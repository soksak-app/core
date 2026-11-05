package windows

import (
	"errors"
	"sync"
	"sync/atomic"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// mouseButton is one button of a raw mouse input: its flags in RAWMOUSE.usButtonFlags, its bit in the mask of
// host.buttons, and its virtual key.
type mouseButton struct {
	down, up uint16
	bit      uint64
	key      int
}

var mouseButtons = [...]mouseButton{
	{down: 0x0001, up: 0x0002, bit: 1 << 0, key: 0x01}, // left
	{down: 0x0004, up: 0x0008, bit: 1 << 1, key: 0x02}, // right
	{down: 0x0010, up: 0x0020, bit: 1 << 2, key: 0x04}, // middle
	{down: 0x0040, up: 0x0080, bit: 1 << 3, key: 0x05}, // fourth
	{down: 0x0100, up: 0x0200, bit: 1 << 4, key: 0x06}, // fifth
}

// mouseButtonsHeld reads the mask of the held buttons from the state of their virtual keys.
func mouseButtonsHeld(held func(key int) bool) uint64 {
	var mask uint64
	for _, button := range mouseButtons {
		if held(button.key) {
			mask |= button.bit
		}
	}
	return mask
}

// nextMouseButtons applies the flags of one input to a mask. It returns whether the flags name a button at all, because
// the other flags are the wheels. An input that names both changes of a button ended with that button released.
func nextMouseButtons(mask uint64, flags uint16) (uint64, bool) {
	named := false
	for _, button := range mouseButtons {
		if flags&button.down != 0 {
			mask |= button.bit
			named = true
		}
		if flags&button.up != 0 {
			mask &^= button.bit
			named = true
		}
	}
	return mask, named
}

// primaryChange reads the press and the release of the primary button, the one that the system maps to the left button
// of a page. A raw input names the physical button, and the system setting exchanges the two.
func primaryChange(flags uint16, swapped bool) (down, up bool) {
	button := mouseButtons[0]
	if swapped {
		button = mouseButtons[1]
	}
	return flags&button.down != 0, flags&button.up != 0
}

// mouseSystem is what the source reads of the system at an input.
type mouseSystem interface {
	// swapped tells whether the system exchanges the primary and the secondary button.
	swapped() bool
	// hit reads the top window under the pointer and its views from the hit view upward. The window is not one of
	// them, and it is 0 when no window is there.
	hit() (window uintptr, views []uintptr, err error)
	// position reads the pointer in the page coordinates of the window.
	position(window uintptr) (x, y float64, err error)
}

// inputWatch delivers the input of one window. Its functions run on the UI thread, except that the source reads dragging
// to keep the moves of a drag that the page handles away from that thread.
type inputWatch struct {
	window   uintptr
	input    platform.Input
	dragging atomic.Bool
	ended    bool
}

func (w *inputWatch) press(views []uintptr, x, y float64) {
	if w.ended {
		return
	}
	dragging := false
	for _, view := range views {
		if w.input.Press(view) {
			dragging = true
			break
		}
	}
	w.dragging.Store(dragging)
	if dragging {
		w.input.Point(0, x, y)
	}
}

func (w *inputWatch) move(x, y float64) {
	if w.dragging.Load() {
		w.input.Point(1, x, y)
	}
}

func (w *inputWatch) release(x, y float64) {
	if w.dragging.Swap(false) {
		w.input.Point(2, x, y)
	}
}

func (w *inputWatch) end() {
	w.ended = true
	w.dragging.Store(false)
}

// mouseSource turns the raw mouse inputs of the system into the reports of host.buttons and the steps of the watched
// windows. receive runs on its own thread, so the reading of a hit, which may wait for another process, never holds
// the UI thread, and a move that nothing watches never wakes it. Every report and step reaches the UI thread through
// post, in the order of the inputs.
type mouseSource struct {
	system mouseSystem
	post   func(task func())
	report func(err error)

	mu      sync.Mutex
	mask    uint64
	changed func(mask uint64)
	watches map[uintptr]*inputWatch
	last    uintptr

	// pressed is the watch of the window that received the open press, and lastX and lastY where the pointer was
	// when the source last sent it a step. Only receive uses them.
	pressed      *inputWatch
	lastX, lastY float64
}

// receive handles the button flags of one raw mouse input. An input without a button is a move or a wheel.
func (s *mouseSource) receive(flags uint16) {
	s.reportButtons(flags)
	down, up := false, false
	if flags != 0 {
		down, up = primaryChange(flags, s.system.swapped())
	}
	if down {
		s.pressStep()
	}
	if up {
		s.releaseStep()
	}
	if !down && !up {
		s.moveStep()
	}
}

func (s *mouseSource) reportButtons(flags uint16) {
	s.mu.Lock()
	defer s.mu.Unlock()
	mask, named := nextMouseButtons(s.mask, flags)
	if !named {
		return
	}
	s.mask = mask
	if changed := s.changed; changed != nil {
		s.post(func() { changed(mask) })
	}
}

func (s *mouseSource) pressStep() {
	s.pressed = nil
	window, views, err := s.system.hit()
	if err != nil {
		s.report(err)
		return
	}
	watch := s.watchOf(window)
	if watch == nil {
		return
	}
	x, y, err := s.system.position(window)
	if err != nil {
		s.report(err)
		return
	}
	s.pressed, s.lastX, s.lastY = watch, x, y
	s.post(func() { watch.press(views, x, y) })
}

func (s *mouseSource) releaseStep() {
	watch := s.pressed
	if watch == nil {
		return
	}
	s.pressed = nil
	x, y, err := s.system.position(watch.window)
	if err != nil {
		// The release still ends the drag that the page holds, at the last place that the pointer was read.
		s.report(err)
		x, y = s.lastX, s.lastY
	}
	s.post(func() { watch.release(x, y) })
}

func (s *mouseSource) moveStep() {
	watch := s.pressed
	if watch == nil || !watch.dragging.Load() {
		return
	}
	x, y, err := s.system.position(watch.window)
	if err != nil {
		s.report(err)
		return
	}
	if x == s.lastX && y == s.lastY {
		return
	}
	s.lastX, s.lastY = x, y
	s.post(func() { watch.move(x, y) })
}

func (s *mouseSource) watchOf(window uintptr) *inputWatch {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, watch := range s.watches {
		if watch.window == window {
			return watch
		}
	}
	return nil
}

// setChanged starts the reports of the mask and gives the current mask to changed. Call it on the UI thread: a report
// of a later input runs as a later step of that thread.
func (s *mouseSource) setChanged(changed func(mask uint64)) error {
	s.mu.Lock()
	if s.changed != nil {
		s.mu.Unlock()
		return errors.New("the mouse buttons are already watched")
	}
	s.changed = changed
	mask := s.mask
	s.mu.Unlock()
	changed(mask)
	return nil
}

// watch starts to deliver the input of a window and returns the number of the watch. Call it on the UI thread.
func (s *mouseSource) watch(window uintptr, input platform.Input) uintptr {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.watches == nil {
		s.watches = map[uintptr]*inputWatch{}
	}
	s.last++
	s.watches[s.last] = &inputWatch{window: window, input: input}
	return s.last
}

// unwatch ends a watch. A step that the source already sent to it does nothing. Call it on the UI thread.
func (s *mouseSource) unwatch(monitor uintptr) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if watch, ok := s.watches[monitor]; ok {
		watch.end()
		delete(s.watches, monitor)
	}
}
