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

	shells := NewShells(emitShellOutput)
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
		// 페이지가 받는 크기다. Wails 의 Height 는 콘텐츠 높이이고 Tauri 의
		// tauri.conf.json 은 제목 표시줄을 포함한 창 높이이므로, 두 설정의 숫자는
		// 제목 표시줄만큼 다르고 페이지가 받는 값은 같다. 이 창은 화면에 들어가는
		// 크기여야 한다. 들어가지 않으면 창이 줄어들고, 두 프레임워크가 줄이는
		// 방식이 달라 페이지 크기가 어긋난다.
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
