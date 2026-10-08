// 사이드카 채널.
//
// 플러그인이 plugin.json 에 의존성으로 선언한 사이드카를 처음 사용할 때 실행하고,
// 표면 페이지와 사이드카 사이에서 한 줄 JSON 메시지를 전달한다. 메시지 본문은 해석하지
// 않는다. 형식은 docs/spec/sidecars.md 에 정의한다.
//
// 사이드카는 스테이징된 설정 파일로만 찾는다.
//
//	environment.json                  plugins: plugins
//	modules/<플러그인>/plugin.json     sidecars: sidecars
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
	"log"
	"net"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
)

// SidecarMessage 는 사이드카가 보낸 메시지를 페이지에 전달하는 이벤트 값이다.
type SidecarMessage struct {
	Sidecar string          `json:"sidecar"`
	Surface string          `json:"surface"`
	Body    json.RawMessage `json:"body"`
}

// SidecarFailure 는 사이드카 실패를 그 사이드카에 보낸 표면의 페이지에 알리는 이벤트 값이다
// (docs/spec/sidecars.md#failure).
type SidecarFailure struct {
	Sidecar string `json:"sidecar"`
	Surface string `json:"surface"`
	Reason  string `json:"reason"`
}

// sidecarMessageLimit 는 사이드카 메시지 한 줄의 줄바꿈 앞 최대 byte 수다(docs/spec/sidecars.md#messages).
// 수 MB 의 schema snapshot 을 열 배 이상의 여유로 담고, 메시지 하나에 잡는 메모리를 이 크기로 제한한다.
const sidecarMessageLimit = 64 << 20

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

// sidecarOutput 은 표준 출력 메시지의 선언된 형태다. 빠진 surface 를 빈 문자열과 구별한다. closed 가 있으면
// closed 에 대한 응답이고 error 는 닫지 못한 까닭이다(docs/spec/sidecars.md#messages).
type sidecarOutput struct {
	Surface *string         `json:"surface"`
	Body    json.RawMessage `json:"body"`
	Closed  *bool           `json:"closed"`
	Error   *string         `json:"error"`
}

// ClosingSurface 는 호스트가 closed 를 보냈고 사이드카가 아직 답하지 않은 표면이다(host.sidecars).
type ClosingSurface struct {
	Sidecar string `json:"sidecar"`
	Surface string `json:"surface"`
}

type sidecar struct {
	name string
	// version is the version that a persistent service sent in its hello reply, or nil when the reply had none.
	version       *string
	cmd           *exec.Cmd
	stdin         io.WriteCloser
	conn          net.Conn
	persistent    bool
	outbox        chan []byte
	exited        chan struct{}
	muClosed      sync.Mutex
	pendingCloses [][]byte // 대기 중인 closed 메시지이며, 전송 순서를 따른다
	// pendingReplies 는 채널이 가득 찬 경우 immutable image ack를 버퍼링한다.
	// 각 항목을 보존하여 sequence가 다른 응답을 덮어쓰지 않는다.
	pendingReplies [][]byte
	closeWaiters   map[string]chan error
	// retained 는 retain 요청마다 서비스가 닫은 세션 수다.
	retained map[string]int
	// surfaces 는 이 프로세스에 요청을 보낸 표면이다. 실패를 알릴 표면이다. c.mu 로 보호한다.
	surfaces map[string]bool
	// stopClosing 은 Stop 이 closing 목록에서 뺀 이 프로세스의 닫기다. 표준 입출력 사이드카는 끝나면서 이 닫기에
	// 답하므로 그 답은 실패가 아니다(docs/spec/sidecars.md#messages). c.mu 로 보호한다.
	stopClosing map[string]int
	// violated 와 waitErr 는 멈추는 동안 read 가 기록하고 exited 를 닫는다. Stop 은 exited 뒤에 읽는다.
	// violated 는 프로토콜 위반으로 읽기를 멈춘 것이고, waitErr 는 프로세스를 기다린 결과다.
	violated bool
	waitErr  error
	// begin 은 등록된 프로세스의 쓰기와 읽기 고루틴을 시작한다.
	begin func()
}

// SidecarOwner 는 표면을 소유한 창이다. 사이드카 메시지의 root 를 제공하고 이벤트를 받는다.
type SidecarOwner interface {
	ProjectRoot() string
	Emit(name string, data ...any)
}

// Sidecars 는 애플리케이션 하나의 사이드카 프로세스와 표면 소유 창을 관리한다.
type Sidecars struct {
	mu sync.Mutex
	// declarations 는 declared, persistent, basenames 를 보호한다. 설치가 실행 중에 선언을 더하고 시작은 c.mu 밖에서
	// 실행 파일을 읽으므로 c.mu 와 따로 둔다.
	declarations sync.RWMutex
	declared     map[string]string
	// versions holds the version that installed.json records for each declared sidecar.
	versions   map[string]string
	persistent map[string]bool
	running    map[string]*sidecar
	// starting 은 시작 중인 사이드카다. 시작은 잠금 밖에서 하며, 끝나면 그 채널을 닫는다.
	starting map[string]chan struct{}
	// closing holds, for each sidecar, the surfaces whose closed was sent and not answered, with the number of those
	// closes. A surface closed again before the answer receives one answer per close.
	closing map[string]map[string]int
	// ClosingChanged 는 closing 이 바뀐 뒤 잠금 밖에서 호출된다. 호스트가 host.sidecars 를 알린다.
	ClosingChanged func()
	owners         map[string]SidecarOwner
	// roots 는 표면을 처음 보낼 때의 프로젝트 디렉터리다. 사이드카는 root 와 표면으로 세션을 찾으므로,
	// 창의 프로젝트가 바뀐 뒤에도 이미 열린 표면의 요청과 닫힘은 이 root 로 보낸다.
	roots   map[string]string
	stopped bool
	// unannouncedLoss 는 연결이 끊겼고 아직 소유 표면에 알리지 않은 영속 사이드카다(V5-106).
	// 끊김을 알린 시작이 이 기록을 소진한다 — 첫 시작은 알림이 없다.
	unannouncedLoss map[string]bool
	// basenames 는 영속 sidecar 실행 파일의 basename 과 그 sidecar 이름이다.
	basenames   map[string]string
	StopTimeout time.Duration // 테스트에서 주입 가능한 Stop() 기한. 기본값 5초.
	// ReadyTimeout 은 새로 시작한 영속 service 가 endpoint 를 출력하기까지의 상한이다. 기본값 30초. 테스트가 주입한다.
	ReadyTimeout time.Duration
	// RetainSending 은 Retain 이 서비스를 준비한 뒤 retain 을 보내기 전에 서비스 이름으로 호출된다. 검사가 그 사이에
	// 다른 작업을 끼워 넣는 지점이며, nil 이면 호출하지 않는다.
	RetainSending func(name string)
	configDir     string
	nextRequest   uint64
}

