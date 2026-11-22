package host

import (
	"fmt"
	"time"
)

// ViewReloadRequest names the tab whose view restarts.
type ViewReloadRequest struct {
	Surface string `json:"surface"`
}

// ReloadView restarts the view of the tab surface: the host ends the current view, clears its restart stop, and creates the view again
// from its record (core.tab.reload, docs/spec/native-surfaces.md#view-surfaces). A reload counts no failure. It runs on the UI thread.
func (s *Surfaces) ReloadView(surface string) error {
	if s.window == nil {
		return errNoWindow
	}
	done := make(chan error, 1)
	if err := system.EnqueueUI(func() {
		spec, err := s.reloadView(surface, time.Now(), viewClosers{document: system.CloseDocument, image: system.CloseImage})
		if err == nil && spec != nil {
			err = s.syncView(surface, spec.native, spec.plugin, spec.page, spec.visible, spec.start)
		}
		done <- err
	}); err != nil {
		return err
	}
	return <-done
}

// reloadView ends the view of surface at the instant now without a failure, clears its restart stop, and returns the record from which
// the view is created again. A surface without a view record is refused with its id. It runs on the UI thread.
func (s *Surfaces) reloadView(surface string, now time.Time, closers viewClosers) (*viewSpec, error) {
	lifecycle := s.viewRecords()
	if lifecycle.specs[surface] == nil {
		return nil, fmt.Errorf("tab %s: no view to reload", surface)
	}
	lifecycle.reset(surface)
	channel, ok := s.documents.view(surface)
	if !ok {
		spec := lifecycle.specs[surface]
		return spec, nil
	}
	restart, ended := s.endViewWith(surface, channel.handle, channel.generation, now, closers, "view-reloaded", false)
	if !ended {
		return nil, fmt.Errorf("tab %s: the view changed while it was reloaded", surface)
	}
	return restart, nil
}
