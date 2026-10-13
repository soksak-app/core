// Package host is the Wails v3 native host that runs the soksak workbench.
//
// Wails provides the windows and the asset server. For each window, this package lays out the surfaces that the page declared as native
// web views, shows [data-native-modal] elements as modal web views, connects the sidecar channels, and
// provides the exposure entries through the local endpoint. The implementation that the platform package selected performs the operating system specific behavior.
//
// The application passes to Run a file system that contains the staged frontend under frontend/.
// Wails uses the directory that holds index.html as the asset root, so the window opens "/".
package host

import (
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
	_ "github.com/soksak-app/core/packages/host/wailsv3/src/platform/darwin"
	_ "github.com/soksak-app/core/packages/host/wailsv3/src/platform/windows"
	"github.com/soksak-app/core/packages/sok/wailsv3/src"
	// The plugin work (plugins.go) uses the installer library of the command line, so its platform implementation is also registered.
	_ "github.com/soksak-app/core/packages/sok/wailsv3/src/platform/darwin"
	_ "github.com/soksak-app/core/packages/sok/wailsv3/src/platform/linux"
	_ "github.com/soksak-app/core/packages/sok/wailsv3/src/platform/windows"
)

// Options are the values that the application reads from the command line and passes.
type Options struct {
	// ConfigDir is the configuration directory. When empty, it uses the identifier directory of this build under the user configuration directory
	// (docs/spec/projects.md#persistence).
	ConfigDir string
	// RegistryCA is --registry-ca of a diagnostic build. It is the PEM file of the certificate authority that the registry download trusts.
	RegistryCA string
}

// The application name and version that the endpoint announces.
const (
	applicationName    = "wailsv3"
	applicationVersion = "0.0.12"
)

// system is the operating system implementation that Run selected.
var system platform.Platform