// SidecarDeclaration 은 설치된 sidecar 하나다. Data 는 그 sidecar.json 의 내용이고 Folder 는 그것을 담은 폴더다.
type SidecarDeclaration struct {
	Name   string
	Folder string
	Data   []byte
	// Version is the version that installed.json records for the sidecar.
	Version string
}

// OutdatedSidecar is a persistent sidecar whose running service has another version than the installed one
// (docs/spec/terminal-runtime.md#updates). Running is nil when the service sent no version; Sessions counts the open
// surfaces of the application that have sent to the service.
type OutdatedSidecar struct {
	Sidecar   string  `json:"sidecar"`
	Running   *string `json:"running"`
	Installed string  `json:"installed"`
	Sessions  int     `json:"sessions"`
}

// NewSidecars 는 선언된 sidecar 로 채널을 생성한다. 실행 파일은 각 Folder 안의 executable 경로다. 선언의 형식이
// 틀리면 실패한다.
func NewSidecars(declarations []SidecarDeclaration, configDirectory string) (*Sidecars, error) {
	c := &Sidecars{
		declared:        map[string]string{},
		versions:        map[string]string{},
		persistent:      map[string]bool{},
		running:         map[string]*sidecar{},
		starting:        map[string]chan struct{}{},
		closing:         map[string]map[string]int{},
		owners:          map[string]SidecarOwner{},
		roots:           map[string]string{},
		unannouncedLoss: map[string]bool{},
		basenames:       map[string]string{},
		StopTimeout:     5 * time.Second,
		ReadyTimeout:    30 * time.Second,
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
	if err := c.Declare(declarations); err != nil {
		return nil, err
	}
	return c, nil
}

// Declare declares the installed sidecars (docs/spec/installation.md#applying-a-change). The running process of a
// standard input and output sidecar whose executable changed or that is no longer declared stops by the stop rules, so
// the next Send starts the new executable. A persistent service uses the new executable from its next start. An
// invalid declaration fails without a change.
func (c *Sidecars) Declare(declarations []SidecarDeclaration) error {
	changed, err := c.declare(declarations)
	if err != nil {
		return err
	}
	c.mu.Lock()
	// A sidecar that is starting registers when its start ends, so the start is awaited before the running list is
	// read.
	for {
		var wait chan struct{}
		for _, name := range changed {
			if starting := c.starting[name]; starting != nil {
				wait = starting
				break
			}
		}
		if wait == nil {
			break
		}
		c.mu.Unlock()
		<-wait
		c.mu.Lock()
	}
	processes := make([]*sidecar, 0, len(changed))
	forgot := false
	for _, name := range changed {
		if process := c.running[name]; process != nil && !process.persistent {
			forgot = c.detach(name, process) || forgot
			processes = append(processes, process)
		}
	}
	c.mu.Unlock()
	if forgot {
		c.closingChanged()
	}
	c.stopProcesses(processes)
	return nil
}

// declare replaces the declarations with declarations and returns the declared sidecars whose executable changed or
// that are no longer declared. Nothing changes when a declaration is invalid.
func (c *Sidecars) declare(declarations []SidecarDeclaration) ([]string, error) {
	c.declarations.Lock()
	defer c.declarations.Unlock()
	declared := map[string]string{}
	versions := map[string]string{}
	persistent := map[string]bool{}
	basenames := map[string]string{}
	for _, item := range declarations {
		name := item.Name
		file := filepath.Join(item.Folder, "sidecar.json")
		var sidecar struct {
			Executable string `json:"executable"`
			Protocol   int    `json:"protocol"`
			Transport  string `json:"transport"`
		}
		if err := json.Unmarshal(item.Data, &sidecar); err != nil {
			return nil, fmt.Errorf("%s: %w", file, err)
		}
		if sidecar.Executable == "" || path.IsAbs(sidecar.Executable) ||
			strings.Contains("/"+sidecar.Executable+"/", "/../") {
			return nil, fmt.Errorf("%s: executable must be a path inside the package", file)
		}
		if sidecar.Protocol != 1 {
			return nil, fmt.Errorf("%s: protocol must be 1", file)
		}
		if sidecar.Transport != "" && sidecar.Transport != "persistent" {
			return nil, fmt.Errorf("%s: transport %s is not supported", file, sidecar.Transport)
		}
		if sidecar.Transport == "persistent" && c.configDir == "" {
			return nil, fmt.Errorf("%s: persistent transport requires a config directory", file)
		}
		if sidecar.Transport == "persistent" {
			base := path.Base(sidecar.Executable)
			if other, exists := basenames[base]; exists {
				return nil, fmt.Errorf("%s: executable basename %s is already used by %s", file, base, other)
			}
			basenames[base] = name
			persistent[name] = true
		}
		declared[name] = filepath.Join(item.Folder, filepath.FromSlash(sidecar.Executable))
		versions[name] = item.Version
	}
	changed := []string{}
	for name, program := range c.declared {
		if declared[name] != program {
			changed = append(changed, name)
		}
	}
	c.declared, c.versions, c.persistent, c.basenames = declared, versions, persistent, basenames
	return changed, nil
}

// declaration 은 선언된 sidecar name 의 실행 파일과 영속 여부를 돌려준다. c.mu 와 무관하게 부를 수 있다.
func (c *Sidecars) declaration(name string) (program string, persistent, ok bool) {
	c.declarations.RLock()
	defer c.declarations.RUnlock()
	program, ok = c.declared[name]
	return program, c.persistent[name], ok
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

	// 이 전송이 끊김 뒤의 첫 시작이면 잠금 해제 뒤에 연결 알림을 보낸다(V5-106).
	// 알림은 소유자 그림 재구성을 되부르므로 뮤텍스 안에서 실행할 수 없다.
	var reconnected bool
	defer func() {
		if reconnected {
			c.notifyConnection(name, nil)
		}
	}()
	// A new surface or a new service of an outdated sidecar changes host.sidecars, which is announced after the unlock.
	var outdatedChanged bool
	defer func() {
		if outdatedChanged {
			c.closingChanged()
		}
	}()
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.stopped {
		return fmt.Errorf("sidecars are stopped")
	}
	if _, _, ok := c.declaration(name); !ok {
		return fmt.Errorf("sidecar %s is not declared by any plugin", name)
	}
	if other, ok := c.owners[surface]; ok && other != owner {
		return fmt.Errorf("surface %s belongs to another window", surface)
	}
	process, started, err := c.process(name)
	if err != nil {
		return err
	}
	if started {
		reconnected = c.unannouncedLoss[name]
		delete(c.unannouncedLoss, name)
	}
	// 시작하는 동안 잠금을 놓았으므로 표면의 소유자를 다시 확인한다.
	if other, ok := c.owners[surface]; ok && other != owner {
		return fmt.Errorf("surface %s belongs to another window", surface)
	}
	outdatedChanged = (started || !process.surfaces[surface]) && c.outdated(process)
	process.surfaces[surface] = true
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
	if c.closeSurface(surface) {
		c.closingChanged()
	}
}

// closeSurface 는 surface 의 closed 를 실행 중인 사이드카에 보내고, 응답을 기다리는 표면을 기록했으면 true 를 반환한다.
func (c *Sidecars) closeSurface(surface string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.owners[surface]; !ok {
		return false
	}
	delete(c.owners, surface)
	root := c.roots[surface]
	delete(c.roots, surface)

	line, err := json.Marshal(sidecarRequest{Surface: surface, Root: root, Closed: true})
	if err != nil {
		LogError("sidecar close "+surface, fmt.Sprintf("marshal: %v", err))
		return false
	}
	line = append(line, '\n')

	for _, process := range c.running {
		if c.closing[process.name] == nil {
			c.closing[process.name] = map[string]int{}
		}
		c.closing[process.name][surface]++
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
	return len(c.running) > 0
}

// Closing 은 closed 를 보냈고 답을 받지 않은 표면을 사이드카와 표면 순으로 반환한다(host.sidecars).
func (c *Sidecars) Closing() []ClosingSurface {
	c.mu.Lock()
	defer c.mu.Unlock()
	list := []ClosingSurface{}
	for sidecar, surfaces := range c.closing {
		for surface := range surfaces {
			list = append(list, ClosingSurface{Sidecar: sidecar, Surface: surface})
		}
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].Sidecar != list[j].Sidecar {
			return list[i].Sidecar < list[j].Sidecar
		}
		return list[i].Surface < list[j].Surface
	})
	return list
}

