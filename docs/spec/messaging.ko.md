# Messaging

[English](messaging.md)

이 문서는 terminal과 agent 사이 messaging 계약을 정의한다. 구현과 검증은 [features](../features.md)에서 추적한다. [open decisions](messaging.md#open-decisions)에 열린 것으로 표시된 항목은 이 문서가 결정하지 않으며, 그 결정이 이 문서에 기록되기 전에는 구현하지 않는다.

## 유효한 결정

- [terminal plan](../plans/terminal-plan.md#32-event-path-decision-d3)의 결정 D3: terminal sidecar가 관찰하는 file event가 messaging 이벤트의 유일한 경로다. Agent hook(Claude Code `FileChanged`, Codex hook event)은 전달 경로에 없다. 메시지는 어느 agent가 파일을 썼든 같은 방식으로 전달된다.
- [terminal plan](../plans/terminal-plan.md#33-delivery-channel-to-the-agent-decision-d4)의 결정 D4: 등록된 terminal로의 input injection이 기본 경로다. Agent가 MCP tool을 지원하는 곳에서는 MCP tool `messages.read`와 `messages.wait`가 더 나은 경로다. 전달은 skill에 의존하지 않는다.
- Sidecar는 polling하지 않는다. Folder 변경은 event source로 관찰한다. [AGENTS](../../AGENTS.md)의 규칙이 적용된다: file watching은 생태계의 maintained library를 사용한다. 이 문서는 library 이름을 정하지 않는다([open decisions](messaging.md#open-decisions), 질문 1).

## 등록된 folder

Terminal은 선언된 요청을 terminal sidecar에 보내 folder를 등록한다. 요청에는 모든 sidecar 요청과 같이 terminal의 `surface`가 담긴다([sidecars](sidecars.md#messages)). Sidecar는 자신에게 요청을 보낸 surface에만 event를 보낸다([sidecars](sidecars.md#failure), surface에 host가 보내지 않은 message의 실패 규칙).

Host가 surface에 `closed`를 보내면 sidecar는 그 surface의 자원(예: watch)을 해제한 뒤 `{"surface": id, "closed": true}`로 답한다. 자원을 해제하지 못하면 `error`로 답한다([sidecars](sidecars.md#messages)).

Folder 등록 command, 그 parameter, 그 reply는 열려 있다([open decisions](messaging.md#open-decisions), 질문 2와 3).

## File event

File event는 surface의 page에 sidecar message로 전달된다. Host는 각 sidecar message를 surface에 처음 보낸 window에만, `sidecar-message` event `{sidecar, surface, cids, body}`로 전달한다([sidecars](sidecars.md#messages)). Page는 `on(surface, fn)`으로 body를 받는다([page interface](sidecars.md#page-interface)).

Plan은 변경마다 event 하나를 요구하며, 각 event는 source와 sequence number를 가진다([terminal plan, 3.5](../plans/terminal-plan.md#35-red-and-green-for-f899-7)). Event의 body, source 값, sequence의 범위, sidecar catalog([logging](logging.md#sidecar-catalogs))의 event 이름은 열려 있다([open decisions](messaging.md#open-decisions), 질문 4와 5).

## Message

Message는 등록된 folder에 쓰인 파일이다. 파일 형식, 파일 이름, folder 안의 위치, 읽는 절차, 읽은 message의 소비, message의 순서와 반복은 열려 있다([open decisions](messaging.md#open-decisions), 질문 6부터 8).

## 없는 folder

등록된 folder가 없으면 실패다. 적용되는 규칙은 다음과 같다. 누락된 operation과 sidecar 오류는 실패이며 대체되거나 버려지지 않는다([sidecars](sidecars.md#messages)). 경계는 잘못된 값을 명시적 오류로 거부한다([AGENTS](../../AGENTS.md)). 등록 시점에 folder가 없을 때의 reply, 등록 후 folder가 제거되거나 이름이 바뀔 때의 동작은 열려 있다([open decisions](messaging.md#open-decisions), 질문 3과 9).

## Input injection

Trigger는 terminal을 통해 동작한다. 등록된 terminal에 input을 주입하거나, 선언된 command를 실행한다. Agent API는 쓰지 않는다([terminal plan, 3.2](../plans/terminal-plan.md#32-event-path-decision-d3)).

Sidecar는 session의 `input`과 `paste` operation으로 input을 받는다([persistent services](persistent-services.md#destructive-command-guard)). 이 operation이 담은 제출 줄마다 destructive command guard가 판정한다. 선언된 규칙에 맞는 줄이나 명령을 판정할 수 없는 줄은 오류 `guardRefused`로 거부되며 session에 byte를 쓰지 않는다([persistent services](persistent-services.md#destructive-command-guard)). 주입된 message가 이 guard를 통과하는지는 열려 있다([open decisions](messaging.md#open-decisions), 질문 10).

Message를 terminal로 옮기는 선언된 command, input 안의 message 형식은 열려 있다([open decisions](messaging.md#open-decisions), 질문 11과 12). Agent가 foreground TUI에서 바쁠 때는 TUI adapter의 background 또는 send-now 동작을 통해서만 input을 받는다([terminal plan, 4.1](../plans/terminal-plan.md#41-tui-key-adapters-decision-d6)). Message가 어느 동작을 쓰는지는 열려 있다(질문 13).

## MCP tool

Sok MCP server는 고정된 tool 집합을 제공하며, exposure에서 tool을 만들지 않는다([cli](cli.md#mcp-server), tool 표의 규칙). Messaging tool은 feature row가 적은 이름 `messages.read`와 `messages.wait`다.

| Tool | 인자 | Reply |
| --- | --- | --- |
| `messages.read` | 열림 (질문 14) | 열림 (질문 15) |
| `messages.wait` | 열림 (질문 16) | 열림 (질문 17) |

이름은 점으로 구분되지만, [cli](cli.md#mcp-server)의 tool 표에 있는 모든 tool은 밑줄 이름(예: `windows_list`, `status_get`)이다. 이름 형식은 열려 있다(질문 18).

거부되거나 실패한 호출은 명시적 오류를 돌려준다. 빈 결과로 보고하지 않는다. 모든 오류는 보고된다([AGENTS](../../AGENTS.md)). Tool 호출이 실패하면 [cli](cli.md#mcp-server)가 다른 tool에 정의한 대로 tool 오류를 돌려준다. 각 messaging tool의 오류 문구는 reply와 함께 열려 있다.

Agent는 client가 MCP tool을 지원하는 곳에서만 MCP tool을 쓴다([terminal plan, 3.3](../plans/terminal-plan.md#33-delivery-channel-to-the-agent-decision-d4)). Sidecar나 trigger가 agent의 MCP 지원을 아는 방법은 열려 있다(질문 19).

## 열린 결정

각 질문은 열린 이유를 적는다.

1. 플랫폼별 folder 감시에 쓸 maintained library. 이유: AGENTS는 file watching에 maintained library를 요구하며, 저장소가 이 계약에 대해 library를 지정하지 않는다.
2. Folder를 등록하는 선언된 요청과 그 parameter. 이유: plan은 등록을 "a terminal registers a folder"로만 적는다([terminal plan, 3.1](../plans/terminal-plan.md#31-requirement)).
3. 등록의 reply와, folder가 없거나 디렉터리가 아니거나 다른 surface가 이미 등록한 경우의 오류 문구. 이유: plan이 reply를 정의하지 않는다.
4. File event의 body: 필드, 변경 종류, 가리키는 경로. 이유: plan은 source와 sequence number를 요구하지만 정의하지 않는다.
5. File event의 sequence number와 source: 범위(등록별, folder별, sidecar 실행별, boot별)와 source가 가리키는 값. 이유: plan이 범위를 정하지 않으며, event log는 [logging](logging.md#event)의 형식으로 sequence를 요구한다.
6. Message 파일의 형식(예: JSON 또는 text, 최대 크기), 파일 이름 규칙, 쓰이는 folder. 이유: plan이 message 형식을 정의하지 않는다.
7. 읽은 message를 소비하는지, 옮기는지, 그대로 두는지, 같은 message를 다시 읽을 때의 동작. 이유: plan이 소비를 정의하지 않는다.
8. 여러 message가 함께 도착할 때의 순서, 다시 쓰인 message의 처리. 이유: plan이 순서와 반복을 정의하지 않는다.
9. 등록 후 folder가 제거되거나 이름이 바뀔 때의 동작: 명시적 event로 watch가 끝나는지, 다시 만들어진 folder에서 watch가 재개되는지. 이유: plan은 이미 있는 folder의 등록만 다룬다.
10. 주입된 message가 destructive command guard를 통과하는지, guard 규칙에 맞는 message를 거부할지 다르게 보고할지. 이유: guard는 제출된 각 줄을 판정하며([persistent services](persistent-services.md#destructive-command-guard)), message는 제출된 input이다. Plan은 이를 정하지 않는다.
11. 주입된 message를 terminal로 옮기는 선언된 command와 그 parameter. 이유: plan은 trigger 경로를 적지만 command를 적지 않는다([terminal plan, 3.2](../plans/terminal-plan.md#32-event-path-decision-d3)).
12. Terminal input 안의 주입된 message 형식(text, message임을 나타내는 접두어, 제출 방식). 이유: plan은 "one declared form"이라고만 적고 정의하지 않는다([terminal plan, 3.3](../plans/terminal-plan.md#33-delivery-channel-to-the-agent-decision-d4)).
13. 바쁜 foreground TUI에 message를 전달하는 TUI 동작(background, send-now, 또는 idle 상태의 대기열)과 agent별 규칙. 이유: adapter의 동작 key는 agent별로 정의되지만 아직 선언되지 않았다([terminal plan, 4.1](../plans/terminal-plan.md#41-tui-key-adapters-decision-d6)).
14. `messages.read`의 인자. 이유: plan은 tool 이름만 적는다.
15. `messages.read`의 reply: 멤버 이름, message의 순서, 알 수 없는 terminal의 오류 문구. 이유: plan은 결과가 구조화된다고만 적고 형식을 정의하지 않는다.
16. `messages.wait`의 인자. 이유: plan은 tool 이름만 적는다.
17. `messages.wait`의 reply: 도착 시, 시간 초과 시, client 취소 시. 이유: plan이 정의하지 않는다. [cli](cli.md#mcp-server)의 status watch 취소는 선례일 뿐 이 tool의 결정이 아니다.
18. 두 tool의 이름 형식: feature row가 적은 점 표기, 또는 [cli](cli.md#mcp-server)의 모든 tool이 쓰는 밑줄 표기. 이유: 두 형식이 충돌하며, 결정은 tool 표를 바꾼다.
19. Sidecar나 trigger가 agent의 MCP tool 지원을 아는 방법, 그리고 adapter가 동작별로 이를 선언하는지([terminal plan, 4.1](../plans/terminal-plan.md#41-tui-key-adapters-decision-d6)). 이유: plan은 조건을 적지만 선언을 적지 않는다.
20. Claude Code와 Codex에서 기다리는 `messages.wait` 호출의 시간 제한. 이유: plan의 열린 항목 V7은 측정되지 않았다([terminal plan, 3.6](../plans/terminal-plan.md#36-open-items-in-part-3)).
21. 공유 기기에서 file event의 전달 지연 상한. 이유: plan의 열린 항목 V6은 측정되지 않았으며, plan은 측정 전에 상한을 적지 않는다고 한다([terminal plan, 3.2](../plans/terminal-plan.md#32-event-path-decision-d3)).
22. Claude Code에 session message를 위한 같은 기기 직접 경로가 있는지. 이유: plan의 열린 항목 V8은 기록되지 않았다([terminal plan, 3.6](../plans/terminal-plan.md#36-open-items-in-part-3)).
23. File 감시 sidecar의 transport, `stdio` 또는 `persistent`, 그리고 persistent service가 재연결될 때 watch가 유지되는지. 이유: persistent service 계약은 session의 재연결을 정의하지만([persistent services](persistent-services.md#service-transport)) watch를 적지 않는다.
24. File event, 등록, message 전달의 sidecar catalog event 이름과 event log의 gate 수준([logging](logging.md#sidecar-catalogs)). 이유: 선언된 event 이름이 없다.
