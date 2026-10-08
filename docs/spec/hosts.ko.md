# 네이티브 호스트

[English](hosts.md)

코어의 네이티브 쪽은 같은 구조를 가진 두 라이브러리 패키지에 있다. [네이티브 호스트 인터페이스](native-host.ko.md)가 워크벤치 페이지가 사용하는 연산을 정의한다. [호스트 계약 사례](host-contract.ko.md)는 두 호스트의 테스트가 실행하는 동작을 나열한다.

| 패키지 | 언어 | 식별 |
| --- | --- | --- |
| `packages/host/wailsv3` | Go | 모듈 `github.com/soksak-app/core/packages/host/wailsv3`. `src/`의 패키지 `host`이며 `github.com/soksak-app/core/packages/host/wailsv3/src`로 가져온다 |
| `packages/host/tauriv2` | Rust | 크레이트 `soksak-host-tauriv2`, `[lib] path = "src/host.rs"` |

애플리케이션 `apps/wailsv3`와 `apps/tauriv2`는 `src/main.*`, `environment.json`, `runtime/index.js`, 테스트, 매니페스트, 프레임워크 설정만 가진다. `apps/wailsv3/src/main.go`는 명령행 플래그를 `host.Options`로 읽고 `host.Run(assets, options)`를 호출한다. `apps/tauriv2/src/main.rs`는 `soksak_host_tauriv2::run(tauri::generate_context!(), BACKGROUND)`를 호출하며, `BACKGROUND`는 스테이징된 `frontend/background.js`다.

## 호스트 트리

```
packages/host/wailsv3/                     packages/host/tauriv2/
  package.json                               package.json
  go.mod, go.sum                             Cargo.toml            차이 A4
  (없음: cgo 지시문이 pkg-config 사용)          build.rs              차이 H1
  src/                                       src/
    host.go        패키지 문서, Run                   host.rs
    bindings.go    페이지 호출 등록                   bindings.rs
    windows.go     창, 준비, 닫기, 종료               windows.rs
    projects.go    폴더 확인, 선택, 생성              projects.rs
    workspace.go   설정과 프로젝트 저장               workspace.rs
    surfaces.go    표면 동기화, 표시, 배치            surfaces.rs
    documents.go   표면의 문서 영역                   documents.rs
    modals.go      네이티브 모달                      modals.rs
    shapes.go      표면 위 외곽선                     shapes.rs
    theme.go       테마 저장과 전달                   theme.rs
    sidecars.go    사이드카 채널                      sidecars.rs
    exposure.go    노출 요청 전달                     exposure.rs
    endpoint.go    JSON-RPC 서버                      endpoint.rs
    termination.go 종료 요청                          termination.rs
    diagnostics.go 진단 메서드(빌드 태그)             diagnostics.rs
    recording.go   진단 녹화 상태(빌드 태그)          recording.rs
    bridge.js      추가 웹뷰 호출 통로                차이 H3
    platform/                                  platform/
      platform.go  인터페이스와 선택             platform.rs
      darwin/                                    darwin/
        darwin.go    패키지 문서, 등록                darwin.rs
        window.go    창 준비, 창 단추                 window.rs
        webview.go   웹뷰 생성, 배치                  webview.rs
        webview.m    WKWebView 생성                   차이 H4
        document.go  문서 영역 뷰                     document.rs
        layout.go    표면 배치 트랜잭션               layout.rs
        shapes.go    외곽선 뷰                        shapes.rs
        input.go     입력 감시                        input.rs
        capture.go   캡처 호출(빌드 태그)             capture.rs
        dock.go      Dock 메뉴                        dock.rs
        identity.go  디렉터리 식별                    identity.rs
        endpoint.go  Unix 소켓                        endpoint.rs
        termination.go 종료 신호                      termination.rs
      windows/                                   windows/
        windows.go     패키지 문서, 등록                windows.rs
        identity.go    파일 ID                          identity.rs
        unsupported.go named pipe 엔드포인트를 포함한 "not implemented" 동작  unsupported.rs
      linux/  (구현 시 추가)                     linux/
  tests/                                     tests/
    sidecars_test.go                           sidecars_test.rs
    recording_test.go(빌드 태그)               recording_test.rs(기능)
    workspace_test.go                          workspace_test.rs
    endpoint_test.go                           endpoint_test.rs
    exposure_test.go                           exposure_test.rs
    documents_test.go                          documents_test.rs
    termination_test.go                        termination_test.rs
```

## 규칙

- 코드는 `src/`에 둔다. 테스트는 `tests/`에 두며, 두 언어 모두 테스트 파일 이름은 `_test`로 끝난다. `tests/`의 Go 테스트는 호스트 패키지를 가져온다. Cargo는 각 `tests/*_test.rs` 파일을 크레이트의 통합 테스트로 빌드한다.
- 각 디렉터리의 대표 파일은 디렉터리 이름과 같다: `host.*`, `platform/platform.*`, `darwin/darwin.*`, `windows/windows.*`.
- Rust 모듈은 `#[path = "..."]` 속성을 사용하므로 크레이트에 `lib.rs`와 `mod.rs`가 없다.
- 플랫폼 코드는 `src/platform/<os>/` 아래에만 있으며 `os`는 `darwin`, `windows`, `linux` 중 하나다.
- 대체(stub) 파일은 없다. 플랫폼이 구현하지 않은 연산은 `src/platform/<os>/unsupported.*`에서 오류를 반환한다.
- `native/darwin`이 내보내는 C 이름이 프레임워크의 이름과 겹치면 `sp_`로 시작한다. Wails는 자기 `windowFullscreen`을 컴파일하고, 링커가 둘 중 하나를 골라 호출이 프레임워크 함수로 갔으며 호스트는 그 반환값을 실패로 읽었다.

