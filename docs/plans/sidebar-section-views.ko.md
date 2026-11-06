# Sidebar section view

[English](sidebar-section-views.md)

이 proposal은 sidebar section이 그 plugin의 view가 되는 방식을 적는다(F332). 승인된 내용을 명세에 넣은 뒤 지운다.

## 문제

sidebar section은 declared UI다. plugin이 list, tree, button, status-line 요소로 된 status 값을 보내면 workbench가 그린다(`docs/spec/plugin-processes.ko.md#층-규칙`, `docs/spec/declared-ui.ko.md`). 그래서 plugin 내용을 그리는 일이 core의 기능이다. files tree는 `packages/workbench/declared-ui.js`가 그리고, F13-2-5가 정한 `@pierre/trees`의 디자인을 잃었다. plugin은 자기 view를 그리는 수단으로 section을 그릴 수 없다.

## 규칙

plugin은 자기가 가진 모든 화면을 어떤 수단으로든 그린다. 손으로 쓴 DOM, framework, library, 또는 image region에 놓인 sidecar 그림이다. core는 자리를 주고 exposure 계약만 요구한다. 모든 조작 요소는 공유 binder로 선언된 command에 연결되고 element name을 가지며, 모든 보이는 상태는 선언된 status다([exposure](../spec/exposure.ko.md)). sidebar section도 그런 화면이다.

## 결정

