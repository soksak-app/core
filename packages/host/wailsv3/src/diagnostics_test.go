//go:build diagnostics

package host

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
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

// contract: diagnostics.capture.document-identity.start.is-registered
func TestCaptureDocumentIdentityStartIsRegistered(t *testing.T) {
	method, ok := diagnosticMethods["diagnostics.capture.document-identity.start"]
	if !ok || method == nil {
		t.Fatal("diagnostics.capture.document-identity.start is not registered")
	}
}

// contract: diagnostics.capture-document-identity.stop-preserves-captures-without-a-document-source
func TestCaptureStopPreservesCaptureModesWithoutDocumentSource(t *testing.T) {
	for _, frameIdentity := range []bool{false, true} {
		freezeCalls, stopCalls, removeCalls := 0, 0, 0
		issued, removed, err := documentIdentityStopSequence(
			frameIdentity,
			nil,
			nil,
			func(uint64) (json.RawMessage, error) {
				freezeCalls++
				return nil, nil
			},
			func() error { stopCalls++; return nil },
			func(uint64) (json.RawMessage, error) {
				removeCalls++
				return nil, nil
			},
		)
		if err != nil || issued != nil || !removed {
			t.Fatalf("frameIdentity=%t stop result issued=%v removed=%t error=%v", frameIdentity, issued, removed, err)
		}
		if freezeCalls != 0 || stopCalls != 1 || removeCalls != 0 {
			t.Fatalf("frameIdentity=%t operation counts freeze=%d stop=%d remove=%d", frameIdentity, freezeCalls, stopCalls, removeCalls)
		}
	}
}

// contract: diagnostics.capture-start.waits-for-prior-identity-removal
func TestCaptureStartWaitsForPriorIdentityRemoval(t *testing.T) {
	recordingStarted := make(chan struct{})
	allowTrace := make(chan struct{})
	traceStarted := make(chan struct{})
	stopStarted := make(chan struct{})
	results := make(chan error, 2)
	go func() {
		results <- withDocumentFrameIdentityLifecycle(func() error {
			close(recordingStarted)
			<-allowTrace
			close(traceStarted)
			return nil
		})
	}()
	<-recordingStarted
	go func() {
		results <- withDocumentFrameIdentityLifecycle(func() error {
			close(stopStarted)
			return nil
		})
	}()
	select {
	case <-stopStarted:
		close(allowTrace)
		<-results
		<-results
		t.Fatal("stop entered while new capture trace initialization was pending")
	case <-time.After(20 * time.Millisecond):
	}
	close(allowTrace)
	select {
	case <-traceStarted:
	case <-time.After(time.Second):
		t.Fatal("capture trace initialization remained blocked")
	}
	select {
	case <-stopStarted:
	case <-time.After(time.Second):
		t.Fatal("stop remained blocked after capture trace initialization")
	}
	for range 2 {
		if err := <-results; err != nil {
			t.Fatalf("capture lifecycle operation: %v", err)
		}
	}
}

// contract: diagnostics.capture-document-identity.stop-orders-freeze-capture-and-cleanup
func TestCaptureStopFreezesAndRemovesTheSelectedSourceAfterRecording(t *testing.T) {
	source := &documentFrameIdentitySource{surface: "surface-a", generation: 7}
	var phases []string
	issued, removed, err := documentIdentityStopSequence(
		true,
		source,
		nil,
		func(generation uint64) (json.RawMessage, error) {
			phases = append(phases, "freeze")
			if generation != source.generation {
				t.Fatalf("freeze generation=%d", generation)
			}
			return json.RawMessage(`{"generation":7,"atlasSlots":300,"issuedSlots":2}`), nil
		},
		func() error { phases = append(phases, "capture-stop"); return nil },
		func(generation uint64) (json.RawMessage, error) {
			phases = append(phases, "remove")
			if generation != source.generation {
				t.Fatalf("remove generation=%d", generation)
			}
			return json.RawMessage(`{"generation":7,"removed":true}`), nil
		},
	)
	if err != nil || issued == nil || *issued != 2 || !removed {
		t.Fatalf("stop result issued=%v removed=%t error=%v", issued, removed, err)
	}
	if !reflect.DeepEqual(phases, []string{"freeze", "capture-stop", "remove"}) {
		t.Fatalf("stop phases=%v", phases)
	}
}

// contract: diagnostics.capture-document-identity.stop-does-not-credit-unconfirmed-freeze
func TestCaptureStopStillCleansUpAfterFreezeFailure(t *testing.T) {
	source := &documentFrameIdentitySource{surface: "surface-a", generation: 7}
	stopCalls, removeCalls := 0, 0
	issued, removed, err := documentIdentityStopSequence(
		true,
		source,
		nil,
		func(uint64) (json.RawMessage, error) { return nil, errors.New("freeze timeout") },
		func() error { stopCalls++; return nil },
		func(uint64) (json.RawMessage, error) {
			removeCalls++
			return json.RawMessage(`{"generation":7,"removed":true}`), nil
		},
	)
	if err == nil || issued != nil || !removed || stopCalls != 1 || removeCalls != 1 {
		t.Fatalf("freeze failure stop result issued=%v removed=%t stop=%d remove=%d error=%v", issued, removed, stopCalls, removeCalls, err)
	}
}

