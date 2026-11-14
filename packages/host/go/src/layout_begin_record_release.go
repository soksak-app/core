//go:build !diagnostics

package host

// recordLayoutBegin records nothing: only a diagnostic build records the layout begins of the preparations.
func recordLayoutBegin(ticket uint64) {}
