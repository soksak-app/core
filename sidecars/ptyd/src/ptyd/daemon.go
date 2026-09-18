package ptyd

import (
	"bufio"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"log"
	"net"
	"sync"
	"time"
)

// Daemon은 PTY 세션을 관리하는 데몬이다.
type Daemon struct {
	mu sync.Mutex

	identity        DaemonIdentity
	socketDir       string
	listener        net.Listener
	address         string
	idleTimeout     time.Duration
	lastActivity    time.Time
	shutdownChan    chan struct{}

	sessions map[string]*Session
	hints    map[string]string
}

// NewDaemon은 새 데몬을 만든다.
func NewDaemon(identity DaemonIdentity, socketDir string, idleTimeout time.Duration) *Daemon {
	return &Daemon{
		identity:     identity,
		socketDir:    socketDir,
		idleTimeout:  idleTimeout,
		lastActivity: time.Now(),
		shutdownChan: make(chan struct{}),
		sessions:     make(map[string]*Session),
		hints:        make(map[string]string),
	}
}

// Start는 데몬을 시작한다.
func (d *Daemon) Start() error {
	listener, address, err := PrepareListener(d.socketDir, d.identity)
	if err != nil {
		return fmt.Errorf("failed to prepare listener: %w", err)
	}

	d.mu.Lock()
	d.listener = listener
	d.address = address
	d.mu.Unlock()

	log.Printf("ptyd: listening on %s", address)

	go d.acceptLoop()

	if d.idleTimeout > 0 {
		go d.idleCheckLoop()
	}

	return nil
}

// acceptLoop는 클라이언트 연결을 받는다.
func (d *Daemon) acceptLoop() {
	for {
		conn, err := d.listener.Accept()
		if err != nil {
			select {
			case <-d.shutdownChan:
				return
			default:
				log.Printf("ptyd: accept error: %v", err)
				time.Sleep(100 * time.Millisecond)
				continue
			}
		}

		go d.handleClient(conn)
	}
}

// handleClient는 클라이언트 연결을 처리한다.
func (d *Daemon) handleClient(conn net.Conn) {
	defer conn.Close()

	scanner := bufio.NewScanner(conn)
	writer := bufio.NewWriter(conn)

	for scanner.Scan() {
		line := scanner.Bytes()

		req, err := ParseRequest(line)
		if err != nil {
			resp := Response{Error: err.Error()}
			if b, err := EncodeResponse(resp); err == nil {
				writer.Write(b)
				writer.WriteByte('\n')
			}
			writer.Flush()
			continue
		}

		resp := d.handleRequest(req)

		if b, err := EncodeResponse(resp); err == nil {
			writer.Write(b)
			writer.WriteByte('\n')
			writer.Flush()
		}

		d.updateLastActivity()
	}
}

// handleRequest는 요청을 처리하고 응답을 반환한다.
func (d *Daemon) handleRequest(req Request) Response {
	switch req.Command {
	case "open":
		return d.handleOpen(req)
	case "write":
		return d.handleWrite(req)
	case "resize":
		return d.handleResize(req)
	case "signal":
		return d.handleSignal(req)
	case "attach":
		return d.handleAttach(req)
	case "detach":
		return d.handleDetach(req)
	case "close":
		return d.handleClose(req)
	case "list":
		return d.handleList(req)
	case "purge":
		return d.handlePurge(req)
	default:
		return Response{Error: "unknown command: " + req.Command}
	}
}

// handleOpen은 새 세션을 열거나 기존 세션을 찾는다.
func (d *Daemon) handleOpen(req Request) Response {
	d.mu.Lock()
	defer d.mu.Unlock()

	if req.Hint != "" {
		if sessionID, ok := d.hints[req.Hint]; ok {
			if session, ok := d.sessions[sessionID]; ok && !session.Closed() {
				return Response{
					Command:      "open",
					SessionID:    sessionID,
					DefaultCols:  80,
					DefaultRows:  24,
				}
			}
		}
	}

	sessionID := generateSessionID()
	session := NewSession(sessionID, 10000)

	// 기본값
	program := req.Program
	if program == "" {
		program = "/bin/sh"
	}
	cols := req.Cols
	if cols <= 0 {
		cols = 80
	}
	rows := req.Rows
	if rows <= 0 {
		rows = 24
	}

	// PTY 할당 및 프로세스 시작 (플랫폼별)
	// 테스트 환경이 아니면 실제 PTY 할당
	if StartPTYSession != nil {
		handle, err := StartPTYSession(program, req.Args, req.Env, req.Cwd, cols, rows)
		if err != nil {
			return Response{Error: fmt.Sprintf("failed to start session: %v", err)}
		}

		// 세션에 핸들 설정
		reader := GetPTYReader(handle)
		writer := GetPTYWriter(handle)
		session.SetSessionHandle(handle, reader, writer)
	}

	d.sessions[sessionID] = session

	if req.Hint != "" {
		d.hints[req.Hint] = sessionID
	}

	return Response{
		Command:      "open",
		SessionID:    sessionID,
		DefaultCols:  cols,
		DefaultRows:  rows,
	}
}

