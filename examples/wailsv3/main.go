// Runs the soksak example as a real Wails v3 application.
//
// The frontend is built by examples/sync-frontend.sh from the repository
// example. Wails roots its asset FS at the directory that holds index.html,
// so index.html sits at the frontend root and the window opens "/".
//
// Wails v3 beta.16 creates one webview per window and offers no API to add a
// second webview to one, so a native surface here is a frameless window held
// over the main one. See surfaces.go.
package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v3/pkg/application"
)

//go:embed all:frontend
var assets embed.FS

func main() {
	shells := NewShells()
	pages, err := NewPages(assets, shells)
	if err != nil {
		log.Fatal(err)
	}
	surfaces := NewSurfaces(shells, pages)
	pages.Bind(surfaces)
	app := application.New(application.Options{
		Name:        "soksak",
		Description: "soksak layout running in Wails v3",
		Assets: application.AssetOptions{
			Handler: application.BundledAssetFileServer(assets),
		},
		Services: []application.Service{
			application.NewService(surfaces),
		},
	})

	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:             "main",
		Title:            "soksak / Wails v3",
		Width:            1280,
		Height:           900,
		URL:              "/",
		DevToolsEnabled:  true,
		BackgroundColour: application.NewRGB(16, 17, 23),
	})

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
