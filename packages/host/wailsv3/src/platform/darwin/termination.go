//go:build darwin

package darwin

import (
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
