package windows

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// params reads the JSON of a call as the protocol receives it.
func params(t *testing.T, call devToolsCall) map[string]any {
	t.Helper()
	var read map[string]any
	if err := json.Unmarshal([]byte(call.params), &read); err != nil {
		t.Fatal(err)
	}
	return read
}

func TestAPointerPhaseBecomesItsMouseEvent(t *testing.T) {
	for _, test := range []struct {
		name          string
		phase, button int
		open          [2]bool
		want          map[string]any
	}{
		{"move", phaseMove, 0, [2]bool{}, map[string]any{"type": "mouseMoved", "x": 10.5, "y": 20.0, "button": "none", "buttons": 0.0, "clickCount": 0.0}},
		{"press", phasePress, 0, [2]bool{}, map[string]any{"type": "mousePressed", "x": 10.5, "y": 20.0, "button": "left", "buttons": 1.0, "clickCount": 2.0}},
		{"right press", phasePress, 1, [2]bool{}, map[string]any{"type": "mousePressed", "x": 10.5, "y": 20.0, "button": "right", "buttons": 2.0, "clickCount": 2.0}},
		{"drag", phaseDrag, 0, [2]bool{true, false}, map[string]any{"type": "mouseMoved", "x": 10.5, "y": 20.0, "button": "left", "buttons": 1.0, "clickCount": 0.0}},
		{"release", phaseRelease, 0, [2]bool{true, false}, map[string]any{"type": "mouseReleased", "x": 10.5, "y": 20.0, "button": "left", "buttons": 0.0, "clickCount": 2.0}},
		{"release with another button held", phaseRelease, 0, [2]bool{true, true}, map[string]any{"type": "mouseReleased", "x": 10.5, "y": 20.0, "button": "left", "buttons": 2.0, "clickCount": 2.0}},
		{"move with a held button", phaseMove, 0, [2]bool{true, false}, map[string]any{"type": "mouseMoved", "x": 10.5, "y": 20.0, "button": "none", "buttons": 1.0, "clickCount": 0.0}},
		{"scroll", phaseScroll, 0, [2]bool{}, map[string]any{"type": "mouseWheel", "x": 10.5, "y": 20.0, "button": "none", "buttons": 0.0, "clickCount": 0.0, "deltaX": 3.0, "deltaY": -4.0}},
	} {
		t.Run(test.name, func(t *testing.T) {
			state := pressState{open: test.open}
			call, result := state.call(10.5, 20, test.phase, test.button, 3, -4, 2)
			if result != platform.PointerDelivered {
				t.Fatalf("result %v", result)
			}
			if call.method != "Input.dispatchMouseEvent" {
				t.Fatalf("method %s", call.method)
			}
			if got := params(t, call); !reflect.DeepEqual(got, test.want) {
				t.Fatalf("params %v, want %v", got, test.want)
			}
		})
	}
}

func TestAPointerThatBreaksThePressRulesIsNotSent(t *testing.T) {
	for _, test := range []struct {
		name                  string
		phase, button, clicks int
		open                  [2]bool
		want                  platform.PointerResult
	}{
		{"a second press of a button", phasePress, 0, 1, [2]bool{true, false}, platform.PointerPressOpen},
		{"a drag with no press", phaseDrag, 0, 0, [2]bool{}, platform.PointerRejected},
		{"a release with no press", phaseRelease, 0, 1, [2]bool{}, platform.PointerRejected},
		{"a click count of 0", phasePress, 0, 0, [2]bool{}, platform.PointerRejected},
		{"a click count of 4", phasePress, 0, 4, [2]bool{}, platform.PointerRejected},
		{"an unknown phase", 5, 0, 1, [2]bool{}, platform.PointerRejected},
		{"an unknown button", phasePress, 2, 1, [2]bool{}, platform.PointerRejected},
	} {
		t.Run(test.name, func(t *testing.T) {
			state := pressState{open: test.open}
			if _, result := state.call(1, 1, test.phase, test.button, 0, 0, test.clicks); result != test.want {
				t.Fatalf("result %v, want %v", result, test.want)
			}
		})
	}
}

// A delivered release ends an open press, and a press that did not arrive leaves none open.
func TestOnlyADeliveredPointerChangesThePress(t *testing.T) {
	var state pressState
	state.delivered(phasePress, 1)
	if state.open != [2]bool{false, true} {
		t.Fatalf("after a press %v", state.open)
	}
	state.delivered(phaseDrag, 1)
	if state.open != [2]bool{false, true} {
		t.Fatalf("after a drag %v", state.open)
	}
	state.delivered(phaseRelease, 1)
	if state.open != [2]bool{} {
		t.Fatalf("after a release %v", state.open)
	}
}

