// Package host 는 soksak 워크벤치를 실행하는 Wails v3 네이티브 호스트다.
//
// Wails 가 창과 자산 서버를 제공한다. 이 패키지는 창마다 페이지가 선언한 표면을 네이티브
// 웹뷰로 배치하고, [data-native-modal] 요소를 모달 웹뷰로 표시하고, 사이드카 채널을
// 연결하고, 로컬 엔드포인트로 노출 항목을 제공한다. 운영체제별 동작은 platform 패키지가 선택한 구현이 수행한다.
//
// 애플리케이션은 스테이징한 프런트엔드를 frontend/ 아래에 포함한 파일 시스템을 Run 에
// 전달한다. Wails 는 index.html 이 있는 디렉터리를 자산 루트로 사용하므로 창은 "/" 를 연다.
package host

import (
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"time"

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
}

// 엔드포인트가 알리는 애플리케이션 이름과 버전.
const (
	applicationName    = "wailsv3"
	applicationVersion = "0.0.1"
)

// system 은 Run 이 선택한 운영체제 구현이다.
var system platform.Platform

// Run 은 assets 의 frontend/ 를 자산 루트로 사용하는 애플리케이션을 실행하고, 종료할 때 반환한다.
func Run(assets fs.FS, options Options) error {
	current, err := platform.Current()
	if err != nil {
		return err
	}
	system = current
	// 창 확대 애니메이션은 창 프레임만 움직이고 웹 문서는 그 뒤에 따라온다. AppKit 이 기본값을
	// 읽기 전에 그 길이를 줄인다.
	if err := system.InstantWindowResize(); err != nil {
		return err
	}
	// 종료 신호는 엔드포인트를 만들기 전부터 받는다. 일반 종료는 애플리케이션이 시작한 뒤에
	// 요청한다. 일반 종료는 준비된 창의 저장을 마친 뒤 엔드포인트를 닫는다.
	started := make(chan struct{})
	if err := system.OnTermination(func() {
		<-started
		application.Get().Quit()
	}); err != nil {
		return err
	}
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
	// 엔드포인트는 창을 표시하기 전에 만든다. 만들 수 없으면 애플리케이션을 시작하지 않는다.
	listener, address, err := system.Listen(SocketDirectory(), applicationName)
	if err != nil {
		return fmt.Errorf("local endpoint: %w", err)
	}
	host.endpoint = NewEndpoint(hostBackend{host})
	info := EndpointInfo{Transport: address.Transport, Address: address.Address, PID: os.Getpid(),
		Application: applicationName, Version: applicationVersion, Started: time.Now()}
	if err := host.endpoint.Serve(listener, info, host.workspace.directory); err != nil {
		listener.Close()
		return fmt.Errorf("local endpoint: %w", err)
	}
	defer host.endpoint.Close()
	app := application.New(application.Options{
		Name: "soksak", Description: "soksak layout running in Wails v3",
		Assets:     application.AssetOptions{Handler: application.BundledAssetFileServer(assets)},
		Services:   []application.Service{application.NewService(host)},
		ShouldQuit: host.shouldQuit,
		// Wails 의 기본 신호 처리기는 만들어지기만 하고 시작되지 않는다(v3.0.0-beta.16).
		// Run 이 등록한 처리기가 종료 신호를 받는다.
		DisableDefaultSignalHandler: true,
		OnShutdown: func() {
			sidecars.Stop()
			if err := host.endpoint.Close(); err != nil {
				log.Printf("local endpoint: %v", err)
			}
		},
		KeyBindings: map[string]func(application.Window){
			"CmdOrCtrl+Shift+N": func(application.Window) { go host.WindowNew() },
		},
	})
	app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) {
		close(started)
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
