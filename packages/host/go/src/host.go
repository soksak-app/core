// Package host is the Go language host library that runs the soksak workbench.
//
// A framework adapter provides the windows and the asset server through the framework port (framework.go) and holds Run. For each
// window, this package lays out the surfaces that the page declared as native web views, shows [data-native-modal] elements as
// modal web views, connects the sidecar channels, and provides the exposure entries through the local endpoint. The implementation
// that the platform package selected performs the operating system specific behavior.
package host

import (
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/soksak-app/core/packages/host/go/src/platform"
	_ "github.com/soksak-app/core/packages/host/go/src/platform/darwin"
	_ "github.com/soksak-app/core/packages/host/go/src/platform/windows"
	"github.com/soksak-app/core/packages/host/go/src/routine"
	"github.com/soksak-app/core/packages/sok/go/src"
	// The plugin work (plugins.go) uses the installer library of the command line, so its platform implementation is also registered.
	_ "github.com/soksak-app/core/packages/sok/go/src/platform/darwin"
	_ "github.com/soksak-app/core/packages/sok/go/src/platform/linux"
	_ "github.com/soksak-app/core/packages/sok/go/src/platform/windows"
)

// Options are the values that the application reads from the command line and passes.
type Options struct {
	// ConfigDir is the configuration directory. When empty, it uses the identifier directory of this build under the user configuration directory
	// (docs/spec/projects.md#persistence).
	ConfigDir string
	// RegistryCA is --registry-ca of a diagnostic build. It is the PEM file of the certificate authority that the registry download trusts.
	RegistryCA string
}

// applicationVersion is the version that the endpoint announces.
const applicationVersion = "0.0.40"

// system is the operating system implementation that Run selected.
var system platform.Platform

// Session is one run of the host, which a framework adapter holds around the run of its framework.
type Session struct {
	host        *Host
	config      string
	frontend    fs.FS
	quit        *Quit
	started     chan struct{}
	unpublished chan error
	// stall guards the stop of the watch of the main thread and whether the shutdown began, after which no watch starts.
	stall struct {
		sync.Mutex
		stop     func()
		shutDown bool
	}
	main *Surfaces
	// cleanups run in reverse order at End.
	cleanups []func()
}

