# 메모리 절약

[English](memory-saver.md)

F198의 대기 중인 제안이다. 승인된 내용은 `docs/spec/plugins.md`, `docs/spec/settings.md`, `docs/spec/exposure.md`, `docs/spec/hosts.md`, `docs/spec/logging.md`로 옮기고 이 파일은 지운다.

## 문제

보이지 않는 tab은 해제되지 않는다. `packages/workbench/index.html`의 `dormant()`는 보이지 않는 모든 tab을 보이지 않는 surface로 commit한다: 각 카드의 다른 tab, 모든 space와 project의 모든 tab이다. `disposeSurfacesExcept`는 더 이상 존재하지 않는 tab만 해제하고, surface는 tab이 닫힐 때만 해제된다(`closeTab` → `disposeSurface`). 숨겨진 document tab은 WebContent process와 page를, 숨겨진 DOM tab은 main page process 안의 DOM과 객체를, 숨겨진 image tab은 image region을 유지한다. F196.29는 숨겨진 document region의 back-forward cache를 비우지만, 보이는 page와 process는 남는다.

## 결정

core는 숨겨진 tab을 내리고, 다시 보일 때 저장된 상태로 복원한다. 설정 하나로 켜고 끈다. 언제 할지는 core만 정한다; plugin은 자기 tab을 내릴 수 있는지 선언하고 상태를 최신으로 유지한다.

용어: **unload**(layout에 남아 있는 tab의 surface를 해제한다)와 **restore**(내려진 tab을 상태로부터 다시 mount한다). 이 두 동작을 다른 낱말로 부르지 않는다.

### 규칙

