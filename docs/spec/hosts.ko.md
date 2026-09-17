# 네이티브 호스트

[English](hosts.md)

코어의 네이티브 쪽은 같은 구조를 가진 두 라이브러리 패키지에 있다. [네이티브 호스트 인터페이스](native-host.ko.md)가 워크벤치 페이지가 사용하는 연산을 정의한다.

| 패키지 | 언어 | 식별 |
| --- | --- | --- |
| `packages/host/wailsv3` | Go | 모듈 `github.com/min-median-max/soksak/packages/host/wailsv3`. `src/`의 패키지 `host`이며 `github.com/min-median-max/soksak/packages/host/wailsv3/src`로 가져온다 |
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
    modals.go      네이티브 모달                      modals.rs
    shapes.go      표면 위 외곽선                     shapes.rs
    theme.go       테마 저장과 전달                   theme.rs
    sidecars.go    사이드카 채널                      sidecars.rs
    exposure.go    노출 요청 전달                     exposure.rs
    endpoint.go    JSON-RPC 서버                      endpoint.rs
    diagnostics.go 진단 메서드(빌드 태그)             diagnostics.rs
    bridge.js      추가 웹뷰 호출 통로                차이 H3
    platform/                                  platform/
      platform.go  인터페이스와 선택             platform.rs
      darwin/                                    darwin/
        darwin.go    패키지 문서, 등록                darwin.rs
        window.go    창 준비, 창 단추                 window.rs
        webview.go   웹뷰 생성, 배치                  webview.rs
        webview.m    WKWebView 생성                   차이 H4
        layout.go    표면 배치 트랜잭션               layout.rs
        shapes.go    외곽선 뷰                        shapes.rs
        input.go     입력 감시                        input.rs
        capture.go   캡처 호출                        capture.rs
        dock.go      Dock 메뉴                        dock.rs
        identity.go  디렉터리 식별                    identity.rs
        endpoint.go  Unix 소켓                        endpoint.rs
      windows/                                   windows/
        windows.go     패키지 문서, 등록                windows.rs
        identity.go    파일 ID                          identity.rs
        unsupported.go named pipe 엔드포인트를 포함한 "not implemented" 동작  unsupported.rs
      linux/  (구현 시 추가)                     linux/
  tests/                                     tests/
    sidecars_test.go                           sidecars_test.rs
    workspace_test.go                          workspace_test.rs
    endpoint_test.go                           endpoint_test.rs
    exposure_test.go                           exposure_test.rs
