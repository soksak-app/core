package workbench

import "fmt"

// The keyboard of the window follows the focus ring (docs/spec/exposure.md#keyboard-focus): while no modal is open, the active
// surface of the card with the ring holds the keyboard. Every move of the ring goes through focusCard, and the frame that shows
// the move sends the one host call surfaceFocus after the placement that holds the surface, so a surface that the host does not
// hold yet receives the keyboard when it stands.

// keyboardState is what the workbench last asked of the host about the keyboard.
type keyboardState struct {
	// owed tells that the keyboard has to move even when the target is the same: a path moved the ring, or the first responder
	// left the target.
	owed bool
	// target is the surface of the last call. It starts nil, because a window starts with the keyboard in its workbench.
	target *string
}

// focusCard moves the focus ring to card and owes the keyboard to its active surface.
func (s *Shell) focusCard(card string) {
	s.focused = card
	s.keyboard.owed = true
}

// keyboardTarget is the surface that holds the keyboard, and nil when the workbench holds it: while a modal is open, while the
// window shows the library, and for a card without a surface. It reads the seats of the frame that was drawn.
func (s *Shell) keyboardTarget() *string {
	if s.modalName() != nil || s.browsing || s.plane == nil || s.opened() == nil {
		return nil
	}
	data, err := s.cardData(s.focused)
	if err != nil || data == nil || data.ActiveTab() == nil {
		return nil
	}
	id := data.ActiveTab().ID
	if _, seated := s.surfaces.drawn[id]; !seated {
		return nil
	}
	return &id
}

// followKeyboard ends a frame: it sends the host call when the target changed or a path owes the keyboard. A placement that runs
// holds the call, because its end draws a frame.
func (s *Shell) followKeyboard() {
	if s.surfaces.running {
		return
	}
	target := s.keyboardTarget()
	same := (target == nil) == (s.keyboard.target == nil) && (target == nil || *target == *s.keyboard.target)
	if same && !s.keyboard.owed {
		return
	}
	s.keyboard = keyboardState{target: target}
	s.calls.CallInOrder(surfaceOrder, "surfaceFocus", map[string]any{"surface": target}, func(_ any, err error) {
		if err != nil {
			s.fail(fmt.Errorf("surface focus: %w", err))
		}
	})
}

// keyboardLeft follows a first responder that reached the workbench while a surface should hold the keyboard: a press on the
// workbench, or AppKit moving it from a view that it hides or closes.
func (s *Shell) keyboardLeft(responder Responder) {
	if responder.Owner == "workbench" && s.keyboardTarget() != nil {
		s.keyboard.owed = true
		s.options.Invalidate()
	}
}
