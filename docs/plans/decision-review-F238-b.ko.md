# 결정 검토 F238-b: view 로그 level과 view 단축키 표

[English](decision-review-F238-b.md)

이 기록은 브랜치 `feat/view-bridge-F231`에서 적대적 검토 없이 내린 두 결정을 검토한다.

- D5(F233): view bridge가 첫 사용 시 요청으로 저장된 로그 level을 알아낸다.
- D6(F234): view가 단축키 표를 등록하고 workbench 키를 명령 경로로 넘긴다.

각 결정은 본문, 근거, file과 line이 있는 증거, 필요한 변경을 적는다. 감사자는 새 subagent(Haiku)이며, 각자 실질 반론과 구체적 해결안을 낸다. 문구와 인용 정정은 직접 반영한다. 각 라운드는 아래에 기록한다. 한 라운드의 두 감사자가 모두 실질 반론이 없을 때까지 반복한다.

인용: `feat`는 `feat/view-bridge-F231`, `main`은 이 저장소의 `main`이다.

## 범위

- D5: view 페이지가 어떤 level로 게이트하는지, level이 view에 어떻게 닿고 최신으로 유지되는지, view가 거부된 기록을 어떻게 세는지. 선언되지 않은 plugin 기록의 속도 상한, 대기 중인 거부의 flush 시점, 죽은 view의 손실 수 기록은 여기서 정하지 않는다. 이것들은 각 근거와 함께 하위 항목 S1부터 S3이다.
- D6: view에 단축키 표가 필요한지, view가 어떤 키를 workbench로 넘기는지, Escape가 열린 페이지 picker를 어떻게 닫는지.

범위 밖: 문구, 새 필드의 정확한 이름(하위 항목에서 정한다), 해당 모듈의 단위 테스트가 정하는 동작, 하위 항목 S1부터 S3.

## D5. View 로그 level (F233)

### 원래 결정

`feat` `packages/plugin-api/view.js:116-135`: bridge가 첫 기록에서 `runtime.log.levels`를 호출하고(`storedLevel`, 127행), `levels === null`인 동안 모든 기록을 보내며(135행), 거부된 읽기는 오류 줄로 보고한다(`recordError`, 116행). 페이지는 plugin 기록의 level로 응답한다(`packages/workbench/view-calls.js:184-187`). 변경은 `log.levels` 이벤트로 온다(`view.js:130-131`; `packages/workbench/surface-modules.js:261-264`, `:308`; `packages/workbench/view-events.js`).

### 결정 본문 (라운드 6, 축소)

감독자가 범위를 줄였다. 속도 상한, flush 규칙, 죽은 view의 손실 기록은 이 본문에서 빼고 S1부터 S3으로 등록한다. 라운드 5의 반론은 아래에 답하고 여기에 반영했다.

