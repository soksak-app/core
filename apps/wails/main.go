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

	host := NewHost()
	app := application.New(application.Options{
		Name: "soksak", Description: "soksak layout running in Wails v3",
		Assets:     application.AssetOptions{Handler: application.BundledAssetFileServer(assets)},
		Services:   services(host),
		ShouldQuit: host.shouldQuit,
		KeyBindings: map[string]func(application.Window){
			"CmdOrCtrl+Shift+N": func(application.Window) { go host.WindowNew() },
		},
	})
	setupDockMenu(host)
	host.newWindow("main", "/")

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}

// services 는 이 애플리케이션이 등록할 서비스 목록이다. 관측은 요청했을 때만 붙는다.
func services(host *Host) []application.Service {
	list := []application.Service{application.NewService(host)}
	if *observing {
		list = append(list, application.NewService(&Observe{}))
	}
	return list
}
