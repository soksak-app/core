// 표면마다 하나의 셸 프로세스를 실행한다.
//
// 콘솔이며 터미널 에뮬레이터가 아니다. 출력은 줄 단위 텍스트로 전달하고 입력은 받은
// 그대로 전달한다. 대화형 셸은 터미널 제어 문자로 프롬프트를 그리므로 셸을 대화형으로
// 실행하지 않는다. 표준 출력과 표준 오류는 한 파이프로 받아 출력 순서를 유지한다.
package shell

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"sync"

	"github.com/min-median-max/soksak/sidecars/shell/src/platform"
	_ "github.com/min-median-max/soksak/sidecars/shell/src/platform/darwin"
	_ "github.com/min-median-max/soksak/sidecars/shell/src/platform/linux"
	_ "github.com/min-median-max/soksak/sidecars/shell/src/platform/windows"
)

// Output 은 셸이 보내는 것을 받는 함수들이다. 읽는 고루틴에서 호출된다.
type Output struct {
	// Text 는 출력 한 줄을 받는다. 줄바꿈을 포함한다.
	Text func(id, text string)
	// Directory 는 셸의 현재 디렉터리를 받는다.
	Directory func(id, dir string)
	// Finished 는 Run 의 결과를 받는다. err 가 있으면 명령을 실행하지 못한 것이다.
	Finished func(id, request, output string, exit int, err error)
}

type session struct {
	cmd *exec.Cmd
	// 실행 중인 명령의 표준 입력.
	stdin io.WriteCloser
	// 셸이 실행할 명령을 읽는 파이프.
	commands io.WriteCloser
	// 마지막으로 보고된 현재 디렉터리. Run 이 이 디렉터리에서 실행한다.
	dir string
	// 실행 중인 Run 명령. 중단과 종료 대상이다.
	runs map[*exec.Cmd]bool
}

type Shells struct {
	mu       sync.Mutex
	running  map[string]*session
	output   Output
	platform platform.Platform
}

// interrupts 는 사이드카가 받은 중단 신호다. 읽지 않는다.
var interrupts = make(chan os.Signal, 1)

// NewShells 는 셸 집합을 생성한다.
//
// 부모가 중단 신호를 무시한 채 사이드카를 시작하면(예: 작업 제어가 없는 셸의 백그라운드 실행)
// 무시 상태가 셸과 명령에 상속되어 중단이 동작하지 않는다. 처리기를 설치한 신호는 실행한 자식에서
// 기본 동작으로 돌아가므로 처리기를 설치한다. 사이드카 자신은 이 신호로 종료하지 않는다.
func NewShells(output Output) (*Shells, error) {
	current, err := platform.Current()
	if err != nil {
		return nil, err
	}
	signal.Notify(interrupts, os.Interrupt)
	return &Shells{running: map[string]*session{}, output: output, platform: current}, nil
}

// Open 은 id 의 셸을 root 에서 시작하고 시작 여부를 반환한다. 이미 실행 중이면 시작하지 않고
// false 를 반환한다. 같은 출력에 읽는 고루틴이 둘 생기지 않게 하기 위해서다. 시작한 셸은 곧바로
// 현재 디렉터리를 보고한다.
//
// 파이프는 셋이다. 셸이 명령을 읽는 파이프, 실행 중인 명령의 표준 입력, 표준 출력과 표준 오류를
// 함께 받는 파이프.
func (s *Shells) Open(id, root string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, live := s.running[id]; live {
		return false, nil
	}

	cmd, err := s.platform.Session()
	if err != nil {
		return false, err
	}
	cmd.Dir = root
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return false, err
	}
	commandsRead, commands, err := os.Pipe()
	if err != nil {
		stdin.Close()
		return false, err
	}
	reader, writer, err := os.Pipe()
	if err != nil {
		stdin.Close()
		commandsRead.Close()
		commands.Close()
		return false, err
	}
	cmd.ExtraFiles = []*os.File{commandsRead}
	cmd.Stdout = writer
	cmd.Stderr = writer
	err = cmd.Start()
	// 자식이 쓰고 읽는 끝은 자식이 가진다. 부모가 닫아야 셸이 끝났을 때 읽기가 끝난다.
	writer.Close()
	commandsRead.Close()
	if err != nil {
		stdin.Close()
		commands.Close()
		reader.Close()
		return false, err
	}

	live := &session{cmd: cmd, stdin: stdin, commands: commands, dir: root, runs: map[*exec.Cmd]bool{}}
	s.running[id] = live
	go s.read(id, live, reader)
	return true, nil
}

