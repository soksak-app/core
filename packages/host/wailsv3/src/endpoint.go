// 로컬 엔드포인트의 JSON-RPC 서버.
//
// 형식은 docs/spec/endpoint.md 와 docs/spec/exposure.md 에 정의한다. 전송은 운영체제 구현이
// 만든 리스너이고, 이 파일은 프레임 해석, 메서드 분배, 연결별 감시와 알림, endpoint.json 을
// 처리한다. 창과 페이지는 Backend 로 접근하므로 검사는 애플리케이션 없이 이 서버를 실행한다.

package host

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/min-median-max/soksak/packages/host/wailsv3/src/platform"
)

// 프레임 본문의 최대 길이.
const frameLimit = 16 << 20

// 오류 번호. docs/spec/exposure.md 의 오류 표와 같다.
const (
	codeInternal      = -32603
	codeInvalidParams = -32602
	codeHandler       = -32000
	codeUnknownName   = 1001
	codeUnregistered  = 1002
	codeNoWindow      = 1003
	codeNoInput       = 1004
	codeTimeout       = 1005
	codeInactive      = 1006
	codeButtonHeld    = 1007
)

// RPCError 는 JSON-RPC 오류 객체다.
type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *RPCError) Error() string { return fmt.Sprintf("%d: %s", e.Code, e.Message) }

func rpcError(code int, format string, args ...any) *RPCError {
	return &RPCError{Code: code, Message: fmt.Sprintf(format, args...)}
}

// errMissingWindow 는 창이 없을 때의 오류를 만든다.
func errMissingWindow(window string) *RPCError {
	return rpcError(codeNoWindow, "window %q does not exist", window)
}

// WindowEntry 는 windows.list 의 항목이다.
type WindowEntry struct {
	Window string `json:"window"`
	Title  string `json:"title"`
	// Project 는 창에 마지막으로 열린 프로젝트의 루트 디렉터리다. 없으면 null 이다.
	Project *string `json:"project"`
	Key     bool    `json:"key"`
	// Ready 는 창의 메인 페이지가 준비를 알렸는지다. 다시 읽는 동안에는 거짓이다.
	Ready bool `json:"ready"`
}

// PointerInput 은 input.pointer 의 값이다. Phase 는 move, down, drag, up, scroll 중 하나이고
// Button 은 left 또는 right 다. Activate 는 move 에만 참일 수 있다.
type PointerInput struct {
	X, Y           float64
	Phase          string
	Button         string
	DeltaX, DeltaY float64
	Activate       bool
}

// KeyInput 은 input.key 의 값이다. Modifiers 는 비트 합이다: 1 Shift, 2 Control, 4 Option, 8 Command.
type KeyInput struct {
	Key       string
	Text      string
	Modifiers uint
	Down      bool
}

// Backend 는 엔드포인트가 사용하는 창과 페이지다. 오류가 *RPCError 이면 그 번호로 답한다.
type Backend interface {
	// Windows 는 열린 창의 목록이다.
	Windows() []WindowEntry
	// HasWindow 는 창 window 가 있는지 반환한다.
	HasWindow(window string) bool
	// PageRequest 는 창 window 의 메인 페이지에 요청을 보내고 그 답을 기다린다.
	PageRequest(window, method string, params json.RawMessage) (json.RawMessage, error)
	// HostStatus 는 호스트 상태 name 의 값이다.
	HostStatus(window, name string) (any, error)
	// HostCommand 는 호스트 명령 name 을 실행한다.
	HostCommand(window, name string, params json.RawMessage) (any, error)
	// Pointer 와 Key 는 창에 네이티브 입력을 전달한다.
	Pointer(window string, input PointerInput) error
	Key(window string, input KeyInput) error
}

// SocketDirectory 는 애플리케이션이 소켓을 두는 디렉터리다. 사용자별 임시 디렉터리 아래에 있다.
func SocketDirectory() string { return filepath.Join(os.TempDir(), "soksak") }

