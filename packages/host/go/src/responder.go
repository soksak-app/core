package host

import (
	"reflect"
	"sync"

	"github.com/soksak-app/core/packages/host/go/src/routine"
)

// responderEvent is the window event window-responder: the web view that holds the first responder of the window, as
// host.window reports it (docs/spec/exposure.md#core-focus).
type responderEvent struct {
	Owner    string  `json:"owner"`
	Surface  *string `json:"surface"`
	Document *string `json:"document"`
}

// responderState holds the responder that the workbench of the window last received. mu also orders the reads and sends,
// so a later change is never sent before an earlier one.
type responderState struct {
	mu   sync.Mutex
	sent *responderEvent
}

// responderChanged sends the first responder to the workbench when it changed since the last send. A workbench that has
// not reported ready receives none; its ready sends the current responder. The native observation calls it on the UI thread,
// and the status is read in another goroutine.
func (s *Surfaces) responderChanged() {
	s.windowChanged()
	routine.Go("window-responder", func() { s.sendResponder(false) })
}

// responderWorkbenchReady sends the current first responder to the workbench that reported ready.
func (s *Surfaces) responderWorkbenchReady() {
	s.sendResponder(true)
}

func (s *Surfaces) sendResponder(force bool) {
	read := func() (*responderEvent, error) {
		state, err := s.windowState()
		if err != nil {
			return nil, err
		}
		return &responderEvent{Owner: state.Responder.Owner, Surface: state.Responder.Surface, Document: state.Responder.Document}, nil
	}
	workbenchReady := func() bool {
		s.host.mu.Lock()
		defer s.host.mu.Unlock()
		return s.ready
	}
	emit := func(event *responderEvent) { s.windowEvent("window-responder", event) }
	if err := s.responder.send(force, workbenchReady, read, emit, WindowClosed); err != nil {
		LogError("window responder", err)
	}
}

// send reads the first responder and emits it when it differs from the last emitted one. force is the ready of a workbench,
// which has received none: it emits the current responder. Without force, a workbench that is not ready receives nothing,
// because its ready sends the current responder. A read that fails is no error when closed reports that the window closed,
// because the close removed the workbench.
func (r *responderState) send(force bool, workbenchReady func() bool, read func() (*responderEvent, error), emit func(*responderEvent), closed func(error) bool) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if force {
		r.sent = nil
	} else if !workbenchReady() {
		return nil
	}
	event, err := read()
	if err != nil {
		if closed(err) {
			// silent: the close removed the workbench of the window, so no workbench receives the responder.
			return nil
		}
		return err
	}
	if reflect.DeepEqual(event, r.sent) {
		return nil
	}
	r.sent = event
	emit(event)
	return nil
}
