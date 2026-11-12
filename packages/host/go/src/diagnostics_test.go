//go:build diagnostics

package host

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
	"unsafe"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// contract: diagnostics.capture-start.preserves-display-option-parsing
func TestCaptureStartOptionsPreserveDisplayParsing(t *testing.T) {
	for _, test := range []struct {
		name string
		json string
		want bool
	}{
		{name: "omitted", json: `{"gap":8,"frames":10}`, want: false},
		{name: "false", json: `{"gap":8,"frames":10,"display":false}`, want: false},
		{name: "true", json: `{"gap":8,"frames":10,"display":true}`, want: true},
		{name: "null remains false", json: `{"gap":8,"frames":10,"display":null}`, want: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := parseCaptureStartOptions(json.RawMessage(test.json))
			if err != nil || got.Display != test.want {
				t.Fatalf("parseCaptureStartOptions(%s) = %+v, %v; want display %t", test.json, got, err, test.want)
			}
		})
	}
	for _, value := range []string{`"true"`, `1`, `[]`, `{}`} {
		if _, err := parseCaptureStartOptions(json.RawMessage(`{"gap":8,"frames":10,"display":` + value + `}`)); err == nil {
			t.Errorf("display value %s was accepted", value)
		}
	}
}

// contract: diagnostics.capture-start.validates-still-plan
func TestCaptureStartPlanTakesGapAndSecondsOrFrames(t *testing.T) {
	for _, test := range []struct {
		json string
		want CapturePlan
	}{
		{json: `{"gap":8.333,"seconds":2}`, want: CapturePlan{Gap: 8.333, Seconds: 2}},
		{json: `{"gap":1,"frames":4096}`, want: CapturePlan{Gap: 1, Frames: 4096}},
		{json: `{"gap":1000,"seconds":600}`, want: CapturePlan{Gap: 1000, Seconds: 600}},
		{json: `{"gap":146.484375,"seconds":600}`, want: CapturePlan{Gap: 146.484375, Seconds: 600}},
		{json: `{"gap":10,"frames":1,"seconds":null}`, want: CapturePlan{Gap: 10, Frames: 1}},
	} {
		got, err := parseCaptureStartOptions(json.RawMessage(test.json))
		if err != nil || got.Plan != test.want {
			t.Errorf("parseCaptureStartOptions(%s) = %+v, %v; want plan %+v", test.json, got.Plan, err, test.want)
		}
	}
	for _, test := range []struct{ json, want string }{
		{`{"frames":10}`, "gap must be a number of milliseconds from 1 to 1000"},
		{`{"gap":null,"frames":10}`, "gap must be a number of milliseconds from 1 to 1000"},
		{`{"gap":"8","frames":10}`, "gap must be a number of milliseconds from 1 to 1000"},
		{`{"gap":0.5,"frames":10}`, "gap must be a number of milliseconds from 1 to 1000"},
		{`{"gap":1000.5,"frames":10}`, "gap must be a number of milliseconds from 1 to 1000"},
		{`{"gap":8,"seconds":1,"frames":10}`, "give seconds or frames, not both"},
		{`{"gap":8}`, "a recording needs seconds or frames"},
		{`{"gap":8,"seconds":0}`, "seconds must be above 0 and at most 600"},
		{`{"gap":8,"seconds":600.5}`, "seconds must be above 0 and at most 600"},
		{`{"gap":8,"seconds":"1"}`, "seconds must be above 0 and at most 600"},
		{`{"gap":8,"frames":0}`, "frames must be an integer from 1 to 4096"},
		{`{"gap":8,"frames":4097}`, "frames must be an integer from 1 to 4096"},
		{`{"gap":8,"frames":2.5}`, "frames must be an integer from 1 to 4096"},
		{`{"gap":8,"seconds":40}`, "the recording plans 5000 stills, more than 4096"},
		{`{"gap":146,"seconds":600}`, "the recording plans 4110 stills, more than 4096"},
	} {
		_, err := parseCaptureStartOptions(json.RawMessage(test.json))
		if messageOf(err) != test.want {
			t.Errorf("parseCaptureStartOptions(%s) error %v, want %q", test.json, err, test.want)
		}
	}
	// The plan is checked before newWindow holds a window.
	if _, err := parseCaptureStartOptions(json.RawMessage(`{"newWindow":true}`)); messageOf(err) != "gap must be a number of milliseconds from 1 to 1000" {
		t.Errorf("newWindow without a plan: error %v", err)
	}
}

