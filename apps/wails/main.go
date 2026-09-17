// soksak 워크벤치를 실행하는 Wails v3 애플리케이션.
//
// pnpm run frontend 가 frontend/ 에 프런트엔드를 배치한다. Wails 는 index.html 이 있는
// 디렉터리를 자산 루트로 사용하므로 창은 "/" 를 연다.
//
// Wails 가 메인 창을 생성한다. 추가 네이티브 웹뷰와 그 메시지는 webview.go 가 처리한다.
// 사이드카 채널은 sidecars.go 가 처리한다.
package main

import (
	"embed"
	"flag"
	"io/fs"
	"log"
	"os"
	"path/filepath"

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

	frontend, err := fs.Sub(assets, "frontend")
	if err != nil {
		log.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		log.Fatal(err)
	}
	sidecars, err := NewSidecars(frontend, filepath.Dir(executable))
	if err != nil {
		log.Fatal(err)
	}
	host := NewHost(sidecars)
	app := application.New(application.Options{
		Name: "soksak", Description: "soksak layout running in Wails v3",
		Assets:     application.AssetOptions{Handler: application.BundledAssetFileServer(assets)},
		Services:   services(host),
		ShouldQuit: host.shouldQuit,
		OnShutdown: sidecars.Stop,
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
