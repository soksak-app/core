// Package files 는 파일 사이드카의 요청 처리를 구현한다.
//
// 한 줄에 JSON 메시지 하나를 사용한다. 형식은 docs/spec/sidecars.md 의 files 에 정의한다.
//
//	입력  {"surface": id, "root": 경로, "body": {"operation": "list", "id": 요청, "path": 상대 경로}}
//	출력  {"surface": id, "body": {"id": 요청, "entries": [{"name": 이름, "directory": 참거짓}]}}
//	      {"surface": id, "body": {"id": 요청, "error": 메시지}}
//
// 요청 사이에 상태를 갖지 않는다. Serve 는 입력이 닫히면 반환한다.
package files

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Request 는 호스트가 보낸 메시지 하나다.
type Request struct {
	Surface string `json:"surface"`
	Root    string `json:"root,omitempty"`
	Closed  bool   `json:"closed,omitempty"`
	Body    struct {
		Operation string `json:"operation"`
		ID        string `json:"id"`
		Path      string `json:"path"`
	} `json:"body"`
}

// Entry 는 디렉터리 항목 하나다.
type Entry struct {
	Name      string `json:"name"`
	Directory bool   `json:"directory"`
}

// EventBody 는 목록이나 실패 하나를 요청 id 와 함께 담는다.
type EventBody struct {
	ID string `json:"id"`
	// Entries 는 목록의 답에만 있다. 빈 디렉터리는 빈 배열이다.
	Entries *[]Entry `json:"entries,omitempty"`
	Error   string   `json:"error,omitempty"`
}

// Event 는 호스트에 보내는 메시지 하나다.
type Event struct {
	Surface string    `json:"surface"`
	Body    EventBody `json:"body"`
}

// Serve 는 in 이 닫힐 때까지 요청을 처리하고 답을 out 에 기록한다.
func Serve(in io.Reader, out io.Writer) error {
	encoder := json.NewEncoder(out)
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
		// 세션은 상태가 없으므로 닫힘 알림에는 할 일이 없다.
		if request.Closed {
			continue
		}
		body := EventBody{ID: request.Body.ID}
		entries, err := handle(request)
		if err != nil {
			body.Error = err.Error()
		} else {
			body.Entries = &entries
		}
		if err := encoder.Encode(Event{Surface: request.Surface, Body: body}); err != nil {
			return fmt.Errorf("write event: %w", err)
		}
	}
	return scanner.Err()
}

func handle(request Request) ([]Entry, error) {
	if request.Body.Operation != "list" {
		return nil, fmt.Errorf("unknown operation %q", request.Body.Operation)
	}
	if request.Root == "" {
		return nil, fmt.Errorf("list requires a root")
	}
	return List(request.Root, request.Body.Path)
}

// List 는 root 안의 상대 경로 path 에 있는 디렉터리의 항목을 디렉터리 먼저, 각 묶음은 이름순으로 반환한다.
// 심볼릭 링크를 따라간 경로가 root 를 벗어나면 실패한다.
func List(root, path string) ([]Entry, error) {
	if filepath.IsAbs(path) {
		return nil, fmt.Errorf("path %q must be relative to the root", path)
	}
	base, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, err
	}
	target, err := filepath.EvalSymlinks(filepath.Join(base, path))
	if err != nil {
		return nil, err
	}
	inside, err := filepath.Rel(base, target)
	if err != nil || inside == ".." || strings.HasPrefix(inside, ".."+string(filepath.Separator)) {
		return nil, fmt.Errorf("path %q leaves the root", path)
	}
	read, err := os.ReadDir(target)
	if err != nil {
		return nil, err
	}
	entries := make([]Entry, 0, len(read))
	for _, item := range read {
		directory := item.IsDir()
		// 디렉터리를 가리키는 심볼릭 링크도 디렉터리로 보인다. 대상이 없는 링크는 디렉터리가 아니다.
		if item.Type()&os.ModeSymlink != 0 {
			info, err := os.Stat(filepath.Join(target, item.Name()))
			directory = err == nil && info.IsDir()
		}
		entries = append(entries, Entry{Name: item.Name(), Directory: directory})
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Directory != entries[j].Directory {
			return entries[i].Directory
		}
		return entries[i].Name < entries[j].Name
	})
	return entries, nil
}
