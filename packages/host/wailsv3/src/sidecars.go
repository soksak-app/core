// 사이드카 채널.
//
// 플러그인이 plugin.json 에 의존성으로 선언한 사이드카를 처음 사용할 때 실행하고,
// 표면 페이지와 사이드카 사이에서 한 줄 JSON 메시지를 전달한다. 메시지 본문은 해석하지
// 않는다. 형식은 docs/spec/sidecars.md 에 정의한다.
//
// 사이드카는 스테이징된 설정 파일로만 찾는다.
//
//	environment.json                  plugins: 플러그인 패키지 이름
//	modules/<플러그인>/plugin.json     sidecars: 사이드카 패키지 이름
//	modules/<사이드카>/sidecar.json    executable: 패키지 안의 실행 파일 경로
//
// 실행 파일은 애플리케이션 실행 파일과 같은 디렉터리에 같은 파일 이름으로 놓인다.

package host

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// SidecarMessage 는 사이드카가 보낸 메시지를 페이지에 전달하는 이벤트 값이다.
type SidecarMessage struct {
	Sidecar string          `json:"sidecar"`
	Surface string          `json:"surface"`
	Body    json.RawMessage `json:"body"`
}

type sidecarRequest struct {
	Surface string          `json:"surface"`
	Root    string          `json:"root,omitempty"`
	Closed  bool            `json:"closed,omitempty"`
	Body    json.RawMessage `json:"body,omitempty"`
}

type sidecarEvent struct {
	Surface string          `json:"surface"`
	Body    json.RawMessage `json:"body"`
}

type sidecar struct {
	name       string
	cmd        *exec.Cmd
	stdin      io.WriteCloser
	outbox     chan []byte
	exited     chan struct{}
	muClosed   sync.Mutex
	closedMsgs map[string][]byte // surface → 마지막 closed 메시지. 같은 표면의 것을 교체한다.
}

// SidecarOwner 는 표면을 소유한 창이다. 사이드카 메시지의 root 를 제공하고 이벤트를 받는다.
type SidecarOwner interface {
	ProjectRoot() string
	Emit(name string, data ...any)
}

// Sidecars 는 애플리케이션 하나의 사이드카 프로세스와 표면 소유 창을 관리한다.
type Sidecars struct {
	mu          sync.Mutex
	declared    map[string]string
	running     map[string]*sidecar
	owners      map[string]SidecarOwner
	stopped     bool
	StopTimeout time.Duration // 테스트에서 주입 가능한 Stop() 기한. 기본값 5초.
}

// NewSidecars 는 스테이징된 프런트엔드 frontend 의 설정 파일로 사이드카를 찾아 채널을 생성한다.
// 실행 파일은 directory 에서 찾는다. 설정 파일이 없거나 형식이 틀리면 실패한다.
func NewSidecars(frontend fs.FS, directory string) (*Sidecars, error) {
	read := func(name string, into any) error {
		data, err := fs.ReadFile(frontend, name)
		if err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
		if err := json.Unmarshal(data, into); err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
		return nil
	}
	var environment struct {
		Plugins []string `json:"plugins"`
	}
	if err := read("environment.json", &environment); err != nil {
		return nil, err
	}
	c := &Sidecars{
		declared:    map[string]string{},
		running:     map[string]*sidecar{},
		owners:      map[string]SidecarOwner{},
		StopTimeout: 5 * time.Second,
	}
	for _, plugin := range environment.Plugins {
		var manifest struct {
			Sidecars []string `json:"sidecars"`
		}
		if err := read(path.Join("modules", plugin, "plugin.json"), &manifest); err != nil {
			return nil, err
		}
		for _, name := range manifest.Sidecars {
			if _, known := c.declared[name]; known {
				continue
			}
			file := path.Join("modules", name, "sidecar.json")
			var declared struct {
				Executable string `json:"executable"`
				Protocol   int    `json:"protocol"`
			}
			if err := read(file, &declared); err != nil {
				return nil, err
			}
			if declared.Executable == "" || path.IsAbs(declared.Executable) ||
				strings.Contains("/"+declared.Executable+"/", "/../") {
				return nil, fmt.Errorf("%s: executable must be a path inside the package", file)
			}
			if declared.Protocol != 1 {
				return nil, fmt.Errorf("%s: protocol must be 1", file)
			}
			c.declared[name] = filepath.Join(directory, path.Base(declared.Executable))
		}
	}
	return c, nil
}

