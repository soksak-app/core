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
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"github.com/min-median-max/soksak/packages/host/wailsv3/src/platform"
	_ "github.com/min-median-max/soksak/packages/host/wailsv3/src/platform/darwin"
	_ "github.com/min-median-max/soksak/packages/host/wailsv3/src/platform/windows"
	// plugin 작업(plugins.go)은 command line 의 installer library 를 쓰므로 그 platform 구현도 등록한다.
	_ "github.com/min-median-max/soksak/packages/sok/wailsv3/src/platform/darwin"
	_ "github.com/min-median-max/soksak/packages/sok/wailsv3/src/platform/windows"
)

// ApplicationIdentifier 는 애플리케이션 번들 식별자이며 기본 설정 디렉터리의 이름이다(docs/spec/projects.md). 번들의
// Info.plist 와 같은 값이다.
const ApplicationIdentifier = "com.soksak.wails"

// Options 는 애플리케이션이 명령행에서 읽어 전달하는 값이다.
type Options struct {
	// ConfigDir 은 설정 디렉터리다. 비어 있으면 사용자 설정 디렉터리의 ApplicationIdentifier 디렉터리를 사용한다.
	ConfigDir string
}

// 엔드포인트가 알리는 애플리케이션 이름과 버전.
const (
	applicationName    = "wailsv3"
	applicationVersion = "0.0.2"
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
	configDirectory := options.ConfigDir
	if configDirectory == "" {
		config, err := os.UserConfigDir()
		if err != nil {
			return err
		}
		configDirectory = filepath.Join(config, ApplicationIdentifier)
	}
	configDirectory, err = PrepareConfigDirectory(configDirectory)
	if err != nil {
		return fmt.Errorf("config directory: %w", err)
	}
	if err := PerformanceDisable(configDirectory); err != nil {
		return fmt.Errorf("reset performance switch: %w", err)
	}
	// 지난 실행이 남긴 WebKit 자식을 기록으로 수확하고, 남의 것을 덮지 않게 지금 떠 있는
	// WebKit 을 기준선으로 찍는다(V5-113). 아직 창이 없으므로 이 실행의 WebKit 은 없다.
	ReapRecordedWebKit(configDirectory)
	SnapshotBaseline()
	declarations, err := InstalledSidecars(configDirectory)
	if err != nil {
		return fmt.Errorf("installed plugins: %w", err)
	}
	sidecars, err := NewSidecars(declarations, configDirectory)
	if err != nil {
		return err
	}
	host, err := newHost(sidecars, configDirectory)
	if err != nil {
		return err
	}
	// 엔드포인트는 창을 표시하기 전에 만든다. 만들 수 없으면 애플리케이션을 시작하지 않는다.
	// endpoint.json 은 첫 창을 등록하고 애플리케이션이 시작한 뒤 쓴다.
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
		Assets: application.AssetOptions{Handler: application.BundledAssetFileServer(assets), Middleware: func(next http.Handler) http.Handler {
			return StartAssets(host.startPage)(InstalledAssets(configDirectory)(next))
		}},
		Services:   []application.Service{application.NewService(host)},
		ShouldQuit: host.shouldQuit,
		// Wails 의 기본 신호 처리기는 만들어지기만 하고 시작되지 않는다(v3.0.0-beta.16).
		// Run 이 등록한 처리기가 종료 신호를 받는다.
		DisableDefaultSignalHandler: true,
		OnShutdown: func() {
			// 종료 전에 모든 창의 웹 프로세스를 죽인다. AppKit 은 XPC 서비스를 클라이언트보다
			// 오래 살려두므로(V5-105), 죽이지 않으면 WebContent·GPU·Networking 프로세스가
			// 앱 종료 후에도 남아 메모리를 차지한다.
			host.mu.Lock()
			shutdown := make([]*application.WebviewWindow, 0, len(host.windows))
			for _, s := range host.windows {
				shutdown = append(shutdown, s.window)
			}
			host.mu.Unlock()
			for _, win := range shutdown {
				window := win
				application.InvokeSync(func() {
					if main, err := system.MainWebview(window.NativeWindow()); err == nil {
						if err := system.KillWebContentProcess(main); err != nil {
							log.Printf("shutdown web content kill: %v", err)
						}
					}
				})
			}
			sidecars.Stop()
			if err := host.endpoint.Close(); err != nil {
				log.Printf("local endpoint: %v", err)
			}
		},
	})
	// 클라이언트는 endpoint.json 을 읽자마자 첫 창에 요청하므로 창을 등록한 뒤 쓴다. 쓰지 못하면
	// 애플리케이션을 끝내고 그 오류를 반환한다.
	unpublished := make(chan error, 1)
	app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) {
		close(started)
		// 알림 센터를 쓸 수 없으면 애플리케이션을 시작하지 않는다(docs/spec/hosts.md).
		if err := host.startNotifications(); err != nil {
			unpublished <- err
			app.Quit()
			return
		}
		if err := host.endpoint.Publish("main"); err != nil {
			unpublished <- fmt.Errorf("local endpoint: %w", err)
			app.Quit()
		}
	})
	// 메뉴의 새 창 항목은 Host.WindowNew 로 창을 연다. 초기 메뉴 언어는 시스템 선호 언어를 계약
	// 표의 언어에 대응한 값이고 페이지가 설정 언어를 알리면 SetMenuLanguage 가 같은 표로 메뉴를
	// 다시 만든다(docs/spec/host-contract.md 의 Application menu).
	menuWindowNew = host.WindowNew
	assignMenuLanguage(InitialMenuLanguage())
	menu, menuFailure := ApplicationMenu()
	if menuFailure != nil {
		return menuFailure
	}
	app.Menu.Set(menu)
	setupDockMenu(host)
	main := host.newWindow("main", "/")
	app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) {
		main.prepareNative()
	})
	err = app.Run()
	select {
	case failure := <-unpublished:
		return errors.Join(err, failure)
	default:
		return err
	}
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
