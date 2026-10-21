# 결정 검토 F238-b: view 로그 level과 view 단축키 표

[English](decision-review-F238-b.md)

이 기록은 브랜치 `feat/view-bridge-F231`에서 적대적 검토 없이 내린 두 결정을 검토한다.

- D5(F233): view bridge가 첫 사용 시 요청으로 저장된 로그 level을 알아낸다.
- D6(F234): view가 단축키 표를 등록하고 workbench 키를 명령 경로로 넘긴다.

각 결정은 본문, 근거, file과 line이 있는 증거, 필요한 변경을 적는다. 감사자는 새 subagent(Haiku)이며, 각자 실질 반론과 구체적 해결안을 낸다. 문구와 인용 정정은 직접 반영한다. 각 라운드는 아래에 기록한다. 한 라운드의 두 감사자가 모두 실질 반론이 없을 때까지 반복한다.

인용: `feat`는 `feat/view-bridge-F231`, `main`은 이 저장소의 `main`이다.

## 범위

- D5: 어떤 class가 view 기록을 게이트하는지, 거부된 기록을 누가 세는지, 종료된 view가 무엇을 잃는지. 라운드 7은 선언되지 않은 plugin 기록의 속도(S1), 대기 중인 거부의 flush(S2), 종료된 view의 기록(S3)을 각 근거와 함께 정한다.
- D6: view가 키에 대해 workbench 명령을 실행하는지, 어떻게 실행하는지, view가 보낸 키에 호스트가 무엇을 하는지.

범위 밖: 문구, 새 필드의 정확한 이름(하위 항목에서 정한다), 해당 모듈의 단위 테스트가 정하는 동작.

## D5. View 로그 level (F233)

### 원래 결정

`feat` `packages/plugin-api/view.js:116-135`: bridge가 첫 기록에서 `runtime.log.levels`를 호출하고(`storedLevel`, 127행), `levels === null`인 동안 모든 기록을 보내며(135행), 거부된 읽기는 오류 줄로 보고한다(`recordError`, 116행). 페이지는 plugin 기록의 level로 응답한다(`packages/workbench/view-calls.js:184-187`). 변경은 `log.levels` 이벤트로 온다(`view.js:130-131`; `packages/workbench/surface-modules.js:261-264`, `:308`; `packages/workbench/view-events.js`).

### 결정 본문 (라운드 7)

감독자가 라운드 6의 열린 쟁점을 정했다. view에는 게이트가 없다. 기록기만 게이트이자 세는 주체다. view로 가는 시작 값, 정책과 class 맵의 게시, view 쪽 계수와 플러시 규칙을 모두 제거한다. 1~7단계가 인용하는 `packages/plugin-api/view.js`, `packages/workbench/view-calls.js`, `view-events.js`, `surface-modules.js`, `plugin-runtime.js`와 그 시험은 `feat/view-bridge-F231`에 있다(라운드 7에 `git show`로 확인); 이 기록의 워크트리에는 없다.

