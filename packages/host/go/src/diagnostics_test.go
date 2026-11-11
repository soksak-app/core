//go:build diagnostics

package host

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
	"unsafe"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// contract: recording.finish.layout-trace-failure-preserves-folder
func TestCaptureStopLayoutFailurePreservesStartedFolder(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "frames")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}

	_, err := finishCaptureStop(fakeCaptureStatus{}, directory, 1, false, func() ([]platform.LayoutRecord, error) {
		return nil, errors.New("layout trace stop failed")
	})
	if err == nil || err.Error() != "layout trace stop failed" {
		t.Fatalf("finishCaptureStop error = %v", err)
	}
	if info, statErr := os.Stat(directory); statErr != nil || !info.IsDir() {
		t.Fatalf("failed capture directory was not preserved: stat=%v info=%v", statErr, info)
	}
}

// contract: diagnostics.capture-document-identity.callback-ends-the-wait
func TestTheFrameIdentityWaitEndsByItsCallback(t *testing.T) {
	t.Parallel()
	s := &Surfaces{invoke: func(work func()) { work() }}
	want := json.RawMessage(`{"generation":7}`)
	reply, err := awaitDocumentFrameIdentity(s, func(done func(json.RawMessage, error)) error {
		// The library answers once on every path, from another routine after the wait began; the wait ends by that answer.
		go done(want, nil)
		return nil
	})
	if err != nil || string(reply) != string(want) {
		t.Fatalf("awaitDocumentFrameIdentity = %s, %v; want the reply of the callback %s", reply, err, want)
	}
}

// contract: diagnostics.capture-document-identity.reports-late-callback-errors
func TestAwaitDocumentFrameIdentityReportsALateErrorAfterAFailedSchedule(t *testing.T) {
	isolateTraceRecords(t)
	s := &Surfaces{invoke: func(work func()) { work() }}
	var callback func(json.RawMessage, error)
	scheduleErr := errors.New("native operation was not scheduled")
	reply, err := awaitDocumentFrameIdentity(s, func(done func(json.RawMessage, error)) error {
		callback = done
		return scheduleErr
	})
	if !errors.Is(err, scheduleErr) || reply != nil {
		t.Fatalf("awaitDocumentFrameIdentity = %s, %v; want the schedule failure and no source result", reply, err)
	}
	if callback == nil {
		t.Fatal("native callback was not registered")
	}

	callback(nil, errors.New("late native identity callback failed"))
	errors := bufferedTraces(t, "host.record.error")
	if len(errors) != 1 {
		t.Fatalf("late callback error records = %#v, want one error", errors)
	}
	if errors[0]["where"] != "document frame identity callback" || errors[0]["text"] != "late native identity callback failed" {
		t.Fatalf("late callback error record = %#v, want the callback error at its source", errors[0])
	}
}

// contract: diagnostics.capture-document-identity.callback-completion-is-single-use
func TestAwaitDocumentFrameIdentitySynchronousCallbackReturnsResult(t *testing.T) {
	s := &Surfaces{invoke: func(work func()) { work() }}
	want := json.RawMessage(`{"generation":7}`)
	reply, err := awaitDocumentFrameIdentity(s, func(done func(json.RawMessage, error)) error {
		done(want, nil)
		return nil
	})
	if err != nil || string(reply) != string(want) {
		t.Fatalf("awaitDocumentFrameIdentity = %s, %v; want synchronous result %s", reply, err, want)
	}
}

