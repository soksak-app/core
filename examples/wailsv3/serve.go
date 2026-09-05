// The pages a native view loads.
//
// A view added straight to the window is outside the app's asset server, which
// answers a scheme only the app's own webview knows. These pages are therefore
// served over http on the loopback address, on a port the system picks.
//
// The same server carries the terminal traffic: a view added this way has no
// bridge to Go either, so output arrives as an event stream and input as a post.
package main

import (
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"strconv"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"
)

type Pages struct {
	addr     string
	shells   *Shells
	surfaces *Surfaces
}

// Bind lets the pages reach the surfaces once both exist.
func (p *Pages) Bind(surfaces *Surfaces) { p.surfaces = surfaces }

// NewPages starts the server and reports where it is listening.
func NewPages(assets embed.FS, shells *Shells) (*Pages, error) {
	frontend, err := fs.Sub(assets, "frontend")
	if err != nil {
		return nil, err
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	pages := &Pages{addr: listener.Addr().String(), shells: shells}

	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.FS(frontend)))
	mux.HandleFunc("/terminal/open", pages.open)
	mux.HandleFunc("/terminal/write", pages.write)
	mux.HandleFunc("/terminal/stream", pages.stream)
	mux.HandleFunc("/overlay/content", pages.overlayContent)
	mux.HandleFunc("/overlay/fit", pages.overlayFit)
	mux.HandleFunc("/overlay/pick", pages.overlayPick)
	go func() { _ = http.Serve(listener, mux) }()
	return pages, nil
}

// URL turns a page path into one a native view can load.
func (p *Pages) URL(path string) string {
	return "http://" + p.addr + "/" + strings.TrimPrefix(path, "/")
}

func (p *Pages) overlayContent(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(p.surfaces.ModalContent(r.URL.Query().Get("id")))
}

// overlayFit gives the view the size the page found it needs, and reveals it.
func (p *Pages) overlayFit(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	width, _ := strconv.ParseFloat(q.Get("w"), 64)
	height, _ := strconv.ParseFloat(q.Get("h"), 64)
	p.surfaces.ModalFit(q.Get("id"), width, height)
	w.WriteHeader(http.StatusNoContent)
}

// overlayPick tells the main page what was chosen; it decides what it means.
func (p *Pages) overlayPick(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	application.Get().Event.Emit("overlay-pick", map[string]string{
		"id": q.Get("id"), "key": q.Get("key"),
	})
	w.WriteHeader(http.StatusNoContent)
}

func (p *Pages) open(w http.ResponseWriter, r *http.Request) {
	if err := p.shells.Open(r.URL.Query().Get("id")); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (p *Pages) write(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := p.shells.Write(r.URL.Query().Get("id"), string(body)); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// stream sends one shell's output as it arrives, for as long as the page is
// open.
func (p *Pages) stream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "no streaming", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	id := r.URL.Query().Get("id")
	lines := p.shells.Listen(id)
	defer p.shells.Unlisten(id, lines)

	for {
		select {
		case <-r.Context().Done():
			return
		case text, open := <-lines:
			if !open {
				return
			}
			payload, _ := json.Marshal(text)
			fmt.Fprintf(w, "data: %s\n\n", payload)
			flusher.Flush()
		}
	}
}
