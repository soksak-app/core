# 호스트 계약 사례

[English](host-contract.md)

Wails 호스트(Go)와 Tauri 호스트(Rust)는 하나의 호스트 계약을 구현한다([네이티브 호스트](hosts.ko.md)). 이 문서는 두 호스트가 모두 실행해야 하는 계약 사례를 나열해, 한 호스트에서 검사한 동작을 다른 호스트에서도 검사하게 한다.

## 선언

각 호스트 테스트 함수는 함수 바로 위, Rust에서는 테스트 속성 위의 줄에 실행하는 사례를 선언한다.

```go
// contract: endpoint.transport.invalid-json-closes
func TestEndpointClosesOnInvalidJSON(t *testing.T) {
```

```rust
// contract: endpoint.transport.invalid-json-closes
#[test]
fn invalid_json_closes_connection() {
```

테스트 함수 하나는 쉼표로 나눈 여러 사례를 선언할 수 있다. `packages/host/wailsv3/tests/`, `packages/host/wailsv3/src/*_test.go`, `packages/host/tauriv2/tests/`, `packages/host/tauriv2/src/`의 테스트 모듈에 있는 모든 테스트 함수는 사례를 하나 이상 선언한다. 테스트는 단언이 사례의 결과를 확인할 때만 그 사례를 선언한다.

## 검사

`make host-contract-check`는 명령 감독자로 각 호스트의 테스트를 기본 구성과 진단 구성(Go 태그 `diagnostics`, Rust 기능 `diagnostics`)에서 실행하고 보고된 결과를 읽는다. 다음 경우에 실패한다.

- 호스트 범위의 사례에 그 호스트의 통과한 테스트가 없다.
- 선언한 테스트가 어느 구성에서도 실행되지 않았거나, 한 구성에서 실패했거나 건너뛰었다.
- 테스트가 사례를 선언하지 않았거나, 정의되지 않은 사례나 호스트 범위 밖의 사례를 선언했다.
- 선언이 테스트 함수에 붙어 있지 않다.
- 호스트 실행이 테스트 0개를 보고했다.

범위 열은 `both`이거나, 한 호스트에만 있는 동작이면 `<host> only: <이유>`다. 검사는 두 호스트가 모두 구현한 유일한 플랫폼인 macOS에서 실행한다. Windows와 Linux 진입점은 `not implemented` 오류를 반환하며 사례가 없다. 검사의 단위 테스트(`scripts/test/check-host-contract.test.mjs`)는 각 실패를 주입하며 `pnpm test`에서 실행된다.

## 애플리케이션 메뉴

두 호스트는 하나의 표로 애플리케이션 메뉴를 구성하므로 한쪽에만 있는 메뉴 항목은 결함이다. `title` 항목의 제목은 선택된 언어에서 온다. `system` 항목은 프레임워크가 제공하는 제목을 유지한다(번들이 표의 언어들을 현지화로 선언하므로 시스템이 관리하는 제목도 같은 언어를 따른다). 키는 `host.menu` 보고 형식을 쓴다. 지원 언어는 표의 언어 열이다 — 현재 `ko`·`en` 이며 새 언어는 워크벤치의 언어 선언과 함께 열을 추가해 확장한다. 언어는 일반 설정 `language`다. `auto` 는 시스템 언어의 주 태그를 지원 집합에서 찾고 없는 시스템 언어는 기본 언어 `en` 으로 내려간다. 페이지는 처음 사용 전과 변경마다 유효 언어를 호스트에 보낸다(`set_menu_language`). 그 전에 호스트는 같은 대응과 대비로 시스템 언어에서 메뉴를 구성한다.

메뉴:

| id | ko | en |
|---|---|---|
| app | (애플리케이션 이름) | (the application name) |
| file | 파일 | File |
| edit | 편집 | Edit |
| view | 보기 | View |
| window | 윈도우 | Window |
| help | 도움말 | Help |

항목:

| menu | id | source | ko | en | key |
|---|---|---|---|---|---|
| app | about | title | 정보 | About | |
| app | services | system | | | |
| app | hide | title | 가리기 | Hide | cmd+h |
| app | hide-others | title | 기타 가리기 | Hide Others | opt+cmd+h |
| app | show-all | title | 모두 보이기 | Show All | |
| app | quit | title | 종료 | Quit | cmd+q |
| file | close-window | title | 윈도우 닫기 | Close Window | cmd+w |
| file | close-all | system | | | |
| edit | undo | title | 실행 취소 | Undo | cmd+z |
| edit | redo | title | 다시 실행 | Redo | shift+cmd+z |
| edit | cut | title | 잘라내기 | Cut | cmd+x |
| edit | copy | title | 복사 | Copy | cmd+c |
| edit | paste | title | 붙여넣기 | Paste | cmd+v |
| edit | select-all | title | 모두 선택 | Select All | cmd+a |
| view | text-larger | title | 글자 크게 | Bigger Text | cmd+= |
| view | text-smaller | title | 글자 작게 | Smaller Text | cmd+- |
| view | text-default | title | 글자 기본 크기 | Default Text Size | cmd+0 |
| view | fullscreen | system | | | |
| window | new-window | title | 새 창 | New Window | shift+cmd+n |
| window | bring-all-to-front | system | | | |

`host.menu`는 `{language, menus}` 를 보고한다 — 활성 메뉴 언어와 구성된 메뉴다. 언어는 호스트 자신의 상태이지 제목에서 추측하는 값이 아니다. 호스트 사이 비교와 위 표 대조는 창 검사 계층에서 확인하고, `scripts/check-host-parity.mjs`가 두 호스트의 메뉴 빌더가 이 표와 같은 표를 담고 있는지 검사한다.

## Contract cases