func TestAKeyBecomesItsKeyEvent(t *testing.T) {
	for _, test := range []struct {
		name      string
		key, text string
		modifiers uint
		down      bool
		want      map[string]any
	}{
		{"a letter", "a", "", 0, true, map[string]any{"type": "keyDown", "key": "a", "code": "KeyA", "windowsVirtualKeyCode": 65.0, "text": "a", "unmodifiedText": "a", "modifiers": 0.0}},
		{"a letter up", "a", "", 0, false, map[string]any{"type": "keyUp", "key": "a", "code": "KeyA", "windowsVirtualKeyCode": 65.0, "modifiers": 0.0}},
		{"a digit", "7", "", 0, true, map[string]any{"type": "keyDown", "key": "7", "code": "Digit7", "windowsVirtualKeyCode": 55.0, "text": "7", "unmodifiedText": "7", "modifiers": 0.0}},
		{"Enter types a return", "Enter", "", 0, true, map[string]any{"type": "keyDown", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13.0, "text": "\r", "unmodifiedText": "\r", "modifiers": 0.0}},
		{"Space types a space", "Space", "", 0, true, map[string]any{"type": "keyDown", "key": " ", "code": "Space", "windowsVirtualKeyCode": 32.0, "text": " ", "unmodifiedText": " ", "modifiers": 0.0}},
		{"an arrow types nothing", "ArrowLeft", "", 0, true, map[string]any{"type": "rawKeyDown", "key": "ArrowLeft", "code": "ArrowLeft", "windowsVirtualKeyCode": 37.0, "modifiers": 0.0}},
		{"Control types nothing", "c", "", 2, true, map[string]any{"type": "rawKeyDown", "key": "c", "code": "KeyC", "windowsVirtualKeyCode": 67.0, "modifiers": 2.0}},
		{"each modifier has its bit", "c", "", 1 | 2 | 4 | 8, true, map[string]any{"type": "rawKeyDown", "key": "c", "code": "KeyC", "windowsVirtualKeyCode": 67.0, "modifiers": 15.0}},
		{"Control and A select the page", "a", "", 2, true, map[string]any{"type": "rawKeyDown", "key": "a", "code": "KeyA", "windowsVirtualKeyCode": 65.0, "modifiers": 2.0}},
		{"Command and A go down as Meta", "a", "", 8, true, map[string]any{"type": "rawKeyDown", "key": "a", "code": "KeyA", "windowsVirtualKeyCode": 65.0, "modifiers": 4.0}},
		{"Shift keeps the text", "A", "", 1, true, map[string]any{"type": "keyDown", "key": "A", "code": "KeyA", "windowsVirtualKeyCode": 65.0, "text": "A", "unmodifiedText": "A", "modifiers": 8.0}},
		{"a given text is typed", "a", "한", 4, true, map[string]any{"type": "keyDown", "key": "a", "code": "KeyA", "windowsVirtualKeyCode": 65.0, "text": "한", "unmodifiedText": "한", "modifiers": 1.0}},
		{"a character without a key", "한", "", 0, true, map[string]any{"type": "keyDown", "key": "한", "text": "한", "unmodifiedText": "한", "modifiers": 0.0}},
	} {
		t.Run(test.name, func(t *testing.T) {
			call, result := keyCall(test.key, test.text, test.modifiers, test.down)
			if result != platform.PointerDelivered {
				t.Fatalf("result %v", result)
			}
			if call.method != "Input.dispatchKeyEvent" {
				t.Fatalf("method %s", call.method)
			}
			if got := params(t, call); !reflect.DeepEqual(got, test.want) {
				t.Fatalf("params %v, want %v", got, test.want)
			}
		})
	}
}

func TestAKeyThatIsNoNameAndNoCharacterIsNotSent(t *testing.T) {
	for _, key := range []string{"", "Enterr", "ab"} {
		if _, result := keyCall(key, "", 0, true); result != platform.PointerRejected {
			t.Fatalf("key %q: result %v", key, result)
		}
	}
}

// fakeProtocol holds the calls of a queue, which end when the test completes them, and the waits of a queue.
type fakeProtocol struct {
	calls     []devToolsCall
	completes []func(error)
	refuse    error
	timers    []func()
}

