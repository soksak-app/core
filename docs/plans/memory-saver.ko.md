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
   - `media`: document region이 media를 재생한다. 판단할 때마다(지연 마감, pressure 알림, `core.tab.unload`) core가 region에 묻고 web view의 public `requestMediaPlaybackState` 응답을 기다린다; `playing`이 tab을 보호한다. region이 사라진 경우처럼 실패한 응답은 이유 `media-unknown`으로 tab을 보호하고 기록된다. public `cameraCaptureState`와 `microphoneCaptureState`를 key-value observation으로 읽은 진행 중인 camera나 microphone capture는 별도 이유 `capture`이고, observation이 보고할 때 바뀐다. picture in picture 안의 멈춘 media는 다루지 않는다: WebKit은 public picture in picture 상태를 보고하지 않는다; 화면 capture는 region이 `getDisplayMedia`를 허락하지 않으므로 다루지 않는다.
   - `form`: document region의 frame에 그 frame의 document가 load된 뒤 trusted `input` event를 받은 편집 가능한 요소(form field나 `contenteditable`)가 있다. WebKit에는 이것의 public 엔진 상태가 없으므로, region content world에서 모든 frame에 주입한(`forMainFrameOnly` 끔) region script가 보고한다. native region은 script message의 frame 식별자를 key로 한 map에 표시를 둔다; frame의 `pagehide`와 form `submit`은 그 표시를 지우고, main frame navigation commit이나 reload는 map을 지운다. 등록된 `beforeunload` handler는 보호가 아니다: content world는 page의 listener를 볼 수 없다. `form` 표시는 그 event 중 하나가 올 때까지 남으므로, 사용자가 고친 field를 두고 떠나면 tab은 올라온 채 남는다; 사용자는 이동하거나 `core.tab.unload`로 놓는다.
   - `kept`: 사용자가 `core.tab.keep`으로 tab을 계속 올려 두도록 표시했다; 표시는 tab 상태 store에 둔다.
   - `off`: 설정이 꺼져 있다.

   region은 download하지 않는다: view가 보일 수 없는 navigation은 실패하거나 취소되므로 download 보호는 없다. download 지원은 자기 보호를 가진 별도 항목이 된다.
5. **두 가지 계기.**
   - `delay`: 보호 없이 지연 시간(기본 2시간, 주요 기본값의 크기) 동안 숨겨진 tab을 내린다. core scheduler 하나가 각 tab이 숨겨진 monotonic 시각으로 계산한 가장 이른 마감을 가지고, 그것을 바꾸는 기존 event(tab 표시나 숨김, 보호 변화, 설정 변화)에 다시 맞춘다. 경과 시간에는 event source가 없어서 timer를 쓰고, code와 명세가 그 이유를 적는다. 마감에 `media`나 `media-unknown`이 보호한 tab은 다음 마감이 지연 한 번 뒤가 되고 `unloadAt`에 보인다.
   - `pressure`: native memory pressure source 하나가 host와 함께 시작하고, level(warn 또는 critical)을 읽고 각 알림에 번호를 붙인다. F196.29의 document region 소비자를 부르고(그 소비자는 source를 갖지 않고 구독한다), host는 page에 event `memory-pressure {level, seq}` 하나를 보낸다. 알림마다 core는 보호 없는 숨겨진 tab 하나를, 가장 오래전에 보인 것부터 내린다. pressure에서 `recent`는 보호하지 않는다; 다른 보호는 모두 지킨다. 가장 오래전에 보인 순서이므로 방금 restore된 tab은 맨 뒤에 남는다. 후보를 찾지 못한 알림은 event `page.tab.unload.skipped {trigger, seq, reasons}`다.
