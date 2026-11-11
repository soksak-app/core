//go:build diagnostics

package host

import "testing"

// contract: diagnostics.modal-hold.ends-with-window-or-connection
func TestAModalHoldEndsWithItsWindow(t *testing.T) {
	e, s, _ := heldEndpoint(t)
	endModalHoldsAfter(t, e)
	if err := call(t, e, endpointConnection(t), "diagnostics.modal.hold", `{"window":"window-a","on":true}`); err != nil {
		t.Fatal(err)
	}
	waited := make(chan struct{})
	go func() {
		holdModalContent(s)
		close(waited)
	}()
	answered := heldAnswer(t, s)
	// The close of a window ends each diagnostic hold of the window before its views close.
	if diagnosticWindowClosed == nil {
		t.Fatal("a diagnostic build does not end the holds of a window that closes")
	}
	diagnosticWindowClosed(s)
	if !ended(waited) {
		t.Fatal("the held modal content answer was not sent when its window closed")
	}
	if !ended(answered) {
		t.Fatal("diagnostics.modal.held did not answer when the window of the hold closed")
	}
}
