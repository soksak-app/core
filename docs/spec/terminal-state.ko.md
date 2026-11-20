# 터미널 상태

[English](terminal-state.md)

이 문서는 terminal sidecar가 publish하고 terminal plugin이 보여 주는 터미널 상태를 정의한다. 두 터미널 쌍 모두에 적용된다: plugin `terminal`과 sidecar `vt`, plugin `term`과 sidecar `alacritty`. 각 sidecar와 각 plugin은 같은 contract를 구현하며, 각자 [cases](#공유-case)의 공유 case를 자기 구현에 대해 실행한다. 구현과 검증은 [features](../features.md)에서 추적한다. [보류된 상태](#보류된-상태)에 적힌 항목은 그 조건이 충족될 때까지 구현하지 않는다.

## 상태

터미널 상태는 다음 이름 중 하나다. sidecar는 상태가 바뀔 때 그것을 event로 publish하며, 호출자는 상태를 polling하지 않는다([AGENTS](../../AGENTS.md#implementation)).

| 상태 | 의미 | source |
| --- | --- | --- |
| `idle` | shell이 prompt에 있다: 마지막 mark가 OSC 133의 prompt 시작 `A`, 명시적 prompt 시작 `P` 또는 prompt 끝 `B`다 | `osc133` |
| `running` | 명령이 실행 중이다: 마지막 mark가 명령 시작 `C`다 | `osc133` |
| `exited` | 명령이 끝났다: 마지막 mark가 명령 종료 mark `D`이며, 그 exit code를 함께 가진다 | `osc133` |
| `waiting` | program이 사람의 입력을 기다린다 | 보류([보류된 상태](#보류된-상태)) |
| `agent-busy` | 터미널의 agent가 turn을 처리하고 있다 | 보류([보류된 상태](#보류된-상태)) |
| `agent-waiting` | 터미널의 agent가 사람을 기다린다 | 보류([보류된 상태](#보류된-상태)) |

shell이 OSC 133 mark를 보내지 않는 session에는 상태가 없다: sidecar는 출력에서 상태를 추론하지 않으며, 상태는 `null`로 남는다. 각 sidecar의 shell integration은 zsh와 bash에 대해 mark를 보낸다.

## Mark

sidecar는 session의 출력에서 OSC 133 mark를 읽는다(`ESC ] 133 ; <mark> [; <parameter>]… BEL` 또는 `ST`). mark `A`, `P`, `B`는 `idle`을, `C`는 `running`을, `D`는 `exited`를 준다. `P`는 prompt의 한 줄을 명시적으로 시작한다. 그 parameter `k`는 그 줄의 종류를 정한다: `i`는 prompt의 첫 줄이며 `k`가 없을 때의 종류이고, `c`나 `s`는 이어지는 줄, `r`은 오른쪽 prompt다. 다른 종류의 `P`는 잘못된 mark다. `D`의 첫 parameter는, 있고 `<name>=<value>` 형태의 named parameter가 아니면, 명령의 exit code다. 이것은 shell exit status의 범위인 0부터 255까지의 10진 정수다. 그 parameter가 없는 `D`는 exit code `null`인 `exited`를 준다. 첫 parameter가 named parameter도 아니고 0부터 255까지의 10진 정수도 아닌 `D`는 잘못된 mark다: engine은 다른 모든 잘못된 sequence처럼 `sequence.rejected`로 그것을 거부하며, 상태는 바뀌지 않는다.

mark는 현재 상태와 다른 상태를 줄 때만 상태를 바꾼다. `A` 뒤의 `B`처럼 반복된 mark는 변화를 주지 않는다.

## Prompt region

각 sidecar의 engine은 primary screen의 mark를 행의 사실로 유지하여, 크기 조정이 shell이 `SIGWINCH` 뒤 다시 그리는 prompt를 유지하게 한다. 크기 조정의 순서는 kitty의 순서다: engine은 reflow 전에 prompt를 reflow에서 빼고 reflow 뒤에 되돌려 놓는다.

- 기록된 행: `A`는 커서가 0열에 있지 않으면 먼저 커서를 다음 줄의 시작으로 옮기고, 기록된 모든 행을 지우고, 커서 행을 기록한다. 종류 `i`, `c`, `s`의 `P`는 커서 행을 기록하고, 종류 `r`의 `P`는 아무 행도 기록하지 않는다. `C`와 `D`는 기록된 모든 행을 지운다. 기록된 행은 절대 행이다: history 한도를 넘어 버려진 행 수, 더하기 history 행 수, 더하기 screen 행이다. 그래서 출력이 행을 history로 밀어 올리는 동안에도, history가 가장 오래된 행을 버리는 동안에도 행의 번호는 같다. prompt에서의 ED 2는 기록된 행을 맨 위 행으로 바꾼다. shell은 새 `A` 없이 그곳에 prompt를 다시 그리기 때문이다.
- Redraw: mark의 parameter `redraw`는 shell이 다시 그리는 region을 정한다: `1`은 prompt 전체, `last`는 커서가 있는 논리적 행만(readline은 prompt의 마지막 줄만 다시 그린다), `0`은 region 없음이다. `redraw` 없는 `A`는 `1`을 정하므로 각 `A`가 `redraw=0`을 끝낸다. `redraw` 없는 `P`와 `B`는 현재 값을 유지한다. 다른 값은 잘못된 mark다.
- Region: prompt에서(마지막 mark가 `A`, `P`, `B`) `redraw`가 `0`이 아니면, region은 커서 또는 그 위의 가장 가까운 기록된 행부터 screen의 맨 아래까지의 행이다. `redraw=last`이면 커서의 논리적 행의 첫 행이 기록된 행보다 아래에 있을 때 그 행에서 시작한다. `C`나 `D` 뒤, `redraw=0`, 기록된 행이 없을 때, alternate screen에서는 region이 없다.
- Region이 있는 크기 조정: engine은 region의 행을 복사한다. 그 행을 지워서, reflow가 region의 첫 행부터 커서 행까지 지운 각 행을 어떤 행도 잇지 않는 한 행으로 유지하고 커서 아래의 행을 빈 행으로 유지하게 한다. reflow를 위해 커서를 0열로 옮긴다. screen과 history를 새 크기로 reflow한다. 그다음 크기 조정 전 region의 첫 행이 커서 위에 있던 만큼 커서 위에 있는 행부터 복사본을 새 폭에서 잘라 되돌려 놓고, 커서를 자기 열로 되돌린다: 프로그램이 커서 행에 쓴 마지막 칸 다음 열이며, 커서 열에 다음 문자가 다음 행을 기다릴 때 1을 더한 값이고, 많아야 마지막 열이며, 그 열이 새 폭 이상이면 다음 문자는 다음 행을 기다린다. 커서는 프로그램이 둔 곳에 머문다. kitty는 열을 유지하고 Ghostty는 새 폭으로 제한한다. 그렇지 않으면 크기 조정과 shell의 다시 그리기 사이에 surface가 바로 표시하는 화면이 prompt의 첫 칸 위의 커서를 보인다. 잘림이 가르는 넓은 문자와 감싼 넓은 문자의 spacer는 빈 칸으로 남고, 되돌려 놓은 어떤 행도 다른 행을 잇지 않는다. region의 기록된 행은 자기 복사본과 함께 옮겨 간다. region 위의 기록된 행은 reflow가 그 행을 바꿨으므로 지운다. zsh와 readline은 자기가 커서 위에 그린 행 수만큼 커서를 올리고 그곳부터 다시 그린다. 그곳은 되돌려 놓은 첫 행이므로, shell이 다시 그리기 전에 표시되는 화면은 빈 행 대신 이전 폭의 prompt를 보이고, shell은 그 위에 쓴다.
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

page는 session을 열거나 session에 attach한 뒤 상태를 읽는다. persistent session은 어떤 page도 그것을 보여 주지 않는 동안에도 자기 상태를 유지하기 때문이다([persistent services](persistent-services.md)). 그 뒤 page는 변화 event를 따른다. surface의 답과 event는 하나의 순서 있는 channel로 도착하므로, page는 각각을 도착 순서대로 적용한다.

## Plugin status

각 terminal plugin은 각 terminal surface에 status `<plugin>.state`(`terminal.state`, `term.state`)를 선언한다. 그 값은 [상태 읽기](#상태-읽기)의 의미를 가진 `{state, source, sequence, exit}`다: 첫 읽기의 답 전에는 `{state: null, source: null, sequence: 0, exit: null}`, 그다음 읽기의 답, 그 뒤 각 변화 event의 member `to`, `source`, `sequence`, `exit`다. 이 형태가 아닌 변화 event나 읽기 답은 sidecar error다: page는 그것을 session의 error 경로로 보고하고 이전 값을 유지한다. surface의 새 session은 첫 읽기 전의 값에서 다시 시작한다.

## Activity

각 terminal plugin은 각 terminal surface에 status `<plugin>.activity`(`terminal.activity`, `term.activity`)도 선언하며, core가 tab, 그 card, space, project의 activity를 모으도록 `activity: true`로 core에 선언한다(core F982). 그 값은 core activity level이거나 activity가 없음을 뜻하는 `null`이다. plugin이 상태와 exit code를 알기 때문에 level은 plugin이 정하며, core는 level을 모으기만 한다. 값은 `<plugin>.state`의 각 값을 따른다:

| `<plugin>.state`의 `state` | `<plugin>.activity` |
| --- | --- |
| 첫 변화 전의 `null` | `null` |
| `idle` | `idle` |
| `running` | `running` |
| 0이 아닌 `exit`를 가진 `exited` | `failed` |
| `exit` 0 또는 `exit` `null`을 가진 `exited` | `null` |
| `waiting`, `agent-waiting`(보류) | `attention` |
| `agent-busy`(보류) | `running` |

mark가 exit code를 주지 않은 `exited` 상태는 실패를 보고하지 않는다. 실패를 보여 주는 code가 없기 때문이다. 보류된 상태의 행은 그 상태가 정의될 때 적용된다([보류된 상태](#보류된-상태)). status는 값이 바뀔 때만 바뀌며, surface의 새 session은 다시 `null`에서 시작한다.

## 보류된 상태

- `waiting`: 계획은 이것을 한 window 동안의 출력 정적과 prompt나 질문을 보여 주는 화면의 조합으로 정의한다([terminal plan, 2.3](../plans/terminal-plan.md#23-states)). window의 길이는 측정되지 않았고 prompt나 질문의 pattern도 선언되지 않았으며, mark와 agent signal이 event source인 곳에서 고정된 정적 window는 timer다. window와 pattern이 그 근거와 함께 이 문서에서 정해질 때까지 보류한다.
- `agent-busy`와 `agent-waiting`: 이것들은 agent의 hook event에서 온다([terminal plan, 2.5](../plans/terminal-plan.md#25-decision-for-the-state-rule)). Codex hook event(계획 항목 V4)와 Claude Code `Notification` event(계획 항목 V5)의 payload field가 실제 session에서 기록되지 않았고, hook event가 자기 터미널의 sidecar에 닿는 경로가 정의되지 않았다. 각 event의 payload가 실제 session에서 기록되고 이 문서가 그 경로와 field를 정의할 때까지 보류한다.

## 공유 case

`docs/spec/cases/terminal-state/osc133.json`은 mark의 case를 담는다: 각 case는 session의 출력, 그 출력이 순서대로 주는 변화 event, 출력 뒤의 상태 읽기, 그리고 출력이 거부된 mark를 담는지를 가진다. sidecar는 그 파일을 자기 fixture로 복사하고 각 case를 자기 실제 engine과 상태 tracker로 실행한다. plugin은 그것을 복사하여 각 case의 변화 event와 읽기 답을 자기 page에 적용하고 자기 status의 값을 비교한다. contract가 바뀌면 복사본을 교체한다.

`docs/spec/cases/terminal-state/prompt-region.json`은 [prompt region](#prompt-region)의 case를 담는다: 각 case는 screen의 크기와 step을 가지며, 각 step은 engine이 읽는 출력이거나 크기 조정이고, step이 그것을 적을 때 step 뒤의 screen 행(각 행에서 끝의 빈칸을 뺀 것), 가장 오래된 것부터의 history 행, 커서, engine이 보고하는 오류를 가진다. 오류를 적지 않은 step은 오류가 없기를 기대한다. 각 sidecar는 그 파일을 자기 fixture로 복사하고 각 case를 자기 실제 engine으로 실행한다.