6. **unload, 재시작, 숨김 시각.**

   unload는 이 순서의 core 동작 하나다: (1) core는 `host.window`가 보고하는 surface와 document 이름으로 지정하는 선언된 host method로 tab의 각 document region에 `interactionState`를 묻는다; (2) tab을 내려진 것으로 표시한다; (3) commit을 요청해 `dormant()`가 tab을 빼게 한다; (4) `disposeSurfacesExcept`가 받는 집합은 tab을 빼고, tab이 내려진 것으로 표시되어 있으므로 surface는 `disposeSurface`의 unload mode로 해제된다; 이 mode는 tab 보고(제목, footer, directory, origin, modified, notice; notice는 plugin 명세대로 tab이 보이거나 닫힐 때만 끝난다)를 유지하고 오류만 지운다(표시는 instance와 함께 끝났고, 하나의 오류 표시가 이미 문장을 log에 썼다); `forgetTab`은 tab을 닫을 때만 실행한다; (5) `host.place`가 응답한 뒤 `page.tab.unloaded`를 보낸다.

   각 unload 시도는 세대를 가진다. 기다리는 각 단계(`interactionState` 응답, media 응답) 뒤에 core는 단계 2 전에 보호를 다시 평가한다; 생긴 보호나 tab 표시는 그 시도를 `page.tab.unload.skipped {trigger, seq, reasons}`로 끝내고, `core.tab.unload`는 그 이유와 함께 실패한다.

   보이지 않고 mount된 tab은 mount 시각을 숨김 시각으로 삼는다. 설정을 켜면 각 tab의 숨김 시각을 유지하고 scheduler를 다시 맞춘다.

   **재시작.** `memorySaver`가 켜져 있으면, `surface.unload`를 선언한 plugin의 숨겨진 tab은 시작할 때 내려진 상태로 시작하고 처음 보일 때 restore된다. 꺼져 있으면 숨겨진 tab은 지금처럼 mount된다.

   `dormant()`는 내려진 tab을 자기가 선언하는 보이지 않는 surface에서 빼므로, host가 다음 commit에서 그 surface를 해제한다; tab은 layout에 남고, store가 layout의 tab 식별자를 key로 하므로 상태가 남는다.
7. **보이고 관측 가능하다.**
   - tab button은 status의 상태(`loaded`, `unloaded`, `restoring`)를 담은 `data-tab-state`와 dom name을 가진다; 보호는 status의 이유로만 보인다.
   - core catalog의 event, class `lifecycle`: `page.tab.unloaded {tab, plugin, trigger}`(info), `page.tab.restored {tab, plugin, history}`(info; session history를 얻지 못했으면 `history`가 false), `page.tab.restore.failed {tab, plugin, reason}`(error, 하나의 오류 표시 경로로), `page.tab.unload.skipped {trigger, seq, reasons}`(info), `page.tab.state.stored {tab, bytes}`(debug, 표시와 label을 포함한 tab 항목의 모든 쓰기), `page.tab.keep.changed {tab, keep}`(info).
   - 이유는 status와 event가 함께 쓰는 열거 하나다: `shown`, `recent`, `keep:modified`, `keep:busy`, `media`, `media-unknown`, `capture`, `form`, `kept`, `off`, `undeclared`, `background`. `media`와 `media-unknown`은 tab의 `checkedAt`에 한 마지막 판단의 결과다; 다른 이유는 그 source가 보고할 때 바뀐다.
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
4. F198.4 workbench의 scheduler, 보호, 적힌 순서의 unload 동작과 restore(Red: 보이지 않고 mount된 tab은 mount 시각을 얻는다; 설정을 켜도 숨김 시각이 유지된다; `interactionState` 응답을 기다리는 동안의 표시나 `modified` 보고는 tab을 올려 둔다); `dormant()`가 내려진 tab을 뺀다(Red: unload 뒤 commit이 tab을 다시 mount하지 않고 store 항목을 지우지 않는다); 시험에서는 `mock.timers`가 지연을 움직인다.
5. F198.5 document region 보고: media 재생 질의, camera와 microphone은 key-value observation으로; form 수정은 frame별 map과 함께 모든 frame의 region script로(Red: 지운 subframe과 reload가 표시를 지운다); `interactionState`는 닫기 전에 돌려주고 restore할 때 넘기며 빈 경우도 다룬다.
6. F198.6 native memory pressure source를 host와 함께 시작하는 소유자로 옮긴다; `sp_observe_memory_pressure`는 handler에 level을 넘기고 단일 등록으로 남는다(public dispatch API, private API 행 없음; Red: host 시작 한 번이 source 하나만 등록한다); region 소비자는 그것을 구독한다; Go와 Rust는 contract case와 선언한 fault injection과 함께 `memory-pressure {level, seq}`를 전달한다; `docs/spec/hosts.md`가 소유를 적는다.
7. F198.7 설정과 그 검증; 명령 `core.tab.unload`와 `core.tab.keep`, context menu 항목(Red: 표시를 두 번 설정하면 event가 하나; 상태 없는 표시는 `null`을 읽는다).
8. F198.8 tab button 상태와 오류 표시로 가는 restore 실패.
9. F198.9 DOM tab benchmark.
10. F198.10 두 host의 창 검사: `core.tab.unload`와 pressure fault injection이 숨겨진 browser tab을 내리고, `core.tab.memory`와 region process가 그것을 보이며, tab을 보이면 주소가 restore된다.
11. 각 plugin 저장소의 채택과, 그 release를 core checklist 항목으로.
12. `memorySaver`를 기본으로 켜는 release는 F198.5가 모든 보호를 갖춘 뒤에만 낸다.