// Send 는 owner 창의 표면 surface 에서 온 body 를 사이드카 name 에 전달한다.
// 뮤텍스 밖에서 직렬화하고 논블로킹 채널로 전송하므로, 사이드카가 느려도 다른 전송을 차단하지 않는다.
func (c *Sidecars) Send(owner SidecarOwner, name, surface string, body json.RawMessage) error {
	// 먼저 뮤텍스 밖에서 JSON 직렬화한다.
	line, err := json.Marshal(sidecarRequest{Surface: surface, Root: owner.ProjectRoot(), Body: body})
	if err != nil {
		return fmt.Errorf("sidecar %s: %w", name, err)
	}
	line = append(line, '\n')

	c.mu.Lock()
	defer c.mu.Unlock()
	if c.stopped {
		return fmt.Errorf("sidecars are stopped")
	}
	if _, ok := c.declared[name]; !ok {
		return fmt.Errorf("sidecar %s is not declared by any plugin", name)
	}
	if other, ok := c.owners[surface]; ok && other != owner {
		return fmt.Errorf("surface %s belongs to another window", surface)
	}
	process, err := c.process(name)
	if err != nil {
		return err
	}
	c.owners[surface] = owner

	// 논블로킹으로 채널에 전송한다. 채널이 가득 차면 "is not keeping up" 오류를 반환한다.
	select {
	case process.outbox <- line:
		return nil
	default:
		return fmt.Errorf("sidecar %s is not keeping up", name)
	}
}

// Close 는 제거된 표면을 실행 중인 모든 사이드카에 알린다.
func (c *Sidecars) Close(surface string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.owners[surface]; !ok {
		return
	}
	delete(c.owners, surface)

	// 뮤텍스 밖에서 직렬화한다.
	line, err := json.Marshal(sidecarRequest{Surface: surface, Closed: true})
	if err != nil {
		log.Printf("sidecar close %s: marshal: %v", surface, err)
		return
	}
	line = append(line, '\n')

	for _, process := range c.running {
		// 논블로킹으로 채널에 전송한다. 채널이 가득 차면 closedMsgs에 저장한다.
		select {
		case process.outbox <- line:
		default:
			// 채널이 가득 찼으므로 closedMsgs에 저장 (같은 표면의 이전 것을 교체)
			process.muClosed.Lock()
			process.closedMsgs[surface] = line
			process.muClosed.Unlock()
		}
	}
}

// CloseOwner 는 owner 창의 모든 표면을 사이드카에 알린다. 창이 닫힐 때 호출한다.
func (c *Sidecars) CloseOwner(owner SidecarOwner) {
	c.mu.Lock()
	surfaces := make([]string, 0)
	for surface, current := range c.owners {
		if current == owner {
			surfaces = append(surfaces, surface)
		}
	}
	c.mu.Unlock()
	for _, surface := range surfaces {
		c.Close(surface)
	}
}

