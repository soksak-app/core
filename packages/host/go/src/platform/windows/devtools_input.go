package windows

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// The pointer phases of platform.Platform.InjectPointer.
const (
	phaseMove = iota
	phasePress
	phaseDrag
	phaseRelease
	phaseScroll
)

// maxClicks is the largest click count of a press and a release, as on the other platforms.
const maxClicks = 3

// devToolsCall is one call of the DevTools protocol, with its parameters as JSON.
type devToolsCall struct {
	method, params string
}

// newCall builds the call of method. The parameters are maps of plain values, so they always encode.
func newCall(method string, params map[string]any) devToolsCall {
	text, err := json.Marshal(params)
	if err != nil {
		panic(err)
	}
	return devToolsCall{method, string(text)}
}

// pressState is the open press of each button of a window and the pointer that holds them. A page has one mouse pointer, so a
// window holds one press of each button, all of one pointer.
type pressState struct {
	open [2]bool
	// holder is the pointer of the open presses; it is empty while no press is open.
	holder string
}

// pointerHeldReason is the reason of a PointerHeld rejection: the page has one mouse pointer, which the presses of holder take.
const pointerHeldReason = "the page has one mouse pointer"

// buttons is the protocol's mask of the open presses, with button changed to pressed.
func (s *pressState) buttons(button int, pressed bool) int {
	open := s.open
	if button >= 0 && button < len(open) {
		open[button] = pressed
	}
	mask := 0
	if open[0] {
		mask |= 1
	}
	if open[1] {
		mask |= 2
	}
	return mask
}

// call returns the call that delivers a pointer input of pointer, or the result of an input that is not sent. x and y are CSS pixels of
// the web view at the content area of the window. It keeps the press rules of the other platforms: a button has one press, and a drag and
// a release need it. While another pointer holds a press, a move, a press, a drag and a release are PointerHeld, and a scroll is sent.
func (s *pressState) call(pointer string, x, y float64, phase, button int, deltaX, deltaY float64, clicks int) (devToolsCall, platform.PointerResult) {
	if button != 0 && button != 1 {
		return devToolsCall{}, platform.PointerRejected
	}
	if s.holder != "" && s.holder != pointer && phase != phaseScroll {
		return devToolsCall{}, platform.PointerHeld
	}
	name := "left"
	if button == 1 {
		name = "right"
	}
	event := map[string]any{"x": x, "y": y, "button": "none", "clickCount": 0}
	switch phase {
	case phaseMove:
		event["type"] = "mouseMoved"
		event["buttons"] = s.buttons(-1, false)
	case phaseScroll:
		event["type"], event["deltaX"], event["deltaY"] = "mouseWheel", deltaX, deltaY
		event["buttons"] = s.buttons(-1, false)
	case phasePress:
		if s.open[button] {
			return devToolsCall{}, platform.PointerPressOpen
		}
		if clicks < 1 || clicks > maxClicks {
			return devToolsCall{}, platform.PointerRejected
		}
		event["type"], event["button"], event["clickCount"] = "mousePressed", name, clicks
		event["buttons"] = s.buttons(button, true)
	case phaseDrag:
		if !s.open[button] {
			return devToolsCall{}, platform.PointerRejected
		}
		event["type"], event["button"] = "mouseMoved", name
		event["buttons"] = s.buttons(-1, false)
	case phaseRelease:
		if !s.open[button] || clicks < 1 || clicks > maxClicks {
			return devToolsCall{}, platform.PointerRejected
		}
		event["type"], event["button"], event["clickCount"] = "mouseReleased", name, clicks
		event["buttons"] = s.buttons(button, false)
	default:
		return devToolsCall{}, platform.PointerRejected
	}
	return newCall("Input.dispatchMouseEvent", event), platform.PointerDelivered
}

// delivered records a pointer input of pointer that reached the page. An input that failed leaves the press as it was.
func (s *pressState) delivered(pointer string, phase, button int) {
	switch phase {
	case phasePress:
		s.open[button] = true
		s.holder = pointer
	case phaseRelease:
		s.open[button] = false
		if s.open == [2]bool{} {
			s.holder = ""
		}
	}
}

// namedKey is a key that the name of input.key gives.
type namedKey struct {
	key, code string
	virtual   int
	text      string
}

