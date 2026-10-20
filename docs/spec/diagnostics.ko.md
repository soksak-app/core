# 진단

[English](diagnostics.md)

사용자 컴퓨터에서 한 번 나타난 결함은 결함이 나타나기 전에 애플리케이션이 써 둔 기록으로만 원인을 찾는다. 이 문서는 어떤 기록이 있는지, 누가 쓰는지, 형태가 어떤지, 각 실패가 어디에 기록을 남기는지를 정하는 한 곳이다. [host](hosts.ko.md#애플리케이션-로그), [performance trace](performance-trace.ko.md), [debug view](debug.ko.md)는 자기 부분의 세부를 정하고 파일 표와 규칙은 여기를 가리킨다.

## 폴더

애플리케이션의 모든 진단 파일은 `<config-dir>/logs/` 아래에 있다. 결함을 만난 사람은 이 폴더를 넘기고, [debug view](debug.ko.md)가 이 폴더를 나열하고 저장한다. 진단 파일을 담는 다른 폴더는 없다. `process.lock` 같은 운영 파일은 기록이 아니므로 `logs/` 밖에 둔다.

## 파일

| 파일 | 쓰는 쪽 | 형태 | 한계 |
|---|---|---|---|
| `host-<boot>.stderr` | host 프로세스의 raw 표준 오류: 런타임의 crash 출력과 native 라이브러리의 fatal 줄 | 글 | 실행이 열 때 100 MB이면 `host-<boot>.stderr.1`로 이름을 바꾸고 이전 세대 다섯 개를 남긴다 |
| `crash-found.txt` | 시작할 때마다 host | 글: host가 `host.crash.found`로 알린 시스템 crash report의 경로, 한 줄에 하나([로깅](logging.ko.md)) | 시작할 때마다 lookup이 아직 보는 report만 남기도록 다시 쓴다. 최대 64줄 |
| `stall-<pid>-<ms>.txt`, `stall-<pid>-<ms>-page-<pid>.txt` | host가 응답하지 않을 때 창 검사 harness가 `sample`로 쓴다. host는 경로를 `host.stall.dump`로 저장한다 | 글 | 없음. 정지마다 파일 하나 |
| `host-<boot>.jsonl` | host 프로세스: 자신의 기록, page의 기록(실패와 관측은 `page.record.<level>` event이며 host 호출 `log`의 배치로 중계한다), native 라이브러리의 event 중 level `error`, `warn`, `info` | [로깅 계약](logging.ko.md)의 event | 100 MB에서 회전한다. 닫은 파일은 세대 `host-<boot>.jsonl.<n>`(`.1`이 가장 오래됨)이 되고 지우는 세대는 없다. [보존](logging.ko.md#보존)이 폴더를 6 GiB로 묶는다 |
| `host-<boot>.debug.jsonl` | 같은 프로세스: level `debug`와 `trace`의 event. 첫 event에서 만든다 | [로깅 계약](logging.ko.md)의 event | main 파일처럼 회전하며 `host-<boot>.debug.jsonl.<n>`이 된다 |
| `log-policy.json` | host. 설정 `diagnostics.log`에서 쓴다 | JSON 문서 하나, event 로그의 [정책](logging.ko.md#정책)이며 모든 프로세스가 감시한다 | 설정이 바뀔 때 다시 쓴다 |
| `<executable-name>.log` | 상주 service. host가 service의 standard error로 연다 | service가 쓰는 같은 형식의 글 기록 | host가 service를 시작할 때 100 MB이면 `<name>.1`로 이름을 바꾸고 이전 세대 다섯 개를 남긴다 |
| `heap-<pid>-<ms>.pprof` | 진단 build의 Wails host가 `diagnostics.heap.profile`에 쓴다 | Go runtime의 heap profile(`runtime/pprof`) | 없음. 요청마다 파일 하나 |
| `state-<time>.json` | debug view가 열릴 때 두 host | JSON 문서 하나 | 없음. 열 때마다 파일 하나 |
| `captures/…` | 진단 빌드의 두 host | PNG와 frame 파일 | 요청한 쪽이 지운다 |

`<time>`은 UTC 시각 `YYYYMMDDTHHMMSSZ`다. 응답 정지 sample은 애플리케이션이 아니라 창 검사 harness가 쓴다. 응답하지 않는 host는 자신을 sample할 수 없기 때문이며, harness는 이어서 `diagnostics.stall.dump`를 보내 host가 파일 경로를 event로 저장하게 한다.

표준 오류에는 계약의 어떤 writer도 쓰지 않는 것만 남는다. Wails 프레임워크는 page가 파일을 요청할 때마다 `[AssetFileServerFS] Handling request` 줄을 level `info`로 쓰며, 이 줄이 실패를 뜻하지 않는 2.0 MB를 파일에 채웠다. 그래서 Wails host는 프레임워크 logger의 level을 `warn`(`FrameworkLogLevel`)으로 정한다. 요청 줄은 빠지고 프레임워크의 warning과 error는 남는다. 의미 있는 요청은 `host.binding.call`, `page.call`, host의 `error` 기록이 밝힌다. Tauri host는 표준 오류에 그런 줄을 쓰지 않으므로 level을 정하지 않는다.

## 형태

기록은 세 형태이고, 각 사실은 맞는 형태로 기록한다. 줄 형태인 글 기록과 event는 시각을 맨 앞에 두고 같은 layer 이름을 쓰므로, 한 독자가 둘을 같은 순서로 읽는다.

1. **글 기록.** service log의 한 줄과 기록 event의 보기 `<time> <level> <layer> <where>: <text>`. 요소는 공백 하나로 구분한다.
   - `<time>`은 쓴 시각의 UTC `YYYY-MM-DDTHH:MM:SS.mmmZ`로, event의 `ts`와 같은 형태다.
   - `<level>`은 실패면 `error`, 실패가 아닌 상태면 `info`다.
   - `<layer>`는 기록을 쓴 쪽으로 `page`, `host`, `native`, `sidecar` 중 하나다.
   - `<where>`는 동작이나 대상의 이름이고 공백을 담을 수 있으며 처음 나오는 `: `에서 끝난다.
   - `<text>`는 줄의 나머지다. 그 안의 줄바꿈은 두 글자 `\n`으로 써서 기록 하나가 항상 한 줄이다.

   모든 실패는 level `error`의 기록을 쓰고, 그 밖의 기록은 level `info`다. 쓰는 쪽은 level마다 helper 하나를 가진다(Go `LogError`와 `LogInfo`, Rust `log_error`와 `log_info`, native 라이브러리 `sp_log_error`와 `sp_log_info`, page는 level을 받는 `report`). host의 helper와 `report`는 `where`와 `text` field를 가진 event `<layer>.record.<level>`를 event log에 저장하고, 글 형태는 window-check 하네스와 debug 화면이 그 event를 보이는 보기다. 두 host에 모두 있는 지점은 두 host에서 같은 `<where>`와 `<text>`를 쓴다. host는 읽는 sidecar의 표준 오류 줄마다 level `info`, layer `sidecar`, `<where>`가 sidecar 이름인 기록으로 쓰고, 상주 service는 같은 layer와 `<where>`로 자기 표준 오류를 이 형식으로 쓴다. 형식이 없는 글은 runtime이 쓰는 runtime의 crash 출력(Go panic과 fatal signal 보고, Rust 기본 panic hook의 메시지)뿐이다.
2. **Event.** event 파일의 한 줄: [event 계약](logging.ko.md#event)의 JSON 객체로 `ts_us`, `seq`, `level`, `layer`, `event`와 그 event의 필드를 가진다. event는 무슨 일이 언제 일어났는지를 계층을 가로지르는 한 시간선의 순서로 기록한다.
3. **State file.** `state-<time>.json`: 한 시점의 애플리케이션 상태로, `time`, `host`, `versions`, `windows`, `page`를 가진다. 쓰는 쪽이 읽지 못한 부분은 그 오류와 함께 기록하고 파일 쓰기를 멈추지 않는다.

## 규칙

- 실패 지점의 기록은 아래 표에 있다. 표에 없는 실패 지점은 이 문서의 결함이다.
- `make failures-check`(`make docs-check`에 포함)는 host와 네이티브 라이브러리의 소스가 리터럴 장소로 쓰는 오류 기록마다(`LogError`, `log_error`, `log_failure`, `sp_log_error`의 첫 인자) 장소를 읽고, 아래 표와 그 번역이 `error <layer> <place>`를 적을 것을 요구한다. 소스가 변수나 상수(파일 경로, 호출자가 계산한 label)에서 가져오는 장소는 리터럴 텍스트가 없으므로 검사가 읽지 않는다.
- 기록은 실패가 일어난 순간 그것을 알리는 event가 쓴다. timer나 polling으로 실패를 찾지 않는다. 한 원인은 한 줄을 쓰고, 같은 원인의 반복 보고는 아무것도 더하지 않는다.
- 각 파일의 크기 한계는 쓰는 쪽이 파일을 열 때 적용한다. 쓰는 쪽이 하나인 performance trace는 쓰는 동안에도 적용하고, 한 descriptor를 여럿이 쓰는 application log와 service log는 다음에 열 때까지 커진다.
- 입력 경로의 기록은 계층이 본 모든 것을 담는다: 입력한 글자, 모든 범위와 플래그, PTY에 쓰고 읽은 모든 바이트, 전과 후의 입력 문서 상태, 시각. 입력의 결함을 파일만으로 찾으므로 기록은 자르지 않고 계층은 볼 수 있는 값을 빼지 않는다. 파일은 사람의 컴퓨터의 `logs/`에 있고, 사람이 친 글자는 비밀번호를 포함해 그 안에 있다. 결함을 알릴 때 사람이 그 폴더를 넘긴다. 사람이 여는 파일의 내용은 입력이 아니므로 기록하지 않는다.
- 입력 경로의 기록: native 라이브러리는 입력기의 각 콜백(`keyDown`, `insertText`, `setMarkedText`, `unmarkText`, `doCommandBySelector`, `commitThrough`, `reportPreedit`, `clearDocument`, `commitPending`, `becomeFirstResponder`, `resignFirstResponder`)을 인자와 문서의 `before`, `after` 상태(`document`, `committed`, `marked`, `selected`, `reportedPreedit`, `source`, `focus`, `closed`, `reports`, `active`, `keyWindow`)를 담은 JSON 객체의 `info native input method`로, page로 보내는 각 JSON 보고를 `info native input report`로 쓴다. 입력을 버리는 콜백은 그 기록에 이유를 쓰고(`noop:` 명령은 `"dropped":"noop"`, 글이 아닌 insert나 marked text는 `"dropped":"not text"`), 닫힌 영역으로 가는 보고는 `info native input report dropped`로 쓴다. native 라이브러리는 endpoint가 주입하는 각 pointer·key 입력을 인자(`x`, `y`, `phase`, `button`, `deltaX`, `deltaY` 또는 `key`, `text`, `modifiers`, `down`), `result`(`delivered`, `rejected`, `inactive`, `unreceived`, `button held`, `press open`), 거부의 `reason`을 담은 JSON 객체의 `info native input inject`로 쓰며, 키는 first responder의 class(`responder`)와 창이 key window인지(`keyWindow`)도 담고, plugin은 trace event `region`, `ime`, `input`, `send`, `send.result`, `sidecar.event`를 본문 전체와 함께 쓰고, host는 layer `host`의 trace event `region`(native 영역의 각 event, `surface`, `name`, 본문 전체), `sidecar.send`와 `sidecar.receive`(sidecar로 보내는 각 요청과 받는 각 메시지, `sidecar`, `surface`, 본문 전체)를 쓰며, terminal sidecar는 본문 전체를 담은 `request`, 덩어리마다 길이와 글과 16진수 바이트를 담은 `pty_write`와 `pty_read`, 그리고 `session_open`, `pty_eof`, `pty_read_error`, `session_exit`를 쓴다.
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
| Wails host에서 surface나 modal의 WebContent process가 끝난다 | `error native surface webview: web content process terminated: <address>`. Tauri host는 surface와 modal을 포함한 모든 web view의 종료를 `error host page process: <label>: terminated`로 쓴다 |
| 창의 WebContent process가 끝난다 | `error host page process: <window>: terminated`. 앱 DOM webview가 등록되어 있으면 native 계층은 WebKit 종료 이유(`reason`과 `code`)를 담은 `native.webview.process_ended` 이벤트도 저장한다 |
| Tauri host가 main thread 감시의 heartbeat를 그 thread에 보내지 못한다 | `error host stall watch: heartbeat: <reason>`, 그리고 감시가 끝난다([logging](logging.ko.md), 정지) |
| `diagnostics.input.source`의 선택한 input source 대기가 응답이 끝난 뒤에 답한다(Tauri host) | `error host input source: the wait answered after its reply ended: <result>` |
| writer가 쓴 뒤 event 파일의 색인을 최신으로 맞출 수 없다(event 구조를 어기는 줄, 손상된 색인, 열 수 없는 파일) | `error host log index: <reason>`, 파일마다 이유가 다를 때마다 한 번([logging](logging.ko.md#색인)) |
| 파일 `log-policy.json`이 [정책](logging.ko.md#정책)의 형식을 어기거나(JSON이 아닌 글, 모르는 항목, 빠졌거나 계약 밖인 class, 여섯 밖의 level) 정책을 감시하거나 적용할 수 없다 | `error host log policy: <file>: <발견한 것>`, 파일이 바뀔 때마다 한 번. 적용 중인 정책은 그대로 남는다 |
| document stream을 문서에서 켜거나 끄지 못하거나, 그 스냅샷이나 메시지가 실패한다 | `sp_log_error`의 `error native document stream: <stream> <on or off>: <text>`, `error native document stream: elements snapshot: <text>`, `error native document stream: <stream>: the message is not JSON` |
| native 호출이 실패한다 | `sp_log_error`의 `error native <where>: <text>` |
| Tauri host의 fatal signal이나 잡히지 않은 예외 | `error native fatal: <signal name>` 또는 `error native fatal: uncaught exception <name>: <reason>` 기록 하나, 그 뒤 process가 끝난다. Wails host의 fatal signal은 Go runtime이 보고를 표준 오류에 쓴다 |
| host의 goroutine이나 스레드가 panic한다 | goroutine이나 스레드의 `name`, `text`, `stack`을 담은 event `host.panic`을 프로세스가 상태 2(Go) 또는 101(Rust)로 끝나기 전에 저장한다. Go runtime이나 기본 panic hook도 메시지를 표준 오류에 쓴다 |
| host가 실행되는 동안 표준 입출력 sidecar process가 끝난다 | `error host sidecar <name>: failed: output closed: <exit status>` |
| webview에서 합성 pointer 입력이 끝나지 않는다 | `error native webview input: receipt of <type> did not arrive within <seconds> seconds`, `send of <type> was refused`, `_setIgnoresMouseMoveEvents: is unavailable`, `_doAfterProcessingAllPendingMouseEvents: is unavailable`, `receipt message ignored: <reason>`; `info native webview input: wait for <type> ended by the end of the registration`, `receipt of <type> arrived without a wait` |
| 사이드카 메시지의 표면을 소유한 창이 없거나, closed 알림이 사이드카의 가득 찬 큐를 기다린다 | `info host sidecar <name>: message for surface <surface> dropped: no window owns the surface: <body>`, `info host sidecar <name>: close <surface>: outbox full, buffered` |
| 문서 영역의 이동이 실패하거나, 주소를 거부하거나, plugin 파일을 찾지 못하거나, 데이터 없는 메시지를 받거나, WebContent process를 잃는다 | `info native document view: navigation failed: <reason> (<domain> <code>) <address>`, `navigation refused: <address> is not a web address`, `plugin file not found: <address>`, `message without data: <reason> (<address>)`, `error native document view: web content process terminated: <address>`. 실패는 영역을 소유한 page에도 문서의 `failure`로 닿는다 |
| view가 자기 plugin에 허용되지 않은 core root 파일, core root 규칙 밖의 경로, 또는 enabled가 아닌 요청 plugin을 요청한다 | `error host core root: <path> is not granted to <plugin>`, 요청은 not found로 답한다 |
| view가 `view.error` event를 보내거나, view channel message가 JSON이 아니거나 `message`도 `error`도 없거나, main frame이 아닌 frame에서 message가 온다 | `error host view channel: <reason>`, 그 message는 처리하지 않는다 |
| host가 image 영역의 프레임을 거부하거나 image 필드가 봉투가 아니다 | 영역을 소유하지 않은 sidecar나 이전 raster의 프레임(`notAttached`, `stale`)은 `info host image frame: surface=<s> name=<n> sender=<sidecar> generation=<g> raster=<r> sequence=<q> refused: <reason> current <state>`, host가 표시하지 않는 형식, token, nonce는 `error host image frame: ... refused: unsupported ...`, 봉투가 아닌 image 필드는 `error host image frame: surface=<s> sender=<sidecar> malformed image envelope: <image>` |
| 표면이나 modal 문서의 script가 예외를 던지거나, 그 module이 로드되지 않거나, 그 promise가 처리기 없이 reject된다 | `error page surface <id>: <message> @ <file>:<line>`, `cannot load <address>`, 또는 rejection의 message. 표면 id가 없는 문서는 place `document`를 쓰고, 같은 글은 한 번만 쓴다 |
| Tauri host가 창의 마지막 host.window watch가 끝날 때 마지막으로 보낸 값의 기록을 읽지 못한다 | `error host host.window unwatch: <error>` |
| host가 창의 진단 단계(modal 렌더링, 끌기, navigation callback)를 서술하거나, Wails host가 창 상태를 읽지 못하거나 page에 다시 감시를 요청하지 못한다 | `info host transcript <window>: <line>`, Wails host는 `error host host.window <window>: <error>`, `error host rewatch <name> <window>: <error>`도 쓴다. 기록을 요청한 연결의 진단 기록도 같은 줄을 받는다 |
| page가 sidecar로 보낸 전송이 실패한다 | `error page sidecar <name>: send failed: <reason>`, 표면 문서의 `page.report`로 쓴다 |
| 창에 놓인 파일을 표면에 넘길 수 없다 | `error page drop: <reason>`(잘못된 drop, drop 지점 아래에 표면 없음, plugin이 drop 명령을 선언하지 않음, 명령 실패). 모든 drop은 `info page drop: received <payload>`를 쓰고, 명령이 받으면 `info page drop: command <name> accepted <n> file(s) on surface <id>`도 쓴다 |
| endpoint 요청이 제한 시간 오류 1005로 끝난다(문서가 답하지 않음, 창이 표시되지 않음, 창이 전체 화면을 바꾸지 않음, 문서가 입력을 받지 않음) | `error host endpoint timeout: <method>: <message>` |
| endpoint 연결이 닫힌다 | `info host endpoint: connection closed: <reason>`을 소켓을 닫기 전에 쓴다. reason은 `peer closed`, `frame of <n> bytes exceeds the limit of <limit>`, `frame is not a JSON-RPC 2.0 request: <body>`, `method "<name>" is not declared`, `the endpoint closed`이며 Wails host는 `the output queue is full`, `write failed`, `the reply cannot be encoded`도 쓴다 |
| host가 실행되는 동안 상주 service의 연결이 끝난다 | `error host sidecar <name>: connection lost; restarted`, 또는 `connection lost; restart failed: <reason>` |
| 화면 캡처를 준비하거나 열거나 시작하거나 멈출 수 없거나, 프레임을 저장할 수 없거나, 정지 캡처가 실패한다 | `error native capture preparation`, `error native capture open`, `error native capture start`, `error native capture stop`, `error native capture`, `error native still capture`. 각각 뒤에 `: <reason>`이 붙는다 |
| image region이 프레임을 표시할 수 없거나, region의 입력기가 적용할 수 없는 텍스트를 받는다 | `error native image region: <reason> (state <state>)`, `error native input method: <reason>: state <state>`. region은 이 실패를 page에도 type이 `error`인 event로 알린다 |
| 표면 배치의 문서 완료를 기다리다 실패한다 | `error native surface settle: DOM completion failed: <reason>` |
| native 호출이 입력을 거부하거나 플랫폼이 거부한다. 대상은 web view의 appearance, clipboard, dock menu, file drop, input source, link, surface, web view의 WebContent process, 창의 controls, 창의 facts와 menu다 | `error native appearance`, `error native clipboard`, `error native dock menu`, `error native file drop`, `error native input source`, `error native link`, `error native surface`, `error native webview process`, `error native window controls`, `error native window facts`. 각각 뒤에 `: <reason>`이 붙는다 |
| native 진입점이 등록을 거부한다 (handler 없음, 대상 없음, 유효하지 않은 source 이름, 플랫폼이 token을 돌려주지 않음) | level `error`인 event `native.observe.failed`에 `source`, 등록의 `kind`, `reason`이 붙는다. 성공한 등록은 event `native.observe.registered`다 |
| host가 기다리는 process가 기다린 시간 안에 끝나지 않는다 | level `warn`인 event `native.process.exit_timeout`에 `pid`와 `seconds`가 붙는다 |
| Tauri host가 창에 event를 전달할 수 없거나, 문서 event나 상태의 본문이 JSON이 아니다 | `error host document-event`, `error host document-state`, `error host files-dropped`, `error host modal-rendered`, `error host notification-state`, `error host plugins-changed`, `error host project-close-request`, `error host sidecar-failure`, `error host sidecar-message`, `error host sidecars-changed`, `error host surface-input`, `error host surface-pressed`, `error host window-active`, `error host workspace-changed`, `error host debug-log-changed`, `error host log-policy`, `error host memory-pressure`. 각각 뒤에 `: <reason>`이 붙고 place는 event 이름이다 |
| Tauri host가 endpoint 감시자에게 줄 값을 계산하거나 전달할 수 없거나, 진단 tick이 실패한다 | `error host host.window`, `error host host.window change`, `error host host.windows`, `error host host.windows change`, `error host host.sidecars`, `error host host.sidecars change`, `error host host.buttons`, `error host host.buttons change`, `error host host.log change`, `error host exposure-registered`, `error host diagnostics-tick`, `error host drag tick clock`. 각각 뒤에 `: <reason>`이 붙는다 |
| Tauri host가 main thread에서 돌린 작업이 실패했는데 그 답을 기다리는 요청이 이미 없다 | `error host main-thread work`, `error host native window work`, `error host webview work`, `error host presentation`, `error host activation`, `error host surface focus`, `error host main webview handle`, `error host surface placement`, `error host DOM presentation`. 각각 뒤에 `: <reason>`이 붙는다. 요청이 끝난 뒤 오류 없이 도착한 결과는 본문 `arrived after its request ended`와 함께 `info`로 쓴다 |
| endpoint가 연결을 받거나 읽거나 답하거나 알리거나 쓰거나 닫을 수 없다 | `error host endpoint: closing a connection that does not read`, `error host endpoint accept`, `error host endpoint connection`, `error host endpoint connection close`, `error host endpoint connection write`, `error host endpoint notification`, `error host endpoint release`, `error host endpoint reply`, `error host endpoint close`, `error host endpoint record`(Tauri host가 요청의 params를 event에 쓰려고 읽을 수 없을 때). 각각 뒤에 `: <reason>`이 붙는다 |
| host가 끝나는 중에 event log를 flush할 수 없거나, 종료 요청에 답하거나 취소할 수 없거나, 창이 종료할 수 없거나, 종료 신호 처리기가 실패하거나, 떼어 낸 애플리케이션 업데이트나 relaunch를 시작할 수 없다 | `error host event log flush`, `error host quit request answer`, `error host quit request cancel`, `error host window quit`, `error host termination signal <number>`, `error host application update`, `error host application relaunch`. 각각 뒤에 `: <reason>`이 붙는다 |
| 프로젝트 제거 요청의 답을, 요청한 명령이 기다리기를 이미 끝내서 전달할 수 없다 | `error host project removal: <reason>` |
| Wails host의 framework나 성능 trace가 오류를 알린다 | `error host wails: <reason>`, `error host performance trace: <reason>`(관측이나 sampler를 저장할 수 없다) |
| 창을 만들거나 준비하거나 제목줄을 정하거나 닫을 수 없거나, 메뉴 명령이 실패하거나, 창의 WebContent process를 끝낼 때 죽일 수 없다 | `error host window new`, `error host window prepare`, `error host window title bar`, `error host window close`, `error host menu command <id>`, `error host web content kill`. 각각 뒤에 `: <reason>`이 붙는다 |
| 표면 배치를 취소하거나 제목줄을 되돌릴 수 없거나, 표면 입력 감시를 제거할 수 없거나, shape를 정하거나 없앨 수 없다 | `error host surface layout cancel`, `error host surface layout title bar restore`, `error host surface input`, `error host shape`, `error host shape <id>`. 각각 뒤에 `: <reason>`이 붙는다 |
| 표면의 문서나 이미지를 닫거나 배경을 바꾸거나 답할 수 없다 | `error host document message <name>`, `error host document background`, `error host document close`, `error host document query`, `error host image event`, `error host image close`, `error host image <name>`, `error host image reply <name>`, `error host image response <name>`, `error host image notAttached <name>`, `error host image recovery`. 각각 뒤에 `: <reason>`이 붙는다 |
| 문서 영역의 stream 메시지가 잘못되었거나 전달할 수 없거나, snapshot 확인이 거부된다 | `error host document stream <name>: <reason>`. 이름 `<name>`의 문서에서 실패한 stream 메시지마다 쓰며, 잘못된 메시지, 알 수 없는 stream이나 메시지 type, 거부된 `on`이나 확인, 없는 문서가 해당한다 |
| 모달을 놓거나 모서리를 둥글게 하거나 위로 올리거나 포커스를 돌려줄 수 없거나, 모달 문서를 그리지 못한다 | `error host modal place`, `error host modal corners`, `error host modal raise`, `error host modal focus restoration`, `error host modal state`(모달 기록의 lock이 poisoned), `error host modal <id>`. 각각 뒤에 `: <reason>`이 붙는다 |
| 사이드카를 멈추거나 교체하거나 창을 위해 유지할 수 없거나, 표면이 닫혔음을 알릴 수 없거나, Wails host의 native view 다리가 실패한다 | `error host sidecar stop`, `error host replace`, `error host sidecar retain`, `error host sidecar close <surface>`, `error host native message`, `error host native reply`. 각각 뒤에 `: <reason>`이 붙는다 |
| recording 상태의 lock이 poisoned이다 | `error host recording: <reason>` |
| 알림 센터가 실패를 알리거나, 이벤트를 읽지 못하거나, 알림의 종류를 모르거나, 창과 표면이 없거나, 닫힌 창을 가리킨다 | `error host notification: <reason>` |
| 이전 실행의 crash report를 읽을 수 없거나, crash report 폴더를 나열하거나 알아낼 수 없다 | `error host crash reports: <reason>`, `error native diagnostic reports: the system names no Library folder for the user`. 이유는 파일이나 폴더를 밝히며, 읽을 수 없는 report는 한 번만 보고한다([로깅](logging.ko.md)) |
| 설치된 plugin의 catalog를 쓸 수 없다: 없거나 JSON이 아니거나 `plugin.<plugin>.` 밖의 이름이나 모르는 class를 선언한다 | `error host plugin catalog: <file>: <reason>`. 그 plugin의 event는 `undeclared`로 남고 다른 plugin은 class를 유지한다([로깅](logging.ko.md#plugin-catalog)) |
| image region event의 `cids`가 식별자 목록이 아니거나 `type`이 없어 host가 그 중계를 기록하지 못한다 | `error host input relay: <reason>` |
| 딥링크가 거부된다: URL을 해석할 수 없거나 [딥링크](native-host.ko.md#딥링크) 형식에 맞지 않거나, 열린 창이 없거나, 가리키는 command가 실패한다 | `error host deep link: <url>: <reason>`, URL마다 한 번 |
| Tauri host가 딥링크의 실행 URL을 읽지 못한다 | `error host deep link: launch URL: <reason>` |
| Tauri host가 logs 폴더 저장의 진행이나 끝을 요청한 창에 전달할 수 없다 | `error host debug save: debug-save-progress: <reason>` 또는 `error host debug save: debug-save-done: <reason>` |
| 호스트의 시작 단계가 실패한다 | `error host startup: <reason>`, 그리고 프로세스가 상태 1로 끝난다 |

호출자가 받아 오류 표시로 보이는 실패는 그 표시가 기록한다. endpoint 요청은 실패를 client에 답하고, `sok` 명령은 상태와 메시지를 표준 오류로 끝내며, plugin은 host가 문서의 `failure`로 알린 document region의 탐색 실패를 `tab.error`([plugins](plugins.md))로 보이고 그 표시가 `error page tab error <tab id>: <text>`를 쓴다.

## 읽기

application log는 무엇이 어디서 실패했는지, performance trace는 언제 어떤 순서였는지, state file은 한 시점에 애플리케이션이 무엇을 가졌는지를 답한다. 결함 보고는 `logs/`의 파일과 결함의 시각을 밝힌다.