// contract: diagnostics.drag.takes-a-capture-plan
func TestDiagnosticDragCaptureTakesAPlan(t *testing.T) {
	for _, test := range []struct {
		params string
		want   dragCaptureOptions
	}{
		{params: `{}`, want: dragCaptureOptions{}},
		{params: `{"capture":null}`, want: dragCaptureOptions{}},
		{params: `{"capture":false}`, want: dragCaptureOptions{}},
		{params: `{"capture":{"gap":8.333,"frames":4096}}`, want: dragCaptureOptions{capture: true, plan: CapturePlan{Gap: 8.333, Frames: 4096}}},
		{params: `{"capture":{"gap":10,"seconds":2}}`, want: dragCaptureOptions{capture: true, plan: CapturePlan{Gap: 10, Seconds: 2}}},
		// A plan at the top level of the drag is not a plan of its recording.
		{params: `{"gap":8,"frames":10}`, want: dragCaptureOptions{}},
	} {
		got, err := parseDragCaptureOptions(json.RawMessage(test.params))
		if err != nil || got != test.want {
			t.Errorf("parseDragCaptureOptions(%s) = %+v, %v; want %+v", test.params, got, err, test.want)
		}
	}
	for _, test := range []struct{ params, want string }{
		{`{"capture":true}`, "capture must be false or a plan {gap, seconds | frames}"},
		{`{"capture":"yes"}`, "capture must be false or a plan {gap, seconds | frames}"},
		{`{"capture":1}`, "capture must be false or a plan {gap, seconds | frames}"},
		{`{"capture":[]}`, "capture must be false or a plan {gap, seconds | frames}"},
		{`{"capture":true,"gap":8,"frames":10}`, "capture must be false or a plan {gap, seconds | frames}"},
		{`{"capture":{}}`, "gap must be a number of milliseconds from 1 to 1000"},
		{`{"capture":{"gap":8,"seconds":1,"frames":10}}`, "give seconds or frames, not both"},
		{`{"capture":{"gap":8}}`, "a recording needs seconds or frames"},
		{`{"capture":{"gap":8,"seconds":601}}`, "seconds must be above 0 and at most 600"},
		{`{"capture":{"gap":8,"frames":4097}}`, "frames must be an integer from 1 to 4096"},
		{`{"capture":{"gap":8,"seconds":40}}`, "the recording plans 5000 stills, more than 4096"},
	} {
		if _, err := parseDragCaptureOptions(json.RawMessage(test.params)); messageOf(err) != test.want {
			t.Errorf("parseDragCaptureOptions(%s) error %v, want %q", test.params, err, test.want)
		}
	}
}

type fakeCaptureStatus struct {
	missed int
	late   int
	gap    float64
}

type captureStartProbe struct {
	plan     CapturePlan
	failStop bool
}

func (*captureStartProbe) Open(CaptureTarget) error { return nil }
func (c *captureStartProbe) Start(_ string, plan CapturePlan) error {
	c.plan = plan
	return nil
}
func (c *captureStartProbe) Stop() (int, error) {
	if c.failStop {
		return 0, errors.New("stop failed")
	}
	return 1, nil
}

// testPlan is the plan of the stills of the recordings of these tests.
var testPlan = CapturePlan{Gap: 8, Frames: 120}

// contract: recording.finish.keeps-folder-and-reports-frames
func TestRecordingFinishKeepsTheFolder(t *testing.T) {
	fake := &captureStartProbe{}
	var recording Recording
	directory := filepath.Join(t.TempDir(), "frames")
	if err := recording.Start(fake, CaptureTarget{Window: 7}, directory, testPlan); err != nil {
		t.Fatal(err)
	}
	finishedDirectory, _, window, err := recording.Finish(fake)
	if err != nil || finishedDirectory != directory || window == nil || *window != 7 {
		t.Fatalf("finish directory=%q window=%v error=%v", finishedDirectory, window, err)
	}
}

