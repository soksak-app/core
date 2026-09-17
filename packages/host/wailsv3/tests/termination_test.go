// 종료 신호 테스트. 신호는 프로세스 전체에 영향을 주므로 자식 프로세스에서 확인한다.
package host_test

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"testing"

	host "github.com/min-median-max/soksak/packages/host/wailsv3/src"
)

// terminationChild 는 자식 프로세스임을 알리는 환경 변수다.
const terminationChild = "SOKSAK_TERMINATION_CHILD"

func TestTerminationSignalRequestsQuitOnceAndTheNextEndsTheProcess(t *testing.T) {
	if os.Getenv(terminationChild) != "" {
		terminate()
		return
	}
	command := exec.Command(os.Args[0], "-test.run=^TestTerminationSignalRequestsQuitOnceAndTheNextEndsTheProcess$")
	command.Env = append(os.Environ(), terminationChild+"=1")
	// 자식은 표준 입력을 읽으며 기다린다. 부모가 쓰는 쪽을 열어 두므로 신호 없이는 끝나지 않는다.
	stdin, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer stdin.Close()
	output, err := command.Output()
	var exit *exec.ExitError
	if !errors.As(err, &exit) {
		t.Fatalf("child ended with %v, output %q", err, output)
	}
	status := exit.Sys().(syscall.WaitStatus)
	if !status.Signaled() || status.Signal() != syscall.SIGTERM || string(output) != "quit requested\n" {
		t.Fatalf("child status %v, output %q", status, output)
	}
}

// terminate 는 종료 신호를 두 번 받는다. 첫 신호는 quit 를 부르고, 둘째 신호는 프로세스를 끝낸다.
func terminate() {
	quit := make(chan struct{})
	if err := host.OnTermination(func() { close(quit) }); err != nil {
		fmt.Println(err)
		os.Exit(2)
	}
	self, err := os.FindProcess(os.Getpid())
	if err != nil {
		fmt.Println(err)
		os.Exit(2)
	}
	if err := self.Signal(syscall.SIGTERM); err != nil {
		fmt.Println(err)
		os.Exit(2)
	}
	<-quit
	fmt.Println("quit requested")
	if err := self.Signal(syscall.SIGTERM); err != nil {
		fmt.Println(err)
		os.Exit(2)
	}
	os.Stdin.Read(make([]byte, 1))
	fmt.Println("the second signal did not end the process")
	os.Exit(3)
}
