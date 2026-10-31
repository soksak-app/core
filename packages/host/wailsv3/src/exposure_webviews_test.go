package host

import "testing"

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
