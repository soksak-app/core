// 표면마다 하나의 셸 프로세스를 실행한다.
//
// 콘솔이며 터미널 에뮬레이터가 아니다. 출력은 줄 단위 텍스트로 전달하고 입력은 받은
// 그대로 전달한다. 대화형 셸은 터미널 제어 문자로 프롬프트를 그리므로 셸을 대화형으로
// 실행하지 않는다.
package shell

import (
	"bufio"
	"fmt"
	"io"
	"os/exec"
	"sync"

	"github.com/min-median-max/soksak/sidecars/shell/src/platform"
	_ "github.com/min-median-max/soksak/sidecars/shell/src/platform/darwin"
	_ "github.com/min-median-max/soksak/sidecars/shell/src/platform/linux"
	_ "github.com/min-median-max/soksak/sidecars/shell/src/platform/windows"
)

type session struct {
	cmd   *exec.Cmd
	stdin io.WriteCloser
}

type Shells struct {
	mu      sync.Mutex
	running map[string]*session
	// 출력 한 줄을 받는 함수. 읽는 고루틴이 줄마다 바로 호출한다.
	say func(id string, text string)
}

// NewShells 는 셸 집합을 생성한다. say 는 각 셸이 출력한 줄을 읽는 고루틴에서 받는다.
func NewShells(say func(id string, text string)) *Shells {
	return &Shells{running: map[string]*session{}, say: say}
}

// Open 은 id 의 셸을 시작하고 시작 여부를 반환한다. 이미 실행 중이면 시작하지 않고
// false 를 반환한다. 같은 출력에 읽는 고루틴이 둘 생기지 않게 하기 위해서다.
func (s *Shells) Open(id, root string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, live := s.running[id]; live {
		return false, nil
	}

	current, err := platform.Current()
	if err != nil {
		return false, err
	}
	cmd := exec.Command(current.Shell())
	cmd.Dir = root
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return false, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		stdin.Close()
		return false, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		stdin.Close()
		stdout.Close()
		return false, err
	}
	// Wait 는 시작된 프로세스의 파이프만 닫는다. 시작에 실패하면 여기서 닫아야 부모
	// 프로세스의 파일 기술자가 남지 않는다.
	if err := cmd.Start(); err != nil {
		stdin.Close()
		stdout.Close()
		stderr.Close()
		return false, err
	}

	live := &session{cmd: cmd, stdin: stdin}
	s.running[id] = live

	for _, stream := range []io.Reader{stdout, stderr} {
		go func(stream io.Reader) {
			reader := bufio.NewReader(stream)
			for {
				// ReadString 은 줄바꿈을 포함해 반환하므로 셸이 출력한 줄바꿈이 그대로 전달된다.
				line, err := reader.ReadString('\n')
				if line != "" {
					s.say(id, line)
				}
				if err != nil {
					return
				}
			}
		}(stream)
	}
	return true, nil
}

// Write 는 id 의 셸 입력으로 data 를 전달한다.
func (s *Shells) Write(id string, data string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	live, ok := s.running[id]
	if !ok {
		return fmt.Errorf("shell %s is not running", id)
	}
	_, err := io.WriteString(live.stdin, data)
	return err
}

// Close 는 표면이 제거된 셸을 종료한다.
//
// 종료는 프로세스를 기다리는 작업이므로 잠금을 해제한 뒤 수행한다. 잠금을 유지한 채
// 기다리면 다른 호출이 대기한다.
func (s *Shells) Close(id string) {
	s.mu.Lock()
	live, ok := s.running[id]
	if ok {
		delete(s.running, id)
	}
	s.mu.Unlock()
	if !ok {
		return
	}

	_ = live.stdin.Close()
	_ = live.cmd.Process.Kill()
	_ = live.cmd.Wait()
}

// CloseAll 은 실행 중인 모든 셸을 종료한다.
func (s *Shells) CloseAll() {
	s.mu.Lock()
	ids := make([]string, 0, len(s.running))
	for id := range s.running {
		ids = append(ids, id)
	}
	s.mu.Unlock()
	for _, id := range ids {
		s.Close(id)
	}
}
