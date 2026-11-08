package workbench

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/egoist/mygo/ui"
)

// The keyboard focus of the window, the value of the status core.focus (docs/spec/exposure.md#keyboard-focus). The first
// responder that the host reports selects the document: the workbench reads the element that the binder bound, a view surface
// the element that its view reported, and every other owner has no exposed focus.

// Responder is the first responder of the window, the window event window-responder.
type Responder struct {
	Owner    string  `json:"owner"`
	Surface  *string `json:"surface"`
	Document *string `json:"document"`
}

// FocusStatus is the value of the status core.focus.
type FocusStatus struct {
	Name    string  `json:"name"`
	Index   int     `json:"index"`
	Surface *string `json:"surface"`
}

// elementPlace is an element of the workbench: its name and its index among the elements of that name.
type elementPlace struct {
	name  string
	index int
}

// viewFocus is the value that a view reported with the view call tab.focus.
type viewFocus struct {
	Name  *string `json:"name"`
	Index *int    `json:"index"`
}

// Focus holds the keyboard focus of a window.
type Focus struct {
	declared *Declarations
	changed  func()
	window   *ui.Context
	// handles keeps the handle of each element between frames, and places lists the elements of the last frame in order.
	handles map[elementPlace]*ui.Handle
	places  []elementPlace
	// absent holds the places of the last frame whose elements the window does not show.
	absent map[elementPlace]bool
	// reveal is the place that the focus command focused, which the next frame brings into view.
	reveal *elementPlace
	// held holds the places whose elements have had the focus, each of which keeps its own selection.
	held      map[elementPlace]bool
	responder Responder
	views     map[string]*FocusStatus
	reported  *FocusStatus
	// transition writes the line of a focus transition of the workbench, and entered is the element that held the focus at the
	// last report.
	transition func(line string)
	entered    *elementPlace
}

// NewFocus makes the focus of a window. changed runs on each change of the status.
func NewFocus(declared *Declarations, changed func()) *Focus {
	return &Focus{declared: declared, changed: changed, handles: map[elementPlace]*ui.Handle{}, absent: map[elementPlace]bool{}, held: map[elementPlace]bool{}, responder: Responder{Owner: "workbench"},
		views: map[string]*FocusStatus{}}
}

// Register registers the status core.focus and the command core.focus.set.
func (f *Focus) Register(registry *Registry) {
	registry.Status("core.focus", func() any { return f.Status() })
	registry.Command("core.focus.set", func(params json.RawMessage) (any, error) {
		var target struct {
			Name  string `json:"name"`
			Index int    `json:"index"`
		}
		if err := json.Unmarshal(params, &target); err != nil {
			return nil, fmt.Errorf("core.focus.set: %w", err)
		}
		return nil, f.Set(target.Name, target.Index)
	})
}

// Frame starts a frame of the view of window. The view calls it before it binds an element; a focus that moved since the last
// frame reports its change here.
func (f *Focus) Frame(window *ui.Context) {
	f.report()
	f.window, f.places = window, f.places[:0]
	clear(f.absent)
}

// Bind gives element the identity of the next element of name and returns it.
func (f *Focus) Bind(element ui.Element, name string) ui.Element {
	place := f.next(name)
	handle := f.handles[place]
	if handle == nil {
		handle = &ui.Handle{}
		f.handles[place] = handle
	}
	f.places = append(f.places, place)
	if f.reveal != nil && *f.reveal == place {
		// A focus of a page brings its element into view, and selects the text of a field that has not had the focus.
		element.ScrollIntoView()
		if !f.held[place] {
			element.SelectAll()
		}
		f.reveal = nil
	}
	if element.Focused() {
		f.held[place] = true
	}
	return element.Bind(handle)
}

// Hold keeps the index of the next element of name for an element that the window does not show, which the focus does not reach.
func (f *Focus) Hold(name string) {
	place := f.next(name)
	f.absent[place] = true
	f.places = append(f.places, place)
}

// next returns the place of the next element of name.
func (f *Focus) next(name string) elementPlace {
	index := 0
	for _, place := range f.places {
		if place.name == name {
			index++
		}
	}
	return elementPlace{name, index}
}