func (f *fakeProtocol) send(call devToolsCall, complete func(error)) error {
	if f.refuse != nil {
		return f.refuse
	}
	f.calls = append(f.calls, call)
	f.completes = append(f.completes, complete)
	return nil
}

func (f *fakeProtocol) after(_ time.Duration, task func()) func() {
	index := len(f.timers)
	f.timers = append(f.timers, task)
	return func() { f.timers[index] = nil }
}

func (f *fakeProtocol) methods() []string {
	methods := []string{}
	for _, call := range f.calls {
		methods = append(methods, call.method)
	}
	return methods
}

func newFakeQueue() (*inputQueue, *fakeProtocol) {
	f := &fakeProtocol{}
	return &inputQueue{send: f.send, after: f.after}, f
}

// The protocol may process calls out of order, so a call starts when the one before it completed.
func TestAQueueSendsOneCallAtATime(t *testing.T) {
	q, f := newFakeQueue()
	var ended []string
	for _, method := range []string{"a", "b"} {
		if err := q.push(devToolsCall{method: method}, time.Second, func(err error) {
			if err != nil {
				t.Error(err)
			}
			ended = append(ended, method)
		}); err != nil {
			t.Fatal(err)
		}
	}
	if want := []string{focusEmulation.method}; !reflect.DeepEqual(f.methods(), want) {
		t.Fatalf("calls %v, want %v", f.methods(), want)
	}
	f.completes[0](nil)
	if want := []string{focusEmulation.method, "a"}; !reflect.DeepEqual(f.methods(), want) {
		t.Fatalf("calls %v, want %v", f.methods(), want)
	}
	f.completes[1](nil)
	if want := []string{"a"}; !reflect.DeepEqual(ended, want) {
		t.Fatalf("ended %v, want %v", ended, want)
	}
	f.completes[2](nil)
	if want := []string{"a", "b"}; !reflect.DeepEqual(ended, want) {
		t.Fatalf("ended %v, want %v", ended, want)
	}
}

// A page shows :focus only while it counts as active, and a window behind others does not.
func TestAQueueEmulatesTheFocusBeforeItsFirstInputOnly(t *testing.T) {
	q, f := newFakeQueue()
	if err := q.push(devToolsCall{method: "a"}, time.Second, nil); err != nil {
		t.Fatal(err)
	}
	if got := params(t, f.calls[0]); !reflect.DeepEqual(got, map[string]any{"enabled": true}) {
		t.Fatalf("params %v", got)
	}
	f.completes[0](nil)
	f.completes[1](nil)
	if err := q.push(devToolsCall{method: "b"}, time.Second, nil); err != nil {
		t.Fatal(err)
	}
	if want := []string{focusEmulation.method, "a", "b"}; !reflect.DeepEqual(f.methods(), want) {
		t.Fatalf("calls %v, want %v", f.methods(), want)
	}
}

func TestACallThatFailsAnswersItsFailure(t *testing.T) {
	q, f := newFakeQueue()
	failure := errors.New("the protocol refused")
	var got error
	if err := q.push(devToolsCall{method: "a"}, time.Second, func(err error) { got = err }); err != nil {
		t.Fatal(err)
	}
	f.completes[0](nil)
	f.completes[1](failure)
	if !errors.Is(got, failure) {
		t.Fatalf("got %v", got)
	}
}

// A key answers before its call ends, so the next input reports the failure of that call.
func TestTheFailureOfACallWithNoAnswerGoesToTheNextInput(t *testing.T) {
	q, f := newFakeQueue()
	failure := errors.New("the protocol refused")
	if err := q.push(devToolsCall{method: "a"}, time.Second, nil); err != nil {
		t.Fatal(err)
	}
	f.completes[0](nil)
	f.completes[1](failure)
	if err := q.push(devToolsCall{method: "b"}, time.Second, nil); !errors.Is(err, failure) {
		t.Fatalf("got %v", err)
	}
	if err := q.push(devToolsCall{method: "c"}, time.Second, nil); err != nil {
		t.Fatalf("the failure was reported once, then %v", err)
	}
}

func TestACallThatCannotStartAnswersItsFailureAndTheNextOneRuns(t *testing.T) {
	q, f := newFakeQueue()
	q.focused = true
	failure := errors.New("no call")
	f.refuse = failure
	var got error
	if err := q.push(devToolsCall{method: "a"}, time.Second, func(err error) { got = err }); err != nil {
		t.Fatal(err)
	}
	if !errors.Is(got, failure) {
		t.Fatalf("got %v", got)
	}
	f.refuse = nil
	if err := q.push(devToolsCall{method: "b"}, time.Second, nil); err != nil {
		t.Fatal(err)
	}
	if want := []string{"b"}; !reflect.DeepEqual(f.methods(), want) {
		t.Fatalf("calls %v, want %v", f.methods(), want)
	}
}

