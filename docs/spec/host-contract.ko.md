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
| help | debug | title | 디버그 | Debug | |

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
| `deep-link.parse.accepts-core-and-plugin-owners` | `soksak://core/<command>`와 `soksak://<plugin>/<command>`는 owner, command 이름 `<owner>.<command>`, 쿼리의 매개변수로 해석된다. | both |
| `deep-link.parse.decodes-percent-encoded-params` | 쿼리의 percent 인코딩된 이름과 값은 원래 텍스트로 디코딩되며, `+`는 공백으로 디코딩된다. | both |
| `deep-link.parse.rejects-other-scheme` | scheme이 `soksak`이 아닌 URL은 `scheme "<scheme>" is not soksak`으로 거부한다. | both |
| `deep-link.parse.rejects-missing-owner-or-command` | owner가 비었거나, command가 비었거나, command가 두 번째 조각을 가진 링크는 `owner is missing`, `command is missing`, `command has more than one segment`로 거부한다. | both |
| `deep-link.parse.rejects-empty-param-name` | 이름이 빈 쿼리 매개변수(예: `?=x`)는 `parameter name is empty`로 거부한다. | both |
| `deep-link.parse.rejects-bad-query` | 16진수 두 자리가 따르지 않는 percent 기호, 또는 되풀이된 매개변수 이름이 있는 쿼리는 `invalid percent-encoding` 또는 `parameter <name> is repeated`로 거부한다. | both |
| `deep-link.parse.rejects-long-url` | 8192자보다 긴 URL은 `URL is longer than 8192 characters`로 거부한다. | both |
| `deep-link.launch.kept-links-run-in-order-when-window-ready` | 첫 창이 준비되기 전에 도착한 링크는 준비되면 도착한 순서대로 실행하며, 그 전에는 어느 링크도 실행하지 않는다. | both |
| `deep-link.launch.later-link-runs-at-once` | 첫 창이 준비된 뒤 도착한 링크는 바로 실행하며, 두 번째 준비 알림은 보관한 링크를 다시 실행하지 않는다. | both |
| `links.open.accepts-web-and-mail-schemes` | 절대 `http`, `https`, `mailto` URL은 열기를 받아들인다. | both |
| `links.open.rejects-other-schemes` | 다른 스킴의 URL, 해석되지 않는 URL, 8192자보다 긴 URL은 거부한다. | both |
| `notifications.request.accepts-tab-notices` | 제어 문자 없이 1–256자인 표면과 제목, 1–1024자인 본문의 알림을 받아들이며, 제거에는 표면만 필요하다. | both |
| `notifications.request.rejects-invalid-fields` | 비었거나 너무 길거나 제어 문자가 있는 표면, 제목, 본문은 그 필드를 적은 오류로 거부한다. | both |
| `notifications.event.records-each-event-and-failure` | host가 해석하는 알림 센터의 사건마다 `type`, 상태의 `authorization`, 알림의 `window`와 `surface`를 가진 event `host.notification.event`가 있고, 실패(읽을 수 없거나 알 수 없는 종류의 사건, 창과 표면이 없는 알림, 닫힌 창, 알림 센터가 알린 실패)마다 장소 `notification`의 `error` 기록이 있다. Go 시험은 전체 경로를, Rust 시험은 이벤트를 읽는 부분까지를 다룬다. 창 조회에는 application handle이 필요하기 때문이다. | both |
| `diagnostics.capture-stop.payload-reports-frame-limit` | 한도에 도달한 녹화의 중지 페이로드는 frames, count, limited true, 가장 긴 간격을 보고한다. | both |
| `diagnostics.capture-stop.payload-reports-unbounded` | 한도에 도달하지 않은 녹화의 중지 페이로드는 limited false를 보고한다. | both |
| `diagnostics.capture-stop.payload-reports-layout-timeline` | 녹화 중지 페이로드는 기록된 layout transaction이 없어도 항상 `layouts` 배열을 보고한다. | both |
| `diagnostics.capture-stop.payload-preserves-layout-stages` | 각 `layouts` 항목은 기록된 ticket, begun, requested, presented, committed 값을 유지한다. | both |
| `diagnostics.native-objects.payload-names-counts` | `diagnostics.native.objects` 응답은 라이브러리의 살아 있는 객체 수를 `windowCompositions`, `surfaceHosts`, `inputRegistrations` 정수로만 담는다. | both |
| `diagnostics.native-objects.equal-validates` | `diagnostics.native.objects`는 `equal`을 정확히 `windowCompositions`, `surfaceHosts`, `inputRegistrations`를 음이 아닌 정수로 담은 객체로만 받고, 다른 값은 `equal must be an object of windowCompositions, surfaceHosts and inputRegistrations, each a non-negative integer`로 거부한다. `equal`에 이르지 않은 수는 `window object counts did not reach <equal> within 10s; they are <counts>`로 실패하며, 각 수는 `windowCompositions N, surfaceHosts N, inputRegistrations N`으로 쓴다. | both |
| `diagnostics.process-exit.pid-validates` | `diagnostics.process.exit`는 `pid`를 1부터 2147483647 사이의 정수로만 받고, 없거나 다른 값은 `pid must be a positive integer`로 거부한다. | both |
| `diagnostics.test-mark.params-validate` | `diagnostics.test.mark`는 `kind` `start` 또는 `end`, 빈 문자열이 아닌 `name`과 `run`, `end`에는 `pass`, `fail`, `skip` 중 하나인 `result`(`start`에는 거부)만 받고, 그 밖의 값은 invalid-params 오류 `kind must be start or end`, `name must be a non-empty string`, `run must be a non-empty string`, `result must be pass, fail or skip`, `result is only for an end mark`로 거부한다. | both |
| `diagnostics.test-mark.event-carries-position` | 시작 표시는 event `host.test.start`(`name`, `run`), 끝 표시는 `host.test.end`(`name`, `run`, `result`)이며 layer `host`, level `info`다. 답은 flush 뒤에 읽은 event 파일의 `boot`와 그 줄의 `seq`다. | both |
| `diagnostics.stall-dump.params-validate` | `diagnostics.stall.dump`는 존재하는 파일의 절대 경로만 받고, 그 밖의 값은 invalid-params 오류 `path must be a non-empty string`, `path must be absolute`, `path does not name a file: <path>`로 거부한다. | both |
| `diagnostics.stall-dump.event-carries-path` | 정지 dump는 layer `host`, level `warn`의 event `host.stall.dump`(`path`)이며, 답은 event 파일의 `boot`와 그 줄의 `seq`다. | both |
| `diagnostics.objects.counts-host-objects` | `diagnostics.objects`는 host가 창을 위해 가진 surface, region, document, sidecar session, 대기 중인 응답, event 구독자의 수를 돌려주고, 각 수는 그 객체가 제거되면 다시 준다. | both |
| `diagnostics.objects.reply-and-params` | `diagnostics.objects`는 `window`를 요구하고, 없는 창에는 세지 않고 오류 1003으로 답하며, 이름이 주어진 창에 대해 diagnostic backend가 센 수로 `{host, page, documents, sessions}`를 답하고 `documents`는 surface와 document 순서로 둔다. | both |
| `diagnostics.objects.sidecar-sessions-agree` | `diagnostics.objects`는 창의 sidecar session을 sidecar와 surface 순서의 `{sidecar, surface}`로 담은 `sessions`를 돌려주고, surface는 그것이 보낸 적이 있는 사이드카의 session일 뿐이다: page를 다시 불러와도 surface가 보낸 적이 없는 사이드카에는 그 surface를 위해 아무것도 보내지 않으므로, 두 host는 같은 project에 대해 같은 session을 나열한다. | both |
| `diagnostics.objects.runtime-memory` | `diagnostics.objects`는 Go runtime의 수치 여덟 개를 가진 `runtime`을 돌려준다: heap 객체, 쓰이지 않는 heap, free heap, released heap, stack, 그 밖의 metadata의 byte 수, heap goal, goroutine 수다. | wailsv3 only: Tauri host에는 garbage collection runtime이 없다 |
| `diagnostics.heap-profile.writes-a-profile` | `diagnostics.heap.profile`은 Go runtime의 heap profile(gzip으로 압축한 protocol buffer)을 진단 폴더의 `heap-<pid>-<ms>.pprof`에 쓰고 그 경로로 답한다. | wailsv3 only: Tauri host에는 garbage collection heap이 없다 |
| `diagnostics.objects.counts-documents` | `diagnostics.objects`는 main page와 창의 각 document region의 요소 수와 문서 수를 돌려준다. | both |
| `diagnostics.crash.report-is-announced-once` | crash report 폴더에 있는 애플리케이션의 crash report는 level `warn`의 event `host.crash.found`(`path`, `pid`, header의 `time`)이다. 두 번째 lookup은 아무것도 알리지 않고, 나중에 생긴 report는 다음 lookup만 알린다. | both |
| `diagnostics.crash.report-belongs-to-the-application` | 파일 이름이 다른 이름으로 시작하거나, header가 다른 애플리케이션(애플리케이션 이름으로 시작하는 이름 포함)을 가리키거나, 확장자가 `.ips`가 아닌 report는 알리지 않는다. | both |
| `diagnostics.crash.lookup-is-bounded` | lookup 한 번은 파일 이름 기준으로 애플리케이션의 최신 report 64개만 알리고 그보다 오래된 것은 알리지 않는다. | both |
| `diagnostics.crash.unreadable-report-is-an-error` | header나 body를 읽을 수 없거나 body에 `pid`가 없는 report는 파일과 원인을 밝힌 오류이며, ledger에 올라 다시 보고하지 않고 event를 만들지 않는다. | both |
| `diagnostics.crash.missing-folder-has-no-reports` | 없는 crash report 폴더는 report가 없는 것이다. 오류도 event도 없다. | both |
| `diagnostics.crash.folder-that-cannot-be-read-is-an-error` | 나열할 수 없는 crash report 경로는 그 경로를 밝힌 오류다. | both |
| `diagnostics.crash.folder-is-named-by-the-platform` | platform은 crash report 폴더를 `Library/Logs/DiagnosticReports`로 끝나는 절대 경로로 알린다. | both |
| `diagnostics.stderr.leaves-out-asset-request-lines` | host가 프레임워크 logger에 준 level에서 logger는 asset server의 `Handling request` 줄을 쓰지 않고 warning과 error는 남긴다. | wailsv3 only: Tauri host는 그런 줄을 쓰지 않는다 |
| `endpoint.record.call-is-an-event` | endpoint client의 모든 요청(구독 변경도)은 성능 trace가 꺼져 있을 때도 layer `host`, level `debug`이고 `name`, `args`(받은 그대로의 params, 없으면 `null`), `micros`, `ok: true`, `truncated: false`를 가진 event `host.endpoint.call`이다. | both |
| `endpoint.record.failure-names-the-error` | 실패한 요청은 level `warn`이고 `ok: false`와 client가 받는 코드와 메시지인 `error` `<code>: <message>`를 가진 event `host.endpoint.call`이다. | both |
| `endpoint.record.arguments-are-cut-before-copying` | `args`는 문자 경계에서 자른 최대 1024바이트이고, params가 더 길면 event에 `truncated: true`가 있다. | both |
| `binding.record.call-is-an-event` | page의 모든 host 호출은 layer `host`, level `debug`이고 `name`(호출의 snake case 이름), `args`(호출 순서대로의 인자를 담은 JSON 배열, 없으면 `[]`), `micros`, `ok: true`, `truncated: false`를 가진 event `host.binding.call`이며, 성능 trace가 꺼져 있을 때도 그렇다. | both |
| `binding.record.failure-names-the-error` | 실패한 host 호출은 level `warn`이고 `ok: false`와 `error` `<code>: <text>`(page가 받는 글에 내부 code `-32603`을 붙인 것이다. host 메서드는 글만 가진 오류로 실패하기 때문이다)를 가진 event `host.binding.call`이다. | both |
| `binding.record.operation-identifiers-are-stored` | `cids`를 나르는 host 호출(`Bindings.Call`의 네 번째 인자, Tauri command의 payload key `cids`)은 그 `cids`를 가진 event `host.binding.call`이며 실패해도 그렇다. `cids`가 없는 호출은 없는 event를 저장하고, 식별자는 호출의 인자가 아니다. | both |
| `binding.record.invalid-identifiers-are-refused` | 빈 식별자이거나 따옴표, 역슬래시, 제어 문자가 든 식별자를 `cids`에 담은 호출은 그 식별자를 밝힌 오류로 거절된다. 메서드는 실행되지 않고, event는 `cids` 없이 `error`가 `-32603: <그 글>`인 실패한 `host.binding.call`이다. | both |
| `binding.record.arguments-are-cut-before-copying` | `args`는 최대 1024바이트이고 문자 경계에서 자르며, 인자가 더 길었으면 event에 `truncated: true`가 있다. | both |
| `binding.record.unfinished-call-names-the-error` | 결과 없이 끝난 host 호출은 level `warn`이고 `ok: false`와 `error` `-32603: the call ended without a result`를 가진 event `host.binding.call`이다. | both |
| `binding.record.refusal-names-the-error` | host의 어떤 메서드도 가리키지 않는 호출이나 메서드가 받는 것과 다른 수의 인자를 넘기는 호출은 오류로 거절되고, 그 오류를 `-32603: <text>`로 가진 level `warn`의 event `host.binding.call`로 저장된다. | wailsv3 only: Wails는 host의 모든 메서드를 이름으로 찾는 바인딩 메서드 `Bindings.Call` 하나로 닿게 하지만, Tauri는 모르는 command와 거절된 인자를 host가 실행되기 전에 거절한다 |
| `binding.record.native-call-is-an-event` | native web view 문서의 호출은 같은 필드를 가진 event `host.binding.call`로 저장된다. | wailsv3 only: Wails page runtime은 surface page 호출을 native bridge로 보내지만, Tauri surface page는 main page의 command를 부른다 |
| `binding.record.every-host-method-is-callable` | host의 내보낸 모든 메서드는 입구를 통해 이름으로 닿고, 지원하지 않는 서명의 메서드는 그 메서드의 이름을 말하는 오류로 host 시작을 멈춘다. | wailsv3 only: Tauri는 `bindings!` 매크로가 정의한 command를 등록하므로 매크로 밖의 command는 등록에 들어가지 않는다 |
| `binding.record.unsupported-method-fails-at-start` | 매개변수가 선택적 context와 `json.RawMessage` 값이 아니거나 결과가 선택적 값과 선택적 오류가 아닌 내보낸 메서드는 입구의 생성을 그 메서드의 이름을 말하는 오류로 실패시킨다. | wailsv3 only: Tauri는 command를 reflection으로 읽지 않는다 |
| `diagnostics.test-mark.needs-the-event-log` | event log가 연결되지 않은 동안의 표시는 `the event log of the host is not attached`로 실패한다. | both |
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
| `document.stream.subscribe-rejects-unknown-stream` | `elements`나 `requests`가 아닌 stream의 구독은 `unknown document stream "<name>"`으로 실패한다. | both |
| `document.stream.unsubscribe-rejects-unknown-handle` | 문서가 가지지 않은 핸들을 끝내면 `document stream handle <handle> is not subscribed to document "<name>"`으로 실패한다. | both |
| `document.stream.first-on-last-off` | stream의 첫 구독은 수집을 켜고, 같은 stream의 다음 구독은 다시 켜지 않으며, 마지막 구독을 제거하면 수집을 끈다. | both |
| `document.stream.native-refusal-rejects-subscription` | native 계층이 stream 켜기를 거부하면 구독은 유지되지 않고 호출은 `document "<name>" does not accept stream "<stream>"`으로 실패한다. | both |
| `document.stream.page-load-removes-subscriptions` | 구독한 표면 페이지의 새 문서는 그 구독을 제거하고, stream마다 구독자 수는 0으로 돌아간다. | both |
| `document.stream.region-close-removes-subscriptions` | 문서 영역을 닫으면 그 구독을 제거하고, 구독자 수는 0으로 돌아가며, 요청 로그는 해제된다. | both |
| `document.stream.request-log-replays-with-dropped` | 새 requests 구독은 먼저 최대 200개 항목의 로그를 받고, `dropped`는 마지막 reset 이후 로그가 버린 항목 수이며, 이후 항목은 순서대로 따른다. | both |
| `document.stream.reset-clears-request-log` | requests stream의 reset은 로그와 `dropped` 수를 지우고, 그 stream의 구독에 `reset`을 보낸다. | both |
| `document.stream.delivers-to-subscribing-surface-only` | stream의 메시지는 영역에서 그 stream의 구독에만 전달되며, 각 구독의 표면과 핸들을 함께 실어 보낸다. | both |
| `document.stream.snapshot-acknowledged-after-delivery` | snapshot은 elements stream의 구독에 전달되고, 그 `seq`는 전달 뒤에 native로 확인되며, 남은 구독이 없어도 같다. | both |
| `document.stream.rejects-unknown-message` | JSON이 아닌 stream 메시지는 `document stream message is not JSON`으로, 알 수 없는 stream은 `unknown document stream "<name>"`으로, 알 수 없는 메시지 type은 `document stream "<stream>" sent an unknown message type "<type>"`으로, `seq`가 없는 elements snapshot은 `document stream "elements" snapshot has no seq`로 실패한다. | both |
| `document.stream.ack-refusal-names-seq` | native가 거부한 확인은 `document "<name>" stream <stream>: seq <seq> was not sent`로 실패하며, host는 이를 애플리케이션 로그에 쓴다. | both |
| `document.stream.process-end-removes-subscriptions` | 구독한 표면 페이지의 web content process가 끝나면 그 구독을 제거하고, stream마다 구독자 수는 0으로 돌아간다. | both |
| `document.stream.window-close-removes-subscriptions` | 구독한 표면이 있는 창을 닫으면 그 구독을 제거하고, 구독자 수는 0으로 돌아가며, 요청 로그는 해제된다. | both |
| `document.plugin.folder` | 문서 영역의 plugin 폴더는 `plugins/installed.json`이 표면의 켜진 설치 plugin에 기록한 폴더다. 꺼졌거나 알 수 없는 plugin은 `plugin <id> is not installed and enabled`로 실패한다. | both |
| `document.message.forward` | plugin 문서의 메시지 `{"message": value}`는 `document-message`의 payload `{surface, document, message}`가 되고, `{"error": reason}`은 host가 로그에 쓰는 이유가 되며, 둘 다 없는 값은 `document message <name> has neither message nor error`로 실패한다. | both |
| `host.arguments.declared-only` | `--config-dir PATH`와 `--config-dir=PATH`는 설정 폴더를 정한다. 선언하지 않은 인자, 값 없는 flag, 두 번 준 flag는 그 문장으로 실패한다. | both |
| `host.arguments.registry-ca-in-diagnostic-builds` | 진단 build는 `--registry-ca PATH`를 받고, 그 뒤 registry 받기는 그 PEM 파일의 인증 기관만 신뢰한다. 인증서 없는 파일은 `--registry-ca <path>: <reason>`으로 실패한다. | both |
| `endpoint.process.rejects-a-malformed-lock` | 내용이 양수 process ID가 아닌 `process.lock`은 `0`을 포함해 `<path>: invalid process lock`으로 endpoint를 거부하고 그대로 남는다. | both |
| `endpoint.process.one-owner-per-config-dir` | 같은 설정 디렉터리의 두 번째 엔드포인트는 "already owned by process"로 거부되고, 첫 엔드포인트는 닫을 때까지 잠금을 유지한다. | both |
| `endpoint.process.lock-mode-0600` | 설정 디렉터리의 `process.lock`은 mode 0600이다. | both |
| `endpoint.transport.http-request-line-closes` | HTTP 요청 줄은 응답이나 메서드 호출 없이 연결을 닫는다. | both |
| `endpoint.transport.invalid-json-closes` | 본문이 JSON이 아닌 프레임은 응답 없이 연결을 닫는다. | both |
| `endpoint.transport.closing-a-disconnected-connection-succeeds` | socket이 이미 끊긴 연결을 닫으면 성공한다. 다른 shutdown 오류는 보고한다. | tauriv2 only: Rust host는 socket을 명시적으로 shutdown하며 끊긴 socket을 보고하고, Go는 shutdown 없이 연결을 닫는다 |
| `endpoint.transport.non-jsonrpc-object-closes` | JSON-RPC 2.0 요청이 아닌 JSON 프레임은 응답 없이 연결을 닫는다. | both |
| `endpoint.transport.undeclared-method-closes` | 선언되지 않은 메서드는 응답 없이 연결을 닫고 페이지에 아무것도 전달하지 않는다. | both |
| `endpoint.transport.close-reason-is-recorded` | 닫히는 연결은 소켓을 닫기 전에 `info host endpoint: connection closed: <reason>`을 쓴다. reason은 한도를 넘은 frame, JSON-RPC 2.0 요청이 아닌 frame(본문 포함), 선언되지 않은 메서드, peer의 종료다. | both |
| `endpoint.timeout.is-recorded` | 제한 시간 오류 1005로 끝나는 endpoint 요청은 client가 오류를 받기 전에 `error host endpoint timeout: <method>: <message>`를 쓴다. | both |
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
| `endpoint.input.pointer-button-held-message` | 1007 메시지는 `NSEvent.pressedMouseButtons` 마스크를 16진수로, frontmost 애플리케이션을 bundle identifier와 pid로 보고하며, bundle identifier가 없는 애플리케이션은 pid로, frontmost 애플리케이션이 없으면 그 사실을 두 host에서 같은 문장으로 보고한다. | both |
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
| `exposure-reply.removed-surface-discarded` | 표면이 제거된 표면 페이지의 답은 오류 대신 관측 `exposure reply <id> of removed surface "<surface>" arrived after its request ended`와 함께 버려진다. | both |
| `exposure.list.appends-host-entries-registered` | 노출 목록은 페이지 항목을 유지하고 호스트 상태와 명령 항목을 등록된 항목으로 더한다. | both |
| `exposure.list.host-entries-exact-sorted-set` | 호스트 상태와 명령 이름은 정해진 정렬 목록과 같다. | both |
| `exposure.list.host-entries-described` | 모든 호스트 항목은 비어 있지 않은 설명을 가진다. | both |
| `exposure.list.host-quit-result-null` | host.quit은 null 결과 스키마를 선언한다. | both |
| `exposure.list.non-object-list-rejected` | 객체가 아닌 페이지 노출 목록은 오류다. | both |
| `exposure.host-window.reads-during-surface-creation` | 네이티브 surface view는 생성하는 같은 단계에서 surface id로 이름이 붙으므로, window status 읽기는 surface id가 없는 네이티브 view를 만나지 않는다. | both |
| `exposure.host-window.reads-during-surface-close` | 네이티브 surface view는 닫는 단계가 id를 잊을 때까지 surface id를 유지하므로, view가 열려 있는 동안 window status 읽기는 surface id가 없는 네이티브 view를 만나지 않는다. | both |
| `exposure.timeout.command-run-default-and-declared` | command.run은 기본 10초를 기다리고 선언된 timeout을 쓴다. | both |
| `exposure.timeout.status-next-unbounded` | timeout이 없는 status.next는 시간 제한이 없다. | both |
| `exposure.timeout.invalid-timeout-rejected` | 0, 600000 초과, 소수, 문자열, 음수인 command.run timeout은 -32602를 반환한다. | both |
| `exposure.timeout.status-next-timeout-rejected` | timeout이 있는 status.next는 -32602를 반환한다. | both |
| `exposure.relay.reply-resolves-request` | 대상 문서에서 온 같은 id의 응답은 그 결과로 요청을 완료한다. | both |
| `exposure.relay.keeps-value-text` | Page 응답은 page가 보낸 텍스트 그대로 중계되므로 값의 key 순서가 유지된다(`{"zeta":1,"alpha":{"b":2,"a":1}}`는 보낸 그대로다). | both |
| `exposure.relay.missing-result-is-null` | result가 없는 응답은 null로 완료된다. | both |
| `exposure.relay.error-reply-keeps-code-and-message` | 오류 응답은 같은 코드와 메시지로 요청을 실패시킨다. | both |
| `exposure.relay.foreign-document-reply-ignored-timeout-1005` | 다른 문서의 응답은 무시되고, 요청은 1005로 시간 초과되며, 늦은 응답도 받지 않는다. | both |
| `exposure.relay.late-reply-states-its-delay` | 시간이 초과된 요청은 `the document did not reply within <ms> ms`로 실패하고, 그 뒤에 온 답은 요청을 보낸 뒤의 지연과 제한 시간으로 실패하며, 요청이 없는 답은 `has no matching request`로 실패한다. | both |
| `exposure.relay.send-failure-1003` | 문서로 보내기가 실패하면 요청은 즉시 1003으로 실패한다. | both |
| `exposure.relay.closed-document-fails-pending-1003` | 문서를 닫으면 대기 중인 요청은 1003으로 실패한다. | both |
| `exposure.relay.no-timeout-waits-until-close` | timeout이 없는 요청은 문서가 닫힐 때까지 기다린 뒤 1003으로 실패한다. | both |
| `exposure.window.dropped-view-work-reports-no-view` | 실행되기 전에 파괴된 웹뷰로 보낸 작업은 수신 오류 대신 결과 없음이 되어, `host.window`가 닫히는 모달을 뷰 없이 보고한다. 실행되어 실패한 작업은 그 오류를 유지한다. | tauriv2 only: Tauri는 웹뷰 작업을 dispatch로 실행하며 웹뷰가 파괴되면 작업을 버리고, Wails는 모달 뷰를 자기 기록에서 읽는다 |
| `exposure.window.region-reports-presented-frame` | 설정과 표시된 프레임 뒤 `host.window`는 영역의 `presented`에 그 프레임의 `generation`, `raster`, `sequence`를 보고한다. 래스터가 바뀐 뒤에는 새 래스터의 프레임이 표시되기 전까지 `presented`가 null이다. | both |
| `exposure.windows.closing-window-omitted` | `host.windows`는 닫기가 받아들여진 창을 조회하지 않고 목록에서 뺀다. | tauriv2 only: Tauri는 창마다 제목과 초점을 runtime에 묻는데, 닫기가 runtime에서 창을 지운 뒤 Destroyed 이벤트가 등록을 지우기 전에는 이 조회가 실패한다. Wails는 제목을 host 상태에서 읽고 초점 조회는 오류를 돌려주지 않는다 |
| `exposure.windows.open-window-query-failure-reported` | 열린 창의 제목이나 초점 조회가 실패하면 `host.windows`가 그 오류로 실패한다. | tauriv2 only: Tauri는 창마다 제목과 초점을 runtime에 묻는데, 닫기가 runtime에서 창을 지운 뒤 Destroyed 이벤트가 등록을 지우기 전에는 이 조회가 실패한다. Wails는 제목을 host 상태에서 읽고 초점 조회는 오류를 돌려주지 않는다 |
| `exposure.windows.entry-fields` | 목록의 창은 `ready`, `window`, `title`, `project`(프로젝트가 없으면 null), `key`를 가진다. | tauriv2 only: Tauri는 창마다 제목과 초점을 runtime에 묻는데, 닫기가 runtime에서 창을 지운 뒤 Destroyed 이벤트가 등록을 지우기 전에는 이 조회가 실패한다. Wails는 제목을 host 상태에서 읽고 초점 조회는 오류를 돌려주지 않는다 |
| `exposure.windows.listed-in-one-main-thread-step` | `host.windows`는 모든 창의 닫기 상태, 제목, 초점을 한 메인 스레드 단계에서 읽는다. 목록 중에 메인 스레드가 처리한 닫기는 그 창을 목록에서 빼거나 넣을 뿐 목록을 실패시키지 않는다. | tauriv2 only: Tauri는 창의 닫기를 메인 스레드에서 처리하고, 닫기가 runtime에서 지운 창의 제목이나 초점 조회를 답 없이 버린다. Wails는 제목을 host 상태에서 읽고, 초점 조회는 메인 스레드에서 native 창을 읽는데 destroy가 이미 그 값을 nil로 바꾸었으므로 false를 돌려준다 |
| `flush.queue.rejects-send-when-full` | 사이드카가 읽지 않아 쓰기 대기열이 가득 차면 보내기가 실패한다. | both |
| `flush.queue.full-error-says-not-keeping-up` | 대기열이 가득 찬 오류는 "is not keeping up"을 적는다. | both |
| `flush.buffer.replies-delivered-after-drain` | 대기열이 가득 찬 동안 버퍼에 넣은 응답은 사이드카가 다시 읽은 뒤 도착한다. | both |
| `flush.buffer.closes-delivered-after-drain` | 대기열이 가득 찬 동안 버퍼에 넣은 표면 닫기 알림이 사이드카에 도착한다. | both |
| `flush.buffer.consumed-acks-not-coalesced` | 버퍼에 넣은 consumed 응답은 같은 이미지의 두 응답을 포함해 각각 한 번 도착한다. | both |
| `flush.buffer.delivered-after-queued-bodies` | 버퍼에 넣은 응답과 닫기 알림은 이미 대기열에 있던 본문 뒤에 도착한다. | both |
| `images.invalidate.sidecar-connection-loss-resends-configure` | 사이드카의 그림을 무효화하면 같은 크기의 configure 를 다시 보내고 다른 사이드카의 그림은 그대로 둔다. | both |
| `performance.trace.switch-accepts-on-and-off-only` | `performance` 호출은 동작 `on`과 `off`만 받으며, `line`을 포함한 다른 동작은 `action must be on or off`로 실패하고 아무것도 쓰지 않는다. | both |
| `performance.trace.switch-is-held-by-the-process` | 프로세스가 스위치를 가진다. `on`은 trace를 켜고 `off`는 끄며, 켜진 동안의 관측만 event `host.trace.on`과 `host.trace.off` 사이에 저장되고, 그 뒤에 파일 `performance`, 파일 `logs/performance.ndjson`, service 폴더의 flag는 없다. | both |
| `performance.sampler.ends-with-the-switch` | 표본 추출은 trace가 켜진 동안 돌고, 꺼지면 끝나며, 다시 켜면 새로 시작한다. | both |
| `performance.trace.already-off-writes-nothing` | trace가 꺼져 있을 때의 `off` 요청은 event를 저장하지 않는다. | both |
| `performance.trace.host-observation-is-an-event` | trace가 켜져 있는 동안 host의 관측(layer `host` 또는 `sampler`)은 이름이 field에 반복되지 않는 level `debug`의 event `host.trace.<event>` 또는 `host.sampler.<event>`로 event log에 저장되며 trace 파일의 줄이 아니다. event 이름이 없는 관측은 오류 `performance trace`로 보고하고 아무것도 저장하지 않는다. | both |
| `performance.sampler.failed-reading-is-explicit` | 상주 크기를 얻지 못한 sampler 읽기는 `rss_host_kb` 대신 `error`를 기록한다. | both |
| `performance.sampler.reads-every-registered-process` | trace가 켜져 있는 동안 표본 추출은 host와 프로세스 등록부의 각 process마다 `role`, `name`, `pid`, `rss_kb`를 담은 이벤트 `host.sampler.memory`를 하나씩 저장한다. process의 이름을 붙이면 이벤트 `host.trace.process`를 저장하고, 제거된 process는 다시 읽지 않으며, 크기를 읽을 수 없는 등록 process는 `rss_kb` 없이 `error`와 함께 저장한다. | both |
| `performance.sampler.names-the-sidecar-processes` | host가 시작한 사이드카 process와 연결한 상주 service는 process가 끝나거나 연결이 끝날 때까지 프로세스 등록부에 있다. | both |
| `performance.surface.lifecycle-events-hold-the-geometry` | trace는 표면의 단계를 단계 `created`, `placed`, `destroyed`를 가진 이벤트 `host.trace.surface`로 저장하고, 단계 `placed`는 `x`, `y`, `w`, `h`, `visible`을 담는다. | both |
| `performance.clock.before-epoch-is-explicit` | 유닉스 epoch 이전의 trace 시각은 epoch가 아니라 오류다. | tauriv2 only: Rust host는 epoch부터의 기간으로 시각을 적으므로 그 이전에서 실패하고, Go는 모든 시각을 적는다 |
| `log.open.rotates-at-100mb` | 100 MB 이상인 로그 파일을 열면 먼저 `<이름>.1`로 옮기고 이전 세대를 하나씩 뒤로 옮기며 다섯째를 지우고 새 파일을 시작한다. | both |
| `log.open.appends-below-bound` | 더 작은 로그 파일을 열면 거기에 덧붙이고, 새 로그 파일은 mode 0600이다. | both |
| `platform.private.creates-owner-only-directories` | private directory 생성 연산은 경로에서 없는 모든 디렉터리를 mode 0700으로 만들고 이미 있는 디렉터리의 mode는 유지한다. | both |
| `platform.private.appends-owner-only-file` | private append 연산은 없는 파일을 mode 0600으로 만들고, 있는 파일에는 덧붙이며, 있는 파일의 mode는 유지한다. | both |
| `platform.private.creates-new-owner-only-file` | private 새 파일 연산은 없는 파일을 mode 0600으로 만들고, 이미 있는 경로에는 already-exists 오류로 실패한다. | both |
| `platform.private.writes-owner-only-file` | private write 연산은 없는 파일을 mode 0600으로 만들고, 있는 파일의 내용을 바꾸며, 있는 파일의 mode는 유지한다. | both |
| `log.application.start-replaces-standard-error` | 애플리케이션 로그를 시작하면 실행의 첫 줄을 쓰고 그 파일을 프로세스와 그 프로세스가 시작하는 자식의 표준 오류로 만든다. | both |
| `log.error.line-form` | 헬퍼로 쓴 호스트 오류는 애플리케이션 로그의 기록 `<time> error host <where>: <text>`다. | both |
| `log.transcript.line-reaches-the-application-log` | 창의 진단 기록 줄은 `info host transcript <window>: <line>`으로도 쓰고, Wails host는 진단 기록이 싣는 오류를 `error host <operation> <window>: <error>`로도 써서, 진단 기록을 요청한 연결이 없어도 그 줄이 남는다. | both |
| `log.info.record-form` | `LogInfo`(Go)나 `log_info`(Rust)로 쓴 호스트 관측은 애플리케이션 로그의 기록 `<time> info host <where>: <text>`다. | both |
| `log.record.one-line` | 기록은 한 줄이다. 본문의 줄바꿈은 두 글자 `\n`으로 쓰고, 시각을 뺀 항목은 `<level> <layer> <where>: <text>`다. | both |
| `sidecars.trace.relay-records-every-message-with-its-body` | performance trace가 켜진 동안 host가 sidecar로 보내는 각 요청은 event log의 event `host.trace.sidecar.send`, 받는 각 메시지는 `host.trace.sidecar.receive`이며, field에 `sidecar`, `surface`, 본문 전체를 담는다. | both |
| `sidecars.lifetime.start-and-exit-events` | 호스트가 시작하는 표준 입출력 사이드카 프로세스마다 `name`과 `pid`를 가진 event `host.sidecar.start`가 있고, 그 종료는 `name`, `pid`, `status`(`exit status <code>` 또는 `signal <number>`), 호스트가 멈추는 중이었는지 알려 주는 `stopping`을 가진 event `host.sidecar.exit`다. | both |
| `sidecars-transport.persistent.connection-events` | host가 영구 service에 연결할 때마다 `name`, service `pid`, `spawned`를 가진 event `host.sidecar.connect`가 있고, 그 끝은 `name`, `pid`, `stopping`, 위반 문구 `violation`(service가 연결을 닫았으면 빈 문자열)을 가진 event `host.sidecar.disconnect`다. | both |
| `windows.events.window-event-is-recorded` | 창 event는 `window`와 `kind`(`resize`, `move`, `scale_factor_changed`, `show`, `hide`, `occlusion_changed`, `focus`, `lost_focus`, `close_requested`, `closed`, `web_process_ended`, `navigation_committed`)를 가진 event `host.window.event`이며, `resize`, `move`, `scale_factor_changed`는 level `debug`, 나머지는 `info`다. 목록에 없는 kind는 표준 오류에 보고하고 아무것도 저장하지 않는다. | both |
| `application.events.app-event-is-recorded` | 애플리케이션 event는 `kind`(`started`, `activated`, `deactivated`, `exit_requested`, `exit`)를 가진 event `host.app.event`이며 level은 `info`다. 목록에 없는 kind는 표준 오류에 보고하고 아무것도 저장하지 않는다. | both |
| `sidecars.protocol.request-line-carries-cids` | 입력을 이어받는 페이지 요청은 `root`와 `body` 사이에 필드 `cids`(상관 식별자, 순서대로)를 가진 요청 줄로 사이드카에 가고, 입력을 이어받지 않는 요청에는 `cids` 필드가 없다. | both |
| `sidecars.protocol.request-with-cids-is-recorded` | `cids`를 가진 페이지 요청은 그 `cids`, 사이드카의 `name`, `surface`, body 크기 `bytes`를 가진 level `info`의 event `host.sidecar.request`가 되고, `cids`가 없는 요청은 이 event를 저장하지 않는다. | both |
| `sidecars.protocol.reply-with-cids-is-recorded` | 줄이 `cids`를 밝히거나 body가 `error` member를 가진 객체인 sidecar의 메시지는 event `host.sidecar.reply`이다. `name`, `surface`, body 크기 `bytes`, `ok`(`error`이면 false), 줄의 `cids`, 그 첫 번째 요청을 host가 기억하면 `micros`, 오류이면 `error` `-32603: <text>`(문자열 오류는 그 글, 다른 값은 JSON 글)를 level `warn`(오류가 없는 reply는 `info`)으로 가진다. 둘 다 없는 메시지는 이 event를 저장하지 않는다. | both |
| `sidecars.protocol.failure-fails-the-pending-requests` | sidecar의 실패는 기다리는 요청이 있는 surface마다 level `warn`에 `ok: false`, `bytes: 0`, `error` `-32603: <reason>`(page가 받는 이유)과 그 요청들의 `cids`를 가진 event `host.sidecar.reply`를 저장한다. | both |
| `log.input.region-event-with-cids-is-recorded` | JSON에 `cids`가 있는 image region event는 그 `cids`, region의 `surface`와 `name`, event의 `type`을 가진 level `info`의 event `host.input.relay`가 된다. `cids`가 없는 region event는 `host.input.relay`를 저장하지 않는다. | both |
| `sidecars.stderr.lines-are-written-as-records` | 표준 입출력 사이드카의 표준 오류 각 줄과 줄바꿈 없이 끝난 마지막 글은 기록 `<time> info sidecar <name>: <line>`으로 쓴다. | both |
| `log.panic.records-an-event` | 진입점(`routine.Go`, `spawn_named`)으로 시작한 goroutine이나 스레드가 panic하면 프로세스가 0이 아닌 상태(Go는 2, Rust는 101)로 끝나기 전에 받은 `name`, panic 값 `text`, `stack`을 담은 `error` 수준 event `host.panic` 하나를 저장한다. | both |
| `log.panic.does-not-wait-for-the-writer` | panic hook은 writer가 멈춰 있어도 writer를 기다리지 않고 panic한 스레드에 돌아오며, writer가 풀리면 event가 저장되고 프로세스가 끝난다. | tauriv2 only: goroutine의 panic은 진입점이 recover하며 hook이 없다 |
| `log.fatal-signal.writes-an-error-line` | 애플리케이션 로그를 연 뒤 host process가 fatal signal을 받으면 그 signal로 process가 끝나기 전에 `error: fatal: <signal name>`을 한 번 쓴다. | tauriv2 only: Go runtime은 fatal signal을 스스로 처리하고 보고를 표준 오류에 쓰며 표준 오류가 애플리케이션 로그다 |
| `log.binding-failure.returned-not-logged` | 실패한 binding 호출은 framework transport의 log 줄 없이 page로 돌아가므로 page가 그 실패를 한 번 기록한다. | wailsv3 only: Wails HTTP transport가 binding 호출을 나르고, Tauri invoke는 돌려준 오류에 log 줄을 쓰지 않는다 |
| `log.service.standard-error-goes-to-service-log` | 호스트가 시작한 영속 서비스는 표준 오류를 `logs/<실행 파일 이름>.log`에 쓴다. | both |
| `log.service.open-failure-fails-start` | 서비스 로그를 열 수 없으면 `sidecar <name>: service log: <error>`로 시작을 실패시키고 서비스를 시작하지 않는다. | both |
| `images.envelope.rejects-unattached-image` | 연결된 적 없는 이미지 이름의 봉투에 notAttached로 응답한다. | both |
| `images.envelope.refusal-echoes-name-and-sequence` | 거부 응답은 봉투의 name과 sequence를 담는다. | both |
| `images.envelope.refusal-preserves-quoted-name` | 따옴표가 든 이름의 거부 응답은 올바른 JSON이며 이름을 유지한다. | both |
| `images.envelope.refusal-is-recorded` | host가 거부한 프레임은 `<level> host image frame: surface=<s> name=<n> sender=<x> generation=<g> raster=<r> sequence=<q> refused: <reason> current <state>`를 쓰고(`unsupported`는 `error`, 나머지는 `info`), 봉투가 아닌 image 필드는 `error host image frame: surface=<s> sender=<x> malformed image envelope: <image>`를 쓴다. | both |
| `trace.image-frame-answer-is-recorded` | trace가 켜져 있는 동안 프레임에 대한 모든 응답(consumed 또는 거부 사유를 담은 refused)은 layer `host`의 event `host.trace.image.frame`으로 저장되며, field `surface`, `name`, `response`(사이드카가 받는 응답)를 가진다. | both |
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
| `images.wait.timeout-writes-no-log-line` | 제한 시간에 이른 표시 대기는 호출자에게 `presentationTimeout`을 반환하고 애플리케이션 로그에 줄을 쓰지 않는다. 기다린 요청이 그 실패를 보고하기 때문이다. | both |
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
| `images.present.frame-of-undeclared-sidecar-is-invalidated` | 어떤 plugin도 선언하지 않는 사이드카의 그림은 `stale`로 답하고 native 표시, 복구, 오류 없이 기록되며, 끝난 사이드카에 대한 답은 `not sent`로 기록된다. | both |
| `surfaces.reload.reconnects-only-declared-sidecars` | page를 다시 불러오면 이전 page의 각 surface에 대해 plugin이 선언한 image region의 사이드카와 그 surface가 보낸 적이 있는 실행 중인 persistent 사이드카를 다시 연결하고, 어떤 plugin도 선언하지 않는 사이드카는 건너뛴다. 그 surface는 plugin 제거와 함께 끝났다. | tauriv2 only: Wails host는 page를 다시 불러올 때 reconnect를 보내지 않는다 |
| `images.present.failure-line-names-the-current-frame` | 다른 표시 실패는 그 사유(알 수 없는 상세는 `presentFailed`)로 답하고 오류 줄 `error host image present: ... reason=<detail> current <frame state>`를 남긴다. | both |
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
| `menu.application.help-has-debug` | 애플리케이션 메뉴의 도움말 메뉴에 단축키 없는 항목 디버그(Debug)가 있다. 이 항목은 main 창의 메인 page에서 `core.debug.open`을 실행한다([디버그 화면](debug.ko.md)). | both |
| `sidecars.protocol.surface-keeps-its-first-root` | 소유 창의 프로젝트가 바뀐 뒤에도 열린 표면의 요청과 closed 알림은 첫 요청의 root를 가진다. | both |
| `sidecars.protocol.closed-surface-messages-are-discarded-and-unknown-ones-fail` | 호스트가 닫은 표면에 대한 stdio sidecar 메시지는 버리고, 호스트가 그 프로세스에 한 번도 보내지 않은 표면의 메시지는 보낸 표면에 `unknown surface <surface>`를 전달하며 sidecar를 실패시킨다. | both |
| `sidecars.protocol.dropped-message-is-recorded` | 소유 창이 없어 버려지는 사이드카 메시지는 `info host sidecar <name>: message for surface <surface> dropped: no window owns the surface: <body>`를 쓴다. | both |
| `sidecars.protocol.answer-to-ended-sidecar-is-recorded` | process가 실행 중이 아닌 sidecar로의 응답은 끝난 오류(`sidecar <name> is not running`)이고, 그런 sidecar에 대한 버려진 transfer image의 `closed` 답은 오류 대신 `not sent`로 기록된다. sidecar의 frame은 process와 함께 끝나기 때문이다. | both |
| `sidecars.image.closed-surface-is-answered` | 소유 창이 없는 표면의 전송 그림은 버리고 그 그림의 값으로 `{"surface":<surface>,"body":{"image":{"error":"closed","name","generation","raster","sequence"}}}`를 답한다. | both |
| `sidecars.read.unfinished-line-ends-the-connection` | process가 줄을 쓰다 끝나서 line feed 없는 줄로 끝나는 sidecar 출력은 연결을 끝낸다. 그 줄은 메시지가 아니고, host는 `info host sidecar <name>: the output ended in a line of <n> bytes without a line break, which is not a message`를 쓰며, sidecar의 어떤 surface도 `invalid message`로 실패하지 않는다. | both |
| `sidecars.send.rejects-undeclared-sidecar` | 어떤 플러그인도 선언하지 않은 사이드카로 보내면 "not declared"로 실패한다. | both |
| `sidecars.send.rejects-after-stop` | 사이드카가 멈춘 뒤 보내면 "stopped"로 실패한다. | both |
| `sidecars.send.rejects-when-no-plugin-declares-sidecars` | 선언된 사이드카가 없으면 생성은 성공하고 모든 보내기는 "not declared by any plugin"으로 실패한다. | both |
| `sidecars.start.fails-on-missing-executable` | 디스크에 없는 선언된 실행 파일은 첫 보내기를 사이드카 이름과 함께 실패시킨다. | both |
| `sidecars.start.passes-log-directory` | 표준 입출력 sidecar는 인자 `--log-dir <config-dir>/logs`만 받아 시작한다. | both |
| `sidecars.declaration.fails-on-missing-sidecar-json` | sidecar.json이 없는 설치 sidecar 폴더는 그 경로와 함께 설치 sidecar 찾기를 실패시킨다. | both |
| `sidecars.declaration.adds-sidecars-installed-after-start` | 생성 뒤에 설치 sidecar를 선언하면 선언되지 않은 것을 더하므로 그 sidecar로의 보내기가 그것을 시작한다. | both |
| `sidecars.declaration.rejects-executable-escaping-package` | sidecar 밖의 실행 파일 경로는 생성을 실패시킨다. | both |
| `sidecars.declaration.rejects-absolute-executable` | 절대 실행 파일 경로는 생성을 실패시킨다. | both |
| `sidecars.declaration.rejects-unsupported-protocol` | 지원하지 않는 프로토콜 버전은 생성을 실패시킨다. | both |
| `sidecars.declaration.rejects-unknown-transport` | 알 수 없는 전송 방식은 "is not supported"로 생성을 실패시킨다. | both |
| `sidecars.declaration.persistent-requires-config-directory` | 설정 디렉터리가 없는 지속 전송은 생성을 실패시킨다. | both |
| `sidecars.persistent.accepts-non-canonical-config-directory` | 지속 전송은 정규화되지 않은 설정 디렉터리 경로를 받아들인다. | both |
| `sidecars.send.fails-fast-when-sidecar-not-keeping-up` | 읽지 않는 사이드카로의 큰 보내기는 "is not keeping up"으로 끝난다. | both |
| `sidecars.send.slow-sidecar-does-not-block-others` | 한 사이드카 대기열이 가득 찬 동안 다른 사이드카로의 보내기는 50ms 안에 반환된다. | both |
| `sidecars.send.start-does-not-block-other-sidecars` | 영속 service가 hello 응답을 늦추는 동안 실행 중인 다른 사이드카로의 보내기는 50ms 안에 반환된다. | both |
| `sidecars.close.answer-ends-closing` | `closed`를 보낸 뒤 `host.sidecars`는 사이드카가 답할 때까지 그 표면을 나열하고, 답하면 목록이 빈다. | both |
| `sidecars.write.wait-is-recorded` | sidecar의 쓰기 queue에서 1초 이상 기다리거나 쓰기에 10 ms 이상 걸린 줄은 `host.sidecar.write_wait`(sidecar의 `name`, 줄의 `bytes`, `queued_us`, `write_us`)를 level `info`로 저장하고, 곧바로 쓴 줄은 아무것도 저장하지 않는다. | both |
| `buffers.sidecar-replies.bounded-by-messages` | sidecar의 보류 응답은 최대 1,024개이며, 다음 응답은 `sidecar <name>: the pending replies reached 1024 messages, so a reply of surface <surface> is dropped`로 거절되고 `host.buffer.dropped`(`buffer` `sidecar <name> pending replies`, `count` 1, `bytes`, `reason` `the buffer holds 1024 messages`)를 저장한다. | both |
| `buffers.sidecar-replies.bounded-by-bytes` | sidecar의 보류 응답은 최대 4,194,304바이트이며, 이를 넘게 되는 응답은 `...reached 4194304 bytes...`로 거절되고 `reason`이 `the buffer holds 4194304 bytes`인 `host.buffer.dropped`를 저장한다. | both |
| `buffers.sidecar-closes.bounded-and-forgotten` | sidecar의 보류 close는 최대 1,024개와 4,194,304바이트이며, 이를 넘는 close는 보내지 않고 `host.buffer.dropped`(`buffer` `sidecar <name> pending closes`)를 저장하며, 그 표면은 답을 기다리는 표면 목록에 없다. | both |
| `buffers.relay-expired.bounded-and-counted` | relay는 만료된 요청을 최대 256개 기억하며, 가장 오래된 것을 잊을 때 `host.buffer.dropped`(`buffer` `relay expired requests`, `count` 1, `bytes` 0, `reason` `the buffer holds 256 requests`)를 저장하고, 그 요청의 늦은 응답에는 `exposure reply <id> has no matching request`로 답한다. | both |
| `log.writer.event-over-size-bound-is-cut` | writer가 받을 때 fields 글이 1,048,576바이트를 넘는 event는 최대 4,096바이트의 `fields` `{"head": ...}`와 자르기 전 크기인 `truncated`로 저장하고, 상한 아래의 event에는 `truncated`가 없으며 `seq`는 연속이다. | both |
| `sidecars.close.buffered-close-is-recorded` | 사이드카의 큐가 가득 차서 기다리는 closed 알림은 `info host sidecar <name>: close <surface>: outbox full, buffered`를 쓴다. | both |
| `sidecars.close.failed-answer-is-logged` | `error`가 있는 닫기 응답은 host 로그에 오류 줄 "error host sidecar <name>: close <surface>: <error>"를 쓰고 닫는 중 항목을 끝낸다. | both |
| `sidecars.declaration.replaces-changed-folder` | 폴더가 바뀐 사이드카를 선언하면 실행 중인 표준 입출력 프로세스를 실패 없이 멈추고, 다음 send가 새 폴더의 실행 파일을 시작한다. | both |
| `sidecars.close.repeated-close-awaits-each-answer` | 사이드카가 앞 닫기에 답하기 전에 다시 닫은 표면은 사이드카가 닫기마다 답할 때까지 닫는 중으로 남고, 어느 답도 사이드카를 실패시키지 않는다. | both |
| `sidecars.close.unexpected-answer-fails` | host가 닫고 있지 않은 표면의 닫기 응답은 "unexpected close answer for <surface>"로 사이드카를 실패시킨다. | both |
| `sidecars.close.process-end-clears-closing` | 사이드카 process가 답하지 않고 끝나면 그 표면은 `host.sidecars`에서 빠진다. | both |
| `sidecars.stop.honors-stop-timeout` | 입력을 비우지 않는 사이드카의 중지는 중지 제한 시간의 두 배 안에 반환된다. | both |
| `sidecars.stop.graceful-on-stdin-eof` | 입력 끝에서 종료하는 사이드카는 제한 시간을 기다리지 않고 멈춘다. | both |
| `sidecars.stop.kills-after-timeout` | 입력 끝을 무시하는 사이드카는 중지 제한 시간 뒤에 강제 종료되고, 호스트는 오류 줄 "error host sidecar <name>: did not end within the stop timeout and was killed"를 쓰며 "exited while stopping" 줄은 쓰지 않는다. | both |
| `sidecars.stop.closes-unread-output` | 멈추는 동안 표준 입출력 사이드카의 프로토콜 실패는 오류 줄 "error host sidecar <name>: failed: <reason>"을 쓰고 실패 이벤트를 전달하지 않으며, 호스트는 파이프의 자기 쪽 끝을 닫으므로, 그 뒤 파이프가 담는 것보다 많이 쓰는 사이드카는 쓰기 오류를 받고 "exited while stopping" 줄 없이 중지 제한 시간 전에 끝난다. | both |
| `sidecars.stop.reads-output-to-end` | 멈추는 동안 호스트는 표준 입출력 사이드카의 출력을 끝날 때까지 읽는다. 중지 전에 보낸 닫기에 입력이 끝난 뒤에야 답하고 그다음 파이프가 담는 것보다 많이 쓰는 사이드카는 모든 쓰기를 마치고 중지 제한 시간 전에 끝나며, 호스트는 오류 줄을 쓰지 않는다. | both |
| `sidecars.stop.reports-exit-status` | 멈추는 동안 종료 상태 3이나 신호 15로 끝난 표준 입출력 사이드카는 오류 줄 "error host sidecar <name>: exited while stopping: exit status 3"이나 "error host sidecar <name>: exited while stopping: signal 15"를 쓴다. | both |
| `sidecars.stop.forgets-running-sidecars` | 중지는 입력을 끝내기 전에 모든 사이드카를 실행 목록에서 빼고 답하지 않은 닫기를 지우므로, 그 뒤 표면이나 소유 창을 닫아도 아무것도 보내지 않고 닫는 중인 표면을 알리지 않는다. | both |
| `sidecars.protocol.message-at-limit-is-delivered` | 줄바꿈 앞이 정확히 67108864 byte인 사이드카 메시지가 손상 없이 소유 창에 도착한다. | both |
| `sidecars.failure.oversize-message-terminates-and-notifies` | 67108864 byte보다 긴 줄은 줄이 끝나기를 기다리지 않고 사이드카 프로세스를 끝내고 "exceeds"를 담은 `sidecar-failure`를 소유 창에 전달한다. | both |
| `sidecars.failure.invalid-message-terminates-and-notifies` | JSON이 아닌 줄이나 `body`가 없는 JSON 객체는 사이드카 프로세스를 끝내고 "invalid message"를 담은 `sidecar-failure`를 전달한다. | both |
| `sidecars.failure.output-close-notifies-each-surface` | 호스트가 종료 중이 아닐 때 종료 상태 3으로 끝난 사이드카는 그 사이드카에 보낸 각 표면의 소유 창에 이유가 "output closed: exit status 3"인 `sidecar-failure`를 전달하고, 다음 전송은 새 프로세스를 시작한다. | both |
| `sidecars-transport.endpoint.concurrent-hosts-share-authenticated-service` | 두 호스트가 토큰으로 한 서비스 엔드포인트에 인증하고 각자의 이벤트를 받는다. | both |
| `sidecars-transport.hello.declares-protocol-one` | hello 요청은 프로토콜 1을 선언한다. | both |
| `sidecars-transport.reconnect.after-connection-loss-preserves-owner` | 서비스가 연결을 끊으면 다음 보내기가 다시 연결하고 이벤트는 계속 소유자와 표면에 도착한다. | both |
| `sidecars-transport.stop.close-owner-failure-returns-promptly` | close-owner 실패 응답은 중지를 1초 넘게 늦추지 않는다. | both |
| `sidecars-transport.hello.reports-a-service-of-another-version` | hello 응답의 `version`이 `installed.json`의 기록과 다르거나 없는 persistent 서비스는 `host.sidecars` `outdated`에 실행 중인 version이나 `null`, 설치된 version, 열린 표면 수와 함께 나열된다. 설치된 version의 서비스는 나열되지 않는다. | both |
| `sidecars-transport.hello.client-is-the-configuration-directory` | host가 상주 service에 보내는 `hello` 메시지는 애플리케이션의 설정 폴더를 `client`로 싣는다. | both |
| `sidecars-transport.hello.rejects-auth-failure` | 실패한 hello 응답은 보내기를 "authentication handshake failed"로 실패시킨다. | both |
| `sidecars-transport.hello.rejects-unsupported-protocol-without-replacing-endpoint` | 다른 프로토콜의 hello 응답은 보내기를 실패시키고 endpoint.json을 바꾸지 않는다. | both |
| `sidecars-transport.hello.times-out` | hello를 받고 답하지 않는 service는 5초 뒤 "the service did not answer hello within 5s"로 보내기를 실패시킨다. | both |
| `sidecars-transport.startup.times-out` | 준비 상한 안에 endpoint를 출력하지 않는 시작한 service는 "the service did not print its endpoint within <bound>"로 보내기를 실패시키고, host는 그 service를 끝내고 회수한다. | both |
| `sidecars-transport.startup.exits-before-endpoint` | endpoint 전에 끝난 시작한 service는 "service exited before endpoint"로 보내기를 실패시킨다. | both |
| `sidecars-transport.endpoint.replaces-dead-service-endpoint` | 죽은 서비스가 남긴 엔드포인트는 새 서비스 엔드포인트로 바뀐다. | both |
| `sidecars-transport.endpoint.live-unreachable-reported-without-replacement` | 살아 있지만 연결할 수 없는 서비스의 엔드포인트는 보내기를 실패시키고 바뀌지 않는다. | both |
| `sidecars-transport.stop.close-owner-then-shutdown` | 중지는 close-owner를 보내고 성공 응답 뒤에 shutdown을 보낸다. | both |
| `sidecars-transport.stop.own-close-is-not-a-read-error` | 중지 중에 서비스 연결을 닫아도 `persistent read` 오류 줄을 쓰지 않는다. host 자신이 닫았기 때문이다. | both |
| `sidecars-transport.stop.accepts-close-answers-sent-before-stop` | 지속 service가 중지 전에 보낸 closed 알림에 중지가 시작된 뒤 답해도 받아들인다. 중지는 shutdown을 보내고 닫는 중인 표면이 남지 않는다. | both |
| `sidecars-transport.stop.leaves-the-close-of-a-replacement-to-the-replacement` | 지속 service의 owner 닫기는 연결마다 한 번 실행된다. 교체가 owner를 닫는 동안 시작한 종료는 두 번째 close-owner를 보내지 않고, 교체가 끝나기를 기다리며, transport를 다시 닫지 않는다. | both |
| `sidecars-transport.detach.closes-the-connection-without-closing-the-owner` | 사이드카를 분리하면 상주 service의 연결만 끝나고 close-owner와 shutdown을 보내지 않으며, 분리 뒤의 stop은 더 보내지 않는다. | both |
| `sidecars-transport.persistent.revives-a-lost-connection` | 서비스가 연결을 끊으면 호스트가 전송 없이 다시 시작하고 소유 표면이 연결 이벤트를 받는다. | both |
| `sidecars-transport.persistent.lost-connection-writes-an-error-line` | host가 실행되는 동안 프로토콜 위반 없이 끝난 상주 service의 연결은 host가 다시 연결한 뒤 `error host sidecar <name>: connection lost; restarted`를 한 번 쓰고, 연결하지 못하면 `error host sidecar <name>: connection lost; restart failed: <reason>`을 쓴다. | both |
| `sidecars-transport.replace.replaces-an-outdated-service` | `hello`의 version이 설치된 version과 다른 상주 service를 교체하면 `close-owner`와 `shutdown`을 보내고, 연결을 닫고, 생성 경로로 설치된 service를 시작하고, 그 sidecar로 보낸 각 표면에 연결 알림을 보내고, `host.sidecars`의 `outdated`에서 그 sidecar를 빼고, `sidecar <name>: service <running> replaced by <installed>`를 쓴다. | both |
| `sidecars-transport.replace.refuses-a-service-that-is-not-outdated` | 실행 중인 service가 없거나 service가 설치된 version이면 그 sidecar의 교체는 sidecar를 밝히는 오류로 실패하고 service에 아무것도 보내지 않는다. | both |
| `sidecars-transport.replace.runs-when-sessions-reach-zero` | 오래된 service로 보낸 마지막 열린 표면이 닫히면 host가 그 service를 교체한다. | both |
| `sidecars-transport.persistent.starts-in-new-session` | 호스트가 시작한 영속 서비스는 새 session의 leader이므로 애플리케이션의 process group이나 terminal의 signal을 받지 않는다. | both |
| `sidecars-transport.endpoint.zombie-service-does-not-exist` | 좀비 서비스 pid 는 존재하는 서비스로 치지 않아 낡은 endpoint 를 교체한다. | both |
| `sidecars-transport.endpoint.foreign-service-process-exists` | 다른 사용자가 소유한 프로세스의 service pid 는 존재하는 service 다. 거부된 signal 확인이 그 프로세스가 있음을 보이기 때문이다. | both |
| `sidecars-transport.endpoint.waits-for-the-end-of-a-service-process` | service process의 종료를 기다리면 시간 안에 process가 끝났을 때와 process가 없을 때 true를, 시간이 지나도 실행 중이면 false를 답한다. | both |
| `sidecars-transport.replace.waits-for-the-end-of-the-service-process` | 교체한 상주 service는 endpoint의 process가 끝난 뒤에만 설치된 service를 시작하고, 중지 기한 안에 끝나지 않는 process는 sidecar를 밝히는 오류 줄과 함께 교체를 실패시켜 sidecar를 오래된 채로 둔다. | both |
| `sidecars-transport.persistent.revive-failure-is-reported` | 재시작 실패는 연결 끊김과 그 까닭을 소유 표면에 알린다. | both |
| `sidecars-transport.persistent.oversize-line-fails-the-connection` | 64 MiB 메시지 한도보다 긴 service 줄은 줄의 나머지를 읽지 않고 연결을 닫으며, 보낸 surface에 `message exceeds 67108864 bytes`와 함께 `sidecar-failure`를 보낸다. | both |
| `sidecars-transport.persistent.invalid-event-fails-the-connection` | JSON 객체가 아닌 service 줄이나 문자열 `surface`가 없는 surface event는 연결을 닫고 보낸 surface에 `invalid message: ...`와 함께 `sidecar-failure`를 보낸다. 다음 전송은 다시 연결한다. | both |
| `webkit-children.reap.requires-alive-webkit-same-start` | 기록된 WebKit 자식은 살아 있고, 여전히 WebKit 프로세스이며, 시작 시각이 기록과 같을 때만 죽는다. | both |
| `webkit-children.record.owner-only` | 갱신이 쓰는 WebKit 자식 기록은 mode 0600이다. | both |
| `webkit-children.record.concurrent-refreshes` | 동시에 실행된 기록 쓰기는 모두 성공하고 임시 파일을 남기지 않는다. | both |
| `webkit-children.ps.reports-a-failed-query` | 실행할 수 없거나 존재하지 않는 프로세스의 상태 1이 아닌 상태로 끝난 `ps` 질의는 질의와 `ps`의 메시지를 담은 장소 `webkit children`의 `error` 기록이다. 존재하지 않는 프로세스를 묻는 질의는 오류가 아니다. | both |
| `webkit-children.ps.reports-an-unreadable-line` | WebKit 프로세스의 `ps` 목록에서 프로세스 번호로 시작하지 않는 줄은 그 줄을 인용하는 장소 `webkit children`의 `error` 기록이고, 공백이 앞서는 프로세스 번호의 줄은 읽는다. | both |
| `recording.state.poisoned-lock-is-reported` | 상태를 쥔 다른 thread가 panic한 뒤 진행 중인 녹화의 폴더를 읽으면 장소 `recording`의 `error` 기록이고 폴더는 없다. | tauriv2 only: Rust는 holder가 panic하면 mutex를 poisoned로 표시하지만 Go mutex에는 그런 상태가 없다 |
| `modal.state.poisoned-lock-is-reported` | 모달 기록을 쥔 다른 thread가 panic한 뒤 열린 모달이나 그 mode를 읽으면 장소 `modal state`의 `error` 기록이고 모달은 없다. | tauriv2 only: Rust는 holder가 panic하면 mutex를 poisoned로 표시하지만 Go mutex에는 그런 상태가 없다 |
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
| `surfaces-geometry.sync.plugin` | 동기화 요청은 표면마다 그 plugin을 적는다. 배치 트랜잭션을 시작하기 전에 실행하는 검사는 plugin이 없는 표면을 `surface "<id>" requires its plugin`으로, 이미 받은 표면의 plugin이 다르면 `surface "<id>" changed its composition declaration`으로 거부하고, plugin과 composition이 같은 표면은 받는다. 동기화가 받은 표면의 페이지 composition 선언은 같은 plugin을 적는다. | both |
| `surfaces.sync.failure-leaves-no-begun-layout` | 표면 동기화는 배치 트랜잭션을 시작하기 전에 창 덮개를 놓으므로 거부된 덮개는 트랜잭션을 시작하지 않고, 뒤 단계가 실패하면 시작한 트랜잭션을 취소한다. 성공한 동기화는 취소하지 않는다. | both |
| `surfaces.sync.titlebar.accepts-heights-in-range` | 배치 트랜잭션을 시작하기 전에 실행하는 검사는 `titlebar` 가 32 이상 200 이하 point 인 동기화 요청을 받는다. | both |
| `surfaces.sync.titlebar.rejects-other-heights` | 배치 트랜잭션을 시작하기 전에 실행하는 검사는 `titlebar` 가 32 point 미만이나 200 point 초과, NaN, 무한대인 동기화 요청을 `title bar height must be a finite number from 32 through 200 points` 로 거부한다. | both |
| `surfaces.sync.titlebar.set-in-begun-layout` | 표면 동기화는 배치 트랜잭션을 시작한 뒤, 표면을 놓기 전에 제목줄 높이를 정한다. 높이를 정하지 못하면 표면을 놓지 않고, 시작한 트랜잭션을 취소하고, 그 오류로 동기화를 실패시킨다. 표면을 놓지 못하면 트랜잭션을 취소하기 전에 이전 제목줄 높이를 다시 정한다. | both |
| `page.start.titlebar-follows-frame-factor` | 호스트가 시작 문서에 답하기 전에 정하는 제목줄 높이는 모든 글자 크기 단계에서 공통 설정 `textSize` 에 대한 `round(max(40, 36 × textSize))` 이고, 설정이 없으면 40 이다. 수가 아닌 `textSize` 는 `common setting textSize must be a number, not <type>` 으로, 0.5 이상 3 이하 밖의 수는 `common setting textSize must be from 0.5 through 3` 으로 실패한다. | both |
| `workspace.settings.rejects-project-text-size-override` | `textSize` 가 있는 프로젝트 설정 파일은 스냅샷을 `<path>: textSize is common-only` 로 실패시키고, `textSize` 가 있는 프로젝트 설정 쓰기는 `textSize is common-only` 로 실패한다. | both |
| `exposure.host-buttons.notifies-mask-change` | `host.buttons`는 버튼 source가 마지막으로 보고한 마스크를 담은 `{mask}`이고, 그와 다른 마스크의 보고는 새 값으로 감시자에게 한 번 알리며, 같은 마스크의 보고는 알리지 않는다. | both |
| `exposure.status-change.refuses-host-name` | 메인 페이지가 `host.`로 시작하는 이름에 보낸 상태 변경은 `the page cannot change host status <name>`으로 거부되고, 다른 이름의 변경은 받아들여진다. | both |
| `images.calls.name-the-call` | 인자 해석 뒤 image 영역 호출의 실패는 호출 이름 `imageAttach`, `imageFocus`, `imageCaret`, `imageText`, `imageDetach`를 붙인 `<call>: <reason>`이다. | both |
| `host-calls.decode.messages` | 인자 decoder는 빠졌거나 `null`인 필수 field, 다른 JSON 형식의 값, 정수 field 범위 밖이거나 소수인 수, `null` 인자, 길이가 다른 고정 길이 배열을 [host 호출](native-host.ko.md#host-호출)의 message로 거부하고, 빠졌거나 `null`인 선택 field는 받는다. | both |
| `host-calls.native.image-argument-lists` | surface 페이지의 요청 하나와 좌표 넷인 `ImageCaret` 호출과 요청 하나와 텍스트인 `ImageText` 호출은 각자의 인자 목록으로 해석되어 호출자 확인에 닿는다. | wailsv3 only: Wails page runtime은 surface 페이지 호출을 native bridge로 보내고 host가 그 인자 목록을 해석한다. Tauri surface 페이지는 메인 페이지의 명령을 부른다. |
| `host-calls.decode.every-binding` | 모든 `Host` binding의 모든 인자는 binding이 다른 일보다 먼저 해석하는 raw JSON이므로 framework는 인자를 해석하지 않는다. | wailsv3 only: Go reflection은 실행 중에 binding을 나열한다. `make hosts-check`는 framework 객체가 아닌 모든 Tauri 명령 인자가 `Argument<T>`이기를 요구한다. |
| `termination.signal.first-requests-quit-second-ends-process` | 첫 종료 신호는 종료를 요청하고 두 번째 신호는 프로세스를 끝낸다. | both |
| `window-close.surfaces.closes-regions-then-surface` | 창을 닫으면 논리 표면마다 id 순서로 그 문서 영역과 그림 영역을 닫은 뒤 표면을 닫고, 그 이름을 창의 문서 영역 목록과 그림 영역 목록에서 지운다. | both |
| `window-close.native-window.used-in-reading-step` | native 창을 쓰는 host 요청은 native 창을 native code에 넘기는 main thread 단계에서 읽으므로, 요청의 앞선 단계 뒤에 main thread가 처리한 닫기가 닫힌 창을 native code에 넘기지 않는다. 그 단계 전에 닫힌 창은 native code에 닿지 않고, 요청은 오류 1003 `window "<name>" does not exist`로 실패한다. | both |
| `window-close.surfaces.reports-every-failure` | 네이티브 닫기 하나가 실패해도 나머지를 닫고, 창 닫기는 모든 실패를 표면 id 와 객체 종류와 함께 반환한다. | both |
| `host.stall.recorded-without-a-check` | main thread 밖의 thread가 250 ms마다 main thread에 heartbeat를 보낸다. 1 s 이상 늦은 heartbeat는 `host.stall`(`late_ms`)을 저장하고, `logs/stall-host-<pid>-<ms>.txt`로 표본한 thread들의 stack은 `host.stall.sampled`(`path`, 파일을 쓰지 못했으면 `error`)를 저장하며, 다음 heartbeat는 `host.stall.resumed`(`stalled_ms`)를 저장한다. window check 없이 그렇게 한다. | both |
| `window-close.surfaces.closed-once` | surface sync 가 제거하는 surface 는 handle 을 닫기 전에 창의 surface registry 에서 빠지므로, 그 닫기보다 먼저 실행된 창 닫기는 그 handle 을 받지 않고 모든 surface handle 은 한 번만 닫힌다. 제거된 surface 하나의 닫기가 실패해도 나머지를 닫고, sync 는 모든 실패를 surface id 와 함께 반환한다. | tauriv2 only: Wails host 는 surface 를 view 객체로 닫고 그 객체가 main thread 에서 handle 을 비우므로 두 번째 닫기는 native code 에 닿지 않는다. Tauri host 는 surface 를 handle 로 닫고 그 handle 은 registry 항목만 가진다 |
| `surfaces.sync.name-outlives-native-surface` | surface sync가 제거하는 surface는 native surface가 닫힐 때까지 이름을 유지한다. 닫기와 이름 제거가 main thread의 한 단계에서 실행되므로, 창의 native surface 읽기(`host.window`)는 이름이 있는 surface를 찾거나 surface를 찾지 않는다. 닫기가 실패해도 이름을 제거하고 실패를 반환한다. | tauriv2 only: Wails host는 main thread에서 view를 닫고 그 호출이 돌아온 뒤 이름을 제거하므로, 둘 사이의 창 읽기는 surface를 찾지 않고 이름은 알려진 상태다. Tauri host는 sync의 thread에서 main thread로 닫기를 보낸다 |
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
| `workspace.settings.records-each-change` | 설정 변경마다 `scope`(`common` 또는 project id), 바꾼 키 `set`, 있었던 키 중 지운 `removed`를 각각 쉼표로 이은 정렬된 목록으로 가진 event `host.workspace.settings`가 있다. | both |
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
| `debug.files.lists-the-logs-folder` | 디버그 파일은 `<config-dir>/logs/` 아래 모든 파일이고, 설정 폴더에 대한 상대 경로, 크기, 수정 시각을 담아 경로 순으로 나열된다. | both |
| `debug.save.copies-a-file-of-the-logs-folder-only` | 저장은 `logs/` 아래 파일을 복사한다. `logs/` 밖, `..`가 든 경로, 폴더, 없는 파일은 `debug: <path> is not a file under logs/`로 거부한다. | both |
| `debug.save-all.writes-the-logs-folder-as-tar` | 모두 저장은 `logs/`의 파일을 그 경로로 담은 gzip 압축 tar 파일을 쓴다. | both |
| `debug.save-all.reports-progress` | tar writer는 나열한 byte를 1 MiB 이상 더 쓸 때마다, 그리고 마지막 파일 뒤에 쓴 byte가 전체와 같게 한 번 보고한다. | both |
| `overlay.pick.dropped-is-recorded` | id와 instance가 열린 모달의 것이 아닌 모달의 응답은 기록 `host.overlay.dropped`의 field `{id, instance, key, open}`과 함께 버려지며, 열린 모달이 없으면 `open`은 빈 글이다. 열린 모달의 응답은 버려지지 않는다. | both |
| `reload.timeout.names-running-calls` | 범위 안에 page가 준비를 알리지 않은 다시 읽기는 `the reloaded page did not report ready within <bound>; running host calls: <calls>`로 실패하며, `<calls>`는 그 window에서 돌아오지 않은 호출을 시작 순서로 각각 소수 한 자리의 `<name> <seconds>s`로 적거나 `none`이다. | both |
| `log.batch.requires-the-page` | 쓴 page를 `page`에 이름하지 않은 relay event는 `page must name the document that wrote the event`로 거부되고, writer는 page 없는 layer page나 plugin의 relay event와 page가 있는 다른 layer의 event를 거부한다. | both |
| `debug.save-text.writes-the-text-to-the-destination` | 글 저장은 요청의 글을 줄바꿈과 ASCII가 아닌 글자를 그대로 둔 채 목적지에 쓴다. | both |
| `debug.save-text.refuses-a-name-that-is-not-a-file-name-and-text-that-is-empty-or-too-large` | 빈 이름, `.`, `..`, `/`나 `\`를 가진 이름은 `debug: name "<name>" is not a file name`으로, 빈 글은 `debug: text is empty`로, 16 MiB를 넘는 글은 `debug: text is <n> bytes, over the limit of 16777216`으로 요청을 거절한다. | both |
| `files.place.answers-the-path-inside-the-project` | project root 안에서 고른 위치는 root나 위치가 symbolic link를 지나도 root 기준 상대 path를 부분 사이 `/`로 답한다. | both |
| `files.place.refuses-a-place-outside-the-project` | project root 밖에서 고른 위치, root 자체, `..`나 symbolic link로 밖에 닿는 위치는 `file place: <path> is outside the project <root>`로 거부된다. | both |
| `files.place.refuses-a-name-that-is-not-a-file-name` | 빈 글, `.`, `..`, `/`나 `\`를 담은 `name`은 panel이 보이기 전에 `file place: name <name> is not a file name`으로 거부된다. | both |
| `log.query.answers-the-golden-pages` | `packages/log-contract/fixtures/query/cases.json`의 각 질의가 golden 행, `next`, `tail`, `scanned`를 돌려주고, 행의 글 줄이 golden 줄이다. | both |
| `log.query.pages-through-the-cursor` | `next`를 `after`로 넘기며 page를 넘기면 질의의 모든 행을 key 순서로 `asc`와 `desc`에서 한 번씩 돌려주고 `next` `null`로 끝나며, page는 줄 글 8,388,608바이트를 넘기 전에 끝나고 항상 행 하나를 담는다. | both |
| `log.query.follows-the-tail-with-since` | 앞선 답의 `tail`을 `since`로 준 질의는 그 뒤에 덧붙은 행을 돌려주며 앞선 답이 담은 행보다 `ts_us`가 이른 행도 돌려주고, 프로세스의 `seq` 이하의 행은 뺀다. | both |
| `log.query.resolves-a-run-to-the-range-of-its-marks` | `run`은 질의를 channel의 모든 파일에서 그 run의 가장 이른 `host.test.start`부터 가장 늦은 `host.test.end`까지의 시간 범위로 한정하고, start가 없는 run은 오류 `log query run "<run>" has no host.test.start in the channel`이다. | both |
| `log.query.refuses-invalid-parameters` | 선언하지 않은 항목과 매개변수의 잘못된 값은 명세의 오류 문구로 거절하고, event 구조를 어기는 줄이 있는 파일을 읽는 질의는 파일과 줄을 밝히며 실패한다. | both |
| `log.query.answers-the-rows-around-a-row` | `around`가 있는 질의는 key 앞의 `earlier`개 행과 뒤의 `later`개 행을 key에 있는 행과 함께 channel의 파일에서 filter 없이 key 순서로 돌려주고, 각 행에 `context`(이웃은 true, key의 행은 false)를 표시하며 `next`는 null이다. 행이 없는 key는 이웃만 돌려준다. `packages/log-contract/fixtures/query/cases.json`의 golden `around` 사례와 그 글 줄(context 행은 공백 둘로 들여 쓴다)은 두 구현에서 같다. `channel`, `earlier`, `later` 외의 항목, `around` 없는 `earlier`나 `later`, 잘못된 cursor, 0에서 500을 벗어난 개수는 명세의 오류 문구로 거절하며, 답의 줄 글은 8,388,608바이트 이하다. | both |
| `log.query.reads-only-the-segments-that-can-hold-a-row` | segment가 여럿인 로그에서 `cid`, `event`, `surface`, 시간 범위로 묻는 질의는 색인이 받아들이는 segment만 읽고(`scanned.read`), `text`가 있는 질의는 모든 segment를 읽는다. | both |
| `log.query.answers-a-million-events-within-the-limit` | event 1,000,000개의 로그가 첫 page, `cid`, event 이름, surface, 시간 범위, level, `text`로 묻는 page를 test가 밝힌 한도 안에서 답하고 색인 생성도 한도 안에 끝나며, test는 시간을 출력한다. | both |
| `log.query.reads-the-files-the-writer-wrote` | 질의는 writer가 만든 모든 세대에 걸쳐 main 파일을 channel `other`로, debug 파일을 channel `debug`로 읽는다. | both |
| `log.query.matches-the-class-the-writer-stored` | 질의 필터 `class`는 색인의 class 비트를 통해 writer가 줄에 저장한 class와 맞는다. | both |
| `log.index.matches-the-golden-digest` | 구현이 각 golden event 파일에서 만든 색인의 SHA-256이 golden 값과 같고, 최신 색인의 갱신은 아무것도 바꾸지 않는다. | both |
| `log.index.follows-appended-lines-and-is-rebuilt-when-stale` | 색인을 만든 뒤 덧붙은 줄은 부분 segment부터 색인하고, 마지막 줄바꿈 뒤의 바이트는 줄바꿈이 쓰인 뒤 색인하며, 더 작은 파일, 다른 첫 줄, 같은 크기에서 다른 수정 시각은 색인을 처음부터 다시 만든다. | both |
| `log.index.counts-the-lines-that-announce-a-change` | 색인 갱신은 `announcing`, 곧 앞선 갱신 뒤에 색인한 줄에서 log만 읽는 호출의 기록(`logQuery`의 `host.binding.call`과 `log.query`의 `host.endpoint.call`)을 뺀 수와, 덮는 파일의 크기 `size`를 보고한다. 갱신이 다시 읽는 부분 segment는 두 번 세지 않고, 최신 색인의 갱신은 아무것도 알리지 않는다. | both |
| `log.index.refuses-a-damaged-index-and-a-broken-line` | 다른 버전의 색인, 검사합이 맞지 않는 block이나 기록, block보다 짧은 파일은 색인을 밝히는 오류이고, event 구조를 어기는 줄과 schema 2의 `log.open`이 아닌 첫 줄은 파일과 줄을 밝히는 오류이며 색인은 이전 상태를 유지한다. | both |
| `log.index.moves-with-the-generations-of-a-rotation` | 회전은 가득 찬 파일의 색인을 최신으로 맞추고 색인 파일을 세대와 함께 바꾸어, 닫힌 세대가 만들기 없이 색인으로 답하게 하고 지워진 세대의 색인을 지운다. | both |
| `log.index.update-reads-with-a-buffer-of-the-new-bytes` | index의 갱신은 읽는 byte만큼, 많아야 한 번 읽는 chunk만큼 읽기 buffer를 할당하므로, 덧붙은 두 줄의 갱신은 1 MiB보다 적게 할당한다. | both |
| `log.writer.indexes-each-batch-it-wrote` | host의 writer가 batch를 쓴 뒤 질의 없이도 그 파일의 색인이 batch의 줄을 덮고, writer의 회전은 닫힌 세대의 색인을 완전하게 남긴다. | both |
| `log.writer.stores-an-event-for-each-index-built-from-the-file` | 파일 전체로 만든 색인은 파일, 이유, 줄 수, 바이트, 마이크로초를 가진 event `host.log.index_rebuilt`이고, 증분 갱신은 event를 저장하지 않으며, 실패한 갱신은 문구마다 한 번 장소 `log index`의 `error` 기록으로 보인다. | both |
| `log.endpoint.query-answers-one-page` | diagnostics가 없는 빌드의 endpoint 메서드 `log.query`가 질의의 page로 답하고, 매개변수를 invalid-params 오류와 질의의 문구로 거절하며, `window`를 받지 않는다. | both |
| `log.endpoint.query-answers-the-rows-around-a-row` | endpoint 메서드 `log.query`는 `around`가 있으면 `context` 표시를 가진 그 행 둘레의 행과 null인 `next`를 답하고, 다른 filter 항목은 코드 `-32602`와 질의의 오류 문구로 거절한다. | both |
| `debug.log-query.answers-the-query-of-the-endpoint` | host 호출 `logQuery`가 같은 요청에 endpoint 메서드 `log.query`와 같은 page로 답하고, 오류는 질의의 오류 문구다. | both |
| `debug.follow.coalesces-writes-into-a-notice` | event log의 변경 알림은 창을 기다리지 않고 돌아오며, 알림은 250 ms 이상 간격으로 발행되고(시험은 더 짧은 간격으로 확인한다), 그동안 온 알림은 마지막 경로와 크기를 가진 알림 하나가 된다. `notices`는 발행한 알림 수이고 `notices + coalesced`는 알림 전체 수이며, `host.log`의 값은 가장 최근 알림이고 첫 알림 전에는 0 값이다. | both |
| `debug.follow.announces-only-changes-that-are-not-log-reads` | `announcing`이 0인 색인 갱신은 알림을 발행하지 않고, `announcing`이 0보다 큰 갱신은 그 갱신의 파일과 크기를 담은 알림을 발행한다. | both |
| `debug.follow.query-announces-the-lines-it-indexes` | 색인을 최신으로 만든 질의는 그 줄의 알림을 발행하고, 이미 최신인 색인의 질의는 발행하지 않는다. | both |
| `log.writer.announces-each-write-to-the-observer` | host의 기록기는 한 묶음을 쓴 뒤 파일의 경로와 크기로 observer를 부른다. | both |
| `debug.read.returns-the-end-of-a-text-file` | `debugRead`는 `logs/` 아래 글 파일의 전체 내용을, 더 크면 문자 경계에서 시작하는 마지막 262144 byte를 `truncated` true와 함께 `kind` `text`인 `{path, size, truncated, kind, text}`로 답한다. | both |
| `debug.read.returns-a-png-file-as-an-image` | `debugRead`는 PNG 파일 전체의 `data:image/png;base64,` 주소를 `kind` `image`인 `{path, size, truncated, kind, image}`로 답하고, PNG signature로 시작하지 않는 `.png` 파일과 16 MB보다 큰 PNG 파일은 거부한다. | both |
| `debug.read.refuses-a-path-outside-logs-and-a-file-that-is-not-text` | `debugRead`는 `logs/` 밖의 경로, 파일이 아닌 경로, 내용이 UTF-8 글이 아닌 파일을 그 경로를 밝히는 오류로 거부한다. | both |
| `assets.missing.writes-one-error-line-for-each-path` | host가 내줄 수 없는 page 파일 요청은 그 경로마다 한 번 `error host page asset: <path>: not found`로 알리고, 내준 파일은 알리지 않으며, 파일 확장자가 없는 경로도 알리지 않는다. | both |
| `assets.missing.does-not-answer-with-the-start-document` | 파일 확장자가 있고 어떤 파일도 가리키지 않는 경로의 요청은 두 host의 파일 서버에서 시작 문서로 답하지 않는다. Wails 서버는 404로, Tauri 프레임워크는 asset 오류로 답한다. | tauriv2 only: Tauri 프레임워크는 `<path>`, `<path>.html`, `<path>/index.html`을 찾고 시작 문서로 대신한다. Wails 서버는 스스로 404로 답한다 |
| `assets.missing.runtime-optional-file-is-not-reported` | Wails runtime이 요청하고 애플리케이션이 제공하지 않는 runtime 파일 `/wails/custom.js`는 알리지 않는다. | wailsv3 only: Wails runtime이 이 선택 파일을 설계상 요청한다 |
| `page.process.termination-writes-an-error-line` | host가 실행되는 동안 창의 WebContent process가 끝나면 host는 그 종료마다 한 번 `error host page process: <window>: terminated`를 쓴다. 단 host가 종료하는 동안은 process를 일부러 끝내므로 쓰지 않는다. | both |
| `quit.cancel.ends-the-quit-state` | 시작한 종료 상태는 `windowCloseKept`가 취소할 때까지 유지된다. 시작과 취소는 멱등이고, `host.window`가 이 상태를 `quitting`으로 보고한다. | both |
| `project-removal.ask.waits-for-the-owner-answer` | 프로젝트의 제거 요청은 그 프로젝트를 보이는 창의 답으로 이행한다. 요청이 대기 중인 프로젝트에 대한 두 번째 요청, 요청 없는 답, 올바르지 않은 project id는 오류로 실패하고, 요청을 받은 창이 끝나면 제거해도 된다고 답한 것으로 본다. | both |
| `project-removal.abandon.records-each-allowed-removal` | 제거에 대한 질문을 받은 창이 끝나면 제거를 허용하고, 그 요청마다 `window`와 `project`를 가진 event `host.project.removal_allowed`를 저장한다. 다른 창의 요청에는 저장하지 않는다. | both |
| `debug.record.writes-the-state-file` | 기록은 주어진 상태와 UTC `time` `YYYYMMDDTHHMMSSZ`를 담은 `logs/state-<time>.json`을 쓰고 그 상대 경로로 답한다. | both |
| `debug.record.keeps-the-newest-20-state-files` | 상태 파일을 쓴 뒤 host는 시각으로 가장 새 20개를 넘는 `logs/state-<time>.json` 파일을 지우고 `logs/`의 다른 파일은 둔다. | both |
| `cli.identity.build-identifier` | `dev` 플래그 build는 `app.soksak.<wails 또는 tauri>.dev`를 쓰고, 진단 build를 포함한 다른 build는 `app.soksak.<wails 또는 tauri>`를 쓴다. | both |
| `cli.command.flags-from-schema` | 선언된 command는 창, surface, 그리고 선언된 schema로 flag에서 바꾼 매개변수와 함께 `command.run`으로 실행된다. 텍스트, 숫자, 정수, boolean, enum 값, nullable type의 `null`, JSON 객체와 배열, `--`로 시작하며 `=` 뒤에 준 값이며, `--params`는 객체 전체를 준다. | both |
| `cli.command.rejects-undeclared-or-invalid-values` | 선언되지 않은 flag, schema와 맞지 않는 값, 값이 없는 flag, 값이 따라오는 boolean, 매개변수 flag와 함께 쓴 `--params`, 선언되지 않은 command는 `command.run`을 보내기 전에 종료 상태 2로 끝난다. | both |
| `cli.commands.lists-declared-commands` | `sok commands`는 `exposure.list`의 `commands` 목록을 애플리케이션이 선언한 순서대로 출력한다. | both |
| `cli.path.writes-and-removes-the-entry` | `sok path install`은 실행 중인 `sok`의 폴더를 담은 `<paths directory>/<identifier>`를 쓰고 파일과 폴더를 출력한다. 되풀이해도 같은 파일이다. `sok path remove`는 그것을 지우며 없어도 성공한다. 쓰기 실패는 파일과 `run sudo sok path install`을 보고한다. | both |
| `cli.path.fails-without-a-path-entry-folder` | 경로 항목 폴더가 없는 운영체제에서 `sok path install`은 `path entries are not implemented on linux` 같은 platform의 까닭으로 실패하고 아무것도 쓰지 않는다. | both |
| `cli.pack.writes-sorted-plugin-release` | `sok plugin pack`은 `package.json`과 나열한 파일을 경로 순서, mode 0644나 0755, 시각 0, 소유자 0으로 담은 `<id>-<version>.tgz`를 쓰고, `id`, `release`, `sha256`, `version`을 출력하며, 되풀이하면 같은 byte를 쓴다. | both |
| `cli.pack.rejects-links-and-manifest-mismatch` | 나열한 폴더 안의 symbolic link, id 없는 `plugin.json`, `soksak`이 있는 `package.json`은 종료 상태 1로 실패하고 출력 폴더를 비워 둔다. | both |
| `cli.pack.diagnostics-only-with-flag` | `sok plugin pack`은 `diagnostics.json`과 그 module을 빼고, `--diagnostics`는 둘을 더하며, `files`가 둘 중 하나를 나열하면 pack이 실패하고, `plugin pack` 밖의 `--diagnostics`는 종료 상태 2다. | both |
| `cli.pack.rejects-unlisted-modules` | `plugin.json`의 surface module, 방향과 상관없는 section module, state module이 `files`가 나열한 경로 밖에 있으면 `sok plugin pack`은 종료 상태 1로 실패하고 그 module을 밝힌다. | both |
| `cli.release.writes-release-and-sums` | `sok sidecar release`는 `<file name>-<version>-<platform>.tar.gz`를 쓰고 release마다 `SHA256SUMS` 한 줄을 이름 순서로 유지하며, 같은 이름은 바꾼다. 알 수 없는 `--platform`은 종료 상태 2, 나열하지 않은 실행 파일은 1, 형식이 틀린 `SHA256SUMS`는 release를 쓰지 않고 1이다. | both |
| `cli.release.requires-the-replay-executable` | `sidecar.json`이 `replay`를 선언한 package에서 `replay.executable`이 없거나 `files`가 나열하지 않으면 `sok sidecar release`는 release를 쓰지 않고 그 파일 이름을 담은 오류로 1로 끝나며, 나열한 package는 release된다. | both |
| `cli.registry.writes-checked-index` | `sok registry build`는 registry 파일을 읽고 모든 release hash와 plugin release의 `package.json`, `plugin.json`을 검사한 뒤, 선언한 필드 순서와 두 칸 들여쓰기로 `index.json`을 쓰고 `index`, `packs`, `plugins`, `sidecars`를 출력한다. 두 구현은 같은 텍스트를 쓴다. | both |
| `cli.registry.rejects-without-writing` | 형식이 틀린 hash, hash가 다른 release, 항목과 다른 `package.json`, 항목과 다른 파일 이름, 없는 `revoked.json`, 알 수 없는 plugin을 지정한 pack은 종료 상태 1이며 `index.json`을 남기지 않는다. | both |
| `cli.registry.checks-plugin-dependencies` | `sok registry build`는 나열된 plugin을 지정하는 `plugin.json`의 dependency를 받아들이고 version의 `sidecars`에는 sidecar dependency만 쓴다. 나열된 plugin도 나열된 sidecar도 지정하지 않는 dependency와 나열된 어느 version도 채우지 않는 plugin dependency는 그 문구와 함께 종료 상태 1이며 `index.json`을 남기지 않는다. | both |
| `cli.registry.lists-core-releases` | `sok registry build`는 registry 폴더의 `core.json`을 읽고 모든 core release의 `sha256`을 확인하며, 정렬한 목록을 `index.json`의 `sidecars`와 `packs` 사이에 `core`로 쓰고 결과에 `core`로 센다. `core.json`이 없는 registry는 `core`를 쓰지 않고 0으로 센다. | both |
| `cli.registry.rejects-malformed-core-releases` | `sok registry build`는 알려진 platform과 host의 `<platform>-<host>`가 아닌 core release 키, 두 번 나열된 버전, 알 수 없는 field, hash가 다른 release, 나열되지 않은 철회 core 버전이 있으면 `index.json`을 쓰지 않는다. | both |
| `app-update.state.selects-the-candidate` | 애플리케이션 업데이트의 후보는 `core`에서 실행 중인 core보다 새롭고 `revoked.core`에 없으며 `<platform>-<host>` 키의 release가 있는 가장 새 버전이다. `core`가 없는 index에는 후보가 없다. | both |
| `app-update.stage.verifies-and-extracts` | 후보를 준비하면 release를 받고 `sha256`을 확인하고 `<config-dir>/updates/<version>/`을 지운 뒤 그 안에 zip을 풀고, `CFBundleShortVersionString`이 그 버전인 애플리케이션 번들 하나를 담았는지 확인해 번들의 경로를 돌려준다. | both |
| `app-update.stage.rejects-a-wrong-release` | hash가 다르거나 번들 버전이 후보와 다르거나 읽을 수 없는 release는 단계를 밝힌 메시지로 실패하고 준비한 폴더를 남기지 않는다. | both |
| `app-update.host.stages-only-the-candidate` | host는 지금 registry index의 후보인 버전만 준비하며, 다른 버전과 실행 중인 버전에는 `<version> is not the candidate of core <running>`으로 실패한다. | both |
| `app-update.replace.replaces-the-bundle-after-the-process-ended` | `sok app update`는 커널 알림으로 프로세스의 끝을 기다리고, 새 번들을 target 옆에 복사하고, target을 옆으로 옮기고 복사본을 그 자리로 옮기고, `--` 뒤의 인자로 target을 시작한 뒤 이전 번들과 준비한 번들을 지우고 `{target}`을 출력한다. | both |
| `app-update.replace.restores-the-bundle-when-the-start-fails` | 옮긴 뒤 시작이 실패하면 새 번들을 지우고 이전 번들을 되돌려 시작하며 시작의 메시지로 실패한다. | both |
| `app-update.replace.refuses-before-it-changes-anything` | 응용 프로그램 번들이 아닌 target이나 bundle, 둘이 같은 폴더인 경우, 기한(60초) 뒤에도 실행 중인 프로세스는 target이 바뀌기 전에 실패한다. | both |
| `app-update.apply.starts-sok-from-a-copy-and-checks-the-bundle` | 업데이트를 적용하면 실행 중인 번들의 `sok`을 `<config-dir>/updates/sok`에 복사하고 `sok app update --wait <pid> --bundle <bundle> --target <실행 중인 번들> [-- <인자>]`를 새 세션으로 준비한다. `updates/` 밖의 번들, `Info.plist`가 없는 폴더, 응용 프로그램 번들 밖의 애플리케이션은 거부한다. | both |
| `app-update.apply.records-the-detached-command` | 분리 실행한 명령은 host의 표준 오류를 그대로 쓰므로 그 메시지는 실행의 표준 오류 파일에 있고, host는 명령을 시작할 때 명령의 `pid`와 `command` 줄을 가진 event `host.update.start`를 저장한다. 시작할 수 없는 명령은 그 명령을 이름으로 가리키는 오류다. | both |
| `cli.plugin.install-extracts-and-records` | `sok registry use`는 검사한 index를 `file:` URL로 기록한다. `sok plugin install`은 plugin과 그 sidecar version을 mode와 함께 풀고, 푼 폴더마다 절대 `path`를 담아 `installed.json`을 쓰고, plugin 항목과 sidecar version을 출력하며, 되풀이하면 아무것도 바꾸지 않는다. | both |
| `cli.plugin.install-modes-ignore-the-umask` | umask 077에서도 `sok plugin install`은 실행 파일을 mode 0755로, 다른 파일을 mode 0644로 쓴다. | both |
| `cli.plugin.install-failure-keeps-state` | `plugins/registry.json`이 없거나, hash가 index와 다른 release이거나, 폴더 밖 항목을 담은 release이면 `sok plugin install`은 종료 상태 1이며 `installed.json`, version 폴더, 푼 파일을 남기지 않는다. | both |
| `cli.plugin.dependencies-install` | `sok plugin install`은 고른 version의 plugin dependency도 설치한다. 설치되지 않은 provider는 범위를 채우는 가장 새 version을 받고, 모든 범위를 채우는 설치된 provider는 그대로 두며, 다른 설치된 provider는 모든 범위를 채우는 가장 새 version과 `previous`를 받고, 꺼진 provider는 켜진다. `installed.json` 항목마다 `sidecars`는 sidecar 범위만 담는다. | both |
| `cli.plugin.dependencies-reject` | Registry index의 plugin도 sidecar도 지정하지 않는 dependency는, provider를 `installed.json`만 나열해도, `<plugin> <version>: dependency <package> is neither a plugin nor a sidecar of the registry`로 실패한다. 어느 version도 채우지 않는 plugin dependency는 provider, core version, 각 plugin과 범위를 밝혀 실패하고, 순환은 `plugin dependency cycle: <id> -> <id> -> <id>`로 실패한다. 실패마다 `installed.json`과 plugin 폴더는 바뀌지 않는다. | both |
| `cli.plugin.dependencies-update` | Provider의 `sok plugin update`는 켜졌든 꺼졌든 그 provider를 지정하는 모든 설치된 plugin의 범위를 채우는 가장 새 version을 고르고, 지정하는 설치된 plugin이 없어지면 가장 새 version을 고른다. | both |
| `cli.plugin.dependencies-required` | 켜진 설치 plugin이 package를 지정하는 plugin의 `sok plugin remove`와 `sok plugin disable`은 `plugin <id> is required by <dependent> <range>`로 실패하고 `installed.json`과 폴더를 바꾸지 않는다. Dependent를 끄면 둘 다 성공한다. | both |
| `cli.plugin.installed-reads-name-from-package-json` | `sok plugin install`은 `installed.json`에 `package`를 쓰지 않고, `sok plugin remove`, `disable`, `update`의 dependency 규칙은 설치된 plugin의 이름을 기록된 `path`의 `package.json`에서 가져온다. | both |
| `cli.plugin.installed-refuses-package` | Plugin이 `package`를 담은 `installed.json`을 읽으면 `<file>: plugins/installed.json <id>: unknown field package`로 실패한다. | both |
| `cli.plugin.update-remove-enable-list` | `sok plugin update`는 설치되지 않은 plugin이면 실패하고, `enabled`를 유지하며 `previous`를 기록해 가장 새 version을 설치하고, 쓰는 version과 `previous`만 남긴다. `disable`과 `enable`은 `enabled`를 정하고, `list`는 `installed.json`을 출력하며, `remove`는 `null`을 출력하고 plugin과 sidecar 폴더를 지우며 되풀이하면 실패한다. | both |
| `cli.plugin.state-reads-registry-and-installed` | Installer library는 `{registry, index, installed}`를 보고한다. `plugins/registry.json`이 없으면 registry와 index가 `null`이고, 있으면 index URL과 검사한 index이며, 읽지 못한 index는 그 읽기 오류를 `index`로, 잘못된 `installed.json`은 오류를 보고한다. | both |
| `cli.plugin.action-runs-the-command` | Installer library는 `install`, `update`, `remove`, `enable`, `disable`을 같은 `sok plugin` 명령의 결과로 실행하고, 다른 action은 `unknown plugin action`으로 거부한다. | both |
| `cli.file.errors-name-the-path-and-the-reason` | 실패한 파일 작업은 `<경로>: <이유>`로 보고하며, 이유는 소문자로 시작하는 운영체제 오류 문구다. 없는 registry index는 `<경로>: no such file or directory`, 읽을 수 없는 `installed.json`은 `<경로>: permission denied`를 보고한다 | both |
| `cli.debug.query-golden-lines` | `sok debug query`가 모든 사례에서 `packages/log-contract/fixtures/query`의 golden page의 글 줄을 debug 화면과 같은 줄로 출력하고, 행이 page 뒤에 더 있으면 표준 오류에 `more: --after <cursor>`를 쓴다. | both |
| `cli.debug.query-errors` | `sok debug query`는 event 파일이 event 구조를 어기면 파일과 줄 번호를 담은 오류로, `logs/` 폴더가 없으면 폴더를 담은 오류로 실패한다. | both |
| `cli.debug.query-flag-values` | `sok debug query`는 잘못된 flag 값을 질의의 오류 문구를 가진 사용법 오류로 거부하고, 명령에 없는 flag를 거부한다. | both |
| `cli.debug.replay-equal` | `sok debug replay <session>`은 session의 sidecar event가 가진 role을 선언한 설치된 sidecar의 replay 실행 파일을 segment마다 한 번 실행하고, 저장된 hash가 모두 재생한 hash이면 `replay session <session>: <n> sidecar frames and <m> page frames equal in <k> segments`를 출력한다. | both |
| `cli.debug.replay-until` | `sok debug replay --until <sequence>`는 실행 파일에 그 순번까지의 event만 주고 그 순번까지의 frame 기록만 비교한다. 음이 아닌 정수가 아닌 값은 사용법 오류다. | both |
| `cli.debug.replay-divergence` | `sok debug replay`는 순번 순서로, 같은 순번이면 sidecar를 page보다 먼저 보아 저장된 hash가 재생한 hash와 다른 첫 곳에서 상태 1로 끝나며, `sok: replay divergence: session <session> segment <boot> sequence <n> layer <layer> expected <hash> found <hash>`를 쓰고 event `sok.replay.divergence`를 저장한다(`segment`를 가지며, sidecar frame 기록이 없는 page frame 기록이면 `expected`는 `none`). | both |
| `cli.debug.replay-segments` | 새 sidecar 실행에서 `sequence`가 다시 시작하는 session은 `boot`마다 하나의 segment로 재생한다. 각 segment는 빈 화면에 자기 순번으로 적용되어 자기 저장 hash와 비교되고, `--until`은 각 segment의 순번을 제한하며, 불일치는 segment를 이름으로 밝힌다. | both |
| `cli.debug.replay-holds-one-segment` | 재생은 한 번에 한 segment의 event 줄을 보관하며, 결과는 segment 수와 한 번에 보관한 줄의 최댓값을 보고한다. 그 값은 session이 아니라 가장 큰 segment의 크기다. | both |
| `cli.debug.replay-segment-errors` | `fields.segment`가 없는 page frame 기록, 문자열이 아니거나 session에 없는 `boot`를 가리키는 `fields.segment`, 시각상 번갈아 나오는 두 segment의 sidecar event는 불일치 없이 재생을 실패시킨다. | both |
| `cli.debug.replay-session-rules` | `sok debug replay`는 sidecar의 `replay.inputs`가 적는 event인 각 segment의 재생 입력을 session 규칙으로 검사하고, 규칙을 어긴 segment를 `replay session <session>: segment <boot>: <problem>`으로 거부한다. 종류마다 `replay.inputs`가 없는 sidecar.json은 그 파일을 밝히는 오류다. | both |
| `cli.debug.replay-input-cases` | 도구의 재생 입력 규칙은 `packages/log-contract/fixtures/replay/inputs.json`의 모든 case를 재현한다: valid 입력, 문구가 있는 invalid 입력, problem이 있는 session. | both |
| `cli.debug.replay-errors` | `sok debug replay`는 sidecar event가 없는 session, 두 role의 sidecar event가 있는 session, 그 role을 선언한 설치된 sidecar가 없는 경우, frame 기록이 없는 경우, 소문자 16진 64자가 아닌 저장된 hash, 실패하거나 `{"sequence", "hash"}`가 아닌 줄을 출력하거나 frame 기록의 hash를 출력하지 않는 재생 실행 파일에서 불일치가 아닌 오류로 실패한다. | both |
| `cli.log.records-each-command-with-its-result` | `sok`을 실행할 때마다 대상 설정 디렉터리에 `logs/sok-<boot>.jsonl`을 쓴다. `seq` 1의 `log.open`, 이어서 명령 단어, 공백으로 이은 인자, 마이크로초, `ok`, `status`, 상태가 0이 아니면 표준 오류의 첫 줄인 `error`를 담은 `sok.command`가 level `debug` 또는 `warn`으로 저장되며, 모든 줄이 층 `sok`, `ts_us`, `mono_ns`를 가진다. | both |
| `cli.log.records-a-panic-with-its-stack` | 명령의 panic은 `sok.panic`(thread `main`, 글, panic한 함수를 가리키는 stack)과 상태 4의 `sok.command`를 저장하고, `sok: panic: <text>`를 표준 오류의 맨 앞에 쓰며, 호출자에게 닿지 않고 상태 4를 돌려준다. | both |
| `cli.log.records-a-panic-of-a-routine-and-ends-the-process` | 도구가 시작한 goroutine이나 thread의 panic은 routine의 이름과 stack을 담은 `sok.panic`을 저장하고 프로세스를 상태 4로 끝낸다. | both |
| `cli.log.writer-options.refuses-a-negative-rotation-bound` | rotation 한도가 0 미만인 writer는 한도를 이름으로 가진 오류로 거부된다. | wailsv3 only: Rust writer의 rotation 한도는 부호 없는 수여서 음수일 수 없다 |
| `cli.log.writer-options.stores-the-layer-the-clock-and-the-cids` | rotation이 없는 writer는 옵션이 주는 layer, 시계, correlation identifier를 저장하고 rotation하지 않는다. | both |
| `cli.log.writer-options.rotates-at-its-bound` | rotation 한도가 있는 writer는 한도에서 새 파일을 쓰고, 새 파일은 `log.open`과 `log.rotated`로 시작한다. | both |
| `cli.log.writer-options.stores-the-events-and-the-loss-of-its-pull-source` | writer는 pull source가 돌려주는 event와 source가 보고한 손실을 저장한다. | both |
| `buffers.sidecar-replies.order-is-bounded` | sidecar reply를 기다리는 요청의 순서는 응답한 요청이 몇 개든 대기 요청 한도의 두 배를 넘지 않는다. | both |
| `buffers.sidecar-replies.forgotten-request-is-counted` | 대기 요청의 한도에서 잊는 요청은 세며, 잊는 것은 가장 오래된 요청이다. | both |
| `cli.log.lines-follow-the-golden-fixtures` | 도구의 `log.open` 줄은 `packages/log-contract/fixtures/key.jsonl`의 `log.open` 줄과 같은 key, key 순서, field 집합(schema 2, `role` `sok`)을 가지며, event 줄은 golden event 줄의 key 순서와 `ts_us`, `mono_ns`, `seq` 2를 가진다. | both |
| `cli.log.escapes-and-truncates-like-the-contract` | 따옴표, 역슬래시, 줄바꿈, tab, U+2028, ASCII가 아닌 글을 담은 field가 줄을 거쳐 그대로 돌아오고, fields 글이 1,048,576바이트를 넘는 event는 원래 크기를 담은 `truncated`와 4,096바이트의 `fields` `{"head": ...}`로 저장된다. | both |
| `cli.log.records-a-refused-event-as-log-dropped` | writer가 거절한 event는 세어져 golden field(`from_seq`, `to_seq`, `count`)를 가진 level `warn`의 `log.dropped`로 저장되고, 저장된 `seq`와 그것이 가리키는 범위가 1부터 n까지를 한 번씩 덮으며 `log.dropped`는 그 범위 뒤에 온다. | both |
| `cli.log.run-stores-only-the-declared-events` | 한 번의 실행은 `log.open`, `sok.command`, `sok.panic`, `log.dropped`만 저장한다. 이것이 rotation 없는 writer의 근거이며 main 파일과 debug 파일 모두 그렇다. | both |
| `cli.log.stores-class` | 도구는 host writer처럼 `class`와 `undeclared`를 저장한다. | both |
| `cli.log.policy-accepts-the-golden-cases` | 도구의 policy 파일 reader는 `packages/log-contract/fixtures/policy/cases.json`의 모든 valid case를 그 class와 gate대로 받는다. | both |
| `cli.log.policy-refuses-the-golden-cases` | 도구의 policy 파일 reader는 `packages/log-contract/fixtures/policy/cases.json`의 모든 invalid case를 그 case의 오류 문구로 거부한다. | both |
| `cli.log.splits-files-by-level` | 도구는 `error`, `warn`, `info`를 `logs/sok-<boot>.jsonl`에, `debug`와 `trace`를 `logs/sok-<boot>.debug.jsonl`에 쓰며, 후자는 첫 해당 event와 함께 만들고 `log.open`으로 시작한다. | both |
| `cli.log.reports-a-folder-that-cannot-be-written` | `logs/`나 event 파일을 만들 수 없으면 도구는 `sok: event log: <path>: <reason>`을 표준 오류에 쓰고 명령을 자기 종료 상태로 실행한다. | both |
| `install.version.ranges-and-order` | 범위 `x.y.z`, `^x.y.z`, `~x.y.z`, `>=x.y.z <a.b.c`는 선언한 경계를 가지고, `*`는 상한이 없는 `>=0.0.0`이다. Version은 숫자로 비교한다. 다른 형식, 앞자리 0, 빈 범위, 4294967295를 넘는 자리는 `invalid version`으로 거부한다. | both |
| `install.package-json.fields-and-manifest` | Plugin `package.json`에는 `name`, `version`, `engines.soksak`, plugin 안의 `plugin.json`을 나열한 `files`가 있어야 한다. `soksak`은 거부하고, `plugin.json`의 `dependencies`는 각각 올바른 범위다. 실패마다 필드를 밝힌다. | both |
| `install.registry.entries` | Registry plugin, sidecar, pack, revoked 항목은 알 수 없는 필드, 절대 `file:` URL이 아니거나 query, fragment, 잘못된 escape를 가진 URL, 소문자 16진수 64자리가 아닌 `sha256`, 중복 version, 알 수 없는 플랫폼, 1이 아닌 `protocol`, 200 code point를 넘는 설명, 빈 pack, 이유 없는 revoked 항목을 거부한다. | both |
| `install.registry.index-cross-checks` | Index는 format 2, 중복 plugin id나 package, 알 수 없는 plugin을 지정한 pack, 알 수 없는 sidecar나 어떤 sidecar version도 채우지 않는 범위가 필요한 plugin version, 나열되지 않은 revoked version을 거부한다. | both |
| `install.select.newest-usable` | 선택은 core version에 맞고 revoked가 아니며 그 plugin을 지정하는 모든 설치된 plugin의 범위를 채우는 가장 새 plugin version과, 범위 안에 있고 플랫폼 release가 있는 가장 새 sidecar version을 고른다. 맞는 것이 없으면 plugin, core version, sidecar, 플랫폼, 각 plugin과 범위를 밝힌다. | both |
| `install.select.shared-sidecar` | 선택은 쓰고 있는 sidecar version이 다른 모든 설치된 plugin의 범위를 채우면 그대로 두고, 아니면 모든 범위를 채우는 가장 새 version을 고른다. 설치하는 plugin의 이전 범위는 무시하며, 충돌하면 각 plugin과 범위를 밝힌다. | both |
| `install.names.releases-and-paths` | Release 이름은 `<id>-<version>.tgz`와 `<file name>-<version>-<platform>.tar.gz`, 설치 경로는 `plugins/<id>/<version>`와 `sidecars/<file name>/<version>/<platform>`이며, `@scope/name`은 `scope-name`이 된다. 알 수 없는 플랫폼이나 잘못된 plugin id는 거부한다. | both |
| `install.installed.consistency` | `plugins/installed.json`은 `enabled` 누락, 현재 형식에서 `package`를 담은 plugin, 설치 규칙의 폴더가 아닌 plugin이나 sidecar의 `path`, 3이 아닌 `format`, `{ version, path }`가 아닌 sidecar 항목, 없는 `sidecars` 객체, 쓰는 version이 없는 sidecar, plugin 범위 밖의 쓰는 version, 어느 plugin도 지정하지 않은 sidecar를 거부한다. | both |
| `cli.plugin.host-entry-takes-no-lock` | 설치 library의 `RunPluginAction`은 설정 폴더의 lock을 잡지 않는다. host들이 자기 소유 안에서 호출하므로 살아 있는 host의 lock 옆에서도 애플리케이션의 plugin 조작이 돈다. | both |
| `cli.plugin.writing-commands-own-the-configuration` | `sok` command line의 쓰기 plugin 명령은 쓰기 동안 `process.lock`으로 설정 폴더를 소유한다. 살아 있는 소유자(실행 중인 host나 두 번째 명령) 옆의 명령은 `configuration directory <dir> is already owned by process <pid>`로 거부하고, 끝난 process의 lock은 지우고 한 번 다시 시도하며, 명령이 끝나면 설정을 놓는다. host가 자기 소유 안에서 호출하므로 `RunPluginAction`은 lock을 잡지 않는다. | both |
| `install.migration.projects-wraps-the-bare-list` | engine이 workspace 계층의 첫 읽기에서 projects.json의 bare 배열(형태 0)을 `projects` member와 format member를 가진 객체(형태 1)로 감싸고 모든 project를 유지하며, 두 번 적용은 아무것도 쓰지 않는다. | both |
| `install.migration.settings-migrates-the-form-without-a-number` | engine이 workspace 계층의 첫 읽기에서 settings.json의 format member(형태 0에서 1)를 더하고 모든 설정을 유지하며, 두 번 적용은 아무것도 쓰지 않는다. | both |
| `install.migration.chain-ends-at-the-current-format` | embed된 정의 사슬이 reader가 요구하는 형식에서 끝나고 각 단계가 이전 단계가 끝나는 곳에서 시작한다. 다른 곳에서 끝나는 사슬은 소유 시험에 실패한다. | both |
| `install.migration.migrates-the-released-form` | 두 command line의 engine이 릴리즈가 쓴 그대로의 형식 2 `plugins/installed.json`(지워진 member와 `^` 범위 포함)에 정의를 적용하고 reader가 갱신된 file을 받아들인다. | both |
| `install.migration.is-idempotent` | 두 번 적용은 아무것도 쓰지 않고 byte가 바뀌지 않으며, 없는 file은 없는 채로 둔다. | both |
| `install.migration.refuses-forms-outside-the-chain` | 바닥 아래 형식, 현재 번호보다 새 형식, 판독 불가 file은 파일과 숫자로 거부되고 file은 바뀌지 않는다. | both |
| `install.installed.rejects-another-format` | 바닥 위에서 `format`이 2가 아닌 `plugins/installed.json`은 `<file>: plugins/installed.json: format must be 3`로 실패하고 바뀌지 않는다. 바닥 아래 형식은 `<file>: the file holds format <n>; the definitions migrate formats 2 to 3`로 실패하고 바뀌지 않는다. 형식 2 file은 reader 입구에서 3으로 갱신된다([저장 데이터 마이그레이션](installation.ko.md#저장-데이터-마이그레이션)). | both |
| `installed.document.lists-enabled-plugins` | `/installed-plugins.json`은 켜진 설치 plugin을 id 순서로 `id`, `package`, `version`, 그리고 `plugin.json`의 compact 내용인 `manifest`와 함께 나열하고, 진단 build에서만 `diagnostics.json`의 compact 내용을 더하며, `installed.json`이 없으면 `{"plugins":[]}`다. | both |
| `installed.document.names-from-package-json` | `/installed-plugins.json` 항목의 `package`와 설치된 plugin의 `/modules/<package>`는 기록된 `path`의 `package.json`의 `name`이며, `package.json`이 없으면 `{"error":"<file>: no such file or directory"}`다. | both |
| `installed.document.refuses-package` | Plugin이 `package`를 담은 `installed.json`은 `{"error":"<file>: plugins/installed.json <id>: unknown field package"}`다. | both |
| `installed.document.reports-errors` | 켜진 plugin의 `plugin.json`이 없거나 잘못되었거나, `diagnostics.json`이나 `installed.json`이 잘못되었으면 `/installed-plugins.json`은 파일과 이유를 담은 `{"error":...}`다. | both |
| `page.start.document` | 시작 문서는 작업 공간 스냅샷과 window의 `windowControls` 답을 이 순서로 담은 `{"workspace":...,"controls":...}`다. | both |
| `page.start.requires-window` | 시작 문서 요청은 요청한 window를 시작한 뒤 문서를 `no-store`인 `application/json`으로 답하고, 요청이 window를 가리키지 않으면 아무것도 시작하지 않고 400과 `the start document request names no window`로 실패하며, 시작이 실패하면 500과 그 이유로 실패한다. | both |
| `page.start.sok-core-owner` | Tauri는 시작 문서를 `sok://core/start.json`에서 내보낸다. 다른 owner의 `sok` 주소는 창을 시작하지 않고 404와 `sok://<owner>/start.json not found`로 답한다. | tauriv2 only: Wails는 시작 문서를 asset server의 `/start.json`에서 내보낸다 |
| `plugins.state.reports-registry-and-installed` | `pluginsState`는 `plugins/registry.json`이 없으면 `registry`와 `index`를 `null`로, 있으면 index URL과 검사한 index를, 읽거나 검사하지 못한 index는 `index`를 `{"error":...}`로 돌려주고, `installed.json`의 내용 또는 없을 때 빈 format 1 문서를 돌려준다. | both |
| `plugins.run.changes-like-the-command` | `install`, `update`, `disable`, `enable`, `remove`의 `pluginsRun`은 같은 `sok plugin` 명령처럼 `installed.json`과 폴더를 바꾸고 그 출력을 돌려주며, 바꿀 때마다 모든 창에 `{action, plugin}`과 함께 `plugins-changed`를 보낸다. | both |
| `plugins.run.applies-before-it-notifies` | `installed.json`을 바꾸는 plugin 작업은 `plugins-changed`를 보내기 전에 변경을 사이드카에 적용한다. | both |
| `plugins.run.rejects-invalid-and-concurrent` | `pluginsRun`은 알 수 없는 action, 비어 있지 않은 문자열이 아닌 plugin id, 명령의 message로 실패한 작업, 다른 작업이 실행 중일 때의 호출을 `another plugin operation is running`으로 거부하고, `plugins-changed` event를 보내지 않는다. | both |
| `plugins.registry.sets-like-the-command` | registry index로 `pluginsUseRegistry`를 부르면 `sok registry use`처럼 `plugins/registry.json`을 쓰고 `{ index }`를 돌려준다. 비어 있지 않은 문자열이 아닌 `index`는 `index must be a non-empty string`으로 거부한다. | both |
| `fetch.https.reads-a-tls-response` | 설정한 인증 기관이 신뢰하는 TLS server에서 `https:` index나 release를 읽고, `sha256`이 항목과 다른 release는 실패한다. | both |
| `fetch.https.redirects-only-to-https` | `https:` URL로의 redirect는 5번까지 따라간다. 여섯 번째 redirect와 `http:`로의 redirect는 그 문장으로 실패한다. | both |
| `fetch.https.reports-status-size-and-timeout` | 200이 아닌 응답, 한도보다 큰 본문, 한도보다 느린 요청은 `HTTP <status>`, `larger than <bytes> bytes`, `timed out after <seconds> s`로 실패한다. | both |
| `fetch.url.rejects-other-schemes` | `https:`도 절대 `file:` URL도 아닌 index나 release URL은 `the URL must be https: or an absolute file: URL`로 실패한다. | both |
| `installed.modules.serve-installed-files` | 켜진 설치 plugin의 `/modules/<package>/<path>`는 기록된 `path` 안의 파일을 제공한다. 없는 파일이나 빈 segment, `.`, `..`가 있는 경로는 찾을 수 없다. 꺼진 plugin이나 다른 package는 애플리케이션 frontend가 제공한다. | both |
| `installed.shared.serve-extension-point-modules` | `/shared/<plugin id>.<point>/<specifier>.js`는 켜진 설치 plugin의 `plugin.json` `extends.<point>.modules`가 specifier에 대응한, 그 plugin의 기록된 `path` 안의 파일을 제공한다. `.js`로 끝나지 않는 경로, plugin이 선언하지 않은 지점, 지점이 대응하지 않은 specifier, 없는 파일, 빈 부분이나 `.`, `..` 부분이 있는 경로, 꺼졌거나 알 수 없는 plugin은 찾을 수 없고, 읽을 수 없는 `plugin.json`은 그 경로와 함께 실패한다. | both |
| `installed.sidecars.resolve-installed-folders` | Host의 sidecar는 켜진 설치 plugin의 `plugin.json`이 지정한 것이며, 각각 sidecar 폴더의 기록된 `path`와 거기의 `sidecar.json`을 가진다. 설치 version이 없는 sidecar는 실패하고, 빈 설정에는 sidecar가 없다. | both |
| `installed.sidecars.leave-out-plugin-dependencies` | 켜졌든 꺼졌든 설치된 plugin을 지정하는 `plugin.json`의 dependency는 host의 sidecar가 아니다. | both |
| `log.writer.assigns-seq-and-opens-with-log-open` | host 로그 파일은 `schema`(2), `pid`, `role`, `boot`를 담은 `log.open`으로 시작하며, writer는 모든 줄에 1부터 연속인 `seq`를 부여한다. | both |
| `log.writer.stores-both-clocks` | writer의 모든 줄은, `log.open`, `log.rotated`, `log.dropped`를 포함해, `ts_us`(호출 시점의 wall clock, 마이크로초)와 `mono_ns`(호출 시점의 플랫폼 monotonic clock, 나노초이며 양수이고 앞선 호출의 `mono_ns`보다 작지 않다)를 가진다. | both |
| `log.writer.stores-cids` | host의 생산자가 상관 식별자와 함께 낸 event는 `cids`(순서대로의 목록)와 함께 저장되고, 식별자가 없는 event에는 `cids`가 없다. 비어 있거나 따옴표, 역슬래시, 제어 문자를 담은 식별자는 거부하고 손실로 센다. | both |
| `log.writer.never-blocks-and-counts-loss` | `emit`은 기다리지 않고 돌아온다. 큐에 자리가 없으면 false를 돌려주고, writer는 거부된 event 수와 같은 `count`와 거부된 event의 `channel`을 가진 `log.dropped` 하나를 그것이 가리키는 `seq` 범위 뒤에 저장한다. | both |
| `log.writer.writes-each-interval` | writer는 마지막 쓰기 뒤 batch 간격이 끝날 때마다 모인 것을 쓰며, event가 간격보다 빨리 계속 들어올 때도 그렇다. event가 없는 간격을 기다리는 writer는 꾸준한 입력 동안 아무것도 쓰지 않고 kill에서 한 간격보다 많이 잃는다. | both |
| `log.writer.error-wakes-the-writer` | level이 `error`인 event는 배치 간격을 기다리지 않고 기록된다. | both |
| `log.writer.files-are-private` | 로그 폴더는 mode 0700, 로그 파일은 mode 0600이다. | both |
| `log.writer.output-follows-the-contract` | writer의 파일은 자신의 event를 선언한 catalog에 대해 `@soksak/log-contract` 감사를 통과한다. | both |
| `log.writer.flush-at-exit` | `flush`는 받아들인 모든 event가 디스크에 기록된 뒤 돌아오며, 기한이 지나면 실패한다. | both |
| `log.writer.relays-events-with-their-layer-and-time` | host의 writer는 프로세스의 다른 계층이 중계한 event를 그 event의 `layer`, `ts_us`, `mono_ns`, `cids`와 writer의 `seq`로 저장하고, 계층으로 시작하지 않는 event 이름, 계약에 없는 계층, 0인 `mono_ns`, 유효하지 않은 식별자는 오류로 거부한다. | both |
| `log.writer.rotates-at-the-bound-and-keeps-generations` | writer는 파일을 `rotate_bytes`를 넘게 될 줄 앞에서 닫고, 닫은 파일을 하나도 지우지 않고 세대 `.1`부터 `.N`으로 보관하고, 새 파일을 `log.open`과 `log.rotated`로 시작하되 `seq`를 이어 가고, 모든 세대가 계약의 파일이다. | both |
| `log.writer.refuses-an-unbounded-file` | 양의 회전 경계나 양의 세대 수 없이 시작한 writer는 그 옵션을 가리키는 오류로 시작에 실패한다. | both |
| `log.native.stores-pulled-records-in-the-layer-native` | writer는 native ring에서 pull한 record를 library가 준 시각과 level, 이름, field, writer의 `seq`로 계층 `native`에 저장한다. | both |
| `log.native.stores-clock-and-cids-of-pulled-records` | native ring에서 pull한 record는 library가 준 `ts_us`, `mono_ns`, `cids`와 함께 저장된다. 식별자에 따옴표, 역슬래시, 제어 문자가 있거나 이름과 식별자의 길이가 record에 맞지 않는 record는 이유 `a native record was refused`의 `log.dropped`로 센다. | both |
| `log.native.counts-refused-records-and-ring-loss` | writer는 native ring이 거부한 event를 이유 `the native ring was full`의 `log.dropped`로 세고, 계층 `native` 밖의 이름, 정의되지 않은 level이나 class, JSON 객체가 아닌 field, 맞지 않는 길이를 가진 pull한 record를 이유 `a native record was refused`의 `log.dropped`로 센다. | both |
| `log.native.pulls-at-the-batch-interval` | writer는 배치 간격마다 native ring을 pull하므로, 나중에 도착한 record는 flush 요청 없이 저장된다. | both |
| `log.native.platform-pulls-the-ring` | 플랫폼은 빈 native ring을 0바이트와 손실 없음으로 pull하고, 빈 buffer로의 pull은 거부한다. | both |
| `log.native.platform-reads-the-clock-and-takes-the-boot` | 플랫폼은 양수이고 줄어들지 않으며 시간과 함께 늘어나는 monotonic clock(나노초)을 읽고, 실행의 boot 식별자를 native 계층의 상관 식별자용으로 받는다. 빈 식별자와 영문자, 숫자, `-`, `_` 외의 문자가 있는 식별자는 거부한다. | both |
| `log.native.host-writer-starts-with-the-platform-pull` | host의 writer는 플랫폼의 pull과 함께 시작하고 `log.open`을 먼저 쓴다. | both |
| `log.native.platform-flushes-the-observers` | 플랫폼은 마지막 요약 뒤에 전달이 있는 native observer의 모든 counted source의 요약을 저장하고 오류 없이 응답한다. | both |
| `log.native.shutdown-flushes-the-observers-before-the-writer` | host의 종료는 native observer를 먼저 flush하고 event writer를 나중에 flush하므로, observer flush가 저장한 event는 종료 flush가 반환될 때 파일에 있다. | both |
| `log.native.shutdown-reports-a-failed-observer-flush` | native observer의 flush가 실패해도 writer의 flush는 건너뛰지 않고, 결과는 observer flush와 그 원인을 이름으로 밝힌다. | both |
| `log.writer.stores-class` | writer의 모든 줄은 catalog가 그 event 이름에 선언한 class인 `class`를 담으며, writer 자신의 event의 줄도 그렇다. | both |
| `log.writer.marks-undeclared` | catalog가 이름을 선언하지 않은 event는 `class` 없이 `undeclared` `true`로 저장하며 버리지 않는다. | both |
| `log.writer.splits-files-by-level` | level `error`, `warn`, `info`는 `<role>-<boot>.jsonl`에, `debug`와 `trace`는 `<role>-<boot>.debug.jsonl`에 간다. 후자는 첫 해당 event가 `log.open`을 첫 줄로 하여 만들며, `seq`는 두 파일에 걸쳐 이어지고 두 파일을 합치면 모든 `seq`가 한 번씩 있다. | both |
| `log.writer.rotation-keeps-every-generation` | 각 파일은 상한에서 따로 회전해 회전 순서대로 1부터 센 세대 `<file>.<n>`이 되고, 새 파일은 `log.open`과 `log.rotated` `{bytes, generation}`으로 시작하며, 회전은 세대를 지우지 않는다. | both |
| `log.native.stores-the-class-of-a-pulled-record` | native ring에서 pull한 record는 그것이 가진 class로 저장하고, class가 열거 밖이거나 catalog의 class와 다른 record는 거부하며 이유 `a native record was refused`의 `log.dropped`로 센다. | both |
| `log.native.platform-takes-the-policy` | 플랫폼은 정책(class마다 level 하나 또는 -1)을 native 라이브러리에 주고, 열거 밖의 level은 거부한다. | both |
| `log.policy.file-names-every-class-and-nothing-else` | 모든 class를 한 번씩 여섯 값 중 하나로 이름 붙인 정책 파일은 적용한다. JSON이 아닌 글, `schema`와 `classes` 외의 항목, 다른 schema, 빠졌거나 모르는 class, 여섯 밖의 값은 파일 이름과 발견한 것을 담은 오류로 거부한다. | both |
| `log.policy.file-is-watched` | `log-policy.json`의 생성, 쓰기, 교체, 삭제는 타이머 없이 파일 시스템 event로 정책을 적용하고, 파일을 그대로 두는 알림은 아무것도 바꾸지 않으며, 규칙을 어긴 파일은 장소 `log policy`의 오류 기록이고 적용 중인 정책은 그대로 남는다. | both |
| `log.policy.default-stores-errors` | 정책 파일이 없는 writer는 모든 class의 `error` event를 저장하고 모든 class의 `warn`, `info`, `debug`, `trace` event를 거부하며, 기본 정책은 `packages/log-contract/fixtures/policy/cases.json`의 `default`와 같다. | both |
| `log.policy.change-is-an-event` | writer의 첫 정책과 이후의 각 변경은 `source`와 `classes`를 가진 `log.policy` event 하나이며, 같은 정책이 다시 오면 아무것도 저장하지 않는다. | both |
| `log.policy.gate-counts-what-it-did-not-build` | 닫힌 gate는 아무것도 저장하지 않고, writer는 거부한 event의 정확한 수를 class와 level별로 `log.gated`로 보고한다. | both |
| `log.policy.gate-passes-the-events-of-the-writer-itself` | `log.open`, `log.rotated`, `log.dropped`, `log.policy`, `log.gated`, `log.pruned`는 class `lifecycle`을 끈 정책을 지난다. | both |
| `log.policy.page-sets-the-file` | host 호출 `log`의 action `policy`는 class를 파일의 규칙으로 검사하고 `log-policy.json`(mode 0600)을 쓰며, 규칙을 어긴 요청은 오류이고 아무것도 쓰지 않는다. | both |
| `log.policy.binding-call-is-gated` | 정책이 저장하지 않는 binding 호출은 event를 만들지 않고 `log.gated`로 세며, 실패한 호출은 정책이 그 class를 `warn`부터 저장하면 경고로 저장한다. | both |
| `log.policy.endpoint-call-is-gated` | 정책이 저장하지 않는 endpoint 요청은 event를 만들지 않고 `log.gated`로 센다. | both |
| `log.policy.counts-each-second` | writer는 닫힌 gate의 정확한 수(`log.gated`)를 이전 보고 뒤 1초가 지났을 때, flush할 때, 멈출 때 보고한다. 여러 batch 간격에 걸친 1초 미만의 거부된 event는 `log.gated`를 저장하지 않고, flush는 그 정확한 합을 저장한다. | both |
| `log.policy.producer-builds-nothing-for-a-closed-gate` | 인자를 직렬화하는 host의 생산자는 class와 level의 gate가 닫혀 있으면 field를 만들지 않는다. | both |
| `log.policy.closed-gate-costs-a-branch` | 닫힌 gate의 질문은 열린 gate의 enqueue보다 훨씬 싸고 넉넉한 한도 안에 머물며, 수치를 출력한다. | both |
| `log.retention.removes-the-oldest-runs-over-the-bound` | `logs/`의 실행들의 파일이 상한을 넘으면 writer는 실행을 통째로, 가장 새로운 파일이 가장 오래된 실행부터 지우고, 파일을 지우는 각 회차는 `files`, `bytes`, `runs`, `from_us`, `to_us`, `remaining`, `bound`를 담은 `log.pruned` 하나다. | both |
| `log.retention.keeps-a-pinned-run-and-the-current-run` | writer의 실행과 `<role>-<boot>.keep` 파일이 있는 실행은 지우지 않으며, 파일이 상한을 넘은 채로 두는 회차는 level `warn`의 `log.pruned`를 저장한다. | both |
| `log.retention.stores-nothing-under-the-bound` | 상한 안의 파일은 지우지 않고 event도 저장하지 않는다. | both |
| `log.retention.runs-after-a-rotation` | writer의 회전은 보존을 다시 실행한다. | both |
| `log.retention.requires-a-bound` | 양의 보존 상한 없이 시작한 writer는 옵션 이름을 담은 오류로 시작에 실패한다. | both |
| `log.record.error-and-info-are-events` | level이 `error`나 `info`인 host 기록과 page가 보고한 기록은 호출한 시각과 줄바꿈을 포함한 원문 그대로의 `text`를 가진 event `<layer>.record.<level>`로 event log에 저장된다. | both |
| `log.record.start-buffer-holds-records-until-the-writer-exists` | host의 writer가 생기기 전에 쓴 기록은 시작 buffer에서 기다리고, writer는 그 기록을 쓴 시각 그대로 순서대로 받는다. | both |
| `log.record.start-buffer-counts-its-loss` | 시작 buffer는 1024개를 담고 그 너머의 기록은 거부하며, writer는 거부한 기록을 그 수와 함께 `log.dropped`로 기록한다. | both |
| `log.plugin-catalog.classifies-plugin-events` | writer는 plugin event를 plugin class가 주는 class로, 어느 catalog도 선언하지 않은 event를 `undeclared`로 저장한다. | both |
| `log.plugin-catalog.reads-the-enabled-plugins` | plugin class는 활성화된 설치 plugin의 catalog가 선언한 class이며, 비활성 plugin은 아무것도 더하지 않는다. | both |
| `log.plugin-catalog.refuses-a-catalog` | 없거나 JSON이 아니거나 `plugin.<plugin>.` 밖의 이름이나 모르는 class를 선언한 catalog는 plugin id 순서로 그 파일을 밝히는 오류이고, 다른 plugin은 class를 유지한다. | both |
| `log.plugin-catalog.host-applies-the-installed-catalogs` | host는 설치된 catalog의 class를 writer에 주고, 쓸 수 없는 catalog를 장소 `plugin catalog`의 오류 기록으로 남긴다. | both |
| `bounds.producer.fields-are-cut-while-serialized` | host event의 fields는 1,048,576바이트까지만 직렬화한다. 상한을 넘는 값은 `fields` `{"head": <첫 4,096바이트>}`와 상한을 막 넘은 `truncated`(직렬화가 멈출 때까지 쓴 바이트 수)로 저장하고, 상한에 들어가는 fields는 그 JSON으로 저장한다. | both |
| `bounds.producer.record-text-is-cut` | host record의 `text`는 최대 8,192바이트, `where`는 최대 1,024바이트이며 각각 문자 경계에서 자르고, 둘 중 하나라도 잘렸으면 fields에 `truncated: true`가 있다. | both |
| `bounds.start-buffer.holds-at-most-four-mebibytes` | record의 시작 buffer는 record 1,024개 외에 최대 4,194,304바이트를 담고, writer는 거절한 record와 그 바이트를 `log.dropped`로 센다. | both |
| `bounds.endpoint.topic-changes-hold-at-most-256` | topic 하나의 구독 변경 256개가 page를 기다리면 다음 변경은 적용하지 않고, 오류 코드 `-32000`과 topic과 256을 말하는 메시지로 답하며, buffer `endpoint topic changes`와 이유 `the buffer holds 256 messages`를 가진 `host.buffer.dropped`로 저장한다. | both |
| `bounds.endpoint.output-queue-holds-at-most-sixteen-mebibytes` | 연결의 출력 큐가 16,777,216바이트를 넘게 담게 하는 frame은 거절하고, buffer `endpoint output queue`와 이유 `the buffer holds 16777216 bytes`를 가진 `host.buffer.dropped`로 저장하며, 연결을 닫는다. | wailsv3 only: Wails host는 연결의 frame을 writer goroutine이 비우는 큐로 보내지만, Tauri host는 연결을 쥔 채 각 frame을 소켓에 쓴다 |
| `log.record.flush-stores-the-records-written-so-far` | 기록 flush는 지금까지 쓴 기록이 event log에 들어갈 때까지 기다리고, 붙은 writer가 없으면 곧바로 돌아온다. | both |
| `log.batch.stores-page-events-in-order` | `log` 중계는 `batch` 요청의 event를 page가 준 `ts_us`와 writer의 `seq`로, 순서대로, 계층 `page`에 저장한다. | both |
| `log.batch.rejects-an-invalid-batch-without-writing` | `log` 중계는 `batch`나 `clock`이 아닌 action, 배열이 아닌 `events`, `page.`와 `plugin.` 어느 쪽으로도 시작하지 않는 event 이름, 계약에 없는 level, 양의 정수가 아닌 `ts_us`나 `mono_ns`, 따옴표·역슬래시·제어 문자 없는 비어 있지 않은 문자열의 배열이 아닌 `cids`, 객체가 아닌 `fields`에 대해 배치 전체를 거부하고 그 배치는 아무것도 쓰지 않으며, 오류는 `events[<index>]`를 가리킨다. | both |
| `log.batch.returns-the-transcript-lines-of-page-records` | `log` 중계는 배치의 page 기록(문자열 field `where`와 `text`를 가진 `page.record.<level>`)의 줄 `<level> page <where>: <text>`을 돌려주며 host는 그것을 창의 transcript에 보이고, 그 문자열 field가 아닌 page 기록은 거부한다. | both |
| `log.batch.stores-plugin-events-in-the-layer-plugin` | `log` 중계는 이름이 `plugin.`으로 시작하는 event를 계층 `plugin`에, `page.`로 시작하는 event를 계층 `page`에, 각각 page가 준 시각과 writer의 `seq`로 저장한다. | both |
| `log.batch.stores-clock-and-cids-of-page-events` | `log` 중계는 page가 준 `ts_us`, `mono_ns`와, event에 있으면 `cids`를 저장하고, `cids`가 없는 event에는 `cids`가 없다. | both |
| `log.batch.answers-the-clock-request` | `log` 중계는 `{action: "clock"}`에 host가 호출 시점에 읽은 `ts_us`와 `mono_ns`로 답하고 event를 저장하지 않는다. 두 번째 답은 어느 clock에서도 첫 번째 답보다 작지 않다. | both |
| `startup.failure.exits-with-its-message` | setup 단계의 실패는 그 메시지를 쓰고, 실패를 event loop에 돌려주지 않고 상태 1로 프로세스를 끝낸다. 돌려주면 프로세스가 abort된다. | both |
