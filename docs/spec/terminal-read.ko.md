# 터미널 읽기

[English](terminal-read.md)

이 문서는 agent 같은 호출자가 터미널의 글을 읽는 방법, 곧 보이는 글, viewport 위의 행, full-screen program 의 글을 정한다. 두 터미널 쌍, 곧 sidecar `vt` 와 함께하는 plugin `terminal` 과 sidecar `alacritty` 와 함께하는 plugin `term` 에 적용된다. `<plugin>` 은 그 쌍의 plugin 을 이름한다. 각 sidecar 는 sidecar 부분을, 각 plugin 은 plugin 부분을 자기 repository 에서 구현한다. `docs/spec/cases/terminal-read/` 의 공유 case 가 입력과 기대하는 읽기를 담고, 각 repository 는 그 복사본을 실제 engine 이나 page 로 실행한다.

각 읽기 mode 는 두 plugin 에서 같은 이름을 가진 선언된 명령 하나이다. 호출자는 필요한 글을 담은 첫 mode 를 택한다. program scroll 은 program 에 입력을 쓰므로 마지막이다.

| Mode | 명령 | 쓰는 곳 | 보지 못하는 것 |
| --- | --- | --- | --- |
| 보이는 글 | `<plugin>.screen.read` | 지금 screen 의 행 | viewport 위의 행 |
| 보존된 행 | `<plugin>.screen.rows {screen, from, count}` | shell 이나 inline 으로 그리는 program 의 primary history, 그리고 full-screen program 이 alternate screen 밖으로 scroll 한 행. program 에 입력이 가지 않는다 | program 이 그린 적 없는 행 |
| Program scroll | `<plugin>.screen.scroll.read {by}` | full-screen program 이 그린 적 없는 행, 마지막 수단으로. program 을 움직이고 되돌려 scroll 한다 | program 의 내용 안의 절대 위치 |