// handleWrite는 데이터를 세션에 쓴다.
func (d *Daemon) handleWrite(req Request) Response {
	d.mu.Lock()
	session, ok := d.sessions[req.SessionID]
	d.mu.Unlock()

	if !ok {
		return Response{Error: "session not found"}
	}

	if session.Closed() {
		return Response{Error: "session is closed"}
	}

	data, err := base64Decode(req.Data)
	if err != nil {
		return Response{Error: fmt.Sprintf("invalid data: %v", err)}
	}

	if err := session.WriteInput(data); err != nil {
		return Response{Error: err.Error()}
	}

	return Response{Command: "write"}
}

// handleResize는 세션을 리사이즈한다.
func (d *Daemon) handleResize(req Request) Response {
	d.mu.Lock()
	session, ok := d.sessions[req.SessionID]
	d.mu.Unlock()

	if !ok {
		return Response{Error: "session not found"}
	}

	if session.Closed() {
		return Response{Error: "session is closed"}
	}

	if err := session.Resize(req.Cols, req.Rows); err != nil {
		return Response{Error: err.Error()}
	}

	return Response{Command: "resize"}
}

func (d *Daemon) handleSignal(req Request) Response {
	d.mu.Lock()
	session, ok := d.sessions[req.SessionID]
	d.mu.Unlock()

	if !ok {
		return Response{Error: "session not found"}
	}

	if session.Closed() {
		return Response{Error: "session is closed"}
	}

	// 신호 처리 (플랫폼별)
	// darwin의 경우: handle.Kill(sig)
	if err := session.Signal(req.Name); err != nil {
		return Response{Error: err.Error()}
	}

	return Response{Command: "signal"}
}

func (d *Daemon) handleAttach(req Request) Response {
	d.mu.Lock()
	session, ok := d.sessions[req.SessionID]
	d.mu.Unlock()

	if !ok {
		return Response{Error: "session not found"}
	}

	consumer := &Consumer{
		SessionID: req.SessionID,
		Ch:        make(chan RingEntry, 100),
	}

	truncated, entries := session.Attach(consumer, req.From)

	return Response{
		Command:   "attach",
		Truncated: truncated,
		Entries:   entries,
	}
}

func (d *Daemon) handleDetach(req Request) Response {
	d.mu.Lock()
	_, ok := d.sessions[req.SessionID]
	d.mu.Unlock()

	if !ok {
		return Response{Error: "session not found"}
	}

	return Response{Command: "detach"}
}

func (d *Daemon) handleClose(req Request) Response {
	d.mu.Lock()
	session, ok := d.sessions[req.SessionID]
	d.mu.Unlock()

	if !ok {
		return Response{Error: "session not found"}
	}

	if err := session.Close(); err != nil {
		return Response{Error: err.Error()}
	}

	return Response{Command: "close"}
}

func (d *Daemon) handleList(req Request) Response {
	d.mu.Lock()
	defer d.mu.Unlock()

	var sessions []SessionInfo
	for id, session := range d.sessions {
		sessions = append(sessions, SessionInfo{
			SessionID: id,
			Consumers: session.ConsumerCount(),
			Closed:    session.Closed(),
		})
	}

	return Response{
		Command:  "list",
		Sessions: sessions,
	}
}

func (d *Daemon) handlePurge(req Request) Response {
	d.mu.Lock()
	if len(d.sessions) == 0 {
		close(d.shutdownChan)
	}
	d.mu.Unlock()

	return Response{Command: "purge"}
}

// idleCheckLoop는 주기적으로 유휴 타임아웃을 확인한다.
func (d *Daemon) idleCheckLoop() {
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			d.mu.Lock()
			if len(d.sessions) == 0 {
				idle := time.Since(d.lastActivity)
				if idle > d.idleTimeout {
					log.Printf("ptyd: idle timeout reached, shutting down")
					close(d.shutdownChan)
					d.mu.Unlock()
					return
				}
			}
			d.mu.Unlock()
		case <-d.shutdownChan:
			return
		}
	}
}

// Stop은 데몬을 정지한다.
func (d *Daemon) Stop() error {
	d.mu.Lock()
	defer d.mu.Unlock()

	if d.listener != nil {
		d.listener.Close()
	}

	for _, session := range d.sessions {
		session.Close()
	}

	return nil
}

// Wait는 shutdown 신호를 기다린다.
func (d *Daemon) Wait() {
	<-d.shutdownChan
}

// updateLastActivity는 마지막 활동 시간을 업데이트한다.
func (d *Daemon) updateLastActivity() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.lastActivity = time.Now()
}

// Helpers

func generateSessionID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func base64Decode(s string) ([]byte, error) {
	return base64.StdEncoding.DecodeString(s)
}

// 플랫폼별 함수 (darwin/helpers.go에서 정의, init에서 설정)
// StartPTYSession은 PTY 세션을 시작한다 (플랫폼별)
var StartPTYSession func(shell string, args []string, env map[string]string, cwd string, cols, rows int) (any, error)

// GetPTYReader는 PTY 마스터의 Reader를 반환한다
var GetPTYReader func(handle any) any

// GetPTYWriter는 PTY 마스터의 Writer를 반환한다
var GetPTYWriter func(handle any) any

// SignalHandler는 세션에 신호를 보낸다
var SignalHandler func(handle any, sigName string) error

// WaitHandler는 자식이 종료될 때까지 대기하고 종료 코드를 반환한다
var WaitHandler func(handle any) int
