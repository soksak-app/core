# 호스트 계약 사례

[English](host-contract.md)

Wails 호스트(Go), Tauri 호스트(Rust), mygo 호스트(Go)는 하나의 호스트 계약을 구현한다([네이티브 호스트](hosts.ko.md)). 이 문서는 호스트들이 실행해야 하는 계약 사례를 나열해, 한 호스트에서 검사한 동작을 다른 호스트에서도 검사하게 한다.

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

테스트 함수 하나는 쉼표로 나눈 여러 사례를 선언할 수 있다. 열다섯 개 선언 경로에서 선택된 테스트 함수는 사례를 하나 이상 선언한다: `packages/host/go/tests/`, `packages/host/go/src/*_test.go`, `packages/host/wailsv3/tests/`, `packages/host/wailsv3/src/*_test.go`, `packages/host/mygo/tests/`, `packages/host/mygo/src/*_test.go`, `packages/host/mygo/benchmark/`, `packages/sok/go/tests/`, `packages/sok/go/src/*_test.go`, `packages/host/rust/tests/`, `packages/host/rust/src/`, `packages/host/tauriv2/tests/`, `packages/host/tauriv2/src/`, `packages/sok/rust/tests/`, `packages/sok/rust/src/`. 테스트는 단언이 사례의 결과를 확인할 때만 그 사례를 선언한다. Go 선언 inventory는 현재 `GOOS`와 `GOARCH`에서 host-contract의 각 설정에 대해 `go list`가 선택한 `_test.go` 파일의 합집합이다. 모든 설정에서 제외된 파일은 이 platform의 host-contract inventory에 포함하지 않는다. 공유 계약 텍스트는 어느 패키지도 소유하지 않는 `docs/spec/cases`에 있다(manifest 사례표와 log-contract fixture). 테스트는 거기서 읽고, `make check-boundaries`는 핵심 패키지의 테스트가 다른 핵심 패키지의 경로를 읽는 것을 거부한다.

## 검사

`make test-hosts`는 명령 감독자로 각 호스트의 테스트를 기본 구성과 진단 구성(Go 태그 `diagnostics`, Rust 기능 `diagnostics`)에서 실행하고 보고된 결과를 읽는다. mygo 호스트의 실행은 각 태그 집합에 `mygo` 태그를 더한다. `packages/host/go`와 `packages/host/mygo`는 `mygo`와 `diagnostics mygo`로, `packages/sok/go`는 `mygo`, `diagnostics mygo`, `diagnostics dev mygo`로 실행한다. 다음 경우에 실패한다.

- 호스트 범위의 사례에 그 호스트의 통과한 테스트가 없다.
- 선언한 테스트가 어느 구성에서도 실행되지 않았거나, 한 구성에서 실패했거나 건너뛰었다.
- 테스트가 사례를 선언하지 않았거나, 정의되지 않은 사례나 호스트 범위 밖의 사례를 선언했다.
- 선언이 테스트 함수에 붙어 있지 않다.
- 호스트 실행이 테스트 0개를 보고했다.
- Rust 잎 이름(테스트 모듈 경로의 마지막 조각)이 한 실행에서 한 크레이트의 테스트 두 개에 나타난다. 어느 타깃에 있는지는 묻지 않으므로, 선언이 테스트 하나를 가리킨다.
- 선언의 속성 블록에 `#[test]`, `#[tokio::test]`, `#[cfg(feature = "...")]`, `#[cfg(not(feature = "..."))]` 이외의 속성이 있다. 블록은 선언과 `fn` 위아래로 이어지는 속성과 주석 줄이며, 실패 메시지는 파일, 줄, 속성을 밝힌다.

소유자 규칙: 선언된 테스트는 자기 소유자의 항목에서만 결과를 얻는다. Go 테스트의 소유자는 패키지 디렉터리이고, Rust 테스트의 소유자는 크레이트 디렉터리(파일 위쪽에서 가장 가까운 `Cargo.toml`이 있는 폴더)다. 결과는 실행, 소유자, 테스트 이름으로 묶으며, 호스트의 결과가 sok 선언에 쓰이거나 그 반대가 되지 않는다. Rust 선언은 이름이 같은 잎 이름을 가진 테스트 하나와 일치한다.

범위 열은 `all`이거나, 이름을 든 호스트에만 있는 동작이면 `<host>[, <host>] only: <이유>`다. 검사의 호스트는 `wailsv3`, `tauriv2`, `mygo`이고, 각 호스트는 모든 `all` 사례를 실행하며, 범위는 이 호스트만 이름으로 든다. 호스트는 자기 contract run과 함께 이 목록에 들어간다. 그때부터 모든 `all` 사례가 그 호스트에도 세어지기 때문이다. language host library가 framework port 없이 구현하는 사례는 library의 test가 선언하고, 그 library를 link하는 범위 안의 각 호스트에 센다. 두 Go 호스트는 Go language host library와 Go `sok`의 test를 모두 실행하므로, 그런 test는 어느 Go 호스트의 사례든 선언할 수 있고, 그 사례의 호스트만 그것을 센다. 동작이 `Framework`나 `Frontend`를 거치는 사례는 범위 안의 각 framework adapter의 test가 선언한다([host tree](hosts.ko.md#호스트-트리)). Language host library가 선언하는 사례의 id는 호스트 이름으로 시작하지 않는다. 호스트는 범위가 이름으로 든다. 검사는 호스트들이 구현한 유일한 플랫폼인 macOS에서 실행한다. Windows와 Linux 진입점은 `not implemented` 오류를 반환하며 사례가 없다. 검사의 단위 테스트(`scripts/test/test-hosts.test.mjs`)는 각 실패를 주입하며 `pnpm test`에서 실행된다.

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
| app | settings | title | 설정… | Settings… | cmd+, |
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

`host.menu`는 `{language, menus}` 를 보고한다 — 활성 메뉴 언어와 구성된 메뉴다. 언어는 호스트 자신의 상태이지 제목에서 추측하는 값이 아니다. 호스트 사이 비교와 위 표 대조는 창 검사 계층에서 확인하고, `scripts/check-hosts-same.mjs`가 두 호스트의 메뉴 빌더가 이 표와 같은 표를 담고 있는지 검사한다.

## Contract cases

| 사례 | 동작 | 범위 |
| --- | --- | --- |
| `authorization.surface.cross-surface-rejected` | 한 표면의 호출자가 다른 표면에 대해 요청하면 거부한다. | all |
| `authorization.surface.own-surface-accepted` | 자기 표면에 대한 호출자의 요청을 받아들인다. | all |
| `authorization.surface.unscoped-caller-rejected-for-document` | 표면이 없는 호출자가 표면을 대상으로 한 문서 요청을 거부한다. | all |
| `authorization.main.known-main-caller-accepted` | 표면이 없고 id가 주 창의 id인 호출자는 표면 대상 요청이 허용된다. | all |
| `authorization.main.unknown-main-caller-rejected` | 표면이 없고 id가 주 창의 id가 아닌 호출자를 거부한다. | all |
| `clipboard.persist-png.writes-exact-bytes` | 올바른 PNG 페이로드를 저장하면 입력 바이트와 정확히 같은 파일의 경로를 반환한다. | all |
| `clipboard.persist-png.owner-only-mode` | 저장한 PNG 파일의 모드는 0600이다. | all |
| `clipboard.png.rejects-oversize` | 16 MiB보다 큰 PNG 페이로드를 거부한다. | all |
| `clipboard.png.rejects-empty` | 빈 PNG 페이로드를 거부한다. | all |
| `clipboard.png.accepts-valid-within-bound` | 한도 안에서 PNG 서명과 올바른 `IHDR` 청크로 시작하는 페이로드를 받아들인다. | all |
| `clipboard.png.rejects-bad-signature` | 8바이트 PNG 서명으로 시작하지 않는 페이로드를 PNG 서명을 적은 오류로 거부한다. | all |
| `clipboard.png.rejects-bad-header` | 첫 청크가 CRC가 맞고, 너비와 높이가 0이 아니며, PNG가 허용하는 비트 깊이와 색 형식 조합이고, 압축과 필터 방식이 0이며, 인터레이스 방식이 0 또는 1인 13바이트 `IHDR` 청크가 아닌 페이로드를 PNG 헤더를 적은 오류로 거부한다. | all |
| `clipboard.read.requires-user-initiated` | 사용자의 명시적 붙여넣기가 아닌 클립보드 읽기를 거부한다. | all |
| `clipboard.read.rejects-unknown-type` | 사용자가 시작했더라도 알 수 없는 형식의 클립보드 읽기를 거부한다. | all |
| `clipboard.read.accepts-known-types` | 사용자가 시작한 텍스트와 파일 URL 읽기를 받아들인다. | all |
| `clipboard.view.read-png-puts-binary` | view를 위한 PNG 읽기는 클립보드의 PNG를 `image/png`로 view의 binary store에 put하고 put의 id와 함께 `{present: true, type: "png", binary}`로 답한다. PNG가 없는 클립보드는 `{present: false, type: "png"}`로 답하고 아무것도 put하지 않는다. | all |
| `clipboard.view.persist-png-takes-binary` | view의 PNG 저장은 view의 binary store에서 binary id의 byte를 take해 클립보드 PNG로 저장한다. 저장되지 않은 id는 native take 오류로 실패한다. | all |
| `deep-link.parse.accepts-core-and-plugin-owners` | `soksak://core/<command>`와 `soksak://<plugin>/<command>`는 owner, command 이름 `<owner>.<command>`, 쿼리의 매개변수로 해석된다. | all |
| `deep-link.parse.decodes-percent-encoded-params` | 쿼리의 percent 인코딩된 이름과 값은 원래 텍스트로 디코딩되며, `+`는 공백으로 디코딩된다. | all |
| `deep-link.parse.rejects-other-scheme` | scheme이 `soksak`이 아닌 URL은 `scheme "<scheme>" is not soksak`으로 거부한다. | all |
| `deep-link.parse.rejects-missing-owner-or-command` | owner가 비었거나, command가 비었거나, command가 두 번째 조각을 가진 링크는 `owner is missing`, `command is missing`, `command has more than one segment`로 거부한다. | all |
| `deep-link.parse.rejects-empty-param-name` | 이름이 빈 쿼리 매개변수(예: `?=x`)는 `parameter name is empty`로 거부한다. | all |
| `deep-link.parse.rejects-bad-query` | 16진수 두 자리가 따르지 않는 percent 기호, 또는 되풀이된 매개변수 이름이 있는 쿼리는 `invalid percent-encoding` 또는 `parameter <name> is repeated`로 거부한다. | all |
| `deep-link.parse.rejects-long-url` | 8192자보다 긴 URL은 `URL is longer than 8192 characters`로 거부한다. | all |
| `deep-link.launch.kept-links-run-in-order-when-window-ready` | 첫 창이 준비되기 전에 도착한 링크는 준비되면 도착한 순서대로 실행하며, 그 전에는 어느 링크도 실행하지 않는다. | all |
| `deep-link.launch.later-link-runs-at-once` | 첫 창이 준비된 뒤 도착한 링크는 바로 실행하며, 두 번째 준비 알림은 보관한 링크를 다시 실행하지 않는다. | all |
| `window.responder.sent-at-ready-and-on-each-change` | 호스트는 창의 first responder를 워크벤치가 ready를 알릴 때와 그 뒤 바뀔 때마다 창 event `window-responder {owner, surface, document}`로 보내고, ready가 아닌 워크벤치에는 보내지 않으며, 바뀌지 않은 값은 한 번만 보내고, 읽기 실패를 돌려준다. | all |
| `window.responder.view-is-owner-surface` | host가 surface의 document `""`로 등록하는 view surface의 view에 first responder가 있으면 `{owner: "surface", surface, document: null}`로 보고한다. document region에 first responder가 있으면 `{owner: "document", surface, document}`다. | all |
| `window.responder.closed-window-sends-nothing` | close가 window를 지운 뒤 그 window에 닿은 first responder 변경은 받을 워크벤치가 없으므로 `window-responder` event를 보내지 않고 오류도 저장하지 않는다. window가 열려 있는 동안 실패한 responder 읽기는 오류로 보고한다. | all |
| `window.frames.counts-frames-and-reports-settled` | 창의 frame 기록은 각 frame과 commit된 각 command buffer를 세고, 마지막 frame 뒤 창이 settled인지 보고하며, `settled`가 바뀔 때와 창을 settled로 두는 각 frame 뒤에 `host.window` watcher에게 알린다. watcher 없는 frame은 할당하지 않는다. | mygo only: frame을 보고하는 framework는 mygo뿐이다([framework 변경](hosts.ko.md#framework-변경)의 U7) |
| `window.frames.records-reach-the-class-frame` | 각 frame 보고는 class `frame`의 event `host.frame.record`이고, frame 밖의 각 commit은 event `host.frame.commit`이다. | mygo only: frame을 보고하는 framework는 mygo뿐이다([framework 변경](hosts.ko.md#framework-변경)의 U7) |
| `window.frames.steps-reach-the-class-frame` | framework가 보고한 main thread의 각 step은 event log의 이름을 가진 class `frame`의 event `host.frame.step`이고, focus된 창이 없는 step은 하나뿐인 열린 창에 속한다. | mygo only: main thread의 step을 보고하는 framework는 mygo뿐이다(host tree의 행 P10) |
| `window.frames.step-recording-follows-the-policy` | step 기록은 class `frame`의 저장 level이 step을 저장하면 시작하고 저장하지 않으면 멈추며, 손실은 host에 닿고, step이 없는 framework는 아무것도 기록하지 않고, 기록은 stop이 돌아오면 끝난다. | mygo only: main thread의 step을 보고하는 framework는 mygo뿐이다(host tree의 행 P10) |
| `window.frames.step-listener-hears-without-the-policy` | listener는 끝날 때까지 어떤 policy에서도 각 step을 듣고, 그 끝은 기록을 비우며, step을 저장하는 policy에서는 기록이 listener 없이 이어진다. | mygo only: main thread의 step을 보고하는 framework는 mygo뿐이다(host tree의 행 P10) |
| `window.frames.native-views-of-the-last-placement` | 창의 frames는 마지막 placement의 native view element 수를 가진다. | mygo only: frames로 native view element를 놓는 창은 mygo framework의 창뿐이다(host tree의 행 H46) |
| `window.responder.outside-the-web-views-follows-the-main-page` | main page 없는 창에서 모든 web view와 surface host 밖의 first responder는 owner workbench이고, surface의 native view는 그 surface와 함께 owner native로 남으며, main page가 있는 창에서 web view 밖의 view는 native view다. | wailsv3, mygo only: Go language host library는 fixture framework로 시험하고, Rust language host library에는 main page 없는 framework가 없다 |
| `window.page-process.null-without-a-main-page` | `host.window`는 `pageProcess`를 정수 또는 `null`로 선언하고, main page 없는 창에는 `null`을 보고하며 sampler는 그 page를 읽지 않는다. main page가 있는 창은 그 page의 process를 보고하고, 시작 전에는 0을 보고한다. | wailsv3, mygo only: Go language host library는 fixture framework로 시험하고, Rust language host library에는 main page 없는 framework가 없다 |
| `window.facts.modal-order-is-above-every-webview` | `host.window`은 열린 modal의 `order`를 창의 native surface 수와 web view 수의 합으로 보고한다. native surface의 order와 web view의 order는 두 목록의 index이고 modal은 둘 위에 붙으므로, 이 값은 모든 native surface, 모든 web view와 document region의 `order`보다 크다. | all |
| `window.facts.document-reports-its-blur` | `host.window`은 dialog 배경의 native blur filter를 가진 각 document web view(view 표면의 page와 document region)에 `blurred: true`를, filter가 없는 것에 `blurred: false`를 보고한다. | all |
| `window.facts.region-reports-its-blur` | `host.window`의 각 image region 항목은 region이 dialog 배경의 native blur filter를 가진 동안 `blurred: true`를, filter가 없는 동안 `blurred: false`를 보고한다. | all |
| `window.facts.activation-observation-is-the-native-object` | `host.window`는 `activationObservation`을 native window facts가 준 그대로 보고한다. `registered`는 boolean이고 `count`는 `"18446744073709551615"`를 포함한 canonical unsigned 64-bit 10진 문자열이다. | all |
| `window.facts.activation-observation-refuses-invalid-native-evidence` | `activationObservation`이 없거나, `registered`가 boolean이 아니거나, `count`가 canonical unsigned 64-bit 10진 문자열이 아니면(숫자, 빈 문자열, 앞자리 0이나 부호, 소수, 18446744073709551615 초과) `host.window` 읽기는 `activationObservation`을 이름으로 밝힌 오류로 실패한다. | all |
| `window.facts.activation-observation-declares-its-schema` | `host.window` 선언은 `activationObservation`에 `registered` `{"type": "boolean"}`과 `count` `{"type": "string", "pattern": "^(0\|[1-9][0-9]*)$"}` property를 준다. | all |
| `links.open.accepts-web-and-mail-schemes` | 절대 `http`, `https`, `mailto` URL은 열기를 받아들인다. | all |
| `links.open.rejects-other-schemes` | 다른 스킴의 URL, 해석되지 않는 URL, 8192자보다 긴 URL은 거부한다. | all |
| `notifications.request.accepts-tab-notices` | 제어 문자 없이 1–256자인 표면과 제목, 1–1024자인 본문의 알림을 받아들이며, 제거에는 표면만 필요하다. | all |
| `notifications.request.rejects-invalid-fields` | 비었거나 너무 길거나 제어 문자가 있는 표면, 제목, 본문은 그 필드를 적은 오류로 거부한다. | all |
| `notifications.event.records-each-event-and-failure` | host가 해석하는 알림 센터의 사건마다 `type`, 상태의 `authorization`, 알림의 `window`와 `surface`를 가진 event `host.notification.event`가 있고, 실패(읽을 수 없거나 알 수 없는 종류의 사건, 창과 표면이 없는 알림, 닫힌 창, 알림 센터가 알린 실패)마다 장소 `notification`의 `error` 기록이 있다. Go 시험은 전체 경로를, Rust 시험은 이벤트를 읽는 부분까지를 다룬다. 창 조회에는 application handle이 필요하기 때문이다. | all |
| `diagnostics.input-reference.declared` | Diagnostic endpoint는 같은 window의 input reference method를 선언한다. | all |
| `diagnostics.input-reference.validates-document` | Input reference action은 wait-document와 wait에서만 빈 문자열을 포함한 document 문자열을 받으며 없거나 잘못된 값을 거부한다. | all |
| `diagnostics.input-reference.rejects-nul` | Native input reference adapter는 action이나 document의 NUL을 거부하고 오류로 한 번 완료한다. | all |
| `diagnostics.input-source.selects-a-role` | `diagnostics.input.source`는 role `latin`, `korean`, `japanese`가 아닌 `select`, `restore`와 함께 온 `select`, 빈 `restore`를 각각 invalid-params 오류로 거부한다. Role은 role 그대로 platform에 전달되며, 응답은 platform이 보고한 role을 `current`(role이 없는 input source는 null)로, 그 platform 식별자를 `source`로 담는다. | all |
| `endpoint.diagnostics-clock.real-jsonrpc-returns-monotonic-decimal` | diagnostics build에서 `{window}`을 담은 실제 endpoint JSON-RPC `diagnostics.clock` 요청은 host event-record clock의 `{mono_ns}`를 양수 canonical uint64 십진 문자열로 반환하고, 같은 연결의 두 번째 요청은 첫 값보다 작지 않은 값을 반환한다. | all |
| `endpoint.diagnostics-clock.absent-without-diagnostics` | diagnostics build 옵션이 없으면 endpoint는 `diagnostics.clock`을 선언하지 않으며 해당 요청의 연결을 닫는다. | all |
| `diagnostics.capture-stop.payload-reports-frame-limit` | 한도에 도달한 녹화의 중지 페이로드는 frames, count, limited true, 가장 긴 간격을 보고한다. | all |
| `diagnostics.capture-stop.payload-reports-callback-status` | 녹화 중지 페이로드는 녹화 폴더 안에 있는 bounded callback status 및 정확한 display time JSONL artifact의 경로를 보고한다. | all |
| `diagnostics.capture-stop.payload-reports-unbounded` | 한도에 도달하지 않은 녹화의 중지 페이로드는 limited false를 보고한다. | all |
| `diagnostics.capture-stop.payload-reports-layout-timeline` | 녹화 중지 페이로드는 기록된 layout transaction이 없어도 항상 `layouts` 배열을 보고한다. | all |
| `diagnostics.capture-stop.payload-preserves-layout-stages` | 각 `layouts` 항목은 기록된 ticket, begun, requested, presented, committed 값을 유지한다. | all |
| `diagnostics.capture-stop.payload-names-opt-in-frame-identity-artifact` | `frameIdentity: true`로 녹화를 시작하면 중지 페이로드는 상태가 `complete`이고 manifest 경로를 가진 `frameIdentity`를 보고한다. | all |
| `diagnostics.capture-start.preserves-display-option-parsing` | 선택적 `frameIdentity` 매개변수를 추가해도 기존 `display` 옵션 파싱은 바뀌지 않는다. | all |
| `diagnostics.capture-start.parses-frame-identity-option` | `diagnostics.capture.start`는 선택적 boolean `frameIdentity`를 받고 그 값을 recording capture에 전달한다. | all |
| `diagnostics.capture-start.frame-identity-is-strict-boolean` | JSON boolean이 아닌 `frameIdentity` 값은 `frameIdentity must be a boolean` 오류로 거부된다. | all |
| `diagnostics.capture-start.forwards-frame-identity` | recording 시작은 요청된 `frameIdentity` 값을 native capture 시작에 전달한다. | all |
| `diagnostics.document.viewport-marker.is-declared` | 진단 build는 `diagnostics.document.viewport-marker`를 선언한다. | all |
| `diagnostics.document.viewport-marker.requires-valid-parameters` | viewport-marker command는 비어 있지 않은 `surface`, `document` 문자열과 boolean `enabled`를 요구하며, 없거나 비어 있거나 null이거나 타입이 다른 값은 native 작업 전에 거부한다. | all |
| `diagnostics.document.viewport-marker.uses-the-owning-window-document` | command는 요청한 surface와 window에 속한 연결 document만 찾는다. 해당 document 없이 시작하면 native 작업 전에 실패하고, 제거 뒤 중지는 idempotent하다. | all |
| `diagnostics.document.viewport-marker.schedules-native-work-and-returns-native-result` | command는 UI dispatcher를 통해 marker 작업을 실행하고 native enabled 상태, kind, color, border width를 그대로 반환한다. | all |
| `diagnostics.document.viewport-marker.reports-native-errors` | native marker 실패는 원래 text와 internal-error code로 반환하며 성공으로 보고하지 않는다. | all |
| `diagnostics.capture.document-identity.start.is-declared` | 진단 build는 `diagnostics.capture.document-identity.start`를 선언한다. | all |
| `diagnostics.window.draw-covered.is-declared` | 진단 build는 `diagnostics.window.draw-covered`를 선언한다. | all |
| `diagnostics.capture-document-identity.stop-preserves-captures-without-a-document-source` | 선택된 document identity source가 없는 중지는 source freeze와 제거를 건너뛰고 capture를 한 번 중지하며 `frameIdentity` option의 두 값을 모두 보존한다. | all |
| `diagnostics.capture-document-identity.stop-orders-freeze-capture-and-cleanup` | 선택된 source가 있으면 중지는 source를 freeze하고 capture를 중지한 뒤 같은 generation을 제거한다. `issuedSlots`는 성공한 freeze reply에서 온다. | all |
| `diagnostics.capture-document-identity.stop-does-not-credit-unconfirmed-freeze` | source freeze에 실패하면 issued-slot count를 더하지 않지만 capture finalization과 source 제거는 계속 시도하고 오류를 보존한다. | all |
| `diagnostics.capture-document-identity.stop-drains-late-start-before-cleanup` | 중지는 cleanup 전에 대기 중인 source start가 끝나기를 기다리며, timeout된 start가 확인하지 않은 issued count는 반영하지 않는다. | all |
| `diagnostics.capture-document-identity.start-validates-current-root-generation` | source 시작은 요청된 surface와 generation의 현재 연결된 root document만 찾고, 교체되거나 종료된 generation은 거부한다. | all |
| `diagnostics.capture-document-identity.start-rejects-invalid-parameters` | source 시작은 document source를 선택하기 전에 없거나 비어 있거나 안전하지 않은 surface와 generation 값을 거부한다. | all |
| `diagnostics.capture-document-identity.start-validates-native-metadata` | source 시작은 현재 generation과 측정된 유효 ROI를 가리키는 native metadata를 요구하며, 없거나 일치하지 않는 metadata는 거부한다. | all |
| `diagnostics.capture-document-identity.stop-requires-issued-slots-field` | source-freeze reply에는 `issuedSlots`가 있어야 하며 0은 유효하고 필드 누락은 오류다. | all |
| `diagnostics.capture-document-identity.start-selects-one-source-per-capture` | capture 하나는 document identity source를 최대 하나 선택하며 두 번째 source는 거부한다. | all |
| `diagnostics.capture-document-identity.start-requires-explicit-capture-endpoint` | document identity source는 명시적인 capture endpoint가 필요하며 drag operation이 소유한 identity capture에는 연결할 수 없다. | all |
| `diagnostics.capture-start.waits-for-prior-identity-removal` | 새 capture 시작은 이전에 선택한 document identity source 제거가 완료될 때까지 기다린다. | all |
| `diagnostics.capture-document-identity.callback-completion-is-single-use` | 첫 callback이 document identity 결과를 제공하며 추가 호출은 오류를 보고하고 완료된 결과를 대체하지 않는다. | wailsv3, mygo only: Go callback closure는 반복 호출이 가능하며 Rust FnOnce callback은 이를 정적으로 막는다 |
| `diagnostics.capture-document-identity.schedule-error-preserves-callback-error` | 동기 callback이 오류를 보고한 뒤 scheduling도 실패하면 반환 오류는 두 오류를 보존한다. 성공 callback이 scheduling 실패를 대체하지 않는다. | all |
| `diagnostics.capture-stop.bounds-identity-callback-wait` | document identity callback 대기는 제한되어 있으며 callback이 오지 않으면 명시적인 timeout 오류를 반환한다. | all |
| `diagnostics.capture-document-identity.reports-late-callback-errors` | 늦은 document identity callback 오류는 error level로 기록하고 현재 source 결과를 대체하지 않는다. | all |
| `diagnostics.capture-document-identity.cleanup-source-survives-recording-stop` | recording 중지는 선택된 identity source의 native 제거가 완료될 때까지 소유권을 유지하며, recording finalization 오류 뒤에도 마찬가지다. | all |
| `diagnostics.capture-start.rejects-unconfirmed-identity-cleanup` | 이전 source 제거가 확인되지 않은 동안 새 identity capture를 거부한다. | all |
| `diagnostics.capture.poisoned-lifecycle-lock-is-reported` | poisoned document-identity lifecycle lock은 보호 작업 실행 전에 명시적인 interruption 오류를 반환한다. | tauriv2 only: Rust `Mutex` poisoning은 Rust 전용 synchronization 상태다 |
| `diagnostics.capture.poisoned-pending-lock-is-reported` | poisoned pending-start lock은 명시적인 interruption 오류를 반환하고 저장된 receiver를 유지한다. | tauriv2 only: Rust `Mutex` poisoning은 Rust 전용 synchronization 상태다 |
| `diagnostics.capture.pending-start-probe-does-not-reenter-lock` | pending-start probe는 receive helper가 다시 lock을 얻기 전에 기존 lock을 놓아 ready receiver가 deadlock을 일으키지 않는다. | tauriv2 only: pending receiver helper와 `Mutex`는 Rust 전용이다 |
| `diagnostics.drag.forwards-frame-identity` | `diagnostics.drag`는 선택적 strict boolean `frameIdentity`를 받고 기본값은 false다. Identity를 켜면 `capture: true`를 요구하고 recording 시작에 전달한다. | all |
| `diagnostics.drag.native-delivers-pointer-gesture` | `diagnostics.drag`는 선택적 strict boolean `native`를 받고, 다른 값은 `native must be a boolean`으로 거절하며 workbench에 전달하지 않는다. `native: true`이면 경계 점을 읽기 전과 매 누름 전에 창이 현재 layout을 표시할 때까지 기다리고, 왕복마다 경계 점에서 주 버튼을 누르고, 각 단계를 그 점에 offset과 단계 비율을 곱한 값을 더한 위치의 끌기로 나갔다가 돌아오며, 경계에서 떼고, 어느 입력도 활성화하지 않으며, 누름 전 대기를 뺀 `took`과 함께 `{from, steps, took, asked, pressWaits}`로 응답한다. 대기가 실패하면 그 누름 전에 `native drag wait before the press of round trip <n>: <error>`로 실패하고, 실패한 단계는 그 위치에서 버튼을 떼고 `native drag step <n>: <error>`로 실패한다. | all |
| `diagnostics.drag.native-reads-boundary-after-presentation` | native drag는 창이 현재 layout을 표시할 때까지 기다린 뒤 page에 경계의 점을 묻고, 표시하지 못한 창은 그 실패로 drag를 끝내며 묻지 않는다. | all |
| `diagnostics.drag.no-main-page-delivers-native` | main page 없는 창에서 `diagnostics.drag`는 `native`와 무관하게 제스처를 네이티브 포인터 입력으로 전달한다. 제스처 전에 workbench에 `diagnostics.drag` `{axis, line}`를, 제스처 뒤에는 실패한 제스처 뒤에도 `diagnostics.drag.end`를 요청하고, 네이티브 제스처의 응답에 workbench가 준 `boundary`(드래그 전과 각 단계 뒤의 위치)와 `handled`(각 drag 입력의 `mouseDragged:` step이 들어가서 돌아올 때까지의 밀리초)를 더한다. callback이나 위치의 수가 전달한 단계 수와 다른 드래그는 `the drag delivered <n> steps and recorded <n> callbacks and <n> boundary positions`로 실패한다. | mygo only: Wails와 Tauri host는 main page에서 드래그를 구동한다 |
| `diagnostics.native-objects.payload-names-counts` | `diagnostics.native.objects` 응답은 라이브러리의 살아 있는 객체 수를 `windowCompositions`, `surfaceHosts`, `inputRegistrations` 정수로만 담는다. | all |
| `diagnostics.native-window-color-space.reports-appkit-profile` | `diagnostics.native.window-color-space`는 선택한 window를 한 번 읽어 `name`과 `iccSHA256`만 반환한다. `name`은 AppKit color space의 localized name이고 hash는 ICC profile byte의 lowercase SHA-256이며 ICC profile을 사용할 수 없으면 null이다. Window에 backing color space가 없으면 두 값 모두 null이다. 이 method는 diagnostic build에서만 선언되고 window를 변경하지 않는다. 비활성 window check는 OS가 선택한 profile을 고정하지 않고 응답 형식을 정확히 확인하며, 존재하지 않는 window에 error 1003을 요구하고, query 전후의 안정된 `host.window` facts를 비교한다. | all |
| `diagnostics.native-objects.equal-validates` | `diagnostics.native.objects`는 `equal`을 정확히 `windowCompositions`, `surfaceHosts`, `inputRegistrations`를 음이 아닌 정수로 담은 객체로만 받고, 다른 값은 `equal must be an object of windowCompositions, surfaceHosts and inputRegistrations, each a non-negative integer`로 거부한다. `equal`에 이르지 않은 수는 `window object counts did not reach <equal> within 10s; they are <counts>`로 실패하며, 각 수는 `windowCompositions N, surfaceHosts N, inputRegistrations N`으로 쓴다. | all |
| `diagnostics.process-exit.pid-validates` | `diagnostics.process.exit`는 `pid`를 1부터 2147483647 사이의 정수로만 받고, 없거나 다른 값은 `pid must be a positive integer`로 거부한다. | all |
| `diagnostics.memory-pressure.level-validates` | `diagnostics.memory.pressure`는 `level`을 `normal`, `warn`, `critical`로만 받고, 없거나 다른 값은 `level must be normal, warn or critical`로 거부한다. | all |
| `diagnostics.test-mark.params-validate` | `diagnostics.test.mark`는 `kind` `start` 또는 `end`, 빈 문자열이 아닌 `name`과 `run`, `end`에는 `pass`, `fail`, `skip` 중 하나인 `result`(`start`에는 거부)만 받고, 그 밖의 값은 invalid-params 오류 `kind must be start or end`, `name must be a non-empty string`, `run must be a non-empty string`, `result must be pass, fail or skip`, `result is only for an end mark`로 거부한다. | all |
| `diagnostics.test-mark.event-carries-position` | 시작 표시는 event `host.test.start`(`name`, `run`), 끝 표시는 `host.test.end`(`name`, `run`, `result`)이며 layer `host`, level `info`다. 답은 flush 뒤에 읽은 event 파일의 `boot`와 그 줄의 `seq`다. | all |
| `diagnostics.stall-dump.params-validate` | `diagnostics.stall.dump`는 존재하는 파일의 절대 경로만 받고, 그 밖의 값은 invalid-params 오류 `path must be a non-empty string`, `path must be absolute`, `path does not name a file: <path>`로 거부한다. | all |
| `diagnostics.stall-dump.event-carries-path` | 정지 dump는 layer `host`, level `warn`의 event `host.stall.dump`(`path`)이며, 답은 event 파일의 `boot`와 그 줄의 `seq`다. | all |
| `diagnostics.objects.counts-host-objects` | `diagnostics.objects`는 host가 창을 위해 가진 surface, region, document, sidecar session, 대기 중인 응답, event 구독자의 수를 돌려주고, 각 수는 그 객체가 제거되면 다시 준다. | all |
| `diagnostics.objects.reply-and-params` | `diagnostics.objects`는 `window`를 요구하고, 없는 창에는 세지 않고 오류 1003으로 답하며, 이름이 주어진 창에 대해 diagnostic backend가 센 수로 `{host, page, documents, sessions}`를 답하고 `documents`는 surface와 document 순서로 둔다. | all |
| `diagnostics.objects.sidecar-sessions-agree` | `diagnostics.objects`는 창의 sidecar session을 sidecar와 surface 순서의 `{sidecar, surface}`로 담은 `sessions`를 돌려주고, surface는 그것이 보낸 적이 있는 사이드카의 session일 뿐이다: page를 다시 불러와도 host는 사이드카에 아무 메시지도 보내지 않으므로, 두 host는 같은 project에 대해 같은 session을 나열한다. | all |
| `diagnostics.objects.runtime-memory` | `diagnostics.objects`는 Go runtime의 수치 여덟 개를 가진 `runtime`을 돌려준다: heap 객체, 쓰이지 않는 heap, free heap, released heap, stack, 그 밖의 metadata의 byte 수, heap goal, goroutine 수다. | wailsv3, mygo only: Tauri host에는 garbage collection runtime이 없다 |
| `diagnostics.heap-profile.writes-a-profile` | `diagnostics.heap.profile`은 Go runtime의 heap profile(gzip으로 압축한 protocol buffer)을 진단 폴더의 `heap-<pid>-<ms>.pprof`에 쓰고 그 경로로 답한다. | wailsv3, mygo only: Tauri host에는 garbage collection heap이 없다 |
| `diagnostics.cpu-profile.profiles-until-stopped` | `diagnostics.cpu.profile` `{on: true}`는 Go runtime의 CPU profile을 진단 폴더의 `cpu-<pid>-<ms>.pprof`에 쓰기 시작하고, 도는 중에 다시 시작하면 실패한다. `{on: false}`는 멈추고 그 파일(gzip으로 압축한 protocol buffer)의 경로로 답하며, 도는 profile이 없을 때 멈추면 `null`로 답한다. `on`이 없는 요청은 invalid params로 실패한다. | wailsv3, mygo only: `sample`이 Rust host의 frame을 읽는다 |
| `diagnostics.gc-loop.collects-until-stopped` | `diagnostics.gc.loop` `{on: true}`는 `runtime.GC`를 쉬지 않고 도는 goroutine을 시작하고, `{on: false}`는 그 goroutine을 멈추고 반환한 뒤 답하므로 그 답 뒤에 collection이 시작되지 않는다. 두 번째 시작은 goroutine을 더 만들지 않고, loop가 꺼져 있을 때의 정지는 `null`로 답하며, `on`이 없는 요청은 거절한다. | wailsv3, mygo only: Tauri host에는 garbage collection heap이 없다 |
| `diagnostics.objects.counts-documents` | `diagnostics.objects`는 창의 각 document region의 요소 수와 문서 수를, main page가 있는 창이면 그 main page의 것까지 돌려준다. | all |
| `diagnostics.objects.page-is-null-without-a-main-page` | main page 없는 창의 `diagnostics.objects`는 host의 객체를 세고 `page`를 `null`로 답한다. | wailsv3, mygo only: Go language host library는 fixture framework로 시험하고, Rust language host library에는 main page 없는 framework가 없다 |
| `diagnostics.objects.framework-counts-of-a-drawn-workbench` | host가 그리는 workbench의 `diagnostics.objects` 응답은 callback, node, native view 수를 담은 `framework`를 가지고, main page의 응답에는 `framework`가 없다. | mygo only: framework로 workbench를 그리는 host는 mygo뿐이다 |
| `diagnostics.main-page-methods.answer-no-main-page` | `diagnostics.page.request`, `diagnostics.page.calls`, `diagnostics.host.events`, `diagnostics.page.collect`는 main page에 작용하고, main page 없는 host는 창을 검사한 뒤 각각 오류 `the mygo host has no main page`로 답한다. | mygo only: Wails와 Tauri host에는 main page가 있다 |
| `diagnostics.modal-methods.answer-no-modal-web-views` | `diagnostics.modal.hold`와 `diagnostics.modal.held`는 modal web view에 작용한다. modal web view가 없는 host는 창을 검사한 뒤 각각 오류 `the mygo host has no modal web views`로 답하고, main page가 있는 framework는 method에 닿는다. | mygo only: Wails와 Tauri host는 modal을 web view에 보여 준다 |
| `diagnostics.crash.report-is-announced-once` | crash report 폴더에 있는 애플리케이션의 crash report는 level `warn`의 event `host.crash.found`(`path`, `pid`, header의 `time`)이다. 두 번째 lookup은 아무것도 알리지 않고, 나중에 생긴 report는 다음 lookup만 알린다. | all |
| `diagnostics.crash.report-belongs-to-the-application` | 파일 이름이 다른 이름으로 시작하거나, header가 다른 애플리케이션(애플리케이션 이름으로 시작하는 이름 포함)을 가리키거나, 확장자가 `.ips`가 아닌 report는 알리지 않는다. | all |
| `diagnostics.crash.lookup-is-bounded` | lookup 한 번은 파일 이름 기준으로 애플리케이션의 최신 report 64개만 알리고 그보다 오래된 것은 알리지 않는다. | all |
| `diagnostics.crash.unreadable-report-is-an-error` | header나 body를 읽을 수 없거나 body에 `pid`가 없는 report는 파일과 원인을 밝힌 오류이며, ledger에 올라 다시 보고하지 않고 event를 만들지 않는다. | all |
| `diagnostics.crash.missing-folder-has-no-reports` | 없는 crash report 폴더는 report가 없는 것이다. 오류도 event도 없다. | all |
| `diagnostics.crash.folder-that-cannot-be-read-is-an-error` | 나열할 수 없는 crash report 경로는 그 경로를 밝힌 오류다. | all |
| `diagnostics.crash.folder-is-named-by-the-platform` | platform은 crash report 폴더를 `Library/Logs/DiagnosticReports`로 끝나는 절대 경로로 알린다. | all |
| `diagnostics.stderr.leaves-out-asset-request-lines` | host가 프레임워크 logger에 준 level에서 logger는 asset server의 `Handling request` 줄을 쓰지 않고 warning과 error는 남긴다. | wailsv3 only: Tauri host는 그런 줄을 쓰지 않는다 |
| `endpoint.input.close-releases-presses` | Endpoint connection이 닫히면 그 connection의 `down`이 열고 어떤 `up`도 끝내지 않은 각 누름의 `up`을 그 누름이 마지막으로 전달된 입력의 점에서 전달하므로 다른 connection의 `down`이 전달된다. 1007로 거부된 뗌은 다음 `host.buttons` mask 0에서 전달한다. | all |
| `endpoint.status.ended-ends-a-watch` | Watch의 surface나 창이 닫히면 그 watch를 가진 각 connection은 앞선 `status.changed` 뒤에 `status.ended {window, name, surface?, reason}`를 한 번 받고 그 뒤 `status.changed`는 받지 않으며, page는 그 watch의 `status.unwatch`를 받지 않는다. | all |
| `endpoint.record.call-is-an-event` | endpoint client의 모든 요청(구독 변경도)은 성능 trace가 꺼져 있을 때도 layer `host`, level `debug`이고 `name`, `args`(받은 그대로의 params, 없으면 `null`), `micros`, `ok: true`, `truncated: false`를 가진 event `host.endpoint.call`이다. | all |
| `endpoint.record.failure-names-the-error` | 실패한 요청은 level `warn`이고 `ok: false`와 client가 받는 코드와 메시지인 `error` `<code>: <message>`를 가진 event `host.endpoint.call`이다. | all |
| `endpoint.record.arguments-are-cut-before-copying` | `args`는 문자 경계에서 자른 최대 1024바이트이고, params가 더 길면 event에 `truncated: true`가 있다. | all |
| `endpoint.response.follows-the-socket-write` | 요청이 응답 뒤에 등록한 작업은 응답이 queue 에 들어갈 때가 아니라 실제 쓰기와 flush 가 끝나고 연결 writer 잠금이 풀린 뒤 한 번 실행된다. 완료 뒤에 등록한 작업은 같은 결과로 바로 실행된다. | all |
| `endpoint.response.reports-its-outcome` | 응답의 완료는 응답 기록, 응답 없는 notification, 쓰기 실패, 답 포기를 구분해 알린다. 쓰기 실패, 거부된 frame, encode 할 수 없는 응답, 닫힌 연결은 응답을 쓴 것이 아니며 문맥의 복사본을 버려도 완료되지 않는다. | all |
| `endpoint.response.quit-follows-the-response` | 엔드포인트 요청의 네이티브 작업(`host.menu.select`, `host.dock.select`) 중에 시스템이 요청한 종료는 그 요청의 응답 뒤에 한 번 실행된다. 이런 작업 밖이거나 응답이 없는 요청이면 바로 실행된다. | all |
| `binding.record.call-is-an-event` | page의 모든 host 호출은 layer `host`, level `debug`이고 `name`(호출의 snake case 이름), `args`(호출 순서대로의 인자를 담은 JSON 배열, 없으면 `[]`), `micros`, `ok: true`, `truncated: false`를 가진 event `host.binding.call`이며, 성능 trace가 꺼져 있을 때도 그렇다. | all |
| `binding.record.failure-names-the-error` | 실패한 host 호출은 level `warn`이고 `ok: false`와 `error` `<code>: <text>`(page가 받는 글에 내부 code `-32603`을 붙인 것이다. host 메서드는 글만 가진 오류로 실패하기 때문이다)를 가진 event `host.binding.call`이다. | all |
| `binding.record.operation-identifiers-are-stored` | `cids`를 나르는 host 호출(`Bindings.Call`의 네 번째 인자, Tauri command의 payload key `cids`)은 그 `cids`를 가진 event `host.binding.call`이며 실패해도 그렇다. `cids`가 없는 호출은 없는 event를 저장하고, 식별자는 호출의 인자가 아니다. | all |
| `binding.record.invalid-identifiers-are-refused` | 빈 식별자이거나 따옴표, 역슬래시, 제어 문자가 든 식별자를 `cids`에 담은 호출은 그 식별자를 밝힌 오류로 거절된다. 메서드는 실행되지 않고, event는 `cids` 없이 `error`가 `-32603: <그 글>`인 실패한 `host.binding.call`이다. | all |
| `binding.record.arguments-are-cut-before-copying` | `args`는 최대 1024바이트이고 문자 경계에서 자르며, 인자가 더 길었으면 event에 `truncated: true`가 있다. | all |
| `binding.record.unfinished-call-names-the-error` | 결과 없이 끝난 host 호출은 level `warn`이고 `ok: false`와 `error` `-32603: the call ended without a result`를 가진 event `host.binding.call`이다. | all |
| `binding.reply.absent-value-is-null` | method가 값을 돌려주지 않거나 null 값을 돌려주는 host 호출은 page에 JSON 값 `null`을 응답한다; Wails transport가 nil 결과를 `{}`로 쓰므로 Wails entrance는 `null`로 encode되는 값을 돌려준다. | all |
| `binding.record.refusal-names-the-error` | host의 어떤 메서드도 가리키지 않는 호출이나 메서드가 받는 것과 다른 수의 인자를 넘기는 호출은 오류로 거절되고, 그 오류를 `-32603: <text>`로 가진 level `warn`의 event `host.binding.call`로 저장된다. | wailsv3 only: Wails는 host의 모든 메서드를 이름으로 찾는 바인딩 메서드 `Bindings.Call` 하나로 닿게 하지만, Tauri는 모르는 command와 거절된 인자를 host가 실행되기 전에 거절한다 |
| `binding.record.native-call-is-an-event` | native web view 문서의 호출은 같은 필드를 가진 event `host.binding.call`로 저장된다. | wailsv3 only: Wails page runtime은 surface page 호출을 native bridge로 보내지만, Tauri surface page는 main page의 command를 부른다 |
| `binding.record.every-host-method-is-callable` | host의 내보낸 모든 메서드는 입구를 통해 이름으로 닿고, 지원하지 않는 서명의 메서드는 그 메서드의 이름을 말하는 오류로 host 시작을 멈춘다. | wailsv3 only: Tauri는 `bindings!` 매크로가 정의한 command를 등록하므로 매크로 밖의 command는 등록에 들어가지 않는다 |
| `binding.record.unsupported-method-fails-at-start` | 매개변수가 선택적 context와 `json.RawMessage` 값이 아니거나 결과가 선택적 값과 선택적 오류가 아닌 내보낸 메서드는 입구의 생성을 그 메서드의 이름을 말하는 오류로 실패시킨다. | wailsv3 only: Tauri는 command를 reflection으로 읽지 않는다 |
| `diagnostics.test-mark.needs-the-event-log` | event log가 연결되지 않은 동안의 표시는 `the event log of the host is not attached`로 실패한다. | all |
| `documents.attach.one-main-step` | attach는 영역 확인, 이름 예약, 문서 생성과 등록을 main thread의 한 step에서 실행하므로, 표면 닫기나 page reload는 attach 전체의 앞이나 뒤에 실행된다. 실패한 attach는 오류 기록 없이 자기 이름과 request log만 되돌리고, 이름 없이 열린 문서는 남지 않는다. | all |
| `documents.request.accepts-own-surface` | 호출자 자신의 표면에 대한 문서 요청을 받아들이고 표면과 이름 키를 반환한다. | all |
| `documents.request.rejects-foreign-or-missing-caller` | 호출자 표면이 없거나 다른 표면에서 온 문서 요청은 "not surface"로 실패한다. | all |
| `documents.request.rejects-invalid-names` | 빈 이름, 대문자, 하이픈으로 시작, 슬래시 포함, 65자 문서 이름을 거부한다. | all |
| `documents.request.zoom-must-be-finite-positive` | 확대 값이 없거나 0 또는 음수인 문서 확대 요청은 거부하고, 유한한 양수는 배율이다. | all |
| `documents.query.reply-is-the-region-report` | 세 boolean으로 된 native의 질의 답 `{media, capture, form}`은 `documentQuery`의 보고다. 답 `{error}`는 오류 `document <name>: <error>`이고, 다른 값, 빠진 field, JSON이 아닌 글은 오류 `document <name> answered an invalid query reply: <reply>`다. | all |
| `documents.request.interaction-state-must-not-be-empty` | `interactionState`가 없는 문서 요청은 아무것도 복원하지 않고, 비어 있지 않은 `interactionState`는 `documentAttach`가 복원하는 상태이며, 빈 값은 `document interactionState must not be empty`로 거부한다. | all |
| `documents.request.entry-requires-offset` | `entry` 문서 `go` 요청은 0이 아닌 정수 `offset`이 필요하고, `offset`이 있는 다른 동작은 거부한다. | all |
| `documents.commit.precedes-messages` | 웹뷰가 문서 commit 뒤에 보낸 메시지는 그 commit 처리 뒤에 처리되고, 한 웹뷰의 commit은 순서대로 처리되며, 다른 웹뷰의 메시지는 기다리지 않는다. | wailsv3, mygo only: Go host는 WebKit의 commit과 script message를 메인 스레드에서 record를 쓰고 돌아가는 C callback으로 받고, 메인 스레드의 worker([hosts](hosts.ko.md#wails-host의-main-thread))가 각 record를 그 웹뷰의 고루틴에 넘기며, 그 고루틴은 그 웹뷰의 record를 순서대로 처리하고 다른 웹뷰를 기다리지 않지만, Tauri는 commit에서 표면의 문서 상태를 초기화하지 않는다 |
| `documents.request.ignores-placement-fields` | 문서 요청을 해석하면 표면과 문서만 남기고 배치 필드를 버린다. | all |
| `documents.request.url-and-action-default-empty` | url과 action이 없는 문서 요청을 해석하면 둘 다 비어 있다. | all |
| `documents.registry.rejects-duplicate-reservation` | 같은 문서 키를 두 번 예약하면 "already attached"로 실패한다. | all |
| `documents.registry.reserved-name-is-not-attached` | 설정 전의 예약된 문서 키를 읽으면 실패한다. | all |
| `documents.registry.set-attaches-reserved-name` | 예약된 문서 키를 설정하면 성공하고 읽으면 핸들을 반환한다. | all |
| `documents.registry.lists-names-by-handle` | 등록소는 각 문서 핸들을 그 키와 함께 나열한다. | all |
| `documents.registry.surface-close-removes-only-its-documents` | 표면을 제거하면 그 문서를 반환하고 키를 읽을 수 없게 하며 다른 표면의 문서는 유지한다. | all |
| `documents.registry.rejects-set-after-surface-removed` | 표면이 제거된 문서 키의 설정은 실패한다. | all |
| `documents.registry.remove-reserved-returns-empty` | 예약만 된 문서 이름을 제거하면 빈 핸들로 성공한다. | all |
| `documents.registry.remove-attached-returns-handle-once` | 연결된 문서 이름을 제거하면 핸들을 반환하고, 다시 제거하면 실패한다. | all |
| `documents.create.failure-closes-document` | 만든 document region의 구성 단계가 실패하거나, 만든 view의 구성 단계나 page load가 실패하면 native document는 오류가 반환되기 전에 닫히고, 이후 단계는 실행되지 않으며, 실패한 close는 그 실패와 함께 보고된다. | all |
| `document.stream.subscribe-rejects-unknown-stream` | `elements`나 `requests`가 아닌 stream의 구독은 `unknown document stream "<name>"`으로 실패한다. | all |
| `document.stream.unsubscribe-rejects-unknown-handle` | 문서가 가지지 않은 핸들을 끝내면 `document stream handle <handle> is not subscribed to document "<name>"`으로 실패한다. | all |
| `document.stream.first-on-last-off` | 영역의 첫 `elements` 구독은 요소 트리의 수집을 켜고, 다음 `elements` 구독은 다시 켜지 않으며, 마지막 구독을 제거하면 수집을 끈다. | all |
| `document.stream.attach-starts-request-collection` | 영역의 attach는 빈 요청 로그를 만들고 요청 수집을 켠다. 같은 영역의 두 번째 attach는 `document "<name>" already has a request log`로 실패하고, 요청 로그가 없는 영역의 `requests` 구독은 `document "<name>" has no request log`로 실패한다. | all |
| `document.stream.request-log-lives-with-the-region` | 영역의 요청 로그는 어느 page도 구독하지 않는 동안 도착한 항목을 담고, 모든 구독이 끝나도 항목과 `dropped`를 유지하므로, 나중의 `requests` 구독은 로그 전체를 먼저 받는다. | all |
| `document.stream.request-subscription-changes-no-collection` | `requests` 구독과 그 끝은 영역의 `elements` 구독이 남아 있는 동안에도 어떤 수집도 켜거나 끄지 않으므로, 로그는 각 항목을 한 번 담고 `dropped`는 로그가 버린 항목만 센다. | all |
| `document.stream.native-refusal-rejects-subscription` | native 계층이 stream 켜기를 거부하면 구독은 유지되지 않고 호출은 `document "<name>" does not accept stream "<stream>"`으로 실패한다. | all |
| `document.stream.page-load-removes-subscriptions` | 구독한 표면 페이지의 새 문서는 그 구독을 제거하고, stream마다 구독자 수는 0으로 돌아간다. | all |
| `document.stream.region-close-removes-subscriptions` | 문서 영역을 닫으면 그 구독을 제거하고, 구독자 수는 0으로 돌아가며, 요청 로그는 해제되므로, 그 뒤 영역의 항목은 남지 않고 그 뒤의 `requests` 구독은 실패한다. | all |
| `document.stream.request-log-replays-with-dropped` | 새 requests 구독은 먼저 최대 200개 항목의 로그를 받고, `dropped`는 마지막 reset 이후 로그가 버린 항목 수이며, 이후 항목은 순서대로 따른다. | all |
| `document.stream.reset-clears-request-log` | requests stream의 reset은 로그와 `dropped` 수를 지우고, 그 stream의 구독에 `reset`을 보낸다. | all |
| `document.stream.delivers-to-subscribing-surface-only` | stream의 메시지는 영역에서 그 stream의 구독에만 전달되며, 각 구독의 표면과 핸들을 함께 실어 보낸다. | all |
| `document.stream.snapshot-acknowledged-after-delivery` | snapshot은 elements stream의 구독에 전달되고, 그 `seq`는 전달 뒤에 native로 확인되며, 남은 구독이 없어도 같다. | all |
| `document.stream.rejects-unknown-message` | JSON이 아닌 stream 메시지는 `document stream message is not JSON`으로, 알 수 없는 stream은 `unknown document stream "<name>"`으로, 알 수 없는 메시지 type은 `document stream "<stream>" sent an unknown message type "<type>"`으로, `seq`가 없는 elements snapshot은 `document stream "elements" snapshot has no seq`로 실패한다. | all |
| `document.stream.ack-refusal-names-seq` | native가 거부한 확인은 `document "<name>" stream <stream>: seq <seq> was not sent`로 실패하며, host는 이를 애플리케이션 로그에 쓴다. | all |
| `document.stream.process-end-removes-subscriptions` | 구독한 표면 페이지의 web content process가 끝나면 그 구독을 제거하고, stream마다 구독자 수는 0으로 돌아가며, 마지막 구독을 잃은 `elements` 수집은 꺼지고, 영역은 요청 수집과 요청 로그를 유지한다. | all |
| `document.stream.window-close-removes-subscriptions` | 구독한 표면이 있는 창을 닫으면 그 구독을 제거하고, 구독자 수는 0으로 돌아가며, 요청 로그는 해제된다. | all |
| `document.plugin.folder` | 문서 영역의 plugin 폴더는 `plugins/installed.json`이 표면의 켜진 설치 plugin에 기록한 폴더다. 꺼졌거나 알 수 없는 plugin은 `plugin <id> is not installed and enabled`로 실패한다. 그 plugin의 `plugin.json`만 읽으므로 다른 plugin의 잘못된 `plugin.json`은 답을 바꾸지 않고, 설치나 제거 뒤의 답은 설치를 따른다. | all |
| `document.process-label` | view의 WebContent process 표시 이름은 `soksak://plugin/<plugin id>`이고 document region의 표시 이름은 `soksak://plugin/<plugin id>/<region>`이다. host가 이 이름을 만들어 web view를 만들 때 platform에 넘긴다. | all |
| `document.message.forward` | plugin 문서의 메시지 `{"message": value}`는 `document-message`의 payload `{surface, document, message}`가 되고, `{"error": reason}`은 host가 로그에 쓰는 이유가 되며, 둘 다 없는 값은 `document message <name> has neither message nor error`로 실패한다. | all |
| `document.core-root.grant` | core root(`soksak://core`)는 view import map의 core target을 bundled frontend에서 제공하고 그 목록은 bundled frontend의 `core-root.json`에서 읽으며(없거나 잘못된 파일은 error이다), `install.granted-items`가 요청 plugin에 허용한 설치 plugin 파일만 제공한다. 그 밖의 경로, enabled가 아닌 요청 plugin, grant가 이름 붙이지 않은 다른 plugin의 경로는 not found가 되며 `error: core root: <path> is not granted to <plugin>`을 기록한다. 허용되었으나 없는 파일은 거부가 아니라 error이다. | all |
| `document.core-root.native` | host는 core root resolver를 platform에 등록하며, resolver는 view의 요청을 `CoreRoot`로 답한다. 허용된 module, shared target, core 파일은 확장자의 content type으로 내보내고, 거부된 path나 설치되지 않은 요청자는 not found가 되며 `error: core root: <path> is not granted to <plugin>`을 기록한다. `CoreRoot`의 error는 application log에 기록되고 요청은 not found가 된다. | all |
| `document.view-import-map.native` | host는 view import map을 platform에 설정하며, 그 값은 bundled frontend의 `view-imports.json`에서 읽고, 파일이 없으면 host는 시작하지 않는다. | all |
| `documents.binary.view-take-releases-id` | surface의 view에서 binary id를 take하면 저장된 byte를 돌려주고 id를 놓으므로, 같은 id의 두 번째 take는 native 오류 문구 `the binary id is not stored`로 실패한다. | all |
| `documents.binary.view-put-mints-id` | put은 byte를 content type과 함께 surface의 view의 binary store에 저장하고 native put이 만든 id를 돌려준다. native put의 거부는 그 문구 그대로 전달된다. | all |
| `documents.binary.view-errors` | view가 없는 surface의 take나 put은 `surface "<surface>" has no view`로 실패하고 어떤 store도 바꾸지 않는다. | all |
| `view.presentation-wait.ends` | view는 변경마다 한 번 presentation wait에 참여한다. presentation 없는 끝(process-ended, hidden, unresponsive, timeout)은 wait를 한 번 끝내고 `host.trace.view.presentation-abandoned {surface, reason}`을 쓴다. presentation은 그 event 없이 wait를 끝낸다. end가 아닌 reason은 거부된다. | all |
| `view.presentation-wait.ends-at-the-presentation-limit` | 참여한 view가 10초의 presentation limit까지 presentation도 끝도 없으면 wait는 reason `timeout`으로 끝난다. native join은 중단되고 `host.trace.view.presentation-abandoned {surface, reason: timeout}`을 쓰며, 그 view generation은 이후 wait에 참여하지 않고 새 generation은 다시 참여한다. 이미 presentation했거나 끝난 join의 limit은 아무것도 바꾸지 않으며, 그 generation은 다음 transaction에 참여한다. | all |
| `view.presentation-wait.join-trace` | performance trace가 켜져 있으면 presentation join은 정확한 surface, generation, ticket을 담은 `host.trace.view.presentation-join`의 요청, native 결과, presentation, abandonment phase를 기록한다. 동기 callback은 native join 결과보다 먼저 기록되며 abandonment 뒤의 늦은 callback도 원래 join identity를 유지한다. | all |
| `view.presentation-wait.cancel-clears-ticket` | 열린 layout ticket을 취소하면 view presentation wait와 pending 상태를 제거하고 정확한 ticket을 취소하기 전에 native join을 끝내며 presentation-abandoned event를 내보내지 않는다. 늦은 callback은 wait를 복원하지 못한다. | all |
| `view.presentation-wait.presented-before-end` | presentation 완료가 native callback에서 일어나면, UI thread가 wait의 대기 중인 끝을 실행하기 전에 그 완료를 기록한다. 그 뒤에 실행되는 끝(hidden, process-ended, unresponsive)은 wait를 presented로 끝낸다. 그때 `host.trace.view.presentation-abandoned`를 쓰지 않고 native join도 중단하지 않으며, 뒤이은 presented 끝은 wait를 찾지 못한다. | all |
| `view.presentation-wait.invisible-present-defers-end` | presentation 요청에서 보이지 않는 root 배치는 wait에 참여하지 않고, 그 요청은 그 배치의 wait를 끝내지 않는다. 보이는 view의 wait는 보이지 않음을 적용하는 sync까지 열려 있으며, 그 sync가 `host.trace.view.presentation-abandoned {surface, reason: hidden}`과 함께 한 번 끝낸다. | all |
| `view.presentation-wait.joins` | 표시되며 기다리는 것이 없는 view는 배치가 그 frame을 바꾸거나, 그것을 보이게 하거나, 새 generation을 보이게 할 때 settled든 unsettled든 present의 열린 배치 트랜잭션에 참여하고, 트랜잭션은 view가 표시된 뒤 commit된다. 표시 없이 끝나면 native 참여를 한 번 끝낸다. | all |
| `surface-layout.setup-failure-cancels-open-transaction` | Tauri가 layout setup 중 WebView presentation callback을 등록하지 못하면 열린 layout transaction을 취소하고 setup 오류를 반환한다. 취소도 실패하면 그 오류를 setup 오류에 덧붙인다. | tauriv2 only: callback 등록 setup 단계는 Tauri WebView 경로의 일부이며 Wails는 platform operation으로 참여한다 |
| `surface-layout.keyboard-follows-the-focus-ring` | workbench는 `surfaceFocus {surface}`로 창의 키보드를 surface에 주고, `surface`가 null이면 워크벤치에 준다([surface의 키보드](native-surfaces.ko.md#surface의-키보드)). window가 없거나 window가 갖지 않은 surface면 요청을 거부한다. | all |
| `surface-layout.keys-wait-for-the-decision` | 창의 워크벤치 위 release 뒤의 창 키는 `surfaceFocus {surface, decided: true}`, 창의 press, 워크벤치의 끝, 창 닫힘 중 하나까지 순서대로 기다리고, pointer event는 기다리지 않는다. decided 호출은 키보드가 옮겨진 뒤 키를 주며 surface가 거부될 때도 준다. `decided`가 없는 호출은 대기를 남긴다([surface의 키보드](native-surfaces.ko.md#surface의-키보드)). 창이 없으면 호출은 거부된다. | all |
| `surface-layout.page-cancels-preparation` | workbench는 presentation하지 않는 preparation을 `cancelSurfaces {ticket}`로 취소하고, 이 요청은 main thread에서 ticket의 wait를 포기하고 layout을 취소한다. window가 없으면 요청을 거부한다. | all |
| `surface-layout.cancelled-ticket-is-no-longer-current` | 기다리는 동안 page 시작, 창 닫기 또는 `cancelSurfaces`가 ticket을 취소한 `presentSurfaces`는 그 ticket의 presentation wait를 끝내고 `surface preparation <ticket> is no longer current`로 실패한다([native host](native-host.ko.md)). | all |
| `surface-layout.element-holds-its-views-until-the-next-frame` | main page 없는 창에서 surface의 native view element는 떠난 뒤 다음 frame까지 view를 붙들고, 새 view page의 element는 끝난 page의 element를 대체하며, 이어질 frame이 없으면 view를 놓으며, 닫히는 창의 element도 모두 그렇게 놓는다. main page가 있는 창에는 element가 없다. | wailsv3, mygo only: Go language host library는 fixture framework로 시험하고, Rust language host library에는 main page 없는 framework가 없다 |
| `surface-layout.commits-after-the-presentation-notice` | layout transaction은 `Frontend`의 presentation notice가 답한 뒤에만 commit하고, 실패한 notice는 transaction을 취소하며 그 오류로 present를 끝낸다. | all |
| `surface-layout.prepare-visible-surfaces` | 표시할 surface를 준비하면 요청된 표시 상태를 유지하고, 표시하지 않을 surface는 즉시 숨긴다. | all |
| `surface-layout.placement-names-its-scale` | 준비가 답하는 보이는 배치마다, 그리고 `placed` 단계의 trace event `surface` 는 host 가 표면을 맞춘 device pixel 의 창 backing scale 을 적는다. presentation 은 그 준비의 scale 을 유지하고, 숨긴 배치는 scale 을 적지 않으며, backing scale 이 없는 창에서는 맞춤이 실패한다. | all |
| `surface-layout.created-surface-placed-without-a-main-page` | main page 없는 창에서 준비는 자기가 만든 표면을 맞춘 상자에 놓는다. transaction 의 frame 에는 그 표면의 element 가 없기 때문이다. 이미 있던 표면은 element 가 주는 자리를 유지한다. | wailsv3, mygo only: Go language host library는 fixture framework로 시험하고, Rust language host library에는 main page 없는 framework가 없다 |
| `surface-layout.frame-opened-layout-ends-with-a-preparation` | frame 이 연 layout 은 그 창의 첫 준비로 끝난다. layout 이 시작되기 전에 실패한 준비는 열린 layout 을 취소하고, 그 뒤의 실패는 아무것도 취소하지 않는다. | mygo only: frame을 보고하는 framework는 mygo뿐이다([framework 변경](hosts.ko.md#framework-변경)의 U7) |
| `surface-layout.closed-window-begins-no-layout` | 창이 닫힌 뒤 main thread 에 닿은 준비는 layout 을 시작하지 않고 창이 닫혔다는 오류로 실패한다. | wailsv3, mygo only: Go language host library는 fixture framework로 시험하고, Rust language host library에는 main page 없는 framework가 없다 |
| `surface-layout.joins-root-views-before-awaiting-app-dom` | 표시 중인 root view가 변경되면 host는 application DOM presentation을 기다리기 전에 열린 layout ticket에 참여한다. host는 DOM과 raster 준비를 기다린 뒤 commit하며 교체된 root generation도 commit 전에 해당 ticket에 참여해야 한다. 변경되지 않은 commit된 root는 다시 참여하지 않는다. | all |
| `surface-layout.presentation-failure-stops-before-commit` | application DOM presentation 실패 시 raster 작업을 건너뛰며 DOM 또는 raster 오류를 성공한 native commit 없이 반환한다. | all |
| `view.call.peer-lost` | view가 `sok-view`로 보내고 workbench가 답하지 않은 call 요청은 view process가 끝날 때까지 열려 있다. process 종료는 그것을 process-ended 이유로 끝내고 `host.call.peer-lost {plugin, command, reason}`을 쓴다. 종료 전에 workbench가 답한 call은 아무것도 쓰지 않는다. | all |
| `view.theme.first-script` | host가 만든 view는 page를 불러오기 전에 생성 시점의 테마 `{scheme, tokens}`를 동결해 `window.sokTheme`에 넣는 document-start script를 가진다. 그래서 page의 첫 script가 토큰을 읽으며, 나중의 테마 변경은 post 경로로 보낸다. | all |
| `view.start-values.first-script` | host가 만든 view는 page를 불러오기 전에 페이지가 준비로 그 surface에 선언한 동결된 시작 값 `{surface, params, origin, project, declarations, diagnostics, section, levels}`를 `window.sokSurface`에 넣는 document-start script를 가진다. 그래서 page의 첫 script가 이를 읽는다. surface가 가지지 않은 값은 `null`이되, `origin`은 연 탭이 directory를 기록하지 않았을 때 `{directory: null}`이고, 형식이 맞지 않는 값은 준비와 함께 거부되며, 다른 구성의 surface는 이 값을 담지 않고, host는 view를 다시 만들 때 surface의 기록에서 이 값을 다시 주입한다. | all |
| `view.start-values.levels` | 시작 값 `levels`는 host가 view를 만들 때 host writer의 gate에서 각 event class의 저장 level인 `{<class>: <level>}`이다. 아무 level도 저장하지 않는 class는 `off`이고, writer가 host를 gate하지 않는 동안 모든 class는 `trace`다. 페이지는 `levels`를 보내지 않는다. | all |
| `view.start-values.declaration-table` | Surface synchronization request는 request-local declaration table을 요구하고 기존 검사나 surface 변경 전에 각 view start index를 완전한 declaration object로 해석한다. 누락된 table, 잘못된 entry, 누락되거나 잘못된 index, 사용하지 않는 entry와 이전 중첩 wire 형식은 거부한다. View별 context 차이와 request별 변경을 보존한다. | all |
| `view.start-values.omitted-keeps-held` | Surface synchronization request에서 `start`가 없는 view surface는 host가 쥔 start 값을 유지하고, host는 그 값으로 view를 다시 만든다. `start`가 있는 request는 그 값을 바꾼다. Host가 쥔 값이 없는 view surface에 `start`가 없으면 `surface "<id>": view start is missing`으로 거부한다. | all |
| `view.start-values.refuses-a-missing-origin` | `origin`이 없거나, `null`이거나, 경로 또는 `null`을 담은 `{directory}`가 아니거나, directory가 로컬 절대 경로가 아닌 view surface의 준비는 [네이티브 surface](native-surfaces.ko.md#view-표면)의 네 문구 중 하나로 거부된다. 순서는 그 절의 순서이며, 문구는 `surface "<id>": view start origin is missing`, `surface "<id>": view start origin is not {directory} with a path or null`, `surface "<id>": view start origin directory is empty`, `surface "<id>": view start origin directory is not an absolute path`다. host는 그 자리에 directory를 주입하지 않으며, 시작 값 script도 이런 origin을 거부한다. | all |
| `view.start-values.keeps-null-members` | Surface synchronization request의 decoder는 view 시작 값의 null `diagnostics`와 `section`을 있는 값으로 유지하므로 시작 값 검사가 이를 받아들인다. 없는 member만 missing이다. | all |
| `view.start-values.refuses-a-missing-section` | 유효한 origin과 diagnostic 선언 뒤에 `section`이 없는 view surface의 준비는 `surface "<id>": view start section is missing`로 거부하며, 시작 값 script도 이런 시작 값을 거부한다. | all |
| `view.start-values.refuses-a-section-of-another-form` | `null`이 아니고, 정확히 비어 있지 않은 문자열 `id`, 비어 있지 않은 문자열 `sidebar`, 비어 있지 않은 문자열 또는 `null`인 `card`를 가진 객체가 아닌 `section`은 `surface "<id>": view start section is not {id, sidebar, card}`로 거부한다. `null`과 그 형식의 객체는 받아들이며, 시작 값 script는 받아들인 객체를 동결하여 주입한다. | all |
| `view.channel.ready` | view의 `view.ready` message는 그 문서를 ready 문서로 기록하고, 호스트는 이어서 현재 테마를 `sok: 1`과 함께 보낸다. view의 새 탐색(document 상태의 `navigations` 값 상승)은 기록을 지우므로, 그 뒤의 post는 다음 ready message 전까지 거부된다. | all |
| `view.log.uses-direct-writer` | view의 `runtime.log` clock 또는 batch 요청은 host writer가 처리하며 합성 `host.view.call`이나 workbench relay event가 되지 않는다. | all |
| `view.log.retired-generation-cannot-write-as-replacement` | retired view generation에서 받은 runtime log 요청은 replacement page의 요청으로 받아들이지 않으며 replacement를 통해 기록하지 않는다. | all |
| `view.log-navigation-clears-ready-page` | 새 navigation이 시작되면 이전 ready page의 runtime log 요청은 no-ready-page 오류로 거부하고 요청 id를 reply에 보존한다. | all |
| `view.log.same-id-replies` | 직접 runtime log reply는 성공 결과와 오류 모두 원래 요청 id를 담는다. | all |
| `view.log.reply-post-failure-is-reported` | Wails가 direct runtime log reply를 native view에 보내지 못하면 host는 그 native post failure를 view error 경로에 기록한다. | wailsv3 only: Wails runtime log handler는 native post 오류를 보고할 수 있는 WebView API로 reply를 보내며 Tauri는 command response로 invoke 결과를 반환한다 |
| `view.ready.requires-document-and-positive-time-origin` | `view.ready`가 page identity인 비어 있지 않은 `document`와 양의 유한수 `time_origin`을 적지 않으면 view는 direct log 전달을 위한 ready 상태가 되지 않으며, 그런 message는 ready document를 만들지 않는다. | all |
| `view.channel.progress-keeps-ready` | `loading`이 true이고 `navigations` 값이 직전 상태와 같은 view의 document 상태는 ready 기록을 유지한다. 그래서 load가 도는 중에 ready message를 보낸 view는 그 load의 progress 뒤에도 post를 받는다. | all |
| `view.channel.state-boolean` | view의 document 상태는 `loading`을 JSON boolean으로 담고, host는 상태의 native payload(`url`, `title`, `loading`, `progress`, `canGoBack`, `canGoForward`, `error`, `scroll`, `history`, `link`, `navigations`)를 받는다. | all |
| `view.channel.state-navigations-required` | `navigations`가 없는 view 상태는 `<surface>: view state has no navigations`로 거부되고, 직전에 센 값보다 작은 수는 `<surface>: view state counts <n> navigations, below the <m> counted before`로 거부된다. | all |
| `view.channel.state-numeric-refused` | `loading`이 숫자인 view 상태는 `<surface>: view state is not JSON`과 decoder의 type 오류로 거부되며, ready 문서의 기록은 남는다. | all |
| `view.channel.ui-thread` | view 문서에 대한 각 native post(theme, reply, request, event)는 view 문서 조회와 함께 UI thread의 작업 하나로 실행되어 다른 thread에서 실행되지 않는다. | all |
| `view.channel.post-before-ready` | ready 문서가 기록되지 않은 view로의 post는 `<surface> has no ready document`로 거부되며, 아무것도 보내지 않는다. | all |
| `view.channel.queue-full` | queue overflow 이유의 `view.error` message는 그 이유를 `error: view channel: <reason>`으로 application log에 쓰고, 다른 frame에서 온 view의 `{"error": reason}` message도 같은 형식으로 이유를 쓴다. | all |
| `view.error.display` | 다른 이유의 `view.error` message는 `error: view <plugin> <surface>: <reason>`으로 오류 표시 경로에 한 번 쓰이고 view는 계속된다. 이유가 빈 `view.error`는 거부한다. | all |
| `view.call.record` | view의 call 요청은 debug 수준의 `host.view.call`(plugin, surface, id, command)로 기록되고, 그 회신은 결과(outcome)와 함께 `host.view.reply`로 기록된다. cancel은 call로 기록하지 않는다. | all |
| `view.restart.limit` | process가 끝했거나 message queue가 넘친 view는 300초 안에 네 번째 failure까지 닫히고 다시 만들어지며, surface마다 sliding window로 센다: 새 failure보다 300초 이전인 failure은 세지 않는다. 네 번째 failure가 restart를 멈추고, 멈춘 surface는 view를 만들지 않으며, surface를 제거하면 그 failure 기록을 지운다. | all |
| `view.responsiveness.relay` | view의 `_webViewWebProcessDidBecomeUnresponsive:` 알림은 `host.trace.view.unresponsive {plugin, surface}`를 쓰고 `view-responsiveness {surface, plugin, generation, responsive: false}`를 workbench에 보내며, `_webViewWebProcessDidBecomeResponsive:` 알림은 `host.trace.view.responsive {plugin, surface}`를 쓰고 같은 generation의 `responsive: true`를 보낸다. Callback은 이를 만든 view의 generation을 캡처하고, workbench는 해당 generation이 current일 때만 notice를 적용하며 오래된 notice는 `workbench.view.event.cancel`로 기록한다. 두 알림 모두 view의 call을 끝내지 않는다. | all |
| `view.process.events` | view를 만들면 `host.trace.view.process-request {plugin, surface}`를 쓰고, 그 view의 첫 ready message는 `host.trace.view.process-ready {plugin, surface}`를 쓴다. | all |
| `view.restart.restores-state` | 프로세스가 끝난 뒤 호스트가 다시 만든 view는 기록의 surface를 가지므로, 새 view의 view 호출은 그 surface를 담은 `view-call`로 전달되고, workbench가 surface별로 보관하는 그 surface의 탭 상태는 끝나기 전과 같이 읽힌다. | all |
| `view.restart.limit-shows-error` | 300초 안의 네 번째 view surface 실패는 `view-stopped {surface, plugin, reason}` event를 창의 workbench에 한 번 보내며, reason은 `the view failed 4 times within 300 seconds and is created again when its tab is reopened`이고, application log에 `error: view channel: <surface>: <reason>`을 쓴다. | all |
| `view.channel.overflow-closes` | 이유가 `queue full for <plugin>`인 `view.error` message는 그 surface의 view를 닫고 그 surface의 실패 하나로 센다. 이미 닫힌 view의 message는 아무것도 닫지 않는다. | all |
| `view.origin.current-callback-is-dispatched` | 현재 view origin의 callback은 view dispatch 경로에 도달한다. | all |
| `view.origin.retired-callback-is-cancelled` | 종료된 view origin의 callback은 dispatch 전에 취소되고 교체 view에는 도달하지 않는다. | all |
| `view.origin.retired-producer-error-is-preserved` | 종료된 view origin의 producer 오류는 원래 이유와 view 식별자를 보존해 기록하며 현재 channel에는 들어가지 않는다. | all |
| `view.origin.retired-channel-errors-are-reported` | 종료된 view origin에서 발생한 잘못된 JSON과 transport 오류는 원래 이유를 보존한 channel 오류로 보고된다. | all |
| `view.dispatch.decodes-envelope-once` | Tauri view dispatcher는 현재 message envelope를 한 번만 decode하고 decode한 값에서 reply, call, snapshot, ready message를 분기한다. | tauriv2 only: Rust dispatcher의 decoded-value ownership 경로를 검증한다 |
| `view.dispatch.preserves-precedence-and-errors` | Tauri view dispatcher는 field를 검증하기 전에 reply, cancel, ready 우선순위를 적용하고 잘못된 reply와 malformed JSON의 명시적 오류를 보존한다. | tauriv2 only: Rust dispatcher의 message-kind 선택과 decoder 오류를 검증한다 |
| `view.origin.retired-malformed-envelope-is-reported` | 종료된 view origin의 잘못된 message envelope는 원래 이유를 보존한 channel 오류로 보고된다. | all |
| `view.call.reply-generation-scoped-cleanup` | 이전 view generation의 늦은 reply는 같은 call id를 가진 교체 generation의 pending-call 기록을 제거하지 않는다. | all |
| `sidecars.stop.stdin-eof-cancels-late-image` | stdio sidecar의 입력이 닫힌 뒤 이를 중지하면 늦은 image transfer를 닫힌 surface에 전달하지 않고 취소한다. | all |
| `view.source-generation` | View request, reply, event 직렬화는 JavaScript safe integer 한도를 넘는 generation을 `<subject> source generation exceeds the JavaScript safe integer limit`로 거부한다. subject는 `view request`, `view reply`, `view event`다. 이전 generation의 request와 event는 게시 없이 취소하고, 이전 acknowledgement는 게시하지 않으며 이전 pull은 취소한다. 최대 safe generation은 허용된다. | all |
| `view.source-registration-precedes-provider-messages` | View source-registration event는 첫 status-watch 등록보다 먼저 전달되며, 둘은 같은 source generation을 가진다. | all |
| `source-origin.generation.javascript-safe-integer-limit` | Source-origin allocator는 JavaScript safe integer 한도를 넘는 generation 발급을 `view source generation exceeds the JavaScript safe integer limit`로 거부하며 floor나 등록된 source 상태를 바꾸지 않는다. | all |
| `source-origin.atomic-snapshot-keeps-floor-and-only-current-sources` | view source-origin snapshot은 현재 source identity만 포함하며 source를 retire하거나 교체한 뒤에도 generation floor를 유지한다. | all |
| `view.process-end-precedes-replacement-registration` | 실패한 view의 process-ended event는 대체 view가 source-registration event를 보내기 전에 전달된다. | all |
| `view.call.forward` | 멤버 `cids`(식별자 목록)를 가진 call 요청은 event에 멤버 `cids`를 싣는다. 한 줄에 담을 수 없는 목록은 애플리케이션 로그에 쓰고 어떤 page에도 전달하지 않는다.  view가 `sok-view`로 보낸 call 요청 `{sok: 1, id, command, params}`은 view의 surface와 plugin을 담은 `view-call {surface, plugin, id, command, params}` event가 된다. `id`가 정수가 아니거나 `command`가 비어 있는 요청은 application log에 쓰고 어떤 page에도 전달하지 않는다. | all |
| `view.call.cancel` | view가 `sok-view`로 보낸 cancel `{sok: 1, id, cancel: true}`은 view의 surface와 plugin을 담은 `view-call {surface, plugin, id, cancel: true}` event가 된다. `id`가 정수가 아니거나, `cancel`이 `true`가 아니거나, `command`를 담은 cancel은 application log에 쓰고 어떤 page에도 전달하지 않는다. | all |
| `view.call.reply-null-result` | workbench의 `viewReply {page, surface, generation, id, result: null}`는 `{sok: 1, id, result: null}`로 ready document에 post된다. 값이 없는 명령은 null result로 답하며, host는 그 null을 result로 보존한다. | all |
| `view.call.reply` | workbench의 응답 `viewReply {page, surface, generation, id, result}` 또는 `viewReply {page, surface, generation, id, error}`는 view의 ready 문서에 `{sok: 1, id, result}` 또는 `{sok: 1, id, error}`로 post된다. `page`는 현재 메인 문서의 page identity다([logging](logging.ko.md#event)). ready document가 없는 view 응답은 `<surface> has no ready document`로 실패한다. generation 검증 뒤 host는 `host.view.reply.dispatch`를 기록하며, current 대상은 native post가 반환된 뒤 기록한다. 기록에는 window, page, surface, generation, id, outcome과 disposition이 있다. stale 대상은 `discarded`와 `view-generation-not-current` reason을 기록한다. `posted`는 native post 수락이지 JavaScript 수신이 아니다. Native post 오류는 host call을 거부하고 dispatch record를 쓰지 않는다. | all |
| `view.event.push` | workbench의 `viewEvent {surface, generation, event, data}`는 view의 ready 문서에 `{sok: 1, event, data}`로 post되고 `data`는 임의의 JSON 값이다. Host는 current view generation만 받아들이며 `sok-view`에 generation을 노출하지 않는다. Stale generation은 post 없이 취소한다. Current generation event를 보낼 ready 문서가 없으면 `<surface> has no ready document`로 실패한다. | all |
| `sidecar.route.calls` | workbench의 `sidecarListen {sidecar, id, on}`과 `viewSidecarRoute {surface, generation, sidecar, id, on}`은 `null`로 답한다. 각 call은 workbench가 아닌 호출자에게 거절되고, 형식 밖의 field에는 `<call> requires a non-empty sidecar`, `<call> requires a non-empty id`, `<call> requires on as a boolean`, `viewSidecarRoute requires a non-empty surface`, `viewSidecarRoute has no source generation`, `viewSidecarRoute source generation exceeds the JavaScript safe integer limit`로 거절된다. | all |
| `sidecar.route.delivery` | 한 쌍의 sidecar message는 workbench가 그 쌍을 듣는 동안에만 workbench에 `sidecar-message`로 가고, generation이 current인 route된 view 각각은 raw body를 담은 `{"sok":1,"event":"sidecar.message","data":{"id":<id>,"body":<body>}}`를 받는다. 더 이상 current가 아닌 generation의 route는 `host.view.sidecar.discard`와 함께 지워지고, 같은 call의 반복은 아무것도 바꾸지 않으며, 메인 문서의 load는 모든 route를 지운다. | all |
| `view.status.relay` | `sok-view`로 view가 보낸 status watch `{sok: 1, id, command: "runtime.status.watch", params: {name}}`는 call request와 같이 command와 params를 바꾸지 않고 `view-call {surface, plugin, id, command, params}` event가 된다. 메인 페이지의 `viewEvent {surface, generation, event: "status", data: {name, value}}`는 ready document에 `{sok: 1, event: "status", data: {name, value}}`로 게시된다. Host는 current view generation을 검사하고 command와 status 이름은 읽지 않으며, 어느 owner의 status든 전달한다. | all |
| `view.command.request` | workbench의 `viewRequest {surface, id, command, params}`는 view의 ready 문서에 `{sok: 1, id, command, params}`로 post된다. `viewRequest`가 `cids`를 가지면 메시지에 멤버 `cids`로 실어 보내고, `cids`가 없는 요청은 멤버를 싣지 않는다. 한 줄에 담을 수 없는 식별자(빈 식별자, 또는 따옴표, 역슬래시, 제어 문자가 있는 식별자)가 있는 `cids`는 요청을 이름 붙인 오류로 거부하며 어떤 view에도 post하지 않는다. view가 `sok-view`로 보낸 응답 `{sok: 1, reply: id, result}` 또는 `{sok: 1, reply: id, error: {code, message}}`는 `view-reply {surface, plugin, id, result}` 또는 `view-reply {surface, plugin, id, error}` event가 된다. `id`가 정수가 아니거나, `result`와 `error` 중 하나만 없거나, error에 message가 없는 응답은 application log에 쓰고 어떤 page에도 전달하지 않는다. | all |
| `view.message.unknown-event` | view가 `sok-view`로 보낸 message의 `event`가 `view.ready`도 `view.error`도 아니면 `<surface>: view event "<event>" is unknown`으로 application log에 기록되고 어떤 page에도 전달되지 않는다. 지워진 `declared-ui.snapshot`도 그런 event다. | all |
| `view.exposure.register` | workbench는 view 페이지의 status·element 등록을 `{surface, kind, name}`을 담은 `exposureRegister` 호출로 전달한다. 호스트는 이를 기록하고 workbench에 event `exposure-registered {surface, kind, name}`를 보내며, 다시 읽은 workbench는 replay를 통해 살아 있는 모든 등록을 다시 받는다. view가 없는 surface에 대한 전달, `status`·`command`·`element` 이외의 `kind`, surface가 등록할 수 없는 이름은 오류로 거부되며 아무것도 기록하거나 알리지 않는다. | all |
| `view.regions.close-with-process` | view의 process가 끝나면 호스트는 view를 다시 만들기 전에 그 표면의 document·image 영역을 닫으므로, 새 view는 선언된 영역 이름을 다시 붙인다. view 자체는 재시작 한도 안에서 다시 만들어진다. | all |
| `view.process-ended.forgets-regions` | view의 process가 끝나면 호스트는 그 표면의 영역을 닫은 뒤 window event `view-process-ended {surface}`를 보내므로, 페이지는 새 view가 영역을 다시 붙일 때까지 그 표면의 영역을 잊는다. | all |
| `view.create-loads-page` | view surface는 첫 sync에서 view 구성(`isView` 설정)으로 web view를 folder와 plugin을 surface의 것으로 하여 만들고, `soksak://<plugin>/<page>`를 load한다. | all |
| `view.composition.page-and-regions` | 호스트는 surface의 합성 선언을 검증한다. `page`가 plugin의 하나의 `.html` 파일이고 `regions`와 `overlays`가 선택적인 `view` 합성은 받아들이고, `page`가 없는 `view`, plugin 밖의 `page`, 접미사가 `.html`이 아니거나 `.binary` 폴더 안의 `page`, `surface.module`과 `hybrid` 합성은 거절한다. | all |
| `view.composition.image-region-declares-present` | image 영역은 `present`를 `copy` 또는 `lease`로 선언한다. 호스트는 `present`가 없거나 다른 값인 image 영역을 `image region "<name>" declares present copy or lease` 오류로 거절하고, `present`를 선언한 document 영역은 native input을 갖지 않는 영역으로 거절한다. | all |
| `view.placement.requires-current-page-declaration` | 현재 page가 composition declaration을 등록하지 않은 view의 sync request는 `surface "<id>" has no composition declaration in the current page`로 거부한다. 현재 page의 일치하는 declaration은 허용하고 다른 declaration은 거부한다. | all |
| `view.placement.retires-declarations-on-page-reload` | Page를 reload하면 이전 page의 view composition 및 plugin declaration을 지워 이후 sync request의 권한으로 사용할 수 없게 한다. | all |
| `view.composition.dom-removed` | 제거된 `dom` 합성 kind는 `plugin <plugin> surface composition: kind dom is removed; the composition takes kind view`로, 제거된 `hybrid` kind는 `kind hybrid is removed; the composition takes kind view`로 거절된다. | all |
| `view.overlays.reach-native-in-declared-order` | view surface의 DOM overlay는 배치가 어떤 순서로 도착하든 선언된 순서대로, 선언한 overlay마다 하나씩 자신의 insets와 표시 여부를 가지고 native surface에 전달된다. | all |
| `view.overlays.native-mask-values` | view surface의 native overlay mask는 native 호출 순서대로 overlay마다 다섯 값을 받는다. left, top, right, bottom insets와, 보이는 overlay는 1, 숨긴 overlay는 0인 표시 flag다. | all |
| `host.arguments.declared-only` | `--config-dir PATH`와 `--config-dir=PATH`는 설정 폴더를 정한다. 선언하지 않은 인자, 값 없는 flag, 두 번 준 flag는 그 문장으로 실패한다. | all |
| `host.arguments.registry-ca-in-diagnostic-builds` | 진단 build는 `--registry-ca PATH`를 받고, 그 뒤 registry 받기는 그 PEM 파일의 인증 기관만 신뢰한다. 인증서 없는 파일은 `--registry-ca <path>: <reason>`으로 실패하고, host의 TLS parser가 거부하는 인증서는 `--registry-ca <path>: certificate <n> does not parse: <reason>`으로 실패한다. n은 파일의 인증서 block을 1부터 센다. | all |
| `host.memory-pressure.relays-level-and-seq` | host는 시작할 때 platform의 memory pressure source를 시작하고, 각 보고를 그 보고의 `{level, seq}`를 가진 workbench event `memory-pressure`로 `seq` 순서대로, 보고하는 thread를 붙잡지 않고 모든 창에 보낸다. platform이 거부한 source는 `failed to start the memory pressure source`로 시작을 실패시킨다. | all |
| `endpoint.process.rejects-a-malformed-lock` | 잠금이 걸린 `process.lock`의 내용이 비었거나 다른 형식이면 엔드포인트는 `already owned by a live process`로 거부하며, 거부에 드는 내용은 256 바이트로 잘린다. 잠금 파일은 그대로 남는다. | all |
| `endpoint.lock.empty-is-no-previous-run` | 시작할 때 비었고 잠기지 않은 `process.lock`은 event `host.run.unrecorded-end`를 저장하지 않고 넘겨받는다. 시작자가 잠그기 전에 파일을 만들고, 소유자는 잠금 아래에서만 기록을 쓰기 때문이다. | all |
| `endpoint.lock.unrecorded-end` | 시작할 때 잠기지 않았고 비어 있지 않은 `process.lock`은 내용과 관계없이 넘겨받으며, 엔드포인트는 이전 실행의 `boot`와 `pid`, 또는 다른 형식 파일의 내용을 알려 준다. host는 이를 `host.run.unrecorded-end`로 저장한다. | all |
| `endpoint.lock.single-owner` | 같은 설정 디렉터리의 두 번째 엔드포인트는 첫 엔드포인트가 잠금을 쥐고 있는 동안 "already owned by process"로 거부되며, 오래된 `process.lock`을 찾은 두 시작자는 소유자를 하나만 남긴다. | all |
| `endpoint.process.lock-mode-0600` | 설정 디렉터리의 `process.lock`은 mode 0600이다. | all |
| `endpoint.transport.http-request-line-closes` | HTTP 요청 줄은 응답이나 메서드 호출 없이 연결을 닫는다. | all |
| `endpoint.transport.invalid-json-closes` | 본문이 JSON이 아닌 프레임은 응답 없이 연결을 닫는다. | all |
| `endpoint.transport.closing-a-disconnected-connection-succeeds` | socket이 이미 끊긴 연결을 닫으면 성공한다. 다른 shutdown 오류는 보고한다. | tauriv2 only: Rust host는 socket을 명시적으로 shutdown하며 끊긴 socket을 보고하고, Go는 shutdown 없이 연결을 닫는다 |
| `endpoint.transport.non-jsonrpc-object-closes` | JSON-RPC 2.0 요청이 아닌 JSON 프레임은 응답 없이 연결을 닫는다. | all |
| `endpoint.transport.undeclared-method-closes` | 선언되지 않은 메서드는 응답 없이 연결을 닫고 workbench에 아무것도 전달하지 않는다. | all |
| `endpoint.transport.close-reason-is-recorded` | 닫히는 연결은 소켓을 닫기 전에 `info host endpoint: connection closed: <reason>`을 쓴다. reason은 한도를 넘은 frame, JSON-RPC 2.0 요청이 아닌 frame(본문 포함), 선언되지 않은 메서드, peer의 종료다. | all |
| `endpoint.timeout.is-recorded` | 제한 시간 오류 1005로 끝나는 endpoint 요청은 client가 오류를 받기 전에 `error host endpoint timeout: <method>: <message>`를 쓴다. | all |
| `endpoint.diagnostics.methods-exist-only-in-diagnostic-builds` | 릴리스 빌드에서 diagnostics.transcript는 연결을 닫고 workbench에 닿지 않으며, 진단 빌드에서는 응답된다. | all |
| `endpoint.rpc.round-trip-by-id` | 한 연결의 여러 요청은 각각 같은 id와 결과를 가진 JSON-RPC 2.0 응답을 받는다. | all |
| `endpoint.rpc.page-params-omit-window` | workbench는 window 필드를 뺀 전달 매개변수를 받는다. | all |
| `endpoint.rpc.unknown-window-1003` | 존재하지 않는 창에 대한 선언된 메서드는 workbench에 닿지 않고 오류 1003을 반환한다. | all |
| `endpoint.rpc.missing-window-param-invalid` | window 매개변수가 없는 status.get은 -32602를 반환한다. | all |
| `endpoint.rpc.target-params-are-checked-in-order` | window를 지정하는 요청은 params를 한 순서로 검사한다. window가 없거나, null이거나, 문자열이 아니거나, 비어 있으면 -32602 `window must be a non-empty string`으로 실패한다. 그다음 `status.get`, `status.watch`, `status.unwatch`, `command.run`, `element.rect`, `element.act`에서 name이 없거나, 문자열이 아니거나, `<owner>.<name>` 형식이 아니면 -32602 `name is required and must have the form <owner>.<name>`으로 실패한다. 그다음 없는 window는 1003으로 실패한다. 이런 요청은 workbench에 닿지 않는다. | all |
| `endpoint.rpc.element-rect-role` | `element.rect` 응답은 workbench가 답한 `role`을 그대로 담는다. ARIA role은 문자열이고, 묶거나 글자만 담는 요소는 null이다. | all |
| `endpoint.names.unknown-host-name-1001` | 알 수 없는 host 이름의 command.run은 오류 1001을 반환한다. | all |
| `endpoint.names.missing-name-invalid` | name이 없는 status.get은 -32602를 반환한다. | all |
| `endpoint.names.owner-form-required` | owner.name 형식이 아닌 이름과 문자열이 아닌 이름은 -32602를 반환한다. | all |
| `endpoint.names.valid-name-examples` | core.surface.document와 plugin-x.a-1 같은 이름은 올바르다. | all |
| `endpoint.input.pointer-invalid-phase` | 알 수 없는 phase의 포인터 입력은 -32602를 반환한다. | all |
| `endpoint.input.pointer-missing-coordinate` | x가 없는 포인터 입력은 -32602를 반환한다. | all |
| `endpoint.input.pointer-numeric-button-rejected` | 숫자 포인터 버튼은 -32602를 반환한다. | all |
| `endpoint.input.pointer-middle-button-rejected` | 가운데 포인터 버튼은 -32602를 반환한다. | all |
| `endpoint.input.pointer-activate-only-on-move` | activate는 down phase에서 거부되고 move phase에서 받아들여진다. | all |
| `endpoint.input.pointer-activate-must-be-bool` | 불리언이 아닌 activate는 -32602를 반환한다. | all |
| `endpoint.input.pointer-defaults` | button이나 activate가 없는 포인터 입력은 왼쪽 버튼과 비활성화를 쓴다. | all |
| `endpoint.input.pointer-clicks-range` | 1부터 3까지의 정수가 아닌 포인터 clicks는 -32602를 반환한다. | all |
| `endpoint.input.pointer-clicks-only-on-press-and-release` | clicks는 down, up phase에서 받고 move, drag, scroll phase에서는 -32602를 반환한다. | all |
| `endpoint.input.pointer-clicks-default` | clicks가 없는 포인터 입력의 click count는 1이고, clicks 2는 click count 2로 전달한다. | all |
| `endpoint.input.pointer-unknown-field-rejected` | method가 정의하지 않은 field가 있는 포인터 입력은 -32602를 반환한다. | all |
| `endpoint.input.pointer-right-button-accepted` | 오른쪽 포인터 버튼을 받아들이고 오른쪽 버튼으로 전달한다. | all |
| `endpoint.input.pointer-phase-and-scroll-decoding` | drag와 scroll phase, deltaY, 소수 좌표를 그대로 전달한다. | all |
| `endpoint.input.pointer-button-held-message` | 1007 메시지는 `NSEvent.pressedMouseButtons` 마스크를 16진수로, frontmost 애플리케이션을 bundle identifier와 pid로 보고하며, bundle identifier가 없는 애플리케이션은 pid로, frontmost 애플리케이션이 없으면 그 사실을 두 host에서 같은 문장으로 보고한다. | all |
| `endpoint.input.pointer-name` | `pointer`의 기본값은 `main`이고, `a-z`, `0-9`, `-`로 된 1~32자 이름은 그대로 전달하며, 빈 이름, 다른 문자가 있는 이름, 더 긴 이름, 문자열이 아닌 값은 -32602를 반환한다. | all |
| `endpoint.input.pointer-held-message` | 1011 메시지는 누름을 쥔 pointer와 그 누름이 쥔 상태를 두 host에서 같은 문장으로 밝힌다. | all |
| `endpoint.input.key-unknown-modifier-rejected` | 알 수 없는 키 수정자는 -32602를 반환한다. | all |
| `endpoint.input.key-shift-command-mask` | shift와 command 수정자는 비트 마스크 9가 되고, 키와 phase는 그대로 전달된다. | all |
| `endpoint.input.key-control-option-and-text` | control과 option 수정자는 6이 되고 text는 그대로 전달된다. | all |
| `endpoint.input.key-empty-text-types-the-key` | text가 빈 키는 text 없이 플랫폼에 닿으므로, 키 이름이 event의 문자를 정한다. | all |
| `endpoint.input.key-invalid-phase-or-modifier-type` | 알 수 없는 키 phase나 배열이 아닌 modifiers 값은 -32602를 반환한다. | all |
| `endpoint.discovery.writes-endpoint-json` | endpoint.json은 전송 방식, 주소, pid, 애플리케이션, 버전, 실행 파일, 시작 시각을 담는다. | all |
| `endpoint.discovery.written-after-first-window` | 엔드포인트를 시작할 때 endpoint.json을 쓰지 않는다. 없는 창으로 게시하면 실패하고 파일을 쓰지 않으며, 있는 창으로 게시한 뒤에는 그 창의 요청에 응답한다. | all |
| `endpoint.discovery.endpoint-json-mode-0600` | endpoint.json의 모드는 0600이다. | all |
| `endpoint.discovery.removes-endpoint-json-on-close` | 엔드포인트를 닫으면 endpoint.json을 제거한다. | all |
| `endpoint.discovery.removes-socket-on-close` | 소켓은 서비스 중에 존재하고 엔드포인트를 닫으면 제거된다. | all |
| `endpoint.discovery.close-keeps-replacement` | 닫을 때 다른 프로세스가 쓴 endpoint.json은 제거하지 않는다. | all |
| `endpoint.socket.private-modes` | 소켓 디렉터리의 모드는 0700이고 소켓의 모드는 0600이다. | all |
| `endpoint.socket.sweeps-ended-process-sockets` | 수신을 시작하면 이 애플리케이션의 끝난 프로세스 소켓을 제거하고, 살아 있는 소켓과 다른 애플리케이션의 소켓은 유지한다. | all |
| `endpoint.socket.refuses-open-directory` | 다른 사용자에게 열린 소켓 디렉터리를 오류에 모드를 적어 거부한다. | all |
| `endpoint.socket.refuses-foreign-owner` | 다른 사용자가 소유한 소켓 디렉터리를 "belongs to another user"로 거부한다. | all |
| `endpoint.socket.refuses-non-directory` | 심볼릭 링크인 소켓 경로를 "is not a directory"로 거부한다. | all |
| `endpoint.socket.path-over-limit` | 103바이트를 넘는 소켓 경로는 macOS unix socket 주소의 한계(`sun_path`는 종료 NUL을 포함해 104바이트이다)이므로, 소켓 디렉터리를 바꾸기 전에 `endpoint socket path <path> is <n> bytes, over the limit of 103 bytes of a unix socket address`로 거부한다. | all |
| `endpoint.watch.notifies-watching-connection` | status.watch 뒤의 변경은 window, name, value를 가진 status.changed 알림으로 그 연결에 도착한다. | all |
| `endpoint.watch.non-watching-connection-not-notified` | 구독하지 않은 연결은 알림을 받지 않는다. | all |
| `endpoint.watch.unwatch-is-per-connection` | 한 연결의 구독 해제는 같은 상태를 구독한 다른 연결의 알림을 유지한다. | all |
| `endpoint.watch.page-watch-deduplicated` | 같은 상태를 구독하는 두 번째 연결은 workbench에 status.watch를 더 보내지 않는다. | all |
| `endpoint.watch.no-page-unwatch-while-watched` | 어떤 연결이든 상태를 구독하는 동안 workbench는 status.unwatch를 받지 않는다. | all |
| `endpoint.watch.last-watcher-close-unwatches-page` | 마지막 구독 연결을 닫으면 workbench에 status.unwatch를 보낸다. | all |
| `endpoint.watch.registry-reflects-watches` | 구독 등록소는 활성 구독만 정확히 나열하고 마지막 구독자가 떠나면 비어 있다. | all |
| `endpoint.watch.surface-and-plain-forwarded-separately` | 같은 이름의 표면 구독과 일반 구독은 각자의 매개변수로 모두 workbench에 전달된다. | all |
| `endpoint.watch.empty-surface-invalid` | 빈 surface의 status.watch는 -32602를 반환한다. | all |
| `endpoint.watch.surface-change-names-surface` | 표면 구독의 변경은 surface를 담고, 일반 구독의 변경은 담지 않는다. | all |
| `endpoint.watch.surface-unwatch-forwarded-with-surface` | 표면 구독을 해제하면 surface를 담은 status.unwatch를 workbench에 보낸다. | all |
| `endpoint.watch.surface-unwatch-keeps-plain-watch` | 표면 구독을 해제해도 같은 이름의 일반 구독은 유지된다. | all |
| `endpoint.watch.subscription-arrival-order` | 연달아 보낸 watch, unwatch, watch는 느린 workbench에 그 순서로 도착하고 연결은 계속 구독한다. | all |
| `status.window.rewatch-notifies` | host.window의 마지막 watch가 끝난 뒤 시작한 watch는, 앞선 watch 종료 전에 보낸 값과 같더라도 창의 다음 값을 받는다. Tauri host는 마지막 watch가 끝날 때 마지막으로 보낸 값의 기록을 지우고, Wails host는 기록을 두지 않는다. | all |
| `status.window.latest-value-last` | 읽는 동안 들어온 host.window 변경은 그 마지막 변경 뒤에 시작하는 읽기 하나로 합쳐지므로, 변경이 몰려도 읽기는 하나이고 새 값 뒤에 옛 값을 보내지 않는다. | all |
| `status.window.latest-reads-run-on-one-thread` | 창들의 latest read는 유지되는 thread 하나에서 돈다. 각 창은 자기 latest read를 가지고, burst가 끝난 뒤의 요청은 그 thread를 쓴다. | tauriv2 only: Go의 읽기는 goroutine에서 돌므로 유지되는 thread가 필요 없다 |
| `endpoint.watch.other-requests-not-blocked-by-pending-subscription` | workbench 구독 해제가 대기 중이어도 같은 연결의 다음 요청에 응답한다. | all |
| `exposure-reply.payload.main-reply-unscoped` | surface가 없는 주 문서 응답 페이로드는 빈 surface로 해석된다. | all |
| `exposure-reply.payload.scoped-reply-keeps-surface` | surface가 있는 응답 페이로드는 인코딩과 해석을 거쳐도 surface를 유지한다. | all |
| `exposure-reply.target.main-and-surface-distinct` | surface가 없는 응답은 창의 주 문서를, surface가 있는 응답은 그 표면 문서를 대상으로 한다. | all |
| `exposure-reply.target.invalid-surface-rejected` | surface가 null, 빈 문자열, 숫자, 객체인 응답은 주 응답이 아니라 오류다. | all |
| `exposure-reply.removed-surface-discarded` | 표면이 제거된 표면 페이지의 답은 오류 대신 관측 `exposure reply <id> of removed surface "<surface>" arrived after its request ended`와 함께 버려진다. | all |
| `exposure.list.host-owner-without-page` | `owner`가 `host`인 노출 목록은 호스트 항목만 등록된 항목으로 담고 workbench에 묻지 않으며, 다른 `owner`는 `exposure.list owner must be host`로 실패한다. | all |
| `exposure.list.appends-host-entries-registered` | 노출 목록은 workbench 항목을 유지하고 호스트 상태와 명령 항목을 등록된 항목으로 더한다. | all |
| `exposure.list.host-entries-exact-sorted-set` | 호스트 상태와 명령 이름은 정해진 정렬 목록과 같다. | all |
| `exposure.list.host-entries-described` | 모든 호스트 항목은 비어 있지 않은 설명을 가진다. | all |
| `exposure.list.host-quit-result-null` | host.quit은 null 결과 스키마를 선언한다. | all |
| `exposure.list.host-hit-kinds` | host.hit은 결과 kind `workbench`, `document`, `native`를 선언한다. | all |
| `exposure.list.non-object-list-rejected` | 객체가 아닌 workbench 노출 목록은 오류다. | all |
| `exposure.host-window.reads-during-surface-creation` | 네이티브 surface view는 생성하는 같은 단계에서 surface id로 이름이 붙으므로, window status 읽기는 surface id가 없는 네이티브 view를 만나지 않는다. | all |
| `exposure.host-window.reads-during-surface-close` | 네이티브 surface view는 닫는 단계가 id를 잊을 때까지 surface id를 유지하므로, view가 열려 있는 동안 window status 읽기는 surface id가 없는 네이티브 view를 만나지 않는다. | all |
| `exposure.host-window.unregistered-surface-named` | window status 읽기가 등록된 surface가 없는 네이티브 surface view를 만나면 `unregistered native surface <id>`로 실패하며, `<id>`는 window facts의 네이티브 view 주소이고 두 host의 글은 같다. | all |
| `exposure.timeout.command-run-default-and-declared` | command.run은 기본 10초를 기다리고 선언된 timeout을 쓴다. | all |
| `exposure.timeout.every-forward-bounded` | timeout이 없는 forward 요청은 method와 관계없이 10초를 기다리므로, 시간 제한이 없는 forward는 없다. | all |
| `exposure.timeout.invalid-timeout-rejected` | 0, 600000 초과, 소수, 문자열, 음수인 command.run timeout은 -32602를 반환한다. | all |
| `exposure.relay.reply-resolves-request` | 대상 문서에서 온 같은 id의 응답은 그 결과로 요청을 완료한다. | all |
| `exposure.relay.keeps-value-text` | workbench 응답은 workbench가 보낸 텍스트 그대로 중계되므로 값의 key 순서가 유지된다(`{"zeta":1,"alpha":{"b":2,"a":1}}`는 보낸 그대로다). | all |
| `exposure.relay.missing-result-is-null` | result가 없는 응답은 null로 완료된다. | all |
| `exposure.relay.error-reply-keeps-code-and-message` | 오류 응답은 같은 코드와 메시지로 요청을 실패시킨다. | all |
| `exposure.relay.foreign-document-reply-ignored-timeout-1005` | 다른 문서의 응답은 무시되고, 요청은 1005로 시간 초과되며, 늦은 응답도 받지 않는다. | all |
| `exposure.relay.late-reply-states-its-delay` | 시간이 초과된 요청은 `the document did not reply within <ms> ms`로 실패하고, 그 뒤에 온 답은 요청을 보낸 뒤의 지연과 제한 시간으로 실패하며, 요청이 없는 답은 `has no matching request`로 실패한다. | all |
| `exposure.relay.timeout-writes-call-event` | 시간이 초과된 command는 `plugin`과 `command`를 가진 `host.call.timeout`을 쓰고, command가 아닌 요청은 call event를 쓰지 않는다. | all |
| `exposure.relay.late-reply-writes-call-event` | 시간이 초과된 command의 늦은 답은 `plugin`, `command`와 보낸 뒤의 `delay`를 가진 `host.trace.call.late-reply`를 쓴다. | all |
| `exposure.relay.send-failure-1003` | 문서로 보내기가 실패하면 요청은 즉시 1003으로 실패한다. | all |
| `exposure.relay.closed-document-fails-pending-1003` | 문서를 닫으면 대기 중인 요청은 1003으로 실패한다. | all |
| `exposure.relay.page-reload-ends-surface-requests` | 준비된 workbench에 reload 요청을 보낸 뒤 그 window의 surface document로 보낸 요청은 1003으로 끝나고, 새 workbench가 시작할 때까지 이후 요청은 1003으로 거부된다. 다른 window의 요청은 계속 기다린다. | all |
| `exposure.settled-wait.presents-through-the-frontend` | settled wait는 `Frontend`의 settled presentation으로 내용을 화면에 올리고, `Frontend`가 만들지 못한 presentation은 platform의 settled wait 전에 그 오류로 wait를 끝내며, block의 실패도 wait를 끝낸다. | all |
| `exposure.window-presented.waits-for-the-last-placement` | `host.window.presented`와 `diagnostics.drag`는 연속 갱신의 끝과 settled presentation을 기다리기 전에 창의 workbench에 `workbench.placement.last`, 곧 workbench가 만들었거나 들고 있는 마지막 placement를 묻는다. 진행 중인 placement 뒤에서 기다리는 placement는 workbench만 알기 때문이다. 시작하지 않은 workbench는 들고 있는 placement가 없다. 그 placement가 실패하거나 workbench가 시간 제한 안에 답하지 않으면 wait도 실패한다. | all |
| `exposure.relay.ended-reply-is-observed` | 문서가 1003으로 끝낸 요청에 대한 답은 받아들여 관측 `exposure reply <id> arrived after its request ended`로 쓴다. 릴레이가 보낸 적 없는 요청에 대한 답은 `exposure reply <id> has no matching request`로 실패한다. | all |
| `exposure.relay.no-timeout-waits-until-close` | timeout이 없는 요청은 문서가 닫힐 때까지 기다린 뒤 1003으로 실패한다. | all |
| `exposure.window.dropped-view-work-reports-no-view` | 실행되기 전에 파괴된 웹뷰로 보낸 작업은 수신 오류 대신 결과 없음이 되어, `host.window`가 닫히는 모달을 뷰 없이 보고한다. 실행되어 실패한 작업은 그 오류를 유지한다. | tauriv2 only: Tauri는 웹뷰 작업을 dispatch로 실행하며 웹뷰가 파괴되면 작업을 버리고, Wails는 모달 뷰를 자기 기록에서 읽는다 |
| `exposure.window.region-reports-presented-frame` | 설정과 표시된 프레임 뒤 `host.window`는 영역의 `presented`에 그 프레임의 `generation`, `raster`, `sequence`를 보고한다. 래스터가 바뀐 뒤에는 새 래스터의 프레임이 표시되기 전까지 `presented`가 null이다. | all |
| `exposure.window.region-reports-presented-frames` | `host.window`의 각 image region 항목은 `presentedFrames`를 보고한다. 이는 region이 attach된 뒤 host가 presented로 표시한 그 region의 frame 수다. 새 region에서는 0이고, host가 presented로 표시하는 frame마다 하나 늘며, host가 presented로 표시하지 않는 frame과 raster 변경에는 바뀌지 않고, 같은 이름으로 다시 attach된 region에서는 다시 0이다. | all |
| `exposure.window.frame-counters-are-null` | `host.window`는 `frames`, `commandBuffers`, `settled`를 `null`로 보고하고, 각각 integer 또는 null, integer 또는 null, boolean 또는 null로 선언한다. WebKit이 host의 workbench를 그리므로 host는 그 frame도 command buffer도 세지 않기 때문이다. | all |
| `exposure.windows.closing-window-omitted` | `host.windows`는 닫기가 받아들여진 창을 조회하지 않고 목록에서 뺀다. | tauriv2 only: Tauri는 창마다 제목과 초점을 runtime에 묻는데, 닫기가 runtime에서 창을 지운 뒤 Destroyed 이벤트가 등록을 지우기 전에는 이 조회가 실패한다. Wails는 제목을 host 상태에서 읽고 초점 조회는 오류를 돌려주지 않는다 |
| `exposure.windows.open-window-query-failure-reported` | 열린 창의 제목이나 초점 조회가 실패하면 `host.windows`가 그 오류로 실패한다. | tauriv2 only: Tauri는 창마다 제목과 초점을 runtime에 묻는데, 닫기가 runtime에서 창을 지운 뒤 Destroyed 이벤트가 등록을 지우기 전에는 이 조회가 실패한다. Wails는 제목을 host 상태에서 읽고 초점 조회는 오류를 돌려주지 않는다 |
| `exposure.windows.entry-fields` | 목록의 창은 `ready`, `window`, `title`, `project`(프로젝트가 없으면 null), `key`를 가진다. | tauriv2 only: Tauri는 창마다 제목과 초점을 runtime에 묻는데, 닫기가 runtime에서 창을 지운 뒤 Destroyed 이벤트가 등록을 지우기 전에는 이 조회가 실패한다. Wails는 제목을 host 상태에서 읽고 초점 조회는 오류를 돌려주지 않는다 |
| `exposure.windows.listed-in-one-main-thread-step` | `host.windows`는 모든 창의 닫기 상태, 제목, 초점을 한 메인 스레드 단계에서 읽는다. 목록 중에 메인 스레드가 처리한 닫기는 그 창을 목록에서 빼거나 넣을 뿐 목록을 실패시키지 않는다. | tauriv2 only: Tauri는 창의 닫기를 메인 스레드에서 처리하고, 닫기가 runtime에서 지운 창의 제목이나 초점 조회를 답 없이 버린다. Wails는 제목을 worker에서 host 상태로 읽고, 초점 조회는 worker가 메인 스레드에 전달한 C 호출([hosts](hosts.ko.md#wails-host의-main-thread))에서 native 창을 읽는데 destroy가 이미 그 값을 nil로 바꾸었으므로 false를 돌려준다 |
| `flush.queue.rejects-send-when-full` | 사이드카가 읽지 않아 쓰기 대기열이 가득 차면 보내기가 실패한다. | all |
| `flush.queue.full-error-says-not-keeping-up` | 대기열이 가득 찬 오류는 "is not keeping up"을 적는다. | all |
| `flush.buffer.replies-delivered-after-drain` | 대기열이 가득 찬 동안 버퍼에 넣은 응답은 사이드카가 다시 읽은 뒤 도착한다. | all |
| `flush.buffer.closes-delivered-after-drain` | 대기열이 가득 찬 동안 버퍼에 넣은 표면 닫기 알림이 사이드카에 도착한다. | all |
| `flush.buffer.consumed-acks-not-coalesced` | 버퍼에 넣은 consumed 응답은 같은 이미지의 두 응답을 포함해 각각 한 번 도착한다. | all |
| `flush.buffer.delivered-after-queued-bodies` | 버퍼에 넣은 응답과 닫기 알림은 이미 대기열에 있던 본문 뒤에 도착한다. | all |
| `verification.flush-fixture.receives-before-cleanup` | Tauri drain scenario는 cleanup callback보다 먼저 receive callback을 호출한다. 이 test-only case는 child process나 sidecar queue를 검증하지 않는다. | tauriv2 only: 이 fixture는 Tauri sidecar test harness에 속한다 |
| `verification.trace-switch.requires-the-test-switch` | test switch를 쥐지 않고 performance trace를 전환하는 test는 첫 호출에서 실패한다. 이 test-only case는 전환 자체를 검증하지 않는다. | tauriv2 only: 이 guard는 Rust host의 lib test에 속한다 |
| `images.invalidate.sidecar-connection-loss-resends-configure` | 사이드카의 그림을 무효화하면 같은 크기의 configure 를 다시 보내고 다른 사이드카의 그림은 그대로 둔다. | all |
| `performance.trace.switch-accepts-on-and-off-only` | `performance` 호출은 동작 `on`과 `off`만 받으며, `line`을 포함한 다른 동작은 `action must be on or off`로 실패하고 아무것도 쓰지 않는다. | all |
| `performance.trace.switch-is-held-by-the-process` | 프로세스가 스위치를 가진다. `on`은 trace를 켜고 `off`는 끄며, 켜진 동안의 관측만 event `host.trace.on`과 `host.trace.off` 사이에 저장되고, 그 뒤에 파일 `performance`, 파일 `logs/performance.ndjson`, service 폴더의 flag는 없다. | all |
| `performance.sampler.ends-with-the-switch` | 표본 추출은 trace가 켜진 동안 돌고, 꺼지면 끝나며, 다시 켜면 새로 시작한다. | all |
| `performance.trace.switch-gates-every-host-trace-event` | switch가 꺼진 동안에는 log policy가 무엇을 저장하든 이름이 `host.trace.`로 시작하는 event를 저장하지 않는다. `host.trace.on`과 `host.trace.off`는 switch가 켜진 동안 저장된다. | all |
| `performance.trace.already-off-writes-nothing` | trace가 꺼져 있을 때의 `off` 요청은 event를 저장하지 않는다. | all |
| `performance.trace.host-observation-is-an-event` | trace가 켜져 있는 동안 host의 관측(layer `host` 또는 `sampler`)은 이름이 field에 반복되지 않는 level `debug`의 event `host.trace.<event>` 또는 `host.sampler.<event>`로 event log에 저장되며 trace 파일의 줄이 아니다. event 이름이 없는 관측은 오류 `performance trace`로 보고하고 아무것도 저장하지 않는다. | all |
| `performance.surface.dispatch-records-existing-boundaries` | performance trace가 켜져 있으면 surface `sync`와 `present` 경로의 기존 UI dispatch와 비동기 presentation callback마다 같은 host event clock으로 window, operation, stage, `queued_ns`, `entered_ns`, `returned_ns`를 담은 `host.trace.surface.dispatch`를 저장한다. 이미 배정된 layout ticket은 포함하고, 아직 ticket이 배정되지 않았으면 생략한다. `queued_ns`는 기존 dispatch 또는 callback 등록 직전, `entered_ns`는 UI closure 또는 callback 진입 시점, `returned_ns`는 종료 시점에 기록한다. 이 기록은 caller 재개 시간을 포함하지 않으며 dispatch를 추가하지 않는다. | all |
| `performance.surface.dispatch-records-frame-only-boundaries` | performance trace가 꺼져 있고 frame trace가 켜져 있으면 기존 surface dispatch마다 window, operation, stage와 `queued_ns`, `entered_ns`, `returned_ns`를 담은 `host.frame.surface.dispatch` 하나를 저장하며 중복 `host.trace.surface.dispatch` 기록은 만들지 않는다. | all |
| `performance.surface.dispatch-frame-fallback-is-exclusive` | surface dispatch는 performance trace gate가 열려 있으면 이를 사용하고, 아니면 frame trace gate가 열려 있을 때 frame tracing을 사용하며, 두 gate가 모두 닫혀 있으면 event clock을 읽지 않는다. `host.trace.surface.dispatch`와 `host.frame.surface.dispatch` 중 최대 하나의 경로로 기록한다. | all |
| `performance.surface.dispatch-records-the-raster-wait` | Presentation의 raster 단계는 다른 surface dispatch와 같은 gate와 clock으로 operation `present`, stage `present-raster-wait`를 기록한다. `queued_ns`는 raster refresh 직전, `entered_ns`는 raster 대기 시작, `returned_ns`는 대기 종료 시점이며, 대기가 실패해도 기록한다. Refresh가 실패하면 대기를 시작하지 않고 아무것도 기록하지 않는다. | all |
| `performance.surface.dispatch-names-its-surface` | surface 하나의 region과 overlay를 배치하는 UI dispatch는 operation `composition`, stage `composition-place-ui`, 그리고 surface 이름을 담은 `surface` 필드를 다른 surface dispatch와 같은 gate와 clock으로 기록한다. window layout의 dispatch는 `surface`를 기록하지 않는다. | all |
| `performance.sampler.failed-reading-is-explicit` | 상주 크기를 얻지 못한 sampler 읽기는 `rss_host_kb` 대신 `error`를 기록한다. | all |
| `performance.sampler.reads-every-registered-process` | trace가 켜져 있는 동안 표본 추출은 host와 프로세스 등록부의 각 process마다 `role`, `name`, `pid`, `rss_kb`를 담은 이벤트 `host.sampler.memory`를 하나씩 저장한다. process의 이름을 붙이면 이벤트 `host.trace.process`를 저장하고, 제거된 process는 다시 읽지 않으며, 크기를 읽을 수 없는 등록 process는 `rss_kb` 없이 `error`와 함께 저장한다. | all |
| `performance.sampler.names-the-sidecar-processes` | host가 시작한 사이드카 process와 연결한 상주 service는 process가 끝나거나 연결이 끝날 때까지 프로세스 등록부에 있다. | all |
| `performance.sampler.reads-every-window-process` | 표본은 등록된 각 window의 page process마다 `role` `page`, `window`, `pid`, `rss_kb`, `footprint_kb`를 가진 `host.sampler.memory` event 하나를, 각 document 웹 뷰(document region이나 view surface의 page)의 process마다 `role` `document`, `window`, `surface`, `document`, `pid`, `footprint_kb`를 가진 event 하나를 저장합니다. process가 아직 시작되지 않은 document region과 process를 읽을 수 없는 window는 `rss_kb` 없이 `error`로 저장됩니다. | all |
| `performance.sampler.divides-the-footprint` | host와 시작된 각 process의 sampler 읽기는 `footprint_kb`와 그 부분 `internal_kb`, `compressed_kb`, `purgeable_kb`, `graphics_kb`, `media_kb`, `network_kb`, `neural_kb`를 footprint와 한 번의 호출로 읽어 가지며, 실행 중인 process의 `internal_kb`는 0보다 큽니다. process가 아직 시작되지 않은 웹 뷰는 이 값을 하나도 갖지 않습니다. | all |
| `performance.surface.lifecycle-events-hold-the-geometry` | trace는 표면의 단계를 단계 `created`, `placed`, `destroyed`를 가진 이벤트 `host.trace.surface`로 저장하고, 단계 `placed`는 `x`, `y`, `w`, `h`, `visible`을 담는다. | all |
| `performance.clock.before-epoch-is-explicit` | 유닉스 epoch 이전의 trace 시각은 epoch가 아니라 오류다. | tauriv2 only: Rust host는 epoch부터의 기간으로 시각을 적으므로 그 이전에서 실패하고, Go는 모든 시각을 적는다 |
| `log.open.rotates-at-100mb` | 100 MB 이상인 로그 파일을 열면 먼저 `<이름>.1`로 옮기고 이전 세대를 하나씩 뒤로 옮기며 다섯째를 지우고 새 파일을 시작한다. | all |
| `log.open.appends-below-bound` | 더 작은 로그 파일을 열면 거기에 덧붙이고, 새 로그 파일은 mode 0600이다. | all |
| `platform.private.creates-owner-only-directories` | private directory 생성 연산은 경로에서 없는 모든 디렉터리를 mode 0700으로 만들고 이미 있는 디렉터리의 mode는 유지한다. | all |
| `platform.private.appends-owner-only-file` | private append 연산은 없는 파일을 mode 0600으로 만들고, 있는 파일에는 덧붙이며, 있는 파일의 mode는 유지한다. | all |
| `platform.private.creates-new-owner-only-file` | private 새 파일 연산은 없는 파일을 mode 0600으로 만들고, 이미 있는 경로에는 already-exists 오류로 실패한다. | all |
| `platform.private.writes-owner-only-file` | private write 연산은 없는 파일을 mode 0600으로 만들고, 있는 파일의 내용을 바꾸며, 있는 파일의 mode는 유지한다. | all |
| `platform.windows.input.pointer-phase-becomes-mouse-event` | pointer 입력은 DevTools 호출 `Input.dispatchMouseEvent`가 된다. move는 `mouseMoved`, press는 버튼과 `buttons`, `clickCount`를 담은 `mousePressed`, drag는 눌린 버튼을 담은 `mouseMoved`, release는 아직 눌린 버튼을 담은 `mouseReleased`, scroll은 delta를 담은 `mouseWheel`이다. | all |
| `platform.windows.input.pointer-breaking-press-rules-is-not-sent` | 버튼이 눌린 동안의 press, press 없는 drag나 release, click이 없거나 셋보다 많은 press, 모르는 phase와 모르는 버튼은 보내지 않는다. 그 press는 열린 press로, 나머지는 거절로 답한다. | all |
| `platform.windows.input.only-delivered-pointer-changes-press` | 전달된 press만 그 버튼의 press를 열고 전달된 release만 닫는다. drag는 그대로 둔다. | all |
| `platform.windows.input.pointer-held-by-another-pointer` | 한 pointer가 page의 press를 쥔 동안 다른 pointer의 move, press, drag, release는 그 pointer가 쥔 것으로 답하고, 그 scroll은 보내며, 쥔 pointer 자신의 drag는 보내고, 마지막 release 뒤에는 다른 pointer가 press한다. | all |
| `platform.windows.input.key-becomes-key-event` | 키는 key, code, Windows 가상 키 코드를 담은 DevTools 호출 `Input.dispatchKeyEvent`가 된다. 글자를 치는 키는 text를 담은 `keyDown`, 글자를 치지 않는 키나 Control, Alt, Meta가 붙은 키는 text 없는 `rawKeyDown`, 떼기는 `keyUp`이다. Shift와 입력기의 text는 친 글자를 유지하고, 어떤 키도 이름 붙이지 않는 글자는 text만 담아 보낸다. | all |
| `platform.windows.input.key-without-name-or-character-is-not-sent` | 키 이름도 한 글자도 아닌 키는 빈 키나 `Enterr`처럼 거절되고 보내지 않는다. | all |
| `platform.windows.input.queue-sends-one-call-at-a-time` | web view의 입력 queue는 DevTools 호출을 한 번에 하나씩 보낸다. 다음 호출은 앞 호출이 끝난 뒤에 시작하고, 각 호출은 끝날 때 답한다. | all |
| `platform.windows.input.queue-emulates-focus-before-first-input-only` | queue는 첫 입력 전에 `Emulation.setFocusEmulationEnabled` `{enabled: true}`로 page의 focus emulation을 켜고, 이후 입력에는 그 호출을 보내지 않는다. | all |
| `platform.windows.input.failed-call-answers-its-failure` | 실패로 끝난 호출은 그 실패를 호출자에게 답한다. | all |
| `platform.windows.input.unanswered-failure-goes-to-next-input` | 답할 호출자가 없는 호출의 실패는 다음 입력이 돌려주고, 그다음 입력은 받는다. | all |
| `platform.windows.input.call-that-cannot-start-answers-and-next-runs` | web view가 시작을 거절한 호출은 그 실패를 곧바로 답하고, 다음 호출은 보낸다. | all |
| `platform.windows.input.incomplete-call-ends-wait-and-stops-queue` | 기다리는 시간 안에 끝나지 않은 호출은 시간이 다 됐다고 답하고, 그 호출이 열린 동안 다음 입력은 `did not complete`로 실패하며, 늦은 완료는 아무것도 답하지 않고, 그 뒤 queue는 다시 보낸다. | all |
| `platform.windows.input.completed-call-ends-its-wait` | 끝난 호출은 기다림의 timer를 취소한다. | all |
| `platform.windows.input.call-answer-becomes-pointer-result` | pointer 호출의 답이 그 결과가 된다. 끝난 호출은 delivered, 시간이 다 된 호출은 unreceived, 실패한 호출은 rejected다. | all |
| `platform.windows.capture.view-that-does-not-draw-is-refused` | 최소화된 창, 보이지 않는 창, 숨은 view의 capture는 그 상태를 이름으로 든 실패로 거절하고, 보이는 view는 capture한다. | all |
| `platform.windows.capture.incomplete-capture-ends-its-wait` | 기다리는 시간 안에 끝나지 않은 capture는 가려진 view를 이름으로 든 실패를 답하고, 늦은 완료는 아무것도 답하지 않는다. | all |
| `platform.windows.capture.completed-capture-answers-once` | 끝난 capture는 한 번 답하고 기다림의 timer를 취소한다. | all |
| `platform.windows.capture.still-must-be-an-image` | still은 bytes가 PNG signature로 시작할 때만 받는다. 빈 bytes와 다른 bytes는 실패한다. | all |
| `platform.windows.mouse.mask-follows-raw-input-buttons` | button mask는 raw mouse 입력의 각 버튼 flag를 따른다. down은 그 버튼의 bit를 켜고 up은 끄며, 한 입력에 같은 버튼의 down과 up이 함께 있으면 bit는 꺼진 채이고, move나 wheel 입력은 버튼을 이름으로 들지 않고 mask를 유지한다. | all |
| `platform.windows.mouse.held-buttons-name-their-bits` | 시스템이 눌렸다고 보고한 버튼은 mask에서 그 버튼의 bit를 켠다. | all |
| `platform.windows.mouse.button-watch-reports-mask-from-its-start` | button watch는 시작할 때 눌린 mask를 보고하고, 그 뒤 각 버튼 입력 뒤의 mask를 보고한다. move나 wheel 입력은 아무것도 보고하지 않는다. | all |
| `platform.windows.mouse.second-button-watch-is-refused` | 첫 button watch가 도는 동안 두 번째 watch는 거절한다. | all |
| `platform.windows.mouse.drag-over-surface-reaches-window-in-order` | 감시하는 surface 위의 주 버튼 press는 pointer 아래 view와 함께 그 창에 닿고, press, 각 move, release가 위치와 함께 순서대로 surface에 닿는다. release 뒤의 move는 아무 데도 닿지 않는다. | all |
| `platform.windows.mouse.fast-click-still-ends-its-drag` | UI thread가 press를 돌리기 전에 도착한 press와 release도 surface에 press와 release로 닿는다. | all |
| `platform.windows.mouse.page-drag-never-wakes-ui-thread` | 감시하는 surface가 아니라 page 위에서 시작한 drag는 UI thread에 단계를 보내지 않고 어느 surface에도 닿지 않는다. | all |
| `platform.windows.mouse.move-without-position-change-wakes-nothing` | drag 중 위치를 바꾸지 않는 move나 wheel 입력은 단계를 보내지 않는다. | all |
| `platform.windows.mouse.press-over-another-window-is-not-delivered` | 감시하지 않는 창이나 창이 없는 곳의 press와 그 release는 전달하지 않는다. | all |
| `platform.windows.mouse.primary-button-follows-system-exchange` | 시스템이 마우스 버튼을 바꿔 두면 오른쪽 버튼이 주 버튼이다. 그 버튼이 drag를 시작하고, 왼쪽 버튼은 hit를 읽지 않는다. | all |
| `platform.windows.mouse.secondary-button-is-no-drag` | 감시하는 surface 위의 보조 버튼 press는 drag를 시작하지 않는다. | all |
| `platform.windows.mouse.removed-watch-takes-no-input` | 제거된 창의 watch는 press, 단계, release를 받지 않는다. | all |
| `platform.windows.mouse.read-failure-is-reported-and-release-ends-drag` | drag 중 위치를 읽지 못하면 입력마다 그 실패를 보고하고, release는 마지막으로 읽은 위치에서 drag를 끝낸다. | all |
| `platform.windows.mouse.unreadable-hit-is-reported` | hit를 읽지 못한 press는 그 실패를 보고하고 어느 surface에도 닿지 않는다. | all |
| `platform.windows.ui-queue.tasks-run-in-order-once` | UI queue의 task는 들어온 순서대로 한 번씩 돌고, UI thread의 단계 전에는 하나도 돌지 않는다. | all |
| `platform.windows.ui-queue.task-queued-by-task-waits-for-later-step` | 도는 task가 넣은 task는 그것을 넣은 단계가 아니라 다음 단계에 돈다. | all |
| `platform.windows.ui-queue.refused-task-never-runs` | queue가 거절한 task는 곧바로 실패하고 돌지 않으며, 나중 task는 받아서 돈다. | all |
| `platform.windows.ui-queue.refuses-before-its-thread` | UI thread가 시작하기 전에 queue는 task를 `the UI thread has not started`로 거절하고, 지연 task는 timer를 시작하지 않고 거절한다. | all |
| `platform.windows.ui-queue.delayed-task-runs-as-step-after-wait` | 지연 task는 timer에 기다릴 시간을 요청하고, timer가 울린 뒤 UI thread의 첫 단계에서 돈다. timer의 thread에서는 돌지 않는다. | all |
| `platform.windows.ui-queue.refused-delayed-task-enters-later` | timer가 울릴 때 queue가 거절한 지연 task는 한 번 보고되고 재시도 시간 뒤 다시 들어가며, 그 뒤 한 단계에서 돈다. | all |
| `platform.windows.ui-queue.negative-delay-is-refused` | 기다릴 시간이 음수인 지연 task는 거절하고 timer를 시작하지 않는다. | wailsv3, mygo only: Rust task의 지연은 음수 값이 없는 `Duration`이다 |
| `platform.windows.show.only-foreground-shows-with-activation` | 창은 이 application이 foreground를 가진 동안에만 활성화하며 보이고, 그 밖에는 활성화하지 않고 보인다. | all |
| `platform.windows.show.position-change-keeps-the-front` | foreground 밖에서 창을 보이는 위치 변경에는 활성화 안 함과 z-order 유지를 더해 앞 창이 앞에 남는다. foreground 안의 show와 아무것도 보이지 않는 변경은 요청한 그대로 둔다. | tauriv2 only: tao는 host가 고쳐 쓰는 위치 변경으로 창을 보이고, Go host들은 host의 show로 창을 보인다 |
| `platform.windows.page-process.failure-kind-decides-the-page` | WebView2의 browser process나 render process가 끝나면 page가 끝나고, 다른 종류의 process 실패는 page를 유지한다. | all |
| `log.application.start-replaces-standard-error` | 애플리케이션 로그를 시작하면 실행의 첫 줄을 쓰고 그 파일을 프로세스와 그 프로세스가 시작하는 자식의 표준 오류로 만든다. | all |
| `log.error.line-form` | 헬퍼로 쓴 호스트 오류는 애플리케이션 로그의 기록 `<time> error host <where>: <text>`다. | all |
| `log.transcript.line-reaches-the-application-log` | 창의 진단 기록 줄은 `info host transcript <window>: <line>`으로도 쓰고, Wails host는 진단 기록이 싣는 오류를 `error host <operation> <window>: <error>`로도 써서, 진단 기록을 요청한 연결이 없어도 그 줄이 남는다. | all |
| `log.page.clock-anchor-passes-default-policy` | Writer는 기본 lifecycle/error 정책에서 view page의 `page.log.clock`과 workbench의 `workbench.log.clock` 시각 metadata를 저장하고 일반 lifecycle/info event는 계속 거부한다. | all |
| `log.workbench.fixture-step-passes-default-policy` | Writer는 기본 lifecycle/error 정책에서 각 workbench.fixture.step event(lifecycle/info)를 저장하며, 진단 시험 표지와 같다. | all |
| `log.info.record-form` | `LogInfo`(Go)나 `log_info`(Rust)로 쓴 호스트 관측은 애플리케이션 로그의 기록 `<time> info host <where>: <text>`다. | all |
| `log.record.one-line` | 기록은 한 줄이다. 본문의 줄바꿈은 두 글자 `\n`으로 쓰고, 시각을 뺀 항목은 `<level> <layer> <where>: <text>`다. | all |
| `sidecars.disconnect.record-end` | 영속 서비스 연결의 `host.sidecar.disconnect` 기록은 연결이 어떻게 끝났는지(`end`: `eof`, `unfinished line`, `read error: <text>`, `violation`)와 그 연결을 기다리던 요청 수(`waiting`)를 담는다. 서비스의 종료 상태는 기록하지 않는다. 호스트가 그 프로세스를 소유하지 않기 때문이다. | all |
| `sidecars.trace.relay-records-every-message-with-its-body` | performance trace가 켜진 동안 host가 sidecar로 보내는 각 요청은 event log의 event `host.trace.sidecar.send`, 받는 각 메시지는 `host.trace.sidecar.receive`이며, field에 `sidecar`, `surface`, 본문 전체를 담는다. | all |
| `sidecars.receive-trace.records-before-dispatch` | Tauri sidecar receive trace callback은 처리되는 message와 일반 message에서 각각 한 번 실행되며 native image dispatch보다 먼저 실행된다. 일반 message는 page 전달에 계속 사용할 수 있다. | tauriv2 only: Rust receive hook의 trace 관찰과 native dispatch 순서를 검증한다 |
| `sidecars.trace.first-answer-after-spawn-is-recorded` | host가 spawn한 sidecar마다 event `host.trace.sidecar.ready`(level `debug`)를 남기며, 필드 `sidecar`, `pid`, `ms`를 담는다. `ms`는 spawn부터 그 프로세스가 보낸 첫 메시지 줄까지의 밀리초다. spawn마다 한 번 남기며, 다른 host가 시작한 프로세스는 아무것도 남기지 않는다. | all |
| `sidecars.lifetime.start-and-exit-events` | 호스트가 시작하는 표준 입출력 사이드카 프로세스마다 `name`과 `pid`를 가진 event `host.sidecar.start`가 있고, 그 종료는 `name`, `pid`, `status`(`exit status <code>` 또는 `signal <number>`), 호스트가 멈추는 중이었는지 알려 주는 `stopping`을 가진 event `host.sidecar.exit`다. | all |
| `sidecars.display-name.requires-canonical-component` | 사이드카 선언에는 `displayName`이 필요하며 `soksak://sidecar/<lowercase-id>` 형식의 component 하나여야 한다. 누락, 문자열이 아닌 값, 잘못된 scheme 또는 role, 추가 path component, 대문자 id는 거부된다. 없거나 null인 값은 `displayName is required`로, 다른 값은 `displayName must be soksak://sidecar/ followed by one lowercase identifier`로 거부된다. 그 sidecar는 선언되지 않고 생성은 성공하며, 그 sidecar에 대한 요청은 `sidecar <name>: <sidecar.json 경로>: <reason>`으로 실패한다. | all |
| `sidecars.display-name.is-not-injected-into-child-environment` | 호스트는 자식 프로세스에 이미 있는 `SOKSAK_SIDECAR_DISPLAY_NAME` 값을 선언의 `displayName`으로 덮어쓰지 않는다. | all |
| `sidecars-transport.persistent.connection-events` | host가 영구 service에 연결할 때마다 `name`, service `pid`, `spawned`를 가진 event `host.sidecar.connect`가 있고, 그 끝은 `name`, `pid`, `stopping`, 위반 문구 `violation`(service가 연결을 닫았으면 빈 문자열)을 가진 event `host.sidecar.disconnect`다. | all |
| `windows.events.window-event-is-recorded` | 창 event는 `window`와 `kind`(`resize`, `move`, `scale_factor_changed`, `show`, `hide`, `occlusion_changed`, `focus`, `lost_focus`, `close_requested`, `closed`, `web_process_ended`, `navigation_committed`, `window-active`)를 가진 event `host.window.event`이며, `resize`, `move`, `scale_factor_changed`는 level `debug`, 나머지는 `info`다. 목록에 없는 kind는 표준 오류에 보고하고 아무것도 저장하지 않는다. | all |
| `application.window.scale-change-refreshes-rasters` | window의 backing scale이 바뀌면 그 window의 image raster refresh가 시작되고, window가 움직이기만 하면 시작되지 않는다. | all |
| `application.window.closed-window-places-no-main-web-view` | 닫힌 뒤에 창이 보고한 resize나 show는, quit가 닫는 동안 full screen을 떠나는 창의 경우처럼, main web view를 배치하지 않는다. 그래서 실패한 배치가 quit가 끝나기 전에 process를 끝내지 않는다. | wailsv3 only: Go language host library는 창의 resize와 show마다 main web view를 배치하며, Go host 중 main page가 있는 것은 Wails뿐이다. Rust language host library는 창을 등록할 때 한 번만 main web view를 배치한다 |
| `application.window.gone-window-reads-no-state-on-change` | native window가 사라진 뒤 창이 보고한 변경은 그 창의 상태를 읽지 않고 오류를 보고하지 않는다. | wailsv3, mygo only: Rust host는 region을 만들 때만 창의 on-screen 상태를 읽으므로, 닫힌 창의 변경은 거기서 아무것도 읽지 않는다 |
| `application.events.app-event-is-recorded` | 애플리케이션 event는 `kind`(`started`, `activated`, `deactivated`, `exit_requested`, `exit`)를 가진 event `host.app.event`이며 level은 `info`다. 목록에 없는 kind는 표준 오류에 보고하고 아무것도 저장하지 않는다. | all |
| `application.launch.system-decides-activation` | host는 다른 애플리케이션이 active인 동안 실행을 마칠 때 스스로 activate하지 않으므로 Launch Services가 실행의 activation을 결정한다([launch activation](hosts.md#launch-activation)). | all |
| `application.window.opens-without-taking-the-front` | 시스템이 active 로 보는 애플리케이션의 window 는 앞으로 온다. 시스템이 active 로 보지 않는 애플리케이션은 보이는 window 를 앞 window 뒤에 두고 앞 애플리케이션을 그대로 둔다([launch activation](hosts.md#launch-activation)). | all |
| `application.window.show-reaches-the-registered-platform-before-the-host-starts` | host 의 start 가 platform 을 고르지 않았어도 framework window 의 show 는 등록된 platform 에 닿는다([launch activation](hosts.md#launch-activation)). | wailsv3, mygo only: Go framework 는 보이는 window 마다 Go language host library 의 `ShowWindow` 에 넘기고, `ShowWindow` 는 `platform.Register` 가 등록한 platform 에 묻는다. Rust language host library 는 platform 을 등록하지 않는다. `platform::current` 가 build 가 그 operating system 용으로 compile 한 구현을 돌려주고, Tauri framework adapter 는 그 구현으로 window 를 보인다 |
| `platform.native-provider.first-operation-initializes-it-once` | host 시작 전의 `ShowWindow`를 포함해 첫 native 작업이 framework adapter가 설치한 native provider를 초기화하고, 이후 작업은 그 초기화를 다시 쓴다. provider가 설치되지 않았으면 show마다 `framework adapter has not installed its native provider`로 실패하고, 실패하는 provider는 한 번만 실행되며 show마다 그 실패를 돌려준다. | wailsv3, mygo only: 공유 Go platform은 framework adapter가 설치한 typed native provider를 초기화하고, Rust는 build 때 native 선언을 link하므로 runtime provider가 필요 없다(host tree의 H64 행) |
| `application.window.show-without-a-registered-platform-ends-through-the-fatal-error` | 등록된 platform 이 없을 때 framework window 의 show 는 panic 없이 host 의 fatal error 로 process 를 status 1 로 끝낸다. | wailsv3, mygo only: run time 에 platform 을 등록하는 것은 Go language host library 뿐이다. Rust language host library 의 `platform::current` 는 build 가 그 operating system 용으로 compile 한 구현을 돌려주므로 Tauri host 의 show 에는 빠질 수 있는 등록이 없다 |
| `application.window.no-main-page-calls-no-main-web-view` | Main page가 없는 framework의 창은 main web view operation을 호출하지 않는다. Library는 main web view를 배치하지 않고 load 뒤에 창을 드러내지 않는다. | wailsv3, mygo only: the Go language host library tests it with a fixture framework; the Rust language host library has no framework without a main page |
| `application.window.no-main-page-stages-no-page-script` | Library는 main page가 있는 framework에서만 staged 프런트엔드의 background script를 읽으므로, main page가 없는 framework의 view root가 시작한다. | wailsv3, mygo only: the Go language host library tests it with a fixture framework; the Rust language host library has no framework without a main page |
| `application.window.no-main-page-starts-without-the-page-title-bar` | main page 없는 framework의 창은 page의 title bar transaction을 시작하지 않는다. workbench가 시작할 때마다 아직 아무 프레임도 보이지 않는 창의 title bar는 common settings의 첫 줄 높이를 곧바로 받고, 화면에 나온 적 있는 창은 직전 workbench의 마지막 프레임의 title bar를 유지하며, 어느 쪽이든 시작은 그 설정을 검사한다. 그 뒤의 첫 줄 높이는 workbench가 layout과 함께 준다. | wailsv3, mygo only: Go language host library는 fixture framework로 시험하고, Rust language host library에는 main page 없는 framework가 없다 |
| `application.window.closed-start-sets-no-title-bar` | 닫힌 창에 닿은 workbench 시작의 title bar 단계는 main page 가 있든 없든 native 창을 건드리지 않고, 시작 창이 없다는 오류로 실패한다. | wailsv3, mygo only: Go language host library는 fixture framework로 시험하고, Rust language host library에는 main page 없는 framework가 없다 |
| `application.window.no-main-page-start-fails-with-its-reason` | main page 없는 창의 workbench 시작은 시작 문서 요청처럼 실패한 시작 단계의 이유로 실패한다. 열린 layout을 취소하지 못한 창은 `page reload: <reason>`으로 실패한다. | wailsv3, mygo only: Go language host library는 fixture framework로 시험하고, Rust language host library에는 main page 없는 framework가 없다 |
| `application.framework.names-the-application` | framework adapter는 `endpoint.json`, endpoint socket의 이름, application update의 release key, debug view의 state file이 담는 application을 정한다. Wails host는 `wailsv3`이고 Tauri host는 `tauriv2`다([host tree](hosts.md#host-tree)). | all |
| `application.framework.window-events-are-port-events` | framework adapter는 language host library가 관찰하는 framework의 각 window event를 `Frontend` port의 window event로 알린다([host tree](hosts.md#host-tree)). | all |
| `application.framework.lengths-are-logical-pixels` | `Frontend` port는 크기와 위치를 logical pixel로 받고 주며, framework가 정수를 가지는 framework adapter는 각 길이의 가장 가까운 정수를 framework에 준다([host tree](hosts.ko.md#호스트-트리)). | wailsv3, mygo only: Wails와 mygo는 길이를 정수로 가지고, Tauri는 logical 길이를 부동소수점 수로 가진다. |
| `mygo.framework.start-builds-the-workbench` | adapter의 시작은 workbench 없이 실패하고, 창은 workbench와 함께 숨겨진 채 시작하며, `StartWorkbench`는 workbench를 닫고 다시 만든다. workbench는 그 창의 첫 frame 뒤에 시작하며, 보여진 창에서 다시 시작한 workbench는 첫 화면 전에 frame을 그리지 않으며, 창은 workbench의 첫 화면 frame과 함께 화면에 올라간다. | mygo only: mygo framework adapter를 직접 시험하며, 다른 adapter에는 그 framework가 없다 |
| `mygo.framework.failed-start-shows-its-failure` | 창이 열린 layout을 취소하지 못한 경우처럼 host가 거절한 workbench 시작은 workbench에 시작했다고 알리지 않는다. adapter는 이유를 place `workbench start`의 `error` record로 쓰고 workbench에 실패를 알리며(`StartFailed`), workbench는 host를 호출하지 않고 이유를 오류 표시에 첫 화면으로 보이며 창이 ready라고 알리지 않는다([page 시작](native-host.ko.md#page-시작)). | mygo only: mygo framework adapter를 직접 시험하며, 다른 adapter에는 그 framework가 없다 |
| `mygo.framework.start-tells-whether-the-window-shows-a-frame` | workbench 시작은 창이 화면에 올라갔는지를 host에 알린다. 그래서 보여진 창에서 다시 시작한 workbench는 창이 hold한 frame의 제목줄을 유지하고, 아직 frame을 보이지 않는 창은 설정의 행을 바로 받는다([제목줄 높이](native-surfaces.ko.md#제목줄-높이)). | mygo only: mygo framework adapter를 직접 시험하며, 다른 adapter에는 그 framework가 없다 |
| `mygo.framework.closed-window-start-ends-without-a-failure` | 실행 중에 창이 닫힌 workbench 시작은 시작 창을 지목하지 않으며, 그 창에는 실패를 보일 화면이 없으므로 adapter는 workbench에 실패를 알리지 않는다. | mygo only: mygo framework adapter를 직접 시험하며, 다른 adapter에는 그 framework가 없다 |
| `mygo.framework.steps-and-quit` | `Step`과 `Post`는 main thread에서 순서대로 돌고, quit은 quit listener를 거쳐 application을 끝낸다. | mygo only: mygo framework adapter를 직접 시험하며, 다른 adapter에는 그 framework가 없다 |
| `mygo.framework.window-operations` | adapter의 창은 제목, 크기와 위치, 최대화 상태를 바꾸고, closing hook은 창을 유지하거나 닫으며, dialog는 그 창에 붙는다. 닫힌 창의 scale 읽기는 닫힌 창의 오류를 주고 native code를 부르지 않는다. | mygo only: mygo framework adapter를 직접 시험하며, 다른 adapter에는 그 framework가 없다 |
| `mygo.framework.dock-menu-has-the-new-window-item` | adapter의 Dock menu에는 새 창 항목이 있다. | mygo only: mygo framework adapter를 직접 시험하며, 다른 adapter에는 그 framework가 없다 |
| `mygo.framework.events-and-calls-reach-the-workbench` | 창의 event와 call은 그 창의 workbench에 닿는다. | mygo only: mygo framework adapter를 직접 시험하며, 다른 adapter에는 그 framework가 없다 |
| `mygo.framework.frame-reports-reach-the-counters` | layout observer는 창의 transaction을 보고하고, preparation은 frame을 요청할 때까지 그 창의 frame을 hold하며, 창의 frame 보고는 그 counter에 닿으며, 보여진 창은 frame을 센 뒤 더 그리지 않는다. | mygo only: mygo framework adapter를 직접 시험하며, 다른 adapter에는 그 framework가 없다 |
| `mygo.framework.frame-opens-the-layout` | frame은 창이 그 frame을 build하고 frame을 hold하지 않는 동안에만 그 창의 layout을 열고, layout transaction 안의 frame은 layout을 열지 않는다. 연 frame은 창에 frame을 요청하지 않는다. transaction 안에서 present했거나 scene이 바뀌지 않았으면 그 frame이 transaction의 frame이 되고, drawable을 기다리거나 찾지 못한 frame은 preparation이 자기 frame을 요청하게 두며, capture의 frame은 layout을 다음 frame에 넘기고, 자기가 연 layout이 끝난 뒤의 frame 보고는 아무것도 바꾸지 않는다. | mygo only: frame을 보고하는 framework는 mygo뿐이다([framework 변경](hosts.ko.md#framework-변경)의 U7) |
| `mygo.framework.preparation-hears-the-presented-frame` | transaction 안에서 present한 frame의 layout을 넘겨받은 preparation, 또는 그 transaction의 frame 뒤에 온 preparation은 그 frame을 바로 듣는다. trace는 요청 하나와 presentation 하나를 기록하고, 창은 hold를 유지하며, 두 번째 frame이 commit을 기다리지 않는다. | mygo only: frame을 보고하는 framework는 mygo뿐이다([framework 변경](hosts.ko.md#framework-변경)의 U7) |
| `mygo.menu.set-menu-builds-the-application-menu` | `SetMenu`는 menu를 application에 설치하고, 알 수 없는 role이나 modifier를 가진 항목은 menu를 만들지 않는다. | mygo only: mygo framework adapter를 직접 시험하며, 다른 adapter에는 그 framework가 없다 |
| `mygo.presentation.notice-answers` | drawable을 찾지 못한 frame은 다시 묻고 그 notice에 답하며, damage 없는 frame은 presented로 세고, held frame은 호출자가 기다리지 않으면 실패하고 그렇지 않으면 창의 release 뒤에, 또는 release가 따르지 않는 창의 close 때 다시 묻는다. 실패한 frame은 그 실패를 돌려주고, 닫힌 창은 wait를 끝내며, notice 뒤에 실패한 ask는 `done`에 닿는다. | mygo only: frame의 presentation을 보고하는 framework는 mygo뿐이다([framework 변경](hosts.ko.md#framework-변경)의 U3) |
| `mygo.system.file-drop-reaches-the-workbench` | 창에 놓은 파일은 file drop view의 텍스트로 workbench에 닿고, 더 이상 해석되지 않는 경로의 drop은 거절된다. | mygo only: mygo framework adapter를 직접 시험하며, 다른 adapter에는 그 framework가 없다 |
| `mygo.system.notification-events-reach-the-workbench` | notification center의 event는 workbench에 닿는다. | mygo only: mygo framework adapter를 직접 시험하며, 다른 adapter에는 그 framework가 없다 |
| `mygo.system.update-replaces-the-bundle` | application update는 application을 끝내고 그 bundle을 교체하는 명령을 시작한다. | mygo only: mygo framework adapter를 직접 시험하며, 다른 adapter에는 그 framework가 없다 |
| `mygo.benchmark.empty-window-reads-the-window` | 빈 창 benchmark는 세 host benchmark의 창을 읽고, 읽기에 실패하면 끝나며, 인수를 받고, JSON 한 줄을 보고하고, `footprint`의 출력에서 footprint를 읽는다. | mygo only: 이 benchmark는 mygo framework의 창을 실행한다 |
| `mygo.native-callbacks.incomplete-profile-allocates-no-address` | `Bind`와 `BindDiagnostic`은 함수가 하나라도 빠진 callback profile을 거부하며 거부하는 동안 callback 주소를 할당하지 않는다. 그래서 pool의 2000개 주소보다 많은 2001번의 거부도 모두 거부로 끝난다. | mygo only: mygo adapter는 cgo 없이 native callback을 bind하고, Wails는 cgo로 등록하며 Tauri는 Rust 함수 주소를 쓴다(host tree의 H61 행) |
| `mygo.native-callbacks.preserve-the-declared-abi` | `Bind`와 `BindDiagnostic`이 만든 base와 diagnostic callback table은 native table의 크기와 field offset을 갖고, 두 번째 bind는 거부되며, native library는 각 table을 한 번 받아들이고 교체를 거부한다. native 호출은 43개 callback 각각에 선언 순서대로 한 번씩 닿고, scalar·pointer·output 인수는 그대로이며 정수 token은 Go stack 확장과 garbage collection을 거쳐도 그대로다. | mygo only: mygo adapter는 cgo 없이 native callback을 bind하고, Wails는 cgo로 등록하며 Tauri는 Rust 함수 주소를 쓴다(host tree의 H61 행) |
| `mygo.native-callbacks.run-on-the-framework-worker` | mygo framework lifecycle 동안 native main-thread code가 부른 callback은 현재 framework step의 worker thread에서 token과 함께 실행되고, 그 안에 중첩된 main-thread 호출과 넘겨진 presentation completion은 native main thread에서 실행되며, 빌린 native 입력은 중첩 호출을 거쳐도 유효하고, framework는 끝에 정상적으로 돌아온다. | mygo only: 생성된 cgo 없는 callback binding은 mygo main-thread worker를 거쳐 실행되고, Wails와 Tauri는 이 foreign-call binding을 쓰지 않는다(host tree의 H62 행) |
| `mygo.test-application.native-startup-failure-precedes-the-tests` | `SOKSAK_NATIVE_LIBRARY`가 load되지 않는 library를 가리키는 mygo adapter의 test process는 선택된 test를 실행하기 전에 그 library를 이름으로 밝힌 실패로 끝나며 panic하지 않는다. | mygo only: `SOKSAK_NATIVE_LIBRARY`가 가리키는 dynamic native library는 mygo adapter만 load하고, Wails와 Tauri는 build 때 native library를 link한다 |
| `sidecars.protocol.request-line-carries-cids` | 입력을 이어받는 페이지 요청은 `root`와 `body` 사이에 필드 `cids`(상관 식별자, 순서대로)를 가진 요청 줄로 사이드카에 가고, 입력을 이어받지 않는 요청에는 `cids` 필드가 없다. | all |
| `sidecars.protocol.request-with-cids-is-recorded` | `cids`를 가진 페이지 요청은 그 `cids`, 사이드카의 `name`, `surface`, body 크기 `bytes`를 가진 level `info`의 event `host.sidecar.request`가 되고, `cids`가 없는 요청은 이 event를 저장하지 않는다. | all |
| `sidecars.protocol.reply-cids-reach-the-owner` | 줄이 `cids`를 밝힌 sidecar의 메시지는 그 `cids`와 함께 surface의 owner에게 간다. `sidecar-message` event와 host가 view에 post하는 메시지 모두, 표준 입출력 transport와 persistent 연결 모두 같다. `cids`가 없는 메시지에는 없다. | all |
| `sidecars.protocol.reply-with-cids-is-recorded` | 줄이 `cids`를 밝히거나 body가 `error` member를 가진 객체인 sidecar의 메시지는 event `host.sidecar.reply`이다. `name`, `surface`, body 크기 `bytes`, `ok`(`error`이면 false), 줄의 `cids`, 그 첫 번째 요청을 host가 기억하면 `micros`, 오류이면 `error` `-32603: <text>`(문자열 오류는 그 글, 다른 값은 JSON 글)를 level `warn`(오류가 없는 reply는 `info`)으로 가진다. 둘 다 없는 메시지는 이 event를 저장하지 않는다. | all |
| `sidecars.protocol.failure-fails-the-pending-requests` | sidecar의 실패는 기다리는 요청이 있는 surface마다 level `warn`에 `ok: false`, `bytes: 0`, `error` `-32603: <reason>`(page가 받는 이유)과 그 요청들의 `cids`를 가진 event `host.sidecar.reply`를 저장한다. | all |
| `log.input.region-event-with-cids-is-recorded` | JSON에 `cids`가 있는 image region event는 그 `cids`, region의 `surface`와 `name`, event의 `type`을 가진 level `info`의 event `host.input.relay`가 된다. `cids`가 없는 region event는 `host.input.relay`를 저장하지 않는다. | all |
| `sidecars.stderr.lines-are-written-as-records` | 표준 입출력 사이드카의 표준 오류 각 줄과 줄바꿈 없이 끝난 마지막 글은 기록 `<time> info sidecar <name>: <line>`으로 쓴다. | all |
| `log.panic.records-an-event` | 진입점(`routine.Go`, `spawn_named`)으로 시작한 goroutine이나 스레드가 panic하면 프로세스가 0이 아닌 상태(Go는 2, Rust는 101)로 끝나기 전에 받은 `name`, panic 값 `text`, `stack`을 담은 `error` 수준 event `host.panic` 하나와, 그 뒤에 그 상태를 `code`로 담은 원인 `exit`의 `log.closed`를 저장한다. | all |
| `log.panic.does-not-wait-for-the-writer` | panic hook은 writer가 멈춰 있어도 writer를 기다리지 않고 panic한 스레드에 돌아오며, writer가 풀리면 event가 저장되고 프로세스가 끝난다. | tauriv2 only: goroutine의 panic은 진입점이 recover하며 hook이 없다 |
| `log.panic.before-writer-is-stored-when-the-writer-opens` | writer가 붙기 전의 host panic은 시작 buffer에 남고, writer가 붙으면 event가 저장되고 저장 뒤 프로세스가 상태로 끝난다. 5초 안에 붙은 writer가 없으면 프로세스는 상태로 끝나고 record와 stack이 표준 오류에 남는다. | all |
| `log.panic.without-writer-is-written-to-the-standard-error` | writer가 저장하지 못한 panic은 표준 오류에 전부 쓰인다. writer가 열리지 않았다는 줄 뒤에 `host.panic name=<name> text=<text>` 줄과 stack이 온다. | all |
| `host.stall.passes-every-gate` | stall 기록 `host.stall`, `host.stall.sampled`, `host.stall.dump`는 lifecycle 기록을 끄는 policy에서도 저장된다. 로깅 명세의 이름 붙은 gate 예외로 모든 gate를 `warn`에서 지나가기 때문이다. | all |
| `host.crash.found.passes-every-gate` | crash 기록 `host.crash.found`는 lifecycle 기록을 끄는 policy에서도 저장된다. 명세의 이름 붙은 gate 예외로 `warn`에서 모든 gate를 지나기 때문이다. | all |
| `host.view.killed.passes-every-gate` | 종료 기록 `host.view.killed`는 lifecycle 기록을 끄는 policy에서도 저장된다. 명세의 이름 붙은 gate 예외로 `warn`에서 모든 gate를 지나기 때문이다. | all |
| `host.view.killed.is-written-on-every-end` | host가 종료를 관찰하는 view(process가 끝난 뒤 kill, surface 또는 window와 함께 close)는 자기 plugin, 자기 surface와 `unsent` true를 담은 `host.view.killed`를 종료마다 한 번 저장한다. 살아 있는 view가 없는 surface는 아무것도 저장하지 않는다. 성공한 메시지 전달은 살아 있는 view를 끝내거나 종료 record를 저장하지 않는다. | all |
| `host.locks.poisoned-state-is-recovered` | poisoned lock은 가지고 있던 상태와 함께 복구되고 연산이 끝난다. host의 panic hook이 panic을 기록한다. 로깅 명세의 하나뿐인 방식이다. | tauriv2 only: Go mutex는 poison되지 않는다 |
| `host.runtime.async-workers-and-blocking-threads` | host의 비동기 runtime은 worker 둘을 가지고, command burst가 시작한 blocking thread는 마지막 task 1초 뒤에 끝난다. | tauriv2 only: goroutine에는 이런 runtime이 필요 없다(host tree의 행 H44) |
| `log.fatal-signal.writes-an-error-line` | 애플리케이션 로그를 연 뒤 host process가 fatal signal을 받으면 그 signal로 process가 끝나기 전에 `error: fatal: <signal name>`을 한 번 쓴다. | tauriv2 only: Go runtime은 fatal signal을 스스로 처리하고 보고를 crash file에 쓴다(`log.fatal-error.writes-the-crash-file`) |
| `log.fatal-error.writes-the-crash-file` | event log를 연 뒤 host의 runtime fatal error는 출력을 `logs/host-<boot>.crash`에 쓰고 process를 `SIGABRT`로 끝낸다. 그래서 시스템이 모든 thread의 native frame을 담은 crash report를 쓴다. | wailsv3, mygo only: Rust host에는 runtime fatal error가 없으며, fatal signal은 `log.fatal-signal.writes-an-error-line`을 따른다 |
| `test-support.crash-reports.removes-only-the-saved-report` | 의도한 crash를 검사하는 test가 쓰는 crash report watch는 자기 process의 저장된 report `<application>-<time>.ips`를 지우고, 시스템이 rename하기 전에 report를 쓰는 숨김 파일은 지우지 않는다. | all |
| `test-support.crash-reports.child-runs-under-a-name-of-its-run` | 의도한 crash를 검사하는 test의 child는 test 실행 파일의 복사본을 그 run의 이름으로 실행한다. 시스템은 한 process 이름의 crash report가 25개에 이르면, test가 지운 report까지 세어, 더 쓰지 않기 때문이다. | all |
| `log.binding-failure.returned-not-logged` | 실패한 binding 호출은 framework transport의 log 줄 없이 page로 돌아가므로 page가 그 실패를 한 번 기록한다. | wailsv3 only: Wails HTTP transport가 binding 호출을 나르고, Tauri invoke는 돌려준 오류에 log 줄을 쓰지 않는다 |
| `log.service.standard-error-goes-to-service-log` | 호스트가 시작한 영속 서비스는 표준 오류를 `logs/<실행 파일 이름>.log`에 쓴다. | all |
| `log.service.open-failure-fails-start` | 서비스 로그를 열 수 없으면 `sidecar <name>: service log: <error>`로 시작을 실패시키고 서비스를 시작하지 않는다. | all |
| `images.detach.ack-consumed` | 유효한 `image.detached` 응답은 root, `image` 내부, acknowledgement object 내부의 무관한 더 깊은 JSON member가 `Value` materialization 깊이를 초과해도 host가 소비하며 page에 전달하지 않는다. | all |
| `images.relay.preserves-compose-marked-range` | image event를 전달할 때 compose `markedRange`와 소유 surface 및 region을 보존한다. | all |
| `images.detach.ack-exact-owner` | request, supplier, surface, image name, generation이 일치하는 응답만 detach를 완료한다. 불일치 응답은 대기를 끝내지 않는다. | all |
| `images.detach.malformed-ack-names-its-member` | member가 없거나 다른 type인 응답은 그 member를 밝히는, 두 호스트에서 같은 오류 text로 거부되고 그 pending detach는 계속 기다린다. | all |
| `images.detach.refusal-ends-pending` | supplier 거부는 pending detach를 끝낸다. 그 surface의 `image-detach-ended` event는 supplier가 알리면 현재 generation을 담은 `... rejected: <reason>`을 담고, 여러 image의 실패는 이름의 byte 순서로 `; `로 이어지며, 호스트는 그 실패의 오류 기록을 쓰지 않는다. | all |
| `images.detach.timeout-keeps-waiting` | 10초 안에 응답이 없는 detach는 `... timed out` 오류를 한 번 쓰고 계속 기다린다. reload는 pending image에 두 번째 detach를 보내지 않고, 늦은 응답은 detach를 끝내고 그 surface의 ended event를 보낸다. | all |
| `images.detach.surface-ends-after-its-last-detach` | surface는 그 image detach가 모두 끝날 때까지 pending이고, 창 event `image-detach-ended {surface, error}`는 마지막 detach가 끝난 뒤에 온다. | all |
| `images.reload.captures-old-image-owner` | Reload는 native 영역을 닫고 surface generation을 올리기 전에 각 이미지의 supplier와 현재 generation을 캡처한다. | all |
| `images.reload.start-sends-detach-without-waiting` | reload는 native image를 닫은 뒤 캡처한 각 image의 detach를 보내고, 응답을 기다리지 않고 start document를 돌려준다. 각 image의 surface는 pending으로 남는다. | all |
| `surfaces.reload.sends-only-image-detaches` | page reload는 다시 불러온 surface가 캡처한 각 image의 detach만 sidecar에 보낸다. image supplier에도, surface가 보낸 적이 있는 persistent sidecar에도 다른 메시지는 보내지 않으며, 새 page의 module이 같은 session owner에 닿는다. | all |
| `images.detach.pending-surface-is-refused` | surface의 detach가 pending인 동안 그 surface의 `imageAttach`와 page의 모든 sidecar send는 `... is pending`으로 거부되고, 다른 surface는 거부되지 않는다. | all |
| `images.detach.session-end-releases` | supplier 연결이 끝나면 그 supplier의 pending detach가 끝나고 각 surface의 ended event가 `... ended: the supplier connection ended`를 담는다. surface session이 끝나면 그 surface의 pending detach가 ended event 없이 끝난다. | all |
| `images.detach.ended-event-waits-for-ready` | workbench가 ready를 알리기 전의 ended event는 ready를 알릴 때 보낸다. workbench 시작은 이전 workbench가 받지 못한 event를 버리고 그 실패를 오류 기록으로 쓴다. | all |
| `images.envelope.rejects-unattached-image` | 연결된 적 없는 이미지 이름의 봉투에 notAttached로 응답한다. | all |
| `images.envelope.refusal-echoes-name-and-sequence` | 거부 응답은 봉투의 name과 sequence를 담는다. | all |
| `images.envelope.refusal-preserves-quoted-name` | 따옴표가 든 이름의 거부 응답은 올바른 JSON이며 이름을 유지한다. | all |
| `images.envelope.refusal-is-recorded` | host가 거부한 프레임은 `<level> host image frame: surface=<s> name=<n> sender=<x> generation=<g> raster=<r> sequence=<q> refused: <reason> current <state>`를 쓰고(`unsupported`는 `error`, 나머지는 `info`), 봉투가 아닌 image 필드는 `error host image frame: surface=<s> sender=<x> malformed image envelope: <image>`를 쓴다. | all |
| `trace.image-frame-answer-is-recorded` | trace가 켜져 있는 동안 프레임에 대한 모든 응답(consumed 또는 거부 사유를 담은 refused)은 layer `host`의 event `host.trace.image.frame`으로 저장되며, field `surface`, `name`, `response`(사이드카가 받는 응답)를 가진다. | all |
| `images.envelope.rejects-other-sidecar` | 다른 사이드카가 보낸 연결된 이미지의 봉투에 notAttached로 응답한다. | all |
| `images.envelope.presents-attached-current-frame` | 연결한 사이드카가 보낸 현재 raster 프레임은 토큰, 크기, 이름, sequence와 함께 표시된다. | all |
| `images.envelope.present-carries-nonce-scale-generation-raster` | 표시할 프레임은 nonce, scale, generation, raster도 담는다. | all |
| `images.envelope.rejects-unsupported-format` | bgra8이 아닌 형식의 봉투에 unsupported로 응답한다. | all |
| `images.envelope.rejects-bad-nonce-length` | nonce가 16바이트가 아닌 봉투에 unsupported로 응답한다. | all |
| `images.envelope.rejects-unknown-token-kind` | 토큰 종류가 iosurface-global이 아닌 봉투에 unsupported로 응답한다. | all |
| `images.envelope.ignores-body-without-image` | image 필드가 없는 JSON 본문은 이미지 봉투가 아니다. | all |
| `images.envelope.ignores-invalid-json` | JSON이 아닌 본문은 이미지 봉투가 아니다. | all |
| `images.ack.consumed-carries-frame-identity` | 표시에 성공하면 consumed와 프레임의 name, generation, raster, sequence로 응답한다. | all |
| `images.ack.leased-carries-frame-identity` | lease 방식 영역의 표시에 성공하면 leased와 프레임의 name, generation, raster, sequence로 응답한다. | all |
| `images.lease.released-carries-frame-identity` | lease 방식 영역이 surface를 더 쥐지 않게 되면, 호스트는 그 surface가 담았던 프레임의 name, generation, raster, sequence와 함께 released를 공급자에게 보낸다. | all |
| `images.lease.release-after-window-close-sends-nothing` | 창이 닫힌 뒤 도착한 lease region의 release는 supplier에 아무것도 보내지 않고 실패도 보고하지 않는다. supplier가 이미 그 surface를 끝냈기 때문이다. | tauriv2 only: Go host들은 region을 닫는 중에, supplier에서 surface가 닫히기 전에 release를 보내므로, 창이 닫힌 뒤 오는 release가 없다 |
| `images.lease.failed-release-is-reported` | 열린 창에서 supplier가 받지 못한 lease region의 release는 그 실패를 보고한다. | all |
| `images.ack.failure-carries-error-and-frame-identity` | 표시에 실패하면 오류와 프레임의 name, generation, raster, sequence로 응답한다. | all |
| `images.transfer.rejects-duplicate-sequence` | 현재 raster에서 같은 sequence를 반복하면 stale로 응답한다. | all |
| `images.transfer.reconfigure-advances-raster` | 새 크기를 구성하면 더 큰 raster 번호를 반환한다. | all |
| `images.transfer.rejects-stale-raster` | 대체된 raster의 프레임에는 stale로 응답하고 새 raster의 프레임은 표시한다. | all |
| `images.transfer.configure-stamps-current-generation` | raster 구성은 현재 표면 generation을 담는다. | all |
| `images.transfer.generation-advances` | 나중 generation의 번호가 더 크다. | all |
| `images.transfer.rejects-old-generation-after-reattach` | 새 generation에서 이미지를 다시 연결하면 이전 generation의 프레임에 notAttached로 응답한다. | all |
| `images.transfer.reattach-continues-raster` | 같은 세대에서 떼었다가 다시 붙인 그림은 마지막 래스터 리비전보다 큰 값으로 이어 세므로, 다음 구성이 사이드카가 받은 어떤 구성보다 새롭다. 새 세대는 다시 센다. | all |
| `images.transfer.new-generation-invalidates-queued-old-frame` | 이미지를 닫기 전에 새 generation을 시작하면 대기 중인 이전 generation 프레임은 notAttached로 응답된다. | all |
| `images.wait.blocks-before-first-frame` | 표시 대기는 보이는 raster의 첫 프레임 전에는 통과하지 않는다. | all |
| `images.wait.releases-after-current-frame-presented` | 현재 raster의 프레임이 표시되면 표시 대기가 통과한다. | all |
| `images.wait.successful-handle-replies-consumed` | 주 스레드 표시에 성공한 봉투를 처리하면 consumed로 응답한다. | all |
| `images.wait.newer-sequence-rearms-wait` | 같은 raster의 새 sequence를 결정하면 settled presentation wait가 다시 대기한다. | all |
| `images.wait.continuous-raster-snapshot` | Continuous layout 대기는 후속 같은 raster sequence가 수락되더라도 현재 generation과 raster에 positive presented sequence가 설치되면 완료된다. Generation 또는 raster 변경은 설치된 snapshot을 지우고, presentation error는 대기를 실패시키며, 숨긴 영역은 대기를 막지 않는다. Settled 대기는 최신 accepted sequence를 계속 요구한다. | all |
| `images.presentation.runs-after-framework-event` | Tauri image presentation은 framework event가 lock을 놓은 뒤 commit하며, queue enqueue와 native presentation 오류를 frame handler에 그대로 전달한다. | tauriv2 only: Tauri UI callback adapter의 lock 및 오류 경계를 검증한다 |
| `images.wait.reconfigure-clears-presented` | raster를 다시 구성하면 표시 상태를 지운다. | all |
| `images.wait.hidden-image-does-not-block` | 숨긴 이미지는 표시 대기를 막지 않고, 다시 보이면 다시 막는다. | all |
| `images.wait.hidden-surface-does-not-block` | 숨긴 표면은 표시 대기를 막지 않고, 다시 보이면 다시 막는다. | all |
| `images.wait.ended-generation-does-not-block` | 표면 generation을 끝내면 표시 대기가 풀린다. | all |
| `images.wait.timeout-writes-no-log-line` | 제한 시간에 이른 표시 대기는 호출자에게 `presentationTimeout`을 반환하고 애플리케이션 로그에 줄을 쓰지 않는다. 기다린 요청이 그 실패를 보고하기 때문이다. | all |
| `images.visibility.survives-first-document-navigation` | 첫 문서 이동 전에 숨긴 표면은 이동 뒤에도 숨겨진 상태를 유지한다. | all |
| `images.visibility.hidden-surface-defers-configuration` | 숨긴 표면의 이미지를 구성하면 표면이 보일 때까지 구성을 반환하지 않는다. | all |
| `images.visibility.shown-surface-reconfigures-its-raster` | 숨겼다가 다시 보인 표면은 같은 크기라도 새 raster revision을 설정하므로, 표시 장벽은 숨긴 동안의 frame을 기다리지 않는다. | all |
| `images.visibility.shown-surface-presents-from-its-new-raster` | 다시 보인 표면의 presented sequence는 새 raster와 함께 새로 시작하므로, 이전 raster가 더 큰 sequence를 표시했더라도 새 raster 첫 frame의 native presentation이 표시 장벽을 끝낸다. | all |
| `images.visibility.refresh-list-excludes-hidden` | 새로 고침 목록은 숨긴 표면의 이미지와 숨긴 이미지를 뺀다. | all |
| `images.present.rejects-frame-superseded-during-main-thread` | 주 스레드 표시 전에 raster가 다시 구성된 프레임에 stale로 응답한다. | all |
| `images.present.rejects-frame-detached-during-main-thread` | 주 스레드 표시 전에 표면 이미지가 제거된 프레임에 stale로 응답한다. | all |
| `images.present.main-thread-failure-reports-present-failed` | 주 스레드 표시가 실패하면 presentFailed로 응답하고 표시 대기는 그 오류를 반환한다. | all |
| `images.present.older-ack-preserves-newer-rejection` | 성공한 오래된 in-flight presentation은 실제 presented sequence를 전진시키지만 더 새 accepted sequence의 rejection을 지우지 않는다. 최신 accepted sequence의 성공 acknowledgment만 그 rejection을 지운다. | all |
| `images.present.missing-native-surface-requests-reconfiguration` | notFound로 실패한 표시는 같은 raster의 새 구성을 요청한다. | all |
| `images.attach.surface-close-removes-only-its-images` | 표면을 제거하면 그 이미지 핸들을 반환하고 다른 표면의 이미지는 유지한다. | all |
| `images.attach.one-main-step` | attach는 요청 확인, 이름 예약, 영역 생성과 등록을 main thread의 한 step에서 실행하므로, 표면 닫기나 page reload는 attach 전체의 앞이나 뒤에 실행된다. 실패한 attach는 오류 기록 없이 자기 이름만 되돌리고, 이름 없이 열린 영역은 남지 않는다. | all |
| `images.attach.rejects-reservation-without-sidecar` | 소유 사이드카가 없는 이미지 예약을 거부하고 아무것도 등록하지 않는다. | all |
| `images.present.replaced-frame-is-logged-as-invalidated` | 더는 현재가 아닌 프레임(`stale`, `notAttached`, `staleRaster native=... frame=...`)은 `stale`로 답하고 표시 실패로 기록하지 않으며 `image frame invalidated before native presentation: ... reason=<detail>`을 남긴다. | all |
| `images.present.frame-of-undeclared-sidecar-is-invalidated` | 어떤 plugin도 선언하지 않는 사이드카의 그림은 `stale`로 답하고 native 표시, 복구, 오류 없이 기록되며, 끝난 사이드카에 대한 답은 `not sent`로 기록된다. | all |
| `images.present.failure-line-names-the-current-frame` | 다른 표시 실패는 그 사유(알 수 없는 상세는 `presentFailed`)로 답하고 오류 줄 `error host image present: ... reason=<detail> current <frame state>`를 남긴다. | all |
| `recording.finish.keeps-folder-and-reports-frames` | 녹화를 마치면 폴더를 유지하고 프레임 수와 시작 때 받은 `frameIdentity` 옵션을 보고하며, 두 번째 마침은 실패한다. | all |
| `recording.finish.stop-failure-preserves-folder` | native stream이 계속 소유 상태일 때 capture stop이 실패하면 finish는 stop 오류를 보고하고 start가 반환한 폴더와 소유권을 유지해 이후 abort 재시도를 허용한다. | all |
| `recording.finish.retired-stop-failure-releases-owner` | native stream과 writer가 퇴역한 뒤 capture stop이 실패하면 finish는 stop 오류를 보고하고 start가 반환한 폴더를 그대로 두며, 다른 녹화를 시작할 수 있도록 녹화 소유권을 해제한다. | all |
| `recording.finish.stop-query-failure-preserves-owner` | capture stop과 native 소유권 조회가 모두 실패하면 finish는 두 오류를 보고하고 폴더와 cleanup 소유권을 유지한다. | all |
| `recording.finish.layout-trace-failure-preserves-folder` | capture stop 뒤 layout trace finalization이 실패하면 finish는 해당 오류를 반환하고 start가 이미 반환한 frame 폴더를 보존한다. | all |
| `recording.drag.layout-trace-after-settle` | 기록하는 drag는 마지막 layout이 commit되고 표시된 뒤에 layout trace를 끝내므로, trace가 마지막 layout의 presentation과 commit을 가진다. drag나 그 대기가 실패해도 trace는 끝난다. | all |
| `recording.start.failed-open-removes-folder` | 캡처 열기에 실패한 녹화는 폴더를 제거하고 실행 중인 것을 남기지 않는다. | all |
| `recording.start.failed-start-removes-folder` | 캡처 시작에 실패한 녹화는 폴더를 제거하고 실행 중인 것을 남기지 않는다. | all |
| `recording.start.cleanup-failure-retains-folder-owner` | 시작 실패 뒤 소유 폴더를 제거할 수 없으면 두 오류를 보고하고 cleanup 소유권을 유지하며, abort가 폴더를 제거할 때까지 다음 시작을 막는다. | all |
| `recording.start.make-failure-preserves-unowned-path` | 폴더 생성이 실패하면 기존 경로를 변경하지 않고 capture 장치를 호출하지 않으며 그 경로의 소유권을 주장하지 않는다. | all |
| `recording.start.stop-failure-preserves-retry-state` | 첫 프레임 대기가 실패하고 native stream이 계속 소유 상태인 채 capture stop도 실패하면 start는 두 오류를 보고하고 폴더와 cleanup 상태를 유지하며, 다음 시작을 막고 abort 재시도를 허용한다. | all |
| `recording.start.retired-stop-failure-removes-folder` | 첫 프레임 대기와 capture stop이 실패했지만 native stream과 writer가 퇴역했다면 start는 두 오류를 보고하고 실패한 녹화 폴더를 제거하며 녹화 소유권을 해제한다. | all |
| `recording.start.stop-query-failure-preserves-owner` | 시작 cleanup의 stop 호출과 native 소유권 조회가 모두 실패하면 start는 모든 오류를 보고하고 폴더와 cleanup 소유권을 유지한다. | all |
| `recording.start.no-first-frame-stops-and-removes` | 첫 프레임이 없는 녹화는 중지되고 폴더가 제거된다. | all |
| `recording.start.rejects-while-running` | 녹화 중에 녹화를 시작하면 실패하고 폴더를 만들지 않는다. | all |
| `recording.abort.stops-removes-and-allows-next` | 녹화를 중단하면 중지하고 폴더를 제거하며 다음 녹화를 허용한다. | all |
| `recording.target.prepared-each-recording` | 준비가 그때의 창 크기로 stream 출력 크기를 정하므로, 녹화마다 같은 대상도 다시 준비한다. | all |
| `recording.target.different-target-reopened` | 다른 대상을 녹화하면 대상을 다시 준비한다. | all |
| `recording.abort.stop-failure-preserves-retry-state` | abort가 capture를 중지하지 못하고 native stream이 계속 소유 상태면 stop 오류를 보고하고 폴더 소유권과 cleanup 상태를 보존하며, 다음 시작을 막고 abort 재시도를 허용한다. | all |
| `recording.abort.stop-query-failure-preserves-owner` | abort의 stop 호출과 native 소유권 조회가 실패하면 두 오류를 보고하고 폴더와 cleanup 소유권을 유지한다. | all |
| `recording.abort.retired-stop-failure-removes-folder` | native stream과 writer가 퇴역한 뒤 capture stop이 실패하면 abort는 폴더를 제거하고 녹화 소유권을 해제하면서 stop 오류를 계속 보고한다. | all |
| `recording.abort.retired-stop-failure-cleanup-retry-skips-stop` | 퇴역한 stream의 cleanup이 실패하면 abort는 stop과 삭제 오류를 보고하고 퇴역 폴더 소유권을 유지한다. 재시도는 stop을 다시 하지 않고 폴더를 제거한다. | all |
| `recording.abort.stop-complete-cleanup-retry-skips-stop` | capture 중지에는 성공했지만 폴더 제거가 실패하면 abort는 제거 오류를 보고하고 중지된 cleanup 소유권을 유지한다. 재시도는 stop을 중복 호출하지 않고 폴더를 제거한 뒤 다음 시작을 허용한다. | all |
| `recording.start.panicking-capture-is-cleaned-up` | capture 시작 중 panic하면 partial capture를 중지하고 폴더를 제거하려 시도한 뒤 panic을 다시 전달한다. | tauriv2 only: Tauri는 unwind 중 최선의 녹화 cleanup을 수행하고, Wails는 panic 상태 2로 process를 끝내 cleanup을 재개하지 않는다. |
| `recording.start.panicking-capture-retired-stop-error-releases-owner` | panic cleanup에서 native stream과 writer가 퇴역한 뒤 stop 오류가 나면 폴더를 제거하고 녹화 소유권을 해제하며 stop 오류를 기록한 뒤 원래 panic을 다시 전달한다. | tauriv2 only: Wails는 panic 상태 2로 process를 끝내므로 process 안의 panic cleanup은 실행되지 않는다. |
| `recording.start.panic-cleanup-failure-blocks-next-start` | panic cleanup에서 capture 중지나 폴더 제거를 확인하지 못하면 녹화는 cleanup 소유권을 유지해 다음 시작을 막고 abort 재시도를 허용한다. | tauriv2 only: Wails는 panic 상태 2로 process를 끝내므로 이후 시작이 실행되지 않는다. |
| `sidecars.send.delivers-only-to-owning-window` | 각 창의 사이드카 메시지는 사이드카, 표면, 본문이 그대로인 이벤트로 그 창에만 돌아온다. | all |
| `sidecars.send.rejects-surface-owned-by-another-window` | 다른 창이 소유한 표면으로 보내면 "another window"로 실패한다. | all |
| `sidecars.protocol.request-lines-carry-surface-root-body` | 사이드카는 surface, root, body 요청 줄을 보낸 순서로 받는다. | all |
| `sidecars.close-owner.sends-closed-per-surface` | 창의 소유를 닫으면 각 표면의 closed 알림을 보낸다. | all |
| `sidecars.close.reaches-holding-sidecar` | surface를 닫으면 그 surface에 요청을 보낸 사이드카 프로세스에만 closed 알림을 보낸다. 그 surface의 session을 갖지 않은 다른 사이드카는 알림을 받지 않는다. | all |
| `sidecars.close.keeps-other-sessions` | 제거된 surface를 닫으면 그 surface에만 closed 알림을 보낸다. surface가 아닌 plugin 상태 session을 포함한 창의 다른 session은 열린 채로 남고, 창의 project가 해제된 뒤에도 첫 요청의 root를 유지한다. | all |
| `sidecars.native-view-removal.closes-stdio-session` | Logical surface가 project layout에 남아 있어도 native view를 제거하면 요청을 받은 표준 입출력 sidecar에 `closed`를 보낸다. | all |
| `sidecars.native-view-removal.retains-persistent-layout-session` | Logical surface가 project layout에 남아 있을 때 native view를 제거해도 persistent service에는 `closed` 메시지를 보내지 않는다. | all |
| `sidecars.retain.sends-authoritative-layout` | retain은 실행 중이거나 엔드포인트가 게시된 영속 서비스마다 authoritative layout 표면과 request preparation 중 허용된 session을 담은 요청을 보낸다. 이전에 알려진 일반 surface 중 layout에 없는 항목은 제외하며 남은 항목이 없으면 빈 keep 목록을 보낸다. 서비스가 닫은 수를 반환한다. | all |
| `sidecars.retain.reports-service-failure` | `ok: false`인 `retained` 응답은 서비스의 사유를 담은 오류로 반환한다. | all |
| `sidecars.retain.skips-service-without-endpoint` | 실행 중인 서비스와 그 엔드포인트 파일이 없으면 retain은 서비스를 시작하지 않고 아무것도 닫지 않는다. | all |
| `sidecars.retain.timeout-names-the-request-stage` | service가 읽고 답하지 않은 retain은 10초 뒤 요청 줄의 stage, 즉 쓰인 뒤의 시간과 service에서 마지막 줄이 도착한 뒤의 시간으로 실패한다. | all |
| `sidecars.retain.keeps-surface-first-sent-during-start` | Persistent service가 시작된 뒤 keep 목록을 모으기 전에 처음 보낸 일반 surface session도 해당 retain에 포함된다. | all |
| `sidecars.send.page-needs-a-project-root` | project를 보여 주지 않는 window에서 root가 기록되지 않은 surface로 보내는 page 요청은 실패하고, 어떤 sidecar에도 가지 않으며, 진행 중인 retain은 계속된다. root가 기록된 surface는 그 root로 계속 보낸다. | all |
| `sidecars.send.host-send-leaves-no-session-without-a-root` | project를 보여 주지 않는 window에서 host의 send는 sidecar에 도달하되 root를 기록하지 않아, 어떤 retain도 그 surface를 유지하지 않는다. | all |
| `sidecars.view-send.requires-a-safe-generation-and-its-own-surface` | `viewSidecarSend` request는 `generation`이 없거나 null이거나 정수가 아니거나 0이거나 JavaScript의 safe integer 한계를 넘을 때, 또는 `surface`가 `source`와 다를 때 거부된다. | all |
| `sidecars.view-send.uncorrelated-cids-are-accepted` | `cids`가 없거나 `cids: null`이거나 `cids: []`인 `viewSidecarSend` request는 받아들여지고 correlation identifier를 갖지 않는다. | all |
| `sidecars.view-send.retired-generation-sends-nothing` | surface의 다음 mount가 retire한 generation을 가진 `viewSidecarSend` request는, 그 generation이 current일 때 만든 request여도 거부되고 sidecar에 request line을 보내지 않는다. | all |
| `sidecars.view-send.root-is-the-project-of-its-mount` | mount된 view의 첫 `viewSidecarSend`는 그 mount의 start가 가진 project의 root를 보낸다. window가 project를 보여 주지 않거나 다른 project를 보여 줄 때도 같다. | all |
| `sidecars.view-send.new-mount-sends-its-own-project` | 같은 surface에 다른 project로 다시 mount된 view는 이전 mount나 window의 project가 아니라 새 mount의 project root를 보낸다. | all |
| `sidecars.view-send.generation-retired-during-start-creates-no-session` | sidecar process의 start를 기다리는 `viewSidecarSend`는 start가 끝나기 전에 그 generation이 retire되면 실패하고, request line을 보내지 않으며 surface의 session을 기록하지 않는다. | all |
| `sidecars.view-send.full-queue-creates-no-session` | sidecar의 가득 찬 queue가 거부한 `viewSidecarSend`는 `not keeping up`으로 실패하고 session의 surface, owner, root를 기록하지 않는다. | all |
| `sidecars.window-send.mounted-view-surface-is-refused` | view가 mount된 surface로의 `sidecarSend`는 거부되고 request line을 보내지 않는다. mount된 view를 위해 보내는 것은 원래 source generation을 가진 `viewSidecarSend`뿐이다. | all |
| `sidecars.window-send.mount-during-start-ends-the-admission` | mount된 view가 없는 surface에 대해 sidecar process의 start를 기다리는 `sidecarSend`는 start가 끝나기 전에 그 surface에 view가 mount되면 실패한다. 그 view가 그 전에 다시 retire되어도 같다. 이때 request line을 보내지 않고 surface의 session을 기록하지 않는다. | all |
| `sidecars.window-send.other-surface-mount-keeps-the-admission` | `sidecarSend`가 sidecar process의 start를 기다리는 동안 다른 surface의 view source가 시작되어도 request는 받아들여진 채로 남고, start 뒤에 request line을 보낸다. | all |
| `sidecars.window-send.absence-ticket-ends-with-its-request` | mount된 view가 없는 surface로의 `sidecarSend`는 기다리는 동안 그 surface의 source-absence ticket을 갖고, ticket은 request가 보내지든 거부되든 취소되든 request와 함께 끝나며 다른 request의 ticket은 끝내지 않는다. | all |
| `sidecars.window-send.start-rechecks-the-surface-root` | sidecar process의 start를 기다리는 `sidecarSend`는 start 뒤에 surface의 root를 다시 확인한다. 그 사이 다른 request가 그 surface에 다른 root를 기록했으면 실패하고 request line을 보내지 않으며, 보내진 line은 기록된 root를 갖는다. | all |
| `sidecars.retain.closes-sessions-absent-from-layout` | 이전에 알려진 일반 surface를 retain에서 생략하면 stale owner와 root를 제거하고 persistent service에 그 surface가 없는 keep 목록을 보낸다. | all |
| `sidecars.restart.enable-clears-stops` | plugin 하나를 사람이 enable하면 그 plugin이 `dependencies`에 나열한 사이드카마다 정지를 해제해 다음 전송이 사이드카를 시작한다. 어떤 활성 plugin도 나열하지 않은 사이드카의 정지는 그대로 남는다. | all |
| `sidecars.retain.rejects-after-stop` | 사이드카가 멈춘 뒤 시작한 retain이나 서비스를 준비한 뒤 멈춤이 끼어든 retain은 "sidecars are stopped"로 실패하고 서비스에 retain을 보내지 않는다. | all |
| `menu.application.view-has-full-screen-and-text-size` | 애플리케이션 메뉴의 View 메뉴에는 전체 화면과 Command `=`, `-`, `0`의 [글자 크기](text-size.ko.md) 항목이 있고, 웹뷰 전체를 확대하거나 다시 읽는 메뉴 항목이 없다. | all |
| `menu.application.help-has-debug` | 애플리케이션 메뉴의 도움말 메뉴에 단축키 없는 항목 디버그(Debug)가 있다. 이 항목은 main 창의 workbench에서 `core.debug.open`을 실행한다([디버그 화면](debug.ko.md)). | all |
| `menu.application.app-has-settings` | 애플리케이션 메뉴의 app 메뉴에 about 항목 바로 다음으로 단축키 Command `,`의 항목 설정…(Settings…)이 있다. 이 항목은 메인 윈도우의 workbench에서 `core.settings.open`을 실행한다([settings window](settings.ko.md)). | all |
| `menu.select.runs-after-the-framework-callback-unwinds` | `host.menu.select`는 선택한 item을 platform UI queue의 task 하나에서, 그 task를 넣은 framework callback이 돌아와 lock을 놓은 뒤에 수행하고, item이 실행된 뒤에 응답한다. | tauriv2 only: Tauri host는 framework callback이 풀린 뒤 platform의 UI queue에서 item을 수행하고, Go host는 framework callback 없이 UI thread의 한 step에서 수행한다(host tree의 H69 행) |
| `menu.select.answers-the-failure-of-the-item` | 실패한 선택 item은 그 실패를 그대로 `host.menu.select`의 응답으로 준다. | tauriv2 only: Tauri host는 framework callback이 풀린 뒤 platform의 UI queue에서 item을 수행하고, Go host는 framework callback 없이 UI thread의 한 step에서 수행한다(host tree의 H69 행) |
| `menu.select.queue-refusal-performs-nothing` | platform의 UI queue가 task를 거부하면 `host.menu.select`는 그 거부로 응답하고 item은 실행되지 않는다. | tauriv2 only: Tauri host는 framework callback이 풀린 뒤 platform의 UI queue에서 item을 수행하고, Go host는 framework callback 없이 UI thread의 한 step에서 수행한다(host tree의 H69 행) |
| `sidecars.protocol.surface-keeps-its-first-root` | 소유 창의 프로젝트가 바뀐 뒤에도 열린 표면의 요청과 closed 알림은 첫 요청의 root를 가진다. | all |
| `sidecars.protocol.closed-surface-messages-are-discarded-and-unknown-ones-fail` | 호스트가 닫은 표면에 대한 stdio sidecar 메시지는 버리고, 호스트가 그 프로세스에 한 번도 보내지 않은 표면의 메시지는 보낸 표면에 `unknown surface <surface>`를 전달하며 sidecar를 실패시킨다. | all |
| `sidecars.protocol.dropped-message-is-recorded` | 소유 창이 없어 버려지는 사이드카 메시지는 `info host sidecar <name>: message for surface <surface> dropped: no window owns the surface: <body>`를 쓴다. | all |
| `sidecars.protocol.answer-to-ended-sidecar-is-recorded` | process가 실행 중이 아닌 sidecar로의 응답은 끝난 오류(`sidecar <name> is not running`)이고, 그런 sidecar에 대한 버려진 transfer image의 `closed` 답은 오류 대신 `not sent`로 기록된다. sidecar의 frame은 process와 함께 끝나기 때문이다. | all |
| `sidecars.image.closed-surface-is-answered` | 소유 창이 없는 표면의 전송 그림은 버리고 그 그림의 값으로 `{"surface":<surface>,"body":{"image":{"error":"closed","name","generation","raster","sequence"}}}`를 답한다. | all |
| `sidecars.image.retired-owner-dispositions` | 표면 owner가 retire된 뒤 해당 owner에 이미 전달된 유효한 전송 그림은 closed로 답한다. Non-image message와 malformed image message는 소비하고 응답하지 않는다. | all |
| `sidecars.image.stop-answers-late-persistent-image-before-shutdown` | 호스트가 중지 중일 때 persistent service는 소유자가 없는 표면의 전송 그림을 보낼 수 있다. 호스트는 아직 열린 service 연결로 `shutdown`을 보내기 전에 응답하여 service가 transport를 닫기 전에 그림을 해제하게 한다. | all |
| `sidecars.read.unfinished-line-ends-the-connection` | process가 줄을 쓰다 끝나서 line feed 없는 줄로 끝나는 sidecar 출력은 연결을 끝낸다. 그 줄은 메시지가 아니고, host는 `info host sidecar <name>: the output ended in a line of <n> bytes without a line break, which is not a message`를 쓰며, sidecar의 어떤 surface도 `invalid message`로 실패하지 않는다. | all |
| `sidecars.send.rejects-undeclared-sidecar` | 어떤 플러그인도 선언하지 않은 사이드카로 보내면 "not declared"로 실패한다. | all |
| `sidecars.send.rejects-after-stop` | 사이드카가 멈춘 뒤 보내면 "stopped"로 실패한다. | all |
| `sidecars.send.rejects-when-no-plugin-declares-sidecars` | 선언된 사이드카가 없으면 생성은 성공하고 모든 보내기는 "not declared by any plugin"으로 실패한다. | all |
| `sidecars.start.fails-on-missing-executable` | 디스크에 없는 선언된 실행 파일은 첫 보내기를 사이드카 이름과 함께 실패시킨다. | all |
| `sidecars.start.refuses-zero-hello-timeout` | 영값 `Sidecars`로 영속 서비스를 시작하면 서비스 생성 전에 거부하며 `HelloTimeout`을 이름 붙인 오류를 낸다. | wailsv3, mygo only: Go는 영값 `Sidecars`를 허용하지만 Tauri는 공개 영값 구조체가 아니라 builder로 사이드카 core를 만든다 |
| `sidecars.start.passes-log-directory` | 표준 입출력 sidecar는 인자 `--log-dir <config-dir>/logs`만 받아 시작한다. | all |
| `sidecars.declaration.refuses-missing-sidecar-json` | sidecar.json이 없는 설치 sidecar 폴더나 installed.json에 version이 없는 sidecar는 선언되지 않고, 그 sidecar에 대한 요청은 없는 파일이나 그 sidecar를 나열한 plugin.json을 밝히는 `sidecar <name>: <path>: <reason>`으로 실패한다. | all |
| `installed.sidecars.unreadable-installation-starts-without-sidecars` | `installed.json`이 이전 형식이거나 사용 중인 plugin의 `plugin.json`이 parse되지 않으면, host 시작의 sidecar channel은 선언 없이 만들어지고, host는 `installed plugins: <error>`를 기록하며, 설치된 sidecar에 대한 요청은 `sidecar <name> is not declared by any plugin`으로 실패한다. | all |
| `sidecars.declaration.adds-sidecars-installed-after-start` | 생성 뒤에 설치 sidecar를 선언하면 선언되지 않은 것을 더하므로 그 sidecar로의 보내기가 그것을 시작한다. | all |
| `sidecars.declaration.rejects-executable-escaping-package` | sidecar 밖의 실행 파일 경로는 `executable <path> is not a path inside the package`로 거부된다. 그 sidecar는 선언되지 않고 생성은 성공하며, 그 sidecar에 대한 요청은 `sidecar <name>: <sidecar.json 경로>: <reason>`으로 실패한다. | all |
| `sidecars.declaration.rejects-absolute-executable` | 절대 실행 파일 경로는 `executable <path> is not a path inside the package`로 거부된다. 그 sidecar는 선언되지 않고 생성은 성공하며, 그 sidecar에 대한 요청은 `sidecar <name>: <sidecar.json 경로>: <reason>`으로 실패한다. | all |
| `sidecars.declaration.rejects-unsupported-protocol` | 지원하지 않는 프로토콜 버전은 `protocol <n> is not supported`로 거부된다. 그 sidecar는 선언되지 않고 생성은 성공하며, 그 sidecar에 대한 요청은 `sidecar <name>: <sidecar.json 경로>: <reason>`으로 실패한다. | all |
| `sidecars.declaration.rejects-unknown-transport` | 알 수 없는 전송 방식은 `transport <value> is not supported`로 거부된다. 그 sidecar는 선언되지 않고 생성은 성공하며, 그 sidecar에 대한 요청은 `sidecar <name>: <sidecar.json 경로>: <reason>`으로 실패한다. | all |
| `sidecars.declaration.rejects-host-read-operations` | `hostReadOperations`가 있는 `sidecar.json`은 `<path of sidecar.json>: hostReadOperations is removed`로 거부된다. 그 사이드카는 선언되지 않고, 생성은 성공하며, 그 사이드카로 보내는 요청은 사이드카 이름과 그 이유를 밝히며 실패한다. | all |
| `sidecars.declaration.invalid-sidecar-leaves-others-declared` | 올바른 sidecar 옆의 거부된 sidecar는 생성 때와 이후 선언 때 모두 올바른 sidecar를 선언된 채로 둔다. 올바른 sidecar에 대한 요청은 그 sidecar에 닿고, 거부된 sidecar에 대한 요청은 `sidecar <name>: <path>: displayName is required`로 실패한다. | all |
| `sidecars.declaration.persistent-requires-config-directory` | 설정 디렉터리가 없는 지속 전송은 생성을 실패시킨다. | all |
| `sidecars.persistent.accepts-non-canonical-config-directory` | 지속 전송은 정규화되지 않은 설정 디렉터리 경로를 받아들인다. | all |
| `sidecars.send.fails-fast-when-sidecar-not-keeping-up` | 읽지 않는 사이드카로의 큰 보내기는 "is not keeping up"으로 끝난다. | all |
| `sidecars.send.slow-sidecar-does-not-block-others` | 한 사이드카 대기열이 가득 찬 동안 다른 사이드카로의 보내기는 50ms 안에 반환된다. | all |
| `sidecars.send.start-does-not-block-other-sidecars` | 영속 service가 hello 응답을 늦추는 동안 실행 중인 다른 사이드카로의 보내기는 50ms 안에 반환된다. | all |
| `sidecars.close.answer-ends-closing` | `closed`를 보낸 뒤 `host.sidecars`는 사이드카가 답할 때까지 그 표면을 나열하고, 답하면 목록이 빈다. | all |
| `sidecars.write.wait-is-recorded` | sidecar의 쓰기 queue에서 1초 이상 기다리거나 쓰기에 10 ms 이상 걸린 줄은 `host.sidecar.write_wait`(sidecar의 `name`, 줄의 `bytes`, `queued_us`, `write_us`)를 level `info`로 저장하고, 곧바로 쓴 줄은 아무것도 저장하지 않는다. | all |
| `buffers.sidecar-replies.bounded-by-messages` | sidecar의 보류 응답은 최대 1,024개이며, 다음 응답은 `sidecar <name>: the pending replies reached 1024 messages, so a reply of surface <surface> is dropped`로 거절되고 `host.buffer.dropped`(`buffer` `sidecar <name> pending replies`, `count` 1, `bytes`, `reason` `the buffer holds 1024 messages`)를 저장한다. | all |
| `buffers.sidecar-replies.bounded-by-bytes` | sidecar의 보류 응답은 최대 4,194,304바이트이며, 이를 넘게 되는 응답은 `...reached 4194304 bytes...`로 거절되고 `reason`이 `the buffer holds 4194304 bytes`인 `host.buffer.dropped`를 저장한다. | all |
| `buffers.sidecar-closes.bounded-and-forgotten` | sidecar의 보류 close는 최대 1,024개와 4,194,304바이트이며, 이를 넘는 close는 보내지 않고 `host.buffer.dropped`(`buffer` `sidecar <name> pending closes`)를 저장하며, 그 표면은 답을 기다리는 표면 목록에 없다. | all |
| `buffers.relay-expired.bounded-and-counted` | relay는 만료된 요청을 최대 256개 기억하며, 가장 오래된 것을 잊을 때 `host.buffer.dropped`(`buffer` `relay expired requests`, `count` 1, `bytes` 0, `reason` `the buffer holds 256 requests`)를 저장하고, 그 요청의 늦은 응답에는 `exposure reply <id> has no matching request`로 답한다. | all |
| `log.writer.event-over-size-bound-is-cut` | writer가 받을 때 fields 글이 1,048,576바이트를 넘는 event는 최대 4,096바이트의 `fields` `{"head": ...}`와 자르기 전 크기인 `truncated`로 저장하고, 상한 아래의 event에는 `truncated`가 없으며 `seq`는 연속이다. | all |
| `sidecars.close.buffered-close-is-recorded` | 사이드카의 큐가 가득 차서 기다리는 closed 알림은 `info host sidecar <name>: close <surface>: outbox full, buffered`를 쓴다. | all |
| `sidecars.close.room-has-no-buffered-record` | sidecar의 queue에 자리가 있는 closed notice는 바로 전송되고 `outbox full, buffered` 기록을 쓰지 않는다. writer는 찬 queue에서 언제든 한 줄을 꺼낼 수 있으므로, send를 거부한 queue에도 다음 close가 들어갈 자리가 생길 수 있다. | all |
| `sidecars.close.failed-answer-is-logged` | `error`가 있는 닫기 응답은 host 로그에 오류 줄 "error host sidecar <name>: close <surface>: <error>"를 쓴 뒤에 닫는 중 항목을 끝낸다. | all |
| `sidecars.declaration.replaces-changed-folder` | 폴더가 바뀐 사이드카를 선언하면 실행 중인 표준 입출력 프로세스를 실패 없이 멈추고, 다음 send가 새 폴더의 실행 파일을 시작한다. | all |
| `sidecars.close.repeated-close-awaits-each-answer` | 사이드카가 앞 닫기에 답하기 전에 다시 닫은 표면은 사이드카가 닫기마다 답할 때까지 닫는 중으로 남고, 어느 답도 사이드카를 실패시키지 않는다. | all |
| `sidecars.close.unexpected-answer-fails` | host가 닫고 있지 않은 표면의 닫기 응답은 "unexpected close answer for <surface>"로 사이드카를 실패시킨다. | all |
| `sidecars.close.process-end-clears-closing` | 사이드카 process가 답하지 않고 끝나면 그 표면은 `host.sidecars`에서 빠진다. | all |
| `sidecars.stop.honors-stop-timeout` | 입력을 비우지 않는 사이드카의 중지는 중지 제한 시간의 두 배 안에 반환된다. | all |
| `sidecars.stop.graceful-on-stdin-eof` | 입력 끝에서 종료하는 사이드카는 제한 시간을 기다리지 않고 멈춘다. | all |
| `sidecars.stop.kills-after-timeout` | 입력 끝을 무시하는 사이드카는 중지 제한 시간 뒤에 강제 종료되고, 호스트는 오류 줄 "error host sidecar <name>: did not end within the stop timeout and was killed"를 쓰며 "exited while stopping" 줄은 쓰지 않는다. | all |
| `sidecars.stop.closes-unread-output` | 멈추는 동안 표준 입출력 사이드카의 프로토콜 실패는 오류 줄 "error host sidecar <name>: failed: <reason>"을 쓰고 실패 이벤트를 전달하지 않으며, 호스트는 파이프의 자기 쪽 끝을 닫으므로, 그 뒤 파이프가 담는 것보다 많이 쓰는 사이드카는 쓰기 오류를 받고 "exited while stopping" 줄 없이 중지 제한 시간 전에 끝난다. | all |
| `sidecars.stop.reads-output-to-end` | 멈추는 동안 호스트는 표준 입출력 사이드카의 출력을 끝날 때까지 읽는다. 중지 전에 보낸 닫기에 입력이 끝난 뒤에야 답하고 그다음 파이프가 담는 것보다 많이 쓰는 사이드카는 모든 쓰기를 마치고 중지 제한 시간 전에 끝나며, 호스트는 오류 줄을 쓰지 않는다. | all |
| `sidecars.stop.reports-exit-status` | 멈추는 동안 종료 상태 3이나 신호 15로 끝난 표준 입출력 사이드카는 오류 줄 "error host sidecar <name>: exited while stopping: exit status 3"이나 "error host sidecar <name>: exited while stopping: signal 15"를 쓴다. | all |
| `sidecars.stop.records-open-requests` | host가 sidecar를 멈추거나 떼어낼 때 응답을 기다리는 식별자 있는 요청은 `host.sidecar.reply` 오류 기록을 얻는다. 기록은 그 surface, sidecar, 식별자를 밝히며, 이유는 `the host stopped before the sidecar replied`다. surface는 이 요청에 대해 `sidecar-failure` event를 받지 않는다. | all |
| `sidecars.reply.error-text-cut-is-marked` | 1,024바이트 한도에서 잘린 오류 글을 가진 `host.sidecar.reply`는 `truncated: true`를 가지며, 잘리지 않은 오류 글은 `truncated` member가 없다. | all |
| `debug.rows.out-of-range-number-is-refused` | float64 범위 밖의 수를 가진 debug 로그 줄은 파일, 줄, 원문과 함께 `not JSON`으로 거부되며, 어떤 행도 그 수에 `undefined`를 보이지 않는다. | all |
| `endpoint.accept.error-is-recorded` | endpoint가 서비스하는 동안 실패한 accept는 `error host endpoint accept: <reason>`을 쓰며, endpoint가 listener를 스스로 닫은 뒤 실패한 accept는 기록을 쓰지 않는다. | all |
| `endpoint.close.reply-after-peer-close` | 상대가 닫은 연결을 만난 답이나 알림은, 닫힘을 먼저 읽었든 쓰기가 broken pipe나 reset으로 실패했든 오류가 아니다. 호스트는 `info host endpoint: reply to <id> not sent: peer closed` 또는 `info host endpoint: notification <method> not sent: peer closed`를 쓰고, 연결은 `peer closed`로 닫힌다. | all |
| `endpoint.close.reason-of-read-error` | 프레임 중간에 끝난 연결은 `connection closed inside a length prefix` 또는 `connection closed inside a frame body`로 닫히고, 그 밖의 읽기 오류는 I/O 글로 닫히며, 프레임 경계에서의 끝이나 reset은 `peer closed`로 닫힌다. | all |
| `host.document.creation-error-states-the-cause` | native layer가 만들지 못한 document region은 생성 오류 뒤에 `: <native cause>`를 붙인 오류로 실패한다. native 생성의 모든 실패는 원인을 밝히며, 원인이 없는 실패는 원인 `the native layer stated no cause`로 실패하므로 오류가 원인이 빠졌다는 사실을 숨기지 않는다. | all |
| `sidecars.stop.forgets-running-sidecars` | 중지는 입력을 끝내기 전에 모든 사이드카를 실행 목록에서 빼고 답하지 않은 닫기를 지우므로, 그 뒤 표면이나 소유 창을 닫아도 아무것도 보내지 않고 닫는 중인 표면을 알리지 않는다. | all |
| `sidecars.protocol.message-at-limit-is-delivered` | 줄바꿈 앞이 정확히 67108864 byte인 사이드카 메시지가 손상 없이 소유 창에 도착한다. | all |
| `sidecars.failure.oversize-message-terminates-and-notifies` | 67108864 byte보다 긴 줄은 줄이 끝나기를 기다리지 않고 사이드카 프로세스를 끝내고 "exceeds"를 담은 `sidecar-failure`를 소유 창에 전달한다. | all |
| `sidecars.failure.invalid-message-terminates-and-notifies` | JSON이 아닌 줄이나 `body`가 없는 JSON 객체는 사이드카 프로세스를 끝내고 "invalid message"를 담은 `sidecar-failure`를 전달한다. | all |
| `sidecars.failure.output-close-notifies-each-surface` | 호스트가 종료 중이 아닐 때 종료 상태 3으로 끝난 사이드카는 그 사이드카에 보낸 각 표면의 소유 창에 이유가 "output closed: exit status 3"인 `sidecar-failure`를 전달하고, 다음 전송은 새 프로세스를 시작한다. | all |
| `sidecars.restart.three-failures-restart` | 표준 입출력 사이드카의 실패 3번이 각각 300초 안에 있으면 다음 전송은 새 프로세스를 시작하고, 재시작 한도 오류를 쓰지 않는다. | all |
| `sidecars.restart.fourth-failure-stops` | 300초 안의 네 번째 실패는 `error: sidecar <name>: restart limit: 4 failures within 300 s`를 쓰고, level `error`의 event `host.sidecar.restart-limit`을 기록하며, 실패한 프로세스에 요청을 보낸 표면의 다음 전송은 프로세스를 시작하지 않고 이유가 "restart limit"인 `sidecar-failure`를 소유 창에 전달하고 실패한다. | all |
| `sidecars.restart.old-failure-not-counted` | 나중 실패보다 300초 넘게 앞선 실패는 세지 않는다. 0, 10, 20초의 실패 뒤 305초의 실패는 사이드카를 계속 재시작하게 두고, 0초의 실패는 세지 않는다. | all |
| `sidecars.restart.refuses-already-open-surface` | 재시작 한도가 사이드카를 멈춘 동안 이미 열린 표면의 전송은, 그 표면이 실패한 프로세스에 보냈든 아니든, 이유 "restart limit"으로 거절되고 프로세스를 시작하지 않는다. | all |
| `sidecars.restart.surface-open-resets-the-record` | 멈춘 사이드카를 `dependencies`에 적은 plugin의 표면이 만들어지면 실패 기록이 지워지고, `sidecar`와 `surface`를 가진 event `host.trace.sidecar.restart-reset`이 기록되며, 다음 전송이 프로세스를 시작한다. 그 사이드카를 적지 않은 plugin의 표면 생성은 멈춤을 그대로 둔다. | all |
| `sidecars.restart.persistent-service-end-stops-before-the-spawn` | 전송이 실행한 영속 서비스의 실패한 시작 3번, 부활이 살아 있는 서비스에 다시 붙는 끊김, 서비스 프로세스가 끝난 끊김은 다시 붙은 끊김을 빼고 실패 4번으로 센다. 마지막 끊김의 부활은 아무것도 스폰하지 않고, `error: sidecar <name>: restart limit: 4 failures within 300 s`를 쓰며, event `host.sidecar.restart-limit`을 level `error`로 기록하고, 전송한 표면은 연결 알림 `{"event": "connection", "connected": false, "reason": "restart limit"}`을 받는다. | all |
| `sidecars.restart.persistent-refused-send-gets-the-connection-notice` | 재시작 한도가 영속 서비스를 멈춘 동안 전송은 서비스를 시작하지 않고, `sidecar <name>: restart limit`로 실패하며, `error: sidecar <name>: restart limit: request for <surface> refused`를 쓰고, 전송한 표면에 이유 `restart limit`인 연결 알림을 전달하며 `sidecar-failure`는 전달하지 않는다. 그 사이드카를 `dependencies`에 적은 plugin의 표면이 만들어진 뒤 다음 전송은 생성 경로를 실행한다. | all |
| `sidecars.restart.persistent-violation-counts` | 300초 안에 각각 protocol 위반으로 끝난 영속 서비스 연결 4개는 재시작을 멈춘다. 다음 전송은 어느 서비스에도 연결하지 않고 `sidecar <name>: restart limit`로 실패한다. | all |
| `sidecars-transport.endpoint.concurrent-hosts-share-authenticated-service` | 두 호스트가 토큰으로 한 서비스 엔드포인트에 인증하고 각자의 이벤트를 받는다. | all |
| `sidecars-transport.hello.declares-protocol-one` | hello 요청은 프로토콜 1을 선언한다. | all |
| `sidecars-transport.reconnect.after-connection-loss-preserves-owner` | 서비스가 연결을 끊으면 다음 보내기가 다시 연결하고 이벤트는 계속 소유자와 표면에 도착한다. | all |
| `sidecars-transport.stop.close-owner-failure-returns-promptly` | close-owner 실패 응답은 중지를 1초 넘게 늦추지 않는다. | all |
| `sidecars-transport.hello.reports-a-service-of-another-version` | hello 응답의 `version`이 `installed.json`의 기록과 다르거나 없는 persistent 서비스는 `host.sidecars` `outdated`에 실행 중인 version이나 `null`, 설치된 version, 열린 표면 수와 함께 나열된다. 설치된 version의 서비스는 나열되지 않는다. | all |
| `sidecars-transport.hello.client-is-the-configuration-directory` | host가 상주 service에 보내는 `hello` 메시지는 애플리케이션의 설정 폴더를 `client`로 싣는다. | all |
| `sidecars-transport.hello.rejects-auth-failure` | 실패한 hello 응답은 보내기를 "authentication handshake failed"로 실패시킨다. | all |
| `sidecars-transport.hello.rejects-unsupported-protocol-without-replacing-endpoint` | 다른 프로토콜의 hello 응답은 보내기를 실패시키고 endpoint.json을 바꾸지 않는다. | all |
| `sidecars-transport.hello.times-out` | hello를 받고 답하지 않는 service는 5초 뒤 "the service did not answer hello within 5s"로 보내기를 실패시킨다. | all |
| `sidecars-transport.hello.deadline-ends-with-its-answer` | hello 의 deadline 은 그 답과 함께 끝난다. persistent service 가 더 오래 조용해도 그 뒤에 보낸 내용은 owner 에게 도착한다. | all |
| `sidecars-transport.startup.times-out` | 준비 상한 안에 endpoint를 출력하지 않는 시작한 service는 "the service did not print its endpoint within <bound>"로 보내기를 실패시키고, host는 그 service를 끝내고 회수한다. | all |
| `sidecars-transport.startup.exits-before-endpoint` | endpoint 전에 끝난 시작한 service는 "service exited before endpoint"로 보내기를 실패시킨다. | all |
| `sidecars-transport.endpoint.replaces-dead-service-endpoint` | 죽은 서비스가 남긴 엔드포인트는 새 서비스 엔드포인트로 바뀐다. | all |
| `sidecars-transport.endpoint.live-unreachable-reported-without-replacement` | 살아 있지만 연결할 수 없는 서비스의 엔드포인트는 보내기를 실패시키고 바뀌지 않는다. | all |
| `sidecars-transport.stop.close-owner-then-shutdown` | 중지는 close-owner를 보내고 성공 응답 뒤에 shutdown을 보낸다. | all |
| `sidecars-transport.stop.own-close-is-not-a-read-error` | 중지 중에 서비스 연결을 닫아도 `persistent read` 오류 줄을 쓰지 않는다. host 자신이 닫았기 때문이다. | all |
| `sidecars-transport.stop.accepts-close-answers-sent-before-stop` | 지속 service가 중지 전에 보낸 closed 알림에 중지가 시작된 뒤 답해도 받아들인다. 중지는 shutdown을 보내고 닫는 중인 표면이 남지 않는다. | all |
| `sidecars-transport.stop.leaves-the-close-of-a-replacement-to-the-replacement` | 지속 service의 owner 닫기는 연결마다 한 번 실행된다. 교체가 owner를 닫는 동안 시작한 종료는 두 번째 close-owner를 보내지 않고, 교체가 끝나기를 기다리며, transport를 다시 닫지 않는다. | all |
| `sidecars-transport.detach.closes-the-connection-without-closing-the-owner` | 사이드카를 분리하면 상주 service의 연결만 끝나고 close-owner와 shutdown을 보내지 않으며, 분리 뒤의 stop은 더 보내지 않는다. | all |
| `sidecars-transport.persistent.revives-a-lost-connection` | 서비스가 연결을 끊으면 호스트가 전송 없이 다시 시작하고 소유 표면이 연결 이벤트를 받는다. | all |
| `sidecars-transport.persistent.connection-notice-reaches-only-senders` | 영속 사이드카의 연결 알림은 연결을 다시 맺지 못한 뒤와 다시 연결하는 전송 뒤에 그 사이드카로 전송한 표면에만 닿는다. 다른 사이드카로만 전송한 표면은 받지 않는다. | all |
| `sidecars-transport.persistent.lost-connection-writes-an-error-line` | host가 실행되는 동안 프로토콜 위반 없이 끝난 상주 service의 연결은 host가 다시 연결한 뒤 `error host sidecar <name>: connection lost; restarted (end: <end>, waiting: <n>)`를 한 번 쓰고, 연결하지 못하면 `error host sidecar <name>: connection lost; restart failed: <reason>`을 쓴다. | all |
| `sidecars-transport.replace.replaces-an-outdated-service` | `hello`의 version이 설치된 version과 다른 상주 service를 교체하면 `close-owner`와 `shutdown`을 보내고, 연결을 닫고, 생성 경로로 설치된 service를 시작하고, 그 sidecar로 보낸 각 표면에 연결 알림을 보내고, `host.sidecars`의 `outdated`에서 그 sidecar를 빼고, `sidecar <name>: service <running> replaced by <installed>`를 쓴다. | all |
| `sidecars-transport.replace.refuses-a-service-that-is-not-outdated` | 실행 중인 service가 없거나 service가 설치된 version이면 그 sidecar의 교체는 sidecar를 밝히는 오류로 실패하고 service에 아무것도 보내지 않는다. | all |
| `sidecars-transport.replace.ends-a-service-of-an-undeclared-sidecar` | 사이드카가 더 이상 선언되지 않은 실행 중인 상주 service는 `installed` `null`로 오래된 것으로 보고된다. 교체하면 `close-owner`와 `shutdown`을 보내고, 실행 파일을 시작하지 않고, 그 sidecar로 보낸 각 표면에 선언되지 않은 오류의 연결 알림을 보내고, `outdated`에서 빼고, info로 `sidecar <name>: service <running> ended; the sidecar is not declared`를 기록한다. | all |
| `input.pointer.reads-the-press-target-before-delivery` | 주입된 press는 main thread의 한 단계 안에서 전달 전에 그 아래 view를 읽고, target을 읽을 수 없는 press는 전달하지 않는다. | all |
| `image.drawing.sent-at-attach-and-on-change` | 호스트는 image region의 공급자에게 region의 부착 때와 상태가 바뀔 때마다 그 그리기 상태를 보내고, 바뀌지 않은 상태는 다시 보내지 않는다. | all |
| `image.drawing.reads-occlusion-at-attach` | 만들 때 완전히 가려진 창에 부착된 region의 그리기 상태는 false이며, 창 event가 아니라 AppKit occlusion 상태에서 읽는다. | all |
| `image.drawing.reports-a-hidden-surface` | region의 그리기 메시지는 바깥 표면이 숨김을 알린 동안 `hidden`을 true로, 그 밖에는 false로 적는다. 아무것도 알리지 않은 표면은 숨겨진 것이 아니고, 값이 바뀌면 메시지를 보내며, 새 연결의 서비스는 그 값을 다시 받는다. | all |
| `image.drawing.configures-shown-regions` | 보이는 region은 창의 상태와 상관없이 설정을 받고, 화면에 없는 창에서 raster가 바뀔 때도 받으며, 숨겨진 region은 받지 않는다. 표시 대기는 그리기 상태가 아닌 region을 기다리지 않고 그리기 상태가 된 region을 기다리며, 설정된 raster는 region이 그리기 상태가 될 때 다시 설정되지 않는다. | all |
| `image.drawing.configures-a-raster-that-changed-while-hidden` | region이 숨겨진 동안 바뀐 raster는 설정을 받지 않는다. region이 보이면 그리기 메시지 뒤에 바뀐 raster의 설정을 한 번 보내고, 바뀌지 않은 raster는 다시 설정하지 않는다. | all |
| `image.drawing.answers-transfers-while-not-drawing` | region이 그리기를 멈추기 전에 받은 전송 그림은 `consumed`나 오류로 답을 받는다. | all |
| `image.drawing.draws-covered-in-diagnostic-builds` | 진단 build에서 가려진 창의 region은 창이 가려진 채 그리는 동안 그리기 상태이고, 바깥 표면이 숨은 동안과 창이 가려진 채 그리기를 끝낸 뒤에는 그리기 상태가 아니며, 화면에 있는 창에서 가려진 채 그리기는 아무것도 바꾸지 않는다. | all |
| `image.drawing.covered-window-never-draws-without-diagnostics` | 진단이 없는 build에는 가려진 채 그리기의 setter가 없고 `diagnostics.window.draw-covered`를 선언하지 않는다. 가려진 창의 region은 창이 화면에 다시 있을 때만 그린다. | all |
| `sidecars-transport.replace.runs-when-sessions-reach-zero` | layout 목록이 오래된 service에 표면을 남기지 않으면 host가 그 service를 교체한다. | all |
| `sidecars-transport.replace.keeps-a-service-that-a-layout-holds` | 이 process에서 보낸 적이 없는, 그 사이드카의 plugin 표면을 layout이 쥐는 동안에는 표면이 닫혀도 오래된 service가 남고 그 표면은 `sessions`에 들어간다. 그 표면이 없는 목록이 오면 service를 교체한다. | all |
| `sidecars-transport.replace.counts-the-surfaces-of-the-plugins-of-the-sidecar` | plugin이 그 사이드카를 나열하지 않는 layout 표면은 오래된 service를 붙들지 않는다. | all |
| `sidecars-transport.replace.waits-for-the-first-layout-list` | layout의 첫 목록 전에는 표면이 닫혀도 오래된 service를 교체하지 않는다. | all |
| `sidecars-transport.persistent.starts-in-new-session` | 호스트가 시작한 영속 서비스는 새 session의 leader이므로 애플리케이션의 process group이나 terminal의 signal을 받지 않는다. | all |
| `sidecars-transport.endpoint.zombie-service-does-not-exist` | 좀비 서비스 pid 는 존재하는 서비스로 치지 않아 낡은 endpoint 를 교체한다. | all |
| `sidecars-transport.endpoint.foreign-service-process-exists` | 다른 사용자가 소유한 프로세스의 service pid 는 존재하는 service 다. 거부된 signal 확인이 그 프로세스가 있음을 보이기 때문이다. | all |
| `sidecars-transport.endpoint.waits-for-the-end-of-a-service-process` | service process의 종료를 기다리면 시간 안에 process가 끝났을 때와 process가 없을 때 true를, 시간이 지나도 실행 중이면 false를 답한다. | all |
| `sidecars-transport.replace.waits-for-the-end-of-the-service-process` | 교체한 상주 service는 endpoint의 process가 끝난 뒤에만 설치된 service를 시작하고, 중지 기한 안에 끝나지 않는 process는 sidecar를 밝히는 오류 줄과 함께 교체를 실패시켜 sidecar를 오래된 채로 둔다. | all |
| `sidecars-transport.persistent.revive-failure-is-reported` | 재시작 실패는 연결 끊김과 그 까닭을 소유 표면에 알린다. | all |
| `sidecars-transport.persistent.oversize-line-fails-the-connection` | 64 MiB 메시지 한도보다 긴 service 줄은 줄의 나머지를 읽지 않고 연결을 닫으며, 보낸 surface에 `message exceeds 67108864 bytes`와 함께 `sidecar-failure`를 보낸다. | all |
| `sidecars-transport.persistent.invalid-event-fails-the-connection` | JSON 객체가 아닌 service 줄이나 문자열 `surface`가 없는 surface event는 연결을 닫고 보낸 surface에 `invalid message: ...`와 함께 `sidecar-failure`를 보낸다. 다음 전송은 다시 연결한다. | all |
| `recording.state.poisoned-lock-is-recovered` | 상태를 쥔 다른 thread가 panic한 뒤 녹화를 끝내거나 그 폴더를 읽으면 상태를 복구한다. panic은 panic hook이 기록한다. | tauriv2 only: Rust는 holder가 panic하면 mutex를 poisoned로 표시하지만 Go mutex에는 그런 상태가 없다 |
| `modal.state.poisoned-lock-is-recovered` | 모달 기록을 쥔 다른 thread가 panic한 뒤 열린 모달이나 그 mode를 읽으면 저장된 모달을 돌려준다. panic은 panic hook이 기록한다. | tauriv2 only: Rust는 holder가 panic하면 mutex를 poisoned로 표시하지만 Go mutex에는 그런 상태가 없다 |
| `surface-activation.owner.resolves-registered-view` | 등록된 네이티브 뷰는 그 표면 id로 해석된다. | all |
| `surface-activation.owner.ignores-unknown-view` | 등록되지 않은 네이티브 뷰는 표면으로 해석되지 않는다. | all |
| `surface-activation.owner.ignores-empty-owner` | 빈 표면 id로 등록된 뷰는 표면으로 해석되지 않는다. | all |
| `surface-activation.create.propagates-native-failure` | 네이티브 표면 생성이 실패하면 네이티브 오류와 표면 id를 담은 오류를 반환한다. | all |
| `surface-activation.create.rejects-nil-handle` | 핸들을 반환하지 않은 네이티브 표면 생성은 "nil handle"로 실패한다. | all |
| `surfaces-geometry.rect.accepts-zero-size` | 크기가 0인 사각형은 올바르다. | all |
| `surfaces-geometry.rect.rejects-negative-size` | 크기가 음수인 사각형은 잘라 맞추지 않고 거부한다. | all |
| `surfaces-geometry.rect.rejects-non-finite` | 크기가 유한하지 않은 사각형을 거부한다. | all |
| `surfaces-geometry.sync.rejects-surface-rect-before-layout` | 배치 트랜잭션을 시작하기 전에 실행하는 검사는 표면 사각형의 크기가 음수인 동기화 요청을 `surface "<id>" geometry must not have a negative size`로 거부하고, 올바른 요청은 받는다. | all |
| `surfaces-geometry.sync.rejects-overlay-rect-before-layout` | 배치 트랜잭션을 시작하기 전에 실행하는 검사는 창 overlay 사각형의 크기가 음수인 동기화 요청을 `window overlay geometry must not have a negative size`로 거부하고, 올바른 요청의 overlay를 표시 여부와 함께 반환한다. | all |
| `surfaces-geometry.sync.plugin` | 동기화 요청은 표면마다 그 plugin을 적는다. 배치 트랜잭션을 시작하기 전에 실행하는 검사는 plugin이 없는 표면을 `surface "<id>" requires its plugin`으로, 이미 받은 표면의 plugin이 다르면 `surface "<id>" changed its composition declaration`으로 거부하고, plugin과 composition이 같은 표면은 받는다. 동기화가 받은 표면의 페이지 composition 선언은 같은 plugin을 적는다. | all |
| `surfaces.sync.failure-leaves-no-begun-layout` | 표면 동기화는 배치 트랜잭션을 시작하기 전에 창 덮개를 놓으므로 거부된 덮개는 트랜잭션을 시작하지 않고, 뒤 단계가 실패하면 시작한 트랜잭션을 취소한다. 성공한 동기화는 취소하지 않는다. | all |
| `surfaces.sync.titlebar.accepts-heights-in-range` | 배치 트랜잭션을 시작하기 전에 실행하는 검사는 `titlebar` 가 32 이상 200 이하 point 인 동기화 요청을 받는다. | all |
| `surfaces.sync.titlebar.rejects-other-heights` | 배치 트랜잭션을 시작하기 전에 실행하는 검사는 `titlebar` 가 32 point 미만이나 200 point 초과, NaN, 무한대인 동기화 요청을 `title bar height must be a finite number from 32 through 200 points` 로 거부한다. | all |
| `surfaces.sync.titlebar.set-in-begun-layout` | 표면 동기화는 배치 트랜잭션을 시작한 뒤, 표면을 놓기 전에 제목줄 높이를 정한다. 높이를 정하지 못하면 표면을 놓지 않고, 시작한 트랜잭션을 취소하고, 그 오류로 동기화를 실패시킨다. 표면을 놓지 못하면 트랜잭션을 취소하기 전에 이전 제목줄 높이를 다시 정한다. | all |
| `page.start.titlebar-follows-frame-factor` | 호스트가 시작 문서에 답하기 전에 정하는 제목줄 높이는 모든 글자 크기 단계에서 공통 설정 `textSize` 에 대한 `round(max(40, 36 × textSize))` 이고, 설정이 없으면 40 이다. 수가 아닌 `textSize` 는 `common setting textSize must be a number, not <type>` 으로, 0.5 이상 3 이하 밖의 수는 `common setting textSize must be from 0.5 through 3` 으로 실패한다. | all |
| `workspace.settings.rejects-project-common-only-keys` | 공통 전용 키 `projectOpening`, `textSize`, `memorySaver`, `memorySaverDelay` 각각에 대해, 그 키가 있는 프로젝트 설정 파일은 스냅샷에서 그 프로젝트에 `settingsError` `<path>: <key> is common-only` 를 주고, 그 키가 있는 프로젝트 설정 쓰기는 `<key> is common-only` 로 실패한다. | all |
| `workspace.settings.common-only-keys-are-the-declared-list` | 호스트가 거부하는 공통 전용 키는 그 language host library가 embed한 `workbench.json` 사본의 목록이며, 그 목록의 순서를 따른다. | all |
| `workspace.settings.refuses-project-file-at-its-project` | 현재 `format`이 없는 프로젝트 설정 파일은 스냅샷에서 그 프로젝트에 `settingsError` `<path>: settings.json: format must be 1`을 주고 `settings`는 주지 않으며, 다른 프로젝트는 `settingsError` 없이 설정을 유지한다. | all |
| `workspace.snapshot.reports-refused-stored-files` | 다른 형태의 `projects.json`이 있을 때 snapshot은 프로젝트 없이 빈 공통 설정과 `<file>: projects.json: format must be 1`의 `projectsError`를 돌려준다. 다른 형태의 `settings.json`이 있을 때는 빈 공통 설정과 `<file>: settings.json: format must be 1`의 `settingsError`를 돌려준다. 그 뒤 `add`나 공통 `settings` 쓰기는 그 오류로 실패하고 file은 바뀌지 않는다. | all |
| `exposure.host-buttons.notifies-mask-change` | `host.buttons`는 버튼 source가 마지막으로 보고한 마스크를 담은 `{mask}`이고, 그와 다른 마스크의 보고는 새 값으로 감시자에게 한 번 알리며, 같은 마스크의 보고는 알리지 않는다. | all |
| `exposure.status-change.refuses-host-name` | workbench가 `host.`로 시작하는 이름에 보낸 상태 변경은 `the page cannot change host status <name>`으로 거부되고, 다른 이름의 변경은 받아들여진다. | all |
| `images.calls.name-the-call` | 인자 해석 뒤 image 영역 호출의 실패는 호출 이름 `imageAttach`, `imageFocus`, `imageCaret`, `imageText`, `imageDetach`를 붙인 `<call>: <reason>`이다. | all |
| `host-calls.decode.messages` | 인자 decoder는 빠졌거나 `null`인 필수 field, 다른 JSON 형식의 값, 정수 field 범위 밖이거나 소수인 수, `null` 인자, 길이가 다른 고정 길이 배열을 [host 호출](native-host.ko.md#host-호출)의 message로 거부하고, 빠졌거나 `null`인 선택 field는 받는다. | all |
| `host-calls.native.image-argument-lists` | surface 페이지의 요청 하나와 좌표 넷인 `ImageCaret` 호출과 요청 하나와 텍스트인 `ImageText` 호출은 각자의 인자 목록으로 해석되어 호출자 확인에 닿는다. | wailsv3 only: Wails page runtime은 surface 페이지 호출을 native bridge로 보내고 host가 그 인자 목록을 해석한다. Tauri surface 페이지는 메인 페이지의 명령을 부른다. |
| `host-calls.decode.every-binding` | 모든 `Host` binding의 모든 인자는 binding이 다른 일보다 먼저 해석하는 raw JSON이므로 framework는 인자를 해석하지 않는다. | wailsv3 only: Go reflection은 실행 중에 binding을 나열한다. `make check-host-files`는 framework 객체가 아닌 모든 Tauri 명령 인자가 `Argument<T>`이기를 요구한다. |
| `termination.signal.first-requests-quit-second-ends-process` | 첫 종료 신호는 종료를 요청하고 두 번째 신호는 프로세스를 끝낸다. | all |
| `termination.signal.begins-the-quit-state` | 첫 종료 신호는 종료를 요청하기 전에 종료 상태를 시작한다. `host.quit`이 시작하는 상태와 같으므로, 그 종료 중의 WebContent process 종료는 오류 줄을 쓰지 않는다. | all |
| `log.closed.signal-before-quit` | 첫 종료 신호는 quit을 요청하기 전에 원인 `signal`과 번호를 담은 `log.closed`를 저장하므로, quit의 flush가 실행될 때 기록이 로그에 있다. | all |
| `log.closed.cause-before-quit` | 프로세스 종료 요청은 quit을 실행하기 전에 원인(`quit-command`, `quit-request`, `last-window-closed`, `update`)을 담은 `log.closed`를 저장한다. | all |
| `log.closed.exit-request-source` | 원인 `exit-request`의 `log.closed`는 quit이 어디서 왔는지 밝힌다: 보낸 process와 그 이름을 담은 `apple-event`, signal과 보낸 process를 담은 `signal`, host의 요청을 담은 `host`, 그리고 host의 어떤 부분도 quit을 요청하지 않았을 때 현재 event의 type을 담은 `menu`. | all |
| `log.closed.fatal-exit-code` | shutdown 없이 프로세스를 끝내는 fatal error는 그 오류 기록 뒤에 종료 코드 1을 담은 원인 `exit`의 `log.closed`를 저장한다. | wailsv3, mygo only: Rust host는 panic 뒤에만 shutdown 없이 프로세스를 끝내며, 그것은 `log.panic.records-an-event`가 다룬다 |
| `log.closed.passes-every-gate` | writer는 class `lifecycle`을 끈 정책에서도 level `info`, class `lifecycle`의 `log.closed`를 저장한다. | all |
| `window-close.surfaces.closes-regions-then-surface` | 창을 닫으면 논리 표면마다 id 순서로 그 문서 영역과 그림 영역을 닫은 뒤 표면을 닫고, 그 이름을 창의 문서 영역 목록과 그림 영역 목록에서 지운다. | all |
| `window-close.native-window.used-in-reading-step` | native 창을 쓰는 host 요청은 native 창을 native code에 넘기는 main thread 단계에서 읽으므로(Wails host에서는 main thread가 그 단계를 위해 C에서 기다리는 동안 worker가 읽고, main thread가 같은 단계에서 실행하는 C 호출로 넘긴다: [hosts](hosts.ko.md#wails-host의-main-thread)), 요청의 앞선 단계 뒤에 main thread가 처리한 닫기가 닫힌 창을 native code에 넘기지 않는다. 그 단계 전에 닫힌 창은 native code에 닿지 않고, 요청은 오류 1003 `window "<name>" does not exist`로 실패한다. | all |
| `window-close.surfaces.reports-every-failure` | 네이티브 닫기 하나가 실패해도 나머지를 닫고, 창 닫기는 모든 실패를 표면 id 와 객체 종류와 함께 반환한다. | all |
| `host.callback-handle.retains-state-until-delete` | Go callback handle은 0이 아니며, 삭제할 때까지 garbage collection 뒤에도 callback과 변경된 Go 상태를 유지한다. 삭제 뒤 다시 읽거나 삭제하면 panic한다. | wailsv3, mygo only: Go callback token registry의 계약이며, Tauri는 Rust 소유권으로 callback 값을 유지한다 |
| `host.callback-handle.rejects-zero` | 0인 Go callback handle을 읽거나 삭제하면 panic한다. | wailsv3, mygo only: Go callback token registry의 계약이며, Tauri는 Rust 소유권으로 callback 값을 유지한다 |
| `host.callback-handle.distinguishes-nil` | 유효한 Go callback handle은 nil을 보관할 수 있고 읽으면 nil을 돌려준다. nil 값과 유효하지 않은 handle은 구분된다. | wailsv3, mygo only: Go callback token registry의 계약이며, Tauri는 Rust 소유권으로 callback 값을 유지한다 |
| `host.callback-handle.never-reuses-deleted-token` | 새 Go callback handle은 삭제된 token과 다르다. 삭제된 token은 계속 읽을 수 없으며 새 callback을 가리킬 수 없다. | wailsv3, mygo only: Go callback token registry의 계약이며, Tauri는 Rust 소유권으로 callback 값을 유지한다 |
| `host.callback-handle.isolates-concurrent-owners` | 동시에 실행되는 Go callback owner들이 handle을 반복해서 할당하고 읽고 삭제해도 다른 owner의 값을 읽지 않는다. | wailsv3, mygo only: Go callback token registry의 계약이며, Tauri는 Rust 소유권으로 callback 값을 유지한다 |
| `verification.native-test-facade.validates-provider-and-recordings` | Go native-test facade는 설치 전 사용, 불완전하게 주입한 함수 table, 두 번째 설치를 거부한다. Sampler 오류와 얻은 count를 보존하고, 읽을 수 없거나 누락된 recorder entry를 거부하며, 완전한 recording의 모든 field를 돌려준다. 이 사례는 주입한 operation으로 facade를 검사하며 실제 thread 표본을 검증하지 않는다. | wailsv3, mygo only: Go native test 지원의 계약이며, Tauri는 이 Go facade와 loader를 쓰지 않는다 |
| `verification.native-test-loader.rejects-invalid-artifacts` | Go native-test loader는 설정하지 않은 경로, 빈 경로, 상대경로, 없는 파일, directory, 유효하지 않은 native library byte를 거부한다. 오류마다 선언한 변수 이름을 남기며 절대경로이면 그 경로도 남긴다. | wailsv3, mygo only: Go native test 지원의 계약이며, Tauri는 이 Go facade와 loader를 쓰지 않는다 |
| `verification.native-test-loader.retains-handle-and-reports-missing-symbols` | 명시적으로 선언한 native test artifact를 두 번 열면 같은 0이 아닌 handle을 돌려준다. Direct-runner symbol의 주소는 0이 아니며, 없는 symbol을 요청하면 0과 그 symbol 이름을 담은 오류를 돌려준다. | wailsv3, mygo only: Go native test 지원의 계약이며, Tauri는 이 Go facade와 loader를 쓰지 않는다 |
| `platform.native-memory.cstring-is-a-nul-terminated-copy-the-caller-frees` | `CString`은 Go 문자열의 NUL로 끝나는 native 복사본을 돌려준다. 빈 문자열이면 NUL byte 하나이며, 복사본은 문자열과 메모리를 공유하지 않고 caller가 해제할 때까지 할당된 채로 남는다. | wailsv3, mygo only: Go native memory helper는 설치된 native provider의 allocator로 문자열과 byte를 복사하고, Rust는 호출 지점마다 명시적으로 할당한다(host tree의 H63 행) |
| `platform.native-memory.gostring-copies-to-the-first-nul` | `GoString`은 첫 NUL까지의 native byte를 그것과 메모리를 공유하지 않는 Go 문자열로 복사하고, nil에는 빈 문자열을 돌려준다. | wailsv3, mygo only: Go native memory helper는 설치된 native provider의 allocator로 문자열과 byte를 복사하고, Rust는 호출 지점마다 명시적으로 할당한다(host tree의 H63 행) |
| `platform.native-memory.cbytes-is-a-binary-copy-the-caller-frees` | `CBytes`는 0 byte를 포함한 binary data의 native 복사본을 돌려준다. 복사본은 입력과 메모리를 공유하지 않고 caller가 해제할 때까지 할당된 채로 남으며, 빈 data에도 할당된다. | wailsv3, mygo only: Go native memory helper는 설치된 native provider의 allocator로 문자열과 byte를 복사하고, Rust는 호출 지점마다 명시적으로 할당한다(host tree의 H63 행) |
| `platform.native-memory.gobytes-copies-the-requested-range` | `GoBytes`는 요청한 길이만큼의 native byte를 그것과 메모리를 공유하지 않는 Go slice로 복사하고 아무것도 해제하지 않는다. nil의 길이 0은 빈 slice를 준다. | wailsv3, mygo only: Go native memory helper는 설치된 native provider의 allocator로 문자열과 byte를 복사하고, Rust는 호출 지점마다 명시적으로 할당한다(host tree의 H63 행) |
| `platform.native-memory.invalid-range-or-failed-allocation-panics` | `GoBytes`는 음수 길이와 양수 길이의 nil에서 panic하고, `CString`과 `CBytes`는 native 할당이 실패하면 빈 입력에서도 panic한다. | wailsv3, mygo only: Go native memory helper는 설치된 native provider의 allocator로 문자열과 byte를 복사하고, Rust는 호출 지점마다 명시적으로 할당한다(host tree의 H63 행) |
| `host.main-thread.runs-no-code-outside-own-stack` | Go host가 main-thread step(Wails host에서는 각 exported callback, `EnqueueUI`, `application.InvokeSync`, Dock menu callback, memory pressure callback, stall heartbeat, 비동기 signal, mygo host에서는 U1의 worker에서 실행되는 `App.Run`의 Go 코드, framework의 각 Objective-C method와 block, 각 C callback)을 실행하는 동안, main thread의 stack pointer를 표본한 값은 모두 main thread의 stack 안에 있다. | wailsv3, mygo only: Tauri host는 main thread의 stack 위에서 Rust를 실행하므로 표본할 Go stack이 없다 |
| `host.main-thread.stall-check-fails-a-send-into-a-wait` | main-thread entry의 stall check는 watch가 main run loop의 wait 안으로 보낸 heartbeat를 실패로 판정한다. heartbeat들이 읽은 wait은 통과하더라도, watch가 wait 안으로 보낸 send의 수와 그 send가 일으킨 wake가 실패로 만든다. | wailsv3, mygo only: stall check는 Go test support package의 main-thread entry에 속하며, Tauri host는 그 entry를 실행하지 않는다 |
| `host.main-thread.start-requires-both-functions` | macOS에서 Go language host library의 시작은 첫 native call 전에 `main-thread functions are not installed`와 framework adapter가 설치하지 않은 함수 각각의 이름으로 실패한다. | wailsv3, mygo only: Rust language host library는 Tauri host의 main thread에서 실행되며 main-thread 함수가 없다 |
| `host.stall.recorded-without-a-check` | main run loop가 event를 처리하는 동안 main thread 밖의 thread가 250 ms마다 main thread에 heartbeat를 보낸다. 1 s 이상 늦은 heartbeat는 `host.stall`(`late_ms`)을 저장하고, `logs/stall-host-<pid>-<ms>.txt`로 표본한 thread들의 stack은 `host.stall.sampled`(`path`, 파일을 쓰지 못했으면 `error`)를 저장하며, 다음 heartbeat는 `host.stall.resumed`(`stalled_ms`)를 저장한다. window check 없이 그렇게 한다. 기본 정책은 앞의 두 기록을 gate 예외([정책](logging.ko.md#정책))로 저장한다. | all |
| `host.stall.watch-late-separates-scheduling` | 감시 thread가 heartbeat와 함께 늦게 깨어나면, `host.stall`(`late_ms`)은 감시 thread가 250 ms 박자를 넘어 깨어난 시간인 `watch_late_ms`를 가져, `watch_late_ms`가 `late_ms`의 절반 이상이다. | all |
| `host.stall.watch-late-separates-blocked-main` | 감시 thread가 제때 깨어나고 heartbeat만 늦으면, `host.stall`은 `watch_late_ms` 0을 가져, `late_ms`의 절반 미만이다. | all |
| `host.stall.sample-keeps-the-watch-running` | stall의 sample이 도는 동안 감시 thread는 event를 처리하는 main run loop에 heartbeat를 계속 보낸다. stall은 `host.stall.resumed`로 끝나고, sample 시간은 이후 `host.stall`의 `late_ms`에 들어가지 않으며, sample이 도는 중의 stall은 `error`가 `a sample of the threads is still running`인 `host.stall.sampled`이다. | all |
| `host.stall.waiting-run-loop-takes-no-heartbeat` | main run loop가 event를 기다리는 동안 감시 thread는 heartbeat를 보내지 않고 timer 없이 막힌다. run loop가 깨어나면 박자가 이어지고, 대기 시간은 늦음이 아니며, 깨어나서 돌지 않는 run loop는 `late_ms`를 그 깨어남부터 재는 `host.stall`이다. | all |
| `host.stall.ends-when-the-run-loop-waits` | stall에서 돌아와 다음 박자 전에 대기로 들어간 main thread는 그 대기의 시작까지의 `stalled_ms`를 가진 `host.stall.resumed`를 저장하고, 도는 sample은 여전히 `host.stall.sampled`를 저장한다. | all |
| `host.stall.stop-waits-for-the-sample` | host 의 shutdown 은 main thread 에서의 자기 작업 전에 watch 를 멈춘다. stop 은 도는 sample 이 끝나 그 `host.stall.sampled` 를 저장한 뒤에 돌아오고, stop 뒤에는 stall 을 기록하지도 sample 을 시작하지도 않으므로 sample process 가 host 보다 오래 남지 않는다. | all |
| `window-close.surfaces.closed-once` | surface sync 가 제거하는 surface 는 handle 을 닫기 전에 창의 surface registry 에서 빠지므로, 그 닫기보다 먼저 실행된 창 닫기는 그 handle 을 받지 않고 모든 surface handle 은 한 번만 닫힌다. 제거된 surface 하나의 닫기가 실패해도 나머지를 닫고, sync 는 모든 실패를 surface id 와 함께 반환한다. | tauriv2 only: Wails host 는 surface 를 view 객체로 닫고 그 객체가 main-thread 단계의 C 호출([hosts](hosts.ko.md#wails-host의-main-thread))에서 handle 을 비우므로 두 번째 닫기는 native code 에 닿지 않는다. Tauri host 는 surface 를 handle 로 닫고 그 handle 은 registry 항목만 가진다 |
| `surfaces.sync.name-outlives-native-surface` | surface sync가 제거하는 surface는 native surface가 닫힐 때까지 이름을 유지한다. 닫기와 이름 제거가 main thread의 한 단계에서 실행되므로, 창의 native surface 읽기(`host.window`)는 이름이 있는 surface를 찾거나 surface를 찾지 않는다. 닫기가 실패해도 이름을 제거하고 실패를 반환한다. | tauriv2 only: Wails host는 worker가 main thread에 전달한 C 호출([hosts](hosts.ko.md#wails-host의-main-thread))로 view를 닫고 그 main-thread 단계가 끝난 뒤 이름을 제거하므로, 둘 사이의 창 읽기는 surface를 찾지 않고 이름은 알려진 상태다. Tauri host는 sync의 thread에서 main thread로 닫기를 보낸다 |
| `window-overlay.rects.packs-four-values-per-rect` | 보이는 오버레이는 입력 순서대로 x, y, width, height 값으로 묶인다. | all |
| `window-overlay.rects.filters-hidden` | 숨긴 오버레이는 묶은 목록에서 빠진다. | all |
| `workspace.config-dir.creates-requested-path` | 없는 설정 디렉터리를 준비하면 만들고 정규 경로를 반환한다. | all |
| `workspace.config-dir.creates-owner-only` | 준비 과정이 만든 설정 디렉터리의 권한은 0700이며, 이미 있는 디렉터리는 권한을 유지한다. | all |
| `workspace.config-dir.rejects-empty-path` | 빈 설정 디렉터리 경로를 거부한다. | all |
| `workspace.config-dir.rejects-path-under-file` | 일반 파일 아래의 설정 디렉터리 경로를 거부한다. | all |
| `workspace.settings.project-file-holds-only-overrides` | 프로젝트 설정 파일은 프로젝트 재정의만 담는다. | all |
| `workspace.settings.persist-across-reopen` | 같은 설정 디렉터리로 다시 연 작업 공간은 저장된 공통 설정과 프로젝트 설정을 보여 준다. | all |
| `workspace.settings.reset-removes-override` | 프로젝트 재정의를 제거하면 빈 프로젝트 설정 객체가 남는다. | all |
| `workspace.settings.rejects-project-opening-override` | projectOpening의 프로젝트 재정의를 거부한다. | all |
| `workspace.tab-state.put-keeps-other-entries` | `tab-state.json`이 없으면 `tabState`는 `null`을 읽는다. 한 설정 디렉터리의 두 저장소에서 다른 탭의 `tabStatePut` 두 번은 `{format: 1, tabs}`에 두 entry를 모두 지키고, `null` entry는 자기 탭만 지우며, put마다 쓴 file의 크기를 돌려준다. | all |
| `workspace.tab-state.rejects-other-format` | 형식 2의 `tab-state.json`에 대한 `tabStatePut`은 `<path>: tab-state.json: format must be 1`로 실패하고 file을 바꾸지 않는다. | all |
| `workspace.tab-state.rejects-invalid-entry` | `tabStatePut`은 탭이 없으면 `tab state put requires a tab`로, 빈 entry, `kept: false`, 빈 label, 양의 정수 format이나 value가 없는 state, 다른 필드는 `invalid tab state entry of <tab>: <field>`로 거부한다. | all |
| `workspace.tab-session.put-rewrites-own-file` | `tab-sessions/<tab>.json`이 없으면 `tabSession`은 `null`을 읽고, folder가 없으면 `tabSessions`는 `[]`를 나열한다. `tabSessionPut {tab, regions}`는 자기 탭의 file만 `{format: 1, regions}`로 바꾸고 그 크기를 돌려주며, 다른 탭의 file과 `tab-state.json`은 바꾸지 않는다. `tabSessions`는 file이 있는 탭을 이름 순서로 나열하고, `null` `regions`는 file을 지우고 `null`을 돌려주며 file이 없을 때도 그렇다. | all |
| `workspace.tab-session.rejects-other-format` | 형식 2이거나 형식이 없는 file의 `tabSession`은 `<path>: tab-sessions/<tab>.json: format must be 1`로 실패하고, `regions`가 object가 아닌 file은 `<path>: tab session regions is not an object`로 실패한다. | all |
| `workspace.tab-session.rejects-invalid-request` | 탭이 없는 요청은 `tab session requires a tab`로, 소문자, 숫자, hyphen이 아니고 section surface id(`workspace.tab-session.section-surface-file`)도 아닌 탭은 `invalid tab session tab: <tab>`로, 빈 `regions`는 `invalid tab session of <tab>: empty`로, 비어 있지 않은 text의 `{session}`이 아닌 region은 `invalid tab session region of <tab>: <region>`로 실패한다. | all |
| `workspace.tab-session.section-surface-file` | section surface id `<space>/<sidebar>/<section>`는 space가 `spc-` 뒤에 `a`–`z`와 `2`–`7` 중 여섯 문자가 오는 형태이고, sidebar가 `left`, `right` 또는 `<card>:<side>`(side는 top, bottom, left, right 중 하나)이고 section이 `<plugin>.<name>`일 때, session file `tab-sessions/<name>.json`에 대응한다. `<name>`은 unreserved 문자(영문자, 숫자, `-`, `.`, `_`, `~`)를 유지한 채 id를 RFC 3986 percent 인코딩한 값이다. `tabSessionPut`은 그 file을 쓰고, `tabSession`은 그 file을 읽으며, `tabSessions`는 id를 이름 순서로 나열한다. | all |
| `workspace.tab-session.list-refuses-other-name` | `tabSessions`는 이름이 tab id나 section surface id를 인코딩한 이름이 아닌 file `tab-sessions/<file>.json`을 거부한다. `left%2Fprobe.tree.json`처럼 이전 id 형식의 file도 거부하며, 오류는 `tab-sessions/<file>.json does not name a tab id or a section surface id`이다. atomic write가 만들고 지우는, `.json` 확장자가 없는 file은 나열하지 않는다. | all |
| `workspace.settings.invalid-common-file-not-overwritten` | 잘못된 공통 설정 파일은 설정 변경을 실패시키고 바이트 단위로 그대로 남는다. | all |
| `workspace.settings.concurrent-patches-preserved` | 서로 다른 키에 대한 동시 공통 설정 변경이 모두 유지된다. | all |
| `workspace.settings.records-each-change` | 설정 변경마다 `scope`(`common` 또는 project id), 바꾼 키 `set`, 있었던 키 중 지운 `removed`를 각각 쉼표로 이은 정렬된 목록으로 가진 event `host.workspace.settings`가 있다. | all |
| `workspace.projects.move-reorders` | 프로젝트를 옮기면 저장된 순서의 위치가 바뀐다. | all |
| `workspace.projects.move-requires-delta` | `delta`가 없거나 `null`인 `move` 요청은 `move delta is missing`으로 실패하고 순서를 바꾸지 않는다. | all |
| `workspace.projects.plugin-data-patched` | 프로젝트 patch는 `plugins` 객체를 저장하고, 알 수 없는 다른 필드의 patch는 거부된다. | all |
| `workspace.projects.remove-keeps-remaining-order` | 프로젝트를 제거해도 남은 프로젝트의 순서는 유지된다. | all |
| `workspace.folder.aliases-share-identity` | 디렉터리와 그 심볼릭 링크는 같은 프로젝트 폴더로 해석된다. | all |
| `workspace.folder.rejects-file` | 일반 파일은 프로젝트 폴더로 거부된다. | all |
| `workspace.folder.replaced-directory-changes-identity` | 바뀌지 않은 디렉터리는 identity를 유지하고, 같은 root에 새로 만든 다른 디렉터리는 다른 identity를 가진다. | all |
| `workspace.folder.messages` | 폴더 확인은 요청한 경로를 한 번 담은 문구 하나로 실패한다. 경로나 상위 폴더가 없으면 `project directory does not exist: <path>`, 접근이 거부되면 `project directory is not readable: <path>`, 파일이면 `not a project directory: <resolved path>`, 그 밖의 system 오류는 `project directory cannot be resolved: <path> (errno <n>)`이다. | all |
| `cli.usage.unknown-command-exits-2` | 알 수 없는 명령은 종료 상태 2로 끝나며 표준 오류에 `sok: unknown command: <word>`와 사용법을 출력한다. | all |
| `cli.endpoint.missing-file-reports-not-running` | `endpoint.json`이 없으면 명령은 종료 상태 1로 끝나며, 그 파일이 없고 애플리케이션이 실행 중이 아니라고 보고한다. | all |
| `cli.output.indents-result-keeping-key-order` | 결과는 endpoint가 보낸 key 순서대로 두 칸 들여쓰기로 출력하며, 빈 container는 `{}`와 `[]`다. | all |
| `cli.window.single-window-is-default` | `--window`나 `--project`가 없으면 명령은 애플리케이션의 하나뿐인 창을 쓴다. | all |
| `cli.window.several-windows-need-selection` | 창이 여럿인데 선택이 없거나 `--window`와 `--project`를 함께 주면, 명령은 종료 상태 2로 끝나며 창 목록이나 충돌을 밝힌다. | all |
| `cli.window.project-selects-by-canonical-folder` | `--project`는 둘을 canonical 경로로 바꾼 뒤 열린 project 폴더가 주어진 폴더와 같은 창을 고른다. | all |
| `cli.requests.carry-command-parameters` | `status`, `exposures`, `capture`, `element`, `input`은 spec이 정한 endpoint method와 매개변수를 보내며, 숫자는 JSON 숫자로, 주지 않은 option은 빼고 보낸다. | all |
| `cli.error.reports-endpoint-code` | Endpoint 오류는 종료 상태 1로 끝나며 `sok: <message> (<code>)`를 출력한다. | all |
| `cli.error.unwritable-stderr-exits-3` | sok이 오류를 표준 오류에 쓰지 못하면 1이나 2 대신 종료 상태 3으로 끝난다. | all |
| `cli.diagnostics.capture-only-in-diagnostic-builds` | 진단 build의 sok은 `capture`를 고른 창과 함께 `diagnostics.capture.still`로 보내고, 다른 build는 `capture`를 사용법 오류 `capture needs a diagnostic build of sok`로 거부하며 진단 method를 담지 않는다. | all |
| `cli.status.watch-prints-value-and-changes` | `status --watch`는 현재 값과 그 뒤 같은 status의 각 변경을 compact JSON 한 줄씩 출력하고, 다른 status의 변경은 무시한다. | all |
| `cli.config-dir.default-uses-application-identifier` | `--config-dir`이 없으면 명령은 `<사용자 설정 폴더>/<application identifier>`를 쓴다. | all |
| `debug.files.lists-the-logs-folder` | 디버그 파일은 `<config-dir>/logs/` 아래 모든 파일이고, 설정 폴더에 대한 상대 경로, 크기, 수정 시각을 담아 경로 순으로 나열된다. | all |
| `debug.save.copies-a-file-of-the-logs-folder-only` | 저장은 `logs/` 아래 파일을 복사한다. `logs/` 밖, `..`가 든 경로, 폴더, 없는 파일은 `debug: <path> is not a file under logs/`로 거부한다. | all |
| `debug.save-all.writes-the-logs-folder-as-tar` | 모두 저장은 `logs/`의 파일을 그 경로로 담은 gzip 압축 tar 파일을 쓴다. | all |
| `debug.save-all.reports-progress` | tar writer는 나열한 byte를 1 MiB 이상 더 쓸 때마다, 그리고 마지막 파일 뒤에 쓴 byte가 전체와 같게 한 번 보고한다. | all |
| `overlay.pick.dropped-is-recorded` | id와 instance가 열린 모달의 것이 아닌 모달의 응답은 기록 `host.overlay.dropped`의 field `{id, instance, key, open}`과 함께 버려지며, 열린 모달이 없으면 `open`은 빈 글이다. 열린 모달의 응답은 버려지지 않는다. | all |
| `modal.ready-visible` | 열린 모달의 ready 요청은 모달을 표시하고 visible 플래그를 설정한 뒤, 둘 다 끝난 후에 메인 스레드에서 응답한다. 표시가 실패하면 그 오류로 응답하고 모달은 다음 ready 요청까지 대기 상태로 남는다. id와 instance가 열린 모달의 것이 아닌 ready 요청은 오래된 요청이다. 아무것도 바꾸지 않고 ok로 응답하며, 이벤트 `host.trace.modal.stale-ready`를 `modal`과 `instance`와 함께 기록한다. | all |
| `modal.keyboard-hold` | 모달 web view 의 show 는 이전 모달을 제거하기 전에 window 의 input 을 hold 한다. hold 는 ready 요청에서 모달이 keyboard 를 받은 뒤에 끝나고, 그 전에 모달이 닫히거나 show 가 실패하거나 main page 가 시작하면 그때 끝난다. 모달을 교체하는 show 는 교체한 모달을 위해 hold 를 유지한다. | all |
| `modal.dialog-blurs-each-document-and-image-region` | Dialog를 열면 window의 각 document web view와 각 image region에 native blur를 걸고, 닫으면 걷는다. | all |
| `modal.region-under-a-dialog-starts-blurred` | Dialog가 열린 동안 만든 image region은 흐린 상태로 시작하고, dialog가 없는 동안 만든 것은 blur 없이 시작한다. | all |
| `modal.workbench-dialog.new-workbench-ends-the-claim` | window에서 새 workbench가 시작되면 이전 workbench가 `setDialogBackground`로 알린 dialog가 끝난다. window에는 dialog가 없고, document web view와 image region은 blur를 잃으며, 그 뒤에 만든 image region은 blur 없이 시작한다. | wailsv3, mygo only: Go language host library는 workbench가 직접 그리는 dialog(host tree의 B2 행)를 modal web view와 별개의 claim으로 갖고, Rust language host library에는 modal web view만 있다(host tree의 H41 행) |
| `modal.workbench-dialog.end-keeps-a-modal-dialog-background` | workbench가 `setDialogBackground`로 알린 dialog를 끝내도 `dialog` mode의 modal web view가 열려 있는 동안 window의 dialog와 image region의 blur는 남는다. | wailsv3, mygo only: Go language host library는 workbench가 직접 그리는 dialog(host tree의 B2 행)를 modal web view와 별개의 claim으로 갖고, Rust language host library에는 modal web view만 있다(host tree의 H41 행) |
| `reload.timeout.names-running-calls` | 범위 안에 workbench가 준비를 알리지 않은 다시 읽기는 `the reloaded page did not report ready within <bound>; running host calls: <calls>`로 실패하며, `<calls>`는 그 window에서 돌아오지 않은 호출을 시작 순서로 각각 소수 한 자리의 `<name> <seconds>s`로 적거나 `none`이다. | all |
| `log.batch.requires-the-start` | 자신을 쓴 workbench의 start를 `start`에 이름하지 않은 workbench 배치의 event는 `start must name the start of the workbench that wrote the event`로, `page`를 이름한 event는 `page is not a member of an event of the workbench`로 거부된다. | all |
| `debug.save-text.writes-the-text-to-the-destination` | 글 저장은 요청의 글을 줄바꿈과 ASCII가 아닌 글자를 그대로 둔 채 목적지에 쓴다. | all |
| `debug.save-text.refuses-a-name-that-is-not-a-file-name-and-text-that-is-empty-or-too-large` | 빈 이름, `.`, `..`, `/`나 `\`를 가진 이름은 `debug: name "<name>" is not a file name`으로, 빈 글은 `debug: text is empty`로, 16 MiB를 넘는 글은 `debug: text is <n> bytes, over the limit of 16777216`으로 요청을 거절한다. | all |
| `files.place.answers-the-path-inside-the-project` | project root 안에서 고른 위치는 root나 위치가 symbolic link를 지나도 root 기준 상대 path를 부분 사이 `/`로 답한다. | all |
| `files.place.refuses-a-place-outside-the-project` | project root 밖에서 고른 위치, root 자체, `..`나 symbolic link로 밖에 닿는 위치는 `file place: <path> is outside the project <root>`로 거부된다. | all |
| `files.place.refuses-a-name-that-is-not-a-file-name` | 빈 글, `.`, `..`, `/`나 `\`를 담은 `name`은 panel이 보이기 전에 `file place: name <name> is not a file name`으로 거부된다. | all |
| `log.query.answers-the-golden-pages` | `docs/spec/cases/log-contract/query/cases.json`의 각 질의가 golden 행, `next`, `tail`, `scanned`를 돌려주고, 행의 글 줄이 golden 줄이다. | all |
| `log.query.pages-through-the-cursor` | `next`를 `after`로 넘기며 page를 넘기면 질의의 모든 행을 key 순서로 `asc`와 `desc`에서 한 번씩 돌려주고 `next` `null`로 끝나며, page는 줄 글 8,388,608바이트를 넘기 전에 끝나고 항상 행 하나를 담는다. | all |
| `log.query.follows-the-tail-with-since` | 앞선 답의 `tail`을 `since`로 준 질의는 그 뒤에 덧붙은 행을 돌려주며 앞선 답이 담은 행보다 `ts_us`가 이른 행도 돌려주고, 프로세스의 `seq` 이하의 행은 뺀다. | all |
| `log.query.resolves-a-run-to-the-range-of-its-marks` | `run`은 질의를 channel의 모든 파일에서 그 run의 가장 이른 `host.test.start`부터 가장 늦은 `host.test.end`까지의 시간 범위로 한정하고, start가 없는 run은 오류 `log query run "<run>" has no host.test.start in the channel`이다. | all |
| `log.query.refuses-invalid-parameters` | 선언하지 않은 항목과 매개변수의 잘못된 값은 명세의 오류 문구로 거절하고, event 구조를 어기는 줄이 있는 파일을 읽는 질의는 파일과 줄을 밝히며 실패한다. | all |
| `log.query.leaves-out-a-file-of-another-schema` | 질의는 schema 번호가 다른 파일을 빼고 다른 파일의 행을 답하며, `around`에서도 그 파일의 오류를 `rejected`에 담는다. 그런 파일이 없는 질의는 빈 `rejected`를 답한다. | all |
| `log.query.answers-the-rows-around-a-row` | `around`가 있는 질의는 key 앞의 `earlier`개 행과 뒤의 `later`개 행을 key에 있는 행과 함께 channel의 파일에서 filter 없이 key 순서로 돌려주고, 각 행에 `context`(이웃은 true, key의 행은 false)를 표시하며 `next`는 null이다. 행이 없는 key는 이웃만 돌려준다. `docs/spec/cases/log-contract/query/cases.json`의 golden `around` 사례와 그 글 줄(context 행은 공백 둘로 들여 쓴다)은 두 구현에서 같다. `channel`, `earlier`, `later` 외의 항목, `around` 없는 `earlier`나 `later`, 잘못된 cursor, 0에서 500을 벗어난 개수는 명세의 오류 문구로 거절하며, 답의 줄 글은 8,388,608바이트 이하다. | all |
| `log.query.reads-only-the-segments-that-can-hold-a-row` | segment가 여럿인 로그에서 `cid`, `event`, `surface`, 시간 범위로 묻는 질의는 색인이 받아들이는 segment만 읽고(`scanned.read`), `text`가 있는 질의는 모든 segment를 읽는다. | all |
| `log.query.reads-what-each-query-of-a-million-events-needs` | event 1,000,000개의 로그가 첫 page, `cid`, event 이름, surface, 시간 범위, level, `text`로 묻는 page를 그 행과 함께 답하고, 각 query는 test가 밝힌 색인의 segment와 line을 읽으며, 색인은 모든 event를 센다. test는 시간을 출력하고, 그 시간은 benchmark target이 잰다. | all |
| `log.query.reads-the-files-the-writer-wrote` | 질의는 writer가 만든 모든 세대에 걸쳐 main 파일을 channel `other`로, debug 파일을 channel `debug`로 읽는다. | all |
| `log.query.matches-the-class-the-writer-stored` | 질의 필터 `class`는 색인의 class 비트를 통해 writer가 줄에 저장한 class와 맞는다. | all |
| `log.index.matches-the-golden-digest` | 구현이 각 golden event 파일에서 만든 색인의 SHA-256이 golden 값과 같고, 최신 색인의 갱신은 아무것도 바꾸지 않는다. | all |
| `log.index.follows-appended-lines-and-is-rebuilt-when-stale` | 색인을 만든 뒤 덧붙은 줄은 부분 segment부터 색인하고, 마지막 줄바꿈 뒤의 바이트는 줄바꿈이 쓰인 뒤 색인하며, 더 작은 파일, 다른 첫 줄, 같은 크기에서 다른 수정 시각은 색인을 처음부터 다시 만든다. | all |
| `log.index.counts-the-lines-that-announce-a-change` | 색인 갱신은 `announcing`, 곧 앞선 갱신 뒤에 색인한 줄에서 log만 읽는 호출의 기록(`logQuery`의 `host.binding.call`과 `log.query`의 `host.endpoint.call`)을 뺀 수와, 덮는 파일의 크기 `size`를 보고한다. 갱신이 다시 읽는 부분 segment는 두 번 세지 않고, 최신 색인의 갱신은 아무것도 알리지 않는다. | all |
| `log.index.head-read-error-is-reported` | head를 읽는 색인 갱신이 읽기 오류로 실패하면 그 오류를 반환하며, `the first line changed` 이유로 색인을 다시 만들지 않는다. | all |
| `log.writer.unwritable-line-is-dropped` | writer가 쓸 수 없는 줄(직렬화할 수 없거나 파일을 열 수 없는 줄)은 seq를 간격으로 남기고, 그 간격을 `from_seq`와 `to_seq`, `count` 1, `reason`의 원인을 가진 `log.dropped`로 main 파일에 바로 기록한다. 같은 방식으로 실패하는 `log.dropped` 줄은 표준 오류에만 보고한다. | all |
| `log.index.refuses-a-damaged-index-and-a-broken-line` | 다른 버전의 색인, 검사합이 맞지 않는 block이나 기록, block보다 짧은 파일은 색인을 밝히는 오류이고, event 구조를 어기는 줄과 schema 2의 `log.open`이 아닌 첫 줄은 파일과 줄을 밝히는 오류이며 색인은 이전 상태를 유지한다. | all |
| `log.index.moves-with-the-generations-of-a-rotation` | 회전은 가득 찬 파일의 색인을 최신으로 맞추고 색인 파일을 세대와 함께 바꾸어, 닫힌 세대가 만들기 없이 색인으로 답하게 하고 지워진 세대의 색인을 지운다. | all |
| `log.index.update-reads-with-a-buffer-of-the-new-bytes` | index의 갱신은 읽는 byte만큼, 많아야 한 번 읽는 chunk만큼 읽기 buffer를 할당하므로, 덧붙은 두 줄의 갱신은 1 MiB보다 적게 할당한다. | all |
| `log.writer.indexes-each-batch-it-wrote` | host의 writer가 batch를 쓴 뒤 질의 없이도 그 파일의 색인이 batch의 줄을 덮고, writer의 회전은 닫힌 세대의 색인을 완전하게 남긴다. | all |
| `log.writer.stores-an-event-for-each-index-built-from-the-file` | 파일 전체로 만든 색인은 파일, 이유, 줄 수, 바이트, 마이크로초를 가진 event `host.log.index_rebuilt`이고, 증분 갱신은 event를 저장하지 않으며, 실패한 갱신은 문구마다 한 번 장소 `log index`의 `error` 기록으로 보인다. | all |
| `log.endpoint.query-answers-one-page` | diagnostics가 없는 빌드의 endpoint 메서드 `log.query`가 질의의 page로 답하고, 매개변수를 invalid-params 오류와 질의의 문구로 거절하며, `window`를 받지 않는다. | all |
| `log.endpoint.query-answers-the-rows-around-a-row` | endpoint 메서드 `log.query`는 `around`가 있으면 `context` 표시를 가진 그 행 둘레의 행과 null인 `next`를 답하고, 다른 filter 항목은 코드 `-32602`와 질의의 오류 문구로 거절한다. | all |
| `debug.log-query.answers-the-query-of-the-endpoint` | host 호출 `logQuery`가 같은 요청에 endpoint 메서드 `log.query`와 같은 page로 답하고, 오류는 질의의 오류 문구다. | all |
| `debug.follow.coalesces-writes-into-a-notice` | event log의 변경 알림은 창을 기다리지 않고 돌아오며, 알림은 250 ms 이상 간격으로 발행되고(시험은 더 짧은 간격으로 확인한다), 그동안 온 알림은 마지막 경로와 크기를 가진 알림 하나가 된다. `notices`는 발행한 알림 수이고 `notices + coalesced`는 알림 전체 수이며, `host.log`의 값은 가장 최근 알림이고 첫 알림 전에는 0 값이다. | all |
| `debug.follow.announces-only-changes-that-are-not-log-reads` | `announcing`이 0인 색인 갱신은 알림을 발행하지 않고, `announcing`이 0보다 큰 갱신은 그 갱신의 파일과 크기를 담은 알림을 발행한다. | all |
| `debug.follow.query-announces-the-lines-it-indexes` | 색인을 최신으로 만든 질의는 그 줄의 알림을 발행하고, 이미 최신인 색인의 질의는 발행하지 않는다. | all |
| `log.writer.announces-each-write-to-the-observer` | host의 기록기는 한 묶음을 쓴 뒤 파일의 경로와 크기로 observer를 부른다. | all |
| `debug.read.returns-the-end-of-a-text-file` | `debugRead`는 `logs/` 아래 글 파일의 전체 내용을, 더 크면 문자 경계에서 시작하는 마지막 262144 byte를 `truncated` true와 함께 `kind` `text`인 `{path, size, truncated, kind, text}`로 답한다. | all |
| `debug.read.returns-a-png-file-as-an-image` | `debugRead`는 PNG 파일 전체의 `data:image/png;base64,` 주소를 `kind` `image`인 `{path, size, truncated, kind, image}`로 답하고, PNG signature로 시작하지 않는 `.png` 파일과 16 MB보다 큰 PNG 파일은 거부한다. | all |
| `debug.read.refuses-a-path-outside-logs-and-a-file-that-is-not-text` | `debugRead`는 `logs/` 밖의 경로, 파일이 아닌 경로, 내용이 UTF-8 글이 아닌 파일을 그 경로를 밝히는 오류로 거부한다. | all |
| `assets.missing.writes-one-error-line-for-each-path` | host가 내줄 수 없는 page 파일 요청은 그 경로마다 한 번 `error host page asset: <path>: not found`로 알리고, 내준 파일은 알리지 않으며, 파일 확장자가 없는 경로도 알리지 않는다. | all |
| `assets.missing.does-not-answer-with-the-start-document` | 파일 확장자가 있고 어떤 파일도 가리키지 않는 경로의 요청은 두 host의 파일 서버에서 시작 문서로 답하지 않는다. Wails 서버는 404로, Tauri 프레임워크는 asset 오류로 답한다. | tauriv2 only: Tauri 프레임워크는 `<path>`, `<path>.html`, `<path>/index.html`을 찾고 시작 문서로 대신한다. Wails 서버는 스스로 404로 답한다 |
| `assets.missing.runtime-optional-file-is-not-reported` | Wails runtime이 요청하고 애플리케이션이 제공하지 않는 runtime 파일 `/wails/custom.js`는 알리지 않는다. | wailsv3 only: Wails runtime이 이 선택 파일을 설계상 요청한다 |
| `page.process.termination-writes-an-error-line` | host가 실행되는 동안 창의 WebContent process가 끝나면 host는 그 종료마다 한 번 `error host page process: <window>: terminated`를 쓴다. 단 host가 종료하는 동안은 process를 일부러 끝내므로 쓰지 않는다. | all |
| `quit.cancel.ends-the-quit-state` | 시작한 종료 상태는 `windowCloseKept`가 취소할 때까지 유지된다. 시작과 취소는 멱등이고, `host.window`가 이 상태를 `quitting`으로 보고한다. | all |
| `quit.request.begins-the-quit-state` | quit 요청은 준비된 창이 있든 없든 quit을 실행하기 전에 종료 상태를 시작하므로, 그 종료 중의 page process 종료는 오류 줄을 쓰지 않는다. | all |
| `project-removal.ask.waits-for-the-owner-answer` | 프로젝트의 제거 요청은 그 프로젝트를 보이는 창의 답으로 이행한다. 요청이 대기 중인 프로젝트에 대한 두 번째 요청, 요청 없는 답, 올바르지 않은 project id는 오류로 실패하고, 요청을 받은 창이 끝나면 제거해도 된다고 답한 것으로 본다. | all |
| `project-removal.abandon.records-each-allowed-removal` | 제거에 대한 질문을 받은 창이 끝나면 제거를 허용하고, 그 요청마다 `window`와 `project`를 가진 event `host.project.removal_allowed`를 저장한다. 다른 창의 요청에는 저장하지 않는다. | all |
| `project.open-ready-shown-order` | project를 열 때 workbench가 새 project를 선택하기 전까지 이전에 commit된 project를 유지하며, 선택 전에는 staged project를 게시하지 않는다. | all |
| `project.open.prepare-before-show` | 이미 보이는 project를 다시 열 때 workbench가 그 project의 root를 선택하기 전까지 commit된 root를 유지한다. | all |
| `project.open.registers-owner-without-commit` | 새 project를 열 때 owner는 등록하지만 workbench가 표시된 project를 알릴 때까지 기존 commit 상태를 유지하고 project를 게시하지 않는다. | all |
| `project.open.staged-until-shown` | project owner는 project를 여는 동안 staged 상태로 남고, workbench가 표시된 project를 알린 뒤에만 commit된다. | all |
| `project.open.other-owner-is-shown-without-activation` | 다른 창이 가진 project를 열면 응용의 활성화를 요청하지 않은 채 그 창을 보인다. | all |
| `project.open.front-is-recorded` | project owner의 창을 보이게 하면 event `host.project.front`를 level `info`로 저장한다. 필드는 `window`, `project`, `key`(보이게 한 뒤 그 창이 key window인지)와 `app_active`(응용이 활성 상태인지, 그 상태를 읽지 못하면 null)다. | all |
| `projects.open.geometry-failure-closes-before-reservation` | 새 project window의 geometry 설정이 실패하면 host는 owner reservation을 추가하기 전에 그 window를 닫고 다른 project 상태는 유지한다. | tauriv2 only: Tauri window geometry operation은 오류 결과를 반환한다 |
| `project.shown-commits-after-page-ready` | workbench가 선택한 project를 알린 뒤 host가 해당 project를 commit한다. 게시되는 값은 commit된 상태를 반영하며, project 없음 선택은 그 상태를 지운다. | all |
| `projects.shown.requires-project-field` | Project-shown 요청에는 `project` member가 필요하다. 명시적 `null`은 표시 project를 지우며, member를 생략하면 상태 변경 전에 거부한다. | all |
| `projects.shown-validates-before-commit` | Staged project와 root가 일치하지 않는 project-shown 요청은 commit된 상태나 staged 상태를 바꾸지 않고 거부된다. | all |
| `projects.release-rolls-back-staged-owner` | Pending project를 release하면 다른 owner의 reservation이나 commit된 project는 바꾸지 않고 해당 owner reservation을 제거한다. | all |
| `projects.shown-command-is-registered` | workbench는 등록된 project-shown command로 선택한 project를 commit할 수 있다. | all |
| `project.shown.ignores-unknown-fields` | project-shown 입력에는 `project` member가 필요하며 값은 `null`일 수 있고, member 생략은 거부된다. 알 수 없는 바깥쪽 및 중첩 field는 무시하고 인식하는 project data를 commit하며 명시적 `null`은 commit된 project를 지운다. | all |
| `debug.record.writes-the-state-file` | 기록은 주어진 상태와 UTC `time` `YYYYMMDDTHHMMSSZ`를 담은 `logs/state-<time>.json`을 쓰고 그 상대 경로로 답한다. | all |
| `debug.record.names-the-value-of-the-workbench` | 상태 파일은 요청이 member `workbench`로 준 workbench의 값을 담고, member `page`는 없다. | all |
| `debug.record.keeps-the-newest-20-state-files` | 상태 파일을 쓴 뒤 host는 시각으로 가장 새 20개를 넘는 `logs/state-<time>.json` 파일을 지우고 `logs/`의 다른 파일은 둔다. | all |
| `cli.identity.build-identifier` | `dev` 플래그 build는 `app.soksak.<wails, mygo 또는 tauri>.dev`를 쓰고, 진단 build를 포함한 다른 build는 `app.soksak.<wails, mygo 또는 tauri>`를 쓴다. | all |
| `cli.command.host-command-without-page` | `host.` command는 `owner`가 `host`인 `exposure.list`로 검사되므로, workbench가 노출 목록에 답하지 않는 동안에도 `command.run`으로 실행된다. | all |
| `cli.command.flags-from-schema` | 선언된 command는 창, surface, 그리고 선언된 schema로 flag에서 바꾼 매개변수와 함께 `command.run`으로 실행된다. 텍스트, 숫자, 정수, boolean, enum 값, nullable type의 `null`, JSON 객체와 배열, `--`로 시작하며 `=` 뒤에 준 값이며, `--params`는 객체 전체를 준다. | all |
| `cli.command.rejects-undeclared-or-invalid-values` | 선언되지 않은 flag, schema와 맞지 않는 값, 값이 없는 flag, 값이 따라오는 boolean, 매개변수 flag와 함께 쓴 `--params`, 선언되지 않은 command는 `command.run`을 보내기 전에 종료 상태 2로 끝난다. | all |
| `cli.commands.lists-declared-commands` | `sok commands`는 `exposure.list`의 `commands` 목록을 애플리케이션이 선언한 순서대로 출력한다. | all |
| `cli.path.writes-and-removes-the-entry` | `sok path install`은 실행 중인 `sok`의 폴더를 담은 `<paths directory>/<identifier>`를 쓰고 파일과 폴더를 출력한다. 되풀이해도 같은 파일이다. `sok path remove`는 그것을 지우며 없어도 성공한다. 쓰기 실패는 파일과 `run sudo sok path install`을 보고한다. | all |
| `cli.path.fails-without-a-path-entry-folder` | 경로 항목 폴더가 없는 운영체제에서 `sok path install`은 `path entries are not implemented on linux` 같은 platform의 까닭으로 실패하고 아무것도 쓰지 않는다. | all |
| `cli.registry.writes-checked-index` | `sok registry build`는 registry 파일을 읽고 모든 release hash와 plugin release의 `package.json`, `plugin.json`을 검사한 뒤, 선언한 필드 순서와 두 칸 들여쓰기로 `index.json`을 쓰고 `index`, `packs`, `plugins`, `sidecars`를 출력한다. 두 구현은 같은 텍스트를 쓴다. | all |
| `cli.registry.rejects-without-writing` | 형식이 틀린 hash, hash가 다른 release, 항목과 다른 `package.json`, 항목과 다른 파일 이름, 없는 `revoked.json`, 알 수 없는 plugin을 지정한 pack은 종료 상태 1이며 `index.json`을 남기지 않는다. | all |
| `cli.registry.checks-plugin-dependencies` | `sok registry build`는 나열된 plugin을 지정하는 `plugin.json`의 dependency를 받아들이고 version의 `sidecars`에는 sidecar dependency만 쓴다. 나열된 plugin도 나열된 sidecar도 지정하지 않는 dependency와 나열된 어느 version도 채우지 않는 plugin dependency는 그 문구와 함께 종료 상태 1이며 `index.json`을 남기지 않는다. | all |
| `cli.registry.lists-core-releases` | `sok registry build`는 registry 폴더의 `core.json`을 읽고 모든 core release의 `sha256`을 확인하며, 정렬한 목록을 `index.json`의 `sidecars`와 `packs` 사이에 `core`로 쓰고 결과에 `core`로 센다. `core.json`이 없는 registry는 `core`를 쓰지 않고 0으로 센다. | all |
| `cli.registry.rejects-malformed-core-releases` | `sok registry build`는 알려진 platform과 host의 `<platform>-<host>`가 아닌 core release 키, 두 번 나열된 버전, 알 수 없는 field, hash가 다른 release, 나열되지 않은 철회 core 버전이 있으면 `index.json`을 쓰지 않는다. | all |
| `app-update.state.selects-the-candidate` | 애플리케이션 업데이트의 후보는 `core`에서 실행 중인 core보다 새롭고 `revoked.core`에 없으며 `<platform>-<host>` 키의 release가 있는 가장 새 버전이다. `core`가 없는 index에는 후보가 없다. | all |
| `app-update.stage.verifies-and-extracts` | 후보를 준비하면 release를 받고 `sha256`을 확인하고 `<config-dir>/updates/<version>/`을 지운 뒤 그 안에 zip을 풀고, `CFBundleShortVersionString`이 그 버전인 애플리케이션 번들 하나를 담았는지 확인해 번들의 경로를 돌려준다. | all |
| `app-update.stage.rejects-a-wrong-release` | hash가 다르거나 번들 버전이 후보와 다르거나 읽을 수 없는 release는 단계를 밝힌 메시지로 실패하고 준비한 폴더를 남기지 않는다. | all |
| `app-update.host.stages-only-the-candidate` | host는 지금 registry index의 후보인 버전만 준비하며, 다른 버전과 실행 중인 버전에는 `<version> is not the candidate of core <running>`으로 실패한다. | all |
| `app-update.replace.replaces-the-bundle-after-the-process-ended` | `sok app update`는 커널 알림으로 프로세스의 끝을 기다리고, 새 번들을 target 옆에 복사하고, target을 옆으로 옮기고 복사본을 그 자리로 옮기고, `--` 뒤의 인자로 target을 시작한 뒤 이전 번들과 준비한 번들을 지우고 `{target}`을 출력한다. | all |
| `app-update.replace.restores-the-bundle-when-the-start-fails` | 옮긴 뒤 시작이 실패하면 새 번들을 지우고 이전 번들을 되돌려 시작하며 시작의 메시지로 실패한다. | all |
| `app-update.replace.refuses-before-it-changes-anything` | 응용 프로그램 번들이 아닌 target이나 bundle, 둘이 같은 폴더인 경우, 기한(60초) 뒤에도 실행 중인 프로세스는 target이 바뀌기 전에 실패한다. | all |
| `app-update.apply.starts-sok-from-a-copy-and-checks-the-bundle` | 업데이트를 적용하면 실행 중인 번들의 `sok`을 `<config-dir>/updates/sok`에 복사하고 `sok app update --wait <pid> --bundle <bundle> --target <실행 중인 번들> [-- <인자>]`를 새 세션으로 준비한다. `updates/` 밖의 번들, `Info.plist`가 없는 폴더, 응용 프로그램 번들 밖의 애플리케이션은 거부한다. | all |
| `app-update.apply.records-the-detached-command` | 분리 실행한 명령은 host의 표준 오류를 그대로 쓰므로 그 메시지는 실행의 표준 오류 파일에 있고, host는 명령을 시작할 때 명령의 `pid`와 `command` 줄을 가진 event `host.update.start`를 저장한다. 시작할 수 없는 명령은 그 명령을 이름으로 가리키는 오류다. | all |
| `app-relaunch.starts-the-same-bundle-in-the-background-after-the-process-ended` | `sok app relaunch`는 kernel 알림으로 프로세스의 끝을 기다린 뒤, 바꾸지 않은 대상 번들을 `--` 뒤의 인자로 활성화하지 않고 시작하고 `{target}`을 출력한다. | all |
| `app-relaunch.refuses-a-folder-that-is-not-a-bundle-and-a-process-that-keeps-running` | 애플리케이션 번들이 아닌 대상은 `application relaunch: the target <path> is not an application bundle`로, 제한 시간이 지나도 실행 중인 프로세스는 `application relaunch: process <pid> did not end within <timeout>`으로, 둘 다 아무것도 시작하기 전에 실패한다. | all |
| `app-relaunch.host.starts-sok-of-the-running-bundle` | `diagnostics.host.relaunch`는 실행 중인 번들의 `Contents/MacOS/sok`으로 `sok app relaunch --wait <pid> --target <실행 중인 번들> [-- <인자>]`를 host의 표준 오류와 함께 새 세션에서 준비한다. 애플리케이션 번들 밖의 애플리케이션은 `application relaunch: <executable> does not run from an application bundle`로 실패한다. | all |
| `app-relaunch.host.records-the-detached-command` | host는 relaunch 명령을 시작할 때 명령의 `pid`와 `command` 줄을 가진 event `host.relaunch.start`를 저장한다. 시작할 수 없는 명령은 `application relaunch: start <program>: <reason>`으로 실패한다. | all |
| `cli.plugin.install-extracts-and-records` | `sok registry use`는 검사한 index를 `file:` URL로 기록한다. `sok plugin install`은 plugin과 그 sidecar version을 mode와 함께 풀고, 푼 폴더마다 절대 `path`를 담아 `installed.json`을 쓰고, plugin 항목과 sidecar version을 출력하며, 되풀이하면 아무것도 바꾸지 않는다. | all |
| `cli.plugin.install-modes-ignore-the-umask` | umask 077에서도 `sok plugin install`은 실행 파일을 mode 0755로, 다른 파일을 mode 0644로 쓴다. | all |
| `cli.plugin.install-failure-keeps-state` | `plugins/registry.json`이 없거나, hash가 index와 다른 release이거나, 폴더 밖 항목을 담은 release이면 `sok plugin install`은 종료 상태 1이며 `installed.json`, version 폴더, 푼 파일을 남기지 않는다. | all |
| `cli.plugin.install-refuses-entry-outside-package` | plugin release가 `package/` 밖의 entry를 담으면 `sok plugin install`은 종료 상태 1과 `plugin <id> <version> package: entry <path> is outside package/`로 실패하고 아무것도 설치하지 않는다. | all |
| `cli.plugin.install-requires-loaded-modules` | release에 `plugin.json`이 불러오는 view page나 surface module이 없으면 `sok plugin install`은 종료 상태 1과 `plugin <id> <version> package: plugin.json: view page <path> is not in the release`로 실패하고, 그것을 담은 release는 설치한다. | all |
| `cli.plugin.install-refuses-binary-path` | release가 `.binary` 부분 아래의 파일을 담으면 `sok plugin install`은 종료 상태 1과 `plugin <id> <version> package: plugin release holds <path>: the .binary path is reserved for the binary store`로 실패한다. | all |
| `cli.plugin.install-requires-sidecar-executable` | sidecar release에 `sidecar.json`이 지정한 executable이 없으면 `sok plugin install`은 종료 상태 1과 `sidecar <name> <version> <platform>: sidecar.json: executable <path> is not in the release`로 실패하고 `installed.json`을 쓰지 않는다. | all |
| `cli.plugin.dependencies-install` | `sok plugin install`은 고른 version의 plugin dependency도 설치한다. 설치되지 않은 provider는 범위를 채우는 가장 새 version을 받고, 모든 범위를 채우는 설치된 provider는 그대로 두며, 다른 설치된 provider는 모든 범위를 채우는 가장 새 version과 `previous`를 받고, 꺼진 provider는 켜진다. `installed.json` 항목마다 `sidecars`는 sidecar 범위만 담는다. | all |
| `cli.plugin.dependencies-reject` | Registry index의 plugin도 sidecar도 지정하지 않는 dependency는, provider를 `installed.json`만 나열해도, `<plugin> <version>: dependency <package> is neither a plugin nor a sidecar of the registry`로 실패한다. 어느 version도 채우지 않는 plugin dependency는 provider, core version, 각 plugin과 범위를 밝혀 실패하고, 순환은 `plugin dependency cycle: <id> -> <id> -> <id>`로 실패한다. 실패마다 `installed.json`과 plugin 폴더는 바뀌지 않는다. | all |
| `cli.plugin.dependencies-update` | Provider의 `sok plugin update`는 켜졌든 꺼졌든 그 provider를 지정하는 모든 설치된 plugin의 범위를 채우는 가장 새 version을 고르고, 지정하는 설치된 plugin이 없어지면 가장 새 version을 고른다. | all |
| `cli.plugin.dependencies-required` | 켜진 설치 plugin이 package를 지정하는 plugin의 `sok plugin remove`와 `sok plugin disable`은 `plugin <id> is required by <dependent> <range>`로 실패하고 `installed.json`과 폴더를 바꾸지 않는다. Dependent를 끄면 둘 다 성공한다. | all |
| `cli.plugin.installed-reads-name-from-package-json` | `sok plugin install`은 `installed.json`에 `package`를 쓰지 않고, `sok plugin remove`, `disable`, `update`의 dependency 규칙은 설치된 plugin의 이름을 기록된 `path`의 `package.json`에서 가져온다. | all |
| `cli.plugin.installed-refuses-package` | Plugin이 `package`를 담은 `installed.json`을 읽으면 `<file>: plugins/installed.json <id>: unknown field package`로 실패한다. | all |
| `cli.plugin.update-remove-enable-list` | `sok plugin update`는 설치되지 않은 plugin이면 실패하고, `enabled`를 유지하며 `previous`를 기록해 가장 새 version을 설치하고, 쓰는 version과 `previous`만 남긴다. `disable`과 `enable`은 `enabled`를 정하고, `list`는 `installed.json`을 출력하며, `remove`는 `null`을 출력하고 plugin과 sidecar 폴더를 지우며 되풀이하면 실패한다. | all |
| `cli.plugin.state-reads-registry-and-installed` | Installer library는 `{registry, index, installed}`를 보고한다. `plugins/registry.json`이 없으면 registry와 index가 `null`이고, 있으면 index URL과 검사한 index이며, 읽지 못한 index는 그 읽기 오류를 `index`로, 잘못된 `installed.json`은 오류를 보고한다. | all |
| `cli.plugin.state-reads-and-rejects-starter-job` | plugin state는 starter job이 있으면 보고하고, 잘못된 starter-job data는 `starter.json`을 명시하는 오류로 거부한다. | all |
| `cli.plugin.starter-job-transitions-are-bound-to-snapshot` | 기록된 registry snapshot의 모든 plugin이 설치될 때까지 starter job은 pending으로 남는다. snapshot이 바뀌면 job을 완료하거나 변경할 수 없고, pending 및 completed 상태는 재시작 후에도 유지된다. | all |
| `cli.plugin.action-runs-the-command` | Installer library는 `install`, `update`, `remove`, `enable`, `disable`을 같은 `sok plugin` 명령의 결과로 실행하고, 다른 action은 `unknown plugin action`으로 거부한다. | all |
| `cli.file.errors-name-the-path-and-the-reason` | 실패한 파일 작업은 `<경로>: <이유>`로 보고하며, 이유는 소문자로 시작하는 운영체제 오류 문구다. 없는 registry index는 `<경로>: no such file or directory`, 읽을 수 없는 `installed.json`은 `<경로>: permission denied`를 보고한다 | all |
| `cli.process-wait.rejects-invalid-pid-and-timeout` | process-wait 인수가 누락, 잘못됨, 중복되거나 알 수 없는 경우 exit 2로 끝나고 표준 출력을 쓰지 않으며 잘못된 인수를 명시하고 process-wait operation을 호출하지 않는다. | all |
| `cli.process-wait.requires-an-action` | 하위 command가 없는 `sok process`는 exit 2로 끝나며 process command에 action이 필요하다고 보고한다. | all |
| `cli.process-wait.option-is-command-scoped` | `--timeout-ms` 옵션은 `sok process wait`에서 허용되고 다른 command의 파싱에는 영향을 주지 않는다. | all |
| `cli.process-wait.repeated-help-is-idempotent` | help flag를 반복해도 같은 process-wait 사용법을 성공적으로 출력한다. | all |
| `cli.process-wait.timeout-is-an-error` | 요청한 timeout이 끝날 때까지 process가 남아 있으면 `sok process wait`는 exit 1로 끝나고 표준 출력을 쓰지 않으며 PID와 timeout을 보고한다. | all |
| `cli.process-wait.reports-pid-absent` | PID가 이미 없으면 `sok process wait`는 exit 0으로 끝나고 `{pid, ended: true}`를 출력한다. | all |
| `cli.process-wait.platform-error-is-reported` | 운영체제의 process-wait operation이 실패하면 `sok process wait`는 exit 1로 끝나고 표준 출력을 쓰지 않으며 platform 오류를 보고한다. | all |
| `cli.process-wait.registered-platform-receives-request` | Go `sok`의 등록된 process-wait 구현은 요청한 PID와 timeout을 받고 command는 그 결과를 직렬화한다. | wailsv3, mygo only: Go CLI는 변경 가능한 platform 등록 API를 제공한다 |
| `cli.debug.query-golden-lines` | `sok debug query`가 모든 사례에서 `docs/spec/cases/log-contract/query`의 golden page의 글 줄을 debug 화면과 같은 줄로 출력하고, 행이 page 뒤에 더 있으면 표준 오류에 `more: --after <cursor>`를 쓴다. | all |
| `cli.debug.query-errors` | `sok debug query`는 event 파일이 event 구조를 어기면 파일과 줄 번호를 담은 오류로, `logs/` 폴더가 없으면 폴더를 담은 오류로 실패한다. | all |
| `cli.debug.reports-a-rejected-file` | `sok debug query`는 다른 파일의 줄을 상태 0으로 출력하고, `sok debug query`와 `sok debug replay`는 schema 번호가 다른 파일마다 표준 오류에 `rejected: <error>`를 쓴다. | all |
| `cli.debug.query-flag-values` | `sok debug query`는 잘못된 flag 값을 질의의 오류 문구를 가진 사용법 오류로 거부하고, 명령에 없는 flag를 거부한다. | all |
| `cli.debug.replay-equal` | `sok debug replay <session>`은 session의 sidecar event가 가진 role을 선언한 설치된 sidecar의 replay 실행 파일을 segment마다 한 번 실행하고, 저장된 hash가 모두 재생한 hash이면 `replay session <session>: <n> sidecar frames and <m> page frames equal in <k> segments`를 출력한다. | all |
| `cli.debug.replay-until` | `sok debug replay --until <sequence>`는 실행 파일에 그 순번까지의 event만 주고 그 순번까지의 frame 기록만 비교한다. 음이 아닌 정수가 아닌 값은 사용법 오류다. | all |
| `cli.debug.replay-divergence` | `sok debug replay`는 순번 순서로, 같은 순번이면 sidecar를 page보다 먼저 보아 저장된 hash가 재생한 hash와 다른 첫 곳에서 상태 1로 끝나며, `sok: replay divergence: session <session> segment <boot> sequence <n> layer <layer> expected <hash> found <hash>`를 쓰고 event `sok.replay.divergence`를 저장한다(`segment`를 가지며, sidecar frame 기록이 없는 page frame 기록이면 `expected`는 `none`). | all |
| `cli.debug.replay-segments` | 새 sidecar 실행에서 `sequence`가 다시 시작하는 session은 `boot`마다 하나의 segment로 재생한다. 각 segment는 빈 화면에 자기 순번으로 적용되어 자기 저장 hash와 비교되고, `--until`은 각 segment의 순번을 제한하며, 불일치는 segment를 이름으로 밝힌다. | all |
| `cli.debug.replay-holds-one-segment` | 재생은 한 번에 한 segment의 event 줄을 보관하며, 결과는 segment 수와 한 번에 보관한 줄의 최댓값을 보고한다. 그 값은 session이 아니라 가장 큰 segment의 크기다. | all |
| `cli.debug.replay-segment-errors` | `fields.segment`가 없는 page frame 기록, 문자열이 아니거나 session에 없는 `boot`를 가리키는 `fields.segment`, 시각상 번갈아 나오는 두 segment의 sidecar event는 불일치 없이 재생을 실패시킨다. | all |
| `cli.debug.replay-session-rules` | `sok debug replay`는 sidecar의 `replay.inputs`가 적는 event인 각 segment의 재생 입력을 session 규칙으로 검사하고, 규칙을 어긴 segment를 `replay session <session>: segment <boot>: <problem>`으로 거부한다. 종류마다 `replay.inputs`가 없는 sidecar.json은 그 파일을 밝히는 오류다. | all |
| `cli.debug.replay-input-cases` | 도구의 재생 입력 규칙은 `docs/spec/cases/log-contract/replay/inputs.json`의 모든 case를 재현한다: valid 입력, 문구가 있는 invalid 입력, problem이 있는 session. | all |
| `cli.debug.replay-errors` | `sok debug replay`는 sidecar event가 없는 session, 두 role의 sidecar event가 있는 session, 그 role을 선언한 설치된 sidecar가 없는 경우, frame 기록이 없는 경우, 소문자 16진 64자가 아닌 저장된 hash, 실패하거나 `{"sequence", "hash"}`가 아닌 줄을 출력하거나 frame 기록의 hash를 출력하지 않는 재생 실행 파일에서 불일치가 아닌 오류로 실패한다. | all |
| `cli.log.records-each-command-with-its-result` | `sok`을 실행할 때마다 대상 설정 디렉터리에 `logs/sok-<boot>.jsonl`을 쓴다. `seq` 1의 `log.open`, 이어서 명령 단어, 공백으로 이은 인자, 마이크로초, `ok`, `status`, 상태가 0이 아니면 표준 오류의 첫 줄인 `error`를 담은 `sok.command`가 level `debug` 또는 `warn`으로 저장되며, 모든 줄이 층 `sok`, `ts_us`, `mono_ns`를 가진다. | all |
| `cli.log.registered-platform-file-operations` | Go `sok`에서 `StartToolEventLog`는 현재 등록된 platform 구현의 `PrepareLogDirectory`와 `CreateLogFile`을 각각 한 번 호출한다. | wailsv3, mygo only: 이 case는 Go의 변경 가능한 platform 등록을 통한 dispatch를 규정한다. Tauri는 target에 따라 platform 구현을 선택한다 |
| `cli.log.registered-platform-prepare-error` | Go `sok`에서 현재 등록된 platform의 `PrepareLogDirectory`가 error를 돌려주면 `Logged`는 표준 오류에 `sok: event log: <reason>`을 쓰고 command를 실행해 command status를 반환하며 `logs/` 경로를 만들지 않는다. | wailsv3, mygo only: 이 case는 Go의 변경 가능한 platform 등록의 실패 처리를 규정한다. Cross-host event-log 시작 동작은 `cli.log.reports-a-folder-that-cannot-be-written`이 다룬다 |
| `cli.log.records-a-panic-with-its-stack` | 명령의 panic은 `sok.panic`(thread `main`, 글, panic한 함수를 가리키는 stack)과 상태 4의 `sok.command`를 저장하고, `sok: panic: <text>`를 표준 오류의 맨 앞에 쓰며, 호출자에게 닿지 않고 상태 4를 돌려준다. | all |
| `cli.log.records-a-panic-of-a-routine-and-ends-the-process` | 도구가 시작한 goroutine이나 thread의 panic은 routine의 이름과 stack을 담은 `sok.panic`을 저장하고 프로세스를 상태 4로 끝낸다. | all |
| `cli.log.writer-options.refuses-a-negative-rotation-bound` | rotation 한도가 0 미만인 writer는 한도를 이름으로 가진 오류로 거부된다. | wailsv3, mygo only: Rust writer의 rotation 한도는 부호 없는 수여서 음수일 수 없다 |
| `cli.log.writer-options.stores-the-layer-the-clock-and-the-cids` | rotation이 없는 writer는 옵션이 주는 layer, 시계, correlation identifier를 저장하고 rotation하지 않는다. | all |
| `cli.log.writer-options.rotates-at-its-bound` | rotation 한도가 있는 writer는 한도에서 새 파일을 쓰고, 새 파일은 `log.open`과 `log.rotated`로 시작한다. | all |
| `cli.log.writer.poisoned-observer-lock-is-recovered` | panic한 thread가 poison한 write observer의 lock은 복구된다. observer는 여전히 설정되고 다음에 쓴 batch 뒤에 호출된다. panic hook이 panic을 기록한다. | tauriv2 only: Go mutex는 poison되지 않는다 |
| `cli.log.writer-options.stores-the-events-and-the-loss-of-its-pull-source` | writer는 pull source가 돌려주는 event와 source가 보고한 손실을 저장한다. | all |
| `cli.log.writer-options.records-refused-events-as-loss-before-the-next-accepted-event` | queue가 가득 찬 writer는 placed write의 event를 `its queue was full` 원인으로 거부하고, 다음 accepted event 앞에 개수, reason, queue 깊이를 담은 `log.dropped`를 저장한다. | all |
| `cli.log.writer-options.records-an-invalid-correlation-identifier-as-its-own-loss` | correlation identifier가 유효하지 않은 event는 거부되고, reason `a correlation identifier was not valid`와 queue 깊이 없이 `log.dropped`로 저장된다. | all |
| `cli.log.writer-options.records-a-level-outside-the-contract-as-its-own-loss` | level이 contract에 없는 event는 거부되고, reason `the level was not in the contract`와 queue 깊이 없이 `log.dropped`로 저장된다. | wailsv3, mygo only: Rust writer의 level은 enum이어서 contract 밖일 수 없다 |
| `cli.log.writer-options.records-unserializable-fields-as-their-own-loss` | fields를 serialize할 수 없는 event는 거부되고, reason `the fields could not be serialized`와 queue 깊이 없이 `log.dropped`로 저장된다. | all |
| `cli.log.writer-options.refuses-a-placed-event-by-its-cause` | 정책이 거부한 placed event는 `the policy does not store it` 원인으로 실패하며, gated event로 저장되고 손실이 아니다. | all |
| `buffers.sidecar-replies.order-is-bounded` | sidecar reply를 기다리는 요청의 순서는 응답한 요청이 몇 개든 대기 요청 한도의 두 배를 넘지 않는다. | all |
| `buffers.sidecar-replies.forgotten-request-is-counted` | 대기 요청의 한도에서 잊는 요청은 세며, 잊는 것은 가장 오래된 요청이다. | all |
| `cli.log.lines-follow-the-golden-fixtures` | 도구의 `log.open` 줄은 `docs/spec/cases/log-contract/key.jsonl`의 `log.open` 줄과 같은 key, key 순서, field 집합(schema 2, `role` `sok`)을 가지며, event 줄은 golden event 줄의 key 순서와 `ts_us`, `mono_ns`, `seq` 2를 가진다. | all |
| `cli.log.escapes-and-truncates-like-the-contract` | 따옴표, 역슬래시, 줄바꿈, tab, U+2028, ASCII가 아닌 글을 담은 field가 줄을 거쳐 그대로 돌아오고, fields 글이 1,048,576바이트를 넘는 event는 원래 크기를 담은 `truncated`와 4,096바이트의 `fields` `{"head": ...}`로 저장된다. | all |
| `cli.log.records-a-refused-event-as-log-dropped` | writer가 거절한 event는 세어져 golden field(`from_seq`, `to_seq`, `count`)를 가진 level `warn`의 `log.dropped`로 저장되고, 저장된 `seq`와 그것이 가리키는 범위가 1부터 n까지를 한 번씩 덮으며 `log.dropped`는 그 범위 뒤에 온다. | all |
| `cli.log.run-stores-only-the-declared-events` | 한 번의 실행은 `log.open`, `sok.command`, `sok.panic`, `log.dropped`만 저장한다. 이것이 rotation 없는 writer의 근거이며 main 파일과 debug 파일 모두 그렇다. | all |
| `cli.log.stores-class` | 도구는 host writer처럼 `class`와 `undeclared`를 저장한다. | all |
| `cli.log.policy-accepts-the-golden-cases` | 도구의 policy 파일 reader는 `docs/spec/cases/log-contract/policy/cases.json`의 모든 valid case를 그 class와 gate대로 받는다. | all |
| `cli.log.policy-refuses-the-golden-cases` | 도구의 policy 파일 reader는 `docs/spec/cases/log-contract/policy/cases.json`의 모든 invalid case를 그 case의 오류 문구로 거부한다. | all |
| `cli.log.applies-the-policy-file` | 도구는 시작할 때 configuration directory의 `log-policy.json`을 적용하므로, 모든 level을 저장하는 file이 있으면 default policy가 거부하는 `sok.command`를 저장합니다. | all |
| `cli.log.records-a-refused-policy-file` | reader가 거부한 policy file은 place `log policy`의 error record로 저장됩니다. | all |
| `cli.log.splits-files-by-level` | 도구는 `error`, `warn`, `info`를 `logs/sok-<boot>.jsonl`에, `debug`와 `trace`를 `logs/sok-<boot>.debug.jsonl`에 쓰며, 후자는 첫 해당 event와 함께 만들고 `log.open`으로 시작한다. | all |
| `cli.log.reports-a-folder-that-cannot-be-written` | `logs/`나 event 파일을 만들 수 없으면 도구는 `sok: event log: <path>: <reason>`을 표준 오류에 쓰고 명령을 자기 종료 상태로 실행한다. | all |
| `install.version.ranges-and-order` | 범위 `x.y.z`, `^x.y.z`, `~x.y.z`, `>=x.y.z <a.b.c`는 선언한 경계를 가지고, `*`는 상한이 없는 `>=0.0.0`이며, 합집합 `<range> \|\| <range>`는 한 부분이 포함하는 것을 포함한다. 사례는 `docs/spec/cases/version-ranges.json`이다. Version은 숫자로 비교한다. 다른 형식, 앞자리 0, 빈 범위, 4294967295를 넘는 자리는 `invalid version`으로 거부한다. | all |
| `install.package-json.fields-and-manifest` | Plugin `package.json`에는 `name`, `version`, `engines.soksak`, plugin 안의 `plugin.json`을 나열한 `files`가 있어야 한다. `soksak`은 거부하고, `plugin.json`의 `dependencies`는 각각 올바른 범위다. 실패마다 필드를 밝힌다. | all |
| `install.registry.entries` | Registry plugin, sidecar, pack, revoked 항목은 알 수 없는 필드, 절대 `file:` URL이 아니거나 query, fragment, 잘못된 escape를 가진 URL, 소문자 16진수 64자리가 아닌 `sha256`, 중복 version, 알 수 없는 플랫폼, 1이 아닌 `protocol`, 200 code point를 넘는 설명, 빈 pack, 이유 없는 revoked 항목을 거부한다. | all |
| `install.registry.index-cross-checks` | Index는 format 2, 중복 plugin id나 package, 알 수 없는 plugin을 지정한 pack, 알 수 없는 sidecar나 어떤 sidecar version도 채우지 않는 범위가 필요한 plugin version, 나열되지 않은 revoked version을 거부한다. | all |
| `install.select.newest-usable` | 선택은 core version에 맞고 revoked가 아니며 그 plugin을 지정하는 모든 설치된 plugin의 범위를 채우는 가장 새 plugin version과, 범위 안에 있고 플랫폼 release가 있는 가장 새 sidecar version을 고른다. 맞는 것이 없으면 plugin, core version, sidecar, 플랫폼, 각 plugin과 범위를 밝힌다. | all |
| `install.select.shared-sidecar` | 선택은 쓰고 있는 sidecar version이 다른 모든 설치된 plugin의 범위를 채우면 그대로 두고, 아니면 모든 범위를 채우는 가장 새 version을 고른다. 설치하는 plugin의 이전 범위는 무시하며, 충돌하면 각 plugin과 범위를 밝힌다. | all |
| `install.names.releases-and-paths` | 설치 경로는 `plugins/<id>/<version>`와 `sidecars/<file name>/<version>/<platform>`이며, `@scope/name`은 `scope-name`이 된다. 알 수 없는 플랫폼이나 잘못된 plugin id는 거부한다. | all |
| `install.plugin-id.core-reserved` | plugin id `core`는 core root가 예약하며, `validateManifest`와 plugin 버전의 설치 경로가 `plugin id core is reserved for the core root`로 거부하고, 그 id로 plugin을 설치하지 않는다. | all |
| `install.plugin-id.mismatch-refused` | `plugin.json`의 `id`가 설치 기록의 id와 다른 release의 설치는 `plugin.json id <a> differs from the installed plugin <b>`로 실패하고, 아무것도 풀지 않으며 `installed.json`을 쓰지 않는다. 기록된 폴더의 `plugin.json`이 다른 id를 밝히면 `plugins/installed.json` 읽기도 같은 문구로 실패한다. | all |
| `install.plugin-json.refuses-schema-outside-subset` | 풀린 `plugin.json`이 surface `params`에 `required`를 선언한 plugin의 설치는 `<plugin.json 위치>: plugin probe surface params: unknown field required`로 실패하며 `installed.json`을 쓰지 않는다. | all |
| `install.manifest.replays-manifest-cases` | 사례의 manifest를 `plugin.json`으로 담은 release를 `sok plugin install`하면 plugin id를 비교하기 전에 reader로 manifest를 검사한다. 거부 사례는 `plugin.json` 위치 뒤에 reader의 오류 문구로 거부하고 `installed.json`을 쓰지 않으며, 받아들이는 사례는 reader를 통과한다. | all |
| `install.granted-items` | `GrantedFiles`(Go)와 `granted_files`(Rust)는 요청 plugin의 view가 읽을 수 있는 파일의 core root 경로를 정렬하여 돌려준다: 요청 plugin의 point에 다른 enabled plugin이 기여하는 각 granted item의 module은 `/modules/<package>/<module>`이고, 다른 plugin의 granted item이 있는 각 point, 또는 요청 plugin이 기여하는 각 point의 각 shared module은 `/shared/<plugin id>.<point>/<specifier>.js`이다. Item은 provider가 설치되어 enabled이고, point가 version을 선언하며, item의 range가 그 version을 포함할 때 granted이다. 선언되지 않은 point, version이 없는 point, 범위 밖 item, disabled 또는 없는 provider, 설치되지 않은 요청 plugin은 아무것도 허용하지 않는다. 잘못된 선언, 없는 `plugin.json`이나 package name은 그것을 밝히는 error이다. | all |
| `install.installed.consistency` | `plugins/installed.json`은 `enabled` 누락, 현재 형식에서 `package`를 담은 plugin, 설치 규칙의 폴더가 아닌 plugin이나 sidecar의 `path`, 3이 아닌 `format`, `{ version, path }`가 아닌 sidecar 항목, 없는 `sidecars` 객체, 쓰는 version이 없는 sidecar, plugin 범위 밖의 쓰는 version, 어느 plugin도 지정하지 않은 sidecar를 거부한다. | all |
| `cli.plugin.host-entry-takes-no-lock` | 설치 library의 `RunPluginAction`은 설정 폴더의 lock을 잡지 않는다. host들이 자기 소유 안에서 호출하므로 살아 있는 host의 lock 옆에서도 애플리케이션의 plugin 조작이 돈다. | all |
| `cli.plugin.writing-commands-own-the-configuration` | `sok` command line의 쓰기 plugin 명령은 쓰기 동안 `process.lock`으로 설정 폴더를 소유한다. 살아 있는 소유자(실행 중인 host나 두 번째 명령) 옆의 명령은 `configuration directory <dir> is already owned by process <pid>`로 거부하고, 끝난 process의 lock은 지우고 한 번 다시 시도하며, 명령이 끝나면 설정을 놓는다. host가 자기 소유 안에서 호출하므로 `RunPluginAction`은 lock을 잡지 않는다. | all |
| `endpoint.lock.case-table-held` | 사례표 `docs/spec/cases/process-lock.json`의 잠긴(held) 사례마다 잠긴 `process.lock`은 endpoint 시작을 결과의 host 문구로 거부한다. 현재 형식이면 파일의 pid(살아 있든 아니든)와 함께 `configuration directory <dir> is already owned by process <pid>`, 빈 내용이면 `...by a live process`, 다른 형식이면 `...by a live process; process.lock is not the current form: <content>`. | all |
| `cli.plugin.lock-form-cases` | `sok`의 쓰기 명령은 `process.lock`에 advisory lock(flock)을 걸고 사례표 `docs/spec/cases/process-lock.json`의 형식으로 읽는다. 잠긴 잠금은 사례의 host 문구로 명령을 거부하고(현재 형식이면 파일의 pid), 잠기지 않은 잠금 파일은 내용과 관계없이 넘겨받는다. | all |
| `workspace.settings.write-refuses-another-form` | 다른 형태이거나 `format` member가 없는 프로젝트 설정 file에 대한 `settings` 쓰기는 `<file>: settings.json: format must be 1`로 실패하고 file을 바꾸지 않는다. 없는 file에 대한 쓰기는 현재 번호의 `format` member를 가진 현재 형태로 저장한다. | all |
| `install.stored.rejects-an-earlier-form` | 다른 형태의 번호 있는 저장 file은 `<file>: <name>: format must be <n>`로 실패하고 바뀌지 않는다: bare 배열 형태의 `projects.json`(`<file>: projects.json: format must be 1`)과 `format` member가 없는 `settings.json` 또는 `<project root>/.soksak/settings.json`. workspace snapshot은 그런 file을 보고하고(`workspace.snapshot.reports-refused-stored-files`, `workspace.settings.refuses-project-file-at-its-project`), 그 file에 쓰면 실패한다. 선언한 format의 `{format, value}`가 아닌 저장된 plugin data 항목은 그 key의 `data.get`을 프로젝트, 플러그인, key, format을 적은 message로 실패하게 한다. | all |
| `install.stored.no-migration` | 어떤 command line이나 host도 저장 file에 마이그레이션 정의를 적용하지 않으며, `migrations`를 선언한 plugin manifest는 알 수 없는 member로 거부된다. | all |
| `install.installed.rejects-another-format` | `format`이 3이 아닌 `plugins/installed.json`(형식 2와 member가 없는 file을 포함한다)은 `<file>: plugins/installed.json: format must be 3`로 실패하고 바뀌지 않는다([저장 데이터 형식](installation.ko.md#저장-데이터-형식)). | all |
| `installed.document.lists-enabled-plugins` | `/installed-plugins.json`은 켜진 설치 plugin을 id 순서로 `id`, `package`, `version`, 그리고 `plugin.json`의 compact 내용인 `manifest`와 함께 나열하고, 진단 build에서만 `diagnostics.json`의 compact 내용을 더하며, `installed.json`이 없으면 `{"plugins":[]}`다. | all |
| `installed.document.names-from-package-json` | `/installed-plugins.json` 항목의 `package`와 설치된 plugin의 `/modules/<package>`는 기록된 `path`의 `package.json`의 `name`이며, `package.json`이 없으면 `{"error":"<file>: no such file or directory"}`다. | all |
| `installed.document.refuses-package` | Plugin이 `package`를 담은 `installed.json`은 `{"error":"<file>: plugins/installed.json <id>: unknown field package"}`다. | all |
| `installed.document.reports-errors` | 켜진 plugin의 `plugin.json`이 없거나 잘못되었거나, `diagnostics.json`이나 `installed.json`이 잘못되었으면 `/installed-plugins.json`은 파일과 이유를 담은 `{"error":...}`다. | all |
| `installed.document.sidecar-facts` | `/installed-plugins.json`의 plugin `sidecars` 항목은 사이드카 의존마다 그 사이드카의 `sidecar.json`에 있는 `message`를 사이드카 이름 아래 담으며, 사이드카 의존이 없는 plugin에는 `sidecars` 필드가 없다. | all |
| `installed.document.acceptance-of-the-workbench` | Go `sok`는 page 없는 workbench를 위해 `/installed-plugins.json`을 받아들인다. 거절된 plugin은 그 오류와 함께 빼고, 오류 문서는 plugin을 받지 않고 그 오류로 답하며, 다른 형식이거나 plugin이 두 번 있는 문서는 오류이고, 항목은 page의 규칙을 따르며, plugin의 sidecar 사실은 그 dependency다. | mygo only: Wails와 Tauri host의 workbench는 page의 JavaScript에서 이 문서를 받아들인다 |
| `installed.plugin-json.invalid-text` | 켜진 plugin의 `plugin.json`이 JSON이 아니면 두 host 모두 `/installed-plugins.json`은 `{"error":"<file> is not valid JSON"}`다. host마다 다른 parser 세부는 담지 않는다. | all |
| `installed.json.invalid-text` | `installed.json`이 JSON이 아니면 두 host 모두 `/installed-plugins.json`은 `{"error":"<file> is not valid JSON"}`다. host마다 다른 parser 세부는 담지 않는다. | all |
| `installed.package-json.invalid-text` | 켜진 plugin의 `package.json`이 JSON이 아니면 두 host 모두 `/installed-plugins.json`은 `{"error":"<file> is not valid JSON"}`다. host마다 다른 parser 세부는 담지 않는다. | all |
| `page.start.document` | 시작 문서는 작업 공간 스냅샷, window의 `windowControls` 답, pending image detach가 있는 surface의 byte 순서 목록을 이 순서로 담은 `{"workspace":...,"controls":...,"pendingSurfaces":[...]}`다. | all |
| `page.start.snapshot-error-carries-controls` | page 시작의 작업 공간 스냅샷이 실패하면 host는 설정이 없을 때의 title bar를 설정하고, 그 뒤 `windowControls`를 읽으며, `workspace` 대신 스냅샷 오류를 담은 `{"error":...,"controls":...,"pendingSurfaces":[...]}`로 답한다. | all |
| `page.start.requires-window` | 시작 문서 요청은 요청한 window를 시작한 뒤 문서를 `no-store`인 `application/json`으로 답하고, 요청이 window를 가리키지 않으면 아무것도 시작하지 않고 400과 `the start document request names no window`로 실패하며, 시작이 실패하면 500과 그 이유로 실패한다. | all |
| `page.start.sok-core-owner` | Tauri는 시작 문서를 `soksak://core/start.json`에서 내보낸다. 다른 owner의 `soksak` 주소는 창을 시작하지 않고 404와 `soksak://<owner>/start.json not found`로 답한다. | tauriv2 only: Wails는 시작 문서를 asset server의 `/start.json`에서 내보낸다 |
| `plugins.state.reports-registry-and-installed` | `pluginsState`는 실행 중인 core의 version을 `core`로 돌려주고, `plugins/registry.json`이 없으면 `registry`와 `index`를 `null`로, 있으면 index URL과 검사한 index를, 읽거나 검사하지 못한 index는 `index`를 `{"error":...}`로 돌려주고, `installed.json`의 내용 또는 없을 때 빈 format 1 문서를 돌려준다. | all |
| `plugins.run.changes-like-the-command` | `install`, `update`, `disable`, `enable`, `remove`의 `pluginsRun`은 같은 `sok plugin` 명령처럼 `installed.json`과 폴더를 바꾸고 그 출력을 돌려주며, 바꿀 때마다 모든 창에 `{action, plugin}`과 함께 `plugins-changed`를 보낸다. | all |
| `plugins.run.applies-before-it-notifies` | `installed.json`을 바꾸는 plugin 작업은 `plugins-changed`를 보내기 전에 변경을 사이드카에 적용한다. | all |
| `plugins.run.rejects-invalid-and-concurrent` | `pluginsRun`은 알 수 없는 action, 비어 있지 않은 문자열이 아닌 plugin id, 명령의 message로 실패한 작업, 다른 작업이 실행 중일 때의 호출을 `another plugin operation is running`으로 거부하고, `plugins-changed` event를 보내지 않는다. | all |
| `plugins.registry.sets-like-the-command` | registry index로 `pluginsUseRegistry`를 부르면 `sok registry use`처럼 `plugins/registry.json`을 쓰고 `{ index }`를 돌려준다. 비어 있지 않은 문자열이 아닌 `index`는 `index must be a non-empty string`으로 거부한다. | all |
| `fetch.https.reads-a-tls-response` | 설정한 인증 기관이 신뢰하는 TLS server에서 `https:` index나 release를 읽고, `sha256`이 항목과 다른 release는 실패한다. | all |
| `fetch.https.redirects-only-to-https` | `https:` URL로의 redirect는 5번까지 따라간다. 여섯 번째 redirect와 `http:`로의 redirect는 그 문장으로 실패한다. | all |
| `fetch.https.reports-status-size-and-timeout` | 200이 아닌 응답, 한도보다 큰 본문, 한도보다 느린 요청은 `HTTP <status>`, `larger than <bytes> bytes`, `timed out after <seconds> s`로 실패한다. | all |
| `fetch.url.rejects-other-schemes` | `https:`도 절대 `file:` URL도 아닌 index나 release URL은 `the URL must be https: or an absolute file: URL`로 실패한다. | all |
| `installed.modules.unreadable-installation-serves-frontend` | `plugins/installed.json`을 읽을 수 없으면 `/modules/` 아래 요청은 설치 plugin을 가리키지 않고 bundled frontend가 답하므로, core module이 불러와지고 page가 시작한다. `/installed-plugins.json`이 오류를 담는다. | all |
| `installed.modules.serve-installed-files` | 켜진 설치 plugin의 `/modules/<package>/<path>`는 기록된 `path` 안의 파일을 제공한다. 없는 파일이나 빈 segment, `.`, `..`가 있는 경로는 찾을 수 없다. 꺼진 plugin이나 다른 package는 애플리케이션 frontend가 제공한다. | all |
| `installed.modules.frontend-first` | 애플리케이션 frontend가 가진 `/modules/` 아래 파일은 frontend가 제공한다. 그 요청은 `plugin.json`도 `package.json`도 읽지 않고, 같은 package의 plugin이 그 파일을 대신하지 않는다. | all |
| `installed.modules.read-the-manifest-of-the-request` | `/modules/`와 `/shared/` 아래 요청은 자기가 가리키는 plugin의 `plugin.json`만 읽고, `/modules/` 아래 요청은 자기 package의 plugin에서 `package.json` 읽기를 멈춘다. core module은 하나도 읽지 않고, 다른 plugin의 잘못된 `plugin.json`이나 `package.json`은 답을 바꾸지 않는다. | all |
| `installed.modules.follow-the-installation` | 설치, 제거, `plugin.json` 변경 뒤의 요청은 새 파일로 답한다. 어떤 요청도 앞 요청이 읽은 것을 갖고 있지 않기 때문이다. | all |
| `installed.shared.serve-extension-point-modules` | `/shared/<plugin id>.<point>/<specifier>.js`는 켜진 설치 plugin의 `plugin.json` `extends.<point>.modules`가 specifier에 대응한, 그 plugin의 기록된 `path` 안의 파일을 제공한다. `.js`로 끝나지 않는 경로, plugin이 선언하지 않은 지점, 지점이 대응하지 않은 specifier, 없는 파일, 빈 부분이나 `.`, `..` 부분이 있는 경로, 꺼졌거나 알 수 없는 plugin은 찾을 수 없고, 읽을 수 없는 `plugin.json`은 그 경로와 함께 실패한다. | all |
| `installed.sidecars.resolve-installed-folders` | Host의 sidecar는 켜진 설치 plugin의 `plugin.json`이 지정한 것이며, 각각 sidecar 폴더의 기록된 `path`와 거기의 `sidecar.json`을 가진다. 설치 version이 없는 sidecar는 실패하고, 빈 설정에는 sidecar가 없다. | all |
| `installed.sidecars.leave-out-plugin-dependencies` | 켜졌든 꺼졌든 설치된 plugin을 지정하는 `plugin.json`의 dependency는 host의 sidecar가 아니다. | all |
| `installed.sidecars.dependents-of-a-shared-sidecar` | 여러 켜진 plugin이 `dependencies`에 적은 sidecar는 한 번 선언되며, 그 선언은 그런 plugin을 plugin id 순서로 dependent로 나열한다. | all |
| `log.writer.assigns-seq-and-opens-with-log-open` | host 로그 파일은 `schema`(3), `pid`, `role`, `boot`를 담은 `log.open`으로 시작하며, writer는 모든 줄에 1부터 연속인 `seq`를 부여한다. | all |
| `log.writer.stores-both-clocks` | writer의 모든 줄은, `log.open`, `log.rotated`, `log.dropped`를 포함해, `ts_us`(호출 시점의 wall clock, 마이크로초)와 `mono_ns`(호출 시점의 플랫폼 monotonic clock, 나노초이며 양수이고 앞선 호출의 `mono_ns`보다 작지 않다)를 가진다. | all |
| `log.writer.stores-cids` | host의 생산자가 상관 식별자와 함께 낸 event는 `cids`(순서대로의 목록)와 함께 저장되고, 식별자가 없는 event에는 `cids`가 없다. 비어 있거나 따옴표, 역슬래시, 제어 문자를 담은 식별자는 거부하고 손실로 센다. | all |
| `log.writer.never-blocks-and-counts-loss` | `emit`은 기다리지 않고 돌아온다. 큐에 자리가 없으면 false를 돌려준다. writer는 손실을 기록할 때마다 직전 기록 이후 거부된 event 수와 같은 `count`와 거부된 event의 `channel`을 가진 `log.dropped` 하나를 그것이 가리키는 `seq` 범위 뒤에 저장하며, `count`의 합은 거부된 event 수다. | all |
| `log.writer.writes-each-interval` | writer는 마지막 쓰기 뒤 batch 간격이 끝날 때마다 모인 것을 쓰며, event가 간격보다 빨리 계속 들어올 때도 그렇다. event가 없는 간격을 기다리는 writer는 꾸준한 입력 동안 아무것도 쓰지 않고 kill에서 한 간격보다 많이 잃는다. | all |
| `log.writer.sleeps-with-nothing-to-write` | batch 간격 동안 쓴 것이 없는 writer는 event, source의 wake, 기다린 count가 닿을 때까지 다시 깨어나지 않는다. | all |
| `log.writer.a-count-waits-for-a-write` | gate count만으로는 쓰지 않는다. 잠든 writer는 다음 event까지 최대 1분 동안 count를 들고 있는다. | all |
| `log.writer.stores-the-first-event-at-once` | 잠든 writer를 깨운 event는 batch 간격을 기다리지 않고 저장되고, 뒤따르는 event는 그 event가 시작한 간격의 batch를 기다린다. | all |
| `log.writer.error-wakes-the-writer` | level이 `error`인 event는 배치 간격을 기다리지 않고 기록된다. | all |
| `log.writer.files-are-private` | 로그 폴더는 mode 0700, 로그 파일은 mode 0600이다. | all |
| `log.writer.output-follows-the-contract` | writer의 파일은 자신의 event를 선언한 catalog에 대해 `@soksak/log-contract` 감사를 통과한다. | all |
| `log.writer.flush-at-exit` | `flush`는 받아들인 모든 event가 디스크에 기록된 뒤 돌아오며, 기한이 지나면 그 기한을 밝히는 오류로 실패한다. | all |
| `log.writer.flush-behind-a-flush-or-a-stop-is-answered` | writer가 다른 flush 요청이나 stop 뒤에서 찾은 flush 요청은 답을 받고 그 뒤의 event는 저장되며, 끝난 writer의 flush는 deadline이 아닌 오류로 바로 실패한다. | all |
| `log.writer.relays-events-with-their-layer-and-time` | host의 writer는 프로세스의 다른 계층이 중계한 event를 그 event의 `layer`, `ts_us`, `mono_ns`, `cids`와 writer의 `seq`로 저장하고, 계층으로 시작하지 않는 event 이름, 계약에 없는 계층, 0인 `mono_ns`, 유효하지 않은 식별자는 오류로 거부한다. | all |
| `log.writer.names-the-writing-document` | 중계된 event는 자신을 쓴 문서를 layer `workbench`이면 `start`에, layer `page`이면 `page`에, layer `plugin`이면 둘 중 정확히 하나에 이름한다. writer는 이름한 member를 저장하고, member가 없는 event(`the event <name> of the layer <layer> names its writer in start`, `… in page or start`), layer `plugin`의 event에 두 member가 모두 있는 경우(`… names its writer in one of page and start, not both`), layer가 허용하지 않는 member(`the event <name> of the layer <layer> names page, which only an event of the layer page or plugin names`, `start`이면 `workbench or plugin`)를 거부한다. | all |
| `log.writer.rotates-at-the-bound-and-keeps-generations` | writer는 파일을 `rotate_bytes`를 넘게 될 줄 앞에서 닫고, 닫은 파일을 하나도 지우지 않고 세대 `.1`부터 `.N`으로 보관하고, 새 파일을 `log.open`과 `log.rotated`로 시작하되 `seq`를 이어 가고, 모든 세대가 계약의 파일이다. | all |
| `log.writer.refuses-an-unbounded-file` | 양의 회전 경계나 양의 세대 수 없이 시작한 writer는 그 옵션을 가리키는 오류로 시작에 실패한다. | all |
| `log.native.stores-pulled-records-in-the-layer-native` | writer는 native ring에서 pull한 record를 library가 준 시각과 level, 이름, field, writer의 `seq`로 계층 `native`에 저장한다. | all |
| `log.native.stores-clock-and-cids-of-pulled-records` | native ring에서 pull한 record는 library가 준 `ts_us`, `mono_ns`, `cids`와 함께 저장된다. 식별자에 따옴표, 역슬래시, 제어 문자가 있거나 이름과 식별자의 길이가 record에 맞지 않는 record는 이유 `a native record was refused`의 `log.dropped`로 센다. | all |
| `log.native.counts-refused-records-and-ring-loss` | writer는 native ring이 거부한 event를 이유 `the native ring was full`의 `log.dropped`로 세고, 계층 `native` 밖의 이름, 정의되지 않은 level이나 class, JSON 객체가 아닌 field, 맞지 않는 길이를 가진 pull한 record를 이유 `a native record was refused`의 `log.dropped`로 센다. | all |
| `log.native.wake-stores-a-record-at-once` | native ring의 wake는 잠든 writer를 ring으로 데려가므로, 나중에 도착한 record는 flush 요청 없이 즉시 저장된다. | all |
| `log.native.close-stores-the-ring` | writer를 닫으면 native ring의 record를 저장하며, wake를 받지 못한 record도 저장한다. | all |
| `log.native.pull-needs-a-wake` | source의 pull이 있고 wake가 없는 writer는 wake를 말하는 오류로 시작에 실패한다. | all |
| `log.native.platform-pulls-the-ring` | 플랫폼은 빈 native ring을 0바이트와 손실 없음으로 pull하고, 빈 buffer로의 pull은 거부한다. | all |
| `log.native.platform-reads-the-clock-and-takes-the-boot` | 플랫폼은 양수이고 줄어들지 않으며 시간과 함께 늘어나는 monotonic clock(나노초)을 읽고, 실행의 boot 식별자를 native 계층의 상관 식별자용으로 받는다. 빈 식별자와 영문자, 숫자, `-`, `_` 외의 문자가 있는 식별자는 거부한다. | all |
| `log.native.host-writer-starts-with-the-platform-pull` | host의 writer는 플랫폼의 pull과 함께 시작하고 `log.open`을 먼저 쓴다. | all |
| `log.native.activity-observers-register-under-the-policy` | host는 writer가 첫 policy를 적용한 뒤 활동 observer를 설치하므로, class `lifecycle`을 level `info`로 저장하는 policy는 host 시작부터 `activity.window`와 `activity.occlusion`의 `native.observe.registered`를 저장한다. | all |
| `log.native.platform-flushes-the-observers` | 플랫폼은 마지막 요약 뒤에 전달이 있는 native observer의 모든 counted source의 요약을 저장하고 오류 없이 응답한다. | all |
| `log.native.shutdown-flushes-the-observers-before-the-writer` | host의 종료는 native observer를 먼저 flush하고 event writer를 나중에 flush하므로, observer flush가 저장한 event는 종료 flush가 반환될 때 파일에 있다. | all |
| `log.native.shutdown-reports-a-failed-observer-flush` | native observer의 flush가 실패해도 writer의 flush는 건너뛰지 않고, 결과는 observer flush와 그 원인을 이름으로 밝힌다. | all |
| `log.writer.stores-class` | writer의 모든 줄은 catalog가 그 event 이름에 선언한 class인 `class`를 담으며, writer 자신의 event의 줄도 그렇다. | all |
| `log.writer.marks-undeclared` | 어느 catalog도 이름을 선언하지 않은 event는 `undeclared` `true`로 저장하며 버리지 않는다. layer가 `plugin`이면 class는 `lifecycle`이고, 그 밖의 미선언 이름은 class가 없다. | all |
| `log.writer.splits-files-by-level` | level `error`, `warn`, `info`는 `<role>-<boot>.jsonl`에, `debug`와 `trace`는 `<role>-<boot>.debug.jsonl`에 간다. 후자는 첫 해당 event가 `log.open`을 첫 줄로 하여 만들며, `seq`는 두 파일에 걸쳐 이어지고 두 파일을 합치면 모든 `seq`가 한 번씩 있다. | all |
| `log.writer.rotation-keeps-every-generation` | 각 파일은 상한에서 따로 회전해 회전 순서대로 1부터 센 세대 `<file>.<n>`이 되고, 새 파일은 `log.open`과 `log.rotated` `{bytes, generation}`으로 시작하며, 회전은 세대를 지우지 않는다. | all |
| `log.native.stores-the-class-of-a-pulled-record` | native ring에서 pull한 record는 그것이 가진 class로 저장하고, class가 열거 밖이거나 catalog의 class와 다른 record는 거부하며 이유 `a native record was refused`의 `log.dropped`로 센다. | all |
| `log.native.platform-takes-the-policy` | 플랫폼은 정책(class마다 level 하나 또는 -1)을 native 라이브러리에 주고, 열거 밖의 level은 거부한다. | all |
| `log.policy.file-names-every-class-and-nothing-else` | 모든 class를 한 번씩 여섯 값 중 하나로 이름 붙인 정책 파일은 적용한다. JSON이 아닌 글, `schema`와 `classes` 외의 항목, 다른 schema, 빠졌거나 모르는 class, 여섯 밖의 값은 파일 이름과 발견한 것을 담은 오류로 거부한다. | all |
| `log.policy.file-is-watched` | `log-policy.json`의 생성, 쓰기, 교체, 삭제는 타이머 없이 파일 시스템 event로 정책을 적용하고, 파일을 그대로 두는 알림은 아무것도 바꾸지 않으며, 규칙을 어긴 파일은 장소 `log policy`의 오류 기록이고 적용 중인 정책은 그대로 남는다. | all |
| `log.policy.default-stores-errors` | 정책 파일이 없는 writer는 모든 class의 `error` event를 저장하고 모든 class의 `warn`, `info`, `debug`, `trace` event를 거부하며, 기본 정책은 `docs/spec/cases/log-contract/policy/cases.json`의 `default`와 같다. | all |
| `log.policy.change-is-an-event` | writer의 첫 정책과 이후의 각 변경은 `source`와 `classes`를 가진 `log.policy` event 하나이며, 같은 정책이 다시 오면 아무것도 저장하지 않는다. | all |
| `log.policy.gate-counts-what-it-did-not-build` | 닫힌 gate는 아무것도 저장하지 않고, writer는 거부한 event의 정확한 수를 class와 level별로 `log.gated`로 보고한다. | all |
| `log.policy.gate-passes-the-events-of-the-writer-itself` | `log.open`, `log.rotated`, `log.dropped`, `log.policy`, `log.gated`, `log.pruned`는 class `lifecycle`을 끈 정책을 지난다. | all |
| `log.policy.gate-passes-the-start-of-the-workbench` | workbench가 host call `log`의 action `batch`로 전달한 `workbench.start` event는 class `lifecycle`을 끈 정책 아래에서도 저장된다. | all |
| `log.policy.page-sets-the-file` | host 호출 `log`의 action `policy`는 class를 파일의 규칙으로 검사하고 `log-policy.json`(mode 0600)을 쓰며, 규칙을 어긴 요청은 오류이고 아무것도 쓰지 않는다. | all |
| `log.policy.carries-the-cids-of-the-change` | host 호출 `log`의 action `policy`가 `cids`와 함께 쓴 정책은 감시가 적용할 때 그 `cids`를 가진 `log.policy`로 저장된다. 같은 정책이 다시 오면 아무것도 저장하지 않고, 파일의 다른 writer가 가져온 정책에는 `cids`가 없으며, 한 줄에 담을 수 있는 identifier의 목록이 아닌 `cids`는 오류이고 아무것도 쓰지 않는다. | all |
| `log.policy.read-answers-the-policy-in-force` | host 호출 `log`의 action `policy-read`는 적용 중인 정책의 모든 class 값인 `{classes}`로 답한다. 첫 정책 전에는 기본 정책이고, 그 뒤에는 마지막으로 적용한 정책이다. | all |
| `log.policy.event-reaches-every-document` | 정책을 적용하는 정책 파일의 각 load(source `default` 또는 `file`)는 그 정책의 `{classes}`를 담은 host event `log-policy`를 모든 window에 보내고, 거부된 파일은 아무것도 보내지 않는다. | all |
| `log.policy.binding-call-is-gated` | 정책이 저장하지 않는 binding 호출은 event를 만들지 않고 `log.gated`로 세며, 실패한 호출은 정책이 그 class를 `warn`부터 저장하면 경고로 저장한다. | all |
| `log.policy.endpoint-call-is-gated` | 정책이 저장하지 않는 endpoint 요청은 event를 만들지 않고 `log.gated`로 센다. | all |
| `log.policy.counts-each-second` | writer는 닫힌 gate의 정확한 수(`log.gated`)를 이전 보고 뒤 1초가 지났을 때, flush할 때, 멈출 때 보고한다. 여러 batch 간격에 걸친 1초 미만의 거부된 event는 `log.gated`를 저장하지 않고, flush는 그 정확한 합을 저장한다. | all |
| `log.policy.producer-builds-nothing-for-a-closed-gate` | 인자를 직렬화하는 host의 생산자는 class와 level의 gate가 닫혀 있으면 field를 만들지 않는다. | all |
| `log.policy.closed-gate-costs-a-branch` | 닫힌 gate의 질문은 열린 gate의 enqueue보다 훨씬 싸고 넉넉한 한도 안에 머물며, 수치를 출력한다. | all |
| `log.retention.removes-the-oldest-runs-over-the-bound` | `logs/`의 실행들의 파일이 상한을 넘으면 writer는 실행을 통째로, 가장 새로운 파일이 가장 오래된 실행부터 지우고, 파일을 지우는 각 회차는 `files`, `bytes`, `runs`, `from_us`, `to_us`, `remaining`, `bound`를 담은 `log.pruned` 하나다. | all |
| `log.retention.keeps-a-pinned-run-and-the-current-run` | writer의 실행과 `<role>-<boot>.keep` 파일이 있는 실행은 지우지 않으며, 파일이 상한을 넘은 채로 두는 회차는 level `warn`의 `log.pruned`를 저장한다. | all |
| `log.retention.stores-nothing-under-the-bound` | 상한 안의 파일은 지우지 않고 event도 저장하지 않는다. | all |
| `log.retention.runs-after-a-rotation` | writer의 회전은 보존을 다시 실행한다. | all |
| `log.retention.requires-a-bound` | 양의 보존 상한 없이 시작한 writer는 옵션 이름을 담은 오류로 시작에 실패한다. | all |
| `log.record.error-and-info-are-events` | level이 `error`나 `info`인 host 기록과 page가 보고한 기록은 호출한 시각과 줄바꿈을 포함한 원문 그대로의 `text`를 가진 event `<layer>.record.<level>`로 event log에 저장된다. | all |
| `log.record.site-names-the-call` | host의 record helper가 쓰는 기록은 helper를 부른 호출의 파일 이름과 줄인 field `site`를 담는다. | all |
| `log.record.start-buffer-holds-records-until-the-writer-exists` | host의 writer가 생기기 전에 쓴 기록은 시작 buffer에서 기다리고, writer는 그 기록을 쓴 시각 그대로 순서대로 받는다. | all |
| `log.record.start-buffer-counts-its-loss` | 시작 buffer는 1024개를 담고 그 너머의 기록은 거부하며, writer는 거부한 기록을 그 수와 함께 `log.dropped`로 기록한다. | all |
| `log.plugin-catalog.classifies-plugin-events` | writer는 plugin event를 plugin class가 주는 class로, 어느 catalog도 선언하지 않은 event를 `undeclared`로 저장한다. | all |
| `log.plugin-gate.undeclared-takes-lifecycle` | 선언되지 않은 layer plugin의 event는 class lifecycle과 `undeclared`로 저장되며, lifecycle을 끈 policy는 이를 거부하고 `log.gated`에 class lifecycle로 센다. | all |
| `log.plugin-gate.refuses-below-the-class-level` | class의 level 아래의 plugin event는 writer가 거부하고 `log.gated`에 그 class로 센다. | all |
| `log.plugin-catalog.reads-the-enabled-plugins` | plugin class는 활성화된 설치 plugin의 catalog가 선언한 class이며, 비활성 plugin은 아무것도 더하지 않는다. | all |
| `log.plugin-catalog.refuses-a-catalog` | 없거나 JSON이 아니거나 `plugin.<plugin>.` 밖의 이름이나 모르는 class를 선언한 catalog는 plugin id 순서로 그 파일을 밝히는 오류이고, 다른 plugin은 class를 유지한다. | all |
| `log.plugin-catalog.host-applies-the-installed-catalogs` | host는 설치된 catalog의 class를 writer에 주고, 쓸 수 없는 catalog를 장소 `plugin catalog`의 오류 기록으로 남긴다. | all |
| `log.plugin-catalog.keeps-the-catalogs-of-earlier-plugins` | 변경이 plugin을 제거한 뒤에도 writer는 그 plugin의 event를 그 catalog의 class로 저장한다. plugin을 load한 page는 reload할 때까지 그 code를 실행하기 때문이다. | all |
| `log.plugin-catalog.records-the-held-catalogs` | plugin catalog를 적용할 때마다(시작할 때와 변경마다) writer는 event `log.plugins` 하나를 저장하며, 그 `plugins`는 writer가 가진 catalog마다 plugin과 version을 적는다. | all |
| `bounds.producer.fields-are-cut-while-serialized` | host event의 fields는 1,048,576바이트까지만 직렬화한다. 상한을 넘는 값은 `fields` `{"head": <첫 4,096바이트>}`와 상한을 막 넘은 `truncated`(직렬화가 멈출 때까지 쓴 바이트 수)로 저장하고, 상한에 들어가는 fields는 그 JSON으로 저장한다. | all |
| `bounds.producer.record-text-is-cut` | host record의 `text`는 최대 8,192바이트, `where`는 최대 1,024바이트이며 각각 문자 경계에서 자르고, 둘 중 하나라도 잘렸으면 fields에 `truncated: true`가 있다. | all |
| `bounds.start-buffer.holds-at-most-four-mebibytes` | record의 시작 buffer는 record 1,024개 외에 최대 4,194,304바이트를 담고, writer는 거절한 record와 그 바이트를 `log.dropped`로 센다. | all |
| `bounds.endpoint.topic-changes-hold-at-most-256` | topic 하나의 구독 변경 256개가 workbench를 기다리면 다음 변경은 적용하지 않고, 오류 코드 `-32000`과 topic과 256을 말하는 메시지로 답하며, buffer `endpoint topic changes`와 이유 `the buffer holds 256 messages`를 가진 `host.buffer.dropped`로 저장한다. | all |
| `bounds.endpoint.output-queue-holds-at-most-sixteen-mebibytes` | 연결의 출력 큐가 16,777,216바이트를 넘게 담게 하는 frame은 거절하고, buffer `endpoint output queue`와 이유 `the buffer holds 16777216 bytes`를 가진 `host.buffer.dropped`로 저장하며, 연결을 닫는다. | wailsv3, mygo only: Go host는 연결의 frame을 writer goroutine이 비우는 큐로 보내지만, Tauri host는 연결을 쥔 채 각 frame을 소켓에 쓴다 |
| `log.record.flush-stores-the-records-written-so-far` | 기록 flush는 지금까지 쓴 기록이 event log에 들어갈 때까지 기다리고, 붙은 writer가 없으면 곧바로 돌아온다. | all |
| `log.batch.stores-workbench-events-in-order` | workbench의 `log` 중계는 `batch` 요청의 event를 workbench가 준 `start`와 `ts_us`, writer의 `seq`로, 순서대로, 계층 `workbench`에 저장한다. | all |
| `log.batch.rejects-an-invalid-batch-without-writing` | `log` 중계는 `batch`나 `clock`이 아닌 action, 배열이 아닌 `events`, `workbench.`와 `plugin.` 어느 쪽으로도 시작하지 않는 event 이름, 계약에 없는 level, 양의 정수가 아닌 `ts_us`나 `mono_ns`, 따옴표·역슬래시·제어 문자 없는 비어 있지 않은 문자열의 배열이 아닌 `cids`, 객체가 아닌 `fields`에 대해 배치 전체를 거부하고 그 배치는 아무것도 쓰지 않으며, 오류는 `events[<index>]`를 가리킨다. | all |
| `log.batch.returns-the-transcript-lines-of-workbench-records` | `log` 중계는 배치의 workbench 기록(문자열 field `where`와 `text`를 가진 `workbench.record.<level>`)의 줄 `<level> workbench <where>: <text>`을 돌려주며 host는 그것을 창의 transcript에 보이고, 그 문자열 field가 아닌 workbench 기록은 거부한다. | all |
| `log.transcript.answers-the-whole-line` | host call `log`의 action `transcript`는 줄을 place `workbench`와 workbench의 start를 가진 `workbench.record.info`로 저장하되 8,192바이트에서 잘라 `truncated: true`를 두고, 전체 줄 `info workbench workbench: <line>`을 응답하며 host는 그것을 창의 transcript에 보인다. `start`가 없거나 `line`이 빈 요청은 오류다. | all |
| `log.batch.stores-plugin-events-in-the-layer-plugin` | workbench의 `log` 중계는 이름이 `plugin.`으로 시작하는 event를 계층 `plugin`에, `workbench.`로 시작하는 event를 계층 `workbench`에, 각각 workbench가 준 `start`와 시각, `page` 없이 writer의 `seq`로 저장한다. | all |
| `log.batch.stores-clock-and-cids-of-workbench-events` | `log` 중계는 workbench가 준 `ts_us`, `mono_ns`와, event에 있으면 `cids`를 저장하고, `cids`가 없는 event에는 `cids`가 없다. | all |
| `log.batch.answers-the-clock-request` | `log` 중계는 `{action: "clock"}`에 host가 호출 시점에 읽은 `ts_us`와 `mono_ns`로 답하고 event를 저장하지 않는다. 두 번째 답은 어느 clock에서도 첫 번째 답보다 작지 않다. | all |
| `log.view-batch.binds-ready-page-and-native-surface` | view batch는 해당 view의 ready page에 대해서만 허용된다. host는 native plugin과 surface를 묶고 결과 기록에 page와 주입한 surface를 저장한다. | all |
| `log.view-batch.rejects-foreign-source-without-partial-write` | 다른 page의 event가 포함된 batch는 전체를 거부하며 그보다 앞선 유효 event도 쓰지 않는다. | all |
| `log.view-batch-requires-page-start-to-match-ready-origin` | view batch의 `page.start`는 ready page identity와 같은 `time_origin`을 가져야 한다. 다르면 전체 batch를 쓰지 않고 거부한다. | all |
| `log.view-batch-requires-a-nonempty-page-start-url` | view batch의 `page.start`에는 비어 있지 않은 URL이 필요하며, 빈 URL이면 전체 batch를 쓰지 않고 거부한다. | all |
| `log.view-batch-refuses-a-caller-supplied-surface` | plugin event는 자신의 `surface`를 view batch에 넣을 수 없다. host는 그 값을 신뢰하거나 교체하지 않고 batch를 거부한다. | all |
| `log.view-batch-rejects-a-foreign-plugin-prefix` | view batch의 plugin event는 해당 view plugin의 prefix를 사용해야 하며 다른 prefix는 batch 전체 쓰기 없이 거부된다. | all |
| `log.view-batch-bounds-fields-after-surface-injection` | native surface를 주입한 뒤 host는 event fields를 page field 크기 제한 안에 유지하고 잘라낸 fields를 표시한다. | all |
| `log.view-request-accepts-only-declared-clock-and-batch-fields` | view writer는 `clock`에 `{action}`만, `batch`에 `{action, events}`만 허용한다. 알 수 없는 요청 field는 기록 없이 거부한다. | all |
| `log.view-clock-answers-without-policy-or-event-write` | view clock 요청은 host wall 및 monotonic clock으로 답하고 policy 작업은 허용하지 않으며 event를 쓰지 않는다. | all |
| `startup.failure.exits-with-its-message` | setup 단계의 실패는 그 메시지를 쓰고, 실패를 event loop에 돌려주지 않고 상태 1로 프로세스를 끝낸다. 돌려주면 프로세스가 abort된다. | all |
| `startup.ends-no-process` | 호스트의 시작은 어떤 프로세스도 끝내지 않는다: 이전 실행의 기록 파일이 나열한 다른 애플리케이션의 WebKit 프로세스는 설정 디렉터리를 준비한 뒤에도 살아 있다. | all |
| `plugins.starter.rejects-invalid-request` | 등록된 plugins starter command는 `state` 형식이 잘못된 요청을 command argument 오류로 거부한다. | all |
| `view-source-stream.channel-registers-and-retires` | Tauri main-page command는 현재 view-source event channel을 등록하고 교체 또는 page reload 시 이전 channel을 retire한다. | tauriv2 only: host는 Tauri가 주입하는 `Channel` lifecycle API를 사용한다 |
| `view-source-stream.command-is-registered` | Ordered view-source event channel을 등록하는 main-page command는 webview에 노출된다. | tauriv2 only: Tauri는 주입된 `Channel`을 전달하는 command를 등록한다 |
| `view-source-stream.requires-current-channel` | channel 등록 전이나 page 교체 중에 보낸 view-source event는 명시적 오류로 실패한다. | tauriv2 only: host는 Tauri가 주입하는 `Channel` lifecycle API를 사용한다 |
| `view-source-stream.follows-channel-call-order` | view-source event는 source handler가 호출한 순서대로 현재 Tauri channel에 전송된다. | tauriv2 only: host는 Tauri가 주입하는 `Channel` transport를 사용한다 |
| `view-source-stream.send-failure-is-returned` | Tauri channel로 view-source event를 보내지 못하면 source handler에 오류를 반환한다. | tauriv2 only: Tauri `Channel` send operation은 결과를 반환한다 |
| `view-source-stream.rejects-unlisted-events` | view-source channel은 allowlist 밖의 event 이름을 거부한다. | tauriv2 only: host가 Tauri channel allowlist를 소유한다 |
| `view.placement.geometry-failure-is-reported` | Tauri native geometry operation이 반환한 placement 실패를 호출자에게 전달한다. | tauriv2 only: Tauri platform geometry method는 결과를 반환한다 |
| `surface-close.closed-window-reports-no-failure` | window가 닫힌 뒤 실행되는 surface close는 close가 가져간 window record에서 view source를 끝내고, 알림을 보내지 않으며, 실패를 보고하지 않는다. | tauriv2 only: Tauri close는 가져간 record로 main thread에서 queue되어 실행되고, 그곳에서 window가 열려 있는지 판단한다. Wails close는 자기 window의 state에서 실행된다(docs/spec/hosts.md H21) |
| `surface-close.open-window-ends-view-source-for-page` | 열린 window의 surface close는 view source를 끝내고, page가 끝났다고 알게 되는 plugin과 generation을 준다. | tauriv2 only: Tauri close는 가져간 record로 main thread에서 queue되어 실행되고, 그곳에서 window가 열려 있는지 판단한다. Wails close는 자기 window의 state에서 실행된다(docs/spec/hosts.md H21) |
| `presentation-end.closed-window-ends-nothing` | 실행 전에 window가 닫힌 presentation wait의 지연된 종료는 wait를 끝내지 않고 실패를 보고하지 않는다. | tauriv2 only: Tauri 종료는 main thread에서 queue되어 실행되고 label로 window를 찾는다. Wails 종료는 자기 window의 record에서 실행된다(docs/spec/hosts.md H22) |
| `presentation-end.open-window-ends-join` | 열린 window의 presentation wait의 지연된 종료는 그 surface, generation, ticket의 join을 끝낸다. | tauriv2 only: Tauri 종료는 main thread에서 queue되어 실행되고 label로 window를 찾는다. Wails 종료는 자기 window의 record에서 실행된다(docs/spec/hosts.md H22) |
| `window-notification.closed-window-reports-no-failure` | window가 닫힌 뒤 실행되는 window 알림은 단계를 실행하지 않고 실패를 보고하지 않는다. | tauriv2 only: 알림은 host의 window record를 따른다. |
| `window-notification.open-window-reports-its-failure` | 열린 window의 알림은 단계를 실행하고 단계의 실패를 보고한다. | tauriv2 only: 알림은 host의 window record를 따른다. |
| `surface-sync.closed-handle-is-not-used` | surface가 닫힌 뒤 실행되는 surface sync의 main-thread 단계는 sync가 읽은 handle을 쓰지 않는다. close가 먼저 registration을 잊기 때문이다. | tauriv2 only: Tauri sync는 main thread 밖에서 handle을 읽고 그 handle을 쓰는 단계를 queue한다. Wails layout은 한 main-thread 단계에서 handle을 읽고 쓴다 |
| `document-callback.retirement-keeps-active-callback-alive` | Tauri document를 폐기할 때 이미 실행 중인 invocation이 반환된 뒤 ended, changed, event, responsiveness callback을 해제한다. | tauriv2 only: native document FFI 경계를 넘는 Rust callback receiver ownership을 검증한다 |
| `exposure.surface-closed.closed-window-records-nothing` | 창이 닫힌 뒤 닫히는 surface는 아무것도 제거하지 않고 오류도 쓰지 않는다. registration은 창의 record와 함께 끝났다. | tauriv2 only: Go host는 surface 값에 registration을 두고 닫기가 그 값에 직접 닿으므로 그곳에서는 record 조회가 실패할 수 없다 |
| `surface.sync.closed-window-creates-nothing` | 창이 닫힐 때 진행 중인 배치나 modal 요청은 표면이나 modal view를 만들지 않고 `project window is closed`로 실패한다. 창을 닫을 때 모든 표면을 이미 닫았으므로 그 뒤에 만든 표면은 닫는 곳이 없기 때문이다. | all |
| `exposure.reply.error-member-names-code-and-message` | document reply의 `error` member에 `code`나 `message`가 없으면 `error has no code` 또는 `error has no message`로 거부하며, 기다리는 요청에 code 0이나 빈 message를 전달하지 않는다. | all |
| `sok.endpoint.error-member-names-code-and-message` | endpoint 응답의 error member에 `code`나 `message`가 없으면 `invalid frame from endpoint: error has no code` 또는 `... error has no message`로 거부하며, code 0이나 빈 message로 대신하지 않는다. | all |

## Workbench cases

Wails와 Tauri 호스트의 메인 페이지와 mygo 호스트의 workbench는 각자 project data의 view call에 답한다. 그래서 한 동작의 page 시험과 mygo 시험은 시험 바로 위의 줄 `// contract: <id>`로 한 사례를 선언한다. 시험 목록 검사(`scripts/check-tests.mjs`)는 한쪽에 시험이 없는 사례, `packages/workbench-mygo/tests/`의 시험이 선언한 표에 없는 사례, 시험에 붙지 않은 선언에서 실패한다.

| 층 | 이 사례의 코드 | 시험 |
| --- | --- | --- |
| 메인 페이지(Wails, Tauri) | `packages/workbench/plugin-data.js`, `packages/workbench/projects.js` | `packages/workbench/test/` |
| mygo 호스트의 workbench | `packages/workbench-mygo/src/project_data.go` | `packages/workbench-mygo/tests/` |
| Go 호스트, Rust 호스트 | 없음: patch는 자기가 실은 `plugins` object를 저장하고, 어느 호스트도 그 안의 key를 읽지 않는다. `workspace.projects.plugin-data-patched`가 이것을 다룬다 | 없음 |
| SDK | `packages/plugin-api/view.js`: 모든 호스트에 하나인 `runtime.data.change` | `packages/plugin-api/test/view.test.mjs` |

이 절의 case:

| Case | Behavior |
| --- | --- |
| `project-data.write.keeps-the-keys-before-it` | 뷰의 쓰기는 앞선 쓰기 뒤에 store에 닿고 앞선 쓰기를 함께 실으므로, 연달아 쓴 두 key가 모두 남는다. |
| `project-data.write.outran-read-keeps-the-write` | 쓰기가 앞지른 store 읽기는 창의 기록에서 그 쓰기를 빼지 않는다. |
| `project-data.write.refusal-answers-the-view` | store가 거부한 쓰기는 view call을 실패시키고 key의 값을 그대로 둔다. |
| `project-data.replace.changed-value-writes-nothing` | 한 읽기에서 나온 `runtime.data.replace` 두 호출 중 첫째는 값을 저장하고 `true`를 답하며, 둘째는 아무것도 저장하지 않고 `false`를 답한다. |
| `project-data.replace.compares-json-values` | `docs/spec/cases/project-data/values.json`의 각 행은 한 답을 낸다. object member의 순서, 숫자의 표기, 문자열의 escape는 차이를 만들지 않고, 값이 다르면 `false`를 답한다. |
| `project-data.replace.read-value-is-its-base` | 그 파일의 각 저장 값에 `runtime.data.get`이 답한 값을 `base`로 돌려보내면 `true`를 답한다. |
| `project-data.replace.requires-base` | `base`가 없는 `runtime.data.replace`는 `view call runtime.data.replace requires base`로 실패한다. |
| `project-data.replace.refusal-answers-the-view` | store가 거부한 replace는 view call을 실패시키고 key의 값을 그대로 둔다. |
