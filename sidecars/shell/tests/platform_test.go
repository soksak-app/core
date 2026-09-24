package shell_test

import (
	"os/exec"
	"syscall"
	"testing"
	"time"

	"github.com/min-median-max/soksak/sidecars/shell/src/platform"
	_ "github.com/min-median-max/soksak/sidecars/shell/src/shell"
)

func TestCurrentPlatformBuildsASession(t *testing.T) {
	current, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	cmd, err := current.Session()
	if err != nil {
		t.Fatal(err)
	}
	if cmd.Path == "" {
		t.Fatal("the platform returned a session without a program")
	}
}

func TestAPosixShellIsUsedWhenShellIsNotPosix(t *testing.T) {
	t.Setenv("SHELL", "/opt/homebrew/bin/fish")
	current, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	cmd, err := current.Session()
	if err != nil {
		t.Fatal(err)
	}
	if cmd.Path != "/bin/sh" {
		t.Fatalf("session program = %s, want /bin/sh", cmd.Path)
	}
}

// 셸이 끝났지만 아직 회수되지 않은 동안 그 그룹을 끝내면 끝낼 프로세스가 없으므로 성공한다.
// macOS 는 이런 그룹의 신호에 EPERM 으로 답한다.
func TestTerminatingAGroupWhoseShellHasEndedSucceeds(t *testing.T) {
	current, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("/bin/sh", "-c", "exit 0")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	pid := cmd.Process.Pid
	// 종료를 기다리되 회수하지 않는다. 끝난 프로세스에 대한 kill(pid, 0) 은 좀비가 회수될 때까지 성공하므로
	// 그룹 신호의 답으로 끝났는지를 본다.
	deadline := time.Now().Add(2 * time.Second)
	for syscall.Kill(-pid, 0) != syscall.EPERM {
		if time.Now().After(deadline) {
			t.Fatalf("the ended shell group %d never answered EPERM", pid)
		}
		time.Sleep(5 * time.Millisecond)
	}
	terminated := current.Terminate(pid)
	if err := cmd.Wait(); err != nil {
		t.Fatal(err)
	}
	if terminated != nil {
		t.Fatalf("terminating an ended shell group failed: %v", terminated)
	}
}
