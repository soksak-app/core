//go:build darwin

package darwin

/*
#include <pthread.h>
#include <signal.h>
#include <stdbool.h>
#include "quit_request.h"
#include "main_thread.h"

// The request runs its Go function on the worker, and the native calls run on the main thread (main_thread.h).
extern void goQuitRequest(void);
static bool installQuitRequest(void) {
    return ON_MAIN(bool, sp_quit_request_install(^{ wailsRunOnWorker(^{ goQuitRequest(); }); }));
}
static void main_sp_quit_request_answer(void) { wailsRunOnMain(^{ sp_quit_request_answer(); }); }
static void main_sp_quit_request_cancel(void) { wailsRunOnMain(^{ sp_quit_request_cancel(); }); }

// blockAsyncSignals blocks every signal except the synchronous faults on the main thread and returns 0, -1 on another thread,
// or the error number of pthread_sigmask. A fault that the main thread raises is delivered to it whether it is blocked or not, so
// the faults stay unblocked to reach their handlers.
static int blockAsyncSignals(void) {
    if (!pthread_main_np()) return -1;
    sigset_t set;
    sigfillset(&set);
    const int faults[] = {SIGILL, SIGTRAP, SIGABRT, SIGEMT, SIGFPE, SIGBUS, SIGSEGV, SIGSYS};
    for (size_t i = 0; i < sizeof faults / sizeof faults[0]; i++) sigdelset(&set, faults[i]);
    return pthread_sigmask(SIG_BLOCK, &set, NULL);
}
*/
import "C"

import (
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/soksak-app/core/packages/host/wailsv3/src/routine"
)

// terminationSignals are the signals that request the end of the process.
var terminationSignals = []os.Signal{syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP}

func (implementation) BlockAsyncSignals() error {
	switch result := C.blockAsyncSignals(); result {
	case 0:
		return nil
	case -1:
		return errors.New("block asynchronous signals: the calling thread is not the main thread")
	default:
		return fmt.Errorf("block asynchronous signals: pthread_sigmask: %w", syscall.Errno(result))
	}
}

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

func (implementation) AnswerQuitRequests() { C.main_sp_quit_request_answer() }

func (implementation) CancelQuitRequests() { C.main_sp_quit_request_cancel() }
