# Page-wire cases

[English](README.md)

page-wire case는 workbench page와 host 사이에서 주고받는 호출 한 번의 교환을 기록한다. page가 `@soksak/runtime`의 `host` transport로 보내는 각 호출(`host.call(name, payload, options)`)과 host가 그 호출에 주는 응답이 기록된다. workbench page는 [host.js](../../../../packages/workbench/host.js)와 [log-policy.js](../../../../packages/workbench/log-policy.js)에서 이 transport를 읽고, 애플리케이션 runtime이 이를 구현한다(예: [apps/wailsv3/runtime/index.js](../../../../apps/wailsv3/runtime/index.js)의 `host.call`).

case는 이 디렉터리의 추적되는 JSON 파일 하나다. consumer는 workbench page다. page의 테스트는 case의 응답으로 page의 호출에 답한다. producer는 host 패키지다. 같은 case를 실제 host에 실행하고 각 응답이 case가 기록한 것과 같은지 확인한다. [테스트 종류](../../../operations/examples.md#test-kinds) 규칙은 wire consumer에 이를 요구한다.

## 파일

- 파일 이름은 `<name>.json`이며, `name` 멤버는 `.json`을 뺀 파일 이름과 같다.
- 파일 이름 접두사마다 한 영역을 둔다: `log-`, `workspace-`.

## 멤버

| 멤버 | 필수 | 의미 |
| --- | --- | --- |
| `name` | 예 | case 이름이며 파일 이름과 같다. |
| `description` | 예 | 호출이 하는 일과 응답이 무엇인지 설명하는 한 문장(영어). |
| `replay` | 예 | `true`이면 producer가 실제 host에서 case를 실행한다. `false`이면 `reason`이 필요하다. |
| `reason` | `replay`가 `false`일 때 | producer가 case를 실행하지 않는 이유. |
| `variables` | 아니요 | host가 고르는 값. 각 변수는 `"<name>": {"type": "...", "example": ...}`이다. |
| `writer` | 아니요 | case가 실행되는 host의 event writer 상태. `policy`가 `true`이면 writer에 policy 파일(설정 디렉터리의 `log-policy.json`)이 있다. 멤버가 없으면 writer에 policy 파일이 없다. |
| `steps` | 예 | 순서가 있는 교환. 빈 배열이면 page가 호출을 보내지 않는다. |

변수 이름은 소문자, 숫자, 하이픈으로 된 형식이다. 응답 값이 문자열 `$<name>`이면 host가 그 변수에 고른 값을 뜻한다. reader는 `example` 값으로 치환하고, producer는 선언된 `type`의 모든 값을 받아들인다. 변수는 응답 값에만 쓴다. page가 보내는 값은 page가 고르므로 호출 step에는 변수가 없다.

## Step

step은 두 객체 중 하나다.

- `{"call": {"name": ..., "payload": ..., "cids": [...]}}`: page가 host 메서드 `name`을 호출한다. `payload`는 호출의 인자 하나이며, page가 인자를 보내지 않으면 없다. `cids`는 page가 호출과 함께 넘기는 상관 식별자 목록이며, 넘기지 않으면 없다.
- `{"reply": {"result": ...}}` 또는 `{"reply": {"error": "..."}}`: 바로 앞 호출에 대한 host의 응답이다. `result`는 호출이 resolve하는 JSON 값이며, host가 아무것도 답하지 않으면 `null`이다. `error`는 호출이 reject하는 오류 텍스트다.

호출 step 다음에는 그 호출의 응답 step이 온다. case는 응답 step으로 끝난다. 호출은 page의 호출과 필드 단위로 정확히 비교하며, JSON 인코딩 후에 비교한다. 따라서 없는 필드와 `null`은 서로 다른 값이다.

## Reader 동작

workbench 테스트 runtime(`packages/workbench/test/runtime/page-wire.js`이며, `packages/workbench/test/runtime/index.js`의 `selectPageWire`가 선택한다)은 page의 호출에 step 순서대로 답한다.

- case의 다음 호출이 아닌 호출은 reject되며, 차이가 failure로 남는다.
- case의 마지막 step 뒤의 호출은 reject되며, failure로 남는다.
- reader의 `calls` 목록은 page의 모든 호출을 담으므로, 테스트가 기대하는 호출과 비교할 수 있다.
- `finish()`는 남은 failure가 있거나 실행되지 않은 step이 있으면 throw한다. 테스트는 본문 끝에서 이를 호출한다.
- case에는 notice가 없다. page가 `on`으로 등록한 listener는 호출되지 않는다.

## Producer 실행

page-wire producer를 가진 각 패키지는 `replay: true`인 case를 실제 host에 실행한다. 실제 host가 case와 다르게 응답하면 host 또는 case의 결함이다. host의 producer runner는 `packages/host/go/tests/page_wire_test.go`(`TestPageWire`)다. 이 runner는 `replay: true`인 각 case를 bindings의 기록 진입점(`host.RecordedCall`)과 각 호출의 host 메서드가 실행하는 작업(`log`는 `host.LogCommand`, `workspace`는 `host.Workspace.Apply`)을 거쳐 실행한다. 이 디렉터리 case의 응답은 요청에 대해 host 소스가 돌려주는 값이다: `packages/host/go/src/event_relay.go`의 `log` 호출(`LogCommand`, `Log`), `packages/host/go/src/log_policy.go`의 `setLogPolicy`, `packages/host/go/src/workspace.go`의 `workspace` 호출(`snapshot`, `Apply`, `runWorkspace`).

## 한계

- Notice는 기록하지 않는다. host는 쓰기를 수행하는 `workspace` 호출 뒤에 각 window에 workspace 변경(`workspace-changed`)을 알리며, 이 디렉터리의 case는 그 notice를 기록하지 않는다. notice가 있는 case는 아직 정의되지 않은 형식 확장이 필요하다.
- case는 host가 읽는 상태를 말하며, 그 상태를 만드는 방법은 말하지 않는다. registry의 project에 의존하는 응답(예: project의 설정 변경)은 producer가 그 상태를 만들 수 있는 case가 필요하며, 형식은 아직 이를 이름으로 정하지 않는다.
- 요청이 시각이나 생성된 값을 담는 호출은 아직 기록하지 않는다. case는 요청을 정확히 비교하기 때문이다.
