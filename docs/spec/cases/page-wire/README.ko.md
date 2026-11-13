# Page-wire cases

[English](README.md)

page-wire case는 workbench page와 host 사이의 교환 한 번을 기록한다. page가 `@soksak/runtime`의 `host` transport로 보내는 각 호출(`host.call(name, payload, options)`), host가 그 호출에 주는 응답, 그리고 page가 `host.on(event, listener)`로 등록한 listener에 host가 보내는 각 notice가 기록된다. workbench page는 [host.js](../../../../packages/workbench/host.js)와 [log-policy.js](../../../../packages/workbench/log-policy.js)에서 이 transport를 읽고, 애플리케이션 runtime이 이를 구현한다(예: [apps/wailsv3/runtime/index.js](../../../../apps/wailsv3/runtime/index.js)의 `host.call`).

case는 이 디렉터리의 추적되는 JSON 파일 하나다. consumer는 workbench page다. page의 테스트는 case의 응답으로 page의 호출에 답한다. producer는 host 패키지다. 같은 case를 실제 host에 실행하고 각 응답이 case가 기록한 것과 같은지 확인한다. [테스트 종류](../../../operations/examples.md#test-kinds) 규칙은 wire consumer에 이를 요구한다.

## 파일

- 파일 이름은 `<name>.json`이며, `name` 멤버는 `.json`을 뺀 파일 이름과 같다.
- 파일 이름 접두사마다 한 영역을 둔다: `compositor-`, `document-region-`, `exposure-reply-`, `file-drop-`, `log-`, `overlay-`, `workspace-`.

## 멤버

| 멤버 | 필수 | 의미 |
| --- | --- | --- |
| `name` | 예 | case 이름이며 파일 이름과 같다. |
| `description` | 예 | 호출이 하는 일과 응답이 무엇인지 설명하는 한 문장(영어). |
| `replay` | 예 | `true`이면 producer가 실제 host에서 case를 실행한다. `false`이면 `reason`이 필요하다. |
| `reason` | `replay`가 `false`일 때 | producer가 case를 실행하지 않는 이유. |
| `variables` | 아니요 | host나 page가 고르는 값. 각 변수는 `"<name>": {"type": ..., "example": ..., "source": ...}`이다. |
| `writer` | 아니요 | case가 실행되는 host의 event writer 상태. `policy`가 `true`이면 writer에 policy 파일(설정 디렉터리의 `log-policy.json`)이 있다. 멤버가 없으면 writer에 policy 파일이 없다. |
| `steps` | 예 | 순서가 있는 교환. 빈 배열이면 page가 호출을 보내지 않는다. |

변수 이름은 소문자, 숫자, 하이픈으로 된 형식이다. `type`은 `string`, `number`, `integer`, `boolean`, `object`, `array`, `null` 중 하나이거나 그 목록이고, `example`은 그 type의 값이다. `source`는 `host`(기본값) 또는 `page`다.

- host 변수는 응답이나 notice에서 host가 고르는 값을 뜻한다. 그 자리의 문자열 `$<name>`이 그 값이다. reader는 `example` 값으로 치환하고, producer는 선언된 `type`의 모든 값을 받아들인다.
- page 변수는 호출에서 page가 고르고 실행마다 반복할 수 없는 값을 뜻한다. 예를 들면 `performance.now()`의 시각이나 생성된 식별자다. reader는 그 자리에서 선언된 `type`의 모든 값을 받아들인다. 첫 값이 변수를 묶고, 이후 호출에서 쓰면 그 값과 같아야 하며, 이후 응답이나 notice에서 쓰면 그 값이 된다. producer는 호출에 `example` 값을 보낸다.
- 호출에는 host 변수가 없다.

## Step

step은 세 객체 중 하나다.

- `{"call": {"name": ..., "payload": ..., "cids": [...]}}`: page가 host 메서드 `name`을 호출한다. `payload`는 호출의 인자 하나이며, page가 인자를 보내지 않으면 없다. `cids`는 page가 호출과 함께 넘기는 상관 식별자 목록이며, 넘기지 않으면 없다.
- `{"reply": {"result": ...}}` 또는 `{"reply": {"error": "..."}}`: 바로 앞 호출에 대한 host의 응답이다. `result`는 호출이 resolve하는 JSON 값이며, host가 아무것도 답하지 않으면 `null`이다. `error`는 호출이 reject하는 오류 텍스트다. `"held": true`이면 reader가 테스트가 풀 때까지 응답을 붙잡으므로, 테스트는 호출이 끝나지 않은 동안 page가 동작하게 할 수 있다. producer는 이 응답을 다른 응답처럼 비교한다.
- `{"notice": {"event": ..., "payload": ...}}`: host가 page가 `event`에 등록한 listener에 인자 하나 `payload`와 함께 notice `event`를 보낸다. notice에 인자가 없으면 `payload`는 없다.

호출 step 다음에는 그 호출의 응답 step이 오고, notice는 그 쌍 사이에 온다. 호출은 page의 호출과 필드 단위로 정확히 비교하며, JSON 인코딩 후에 비교한다. 따라서 없는 필드와 `null`은 서로 다른 값이다.

## Reader 동작

workbench 테스트 runtime(`packages/workbench/test/runtime/page-wire.js`이며, `packages/workbench/test/runtime/index.js`의 `selectPageWire`가 선택한다)은 page의 호출에 step 순서대로 답한다.

- case의 다음 호출이 아닌 호출은 reject되며, 차이가 failure로 남는다.
- case의 마지막 step 뒤의 호출은 reject되며, failure로 남는다.
- reader의 `calls` 목록은 page의 모든 호출을 담으므로, 테스트가 기대하는 호출과 비교할 수 있다.
- `release()`는 가장 오래 붙잡힌 응답을 settle한다.
- `deliverNotice()`는 다음 step을 실행한다. 그 step은 notice여야 하며, page가 그 event에 등록한 각 listener를 호출한다. listener가 없는 notice는 failure다. 테스트는 host가 notice를 보낼 시점에 이를 전달한다.
- `finish()`는 남은 failure가 있거나, 실행되지 않은 step이 있거나, 풀리지 않은 응답이 있으면 throw한다. 테스트는 본문 끝에서 이를 호출한다.

## Producer 실행

page-wire producer를 가진 각 패키지는 `replay: true`인 case를 실제 host에 실행한다. Go producer는 window 없이 host를 실행하고 notice는 window의 listener에만 닿으므로, notice가 있는 `replay: true` case를 거부한다. 그런 case는 window가 있는 producer가 실행할 때까지 `replay: false`와 그 이유를 가진다. 실제 host가 case와 다르게 응답하면 host 또는 case의 결함이다. host의 producer runner는 `packages/host/go/tests/page_wire_test.go`(`TestPageWire`)다. 이 runner는 `replay: true`인 각 case를 bindings의 기록 진입점(`host.RecordedCall`)과 각 호출의 host 메서드가 실행하는 작업(`log`는 `host.LogCommand`, `workspace`는 `host.Workspace.Apply`)을 거쳐 실행한다. 이 디렉터리 case의 응답은 요청에 대해 host 소스가 돌려주는 값이다: `packages/host/go/src/event_relay.go`의 `log` 호출(`LogCommand`, `Log`), `packages/host/go/src/log_policy.go`의 `setLogPolicy`, `packages/host/go/src/workspace.go`의 `workspace` 호출(`snapshot`, `Apply`, `runWorkspace`).

## 한계

- case는 host가 읽는 상태를 말하며, 그 상태를 만드는 방법은 말하지 않는다. registry의 project에 의존하는 응답(예: project의 설정 변경)은 producer가 그 상태를 만들 수 있는 case가 필요하며, 형식은 아직 이를 이름으로 정하지 않는다.