// contract: recording.finish.reports-the-recorded-window
func TestRecordingFinishReportsTheRecordedWindow(t *testing.T) {
	fake := &captureStartProbe{}
	var recording Recording
	if err := recording.Start(fake, CaptureTarget{Window: 7, Display: true}, filepath.Join(t.TempDir(), "display"), testPlan); err != nil {
		t.Fatal(err)
	}
	if _, _, window, err := recording.Finish(fake); err != nil || window != nil {
		t.Fatalf("a display recording finished with window %v and error %v, want nil and nil", window, err)
	}
	if err := recording.Start(fake, CaptureTarget{Window: 9}, filepath.Join(t.TempDir(), "window"), testPlan); err != nil {
		t.Fatal(err)
	}
	if _, _, window, err := recording.Finish(fake); err != nil || window == nil || *window != 9 {
		t.Fatalf("a window recording finished with window %v and error %v, want 9 and nil", window, err)
	}
}

func (c fakeCaptureStatus) Missed() int         { return c.missed }
func (c fakeCaptureStatus) Late() int           { return c.late }
func (c fakeCaptureStatus) LongestGap() float64 { return c.gap }

// contract: diagnostics.capture-stop.payload-reports-stills
func TestCaptureStopPayloadReportsStills(t *testing.T) {
	window := 31
	payload := captureStopPayload(fakeCaptureStatus{missed: 2, late: 1, gap: 42.5}, "/tmp/frames", 598, &window)
	want := map[string]any{
		"window":      31,
		"frames":      "/tmp/frames",
		"stills":      filepath.Join("/tmp/frames", "stills.jsonl"),
		"displayLink": filepath.Join("/tmp/frames", "display-link.json"),
		"count":       598,
		"missed":      2,
		"late":        1,
		"longestGap":  42.5,
	}
	for key, value := range want {
		if payload[key] != value {
			t.Errorf("payload[%q] = %#v, want %#v", key, payload[key], value)
		}
	}
	for key := range payload {
		if _, ok := want[key]; !ok {
			t.Errorf("payload has the member %q, which the stop does not report", key)
		}
	}
	// A display recording has no window of its own: the member is null, not absent.
	display := captureStopPayload(fakeCaptureStatus{}, "/tmp/frames", 3, nil)
	if value, ok := display["window"]; !ok || value != nil {
		t.Errorf("the stop of a display recording reports window %#v (present %t), want null", value, ok)
	}
}

// contract: diagnostics.layout-trace.reply-reports-layouts
func TestALayoutTraceWithoutTransactionsReportsAnEmptyList(t *testing.T) {
	encoded, err := json.Marshal(map[string]any{"layouts": layoutTrace(nil)})
	if err != nil || string(encoded) != `{"layouts":[]}` {
		t.Fatalf("the layout trace of no transaction is %s (%v), want an empty list", encoded, err)
	}
}

// contract: diagnostics.layout-trace.reply-preserves-layout-stages
func TestALayoutTraceKeepsTheStagesOfEachTransaction(t *testing.T) {
	records := []platform.LayoutRecord{
		{Ticket: 7, Begun: 10, Requested: 15, Presented: 20, Committed: 30, CommitPath: "view-join", OpenAtCommit: 1, Flushed: 35, Displayed: 41.6},
		{Ticket: 8, Begun: 40, Requested: math.NaN(), Presented: math.NaN(), Committed: math.NaN(), OpenAtCommit: math.NaN(), Flushed: math.NaN(), Displayed: math.NaN()},
	}
	want := []map[string]any{
		{"ticket": uint64(7), "begun": float64(10), "requested": float64(15), "presented": float64(20), "committed": float64(30), "commitPath": "view-join", "openAtCommit": float64(1), "flushed": float64(35), "displayed": float64(41.6)},
		{"ticket": uint64(8), "begun": float64(40), "requested": nil, "presented": nil, "committed": nil, "commitPath": nil, "openAtCommit": nil, "flushed": nil, "displayed": nil},
	}
	if layouts := layoutTrace(records); !reflect.DeepEqual(layouts, want) {
		t.Fatalf("layout entries = %#v, want %#v", layouts, want)
	}
}

