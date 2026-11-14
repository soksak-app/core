//go:build !diagnostics

package host

// stallSampleFault holds no sample: only a diagnostic build has the stall sample fault injection point.
func stallSampleFault() error {
	return nil
}
