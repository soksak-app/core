// Package routine is the entrance of every goroutine of the host (docs/spec/hosts.md#process-lifecycle).
//
// Go starts a function in a goroutine and recovers its panic. The panic is written to the standard error with the name of
// the goroutine and its stack, handed to Record, and ends the process with PanicStatus: a state that a panic left behind is
// not trusted, so there is no mode that continues after a panic. A package of the host that starts a goroutine uses Go;
// a bare go statement ends the process with the Go runtime's report only and leaves no event.
package routine

import (
	"fmt"
	"os"
	"runtime/debug"
)

// PanicStatus is the exit status of the process after a panic of a goroutine; it is the status of an unrecovered Go panic.
const PanicStatus = 2

// Record stores the panic of a goroutine and waits until it is stored. The host sets it when it starts; the process ends
// after it returns.
var Record = func(name, text, stack string) {}

// Go runs fn in a goroutine called name. A panic of fn is recorded and ends the process with PanicStatus.
func Go(name string, fn func()) {
	go func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				end(name, fmt.Sprint(recovered), string(debug.Stack()))
			}
		}()
		fn()
	}()
}

// end writes the panic to the standard error, records it and ends the process.
func end(name, text, stack string) {
	fmt.Fprintf(os.Stderr, "panic: %s\n\ngoroutine %s:\n%s", text, name, stack)
	Record(name, text, stack)
	os.Exit(PanicStatus)
}
