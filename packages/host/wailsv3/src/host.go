// Package adapter is the Wails framework adapter of the soksak host: it holds the run of the Wails application and implements the
// framework port of the Go language host library (docs/spec/hosts.md#mygo-host).
package adapter

import (
	"io/fs"
	"log/slog"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/src/platform"
	_ "github.com/soksak-app/core/packages/host/wailsv3/src/platform/darwin"
)

// FrameworkLogLevel is the level of the logger of the Wails framework. The asset server of the framework writes the line
// `[AssetFileServerFS] Handling request` at the level info for every file that a page requests, which filled the standard error
// with 2.0 MB of lines that carry no failure and hid the crash output of the runtime. The events `host.binding.call` and the
// page records state the requests that matter; the framework keeps its warnings and errors.
const FrameworkLogLevel = slog.LevelWarn

// Run runs the application that uses frontend/ in assets as its asset root.
func Run(assets fs.FS, options host.Options) error {
	session, err := host.Prepare(Framework{}, assets, options)
	if err != nil {
		return err
	}
	defer session.End()
	bindings, err := NewBindings(session.Host())
	if err != nil {
		return err
	}
	app := application.New(application.Options{
		Name: "soksak", Description: "soksak layout running in Wails v3",
		Assets: application.AssetOptions{
			Handler:    application.BundledAssetFileServer(assets),
			Middleware: application.Middleware(session.Assets("x-wails-window-id", "/wails/custom.js")),
		},
		Services:   []application.Service{application.NewService(bindings)},
		LogLevel:   FrameworkLogLevel,
		ShouldQuit: session.ShouldQuit,
		Mac:        LaunchMacOptions(),
		// The default signal handler of Wails does not receive SIGHUP and only holds the signals after the first one, so
		// it does not end the process with the default action. The handler that Prepare registered
		// keeps the termination signal contract of the host specification (docs/spec/hosts.md).
		DisableDefaultSignalHandler: true,
		// Wails errors are written as error lines of the host instead of the level prefix of the default logger. The window check reads those lines as errors
		// (docs/spec/hosts.md#application-log).
		ErrorHandler: func(err error) { host.LogError("wails", err) },
		OnShutdown:   session.Shutdown,
	})
	app.Event.OnApplicationEvent(events.Mac.ApplicationDidBecomeActive, func(*application.ApplicationEvent) {
		host.RecordAppEvent("activated")
	})
	app.Event.OnApplicationEvent(events.Mac.ApplicationDidResignActive, func(*application.ApplicationEvent) {
		host.RecordAppEvent("deactivated")
	})
	// A deep link that opens the application arrives as the framework event of the URL (docs/spec/native-host.md#deep-links).
	app.Event.OnApplicationEvent(events.Common.ApplicationLaunchedWithUrl, func(event *application.ApplicationEvent) {
		session.OpenDeepLink(event.Context().URL())
	})
	if err := session.Open(); err != nil {
		return err
	}
	for _, step := range session.Started() {
		app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) { step() })
	}
	// The main goroutine runs on the main thread (the framework locks it there in its init), so the mask is the mask of the main
	// thread (docs/spec/hosts.md, main thread of the Wails host).
	if err := session.BlockAsyncSignals(); err != nil {
		return err
	}
	return session.Finish(app.Run())
}

// LaunchMacOptions returns the macOS options of the application. Launch Services activates an application that it launches
// unless the launch requested no activation (`open -g`, kLSLaunchDontSwitch, NSWorkspaceOpenConfiguration.activates false),
// so the application does not activate itself when it finishes launching, which Wails does by default and which brings a
// background launch to the front, and a window shows through the show of the host, because Wails orders every window that it
// shows front (docs/spec/hosts.md#launch-activation).
func LaunchMacOptions() application.MacOptions {
	return application.MacOptions{
		ActivationPolicy: application.ActivationPolicyRegular, DisableActivationOnLaunch: true,
		WindowShow: func(window unsafe.Pointer) { host.ShowWindow(platform.Window(uintptr(window))) },
	}
}