두 호스트의 `platform/darwin/ui_queue.go`와 `ui_queue.rs`는 프레임워크 이벤트 잠금 밖의 네이티브 메인 큐 실행을 제공한다. 표면 커밋과 취소는 이 경계에서 실행한다.

## 플랫폼 선택

Go: 각 `src/platform/<os>/` 디렉터리는 Go 패키지다. 대표 파일(`darwin.go`, `windows.go`)은 빌드 태그가 없고 패키지 문서만 가진다. 나머지 파일은 `//go:build <os>` 태그를 가지며, 그중 한 파일이 `init`에서 `platform.Register`를 호출한다. `host.go`는 모든 운영체제 패키지를 빈 식별자로 가져오므로 빌드는 대상 운영체제의 구현만 등록한다. `host.Run`은 `platform.Current()`로 구현을 얻고, 등록된 구현이 없으면 실패한다.

Rust: `src/platform/platform.rs`는 각 운영체제 모듈을 `#[cfg(target_os = "macos")]` 또는 `#[cfg(windows)]`와 `#[path = "<os>/<os>.rs"]`로 선언한다. `platform::current()`는 대상 운영체제의 구현을 반환하고, 다른 대상에서는 오류를 반환한다. 각 운영체제 모듈은 자신의 파일을 `#[path]`로 선언한다.