1. **core가 정한다.** tab을 언제 unload하고 restore할지는 core만 정한다. plugin은 timer나 unload 판단을 두지 않는다.
2. **모든 plugin이 선언한다.** `plugin.json`의 surface는 `surface.unload`를 선언한다: `false`이거나, tab을 내릴 수 있는 plugin이면 `{format, maxBytes}`다. plugin이 `background`를 선언하지 않으면 필수이고, 선언하면 금지다: background session을 가진 plugin은 background 경로(F192)로 session을 유지한다. `validateManifest`는 어느 규칙이든 어긴 manifest를 거부한다. `false`를 선언한 plugin의 tab은 내리지 않고 status에 이유 `undeclared`로 나타난다; `background`를 가진 plugin의 tab은 이유 `background`로 나타난다.
3. **상태는 바뀔 때마다 쓰고, 즉시 메모리에 두며, tab별로 저장한다.** 선언한 plugin은 필요한 상태를 JSON으로, 바뀔 때마다 `context.tab.state.write(value)`로 쓴다. 쓰기는 메모리에 동기로 들어가므로 같은 task의 unload가 최신 값을 본다. core는 이것을 tab별로 `{format, value}`로 tab 상태 store에 저장하고(저장 format 참고), 메모리의 값은 버리지 않고 저장된 값은 1초 안에 그것을 따라간다(저장 format 참고); tab의 각 store 쓰기는 event `page.tab.state.stored {tab, bytes}`다. JSON이 아니거나 `maxBytes`를 넘는 값은 tab과 크기를 적은 오류로 거부한다. surface가 dispose된 뒤 이전 context의 `state.write`는 tab과 `disposed`를 적은 오류로 거부되고 context마다 한 번 기록되므로, 이전 instance가 restore된 instance의 상태를 덮어쓰지 못한다; plugin은 dispose에서 abort되는 기존 `context.closing` signal로 진행 중인 작업을 멈춘다. restore된 surface는 `context.tab.state.read()`로 읽고, store에 그 tab의 항목이 없으면 `null`이다; 선언한 것과 다른 저장 format은 tab과 찾은 format을 적은 restore 오류로 거부한다. 이 API로 쓴 상태만 unload, crash, 재시작 뒤에 남는다; 각 plugin은 무엇을 잃는지 자기 명세에 적는다.
4. **보호.** 다음 중 하나라도 해당하면 tab을 내리지 않는다; 각각 규칙 7의 열거에 있는 이유이고, tab은 여러 이유를 가질 수 있다:
   - `shown`: 보이는 space에서 그 카드의 보이는 tab.
   - `recent`: 보인 지 지연 시간이 지나지 않았다.
   - `keep:modified`: tab이 기존 `context.tab.modified`로 저장되지 않은 변경을 보고한다; core는 tab 보고(`tabModified`)에서 읽으므로 호출 하나가 그 사실을 가진다. 보고한 tab은 깨끗하다고 보고할 때까지 유지된다.
   - `keep:busy`: surface가 `context.tab.keep("busy", on)`으로 진행 중인 작업을 보고한다. surface가 dispose되면 끝난다.
   - `media`: document region이 media를 재생한다. 판단할 때마다(지연 마감, pressure 알림, `core.tab.unload`) core가 region에 묻고 web view의 public `requestMediaPlaybackState` 응답을 기다린다; `playing`이 tab을 보호한다. region이 사라진 경우처럼 실패한 응답은 이유 `media-unknown`으로 tab을 보호하고 기록된다. 진행 중인 camera나 microphone capture는 별도 이유 `capture`이고, 같은 판단 단계에서 public `cameraCaptureState`와 `microphoneCaptureState`를 읽는다. picture in picture 안의 멈춘 media는 다루지 않는다: WebKit은 public picture in picture 상태를 보고하지 않는다; 화면 capture는 region이 `getDisplayMedia`를 허락하지 않으므로 다루지 않는다.
   - `form`: document region의 frame에 그 frame의 document가 load된 뒤 trusted `input` event를 받은 편집 가능한 요소(form field나 `contenteditable`)가 있다. WebKit에는 이것의 public 엔진 상태가 없으므로, region content world에서 모든 frame에 주입한(`forMainFrameOnly` 끔) region script가 보고한다. native region은 script message의 frame 식별자를 key로 한 map에 표시를 둔다; frame의 `pagehide`와 form `submit`은 그 표시를 지우고, main frame navigation commit이나 reload는 map을 지운다. 등록된 `beforeunload` handler는 보호가 아니다: content world는 page의 listener를 볼 수 없다. `form` 표시는 그 event 중 하나가 올 때까지 남으므로, 사용자가 고친 field를 두고 떠나면 tab은 올라온 채 남는다; 사용자는 이동하거나 `core.tab.unload`로 놓는다.
   - `kept`: 사용자가 `core.tab.keep`으로 tab을 계속 올려 두도록 표시했다; 표시는 tab 상태 store에 둔다.
   - `off`: 설정이 꺼져 있다.

   region은 download하지 않는다: view가 보일 수 없는 navigation은 실패하거나 취소되므로 download 보호는 없다. download 지원은 자기 보호를 가진 별도 항목이 된다.
5. **두 가지 계기.**
   - `delay`: 보호 없이 지연 시간(기본 2시간, 주요 기본값의 크기) 동안 숨겨진 tab을 내린다. core scheduler 하나가 각 tab이 숨겨진 monotonic 시각으로 계산한 가장 이른 마감을 가지고, 그것을 바꾸는 기존 event(tab 표시나 숨김, 보호 변화, 설정 변화)에 다시 맞춘다. 경과 시간에는 event source가 없어서 timer를 쓰고, code와 명세가 그 이유를 적는다. 마감에 `media`나 `media-unknown`이 보호한 tab은 다음 마감이 지연 한 번 뒤가 되고 `unloadAt`에 보인다.
   - `pressure`: native memory pressure source 하나가 host와 함께 시작하고, normal, warn, critical level을 관측하며 각 알림에 번호를 붙인다; level이 바뀔 때만 알린다. level이 warn이나 critical인 동안 core는 보호 없는 숨겨진 tab 하나를 내리고, 그 unload가 끝나기를 기다린 뒤, normal 알림이 오거나 후보가 없을 때까지 되풀이한다. F196.29의 document region 소비자를 부르고(그 소비자는 source를 갖지 않고 구독한다), host는 page에 event `memory-pressure {level, seq}` 하나를 보낸다. 후보는 가장 오래전에 보인 것부터다. pressure에서 `recent`는 보호하지 않는다; 다른 보호는 모두 지킨다. 가장 오래전에 보인 순서이므로 방금 restore된 tab은 맨 뒤에 남는다. 후보를 찾지 못한 알림은 event `page.tab.unload.skipped {trigger, seq, reasons}`다.