// Prepare runs the start of the host up to the point at which the framework runs, with the staged frontend under frontend/ of
// assets as the asset root. The caller calls End of the session that it returns when the framework ended.
func Prepare(adapter Framework, assets fs.FS, options Options) (_ *Session, failure error) {
	framework = adapter
	session := &Session{started: make(chan struct{}), unpublished: make(chan error, 1)}
	defer func() {
		if failure != nil {
			session.End()
		}
	}()
	current, err := platform.Current()
	if err != nil {
		return nil, err
	}
	system = current
	// The darwin layer runs each native call and each callback through the main-thread functions of the framework adapter, so the
	// start fails when one is missing instead of running them on another thread (docs/spec/hosts.md, main thread of the Wails host).
	if err := system.RequireMainThread(); err != nil {
		return nil, err
	}
	// The window zoom animation moves only the window frame, and the web document follows it. This shortens that duration before AppKit
	// reads the default.
	if err := system.InstantWindowResize(); err != nil {
		return nil, err
	}
	// The termination signals are received before the endpoint is created. A normal termination is
	// requested after the application started. A normal termination closes the endpoint after the save of the ready windows finishes.
	quit := &Quit{}
	if err := OnTermination(quit, func() {
		<-session.started
		framework.Quit()
	}); err != nil {
		return nil, err
	}
	frontend, err := fs.Sub(assets, "frontend")
	if err != nil {
		return nil, err
	}
	session.frontend = frontend
	if err := readBackgroundScript(frontend); err != nil {
		return nil, err
	}
	// Each view configuration runs the view channel script of the bundled frontend before its page (docs/spec/native-surfaces.md#view-surfaces).
	viewChannel, err := fs.ReadFile(frontend, viewChannelPath)
	if err != nil {
		return nil, fmt.Errorf("view channel script: %w", err)
	}
	viewChannelScript = string(viewChannel)
	// The identifier is that of the application of the framework adapter, not that of a build tag (docs/spec/projects.md#persistence).
	identifier, err := sok.IdentityOf(framework.ApplicationName())
	if err != nil {
		return nil, err
	}
	configDirectory := options.ConfigDir
	if configDirectory == "" {
		config, err := os.UserConfigDir()
		if err != nil {
			return nil, err
		}
		configDirectory = filepath.Join(config, identifier)
	}
	configDirectory, err = PrepareConfigDirectory(configDirectory)
	if err != nil {
		return nil, fmt.Errorf("config directory: %w", err)
	}
	session.config = configDirectory
	host, err := newHost(configDirectory, quit)
	if err != nil {
		return nil, err
	}
	// The core root of the views serves the files of the configuration folder and the bundled frontend, so the application does not start
	// when the platform cannot register the resolver.
	if err := RegisterCoreRoot(system, configDirectory, frontend); err != nil {
		return nil, err
	}
	// The view import map is inserted into each view page, so the application does not start when the platform cannot set it.
	if err := RegisterViewImportMap(system, frontend); err != nil {
		return nil, err
	}
	// The endpoint is created before a window is shown. When it cannot be created, the application does not start.
	// endpoint.json is written after the first window is registered and the application started.
	listener, address, err := system.Listen(SocketDirectory(), framework.ApplicationName())
	if err != nil {
		return nil, fmt.Errorf("local endpoint: %w", err)
	}
	session.host = host
	host.endpoint = NewEndpoint(hostBackend{host})
	host.buttons = NewButtons(func(value map[string]any) { host.endpoint.NotifyWatchers("host.buttons", value) })
	info := EndpointInfo{Transport: address.Transport, Address: address.Address, PID: os.Getpid(),
		Application: framework.ApplicationName(), Version: applicationVersion, Started: time.Now()}
	if err := host.endpoint.Serve(listener, info, host.workspace.directory); err != nil {
		listener.Close()
		return nil, fmt.Errorf("local endpoint: %w", err)
	}
	session.cleanups = append(session.cleanups, func() { host.endpoint.Close() })
	// The event log and the stderr file are opened after Serve holds the process lock, so no other run writes the same files
	// (docs/spec/hosts.md#application-log). The run record waits in the start buffer until the writer exists.
	eventLog, err := StartHostEventLog(configDirectory)
	if err != nil {
		return nil, fmt.Errorf("event log: %w", err)
	}
	host.events = eventLog
	UseHostEventLog(eventLog)
	// An owner that an earlier run left in process.lock marks an end of that run without its exit path (docs/spec/endpoint.md#discovery).
	// The event is stored once the writer exists.
	if end, ok := host.endpoint.UnrecordedEnd(); ok {
		ReportUnrecordedEnd(end)
	}
	// The policy of the event log is the file log-policy.json, which the host and every process watch (docs/spec/logging.md#classes-and-policy).
	// The activity observers start after the first policy is applied, so their registration records meet that policy.
	steps := newStepRecording(framework.RecordSteps, func() bool { return eventLog.Enabled(ClassFrame, LevelDebug) },
		func(events uint64) { eventLog.CountLoss(sok.ChannelDebug, sok.LossStepRingFull, events, 0) })
	host.steps = steps
	announcePolicy := LogPolicyAnnouncer(eventLog, host.announceToWindows)
	stopPolicy, err := StartHostLogPolicy(eventLog, func(source, detail string) {
		announcePolicy(source, detail)
		steps.sync()
	})
	if err != nil {
		return nil, fmt.Errorf("log policy: %w", err)
	}
	session.cleanups = append(session.cleanups, stopPolicy, steps.stop)
	// The debug view follows the event files: every window and every watcher of host.log learns that a line announced a change
	// (docs/spec/debug.md#following). The index covers the lines before the notice, so the notice follows the indexer and the queries
	// that update an index, and not the writer.
	notices := NewLogNotices(LogNoticeInterval, host.announceLogNotice)
	session.cleanups = append(session.cleanups, notices.Stop)
	host.logNotices = notices
	UseLogNotices(notices)
	session.cleanups = append(session.cleanups, func() { UseLogNotices(nil) })
	// The index of each event file follows the writer (docs/spec/logging.md#index).
	indexWrites, stopIndexer := StartLogIndexer(NewIndexReporter())
	session.cleanups = append(session.cleanups, stopIndexer)
	eventLog.SetOnWrite(indexWrites)
	ApplyPluginEventClasses(eventLog, configDirectory)
	if err := StartStandardError(configDirectory, identifier); err != nil {
		return nil, err
	}
	// The crash reports of the earlier runs are announced once, after the writer exists (docs/spec/logging.md#entrances).
	if err := AnnounceCrashReportsAtStart(configDirectory); err != nil {
		LogError("crash reports", err)
	}
	// Both hosts write the host lines in the same form without a prefix. The first line of a run carries the time.
	log.SetFlags(0)
	// The install state is read after the process lock is taken and the application log is open. A read error is kept in the application log
	// (docs/spec/installation.md). endpoint.json does not exist yet, so no request that uses a sidecar arrives.
	sidecars, err := NewInstalledSidecars(configDirectory)
	if err != nil {
		return nil, err
	}
	host.sidecars = sidecars
	sidecars.ClosingChanged = host.sidecarsChanged
	sidecars.ClosingInvalidated = host.notifySidecars
	return session, nil
}

