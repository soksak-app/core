package host_test

import (
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

// contract: assets.missing.writes-one-error-line-for-each-path
func TestMissingAssetsReportEachPathOnce(t *testing.T) {
	var reported []string
	served := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/present.js" || r.URL.Path == "/" {
			w.Write([]byte("ok"))
			return
		}
		http.NotFound(w, r)
	})
	handler := host.MissingAssets(served, func(path string) { reported = append(reported, path) })
	for _, path := range []string{"/present.js", "/missing.js", "/missing.js", "/other.css", "/", "/no-extension"} {
		handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, path, nil))
	}
	if want := []string{"/missing.js", "/other.css"}; !slices.Equal(reported, want) {
		t.Fatalf("reported %v, want %v", reported, want)
	}
}

// contract: assets.missing.runtime-optional-file-is-not-reported
func TestMissingAssetsDoNotReportTheOptionalFileOfTheRuntime(t *testing.T) {
	var reported []string
	handler := host.MissingAssets(http.NotFoundHandler(), func(path string) { reported = append(reported, path) })
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/wails/custom.js", nil))
	if len(reported) != 0 {
		t.Fatalf("reported %v", reported)
	}
}