6. **unload, 재시작, 숨김 시각.**

   unload는 이 순서의 core 동작 하나다: (1) core는 `host.window`가 보고하는 surface와 document 이름으로 지정하는 선언된 host method로 tab의 각 document region에 `interactionState`를 묻는다; (2) tab을 내려진 것으로 표시한다; (3) commit을 요청해 `dormant()`가 tab을 빼게 한다; (4) `disposeSurfacesExcept`가 받는 집합은 tab을 빼고, tab이 내려진 것으로 표시되어 있으므로 surface는 `disposeSurface`의 unload mode로 해제된다; 이 mode는 tab 보고(제목, footer, directory, origin, modified, notice; notice는 plugin 명세대로 tab이 보이거나 닫힐 때만 끝난다)를 유지하고 오류만 지운다(표시는 instance와 함께 끝났고, 하나의 오류 표시가 이미 문장을 log에 썼다); `forgetTab`은 tab을 닫을 때만 실행한다; (5) `host.place`가 응답한 뒤 `page.tab.unloaded`를 보낸다.

   각 unload 시도는 세대를 가진다. 기다리는 각 단계(`interactionState` 응답, media 응답) 뒤에 core는 단계 2 전에 보호를 다시 평가한다; 생긴 보호나 tab 표시는 그 시도를 `page.tab.unload.skipped {trigger, seq, reasons}`로 끝내고, `core.tab.unload`는 그 이유와 함께 실패한다.

   보이지 않고 mount된 tab은 mount 시각을 숨김 시각으로 삼는다. 설정을 켜면 각 tab의 숨김 시각을 유지하고 scheduler를 다시 맞춘다.

   **재시작.** `memorySaver`가 켜져 있으면, `surface.unload`를 선언한 plugin의 숨겨진 tab은 시작할 때 내려진 상태로 시작하고 처음 보일 때 restore된다. 꺼져 있으면 숨겨진 tab은 지금처럼 mount된다.

   `dormant()`는 내려진 tab을 자기가 선언하는 보이지 않는 surface에서 빼므로, host가 다음 commit에서 그 surface를 해제한다; tab은 layout에 남고, store가 layout의 tab 식별자를 key로 하므로 상태가 남는다.
7. **보이고 관측 가능하다.**
   - tab button은 status의 상태(`loaded`, `unloaded`, `restoring`)를 담은 `data-tab-state`와 dom name을 가진다; 보호는 status의 이유로만 보인다.
   - core catalog의 event, class `lifecycle`: `page.tab.unloaded {tab, plugin, trigger}`(info), `page.tab.restored {tab, plugin, history}`(info; session history를 얻지 못했으면 `history`가 false), `page.tab.restore.failed {tab, plugin, reason}`(error, 하나의 오류 표시 경로로), `page.tab.unload.skipped {trigger, seq, reasons}`(info), `page.tab.state.stored {tab, bytes}`(debug, 표시와 label을 포함한 tab 항목의 모든 쓰기), `page.tab.keep.changed {tab, keep}`(info).
   - 이유는 status와 event가 함께 쓰는 열거 하나다: `shown`, `recent`, `keep:modified`, `keep:busy`, `media`, `media-unknown`, `capture`, `form`, `kept`, `off`, `undeclared`, `background`. `media`, `media-unknown`, `capture`는 tab의 `checkedAt`에 한 마지막 판단의 결과다; 다른 이유는 그 source가 보고할 때 바뀐다.
   - status `core.tab.memory`: `{enabled, delay, pressure: {level, seq}, tabs: [{tab, plugin, state: loaded|unloaded|restoring, reasons, hiddenAt, unloadAt, checkedAt}]}`, 바뀔 때마다 알린다; `core.surfaces`는 각 tab의 상태를 보고하고, 내려진 surface에 대한 요청은 `tab <id> is unloaded`로 실패한다.
