package workbench

import "github.com/egoist/mygo/ui"

// The last pointer sequence of the workbench, the value of the status core.pointer. The binder gives each element that takes a
// press its Handler, and reports the click that the element reports: a press on an element that the view replaced before the
// release ends without a click, and the record tells it so.

// PointerStatus is the value of the status core.pointer. A press increments Sequence and the other members start anew.
type PointerStatus struct {
	Sequence         int     `json:"sequence"`
	Down             *string `json:"down"`
	Up               *string `json:"up"`
	PressedConnected *bool   `json:"pressedConnected"`
	Click            *string `json:"click"`
}

// PointerSequence holds the last pointer sequence of a window.
type PointerSequence struct {
	changed func()
	status  PointerStatus
	frame   uint64
	// drawn is the frame that last drew each named element.
	drawn map[string]uint64
}

// NewPointerSequence makes the sequence of a window. changed runs on each change of its status.
func NewPointerSequence(changed func()) *PointerSequence {
	return &PointerSequence{changed: changed, drawn: map[string]uint64{}}
}

// Frame starts a frame of the view. The view calls it before it draws an element, so that Handler tells the elements of this
// frame from the elements of the frame before.
func (p *PointerSequence) Frame() { p.frame++ }

// Handler is the input handler of the element name of this frame. It takes the press of the element, and so its release.
func (p *PointerSequence) Handler(name string) func(ui.InputEvent) bool {
	p.drawn[name] = p.frame
	return func(ev ui.InputEvent) bool {
		switch ev.Kind {
		case ui.InputPointerDown:
			p.down(name)
			return true
		case ui.InputPointerUp:
			p.up(name)
			return true
		}
		return false
	}
}

func (p *PointerSequence) down(name string) {
	p.status = PointerStatus{Sequence: p.status.Sequence + 1, Down: &name}
	p.changed()
}

func (p *PointerSequence) up(name string) {
	connected := p.drawn[name] == p.frame
	p.status.Up, p.status.PressedConnected = &name, &connected
	p.changed()
}

// Click records the click that the element name reported.
func (p *PointerSequence) Click(name string) {
	p.status.Click = &name
	p.changed()
}

// Status is the value of the status core.pointer.
func (p *PointerSequence) Status() PointerStatus { return p.status }
