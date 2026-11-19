# Messaging

[English](messaging.md)

이 문서는 terminal과 agent 사이 messaging 계약을 정의한다. 구현과 검증은 [features](../features.md)에서 추적한다. [open decisions](messaging.md#open-decisions)에 나열된 항목은 이 문서가 결정하지 않으며, 그 결정이 이 문서에 기록되기 전에는 구현하지 않는다.

## 유효한 결정

- [terminal plan](../plans/terminal-plan.md#32-event-path-decision-d3)의 결정 D3: terminal sidecar가 관찰하는 file event가 messaging 이벤트의 유일한 경로다. Agent hook(Claude Code `FileChanged`, Codex hook event)은 전달 경로에 없다. 메시지는 어느 agent가 파일을 썼든 같은 방식으로 전달된다.
- [terminal plan](../plans/terminal-plan.md#33-delivery-channel-to-the-agent-decision-d4)의 결정 D4: 등록된 terminal로의 input injection이 기본 경로다. Agent가 MCP tool을 지원하는 곳에서는 MCP tool `messages_read`와 `messages_wait`가 더 나은 경로다. 전달은 skill에 의존하지 않는다.
- Sidecar는 polling하지 않는다. Folder 변경은 event source로 관찰하며, 그 library는 Rust crate `notify`다([settled](messaging.md#settled-decisions)). [AGENTS](../../AGENTS.md#implementation)의 규칙이 적용된다: file watching은 생태계의 maintained library를 사용한다.

## 등록된 folder

Terminal은 `messages.register` 요청을 terminal sidecar에 보내 folder를 등록한다. Parameter는 `folder`이며 절대 경로다. 요청에는 모든 sidecar 요청과 같이 terminal의 `surface`가 담긴다([sidecars](sidecars.md#messages)). Sidecar는 자신에게 요청을 보낸 surface에만 event를 보낸다([sidecars](sidecars.md#failure), surface에 host가 보내지 않은 message의 실패 규칙).

Reply는 `{registration, folder}`다. `registration`은 sidecar가 할당하는 식별자이며, folder를 등록할 때 난수로 만든 version 4 UUID다. 따라서 process를 넘어 유일하다([wire 결정](messaging.md#wire-decisions), 항목 3). 존재하지 않는 folder의 요청은 `folder-missing`으로 실패하고, directory가 아닌 경로는 `not-a-directory`로 실패한다. 다른 surface가 이미 등록한 folder, 또는 registration을 이미 가진 surface의 두 번째 folder의 요청은 `already-registered`로 실패한다. 같은 surface가 같은 folder를 다시 요청하면 같은 reply를 돌려준다. 이 operation은 idempotent하기 때문이다([AGENTS](../../AGENTS.md#implementation)). 이 규칙들은 [wire 결정](messaging.md#wire-decisions)에서 정한다. 각 error는 명시적인 error reply이며, 빈 결과로 대체되지 않는다.

Host가 surface에 `closed`를 보내면 sidecar는 그 surface의 자원(예: watch)을 해제한 뒤 `{"surface": id, "closed": true}`로 답한다. 자원을 해제하지 못하면 `error`로 답한다([sidecars](sidecars.md#messages)).

## File event

File event는 surface의 page에 sidecar message로 전달된다. Host는 각 sidecar message를 surface에 처음 보낸 window에만, `sidecar-message` event `{sidecar, surface, cids, body}`로 전달한다([sidecars](sidecars.md#messages)). Page는 `on(surface, fn)`으로 body를 받는다([page interface](sidecars.md#page-interface)).

File event의 body는 `{registration, path, from, kind, seq}`다.

- `registration`: 변경을 관찰한 registration의 식별자다.
- `path`: 등록된 folder 기준의 변경된 파일 경로다.
- `from`: message 파일 이름에서 읽은 보낸 surface의 식별자다([message](messaging.md#message)). Message 파일만 event를 만들므로 event마다 `from`이 있다.
- `kind`: `created`, `modified`, `removed` 중 하나다.
- `seq`: event의 sequence number다.

Sidecar는 message 파일의 변경마다 event 하나를 보낸다. Message 파일은 이름이 `.txt`로 끝나고 sender를 담는, folder의 바로 아래 파일이다([message](messaging.md#message), [wire 결정](messaging.md#wire-decisions)). Sequence number `seq`는 registration마다 센다. 한 sidecar process 안에서 각 registration은 1부터 시작한다. Event의 source는 body가 가리키는 registration이다. [logging](logging.md#event)의 `seq` 규칙은 log record에 대해 writer process마다 counter 하나를 두며, 이 계약은 같은 counter 형식을 registration마다 적용한다. 그래야 reader가 folder 하나의 event를 counter 하나로 정렬한다. Plan은 event마다 sequence number를 요구하지만 그 범위는 정의하지 않는다([terminal plan, 3.5](../plans/terminal-plan.md#35-red-and-green-for-f899-7)).

Wire에서 event 이름은 body의 member `body.event`이며 값은 `file.changed`다([wire 결정](messaging.md#wire-decisions), 항목 1). 아래 이름은 event log record의 이름이다. 각 terminal sidecar는 자기 surface의 folder를 감시하고 그 message를 전달한다: plugin `term`에는 `alacritty`, plugin `terminal`에는 `vt`다. 각자 자기 plugin의 terminal session을 가지기 때문이며, 둘 다 이 contract를 구현하고 그 [공유 case](messaging.md#shared-cases)를 실행한다. sidecar catalog의 event 이름은 `sidecar.<sidecar>.file.changed`(`sidecar.alacritty.file.changed`, `sidecar.vt.file.changed`)다. Catalog 형식은 모든 sidecar event에 그 prefix를 요구하므로([logging](logging.md#sidecar-catalogs)), prefix 없이 주어진 이름은 유효한 catalog 이름이 아니다. Gate level은 `debug`이고 class는 `io`다. Sidecar message가 이 class에 속한다([logging](logging.md#classes-and-policy)). 기본 policy는 `error`만 저장하므로([logging](logging.md#policy)), file event는 사람이 그 class의 `debug` level을 켠 경우에만 저장된다.

## Message

Message는 등록된 folder 안에 바로 쓰인 파일이다. 하위 folder에 쓰지 않는다. 파일 이름은 `<from>.<token>.txt`다. `from`은 보낸 surface의 식별자이며, 보내는 쪽이 자기 환경의 `SOKSAK_SURFACE`에서 읽는다([surface의 프로세스](sidecars.md#processes-of-a-surface)). `token`은 이름을 유일하게 만드는, `.`이 없는 빈 문자열이 아닌 문자열이다. Sidecar는 이름에서 `.txt`를 뗀 뒤 마지막 `.` 앞의 text를 `from`으로 본다. 따라서 surface 식별자는 `.`을 포함할 수 있다. 내용은 UTF-8 text이며, 크기는 64 KiB 이하다. 하위 folder의 파일이나 이름이 `.txt`로 끝나지 않는 파일은 event도 message도 만들지 않는다([wire 결정](messaging.md#wire-decisions)). `from`이나 `token`이 비어 있는 `.txt` 파일은 event를 만들지 않으며, 그 파일이 제거되거나 이름이 바뀔 때까지 `messages.read`가 path를 밝히며 `invalid-sender`로 거부한다([wire 결정](messaging.md#wire-decisions), 항목 16). 64 KiB를 넘는 파일은 `messages.read`가 명시적 error `message-too-large`로 거부하며, error에는 path가 담긴다. 상한을 두는 이유는 sidecar buffer가 제한 없이 커지지 않도록 하기 위해서이며, 큰 파일을 잘라서 전달하지 않고 알린다([AGENTS](../../AGENTS.md#implementation)). 내용이 UTF-8이 아닌 message는 `messages.read`가 `invalid-text`로 거부하며, error에는 path가 담긴다. 경계는 잘못된 값의 byte를 바꾸지 않고 거부하기 때문이다([AGENTS](../../AGENTS.md#implementation)).

Writer는 message를 `.txt`로 끝나지 않는 임시 이름, 예를 들면 같은 folder의 `.tmp-<random>`으로 먼저 만들고, text를 쓴 뒤 file을 닫은 다음, `<from>.<token>.txt` 이름으로 rename한다. Rename만이 message가 보이는 유일한 시점이다. 새 파일은 생성될 때 보고되며, 그 시점은 쓰기가 끝나기 전일 수 있다. Sidecar는 `.txt`로 끝나는 이름만 읽는다. `sok`의 send command는 이 방식으로 message를 쓴다. [cli](cli.md#commands)가 그 command를 정의하며, 이 규칙이 그 계약이다. `sok`이 아닌 writer도 같은 규칙을 따라야 한다. Sidecar는 완성된 파일과 쓰는 중인 파일을 구별할 수 없기 때문이다([wire 결정](messaging.md#wire-decisions), 항목 17). 두 sidecar에 대해 macOS에서 측정했다: 임시 이름으로 여러 단계에 걸쳐 쓴 message는 event를 주지 않고, 그 rename은 `created` 하나를 주며, 그 읽기는 text 전체를 돌려준다(`alacritty-core/tests/serve_contract.rs`와 `vt-core/tests/serve_contract.rs`의 쓰기 규칙 test).

Message는 소비되지 않는다. `messages_read`는 `after`보다 큰 sequence number를 가진 message를 `seq` 증가 순서로 돌려준다. 같은 `after`로 반복해서 읽으면 folder가 바뀌지 않는 한 같은 message를 돌려준다. 이 operation은 idempotent하기 때문이다([AGENTS](../../AGENTS.md#implementation)). 같은 파일을 다시 쓰면 새 `created` 또는 `modified` file event가 새 `seq`로 생기며, 이것은 새 message로 그 `seq`와 함께 돌려준다. 이전 event를 대체하지 않는다. Message의 text는 reply를 만들 때 읽는다. `removed` event는 message가 아니다: reply의 message는 reply를 만들 때 파일이 있는 `created`와 `modified` event이며, `last`는 registration의 모든 event 중 가장 큰 `seq`다.

## Folder 제거 또는 이름 변경

등록된 folder가 제거되거나 이름이 바뀌면 sidecar는 `{registration, reason: "folder-removed"}`를 담은 `sidecar.<sidecar>.registration.closed` event를 gate level `info`로 보내고, 그 registration의 watch를 끝낸다. Event는 명시적이며, sidecar는 folder를 polling하지 않는다([AGENTS](../../AGENTS.md#implementation)). 같은 path에 folder를 다시 만들어도 watch는 재개되지 않는다. Agent가 folder를 다시 등록하며, 새 registration의 `seq`는 1에서 시작한다.

## 재시작 뒤 cursor

`seq`는 registration마다 세며, 다시 시작한 sidecar process는 새 registration을 만들므로 `seq`가 다시 1에서 시작한다. Registration은 만들 때마다 새 난수 version 4 UUID를 받으므로(출처: `alacritty-core/src/pty.rs:365`, `Uuid::new_v4().to_string()`), 다시 시작한 process의 registration은 이전 어떤 registration과도 같지 않고, 이전 process의 cursor는 현재 registration이 없는 식별자를 가리킨다. Agent가 이전 process에서 보관한 cursor는 메시지를 건너뛰거나 반복하게 된다. 따라서 registration이 cursor의 epoch다. Read의 reply는 `registration`을 돌려주고, 호출자는 이를 `after`와 함께 넘긴다. 현재 registration이 아닌 `registration`의 read나 wait는 `epoch-changed`로 실패하며, 주어진 registration과 현재 registration을 밝힌다. 호출자는 현재 registration으로 `after` 0부터 다시 읽는다. `after`가 0보다 크고 `registration`이 없는 read는 `invalidParams`로 실패한다. Epoch를 folder의 message 수로 두지 않는다. 수는 message가 지워지면 바뀌어 가장 큰 `seq`가 cursor보다 작아지고, 새 message가 건너뛰어지기 때문이다([cursor across restart](messaging.md#cursor-across-restart), [wire 결정](messaging.md#wire-decisions), 항목 18).

## Missing folder

등록된 folder가 존재하지 않으면 실패다. 적용되는 규칙은 다음과 같다. 누락된 operation과 sidecar error는 실패이며 대체하거나 버리지 않는다([sidecars](sidecars.md#messages)). 경계는 잘못된 값을 명시적 error로 거부한다([AGENTS](../../AGENTS.md#implementation)). 등록 시점에 folder가 없으면 `folder-missing`이다. 등록 후 folder가 제거되면 [Folder 제거 또는 이름 변경](messaging.md#folder-removed-or-renamed)의 event가 registration을 끝낸다.

## Hand-off는 message가 아니다

Hand-off는 작업을 다른 terminal에 넘기고 결과를 받는 것이다. 이는 message가 아니라 record다. Message는 reader가 순서대로 받는 text이며, message로 보낸 결과는 어느 attempt의 답인지 보이지 않기 때문이다. record와 그 저장을 정의한 specification은 아직 없으며, 이 문서는 분리만 정의한다. Record의 상태는 `assigned`, `started`, `result`, `integrated`, `abandoned`다. `assigned`가 attempt를 시작하고, `started`, `result`, `integrated`가 그 순서로 따른다. `abandoned`는 `integrated`에 이르지 않은 attempt를 끝내며, 그 뒤의 새 할당은 다음 attempt를 시작한다. 각 record는 `attempt` 번호를 가지며, 1에서 시작해 할당마다 1씩 늘어난다. 상태 변경은 자기 attempt를 밝히며, 이전 attempt의 변경이나 결과는 `stale-attempt`로 거부된다. 이 error는 현재 attempt를 밝힌다. Record에는 heartbeat, 시간 제한, lock이 없다. 멈춘 attempt는 소유자나 사람이 `abandoned`로 끝낼 때까지 `started`로 남으며, 기다리는 호출자는 상태 event를 기다린다. [AGENTS](../../AGENTS.md#implementation)가 event 대기에 요구하는 방식이다.

## Input injection

Trigger는 terminal을 통해 동작한다. 등록된 terminal에 input을 주입하거나, 선언된 command를 실행한다. Agent API는 쓰지 않는다([terminal plan, 3.2](../plans/terminal-plan.md#32-event-path-decision-d3)).

Sidecar는 session의 `input`과 `paste` operation으로 input을 받는다([persistent services](persistent-services.md#destructive-command-guard)). 이 operation이 전달하는 제출된 각 줄은 destructive command guard가 판단한다. 선언된 규칙이 일치하거나 command를 판단할 수 없는 줄은 error `guardRefused`로 거부되며, session에 byte를 쓰지 않는다([persistent services](persistent-services.md#destructive-command-guard)). 주입된 message도 이 guard가 판단한다([settled](messaging.md#settled-decisions)).

Message의 input 안 형식은 열려 있다([open decisions](messaging.md#open-decisions), 항목 1). Agent가 foreground TUI에서 작업 중인 terminal은 TUI adapter의 background 또는 send-now action을 통해서만 input을 받는다([terminal plan, 4.1](../plans/terminal-plan.md#41-tui-key-adapters-decision-d6)). Agent마다 둘 중 어느 것을 쓰는지는 보류 상태다([open decisions](messaging.md#open-decisions), 항목 2).

## MCP tools

sok MCP server는 고정된 tool 집합을 노출하며, exposure로 tool을 만들지 않는다([cli](cli.md#mcp-server), tool table의 규칙). Messaging tool은 `messages_read`와 `messages_wait`다. 각 tool은 같은 점 표기 이름의 sidecar operation `messages.read`, `messages.wait`를 호출한다.

| Tool | Arguments | Reply |
| --- | --- | --- |
| `messages_read` | `{terminal, after, registration}`; `after`는 선택이며 기본값은 0; `registration`은 선택이며 `after`가 0보다 크면 필수다([재시작 뒤 cursor](messaging.md#cursor-across-restart)) | `{registration, messages: [{seq, path, text, from}], last}`. `registration`은 surface의 현재 registration이며 cursor의 epoch다. `last`는 reply를 만들 때 registration의 가장 큰 `seq`이며, 호출자는 이를 그 `registration`과 함께 다음 `after`로 넘긴다. 알 수 없는 terminal은 `unknown-terminal`로, 현재가 아닌 `registration`은 `epoch-changed`로, sender가 없는 message는 `invalid-sender`로 실패한다. |
| `messages_wait` | `{terminal, after, registration}`; `after`와 `registration`은 `messages_read`와 같다 | 도착하면 `messages_read`와 같은 형태이며 같은 error를 낸다. 이 call은 시간 제한과 timer가 없다. 도착, 호출자의 취소, 또는 그 folder의 registration이 닫힐 때 끝난다. Registration이 닫히면 닫힌 이유와 함께 `registration-closed`로 실패한다. 알 수 없는 terminal은 `unknown-terminal`로 실패한다. |

Wait는 도착하거나 registration을 닫는 event가 올 때 끝난다. Wait는 event를 기다리는 것이며, [AGENTS](../../AGENTS.md#implementation)는 event source가 없을 때만 timer를 허용하므로 timer로 끝내지 않는다. 취소된 call은 status watch와 같이 결과 없이 끝난다([cli](cli.md#mcp-server)).

[cli](cli.md#mcp-server)의 표에 있는 모든 tool은 밑줄 이름을 가진다. 예를 들어 `windows_list`, `status_get`이 그렇다. Messaging tool도 같은 형식을 따른다([settled](messaging.md#settled-decisions)).

실패하거나 거부된 call은 명시적 error를 돌려주며, 빈 결과로 보고하지 않는다. 모든 error는 보고되어야 하기 때문이다([AGENTS](../../AGENTS.md#implementation)). 실패한 tool call은 [cli](cli.md#mcp-server)가 다른 tool에 정의한 대로 tool error를 돌려준다.

Agent는 그 client가 MCP tool을 지원하는 곳에서만 MCP tool을 쓴다([terminal plan, 3.3](../plans/terminal-plan.md#33-delivery-channel-to-the-agent-decision-d4)). MCP tool을 받는 agent는 Claude Code와 Codex이며, `sok mcp install`이 등록하는 두 agent다. Test가 이 집합을 그 등록과 대조한다([wire 결정](messaging.md#wire-decisions), 항목 15).

## 공유 case

`docs/spec/cases/messaging/names.json`은 [message](messaging.md#message)의 이름 규칙의 case를 담는다: 각 case는 folder 바로 안의 파일 이름과 그 결과를 가진다. 결과는 message가 아닌 이름에는 `ignored`, `from`이나 `token`을 주지 않는 `.txt` 이름에는 `invalid-sender`, message에는 그 `from`이다. 각 terminal sidecar는 그 파일을 자기 fixture로 복사하고 각 case를 자기 이름 규칙으로 실행하며, 그 contract test는 이 문서의 동작을 실제 folder와 파일로 실행한다.

## Wire decisions

각 결정은 terminal sidecar들의 기존 wire를 따르며, 출처는 sidecar `alacritty`의 `main` branch다. sidecar `vt`는 `vt-core/src/protocol.rs`, `vt-core/src/pty.rs`, `vt-core/src/platform/darwin/file_watch.rs`에 같은 wire를 가진다. `protocol.rs`는 `alacritty-core/src/protocol.rs`, `pty.rs`는 `alacritty-core/src/pty.rs`, `file_watch.rs`는 `alacritty-core/src/platform/darwin/file_watch.rs`다. 각 결정은 한 문장이며, 이유와 출처가 뒤따른다.

1. **Event 이름.** Sidecar event는 `body`의 member `event`에 점 표기 이름으로 자신을 밝힌다. 따라서 file event는 `{surface, body: {event: "file.changed", registration, path, from, kind, seq}}`다. 이유: host는 `body`를 읽지 않고 전달하며([sidecars](sidecars.md#messages)), 기존 wire event는 모두 이렇게 이름을 밝힌다. 출처: `protocol.rs:3630`(`session`), `protocol.rs:3469`(`clipboard.store`), `protocol.rs:4923`(`screen.rows`) 카탈로그와 log 형식은 접두사를 유지하고(`events.json:162`, `sidecar.alacritty.shell.state`), wire는 짧은 이름을 쓴다(`protocol.rs:2225`, `selection.copy`).
2. **Operation parameter.** Request는 `body`의 member `operation`에 점 표기 operation 이름 `messages.register`, `messages.read`, `messages.wait`를 밝히며, 각 parameter는 `operation` 옆의 `body` member다. Registration은 `folder`, read와 wait는 `after`와 `registration`을 쓴다. Terminal은 envelope member `surface`이므로 tool 인자 `terminal`은 `surface`로 보낸다. 절대 경로가 아닌 `folder`는 `invalidParams`로 실패한다. 이유: 기존 점 표기 operation `screen.read`와 `screen.watch`가 이 형식을 쓰고, envelope이 이미 surface를 담는다. 출처: `protocol.rs:5837`(`body.operation`으로 분기), `protocol.rs:6212`(`screen.watch`), `protocol.rs:6229`(`screen.read`), `protocol.rs:5867`(`open directory must be an absolute path`).
3. **Registration 형식.** Member `registration`은 string이며, folder를 등록할 때 sidecar가 만드는 version 4 UUID다. 이유: registration은 sidecar가 만들고 reply로 돌려주며 event에 이름으로 쓰는 식별자이므로, `sessionId` string과 같은 역할이다. `protocol.rs:155`의 `generation` 정수는 image attachment를 가리키며 sidecar가 소유한 객체가 아니므로 형식이 아니다. 출처: `pty.rs:365`(`Uuid::new_v4().to_string()`), `protocol.rs:3630`(`sessionId`).
4. **Error 필드.** 실패한 request는 `body: {error: <code>, reason: <text>}`로 답한다. `error`는 code(`folder-missing`, `not-a-directory`, `already-registered`, `unknown-terminal`, `message-too-large`, `invalid-text`, `invalid-sender`, `epoch-changed`)이고, `reason`은 실패한 folder 또는 path를 밝힌다. 이유: 기존 거부는 code를 `error`에, 원인을 `reason`에 담으며, reply error 문장은 둘을 모두 읽는다. 출처: `protocol.rs:6236`(`invalidParams`와 `reason`), `protocol.rs:4410`(`guardRefused`의 `rule`과 `reason`), `protocol.rs:84-96`(`reply_error`).
5. **Event reason 필드.** 닫힘 event는 원인을 `body`의 member `reason`에 담는다. 즉 `{event: "registration.closed", registration, reason: "folder-removed"}`다. 이유: `reason`은 기존 sidecar event가 원인을 담는 member다. 출처: `protocol.rs:3550`(`sequence.rejected`), `protocol.rs:3292`(`error`).
6. **상관 식별자.** Messages request는 envelope에 `cids` 식별자 하나를 담고, reply는 답이든 error든 그 `cids`를 되돌린다. File event는 request가 일으키지 않으므로 `cids`가 없다. 이유: 기존 request는 `cids`를 담고 각 reply가 이를 되돌리므로 `cids`가 기존 상관 형식이다. `messages.wait`의 reply는 같은 surface의 다른 line 뒤에 오므로 surface와 operation만으로는 식별되지 않는다. 출처: `protocol.rs:5497`(request envelope의 `cids`), `protocol.rs:111-117`(`Request::answer`가 각 reply에 `cids`를 쓴다), `protocol.rs:459-462`(`reply`가 `answer`를 호출한다).
7. **호출자 취소.** 호출자가 input을 닫으면 sidecar는 대기 중인 `messages.wait`를 reply 없이 끝낸다. 이유: 클라이언트가 취소한 call은 결과 없이 끝나며([cli](cli.md#mcp-server)의 status watch와 같다), 닫힌 input은 프로토콜이 관찰하는 취소다. 출처: `protocol.rs:5457-5471`(input의 끝은 persistent connection을 분리하고 reply를 쓰지 않는다), `cli.md` 229행.
8. **Session 요구.** `messages.register`, `messages.read`, `messages.wait`는 열린 session을 요구하지 않는다. `input`은 session이 없으면 거부된다. 이유: registration은 PTY session이 아니라 folder를 감시하므로, agent는 terminal을 열기 전에 등록할 수 있다. 출처: `protocol.rs:4913-4915`(`screen.watch`는 session 없이 reply한다), `protocol.rs:4396`(`input`의 `Session not open`).
9. **이미 등록됨.** Surface는 registration을 하나만 가진다. 따라서 다른 surface가 등록한 folder, 또는 registration을 가진 surface의 두 번째 folder의 요청은 `already-registered`로 실패한다. 이유: `messages.read`와 `messages.wait`는 `after`만 받으므로, folder가 둘인 surface는 read가 가리킬 folder가 없다. Sidecar는 한 key 아래 두 번째 항목을 명시적 error로 거부한다. 출처: `protocol.rs:757`(`session surface already exists`).
10. **반복 등록.** 같은 surface가 같은 folder로 `messages.register`를 반복하면 첫 번째와 같은 `{registration, folder}`를 돌려주고 새 registration을 만들지 않으므로 `seq`가 다시 시작하지 않는다. 이유: operation은 idempotent하며([AGENTS](../../AGENTS.md#implementation)), `sok` operation은 같은 식별자에 같은 결과를 돌려준다. 출처: `cli.md` 160행.
11. **64 KiB 경계.** 65536 byte message 파일은 받아들이고, 65537 byte 파일은 `message-too-large`로 거부한다. 이유: buffer는 명시적 상한이 필요하며([AGENTS](../../AGENTS.md#implementation)), 상한을 byte로 적어 거부가 정확하도록 한다. 출처: sidecar의 messaging 계약 test `alacritty-core/tests/serve_contract.rs`. 이 test는 `64 * 1024 + 1` byte를 쓰고 `message-too-large`를 기대한다. 65536 경계는 아직 test가 없다.
12. **하위 folder와 그 밖의 파일.** 하위 folder 파일이나 이름이 `.txt`로 끝나지 않는 바로 아래 파일의 변경은 event도 message도 만들지 않는다. 그런 파일은 message가 아니므로 거부하지 않고 무시한다. 이유: event는 message에만 있으므로 `seq`는 message를 세며 다른 파일을 세지 않는다. 출처: `file_watch.rs:44-46`(`Change`는 각 변경을 vnode `folder` 또는 `file`로 보고하므로, sidecar는 event를 보내기 전에 이름으로 거른다).
13. **Folder 이름 변경.** 등록된 folder의 이름 변경은 제거로 다룬다. Sidecar는 `reason: "folder-removed"`를 담은 `registration.closed`를 보낸다. 이유: 이름 변경 뒤 등록된 path는 folder를 가리키지 않으며, watch는 이름 변경을 folder vnode에서 보고한다. 출처: `file_watch.rs:25`(vnode event의 `NOTE_RENAME`), `file_watch.rs:141`(folder vnode가 그 event로 등록된다). darwin watch는 `NOTE_RENAME`을 file vnode에서만 교체로 다루며(`file_watch.rs:212-216`), folder 이름 변경은 아직 구현되지 않았다.
14. **MCP tool 계층.** `messages_read`와 `messages_wait`는 `packages/sok/go/src/agents/mcp.json`의 tool 목록에 고정된 항목이며, 입력 schema는 `{terminal, after, registration}`다. Exposure로 만들지 않는다. 이유: MCP tool 집합은 고정되어 있고 선언된 command마다 tool을 두지 않는다([cli](cli.md#mcp-server)). 출처: `cli.md` 126행과 292행, `packages/sok/go/src/agents/mcp.json`(`tools`).
15. **Agent의 MCP 지원.** MCP tool을 받는 agent는 Claude Code와 Codex다. `sok mcp install`이 MCP server를 `claude` command에, 그리고 `PATH`에 있으면 `codex` command에 등록하기 때문이다. 이유: terminal sidecar repository에는 agent catalog가 없고, `sidecar.json` manifest에는 agent를 이름으로 밝히는 member가 없다([sidecars](sidecars.md#declaration-and-startup)). 출처: `cli.md` 250-257행(MCP 등록), `sidecars.md` 14-22행(`sidecar.json` 필드).
16. **Sender.** Message의 sender는 파일 이름의 `from` 부분이며, 보내는 쪽 환경의 `SOKSAK_SURFACE`가 밝히는 surface다. `from`이 없는 `.txt` 파일은 `invalid-sender`로 거부한다. 이유: request는 envelope member `surface`로 자신의 surface를 밝히고, surface의 모든 process는 그 surface의 `SOKSAK_SURFACE`를 받으므로, surface 식별자는 wire가 이미 쓰는 식별자다. 이름이 그것을 담으므로 sidecar는 이미 거르는 이름에서 sender를 읽으며([항목 12](messaging.md#wire-decisions)), 파일을 열지 않는다. Text 안의 header 줄은 sender를 알기 전에 파일을 읽고 파싱해야 한다. 출처: `protocol.rs:127-130`(줄의 `surface` member), `file_watch.rs:44-46`(`Change`가 각 변경을 보고하므로 sidecar는 event를 보내기 전에 이름을 거른다), `sidecars.md`의 surface 프로세스 절(`SOKSAK_SURFACE`).
17. **Write rule.** Message는 `.txt`로 끝나는 이름으로 rename될 때 보이며, writer는 먼저 임시 이름으로 만든다. 이유: sidecar는 endpoint 파일을 임시 이름과 같은 folder 안의 rename으로 이미 게시하므로, 같은 형식이 wire의 고유 패턴이다. 출처: `alacritty-core/src/platform/darwin/service.rs:129`(임시 이름 `endpoint.json.<uuid>.tmp`), `service.rs:139`(`endpoint.json`으로의 `fs::rename`).
18. **Cursor epoch.** Registration이 read의 epoch다. Read와 wait는 `registration`을 받으며, 현재 surface의 registration이 아닌 `registration`의 read는 `epoch-changed`로 실패한다. 이유: registration마다 새 식별자가 있고, 새 sidecar process가 folder를 다시 등록하면 새 식별자가 만들어지므로, `seq`가 다시 시작할 때 식별자도 바뀐다. Folder의 message 수는 agent가 이미 읽은 message가 지워지면 cursor를 보존하지 못한다. 출처: `alacritty-core/src/pty.rs:365`(`Uuid::new_v4().to_string()`으로 새 식별자를 만든다), 항목 3.

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
- Message 형식: 등록된 folder의 `<from>.<token>.txt` 파일, UTF-8, 64 KiB 이하. 더 큰 파일은 `message-too-large`로 거부한다. 이유: text 파일은 terminal agent가 쓰기 가장 단순한 형식이며, 상한은 bounded buffer에 대한 [AGENTS](../../AGENTS.md#implementation)를 따른다.
- 소비: message는 소비되지 않는다. `messages_read`는 `after`와 `registration`을 받아 더 큰 `seq`의 message를 돌려주며, 같은 `after`로 반복 읽으면 같은 결과를 준다. 이유: [AGENTS](../../AGENTS.md#implementation)는 idempotent operation을 요구한다.
- 순서와 다시 쓴 파일: message는 `seq` 증가 순서로 전달된다. 다시 쓴 파일은 새 `seq`를 가진 새 file event이며, 이전 event의 대체가 아니다. 이유: [logging](logging.md#event)의 `seq` 규칙은 한 counter의 event를 정렬하며, 대체하면 [AGENTS](../../AGENTS.md#implementation)의 idempotent 요구를 깨뜨린다.
- 제거 또는 이름 변경된 folder: sidecar는 `reason: "folder-removed"`를 담은 `sidecar.<sidecar>.registration.closed`를 보내며, 다시 만든 folder는 watch를 재개하지 않는다. 이유: [AGENTS](../../AGENTS.md#implementation)는 event source가 있는 곳에서 polling을 금지하며, folder 제거는 watch가 받는 event다.
- 대기 call: `messages_wait`는 `{terminal, after, registration}`를 받고 시간 제한이 없다. 이유: wait는 도착, 호출자 취소, registration 종료 중 하나로 끝나는 event 대기이므로 timer가 필요 없다([AGENTS](../../AGENTS.md#implementation)). 대기 call의 시간 제한 항목은 이 결정으로 닫힌다.
- Event 이름과 gate level: `sidecar.<sidecar>.file.changed`는 `debug`, class `io`; `sidecar.<sidecar>.messages.registered`와 `sidecar.<sidecar>.registration.closed`는 `info`, class `lifecycle`이며, `<sidecar>`는 `alacritty` 또는 `vt`다. 이유: sidecar event는 sidecar prefix를 가진다([logging](logging.md#sidecar-catalogs)). `info`는 object lifetime의 변경이고 `debug`는 boundary 통과다([logging](logging.md#event)). Class는 [logging](logging.md#classes-and-policy)의 표를 따른다.
- Agent의 MCP 지원: agent 집합은 [wire 결정](messaging.md#wire-decisions) 항목 15에서 정한다. 근거는 `sok` command의 MCP 등록([cli](cli.md#mcp-registration))이다.
- Tool 이름: 두 MCP tool은 [cli](cli.md#mcp-server)의 모든 tool과 같이 밑줄로 이름 붙인다(`messages_read`, `messages_wait`). 이 문서의 tool table은 이 이름을 쓴다.
- Guard: 주입된 message는 입력된 줄과 같은 `input` operation으로 제출되므로, destructive command guard가 다른 제출 줄과 같이 판단한다([persistent services](persistent-services.md#destructive-command-guard)). 거부된 message는 `rule`과 `reason`을 담은 `guardRefused` reply를 받는다.
- Carrier: 주입된 message는 session의 `input` operation으로 terminal에 도달한다. 이 operation은 입력된 줄을 나르는 operation이다([persistent services](persistent-services.md#destructive-command-guard)). 그 operation의 parameter는 이 repository가 아니라 자신의 repository에서 terminal sidecar가 선언한다([AGENTS](../../AGENTS.md#structure)).
- Busy foreground TUI: busy foreground TUI로의 전달은 TUI adapter의 background 또는 send-now action을 요구한다. Plan은 둘 중 하나가 실행되기 전에는 그런 TUI가 message를 받지 않는다고 말한다([terminal plan, 4.1](../plans/terminal-plan.md#41-tui-key-adapters-decision-d6)).