8. **명령.** `core.tab.unload {tab}`은 숨겨진 tab을 지금 내린다. 사용자 자신의 결정이므로 `recent`, `media`, `media-unknown`, `capture`, `form`을 기다리지 않는다; 남은 보호(`shown`, `keep:modified`, `keep:busy`, `kept`, `off`, `undeclared`, `background`)가 있으면 그 이유와 함께, 모르는 tab이면 -32602로 실패한다. `core.tab.keep {tab, keep}`은 사용자의 표시를 설정하거나 지운다(idempotent, 바뀔 때마다 `page.tab.keep.changed` 하나; 모르는 tab이나 boolean이 아닌 값은 -32602; 절대 내릴 수 없는 tab은 tab과 `undeclared` 또는 `background`를 적은 오류). binder로 연결한 tab context menu 항목 `tab-menu-keep`은 `core.tab.memory`의 이유에서 `kept`를 읽고, 절대 내릴 수 없는 tab에는 없다.

### 설정

- `memorySaver`(boolean, common scope, 기본 켜짐), 일반 절, 라벨 "메모리 절약", switch.
- `memorySaverDelay`(정수 분 5~720, common scope, 기본 120), 라벨 "숨긴 뒤 내리기까지", slider. 다른 값은 `Invalid setting memorySaverDelay: <value>`로 거부한다. 바뀌면 scheduler를 다시 맞춘다.

설정 하나가 모든 plugin에 적용된다. plugin은 자기 설정을 더하지 않는다; plugin에 사이트 예외 목록이 필요하면 그것은 그 plugin의 설정이고 keep 이유로 core에 닿는다.

### 범위와 순서

- core 계약은 모든 surface 종류를 다룬다. 채택은 unload가 WebContent process를 끝내는 document tab부터 시작한다.
- DOM tab(editor, flowmark, shell)은 main page process를 공유한다; 그 이득은 먼저 추적되는 benchmark(plugin마다 숨겨진 DOM tab, N개를 내리기 전후의 main page footprint)로 잰다. benchmark가 이득을 보일 때만 DOM plugin이 선언을 채택하고, 계획에 수치를 적는다.
- terminal은 background session(F192)을 유지하고 이 항목에 들지 않는다; 숨겨진 terminal의 image region 해제는 따로 잰다.
- 각 plugin이 무엇을 저장하는지는 그 plugin 저장소에서 명세하고, core는 그 release를 checklist 항목으로 둔다.

### browser history

내려진 region이 닫히기 전에, native region은 web view의 public `interactionState`(document나 process를 붙잡지 않는 직렬화된 session history)를 host를 거쳐 page에 돌려준다. page는 그것을 store가 아니라 메모리에 tab과 함께 두고, restore할 때 만드는 region에 넘긴다; web view가 거부한 값은 `page.tab.restore.failed`의 이유다. process가 이미 끝나 읽기가 아무것도 돌려주지 않으면, region은 저장된 주소로 만들어지고 `page.tab.restored`는 `history: false`를 가진다. 재시작 뒤에는 plugin이 쓴 주소만 restore된다. 주소는 같은 변경에서 browser 자신의 `localStorage` key에서 `context.tab.state`로 옮긴다.

### 저장 format

tab 상태는 `projects.json`에 저장하지 않는다. 설정 폴더의 새 store `tab-state.json`은 첫 release부터 format 1이고, tab 식별자마다 선택 field 셋, `state: {format, value}`, `kept: true`, `label`을 가진 항목을 두고, 그중 하나가 있을 때만 항목을 저장한다. `label`은 surface가 마지막으로 보고한 제목이고, `surface.unload`를 선언한 plugin의 tab에만 설정과 관계없이 같은 합치기로 쓴다; `null` 보고는 그것을 지운다. 이것은 mount되지 않은 tab을 위한 표시 cache다: surface가 제목의 소유자로 남고, layout `title`은 tab 이름으로 남으며, restore 뒤 첫 보고가 cache를 바꾼다. footer와 directory는 저장하지 않는다: footer는 보이는 tab에만 보이고, 내려진 tab에서 더한 tab은 plugin 명세대로 `origin.directory: null`을 얻어 project root에서 시작한다; `state`가 없으면 `read()`는 `null`이다. tab이 내려졌는지는 저장하지 않는다: 규칙 6이 그것을 정한다. 한 tab의 쓰기는 초당 최대 한 번으로 합치고 종료할 때 내보내므로, crash는 최대 마지막 1초의 상태를 잃는다. 항목이 없는 tab은 `null`을 읽는다. 항목은 그 tab을 빼는 layout 쓰기가 확인된 뒤에만 지운다. load할 때 store를 `projects.json`의 tab 식별자와 맞추고, 지운 각 고아 항목은 event다. reader는 현재 format만 받는다. `projects.json`은 내용이 바뀌지 않으므로 format을 유지한다. 별도 store는 잦은 상태 쓰기를 layout 전체 파일에서 떼어 놓는다; plugin `data`는 tab이 아니라 project와 선언한 key별이므로 소유자가 아니다.

