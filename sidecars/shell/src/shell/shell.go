// Package shell 은 셸 사이드카의 요청 처리와 셸 세션을 구현한다.
//
// 한 줄에 JSON 메시지 하나를 사용한다. 형식은 docs/spec/sidecars.md 에 정의한다.
//
//	입력  {"surface": id, "root": 경로, "body": {"operation": "open"}}
//	      {"surface": id, "body": {"operation": "write", "data": 텍스트}}
//	      {"surface": id, "body": {"operation": "run", "id": 요청, "command": 명령}}
//	      {"surface": id, "body": {"operation": "interrupt"}}
//	      {"surface": id, "closed": true}
//	출력  {"surface": id, "body": {"text": 텍스트}}
//	      {"surface": id, "body": {"cwd": 경로}}
//	      {"surface": id, "body": {"id": 요청, "output": 텍스트, "exit": 코드}}
//	      {"surface": id, "body": {"id": 요청, "error": 메시지}}
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
	"os"
	"sync"
)

// Request 는 호스트가 보낸 메시지 하나다.
type Request struct {
	Surface string `json:"surface"`
	Root    string `json:"root,omitempty"`
	Closed  bool   `json:"closed,omitempty"`
	Body    struct {
		Operation string `json:"operation"`
		Data      string `json:"data,omitempty"`
		ID        string `json:"id,omitempty"`
		Command   string `json:"command,omitempty"`
	} `json:"body"`
}

// Event 는 호스트에 보내는 메시지 하나다.
type Event struct {
	Surface string    `json:"surface"`
	Body    EventBody `json:"body"`
}

// EventBody 는 출력 텍스트, 현재 디렉터리, 실행 결과, 요청 실패 중 하나를 담는다. 실행 결과와
// 요청 id 가 있는 요청의 실패는 ID 를 가진다.
type EventBody struct {
	Text   string  `json:"text,omitempty"`
	Cwd    string  `json:"cwd,omitempty"`
	ID     string  `json:"id,omitempty"`
	Output *string `json:"output,omitempty"`
	Exit   *int    `json:"exit,omitempty"`
	Error  string  `json:"error,omitempty"`
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
	shells, err := NewShells(Output{
		Text:      func(id, text string) { send(Event{Surface: id, Body: EventBody{Text: text}}) },
		Directory: func(id, dir string) { send(Event{Surface: id, Body: EventBody{Cwd: dir}}) },
		Finished: func(id, request, output string, exit int, err error) {
			if err != nil {
				send(Event{Surface: id, Body: EventBody{ID: request, Error: err.Error()}})
				return
			}
			send(Event{Surface: id, Body: EventBody{ID: request, Output: &output, Exit: &exit}})
		},
	})
	if err != nil {
		return err
	}
	defer func() {
		if err := shells.CloseAll(); err != nil {
			fmt.Fprintf(os.Stderr, "shell cleanup failed: %v\n", err)
		}
	}()

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
			send(Event{Surface: request.Surface, Body: EventBody{ID: request.Body.ID, Error: err.Error()}})
		}
	}
	return scanner.Err()
}

func handle(shells *Shells, request Request) error {
	if request.Closed {
		return shells.Close(request.Surface)
	}
	switch request.Body.Operation {
	case "open":
		if request.Root == "" {
			return fmt.Errorf("open requires a root")
		}
		_, err := shells.Open(request.Surface, request.Root)
		return err
	case "close":
		return shells.Close(request.Surface)
	case "write":
		return shells.Write(request.Surface, request.Body.Data)
	case "run":
		if request.Body.ID == "" || request.Body.Command == "" {
			return fmt.Errorf("run requires an id and a command")
		}
		return shells.Run(request.Surface, request.Body.ID, request.Body.Command)
	case "interrupt":
		return shells.Interrupt(request.Surface)
	default:
		return fmt.Errorf("unknown operation: %q", request.Body.Operation)
	}
}