// EndpointInfo 는 endpoint.json 의 내용이다.
type EndpointInfo struct {
	Transport   string    `json:"transport"`
	Address     string    `json:"address"`
	PID         int       `json:"pid"`
	Application string    `json:"application"`
	Version     string    `json:"version"`
	Executable  string    `json:"executable"`
	Started     time.Time `json:"started"`
}

// endpointMethod 는 선언된 메서드 하나의 처리다.
type endpointMethod func(e *Endpoint, c *endpointConn, params json.RawMessage) (any, error)

// diagnosticMethods 는 진단 빌드가 init 에서 추가하는 메서드다. 진단 빌드가 아니면 비어 있다.
var diagnosticMethods = map[string]endpointMethod{}

// subscriptionMethod 는 연결의 구독을 바꾸는 메서드의 params 를 읽고 바꿀 topic 과 방향을 반환한다.
// 이 메서드들은 받은 순서대로 적용한다.
type subscriptionMethod func(e *Endpoint, params json.RawMessage) (topic, bool, error)

var subscriptionMethods = map[string]subscriptionMethod{
	"status.watch":   func(e *Endpoint, p json.RawMessage) (topic, bool, error) { return watchTopic(e, p, true) },
	"status.unwatch": func(e *Endpoint, p json.RawMessage) (topic, bool, error) { return watchTopic(e, p, false) },
}

// diagnosticSubscriptions 는 진단 빌드가 init 에서 추가하는 구독 메서드다.
var diagnosticSubscriptions = map[string]subscriptionMethod{}

// topic 은 알림을 받는 대상이다. 상태 감시는 상태 이름, 진단 구독은 diagnosticTopics 의 이름을 사용한다.
type topic struct {
	window string
	name   string
	// surface 는 감시가 지정한 표면이다. 지정하지 않은 감시는 빈 문자열이다.
	surface string
}

// watchParams 는 페이지에 보낼 감시 요청의 params 다.
func (t topic) watchParams() map[string]string {
	params := map[string]string{"name": t.name}
	if t.surface != "" {
		params["surface"] = t.surface
	}
	return params
}

// diagnosticTopics 는 진단 빌드가 init 에서 추가하는 구독 대상이다. 값은 구독의 시작(on)과
// 끝을 페이지에 알리는 요청의 메서드와 params 를 만든다. 진단 빌드가 아니면 비어 있다.
var diagnosticTopics = map[string]func(on bool) (method string, params any){}

// transcribe 는 창의 진단 기록을 켠 연결에 줄 하나를 보낸다. 진단 빌드가 init 에서 정한다.
var transcribe func(e *Endpoint, window, line string)

// Endpoint 는 연결을 받고 요청을 처리한다.
type Endpoint struct {
	backend Backend
	// 구성 디렉터리. 성능 트레이스의 스위치와 대상이 여기에 있다(V5-104).
	configDir string

	mu          sync.Mutex
	listener    net.Listener
	processLock *processLock
	file        string
	owner       EndpointInfo
	published   bool
	conns       map[*endpointConn]bool
	// counts 는 topic 마다 구독한 연결의 수다.
	counts map[topic]int
	// queues 는 topic 마다 받은 순서대로 실행할 구독 변경이다. 목록이 있으면 그 topic 의 실행
	// 고루틴이 있다. queueMu 로 보호한다.
	queueMu sync.Mutex
	queues  map[topic][]func()
}

// processLock gives one application process exclusive ownership of a
// configuration directory while retaining the PID needed to replace a stale
// lock after an unclean termination.
type processLock struct {
	path string
	file *os.File
}