// Outdated returns the persistent sidecars whose running service has another version than the installed one, sorted by
// sidecar (host.sidecars, docs/spec/terminal-runtime.md#updates).
func (c *Sidecars) Outdated() []OutdatedSidecar {
	c.mu.Lock()
	defer c.mu.Unlock()
	list := []OutdatedSidecar{}
	for name, process := range c.running {
		if !c.outdated(process) {
			continue
		}
		sessions := 0
		for surface := range process.surfaces {
			if c.owners[surface] != nil {
				sessions++
			}
		}
		c.declarations.RLock()
		installed := c.versions[name]
		c.declarations.RUnlock()
		list = append(list, OutdatedSidecar{Sidecar: name, Running: process.version, Installed: installed, Sessions: sessions})
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Sidecar < list[j].Sidecar })
	return list
}

// outdated reports whether process is a persistent service whose version differs from the installed version of its
// sidecar. A service that sent no version is of an earlier version. It is called with c.mu held.
func (c *Sidecars) outdated(process *sidecar) bool {
	if !process.persistent {
		return false
	}
	c.declarations.RLock()
	installed := c.versions[process.name]
	c.declarations.RUnlock()
	return process.version == nil || *process.version != installed
}

// closingChanged 는 closing 이 바뀐 것을 알린다. 잠금 밖에서 호출한다.
func (c *Sidecars) closingChanged() {
	if c.ClosingChanged != nil {
		c.ClosingChanged()
	}
}

// closeAnswered 는 사이드카 process 가 surface 의 closed 에 답한 것을 기록한다. 그 표면을 닫고 있지 않았고 Stop 이
// 목록에서 뺀 닫기도 아니면 프로토콜 위반의 까닭을 반환한다. 닫지 못한 까닭은 로그에 쓴다. 잠금 밖에서 호출한다.
func (c *Sidecars) closeAnswered(process *sidecar, surface string, closed bool, failure *string) string {
	if !closed {
		return "invalid message: closed is not true"
	}
	name := process.name
	c.mu.Lock()
	pending := take(c.closing[name], surface)
	if len(c.closing[name]) == 0 {
		delete(c.closing, name)
	}
	stopped := !pending && take(process.stopClosing, surface)
	c.mu.Unlock()
	if !pending && !stopped {
		return "unexpected close answer for " + surface
	}
	if failure != nil {
		LogError("sidecar "+name, fmt.Sprintf("close %s: %s", surface, *failure))
	}
	if pending {
		c.closingChanged()
	}
	return ""
}

// take lowers the count of key in counts by one and returns true when it did; a key whose count reaches 0 is removed.
func take(counts map[string]int, key string) bool {
	if counts[key] == 0 {
		return false
	}
	counts[key]--
	if counts[key] == 0 {
		delete(counts, key)
	}
	return true
}

// forgetClosing 는 끝난 프로세스나 끊긴 연결의 사이드카 name 이 답하지 않은 닫기를 지운다. c.mu 를 쥔 채 호출하며,
// 지웠으면 true 를 반환한다.
func (c *Sidecars) forgetClosing(name string) bool {
	if len(c.closing[name]) == 0 {
		return false
	}
	delete(c.closing, name)
	return true
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
	// 시작 중인 사이드카는 끝나면 등록되므로, 그 시작을 기다린 뒤 실행 중인 목록을 읽는다.
	for len(c.starting) > 0 {
		var wait chan struct{}
		for _, starting := range c.starting {
			wait = starting
			break
		}
		c.mu.Unlock()
		<-wait
		c.mu.Lock()
	}
	// outbox 로의 전송은 잠금 안에서 실행 목록에 있는 사이드카에만 일어난다. 채널을 닫기 전에 목록에서 빼므로,
	// 종료 중에 닫히는 창의 표면 닫기는 아무것도 보내지 않는다. 표준 입출력 사이드카는 끝나므로 닫기에 답하지
	// 않는다. 지속 service 는 중지 전에 보낸 닫기에 close-owner 응답보다 먼저 답하므로 그 표면은 답이나 연결의
	// 끝까지 둔다(docs/spec/sidecars.md#messages).
	processes := make([]*sidecar, 0, len(c.running))
	forgot := false
	for name, process := range c.running {
		processes = append(processes, process)
		forgot = c.detach(name, process) || forgot
	}
	c.mu.Unlock()
	if forgot {
		c.closingChanged()
	}
	c.stopProcesses(processes)
}