## 검토

1차(검토자 셋: 정확성, 구조, 규칙). 각 반박과 답:

- opt-in이면 plugin이 모르게 메모리를 유지한다 → 선언은 필수이고 `false`는 `undeclared`로 나열한다(규칙 2).
- tab마다 timer는 event 규칙을 어긴다 → 이유를 적은 scheduler 하나(규칙 5).
- pressure 전용(pressure 없으면 내리지 않기) → 거부: pressure가 없을 때도 숨겨진 tab은 F196이 잰 대로 수십~수백 MB를 쓴다; 지연은 기본 켜짐으로 두고 사용자가 끌 수 있다.
- 스스로 보고하는 busy가 붙어 남을 수 있다 → keep 이유는 dispose에서 끝나고 status에 이유와 함께 나열된다.
- `modified`가 plugin에 달려 있고 파일을 읽기 전에 놓칠 수 있다 → 보고한 `modified`는 깨끗해질 때까지 남고, 각 plugin 시험이 첫 읽기 전의 수정을 다룬다.
- form 입력, download, media가 사라진다 → web view에서 읽는 이름 붙은 보호.
- back history가 사라진다 → `interactionState`로 메모리에 둔다.
- dispose와 mount의 경쟁 → mount가 진행 중인 dispose를 기다린다.
- 상태 쓰기가 unload와 재시작과 경쟁한다 → 동기 메모리 쓰기, 마지막 값을 지키는 합친 store 쓰기, dispose 뒤 쓰기는 거부하고 context마다 한 번 기록한다(Red: 두 번째 쓰기는 더 기록하지 않는다).
- format과 크기 없는 tab 상태 → `{format, maxBytes}` 선언, 넘으면 거부, format 불일치는 restore 오류.
- pressure에서 반복 내리기 → 알림마다 하나(이 차수의 `restored` 보호는 3차에서 지웠다).
- pressure observer 둘 → native source 하나가 두 소비자에게 준다.
- 선언하지 않은 tab은 도움을 못 받는다 → 범위에 적고 status에 나열한다.
- restore 실패와 재시작 → 오류 표시로 가는 restore 실패 event; 숨겨진 tab은 내려진 상태로 시작.
- event, 용어, status schema, 명령 schema, 설정 이름과 scope, layout format, media 감지 없는 platform, 단계별 시험, 설정 범위를 낮추지 않는 창 검사 → 규칙 5~8, 설정, 저장 format, 단계에서 답한다.
- DOM tab은 이득이 충분하지 않을 수 있다 → 측정된 benchmark를 따라 채택한다.
- terminal은 image region을 해제할 수 있다 → 따로 잰다; background session은 유지한다.

2차(검토자 하나). 각 반박과 답:

- macOS 14.4에는 재생과 picture in picture의 관측 가능한 public 속성이 없어서 `media`가 polling, private API, 꺼진 기능 중 하나를 강제한다 → 재생과 picture in picture는 모든 frame의 region script가 media 요소 event로 읽는다; camera와 microphone은 key-value observation을 유지한다; 화면 capture는 region이 허락하지 않으므로 다루지 않는다; 기능을 끄던 조항은 지운다.
- region에 download 처리가 없다 → `download` 보호를 지우고 이유를 적는다.
- subframe에서의 form 감지가 명세되지 않았다 → region content world에서 모든 frame에 주입, trusted `input` event, frame별 표시, navigation commit과 submit에서 지움; content world가 page listener를 볼 수 없으므로 `beforeunload`는 채택하지 않는다.
- region이 닫힌 뒤 `interactionState`의 소유자가 없다 → region이 닫기 전에 page에 돌려주고 page가 tab과 함께 메모리에 둔다.
- pressure source가 첫 region과 함께만 시작하고 level과 전달이 없다 → host와 함께 시작하는 소유자로 옮기고, level을 읽고, 알림에 번호를 붙이며, region 소비자와 host event에 준다.
- `surface.unload` 필수가 `background`와 모순된다 → `background`가 없으면 필수, 있으면 금지, 이유 `background`로 나열.
- 내려진 상태로 시작하는 것이 `dormant()`와 `disposeSurfacesExcept`와 충돌한다 → 내려진 tab은 `dormant()`에서 빠진다(유지 집합 부분은 8차에서 바로잡았다: 집합은 tab을 빼고 `disposeSurface`의 unload mode가 해제한다), Red 시험을 둔다.
- 후보 없는 pressure 알림이 흔적을 남기지 않았다 → event `page.tab.unload.skipped`.
- 보호가 일부뿐인데 기본 켜짐 → 기본 켜짐 release는 F198.5 뒤에 온다.
- tab 상태를 `projects.json`에 저장하면 그 format이 바뀐다 → 별도 store `tab-state.json`이 format 1로 시작하고, `projects.json`은 바뀌지 않으며, 잦은 쓰기를 layout 파일에서 떼어 놓는다.

3차(검토자 하나, 기준: 정공법, 숨김 없음, 프로덕션 안정성, 개발 편의성, 구조적 완결성). 각 반박과 답:

- 엔진이 답하는 곳에 media page script는 특이하다 → core가 판단할 때마다 `requestMediaPlaybackState`를 묻는다; camera와 microphone은 key-value observation을 유지한다; script의 media 부분은 지운다.
- 지운 frame과 reload의 form 표시가 정해지지 않았다 → native 쪽 frame별 map, `pagehide`, `submit`, main frame commit, reload가 지우고 Red 시험을 둔다; WebKit에 public 엔진 상태가 없으므로 script는 `form`에만 남는다.
- 저장한 내려짐 표시가 규칙 6과 겹치고 두 파일이 어긋날 수 있다 → 표시를 지운다; 쓰기 합치기에 한도를 두고 종료할 때 내보낸다; 항목은 layout 쓰기 뒤에 지운다(먼저 쓰기 부분은 4차에서 지웠다); load 때 고아를 event와 함께 맞춘다.
- process가 끝난 뒤 `interactionState`가 빌 수 있다 → 저장된 주소로 restore하고 `history: false`.
- `restored`, `page.tab.kept`, `core.tab.keep`은 첫 버전에 넘친다 → 지운다; 가장 오래전에 보인 순서가 반복을 막는다(`core.tab.keep`과 `kept` 표시는 두 platform과의 비교 뒤 되돌아왔다: 둘 다 사용자가 고정한 tab을 제외한다; `restored`와 `page.tab.kept`는 지운 채로 둔다).
- 5분 기본값은 주요 기본값보다 훨씬 짧다 → 기본 2시간, 범위 5분~12시간; pressure는 빠른 경로로 남는다.

4차(검토자 하나). 각 반박과 답:

- 3차 뒤 tab button 상태 `kept`의 정의가 없다 → button은 status 상태 `loaded`, `unloaded`, `restoring`을 가진다; 보호는 이유로만 보인다.
- 설정이 꺼져 있어도 재시작이 tab을 내린다 → 규칙 6은 `memorySaver`가 켜져 있을 때만 적용한다.
- `disposeSurfacesExcept`의 유지 집합은 내려진 tab에 아무 일도 하지 않아서 Red 시험이 바뀌지 않은 code에서도 통과한다 → 규칙 6은 `dormant()`가 tab을 빼고 store가 상태를 지킨다고 적는다; Red 시험은 commit 뒤 다시 mount하지 않고 항목을 지우지 않는 것을 확인한다.
- "마지막 값을 버리지 않는다"가 "crash는 최대 1초를 잃는다"와 모순된다 → 메모리 값은 버리지 않고, 저장된 값은 1초 안에 따라가며, 각 store 쓰기는 `page.tab.state.stored`다.
- 새 tab의 쓰기 순서가 불가능하다 → 항목이 없으면 `null`을 읽는다; 순서는 지우기에만 적용한다.
- picture in picture를 근거 없이 `playing`이라 했고 질의 실패가 정해지지 않았다 → `playing`만 보호한다; picture in picture 안의 멈춘 media는 다루지 않는다고 적는다; 판단은 응답을 기다리고 실패한 응답은 `media-unknown`으로 보호하며 기록한다.
- `reasons`가 보호와 다른 이유를 섞었다 → 규칙 7의 열거 하나를 규칙 2와 4, status, event가 쓴다.
- 1차 답이 지운 `restored`를 가리킨다 → 3차에서 지웠다고 표시했다.
- dispose 뒤 쓰기의 throw가 plugin 정리 경쟁에서 오류를 낸다 → context마다 한 번 기록되는 오류로 거부하고, plugin은 `context.closing`으로 작업을 멈춘다.

5차(검토자 하나). 각 반박과 답:

- 단계 3이 아직 dispose 뒤 쓰기가 throw한다고 했다 → 거부하고 context마다 한 번 기록하며 Red 시험을 둔다.
- capture에 이유가 없다 → key-value observation으로 바뀌는 이유 `capture`.
- 판단 사이의 status 재생 상태가 정해지지 않았다 → `media`와 `media-unknown`은 `checkedAt`의 마지막 판단 결과다.
- 마감에 질의로 보호된 tab에 다시 시도가 없다 → 다음 마감은 지연 한 번 뒤다.
- `form` 표시가 한없이 tab을 올려 둘 수 있다 → 동작으로 적고, 이동과 `core.tab.unload`를 사용자의 놓기로 둔다; `core.tab.unload`는 `recent`, `media`, `media-unknown`, `capture`, `form`을 기다리지 않는다.
- 3차 답이 지운 쓰기 순서를 말한다 → 표시했다.

자리 잡은 두 platform과의 비교(숨겨진 web view를 파괴하고 view가 쓴 상태를 유지하는 editor platform, 숨겨진 browser process를 한도로 묶고 숨겨진 terminal process를 유지하는 desktop agent workbench). 각 차이와 답:

- 둘 다 사용자가 고정한 tab을 제외한다 → 사용자 표시 `kept`와 `core.tab.keep`을 이 항목으로 되돌린다.
- 하나는 표시와 숨김 event에서 숨겨진 process를 개수로 묶고, 다른 하나는 개수를 넘는 가장 오래전 editor를 닫는다 → 첫 버전에서는 채택하지 않는다: pressure가 실제 한계에 답한다; 개수는 첫 버전 뒤에 잰다.
- 하나는 변경 1초 뒤 수정된 내용을 저장한다 → 1초 저장 시간과 같다.
- 하나는 읽을 수 없는 상태를 조용히 버린다 → 우리 규칙은 그런 값을 오류로 거부하고, 그대로 둔다.
- 하나는 `beforeunload`를 무시한다 → 규칙 4와 같다.
- 하나는 숨겨진 terminal의 process와 해석된 model을 유지하고 번호 붙은 snapshot으로 view를 되살린다 → 숨겨진 terminal의 image region 해제 설계는 잴 때 그 분리를 따른다.

