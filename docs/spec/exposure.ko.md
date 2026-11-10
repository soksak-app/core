# 노출: status, command, element

[English](exposure.md)

코어, 플러그인 API, 셸·브라우저 플러그인, macOS 호스트가 이 명세를 구현하며 [기능 상태](../features.ko.md)가 검증 결과를 기록한다.

코어(워크벤치와 네이티브 호스트)는 선언된 상태 값, 명령, 요소를 [로컬 엔드포인트](endpoint.ko.md)로 외부 클라이언트에 공개한다. 임의 코드를 실행하는 메서드는 없다.

## 선언

공개 작업이 만든 artifact의 소유권도 status 관찰로 전달한다. Debug 열기는 host가 실제 만든 정지 PNG 경로를 `core.debug.captures`로 공개하며 page와 native workbench가 같은 기록·초기화 계약을 따른다([debug](debug.ko.md)). 자동화는 private 파일로 경로를 추측하거나 실패 증거 감사를 끄는 대신 선언된 capture 디렉터리를 recording 생명주기에 등록한다.

플러그인은 `plugin.json`의 `exposes`에 항목을 선언한다([플러그인](plugins.ko.md)). 코어는 같은 형식으로 `packages/workbench/exposure.json`에 항목을 선언한다.

```json
{
  "exposes": {
    "status": [],
    "commands": [],
    "element": []
  }
}
```

선언되지 않은 이름의 등록은 실패한다. 선언되었지만 등록되지 않은 이름을 요청하면 오류를 반환한다.

### 이름

이름의 형식은 `<소유자>.<이름>`이다. 소유자는 `core`, `host`, 또는 플러그인 id다. 이름에는 소문자, 숫자, 점, 하이픈을 사용한다.

### 항목 필드

| 종류 | 필드 | 의미 |
| --- | --- | --- |
| status | `name` | 항목 이름 |
| status | `description` | 한 문장 설명 |
| status | `schema` | 값 스키마 |
| command | `name` | 항목 이름 |
| command | `description` | 한 문장 설명 |
| command | `params` | 매개변수 스키마 |
| command | `result` | 결과 스키마 |
| command | `timeout` | 명령 선언의 member가 아니다. manifest 검사와 registry는 그것을 가진 선언을 `<where>: timeout is not a member of a command declaration`로 거절한다. 명령에는 시간 제한이 없다. 명령은 그 답, 동기든 비동기든 예외를 던진 handler(자기 오류로), 또는 상대의 끝으로 끝난다. 상대의 끝은 그것을 실행하는 문서의 닫기, 그 페이지 WebContent 프로세스의 끝이나 다시 읽기, 그것이 기다리는 plugin 프로세스나 sidecar의 끝, 그것을 보낸 endpoint 연결의 끝이다([플러그인 프로세스](plugin-processes.ko.md) 규칙 3). 살아 있으면서 답하지 않는 handler는 아무 이벤트도 보내지 않으므로 그 호출은 열린 채 남고, `core.plugin.open-calls`가 그것을 알린다. core 명령은 그 뒤 배치 표시를 기다리며, 표시 경로의 각 단계는 자기 이벤트로 끝난다([네이티브 호스트](native-host.ko.md)) |
| element | `name` | 항목 이름 |
| element | `description` | 한 문장 설명 |
| element | `many` | 선택. 여러 요소가 같은 이름을 쓰면 `true`이며, 요청은 `index`로 요소 하나를 지정한다 |

스키마는 `type`, `properties`, `items`, `enum` 키워드만 쓰는 JSON Schema 부분집합이다. `type`은 `string`, `number`, `integer`, `boolean`, `object`, `array`, `null` 이름 가운데 하나이거나 그 이름들의 비어 있지 않은 목록이며, 그 밖의 값은 거부한다. `null`과 목록 안의 목록도 거부한다. `enum`은 비어 있지 않은 목록이고, 값은 같은 JSON 값일 때 항목과 일치하며, 객체의 member는 순서와 무관하게 비교한다.

element 항목의 요소는 `data-expose="<이름>"` 속성을 가지며, 그 이름이 element 이름이다. `many`가 없으면 그 이름을 가진 요소는 정확히 하나다. `exposes.dom`을 선언한 플러그인 manifest는 `plugin <id>: exposes.dom is removed; an exposed element is declared in exposes.element`로 거부한다.

## 사용자 인터페이스

사람과 외부 클라이언트는 같은 항목으로 문서를 조작한다.

- 문서의 모든 사용자 조작은 선언된 명령을 실행한다. 컨트롤은 `data-command="<이름>"`으로 명령을 가리키고, 고정 매개변수는 `data-params`에 JSON 객체로 적는다. 값을 입력하는 컨트롤은 그 값을 `data-value`가 가리키는 매개변수 이름(기본 `value`)으로 더한다. 명령을 먼저 선언하고(`exposure.json`, `plugin.json`), 문서는 `@soksak/plugin-api`의 `createBinder(run)`으로 선언된 명령에만 요소를 연결한다. `bind(요소, 이름, 매개변수, {event, when, stop, failed})`는 이벤트에서 명령을 실행하고, `mark(요소, 이름, 매개변수, 값 이름)`은 속성을 붙이며, `delegate(루트)`는 `bind`가 연결하지 않은 표시된 하위 요소의 누름과 값 변경을 실행한다. `bind`로 연결한 요소는 자기 이벤트에서만 명령을 실행하므로, Enter에 연결한 텍스트 필드는 같은 Enter가 일으키는 `change`에서 명령을 다시 실행하지 않는다. 선언되지 않은 이름을 연결하거나 표시하면 예외를 던진다. 워크벤치는 `packages/workbench/commands.js`(등록소 위의 연결기)를, 플러그인 페이지는 페이지가 등록한 명령을 실행하는 `expose.bind`, `expose.mark`, `expose.delegate`를 쓴다. 처리기는 모듈 함수를 직접 부르지 않는다. 탭 드래그 같은 연속 조작은 결과를 만드는 명령(`core.tab.move`)을 가지며, 키보드 단축키도 명령을 실행한다. `bind`의 `params`가 함수이면 실행마다 이벤트를 받아 그 실행의 매개변수가 되며, 그 요소에는 `data-params`가 없으므로 `mark`는 아무것도 쓰지 않는다.
- 문서에 보이는 모든 상태는 status로 읽을 수 있다.
- 모든 조작 요소(`button`, `input`, `select`, `textarea`, `role="button"`, `contenteditable`)는 명령에 연결되고(직접 연결되거나, 위임한 루트 안에서 `data-command`를 가짐) element 이름을 가진다.
- 다시 그리기는 문서에 남는 모든 컨트롤을 제자리에 두고, 순서가 틀린 컨트롤만 옮긴다. WebKit은 누름과 뗌 사이에 요소가 문서에서 빠진 누름에 `click`을 보내지 않고, `insertBefore`로 요소를 옮기면 요소가 먼저 문서에서 빠지므로, 컨트롤을 옮긴 다시 그리기는 그동안 누른 click을 잃었다. plugin page는 key마다 요소를 제자리에 두는 `@soksak/plugin-api`의 `drawList`로 컨트롤 목록을 그린다.
- 네이티브 모달은 요소의 사본을 그리고 컨트롤의 key로 답한다. 워크벤치는 자기 요소에서 그 컨트롤을 찾아 명령을 실행한다.