- **D1 형식.** `plugin.json`의 section은 `{id, name, composition, height, unload?}`다. `unload`는 `surface.unload`의 형식이고 memory saver가 section surface를 unload하게 한다. 그것이 없으면 `surface.unload` 없는 surface의 tab처럼 unload되지 않는다. `composition`은 kind `view`인 `surface.composition`의 형식이다([plugins](../spec/plugins.ko.md#pluginjson)). 그래서 surface 없이 section만 가진 plugin도 각 section의 page와 region을 선언한다. `height`는 `"fill"` 또는 point 단위의 양의 정수다. fill section은 다른 열린 section이 쓰고 남은 높이를 나눠 쓰고, 다른 열린 section은 선언한 높이를 가진다. `status`, `module`, `fill`을 가진 section은 manifest를 읽을 때 `plugin <id>: section <section id> <field> is removed; a section takes composition and height`로 거부되고, 다른 형식의 `height`는 `plugin <id>: section <section id> height must be "fill" or a positive integer`로 거부된다. `sections`를 가진 plugin은 `surface`를 가진 plugin처럼 `dependencies`를 선언할 수 있다.
- **D2 Surface.** 그려진 section마다 그 plugin의 view surface, 곧 *section surface*가 하나 있고, tab마다 view가 하나인 것처럼 section마다 view가 하나다. surface id는 `<space id>/<sidebar id>/<section id>`다. id가 `/`를 가지므로 tab session 파일 이름은 id의 percent-encoding이다([persistence](../spec/projects.ko.md#저장)). sidebar는 section을 한 번만 가지고 id가 sidebar를 밝히므로, 두 sidebar에 연결된 set은 section surface 둘을 낸다. `core.surfaces`는 tab surface 옆에 section surface를 `kind` `section`과 그 sidebar와 함께 나열한다. page는 tab page처럼 자기 composition을 선언하고, host는 tab처럼 view를 만들고 놓고 놓아준다.
- **D3 수명과 메모리.** section surface는 그 section이 창의 space에 있는 sidebar에 있는 동안 있다. tab view가 그 tab이 그런 space에 있는 동안 있는 것과 같다. 보이지 않는 space의 section은 숨겨진다. 접힌 section, `tabs` set에서 선택되지 않은 tab의 section, 꺼진 sidebar의 section은 비활성 tab처럼 숨겨진다. memory saver는 tab과 함께 section surface를 관찰하고, 숨겨진 section surface를 숨겨진 tab의 규칙으로 unload한다([tab memory](../spec/exposure.ko.md#tab-memory)). section은 다시 보일 때 그것을 다시 보인다. `core.tab.memory`는 section surface를 `kind` `section`으로 나열한다. `core.tab.unload`, `core.tab.keep`, `core.tab.menu`는 tab을 받고 section surface id를 거부하므로, section은 memory saver만 unload한다. layout이 가지는 surface(`layoutSurfaces`)는 그 tab과 그 card sidebar와 window sidebar의 section surface다. 그래서 tab state store와 tab session store는 load할 때 section surface의 항목을 유지한다. surface는 section이 sidebar의 set에서 빠질 때, sidebar가 없어질 때, sidebar를 가진 card가 닫힐 때 놓아준다. 아래 사건 표가 적용된다.
- **D4 시작 값.** section surface의 시작 값은 view의 시작 값이다. `params`는 `null`, `origin`은 tab이 열지 않았으므로 `{directory: null}`이며 workbench는 tab의 origin 기록 없이 이를 정한다. `project`는 창의 project이고, 새 member `section`은 `{id, sidebar, card}`다. `card`는 sidebar를 가진 card의 id이고, window sidebar에서는 `null`이다. 두 host는 `section`을 전달하고 검사하고 주입하며, tab surface에서는 `null`이다. host contract가 이를 적는다.
- **D5 따라가는 surface.** `core.sidebars`는 각 section의 `surface`를 보고한다. sidebar를 가진 card의 활성 tab이고, window sidebar에서는 포커스된 card의 활성 tab이며, 없으면 `null`이다. view call `runtime.status.watch`와 `runtime.status.unwatch`는 선택 인자 `surface`를 받는다. 이는 창에 있는 view의 plugin의 surface이고, 그러면 plugin의 status를 그 surface에서 따라가며, watch는 이름과 surface로 구분된다. section view는 `core.sidebars`를 따라가고, `surface`로 그것이 보고하는 surface의 status를 따라간다. 그 surface가 바뀌면 이전 surface를 unwatch하고 새 surface를 watch한다. `surface` 없는 요청은 section surface를 고르지 않는다([표면 선택](../spec/exposure.ko.md#표면-선택)).
- **D6 방향.** `core.sidebars`는 각 sidebar의 방향(`horizontal` 또는 `vertical`)을 보고하고, section view는 그에 따라 내용을 배치한다.
- **D7 높이.** 높이는 D1의 선언에서 온다. core는 내용 높이를 읽지 않고 view도 보고하지 않으므로, 높이 변경이 layout을 시작하지 않는다.
- **D8 틀과 자리.** core는 sidebar 틀만 그린다. 이름을 가진 section 머리, 접기(`core.sidebar.section.fold`), tab(`core.sidebar.section.select`), 높이, sidebar의 status line이다. compositor는 card sidebar와 window sidebar에서, 그려진 각 section의 body를 card 자리 옆에 section surface id로 구분한 자리로 재며, 모든 section 자리를 잰 뒤에만 layout이 완료된다. 모든 section surface는 자리를 가진다. 숨겨진 section의 자리는 재지 않은 tab surface처럼 `visible` false와 크기 0의 frame을 가진다.
- **D9 재시작.** section surface의 재시작 한도는 tab의 view surface 기록으로 section surface마다 세며, 그 기록은 section surface id를 밝힌다. 한도를 넘으면 section body는 오류 표시로 오류를 보인다. `docs/spec/plugin-processes.ko.md`의 rule 5는 section surface의 기록을 지우는 사람의 행동을 밝힌다. section을 펼치기, 그 tab을 선택하기, 그 sidebar의 set을 바꾸기이고, 그러면 view가 다시 시작한다.
- **D10 제거.** 아래 표의 이름을 지운다. 지운 필드를 선언한 plugin release는 reader가 그 필드를 밝히는 오류로 거부한다.
- **D11 Release.** 각 plugin은 이 변경을 담은 core를 포함하는 `engines.soksak` 범위로 따로 release한다.
- **D12 비용.** unload되지 않은 그려진 section마다 web view process가 하나 돈다. files는 둘까지, browser는 넷까지다. 비용은 개발 뒤 benchmark로 잰다.
- **D13 Project data.** view call `runtime.data.get {key}`과 `runtime.data.set {key, value}`는 호출한 view의 시작 값에 있는 project의 plugin `data` key를 읽고 쓴다. main page는 그 project의 project data store에서 답한다. 그래서 다른 project의 숨겨진 view는 자기 project만 읽고 쓰며, 보이지 않는 project에 쓴 값은 그 project에 저장된다. 보이는 project에 답한다는 `docs/spec/plugins.ko.md:130`의 문장은 바뀐다. `data`는 더 이상 `host`를 요구하지 않고 `surface`나 `sections`를 요구한다.

### 사건

| 사건 | Section surface |
| --- | --- |
| Space 전환 | 떠난 space의 section은 그 space의 tab view처럼 숨겨지고, memory saver가 자기 규칙으로 unload한다(D3). |
| Project 전환 | 창은 다른 project의 layout을 보인다. 이전 layout의 section은 space 전환의 규칙을 따르고 시작 값의 project를 유지하며, data 호출은 그 project를 대상으로 한다(D13). |
| Page reload | 모든 section surface는 tab surface처럼 물러나고, 다시 불러온 page의 section으로 다시 만들어진다. |
| 접기, 선택되지 않은 tab, sidebar 끔 | 숨겨지고, memory saver가 unload한다(D3). |
| section이 set에서 빠짐, sidebar 없어짐, card 닫힘 | 놓아준다. |

section view 위의 입력과 focus는 tab view처럼 [네이티브 뷰 위의 입력](../spec/native-surfaces.ko.md#네이티브-뷰-위의-입력)을 따른다.

### 지우는 이름

| 지움 | 대체 |
| --- | --- |
| Declared UI: `declared-ui.js`, `declared-section.js`, `declared-source.js`, `docs/spec/declared-ui.md`, declared UI snapshot message, `core.declared-ui.tree.*` | section view가 자기 내용을 그린다. |
| section `status`, `fill`과 `data-fill`(`sidebar-sections.js:226-227`, `app.css:673-676`, `test/sidebar-sections.test.mjs:89-93`), `fill` 검사(`plugin-api/index.js:810`, `:824-825`) | section `composition`, `height`와 `height: "fill"`. |
| Plugin host: `plugin-host.js`, `host`, `docs/spec/plugin-host.md`, `host.plugin-host.*`와 `host.trace.plugin-host.*` 기록, `core.plugin.losses`, `core.plugin.views`, `core.plugin.open-calls`의 plugin host 항목 | section view. 세 status는 view 항목을 유지한다. |
| `plugin.json`의 `hostOperations`와 `sidecar.json`의 `hostReadOperations` | `dependencies`의 view sidecar 호출. |
| plugin host를 통한 `data`(`plugin-data.js`, `environment.js:115`, `plugin-api/index.js:679-681`의 `host` 요구) | `runtime.data.get`과 `runtime.data.set`으로 plugin의 view가 읽고 쓰는 `data`(D13). |
| status `core.plugin.snapshots`, `element.rect`와 `element.act`의 control address와 오류 1009, shortcut table의 declared tree key, view event `declared-ui.expanded`와 `declared-ui.snapshot` | 없음: section의 view가 자기 control과 key를 맡는다. |
| host event `declared-ui-source-registered`와 `declared-ui-source-ended`, query `declaredSourceOrigins` | 모든 view source의 generation을 유지하는 `view-source-registered`, `view-source-ended`, `viewSourceOrigins`. |
| element name `core.sidebar.section.control`과 `core.sidebars`의 control 수 | binder audit가 다루는 plugin의 element name. |
| 이 이름을 쓰는 window check(`e2e/files.test.mjs`, `e2e/editor.test.mjs`, `e2e/declared-sidebar-control.mjs`) | section view의 항목을 쓰는 check. |

`docs/spec/native-surfaces.ko.md`는 section surface의 origin과 시작 값의 member `section`을 적고, host contract는 둘을 적는다. `docs/spec/plugin-processes.ko.md`의 layer rule과 rule 5, `docs/spec/plugins.ko.md`(`sections`, 높이, 84행의 plugin 요구, `dependencies`, 127-130행의 `data`), `docs/spec/native-surfaces.ko.md`의 제공되는 view call(150-160행), `packages/plugin-api/index.js:679-681`과 `:698-700`의 검사, `packages/plugin-api/terms.json`의 용어 *section surface*와 *card surface*가 같은 변경에서 바뀐다.

## Review

Round 1 반론과 판정:

1. compositor는 card만 자리로 삼으므로 section surface가 보이지 않는다(`compositor.js:370-402`, `plane.js:1413-1433`). 받아들임: D8.
2. origin을 만들 수 없고(`surface-modules.js:266-318`, `tab-reports.js:226-229`, `native-surfaces.md:191`), `section`은 새 시작 값 member다. 일부 받아들임: `{directory: null}`은 directory를 기록하지 않은 origin의 정해진 형식이고, section은 연 tab이 없으므로 이는 버려진 origin을 채운 것이 아니라 그 값이다. workbench는 `tabOrigin` 없이 이를 정한다. 새 member는 받아들임: D4.
3. section은 composition이 없다(`environment.js:34-100`). 받아들임: D1.
4. `runtime.status.watch`는 `{name}`만 받는다(`native-surfaces.md:154`). 받아들임: D5.
5. 숨겨진 section은 unload되지 않고, state store는 어떤 layout도 가지지 않은 key를 지운다(`plugin-processes.md:17-25`, `tab-session.js:99-101`). 받아들임: D3.
6. 재시작 한도는 사람이 surface를 열 때만 지워진다(`plugin-processes.md:118-120`). 받아들임: D9.
7. 높이 보고는 제공되지 않고, 잘못된 값을 잘라내며, 반복될 수 있다. 받아들임: D1과 D7은 선언된 높이를 쓴다.
8. 제거 목록에 `data`, `hostOperations`, `core.plugin.*`, control 이름, check가 빠졌다. 받아들임: 지우는 이름 표.
9. plugin release가 한 core release에 묶인다. 받아들임: D11.
10. layer rule과 용어가 D2와 모순된다. 받아들임: 표 아래에 적었다.
11. surface 식별과 `core.surfaces`가 정해지지 않았다. 받아들임: D2.
12. space, project, reload, 입력이 다뤄지지 않았다. 받아들임: 사건 표.

Round 2 반론과 판정(round 1의 반론 2, 5, 6, 8, 11, 12는 일부 열려 있었고 이것으로 답한다):

- N1 layout store와 memory saver는 tab만 가진다(`projects.js:98-105`, `:263-264`, `tab-state.js:89-90`, `tab-session.js:99-100`, `memory-saver.js:212-218`, `core-exposure.js:554-555`). 받아들임: D3.
- N2 숨겨진 section은 잰 자리가 없어 layout이 완료되지 않는다. 받아들임: D8.
- N3 `dependencies`는 `surface`, `host`, `contributes`를 요구한다(`plugin-api/index.js:698-700`). 받아들임: D1.
- N4 rule 5는 surface를 열 때만 기록을 지우고, 기록이 밝혀지지 않았다(`plugin-processes.md:118-120`). 받아들임: D9.
- N5 view bridge는 `name`만 전달하고, watch는 이름으로 구분되며, 기본 선택이 section을 고를 수 있다(`view-calls.js:243-247`, `exposure.md:168`). 받아들임: D5.
- N6 `fill` 사용처가 목록에 없다. 받아들임: 표.
- N7 `data`에 view call이 없다. 받아들임: D13과 표.
- N8 `hostReadOperations`와 `core.plugin.*` status가 정해지지 않았다. 받아들임: 표.
- Round 1 반론 2의 남은 부분: `native-surfaces.md:189`와 `:191`이 변경 목록에 있고, workbench는 `tabOrigin` 없이 section의 origin을 정한다(D4).

Round 3 반론과 판정:

- A space 전환에 규칙이 둘이고, tab을 여는 것은 section process의 기록을 지우지 못한다. 앞의 것은 다른 해법으로 받아들임: 보이지 않는 space의 section은 놓아주지 않고 그 tab view처럼 숨겨지며 memory saver가 unload한다. 한 space의 section과 tab은 한 규칙을 따르기 때문이다(D3, 사건 표). 뒤의 것은 받아들임: D9는 section에 대한 행동만 밝힌다.
- B 이전 project의 section이 보이는 project의 data를 읽게 된다. 다른 해법으로 받아들임: data 호출은 호출한 view의 시작 값에 있는 project를 대상으로 하므로(D13) project 전환에서 section을 놓아주지 않는다.
- C view call 목록과 `plugins.md:127-130`이 변경 목록에 없고, surface나 sections 없는 `data`는 읽는 쪽이 없다. 받아들임: D13과 변경 목록.

Round 4 반론과 판정:

- N1 D13은 view의 project에 답하면서 `plugins.md:130`의 보이는 project 규칙을 인용했다. 받아들임: D13은 자기 규칙을 적고 그 문장을 바꾼다.
- N2 지우는 기록에 `host.trace.plugin-host.*`가 빠졌다. 받아들임: 표.

Round 5에서 남은 반론은 없다.

## 답한 반론

- plugin의 view가 열려 있지 않을 때도 값을 보여야 하는 section은 plugin host가 필요했다. D3에서는 section 자체가 view이므로, 그려진 동안 자기 값을 스스로 낸다.
- F238-d review는 files sidebar를 declared UI에 두었다. 그 이유는 이 proposal이 바꾸는 layer rule이었다. 다른 조건(rename, drag and drop, pointer menu가 없음)은 view가 이를 가질 수 있으므로 필요 없다.
