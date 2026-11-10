package host

import (
	"encoding/json"
	"testing"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// pagelessFactsPlatform answers the window facts with the given pagelessProcesses member, or without one when it is empty.
type pagelessFactsPlatform struct {
	elementPlatform
	pageless string
}

func (p *pagelessFactsPlatform) WindowFacts(platform.Window) (string, error) {
	member := ""
	if p.pageless != "" {
		member = `"pagelessProcesses":` + p.pageless + `,`
	}
	return `{"pageProcess":0,` + member + `"nativeSurfaces":[],"webviews":[],"activationObservation":{"registered":false,"count":"0"}}`, nil
}

// host.window carries the WebContent processes without a page that the native facts report, with whether WebKit ends each, and
// null when the facts of the platform do not report them.
// contract: window.facts.pageless-processes
func TestWindowReportsTheProcessesWithoutAPage(t *testing.T) {
	savedFramework, savedSystem := framework, system
	t.Cleanup(func() { framework, system = savedFramework, savedSystem })
	window := &elementWindow{}
	window.native = platform.Window(1)
	surfaces := &Surfaces{host: &Host{quit: &Quit{}}, window: window, images: NewImages(), documents: NewDocuments(), invoke: func(task func()) { task() }}
	for _, c := range []struct {
		name     string
		pageless string
		want     string
	}{
		{name: "processes without a page", pageless: `[{"pid":4101,"ending":true},{"pid":4102,"ending":false}]`,
			want: `[{"pid":4101,"ending":true},{"pid":4102,"ending":false}]`},
		{name: "none", pageless: `[]`, want: `[]`},
		{name: "a platform that does not report them", want: `null`},
	} {
		t.Run(c.name, func(t *testing.T) {
			framework, system = stepFramework{}, &pagelessFactsPlatform{pageless: c.pageless}
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
			if got := string(status["pagelessProcesses"]); got != c.want {
				t.Fatalf("host.window pagelessProcesses is %s, want %s", got, c.want)
			}
		})
	}
	for _, invalid := range []string{`{}`, `[{"pid":0,"ending":true}]`, `[{"pid":4101}]`, `[{"pid":"4101","ending":true}]`} {
		framework, system = stepFramework{}, &pagelessFactsPlatform{pageless: invalid}
		if _, err := surfaces.windowState(); err == nil {
			t.Fatalf("host.window accepted the pageless processes %s", invalid)
		}
	}
	if _, declared := hostStatus["host.window"].Schema["properties"].(map[string]any)["pagelessProcesses"]; !declared {
		t.Fatal("host.window does not declare pagelessProcesses")
	}
}
