# 터미널 상태

[English](terminal-state.md)

이 문서는 terminal sidecar가 publish하고 terminal plugin이 보여 주는 터미널 상태를 정의한다. 두 터미널 쌍 모두에 적용된다: plugin `terminal`과 sidecar `vt`, plugin `term`과 sidecar `alacritty`. 각 sidecar와 각 plugin은 같은 contract를 구현하며, 각자 [cases](#공유-case)의 공유 case를 자기 구현에 대해 실행한다. 구현과 검증은 [features](../features.md)에서 추적한다.

## 상태

터미널 상태는 다음 이름 중 하나다. sidecar는 상태가 바뀔 때 그것을 event로 publish하며, 호출자는 상태를 polling하지 않는다([AGENTS](../../AGENTS.md#implementation)).

| 상태 | 의미 | source |
| --- | --- | --- |
| `idle` | shell이 prompt에 있다: 마지막 mark가 OSC 133의 prompt 시작 `A`, 명시적 prompt 시작 `P` 또는 prompt 끝 `B`다 | `osc133` |
| `running` | 명령이 실행 중이다: 마지막 mark가 명령 시작 `C`다 | `osc133` |
| `exited` | 명령이 끝났다: 마지막 mark가 명령 종료 mark `D`이며, 그 exit code를 함께 가진다 | `osc133` |

한 command로 실행되는 program이 그 안에서 하는 일은 mark의 상태가 아니다: program이 스스로 보고한다([program status](#program-status)).

shell이 OSC 133 mark를 보내지 않는 session에는 상태가 없다: sidecar는 출력에서 상태를 추론하지 않으며, 상태는 `null`로 남는다. 각 sidecar의 shell integration은 zsh와 bash에 대해 mark를 보낸다.

## Mark

sidecar는 session의 출력에서 OSC 133 mark를 읽는다(`ESC ] 133 ; <mark> [; <parameter>]… BEL` 또는 `ST`). mark `A`, `P`, `B`는 `idle`을, `C`는 `running`을, `D`는 `exited`를 준다. `P`는 prompt의 한 줄을 명시적으로 시작한다. 그 parameter `k`는 그 줄의 종류를 정한다: `i`는 prompt의 첫 줄이며 `k`가 없을 때의 종류이고, `c`나 `s`는 이어지는 줄, `r`은 오른쪽 prompt다. 다른 종류의 `P`는 잘못된 mark다. `D`의 첫 parameter는, 있고 `<name>=<value>` 형태의 named parameter가 아니면, 명령의 exit code다. 이것은 shell exit status의 범위인 0부터 255까지의 10진 정수다. 그 parameter가 없는 `D`는 exit code `null`인 `exited`를 준다. 첫 parameter가 named parameter도 아니고 0부터 255까지의 10진 정수도 아닌 `D`는 잘못된 mark다: engine은 다른 모든 잘못된 sequence처럼 `sequence.rejected`로 그것을 거부하며, 상태는 바뀌지 않는다.

mark는 현재 상태와 다른 상태를 줄 때만 상태를 바꾼다. `A` 뒤의 `B`처럼 반복된 mark는 변화를 주지 않는다.

## Prompt region

각 sidecar의 engine은 primary screen의 mark를 행의 사실로 유지하여, 크기 조정이 shell이 `SIGWINCH` 뒤 다시 그리는 prompt를 유지하게 한다. 크기 조정의 순서는 kitty의 순서다: engine은 reflow 전에 prompt를 reflow에서 빼고 reflow 뒤에 되돌려 놓는다.

- 기록된 행: `A`는 커서가 0열에 있지 않으면 먼저 커서를 다음 줄의 시작으로 옮기고, 기록된 모든 행을 지우고, 커서 행을 기록한다. 종류 `i`, `c`, `s`의 `P`는 커서 행을 기록하고, 종류 `r`의 `P`는 아무 행도 기록하지 않는다. `C`와 `D`는 기록된 모든 행을 지운다. 기록된 행은 절대 행이다: history 한도를 넘어 버려진 행 수, 더하기 history 행 수, 더하기 screen 행이다. 그래서 출력이 행을 history로 밀어 올리는 동안에도, history가 가장 오래된 행을 버리는 동안에도 행의 번호는 같다. prompt에서의 ED 2는 기록된 행을 맨 위 행으로 바꾼다. shell은 새 `A` 없이 그곳에 prompt를 다시 그리기 때문이다.
- Redraw: mark의 parameter `redraw`는 shell이 다시 그리는 region을 정한다: `1`은 prompt 전체, `last`는 커서가 있는 논리적 행만(readline은 prompt의 마지막 줄만 다시 그린다), `0`은 region 없음이다. `redraw` 없는 `A`는 `1`을 정하므로 각 `A`가 `redraw=0`을 끝낸다. `redraw` 없는 `P`와 `B`는 현재 값을 유지한다. 다른 값은 잘못된 mark다.
- Region: prompt에서(마지막 mark가 `A`, `P`, `B`) `redraw`가 `0`이 아니면, region은 커서 또는 그 위의 가장 가까운 기록된 행부터 screen의 맨 아래까지의 행이다. `redraw=last`이면 커서의 논리적 행의 첫 행이 기록된 행보다 아래에 있을 때 그 행에서 시작한다. `C`나 `D` 뒤, `redraw=0`, 기록된 행이 없을 때, alternate screen에서는 region이 없다.
- Region이 있는 크기 조정: engine은 region의 행을 복사한다. 그 행을 지워서, reflow가 region의 첫 행부터 커서 행까지 지운 각 행을 어떤 행도 잇지 않는 한 행으로 유지하고 커서 아래의 행을 빈 행으로 유지하게 한다. 커서를 0열로 옮긴다. screen과 history를 새 크기로 reflow한다. 그다음 크기 조정 전 region의 첫 행이 커서 위에 있던 만큼 커서 위에 있는 행부터 복사본을 새 폭에서 잘라 되돌려 놓는다. 잘림이 가르는 넓은 문자와 감싼 넓은 문자의 spacer는 빈 칸으로 남고, 되돌려 놓은 어떤 행도 다른 행을 잇지 않는다. region의 기록된 행은 자기 복사본과 함께 옮겨 간다. region 위의 기록된 행은 reflow가 그 행을 바꿨으므로 지운다. zsh와 readline은 자기가 커서 위에 그린 행 수만큼 커서를 올리고 그곳부터 다시 그린다. 그곳은 되돌려 놓은 첫 행이므로, shell이 다시 그리기 전에 표시되는 화면은 빈 행 대신 이전 폭의 prompt를 보이고, shell은 그 위에 쓴다.
- Region이 없는 크기 조정: engine은 reflow만 하고 아무것도 지우지 않으며, 기록된 모든 행을 지운다.
- 오류: 가장 가까운 기록된 행이 screen 위에, 즉 history에 있거나 그 너머로 버려졌으면, engine은 screen 행과 함께 `terminal resize: the prompt start row <row> lies above the screen`을 보고하고 region 없이 크기를 바꾼다. 기록된 행이 있지만 어느 것도 커서 또는 그 위에 없으면 `terminal resize: no prompt row is recorded at or above the cursor row`를 보고하고 region 없이 크기를 바꾼다. screen의 행 수가 region보다 적어 reflow 뒤 region의 첫 행이 screen 위에 있으면, 복사본은 맨 위 행부터 선다. shell은 그 위로 올라갈 수 없어 그곳부터 그리기 때문이다. 그리고 engine은 `terminal resize: the prompt region starts at the screen row <row> after the reflow, above the screen`을 보고한다.
- 현재 크기로의 크기 조정은 아무것도 바꾸지 않는다. PTY가 그때 `SIGWINCH`를 보내지 않기 때문이다. engine은 크기 조정도, 그 뒤의 `SIGWINCH`도 늦추지 않는다.

각 sidecar의 shell integration은 region이 필요로 하는 mark를 보낸다: zsh는 `precmd` hook에서 `A`를 보내고 `PS1`의 시작에 `P;k=i`, 끝에 `B`를, `PS2`의 시작에 `P;k=s`, 끝에 `B`를 더하므로, zsh가 다시 그리는 각 prompt가 자기 행을 기록한다. bash는 각 prompt 앞에 `A;redraw=last`를 보내고 `PS1`의 각 줄바꿈 뒤에 `P;k=s`를 더하므로, region은 readline이 다시 그리는 prompt의 마지막 줄이다.

## 변화 event

상태의 각 변화는 sidecar의 surface event 하나 `{event: "shell.state", from, to, source, sequence, exit}`다:

- `from`은 변화 전의 상태이며, session의 첫 변화에서는 `null`이다.
- `to`는 새 상태다.
- `source`는 상태를 정한 signal이다. mark에서는 `osc133`이다.
- `sequence`는 session에서 그 변화의 번호다: 첫 변화는 1이고, 이후 변화마다 하나씩 커진다. surface의 새 session은 다시 1에서 시작한다.
- `exit`는 `exited`의 exit code로, 정수이거나 mark가 주지 않았으면 `null`이다. 다른 모든 상태에서는 `null`이다.

sidecar는 각 변화를 자기 event log에도 `sidecar.<sidecar>.shell.state`(`sidecar.vt.shell.state`, `sidecar.alacritty.shell.state`)로 class `lifecycle`의 level `info`에 member `from`, `to`, `source`, `sequence`, `exit`와 함께 쓴다. sidecar는 surface의 image region이 그리지 않는 동안에도 모든 출력의 mark를 따르므로 상태는 최신으로 유지된다. surface event는 surface의 다른 vendor event와 같은 규칙으로 보낸다.

## 상태 읽기

operation `shell.state.read`는 surface의 session의 현재 상태를 돌려준다. 그 답은 surface event `{event: "shell.state.current", state, source, sequence, exit}`다: `state`는 현재 상태이거나 첫 변화 전에는 `null`이고, `source`는 그 상태의 source이거나 `null`이며, `sequence`는 마지막 변화의 `sequence`이거나 첫 변화 전에는 0이고, `exit`는 변화 event와 같다. 답은 요청의 `cids`를 되돌려준다. 열린 session 없이 한 읽기는 sidecar가 session 없이 받은 모든 session operation에 돌려주는 error로 실패하며, 상태를 돌려주지 않는다. 읽기는 아무것도 바꾸지 않으므로, 반복된 읽기는 다음 변화 전까지 같은 답을 돌려준다([AGENTS](../../AGENTS.md#implementation)).

page는 session을 열거나 session에 attach한 뒤 상태를 읽는다. persistent session은 어떤 page도 그것을 보여 주지 않는 동안에도 자기 상태를 유지하기 때문이다([persistent services](persistent-services.md)). 그 뒤 page는 변화 event를 따른다. surface는 image region이 없는 동안 event를 보내지 않으므로, page는 region이 없던 때 뒤에 surface의 image region을 설정할 때마다, 그리고 변화 event의 `sequence`가 자기가 지닌 값보다 하나 큰 값이 아닐 때 상태를 다시 읽는다. `sequence`가 자기가 지닌 값보다 작은 답은 sidecar의 오류다. 답과 event는 하나의 순서 있는 channel을 함께 쓰기 때문이며, page는 그것을 session의 오류 경로로 보고하고 자기 값을 지닌다. surface의 답과 event는 하나의 순서 있는 channel로 도착하므로, page는 각각을 도착 순서대로 적용한다.

## Plugin status

각 terminal plugin은 각 terminal surface에 status `<plugin>.state`(`terminal.state`, `term.state`)를 선언한다. 그 값은 [상태 읽기](#상태-읽기)의 의미를 가진 `{state, source, sequence, exit}`다: 첫 읽기의 답 전에는 `{state: null, source: null, sequence: 0, exit: null}`, 그다음 읽기의 답, 그 뒤 각 변화 event의 member `to`, `source`, `sequence`, `exit`다. 이 형태가 아닌 변화 event나 읽기 답은 sidecar error다: page는 그것을 session의 error 경로로 보고하고 이전 값을 유지한다. surface의 새 session은 첫 읽기 전의 값에서 다시 시작한다.

## Program status

agent, build, package manager처럼 한 command로 실행되는 program은 실행되는 동안 내내 mark의 상태를 `running`에 둔다. 그 command 안에서 program이 하는 일, 곧 일하는지, 자기 prompt에서 쉬는지, 승인이나 답을 기다리는지, 실패했는지는 program만 알므로, terminal은 그것을 program이 보고하는 것에서만 가져온다: sidecar는 session의 출력과 사람의 입력에서 선언된 신호 두 가지를 읽고, 화면, 제목, 출력이나 그 정적에서 아무것도 짐작하지 않는다.

- **Report**: Program Status Protocol(OSC 7501, 2026-10-10의 revision 0.4, `https://www.superlogical.com/rex/docs/build/program-status`), `ESC ] 7501 ; <key>=<value>[:<key>=<value>]… BEL` 또는 `ST`. sidecar는 protocol이 정의하는 대로 session의 record를 지닌다([records](#records)).
- **Notice**: program의 notification. progress report `9;4`가 아닌 OSC 9 `ESC ] 9 ; <message>`, OSC 777 `ESC ] 777 ; notify ; <title> ; <body>`, 또는 control string 밖의 BEL byte다(OSC sequence를 끝내는 BEL은 그 terminator다). notice는 program이 사람을 불렀다고 알린다. program의 상태를 말하지 않고, program이 보고하는 끝도 없다([notice](#notice)).

두 신호 중 어느 것도 보내지 않는 program을 terminal은 알 수 없다: 그 terminal의 activity는 program이 실행되는 동안 `running`에 머물며, 그 level은 program이 일한다는 것이 아니라 command가 실행된다는 것만 말한다. program이 하는 일을 말하는 것이 없기 때문이다. shell이 OSC 133 mark를 보내지 않는 session에서는 어떤 mark도 record를 끝내지 않으므로, program이 남긴 `working`이나 `blocked` record는 `clear`, full reset, session의 끝에서만 끝난다.

### Records

각 sidecar의 engine이 각 report를 해석하고, session의 tracker(각 sidecar core의 `program_status.rs`)가 record를 지닌다:

- 문법: pair는 `:`로 나뉘고, pair는 첫 `=`에서 key와 value로 나뉜다. key는 16 byte 이하의 `[a-z]+`, value는 `[A-Za-z0-9_.,+/=-]*`이며, key와 value 둘레의 공백은 지운다. 다른 형식의 pair는 잘못된 pair다: engine은 그것을 `sequence.rejected`로 보고하고 report의 나머지를 적용한다. protocol이 정의하지 않는 key는 보고 없이 무시한다. 나중 revision이 key를 더할 수 있도록 protocol이 그렇게 요구하기 때문이다. 되풀이된 key는 마지막 value를 지닌다.
- `state`는 `idle`, `working`, `blocked`, `done`, `error`, `clear` 중 하나다. `state`가 없거나 다른 값인 report는 통째로 거부한다. `kind`는 `permission`, `question`, `auth` 중 하나이고 `blocked`와 함께일 때만 지닌다. `progress`는 0부터 100까지의 값을 나타내는 한 자리에서 세 자리의 ASCII 숫자이고 `working`과 `blocked`와 함께일 때만 지닌다. `app`은 `[A-Za-z0-9_.+-]{1,32}`다. 잘못된 `kind`, `progress`, `app`, 그리고 그것을 받지 않는 상태와 함께인 `kind`나 `progress`는 `sequence.rejected`로 보고하고, protocol이 정하는 대로 없는 것으로 다룬다. `title`과 `msg`는 padding이 선택인 표준 base64이며, 제어 문자 U+0000부터 U+001F, U+007F, U+0080부터 U+009F가 없는 UTF-8 text를 담는다. 빈 value는 빈 text다.
- 한계: `ESC`부터 terminator까지 4096 byte를 넘는 sequence, encode해서 2732 byte나 decode해서 2048 byte를 넘는 `msg`, encode해서 256 byte나 decode해서 192 byte를 넘는 `title`, decode되지 않는 base64, UTF-8이 아니거나 제어 문자를 담은 decode된 text, 그리고 비었거나 `[A-Za-z0-9_.+-]`의 1에서 32 byte인 segment 하나에서 여덟 개를 `/`로 이어 128 byte 안에 든 것이 아닌 `id`는 report를 통째로 거부한다: engine은 이유와 함께 `sequence.rejected`를 보고하고 그 report에서 아무것도 적용하지 않는다.
- `id`는 record를 가리킨다. `id`가 없는 report는 root record를 가리킨다. 각 report는 그 record를 통째로 바꾸고, record가 바뀌지 않을 때도 그것을 가장 최근에 갱신된 record로 만든다. `state`가 `clear`인 report는 record를 만들지 않고 `id` 말고 다른 key를 받지 않으며, 그 안의 protocol의 다른 key는 `sequence.rejected`로 보고하고 없는 것으로 다루므로, 한계가 report를 통째로 거부하지 않는 한 clear는 그래도 적용된다: 그것은 가리키는 record와 그 아래의 모든 record를 지우고(`build`는 `build/test`를 담는다), `id` 없이는 모든 record를 지운다. `app`이 없는 record는 각 event 때 있는 record 가운데 가장 가까운 조상의 `app`을 가지며, root record는 `id`를 가진 모든 record의 조상이다.
- tracker는 session의 record를 256개까지 지니며, protocol이 그 한계에 대해 정하는 대로 report가 하나를 더할 때 가장 오래전에 갱신된 record를 지운다. 그 제거는 지운 `id`를 가진 `warn` log event `sidecar.<sidecar>.program.status.evicted`이고, 변화 event가 그것을 보여 준다.
- query `ESC ] 7501 ; ? <terminator>`에는 query의 terminator를 붙인 `ESC ] 7501 ; ? <terminator>`로 답한다. 이것은 protocol이 terminal에게 되써도 된다고 허락하는 유일한 byte이며, record를 바꾸지 않는다. 답은 `states`와 `kinds`를 나열하지 않는다. terminal이 protocol의 기본값을 그대로 읽기 때문이다. 이 답을 받은 뒤에만 보고하는 program은 그 답 덕분에 이 terminal에 보고한다.
- record의 끝: command 종료 mark `D`와 prompt 시작 mark(`A`, 또는 kind `i`의 `P`)는 `working`, `blocked`, `idle` record를 지운다. program의 command가 끝났고 shell은 그 뒤에야 prompt를 그리기 때문이다. protocol은 process가 끝날 때와 새 prompt에서 앞의 두 가지를 요구하고 세 번째를 허락한다. command 시작 mark `C`는 `done`과 `error` record를 지운다. 사람이 결과 뒤에 이 terminal에서 다른 command를 시작했기 때문이다. protocol은 그것들을 끝과 prompt 뒤에도 지니게 하고 언제 보여 주기를 멈출지는 terminal에 맡긴다. full reset(RIS, `ESC c`)은 모든 record를 지우고 soft reset은 지우지 않는다. session의 끝은 모든 record와 notice를 지우며, 그 변화 event는 session의 exit event보다 먼저 보낸다. surface의 새 session은 record 없이 시작한다.

### Notice

tracker는 session의 notice 하나를 `true`나 `false`로 지닌다:

- surface가 keyboard focus를 갖지 않은 동안 OSC 9 notification, OSC 777 `notify`, BEL이 오면 `true`가 된다. focus는 surface의 image region의 keyboard focus이며, page는 그것을 자기 input의 `focus` action으로 보고하고 session이 열리거나 attach될 때마다 다시 보낸다. region이 없는 surface에는 focus가 없다. surface가 focus를 가진 동안의 notice는 아무것도 바꾸지 않는다. 사람이 terminal에 있기 때문이며, 그래서 사람이 줄을 편집하는 동안 bell을 울리는 shell은 notice를 주지 않는다.
- surface가 keyboard focus를 얻을 때, 사람이 거기에 입력할 때, 곧 text, key, command action을 가진 region의 input transaction이 올 때(command action은 `insertNewline:`처럼 사람의 key가 주는 text system의 편집 command다), command 종료 mark `D`와 prompt 시작 mark(`A`, 또는 kind `i`의 `P`)에서(부른 program이 끝났기 때문이다), full reset에서, 그리고 session이 끝날 때 `false`가 된다. paste operation, menu의 action, 그리고 region의 input transaction에서 오지 않은 다른 쓰기는 그것을 그대로 둔다. 그런 쓰기는 사람이 terminal을 본 것이 아니기 때문이다.
- region은 그 창이 key window가 아닌 동안에도 가진 focus를 지니므로, region이 focus를 가진 동안 다른 application 뒤에 있는 창의 program은 notice를 주지 않는다. 이 한계는 region의 focus가 창의 key 상태를 따를 때까지 남으며, [features](../features.md)가 그것을 추적한다.

첫 field가 `4`인 OSC 9는 ConEmu의 progress report `ESC ] 9 ; 4 ; <state> [; <progress>]`이며 다른 terminal과 program도 쓴다. 이것은 notification이 아니다. engine은 그것을 event `progress` `{state, progress}`로 준다. `state`는 0부터 4까지의 한 자리 숫자이고 `progress`는 0부터 100까지의 값을 나타내는 한 자리에서 세 자리 숫자이거나 `null`이다. terminal은 그것에서 상태를 가져오지 않으므로 그것은 record도 notice도 바꾸지 않는다: progress report에는 기다림을 나타내는 상태도 program이 끝날 때의 끝도 없고, record의 protocol은 terminal이 OSC 7501 report를 받은 뒤에는 OSC 9;4를 반영하기를 멈추어야 한다(SHOULD)고 하며, progress를 보고하는 command는 mark로 이미 `running`이다. page는 마지막 notification을 `vendor.notification`에 지니듯 마지막 progress report를 `<plugin>.session`의 `vendor.progress`에 `{state, progress}`로, 첫 report 전에는 `null`로 지닌다. 그 밖의 형식은 `sequence.rejected`로 거부하며 notice가 아니다. 첫 field가 `notify`가 아닌 OSC 777과 OSC 99는 읽지 않는다: 그것들은 `sequence.rejected`를 주는 지원하지 않는 selector로 남는다. program은 이름이나 답으로 kitty나 foot라고 알아본 terminal에만 OSC 99를 보내며, 이 terminal은 어느 쪽이라고도 하지 않는다.

### Program status event

record나 notice의 각 변화는 surface event 하나 `{event: "program.status", records, notice, sequence}`다:

- `records`는 record를 나열한다. root record가 먼저이고, 그다음 `id`의 code point 순서이며, 각각 `{id, state, kind, progress, app, title, msg}`다: root record의 `id`는 `null`이고, `app`은 보고된 값이나 물려받은 값이며, `title`과 `msg`는 decode된 text이고, 없는 member는 `null`이다.
- `notice`는 notice다.
- `sequence`는 session에서 변화의 번호이며 첫 변화가 1이다. 새 session은 다시 1에서 시작한다.

record를 그대로 두는 report와 notice를 그대로 두는 notice는 event를 주지 않는다. sidecar는 surface의 event를 그 원인을 적용한 순서대로, 출력의 byte든 page의 input이든 똑같이, surface의 하나뿐인 순서 있는 channel로 보내므로, 한 출력의 `shell.state`와 `program.status`는 그 byte의 순서대로 온다. sidecar는 각 변화를 자기 event log에 class `lifecycle`의 `info` `sidecar.<sidecar>.program.status`로 쓰며, `sequence`, `notice`, 그리고 `{id, state, kind, app}`인 `records`를 담고 `title`과 `msg`는 담지 않는다. program이 승인을 묻는 command를 거기에 쓸 수 있기 때문이다. tracker는 surface가 그리지 않는 동안에도 모든 출력을 따른다.

operation `program.status.read`는 `{event: "program.status.current", records, notice, sequence}`를 돌려준다. 첫 변화 전에는 `sequence`가 0이고 record가 없다. 그것은 요청의 `cids`를 되돌려 주고, 아무것도 바꾸지 않으며, 열린 session이 없으면 `shell.state.read`처럼 실패한다. page는 [상태 읽기](#상태-읽기)의 규칙으로 그것을 읽고 그 event를 따른다: session을 열거나 attach한 뒤, image region이 없던 때 뒤에, `sequence`의 빈틈에서 읽고, 답의 더 작은 `sequence`는 sidecar의 오류다.

### 실행 중인 terminal의 상태

record와 notice는 command가 실행 중인 terminal의 상태를 program의 종류마다 이렇게 준다:

| program이 보고하는 것 | program |
| --- | --- |
| `working` record | 일한다 |
| `idle`이나 `done` record가 있고 `working`, `blocked`, `error` record가 없다 | 자기 prompt에서 쉬며 다음 지시를 기다린다 |
| `blocked` record | permission prompt처럼 사람의 승인이나 답을 기다린다. 그 record에 다른 상태를 보고할 때까지 기다린다 |
| `error` record | 실패했다 |
| record가 없고 notice가 있다 | 사람을 불렀다. 아직 기다리는지는 보고되지 않는다 |
| record도 notice도 없다 | 알 수 없다: terminal은 command가 실행된다는 것만 안다 |

program이 답을 기다린다는 것과 얼마나 기다리는지는 `blocked` record만 말한다. notice는 program이 한 번 불렀다는 것을 말한다: program이 아직 기다리든 아니든, 사람이 terminal을 보거나 거기에 입력하면 끝난다. record가 없는 실행 중인 command는 아무것도 보고하지 않는 program이며, `<plugin>.program`은 그것을 record 없이 보여 준다. activity `running`만으로는 그것과 일하는 program을 구별하지 못한다. terminal에 쓰는 operation처럼 실수로 prompt에 답하면 안 되는 consumer는 activity만이 아니라 `<plugin>.program`과 `<plugin>.state`를 읽는다: `blocked` record는 기다림이고, notice는 부름이며, record가 없는 실행 중인 command는 기다리는지 알 수 없는 program이다. 답을 기다리는 것이 없는 때는 정확히 `blocked`인 record가 없고, session에 record가 있거나 notice가 `false`이고 `state`가 `idle`이나 `exited`인 동안이다. record가 없는 program의 notice는 program이 turn이 끝나서 불렀을 때도 `attention`을 준다. notice는 program이 왜 불렀는지 말하지 않기 때문이다.

## Plugin program status

각 terminal plugin은 각 terminal surface에 status `<plugin>.program`(`terminal.program`, `term.program`)을 선언한다. 그 값은 [program status event](#program-status-event)의 의미를 가진 `{records, notice, sequence}`다: 첫 읽기의 답 전에는 `{records: [], notice: false, sequence: 0}`, 그다음 읽기의 답, 그다음 각 변화 event다. 이 형식이 아닌 event는 sidecar의 오류다: page는 그것을 session의 오류 경로로 보고하고 이전 값을 지닌다. surface의 새 session은 다시 첫 읽기 전의 값에서 시작한다.

## Activity

각 terminal plugin은 각 terminal surface에 status `<plugin>.activity`(`terminal.activity`, `term.activity`)도 선언하며, core가 tab, 그 card, space, project의 activity를 모으도록 `activity: true`로 core에 선언한다(core F982). 그 값은 core activity level이거나 activity가 없음을 뜻하는 `null`이다. plugin이 상태, exit code, program status를 알기 때문에 level은 plugin이 정하고, core는 level을 모으기만 한다. 값은 `<plugin>.state`와 `<plugin>.program`의 각 값을 이 순서로 따른다:

1. session에 record가 있으면, core 순서(`attention` > `failed` > `running` > `idle`)에서 그 record들의 가장 높은 level. 자기 상태를 보고하는 program은 사람을 부른 뒤에도 아직 기다리는지를 말하기 때문이다:

   | record `state` | level |
   | --- | --- |
   | `blocked` | `attention` |
   | `error` | `failed` |
   | `working` | `running` |
   | `idle`, `done` | `idle` |

2. 그렇지 않으면 notice가 `attention`을 준다.
3. 그렇지 않으면 mark의 상태:

   | `<plugin>.state`의 `state` | `<plugin>.activity` |
   | --- | --- |
   | 첫 변화 전의 `null` | `null` |
   | `idle` | `idle` |
   | `running` | `running` |
   | 0이 아닌 `exit`를 가진 `exited` | `failed` |
   | `exit` 0 또는 `exit` `null`을 가진 `exited` | `null` |

mark가 exit code를 주지 않은 `exited` 상태는 실패를 보고하지 않는다. 실패를 보여 주는 code가 없기 때문이다. program의 record는 그 command의 exit code보다도 앞선다: `done`을 보고했고 command가 0이 아닌 code로 끝난 program은 다음 command가 시작할 때까지 `idle`을 주고, `error`를 보고한 program은 `failed`를 준다. `error` record는 가장 높은 level이 정하므로 `working` record 옆에서도 `failed`를 준다. status는 값이 바뀔 때만 바뀌며, surface의 새 session은 다시 `null`에서 시작한다.

`attention`은 정확히 session에 `blocked` record가 있는 동안, 또는 record가 없고 notice가 `true`인 동안 유지된다. 그래서 `blocked` record의 report와 record가 없는 session의 notice에서 들어가고, program이 마지막 `blocked` record를 바꾸거나 지울 때, 그 record와 notice를 끝내는 command 종료 mark와 prompt 시작 mark에서, full reset에서, session이 끝날 때, 그리고 notice라면 사람이 terminal에 focus를 주거나 입력할 때 나온다. record의 report는 notice를 바꾸지 않는다: record가 있는 session은 notice에서 `attention`을 얻지 않으며, notice가 `true`인 동안 record가 지워지면 `attention`이 돌아온다. record의 `failed`는 program이 그 record를 바꾸거나 지울 때, command가 시작할 때, full reset에서, session이 끝날 때 나온다.

### 결정

이 규칙은 실행 중인 program의 상태를 program이 선언하는 신호, 곧 OSC 7501의 record와 notification에서만 가져온다. OSC 7501은 program이 아니라 sequence로 정의된다: terminal(kitty, libghostty-vt의 parser, tuios, xterm.js의 addon)이 그것을 읽고, 여러 종류의 program(Codex CLI, opencode, Crush, omp 같은 agent, query의 답을 받은 뒤의 Claude Code, 그리고 bubbletea, Symfony, Composer, Pulumi 같은 library와 tool)이 그것을 쓰므로, 그것을 읽는 일은 어떤 program도 읽지 않는다. notification은 turn이 끝날 때 bell을 울리는 program처럼 record를 쓰지 않는 program의 대체 신호다. 다음 후보는 각각 한 program에서 짐작하므로 거부했다: 한 window 동안의 출력 정적과 prompt를 보여 주는 화면은 timer인 고정 window와 program을 가리키는 prompt pattern이 필요하다. 제목이나 화면의 spinner는 한 program의 그림이다. agent의 hook event는 그 agent의 설정과 agent에서 terminal로 가는 경로가 필요하고, 그 event는 agent마다 다르다. core level은 새 level 없이 이 상태들을 나타낸다: 자기 prompt에 있는 program은 일하지 않고 대기 중인 승인이나 답이 없으며, 그것이 `idle`이다.

adversarial review는 다섯 round에 걸쳐 다음 반론을 냈고, 각 반론을 그 근거로 판정했다:

- *record 옆의 notice는 사람이 자리를 비운 동안 program이 끝낸 각 turn 뒤에 `attention`을 주므로, prompt에 있는 program이 기다림을 보이고 terminal에 쓰는 operation이 멈춘다.* 받아들인다: record가 notice보다 앞선다. 자기 상태를 보고하는 program은 부른 뒤에도 기다리는지를 말하기 때문이다. notice는 record가 없는 session에서만 정한다.
- *focus나 입력에서 끝나는 notice는 아직 보이는 prompt에 대해 `attention`을 믿을 수 없게 만든다.* 한계로 받아들이고 적는다: 기다림을 말하는 것은 `blocked` record뿐이며, prompt에 답하면 안 되는 consumer는 `<plugin>.program`과 `<plugin>.state`를 읽는다([실행 중인 terminal의 상태](#실행-중인-terminal의-상태)). notice에는 program이 보고하는 끝이 없으며, 사람의 주의에서 그것을 끝내는 것은 kitty(focus에서 `clear_needs_attention`), tmux(창을 고를 때 `winlink_clear_flags`), iTerm2(session에 key를 보낼 때 bell이 끝남), Ghostty(focus나 key에서 bell 제목이 끝남)의 규칙이다.
- *shell prompt의 bell은 아무것도 기다리지 않으므로 `attention`을 주면 안 된다.* 거부한다: 사람이 자리를 비운 동안의 bell은 부름이며 kitty, tmux, Ghostty도 같은 식으로 표시한다. 사람이 줄을 편집하는 동안의 bell은 terminal이 focus를 가지므로 notice를 주지 않는다.
- *record를 쓰지 않는 program의 notice는 끝난 turn에 대해서도 `attention`을 주므로, prompt에서 쉬는 program이 기다림을 보인다.* 한계로 받아들이고 적는다: notification은 program이 왜 불렀는지 말하지 않으므로 terminal은 부름을 보여 준다. 쉬고 있음을 말하는 program은 record를 쓴다. notice를 실행 중인 command로 제한하면 prompt 뒤에서 끝나는 job의 bell을 숨긴다.
- *부른 program보다 오래 남는 notice는 다음 shell prompt에서 `attention`을 준다.* 받아들인다: 부른 program이 끝났으므로 command 종료 mark와 prompt 시작 mark가 notice를 끝낸다.
- *사람의 key가 시작하는 paste는 terminal에 있는 사람인데 notice를 그대로 둔다.* 거부한다: 사람의 paste는 region이 focus를 가진 동안에만 region에 이르고, 그 focus가 이미 notice를 끝냈다. focus 없이 오는 것은 다른 operation이 보내는 paste뿐이다.
- *`sequence`가 더 작은 상태 읽기의 reply를 조용히 버리면 안 되고, `shell.state`도 `program.status`처럼 image region이 없으면 event를 잃는다.* 받아들인다: 그런 reply는 sidecar의 오류로 보고하고, page는 빈틈에서와 image region이 없던 때 뒤에 둘 다 다시 읽는다([상태 읽기](#상태-읽기)).
- *기다리는 것이 없다는 조건은 notice보다 record가 앞선다는 순서를 따라야 하고, root record는 `app`의 조상이어야 한다.* 받아들이고 적는다.
- *record의 report가 끝내는 notice는 record가 없고 notice가 `true`인 동안 정확히 `attention`이 유지된다는 규칙과 어긋나고, 다른 key를 가진 clear는 모호하다.* 받아들인다: record의 report는 notice를 그대로 두고, clear는 다른 key 없이 적용된다.
- *record가 온 뒤에는 engine이 `progress` event를 주지 않아야 한다.* 거부한다: 그 event는 program의 report를 page에 전하고 page는 그것을 `<plugin>.session`의 `vendor.progress`에 지니며, terminal은 어느 경우에도 그것에서 상태를 가져오지 않는다. protocol은 terminal에게 OSC 9;4의 반영을 멈추라고 하며, 이 terminal은 그것에서 어떤 상태도 반영하지 않는다.
- *길이를 넘거나 decode되지 않는 `msg`를 가진 clear를 한 해석은 적용하고 다른 해석은 거부하며, protocol은 상태를 가져오는 것이 아니라 OSC 9;4의 반영을 말하고, page가 progress report를 지니는 곳이 이름 붙지 않았다.* 받아들인다: 한계는 어떤 report든 통째로 거부하고, protocol의 조항을 적으며, `vendor.progress`를 이름 붙인다.
- *OSC 133 mark가 없는 session은 record를 끝내지 않고, 뒤에 있는 창은 notice를 주지 않는다.* 한계로 받아들이고 본문에 적는다.
- *paste나 주입된 쓰기가 사람이 보지 않은 notice를 끝낸다.* 받아들인다: region의 input transaction만 그것을 끝낸다.
- *아무 kind의 `P`나 prompt 시작이 살아 있는 record를 지우고, protocol이 말하는 process의 끝은 command 종료 mark다.* 받아들인다: `D`, `A`, kind `i`의 `P`가 실행 중인 program의 record를 끝낸다.
- *0이 아닌 exit의 level은 `D`부터 zsh가 곧바로 보내는 다음 `A`까지만 간다.* 이 변경이 바꾸지 않는 mark 규칙의 결함으로 받아들인다. [features](../features.md)가 그것을 추적한다.
- *창이 key 상태를 잃어도 region의 focus는 바뀌지 않으므로, 뒤에 있는 창의 bell은 notice를 주지 않고 DEC 1004는 focus-out을 보고하지 않는다.* 이 변경이 바꾸지 않는 region focus의 결함으로 받아들인다. [features](../features.md)가 그것을 추적한다.
- *`done`은 "끝났고 보지 않음"인데 `idle`이 된다.* 일부 받아들인다. 자기 prompt에서 쉬는 program은 대기 중인 승인이나 답이 없으며 그것이 `idle`의 의미다. 다섯 번째 level은 program이 스스로 끝내는 상태 때문에 core의 순서와 icon을 바꾼다(program은 사람이 확인하면 `idle`을 보고한다). [activity](activity.ko.md#activity의-종류)의 `idle` 의미가 이를 적는다.
- *다음 command 시작에서 `done`과 `error`를 지우는 것은 protocol을 어긴다.* 거부한다: protocol은 그것들을 끝과 prompt 뒤에도 지니게 하고 언제 보여 주기를 멈출지는 terminal에 맡기며, 사람이 같은 terminal에서 시작한 command는 사람이 결과를 보았다는 것을 보여 준다.
- *`blocked` record의 축출은 prompt가 보이는 동안 `attention`을 끝내므로 축출되면 안 된다.* 두 round에서 두 번 거부한다: protocol은 한계를 넘으면 가장 오래전에 갱신된 record를 지운다고 정한다. program은 자기 record가 256개를 넘어야 거기에 이르고, 축출은 `warn`으로 log에 남고 변화 event가 보여 주며, protocol을 어기고 `blocked` record를 지니면 한 program이 session의 record를 차지할 수 있다.
- *OSC 99와 첫 field가 다른 OSC 777은 보고 없이 무시해야 한다.* 거부한다: engine은 자기가 처리하지 않는 모든 sequence를 보고하며(각 sidecar의 protocol 문서의 OSC inventory), 그 보고는 아무것도 처리하지 않는다.
- *unload된 tab은 activity를 정하지 않으므로 sidecar가 activity를 정해야 한다.* 거부한다: core에서 surface가 없는 tab은 activity가 없으며([activity](activity.ko.md#tab의-activity)), sidecar의 tracker는 attach하는 page를 위해 record를 지닌다.
- *각 status event는 session의 모든 event에 걸친 하나의 counter가 필요하다.* 거부한다: surface의 event는 그것을 준 byte의 순서대로 하나의 순서 있는 channel로 온다. `program.status`의 `sequence`에 빈틈이 있으면 page가 다시 읽는다.
- *`<plugin>.program`의 `title`과 `msg`는 program이 승인을 묻는 command를 드러낸다.* 거부한다: `<plugin>.screen`이 화면의 같은 text를 드러낸다. log는 session 뒤에도 남으므로 그것들을 뺀다.
- *case가 read가 출력을 자르는 방식에 달려 있다.* 받아들인다: 각 sidecar는 각 case를 출력을 한 byte씩 넣어서도 실행한다.

## 공유 case

`docs/spec/cases/terminal-state/osc133.json`은 mark의 case를 담는다: 각 case는 session의 출력, 그 출력이 순서대로 주는 변화 event, 출력 뒤의 상태 읽기, 그리고 출력이 거부된 mark를 담는지를 가진다. sidecar는 그 파일을 자기 fixture로 복사하고 각 case를 자기 실제 engine과 상태 tracker로 실행한다. plugin은 그것을 복사하여 각 case의 변화 event와 읽기 답을 자기 page에 적용하고 자기 status의 값을 비교한다. contract가 바뀌면 복사본을 교체한다.

`docs/spec/cases/terminal-state/program-status.json`은 [program status](#program-status)의 case를 담는다: 각 case는 step을 가지며, 각 step은 engine이 읽는 출력, page가 보고하는 `focus`, 또는 사람의 `input`이고, 그다음 step이 순서대로 주는 `program.status`, `shell.state`, `sequence.rejected` event, step 뒤의 program status 읽기, plugin이 정하는 activity를 가진다. sidecar는 각 step의 출력을 한 번에, 그리고 다시 한 byte씩 넣어 각 case를 자기 실제 engine과 tracker로 실행한다. plugin은 각 case의 event와 read reply를 자기 page에 적용하고 `<plugin>.program`과 `<plugin>.activity`를 비교한다.

`docs/spec/cases/terminal-state/prompt-region.json`은 [prompt region](#prompt-region)의 case를 담는다: 각 case는 screen의 크기와 step을 가지며, 각 step은 engine이 읽는 출력이거나 크기 조정이고, step이 그것을 적을 때 step 뒤의 screen 행(각 행에서 끝의 빈칸을 뺀 것), 가장 오래된 것부터의 history 행, 커서, engine이 보고하는 오류를 가진다. 오류를 적지 않은 step은 오류가 없기를 기대한다. 각 sidecar는 그 파일을 자기 fixture로 복사하고 각 case를 자기 실제 engine으로 실행한다.
