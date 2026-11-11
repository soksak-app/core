package host

import (
	"encoding/json"
	"testing"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// cursorFactsPlatform answers the window facts with the given cursor member, or without one when it is empty.
type cursorFactsPlatform struct {
	elementPlatform
	cursor string
}

func (p *cursorFactsPlatform) WindowFacts(platform.Window) (string, error) {
	member := ""
	if p.cursor != "" {
		member = `"cursor":` + p.cursor + `,`
	}
	return `{"pageProcess":0,` + member + `"nativeSurfaces":[],"webviews":[],"activationObservation":{"registered":false,"count":"0"}}`, nil
}

// host.window carries the cursor that the application set for the virtual key window, and null when the window is not the
// virtual key window, no cursor was set for it or the platform does not report it.
// contract: window.facts.cursor
func TestWindowReportsTheCursorOfTheVirtualKeyWindow(t *testing.T) {
	savedFramework, savedSystem := framework, system
	t.Cleanup(func() { framework, system = savedFramework, savedSystem })
	window := &elementWindow{}
	window.native = platform.Window(1)
	surfaces := &Surfaces{host: &Host{quit: &Quit{}}, window: window, images: NewImages(), documents: NewDocuments(), invoke: func(task func()) { task() }}
	for _, c := range []struct{ cursor, want string }{
		{cursor: `"pointingHand"`, want: `"pointingHand"`},
		{cursor: `null`, want: `null`},
		{want: `null`},
	} {
		framework, system = stepFramework{}, &cursorFactsPlatform{cursor: c.cursor}
		state, err := surfaces.windowState()
		if err != nil {
			t.Fatal(err)
		}
		text, err := json.Marshal(state)
		if err != nil {
			t.Fatal(err)
		}
		var status map[string]json.RawMessage
		if err := json.Unmarshal(text, &status); err != nil {
			t.Fatal(err)
		}
		if got := string(status["cursor"]); got != c.want {
			t.Fatalf("host.window cursor for the facts %q is %s, want %s", c.cursor, got, c.want)
		}
	}
	framework, system = stepFramework{}, &cursorFactsPlatform{cursor: `3`}
	if _, err := surfaces.windowState(); err == nil {
		t.Fatal("host.window accepted the cursor 3")
	}
	if _, declared := hostStatus["host.window"].Schema["properties"].(map[string]any)["cursor"]; !declared {
		t.Fatal("host.window does not declare cursor")
	}
}
