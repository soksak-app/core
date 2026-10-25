//go:build diagnostics

package host

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// contract: recording.finish.layout-trace-failure-preserves-folder
func TestCaptureStopLayoutFailurePreservesStartedFolder(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "frames")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}

	_, err := finishCaptureStop(fakeCaptureStatus{}, directory, 1, false, func() ([][5]float64, error) {
		return nil, errors.New("layout trace stop failed")
	})
	if err == nil || err.Error() != "layout trace stop failed" {
		t.Fatalf("finishCaptureStop error = %v", err)
	}
	if info, statErr := os.Stat(directory); statErr != nil || !info.IsDir() {
		t.Fatalf("failed capture directory was not preserved: stat=%v info=%v", statErr, info)
	}
}

// contract: diagnostics.capture-start.preserves-display-option-parsing
func TestCaptureStartOptionsPreserveDisplayParsing(t *testing.T) {
	for _, test := range []struct {
		name string
		json string
		want bool
	}{
		{name: "omitted", json: `{}`, want: false},
		{name: "false", json: `{"display":false}`, want: false},
		{name: "true", json: `{"display":true}`, want: true},
		{name: "null remains false", json: `{"display":null}`, want: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := parseCaptureStartOptions(json.RawMessage(test.json))
			if err != nil || got.Display != test.want {
				t.Fatalf("parseCaptureStartOptions(%s) = %+v, %v; want display %t", test.json, got, err, test.want)
			}
		})
	}
	for _, value := range []string{`"true"`, `1`, `[]`, `{}`} {
		if _, err := parseCaptureStartOptions(json.RawMessage(`{"display":` + value + `}`)); err == nil {
			t.Errorf("display value %s was accepted", value)
		}
	}
}

// contract: diagnostics.capture-start.frame-identity-is-strict-boolean
func TestCaptureStartFrameIdentityRejectsNull(t *testing.T) {
	if _, err := parseCaptureStartOptions(json.RawMessage(`{"frameIdentity":null}`)); err == nil {
		t.Fatal("frameIdentity null was accepted as the default false value")
	}
}

// contract: diagnostics.capture-start.parses-frame-identity-option
func TestCaptureStartOptionsParseFrameIdentity(t *testing.T) {
	for _, test := range []struct {
		name string
		json string
		want bool
	}{
		{name: "omitted", json: `{}`, want: false},
		{name: "false", json: `{"frameIdentity":false}`, want: false},
		{name: "true", json: `{"frameIdentity":true}`, want: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := parseCaptureStartOptions(json.RawMessage(test.json))
			if err != nil || got.FrameIdentity != test.want {
				t.Fatalf("parseCaptureStartOptions(%s) = %+v, %v; want frameIdentity %t", test.json, got, err, test.want)
			}
		})
	}
	for _, value := range []string{`null`, `"true"`, `1`, `[]`, `{}`} {
		if _, err := parseCaptureStartOptions(json.RawMessage(`{"frameIdentity":` + value + `}`)); err == nil {
			t.Errorf("frameIdentity value %s was accepted", value)
		}
	}
}

type fakeCaptureStatus struct {
	limited bool
	gap     float64
}

type captureStartProbe struct {
	frameIdentity bool
	failStop      bool
}

func (*captureStartProbe) Open(CaptureTarget) error { return nil }
func (c *captureStartProbe) Start(_ string, frameIdentity bool) error {
	c.frameIdentity = frameIdentity
	return nil
}
func (*captureStartProbe) Wait() (bool, error) { return true, nil }
func (c *captureStartProbe) Stop() (int, error) {
	if c.failStop {
		return 0, errors.New("stop failed")
	}
	return 1, nil
}

// contract: diagnostics.capture-start.forwards-frame-identity
func TestRecordingStartForwardsFrameIdentity(t *testing.T) {
	fake := &captureStartProbe{}
	var recording Recording
	if err := recording.Start(fake, CaptureTarget{Window: 7}, filepath.Join(t.TempDir(), "frames"), true); err != nil {
		t.Fatal(err)
	}
	if !fake.frameIdentity {
		t.Fatal("recording start did not forward frameIdentity")
	}
}

