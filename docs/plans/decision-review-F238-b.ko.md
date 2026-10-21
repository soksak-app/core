# 결정 검토 F238-b: view 로그 level과 view 단축키 표

[English](decision-review-F238-b.md)

이 기록은 브랜치 `feat/view-bridge-F231`에서 적대적 검토 없이 내린 두 결정을 검토한다.

- D5(F233): view bridge가 첫 사용 시 요청으로 저장된 로그 level을 알아낸다.
- D6(F234): view가 단축키 표를 등록하고 workbench 키를 명령 경로로 넘긴다.

각 결정은 본문, 근거, file과 line이 있는 증거, 필요한 변경을 적는다. 감사자는 새 subagent(Haiku)이며, 각자 실질 반론과 구체적 해결안을 낸다. 문구와 인용 정정은 직접 반영한다. 각 라운드는 아래에 기록한다. 한 라운드의 두 감사자가 모두 실질 반론이 없을 때까지 반복한다.

인용: `feat`는 `feat/view-bridge-F231`, `main`은 이 저장소의 `main`이다.

## 범위

- D5: 어떤 level로 view 페이지가 게이트하는지, level이 view에 어떻게 닿는지, 거부된 기록을 어떻게 세는지, 어떤 요청 경로를 없애는지.
- D6: view에 단축키 표가 필요한지, view가 어떤 키를 막는지.

범위 밖: 문구, 새 필드의 정확한 이름(하위 항목에서 정한다), 해당 모듈의 단위 테스트가 정하는 동작.

## D5. View 로그 level (F233)

### 원래 결정

`feat` `packages/plugin-api/view.js:116-135`: bridge가 첫 기록에서 `runtime.log.levels`를 호출하고(`storedLevel`, 127행), 응답 전에는 `levels === null`인 동안 모든 기록을 보내며(135행), 거부된 읽기는 오류 줄로 보고한다(`recordError`, 116행). 페이지는 plugin 기록의 level로 응답한다(`packages/workbench/view-calls.js:184-187`). 변경은 `log.levels` 이벤트로 온다(`view.js:130-131`; `surface-modules.js:261-264`, `:308`; `view-events.js`).

### 결정 본문 (라운드 2)