셸 사이드카 repository는 자기 `src/platform/`에서 같은 Go 방식을 사용한다([Repository](plugins.ko.md#repository)).

## 플랫폼 인터페이스

`src/platform/platform.*`가 인터페이스를 정의하고, 각 `src/platform/<os>/`가 이를 구현한다. 연산은 네이티브 창과 뷰 핸들을 받는다.

| 영역 | 연산 |
| --- | --- |
| 창 | 창 준비, 제목줄 높이, 전체 화면, 창 단추 영역, 윈도 서버 번호, 네이티브 검사 요청 |
| 웹뷰 | 생성, 배치, 영역, 표시 여부, 배경, 불투명도, 연속 크기 변경, 닫기(Wails는 탐색, 스크립트 실행, 모달 설정과 초점, 픽셀 정렬도 포함하고, Tauri는 순서, 모서리 반경, 뷰 식별도 포함한다) |
| 표면 배치 | 트랜잭션 시작, 커밋, 취소, 표시 후 완료 |
| 표면 합성 | `SurfaceHost` 생성과 닫기, 완전한 합성 적용, 네이티브 평면 클리핑·쌓임·표시·히트 분배, 그림 설정과 불변 스냅샷 표시 |
| 외곽선 | 표면 위 외곽선 뷰의 생성, 영역, 스타일, 제거 |
| 입력 | 입력 감시와 해제. Tauri는 포인터 라우팅에 웹뷰를 등록하는 연산도 가진다 |
| 캡처 | 창 캡처: 대상 지정, 시작, 첫 프레임 대기, 종료 |
| 문서 영역 | 표면 웹뷰 안의 생성, 이동, 기록 동작, 여백에 따른 배치, 대화 상자 흐림, 닫기 |
| 종료 | 종료 신호(SIGTERM, SIGINT, SIGHUP). 첫 신호는 호스트의 종료 요청을 부르고, 그 뒤의 신호는 기본 동작으로 프로세스를 끝낸다. quit 는 창이 저장한 뒤 모든 창의 웹 프로세스를 끝낸다 — [프로세스 생명주기](#프로세스-생명주기) |
| 종료 요청 | 운영체제의 종료 요청(Dock, 로그아웃, 재시작, 다른 프로그램이 보내는 `kAEQuitApplication` Apple event)은 준비된 창의 저장을 포함해 `host.quit`과 같은 종료를 실행하고, 호스트는 저장과 종료 단계를 마친 뒤 프로세스가 끝나기 직전에 그 요청에 오류 없이 답한다. 애플리케이션 프레임워크의 자체 종료 경로는 쓰지 않는다. Wails 프레임워크는 미룬 종료에 취소로 답해 로그아웃도 멈추고, Tauri 프레임워크는 페이지 저장을 기다리지 않고 끝나기 때문이다 |
| 창 동작 | 창을 만들기 전에 창 크기 변경 애니메이션 길이 줄이기 |
| 표준 오류 | 프로세스의 표준 오류를 열린 파일로 바꾸기 — [애플리케이션 로그](#애플리케이션-로그) 참고. Windows는 미구현 |
| Dock | Dock 메뉴 설치 |
| 식별 | 디렉터리 식별 |
| 비공개 파일 | 현재 사용자만 접근할 수 있는 파일과 디렉터리: 경로에서 없는 디렉터리 만들기(macOS에서 mode 0700), 파일을 덧붙이기로 열고 없으면 만들기(mode 0600), 있으면 안 되는 새 파일 만들기(mode 0600), 파일 내용을 바꾸고 없으면 만들기(mode 0600), 영구 service 디렉터리 제한, 진단 build에서 확인을 거치는 비공개 디렉터리. 공용 host 코드는 이런 파일과 디렉터리를 이 연산으로만 만들고 권한 mode를 직접 정하지 않는다. 이미 있는 파일과 디렉터리는 mode를 유지한다. Windows에서는 구현하지 않는다 |
| 엔드포인트 | [로컬 엔드포인트](endpoint.ko.md) 전송: macOS는 Unix 소켓, Windows는 미구현 |

캡처 첫 프레임 준비는 완전한 프레임이 기록되고 준비 검사 시 알려진 녹화 오류가 없을 때만 성공한다. 비동기 시작 또는 스트림 실패가 이미 알려져 있으면 프레임이 있어도 준비 성공을 거부하며 호출자가 원래 오류를 확인할 수 있어야 한다.

정지 캡처는 녹화 오류와 분리된 호출자 소유 오류 문자열을 반환하며 호출자는 free()로 해제한다. 정지 캡처 실패는 기존 녹화 오류를 지우거나 정상 녹화를 실패하게 만들지 않는다. 잘못된 UTF-8 경로는 플랫폼 API 호출 전에 거부한다. 늦은 정지 캡처 콜백은 자기 호출 상태만 보존하며 녹화 결과를 바꿀 수 없다. 네이티브 sp_capture_still 오류 출력 포인터는 필수이며 성공은 그 값을 NULL로 설정하고 실패는 UTF-8 오류 문자열을 할당한다. 두 호스트는 sp_capture_error 대신 호출별 출력을 읽고 해제한다.

녹화 대상 준비·시작은 이미 활성 녹화가 있으면 대상·프레임 계수·녹화 오류 변경 전에 거부한다. 각 open/start 호출은 필수 출력 포인터로 별도의 호출자 소유 UTF-8 오류를 반환한다(성공은 NULL, 실패는 free()로 해제). 거부된 중첩 작업은 정상 녹화 준비를 무효화하거나 이전 녹화 실패를 지울 수 없다.

대상 준비는 자기 조회가 10000ms 제한 안에 성공 완료했을 때만 필터·설정을 게시한다. 시간 초과된 조회는 자기 콜백 상태만 보존하고 늦은 실패는 보고하며 늦은 성공은 이후 대상을 덮어쓸 수 없다. 준비는 쓰지 않는 객체를 유지하지 않고 비활성 이전 대상/설정 소유를 해제한다. 준비 오류는 호출별 출력으로 반환하며 녹화 오류를 바꾸지 않는다. 성공한 준비를 게시하기 전에 녹화가 활성화되면 게시를 거부하고 활성 녹화를 유지한다.

실패한 프레임 파일 열기·쓰기·닫기·커밋은 각 작업·프레임 경로·저장한 시스템 오류를 보고한다. 부분 파일 삭제 실패는 원래 실패를 대체하지 않고 추가 녹화 오류로 보고한다. 쓰기 실패 뒤에도 닫기를 시도하고 닫기 실패를 따로 보고한다. 쓰기가 파일 열기에 성공한 경우에만 삭제를 시도하며 열기 실패로 기존 경로를 삭제하지 않는다. 실패한 프레임은 기록 수를 증가시키거나 첫 프레임 준비를 알리지 않는다.

비동기 시작·대리자 종료 실패는 현재 스트림을 식별할 때만 녹화 오류를 바꾼다. 이전 스트림의 지연 실패는 스트림 동일성과 함께 보고하며 이후 녹화 오류·첫 프레임 준비를 바꾸지 않는다. 시작 완료는 전달될 때까지 원래 스트림 동일성을 유지하며 교체된 스트림의 동일성을 자신의 것으로 읽지 않는다.

웹뷰 연산은 DOM 평면을 창의 공통 표면 컨테이너에 직접 붙이지 않고 `SurfaceHost`에 붙인다. 문서·그림 연산은 그 호스트 네이티브 평면의 하위 뷰를 만든다. 플랫폼 인터페이스는 영역을 `SurfaceHost`의 형제로 배치하는 연산을 노출하지 않는다. 두 언어 호스트는 플랫폼 코드를 호출하기 전에 [표면 합성](surface-composition.ko.md)을 검증한다.

### 창 단추

AppKit 이 창 자신의 단추를 소유한다. 제목줄 높이가 AppKit 이 단추를 두는 자리를 정한다. AppKit 은 단추를 제목줄의 세로 가운데에 두고, 제목 변경, 크기 변경, 이동 뒤에도 그 자리를 지킨다. 각 호스트는 AppKit 의 `-[NSWindow setTitlebarHeight:]`(`windowSetTitlebarHeight`, [비공개 네이티브 API 목록](../operations/private-native-apis.ko.md)에 있다)로 제목줄 높이를 정하고, 창에는 도구막대가 없다. 각 호스트는 창을 만들 때, 창이 보이기 전에 높이를 40pt 로 정하고, 창 페이지의 시작 문서에 답하기 전에 저장된 프레임 배율의 행 높이로 정하며, 창이 아직 이전 페이지를 보이면 시작 트랜잭션 안에서 정한다. 그래서 준비를 기다리지 않는 페이지의 첫 그리기가 자기 제목줄을 가진다([제목줄 높이](native-surfaces.ko.md#제목줄-높이)).

페이지가 첫 행의 높이를 소유한다. `packages/workbench/app.css` 의 `--chrome-row` 는 `round(max(--chrome-h, 36px × 프레임 배율))` 이고, `--chrome-h` 는 고정된 40px 최솟값, 프레임 배율은 프레임의 [글자 크기](text-size.ko.md)다. `packages/workbench/frame-text.js` 의 `chromeRow` 가 페이지의 요청에 쓰는 같은 높이를 계산한다. 페이지는 행을 창의 답에서 얻지 않으므로 제목줄이 바뀌어도 행은 바뀌지 않는다. 제목줄 높이는 배치 트랜잭션에 속한다([제목줄 높이](native-surfaces.ko.md#제목줄-높이)). 각 준비(`syncSurfaces`)는 다음 그리기가 보이는 첫 행의 높이 `titlebar` 를 담고, 호스트는 창의 열린 트랜잭션 안에서 제목줄을 그 높이로 정하므로 제목줄과 행은 같은 표시 프레임에서 바뀐다. 페이지는 시작할 때와 창 크기가 바뀔 때마다 `windowControls` 를 읽어 첫 행에서 단추 영역의 폭을 비우고, 제목줄이 행과 다르면 행을 담은 배치를 준비한다. `host.window` 는 보이는 영역을 `controls` 로 보고한다.

`titlebar` 는 32 이상 200 이하의 point 수다. 두 호스트는 트랜잭션을 시작하기 전에, 이 값이 없는 요청을 인자 decoder 의 `argument request.titlebar is missing`([host 호출](native-host.ko.md#host-호출))으로, 다른 값을 `title bar height must be a finite number from 32 through 200 points` 로 거부한다. 표준 단추나 content view 가 없는 창은 `the window has no standard buttons or content view for a title bar` 로 실패하고, 그 실패는 시작한 트랜잭션을 취소한다. 전체 화면인 창은 제목줄을 보이지 않고, AppKit 은 창이 전체 화면에 들어갈 때 높이를 저장하고 나올 때 되돌리므로 그 사이에 정한 높이는 사라진다. 그래서 호스트는 창이 전체 화면인 동안 제목줄을 바꾸지 않고, 준비는 `chrome.row` 0 으로 답한다. 전체 화면에서 나오면 창 크기가 바뀐다. 페이지는 그때 `windowControls` 를 읽고, 되돌린 높이가 행과 다르면 행을 다시 준비한다.

단추를 페이지 쪽 뷰로 옮기면 제목이나 녹화 표시가 바뀔 때 AppKit 이 되찾아 갔고, 창 이동·크기 변경 48회당 한 번꼴로 단추가 사라지거나 제목줄 자리에 있는 프레임이 화면에 나왔다. 제목줄 높이는 도구막대에서 오지 않는다. 항목이 없는 unified compact 도구막대는 제목줄을 40pt 로 고정하므로, 프레임 배율이 키운 첫 행에서 단추가 가운데를 벗어난다.

## Windows 상태

Windows에서 두 호스트는 디렉터리 식별(`platform/windows/identity.*`)만 구현한다. `platform/windows/unsupported.*`의 나머지 연산은 `<operation> is not implemented on windows` 형식의 오류를 반환한다. Windows에서는 애플리케이션 시작이 첫 platform 연산에서 실패한다. Wails의 `Run`과 Tauri의 `run`은 창을 열기 전에 `window resize animation is not implemented on windows`와 상태 1로 끝난다. Linux 구현은 없으며, 그곳에서 `platform.Current()`와 `platform::current()`는 오류를 반환한다.

`make hosts-check`는 `make windows-build-check`를 실행하며, 이 target은 Wails host source를 기본 build와 diagnostics build에서 `windows/arm64`용으로 vet한다.

## 허용 차이

| ID | Wails | Tauri | 이유 |
| --- | --- | --- | --- |
| H1 | 없음 | `build.rs` | Rust는 macOS 대상에서 빌드 스크립트로 pkg-config(`soksak-darwin`)를 통해 `native/darwin`을 찾고, Go는 `#cgo pkg-config` 지시문을 사용한다 |
| H3 | `src/bridge.js` | 없음 | Wails는 애플리케이션이 생성한 웹뷰에 호출 통로를 제공하지 않는다 |
| H4 | `src/platform/darwin/webview.m` | 없음 | Wails에 자식 웹뷰 API가 없어 호스트가 Objective-C로 웹뷰를 생성하며, Tauri는 `add_child`를 사용한다 |
| H5 | `src/diagnostics_test.go` | 없음 | 진단 전용 Go 단위 검사는 호스트 API를 넓히지 않고 비공개 capture payload helper를 검사하기 위해 구현 옆에 둔다. Rust 진단 범위는 호스트 통합 테스트에 있다 |
| H6 | `src/menu.go`, `tests/menu_test.go` | 없음 | Wails 기본 애플리케이션 메뉴는 View 메뉴에서 메인 웹뷰 전체를 확대하고 다시 읽으므로 Wails 호스트가 애플리케이션 메뉴를 정한다. Tauri 호스트는 View 메뉴에 전체 화면만 있는 Tauri 기본 메뉴를 쓴다 |
| A1 | 내용만 다름 | 내용만 다름 | `runtime/index.js`가 각 프레임워크의 호출 방식을 사용한다 |
| A2 | 없음 | `build.rs` | Tauri는 `tauri_build::build()`를 요구한다 |
| A3 | 없음 | `tauri.conf.json`, `capabilities/`, `icons/`, `gen/` | Tauri 설정 |
| A4 | `go.mod`, `go.sum` | `Cargo.toml` | 언어마다 매니페스트가 다르며, 호스트 패키지에도 같은 차이가 있다 |
| C1 | `src/cmd/sok/main.go` | `src/main.rs` | Go 명령은 자기 `main` package 폴더가 필요하고, Rust binary target은 library root 옆의 `src/main.rs`다 |
| C2 | `src/diagnostics_test.go`, `src/dev_test.go`, `tests/build_test.go` | 없음 | Go 파일은 build 제약으로 한 build에만 속하므로, `sok`의 진단 build는 `diagnostics && !dev` 단위 test에서 `capture` 요청과 release 식별자를, `dev` build는 `dev` 단위 test에서 `.dev` 식별자를, 다른 build는 `!diagnostics` test에서 사용법 오류와 release 식별자를 검사한다. Rust는 `tests/sok_test.rs`에서 `cfg(feature = "diagnostics")`와 `cfg(feature = "dev")`로 build를 검사한다 |
| C3 | `src/dev.go` | 없음 | Go는 `dev` build 태그만 컴파일하는 파일의 `init`으로 `.dev` 식별자를 고르고, Rust는 `src/identity.rs` 안의 `cfg!(feature = "dev")`로 고르므로 따로 파일이 없다 |

## 프로세스 생명주기

호스트는 세 자식 프로세스 계열을 각각 하나의 규칙으로 소유한다.

**WebKit XPC 는 애플리케이션과 함께 죽는다.** 모든 종료 경로는 프로세스가 끝나기 전에 네이티브 `_killWebContentProcessAndResetState` 로 각 창의 WebContent 프로세스를 죽인다. 종료 신호는 두 호스트 모두에서 정상 quit 를 요청하므로 `host.quit` 처럼 창이 저장하고 사이드카가 멈춘다. quit 가 끝나지 않으면 두 번째 신호가 프로세스를 끝낸다. Wails 호스트는 종료 단계에서 WebContent 프로세스를 죽이고, Tauri 호스트는 애플리케이션이 종료하는 동안 닫히는 각 창의 WebContent 프로세스를 죽인다. 죽이지 않으면 macOS 는 클라이언트가 죽은 뒤에도 WebContent·GPU·Networking 프로세스를 살려 둔다.

충돌 잔여는 운영체제가 회수할 때까지 받아들인다. 시작 정리를 시도했다가 전제가 틀려 지웠다(2026-09-30 실측): 이 시스템에서는 살아 있는 애플리케이션의 WebKit 도 unix 소켓이 없어 소켓 유무가 아무것도 가려내지 못하고, WebKit XPC 는 SIGTERM 을 무시하며, 유일한 건전한 소유 증명 — Networking 프로세스가 소유 번들의 `WebsiteData` 저장소를 열어 두는 것 — 은 고아 묶음의 소수만 식별한다. 메모리가 무거운 WebContent 는 식별 경로를 남기지 않기 때문이다. 죽은 애플리케이션의 WebKit 이 무엇인지 증명하지 못하는 정리는 실행되어서는 안 된다.

**영속 사이드카는 애플리케이션보다 오래 살고 다시 붙는다.** 터미널 서비스는 앱 재시작과 연결 단절을 지나 세션을 유지하며, 끊긴 연결은 즉시 다시 맺고 죽은 서비스는 재스폰한다([터미널 런타임](terminal-runtime.ko.md)). 애플리케이션은 종료 시 영속 서비스를 죽이지 않는다. 두 호스트는 platform 연산 `NewSession`(Go) 또는 `new_session`(Rust)으로 영속 서비스를 새 session에서 시작하므로, 서비스는 애플리케이션의 process group이나 terminal의 signal을 받지 않는다.

**비영속 사이드카는 창과 함께 죽는다.** 표면 제거나 창 닫기가 닫힘을 알리고 프로세스는 채널과 함께 끝난다.

## 애플리케이션 로그

[진단](diagnostics.ko.md)이 모든 기록과 그 형태, 각 실패가 기록을 남기는 곳을 정한다. 애플리케이션의 모든 진단 파일은 고정된 폴더 하나, 설정 디렉터리의 `logs/`에 있다: 애플리케이션 로그, [성능 트레이스](performance-trace.md), 서비스 로그, 응답 멈춤 sample, 그리고 `logs/captures/`의 정지 캡처와 녹화. 결함을 만난 사람은 이 폴더를 넘겨준다.

각 호스트는 애플리케이션 로그를 설정 디렉터리의 `logs/application.log`에 쓴다. 호스트는 설정 디렉터리의 process lock을 잡는 [엔드포인트](endpoint.ko.md)를 만든 직후, 그 파일을 mode 0600의 덧붙이기로 열고 플랫폼 표준 오류 연산으로 프로세스의 표준 오류를 그 파일로 바꾼다. 그래서 파일에는 호스트 자신의 줄, 페이지가 `report`로 보낸 각 줄, 런타임의 crash 출력, 그리고 그 descriptor를 물려받는 모든 비영속 사이드카의 표준 오류가 담긴다. 한 줄은 그 줄을 쓴 write가 반환될 때 이미 파일에 있다. 두 호스트는 자신의 줄과 페이지의 줄을 접두사 없이 쓰며, 각 실행은 시각을 가진 `<ISO-8601 시각> application log: <애플리케이션 식별자> pid <pid>` 줄로 로그를 시작한다. 엔드포인트가 생기기 전에 쓴 출력은 프로세스가 시작될 때의 표준 오류로 간다.

오류를 알리는 페이지 줄은 `error: `로 시작하고, 그렇게 시작하지 않는 페이지 줄은 정보다. 워크벤치는 메인 문서에 보이는 모든 오류, 처리되지 않은 모든 오류와 promise rejection, 거부된 모든 상태 변경, 실패한 모든 표면 mount와 배경 session, 실패한 모든 자체 검증(`error: verify: <n> fail — …`)을 이 형식으로 보고한다. 나중의 reload가 문서에서 오류를 지워도 로그에는 각 오류 줄이 남으므로, window check는 로그로 모든 오류 발생을 판정한다. host가 없는 페이지는 실패를 콘솔에 오류로 쓴다.

오류를 알리는 호스트 줄도 같은 형식 `error: <where>: <text>`를 쓴다. `<where>`는 실패한 연산이나 대상의 이름이고 `<text>`는 실패 내용이다. 각 호스트는 helper 하나(Go의 `LogError`, Rust의 `log_error`)로 그 줄을 쓰며, 두 호스트에 모두 있는 site는 두 호스트에서 같은 `<where>`와 `<text>`를 쓴다. native 라이브러리는 `sp_log_error`로 같은 형식의 오류 줄을 쓴다. 로그를 연 뒤의 치명적 실패는 프로세스가 끝나기 전에 이 형식으로 줄을 쓴다. `error: `로 시작하지 않는 호스트 줄은 관측이다. 관측은 예상된 상태를 기록하며 그 상태를 말한다. 예를 들어 `exposure reply <id> of removed surface "<surface>" arrived after its request ended`, 그리고 호출자가 이미 자신의 실패를 반환한 뒤에 완료가 쓰는 `<operation> arrived after its request ended`가 있다. 호스트는 실패를 관측으로 쓰지 않는다. 요청이 받는 실패는 그 실패를 받은 요청자가 보고하며, 다른 곳은 그 실패의 줄을 쓰지 않는다. 호스트는 어떤 요청도 보고하지 않는 실패에만 오류 줄을 쓴다. 예를 들어 그림 표시 제한 시간은 그것을 기다린 표면 준비나 표시 요청의 답이므로 두 호스트 모두 그 줄을 쓰지 않는다. 페이지의 배치 대기열이 그 답을 받아 `page: surface presentation failed: <text>`로 보이며, 이것이 그 실패의 유일한 줄이다. 배치 대기열은 실패한 배치를 거절이 아니라 실패한 상태로 그 배치를 예약한 코드와 그 배치를 기다리는 모든 대기에 답하므로, 그 배치를 기다린 프로젝트 전환이나 다른 명령, 그리고 어떤 명령도 기다리지 않는 몸짓의 배치는 그 실패의 줄을 쓰지 않는다. 애플리케이션 framework의 오류 출력도 같은 helper를 거친다(`error: wails: <text>`). Tauri runtime에는 설치된 logger가 없다.

영속 서비스는 자신을 시작한 호스트보다 오래 살기 때문에 호스트의 표준 오류를 물려받지 않는다. 호스트는 영속 서비스를 시작할 때 `logs/<실행 파일 이름>.log`를 mode 0600의 덧붙이기로 열어 서비스의 표준 오류로 넘긴다.

호스트가 10 MB 이상인 로그 파일을 열 때는 먼저 그 파일을 `<이름>.1`로 바꿔 이전 세대를 대체하고 새 파일을 시작한다. 호스트는 다른 프로세스가 쓰지 않을 때만 로그 파일을 연다. 애플리케이션 로그는 process lock을 잡은 동안 실행마다 한 번 열고, 서비스 로그는 그 서비스를 시작할 때만 연다. 실행이나 서비스는 다음에 열 때까지 크기 제한 없이 덧붙이므로, 다음 실행이나 다음 서비스 시작이 상한을 적용한다.

애플리케이션 로그를 열 수 없거나 표준 오류를 바꿀 수 없는 호스트는 시작하지 않으며, 그 오류를 시작할 때의 표준 오류에 보고한다. 서비스 로그를 열 수 없는 호스트는 그 서비스를 시작하지 않고 `sidecar <name>: service log: <error>`로 시작을 실패시킨다.

## 애플리케이션 트리

```
apps/wailsv3/                  apps/tauriv2/
  package.json                   package.json
  environment.json               environment.json
  runtime/index.js               runtime/index.js      차이 A1
  test/                          test/
  src/main.go                    src/main.rs
  src/frontend/  (생성됨)        src/frontend/  (생성됨)
  go.mod, go.sum                 Cargo.toml            차이 A4
  (없음)                         build.rs              차이 A2
  (없음)                         tauri.conf.json, capabilities/, icons/, gen/   차이 A3
```

`apps/wailsv3/go.mod`는 호스트 모듈을 요구한다. `apps/tauriv2/Cargo.toml`은 경로로 지정한 `soksak-host-tauriv2`와 `tauri`에 의존한다. `apps/tauriv2/build.rs`는 `tauri_build::build()`만 호출한다.

Wails 바인딩 서비스 이름은 `github.com/soksak-app/core/packages/host/wailsv3/src.Host`다. Wails가 Go 패키지 경로와 타입 이름으로 이 이름을 만들고, `apps/wailsv3/runtime/index.js`가 이를 사용한다.

## Command line 트리

```
packages/sok/wailsv3/          packages/sok/tauriv2/
  src/sok.go  (package sok)      src/sok.rs  (library root)
  src/<role>.go                  src/<role>.rs
  src/cmd/sok/main.go            src/main.rs           차이 C1
  tests/<role>_test.go           tests/<role>_test.rs
  go.mod, go.sum                 Cargo.toml            차이 A4
```

이 쌍은 호스트 패키지와 같은 파일 이름 규칙과 구조 검사를 따른다. 그 contract case는 [호스트 계약](host-contract.ko.md)에 `cli.`로 나열한다.

## 애플리케이션 인자

애플리케이션은 `--config-dir PATH`([projects](projects.ko.md#저장))를 두 인자 또는 `--config-dir=PATH`로 받는다. 두 host는 창을 열기 전에 하나의 규칙으로 인자를 읽는다. 애플리케이션이 선언하지 않은 인자는 `unknown argument <argument>`로, 값 없는 flag는 `--<flag> needs a value`로, 두 번 준 flag는 `--<flag> is given twice`로 실패한다. 애플리케이션은 그 문장을 표준 오류에 쓰고 상태 2로 끝난다.

진단 build는 `--registry-ca PATH`도 받는다. host의 registry 받기가 운영체제의 인증 기관 대신 신뢰하는 인증 기관을 담은 PEM 파일이며([받기](installation.ko.md#받기)), window check가 local TLS registry를 쓸 수 있게 한다. 읽을 수 없거나 인증서가 없는 파일은 `--registry-ca <path>: <reason>`과 상태 2로 시작을 끝낸다. release build는 이 인자를 선언하지 않으므로 모르는 인자로 거부한다.

## 프런트엔드와 실행 파일

`soksak-stage`는 프런트엔드를 `apps/<app>/src/frontend/`에 배치하며, 각 애플리케이션의 `.gitignore`가 이 디렉터리를 제외한다. `go:embed`는 포함하는 패키지 디렉터리 아래의 파일만 포함할 수 있으므로 Wails는 `src/main.go`의 `//go:embed all:frontend`로 이 디렉터리를 포함한다. `host.Run`은 `frontend/`를 자산 루트로 사용한다. Tauri는 `tauri.conf.json`의 `"frontendDist": "src/frontend"`로 이 디렉터리를 읽고, `src/main.rs`는 `frontend/background.js`를 포함한다.

macOS에서 각 애플리케이션은 애플리케이션 번들에서 실행된다. 운영체제의 알림 센터가 번들에서 실행된 프로세스만 받기 때문이다([플러그인](plugins.ko.md#탭-알림)). 두 release 애플리케이션은 표시 이름 `soksak`의 `soksak.app`이다. release 번들은 `target/release/wailsv3/soksak.app`과 `target/release/tauriv2/soksak.app`이고, 번들 식별자는 설정 디렉터리의 식별자인 `app.soksak.wails`와 `app.soksak.tauri`다([projects](projects.ko.md#저장)). 디버그 번들은 release 애플리케이션 옆에서 함께 실행되도록 이름을 유지한다. `target/debug/soksak-wailsv3.app/Contents/MacOS/soksak-wailsv3`와 `target/debug/soksak-tauriv2.app/Contents/MacOS/soksak-tauriv2`이며, 번들 이름은 실행 파일 이름이고 식별자는 `app.soksak.wails.dev`와 `app.soksak.tauri.dev`다. 각 번들 안의 실행 파일은 `soksak-wailsv3` 또는 `soksak-tauriv2`다. 빌드는 각 번들의 `Contents/Info.plist`를 release 값을 선언한 `apps/<app>/platform/darwin/Info.plist`에서 쓰고, 디버그 빌드는 번들 식별자와 번들 이름을 바꾼다. Dock이 보이는 soksak 아이콘 `apps/<app>/platform/darwin/AppIcon.icns`를 `Contents/Resources/`에 복사하며, 번들에 ad hoc 서명을 하고 LaunchServices에 다시 등록한다. Dock은 등록된 번들의 아이콘을 보이며, 번들 안의 파일만 바뀌면 LaunchServices는 번들을 다시 읽지 않는다. 번들에는 플러그인도 사이드카도 없다. 호스트는 설정 디렉터리에 설치된 플러그인을 제공하고 사이드카를 시작하며, `plugins/installed.json`이 기록한 폴더를 쓴다([설치](installation.ko.md#설치된-plugin-제공)).

## 워크스페이스 파일

| 파일 | 내용 |
| --- | --- |
| `go.work` | `apps/wailsv3`, `packages/host/wailsv3`, `packages/sok/wailsv3`을 사용하고, 호스트 모듈과 command line 모듈 `v0.0.0`을 `./packages/host/wailsv3`와 `./packages/sok/wailsv3`로 대체한다 |
| `Cargo.toml` | 멤버 `apps/tauriv2`, `packages/host/tauriv2`, `packages/sok/tauriv2`, Tauri 크레이트에 대한 공용 `[patch.crates-io]`, `dev` 프로필을 가진 워크스페이스 |
| `Cargo.lock` | 두 크레이트가 공유하는 하나의 잠금 파일 |
| `target/` | Cargo 출력과 두 애플리케이션 실행 파일. `.gitignore`가 제외한다 |

## 명령

| 명령 | 동작 |
| --- | --- |
| `make wailsv3-build`, `make tauriv2-build` | `native/darwin`과 프런트엔드를 빌드하고 스테이징한 뒤 디버그 실행 파일을 빌드한다 |
| `make wailsv3-build-release`, `make tauriv2-build-release` | 릴리스 실행 파일을 빌드한다 |
| `make wailsv3`, `make tauriv2` | 디버그 실행 파일을 빌드하고 실행한다 |
| `make registry`, `make install-plugins CONFIG=DIR` | `scripts/workspace-registry.json`이 선언한 plugin·sidecar repository로 `target/registry`에 workspace registry를 만들고([Repository](plugins.ko.md#repository)), 그 플러그인을 설정 디렉터리에 설치한다 |
| `make rust-clippy-check` | Rust workspace의 모든 package와 test를 진단 feature가 있을 때와 없을 때 `-D warnings`로 clippy 검사한다. `make native-test`가 실행한다 |
| `make native-test` | `make -C native/darwin test`, `packages/host/wailsv3`의 `go test`, `cargo test -p soksak-host-tauriv2`를 실행한다. 호스트 검사는 진단 빌드와 일반 빌드로 각각 실행한다. 각 sidecar repository는 자기 test를 실행한다 |
| `make platforms` | `scripts/check-platforms.mjs`를 실행한다 |
| `make hosts-check` | `scripts/check-hosts.mjs`를 실행한다 |

## 구조 검사

`scripts/check-hosts.mjs`는 `packages/host/wailsv3`와 `packages/host/tauriv2`, `apps/wailsv3`와 `apps/tauriv2`를 비교한다. `.go`와 `.rs` 파일은 확장자를 제외한 상대 경로로, 그 밖의 파일은 상대 경로로 비교한다. 한쪽에만 있는 파일은 허용 차이 표의 차이 ID와 함께 목록에 있을 때만 통과한다. 검사는 Git이 추적하거나 추적할 파일만 읽으므로 생성된 `src/frontend/` 파일은 비교하지 않는다.

`scripts/check-platforms.mjs`는 `platform/<os>/` 디렉터리 밖에 있는 다음 항목을 보고한다: 운영체제 접미사(`_darwin`, `_windows` 등)를 가진 파일 이름, 그리고 소스 파일의 `runtime.GOOS`, Go 운영체제 빌드 태그, Rust 운영체제 `cfg` 속성, `process.platform`. `native/<os>/`, `scripts/check-build-environment.sh`, `platform/platform.{go,rs,js}`, 검사 파일 자신은 건너뛴다. `Cargo.toml`은 읽지 않으므로 대상별 의존성 표는 허용된다.

## native/darwin

`native/darwin`은 두 호스트가 호출하는 공용 macOS 라이브러리다. 최소 macOS 버전은 14.4다. `capture.m`이 macOS 14.4에서 추가된 `SCShareableContent getCurrentProcessShareableContentWithCompletionHandler:`를 호출하기 때문이다. Makefile은 이 값을 `MACOS_MINIMUM`에 선언하고 라이브러리와 두 애플리케이션을 그 값으로 build한다. 두 애플리케이션의 `Info.plist`는 `LSMinimumSystemVersion`에, `apps/tauriv2/tauri.conf.json`은 `bundle.macOS.minimumSystemVersion`에 같은 값을 선언하는데, Tauri bundler가 그 값으로 애플리케이션을 build하기 때문이다. 번들이 다른 값을 선언하거나, 애플리케이션 실행 파일이 다른 macOS version으로 build되었거나, 번들의 다른 실행 파일이 더 새 version으로 build되었으면 `make release-check`가 실패한다.

| 경로 | 내용 |
| --- | --- |
| `src/` | `<이름>.h`와 `<이름>.m` 소스. 두 호스트가 창 캡처에 사용하는 `capture.m`을 포함한다. 디렉터리가 플랫폼을 나타내므로 파일 이름에 `_darwin` 접미사가 없다 |
| `tests/` | `window_motion_test.m`, `input_inject_test.m`, `webview_input_receipts_test.m`, `window_facts_test.m`, `window_controls_test.m`, `window_titlebar_layout_test.m`, `window_titlebar_reload_test.m`, `surface_layout_test.m`, `webview_focus_test.m`, `webview_geometry_test.m`, `document_view_test.m` 기본 실행(`make test`, 활성화 없음. `document_view_test`는 종료 시 프로세스가 활성이면 실패한다), `input_activate_test.m`, `webview_input_test.m`, `webview_inspector_test.m`, `window_fullscreen_test.m`, `image_region_ime_test.m`, `document_view_test.m --activation`(`make test-activation`, 애플리케이션 활성화) |
| `Makefile` | 호스트가 pkg-config에서 `soksak-darwin`으로 찾는 정적 라이브러리를 빌드한다. `make -C native/darwin test`와 `make -C native/darwin test-activation`이 입력 검사를 실행한다 |
