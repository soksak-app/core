package host

// main page 의 시작 문서(docs/spec/native-host.md#page-start). page 는 첫 화면을 첫 await 전에 그리도록 이 문서를
// module graph 로 가져오고, host 는 이 요청에 답하기 전에 page 를 시작한다.

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// StartDocumentPath 는 main page 가 시작 문서를 가져오는 경로다.
const StartDocumentPath = "/start.json"

// windowIDHeader 는 Wails 가 webview 의 자원 요청에 붙이는 창 번호 헤더다.
const windowIDHeader = "x-wails-window-id"

// ErrNoStartWindow 는 시작 문서 요청이 어떤 창도 가리키지 않을 때의 오류다.
var ErrNoStartWindow = errors.New("the start document request names no window")

// StartDocument 는 작업 공간 스냅샷과 창 단추 응답을 담은 시작 문서다.
func StartDocument(workspace any, controls Chrome) ([]byte, error) {
	return json.Marshal(struct {
		Workspace any    `json:"workspace"`
		Controls  Chrome `json:"controls"`
	}{workspace, controls})
}

// StartAssets 는 시작 문서 요청을 요청한 창의 번호로 start 에 넘기고, 다른 경로는 next 로 넘긴다. 창을 찾지 못하면
// page 를 시작하지 않고 400 으로, 다른 실패는 500 으로 답한다.
func StartAssets(start func(window uint) ([]byte, error)) application.Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != StartDocumentPath {
				next.ServeHTTP(w, r)
				return
			}
			window, err := strconv.ParseUint(r.Header.Get(windowIDHeader), 10, 0)
			var data []byte
			if err != nil {
				err = ErrNoStartWindow
			} else {
				data, err = start(uint(window))
			}
			if err != nil {
				LogError(StartDocumentPath, err)
				status := http.StatusInternalServerError
				if errors.Is(err, ErrNoStartWindow) {
					status = http.StatusBadRequest
				}
				http.Error(w, err.Error(), status)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-store")
			if _, err := w.Write(data); err != nil {
				LogError(StartDocumentPath, err)
			}
		})
	}
}

// startPage 는 창의 main page 를 시작하고 그 창의 시작 문서를 만든다. 답하기 전에 창을 준비되지 않은 상태로 두고,
// 이전 페이지에 보낸 요청을 끝내고, 이전 페이지의 표면 문서와 그림 영역과 모달을 정리한다.
func (h *Host) startPage(window uint) ([]byte, error) {
	h.mu.Lock()
	s := h.windows[window]
	if s != nil {
		s.ready = false
	}
	h.mu.Unlock()
	if s == nil {
		return nil, ErrNoStartWindow
	}
	h.relay.Abandon(func(t relayTarget) bool { return t.owner == s && t.surface == "" })
	go h.windowsChanged()
	application.InvokeSync(s.reloadSurfaceDocuments)
	s.discardOverlay()
	snapshot, err := h.runWorkspace(WorkspaceRequest{Kind: "snapshot"})
	if err != nil {
		return nil, err
	}
	// 페이지의 첫 그리기는 준비를 기다리지 않으므로 제목줄을 그 첫 행의 높이로 먼저 정하고 controls 를 읽는다
	// (docs/spec/native-surfaces.md#title-bar-height).
	record, ok := snapshot.(Record)
	common, has := record["common"].(Record)
	if !ok || !has {
		return nil, errors.New("the workspace snapshot has no common settings")
	}
	if err := s.startTitlebar(common); err != nil {
		return nil, err
	}
	controls, err := s.WindowChrome()
	if err != nil {
		return nil, err
	}
	return StartDocument(snapshot, controls)
}
