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
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/min-median-max/soksak/packages/host/wailsv3/src/platform"
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
	name          string
	cmd           *exec.Cmd
	stdin         io.WriteCloser
	conn          net.Conn
	persistent    bool
	outbox        chan []byte
	exited        chan struct{}
	muClosed      sync.Mutex
	pendingCloses [][]byte // queued closed messages, in send order
	// pendingReplies 는 채널이 가득 찬 경우 immutable image ack를 버퍼링한다.
	// 각 항목을 보존하여 sequence가 다른 응답을 덮어쓰지 않는다.
	pendingReplies [][]byte
	closeWaiters   map[string]chan error
}

// SidecarOwner 는 표면을 소유한 창이다. 사이드카 메시지의 root 를 제공하고 이벤트를 받는다.
type SidecarOwner interface {
	ProjectRoot() string
	Emit(name string, data ...any)
}

// Sidecars 는 애플리케이션 하나의 사이드카 프로세스와 표면 소유 창을 관리한다.
type Sidecars struct {
	mu         sync.Mutex
	declared   map[string]string
	persistent map[string]bool
	running    map[string]*sidecar
	owners     map[string]SidecarOwner
	// roots 는 표면을 처음 보낼 때의 프로젝트 디렉터리다. 사이드카는 root 와 표면으로 세션을 찾으므로,
	// 창의 프로젝트가 바뀐 뒤에도 이미 열린 표면의 요청과 닫힘은 이 root 로 보낸다.
	roots       map[string]string
	stopped     bool
	StopTimeout time.Duration // 테스트에서 주입 가능한 Stop() 기한. 기본값 5초.
	configDir   string
	nextRequest uint64
}

// NewSidecars 는 스테이징된 프런트엔드 frontend 의 설정 파일로 사이드카를 찾아 채널을 생성한다.
// 실행 파일은 directory 에서 찾는다. 설정 파일이 없거나 형식이 틀리면 실패한다.
func NewSidecars(frontend fs.FS, directory, configDirectory string) (*Sidecars, error) {
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
		persistent:  map[string]bool{},
		running:     map[string]*sidecar{},
		owners:      map[string]SidecarOwner{},
		roots:       map[string]string{},
		StopTimeout: 5 * time.Second,
	}
	configDirectoryProvided := strings.TrimSpace(configDirectory) != ""
	if configDirectoryProvided {
		config, err := filepath.Abs(configDirectory)
		if err != nil {
			return nil, fmt.Errorf("config directory: %w", err)
		}
		config, err = filepath.EvalSymlinks(config)
		if err != nil {
			return nil, fmt.Errorf("config directory: %w", err)
		}
		c.configDir = config
	}
	basenames := map[string]string{}
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
				Transport  string `json:"transport"`
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
			if declared.Transport != "" && declared.Transport != "persistent" {
				return nil, fmt.Errorf("%s: transport %s is not supported", file, declared.Transport)
			}
			if declared.Transport == "persistent" && !configDirectoryProvided {
				return nil, fmt.Errorf("%s: persistent transport requires a config directory", file)
			}
			if declared.Transport == "persistent" {
				base := path.Base(declared.Executable)
				if other, exists := basenames[base]; exists {
					return nil, fmt.Errorf("%s: executable basename %s is already used by %s", file, base, other)
				}
				basenames[base] = name
			}
			c.declared[name] = filepath.Join(directory, path.Base(declared.Executable))
			if declared.Transport == "persistent" {
				c.persistent[name] = true
			}
		}
	}
	return c, nil
}

// Send 는 owner 창의 표면 surface 에서 온 body 를 사이드카 name 에 전달한다.
// 뮤텍스 밖에서 직렬화하고 논블로킹 채널로 전송하므로, 사이드카가 느려도 다른 전송을 차단하지 않는다.
func (c *Sidecars) Send(owner SidecarOwner, name, surface string, body json.RawMessage) error {
	c.mu.Lock()
	root, known := c.roots[surface]
	c.mu.Unlock()
	if !known {
		root = owner.ProjectRoot()
	}
	// JSON 직렬화는 뮤텍스 밖에서 한다.
	line, err := json.Marshal(sidecarRequest{Surface: surface, Root: root, Body: body})
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
	if _, ok := c.roots[surface]; !ok {
		c.roots[surface] = root
	}

	// 논블로킹으로 채널에 전송한다. 채널이 가득 차면 "is not keeping up" 오류를 반환한다.
	select {
	case process.outbox <- line:
		return nil
	default:
		return fmt.Errorf("sidecar %s is not keeping up", name)
	}
}

