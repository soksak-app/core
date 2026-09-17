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
package main

import (
	"bufio"
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
	name    string
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	encoder *json.Encoder
	exited  chan struct{}
}

// sidecarOwner 는 표면을 소유한 창이다. 사이드카 메시지의 root 를 제공하고 이벤트를 받는다.
type sidecarOwner interface {
	projectRoot() string
	emit(name string, data ...any)
}

// Sidecars 는 애플리케이션 하나의 사이드카 프로세스와 표면 소유 창을 관리한다.
type Sidecars struct {
	mu        sync.Mutex
	declared  map[string]string
	running   map[string]*sidecar
	owners    map[string]sidecarOwner
	stopped   bool
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
	c := &Sidecars{declared: map[string]string{},
		running: map[string]*sidecar{}, owners: map[string]sidecarOwner{}}
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
func (c *Sidecars) Send(owner sidecarOwner, name, surface string, body json.RawMessage) error {
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
	return process.encoder.Encode(sidecarRequest{Surface: surface, Root: owner.projectRoot(), Body: body})
}

// Close 는 제거된 표면을 실행 중인 모든 사이드카에 알린다.
func (c *Sidecars) Close(surface string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.owners[surface]; !ok {
		return
	}
	delete(c.owners, surface)
	for _, process := range c.running {
		if err := process.encoder.Encode(sidecarRequest{Surface: surface, Closed: true}); err != nil {
			log.Printf("sidecar %s: close %s: %v", process.name, surface, err)
		}
	}
}

// CloseOwner 는 owner 창의 모든 표면을 사이드카에 알린다. 창이 닫힐 때 호출한다.
func (c *Sidecars) CloseOwner(owner sidecarOwner) {
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

// Stop 은 모든 사이드카의 표준 입력을 닫고 종료를 기다린다.
func (c *Sidecars) Stop() {
	c.mu.Lock()
	c.stopped = true
	processes := make([]*sidecar, 0, len(c.running))
	for _, process := range c.running {
		processes = append(processes, process)
	}
	c.mu.Unlock()
	for _, process := range processes {
		_ = process.stdin.Close()
		<-process.exited
	}
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
	process := &sidecar{name: name, cmd: cmd, stdin: stdin, encoder: json.NewEncoder(stdin), exited: make(chan struct{})}
	c.running[name] = process
	go c.read(process, stdout)
	return process, nil
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
			owner.emit("sidecar-message", SidecarMessage{Sidecar: process.name, Surface: event.Surface, Body: event.Body})
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
