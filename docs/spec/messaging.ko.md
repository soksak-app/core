# Messaging

[English](messaging.md)

이 문서는 terminal과 agent 사이 messaging 계약을 정의한다. 구현과 검증은 [features](../features.md)에서 추적한다. [open decisions](messaging.md#open-decisions)에 나열된 항목은 이 문서가 결정하지 않으며, 그 결정이 이 문서에 기록되기 전에는 구현하지 않는다.

## 유효한 결정

- [terminal plan](../plans/terminal-plan.md#32-event-path-decision-d3)의 결정 D3: terminal sidecar가 관찰하는 file event가 messaging 이벤트의 유일한 경로다. Agent hook(Claude Code `FileChanged`, Codex hook event)은 전달 경로에 없다. 메시지는 어느 agent가 파일을 썼든 같은 방식으로 전달된다.
- [terminal plan](../plans/terminal-plan.md#33-delivery-channel-to-the-agent-decision-d4)의 결정 D4: 등록된 terminal로의 input injection이 기본 경로다. Agent가 MCP tool을 지원하는 곳에서는 MCP tool `messages_read`와 `messages_wait`가 더 나은 경로다. 전달은 skill에 의존하지 않는다.
- Sidecar는 polling하지 않는다. Folder 변경은 event source로 관찰하며, 그 library는 Rust crate `notify`다([settled](messaging.md#settled-decisions)). [AGENTS](../../AGENTS.md#implementation)의 규칙이 적용된다: file watching은 생태계의 maintained library를 사용한다.

## 등록된 folder

Terminal은 `messages.register` 요청을 terminal sidecar에 보내 folder를 등록한다. Parameter는 `folder`이며 절대 경로다. 요청에는 모든 sidecar 요청과 같이 terminal의 `surface`가 담긴다([sidecars](sidecars.md#messages)). Sidecar는 자신에게 요청을 보낸 surface에만 event를 보낸다([sidecars](sidecars.md#failure), surface에 host가 보내지 않은 message의 실패 규칙).

Reply는 `{registration, folder}`다. `registration`은 sidecar가 할당하고 그 process 안에서 유일한 식별자다. 존재하지 않는 folder의 요청은 `folder-missing`으로 실패하고, directory가 아닌 경로는 `not-a-directory`로 실패한다. 다른 surface가 이미 등록한 folder의 요청은 `already-registered`로 실패한다. 같은 surface가 같은 folder를 다시 요청하면 같은 reply를 돌려준다. 이 operation은 idempotent하기 때문이다([AGENTS](../../AGENTS.md#implementation)). 각 error는 명시적인 error reply이며, 빈 결과로 대체되지 않는다.

Host가 surface에 `closed`를 보내면 sidecar는 그 surface의 자원(예: watch)을 해제한 뒤 `{"surface": id, "closed": true}`로 답한다. 자원을 해제하지 못하면 `error`로 답한다([sidecars](sidecars.md#messages)).

## File event

File event는 surface의 page에 sidecar message로 전달된다. Host는 각 sidecar message를 surface에 처음 보낸 window에만, `sidecar-message` event `{sidecar, surface, cids, body}`로 전달한다([sidecars](sidecars.md#messages)). Page는 `on(surface, fn)`으로 body를 받는다([page interface](sidecars.md#page-interface)).

File event의 body는 `{registration, path, kind, seq}`다.

- `registration`: 변경을 관찰한 registration의 식별자다.
- `path`: 등록된 folder 기준의 변경된 파일 경로다.
- `kind`: `created`, `modified`, `removed` 중 하나다.
- `seq`: event의 sequence number다.

Sidecar는 folder 안 모든 파일의 변경마다 event 하나를 보낸다. Sequence number `seq`는 registration마다 센다. 한 sidecar process 안에서 각 registration은 1부터 시작한다. Event의 source는 body가 가리키는 registration이다. [logging](logging.md#event)의 `seq` 규칙은 log record에 대해 writer process마다 counter 하나를 두며, 이 계약은 같은 counter 형식을 registration마다 적용한다. 그래야 reader가 folder 하나의 event를 counter 하나로 정렬한다. Plan은 event마다 sequence number를 요구하지만 그 범위는 정의하지 않는다([terminal plan, 3.5](../plans/terminal-plan.md#35-red-and-green-for-f899-7)).

Sidecar catalog의 event 이름은 `sidecar.<name>.file.changed`다. `<name>`은 sidecar가 자신의 catalog에 선언하는 sidecar 이름이다. Catalog 형식은 모든 sidecar event에 그 prefix를 요구하므로([logging](logging.md#sidecar-catalogs)), prefix 없이 주어진 이름은 유효한 catalog 이름이 아니다. Gate level은 `debug`이고 class는 `io`다. Sidecar message가 이 class에 속한다([logging](logging.md#classes-and-policy)). 기본 policy는 `error`만 저장하므로([logging](logging.md#policy)), file event는 사람이 그 class의 `debug` level을 켠 경우에만 저장된다.

## Message

Message는 등록된 folder 안에 바로 쓰인 파일이다. 하위 folder에 쓰지 않는다. 파일 이름은 `.txt`로 끝나고, 내용은 UTF-8 text이며, 크기는 64 KiB 이하다. `.txt`로 끝나지 않는 파일은 file event를 만들지만 message는 되지 않는다. 64 KiB를 넘는 파일은 `messages.read`가 명시적 error `message-too-large`로 거부하며, error에는 path가 담긴다. 상한을 두는 이유는 sidecar buffer가 제한 없이 커지지 않도록 하기 위해서이며, 큰 파일을 잘라서 전달하지 않고 알린다([AGENTS](../../AGENTS.md#implementation)).

Message는 소비되지 않는다. `messages_read`는 `after`보다 큰 sequence number를 가진 message를 `seq` 증가 순서로 돌려준다. 같은 `after`로 반복해서 읽으면 folder가 바뀌지 않는 한 같은 message를 돌려준다. 이 operation은 idempotent하기 때문이다([AGENTS](../../AGENTS.md#implementation)). 같은 파일을 다시 쓰면 새 `created` 또는 `modified` file event가 새 `seq`로 생기며, 이것은 새 message로 그 `seq`와 함께 돌려준다. 이전 event를 대체하지 않는다. Message의 text는 reply를 만들 때 읽는다.

## Folder 제거 또는 이름 변경

등록된 folder가 제거되거나 이름이 바뀌면 sidecar는 `{registration, reason: "folder-removed"}`를 담은 `sidecar.<name>.registration.closed` event를 gate level `info`로 보내고, 그 registration의 watch를 끝낸다. Event는 명시적이며, sidecar는 folder를 polling하지 않는다([AGENTS](../../AGENTS.md#implementation)). 같은 path에 folder를 다시 만들어도 watch는 재개되지 않는다. Agent가 folder를 다시 등록하며, 새 registration의 `seq`는 1에서 시작한다.

## Missing folder

등록된 folder가 존재하지 않으면 실패다. 적용되는 규칙은 다음과 같다. 누락된 operation과 sidecar error는 실패이며 대체하거나 버리지 않는다([sidecars](sidecars.md#messages)). 경계는 잘못된 값을 명시적 error로 거부한다([AGENTS](../../AGENTS.md#implementation)). 등록 시점에 folder가 없으면 `folder-missing`이다. 등록 후 folder가 제거되면 [Folder 제거 또는 이름 변경](messaging.md#folder-removed-or-renamed)의 event가 registration을 끝낸다.

## Input injection

Trigger는 terminal을 통해 동작한다. 등록된 terminal에 input을 주입하거나, 선언된 command를 실행한다. Agent API는 쓰지 않는다([terminal plan, 3.2](../plans/terminal-plan.md#32-event-path-decision-d3)).

Sidecar는 session의 `input`과 `paste` operation으로 input을 받는다([persistent services](persistent-services.md#destructive-command-guard)). 이 operation이 전달하는 제출된 각 줄은 destructive command guard가 판단한다. 선언된 규칙이 일치하거나 command를 판단할 수 없는 줄은 error `guardRefused`로 거부되며, session에 byte를 쓰지 않는다([persistent services](persistent-services.md#destructive-command-guard)). 주입된 message도 이 guard가 판단한다([settled](messaging.md#settled-decisions)).

Message의 input 안 형식은 열려 있다([open decisions](messaging.md#open-decisions), 항목 1). Agent가 foreground TUI에서 작업 중인 terminal은 TUI adapter의 background 또는 send-now action을 통해서만 input을 받는다([terminal plan, 4.1](../plans/terminal-plan.md#41-tui-key-adapters-decision-d6)). Agent마다 둘 중 어느 것을 쓰는지는 보류 상태다([open decisions](messaging.md#open-decisions), 항목 2).

## MCP tools

sok MCP server는 고정된 tool 집합을 노출하며, exposure로 tool을 만들지 않는다([cli](cli.md#mcp-server), tool table의 규칙). Messaging tool은 `messages_read`와 `messages_wait`다. 각 tool은 같은 점 표기 이름의 sidecar operation `messages.read`, `messages.wait`를 호출한다.

| Tool | Arguments | Reply |
| --- | --- | --- |
| `messages_read` | `{terminal, after}`; `after`는 선택이며 기본값은 0 | `{messages: [{seq, path, text}], last}`. `last`는 reply를 만들 때 registration의 가장 큰 `seq`이며, 호출자는 이를 다음 `after`로 넘긴다. 알 수 없는 terminal은 `unknown-terminal`로 실패한다. |
| `messages_wait` | `{terminal, after}`; `after`는 선택이며 기본값은 0 | 도착하면 `messages_read`와 같은 형태다. 이 call은 시간 제한과 timer가 없다. 도착, 호출자의 취소, 또는 그 folder의 registration이 닫힐 때 끝난다. Registration이 닫히면 닫힌 이유와 함께 `registration-closed`로 실패한다. 알 수 없는 terminal은 `unknown-terminal`로 실패한다. |

Wait는 도착하거나 registration을 닫는 event가 올 때 끝난다. Wait는 event를 기다리는 것이며, [AGENTS](../../AGENTS.md#implementation)는 event source가 없을 때만 timer를 허용하므로 timer로 끝내지 않는다. 취소된 call은 status watch와 같이 결과 없이 끝난다([cli](cli.md#mcp-server)).

[cli](cli.md#mcp-server)의 표에 있는 모든 tool은 밑줄 이름을 가진다. 예를 들어 `windows_list`, `status_get`이 그렇다. Messaging tool도 같은 형식을 따른다([settled](messaging.md#settled-decisions)).

실패하거나 거부된 call은 명시적 error를 돌려주며, 빈 결과로 보고하지 않는다. 모든 error는 보고되어야 하기 때문이다([AGENTS](../../AGENTS.md#implementation)). 실패한 tool call은 [cli](cli.md#mcp-server)가 다른 tool에 정의한 대로 tool error를 돌려준다.

Agent는 그 client가 MCP tool을 지원하는 곳에서만 MCP tool을 쓴다([terminal plan, 3.3](../plans/terminal-plan.md#33-delivery-channel-to-the-agent-decision-d4)). Terminal sidecar의 agent catalog가 agent마다 client의 MCP tool 지원 여부를 선언한다. Claude Code와 Codex는 지원하는 것으로 선언된다. Test가 이 선언을 확인한다. Repository에는 agent의 MCP 지원을 runtime에 보고하는 source가 없으므로, 선언이 유일한 source다([settled](messaging.md#settled-decisions)).

## Open decisions

각 항목은 열려 있는 이유를 적는다.

1. Terminal input 안 주입 message의 형식: 보이는 text, message임을 표시하는 prefix, 제출 방식. 결정이 필요하다. Text는 사람이 agent의 input line에서 읽는 내용이며, 그 wording을 repository가 고를 수 없기 때문이다. 공백의 원인: plan은 "one declared form"만 말하고 정의하지 않는다([terminal plan, 3.3](../plans/terminal-plan.md#33-delivery-channel-to-the-agent-decision-d4)).
2. Agent마다 busy foreground TUI에 message를 전달하는 TUI adapter의 action(background 또는 send-now)과 각 action의 key. 보류(held): TUI adapter의 key table이 비어 있어 관찰된 key가 없다. 해제 조건은 key가 관찰되는 것이다. TUI adapter의 message 전달이 이 같은 사실에 의존한다([terminal plan, 4.1](../plans/terminal-plan.md#41-tui-key-adapters-decision-d6)).
3. 공유 machine에서 file event의 전달 지연 상한. 측정 대상으로 보류: plan의 열린 항목 V6이 측정되지 않았고, plan은 측정 전에는 상한을 적지 않는다고 말한다([terminal plan, 3.2](../plans/terminal-plan.md#32-event-path-decision-d3)).
4. Claude Code가 session message를 위한 same-machine direct path를 갖는지. 측정 대상으로 보류: plan의 열린 항목 V8이 기록되지 않았고, 지금까지 관찰된 문자열에는 그런 path가 나타나지 않는다([terminal plan, 3.6](../plans/terminal-plan.md#36-open-items-in-part-3)).

## Settled decisions

- Watcher library: Rust crate `notify`다. 이 crate는 maintained library이며 macOS에서 FSEvents를 사용한다. 이유: [AGENTS](../../AGENTS.md#implementation)는 file watching에 새 구현 대신 maintained library를 요구한다. 이 repository가 쓰는 folder watching library `@parcel/watcher`는 Node test tooling을 위한 것이며, 그 사용이 sidecar의 library를 정하지 않는다. Sidecar 언어의 출처: terminal sidecar는 자신의 repository에서 구현되며 이 repository는 그것을 선언하지 않는다. `notify`의 선택은 plan이 가리키는 Rust 구현을 따른다.
- 파일 감시 sidecar의 transport: `transport: "persistent"`. 이유: registration은 persistent service의 재연결 후에도 살아남아야 하며, [persistent services](persistent-services.md#service-transport)는 재연결이 session을 복원한다고 정한다("Reconnection restores the same session, child process, and session state"). 그 규칙은 session을 말하며 watch는 말하지 않으므로, watch의 생존은 이 계약의 요구사항이다. [Sidecars](sidecars.md#failure)는 실패 후 새 process가 이전 process의 session을 전혀 갖지 않는다고 정하므로, standard input and output sidecar는 process가 끝나면 watch를 잃는다.
- 요청: `messages.register`, parameter `folder`(절대 경로). 이유: 점 표기 operation 형식은 [persistent services](persistent-services.md#screen-message)의 `screen.read`와 같다.
- 등록 reply와 error: `{registration, folder}`; `folder-missing`, `not-a-directory`, `already-registered`. 이유: reply와 명시적 error가 필요하며, sidecar는 이 조건들을 보고한다. Reply 형태는 [등록된 folder](messaging.md#registered-folder)에 주어진 그대로다.
- Sequence 범위: registration마다, 한 sidecar process 안에서 1부터 시작. 이유: [logging](logging.md#event)은 `seq`를 writer마다 센 counter로 두며, registration마다 counter를 두면 reader가 folder 하나의 순서를 얻는다.
- Message 형식: 등록된 folder의 `.txt` 파일, UTF-8, 64 KiB 이하. 더 큰 파일은 `message-too-large`로 거부한다. 이유: text 파일은 terminal agent가 쓰기 가장 단순한 형식이며, 상한은 bounded buffer에 대한 [AGENTS](../../AGENTS.md#implementation)를 따른다.
- 소비: message는 소비되지 않는다. `messages_read`는 `after`를 받아 더 큰 `seq`의 message를 돌려주며, 같은 `after`로 반복 읽으면 같은 결과를 준다. 이유: [AGENTS](../../AGENTS.md#implementation)는 idempotent operation을 요구한다.
- 순서와 다시 쓴 파일: message는 `seq` 증가 순서로 전달된다. 다시 쓴 파일은 새 `seq`를 가진 새 file event이며, 이전 event의 대체가 아니다. 이유: [logging](logging.md#event)의 `seq` 규칙은 한 counter의 event를 정렬하며, 대체하면 [AGENTS](../../AGENTS.md#implementation)의 idempotent 요구를 깨뜨린다.
- 제거 또는 이름 변경된 folder: sidecar는 `reason: "folder-removed"`를 담은 `sidecar.<name>.registration.closed`를 보내며, 다시 만든 folder는 watch를 재개하지 않는다. 이유: [AGENTS](../../AGENTS.md#implementation)는 event source가 있는 곳에서 polling을 금지하며, folder 제거는 watch가 받는 event다.
- 대기 call: `messages_wait`는 `{terminal, after}`를 받고 시간 제한이 없다. 이유: wait는 도착, 호출자 취소, registration 종료 중 하나로 끝나는 event 대기이므로 timer가 필요 없다([AGENTS](../../AGENTS.md#implementation)). 대기 call의 시간 제한 항목은 이 결정으로 닫힌다.
- Event 이름과 gate level: `sidecar.<name>.file.changed`는 `debug`, class `io`; `sidecar.<name>.messages.registered`와 `sidecar.<name>.registration.closed`는 `info`, class `lifecycle`. 이유: sidecar event는 sidecar prefix를 가진다([logging](logging.md#sidecar-catalogs)). `info`는 object lifetime의 변경이고 `debug`는 boundary 통과다([logging](logging.md#event)). Class는 [logging](logging.md#classes-and-policy)의 표를 따른다.
- Agent의 MCP 지원: terminal sidecar의 agent catalog에 agent마다 정적으로 선언하며, Claude Code와 Codex는 MCP tool 지원으로 선언하고, test로 확인한다. 이유: repository에는 agent의 MCP 지원을 runtime에 보고하는 source가 없다([terminal plan, 3.3](../plans/terminal-plan.md#33-delivery-channel-to-the-agent-decision-d4)).
- Tool 이름: 두 MCP tool은 [cli](cli.md#mcp-server)의 모든 tool과 같이 밑줄로 이름 붙인다(`messages_read`, `messages_wait`). 이 문서의 tool table은 이 이름을 쓴다.
- Guard: 주입된 message는 입력된 줄과 같은 `input` operation으로 제출되므로, destructive command guard가 다른 제출 줄과 같이 판단한다([persistent services](persistent-services.md#destructive-command-guard)). 거부된 message는 `rule`과 `reason`을 담은 `guardRefused` reply를 받는다.
- Carrier: 주입된 message는 session의 `input` operation으로 terminal에 도달한다. 이 operation은 입력된 줄을 나르는 operation이다([persistent services](persistent-services.md#destructive-command-guard)). 그 operation의 parameter는 이 repository가 아니라 자신의 repository에서 terminal sidecar가 선언한다([AGENTS](../../AGENTS.md#structure)).
- Busy foreground TUI: busy foreground TUI로의 전달은 TUI adapter의 background 또는 send-now action을 요구한다. Plan은 둘 중 하나가 실행되기 전에는 그런 TUI가 message를 받지 않는다고 말한다([terminal plan, 4.1](../plans/terminal-plan.md#41-tui-key-adapters-decision-d6)).
