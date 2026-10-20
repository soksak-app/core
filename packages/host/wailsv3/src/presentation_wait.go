package host

import "fmt"

// presentationWait holds the views that wait for their presentation after a change of a card layout (docs/plans/plugin-processes.md,
// rule 6). Each view joins once per change, at its first display after the change, and the wait ends at the first of the presentation of
// the view, the end of its process, a change of which the view is not shown, and an unresponsive notice. It runs on the UI thread only.
type presentationWait struct {
	waiting map[string]bool
}

// presentationEnds are the reasons that end a wait. presented is the presentation of the view; the others end the wait without it.
var presentationEnds = map[string]bool{"presented": true, "process-ended": true, "hidden": true, "unresponsive": true}

// begin joins the view of surface to the wait. It reports false when the view already waits, so a view joins once per change.
func (w *presentationWait) begin(surface string) bool {
	if w.waiting == nil {
		w.waiting = map[string]bool{}
	}
	if w.waiting[surface] {
		return false
	}
	w.waiting[surface] = true
	return true
}

// end ends the wait of the view of surface with reason. It reports whether the wait ended without presentation, and then writes
// host.trace.view.presentation-abandoned; a view that does not wait has nothing to end. A reason that is not one of the ends is an error.
func (w *presentationWait) end(surface, reason string) (bool, error) {
	if !presentationEnds[reason] {
		return false, fmt.Errorf("presentation wait ends with %q, which is not an end", reason)
	}
	if !w.waiting[surface] {
		return false, nil
	}
	delete(w.waiting, surface)
	if reason == "presented" {
		return false, nil
	}
	EmitHost(LevelDebug, "host.trace.view.presentation-abandoned", map[string]any{"surface": surface, "reason": reason})
	return true, nil
}

// endPresentationWait ends the wait of the view of surface with reason and reports a failure of the end to the application log.
func (s *Surfaces) endPresentationWait(surface, reason string) {
	if _, err := s.presentation.end(surface, reason); err != nil {
		LogError("view channel", err)
	}
}