// A call may never complete, so its wait ends, and a later input fails at once because the order of the calls is lost.
func TestACallThatDoesNotCompleteEndsItsWaitAndStopsTheQueue(t *testing.T) {
	q, f := newFakeQueue()
	q.focused = true
	var got []error
	if err := q.push(devToolsCall{method: "a"}, time.Second, func(err error) { got = append(got, err) }); err != nil {
		t.Fatal(err)
	}
	f.timers[0]()
	if len(got) != 1 || !errors.Is(got[0], errInputTimedOut) {
		t.Fatalf("got %v", got)
	}
	err := q.push(devToolsCall{method: "b"}, time.Second, nil)
	if err == nil || !strings.Contains(err.Error(), "did not complete") {
		t.Fatalf("the next input answered %v", err)
	}
	f.completes[0](nil)
	if len(got) != 1 {
		t.Fatalf("a late completion answered again: %v", got)
	}
	if err := q.push(devToolsCall{method: "c"}, time.Second, nil); err != nil {
		t.Fatalf("after the late completion %v", err)
	}
	if want := []string{"a", "c"}; !reflect.DeepEqual(f.methods(), want) {
		t.Fatalf("calls %v, want %v", f.methods(), want)
	}
}

func TestACompletedCallEndsItsWait(t *testing.T) {
	q, f := newFakeQueue()
	q.focused = true
	if err := q.push(devToolsCall{method: "a"}, time.Second, nil); err != nil {
		t.Fatal(err)
	}
	f.completes[0](nil)
	if f.timers[0] != nil {
		t.Fatal("the wait of a completed call goes on")
	}
}

func TestAnAnswerOfACallBecomesThePointerResult(t *testing.T) {
	for _, test := range []struct {
		err  error
		want platform.PointerResult
	}{
		{nil, platform.PointerDelivered},
		{errInputTimedOut, platform.PointerUnreceived},
		{errors.New("refused"), platform.PointerRejected},
	} {
		if got := pointerResult(test.err); got != test.want {
			t.Fatalf("%v gives %v, want %v", test.err, got, test.want)
		}
	}
}

// A hidden or minimized web view is reported never to complete a capture, so that state is the answer before the capture starts.
func TestACaptureOfAViewThatDoesNotDrawIsRefused(t *testing.T) {
	for _, test := range []struct {
		name                      string
		minimized, shown, visible bool
		want                      string
	}{
		{"a shown window", false, true, true, ""},
		{"a minimized window", true, true, true, "minimized"},
		{"a window that is not shown", false, false, true, "not shown"},
		{"a hidden web view", false, true, false, "hidden"},
	} {
		t.Run(test.name, func(t *testing.T) {
			err := captureRefusal(test.minimized, test.shown, test.visible)
			if test.want == "" {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("got %v, want %q", err, test.want)
			}
		})
	}
}

// A capture of a covered window may never complete. The wait names that state, and a late completion answers nothing.
func TestACaptureThatDoesNotCompleteEndsItsWait(t *testing.T) {
	f := &fakeProtocol{}
	var got []error
	finish := captureWait(f.after, time.Second, func(err error) { got = append(got, err) })
	f.timers[0]()
	if len(got) != 1 || got[0] == nil || !strings.Contains(got[0].Error(), "covered") {
		t.Fatalf("got %v", got)
	}
	finish(nil)
	if len(got) != 1 {
		t.Fatalf("a late completion answered again: %v", got)
	}
}

func TestACompletedCaptureAnswersOnce(t *testing.T) {
	f := &fakeProtocol{}
	var got []error
	finish := captureWait(f.after, time.Second, func(err error) { got = append(got, err) })
	finish(nil)
	if len(got) != 1 || got[0] != nil {
		t.Fatalf("got %v", got)
	}
	if f.timers[0] != nil {
		t.Fatal("the wait of a completed capture goes on")
	}
}

func TestAStillMustBeAnImage(t *testing.T) {
	if err := checkStill([]byte("\x89PNG\r\n\x1a\nrest")); err != nil {
		t.Fatal(err)
	}
	for _, data := range [][]byte{nil, []byte("not an image")} {
		if err := checkStill(data); err == nil {
			t.Fatalf("%q was accepted", data)
		}
	}
}