// contract: diagnostics.capture-document-identity.stop-drains-late-start-before-cleanup
func TestCaptureStopDrainsPendingStartWithoutCreditingItsUnconfirmedCount(t *testing.T) {
	source := &documentFrameIdentitySource{surface: "surface-a", generation: 7}
	phases := make([]string, 0, 3)
	issued, removed, err := documentIdentityStopSequence(
		true,
		source,
		errors.New("start callback timed out"),
		func(uint64) (json.RawMessage, error) {
			phases = append(phases, "freeze")
			return json.RawMessage(`{"generation":7,"atlasSlots":300,"issuedSlots":2}`), nil
		},
		func() error { phases = append(phases, "capture-stop"); return nil },
		func(uint64) (json.RawMessage, error) {
			phases = append(phases, "remove")
			return json.RawMessage(`{"generation":7,"removed":true}`), nil
		},
	)
	if err == nil || issued != nil || !removed {
		t.Fatalf("pending start result issued=%v removed=%t error=%v", issued, removed, err)
	}
	if !reflect.DeepEqual(phases, []string{"freeze", "capture-stop", "remove"}) {
		t.Fatalf("pending start cleanup phases=%v", phases)
	}
}

// contract: diagnostics.capture-document-identity.start-resolves-current-root-handle
func TestCaptureDocumentIdentityStartResolvesCurrentRootHandle(t *testing.T) {
	s := &Surfaces{documents: NewDocuments(), sourceOrigins: newSourceOrigins()}
	generation, err := s.sourceOriginState().create("surface-a", true)
	if err != nil {
		t.Fatal(err)
	}
	handle := new(byte)
	key := DocumentKey{Surface: "surface-a", Name: ""}
	if err := s.documents.Reserve(key); err != nil {
		t.Fatal(err)
	}
	if !s.documents.Set(key, unsafe.Pointer(handle)) {
		t.Fatal("root document reservation disappeared")
	}
	s.documents.views["surface-a"] = &viewChannel{generation: generation, handle: unsafe.Pointer(handle)}
	got, err := s.documentFrameIdentityRoot("surface-a", generation)
	if err != nil || got != unsafe.Pointer(handle) {
		t.Fatalf("root handle=%p error=%v", got, err)
	}
	if _, err := s.documentFrameIdentityRoot("surface-a", generation+1); err == nil {
		t.Fatal("stale generation was accepted")
	}
	s.documents.views["surface-a"].handle = unsafe.Pointer(new(byte))
	if _, err := s.documentFrameIdentityRoot("surface-a", generation); err == nil {
		t.Fatal("root handle mismatch was accepted")
	}
}

// contract: diagnostics.capture-document-identity.start-validates-native-metadata
func TestCaptureDocumentIdentityStartValidatesNativeMetadata(t *testing.T) {
	valid := json.RawMessage(`{"generation":7,"atlasSlots":300,"roi":{"x":1,"y":2,"width":30,"height":40,"scale":2}}`)
	var reply map[string]any
	if err := validateDocumentFrameIdentityStartReply(valid, 7, &reply); err != nil || reply["atlasSlots"] != float64(300) {
		t.Fatalf("valid native metadata reply=%#v error=%v", reply, err)
	}
	zeroOrigin := json.RawMessage(`{"generation":7,"atlasSlots":300,"roi":{"x":0,"y":0,"width":30,"height":40,"scale":2}}`)
	if err := validateDocumentFrameIdentityStartReply(zeroOrigin, 7, &reply); err != nil {
		t.Fatalf("valid zero-origin metadata was rejected: %v", err)
	}
	for _, raw := range []json.RawMessage{
		json.RawMessage(`{"generation":8,"atlasSlots":300,"roi":{"x":1,"y":2,"width":30,"height":40,"scale":2}}`),
		json.RawMessage(`{"generation":7,"atlasSlots":513,"roi":{"x":1,"y":2,"width":30,"height":40,"scale":2}}`),
		json.RawMessage(`{"generation":7,"atlasSlots":300,"roi":{"x":1,"y":2,"width":0,"height":40,"scale":2}}`),
		json.RawMessage(`{"generation":7,"atlasSlots":300,"roi":{"y":2,"width":30,"height":40,"scale":2}}`),
		json.RawMessage(`{"generation":7,"atlasSlots":300,"roi":{"x":1,"width":30,"height":40,"scale":2}}`),
		json.RawMessage(`null`),
	} {
		if err := validateDocumentFrameIdentityStartReply(raw, 7, &reply); err == nil {
			t.Fatalf("accepted invalid native metadata %s", raw)
		}
	}
}

