package ptyd

import (
	"encoding/base64"
	"fmt"
	"io"
	"sync"
)

// RingEntry는 링 버퍼의 한 항목이다.
type RingEntry struct {
	Sequence int64
	// "output" 또는 "resize"; resize는 cols, rows 값을 갖는다.
	Type string
	// output 타입일 때 base64 인코딩된 데이터. resize일 때는 사용 안 함.
	Data string
	// resize 타입일 때 열 수, 행 수.
	Cols, Rows int
}

// Session은 PTY와 자식 프로세스, 그리고 순번이 붙은 출력 링 버퍼를 갖는다.
type Session struct {
	mu sync.Mutex

	// 세션 정체성
	id string

	// PTY와 프로세스 (플랫폼별)
	sessionHandle  any           // 플랫폼 세션 핸들 (darwin: *platform/darwin.SessionHandle)
	ptmasterReader io.Reader     // PTY 마스터 읽기
	ptmasterWriter io.Writer     // PTY 마스터 쓰기
	closed         bool          // 종료 여부
	exitCode       int           // 종료 코드 (-1 = 실행 중)
	closeChan      chan struct{} // 종료 신호

	// 링 버퍼: 각 항목은 순번과 함께 저장되고, 소비자들에게 배송된다.
	// 링은 최대 크기가 고정되고(예: 10000개 항목), 넘으면 오래된 것부터 버린다.
	ring     []RingEntry
	ringSize int
	nextSeq  int64 // 다음 쓰기의 순번
	totalSeq int64 // 누적 순번 (truncation 판단용)

	// 소비자 추적
	consumers map[*Consumer]bool
}

// Consumer는 세션에 붙은 클라이언트다.
type Consumer struct {
	SessionID string
	from      int64          // 다음 받을 순번
	Ch        chan RingEntry // 소비자가 값을 받을 채널
	Done      chan struct{}  // 종료 신호를 받을 채널
}

// NewSession은 새 세션을 만든다.
func NewSession(id string, ringSize int) *Session {
	if ringSize <= 0 {
		ringSize = 10000
	}
	return &Session{
		id:        id,
		ring:      make([]RingEntry, 0, ringSize),
		ringSize:  ringSize,
		consumers: make(map[*Consumer]bool),
		exitCode:  -1,
		closeChan: make(chan struct{}),
	}
}

// SetSessionHandle은 플랫폼별 세션 핸들을 설정한다.
func (s *Session) SetSessionHandle(handle, readerAny, writerAny any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sessionHandle = handle
	if r, ok := readerAny.(io.Reader); ok {
		s.ptmasterReader = r
	}
	if w, ok := writerAny.(io.Writer); ok {
		s.ptmasterWriter = w
	}

	// 출력 펌프 시작
	go s.readPump()

	// 자식 프로세스 모니터링 시작
	go s.waitForExit()
}

// WriteInput은 입력 데이터를 자식 프로세스에 보낸다.
func (s *Session) WriteInput(data []byte) error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return fmt.Errorf("session %s is closed", s.id)
	}
	writer := s.ptmasterWriter
	s.mu.Unlock()

	if writer == nil {
		return fmt.Errorf("PTY not initialized")
	}

	_, err := writer.Write(data)
	return err
}

// addToRing은 데이터를 링에 추가하고 소비자에게 전달한다.
func (s *Session) addToRing(entry RingEntry) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.closed {
		return
	}

	// 링 추가
	if len(s.ring) >= s.ringSize {
		// 가장 오래된 것 제거
		s.ring = s.ring[1:]
	}
	s.ring = append(s.ring, entry)

	// 모든 소비자에게 전달
	for consumer := range s.consumers {
		if consumer.from == entry.Sequence {
			select {
			case consumer.Ch <- entry:
				consumer.from++
			default:
				// 채널이 가득 차면 무시 (소비자가 처리 못함)
			}
		}
	}
}

// TestWrite는 테스트용 메서드로, 링에 데이터를 추가한다.
func (s *Session) TestWrite(data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.closed {
		return fmt.Errorf("session is closed")
	}

	encoded := base64.StdEncoding.EncodeToString(data)
	seq := s.nextSeq
	s.nextSeq++
	s.totalSeq++

	entry := RingEntry{
		Sequence: seq,
		Type:     "output",
		Data:     encoded,
	}

	// 링 추가
	if len(s.ring) >= s.ringSize {
		s.ring = s.ring[1:]
	}
	s.ring = append(s.ring, entry)

	// 소비자에게 전달
	for consumer := range s.consumers {
		if consumer.from == entry.Sequence {
			select {
			case consumer.Ch <- entry:
				consumer.from++
			default:
			}
		}
	}

	return nil
}