// Host is the value whose exported methods are the host calls of a page.
func (s *Session) Host() *Host { return s.host }

// Assets returns the middleware of the asset server. windowHeader is the header that holds the window number of a request, and
// optional is the file that the runtime of the framework requests and the application does not provide.
func (s *Session) Assets(windowHeader, optional string) Middleware {
	return func(next http.Handler) http.Handler {
		return MissingAssets(StartAssets(s.host.startPage, windowHeader)(InstalledAssets(s.config, s.frontend)(next)), optional, reportMissingAsset)
	}
}

// ShouldQuit answers the quit request of the framework.
func (s *Session) ShouldQuit() bool { return s.host.shouldQuit() }

// OpenDeepLink opens the deep link that the framework received (docs/spec/native-host.md#deep-links).
func (s *Session) OpenDeepLink(value string) {
	routine.Go("deep-link", func() { s.host.openDeepLink(value) })
}

// Shutdown ends the services of the host when the framework shuts down.
func (s *Session) Shutdown() {
	host := s.host
	// The shutdown ends the watch of the main thread before its own work on the main thread, and the stop waits for the running
	// sample, so its host.stall.sampled reaches the flush below and no sample process outlives the host (docs/spec/logging.md,
	// stalls).
	s.stopStallWatch()
	RecordAppEvent("exit")
	EmitClosed("exit", nil)
	// An application update or a relaunch keeps the persistent services running for the application that starts next.
	update := host.takeUpdate()
	if update != nil {
		// The command waits for the end of this process, so it starts here, before the flush that stores its event and
		// the error of a start that fails.
		update.start()
		host.sidecars.Detach()
	} else {
		// The quit hook ended the quit stop before the framework shut down, so this stop finds no sidecar that runs then
		// (docs/spec/hosts.md#process-lifecycle).
		host.sidecars.Stop()
	}
	if err := host.endpoint.Close(); err != nil {
		LogError("endpoint close", err)
	}
	if err := FlushEventLog(host.events, system.FlushNativeObservers); err != nil {
		LogError("event log flush", err)
	}
	// The save and the cleanup are finished, so the termination request of the operating system that was received is answered.
	mainThreadStep(system.AnswerQuitRequests)
}

// readBackgroundScript reads the background script of the modal web views from the staged frontend. An application without a main
// page has neither, and its staging holds no such file (docs/spec/plugins.md#environmentjson).
func readBackgroundScript(frontend fs.FS) error {
	if !framework.MainPage() {
		return nil
	}
	background, err := fs.ReadFile(frontend, "background.js")
	if err != nil {
		return err
	}
	backgroundScript = string(background)
	return nil
}

