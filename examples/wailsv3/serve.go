// The pages a native view loads.
//
// A view added straight to the window is outside the app's asset server, which
// serves a scheme only the app's own webview resolves. These pages are therefore
// served over http on the loopback address, on a port the system picks.
//
// The server carries the documents and nothing else. A page talks to this app
// over the message channel the view injects (native_darwin.go): WKWebViews share
// one network process with six connections per host, and a page that holds one
// for as long as it lives spends a budget the number of surfaces can exhaust.
package main

import (
	"embed"
	"io/fs"
	"net"
	"net/http"
	"strings"
	"sync"
)

type Pages struct {
	addr     string
	shells   *Shells
	surfaces *Surfaces

	// The theme the page last chose. A view is created with it, so the page it
	// loads has the theme before its first script runs and asks for nothing.
	themeMu sync.Mutex
	theme   Theme
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
	go func() { _ = http.Serve(listener, mux) }()
	return pages, nil
}

// URL turns a page path into one a native view can load.
func (p *Pages) URL(path string) string {
	return "http://" + p.addr + "/" + strings.TrimPrefix(path, "/")
}

// SetTheme records what the page chose and tells the pages already open.
func (p *Pages) SetTheme(theme Theme) {
	p.themeMu.Lock()
	p.theme = theme
	p.themeMu.Unlock()
	if p.surfaces != nil {
		p.surfaces.Tell("theme", theme)
	}
}

// Theme is what a view injects into the page it loads.
func (p *Pages) Theme() Theme {
	p.themeMu.Lock()
	defer p.themeMu.Unlock()
	return p.theme
}

// NotifyModal sends new content to the page rendering that modal.
func (p *Pages) NotifyModal(id string, content OverlayContent) {
	if p.surfaces != nil {
		p.surfaces.deliverModal(id, "content", content)
	}
}