// detach removes a process that stops from the running list. A standard input and output sidecar ends, so its
// unanswered closes move to stopClosing. It is called with c.mu held and returns true when closing changed.
func (c *Sidecars) detach(name string, process *sidecar) bool {
	delete(c.running, name)
	if process.persistent {
		return false
	}
	process.stopClosing = c.closing[name]
	return c.forgetClosing(name)
}

// stopProcesses stops processes, which are out of the running list, by the stop rules and waits until they end
// (docs/spec/sidecars.md#declaration-and-startup).
func (c *Sidecars) stopProcesses(processes []*sidecar) {
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
					LogError("sidecar "+p.name, fmt.Sprintf("close owner: %v", err))
				}
				return
			}
			// read() 고루틴이 출력을 끝까지 읽고 프로세스를 기다리면 process.exited 채널이 닫힌다.
			killed := false
			select {
			case <-p.exited:
			case <-ctx.Done():
				// 기한 초과. 강제 종료.
				err := p.cmd.Process.Kill()
				killed = err == nil
				if err != nil && !errors.Is(err, os.ErrProcessDone) {
					LogError("sidecar "+p.name, fmt.Sprintf("kill: %v", err))
				}
				// read() 고루틴이 종료될 때까지 기다린다.
				<-p.exited
			}
			// 강제 종료나 위반 뒤 닫은 파이프가 일으킨 종료는 보고하지 않는다(docs/spec/sidecars.md#declaration-and-startup).
			switch {
			case killed:
				LogError("sidecar "+p.name, "did not end within the stop timeout and was killed")
			case p.violated:
			case p.waitErr != nil:
				LogError("sidecar "+p.name, "exited while stopping: "+exitStatus(p.cmd, p.waitErr))
			}
		}(process)
	}
	wg.Wait()
}

// RetainedSurface 는 retain 에 보내는 표면과 그 표면을 연 프로젝트 루트다.
type RetainedSurface struct {
	Surface string `json:"surface"`
	Root    string `json:"root"`
}

// retainTimeout 은 서비스가 retain 에 답하기를 기다리는 시간이다. 세션을 닫는 데 걸리는 시간을 포함한다.
const retainTimeout = 10 * time.Second

// Retain 은 각 영속 서비스에서 surfaces 에 없는 이 애플리케이션의 세션을 닫고, 닫은 세션 수를 반환한다.
// 이 프로세스가 이미 메시지를 보낸 표면은 목록에 없어도 남긴다. 서비스가 떠 있지 않고 엔드포인트도
// 없으면 세션이 없으므로 건너뛴다.
func (c *Sidecars) Retain(surfaces []RetainedSurface) (int, error) {
	if surfaces == nil {
		return 0, errors.New("retain requires a surfaces list")
	}
	c.mu.Lock()
	// 빈 목록도 JSON 배열로 보내도록 nil 이 아닌 슬라이스에서 시작한다.
	keep := append(make([]RetainedSurface, 0, len(surfaces)+len(c.roots)), surfaces...)
	for surface, root := range c.roots {
		keep = append(keep, RetainedSurface{Surface: surface, Root: root})
	}
	c.mu.Unlock()
	c.declarations.RLock()
	names := make([]string, 0, len(c.persistent))
	for name, persistent := range c.persistent {
		if persistent {
			names = append(names, name)
		}
	}
	c.declarations.RUnlock()
	for _, item := range keep {
		if item.Surface == "" || item.Root == "" {
			return 0, fmt.Errorf("retain surface entry is invalid: %+v", item)
		}
	}
	total := 0
	for _, name := range names {
		request := fmt.Sprintf("%d", atomic.AddUint64(&c.nextRequest, 1))
		line, err := json.Marshal(map[string]any{"operation": "retain", "request": request, "surfaces": keep})
		if err != nil {
			return total, err
		}
		line = append(line, '\n')
		waiter := make(chan error, 1)
		c.mu.Lock()
		if c.stopped {
			c.mu.Unlock()
			return total, errors.New("sidecars are stopped")
		}
		if _, running := c.running[name]; !running {
			program, _, ok := c.declaration(name)
			if !ok {
				c.mu.Unlock()
				return total, fmt.Errorf("sidecar %s is not declared by any plugin", name)
			}
			endpoint := filepath.Join(c.configDir, "services", filepath.Base(program), "endpoint.json")
			if _, err := os.Stat(endpoint); errors.Is(err, os.ErrNotExist) {
				c.mu.Unlock()
				continue
			} else if err != nil {
				c.mu.Unlock()
				return total, fmt.Errorf("sidecar %s: read endpoint: %w", name, err)
			}
		}
		if _, _, err := c.process(name); err != nil {
			c.mu.Unlock()
			return total, err
		}
		c.mu.Unlock()
		if c.RetainSending != nil {
			c.RetainSending(name)
		}
		// outbox 로의 전송은 잠금 안에서 실행 목록에 있는 사이드카에만 일어난다. 서비스를 준비한 사이 Stop 이 그 outbox 를
		// 닫았을 수 있으므로 다시 확인하고, 막히지 않게 보낸다.
		c.mu.Lock()
		if c.stopped {
			c.mu.Unlock()
			return total, errors.New("sidecars are stopped")
		}
		process, ok := c.running[name]
		if !ok {
			c.mu.Unlock()
			return total, fmt.Errorf("sidecar %s is not running", name)
		}
		process.closeWaiters[request] = waiter
		select {
		case process.outbox <- line:
		default:
			delete(process.closeWaiters, request)
			c.mu.Unlock()
			return total, fmt.Errorf("sidecar %s is not keeping up", name)
		}
		c.mu.Unlock()
		timer := time.NewTimer(retainTimeout)
		select {
		case err := <-waiter:
			timer.Stop()
			if err != nil {
				return total, fmt.Errorf("sidecar %s: retain: %w", name, err)
			}
		case <-timer.C:
			return total, fmt.Errorf("sidecar %s: retain was not answered within %s", name, retainTimeout)
		}
		c.mu.Lock()
		total += process.retained[request]
		delete(process.retained, request)
		c.mu.Unlock()
	}
	return total, nil
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
// process 는 실행 중인 사이드카를 돌려주고, 없으면 시작해서 등록한다. c.mu 를 쥔 채 부르고 쥔 채 돌아온다. 시작은
// 프로세스 기동과 영속 service 의 연결과 인증을 기다리므로 잠금을 놓은 채 한다. 그동안 다른 사이드카의 요청은
// 기다리지 않고, 같은 사이드카의 요청은 그 시작이 끝나기를 기다린다. started 는 이 호출이 시작했는지다.
func (c *Sidecars) process(name string) (process *sidecar, started bool, err error) {
	for {
		if process, ok := c.running[name]; ok {
			return process, false, nil
		}
		if c.stopped {
			return nil, false, errors.New("sidecars are stopped")
		}
		wait, ok := c.starting[name]
		if !ok {
			break
		}
		c.mu.Unlock()
		<-wait
		c.mu.Lock()
	}
	done := make(chan struct{})
	c.starting[name] = done
	c.mu.Unlock()
	process, err = c.launch(name)
	c.mu.Lock()
	delete(c.starting, name)
	close(done)
	if err != nil {
		return nil, false, err
	}
	// Stop 은 시작이 끝나기를 기다린 뒤 실행 중인 목록을 읽으므로, 멈추는 중에 끝난 시작도 등록해 Stop 이 정리한다.
	c.running[name] = process
	process.begin()
	if c.stopped {
		return nil, false, errors.New("sidecars are stopped")
	}
	return process, true, nil
}

// launch 는 사이드카 name 을 시작한다. 잠금 없이 부르며 등록하지 않는다.
func (c *Sidecars) launch(name string) (*sidecar, error) {
	program, persistent, ok := c.declaration(name)
	if !ok {
		return nil, fmt.Errorf("sidecar %s is not declared by any plugin", name)
	}
	if persistent {
		return c.processPersistent(name)
	}
	cmd := exec.Command(program)
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
		surfaces:       make(map[string]bool),
	}
	process.begin = func() {
		go c.write(process)        // 쓰기 고루틴: outbox 채널에서 읽어 stdin 에 쓴다.
		go c.read(process, stdout) // 읽기 고루틴: stdout 에서 읽어 이벤트를 전달한다.
	}
	return process, nil
}

