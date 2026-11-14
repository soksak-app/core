//go:build !diagnostics

package host

// recordDocumentStep keeps no record: only a diagnostic build records the steps of the configuration of a document region.
func recordDocumentStep(step string) {}

// documentStepFault injects no failure: only a diagnostic build has the document fault injection point.
func documentStepFault(step string) error {
	return nil
}