어떤 터미널 명령도 file 이나 agent 의 transcript 를 읽지 않는다. agent 는 file 을 스스로 읽고, agent program 의 transcript 는 대화 읽기로 읽는다([agent transcript](#agent-transcript)). session 상태는 호출자가 mode 를 고르는 데 필요한 것을 알린다([session 상태](#session-상태)).

## 보이는 글

`<plugin>.screen.read` 는 활성 screen 의 viewport 행, 곧 사람이 보는 행을 돌려준다. primary screen 에서 행은 `<plugin>.scrollback.set` 의 viewport offset 을 따르고, full-screen program 의 alternate screen 에서는 그 program 이 그린 행이다. sidecar 는 parameter 없는 `screen.read` 로 답한다([화면 메시지](persistent-services.ko.md#화면-메시지)).

## Primary 행

`<plugin>.screen.rows {screen: "primary", from, count}` 는 sidecar 요청 `screen.read {screen: "primary", from, count}` 로 primary screen 과 그 history 의 행 `count` 개(1 부터 200 까지)를 viewport 를 움직이지 않고 돌려준다([화면 메시지](persistent-services.ko.md#화면-메시지)). 행 0 은 history 에 처음 들어간 행이다. 가장 오래 보존된 행은 history 한도를 넘어 버린 행의 수(`dropped`)이고, offset 0 의 viewport 는 그 뒤로 `history` 행 뒤에서 시작한다. alternate screen 에 들어가지 않는 agent program 처럼 primary screen 에 inline 으로 그리는 program 의 행은 primary 행이며 이 경로로 읽는다.

범위는 alternate screen 이 활성일 때도 primary 행을 이름한다. primary screen 과 그 history 는 full-screen program 아래에서도 읽을 수 있다. session 상태의 `scrollback` member 는 `offset`, `history`, `dropped` 를 담으므로 호출자는 거절되는 요청 없이 범위를 계산한다. 보존된 행 밖의 범위는 `invalidParams` 와 보존된 범위를 이름하는 reason 으로 거절된다.

## Alternate 행

full-screen program 은 alternate screen 에 그리며, 표준 터미널에서 그 screen 은 history 를 갖지 않는다. sidecar 는 scroll 로 alternate screen 의 위를 떠나는 행을 보존하므로, 호출자는 program 에 입력하지 않고 그 행을 읽는다. 선례는 alternate screen mode 에서 줄을 scrollback 에 저장하는 iTerm2 의 설정이다. 이 계약은 그 행을 primary history 와 떼어 두므로 primary 행과 그 번호는 바뀌지 않는다.

- 보존하는 행: scroll region 의 위 margin 이 screen 의 첫 행이고 왼쪽이나 오른쪽 margin 이 없는 동안, 위로의 scroll 이 행을 alternate screen 의 위로 밀어낼 때 그 행을 보존한다. 그 scroll 은 아래 margin 에서의 line feed, `IND`, `NEL`, 또는 `CSI n S` 이다. 위가 첫 행 아래인 region 의 scroll 은 행이 program 의 screen 안에 남으므로 아무것도 보존하지 않는다. scroll 없이 행을 다시 쓰는 repaint 는 screen 을 떠난 행이 없으므로 아무것도 보존하지 않는다.
- 읽기: `<plugin>.screen.rows {from, count, screen: "alternate"}` 는 `screen.read {from, count, screen: "alternate"}` 를 보낸다. 행 0 은 alternate screen 에 들어온 뒤 sidecar 가 처음 보존한 행이고, 가장 오래 보존된 행은 한도가 버린 보존 행의 수이다. 보존한 행이 먼저 오고 alternate screen 의 행이 그 뒤를 따른다. 답은 `screen`, `from`, `count`, `rows` 를 담은 `screen.rows` 이다. `screen` 은 필수이고 `primary` 나 `alternate` 이다. 그것이 없거나 다른 값인 요청은 plugin 에서는 요청 전에, sidecar 에서도 `invalidParams` 로 거절된다.
- 한도: sidecar 는 session 의 history 한도만큼의 행까지 보존한다. 한도가 버린 행은 session 상태의 `alternate` member(`{history, dropped}`)의 `dropped` 로 세고, 데이터를 버리는 bounded buffer 는 알린다는 규칙대로([AGENTS](../../AGENTS.md#implementation)) sidecar 는 scroll 하나의 버림마다 버린 행의 수를 담은 기록 하나를 쓴다.
- 수명: 보존한 행은 program 이 alternate screen 을 떠난 뒤에도 남으므로 호출자는 program 이 끝난 뒤에 그 행을 읽는다. 행은 alternate screen 에 다시 들어갈 때와 session 이 끝날 때 지워진다.

## Program scroll

program 이 그린 적 없는 행은 program 만 갖고 있으며, 어떤 터미널도 그것을 읽을 수 없다. 그때에만 호출자가 program 을 움직인다. `<plugin>.screen.scroll.read {by}` 는 program 을 `by` 행(양수는 더 오래된 내용 쪽)만큼 scroll 하고, program 이 그린 뒤의 screen 을 읽고, 되돌려 scroll 한다. 터미널은 program 의 내용 안의 절대 위치를 알 수 없으므로 offset 은 읽기가 시작될 때의 program 의 위치에 대한 상대값이다.

- 경로: scroll 은 Shift 없이 sidecar 의 wheel 규칙([wheel 입력](#wheel-입력))을 따른다. program 이 mouse tracking 을 켰으면 wheel 의 mouse report, alternate screen 이 활성이고 alternate scroll mode 가 적용되면 cursor key `Up` 과 `Down`, 그 밖에는 primary screen 의 viewport 이다.
- 단계: 명령은 screen 을 읽고, scroll 을 보내고, program 이 그것을 그릴 때까지 기다리고, screen 을 읽고, `-by` 의 scroll 을 보내고, program 이 그것을 그릴 때까지 기다리고, screen 을 읽어 첫 읽기와 비교한다.
- 답: `{route, changed, text, restored}`. `route` 는 `program`, `alternate_scroll`, `viewport` 중 하나이다. `changed` 는 scroll 뒤의 screen 이 첫 읽기와 다른지이므로 호출자는 내용의 끝을 본다. `text` 는 scroll 뒤의 각 행의 plain text 이다. `restored` 는 마지막 읽기가 첫 읽기와 같은지이다. 그것이 `false` 이면 program 이 원래 자리에 있지 않으므로 답은 첫 읽기와 마지막 읽기의 첫 행도 담고, plugin 은 그 오류를 자기 오류 표시 경로로 보인다. 명령은 짐작한 차이만큼 다시 scroll 하지 않는다.
- 사람의 입력: 사람이 첫 단계와 마지막 단계 사이에 그 session 에 입력을 보내면 읽기는 session 의 입력 순서로 판정해 거절된다. 사람의 입력은 실행되고, 읽기는 그 입력을 이름하는 오류로 끝난다.
- 그리기: 그리기의 기다림을 끝내는 이벤트는 열린 결정이다([열린 결정](#열린-결정)). timer 는 그것을 끝내지 않는다.

## Session 상태

session 상태(`<plugin>.session`)는 mode 를 고르기 위해 alternate screen 이 활성인지(`alternate.active`), 각 screen 의 보존된 행(`offset`, `history`, `dropped` 를 담은 `scrollback` 과 `history`, `dropped` 를 담은 `alternate`), 그리고 session 의 foreground program 을 알린다.

## Agent transcript

agent program 은 대화의 transcript 를 스스로 보존한다. `sok conversation read` 가 그것을 disk 의 session file 에서 읽는다([agent 대화](agent-conversation.ko.md)). agent 의 대화가 필요한 호출자는 screen 이 아닌 그 경로를 택한다.

## Wheel 입력

sidecar 는 wheel 동작 `scroll {lines, col, row, shift}` 를 이 순서로 보낸다. program 이 mouse reporting 을 켰고 Shift 가 눌리지 않았으면 mouse report, alternate screen 이 활성이고 alternate scroll mode(DECSET 1007)가 설정되었으면 alternate scroll 의 cursor key, 그 밖에는 primary screen 의 viewport 이다. 각 plugin 의 page 는 사람의 wheel 을 이 동작으로 보내고, program scroll 도 같은 동작을 보낸다.

## 열린 결정

- Program scroll 의 그리기. 제안 규칙: (1) 동기 출력(DECSET 과 DECRST 2026)을 쓰는 program 은 reset 으로 frame 을 끝내므로, scroll 입력 뒤의 첫 reset 이 기다림을 끝내고 답은 `settledBy: "sync"` 를 말한다. sidecar 는 동기 frame 이 끝날 때마다 session 이벤트를 발행한다. (2) 동기 출력이 없는 program 에서는 redraw 의 끝을 알리는 이벤트가 없으므로, 그때에만 입력 뒤의 마지막 출력 다음에 session 의 출력이 없는 조용한 간격이 지나면 기다림이 끝난다. 간격은 millisecond 가 아니라 창의 display frame 으로 세므로 규칙은 모든 refresh rate 에서 성립한다. 답은 `settledBy: "quiet"` 와 간격을 말하고, 간격은 frame 단위의 기본값을 가진 선언된 설정이다. (3) 입력 뒤 간격 안에 출력이 없으면 screen 은 바뀌지 않은 채 `changed: false` 이다. (4) 되돌리기 단계의 기다림도 같은 규칙으로 끝난다. 이유: 2026 의 reset 은 program 이 frame 의 끝에 보내는 유일한 이벤트이고, frame 수는 refresh rate 를 가정하지 않는 척도이다.
  - 반론, 답함: 창의 display frame 은 sidecar 의 frame 요청에 답하는 tick 으로만 sidecar 에 닿고([image region](native-surfaces.ko.md#그림-영역)), 가려진 창이나 그리지 않는 region 은 그것을 주지 않는다. 답: 그리기가 아니라 읽기를 위한 frame 요청은 `purpose: "read"` 를 담고, screen 의 display link 는 가려짐과 무관하게 돌므로 host 는 창이 가려졌거나 region 이 그리지 않을 때도 창의 screen 의 display frame 에서 그것에 답한다. 어느 screen 에도 없는 창은 그 창을 이름하는 오류로 읽기를 거절한다. session 은 시계를 갖지 않는다.
  - 반론, 답함: 조용한 간격은 출력이 없음으로 program 을 판정하므로, disk 나 network 에서 내용을 읽는 program 처럼 간격 뒤에 답하는 program 에는 그 답 이전의 screen 을 이름하는 답을 준다. 답: `settledBy: "quiet"` 는 program 이 끝났음을 증명하지 않는다. 답은 간격을 담으므로 호출자가 다시 읽는다. 기본 간격은 측정한다. 부하 아래 `less`, `vim`, `htop` 의 redraw 하나의 출력 묶음 사이의 가장 큰 간격을 추적되는 측정으로 재고, 이 절이 그 결과와 근거를 말한다.
  - 남은 것: 기본 간격의 측정과 반론 없는 규칙의 review 한 차례.
