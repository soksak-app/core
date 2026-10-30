package host

import "testing"

// contract: window.facts.plugin-host-webviews-are-counted-apart
func TestWindowStatusCountsPluginHostWebviewsApart(t *testing.T) {
	facts := windowFacts{AppDomWebviews: 2, DocumentWebviews: 1, PluginHostWebviews: 1}
	appDom, document, pluginHost := windowWebviewCounts(facts)
	if appDom != 2 || document != 1 || pluginHost != 1 {
		t.Fatalf("counts appDom %d, document %d, pluginHost %d, want 2, 1, 1", appDom, document, pluginHost)
	}
	row := windowWebviewRow(3, windowWebviewFacts{View: 33, PluginHost: true, Hidden: true})
	if !row.PluginHost || row.Main || row.Document || row.Visible || row.Order != 3 {
		t.Fatalf("plugin host row %#v, want pluginHost true, main false, document false, visible false, order 3", row)
	}
}

// contract: window.facts.modal-order-is-above-every-webview
func TestModalOrderIsAboveEveryNativeSurfaceAndWebview(t *testing.T) {
	// Two native surfaces have the orders 0 and 1, and five web views have the orders 0 to 4.
	if order := modalOrder(2, 5); order != 7 {
		t.Fatalf("modal order %d, want 7", order)
	}
}
