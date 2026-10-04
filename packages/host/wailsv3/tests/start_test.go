package host_test

// main page 의 시작 문서(docs/spec/native-host.md#page-start)를 검사한다.

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

// contract: page.start.document
func TestStartDocumentCarriesTheWorkspaceAndTheWindowControls(t *testing.T) {
	data, err := host.StartDocument(map[string]any{"common": map[string]any{}, "projects": []any{}},
		host.Chrome{Controls: host.Rect{X: 7, Y: 8, W: 52, H: 14}, Row: 32})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"workspace":{"common":{},"projects":[]},"controls":{"controls":{"x":7,"y":8,"w":52,"h":14},"row":32}}`
	if string(data) != want {
		t.Fatalf("start document %s", data)
	}
}

// contract: page.start.requires-window
func TestStartAssetsStartTheRequestingWindowOnly(t *testing.T) {
	var started []uint
	start := func(window uint) ([]byte, error) {
		started = append(started, window)
		switch window {
		case 8:
			return nil, host.ErrNoStartWindow
		case 9:
			return nil, errors.New("window 9 has no title bar")
		}
		return []byte(`{"workspace":{},"controls":null}`), nil
	}
	frontend := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "frontend "+r.URL.Path) })
	handler := host.StartAssets(start)(frontend)
	get := func(path, window string) (int, string, string, string) {
		request := httptest.NewRequest(http.MethodGet, path, nil)
		if window != "" {
			request.Header.Set("x-wails-window-id", window)
		}
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		return recorder.Code, recorder.Body.String(), recorder.Header().Get("Content-Type"), recorder.Header().Get("Cache-Control")
	}
	if code, body, kind, cache := get(host.StartDocumentPath, "3"); code != 200 || body != `{"workspace":{},"controls":null}` ||
		kind != "application/json" || cache != "no-store" {
		t.Fatalf("start document %d %q %q %q", code, body, kind, cache)
	}
	if code, body, _, _ := get(host.StartDocumentPath, ""); code != 400 || body != "the start document request names no window\n" {
		t.Fatalf("request without a window %d %q", code, body)
	}
	if code, body, _, _ := get(host.StartDocumentPath, "x"); code != 400 || body != "the start document request names no window\n" {
		t.Fatalf("request with an invalid window %d %q", code, body)
	}
	if code, body, _, _ := get(host.StartDocumentPath, "8"); code != 400 || body != "the start document request names no window\n" {
		t.Fatalf("request for a missing window %d %q", code, body)
	}
	if code, body, _, _ := get(host.StartDocumentPath, "9"); code != 500 || body != "window 9 has no title bar\n" {
		t.Fatalf("failed start %d %q", code, body)
	}
	if code, body, _, _ := get("/index.html", "3"); code != 200 || body != "frontend /index.html" {
		t.Fatalf("other path %d %q", code, body)
	}
	if len(started) != 3 || started[0] != 3 || started[1] != 8 || started[2] != 9 {
		t.Fatalf("started windows %v", started)
	}
}
