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
3. **상태는 바뀔 때마다 쓰고, 즉시 메모리에 두며, tab별로 저장한다.** 선언한 plugin은 필요한 상태를 JSON으로, 바뀔 때마다 `context.tab.state.write(value)`로 쓴다. 쓰기는 메모리에 동기로 들어가므로 같은 task의 unload가 최신 값을 본다. core는 이것을 tab별로 `{format, value}`로 tab 상태 store에 저장하고(저장 format 참고), 한 tab의 쓰기를 합치되 마지막 값을 버리지 않는다; 합친 각 쓰기는 event다. JSON이 아니거나 `maxBytes`를 넘는 값은 tab과 크기를 적은 오류로 거부한다. surface가 dispose된 뒤 이전 context의 `state.write`는 throw하므로, 이전 instance가 restore된 instance의 상태를 덮어쓰지 못한다. restore된 surface는 `context.tab.state.read()`로 읽는다; 선언한 것과 다른 저장 format은 tab과 찾은 format을 적은 restore 오류로 거부한다. 이 API로 쓴 상태만 unload, crash, 재시작 뒤에 남는다; 각 plugin은 무엇을 잃는지 자기 명세에 적는다.
4. **보호.** 다음 중 하나라도 해당하면 tab을 내리지 않는다; 각각 이름 붙은 이유이고, tab은 여러 이유를 가질 수 있다:
   - `shown`: 보이는 space에서 그 카드의 보이는 tab.
   - `recent`: 보인 지 지연 시간이 지나지 않았다.
   - `keep`: surface가 `context.tab.keep(reason, on)`으로 keep 이유를 가진다. `reason`은 `modified`(저장되지 않은 변경) 또는 `busy`(진행 중인 작업). keep 이유는 surface가 dispose되면 끝난다. `modified`를 보고한 surface는 깨끗하다고 보고할 때까지 유지된다.
   - `media`: document region이 media를 재생한다. 판단할 때마다(지연 마감, pressure 알림, `core.tab.unload`) core가 region에 묻고, region은 web view의 public `requestMediaPlaybackState`를 부른다; picture in picture를 포함한 `playing`이 tab을 보호한다. camera와 microphone capture는 public `cameraCaptureState`와 `microphoneCaptureState`를 key-value observation으로 읽는다. status는 마지막 판단의 media 결과를 보인다. 화면 capture는 다루지 않는다: region은 `getDisplayMedia`를 허락하지 않는다.
   - `form`: document region의 frame에 그 frame의 document가 load된 뒤 trusted `input` event를 받은 편집 가능한 요소(form field나 `contenteditable`)가 있다. WebKit에는 이것의 public 엔진 상태가 없으므로, region content world에서 모든 frame에 주입한(`forMainFrameOnly` 끔) region script가 보고한다. native region은 script message의 frame 식별자를 key로 한 map에 표시를 둔다; frame의 `pagehide`와 form `submit`은 그 표시를 지우고, main frame navigation commit이나 reload는 map을 지운다. 등록된 `beforeunload` handler는 보호가 아니다: content world는 page의 listener를 볼 수 없다.
   - `off`: 설정이 꺼져 있다.

   region은 download하지 않는다: view가 보일 수 없는 navigation은 실패하거나 취소되므로 download 보호는 없다. download 지원은 자기 보호를 가진 별도 항목이 된다.
5. **두 가지 계기.**
   - `delay`: 보호 없이 지연 시간(기본 2시간, 주요 기본값의 크기) 동안 숨겨진 tab을 내린다. core scheduler 하나가 각 tab이 숨겨진 monotonic 시각으로 계산한 가장 이른 마감을 가지고, 그것을 바꾸는 기존 event(tab 표시나 숨김, 보호 변화, 설정 변화)에 다시 맞춘다. 경과 시간에는 event source가 없어서 timer를 쓰고, code와 명세가 그 이유를 적는다.
   - `pressure`: native memory pressure source 하나가 host와 함께 시작하고, level(warn 또는 critical)을 읽고 각 알림에 번호를 붙인다. F196.29의 document region 소비자를 부르고(그 소비자는 source를 갖지 않고 구독한다), host는 page에 event `memory-pressure {level, seq}` 하나를 보낸다. 알림마다 core는 보호 없는 숨겨진 tab 하나를, 가장 오래전에 보인 것부터 내린다. pressure에서 `recent`는 보호하지 않는다; 다른 보호는 모두 지킨다. 가장 오래전에 보인 순서이므로 방금 restore된 tab은 맨 뒤에 남는다. 후보를 찾지 못한 알림은 event `page.tab.unload.skipped {trigger, seq, reasons}`다.
