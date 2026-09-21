//go:build diagnostics

package host

import "testing"

type fakeCaptureStatus struct {
	limited bool
	gap     float64
}

func (c fakeCaptureStatus) Limited() bool       { return c.limited }
func (c fakeCaptureStatus) LongestGap() float64 { return c.gap }

func TestCaptureStopPayloadReportsNormalFrameLimit(t *testing.T) {
	payload := captureStopPayload(fakeCaptureStatus{limited: true, gap: 42.5}, "/tmp/frames", 600)
	if payload["frames"] != "/tmp/frames" || payload["count"] != 600 || payload["limited"] != true || payload["longestGap"] != 42.5 {
		t.Fatalf("payload = %#v", payload)
	}
}

func TestCaptureStopPayloadReportsUnboundedRecording(t *testing.T) {
	payload := captureStopPayload(fakeCaptureStatus{limited: false}, "/tmp/frames", 3)
	if payload["limited"] != false {
		t.Fatalf("payload = %#v", payload)
	}
}
