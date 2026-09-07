// Runs the soksak example as a real Wails v3 application.
//
// The frontend is built by the example-frontend make target from the
// repository example. Wails roots its asset FS at the directory that holds
// index.html,
// so index.html sits at the frontend root and the window opens "/".
//
// Wails creates the main window. This application creates additional native
// webviews and handles their messages through webview.go; no fork is required.
package main

import (
	"embed"
	"flag"
	"log"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

//go:embed all:frontend
var assets embed.FS

// 창 자신의 단추를 두는 자리. 창의 왼쪽 위에서 잰 점이고, 맨 왼쪽 단추의 왼쪽 위
// 모서리가 여기에 온다. 타우리 호스트가 같은 값을 쓰고, 페이지의 검증기가 그 결과를
// 잰다.
const (
	controlsAtX = 12
	controlsAtY = 14.5
)

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
	connectNativePages(app, surfaces)

	win := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:  "main",
		Title: "soksak / Wails v3",
		// 페이지가 받는 크기다. 창에 제목 표시줄이 없으므로 두 애플리케이션의
		// 설정이 같은 숫자를 갖고 같은 것을 뜻한다. 이 창은 화면에 들어가는
		// 크기여야 한다. 들어가지 않으면 창이 줄어들고, 두 프레임워크가 줄이는
		// 방식이 달라 페이지 크기가 어긋난다.
		Width:  1200,
		Height: 760,
		// 제목 표시줄을 투명하게 두고 콘텐츠가 창 전체를 차지한다. 프레임은
		// 남으므로 모서리, 그림자, 리사이즈, 제목줄 끌기는 OS 의 것이고, 두 설정의
		// 숫자가 같은 것을 뜻하며 페이지가 창 전체를 받는다.
		Mac: application.MacWindow{
			TitleBar: application.MacTitleBarHidden,
		},
		URL:              "/",
		DevToolsEnabled:  true,
		BackgroundColour: application.NewRGB(16, 17, 23),
	})
	// 창의 단추를 페이지의 첫 줄 안에 둔다. 창이 표시된 뒤에 옮긴다: 그 전에는
	// NSWindow 가 없다. 프레임워크의 설정 대신 이 애플리케이션이 직접 두는 이유는
	// native_darwin.go 에 적혀 있다 — AppKit 은 창을 다시 배치할 때마다 단추를
	// 표준 자리로 되돌리고, 창의 크기가 바뀌는 것이 그 배치다.
	// 이벤트 수신자는 자기 고루틴에서 실행되고, AppKit 은 창의 기하를 주 스레드에서만
	// 바꾸게 한다.
	place := func(*application.WindowEvent) {
		application.InvokeSync(func() {
			prepareNativeWindow(win.NativeWindow())
			windowPlaceControls(win.NativeWindow(), controlsAtX, controlsAtY)
		})
	}
	win.OnWindowEvent(events.Common.WindowDidResize, place)
	win.OnWindowEvent(events.Common.WindowShow, place)
	win.OnWindowEvent(events.Mac.WebViewDidCommitNavigation, func(*application.WindowEvent) {
		application.InvokeSync(cancelSurfaceLayout)
		surfaces.discardOverlay()
	})
	win.OnWindowEvent(events.Common.WindowClosing, func(*application.WindowEvent) { dropNativeWebviews() })

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