6. **재시작.** 시작할 때, `surface.unload`를 선언한 plugin의 숨겨진 tab은 내려진 상태로 시작하고 처음 보일 때 restore된다.

   내려진 tab은 `dormant()`가 선언하는 보이지 않는 surface에서 빠지고, `disposeSurfacesExcept`는 내려진 plugin의 placeholder처럼 그 식별자를 유지 집합에 둔다. 그래서 commit이 그 tab을 닫힌 것으로 다루지 않고 상태가 남는다.
7. **보이고 관측 가능하다.**
   - tab button은 dom name과 함께 `data-tab-state` `unloaded` 또는 `kept`를 가지고, restore 중인 tab은 surface status `restoring`을 보인다.
   - core catalog의 event, class `lifecycle`: `page.tab.unloaded {tab, plugin, trigger}`(info), `page.tab.restored {tab, plugin, history}`(info; session history를 얻지 못했으면 `history`가 false), `page.tab.restore.failed {tab, plugin, reason}`(error, 하나의 오류 표시 경로로), `page.tab.unload.skipped {trigger, seq, reasons}`(info).
   - status `core.tab.memory`: `{enabled, delay, pressure: {level, seq}, tabs: [{tab, plugin, state: loaded|unloaded|restoring, reasons, hiddenAt, unloadAt}]}`, 바뀔 때마다 알린다; `core.surfaces`는 각 tab의 상태를 보고하고, 내려진 surface에 대한 요청은 `tab <id> is unloaded`로 실패한다.
8. **명령.** `core.tab.unload {tab}`은 숨겨진 tab을 지금 내린다(계기와 같은 동작); tab이 보호되면 보호 이유와 함께, 모르는 tab이면 -32602로 실패한다. 사용자가 tab을 계속 올려 두는 표시는 후속 항목이다.

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

tab 상태는 `projects.json`에 저장하지 않는다. 설정 폴더의 새 store `tab-state.json`은 첫 release부터 format 1이고, tab 식별자마다 `{format, value}` 상태를 가진다. tab이 내려졌는지는 저장하지 않는다: 규칙 6이 그것을 정한다. 한 tab의 쓰기는 초당 최대 한 번으로 합치고 종료할 때 내보내므로, crash는 최대 마지막 1초의 상태를 잃는다. tab의 항목은 그것을 참조하는 layout보다 먼저 쓰고, tab을 빼는 layout 쓰기가 확인된 뒤에만 지운다. load할 때 store를 `projects.json`의 tab 식별자와 맞추고, 지운 각 고아 항목은 event다. reader는 현재 format만 받는다. `projects.json`은 내용이 바뀌지 않으므로 format을 유지한다. 별도 store는 잦은 상태 쓰기를 layout 전체 파일에서 떼어 놓는다; plugin `data`는 tab이 아니라 project와 선언한 key별이므로 소유자가 아니다.

## 채택과 비채택

- 채택: 지연 뒤와 memory pressure 때 숨겨진 tab unload; plugin마다 필수 선언; format과 크기 한계가 있고 바뀔 때마다 쓰는 상태; 위의 보호, 사실을 가진 곳(web view나 region script)에서 읽기; pressure 알림마다 가장 오래전에 보인 tab 하나; scheduler 하나; 재시작 뒤 첫 표시에서 restore; 이유와 보호를 event와 status로; public `interactionState`로 메모리에 둔 session history.
- 비채택: 숨기자마자 내리기; 내리는 순간의 저장 hook; 선언하지 않은 tab 내리기; 전체 session history 저장; plugin별 설정; 측정된 이득 전 DOM tab 내리기; media를 위한 page script(엔진이 답한다); 낮은 메모리 수치를 위해 고른 짧은 기본 지연.

## 단계

각 단계는 checklist 항목 하나이고, 소유 module에서 Red부터 시작한다.