func acquireProcessLock(directory string) (*processLock, error) {
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, err
	}
	path := filepath.Join(directory, "process.lock")
	for attempt := 0; attempt < 2; attempt++ {
		file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err == nil {
			if _, err := fmt.Fprintf(file, "%d", os.Getpid()); err != nil {
				return nil, errors.Join(err, file.Close(), os.Remove(path))
			}
			if err := file.Sync(); err != nil {
				return nil, errors.Join(err, file.Close(), os.Remove(path))
			}
			return &processLock{path: path, file: file}, nil
		}
		if !errors.Is(err, os.ErrExist) || attempt != 0 {
			return nil, err
		}
		contents, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil, readErr
		}
		var pid int
		if _, scanErr := fmt.Sscanf(string(contents), "%d", &pid); scanErr != nil || pid <= 0 {
			return nil, fmt.Errorf("invalid process lock %s", path)
		}
		implementation, currentErr := platform.Current()
		if currentErr != nil {
			return nil, currentErr
		}
		if implementation.ServiceProcessExists(pid) {
			return nil, fmt.Errorf("configuration directory %s is already owned by process %d", directory, pid)
		}
		if err := os.Remove(path); err != nil {
			return nil, err
		}
	}
	return nil, fmt.Errorf("could not acquire process lock %s", path)
}

