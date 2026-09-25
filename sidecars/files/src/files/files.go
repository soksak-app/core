// Package files 는 파일 사이드카의 요청 처리를 구현한다.
//
// 한 줄에 JSON 메시지 하나를 사용한다. 형식은 docs/spec/sidecars.md 의 files 에 정의한다.
//
//	입력  {"surface": id, "root": 경로, "body": {"operation": "list", "id": 요청, "path": 상대 경로}}
//	      {"surface": id, "root": 경로, "body": {"operation": "watch", "id": 요청, "paths": [상대 경로]}}
//	      {"surface": id, "root": 경로, "body": {"operation": "git", "id": 요청}}
//	      {"surface": id, "closed": true}
//	출력  {"surface": id, "body": {"id": 요청, "entries": [{"name": 이름, "directory": 참거짓}]}}
//	      {"surface": id, "body": {"id": 요청, "entries": [{"path": 상대 경로, "status": 상태}]}}
//	      {"surface": id, "body": {"id": 요청}}
//	      {"surface": id, "body": {"changed": 상대 경로}}
//	      {"surface": id, "body": {"id": 요청, "error": 메시지}}
//
// 세션은 감시하는 디렉터리만 상태로 갖는다. Serve 는 입력이 닫히면 모든 감시를 끝내고 반환한다.
package files

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/min-median-max/soksak/sidecars/files/src/platform"
	_ "github.com/min-median-max/soksak/sidecars/files/src/platform/darwin"
	_ "github.com/min-median-max/soksak/sidecars/files/src/platform/linux"
	_ "github.com/min-median-max/soksak/sidecars/files/src/platform/windows"
)

// Request 는 호스트가 보낸 메시지 하나다.
type Request struct {
	Surface string `json:"surface"`
	Root    string `json:"root,omitempty"`
	Closed  bool   `json:"closed,omitempty"`
	Body    struct {
		Operation string   `json:"operation"`
		ID        string   `json:"id"`
		Path      string   `json:"path"`
		Paths     []string `json:"paths"`
	} `json:"body"`
}

// Entry 는 디렉터리 항목 하나다.
type Entry struct {
	Name      string `json:"name"`
	Directory bool   `json:"directory"`
}

// EventBody 는 요청의 답(목록, 감시 확인, 실패)이나 감시한 디렉터리의 변경 하나를 담는다.
type EventBody struct {
	ID string `json:"id,omitempty"`
	// Entries 는 목록([]Entry)과 git 상태([]GitEntry)의 답에만 있다. 항목이 없으면 빈 배열이다.
	Entries any `json:"entries,omitempty"`
	// Changed 는 항목이 바뀐 감시 디렉터리의 상대 경로다. 프로젝트 폴더는 빈 문자열이다.
	Changed *string `json:"changed,omitempty"`
	Error   string  `json:"error,omitempty"`
}

// Event 는 호스트에 보내는 메시지 하나다.
type Event struct {
	Surface string    `json:"surface"`
	Body    EventBody `json:"body"`
}

// Serve 는 in 이 닫힐 때까지 요청을 처리하고 답과 변경을 out 에 기록한다.
func Serve(in io.Reader, out io.Writer) error {
	var mu sync.Mutex
	encoder := json.NewEncoder(out)
	var writeErr error
	send := func(event Event) {
		mu.Lock()
		defer mu.Unlock()
		if err := encoder.Encode(event); err != nil && writeErr == nil {
			writeErr = fmt.Errorf("write event: %w", err)
		}
	}
	written := func() error {
		mu.Lock()
		defer mu.Unlock()
		return writeErr
	}
	watches := newWatches(send)
	defer watches.closeAll()
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
		if request.Closed {
			if err := watches.set(request.Surface, "", nil); err != nil {
				send(Event{Surface: request.Surface, Body: EventBody{Error: err.Error()}})
			}
		} else {
			body := EventBody{ID: request.Body.ID}
			if err := handle(watches, request, &body); err != nil {
				body = EventBody{ID: request.Body.ID, Error: err.Error()}
			}
			send(Event{Surface: request.Surface, Body: body})
		}
		if err := written(); err != nil {
			return err
		}
	}
	return scanner.Err()
}

