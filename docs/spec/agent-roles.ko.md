# Agent 역할

[English](agent-roles.md)

이 문서는 agent CLI의 tab이 역할을 받는 방식과, soksak이 agent가 그 역할 파일을 읽었다는 것을 확인하는 방식을 정의한다. 구현과 검증은 [features](../features.md)에서 추적한다. 변경 메시지는 [messaging](messaging.md#injected-message)의 주입 경로로 agent에 닿는다.

## 결정

- Agent CLI를 시작하는 tab은 launch adapter를 통해 CLI에 stable identity를 준다. Identity는 그 tab의 역할 파일의 절대 경로를 적는다. Agent는 역할을 그 파일에서 읽으며, 역할 text는 terminal에 붙여 넣거나 메시지에 담지 않는다.
- 역할 파일은 surface 하나에 속하며, 사람의 repository가 아니라 application의 configuration directory에 놓인다. 정의의 각 단위는 fragment 줄로 끝나며, agent는 모든 fragment를 모아 `sok role confirm`으로 soksak에 돌려준다. 이것으로 파일 전체를 읽었음이 증명된다.
- 역할 할당이나 변경은 역할 파일을 원자적으로 다시 쓰고 짧은 변경 메시지를 보낸다. 변경 메시지는 역할 파일의 경로를 적으며, 역할 text와 확인 값을 담지 않는다.
- Launch adapter가 없는 CLI는 같은 경로를 적은 같은 identity를 첫 메시지로 받는다.
- Resume은 CLI의 launch 지시를 바꾸지 않는다. Resume된 tab은 같은 경로를 적은 재읽기 메시지를 보낸다.
- Agent는 역할을 CLI의 persistent 메모리에 쓰지 않는다. 역할은 세션 context와 역할 파일에만 있다.
- 한 surface의 역할 작업은 도착 순서로 직렬화되며, 변경마다 tab의 generation이 오른다.

근거: [측정된 사실](#측정된-사실)에 나열된 사실은 launch flag가 새 세션에만 적용되고, `resume`이 세션 시작의 지시를 유지하며, 역할 파일을 가리키는 pointer를 받은 agent가 파일을 읽고 변경 메시지 뒤에 다시 읽는다는 것을 보인다. 메시지나 launch에 text로 준 역할은 뒤의 메시지로만 바뀔 수 있다. 파일은 현재 역할을 담는 유일한 곳이고, 문단마다 있는 fragment는 파일의 끝까지 읽어야 얻을 수 있다.

## 측정된 사실

Claude Code 2.1.329와 Codex 0.171.0을 모두 대화형 TUI로, 임시 configuration directory를 쓰는 application에서 측정했다. 각 행은 한 번의 실행이며 agent가 보인 답을 적는다.

| # | Launch 또는 동작 | 관찰된 결과 |
| --- | --- | --- |
| 1 | `claude --append-system-prompt-file F`, F가 역할 text를 담음 | F의 역할이 TUI에 적용되었다. |
| 2 | `claude --resume ID --append-system-prompt-file G` | 세션은 시작 때의 지시를 유지했고, G는 적용되지 않았다. |
| 3 | 실행 중인 Claude 세션에 새 역할을 정하는 메시지 | 새 역할이 launch 역할을 바꾸었다. |
| 4 | `codex --no-daemon -c developer_instructions="..."` | 지시가 TUI에 적용되었고, 사람의 전역 `AGENTS.md`도 그 옆에서 계속 유효했다. |
| 5 | 실행 중인 Codex 세션에 새 역할을 정하는 사용자 메시지 | developer-instruction의 역할이 유지되었다. |
| 6 | `codex resume --no-daemon ID -c developer_instructions=...` | 세션 시작의 developer instruction이 유지되었다. |
| 7 | Stable identity와 접두어가 붙은 역할 메시지가 있는 Codex | 가장 최근의 역할 메시지가 역할을 정했다. |
| 8 | 역할 파일만 가리키는 launch를 받은 Codex, 파일 변경, 변경 메시지 전송 | Agent는 첫 답변에서 파일을 읽었고, 변경 메시지 뒤에 다시 읽어 새 역할을 받았다. |
| 9 | Flag 없이 첫 메시지에서 pointer를 받은 Claude Code, 파일 변경, 변경 메시지 전송 | Agent는 파일을 읽었고, 변경 뒤에 다시 읽어 새 역할을 받았다. |
| 10 | `claude --model haiku --append-system-prompt-file <identity file>`, identity file은 pointer와 변경 뒤 다시 읽으라는 규칙만 담음 | Agent는 역할 파일을 읽었고, 파일이 바뀌고 변경 메시지가 간 뒤 다시 읽어 새 역할을 받았다. |

2~10행은 agent의 session 기록으로 확인했으며, 시각 없이 기록되었고 각 행은 한 번의 실행이다. 3행과 7행은 agent가 새 역할을 적은 변경 메시지를 따른다는 것만 보이며, 파일을 읽는다는 것은 보이지 않는다. 두 CLI 모두 측정되지 않은 것: context compaction, resume 뒤의 변경 메시지, agent가 바쁠 때의 변경 메시지, 같은 tab의 subagent나 두 번째 세션, 자동 메모리나 Codex 메모리의 세션 간 공유. 이에 기대는 규칙은 이 계약의 규칙으로 적었으며 측정된 동작으로 주장하지 않는다. 영구 메모리 금지 규칙은 지시일 뿐이며, 측정된 launch 옵션 중 메모리를 끄는 것이 없으므로 launch가 이를 강제하지 않는다.

Claude Code의 `blocked` hold는 측정되지 않았다. Claude Code가 permission prompt를 [terminal state](terminal-state.ko.md)의 program 상태로 `blocked`라고 보고하는지가 아직 정해지지 않았으며, 이것이 prompt에서 변경 메시지를 보류할지를 정한다([messaging](messaging.md#evidence-of-the-hold)). 측정되기 전에는 prompt가 열려 있을 수 있는 동안 Claude Code에 변경 메시지를 보내지 않으며, 그 메시지를 보내는 acceptance 단계는 보류한다.

## Launch adapter

Launch adapter는 CLI launch 중 stable identity를 싣는 부분이다. 그 CLI의 내장 지시에 더하는 adapter만 쓴다.

| CLI | Launch 형식 | 내장 지시에 주는 효과 | 상태 |
| --- | --- | --- | --- |
| Claude Code | `claude --append-system-prompt-file <identity file>` | System prompt에 더한다. 역할 파일 경로만 적은 identity-only launch가 적용되고 agent가 역할 파일을 읽는다(10행). | 사용 |
| Codex | `codex --no-daemon -c developer_instructions="<identity>"` | 전역 `AGENTS.md` 옆에 developer instruction을 더한다. 대화형 TUI에 적용되며, 변경 메시지 뒤 agent가 역할 파일을 다시 읽는다(4행과 8행). | 사용 |
| Kimi | `--agent-file` | 측정되지 않음. | 후보, 미사용 |
| Copilot | `--agent <name>` | 측정되지 않음. | 후보, 미사용 |
| OpenClaw | `tui --local agent:<name>` | 측정되지 않음. | 후보, 미사용 |
| Qwen | `--append-system-prompt` | 측정되지 않음. | 후보, 미사용 |
| Goose | `session --system` | 측정되지 않음. 이 flag는 지시를 대체할 수 있다. | 후보, 미사용 |

후보는 TUI에서 launch 동작이 검증된 뒤에 adapter로 더한다. 지시가 새 세션에 적용되고, 내장 지시에 더해지고, 변경 메시지가 agent에게 역할 파일을 다시 읽게 해야 한다. 내장 지시를 대체하는 후보는 더하지 않는다.

Resume 형식: `claude --resume <id>`와 `codex resume --no-daemon <id>`은 세션 시작의 지시를 유지하고, resume 명령의 adapter flag를 무시한다(2행과 6행). 따라서 launch adapter는 새 launch에서만 쓴다.

Agent CLI는 CLI가 이미 신뢰하는 folder에서만 시작한다. Folder 신뢰나 update를 묻는 CLI는 주입의 Enter를 자기 prompt에 받는다. 이는 [evidence of the hold](messaging.md#evidence-of-the-hold)에서 측정되었다. Folder 신뢰를 확인하는 방법은 이 계약이 정하지 않는다.

## Stable identity

Stable identity는 tab의 launch가 전달하는 text다. 영어로 쓰며, 그 tab의 역할 파일의 절대 경로인 `<role file>`을 넣어 다음 형식을 가진다.

> soksak assigns your role with messages that begin with [soksak 역할]; the latest such message defines your role. Your role is written in the file <role file>. Read that file before your first answer, and read it again when a message that begins with [soksak 역할] says that the role changed. Do not write your role into any persistent memory of yours, such as automatic memory or saved memories; the role file is the only record of your role.

- Identity는 메시지 접두어를 적으므로, agent는 변경 메시지를 역할의 권위로 알아본다.
- Identity는 역할 파일의 경로를 적으므로, agent는 첫 답변과 변경 메시지마다 파일에서 역할을 읽는다.
- 영구 메모리 금지 규칙은 다른 세션이 읽을 수 있는 메모리에 역할이 들어가는 것을 막는다. CLI의 메모리가 세션 사이에 공유되면 역할이 다른 tab에 닿을 수 있으며, 공유 여부는 측정되지 않았다.
- 경로는 application의 configuration directory에서 온 절대 경로다. 따옴표나 제어 문자를 담지 않으며, launch는 그런 경로를 거부한다.
- Identity는 launch와 adapter가 없는 CLI의 첫 메시지에서 같은 text다.

## 역할 파일

- 경로: `<config-dir>/agents/<surface>/role.md`. `<config-dir>`은 application의 configuration directory([installation layout](installation.md#installation-layout))이고, `<surface>`는 tab의 surface다. 각 surface는 자기 파일을 가진다.
- 단위: 정의 text를 단위로 나눈다. 단위는 문단이며, 빈 줄로 다음 블록과 떨어진 비어 있지 않은 줄들의 블록이다. 정의의 문단이 4개보다 적으면 단위는 대신 비어 있지 않은 줄이다. 단위가 4개보다 적은 정의는 `definition needs at least 4 paragraphs or lines` 오류로 거부하여, 확인 값이 64비트 이상이 되게 한다.
- 단위 `i`(총 `n`개)의 fragment: UTF-8 바이트로 된 role 식별자, 줄바꿈(U+000A), 십진수 `i`, 줄바꿈, 저장된 단위 text(그 fragment 줄은 제외) 순서로 이은 것의 SHA-256 digest에서 앞의 소문자 16진수 4자리다. 식별자에는 줄바꿈이 없으므로 구분자가 모호하지 않다. Fragment는 식별자, 위치, text에만 의존하므로 같은 정의는 항상 같은 fragment를 준다.
- 단위 `i`의 fragment 줄: `[soksak i/n frag_i]`이며, 파일에서 그 단위의 마지막 줄로 쓴다.
- 확인 값: fragment를 순서대로 이은 `frag_1-frag_2-...-frag_n`. 각 fragment는 자기 단위의 끝에 있으므로, 값을 만들려면 모든 단위가 필요하다. 단위마다 약 16비트가 더해지며, 단위가 4개 이상이므로 값은 64비트 이상이다. Agent는 이 값을 계산하지 않으며, soksak이 저장된 정의에서 계산해 비교한다.
- 파일의 구성, 순서대로:
  1. 지시 줄: `Read this whole file. It defines your role. Each unit ends with a fragment line `[soksak i/n frag]`. When you have read the whole file, confirm with `sok role confirm`, giving the fragments of all units in order, joined by hyphens.` 지시 줄은 값을 주지 않는다;
  2. 단위마다 차례로: 단위 text, 그 fragment 줄, 빈 줄 하나. 마지막 단위 뒤에는 빈 줄을 쓰지 않는다.
  각 줄은 줄바꿈으로 끝난다. 역할이 없는 tab의 파일은 지시 줄만 가지며, 그 확인 값은 빈 문자열이고 soksak은 이를 `null`로 본다.
- 명시: 확인 값이 저장된 정의의 값과 같다는 것은 각 fragment가 자기 단위의 text에서 계산되었음을 증명한다. Text 없이 값을 만드는 것은 불가능하므로, 값은 fragment들이 보였음을 보여 주지만 agent가 내용을 이해했음을 보이지 않는다. 읽었다는 증거는 [acceptance](#acceptance)의 2층이다.
- 내용의 한계: 정의 text는 최대 8 KiB다.
- 파일은 generation과 token을 담지 않는다. Generation은 tab의 저장된 값이다([tab role state](#tab의-역할-상태)).
- 파일은 configuration directory에 속하며 사람의 repository에 속하지 않는다.
- 권한: `<config-dir>/agents/<surface>/` 디렉터리는 mode 0700으로 만들고, `role.md`와 identity file은 mode 0600으로 쓴다. 임시 파일의 mode는 rename 전에 검사하므로, 다른 mode의 파일은 최종 이름으로 보이지 않는다. 그러면 쓰기는 명시적 오류로 실패하고 임시 파일을 지운다.
- 원자적 쓰기: host는 같은 folder의 임시 파일에 새 내용을 쓴 뒤 `role.md` 위로 rename한다. Reader는 이전 파일 전체나 새 파일 전체를 보며, 섞인 내용을 보지 않는다.
- 쓰는 주체: host가 파일을 쓴다. Terminal page는 파일을 만들지 않는다. 실패한 쓰기는 경로와 원인을 적은 오류이며, rename 전의 실패는 저장된 역할을 바꾸지 않는다([failure rules](#tab의-역할-상태)).
- 수명: host는 launch 전에 디렉터리를 만든다. Tab이 layout에서 제거되면 host는 그 tab의 program을 멈추고, 진행 중인 쓰기가 끝나기를 기다리며, 그 tab의 이후 역할 변경을 명시적 오류로 거부하고, 디렉터리를 지운다. 제거된 tab은 resume할 수 없다.
- Launch 기록: 각 launch는 세션 기록에 identity 경로와 launch 식별자를 저장한다. Resume은 저장된 경로가 역할 파일의 현재 경로와 같은지, 파일이 있는지 확인한다. 다르면(configuration directory가 옮겨진 경우) 또는 파일이 없으면, 경로와 원인을 적은 명시적 오류로 resume을 실패시킨다.

Claude Code adapter의 identity file은 `<config-dir>/agents/<surface>/identity.txt`이며, launch 때 역할 파일 옆에 같은 쓰기 규칙으로 쓴다. Codex adapter는 identity text를 TOML 문자열로 따옴표를 씌워 inline으로 넘긴다.

### 확인 값 참조 사례

알고리즘은 공유 사례 파일 `docs/spec/cases/agent-roles/fingerprint.json`으로 시험한다. 각 사례는 identifier, 정의 text, split이 만들어야 할 단위, 기대 확인 값을 준다. `refused` 사례는 단위가 너무 적은 정의의 오류를 준다. Host(Go와 Rust)는 각 사례를 실행하고, 계산한 단위와 값을 확인한다. 비ASCII text와 줄바꿈이 있는 사례도 포함한다. 값은 위 알고리즘에서 계산했으며 두 host에서 같다.

## 역할 정의

역할 정의는 역할 파일이 담는 text다. Soksak은 정의를 `<config-dir>/roles.json` 한 파일에 둔다. 이 파일은 `settings.json`, `projects.json`과 나란히 놓인다([stored data formats](installation.md#stored-data-formats)). 번호가 있는 형식이며, 그 member `format`은 `1`이다. Reader는 그 번호만 받아들이고, 다른 번호는 `<file>: roles: format must be 1, found <value>`로 거부한다.

```json
{"format": 1, "roles": {"reviewer": {"text": "You review the changes of the other agents in this project."}}}
```

- 역할 식별자는 `[a-z][a-z0-9-]*`에 맞고 최대 64자다. 다른 식별자는 그 이름을 적은 오류로 거부된다.
- `text`는 최대 8 KiB의 UTF-8 text이며, 역할 파일에 그대로 쓴다.
- Tab이 이름을 댄 역할이 `roles.json`에 없으면 `unknown agent role <id>`로 거부되며, tab은 이전 역할을 유지한다. 내장 정의를 대신 쓰지 않는다.

이 파일의 편집 도구는 별도의 checklist 항목이다.

## Tab의 역할 상태

Agent CLI의 각 tab은 agent 역할 하나나 없음을 가진다. Tab의 저장된 역할 기록은 `projects.json` layout의 항목이며 다음을 담는다.

- `role`: 역할 식별자, 역할이 없으면 `null`;
- `generation`: 1에서 시작하는 정수이며, 역할이나 정의가 바뀔 때마다 1씩 오른다;
- `value`: 현재 역할 파일의 확인 값;
- `confirmedValue`: agent가 확인한 확인 값, 확인되기 전에는 `null`.

이 기록을 더하면 `projects.json`의 형식이 바뀌므로, [stored data formats](installation.md#stored-data-formats)의 규칙에 따라 형식 번호를 2에서 3으로 올린다. Migration은 쓰지 않으며, reader는 형식 2를 거부한다.

역할 변경은 명령 `core.tab.role {tab, role}`이며, 다른 명령과 같이 registry를 거친다. Tab이 이미 가진 역할을 같은 정의로 다시 정하면 파일을 쓰지 않고 generation을 바꾸지 않으며 메시지를 보내지 않는다. 현재 `{role, generation, state}`를 답한다. 메시지를 보내는 반복 할당은 상태가 `unconfirmed`일 때 하나뿐이다. 그때는 파일을 쓰지 않고 generation을 바꾸지 않으며 변경 메시지를 한 번 보낸다. 사람이 이 상태를 푸는 방법이 이것이다.

변경은 다음 순서로 실행하며, 각 단계는 앞 단계가 성공해야 시작한다.

1. host가 새 역할 파일을 임시 이름으로 쓴다. 지시 줄, 단위와 그 fragment 줄을 담고, mode를 검사한다;
2. host가 새 `role`, `generation`, `value`와 `confirmedValue: null`을 `projects.json`에 저장한다;
3. host가 임시 파일을 `role.md`로 rename한다;
4. host가 `{role, generation, state: "pending", seq}`로 상태 `core.tab.role`을 공개한다;
5. 터미널 page가 변경 메시지를 보낸다([변경 메시지](#변경-메시지)).

실패 규칙: 1단계의 실패는 임시 파일을 지우고 아무것도 저장하지 않는다. 2단계의 실패는 임시 파일을 지우고 저장된 역할을 바꾸지 않으며 오류로 보고한다. 2단계 뒤의 3단계 실패는 오류를 보고하기 전에 `projects.json`의 이전 기록을 되돌리므로, 기록과 파일이 맞는다. Host가 단계 사이에 끝나면, 다음 launch가 CLI를 시작하기 전에 `projects.json`에서 역할 파일을 다시 쓴다. Launch는 이전 종료가 남긴 임시 파일도 지운다.

상태 `core.tab.role`은 `{role, generation, state, seq}` 값의 이벤트로 공개된다. `state`는 `pending`, `ready`, `unconfirmed`이고, 역할이 없으면 `null`이며, `seq`는 변경마다 오르는 counter다. 상태와 답은 확인 값을 담지 않는다. Agent는 확인 값을 파일의 fragment 줄에서만 얻는다. Page는 `runtime.status.watch`로 상태를 따르며 polling하지 않는다.

Plane의 leader는 이 계약에서 역할을 바꾸지 않는다. [groups](groups.md#model)는 leader가 명령, focus, 그리기 순서를 바꾸지 않는 표시라고 정한다. Plane의 leader에게 역할을 주려는 호출자는 `core.tab.role`로 정한다. Leader 표시 자체가 역할을 움직이는지는 사람이 정할 문제다.

## 확인

Role은 soksak이 기계적으로 확인했을 때만 ready다. 상태는 다음과 같다.

- `pending`: 역할 파일이 agent가 확인하지 않은 확인 값을 담는다. 역할 할당, 역할 변경과 역할이 있는 tab의 launch가 이 상태를 정한다.
- `ready`: 저장된 `confirmedValue`가 현재 역할 파일의 확인 값과 같다.
- `unconfirmed`: `pending` 상태에서 변경 메시지나 첫 메시지가 주입된 뒤, agent의 program이 바쁘지 않았다([idle rule](#idle-rule)).
- `null`: tab에 역할이 없다.

역할 변경은 generation과 확인 값이 새로 생기므로 상태를 `pending`으로 되돌린다.

Agent는 역할 파일의 지시 줄이 말하는 대로, 모든 단위의 fragment를 순서대로 이은 값으로 `sok role confirm <확인 값>`을 실행해 확인한다. `sok`은 agent의 process chain이 준 surface로 요청을 application에 보낸다([processes of a surface](sidecars.md#processes-of-a-surface)). 그래서 tab 밖의 process는 그 tab을 대신해 확인할 수 없다. Host는 요청을 그 surface의 직렬화 안에서([동시성](#동시성)), 차례가 온 상태를 기준으로 판정한다.

- 값이 현재 역할 파일의 확인 값과 같고 상태가 `pending` 또는 `unconfirmed`이면: `confirmedValue`를 저장하고, 상태를 `ready`로 바꾸며, `seq`를 올리고, 보류된 work message를 풀어 준다;
- 값이 현재 값과 같고 상태가 `ready`이면: 아무것도 바뀌지 않으며 답은 성공이다;
- 값이 현재 값과 다르면, 이전 파일의 값이므로: 낡은 값으로 거부하며 재시도하지 않는다. 오류는 현재 역할 파일의 경로와 현재 generation을 적고, 그 파일을 다시 읽으라고 말한다. 확인 값은 적지 않는다. 상태는 `pending`으로 남는다;
- Tab에 역할이 없거나 surface에 tab이 없으면: surface 이름을 적은 명시적 오류로 거부한다.

확인 명령은 CLI의 declared command이며, 계약은 [command line](cli.md#commands)에 있다.

### 보류된 message

상태가 `ready`가 아닌 동안 page는 tab의 work message, 즉 registration의 agent message를 보류한다([messaging](messaging.md#injected-message)). 보류된 message는 순서를 지키며, 상태가 `ready`가 되면 한 번에 하나씩 주입된다. 각 message는 한 번만 전달된다. 전달 기록이 파일 이름으로 키를 잡으므로, 두 번째 `ready`는 같은 message를 다시 주입하지 않는다. 세션의 첫 message와 변경 message는 보류되지 않는다. 보류 이유는 `role-pending`이며, 전달 상태가 그 이름을 적는다([messaging](messaging.md#hold-for-the-person)).

대기 중에 바뀌면 message는 계속 대기한다. 새 generation의 `ready` 뒤에 전달된다.

### Idle rule

Page는 tab의 program 상태를 본다([terminal state](terminal-state.ko.md)). 상태가 `pending`인 동안 변경 메시지나 첫 메시지가 주입된 뒤 program이 바쁘지 않다고 보고하면, host는 상태를 `unconfirmed`로 바꾸고, 오류 표시 경로로 알리며, 애플리케이션 로그에 쓴다. 그러면 page는 변경 메시지를 한 번 더 보낸다. 상태가 `unconfirmed`인 동안 program이 다시 바쁘지 않으면, 상태는 `unconfirmed`로 남고 보류된 message도 계속 보류된다. 사람이 반복 할당으로 푼다. 반복 할당은 변경 메시지를 한 번 보낸다([tab의 역할 상태](#tab의-역할-상태)). 이 전이들을 정하는 timer는 없다. 각 CLI가 바쁘지 않다고 보고하는 방식은 그 adapter 검증의 일부다.

## Idempotency

역할 handshake의 모든 단계는 결과를 바꾸지 않고 반복된다.

- 같은 역할과 정의로 `core.tab.role`을 반복하면 파일을 쓰지 않고, generation을 바꾸지 않으며, 메시지를 보내지 않고, 현재 `{role, generation, state}`를 답한다. 다만 `unconfirmed` 상태는 [tab의 역할 상태](#tab의-역할-상태)가 정한 대로 다르다;
- 새 generation은 역할이나 정의가 바뀔 때만 만든다;
- 현재 파일의 확인 값으로 `sok role confirm`을 반복하면 `ready`를 답하고, `seq`를 포함해 아무것도 바꾸지 않는다;
- 다시 보낸 변경 메시지는 같은 경로를 적으므로, 파일을 다시 읽고 다시 확인하면 같은 `ready`가 된다;
- Work message는 `ready`가 두 번 도달해도 한 번만 전달된다;
- Application이나 agent를 재시작한 뒤, 상태는 입력 없이 저장된 기록과 파일에서 다시 만들어진다. `confirmedValue`가 파일의 확인 값과 같으면 `ready`, 아니면 `pending`이다. 저장된 값과 다른 파일은 먼저 기록에서 다시 쓴다;
- Resume은 같은 확인 값으로 `pending`을 준다. Resume은 launch 텍스트를 유지하지만 agent가 파일을 읽었다는 증거는 유지하지 않기 때문이다. Host는 resume에서 `confirmedValue`를 지우고, 재개된 tab은 같은 경로를 적은 재읽기 메시지를 보낸다.

같은 정의에서 확인 값이 바뀌지 않는다는 것이 이 반복들을 자연스럽게 만든다. 같은 text로 다시 쓴 파일은 같은 내용이다.

### 반복의 시험

- 같은 역할과 정의를 반복 할당: 역할 파일을 쓰지 않음(inode와 내용 유지), 새 generation 없음, 변경 메시지 없음, 답은 현재 `{role, generation, state}`와 같다.
- 같은 역할에 정의만 바뀜: 새 generation과 변경 메시지 하나.
- A에서 B를 거쳐 A로: A의 확인 값이 되돌아오고, 그 확인은 `ready`가 된다.
- 현재 확인 값의 반복 확인: 두 번 모두 `ready`이고, 두 번째 뒤 `seq`는 그대로다.
- 변경 뒤의 이전 확인 값: 낡은 값으로 거부되며, 오류는 파일과 generation을 적고 확인 값은 적지 않는다.
- 다시 보낸 변경 메시지: 같은 경로이며, 그 뒤 확인하면 `ready`다.
- `ready`가 두 번 도달한 work message: 파일 이름으로 키를 잡아 한 번 주입된다.
- 저장된 확인이 있는 재시작: 입력 없이 `ready`다. 저장된 확인이 없으면 `pending`이다.
- Resume: `pending`, 같은 확인 값, `confirmedValue` 제거, 재읽기 메시지 한 번.
- `unconfirmed`에서 반복 할당: 변경 메시지 한 번, 파일 쓰기 없음, generation 변경 없음.

이 시험들은 실제 파일과 실제 `sok` 명령을 쓰는 host와 page의 단위 시험이다. 그 안에서 agent CLI는 실행하지 않는다.

## 동시성

한 surface의 역할 작업은 host의 한 owner가 도착 순서로 직렬화한다. 작업은 역할의 할당이나 변경, 확인, 재읽기다. 변경마다 generation이 오르며, 확인은 같은 직렬화 안에서 판정되므로 차례가 온 상태를 기준으로 판정된다.

- 역할 파일은 원자적으로 쓴다([역할 파일](#역할-파일)). Reader는 이전 파일 전체나 새 파일 전체를 본다.
- 이미 현재가 아닌 확인 값의 확인은 낡은 값으로 거부된다([확인](#확인)).
- A에서 B, B에서 C로 연속 변경: 각각 변경 메시지를 보내며, 각 메시지는 파일을 가리키기만 하므로 파일은 항상 최신 역할을 담는다. 어느 메시지로 다시 읽어도 C에 닿는다. C의 확인 값을 한 번 확인하면 `ready`가 된다. 같은 값의 이후 재읽기와 확인은 아무것도 바꾸지 않는다.
- B와 C의 확인이 서로 엇갈림: B의 확인은 낡은 값으로 거부되고 C의 확인은 받아들여진다. 두 확인의 순서는 최종 상태를 바꾸지 않는다.
- 사람과 lead agent가 동시에 역할을 정함: 직렬화되며 나중 것이 이긴다. 각 답은 결과의 `{role, generation, state}`를 준다.
- 대기 중인 work message는 현재 generation의 `ready`를 기다린다. 대기 중 변경이 있어도 계속 대기하며, 한 번 전달된다.
- 재시작: generation과 확인 값은 기록에 저장되므로, 상태는 위 idempotency 규칙대로 다시 만들어진다.

### 동시성의 시험

- 연속 변경 A에서 B, B에서 C: 변경 메시지 세 개가 같은 경로를 적는다. 첫 메시지로 다시 읽으면 C가 나온다. C의 확인 한 번이 `ready`를 준다.
- 엇갈린 확인 B와 C: B는 낡은 값으로 거부되고 C는 받아들여지며, 어느 순서든 끝 상태는 C의 `ready`다.
- 낡은 확인: 거부되며, 오류는 파일과 generation을 적고 확인 값은 적지 않는다.
- 동시 설정자: 같은 때에 둘이 한 할당은 직렬화되고, 최종 generation은 나중 것이며, 각 답은 결과 generation을 준다.
- 쓰기 중 읽기: fault injection이 임시 쓰기와 rename 사이에서 writer를 멈춘다. 멈춘 동안 reader는 이전 파일 전체를 보고, rename 뒤에는 새 파일 전체를 본다.

## 변경 메시지

변경 메시지는 한 줄이다.

`[soksak 역할] 역할이 바뀌었다. 역할 파일 <role file>을 다시 읽어라. 이 메시지는 soksak이 보낸 것이며 사람의 입력이 아니다. 현재 작업을 마친 뒤 처리하고, 승인이나 권한을 주지 않으며 대기 중인 질문에 답하지 않는다.`

- 역할 파일의 경로를 담으며, 역할 text와 확인 값은 담지 않는다.
- 보고 요청을 담지 않는다. 다른 agent의 메시지가 아니고 보낸 folder도 없다.
- 보낸 쪽은 application이다. Tab이 보낸 쪽이 아니므로, 보낸 tab이 window에 없으면 거부하는 규칙은 적용되지 않는다.
- [messaging](messaging.md#injected-message)의 hold, guard, 전달 기록을 모두 거친다. Destructive command guard는 [persistent services](persistent-services.md#destructive-command-guard)다. 변경 메시지는 program이 사람을 기다리는 동안 보류된다([hold for the person](messaging.md#hold-for-the-person)).
- Tab의 agent CLI가 세션의 foreground program일 때만 주입된다. 이는 sidecar의 program 상태로 판정한다. Shell prompt, 종료된 program, 닫힌 세션에 제출된 줄은 shell에서 실행될 수 있다. CLI가 실행되지 않는 동안 바뀐 역할은 기록에 남고, 다음 launch의 첫 메시지로 간다.
- 메시지 형식과 전달 기록은 변경 메시지의 구현이 [messaging](messaging.ko.md)에 더한다. 그 전까지 `messaging.md`는 이를 정의하지 않는다.

## 첫 메시지

Launch adapter가 없는 CLI는 identity를 첫 메시지로 받는다. 첫 메시지는 세션의 첫 주입 메시지다. `[soksak 역할] <identity text> 이 메시지는 soksak이 보낸 것이며 사람의 입력이 아니다. 현재 작업을 마친 뒤 처리하고, 승인이나 권한을 주지 않으며 대기 중인 질문에 답하지 않는다.` 형식의 한 줄이다.

세션의 첫 메시지는 그 registration의 어떤 agent 메시지보다 먼저 전달된다. Page는 program이 처음 상태를 보고할 때 이를 주입한다. 그 상태는 세션의 첫 `<plugin>.program` record 또는 첫 `running`이나 `idle` 상태다. Record를 쓰지 않고 알림도 주지 않는 시작 prompt는 관찰되지 않으므로, page가 보내는 Enter가 그 prompt에 답할 수 있다([evidence of the hold](messaging.md#evidence-of-the-hold)에서 측정되었다). 이 한계는 명시한다.

## 주입 메시지의 순서

Page는 registration마다 queue 하나를 가진다. Queue는 folder의 agent 메시지를 `seq` 순으로, 역할 변경을 generation과 `seq` 순으로 담고, 그 항목들을 page에 도착한 순서대로 한 번에 하나씩 주입한다. 세션의 첫 메시지는 그 registration의 모든 agent 메시지보다 먼저 온다. 각 항목의 전달 기록은 종류 `message` 또는 `role`을 적으며, 역할 항목의 기록 필드는 [messaging](messaging.md#delivery)이 정한다.

## Framing

[Messaging](messaging.md#injected-message)은 agent 메시지의 framing을 정한다. 이 문서는 변경 메시지와 첫 메시지에도 같은 framing 절을 준다. Text는 사람의 입력이 아니며, 현재 작업을 마친 뒤 처리하고, 승인이나 권한을 주지 않으며 대기 중인 질문에 답하지 않는다. Framing은 text의 출처를 밝히며, text가 요구하는 것을 허용하지 않는다.

변경 메시지는 권한 prompt를 승인할 수 없으며, [messaging](messaging.md#hold-for-the-person)의 hold가 적용된다. Record를 쓰지 않는 prompt에는 hold가 적용되지 않는다. Claude Code의 `blocked` hold는 [측정된 사실](#측정된-사실)에 있는 열린 측정이다.

## Resume

Resume은 프로그램을 자기 명령으로 다시 시작하며, launch adapter는 세션을 바꾸지 않는다. Resume된 tab은 역할 파일의 경로를 적은 재읽기 메시지를 한 번 보낸다. 이는 resume 뒤에 파일이 권위임을 알리는 신호이며, 역할 변경이 아니다. Adapter가 없는 tab은 resume 뒤에 첫 메시지의 identity를 다시 보낸다. 재개된 process는 처음 시작 때의 identity를 갖지 않기 때문이다. 역할이 `null`인 tab도 같은 방식으로 identity를 받는다.

| 경우 | Identity | 변경 메시지 |
| --- | --- | --- |
| Tab의 launch 명령으로 새로 시작, adapter가 있는 CLI | Launch flag로 준다 | Program 상태가 보고된 뒤 보낸다 |
| Tab의 launch 명령으로 새로 시작, adapter가 없는 CLI | 첫 메시지 | 따로 보내지 않는다 |
| Tab의 launch 명령으로 resume | 세션 시작에서 유지(adapter가 있는 CLI), 또는 첫 메시지(adapter가 없는 CLI) | 재읽기 메시지를 보낸다 |
| 사람이 tab의 shell에 launch 명령 밖에서 입력한 명령 | 없음: soksak이 identity를 주지 않는다 | 없음 |

사람이 launch 명령 밖에서 입력한 명령은 soksak의 launch가 아니므로, 계약은 identity를 주지 않고 아무것도 보내지 않는다.

## 실행 중 agent의 변경

변경 하나는 역할 변경 하나, 역할 파일의 원자적 다시 쓰기 하나, 새 generation 하나, 변경 메시지 하나다. Agent는 파일을 읽을 때 변경을 적용하며, 변경 메시지가 그렇게 시킨다(2행과 9행). 재시작은 필요 없고, 변경이 프로그램을 끝내지도 않는다.

사람이 tab 안의 shell에서 두 번째 agent로 CLI를 직접 시작하면, 그 CLI는 soksak의 identity를 받지 않는다. 변경 메시지는 foreground program이 무엇이든 닿으므로, 계약은 이 한계를 명시한다. Launch 기록은 identity를 가진 한 process를 가리키며, page는 변경 메시지를 그 launch에만 보낸다. 사람이 직접 시작한 두 번째 agent는 계약 밖이다.

Agent가 바쁠 때 도착한 변경 메시지의 동작은 두 CLI 모두 측정되지 않았다. 측정이 결정할 때까지, 변경 메시지는 program이 바쁘지 않다고 보고한 뒤에만 주입된다. 현재 작업이 끝난 뒤 처리한다는 규칙은 framing 절이며 측정된 보장이 아니다.

## 테스트

### 단위 테스트

- Launch adapter: 각 adapter가 만든 인자 목록과 identity file을 기대값과 비교한다. 단위 시험에서 agent CLI는 실행하지 않는다.
- 터미널 launch 경로: launch가 agent 명령으로 시작하는 기록 program. 받은 인자와 첫 입력을 기록하고 다른 일은 하지 않는다. Launch는 이를 실제 process로 시작하며, 시험은 launch 함수를 대체하지 않는다.
- 역할 파일 쓰기: 실제 파일을 쓴다. 시험용 fault point가 host writer의 1단계(임시 파일 전), 2단계(`projects.json` 쓰기), 3단계(rename)에서 쓰기를 실패시키며, 각 경우 뒤의 저장된 기록과 파일을 확인한다.
- 권한: 임시 파일은 mode 0600, 디렉터리는 0700으로 만든다. Rename 전에 임시 파일의 mode를 바꾸면 쓰기는 rename 없이 거부된다.
- 구성과 확인 값: 구성은 지시 줄, 단위, fragment 줄이다. `docs/spec/cases/agent-roles/fingerprint.json`의 각 사례에서 Go host와 Rust host가 계산한 단위와 확인 값이 같다. 비ASCII와 줄바꿈 사례를 포함한다.
- 경로: 따옴표나 제어 문자가 있는 configuration directory 경로는 launch가 명시적 오류로 거부한다.
- Resume: 저장된 경로가 현재 경로와 같고 파일이 있으면 시작한다. 다른 경로나 없는 파일은 경로를 적은 오류로 resume을 실패시킨다.
- 첫 메시지: [첫 메시지](#첫-메시지)의 형식이며, 세션마다 한 번 보낸다.
- 저장된 확인: 저장된 generation과 `seq`는 재시작 뒤에도 남으므로, 다시 적재된 page는 전달된 `seq` 이하를 주입하지 않는다.
- 정리: launch는 이전 종료가 남긴 임시 파일을 지우고 `role.md`는 남긴다.
- 형식: `projects.json` reader는 형식 2를 저장 데이터 오류로 거부하고, writer는 형식 3을 쓴다.
- 반복과 동시성: [반복의 시험](#반복의-시험)과 [동시성의 시험](#동시성의-시험).
- `roles.json`: 형식 번호, 식별자 규칙, text 한계, 알 수 없는 역할 거부, 각각의 오류 text.
- 변경 메시지: 형식, 역할 text와 확인 값이 없음, agent CLI가 아닌 program에는 보내지 않음.

### Acceptance

Acceptance target은 `test-app-agent-role`이다. Core는 agent CLI나 plugin 이름을 대는 window check를 선언하지 않으므로, target은 변경 메시지를 보내는 page를 소유한 터미널 plugin의 repository가 선언한다. 그 plugin을 설치한 application에서 실제 Claude Code와 Codex를 실행하며, 임시 configuration directory와 CLI가 이미 신뢰하는 project folder를 쓴다. 로컬에서만 실행하고, 화면이 필요하며, 사람이 실행할 때만 돈다. [AGENTS](../../AGENTS.md#verification)의 window check 규칙이 적용되며, `make test-app`에는 포함되지 않는다.

각 CLI에 대해 두 층을 판정한다.

1. 값(1층): target은 각 역할 정의의 한 단위에 자기 난수 nonce를 넣어 쓰므로, agent가 파일을 읽기 전에는 어떤 값도 알려지지 않는다. Target은 `roles.json`에서 같은 알고리즘으로 기대 확인 값을 계산한다. Agent의 `sok role confirm` 호출은 정확히 그 값을 주어야 한다. 이는 모든 fragment가 보였고 파일에서 계산되었음을 증명하며, 그 자체로 이해를 증명하지는 않는다.
2. 읽기 증거(읽었다는 증명): 세션 기록은 역할 파일 전체를 담는 도구 출력 하나를 보여야 한다. Claude Code는 세션 transcript의 `role.md`에 대한 `Read` 도구 결과, Codex는 세션 rollout의 `cat <역할 파일>` `exec_command` 호출의 출력이다. Target은 도구 출력 text의 SHA-256 digest를 파일의 digest와 비교하며, `Read` 도구가 각 줄에 붙이는 줄 번호 접두어를 먼저 제거하고 바이트 단위로 같아야 한다. Fragment 줄만 담은 출력(예: `grep`)은 이 층에서 실패한다. Target은 `sok conversation read --agent <claude-code|codex> --cwd <project folder>`([agent conversation](agent-conversation.ko.md))로 읽으며, 그 답은 각 record에 transcript의 index, 시각과 도구 출력 text를 줘야 한다. Target은 `role.md` 이외의 경로에 대한 읽기를 거부한다.

도구 출력 text를 주는 것은 `sok conversation read`이며, 현재 계약은 메시지 text만 준다. 그래서 target은 agent conversation 계약과 그 구현이 도구 출력을 줄 때까지 통과할 수 없다. 그 전까지 target은 읽기 단계에서 `no tool record of the role file in <file>` 오류로 실패한다.

각 CLI에 대해 target은 다음을 한다.

1. `core.layout.open`으로 CLI와 역할 `reviewer`를 가진 tab을 열며, 정의는 이 실행의 nonce를 담는다. 상태 `core.tab.role`과 program 상태를 기다린다(timer를 기다리지 않는다);
2. Agent에게 역할 파일 마지막 fragment 줄이 말하는 대로 확인하라고 요청하고, 1층의 값과 2층의 읽기 증거를 요구한다;
3. `core.tab.role`로 역할을 `leader`로 바꾸며 정의는 새 nonce를 담는다. 다시 묻고, 새 확인 값과 2층의 읽기 증거를 요구하며, 이전 값은 답에 없어야 한다;
4. 상태가 `ready`에 이른 것은 현재 값으로 `sok role confirm`을 실행한 뒤뿐임을 요구하며, 세션 기록은 그 확인 이전의 파일 읽기를 보여야 한다;
5. 세션을 resume하고 재읽기 메시지를 요구한 뒤 다시 묻는다. 현재 확인 값과 resume 뒤의 읽기 증거를 요구한다;
6. 역할의 nonce나 확인 값이 CLI의 persistent 메모리 파일이나 project folder의 `AGENTS.md`, `CLAUDE.md`에 나타나지 않아야 한다.

Claude Code의 3단계와 5단계는 [측정된 사실](#측정된-사실)의 `blocked` hold가 측정될 때까지 보류된다. 보류된 단계는 통과가 아니라 조건과 함께 `held`로 보고한다.

실패 결과는 각각 오류 text를 가진 실패한 시험이다.
- 프로젝트 folder의 세션 파일이 없음: `no session file for <folder>`;
- Target 창에서 folder에 맞는 세션 파일이 둘 이상임: `more than one session file for <folder>: <files>`. 가장 최근 파일이 다른 세션일 수 있기 때문이다;
- Target이 필요한 읽기 record가 `skipped`임: `skipped records in <file>: <count>`;
- 답에 확인 값이 있는데 그 값을 담은 역할 파일 읽기가 없음: `fingerprint <fp> in the answer without a read of the role file`;
- 답에 현재 확인 값이 없음: `answer does not hold the fingerprint of the current role file`.

`claude`나 `codex` 명령이 없으면 그 이름을 적은 오류로 target이 실패하며, 어떤 시험도 건너뛰지 않는다. 각 시험은 자신의 시간 한계를 가지며, `running`, `finished`, `passed`, `failed`와 경과 시간을 출력한다([AGENTS](../../AGENTS.md#verification)).

## 검증 경계

Adapter 표는 target이 각 CLI에 대해 실행될 때, 그리고 launch 옵션을 바꾸는 CLI의 새 버전마다 검증된다. Target이 있고 그 실행이 [features](../features.ko.md)에 기록되기 전까지, 그에 기대는 주장은 검증되지 않은 것이다.

## 검토

이 결정은 적대적 검토자들이 검토했다. 각 검토자는 증거로 초안에 반대했고, 각 반론에 답을 냈다. 이 문서에 적용된 라운드와 답은 다음과 같다.

- 1라운드, 기존 계약과의 일관성: plane의 leader는 tab이 없는 group card일 수 있으므로 역할은 tab에만 붙는다. Leader 표시는 명령을 바꾸지 않으므로([groups](groups.md#model)), 여기서 역할을 움직이지 않는다. 역할 queue는 folder queue와 따로 있고 도착 순서로 정렬한다. `roles.json`과 tab 역할은 저장 형식이다([stored data formats](installation.md#stored-data-formats)). Guard 앵커는 [persistent services](persistent-services.md#destructive-command-guard)다.
- 1라운드, 실행 동작: 역할 변경은 agent CLI가 foreground program일 때만 주입된다. 첫 메시지는 program의 첫 상태를 기다린다. 시작 prompt의 한계는 명시한다. Claude Code의 `blocked` hold는 열린 측정이다. 마지막으로 전달된 역할 `seq`는 기록에 있으므로 page 재적재가 전달을 되풀이하지 않는다. Identity file 쓰기 실패는 launch를 명시적 오류로 실패시킨다.
- 1라운드, 범위와 시험: 단위 시험은 각 adapter의 인자와 identity file을 확인하며, 기록 program은 받은 것을 기록하는 실제 process다. Acceptance target은 core가 plugin 이름을 대는 window check를 선언할 수 없으므로 터미널 plugin repository에 있다.
- 2라운드, pointer 설계와 실행: 역할 디렉터리는 tab이 있는 동안 산다. Resume은 저장된 경로와 파일을 확인하고, 아니면 명시적 오류로 실패한다. 쓰기 순서는 기록을 먼저 하고 파일 rename을 나중에 하며, 다음 launch에 기록에서 파일을 다시 쓴다. 역할 파일 mode는 0700과 0600이다. 재실행 경우를 표로 적었다. Compaction, 바쁜 receiver, 두 번째 세션, 메모리 공유는 측정되지 않았다고 적었다.
- 2라운드, 기록과 용어: 측정 날짜와 계정 설명을 뺐다. 다른 작업은 checklist ID가 아니라 설명으로 가리킨다. 측정 행은 관찰된 대로 적었다.
- 3라운드, 증거와 실행: 읽기 증거는 `sok conversation read`의 도구 출력을 필요로 하며 현재 계약은 그것을 주지 않는다. 실패 결과를 목록으로 적었다. 읽기는 transcript index와 시각으로 정렬한다. 시험 가능한 규칙마다 이름 있는 fault point로 단위 시험을 둔다. 토큰은 정의에서 만든 확인 값으로 바뀌었다.
- 3라운드, 계약 일관성: `role-pending`과 역할 전달 기록은 `messaging.md`의 계약 변경이며, 이 문서는 변경 메시지 구현의 일부로 적는다. 낡은 확인 오류는 확인 값을 적지 않는다. Generation은 기록에 저장된다.
- 3라운드, 실패 모드와 시험: 쓰기 순서와 실패 규칙은 한 순서로 적었다. 규칙마다 단위 시험이 있다. 제거된 tab의 수명은 program을 먼저 멈춘다.

해결하지 못한 반론: Claude Code의 `blocked` hold가 측정되지 않아서, Claude Code의 3단계와 5단계는 보류된다. Leader에서 역할로 가는 문제는 사람이 정한다. `messaging.md`의 계약 변경과 `projects.json` 형식 변경은 구현 항목에 속한다. Go와 Rust host의 알고리즘 기록은 그 구현에 기댄다.
