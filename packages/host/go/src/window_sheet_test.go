package host

import (
	"encoding/json"
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

// host.window carries the sheet attached to the window as the native facts report it, with the folder and the name of a panel,
// null without one or when the platform does not report sheets, and refuses a sheet of an unknown kind.
// contract: window.facts.sheet
func TestWindowReportsItsSheet(t *testing.T) {
	savedFramework, savedSystem := framework, system
	t.Cleanup(func() { framework, system = savedFramework, savedSystem })
	window := &elementWindow{}
	window.native = platform.Window(1)
	surfaces := &Surfaces{host: &Host{quit: &Quit{}}, window: window, images: NewImages(), documents: NewDocuments(), invoke: func(task func()) { task() }}
	const frame = `"frame":{"x":10,"y":20,"width":370,"height":182}`
	const save = `{"kind":"save",` + frame + `,"directory":"/Users/check/Documents","name":"host.jsonl"}`
	const open = `{"kind":"open",` + frame + `,"directory":"/Users/check/Documents","name":null}`
	const alert = `{"kind":"alert",` + frame + `,"directory":null,"name":null}`
	for _, c := range []struct{ sheet, want string }{
		{sheet: save, want: save},
		{sheet: open, want: open},
		{sheet: alert, want: alert},
		// Facts without a folder and a name report both as null.
		{sheet: `{"kind":"other",` + frame + `}`, want: `{"kind":"other",` + frame + `,"directory":null,"name":null}`},
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
	framework, system = stepFramework{}, &sheetFactsPlatform{sheet: `{"kind":"save",` + frame + `,"directory":3,"name":null}`}
	if _, err := surfaces.windowState(); err == nil {
		t.Fatal("host.window accepted a sheet whose folder is not a string")
	}
	declared, _ := hostStatus["host.window"].Schema["properties"].(map[string]any)["sheet"].(map[string]any)
	kinds, _ := declared["properties"].(map[string]any)["kind"].(map[string]any)["enum"].([]string)
	if !slices.Equal(kinds, []string{"save", "open", "alert", "other"}) {
		t.Fatalf("host.window declares the sheet %v", declared)
	}
	for _, field := range []string{"directory", "name"} {
		if _, ok := declared["properties"].(map[string]any)[field]; !ok {
			t.Fatalf("host.window declares no %s of the sheet: %v", field, declared)
		}
	}
}
