// Package adapter is the mygo framework adapter of the soksak host: it holds the run of the mygo application and implements the
// framework port of the Go language host library (docs/spec/hosts.md#mygo-host).
package adapter

import (
	"errors"
	"fmt"
	"io/fs"

	"github.com/egoist/mygo"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/src/platform"
	"github.com/soksak-app/core/packages/host/go/src/routine"
	_ "github.com/soksak-app/core/packages/host/mygo/src/platform/darwin"
)

// ErrNoWorkbench is the error of a start without a Workbench.
var ErrNoWorkbench = errors.New("no workbench is installed")

// Run runs the application that draws workbench, with the staged view root under frontend/ of assets.
func Run(assets fs.FS, options host.Options, workbench Workbench) error {
	if workbench == nil {
		return ErrNoWorkbench
	}
	framework := NewFramework(workbench)
	session, err := host.Prepare(framework, assets, options)
	if err != nil {
		return err
	}
	defer session.End()
	framework.Serve(session.Host())
	ConfigureApplication()
	mygo.App.OnBeforeQuit(func(event *mygo.QuitEvent) {
		if !session.ShouldQuit() {
			event.PreventDefault()
		}
	})
	mygo.App.OnQuit(session.Shutdown)
	// The listener exists before the application runs, so a link that opens the application arrives too (docs/spec/native-host.md#deep-links).
	mygo.App.OnOpenURL(session.OpenDeepLink)
	mygo.App.OnDidBecomeActive(func() { host.RecordAppEvent("activated") })
	mygo.App.OnDidResignActive(func() { host.RecordAppEvent("deactivated") })
	var opening error
	mygo.App.WhenReady(func() {
		// A window opens after the application finished launching, and the steps wait for the main thread, so they run outside it.
		routine.Go("application-started", func() {
			if opening = framework.ObserveLayout(); opening == nil {
				opening = session.Open()
			}
			if opening != nil {
				mygo.App.Quit()
				return
			}
			for _, step := range session.Started() {
				step()
			}
		})
	})
	// The main goroutine runs on the main thread (the framework locks it there in its init), so the mask is the mask of the main
	// thread (docs/spec/hosts.md, main thread of the Wails host).
	if err := session.BlockAsyncSignals(); err != nil {
		return err
	}
	err = session.Finish(mygo.App.Run())
	if opening != nil {
		return errors.Join(err, fmt.Errorf("first window: %w", opening))
	}
	return err
}

// ConfigureApplication sets what the host owns before the application runs. Launch Services activates an application that it
// launches unless the launch requested no activation, so the application does not activate itself
// (docs/spec/hosts.md#launch-activation). The host takes the termination signals and quits through its own save, and it sets the
// delegate of the notification center (docs/spec/hosts.md#process-lifecycle). A macOS application stays open without a window, so
// the listener of the last window keeps it running.
func ConfigureApplication() {
	mygo.App.SetName("soksak")
	mygo.App.SetSelfActivation(false)
	mygo.App.SetWindowShow(func(window uintptr) { host.ShowWindow(platform.Window(window)) })
	mygo.App.SetSignalQuit(false)
	mygo.App.SetNotificationDelegate(false)
	mygo.App.OnWindowAllClosed(func() {})
}