1. **호스트가 보유한 정책으로 시작 값을 만든다.** 생성과 재시작 때 호스트는 `window.sokSurface`(`ViewStart`, `packages/host/tauriv2/src/surfaces.rs:61`, `packages/host/wailsv3/src/surfaces.go:66`)에 필수 멤버 두 개를 주입한다.
   - `logPolicy`: [클래스와 정책](../spec/logging.md#classes-and-policy)의 다섯 클래스이며, 값은 `off`, `error`, `warn`, `info`, `debug`, `trace` 중 하나로 호스트가 적용 중인 정책에서 얻는다(파일 `log-policy.json`, 파일이 없으면 기본값; `log_policy.rs`).
   - `logClasses`: surface plugin의 각 전체 이벤트 이름 `plugin.<id>.<event>`를 클래스에 대응시킨 것이며, 호스트가 시작 때 이미 읽는 catalog(`PluginEventClasses`, `packages/sok/wailsv3/src/plugin_catalog.go:21`, `packages/host/wailsv3/src/installed.go:463`; Rust 쪽 reader가 짝이다)에서 얻고 `plugin.<id>.` 접두사로 거른다.
   두 멤버 중 하나라도 없으면 `view start is missing logPolicy` 또는 `view start is missing logClasses`로 거부한다(각 호스트와 `createSurfaceContext`). [호스트 계약](../spec/host-contract.md) 196행에 두 멤버를 추가한다. 이것들은 기존 항목이 아니라 새 항목이다.
2. **view가 기록마다 게이트한다.** 훅 `logEnabled`이 이벤트 이름을 받으므로, view는 `logPolicy[logClasses[event]]`로 기록을 결정한다. `logClasses`에 없는 plugin 기록은 선언되지 않은 이벤트이다. 기본 level `error`로 게이트하고 `undeclared`를 표시하며 센다([logging](../spec/logging.md#classes-and-policy) 13행이 선언되지 않은 이벤트에 요구하는 대로). `log.enabled(level)`은 plugin의 어떤 클래스가 그 level을 저장하면 true다.
3. **거부된 기록은 페이지 batcher에서 센다.** view는 거부된 기록을 클래스와 level별로 센다. 수는 `runtime.log.gated {class, level, count}` 호출로 나가고, 페이지는 batcher의 gated 맵에 더한다(`batcher.countGated`, `packages/workbench/log-batch.js`). 보고는 `page.log.gated`로 한다. view는 이전 보고 뒤 1초가 지나면, 다음 저장 기록과 함께, `pagehide`에서 대기 중인 수를 보낸다. view 프로세스가 종료될 때 아직 보내지 않은 수는 잃는다. 호스트는 수 없이 `host.view.log-counts-lost {surface, plugin}`을 기록하므로 손실은 기록되지만 크기는 알 수 없다. 이벤트 원천이 수를 보고하지 않으므로 1초 경계가 유일한 타이머다.
4. **변경은 기존 이벤트로 view에 닿는다.** 호스트는 이미 모든 surface 문서에 `log-policy {classes}`를 보내고, surface 문서는 이를 자기 게이트에 적용한다([logging](../spec/logging.md#policy) Documents; `packages/host/tauriv2/src/log_policy.rs:109,120`). view도 같은 이벤트를 `logPolicy`에 적용한다. 호스트가 만든 view에 `log-policy`가 닿지 않으면, 호스트는 `log-policy` 방출마다 같은 payload를 준비된 view에 보낸다. 이 확인은 D5-c에 있다. 새 surface 호출은 추가하지 않는다.
5. **제거.** 첫 사용 요청(`view.js:125-135`), `runtime.log.levels`(`view-calls.js:184-187`), `log.levels` 이벤트와 `view-events.js`의 구독, `subscribe.logLevels`, `surface-modules.js:261-264`, `:308`, 명세 줄(`native-surfaces.md:113`, `:120`, `:127`; `plugins.md:170`과 ko)을 제거한다. 테스트 `view.test.mjs:370-384`, `view-calls.test.mjs:61,210-214`, `view-events.test.mjs:48-52`는 새 경로로 옮긴다.
6. **`recordError`는 보고한다.** 오류 기록 자체가 실패하면 `recordError`는 bridge의 `report` 함수를 `{where, text, error}`와 함께 호출한다(`view.js:89-90`). 어떤 실패도 조용하지 않다.
7. **대체.** 이 결정은 view에 대해 [logging](../spec/logging.md#policy) 71행과 74행을 대체한다. 시작 기록이 있는 view는 정책을 시작 값으로 받으며 기본 대기 구간이 없다. 호스트가 없는 페이지와 정책 파일이 없는 호스트에는 기본 error-only 정책이 남는다. D5-f가 두 행을 바꾼다.

### 근거와 증거

- 원래 규칙은 응답 전에 모든 기록을 보냈다(`view.js:135`). 이는 `logging.md:74`가 surface에 주는 기본값과 맞지 않으며, 정책이 거부할 기록을 IPC로 보낸다(`logging.md:10`). 시작 값은 대기 구간을 없앤다. 호스트는 view를 만들기 전에 정책을 가지고 있다.
- `main`의 gate는 첫 설정 갱신까지 `error`에서 시작한다(`packages/workbench/log-gate.js:23-24`; `setLogPolicy`의 유일한 호출자는 `settings.js:458`). 따라서 페이지 gate로 만든 시작 값은 오래된 값일 수 있다. 호스트가 자기 정책으로 만들므로 그렇지 않다.
- `plugin-runtime.js:72`(`if (!enabled(level)) return;`)는 거부된 기록을 세지 않고 버린다. `enabled`는 훅을 level만으로 호출한다(`plugin-runtime.js:59-63`). 훅에 이벤트를 넘기는 것(D5-g)과 view에서 세는 것(3단계)이 둘 다 고친다.
- `classOf`(`packages/workbench/event-classes.js:137`)는 `main`에 plugin 항목이 없다. plugin 이벤트의 클래스는 대신 호스트의 catalog reader에서 온다(1단계).
- `log.levels`는 배열을 전달했다(`view-events.js`, `view.js:131,135`). 새 data는 정책 객체이며, 배열 형식은 함께 제거한다.

### 필요한 변경

| ID | 소유자 | 변경 |
|---|---|---|
| D5-a | `main`: `packages/host/tauriv2/src/surfaces.rs`, `packages/host/wailsv3/src/surfaces.go`, `docs/spec/host-contract.md:196`과 ko, `docs/spec/events.json`(`host.view.log-counts-lost`) | 호스트가 생성과 재시작 때 `logPolicy`와 `logClasses`를 만들고 주입한다. 호스트와 `createSurfaceContext`의 거부 문구. 새 이벤트 선언. |
| D5-c | `feat`: `packages/plugin-api/view-events.js`와 `view.js`(`log-policy` 적용); `main`: 호스트 이벤트 전달 | `log-policy`가 호스트가 만든 view에 닿는지 확인한다. 닿으면 view가 적용하고, 닿지 않으면 호스트가 `log-policy` 방출마다 같은 payload를 준비된 view에 보낸다. |
| D5-d | `feat`: `packages/plugin-api/view.js` | 거부된 기록을 클래스와 level별로 세고, 타이머와 `pagehide`에 `runtime.log.gated`를 보낸다. |
| D5-e | `feat`: `view.js:125-135`, `view-calls.js:184-187`, `view-events.js`(`log.levels`, `subscribe.logLevels`), `surface-modules.js:261-264`, `:308`, `native-surfaces.md:113,120,127`, `plugins.md:170`과 ko; 테스트 `view.test.mjs:370-384`, `view-calls.test.mjs:61,210-214`, `view-events.test.mjs:48-52` | 첫 사용 요청, `runtime.log.levels`, `log.levels` 이벤트와 구독을 제거한다. |
| D5-f | `main`: `docs/spec/logging.md:71,74,76`과 ko | view 규칙(시작 값, 기본 대기 구간 없음)과 plugin 기록의 선언되지 않은 이벤트 규칙을 명시한다. |
| D5-g | `feat`: `packages/plugin-api/plugin-runtime.js:59-72`과 테스트, `packages/plugin-api/test/surface.test.mjs:142,172,195-198` | `logEnabled(level, event)`; `log.enabled(level)` = 어떤 클래스든 그 level을 저장; 선언되지 않은 이벤트는 `error`로 게이트하고 표시한다. |
| D5-h | `main`: `packages/workbench/log-batch.js`(`countGated`), `packages/workbench/view-calls.js`(`runtime.log.gated`) | batcher가 view의 수를 받는다. 같은 gated 맵과 타이머를 쓴다. |

### 라운드

#### 라운드 1 (응답)

두 감사자: A(D5 게이트와 소유자), B(D5 변경과 빈틈). 각 반론은 파일에서 확인했다.

| 반론 | 응답 |
|---|---|
| A1: 게이트가 이벤트를 받지 못함 | 수용. 2단계; D5-g. |
| A2: 수가 batcher에 들어갈 경로가 없음 | 수용. 3단계; D5-h. |
| A3: plugin catalog의 소유자와 키 형식 | 수용. 호스트 reader가 이미 있다(`plugin_catalog.go`, `installed.go:463`). 키는 전체 이름이다. 1단계. 소유자는 호스트 코드이며 plugin 저장소는 필요 없다. |
| A4: 시작 값이 오래될 수 있음 | 수용. 호스트가 자기 정책으로 만든다. 1단계. |
| A5: 변경 경로가 기존 `log-policy`와 중복 | 일부 수용. `log-policy`가 이미 surface 문서에 닿는다(`log_policy.rs:109,120`). 4단계가 이를 재사용한다. 호스트가 만든 view에 닿는지는 확인 항목(D5-c). |
| A6: `log.levels`의 형태와 소유자 | 수용. `log.levels`를 제거한다. 제거 소유자는 D5-e. |
| B1: gate 변경 훅 | 현재 경로가 쓰이지 않으므로 해당 없음으로 수용. `feat` `log-gate.js:59-64`의 `onChange`는 쓰이지 않으면 D5-e에서 제거하며, D5-c가 결정한다. |
| B2: `host-contract.md:196`을 기존 멤버로 인용 | 수용. 멤버는 새 항목이다(1단계; D5-a). |
| B3: 선언되지 않은 기록이 정책을 우회 | 수용. 2단계: `error`로 게이트하고 `undeclared`로 표시하며 센다(`logging.md:13`). |
| B4: 대체 기술이 명세와 맞지 않음 | 수용. 7단계를 다시 썼고, D5-f가 `logging.md:71`과 `:74`를 바꾼다. |
| B5: 병렬 전달 경로 | A5와 같다: `log-policy`를 재사용한다. |
| B6: 마지막 수가 조용히 사라짐 | 일부 수용. 대기 수는 `pagehide`와 매 초 보낸다. 강제 종료 시 최대 1초 분량을 잃으며, `host.view.log-counts-lost`로 기록된다(3단계). 손실은 조용하지 않다. |

문구: `sends every record while levels === null`의 줄은 `view.js:135`이다. 정정했다.

## D6. View 단축키 표 (F234)

### 원래 결정

`feat` `packages/plugin-api/view.js:139-164`: view가 페이지에서 읽은 단축키 표를 등록한다(`runtime.shortcuts.read`, `viewShortcuts`가 응답, `packages/workbench/view-calls.js:86-88`). owner가 `workbench`인 행의 keydown은 막고 명령 경로로 넘긴다(`runtime.shortcuts.run`, `view.js:153-158`, `view-calls.js:205-212`). 등록 전 첫 키는 `runtime.shortcuts.missing`을 보내고(`view.js:143-147`), 이는 `page.view.shortcut-table-missing`으로 기록된다. bridge는 `shortcuts.register()`를 내보낸다(`view.js:160-164`, `:331`에서 반환).

### 결정 본문 (라운드 2)

1. **view는 어떤 키도 막지 않는다.** `viewShortcuts`는 `when`이 `Any focus`인 행(14개, 모두 owner `native menu`)과 owner가 `view`인 행(`Escape`, `command: none`; 텍스트 입력 키)만 남긴다. owner가 `workbench`인 행은 view 표에 들어오지 않는다. workbench 행은 다른 context를 가지기 때문이다(`packages/workbench/shortcuts.json:17-23`). view는 오늘 기본 동작을 막지 않는다.
2. **표 경로를 공개 API와 함께 제거한다.** 제거 대상:
   - keydown 리스너와 `shortcutTable`(`view.js:139-159`);
   - `shortcuts.register()`와 그 반환(`view.js:160-164`, `:331`); `packages/` 안에서 `view.js` 밖의 호출자가 없으므로 저장소 안에서는 완전히 제거된다. `shortcuts.register()`를 부르는 plugin은 no-op이 아니라 깨진다;
   - 페이지 쪽: `viewShortcuts`와 `runtime.shortcuts.read`, `.missing`, `.run` 분기(`view-calls.js:86-88`, `:199-212`), `shortcuts.json` import와 `shortcuts` 옵션(`surface-modules.js:21`, `:287`, `view-calls.js:15`);
   - 이벤트 `page.view.shortcut-table-missing`과 `page.input.shortcut.failed`(`docs/spec/events.json:690`, `:699`)와 클래스 표의 행(`packages/sok/tauriv2/src/event_classes.rs:167`, `packages/sok/wailsv3/src/event_classes.go:125`, `packages/workbench/event-classes.js:112`), 재생성한다.
   AGENTS.md: 쓰이지 않는 코드 경로를 제거한다. 쓰이지 않는 표는 두지 않는다.
3. **view에서 유지되는 workbench 행은 없다.** view가 포커스를 가진 동안 유지되어야 하는 workbench 행은 자체 결정, 경로, 테스트, 증거가 필요하다.
4. **명세 문장.** view 단축키 문장을 "plugin view는 어떤 키도 막지 않는다"로 고친다. 대상: `native-surfaces.md` Input(`main:137`; `feat:141`), `plugin-processes.md` 규칙 7(`main:94-100`; `feat` `docs/plans/plugin-processes.md:113-122`), `exposure.md:67`, `:71`(`feat`), `main`의 `:94`, `:95`, 그리고 ko 쌍. `shortcuts.json` 24-25행은 `when` 문구를 "A plugin view has keyboard focus; the view handles it itself"로 바꾼다. `scripts/test/shortcut-table.test.mjs`를 같은 변경에서 고친다. 변경 기록(`CHANGELOG.md:8`, `CHANGELOG.ko.md:8`)과 `docs/features.md:1239`는 F234 표 경로가 제거되고 대체되었다고 적는다.
5. **view 포커스의 Escape: 코드에서 얻은 알려진 결과.** 페이지 picker의 Escape 리스너는 picker가 열린 동안에만 붙고(`packages/workbench/plane.js:745-746`), 페이지에 포커스가 있을 때만 키를 받는다. view의 `Escape` 행(owner `view`)은 아무것도 처리하지 않는다. 따라서 view에서 Escape를 누르면 페이지 picker가 닫히지 않는다. 이 기대는 probe 결과가 아니라 알려진 결과로 적는다. 네이티브 picker와 modal WebView는 Escape를 스스로 처리하므로(`packages/workbench/picker-layer.js:98-99`, `card.js:25-28`) 경우가 다르다. probe가 이를 확인한다.
   **대체 경로를 미리 고정한다:** view는 Escape에서 `runtime.dismiss` 호출을 보낸다(기본 동작은 막지 않는다). 페이지는 열린 layer를 `core.picker.close` 또는 `core.modal.dismiss`로 닫고, 열린 것이 없으면 아무것도 하지 않는다. 이는 새 경로이므로 자체 Red 테스트가 필요하다. probe(D6-c)가 각 overlay에 이 대체가 필요한지 확인한다. F212.6a의 Escape 측정과 같은 경우이므로 연결하며, probe 하나로 둘 다 본다.
6. **view 포커스의 cmd+k와 shift+cmd+n.** `cmd+k`(`core.focus.set`, `shortcuts.json:18`)와 브라우저 빌드의 `shift+cmd+n`(`:17`)은 페이지 keydown에서만 처리되므로 view 포커스에서는 페이지에 닿지 않는다. 명세는 view 한정 없이 적는다(`exposure.md:87-88`). D6-c의 probe 사례이며, 격차가 확인되면 D6-d가 `When`을 "The library is shown and the page has keyboard focus"로 좁힌다(영문과 한글).

### 근거와 증거

- `viewShortcuts`는 owner `workbench` 행을 결코 돌려주지 않으므로, `runtime.shortcuts.run`은 모든 키를 "is not a workbench shortcut of a view"로 거부한다(`view-calls.js:205-212`). 성공할 수 없는 경로는 쓰이지 않는 경로다.
- 표는 view가 쓰는 것을 주지 않는다. `native menu`와 `view` 행은 기본 동작을 유지하고, view는 어차피 막지 않는다.
- 원래 논거(표가 바인딩의 단일 원천이다)는 표에 workbench 행이 없는 동안 성립하지 않는다.
- Escape(5단계)와 cmd+k(6단계)는 기존 동작이며, 표를 제거해도 바뀌지 않는다.

### 필요한 변경

| ID | 소유자 | 변경 |
|---|---|---|
| D6-a | `feat`: `packages/plugin-api/view.js:139-164,331`, `packages/workbench/view-calls.js:15,86-88,199-212`, `packages/workbench/surface-modules.js:21,287`, `docs/spec/events.json:690,699`, 클래스 표 세 개, `native-surfaces.md:141`과 ko, `docs/plans/plugin-processes.md:113-122`, `exposure.md:71`, `CHANGELOG.md:8`, `CHANGELOG.ko.md:8`, `docs/features.md:1239`과 ko; `main`: `docs/spec/native-surfaces.md:137`, `plugin-processes.md:94-100`, `exposure.md:67,94,95`과 ko, `scripts/test/shortcut-table.test.mjs` | 표 경로, 그 API와 이벤트를 제거한다. view는 어떤 키도 막지 않는다고 명시한다. |
| D6-b | `feat`: `packages/plugin-api/test/view.test.mjs:394-419`, `packages/workbench/test/view-calls.test.mjs:13,278-310`, `fakes()`의 `shortcuts` 옵션 | 표 테스트를 삭제한다. 테스트를 추가한다: view의 keydown은 결코 막히지 않고, `runtime.shortcuts.*` 호출이 없으며, 이벤트도 나가지 않는다(현재 코드에서 Red: 리스너가 `runtime.shortcuts.missing`을 호출한다). |
| D6-c | `feat`(probe, 다음 수정) | macOS probe: view에 포커스가 있을 때 Escape를 (a) 페이지 picker, (b) 네이티브 picker, (c) modal이 열린 상태에서 확인; view 포커스에서 cmd+k와 shift+cmd+n. 대체는 5단계의 `runtime.dismiss`. F212.6a와 연결. |
| D6-d | `main`: `docs/spec/exposure.md:87-88`과 ko | D6-c가 격차를 확인하면 `When`을 페이지 포커스 조건으로 좁힌다. |

### 라운드

#### 라운드 1 (응답)

두 감사자: C(D6 완전성), D(제거에 대한 반론). 각 반론은 파일에서 확인했다.

| 반론 | 응답 |
|---|---|
| C1: 파일 누락(surface-modules, view-calls 문서, 이벤트, 클래스 표, 변경 기록, 계획 줄) | 수용. 2단계, 4단계, D6-a에 모두 넣었다. |
| C2: 테스트 목록 불완전(278-286, 288-293, 픽스처 행 :13, fakes) | 수용. D6-b. |
| C3: view 소유 행의 낡은 문구 | 수용. 4단계가 24-25행과 `exposure.md` 사본의 `when`을 바꾼다. 두 행은 `shortcut-table.test.mjs`가 소유자를 검사하므로 남긴다. |
| C4: Escape 항목이 잘못 기술되었고 해결 경로가 없음 | 수용. 5단계가 코드에서 얻은 결과와 미리 고정한 대체를 적는다. |
| D1: `shortcuts.register()` API가 남아 있음 | 수용. 2단계. |
| D2: 다른 명세 문장(`exposure.md:67,94,95`) | 수용. 4단계. |
| D3: Escape 항목이 핸들러가 있는 것처럼 기술됨 | 수용. 5단계. |
| D4: cmd+k와 shift+cmd+n이 과장됨 | 수용. 6단계, D6-d. |

## 하위 항목

`docs/features.md`에 F212 아래 F238-b-1(D5-a)부터 F238-b-12(D6-d)까지 위 행마다 하나씩 등록한다.

## 다른 곳에 기록할 내용

각 행은 소유자를 적는다. `main`이 소유한 행은 `main`에서 바꿀 내용이고, `feat/view-bridge-F231`이 소유한 행은 그 브랜치에서 바꿀 내용이다.
