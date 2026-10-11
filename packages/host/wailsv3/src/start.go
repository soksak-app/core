package host

// The start document of the main page (docs/spec/native-host.md#page-start). The page imports this document as the module graph so that it draws the first screen before its first await, and
// the host starts the page before it answers this request.

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/soksak-app/core/packages/host/wailsv3/src/routine"
)

// StartDocumentPath is the path from which the main page imports the start document.
const StartDocumentPath = "/start.json"

// windowIDHeader is the window number header that Wails attaches to the resource requests of a web view.
const windowIDHeader = "x-wails-window-id"

// ErrNoStartWindow is the error for a start document request that points to no window.
var ErrNoStartWindow = errors.New("the start document request names no window")

// StartDocument is the start document that carries the workspace snapshot and the window button reply.
func StartDocument(workspace any, controls Chrome) ([]byte, error) {
	return json.Marshal(struct {
		Workspace any    `json:"workspace"`
		Controls  Chrome `json:"controls"`
	}{workspace, controls})
}

// StartAssets passes a start document request to start with the number of the requesting window and passes other paths to next. When the window is not found, it answers 400 without starting
// the page, and it answers 500 for other failures.
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

// startPage starts the main page of a window and builds the start document of that window. Before it answers, it leaves the window in the not ready state,
// ends the requests sent to the previous page, and cleans up the surface documents, the picture regions and the modals of the previous page.
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
	routine.Go("windows-changed", h.windowsChanged)
	application.InvokeSync(s.reloadSurfaceDocuments)
	s.discardOverlay()
	snapshot, err := h.runWorkspace(WorkspaceRequest{Kind: "snapshot"})
	if err != nil {
		return nil, err
	}
	// The first draw of the page does not wait for the preparation, so the title bar is first set to the height of that first row and then the controls are read.
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
