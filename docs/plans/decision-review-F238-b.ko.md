# 결정 검토 F238-b: view 로그 level과 view 단축키 표

[English](decision-review-F238-b.md)

이 기록은 브랜치 `feat/view-bridge-F231`에서 적대적 검토 없이 내린 두 결정을 검토한다.

- D5(F233): view bridge가 첫 사용 시 요청으로 저장된 로그 level을 알아낸다.
- D6(F234): view가 단축키 표를 등록하고 workbench 키를 명령 경로로 넘긴다.

각 결정은 본문, 근거, file과 line이 있는 증거, 필요한 변경을 적는다. 감사자는 새 subagent(Haiku)이며, 각자 실질 반론과 구체적 해결안을 낸다. 문구와 인용 정정은 직접 반영한다. 각 라운드는 아래에 기록한다. 한 라운드의 두 감사자가 모두 실질 반론이 없을 때까지 반복한다.

인용: `feat`는 `feat/view-bridge-F231`, `main`은 이 저장소의 `main`이다.

## 범위

- D5: 어떤 level로 view 페이지가 게이트하는지, level이 view에 어떻게 닿고 최신으로 유지되는지, 거부된 기록을 어떻게 세는지, 어떤 요청 경로를 없애는지.
- D6: view에 단축키 표가 필요한지, view가 어떤 키를 막는지, Escape가 열린 페이지 overlay를 어떻게 닫는지.

범위 밖: 문구, 새 필드의 정확한 이름(하위 항목에서 정한다), 해당 모듈의 단위 테스트가 정하는 동작.

## D5. View 로그 level (F233)

### 원래 결정

`feat` `packages/plugin-api/view.js:116-135`: bridge가 첫 기록에서 `runtime.log.levels`를 호출하고(`storedLevel`, 127행), `levels === null`인 동안 모든 기록을 보내며(135행), 거부된 읽기는 오류 줄로 보고한다(`recordError`, 116행). 페이지는 plugin 기록의 level로 응답한다(`packages/workbench/view-calls.js:184-187`). 변경은 `log.levels` 이벤트로 온다(`view.js:130-131`; `packages/workbench/surface-modules.js:261-264`, `:308`; `packages/workbench/view-events.js`).

### 결정 본문 (라운드 4)

