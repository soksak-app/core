package ptyd

import (
	"bufio"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
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
	started   []*Consumer // attach 응답 후 forwarder를 시작할 소비자 목록
}

// Daemon은 PTY 세션을 관리하는 데몬이다.
type Daemon struct {
	mu           sync.Mutex
	shutdownOnce sync.Once

	identity          DaemonIdentity
	socketDir         string
	listener          net.Listener
	address           string
	idleTimeout       time.Duration
	lastActivity      time.Time
	idleTimerStarted  time.Time // 유휴 기한이 시작된 시간
	activeConnections int       // 활성 연결 수
	shutdownChan      chan struct{}

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

// SocketPath는 데몬이 listen하는 소켓의 경로를 반환한다.
func (d *Daemon) SocketPath() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.address
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

		d.mu.Lock()
		d.activeConnections++
		d.resetIdleTimer()
		d.mu.Unlock()

		go d.handleClient(conn)
	}
}

// handleClient는 클라이언트 연결을 처리한다.
func (d *Daemon) handleClient(conn net.Conn) {
	defer conn.Close()
	defer func() {
		d.mu.Lock()
		d.activeConnections--
		// 0개 세션과 0개 연결이 되면 유휴 기한을 시작
		if len(d.sessions) == 0 && d.activeConnections == 0 {
			d.idleTimerStarted = time.Now()
		}
		d.mu.Unlock()
	}()

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
		// 요청 응답은 요청의 command를 그대로 싣는다
		resp.Command = req.Command

		d.writeResponse(cc, resp)

		// attach 응답 쓴 후, 이번 요청으로 생긴 소비자들의 forwarder를 시작한다
		for _, consumer := range cc.started {
			close(consumer.start)
		}
		cc.started = nil

		d.updateLastActivity()
	}
}

// writeResponse는 응답을 클라이언트에 직렬화해 쓴다.
func (d *Daemon) writeResponse(cc *clientConnection, resp Response) {
	d.writeResponseChecked(cc, resp)
}

// writeResponseChecked는 응답을 클라이언트에 쓰고 성공 여부를 반환한다.
func (d *Daemon) writeResponseChecked(cc *clientConnection, resp Response) bool {
	return d.writeMessageChecked(cc, resp)
}

// writeMessageChecked는 임의의 메시지를 클라이언트에 쓰고 성공 여부를 반환한다.
func (d *Daemon) writeMessageChecked(cc *clientConnection, msg any) bool {
	cc.writeMu.Lock()
	defer cc.writeMu.Unlock()

	b, err := json.Marshal(msg)
	if err != nil {
		// 메시지 인코딩 실패: 로그하고 반환
		log.Printf("ptyd: encode message failed: %v", err)
		return false
	}

	if _, err := cc.writer.Write(b); err != nil {
		log.Printf("ptyd: write message failed: %v", err)
		return false
	}

	if err := cc.writer.WriteByte('\n'); err != nil {
		log.Printf("ptyd: write newline failed: %v", err)
		return false
	}

	if err := cc.writer.Flush(); err != nil {
		log.Printf("ptyd: flush failed: %v", err)
		return false
	}

	return true
}

// cleanupConsumers는 연결의 모든 소비자를 정리한다.
func (d *Daemon) cleanupConsumers(cc *clientConnection) {
	for _, consumer := range cc.consumers {
		d.mu.Lock()
		session, ok := d.sessions[consumer.SessionID]
		sessionID := consumer.SessionID
		d.mu.Unlock()

		if ok {
			session.Detach(consumer)
			// 세션이 이미 끝났고 소비자가 0이 되면 삭제
			d.mu.Lock()
			if session.Closed() && session.ConsumerCount() == 0 {
				d.tryDeleteSession(sessionID)
			}
			d.mu.Unlock()
		}
	}
}