// SendResponse는 사이드카에 응답(이미지 반납 등)을 전달한다.
// 채널이 가득 차면 immutable 응답을 순서대로 버퍼링했다가 쓰기 스레드가 전송한다.
func (c *Sidecars) SendResponse(name, surface, image string, body json.RawMessage) error {
	// 먼저 뮤텍스 밖에서 JSON 직렬화한다.
	type response struct {
		Surface string          `json:"surface"`
		Body    json.RawMessage `json:"body"`
	}
	line, err := json.Marshal(response{Surface: surface, Body: body})
	if err != nil {
		return fmt.Errorf("sidecar %s: response serialize: %w", name, err)
	}
	line = append(line, '\n')

	c.mu.Lock()
	defer c.mu.Unlock()
	if c.stopped {
		return fmt.Errorf("sidecars are stopped")
	}
	process, ok := c.running[name]
	if !ok {
		return fmt.Errorf("sidecar %s is not running", name)
	}
	select {
	case <-process.exited:
		return fmt.Errorf("sidecar %s response channel is disconnected", name)
	default:
	}

	// 논블로킹으로 채널에 전송한다. 채널이 가득 차면 버퍼링한다.
	select {
	case process.outbox <- line:
		return nil
	default:
		// 채널이 가득 찼으므로 immutable 응답을 순서대로 보관한다.
		responseKey := surface + ":" + image + ":" + string(body)
		process.muClosed.Lock()
		process.pendingReplies = append(process.pendingReplies, line)
		process.muClosed.Unlock()
		log.Printf("sidecar %s: response queue full, buffering %s", name, responseKey)
		return nil
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
	root := c.roots[surface]
	delete(c.roots, surface)

	line, err := json.Marshal(sidecarRequest{Surface: surface, Root: root, Closed: true})
	if err != nil {
		log.Printf("sidecar close %s: marshal: %v", surface, err)
		return
	}
	line = append(line, '\n')

	for _, process := range c.running {
		// 논블로킹으로 채널에 전송한다. 채널이 가득 차면 pendingCloses에 저장한다.
		select {
		case process.outbox <- line:
		default:
			// 채널이 가득 찼으므로 닫힘 메시지를 전송 순서대로 보관한다.
			process.muClosed.Lock()
			process.pendingCloses = append(process.pendingCloses, line)
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
		if !process.persistent {
			close(process.outbox)
		}
	}

	// 모든 프로세스를 병렬로 기다린다. 기한을 넘기면 kill하고 exited 채널을 기다린다.
	ctx, cancel := context.WithTimeout(context.Background(), c.StopTimeout)
	defer cancel()

	var wg sync.WaitGroup
	for _, process := range processes {
		wg.Add(1)
		go func(p *sidecar) {
			defer wg.Done()
			if p.persistent {
				if err := c.closePersistentOwner(p, ctx); err != nil {
					log.Printf("sidecar %s: close owner: %v", p.name, err)
				}
				return
			}
			// read() 고루틴이 종료되면 process.exited 채널이 닫힌다.
			select {
			case <-p.exited:
				// 프로세스가 정상 종료됨.
			case <-ctx.Done():
				// 기한 초과. 강제 종료.
				if err := p.cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
					log.Printf("sidecar %s: kill: %v", p.name, err)
				}
				// read() 고루틴이 종료될 때까지 기다린다.
				<-p.exited
			}
		}(process)
	}
	wg.Wait()
}

func (c *Sidecars) closePersistentOwner(process *sidecar, ctx context.Context) error {
	request := fmt.Sprintf("%d", atomic.AddUint64(&c.nextRequest, 1))
	waiter := make(chan error, 1)
	defer func() {
		c.mu.Lock()
		delete(process.closeWaiters, request)
		c.mu.Unlock()
	}()
	c.mu.Lock()
	process.closeWaiters[request] = waiter
	c.mu.Unlock()
	line, err := json.Marshal(map[string]string{"operation": "close-owner", "request": request})
	if err != nil {
		return err
	}
	line = append(line, '\n')
	select {
	case process.outbox <- line:
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case err := <-waiter:
		if err != nil {
			process.conn.Close()
			close(process.outbox)
			return err
		}
		shutdown := fmt.Sprintf("%d", atomic.AddUint64(&c.nextRequest, 1))
		shutdownWaiter := make(chan error, 1)
		c.mu.Lock()
		process.closeWaiters[shutdown] = shutdownWaiter
		c.mu.Unlock()
		shutdownLine, marshalErr := json.Marshal(map[string]string{"operation": "shutdown", "request": shutdown})
		if marshalErr != nil {
			return marshalErr
		}
		shutdownLine = append(shutdownLine, '\n')
		select {
		case process.outbox <- shutdownLine:
		case <-ctx.Done():
			return ctx.Err()
		}
		select {
		case shutdownErr := <-shutdownWaiter:
			process.conn.Close()
			close(process.outbox)
			return shutdownErr
		case <-ctx.Done():
			process.conn.Close()
			close(process.outbox)
			return ctx.Err()
		}
	case <-ctx.Done():
		process.conn.Close()
		close(process.outbox)
		return ctx.Err()
	}
}

// process 는 실행 중인 사이드카를 반환하고, 없으면 실행한다. c.mu 를 잡은 상태로 호출한다.
func (c *Sidecars) process(name string) (*sidecar, error) {
	if process, ok := c.running[name]; ok {
		return process, nil
	}
	if c.persistent[name] {
		return c.processPersistent(name)
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
		outbox:         make(chan []byte, 256),
		exited:         make(chan struct{}),
		pendingCloses:  make([][]byte, 0),
		pendingReplies: make([][]byte, 0),
		closeWaiters:   make(map[string]chan error),
	}
	c.running[name] = process
	go c.write(process)        // 쓰기 고루틴: outbox 채널에서 읽어 stdin 에 쓴다.
	go c.read(process, stdout) // 읽기 고루틴: stdout 에서 읽어 이벤트를 전달한다.
	return process, nil
}

type persistentEndpoint struct {
	Protocol uint64 `json:"protocol"`
	PID      int    `json:"pid"`
	Socket   string `json:"socket"`
	Token    string `json:"token"`
}

func (c *Sidecars) processPersistent(name string) (*sidecar, error) {
	program := c.declared[name]
	serviceDir := filepath.Join(c.configDir, "services", filepath.Base(program))
	if err := os.MkdirAll(serviceDir, 0o700); err != nil {
		return nil, fmt.Errorf("sidecar %s: create service directory: %w", name, err)
	}
	if err := os.Chmod(serviceDir, 0o700); err != nil {
		return nil, fmt.Errorf("sidecar %s: secure service directory: %w", name, err)
	}
	endpointPath := filepath.Join(serviceDir, "endpoint.json")
	var endpoint persistentEndpoint
	var cmd *exec.Cmd
	if data, err := os.ReadFile(endpointPath); err == nil {
		if err := json.Unmarshal(data, &endpoint); err != nil {
			return nil, fmt.Errorf("sidecar %s: invalid endpoint: %w", name, err)
		}
	} else if errors.Is(err, os.ErrNotExist) {
		cmd = exec.Command(program, "--service-dir", serviceDir)
		// A persistent service belongs to the configuration directory, not to
		// the lifetime of this application process. Start a new session so an
		// application crash cannot take the recovery service down with it.
		cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
		cmd.Stdin = nil
		cmd.Stderr = os.Stderr
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			return nil, fmt.Errorf("sidecar %s: service stdout: %w", name, err)
		}
		if err := cmd.Start(); err != nil {
			return nil, fmt.Errorf("sidecar %s: %w", name, err)
		}
		line, err := bufio.NewReader(stdout).ReadBytes('\n')
		if err != nil {
			return nil, fmt.Errorf("sidecar %s: service startup: %w", name, err)
		}
		if err := json.Unmarshal(line, &endpoint); err != nil || endpoint.Protocol == 0 {
			var failure struct {
				Error    string              `json:"error"`
				Endpoint *persistentEndpoint `json:"endpoint"`
			}
			if json.Unmarshal(line, &failure) == nil && failure.Error != "" && failure.Endpoint != nil {
				endpoint = *failure.Endpoint
			} else {
				if err == nil {
					err = errors.New("endpoint is incomplete")
				}
				return nil, fmt.Errorf("sidecar %s: service endpoint: %w", name, err)
			}
		}
	} else {
		return nil, fmt.Errorf("sidecar %s: read endpoint: %w", name, err)
	}
	current, err := platform.Current()
	if err != nil {
		return nil, err
	}
	if !current.ServiceProcessExists(endpoint.PID) {
		if err := os.Remove(endpointPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("sidecar %s: remove stale endpoint: %w", name, err)
		}
		// The endpoint was left by a crashed service. Remove only this proven
		// stale record, then enter the normal single creation path.
		return c.processPersistent(name)
	}
	if endpoint.Protocol != 1 {
		return nil, fmt.Errorf("sidecar %s: service protocol %d is not supported", name, endpoint.Protocol)
	}
	if endpoint.PID == 0 || endpoint.Socket == "" || endpoint.Token == "" {
		return nil, fmt.Errorf("sidecar %s: service endpoint is incomplete", name)
	}
	conn, err := net.Dial("unix", endpoint.Socket)
	if err != nil {
		return nil, fmt.Errorf("sidecar %s: connect authenticated service: %w", name, err)
	}
	reader := bufio.NewReader(conn)
	hello, err := json.Marshal(map[string]any{"operation": "hello", "protocol": 1, "token": endpoint.Token, "client": c.configDir})
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("sidecar %s: encode hello: %w", name, err)
	}
	hello = append(hello, '\n')
	if _, err := conn.Write(hello); err != nil {
		conn.Close()
		return nil, fmt.Errorf("sidecar %s: hello: %w", name, err)
	}
	responseLine, err := reader.ReadBytes('\n')
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("sidecar %s: hello response: %w", name, err)
	}
	var response struct {
		Operation string  `json:"operation"`
		Protocol  *uint64 `json:"protocol"`
		OK        bool    `json:"ok"`
		Error     string  `json:"error"`
	}
	if err := json.Unmarshal(responseLine, &response); err != nil || response.Operation != "hello" {
		conn.Close()
		return nil, fmt.Errorf("sidecar %s: authentication handshake failed: invalid hello response", name)
	}
	if !response.OK {
		conn.Close()
		if response.Error == "" {
			response.Error = "authentication failed"
		}
		return nil, fmt.Errorf("sidecar %s: authentication handshake failed: %s", name, response.Error)
	}
	if response.Protocol == nil || *response.Protocol != 1 {
		conn.Close()
		return nil, fmt.Errorf("sidecar %s: service protocol mismatch in hello response", name)
	}
	process := &sidecar{
		name: name, cmd: cmd, conn: conn, persistent: true,
		outbox: make(chan []byte, 256), exited: make(chan struct{}),
		pendingCloses: make([][]byte, 0), pendingReplies: make([][]byte, 0),
		closeWaiters: make(map[string]chan error),
	}
	c.running[name] = process
	go c.writePersistent(process)
	go c.readPersistent(process, reader)
	return process, nil
}