// readPump는 PTY 마스터에서 데이터를 읽고 링에 추가한다.
func (s *Session) readPump() {
	s.mu.Lock()
	reader := s.ptmasterReader
	s.mu.Unlock()

	if reader == nil {
		return
	}

	defer func() {
		s.mu.Lock()
		s.closed = true
		s.mu.Unlock()
	}()

	buf := make([]byte, 4096)
	for {
		n, err := reader.Read(buf)
		if n > 0 {
			s.mu.Lock()
			seq := s.nextSeq
			s.nextSeq++
			s.totalSeq++
			s.mu.Unlock()

			encoded := base64.StdEncoding.EncodeToString(buf[:n])
			entry := RingEntry{
				Sequence: seq,
				Type:     "output",
				Data:     encoded,
			}
			s.addToRing(entry)
		}

		if err != nil {
			// EOF 또는 읽기 오류
			return
		}
	}
}

// Attach는 새 소비자를 세션에 붙인다.
// from: 시작할 순번. truncated는 그 순번이 링을 넘겨 이미 버려졌으면 true.
func (s *Session) Attach(consumer *Consumer, from int64) (truncated bool, entries []RingEntry) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.consumers[consumer] = true
	consumer.from = from

	// 링의 최초 순번
	var minSeq int64
	if len(s.ring) > 0 {
		minSeq = s.ring[0].Sequence
	} else {
		minSeq = s.nextSeq
	}

	// from이 이미 버려진 순번이면 truncated 설정
	if from < minSeq {
		truncated = true
		from = minSeq
		consumer.from = from
	}

	// from 이상의 항목들을 반환
	for i, e := range s.ring {
		if e.Sequence >= from {
			entries = append(entries, s.ring[i:]...)
			break
		}
	}

	return
}

// Detach는 소비자를 제거한다.
func (s *Session) Detach(consumer *Consumer) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.consumers, consumer)
}

// ConsumerCount는 현재 붙은 소비자의 수를 반환한다.
func (s *Session) ConsumerCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.consumers)
}

// Close는 세션을 종료한다.
func (s *Session) Close() error {
	s.mu.Lock()

	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true

	handle := s.sessionHandle
	s.mu.Unlock()

	if handle == nil {
		return nil
	}

	// 플랫폼별 정리 (darwin의 경우 handle은 *darwin.SessionHandle)
	// 이건 daemon에서 타입 단언으로 처리
	// 여기서는 플레이스홀더

	return nil
}

// waitForExit은 자식 프로세스가 종료될 때까지 기다렸다가 상태를 업데이트한다.
func (s *Session) waitForExit() {
	s.mu.Lock()
	handle := s.sessionHandle
	s.mu.Unlock()

	if handle == nil {
		return
	}

	// WaitHandler가 등록되어 있으면 호출
	if WaitHandler != nil {
		code := WaitHandler(handle)
		s.mu.Lock()
		s.exitCode = code
		s.mu.Unlock()

		// 모든 소비자에게 종료 알림
		s.NotifyConsumersOfExit()
	}
}

// Resize는 창 크기를 변경하고 링에 기록한다.
func (s *Session) Resize(cols, rows int) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.closed {
		return fmt.Errorf("session %s is closed", s.id)
	}

	seq := s.nextSeq
	s.nextSeq++
	s.totalSeq++

	entry := RingEntry{
		Sequence: seq,
		Type:     "resize",
		Cols:     cols,
		Rows:     rows,
	}

	// 링에 추가 (addToRing을 직접 인라인)
	if len(s.ring) >= s.ringSize {
		s.ring = s.ring[1:]
	}
	s.ring = append(s.ring, entry)

	return nil
}

// Signal은 자식 프로세스 그룹에 신호를 보낸다.
func (s *Session) Signal(sigName string) error {
	s.mu.Lock()
	handle := s.sessionHandle
	s.mu.Unlock()

	if handle == nil {
		return fmt.Errorf("session not initialized")
	}

	// 플랫폼별 처리
	if SignalHandler != nil {
		return SignalHandler(handle, sigName)
	}

	return fmt.Errorf("signal handler not initialized")
}

// GetExitCode는 자식의 종료 코드를 반환한다 (-1이면 실행 중).
func (s *Session) GetExitCode() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.exitCode
}

// Closed는 세션이 종료되었는지 확인한다.
func (s *Session) Closed() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closed
}

// GetID는 세션 ID를 반환한다.
func (s *Session) GetID() string {
	return s.id
}

// GetNextSeq는 다음 쓰기의 순번을 반환한다.
func (s *Session) GetNextSeq() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.nextSeq
}

// NotifyConsumersOfExit은 모든 소비자에게 세션 종료를 알린다.
func (s *Session) NotifyConsumersOfExit() {
	s.mu.Lock()
	defer s.mu.Unlock()

	for consumer := range s.consumers {
		select {
		case <-consumer.Done:
			// 이미 종료됨
		default:
			close(consumer.Done)
		}
	}
}
