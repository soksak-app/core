//go:build diagnostics

package host

import "testing"

type fakeCaptureStatus struct {
	limited bool
	gap     float64
}

func (c fakeCaptureStatus) Limited() bool       { return c.limited }
func (c fakeCaptureStatus) LongestGap() float64 { return c.gap }

// contract: diagnostics.capture-stop.payload-reports-frame-limit
func TestCaptureStopPayloadReportsNormalFrameLimit(t *testing.T) {
	payload := captureStopPayload(fakeCaptureStatus{limited: true, gap: 42.5}, "/tmp/frames", 600, nil)
	if payload["frames"] != "/tmp/frames" || payload["count"] != 600 || payload["limited"] != true || payload["longestGap"] != 42.5 {
		t.Fatalf("payload = %#v", payload)
	}
}

// contract: diagnostics.capture-stop.payload-reports-unbounded
func TestCaptureStopPayloadReportsUnboundedRecording(t *testing.T) {
	payload := captureStopPayload(fakeCaptureStatus{limited: false}, "/tmp/frames", 3, nil)
	if payload["limited"] != false {
		t.Fatalf("payload = %#v", payload)
	}
}

// contract: diagnostics.capture-stop.payload-reports-layout-timeline
func TestCaptureStopPayloadRequiresLayoutTimeline(t *testing.T) {
	payload := captureStopPayload(fakeCaptureStatus{}, "/tmp/frames", 3, nil)
	if _, ok := payload["layouts"]; !ok {
		t.Fatalf("capture stop omitted layouts: %#v", payload)
	}
}

// contract: diagnostics.capture-stop.payload-preserves-layout-stages
func TestCaptureStopPayloadPreservesLayoutStages(t *testing.T) {
	payload := captureStopPayload(fakeCaptureStatus{}, "/tmp/frames", 3, [][5]float64{{7, 10, 20, 30, 15}})
	layouts := payload["layouts"].([]map[string]any)
	if len(layouts) != 1 || layouts[0]["ticket"] != uint64(7) || layouts[0]["begun"] != float64(10) || layouts[0]["requested"] != float64(15) || layouts[0]["presented"] != float64(20) || layouts[0]["committed"] != float64(30) {
		t.Fatalf("layout stages changed: %#v", payload)
	}
}

// contract: diagnostics.input-reference.declared
func TestInputReferenceMethodIsDeclared(t *testing.T) {
	if diagnosticMethods["diagnostics.input.reference"] == nil {
		t.Fatal("the diagnostic endpoint has no same-window input reference")
	}
}

// contract: diagnostics.input-reference.validates-document
func TestInputReferenceValidatesDocument(t *testing.T) {
	for _, action := range []string{"open", "read", "focus", "close"} {
		got, document, err := parseInputReference([]byte(`{"action":"` + action + `"}`))
		if err != nil || got != action || document != nil {
			t.Fatalf("action %s: %s, %v, %v", action, got, document, err)
		}
	}
	for _, document := range []string{`""`, `"a😀"`} {
		_, got, err := parseInputReference([]byte(`{"action":"wait","document":` + document + `}`))
		if err != nil || got == nil {
			t.Fatalf("document %s: %v, %v", document, got, err)
		}
	}
	for _, params := range []string{`null`, `[]`, `{}`, `{"action":"invalid"}`, `{"action":"open","document":null}`, `{"action":"read","document":""}`, `{"action":"close","document":null}`, `{"action":"wait"}`, `{"action":"wait","document":null}`, `{"action":"wait","document":3}`} {
		if _, _, err := parseInputReference([]byte(params)); err == nil {
			t.Fatalf("accepted invalid params %s", params)
		}
	}
}