// write 는 큐를 먼저 비우고, 큐가 비면 보관분을 쓰고, 그다음 큐를 기다린다.
// 보관분은 큐가 가득 찬 뒤에 생기므로 큐에 먼저 들어간 메시지보다 뒤에 나가야 한다.
// 큐가 닫히면 보관분까지 쓴 뒤 stdin 을 닫는다.
func (c *Sidecars) write(process *sidecar) {
	defer func() {
		if err := process.stdin.Close(); err != nil {
			log.Printf("sidecar %s: close stdin: %v", process.name, err)
		}
	}()
	for {
		// ① 채널에 있는 모든 메시지를 비블로킹으로 쓴다 (default 가 있는 select).
		for drained := false; !drained; {
			select {
			case line, ok := <-process.outbox:
				if !ok {
					// 채널이 닫혔다. 보관분을 모두 쓴 뒤 종료한다.
					c.writePending(process)
					return
				}
				if !c.writeLine(process, line) {
					return
				}
			default:
				drained = true
			}
		}

		// ② 큐가 비었으면 보관분을 모두 쓴다.
		if !c.writePending(process) {
			return
		}

		// ③ 이제 채널에서 다음 건을 기다린다 (블로킹).
		line, ok := <-process.outbox
		if !ok {
			// 채널이 닫혔다. 보관분을 모두 쓴 뒤 종료한다.
			c.writePending(process)
			return
		}
		if !c.writeLine(process, line) {
			return
		}
	}
}