// namedKeys holds the key names of input.key (docs/spec/exposure.md).
var namedKeys = map[string]namedKey{
	"Enter":      {"Enter", "Enter", 0x0D, "\r"},
	"Tab":        {"Tab", "Tab", 0x09, "\t"},
	"Escape":     {"Escape", "Escape", 0x1B, ""},
	"Backspace":  {"Backspace", "Backspace", 0x08, ""},
	"Delete":     {"Delete", "Delete", 0x2E, ""},
	"Space":      {" ", "Space", 0x20, " "},
	"ArrowLeft":  {"ArrowLeft", "ArrowLeft", 0x25, ""},
	"ArrowUp":    {"ArrowUp", "ArrowUp", 0x26, ""},
	"ArrowRight": {"ArrowRight", "ArrowRight", 0x27, ""},
	"ArrowDown":  {"ArrowDown", "ArrowDown", 0x28, ""},
	"Home":       {"Home", "Home", 0x24, ""},
	"End":        {"End", "End", 0x23, ""},
	"PageUp":     {"PageUp", "PageUp", 0x21, ""},
	"PageDown":   {"PageDown", "PageDown", 0x22, ""},
}

// characterKey returns the key of one character. A letter and a digit have a physical key, and any other character has only its text.
func characterKey(character string) (namedKey, bool) {
	r, size := utf8.DecodeRuneInString(character)
	if character == "" || r == utf8.RuneError || size != len(character) {
		return namedKey{}, false
	}
	found := namedKey{key: character, text: character}
	switch upper := unicode.ToUpper(r); {
	case upper >= 'A' && upper <= 'Z':
		found.code, found.virtual = "Key"+string(upper), int(upper)
	case r >= '0' && r <= '9':
		found.code, found.virtual = "Digit"+string(r), int(r)
	}
	return found, true
}

// The modifiers of input.key.
const (
	modifierShift = 1 << iota
	modifierControl
	modifierOption
	modifierCommand
)

// protocolModifiers is the protocol's bit sum of the modifiers of input.key: Alt 1, Ctrl 2, Meta 4, Shift 8.
func protocolModifiers(modifiers uint) int {
	bits := 0
	if modifiers&modifierOption != 0 {
		bits |= 1
	}
	if modifiers&modifierControl != 0 {
		bits |= 2
	}
	if modifiers&modifierCommand != 0 {
		bits |= 4
	}
	if modifiers&modifierShift != 0 {
		bits |= 8
	}
	return bits
}

// keyCall returns the call that delivers a key input. A key types the given text, and without one its own characters unless Control,
// Option or Command holds it. A key that types nothing goes down as rawKeyDown, which inserts nothing.
func keyCall(name, text string, modifiers uint, down bool) (devToolsCall, platform.PointerResult) {
	found, ok := namedKeys[name]
	if !ok {
		if found, ok = characterKey(name); !ok {
			return devToolsCall{}, platform.PointerRejected
		}
	}
	event := map[string]any{"key": found.key, "modifiers": protocolModifiers(modifiers)}
	if found.code != "" {
		event["code"], event["windowsVirtualKeyCode"] = found.code, found.virtual
	}
	if !down {
		event["type"] = "keyUp"
		return newCall("Input.dispatchKeyEvent", event), platform.PointerDelivered
	}
	types := text
	if types == "" && modifiers&(modifierControl|modifierOption|modifierCommand) == 0 {
		types = found.text
	}
	event["type"] = "rawKeyDown"
	if types != "" {
		event["type"], event["text"], event["unmodifiedText"] = "keyDown", types, types
	}
	return newCall("Input.dispatchKeyEvent", event), platform.PointerDelivered
}

// focusEmulation makes a page count as active. Its :focus needs that, and a window behind others is not active.
var focusEmulation = newCall("Emulation.setFocusEmulationEnabled", map[string]any{"enabled": true})

// errInputTimedOut is the answer of a call that did not complete within its wait.
var errInputTimedOut = errors.New("the web view did not complete the input")

// queuedCall is a call of an inputQueue with its answer, which is nil for an input that answered when it was queued.
type queuedCall struct {
	call     devToolsCall
	wait     time.Duration
	answer   func(error)
	answered bool
}

// inputQueue sends the calls of one web view. The protocol may process calls out of order, so a call starts when the one before it
// completed. Use it on the UI thread: send completes there, and after runs its task there.
type inputQueue struct {
	// send starts a call, and complete runs when it ends. An error means that complete does not run.
	send func(call devToolsCall, complete func(error)) error
	// after runs task after a wait, unless the returned function cancels it.
	after func(wait time.Duration, task func()) (cancel func())

	waiting []*queuedCall
	current *queuedCall
	// failed is the failure of a call that has no answer, which the next input reports.
	failed error
	// focused is whether the focus emulation was asked for.
	focused bool
}

// push queues a call, and answer receives its end. The returned error is why the input was not queued: the failure of an earlier call
// with no answer, or a call that has not completed, after which the order of the calls is not known.
func (q *inputQueue) push(call devToolsCall, wait time.Duration, answer func(error)) error {
	if failed := q.failed; failed != nil {
		q.failed = nil
		return failed
	}
	if q.current != nil && q.current.answered {
		return fmt.Errorf("the input call %s before this one did not complete", q.current.call.method)
	}
	if !q.focused {
		q.focused = true
		q.waiting = append(q.waiting, &queuedCall{call: focusEmulation, wait: wait})
	}
	q.waiting = append(q.waiting, &queuedCall{call: call, wait: wait, answer: answer})
	q.next()
	return nil
}

