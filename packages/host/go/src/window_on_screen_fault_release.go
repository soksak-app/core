//go:build !diagnostics

package host

// windowOnScreenFault injects no failure: only a diagnostic build has the window state fault injection point.
func windowOnScreenFault() error {
	return nil
}