6차(검토자 하나). 각 반박과 답:

- 3차 답이 아직 표시를 지웠다고 말한다 → 되돌아온 이유와 함께 표시했다.
- 채택 목록에 표시가 빠졌다 → 더했다.
- 바뀐 표시에 event가 없다 → `page.tab.keep.changed`; `page.tab.state.stored`는 항목의 모든 쓰기를 다룬다.
- 표시만 있는 항목의 `read()`가 정해지지 않았다 → 선택 field 둘; `state`가 없으면 `read()`는 `null`.
- 명령의 범위와 menu 상태가 명세되지 않았다 → 절대 내릴 수 없는 tab에는 오류; menu 항목 `tab-menu-keep`은 status에서 `kept`를 읽고 그런 tab에는 없다.

7차(검토자 하나). 각 반박과 답:

- `keep:modified`가 기존 `context.tab.modified`를 되풀이했다 → 보호는 tab 보고를 읽는다; `context.tab.keep`은 `busy`만 다룬다.
- dispose가 내려진 tab의 tab 보고를 지웠다 → unload dispose가 유지한다; `forgetTab`은 닫을 때만 실행한다.
- unload에 순서가 없고 닫기 전에 `interactionState`를 읽을 수 없었다 → 순서가 정해진 다섯 단계의 동작 하나와 surface와 document로 지정하는 선언된 host method.
- 한 번도 보이지 않은 tab에 숨김 시각이 없었다 → mount 시각; 설정을 켜도 숨김 시각을 유지한다.
- pressure handler에 level이 없고 두 번째 source가 가능했다 → entrance가 level을 넘기고 단일 등록으로 남으며 Red 시험을 둔다.

8차(검토자 하나). 각 반박과 답:

- 유지하는 보고에 origin이 빠져 restore된 tab이 directory를 잃는다 → origin을 유지하고 Red 시험을 둔다.
- 유지한 notice와 error는 지울 instance가 없다 → unload mode가 오류를 지우고 그 문장은 log에 있다(notice 부분은 9차에서 바로잡았다: notice는 tab이 보이거나 닫힐 때까지 남는다).
- 2차 답이 내려진 tab을 유지 집합에 넣어 해제와 모순된다 → 바로잡았다: 집합은 tab을 빼고 unload mode가 해제한다.
- 기다리는 단계 동안 보호가 생길 수 있다 → 시도마다 세대를 두고 기다린 각 단계 뒤에 다시 평가하며, `page.tab.unload.skipped`로 끝낸다.

9차(검토자 하나). 각 반박과 답:

- notice는 숨겨진 tab에만 있고, 표시나 닫기에서만 끝나며, log에 남지 않는다 → unload mode는 notice를 유지하고 오류만 지운다.
- 재시작 뒤 내려진 상태로 시작한 tab에 보고가 없어 저장된 제목을 보였다 → store가 label cache를 유지한다(이 답의 footer와 directory 부분은 10차에서 좁혔다).

10차(검토자 하나, 대안 제안과 함께). 각 쟁점과 결과:

- 9차의 `reports` field는 쓰는 시점, event 누락, plugin 명세와의 모순이 있었다. 조정자는 field 자체가 틀렸다고 판단하고, 대신 보고한 label을 layout `title`에 쓰자고 제안했다. 검토자가 근거로 거부했다: layout `title`은 tab 이름이고(`tab.title(null)`이 이름을 다시 보인다), 그 의미를 바꾸면 format 변경이며, 이동마다 layout 파일 전체를 다시 쓰게 된다. 대안은 철회했다.
- 합의한 답: `label`만, 선언한 plugin에만 같은 합치기로 쓰는 표시 cache이고 restore 뒤 첫 보고가 바꾼다; footer와 directory는 저장하지 않으며 보이는 손실이 없다; event 문장, F198.1의 plugin 명세 변경, F198.2의 Red 시험이 따라 바뀐다.