// forwardConsumerOutput는 소비자의 출력을 클라이언트에 전달한다.
// forwarder만 consumer.from을 읽고 쓴다.
// 링이 유일한 출처이고, 소비자는 wake 신호를 받으면 링 전체를 읽는다.
func (d *Daemon) forwardConsumerOutput(cc *clientConnection, consumer *Consumer) {
	// attach 응답이 나갈 때까지 대기
	<-consumer.start

	pendingTruncated := false

	for {
		select {
		case <-consumer.wake:
			// 새 출력 알림. 세션 락 아래에서 oldest를 확인
			d.mu.Lock()
			session, ok := d.sessions[consumer.SessionID]
			d.mu.Unlock()

			if !ok {
				return
			}

			// 세션 락 아래에서 oldest를 확인하고 truncated 처리
			session.mu.Lock()
			var oldest int64
			if len(session.ring) > 0 {
				oldest = session.ring[0].Sequence
			} else {
				oldest = session.nextSeq
			}

			// consumer.from < oldest이면 손실 발생
			if consumer.from < oldest {
				pendingTruncated = true
				consumer.from = oldest
			}

			// consumer.from 이상의 항목들을 복사
			var entriesToSend []RingEntry
			for i, e := range session.ring {
				if e.Sequence >= consumer.from {
					entriesToSend = append(entriesToSend, session.ring[i:]...)
					break
				}
			}
			session.mu.Unlock()

			// 각 항목을 전송
			for i, entry := range entriesToSend {
				// 첫 번째 항목에만 truncated 표시
				truncated := (i == 0) && pendingTruncated

				// entry.Type에 따라 메시지 선택
				var msg any
				switch entry.Type {
				case "output":
					msg = OutputMessage{
						Command:   "output",
						SessionID: consumer.SessionID,
						Sequence:  entry.Sequence,
						Output:    entry.Data,
						Truncated: truncated,
					}
				case "resize":
					msg = ResizeMessage{
						Command:   "resized",
						SessionID: consumer.SessionID,
						Sequence:  entry.Sequence,
						Cols:      entry.Cols,
						Rows:      entry.Rows,
						Truncated: truncated,
					}
				default:
					// 알 수 없는 타입: 로그하고 연결 끊김
					log.Printf("ptyd: unknown entry type in ring: %q (seq %d)", entry.Type, entry.Sequence)
					return
				}

				if !d.writeMessageChecked(cc, msg) {
					// 쓰기 실패: 연결이 끊긴 것
					return
				}

				if i == 0 && pendingTruncated {
					pendingTruncated = false
				}
				consumer.from = entry.Sequence + 1
			}

		case <-consumer.Done:
			// 세션이 종료됨
			d.mu.Lock()
			session, ok := d.sessions[consumer.SessionID]
			d.mu.Unlock()
			exitCode := 0
			if ok {
				exitCode = session.GetExitCode()
			}
			msg := ExitMessage{
				Command:   "exit",
				SessionID: consumer.SessionID,
				Code:      exitCode,
			}
			d.writeMessageChecked(cc, msg)
			// 소비자는 아직 붙어있음. 연결이 끊길 때까지 대기하다가
			// cleanupConsumers에서 detach될 것.
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
					Done:      make(chan struct{}),
				}

				truncated, err := session.Attach(consumer, 0)
				if err != nil {
					return Response{Error: "invalidParams: " + err.Error()}
				}

				cc.consumers = append(cc.consumers, consumer)
				cc.started = append(cc.started, consumer)

				// 출력 전달 고루틴 시작
				go d.forwardConsumerOutput(cc, consumer)

				// truncated 정보는 첫 스트리밍 메시지에 담겨 전송됨
				_ = truncated

				return Response{
					SessionID:   sessionID,
					DefaultCols: 80,
					DefaultRows: 24,
				}
			}
		}
	}

	// cols/rows 검증: 0 이하면 오류 반환
	if req.Cols <= 0 || req.Rows <= 0 {
		return Response{Error: "invalid size: cols and rows must be positive"}
	}

	sessionID, err := generateSessionID()
	if err != nil {
		return Response{Error: err.Error()}
	}
	session := NewSession(sessionID, 10000)

	// 기본값
	program := req.Program
	if program == "" {
		program = "/bin/sh"
	}
	cols := req.Cols
	rows := req.Rows

	// 세션이 자식 없이 종료되면 호출할 콜백 설정
	session.SetOnExit(func() {
		d.mu.Lock()
		d.tryDeleteSession(sessionID)
		// 0개 세션과 0개 연결이 되면 유휴 기한을 시작
		if len(d.sessions) == 0 && d.activeConnections == 0 {
			d.idleTimerStarted = time.Now()
		}
		d.mu.Unlock()
	})

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
		Done:      make(chan struct{}),
	}

	truncated, err := session.Attach(consumer, 0)
	if err != nil {
		return Response{Error: "invalidParams: " + err.Error()}
	}

	cc.consumers = append(cc.consumers, consumer)
	cc.started = append(cc.started, consumer)

	// 출력 전달 고루틴 시작
	go d.forwardConsumerOutput(cc, consumer)

	// truncated 정보는 첫 스트리밍 메시지에 담겨 전송됨
	_ = truncated

	return Response{
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

	return Response{}
}

