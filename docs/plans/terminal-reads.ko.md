# 터미널 화면과 기록 읽기

[English](terminal-reads.md)

이 제안은 사람이나 agent가 보이는 화면보다 더 많은 내용을 읽는 데 필요한 읽기 명령을 추가한다. 두 터미널 plugin인 `terminal`(sidecar `vt-alacritty`)과 `term`(sidecar `alacritty`)에 모두 적용하며, 두 sidecar 모두에 적용한다. 각 명령은 두 plugin에서 같은 이름, 같은 parameter, 같은 결과를 가지며, 각 sidecar는 같은 공유 계약 case를 검사한다. 그래서 변경이 두 터미널에 같은 방식으로 적용된다.

## 현재 코드에서 확인한 사실

- `terminal.screen.read`와 `term.screen.read`는 viewport만 돌려준다. 현재 display offset의 grid `screen_lines` 행이다(`sidecars/alacritty/alacritty/src/engine.rs`, `fn screen`). viewport 위의 행을 데이터로 돌려주는 명령은 없다.
- `terminal.scrollback.set`과 `term.scrollback.set`은 display offset을 바꾸고, sidecar는 이를 세션 status의 `scrollback.offset`과 `scrollback.history`로 보고한다. offset은 텍스트를 돌려주지 않는다.
- `alacritty` sidecar는 이미 OSC 133 셸 마크(`A`, `B`, `C`, `D`)를 파싱하고, 절대 행 번호(`dropped + history + line`)를 계산한다. 기록이 유지되는 동안 이 번호는 안정적이다(`engine.rs`, `fn absolute`). 이를 노출하는 명령은 없다.
- `vt` sidecar와 `vt-core`의 OSC 133 처리는 아직 확인하지 않았다(미확인 항목 V1).
- TUI agent(Claude Code, Codex)에서 스크롤이 화면을 움직이지 않는 이유: TUI는 대체 화면(alternate screen)에서 돈다. 엔진은 대체 화면에 기록을 두지 않는다(`alacritty/tests/engine_test.rs`, `alternate_screen_is_separate_from_primary_scrollback`). 휠은 `WheelRoute::of`(`alacritty-core/src/protocol.rs`)가 라우팅한다. 마우스 보고가 켜져 있고 Shift가 없으면 program으로 가고, 대체 화면에서 alternate scroll이 켜져 있으면 program에 커서 키가 된다. viewport는 primary 화면에서만 움직인다. viewport 명령은 offset을 기록 범위로 자르는데(`SurfaceCommand::Viewport`), 대체 화면의 기록은 비어 있으므로 화면이 움직이지 않는다. plugin은 이 경우를 알리지 않는다. 이것이 보고된 현상을 설명한다. 변경 전에 V2에서 실행 중인 TUI로 확인한다.
- TUI agent는 대화를 터미널이 아니라 디스크의 파일에 남긴다. Claude Code는 `~/.claude/projects/<cwd>/<session>.jsonl`(`user`, `assistant` 레코드)을, Codex는 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`(`response_item`, `event_msg` 레코드, 작업 디렉터리는 `session_meta`)을 쓴다. 이 파일들은 화면이 무엇을 보이든 대화를 담는다.

## 필수 결과

이 계획은 `term`과 `terminal` 모두에 두 방법을 제공한다.

- **방법 A, TUI 화면 읽기.** 보이는 화면의 임의 행 구간(`from`, `count`)을 cell과 평문으로, 커서와 줄바꿈 표시와 함께 읽는다. 방안 1과 2가 구현한다.
- **방법 B, 대화 session 찾아 읽기.** 터미널에서 실행 중인 agent(Claude Code 또는 Codex)의 session을 찾고, 디스크의 session 파일에서 메시지를 순서대로 읽는다. 결과는 읽은 파일을 밝힌다. 방안 7이 구현한다.

방안 3부터 6까지는 두 방법이 요구하지 않는다. 각각은 방법 A와 방법 B를 검증한 뒤 따로 정한다.

## 터미널 상태

위의 읽기는 내용을 돌려준다. 호출자는 각 터미널의 상태도 알아야 한다. 프로그램이 실행 중인지, 멈췄는지, prompt에서 쉬고 있는지, 입력을 기다리는지다. 상태는 호출자가 polling하는 값이 아니라, 바뀔 때 sidecar가 발행하는 event다.

현재 코드에서 확인한 사실은 다음과 같다.

- `alacritty` 엔진은 OSC 133 마크 `A`(prompt 시작), `B`(prompt 끝), `C`(명령 시작), `D`(명령 끝, 종료 코드 포함)를 파싱한다(`alacritty/src/engine.rs`, `ShellMarker`). prompt 시작과 그 절대 행 번호를 기록한다. 아직 이 마크를 알리는 event는 없다.
- Claude Code나 Codex 같은 TUI agent는 OSC 133 마크를 내지 않는다. 그래서 마크는 셸 prompt만 보여 주고, agent 자신의 작업은 보여 주지 않는다.

제안하는 상태는 신뢰도가 높은 신호부터 순서대로 정한다.

- `idle`: 셸이 prompt에 있다(`A`/`B` 이후, `C` 이전). 실행 중인 명령이 없다.
- `running`: 명령이 시작했고(`C`) 아직 끝나지 않았다(`D`).
- `exited`: 명령이 끝났다(`D`), 종료 코드를 가진다.
- `waiting`: 프로그램이 일정 시간 조용했고 화면에 prompt나 질문이 보인다. 발견적 판단이며, 결과에 그렇다고 표시한다.
- `agent-busy` / `agent-waiting`(Claude Code, Codex): agent 자신의 신호로 정한다. agent가 hook event를 제공하면 그것을 쓴다(아래 오픈소스 비교). 출력이 조용한 것만으로는 판단하지 않는다.

상태가 바뀔 때마다 이전 상태, 새 상태, 신호의 출처, 순번을 담은 event를 낸다. 상태 읽기는 현재 상태, 출처, 마지막 변경의 순번을 돌려준다.

### 오픈소스 비교(상태 신호)

- Orca(github.com/stablyai/orca)는 신호를 여러 층으로 쓴다. OSC 133 `A`/`D` 마크, agent 상태 protocol(OSC 7501), agent hook event(Claude Code의 `SessionStart`, `UserPromptSubmit`, `Stop`, `PreToolUse`, `PermissionRequest`, `SessionEnd`), 제목 글자, 출력 정지와 화면 확인을 쓴다. hook 상태의 상태는 `working`, `permission`, `idle`, `done`이다. 명시적 보고가 제목에서 얻은 상태를 이기고, 제목에서 온 idle은 출력이 일정 시간 조용한 뒤에만 받아들인다.
- omp(github.com/can1357/oh-my-pi)는 감지하는 쪽이 아니라 보고하는 쪽이다. 자기 실행 상태(`idle`, `working`, `done`, `error`, `permission` 또는 `question`인 `blocked`)를 OSC 7501 record로 event 흐름에서 쓰고, record가 유지되는 동안 OSC 133 영역을 끈다.
- Claude Code는 hook event(`Stop`, `permission_prompt`/`idle_prompt`를 가진 `Notification`, `PermissionRequest`, `StopFailure`)를 제공한다. 화면에서 추측하지 않고 `agent-busy`와 `agent-waiting`의 event 원천으로 쓸 수 있다.
- Codex는 `notify`가 turn 완료에서만 실행되고, 승인 event에는 `PermissionRequest` hook이 필요하다. 정확한 hook payload는 확인하지 않았다(미정 항목 V4).

이 계획의 결정: agent 상태는 hook event가 있으면 그것으로 정한다. 화면 발견적 판단은 hook이 없는 터미널에만 쓰고, 발견적 판단이라고 표시한다. 상태를 구현하기 전에 V4(Codex hook payload)와 V5(Claude Notification payload 필드)를 확인한다.

## 터미널 간 메시징(결정 D3)

감시하는 폴더가 바뀌면 터미널끼리 알린다. 계약은 모든 agent에 같은 경로 하나를 쓴다.

- 메시징 event의 유일한 원천은 터미널 sidecar가 관찰하는 파일 event다. sidecar는 터미널이 등록한 폴더를 감시하고, 변경마다 event를 낸다. polling하지 않는다.
- agent hook(Claude Code `FileChanged`, Codex hook event)은 전달 경로에 들어가지 않는다. agent 상태를 보강하는 데만 쓸 수 있다(터미널 상태 절). 메시지는 어떤 agent가 파일을 썼든 같은 방식으로 전달된다.
- 트리거는 터미널을 통해 동작한다. 등록된 터미널에 입력을 주입하거나 선언된 명령을 실행한다. agent API를 쓰지 않는다.
- 전달 지연은 공용 머신에서 측정한 뒤에 계약에 적는다. 공용 머신 측정에서 기록된 FSEvents 지연은 3~14초이므로, 측정 전에는 어떤 보장 수치도 쓰지 않는다(미정 항목 V6).

한 경로로 두는 이유: Codex에는 파일 변경 event가 없고, Claude의 `FileChanged`는 Claude 세션 안에서만 돈다. 두 경로를 두면 같은 메시지가 서로 다른 시점에 도착하거나 아예 도착하지 않는다.

## agent 전달(결정 D4)

메시지의 전달 경로는 기준 하나로 정한다. agent가 제공하는 더 나은 경로를 쓴다.

- 기본 경로: 등록된 터미널에 입력 주입. 메시지, 명령, skill 호출은 선언된 형식 하나로 보낸다. TUI가 입력을 대기열에 넣는 것은 받아들인 동작이다. sidecar는 터미널 상태로 막지 않으며, 대화상자나 타이밍 같은 TUI 동작을 우회하지 않는다.
- 더 나은 경로가 있으면 쓴다: agent가 제공하는 경우 sok 서버의 MCP 도구(`messages.read`, `messages.wait`). 결과가 구조화되고 대화에 입력이 남지 않는다. agent의 클라이언트가 MCP 도구를 지원하면 그 경로를 쓴다.
- skill은 두 경로의 사용법을 더 잘 안내한다. 전달은 skill에 의존하지 않는다.

미정 항목 V7: 각 클라이언트(Claude Code, Codex)에서 기다리는 MCP 도구 호출의 제한 시간. 이 값이 `messages.wait`가 돌아오는 방식을 정한다.

## 방안과 결과

각 방안은 명령이다. 결과는 한정된다. 모든 읽기는 `count`를 받고 상한이 있으며, 상한을 넘는 읽기는 명시적 오류로 실패한다.

1. **viewport 조각**(`screen.read {from, count}`). viewport의 `from`부터 `from + count`행을 돌려준다. parameter 없는 기존 호출의 결과는 그대로 둔다.
2. **평문**(`screen.text {from, count}`와 `history.text {from, count}`). 각 행을 뒤쪽 공백을 뺀 글자로 돌려주고 `wrapped` 표시를 붙여서, 읽는 쪽이 cell을 파싱하지 않게 한다. cell 형식은 방안 1로 계속 쓸 수 있다.
3. **절대 행 번호로 기록 읽기**(`history.read {from, count, format}`). 유지되는 기록의 행을 절대 행 번호로 읽는다. 결과는 `first`(가장 오래된 유지 행), `last`(가장 새 행), `dropped`를 담는다. 기록을 지우기 전까지 절대 번호는 의미가 바뀌지 않으며, 지워진 양은 `dropped`가 보고한다.
4. **검색**(`history.find {pattern, from, limit}`). 일치하는 항목의 절대 행 번호와 일치한 글자를 최대 `limit`개까지 돌려준다. pattern은 정규식이며, 잘못된 pattern은 오류 글을 담아 실패한다.
5. **셸 마크로 명령 출력 읽기**(`command.list {limit}`와 `command.read {index, format, from, count}`). 명령 하나는 `C` 마크와 다음 `D` 마크 사이의 행이며, `D`의 종료 코드를 가진다. `command.list`는 각 명령의 index, 절대 시작과 끝, 종료 코드를 준다. 셸 통합이 없는 터미널은 빈 목록을 돌려주고, `command.list`는 마크를 본 적이 없다고 밝힌다.
7. **agent 대화**(`agent.conversation {limit, after}`). 전경 프로세스(`claude` 또는 `codex`)로 session의 agent를 찾고 그 session 파일을 읽어, 메시지를 순서대로 역할, 글, 시각과 함께 돌려준다. 파일은 같은 사용자의 디스크에서 읽으며 sidecar는 화면을 해석하지 않는다. session에 속한 파일은 session의 작업 디렉터리와 그 디렉터리의 가장 새 파일(Claude), 또는 `session_meta`의 작업 디렉터리(Codex)로 정한다. 각 결과는 읽은 파일과 파일을 찾았는지를 밝힌다.
6. **원시 출력 로그**(`transcript.read {offset, bytes}`). 고정된 바이트 상한의 로그에서 세션의 PTY 출력 바이트를 offset부터 돌려준다. 구현 전에 메모리 상한 결정이 필요하다(결정 D1).

모든 읽기는 멱등하다. 상태를 바꾸지 않으며, 내용이 바뀌기 전까지 같은 요청은 같은 결과를 돌려준다. 결과는 `generation`을 가지며, sidecar는 내용이 바뀔 때마다 이를 증가시킨다. 호출자는 이로써 결과가 오래되었는지 알 수 있다.

## 각 방안이 놓이는 곳

- Sidecar: 방안 1부터 5까지는 `vt`와 `alacritty` 두 sidecar에 모두 구현한다. 방안 5는 `vt`의 OSC 133 처리(V1)가 필요하다. `vt`가 마크를 파싱하지 않으면 명령 목록은 비어 있고, 그 명세가 그렇게 밝힌다.
- Plugin: `terminal`과 `term`은 각 명령을 schema와 함께 선언하고, 같은 status와 명령 이름으로 노출한다. 각 plugin은 자기 sidecar의 공유 계약 case를 검사한다. plugin 테스트는 다른 plugin의 파일을 읽지 않는다.
- Core: 변경 없음. 명령은 plugin의 선언된 노출을 쓴다.

## 버전과 release 순서

1. sidecar `alacritty`와 sidecar `vt`가 각자 버전으로 명령을 release한다.
2. plugin `term`과 `terminal`이 각각 명령을 가진 sidecar release로 의존 버전을 올리고 release한다.
3. Core는 이 제안으로 바뀌지 않는다.

버전은 각 부분을 소유한 repository의 규칙에 따라 release 때 정한다.

## 검증

- 각 방안은 소유 sidecar의 Red 테스트를 가진다. 변경 전에 실패한 assertion을 기록한다.
- 공유 계약 case는 두 sidecar와 두 plugin에서 모두 실행한다.
- 방안 3과 5는 유지 기록을 넘는 긴 세션으로 검사하고, 변경 전후의 절대 번호를 비교한다.
- 읽기 비용(시간과 메모리)의 측정은 개발이 끝난 뒤 소유 repository의 계획대로 한다.

## 미정 항목

- V1: `vt`가 OSC 133 마크를 어떻게 처리하는지 확인한다(`sidecars/vt`, `vt-core`).
- V2: 실행 중인 Claude Code 또는 Codex session에서 `term`과 `terminal` 각각 스크롤을 재현한다(휠 경로와 전후 offset). 각 TUI가 휠을 받았을 때 자기 내용을 스크롤하는지도 확인한다.
- V3: 방안 7을 위해 macOS에서 sidecar가 session의 전경 프로세스를 어떻게 알 수 있는지 확인한다.
- D1: 방안 6의 로그 바이트 상한을 구현 전에 정한다.
- D2: `history.find`가 글자만 검색할지, cell의 스타일도 검색할지 정한다.
