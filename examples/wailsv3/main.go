// Runs the soksak example as a real Wails v3 application.
//
// The frontend is built by the example-frontend make target from the
// repository example. Wails roots its asset FS at the directory that holds
// index.html,
// so index.html sits at the frontend root and the window opens "/".
//
// Wails v3 beta.16 creates one webview per window and offers no API to add a
// second webview to one, so a native surface here is a WKWebView this
// application makes and adds to the window's content view. See surfaces.go.
package main

import (
	"embed"
	"flag"
	"log"

	"github.com/wailsapp/wails/v3/pkg/application"
)

//go:embed all:frontend
var assets embed.FS

func main() {
	flag.Parse()

	shells := NewShells()
	surfaces := NewSurfaces(shells)
	app := application.New(application.Options{
		Name:        "soksak",
		Description: "soksak layout running in Wails v3",
		Assets: application.AssetOptions{
			Handler: application.BundledAssetFileServer(assets),
		},
		Services: services(surfaces),
	})

	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:             "main",
		Title:            "soksak / Wails v3",
		Width:            1200,
		Height:           760,
		URL:              "/",
		DevToolsEnabled:  true,
		BackgroundColour: application.NewRGB(16, 17, 23),
	})

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}

// services 는 이 애플리케이션이 등록할 서비스 목록이다. 관측은 요청했을 때만 붙는다.
func services(surfaces *Surfaces) []application.Service {
	list := []application.Service{application.NewService(surfaces)}
	if *observing {
		list = append(list, application.NewService(&Observe{}))
	}
	return list
}
