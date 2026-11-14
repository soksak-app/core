# View-wire cases

[English](README.md)

view-wire case는 view page와 host 사이의 교환 한 번을 기록한다. view가 `sok-view` handler로 보내는 각 호출(`window.webkit.messageHandlers["sok-view"].postMessage({sok: 1, id, command, params, cids})`, [view.js](../../../../packages/plugin-api/view.js)가 만든다), host가 그 호출에 주는 응답, host가 view에 post하는 각 notice(`{sok: 1, event, data}`), host가 view에 post하는 각 request(`{sok: 1, id, command, params}`)가 기록된다. 채널은 [native surfaces](../../native-surfaces.ko.md#view-표면) 명세가 정의하고, 동작은 `docs/spec/host-contract.ko.md`가 나열한다.

형식은 [page-wire cases](../page-wire/README.ko.md)의 형식이다. case마다 추적되는 JSON 파일 하나, 멤버 `name`, `description`, `replay`, `reason`, `variables`, step `call`, `reply`, `notice`, held 응답, stream, 변수와 그 치환은 그 파일을 따른다. 이 파일은 view wire가 더하거나 바꾸는 것만 적는다.

consumer는 view page의 테스트다. [testing.js](../../../../packages/plugin-api/testing.js)의 `openView(name, options)`가 jsdom window 위에 실제 view bridge와 실제 exposure를 열고, view의 각 호출에 case의 응답으로 답한다. producer는 host 패키지이며, host의 view handler가 스스로 답하는 case를 실행한다.

## 파일

- 파일 이름은 `<name>.json`이며, `name` 멤버는 `.json`을 뺀 파일 이름과 같다.
- 파일 이름 접두사는 host가 스스로 답하는 호출이면 `log-`이고, 그 밖에는 case를 재생하는 시험 파일 이름에서 `.test.mjs`를 뺀 것이다.

## 멤버

| 멤버 | 필수 | 의미 |
| --- | --- | --- |
| `name`, `description`, `replay`, `reason`, `variables` | page-wire와 같다 | page-wire case의 멤버. |
| `plugin` | 예 | view의 plugin id. reader는 `soksak://<plugin>/`에서 page를 연다. |
| `steps` | 예 | 순서가 있는 교환. |

page-wire case에는 host event writer 상태를 위한 멤버 `writer`가 있다. view-wire case에는 그 멤버가 없다. producer는 policy 파일이 없는 host writer를 시작한다.

## Step

step은 네 객체 중 하나다.

- `{"call": {"command": ..., "params": ..., "cids": [...]}}`: view가 `command`를 호출한다. `params`는 호출의 인자 하나이며, view가 인자를 보내지 않으면 없다(인자 없는 view bridge 호출은 `null`을 보내며, case에는 `null`로 기록된다). `cids`는 호출이 싣는 상관 식별자 목록이며, 싣지 않으면 없다. 호출에는 host 변수가 없다.
- `{"reply": {"result": ...}}`, `{"reply": {"error": "..."}}` 또는 `"held": true`가 붙은 같은 것: 바로 앞 호출에 대한 host의 응답이며, page-wire와 같다. error는 응답 `{sok: 1, id, error: {code, message}}`의 message다. code는 -32000이며, workbench와 host의 log handler가 모든 실패에 쓴다.
- `{"notice": {"event": ..., "data": ...}}`: host가 이벤트 `event`를 `data`와 함께 view에 post한다(`{sok: 1, event, data}`). 이벤트에 `data`가 없으면 없다. host의 exposure request는 이벤트 `exposure-request`의 notice이며 `data`는 `{id, method, params}`다.
- `{"request": {"id": ..., "command": ..., "params": ...}}`: host가 view의 command `command`에 대한 request를 식별자 `id`로 post한다(`{sok: 1, id, command, params}`). view의 응답은 step이 아니다. view가 보내는 message이며 테스트가 판정한다.

case에는 `listen` step이 없다. view는 listener를 page에서 등록하며, host가 답하는 호출로 등록하지 않는다.

host가 고르는 식별자(request의 `id`, exposure request의 `data.id`)는 case가 적는 숫자다. host는 request를 1001부터 번호 매기고, step 순서대로 request마다 하나씩 센다. exposure request에 답하는 view의 호출(`name`이 `exposureReply`인 `runtime.native.call`)은 그 숫자를 payload에 싣는다.

## Reader 동작

`packages/plugin-api/testing.js`의 `openView`는 view의 호출에 step 순서대로 답한다.

- command `runtime.log`의 호출이 stream 하나를 이루고(page는 다른 호출이 정하지 않는 시점에 이를 쓴다), 그 밖의 모든 호출이 다른 stream을 이룬다. 자기 stream의 다음 호출과 다르거나 stream의 마지막 step 뒤에 오는 호출은 오류로 답하고 실패로 남긴다.
- 응답은 호출이 호출자에게 돌아간 뒤에 전달된다. handler 반대편의 host가 그렇게 한다.
- `calls`는 view의 모든 호출을 `{command, params}`로 나열하며, 호출이 `cids`를 실으면 함께 나열한다.
- `deliverNotice(event, data)`는 다음 step을 실행하며, 그 step은 `event`의 notice여야 한다. `data`를 주면 notice가 그 data를 실어야 한다(JSON 값으로 비교). `run(command, params)`는 다음 step을 실행하며, 그 step은 `params`를 가진 `command`의 request여야 하고, view 응답의 result를 반환한다. `status(name)`, `command(name, params)`, `exposed(method, params)`는 다음 step을 실행하며, 그 step은 그 method의 exposure request여야 한다.
- `release(key)`는 가장 오래된 held 응답, 또는 `key`가 가리키는 held 응답을 settle한다. 숫자는 그 호출 step의 index, 문자열은 그 command의 이름이다([page-wire](../page-wire/README.ko.md#reader-동작)).
- 환경 변수 `VIEW_WIRE_TRACE=1`이면 reader는 view가 보내는 각 호출을 일치 여부와 관계없이 standard error에 쓴다.
- `close()`는 page가 끝나듯 view를 끝낸 다음, 실패가 남았거나 case의 step(어느 stream이든)을 실행하지 않았거나 held 응답을 풀지 않았으면 throw한다.

## Producer 실행

reader는 case의 형식 검사, 호출 매칭, held 항목을 page-wire reader와 공유한다(`@soksak/plugin-api/wire-case`).

view wire의 producer는 `packages/host/go/src/view_wire_test.go`(`TestViewWire`, diagnostics 빌드)와 `packages/host/rust/tests/view_wire_test.rs`다. `replay: true`인 각 case를 host의 view handler로 실행한다. 호출은 ready document가 있는 view의 `answerViewLog`를 거치고, 응답은 case의 응답과 비교한다. host가 스스로 답하는 호출은 command `runtime.log`뿐이다(`packages/host/go/src/event_relay.go`의 `viewLogCommand`: clock request는 host의 clock으로 답하고, page record의 batch는 `null`로 답하고, 거부된 batch는 record를 지목하는 오류로 답한다). 그 밖의 모든 호출은 이벤트 `view-call`로 workbench page에 전달되고, page가 `viewReply`로 답한다(`packages/workbench/view-calls.js`의 `answerViewCall`). 그 호출에는 실행 중인 애플리케이션만 답하므로, 그런 호출을 가진 case는 `replay: false`와 그 이유를 가진다. Rust producer는 요청을 `packages/host/rust/src/event_relay.rs`의 `view_log_command`로 실행한다. 이 함수는 Tauri host의 view handler가 호출하는 함수이며(`packages/host/rust/src/documents.rs`의 `view_log_message`), ready view의 plugin, surface, document, time origin으로 실행하고 오류는 message를 비교한다. 응답의 code -32000은 `view_log_reply_message`의 상수이며 host의 unit test가 판정한다. 이 디렉터리의 `log-` case는 `runtime.log` 호출만 가지며, producer의 ready view가 속한 plugin `probe`를 쓴다.

다른 case의 응답은 workbench page가 그 호출에 반환하는 값이다. `tab.state.read`, `tab.state.write`, `runtime.native.on`, `runtime.native.call`, `runtime.command.register`, `runtime.sidecar.send`, `runtime.textSize.read`, `runtime.textSize.on`, `composition.declaration`, `composition.place`, `document.attach`, `image.attach` 등은 `packages/workbench/view-calls.js`의 `run`과 그것이 부르는 동작이 반환하는 값을 반환하고, `core.file.open`은 `packages/workbench/core-exposure.js`의 `core.file.open`과 `packages/workbench/file-open.js`의 `checkOpenPath`가 반환하는 값을 반환한다.

## 한계

- case는 view 하나의 호출을 가진다. view를 여럿 여는 테스트는 view마다 case 하나를 실행한다.
- case는 workbench page가 응답을 만드는 방법을 적지 않는다. 응답의 값(예: plugin manifest의 composition)은 case의 data다.