// next starts the first waiting call, unless a call has not completed.
func (q *inputQueue) next() {
	for q.current == nil && len(q.waiting) > 0 {
		entry := q.waiting[0]
		q.waiting = q.waiting[1:]
		q.current = entry
		cancel := q.after(entry.wait, func() { q.timedOut(entry) })
		err := q.send(entry.call, func(err error) {
			cancel()
			q.completed(entry, err)
		})
		if err != nil {
			cancel()
			q.completed(entry, err)
		}
	}
}

// timedOut ends the wait of a call. Later calls wait for its completion, because they must not pass it.
func (q *inputQueue) timedOut(entry *queuedCall) {
	entry.answered = true
	if entry.answer != nil {
		entry.answer(errInputTimedOut)
	}
}

// completed ends a call and starts the next one. A call that timed out has answered.
func (q *inputQueue) completed(entry *queuedCall, err error) {
	q.current = nil
	switch {
	case entry.answered:
	case entry.answer != nil:
		entry.answered = true
		entry.answer(err)
	case err != nil:
		q.failed = fmt.Errorf("%s: %w", entry.call.method, err)
	}
	q.next()
}

// pointerResult is the result of a pointer input from the answer of its call.
func pointerResult(err error) platform.PointerResult {
	switch {
	case err == nil:
		return platform.PointerDelivered
	case errors.Is(err, errInputTimedOut):
		return platform.PointerUnreceived
	}
	return platform.PointerRejected
}

// captureRefusal is why a capture does not start. CapturePreview is reported to accept the call and never complete while the web view is
// hidden or its parent window is not shown, and a minimized window hides its web view, so these states are the answer at once.
func captureRefusal(minimized, shown, visible bool) error {
	switch {
	case minimized:
		return errors.New("capture: the window is minimized, and its web view does not draw")
	case !shown:
		return errors.New("capture: the window is not shown, and its web view does not draw")
	case !visible:
		return errors.New("capture: the web view is hidden, and it does not draw")
	}
	return nil
}

// captureWait is the wait for CapturePreview, whose behavior in a covered window no document states, so no limit ends it. It returns
// answer, which receives the completion, and end, which ends the wait with the reason of the end of its request. done runs once, on
// the thread of the first of them: with the completion, or with a failure that names the end and a covered window, and what comes
// later answers nothing.
func captureWait(done func([]byte, error)) (answer func([]byte, error), end func(reason string)) {
	var once sync.Once
	answer = func(data []byte, err error) { once.Do(func() { done(data, err) }) }
	end = func(reason string) {
		answer(nil, fmt.Errorf("capture: CapturePreview did not complete before %s, and the web view reports that it draws; the window may be covered", reason))
	}
	return answer, end
}

// captureEnds holds the end of each still capture that waits, by its token, and the reason of each end that came before its capture
// waited. The host gives each capture a new, larger token, so a capture that returns forgets the ends of its token and of every
// earlier one.
type captureEnds struct {
	mu      sync.Mutex
	waiting map[uint64]func(reason string)
	early   map[uint64]string
}

// wait keeps end as the end of the capture of token until the returned forget, and ends it at once with an end that came before.
func (c *captureEnds) wait(token uint64, end func(reason string)) (forget func()) {
	c.mu.Lock()
	reason, ended := c.early[token]
	if !ended {
		if c.waiting == nil {
			c.waiting = map[uint64]func(string){}
		}
		c.waiting[token] = end
	}
	c.mu.Unlock()
	if ended {
		end(reason)
	}
	return func() {
		c.mu.Lock()
		delete(c.waiting, token)
		for early := range c.early {
			if early <= token {
				delete(c.early, early)
			}
		}
		c.mu.Unlock()
	}
}

// end ends the capture of token with reason, or keeps reason for a capture of token that has not waited yet.
func (c *captureEnds) end(token uint64, reason string) {
	c.mu.Lock()
	end := c.waiting[token]
	delete(c.waiting, token)
	if end == nil {
		if c.early == nil {
			c.early = map[uint64]string{}
		}
		c.early[token] = reason
	}
	c.mu.Unlock()
	if end != nil {
		end(reason)
	}
}

// checkStill checks that CapturePreview wrote an image.
func checkStill(data []byte) error {
	if !bytes.HasPrefix(data, []byte("\x89PNG\r\n\x1a\n")) {
		return fmt.Errorf("capture: CapturePreview wrote %d bytes that are not a PNG image", len(data))
	}
	return nil
}