| 사례 | 동작 | 범위 |
| --- | --- | --- |
| `authorization.surface.cross-surface-rejected` | 한 표면의 호출자가 다른 표면에 대해 요청하면 거부한다. | both |
| `authorization.surface.own-surface-accepted` | 자기 표면에 대한 호출자의 요청을 받아들인다. | both |
| `authorization.surface.unscoped-caller-rejected-for-document` | 표면이 없는 호출자가 표면을 대상으로 한 문서 요청을 거부한다. | both |
| `authorization.main.known-main-caller-accepted` | 표면이 없고 id가 주 창의 id인 호출자는 표면 대상 요청이 허용된다. | both |
| `authorization.main.unknown-main-caller-rejected` | 표면이 없고 id가 주 창의 id가 아닌 호출자를 거부한다. | both |
| `clipboard.persist-png.writes-exact-bytes` | 올바른 PNG 페이로드를 저장하면 입력 바이트와 정확히 같은 파일의 경로를 반환한다. | both |
| `clipboard.persist-png.owner-only-mode` | 저장한 PNG 파일의 모드는 0600이다. | both |
| `clipboard.png.rejects-oversize` | 16 MiB보다 큰 PNG 페이로드를 거부한다. | both |
| `clipboard.png.rejects-empty` | 빈 PNG 페이로드를 거부한다. | both |
| `clipboard.png.accepts-valid-within-bound` | 한도 안에서 PNG 서명과 올바른 `IHDR` 청크로 시작하는 페이로드를 받아들인다. | both |
| `clipboard.png.rejects-bad-signature` | 8바이트 PNG 서명으로 시작하지 않는 페이로드를 PNG 서명을 적은 오류로 거부한다. | both |
| `clipboard.png.rejects-bad-header` | 첫 청크가 CRC가 맞고, 너비와 높이가 0이 아니며, PNG가 허용하는 비트 깊이와 색 형식 조합이고, 압축과 필터 방식이 0이며, 인터레이스 방식이 0 또는 1인 13바이트 `IHDR` 청크가 아닌 페이로드를 PNG 헤더를 적은 오류로 거부한다. | both |
| `clipboard.read.requires-user-initiated` | 사용자의 명시적 붙여넣기가 아닌 클립보드 읽기를 거부한다. | both |
| `clipboard.read.rejects-unknown-type` | 사용자가 시작했더라도 알 수 없는 형식의 클립보드 읽기를 거부한다. | both |
| `clipboard.read.accepts-known-types` | 사용자가 시작한 텍스트와 파일 URL 읽기를 받아들인다. | both |
| `links.open.accepts-web-and-mail-schemes` | 절대 `http`, `https`, `mailto` URL은 열기를 받아들인다. | both |
| `links.open.rejects-other-schemes` | 다른 스킴의 URL, 해석되지 않는 URL, 8192자보다 긴 URL은 거부한다. | both |
| `notifications.request.accepts-tab-notices` | 제어 문자 없이 1–256자인 표면과 제목, 1–1024자인 본문의 알림을 받아들이며, 제거에는 표면만 필요하다. | both |
| `notifications.request.rejects-invalid-fields` | 비었거나 너무 길거나 제어 문자가 있는 표면, 제목, 본문은 그 필드를 적은 오류로 거부한다. | both |
| `diagnostics.capture-stop.payload-reports-frame-limit` | 한도에 도달한 녹화의 중지 페이로드는 frames, count, limited true, 가장 긴 간격을 보고한다. | both |
| `diagnostics.capture-stop.payload-reports-unbounded` | 한도에 도달하지 않은 녹화의 중지 페이로드는 limited false를 보고한다. | both |
| `diagnostics.capture-stop.payload-reports-layout-timeline` | 녹화 중지 페이로드는 기록된 layout transaction이 없어도 항상 `layouts` 배열을 보고한다. | both |
| `diagnostics.capture-stop.payload-preserves-layout-stages` | 각 `layouts` 항목은 기록된 ticket, begun, presented, committed 값을 유지한다. | both |
| `diagnostics.native-objects.payload-names-counts` | `diagnostics.native.objects` 응답은 라이브러리의 살아 있는 객체 수를 `windowCompositions`, `surfaceHosts`, `inputRegistrations` 정수로만 담는다. | both |
| `diagnostics.native-objects.equal-validates` | `diagnostics.native.objects`는 `equal`을 정확히 `windowCompositions`, `surfaceHosts`, `inputRegistrations`를 음이 아닌 정수로 담은 객체로만 받고, 다른 값은 `equal must be an object of windowCompositions, surfaceHosts and inputRegistrations, each a non-negative integer`로 거부한다. `equal`에 이르지 않은 수는 `window object counts did not reach <equal> within 10s; they are <counts>`로 실패하며, 각 수는 `windowCompositions N, surfaceHosts N, inputRegistrations N`으로 쓴다. | both |
| `diagnostics.process-exit.pid-validates` | `diagnostics.process.exit`는 `pid`를 1부터 2147483647 사이의 정수로만 받고, 없거나 다른 값은 `pid must be a positive integer`로 거부한다. | both |
| `documents.request.accepts-own-surface` | 호출자 자신의 표면에 대한 문서 요청을 받아들이고 표면과 이름 키를 반환한다. | both |
| `documents.request.rejects-foreign-or-missing-caller` | 호출자 표면이 없거나 다른 표면에서 온 문서 요청은 "not surface"로 실패한다. | both |
| `documents.request.rejects-invalid-names` | 빈 이름, 대문자, 하이픈으로 시작, 슬래시 포함, 65자 문서 이름을 거부한다. | both |
| `documents.request.zoom-must-be-finite-positive` | 확대 값이 없거나 0 또는 음수인 문서 확대 요청은 거부하고, 유한한 양수는 배율이다. | both |
| `documents.request.entry-requires-offset` | `entry` 문서 `go` 요청은 0이 아닌 정수 `offset`이 필요하고, `offset`이 있는 다른 동작은 거부한다. | both |
| `documents.commit.precedes-messages` | 웹뷰가 문서 commit 뒤에 보낸 메시지는 그 commit 처리 뒤에 처리되고, 한 웹뷰의 commit은 순서대로 처리되며, 다른 웹뷰의 메시지는 기다리지 않는다. | wailsv3 only: Wails는 WebKit의 commit과 script message를 메인 스레드에서 받아 handler마다 고루틴을 따로 실행하지만, Tauri는 commit에서 표면의 문서 상태를 초기화하지 않는다 |
| `documents.request.ignores-placement-fields` | 문서 요청을 해석하면 표면과 문서만 남기고 배치 필드를 버린다. | both |
| `documents.request.url-and-action-default-empty` | url과 action이 없는 문서 요청을 해석하면 둘 다 비어 있다. | both |
| `documents.registry.rejects-duplicate-reservation` | 같은 문서 키를 두 번 예약하면 "already attached"로 실패한다. | both |
| `documents.registry.reserved-name-is-not-attached` | 설정 전의 예약된 문서 키를 읽으면 실패한다. | both |
| `documents.registry.set-attaches-reserved-name` | 예약된 문서 키를 설정하면 성공하고 읽으면 핸들을 반환한다. | both |
| `documents.registry.lists-names-by-handle` | 등록소는 각 문서 핸들을 그 키와 함께 나열한다. | both |
| `documents.registry.surface-close-removes-only-its-documents` | 표면을 제거하면 그 문서를 반환하고 키를 읽을 수 없게 하며 다른 표면의 문서는 유지한다. | both |
| `documents.registry.rejects-set-after-surface-removed` | 표면이 제거된 문서 키의 설정은 실패한다. | both |
| `documents.registry.remove-reserved-returns-empty` | 예약만 된 문서 이름을 제거하면 빈 핸들로 성공한다. | both |
| `documents.registry.remove-attached-returns-handle-once` | 연결된 문서 이름을 제거하면 핸들을 반환하고, 다시 제거하면 실패한다. | both |
| `endpoint.process.one-owner-per-config-dir` | 같은 설정 디렉터리의 두 번째 엔드포인트는 "already owned by process"로 거부되고, 첫 엔드포인트는 닫을 때까지 잠금을 유지한다. | both |
| `endpoint.transport.http-request-line-closes` | HTTP 요청 줄은 응답이나 메서드 호출 없이 연결을 닫는다. | both |
| `endpoint.transport.invalid-json-closes` | 본문이 JSON이 아닌 프레임은 응답 없이 연결을 닫는다. | both |
| `endpoint.transport.closing-a-disconnected-connection-succeeds` | socket이 이미 끊긴 연결을 닫으면 성공한다. 다른 shutdown 오류는 보고한다. | tauriv2 only: Rust host는 socket을 명시적으로 shutdown하며 끊긴 socket을 보고하고, Go는 shutdown 없이 연결을 닫는다 |
| `endpoint.transport.non-jsonrpc-object-closes` | JSON-RPC 2.0 요청이 아닌 JSON 프레임은 응답 없이 연결을 닫는다. | both |
| `endpoint.transport.undeclared-method-closes` | 선언되지 않은 메서드는 응답 없이 연결을 닫고 페이지에 아무것도 전달하지 않는다. | both |
| `endpoint.diagnostics.methods-exist-only-in-diagnostic-builds` | 릴리스 빌드에서 diagnostics.transcript는 연결을 닫고 페이지에 닿지 않으며, 진단 빌드에서는 응답된다. | both |
| `endpoint.rpc.round-trip-by-id` | 한 연결의 여러 요청은 각각 같은 id와 결과를 가진 JSON-RPC 2.0 응답을 받는다. | both |
| `endpoint.rpc.page-params-omit-window` | 페이지는 window 필드를 뺀 전달 매개변수를 받는다. | both |
| `endpoint.rpc.unknown-window-1003` | 존재하지 않는 창에 대한 선언된 메서드는 페이지에 닿지 않고 오류 1003을 반환한다. | both |
| `endpoint.rpc.missing-window-param-invalid` | window 매개변수가 없는 status.get은 -32602를 반환한다. | both |
| `endpoint.names.unknown-host-name-1001` | 알 수 없는 host 이름의 command.run은 오류 1001을 반환한다. | both |
| `endpoint.names.missing-name-invalid` | name이 없는 status.get은 -32602를 반환한다. | both |
| `endpoint.names.owner-form-required` | owner.name 형식이 아닌 이름과 문자열이 아닌 이름은 -32602를 반환한다. | both |
| `endpoint.names.valid-name-examples` | core.surface.document와 plugin-x.a-1 같은 이름은 올바르다. | both |
| `endpoint.input.pointer-invalid-phase` | 알 수 없는 phase의 포인터 입력은 -32602를 반환한다. | both |
| `endpoint.input.pointer-missing-coordinate` | x가 없는 포인터 입력은 -32602를 반환한다. | both |
| `endpoint.input.pointer-numeric-button-rejected` | 숫자 포인터 버튼은 -32602를 반환한다. | both |
| `endpoint.input.pointer-middle-button-rejected` | 가운데 포인터 버튼은 -32602를 반환한다. | both |
| `endpoint.input.pointer-activate-only-on-move` | activate는 down phase에서 거부되고 move phase에서 받아들여진다. | both |
| `endpoint.input.pointer-activate-must-be-bool` | 불리언이 아닌 activate는 -32602를 반환한다. | both |
| `endpoint.input.pointer-defaults` | button이나 activate가 없는 포인터 입력은 왼쪽 버튼과 비활성화를 쓴다. | both |
| `endpoint.input.pointer-right-button-accepted` | 오른쪽 포인터 버튼을 받아들이고 오른쪽 버튼으로 전달한다. | both |
| `endpoint.input.pointer-phase-and-scroll-decoding` | drag와 scroll phase, deltaY, 소수 좌표를 그대로 전달한다. | both |
| `endpoint.input.key-unknown-modifier-rejected` | 알 수 없는 키 수정자는 -32602를 반환한다. | both |
| `endpoint.input.key-shift-command-mask` | shift와 command 수정자는 비트 마스크 9가 되고, 키와 phase는 그대로 전달된다. | both |
| `endpoint.input.key-control-option-and-text` | control과 option 수정자는 6이 되고 text는 그대로 전달된다. | both |
| `endpoint.input.key-invalid-phase-or-modifier-type` | 알 수 없는 키 phase나 배열이 아닌 modifiers 값은 -32602를 반환한다. | both |
| `endpoint.discovery.writes-endpoint-json` | endpoint.json은 전송 방식, 주소, pid, 애플리케이션, 버전, 실행 파일, 시작 시각을 담는다. | both |
| `endpoint.discovery.written-after-first-window` | 엔드포인트를 시작할 때 endpoint.json을 쓰지 않는다. 없는 창으로 게시하면 실패하고 파일을 쓰지 않으며, 있는 창으로 게시한 뒤에는 그 창의 요청에 응답한다. | both |
| `endpoint.discovery.endpoint-json-mode-0600` | endpoint.json의 모드는 0600이다. | both |
| `endpoint.discovery.removes-endpoint-json-on-close` | 엔드포인트를 닫으면 endpoint.json을 제거한다. | both |
| `endpoint.discovery.removes-socket-on-close` | 소켓은 서비스 중에 존재하고 엔드포인트를 닫으면 제거된다. | both |
| `endpoint.discovery.close-keeps-replacement` | 닫을 때 다른 프로세스가 쓴 endpoint.json은 제거하지 않는다. | both |
| `endpoint.socket.private-modes` | 소켓 디렉터리의 모드는 0700이고 소켓의 모드는 0600이다. | both |
| `endpoint.socket.sweeps-ended-process-sockets` | 수신을 시작하면 이 애플리케이션의 끝난 프로세스 소켓을 제거하고, 살아 있는 소켓과 다른 애플리케이션의 소켓은 유지한다. | both |
| `endpoint.socket.refuses-open-directory` | 다른 사용자에게 열린 소켓 디렉터리를 오류에 모드를 적어 거부한다. | both |
| `endpoint.socket.refuses-foreign-owner` | 다른 사용자가 소유한 소켓 디렉터리를 "belongs to another user"로 거부한다. | both |
| `endpoint.socket.refuses-non-directory` | 심볼릭 링크인 소켓 경로를 "is not a directory"로 거부한다. | both |
| `endpoint.watch.notifies-watching-connection` | status.watch 뒤의 변경은 window, name, value를 가진 status.changed 알림으로 그 연결에 도착한다. | both |
| `endpoint.watch.non-watching-connection-not-notified` | 구독하지 않은 연결은 알림을 받지 않는다. | both |
| `endpoint.watch.unwatch-is-per-connection` | 한 연결의 구독 해제는 같은 상태를 구독한 다른 연결의 알림을 유지한다. | both |
| `endpoint.watch.page-watch-deduplicated` | 같은 상태를 구독하는 두 번째 연결은 페이지에 status.watch를 더 보내지 않는다. | both |
| `endpoint.watch.no-page-unwatch-while-watched` | 어떤 연결이든 상태를 구독하는 동안 페이지는 status.unwatch를 받지 않는다. | both |
| `endpoint.watch.last-watcher-close-unwatches-page` | 마지막 구독 연결을 닫으면 페이지에 status.unwatch를 보낸다. | both |
| `endpoint.watch.registry-reflects-watches` | 구독 등록소는 활성 구독만 정확히 나열하고 마지막 구독자가 떠나면 비어 있다. | both |
| `endpoint.watch.surface-and-plain-forwarded-separately` | 같은 이름의 표면 구독과 일반 구독은 각자의 매개변수로 모두 페이지에 전달된다. | both |
| `endpoint.watch.empty-surface-invalid` | 빈 surface의 status.watch는 -32602를 반환한다. | both |
| `endpoint.watch.surface-change-names-surface` | 표면 구독의 변경은 surface를 담고, 일반 구독의 변경은 담지 않는다. | both |
| `endpoint.watch.surface-unwatch-forwarded-with-surface` | 표면 구독을 해제하면 surface를 담은 status.unwatch를 페이지에 보낸다. | both |
| `endpoint.watch.surface-unwatch-keeps-plain-watch` | 표면 구독을 해제해도 같은 이름의 일반 구독은 유지된다. | both |
| `endpoint.watch.subscription-arrival-order` | 연달아 보낸 watch, unwatch, watch는 느린 페이지에 그 순서로 도착하고 연결은 계속 구독한다. | both |
| `endpoint.watch.other-requests-not-blocked-by-pending-subscription` | 페이지 구독 해제가 대기 중이어도 같은 연결의 다음 요청에 응답한다. | both |
| `exposure-reply.payload.main-reply-unscoped` | surface가 없는 주 문서 응답 페이로드는 빈 surface로 해석된다. | both |
| `exposure-reply.payload.scoped-reply-keeps-surface` | surface가 있는 응답 페이로드는 인코딩과 해석을 거쳐도 surface를 유지한다. | both |
| `exposure-reply.target.main-and-surface-distinct` | surface가 없는 응답은 창의 주 문서를, surface가 있는 응답은 그 표면 문서를 대상으로 한다. | both |
| `exposure-reply.target.invalid-surface-rejected` | surface가 null, 빈 문자열, 숫자, 객체인 응답은 주 응답이 아니라 오류다. | both |
| `exposure.list.appends-host-entries-registered` | 노출 목록은 페이지 항목을 유지하고 호스트 상태와 명령 항목을 등록된 항목으로 더한다. | both |
| `exposure.list.host-entries-exact-sorted-set` | 호스트 상태와 명령 이름은 정해진 정렬 목록과 같다. | both |
| `exposure.list.host-entries-described` | 모든 호스트 항목은 비어 있지 않은 설명을 가진다. | both |
| `exposure.list.host-quit-result-null` | host.quit은 null 결과 스키마를 선언한다. | both |
| `exposure.list.non-object-list-rejected` | 객체가 아닌 페이지 노출 목록은 오류다. | both |
| `exposure.timeout.command-run-default-and-declared` | command.run은 기본 10초를 기다리고 선언된 timeout을 쓴다. | both |
| `exposure.timeout.status-next-unbounded` | timeout이 없는 status.next는 시간 제한이 없다. | both |
| `exposure.timeout.invalid-timeout-rejected` | 0, 600000 초과, 소수, 문자열, 음수인 command.run timeout은 -32602를 반환한다. | both |
| `exposure.timeout.status-next-timeout-rejected` | timeout이 있는 status.next는 -32602를 반환한다. | both |
| `exposure.relay.reply-resolves-request` | 대상 문서에서 온 같은 id의 응답은 그 결과로 요청을 완료한다. | both |
| `exposure.relay.keeps-value-text` | Page 응답은 page가 보낸 텍스트 그대로 중계되므로 값의 key 순서가 유지된다(`{"zeta":1,"alpha":{"b":2,"a":1}}`는 보낸 그대로다). | both |
| `exposure.relay.missing-result-is-null` | result가 없는 응답은 null로 완료된다. | both |
| `exposure.relay.error-reply-keeps-code-and-message` | 오류 응답은 같은 코드와 메시지로 요청을 실패시킨다. | both |
| `exposure.relay.foreign-document-reply-ignored-timeout-1005` | 다른 문서의 응답은 무시되고, 요청은 1005로 시간 초과되며, 늦은 응답도 받지 않는다. | both |
| `exposure.relay.send-failure-1003` | 문서로 보내기가 실패하면 요청은 즉시 1003으로 실패한다. | both |
| `exposure.relay.closed-document-fails-pending-1003` | 문서를 닫으면 대기 중인 요청은 1003으로 실패한다. | both |
| `exposure.relay.no-timeout-waits-until-close` | timeout이 없는 요청은 문서가 닫힐 때까지 기다린 뒤 1003으로 실패한다. | both |
| `exposure.window.dropped-view-work-reports-no-view` | 실행되기 전에 파괴된 웹뷰로 보낸 작업은 수신 오류 대신 결과 없음이 되어, `host.window`가 닫히는 모달을 뷰 없이 보고한다. 실행되어 실패한 작업은 그 오류를 유지한다. | tauriv2 only: Tauri는 웹뷰 작업을 dispatch로 실행하며 웹뷰가 파괴되면 작업을 버리고, Wails는 모달 뷰를 자기 기록에서 읽는다 |
| `exposure.windows.closing-window-omitted` | `host.windows`는 닫기가 받아들여진 창을 조회하지 않고 목록에서 뺀다. | tauriv2 only: Tauri는 창마다 제목과 초점을 runtime에 묻는데, 닫기가 runtime에서 창을 지운 뒤 Destroyed 이벤트가 등록을 지우기 전에는 이 조회가 실패한다. Wails는 제목을 host 상태에서 읽고 초점 조회는 오류를 돌려주지 않는다 |
| `exposure.windows.open-window-query-failure-reported` | 열린 창의 제목이나 초점 조회가 실패하면 `host.windows`가 그 오류로 실패한다. | tauriv2 only: Tauri는 창마다 제목과 초점을 runtime에 묻는데, 닫기가 runtime에서 창을 지운 뒤 Destroyed 이벤트가 등록을 지우기 전에는 이 조회가 실패한다. Wails는 제목을 host 상태에서 읽고 초점 조회는 오류를 돌려주지 않는다 |
| `exposure.windows.entry-fields` | 목록의 창은 `ready`, `window`, `title`, `project`(프로젝트가 없으면 null), `key`를 가진다. | tauriv2 only: Tauri는 창마다 제목과 초점을 runtime에 묻는데, 닫기가 runtime에서 창을 지운 뒤 Destroyed 이벤트가 등록을 지우기 전에는 이 조회가 실패한다. Wails는 제목을 host 상태에서 읽고 초점 조회는 오류를 돌려주지 않는다 |
| `flush.queue.rejects-send-when-full` | 사이드카가 읽지 않아 쓰기 대기열이 가득 차면 보내기가 실패한다. | both |
| `flush.queue.full-error-says-not-keeping-up` | 대기열이 가득 찬 오류는 "is not keeping up"을 적는다. | both |
| `flush.buffer.replies-delivered-after-drain` | 대기열이 가득 찬 동안 버퍼에 넣은 응답은 사이드카가 다시 읽은 뒤 도착한다. | both |
| `flush.buffer.closes-delivered-after-drain` | 대기열이 가득 찬 동안 버퍼에 넣은 표면 닫기 알림이 사이드카에 도착한다. | both |
| `flush.buffer.consumed-acks-not-coalesced` | 버퍼에 넣은 consumed 응답은 같은 이미지의 두 응답을 포함해 각각 한 번 도착한다. | both |
| `flush.buffer.delivered-after-queued-bodies` | 버퍼에 넣은 응답과 닫기 알림은 이미 대기열에 있던 본문 뒤에 도착한다. | both |
| `images.invalidate.sidecar-connection-loss-resends-configure` | 사이드카의 그림을 무효화하면 같은 크기의 configure 를 다시 보내고 다른 사이드카의 그림은 그대로 둔다. | both |
| `performance.trace.enable-writes-log-and-sidecar-flags` | 트레이스를 켜면 로그 파일을 만들고 이미 있는 모든 서비스 디렉터리에 로그 경로 플래그를 쓴다. | both |
| `performance.trace.disable-removes-flags-keeps-log` | 트레이스를 끄면 사이드카 플래그를 지우고 로그 파일은 남긴다. | both |
| `performance.trace.relay-requires-object-with-event` | 중계하는 페이지 줄은 event 를 담은 객체여야 한다. 거부된 줄은 아무 것도 덧붙이지 않는다. | both |
| `performance.trace.enable-without-services` | 서비스가 생기기 전에도 활성 호스트는 페이지 이벤트를 받는다. | both |
| `performance.trace.already-off-writes-nothing` | 이미 비활성인 추적을 끄면 출력을 만들거나 덧붙이지 않는다. | both |
| `performance.trace.relay-records-writer-pid` | 중계한 page 줄은 그 줄을 쓰는 host process를 `pid`로 기록한다. | both |
| `performance.trace.rotates-at-10mb` | 10 MB 이상인 출력에 host 줄을 덧붙이면 먼저 그 출력을 `performance.ndjson.1`로 옮기고 새 출력을 시작한다. | both |
| `performance.sampler.failed-reading-is-explicit` | 상주 크기를 얻지 못한 sampler 읽기는 `rss_host_kb` 대신 `error`를 기록한다. | both |
| `performance.clock.before-epoch-is-explicit` | 유닉스 epoch 이전의 trace 시각은 epoch가 아니라 오류다. | tauriv2 only: Rust host는 epoch부터의 기간으로 시각을 적으므로 그 이전에서 실패하고, Go는 모든 시각을 적는다 |
| `performance.trace.switch-and-relay-report-filesystem-errors` | 스위치와 중계 요청은 디렉터리·플래그·출력 실패를 반환한다. | both |
| `performance.trace.invalid-switch-and-cleanup-errors` | 잘못된 스위치 읽기와 플래그 디렉터리는 오류이며 정리는 잘못된 디렉터리를 보존한다. | both |
| `performance.trace.derive-service-flags-and-reset` | 새 서비스는 호스트 스위치를 받는다. 초기화와 비활성 재접속은 잔여 플래그를 제거하고 비활성 계측은 이벤트를 구성하지 않는다. | both |
| `log.open.rotates-at-10mb` | 10 MB 이상인 로그 파일을 열면 먼저 `<이름>.1`로 옮겨 이전 세대를 대체하고 새 파일을 시작한다. | both |
| `log.open.appends-below-bound` | 더 작은 로그 파일을 열면 거기에 덧붙이고, 새 로그 파일은 mode 0600이다. | both |
| `log.application.start-replaces-standard-error` | 애플리케이션 로그를 시작하면 실행의 첫 줄을 쓰고 그 파일을 프로세스와 그 프로세스가 시작하는 자식의 표준 오류로 만든다. | both |
| `log.service.standard-error-goes-to-service-log` | 호스트가 시작한 영속 서비스는 표준 오류를 `logs/<실행 파일 이름>.log`에 쓴다. | both |
| `log.service.open-failure-fails-start` | 서비스 로그를 열 수 없으면 `sidecar <name>: service log: <error>`로 시작을 실패시키고 서비스를 시작하지 않는다. | both |
| `images.envelope.rejects-unattached-image` | 연결된 적 없는 이미지 이름의 봉투에 notAttached로 응답한다. | both |
| `images.envelope.refusal-echoes-name-and-sequence` | 거부 응답은 봉투의 name과 sequence를 담는다. | both |
| `images.envelope.refusal-preserves-quoted-name` | 따옴표가 든 이름의 거부 응답은 올바른 JSON이며 이름을 유지한다. | both |
| `images.envelope.rejects-other-sidecar` | 다른 사이드카가 보낸 연결된 이미지의 봉투에 notAttached로 응답한다. | both |
| `images.envelope.presents-attached-current-frame` | 연결한 사이드카가 보낸 현재 raster 프레임은 토큰, 크기, 이름, sequence와 함께 표시된다. | both |
| `images.envelope.present-carries-nonce-scale-generation-raster` | 표시할 프레임은 nonce, scale, generation, raster도 담는다. | both |
| `images.envelope.rejects-unsupported-format` | bgra8이 아닌 형식의 봉투에 unsupported로 응답한다. | both |
| `images.envelope.rejects-bad-nonce-length` | nonce가 16바이트가 아닌 봉투에 unsupported로 응답한다. | both |
| `images.envelope.rejects-unknown-token-kind` | 토큰 종류가 iosurface-global이 아닌 봉투에 unsupported로 응답한다. | both |
| `images.envelope.ignores-body-without-image` | image 필드가 없는 JSON 본문은 이미지 봉투가 아니다. | both |
| `images.envelope.ignores-invalid-json` | JSON이 아닌 본문은 이미지 봉투가 아니다. | both |
| `images.ack.consumed-carries-frame-identity` | 표시에 성공하면 consumed와 프레임의 name, generation, raster, sequence로 응답한다. | both |
| `images.ack.failure-carries-error-and-frame-identity` | 표시에 실패하면 오류와 프레임의 name, generation, raster, sequence로 응답한다. | both |
| `images.transfer.rejects-duplicate-sequence` | 현재 raster에서 같은 sequence를 반복하면 stale로 응답한다. | both |
| `images.transfer.reconfigure-advances-raster` | 새 크기를 구성하면 더 큰 raster 번호를 반환한다. | both |
| `images.transfer.rejects-stale-raster` | 대체된 raster의 프레임에는 stale로 응답하고 새 raster의 프레임은 표시한다. | both |
| `images.transfer.configure-stamps-current-generation` | raster 구성은 현재 표면 generation을 담는다. | both |
| `images.transfer.generation-advances` | 나중 generation의 번호가 더 크다. | both |
| `images.transfer.rejects-old-generation-after-reattach` | 새 generation에서 이미지를 다시 연결하면 이전 generation의 프레임에 notAttached로 응답한다. | both |
| `images.transfer.reattach-continues-raster` | 같은 세대에서 떼었다가 다시 붙인 그림은 마지막 래스터 리비전보다 큰 값으로 이어 세므로, 다음 구성이 사이드카가 받은 어떤 구성보다 새롭다. 새 세대는 다시 센다. | both |
| `images.transfer.new-generation-invalidates-queued-old-frame` | 이미지를 닫기 전에 새 generation을 시작하면 대기 중인 이전 generation 프레임은 notAttached로 응답된다. | both |
| `images.wait.blocks-before-first-frame` | 표시 대기는 보이는 raster의 첫 프레임 전에는 통과하지 않는다. | both |
| `images.wait.releases-after-current-frame-presented` | 현재 raster의 프레임이 표시되면 표시 대기가 통과한다. | both |
| `images.wait.successful-handle-replies-consumed` | 주 스레드 표시에 성공한 봉투를 처리하면 consumed로 응답한다. | both |
| `images.wait.newer-sequence-rearms-wait` | 같은 raster에서 새 sequence를 결정하면 표시 대기가 다시 막힌다. | both |
| `images.wait.reconfigure-clears-presented` | raster를 다시 구성하면 표시 상태를 지운다. | both |
| `images.wait.hidden-image-does-not-block` | 숨긴 이미지는 표시 대기를 막지 않고, 다시 보이면 다시 막는다. | both |
| `images.wait.hidden-surface-does-not-block` | 숨긴 표면은 표시 대기를 막지 않고, 다시 보이면 다시 막는다. | both |
| `images.wait.ended-generation-does-not-block` | 표면 generation을 끝내면 표시 대기가 풀린다. | both |
| `images.visibility.survives-first-document-navigation` | 첫 문서 이동 전에 숨긴 표면은 이동 뒤에도 숨겨진 상태를 유지한다. | both |
| `images.visibility.hidden-surface-defers-configuration` | 숨긴 표면의 이미지를 구성하면 표면이 보일 때까지 구성을 반환하지 않는다. | both |
| `images.visibility.shown-surface-reconfigures-its-raster` | 숨겼다가 다시 보인 표면은 같은 크기라도 새 raster revision을 설정하므로, 표시 장벽은 숨긴 동안의 frame을 기다리지 않는다. | both |
| `images.visibility.refresh-list-excludes-hidden` | 새로 고침 목록은 숨긴 표면의 이미지와 숨긴 이미지를 뺀다. | both |
| `images.present.rejects-frame-superseded-during-main-thread` | 주 스레드 표시 전에 raster가 다시 구성된 프레임에 stale로 응답한다. | both |
| `images.present.rejects-frame-detached-during-main-thread` | 주 스레드 표시 전에 표면 이미지가 제거된 프레임에 stale로 응답한다. | both |
| `images.present.main-thread-failure-reports-present-failed` | 주 스레드 표시가 실패하면 presentFailed로 응답하고 표시 대기는 그 오류를 반환한다. | both |
| `images.present.missing-native-surface-requests-reconfiguration` | notFound로 실패한 표시는 같은 raster의 새 구성을 요청한다. | both |
| `images.attach.surface-close-removes-only-its-images` | 표면을 제거하면 그 이미지 핸들을 반환하고 다른 표면의 이미지는 유지한다. | both |
| `images.attach.rejects-reservation-without-sidecar` | 소유 사이드카가 없는 이미지 예약을 거부하고 아무것도 등록하지 않는다. | both |
| `images.present.replaced-frame-is-logged-as-invalidated` | 더는 현재가 아닌 프레임(`stale`, `notAttached`, `staleRaster native=... frame=...`)은 `stale`로 답하고 표시 실패로 기록하지 않으며 `image frame invalidated before native presentation: ... reason=<detail>`을 남긴다. | both |
| `images.present.failure-line-names-the-current-frame` | 다른 표시 실패는 그 사유(알 수 없는 상세는 `presentFailed`)로 답하고 `image present on main thread error: ... reason=<detail> current <frame state>`를 남긴다. | both |
| `recording.finish.keeps-folder-and-reports-frames` | 녹화를 마치면 폴더를 유지하고 프레임 수를 보고하며, 두 번째 마침은 실패한다. | both |
| `recording.start.failed-open-removes-folder` | 캡처 열기에 실패한 녹화는 폴더를 제거하고 실행 중인 것을 남기지 않는다. | both |
| `recording.start.failed-start-removes-folder` | 캡처 시작에 실패한 녹화는 폴더를 제거하고 실행 중인 것을 남기지 않는다. | both |
| `recording.start.no-first-frame-stops-and-removes` | 첫 프레임이 없는 녹화는 중지되고 폴더가 제거된다. | both |
| `recording.start.rejects-while-running` | 녹화 중에 녹화를 시작하면 실패하고 폴더를 만들지 않는다. | both |
| `recording.abort.stops-removes-and-allows-next` | 녹화를 중단하면 중지하고 폴더를 제거하며 다음 녹화를 허용한다. | both |
| `recording.target.prepared-each-recording` | 준비가 그때의 창 크기로 stream 출력 크기를 정하므로, 녹화마다 같은 대상도 다시 준비한다. | both |
| `recording.target.different-target-reopened` | 다른 대상을 녹화하면 대상을 다시 준비한다. | both |
| `recording.abort.reports-stop-failure-and-removes-folder` | 중지에 실패한 중단은 중지 오류를 보고하고 폴더는 그래도 제거한다. | both |
| `sidecars.send.delivers-only-to-owning-window` | 각 창의 사이드카 메시지는 사이드카, 표면, 본문이 그대로인 이벤트로 그 창에만 돌아온다. | both |
| `sidecars.send.rejects-surface-owned-by-another-window` | 다른 창이 소유한 표면으로 보내면 "another window"로 실패한다. | both |
| `sidecars.protocol.request-lines-carry-surface-root-body` | 사이드카는 surface, root, body 요청 줄을 보낸 순서로 받는다. | both |
| `sidecars.close-owner.sends-closed-per-surface` | 창의 소유를 닫으면 각 표면의 closed 알림을 보낸다. | both |
| `sidecars.close.keeps-other-sessions` | 제거된 surface를 닫으면 그 surface에만 closed 알림을 보낸다. surface가 아닌 plugin 상태 session을 포함한 창의 다른 session은 열린 채로 남고, 창의 project가 해제된 뒤에도 첫 요청의 root를 유지한다. | both |
| `sidecars.retain.sends-layout-and-known-surfaces` | retain은 실행 중이거나 엔드포인트가 게시된 영속 서비스마다, 주어진 레이아웃 표면과 이 프로세스가 보낸 모든 표면(없으면 빈 배열)을 담은 `retain` 요청 하나를 보내고 서비스가 닫은 수를 반환한다. | both |
| `sidecars.retain.reports-service-failure` | `ok: false`인 `retained` 응답은 서비스의 사유를 담은 오류로 반환한다. | both |
| `sidecars.retain.skips-service-without-endpoint` | 실행 중인 서비스와 그 엔드포인트 파일이 없으면 retain은 서비스를 시작하지 않고 아무것도 닫지 않는다. | both |
| `sidecars.retain.rejects-after-stop` | 사이드카가 멈춘 뒤 시작한 retain이나 서비스를 준비한 뒤 멈춤이 끼어든 retain은 "sidecars are stopped"로 실패하고 서비스에 retain을 보내지 않는다. | both |
| `menu.application.view-has-full-screen-and-text-size` | 애플리케이션 메뉴의 View 메뉴에는 전체 화면과 Command `=`, `-`, `0`의 [글자 크기](text-size.ko.md) 항목이 있고, 웹뷰 전체를 확대하거나 다시 읽는 메뉴 항목이 없다. | both |
| `sidecars.protocol.surface-keeps-its-first-root` | 소유 창의 프로젝트가 바뀐 뒤에도 열린 표면의 요청과 closed 알림은 첫 요청의 root를 가진다. | both |
| `sidecars.protocol.closed-surface-messages-are-discarded-and-unknown-ones-fail` | 호스트가 닫은 표면에 대한 stdio sidecar 메시지는 버리고, 호스트가 그 프로세스에 한 번도 보내지 않은 표면의 메시지는 보낸 표면에 `unknown surface <surface>`를 전달하며 sidecar를 실패시킨다. | both |
| `sidecars.send.rejects-undeclared-sidecar` | 어떤 플러그인도 선언하지 않은 사이드카로 보내면 "not declared"로 실패한다. | both |
| `sidecars.send.rejects-after-stop` | 사이드카가 멈춘 뒤 보내면 "stopped"로 실패한다. | both |
| `sidecars.send.rejects-when-no-plugin-declares-sidecars` | 선언된 사이드카가 없으면 생성은 성공하고 모든 보내기는 "not declared by any plugin"으로 실패한다. | both |
| `sidecars.start.fails-on-missing-executable` | 디스크에 없는 선언된 실행 파일은 첫 보내기를 사이드카 이름과 함께 실패시킨다. | both |
| `sidecars.declaration.fails-on-missing-sidecar-json` | sidecar.json이 없는 설치 sidecar 폴더는 그 경로와 함께 설치 sidecar 찾기를 실패시킨다. | both |
| `sidecars.declaration.rejects-executable-escaping-package` | 패키지 밖의 실행 파일 경로는 생성을 실패시킨다. | both |
| `sidecars.declaration.rejects-absolute-executable` | 절대 실행 파일 경로는 생성을 실패시킨다. | both |
| `sidecars.declaration.rejects-unsupported-protocol` | 지원하지 않는 프로토콜 버전은 생성을 실패시킨다. | both |
| `sidecars.declaration.rejects-unknown-transport` | 알 수 없는 전송 방식은 "is not supported"로 생성을 실패시킨다. | both |
| `sidecars.declaration.persistent-requires-config-directory` | 설정 디렉터리가 없는 지속 전송은 생성을 실패시킨다. | both |
| `sidecars.persistent.accepts-non-canonical-config-directory` | 지속 전송은 정규화되지 않은 설정 디렉터리 경로를 받아들인다. | both |
| `sidecars.send.fails-fast-when-sidecar-not-keeping-up` | 읽지 않는 사이드카로의 큰 보내기는 "is not keeping up"으로 끝난다. | both |
| `sidecars.send.slow-sidecar-does-not-block-others` | 한 사이드카 대기열이 가득 찬 동안 다른 사이드카로의 보내기는 50ms 안에 반환된다. | both |
| `sidecars.send.start-does-not-block-other-sidecars` | 영속 service가 hello 응답을 늦추는 동안 실행 중인 다른 사이드카로의 보내기는 50ms 안에 반환된다. | both |
| `sidecars.close.answer-ends-closing` | `closed`를 보낸 뒤 `host.sidecars`는 사이드카가 답할 때까지 그 표면을 나열하고, 답하면 목록이 빈다. | both |
| `sidecars.close.failed-answer-is-logged` | `error`가 있는 닫기 응답은 host 로그에 "sidecar <name>: close <surface>: <error>"를 쓰고 닫는 중 항목을 끝낸다. | both |
| `sidecars.close.unexpected-answer-fails` | host가 닫고 있지 않은 표면의 닫기 응답은 "unexpected close answer for <surface>"로 사이드카를 실패시킨다. | both |
| `sidecars.close.process-end-clears-closing` | 사이드카 process가 답하지 않고 끝나면 그 표면은 `host.sidecars`에서 빠진다. | both |
| `sidecars.stop.honors-stop-timeout` | 입력을 비우지 않는 사이드카의 중지는 중지 제한 시간의 두 배 안에 반환된다. | both |
| `sidecars.stop.graceful-on-stdin-eof` | 입력 끝에서 종료하는 사이드카는 제한 시간을 기다리지 않고 멈춘다. | both |
| `sidecars.stop.kills-after-timeout` | 입력 끝을 무시하는 사이드카는 중지 제한 시간 뒤에 강제 종료된다. | both |
| `sidecars.stop.closes-unread-output` | 멈추는 동안이든 실패 뒤든 host가 표준 입출력 사이드카의 출력을 더 읽지 않으면 파이프의 자기 쪽 끝을 닫으므로, 끝나면서 파이프가 담는 것보다 많이 쓰는 사이드카는 쓰기 오류를 받고 강제 종료 없이 끝난다. | both |
| `sidecars.stop.forgets-running-sidecars` | 중지는 입력을 끝내기 전에 모든 사이드카를 실행 목록에서 빼고 답하지 않은 닫기를 지우므로, 그 뒤 표면이나 소유 창을 닫아도 아무것도 보내지 않고 닫는 중인 표면을 알리지 않는다. | both |
| `sidecars.protocol.message-at-limit-is-delivered` | 줄바꿈 앞이 정확히 67108864 byte인 사이드카 메시지가 손상 없이 소유 창에 도착한다. | both |
| `sidecars.failure.oversize-message-terminates-and-notifies` | 67108864 byte보다 긴 줄은 줄이 끝나기를 기다리지 않고 사이드카 프로세스를 끝내고 "exceeds"를 담은 `sidecar-failure`를 소유 창에 전달한다. | both |
| `sidecars.failure.invalid-message-terminates-and-notifies` | JSON이 아닌 줄이나 `body`가 없는 JSON 객체는 사이드카 프로세스를 끝내고 "invalid message"를 담은 `sidecar-failure`를 전달한다. | both |
| `sidecars.failure.output-close-notifies-each-surface` | 호스트가 종료 중이 아닐 때 출력이 끝난 사이드카는 그 사이드카에 보낸 각 표면의 소유 창에 "output closed"를 담은 `sidecar-failure`를 전달하고, 다음 전송은 새 프로세스를 시작한다. | both |
| `sidecars-transport.endpoint.concurrent-hosts-share-authenticated-service` | 두 호스트가 토큰으로 한 서비스 엔드포인트에 인증하고 각자의 이벤트를 받는다. | both |
| `sidecars-transport.hello.declares-protocol-one` | hello 요청은 프로토콜 1을 선언한다. | both |
| `sidecars-transport.reconnect.after-connection-loss-preserves-owner` | 서비스가 연결을 끊으면 다음 보내기가 다시 연결하고 이벤트는 계속 소유자와 표면에 도착한다. | both |
| `sidecars-transport.stop.close-owner-failure-returns-promptly` | close-owner 실패 응답은 중지를 1초 넘게 늦추지 않는다. | both |
| `sidecars-transport.hello.rejects-auth-failure` | 실패한 hello 응답은 보내기를 "authentication handshake failed"로 실패시킨다. | both |
| `sidecars-transport.hello.rejects-unsupported-protocol-without-replacing-endpoint` | 다른 프로토콜의 hello 응답은 보내기를 실패시키고 endpoint.json을 바꾸지 않는다. | both |
| `sidecars-transport.hello.times-out` | hello를 받고 답하지 않는 service는 5초 뒤 "the service did not answer hello within 5s"로 보내기를 실패시킨다. | both |
| `sidecars-transport.startup.times-out` | 준비 상한 안에 endpoint를 출력하지 않는 시작한 service는 "the service did not print its endpoint within <bound>"로 보내기를 실패시키고, host는 그 service를 끝내고 회수한다. | both |
| `sidecars-transport.startup.exits-before-endpoint` | endpoint 전에 끝난 시작한 service는 "service exited before endpoint"로 보내기를 실패시킨다. | both |
| `sidecars-transport.endpoint.replaces-dead-service-endpoint` | 죽은 서비스가 남긴 엔드포인트는 새 서비스 엔드포인트로 바뀐다. | both |
| `sidecars-transport.endpoint.live-unreachable-reported-without-replacement` | 살아 있지만 연결할 수 없는 서비스의 엔드포인트는 보내기를 실패시키고 바뀌지 않는다. | both |
| `sidecars-transport.stop.close-owner-then-shutdown` | 중지는 close-owner를 보내고 성공 응답 뒤에 shutdown을 보낸다. | both |
| `sidecars-transport.persistent.revives-a-lost-connection` | 서비스가 연결을 끊으면 호스트가 전송 없이 다시 시작하고 소유 표면이 연결 이벤트를 받는다. | both |
| `sidecars-transport.endpoint.zombie-service-does-not-exist` | 좀비 서비스 pid 는 존재하는 서비스로 치지 않아 낡은 endpoint 를 교체한다. | both |
| `sidecars-transport.persistent.revive-failure-is-reported` | 재시작 실패는 연결 끊김과 그 까닭을 소유 표면에 알린다. | both |
| `sidecars-transport.persistent.oversize-line-fails-the-connection` | 64 MiB 메시지 한도보다 긴 service 줄은 줄의 나머지를 읽지 않고 연결을 닫으며, 보낸 surface에 `message exceeds 67108864 bytes`와 함께 `sidecar-failure`를 보낸다. | both |
| `sidecars-transport.persistent.invalid-event-fails-the-connection` | JSON 객체가 아닌 service 줄이나 문자열 `surface`가 없는 surface event는 연결을 닫고 보낸 surface에 `invalid message: ...`와 함께 `sidecar-failure`를 보낸다. 다음 전송은 다시 연결한다. | both |
| `webkit-children.reap.requires-alive-webkit-same-start` | 기록된 WebKit 자식은 살아 있고, 여전히 WebKit 프로세스이며, 시작 시각이 기록과 같을 때만 죽는다. | both |
| `surface-activation.owner.resolves-registered-view` | 등록된 네이티브 뷰는 그 표면 id로 해석된다. | both |
| `surface-activation.owner.ignores-unknown-view` | 등록되지 않은 네이티브 뷰는 표면으로 해석되지 않는다. | both |
| `surface-activation.owner.ignores-empty-owner` | 빈 표면 id로 등록된 뷰는 표면으로 해석되지 않는다. | both |
| `surface-activation.create.propagates-native-failure` | 네이티브 표면 생성이 실패하면 네이티브 오류와 표면 id를 담은 오류를 반환한다. | both |
| `surface-activation.create.rejects-nil-handle` | 핸들을 반환하지 않은 네이티브 표면 생성은 "nil handle"로 실패한다. | both |
| `surfaces-geometry.rect.accepts-zero-size` | 크기가 0인 사각형은 올바르다. | both |
| `surfaces-geometry.rect.rejects-negative-size` | 크기가 음수인 사각형은 잘라 맞추지 않고 거부한다. | both |
| `surfaces-geometry.rect.rejects-non-finite` | 크기가 유한하지 않은 사각형을 거부한다. | both |
| `surfaces-geometry.sync.rejects-surface-rect-before-layout` | 배치 트랜잭션을 시작하기 전에 실행하는 검사는 표면 사각형의 크기가 음수인 동기화 요청을 `surface "<id>" geometry must not have a negative size`로 거부하고, 올바른 요청은 받는다. | both |
| `surfaces-geometry.sync.rejects-overlay-rect-before-layout` | 배치 트랜잭션을 시작하기 전에 실행하는 검사는 창 overlay 사각형의 크기가 음수인 동기화 요청을 `window overlay geometry must not have a negative size`로 거부하고, 올바른 요청의 overlay를 표시 여부와 함께 반환한다. | both |
| `surfaces.sync.failure-leaves-no-begun-layout` | 표면 동기화는 배치 트랜잭션을 시작하기 전에 창 덮개를 놓으므로 거부된 덮개는 트랜잭션을 시작하지 않고, 뒤 단계가 실패하면 시작한 트랜잭션을 취소한다. 성공한 동기화는 취소하지 않는다. | both |
| `host-calls.decode.messages` | 인자 decoder는 빠졌거나 `null`인 필수 field, 다른 JSON 형식의 값, 정수 field 범위 밖이거나 소수인 수, `null` 인자, 길이가 다른 고정 길이 배열을 [host 호출](native-host.ko.md#host-호출)의 message로 거부하고, 빠졌거나 `null`인 선택 field는 받는다. | both |
| `host-calls.native.image-argument-lists` | surface 페이지의 요청 하나와 좌표 넷인 `ImageCaret` 호출과 요청 하나와 텍스트인 `ImageText` 호출은 각자의 인자 목록으로 해석되어 호출자 확인에 닿는다. | wailsv3 only: Wails page runtime은 surface 페이지 호출을 native bridge로 보내고 host가 그 인자 목록을 해석한다. Tauri surface 페이지는 메인 페이지의 명령을 부른다. |
| `host-calls.decode.every-binding` | 모든 `Host` binding의 모든 인자는 binding이 다른 일보다 먼저 해석하는 raw JSON이므로 framework는 인자를 해석하지 않는다. | wailsv3 only: Go reflection은 실행 중에 binding을 나열한다. `make hosts-check`는 framework 객체가 아닌 모든 Tauri 명령 인자가 `Argument<T>`이기를 요구한다. |
| `termination.signal.first-requests-quit-second-ends-process` | 첫 종료 신호는 종료를 요청하고 두 번째 신호는 프로세스를 끝낸다. | both |
| `window-close.surfaces.closes-regions-then-surface` | 창을 닫으면 논리 표면마다 id 순서로 그 문서 영역과 그림 영역을 닫은 뒤 표면을 닫고, 그 이름을 창의 문서 영역 목록과 그림 영역 목록에서 지운다. | both |
| `window-close.surfaces.reports-every-failure` | 네이티브 닫기 하나가 실패해도 나머지를 닫고, 창 닫기는 모든 실패를 표면 id 와 객체 종류와 함께 반환한다. | both |
| `window-overlay.rects.packs-four-values-per-rect` | 보이는 오버레이는 입력 순서대로 x, y, width, height 값으로 묶인다. | both |
| `window-overlay.rects.filters-hidden` | 숨긴 오버레이는 묶은 목록에서 빠진다. | both |
| `workspace.config-dir.creates-requested-path` | 없는 설정 디렉터리를 준비하면 만들고 정규 경로를 반환한다. | both |
| `workspace.config-dir.creates-owner-only` | 준비 과정이 만든 설정 디렉터리의 권한은 0700이며, 이미 있는 디렉터리는 권한을 유지한다. | both |
| `workspace.config-dir.rejects-empty-path` | 빈 설정 디렉터리 경로를 거부한다. | both |
| `workspace.config-dir.rejects-path-under-file` | 일반 파일 아래의 설정 디렉터리 경로를 거부한다. | both |
| `workspace.settings.project-file-holds-only-overrides` | 프로젝트 설정 파일은 프로젝트 재정의만 담는다. | both |
| `workspace.settings.persist-across-reopen` | 같은 설정 디렉터리로 다시 연 작업 공간은 저장된 공통 설정과 프로젝트 설정을 보여 준다. | both |
| `workspace.settings.reset-removes-override` | 프로젝트 재정의를 제거하면 빈 프로젝트 설정 객체가 남는다. | both |
| `workspace.settings.rejects-project-opening-override` | projectOpening의 프로젝트 재정의를 거부한다. | both |
| `workspace.settings.invalid-common-file-not-overwritten` | 잘못된 공통 설정 파일은 설정 변경을 실패시키고 바이트 단위로 그대로 남는다. | both |
| `workspace.settings.concurrent-patches-preserved` | 서로 다른 키에 대한 동시 공통 설정 변경이 모두 유지된다. | both |
| `workspace.projects.move-reorders` | 프로젝트를 옮기면 저장된 순서의 위치가 바뀐다. | both |
| `workspace.projects.move-requires-delta` | `delta`가 없거나 `null`인 `move` 요청은 `move delta is missing`으로 실패하고 순서를 바꾸지 않는다. | both |
| `workspace.projects.plugin-data-patched` | 프로젝트 patch는 `plugins` 객체를 저장하고, 알 수 없는 다른 필드의 patch는 거부된다. | both |
| `workspace.projects.remove-keeps-remaining-order` | 프로젝트를 제거해도 남은 프로젝트의 순서는 유지된다. | both |
| `workspace.folder.aliases-share-identity` | 디렉터리와 그 심볼릭 링크는 같은 프로젝트 폴더로 해석된다. | both |
| `workspace.folder.rejects-file` | 일반 파일은 프로젝트 폴더로 거부된다. | both |
| `workspace.folder.messages` | 폴더 확인은 요청한 경로를 한 번 담은 문구 하나로 실패한다. 경로나 상위 폴더가 없으면 `project directory does not exist: <path>`, 접근이 거부되면 `project directory is not readable: <path>`, 파일이면 `not a project directory: <resolved path>`, 그 밖의 system 오류는 `project directory cannot be resolved: <path> (errno <n>)`이다. | both |
| `cli.usage.unknown-command-exits-2` | 알 수 없는 명령은 종료 상태 2로 끝나며 표준 오류에 `sok: unknown command: <word>`와 사용법을 출력한다. | both |
| `cli.endpoint.missing-file-reports-not-running` | `endpoint.json`이 없으면 명령은 종료 상태 1로 끝나며, 그 파일이 없고 애플리케이션이 실행 중이 아니라고 보고한다. | both |
| `cli.output.indents-result-keeping-key-order` | 결과는 endpoint가 보낸 key 순서대로 두 칸 들여쓰기로 출력하며, 빈 container는 `{}`와 `[]`다. | both |
| `cli.window.single-window-is-default` | `--window`나 `--project`가 없으면 명령은 애플리케이션의 하나뿐인 창을 쓴다. | both |
| `cli.window.several-windows-need-selection` | 창이 여럿인데 선택이 없거나 `--window`와 `--project`를 함께 주면, 명령은 종료 상태 2로 끝나며 창 목록이나 충돌을 밝힌다. | both |
| `cli.window.project-selects-by-canonical-folder` | `--project`는 둘을 canonical 경로로 바꾼 뒤 열린 project 폴더가 주어진 폴더와 같은 창을 고른다. | both |
| `cli.requests.carry-command-parameters` | `status`, `exposures`, `capture`, `dom`, `input`은 spec이 정한 endpoint method와 매개변수를 보내며, 숫자는 JSON 숫자로, 주지 않은 option은 빼고 보낸다. | both |
| `cli.error.reports-endpoint-code` | Endpoint 오류는 종료 상태 1로 끝나며 `sok: <message> (<code>)`를 출력한다. | both |
| `cli.error.unwritable-stderr-exits-3` | sok이 오류를 표준 오류에 쓰지 못하면 1이나 2 대신 종료 상태 3으로 끝난다. | both |
| `cli.diagnostics.capture-only-in-diagnostic-builds` | 진단 build의 sok은 `capture`를 고른 창과 함께 `diagnostics.capture.still`로 보내고, 다른 build는 `capture`를 사용법 오류 `capture needs a diagnostic build of sok`로 거부하며 진단 method를 담지 않는다. | both |
| `cli.status.watch-prints-value-and-changes` | `status --watch`는 현재 값과 그 뒤 같은 status의 각 변경을 compact JSON 한 줄씩 출력하고, 다른 status의 변경은 무시한다. | both |
| `cli.config-dir.default-uses-application-identifier` | `--config-dir`이 없으면 명령은 `<사용자 설정 폴더>/<application identifier>`를 쓴다. | both |
| `cli.command.flags-from-schema` | 선언된 command는 창, surface, 그리고 선언된 schema로 flag에서 바꾼 매개변수와 함께 `command.run`으로 실행된다. 텍스트, 숫자, 정수, boolean, enum 값, nullable type의 `null`, JSON 객체와 배열, `--`로 시작하며 `=` 뒤에 준 값이며, `--params`는 객체 전체를 준다. | both |
| `cli.command.rejects-undeclared-or-invalid-values` | 선언되지 않은 flag, schema와 맞지 않는 값, 값이 없는 flag, 값이 따라오는 boolean, 매개변수 flag와 함께 쓴 `--params`, 선언되지 않은 command는 `command.run`을 보내기 전에 종료 상태 2로 끝난다. | both |
| `cli.commands.lists-declared-commands` | `sok commands`는 `exposure.list`의 `commands` 목록을 애플리케이션이 선언한 순서대로 출력한다. | both |
| `cli.path.writes-and-removes-the-entry` | `sok path install`은 실행 중인 `sok`의 폴더를 담은 `<paths directory>/<identifier>`를 쓰고 파일과 폴더를 출력한다. 되풀이해도 같은 파일이다. `sok path remove`는 그것을 지우며 없어도 성공한다. 쓰기 실패는 파일과 `run sudo sok path install`을 보고한다. | both |
| `cli.pack.writes-sorted-plugin-archive` | `sok plugin pack`은 `package.json`과 나열한 파일을 경로 순서, mode 0644나 0755, 시각 0, 소유자 0으로 담은 `<id>-<version>.tgz`를 쓰고, `archive`, `id`, `sha256`, `version`을 출력하며, 되풀이하면 같은 byte를 쓴다. | both |
| `cli.pack.rejects-links-and-manifest-mismatch` | 나열한 폴더 안의 symbolic link, id 없는 `plugin.json`, `plugin.json`과 다른 `soksak.sidecars`는 종료 상태 1로 실패하고 출력 폴더를 비워 둔다. | both |
| `cli.pack.diagnostics-only-with-flag` | `sok plugin pack`은 `diagnostics.json`과 그 module을 빼고, `--diagnostics`는 둘을 더하며, `files`가 둘 중 하나를 나열하면 pack이 실패하고, `plugin pack` 밖의 `--diagnostics`는 종료 상태 2다. | both |
| `cli.pack.rejects-unlisted-modules` | `plugin.json`의 surface module, 방향과 상관없는 section module, state module이 `files`가 나열한 경로 밖에 있으면 `sok plugin pack`은 종료 상태 1로 실패하고 그 module을 밝힌다. | both |
| `cli.release.writes-asset-and-sums` | `sok sidecar release`는 `<file name>-<version>-<platform>.tar.gz`를 쓰고 archive마다 `SHA256SUMS` 한 줄을 이름 순서로 유지하며, 같은 이름은 바꾼다. 알 수 없는 `--platform`은 종료 상태 2, 나열하지 않은 실행 파일은 1, 형식이 틀린 `SHA256SUMS`는 archive를 쓰지 않고 1이다. | both |
| `cli.registry.writes-checked-index` | `sok registry build`는 registry 파일을 읽고 모든 archive hash와 plugin archive의 `package.json`, `plugin.json`을 검사한 뒤, 선언한 필드 순서와 두 칸 들여쓰기로 `index.json`을 쓰고 `index`, `packs`, `plugins`, `sidecars`를 출력한다. 두 구현은 같은 텍스트를 쓴다. | both |
| `cli.registry.rejects-without-writing` | 형식이 틀린 hash, hash가 다른 archive, 항목과 다른 `package.json`, 항목과 다른 파일 이름, 없는 `revoked.json`, 알 수 없는 plugin을 지정한 pack은 종료 상태 1이며 `index.json`을 남기지 않는다. | both |
| `cli.plugin.install-extracts-and-records` | `sok registry use`는 검사한 index를 `file:` URL로 기록한다. `sok plugin install`은 plugin과 그 sidecar version을 mode와 함께 풀고, 푼 폴더마다 절대 `path`를 담아 `installed.json`을 쓰고, plugin 항목과 sidecar version을 출력하며, 되풀이하면 아무것도 바꾸지 않는다. | both |
| `cli.plugin.install-failure-keeps-state` | `plugins/registry.json`이 없거나, hash가 index와 다른 archive이거나, 폴더 밖 항목을 담은 archive이면 `sok plugin install`은 종료 상태 1이며 `installed.json`, version 폴더, 푼 파일을 남기지 않는다. | both |
| `cli.plugin.update-remove-enable-list` | `sok plugin update`는 설치되지 않은 plugin이면 실패하고, `enabled`를 유지하며 `previous`를 기록해 가장 새 version을 설치하고, 쓰는 version과 `previous`만 남긴다. `disable`과 `enable`은 `enabled`를 정하고, `list`는 `installed.json`을 출력하며, `remove`는 `null`을 출력하고 plugin과 sidecar 폴더를 지우며 되풀이하면 실패한다. | both |
| `cli.plugin.state-reads-registry-and-installed` | Installer library는 `{registry, index, installed}`를 보고한다. `plugins/registry.json`이 없으면 registry와 index가 `null`이고, 있으면 index URL과 검사한 index이며, 읽지 못한 index는 그 읽기 오류를 `index`로, 잘못된 `installed.json`은 오류를 보고한다. | both |
| `cli.plugin.action-runs-the-command` | Installer library는 `install`, `update`, `remove`, `enable`, `disable`을 같은 `sok plugin` 명령의 결과로 실행하고, 다른 action은 `unknown plugin action`으로 거부한다. | both |
| `cli.file.errors-name-the-path-and-the-reason` | 실패한 파일 작업은 `<경로>: <이유>`로 보고하며, 이유는 소문자로 시작하는 운영체제 오류 문구다. 없는 registry index는 `<경로>: no such file or directory`, 읽을 수 없는 `installed.json`은 `<경로>: permission denied`를 보고한다 | both |
| `install.version.ranges-and-order` | 범위 `x.y.z`, `^x.y.z`, `~x.y.z`, `>=x.y.z <a.b.c`는 선언한 경계를 가진다. Version은 숫자로 비교한다. 다른 형식, 앞자리 0, 빈 범위, 4294967295를 넘는 자리는 `invalid version`으로 거부한다. | both |
| `install.package.fields-and-manifest` | Plugin `package.json`에는 package `name`, `version`, `engines.soksak`, package 안의 `plugin.json`을 나열한 `files`가 있어야 한다. `soksak`은 `sidecars`만 가진다. `soksak.sidecars`는 `plugin.json`의 `sidecars`를 정확히 지정해야 한다. 실패마다 필드를 밝힌다. | both |
| `install.registry.entries` | Registry plugin, sidecar, pack, revoked 항목은 알 수 없는 필드, 절대 `file:` URL이 아니거나 query, fragment, 잘못된 escape를 가진 URL, 소문자 16진수 64자리가 아닌 `sha256`, 중복 version, 알 수 없는 플랫폼, 1이 아닌 `protocol`, 200 code point를 넘는 설명, 빈 pack, 이유 없는 revoked 항목을 거부한다. | both |
| `install.registry.index-cross-checks` | Index는 format 2, 중복 plugin id나 package, 알 수 없는 plugin을 지정한 pack, 알 수 없는 sidecar나 어떤 sidecar version도 채우지 않는 범위가 필요한 plugin version, 나열되지 않은 revoked version을 거부한다. | both |
| `install.select.newest-usable` | 선택은 core version에 맞고 revoked가 아닌 가장 새 plugin version과, 범위 안에 있고 플랫폼 asset이 있는 가장 새 sidecar version을 고른다. 맞는 것이 없으면 plugin, core version, sidecar, 플랫폼을 밝힌다. | both |
| `install.select.shared-sidecar` | 선택은 쓰고 있는 sidecar version이 다른 모든 설치된 plugin의 범위를 채우면 그대로 두고, 아니면 모든 범위를 채우는 가장 새 version을 고른다. 설치하는 plugin의 이전 범위는 무시하며, 충돌하면 각 plugin과 범위를 밝힌다. | both |
| `install.names.archives-and-paths` | Archive 이름은 `<id>-<version>.tgz`와 `<file name>-<version>-<platform>.tar.gz`, 설치 경로는 `plugins/<id>/<version>`와 `sidecars/<file name>/<version>/<platform>`이며, `@scope/name`은 `scope-name`이 된다. 알 수 없는 플랫폼이나 잘못된 plugin id는 거부한다. | both |
| `install.installed.consistency` | `plugins/installed.json`은 `enabled` 누락, 두 번 설치한 package, 절대 폴더가 아닌 plugin이나 sidecar의 `path`, `{ version, path }`가 아닌 sidecar 항목, 없는 `sidecars` 객체, 쓰는 version이 없는 sidecar, plugin 범위 밖의 쓰는 version, 어느 plugin도 지정하지 않은 sidecar를 거부한다. | both |
| `installed.document.lists-enabled-plugins` | `/installed-plugins.json`은 켜진 설치 plugin을 id 순서로 `id`, `package`, `version`, 그리고 `plugin.json`의 compact 내용인 `manifest`와 함께 나열하고, 진단 build에서만 `diagnostics.json`의 compact 내용을 더하며, `installed.json`이 없으면 `{"plugins":[]}`다. | both |
| `installed.document.reports-errors` | 켜진 plugin의 `plugin.json`이 없거나 잘못되었거나, `diagnostics.json`이나 `installed.json`이 잘못되었으면 `/installed-plugins.json`은 파일과 이유를 담은 `{"error":...}`다. | both |
| `page.start.document` | 시작 문서는 작업 공간 스냅샷과 window의 `windowControls` 답을 이 순서로 담은 `{"workspace":...,"controls":...}`다. | both |
| `page.start.requires-window` | 시작 문서 요청은 요청한 window를 시작한 뒤 문서를 `no-store`인 `application/json`으로 답하고, 요청이 window를 가리키지 않으면 아무것도 시작하지 않고 400과 `the start document request names no window`로 실패하며, 시작이 실패하면 500과 그 이유로 실패한다. | both |
| `plugins.state.reports-registry-and-installed` | `pluginsState`는 `plugins/registry.json`이 없으면 `registry`와 `index`를 `null`로, 있으면 index URL과 검사한 index를, 읽거나 검사하지 못한 index는 `index`를 `{"error":...}`로 돌려주고, `installed.json`의 내용 또는 없을 때 빈 format 1 문서를 돌려준다. | both |
| `plugins.run.changes-like-the-command` | `install`, `update`, `disable`, `enable`, `remove`의 `pluginsRun`은 같은 `sok plugin` 명령처럼 `installed.json`과 폴더를 바꾸고 그 출력을 돌려주며, 바꿀 때마다 모든 창에 `{action, plugin}`과 함께 `plugins-changed`를 보낸다. | both |
| `plugins.run.rejects-invalid-and-concurrent` | `pluginsRun`은 알 수 없는 action, 비어 있지 않은 문자열이 아닌 plugin id, 명령의 message로 실패한 작업, 다른 작업이 실행 중일 때의 호출을 `another plugin operation is running`으로 거부하고, `plugins-changed` event를 보내지 않는다. | both |
| `installed.modules.serve-installed-files` | 켜진 설치 plugin의 `/modules/<package>/<path>`는 기록된 `path` 안의 파일을 제공한다. 없는 파일이나 빈 segment, `.`, `..`가 있는 경로는 찾을 수 없다. 꺼진 plugin이나 다른 package는 애플리케이션 frontend가 제공한다. | both |
| `installed.sidecars.resolve-installed-folders` | Host의 sidecar는 켜진 설치 plugin의 `plugin.json`이 지정한 것이며, 각각 sidecar 폴더의 기록된 `path`와 거기의 `sidecar.json`을 가진다. 설치 version이 없는 sidecar는 실패하고, 빈 설정에는 sidecar가 없다. | both |
