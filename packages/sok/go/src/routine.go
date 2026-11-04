package sok

// The entrance of every goroutine of the tool and of the recovery of its panics (docs/spec/cli.md#event-log).
//
// Go starts a function in a goroutine and recovers its panic; Guard runs the command in the calling goroutine and recovers
// its panic. A panic of a goroutine is written to the standard error with the name of the goroutine and its stack, handed to
// the recorder that Logged installs, and ends the process with PanicStatus: a state that a panic left behind is not trusted,
// so no mode continues after it. A bare go statement ends the process with the report of the Go runtime only and leaves no
// event.

import (
	"fmt"
	"os"
	"runtime/debug"
	"sync/atomic"
)

// PanicStatus is the exit status of the tool after a panic.
const PanicStatus = 4

// Panic is a panic that an entrance recovered.
type Panic struct {
	// Name is the name of the goroutine; the command runs in the goroutine "main".
	Name  string
	Text  string
	Stack string
}

// panicRecorder stores a panic of a goroutine and waits until it is stored; Logged installs it for the run.
var panicRecorder atomic.Pointer[func(Panic)]

// Go runs fn in a goroutine called name. A panic of fn is recorded and ends the process with PanicStatus.
func Go(name string, fn func()) {
	go func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				end(Panic{Name: name, Text: fmt.Sprint(recovered), Stack: string(debug.Stack())})
			}
		}()
		fn()
	}()
}

// Guard runs fn in the calling goroutine, which is the goroutine "main", and returns its result. A panic of fn is returned
// as a value and fn's result is 0.
func Guard(fn func() int) (status int, panicked *Panic) {
	defer func() {
		if recovered := recover(); recovered != nil {
			panicked = &Panic{Name: "main", Text: fmt.Sprint(recovered), Stack: string(debug.Stack())}
		}
	}()
	return fn(), nil
}

// end writes the panic of a goroutine to the standard error, records it and ends the process.
func end(p Panic) {
	fmt.Fprintf(os.Stderr, "sok: panic: %s\n\ngoroutine %s:\n%s", p.Text, p.Name, p.Stack)
	if record := panicRecorder.Load(); record != nil {
		(*record)(p)
	}
	os.Exit(PanicStatus)
}
