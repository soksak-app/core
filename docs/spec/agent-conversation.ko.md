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
- `messages`는 그 파일의 모든 메시지를 레코드 순서대로 담는다. `role`은 `user` 또는 `assistant`이다. `text`는 메시지의 텍스트로, 문자열이거나 메시지의 text 블록을 순서대로 줄바꿈으로 이은 값이다. 텍스트가 비어 있는 메시지는 메시지가 아니다. 다만 이미지 항목이 있으면 메시지다([Codex](#codex)와 [Claude Code](#claude-code)).
- `skipped`는 파일의 레코드 중 텍스트가 있는 메시지가 아닌 레코드의 수다. 빈 줄은 레코드가 아니므로 세지 않는다.

명령은 모든 `sok` 명령의 [출력과 종료 상태](cli.ko.md#출력과-종료-상태)를 따른다. 거부는 `sok: <message>` 형식으로 표준 오류에 쓰고 종료 상태 1로 끝나며, 사용법 오류(옵션 누락 또는 알 수 없는 옵션)는 종료 상태 2다.

## Session 파일 위치

`<home>`은 `HOME`의 값이다. `HOME`이 설정되지 않았거나 비어 있으면 이를 필요로 하는 명령은 `HOME is not set`으로 실패한다([에이전트](cli.ko.md#에이전트)).

### Claude Code

Claude Code는 `<home>/.claude/projects/<encoded cwd>/<sessionId>.jsonl`에 쓴다. encoded cwd는 작업 디렉터리에서 ASCII 문자나 숫자가 아닌 UTF-16 code unit을 각각 `-`로 바꾼 값이다. Basic Multilingual Plane 밖의 문자는 code unit 두 개이므로 `--`가 된다. 그 결과가 200자보다 길면 encoded cwd는 앞 200자, `-`, 작업 디렉터리 해시의 절댓값을 base-36으로 쓴 값으로 이루어진다. 해시는 0에서 시작하며, 각 UTF-16 code unit `unit`에 대해 `(hash << 5) - hash + unit`을 부호 있는 32비트 정수로 감싼 값이 된다.

이 규칙의 근거는 Claude Code가 2026-11-18에 쓴 폴더 이름이다. [폴더 이름 사례](cases/conversation-folder-names.json)는 규칙이 바꾸는 문자마다 쌍을 하나씩 둔다. 문자는 `/`, `.`, `_`, 공백, ASCII가 아닌 문자, 그리고 폴더 이름이 200자를 넘는 경로다. 각 쌍은 관찰된 것이 아니라 구성한 것이다. `/`, `.`, 공백, 긴 쌍은 관찰된 쌍에서 사용자 이름 부분만 `user`로 바꾼 것이며, 긴 쌍은 관찰된 공백 쌍에 세그먼트 두 개를 덧붙인 것이다. `_`와 ASCII가 아닌 문자의 쌍은 같은 형식으로 그 문자를 넣은 것이다. 긴 쌍의 해시 접미사는 규칙으로 계산했다. 각 쌍은 Rust와 Go 시험의 별도 사례이며, 시험은 reader가 쌍의 작업 디렉터리를 폴더 이름으로 바꾸는지 확인한다. 따라서 시험은 여기 적은 규칙의 각 변환을 증명하지만, Claude Code가 이 경로에 이 이름을 쓴다는 것은 증명하지 않는다. `_`, ASCII가 아닌 문자, 긴 이름의 변환은 Claude Code에 대해 검증되지 않았다. 2026-11-18에 `/bin/ls "$HOME/.claude/projects"`로 관찰했다. 72개 폴더 이름이 모두 `-[A-Za-z0-9-]*` 형식과 맞으며, 가장 긴 이름은 168자이므로 잘림은 관찰되지 않았다. 경로에 `/` 구성 요소, `.`으로 시작하는 구성 요소(점 폴더), 공백이 있는 작업 디렉터리는 그 문자가 폴더 이름에서 모두 `-`로 적힌다. 예를 들어 홈 폴더 아래 점 폴더를 작업 디렉터리로 한 session의 폴더 이름은 `--<name>`으로 끝난다. `_`나 ASCII가 아닌 문자를 포함한 폴더 이름은 없었고, 최상위 폴더의 session working directory에도 ASCII가 아닌 문자가 없었다. 따라서 이 문자들의 치환과 Basic Multilingual Plane 밖 문자를 `--`로 바꾸는 규칙은 검증되지 않았다. 길이 규칙도 검증되지 않았다. 가장 긴 폴더 이름은 168자이며 잘린 이름은 관찰되지 않았고, 잘린 형식을 다루는 시험도 없다. Claude Code는 읽기가 관찰하지 않는 조건에서 다른 규칙으로 폴더 이름을 쓸 수 있으며, 그 효과는 검증되지 않았다.

session 파일의 레코드는 JSON 객체다. 레코드의 `type`은 레코드의 종류다. `user`와 `assistant`는 대화의 메시지이고, 그 밖의 종류(`attachment`, `system`, `api-request`, `last-prompt` 등)는 메시지가 아니다. 메시지의 `message.content`는 문자열이거나 블록 목록이다. `type`이 `text`인 블록이 텍스트를 담으며, `tool_use`, `tool_result`, `thinking` 블록은 이 읽기에서 텍스트를 담지 않는다. 최상위 `cwd` 필드가 있는 레코드는 그 레코드의 작업 디렉터리를 담으며, session의 작업 디렉터리는 `cwd`가 있는 첫 레코드의 `cwd`다. 2026-11-18에 폴더 바로 아래의 session 파일 113개를 관찰했다. 모든 파일에 `cwd` 레코드가 있었고, 모든 `cwd`, `message.content`, 텍스트 블록의 `text`는 문자열이었다.

### Codex

Codex는 `<home>/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`에 쓴다. 각 파일은 `payload.cwd`가 session의 작업 디렉터리인 `session_meta` 타입 레코드로 시작한다. 2026-11-18에 가장 최근 rollout 파일 84개로 관찰했다. 각 파일의 첫 레코드는 `session_meta`였다. 파일에 두 번째 `session_meta` 레코드가 있는 경우가 있었고(84개 중 67개), 가장 최근 30개 중 그런 파일 26개에서 두 레코드의 `payload.cwd`는 같았다. `turn_context` 레코드도 `payload.cwd`를 담지만 이 읽기는 그 값을 쓰지 않는다.

메시지는 `payload.type`이 `message`이고 `payload.role`이 `user` 또는 `assistant`인 `response_item` 레코드다. `payload.content`는 목록이다. 텍스트는 그 항목 중 타입이 `input_text` 또는 `output_text`인 항목의 `text` 필드를 순서대로 줄바꿈으로 이은 값이다. `developer` 역할의 메시지는 이 읽기의 메시지가 아니며 `skipped`에 센다.

역할이 `user` 또는 `assistant`이고 이미지 항목(`input_image`)이 있는 메시지는 텍스트가 없어도 건너뛰지 않는다. 그 메시지는 이미지 항목마다 `{"type": "image"}`를 담은 `items` 목록을 가지며, 그림 데이터는 쓰지 않는다. 텍스트와 이미지 항목이 함께 있으면 `text`와 `items`를 모두 가진다. 이유: 이미지는 그 종류로 보고되는 메시지 내용이므로, 건너뛰면 agent가 그 메시지를 보냈다는 사실이 사라진다. `claude-code` 레코드에도 같은 규칙이 적용된다. `user` 또는 `assistant` 레코드의 `message.content` 목록에 `image` 블록이 있으면 텍스트가 없어도 건너뛰지 않는다. 그 `items`는 `image` 블록마다 `{"type": "image"}`를 하나씩 담으며, 그림 데이터는 쓰지 않는다. 블록 모양은 관찰되었다. 2026-11-18에 `~/.claude/projects` 아래 session 레코드에서 모든 `image` 블록은 `{"type": "image", "source": {"type": <문자열>, "media_type": <문자열>, "data": <문자열>}}`였다. 최상위 image 블록은 `user` 레코드(`message.content`)에서 관찰되었고, 같은 블록이 `tool_result` 블록의 `content`와 `attachment` 레코드에도 중첩되어 관찰되었다. 관찰한 레코드는 Claude Code 2.1.325가 쓴 것(그 버전의 `user` 레코드 11개가 최상위 image 블록을 가진다)과, 레코드의 `version` 필드가 가리키는 2.1.296부터 2.1.327까지의 다른 버전이 쓴 것이다. 읽기는 `user` 또는 `assistant` 메시지의 최상위 image 블록만 센다. `tool_result` 블록 안에 중첩된 이미지는 메시지 이미지가 아니므로, 그 레코드는 여전히 텍스트가 있는 메시지가 아닌 레코드이며 `skipped`에 센다. 읽기는 `data` 값을 쓰지 않는다. Codex 이미지 모양은 관찰되었다. 2026-11-18에 `~/.codex/sessions` 아래 `response_item` message 레코드에서 모든 `input_image` 항목은 메시지의 `payload.content` 안에서 `{"type": "input_image", "image_url": <문자열>, "detail": <문자열>}`였다. 같은 항목이 `compacted` 레코드의 `replacement_history`에도 나타나지만, 이 읽기는 그것을 메시지로 쓰지 않는다. 레코드에는 `version` 필드가 없으므로 Codex 버전은 각 파일의 `session_meta` 레코드의 `payload.cli_version`이며, 관찰된 파일은 Codex CLI 0.167.0과 0.169.0이 썼다. 이 읽기는 각 `input_image` 항목의 `type`만 쓰며 `image_url`과 `detail`은 읽지 않는다.

## 선택

1. `claude-code`의 후보는 encoded cwd(요청한 cwd를 위 규칙으로 바꾼 값)의 `<home>/.claude/projects/<encoded cwd>/` 아래 일반 `*.jsonl` 파일이다. `codex`의 후보는 `<home>/.codex/sessions/` 아래 깊이와 관계없이 있는 일반 `rollout-*.jsonl` 파일이다. 심볼릭 링크는 두 agent 모두에서 후보가 아니며 어떤 깊이에서도 따라가지 않는다. 두 agent는 일반 폴더에 일반 파일을 쓰며, 2026-11-18에 `<home>/.codex/sessions/` 아래와 `<home>/.claude/projects/`의 첫 두 단계에서 심볼릭 링크를 찾지 못했다.
2. 후보 파일의 session 작업 디렉터리가 요청한 `cwd`와 정확히 같으면 그 파일이 일치한다. `claude-code` 파일의 session 작업 디렉터리는 `cwd`가 있는 첫 레코드의 `cwd`다. `codex` 파일의 session 작업 디렉터리는 첫 레코드의 `payload.cwd`이며, 그 레코드는 `session_meta`여야 한다. 뒤의 `session_meta` 레코드는 선택에 쓰지 않는다.
3. 일치하는 파일 중 수정 시각이 가장 최근인 파일을 고른다. 수정 시각이 같은 두 파일은 경로의 오름차순으로 정렬하며, 그중 첫 파일을 고른다.
4. 일치하는 파일이 없으면 `no <agent> session file has the working directory <cwd>`로 거부한다.

후보의 읽기는 session 작업 디렉터리를 주는 레코드까지의 줄만 파싱한다. 선택된 파일은 전체를 파싱하므로, 선택되지 않은 후보에서 그 레코드 뒤에 있는 줄은 파싱하지 않으며 명령을 실패시킬 수 없다. 읽을 수 없는 후보, 그 레코드까지의 줄을 파싱할 수 없는 후보, session 작업 디렉터리가 없거나 문자열이 아닌 후보는 [거부](#거부)로 명령을 실패시키며, 명령이 그 후보를 건너뛰지 않는다.

## 거부

각 거부는 종료 상태 1의 명시적 오류다. 아무것도 조용히 버리지 않는다.

| 조건 | 메시지 |
| --- | --- |
| `--agent`가 `claude-code` 또는 `codex`가 아니다 | `unknown agent <agent>` |
| `--cwd`가 절대 경로가 아니다 | `cwd is not an absolute path: <cwd>` |
| `HOME`이 설정되지 않았거나 비어 있다 | `HOME is not set` |
| `HOME`에 UTF-8이 아닌 byte가 있다 | `HOME is not UTF-8: <escaped>` |
| reader가 나열하는 folder의 항목 이름에 UTF-8이 아닌 byte가 있다 | `<escaped>: the path is not UTF-8`, 전체 path |
| 어느 후보도 작업 디렉터리와 일치하지 않는다 | `no <agent> session file has the working directory <cwd>` |
| 후보 또는 선택된 파일을 읽을 수 없다 | `<path>: <reason>`, 운영체제 사유를 소문자로 쓴다 |
| 후보 또는 선택된 파일의 한 줄이 JSON 객체가 아니다 | `<path>: line <n> is not a JSON object` |
| 후보의 session 작업 디렉터리가 없거나 문자열이 아니다. `claude-code`는 `cwd` 레코드가 없거나 첫 `cwd`가 문자열이 아니고, `codex`는 첫 레코드가 `session_meta`가 아니거나 그 `payload.cwd`가 문자열이 아니다 | `<path>: the session working directory is missing or not a string` |
| `claude-code`의 `user` 또는 `assistant` 레코드에서 `message.content`가 문자열도 목록도 아니다 | `<path>: line <n> has a message content that is neither a string nor a list` |
| `codex` 메시지 레코드의 `payload.content`가 목록이 아니다 | `<path>: line <n> has a message content that is not a list` |
| `claude-code` text 블록의 `text`, 또는 `codex` 항목 중 타입이 `input_text` 또는 `output_text`인 항목의 `text`가 문자열이 아니다 | `<path>: line <n> has a text that is not a string` |
| `claude-code` 또는 `codex` 메시지의 content 항목이 문자열 `type`을 가진 JSON 객체가 아니다 | `<path>: line <n> has a content item that is not an object with a string type` |

`<n>`은 빈 줄을 포함한 파일의 물리 줄 번호다. `<escaped>`는 0x20부터 0x7e까지의 byte 중 `\`가 아닌 것은 그대로, `\`는 `\\`로, 그 밖의 모든 byte는 `\x`와 소문자 16진 숫자 두 개로 쓴다. 그래서 UTF-8이 아닌 path는 바뀐 문자로 쓰이지 않고 그 byte와 함께 거부되며, 출력과 메시지의 다른 모든 path는 UTF-8이므로 그대로 쓰인다.

## 담당 패키지

명령은 `packages/sok/rust`(`src/conversation.rs`, 테스트는 `tests/conversation_test.rs`)에 구현한다. `packages/sok/go`의 Go `sok`도 같은 계약으로 같은 명령을 구현하며, 그 구현은 [features](../features.md)에 등록한 뒤 추적한다.