// traceCapturer is a platform whose layout trace counts its starts and stops and answers records.
type traceCapturer struct {
	platform.Capturer
	starts, stops int
	records       []platform.LayoutRecord
}

func (c *traceCapturer) LayoutTraceStart() { c.starts++ }
func (c *traceCapturer) LayoutTraceStop() ([]platform.LayoutRecord, error) {
	c.stops++
	return c.records, nil
}

// One run holds the layout trace at a time, because a native start discards what the trace recorded; only the run that holds
// the trace stops it, and the end of the connection that started a trace of diagnostics.layout.trace stops it.
// contract: diagnostics.layout-trace.one-run-at-a-time
func TestTheLayoutTraceHasOneRunAtATime(t *testing.T) {
	previous := framework
	framework = pagelessFramework{window: &elementWindow{}}
	t.Cleanup(func() { framework = previous })
	native := &traceCapturer{records: []platform.LayoutRecord{{Ticket: 1}}}
	trace := platformCapture{Capturer: native}
	drag, other := &layoutTraceRun{}, &layoutTraceRun{endpoint: true}
	if err := startLayoutTrace(trace, drag); err != nil {
		t.Fatal(err)
	}
	if err := startLayoutTrace(trace, other); err == nil || err.Error() != "the layout trace is already running" {
		t.Fatalf("a second start answered %v", err)
	}
	if _, err := stopLayoutTrace(trace, other); err == nil || err.Error() != "no layout trace is running" {
		t.Fatalf("a stop of a run that does not hold the trace answered %v", err)
	}
	records, err := stopLayoutTrace(trace, drag)
	if err != nil || len(records) != 1 || native.starts != 1 || native.stops != 1 {
		t.Fatalf("the stop answered %v, %v after %d starts and %d stops", records, err, native.starts, native.stops)
	}
	ended := false
	other.forget = func() { ended = true }
	if err := startLayoutTrace(trace, other); err != nil {
		t.Fatal(err)
	}
	if _, err := stopLayoutTrace(trace, other); err != nil || !ended || layoutTraces.run != nil {
		t.Fatalf("the stop of an endpoint run answered %v, removed its connection end %t, left %v", err, ended, layoutTraces.run)
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
	}, periodicStep(&now, 16*time.Millisecond, func() { ticks++ }), func() error { return nil })
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
	if trips, ok := result["tripSteps"].([]int); !ok || !reflect.DeepEqual(trips, []int{4, 4}) {
		t.Fatalf("native drag result tripSteps %#v, want the 4 steps of each of the 2 round trips", result["tripSteps"])
	}

	// A step that fails releases the press that is open, and the error names both.
	delivered = nil
	_, err = nativeDrag(dragPlan{Axis: "x", Line: 3, DX: 20, MS: 32, Times: 1}, from, stoppedClock, func(input PointerInput) error {
		delivered = append(delivered, input.Phase)
		if input.Phase == "drag" {
			return errors.New("the window did not accept the input")
		}
		return nil
	}, func(previous time.Duration) (time.Duration, error) { return previous, nil }, func() error { return nil })
	if err == nil || err.Error() != "native drag step 1: the window did not accept the input" {
		t.Fatalf("native drag with a failing step: error %v", err)
	}
	if !reflect.DeepEqual(delivered, []string{"down", "drag", "up"}) {
		t.Fatalf("native drag with a failing step delivered %v, want down, drag and the release up", delivered)
	}
}

// periodicStep is the step of a native drag on the clock now of a check: it runs each, then waits one period after the step
// before it with nextStep, moving now by the wait.
func periodicStep(now *time.Duration, period time.Duration, each func()) func(time.Duration) (time.Duration, error) {
	return func(previous time.Duration) (time.Duration, error) {
		if each != nil {
			each()
		}
		*now = nextStep(previous, period, *now, func(wait time.Duration) { *now += wait })
		return *now, nil
	}
}

