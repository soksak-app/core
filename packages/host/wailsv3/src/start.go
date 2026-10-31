package host

// The start document of the main page (docs/spec/native-host.md#page-start). The page imports this document as the module graph so that it draws the first screen before its first await, and
// the host starts the page before it answers this request.

import (
	"encoding/json"
	"errors"
	"fmt"
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

// StartDocument is the start document that carries the workspace snapshot, or the error of the snapshot in its place, and the window button reply.
func StartDocument(workspace any, workspaceErr error, controls Chrome, pendingSurfaces []string) ([]byte, error) {
	document := struct {
		Workspace       any      `json:"workspace,omitempty"`
		Error           string   `json:"error,omitempty"`
		Controls        Chrome   `json:"controls"`
		PendingSurfaces []string `json:"pendingSurfaces"`
	}{Controls: controls, PendingSurfaces: pendingSurfaces}
	if workspaceErr != nil {
		document.Error = workspaceErr.Error()
	} else {
		document.Workspace = workspace
	}
	return json.Marshal(document)
}

// startParts returns the workspace part and the window button reply of a start document. The title bar is set to the first-row height of the common settings of the snapshot before the
// controls are read (docs/spec/native-surfaces.md#title-bar-height). When the snapshot fails, the title bar takes the height for absent settings and the snapshot error takes the place
// of the workspace, so the page reserves the window button area before it shows the error (docs/spec/native-host.md#page-start).
func startParts(snapshot any, snapshotErr error, titlebar func(Record) error, controls func() (Chrome, error)) (any, error, Chrome, error) {
	common := Record{}
	if snapshotErr == nil {
		record, ok := snapshot.(Record)
		settings, has := record["common"].(Record)
		if ok && has {
			common = settings
		} else {
			snapshotErr = errors.New("the workspace snapshot has no common settings")
		}
	}
	if err := titlebar(common); err != nil {
		return nil, nil, Chrome{}, err
	}
	chrome, err := controls()
	if err != nil {
		return nil, nil, Chrome{}, err
	}
	if snapshotErr != nil {
		return nil, snapshotErr, chrome, nil
	}
	return snapshot, nil, chrome, nil
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
// ends the requests sent to the previous page, and cleans up the surface documents, the image regions and the modals of the previous page.
func (h *Host) startPage(window uint) ([]byte, error) {
	h.mu.Lock()
	s := h.windows[window]
	if s != nil {
		s.ready = false
	}
	h.mu.Unlock()
	if s != nil {
		s.imageDetachPageStarting()
	}
	if s == nil {
		return nil, ErrNoStartWindow
	}
	h.relay.Abandon(func(t relayTarget) bool { return t.owner == s && t.surface == "" })
	routine.Go("windows-changed", h.windowsChanged)
	var detachments []imageDetachTarget
	var reloadErr error
	s.invoke(func() {
		detachments, reloadErr = s.reloadSurfaceDocuments()
		if reloadErr == nil {
			s.disposePluginHosts()
		}
	})
	if reloadErr != nil {
		return nil, fmt.Errorf("page reload: %w", reloadErr)
	}
	if err := s.beginImageDetaches(detachments); err != nil {
		return nil, fmt.Errorf("page reload image detach: %w", err)
	}
	// The plugin sessions of the window end with the previous page, which emits no plugin-host-ended (docs/plans/plugin-host-routes.md rule 7).
	s.sidecars.closePluginSessions(s, func(pluginSession) bool { return true })
	s.discardOverlay()
	snapshot, snapshotErr := h.runWorkspace(WorkspaceRequest{Kind: "snapshot"})
	// The first draw of the page does not wait for the preparation, so the title bar is first set to the height of that first row and then the controls are read.
	// (docs/spec/native-surfaces.md#title-bar-height).
	workspace, workspaceErr, controls, err := startParts(snapshot, snapshotErr, s.startTitlebar, s.WindowChrome)
	if err != nil {
		return nil, err
	}
	// The list is read after the detaches start, so a detach that ends later is told by its image-detach-ended event.
	return StartDocument(workspace, workspaceErr, controls, s.pendingImageDetachSurfaces())
}
