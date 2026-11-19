# 터미널 상태

[English](terminal-state.md)

이 문서는 terminal sidecar가 publish하고 terminal plugin이 보여 주는 터미널 상태를 정의한다. 두 터미널 쌍 모두에 적용된다: plugin `terminal`과 sidecar `vt`, plugin `term`과 sidecar `alacritty`. 각 sidecar와 각 plugin은 같은 contract를 구현하며, 각자 [cases](#공유-case)의 공유 case를 자기 구현에 대해 실행한다. 구현과 검증은 [features](../features.md)에서 추적한다. [보류된 상태](#보류된-상태)에 적힌 항목은 그 조건이 충족될 때까지 구현하지 않는다.

## 상태

터미널 상태는 다음 이름 중 하나다. sidecar는 상태가 바뀔 때 그것을 event로 publish하며, 호출자는 상태를 polling하지 않는다([AGENTS](../../AGENTS.md#implementation)).

| 상태 | 의미 | source |
| --- | --- | --- |
| `idle` | shell이 prompt에 있다: 마지막 mark가 OSC 133의 prompt 시작 `A` 또는 prompt 끝 `B`다 | `osc133` |
| `running` | 명령이 실행 중이다: 마지막 mark가 명령 시작 `C`다 | `osc133` |
| `exited` | 명령이 끝났다: 마지막 mark가 명령 종료 mark `D`이며, 그 exit code를 함께 가진다 | `osc133` |
| `waiting` | program이 사람의 입력을 기다린다 | 보류([보류된 상태](#보류된-상태)) |
| `agent-busy` | 터미널의 agent가 turn을 처리하고 있다 | 보류([보류된 상태](#보류된-상태)) |
| `agent-waiting` | 터미널의 agent가 사람을 기다린다 | 보류([보류된 상태](#보류된-상태)) |

shell이 OSC 133 mark를 보내지 않는 session에는 상태가 없다: sidecar는 출력에서 상태를 추론하지 않으며, 상태는 `null`로 남는다. 각 sidecar의 shell integration은 zsh와 bash에 대해 mark를 보낸다.

## Mark

sidecar는 session의 출력에서 OSC 133 mark를 읽는다(`ESC ] 133 ; <mark> [; <parameter>]… BEL` 또는 `ST`). mark `A`와 `B`는 `idle`을, `C`는 `running`을, `D`는 `exited`를 준다. `D`의 첫 parameter는, 있고 `<name>=<value>` 형태의 named parameter가 아니면, 명령의 exit code다. 이것은 shell exit status의 범위인 0부터 255까지의 10진 정수다. 그 parameter가 없는 `D`는 exit code `null`인 `exited`를 준다. 첫 parameter가 named parameter도 아니고 0부터 255까지의 10진 정수도 아닌 `D`는 잘못된 mark다: engine은 다른 모든 잘못된 sequence처럼 `sequence.rejected`로 그것을 거부하며, 상태는 바뀌지 않는다.

mark는 현재 상태와 다른 상태를 줄 때만 상태를 바꾼다. `A` 뒤의 `B`처럼 반복된 mark는 변화를 주지 않는다.

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

## 보류된 상태

- `waiting`: 계획은 이것을 한 window 동안의 출력 정적과 prompt나 질문을 보여 주는 화면의 조합으로 정의한다([terminal plan, 2.3](../plans/terminal-plan.md#23-states)). window의 길이는 측정되지 않았고 prompt나 질문의 pattern도 선언되지 않았으며, mark와 agent signal이 event source인 곳에서 고정된 정적 window는 timer다. window와 pattern이 그 근거와 함께 이 문서에서 정해질 때까지 보류한다.
- `agent-busy`와 `agent-waiting`: 이것들은 agent의 hook event에서 온다([terminal plan, 2.5](../plans/terminal-plan.md#25-decision-for-the-state-rule)). Codex hook event(계획 항목 V4)와 Claude Code `Notification` event(계획 항목 V5)의 payload field가 실제 session에서 기록되지 않았고, hook event가 자기 터미널의 sidecar에 닿는 경로가 정의되지 않았다. 각 event의 payload가 실제 session에서 기록되고 이 문서가 그 경로와 field를 정의할 때까지 보류한다.

## 공유 case

`docs/spec/cases/terminal-state/osc133.json`은 mark의 case를 담는다: 각 case는 session의 출력, 그 출력이 순서대로 주는 변화 event, 출력 뒤의 상태 읽기, 그리고 출력이 거부된 mark를 담는지를 가진다. sidecar는 그 파일을 자기 fixture로 복사하고 각 case를 자기 실제 engine과 상태 tracker로 실행한다. plugin은 그것을 복사하여 각 case의 변화 event와 읽기 답을 자기 page에 적용하고 자기 status의 값을 비교한다. contract가 바뀌면 복사본을 교체한다.