// read 는 셸 출력을 줄 단위로 전달한다. 현재 디렉터리 보고 줄은 출력에서 빼고 Directory 로 보낸다.
func (s *Shells) read(id string, live *session, stream io.ReadCloser) {
	defer stream.Close()
	reader := bufio.NewReader(stream)
	for {
		// ReadString 은 줄바꿈을 포함해 반환하므로 셸이 출력한 줄바꿈이 그대로 전달된다.
		line, err := reader.ReadString('\n')
		if dir, ok := strings.CutPrefix(line, platform.DirectoryMarker); ok {
			dir = strings.TrimSuffix(dir, "\n")
			s.mu.Lock()
			live.dir = dir
			s.mu.Unlock()
			s.output.Directory(id, dir)
		} else if line != "" {
			s.output.Text(id, line)
		}
		if err != nil {
			return
		}
	}
}

// Write 는 id 의 셸에 data 를 전달한다.
//
// 셸이 명령을 실행하고 있으면 data 는 그 명령의 표준 입력이다. 기다리고 있으면 data 는 셸이
// 실행할 명령이다. 명령이 끝나기 전에 쓴 줄은 명령의 입력이 되고, 명령이 시작되기 전에 쓴 줄은
// 다음 명령이 된다.
func (s *Shells) Write(id string, data string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	live, ok := s.running[id]
	if !ok {
		return fmt.Errorf("shell %s is not running", id)
	}
	busy, err := s.platform.Children(live.cmd.Process.Pid)
	if err != nil {
		return err
	}
	target := live.commands
	if busy > 0 {
		target = live.stdin
	}
	_, err = io.WriteString(target, data)
	return err
}

// Run 은 id 의 셸이 보고한 현재 디렉터리에서 command 를 한 번 실행하고, 끝나면 Finished 로
// request 와 병합된 출력, 종료 코드를 보낸다. 셸 세션의 상태(변수, 디렉터리 변경)는 바꾸지 않는다.
func (s *Shells) Run(id, request, command string) error {
	s.mu.Lock()
	live, ok := s.running[id]
	if !ok {
		s.mu.Unlock()
		return fmt.Errorf("shell %s is not running", id)
	}
	cmd, err := s.platform.Run(command)
	if err != nil {
		s.mu.Unlock()
		return err
	}
	// 사라진 디렉터리에서 시작하면 exec 가 셸 프로그램이 없다고 보고하므로 먼저 확인한다.
	if info, err := os.Stat(live.dir); err != nil || !info.IsDir() {
		s.mu.Unlock()
		return fmt.Errorf("the session directory %s does not exist", live.dir)
	}
	cmd.Dir = live.dir
	var output bytes.Buffer
	cmd.Stdout = &output
	cmd.Stderr = &output
	if err := cmd.Start(); err != nil {
		s.mu.Unlock()
		return err
	}
	live.runs[cmd] = true
	s.mu.Unlock()

	go func() {
		err := cmd.Wait()
		s.mu.Lock()
		delete(live.runs, cmd)
		s.mu.Unlock()
		exit := 0
		var exited *exec.ExitError
		if errors.As(err, &exited) {
			exit = exited.ExitCode()
			err = nil
		}
		s.output.Finished(id, request, output.String(), exit, err)
	}()
	return nil
}

// Interrupt 는 id 의 셸에서 실행 중인 명령과 Run 명령에 중단 신호를 보낸다. 셸은 계속 실행된다.
func (s *Shells) Interrupt(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	live, ok := s.running[id]
	if !ok {
		return fmt.Errorf("shell %s is not running", id)
	}
	if err := s.platform.Interrupt(live.cmd.Process.Pid); err != nil {
		return err
	}
	for cmd := range live.runs {
		if err := s.platform.Interrupt(cmd.Process.Pid); err != nil {
			return err
		}
	}
	return nil
}

// Close 는 표면이 제거된 셸과 그 Run 명령을 프로세스 그룹째 종료한다.
//
// 종료는 프로세스를 기다리는 작업이므로 잠금을 해제한 뒤 수행한다. 잠금을 유지한 채
// 기다리면 다른 호출이 대기한다.
func (s *Shells) Close(id string) {
	s.mu.Lock()
	live, ok := s.running[id]
	if ok {
		delete(s.running, id)
	}
	var runs []*exec.Cmd
	if ok {
		for cmd := range live.runs {
			runs = append(runs, cmd)
		}
	}
	s.mu.Unlock()
	if !ok {
		return
	}

	for _, cmd := range runs {
		_ = s.platform.Terminate(cmd.Process.Pid)
	}
	_ = live.stdin.Close()
	_ = live.commands.Close()
	_ = s.platform.Terminate(live.cmd.Process.Pid)
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