func (c *Sidecars) writePersistent(process *sidecar) {
	for {
		for drained := false; !drained; {
			select {
			case line, ok := <-process.outbox:
				if !ok {
					c.writePersistentPending(process)
					return
				}
				if !c.writePersistentLine(process, line) {
					return
				}
			default:
				drained = true
			}
		}
		if !c.writePersistentPending(process) {
			return
		}
		line, ok := <-process.outbox
		if !ok {
			c.writePersistentPending(process)
			return
		}
		if !c.writePersistentLine(process, line) {
			return
		}
	}
}

func (c *Sidecars) writePersistentLine(process *sidecar, line []byte) bool {
	if _, err := process.conn.Write(line); err != nil {
		log.Printf("sidecar %s: write: %v", process.name, err)
		return false
	}
	return true
}

func (c *Sidecars) writePersistentPending(process *sidecar) bool {
	process.muClosed.Lock()
	replies, closes := process.pendingReplies, process.pendingCloses
	process.pendingReplies, process.pendingCloses = nil, nil
	process.muClosed.Unlock()
	for _, line := range replies {
		if !c.writePersistentLine(process, line) {
			return false
		}
	}
	for _, line := range closes {
		if !c.writePersistentLine(process, line) {
			return false
		}
	}
	return true
}

func (c *Sidecars) writeLine(process *sidecar, line []byte) bool {
	if _, err := process.stdin.Write(line); err != nil {
		log.Printf("sidecar %s: write: %v", process.name, err)
		return false
	}
	return true
}

