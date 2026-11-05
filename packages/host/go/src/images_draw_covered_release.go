//go:build !diagnostics

package host

// drawsCoveredLocked is false: only a diagnostic build makes a covered window draw its regions.
func (i *Images) drawsCoveredLocked() bool {
	return false
}