1. F198.1 용어와 명세(`unload`, `restore`, 보호, `surface.unload`, `context.tab.state`, `context.tab.keep`, event, status, 명령, 설정); `validateManifest`가 `surface.unload`를 요구하고 `background` 옆에서 거부한다.
2. F198.2 tab 상태 store `tab-state.json`(format 1): 다른 format을 거부하는 reader, 종료 시 내보내기를 포함한 쓰기 합치기, layout과의 쓰기 순서, load 때 맞추기.
3. F198.3 `surface-modules.js`의 `context.tab.state`와 `context.tab.keep`; 다음 mount 전에 끝나는 dispose(mount가 진행 중인 dispose를 기다림); dispose 뒤 쓰기는 throw.
4. F198.4 workbench의 scheduler, 보호, unload와 restore 동작; `dormant()`가 내려진 tab을 빼고 `disposeSurfacesExcept`가 유지한다(Red: 내려진 tab이 상태와 함께 commit을 견딘다); 시험에서는 `mock.timers`가 지연을 움직인다.
5. F198.5 document region 보고: media 재생 질의, camera와 microphone은 key-value observation으로; form 수정은 frame별 map과 함께 모든 frame의 region script로(Red: 지운 subframe과 reload가 표시를 지운다); `interactionState`는 닫기 전에 돌려주고 restore할 때 넘기며 빈 경우도 다룬다.
6. F198.6 native memory pressure source를 host와 함께 시작하는 소유자로 옮기고, level을 읽고 각 알림에 번호를 붙인다; region 소비자는 그것을 구독한다; Go와 Rust는 contract case와 선언한 fault injection과 함께 `memory-pressure {level, seq}`를 전달한다; `docs/spec/hosts.md`가 소유를 적는다.
7. F198.7 설정과 그 검증; 명령 `core.tab.unload`.
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
- 상태 쓰기가 unload와 재시작과 경쟁한다 → 동기 메모리 쓰기, 마지막 값을 지키는 합친 store 쓰기, dispose 뒤 쓰기는 throw.
- format과 크기 없는 tab 상태 → `{format, maxBytes}` 선언, 넘으면 거부, format 불일치는 restore 오류.
- pressure에서 반복 내리기 → `restored` 보호와 알림마다 하나.
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
- 내려진 상태로 시작하는 것이 `dormant()`와 `disposeSurfacesExcept`와 충돌한다 → 내려진 tab은 `dormant()`에서 빠지고 유지 집합에 남으며, Red 시험을 둔다.
- 후보 없는 pressure 알림이 흔적을 남기지 않았다 → event `page.tab.unload.skipped`.
- 보호가 일부뿐인데 기본 켜짐 → 기본 켜짐 release는 F198.5 뒤에 온다.
- tab 상태를 `projects.json`에 저장하면 그 format이 바뀐다 → 별도 store `tab-state.json`이 format 1로 시작하고, `projects.json`은 바뀌지 않으며, 잦은 쓰기를 layout 파일에서 떼어 놓는다.

3차(검토자 하나, 기준: 정공법, 숨김 없음, 프로덕션 안정성, 개발 편의성, 구조적 완결성). 각 반박과 답:

- 엔진이 답하는 곳에 media page script는 특이하다 → core가 판단할 때마다 `requestMediaPlaybackState`를 묻는다; camera와 microphone은 key-value observation을 유지한다; script의 media 부분은 지운다.
- 지운 frame과 reload의 form 표시가 정해지지 않았다 → native 쪽 frame별 map, `pagehide`, `submit`, main frame commit, reload가 지우고 Red 시험을 둔다; WebKit에 public 엔진 상태가 없으므로 script는 `form`에만 남는다.
- 저장한 내려짐 표시가 규칙 6과 겹치고 두 파일이 어긋날 수 있다 → 표시를 지운다; 쓰기 합치기에 한도를 두고 종료할 때 내보낸다; 항목은 layout보다 먼저 쓰고 뒤에 지운다; load 때 고아를 event와 함께 맞춘다.
- process가 끝난 뒤 `interactionState`가 빌 수 있다 → 저장된 주소로 restore하고 `history: false`.
- `restored`, `page.tab.kept`, `core.tab.keep`은 첫 버전에 넘친다 → 지운다; 가장 오래전에 보인 순서가 반복을 막는다; 계속 올려 두는 표시는 후속 항목이다.
- 5분 기본값은 주요 기본값보다 훨씬 짧다 → 기본 2시간, 범위 5분~12시간; pressure는 빠른 경로로 남는다.