// writePending 은 보관분을 한꺼번에 가져와 반납 먼저, 닫힘 나중으로 쓴다.
func (c *Sidecars) writePending(process *sidecar) bool {
	process.muClosed.Lock()
	replies, closes := process.pendingReplies, process.pendingCloses
	process.pendingReplies, process.pendingCloses = nil, nil
	process.muClosed.Unlock()
	for _, line := range replies {
		if !c.writeLine(process, line) {
			return false
		}
	}
	for _, line := range closes {
		if !c.writeLine(process, line) {
			return false
		}
	}
	return true
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

func (c *Sidecars) readPersistent(process *sidecar, reader *bufio.Reader) {
	for {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			break
		}
		var value map[string]json.RawMessage
		if err := json.Unmarshal(line, &value); err != nil {
			log.Printf("sidecar %s: invalid persistent event: %v", process.name, err)
			break
		}
		var operation string
		if raw, present := value["operation"]; present {
			if err := json.Unmarshal(raw, &operation); err != nil {
				log.Printf("sidecar %s: invalid persistent operation: %v", process.name, err)
				break
			}
		}
		if operation == "closed-owner" || operation == "shutdown" {
			var request string
			if err := json.Unmarshal(value["request"], &request); err != nil || request == "" {
				log.Printf("sidecar %s: invalid close-owner request: %v", process.name, err)
				break
			}
			var ok bool
			if err := json.Unmarshal(value["ok"], &ok); err != nil {
				log.Printf("sidecar %s: invalid close-owner status: %v", process.name, err)
				break
			}
			var reason string
			if raw, present := value["error"]; present {
				if err := json.Unmarshal(raw, &reason); err != nil {
					log.Printf("sidecar %s: invalid close-owner error: %v", process.name, err)
					break
				}
			}
			c.mu.Lock()
			waiter := process.closeWaiters[request]
			delete(process.closeWaiters, request)
			c.mu.Unlock()
			if waiter != nil {
				if ok {
					waiter <- nil
				} else if reason == "" {
					waiter <- errors.New("close-owner failed")
				} else {
					waiter <- errors.New(reason)
				}
			}
			continue
		}
		var event sidecarEvent
		if err := json.Unmarshal(line, &event); err != nil {
			log.Printf("sidecar %s: invalid persistent event: %v", process.name, err)
			continue
		}
		c.mu.Lock()
		owner := c.owners[event.Surface]
		c.mu.Unlock()
		if owner != nil {
			if c.tryHandleImageEnvelope(owner, process.name, event.Surface, event.Body) {
				continue
			}
			owner.Emit("sidecar-message", SidecarMessage{Sidecar: process.name, Surface: event.Surface, Body: event.Body})
		}
	}
	process.conn.Close()
	c.mu.Lock()
	waiters := make([]chan error, 0, len(process.closeWaiters))
	for request, waiter := range process.closeWaiters {
		delete(process.closeWaiters, request)
		waiters = append(waiters, waiter)
	}
	if c.running[process.name] == process {
		delete(c.running, process.name)
	}
	c.mu.Unlock()
	for _, waiter := range waiters {
		waiter <- errors.New("persistent service disconnected before close-owner ack")
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