func handle(watches *watches, request Request, body *EventBody) error {
	if request.Root == "" {
		return fmt.Errorf("%s requires a root", request.Body.Operation)
	}
	switch request.Body.Operation {
	case "list":
		entries, err := List(request.Root, request.Body.Path)
		if err != nil {
			return err
		}
		body.Entries = entries
		return nil
	case "git":
		entries, err := GitStatus(request.Root)
		if err != nil {
			return err
		}
		body.Entries = entries
		return nil
	case "watch":
		return watches.set(request.Surface, request.Root, request.Body.Paths)
	default:
		return fmt.Errorf("unknown operation %q", request.Body.Operation)
	}
}

// watches 는 세션마다 감시 중인 디렉터리의 멈춤 함수다.
type watches struct {
	mu       sync.Mutex
	send     func(Event)
	sessions map[string][]func() error
}

func newWatches(send func(Event)) *watches {
	return &watches{send: send, sessions: map[string][]func() error{}}
}

// set 은 세션의 감시를 paths 로 바꾼다. 경로 하나라도 실패하면 새 감시를 모두 끝내고 실패한다.
func (w *watches) set(surface, root string, paths []string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	var errs []error
	for _, stop := range w.sessions[surface] {
		errs = append(errs, stop())
	}
	delete(w.sessions, surface)
	if err := errors.Join(errs...); err != nil {
		return err
	}
	if len(paths) == 0 {
		return nil
	}
	current, err := platform.Current()
	if err != nil {
		return err
	}
	stops := make([]func() error, 0, len(paths))
	for _, path := range paths {
		stop, err := w.watch(current, surface, root, path)
		if err != nil {
			for _, started := range stops {
				err = errors.Join(err, started())
			}
			return err
		}
		stops = append(stops, stop)
	}
	w.sessions[surface] = stops
	return nil
}

func (w *watches) watch(current platform.Platform, surface, root, path string) (func() error, error) {
	dir, err := resolve(root, path)
	if err != nil {
		return nil, err
	}
	changed := path
	return current.Watch(dir, func() {
		w.send(Event{Surface: surface, Body: EventBody{Changed: &changed}})
	}, func(failure error) {
		w.send(Event{Surface: surface, Body: EventBody{Error: failure.Error()}})
	})
}

func (w *watches) closeAll() {
	w.mu.Lock()
	defer w.mu.Unlock()
	for surface, stops := range w.sessions {
		for _, stop := range stops {
			if err := stop(); err != nil {
				w.send(Event{Surface: surface, Body: EventBody{Error: err.Error()}})
			}
		}
	}
	w.sessions = map[string][]func() error{}
}

// resolve 는 root 안의 상대 경로 path 를 심볼릭 링크를 따라간 절대 경로로 반환한다. root 를 벗어나면 실패한다.
func resolve(root, path string) (string, error) {
	if filepath.IsAbs(path) {
		return "", fmt.Errorf("path %q must be relative to the root", path)
	}
	base, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", err
	}
	target, err := filepath.EvalSymlinks(filepath.Join(base, path))
	if err != nil {
		return "", err
	}
	inside, err := filepath.Rel(base, target)
	if err != nil || inside == ".." || strings.HasPrefix(inside, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("path %q leaves the root", path)
	}
	return target, nil
}

// List 는 root 안의 상대 경로 path 에 있는 디렉터리의 항목을 디렉터리 먼저, 각 묶음은 이름순으로 반환한다.
// 심볼릭 링크를 따라간 경로가 root 를 벗어나면 실패한다.
func List(root, path string) ([]Entry, error) {
	target, err := resolve(root, path)
	if err != nil {
		return nil, err
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