type persistentEndpoint struct {
	Protocol uint64 `json:"protocol"`
	PID      int    `json:"pid"`
	Socket   string `json:"socket"`
	Token    string `json:"token"`
}

// helloTimeout 은 service 가 hello 에 답하기까지의 상한이다(docs/spec/terminal-runtime.md).
const helloTimeout = 5 * time.Second

// serviceEndpointLine 은 새로 시작한 service 가 stdout 에 출력하는 첫 줄을 읽는다. limit 안에 줄이
// 오지 않으면 그 service 를 끝내고 회수한 뒤 timedOut 을 true 로 반환하고, 그 정리의 실패를 err 로 반환한다.
func serviceEndpointLine(cmd *exec.Cmd, stdout io.Reader, limit time.Duration) (line []byte, timedOut bool, err error) {
	type result struct {
		line []byte
		err  error
	}
	read := make(chan result, 1)
	go func() {
		line, err := bufio.NewReader(stdout).ReadBytes('\n')
		read <- result{line, err}
	}()
	timer := time.NewTimer(limit)
	defer timer.Stop()
	select {
	case got := <-read:
		return got.line, false, got.err
	case <-timer.C:
	}
	// service 가 끝나면 stdout 이 닫혀 읽기 고루틴도 끝난다.
	if err := cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return nil, true, fmt.Errorf("ending the service failed: %w", err)
	}
	<-read
	var exit *exec.ExitError
	if err := cmd.Wait(); err != nil && !errors.As(err, &exit) {
		return nil, true, fmt.Errorf("reaping the service failed: %w", err)
	}
	return nil, true, nil
}

func (c *Sidecars) processPersistent(name string) (*sidecar, error) {
	program, _, ok := c.declaration(name)
	if !ok {
		return nil, fmt.Errorf("sidecar %s is not declared by any plugin", name)
	}
	serviceDir := filepath.Join(c.configDir, "services", filepath.Base(program))
	current, err := platform.Current()
	if err != nil {
		return nil, err
	}
	if err := current.CreatePrivateDirectories(serviceDir); err != nil {
		return nil, fmt.Errorf("sidecar %s: create service directory: %w", name, err)
	}
	if err := current.SecureServiceDirectory(serviceDir); err != nil {
		return nil, fmt.Errorf("sidecar %s: secure service directory: %w", name, err)
	}
	if err := PerformanceSyncServices(c.configDir); err != nil {
		return nil, fmt.Errorf("sidecar %s: performance switch: %w", name, err)
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
		// 영구 service 는 이 애플리케이션 프로세스의 수명이 아니라 configuration
		// 디렉터리에 속한다. 애플리케이션이 비정상 종료해도 복구 service 가 함께
		// 종료되지 않도록 새 session 을 시작한다.
		if err := current.NewSession(cmd); err != nil {
			return nil, fmt.Errorf("sidecar %s: new session: %w", name, err)
		}
		cmd.Stdin = nil
		// 서비스는 이 호스트보다 오래 살므로 호스트의 표준 오류가 아니라 자기 로그 파일에 쓴다
		// (docs/spec/hosts.md#application-log). endpoint 가 없으므로 그 파일에 쓰는 서비스가 없다.
		serviceLog, err := OpenLog(ServiceLogPath(c.configDir, program))
		if err != nil {
			return nil, fmt.Errorf("sidecar %s: service log: %w", name, err)
		}
		cmd.Stderr = serviceLog
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			return nil, errors.Join(fmt.Errorf("sidecar %s: service stdout: %w", name, err), serviceLog.Close())
		}
		startErr := cmd.Start()
		// 서비스는 복제한 descriptor 를 가지므로 호스트가 연 파일은 닫는다.
		if err := errors.Join(startErr, serviceLog.Close()); err != nil {
			return nil, fmt.Errorf("sidecar %s: %w", name, err)
		}
		// 프로세스 등록부의 계기(V5-104): 뜨는 사이드카의 pid 와 역할을 남긴다.
		PerformanceObserve(c.configDir, "host", func() map[string]any {
			return map[string]any{
				"event": "process", "role": "sidecar", "name": name,
				"pid": cmd.Process.Pid,
			}
		})
		line, timedOut, err := serviceEndpointLine(cmd, stdout, c.ReadyTimeout)
		if timedOut {
			message := fmt.Sprintf("sidecar %s: the service did not print its endpoint within %v", name, c.ReadyTimeout)
			if err != nil {
				return nil, fmt.Errorf("%s; %w", message, err)
			}
			return nil, errors.New(message)
		}
		// 줄 없이 stdout 이 닫히면 service 가 endpoint 를 출력하기 전에 끝난 것이다.
		if errors.Is(err, io.EOF) && len(line) == 0 {
			return nil, fmt.Errorf("sidecar %s: service exited before endpoint", name)
		}
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
	exists, err := current.ServiceProcessExists(endpoint.PID)
	if err != nil {
		return nil, err
	}
	if !exists {
		if err := os.Remove(endpointPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("sidecar %s: remove stale endpoint: %w", name, err)
		}
		// 이 endpoint 는 비정상 종료한 service 가 남긴 것이다. 오래된 것으로 확인된 이
		// 기록만 제거하고, 일반적인 단일 생성 경로로 들어간다.
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
	// 답하지 않는 service 가 이 사이드카의 요청과 Stop 을 계속 기다리게 하지 않도록 hello 응답에 기한을 둔다.
	if err := conn.SetReadDeadline(time.Now().Add(helloTimeout)); err != nil {
		conn.Close()
		return nil, fmt.Errorf("sidecar %s: hello deadline: %w", name, err)
	}
	responseLine, err := reader.ReadBytes('\n')
	if errors.Is(err, os.ErrDeadlineExceeded) {
		conn.Close()
		return nil, fmt.Errorf("sidecar %s: the service did not answer hello within %v", name, helloTimeout)
	}
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("sidecar %s: hello response: %w", name, err)
	}
	if err := conn.SetReadDeadline(time.Time{}); err != nil {
		conn.Close()
		return nil, fmt.Errorf("sidecar %s: hello deadline: %w", name, err)
	}
	var response struct {
		Operation string  `json:"operation"`
		Protocol  *uint64 `json:"protocol"`
		Version   *string `json:"version"`
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
		name: name, cmd: cmd, conn: conn, persistent: true, version: response.Version,
		outbox: make(chan []byte, 256), exited: make(chan struct{}),
		pendingCloses: make([][]byte, 0), pendingReplies: make([][]byte, 0),
		closeWaiters: make(map[string]chan error), surfaces: make(map[string]bool),
	}
	process.begin = func() {
		go c.writePersistent(process)
		go c.readPersistent(process, reader)
	}
	return process, nil
}

