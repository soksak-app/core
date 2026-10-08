package host

import (
	"net/http"
	"path"
	"sync"
)

// MissingAssets wraps next and calls report with the path of each page file that next answers with 404, once for
// each path. A path without a file extension is a document route and is not reported (docs/spec/diagnostics.md).
func MissingAssets(next http.Handler, report func(path string)) http.Handler {
	var mutex sync.Mutex
	reported := map[string]bool{}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(&statusWriter{ResponseWriter: w, notFound: func() {
			if path.Ext(r.URL.Path) == "" {
				return
			}
			mutex.Lock()
			first := !reported[r.URL.Path]
			reported[r.URL.Path] = true
			mutex.Unlock()
			if first {
				report(r.URL.Path)
			}
		}}, r)
	})
}

// statusWriter calls notFound when the response status is 404.
type statusWriter struct {
	http.ResponseWriter
	notFound func()
}

func (w *statusWriter) WriteHeader(status int) {
	if status == http.StatusNotFound {
		w.notFound()
	}
	w.ResponseWriter.WriteHeader(status)
}

// reportMissingAsset writes the error line of a page file that the host cannot serve.
func reportMissingAsset(path string) {
	LogError("page asset", path+": not found")
}
