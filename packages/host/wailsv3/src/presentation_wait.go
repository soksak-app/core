package host

import (
	"fmt"
	"unsafe"
)

// presentationWait holds the views that wait for their presentation after a change of a card layout (docs/plans/plugin-processes.md,
// rule 6). Each view joins once per change, at its first display after the change, and the wait ends at the first of the presentation of
// the view, the end of its process, a change of which the view is not shown, and an unresponsive notice. It runs on the UI thread only.
type presentationWait struct {
	// waiting maps each waiting view to the function that ends its native join without presentation. It is nil when the view
	// waits without a native join.
	waiting map[string]func() error
}

// presentationEnds are the reasons that end a wait. presented is the presentation of the view; the others end the wait without it.
var presentationEnds = map[string]bool{"presented": true, "process-ended": true, "hidden": true, "unresponsive": true}

// begin joins the view of surface to the wait, with abandon as the function that ends its native join. It reports false when the view
// already waits, so a view joins once per change.
func (w *presentationWait) begin(surface string, abandon func() error) bool {
	if w.waiting == nil {
		w.waiting = map[string]func() error{}
	}
	if w.waiting[surface] != nil || w.waits(surface) {
		return false
	}
	w.waiting[surface] = abandon
	return true
}

// waits reports whether the view of surface waits for its presentation.
func (w *presentationWait) waits(surface string) bool {
	_, ok := w.waiting[surface]
	return ok
}

// joinShownViews joins each shown view of placements that waits for no presentation yet to the open transaction of window. A view
// that has no view document is skipped: its document is created by its sync, so it has no presentation to wait for.
func (s *Surfaces) joinShownViews(window unsafe.Pointer, ticket uint64, placements []Placement) error {
	for _, p := range placements {
		if !p.Visible || s.presentation.waits(p.ID) || s.viewRecords().specs[p.ID] == nil {
			continue
		}
		view, err := s.documents.Get(DocumentKey{Surface: p.ID, Name: viewRegionName})
		if err != nil {
			continue
		}
		surface := p.ID
		abandon, joined, err := system.JoinView(window, ticket, view, func() {
			if err := system.EnqueueUI(func() { s.endPresentationWait(surface, "presented") }); err != nil {
				LogError("view channel", err)
			}
		})
		if err != nil {
			return fmt.Errorf("joining view %s to the layout transaction: %w", surface, err)
		}
		if !joined {
			continue
		}
		if !s.presentation.begin(surface, abandon) {
			return fmt.Errorf("view %s joined the layout transaction while it already waits", surface)
		}
	}
	return nil
}

// end ends the wait of the view of surface with reason. It reports whether the wait ended without presentation, and then writes
// host.trace.view.presentation-abandoned; a view that does not wait has nothing to end. A reason that is not one of the ends is an error.
func (w *presentationWait) end(surface, reason string) (bool, error) {
	if !presentationEnds[reason] {
		return false, fmt.Errorf("presentation wait ends with %q, which is not an end", reason)
	}
	abandon, waiting := w.waiting[surface]
	if !waiting {
		return false, nil
	}
	delete(w.waiting, surface)
	if reason == "presented" {
		return false, nil
	}
	EmitHost(LevelDebug, "host.trace.view.presentation-abandoned", map[string]any{"surface": surface, "reason": reason})
	if abandon != nil {
		if err := abandon(); err != nil {
			return true, fmt.Errorf("ending the native join of view %s: %w", surface, err)
		}
	}
	return true, nil
}

// endPresentationWait ends the wait of the view of surface with reason and reports a failure of the end to the application log.
// An end without presentation sends the view-presentation-abandoned notice to the surface, which counts it in losses.abandoned.
func (s *Surfaces) endPresentationWait(surface, reason string) {
	abandoned, err := s.presentation.end(surface, reason)
	if err != nil {
		LogError("view channel", err)
	}
	if abandoned {
		s.emitToSurface(surface, "view-presentation-abandoned", map[string]any{"surface": surface, "reason": reason})
	}
}
