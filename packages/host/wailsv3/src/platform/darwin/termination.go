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
)

// terminationSignals 는 프로세스 종료를 요청하는 신호다.
var terminationSignals = []os.Signal{syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP}

func (implementation) OnTermination(quit func()) error {
	received := make(chan os.Signal, 1)
	signal.Notify(received, terminationSignals...)
	go func() {
		<-received
		// 다음 신호는 기본 동작으로 프로세스를 끝낸다. 종료 중 저장이 멈춰도 끝낼 수 있다.
		signal.Reset(terminationSignals...)
		quit()
	}()
	return nil
}

// quitRequest 는 운영체제의 종료 요청이 호출하는 함수다.
var quitRequest func()

//export goQuitRequest
func goQuitRequest() { go quitRequest() }

func (implementation) OnQuitRequest(quit func()) error {
	quitRequest = quit
	if !C.installQuitRequest() {
		return errors.New("failed to register the quit request handler")
	}
	return nil
}

func (implementation) AnswerQuitRequests() { C.sp_quit_request_answer() }

func (implementation) CancelQuitRequests() { C.sp_quit_request_cancel() }
