package host

import (
	"encoding/json"
	"maps"
	"slices"
	"testing"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// sheetFactsPlatform answers the window facts with the given sheet member, or without one when it is empty.
type sheetFactsPlatform struct {
	elementPlatform
	sheet string
}

func (p *sheetFactsPlatform) WindowFacts(platform.Window) (string, error) {
	member := ""
	if p.sheet != "" {
		member = `"sheet":` + p.sheet + `,`
	}
	return `{"pageProcess":0,` + member + `"nativeSurfaces":[],"webviews":[],"activationObservation":{"registered":false,"count":"0"}}`, nil
}

// host.window carries the kind and the frame of the sheet attached to the window as the native facts report them, null without
// one or when the platform does not report sheets, and refuses a sheet of an unknown kind. A panel is the person's, and a check
// answers the dialogs of a window through host.dialog, so the sheet carries no folder and no name of a panel.
// contract: window.facts.sheet
func TestWindowReportsItsSheet(t *testing.T) {
	savedFramework, savedSystem := framework, system
	t.Cleanup(func() { framework, system = savedFramework, savedSystem })
	window := &elementWindow{}
	window.native = platform.Window(1)
	surfaces := &Surfaces{host: &Host{quit: &Quit{}}, window: window, images: NewImages(), documents: NewDocuments(), invoke: func(task func()) { task() }}
	const frame = `"frame":{"x":10,"y":20,"width":370,"height":182}`
	for _, c := range []struct{ sheet, want string }{
		{sheet: `{"kind":"save",` + frame + `}`, want: `{"kind":"save",` + frame + `}`},
		{sheet: `{"kind":"open",` + frame + `}`, want: `{"kind":"open",` + frame + `}`},
		{sheet: `{"kind":"alert",` + frame + `}`, want: `{"kind":"alert",` + frame + `}`},
		{sheet: `{"kind":"other",` + frame + `}`, want: `{"kind":"other",` + frame + `}`},
		// A field that the facts give beyond the kind and the frame is not reported.
		{sheet: `{"kind":"save",` + frame + `,"directory":"/Users/check","name":"host.jsonl"}`, want: `{"kind":"save",` + frame + `}`},
		{sheet: `null`, want: `null`},
		{want: `null`},
	} {
		framework, system = stepFramework{}, &sheetFactsPlatform{sheet: c.sheet}
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
		if got := string(status["sheet"]); got != c.want {
			t.Fatalf("host.window sheet for the facts %q is %s, want %s", c.sheet, got, c.want)
		}
	}
	framework, system = stepFramework{}, &sheetFactsPlatform{sheet: `{"kind":"panel","frame":{"x":0,"y":0,"width":1,"height":1}}`}
	if _, err := surfaces.windowState(); err == nil {
		t.Fatal("host.window accepted a sheet of the kind panel")
	}
	declared, _ := hostStatus["host.window"].Schema["properties"].(map[string]any)["sheet"].(map[string]any)
	kinds, _ := declared["properties"].(map[string]any)["kind"].(map[string]any)["enum"].([]string)
	if !slices.Equal(kinds, []string{"save", "open", "alert", "other"}) {
		t.Fatalf("host.window declares the sheet %v", declared)
	}
	if properties := slices.Sorted(maps.Keys(declared["properties"].(map[string]any))); !slices.Equal(properties, []string{"frame", "kind"}) {
		t.Fatalf("host.window declares the sheet fields %v, want frame and kind", properties)
	}
}