1. **호스트는 주입할 때마다 시작 값을 만든다.** 생성 때와 재시작 때마다 호스트는 그 순간의 살아 있는 상태에서 두 멤버를 만들어 `window.sokSurface`(`ViewStart`, `packages/host/tauriv2/src/surfaces.rs:61`, `packages/host/wailsv3/src/surfaces.go:66`)에 주입한다. 두 멤버는 view의 저장된 시작 값(`ViewSpec`, `view_lifecycle.rs:28-29`, `view_lifecycle.go:25-26`)의 일부가 아니므로, 재시작이 오래된 정책을 다시 보내는 일은 없다.
   - `logPolicy`: [클래스와 정책](../spec/logging.md#classes-and-policy)의 다섯 클래스이며, 값은 `off`, `error`, `warn`, `info`, `debug`, `trace` 중 하나다. 호스트가 마지막으로 적용한 정책에서 읽는다. 적용된 파일이 없으면 기본값이고, 있으면 마지막 유효한 `log-policy.json`이다. 거부된 파일은 값을 바꾸지 않는다(`logging.md:93`). 시작 값이 파일 텍스트인 경우는 없다.
   - `logClasses`: surface plugin의 각 전체 이벤트 이름 `plugin.<id>.<event>`를 클래스에 대응시킨 것이며, catalog 적용기가 저장한 plugin 클래스 map에서 읽는다(`apply_plugin_event_classes`, `packages/host/tauriv2/src/installed.rs:492`가 `log.set_plugin_classes`를 호출하며, Go 쪽은 `packages/host/wailsv3/src/installed.go:463`). map은 D5-a가 추가하는 getter로 노출한다(`packages/sok/tauriv2/src/event_log.rs`의 `plugin_classes()`, `packages/sok/wailsv3/src/event_log.go`의 `PluginClasses()`). 호스트는 접두사 `plugin.<id>.`로 거른다.
   페이지의 준비 값은 두 멤버를 싣지 않는다. 정책이나 클래스 map을 읽을 수 없으면 주입 단계의 오류이며, 그 파일이나 getter의 이름을 적는다. 멤버가 없는 것으로 다루지 않는다.
2. **생산자는 이벤트마다 결정하고, 호스트 writer가 다시 결정한다.** bridge는 기록을 클래스로 게이트한다. `logEnabled(level, event)`는 `logClasses`와 `logPolicy`로 답하며, `fieldsOf`는 저장되는 이벤트에만 필드를 만든다. 공개 API의 한 인자 형식 `log.enabled(level)`은 두 인자 형식 `log.enabled(level, event)`로 바뀐다(`docs/spec/plugins.md:241`, `plugins.ko.md:242`; D5-e). 두 인자 형식도 같은 방식으로 답한다. 이름이 `logClasses`에 있는 기록은 `logPolicy[class]`가 그 level을 저장할 때 저장된다. 거부된 기록은 보내지 않고 센다(3단계). 페이지 batch는 view만이 아니라 모든 plugin의 plugin 계층 기록을 싣으므로, 호스트 writer는 batch의 `plugin` 계층 모든 이벤트에 자기 plugin 클래스 map의 클래스로 `enabled(class, level)`을 적용하고, 거부는 `log.gated`로 센다. 게이트 규칙은 [logging](../spec/logging.md#policy) 76행이며, 도달하는 이벤트마다 게이트에 묻도록 모든 writer에 요구한다. view의 게이트는 최적화이고, 경계는 writer다. writer는 현재 게이트되지 않는 main 페이지의 plugin 기록도 게이트한다. 회귀 테스트는 D5-a에 적는다. 페이지 batcher는 plugin 기록을 게이트하지 않는다. `classOf`가 이들에 undefined를 돌려주고(`packages/workbench/event-classes.js:137-143`), 페이지 gate는 클래스 없는 이벤트를 저장한다(`packages/workbench/log-gate.js:28`). 이름이 `logClasses`에 없는 기록은 선언되지 않은 이벤트다. 클래스가 없으므로 어떤 정책 값도 적용되지 않는다. 표지 `undeclared`와 함께 보내며(`logging.md` 40행, `undeclared` 필드), [logging](../spec/logging.md#policy) 76행에 따라 게이트를 통과한다. 그 속도는 S1이다.
3. **거부된 기록은 view에서 센다.** view는 거부된 기록을 클래스와 level별로 세고, 그 수를 `runtime.log.gated {class, level, count}` 호출로 보낸다. 각 전송에는 `.catch(report)`가 붙는다. 페이지는 수를 batcher의 gated 맵에 더하며(`batcher.countGated`), `page.log.gated`로 보고된다. 수가 view를 떠나는 시점은 S2의 대상이다. 이 결정이 요구하는 것은 거부된 모든 기록이 세어지고, 어떤 수도 기록 없이 버려지지 않는다는 점뿐이다.
4. **변경은 view channel로 view에 닿는다.** 호스트는 테마를 싣는 view channel(`view.channel.ready`, [호스트 계약](../spec/host-contract.md) 196-197행)로 view에 두 이벤트를 보낸다.
   - `{sok: 1, event: "log-policy", data: {classes}}`, surface 문서가 이미 받는 호스트 이벤트의 payload다(`packages/host/tauriv2/src/log_policy.rs:120`, `packages/host/wailsv3/src/log_policy.go:178`);
   - `{sok: 1, event: "log-classes", data: {classes}}`, 1단계의 map이다. catalog 적용기가 실행될 때마다 보낸다.
   호스트는 테마처럼 ready 메시지에 현재 쌍을 보낸다. 변경은 기록된 ready 문서가 있는 view에만 보낸다. 아직 생성 중인 view는 ready 메시지에서 현재 쌍을 받으므로, 건너뛴 post는 오류가 아니다. 그 밖의 거부된 post는 호스트 오류로 기록한다. view는 bridge에서 두 이벤트를 적용한다. `keyOf`(`view.js:211-216`)는 각각을 자기 key로 대응시키고, `dispatch`(`view.js:268`)는 정책과 클래스를 bridge 상태에 저장한다. 페이지 쪽 `view-events.js`는 관여하지 않는다.
5. **`recordError`는 보고한다.** `recordError`(`view.js:116-121`)는 실패한 오류 기록을 조용한 `catch`에서 버린다. 대신 bridge의 `report` 함수를 `{where, text, error}`와 함께 호출하므로 어떤 실패도 조용하지 않다.
6. **제거.** 첫 사용 요청(`view.js:125-135`), `runtime.log.levels`(`view-calls.js:184-187`), `packages/workbench/view-events.js`의 `log.levels` 이벤트와 구독(주석 `view-events.js:14,19,22` 포함), `subscribe.logLevels`와 `surface-modules.js:261-264`, `:308`(주석 `:260` 포함), `view-calls.js:28,33`의 주석을 제거한다. 공개 `log.enabled(level)` 한 인자 형식은 두 인자 형식으로 바뀐다(2단계). `native-surfaces.md:111`의 페이지 게이트와 writer를 설명하는 문장은 다시 쓴다(D5-i). 테스트는 새 경로로 옮긴다: `packages/plugin-api/test/view.test.mjs:370-384`, `packages/workbench/test/view-calls.test.mjs:61,210-214`, `packages/workbench/test/view-events.test.mjs:48-52`.
7. **대체.** 이 결정은 view에 대해 [logging](../spec/logging.md#policy) 71행과 74행을 대체한다. 시작 기록이 있는 view는 정책을 시작 값으로 받으며 기본 대기 구간이 없다. 호스트가 없는 페이지와 적용된 정책이 없는 호스트에는 기본 error-only 정책이 남는다. D5-f가 이 행들을 바꾼다.

### 근거와 증거

- 원래 규칙은 응답 전에 모든 기록을 보냈다(`view.js:135`). 이는 `logging.md:74`가 surface에 주는 기본값과 맞지 않으며, 정책이 거부할 기록을 IPC로 보낸다(`logging.md:10`). 시작 값은 대기 구간을 없앤다. 호스트는 view를 만들기 전에 정책을 가지고 있다.
- `main`의 페이지 gate는 첫 설정 갱신까지 `error`에서 시작한다(`packages/workbench/log-gate.js:23-24`). 그러나 plugin 기록은 게이트하지 않으므로(2단계), 오래된 시작 값은 페이지 gate의 문제가 아니다. 시작 값은 호스트에서 온다.
- `plugin-runtime.js:72`(`if (!enabled(level)) return;`)는 거부된 기록을 세지 않고 버린다. `enabled`는 훅을 level만으로 호출한다(`plugin-runtime.js:59-63`). 이벤트별 확인(D5-g)과 view 쪽 수(3단계)가 둘 다 고친다.
- `log.levels`는 배열을 전달했다(`view-events.js`, `view.js:131,135`). 새 data는 정책 객체이며, 배열 형식은 함께 제거한다.
- Wails 호스트는 `main`에서 `log-policy`를 방출한다(`log_policy.go:178`). Tauri 호스트도 방출한다(`log_policy.rs:120`). `log-classes` 전송은 두 호스트의 새 부분이다.

### 필요한 변경

| ID | 소유자 | 변경 |
|---|---|---|
| D5-a | `main`: `packages/host/tauriv2/src/surfaces.rs`, `packages/host/wailsv3/src/surfaces.go`(주입 script가 주입할 때마다 멤버를 만든다, `documents.rs:2132`, `documents.go:426`), `packages/sok/tauriv2/src/event_log.rs`(`set_plugin_classes` 옆 `plugin_classes()` getter), `packages/sok/wailsv3/src/event_log.go`(`SetPluginClasses` 옆 `PluginClasses()` getter); batch의 `plugin` 계층 모든 이벤트에 대한 host writer 게이트 | 호스트는 각 주입 때 `logPolicy`와 `logClasses`를 만들며, 저장된 시작 값에서 읽지 않는다. writer는 모든 `plugin` 계층 이벤트에 `enabled(class, level)`을 적용하고 거부를 `log.gated`로 센다. 회귀 테스트: 클래스 level 아래의 main 페이지 plugin 기록을 writer가 거부한다. |
| D5-b | `feat`: `packages/plugin-api/view.js:116-121`과 테스트 | `recordError`가 실패한 오류 기록에서 `report({where, text, error})`를 호출한다. 거부된 `runtime.error`가 보고되는지 테스트한다. |
| D5-c | `main`: 두 호스트의 ready와 각 `log-policy` 및 catalog 적용기 변경 시 post 경로; `feat`: `packages/plugin-api/view.js`(`keyOf` `:211-216`, `dispatch` `:268`) | 호스트는 ready에 쌍을 보내고, 각 변경은 기록된 ready 문서가 있는 view에만 보낸다. 테스트: 생성과 ready 사이의 변경은 오류 줄 없이 ready에서 적용된다; ready view에 대한 변경은 적용된다; ready view에 대한 거부된 post는 기록된다. |
| D5-d | `feat`: `packages/plugin-api/view.js`와 테스트 | 거부된 기록을 클래스와 level별로 센다. 각 수는 `runtime.log.gated {class, level, count}`로 보내며 `.catch(report)`를 붙인다. flush 시점은 S2다. |
| D5-e | `feat`: `view.js:125-135`, `view-calls.js:184-187`과 주석 `:28,33`, `packages/workbench/view-events.js`(`log.levels`, `subscribe.logLevels`, 주석 `:14,19,22`), `surface-modules.js:260-264`, `:308`; `docs/spec/plugins.md:241`과 `plugins.ko.md:242`(한 인자 `log.enabled(level)`을 `log.enabled(level, event)`로 바꾼다); 테스트 `packages/plugin-api/test/view.test.mjs:370-384`, `packages/workbench/test/view-calls.test.mjs:61,210-214`, `packages/workbench/test/view-events.test.mjs:48-52` | 첫 사용 요청, `runtime.log.levels`, `log.levels` 이벤트와 구독을 제거한다. 공개 `log.enabled` 시그니처와 명세 줄을 바꾸고 테스트를 옮긴다. |
| D5-f | `main`: `docs/spec/logging.md:71,74`과 ko | view 규칙: 시작 값, 기본 대기 구간 없음(7단계). |
| D5-g | `feat`: `packages/plugin-api/plugin-runtime.js:59-72`와 테스트, `packages/plugin-api/test/surface.test.mjs:142,172,195-198`(새 기대: 두 인자 형식은 이벤트마다 답하고, 선언되지 않은 이벤트는 `true`로 답한다) | `logEnabled(level, event)`와 `log.enabled(level, event)`가 이벤트마다 답한다(2단계). `fieldsOf`는 저장되는 이벤트에만 필드를 만든다. |
| D5-h | `main`: `packages/workbench/log-batch.js`(view 수를 위한 `countGated`), `packages/workbench/view-calls.js`(`runtime.log.gated`) | batcher가 view의 수를 gated 맵에 받는다. 회귀 테스트: 페이지 batcher는 plugin 기록을 게이트하지 않는다. |
| D5-i | `main`: `docs/spec/native-surfaces.md`(view call 목록에 `runtime.log.gated {class, level, count}`를 더하고, view 이벤트에 ready와 각 변경에서 보내는 `log-policy`와 `log-classes`를 더하며, 111행의 게이트와 writer 문장을 시작 값과 writer 재확인으로 다시 쓴다), ko | view channel 계약을 코드 변경 전에 명세에 적는다(AGENTS.md: 계약이 바뀌면 명세를 먼저 고친다). |

### D5의 하위 항목 (닫을 때 등록, 여기서 정하지 않음)

- **S1, 선언되지 않은 plugin 기록의 속도.** 선언되지 않은 plugin 기록에는 클래스가 없으므로 어떤 정책 값도 상한을 두지 않으며, `log.enabled`는 모든 level에서 true로 답한다. 모든 클래스가 `off`인 plugin도 선언되지 않은 기록을 상한 없이 쓸 수 있다. 근거: 라운드 4 A-3. `logging.md` 76행은 선언되지 않은 이벤트에 클래스와 게이트가 없다고 말하고, 13행은 표지를 말하며, 속도 경계는 어느 행에도 없다. 요구: 자체 적대적 검토를 거친 결정. surface마다 상한과 수 기록을 두거나, 상한이 없다는 진술을 두거나 둘 중 하나다.
- **S2, 대기 중인 거부의 flush.** view는 거부된 기록을 센다(3단계). 그러나 명세는 수가 언제 view를 떠나는지 정하지 않는다. `logging.md`의 Count 단락(77행)은 수가 flush할 때와 마지막 보고 뒤 1초가 지났을 때 보고된다고 요구한다. 근거: 라운드 4 A-1은 microtask flush가 task마다 IPC를 하나 보낸다는 것을 보였고, 타이머 없는 flush는 뒤따르는 거부가 없을 때 수를 쥐고 있을 수 있다. 요구: 대기 수의 경계를 둔 flush 규칙, 각 전송의 `.catch(report)`, 그 경계를 적는 Bounds 항목.
- **S3, 죽은 view와 함께 잃는 수.** 죽은 view는 대기 중인 수를 잃는다. 죽은 뒤에는 코드가 실행되지 않기 때문이다. 근거: `logging.md` Principle 3(11행)은 손실이 세어지고 명시된다고 말하며, Count 단락(77행)은 정확한 수를 준다. 요구: 죽은 view마다 모든 게이트를 통과하며 수가 잃어졌을 수 있다고 말하는 호스트 기록, `logging.md`의 예외, 그 예외의 경계. 자체 적대적 검토로 정한다.

### 라운드

#### 라운드 1 (응답)

두 감사자: A(D5 게이트와 소유자), B(D5 변경과 빈틈). 각 반론은 파일에서 확인했다.

| 반론 | 응답 |
|---|---|
| A1: 게이트가 이벤트를 받지 못함 | 수용. 2단계; D5-g. |
| A2: 수가 batcher에 들어갈 경로가 없음 | 수용. 4단계; D5-h. |
| A3: plugin catalog의 소유자와 키 형식 | 수용. 호스트 reader가 있고 키는 전체 이름이다. 1단계; D5-a. |
| A4: 시작 값이 오래될 수 있음 | 수용. 호스트가 적용한 정책으로 만든다. 1단계. |
| A5: 변경 경로가 `log-policy`와 중복 | 일부 수용. `log-policy`가 surface 문서에 닿으므로 6단계가 재사용한다. |
| A6: `log.levels`의 형태와 소유자 | 수용. 제거; 7단계, D5-e. |
| B1: gate 변경 훅 | 쓰이는 페이지 쪽 변경 경로가 없으므로 해당 없음으로 수용. |
| B2: `host-contract.md:196`을 기존 멤버로 인용 | 수용. 새 멤버다. |
| B3: 선언되지 않은 기록이 정책을 우회 | 라운드 1에서 수용; 라운드 2가 바꿈(선언되지 않은 이벤트는 게이트 없이 보낸다); 라운드 5가 상한을 둔다(3단계). |
| B4: 대체 기술이 명세와 맞지 않음 | 수용. 9단계; D5-f. |
| B5: 병렬 전달 경로 | A5와 같다. |
| B6: 마지막 수가 조용히 사라짐 | 일부 수용; 라운드 3과 5가 바꿈(4, 5단계). |

#### 라운드 2 (응답)

| 반론 | 응답 |
|---|---|
| C1 / D1: 선언되지 않은 이벤트를 `error`로 게이트하면 `logging.md:13`과 `:40`에 어긋남 | 수용. 선언되지 않은 이벤트는 표지와 함께 게이트 없이 보내며, 라운드 5가 상한을 둔다. |
| C2 / D2: 타이머가 없어 경계가 성립하지 않음 | 라운드 2에서 수용; 라운드 5가 microtask flush를 4단계의 세 규칙으로 바꾼다. |
| C3 / D3: 잔여 손실이 Principle 3과 정확한 수 규칙을 낮춤 | 형식으로 수용: 명세의 명시된 예외(D5-f), 경계는 5단계. |
| C4: `logClasses`가 시작 때 고정됨 | 수용. 6단계: 호스트가 적용기 변경마다 `log-classes`를 보낸다. |
| C5: 변경 경로와 시작 값의 출처가 정해지지 않음 | 수용. 6단계가 경로를 정하고, 1단계는 적용된 정책을 쓴다. |
| D4: `recordError`에 소유 변경이 없음 | 수용. 8단계; D5-b. |
| 인용: `view-events.js` 경로 | `packages/workbench/view-events.js`로 정정. |

#### 라운드 3 (응답)

| 반론 | 응답 |
|---|---|
| B1: 4단계가 기준을 낮추고, 손실 기록이 `lifecycle=off`로 게이트됨 | 수용. 기록은 `lifecycle` `warn`으로 모든 게이트를 통과한다(D5-a). |
| B2: `keyOf`가 알 수 없는 이벤트를 `native:`로 보냄 | 수용. `feat` `view.js:211-216`에서 확인; 6단계는 `keyOf`와 `dispatch`에서 적용한다. |
| B3: Go 호스트에 `log-policy` 방출자가 없음 | 수용하지 않음: `main` `packages/host/wailsv3/src/log_policy.go:178`이 `log-policy`를 방출한다. `log-classes` 전송은 두 호스트에 추가한다. |
| B4: `view.channel.ready`는 `host-contract.md:197`에 있음 | 수용; 1단계와 6단계가 196-197을 인용한다. |
| B4: `runtime.log.gated` 타이머 전송에 실패 처리가 없음 | 수용; 모든 전송에 `.catch(report)`. |
| D5-1: 페이지 gate가 호스트가 승인한 기록을 버림 | 라운드 3에서 수용; 라운드 4가 페이지 gate는 plugin 기록을 게이트하지 않음을 확인했으므로 우회를 없앤다(2단계). |
| D5-2: 손실 기록 자체가 게이트될 수 있음 | 수용; `lifecycle` `warn`, 모든 게이트 통과. |
| D5-3: 호스트는 수가 대기 중이었는지 알 수 없음 | 수용; 기록은 "possibly"라고 말한다. |
| D5-4: 결정이 Principle 3을 낮춤 | 일부 수용; 라운드 5가 수 경계를 적는다(5단계). |
| D5-5: 선언되지 않은 이벤트에 대해 `log.enabled(level)`이 정의되지 않음 | 라운드 3에서 수용; 라운드 5가 이벤트별로 만든다(2단계). |

#### 라운드 4 (응답)

| 반론 | 응답 |
|---|---|
| A-1: microtask flush는 task마다 IPC를 하나 보내고, 1초 규칙을 무시함 | 수용. 4단계: 256 대기, 다음 거부에서 확인하는 1초, `pagehide`에서 flush; 타이머 없음. |
| A-2: view가 뒷받침 없는 두 번째 게이트임 | 수용. 2단계: 호스트 writer가 모든 view 기록에 `enabled(class, level)`을 적용하고 거부를 `log.gated`로 센다. |
| A-3: 선언되지 않은 plugin 이벤트가 `off`를 우회함 | 수용. 3단계가 surface마다 초당 100개로 상한을 둔다. 상한은 `logging.md`에 명시한다(D5-f). |
| A-4: 경계가 시간 경계이지 수 경계가 아님 | 수용. 4단계가 256 거부 flush를 더하고, 5단계가 죽은 view당 최대 255 거부를 적는다. |
| B-1: 페이지 gate 근거가 거짓 | 수용, 확인함: `classOf`는 `plugin.<id>.<event>`에 undefined를 돌려주고(`event-classes.js:137-143`), `log-gate.js:28`은 클래스 없는 이벤트를 저장한다. 우회를 없앤다(2단계). |
| B-2: `logClasses`에 Rust getter가 없음 | 수용. 1단계와 D5-a가 `plugin_classes()`와 `PluginClasses()`를 추가한다. 적용기는 `installed.rs:492`. |
| B-3: 수준만 보는 `log.enabled`가 `logging.md:10`, `:76`과 모순 | 수용. 2단계: `log.enabled(level, event)`는 이벤트별이다; D5-g와 D5-f. |

#### 라운드 5 (응답)

D5 본문에 대한 두 감사자(둘 다 새 감사자; 각 반론은 파일에서 확인했다).

| 반론 | 응답 |
|---|---|
| A1: gate와 게이트 없음 규칙은 `logging.md:76`에 있으며 `:40`이 아니다 | 수용. 2단계는 76행을 인용하고, S1은 13, 40, 76행을 인용한다. |
| A2: `native-surfaces.md:113,120,127`과 `plugins.md:170`은 log level과 무관하다 | 수용. 명세에서 `log.levels`를 찾을 수 없다. 제거 목록을 바꾸고, `native-surfaces.md:111`의 문장을 다시 쓴다(D5-i). |
| A3: view 호출 `runtime.log.gated`와 이벤트 `log-policy`, `log-classes`가 `native-surfaces.md`에 없다 | 수용. D5-i가 view 호출 목록, view 이벤트, 문장을 ko 사본과 함께 고친다. |
| A4: 생성 중에 ready가 아닌 view에 변경이 post된다 | 수용. 2단계: 변경은 기록된 ready 문서가 있는 view에만 보내며, 쌍은 ready에서 도착한다; D5-c가 이를 테스트한다. |
| A5: 테스트 경로에 디렉터리가 없다 | 수용. 6단계와 D5-e가 전체 경로를 준다. |
| B-O1: 재시작이 저장된 `ViewSpec` 시작 값을 되풀이한다 | 수용. 1단계: 멤버는 주입할 때마다 만들며 저장된 시작 값의 일부가 아니다. |
| B-O2: 누락 멤버 거부가 호스트가 멤버를 만든다는 것과 모순된다 | 수용. 거부를 없애고, 정책이나 클래스 map을 읽을 수 없으면 주입 단계의 오류로 한다. |
| B-O3: `view` 기록에 대한 writer 게이트는 batch에서 view를 식별할 수 없다 | 수용. writer는 batch의 `plugin` 계층 모든 이벤트를 게이트한다(2단계, D5-a). main 페이지 plugin 기록도 포함된다. |
| B-O4: `log.enabled(level)`은 `plugins.md:241`에 공개되어 있고 제거 목록에 없다 | 수용, 옵션 (ii): 두 인자 형식이 대체한다. `plugins.md:241`과 `plugins.ko.md:242`를 D5-e에 넣었다. |
| B-O5: 제거 목록에 `view-calls.js:28,33`, `view-events.js:14,19,22`, `surface-modules.js:260` 주석이 빠졌다 | 수용. 6단계와 D5-e에 적었다. |

## D6. View 단축키 표 (F234)

### 원래 결정

`feat` `packages/plugin-api/view.js:139-164`: view가 페이지에서 읽은 단축키 표를 등록한다(`runtime.shortcuts.read`, `viewShortcuts`가 응답, `packages/workbench/view-calls.js:86-88`). owner가 `workbench`인 행은 막고 명령 경로로 넘긴다(`runtime.shortcuts.run`, `view.js:153-158`, `view-calls.js:205-212`). 등록 전 첫 키는 `runtime.shortcuts.missing`을 보내고(`view.js:143-147`), 이는 `page.view.shortcut-table-missing`으로 기록된다. bridge는 `shortcuts.register()`를 내보낸다(`view.js:160-164`, `:331`에서 반환).

### 결정 본문 (라운드 6, 축소)

감독자가 범위를 줄였다. Escape 통과는 `core.picker.close`에 대해 `runtime.shortcuts.run`을 쓰며, 별도의 `runtime.dismiss` 호출은 없다. 라운드 5의 반론은 아래에 답하고 여기에 반영했다.

1. **view는 스스로 어떤 키도 막지 않는다.** view가 소유한 키(텍스트 입력, 자기 Escape 동작)는 기본 동작을 유지하고 view의 first responder에 닿는다. workbench 행을 view가 처리하는 일은 없다. workbench 행은 다른 context를 가지기 때문이다(`packages/workbench/shortcuts.json:17-23`). view가 workbench로 넘기는 키는 Escape뿐이며, 수식키가 없고 기본 동작이 막히지 않았을 때만이다(4단계).
2. **표 등록, 그 API, 그 이벤트는 제거하고 통과 경로는 남기되 좁힌다.**
   - keydown 리스너와 `shortcutTable`(`view.js:139-159`), 표만 쓰는 도우미 `MODIFIERS`와 `isKey`(`view.js:21-32`), 표의 주석(`view.js:137-138`).
   - `shortcuts.register()`와 그 반환(`view.js:160-164`, `:331`).
   - 페이지 쪽: `viewShortcuts`(`view-calls.js:82-89`), `runtime.shortcuts.read`와 `.missing` 분기(`view-calls.js:199-203`), 그리고 `shortcuts` 옵션(`surface-modules.js:21`, `:287`, `view-calls.js:15`). 이 변경 뒤에는 어느 호출도 쓰지 않는다.
   - `runtime.shortcuts.run` 분기(`view-calls.js:205-212`)는 남기며 `{command}`를 받는다. 명령이 `core.picker.close`일 때만 `runCore`로 실행한다. 이것은 `packages/workbench/shortcuts.json:22`의 Escape 행 명령이다. 다른 명령은 `view call runtime.shortcuts.run: <command> is not the command of the Escape picker shortcut`으로 거부한다. 허용 목록은 이 한 이름이며, D6-b 테스트 (f)가 이를 확인한다.
   - 실패한 명령은 `page.input.shortcut.failed {plugin, command}`를 쓴다. 이 호출에는 `key` 필드가 없으므로 그 필드는 `native-surfaces.md`에 적는다(D6-a).
   - 이벤트 `page.view.shortcut-table-missing`(`docs/spec/events.json:690`)과 클래스 표의 그 행(`packages/sok/tauriv2/src/event_classes.rs:167`, `packages/sok/wailsv3/src/event_classes.go:125`, `packages/workbench/event-classes.js:112`), 재생성한다.
   AGENTS.md: 쓰이지 않는 코드 경로는 제거한다. 쓰이지 않는 표는 두지 않는다.
3. **명세, 용어, 표 문구.** 영문과 국문 모두:
   - `packages/plugin-api/terms.json:394`("shortcut table"): "The workbench table of shortcuts, each with its owner and command (`packages/workbench/shortcuts.json`)"로 바꾼다.
   - `main` `docs/spec/native-surfaces.md:137`(Input)과 `feat` `native-surfaces.md:141`: view는 표를 등록하지 않으며, Escape는 `runtime.shortcuts.run {command}`로 넘어간다(4단계). `page.input.shortcut.failed`의 이 호출에 대한 필드는 `{plugin, command}`다.
   - `main` `docs/spec/plugin-processes.md:94-103`(규칙 7, 같은 이벤트 필드)과 이벤트 행 `:141`; `:166`(계약 사례 목록 "RPC, snapshot, restart, shortcut table"): 단축키 표 사례를 제거한다.
   - `main` `docs/spec/exposure.md:67`(owner `view`): "a key that the view leaves to its default action, or the Escape of an open picker that the view passes to the workbench"로 고친다.
   - `main` `docs/spec/exposure.md:94-95`와 ko: 두 표 행을 `shortcuts.json` 24행과 25행의 문구로 고친다(표의 행이며 단락이 아니다). `feat` `docs/spec/exposure.md:71`: 표에 대한 단락을 삭제한다.
   - `feat` `docs/plans/plugin-processes.md:113-123`(규칙 7), `:162-163`(이벤트 행), `:190`(계약 사례 목록).
   - `main` `packages/workbench/shortcuts.json` 24행(owner `view`, `Escape`): `when` 문구는 "A plugin view has keyboard focus; the view's own Escape action runs when its handler prevents the default, otherwise the Escape command of the open picker runs"가 되고, `exposure.md:94`가 이를 따른다. 25행(텍스트 입력 키): "A plugin view has a text input focused; the view handles the key itself and it keeps its default action".
   - `scripts/test/shortcut-table.test.mjs`를 같은 변경에서 고친다.
   - `CHANGELOG.md:8`, `CHANGELOG.ko.md:8`, `docs/features.md:1239`와 ko: F234 표 등록이 제거되고 대체되었으며, 제거된 API를 적는다.
4. **Escape는 `runtime.shortcuts.run`으로 열린 페이지 picker를 닫는다.** view에 포커스가 있을 때 Escape는 페이지 picker의 리스너에 닿지 않는다(`packages/workbench/plane.js:745-746`, picker가 열린 동안에만 붙고 페이지에 포커스가 있을 때만 쓰인다). 그래서 view에 포커스가 있으면 열린 페이지 picker가 닫히지 않는다. 수정은 다음과 같다.
   - view bridge는 Escape를 `window`의 bubble 단계에서 처리한다. 호출 `runtime.shortcuts.run {command: "core.picker.close"}`은 키가 수식키 없는 Escape이고, `event.repeat`가 false이고, `event.isComposing`이 false이고, `event.keyCode`가 229가 아닐 때만 보낸다(입력기 키). 검사는 이벤트 전파가 끝난 뒤 `setTimeout(0)` 안에서, 그 시점의 `event.defaultPrevented`를 읽어 수행한다. bridge는 이 호출을 Escape에 대해서만 보낸다.
   - bridge는 view 자신의 Escape 규칙을 강제하지 않는다. 자기 Escape 동작(예: 팝오버)이 `preventDefault`를 부르지 않는 view도 열린 페이지 picker를 함께 닫는다. bridge는 `event.defaultPrevented`만 읽기 때문이다. 한 layer만 닫히는 결과는 `native-surfaces.md`에 적힌 계약을 따르는 view에서만 성립한다. 자기 Escape를 처리하는 view는 `preventDefault`를 부른다.
   - `core.picker.close`는 이미 선언되어 있고(`packages/workbench/core-exposure.js:553`, `packages/workbench/exposure.json:3586`) 행 `shortcuts.json:22`의 명령이다. `closePicker`는 열린 picker가 없으면 돌아가므로(`packages/workbench/plane.js:756-757`) 명령은 멱등이다.
   - 새 권한은 생기지 않는다. view plugin의 `runtime.command(name, params)`는 어떤 이름이든 `calls.request(name, params)`를 부른다. editor, shell, flowmark view의 plugin context가 그렇다(`plugins/editor/ui/view.js:128`, `plugins/shell/ui/view.js:104`, `plugins/flowmark/ui/view.js:78`). call layer는 모든 `core.` 이름을 `runCore`로 실행한다(`view-calls.js:244`, `feat`). 따라서 Escape 통과로 plugin이 못 하던 명령은 생기지 않는다.
   - 페이지는 picker 슬롯을 하나만 가지므로(`plane.js:734`) Escape 한 번은 페이지 picker를 최대 하나만 닫는다. view 자신의 layer를 함께 닫는 것은 막지 못한다(앞 항목).
   - 네이티브 picker나 modal WebView가 포커스를 가지면 keydown을 직접 받으므로, view는 이를 보지 못한다. 네이티브 modal은 `core.modal.dismiss`(`packages/workbench/picker-layer.js:103-105`)로 Escape에 답하며, 이는 바뀌지 않는다. view에 포커스가 있을 때 열린 네이티브 picker는 같은 Escape로 닫히며, 그 기대 결과는 D6-c에 있다.
   Red 테스트는 D6-b에 있다. probe(D6-c)는 overlay마다 기대를 확인하며, 수정을 배포할지는 정하지 않는다.
5. **view 포커스에서 cmd+k와 shift+cmd+n.** `cmd+k`(`core.focus.set`, `packages/workbench/shortcuts.json:18`)와 브라우저 빌드의 `shift+cmd+n`(`:17`)은 페이지 keydown에서만 처리되므로, view 포커스에서는 페이지에 닿지 않는다. 좁히기는 지금 배포한다(D6-d). `shortcuts.json:17-18`과 `exposure.md:87-88`(및 ko)의 `when` 문구는 `cmd+k`에 대해 "The library is shown and the page has keyboard focus", `shift+cmd+n`에 대해 "No host chrome (browser build) and the page has keyboard focus"가 된다. 단축키 표 테스트는 `when` 문구를 비교하므로 두 파일은 같은 커밋에서 바꾼다.

### 근거와 증거

- `viewShortcuts`는 owner `workbench` 행을 결코 돌려주지 않으므로, `runtime.shortcuts.run`은 모든 키를 거부한다(`view-calls.js:205-212`). 키를 넘기지 않는 view에는 표 등록이 필요 없다. 통과 경로는 Escape를 위해 남긴다.
- 표는 view가 쓰는 것을 주지 않는다. `native menu`와 `view` 행은 기본 동작을 유지하고, view는 어차피 막지 않는다.
- 새 `core.layer.dismiss`나 `runtime.dismiss` 호출은 `core.picker.close`와 `core.modal.dismiss`를 중복한다. 기존 `core.picker.close`를 기존 호출로 쓴다.
- F212.6a의 rule-7 gate(`plugin-processes.md` feat `:267`)는 표와 함께 제거된다. 그 Escape 측정은 F212.6a에 연결된 D6-c에 남긴다.
- 형제 plugin checkout(`../plugins/browser`, `editor`, `files`, `hwp`, `terminal`, `scripts/workspace-registry.json`에서)에서 `shortcuts.register`, `runtime.shortcuts`, `shortcut-table-missing`을 `git grep`으로 찾았고 일치하는 항목이 없었다. 따라서 선언된 plugin 중 제거되는 등록을 부르는 것은 없다.
- `exposure.md:53`은 사용자 동작이 선언된 명령을 실행하도록 요구한다. `core.picker.close`는 선언되어 있으며 통과 경로가 실행하는 명령이다.

### 필요한 변경

| ID | 소유자 | 변경 |
|---|---|---|
| D6-a | `feat`: `packages/plugin-api/view.js:21-32,137-164,331`, `packages/plugin-api/terms.json:394`, `packages/workbench/view-calls.js:13-16`(헤더 주석), `:82-89`, `:199-203`, `:205-212`(`{command}` 허용 목록), `packages/workbench/surface-modules.js:21,287`(변경 뒤 `shortcuts` 옵션은 쓰이지 않으므로 제거), `docs/spec/events.json:690`, `page.view.shortcut-table-missing`의 클래스 표 행, `native-surfaces.md:141`, `exposure.md:71`, `docs/plans/plugin-processes.md:113-123,162-163,190`, `CHANGELOG.md:8`, `docs/features.md:1239`와 ko; `main`: `docs/spec/native-surfaces.md:137`(Escape 호출의 `page.input.shortcut.failed` 필드), `plugin-processes.md:94-103,141,166`(같은 필드), `exposure.md:67,94-95`(표 행)과 ko, `packages/workbench/shortcuts.json:24-25`, `scripts/test/shortcut-table.test.mjs` | 표 등록, read와 missing 분기, 표 전용 도우미, `shortcuts` 옵션, `page.view.shortcut-table-missing` 이벤트와 3단계의 명세·용어 문구를 제거한다. |
| D6-b | `feat`: `packages/plugin-api/test/view.test.mjs:394-419`, `packages/workbench/test/view-calls.test.mjs:13,278-310`, `fakes()`의 `shortcuts` 옵션 | 표 테스트를 삭제한다. 추가(새 동작은 현재 코드에서 Red): (a) Escape가 아닌 키의 keydown은 `runtime.shortcuts.*` 호출을 보내지 않는다; (b) 페이지 picker가 열려 있으면 view Escape 한 번에 한 번 닫힌다; (c) view 자신의 요소에서 `preventDefault`를 부르는 핸들러는 아무것도 보내지 않으며, bridge의 것 뒤에 등록된 `window` bubble 리스너가 `preventDefault`를 불러도 페이지 picker는 열린 채 남는다(읽기는 전파 뒤에 일어난다); (d) picker가 없으면 `runtime.shortcuts.run {command: "core.picker.close"}`는 no-op; (e) `event.repeat`, `event.isComposing`, `keyCode` 229, 그리고 수식키가 있는 Escape는 아무것도 보내지 않는다; (f) `runtime.shortcuts.run`은 `core.picker.close`를 받고 `core.focus.set`을 2단계의 문구와 함께 거부한다; (g) 자기 Escape 핸들러가 `preventDefault`를 부르지 않는 view는 열린 페이지 picker를 닫는다(4단계가 받아들인 결과); (h) 실패한 `runtime.shortcuts.run`은 `key` 필드 없이 `page.input.shortcut.failed {plugin, command}`를 쓴다. |
| D6-c | `feat`(probe) | overlay마다 view 포커스에서 macOS probe: 페이지 picker(4단계의 기대), view 포커스 중 열린 네이티브 picker(같은 명령으로 닫히는 것이 기대), 포커스를 가진 네이티브 modal(view는 keydown을 받지 않으므로 호출이 없다; 단위 테스트가 아니라 end-to-end 확인). 또한 view 포커스에서 cmd+k와 shift+cmd+n, 그리고 view에서 입력기 조합을 끝내거나 취소하는 Escape(기대: 호출 없음). F212.6a에 연결. |
| D6-d | `main`: `packages/workbench/shortcuts.json:17-18`, `docs/spec/exposure.md:87-88`과 ko | 5단계의 `when` 문구를 지금 좁힌다. 한 커밋. |
| D6-e | `main`(`docs/features.md`, F238-b 기록) | 근거의 형제 검사를 다섯 checkout이 아니라 모든 `plugins/*` checkout에 대해 `git grep`으로 기록한다(`shortcuts.register`, `runtime.shortcuts`, `shortcut-table-missing`). 제거된 등록을 설명하는 열린 행 두 개는 F238-b D6에 의해 대체되었다고 닫는다(ko 포함): `plugins/shell/docs/features.md`의 P11.6(34행), `plugins/flowmark/docs/features.md`의 P8.6(27행). 호환성 깨짐 changelog 줄을 적는다. |
| D6-f | `main`: `docs/features.md`의 F212.6a와 F212.7 항목(+ko) | F212.6a(표 gate 제거, Escape 측정은 D6-c에 남김)와 F212.7(표 gate 없음)을 다시 범위 정한다. |
| D6-g | 순서: `main` 먼저, 그다음 `feat`. `main`: `docs/spec/native-surfaces.md`(view 호출 목록의 `runtime.shortcuts.run {command}`와 허용 목록). `feat`: `packages/plugin-api/view.js`(4단계의 가드를 가진 window bubble Escape, 전파 뒤 `setTimeout(0)`에서 `defaultPrevented`를 읽고 `runtime.shortcuts.run {command: "core.picker.close"}` 전송), `packages/workbench/view-calls.js`(한 이름 허용 목록을 가진 `runtime.shortcuts.run` 분기) | 4단계의 Escape 통과를 구현한다. `feat` 변경은 `core.picker.close`가 `main`에 있은 뒤에 들어간다(이미 있다). D6-b (d)와 (f)가 레지스트리 명령과 거부를 확인한다. |

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
| E2: 낡은 위치(용어, plugin-processes 줄, feat 계획 줄) | 수용; 3단계, D6-a. |
| E3: 국문 사본 불완전 | 수용; D6-a가 모든 ko 사본을 나열. |
| E4: `feat` `exposure.md:71`에 대체 문장이 없음 | 수용; 단락 삭제(3단계). |
| E5: `exposure.md:67`의 "handles inside itself"가 남음 | 수용; 3단계. |
| F1: Escape 대체가 내부적으로 모순 | 수용; 라운드 4와 5가 대체를 유지하고 완성한다. |
| F2: `runtime.dismiss`는 선언된 명령이 아님 | 수용; 라운드 5의 4단계가 선언된 `core.picker.close`를 실행한다. |
| F3: 이중 닫힘과 Escape 가로채기 | 수용; 4단계, D6-b (b)와 (c). |
| F4: rule-7 F212.6a gate가 대체 없이 빠짐 | 수용; D6-f. |
| F5: 공개 API 제거의 안전성이 보이지 않음 | 수용; 형제 checkout을 검색했고 일치 없음(근거). D6-e. |
| F6: cmd+k와 shift+cmd+n 좁히기가 probe를 기다림 | 수용; 5단계가 지금 좁힌다(D6-d). |
| F7: view 자신의 키는 view 안에서 처리되어야 함 | 수용; 1단계. |

#### 라운드 3 (응답)

| 반론 | 응답 |
|---|---|
| D6-1: D6-d가 테스트가 보는 `shortcuts.json:17-18`을 빠뜨림 | 수용; 5단계와 D6-d가 포함한다. |
| D6-2: `shortcuts.json` 24-25행의 소유가 없음 | 수용; D6-a가 소유한다. |
| D6-3: Escape 대체에 필요한 변경 행이 없음 | 수용; D6-g. |
| D6-B1: `runtime.dismiss`가 선언된 명령이 아닌 날 호출임 | 수용; 4단계가 선언된 명령을 실행한다. |
| D6-B2: 대체가 view 자신의 Escape UI에서도 발동함 | 수용; 4단계(`defaultPrevented`); D6-b (b). |
| D6-B3: 형제 plugin 검사가 완전하지 않음 | 수용; 검사하고 기록했다(근거; D6-e). |

#### 라운드 4 (응답)

| 반론 | 응답 |
|---|---|
| A-1: `core.layer.dismiss`가 `core.picker.close`와 `core.modal.dismiss`를 중복하고, "topmost"에는 근거가 없음 | 수용, 확인함: 둘 다 선언되어 있고(`core-exposure.js:553,555`), `closePicker`는 멱등이다(`plane.js:756-757`); picker 슬롯은 하나다(`plane.js:734`). 새 명령을 버리고 `core.picker.close`를 쓴다(4단계). |
| A-2: 두 브랜치 사이의 의존이 적혀 있지 않음 | 수용. D6-g가 순서를 적는다: `main` 먼저, 그다음 `feat`; D6-b (f)가 레지스트리 명령을 확인한다. |
| B-1: `defaultPrevented` 확인이 동기식이며 리스너 순서가 결과를 정함 | 수용. 4단계는 전파가 끝난 뒤 `setTimeout(0)`에서 `defaultPrevented`를 읽는다. |
| B-2: `runtime.dismiss`를 plugin이 호출할 수 있음 | 일부 수용. 4단계가 내부 호출로 적고 이름을 적는다. 효과는 열린 picker를 닫는 것뿐이며, 데이터를 다루지 않는 선언된 명령이다. plugin이 닿을 수 있다는 점을 숨기지 않고 적는다. |
| B-3: 네이티브와 페이지 layer를 함께 쌓는 "topmost" | 수용. 4단계: picker 슬롯 하나, 스택 없음. 네이티브 modal은 `core.modal.dismiss`로 답한다. |
| B-4: 키 자동 반복이 layer를 연쇄로 닫음 | 수용. 4단계와 D6-b (e)가 `event.repeat`를 무시한다. |

#### 라운드 5 (응답)

D6 본문에 대한 두 감사자(둘 다 새 감사자; 각 반론은 파일에서 확인했다).

| 반론 | 응답 |
|---|---|
| A1: 통과가 `core.focus.set`을 포함해 모든 workbench 행을 받으며, 5단계가 좁히는 행도 받는다 | 수용. 허용 목록은 `core.picker.close` 한 이름이다(2단계); 테스트 (f)가 수락과 거부를 확인한다. |
| A2: Escape 실패 이벤트가 `key` 필드를 잃으며 명세가 이를 다루지 않는다 | 수용. 필드는 `{plugin, command}`이며, `native-surfaces.md:137`과 `plugin-processes.md` 규칙 7을 D6-a에 넣었다. |
| A3: "caller 없음" 검색이 `plugins/shell`과 `plugins/flowmark`를 빠뜨렸다. 두 곳에 표를 가정한 열린 행이 있다 | 수용. 검색은 모든 `plugins/*` checkout을 포함하며, `shell` P11.6과 `flowmark` P8.6을 대체되었다고 닫는다(D6-e). |
| B-1: 한 layer 보장이 과장되었고 bridge는 아무것도 강제하지 않는다 | 수용. 4단계는 bridge가 규칙을 강제하지 않으며 결과는 계약을 따르는 view에서만 성립한다고 적는다; 테스트 (g)가 받아들인 결과를 확인한다. |
| B-2: `setTimeout(0)` 순서가 테스트되지 않았다 | 수용. 테스트 (c): bridge의 것 뒤에 등록된 `window` 리스너가 `preventDefault`를 부르면 호출이 없다. |
| B-3: 입력기 조합 가드가 없다 | 수용. 4단계가 가드(`isComposing`, keyCode 229)를 추가한다; 테스트 (e); D6-c probe. |
| B-4: 제거 목록이 `view.js:21-32`(`MODIFIERS`, `isKey`)와 `view-calls.js:82-89`를 빠뜨렸고, `{command}` 조회는 명시가 필요하다 | 수용. D6-a가 범위를 적고, 2단계가 한 이름 허용 목록을 준다. |
| B-5: `surface-modules.js` 제거가 조건부이며 그 조건은 성립하지 않는다 | 수용. 옵션을 무조건 제거한다(D6-a). |
| B-6: `exposure.md:94-95`는 단락이 아니라 표 행이다 | 수용. 3단계와 D6-a가 두 행을 고친다. `:71`의 `feat` 단락은 삭제한다. |
| B-7: Red 목록 누락: Escape가 아닌 키, 실패한 명령 이벤트, 팝오버 이중 닫힘, `setTimeout` 순서, 입력기, 수식키; 네이티브 modal 경우는 단위 테스트가 아니다 | 수용. D6-b 테스트 (a)부터 (h); 네이티브 modal 경우는 D6-c probe로 옮긴다. |
| 비차단: view 포커스에서 열린 네이티브 picker; `runtime.command` 문구 | 수용. 4단계가 기대 결과를 적고(D6-c), 문구는 "어떤 이름이든 `calls.request(name, params)`를 부른다"로 읽힌다. |

## 하위 항목

- D5 하위 항목 S1부터 S3(위 "D5의 하위 항목"): 닫을 때 `docs/features.md`에 F212 아래 소유 브랜치 `feat/view-bridge-F231`로 등록한다.
- D6 행 D6-a부터 D6-g: 닫을 때 F212 아래 F238-b-1부터 F238-b-7까지, 행마다 하나씩 등록한다.

## 다른 곳에 기록할 내용

각 행은 소유자를 적는다. `main`이 소유한 행은 `main`에서 바꿀 내용이고, `feat/view-bridge-F231`이 소유한 행은 그 브랜치에서 바꿀 내용이다.
