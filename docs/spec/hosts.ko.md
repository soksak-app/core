# 네이티브 호스트

[English](hosts.md)

이 명세는 아직 구현되지 않았으며, [기능 상태](../features.ko.md)가 구현 여부를 기록한다.

코어의 네이티브 쪽은 같은 구조를 가진 두 호스트 패키지에 있다. [네이티브 호스트 인터페이스](native-host.ko.md)가 워크벤치 페이지가 사용하는 연산을 정의한다.

| 패키지 | 언어 | 식별 |
| --- | --- | --- |
| `packages/host/wailsv3` | Go | 모듈 `soksak/host/wailsv3`, 패키지 `host`, import 경로 `soksak/host/wailsv3/src` |
| `packages/host/tauriv2` | Rust | 크레이트 `soksak-host-tauriv2`, `[lib] path = "src/host.rs"` |

애플리케이션 `apps/wailsv3`와 `apps/tauriv2`는 `src/main.*`, `environment.json`, `runtime/index.js`, 테스트, 프레임워크 설정만 가진다. `src/main.*`는 호스트 패키지를 호출한다.

## 호스트 트리

```
packages/host/wailsv3/                     packages/host/tauriv2/
  package.json                               package.json
  go.mod                                     Cargo.toml
  (없음: cgo 지시문이 pkg-config 사용)          build.rs              차이 H1
  src/                                       src/
    host.go        패키지 문서, 조립                  host.rs
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
    diagnostics.go 진단(빌드 태그)                    diagnostics.rs
    bridge.js      추가 웹뷰 호출 통로                차이 H3
    platform/                                  platform/
      platform.go  인터페이스와 선택             platform.rs
      darwin/                                    darwin/
        darwin.go    패키지 문서, 조립                darwin.rs
        window.go    창 준비, 창 단추                 window.rs
        webview.go   웹뷰 생성, 배치                  webview.rs
        webview.m    WKWebView 생성                   차이 H4
        layout.go    표면 배치 트랜잭션               layout.rs
        shapes.go    외곽선 뷰                        shapes.rs
        input.go     입력 감시, 주입                  input.rs
        capture.go   캡처 호출                        capture.rs
        dock.go      Dock 메뉴                        dock.rs
        identity.go  디렉터리 식별                    identity.rs
        endpoint.go  Unix 소켓                        endpoint.rs
      windows/                                   windows/
        windows.go     패키지 문서, 조립                windows.rs
        endpoint.go    named pipe                       endpoint.rs
        identity.go    파일 ID                          identity.rs
        unsupported.go 나머지 "not implemented"         unsupported.rs
      linux/  (구현 시 추가)                     linux/
  tests/                                     tests/
    sidecars_test.go                           sidecars_test.rs
    workspace_test.go                          workspace_test.rs
    endpoint_test.go                           endpoint_test.rs
    exposure_test.go                           exposure_test.rs
  test/  (JS: 설정 검사)                     test/
```

## 규칙

- 코드는 `src/`에 둔다. 테스트는 `tests/`에 두며, 두 언어 모두 테스트 파일 이름은 `_test`로 끝난다.
- 각 디렉터리의 대표 파일은 디렉터리 이름과 같다: `host.*`, `platform/platform.*`, `darwin/darwin.*`, `windows/windows.*`.
- Rust 모듈은 `#[path = "..."]` 속성을 사용하므로 크레이트에 `lib.rs`와 `mod.rs`가 없다.
- 플랫폼 코드는 `src/platform/<os>/` 아래에만 있으며 `os`는 `darwin`, `windows`, `linux` 중 하나다. Rust는 `#[cfg(target_os = "macos")]`로 `darwin` 모듈을 선택한다.
- 대체(stub) 파일은 없다. 플랫폼이 구현하지 않은 연산은 `src/platform/<os>/unsupported.*`에서 "not implemented" 오류를 반환한다.

## 플랫폼 인터페이스

`src/platform/platform.*`가 인터페이스를 정의하고, 각 `src/platform/<os>/`가 이를 구현한다.

| 영역 | 연산 |
| --- | --- |
| 창 | 창 준비, 창 단추 |
| 웹뷰 | 생성, 배치, 표시 여부, 배경, 닫기 |
| 표면 배치 | 트랜잭션 시작, 커밋, 취소, 표시 후 완료 |
| 외곽선 | 표면 위 외곽선 도형 |
| 입력 | 입력 감시, 네이티브 입력 주입 |
| 캡처 | 창 캡처 |
| Dock | Dock 메뉴 |
| 식별 | 디렉터리 식별 |
| 엔드포인트 | [로컬 엔드포인트](endpoint.ko.md) 전송 |

## 허용 차이

| ID | Wails | Tauri | 이유 |
| --- | --- | --- | --- |
| H1 | 없음 | `build.rs` | Rust는 빌드 스크립트에서 pkg-config와 Objective-C 컴파일을 실행하고, Go는 cgo 지시문을 사용한다 |
| H3 | `bridge.js` | 없음 | Wails는 애플리케이션이 생성한 웹뷰에 호출 통로를 제공하지 않는다 |
| H4 | `platform/darwin/webview.m` | 없음 | Wails에 자식 웹뷰 API가 없어 호스트가 Objective-C로 웹뷰를 생성하며, Tauri는 `add_child`를 사용한다 |
| A1 | 내용만 다름 | 내용만 다름 | `runtime/index.js`가 각 프레임워크의 호출 방식을 사용한다 |
| A2 | 없음 | `build.rs` | Tauri는 `tauri_build::build()`를 요구한다 |
| A3 | 없음 | `tauri.conf.json`, `capabilities/`, `icons/`, `gen/` | Tauri 설정 |
| A4 | `go.mod` | `Cargo.toml` | 언어마다 매니페스트가 다르며, 호스트 패키지에도 같은 차이가 있다 |

## 애플리케이션 트리

```
apps/wailsv3/                  apps/tauriv2/
  package.json                   package.json
  environment.json               environment.json
  runtime/index.js               runtime/index.js      차이 A1
  test/                          test/
  src/main.go                    src/main.rs
  go.mod                         Cargo.toml            차이 A4
  (없음)                         build.rs              차이 A2
  (없음)                         tauri.conf.json, capabilities/, icons/, gen/   차이 A3
```

## 구조 검사

`make hosts-check`가 실행하는 `scripts/check-hosts.mjs`는 두 호스트 트리와 두 애플리케이션 트리를 확장자를 제외한 상대 경로로 비교한다. 모든 차이가 허용 차이 표에 있을 때만 검사가 통과한다.

## native/darwin

`native/darwin`은 두 호스트가 호출하는 공용 macOS 라이브러리다.

| 경로 | 내용 |
| --- | --- |
| `src/` | `<이름>.h`와 `<이름>.m` 소스. 디렉터리가 플랫폼을 나타내므로 파일 이름에 `_darwin` 접미사가 없다 |
| `tests/` | 네이티브 테스트 |
| `Makefile` | 호스트가 pkg-config에서 `soksak-darwin`으로 찾는 정적 라이브러리를 빌드한다 |
