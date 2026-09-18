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

// clientConnection은 클라이언트 연결의 상태를 추적한다.
type clientConnection struct {
	conn      net.Conn
	writer    *bufio.Writer
	writeMu   sync.Mutex // 쓰기 직렬화
	consumers []*Consumer
}

// OutputMessage는 연결으로 전송할 출력 메시지다.
type OutputMessage struct {
	Entry     RingEntry
	Truncated bool
}

// Daemon은 PTY 세션을 관리하는 데몬이다.
type Daemon struct {
	mu sync.Mutex

	identity     DaemonIdentity
	socketDir    string
	listener     net.Listener
	address      string
	idleTimeout  time.Duration
	lastActivity time.Time
	shutdownChan chan struct{}

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

	cc := &clientConnection{
		conn:   conn,
		writer: bufio.NewWriter(conn),
	}
	defer d.cleanupConsumers(cc)

	scanner := bufio.NewScanner(conn)

	for scanner.Scan() {
		line := scanner.Bytes()

		req, err := ParseRequest(line)
		if err != nil {
			resp := Response{Error: err.Error()}
			d.writeResponse(cc, resp)
			continue
		}

		resp := d.handleRequest(cc, req)

		d.writeResponse(cc, resp)

		d.updateLastActivity()
	}
}

// writeResponse는 응답을 클라이언트에 직렬화해 쓴다.
func (d *Daemon) writeResponse(cc *clientConnection, resp Response) {
	cc.writeMu.Lock()
	defer cc.writeMu.Unlock()

	if b, err := EncodeResponse(resp); err == nil {
		cc.writer.Write(b)
		cc.writer.WriteByte('\n')
		cc.writer.Flush()
	}
}

// cleanupConsumers는 연결의 모든 소비자를 정리한다.
func (d *Daemon) cleanupConsumers(cc *clientConnection) {
	for _, consumer := range cc.consumers {
		d.mu.Lock()
		session, ok := d.sessions[consumer.SessionID]
		d.mu.Unlock()

		if ok {
			session.Detach(consumer)
		}
	}
}

// forwardConsumerOutput는 소비자의 출력을 클라이언트에 전달한다.
func (d *Daemon) forwardConsumerOutput(cc *clientConnection, consumer *Consumer) {
	// 실시간 출력을 기다림
	for {
		select {
		case entry, ok := <-consumer.Ch:
			if !ok {
				return
			}
			resp := Response{
				Command:   "output",
				SessionID: consumer.SessionID,
				Output:    entry.Data,
				Sequence:  entry.Sequence,
			}
			d.writeResponse(cc, resp)

		case <-consumer.Done:
			// 세션이 종료됨
			resp := Response{
				Command:   "exit",
				SessionID: consumer.SessionID,
			}
			d.writeResponse(cc, resp)
			return
		}
	}
}

// handleRequest는 요청을 처리하고 응답을 반환한다.
func (d *Daemon) handleRequest(cc *clientConnection, req Request) Response {
	switch req.Command {
	case "open":
		return d.handleOpen(cc, req)
	case "write":
		return d.handleWrite(req)
	case "resize":
		return d.handleResize(req)
	case "signal":
		return d.handleSignal(req)
	case "attach":
		return d.handleAttach(cc, req)
	case "detach":
		return d.handleDetach(cc, req)
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
func (d *Daemon) handleOpen(cc *clientConnection, req Request) Response {
	d.mu.Lock()
	defer d.mu.Unlock()

	if req.Hint != "" {
		if sessionID, ok := d.hints[req.Hint]; ok {
			if session, ok := d.sessions[sessionID]; ok && !session.Closed() {
				// 기존 세션을 찾음. 이 연결을 소비자로 등록
				consumer := &Consumer{
					SessionID: sessionID,
					Ch:        make(chan RingEntry, 100),
					Done:      make(chan struct{}),
				}

				truncated, entries := session.Attach(consumer, 0)

				cc.consumers = append(cc.consumers, consumer)

				// 출력 전달 고루틴 시작
				go d.forwardConsumerOutput(cc, consumer)

				// 기존 항목들 전송 (truncated는 첫 번째 항목에만 표시)
				for i, entry := range entries {
					showTruncated := truncated && i == 0
					resp := Response{
						Command:   "output",
						SessionID: sessionID,
						Output:    entry.Data,
						Sequence:  entry.Sequence,
						Truncated: showTruncated,
					}
					d.writeResponse(cc, resp)
				}

				return Response{
					Command:     "open",
					SessionID:   sessionID,
					DefaultCols: 80,
					DefaultRows: 24,
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

	// 이 연결을 소비자로 등록
	consumer := &Consumer{
		SessionID: sessionID,
		Ch:        make(chan RingEntry, 100),
		Done:      make(chan struct{}),
	}

	session.Attach(consumer, 0)
	cc.consumers = append(cc.consumers, consumer)

	// 출력 전달 고루틴 시작
	go d.forwardConsumerOutput(cc, consumer)

	return Response{
		Command:     "open",
		SessionID:   sessionID,
		DefaultCols: cols,
		DefaultRows: rows,
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

func (d *Daemon) handleAttach(cc *clientConnection, req Request) Response {
	d.mu.Lock()
	session, ok := d.sessions[req.SessionID]
	d.mu.Unlock()

	if !ok {
		return Response{Error: "session not found"}
	}

	consumer := &Consumer{
		SessionID: req.SessionID,
		Ch:        make(chan RingEntry, 100),
		Done:      make(chan struct{}),
	}

	truncated, entries := session.Attach(consumer, req.From)

	cc.consumers = append(cc.consumers, consumer)

	// 출력 전달 고루틴 시작
	go d.forwardConsumerOutput(cc, consumer)

	// 기존 항목들 전송 (truncated는 첫 번째 항목에만 표시)
	for i, entry := range entries {
		showTruncated := truncated && i == 0
		resp := Response{
			Command:   "output",
			SessionID: req.SessionID,
			Output:    entry.Data,
			Sequence:  entry.Sequence,
			Truncated: showTruncated,
		}
		d.writeResponse(cc, resp)
	}

	return Response{
		Command:   "attach",
		Truncated: truncated,
	}
}

func (d *Daemon) handleDetach(cc *clientConnection, req Request) Response {
	d.mu.Lock()
	session, ok := d.sessions[req.SessionID]
	d.mu.Unlock()

	if !ok {
		return Response{Error: "session not found"}
	}

	// cc의 consumer 목록에서 이 sessionID에 해당하는 consumer를 찾아 제거
	for i, consumer := range cc.consumers {
		if consumer.SessionID == req.SessionID {
			session.Detach(consumer)
			cc.consumers = append(cc.consumers[:i], cc.consumers[i+1:]...)
			break
		}
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