// contract: recording.finish.preserves-frame-identity-option
func TestRecordingFinishPreservesFrameIdentityOption(t *testing.T) {
	fake := &captureStartProbe{}
	var recording Recording
	directory := filepath.Join(t.TempDir(), "frames")
	if err := recording.Start(fake, CaptureTarget{Window: 7}, directory, true); err != nil {
		t.Fatal(err)
	}
	finishedDirectory, _, frameIdentity, err := recording.Finish(fake)
	if err != nil || finishedDirectory != directory || !frameIdentity {
		t.Fatalf("finish directory=%q frameIdentity=%v error=%v", finishedDirectory, frameIdentity, err)
	}
}

// contract: recording.finish.stop-failure-preserves-folder
func TestRecordingFinishStopFailurePreservesFolder(t *testing.T) {
	fake := &captureStartProbe{failStop: true}
	var recording Recording
	directory := filepath.Join(t.TempDir(), "frames")
	if err := recording.Start(fake, CaptureTarget{Window: 7}, directory, false); err != nil {
		t.Fatal(err)
	}

	finishedDirectory, _, _, err := recording.Finish(fake)
	if finishedDirectory != directory || err == nil || err.Error() != "stop failed" {
		t.Fatalf("finish directory=%q error=%v", finishedDirectory, err)
	}
	if info, statErr := os.Stat(directory); statErr != nil || !info.IsDir() {
		t.Fatalf("failed capture directory was not preserved: stat=%v info=%v", statErr, info)
	}
	if recording.Running() != "" {
		t.Fatalf("recording still running at %q", recording.Running())
	}
}

func (c fakeCaptureStatus) Limited() bool       { return c.limited }
func (c fakeCaptureStatus) LongestGap() float64 { return c.gap }

// contract: diagnostics.capture-stop.payload-reports-frame-limit
func TestCaptureStopPayloadReportsNormalFrameLimit(t *testing.T) {
	payload := captureStopPayload(fakeCaptureStatus{limited: true, gap: 42.5}, "/tmp/frames", 600, nil, false)
	if payload["frames"] != "/tmp/frames" || payload["callbackStatus"] != "/tmp/frames/callback-status.jsonl" || payload["displayLink"] != "/tmp/frames/display-link.json" || payload["count"] != 600 || payload["limited"] != true || payload["longestGap"] != 42.5 {
		t.Fatalf("payload = %#v", payload)
	}
}

// contract: diagnostics.capture-stop.payload-reports-callback-status
func TestCaptureStopPayloadNamesCallbackStatusArtifact(t *testing.T) {
	payload := captureStopPayload(fakeCaptureStatus{}, "/tmp/frames", 3, nil, false)
	if payload["callbackStatus"] != filepath.Join("/tmp/frames", "callback-status.jsonl") {
		t.Fatalf("callback status path = %#v", payload["callbackStatus"])
	}
}

func TestCaptureStopPayloadNamesOptInFrameIdentityArtifact(t *testing.T) {
	payload := captureStopPayload(fakeCaptureStatus{}, "/tmp/frames", 3, nil, true)
	identity, ok := payload["frameIdentity"].(map[string]any)
	if !ok || identity["status"] != "complete" || identity["manifest"] != filepath.Join("/tmp/frames", "frame-identities", "manifest.json") {
		t.Fatalf("opt-in identity artifact was not returned: %#v", payload)
	}
}

// contract: diagnostics.capture-stop.payload-reports-unbounded
func TestCaptureStopPayloadReportsUnboundedRecording(t *testing.T) {
	payload := captureStopPayload(fakeCaptureStatus{limited: false}, "/tmp/frames", 3, nil, false)
	if payload["limited"] != false {
		t.Fatalf("payload = %#v", payload)
	}
}

// contract: diagnostics.capture-stop.payload-reports-layout-timeline
func TestCaptureStopPayloadRequiresLayoutTimeline(t *testing.T) {
	payload := captureStopPayload(fakeCaptureStatus{}, "/tmp/frames", 3, nil, false)
	if _, ok := payload["layouts"]; !ok {
		t.Fatalf("capture stop omitted layouts: %#v", payload)
	}
}

// contract: diagnostics.capture-stop.payload-preserves-layout-stages
func TestCaptureStopPayloadPreservesLayoutStages(t *testing.T) {
	payload := captureStopPayload(fakeCaptureStatus{}, "/tmp/frames", 3, [][5]float64{{7, 10, 20, 30, 15}}, false)
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
