//go:build diagnostics

package host

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unsafe"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
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

// contract: diagnostics.drag.forwards-frame-identity
func TestDiagnosticDragFrameIdentityRequiresCapture(t *testing.T) {
	for _, test := range []struct {
		name          string
		params        string
		wantCapture   bool
		wantIdentity  bool
		wantErrorText string
	}{
		{name: "default is disabled", params: `{}`},
		{name: "capture keeps identity disabled", params: `{"capture":true}`, wantCapture: true},
		{name: "explicit false", params: `{"capture":true,"frameIdentity":false}`, wantCapture: true},
		{name: "explicit true", params: `{"capture":true,"frameIdentity":true}`, wantCapture: true, wantIdentity: true},
		{name: "identity requires capture", params: `{"frameIdentity":true}`, wantErrorText: "frameIdentity requires capture to be true"},
		{name: "identity rejects disabled capture", params: `{"capture":false,"frameIdentity":true}`, wantErrorText: "frameIdentity requires capture to be true"},
		{name: "identity rejects null", params: `{"capture":true,"frameIdentity":null}`, wantErrorText: "frameIdentity must be a boolean"},
		{name: "identity rejects string", params: `{"capture":true,"frameIdentity":"true"}`, wantErrorText: "frameIdentity must be a boolean"},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := parseDragCaptureOptions(json.RawMessage(test.params))
			if test.wantErrorText != "" {
				if err == nil || !strings.Contains(err.Error(), test.wantErrorText) {
					t.Fatalf("parseDragCaptureOptions(%s) error = %v, want %q", test.params, err, test.wantErrorText)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseDragCaptureOptions(%s): %v", test.params, err)
			}
			if got.capture != test.wantCapture || got.frameIdentity != test.wantIdentity {
				t.Fatalf("parseDragCaptureOptions(%s) = %+v, want capture=%t frameIdentity=%t",
					test.params, got, test.wantCapture, test.wantIdentity)
			}
		})
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

// contract: recording.finish.keeps-folder-and-reports-frames
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

// contract: diagnostics.capture-stop.payload-names-opt-in-frame-identity-artifact
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

// contract: diagnostics.document.viewport-marker.is-declared
func TestDiagnosticViewportMarkerIsDeclared(t *testing.T) {
	method, ok := diagnosticMethods["diagnostics.document.viewport-marker"]
	if !ok || method == nil {
		t.Fatal("diagnostics.document.viewport-marker is not registered")
	}
}

type viewportMarkerPlatform struct {
	platform.Platform
	document unsafe.Pointer
	enabled  bool
	color    [3]uint8
	width    float64
	err      error
	calls    int
	inUI     func() bool
}

func (p *viewportMarkerPlatform) SetDocumentViewportMarker(document unsafe.Pointer, enabled bool) ([3]uint8, float64, error) {
	p.calls++
	p.document, p.enabled = document, enabled
	if p.inUI != nil && !p.inUI() {
		return [3]uint8{}, 0, errors.New("marker called outside UI thread")
	}
	return p.color, p.width, p.err
}

func viewportMarkerEndpoint(t *testing.T, marker *viewportMarkerPlatform, attached bool) (*Endpoint, *Surfaces, *byte) {
	t.Helper()
	h := &Host{windows: map[uint]*Surfaces{}}
	s := &Surfaces{name: "window-a", documents: NewDocuments()}
	h.windows[1] = s
	var document *byte
	if attached {
		key := DocumentKey{Surface: "surface-a", Name: "document-a"}
		if err := s.documents.Reserve(key); err != nil {
			t.Fatal(err)
		}
		document = new(byte)
		if !s.documents.Set(key, unsafe.Pointer(document)) {
			t.Fatal("document reservation disappeared")
		}
	}
	onUI := false
	s.invoke = func(task func()) {
		onUI = true
		task()
		onUI = false
	}
	marker.inUI = func() bool { return onUI }
	oldSystem := system
	system = marker
	t.Cleanup(func() { system = oldSystem })
	return &Endpoint{backend: hostBackend{h: h}}, s, document
}

func runViewportMarker(t *testing.T, e *Endpoint, params string) (any, error) {
	t.Helper()
	method := diagnosticMethods["diagnostics.document.viewport-marker"]
	if method == nil {
		t.Fatal("diagnostics.document.viewport-marker is not registered")
	}
	return method(e, nil, json.RawMessage(params))
}

// contract: diagnostics.document.viewport-marker.validates-owned-region-and-runs-on-ui
func TestDiagnosticViewportMarkerValidatesAndRunsOnUI(t *testing.T) {
	marker := &viewportMarkerPlatform{color: [3]uint8{0, 255, 255}, width: 2}
	e, _, document := viewportMarkerEndpoint(t, marker, true)
	result, err := runViewportMarker(t, e, `{"window":"window-a","surface":"surface-a","document":"document-a","enabled":true}`)
	if err != nil {
		t.Fatalf("diagnostics.document.viewport-marker: %v", err)
	}
	if marker.calls != 1 || marker.document != unsafe.Pointer(document) || !marker.enabled {
		t.Fatalf("native request = calls:%d document:%p enabled:%t", marker.calls, marker.document, marker.enabled)
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(encoded, &got); err != nil {
		t.Fatal(err)
	}
	if got["enabled"] != true || got["kind"] != "native" || got["borderWidthPt"] != float64(2) {
		t.Fatalf("reply = %s", encoded)
	}
	color, ok := got["markerColor"].([]any)
	if !ok || len(color) != 3 || color[0] != float64(0) || color[1] != float64(255) || color[2] != float64(255) {
		t.Fatalf("markerColor = %#v", got["markerColor"])
	}
}

// contract: diagnostics.document.viewport-marker.rejects-invalid-and-unowned-targets
func TestDiagnosticViewportMarkerRejectsInvalidAndUnownedTargets(t *testing.T) {
	for _, test := range []struct {
		name   string
		params string
	}{
		{"missing window", `{"surface":"surface-a","document":"document-a","enabled":true}`},
		{"empty surface", `{"window":"window-a","surface":"","document":"document-a","enabled":true}`},
		{"empty document", `{"window":"window-a","surface":"surface-a","document":"","enabled":true}`},
		{"missing enabled", `{"window":"window-a","surface":"surface-a","document":"document-a"}`},
		{"null enabled", `{"window":"window-a","surface":"surface-a","document":"document-a","enabled":null}`},
		{"string enabled", `{"window":"window-a","surface":"surface-a","document":"document-a","enabled":"true"}`},
		{"unowned surface", `{"window":"window-a","surface":"surface-b","document":"document-a","enabled":true}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			marker := &viewportMarkerPlatform{color: [3]uint8{0, 255, 255}, width: 2}
			e, _, _ := viewportMarkerEndpoint(t, marker, true)
			if _, err := runViewportMarker(t, e, test.params); err == nil {
				t.Fatalf("accepted invalid request %s", test.params)
			}
			if marker.calls != 0 {
				t.Fatalf("native marker called %d times for invalid request", marker.calls)
			}
		})
	}
}

// contract: diagnostics.document.viewport-marker.requires-existing-region-to-start
func TestDiagnosticViewportMarkerStartRequiresAttachedRegion(t *testing.T) {
	marker := &viewportMarkerPlatform{color: [3]uint8{0, 255, 255}, width: 2}
	e, _, _ := viewportMarkerEndpoint(t, marker, false)
	_, err := runViewportMarker(t, e, `{"window":"window-a","surface":"surface-a","document":"document-a","enabled":true}`)
	if err == nil || !strings.Contains(err.Error(), "not attached") {
		t.Fatalf("start without region error = %v", err)
	}
	if marker.calls != 0 {
		t.Fatalf("native marker called %d times for missing region", marker.calls)
	}
}

// contract: diagnostics.document.viewport-marker.stop-is-idempotent-after-region-removal
func TestDiagnosticViewportMarkerStopAfterRegionRemoval(t *testing.T) {
	marker := &viewportMarkerPlatform{color: [3]uint8{0, 255, 255}, width: 2}
	e, _, _ := viewportMarkerEndpoint(t, marker, false)
	result, err := runViewportMarker(t, e, `{"window":"window-a","surface":"surface-a","document":"document-a","enabled":false}`)
	if err != nil {
		t.Fatalf("stop after region removal: %v", err)
	}
	if marker.calls != 1 || marker.document != nil || marker.enabled {
		t.Fatalf("native stop = calls:%d document:%p enabled:%t", marker.calls, marker.document, marker.enabled)
	}
	if result == nil {
		t.Fatal("stop after region removal returned no metadata")
	}
}

// contract: diagnostics.document.viewport-marker.propagates-native-failures
func TestDiagnosticViewportMarkerPropagatesNativeFailure(t *testing.T) {
	marker := &viewportMarkerPlatform{err: errors.New("native marker failed")}
	e, _, _ := viewportMarkerEndpoint(t, marker, true)
	_, err := runViewportMarker(t, e, `{"window":"window-a","surface":"surface-a","document":"document-a","enabled":true}`)
	if err == nil || err.Error() != "native marker failed" {
		t.Fatalf("native error = %v", err)
	}
}
