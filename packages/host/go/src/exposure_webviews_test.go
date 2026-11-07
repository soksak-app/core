package host

import (
	"encoding/json"
	"fmt"
	"reflect"
	"testing"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// contract: window.facts.modal-order-is-above-every-webview
func TestModalOrderIsAboveEveryNativeSurfaceAndWebview(t *testing.T) {
	// Two native surfaces have the orders 0 and 1, and five web views have the orders 0 to 4.
	if order := modalOrder(2, 5); order != 7 {
		t.Fatalf("modal order %d, want 7", order)
	}
}

// contract: window.facts.modal-order-is-above-every-webview
func TestModalOrderIsAboveTheFirstWebviewWithoutNativeSurfaces(t *testing.T) {
	// Without native surfaces, a document region at web view index 0 has order 0, so the modal must have an order above 0.
	for webviews := 1; webviews <= 5; webviews++ {
		for index := 0; index < webviews; index++ {
			if order := modalOrder(0, webviews); order <= index {
				t.Fatalf("modal order %d with no native surface and %d web views, want above the web view index %d", order, webviews, index)
			}
		}
	}
}

// contract: window.facts.document-reports-its-blur
func TestWindowDocumentReportsItsNativeBlur(t *testing.T) {
	key := DocumentKey{Surface: "tab-a", Name: "page"}
	if entry := windowDocument(key, 2, windowWebviewFacts{View: 7, Blurred: true}); !entry.Blurred {
		t.Fatalf("document entry %#v of a blurred web view, want blurred true", entry)
	}
	if entry := windowDocument(key, 2, windowWebviewFacts{View: 7}); entry.Blurred {
		t.Fatalf("document entry %#v of a web view without a filter, want blurred false", entry)
	}
}

// pageFactsPlatform answers the window facts with the WebContent process of a main page.
type pageFactsPlatform struct {
	elementPlatform
	process int
}

func (p *pageFactsPlatform) WindowFacts(platform.Window) (string, error) {
	return fmt.Sprintf(`{"pageProcess":%d,"nativeSurfaces":[],"webviews":[],"activationObservation":{"registered":false,"count":"0"}}`, p.process), nil
}

// A window without a main page has no page process, so host.window reports null and the sampler reads no page. A window
// with a main page reports 0 until its WebContent process starts.
// contract: window.page-process.null-without-a-main-page
func TestWindowReportsNoPageProcessWithoutAMainPage(t *testing.T) {
	savedFramework, savedSystem := framework, system
	t.Cleanup(func() { framework, system = savedFramework, savedSystem })
	window := &elementWindow{}
	window.native = platform.Window(1)
	surfaces := &Surfaces{host: &Host{quit: &Quit{}}, window: window, images: NewImages(), documents: NewDocuments(), invoke: func(task func()) { task() }}
	for _, c := range []struct {
		name      string
		framework Framework
		process   int
		want      string
		page      *int
	}{
		{name: "no main page", framework: pagelessFramework{window: window}, want: "null"},
		{name: "a main page before its process starts", framework: stepFramework{}, want: "0", page: new(int)},
		{name: "a main page", framework: stepFramework{}, process: 501, want: "501", page: func() *int { process := 501; return &process }()},
	} {
		t.Run(c.name, func(t *testing.T) {
			framework, system = c.framework, &pageFactsPlatform{process: c.process}
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
			if got := string(status["pageProcess"]); got != c.want {
				t.Fatalf("host.window pageProcess is %s, want %s", got, c.want)
			}
			processes, err := surfaces.performanceProcesses()
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(processes.Page, c.page) {
				t.Fatalf("the sampler reads the page %v, want %v", processes.Page, c.page)
			}
		})
	}
	declared := hostStatus["host.window"].Schema["properties"].(map[string]any)["pageProcess"].(map[string]any)
	if !reflect.DeepEqual(declared["type"], []any{"integer", "null"}) {
		t.Fatalf("host.window declares pageProcess as %v", declared)
	}
}

// contract: exposure.window.frame-counters-are-null
func TestWindowFrameCountersAreNullBecauseWebKitDrawsTheWorkbench(t *testing.T) {
	text, err := json.Marshal(WindowStatus{})
	if err != nil {
		t.Fatal(err)
	}
	var status map[string]any
	if err := json.Unmarshal(text, &status); err != nil {
		t.Fatal(err)
	}
	properties := hostStatus["host.window"].Schema["properties"].(map[string]any)
	for name, schema := range map[string]any{
		"frames": []any{"integer", "null"}, "commandBuffers": []any{"integer", "null"}, "settled": []any{"boolean", "null"},
	} {
		if got, ok := status[name]; !ok || got != nil {
			t.Fatalf("host.window %s is %v (present %t), want null", name, got, ok)
		}
		declared, _ := properties[name].(map[string]any)
		if !reflect.DeepEqual(declared["type"], schema) {
			t.Fatalf("host.window declares %s as %v, want the type %v", name, declared, schema)
		}
	}
	regions := properties["regions"].(map[string]any)["items"].(map[string]any)["properties"].(map[string]any)
	if declared, _ := regions["presentedFrames"].(map[string]any); declared["type"] != "integer" {
		t.Fatalf("host.window declares the region member presentedFrames as %v, want an integer", declared)
	}
}
