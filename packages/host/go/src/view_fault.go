//go:build diagnostics

// The fault injection point of the view steps. It is compiled only with the diagnostics build tag; the release build has the no-op
// counterpart in view_fault_release.go.

package host

import (
	"errors"
	"os"
)

// faultViewStep is the fault injection point of the view steps of attachView. Its value names the step that fails after the
// platform call of the step returns: message, ended, responsiveness, script or load. The platform call runs first, so the platform
// records the call as the native platform does. docs/operations/examples.md#test-kinds
const faultViewStep = "SOKSAK_FAULT_VIEW_STEP"

// viewStepFault returns the error that the fault point injects into the view step named step, or nil when the point names another step.
func viewStepFault(step string) error {
	if os.Getenv(faultViewStep) == step {
		return errors.New(step + " failed")
	}
	return nil
}

// viewLoadFault reports whether the fault point refuses the load of the view page. A refused load is reported as a load that the
// platform returned false for.
func viewLoadFault() bool {
	return os.Getenv(faultViewStep) == "load"
}

// faultViewPost is the fault injection point of the post to a view document. Its value post makes the post fail as the native post does
// when the document refuses the message; the platform post does not run.
const faultViewPost = "SOKSAK_FAULT_VIEW_POST"

// viewPostFault reports whether the fault point refuses the post to a view document.
func viewPostFault() bool {
	return os.Getenv(faultViewPost) == "post"
}