1. **호스트가 적용 중인 정책으로 시작 값을 만든다.** 생성과 재시작 때 호스트는 `window.sokSurface`(`ViewStart`, `packages/host/tauriv2/src/surfaces.rs:61`, `packages/host/wailsv3/src/surfaces.go:66`)에 필수 멤버 두 개를 주입한다.
   - `logPolicy`: [클래스와 정책](../spec/logging.md#classes-and-policy)의 다섯 클래스이며, 값은 `off`, `error`, `warn`, `info`, `debug`, `trace` 중 하나다. 값은 호스트가 마지막으로 적용한 정책이다. 적용된 파일이 없으면 기본값이고, 있으면 마지막 유효한 `log-policy.json`이다. 거부된 파일은 값을 바꾸지 않는다(`logging.md:93`). 시작 값이 파일 텍스트인 경우는 없다.
   - `logClasses`: surface plugin의 각 전체 이벤트 이름 `plugin.<id>.<event>`를 클래스에 대응시킨 것이다. 각 호스트가 시작 때 이미 실행하는 catalog reader에서 얻고(`PluginEventClasses`, `packages/sok/wailsv3/src/plugin_catalog.go:21`; Rust reader는 `packages/host/tauriv2/src/installed.rs:492`), 접두사 `plugin.<id>.`로 거른다.
   두 멤버 중 하나라도 없으면 `view start is missing logPolicy` 또는 `view start is missing logClasses`로 거부한다(각 호스트와 `createSurfaceContext`). [호스트 계약](../spec/host-contract.md) 196-197행에 두 멤버를 추가한다. 이것들은 새 항목이다.
2. **view가 기록마다 클래스로 게이트하고, 페이지는 다시 게이트하지 않는다.** 훅 `logEnabled(level, event)`는 이벤트 이름을 받는다. 이름이 `logClasses`에 있는 기록은 `logPolicy[class]`가 그 level을 저장할 때 저장되며, 그렇지 않으면 거부되고 센다(3단계). view는 저장되는 기록을 페이지 batcher가 두 번째 게이트 없이 받는 경로로 보낸다(`log-batch.js`, D5-h). `logGate`의 페이지 게이트는 `error`에서 시작하므로, 그대로 두면 호스트 정책이 저장하는 기록을 거부한다. 이름이 `logClasses`에 없는 기록은 선언되지 않은 이벤트이며, 표지 `undeclared`를 붙여 보내고 게이트하지 않는다([logging](../spec/logging.md#classes-and-policy) 13행과 40행). `log.enabled(level)`은 모든 level에서 true를 돌려준다. 선언되지 않은 이벤트는 어떤 level에서도 보내지므로, 생산자는 클래스별 답보다 필드를 더 자주 만든다. 이 비용을 받아들인다.
3. **거부된 기록은 view에서 세고 task 끝에 보낸다.** view는 거부된 기록을 클래스와 level별로 센다. 한 task에서 첫 수가 대기 상태가 되면 view는 `queueMicrotask`로 flush 하나를 예약하고, 그 flush가 `runtime.log.gated {class, level, count}` 호출로 수를 보낸다. view는 `pagehide`에서도 flush 한다. 모든 전송에는 `.catch(report)`가 붙는다. 페이지는 수를 batcher의 gated 맵에 더하며(`batcher.countGated`), `page.log.gated`로 보고된다. 타이머는 없다.
4. **죽은 view의 손실은 명시된 경계를 가진 예외다.** 죽은 view는 죽을 때 실행 중이던 task의 수를 잃는다. 죽은 뒤에는 코드가 실행되지 않기 때문이다. 호스트는 죽은 view마다 `host.view.log-counts-possibly-lost {surface, plugin}`을 쓴다. 클래스는 `lifecycle`, level은 `warn`이므로 이 기록은 모든 게이트를 통과한다(`passes_every_gate`와 `PassesEveryGate`에 추가하고, [logging](../spec/logging.md)의 Change 단락에도 적는다). 기록은 "possibly"라고 말한다. 호스트는 수가 대기 중이었는지 알지 못하기 때문이다. 이 예외는 [logging](../spec/logging.md) Principle 3(11행), Count 단락(77행), Bounds 절에 D5-f로 적는다. 정확한 수에 대한 유일한 예외이며, 경계는 죽은 view 하나의 실행 중 task 하나의 거부 기록이다.
5. **변경은 view channel로 view에 닿는다.** 호스트는 테마를 싣는 view channel(`view.channel.ready`, [호스트 계약](../spec/host-contract.md) 197행)로 view에 두 이벤트를 보낸다.
   - `{sok: 1, event: "log-policy", data: {classes}}`, surface 문서가 이미 받는 호스트 이벤트의 payload다(`packages/host/tauriv2/src/log_policy.rs:120`, `packages/host/wailsv3/src/log_policy.go:178`).
   - `{sok: 1, event: "log-classes", data: {classes}}`, 1단계의 map이다. catalog reader가 실행될 때마다 보낸다(`packages/host/wailsv3/src/installed.go:463`, `packages/host/tauriv2/src/installed.rs:492`, 호스트의 시작과 plugin 변경 경로에서 호출).
   호스트는 테마처럼 ready 메시지에 현재 쌍을 보내므로, 생성과 ready 사이의 변경을 잃지 않는다. view는 bridge에서 두 이벤트를 적용한다. `keyOf`(`view.js:211-216`)는 각각을 자기 key로 대응시키고, `dispatch`(`view.js:268`)는 정책과 클래스를 bridge 상태에 저장한다. 페이지 쪽 `view-events.js`는 관여하지 않는다. ready 이전의 post는 기존 규칙(`view.channel.post-before-ready`)으로 거부된다.
6. **제거.** 첫 사용 요청(`view.js:125-135`), `runtime.log.levels`(`view-calls.js:184-187`), `packages/workbench/view-events.js`의 `log.levels` 이벤트와 구독, `subscribe.logLevels`와 `surface-modules.js:261-264`, `:308`, 명세 줄(`native-surfaces.md:113`, `:120`, `:127`; `plugins.md:170`과 ko)을 제거한다. 테스트 `view.test.mjs:370-384`, `view-calls.test.mjs:61,210-214`, `view-events.test.mjs:48-52`는 새 경로로 옮긴다.
7. **`recordError`는 보고한다.** `recordError`(`view.js:116-121`)는 실패한 오류 기록을 조용한 `catch`에서 버린다. 대신 bridge의 `report` 함수를 `{where, text, error}`와 함께 호출하므로 어떤 실패도 조용하지 않다.
8. **대체.** 이 결정은 view에 대해 [logging](../spec/logging.md#policy) 71행과 74행을 대체한다. 시작 기록이 있는 view는 정책을 시작 값으로 받으며 기본 대기 구간이 없다. 호스트가 없는 페이지와 적용된 정책이 없는 호스트에는 기본 error-only 정책이 남는다. D5-f가 이 행들을 바꾼다.

### 근거와 증거

- 원래 규칙은 응답 전에 모든 기록을 보냈다(`view.js:135`). 이는 `logging.md:74`가 surface에 주는 기본값과 맞지 않으며, 정책이 거부할 기록을 IPC로 보낸다(`logging.md:10`). 시작 값은 대기 구간을 없앤다. 호스트는 view를 만들기 전에 정책을 가지고 있다.
- `main`의 페이지 gate는 첫 설정 갱신까지 `error`에서 시작한다(`packages/workbench/log-gate.js:23-24`; `setLogPolicy`의 유일한 호출자는 `settings.js:458`). 페이지 gate로 만든 시작 값은 오래될 수 있고, view 기록에 페이지 gate를 적용하면 호스트가 승인한 기록을 거부한다. 2단계는 view 기록의 두 번째 게이트를 없앤다.
- `plugin-runtime.js:72`(`if (!enabled(level)) return;`)는 거부된 기록을 세지 않고 버린다. `enabled`는 훅을 level만으로 호출한다(`plugin-runtime.js:59-63`). 훅에 이벤트를 넘기는 것(D5-g)과 view에서 세는 것(3단계)이 둘 다 고친다.
- `logging.md:13`과 `:40`: 선언되지 않은 이벤트는 표지와 함께 쓰이며 클래스와 게이트가 없다. 기본 level로 게이트하면 증거를 버리게 되고, 명세가 이를 금지한다.
- `classOf`(`packages/workbench/event-classes.js:137`)는 `main`에 plugin 항목이 없다. 그래서 plugin 이벤트의 클래스는 호스트의 catalog reader에서 얻는다(1단계).
- `log.levels`는 배열을 전달했다(`view-events.js`, `view.js:131,135`). 새 data는 정책 객체이며, 배열 형식은 함께 제거한다.
- Wails 호스트는 `main`에서 `log-policy`를 방출한다(`log_policy.go:178`). Tauri 호스트도 방출한다(`log_policy.rs:120`). `log-classes` 전송은 두 호스트의 새 부분이다.

### 필요한 변경

| ID | 소유자 | 변경 |
|---|---|---|
| D5-a | `main`: `packages/host/tauriv2/src/surfaces.rs`, `packages/host/wailsv3/src/surfaces.go`, `docs/spec/host-contract.md:196-197`과 ko, `docs/spec/events.json`(`host.view.log-counts-possibly-lost`), `passes_every_gate`(`packages/sok/tauriv2/src/event_log.rs`), `PassesEveryGate`(`packages/sok/wailsv3/src/event_log.go`) | 호스트가 생성과 재시작 때 `logPolicy`(적용된 정책)와 `logClasses`(접두사 필터)를 만들고 주입한다. 호스트와 `createSurfaceContext`의 거부 문구. 새 이벤트는 `lifecycle` `warn`으로 선언하고 모든 게이트를 통과한다. |
| D5-b | `feat`: `packages/plugin-api/view.js:116-121`과 테스트 | `recordError`가 실패한 오류 기록에서 `report({where, text, error})`를 호출한다. 거부된 `runtime.error`가 보고되는지 테스트한다. |
| D5-c | `main`: 두 호스트의 ready와 각 `log-policy` 및 catalog reader 변경 시 post 경로; `feat`: `packages/plugin-api/view.js`(`keyOf` `:211-216`, `dispatch` `:268`) | 호스트가 ready와 각 변경 시 쌍을 보낸다. view는 두 값을 bridge 상태에 저장한다. 생성과 ready 사이의 변경이 적용되는지 테스트한다. |
| D5-d | `feat`: `packages/plugin-api/view.js`와 테스트 | 거부된 기록을 클래스와 level별로 세고, task마다 대기 수가 있으면 `queueMicrotask` flush를 하나 예약하며, `pagehide`에서도 flush 한다. 각 전송에 `.catch(report)`. 타이머는 없다. |
| D5-e | `feat`: `view.js:125-135`, `view-calls.js:184-187`, `packages/workbench/view-events.js`(`log.levels`, `subscribe.logLevels`), `surface-modules.js:261-264`, `:308`, `native-surfaces.md:113,120,127`, `plugins.md:170`과 ko; 테스트 `view.test.mjs:370-384`, `view-calls.test.mjs:61,210-214`, `view-events.test.mjs:48-52` | 첫 사용 요청, `runtime.log.levels`, `log.levels` 이벤트와 구독을 제거한다. |
| D5-f | `main`: `docs/spec/logging.md:11,40,71,74,76,77`, Change 단락, Bounds 절과 ko | Principle 3과 Count 단락이 `host.view.log-counts-possibly-lost`와 그 경계(죽은 view 하나의 실행 중 task 하나)로 죽은 view 예외를 적는다. view 규칙(시작 값, 기본 대기 구간 없음); plugin 기록의 선언되지 않은 이벤트. |
| D5-g | `feat`: `packages/plugin-api/plugin-runtime.js:59-72`과 테스트, `packages/plugin-api/test/surface.test.mjs:142,172,195-198` | `logEnabled(level, event)`; `log.enabled(level)`은 모든 level에서 true(2단계); 선언되지 않은 이벤트는 표지와 함께 보내고 게이트하지 않는다. |
| D5-h | `main`: `packages/workbench/log-batch.js`(`countGated`, 그리고 `logGate`를 거치지 않는 view 기록 수락 경로), `packages/workbench/view-calls.js`(`runtime.log`, `runtime.log.gated`) | batcher가 view 기록을 두 번째 게이트 없이 받고, 수를 gated 맵에 받는다. Red 테스트: 페이지 gate는 `error`, view가 호스트 정책이 저장하는 `info` 기록을 보내면 저장되어야 한다. |

### 라운드

#### 라운드 1 (응답)

두 감사자: A(D5 게이트와 소유자), B(D5 변경과 빈틈). 각 반론은 파일에서 확인했다.

| 반론 | 응답 |
|---|---|
| A1: 게이트가 이벤트를 받지 못함 | 수용. 2단계; D5-g. |
| A2: 수가 batcher에 들어갈 경로가 없음 | 수용. 3단계; D5-h. |
| A3: plugin catalog의 소유자와 키 형식 | 수용. 호스트 reader가 있고 키는 전체 이름이다. 1단계; D5-a. |
| A4: 시작 값이 오래될 수 있음 | 수용. 호스트가 적용한 정책으로 만든다. 1단계. |
| A5: 변경 경로가 `log-policy`와 중복 | 일부 수용. `log-policy`가 surface 문서에 닿으므로 5단계가 재사용한다. |
| A6: `log.levels`의 형태와 소유자 | 수용. 제거; D5-e. |
| B1: gate 변경 훅 | 쓰이는 페이지 쪽 변경 경로가 없으므로 해당 없음으로 수용. |
| B2: `host-contract.md:196`을 기존 멤버로 인용 | 수용. 새 멤버다. |
| B3: 선언되지 않은 기록이 정책을 우회 | 라운드 1에서 수용; 라운드 2에서 대체(선언되지 않은 이벤트는 게이트하지 않고 보낸다). |
| B4: 대체 기술이 명세와 맞지 않음 | 수용. 8단계; D5-f. |
| B5: 병렬 전달 경로 | A5와 같다. |
| B6: 마지막 수가 조용히 사라짐 | 일부 수용; 라운드 3에서 대체(4단계). |

#### 라운드 2 (응답)

| 반론 | 응답 |
|---|---|
| C1 / D1: 선언되지 않은 이벤트를 `error`로 게이트하면 `logging.md:13`과 `:40`에 어긋남 | 수용. 2단계는 표지와 함께 게이트 없이 보낸다. |
| C2 / D2: 타이머가 없어 1초 경계가 성립하지 않음 | 라운드 2에서 수용; 라운드 4에서 대체(3단계: microtask flush, 타이머 없음). |
| C3 / D3: 잔여 손실이 Principle 3과 정확한 수 규칙을 낮춤 | 형식으로 수용: `logging.md`에 명시된 예외(D5-f). 라운드 3에서 경계를 좁혔다(4단계). |
| C4: `logClasses`가 시작 때 고정됨 | 수용. 5단계: 호스트가 catalog reader가 바뀔 때마다 `log-classes`를 보낸다. |
| C5: 변경 경로와 시작 값의 출처가 정해지지 않음 | 수용. 5단계가 경로를 정하고, 1단계는 파일 텍스트가 아니라 적용된 정책을 쓴다. |
| D4: `recordError`에 소유 변경이 없음 | 수용. 7단계; D5-b. |
| 인용: `view-events.js` 경로 | `packages/workbench/view-events.js`로 정정. |

#### 라운드 3 (응답)

두 감사자가 라운드 3 본문을 검토했고, 각 반론은 `main`과 `feat`에서 확인했다.

| 반론 | 응답 |
|---|---|
| B1: 4단계가 기준을 낮추고, 손실 기록이 `lifecycle=off`로 게이트되며, 1초 경계는 크기를 묶지 못함 | 수용. 4단계가 기록을 `host.view.log-counts-possibly-lost`, `lifecycle` `warn`, 모든 게이트 통과로 명명한다(D5-a). 경계는 실행 중 task 하나로 줄었다(3단계, microtask flush). |
| B2: `view-events.js`는 view 쪽 적용 위치가 아니며 `keyOf`가 알 수 없는 이벤트를 `native:`로 보냄 | 수용. `feat` `view.js:211-216`에서 확인. 5단계는 `keyOf`와 `dispatch`에서 적용한다(D5-c). |
| B3: Go 호스트에 `log-policy` 방출자가 없음 | 수용하지 않음: `main` `packages/host/wailsv3/src/log_policy.go:178`이 `log-policy`를 방출하고, Tauri 호스트도 `log_policy.rs:120`에서 방출한다. `log-classes` 전송은 두 호스트 모두에 추가한다(5단계). |
| B4: `view.channel.ready`는 `host-contract.md:197`에 있음 | 수용; 1단계와 5단계가 196-197을 인용한다. |
| B4: `runtime.log.gated` 타이머 전송에 실패 처리가 없음 | 수용. 3단계는 모든 전송에 `.catch(report)`를 쓰고 타이머를 없앤다. |
| D5-1: 페이지 gate가 호스트가 승인한 기록을 버림 | 수용. 2단계와 D5-h: view 기록은 두 번째 게이트 없이 batcher를 지난다; Red 테스트 포함. |
| D5-2: 손실 기록 자체가 게이트될 수 있음 | 수용. 4단계가 `lifecycle` `warn`으로 모든 게이트를 통과하게 한다. |
| D5-3: 호스트는 수가 대기 중이었는지 알 수 없음 | 수용. 4단계가 모든 죽은 view에 "possibly"를 쓴다. |
| D5-4: 결정이 Principle 3을 낮춤 | 부분 수용, B1과 같다: 예외는 명명되고, 실행 중 task 하나로 제한되며, 기록된다. |
| D5-5: 선언되지 않은 이벤트에 대한 `log.enabled(level)`의 답이 정해지지 않음 | 수용. 2단계: `log.enabled(level)`은 모든 level에서 true. |

## D6. View 단축키 표 (F234)

### 원래 결정

`feat` `packages/plugin-api/view.js:139-164`: view가 페이지에서 읽은 단축키 표를 등록한다(`runtime.shortcuts.read`, `viewShortcuts`가 응답, `packages/workbench/view-calls.js:86-88`). owner가 `workbench`인 행은 막고 명령 경로로 넘긴다(`runtime.shortcuts.run`, `view.js:153-158`, `view-calls.js:205-212`). 등록 전 첫 키는 `runtime.shortcuts.missing`을 보내고(`view.js:143-147`), 이는 `page.view.shortcut-table-missing`으로 기록된다. bridge는 `shortcuts.register()`를 내보낸다(`view.js:160-164`, `:331`에서 반환).

### 결정 본문 (라운드 4)

1. **view는 어떤 키도 막지 않는다.** `viewShortcuts`는 `when`이 `Any focus`인 행(14개, 모두 owner `native menu`)과 owner가 `view`인 행(`Escape`, 텍스트 입력 키)만 남긴다. owner `workbench` 행은 view 표에 들어오지 않는다. workbench 행은 다른 context를 가지기 때문이다(`packages/workbench/shortcuts.json:17-23`). view가 소유한 키(텍스트 입력)는 기본 동작을 유지하고 view의 first responder에 닿는다. view의 Escape도 view 자신의 핸들러가 `preventDefault`를 부르지 않는 한 기본 동작을 유지한다(4단계).
2. **표 경로, 그 API, 그 이벤트를 제거한다.**
   - keydown 리스너와 `shortcutTable`(`view.js:139-159`).
   - `shortcuts.register()`와 그 반환(`view.js:160-164`, `:331`).
   - 페이지 쪽: `viewShortcuts`와 `runtime.shortcuts.read`, `.missing`, `.run` 분기(`view-calls.js:86-88`, `:199-212`), `shortcuts.json` import와 `shortcuts` 옵션(`surface-modules.js:21`, `:287`, `view-calls.js:15`).
   - 이벤트 `page.view.shortcut-table-missing`과 `page.input.shortcut.failed`(`docs/spec/events.json:690`, `:699`), 클래스 표의 그 행(`packages/sok/tauriv2/src/event_classes.rs:167`, `packages/sok/wailsv3/src/event_classes.go:125`, `packages/workbench/event-classes.js:112`)은 재생성한다.
   AGENTS.md: 쓰이지 않는 코드 경로는 제거한다. 쓰이지 않는 표는 두지 않는다.
3. **명세, 용어, 표 문구.** 영문과 국문 모두:
   - `packages/plugin-api/terms.json:394`("shortcut table", 제거된 등록의 정의): "The workbench table of shortcuts, each with its owner and command (`packages/workbench/shortcuts.json`)"로 바꾼다.
   - `main` `docs/spec/native-surfaces.md:137`(Input)과 `feat` `native-surfaces.md:141`.
   - `main` `docs/spec/plugin-processes.md:94-103`(규칙 7)과 이벤트 행 `:141-142`; `:166`(계약 사례 목록 "RPC, snapshot, restart, shortcut table"): 단축키 표 사례를 제거한다.
   - `main` `docs/spec/exposure.md:67`(owner `view`): "a key that the view leaves to its default action; no workbench row is handled by a view"로 고친다.
   - `main` `docs/spec/exposure.md:94-95`와 `feat` `docs/spec/exposure.md:71`: `feat`의 표 단락은 삭제하고, view 절은 "a plugin view prevents no key"를 가리킨다.
   - `feat` `docs/plans/plugin-processes.md:113-123`(규칙 7), `:162-163`(이벤트 행), `:190`(계약 사례 목록).
   - `main` `packages/workbench/shortcuts.json` 24행(owner `view`, `Escape`): `when` 문구는 "A plugin view has keyboard focus; the view sends runtime.dismiss and the key keeps its default action"이 되고, `exposure.md:94`가 이를 따른다. 25행(텍스트 입력 키): "A plugin view has a text input focused; the view handles the key itself and it keeps its default action".
   - `scripts/test/shortcut-table.test.mjs`를 같은 변경에서 고친다.
   - `CHANGELOG.md:8`, `CHANGELOG.ko.md:8`, `docs/features.md:1239`와 ko: F234 표 경로가 제거되고 대체되었으며, 제거된 API를 적는다.
4. **Escape는 선언된 명령으로 열린 페이지 overlay를 닫는다.** view에 포커스가 있을 때 Escape는 페이지 picker의 리스너에 닿지 않는다(`packages/workbench/plane.js:745-746`, picker가 열린 동안에만 붙고 페이지에 포커스가 있을 때만 쓰인다). 그래서 view에 포커스가 있으면 열린 페이지 picker가 닫히지 않는다. 이 결정의 일부로 수정한다.
   - 핵심 명령 `core.layer.dismiss`를 `packages/workbench/core-exposure.js`(`registry.command`)와 `packages/workbench/exposure.json`에 선언하고, `packages/plugin-api/core-exposure.json`을 재생성한다(`exposure.md:59`). 명령은 가장 위에 열린 picker 또는 modal layer를 닫고, 열린 layer가 없으면 아무 일도 하지 않는다. 멱등이다.
   - view bridge는 Escape를 bubble 단계에서 처리하고, `!event.defaultPrevented`일 때만 view 호출 `runtime.dismiss`를 보낸다. 페이지의 view 호출 분기는 `runCore`로 `core.layer.dismiss`를 실행하므로 키가 선언된 명령에 닿는다. `runtime.dismiss`는 자체 명령이 아니라 그 선언된 명령으로 가는 bridge 경로다.
   - 자기 Escape 핸들러(예: 팝오버)가 `preventDefault`를 부르는 view는 호출을 보내지 않는다. 규칙은 bridge에 있으므로 각 view가 자체 코드 없이 이를 얻는다.
   - 네이티브 picker나 modal WebView가 포커스를 가지면 keydown을 직접 받으므로, view는 이를 보지 못하고 호출도 나가지 않는다.
   - view 호출 경로는 `native-surfaces.md`의 view 호출 목록에 추가하고, `make exposure-check`가 명령을 검사한다.
   Red 테스트는 D6-b에 있다. probe(D6-c)는 overlay마다 기대를 확인하며, 수정을 배포할지는 정하지 않는다.
5. **view 포커스에서 cmd+k와 shift+cmd+n.** `cmd+k`(`core.focus.set`, `packages/workbench/shortcuts.json:18`)와 브라우저 빌드의 `shift+cmd+n`(`:17`)은 페이지 keydown에서만 처리되므로, view 포커스에서는 페이지에 닿지 않는다. 좁히기는 지금 배포한다(D6-d). `shortcuts.json:17-18`과 `exposure.md:87-88`(및 ko)의 `when` 문구는 `cmd+k`에 대해 "The library is shown and the page has keyboard focus", `shift+cmd+n`에 대해 "No host chrome (browser build) and the page has keyboard focus"가 된다. 단축키 표 테스트는 `when` 문구를 비교하므로 두 파일은 같은 커밋에서 바꾼다.

### 근거와 증거

- `viewShortcuts`는 owner `workbench` 행을 결코 돌려주지 않으므로, `runtime.shortcuts.run`은 모든 키를 "is not a workbench shortcut of a view"로 거부한다(`view-calls.js:205-212`). 성공할 수 없는 경로는 쓰이지 않는 경로다.
- 표는 view가 쓰는 것을 주지 않는다. `native menu`와 `view` 행은 기본 동작을 유지하고, view는 어차피 막지 않는다.
- F212.6a의 rule-7 gate(`plugin-processes.md` feat `:267`, F212.7 앞의 단축키 표 gate)는 표와 함께 제거된다. 그 Escape 측정은 F212.6a에 연결된 D6-c에 남긴다.
- 형제 plugin checkout(`../plugins/browser`, `editor`, `files`, `hwp`, `terminal`, 즉 `scripts/workspace-registry.json`의 저장소들)에서 `shortcuts.register`, `runtime.shortcuts`, `shortcut-table-missing`을 `git grep`으로 찾았고 일치하는 항목이 없었다. 따라서 선언된 plugin 중 제거되는 API를 지금 부르는 것은 없다. 변경 기록은 여전히 제거된 API를 적는다.
- `exposure.md:53`은 사용자 동작이 선언된 명령을 실행하도록 요구한다. Escape 대체는 레지스트리를 거쳐 `core.layer.dismiss`에 닿으므로 그 명령을 선언한다.

### 필요한 변경

| ID | 소유자 | 변경 |
|---|---|---|
| D6-a | `feat`: `packages/plugin-api/view.js:139-164,331`, `packages/plugin-api/terms.json:394`, `packages/workbench/view-calls.js:15,86-88,199-212`, `packages/workbench/surface-modules.js:21,287`, `docs/spec/events.json:690,699`, 클래스 표 세 개, `native-surfaces.md:141`, `exposure.md:71`, `docs/plans/plugin-processes.md:113-123,162-163,190`, `CHANGELOG.md:8`, `docs/features.md:1239`과 ko; `main`: `docs/spec/native-surfaces.md:137`, `plugin-processes.md:94-103,141-142,166`, `exposure.md:67,94-95`과 ko, `packages/workbench/shortcuts.json:24-25`, `scripts/test/shortcut-table.test.mjs` | 표 경로, API, 이벤트와 3단계의 명세·용어 문구를 제거한다. view는 어떤 키도 막지 않는다고 명시한다. |
| D6-b | `feat`: `packages/plugin-api/test/view.test.mjs:394-419`, `packages/workbench/test/view-calls.test.mjs:13,278-310`, `fakes()`의 `shortcuts` 옵션; `packages/workbench`의 `core.layer.dismiss` 테스트 | 표 테스트를 삭제한다. 추가: view의 keydown은 결코 막히지 않고 `runtime.shortcuts.*` 호출이 없다(현재 코드에서 Red). Escape 테스트 추가: (a) 페이지 picker가 열려 있으면 view Escape 한 번에 한 번 닫힌다; (b) `preventDefault`를 부르는 view 핸들러는 호출을 보내지 않는다; (c) 열린 layer가 없으면 `core.layer.dismiss`는 no-op; (d) 네이티브 modal이 포커스를 가지면 view는 보내지 않는다. |
| D6-c | `feat` (probe) | overlay마다(페이지 picker, 네이티브 picker, modal) view 포커스에서 macOS probe: 4단계의 기대를 확인하거나 고친다; view 포커스에서 cmd+k와 shift+cmd+n. F212.6a에 연결. |
| D6-d | `main`: `packages/workbench/shortcuts.json:17-18`, `docs/spec/exposure.md:87-88`과 ko | 5단계의 `when` 문구를 지금 좁힌다. 한 커밋. |
| D6-e | `main`(`docs/features.md`, F238-b 기록) | 3단계의 형제 검사(다섯 plugin checkout에서 일치 없음)를 제거와 함께 기록하고, 호환성 깨짐 changelog 줄을 적는다. |
| D6-f | `main`: `docs/features.md`의 F212.6a와 F212.7 항목(+ko) | F212.6a(표 gate 제거, Escape 측정은 D6-c에 남김)와 F212.7(표 gate 없음)을 다시 범위 정한다. |
| D6-g | `main`: `packages/workbench/core-exposure.js`(`registry.command("core.layer.dismiss")`), `packages/workbench/exposure.json`, 재생성한 `packages/plugin-api/core-exposure.json`, `docs/spec/native-surfaces.md`(view 호출 목록에 `runtime.dismiss`), `exposure.md:53`(변경 없음; 이 규칙이 이유다); `feat`: `packages/plugin-api/view.js`(bubble 단계 Escape, `!defaultPrevented`, `runtime.dismiss` 전송), `packages/workbench/view-calls.js`(`runtime.dismiss` 분기가 `runCore`로 `core.layer.dismiss` 실행) | 4단계의 Escape 대체를 구현한다. |

### 라운드

#### 라운드 1 (응답)

| 반론 | 응답 |
|---|---|
| C1: 파일 누락 | 수용; 2단계, 3단계, D6-a에 나열. |
| C2: 테스트 목록 불완전 | 수용; D6-b. |
| C3: view 소유 행의 낡은 문구 | 수용; 3단계. |
| C4: Escape 항목이 잘못 기술되었고 해결 경로가 없음 | 수용; 4단계. |
| D1: `shortcuts.register()` API가 남아 있음 | 수용; 2단계. |
| D2: 다른 명세 문장 | 수용; 3단계. |
| D3: Escape 항목이 핸들러가 있는 것처럼 기술됨 | 수용; 4단계. |
| D4: cmd+k와 shift+cmd+n이 과장됨 | 수용; 5단계, D6-d. |

#### 라운드 2 (응답)

| 반론 | 응답 |
|---|---|
| E1: 24행 `when` 문구가 5단계와 모순 | 수용; 3단계. |
| E2: 낡은 위치(용어, plugin-processes 줄, feat 계획 줄) | 수용; 3단계, D6-a. 계약 사례 `:166`은 제거. |
| E3: 국문 사본 불완전 | 수용; D6-a가 모든 ko 사본을 나열. |
| E4: `feat` `exposure.md:71`에 대체 문장이 없음 | 수용; 단락 삭제(3단계). |
| E5: `exposure.md:67`의 "handles inside itself"가 남음 | 수용; 3단계. |
| F1: Escape 대체가 내부적으로 모순 | 수용; 라운드 2는 대체를 배포하기로 했고, 라운드 4가 이를 유지하며 완성한다. |
| F2: `runtime.dismiss`는 선언된 명령이 아님 | 수용; 라운드 4의 4단계: view 호출이 선언된 `core.layer.dismiss`로 간다. |
| F3: 이중 닫힘과 Escape 가로채기 | 수용; 라운드 4의 4단계와 D6-b (a)부터 (d). |
| F4: rule-7 F212.6a gate가 대체 없이 빠짐 | 수용; D6-f가 F212.6a와 F212.7을 다시 범위 정한다. |
| F5: 공개 API 제거의 안전성이 보이지 않음 | 수용; 형제 checkout을 검색했고 일치 없음(근거). D6-e. |
| F6: cmd+k와 shift+cmd+n 좁히기가 probe를 기다림 | 수용; 5단계가 지금 좁힌다(D6-d). |
| F7: view 자신의 키는 view 안에서 처리되어야 함 | 수용; 1단계. |

#### 라운드 3 (응답)

| 반론 | 응답 |
|---|---|
| D6-1: D6-d가 테스트가 보는 `shortcuts.json:17-18`을 빠뜨림 | 수용; 5단계와 D6-d가 `shortcuts.json:17-18`을 한 커밋에 포함한다. |
| D6-2: `shortcuts.json` 24-25행의 소유가 없고 24행 문구가 Escape 호출과 모순 | 수용; D6-a가 `shortcuts.json:24-25`를 소유하고, 3단계가 새 문구를 주며, `exposure.md:94`가 이를 따른다. |
| D6-3: Escape 대체에 필요한 변경 행이 없음 | 수용; D6-g. |
| D6-B1: `runtime.dismiss`가 선언된 명령이 아닌 날 호출임(`exposure.md:53`) | 수용; 4단계: bridge 경로가 선언된 명령 `core.layer.dismiss`를 실행한다. |
| D6-B2: 대체가 view 자신의 Escape UI에서도 발동함 | 수용; 4단계: bubble 단계의 `!defaultPrevented`; D6-b (b). |
| D6-B3: 형제 plugin 검사가 완전한 제거 규칙이 아님 | 수용; 검사를 수행하고 기록했다(근거; D6-e). 제거는 호환성 깨짐으로 기록한다. |

## 하위 항목

`docs/features.md`에 F212 아래 F238-b-1부터 F238-b-N까지, 위 행마다 하나씩 등록한다.

## 다른 곳에 기록할 내용

각 행은 소유자를 적는다. `main`이 소유한 행은 `main`에서 바꿀 내용이고, `feat/view-bridge-F231`이 소유한 행은 그 브랜치에서 바꿀 내용이다.
