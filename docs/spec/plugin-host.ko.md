# Plugin host

[English](plugin-host.md)

plugin host는 plugin의 프로세스로, 창에 붙는 platform web view에서 view나 sidecar가 담을 수 없는 DOM 없는 로직을 실행한다. 계약이 요구할 때만 존재한다. 열린 view가 없는 동안에도 sidebar section이 값을 보여야 하는 plugin은 자신의 plugin host가 필요하다. 선언된 status 출처([declared status](declared-ui.ko.md#선언된-status))는 활성 탭의 view가 첫째이고 plugin host가 둘째이기 때문이다. host는 그 로직을 sidecar나 view로 옮기는 것이 불가능할 때만 만든다.

plugin 코드는 workbench 페이지에서 실행되지 않으며, main page는 plugin host의 코드를 실행하지 않는다. host 페이지는 view surface의 view처럼 `sok://<plugin id>` origin의 별도 web view다([plugin processes](plugin-processes.md) rule 1). native host와 workbench가 이 명세를 구현하며, [feature status](../features.md)가 구현 상태를 기록한다.

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
- plugin의 plugin id. 페이지의 `sok://<plugin id>` origin과 core root 응답의 `Access-Control-Allow-Origin`을 정한다.
- `packages/plugin-api/view-start.js`의 텍스트를 담은 document-start user script. [view channel](native-surfaces.ko.md#view-표면) 스크립트다.
- theme 토큰을 담은 document-start user script.
- script message handler `sok-view`.
- plugin id로 key되는 plugin의 persistent website data store.

host는 `plugins/installed.json`이 그 plugin에 대해 기록한 폴더에서 `sok://<plugin id>/<page>`를 불러온다. view의 페이지를 불러오는 것과 같다. 페이지는 네 항목의 [view import map](plugins.ko.md#view-표면)을 선언하고 `checkViewPage`를 통과하며, [view bridge](plugins.ko.md#view-표면)를 import하고 `sok-view` handler로 `createViewChannel()`을 부른다.

web view는 surface host가 아니라 창에 붙는다. 그것은 surface가 아니다. `SurfaceHost`를, surface frame을, region을, presentation wait을 가지지 않는다. host는 그것을 숨겨 놓고 아무것도 보여주지 않는다. web view는 0 frame을 가지고, 보이지 않음으로 제출되고, 화면에 아무것도 그리지 않고, hit testing을 받지 않고, first responder가 되지 않는다. host 페이지는 입력을 받지 않고 shortcut table을 등록하지 않는다. `host.hit`은 그것을 보고하지 않는다.

## Lifetime

host는 창의 main page가 `host`를 선언하는 plugin을 불러올 때 그 plugin의 plugin host web view를 만든다. 그래서 plugin의 declared section이 plugin의 view가 열리기 전에 자기 출처를 가진다. host는 plugin이 제거되거나 사용하지 않게 되거나, plugin 변경의 적용이 창을 다시 불러오거나, 창이 닫힐 때 그 web view를 없앤다. host 페이지 프로세스는 자기 web view와 함께 끝나며 [restart limit](#restarts) 안에서 다시 만들어진다.

host 페이지는 surface context를 가지지 않는다. plugin의 동기 값(`icon(name)`, `origin`, `project`, `declarations`; 탭에 속하는 `params`는 없음)을 view 페이지처럼 받고, 비동기 동작은 view bridge로 걸으며, `contributions(point)`를 그 point의 연결된 항목으로 받는다.

## Channel

plugin host channel은 위의 web view 구성에 대한 [view channel](native-surfaces.ko.md#view-표면)이다. 같은 document-start script, 같은 `sok-view` handler, ready document를 만드는 문서 식별자를 담은 같은 ready message, 최대 256개의 message를 담는 같은 queue, host message의 같은 `sok: 1` 표지, `window.postMessage(message, location.origin)`를 통한 같은 전달, 표지 없는 message에 대한 같은 거부가 재사용된다. queue가 가득 찬 상태에서 도착한 message는 담기지 않는다. script는 `view.error` message로 `sok-view`를 통해 이유 `queue full for <plugin>`을 보고하고, host는 `error: plugin host channel: queue full for <plugin>`을 application log에 쓰며, host는 그 plugin host를 닫고 restart limit 안에서 다시 만든다. host message가 기록 없이 버려지는 일은 없다.

view와 다른 것은 상대와 call이다:

- 중계되는 모든 message는 plugin을 담고 surface를 담지 않는다. host 페이지는 surface를 가지지 않기 때문이다.
- host는 페이지의 call request `{sok: 1, id, command, params}`(`id`가 정수이고 `command`가 [exposure](#exposure)의 등록 call)를 창의 main page에 event `plugin-host-call {plugin, id, command, params}`로 보내고, cancel `{sok: 1, id, cancel: true}`를 `plugin-host-call {plugin, id, cancel: true}`로 보낸다. main page는 `pluginHostReply {plugin, id, result}` 또는 `pluginHostReply {plugin, id, error: {code, message}}`로 답하고, host는 `{sok: 1, id, result}` 또는 `{sok: 1, id, error}`를 ready document에 보낸다. 다른 잘못된 필드를 가진 message는 `error: plugin host channel: <reason>`으로 application log에 쓰이고 중계되지 않는다.
- 페이지는 [view command](native-surfaces.ko.md#view-표면)에 view가 답하듯 `sok-view`를 통해 `{sok: 1, reply: id, result}` 또는 `{sok: 1, reply: id, error: {code, message}}`로 요청에 답한다. 명령의 선언된 `timeout`이 대기를 한정하며, 한계 뒤의 reply는 늦은 reply로 버려진다.
- channel이 받는 페이지의 call은 main page가 답하는 [exposure](#exposure)의 등록 call과 host가 직접 답하는 [state](#state)의 call이다. [snapshot](#declared-ui-snapshots)은 call이 아니라 페이지의 message다. host는 그 밖의 빈 문자열이 아닌 command의 call request에 직접 `{sok: 1, id, error: {code: -32000, message: "plugin host call <name> is not served"}}`로 답하고 아무것도 중계하지 않는다. plugin host에는 `tab.state` call이, region 동작이, sidecar 전송이, clipboard나 link call이 없다. 그것들이 필요한 로직은 plugin host가 아니라 view나 sidecar에 속한다.
- theme은 view에 닿는 것과 같이 host 페이지에 닿는다. document-start script가 토큰을 담고, 각 later theme 변경은 각 ready message 뒤에 host message로 보내진다.
- host가 web view를 만든 뒤 첫 ready message는 view의 첫 ready message가 `host.trace.view.process-ready`를 쓰듯 `host.trace.plugin-host.process-ready {plugin, window}`를 `debug` level로 쓴다.
- host가 plugin의 제거나 비활성화 또는 queue overflow로 그 plugin host web view를 처분하거나 host의 페이지 프로세스가 끝나면, host는 창의 main page에 event `plugin-host-ended {plugin}`을 보낸다. main page는 `plugin:<plugin id>` 아래의 모든 등록([exposure](#exposure))을 지우고, view가 닫힐 때처럼 그 host에 대한 자신의 열린 요청을 모두 `surface-closed`로 끝낸다. 창의 reload나 닫기는 event를 보내지 않는다. 등록을 가진 main page가 그와 함께 교체되거나 끝나기 때문이다.

## Exposure

plugin host 페이지는 자신이 선언한 status, command, dom 항목을 channel을 통해 등록한다. view 페이지가 쓰는 call, 즉 command의 `runtime.command.register`와 status와 dom 항목의 exposure 등록(`page.exposure.register(kind, name)`)으로 한다. plugin host의 모든 등록의 owner key는 `plugin:<plugin id>`다. surface 페이지는 자기 surface id 아래에 자기 plugin을 owner로 등록한다. plugin의 `exposes`가 선언하지 않는 이름은 registry 오류로 거부된다. plugin host의 등록은 자기 프로세스와 함께 끝나며, restart limit 안에서 다시 만들어진 프로세스는 같은 key로 다시 등록한다.

plugin host는 surface가 아니다. plugin host가 등록한 이름에 대한 `surface` 없는 요청은, 그 이름을 등록한 surface 페이지와 state module이 없을 때 그 등록이 답한다([choosing a surface](exposure.ko.md#표면-선택)). `surface`를 naming하는 요청은 plugin host가 답하지 않는다. plugin host는 `command.run`에 등록된 command를 선언된 시간 제한 안에서 channel로 실행해 답하고, `status.get`에는 그 status의 pull([declared UI snapshots](#declared-ui-snapshots))로 답하며 그 reply `{seq, value}`를 `{value, version: seq}`로 돌려준다. plugin host는 status를 declared UI snapshot으로 보내므로, plugin host만 답할 `status.watch`, `status.unwatch`, dom 요청은 `plugin host <plugin id> does not serve <method>`로 거부된다.

## Declared UI snapshots

plugin host는 자신이 등록한 각 declared status의 [declared UI snapshot](declared-ui.ko.md)을 push하고 pull 요청에 답하며, view가 그러하듯 한다. snapshot은 plugin을 담고 surface를 담지 않는다. pull은 `declared-ui.snapshot.request` call이며 그 reply는 `{seq, value}`다([plugin 프로세스](plugin-processes.ko.md) 규칙 2). plugin host가 시작하거나 다시 시작할 때, 각 status의 첫 snapshot은 그 status의 전체 값이고, 다시 시작된 plugin host는 저장된 상태에서 자신의 값을 만든다([state](#state)). workbench는 이전 프로세스의 멈춘 snapshot과 대기 중인 acknowledgement를 버린다([plugin processes](plugin-processes.md) rule 2). state module만 등록하는 status에는 출처가 없고, host가 등록한 declared status는 새 host 프로세스가 다시 등록하고 전체 첫 snapshot을 push하여 다시 제공하며, 이는 [선언된 status](declared-ui.ko.md#선언된-status)의 전이를 따른다. plugin의 view가 그것을 등록하면 그 view가 출처가 된다([declared status](declared-ui.ko.md#선언된-status)).

## Restarts

plugin host의 restart limit은 표준 입력과 출력 sidecar의 한도다([sidecars](sidecars.ko.md#실패)). 실패 기록과 restart limit은 plugin별이다. 모든 창의 plugin host 페이지의 실패가 하나의 기록에 셈해지고, 한도의 멈춤은 모든 창의 host 페이지를 멈춘다. state call의 저장 상태는 plugin별 값 하나이며, 모든 창의 host 페이지가 그것을 읽고 쓴다. host는 각 실패의 시각, 즉 그 실패 event가 도착할 때의 시각으로 plugin host의 실패를 센다. timer는 running하지 않는다. 새 실패보다 300초 이전의 실패는 세지 않는다(sliding window). plugin host의 실패는 host가 자기 없애기(plugin의 제거와 사용 중지, 창을 다시 불러오는 plugin 변경, 창의 닫힘)으로 일으키지 않은 페이지 프로세스의 끝이나 channel의 queue-full 오류이다. 네 번째 실패가 셈해질 때, host는 `error: plugin host <plugin>: restart limit: 4 failures within 300 s`를 자기 log에 쓰고, event `host.plugin-host.restart-limit {plugin}`을 `error` level로 쓰고, 그 plugin host의 재시작을 멈춘다. 페이지 프로세스의 각 재시작은 event `host.plugin-host.restart {plugin, attempt}`를 `error` level로 쓰며, `attempt`는 마지막 reset 이후 그 plugin host의 재시작을 센다.

plugin host가 멈춘 동안 host는 어떤 요청으로도 그것을 다시 만들지 않는다. 그 등록은 제거되었고, 그 이름 중 하나에 대한 요청은 선언되었으나 등록되지 않은 이름의 오류를 돌려주며, 그것이 제공하던 declared section은 비어 있다. 멈춤은 그 자체로 실패 기록을 지우지 않는다.

plugin의 surface를 열어 보는 사람의 행동만이 멈춤을 지운다. plugin host가 멈춘 동안 plugin의 surface가 열릴 때, host는 [sidecars](sidecars.ko.md#실패)의 멈춘 사이드카를 지우듯 그 plugin host의 실패 기록을 지우고, event `host.trace.plugin-host.restart-reset {plugin}`을 `debug` level로 쓰고, 모든 창에서 plugin host를 다시 만든다. plugin host가 멈추지 않은 동안의 surface 열기는 아무것도 지우지 않고, 다른 plugin의 surface 생성도 아무것도 지우지 않는다.

재시작은 마지막으로 저장된 값에서 상태를 복구한다([state](#state)). 저장되지 않은 상태는 잃어지며, 각 plugin은 자기 문서에 그것이 어느 상태인지 밝힌다.

## State

plugin host state는 plugin의 host 페이지가 자기 channel을 통해 저장하는 값이며, host는 페이지의 다음 시작을 위해 그것을 둔다.

- `host` 선언이 `state`를 naming하면 channel은 `state.write {value}`와 `state.read` call을 받으며, host가 직접 답하고 어느 페이지로도 보내지 않는다. `state.write`는 `value`가 없는 params와 compact JSON이 `maxBytes` byte를 넘는 값을 plugin과 크기를 naming하는 오류로 거부하고, 그 밖에는 plugin의 저장된 값을 대체하고 `null`을 돌려준다. `state.read`는 마지막 저장된 값 `{value}` 또는 저장된 것이 없을 때 `{value: null}`을 돌려준다. 페이지는 시작 때 자기 상태를 읽고 변할 때마다 저장하므로, 한도 안의 재시작이 그것을 복구한다.
- host는 마지막 저장된 값을 application이 끝나거나 plugin이 제거되거나 사용하지 않게 될 때까지 둔다. 값은 host 프로세스에 있으므로 plugin host 페이지의 재시작은 살아남지만 application의 끝은 살아남지 않는다.
- 저장된 값은 선언된 `format`을 담는다. 다른 format의 값을 읽는 페이지는 plugin과 발견된 format과 선언된 format을 naming하는 오류로 거부된다. 다른 format의 tab state가 거부되는 것과 같다([plugins](plugins.ko.md#메모리-절약)).
- `state` 필드가 없으면 두 call 모두 plugin을 naming하는 오류로 거부되고, 재시작은 저장된 상태 없이 페이지를 시작한다.