// contract: diagnostics.drag.native-delivers-pointer-gesture
func TestANativeDragStepFollowsTheStepBeforeItByOnePeriod(t *testing.T) {
	// The period runs from the step before, so a wait inside it is no longer than what is left of it, and a step whose time
	// passed is taken at once, from which the next period runs.
	var slept []time.Duration
	sleep := func(wait time.Duration) { slept = append(slept, wait) }
	if at := nextStep(100*time.Millisecond, 16*time.Millisecond, 105*time.Millisecond, sleep); at != 116*time.Millisecond ||
		!reflect.DeepEqual(slept, []time.Duration{11 * time.Millisecond}) {
		t.Fatalf("a step 5 ms into its period was taken at %v after the waits %v, want 116ms after one wait of 11ms", at, slept)
	}
	slept = nil
	if at := nextStep(100*time.Millisecond, 16*time.Millisecond, 120*time.Millisecond, sleep); at != 120*time.Millisecond || slept != nil {
		t.Fatalf("a step whose time passed was taken at %v after the waits %v, want 120ms without a wait", at, slept)
	}

	// Each input takes 5 ms to deliver. Every round trip is a press, two legs of 32 ms whose steps come 16 ms apart, the last
	// step of each leg delivered 5 ms after its time, and a release: 5 + 37 + 37 + 5 ms.
	var now time.Duration
	var stepped []time.Duration
	result, err := nativeDrag(dragPlan{Axis: "x", Line: 3, DX: 20, MS: 32, Times: 2}, point{X: 100, Y: 50}, func() time.Duration { return now },
		func(PointerInput) error {
			now += 5 * time.Millisecond
			return nil
		}, func(previous time.Duration) (time.Duration, error) {
			taken, err := periodicStep(&now, 16*time.Millisecond, nil)(previous)
			stepped = append(stepped, taken-previous)
			return taken, err
		}, func() error { return nil })
	if err != nil {
		t.Fatalf("native drag: %v", err)
	}
	for i, gap := range stepped {
		if gap != 16*time.Millisecond {
			t.Fatalf("step %d came %v after the step before it, want one period of 16ms; steps %v", i+1, gap, stepped)
		}
	}
	if result["steps"] != 8 {
		t.Fatalf("native drag steps %v, want 2 steps in each of the 4 legs", result["steps"])
	}
	if took, ok := result["took"].(int64); !ok || took != 168 {
		t.Fatalf("native drag took %#v ms, want 168 ms: the deliveries are inside the periods", result["took"])
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
		}, periodicStep(&now, 16*time.Millisecond, nil), func() error {
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
		}, periodicStep(&waitNow, 16*time.Millisecond, nil), func() error {
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

// A drag answers whatever happened to its recording: the recording is the log of the drag, so what failed of it is told in
// captureError, and the steps and the layout trace are in every result.
// contract: recording.drag.recording-failure-is-told
func TestARecordedDragTellsWhatFailedOfItsRecording(t *testing.T) {
	window := 7
	traced := []map[string]any{{"ticket": 1}}
	ticks := []float64{1, 2}
	cases := []struct {
		name     string
		recorded dragRecording
		want     map[string]any
	}{
		{"a drag without a recording", dragRecording{},
			map[string]any{"took": 100, "ticks": ticks, "layouts": traced}},
		{"a recording that did not start", dragRecording{failure: "the recording did not start: no window"},
			map[string]any{"took": 100, "ticks": ticks, "layouts": traced, "captureError": "the recording did not start: no window"}},
		{"a recording that started", dragRecording{frames: "/frames", window: &window},
			map[string]any{"took": 100, "ticks": ticks, "layouts": traced, "frames": "/frames", "window": 7}},
	}
	for _, c := range cases {
		got := recordedDragResult(map[string]any{"took": 100}, ticks, traced, c.recorded)
		if !reflect.DeepEqual(got, c.want) {
			t.Fatalf("%s: result %#v, want %#v", c.name, got, c.want)
		}
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
