# Plugin host

[English](plugin-host.md)

plugin host는 plugin의 프로세스로, 창에 붙는 platform web view에서 그 plugin의 선언 status를 제공한다. plugin의 view가 하나도 열려 있지 않은 동안 sidebar section의 [선언 status](declared-ui.ko.md#선언된-status)를 제공해야 할 때만 존재하며, 고른 선언 status 출처가 host일 때마다(활성 탭의 view가 첫째, plugin host가 둘째) 그 status를 제공한다. sidecar는 한 domain의 native 기능을 가지므로 host가 그 status들의 DOM 없는 presentation을 갖고, sidecar는 그 데이터를 준다. sidecar나 상태 모듈은 선언 status 출처가 아니다.

plugin 코드는 workbench 페이지에서 실행되지 않으며, main page는 plugin host의 코드를 실행하지 않는다. host 페이지는 view surface의 view처럼 `soksak://<plugin id>` origin의 별도 web view다([plugin processes](plugin-processes.md) rule 1). native host와 workbench가 이 명세를 구현하며, [feature status](../features.md)가 구현 상태를 기록한다. plugin host 코드는 workbench 페이지에서 실행되지 않으며, workbench는 plugin 코드를 가져오지 않는다.

## Declaration

manifest는 `plugin.json`의 `host` 아래에서 plugin host를 선언한다:

```json
{
  "host": {
    "page": "ui/host.html",
    "state": { "format": 1, "maxBytes": 65536 }
  }
}
```

| 필드 | 필수 | 의미 |
| --- | --- | --- |
| `page` | yes | host web view의 페이지. `view` composition의 페이지 규칙을 따른다. plugin release 안의 상대 경로, 선행 슬래시 없음, 빈 segment와 `.`과 `..` segment와 `.binary` segment 없음, `.html`로 끝남, `package.json`의 `files`에 등재. 페이지가 등재되지 않으면 `sok plugin pack`이 실패한다 |
| `state` | no | host 페이지가 저장하여 프로세스의 재시작에서 복구되는 상태. `surface.unload`와 같은 꼴의 `{ "format": <양의 정수>, "maxBytes": <양의 정수> }`([plugins](plugins.ko.md#메모리-절약)). 다른 field를 가지거나 양의 정수가 아닌 값을 가진 object는 plugin을 naming하는 오류다. 이것이 없으면 host는 상태를 저장하지 않는다([state](#state)) |

`host` 선언은 plugin이 `surface`, `sections` 또는 `contributes`를 선언해야 한다는 요구 외에 추가 요구가 없다. plugin의 host web view는 불러온 plugin의 manifest가 그것을 선언할 때만 존재한다.

## Web view and configuration

host는 plugin당 창당 하나의 plugin host web view를, [view](native-surfaces.ko.md#view-표면)의 구성으로 만든다:

- `isView`를 설정한다. 그래서 이 구성만 `core` scheme을 core root resolver로 보낸다.
- plugin의 plugin id. 페이지의 `soksak://<plugin id>` origin과 core root 응답의 `Access-Control-Allow-Origin`을 정한다.
- `packages/plugin-api/view-start.js`의 텍스트를 담은 document-start user script. [view channel](native-surfaces.ko.md#view-표면) 스크립트다.
- theme 토큰을 담은 document-start user script.
- plugin start 값의 document-start user script. `window.sokHost`를 plugin host의 동결된 `{project, declarations}`로 둔다. host가 값을 직접 만든다. `project`는 host가 plugin host를 만들 때 window가 보여 주는 project의 동결된 `{id, root}`(project id와 정규 root)이고, project를 보여 주지 않는 window에서는 `null`이다. `declarations`는 plugin manifest의 `exposes`이며, 선언이 없으면 `{}`이다. `exposes`가 객체가 아니면 거부한다. host에는 surface도 origin도 없다. script는 page를 불러오기 전에 추가하며, host가 plugin host를 다시 만들면 다시 추가한다. window가 보여 주는 project가 나중에 바뀌면, theme처럼 준비된 document가 있는 각 plugin host에 message event `project`를 `data`가 `{id, root}` 또는 `null`인 채로 보낸다. 준비된 document가 없는 host에는 보내지 않는다;
- script message handler `sok-view`.
- plugin id로 key되는 plugin의 persistent website data store.

host는 `plugins/installed.json`이 그 plugin에 대해 기록한 폴더에서 `soksak://<plugin id>/<page>`를 불러온다. view의 페이지를 불러오는 것과 같다. 페이지는 네 항목의 [view import map](plugins.ko.md#view-표면)을 선언하고 `checkViewPage`를 통과하며, [view bridge](plugins.ko.md#view-표면)를 import하고 `sok-view` handler로 `createViewChannel()`을 부른다.

web view는 surface host가 아니라 창에 붙는다. 그것은 surface가 아니다. `SurfaceHost`를, surface frame을, region을, presentation wait을 가지지 않는다. host는 그것을 숨겨 놓고 아무것도 보여주지 않는다. web view는 0 frame을 가지고, 보이지 않음으로 제출되고, 화면에 아무것도 그리지 않고, hit testing을 받지 않고, first responder가 되지 않는다. host 페이지는 입력을 받지 않고 shortcut table을 등록하지 않는다. `host.hit`은 그것을 보고하지 않는다.

## Lifetime

host는 창의 main page가 `host`를 선언하는 plugin을 불러올 때 그 plugin의 plugin host web view를 만든다. 그래서 plugin의 declared section이 plugin의 view가 열리기 전에 자기 출처를 가진다. host는 plugin이 제거되거나 사용하지 않게 되거나, plugin 변경의 적용이 창을 다시 불러오거나, 창이 닫힐 때 그 web view를 없앤다. host 페이지 프로세스는 자기 web view와 함께 끝나며 [restart limit](#restarts) 안에서 다시 만들어진다.

host 페이지는 surface context를 가지지 않는다. plugin의 동기 값(`icon(name)`, `origin`, `project`, `declarations`; 탭에 속하는 `params`는 없음)을 view 페이지처럼 받고, 비동기 동작은 view bridge로 걸으며, `contributions(point)`를 그 point의 연결된 항목으로 받는다.

## Channel

plugin host channel은 위의 web view 구성에 대한 [view channel](native-surfaces.ko.md#view-표면)이다. 같은 document-start script, 같은 `sok-view` handler, ready document를 만드는 문서 식별자를 담은 같은 ready message, 최대 256개의 message를 담는 같은 queue, host message의 같은 `sok: 1` 표지, `window.postMessage(message, location.origin)`를 통한 같은 전달, 표지 없는 message에 대한 같은 거부가 재사용된다. queue가 가득 찬 상태에서 도착한 message는 담기지 않는다. script는 `view.error` message로 `sok-view`를 통해 이유 `queue full for <plugin>`을 보고하고, host는 `error: plugin host channel: plugin <plugin>: queue full for <plugin>`을 application log에 쓰며, host는 그 plugin host를 닫고 restart limit 안에서 다시 만든다. 다른 nonempty reason의 `view.error`는 `error: plugin host channel: plugin <plugin>: <reason>`으로 한 번 기록한다. reason이 이미 정확히 `plugin <plugin>: ` prefix로 시작하면 host는 prefix를 더하지 않고 한 번 기록한다. reason이 다른 plugin prefix로 시작하면 실제 channel plugin prefix를 더하고 reason은 그대로 보존한다. nonempty reason이 없는 `view.error`는 `plugin <plugin>: view.error has no reason`으로 거부한다. host message가 기록 없이 버려지는 일은 없다.

view와 다른 것은 상대와 call이다:

- 중계되는 모든 message는 plugin을 담고 surface를 담지 않는다. host 페이지는 surface를 가지지 않기 때문이다.
- host는 페이지의 call request `{sok: 1, id, command, params}`(`id`가 정수이고 `command`가 channel이 받는 call이며, 다음 절이 나열한다)를 창의 main page에 event `plugin-host-call {plugin, id, command, params}`로 보내고, cancel `{sok: 1, id, cancel: true}`를 `plugin-host-call {plugin, id, cancel: true}`로 보낸다. main page는 `pluginHostReply {plugin, id, result}` 또는 `pluginHostReply {plugin, id, error: {code, message}}`로 답하고, host는 `{sok: 1, id, result}` 또는 `{sok: 1, id, error}`를 ready document에 보낸다. 다른 잘못된 필드를 가진 message는 `error: plugin host channel: <reason>`으로 application log에 쓰이고 중계되지 않는다.

plugin host reply는 정수 `reply` id와 `result`, `error` 중 정확히 하나의 멤버를 가진다. `result` 멤버의 존재로 결과 제공 여부를 판단하며, 값이 JSON `null`이어도 유효하다. 두 멤버가 함께 있거나 모두 없으면 잘못된 reply다. error는 정수 code와 비어 있지 않은 message를 가진다.
- 페이지는 [view command](native-surfaces.ko.md#view-표면)에 view가 답하듯 `sok-view`를 통해 `{sok: 1, reply: id, result}` 또는 `{sok: 1, reply: id, error: {code, message}}`로 요청에 답한다. 명령의 선언된 `timeout`이 대기를 한정하며, 한계 뒤의 reply는 늦은 reply로 버려진다.
- channel이 받는 페이지의 call은 main page가 답하는 [exposure](#exposure)의 등록 call과, 선언된 sidecar에 대해 main page가 답하는 sidecar call `runtime.sidecar.send`, `runtime.sidecar.on`, `runtime.sidecar.onFailure`([sidecars](sidecars.ko.md#plugin-host-sessions))와, 표시된 프로젝트에 대해 main page가 답하는 프로젝트 데이터 call `runtime.data.get`, `runtime.data.set`([프로젝트 데이터 호출](#프로젝트-데이터-호출))과, main page가 [오류 call](#오류-call)대로 답하는 오류 call `runtime.error`와, main page가 [명령 call](#명령-call)대로 답하는 명령 call `runtime.command`와, main page가 [로그 call](#로그-call)대로 답하는 로그 call `runtime.log`와, main page가 `page.exposure.register`와 같이 답하는 등록 통지 `runtime.native.call`(이름 `registered`, payload `{kind, name}`)과, main page가 등록된 dom 항목에 대해 답하는 구독 call `runtime.native.on`(event `exposure-request`, `declared-ui.expanded`)과 응답 call `runtime.native.call`(이름 `exposureReply`)과, host가 직접 답하는 [state](#state)의 call이다. main page는 host가 등록한 dom 항목의 `dom.*` 요청을 message event `exposure-request`(`data`가 `{id, method, params}`)로 host 페이지에 전달하고, host 페이지가 `runtime.native.call`로 보낸 `{name: "exposureReply", payload: {id, result}}` 또는 `{id, error}`를 그 요청의 답으로 받는다([exposure](exposure.ko.md#전달)). `declared-ui.expanded`는 선택된 declared status tree의 `{status, tree, path, expanded}` update를 source에 전달하며, source는 value를 갱신하고 snapshot을 publish한다([declared UI](declared-ui.ko.md#트리-키)). [snapshot](#declared-ui-snapshots)은 call이 아니라 페이지의 message다. host는 그 밖의 빈 문자열이 아닌 command의 call request에 직접 `{sok: 1, id, error: {code: -32000, message: "plugin host call <name> is not served"}}`로 답하고 아무것도 중계하지 않는다. plugin host에는 `tab.state` call이, region 동작이, clipboard나 link call이 없다. sidecar 전송은 매니페스트가 sidecar 의존마다 선언하고(`hostOperations`) 사이드카가 읽기 전용으로 선언한(`hostReadOperations`) 작업만 제공한다([plugins](plugins.ko.md#pluginjson), [sidecars](sidecars.ko.md#메시지)). 메인 페이지는 그 밖의 작업을 `plugin host <plugin>: operation <op> is not served`로 거절한다. host는 이 항목에 적은 call만 제공하고, 선언 status의 presentation, 여기 적은 call의 중계, [state](#state) call, [재시작](#restarts) 기록 말고는 로직을 갖지 않는다([plugin 프로세스](plugin-processes.ko.md#층-규칙)).
- theme은 view에 닿는 것과 같이 host 페이지에 닿는다. document-start script가 토큰을 담고, 각 later theme 변경은 각 ready message 뒤에 host message로 보내진다.
- project도 같은 방식으로 host 페이지에 닿는다. 각 later project 변경은 각 ready message 뒤에 host message `project`로 보내지고, 페이지는 `runtime.project(listener)`로 받는다. listener는 마지막 project를 바로 받으며, 페이지는 이를 위해 host에 call을 보내지 않는다.
- host가 web view를 만든 뒤 첫 ready message는 view의 첫 ready message가 `host.trace.view.process-ready`를 쓰듯 `host.trace.plugin-host.process-ready {plugin, window}`를 `debug` level로 쓴다.
- host가 plugin의 제거나 비활성화 또는 queue overflow로 그 plugin host web view를 처분하거나 host의 페이지 프로세스가 끝나면, host는 창의 main page에 event `plugin-host-ended {plugin}`을 보낸다. main page는 `plugin:<plugin id>` 아래의 모든 등록([exposure](#exposure))을 지우고, plugin host의 sidecar 구독을 지우며, view가 닫힐 때처럼 그 host에 대한 자신의 열린 요청을 모두 `surface-closed`로 끝낸다. host의 sidecar 세션은 [sidecars](sidecars.ko.md#plugin-host-sessions)가 정하는 대로 host가 닫는다. 창의 reload나 닫기는 event를 보내지 않는다. 등록을 가진 main page가 그와 함께 교체되거나 끝나기 때문이다.

## Exposure

plugin host 페이지는 자신이 선언한 status, command, dom 항목을 channel을 통해 등록한다. view 페이지가 쓰는 call, 즉 command의 `runtime.command.register`와 status와 dom 항목의 exposure 등록(`page.exposure.register(kind, name)`)으로 한다. plugin host의 모든 등록의 owner key는 `plugin:<plugin id>`다. surface 페이지는 자기 surface id 아래에 자기 plugin을 owner로 등록한다. plugin의 `exposes`가 선언하지 않는 이름은 registry 오류로 거부된다. plugin host의 등록은 자기 프로세스와 함께 끝나며, restart limit 안에서 다시 만들어진 프로세스는 같은 key로 다시 등록한다.

plugin host는 surface가 아니다. plugin host가 등록한 이름에 대한 `surface` 없는 요청은, 그 이름을 등록한 surface 페이지와 state module이 없을 때 그 등록이 답한다([choosing a surface](exposure.ko.md#표면-선택)). `surface`를 naming하는 요청은 plugin host가 답하지 않는다. plugin host는 `command.run`에 등록된 command를 선언된 시간 제한 안에서 channel로 실행해 답하고, `status.get`에는 그 status의 pull([declared UI snapshots](#declared-ui-snapshots))로 답하며 그 reply `{seq, value}`를 `{value, version: seq}`로 돌려준다. plugin host는 status를 declared UI snapshot으로 보내므로, plugin host만 답할 `status.watch`, `status.unwatch`, dom 요청은 `plugin host <plugin id> does not serve <method>`로 거부된다.

status.get의 exposure registry와 endpoint는 files.tree처럼 qualified status 이름을 사용한다. Workbench는 declared-ui.snapshot.request를 호출하기 전에 등록한 plugin id와 separator를 제거한다. status 매개변수는 snapshot store가 사용하는 plugin-local 이름(tree)이다. Qualified 이름을 두 번째 key로 시도하지 않는다.

## Declared UI snapshots

Native message callback은 이를 등록한 local host instance에 묶인다. Native message callback, host 생성 및 host dispose는 main thread에서 실행되므로 instance 확인과 동기 dispatch는 replacement와 직렬화된다. Dispose 뒤 해당 instance에서 늦게 온 callback은 같은 plugin의 host가 다시 만들어졌더라도 dispatch 전에 취소하며 performance tracing이 켜져 있으면 `host.trace.plugin-host.message-stale {plugin}`을 쓴다. retired provider의 명시적 오류는 plugin 식별자와 함께 기록하지만 replacement host를 종료하거나 다시 시작하지 않는다. Window record가 이미 제거된 뒤에도 Tauri host는 callback이 캡처한 plugin id로 명시적 provider 오류를 기록하며 일반 늦은 message는 취소한다.

native message callback은 callback을 설치한 local host instance에 묶인다. instance를 처분한 뒤 도착한 그 instance의 늦은 callback은 같은 plugin의 host가 다시 만들어졌더라도 dispatch 전에 취소되며, performance tracing 중에는 `host.trace.plugin-host.message-stale {plugin}`을 기록한다. 종료된 provider가 명시한 error는 그 plugin context로 기록하고 대체 host를 닫거나 재시작하지 않는다.

plugin host는 자신이 등록한 각 declared status의 [declared UI snapshot](declared-ui.ko.md)을 push하고 pull 요청에 답하며, view가 그러하듯 한다. snapshot은 plugin을 담고 surface를 담지 않는다. pull은 `declared-ui.snapshot.request` call이며 그 reply는 `{seq, value}`다([plugin 프로세스](plugin-processes.ko.md) 규칙 2). plugin host가 시작하거나 다시 시작할 때, 각 status의 첫 snapshot은 그 status의 전체 값이고, 다시 시작된 plugin host는 저장된 상태에서 자신의 값을 만든다([state](#state)). workbench는 이전 프로세스의 멈춘 snapshot과 대기 중인 acknowledgement를 버린다([plugin processes](plugin-processes.md) rule 2). state module만 등록하는 status에는 출처가 없고, host가 등록한 declared status는 새 host 프로세스가 다시 등록하고 전체 첫 snapshot을 push하여 다시 제공하며, 이는 [선언된 status](declared-ui.ko.md#선언된-status)의 전이를 따른다. plugin의 view가 그것을 등록하면 그 view가 출처가 된다([declared status](declared-ui.ko.md#선언된-status)).

## Restarts

plugin host의 restart limit은 표준 입력과 출력 sidecar의 한도다([sidecars](sidecars.ko.md#실패)). 실패 기록과 restart limit은 plugin별이다. 모든 창의 plugin host 페이지의 실패가 하나의 기록에 셈해지고, 한도의 멈춤은 모든 창의 host 페이지를 멈춘다. state call의 저장 상태는 plugin별 값 하나이며, 모든 창의 host 페이지가 그것을 읽고 쓴다. host는 각 실패의 시각, 즉 그 실패 event가 도착할 때의 시각으로 plugin host의 실패를 센다. timer는 running하지 않는다. 새 실패보다 300초 이전의 실패는 세지 않는다(sliding window). plugin host의 실패는 host가 자기 없애기(plugin의 제거와 사용 중지, 창을 다시 불러오는 plugin 변경, 창의 닫힘)으로 일으키지 않은 페이지 프로세스의 끝이나 channel의 queue-full 오류이다. 네 번째 실패가 셈해질 때, host는 `error: plugin host <plugin>: restart limit: 4 failures within 300 s`를 자기 log에 쓰고, event `host.plugin-host.restart-limit {plugin}`을 `error` level로 쓰고, 그 plugin host의 재시작을 멈춘다. 페이지 프로세스의 각 재시작은 event `host.plugin-host.restart {plugin, attempt}`를 `error` level로 쓰며, `attempt`는 마지막 reset 이후 그 plugin host의 재시작을 센다.

plugin host가 멈춘 동안 host는 어떤 요청으로도 그것을 다시 만들지 않는다. 그 등록은 제거되었고, 그 이름 중 하나에 대한 요청은 선언되었으나 등록되지 않은 이름의 오류를 돌려주며, 그것이 제공하던 declared section은 비어 있다. 멈춤은 그 자체로 실패 기록을 지우지 않는다.

plugin의 surface를 열어 보는 사람의 행동과 그 plugin을 사용하는 사람의 행동만이 멈춤을 지운다. plugin host가 멈춘 동안 plugin의 surface가 열릴 때, host는 [sidecars](sidecars.ko.md#실패)의 멈춘 사이드카를 지우듯 그 plugin host의 실패 기록을 지우고, event `host.trace.plugin-host.restart-reset {plugin}`을 `debug` level로 쓰고, 모든 창에서 plugin host를 다시 만든다. plugin host가 멈추지 않은 동안의 surface 열기는 아무것도 지우지 않고, 다른 plugin의 surface 생성도 아무것도 지우지 않는다. plugin의 surface를 여는 것과 그 사용은 같은 단계에서 그 `dependencies`에 적힌 사이드카의 멈춤도 지운다([sidecars](sidecars.ko.md#실패)). 두 기록은 이 트리거들을 공유한다. 사용은 같은 방식으로 plugin host를 모든 창에서 다시 만든다.

재시작은 마지막으로 저장된 값에서 상태를 복구한다([state](#state)). 저장되지 않은 상태는 잃어지며, 각 plugin은 자기 문서에 그것이 어느 상태인지 밝힌다.

## State

plugin host state는 plugin의 host 페이지가 자기 channel을 통해 저장하는 값이며, host는 페이지의 다음 시작을 위해 그것을 둔다.

- `host` 선언이 `state`를 naming하면 channel은 `state.write {value}`와 `state.read` call을 받으며, host가 직접 답하고 어느 페이지로도 보내지 않는다. `state.write`는 `value`가 없는 params와 compact JSON이 `maxBytes` byte를 넘는 값을 plugin과 크기를 naming하는 오류로 거부하고, 그 밖에는 plugin의 저장된 값을 대체하고 `null`을 돌려준다. `state.read`는 마지막 저장된 값 `{value}` 또는 저장된 것이 없을 때 `{value: null}`을 돌려준다. 페이지는 시작 때 자기 상태를 읽고 변할 때마다 저장하므로, 한도 안의 재시작이 그것을 복구한다.
- host는 마지막 저장된 값을 application이 끝나거나 plugin이 제거되거나 사용하지 않게 될 때까지 둔다. 값은 host 프로세스에 있으므로 plugin host 페이지의 재시작은 살아남지만 application의 끝은 살아남지 않는다.
- 저장된 값은 선언된 `format`을 담는다. 다른 format의 값을 읽는 페이지는 plugin과 발견된 format과 선언된 format을 naming하는 오류로 거부된다. 다른 format의 tab state가 거부되는 것과 같다([plugins](plugins.ko.md#메모리-절약)).
- `state` 필드가 없으면 두 call 모두 plugin을 naming하는 오류로 거부되고, 재시작은 저장된 상태 없이 페이지를 시작한다.

## 프로젝트 데이터 호출

plugin host는 두 channel call로 플러그인의 [프로젝트 데이터](plugins.ko.md#프로젝트-데이터)를 읽고 쓴다. 두 call은 메인 페이지가 창이 표시한 프로젝트에 대해 답한다.

- `runtime.data.get {key}`는 키의 값을 돌려준다. 저장된 값이나 기본값이다.
- `runtime.data.set {key, value}`는 키의 값을 저장하고, 저장소가 쓰기를 받은 뒤 `null`을 돌려준다.

검사는 [프로젝트 데이터](plugins.ko.md#프로젝트-데이터)의 검사와 같다. 키는 매니페스트의 `data` 필드에 선언되어야 하고, 값은 키의 스키마와 맞아야 하며, 선언된 format이 아닌 저장 값은 읽기에서 거부된다. 매니페스트가 선언하지 않은 키는 플러그인과 키를 naming하는 오류로 거부된다. 창이 프로젝트를 표시하지 않는 동안 두 call은 `plugin host <plugin>: no project is shown`으로 거부되며, 이는 같은 상태의 사이드카 전송과 같은 문구다. 거부는 페이지에 그 call의 오류로 돌아간다. 창은 표시 프로젝트가 바뀌어도 event를 보내지 않는다. 호스트 페이지는 다음 call에서 프로젝트 데이터를 다시 읽는다.

## 오류 call

host 페이지는 선언된 tree의 listing 오류를 call `runtime.error {where, text}`로 알린다. channel은 등록 call과 같이 이를 `plugin-host-call`로 main page에 중계하고, main page는 view call `runtime.error`([native surfaces](native-surfaces.ko.md#view-표면))의 검사로 답한다. `where`는 제어 문자와 `: `가 없는 빈 문자열이 아닌 문자열이어야 하고, `text`는 빈 문자열이 아닌 문자열이어야 한다. 그 밖의 값은 call의 오류로 거부되며 아무것도 쓰지 않는다. 받아들인 call은 main page의 오류 표시를 통해 `error plugin <plugin> <where>: <text>` 줄을 application log에 쓰고 `null`로 답한다. 선언된 tree는 이에 대해 오류를 그리지 않는다([declared UI](declared-ui.ko.md#요소-종류)).

## 명령 call

host 페이지는 call `runtime.command {name, params}`로 command를 실행한다. channel은 등록 call과 같이 이를 `plugin-host-call`로 main page에 중계하고, main page는 view call `runtime.command`([native surfaces](native-surfaces.ko.md#view-표면))의 검사와 답으로 답한다. `core.*` 이름은 `params`로 코어 command를 실행하고, plugin의 이름은 plugin host가 주인 key `plugin:<plugin id>`로 등록한 command를 실행하며([exposure](#exposure)), 그 밖의 이름은 view call의 오류로 거부하며, 그 오류 문장은 호출한 쪽을 `plugin host call`로 적는다(예: `plugin host call open names no owner`). `name`은 빈 문자열이 아닌 문자열이어야 하며, 그렇지 않으면 `plugin host call runtime.command requires a non-empty name`으로 거부되고 아무것도 실행하지 않는다. `params`가 없는 call은 `null`로 command를 실행한다. call은 command의 결과 또는 오류로 답한다. host 페이지는 이 call로 `core.file.open`을 통해 파일 같은 코어 surface를 연다.

## 로그 call

host 페이지는 call `runtime.log {level, event, fields, cids?}`로 자기 plugin의 event를 쓴다. channel은 등록 call과 같이 이를 `plugin-host-call`로 main page에 중계하고, main page는 view call `runtime.log`([native surfaces](native-surfaces.ko.md#view-표면))의 검사와 기록으로 답한다. `level`은 `error`, `warn`, `info`, `debug`, `trace` 중 하나여야 하며, 그 밖의 값은 `plugin host call runtime.log log level must be one of error, warn, info, debug, trace`로 거부한다. `event`, `fields`, `cids`는 plugin 문맥의 log가 검사한다([plugins](plugins.ko.md#logging)). 기록은 plugin 문맥의 log가 저장하듯 `plugin.<plugin>.<event>`로 page의 event writer를 거쳐 level gate와 함께 저장되며, gate에서 제외된 기록은 writer가 센다. plugin host에는 surface가 없으므로 기록에 surface id가 없고 plugin만 있다. 받아들인 call은 `null`로 답하고, 거부된 call은 검사의 오류로 답하며 아무것도 쓰지 않는다.