// handleResize는 세션을 리사이즈한다.
func (d *Daemon) handleResize(req Request) Response {
	// cols/rows 검증
	if req.Cols <= 0 || req.Rows <= 0 {
		return Response{Error: "invalid size: cols and rows must be positive"}
	}

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

	return Response{}
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

	return Response{}
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
		Done:      make(chan struct{}),
	}

	truncated, err := session.Attach(consumer, req.From)
	if err != nil {
		return Response{Error: "invalidParams: " + err.Error()}
	}

	cc.consumers = append(cc.consumers, consumer)
	cc.started = append(cc.started, consumer)

	// 출력 전달 고루틴 시작
	go d.forwardConsumerOutput(cc, consumer)

	// truncated 정보는 첫 스트리밍 메시지에 담겨 전송됨
	_ = truncated

	return Response{}
}

func (d *Daemon) handleDetach(cc *clientConnection, req Request) Response {
	d.mu.Lock()
	session, ok := d.sessions[req.SessionID]
	sessionID := req.SessionID
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

	// 세션이 이미 끝났고 소비자가 0이 되면 삭제
	d.mu.Lock()
	if session.Closed() && session.ConsumerCount() == 0 {
		d.tryDeleteSession(sessionID)
	}
	d.mu.Unlock()

	return Response{}
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

	// 세션을 삭제하려고 시도
	d.mu.Lock()
	d.tryDeleteSession(req.SessionID)
	// 0개 세션과 0개 연결이 되면 유휴 기한을 시작
	if len(d.sessions) == 0 && d.activeConnections == 0 {
		d.idleTimerStarted = time.Now()
	}
	d.mu.Unlock()

	return Response{}
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
		Sessions: sessions,
	}
}

func (d *Daemon) handlePurge(req Request) Response {
	d.mu.Lock()
	if len(d.sessions) == 0 {
		d.requestShutdown()
	}
	d.mu.Unlock()

	return Response{}
}

// idleCheckLoop는 주기적으로 유휴 타임아웃을 확인한다.
func (d *Daemon) idleCheckLoop() {
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			d.mu.Lock()
			// 0개 세션 AND 0개 활성 연결일 때만 유휴 기한 확인
			if len(d.sessions) == 0 && d.activeConnections == 0 {
				idle := time.Since(d.idleTimerStarted)
				if idle > d.idleTimeout {
					log.Printf("ptyd: idle timeout reached, shutting down")
					d.requestShutdown()
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

// requestShutdown signals the daemon to stop exactly once. The caller may hold d.mu.
func (d *Daemon) requestShutdown() {
	d.shutdownOnce.Do(func() { close(d.shutdownChan) })
}

// Shutdown asks the daemon to stop and closes its listener and PTY sessions.
// It is safe to call more than once.
func (d *Daemon) Shutdown() {
	d.requestShutdown()
	_ = d.Stop()
}

// Stop은 데몬을 정지한다.
func (d *Daemon) Stop() error {
	d.mu.Lock()
	defer d.mu.Unlock()

	if d.listener != nil {
		if err := d.listener.Close(); err != nil {
			log.Printf("ptyd: listener close failed: %v", err)
		}
	}

	for _, session := range d.sessions {
		if err := session.Close(); err != nil {
			log.Printf("ptyd: session close failed: %v", err)
		}
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
	d.resetIdleTimer()
}

// resetIdleTimer는 유휴 기한을 리셋한다.
func (d *Daemon) resetIdleTimer() {
	d.idleTimerStarted = time.Now()
}

// tryDeleteSession은 세션이 모두 정리되었으면 목록과 hint에서 삭제한다.
// d.mu가 잠긴 상태에서 호출해야 한다.
func (d *Daemon) tryDeleteSession(sessionID string) {
	session, ok := d.sessions[sessionID]
	if !ok {
		return
	}

	// 세션이 종료되었고 소비자가 없으면 삭제
	if session.Closed() && session.ConsumerCount() == 0 {
		delete(d.sessions, sessionID)
		// hint 테이블에서도 삭제
		for hint, sid := range d.hints {
			if sid == sessionID {
				delete(d.hints, hint)
			}
		}
	}
}

// Helpers

func generateSessionID() (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("cannot generate session id: %w", err)
	}
	return hex.EncodeToString(b), nil
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