// contract: diagnostics.capture-document-identity.stop-requires-issued-slots-field
func TestDocumentFrameIdentityIssuedSlotsRequiresField(t *testing.T) {
	for _, test := range []struct {
		name string
		raw  json.RawMessage
		want uint64
		bad  bool
	}{
		{name: "zero is valid", raw: json.RawMessage(`{"generation":7,"atlasSlots":300,"issuedSlots":0}`), want: 0},
		{name: "positive is valid", raw: json.RawMessage(`{"generation":7,"atlasSlots":300,"issuedSlots":2}`), want: 2},
		{name: "missing is invalid", raw: json.RawMessage(`{"generation":7,"atlasSlots":300}`), bad: true},
		{name: "above atlas is invalid", raw: json.RawMessage(`{"generation":7,"atlasSlots":2,"issuedSlots":3}`), bad: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := documentFrameIdentityIssuedSlots(test.raw, 7)
			if test.bad {
				if err == nil {
					t.Fatalf("accepted invalid issued slot reply %s as %d", test.raw, got)
				}
				return
			}
			if err != nil || got != test.want {
				t.Fatalf("issued slots=%d error=%v, want %d", got, err, test.want)
			}
		})
	}
}

// contract: diagnostics.capture-document-identity.start-rejects-invalid-parameters
func TestCaptureDocumentIdentityStartRejectsInvalidParameters(t *testing.T) {
	for _, raw := range []string{
		`{"window":"window-a","generation":7}`,
		`{"window":"window-a","surface":"","generation":7}`,
		`{"window":"window-a","surface":"surface-a"}`,
		`{"window":"window-a","surface":"surface-a","generation":0}`,
		`{"window":"window-a","surface":"surface-a","generation":9007199254740992}`,
		`{"window":"window-a","surface":"surface-a","generation":1.5}`,
	} {
		if _, err := parseCaptureDocumentIdentityRequest(json.RawMessage(raw)); err == nil {
			t.Fatalf("accepted invalid identity start parameters %s", raw)
		}
	}
}

// contract: diagnostics.capture-document-identity.start-selects-one-source-per-capture
func TestRecordingSelectsOneDocumentIdentitySource(t *testing.T) {
	recording := Recording{directory: "frames", frameIdentity: true, documentIdentityAllowed: true}
	active, source := recording.FrameIdentityState()
	if !active || source != nil {
		t.Fatalf("identity state before source active=%t source=%+v", active, source)
	}
	if err := recording.SelectFrameIdentitySource("surface-a", 7); err != nil {
		t.Fatal(err)
	}
	if err := recording.SelectFrameIdentitySource("surface-b", 8); err == nil {
		t.Fatal("capture accepted a second document source")
	}
	active, source = recording.FrameIdentityState()
	if !active || source == nil || source.surface != "surface-a" || source.generation != 7 {
		t.Fatalf("identity state after source active=%t source=%+v", active, source)
	}
	if recording.ClearFrameIdentitySource("surface-a", 8) {
		t.Fatal("cleared a source using a different generation")
	}
	if !recording.ClearFrameIdentitySource("surface-a", 7) {
		t.Fatal("did not clear the exact selected source")
	}
}

// contract: diagnostics.capture-document-identity.start-requires-explicit-capture-endpoint
func TestRecordingRejectsDocumentSourceForDragOwnedIdentityCapture(t *testing.T) {
	recording := Recording{directory: "frames", frameIdentity: true}
	if err := recording.SelectFrameIdentitySource("surface-a", 7); err == nil {
		t.Fatal("drag-owned identity capture accepted a document source")
	}
}

// contract: diagnostics.capture-document-identity.cleanup-source-survives-recording-stop
func TestRecordingRetainsSelectedSourceUntilNativeRemoval(t *testing.T) {
	recording := Recording{
		identitySource: &documentFrameIdentitySource{surface: "surface-a", generation: 7},
	}
	active, source := recording.FrameIdentityState()
	if active || source == nil || source.surface != "surface-a" || source.generation != 7 {
		t.Fatalf("inactive identity state active=%t source=%+v", active, source)
	}
}

// contract: diagnostics.capture-start.rejects-unconfirmed-identity-cleanup
func TestRecordingRejectsStartWhileDocumentIdentityCleanupIsIncomplete(t *testing.T) {
	probe := &captureStartProbe{}
	recording := Recording{
		identitySource: &documentFrameIdentitySource{surface: "surface-a", generation: 7},
	}
	err := recording.StartWithDocumentIdentity(probe, CaptureTarget{Window: 9}, filepath.Join(t.TempDir(), "frames"), true, true)
	if err == nil || !strings.Contains(err.Error(), "cleanup for surface \"surface-a\" generation 7 is incomplete") {
		t.Fatalf("start error = %v, want incomplete prior cleanup", err)
	}
	if probe.frameIdentity {
		t.Fatal("capture started while prior document identity cleanup was incomplete")
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
