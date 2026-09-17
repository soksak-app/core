// Package shell 은 셸 사이드카의 요청 처리와 셸 세션을 구현한다.
//
// 한 줄에 JSON 메시지 하나를 사용한다. 형식은 docs/spec/sidecars.md 에 정의한다.
//
//	입력  {"surface": id, "root": 경로, "body": {"op": "open"}}
//	      {"surface": id, "body": {"op": "write", "data": 텍스트}}
//	      {"surface": id, "closed": true}
//	출력  {"surface": id, "body": {"text": 텍스트}}
//	      {"surface": id, "body": {"error": 메시지}}
//
// Serve 는 입력이 닫히면 모든 셸을 종료하고 반환한다.
package shell

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"sync"
)

// Request 는 호스트가 보낸 메시지 하나다.
type Request struct {
	Surface string `json:"surface"`
	Root    string `json:"root,omitempty"`
	Closed  bool   `json:"closed,omitempty"`
	Body    struct {
		Op   string `json:"op"`
		Data string `json:"data,omitempty"`
	} `json:"body"`
}

// Event 는 호스트에 보내는 메시지 하나다.
type Event struct {
	Surface string    `json:"surface"`
	Body    EventBody `json:"body"`
}

// EventBody 는 출력 텍스트나 요청 실패 메시지 중 하나를 담는다.
type EventBody struct {
	Text  string `json:"text,omitempty"`
	Error string `json:"error,omitempty"`
}

// Serve 는 in 이 닫힐 때까지 요청을 처리하고 이벤트를 out 에 기록한다.
func Serve(in io.Reader, out io.Writer) error {
	var mu sync.Mutex
	encoder := json.NewEncoder(out)
	send := func(event Event) {
		mu.Lock()
		defer mu.Unlock()
		if err := encoder.Encode(event); err != nil {
			log.Printf("shell sidecar: write event: %v", err)
		}
	}
	shells := NewShells(func(id, text string) { send(Event{Surface: id, Body: EventBody{Text: text}}) })
	defer shells.CloseAll()

	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	for scanner.Scan() {
		var request Request
		if err := json.Unmarshal(scanner.Bytes(), &request); err != nil {
			return fmt.Errorf("invalid request: %w", err)
		}
		if request.Surface == "" {
			return fmt.Errorf("request without surface: %s", scanner.Text())
		}
		if err := handle(shells, request); err != nil {
			send(Event{Surface: request.Surface, Body: EventBody{Error: err.Error()}})
		}
	}
	return scanner.Err()
}

func handle(shells *Shells, request Request) error {
	if request.Closed {
		shells.Close(request.Surface)
		return nil
	}
	switch request.Body.Op {
	case "open":
		if request.Root == "" {
			return fmt.Errorf("open requires a root")
		}
		_, err := shells.Open(request.Surface, request.Root)
		return err
	case "write":
		return shells.Write(request.Surface, request.Body.Data)
	default:
		return fmt.Errorf("unknown op: %q", request.Body.Op)
	}
}
