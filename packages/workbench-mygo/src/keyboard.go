package workbench

import "fmt"

// The keyboard of the window follows the focus ring (docs/spec/exposure.md#keyboard-focus): while no modal is open, the active
// surface of the card with the ring holds the keyboard. Every move of the ring goes through focusCard, and the frame that shows
// the move sends the one host call surfaceFocus. The host holds the input of the window from the release of a press on the
// workbench until a call that carries decided, so each release owes one decided call, sent by the frame that shows what the
// press changed, also for the same target or for the workbench. A surface that an earlier placement gave the host receives the call ahead of the
// placement of the frame, so the host gives it the keyboard at the release of the press that moved the ring, before a key that
// follows the release; a surface that the host does not hold yet receives the call after the placement that holds it, when it
// stands.

// keyboardState is what the workbench last asked of the host about the keyboard.
type keyboardState struct {
	// owed tells that the keyboard has to move even when the target is the same: a path moved the ring, or the first responder
	// left the target.
	owed bool
	// decided tells that a press released on the workbench waits for the call, which carries decided and ends the hold of the
	// input of the window.
	decided bool
	// target is the surface of the last call. It starts nil, because a window starts with the keyboard in its workbench.
	target *string
}

// keyboardPressed follows the release of a left press on the workbench: the host holds the input of the window until the
// decided call of the frame that shows what the press changed.
func (s *Shell) keyboardPressed() {
	s.keyboard.owed = true
	s.keyboard.decided = true
	s.options.Invalidate()
}

// focusCard moves the focus ring to card and owes the keyboard to its active surface.
func (s *Shell) focusCard(card string) {
	s.focused = card
	s.keyboard.owed = true
}

// keyboardTarget is the surface that holds the keyboard, and nil when the workbench holds it: while a modal is open, while the
// window shows the library, while a rename field is open, and for a card without a surface. It reads the seats of the frame that
// was drawn.
func (s *Shell) keyboardTarget() *string {
	if s.modalName() != nil || s.browsing || s.renaming != nil || s.plane == nil || s.opened() == nil {
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

// followKeyboard ends a frame: it sends the host call when the target changed or a path owes the keyboard. Ahead of the placement
// of the frame it sends only a call for a surface that a finished placement held, whose view the host already holds.
// After the placement a placement that runs holds the call, because its end draws a frame.
func (s *Shell) followKeyboard(ahead bool) {
	target := s.keyboardTarget()
	if ahead {
		if target == nil || s.surfaces.held[*target] == nil || !s.surfaces.held[*target].hosted {
			return
		}
	} else if s.surfaces.running {
		return
	}
	same := (target == nil) == (s.keyboard.target == nil) && (target == nil || *target == *s.keyboard.target)
	if same && !s.keyboard.owed {
		return
	}
	request := map[string]any{"surface": target}
	if s.keyboard.decided {
		request["decided"] = true
	}
	s.keyboard = keyboardState{target: target}
	s.calls.CallInOrder(surfaceOrder, "surfaceFocus", request, func(_ any, err error) {
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