## 채택과 비채택

- 채택: 지연 뒤와 memory pressure 때 숨겨진 tab unload; plugin마다 필수 선언; format과 크기 한계가 있고 바뀔 때마다 쓰는 상태; 위의 보호, 사실을 가진 곳(web view나 region script)에서 읽기; pressure 알림마다 가장 오래전에 보인 tab 하나; scheduler 하나; 재시작 뒤 첫 표시에서 restore; `core.tab.keep`으로 설정하고 tab별로 저장하는 사용자 표시 `kept`; 이유와 보호를 event와 status로; public `interactionState`로 메모리에 둔 session history.
- 비채택: 첫 버전에서 올라온 숨겨진 tab 수의 상한(memory pressure가 실제 메모리 한계에 답한다; 상한은 지연과 pressure 경로를 낸 뒤 잰다); 숨기자마자 내리기; 내리는 순간의 저장 hook; 선언하지 않은 tab 내리기; 전체 session history 저장; plugin별 설정; 측정된 이득 전 DOM tab 내리기; media를 위한 page script(엔진이 답한다); 낮은 메모리 수치를 위해 고른 짧은 기본 지연.

## 단계

각 단계는 checklist 항목 하나이고, 소유 module에서 Red부터 시작한다.

1. F198.1 용어와 명세(`docs/spec/plugins.md`의 tab 보고 절: 선언한 plugin의 tab label은 tab이 restore될 때까지 `tab-state.json`에 유지한다; `unload`, `restore`, 보호, `surface.unload`, `context.tab.state`, `context.tab.keep`, event, status, 명령, 설정); `validateManifest`가 `surface.unload`를 요구하고 `background` 옆에서 거부한다.
2. F198.2 label cache를 포함한 tab 상태 store `tab-state.json`(format 1)(Red: 설정을 켠 모의 재시작 뒤 `core.grid`가 숨겨지고 내려진 tab의 마지막 label을 보고하고, 그 뒤 `tab.title(null)`은 tab 이름을 보인다): 다른 format을 거부하는 reader, 종료 시 내보내기를 포함한 쓰기 합치기, layout과의 쓰기 순서, load 때 맞추기.
3. F198.3 `surface-modules.js`의 `context.tab.state`와 `context.tab.keep("busy")`; `disposeSurface`의 unload mode(Red: unload 뒤 보고한 제목, notice, restore된 context의 `origin`이 남고, 보이던 오류는 지워진다); 다음 mount 전에 끝나는 dispose(mount가 진행 중인 dispose를 기다림); dispose 뒤 쓰기는 거부하고 context마다 한 번 기록한다(Red: 두 번째 쓰기는 더 기록하지 않는다).
4. F198.4 workbench의 scheduler, 보호, 적힌 순서의 unload 동작과 restore(Red: critical 알림 하나 뒤 더 알림이 없어도 tab을 둘 이상 내린다; 보이지 않고 mount된 tab은 mount 시각을 얻는다; 설정을 켜도 숨김 시각이 유지된다; `interactionState` 응답을 기다리는 동안의 표시나 `modified` 보고는 tab을 올려 둔다); `dormant()`가 내려진 tab을 뺀다(Red: unload 뒤 commit이 tab을 다시 mount하지 않고 store 항목을 지우지 않는다); 시험에서는 `mock.timers`가 지연을 움직인다.
5. F198.5 document region 보고: 판단 때 읽는 media 재생 질의와 capture 상태; form 수정은 frame별 map과 함께 모든 frame의 region script로(Red: 지운 subframe과 reload가 표시를 지운다); `interactionState`는 닫기 전에 돌려주고 restore할 때 넘기며 빈 경우도 다룬다.
6. F198.6 native memory pressure source를 host와 함께 시작하는 소유자로 옮긴다; `sp_observe_memory_pressure`는 normal, warn, critical을 관측하고 handler에 level을 넘기며 단일 등록으로 남는다(public dispatch API, private API 행 없음; Red: host 시작 한 번이 source 하나만 등록한다); region 소비자는 warn과 critical에서만 back-forward cache를 비운다(Red: normal 알림은 아무것도 비우지 않는다); region 소비자는 그것을 구독한다; Go와 Rust는 contract case와 선언한 fault injection과 함께 `memory-pressure {level, seq}`를 전달한다; `docs/spec/hosts.md`가 소유를 적는다.
7. F198.7 설정과 그 검증; 명령 `core.tab.unload`와 `core.tab.keep`, context menu 항목(Red: 표시를 두 번 설정하면 event가 하나; 상태 없는 표시는 `null`을 읽는다).
8. F198.8 tab button 상태와 오류 표시로 가는 restore 실패.
9. F198.9 DOM tab benchmark.
10. F198.10 두 host의 창 검사: `core.tab.unload`와 pressure fault injection이 숨겨진 browser tab을 내리고, `core.tab.memory`와 region process가 그것을 보이며, tab을 보이면 주소가 restore된다.
11. 각 plugin 저장소의 채택과, 그 release를 core checklist 항목으로.
12. `memorySaver`를 기본으로 켜는 release는 F198.5가 모든 보호를 갖춘 뒤에만 낸다.

