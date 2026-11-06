//go:build diagnostics

package host

// SetDrawCovered makes the regions of the window draw while the window is occluded or minimized, for a check that reads
// the pixels of a covered window (docs/spec/native-surfaces.md#image-regions). The window keeps reporting its occlusion.
func (i *Images) SetDrawCovered(draw bool) {
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.drawCovered != draw {
		i.drawCovered = draw
		i.changedLocked()
	}
}

// drawsCoveredLocked reports whether the regions of the window draw while it is not on screen. Call it while holding i.mu.
func (i *Images) drawsCoveredLocked() bool {
	return i.drawCovered
}
