//go:build darwin

package darwin

/*
#include <stdbool.h>
#include "quit_request.h"

extern void goQuitRequest(void);
static bool installQuitRequest(void) { return sp_quit_request_install(^{ goQuitRequest(); }); }
*/
import "C"

import (
	"errors"

	"os"
	"os/signal"
	"syscall"

	"github.com/soksak-app/core/packages/host/wailsv3/src/routine"
)

// terminationSignals are the signals that request the end of the process.
var terminationSignals = []os.Signal{syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP}

func (implementation) OnTermination(quit func(signal os.Signal)) error {
	received := make(chan os.Signal, 1)
	signal.Notify(received, terminationSignals...)
	routine.Go("termination-signal", func() {
		value := <-received
		// The next signal ends the process with the default action. This allows ending even when the save during termination hangs.
		signal.Reset(terminationSignals...)
		quit(value)
	})
	return nil
}

// quitRequest is the function that the termination request of the operating system calls.
var quitRequest func()

//export goQuitRequest
func goQuitRequest() { routine.Go("quit-request", quitRequest) }

func (implementation) OnQuitRequest(quit func()) error {
	quitRequest = quit
	if !C.installQuitRequest() {
		return errors.New("failed to register the quit request handler")
	}
	return nil
}

func (implementation) AnswerQuitRequests() { C.sp_quit_request_answer() }

func (implementation) CancelQuitRequests() { C.sp_quit_request_cancel() }
