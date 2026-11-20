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
- 답: `{route, changed, text, restored, settledBy, quiet, refreshRate}`. `route` 는 `program`, `alternate_scroll`, `viewport` 중 하나이다. `changed` 는 scroll 뒤의 screen 이 첫 읽기와 다른지이므로 호출자는 내용의 끝을 본다. `text` 는 scroll 뒤의 각 행의 plain text 이다. `restored` 는 마지막 읽기가 첫 읽기와 같은지이다. `settledBy` 는 `{scroll, restore}` 로, 각 단계의 기다림을 끝낸 이벤트 `sync`, `quiet`, `viewport` 중 하나이다([program scroll 의 그리기](#program-scroll-의-그리기)). `quiet` 는 읽기가 쓴 display frame 단위의 조용한 간격이다. `refreshRate` 는 읽기의 마지막 tick 의 refresh rate 이며, 읽기가 tick 을 받지 않았으면 `null` 이다. `restored` 가 `false` 이면 program 이 원래 자리에 있지 않으므로 답은 첫 읽기와 마지막 읽기의 첫 행을 `{before, after}` 로 담는 `first` 도 담고, plugin 은 그 오류를 자기 오류 표시 경로로 보인다. 명령은 짐작한 차이만큼 다시 scroll 하지 않는다.
- sidecar 요청: plugin 은 `screen.scroll.read {by, quiet}` 를 보낸다. `by` 는 0 이 아닌 -1000 부터 1000 까지의 정수이고, `quiet` 는 그 설정 `scrollReadQuiet` 의 조용한 간격으로 1 부터 120 display frame 까지의 정수이며 기본값은 6 이다. sidecar 는 이벤트 `screen.scroll` 과 답의 멤버로 답하고, 다른 값에는 `invalidParams` 와 이유로 답한다. surface 의 다른 읽기가 도는 동안의 읽기는 `invalidParams` 와 이유 `a scroll read is running` 으로 거절된다. 붙은 image region 이 없는 surface 의 읽기는 `invalidParams` 와 이유 `a scroll read needs the display frames of an image region` 으로 거절된다. display frame 은 그 region 의 tick 으로만 sidecar 에 닿기 때문이다. 사람의 입력이 끝낸 읽기는 오류 `scrollReadInterrupted` 와 그 입력(`input`, `paste`, `mouse`, `scroll`, `viewport`)을 이름하는 이유로 답한다. host 가 frame 요청을 거절했거나, image region 이 떨어졌거나, session 이 끝나서 끝난 읽기는 오류 `scrollReadFailed` 와 그 원인을 이름하는 이유로 답한다. plugin 은 그 오류로 명령을 거절한다.
- 사람의 입력: 사람이 첫 단계와 마지막 단계 사이에 그 session 에 입력을 보내면 읽기는 session 의 입력 순서로 판정해 거절된다. 사람의 입력은 실행되고, 읽기는 그 입력을 이름하는 오류로 끝난다.
- 그리기: 각 단계의 기다림은 [program scroll 의 그리기](#program-scroll-의-그리기) 의 규칙으로 끝난다. timer 는 그것을 끝내지 않는다.

## Session 상태

session 상태(`<plugin>.session`)는 호출자가 mode 를 고르는 데 필요한 것을 네 member 로 알린다. sidecar 가 보내고 plugin 은 받은 대로 보관한다.

| Member | 형식 |
| --- | --- |
| `scrollback` | `{offset, history, dropped}`: 활성 screen 의 viewport offset 과 보존된 history 행, 그리고 history 한도가 primary history 에서 버린 행의 수. 이 수는 가장 오래 보존된 primary 행의 번호다 |
| `alternate` | `{active, history, dropped}`: alternate screen 이 활성인지, alternate screen 위에 보존된 행의 수, 그리고 한도가 버린 보존 행의 수. 이 수는 가장 오래 보존된 alternate 행의 번호다 |
| `foreground` | `{group, pid, command, arguments, cwd, started}`: session 의 terminal 의 foreground program 을 process list 의 [process](process-list.ko.md#process) 로 나타낸 것으로, 그 group, 실행 파일의 경로, arguments, 작업 directory 와 시작 시각을 담는다. terminal 의 foreground process group 에 끝나지 않은 member 가 없으면 `null` 이다([foreground program](process-list.ko.md#foreground-program)) |
| `background` | session 의 terminal 의 background job([background jobs](process-list.ko.md#background-jobs)). session 에 job 이 없으면 빈 배열 |

- 출처: sidecar 는 `scrollback` 과 `alternate` 를 각 `view` 이벤트에 담으므로 이 둘은 사람이 보는 화면을 따른다. `foreground` 와 `background` 는 session 의 각 출력 뒤에(그 첫 출력은 shell 의 prompt 다) session 의 terminal 에서 process list 의 한 번의 읽기로 읽고, list 가 마지막으로 보낸 list 와 다르면 이벤트 `{event: "processes", foreground, background}` 를 보낸다. 실패한 읽기는 두 member 를 `null` 로 둔다([process list](process-list.ko.md#session-state)).
- 거절된 읽기: 다른 사용자의 process 의 arguments 나 작업 directory 처럼 system 이 foreground program 의 process 의 읽기를 거절하면 member 는 `{group, pid, command: null, arguments: null, cwd: null, started: null, error}` 이고, `error` 는 그 읽기와 이유를 이름한다. 어떤 값도 추측하지 않는다.
- 한계: foreground 를 잡고 출력을 쓰지 않는 program 은 session 의 다음 출력에서 이름이 붙는다. system 의 어떤 이벤트도 foreground process group 의 변경을 알리지 않고, full-screen program 은 그리므로 그 출력이 그것을 이름한다. 보존된 alternate 행과 program scroll 중 무엇을 쓸지는 `foreground` 가 아니라 `alternate.active` 가 정한다.

## Agent transcript

agent program 은 대화의 transcript 를 스스로 보존한다. `sok conversation read` 가 그것을 disk 의 session file 에서 읽는다([agent 대화](agent-conversation.ko.md)). agent 의 대화가 필요한 호출자는 screen 이 아닌 그 경로를 택한다.

## Wheel 입력

sidecar 는 wheel 동작 `scroll {lines, col, row, shift}` 를 이 순서로 보낸다. program 이 mouse reporting 을 켰고 Shift 가 눌리지 않았으면 mouse report, alternate screen 이 활성이고 alternate scroll mode(DECSET 1007)가 설정되었으면 alternate scroll 의 cursor key, 그 밖에는 primary screen 의 viewport 이다. 각 plugin 의 page 는 사람의 wheel 을 이 동작으로 보내고, program scroll 도 같은 동작을 보낸다.

mouse report 1000(누름과 뗌), 1002(button 을 누른 동안의 움직임도), 1003(모든 움직임도)은 한 mode 다. 하나를 설정하면 나머지를 대신하므로, 1000, 1002, 1003 을 차례로 설정한 program 은 1003 으로 보고받고, engine 의 mode 에는 그 하나만 남는다. wheel 의 mouse report 는 오래된 내용 쪽이면 button 64, 새 내용 쪽이면 65 를 한 줄에 한 번씩 pointer 의 칸에서 보내며, DECSET 1006 이 설정되었으면 SGR encoding, 아니면 기본 encoding 으로 보낸다. alternate scroll 의 cursor key 는 application cursor mode(DECSET 1)를 따르고, alternate scroll mode 는 session 이 시작할 때 설정되어 있다. `docs/spec/cases/terminal-read/wheel-routes.json` 은 route 의 case 를 담는다: program 의 출력, 그 뒤의 mode, 각 scroll 에 session 이 받는 정확한 text 다. 각 sidecar 는 이 파일을 자기 fixture 로 복사하고 각 case 를 실제 engine 과 wheel route 로 실행한다.

## Program scroll 의 그리기

program 이 redraw 를 마쳤음을 알리는 터미널 이벤트는 없으므로, scroll 단계와 되돌리기 단계의 기다림은 이 규칙으로 끝난다. 이 규칙은 시간을 millisecond 가 아니라 창의 display frame 으로 세므로 모든 refresh rate 에서 성립한다.

- Tick: 단계가 기다리는 동안 sidecar 는 자기 region 의 frame 요청 `{"image":{"want":{"name","generation","purpose":"read"}}}` 를 그것에 답하는 각 tick 에서 보내므로, 창이 가려졌거나 region 이 그리지 않는 동안에도 창의 screen 의 display frame 마다 tick 하나를 받는다([복사 경로 프레임](native-surfaces.ko.md#복사-경로-프레임)). 어느 screen 에도 없는 창의 `noScreen` 같은 요청의 거절은 그 거절과 창을 이름하는 오류로 읽기를 끝낸다.
- 동기 출력: 동기 출력(DECSET 과 DECRST 2026)을 쓰는 program 은 reset 으로 frame 을 끝낸다. 단계는 그 단계의 입력 뒤에 열린 update 의 reset 다음의 첫 tick 에서, 그 reset 과 tick 사이에 출력이 없고 열린 update 가 없으면 `sync` 로 끝난다. 같은 redraw 의 두 번째 update 처럼 그 frame 안의 출력은 다음 tick 을 기다린다.
- 조용한 간격: 단계는 그 단계의 입력 뒤의 마지막 출력 다음에, 또는 입력 뒤에 출력이 없었으면 입력 다음에 `quiet` 개의 tick 이 온 tick 에서도 `quiet` 로 끝난다. 조용한 경로는 program 이 동기 출력을 쓰든 안 쓰든 성립하므로, 열리고 닫히지 않는 update 는 그것으로 끝난다. reset 은 기다림을 더 일찍 끝낼 뿐이다. scroll 단계에 출력이 없으면 `changed: false` 이다.
- Viewport: 경로 `viewport` 에서는 engine 이 scroll 을 곧바로 적용하고 program 이 그리지 않으므로 각 단계는 곧바로 `viewport` 로 끝난다.
- 증명 아님: `quiet` 는 program 이 끝났음을 증명하지 않는다. disk 나 network 에서 내용을 읽는 program 처럼 간격 뒤에 답하는 program 은 그 답 이전의 screen 을 이름하는 답을 준다. 답은 `settledBy` 와 `quiet` 를 담으므로 호출자는 다시 읽거나 설정을 올린다. 더 큰 간격의 비용은 시간뿐이다. `quiet` display frame 의 기다림 두 번이며, 그 동안 사람의 입력은 읽기를 거절한다.
- 기본값: `quiet` 는 display frame 6 개이다. tick 은 요청마다 하나씩 서로 다른 display frame 에 오므로, 출력 뒤 `quiet` 개의 tick 은 적어도 `quiet - 1` 개의 온전한 frame 주기에 걸친다. 5 주기는 120 Hz 에서 41.7 ms, 60 Hz 에서 83 ms 이다. vt S211 의 추적되는 측정(sidecar vt 의 `make measure-program-redraw`)은 40 × 120 cell 의 실제 PTY 에서 2000 행의 번호 매긴 file 로 `less` 와 `vim` 을, 그리고 `htop` 을 실행하고, cursor key 50 개씩의 scroll 을 부하 없이와 11 개 processor 마다 바쁜 process 하나의 부하로 120 Hz screen 에서 20 번 보냈다. key 에서 첫 출력까지의 가장 긴 시간과 redraw 하나의 출력 사이의 가장 큰 간격은 `less` 가 부하 없이 0.1 과 0.1 ms, 부하에서 3.7 과 3.4 ms, `vim` 이 1.1 과 0.3 ms 와 3.4 와 0.3 ms, `htop` 이 2.1 과 0.6 ms 와 4.5 와 5.4 ms 였다. 측정이 읽는 thread 대신 `poll` 로 출력을 기다린 뒤의 vt S213 의 실행은 `less` 가 0.9 와 0.3 ms 와 6.9 와 11.8 ms, `vim` 이 8.9 와 0.3 ms 와 8.3 과 0.3 ms, `htop` 이 2.7 과 1.7 ms 와 7.4 와 7.6 ms 로, 120 Hz 에서 많아야 display frame 2 개였다. 기본값은 120 Hz 에서 잰 가장 긴 시간 11.8 ms 의 세 배를 넘는다.

adversarial review 가 규칙에 반론했다. 그 반론과 답:

- 한 redraw 의 두 update 중 첫 것의 reset 이 두 번째 앞에서 기다림을 끝낸다(받아들임): 단계는 reset 뒤에 출력이 없는 tick 에서만 `sync` 로 끝나므로, frame 안의 두 번째 update 는 기다림을 잇는다.
- 열리고 닫히지 않는 update 는 어떤 기다림도 끝내지 않는다(받아들임): 조용한 경로는 모든 단계에서 성립하고, engine 은 닫히지 않은 update 를 그 한도에서 끝낸다.
- 입력 전에 시작한 update 의 reset 이 기다림을 곧바로 끝낸다(받아들임): 그 단계의 입력 뒤에 열린 update 의 reset 만 센다.
- 읽기의 두 단계가 다른 이벤트로 끝날 수 있다(받아들임): `settledBy` 가 각 단계의 이벤트를 이름한다.
- disk 에서 읽는 program 같은 느린 program 은 답 이전의 screen 을 준다(한계로 받아들임): 답에 `settledBy` 와 `quiet` 가 있고, sidecar 의 PTY 시험이 간격 뒤에 쓰는 program 을 다룬다.
- 되돌리기는 이미 낡은 읽기와 비교한다(거절): 첫 읽기는 기다림 뒤의 읽기가 아니라 scroll 입력 전의 screen 이다.
- 측정은 cursor key 와 program 셋만 다룬다(거절): program 은 key 뒤와 wheel report 뒤에 같은 코드로 다시 그리고, 답이 조용한 경로의 한계를 말한다. 측정의 관찰 한도는 그 창이며 규칙의 판정이 아니다.
- tick 이 몰려 `quiet` 개의 tick 이 더 짧은 시간에 걸칠 수 있다(거절): sidecar 는 tick 뒤에만 다음 요청을 보내고 host 는 그것에 다음 display frame 에 답하므로 두 tick 이 한 frame 을 나누지 않는다. 느리거나 빠진 frame 은 기다림을 늘릴 뿐이다.
- refresh rate 가 비용을 바꾼다(받아들임): 답은 마지막 tick 의 `refreshRate` 를 담는다.