// write 는 큐를 먼저 비우고, 큐가 비면 보관분을 쓰고, 그다음 큐를 기다린다.
// 보관분은 큐가 가득 찬 뒤에 생기므로 큐에 먼저 들어간 메시지보다 뒤에 나가야 한다.
// 큐가 닫히면 보관분까지 쓴 뒤 stdin 을 닫는다.
func (c *Sidecars) write(process *sidecar) {
	defer func() {
		if err := process.stdin.Close(); err != nil {
			LogError("sidecar "+process.name, fmt.Sprintf("close stdin: %v", err))
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
		LogError("sidecar "+process.name, fmt.Sprintf("write: %v", err))
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
		LogError("sidecar "+process.name, fmt.Sprintf("write: %v", err))
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

// read 는 사이드카의 출력을 표면 소유 창에 전달한다. 출력이 끝나거나 프로토콜을 어기면, 종료 중이
// 아닐 때 그 프로세스를 끝내고 그 프로세스에 보낸 표면마다 실패를 알린다(docs/spec/sidecars.md#failure).
// ownedSurface 는 실패를 알릴 표면과 그 소유 창이다.
type ownedSurface struct {
	surface string
	owner   SidecarOwner
}

func (c *Sidecars) read(process *sidecar, stdout io.ReadCloser) {
	violation := c.relay(process, stdout)
	// 읽기 끝을 닫아 아직 쓰는 프로세스가 쓰기에서 막히지 않게 한다. 막히면 Stop 의 기한 뒤 강제 종료까지 끝나지 않는다.
	if err := stdout.Close(); err != nil {
		LogError("sidecar "+process.name, fmt.Sprintf("close output: %v", err))
	}
	c.mu.Lock()
	failed := !c.stopped && c.running[process.name] == process
	owned := make([]ownedSurface, 0, len(process.surfaces))
	forgot := false
	if c.running[process.name] == process {
		delete(c.running, process.name)
		forgot = c.forgetClosing(process.name)
	}
	if failed {
		// 종료 중이면 Stop 이 outbox 를 닫는다. 아니면 쓰기 고루틴을 끝내도록 여기서 닫는다.
		// outbox 로의 모든 전송은 c.mu 안에서 running 에 있는 프로세스에만 일어난다.
		close(process.outbox)
		for surface := range process.surfaces {
			if owner := c.owners[surface]; owner != nil {
				owned = append(owned, ownedSurface{surface, owner})
			}
		}
	}
	c.mu.Unlock()
	if forgot {
		c.closingChanged()
	}
	if !failed {
		// 멈추는 중이다. 위반은 로그에 쓰고 실패 이벤트는 보내지 않는다. 종료의 보고는 Stop 이 정한다.
		if violation != "" {
			LogError("sidecar "+process.name, "failed: "+violation)
		}
		process.violated = violation != ""
		process.waitErr = process.cmd.Wait()
		close(process.exited)
		return
	}
	// 실패 뒤의 프로토콜 상태는 정의되지 않으므로 프로세스를 끝낸다.
	reason := violation
	if err := process.cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		reason = fmt.Sprintf("%s; kill: %v", reason, err)
	}
	exit := exitStatus(process.cmd, process.cmd.Wait())
	if violation == "" {
		reason = "output closed: " + exit
	}
	close(process.exited)
	LogError("sidecar "+process.name, "failed: "+reason)
	for _, item := range owned {
		item.owner.Emit("sidecar-failure", SidecarFailure{Sidecar: process.name, Surface: item.surface, Reason: reason})
	}
}

// exitStatus 는 끝난 프로세스 cmd 의 종료를 `exit status <code>` 나 `signal <number>` 로 쓴다
// (docs/spec/sidecars.md#declaration-and-startup). waitErr 는 cmd.Wait 의 결과다. 종료 상태가 아닌 기다리기의 오류는
// 그 오류를 쓴다.
func exitStatus(cmd *exec.Cmd, waitErr error) string {
	var exit *exec.ExitError
	if waitErr != nil && !errors.As(waitErr, &exit) {
		return fmt.Sprintf("wait: %v", waitErr)
	}
	current, err := platform.Current()
	if err != nil {
		return fmt.Sprintf("exit status of process %d: %v", cmd.ProcessState.Pid(), err)
	}
	text, err := current.ExitStatus(cmd.ProcessState)
	if err != nil {
		return fmt.Sprintf("exit status of process %d: %v", cmd.ProcessState.Pid(), err)
	}
	return text
}

// relay 는 출력의 메시지를 소유 창에 전달한다. 출력이 끝나면 빈 문자열을, 프로토콜을 어기거나 읽기가
// 실패하면 그 까닭을 반환한다. 한 줄은 줄바꿈 앞이 sidecarMessageLimit byte 를 넘으면 그 이상 버퍼링하지 않고 실패한다.
func (c *Sidecars) relay(process *sidecar, stdout io.Reader) string {
	scanner := bufio.NewScanner(stdout)
	// 버퍼는 한도와 줄바꿈 하나를 담는다. 더 긴 줄은 bufio.ErrTooLong 이다.
	scanner.Buffer(make([]byte, 0, 64*1024), sidecarMessageLimit+1)
	for scanner.Scan() {
		var output sidecarOutput
		if err := json.Unmarshal(scanner.Bytes(), &output); err != nil {
			return fmt.Sprintf("invalid message: %v", err)
		}
		if output.Surface == nil {
			return "invalid message: surface is missing"
		}
		if output.Closed != nil {
			if violation := c.closeAnswered(process, *output.Surface, *output.Closed, output.Error); violation != "" {
				return violation
			}
			continue
		}
		if output.Body == nil {
			return "invalid message: body is missing"
		}
		event := sidecarEvent{Surface: *output.Surface, Body: output.Body}
		c.mu.Lock()
		owner := c.owners[event.Surface]
		addressed := process.surfaces[event.Surface]
		c.mu.Unlock()
		// 이 프로세스에 보낸 적 없는 표면의 메시지는 프로토콜 위반이다. 보낸 적이 있고 소유 창이 없으면 표면이
		// 닫힌 뒤 사이드카가 보낸 메시지이므로 버린다(docs/spec/sidecars.md#messages).
		if !addressed {
			return "unknown surface " + event.Surface
		}
		if owner != nil {
			// 이미지 봉투 여부 확인
			if c.tryHandleImageEnvelope(owner, process.name, event.Surface, event.Body) {
				continue
			}
			owner.Emit("sidecar-message", SidecarMessage{Sidecar: process.name, Surface: event.Surface, Body: event.Body})
		}
	}
	if err := scanner.Err(); errors.Is(err, bufio.ErrTooLong) {
		return fmt.Sprintf("message exceeds %d bytes", sidecarMessageLimit)
	} else if err != nil {
		return fmt.Sprintf("read: %v", err)
	}
	return ""
}

func (c *Sidecars) readPersistent(process *sidecar, reader *bufio.Reader) {
	violation := c.readPersistentLines(process, reader)
	process.conn.Close()
	wasCurrent := false
	var owned []ownedSurface
	c.mu.Lock()
	waiters := make([]chan error, 0, len(process.closeWaiters))
	for request, waiter := range process.closeWaiters {
		delete(process.closeWaiters, request)
		waiters = append(waiters, waiter)
	}
	forgot := false
	if c.running[process.name] == process {
		delete(c.running, process.name)
		c.unannouncedLoss[process.name] = true
		wasCurrent = true
		forgot = c.forgetClosing(process.name)
		if violation != "" {
			for surface := range process.surfaces {
				if owner := c.owners[surface]; owner != nil {
					owned = append(owned, ownedSurface{surface, owner})
				}
			}
		}
	} else if c.stopped {
		// 중지가 실행 목록에서 뺀 연결이다. 답하지 않은 닫기는 service 가 스스로 마친다.
		forgot = c.forgetClosing(process.name)
	}
	c.mu.Unlock()
	if forgot {
		c.closingChanged()
	}
	for _, waiter := range waiters {
		waiter <- errors.New("persistent service disconnected before close-owner ack")
	}
	close(process.exited)
	if violation != "" {
		// 서비스가 프로토콜을 어겼다. 같은 메시지가 다음 연결도 끝내므로 곧바로 다시 맺지 않고, 다음 전송이
		// 생성 경로로 다시 맺는다(docs/spec/terminal-runtime.md#service-transport).
		LogError("sidecar "+process.name, "failed: "+violation)
		for _, item := range owned {
			item.owner.Emit("sidecar-failure", SidecarFailure{Sidecar: process.name, Surface: item.surface, Reason: violation})
		}
		return
	}
	// 연결이 끊겼다. 다음 전송을 기다리지 않고 즉시 다시 맺는다 — 서비스가 살아 있으면
	// 다시 붙고, 죽었으면 processPersistent 의 낡은 endpoint 정리가 재스폰한다(V5-106).
	if wasCurrent {
		c.revivePersistent(process.name)
	}
}

// readPersistentLines 는 영속 연결의 줄을 읽어 답과 이벤트를 전달한다. 연결이 끝나면 빈 문자열을, 프로토콜을
// 어기면 그 까닭을 반환한다. 한 줄은 줄바꿈 앞이 sidecarMessageLimit byte 를 넘으면 그 이상 버퍼링하지 않고
// 실패한다(docs/spec/terminal-runtime.md#service-transport).
func (c *Sidecars) readPersistentLines(process *sidecar, reader *bufio.Reader) string {
	scanner := bufio.NewScanner(reader)
	// 버퍼는 한도와 줄바꿈 하나를 담는다. 더 긴 줄은 bufio.ErrTooLong 이다.
	scanner.Buffer(make([]byte, 0, 64*1024), sidecarMessageLimit+1)
	for scanner.Scan() {
		line := scanner.Bytes()
		var value map[string]json.RawMessage
		if err := json.Unmarshal(line, &value); err != nil {
			return fmt.Sprintf("invalid message: %v", err)
		}
		var operation string
		if raw, present := value["operation"]; present {
			if err := json.Unmarshal(raw, &operation); err != nil {
				return fmt.Sprintf("invalid message: operation: %v", err)
			}
		}
		if operation == "closed-owner" || operation == "shutdown" || operation == "retained" {
			var request string
			if err := json.Unmarshal(value["request"], &request); err != nil || request == "" {
				return fmt.Sprintf("invalid message: %s request is not a non-empty string", operation)
			}
			var ok bool
			if err := json.Unmarshal(value["ok"], &ok); err != nil {
				return fmt.Sprintf("invalid message: %s ok: %v", operation, err)
			}
			var reason string
			if raw, present := value["error"]; present {
				if err := json.Unmarshal(raw, &reason); err != nil {
					return fmt.Sprintf("invalid message: %s error: %v", operation, err)
				}
			}
			var closed int
			if operation == "retained" && ok {
				if err := json.Unmarshal(value["closed"], &closed); err != nil {
					return fmt.Sprintf("invalid message: retained closed: %v", err)
				}
			}
			c.mu.Lock()
			waiter := process.closeWaiters[request]
			delete(process.closeWaiters, request)
			if operation == "retained" && waiter != nil {
				if process.retained == nil {
					process.retained = map[string]int{}
				}
				process.retained[request] = closed
			}
			c.mu.Unlock()
			if waiter != nil {
				if ok {
					waiter <- nil
				} else if reason == "" {
					waiter <- fmt.Errorf("%s failed", operation)
				} else {
					waiter <- errors.New(reason)
				}
			}
			continue
		}
		var output sidecarOutput
		if err := json.Unmarshal(line, &output); err != nil {
			return fmt.Sprintf("invalid message: %v", err)
		}
		if output.Surface == nil {
			return "invalid message: surface is missing"
		}
		if output.Closed != nil {
			if violation := c.closeAnswered(process, *output.Surface, *output.Closed, output.Error); violation != "" {
				return violation
			}
			continue
		}
		if output.Body == nil {
			return "invalid message: body is missing"
		}
		event := sidecarEvent{Surface: *output.Surface, Body: output.Body}
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
	// net.ErrClosed 는 이 host 가 연결을 닫았다는 뜻이다(종료나 실패 뒤의 정리). 상대가 닫으면 EOF 이고 오류가 없다.
	if err := scanner.Err(); errors.Is(err, bufio.ErrTooLong) {
		return fmt.Sprintf("message exceeds %d bytes", sidecarMessageLimit)
	} else if err != nil && !errors.Is(err, net.ErrClosed) {
		LogError("sidecar "+process.name, fmt.Sprintf("persistent read: %v", err))
	}
	return ""
}

// revivePersistent 는 끊긴 영속 연결을 다시 맺고 결과를 소유 표면에 알린다(V5-106). 이미
// 다른 경로가 다시 시작했거나 종료 중이면 아무 일도 하지 않는다. 한 번의 연결 끊김에 한 번만
// 시도한다 — 실패는 알림으로 보고하고, 다음 전송이 같은 경로를 다시 지나간다.
func (c *Sidecars) revivePersistent(name string) {
	announced, failure := c.reviveAttempt(name)
	// 연결이 거부된 첫 시도는 endpoint 가 더는 듣지 않는다는 증거다 — 재활용된 pid 가
	// kill(pid, 0) 을 통과시켜도 소켓은 죽었다. 끊김 기록이 있는 재시작에서만 endpoint 를
	// 버리고 한 번 더 시도한다(V5-106). 전송 경로의 계약은 그대로다: 차가운 전송의
	// live-unreachable 보고는 endpoint 를 바꾸지 않는다.
	if failure != nil && refusedConnect(failure, name) {
		if program, _, ok := c.declaration(name); ok {
			endpoint := filepath.Join(c.configDir, "services", filepath.Base(program), "endpoint.json")
			if err := os.Remove(endpoint); err != nil && !errors.Is(err, os.ErrNotExist) {
				LogError("sidecar "+name, fmt.Sprintf("remove refused endpoint: %v", err))
			}
		}
		announced, failure = c.reviveAttempt(name)
	}
	switch {
	case failure != nil:
		// 시작에 실패했다 — 끊김 기록은 남겨 다음 시작이 알린다.
		LogError("sidecar "+name, fmt.Sprintf("connection lost; restart failed: %v", failure))
		c.notifyConnection(name, failure)
	case announced:
		// 다른 경로(전송)가 이미 다시 시작했으면 알림도 그 호출이 보냈다.
		LogError("sidecar "+name, "connection lost; restarted")
		c.notifyConnection(name, nil)
	}
}

// reviveAttempt 는 재시작 한 번. 이미 다른 경로가 다시 시작했으면 announced=false,
// 시작에 실패하면 failure 를 돌려준다.
func (c *Sidecars) reviveAttempt(name string) (announced bool, failure error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.stopped {
		return false, nil
	}
	if _, running := c.running[name]; running {
		return false, nil
	}
	_, started, err := c.process(name)
	if err != nil {
		return false, err
	}
	if !started {
		return false, nil
	}
	announced = c.unannouncedLoss[name]
	delete(c.unannouncedLoss, name)
	return announced, nil
}

// refusedConnect 는 processPersistent 의 연결 실패 문장인가.
func refusedConnect(failure error, name string) bool {
	return failure != nil && strings.HasPrefix(failure.Error(), fmt.Sprintf("sidecar %s: connect authenticated service:", name))
}

// notifyConnection 은 다시 맺긴 영속 연결을 소유 표면에 알린다(V5-106). 창은 그 사이드카의
// 그림 configure 를 다시 보내고(SidecarReconnected), 표면은 연결 이벤트를 받아 자기 세션을
// 다시 연다. 시작에 실패했으면 연결 끊김과 그 까닭을 알린다.
func (c *Sidecars) notifyConnection(name string, failure error) {
	type ownerSurface struct {
		surface string
		owner   SidecarOwner
	}
	c.mu.Lock()
	entries := make([]ownerSurface, 0, len(c.owners))
	for surface, owner := range c.owners {
		entries = append(entries, ownerSurface{surface, owner})
	}
	c.mu.Unlock()
	body := map[string]any{"event": "connection", "connected": failure == nil}
	if failure != nil {
		body["reason"] = failure.Error()
	}
	raw, err := json.Marshal(body)
	if err != nil {
		LogError("sidecar "+name, fmt.Sprintf("connection notice serialization: %v", err))
		return
	}
	reconfigured := map[SidecarOwner]bool{}
	for _, item := range entries {
		if failure == nil && !reconfigured[item.owner] {
			reconfigured[item.owner] = true
			if window, ok := item.owner.(interface{ SidecarReconnected(sidecar string) }); ok {
				window.SidecarReconnected(name)
			}
		}
		item.owner.Emit("sidecar-message", SidecarMessage{Sidecar: name, Surface: item.surface, Body: raw})
	}
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