## 검토

열한 차례의 적대 검증(정확성, 구조, 규칙, 그리고 기준: 정공법, 숨김 없음, 프로덕션 안정성, 개발 편의성, 구조적 완결성)과 자리 잡은 두 platform과의 source 비교가 위 규칙을 만들었다. 결정된 각 쟁점과 이유:

- plugin마다 필수 선언, `false`는 `undeclared`로 나열, `background` 옆에서는 금지: plugin이 모르게 메모리를 유지할 수 없고, background session은 자기 경로를 유지한다.
- timer의 이유를 적은 scheduler 하나; 지연 기본값은 2시간(주요 기본값의 크기이고, 낮은 수치를 위해 고른 값이 아니다)이고 memory pressure가 빠른 경로다.
- pressure source는 level 변화만 알리므로, level이 warn이나 critical인 동안 core는 tab을 하나씩 계속 내린다; normal level이 그것을 끝내고 status를 현재로 유지한다.
- 상태는 바뀔 때마다 쓰고, 메모리에 동기로 두며, format, 크기 한계, 맞추기를 가진 별도 store에 1초 안에 저장한다; `projects.json`과 layout `title`(tab 이름)은 바뀌지 않는다; label cache가 mount되지 않은 tab의 마지막 제목을 보인다.
- 보호는 사실을 가진 곳에서 읽는다: 저장되지 않은 변경은 기존 tab 보고에서; 작업 중은 plugin에서; media와 capture는 판단할 때마다 엔진에서; form 수정만 region script에서, WebKit에 그 public 엔진 상태가 없으므로. 실패한 media 질의는 `media`가 아니라 `media-unknown`이다: status는 사실을 말한다(기각: 둘을 합치기).
- 사용자 표시 `kept`와 `core.tab.keep`은 첫 버전에 남는다: 그것이 없으면 예외를 두는 유일한 방법이 기능을 끄는 것이다; 비교한 두 platform 모두 제공한다(기각: 미루기).
- unload는 순서가 정해진 동작 하나이고, 세대와 기다린 각 단계 뒤의 재평가를 가진다; 그 dispose mode는 오류를 뺀 tab 보고를 유지한다; 한 번도 보이지 않은 tab은 mount 시각을 쓴다.
- 비채택: 숨기자마자 내리기, 내리는 순간의 저장 hook, media를 위한 page script, 전체 session history 저장, 측정 전 올라온 숨겨진 tab 수 상한, 측정된 이득 전 DOM tab 내리기, 보호로서의 `beforeunload`(content world는 page listener를 볼 수 없다).
