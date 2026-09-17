//go:build linux

package linux

import (
	"os"
	"os/exec"
	"path/filepath"
	"syscall"

	"github.com/min-median-max/soksak/sidecars/shell/src/platform"
)

type implementation struct{}

func init() { platform.Register(implementation{}) }

// posix 는 세션이 쓰는 trap 과 printf 문법을 지원하는 셸이다.
var posix = map[string]bool{"sh": true, "bash": true, "zsh": true, "ksh": true, "dash": true}

// shell 은 $SHELL 이 POSIX 셸이면 그것을, 아니면 /bin/sh 를 반환한다. 세션 입력은 POSIX
// 셸 문법이므로 다른 셸(fish 등)에는 보내지 않는다.
func shell() string {
	if program := os.Getenv("SHELL"); posix[filepath.Base(program)] {
		return program
	}
	return "/bin/sh"
}

func group(cmd *exec.Cmd) *exec.Cmd {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	return cmd
}

// session 은 세션 셸이 실행하는 스크립트다. trap 처리기가 있는 신호는 자식에서 기본 동작으로
// 돌아가므로, 그룹에 보낸 중단 신호는 실행 중인 명령만 끝낸다. 명령은 한 줄씩 읽어 실행하므로
// 여러 줄에 걸친 구문은 한 줄로 써야 한다.
const session = `trap : INT
printf '\036cwd %s\n' "$PWD"
while IFS= read -r __soksak_line <&3; do
  eval "$__soksak_line"
  printf '\036cwd %s\n' "$PWD"
done`

func (implementation) Session() (*exec.Cmd, error) {
	return group(exec.Command(shell(), "-c", session)), nil
}

func (implementation) Run(command string) (*exec.Cmd, error) {
	return group(exec.Command(shell(), "-c", command)), nil
}

func (implementation) Interrupt(pid int) error { return syscall.Kill(-pid, syscall.SIGINT) }

func (implementation) Terminate(pid int) error { return syscall.Kill(-pid, syscall.SIGKILL) }