func (lock *processLock) close() error {
	if lock == nil {
		return nil
	}
	var errs []error
	if err := lock.file.Close(); err != nil {
		errs = append(errs, err)
	}
	if err := os.Remove(lock.path); err != nil && !errors.Is(err, os.ErrNotExist) {
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}

// NewEndpoint 는 backend 를 사용하는 엔드포인트를 만든다.
func NewEndpoint(backend Backend) *Endpoint {
	return &Endpoint{backend: backend, conns: map[*endpointConn]bool{}, counts: map[topic]int{}, queues: map[topic][]func(){}}
}

// Serve 는 configDir 의 소유권을 얻고 listener 의 연결을 받기 시작한다. endpoint.json 은
// 첫 창을 등록한 뒤 Publish 가 쓴다.
func (e *Endpoint) Serve(listener net.Listener, info EndpointInfo, configDir string) error {
	e.configDir = configDir

	lock, err := acquireProcessLock(configDir)
	if err != nil {
		return err
	}
	file := filepath.Join(configDir, "endpoint.json")
	info.Started = info.Started.UTC().Truncate(time.Second)
	executable, err := os.Executable()
	if err != nil {
		return errors.Join(err, lock.close())
	}
	if info.Executable, err = filepath.EvalSymlinks(executable); err != nil {
		return errors.Join(err, lock.close())
	}
	e.mu.Lock()
	e.listener, e.processLock, e.file, e.owner = listener, lock, file, info
	e.mu.Unlock()
	go e.accept(listener)
	return nil
}

// Publish 는 창 window 가 등록되어 있으면 endpoint.json 을 쓴다. 파일을 읽은 클라이언트가 그 창에
// 바로 요청할 수 있도록 첫 창을 등록한 뒤 한 번 호출한다.
func (e *Endpoint) Publish(window string) error {
	if !e.backend.HasWindow(window) {
		return fmt.Errorf("endpoint.json is not written: window %s does not exist", window)
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	switch {
	case e.file == "":
		return errors.New("the endpoint is not serving")
	case e.published:
		return errors.New("endpoint.json is already written")
	}
	if err := writeJSON(e.file, e.owner); err != nil {
		return err
	}
	e.published = true
	return nil
}

// Close 는 연결을 받지 않고, 열린 연결을 닫고, endpoint.json 을 제거한다.
func (e *Endpoint) Close() error {
	e.mu.Lock()
	listener, processLock, file, owner := e.listener, e.processLock, e.file, e.owner
	e.listener, e.processLock, e.file, e.owner, e.published = nil, nil, "", EndpointInfo{}, false
	conns := make([]*endpointConn, 0, len(e.conns))
	for c := range e.conns {
		conns = append(conns, c)
	}
	e.mu.Unlock()
	var errs []error
	if listener != nil {
		errs = append(errs, listener.Close())
	}
	for _, c := range conns {
		c.close()
	}
	if file != "" {
		var current EndpointInfo
		data, err := os.ReadFile(file)
		switch {
		case errors.Is(err, os.ErrNotExist):
		case err != nil:
			errs = append(errs, err)
		case json.Unmarshal(data, &current) != nil:
			errs = append(errs, fmt.Errorf("endpoint file %s is not valid JSON", file))
		case current.PID == owner.PID && current.Address == owner.Address &&
			current.Application == owner.Application && current.Started.Equal(owner.Started) &&
			current.Executable == owner.Executable:
			if err := os.Remove(file); err != nil && !os.IsNotExist(err) {
				errs = append(errs, err)
			}
		}
	}
	if err := processLock.close(); err != nil {
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}

func (e *Endpoint) accept(listener net.Listener) {
	for {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		c := &endpointConn{conn: conn, topics: map[topic]bool{}, out: make(chan []byte, 256), done: make(chan struct{})}
		e.mu.Lock()
		e.conns[c] = true
		e.mu.Unlock()
		go c.write()
		go e.read(c)
	}
}

// StatusChanged 는 창 window 의 상태 name 을 감시하는 연결에 새 값을 알린다. surface 는 감시가
// 지정한 표면이며, 지정하지 않은 감시의 변경이면 빈 문자열이다.
func (e *Endpoint) StatusChanged(window, name, surface string, value any) {
	params := map[string]any{"window": window, "name": name, "value": value}
	if surface != "" {
		params["surface"] = surface
	}
	e.publish(topic{window, name, surface}, "status.changed", params)
}

// Watching 은 창 window 의 상태 name 을 감시하는 연결이 있는지 반환한다.
func (e *Endpoint) Watching(window, name string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.counts[topic{window, name, ""}] > 0
}

func (e *Endpoint) publish(t topic, method string, params any) {
	data, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
	if err != nil {
		log.Printf("endpoint: %v", err)
		return
	}
	e.mu.Lock()
	targets := make([]*endpointConn, 0)
	for c := range e.conns {
		if c.topics[t] {
			targets = append(targets, c)
		}
	}
	e.mu.Unlock()
	for _, c := range targets {
		c.send(data)
	}
}

// subscribe 는 연결 c 의 topic 구독을 바꾸고, 그 변경이 첫 구독이나 마지막 해제인지 반환한다.
func (e *Endpoint) subscribe(c *endpointConn, t topic, on bool) (edge bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if c.topics[t] == on {
		return false
	}
	if on {
		c.topics[t] = true
		e.counts[t]++
		return e.counts[t] == 1
	}
	delete(c.topics, t)
	e.counts[t]--
	if e.counts[t] > 0 {
		return false
	}
	delete(e.counts, t)
	return true
}

// topics 는 페이지가 알림을 보내야 하는 창 window 의 topic 이다. 페이지가 다시 로드되면 호스트가
// 이 목록으로 감시를 다시 요청한다.
func (e *Endpoint) topics(window string) []topic {
	e.mu.Lock()
	defer e.mu.Unlock()
	var out []topic
	for t := range e.counts {
		if t.window == window {
			out = append(out, t)
		}
	}
	return out
}

// endpointConn 은 연결 하나와 그 연결의 구독이다. topics 는 Endpoint.mu 로 보호한다.
type endpointConn struct {
	conn   net.Conn
	topics map[topic]bool
	out    chan []byte
	done   chan struct{}
	once   sync.Once
}

func (c *endpointConn) close() {
	c.once.Do(func() {
		close(c.done)
		if err := c.conn.Close(); err != nil {
			log.Printf("endpoint: close connection: %v", err)
		}
	})
}

// send 는 프레임 하나를 쓰기 대기열에 넣는다. 대기열이 차면 읽지 않는 연결이므로 닫는다.
func (c *endpointConn) send(body []byte) {
	select {
	case c.out <- body:
	case <-c.done:
	default:
		log.Printf("endpoint: closing a connection that does not read")
		c.close()
	}
}

func (c *endpointConn) write() {
	for {
		select {
		case <-c.done:
			return
		case body := <-c.out:
			frame := binary.BigEndian.AppendUint32(make([]byte, 0, 4+len(body)), uint32(len(body)))
			if _, err := c.conn.Write(append(frame, body...)); err != nil {
				c.close()
				return
			}
		}
	}
}

// request 는 받은 JSON-RPC 객체다. id 가 없으면 알림이므로 답하지 않는다.
type request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  *string         `json:"method"`
	Params  json.RawMessage `json:"params"`
}

// read 는 연결의 프레임을 읽는다. 규칙을 어긴 프레임을 받으면 답하지 않고 연결을 닫는다.
func (e *Endpoint) read(c *endpointConn) {
	defer e.drop(c)
	var size [4]byte
	for {
		if _, err := io.ReadFull(c.conn, size[:]); err != nil {
			return
		}
		length := binary.BigEndian.Uint32(size[:])
		if length > frameLimit {
			return
		}
		body := make([]byte, length)
		if _, err := io.ReadFull(c.conn, body); err != nil {
			return
		}
		var req request
		if !json.Valid(body) || json.Unmarshal(body, &req) != nil || req.JSONRPC != "2.0" || req.Method == nil {
			return
		}
		if parse, ok := e.subscription(*req.Method); ok {
			e.changeInOrder(c, req, parse)
			continue
		}
		method, declared := e.method(*req.Method)
		if !declared {
			return
		}
		go e.run(c, req, method)
	}
}

// subscription 은 구독을 바꾸는 선언된 메서드의 처리를 반환한다.
func (e *Endpoint) subscription(name string) (subscriptionMethod, bool) {
	if parse, ok := subscriptionMethods[name]; ok {
		return parse, true
	}
	parse, ok := diagnosticSubscriptions[name]
	return parse, ok
}

// changeInOrder 는 구독 변경 요청 하나를 그 topic 의 대기열 끝에 넣는다. 읽기 루프에서 호출하므로
// 같은 topic 의 변경과 페이지에 보내는 메시지는 받은 순서대로 실행되고, 답은 페이지가 답한 뒤 보낸다.
func (e *Endpoint) changeInOrder(c *endpointConn, req request, parse subscriptionMethod) {
	t, on, err := parse(e, req.Params)
	if err != nil {
		go e.reply(c, req, nil, err)
		return
	}
	e.enqueue(t, func() { e.reply(c, req, nil, e.change(c, t, on)) })
}

// change 는 연결 c 의 topic 구독을 바꾸고, 첫 구독이나 마지막 해제이면 페이지에 알린다. 페이지가
// 첫 구독을 거부하면 구독을 되돌린다.
func (e *Endpoint) change(c *endpointConn, t topic, on bool) error {
	if !e.subscribe(c, t, on) {
		return nil
	}
	err := e.notifyPage(t, on)
	if err != nil && on {
		e.subscribe(c, t, false)
	}
	return err
}

// enqueue 는 job 을 topic t 의 대기열에 넣고, 실행 중인 고루틴이 없으면 시작한다.
func (e *Endpoint) enqueue(t topic, job func()) {
	e.queueMu.Lock()
	defer e.queueMu.Unlock()
	pending, running := e.queues[t]
	e.queues[t] = append(pending, job)
	if !running {
		go e.drain(t)
	}
}

// drain 은 topic t 의 대기열이 빌 때까지 작업을 차례로 실행한다.
func (e *Endpoint) drain(t topic) {
	for {
		e.queueMu.Lock()
		pending := e.queues[t]
		if len(pending) == 0 {
			delete(e.queues, t)
			e.queueMu.Unlock()
			return
		}
		job := pending[0]
		e.queues[t] = pending[1:]
		e.queueMu.Unlock()
		job()
	}
}

// drop 은 닫힌 연결을 목록에서 빼고 그 구독을 해제한다. 마지막 감시가 사라진 상태는 페이지에
// 해제를 보낸다.
func (e *Endpoint) drop(c *endpointConn) {
	c.close()
	e.mu.Lock()
	delete(e.conns, c)
	held := make([]topic, 0, len(c.topics))
	for t := range c.topics {
		held = append(held, t)
	}
	e.mu.Unlock()
	for _, t := range held {
		e.enqueue(t, func() {
			if err := e.change(c, t, false); err != nil {
				log.Printf("endpoint: release %s on %s: %v", t.name, t.window, err)
			}
		})
	}
}

// notifyPage 는 topic 의 첫 구독이나 마지막 해제를 페이지에 보낸다. 호스트 상태는 페이지에 보내지 않는다.
func (e *Endpoint) notifyPage(t topic, on bool) error {
	var err error
	request, diagnostic := diagnosticTopics[t.name]
	switch {
	case diagnostic:
		method, params := request(on)
		_, err = e.backend.PageRequest(t.window, method, mustJSON(params))
	case isHostName(t.name):
	case on:
		_, err = e.backend.PageRequest(t.window, "status.watch", mustJSON(t.watchParams()))
	default:
		_, err = e.backend.PageRequest(t.window, "status.unwatch", mustJSON(t.watchParams()))
	}
	return err
}

func (e *Endpoint) run(c *endpointConn, req request, method endpointMethod) {
	// 모든 엔드포인트 메서드의 시간과 결과를 성능 트레이스에 남긴다(V5-104).
	// 거부도 그대로 기록한다 — 어긋난 값은 오류 문자열이 담는다.
	started := time.Now()
	result, err := method(e, c, req.Params)
	if PerformanceEnabled(e.configDir) {
		fields := map[string]any{
			"event": "endpoint", "name": methodOf(req), "us": time.Since(started).Microseconds(),
			"ok":    err == nil,
		}
		if err != nil {
			fields["error"] = err.Error()
		}
		_ = PerformanceLine(PerformanceTarget(e.configDir), "host", fields)
	}
	e.reply(c, req, result, err)
}

// reply 는 요청 req 의 결과나 오류를 보낸다. id 가 없는 요청에는 답하지 않는다.
func (e *Endpoint) reply(c *endpointConn, req request, result any, err error) {
	if len(req.ID) == 0 || string(req.ID) == "null" {
		return
	}
	reply := map[string]any{"jsonrpc": "2.0", "id": req.ID}
	if err != nil {
		var coded *RPCError
		if !errors.As(err, &coded) {
			coded = rpcError(codeInternal, "%v", err)
		}
		reply["error"] = coded
	} else {
		reply["result"] = result
	}
	data, marshalErr := json.Marshal(reply)
	if marshalErr != nil {
		log.Printf("endpoint: cannot encode reply for %s: %v", req.ID, marshalErr)
		c.close()
		return
	}
	c.send(data)
}

func mustJSON(value any) json.RawMessage {
	data, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return data
}

// method 는 선언된 메서드의 처리를 반환한다.
func (e *Endpoint) method(name string) (endpointMethod, bool) {
	if method, ok := endpointMethods[name]; ok {
		return method, true
	}
	method, ok := diagnosticMethods[name]
	return method, ok
}

var endpointMethods = map[string]endpointMethod{
	"windows.list":  func(e *Endpoint, _ *endpointConn, _ json.RawMessage) (any, error) { return e.backend.Windows(), nil },
	"exposure.list": exposureList,
	"status.get":    statusGet,
	"command.run":   commandRun,
	"dom.rect":      domRequest("dom.rect"),
	"dom.act":       domRequest("dom.act"),
	"input.pointer": inputPointer,
	"input.key":     inputKey,
}

// namePattern 은 항목 이름의 형식이다.
var namePattern = regexp.MustCompile(`^[a-z0-9-]+(\.[a-z0-9-]+)+$`)

func isHostName(name string) bool { return strings.HasPrefix(name, "host.") }

// target 은 창을 지정하는 요청의 공통 매개변수다.
type target struct {
	Window  *string `json:"window"`
	Name    *string `json:"name"`
	Surface *string `json:"surface"`
}

// decode 는 params 를 into 로 읽는다. 객체가 아니면 매개변수 오류다.
func decode(params json.RawMessage, into any) error {
	if len(params) == 0 || params[0] != '{' {
		return rpcError(codeInvalidParams, "params must be an object")
	}
	if err := json.Unmarshal(params, into); err != nil {
		return rpcError(codeInvalidParams, "%v", err)
	}
	return nil
}

// window 는 params 의 창을 읽고 그 창이 있는지 확인한다.
func (e *Endpoint) window(params json.RawMessage) (string, error) {
	var t target
	if err := decode(params, &t); err != nil {
		return "", err
	}
	if t.Window == nil || *t.Window == "" {
		return "", rpcError(codeInvalidParams, "window is required")
	}
	if !e.backend.HasWindow(*t.Window) {
		return "", errMissingWindow(*t.Window)
	}
	return *t.Window, nil
}

// named 는 params 의 창과 이름을 읽는다.
func (e *Endpoint) named(params json.RawMessage) (string, string, error) {
	var t target
	if err := decode(params, &t); err != nil {
		return "", "", err
	}
	if t.Name == nil || !namePattern.MatchString(*t.Name) {
		return "", "", rpcError(codeInvalidParams, "name is required and must have the form <owner>.<name>")
	}
	window, err := e.window(params)
	return window, *t.Name, err
}

// withoutWindow 는 페이지에 보낼 params 에서 window 를 뺀다.
func withoutWindow(params json.RawMessage) json.RawMessage {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(params, &fields); err != nil {
		return params
	}
	delete(fields, "window")
	return mustJSON(fields)
}

func exposureList(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	window, err := e.window(params)
	if err != nil {
		return nil, err
	}
	reply, err := e.backend.PageRequest(window, "exposure.list", json.RawMessage(`{}`))
	if err != nil {
		return nil, err
	}
	var list map[string][]json.RawMessage
	if err := json.Unmarshal(reply, &list); err != nil {
		return nil, rpcError(codeInternal, "page exposure.list: %v", err)
	}
	// JSON null 은 오류 없이 nil 맵으로 해석되므로 객체가 아닌 목록으로 거부한다.
	if list == nil {
		return nil, rpcError(codeInternal, "page exposure.list is %s, not an object", reply)
	}
	for _, entry := range listedEntries(hostStatus, true) {
		list["status"] = append(list["status"], mustJSON(entry))
	}
	for _, entry := range listedEntries(hostCommands, false) {
		list["commands"] = append(list["commands"], mustJSON(entry))
	}
	if list["dom"] == nil {
		list["dom"] = []json.RawMessage{}
	}
	return list, nil
}

func statusGet(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	window, name, err := e.named(params)
	if err != nil {
		return nil, err
	}
	if isHostName(name) {
		if _, ok := hostStatus[name]; !ok {
			return nil, rpcError(codeUnknownName, "unknown status %s", name)
		}
		return e.backend.HostStatus(window, name)
	}
	return e.backend.PageRequest(window, "status.get", withoutWindow(params))
}

// watchTopic 은 status.watch 와 status.unwatch 의 params 에서 바꿀 topic 을 읽는다.
func watchTopic(e *Endpoint, params json.RawMessage, on bool) (topic, bool, error) {
	window, name, err := e.named(params)
	if err != nil {
		return topic{}, on, err
	}
	t := topic{window: window, name: name}
	if isHostName(name) {
		if _, ok := hostStatus[name]; !ok {
			return topic{}, on, rpcError(codeUnknownName, "unknown status %s", name)
		}
		return t, on, nil
	}
	var fields target
	if err := decode(params, &fields); err != nil {
		return topic{}, on, err
	}
	if fields.Surface != nil {
		if *fields.Surface == "" {
			return topic{}, on, rpcError(codeInvalidParams, "surface must not be empty")
		}
		t.surface = *fields.Surface
	}
	return t, on, nil
}

func commandRun(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	window, name, err := e.named(params)
	if err != nil {
		return nil, err
	}
	if isHostName(name) {
		if _, ok := hostCommands[name]; !ok {
			return nil, rpcError(codeUnknownName, "unknown command %s", name)
		}
		var fields struct {
			Params json.RawMessage `json:"params"`
		}
		if err := decode(params, &fields); err != nil {
			return nil, err
		}
		if len(fields.Params) == 0 || string(fields.Params) == "null" {
			fields.Params = json.RawMessage(`{}`)
		}
		if fields.Params[0] != '{' {
			return nil, rpcError(codeInvalidParams, "params of %s must be an object", name)
		}
		return e.backend.HostCommand(window, name, fields.Params)
	}
	return e.backend.PageRequest(window, "command.run", withoutWindow(params))
}

func domRequest(method string) endpointMethod {
	return func(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
		window, name, err := e.named(params)
		if err != nil {
			return nil, err
		}
		if isHostName(name) {
			return nil, rpcError(codeUnknownName, "the host declares no dom entry %s", name)
		}
		return e.backend.PageRequest(window, method, withoutWindow(params))
	}
}

var pointerPhases = map[string]bool{"move": true, "down": true, "drag": true, "up": true, "scroll": true}

func inputPointer(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	window, err := e.window(params)
	if err != nil {
		return nil, err
	}
	var p struct {
		X, Y           *float64
		Phase          string
		Button         *string
		DeltaX, DeltaY float64
		Activate       bool
	}
	if err := decode(params, &p); err != nil {
		return nil, err
	}
	if p.X == nil || p.Y == nil {
		return nil, rpcError(codeInvalidParams, "x and y are required")
	}
	if !pointerPhases[p.Phase] {
		return nil, rpcError(codeInvalidParams, "phase must be move, down, drag, up, or scroll")
	}
	button := "left"
	if p.Button != nil {
		button = *p.Button
	}
	if button != "left" && button != "right" {
		return nil, rpcError(codeInvalidParams, "button must be left or right")
	}
	if p.Activate && p.Phase != "move" {
		return nil, rpcError(codeInvalidParams, "activate applies only to phase move")
	}
	return nil, e.backend.Pointer(window, PointerInput{X: *p.X, Y: *p.Y, Phase: p.Phase, Button: button,
		DeltaX: p.DeltaX, DeltaY: p.DeltaY, Activate: p.Activate})
}

// modifierBits 는 input.key 의 modifiers 이름과 네이티브 입력의 비트다.
var modifierBits = map[string]uint{"shift": 1, "control": 2, "option": 4, "command": 8}

func inputKey(e *Endpoint, _ *endpointConn, params json.RawMessage) (any, error) {
	window, err := e.window(params)
	if err != nil {
		return nil, err
	}
	var k struct {
		Key       string
		Text      string
		Modifiers []string
		Phase     string
	}
	if err := decode(params, &k); err != nil {
		return nil, err
	}
	if k.Key == "" {
		return nil, rpcError(codeInvalidParams, "key is required")
	}
	if k.Phase != "down" && k.Phase != "up" {
		return nil, rpcError(codeInvalidParams, "phase must be down or up")
	}
	var mask uint
	for _, name := range k.Modifiers {
		bit, ok := modifierBits[name]
		if !ok {
			return nil, rpcError(codeInvalidParams, "modifier %q is not shift, control, option, or command", name)
		}
		mask |= bit
	}
	return nil, e.backend.Key(window, KeyInput{Key: k.Key, Text: k.Text, Modifiers: mask, Down: k.Phase == "down"})
}

// 요청의 메서드 이름. 없는 요청은 빈 문자열이다.
func methodOf(req request) string {
	if req.Method == nil {
		return ""
	}
	return *req.Method
}