// Set gives the keyboard focus to the element name at index, the command core.focus.set.
func (f *Focus) Set(name string, index int) error {
	if !f.declared.Elements[name] {
		return fmt.Errorf("unknown element %s", name)
	}
	place := elementPlace{name, index}
	for _, drawn := range f.places {
		if drawn == place {
			if !f.absent[place] {
				f.handles[place].Focus(f.window)
				f.reveal = &place
				// The frame that applies the focus reports it and reveals the element.
				f.changed()
			}
			return nil
		}
	}
	return fmt.Errorf("element %s has no element at index %d", name, index)
}

// SetResponder applies a window-responder event.
func (f *Focus) SetResponder(event Responder) error {
	valid := func(value *string) bool { return value == nil || *value != "" }
	if event.Owner == "" || !valid(event.Surface) || !valid(event.Document) {
		text, err := json.Marshal(event)
		if err != nil {
			return err
		}
		return errors.New("invalid window-responder event " + string(text))
	}
	f.responder = event
	f.report()
	return nil
}

// SetViewFocus records the value of the view call tab.focus of surface: {name, index} or null. Any other value is refused.
func (f *Focus) SetViewFocus(surface string, value json.RawMessage) error {
	refused := fmt.Errorf("view call tab.focus requires {name, index} or null, not %s", value)
	var report *viewFocus
	decoder := json.NewDecoder(bytes.NewReader(value))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&report); err != nil {
		return refused
	}
	if report == nil {
		f.views[surface] = nil
		f.report()
		return nil
	}
	if report.Name == nil || *report.Name == "" || report.Index == nil || *report.Index < 0 {
		return refused
	}
	f.views[surface] = &FocusStatus{Name: *report.Name, Index: *report.Index, Surface: &surface}
	f.report()
	return nil
}

// ForgetView forgets the focus of a view whose document ended or whose surface closed.
func (f *Focus) ForgetView(surface string) {
	delete(f.views, surface)
	f.report()
}

// Status is the value of the status core.focus.
func (f *Focus) Status() *FocusStatus {
	switch f.responder.Owner {
	case "workbench":
		if place := f.focusedPlace(); place != nil {
			return &FocusStatus{Name: place.name, Index: place.index}
		}
	case "surface":
		if f.responder.Surface != nil {
			return f.views[*f.responder.Surface]
		}
	}
	return nil
}

// OnTransition gives the focus the writer of the lines of its transitions: `focus out <name>` for the element of the workbench
// that loses the keyboard focus and `focus in <name>` for the element that takes it, as the main page writes each focusout and
// focusin of its document (core-exposure.js of packages/workbench).
func (f *Focus) OnTransition(write func(line string)) { f.transition = write }

// focusedPlace is the element of the workbench that holds the keyboard focus in the last frame, or nil.
func (f *Focus) focusedPlace() *elementPlace {
	for _, place := range f.places {
		if !f.absent[place] && f.handles[place].Focused(f.window) {
			return &place
		}
	}
	return nil
}

// writeTransition writes the transition from the element of the last report to the element that holds the focus now.
func (f *Focus) writeTransition() {
	now := f.focusedPlace()
	if now == nil && f.entered == nil || now != nil && f.entered != nil && *now == *f.entered {
		return
	}
	if f.transition != nil {
		if f.entered != nil {
			f.transition("focus out " + f.entered.name)
		}
		if now != nil {
			f.transition("focus in " + now.name)
		}
	}
	f.entered = now
}

// report runs changed when the status differs from the last one it reported.
func (f *Focus) report() {
	f.writeTransition()
	status := f.Status()
	if status == nil && f.reported == nil || status != nil && f.reported != nil && sameFocus(*status, *f.reported) {
		return
	}
	f.reported = status
	f.changed()
}

func sameFocus(a, b FocusStatus) bool {
	same := a.Surface == nil && b.Surface == nil || a.Surface != nil && b.Surface != nil && *a.Surface == *b.Surface
	return a.Name == b.Name && a.Index == b.Index && same
}
