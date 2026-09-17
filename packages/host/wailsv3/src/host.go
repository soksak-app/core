// Package host 는 soksak 워크벤치를 실행하는 Wails v3 네이티브 호스트다.
//
// Wails 가 창과 자산 서버를 제공한다. 이 패키지는 창마다 페이지가 선언한 표면을 네이티브
// 웹뷰로 배치하고, [data-native-modal] 요소를 모달 웹뷰로 표시하고, 사이드카 채널을
// 연결한다. 운영체제별 동작은 platform 패키지가 선택한 구현이 수행한다.
//
// 애플리케이션은 스테이징한 프런트엔드를 frontend/ 아래에 포함한 파일 시스템을 Run 에
// 전달한다. Wails 는 index.html 이 있는 디렉터리를 자산 루트로 사용하므로 창은 "/" 를 연다.
package host

import (
	"io/fs"
	"log"
	"os"
	"path/filepath"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"github.com/min-median-max/soksak/packages/host/wailsv3/src/platform"
	_ "github.com/min-median-max/soksak/packages/host/wailsv3/src/platform/darwin"
	_ "github.com/min-median-max/soksak/packages/host/wailsv3/src/platform/windows"
)

// Options 는 애플리케이션이 명령행에서 읽어 전달하는 값이다.
type Options struct {
	// ConfigDir 은 설정 디렉터리다. 비어 있으면 사용자 설정 디렉터리의 com.soksak.wailsv3 을 사용한다.
	ConfigDir string
	// Observe 는 관측 서비스를 등록할지 나타낸다. 나머지 필드는 관측 서비스가 사용한다.
	Observe Observation
}

// Observation 은 관측 서비스의 시작 동작이다. 각 필드의 형식은 diagnostics.go 에 적는다.
type Observation struct {
	Enabled    bool
	Zoom       bool
	Resize     string
	Drive      string
	Click      string
	Transcript bool
	Capture    string
}

// system 은 Run 이 선택한 운영체제 구현이다.
var system platform.Platform

// Run 은 assets 의 frontend/ 를 자산 루트로 사용하는 애플리케이션을 실행하고, 종료할 때 반환한다.
func Run(assets fs.FS, options Options) error {
	current, err := platform.Current()
	if err != nil {
		return err
	}
	system = current
	frontend, err := fs.Sub(assets, "frontend")
	if err != nil {
		return err
	}
	background, err := fs.ReadFile(frontend, "background.js")
	if err != nil {
		return err
	}
	backgroundScript = string(background)
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	sidecars, err := NewSidecars(frontend, filepath.Dir(executable))
	if err != nil {
		return err
	}
	host, err := newHost(sidecars, options.ConfigDir)
	if err != nil {
		return err
	}
	app := application.New(application.Options{
		Name: "soksak", Description: "soksak layout running in Wails v3",
		Assets:     application.AssetOptions{Handler: application.BundledAssetFileServer(assets)},
		Services:   services(host, options),
		ShouldQuit: host.shouldQuit,
		OnShutdown: sidecars.Stop,
		KeyBindings: map[string]func(application.Window){
			"CmdOrCtrl+Shift+N": func(application.Window) { go host.WindowNew() },
		},
	})
	setupDockMenu(host)
	host.newWindow("main", "/")
	return app.Run()
}

// setupDockMenu 는 애플리케이션이 시작하면 Dock 메뉴를 등록한다.
func setupDockMenu(host *Host) {
	application.Get().Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) {
		application.InvokeSync(func() {
			if err := system.InstallDock(host.WindowNew); err != nil {
				log.Fatal(err)
			}
		})
	})
}
