// The reduced motion override of a window, which a diagnostic build sets in place of the platform value.

package host

// ReduceMotion returns the reduced motion override of the window, or nil when the platform value applies. The pages read it with the
// Motion call, and the mygo workbench reads it through the host.
func (s *Surfaces) ReduceMotion() *bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.reduceMotion
}

// MotionState is the value of the motion call and of the motion event: the reduced motion override, null for the platform value.
type MotionState struct {
	Reduce *bool `json:"reduce"`
}

// ReduceMotionOf returns the reduced motion override of a window of h, or nil when the window has none.
func ReduceMotionOf(h *Host, window Frontend) *bool {
	h.mu.Lock()
	s := h.windows[window.ID()]
	h.mu.Unlock()
	if s == nil {
		return nil
	}
	return s.ReduceMotion()
}

// SetReduceMotion records the reduced motion override of the window and publishes it to the open pages with the motion event, which
// carries {reduce}, true, false or null for the platform value.
func (s *Surfaces) SetReduceMotion(reduce *bool) {
	s.mu.Lock()
	s.reduceMotion = reduce
	s.mu.Unlock()
	s.Emit("motion", map[string]any{"reduce": reduce})
}