```

## 규칙

- 코드는 `src/`에 둔다. 테스트는 `tests/`에 두며, 두 언어 모두 테스트 파일 이름은 `_test`로 끝난다. `tests/`의 Go 테스트는 호스트 패키지를 가져온다. Cargo는 각 `tests/*_test.rs` 파일을 크레이트의 통합 테스트로 빌드한다.
- 각 디렉터리의 대표 파일은 디렉터리 이름과 같다: `host.*`, `platform/platform.*`, `darwin/darwin.*`, `windows/windows.*`.
- Rust 모듈은 `#[path = "..."]` 속성을 사용하므로 크레이트에 `lib.rs`와 `mod.rs`가 없다.
- 플랫폼 코드는 `src/platform/<os>/` 아래에만 있으며 `os`는 `darwin`, `windows`, `linux` 중 하나다.
- 대체(stub) 파일은 없다. 플랫폼이 구현하지 않은 연산은 `src/platform/<os>/unsupported.*`에서 오류를 반환한다.

## 플랫폼 선택

Go: 각 `src/platform/<os>/` 디렉터리는 Go 패키지다. 대표 파일(`darwin.go`, `windows.go`)은 빌드 태그가 없고 패키지 문서만 가진다. 나머지 파일은 `//go:build <os>` 태그를 가지며, 그중 한 파일이 `init`에서 `platform.Register`를 호출한다. `host.go`는 모든 운영체제 패키지를 빈 식별자로 가져오므로 빌드는 대상 운영체제의 구현만 등록한다. `host.Run`은 `platform.Current()`로 구현을 얻고, 등록된 구현이 없으면 실패한다.

Rust: `src/platform/platform.rs`는 각 운영체제 모듈을 `#[cfg(target_os = "macos")]` 또는 `#[cfg(windows)]`와 `#[path = "<os>/<os>.rs"]`로 선언한다. `platform::current()`는 대상 운영체제의 구현을 반환하고, 다른 대상에서는 오류를 반환한다. 각 운영체제 모듈은 자신의 파일을 `#[path]`로 선언한다.

셸 사이드카는 `sidecars/shell/src/platform/`에서 같은 Go 방식을 사용한다.

## 플랫폼 인터페이스

`src/platform/platform.*`가 인터페이스를 정의하고, 각 `src/platform/<os>/`가 이를 구현한다. 연산은 네이티브 창과 뷰 핸들을 받는다.

| 영역 | 연산 |
| --- | --- |
| 창 | 창 준비, 창 단추 배치와 영역, 윈도 서버 번호, 네이티브 검사 요청 |
| 웹뷰 | 생성, 배치, 영역, 표시 여부, 배경, 불투명도, 연속 크기 변경, 닫기(Wails는 탐색, 스크립트 실행, 모달 설정과 초점, 픽셀 정렬도 포함하고, Tauri는 순서, 모서리 반경, 뷰 식별도 포함한다) |
| 표면 배치 | 트랜잭션 시작, 커밋, 취소, 표시 후 완료 |
| 외곽선 | 표면 위 외곽선 뷰의 생성, 영역, 스타일, 제거 |
| 입력 | 입력 감시와 해제. Tauri는 포인터 라우팅에 웹뷰를 등록하는 연산도 가진다 |
| 캡처 | 창 캡처: 대상 지정, 시작, 첫 프레임 대기, 종료 |
| Dock | Dock 메뉴 설치 |
| 식별 | 디렉터리 식별 |
| 엔드포인트 | [로컬 엔드포인트](endpoint.ko.md) 전송. 미구현 |

## Windows 상태

Windows에서 두 호스트는 디렉터리 식별(`platform/windows/identity.*`)만 구현한다. `platform/windows/unsupported.*`의 나머지 연산은 `<operation> is not implemented on windows` 형식의 오류를 반환한다. Windows에서는 애플리케이션 시작이 실패한다. Wails는 Dock 메뉴 설치가 이 오류를 반환하면 종료하고, Tauri의 setup은 Dock 메뉴 오류를 반환한다. Linux 구현은 없으며, 그곳에서 `platform.Current()`와 `platform::current()`는 오류를 반환한다.

## 허용 차이

| ID | Wails | Tauri | 이유 |
| --- | --- | --- | --- |
| H1 | 없음 | `build.rs` | Rust는 macOS 대상에서 빌드 스크립트로 pkg-config(`soksak-darwin`)를 통해 `native/darwin`을 찾고, Go는 `#cgo pkg-config` 지시문을 사용한다 |
| H3 | `src/bridge.js` | 없음 | Wails는 애플리케이션이 생성한 웹뷰에 호출 통로를 제공하지 않는다 |
| H4 | `src/platform/darwin/webview.m` | 없음 | Wails에 자식 웹뷰 API가 없어 호스트가 Objective-C로 웹뷰를 생성하며, Tauri는 `add_child`를 사용한다 |
| A1 | 내용만 다름 | 내용만 다름 | `runtime/index.js`가 각 프레임워크의 호출 방식을 사용한다 |
| A2 | 없음 | `build.rs` | Tauri는 `tauri_build::build()`를 요구한다 |
| A3 | 없음 | `tauri.conf.json`, `capabilities/`, `icons/`, `gen/` | Tauri 설정 |
| A4 | `go.mod`, `go.sum` | `Cargo.toml` | 언어마다 매니페스트가 다르며, 호스트 패키지에도 같은 차이가 있다 |

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

Wails 바인딩 서비스 이름은 `github.com/min-median-max/soksak/packages/host/wailsv3/src.Host`다. Wails가 Go 패키지 경로와 타입 이름으로 이 이름을 만들고, `apps/wailsv3/runtime/index.js`가 이를 사용한다.

## 프런트엔드와 실행 파일

`soksak-stage`는 프런트엔드를 `apps/<app>/src/frontend/`에 배치하며, 각 애플리케이션의 `.gitignore`가 이 디렉터리를 제외한다. `go:embed`는 포함하는 패키지 디렉터리 아래의 파일만 포함할 수 있으므로 Wails는 `src/main.go`의 `//go:embed all:frontend`로 이 디렉터리를 포함한다. `host.Run`은 `frontend/`를 자산 루트로 사용한다. Tauri는 `tauri.conf.json`의 `"frontendDist": "src/frontend"`로 이 디렉터리를 읽고, `src/main.rs`는 `frontend/background.js`를 포함한다.

디버그 실행 파일은 `target/debug/soksak-wailsv3`와 `target/debug/soksak-tauriv2`이며, 릴리스 실행 파일은 `target/release/`에 있다. 스테이징은 사이드카 실행 파일을 같은 디렉터리에 복사하고, 호스트는 실행 중인 실행 파일의 디렉터리에서 사이드카를 시작한다.

## 워크스페이스 파일

| 파일 | 내용 |
| --- | --- |
| `go.work` | `apps/wailsv3`, `packages/host/wailsv3`, `sidecars/shell`을 사용하고, 호스트 모듈 `v0.0.0`을 `./packages/host/wailsv3`로 대체한다 |
| `Cargo.toml` | 멤버 `apps/tauriv2`와 `packages/host/tauriv2`, Tauri 크레이트에 대한 공용 `[patch.crates-io]`, `dev` 프로필을 가진 워크스페이스 |
| `Cargo.lock` | 두 크레이트가 공유하는 하나의 잠금 파일 |
| `target/` | Cargo 출력과 두 애플리케이션 실행 파일. `.gitignore`가 제외한다 |

## 명령

| 명령 | 동작 |
| --- | --- |
| `make wailsv3-build`, `make tauriv2-build` | `native/darwin`, 프런트엔드, 사이드카를 빌드하고 스테이징한 뒤 디버그 실행 파일을 빌드한다 |
| `make wailsv3-build-release`, `make tauriv2-build-release` | 릴리스 실행 파일을 빌드한다 |
| `make wailsv3`, `make tauriv2` | 디버그 실행 파일을 빌드하고 실행한다 |
| `make native-test` | `make -C native/darwin test`, `packages/host/wailsv3`와 `sidecars/shell`의 `go test`, `cargo test -p soksak-host-tauriv2`를 실행한다. 호스트 검사는 진단 빌드와 일반 빌드로 각각 실행한다 |
| `make platforms` | `scripts/check-platforms.mjs`를 실행한다 |
| `make hosts-check` | `scripts/check-hosts.mjs`를 실행한다 |

## 구조 검사

`scripts/check-hosts.mjs`는 `packages/host/wailsv3`와 `packages/host/tauriv2`, `apps/wailsv3`와 `apps/tauriv2`를 비교한다. `.go`와 `.rs` 파일은 확장자를 제외한 상대 경로로, 그 밖의 파일은 상대 경로로 비교한다. 한쪽에만 있는 파일은 허용 차이 표의 차이 ID와 함께 목록에 있을 때만 통과한다. 검사는 Git이 추적하거나 추적할 파일만 읽으므로 생성된 `src/frontend/` 파일은 비교하지 않는다.

`scripts/check-platforms.mjs`는 `platform/<os>/` 디렉터리 밖에 있는 다음 항목을 보고한다: 운영체제 접미사(`_darwin`, `_windows` 등)를 가진 파일 이름, 그리고 소스 파일의 `runtime.GOOS`, Go 운영체제 빌드 태그, Rust 운영체제 `cfg` 속성, `process.platform`. `native/<os>/`, `scripts/check-build-environment.sh`, `platform/platform.{go,rs,js}`, 검사 파일 자신은 건너뛴다. `Cargo.toml`은 읽지 않으므로 대상별 의존성 표는 허용된다.

## native/darwin

`native/darwin`은 두 호스트가 호출하는 공용 macOS 라이브러리다. 최소 macOS 버전은 14.0이다.

| 경로 | 내용 |
| --- | --- |
| `src/` | `<이름>.h`와 `<이름>.m` 소스. 두 호스트가 창 캡처에 사용하는 `capture.m`을 포함한다. 디렉터리가 플랫폼을 나타내므로 파일 이름에 `_darwin` 접미사가 없다 |
| `tests/` | `input_inject_test.m`, `window_facts_test.m`, `surface_layout_test.m`(`make test`, 활성화 없음), `input_activate_test.m`과 `webview_input_test.m`(`make test-activation`, 애플리케이션 활성화) |
| `Makefile` | 호스트가 pkg-config에서 `soksak-darwin`으로 찾는 정적 라이브러리를 빌드한다. `make -C native/darwin test`와 `make -C native/darwin test-activation`이 입력 검사를 실행한다 |