// Run runs the application that uses frontend/ of assets as the asset root and returns when it ends.
func Run(assets fs.FS, options Options) error {
	current, err := platform.Current()
	if err != nil {
		return err
	}
	system = current
	// The window zoom animation moves only the window frame, and the web document follows it. This shortens that duration before AppKit
	// reads the default.
	if err := system.InstantWindowResize(); err != nil {
		return err
	}
	// The termination signals are received before the endpoint is created. A normal termination is
	// requested after the application started. A normal termination closes the endpoint after the save of the ready windows finishes.
	started := make(chan struct{})
	if err := system.OnTermination(func() {
		<-started
		application.Get().Quit()
	}); err != nil {
		return err
	}
	frontend, err := fs.Sub(assets, "frontend")
	if err != nil {
		return err
	}
	background, err := fs.ReadFile(frontend, "background.js")
	if err != nil {
		return err
	}
	backgroundScript = string(background)
	identifier := sok.Identity()
	configDirectory := options.ConfigDir
	if configDirectory == "" {
		config, err := os.UserConfigDir()
		if err != nil {
			return err
		}
		configDirectory = filepath.Join(config, identifier)
	}
	configDirectory, err = PrepareConfigDirectory(configDirectory)
	if err != nil {
		return fmt.Errorf("config directory: %w", err)
	}
	// Harvests the WebKit children that the previous run left into the record, and takes the currently running
	// WebKit processes as the baseline so that it does not overwrite those of others (V5-113). No window exists yet, so this run has no WebKit.
	ReapRecordedWebKit(configDirectory)
	SnapshotBaseline()
	host, err := newHost(configDirectory)
	if err != nil {
		return err
	}
	// The endpoint is created before a window is shown. When it cannot be created, the application does not start.
	// endpoint.json is written after the first window is registered and the application started.
	listener, address, err := system.Listen(SocketDirectory(), applicationName)
	if err != nil {
		return fmt.Errorf("local endpoint: %w", err)
	}
	host.endpoint = NewEndpoint(hostBackend{host})
	host.buttons = NewButtons(func(value map[string]any) { host.endpoint.NotifyWatchers("host.buttons", value) })
	info := EndpointInfo{Transport: address.Transport, Address: address.Address, PID: os.Getpid(),
		Application: applicationName, Version: applicationVersion, Started: time.Now()}
	if err := host.endpoint.Serve(listener, info, host.workspace.directory); err != nil {
		listener.Close()
		return fmt.Errorf("local endpoint: %w", err)
	}
	defer host.endpoint.Close()
	// The event log and the stderr file are opened after Serve holds the process lock, so no other run writes the same files
	// (docs/spec/hosts.md#application-log). The run record waits in the start buffer until the writer exists.
	eventLog, err := StartHostEventLog(configDirectory)
	if err != nil {
		return fmt.Errorf("event log: %w", err)
	}
	host.events = eventLog
	UseHostEventLog(eventLog)
	// The policy of the event log is the file log-policy.json, which the host and every process watch (docs/spec/logging.md#classes-and-policy).
	stopPolicy, err := StartLogPolicy(eventLog, nil)
	if err != nil {
		return fmt.Errorf("log policy: %w", err)
	}
	defer stopPolicy()
	// The debug view follows the event files: every window and every watcher of host.log learns that a line announced a change
	// (docs/spec/debug.md#following). The index covers the lines before the notice, so the notice follows the indexer and the queries
	// that update an index, and not the writer.
	notices := NewLogNotices(LogNoticeInterval, host.announceLogNotice)
	defer notices.Stop()
	host.logNotices = notices
	UseLogNotices(notices)
	defer UseLogNotices(nil)
	// The index of each event file follows the writer (docs/spec/logging.md#index).
	indexWrites, stopIndexer := StartLogIndexer(NewIndexReporter())
	defer stopIndexer()
	eventLog.SetOnWrite(indexWrites)
	ApplyPluginEventClasses(eventLog, configDirectory)
	if err := StartStandardError(configDirectory, identifier); err != nil {
		return err
	}
	// The crash reports of the earlier runs are announced once, after the writer exists (docs/spec/logging.md#automatic-entrances).
	if err := AnnounceCrashReportsAtStart(configDirectory); err != nil {
		LogError("crash reports", err)
	}
	// Both hosts write the host lines in the same form without a prefix. The first line of a run carries the time.
	log.SetFlags(0)
	// The install state is read after the process lock is taken and the application log is open. A read error is kept in the application log
	// (docs/spec/installation.md). endpoint.json does not exist yet, so no request that uses a sidecar arrives.
	declarations, err := InstalledSidecars(configDirectory)
	if err != nil {
		return fmt.Errorf("installed plugins: %w", err)
	}
	sidecars, err := NewSidecars(declarations, configDirectory)
	if err != nil {
		return err
	}
	host.sidecars = sidecars
	sidecars.ClosingChanged = host.sidecarsChanged
	bindings, err := NewBindings(host)
	if err != nil {
		return fmt.Errorf("host calls: %w", err)
	}
	app := application.New(application.Options{
		Name: "soksak", Description: "soksak layout running in Wails v3",
		Assets: application.AssetOptions{Handler: application.BundledAssetFileServer(assets), Middleware: func(next http.Handler) http.Handler {
			return MissingAssets(StartAssets(host.startPage)(InstalledAssets(configDirectory)(next)), reportMissingAsset)
		}},
		Services:   []application.Service{application.NewService(bindings)},
		LogLevel:   FrameworkLogLevel,
		ShouldQuit: host.shouldQuit,
		// The default signal handler of Wails does not receive SIGHUP and only holds the signals after the first one, so
		// it does not end the process with the default action. The handler that Run registered
		// keeps the termination signal contract of the host specification (docs/spec/hosts.md).
		DisableDefaultSignalHandler: true,
		// Wails errors are written as error lines of the host instead of the level prefix of the default logger. The window check reads those lines as errors
		// (docs/spec/hosts.md#application-log).
		ErrorHandler: func(err error) { LogError("wails", err) },
		OnShutdown: func() {
			RecordAppEvent("exit")
			// Kills the web processes of all windows before exit. AppKit keeps XPC services alive
			// longer than their clients (V5-105), so unless they are killed, the WebContent, GPU and Networking processes
			// remain after the application exits and occupy memory.
			host.mu.Lock()
			shutdown := make([]*application.WebviewWindow, 0, len(host.windows))
			for _, s := range host.windows {
				shutdown = append(shutdown, s.window)
			}
			host.mu.Unlock()
			for _, win := range shutdown {
				window := win
				application.InvokeSync(func() {
					if main, err := system.MainWebview(window.NativeWindow()); err == nil {
						if err := system.KillWebContentProcess(main); err != nil {
							LogError("web content kill", err)
						}
					}
				})
			}
			// An application update keeps the persistent services running for the application that starts next.
			update := host.takeUpdate()
			if update != nil {
				// The command waits for the end of this process, so it starts here, before the flush that stores its event and
				// the error of a start that fails.
				if err := StartAppUpdate(update); err != nil {
					LogError("application update", err)
				}
				sidecars.Detach()
			} else {
				sidecars.Stop()
			}
			if err := host.endpoint.Close(); err != nil {
				LogError("endpoint close", err)
			}
			if err := FlushEventLog(host.events, system.FlushNativeObservers, 2*time.Second); err != nil {
				LogError("event log flush", err)
			}
			// The save and the cleanup are finished, so the termination request of the operating system that was received is answered.
			application.InvokeSync(system.AnswerQuitRequests)
		},
	})
	// A client requests the first window as soon as it reads endpoint.json, so it is written after the window is registered. When it cannot be written,
	// the application ends and the error is returned.
	unpublished := make(chan error, 1)
	app.Event.OnApplicationEvent(events.Mac.ApplicationDidBecomeActive, func(*application.ApplicationEvent) {
		RecordAppEvent("activated")
	})
	app.Event.OnApplicationEvent(events.Mac.ApplicationDidResignActive, func(*application.ApplicationEvent) {
		RecordAppEvent("deactivated")
	})
	app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) {
		RecordAppEvent("started")
		close(started)
		// When the notification center cannot be used, the application does not start (docs/spec/hosts.md).
		if err := host.startNotifications(); err != nil {
			unpublished <- err
			app.Quit()
			return
		}
		// host.buttons holds the value of the operating system before endpoint.json is written. When the watch is not possible, the application does not
		// start (docs/spec/exposure.md#host-entries).
		if err := host.watchButtons(); err != nil {
			unpublished <- err
			app.Quit()
			return
		}
		if err := host.endpoint.Publish("main"); err != nil {
			unpublished <- fmt.Errorf("local endpoint: %w", err)
			app.Quit()
		}
	})
	// The new window item of the menu opens a window with Host.WindowNew. The initial menu language is the system preferred language mapped to the language of the contract
	// table, and when the page reports the settings language, SetMenuLanguage rebuilds the menu with the same table
	// (Application menu of docs/spec/host-contract.md).
	menuWindowNew = host.WindowNew
	language, err := InitialMenuLanguage()
	if err != nil {
		return err
	}
	assignMenuLanguage(language)
	menu, menuFailure := ApplicationMenu()
	if menuFailure != nil {
		return menuFailure
	}
	app.Menu.Set(menu)
	setupDockMenu(host)
	setupQuitRequest()
	main := host.newWindow("main", "/")
	app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) {
		main.prepareNative()
	})
	// A stall of the main thread is recorded without a window check (docs/spec/logging.md, stalls). The heartbeat starts when the
	// main loop runs, because before it the main thread runs the start and takes no heartbeat.
	var stopStall atomic.Pointer[func()]
	app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) {
		stop := StartStallWatch(StallWatchOptions{OnMain: application.InvokeAsync, Sample: system.SampleThreads,
			Folder: filepath.Dir(eventLog.Path()), EmitHost: EmitHost})
		stopStall.Store(&stop)
	})
	err = app.Run()
	if stop := stopStall.Load(); stop != nil {
		(*stop)()
	}
	select {
	case failure := <-unpublished:
		return errors.Join(err, failure)
	default:
		return err
	}
}

// setupQuitRequest makes the termination request of the operating system run the same termination as host.quit once the application started.
// OnShutdown answers that request after the save finishes (docs/spec/hosts.md#process-lifecycle).
func setupQuitRequest() {
	application.Get().Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) {
		application.InvokeSync(func() {
			if err := system.OnQuitRequest(func() { application.Get().Quit() }); err != nil {
				fatalError("quit request", err)
			}
		})
	})
}

// setupDockMenu registers the Dock menu once the application started.
func setupDockMenu(host *Host) {
	application.Get().Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) {
		application.InvokeSync(func() {
			if err := system.InstallDock(host.WindowNew); err != nil {
				fatalError("dock menu", err)
			}
		})
	})
}
