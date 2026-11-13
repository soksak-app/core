//go:build !diagnostics

package host

// viewStepFault injects no failure: only a diagnostic build has the view fault injection point.
func viewStepFault(step string) error {
	return nil
}

// viewLoadFault refuses no load: only a diagnostic build has the view fault injection point.
func viewLoadFault() bool {
	return false
}
