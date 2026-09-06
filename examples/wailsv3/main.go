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
		// 페이지가 받는 크기다. 창에 제목 표시줄이 없으므로 두 애플리케이션의
		// 설정이 같은 숫자를 갖고 같은 것을 뜻한다. 이 창은 화면에 들어가는
		// 크기여야 한다. 들어가지 않으면 창이 줄어들고, 두 프레임워크가 줄이는
		// 방식이 달라 페이지 크기가 어긋난다.
		Width:            1200,
		Height:           760,
		// 제목 표시줄을 투명하게 두고 콘텐츠가 창 전체를 차지한다. 프레임은
		// 남으므로 모서리, 그림자, 리사이즈, 제목줄 끌기는 OS 의 것이고, 두 설정의
		// 숫자가 같은 것을 뜻하며 페이지가 창 전체를 받는다.
		Mac: application.MacWindow{
			TitleBar: application.MacTitleBarHidden,
			// 창 자신의 단추를 이 자리에 둔다. 페이지의 첫 줄이 45pt 이고 단추가
			// 16pt 이므로, 그 줄의 상하 가운데다. 두 애플리케이션이 같은 값을 쓰고,
			// 페이지의 검증기가 그 결과를 잰다.
			TrafficLightPosition: application.MacTrafficLightPosition{X: 12, Y: 14.5},
		},
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