// contract: diagnostics.capture-document-identity.callback-completion-is-single-use
func TestAwaitDocumentFrameIdentityReportsDuplicateCallback(t *testing.T) {
	isolateTraceRecords(t)
	s := &Surfaces{invoke: func(work func()) { work() }}
	var first error
	reply, err := awaitDocumentFrameIdentity(s, func(done func(json.RawMessage, error)) error {
		done(json.RawMessage(`{"generation":7}`), nil)
		first = errors.New("identity callback completion invoked more than once")
		done(nil, first)
		return nil
	})
	if err != nil || string(reply) != `{"generation":7}` {
		t.Fatalf("awaitDocumentFrameIdentity = %s, %v; want first callback result", reply, err)
	}
	got := bufferedTraces(t, "host.record.error")
	if len(got) != 1 || got[0]["where"] != "document frame identity callback" ||
		!strings.Contains(got[0]["text"].(string), "completed more than once") ||
		!strings.Contains(got[0]["text"].(string), first.Error()) {
		t.Fatalf("duplicate callback records = %#v, want one explicit callback error", got)
	}
}

// contract: diagnostics.capture-document-identity.schedule-error-preserves-callback-error
func TestAwaitDocumentFrameIdentityPreservesCallbackErrorWhenScheduleFails(t *testing.T) {
	scheduleErr := errors.New("identity operation was not scheduled")
	callbackErr := errors.New("identity callback failed")
	s := &Surfaces{invoke: func(work func()) { work() }}
	_, err := awaitDocumentFrameIdentity(s, func(done func(json.RawMessage, error)) error {
		done(nil, callbackErr)
		return scheduleErr
	})
	if !errors.Is(err, scheduleErr) || !errors.Is(err, callbackErr) {
		t.Fatalf("awaitDocumentFrameIdentity error = %v, want both schedule and callback errors", err)
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
	ownedStream   bool
}

func (*captureStartProbe) Open(CaptureTarget) error { return nil }
func (c *captureStartProbe) Start(_ string, frameIdentity bool) error {
	c.frameIdentity = frameIdentity
	c.ownedStream = true
	return nil
}
func (*captureStartProbe) Wait() (bool, error) { return true, nil }
func (c *captureStartProbe) Stop() (int, error) {
	if c.failStop {
		return 0, errors.New("stop failed")
	}
	c.ownedStream = false
	return 1, nil
}
func (c *captureStartProbe) HasStream() (bool, error) { return c.ownedStream, nil }

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
	if recording.Running() != directory {
		t.Fatalf("failed finish lost cleanup owner: running=%q want=%q", recording.Running(), directory)
	}
	blocked := recording.Start(&captureStartProbe{}, CaptureTarget{Window: 8}, filepath.Join(t.TempDir(), "next"), false)
	if blocked == nil || !strings.Contains(blocked.Error(), "is running") {
		t.Fatalf("a new recording was not blocked: %v", blocked)
	}
	fake.failStop = false
	if err := recording.Abort(fake); err != nil {
		t.Fatal(err)
	}
	_, statErr := os.Stat(directory)
	if recording.Running() != "" || !os.IsNotExist(statErr) {
		t.Fatalf("abort retry left running=%q folder error=%v", recording.Running(), statErr)
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
	records := []platform.LayoutRecord{
		{Ticket: 7, Begun: 10, Requested: 15, Presented: 20, Committed: 30, CommitPath: "view-join", OpenAtCommit: 1},
		{Ticket: 8, Begun: 40, Requested: math.NaN(), Presented: math.NaN(), Committed: math.NaN(), OpenAtCommit: math.NaN()},
	}
	payload := captureStopPayload(fakeCaptureStatus{}, "/tmp/frames", 3, records, false)
	layouts := payload["layouts"].([]map[string]any)
	want := []map[string]any{
		{"ticket": uint64(7), "begun": float64(10), "requested": float64(15), "presented": float64(20), "committed": float64(30), "commitPath": "view-join", "openAtCommit": float64(1)},
		{"ticket": uint64(8), "begun": float64(40), "requested": nil, "presented": nil, "committed": nil, "commitPath": nil, "openAtCommit": nil},
	}
	if !reflect.DeepEqual(layouts, want) {
		t.Fatalf("layout entries = %#v, want %#v", layouts, want)
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

// contract: diagnostics.capture.document-identity.start.is-declared
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
	// order records the entries in the order they ran: a stop that entered while the start held the lifecycle comes first.
	var orderMu sync.Mutex
	var order []string
	enter := func(name string) {
		orderMu.Lock()
		order = append(order, name)
		orderMu.Unlock()
	}
	go func() {
		results <- withDocumentFrameIdentityLifecycle(func() error {
			close(recordingStarted)
			<-allowTrace
			enter("trace")
			close(traceStarted)
			return nil
		})
	}()
	<-recordingStarted
	// While the capture start holds the lifecycle, no other operation can enter it.
	if documentFrameIdentityMu.TryLock() {
		documentFrameIdentityMu.Unlock()
		close(allowTrace)
		t.Fatal("the lifecycle was free while new capture trace initialization was pending")
	}
	// The stop enters after the start returned, which is after its trace initialization.
	go func() {
		results <- withDocumentFrameIdentityLifecycle(func() error {
			enter("stop")
			close(stopStarted)
			return nil
		})
	}()
	close(allowTrace)
	<-traceStarted
	<-stopStarted
	for range 2 {
		if err := <-results; err != nil {
			t.Fatalf("capture lifecycle operation: %v", err)
		}
	}
	if !reflect.DeepEqual(order, []string{"trace", "stop"}) {
		t.Fatalf("the lifecycle ran %v, want the trace initialization of the start before the stop", order)
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
		errors.New("the start callback failed"),
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

// contract: diagnostics.capture-document-identity.start-validates-current-root-generation
func TestCaptureDocumentIdentityStartResolvesCurrentRootHandle(t *testing.T) {
	s := &Surfaces{documents: NewDocuments(), sourceOrigins: newSourceOrigins()}
	generation, err := s.sourceOriginState().create("surface-a")
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
	return method(e, nil, json.RawMessage(params), nil)
}

// contract: diagnostics.document.viewport-marker.uses-the-owning-window-document, diagnostics.document.viewport-marker.schedules-native-work-and-returns-native-result
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

// contract: diagnostics.document.viewport-marker.requires-valid-parameters
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

// contract: diagnostics.document.viewport-marker.uses-the-owning-window-document
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

// contract: diagnostics.document.viewport-marker.uses-the-owning-window-document
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

// contract: diagnostics.document.viewport-marker.reports-native-errors
func TestDiagnosticViewportMarkerPropagatesNativeFailure(t *testing.T) {
	marker := &viewportMarkerPlatform{err: errors.New("native marker failed")}
	e, _, _ := viewportMarkerEndpoint(t, marker, true)
	_, err := runViewportMarker(t, e, `{"window":"window-a","surface":"surface-a","document":"document-a","enabled":true}`)
	if err == nil || err.Error() != "native marker failed" {
		t.Fatalf("native error = %v", err)
	}
}

// stoppedClock is a clock of the host that does not move, for the native drags of a check whose waits take no time.
func stoppedClock() time.Duration { return 0 }

// contract: diagnostics.drag.native-delivers-pointer-gesture
func TestNativeDragDeliversThePressTheStepsAndTheReleaseOfEachRoundTrip(t *testing.T) {
	for _, test := range []struct {
		params string
		want   bool
	}{{`{}`, false}, {`{"native":false}`, false}, {`{"native":true}`, true}} {
		if got, err := parseDragNative(json.RawMessage(test.params)); err != nil || got != test.want {
			t.Fatalf("parseDragNative(%s) = %t, %v; want %t", test.params, got, err, test.want)
		}
	}
	for _, value := range []string{`null`, `"true"`, `1`} {
		if _, err := parseDragNative(json.RawMessage(`{"native":` + value + `}`)); err == nil || !strings.Contains(err.Error(), "native must be a boolean") {
			t.Fatalf("parseDragNative with native %s: error %v, want native must be a boolean", value, err)
		}
	}

	// Two round trips of two steps out and two steps back from the boundary at 100,50.
	plan := dragPlan{Axis: "x", Line: 3, DX: 20, DY: -8, MS: 32, Times: 2}
	from := point{X: 100, Y: 50}
	var delivered []string
	ticks := 0
	var now time.Duration
	clock := func() time.Duration { return now }
	result, err := nativeDrag(plan, from, clock, func(input PointerInput) error {
		if input.Activate || input.Button != "left" {
			t.Fatalf("native drag input %+v activates or uses another button than the primary one", input)
		}
		delivered = append(delivered, fmt.Sprintf("%s %g,%g after %d", input.Phase, input.X, input.Y, ticks))
		return nil
	}, func() error { ticks++; now += 16 * time.Millisecond; return nil }, func() error { return nil })
	if err != nil {
		t.Fatalf("native drag: %v", err)
	}
	trip := func(after int) []string {
		return []string{
			fmt.Sprintf("down 100,50 after %d", after),
			fmt.Sprintf("drag 110,46 after %d", after+1), fmt.Sprintf("drag 120,42 after %d", after+2),
			fmt.Sprintf("drag 110,46 after %d", after+3), fmt.Sprintf("drag 100,50 after %d", after+4),
			fmt.Sprintf("up 100,50 after %d", after+4),
		}
	}
	if want := append(trip(0), trip(4)...); !reflect.DeepEqual(delivered, want) {
		t.Fatalf("native drag delivered\n%s\nwant\n%s", strings.Join(delivered, "\n"), strings.Join(want, "\n"))
	}
	// Each leg runs for its own duration, so its steps follow the step period: MS / 16 ms per leg, two legs per round trip.
	if wantSteps := 2 * plan.Times * (plan.MS / 16); result["from"] != from || result["steps"] != wantSteps || result["asked"] != plan.Times*2*plan.MS {
		t.Fatalf("native drag result %v, want from %v, steps %d and asked %d", result, from, wantSteps, plan.Times*2*plan.MS)
	}
	if took, ok := result["took"].(int64); !ok || took < 0 {
		t.Fatalf("native drag result took %#v, want a non-negative number of milliseconds", result["took"])
	}

	// A step that fails releases the press that is open, and the error names both.
	delivered = nil
	_, err = nativeDrag(dragPlan{Axis: "x", Line: 3, DX: 20, MS: 32, Times: 1}, from, stoppedClock, func(input PointerInput) error {
		delivered = append(delivered, input.Phase)
		if input.Phase == "drag" {
			return errors.New("the window did not accept the input")
		}
		return nil
	}, func() error { return nil }, func() error { return nil })
	if err == nil || err.Error() != "native drag step 1: the window did not accept the input" {
		t.Fatalf("native drag with a failing step: error %v", err)
	}
	if !reflect.DeepEqual(delivered, []string{"down", "drag", "up"}) {
		t.Fatalf("native drag with a failing step delivered %v, want down, drag and the release up", delivered)
	}
}

// contract: diagnostics.drag.native-delivers-pointer-gesture
func TestANativeDragPressesOnlyAfterTheWindowPresentedItsLayout(t *testing.T) {
	// The window answers late on the clock of the check, which only the answers move: each press must follow the answer, and
	// took leaves the waits out.
	const late = 40 * time.Millisecond
	var now time.Duration
	clock := func() time.Duration { return now }
	var events []string
	answers := 0
	result, err := nativeDrag(dragPlan{Axis: "x", Line: 3, DX: 20, MS: 32, Times: 3}, point{X: 100, Y: 50}, clock,
		func(input PointerInput) error {
			events = append(events, input.Phase)
			return nil
		}, func() error { now += 16 * time.Millisecond; return nil }, func() error {
			now += late
			answers++
			events = append(events, fmt.Sprintf("presented %d", answers))
			return nil
		})
	if err != nil {
		t.Fatalf("native drag: %v", err)
	}
	trip := func(answer int) []string {
		return []string{fmt.Sprintf("presented %d", answer), "down", "drag", "drag", "drag", "drag", "up"}
	}
	want := append(append(trip(1), trip(2)...), trip(3)...)
	if !reflect.DeepEqual(events, want) {
		t.Fatalf("native drag with a late window delivered\n%s\nwant\n%s", strings.Join(events, "\n"), strings.Join(want, "\n"))
	}
	waits, ok := result["pressWaits"].([]int64)
	if !ok || len(waits) != 3 {
		t.Fatalf("native drag pressWaits %#v, want the wait before each of the 3 presses", result["pressWaits"])
	}
	for i, wait := range waits {
		if wait != late.Milliseconds() {
			t.Fatalf("native drag pressWaits[%d] = %d ms, want the %d ms the window took to answer", i, wait, late.Milliseconds())
		}
	}
	// Three round trips of four steps of 16 ms each; the waits are not in took.
	if took, ok := result["took"].(int64); !ok || took != 192 {
		t.Fatalf("native drag took %#v ms, want 192 ms of steps without the waits", result["took"])
	}

	// A wait that fails delivers no press.
	events = nil
	var waitNow time.Duration
	_, err = nativeDrag(dragPlan{Axis: "x", Line: 3, DX: 20, MS: 32, Times: 2}, point{X: 100, Y: 50}, func() time.Duration { return waitNow },
		func(input PointerInput) error {
			events = append(events, input.Phase)
			return nil
		}, func() error { waitNow += 16 * time.Millisecond; return nil }, func() error {
			if len(events) > 0 {
				return errors.New("the window did not present within 10s")
			}
			return nil
		})
	if err == nil || err.Error() != "native drag wait before the press of round trip 2: the window did not present within 10s" {
		t.Fatalf("native drag with a failing wait: error %v", err)
	}
	if len(events) != 6 || events[5] != "up" {
		t.Fatalf("native drag with a failing wait delivered %v, want only the first round trip", events)
	}
}

// contract: diagnostics.drag.native-delivers-pointer-gesture
func TestStepPeriodFollowsTheRefreshRateOfTheWindowAndAssumesNone(t *testing.T) {
	sixty, oneTwenty := 60, 120
	for _, test := range []struct {
		rate *int
		want time.Duration
	}{{&sixty, time.Second / 60}, {&oneTwenty, time.Second / 120}} {
		if got, err := stepPeriod(test.rate); err != nil || got != test.want {
			t.Fatalf("stepPeriod(%d) = %v, %v; want %v", *test.rate, got, err, test.want)
		}
	}
	if _, err := stepPeriod(nil); err == nil || err.Error() != "the window is on no display with a refresh rate" {
		t.Fatalf("stepPeriod(nil) error %v, want the window is on no display with a refresh rate", err)
	}
}

// The method that makes a covered window draw its regions is a diagnostic method.
// contract: diagnostics.window.draw-covered.is-declared
func TestDrawCoveredIsADiagnosticMethod(t *testing.T) {
	if _, found := diagnosticMethods["diagnostics.window.draw-covered"]; !found {
		t.Fatal("diagnostics.window.draw-covered is not a diagnostic method")
	}
}

// contract: recording.drag.layout-trace-after-settle
func TestRecordedDragStopsItsLayoutTraceAfterTheLastLayoutIsPresented(t *testing.T) {
	var order []string
	result, err := stopAfterSettled(func() (int, error) {
		order = append(order, "settle")
		return 1, nil
	}, func() error {
		order = append(order, "stop")
		return nil
	})
	if result != 1 || err != nil || !reflect.DeepEqual(order, []string{"settle", "stop"}) {
		t.Fatalf("result %d, error %v, order %v; want 1, nil, [settle stop]", result, err, order)
	}

	order = nil
	_, err = stopAfterSettled(func() (int, error) {
		order = append(order, "settle")
		return 0, errors.New("the drag was not presented")
	}, func() error {
		order = append(order, "stop")
		return nil
	})
	if err == nil || err.Error() != "the drag was not presented" || !reflect.DeepEqual(order, []string{"settle", "stop"}) {
		t.Fatalf("error %v, order %v; want the drag error and the trace stopped after it", err, order)
	}
}

// contract: diagnostics.capture-wait.ends-with-the-connection
func TestTheEndOfTheConnectionEndsTheCaptureWaitsOnlyWhileItsRequestRuns(t *testing.T) {
	conn := endpointConnection(t)
	ended := 0
	remove := conn.onClose(func() { ended++ })
	conn.close("the requester closed")
	remove()
	if ended != 1 {
		t.Fatalf("the end of the connection while its request runs ended %d waits, want 1", ended)
	}

	returnedConn := endpointConnection(t)
	lateEnds := 0
	removeReturned := returnedConn.onClose(func() { lateEnds++ })
	removeReturned()
	returnedConn.close("the requester closed")
	if lateEnds != 0 {
		t.Fatalf("the end of the connection after the request returned ended %d waits", lateEnds)
	}
}

// contract: diagnostics.drag.page-legs-follow-the-refresh-rate
func TestPageLegsPaceEachStepByTheRefreshRateReadAtThatStep(t *testing.T) {
	reads := 0
	rateOf := func() (*int, error) {
		reads++
		rate := 60
		if reads > 3 {
			rate = 120
		}
		return &rate, nil
	}
	now := time.Duration(0)
	var waits []time.Duration
	var ticks []dragTick
	sendLegs(dragPlan{MS: 50, Times: 1}, rateOf, func() time.Duration { return now }, func(d time.Duration) {
		waits = append(waits, d)
		now += d
	}, func(tick dragTick) { ticks = append(ticks, tick) })
	if len(waits) != len(ticks) || len(waits) < 4 {
		t.Fatalf("%d waits for %d ticks; want one wait per tick and a leg longer than three steps", len(waits), len(ticks))
	}
	for i, wait := range waits {
		want := time.Second / 60
		if i >= 3 {
			want = time.Second / 120
		}
		if wait != want {
			t.Fatalf("step %d waited %v, want %v for the refresh rate read at that step", i, wait, want)
		}
	}
	lasts := 0
	for i, tick := range ticks {
		if tick.Error != "" {
			t.Fatalf("step %d failed: %s", i, tick.Error)
		}
		if tick.Last {
			lasts++
			if tick.Fraction != 1 {
				t.Fatalf("the last step of the leg reached %v, want 1", tick.Fraction)
			}
		} else if tick.Fraction <= 0 || tick.Fraction >= 1 {
			t.Fatalf("step %d reached %v of its leg, want a fraction between 0 and 1", i, tick.Fraction)
		}
	}
	if lasts != 2 {
		t.Fatalf("%d steps ended a leg, want one per leg of the round trip (2)", lasts)
	}

	var failed []dragTick
	sendLegs(dragPlan{MS: 50, Times: 1}, func() (*int, error) { return nil, errors.New("no window facts") },
		func() time.Duration { return 0 }, func(time.Duration) { t.Fatal("a failed read must not wait") },
		func(tick dragTick) { failed = append(failed, tick) })
	if len(failed) != 1 || failed[0].Error != "no window facts" {
		t.Fatalf("ticks after a failed read %v, want one error tick carrying the read error", failed)
	}

	var unpaced []dragTick
	sendLegs(dragPlan{MS: 50, Times: 1}, func() (*int, error) { return nil, nil },
		func() time.Duration { return 0 }, func(time.Duration) { t.Fatal("a missing rate must not wait") },
		func(tick dragTick) { unpaced = append(unpaced, tick) })
	if len(unpaced) != 1 || unpaced[0].Error != "the window is on no display with a refresh rate" {
		t.Fatalf("ticks without a refresh rate %v, want one error tick naming the missing display rate", unpaced)
	}
}
