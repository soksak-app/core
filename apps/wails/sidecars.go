// 사이드카 채널.
//
// environment.json 에 선언된 사이드카를 처음 사용할 때 실행하고, 표면 페이지와 사이드카
// 사이에서 한 줄 JSON 메시지를 전달한다. 메시지 본문은 해석하지 않는다. 형식은
// docs/spec/sidecars.md 에 정의한다.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
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
	directory string
	declared  map[string]bool
	running   map[string]*sidecar
	owners    map[string]sidecarOwner
	stopped   bool
}

// NewSidecars 는 environment.json 의 sidecars 목록으로 채널을 생성한다. 실행 파일은
// directory 에서 soksak-<이름> 으로 찾는다.
func NewSidecars(environment []byte, directory string) (*Sidecars, error) {
	var declared struct {
		Sidecars []string `json:"sidecars"`
	}
	if err := json.Unmarshal(environment, &declared); err != nil {
		return nil, fmt.Errorf("environment.json: %w", err)
	}
	c := &Sidecars{directory: directory, declared: map[string]bool{},
		running: map[string]*sidecar{}, owners: map[string]sidecarOwner{}}
	for _, name := range declared.Sidecars {
		c.declared[name] = true
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
	if !c.declared[name] {
		return fmt.Errorf("sidecar %s is not declared in environment.json", name)
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
	cmd := exec.Command(filepath.Join(c.directory, "soksak-"+name))
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