// Stop 은 모든 사이드카를 종료한다. 채널을 닫아 쓰기 고루틴에 EOF 신호를 보내고,
// 최대 stopTimeout 동안 프로세스 종료를 기다린 뒤 응답하지 않으면 강제 종료한다.
func (c *Sidecars) Stop() {
	c.mu.Lock()
	c.stopped = true
	processes := make([]*sidecar, 0, len(c.running))
	for _, process := range c.running {
		processes = append(processes, process)
	}
	c.mu.Unlock()

	// 모든 사이드카에 대해 채널을 닫아 EOF 신호를 보낸다.
	// 쓰기 고루틴이 채널 닫힘을 감지하고 stdin을 닫는다.
	for _, process := range processes {
		close(process.outbox)
	}

	// 모든 프로세스를 병렬로 기다린다. 기한을 넘기면 kill하고 Wait()로 좀비를 수집한다.
	ctx, cancel := context.WithTimeout(context.Background(), c.StopTimeout)
	defer cancel()

	var wg sync.WaitGroup
	for _, process := range processes {
		wg.Add(1)
		go func(p *sidecar) {
			defer wg.Done()
			// 프로세스가 종료되기를 기다린다.
			done := make(chan error, 1)
			go func() {
				done <- p.cmd.Wait()
			}()

			select {
			case <-done:
				// 프로세스가 정상 종료됨.
			case <-ctx.Done():
				// 기한 초과. 강제 종료.
				_ = p.cmd.Process.Kill()
				// Wait() 호출하여 좀비 수집.
				_ = p.cmd.Wait()
			}
		}(process)
	}
	wg.Wait()
}

// process 는 실행 중인 사이드카를 반환하고, 없으면 실행한다. c.mu 를 잡은 상태로 호출한다.
func (c *Sidecars) process(name string) (*sidecar, error) {
	if process, ok := c.running[name]; ok {
		return process, nil
	}
	cmd := exec.Command(c.declared[name])
	cmd.Stderr = os.Stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		stdin.Close()
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		stdin.Close()
		stdout.Close()
		return nil, fmt.Errorf("sidecar %s: %w", name, err)
	}
	process := &sidecar{
		name: name, cmd: cmd, stdin: stdin,
		outbox:     make(chan []byte, 256),
		exited:     make(chan struct{}),
		closedMsgs: make(map[string][]byte),
	}
	c.running[name] = process
	go c.write(process)        // 쓰기 고루틴: outbox 채널에서 읽어 stdin 에 쓴다.
	go c.read(process, stdout) // 읽기 고루틴: stdout 에서 읽어 이벤트를 전달한다.
	return process, nil
}

// write 는 outbox 채널에서 바이트를 읽어 사이드카의 stdin 에 쓴다. 채널이 닫히면 stdin 을 닫고 종료한다.
func (c *Sidecars) write(process *sidecar) {
	for line := range process.outbox {
		if _, err := process.stdin.Write(line); err != nil {
			log.Printf("sidecar %s: write: %v", process.name, err)
			break
		}
	}
	_ = process.stdin.Close()
}

// read 는 사이드카의 출력을 표면 소유 창에 전달하고, 출력이 끝나면 프로세스를 정리한다.
func (c *Sidecars) read(process *sidecar, stdout io.Reader) {
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	for scanner.Scan() {
		var event sidecarEvent
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			log.Printf("sidecar %s: invalid event: %v", process.name, err)
			continue
		}
		c.mu.Lock()
		owner := c.owners[event.Surface]
		c.mu.Unlock()
		if owner != nil {
			// 이미지 봉투 여부 확인
			if c.tryHandleImageEnvelope(owner, process.name, event.Surface, event.Body) {
				continue
			}
			owner.Emit("sidecar-message", SidecarMessage{Sidecar: process.name, Surface: event.Surface, Body: event.Body})
		}
	}
	err := process.cmd.Wait()
	c.mu.Lock()
	if c.running[process.name] == process {
		delete(c.running, process.name)
	}
	stopped := c.stopped
	c.mu.Unlock()
	if !stopped {
		log.Printf("sidecar %s exited: %v", process.name, err)
	}
	close(process.exited)
}

// tryHandleImageEnvelope 은 이벤트가 이미지 봉투인지 확인하고 처리한다. 봉투면 true 를 반환한다.
func (c *Sidecars) tryHandleImageEnvelope(owner SidecarOwner, sidecarName, surface string, body json.RawMessage) bool {
	// 오너가 이미지 봉투 결정 핸들러를 가지고 있는지 확인
	if decider, ok := owner.(interface {
		DecideImageEnvelope(sidecarName, surface string, body json.RawMessage) bool
	}); ok {
		return decider.DecideImageEnvelope(sidecarName, surface, body)
	}

	return false
}
