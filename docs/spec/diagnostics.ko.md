# 진단

[English](diagnostics.md)

사용자 컴퓨터에서 한 번 나타난 결함은 결함이 나타나기 전에 애플리케이션이 써 둔 기록으로만 원인을 찾는다. 이 문서는 어떤 기록이 있는지, 누가 쓰는지, 형태가 어떤지, 각 실패가 어디에 기록을 남기는지를 정하는 한 곳이다. [host](hosts.ko.md#애플리케이션-로그), [performance trace](performance-trace.ko.md), [debug view](debug.ko.md)는 자기 부분의 세부를 정하고 파일 표와 규칙은 여기를 가리킨다.

## 폴더

애플리케이션의 모든 진단 파일은 `<config-dir>/logs/` 아래에 있다. 결함을 만난 사람은 이 폴더를 넘기고, [debug view](debug.ko.md)가 이 폴더를 나열하고 저장한다. 진단 파일을 담는 다른 폴더는 없다. `webkit-children.json` 같은 운영 파일은 기록이 아니므로 `logs/` 밖에 둔다.

## 파일

| 파일 | 쓰는 쪽 | 형태 | 한계 |
|---|---|---|---|
| `application.log` | 두 host, `report`를 거친 page, `sp_log_error`를 거친 native 라이브러리, host가 시작한 sidecar의 standard error | 한 형식의 글 기록([형태](#형태)) | 실행이 열 때 100 MB이면 `application.log.1`로 이름을 바꾸고 이전 세대 다섯 개를 남긴다 |
| `<executable-name>.log` | 상주 service. host가 service의 standard error로 연다 | service가 쓰는 같은 형식의 글 기록 | host가 service를 시작할 때 100 MB이면 `<name>.1`로 이름을 바꾸고 이전 세대 다섯 개를 남긴다 |
| `performance.ndjson` | page, 두 host, sidecar, sampler | 한 줄에 JSON event 하나 | 100 MB에서 `performance.ndjson.1`로 회전하고 이전 세대 다섯 개를 남긴다 |
| `state-<time>.json` | debug view가 열릴 때 두 host | JSON 문서 하나 | 없음. 열 때마다 파일 하나 |
| `captures/…` | 진단 빌드의 두 host | PNG와 frame 파일 | 요청한 쪽이 지운다 |

`<time>`은 UTC 시각 `YYYYMMDDTHHMMSSZ`다. 응답 정지 sample은 애플리케이션이 아니라 창 검사 harness가 쓴다.

## 형태

기록은 세 형태이고, 각 사실은 맞는 형태로 기록한다. 줄 형태인 글 기록과 event는 시각을 맨 앞에 두고 같은 layer 이름을 쓰므로, 한 독자가 둘을 같은 순서로 읽는다.

1. **글 기록.** `application.log`나 service log의 한 줄 `<time> <level> <layer> <where>: <text>`. 요소는 공백 하나로 구분한다.
   - `<time>`은 쓴 시각의 UTC `YYYY-MM-DDTHH:MM:SS.mmmZ`로, event의 `ts`와 같은 형태다.
   - `<level>`은 실패면 `error`, 실패가 아닌 상태면 `info`다.
   - `<layer>`는 기록을 쓴 쪽으로 `page`, `host`, `native`, `sidecar` 중 하나다.
   - `<where>`는 동작이나 대상의 이름이고 공백을 담을 수 있으며 처음 나오는 `: `에서 끝난다.
   - `<text>`는 줄의 나머지다. 그 안의 줄바꿈은 두 글자 `\n`으로 써서 기록 하나가 항상 한 줄이다.

   모든 실패는 level `error`의 기록을 쓰고, 그 밖의 기록은 level `info`다. 쓰는 쪽은 level마다 helper 하나를 가진다(Go `LogError`와 `LogInfo`, Rust `log_error`와 `log_info`, native 라이브러리 `sp_log_error`와 `sp_log_info`, page는 level을 받는 `report`). 두 host에 모두 있는 지점은 두 host에서 같은 `<where>`와 `<text>`를 쓴다. host는 읽는 sidecar의 표준 오류 줄마다 level `info`, layer `sidecar`, `<where>`가 sidecar 이름인 기록으로 쓰고, 상주 service는 같은 layer와 `<where>`로 자기 표준 오류를 이 형식으로 쓴다. 형식이 없는 글은 runtime이 쓰는 runtime의 crash 출력(Go panic과 fatal signal 보고, Rust 기본 panic hook의 메시지)뿐이다.
2. **Event.** `performance.ndjson`의 한 줄: `ts`(밀리초가 있는 ISO-8601), `pid`, `layer`, `event`와 그 event의 필드를 가진 JSON 객체. event는 무슨 일이 언제 일어났는지를 계층을 가로지르는 한 시간선의 순서로 기록한다.
3. **State file.** `state-<time>.json`: 한 시점의 애플리케이션 상태로, `time`, `host`, `versions`, `windows`, `page`를 가진다. 쓰는 쪽이 읽지 못한 부분은 그 오류와 함께 기록하고 파일 쓰기를 멈추지 않는다.

## 규칙

- 실패 지점의 기록은 아래 표에 있다. 표에 없는 실패 지점은 이 문서의 결함이다.
- 기록은 실패가 일어난 순간 그것을 알리는 event가 쓴다. timer나 polling으로 실패를 찾지 않는다. 한 원인은 한 줄을 쓰고, 같은 원인의 반복 보고는 아무것도 더하지 않는다.
- 각 파일의 크기 한계는 쓰는 쪽이 파일을 열 때 적용한다. 쓰는 쪽이 하나인 performance trace는 쓰는 동안에도 적용하고, 한 descriptor를 여럿이 쓰는 application log와 service log는 다음에 열 때까지 커진다.
- 입력 경로의 기록은 계층이 본 모든 것을 담는다: 입력한 글자, 모든 범위와 플래그, PTY에 쓰고 읽은 모든 바이트, 전과 후의 입력 문서 상태, 시각. 입력의 결함을 파일만으로 찾으므로 기록은 자르지 않고 계층은 볼 수 있는 값을 빼지 않는다. 파일은 사람의 컴퓨터의 `logs/`에 있고, 사람이 친 글자는 비밀번호를 포함해 그 안에 있다. 결함을 알릴 때 사람이 그 폴더를 넘긴다. 사람이 여는 파일의 내용은 입력이 아니므로 기록하지 않는다.
- 입력 경로의 기록: native 라이브러리는 입력기의 각 콜백(`keyDown`, `insertText`, `setMarkedText`, `unmarkText`, `doCommandBySelector`, `commitThrough`, `reportPreedit`, `clearDocument`, `commitPending`, `inputSourceChanged`, `becomeFirstResponder`, `resignFirstResponder`)을 인자와 문서의 `before`, `after` 상태(`document`, `committed`, `marked`, `selected`, `reportedPreedit`, `source`, `focus`, `closed`, `reports`)를 담은 JSON 객체의 `info native input method`로, page로 보내는 각 JSON 보고를 `info native input report`로 쓴다. plugin은 trace event `region`, `ime`, `input`, `send`, `send.result`, `sidecar.event`를 본문 전체와 함께 쓰고, host는 layer `host`의 trace event `region`(native 영역의 각 event, `surface`, `name`, 본문 전체), `sidecar.send`와 `sidecar.receive`(sidecar로 보내는 각 요청과 받는 각 메시지, `sidecar`, `surface`, 본문 전체)를 쓰며, terminal sidecar는 본문 전체를 담은 `request`, 덩어리마다 길이와 글과 16진수 바이트를 담은 `pty_write`와 `pty_read`, 그리고 `session_open`, `pty_eof`, `pty_read_error`, `session_exit`를 쓴다.
- 기록을 쓰지 못하는 쪽은 할 수 있는 곳에 오류를 알린다. application log를 열지 못한 host는 시작하지 않는다.
- 각 실패 지점에는 그 실패를 일으키고 기록을 읽는 test가 있다.
- state file은 host가 가진 값만으로 완성된다. 그래서 page가 시작하지 못한 창도 `ready` 값과 마지막 오류 줄과 함께 그 안에 있다.

## 실패 지점

표의 행은 시각이 없는 기록을 `<level> <layer> <where>: <text>`로 보인다.

| 실패 | 기록 |
|---|---|
| main page의 module이 불러오지 못하거나 불러오는 중 던진다 | `error page start: <text> @ <file>:<line>`([page 시작](native-host.ko.md#page-시작)) |
| host가 page가 요청한 파일을 내줄 수 없다 | `error host page asset: <path>: not found`, 경로마다 한 번 |
| main page가 첫 화면 뒤에 던지거나 reject한다 | page 오류 표시의 `error page <where>: <text>` |
| 창의 WebContent process가 끝난다 | `error host page process: <window>: terminated` |
| native 호출이 실패한다 | `sp_log_error`의 `error native <where>: <text>` |
| Tauri host의 fatal signal이나 잡히지 않은 예외 | `error native fatal: <signal name>` 또는 `error native fatal: uncaught exception <name>: <reason>` 기록 하나, 그 뒤 process가 끝난다. Wails host의 fatal signal은 Go runtime이 보고를 표준 오류에 쓴다 |
| Rust host가 panic한다 | panic hook의 `error host panic: <file>:<line>: <message>`. Wails host의 panic은 Go runtime이 stack을 표준 오류에 쓴다 |
| host가 실행되는 동안 표준 입출력 sidecar process가 끝난다 | `error host sidecar <name>: failed: output closed: <exit status>` |
| host가 실행되는 동안 상주 service의 연결이 끝난다 | `error host sidecar <name>: connection lost; restarted`, 또는 `connection lost; restart failed: <reason>` |

호출자가 받아 오류 표시로 보이는 실패는 그 표시가 기록한다. endpoint 요청은 실패를 client에 답하고, `sok` 명령은 상태와 메시지를 표준 오류로 끝내며, plugin은 host가 문서의 `failure`로 알린 document region의 탐색 실패를 `tab.error`([plugins](plugins.md))로 보이고 그 표시가 `error page tab error <tab id>: <text>`를 쓴다.

## 읽기

application log는 무엇이 어디서 실패했는지, performance trace는 언제 어떤 순서였는지, state file은 한 시점에 애플리케이션이 무엇을 가졌는지를 답한다. 결함 보고는 `logs/`의 파일과 결함의 시각을 밝힌다.
