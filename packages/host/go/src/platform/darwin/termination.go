//go:build darwin

package darwin

import (
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/soksak-app/core/packages/host/go/src/routine"
)

// terminationSignals are the signals that request the end of the process.
var terminationSignals = []os.Signal{syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP}

func (implementation) BlockAsyncSignals() error {
	switch result := native.SpBlockAsyncSignals(); result {
	case 0:
		return nil
	case -1:
		return errors.New("block asynchronous signals: the calling thread is not the main thread")
	default:
		return fmt.Errorf("block asynchronous signals: pthread_sigmask: %w", syscall.Errno(result))
	}
}

func (implementation) OnTermination(quit func(signal os.Signal, senderPid int)) error {
	received := make(chan os.Signal, 1)
	signal.Notify(received, terminationSignals...)
	// The recorder of the senders is installed after the handler of Go, so it passes each signal on to it.
	if result := native.SpTerminationSignalsRecord(); result != 0 {
		signal.Stop(received)
		return fmt.Errorf("record the senders of termination signals: sigaction: %w", syscall.Errno(result))
	}
	routine.Go("termination-signal", func() {
		value := <-received
		// The next signal ends the process with the default action. This allows ending even when the save during termination hangs.
		signal.Reset(terminationSignals...)
		sender := 0
		if number, ok := value.(syscall.Signal); ok {
			sender = int(native.SpTerminationSignalSender(int32(number)))
		}
		quit(value, sender)
	})
	return nil
}

// quitRequest is the function that the termination request of the operating system calls.
var quitRequest func(senderPid int, sender string)

// goHost_quit_request copies the borrowed name of the sender before the request runs on its own routine.
func goHost_quit_request(senderPid int32, sender *byte) {
	pid, name := int(senderPid), ""
	if sender != nil {
		name = native.GoString(sender)
	}
	routine.Go("quit-request", func() { quitRequest(pid, name) })
}

func (implementation) QuitEventType() int { return int(native.MainSpQuitRequestEventType()) }

func (implementation) OnQuitRequest(quit func(senderPid int, sender string)) error {
	quitRequest = quit
	if !native.InstallQuitRequest() {
		return errors.New("failed to register the quit request handler")
	}
	return nil
}

func (implementation) AnswerQuitRequests() { native.MainSpQuitRequestAnswer() }

func (implementation) CancelQuitRequests() { native.MainSpQuitRequestCancel() }
