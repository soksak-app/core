# 메모리 절약

[English](memory-saver.md)

F198의 대기 중인 제안이다. 승인되면 `docs/spec/plugins.md`와 `docs/spec/settings.md`로 옮긴다.

## 문제

보이지 않는 tab은 해제되지 않는다. `packages/workbench/index.html`의 `dormant()`는 보이지 않는 모든 tab을 보이지 않는 surface로 commit한다: 각 카드의 다른 tab, 모든 space와 project의 모든 tab이다. `disposeSurfacesExcept`는 더 이상 존재하지 않는 tab만 해제한다. surface는 tab이 닫힐 때만 해제된다(`closeTab` → `disposeSurface`). 그래서 숨겨진 tab은 각자의 메모리를 유지한다:

- document tab(browser, hwp)은 WebContent process와 page를 유지한다.
- DOM tab(editor, flowmark, shell)은 main page process 안에 DOM과 객체를 유지한다.
- image tab(terminal)은 image region을 유지한다; sidecar session은 별개다.

F196.29는 숨겨진 document region의 back-forward cache를 비우지만, 그 region의 보이는 page와 process는 남는다.

## 결정

core는 숨겨진 tab을 내리고, 보일 때 저장된 상태로 다시 mount한다. 사용자 설정 하나로 켜고 끈다. 언제 할지는 core만 정한다; plugin은 자기 tab을 내려도 된다고 선언하고 상태를 최신으로 유지할 뿐이다.

### 규칙

1. **core가 정한다.** tab을 언제 내리고 다시 mount할지는 core만 정한다. plugin은 자기 timer나 내리기 판단을 두지 않는다.
2. **plugin별 opt-in.** `plugin.json`에 `surface.unload: true`를 선언한 plugin의 tab만 내릴 수 있다. 선언하지 않은 plugin은 내리지 않는다.
3. **상태는 바뀔 때마다 쓴다.** `surface.unload`를 선언한 plugin은 복원에 필요한 상태를 바뀔 때마다 `context.tab.state.write(value)`로 쓴다. 값은 JSON이다. core는 이것을 layout의 tab과 함께 저장하므로 내리기, crash, 재시작 뒤에도 남는다. 다시 mount된 surface는 `context.tab.state.read()`로 읽는다. 내리는 순간의 hook은 두지 않는다: pressure로 내리거나 crash가 나면 저장할 기회가 없다.
4. **보호.** 다음 중 하나라도 해당하면 tab을 내리지 않는다; 각각 이름 붙은 이유다:
   - `shown`: 보이는 space에서 그 카드의 보이는 tab이다.
   - `recent`: 보인 지 지연 시간이 지나지 않았다.
   - `modified`: surface가 저장되지 않은 변경을 보고한다(`context.tab.modified`).
   - `busy`: surface가 진행 중인 작업을 보고한다(`context.tab.busy(true)`). 예: 실행 중인 작업, 전송.
   - `media`: document region이 소리나 영상을 재생하거나, picture in picture를 보이거나, camera, microphone, 화면을 capture한다. core가 web view에서 직접 읽는다.
   - `kept`: 사용자가 tab을 계속 올려 두도록 표시했다(명령 `core.tab.keep`).
   - `off`: 설정이 꺼져 있다.
5. **두 가지 계기.**
   - `delay`: 지연 시간(기본 5분) 동안 숨겨져 있고 보호가 없는 tab을 내린다.
   - `pressure`: host가 memory pressure(warn 또는 critical)를 알리면, core는 보호가 없는 숨겨진 tab을 가장 오래전에 보인 것부터 하나씩, 다음 알림까지 내린다. pressure에서는 `recent`가 보호하지 않는다; 다른 보호는 모두 지킨다.
6. **관측 가능.** 각 내리기와 다시 mount는 event `page.tab.unloaded {tab, plugin, reason}`와 `page.tab.restored {tab}`이고, 계기가 검토했지만 남긴 각 tab은 보호 이유와 함께 event `page.tab.kept {tab, reason}`이다. status `core.tab.memory`가 내려진 tab과 남긴 각 tab의 보호를 나열한다.

### 설정

- `core.tabs.memorySaver`(boolean, 기본 켜짐), 라벨 "메모리 절약": 숨겨진 tab을 내려 메모리를 돌려받는다.
- `core.tabs.memorySaverDelay`(분, 1~60, 기본 5), 라벨 "숨긴 뒤 내리기까지".

설정 하나가 모든 plugin에 적용된다. plugin은 자기 설정을 더하지 않는다; 자기 tab을 내릴 수 있는지와 어떤 상태가 필요한지만 정한다.

### plugin별로 유지하는 것

- browser: page의 주소와 scroll 위치. 현재 page 이전의 history는 유지하지 않는다; 다시 mount한 뒤 뒤로 가기는 복원된 page에서 시작한다.
- editor: 파일 경로, cursor, scroll 위치. 저장되지 않은 글이 있는 빈 문서는 `modified`이고 내리지 않는다.
- flowmark, shell, hwp: 선언을 채택할 때 각자 상태를 정한다.
- terminal: 선언하지 않는다. sidecar session은 계속 실행되고, 숨겨진 동안의 출력은 이미 background session(F192)이 다룬다.

## 채택과 비채택

- 채택: 지연 뒤와 memory pressure 때 숨겨진 tab 내리기; view가 바뀔 때마다 쓰는 상태; 보이는 tab, 최근에 보인 tab, 수정된 tab, 작업 중인 tab, media와 capture, 사용자가 남긴 tab의 보호; pressure 알림마다 가장 오래전에 보인 tab부터 하나씩 내리기; 각 내리기의 이유와 각 보호를 event로 남기기.
- 비채택: 숨기자마자 내리기(지연이 빠른 전환을 싸게 유지한다); 내리는 순간의 저장 hook(pressure나 crash에서 실행할 기회가 없다); 선언하지 않은 tab 내리기(core가 모르는 상태는 복원할 수 없다); 다시 mount한 뒤에도 전체 back history 유지(이 기능이 해제하는 이전 document를 유지하게 된다).

## 단계

1. F198.1 명세: `surface.unload`, `context.tab.state`, `context.tab.busy`, 규칙, 설정, event와 status; term; `validateManifest`가 `surface.unload`를 검사한다.
2. F198.2 tab 상태: `surface-modules.js`의 `context.tab.state`, layout의 tab과 함께 저장.
3. F198.3 내리기와 다시 mount: `dormant()`가 내린 tab을 commit에서 빼서 `disposeSurfacesExcept`가 해제한다; 보이면 renderCard가 다시 mount한다; tab별 지연 timer; 보호.
4. F198.4 media와 capture: document region이 media, picture in picture, capture 상태를 host에 보고한다.
5. F198.5 memory pressure: host가 native memory pressure(`sp_observe_memory_pressure`)를 page에 `memory-pressure`로 보낸다.
6. F198.6 설정과 명령 `core.tab.keep`.
7. F198.7 plugin: browser, editor, flowmark, shell, hwp가 각자의 저장소에서 선언을 채택한다.
8. F198.8 창 검사: 숨겨진 browser tab이 짧은 지연 뒤 내려지고, document process가 끝나며, 보일 때 같은 주소로 복원된다.

## 검토

이 제안의 적대 검증과 답한 반박을 여기에 적는다.
