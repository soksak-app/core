//go:build darwin

package host

import (
	"encoding/json"
	"testing"
	"unsafe"

	"github.com/soksak-app/core/packages/host/go/src/platform"
	support "github.com/soksak-app/core/packages/host/go/tests/platform/darwin"
)

// contract: verification.native-test-facade.window-is-real-native-window
func TestTheNativeTestWindowIsAWindowOfTheRealPlatform(t *testing.T) {
	window := support.Window(t, runOnMainThread, 320, 200)
	system, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	var onScreen bool
	var space string
	var onScreenErr, spaceErr error
	runOnMainThread(func() {
		onScreen, onScreenErr = system.WindowOnScreen(window)
		space, spaceErr = system.WindowColorSpace(window)
	})
	if onScreenErr != nil || spaceErr != nil {
		t.Fatalf("window on screen: %v; color space: %v", onScreenErr, spaceErr)
	}
	if onScreen {
		t.Fatal("a window that nothing ordered is on screen")
	}
	if space == "" {
		t.Fatal("the platform reads no color space of the window")
	}
}

// contract: verification.native-test-facade.window-main-page-is-real-main-web-view
func TestTheNativeTestWindowWithAMainPageHasTheMainWebViewOfTheRealPlatform(t *testing.T) {
	window := support.WindowWithMainPage(t, runOnMainThread, 320, 200, "main-page.html")
	system, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	var facts string
	var factsErr error
	runOnMainThread(func() { facts, factsErr = system.WindowFacts(window) })
	if factsErr != nil {
		t.Fatalf("the platform reads no facts of the window: %v", factsErr)
	}
	var read struct {
		Webviews []struct {
			Width, Height float64
			Document      bool
		}
	}
	if err := json.Unmarshal([]byte(facts), &read); err != nil {
		t.Fatalf("the facts of the window are not JSON: %v: %s", err, facts)
	}
	if len(read.Webviews) != 1 || read.Webviews[0].Document || read.Webviews[0].Width != 320 || read.Webviews[0].Height != 200 {
		t.Fatalf("the window holds the web views %+v, want the main web view of the size of the window", read.Webviews)
	}
	var created unsafe.Pointer
	var createErr error
	runOnMainThread(func() {
		created, createErr = system.CreateWebview(window, platform.WebviewOptions{Identifier: 1, Name: "modal", Script: "", Width: 100, Height: 100, Hidden: true})
	})
	if createErr != nil || created == nil {
		t.Fatalf("the platform creates no web view over the main web view: %v", createErr)
	}
	runOnMainThread(func() { system.CloseWebview(created) })
}

// contract: verification.native-test-facade.titled-window-has-title-bar-controls
func TestTheNativeTitledTestWindowHasTheTitleBarControlsOfTheRealPlatform(t *testing.T) {
	window := support.TitledWindow(t, runOnMainThread, 320, 200)
	system, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	var controls platform.Rect
	var row float64
	var controlsErr, setErr, rowErr error
	runOnMainThread(func() {
		setErr = system.SetTitlebarHeight(window, 72)
		row, rowErr = system.TitlebarHeight(window)
		controls, controlsErr = system.WindowControls(window)
	})
	if setErr != nil || rowErr != nil || controlsErr != nil {
		t.Fatalf("title bar set: %v; title bar read: %v; window controls: %v", setErr, rowErr, controlsErr)
	}
	if row != 72 {
		t.Fatalf("the title bar of the window is %v after it was set to 72", row)
	}
	if controls.W <= 0 || controls.H <= 0 {
		t.Fatalf("the window controls occupy %+v, want a region", controls)
	}
}

// contract: verification.native-test-facade.window-reads-of-the-native-library
func TestTheNativeTestInterfaceReadsTheImageRegionsAndTheKeyWaitOfAWindow(t *testing.T) {
	probe := newRegionsProbe(t)
	if got := support.ImageRegions(t, runOnMainThread, probe.window); got != 1 {
		t.Fatalf("the window holds %d image regions, want the one that the test created", got)
	}
	if waiting, decision, modal := support.KeysWait(t, runOnMainThread, probe.window); waiting || decision || modal {
		t.Fatalf("a window that holds no modal reports the key wait %v %v %v", waiting, decision, modal)
	}
	runOnMainThread(func() { system.ModalHold(probe.window) })
	waiting, decision, modal := support.KeysWait(t, runOnMainThread, probe.window)
	runOnMainThread(func() { system.ModalHoldEnd(probe.window) })
	if !waiting || decision || !modal {
		t.Fatalf("a window whose modal holds the keys reports the key wait %v %v %v, want waiting for a modal", waiting, decision, modal)
	}
	if waiting, _, _ := support.KeysWait(t, runOnMainThread, probe.window); waiting {
		t.Fatal("the end of the hold left the keys waiting")
	}
}
