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
2. **모든 plugin이 선언한다.** `surface.unload`는 `plugin.json` surface의 필수 field다: `false`이거나, tab을 내릴 수 있는 plugin이면 `{format, maxBytes}`다. `validateManifest`는 이것이 없는 manifest를 거부한다. 한 manifest에서 `surface.unload`와 `background`는 함께 쓸 수 없다: background session을 가진 plugin은 background 경로(F192)로 session을 유지한다. `false`를 선언한 plugin의 tab은 내리지 않고 status에 이유 `undeclared`로 나타난다.
3. **상태는 바뀔 때마다 쓰고, 즉시 메모리에 두며, tab과 함께 저장한다.** 선언한 plugin은 필요한 상태를 JSON으로, 바뀔 때마다 `context.tab.state.write(value)`로 쓴다. 쓰기는 메모리에 동기로 들어가므로 같은 task의 unload가 최신 값을 본다. core는 이것을 tab과 함께 `{format, value}`로 저장하고, 기존 persistence로 layout store에 쓰며, 한 tab의 쓰기를 합치되 마지막 값을 버리지 않는다; 합친 각 쓰기는 event다. JSON이 아니거나 `maxBytes`를 넘는 값은 tab과 크기를 적은 오류로 거부한다. surface가 dispose된 뒤 이전 context의 `state.write`는 throw하므로, 이전 instance가 restore된 instance의 상태를 덮어쓰지 못한다. restore된 surface는 `context.tab.state.read()`로 읽는다; 선언한 것과 다른 저장 format은 tab과 찾은 format을 적은 restore 오류로 거부한다. 이 API로 쓴 상태만 unload, crash, 재시작 뒤에 남는다; 각 plugin은 무엇을 잃는지 자기 명세에 적는다.
4. **보호.** 다음 중 하나라도 해당하면 tab을 내리지 않는다; 각각 이름 붙은 이유이고, tab은 여러 이유를 가질 수 있다:
   - `shown`: 보이는 space에서 그 카드의 보이는 tab.
   - `recent`: 보인 지 지연 시간이 지나지 않았다.
   - `restored`: restore된 지 60초가 지나지 않았다.
   - `keep`: surface가 `context.tab.keep(reason, on)`으로 keep 이유를 가진다. `reason`은 `modified`(저장되지 않은 변경) 또는 `busy`(진행 중인 작업). keep 이유는 surface가 dispose되면 끝난다. `modified`를 보고한 surface는 깨끗하다고 보고할 때까지 유지된다.
   - `media`: document region이 소리나 영상을 재생하거나, picture in picture를 보이거나, camera, microphone, 화면을 capture한다; region이 public WebKit 속성으로 변화를 event로 보고한다.
   - `form`: document region에 마지막 load 뒤 사용자가 고친 form field가 있다; region script가 보고한다.
   - `download`: document region에 진행 중인 download가 있다.
   - `kept`: 사용자가 tab을 계속 올려 두도록 표시했다(`core.tab.keep`); tab과 함께 저장된다.
   - `off`: 설정이 꺼져 있거나, 그 platform이 media를 보고하지 않는다(그러면 status가 `not implemented on <os>`를 말하고 아무것도 내리지 않는다).
5. **두 가지 계기.**
   - `delay`: 보호 없이 지연 시간(기본 5분) 동안 숨겨진 tab을 내린다. core scheduler 하나가 각 tab이 숨겨진 monotonic 시각으로 계산한 가장 이른 마감을 가지고, 그것을 바꾸는 기존 event(tab 표시나 숨김, 보호 변화, 설정 변화)에 다시 맞춘다. 경과 시간에는 event source가 없어서 timer를 쓰고, code와 명세가 그 이유를 적는다.
   - `pressure`: host가 F196.29가 이미 등록한 native source 하나에서 `memory-pressure {level, seq}`(warn 또는 critical)를 알린다; document region과 page가 그 source에서 받는다. 알림마다 core는 보호 없는 숨겨진 tab 하나를, 가장 오래전에 보인 것부터 내린다. pressure에서 `recent`는 보호하지 않는다; `restored`와 다른 보호는 모두 지킨다.
6. **재시작.** 시작할 때, `surface.unload`를 선언한 plugin의 숨겨진 tab은 내려진 상태로 시작하고 처음 보일 때 restore된다.
7. **보이고 관측 가능하다.**
   - tab button은 dom name과 함께 `data-tab-state` `unloaded` 또는 `kept`를 가지고, restore 중인 tab은 surface status `restoring`을 보인다.
   - core catalog의 event, class `lifecycle`: `page.tab.unloaded {tab, plugin, trigger}`(info), `page.tab.restored {tab, plugin}`(info), `page.tab.restore.failed {tab, plugin, reason}`(error, 하나의 오류 표시 경로로), `page.tab.kept {tab, reasons}`(debug, tab의 보호가 바뀔 때만).
   - status `core.tab.memory`: `{enabled, delay, pressure: {level, seq}, tabs: [{tab, plugin, state: loaded|unloaded|restoring, reasons, hiddenAt, unloadAt}]}`, 바뀔 때마다 알린다; `core.surfaces`는 각 tab의 상태를 보고하고, 내려진 surface에 대한 요청은 `tab <id> is unloaded`로 실패한다.
8. **명령.** `core.tab.keep {tab, keep}`(idempotent; 모르는 tab이나 boolean이 아닌 값은 -32602)과 binder로 연결한 tab context menu 항목; `core.tab.unload {tab}`은 숨겨진 tab을 지금 내리고(계기와 같은 동작), tab이 보호되면 보호 이유와 함께 실패한다.

### 설정

