# Agent 대화

[English](agent-conversation.md)

`sok conversation read`는 작업 디렉터리에서 동작하는 agent의 대화 메시지를 돌려준다. agent가 디스크에 쓰는 session 파일을 읽으므로 실행 중인 애플리케이션과 [endpoint](endpoint.md)가 필요하지 않다. 각 agent는 아래 규칙으로 읽으며, 이 명령은 다른 파일을 읽지 않고 어떤 파일도 바꾸지 않는다.

이 계약은 승인된 agent 대화 읽기를 정의한다. 구현과 검증은 [features](../features.md)에서 추적하며, 이 계약의 승인이 구현을 뜻하지는 않는다.

## 명령

`sok conversation read --agent <agent> --cwd <path>`는 입력 `{agent, cwd}`를 받는다.

| 필드 | 값 |
| --- | --- |
| `agent` | `claude-code` 또는 `codex`; 다른 값은 거부한다 |
| `cwd` | 절대 경로. session의 작업 디렉터리를 적힌 그대로 비교하며 심볼릭 링크를 풀지 않는다. 상대 경로는 거부한다 |

명령은 표준 출력에 JSON 객체 하나를 쓴다.

```json
{"file": "<읽은 session 파일의 절대 경로>", "messages": [{"role": "user", "text": "..."}], "skipped": 0}
```

- `file`은 [선택](#선택)이 고른 session 파일이다.
- `messages`는 그 파일의 모든 메시지를 레코드 순서대로 담는다. `role`은 `user` 또는 `assistant`이다. `text`는 메시지의 텍스트로, 문자열이거나 메시지의 text 블록을 순서대로 줄바꿈으로 이은 값이다. 텍스트가 비어 있는 메시지는 메시지가 아니다.
- `skipped`는 파일의 레코드 중 텍스트가 있는 메시지가 아닌 레코드의 수다. 빈 줄은 레코드가 아니므로 세지 않는다.

명령은 모든 `sok` 명령의 [출력과 종료 상태](cli.ko.md#출력과-종료-상태)를 따른다. 거부는 `sok: <message>` 형식으로 표준 오류에 쓰고 종료 상태 1로 끝나며, 사용법 오류(옵션 누락 또는 알 수 없는 옵션)는 종료 상태 2다.

## Session 파일 위치

`<home>`은 `HOME`의 값이다. `HOME`이 설정되지 않았거나 비어 있으면 이를 필요로 하는 명령은 `HOME is not set`으로 실패한다([에이전트](cli.ko.md#에이전트)).

### Claude Code

Claude Code는 `<home>/.claude/projects/<encoded cwd>/<sessionId>.jsonl`에 쓴다. encoded cwd는 작업 디렉터리에서 ASCII 문자나 숫자가 아닌 모든 문자를 `-`로 바꾼 값이다.

2026-11-18에 `/bin/ls "$HOME/.claude/projects"`로 관찰했다. 72개 폴더 이름이 모두 `-[A-Za-z0-9-]*` 형식과 맞는다. 경로에 `/` 구성 요소, `.`으로 시작하는 구성 요소(점 폴더), 공백이 있는 작업 디렉터리는 그 문자가 폴더 이름에서 모두 `-`로 적힌다. 예를 들어 홈 폴더 아래 점 폴더를 작업 디렉터리로 한 session의 폴더 이름은 `--<name>`으로 끝난다. `_`나 ASCII가 아닌 문자를 포함한 폴더 이름은 없었다. 이 문자들의 치환은 관찰되지 않았으며 그 규칙은 검증되지 않았다.

session 파일의 레코드는 JSON 객체다. 레코드의 `type`은 레코드의 종류다. `user`와 `assistant`는 대화의 메시지이고, 그 밖의 종류(`attachment`, `system`, `api-request`, `last-prompt` 등)는 메시지가 아니다. 메시지의 `message.content`는 문자열이거나 블록 목록이다. `type`이 `text`인 블록이 텍스트를 담으며, `tool_use`, `tool_result`, `thinking` 블록은 이 읽기에서 텍스트를 담지 않는다. 최상위 `cwd` 필드가 있는 레코드는 그 레코드의 작업 디렉터리를 담으며, session의 작업 디렉터리는 `cwd`가 있는 첫 레코드의 `cwd`다.

### Codex

Codex는 `<home>/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`에 쓴다. 각 파일은 `payload.cwd`가 session의 작업 디렉터리인 `session_meta` 타입 레코드로 시작한다. 2026-11-18에 샘플 파일 하나로 관찰했다. 첫 레코드는 `session_meta`이며 `payload.cwd`를 담고, `turn_context` 레코드도 `payload.cwd`를 담지만 이 읽기는 그 값을 쓰지 않는다.

메시지는 `payload.type`이 `message`이고 `payload.role`이 `user` 또는 `assistant`인 `response_item` 레코드다. 텍스트는 `payload.content`의 항목 중 타입이 `input_text` 또는 `output_text`인 항목의 `text` 필드를 순서대로 줄바꿈으로 이은 값이다. `developer` 역할의 메시지는 이 읽기의 메시지가 아니며 `skipped`에 센다.

## 선택

1. `claude-code`의 후보는 encoded cwd(요청한 cwd를 위 규칙으로 바꾼 값)의 `<home>/.claude/projects/<encoded cwd>/` 아래 `*.jsonl` 파일이다. `codex`의 후보는 `<home>/.codex/sessions/` 아래 깊이와 관계없이 있는 `rollout-*.jsonl` 파일이다.
2. 후보 파일의 session 작업 디렉터리가 요청한 `cwd`와 정확히 같으면 그 파일이 일치한다. `claude-code`에서는 `cwd`가 있는 첫 레코드의 `cwd`이고, `codex`에서는 `session_meta` 레코드의 `payload.cwd`다.
3. 일치하는 파일 중 수정 시각이 가장 최근인 파일을 고른다. 수정 시각이 같은 두 파일은 경로의 오름차순으로 정렬하며, 그중 첫 파일을 고른다.
4. 일치하는 파일이 없으면 `no <agent> session file has the working directory <cwd>`로 거부한다.

읽을 수 없는 후보나 필요한 레코드를 파싱할 수 없는 후보는 [거부](#거부)로 명령을 실패시키며, 명령이 그 후보를 건너뛰지 않는다.

## 거부

각 거부는 종료 상태 1의 명시적 오류다. 아무것도 조용히 버리지 않는다.

| 조건 | 메시지 |
| --- | --- |
| `--agent`가 `claude-code` 또는 `codex`가 아니다 | `unknown agent <agent>` |
| `--cwd`가 절대 경로가 아니다 | `cwd is not an absolute path: <cwd>` |
| `HOME`이 설정되지 않았거나 비어 있다 | `HOME is not set` |
| 어느 후보도 작업 디렉터리와 일치하지 않는다 | `no <agent> session file has the working directory <cwd>` |
| 후보 또는 선택된 파일을 읽을 수 없다 | `<path>: <reason>`, 운영체제 사유를 소문자로 쓴다 |
| 후보의 한 줄이 JSON 객체가 아니다 | `<path>: line <n> is not a JSON object` |

## 담당 패키지

명령은 `packages/sok/rust`(`src/conversation.rs`, 테스트는 `tests/conversation_test.rs`)에 구현한다. `packages/sok/go`의 Go `sok`도 같은 계약으로 같은 명령을 구현하며, 그 구현은 [features](../features.md)에 등록한 뒤 추적한다.
