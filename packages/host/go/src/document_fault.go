//go:build diagnostics

// The fault injection point and the step record of the configuration of a document region. They are compiled only with the diagnostics
// build tag; the release build has the no-op counterpart in document_fault_release.go.

package host

import (
	"errors"
	"os"
	"sync"
)

// faultDocumentStep is the fault injection point of the configuration of a document region (configureSteps). Its value names the step
// that fails after the platform call of the step returns: restore, message, stream, "stream on" or event. The platform call runs first, so
// the platform records the call as the native platform does. docs/operations/examples.md#test-kinds
const faultDocumentStep = "SOKSAK_FAULT_DOCUMENT_STEP"

// documentSteps is the record of the steps of the configuration of a document region, in the order in which they ran.
var documentSteps struct {
	sync.Mutex
	ran []string
}

// recordDocumentStep appends step to the record of the steps that ran.
func recordDocumentStep(step string) {
	documentSteps.Lock()
	documentSteps.ran = append(documentSteps.ran, step)
	documentSteps.Unlock()
}

// documentStepsRan returns the steps that ran since the last reset and empties the record.
func documentStepsRan() []string {
	documentSteps.Lock()
	defer documentSteps.Unlock()
	ran := documentSteps.ran
	documentSteps.ran = nil
	return ran
}

// documentStepFault records the step and returns the error that the fault point injects into it, or nil when the point names another step.
func documentStepFault(step string) error {
	recordDocumentStep(step)
	if os.Getenv(faultDocumentStep) == step {
		return errors.New(step + " failed")
	}
	return nil
}
