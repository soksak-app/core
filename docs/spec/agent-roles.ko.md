# Agent roles

[English](agent-roles.md)

이 문서는 terminal agent의 tab이 role을 받는 방법과, soksak이 agent가 role을 가졌다고 확인하는 방법을 정의한다. 구현과 검증은 [features](../features.ko.md)에서 추적한다. 메시지는 [messaging](messaging.md#injected-message)의 주입 경로로 agent에게 전달된다.

## Decision

- agent CLI를 시작하는 tab은 첫 message로 stable identity를 CLI에 준다. identity에는 tab의 role 파일 절대 경로가 적힌다. role 문장은 terminal에 붙여 넣지 않고 agent가 파일에서 읽는다.
- surface는 tab 하나의 surface이므로, surface의 role 파일은 tab 하나에 속한다. role 파일은 application의 configuration directory에 있으며 person의 repository에는 두지 않는다. 정의를 짧게 유지한다. agent는 변경 때마다 파일 전체를 읽으므로 짧은 정의를 권장하지만, soksak은 어떤 길이의 정의든 받아들인다. role 파일의 마지막 줄은 role의 fingerprint(fingerprint)이다.
- fingerprint은 결정적이다. 같은 role 이름과 같은 정의는 언제나 같은 fingerprint을 낸다. agent는 파일 마지막 줄에서 fingerprint을 읽고, 계산하지 않는다.
- agent는 두 방식 중 하나로 확인한다. 명령 `sok role confirm <fingerprint>`, 또는 답변 안의 줄 `soksak role <fingerprint>`다. soksak이 현재 fingerprint을 받았을 때만 role은 `ready`다. 줄 방식은 모든 CLI에 쓰며, 줄 앞에 글자나 숫자가 붙는 CLI는 `sok role confirm`으로 확인한다([확인](#confirmation)).
- 확인하지 않는 agent는 확인할 때까지 바쁘지 않음 보고마다 reread request을 받는다. 상한은 없으며, 각 요청은 record `plugin.<plugin>.messages.delivered`에 kind `role-reread`로 쓴다. 어떤 단계도 timer로 정하지 않는다.
- role 할당이나 변경은 role 파일을 원자적으로 다시 쓰고, 파일 경로를 적은 변경 message를 보낸다. surface의 작업은 도착 순서대로 직렬화한다.
- agent는 role을 CLI의 어떤 persistent memory에도 쓰지 않는다.

이유: [Measured facts](#measured-facts)에 적힌 측정은 다음을 보여준다. launch flag는 새 session에만 적용되고, `resume`은 session 시작의 지시를 유지한다. role 파일 경로를 받은 agent는 파일을 읽고, 변경 message 뒤에 다시 읽는다. message나 launch에 텍스트로 든 role은 나중 message로만 바꿀 수 있다. 현재 role을 담는 곳은 파일 하나뿐이다.

## Measured facts

Claude Code 2.1.329와 Codex 0.171.0을 대화형 TUI로 측정했다. 측정은 disposable configuration directory를 쓰는 application에서 했다. 각 행은 한 번의 실행이며 agent가 답한 관찰 결과를 적는다.

| # | 실행 또는 동작 | 관찰 결과 |
| --- | --- | --- |
| 1 | `claude --append-system-prompt-file F`, F에 role 텍스트 | F의 role이 TUI에 적용되었다. |
| 2 | `claude --resume ID --append-system-prompt-file G` | session은 시작 때의 지시를 유지했고 G는 적용되지 않았다. |
| 3 | 실행 중인 Claude session에 새 role을 할당하는 message | 새 role이 launch role을 대체했다. |
| 4 | `codex --no-daemon -c developer_instructions="..."` | 지시가 TUI에 적용되었고, person의 전역 `AGENTS.md`가 그 옆에서 계속 적용되었다. |
| 5 | 실행 중인 Codex session에 새 role을 할당하는 user message | developer-instruction role이 유지되었다. |
| 6 | `codex resume --no-daemon ID -c developer_instructions=...` | session 시작의 developer instructions가 유지되었다. |
| 7 | 안정 identity와 접두어가 붙은 role message를 쓰는 Codex | 가장 최근 role message가 role을 정의했다. |
| 8 | role 파일 경로만 주는 Codex launch. 파일을 바꾸고 변경 message를 보냄 | agent는 첫 답변에서 파일을 읽었고, 변경 message 뒤에 다시 읽어 새 role을 따랐다. |
| 9 | flag 없이 첫 message에 경로를 넣은 Claude Code. 파일을 바꾸고 변경 message를 보냄 | agent는 파일을 읽었고, 변경 뒤에 다시 읽어 새 role을 따랐다. |
| 10 | `claude --model haiku --append-system-prompt-file <identity file>`. identity 파일에는 경로와 변경 뒤 다시 읽으라는 규칙만 있음 | agent는 role 파일을 읽었고, 파일이 바뀌고 변경 message가 간 뒤 다시 읽어 새 role을 따랐다. |
| 11 | 열린 Bash permission prompt가 있는 Claude Code 2.1.329(`--permission-mode default`)에, prompt 중에 변경 message를 보냄 | `<plugin>.program`이 `{state: blocked, kind: permission}`을 보였고, `<plugin>.messages`는 `{reason: blocked, kind: permission}`와 `pending` 1로 message를 보류했으며 아무것도 붙여 넣지 않았다. 사람이 Esc로 prompt를 닫자 message가 주입되었고 Claude Code가 그에 따라 행동했다. |
| 12 | Claude Code 2.1.329, `.claude/settings.json`에 `SessionStart` command hook을 둔 folder에서 새로 시작. 로그인 없음(probe 전용 configuration home) | hook이 로그인 검사 전에 `source` `startup`으로 실행되었다. |
| 13 | Claude Code 2.1.329, 12행 session에 `claude -p --resume ID` | hook이 `source` `resume`으로 실행되었다. |
| 14 | Codex 0.171.0, `codex exec --trust`로 신뢰한 folder에서 새 `codex exec`(probe 전용 configuration home). `.codex/hooks.json`에 `SessionStart` command hook | hook이 `source` `startup`으로 실행되었다. 이후 실행은 로그인이 없어 첫 model 호출에서 HTTP 401로 멈추었다. |
| 15 | Codex 0.171.0, 14행 session에 `codex exec resume --last` | hook이 `source` `resume`으로 실행되었다. |
| 16 | Claude Code 2.1.329, TUI, 기본 로그인으로 새로 시작. `.claude/settings.json`에 `SessionStart` command hook이 있음 | hook이 `source` `startup`으로 실행되었다. |
| 17 | Claude Code 2.1.329, TUI, 16행 session에서 `/clear` | hook이 `source` `clear`로 실행되었다. |
| 18 | Claude Code 2.1.329, TUI, 17행 session에서 prompt 하나 뒤 `/compact` | `PreCompact`가 `trigger` `manual`로 실행된 뒤 `SessionStart`가 `source` `compact`로 실행되었다. |
| 19 | Claude Code 2.1.329, TUI, probe 전용 환경 변수 `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=1`로 강제한 auto-compaction. prompt 하나 뒤 | `PreCompact`가 `trigger` `auto`로 실행된 뒤 `SessionStart`가 `source` `compact`로 실행되었다. |
| 20 | Codex 0.171.0, `--no-daemon --dangerously-bypass-hook-trust`로 한 TUI, 기본 로그인으로 새로 시작. `.codex/hooks.json`에 `SessionStart` command hook이 있음 | 첫 prompt를 제출할 때 hook이 `source` `startup`으로 실행되었다. |
| 21 | Codex 0.171.0, TUI, 20행 session에서 `/clear` | hook이 `source` `clear`로 실행되었다. |
| 22 | Codex 0.171.0, TUI, 21행 session에서 prompt 하나 뒤 `/compact` | hook이 `source` `compact`로 실행되었다. |
| 23 | Codex 0.171.0, auto-compaction | 측정하지 않았다: 0.171 binary에는 auto-compaction 임계값의 설정 key가 없다(binary의 문자열로 확인). Codex 문서 요약은 compaction이 `source` `compact`의 `SessionStart`를 실행한다고 말하지만, 그 문장은 검증하지 않았다. |
| 24 | Claude Code 2.1.329, `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"The probe word is ZEBRA-7."}}`를 출력하는 `SessionStart` command hook. 새로 시작, `/clear`, `/compact` 뒤 "What is the probe word?"라고 묻음 | 세 source 각각의 뒤에 model이 `ZEBRA-7`로 답했다. |
| 25 | Codex 0.171.0, `.codex/hooks.json`에 같은 hook 출력. 새로 시작, `/clear`, `/compact` 뒤 같은 질문 | 세 source 각각의 뒤에 model이 `ZEBRA-7`로 답했다. |

3행과 7행은 agent가 새 role을 지정하는 변경 message를 따른다는 것만 보여준다. 파일을 읽는다는 사실은 보여주지 않는다. 각 행은 한 번의 실행이다. persistent memory를 쓰지 말라는 규칙은 지시일 뿐이다. 측정된 launch 옵션 중 두 CLI의 memory를 끄는 옵션은 없다.

측정은 기본 로그인으로 대화형 TUI에서 두 CLI의 `SessionStart` source 값을 다뤘다(16행부터 22행). Claude Code는 `PreCompact`도 `trigger` `manual`과 `auto`로 실행했다. Codex 0.171.0은 25행이 보이듯 `SessionStart` hook 출력의 `additionalContext` 필드를 받는다. Codex의 auto-compaction은 측정하지 않았다(23행). Codex 0.171.0은 신뢰하지 않은 folder의 project 설정을 경고와 함께 끄며, `codex exec --trust`가 이를 켠다. `--dangerously-bypass-hook-trust`를 쓰면 `--no-daemon`을 함께 쓰지 않는 한 Codex TUI는 그 flag가 embedded mode를 요구한다는 경고를 보인다.

Claude Code는 permission prompt를 [terminal state](terminal-state.md)의 프로그램 상태로 `blocked`라고 보고한다(11행). 그래서 [messaging](messaging.md#hold-for-the-person)의 `blocked` 보류가 prompt가 열린 동안 변경 message와 reread request을 보류한다.

## Launch

모든 agent CLI는 같은 방식으로 시작한다. `program`이 가리키는 프로그램을 `args`의 인자와 함께 실행하며, core는 인자를 더하지 않는다. identity는 session의 첫 message로 CLI에 전달된다([첫 message](#first-message)). Codex는 `args`에 `--no-daemon`을 받아 시작하며, 이는 [cli](cli.md)가 적는다.

줄 방식 확인은 모든 CLI에 적용되며, 명령 방식은 shell이 있는 agent에 적용된다([확인](#confirmation)).

agent CLI는 CLI가 이미 신뢰하는 폴더에서만 시작한다. 폴더 신뢰나 업데이트를 묻는 CLI는, 주입이 자기 프롬프트에 Enter를 보낸다. 이는 [evidence of the hold](messaging.md#evidence-of-the-hold)에 측정되어 있다.

## Start parameters

terminal tab이 agent CLI를 실행할 때 `core.layout.open`의 `params`에 다음 parameter를 준다. terminal plugin이 받는다.

- `program`: agent CLI의 이름 또는 경로. 없으면 tab은 이전과 같이 shell을 시작한다.
- `args`: 텍스트의 배열이며 program의 인자다. 없으면 빈 배열이다.
- `role`: `null` 또는 agent role 식별자. role이 있는 tab은 launch 전에 role 파일을 쓰며([role 파일](#role-file)), 첫 message가 identity를 싣는다.

core는 `args`를 `program`에 그대로 넘기며 인자를 더하지 않는다. `program` 없이 `role`이 오면 `role requires program`으로, `program` 없이 `args`가 오면 `args require program`으로 거부하며, 두 경우 모두 어떤 program도 시작하지 않는다.

sidecar 프로토콜 변경: terminal session의 `open` 요청은 `directory` 옆에 `program`(텍스트)과 `args`(텍스트 배열) 멤버를 더한다. `program`이 있으면 sidecar는 shell 없이 `program`을 `args`를 인자 벡터로 하여 시작한다. bare name인 `program`은 session 환경의 PATH로 찾고, 구분자를 담은 상대 경로는 session의 `directory`에서 찾는다. 찾지 못한 `program`은 reason이 `program not found: <program>`인 `openFailed` 답으로 시작이 실패한다. program session에는 shell integration이 없어 OSC 133 mark를 보내지 않으며 shell 상태도 없다. `program`이 없으면 sidecar는 이전과 같이 shell을 시작한다. sidecar는 다음 문장으로 `open` 요청을 거부하며 아무것도 시작하지 않는다: 빈 `program`은 `open program must be a non-empty text`, 텍스트 배열이 아닌 `args`는 `open args must be an array of texts`, `program` 없이 온 `args`는 `open args require program`, `program`과 `shell`을 함께 설정한 요청은 `open program and shell are both set`. terminal page는 조립한 `program`과 `args`를 보내며 launch의 다른 인자는 보내지 않는다. 각 terminal sidecar가 이 변경을 구현하며, 그 후속 항목은 [features](../features.ko.md)에 추적한다.

## Stable identity

안정 identity는 tab의 launch가 전달하는 텍스트다. 영어로 쓰며 다음 형식이다. `<role file>`은 tab의 role 파일 절대 경로다.

> [soksak role] Your role is defined in the file <role file>. Read the whole file before your first answer. Read the file again when a message starts with [soksak role] and says that the role changed. Do not save your role in any persistent memory. The role file is the only record of your role.

- identity는 message 접두어를 적으므로 agent는 그 접두어가 붙은 변경 message를 role의 권한으로 알아본다.
- identity는 role 파일 경로를 적으므로 agent는 role을 파일에서 읽는다.
- 경로는 절대 경로이며 application의 configuration directory에서 온다. 따옴표나 제어 문자가 있는 경로는 `configuration directory <path> holds a quote or a control character`로 거부하며 launch는 어떤 program도 시작하지 않는다.
- identity는 모든 CLI의 첫 message이며, session이 시작할 때마다 보낸다.

## Role file

- 경로: `<config-dir>/agents/<surface>/role.md`. `<config-dir>`은 application의 configuration directory([installation layout](installation.md#installation-layout))이고 `<surface>`는 tab의 surface다. 경로 구분자, `..` 구간 또는 제어 문자를 담은 surface 식별자는 `surface "<value>" holds a path part or a control character`로 거부하며, `<value>`는 surface 식별자다. 그 문장으로 거부할 때는 아무것도 쓰지 않는다.
- 한국어 파일: `<config-dir>/agents/<surface>/`의 `role.md` 옆 `role.ko.md`. 첫 줄의 한국어 번역([fingerprint reference cases](#fingerprint-reference-cases)의 `texts_ko`), 정의의 한국어 텍스트(`roles.json`의 `ko`), 마지막 줄의 같은 fingerprint 줄을 담는다. Fingerprint은 `role.md`에만 계산한다. Agent에게 이름을 주는 파일은 `role.md`뿐이므로 agent는 `role.md`만 읽는다.
- 구조, 순서대로:
  1. 첫 줄: ``Read this whole file. Follow the role it defines. Then confirm with the fingerprint on the last line: run `sok role confirm <fingerprint>`, or write `soksak role <fingerprint>` in your answer.``;
  2. 정의 텍스트. `roles.json`에 저장된 그대로다.
  3. 마지막 줄: fingerprint.
  각 줄은 line feed 하나로 끝난다. 저장된 텍스트에 마지막 line feed가 없는 정의는 파일에 line feed 하나가 붙는다. fingerprint은 저장된 텍스트 그대로 계산한다. role이 없는 tab은 role 파일도 identity도 없다([Tab role state](#tab-role-state)).
- fingerprint: role 식별자, line feed 하나(U+000A), 저장된 정의 텍스트를 이어 붙인 UTF-8 바이트의 SHA-256 digest에서 앞 16자리 소문자 16진수. 식별자에는 줄바꿈이 없으므로 구분자가 모호하지 않다. fingerprint은 식별자와 텍스트에만 의존한다. 같은 정의는 언제나 같은 fingerprint을 낸다.
- 길이: soksak은 정의를 길이와 상관없이 그대로 쓴다. 짧은 정의를 권장하며 그 이유는 위에 적었다.
- 파일은 configuration directory에 속하며 person의 repository에는 속하지 않는다.
- 모드: 디렉터리 `<config-dir>/agents/<surface>/`는 모드 0700으로 만든다. `role.md`는 모드 0600으로 쓴다. 임시 파일의 모드는 이름을 바꾸기 전에 확인한다. 모드가 다르면 최종 이름으로는 보이지 않으며, 쓰기는 `role file <path>: mode <mode> is not 0600`으로 실패하고 임시 파일을 지운다. 각 쓰기 단계의 실패는 `role file <path>: write failed: <os error>`로 실패하며, `<path>`는 그 단계가 쓴 경로다. `role.ko.md`도 모드 0600으로 쓴다.
- 원자적 쓰기: host는 같은 폴더에 `.role-<random>.tmp` 이름의 임시 파일에 새 내용을 쓰고 `role.md` 위로 이름을 바꾼다. 읽는 쪽은 이전 파일 전체 또는 새 파일 전체만 본다. launch는 첫 쓰기 전에 surface 폴더에서 `.role-*.tmp`와 맞는 파일을 지운다. 이전 충돌이 남긴 파일이다. 두 파일은 같은 순서를 따른다. host는 각 임시 파일을 쓰고 모드를 확인한 뒤 `role.md`를 먼저, `role.ko.md`를 다음에 이름 바꾼다. `role.ko.md`의 이름 바꾸기 실패는 `role file <path>: rename failed: <os error>`로 보고하며, `<path>`는 그 파일의 경로다.
- 쓰는 주체: host가 파일을 쓴다. terminal page는 파일을 만들지 않는다. 실패한 쓰기는 `role file <path>: write failed: <os error>`라는 문장으로 경로와 이유를 적는다. launch의 role 파일 쓰기가 실패하면 `role file <path>: write failed: <os error>` 문장으로 launch를 거부하며 어떤 program도 시작하지 않는다.
- 수명: host는 launch 전에 디렉터리를 만든다. tab이 layout에서 제거되면 host는 tab의 프로그램을 멈추고, 진행 중인 쓰기가 끝나기를 기다리고, 그 tab의 이후 role 변경을 `tab <tab> was removed; its role cannot change`로 거부하며, 디렉터리를 지운다. 제거 뒤의 이름 바꾸기가 실패하면 임시 파일을 지우고 `role file <path>: rename failed: <os error>` 문장으로 기록한다. 제거된 tab의 보류 message는 버린다. 각 message마다 state `skipped`와 reason `tab removed`의 delivery record를 쓴다. 제거된 tab은 resume할 수 없다.

## Fingerprint reference cases

알고리즘은 공유 사례 파일 `docs/spec/cases/agent-roles/fingerprint.json`으로 검사한다. 각 사례는 식별자, 정의 텍스트, 기대 fingerprint을 준다. 같은 파일은 고정 문구(`texts`)와 `role.ko.md`의 한국어 첫 줄(`texts_ko`)을 담으며, [Phrase test](#phrase-test)가 이를 검사한다. Go host와 Rust host는 모든 사례를 실행해 계산한 fingerprint을 비교한다. 사례에는 non-ASCII 텍스트와 줄바꿈이 있어 UTF-8 인코딩과 구분자를 모두 검사한다. 두 host의 값은 같다.

## Role definitions

role 파일이 담는 정의 텍스트는 soksak이 `<config-dir>/roles.json` 하나에 저장한다. 이 파일은 `settings.json`, `projects.json`과 나란히 둔다([stored data formats](installation.md#stored-data-formats)). 파일은 번호가 있다. member `format`은 `2`이며, reader는 이 번호만 받고 다른 번호는 `<file>: roles: format must be 2, found <value>`로 거부한다. 정의의 한국어 번역은 member `ko`이며, `ko`가 추가되어 형식이 1에서 2로 올랐다. reader는 형식 1을 migration 없이 거부하고, 형식 1인 추적 파일은 같은 변경에서 형식 2로 고친다.

```json
{"format": 2, "roles": {"reviewer": {"text": "You review the changes of the other agents in this project.", "ko": "이 프로젝트의 다른 agent 변경을 검토한다."}}}
```

- role 식별자는 `[a-z][a-z0-9-]*`에 맞고 최대 64자다.
- `text`는 UTF-8 텍스트이며 role 파일에 그대로 쓴다.
- `ko`는 `text`의 한국어 번역인 UTF-8 텍스트이며 `role.ko.md`에 그대로 쓴다. 필수다. `ko`가 없는 정의는 거부하므로 짝이 빠질 수 없다. soksak은 번역하지 않는다.
- tab이 이름을 댄 role이 `roles.json`에 없으면 `unknown agent role <id>`로 거부하고, tab은 이전 role을 유지한다.

`<file>`은 `roles.json`의 경로다. 읽기나 쓰기는 아래 줄 중 맞는 문장으로 파일 전체를 거부하며, 예를 들면 `<file>: roles: format must be 2, found <value>`이다. 문장은 파일을 적고 아무것도 쓰지 않는다:

- `<file>: roles: format must be 2, found <value>`: `<value>`는 member `format`의 compact JSON 텍스트이며, member가 없거나 문서가 객체가 아니면 `null`이다.
- `<file>: roles: unknown field <name>`: `format`과 `roles`가 아닌 최상위 member.
- `<file>: roles: roles must be an object`
- `<file>: roles: invalid role identifier <id>`: 정렬 순서의 식별자 중 맞지 않는 첫 식별자.
- `<file>: roles: role <id> must be an object`
- `<file>: roles: role <id> unknown field <name>`: `text`와 `ko`가 아닌 정의의 member.
- `<file>: roles: role <id> ko must be a string`: member `ko`가 없거나 문자열이 아니다.
- `<file>: roles: role <id> text must be a string`

정의를 편집하는 도구는 별도의 checklist 항목이다.

## Tab role state

agent CLI의 각 tab은 agent role을 하나 가지거나 없다. `projects.json` layout의 각 tab은 member `role`을 가진다. 값은 `null`(role 없음)이거나 role의 저장된 기록 전체다. 기록은 정확히 다음 네 member를 가진다.

- `id`: role 식별자이며 [role 정의](#role-definitions)의 식별자 규칙을 따른다;
- `generation`: 1 이상의 정수. 1에서 시작하고, role이나 정의가 바뀔 때마다 1씩 오른다;
- `fingerprint`: 현재 role 파일의 지문, 소문자 16진수 16자리;
- `confirmedFingerprint`: agent가 확인한 지문, 소문자 16진수 16자리, 없으면 `null`.

부분 기록은 없다. member `role`이 없거나, 값이 `null`도 아니고 위 네 member의 형태를 갖춘 기록도 아닌 tab은 명시적 오류로 거부하며, 오류는 file, tab, member를 밝힌다. 오류 문장은 `projects.json: project <root> space <space>: tab <tab> member role is missing` 또는 `... member role is invalid`다. role 없이 만든 tab은 `role: null`을 저장한다.

이 member가 `projects.json`에 처음 들어가는 형식이 4이므로, [저장 데이터 형식](installation.md#stored-data-formats)에 따라 형식 번호를 3에서 4로 올린다. migration은 쓰지 않는다. reader는 형식 3 file 전체를 `<file>: projects: format must be 4, found 3`으로 거부하며, `<value>`는 file이 담은 member `format`의 compact JSON 텍스트이며, member가 없거나 문서가 객체가 아니면 `null`이다. `3`은 이 예의 file 값이다. 거부된 file의 모든 쓰기는 그 오류로 실패한다.

role 변경은 registry를 거치는 명령 `core.tab.role {tab, role}`이다. tab이 이미 가진 role과 같은 정의를 설정하면 파일을 쓰지 않고, generation을 바꾸지 않고, message를 보내지 않으며, 답은 현재 `{role, generation, state, fingerprint}`다.

`role`을 `null`로 하는 `core.tab.role`은 role과 role 파일을 지운다. role 없이 launch한 tab은 role 파일이 없다.

변경은 다음 순서로 실행하며, 각 단계는 앞 단계가 성공해야 시작한다.

1. host가 새 role 파일을 임시 이름으로 새 fingerprint과 함께 쓰고 모드를 확인한다;
2. host가 기록 `{id, generation, fingerprint, confirmedFingerprint: null}`을 `projects.json`의 tab member `role`로 저장한다;
3. host가 임시 파일을 `role.md`로 이름 바꾼다;
4. host가 상태 `core.tab.role`을 `{role, generation, state: "pending", seq, fingerprint, path}`로 게시한다;
5. terminal page가 변경 message를 보낸다([Change message](#change-message)).

실패 규칙: 1단계 실패는 `role file <path>: write failed: <os error>` 문장으로 임시 파일을 지우고 아무것도 저장하지 않는다. 2단계 실패는 임시 파일을 지우고, 저장된 role은 그대로 두며, `role file <path>: write failed: <os error>` 오류로 보고한다. 3단계 실패는 임시 파일을 지운 뒤 `projects.json`의 이전 기록을 복원한다. 복원도 실패하면 쓰기 오류와 `projects.json <path>: restore failed: <os error>`를 함께 보고한다. 단계 사이에 host가 끝나면, 다음 launch가 CLI를 시작하기 전에 `projects.json`의 기록과 `roles.json`의 정의 텍스트로 role 파일을 다시 쓴다. fingerprint이 기록과 다르면 `role file <path>: fingerprint differs from the record`로 쓰기를 거부한다.

상태 `core.tab.role`의 값은 `{role, generation, state, seq, fingerprint, path}`다. `state`는 `pending`, `ready`이며 role이 없으면 `null`이다. `fingerprint`는 현재 role 파일의 fingerprint이고 role이 없으면 `null`이다. `path`는 tab의 role 파일의 절대 경로 `<config-dir>/agents/<surface>/role.md`이고 role이 없으면 `null`이다. `seq`는 변경마다 오른다. role 명령의 답도 `fingerprint`와 `path`를 담는다. page는 상태의 `path`와 `fingerprint`로 변경 message와 reread request을 만들며, 오류 문장은 fingerprint을 담지 않는다. page는 view call `runtime.status.watch`를 `{name: "core.tab.role", surface}`로 보내 상태를 받는다. `surface`는 terminal 자신의 surface이며, polling하지 않는다([view surfaces](native-surfaces.md#view-surfaces)).

## Confirmation

상태는 다음과 같다.

- `pending`: role 파일이 가진 fingerprint을 agent가 아직 확인하지 않았다. role 할당, role 변경, role을 가진 tab의 launch가 이 상태를 만든다.
- `ready`: `confirmedFingerprint`가 현재 role 파일의 fingerprint과 같다.
- `null`: tab에 role이 없다.

변경은 generation과 fingerprint이 새것이므로 상태를 `pending`으로 되돌린다.

agent는 두 방식 중 하나로 확인하며, 어느 쪽이든 인정된다. 명령 방식은 선언된 명령 `core.tab.role.confirm {fingerprint}`를 실행하며, [cli](cli.md#commands)가 이를 `sok role confirm`으로 노출한다.

- (a) 명령 `sok role confirm <fingerprint>`. shell이 있는 agent가 쓴다. `sok`은 요청을 `agent.surface`가 프로세스에 대해 답하는 surface와 함께 application에 보낸다([processes of a surface](sidecars.md#processes-of-a-surface)). 그래서 tab 밖의 프로세스는 그 tab 대신 확인할 수 없다.
- (b) agent 답변 안의 줄 `soksak role <fingerprint>`. terminal plugin은 `<plugin>.screen.read`가 읽는 화면의 보이는 행에서, 보이는 행이 바뀔 때마다 이 줄을 찾는다. 행은 양 끝의 공백을 뺀 뒤 `soksak role <fingerprint>`로 끝나고, 그 앞이 비어 있거나 글자와 숫자가 아닌 문자들 뒤에 공백 하나 이상이 오면 맞는다. 그래서 `⏺ soksak role <fingerprint>`(Claude Code)와 `• soksak role <fingerprint>`(Codex CLI)는 맞고, 줄 앞에 글자나 숫자가 있으면 맞지 않는다. 이 규칙은 공유 case 파일 `docs/spec/cases/agent-roles/confirmation-line.json`으로 고정하며, page의 matcher test가 이를 실행한다. 보이는 도구 출력의 줄도 인정된다. 형식은 소문자 16진수 16자리의 정확한 줄이며, 파일의 fingerprint만 있는 줄은 맞지 않는다. 찾은 줄은 같은 surface별 직렬화를 거쳐 확인한다. terminal이 폭에서 감싼 줄은 맞지 않으며, 상태는 `pending`에 머물고 reread request이 다시 묻는다. 갱신이 읽히기 전에 행이 화면 밖으로 밀려난 줄도 맞지 않는다. 줄은 현재 파일의 fingerprint을 agent가 가졌음을 보이며, 파일을 읽었음은 보이지 않는다. page는 일치한 줄을 view call `runtime.command`로 `core.tab.role.confirm`을 `{fingerprint}`와 함께 자기 surface에서 확인한다([view surfaces](native-surfaces.md#view-surfaces)). core 명령은 호출자의 surface에서 실행되며, 이는 `sok`이 보내는 명령과 같다.

줄 방식은 모든 CLI에 적용되며, 명령 방식은 shell이 있는 agent에 적용된다. 적용되지 않는 방식은 그 agent에게 제시하지 않는다.

soksak은 confirmation을 surface의 직렬화 안에서, 차례가 왔을 때의 상태에 맞춰 판정한다.

- 16자리 소문자 16진수가 아닌 값은 직렬화 전에 `fingerprint <value> is not 16 lowercase hexadecimal characters`라는 invalid-argument 오류로 거부한다. 아래 오래된 confirmation 규칙은 유효한 값에만 적용된다;
- fingerprint이 현재 fingerprint과 같고 상태가 `pending`이면: `confirmedFingerprint`를 저장하고, 상태를 `ready`로 바꾸고, `seq`를 올리고, 보류된 작업 message를 풀어준다;
- fingerprint이 현재 fingerprint과 같고 상태가 `ready`이면: 아무것도 바꾸지 않으며 답은 성공이다;
- fingerprint이 현재 fingerprint과 다르면, 즉 이전 파일의 fingerprint이면: 재시도 없이 `stale fingerprint: read the role file again at <path>`로 거부한다. 오류는 `stale fingerprint: read the role file again at <path>`이며 현재 role 파일의 경로를 적는다. fingerprint은 적지 않는다. 상태는 `pending`에 두고, 다음 바쁘지 않음 보고가 현재 경로와 fingerprint을 적은 reread request을 보내므로 잘못된 fingerprint도 요청을 되풀이한다;
- role이 없는 tab이거나 tab이 없는 surface이면: `surface "<value>" has no tab`, 또는 role이 없는 tab이면 `tab <tab> has no role`로 거부한다.

### Requests

page는 tab의 프로그램 상태([terminal state](terminal-state.md))를 지켜본다. reread request은 role 파일 경로를 적고, agent에게 파일을 읽고 마지막 줄로 확인하라고 요청하는 message다. 변경 message와 첫 message는 요청으로 세지 않는다. 상태가 `pending`인 동안 page는 프로그램이 바쁘지 않다고 보고할 때마다 reread request 하나를 보낸다. 요청은 agent가 확인할 때까지 상한 없이 반복되며, 각 요청은 record `plugin.<plugin>.messages.delivered`에 kind `role-reread`로 쓴다.

각 요청은 status의 현재 경로와 fingerprint을 적는다. 잘못된 fingerprint도 상태를 `pending`에 두므로, 다음 바쁘지 않음 보고가 현재 경로와 fingerprint을 적은 요청을 보낸다. 이 단계들은 timer로 정하지 않는다. 계수는 저장된 기록의 일부이므로 재시작해도 0으로 돌아가지 않는다.

바쁘지 않음 보고는 CLI마다 검증한다. 그 보고가 없는 CLI의 agent는 `pending`에 머물며, 통과로 넘기지 않고 `pending role: tab <tab> waits for a not-busy report of the agent CLI` 문장과 함께 error display로 드러낸다.

## Held messages

상태가 `pending`이면 page는 tab의 작업 message, 즉 등록의 agent message를 보류한다. 보류된 message는 순서를 지키며, 상태가 `ready`가 되면 한 번에 하나씩 주입한다. 각 message는 한 번만 전달된다. delivery record은 파일 이름으로 message를 구분한다. session의 첫 message와 reread request은 `role-pending` 보류로 보류하지 않는다. prompt가 열린 동안에는 [messaging](messaging.md#hold-for-the-person)의 `blocked` 보류가 이들도 보류한다. 보류 근거 `role-pending`은 [messaging](messaging.md#hold-for-the-person)의 보류 목록에 있다. role play는 fingerprint가 확인된 뒤에만 진행하므로, `ready`가 work를 시작하는 때다.

보류된 message가 있는 동안 변경이 일어나면 message는 대기열에 남고, 새 generation의 `ready` 뒤에 전달한다.

## Idempotency

이 규칙들은 파일 쓰기가 아니라 tab의 저장된 role 기록에 작용한다. 각 단계의 멱등성, generation, [동시성](#concurrency)의 surface별 직렬화, `stale fingerprint: read the role file again at <path>` 거부는 그 기록으로 판정하며, 파일은 기록이 정한 때에만 쓴다.

역할 handshake의 모든 단계는 결과를 바꾸지 않고 반복된다.

- 같은 role과 정의로 `core.tab.role`을 반복하면 파일을 쓰지 않고, generation을 바꾸지 않고, message를 보내지 않는다. 이 호출을 반복해도 아무것도 바꾸지 않는다;
- 새 generation은 role이나 정의가 바뀔 때만 만든다;
- 현재 fingerprint으로 `sok role confirm` 또는 답변 줄을 반복하면 `ready`를 답하며 아무것도 바꾸지 않는다. `seq`도 바꾸지 않는다;
- 다시 보내는 reread request은 같은 경로와 같은 fingerprint을 적으므로, 파일을 다시 읽고 다시 확인하면 같은 `ready`가 된다;
- 작업 message는 `ready`가 두 번 도달해도 정확히 한 번 전달된다;
- program이 계속 실행되는 동안 application을 재시작하면 상태는 저장된 기록과 파일에서 다시 만든다. `confirmedFingerprint`가 파일의 fingerprint과 같으면 `ready`다. 아니면 `pending`이다. 파일의 fingerprint이 기록과 다르면 먼저 `roles.json`에서 파일을 다시 쓴다. 다시 쓴 파일의 fingerprint도 기록과 다르면 `role file <path>: fingerprint differs from the record`로 재시작을 거부한다;
- resume은 같은 fingerprint을 가진 `pending`을 준다. resume은 session을 유지하지만 agent가 파일을 읽었다는 증거는 유지하지 않기 때문이다. host는 resume에서 `confirmedFingerprint`를 지우고, resume된 tab은 확인할 때까지 바쁘지 않음 보고마다 reread request을 보낸다. 새 launch도 `confirmedFingerprint`를 지우며, resume과 같다.

role A를 B로 바꾸고 다시 A로 바꾸면 A의 fingerprint이 다시 나온다. 내용이 같으므로 그 fingerprint의 confirmation은 올바르다.

### Tests of the repetitions

- 같은 role과 정의를 상태 `pending` 또는 `ready`에서 다시 할당: role 파일을 쓰지 않는다(inode와 내용이 그대로), 새 generation이 없고, 변경 message가 없으며, 답은 현재 `{role, generation, state, fingerprint}`와 같다.
- 같은 role의 정의를 바꿈: 새 generation과 변경 message 하나.
- A에서 B로, 다시 A로 바꿈: A의 fingerprint이 돌아오고, 그 fingerprint의 confirmation은 `ready`가 된다.
- 현재 fingerprint의 confirmation을 반복: 두 번 모두 `ready`이며, 두 번째 뒤에 `seq`는 바뀌지 않는다.
- 변경 뒤 이전 fingerprint의 confirmation: `stale fingerprint: read the role file again at <path>`로 거부된다. fingerprint은 적지 않는다.
- 16자리 소문자 16진수가 아닌 confirmation 값: `fingerprint <value> is not 16 lowercase hexadecimal characters`로 invalid input으로 거부하며, `stale fingerprint: read the role file again at <path>` 오류를 보내지 않는다.
- confirmation 없이 바쁘지 않음 보고가 여러 번 있으면 보고마다 reread request 하나가 가며, 각 요청은 `plugin.<plugin>.messages.delivered`에 kind `role-reread`로 쓰고, 상한은 없다.
- 작업 message에서 `ready`가 두 번 도달: 파일 이름으로 구분해 한 번만 주입한다.
- confirmation이 저장된 상태에서 재시작: 입력 없이 `ready`. 없으면 입력 없이 `pending`.
- resume: `pending`, 같은 fingerprint, confirmation은 지워짐, 바쁘지 않음 보고마다 reread request을 보낸다.

이 테스트는 실제 파일과 실제 `sok` 명령을 쓰는 단위 테스트다. agent CLI는 실행하지 않는다. host 테스트는 Go host 패키지와 Rust host 패키지에서 실행한다. page 테스트는 page를 소유하는 terminal plugin 저장소에서 실행한다.

## Concurrency

한 surface의 role 작업은 host의 한 소유자가 도착 순서대로 직렬화한다. 작업은 role 할당이나 변경, confirmation(두 방식 모두), 요청, reread request, tab 제거다. 제거 뒤의 confirmation은 `tab <tab> has no role`로 거부한다. 변경마다 generation이 오르며, confirmation은 같은 직렬화 안에서 판정하므로 차례가 왔을 때의 상태에 맞춰진다.

- role 파일은 원자적으로 쓰므로 읽는 쪽은 이전 파일 전체나 새 파일 전체만 본다.
- A에서 B, B에서 C로 연속 변경: 각 변경은 변경 message를 보내며, 각 message는 같은 경로를 가리킨다. 그 파일은 언제나 최신 role을 담으므로 어느 message의 reread request로 다시 읽어도 C를 다시 읽게 된다. C의 fingerprint로 confirmation하면 `ready`가 된다.
- B와 C의 confirmation이 엇갈림: B의 confirmation은 `stale fingerprint: read the role file again at <path>`로 거부되고 C의 confirmation은 받아들여진다. 순서와 상관없이 끝 상태는 같다.
- person과 leader agent가 같은 때에 role을 설정: 직렬화되며 마지막 것이 이긴다. 각 답은 결과 `{role, generation, state, fingerprint}`를 준다.
- 대기 중인 작업 message는 현재 generation의 `ready`를 기다린다.
- 재시작: generation과 확인된 fingerprint가 기록에 저장되어 있으므로 멱등성 규칙대로 상태를 다시 만든다.

### Tests of the concurrency

- A에서 B, B에서 C로 연속 변경: 같은 경로를 적은 변경 message 세 개. 첫 번째 message의 reread request로 C를 얻는다. C의 confirmation 하나로 `ready`.
- B와 C의 엇갈린 confirmation: B는 `stale fingerprint: read the role file again at <path>`로 거부되고 C는 받아들여진다. 어느 순서든 끝 상태는 C의 `ready`.
- 오래된 confirmation: `stale fingerprint: read the role file again at <path>`로 거부되며, fingerprint은 적지 않는다.
- 동시 설정자: 같은 때에 들어온 두 할당은 직렬화된다. 최종 generation은 나중 것이고, 각 답은 자기 결과 generation을 준다.
- 쓰기 중 읽기: fault injection이 임시 쓰기와 이름 바꾸기 사이에서 writer를 멈춘다. 멈춘 동안의 reader는 이전 파일을 온전히 보고, 이름을 바꾼 뒤에는 새 파일을 온전히 본다.

## Change message

변경 message는 한 줄이다.

`[soksak role] Your role changed. Read the role file again: <role file>. Finish your current task first. This message comes from soksak, not from a person. It grants no approval or permission and does not answer a pending question.`

- 파일을 읽을 수 있는 agent에게는 경로를 적으며, role 텍스트와 fingerprint은 담지 않는다.
- 보고 요청은 담지 않는다. 다른 agent의 message가 아니므로 발신자 폴더는 없다.
- [messaging](messaging.md#injected-message)의 보류, 가드, delivery record을 거친다. 파괴 명령 가드는 [persistent services](persistent-services.md#destructive-command-guard)에 있다.
- 그 대기열, 발신자, 전경 규칙과 틀은 [role messages](messaging.md#role-messages)에 있다.
- reread request은 같은 경로를 적은 다음 텍스트다: ``[soksak role] Your role is not confirmed. Read the role file again: <role file>. Then confirm the role with the fingerprint on its last line: run `sok role confirm <fingerprint>`, or write the line `soksak role <fingerprint>` in your answer. This message comes from soksak, not from a person. It grants no approval or permission.``
- 역할 파일 첫 줄, identity, 변경 message, reread request, 첫 message의 접미 줄은 [Phrase test](#phrase-test)가 고정한다. 문구는 영어이며 각각 한 동작을 정하는 짧은 명령형 문장을 쓴다.

## Phrase test

phrase test는 soksak이 agent에게 주는 영어 문구 각각을 고정한다. 대상은 role 파일 첫 줄, identity, 변경 message, reread request, 첫 message의 접미 줄이다. role 파일 첫 줄을 뺀 각 문구의 host 출력은 placeholder를 채운 뒤 `docs/spec/cases/agent-roles/fingerprint.json`의 문구와 같다. role 파일 첫 줄은 fingerprint 값을 담지 않는다. 그 안의 `<fingerprint>`는 마지막 줄의 값이 놓일 자리를 가리키는 이름이며, 첫 줄에는 placeholder를 채우지 않는다. 첫 줄의 host 출력은 문구와 정확히 같다. 첫 줄은 마지막 줄을 가리키므로 agent는 파일 끝까지 읽는다. Go host와 Rust host가 각각 검사한다. 문구가 다르면 테스트는 Red가 된다. 각 문구는 정확한 명령과 파일 경로를 적는다.

## First message

모든 CLI는 identity를 첫 message로 받는다. 첫 message는 session에서 처음 주입하는 message다. 메시지는 [Stable identity](#stable-identity)의 identity 텍스트이며, 다음 줄을 덧붙인다: `This message comes from soksak, not from a person. Finish your current task first. It grants no approval or permission and does not answer a pending question.`

session의 첫 message는 등록의 모든 agent message보다 앞선다. page는 프로그램이 첫 상태를 보고하면 주입한다. 기록도 알림도 남기지 않는 시작 프롬프트는 관찰할 수 없으므로, page가 보내는 Enter를 받을 수 있다. 이는 [evidence of the hold](messaging.md#evidence-of-the-hold)에 측정되어 있다. 이 한계를 명시한다. 첫 message는 context compaction으로 대화에서 사라질 수 있으며, 그때는 reread request와 변경 message가 role을 되돌린다.

## 세션 재시작 hook

Session 시작 hook은 CLI session의 시작, 재개, `clear`, compaction마다 tab의 stable identity를 CLI에 준다. 그래서 context가 초기화된 직후에 identity가 context 안에 있다. Hook은 [stable identity](#stable-identity)의 identity 텍스트를 주며, role 정의는 절대 주지 않는다. 정의는 agent가 읽는 role 파일에 남는다.

- 명령: `sok role identity`이며 인자가 없다. 명령의 process는 `sok role confirm`처럼 자기 surface를 `agent.surface`에 묻는다([surface의 process](sidecars.md#processes-of-a-surface)). Hook process는 CLI process의 자식이므로 그 조상 사슬이 tab의 surface에 이어진다.
- Role이 있을 때: 표준 출력에 JSON 한 줄 `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"<identity 텍스트>"}}`을 쓰고 종료 상태는 0이다. identity 텍스트는 [stable identity](#stable-identity)의 텍스트이며 `<role file>`은 `<configuration directory>/agents/<surface>/role.md`다. Claude Code와 Codex는 SessionStart hook에서 이 형식을 읽으며, 둘 다 주입된 텍스트가 model context에 들어간다는 것을 측정했다([측정 사실](#measured-facts), 24행과 25행).
- Hook 명령: soksak terminal 안에서만 `sok`을 실행하는 shell 줄이다. `[ -n "$SOKSAK_CONFIG_DIR" ] || exit 0`에 이어 `exec <sok> role identity --soksak-hook`를 쓰며, `<sok>`은 위와 같이 인용한 실행 중인 `sok`이다. Host는 surface를 위해 sidecar가 시작하는 모든 process에 `SOKSAK_CONFIG_DIR`을 설정하므로([sidecar](sidecars.ko.md#surface의-프로세스)), 이 변수는 soksak tab의 session에만 있다. Tab 밖에서는 줄이 `sok`을 실행하지 않고 바로 0으로 끝나므로, soksak을 쓰지 않는 project는 `sok`이 설치되지 않았거나 `PATH`에 없어도 `sok` 시작이나 hook 오류를 보지 않는다. Login shell에서 `SOKSAK_CONFIG_DIR`을 export한 사람에게는 줄이 `sok`을 실행하며, 그러면 `sok`이 자기 오류를 보고하거나 tab 밖에서는 아무것도 출력하지 않는다.
- Role이 없거나 어느 surface에도 속하지 않을 때: 표준 출력은 비고 종료 상태는 0이다. Hook은 tab 밖을 포함해 agent의 모든 session에서 실행된다. tab 밖에는 tab 환경이 없으므로 명령은 surface를 찾지 못하고, 애플리케이션에 연결되지 않은 채 아무것도 출력하지 않고 바로 종료 상태 0으로 끝난다.
- 오류일 때(예: 거부된 surface 식별자, 응답하지 않는 애플리케이션): 표준 출력은 비고, 표준 오류에 `sok: <message>`를 쓰며 종료 상태는 1이다. Codex는 이 실행의 종료 상태만 기록하고 표준 오류의 텍스트는 기록하지 않는다([위](#세션-재시작-hook)). Claude Code는 이 상태로 session을 막지 않으므로, session은 identity 없이 시작한다. Claude Code 참조 문서에 따르면 `SessionStart` hook의 종료 상태 2는 stderr를 사람에게만 보이고 session을 막지 않으며, 그 밖의 0이 아닌 종료 상태는 막지 않는 오류다([Claude Code hooks](https://code.claude.com/docs/en/hooks)). Codex 0.171.0은 command hook을 shell로 실행한다. Unix에서는 `$SHELL -lc '<명령>'`을 시작하며, `SHELL`이 없으면 `/bin/sh`를 쓴다(`codex-rs/hooks/src/engine/command_runner.rs`의 448행부터 474행과 508행, tag `rust-v0.171.0`). `SessionStart` hook에서 종료 상태 0과 JSON 표준 출력은 그 `additionalContext`를 더하고, 종료 상태 0과 JSON이 아닌 표준 출력은 그 출력을 context로 더하며, 그 밖의 종료 상태는 실행을 실패로 기록하고 항목 `hook exited with code <n>`을 남긴다. 실행은 계속된다. 이 handler는 hook의 stderr를 쓰지 않는다(`codex-rs/hooks/src/events/session_start.rs`의 245행부터 321행). 임시 폴더에서 `codex --no-daemon --dangerously-bypass-hook-trust exec --trust`로 한 probe는 두 가지를 확인했다. 변수가 없으면 0으로 끝나는 guard 줄로 shell 형식을 확인했고, 종료 상태 3으로 끝난 hook은 실패로 기록되었으며 그 stderr 텍스트는 보이지 않았다. Bypass flag는 project hook 파일을 그 형식으로 읽게 하며, 사람이 시작한 session에는 필요하지 않다.
- Hook은 role 정의를 절대 보내지 않는다. 지문 루프와 변경 message는 그대로다. Session 시작 hook이 없는 CLI는 루프에만 기댄다.

Terminal에 입력하는 message 대신 hook을 쓰는 이유: 텍스트가 context 초기화 직후에 도착한다. TUI에 아무것도 입력하지 않으므로 person의 입력, 입력 방식, 권한 prompt와 부딪히지 않는다. 대화 turn을 더하지 않는다. Compaction 뒤에 더해지므로 compaction을 견딘다. 정의는 파일에 남는다. Role은 session 중에 바뀔 수 있고, 주입된 context는 나중의 변경으로 거둘 수 없으며(측정하지 않음), 지문은 파일을 읽어야 나오기 때문이다.

Hook은 user 수준에서, skill과 MCP setup이 이미 쓰는 agent 폴더에 설치하며, project 폴더에는 절대 설치하지 않는다. soksak은 project 폴더에 파일을 더하지 않는다. Codex는 신뢰된 폴더에서만 project hook을 실행하며, soksak tab은 어느 폴더에서든 열릴 수 있으므로 project hook은 필요하지 않다.

등록은 setup part `hook`이다([setup part](cli.ko.md#setup-part)). `sok setup install hook`은 존재하는 agent 폴더마다 hook을 쓴다.

- Claude Code: 존재하는 각 Claude 폴더의 `settings.json`. 폴더는 `<home>/.claude`와, 설정되어 비지 않았을 때의 `$CLAUDE_CONFIG_DIR`이며 skill part와 같다.
- Codex: Codex user 폴더의 `hooks.json`. Codex user 폴더는 `CODEX_HOME`이 설정되어 비지 않았으면 그 값, 아니면 `<home>/.codex`이며, 그 폴더가 있을 때 파일을 쓴다. Codex는 이 파일을 user 폴더에서 읽는다: `$CODEX_HOME/hooks.json`, 또는 `CODEX_HOME`이 없으면 `~/.codex/hooks.json`([Codex hooks](https://learn.chatgpt.com/docs/hooks); Codex 0.171.0은 config layer 폴더마다 `hooks.json`을 읽는다, `codex-rs/hooks/src/engine/discovery.rs` 395행).

Hook은 `hooks` member의 `SessionStart` 배열에 있는 group 하나다: `{"matcher": "", "hooks": [{"type": "command", "command": "<sok> role identity --soksak-hook"}]}`. `<sok>`은 MCP 등록이 밝히는 실행 중인 `sok`이며, 경로에 공백이나 shell 문자가 있으면 shell용으로 인용한다. 빈 matcher는 모든 source에서 hook을 실행한다. 고정 인자 `--soksak-hook`은 soksak이 등록한 항목의 표지다. `sok role identity`는 이 인자만 받고 다른 인자는 거부한다. 항목은 문서화된 필드 `type`과 `command`만 담으므로, 항목을 구별하려고 member를 더할 필요가 없다.

병합은 파일의 다른 값을 모두 보존한다.

- Parse되지 않는 파일, 또는 `hooks`나 `SessionStart` member의 type이 다른 파일은 `<file>: <reason>`으로 실패하며 아무것도 쓰지 않는다. 없는 파일은 항목 하나를 담아 만들며, 모드는 0600이다.
- 명령이 `sok`의 경로 뒤에 단어 `role identity --soksak-hook`으로 끝나는 항목은 soksak의 것이다. 설치는 먼저 모든 event와 matcher에서 soksak 항목을 모두 지운다. 그래서 오래되었거나 이름이 바뀌었거나 중복된 soksak 항목도 남지 않는다. Group은 제거로 비게 된 경우에만 지운다. 그다음 현재 group을 `SessionStart` 배열에 더하므로, 파일은 현재 soksak 집합과 사람의 항목을 그대로 담는다.
- 두 번 설치하면 같은 바이트가 된다. 두 번째 설치는 첫 번째 설치의 항목을 지우고 같은 자리에 다시 더한다.
- 다른 program의 항목과 다른 member는 key와 값의 text를 바이트 그대로, 그리고 순서대로 유지한다. 문자열과 숫자는 파일이 쓴 escape와 형식을 유지한다. 파일은 들여쓰기 두 칸과 끝 line feed로 쓰며, 문자열 밖의 공백만 바뀐다. Go와 Rust의 `sok`은 `docs/spec/cases/setup/hook-files.json`의 case에 대해 같은 바이트를 쓴다.
- 쓰기는 원자적이다. 임시 파일은 같은 폴더에 있고 파일 위로 이름을 바꾼다. 있던 파일은 모드를 유지한다.

`sok setup check`는 설치가 쓸 파일마다 part `hook`을 나열한다. 상태는 파일이 정확히 현재 soksak 집합을 담을 때 `ok`다. 사유는 soksak 항목이 없으면 `absent`, soksak 항목이 현재 집합 밖에 있거나, 다른 event 아래에 있거나, 다른 `sok`을 가리키면 `differs`다. 제거는 setup 명령 `sok setup remove hook`이다. 설치와 같은 파일에 적용하며 soksak의 항목만 바꾼다. 모든 event와 matcher 아래의 soksak 항목을 모두 지우고, 제거로 비게 된 group이나 event 배열만 지운다. 다른 값과 순서는 모두 유지한다. 파일이 없으면 만들지 않는다. 그래서 soksak을 제거하면 hook이 남지 않으며, 사람의 항목은 바뀌지 않는다.

## Resume

resume은 자기 명령으로 프로그램을 시작한다. resume된 tab은 첫 message를 다시 보내고, 그다음 role 파일 경로를 적은 reread request을 한 번 보내며, 그 요청은 요청 1로 센다. 상태는 같은 fingerprint을 가진 `pending`이다.

| 경우 | identity | message |
| --- | --- | --- |
| tab의 launch 명령으로 새로 시작 | 첫 message | 별도 없음 |
| tab의 launch 명령으로 resume | 첫 message를 다시 보냄 | reread request 하나 |
| person이 tab의 shell에 직접 입력한 명령, launch 명령 밖 | 없음. soksak이 identity를 주지 않는다 | 없음 |

## Change of a running agent

변경은 role 파일의 원자적 다시 쓰기 한 번, 새 generation 하나, 변경 message 하나다. agent는 변경 message가 시키는 대로 파일을 읽을 때 변경을 적용한다(9행과 8행). 재시작은 필요 없으며, 변경은 프로그램을 끝내지 않는다.

person이 tab의 shell에서 직접 시작한 두 번째 agent CLI는 soksak의 identity가 없으므로 계약 밖이다. agent가 바쁜 동안 도착한 변경 message의 동작은 [role messages](messaging.md#role-messages)에 적는다.

## Tests

### Unit tests

- launch: 인자 목록은 `args` 그대로이며, 첫 message는 role 파일 경로를 적은 identity 텍스트다. 단위 테스트에서는 agent CLI를 실행하지 않는다.
- terminal 실행 경로: launch가 agent 명령으로 시작하는 기록 program. 인자와 첫 입력을 기록하고 그 밖에는 아무것도 하지 않는다. launch는 이것을 실제 프로세스로 시작한다.
- role 파일 쓰기: 실제 파일을 쓴다. host writer의 fault point가 1, 2, 3단계에서 쓰기를 실패시키고, 각 경우는 `role file <path>: write failed: <os error>`를 확인하고 뒤의 저장 기록과 파일을 적는다.
- 모드: 임시 파일은 모드 0600, 디렉터리는 0700으로 만든다. 이름을 바꾸기 전에 모드가 바뀌면 쓰기는 이름을 바꾸지 않고 `role file <path>: mode <mode> is not 0600`으로 실패한다.
- phrase test: [Phrase test](#phrase-test)를 본다.
- 구조와 fingerprint: 구조는 첫 줄, 정의, 마지막 줄을 가진다. 마지막 line feed가 없는 정의는 구조에서 line feed를 얻고 fingerprint은 저장된 텍스트로 계산한다. Go host와 Rust host가 `docs/spec/cases/agent-roles/fingerprint.json`의 각 사례 fingerprint을 계산하고 값이 같다. 사례에는 non-ASCII 텍스트와 줄바꿈이 있다.
- 길이: 긴 정의(5,000자)는 전체가 쓰이고 fingerprint은 전체를 덮는다.
- 경로: 따옴표나 제어 문자가 있는 configuration directory 경로는 `configuration directory <path> holds a quote or a control character`로 거부한다. 경로 구분자, `..` 구간 또는 제어 문자가 있는 surface 식별자도 `surface "<value>" holds a path part or a control character`로 거부하며 아무것도 쓰지 않는다.
- launch 실패: launch의 role 파일 쓰기가 실패하면 `role file <path>: write failed: <os error>`로 거부하며 어떤 program도 시작하지 않는다.
- 남은 파일: launch는 쓰기 전에 surface 폴더의 `.role-*.tmp` 파일을 지운다.
- 제거: 제거된 tab은 program을 멈추고, 이후 변경을 `tab <tab> was removed; its role cannot change`로 거부하며, 보류 message를 각각 `skipped` 기록으로 버린다.
- resume: 프로그램은 자기 명령으로 시작하고, 첫 message를 다시 보내며, 바쁘지 않음 보고마다 reread request이 확인할 때까지 뒤따른다.
- confirmation: 두 방식, `sok role confirm`과 답변 줄이 현재 fingerprint에 `ready`를 주고, 이전 fingerprint에는 `stale fingerprint: read the role file again at <path>` 오류를 준다. 명령 방식은 shell이 있는 agent에서만 테스트한다.
- 요청: 바쁘지 않음 보고마다 요청이 하나씩 가며 상한은 없다. 세 번째 이후 요청도 같은 경로와 현재 fingerprint을 적는다. 각 요청은 `plugin.<plugin>.messages.delivered`에 kind `role-reread`로 쓴다.
- 형식: `projects.json` reader는 형식 3을 `<file>: projects: format must be 4, found 3`으로 거부하고, member `role`이 없거나 `null`도 유효한 기록도 아닌 tab은 [tab의 역할 상태](#tab-role-state)의 오류로 거부한다. writer는 형식 4를 쓰고, role 없이 만든 tab은 `null`을 저장한다.
- 반복과 동시성: [Tests of the repetitions](#tests-of-the-repetitions)와 [Tests of the concurrency](#tests-of-the-concurrency).
- sidecar open: 네 refusal을 각 문장 `open program must be a non-empty text`, `open args must be an array of texts`, `open args require program`, `open program and shell are both set`으로, `openFailed` 답을 `program not found: <program>`으로, program session에는 shell integration이 없다는 규칙을 확인한다.
- `roles.json`: 형식 번호, 식별자 규칙, 알 수 없는 role 거부. 각 오류 문장을 확인한다: `<file>: roles: format must be 2, found <value>`, `<file>: roles: invalid role identifier <id>`, `unknown agent role <id>`.

### Acceptance

인수 target은 `test-app-agent-role`이다. core는 agent CLI나 plugin 이름을 쓰는 window check를 선언하지 않으므로, 이 target은 terminal plugin의 저장소가 선언한다. 이 target은 그 plugin을 설치한 application에서 실제 Claude Code와 Codex를 실행한다. disposable configuration directory와, CLI가 이미 신뢰하는 project 폴더를 쓴다. 로컬에서만 실행하며 display가 필요하고, person이 실행할 때만 돈다. [AGENTS](../../AGENTS.md#verification)의 window check 규칙이 적용되며 `make test-app`에는 들어가지 않는다.

target은 role 상태만 판정한다. CLI마다 다음을 한다.

1. nonce 하나를 담은 role 정의를 쓰고, `core.layout.open`으로 CLI와 role을 가진 tab을 열고, timer가 아니라 상태 `core.tab.role`과 프로그램 상태를 기다린다;
2. `ready`를 기다리고, 확인된 fingerprint이 이 문서의 알고리즘으로 `roles.json`에서 계산한 fingerprint과 같은지 요구한다. nonce는 agent가 파일을 읽기 전에는 알 수 없으므로, 이는 agent가 파일 마지막 줄을 읽었음을 증명한다;
3. `core.tab.role`로 새 nonce를 담은 새 정의로 role을 바꾸고, 새 fingerprint의 새 generation에 대한 `ready`를 기다린다;
4. session을 resume하고 reread request 뒤 같은 fingerprint의 `ready`를 기다린다;
5. 답변 줄로 2단계를 반복하고, shell이 있는 agent는 `sok role confirm`으로 반복한다;
6. CLI의 persistent memory 파일과 project 폴더의 `AGENTS.md`, `CLAUDE.md`에 nonce가 나타나지 않음을 요구한다.

확인하지 않는 agent는 `pending`에 머물며, target은 `pending` 상태를 통과로 보고하지 않는다.

`claude`나 `codex` 명령이 없으면 target은 `command not found: <program>`으로 실패하며, 어떤 테스트도 건너뛰지 않는다. 각 테스트는 자신의 시간 제한을 가지며, `running`, `finished`, `passed`, `failed`와 경과 시간을 출력한다([AGENTS](../../AGENTS.md#verification)).

## Verification boundaries

각 CLI의 launch는 해당 CLI에 대해 인수 target이 실행될 때마다 검증하며, 실행 옵션을 바꾸는 CLI의 새 버전마다 다시 검증한다. target이 생기고 그 실행이 [features](../features.ko.md)에 기록되기 전까지 그에 의존하는 주장은 검증되지 않았다.

## Review

이 결정의 각 개정에 대해 반론이 제기되었고, 아래에 각 반론과 이 문서가 적용한 답을 적는다. 문구에 대한 반론은 위 절의 문구로 답한다.

답하고 적용한 것:

- launch adapter는 제거한다. 모든 CLI는 `program`과 `args`로 시작하고 identity를 첫 message로 받는다. 한 경로는 CLI마다 코드를 두지 않는다. 측정된 trade-off는 첫 message가 context compaction으로 사라질 수 있다는 것이며, reread request와 변경 message가 role을 되돌린다.
- reread request은 agent가 확인할 때까지 바쁘지 않음 보고마다 반복한다. 상한은 없다. 반복이 수렴하는 이유는 파일이 현재 role을 담고 요청마다 그 경로와 현재 fingerprint을 다시 적기 때문이다. 상한을 두면 agent가 확인하기 전에 루프가 끝난다.
- 보류된 work message는 `ready`를 기다린다. role play는 fingerprint가 확인된 뒤에만 진행하기 때문이다.
- `roles.json`은 role 텍스트를 담는다. identifier로 이름이 정해진 role에는 텍스트의 자리가 하나 필요하기 때문이다.
- 두 확인 방식을 둔다. 줄 방식은 모든 CLI에 쓰고, `sok role confirm`은 줄 앞에 글자나 숫자가 붙는 CLI에 쓴다. 줄 matcher가 그런 행을 맞추지 않기 때문이다.
- mode 검사, 남은 파일 정리, 실패 문장, `projects.json` 복원, 검증 거부, 제거된 tab의 기록과 skipped 기록은 남긴다. AGENTS.md는 경계에서 명시적 오류를 요구하며, 모든 오류를 보고하고 입력을 조용히 버리지 않는다고 정한다.
- "실행 중인 tab은 role을 잃을 수 없다"는 제거한다. `role`을 `null`로 하면 role을 지우며, 특별한 거부는 없다.
- launch 기록의 identity 검사는 제거한다. session 기록을 검사하면 알 수 없는 AI가 통과할 수 없기 때문이다.
- 지도자 단락은 제거한다. 설계가 정하지 않은 질문을 적었기 때문이다.
- 대기열 순서, 발신자 규칙, 전경 규칙과 틀은 [role messages](messaging.md#role-messages)로 옮긴다.

- 변경 message는 reread request이 아니다. 변경 message 뒤 첫 요청이 generation의 첫 요청이다.
- 같은 role을 할당하면 파일을 쓰지 않고 상태를 바꾸지 않는다.
- 답변 줄은 agent가 파일을 읽었음이 아니라 현재 파일의 fingerprint을 가졌음을 보인다.
- fingerprint 참조 파일은 role 파일, identity, 변경 message, reread request, 첫 message의 접미 줄을 고정한다.
- 첫 message의 접미 줄은 고정된 텍스트다.
- confirmation이 저장되지 않은 상태로 재시작하면 `pending`이다.
- 보류 근거 `role-pending`은 messaging의 보류 목록에 있다.
- program의 도구 출력도 줄 형식에 인정되며, 명세가 이를 밝힌다.
- 16자리 소문자 16진수가 아닌 confirmation 값은 `fingerprint <value> is not 16 lowercase hexadecimal characters` 문장의 invalid input이며 오래된 confirmation 규칙과 비교하지 않는다.
- 저장된 정의의 마지막 line feed가 없으면 파일에 하나를 붙이며, fingerprint은 저장된 텍스트를 쓴다.
- 경로 구분자, `..` 구간 또는 제어 문자를 담은 surface 식별자는 `surface "<value>" holds a path part or a control character`로 거부하며 아무것도 쓰지 않는다.
- surface는 tab 하나이므로, role 파일은 그 tab에만 속한다.
- launch의 identity 또는 role 파일 쓰기가 실패하면 `role file <path>: write failed: <os error>`로 거부하며 어떤 program도 시작하지 않는다.
- 제거된 tab의 보류 message는 `skipped` 기록과 함께 버린다.
- launch는 쓰기 전에 남은 `.role-*.tmp` 파일을 지운다.
- program이 실행 중인 재시작은 저장된 기록을 유지하고, resume은 기록을 지운다.
- 테스트는 소유 패키지를 밝힌다.
- 시작 parameter `program`, `args`, `role`은 sidecar `open` 요청으로 전달되며, 모든 program은 identity를 첫 message로 받는다.
- status `core.tab.role`과 role 명령의 답은 `fingerprint`와 `generation`을 담으므로, page는 그것으로 reread request을 만든다.
- 줄 형식은 `<plugin>.screen.read`가 읽는 보이는 행에서 보이는 행이 바뀔 때마다 맞춘다. 감싼 줄과 화면 밖으로 밀려난 줄은 맞지 않는다.
- 기억 진술은 측정된 launch 옵션으로 한정한다.
- 영어와 한국어 본문은 같은 규칙을 말한다.

문구를 바꾸지 않고 답한 것:

- terminal이 줄을 감싼 confirmation 줄은 맞지 않으며, 상태는 `pending`에 머문다. reread request이 다시 묻는다. 명세가 이미 이를 말하므로 규칙을 더하지 않는다.

열린 것:

- `fingerprint`, `generation`, `reread request`, `confirmation`, `role message`, `delivery record`, `error display`는 kit commit으로 kit 용어 목록에 들어간다. core의 용어 검사는 kit release와 pin 뒤에 이를 읽는다. 이는 checklist가 추적한다.