충족 여부는 실행 중인 문서에서 판단한다. 보이는 view 표면의 page가 `core.surface.document`를 노출하지 않으면 audit이 실패한다. view는 별도의 문서이므로 audit이 그렇지 않으면 그 조작을 판단할 수 없기 때문이다. 연결기의 `audit(루트)`는 연결되지 않았거나 element 이름이 없는 조작 요소를 `{role, expose, command, text}`로 나열한다. `role`은 요소의 ARIA role이다: `role` 속성의 첫 token, 없으면 tag와 input type의 implicit role(`button`, `textbox`, `combobox`, `listbox`, `checkbox`, `radio`, `slider`, `spinbutton`, `searchbox`), `contenteditable` 요소는 `textbox`, role이 없는 input type은 `null`이다. 워크벤치는 이를 `core.workbench.audit`로, 모든 view surface document는 `core.surface.document`의 `unbound`로 공개한다. `e2e/audit.test.mjs`가 두 앱의 모든 화면, 모달 구역, 메뉴, 편집 상태, 보이는 플러그인 표면을 방문해 빈 목록을 요구한다. `scripts/check-exposure.mjs`(`make check-exposure`)는 `@soksak/plugin-api`의 `exposure-check.js`로 워크벤치 소스가 적은 것만 검사한다. 소스에 적은 이름은 모두 선언되고, 선언한 status와 명령은 등록되며, 선언한 element 이름은 공개 값으로 적혀 있다. view는 코어 status와 자기 plugin의 섹션 id를 적을 수 있고([섹션](plugins.ko.md#섹션)), 자기 plugin의 명령을 view bridge의 `commands.register`로 등록하며, `runtime.command`로 코어 명령이나 자기 plugin이 선언한 명령을 실행한다([view 표면](native-surfaces.ko.md#view-표면)). 코어 이름은 코어가 선언해야 한다. registry의 listed core 검사([registry](registry.ko.md))가 같은 module을 각 plugin release에 실행하며, 이 module은 package의 `core-exposure.json`에서 코어 이름을 읽는다. 그 파일이 워크벤치 선언과 다르면 `make check-exposure`가 실패하고, `node scripts/check-exposure.mjs --write`가 그 파일을 쓴다.

## 키보드 단축키

워크벤치의 모든 키보드 단축키는 소유자 하나와 명령 하나를 가진다. 기계가 읽는 표는 [shortcuts.json](../../packages/workbench/shortcuts.json)(`packages/workbench/shortcuts.json`)이며, 아래 표는 그 사본이다. `scripts/test/shortcut-table.test.mjs`는 두 표가 일치하는지, [애플리케이션 메뉴](host-contract.ko.md#애플리케이션-메뉴)의 모든 키 동등물이 `native menu` 행인지, 워크벤치 키 처리기의 모든 키 비교에 `workbench` 또는 `view` 행이 있는지 요구한다. 소유자는 [플러그인 프로세스](plugin-processes.ko.md)의 7번 규칙을 따른다.

- `native menu`: 애플리케이션 메뉴 항목의 키 동등물. 메뉴가 view보다 먼저 키를 받으므로 view의 기본 동작을 막지 않는다. 코어 명령이 있는 행은 메뉴를 거쳐 그 명령에 닿고, `framework role`인 행은 항목의 role을 실행한다.
- `workbench`: 워크벤치 page 또는 그 네이티브 modal이 처리하고 기본 동작을 막는 키. 행은 그 키가 실행하는 명령을 적는다.
- `view`: view가 자기 안에서 처리하는 키, 또는 view가 넘기는 키에 대해 `runtime.command`로 실행하는 workbench 명령([plugin 프로세스](plugin-processes.ko.md) 규칙 7). view 행은 명령을 적지 않는다. view가 동기로 정하므로 바인딩이 아니라 규칙이다.

키에서 `cmd`는 macOS에서 Command 키, 다른 host에서 Control 키다(`CmdOrCtrl`). `Enter`와 `Escape`는 키 이름이다.

view는 넘길 수 있는 행을 view call `runtime.shortcuts.read`로 읽는다. 주인이 `workbench` 또는 `view`인 행이다([native surface](native-surfaces.ko.md#view-표면), 입력). view는 표를 등록하지 않는다.

| 키 | 소유자 | 명령 | 메뉴 항목 | 조건 |
|---|---|---|---|---|
| `cmd+h` | native menu | framework role | app/hide | 모든 포커스 |
| `opt+cmd+h` | native menu | framework role | app/hide-others | 모든 포커스 |
| `cmd+q` | native menu | framework role | app/quit | 모든 포커스 |
| `cmd+,` | native menu | core.settings.open | app/settings | 모든 포커스 |
| `cmd+w` | native menu | framework role | file/close-window | 모든 포커스 |
| `cmd+z` | native menu | framework role | edit/undo | 모든 포커스 |
| `shift+cmd+z` | native menu | framework role | edit/redo | 모든 포커스 |
| `cmd+x` | native menu | framework role | edit/cut | 모든 포커스 |
| `cmd+c` | native menu | framework role | edit/copy | 모든 포커스 |
| `cmd+v` | native menu | framework role | edit/paste | 모든 포커스 |
| `cmd+a` | native menu | framework role | edit/select-all | 모든 포커스 |
| `cmd+=` | native menu | core.text.larger | view/text-larger | 모든 포커스 |
| `cmd+-` | native menu | core.text.smaller | view/text-smaller | 모든 포커스 |
| `cmd+0` | native menu | core.text.reset | view/text-default | 모든 포커스 |
| `shift+cmd+n` | native menu | core.window.new | window/new-window | 모든 포커스 |
| `shift+cmd+n` | workbench | core.window.new | — | host 크롬이 없음(브라우저 빌드) |
| `cmd+k` | workbench | core.library.search.focus | — | 라이브러리가 보임 |
| `Enter` | workbench | core.rename.commit | — | 탭 이름 변경 필드에 포커스가 있음 |
| `Escape` | workbench | core.rename.cancel | — | 탭 이름 변경 필드에 포커스가 있음 |
| `Enter` | workbench | core.library.form.submit | — | 라이브러리 양식 필드에 포커스가 있음 |
| `Escape` | workbench | core.picker.close | — | 선택 layer가 열려 있음 |
| `Escape` | workbench | core.modal.dismiss | — | 네이티브 modal 메뉴가 열려 있고 키보드 포커스가 있음 |
| `Escape` | view | none | — | 플러그인 view가 키보드 포커스를 가짐. view가 키를 직접 처리하며, 넘길 때만 열린 picker의 Escape 명령을 실행한다 |
| `text input keys` | view | none | — | 플러그인 view의 텍스트 입력에 포커스가 있음. view가 키를 직접 처리하며 기본 동작을 유지한다 |

네이티브 modal 메뉴는 mode가 `menu`인 modal web view이며([네이티브 modal](native-modals.ko.md)), Wails host와 Tauri host만 만든다. mygo workbench는 picker를 직접 그리고 키보드를 유지하므로, 그 host에서는 열린 picker의 Escape와 바깥 press가 registry를 거쳐 `core.picker.close`를 실행하고, `core.modal.dismiss`는 키의 답이 아니다.

`core.library.search.focus`는 인자 없이 현재 표시된 library page의 검색 필드에 focus한다. Projects page에서는 `core.library.search`, plugins page에서는 `core.library.plugins.search`를 선택한다. Library가 표시되지 않으면 명시적으로 거부하며 library를 열거나 page를 바꾸지 않는다. Main-page keyboard handler와 전달된 shortcut command는 같은 동작을 사용한다. `core.focus.set`은 이름으로 노출 DOM을 선택하는 일반 명령으로 유지한다.

## 키보드 포커스

status `core.focus`는 창의 first responder를 가진 문서에서 키보드 포커스를 가진 exposed element를 `{name, index, surface}`나 `null`로 알린다. 호스트는 각 창의 first responder를 `firstResponder`의 key-value observing으로 관찰하고, 워크벤치가 ready를 알릴 때와 그 뒤 바뀔 때마다 워크벤치에 창 event `window-responder {owner, surface, document}`를 보낸다. `owner`, `surface`, `document`는 `host.window`의 `responder`와 같은 값이다. ready를 알리지 않은 워크벤치는 event를 받지 않는다. 그 ready가 현재 값을 보내기 때문이다. view surface는 자기 문서를 가진다. 그 bridge는 문서의 포커스가 움직일 때마다 포커스를 가진 exposed element를 읽고, 값이 바뀌면 view call `tab.focus`로 `{name, index}`나 `null`을 알린다. 워크벤치는 다른 값을 `view call tab.focus requires {name, index} or null, not <value>`로 거부하고, view 문서가 끝나거나 surface가 닫히면 그 값을 잊는다. 워크벤치는 둘을 합친다:

| first responder의 `owner` | `core.focus` |
|---|---|
| `workbench` | 워크벤치(shadow root 안의 surface module 포함)에서 포커스를 가진 exposed element. `surface`는 shadow root의 surface이거나 `null`이다 |
| `surface` | `surface`의 view가 `tab.focus`로 마지막에 알린 값과 그 `surface`. 알린 것이 없으면 `null` |
| `document`, `modal`, `webview`, `native` | `null`. document region, native modal, 등록되지 않은 web view, native view는 exposed focus를 알리지 않는다 |

### 키보드는 focus ring을 따른다

창이 key이고 modal이 열려 있지 않은 동안 focus ring이 있는 card의 active surface가 키보드를 가지며, 둘은 어긋나지 않는다. ring을 옮기거나 그 card의 active surface를 바꾸는 모든 경로는 키보드도 옮긴다. 새 탭, 탭 press, `core.tab.select`, `core.card.focus`, 탭이나 card 닫기, 프로젝트 열기, space 복원이 여기에 든다. 각 워크벤치는 ring을 한 함수에서 옮기고, 하나의 host call `surfaceFocus {surface}`([surface의 키보드](native-surfaces.ko.md#surface의-키보드))를 보낸다. 앞선 placement가 호스트에 준 surface는 보이든 숨겨졌든 그것을 보여 주는 placement보다 먼저 호출을 보낸다. 그래서 호스트는 ring을 옮긴 press의 release에서 키보드를 주고, release 뒤의 키는 surface에 닿는다. 호스트가 아직 갖지 않은 surface는 그것을 보여 주는 placement 뒤에 호출을 받아, 준비되는 때에 키보드를 받는다. ring을 옮긴 명령은 그 이동을 보여 주는 placement와, 그 뒤 키보드 호출에 대한 호스트의 응답이 끝난 뒤에 답한다. 그래서 호출자가 응답 뒤에 보낸 키는 surface에 닿는다. surface가 키보드를 가져야 하는 동안 first responder가 워크벤치에 오면 surface로 돌아간다. 워크벤치 위 left press의 release는 각각 워크벤치에 decided 호출 `surfaceFocus {surface, decided: true}`를 요청하고, 워크벤치는 press의 handler들이 실행된 뒤, page는 그 release를 dispatch하는 턴에, mygo 워크벤치는 click을 실행하는 pass에, press가 바꾼 것을 반영해 그 호출을 보낸다. 대상이 그대로이거나 워크벤치가 키보드를 가질 때도 보낸다([surface의 키보드](native-surfaces.ko.md#surface의-키보드)). 빈 곳, scroll bar, divider 등 워크벤치의 어떤 element에 대한 press도 press로 센다. 반면 surface가 담지 않는 app의 child web view, 곧 native modal 문서 위의 press는 press로 세지 않는다. 그 문서는 키보드 결정에 응답하지 않으므로 그 release는 결정을 요청하지 않고 어떤 키도 기다리지 않는다.

- modal이 열려 있는 동안 키보드는 modal에 머물고, modal이 닫히면 surface로 돌아간다.
- surface가 없는 card(빈 card, 설치되지 않은 플러그인의 placeholder)와 library는 키보드를 워크벤치에 둔다(`surface: null`).
- 워크벤치의 편집 가능한 element(library 양식 필드, 이름 변경 필드)는 포커스가 있는 동안 키보드를 가진다. [키보드 단축키](#키보드-단축키)에서 그 필드를 조건으로 하는 단축키가 이를 요구하기 때문이다. 필드가 포커스를 잃거나 닫히면 키보드는 surface로 돌아간다.
- 탭 pointer press는 element focus를 남기지 않는다. `Tab` 키는 여전히 탭에 멈추고, 키보드가 워크벤치에 있는 동안 그 멈춤을 유지한다.
- 사용자가 press한 sidebar의 section view는 키보드를 유지한다. ring이 그 위에 있지 않기 때문이다.

첫 `window-responder` event 전과 호스트가 없는 runtime에서는 워크벤치가 포커스를 가진다. member가 문자열이나 `null`인 `{owner, surface, document}`가 아닌 `window-responder` event는 `error: window responder: invalid window-responder event <value>`로 알린다.

## 워크벤치 status

워크벤치 선언의 각 status와 명령은 페이지가 아니라 창의 워크벤치에 대해 정의된다. 위치는 창 point로 주고, plane 좌표의 위치는 plane 좌표로 남는다. Wails와 Tauri 호스트에서는 메인 페이지가 워크벤치를 그리고, mygo 호스트는 native UI로 그린다. 목록의 워크벤치 순서는 워크벤치의 element tree에서 그 요소들이 놓인 순서이며, Wails와 Tauri 호스트에서는 메인 페이지의 문서 순서다.

| Status | 값 |
| --- | --- |
| `core.window.workbench` | `{start, startedAt, readyState, visibility, scheme, background, scale, width, height}`. `start`는 워크벤치의 시작 하나를 식별하고 `startedAt`은 그 시작 시각을 epoch 이후 millisecond로 나타낸다. Wails와 Tauri 호스트에서는 메인 페이지의 page identity와 time origin이고, mygo 호스트에서는 워크벤치를 만들 때마다 새 값이다. `readyState`는 `loading`, `interactive`, `complete` 중 하나이며, mygo 호스트는 워크벤치의 첫 표시 프레임 전까지 `loading`, 그 뒤 `complete`를 알린다. `visibility`는 창이 최소화되었거나 보이지 않는 동안 `hidden`, 그 밖에는 `visible`이다. `scheme`은 워크벤치의 color scheme(`dark` 또는 `light`)이다. `background`는 열린 모달의 배경 blur로 워크벤치를 그리는지 알린다. `scale`은 창의 backing scale이다. `width`와 `height`는 창 콘텐츠 크기를 point로 나타낸다 |
| `core.workbench.error` | 워크벤치가 보이는 오류 문장, 또는 `null`. 표시는 오류의 출처를 기록한다. 처음 성공한 배치는 모든 surface가 present 된 뒤 직전 배치의 실패를 거두고, 다른 출처의 오류는 남으며, 오류의 기록은 log에 남는다. 그 present 기다림이 실패하면 아무것도 거두지 않고, 다음에 성공한 배치가 다시 묻는다. 타이머로 다시 묻지 않는다 |
| `core.workbench.audit` | `{unbound}`: audit이 나열한 워크벤치의 조작 요소([사용자 인터페이스](#사용자-인터페이스)) |
| `core.pointer` | `{sequence, down, up, pressedConnected, click}`: workbench가 받은 마지막 pointer sequence다. press는 `sequence`를 늘리고 나머지 member를 새로 시작한다. `down`, `up`, `click`은 대상을 가리킨다. 대상을 둘러싼 가장 가까운 exposed element의 이름이고, 없으면 tag다. Wails와 Tauri host에서 대상은 page의 element이고 tag는 tag name이다. mygo host에는 tag가 없다. 대상은 마지막 frame의 element tree에서 pointer 위치의 가장 안쪽 element이고, tag는 그 ARIA role이며, tree의 어떤 element도 없는 자리는 `unknown`이고 `pressedConnected`는 `null`이다. 빈 자리에는 document와 workbench 모두 이름을 선언하지 않는다. tab 옆의 space 줄, plane의 여백, control 옆의 library 하단 줄은 여기서 `unknown`이고 page에서는 일반 tag이며, library 본문은 여기서 scroll 영역의 role `region`이고 page에서는 일반 tag다. release는 press와 release를 둘러싼 가장 가까운 element를 click하고, primary button만 click하며, press한 element가 release 전에 workbench를 떠나면 click이 없다. 버튼을 누르는 key나 assistive technology action은 press 없이 `click`을 기록한다. sequence는 workbench와 그것이 그리는 overlay를 다룬다. native view와 native modal은 별개의 document다. 이 값은 관찰을 식별할 뿐 판정에 쓰지 않는다 |

mygo host에서는 워크벤치의 step이 native window가 닫힌 뒤에 실행될 수 있다. 그런 step의 `core.verify`와 `core.window.workbench` read는 native code를 부르지 않고 워크벤치 오류도 표시하지 않는다. 그 밖의 read 실패는 `core.workbench.error`로 표시한다.

`host.window.reload`는 창의 워크벤치를 다시 시작하고, `plugins-changed`를 받거나 `core.plugins.apply`를 실행한 창도 같은 방식으로 다시 시작한다([설치](installation.ko.md#변경-적용)). 워크벤치의 새 시작을 기다리는 window check와 측정 대상은 새 page process가 아니라 `core.window.workbench`의 새 `start`를 기다린다.

## 등록

워크벤치는 코어 항목을 자기 등록소에 등록한다. 플러그인 표면 페이지는 `@soksak/plugin-api/page`로 항목을 등록한다. 코어 명령은 handler가 시작한 비동기 작업까지 handler가 끝나고, 판이 가장 새 배치를 그린 뒤 답한다. 배치를 바꾸는 명령 뒤에 배치를 읽는 쪽은 그려진 배치를 읽는다. mygo 호스트는 워크벤치를 native 로 그린다. 실행 중에 frame 을 요청한 명령은, focus ring 의 이동을 포함해, 다음 frame 의 placement 가 끝나고, 그 뒤의 keyboard 호출에 호스트가 응답하고, watcher 가 그 frame 의 status 를 받은 뒤 답하므로, 답 뒤의 요청은 그 frame 의 요소를 찾는다. frame 을 요청하지 않은 실행은 바로 답한다. mygo 워크벤치는 frame 의 status 를 frame 다음 step 에서 보낸다. 그 step 에서는 frame 의 element tree 를 읽을 수 있으므로, status 는 페이지가 render 뒤의 배치를 읽듯이 frame 이 보여 준 것을 말한다. main page 를 가진 호스트에서 명령은 그 뒤 페이지가 보낸 순서 있는 호출 모두에 호스트가 응답할 때까지 기다리므로, 명령이 연 modal 은 명령이 답할 때 창의 input 을 붙잡고 있다([native modals](native-modals.ko.md#키보드)). 기다림은 가장 새 배치를 기다리고, 기다리는 동안 더 새 배치가 예약되면 다시 기다린다. 더 새 배치가 대신한 배치는 그리지 않고 끝나기 때문이다. 그 뒤 그 그리기의 표면 slot을 읽고, slot이 가리키는 각 표면의 선언된 composition을 기다린다. 같은 표면의 이전 dispose를 기다리기 전에 mount 요청을 composition wait에 등록한다. replacement mount가 대기 중인 표면을 slot이 가리키면 그 mount를 기다리며 mount 실패를 그대로 보고한다. 이 명령이나 뒤의 명령이 제거한 표면은 기다림이 slot을 읽을 때 slot이 없다. 가장 새 그리기 뒤에 mount되지도 않고 mount 중도 아닌 표면을 가리키는 slot은 결함이며, 기다림은 `surface <id> is not mounted`로 실패한다. replacement가 없는 dispose는 mount된 상태나 대기 상태를 남기지 않는다. mounted surface entry에서 시작한 composition wait는 mount 등록이 pending이어도 해당 entry를 따른다. entry가 composition을 선언하기 전에 dispose가 시작되면 wait는 `surface <id> was disposed before declaring composition`으로 끝나며, mount 실패는 원래 오류를 반환한다. replacement mount를 기다리는 wait는 replacement entry를 따른다. 가장 새 배치가 실패하면 배치 대기열이 그 실패를 보이고, 그 배치는 표시되지 않았으므로 기다림은 slot을 읽지 않고 끝난다. 기다림 자체의 실패는 `exposure settled failed: <text>`로 쓴다. 두 경우 모두 명령은 handler의 결과로 답하며, 그 실패는 [애플리케이션 로그](hosts.ko.md#애플리케이션-로그)에 한 줄을 가진다.


Native listener 등록은 그 외에는 ready가 될 view mount나 composition wait를 지연하지 않는다. Ready 전에 등록이 reject되면 mount와 composition wait는 해당 오류로 reject된다. 워크벤치는 등록에 성공한 모든 listener를 해제하고 view-command layer를 닫으며 실패한 mounted entry를 제거한다. 이 실패 관측은 native-surface authorization에 의존하지 않는다. Ready 뒤 등록이 reject되면 workbench는 surface status로 오류를 보고하고 view를 정리해 mounted entry를 제거한다. 이미 resolve된 mount나 composition wait의 결과는 유지한다.

Listener 등록이 끝나기 전에 dispose가 시작되면 mount 작업은 기존 dispose 결과를 유지한다. 워크벤치는 이미 등록된 listener를 즉시 해제하고 나중에 등록되는 listener도 해제하며, 이후 발생한 등록 또는 cleanup 실패를 애플리케이션 오류 경로로 보고한다.
Surface별 mount registration은 이전 entry의 dispose를 기다리기 전에 예약하여 composition wait가 replacement를 따르도록 한다. Reservation에는 `mountSurfaceNow`가 새 entry를 만들 때까지 attempt 번호가 없다. Mounted entry 또는 pending reservation 재사용은 attempt를 늘리지 않는다. 새 entry는 page-local 증가 attempt 번호를 받고, entry가 desired plane에 있는 동안 registration outcome과 함께 보존된다. Registration은 entry가 mount되거나 실패할 때까지 pending이다. Composition readiness 후 listener registration이 실패하면 entry를 해제하기 전에 outcome을 실패로 바꾼다. 새로 만든 entry가 실패하면 해당 plugin, surface, attempt, failure phase, 원래 이유를 담은 error event `workbench.surface.mount.failed`를 보낸다. Release 후 시작한 composition wait는 `surface <id> is not mounted`만 보고하지 않고 보존된 attempt와 이유를 보고하며, composition readiness에서 이미 완료한 wait는 완료 상태를 유지한다. Retry reservation은 앞선 실패 outcome을 대체하고 오래된 entry의 늦은 실패는 새 record를 덮지 않는다. 따라서 성공한 retry는 앞선 실패를 상속하지 않는다. 정상 dispose는 entry record를 지우고 desired plane에서 빠진 surface는 보존된 실패도 지운다. 정상 dispose는 mount 실패가 아니며 이 event를 보내지 않는다. 실패 phase는 composition readiness를 막는 실패(ready 전 listener registration 실패 포함)에 `mount`, readiness 후 native listener registration 실패에 `listener-registration`을 사용한다. 같은 surface별 registration record가 pending wait와 보존된 실패 outcome에 함께 쓰이므로 별도 failure map은 필요하지 않다. 구조화 error event는 진단용이며 error display를 호출하지 않는다. 기존 surface status와 settled-error 보고가 계속 실패를 표시한다. `surface.registration` trace는 exposure registration을 설명하며 mount attempt나 실패 outcome은 담지 않는다.

| 함수 | 등록 대상 |
| --- | --- |
| `expose.status(name, read, subscribe)` | `read()`는 현재 값을 반환하고, `subscribe(fn)`은 값이 바뀔 때마다 `fn(value)`를 호출한다 |
| `expose.command(name, run)` | `run(params)`는 결과 또는 결과의 Promise를 반환한다 |
| `expose.element(name, element)` | element 항목의 요소. exposure가 그 요소에 이름을 표시한다 |
| `expose.element(name, provide)` | `many`인 element 항목에서 현재 요소들을 돌려주는 함수. 요청마다 다시 읽으므로, 행 요소를 바꾸는 목록은 지운 요소를 들고 있지 않는다. 페이지는 각 요소를 그릴 때 이름(`dataset.expose`)을 표시한다 |

네이티브 호스트는 [사이드카](sidecars.ko.md) 메시지를 전달하는 방식과 같은 방식으로 표면 페이지와 워크벤치 등록소 사이에서 등록과 요청을 전달한다. 표면 페이지가 닫히면 등록소는 그 페이지의 등록을 제거한다.

페이지는 자신을 식별하는 key, 즉 그 등록의 owner key 아래에서 등록한다. 표면 페이지는 자기 surface id 아래에서 자기 plugin을 owner로 하여 등록한다.

### 표면 문서

core view bridge는 surface start values가 있는 실제 view document에 다음 항목을 등록한다. plugin은 이를 구현하지 않는다. core는 선언을 surface start values와 함께 전달하고 `exposure.json`에 선언한다. surface page가 등록하는 core 항목은 이 세 이름뿐이며 `core.surface.menu`는 main document의 명령이다. core document 요청은 bridge가 한 번 답하며 plugin exposure listener로 전달하지 않는다. main-page placeholder는 view의 document나 input 상태를 보고하지 않는다.

document audit는 open shadow tree를 포함하여 그 document의 모든 shared binder가 실제 연결한 항목을 집계하며, 각 binder의 `audit(root)`는 자기 binding 범위를 유지한다. binder를 dispose하면 document audit에서도 그 연결을 제거한다. document read는 현재 open shadow tree를 순회하고, document·viewport·관찰 중인 DOM·binding 변경은 watcher에 알린다. 발견한 shadow root는 각각 관찰한다. 기존 host에 binding 변경이나 관찰 중인 DOM 변경 없이 만든 unbound shadow root는 mutation notification을 만들지 않지만, 다음 document read에는 포함된다. page exit는 input listener, observer, binding subscription, exposure watch를 해제한다.

| 종류 | 이름 | 의미 |
| --- | --- | --- |
| status | `core.surface.document` | `{url, timeOrigin, readyState, themed, scale, body, viewport, filter, unbound, params}`: 문서 주소, 시간 원점, 준비 상태, 첫 테마 적용 여부, 기기 픽셀 비율, 표면 내용의 크기인 `body`(표면 요소의 상자에 그 밖으로 넘치거나 스크롤되는 내용을 더한 크기)와 표면 요소의 보이는 상자 크기인 `viewport`(모두 CSS 픽셀이며, 내용이 들어맞지 않을 때만 `body`가 `viewport`보다 크다), 루트 요소의 계산된 `filter`, 조작 요소의 audit(`core.workbench.audit`와 같은 형식), view bridge 시작 시 읽은 정확한 `window.sokSurface.params` 값의 snapshot인 `params`(`null` 포함). 값이 없거나 object 또는 null이 아니면 관측 시작을 거부하고 필드명을 보고함 |
| status | `core.surface.input` | 문서의 최근 입력 이벤트 32개(신뢰 여부 포함)를 순서대로 담는다. `pointerdown`, `pointerup`, `pointermove`, `click`, `wheel`, `keydown`에 대한 `{sequence, type, trusted, x, y, key, modifiers}`. `modifiers`는 이벤트가 담은 수정 키(`shift`, `alt`, `control`, `command`)의 목록이다. `sequence`는 1부터 기록한 이벤트마다 1씩 증가한다 |
| command | `core.surface.hit` | CSS 픽셀 단위 `{x, y}`. 그 점에 문서의 요소가 있으면 `true`를 반환한다 |
| command | `core.surface.clock` | `{}`. `{page, timeOrigin, now}`을 반환한다: view start가 설치한 문서의 page identity와, 문서의 time origin과 `performance.now()`(밀리초)이며, check가 두 native clock 읽기 사이에서 읽어 문서 시각을 native clock에 대응시킨다. WebKit은 읽을 때마다 wall clock에서 time origin을 구해 밀리초 단위로 줄이므로, 문서를 밝히는 것은 time origin이 아니라 page identity다 |

mount된 view는 애플리케이션 문서에서 자기 exposure를 소유한다: `runtime.command.register`로 등록한 명령의 요청 콜백과, main page가 그 view 대신 전달한 status·element·command 등록이다. view의 dispose는 같은 논리 표면 식별자로 다시 mount하기 전에 그 콜백과 등록을 제거한다. view가 명령을 등록하지 않았을 때와 view process가 아직 살아 있을 때도 그렇다. 호스트는 place가 그 표면을 뺄 때, 표면이 다른 문서를 읽을 때, main page가 다시 읽힐 때 표면의 close를 알리고, 제거된 project의 탭 해제처럼 place가 앞서지 않은 dispose는 그중 어느 것도 일으키지 않는다. 따라서 닫히거나 unload된 탭은 항목 이름으로 선택되지 않고, `exposure.list`는 그 등록을 세지 않는다. 반복 dispose는 그 식별자의 이후 소유자에게 영향을 주지 않는다. dispose 후 요청은 dispose된 view에 전달되지 않는다.

view는 그 표면의 네이티브 승인이 완료된 뒤에 코어·플러그인 항목을 등록한다. 호스트는 승인된 표면이 composition을 선언할 때 view를 만들기 때문이다. 승인 대기 중 받은 종료 알림이 이후 마운트의 코어 항목만 제거할 수 없어야 한다.

### 모달 문서

네이티브 모달 문서는 렌더, 배치, 테마 변경, 내용의 스크롤마다 모달 응답 경로로 키 `document`를 사용해 자기 상태를 메인 페이지에 보고하므로 요소 사각형이 press가 닿는 자리를 이름 짓는다. 워크벤치는 이를 status `core.modal`로 공개한다. 열린 모달이 없으면 `null`이고, 있으면 `{id, mode, document}`다. `document`는 모달 web view를 만드는 호스트에서만 알리며, 첫 보고 전에는 `null`이며 이후 `{mode, filter, htmlBackground, bodyBackground, scrimBackground, loaded, rect}`다: 렌더한 요소의 `data-native-modal`, 루트의 계산된 `filter`, 루트와 body의 계산된 배경색, 대화상자 scrim에 사용하는 `body::before`의 계산된 배경색, 문서가 첫 내용 요청의 응답을 처리했는지(적용한 변경보다 오래되어 버린 경우도 포함), CSS 픽셀 단위 요소 사각형, 그리고 문서의 이름 있는 요소를 문서 순서로 담은 `elements`: `[{name, x, y, width, height}]`.

모달 문서에는 status watch 경로가 없다. 메인 페이지는 status watch를 surface에만 전달한다. 그래서 모달 문서의 exposure port는 watch된 값을 `status <name> of document <id> cannot be sent: a modal document has no status watch route`로 거부한다. 따라서 page API는 문서 시작에서 그 port를 받아들이고, 값은 보고 없이 문서를 떠나지 않는다.

네이티브 메뉴 모달에서 Escape는 키 `core.modal.dismiss`로 응답하며, 이 키는 메뉴를 닫는 선언된 명령의 이름이다. 응답 값은 비어 있다. 메인 페이지는 그 명령을 registry로 실행하며, 네이티브 뷰는 명령을 스스로 실행하지 않는다.

모달 문서의 응답은 그 모달이 열린 모달일 때만 메인 페이지에 닿는다. host는 모달 id와 instance가 열린 모달의 것이 아닌 응답을 버리고 `host.overlay.dropped` `{id, instance, key, open}`을 기록한다. 메인 페이지는 보이지 않는 모달이나 받는 곳이 없는 모달의 응답을 버리고 `workbench.overlay.dropped` `{id, shown, key}`를 기록한다. 닫히는 모달도 마지막 상태 보고를 보내므로 버림은 오류가 아니라 `info` event이며, 기록 없이 버리는 응답은 없다.

### 표면 선택

여러 표면 페이지가 같은 이름을 등록할 수 있다. 이런 이름에 대한 `status.get`, `status.watch`, `status.unwatch`, `command.run`, `element.rect`, `element.act` 요청은 `core.surfaces`의 식별자인 `surface`를 포함할 수 있다. `surface`가 없으면 워크벤치가 포커스된 카드의 활성 탭, 최근 배치의 보이는 표면, 마지막 등록 순서로 고른다. 그 이름을 등록하지 않은 `surface`는 1002를 반환한다. `surface` 없이 고르는 경우는 탭 표면만 고른다. section 표면은 그 이름을 적은 요청과 자기 view가 실행하는 명령([view call](native-surfaces.ko.md#view-표면))에만 답한다. 한 plugin의 여러 section이 같은 이름을 등록하고, section은 `core.sidebars`가 알리는 탭을 따르기 때문이다.

## Tab memory

메인 페이지의 [메모리 절약](plugins.ko.md#메모리-절약)에는 다음 항목이 있다.

- Status `core.tab.memory`: `{enabled, delay, pressure: {level, seq}, tabs: [{tab, kind, plugin, state, reasons, hiddenAt, unloadAt, checkedAt}]}`이며 바뀔 때마다 알린다. `enabled`는 설정 `memorySaver`, `delay`는 분 단위 설정 `memorySaverDelay`, `pressure`는 마지막 [memory pressure](hosts.ko.md#memory-pressure) 보고다. `kind`는 `tab` 또는 `section`이며, section 항목의 `tab`은 그 section 표면의 id다([메모리 절약](plugins.ko.md#메모리-절약)). `state`는 `loaded`, `unloaded`, `restoring` 중 하나다. `reasons`는 탭을 보호하는 이유를 하나의 열거 `shown`, `recent`, `keep:modified`, `keep:busy`, `media`, `media-unknown`, `capture`, `form`, `kept`, `off`, `undeclared`, `background`에서 나열한다. `hiddenAt`은 탭이 숨겨진 시각이나 `null`, `unloadAt`은 다음 지연 기한이나 `null`, `checkedAt`은 `media`, `media-unknown`, `capture`를 읽은 마지막 결정의 시각이나 `null`이다. `core.surfaces`는 탭마다 같은 `state`를 알리고, unload된 표면에 대한 요청은 `tab <id> is unloaded`로 실패한다.
- Command `core.tab.unload {tab}`은 숨겨진 탭을 지금 unload한다. 사람이 직접 정한 것이므로 `recent`, `media`, `media-unknown`, `capture`, `form`을 기다리지 않는다. 남은 이유(`shown`, `keep:modified`, `keep:busy`, `kept`, `off`, `undeclared`, `background`)와 시도를 끝낸 이유에는 오류 `tab <id> is protected: <reasons>`로, 알 수 없는 탭에는 -32602(invalid params)로 실패한다.
- Command `core.tab.keep {tab, keep}`은 사람의 표시 `kept`를 정하거나(`true`) 지우고(`false`) `tab-state.json`에 저장한다. 멱등이며 바뀔 때마다 `workbench.tab.keep.changed`를 하나 낸다. 알 수 없는 탭이나 boolean이 아닌 `keep`에는 -32602로, 절대 unload될 수 없는 탭에는 이유 `undeclared`나 `background`를 담은 `tab <id> can never be unloaded: <reason>`로 실패한다.
- 각 탭 단추는 자기 `state`(`loaded`, `unloaded`, `restoring`)를 담은 `data-tab-state`를 가진다. 보호는 `reasons`로만 보인다.
- 명령 `core.tab.menu {tab, x, y}`는 탭 context menu를 창의 `x`, `y`에 선택 layer로 연다. 탭 버튼의 오른쪽 클릭은 menu에 항목이 있을 때 이를 실행한다. 알 수 없는 탭에는 -32602로, 절대 unload될 수 없는 탭에는 `tab <id> has no menu items`로 실패한다.
- element 이름 `core.tab.menu-keep`인 탭 context menu 항목은 binder로 `core.picker.pick`을 거쳐 골라지고 표시를 뒤집은 값으로 `core.tab.keep`을 실행한다. `core.tab.memory`의 reasons에 `kept`가 있는 동안 `core.picker`에서 `active`이며, 절대 unload될 수 없는 탭에는 없다. exposure 검사는 접두사 `core.`가 있는 이름만 읽으므로, 이 이름은 core가 선언하는 모든 element 이름처럼 그 접두사를 갖는다.

## Plugin processes

메인 페이지는 [plugin process 설계](plugin-processes.ko.md#메시지와-event)의 status 네 개를 게시한다. 각 status는 plugin id를 담은 record의 목록이다. plugin process가 상태를 메인 페이지에 보고하기 전까지 각 목록은 `[]`이다.

- status `core.plugin.open-calls`: `[{plugin, count, oldestStartedAt}]`, 열린 call이 있는 각 plugin의 값이다. `oldestStartedAt`은 가장 오래된 열린 call의 시작 시각이고, 없으면 `null`이다.
- status `core.plugin.losses`: `[{plugin, abandoned, lateReplies, peerLost}]`, 각 plugin의 손실 횟수다. 응용 프로그램이 끝날 때까지 유지한다.
- status `core.plugin.views`: `[{plugin, surface, responsive}]`, 각 plugin view surface의 응답 상태다.
- status `core.surfaces`: 각 표면 항목은 `kind`를 가진다. `kind`는 탭 표면이면 `tab`, [section 표면](plugins.ko.md#섹션)이면 `section`이며, section 표면 항목은 `sidebar`도 가진다. 각 표면 항목은 선언된 합성의 종류인 `composition`(`view`)을 가진다. plugin이 그 표면을 선언하지 않으면 `null`이다. compositor record가 가지지 않은 mount된 view는 retained view이며([native surfaces](native-surfaces.ko.md)), `visible: false`, `dim`, `declared`와 `applied`가 `null`인 항목으로 나열되고, `exposes`, 자신의 mount의 `status`(`{phase, error}`), `composition`, `state`를 가진다. retained view는 배치가 아니다. mount가 시작되거나, status가 바뀌거나, dispose될 때와 그 표면의 등록이 바뀔 때 알린다.

## 창

애플리케이션에는 창이 하나 이상 있고, 창마다 워크벤치와 등록소가 따로 있다. `windows.list`와 `log.query`를 제외한 모든 메서드는 `window`를 받는다. 이 값은 `windows.list`가 반환하는 식별자다. 더 이상 없는 창을 요청하면 오류 1003 `window "<name>" does not exist`를 반환한다. host가 요청을 받은 뒤 닫힌 창도 같다. host는 native 창을 native code에 넘기는 main thread 단계에서 읽고, 그 단계 전에 닫힌 창은 native code에 닿지 않고 요청을 1003으로 실패시킨다. 그런 창의 `host.window` 변경은 아무것도 알리지 않는다. 닫기는 `host.windows`에서 창이 빠지는 것으로 알려진다.

## 호스트 항목

네이티브 호스트는 같은 형식으로 소유자가 `host`인 항목을 선언하고 직접 처리한다.

화면 좌표는 주 디스플레이의 왼쪽 위를 원점으로 하고 y가 아래로 증가하는 포인트 값이다. `shown`은 모달 웹뷰가 보이고 키보드 초점을 받은 뒤 참이 된다. `order`는 창 안 웹뷰의 그리기 순서다. 메인 페이지가 0이며 값이 클수록 위에 그려진다. `background`는 `{draws, alpha}`이며 모달 웹뷰가 자기 배경을 칠하는지와 페이지 아래 배경색의 알파다.

| 종류 | 이름 | 의미 |
| --- | --- | --- |
| status | `host.window` | `{frame, pointer, content, scale, refreshRate, maximized, key, virtualKey, active, occluded, children, pageProcess, quitting, controls, webviews, surfaces, documents, regions, modal, responder, frames, commandBuffers, settled}`: 창 프레임, 상태를 읽은 때의 화면 좌표 시스템 포인터 위치 `{x, y}`(virtual key window는 마지막 합성 입력이 있으면 그 위치), 콘텐츠 크기, 백킹 배율, 창이 놓인 화면의 최대 재생률(어느 화면에도 없으면 `null`), 프레임이 최대화 프레임인지, 시스템의 키 창 여부, 창이 [virtual key window](#virtual-key-window)인지, 애플리케이션이 실제로 활성인지, 메인 페이지를 그리는 WebContent process의 process 식별자(`pageProcess`, 그 process가 시작되기 전에는 0, 메인 페이지가 없는 호스트에서는 `null`), 다른 창이 창 전체를 가리는지(AppKit 의 가림 상태로, 창이나 그 그림자의 일부라도 보이면 보이는 창이므로 같은 자리의 두 창은 서로를 가리지 않는다. 이 값이 바뀌면 호스트가 `host.window` 감시자에게 알린다. 가려진 창은 WebKit 이 덜 자주 그리므로 표시 측정은 이 값이 거짓이어야 한다), 자식 OS 창 수, `hidden`을 포함한 창 단추 프레임, 창 좌표계의 웹뷰 프레임 `{frame, main, document, visible, focused, order}`, 네이티브 표면 `{id, frame, visible, order}`, [문서 영역](native-surfaces.ko.md#문서-영역) `{surface, document, frame, visible, focused, order, process}`, [그림 영역](native-surfaces.ko.md#그림-영역) `{surface, name, frame, visible, drawing, focused, blurred, presented, presentedFrames, error}`. `drawing`은 호스트가 공급자에게 마지막으로 보낸 [그리기](native-surfaces.ko.md#그림-영역) 상태다. `presented`는 표시 중인 그림의 `{width, height, scale, generation, raster, sequence}`이며, `generation`, `raster`, `sequence`는 호스트가 표시됨으로 기록한 프레임을 식별한다. 현재 래스터의 프레임이 표시되지 않은 동안 `presented`는 `null`이다. `presentedFrames`는 region이 attach된 뒤 호스트가 표시됨으로 기록한 그 region의 프레임 수이며, 래스터가 바뀌어도 0으로 돌아가지 않는다. 열린 네이티브 모달 `{id, mode, shown, frame, order, background}` 또는 `null`, 창의 첫 응답자 `{class, owner, surface, document}`. `owner`는 `workbench`(워크벤치를 그리는 뷰: Wails와 Tauri 호스트에서는 메인 페이지, mygo 호스트에서는 워크벤치의 surface 뷰), `surface`(surface 웹뷰, 또는 `documents`가 그 surface의 document `""`로 나열하는 view surface의 view), `document`(document region), `modal`, `webview`(등록되지 않은 웹뷰), `native`(이미지 영역처럼 모든 웹뷰 밖의 뷰) 중 하나다. `frames`, `commandBuffers`, `settled`는 workbench의 프레임 수, commit된 command buffer 수, 창이 마지막 프레임 뒤에 settle했는지이며, Wails와 Tauri host에서는 WebKit이 workbench를 그리고 호스트가 그 프레임도 command buffer도 세지 않으므로 `null`이다. watcher는 프레임이 창을 settle 상태로 남길 때와 settle 상태를 끝낼 때 알림을 받으며, animation의 프레임마다 받지 않는다. 호스트는 한 창의 값을 한 번에 하나만 읽는다. 읽는 동안 들어온 변경은 다음 읽기 하나로 합쳐지므로, 구독은 새 값 뒤에 옛 값을 받지 않고 마지막 값은 마지막 변경 뒤에 읽은 값이다 |
| status | `host.windows` | `windows.list` 결과. 창이 열리거나 닫힐 때와 창의 제목, 프로젝트, 키 상태, 페이지 준비 상태가 바뀔 때 바뀐다 |
| status | `host.screens` | `[{x, y, width, height, scale, visible}]`: 화면 좌표의 디스플레이와 백킹 배율, 그리고 메뉴 막대와 Dock 을 뺀 영역 `visible`(최대화한 창의 프레임) |
| status | `host.dock` | 애플리케이션 Dock 메뉴 항목 제목의 순서 목록 |
| status | `host.log` | `{path, size, notices, coalesced}`: event log의 변경에 대한 가장 최근 알림([따라가기](debug.ko.md#파일)). `path`는 설정 폴더 아래의 event 파일(`logs/<name>`), `size`는 바이트 크기이고, `notices`는 시작 이후 발행한 알림 수로 250 ms에 하나까지이며, `coalesced`는 뒤의 알림에 합쳐진 알림 수다. 첫 알림 전의 값은 `{path: "", size: 0, notices: 0, coalesced: 0}`다. host는 알림마다 `host.log` 감시자에게 알린다. log만 읽는 호출의 기록을 뺀 모든 줄이 변경을 알리므로 알림 뒤 `log.query`를 요청하는 client가 다음 알림을 일으키지 않는다 |
| status | `host.buttons` | `{mask}`: AppKit이 눌렸다고 보고하는 mouse 버튼(`+[NSEvent pressedMouseButtons]`: bit 0 왼쪽, bit 1 오른쪽, 그 위 bit는 다른 버튼). 호스트는 AppKit이 mouse 버튼의 누름이나 뗌을 애플리케이션에 전달할 때(local event monitor)와 다른 애플리케이션에 전달할 때(global event monitor) 마스크를 읽고, 마스크가 바뀌면 `host.buttons` 감시자에게 알린다. 그래서 다른 애플리케이션이 최전면인 동안의 사람의 버튼도 값을 바꾼다. 합성 `input.pointer` 누름과 뗌은 AppKit의 event 전달을 거치지 않고 뷰로 가므로 값을 바꾸지 않는다 |
| status | `host.sidecars` | `{closing: [{sidecar, surface}], outdated: [{sidecar, running, installed, sessions}]}`: 호스트가 `closed`를 보냈고 사이드카가 아직 답하지 않은 표면([사이드카](sidecars.ko.md#메시지))과, 서비스가 설치된 것과 다른 version으로 도는 persistent 사이드카([persistent services](persistent-services.ko.md#updates)) |
| command | `host.menu.select` | 애플리케이션 메뉴 항목 `{menu, title}`을 실행한다. 제목이 `menu`인 하위 메뉴에서 제목이 `title`인 항목이다 |
| status | `host.menu` | 애플리케이션 메뉴. 구분선을 뺀 하위 메뉴마다 `[{title, items: [{title, key}]}]`이며, `key`는 수정 키 `ctrl`, `opt`, `shift`, `cmd`를 이 순서로 `+`로 이은 뒤 키를 붙인 단축키이거나 빈 문자열이다 |
| command | `host.window.close` | 창의 일반 닫기 동작으로 창을 닫는다 |
| command | `host.window.move` | 창 프레임 원점을 화면 좌표 `{x, y}`로 옮긴다 |
| command | `host.window.maximize` | 창을 최대화한다. `{on: false}`이면 원래 크기로 되돌린다 |
| command | `host.window.fullscreen` | 전체 화면으로 바꾸거나 `on`이 false 이면 되돌린다. 전환이 끝난 뒤에 답한다. macOS 는 전환 중의 요청을 무시하므로 호스트가 그 전환이 끝난 뒤에 적용한다. macOS는 최소화되었거나, 보이지 않거나, sheet를 보이는 창의 요청도 무시하므로 호스트는 그런 요청을 곧바로 1006으로 거절한다. 그런 원인 없이 macOS가 그 turn에 무시한 요청은 1006 `macOS did not start the full screen transition`로 실패한다. 창 닫힘은 기다리는 요청을 1003으로 실패시킨다. AppKit은 시작한 뒤 실패한 전환을 framework가 소유한 창의 delegate에 `windowDidFailToEnterFullScreen:`이나 `windowDidFailToExitFullScreen:`으로 알린다. 호스트는 그 delegate에서 둘 다 받고, 그 실패는 요청을 1005 `macOS failed the full screen transition`로 실패시킨다. 요청에는 한도가 없다 |
| command | `host.window.resize` | 콘텐츠 영역 크기를 `{width, height}`로 바꾼다 |
| command | `host.window.reload` | 창의 워크벤치를 저장된 상태에서 다시 시작하고 워크벤치가 준비를 알린 뒤 완료한다. 그 준비 전의 창 닫힘과 페이지 프로세스 끝은 1003으로 실패시킨다([page 다시 읽기](native-host.ko.md#page-다시-읽기)). Wails와 Tauri 호스트는 메인 페이지를 다시 로드하고, mygo 호스트는 native 워크벤치를 다시 만든다 |
| command | `host.window.presented` | 메인 페이지와 표시 중인 modal이 현재 배치를 화면에 표시하고, 표시 중인 모든 그림 영역이 정확한 현재 래스터를 표시한 뒤 완료된다. 먼저 창의 workbench에 마지막 배치(`workbench.placement.last`)를 묻는다. 이 method는 workbench가 만들었거나 들고 있는 배치가 끝나면 답하고, 그 배치가 실패하면 그 실패로 답한다. 그다음 연속 갱신이 끝나기를 기다린다. 창의 열린 표면 배치 트랜잭션이 먼저 커밋되기를 기다린다([네이티브 표면](native-surfaces.ko.md), [표면 합성](surface-composition.ko.md)). 각 단계는 자기 이벤트로 끝나며 자기 한도가 없다. workbench의 답, 연속 갱신의 끝, 표시 중인 modal의 첫 paint, 숨김, 교체 또는 WebContent 프로세스 끝, 창의 settled 표시, 보이는 각 그림 영역의 현재 래스터의 표시나 실패이며, 그 공급자 연결의 끝이나 영역 닫힘은 래스터 기다림을 실패시킨다. 창 닫힘은 명령을 1003으로 실패시키고, 실패한 단계는 그 실패로 답한다. 그 상태를 보여 주는 화면 갱신 시각(ms, 녹화 프레임 시각과 같은 시계) `{displayed}`를 반환한다(표시 뒤 창이 있는 화면의 다음 갱신이며, 첫 load 뒤 드러나기를 기다리는 창([page start](native-host.ko.md#page-시작))은 그때까지 아무것도 보이지 않으므로 드러난 뒤의 갱신. 창이 어느 화면에도 없으면 호출 시각) |
| command | `host.hit` | 창 좌표의 점 `{x, y}`를 소유한 대상을 반환한다: 워크벤치면 `{kind: "workbench"}`(Wails와 Tauri 호스트에서는 그림 영역이 DOM 입력을 받으므로 여기에 속한다, [표면 합성](surface-composition.ko.md). mygo 호스트에서는 web view와 surface host를 담는 native view 바깥의 모든 점이다, [surface host container](native-surfaces.ko.md#surface-host-container)), 문서 영역이면 `{kind: "document", surface, document}`, 네이티브 hit 이면 `{kind: "native", identifier, view}`다. 네이티브 뷰가 없으면 `view`는 `null`, 있으면 hit-test 된 실제 leaf 뷰의 창 콘텐츠 좌표 프레임과 클래스 `{class, frame}`를 담는다 |
| command | `host.dock.select` | 제목이 `{title}`인 Dock 메뉴 항목을 실행한다 |
| command | `host.quit` | 대기 중인 저장을 포함한 일반 애플리케이션 종료를 요청한다 |

## 메서드

클라이언트는 다음 JSON-RPC 2.0 메서드를 호출한다.

| 메서드 | 매개변수 | 결과 |
| --- | --- | --- |
| `windows.list` | 없음 | `[{window, title, project, key, ready}]`. `project`는 창에 마지막으로 열린 프로젝트의 루트 디렉터리이며, 창에 열린 프로젝트가 없으면 `null`이다. 창의 마지막 프로젝트를 해제하면 창 제목도 라이브러리 제목으로 돌아간다. `ready`는 창의 메인 페이지가 준비를 알린 뒤 참이고 로드하는 동안 거짓이다. 페이지가 로드 중인 창에 대한 요청은 1003으로 실패한다 |
| `log.query` | 질의 매개변수, `window` 없음 | `{rows, next, tail, scanned, rejected}`: 설정 폴더의 event 파일의 event page 하나([endpoint](endpoint.ko.md#log-query), [logging](logging.ko.md#질의)) |
| `exposure.list` | `{window, owner?}` | `{status, commands, element}`: 코어, 호스트, 로드된 플러그인의 선언 항목을 선언 형식으로 반환한다. 각 항목에 `registered`가 있다. `owner`가 `host`이면 호스트 항목만 반환하며, 호스트가 main page 없이 답하므로 page가 시작하지 않은 동안에도 목록이 나온다. 다른 `owner`는 `exposure.list owner must be host`로 거부한다. `sok command`는 `host.` 명령을 호스트 항목으로 검사한다 |
| `status.get` | `{window, name, surface?}` | 현재 값 |
| `status.watch` | `{window, name, surface?}` | `null`. 이후 `status.unwatch`를 받거나, 연결이 닫히거나, 값의 producer가 끝날 때까지 값이 바뀔 때마다 호스트가 `status.changed` 알림 `{window, name, surface?, value}`를 보낸다. `surface` 값이 다른 감시는 서로 별개다. `surface`가 있는 감시의 producer는 그 surface가 닫히거나 그 document가 바뀔 때 끝나고, 창의 모든 감시의 producer는 창이 닫힐 때 끝난다. 그 끝의 차례에 호스트는 감시를 가진 각 연결에 앞서 보낸 `status.changed` 알림 뒤로 종결 알림 `status.ended {window, name, surface?, reason}`를 한 번 보내고(`reason`은 `surface-closed` 또는 `window-closed`), page에 `status.unwatch`를 보내지 않고 감시를 지우므로, 뒤의 같은 이름과 surface의 `status.watch`는 새로 시작한다. `sok status --watch`는 종료 상태 1과 오류 `status <name> ended: <reason>`으로 끝나고, `@soksak/client`의 `watch`는 그 오류와 code `ENDED`로 reject한다. 감시의 값을 기다리는 client는 그것을 결정하는 이벤트(호출자를 만족시키는 값, 종결 알림 `status.ended`, `status.watch`나 `status.get`의 실패한 답, predicate의 오류, 연결 닫힘)의 turn에 호출자를 settle하고, 그 뒤에 끝나지 않은 감시를 `status.unwatch`로 끝낸다. 그래서 어떤 호출자도 unwatch의 답을 기다리지 않는다. 그 기다림에는 시간 제한이 없고, MCP server의 `wait` 도구도 같이 기다린다. 그 `status.unwatch`의 거절도 code가 무엇이든 감시를 끝내므로 client는 다른 것을 닫지 않는다. 그 감시를 거절의 code로 reject하고 연결을 유지하며, 이미 settle된 호출자는 그 결과를 지킨다 |
| `status.unwatch` | `{window, name, surface?}` | `null` |
| `command.run` | `{window, name, params, surface?, cids?}` | 명령 결과. `cids`는 실행의 원인인 상관 식별자이며, view의 명령이 받는다([view 표면](native-surfaces.ko.md#view-표면)) |
| `element.rect` | `{window, name, index?}` | `{x, y, width, height}`: 소유 문서의 CSS 픽셀로 나타낸 요소의 `getBoundingClientRect()`, `zoom`: 요소의 유효 CSS zoom으로, 요소와 flat tree의 각 ancestor의 computed `zoom`을 곱한 값, `role`: 요소의 ARIA role, 그리고 창 좌표로 나타낸 문서 원점 `{document}`. 묶거나 글자만 담는 요소의 `role`은 null이고 모든 host가 null로 답한다. 페이지에서는 `div`, `span`, `role="group"`이고 mygo workbench에서는 element tree의 group과 text이다. 그 밖에는 페이지에서 role 속성의 첫 토큰, 없으면 태그와 input type의 암묵 role, 그것도 없으면 contenteditable 요소의 `textbox`이고, mygo workbench에서는 element tree에 있는 요소 role의 ARIA 이름이다. CSS `zoom` subtree 안에서 WebKit 7624 이후는 CSS Viewport zoom object model이 정의하는 대로 zoom을 적용한 rectangle을 보고하고, 그 이전 WebKit은 `zoom`으로 나눈 rectangle을 보고한다 |
| `element.act` | `{window, name, index?, action, value?, event?}` | `null`. `action`은 `click`, `input`, `dispatch` 중 하나다. 페이지는 `isTrusted`가 false인 합성 DOM 이벤트를 받는다 |
| `input.pointer` | `{window, pointer?, x, y, phase, button?, deltaX?, deltaY?, clicks?, activate?}` | `null`. `pointer`는 입력의 pointer 이름으로, `a-z`, `0-9`, `-`로 된 1~32자이며 기본값은 `main`이다. 다른 값은 -32602를 반환한다([named pointers](#named-pointers)). 창 좌표를 쓴다. `phase`는 `move`, `down`, `drag`, `up`, `scroll` 중 하나다. `button`은 `left`(기본값) 또는 `right`다. `deltaX`, `deltaY`는 포인트 단위 스크롤 거리다. `clicks`는 `down`과 `up`에 적용하며 event의 click count로, 1(기본값)부터 3까지의 정수다. double click은 1로 `down`, `up`을 보낸 뒤 2로 `down`, `up`을 보낸다. `activate`는 `move`에 적용한다. 그 밖의 field는 -32602를 반환한다 |
| `input.key` | `{window, key, text?, modifiers?, phase}` | `null`. `key`는 키 이름(`Enter`, `Tab`, `Escape`, `Backspace`, `Delete`, `Space`, `ArrowLeft`, `ArrowRight`, `ArrowUp`, `ArrowDown`, `Home`, `End`, `PageUp`, `PageDown`) 또는 문자 하나다. `text`는 키가 입력하는 문자열이며, 없거나 비어 있으면 키 이름이 event의 문자를 정한다. `modifiers`는 `shift`, `control`, `option`, `command`의 배열이다. `phase`는 `down` 또는 `up`이다 |

`index`는 0 이상의 정수이며, 타입이 다른 `index`를 준 요청은 -32602로 거부한다.

열린 dialog 는 그 바깥의 모든 element 를 inert 로 만든다. dialog 는 종류가 `dialog` 인 modal, 곧 settings 와 debug view 이고, 종류가 `menu` 인 modal 인 picker 는 어떤 element 도 inert 로 만들지 않는다. inert element 는 layout 을 유지하므로 dialog 가 덮고 있어도 `element.rect` 는 그 사각형을 답하고, 어떤 점에 무엇이 닿는지는 `host.hit` 이 답한다. inert element 에 대한 `element.act` 는 어느 document 에서든 1010 과 메시지 `element <name> is behind the open dialog and takes no action` 을 돌려준다.

네이티브 포인터 주입은 pointer와 버튼별로 누름을 받은 뷰를 누름의 창과 함께 유지한다. 포인터가 다른 뷰를 가로질러도 끌기와 뗌을 그 뷰에 전달하며 뗌의 수신 확인은 누름을 받은 문서를 기다린다. 그 창에서 pointer의 일치하는 누름 없는 끌기·뗌, pointer가 같은 버튼을 누른 상태에서의 추가 누름, 제거된 누름 대상 뷰는 명시적 입력 거부를 반환한다. 스크롤과 버튼 없는 이동은 현재 포인터 위치를 사용한다.

workbench page와 card 요소는 app DOM document를 공유하고 view surface는 자기 document를 가진다. main registry는 선택된 surface가 답할 때 view 내부 `element.rect`에 현재 applied view 원점을 한 번 더한다. view의 native page zoom은 1이고 CSS sizing은 이미 element rectangle에 반영되므로 text-size나 capture scale을 곱하지 않는다. 반환된 rectangle은 app-document 좌표이고 `document` 원점은 `{x: 0, y: 0}`이다. applied frame이 없으면 surface 식별자를 담아 실패하며 zero origin으로 대체하지 않는다. hidden 또는 zero-size view도 자기 applied origin을 사용한다. native modal은 별도 document이므로 rectangle은 modal-local 좌표를 유지하고 `document` 원점은 실제 modal frame 원점이다. native modal 루트 안의 모든 요소는 이렇게 답한다. native modal이 사람이 보는 사본을 그리고 그 사본은 main document와 따로 굴러가고 다시 그려지기 때문이다. modal document가 자기 상태의 `elements`로 이름 있는 요소의 rectangle을 보고하고, 그 보고 전이나 보고에 없는 요소를 요청하면 실패한다. 숨겨진 요소의 빈 상자나 사본의 스크롤이 옮겨 버린 자리는 답하지 않는다. modal 루트 자체는 main document의 rectangle을 유지한다. main document가 그 배치를 가지고 있기 때문이다. 사본은 루트의 자식들을 담을 뿐 그 이름의 요소는 없다. client는 보고된 document origin을 정확히 한 번 더하며 surface kind나 card placement에 따라 보정하지 않는다. mygo 호스트에서 워크벤치의 요소에 대한 `element.rect`는 창 point로 나타낸 요소의 frame을 `zoom` 1, `document` `{x: 0, y: 0}`으로 반환하고, `element.act`는 `click`과 `input`을 받는다. `dispatch`는 `the mygo workbench has no DOM events`로 실패한다. view 페이지의 요소는 모든 호스트에서 모든 동작을 유지한다.

호스트는 `input.pointer`와 `input.key`를 네이티브 이벤트로 전달하며 페이지는 신뢰 이벤트를 받는다. `activate: true`인 `move`를 제외하면 애플리케이션을 활성화하지 않는다. macOS에서는 다음과 같다.

- 실제로 활성인 애플리케이션에서 키 창으로 보내는 키는 사람의 키처럼 창 번호를 담아 `-[NSApplication sendEvent:]`로 보내므로 Command+C와 Command+V 같은 key equivalent는 AppKit이 판단한다. 다른 창이 키 창인 동안 어떤 창으로 보낸 키는 사람의 키가 그 창에 닿을 수 없으므로 전달하지 않고 1006을 반환한다. 비활성 애플리케이션에서 키는 창을 [virtual key window](#virtual-key-window)로 만든다. 이 창은 Command나 Control이 있는 key down을 먼저 key equivalent로 제시하고, 받는 곳이 없는 키는 그 창의 `-[NSWindow sendEvent:]`로 간다. `-[NSApplication sendEvent:]`는 실제 상태를 읽어 키를 버리기 때문이다. 스크롤은 `-[NSWindow sendEvent:]`로 보낸다. AppKit은 비활성 창의 누름을 뷰에 전달하지 않으므로 누름은 좌표의 뷰에 직접 보내고 이후 끌기와 뗌은 그 누름 대상을 유지한다. 그 뷰는 content view의 뷰다. 제목 표시줄의 버튼은 그 밖에 있는 창 frame의 뷰이고 자기 event loop 에서 누름을 추적하므로, 누름은 그 버튼에 닿지 않는다. 사람의 포인터가 지나는 창 서버 경로는 닫기 버튼을 포함해 실제 입력 등급이 검사한다.
- 웹뷰에 대한 `down`과 `up`은 그 웹뷰의 문서가 신뢰 `pointerdown` 또는 `pointerup`을 받은 뒤 반환한다. 페이지가 볼 수 없는 별도 WebKit content world의 스크립트가 수신을 알린다. 수신이 입력의 끝이며, WebKit의 뒤 단계가 그 답을 늦추지 않는다. 기다림은 시간이 아니라 다음 이벤트 중 먼저 오는 것으로 끝나며, 각각 한 번 답한다. 수신 알림, 그 이벤트까지 WebKit에 넘긴 마우스 이벤트의 처리 끝(이때 이벤트를 받은 문서는 이미 수신을 알렸으므로, 수신 알림이 없으면 요청은 1005 `the document did not receive the input`를 반환한다), 웹뷰가 아닌 다른 view에 닿은 누름이나 뗌(보낸 turn에 그 1005를 반환한다), 웹뷰의 입력 등록 끝(웹뷰를 닫으면 끝난다), 창 닫힘, 웹 프로세스가 응답을 멈췄다는 WebKit의 알림이며, 각각 그 1005로 답한다. 입력의 native 기록은 기다림을 끝낸 이벤트를 적는다. 웹뷰의 입력 칸에 초점이 있으면 WebKit은 마우스 이벤트를 먼저 입력기에 비동기로 넘기므로, 이렇게 하지 않으면 이어서 보낸 누름과 뗌이 문서에 반대 순서로 도착할 수 있다. 이 경로에서는 WebKit 처리의 끝이 기다림을 끝내지 않는다. 입력기가 아직 이벤트를 쥐고 있을 수 있기 때문이다. 입력기는 이벤트를 소비할 수도 있고 AppKit은 그 사실을 WebKit에만 알리므로 호스트에는 아무 이벤트도 오지 않는다. 기다림에는 한도가 없다. 수신 알림과 위의 다른 끝 말고도, 애플리케이션이 받는 다음 누름이나 key event가 배치 hold를 끝내듯([배치 트랜잭션](native-surfaces.ko.md#배치-트랜잭션)) 기다림을 그 1005로 끝낸다. `scroll`은 좌표의 웹뷰가 현재 상태를 표시한 뒤 전달한다. WebKit은 스크롤 트리가 표시되기 전에 받은 휠 이벤트로 새 문서를 스크롤하지 않기 때문이다. scroll은 그 표시를 기다리고, view의 입력 등록 끝, 창 닫힘, 프로세스가 응답을 멈췄다는 알림이 1005로 기다림을 끝낸다. 최소화되었거나 보이지 않는 창으로의 scroll은 그 창이 보일 때까지 아무것도 표시하지 않으므로 곧바로 1005로 거절한다. 창을 가상 키 창으로 만드는 `move`는 창에서 보이는 모든 웹뷰가 활성 상태를 웹 프로세스에 보낼 때까지 기다리며, 각 웹뷰가 그 보냄을 알린다. 같은 끝 이벤트들이 그 기다림을 1005로 끝낸다.
- WebKit은 창이 키 창으로 답할 때만 호버(`pointerover`, 버튼 없는 `pointermove`, `:hover`)를 갱신한다. 실제로 활성이 아닌 애플리케이션에서 `move`는 그 창을 [virtual key window](#virtual-key-window)로 만들며, AppKit이 키 창으로 가진 창도 그렇다. 실제로 활성인 애플리케이션에서 키 창이 아닌 창에 대한 `move`는 1006을 반환한다. 활성 애플리케이션의 키 창은 예를 들어 키 창이 될 때 시스템 포인터 위치도 이동으로 받으며, 합성 `down`과 `up` 사이의 이런 이동은 문서에 끌기로 도착한다. 그래서 활성화 등급 검사는 창을 시스템 포인터에서 떨어뜨려 둔다.
- WebKit은 마우스 이벤트의 눌린 버튼을 이벤트가 아니라 AppKit(`+[NSEvent pressedMouseButtons]`)에서 읽는다. AppKit이 0이 아닌 버튼 마스크를 보고하면 합성 누름이나 뗌이 `pointerdown`이나 `pointerup` 대신 `pointermove`로 문서에 도달할 수 있으므로 `down`이나 `up`을 거부하고 1007을 반환한다. 마스크만으로는 해당 상태를 만든 원인을 알 수 없으므로, 오류 메시지는 거부와 같은 main run loop 차례에 측정한 마스크와 frontmost 애플리케이션을 보고한다: `AppKit reports NSEvent.pressedMouseButtons mask <mask> while <application> is frontmost; the synthetic press or release was not delivered`. `<mask>`는 `0x` 접두사를 붙인 소문자 16진수 마스크다. `<application>`은 `<bundle identifier> (pid <pid>)` 또는 `an application without a bundle identifier (pid <pid>)`이고, AppKit이 frontmost 애플리케이션을 보고하지 않으면 해당 절은 `while no application is frontmost`가 된다. 두 host는 같은 문장을 만든다. `down`이 열려 있는 동안 페이지는 사람의 경우와 같이 그 pointer의 event `buttons`에서 그 버튼을 보고, 다른 pointer의 event에서는 보지 않는다. 1007의 원인은 사람이 누른 버튼뿐이다.
- `clicks`는 `down`이나 `up` event의 `clickCount`이고, WebKit은 count 2의 press에서 `dblclick`을 만든다. 그래서 double click은 AppKit이 사람에게 주는 것과 같은 event 쌍이다.
- 전달된 `down`부터 그 창에서 같은 pointer와 버튼의 `up`이 전달될 때까지 누름은 열려 있고, 거부된 `up`은 누름을 연 채로 두므로 나중의 `up`이 누름을 받은 뷰에서 그 누름을 끝낸다. pointer가 누름을 쥔 버튼의 `down`은 어느 창에서든 1008과 메시지 `pointer <pointer> holds an open press of this button; send up before the next down`으로 거부한다. `host.buttons`는 1007 거부가 읽는 마스크를 보고하므로, `up`이 거부된 누름은 `host.buttons`가 마스크 0을 보고한 뒤 끝낼 수 있다. 검사 세션은 끝날 때 열어 둔 누름을 모두 끝낸다: timer 없이 `status.watch`로 `host.buttons`가 마스크 0을 보고할 때까지 기다린 뒤 `up`을 보내고, 그 `up`은 전달되어야 한다.
- 누름은 그 `down`을 전달한 endpoint 연결의 것이며, 어느 연결에서든 그 창에서 그 pointer와 버튼의 `up`이 전달되면 끝난다. 연결이 닫히면 그 연결이 아직 가진 모든 누름을 닫힘의 차례에 놓는다: 호스트는 그 누름의 마지막으로 전달된 `down`이나 `drag`의 점에서 그 창에 그 pointer와 버튼의 `up`을 전달하므로, page는 사람의 뗌처럼 제스처의 뗌을 받는다. 1007로 거부된 뗌은 `host.buttons`가 다음에 마스크 0으로 바뀔 때, 1011로 거부된 뗌은 다음 누름이 끝날 때 전달한다. 이 두 event가 그 거부를 푼다. 다른 이유로 거부된 뗌은 창이 닫히거나 view가 제거되어 누름이 이미 끝났음을 알 뿐 아무것도 끝내지 않는다. 기다리는 뗌과 아무것도 끝내지 않은 뗌은 창, pointer, 버튼, code와 함께 level `info`로 application log에 쓴다. 그래서 끝나는 명령줄, `down`과 `up` 사이에서 멈춘 script, 연결이 닫힌 agent는 열린 누름을 남기지 않는다([명령줄](cli.ko.md)).
- `activate: true`이면 호스트가 애플리케이션을 활성화하고 창을 키 창으로 만든 뒤, 창에서 보이는 모든 webview가 활성 상태를 웹 프로세스에 보낼 때까지 기다렸다가 이동을 전달한다. 사용자가 쓰고 있는 애플리케이션의 키보드 포커스를 가져온다. 키 창이 될 수 없거나, 최소화되었거나, 보이지 않는 창은 곧바로 1006으로 거절한다. macOS는 활성화 요청과 키 창 요청을 들어주면 알림(`NSApplicationDidBecomeActiveNotification`, `NSWindowDidBecomeKeyNotification`)을 보내고 거절하면 아무 이벤트도 보내지 않는다. 어느 단계에도 한도가 없다. 활성화 단계와 키 창 단계는 그 알림, 애플리케이션이 받는 다음 누름이나 key event(배치 hold를 끝내듯, [배치 트랜잭션](native-surfaces.ko.md#배치-트랜잭션)), 창의 닫기로 끝나고, 키 창 단계는 다른 창이 키 창이 되거나 창이 키 창을 내놓을 때(`NSWindowDidBecomeKeyNotification`, `NSWindowDidResignKeyNotification`)에도 끝난다. 들어줌이 아닌 끝은 멈춘 단계(시스템이 애플리케이션을 활성화하지 않음, 창이 키 창이 되지 않음)를 적은 1006을 반환한다. Webview 단계에는 한도가 없다. 보이는 각 webview가 활성 상태를 보냈다고 알린다. 그 전에 애플리케이션이나 창이 활성 상태를 잃으면 곧바로 1006 `the window lost activation before the webviews applied the active state`로 끝나고, 창 닫힘, webview의 입력 등록 끝, 그 프로세스가 응답을 멈췄다는 알림은 1006 `the webviews did not apply the active state`로 끝낸다. native 기록은 그 단계를 끝낸 이벤트를 적는다. 메시지에는 최전면 애플리케이션을 적는다. macOS는 백그라운드로 실행된 뒤 사용자가 활성화한 적 없는 애플리케이션의 자기 활성화 요청을 거절한다(협조적 활성화). 그래서 activation 등급 검사는 사람이 앱을 전환하듯 검사 프로세스에서 `NSRunningApplication`으로 먼저 애플리케이션을 활성화하고, 호스트 요청은 그 뒤 키 창과 webview 단계를 마친다. Webview 단계의 오류는 미완료 visible webview만 기존 role 또는 view identifier와 등록 index로 식별한다. 각 completion은 자신이 등록된 webview만 완료 처리하며, 중복 또는 늦은 completion은 aggregate를 일찍 완료하거나 두 번 완료하지 않는다.
- OS 입력기는 활성 애플리케이션의 키 창에 있는 활성 입력 컨텍스트만 처리한다. 그 키 창이 아닌 창에 보낸 `input.key`는 다른 창이 키 창이면 거부되고, 키 창이 없는 애플리케이션에서는 전달되지만 입력기에 도달하지 않으므로 그 결과는 입력기 증거가 아니다. 문자 키를 입력 컨텍스트에 넘기는 뷰(예: 터미널 그림 영역)는 애플리케이션이 한 번 활성화된 뒤 키 창이 없는 동안 그 키의 문자를 받지 못한다. 입력 컨텍스트가 키를 받고 입력기가 답하지 않기 때문이다. 터미널 그림 영역은 이런 키를 오류 `input method did not answer native keyCode=<code> outside the key window of the active application`으로 보고하고, [virtual key window](#virtual-key-window)에서는 입력기 없이 그 키를 입력한다. 영역이 직접 보고하는 이름 있는 키와 Control 또는 Option 조합은 어느 창에서나 전달된다. web view도 문자 키를 같은 방식으로 입력 컨텍스트에 넘기므로, 애플리케이션이 한 번 활성이었으면 document 영역도 입력 컨텍스트로는 활성 애플리케이션의 키 창에서만 입력한 문자를 받는다. 활성화를 막는 native test처럼 한 번도 활성이 아니었던 애플리케이션은 여전히 받는다. virtual key window에서 web view는 밝힌 text가 있는 문자 키를 대신 자기 text input으로 받는다. 입력기 동작은 활성화 등급 검사로만 검증하고, 터미널 그림 영역과 web view의 문자 입력은 virtual key window에서 검증한다.

Windows 에서 호스트는 `SendInput` 이 아니라 web view 의 DevTools protocol 을 호출한다. `input.pointer` 는 `Input.dispatchMouseEvent`, `input.key` 는 `Input.dispatchKeyEvent` 가 되며, protocol 이 순서를 지키지 않으므로 호출은 앞 호출이 끝난 뒤에 시작한다. web view 의 첫 입력이 `Emulation.setFocusEmulationEnabled` 를 켜므로 다른 창 뒤에 있는 창에서도 `:focus` 가 유지되고, 입력은 시스템 focus 를 가져가지 않는다. press 규칙은 위와 같고, `move` 와 키는 활성이 아닌 창에 1006 으로 답하지 않는다. page 의 mouse pointer 는 하나이므로 창은 버튼마다 press 를 하나 가지고, 열린 press 는 모두 한 pointer 의 것이다. 한 pointer 가 창에서 press 를 쥔 동안 그 창에 대한 다른 pointer 의 `move`, `down`, `drag`, `up` 은 이유 `the page has one mouse pointer` 와 함께 1011 을 반환하고, 그 `scroll` 은 전달된다. 대기 시간 안에 끝나지 않은 호출은 실패로 답하며, 그 호출이 끝날 때까지 이후 입력은 모두 거절된다. `activate: true` 는 시스템에 foreground 를 요청하고, 시스템의 거절이 곧 답이다. `diagnostics.capture.still` 은 `CapturePreview` 를 쓴다. 최소화된 창, 표시되지 않은 창, 숨겨진 web view 는 호출을 받고도 끝나지 않는다는 보고가 있어 곧바로 거절하며, 10 초 안에 끝나지 않은 capture 는 가려진 창을 지목하는 실패로 답한다. 이 경로는 아직 Windows 에서 실행된 적이 없다.

Windows 에서 `control`, `option`, `command` 중 하나가 있고 `text` 가 없는 키는 `code`, `windowsVirtualKeyCode`, modifier 를 가진 `rawKeyDown` 으로 내려가며 `commands` 는 없다. macOS 가 아닌 시스템에서는 Blink 가 이런 key down 을 스스로 편집 명령으로 바꾼다. `third_party/blink/renderer/core/editing/editing_behavior.cc` 는 macOS 가 아닌 시스템의 항목에 `{'A', kCtrlKey, "SelectAll"}` 를 Copy, Paste, Cut, Undo, Redo 와 함께 두고(171~181 행), `EditingBehavior::InterpretKeyEvent` 는 `kRawKeyDown` event 를 key code 와 modifier 로 그 표에서 찾는다(242~284 행). `content/browser/devtools/protocol/input_handler.cc` 는 `rawKeyDown` 을 `kRawKeyDown` event 로(1225~1226 행), `windowsVirtualKeyCode` 를 그 key code 로(1251~1252 행) 만든다. 그래서 Control 과 A 는 `Input.dispatchKeyEvent` 가 실을 수 있는 편집 명령인 `commands`(`third_party/blink/public/devtools_protocol/domains/Input.pdl`, 136~139 행) 없이 페이지를 선택한다. 그 표에서 Meta key 항목은 macOS 에만 있으므로(`editing_behavior.cc`, 150~153 행) Windows 에서 `command` 와 A 는 아무것도 선택하지 않는다. 키로 선택·복사·붙여넣기를 하는 test 는 Windows 에서 `control`, macOS 에서 `command` 를 쓴다. protocol 키는 Windows 입력기를 거치지 않아 조합을 시작하지 않고, `diagnostics.input.source` 는 이 플랫폼에 keyboard input source 가 구현되지 않았다고 답하므로, 조합 test 는 Windows 에서 실행되지 않고 거절된다.


Windows 에서 `host.buttons` 와 창의 press·drag 는 system hook 이 아니라 raw mouse input (`RIDEV_INPUTSINK` 를 준 `RegisterRawInputDevices`) 에서 온다. raw input 은 system 이 입력과 나란히 보내는 사본이므로 사람의 입력이 호스트를 기다리지 않는다. bit 0 은 물리적 왼쪽 버튼, bit 1 은 오른쪽, bit 2 는 가운데, bit 3 과 4 는 네 번째와 다섯 번째 버튼이다. 이 원천의 한계는 다음과 같다. 그 thread 는 다른 애플리케이션 위에서도 mouse 가 움직일 때마다 깨어난다. system 이 raw mouse input 으로 보내지 않는 touch·pen 입력은 아무것도 바꾸지 않는다. press 의 hit test 는 버튼이 바뀐 곳이 아니라 원천이 읽을 때 pointer 가 있는 곳에서 한다. keyboard 는 등록하지 않으므로, macOS 와 달리 키 입력이 어느 view 가 focus 를 가졌는지 호스트에 알려 주지 않는다. integrity 가 더 높은 애플리케이션이 foreground 를 가진 동안 raw input 이 호스트에 닿는지는 관찰하지 않았다.

### Named pointers

`input.pointer`의 `pointer`는 pointer 이름이고, 이것이 없는 요청은 pointer `main`의 입력이다. 각 pointer는 자기 위치, 눌린 버튼, 각 누름을 받은 뷰, 각 누름의 원점을 따로 가지므로 두 pointer가 두 창에서 또는 한 창에서 동시에 누르고 끈다. 실제 cursor는 움직이지 않는다. macOS에서 한 pointer의 입력을 전달하는 동안 `+[NSEvent pressedMouseButtons]`는 그 pointer의 버튼을 답하므로 각 페이지는 자기 gesture의 `buttons`를 보고, 전달 밖에서는 모든 pointer의 버튼을 답한다.

AppKit과 WebKit은 일부 상태를 pointer마다가 아니라 창, 페이지, 애플리케이션마다 하나 둔다. 다른 pointer의 열린 누름과 그런 상태를 공유할 입력은 전달하지 않고, 메시지 `pointer <holder> holds a press that this input would share: <reason>`과 함께 1011을 반환한다. macOS의 경우는 다음과 같다.

- 다른 pointer가 누르고 있는 페이지(좌표의 뷰를 담은 web view 또는 그 뷰 자체)에 대한 `down`: `the page at the point holds its press`. WebKit은 페이지마다 누름 상태를 하나 두고, 페이지가 아직 눌린 버튼을 보고하는 동안의 뗌은 `pointerup`이 아니라 `pointermove`가 된다.
- 다른 pointer가 창에서 누름을 쥔 동안, 누름을 `-[NSApplication sendEvent:]`로 보내는 창(실제로 활성인 애플리케이션의 키 창)에 대한 `down`: `AppKit keeps one press of a window that passes the application`. `NSWindow`는 애플리케이션을 지나는 누름에 대해 버튼마다 대상을 하나 둔다.
- 다른 pointer가 누름을 쥔 창에 대한 `move`: `the window has one hover position`. 창은 진입한 tracking area 집합 하나와 페이지의 pointer 위치 하나를 가진다.
- 시스템 입력기가 입력의 페이지 또는 그 누름의 페이지를 처리할 때(그 페이지가 실제로 활성인 애플리케이션의 키 창에서 current input context를 가질 때), 다른 pointer가 누름을 쥔 동안의 `move`, `down`, `drag`, `up`: `the input method of a page answers after the delivery`. WebKit은 마우스 이벤트를 입력기에 넘기고 전달이 반환된 뒤에 페이지 이벤트를 만들므로 모든 pointer의 버튼을 읽게 된다.

따라서 두 pointer는 누름을 애플리케이션으로 보내지 않는 창(실제로 활성인 애플리케이션의 키 창이 아닌 모든 창, 예를 들어 [virtual key window](#virtual-key-window))에서 서로 다른 페이지나 뷰를 누를 때 한 창에서 동시에 누르고 끈다. `scroll`은 누름을 갖지 않으므로 다른 pointer 때문에 거부되지 않는다. Windows에서는 페이지의 mouse pointer가 하나이므로, 위 Windows 문단대로 다른 pointer는 페이지의 뗌을 기다린다.

### Virtual key window

실제로 활성이 아닌 애플리케이션에서 `input.key`와 `input.pointer`의 `move`는 macOS에서 그 창을 virtual key window로 만든다. 이 창은 애플리케이션 안에서 key window와 main window로 답하고, 애플리케이션은 활성으로 답하므로 WebKit이 hover와 page focus를 갱신한다. 시스템의 key window와 앞 애플리케이션은 바뀌지 않는다. 규칙은 다음과 같다.

- 프로세스에 많아야 하나다. 다른 창으로 보낸 입력은 상태를 그 창으로 옮긴다.
- AppKit은 활성이 아닌 애플리케이션에도 key window를 둘 수 있다. 예를 들어 다른 창이 virtual key window인 동안 host가 보여 준 창이고, 이때 `host.window`는 `key` true와 `active` false를 보고한다. 그 창의 입력은 활성이 아닌 애플리케이션의 입력이다. `move`는 그 창을 virtual key window로 만들고, press는 뷰로 바로 간다.
- method는 첫 진입 때 교체하므로, 그런 입력을 받지 않는 애플리케이션은 교체된 method가 없다.
- 이 창의 입력은 창이나 view로 가며 실제 상태를 읽는 `-[NSApplication sendEvent:]`를 지나지 않는다. 그래서 local event monitor는 이 입력을 보지 못한다.
- Native key producer는 dispatch 전에 원본 event의 `NSEvent.characters`와 `charactersIgnoringModifiers`를 구체화한다. Consumer는 완성된 불변 payload를 받으므로 menu matching이 앞선 observer가 지연된 문자 필드를 읽었는지에 좌우되지 않는다. 시스템 input source의 변환, 물리 key code, modifier flag와 stated-text metadata를 보존하며 Latin 문자로 대체하거나 input source를 바꾸지 않는다.

- 가상 key 경로는 위 shortcut table의 `native menu` 소유권을 시행한다. Command/Control key down을 main menu의 `-[NSMenu performKeyEquivalent:]`에 먼저 보낸다. 활성화된 menu equivalent만 키를 소유하며, 없으면 창의 `-[NSWindow performKeyEquivalent:]`로 보내 view 소유 shortcut과 미등록 shortcut을 보존한다. 둘 다 받지 않는 key down은 `-[NSWindow sendEvent:]`로, key up은 항상 그리로 간다. 이는 가상 input에 대한 프로젝트의 menu 소유권 정책이며 Apple의 기본 view-first dispatch 순서라는 뜻이 아니다. 실제 활성 창의 input은 기존 `-[NSApplication sendEvent:]` 경로를 유지한다. 키의 `input inject` 기록은 `equivalent`와 input hold 뒤에서 기다렸는지(`held`)를 보고한다.
- 창 순서의 자리를 지킨다. `orderFront:`, `makeKeyAndOrderFront:`, `orderFrontRegardless`는 이 창에 대해 거부되고 각각 event `native.input.virtual`을 남긴다.
- 실제 활성화는 그 순간부터 이 상태를 끝내고 실제 상태가 우선한다. `activate: true`는 활성화하기 전에 끝낸다. 창이 닫히면 끝난다. 끝날 때마다 `reason`이 있는 `native.input.virtual`을 하나 남긴다.
- 실제 move, 실제 cursor 위치, 실제 button mask는 이 창의 page에 들어가지 않는다. `host.window`는 합성 입력 위치를 `pointer`로 보고하고, `key`와 `active`는 계속 시스템 상태를 보고하며 그 옆에 `virtualKey`가 있다. 실제 scroll과 실제 press는 그대로 도착하고, 이 창의 실제 press는 애플리케이션을 활성화한다.
- 터미널 그림 영역은 이 창에 답하지 않는 입력기 없이 문자 키를 입력한다. 호출이 `text`를 밝힌 키는 시스템의 입력 소스와 상관없이 그 text를 입력한다. 주입된 event는 `input_inject.h`의 값 `SP_INPUT_STATED_TEXT`를 `kCGEventSourceUserData`에 담고, 영역이 그 surface가 붙잡아 둔 키에서 나중에 받을 때도 그렇다. `text` 없는 키는 현재 입력 소스의 keyboard layout이 만든 문자를 `UCKeyTranslate`와 그 layout의 dead key 상태로 입력하므로, dead key는 아무것도 입력하지 않고 다음 키가 조합된 문자를 입력한다. 한글이나 일본어 같은 입력기 아래의 `text` 없는 키는 오류 `the input source <id> is not a keyboard layout`으로 거부된다. 조합은 시스템만 하고, 그것도 활성 애플리케이션의 키 창에서만 하기 때문이다. 그래서 virtual key window에서 문자를 입력하는 검사는 `text`를 밝히고, 사람의 입력 소스는 바뀌지 않는다.
- document 영역, surface, main page 같은 web view는 호출이 `text`를 밝힌 문자 key down과 이름 있는 key down을 입력기 없이 받는다. 키를 전달하는 동안 그 web view는 입력 컨텍스트 없이 답하므로(WebKit과 `-[WKWebView inputContext]`가 읽는 `-[NSView inputContext]`는 첫 진입 때 교체된다), WebKit은 AppKit이 입력 컨텍스트 없는 view에 하듯 key binding으로 키를 해석한다. 밝힌 text는 키의 명령으로 web view의 `insertText:`에 닿고, 이름 있는 키는 binding의 명령을 실행하므로 Backspace는 `deleteBackward:`를 실행한다. page는 사람의 키가 주는 것을 받는다. 밝힌 text를 `key`로 하는 `keydown`과 `keypress`, 밝힌 text를 `data`로 하는 `beforeinput`과 `input`, 그리고 key up의 `keyup`이다. `keydown`을 취소한 page는 text를 받지 않는다. AppKit은 두 글자 이상인 text의 key up에 시스템 keyboard layout이 그 key code에 주는 문자를 주므로, 그 문자가 그 `keyup`의 `key`다. `text` 없는 문자 키는 전처럼 web view로 가서 그 입력 컨텍스트를 지나고, 입력기는 이 창에서 그 컨텍스트에 답하지 않는다. 키의 `input inject` 기록은 `virtualKeyText`를 밝히며, 그 값은 밝힌 text에서만 true다.
- 키보드를 쥔 채 닫히는 surface와 document 영역은 떠나기 전에 키보드를 content view에 넘긴다. 그러지 않으면 AppKit이 다음 first responder 변경까지 그 view를 붙들어, 닫힌 page와 그 data store가 끝나지 않는다.

실제 입력 경로를 검사하는 테스트는 `input.pointer`와 `input.key`만 사용한다. 테스트는 상태 준비에만 `element.act`를 사용한다.

## 전달

호스트와 페이지는 다음 메시지를 주고받는다. 이 메시지는 코어 내부용이며 엔드포인트에 포함되지 않는다.

| 방향 | 메시지 | 내용 |
| --- | --- | --- |
| 호스트 → 메인 페이지 | 이벤트 `exposure-request` | 코어와 플러그인 이름에 대한 `exposure.list`, `status.*`, `command.run`, `element.*`의 `{id, method, params}`. 요청에는 시간 제한이 없다. 메인 페이지가 명령을 전달하든 스스로 답하든 그 답으로 끝난다. 준비되지 않은 메인 페이지는 1003을 반환하고, 메인 페이지의 다시 읽기, 닫기, WebContent 프로세스의 끝은 그 요청을 1003으로 끝내며, 요청을 보낸 endpoint 연결의 끝은 호스트에서 그 요청을 끝내고 호스트는 아무것도 답하지 않는다 |
| 메인 페이지 → 호스트 | 호출 `exposureReply` | `{id, result}` 또는 `{id, error: {code, message}}` |
| 메인 페이지 → 호스트 | 호출 `exposureChanged` | 감시 중인 상태의 `{name, surface?, value}`. 감시가 표면을 지정했으면 `surface`가 있다. 호스트는 `host.`로 시작하는 이름을 `the page cannot change host status <name>`으로 거부한다. host 상태는 호스트만 바꾼다 |
| 표면 페이지 → 호스트 | 호출 `exposureRegister` | `{surface, kind, name}`. `kind`는 `status`, `command`, `element` 중 하나다. view의 페이지는 surface 브리지가 없다. view 채널을 통해 `runtime.native.call`에 `{name: "registered", payload: {kind, name}}`로 호출하고([view surfaces](native-surfaces.ko.md#view-표면)), 메인 페이지가 이 호출로 전달한다. 메인 페이지가 전달한 등록은 view를 가진 surface에만 허용된다 |
| 호스트 → 메인 페이지 | 이벤트 `exposure-registered` | `{surface, kind, name}`. 표면이 제거되면 `{surface, closed: true}`. 표면은 메인 페이지를 다시 읽어도 남으므로 메인 페이지가 준비를 알린 뒤 호스트가 살아 있는 등록을 모두 다시 보낸다 |
| 메인 페이지 → 호스트 | 호출 `exposureForward` | 표면 페이지가 등록한 이름에 대한 `{id, surface, method, params}`. 요청에는 시간 제한이 없다. 표면 문서의 답으로 끝나며, 요청을 보낸 endpoint 연결의 끝은 호스트에서 그것을 끝낸다. 표면 문서가 닫히거나, 표면 페이지의 WebContent 프로세스가 끝나거나, 창의 페이지가 다시 로드되면 그 뒤에는 답이 올 수 없으므로 요청은 그 이벤트의 turn에 1003으로 끝난다 |
| 호스트 → 표면 페이지 | 이벤트 `exposure-request` | `{id, method, params}`. view의 경우 이벤트는 `surface`를 담고, 메인 페이지가 view의 `exposure-request` 구독(`runtime.native.on`)을 통해 view에 전달하며, `data`는 `{id, surface, method, params}`다 |
| 표면 페이지 → 호스트 | 호출 `exposureReply` | `{id, result}` 또는 `{id, error}`. 호스트는 이 값을 `exposureForward`의 결과로 메인 페이지에 반환한다. view의 페이지는 `runtime.native.call`에 `{name: "exposureReply", payload: {id, result\|error}}`로 답하며, 메인 페이지가 view의 surface와 함께 이 호출로 보낸다 |
| 메인 페이지 → 표면 페이지(`exposureForward` 경유) | `status.watch`, `status.unwatch` | `{name}`. 표면 페이지가 값 추적을 시작하거나 멈춘다. `status.watch` 뒤에는 그 이름을 이미 watch하고 있어도 현재 값을 `changed`로 보내고, `status.unwatch`까지 그 뒤의 다른 값을 각각 보낸다. 이름의 첫 `status.watch`는 첫 읽기가 끝날 때 답한다: 값을 `changed`로 보낸 뒤 `null`로, 또는 읽기의 실패로 답하며, 실패는 같은 차례에 watch를 끝내므로 그 이름의 다음 `status.watch`가 다시 읽고 값을 보낸다. 첫 읽기가 도는 동안의 `status.watch`는 같은 읽기가 끝날 때 같은 결과로 답한다 |
| 표면 페이지 → 메인 페이지 | `changed` | watch된 status의 각 값에 대한 `{name, value, version}`. `version`은 1에서 시작해 다른 값마다 하나씩 커진다. 메인 문서의 표면 페이지는 그것을 registry에 준다. view의 페이지는 view 채널로 `runtime.native.call`에 `{name: "changed", payload: {name, value, version}}`을 보낸다([view 표면](native-surfaces.ko.md#view-표면)). 메인 페이지는 그것을 그 표면과 이름의 watch 중 마지막 version이 더 오래된 watch에 전달하므로, 더 새 변화 뒤에 도착한 변화는 전달하지 않는다. 어느 watch도 받지 않은 값은 trace event `workbench.trace.surface.change.dropped` `{surface, name, version, reason}`로 쓰며, `reason`은 `no watch` 또는 `older than version <n>`이다. 호스트는 이것에 대한 메시지를 나르지 않는다 |
| 호스트 → 메인 페이지 | 이벤트 `diagnostics-tick` | 내용 없음. 진단 빌드에서만 `diagnostics.drag`의 단계마다 한 번 보낸다 |
| 표면 페이지 → 메인 페이지 | 없음 | view는 call `runtime.status.watch`로 status를 따라간다. 메인 페이지는 이 document의 registry observation으로 답한다. core status는 이 document에서 따라가고, plugin status는 그것을 등록한 표면을 통해 따라가며, 이 표의 `status.watch`, `status.unwatch`, `changed`를 쓴다. 이 watch에는 호스트 메시지가 없다([view 표면](native-surfaces.ko.md#view-표면)). |

메인 페이지는 이름을 등록하거나 전달하기 전에 선언과 대조해 검증한다. 불러온 배치에 아직 없는 표면의 등록은 보관했다가, 그 표면을 담은 배치를 불러오면 반영하거나 거부한다. 메인 페이지의 `exposureReply`는 호스트의 `exposure-request`에 대한 응답이고, 표면 페이지의 `exposureReply`는 전달된 요청에 대한 응답이다. 호스트는 호출한 웹뷰로 호출자를 구분한다.

표면 페이지는 표면이 제거된 뒤에 전달된 요청에 답할 수 있다. 예를 들어 표면이 닫히면서 답하는 `command.run`이 그렇다. 호스트는 표면을 제거할 때 그 표면에 보낸 모든 요청을 이미 1003으로 끝냈으므로 그 답에는 답할 요청이 없다. 호스트는 호출을 거부하지 않고 그 답을 버리며, 관측 `exposure reply <id> of removed surface "<surface>" arrived after its request ended`를 애플리케이션 로그에 쓴다. 표면은 남은 채 문서가 닫히거나 다시 불러와져서 호스트가 1003으로 끝낸 요청도 같다. 그 요청에 대한 답은 버리고 관측 `exposure reply <id> arrived after its request ended`로 쓴다. 호스트는 끝난 요청을 최근 256개까지 기억하며, 그 밖의 id에 대한 답은 여전히 `exposure reply <id> has no matching request`로 실패한다.

런타임 모듈은 이 호출을 프레임워크 바인딩에 대응시킨다.

| 호출 | Wails 메서드 | Tauri 명령 |
| --- | --- | --- |
| `exposureReply` | `ExposureReply` | `exposure_reply` |
| `exposureChanged` | `ExposureChanged` | `exposure_changed` |
| `exposureForward` | `ExposureForward` | `exposure_forward` |
| `exposureRegister` | `ExposureRegister` (표면 브리지와 메인 페이지) | `exposure_register` |

표면 페이지의 페이지 인터페이스는 `page.exposure`이며 `register(kind, name)`, 전달된 요청마다 `fn({id, method, params})`를 호출하는 `onRequest(fn)`, `reply(id, payload)`로 구성된다. 메인 페이지는 `host.on("exposure-request", fn)`, `host.on("exposure-registered", fn)`, 그리고 위 호출을 담은 `host.call(...)`을 사용한다. `surface`가 없는 응답은 창의 메인 문서 요청에 대한 답이고, `surface`가 있는 응답은 그 표면 문서 요청에 대한 답이며 비어 있지 않은 문자열로 표면을 가리킨다. `surface`가 `null`, 빈 값, 문자열이 아니면 메인 문서 응답으로 처리하지 않고 오류로 거부한다.

## 오류

| 코드 | 의미 |
| --- | --- |
| -32601 | 선언되지 않은 메서드 |
| -32602 | 잘못된 매개변수. 타입이 틀린 값을 포함한다 |
| 1001 | 알 수 없는 이름 |
| 1002 | 선언되었지만 등록되지 않은 이름 |
| 1003 | 소유 문서가 더 이상 없음 |
| 1004 | 이 플랫폼에서 네이티브 입력을 사용할 수 없음 |
| 1005 | 요청이 결과 없이 끝났다: 기다림을 끝낸 이벤트가 결과보다 먼저 왔다. 문서가 입력을 받지 못했거나 macOS가 전체 화면 전환에 실패한 경우다 |
| 1006 | 창이 활성 상태가 아님: 실제로 활성인 애플리케이션에서 `move`와 키에는 그 키 창이 필요하거나, 시스템이 애플리케이션을 활성화하지 않음 |
| 1007 | AppKit이 0이 아닌 `NSEvent.pressedMouseButtons` 마스크를 보고해 합성 포인터 `down`이나 `up`을 전달하지 않음. 메시지는 거부 시점의 마스크와 frontmost 애플리케이션을 보고함 |
| 1008 | pointer의 그 버튼 누름이 아직 열려 있어 포인터 `down`을 전달하지 않음 |
| 1009 | element 요청의 address 에 해당하는 element 가 없음 |
| 1010 | element 가 열린 dialog 뒤에서 inert 이므로 동작을 전달하지 않음 |
| 1011 | 다른 pointer의 열린 누름이 입력이 공유할 상태를 쥐고 있어 입력을 전달하지 않음. 메시지는 그 pointer와 상태를 밝힌다([named pointers](#named-pointers)) |
| -32000 | 등록된 명령이나 status 처리기가 실패함. `message`는 그 오류 메시지다 |

중계한 요청은 그 답이나 상대의 끝으로만 끝나므로, 그 문서는 끝난 요청에 답을 보내지 않는다. 예외는 endpoint 연결의 끝이 끝낸 요청이다. 호스트는 끝난 요청에 온 답을 받아 관찰 `exposure reply <id> arrived after its request ended`로 쓰고 아무것도 답하지 않는다. 중계가 보낸 적 없는 요청에 온 답은 `exposure reply <id> has no matching request`로 실패한다.

[로컬 엔드포인트](endpoint.ko.md)는 선언되지 않은 메서드를 받으면 연결을 종료한다.

### 창이 소유하는 애플리케이션 메뉴 동작

`host.menu.select`는 요청의 창에서 항목을 실행한다. 창은 플랫폼 포트와 native interface를 거쳐 선택까지 전달되며, 호스트는 다른 창을 고르지 않는다. target이 있는 항목은 그 target에 action을 보낸다. target이 없는 항목은 요청한 창의 first responder부터 그 responder chain을 따라, 그다음 애플리케이션과 그 delegate에 action을 보내며, key window의 responder chain을 거치지 않는다. 선택은 애플리케이션이 활성일 때와 아닐 때 똑같이 동작하고, 창을 활성화하거나 순서를 바꾸지 않는다.

선택은 경우마다 다른 이유로 실패한다: 창이 없음, 메뉴나 항목 제목이 없거나 UTF-8이 아님, 메뉴가 없음, 항목이 없음, 항목에 action이 없음, action을 처리할 responder가 없음. Go와 Rust host의 오류는 요청한 창, 메뉴, 제목을 이유에 더한다.
