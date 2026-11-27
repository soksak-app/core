// The reduced motion override of a window, which a diagnostic build sets in place of the platform value.

package host

// ReduceMotion returns the reduced motion override of the window, or nil when the platform value applies. The pages read it with the
// Motion call, and the mygo workbench reads it through the host.
func (s *Surfaces) ReduceMotion() *bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.reduceMotion
}

// SetReduceMotion records the reduced motion override of the window and publishes it to the open pages with the motion event, which
// carries {reduce}, true, false or null for the platform value.
func (s *Surfaces) SetReduceMotion(reduce *bool) {
	s.mu.Lock()
	s.reduceMotion = reduce
	s.mu.Unlock()
	s.Emit("motion", map[string]any{"reduce": reduce})
}
