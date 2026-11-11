package host

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"testing"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// orderPlatform answers the window facts with a display and a place among the windows on the screen, and records the raises and
// the lowers of the windows.
type orderPlatform struct {
	elementPlatform
	facts string
	calls []string
	fail  error
}

func (p *orderPlatform) WindowFacts(platform.Window) (string, error) { return p.facts, nil }

func (p *orderPlatform) RaiseWindow(window platform.Window) error {
	p.calls = append(p.calls, fmt.Sprintf("raise %d", window))
	return p.fail
}

func (p *orderPlatform) LowerWindow(window platform.Window) error {
	p.calls = append(p.calls, fmt.Sprintf("lower %d", window))
	return p.fail
}

// orderHost is a host with the one window main, whose native window is 7, on the platform p.
func orderHost(t *testing.T, p *orderPlatform) (*Host, *Surfaces) {
	t.Helper()
	savedFramework, savedSystem := framework, system
	t.Cleanup(func() { framework, system = savedFramework, savedSystem })
	framework, system = stepFramework{}, p
	window := &elementWindow{}
	window.native = platform.Window(7)
	h := &Host{quit: &Quit{}, windows: map[uint]*Surfaces{}, owners: map[string]*Surfaces{}, relay: NewRelay[relayTarget]()}
	s := &Surfaces{name: "main", window: window, host: h, ready: true, images: NewImages(), documents: NewDocuments(),
		invoke: func(task func()) { task() }}
	h.windows[1] = s
	return h, s
}

// host.window reports the display of the window and its place among the windows on the screen as the platform reads them, and
// null for each that the platform cannot tell.
// contract: window.order.reported
func TestWindowReportsItsDisplayAndItsPlaceAmongTheWindowsOnTheScreen(t *testing.T) {
	for _, c := range []struct{ name, display, order string }{
		{name: "a window on the screen", display: "1", order: `{"index":2,"count":5,"otherInFront":true}`},
		{name: "a window that is not on the screen", display: "null", order: "null"},
	} {
		t.Run(c.name, func(t *testing.T) {
			p := &orderPlatform{facts: fmt.Sprintf(`{"display":%s,"order":%s,"nativeSurfaces":[],"webviews":[],`+
				`"activationObservation":{"registered":false,"count":"0"}}`, c.display, c.order)}
			_, s := orderHost(t, p)
			state, err := s.windowState()
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
			if string(status["display"]) != c.display || string(status["order"]) != c.order {
				t.Fatalf("host.window display %s and order %s, want %s and %s", status["display"], status["order"], c.display, c.order)
			}
		})
	}
	properties := hostStatus["host.window"].Schema["properties"].(map[string]any)
	for _, name := range []string{"display", "order"} {
		if properties[name] == nil {
			t.Fatalf("host.window declares no %s", name)
		}
	}
}

// host.window.raise and host.window.lower order the native window of the window through the platform, and a refusal of the
// platform is the error of the command.
// contract: window.order.raise-and-lower
func TestRaiseAndLowerOrderTheNativeWindow(t *testing.T) {
	p := &orderPlatform{}
	h, _ := orderHost(t, p)
	backend := hostBackend{h: h}
	for _, name := range []string{"host.window.raise", "host.window.lower"} {
		if hostCommands[name].Description == "" {
			t.Fatalf("%s is not a declared host command", name)
		}
		if result, err := backend.HostCommand("main", name, json.RawMessage(`{}`), nil); err != nil || result != nil {
			t.Fatalf("%s answered %v, %v, want null", name, result, err)
		}
	}
	if !slices.Equal(p.calls, []string{"raise 7", "lower 7"}) {
		t.Fatalf("the platform was called %v, want the raise and the lower of window 7", p.calls)
	}
	p.fail = errors.New("the window is not ordered in")
	if _, err := backend.HostCommand("main", "host.window.raise", json.RawMessage(`{}`), nil); err == nil ||
		err.Error() != "the window is not ordered in" {
		t.Fatalf("a refused raise answered %v", err)
	}
}