- `memorySaver`(boolean, common scope, 기본 켜짐), 일반 절, 라벨 "메모리 절약", switch.
- `memorySaverDelay`(정수 분 1~60, common scope, 기본 5), 라벨 "숨긴 뒤 내리기까지", slider. 다른 값은 `Invalid setting memorySaverDelay: <value>`로 거부한다. 바뀌면 scheduler를 다시 맞춘다.

설정 하나가 모든 plugin에 적용된다. plugin은 자기 설정을 더하지 않는다; plugin에 사이트 예외 목록이 필요하면 그것은 그 plugin의 설정이고 keep 이유로 core에 닿는다.

### 범위와 순서

- core 계약은 모든 surface 종류를 다룬다. 채택은 unload가 WebContent process를 끝내는 document tab부터 시작한다.
- DOM tab(editor, flowmark, shell)은 main page process를 공유한다; 그 이득은 먼저 추적되는 benchmark(plugin마다 숨겨진 DOM tab, N개를 내리기 전후의 main page footprint)로 잰다. benchmark가 이득을 보일 때만 DOM plugin이 선언을 채택하고, 계획에 수치를 적는다.
- terminal은 background session(F192)을 유지하고 이 항목에 들지 않는다; 숨겨진 terminal의 image region 해제는 따로 잰다.
- 각 plugin이 무엇을 저장하는지는 그 plugin 저장소에서 명세하고, core는 그 release를 checklist 항목으로 둔다.

### browser history

document region은 내려진 tab의 session history를 web view의 public `interactionState`로 process 메모리에 두고 restore할 때 되살린다; 저장하지 않으므로 재시작 뒤에는 plugin이 쓴 주소만 restore된다. 주소는 같은 변경에서 browser 자신의 `localStorage` key에서 `context.tab.state`로 옮긴다.

### 저장 format

tab 상태, `kept`, 내려짐 표시가 layout store를 바꾸므로 그 format 번호를 올리고 release와 함께 migration 정의를 낸다(기존 tab은 상태 없이 올라온 상태가 된다). format 번호는 그것을 내는 release와 함께 정한다; 이 계획은 번호를 정하지 않는다.

## 채택과 비채택

- 채택: 지연 뒤와 memory pressure 때 숨겨진 tab unload; plugin마다 필수 선언; format과 크기 한계가 있고 바뀔 때마다 쓰는 상태; 위의 보호, web view가 사실을 가진 곳에서 읽기; pressure 알림마다 가장 오래전에 보인 tab 하나; scheduler 하나; 재시작 뒤 첫 표시에서 restore; 이유와 보호를 event와 status로; public `interactionState`로 메모리에 둔 session history.
- 비채택: 숨기자마자 내리기; 내리는 순간의 저장 hook; 선언하지 않은 tab 내리기; 전체 session history 저장; plugin별 설정; 측정된 이득 전 DOM tab 내리기.

## 단계

각 단계는 checklist 항목 하나이고, 소유 module에서 Red부터 시작한다.

1. F198.1 용어와 명세(`unload`, `restore`, 보호, `surface.unload`, `context.tab.state`, `context.tab.keep`, event, status, 명령, 설정); `validateManifest`가 `surface.unload`를 요구하고 `background` 옆에서 거부한다.
2. F198.2 layout format과 migration 정의가 있는 tab 상태 store(format 번호는 그 release와 함께 정함).
3. F198.3 `surface-modules.js`의 `context.tab.state`와 `context.tab.keep`; 다음 mount 전에 끝나는 dispose(mount가 진행 중인 dispose를 기다림); dispose 뒤 쓰기는 throw.
4. F198.4 workbench의 scheduler, 보호, unload와 restore 동작; 시험에서는 `mock.timers`가 지연을 움직인다.
5. F198.5 document region 보고: media, form 수정, download를 event로; `interactionState` 유지와 restore.
6. F198.6 native source 하나에서 Go와 Rust로 `memory-pressure`를 전달, contract case와 시험용으로 선언한 fault injection.
7. F198.7 설정과 그 검증; 명령 `core.tab.keep`과 `core.tab.unload`와 control.
8. F198.8 tab button 상태와 오류 표시로 가는 restore 실패.
9. F198.9 DOM tab benchmark.
10. F198.10 두 host의 창 검사: `core.tab.unload`와 pressure fault injection이 숨겨진 browser tab을 내리고, `core.tab.memory`와 region process가 그것을 보이며, tab을 보이면 주소가 restore된다.
11. 각 plugin 저장소의 채택과, 그 release를 core checklist 항목으로.

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
- 상태 쓰기가 unload와 재시작과 경쟁한다 → 동기 메모리 쓰기, 마지막 값을 지키는 합친 store 쓰기, dispose 뒤 쓰기는 throw.
- format과 크기 없는 tab 상태 → `{format, maxBytes}` 선언, 넘으면 거부, format 불일치는 restore 오류.
- pressure에서 반복 내리기 → `restored` 보호와 알림마다 하나.
- pressure observer 둘 → native source 하나가 두 소비자에게 준다.
- 선언하지 않은 tab은 도움을 못 받는다 → 범위에 적고 status에 나열한다.
- restore 실패와 재시작 → 오류 표시로 가는 restore 실패 event; 숨겨진 tab은 내려진 상태로 시작.
- event, 용어, status schema, 명령 schema, 설정 이름과 scope, layout format, media 감지 없는 platform, 단계별 시험, 설정 범위를 낮추지 않는 창 검사 → 규칙 5~8, 설정, 저장 format, 단계에서 답한다.
- DOM tab은 이득이 충분하지 않을 수 있다 → 측정된 benchmark를 따라 채택한다.
- terminal은 image region을 해제할 수 있다 → 따로 잰다; background session은 유지한다.
