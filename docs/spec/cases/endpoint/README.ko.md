# Endpoint cases

[English](README.md)

endpoint case는 client와 host endpoint([endpoint](../../endpoint.ko.md#검사)) 사이의 대화 하나를 기록한다. client가 보내는 frame과 host가 돌려보내는 reply, notification이 기록된다. consumer는 client(`packages/client`, window-check session, MCP 서버 `sok mcp`를 포함한 `sok`)이고 producer는 host다. window check `e2e/endpoint-contract.test.mjs`는 `replay: true`인 case를 실행 중인 application에 보내고, host의 unit test는 endpoint가 혼자 답하는 case를 실행한다.

case는 이 디렉터리의 추적되는 JSON 파일 하나다. 파일 이름은 `<name>.json`이며, `name` 멤버는 `.json`을 뺀 파일 이름과 같다.

## 멤버

| 멤버 | 필수 | 의미 |
| --- | --- | --- |
| `name` | 예 | case의 이름. |
| `description` | 예 | endpoint가 하는 일을 영어 한 문장으로 쓴다. |
| `replay` | 예 | window check가 case를 실행 중인 application에 보내면 `true`. `false`이면 `reason`이 필요하다. |
| `reason` | `replay`가 `false`일 때 | window check가 case를 보내지 않는 이유. |
| `page` | 아니오 | case의 page가 case의 script이면 `"scripted"`. 실행 중인 application은 자기 page를 가지므로 case는 `replay: false`여야 한다. |
| `windows` | 아니오 | window가 없는 host에서 case를 실행할 때 존재하는 window 이름. 멤버가 없으면 window가 없다. |
| `ready` | 아니오 | `windows` 가운데 page가 ready를 알린 window 이름. `windows.list`는 이 window를 `ready` true로 나열한다. 멤버가 없으면 모든 window를 loading으로 나열한다. |
| `variables` | 아니오 | host가 고르는 값의 field. 각 variable은 `"<name>": {"type": ..., "keys": [...], "example": ...}`이며, `keys`는 선택이고 object 값이 가지는 멤버를 이름으로 든다. |
| `steps` | 예 | 순서가 있는 step. |
| `mcp` | 아니오 | MCP server `sok mcp`의 client step([mcp 멤버](#mcp-멤버)). |

variable은 host의 frame에서 `$<name>`으로 쓴다. host가 처음 보낸 값이 variable을 묶고, 그 값은 선언한 type과 keys를 가져야 하며, 이후 같은 variable은 처음 값과 같아야 한다. client player(`packages/client/testing/case-player.js`)는 client의 frame에서도 variable을 받는다. host가 앞선 reply에서 고르고 client가 되풀이하는 값(log 위치)이며, player는 이를 test가 준 값이나 example로 바꾸고, 이런 variable을 가진 case는 `replay: false`다. `sok`의 player(`packages/sok/go/tests/case_player_test.go`, `packages/sok/rust/tests/support/case_player.rs`)는 variable에 raw JSON 글도 받으며, host frame은 그 글을 그대로 담는다. Case 파일은 decode한 값을 담으므로 담을 수 없는 값, 예를 들어 lone surrogate escape를 가진 문자열에 쓰며, 그런 case는 `replay: false`다.

## Steps

step은 아래 멤버 중 정확히 하나를 가진다. step은 `connection`도 가질 수 있다. 이는 step이 쓰는 client connection의 이름이며, 없으면 `client` connection을 쓴다. connection은 첫 step에서 열리고, `client`의 `close` step이 닫는다.

- `send`: client가 frame 하나를 쓴다. 멤버는 JSON-RPC 2.0 request이거나, client가 그대로 쓰는 frame의 byte를 뜻하는 `{"raw_hex": "..."}`다.
- `reply`, `notify`: connection에서 host가 보내는 다음 frame이 멤버와 field 단위로 같다(response 또는 id 없는 notification). 없는 field와 `null`은 다른 값이다.
- `close`: `"host"`는 host가 frame 없이 connection을 닫기를 기대하고, `"client"`는 client가 닫는다.
- `page`: page의 step이며 아래에서 설명한다.
- `log`: application log의 record. `{"line": "<text>"}`는 시간 뒤의 text가 `<text>`인 record(`info host endpoint: connection closed: peer closed`)가 log에 생길 때까지 기다리고, `{"absent": "<text>"}`는 어느 record도 `<text>`를 담지 않음을 요구한다.
- `watching`: `{"window": ..., "name": ..., "value": true|false}`는 endpoint의 watch registry가 surface 없는 status의 watch를 가지는지(또는 가지지 않는지)를 요구한다.
- `watched`: host가 지금 가진, host status watch의 시작과 끝 목록(`"<window> <name> on|off"`)이며 순서까지 같아야 한다.

## case의 page

`"page": "scripted"`인 case는 `page` step을 따르는 page를 가진 endpoint에서 실행한다. 단어는 [page-wire](../page-wire/README.ko.md#step) case의 단어(`call`, `reply`, `notice`)와 같고 방향만 반대다. endpoint가 page에 call을 보내는 host이고, page가 답한다.

- `{"page": {"call": {"window": ..., "name": ..., "payload": ...}}}`: endpoint가 request `name`을 params `payload`와 함께 page로 전달하며, step은 전달될 때까지 기다린다. endpoint가 params를 보내지 않으면 `payload`는 없다. `window`는 선택이며, endpoint가 여러 window의 page에 보내는 request에서 그 request를 받는 page의 window를 지정한다. endpoint가 전달한 request가 다음 call과 name, params나 window가 다르거나, case에 call이 없으면 실패다.
- `{"page": {"reply": {"result": ...}}}` 또는 `{"page": {"reply": {"error": {"code": ..., "message": ...}}}}`: 바로 앞 call에 대한 page의 답이며 step은 call 바로 뒤에 온다. endpoint가 code를 답으로 주므로 `error`는 error의 code와 message를 가진다. `"held": true`는 `release` step까지 답을 쥐고 있어, request가 기다리는 동안 endpoint, connection, 다른 request가 움직이게 한다.
- `{"page": {"release": true}}`: 가장 오래된 held reply에 답한다.
- `{"page": {"notice": {"event": "status.changed", "payload": {"window": ..., "name": ..., "surface": ..., "value": ...}}}}`: page가 status 변경을 알리며, endpoint는 그 status를 watch하는 connection에 보낸다. surface 없는 watch의 변경이면 `surface`는 없다.

request, reply, connection의 끝은 host의 relay(`packages/host/go/src/exposure.go`의 `Relay`)를 거치므로, 붙잡힌 request는 host에서와 같이 connection이 끝나면 끝난다. endpoint가 case에 step이 없는 call을 보내거나, case가 가진 call보다 적게 보내거나, held reply를 끝내 release하지 않거나, case에 step이 없는 host status를 읽거나 host command를 실행하면 case는 실패한다.

## mcp 멤버

MCP server `sok mcp`([MCP server](../../cli.ko.md#mcp-server))의 case는 멤버 `mcp`를 가진다. 두 `sok` 구현의 test(`packages/sok/go/tests/mcp_server_test.go`, `packages/sok/rust/tests/mcp_server_test.rs`)는 실제 pipe로 `sok mcp`를 시작하고, case의 step을 endpoint로 실행하며, `mcp`의 step을 MCP client로 실행한다. Server는 일회용 home으로, `CLAUDE_CONFIG_DIR` 없이 시작하므로 test를 실행하는 사람의 skill 파일을 쓰지 않는다.

| 멤버 | 필수 | 의미 |
| --- | --- | --- |
| `arguments` | 아니오 | `sok mcp --config-dir <case의 디렉터리>` 뒤에 오는 인자. 예: `["--window", "main"]`. |
| `environment` | 아니오 | Server 환경의 variable. 예: `{"CODEX_THREAD_ID": "thread-1"}`. 빈 값은 variable을 빈 값으로 정한다. |
| `endpoint` | 아니오 | `"later"`이면 case의 endpoint를 step `start`에서야 시작하므로, server는 먼저 application 없이 실행된다. |
| `steps` | 예 | client의 순서 있는 step. |

첫 step 전에 test는 `initialize`와 `notifications/initialized`로 revision `2025-11-25`의 session을 연다. 단 첫 step이 `client`이면 그 step이 session을 직접 연다. 각 step은 다음 멤버 중 하나를 가진다.

- `tool`: `arguments`(멤버가 없으면 `{}`)로 그 도구를 부르는 `tools/call`. `result`는 결과 JSON 글의 값을, `error`는 도구 오류의 글을 밝히고, 둘 다 없으면 호출은 도구 오류가 아니어야 한다. `as`가 있으면 step은 그 이름으로 호출을 시작하고 답을 기다리지 않는다.
- `await`: `as`가 이름 붙인 호출의 답을 기다리고 그 `result`나 `error`를 검사한다.
- `cancel`: `as`가 이름 붙인 호출에 `notifications/cancelled`를 보낸다. 그 호출은 test가 끝날 때까지 답을 받지 않아야 한다.
- `received`: endpoint가 그 method의 요청을, 이 step까지 그 method의 `received` step 수만큼 받을 때까지 기다린다. `contains`가 있으면 endpoint가 받은 그 method의 마지막 요청이 client가 쓴 그대로 그 글을 담는다.
- `stderr`: server가 그 줄을 표준 오류에 쓸 때까지 기다린다.
- `start`: case의 endpoint를 시작한다(`endpoint: "later"`).
- `client`: message를 그대로 쓴다. `server`가 있으면 client message의 `id`를 가진 답을 기다리고, 답이 `server`가 밝힌 각 멤버를 같은 값으로 가지는지 검사한다.
- `line`: 문자열을 message 한 줄로 그대로 쓴다. lone surrogate escape나 숫자의 글처럼 case의 JSON 값으로 밝힐 수 없는 message에 쓴다. `server`가 있으면 `server`가 밝힌 `id`(server가 읽을 수 없는 줄이면 `id` null)를 가진 새 답을 기다려 `client`처럼 검사한다.
- `hex`: hex 글의 byte를 message 한 줄로 쓴다. 유효한 UTF-8이 아닌 byte처럼 case의 문자열이 담을 수 없는 줄에 쓴다. `server`는 `line`처럼 검사한다.

Step의 문자열 `$config`, `$version`, `$instructions`, `$tools`는 case의 설정 디렉터리, core version, `mcp.json`의 instructions와 tools를 뜻한다. 문자열 안의 `$config`도 그 디렉터리를 뜻하고, case variable의 `$<name>`은 그 example이나 test가 준 값을 뜻한다.

## Producers

- Go host는 endpoint가 혼자 답하는 `replay: true` case와 `"page": "scripted"`인 모든 case를 실행한다(`packages/host/go/tests/endpoint_cases_test.go`). case가 type만 정한 값을 판단하는 test는 그 variable이 묶은 값을 읽는다.
- client는 case의 frame을 이름으로 실행하며 `page`, `log`, `watching`, `watched` step은 무시한다. `packages/client/testing/case-player.js`의 case 형식 검사는 이 step을 `"page": "scripted"`인 case에서만 받아들인다.