1. **view에는 게이트도 정책 사본도 없다.** view 브리지는 정책도 class 맵도 보관하지 않는다. 호스트는 로깅용으로 view에 아무것도 주입하지 않는다(`ViewStart`, `packages/host/tauriv2/src/surfaces.rs:61`, `packages/host/wailsv3/src/surfaces.go:66`은 그대로). view에 `log-policy`나 `log-classes`를 게시하지 않으며, view의 `runtime.log`는 다섯 level 메서드만 가진다. view는 각 기록의 필드를 만들어 페이지 배치로 보낸다. 페이지가 자기 기록에 쓰는 방식과 같다([logging](../spec/logging.ko.md#writer), 108행).
   - 기각한 대안: 기록 전에 거르고 view 쪽에서 세는 view 게이트(라운드 1~6 설계). 이 설계는 동기화 경로 셋(시작 값, 게시, ready 시점)과 view 계수 및 그 플러시 규칙(S2), 종료 시 잃는 계수(S3)가 필요하다. 얻는 것은 거른 기록이 필드를 만들지 않는다는 점뿐인데, 이는 [logging](../spec/logging.ko.md#원칙)의 원칙 2다. 선택한 설계는 view에 대해 이 이득을 포기한다. 메인 페이지는 이미 같은 방식이다. 페이지 게이트는 plugin 기록을 class로 저장하지 않고(`packages/workbench/event-classes.js:137-143`, `packages/workbench/log-gate.js:28`), 기록기가 결정한다. 명시된 비용: 거른 view 기록도 필드를 만들고 배치에 넣는다. 8단계의 배치 한계(256개, Bounds의 행 `page batch`, 또는 100 ms 타이머, [logging](../spec/logging.ko.md#writer), 108행)가 호스트 호출 수를 묶는다.
2. **기록기는 plugin 기록을 모두 class로 게이트하며, 미선언 기록도 포함한다.** 기록기는 `plugin` 층의 모든 이벤트에 `enabled(class, level)`을 적용하고, class는 해당 plugin 카탈로그의 것이다. 어떤 카탈로그도 선언하지 않은 이름의 이벤트는 plugin 층 기본 class `lifecycle`을 받는다. 기록기는 `class: "lifecycle"`과 `undeclared: true`로 쓰고, `lifecycle` 이벤트로 게이트한다. 기본값은 모든 plugin에 같은 고정 class 하나다. `plugin.json`에 필드를 더하지 않으며 plugin별 기본값도 없다.
   - `lifecycle`을 고른 이유: class 표에서 plugin 자신의 수명 변화의 class이며([logging](../spec/logging.ko.md#class와-정책)), 빈도가 낮은 유일한 class이고, 어떤 카탈로그도 선언하지 않은 이름은 명명 오류이므로 가장 낮은 빈도 class에 남아야 한다. `lifecycle`을 off로 두면 미선언 plugin 기록이 막히고, 나머지 네 class는 영향이 없다.
3. **미선언 plugin 기록에 따로 상한을 두지 않는다(S1은 닫힌다).** Principle 5([logging](../spec/logging.ko.md#원칙), 13행)는 미선언 이벤트를 마커와 함께 쓰고 세는 것을 요구하며, error level을 요구하지 않는다. 개발 단계에서 이름을 거른다. 이벤트 검사기는 모든 emit 지점을 카탈로그와 비교하고 선언되지 않은 이름을 쓰는 emit 지점을 보고한다(`packages/plugin-api/events-check.js`, 9~10행과 418~419행). 실행 시에는 class 게이트가 유일한 상한이다. 거른 미선언 기록은 4단계의 class 계수(`lifecycle`, 그 level)에 들어가며, 그 계수에는 이름을 남기지 않는다.
4. **기록기가 센다. 기록과 시점.** 기록기는 게이트가 거른 plugin 기록을 class와 level별로 세고, 기존 보고 시점에 `log.gated {class, level, count}`를 쓴다. 앞 보고 뒤 1초가 지났을 때, 플러시 때, 멈출 때다([logging](../spec/logging.ko.md#정책), 77행). 이 기록은 모든 게이트를 통과한다. view는 자기 계수를 갖지 않으므로 view가 거른 것의 플러시(S2)는 존재하지 않는다. view의 보내지 않은 배치는 거른 것이 아니며 5단계가 다룬다.
5. **종료된 view의 보내지 않은 배치(S3은 명시된 손실로 줄어든다).** 기록기는 받지 않은 기록을 셀 수 없다. 따라서 종료된 view의 보내지 않은 배치는 계수가 없는 유일한 손실이다. 상한은 1단계의 배치 규칙(100 ms 또는 256개)이다. 호스트가 이를 명시한다. view의 종료는 이벤트 `host.view.killed`(계층 `host`, lifecycle, `warn`, 필드 `plugin`, `surface`, `unsent: true`, `log.closed`처럼 모든 게이트 통과, [logging](../spec/logging.ko.md#정책), 78행)로 쓴다. 본문은 view의 보내지 않은 기록이 사라질 수 있다고 말하므로, 손실은 명시되고 계수는 주장하지 않는다.
6. **제거.** 첫 사용 요청(`packages/plugin-api/view.js:125-135`), `runtime.log.levels`(`packages/workbench/view-calls.js:184-187`, 주석 `:28,33`), 이벤트 `log.levels`와 그 구독(`packages/workbench/view-events.js`, 주석 `:14,19,22`), `subscribe.logLevels`와 `packages/workbench/surface-modules.js:260-264,308`, view의 `log.enabled`(`view.js:196`)과 plugin 런타임의 `log.enabled`(`packages/plugin-api/plugin-runtime.js:59-63,75`), `fields`의 함수 형태는 남는다(`fieldsOf`, `plugin-runtime.js:69`): 빌더는 호출 시점에 실행되고, `plugins/terminal/ui/terminal.js`의 함수 형태 호출 여덟 곳(303, 335, 340, 344, 351, 365, 649, 925행)은 바뀌지 않는다. 공개 API의 `log.enabled(level)` 서술(`docs/spec/plugins.md:241`, `plugins.ko.md:242`)도 제거한다. 확인된 사용처는 `plugins/terminal/ui/terminal.js:1214`(`runtime.log.enabled("debug")`)와 그 P32.1의 frame gate(`CHANGELOG.md:40`)이며, 그 소유자가 바꾼다(D5-e).
7. **`recordError`는 보고한다.** `recordError`(`view.js:116-121`)는 기록이 실패하면 브리지의 `report({where, text, error})`를 호출하여 실패가 조용히 사라지지 않게 한다(D5-d). 이 문장은 라운드 6에서 바뀌지 않았다.
8. **명세.** 이 결정의 view 규칙은 코드 변경 전에 [logging](../spec/logging.ko.md)에 쓴다(AGENTS.md: 명세가 먼저). 40행(`undeclared`: 기록은 class `lifecycle`과 마커를 가진다), 71행과 74행(view에는 게이트가 없으므로 기본 창이 적용되지 않는다), 76행(게이트는 묻고, view와 메인 페이지의 plugin 기록은 필드를 만들고 기록기가 결정한다), 77행(계수는 기록기만 쓴다), 291행(미선언 plugin 이벤트의 class)을 바꾸고 한국어 판도 같이 바꾼다. 원칙 2는 1단계의 예외를 적고, 배치 행이 Bounds에 더해진다. 원칙 3은 `host.view.killed`를 손실 기록 목록에 더한다. 그리고 통과 기록 목록(`logging.md` 78행; `passes_every_gate`와 `PassesEveryGate`)에 더한다. 원칙 5는 3단계의 규칙을 적는다. 3단계의 규칙은 `plugin` 계층에만 적용된다. `host`나 `page` 계층의 미선언 이벤트는 [logging](../spec/logging.ko.md#class와-정책)의 규칙(class 없음, 게이트 없음)을 따르며, 이 결정은 바꾸지 않는다. [native-surfaces](../spec/native-surfaces.ko.md#view-표면), 111행은 기록기를 게이트로 서술하도록 다시 쓴다.
9. **대체.** 이 결정은 라운드 6 본문의 1~4단계와 6단계를 대체한다. 그 단계들(시작 값, `log-policy`와 `log-classes` 게시, `runtime.log.gated`, view 계수, D5-a의 view 부분)은 구현하지 않는다.

### 근거와 증거

- 라운드 6 설계는 view마다 계수를 두었고, 플러시 규칙과 종료 손실(S2, S3)이 따랐다. 기록기는 이미 보고 규칙과 함께 자기 계수를 갖는다([logging](../spec/logging.ko.md#정책), 77행). 그러므로 계수를 아는 곳이 하나인 기록기로 옮기면 view 계수와 view 플러시 규칙이 필요 없다.
- 기록기는 이미 plugin 카탈로그의 class를 가지고 plugin 이벤트를 게이트한다([logging](../spec/logging.ko.md#plugin-catalog), 291행). 따라서 view 기록은 정책 사본이 필요 없다. class는 기록기가 안다.
- view의 게이트는 원칙 2를 위한 최적화였다. 메인 페이지는 오늘 plugin 기록을 class로 게이트하지 않는다(라운드 4 B-1, 검증됨). 그래서 view와 페이지가 같은 규칙을 쓰고, 거른 기록의 비용은 1단계에 명시된 것이다.
- `log.enabled`는 view가 class 맵을 갖지 않으면 이벤트별로 답할 수 없다. 이 설계에서 view는 맵이 없다. 정책의 사본을 두 번째로 두는 것보다 제거가 단순하며, 터미널 호출이 유일한 사용처다(D5-e).
- 미선언 이벤트는 명명 오류다. 이벤트 검사기가 개발 단계에서 거른다(`events-check.js`, 418~419행). 실행 시 명명 오류의 기록은 마커다([logging](../spec/logging.ko.md#원칙), 40행). 기록기가 거르면 계수한다.

### 필요한 변경

| ID | 소유자 | 변경 |
|---|---|---|
| D5-a | `main`: `docs/spec/logging.md`(원칙 2와 5; 40, 71, 74, 76, 77, 291행과 그 ko), `docs/spec/native-surfaces.md:111`과 ko, `docs/spec/events.json`(`host.view.killed`: lifecycle, warn, 필드 `plugin`, `surface`, `unsent`; 모든 게이트 통과; class 표를 다시 만든다: `packages/sok/tauriv2/src/event_classes.rs`, `packages/sok/wailsv3/src/event_classes.go`, `packages/workbench/event-classes.js`) | 1~5단계의 규칙을 코드 변경 전에 명세에 쓴다. Bounds 표에 행 `page batch`(256개 또는 100 ms)를 더한다; 원칙 3은 `host.view.killed`를 더한다; 원칙 5는 3단계를 적는다. |
| D5-b | `main`: `packages/sok/tauriv2/src/event_log.rs`, `packages/sok/wailsv3/src/event_log.go`(미선언 `plugin` 이벤트의 기록기 게이트: class `lifecycle`과 마커), `scripts/audit-run.mjs:155-156`(미선언 줄을 마커로 센다), `packages/log-contract`(class `lifecycle`을 가진 미선언 줄은 유효); `packages/sok/tauriv2/src/event_log.rs`와 `packages/sok/wailsv3/src/event_log.go`(`passes_every_gate`와 `PassesEveryGate`; 예외 목록에 `host.view.killed`를 더한다); `packages/sok/wailsv3/src/log_policy.go`(같은 Go 예외의 게이트) | 기록기는 모든 `plugin` 이벤트를 class로 게이트하고, 미선언 이벤트는 `lifecycle`로 한다. 거른 것은 `log.gated`에 센다. 회귀 시험: `lifecycle`이 off일 때 미선언 plugin 기록은 거르고 센다. 메인 페이지의 plugin 기록이 class 수준 아래이면 기록기가 거른다. |
| D5-c | `feat`: `packages/plugin-api/view.js`(`log.enabled`과 levels 요청 제거; `recordError`는 `report`를 호출, D5-d), `packages/plugin-api/plugin-runtime.js:59-75`(`enabled` 제거; `fields`의 함수 형태는 남는다), `packages/workbench/view-calls.js`(주석 `:28,33`; `runtime.log.levels` `:184-187`), `packages/workbench/view-events.js`(`log.levels`와 주석 `:14,19,22`), `packages/workbench/surface-modules.js:260-264,308`, `docs/spec/plugins.md:241`과 `plugins.ko.md:242`; 시험 `packages/plugin-api/test/view.test.mjs:370-384`, `packages/workbench/test/view-calls.test.mjs:61,210-214`, `packages/workbench/test/view-events.test.mjs:48-52`, `packages/plugin-api/test/surface.test.mjs:142,172,195-198,214`, `packages/workbench/test/plugin-states.test.mjs:40`, `packages/workbench/test/plugin-records.test.mjs:25` | view에는 게이트도, levels 요청도, `log.enabled`도, `runtime.log.gated`도 없다. 시험은 코드와 함께 옮기거나 지운다. |
| D5-d | `feat`: `packages/plugin-api/view.js:116-121`과 시험 | 실패한 기록에서 `recordError`가 `report({where, text, error})`를 호출한다. 거른 `runtime.error`가 보고되는지 시험한다. |
| D5-e | `plugins/terminal`: `ui/terminal.js:1214`(`runtime.log.enabled("debug")` 가드), 그리고 모든 `plugins/*` 체크아웃에서 `log.enabled`와 `fields`로 넘기는 함수를 6단계처럼 다시 검색; P32.1의 frame gate(`CHANGELOG.md:40`, `runtime.log.enabled`)는 화면 메시지마다 hash를 계산하게 된다. 소유자가 그 비용을 두거나 자기 조건 뒤로 옮긴다; `plugins/flowmark/docs/features.md:26`의 열린 P8.4는 이 결정으로 대체되었다고 닫는다 | plugin은 가드 없이 디버그 필드를 만들거나, 기록이 싸면 호출 지점을 그대로 둔다. 소유자 `plugins/terminal`(라운드 6 소유자 목록에 없었으며 여기서 등록). |
| D5-f | `main`: `packages/host/tauriv2/src/surfaces.rs`, `packages/host/wailsv3/src/surfaces.go`(view 종료 경로가 `host.view.killed`를 쓴다) | 5단계의 종료 기록과 그 본문. |
| D5-g | `main`: `packages/workbench/log-batch.js`(페이지 배치의 크기 상한 256개; 오늘은 없다) | 페이지 배치는 256개 또는 100 ms 타이머에서 비우며, Bounds의 행 `page batch`가 이를 적는다. |

### D5의 하위 항목 (닫을 때 등록)

- S1은 3단계로 닫힌다(따로 상한 없음; class 게이트가 상한).
- S2는 4단계로 닫힌다(view 계수가 없으므로 view 플러시도 없다).
- S3은 5단계와 행 D5-f로 줄어든다. 종료된 view의 보내지 않은 배치는 배치 규칙에 묶인 명시된 손실이며 계수는 없다.

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

#### 라운드 6 (응답)

D5 본문에 대해 두 감사자(둘 다 새 감사자, 읽기 전용, 결정 수준 반론만)가 검토했다.

| 반론 | 응답 |
|---|---|
| D5 A1: 선언되지 않은 plugin 이벤트가 모든 게이트를 통과하므로, 모든 클래스가 `off`인 plugin도 상한 없이 쓸 수 있다. 상한은 S1로 미뤄졌다 | 결정 수준 반론으로 수용. 미결: 라운드 7은 선언되지 않은 plugin 이벤트에 클래스를 주어 `off`가 성립하게 하거나, 상한을 결정 안에 적어야 한다. |
| D5 B1: 같은 지적을 정책의 목적 쪽에서 함(`logging.md` Gate 단락, `log-gate.js:28`) | 수용. A1과 같은 미결 항목. |
| D5 A2: 3단계는 기록 없이 수가 버려지지 않는다고 하지만, S2와 S3가 flush와 종료 시 손실을 열어 둔다 | 수용. 미결: 라운드 7은 writer 전용 수 기록(view에 대기 상태가 없어 S2와 S3가 사라짐)과 결정 안에 명시한 경계 중 하나를 골라야 한다. 거부된 기록의 IPC 비용이 그 선택의 일부다. |
| D5 A3: view 쪽 gate는 최적화이면서 동기화 경로가 셋(시작 값, 게시, ready 시점)이고, 결정은 이를 writer 전용 설계와 비교하지 않음 | 같은 미결 선택의 일부로 수용. 라운드 7은 두 설계의 비용을 적는다. |

#### 라운드 7 (응답)

새 감사자 넷(Haiku, 결정마다 둘; 읽기 전용). 각 반론은 파일에서 확인했다. D5가 인용하는 view bridge 경로는 `feat/view-bridge-F231`에 있으므로, 감사자가 워크트리에서 찾지 못한 것은 인용 문제이지 설계 문제가 아니다.

| 반론 | 응답 |
| --- | --- |
| D5 A: view 쪽 코드(`view.js`, `view-calls.js`, `view-events.js`, `surface-modules.js`)의 인용이 워크트리에 없다 | 인용 문제로 수용: 경로는 `feat/view-bridge-F231`에 있고 `git show`로 확인했다; 결정 본문 첫머리에 그렇게 적었다. 설계 변경은 없다. |
| D5 A: 3단계가 기본 `error` 정책에서 미선언 `info`와 `warn` 기록에 대해 원칙 5와 충돌한다 | 수용. 8단계가 원칙 5를 명시적으로 고친다: 기록은 그 계층의 class가 level을 저장할 때 쓰고, 거부되면 `log.gated`에 센다. |
| D5 A: 거른 view `frame` 기록이 frame 경로에서 IPC 비용을 낸다(원칙 2) | 상한과 함께 명시된 비용으로 수용: 8단계의 페이지 배치 상한(256개 또는 100 ms)이 호출 수를 묶으며, 원칙 2가 예외를 적는다. |
| D5 B: `fields`의 함수 형태를 제거하면 `plugins/terminal/ui/terminal.js`의 여덟 호출 지점이 깨진다 | 수용. 함수 형태는 남으며 `fieldsOf`가 호출 시점에 만든다(6단계). D5-e가 P32.1의 frame gate를 명시한다. |
| D5 A와 D5 B: 6단계의 제거 대상이 이 워크트리의 HEAD와 맞지 않는다 | 인용 문제로 수용(위 첫 행 참고); feat 경로가 D5의 소유자 경로다(원래 결정의 `feat`). |
| D5 B: `view.killed`가 계층 접두 규칙을 어기며, `log.dropped`는 순번 범위가 필요하다 | 수용: 이벤트는 `host.view.killed`(계층 `host`)이다. `log.dropped`는 쓰지 않는다: 그 필드는 순번 범위인데 보내지 않은 배치에는 순번이 없다. 원칙 3이 `host.view.killed`를 손실 기록 목록에 더한다. |
| D5 B: `plugin-states.test.mjs:40`, `plugin-records.test.mjs:25,195,197,198`, `surface.test.mjs:214`가 `runtime.log.enabled`를 부른다 | 수용; D5-c가 나열한다. |
| D5 B: 페이지 배치의 256개 상한이 `logging.md` Bounds에 없다 | 수용; D5-a가 행 `page batch`(256개 또는 100 ms)를 더한다. |
| D5 라운드 7 형제 검사: `plugins/terminal`(P32.1 frame gate), `plugins/flowmark` P8.4(열림) | D5-e에 기록; flowmark P8.4는 대체되었다고 닫는다. browser P18.4는 `enabled`를 역사로 언급하는 완료 행이며 바꿀 필요가 없다. |

#### 라운드 8 (응답)

새 감사자 넷(Haiku). 라운드 8의 반론은 아래와 같으며, 각 반론은 파일에서 확인했다.

| 반론 | 응답 |
| --- | --- |
| D5 A: D5-a와 D5-f가 아직 `view.killed`를 쓴다 | 수용: `host.view.killed`로 바꿨다. |
| D5 A: D5-b가 예외를 구현하는 파일을 빠뜨렸다 | 수용: `passes_every_gate`(`packages/sok/tauriv2/src/event_log.rs`), `PassesEveryGate`(`packages/sok/wailsv3/src/event_log.go`), `packages/sok/wailsv3/src/log_policy.go`를 D5-b에 더했다. |
| D5 A: 256개 상한이 `log-batch.js`에 구현되어 있지 않고, `logging.md` 108행에는 수치가 없다 | 수용: 1단계와 8단계는 새 Bounds 행을 인용하며, D5-g가 `packages/workbench/log-batch.js`를 소유한다. |
| D5 A: `host`와 `page`의 미선언 이벤트에 대한 규칙이 없다 | 수용: 8단계가 3단계를 `plugin` 계층으로 한정하며, 다른 계층은 `logging.md` 76행을 따른다. |
| D5 B: `plugin-records.test.mjs`의 195, 197, 198행은 `feat`에 없다 | 수용: 인용은 `:25`만이다(D5-c와 여기). |
| D5 B: `view-calls.js:86-88`은 로그 level 행이 아니라 `viewShortcuts`다 | D5 인용이 아니다; 로그 level 행은 `:184-187`과 `:28,33`이며 인용한 그대로다. |

## D6. View 단축키 표 (F234)

### 원래 결정

`feat` `packages/plugin-api/view.js:139-164`: view가 페이지에서 읽은 단축키 표를 등록한다(`runtime.shortcuts.read`, `viewShortcuts`가 응답, `packages/workbench/view-calls.js:86-88`). owner가 `workbench`인 행은 막고 명령 경로로 넘긴다(`runtime.shortcuts.run`, `view.js:153-158`, `view-calls.js:205-212`). 등록 전 첫 키는 `runtime.shortcuts.missing`을 보내고(`view.js:143-147`), 이는 `page.view.shortcut-table-missing`으로 기록된다. bridge는 `shortcuts.register()`를 내보낸다(`view.js:160-164`, `:331`에서 반환).

### 결정 본문 (라운드 7)

감독자가 라운드 6의 열린 쟁점을 정했다. view는 workbench 키를 자기 명령을 직접 실행하는 방식으로만 넘긴다. 호스트는 view의 키에 따라 어떤 동작도 하지 않는다.

1. **view는 어떤 키도 스스로 막지 않는다.** view가 소유한 키(텍스트 입력, 자신의 Escape 동작)는 기본 동작을 유지하고 view의 first responder에 도달한다. view는 자기 키를 소유하고, workbench는 `packages/workbench/shortcuts.json`에서 소유자가 `workbench`인 행을 소유한다.
2. **암묵적 통과는 없다.** 브리지는 단축키 표를 위한 keydown 리스너를 설치하지 않으며, keydown에서 어떤 호출도 보내지 않는다. 호스트는 view가 넘기지 않은 키 때문에 페이지 선택기를 닫거나 workbench 명령을 실행하지 않는다. 편집 가능한 대상(찾기 막대의 Escape, 입력기 조합)은 view가 처리하며, 넘기지 않으므로 workbench가 덮어쓰지 않는다.
3. **view는 명령을 실행하여 넘긴다.** view는 `runtime.shortcuts.read`로 workbench 행을 읽는다(유지, 읽기 전용: 소유자가 `workbench` 또는 `view`인 행을 돌려준다). view 자신의 처리기가 어떤 키를 workbench 키라고 판단하면 `runtime.command(row.command, {})`로 그 행의 명령을 실행한다. 규칙은 모든 행에 같은 하나다. 열린 페이지 선택기의 Escape(`core.picker.close`, `shortcuts.json:22`), cmd+k(`core.focus.set`, `:18`), 브라우저 빌드의 shift+cmd+n(`core.window.new`, `:17`), 그 밖의 모든 workbench 행이다. 키별 예외도, `when` 문구의 축소도 없다. 명령이 무엇을 할지는 명령이 정하며, 적용되지 않는 명령은 자기 오류로 거부하고 호출 계층이 그 오류를 보고한다. `runtime.command`는 view가 선언된 core 명령을 아무것이나 실행하게 하며, 표는 view에게 workbench가 소유한 키를 알려줄 뿐이다. 넘기는 결정은 모든 행에 대해 view의 것이다. 읽기는 실행 중인 빌드의 행을 돌려준다: `when`이 성립하지 않는 빌드 조건을 가진 행(네이티브 빌드의 브라우저 전용 shift+cmd+n 행)은 돌려주지 않는다. 이는 키 예외가 아니라 빌드 표의 속성이다.
   - Escape는 일반 키다. view가 결정하며, 넘길 때 `core.picker.close`(`shortcuts.json:22` 행)를 실행한다. 자기 Escape 동작(팝오버, 찾기 막대)이 있는 view는 자기 처리기에서 결정하며, 계약은 D6-g가 [native-surfaces](../spec/native-surfaces.ko.md#view-표면)에 적는다.
   - 소유자 `native menu`의 행(`shortcuts.json:3-16`)은 view가 읽는 표(5단계)에 없으므로 view가 넘기지 않는다. 웹 view가 그 키를 받는지는 D6-c에서 관찰하며, 규칙을 바꾸지 않는다.
4. **검증: `runtime.command`가 이미 표의 명령에 닿으므로 `runtime.shortcuts.run`은 제거한다.** 호출 계층은 `core.`로 시작하는 모든 이름을 `runCore`로 실행한다(`packages/workbench/view-calls.js:244`, `feat/view-bridge-F231`). `core.picker.close`는 선언되어 있다(`packages/workbench/core-exposure.js:553`, `packages/workbench/exposure.json:3586`). plugin view는 `runtime.command`로 어떤 이름이든 `calls.request(name, params)`를 호출한다(`plugins/editor/ui/view.js:128`, `plugins/shell/ui/view.js:104`, `plugins/flowmark/ui/view.js:78`). 따라서 `runtime.command`로 `core.picker.close`를 실행하는 view는 이미 실행할 수 있는 명령 이상을 얻지 않는다. `runtime.shortcuts.run`과 그 허용 목록은 제거한다. 다른 경로로도 닿는 이름 하나짜리 허용 목록은 아무것도 보호하지 않는다. 일반 브리지(`packages/plugin-api/view.js`)도 같은 경로를 받는다. `command: (name, params) => calls.request(name, params)`이며, 모든 view가 경로 하나를 쓰게 한다. 소유자 검사는 호출 계층이 계속 한다.
5. **제거하며, 대체 기간은 두지 않는다.** `shortcuts.register()`와 그 반환(`view.js:160-164,331`)은 대체 기간 없이 제거한다. F231은 출시되지 않았고 `main`에 없으며, core는 0.0.x이므로 호환 계층을 두지 않는다. 함께 제거하는 것: keydown 리스너와 `shortcutTable`(`view.js:137-159`), `MODIFIERS`와 `isKey`(`view.js:21-32`), 사례 `runtime.shortcuts.missing`과 그 이벤트 `page.view.shortcut-table-missing`(`docs/spec/events.json:690`, `packages/sok/tauriv2/src/event_classes.rs:167`, `packages/sok/wailsv3/src/event_classes.go:125`, `packages/workbench/event-classes.js:112`의 class 행), 사례 `runtime.shortcuts.run`(`view-calls.js:205-212`)과 그 이벤트 `page.input.shortcut.failed`(호출 계층이 실패한 호출을 이미 보고하므로). 유지하는 것: `runtime.shortcuts.read`(`view-calls.js:199-200`; `viewShortcuts`는 `:86-88`에서 필터를 `row.when === "Any focus" || row.owner === "view"`에서 소유자 `workbench`와 `view`로 바꾼다. 현재 필터는 네이티브 메뉴 행을 통과시키며, 읽기는 `key`, `owner`, `command`를 돌려준다)와, 그 읽기가 쓰는 `surface-modules.js:21,287`의 `shortcuts` 옵션.
6. **명세, 용어와 표의 문구.** 모든 파일에 영문과 국문을 함께 쓴다.
   - `packages/plugin-api/terms.json:394`("shortcut table"): "소유자와 명령을 가진 workbench 단축키 표(`packages/workbench/shortcuts.json`); view는 `runtime.shortcuts.read`로 읽고 행의 명령을 `runtime.command`로 실행한다."
   - `native-surfaces.md:137`(Input)과 `feat`의 `:141`: view는 표를 등록하지 않는다. view는 workbench 행의 명령을 `runtime.command`로 실행한다(3단계). 호출 목록에 `runtime.shortcuts.run`은 없으며, `runtime.shortcuts.read`는 읽기로 적는다.
   - `plugin-processes.md:94-103`(규칙 7), 이벤트 행 `:141`, 계약 사례 목록 `:166`(단축키 표 사례 제거); `docs/plans/plugin-processes.md:113-123,162-163,190,267`, `docs/spec/events.json:699`(`page.input.shortcut.failed`), `packages/sok/tauriv2/src/event_classes.rs:142`, `packages/sok/wailsv3/src/event_classes.go:100`, `packages/workbench/event-classes.js:87`, `docs/spec/plugin-processes.ko.md:163`(feat). 규칙 7은 2단계와 3단계를 적는다.
   - `exposure.md:67`(소유자 `view`): "view가 기본 동작에 맡기는 키, 또는 view가 넘긴 자신의 키에 대해 `runtime.command`로 실행하는 workbench 명령". `exposure.md:94-95`와 ko: 두 표 행은 `shortcuts.json` 24행과 25행의 문구를 따른다. `feat`의 `exposure.md:71`: 표에 관한 문단을 삭제한다.
   - `packages/workbench/shortcuts.json` 24행(소유자 `view`, `Escape`): `when`은 "플러그인 view가 키보드 포커스를 가진다. view가 키를 직접 처리하며, 열린 선택기의 Escape 명령은 view가 넘길 때만 실행한다"가 된다. 25행(텍스트 입력 키): "플러그인 view가 텍스트 입력에 포커스를 가진다. view가 키를 직접 처리하며 기본 동작을 유지한다." `scripts/test/shortcut-table.test.mjs`는 행을 따른다.
   - `CHANGELOG.md:8`과 `CHANGELOG.ko.md:8`: 호환성 깨짐 줄 "view 단축키 표(F234)와 `shortcuts.register()`를 제거한다. view는 `runtime.command`로 workbench 명령을 실행한다." `docs/features.md:1239`와 ko: F238-b D6로 대체되었음을 적고 제거된 API를 이름으로 적는다.
7. **cmd+k와 shift+cmd+n의 `when` 문구는 바꾸지 않는다.** 라운드 6의 축소(`shortcuts.json:17-18`, `exposure.md:87-88`)는 두 키도 모든 행과 같은 규칙으로 view가 넘기므로 취소한다. 행은 `when` 문구를 유지한다. cmd+k도 텍스트 입력 안에서 같이 넘긴다. 텍스트 입력은 예외가 아니며 view가 결정한다. 라이브러리가 숨겨져 있으면 `core.focus.set`이 거부하고, 그 거부는 호출 오류로 view에 닿는다(시험 (i)).
8. **사례와 시험.** view는 workbench 명령을 `runtime.command`로만 실행한다. 시험(새 동작은 현재 코드에서 실패해야 한다): (a) 어떤 키의 keydown도 브리지에서 호출을 보내지 않는다. (b) 열린 페이지 선택기가 있고 view가 `runtime.command("core.picker.close")`를 실행하면 한 번 닫힌다. (c) 열린 선택기가 없으면 같은 명령은 아무 일도 하지 않는다. (d) view가 넘기지 않은 편집 대상의 Escape는 페이지 선택기를 열어 둔다. (e) `runtime.shortcuts.run`과 `runtime.shortcuts.missing`은 지원하지 않는 것으로 거부된다(소유자 `runtime`). (f) `runtime.shortcuts.read`는 소유자 `workbench`와 `view`의 행을 돌려주고 네이티브 메뉴 행은 없다. (g) 브리지에 `shortcuts.register`가 없다. (h) `core.` 이름의 `runtime.command`는 `runCore`에 닿고, 다른 소유자의 이름은 거부된다. (i) 거부된 전달 명령(라이브러리가 숨겨진 `core.focus.set`)은 호출 오류로 view에 닿는다. (j) `runtime.shortcuts.read`는 소유자 `native menu`의 행을 돌려주지 않는다. (k) 네이티브 빌드의 read에는 `shift+cmd+n` workbench 행이 없다.

### 근거와 증거

- `viewShortcuts`는 라운드 6에서 `runtime.shortcuts.run`에 workbench 행을 돌려준 적이 없다(`view-calls.js:205-212`). 그래서 그 경로는 모든 키를 거부했다. 표 등록과 그 경로를 제거하면 view의 키로 동작하는 코드 경로가 남지 않는다.
- `runtime.command`로 `core.picker.close`를 실행하는 view는 제거된 경로와 같은 동작이며 새 권한이 없다. 호출 계층과 4단계의 소유자 검사가 둘 모두에 적용된다.
- 호스트가 view를 대신해 넘기는 통과(라운드 6의 4단계)는 편집 대상과 평범한 키를 구별하지 못하며, view의 Escape 기본 처리를 호스트가 볼 수 없다. view는 자기 상태를 알고, 넘기는 결정은 view에 속한다.
- 라운드 5에서 모든 `plugins/*` 체크아웃을 `shortcuts.register`, `runtime.shortcuts`, `shortcut-table-missing`으로 검색했다(D6-e). 선언된 plugin 중 제거된 API를 부르는 것은 없다.
- F212.6a의 규칙 7 게이트(`plugin-processes.md` feat `:267`)는 표와 함께 제거된다. 그 Escape 측정은 D6-c에 남으며 F212.6a에 연결된다.

### 필요한 변경

| ID | 소유자 | 변경 |
|---|---|---|
| D6-a | `feat`: `packages/plugin-api/view.js:21-32,137-164,331`(5단계), `packages/plugin-api/terms.json:394`, `packages/workbench/view-calls.js:13-16`(머리 주석), `packages/workbench/surface-modules.js:287`(`shortcuts` 옵션은 `shortcutTable` 대신 `packages/workbench/shortcuts.json`에서 채운다), `:86-88`(소유자 `workbench`와 `view`로 거름; 현재 필터는 네이티브 메뉴 행을 통과시킨다), `:199-203`(`runtime.shortcuts.missing` 제거), `:205-212`(`runtime.shortcuts.run` 제거), `docs/spec/events.json:690`과 class 표 행, `native-surfaces.md:141`, `exposure.md:71`, `docs/plans/plugin-processes.md:113-123,162-163,190,267`, `docs/spec/events.json:699`(`page.input.shortcut.failed`), `packages/sok/tauriv2/src/event_classes.rs:142`, `packages/sok/wailsv3/src/event_classes.go:100`, `packages/workbench/event-classes.js:87`, `docs/spec/plugin-processes.ko.md:163`, `CHANGELOG.md:8`, `docs/features.md:1239`과 ko; `main`: `docs/spec/native-surfaces.md:137`, `plugin-processes.md:94-103,141,166`, `exposure.md:67,94-95`과 ko, `packages/workbench/shortcuts.json:24-25`, `scripts/test/shortcut-table.test.mjs`, `main`의 `CHANGELOG.md:8`과 ko | 등록, 키 표 처리기, missing과 run 사례와 그 이벤트, 표 전용 도우미를 제거한다. `runtime.shortcuts.read`는 유지한다. view 규칙을 적는다(3단계와 6단계). |
| D6-b | `feat`: `packages/plugin-api/test/view.test.mjs:394-419`, `packages/workbench/test/view-calls.test.mjs:13,278-310`, `fakes()`의 `shortcuts` 옵션 | 표 시험을 지우고 8단계의 (a)~(h)를 추가한다. |
| D6-c | `feat`(탐침) | view에 포커스가 있을 때의 macOS 탐침: 페이지 선택기(view가 자기 Escape에서 `core.picker.close`를 실행하면 한 번 닫혀야 한다), view에 포커스가 있는 동안 열린 네이티브 선택기(view는 호출을 보내지 않고, 네이티브 선택기는 자기 경로로 응답한다; 관찰된 결과로 기록), 포커스를 가진 네이티브 모달(view는 keydown을 받지 않는다; 종단 간 확인), cmd+c(역할 행)와 cmd+=(명령 행)을 view 포커스에서 관찰하여 각 네이티브 메뉴 방식을 본다(view는 둘 다 넘기지 않는다); cmd+k와 shift+cmd+n(view가 행의 명령을 실행한다; 네이티브 빌드의 shift+cmd+n은 메뉴가 먼저 처리하고 view는 keydown을 받지 않는 것으로 관찰한다), view에서 입력기 조합을 끝내는 Escape(view가 넘기지 않는다). F212.6a에 연결한다. |
| D6-d | `feat`: `packages/plugin-api/view.js`(일반 브리지의 runtime에 `command: (name, params) => calls.request(name, params)`; 브리지는 keydown 리스너를 설치하지 않는다)와 `packages/workbench/view-calls.js`(`runCore`는 변경 없음) | view가 명령을 실행하는 경로 하나(4단계). |
| D6-e | `main`(`docs/features.md`의 F238-b 기록) | 닫을 때 모든 `plugins/*` 체크아웃에서 `shortcuts.register`, `runtime.shortcuts`, `shortcut-table-missing`을 다시 검색한다. 제거된 등록을 설명하는 열린 행 두 개는 F238-b D6로 대체되었다고 닫는다(ko 포함): `plugins/shell/docs/features.md` P11.6(34행), `plugins/flowmark/docs/features.md` P8.6(27행). 호환성 깨짐 changelog 줄(6단계). |
| D6-f | `main`: `docs/features.md`의 F212.6a와 F212.7 항목(+ko) | F212.6a는 범위를 다시 정한다(표 게이트 제거; Escape 측정은 D6-c에 남는다). F212.7은 표 게이트가 없다. |
| D6-g | 순서: `main`이 먼저, 그다음 `feat`. `main`: `docs/spec/native-surfaces.md`(3단계의 view 규칙과 `runtime.shortcuts.read`, `runtime.command`가 있는 호출 목록)와 ko. `feat`: D6-d와 D6-a | 코드 변경 전에 명세가 규칙과 Escape 계약을 적는다: Escape는 일반 키이며, 자기 Escape 동작이 열린 view는 자기 처리기에서 결정하고, view는 `core.picker.close`를 실행해서만 넘긴다. |

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

#### 라운드 6 (응답)

D6 본문에 대해 두 감사자(둘 다 새 감사자, 읽기 전용, 결정 수준 반론만)가 검토했다.

| 반론 | 응답 |
|---|---|
| D6 A1과 B1: view가 자체 Escape에서 `preventDefault`를 부르지 않으면 Escape 전달이 열린 page picker를 닫는다. 출시된 편집기 찾기 닫기(`editor.js:571`)가 이를 부르는지 확인되지 않았고, vendor의 Escape 처리(`libraries.js:2078`)는 키를 소비하지 않고 돌아올 수 있다 | 결정 수준 반론으로 수용. 미결: 라운드 7은 view 자체 핸들러에서만 보내는 opt-in 전달(브리지는 기본으로 아무것도 보내지 않음)과, 편집 가능한 대상을 건너뛰는 host 쪽 닫기 중 하나를 골라야 한다. |
| D6 A2: `runtime.command`가 이미 `core.picker.close`에 닿는다면 `runtime.shortcuts.run` 경로와 허용 목록은 표면만 늘리고 보호는 없다 | 결정 질문으로 수용. 미결: 라운드 7은 view 브리지가 `runtime.command`로 `core.picker.close`에 닿는지 확인한다. 닿으면 경로를 없애고, 닿지 않으면 허용 목록을 경계가 아닌 편의로 적는다. |
| D6 A3: `shortcuts.register()` 제거는 이를 부르는 외부 plugin을 깬다. 형제 검색은 로컬 checkout만 다룬다 | 수용. 미결: 라운드 7은 한 릴리스 동안 남기는 deprecated no-op(변경 기록 포함)과, 버전을 적은 제거 중 하나를 고른다. |
| D6 B2: `cmd+k`와 `shift+cmd+n`의 workbench 키 전달을 빼는 것이 이유 없는 제거임 | 수용. 미결: 라운드 7은 규칙을 적거나(Escape 외의 workbench 키는 view에서 전달하지 않으며 이유는 `native-surfaces.md`에 적음), 이름 하나(`core.focus.set`)를 자체 테스트와 함께 허용 목록에 추가한다. |

#### 라운드 7 (응답)

D6 본문에 대해 새 감사자 둘(Haiku; 읽기 전용). 각 반론은 파일에서 확인했다.

| 반론 | 응답 |
| --- | --- |
| D6 A: `viewShortcuts`가 `when === "Any focus" || owner === "view"`로 거른다(`view-calls.js:86-88`). 그래서 네이티브 메뉴 행(`shortcuts.json:3-16`, `when` "Any focus")이 view까지 간다 | 수용하고 확인했다. 필터를 소유자 `workbench`와 `view`로 바꾼다(5단계, D6-a); 시험 (j). |
| D6 A: `runtime.command`가 `core.picker.close`에 닿는다는 주장 | 확인: `view-calls.js:244`가 `core.` 이름을 `runCore`로 보낸다; plugin view는 `calls.request(name, params)`를 부른다; `core.picker.close`는 선언되어 있다. 4단계는 유지된다. |
| D6 B: Escape 하위 항목이 없는 문단을 인용하고, 다른 어떤 키에도 없는 Escape 기본값을 준다 | 수용. 하위 항목을 지운다. Escape는 일반 키이며, D6-g가 계약을 적는다. |
| D6 B: 네이티브 메뉴 규칙이 probe(`shift+cmd+n`만)를 넘어 일반화되었다 | 수용. 이 규칙은 더 이상 메뉴 방식에 기대지 않는다: view는 네이티브 메뉴 행을 읽지 않으므로 넘기지 않는다(3단계). D6-c가 `cmd+c`, `cmd+=`, `shift+cmd+n`을 관찰한다. |
| D6 B: 라이브러리가 숨겨진 cmd+k는 누를 때마다 거부되며, 텍스트 입력 안의 cmd+k는 명시되지 않았다 | 수용하고 명시했다(7단계): view는 cmd+k를 모든 행과 같이 넘기며 텍스트 입력 안에서도 그렇다; 거부는 호출 오류로 view에 닿는다(시험 (i)). |
| D6 A: 일반 브리지가 새 경로를 얻는다 | 반론이 아니다: 호출 계층의 소유자 검사가 적용되며, 4단계가 그렇게 적는다. |

#### 라운드 8 (응답)

새 감사자 둘(Haiku). 각 반론은 파일에서 확인했다.

| 반론 | 응답 |
| --- | --- |
| D6 A: 5단계는 `read`가 `when`을 돌려준다고 하지만 `viewShortcuts`는 `key`, `owner`, `command`만 돌려준다 | 수용: 읽기는 `{key, owner, command}`를 돌려주며 `when`은 돌려주지 않는다. |
| D6 A: 네이티브 빌드가 브라우저 전용 `shift+cmd+n` 행을 돌려주면, view가 네이티브 메뉴와 나란히 `core.window.new`를 실행할 수 있다 | 수용: 읽기는 실행 중인 빌드의 행을 돌려준다(3단계); 시험 (k). 네이티브 메뉴의 응답은 D6-c에서 관찰한다. |
| D6 A: 3단계의 Escape 항목이 제거하기로 한 라운드 7 응답과 어긋난다 | 수용: 이 항목은 규칙의 서술로 남기고, 계약은 D6-g에 적는다. 라운드 7 응답은 "기본 문장 제거"로 읽는다. |
| D6 A: `runtime.command`는 view가 선언된 core 명령을 아무것이나 실행하게 하므로, 단일 규칙은 관례로만 성립한다 | 수용: 3단계에 적는다; 표는 workbench가 소유한 키를 알려주며, 넘기는 결정은 view의 것이다. |
| D6 B: 소유자 행에 `plugin-processes.md:267`, `page.input.shortcut.failed`의 다섯 행, `surface-modules.js:287`이 빠졌다 | 수용: D6-a에 더했다. |
| D6 B: 라운드 5 B-5는 `shortcuts` 옵션을 무조건 제거한다고 했다 | 대체됨: 읽기가 남으므로 옵션은 남고 `shortcuts.json`에서 채워진다(5단계). |

## 하위 항목

- D5 하위 항목 S1부터 S3(위 "D5의 하위 항목"): 닫을 때 `docs/features.md`에 F212 아래 소유 브랜치 `feat/view-bridge-F231`로 등록한다.
- D6 행 D6-a부터 D6-g: 닫을 때 F212 아래 F238-b-1부터 F238-b-7까지, 행마다 하나씩 등록한다.

## 다른 곳에 기록할 내용

각 행은 소유자를 적는다. `main`이 소유한 행은 `main`에서 바꿀 내용이고, `feat/view-bridge-F231`이 소유한 행은 그 브랜치에서 바꿀 내용이다.
