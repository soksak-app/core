//go:build diagnostics

package host

import (
	"path/filepath"
	"testing"
)

type fakeCaptureStatus struct {
	limited bool
	gap     float64
}

func (c fakeCaptureStatus) Limited() bool       { return c.limited }
func (c fakeCaptureStatus) LongestGap() float64 { return c.gap }

// contract: diagnostics.capture-stop.payload-reports-frame-limit
func TestCaptureStopPayloadReportsNormalFrameLimit(t *testing.T) {
	payload := captureStopPayload(fakeCaptureStatus{limited: true, gap: 42.5}, "/tmp/frames", 600, nil)
	if payload["frames"] != "/tmp/frames" || payload["callbackStatus"] != "/tmp/frames/callback-status.jsonl" || payload["displayLink"] != "/tmp/frames/display-link.json" || payload["count"] != 600 || payload["limited"] != true || payload["longestGap"] != 42.5 {
		t.Fatalf("payload = %#v", payload)
	}
}

// contract: diagnostics.capture-stop.payload-reports-callback-status
func TestCaptureStopPayloadNamesCallbackStatusArtifact(t *testing.T) {
	payload := captureStopPayload(fakeCaptureStatus{}, "/tmp/frames", 3, nil)
	if payload["callbackStatus"] != filepath.Join("/tmp/frames", "callback-status.jsonl") {
		t.Fatalf("callback status path = %#v", payload["callbackStatus"])
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

// contract: diagnostics.native-window-color-space.reports-appkit-profile
func TestNativeWindowColorSpaceMethodIsDeclared(t *testing.T) {
	if diagnosticMethods["diagnostics.native.window-color-space"] == nil {
		t.Fatal("the diagnostic endpoint has no native window color-space query")
	}
}