// Open installs the application menu and creates the first window. Call it after the framework was created.
func (s *Session) Open() error {
	host := s.host
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
	if err := framework.SetMenu(menu); err != nil {
		return err
	}
	// The end of a layout transaction ends the waits inside the presentation request of its window
	// (docs/spec/native-surfaces.md#layout-transaction).
	mainThreadStep(func() {
		if err := system.WatchLayoutEnds(host.layoutEnded); err != nil {
			LogError("surface layout", err)
		}
	})
	s.main = host.newWindow("main", "/")
	return nil
}

// Started returns the steps that run when the application started, in order. A framework adapter registers each as a listener of
// its own.
func (s *Session) Started() []func() {
	host := s.host
	return []func(){
		func() {
			RecordAppEvent("started")
			close(s.started)
			// When the notification center cannot be used, the application does not start (docs/spec/hosts.md).
			if err := host.startNotifications(); err != nil {
				s.unpublished <- err
				framework.Quit()
				return
			}
			// host.buttons holds the value of the operating system before endpoint.json is written. When the watch is not possible, the application does not
			// start (docs/spec/exposure.md#host-entries).
			if err := host.watchButtons(); err != nil {
				s.unpublished <- err
				framework.Quit()
				return
			}
			// A client requests the first window as soon as it reads endpoint.json, so it is written after the window is registered. When it cannot be written,
			// the application ends and the error is returned.
			if err := host.endpoint.Publish("main"); err != nil {
				s.unpublished <- fmt.Errorf("local endpoint: %w", err)
				framework.Quit()
			}
		},
		func() { setupDockMenu(host) },
		setupQuitRequest,
		setupMemoryPressure(host),
		func() { s.main.prepareNative() },
		// A stall of the main thread is recorded without a window check (docs/spec/logging.md, stalls). The heartbeat starts when the
		// main loop runs, because before it the main thread runs the start and takes no heartbeat.
		func() {
			s.stall.Lock()
			defer s.stall.Unlock()
			if s.stall.shutDown {
				return
			}
			s.stall.stop = StartStallWatch(StallWatchOptions{Heartbeat: StallHeartbeat(system), AwaitAwake: system.StallAwaitAwake,
				Sample: system.SampleThreads, Folder: filepath.Dir(host.events.Path()), EmitHost: EmitHost})
		},
	}
}

// BlockAsyncSignals blocks the asynchronous signals of the calling thread. The main goroutine runs on the main thread (a framework
// locks it there in its init), so the mask is the mask of the main thread (docs/spec/hosts.md, main thread of the Wails host).
func (s *Session) BlockAsyncSignals() error { return system.BlockAsyncSignals() }

// stopStallWatch stops the watch of the main thread and waits for its running sample. A shutdown that comes before the start of
// the watch keeps the watch from starting.
func (s *Session) stopStallWatch() {
	s.stall.Lock()
	s.stall.shutDown = true
	stop := s.stall.stop
	s.stall.stop = nil
	s.stall.Unlock()
	if stop != nil {
		stop()
	}
}

// Finish returns err, with which the framework ended, with the failure that kept the application from publishing its endpoint.
func (s *Session) Finish(err error) error {
	select {
	case failure := <-s.unpublished:
		return errors.Join(err, failure)
	default:
		return err
	}
}

// End runs the cleanups of the start in reverse order.
func (s *Session) End() {
	for index := len(s.cleanups) - 1; index >= 0; index-- {
		s.cleanups[index]()
	}
	s.cleanups = nil
}

// setupQuitRequest makes the termination request of the operating system run the same termination as host.quit once the application started.
// OnShutdown answers that request after the save finishes (docs/spec/hosts.md#process-lifecycle).
func setupQuitRequest() {
	mainThreadStep(func() {
		if err := system.OnQuitRequest(func(senderPid int, sender string) {
			AfterOwnerResponse(func() { QuitWithCause("quit-request", AppleEventQuitSource(senderPid, sender), framework.Quit) })
		}); err != nil {
			fatalError("quit request", err)
		}
	})
}

// setupDockMenu registers the Dock menu once the application started.
func setupDockMenu(host *Host) {
	mainThreadStep(func() {
		if err := framework.InstallDock(host.WindowNew); err != nil {
			fatalError("dock menu", err)
		}
	})
}
