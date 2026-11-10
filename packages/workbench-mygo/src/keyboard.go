package workbench

import "fmt"

// The keyboard of the window follows the focus ring (docs/spec/exposure.md#keyboard-focus): while no modal is open, the active
// surface of the card with the ring holds the keyboard. Every move of the ring goes through focusCard, and the frame that shows
// the move sends the one host call surfaceFocus. The host holds the input of the window from the release of a press on the
// workbench until a call that carries decided, so each release owes one decided call, sent by the frame that shows what the
// press changed, also for the same target or for the workbench. A surface that an earlier placement gave the host receives the call ahead of the
// placement of the frame, so the host gives it the keyboard at the release of the press that moved the ring, before a key that
// follows the release; a surface that the host does not hold yet receives the call after the placement that holds it, when it
// stands. A command that moved the ring answers after the host answered the keyboard call that the move owes, so a key that the
// caller sends after the answer reaches the surface (docs/spec/exposure.md#the-keyboard-follows-the-focus-ring).

// keyboardState is what the workbench last asked of the host about the keyboard.
type keyboardState struct {
	// owed tells that the keyboard has to move even when the target is the same: a path moved the ring, or the first responder
	// left the target.
	owed bool
	// due tells that a press released on the workbench waits for the call, which carries decided and ends the hold of the
	// input of the window.
	due bool
	// target is the surface of the last call. It starts nil, because a window starts with the keyboard in its workbench.
	target *string
	// decided holds the answers that wait for the keyboard decision that follows their placement, and answered those that
	// wait for the keyboard calls that run. sending counts those calls.
	decided, answered []func(err error)
	sending           int
}

// keyboardPressed follows the release of a left press on the workbench: the host holds the input of the window until the
// decided call of the frame that shows what the press changed.
func (s *Shell) keyboardPressed() {
	s.keyboard.owed = true
	s.keyboard.due = true
	s.options.Invalidate()
}

// focusCard moves the focus ring to card and owes the keyboard to its active surface. The frame that it asks for shows the move.
func (s *Shell) focusCard(card string) {
	s.focused = card
	s.keyboard.owed = true
	s.options.Invalidate()
}

// followCommand holds the answer of a command whose run asked for a frame until the placement of that frame ran and the host
// answered the keyboard call that follows it, so a request after the answer finds what the frame shows; a move of the ring is
// one such change. A run that asked for no frame, or that failed, answers at once. A placement or a keyboard call that fails has
// shown its failure in its own line, and the command answers with the result of its run (docs/spec/exposure.md#registration). A run
// that wrote settings first waits until the host wrote them (afterSettingsWrites).
func (s *Shell) followCommand(answer func(value any, err error)) func(value any, err error) {
	requests, writes := s.frameRequests.Load(), s.settingsIssued
	s.answering++
	answered := func(value any, err error) {
		answer(value, err)
		s.answering--
		if s.answering == 0 {
			waiting := s.afterAnswering
			s.afterAnswering = nil
			for _, run := range waiting {
				run()
			}
		}
	}
	return func(value any, err error) {
		s.afterSettingsWrites(writes, func(failure error) {
			if err == nil && failure != nil {
				value, err = nil, failure
			}
			if err != nil || s.frameRequests.Load() == requests {
				answered(value, err)
				return
			}
			// The answer follows the statuses of that frame, so a request after it reads what the frame showed.
			s.afterPlacement(func(error) { s.afterStatuses(func() { answered(value, nil) }) })
		})
	}
}

// afterAnswers runs run once every command that runs has answered, at once when none runs: a step that ends the document of the window,
// as its close, comes after the answers that the document still owes (followCommand).
func (s *Shell) afterAnswers(run func()) {
	if s.answering == 0 {
		run()
		return
	}
	s.afterAnswering = append(s.afterAnswering, run)
}

// afterKeyboard gives answers of a placement that ended to the keyboard decision that follows it.
func (s *Shell) afterKeyboard(answers []func(err error)) {
	s.keyboard.decided = append(s.keyboard.decided, answers...)
}

// answerKeyboard answers what waits for the keyboard calls once none runs.
func (s *Shell) answerKeyboard(err error) {
	if s.keyboard.sending > 0 {
		return
	}
	answered := s.keyboard.answered
	s.keyboard.answered = nil
	s.answerCommits(answered, err)
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
	hosted := target != nil && s.surfaces.held[*target] != nil && s.surfaces.held[*target].hosted
	if ahead {
		if !hosted {
			return
		}
	} else if s.surfaces.running {
		return
	} else if !hosted {
		// A surface that a frame drew after the last placement started is not held by the host yet: the workbench holds the
		// keyboard until the placement that holds the surface ends and calls again.
		target = nil
	}
	if !ahead {
		s.keyboard.answered = append(s.keyboard.answered, s.keyboard.decided...)
		s.keyboard.decided = nil
	}
	same := (target == nil) == (s.keyboard.target == nil) && (target == nil || *target == *s.keyboard.target)
	if same && !s.keyboard.owed {
		s.answerKeyboard(nil)
		return
	}
	request := map[string]any{"surface": target}
	if s.keyboard.due {
		request["decided"] = true
	}
	s.keyboard.owed, s.keyboard.due, s.keyboard.target = false, false, target
	s.keyboard.sending++
	s.calls.CallInOrder(surfaceOrder, "surfaceFocus", request, func(_ any, err error) {
		s.keyboard.sending--
		if err != nil {
			err = fmt.Errorf("surface focus: %w", err)
			s.fail(err)
		}
		s.answerKeyboard(err)
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
