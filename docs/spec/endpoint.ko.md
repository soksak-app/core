# 로컬 엔드포인트

[English](endpoint.md)

macOS 호스트가 이 명세를 구현하며 [기능 상태](../features.ko.md)가 검증 결과를 기록한다. Windows와 Linux 전송은 구현하지 않았다.

네이티브 호스트는 JSON-RPC 2.0 엔드포인트로 로컬 클라이언트에 [노출](exposure.ko.md) 메서드를 제공한다. 노출은 제품 기능이므로 모든 빌드에 엔드포인트가 포함된다.

## 전송

| OS | 전송 | 주소와 접근 |
| --- | --- | --- |
| macOS | Unix 도메인 소켓 | 사용자별 임시 디렉터리(`$TMPDIR`, Go `os.TempDir`과 Rust `std::env::temp_dir`의 값) 아래 `soksak/`의 `<application>-<pid>.sock`. 호스트가 디렉터리를 모드 0700으로 생성하며, 경로가 디렉터리가 아니거나 다른 사용자 소유이거나 다른 모드이면 열지 않는다. 소켓의 모드는 0600이다 |
| Linux | Unix 도메인 소켓 | `$XDG_RUNTIME_DIR/soksak`의 소켓. 호스트가 디렉터리를 모드 0700으로 생성한다 |
| Windows | named pipe | `\\.\pipe\soksak-<id>`. 보안 설명자는 현재 사용자만 허용한다 |

소켓 경로 길이가 macOS에서 104바이트, Linux에서 108바이트로 제한되므로 소켓을 설정 디렉터리에 두지 않는다.

구현 위치: 각 [네이티브 호스트](hosts.ko.md)의 `src/platform/<os>/endpoint.*`.

## 주소 확인

호스트는 먼저 듣기를 시작하고, 첫 창을 등록한 뒤에만 `<config-dir>/endpoint.json`을 기록한다. 따라서 파일을 읽은 클라이언트는 그 창에 바로 요청을 보낼 수 있다. `windows.list`는 그 창을 나열하고, 그 창의 호스트 항목은 응답한다. 페이지 항목은 `host.windows`가 그 창을 `ready`로 보고할 때까지 1003을 반환하므로 클라이언트는 그 상태 알림을 기다린다. 첫 창을 등록하지 못한 호스트는 파일을 기록하지 않고 오류로 시작을 끝낸다.

호스트는 듣기를 시작하기 전에 `<config-dir>/process.lock`을 열고(없으면 생성), 열린 파일에 배타적 advisory lock(`flock`, `LOCK_EX | LOCK_NB`)을 걸며 프로세스가 사는 동안 유지한다. 소유 여부는 이 잠금만으로 정해진다. 잠금을 얻은 뒤 호스트는 파일에 JSON 객체 `{"pid": <소유 호스트 PID>, "boot": <호스트 실행의 boot 식별자>}` 하나를 쓴다. boot 식별자는 event log가 이름에 쓰는 것(`logs/host-<boot>.jsonl`)이다. 설정 디렉터리 하나의 소유 앱 프로세스는 정확히 하나이며, 그 프로세스가 여러 창을 소유할 수 있다. 잠금이 걸린 동안 같은 설정 디렉터리의 두 번째 호스트는 `endpoint.json`을 기록하거나 바꾸기 전에 종료한다. 내용이 현재 형식이면 `configuration directory <directory> is already owned by process <pid>`, 내용이 비었거나 아직 쓰이지 않았으면 `configuration directory <directory> is already owned by a live process`로 실패하며, 내용이 다른 형식이면 그 문장 뒤에 `; process.lock is not the current form: <content>`가 붙는다. 거부에 드는 내용은 소유자가 쓴 내용을 256 바이트로 자른 것이다. 다른 설정 디렉터리를 사용하는 프로세스는 설정·endpoint·잠금·사이드카 상태가 독립적이므로 동시에 실행할 수 있다. 잠금이 걸려 있지 않은 파일은 내용과 관계없이, 빈 파일을 제외하고, 종료 경로 없이 끝난 이전 실행이 남긴 것이다. 시작하는 호스트는 그 파일을 넘겨받고 자기 기록을 잠금 아래에 쓰며, event `host.run.unrecorded-end`를 저장한다([logging](logging.md#writers)). 시작자는 잠그기 전에 파일을 만들고, 만드는 순간과 잠금 사이에 잠금 호출을 끼워 넣을 수 없으므로, 잠기지 않은 빈 파일은 아직 잠그지 않은 시작자의 파일일 수 있다. 소유자는 잠금을 쥔 뒤에만 기록을 쓰므로 빈 파일은 이전 실행을 가리키지 않는다. 시작하는 호스트는 그 파일을 `host.run.unrecorded-end`를 저장하지 않고 넘겨받는다. 정상 종료는 잠금을 쥔 채 파일을 삭제하고 나서 잠금을 푼다. 열 수 없거나 읽을 수 없는 잠금은 `<path>: <reason>`으로 실패하며, 두 호스트의 문장은 같다. `sok`의 쓰기 명령은 같은 형식으로 `process.lock`을 배타적으로 만든다. 소유자는 `{"pid": <자기 process 식별자>, "boot": <자기 boot 식별자, `<seconds>-<pid>`, 자기 event 파일의 이름>}`이다. 살아 있는 process의 잠금은 `configuration directory <directory> is already owned by process <pid>`로 거부하고, 끝난 process의 잠금은 지운 뒤 한 번 다시 시도하며, 다른 형식의 잠금은 `<path>: process.lock is not the current form: <content>`(내용은 256 바이트로 잘림)로 거부하고 남겨 둔다. `sok` 명령은 advisory lock을 걸지 않으며, 잠금 파일 자체가 그 소유다.

```json
{
  "transport": "unix",
  "address": "/path/to/socket",
  "pid": 1234,
  "application": "wailsv3",
  "version": "0.0.8",
  "executable": "/path/to/soksak-wailsv3",
  "started": "2026-09-17T09:00:00Z"
}
```

| 필드 | 값 |
| --- | --- |
| `transport` | `unix` 또는 `pipe` |
| `address` | 소켓 경로 또는 파이프 이름 |
| `pid` | 호스트 프로세스 id |
| `application` | `wailsv3` 또는 `tauriv2` |
| `version` | 애플리케이션 버전 |
| `executable` | 심볼릭 링크를 해석한 호스트 실행 파일의 절대 경로 |
| `started` | ISO 8601 시작 시각 |

호스트는 종료할 때 파일과 소켓을 삭제한다. 종료 신호(SIGTERM, SIGINT, SIGHUP)로 요청된 종료도 `host.quit`과 같은 종료를 실행하므로 같다. SIGKILL처럼 그 종료를 거치지 않고 끝난 프로세스는 소켓을 남긴다. 같은 애플리케이션의 다음 호스트는 수신을 시작하기 전에 프로세스가 더 이상 실행 중이 아닌 `<application>-<pid>.sock` 소켓을 제거한다. 클라이언트는 이 파일을 읽어 연결한다. `pid` 프로세스가 실행 중이 아니면 클라이언트는 오류를 보고하고 연결하지 않는다.

## 프레임

각 메시지는 4바이트 빅엔디언 부호 없는 길이와, 그 길이만큼의 UTF-8 JSON-RPC 2.0 객체 하나로 구성된다. 최대 길이는 16 MiB다.

연결은 여러 요청 동안 유지된다. 요청은 `id`로 구분해 다중화하며 응답의 순서는 정해지지 않는다. 서버 알림에는 `id`가 없다.

연결의 구독을 바꾸는 요청(`status.watch`, `status.unwatch`, `diagnostics.transcript`)은 호스트가 받은 순서대로 적용하며, 호스트가 이를 위해 페이지에 보내는 메시지도 같은 순서를 따른다. 구독을 끝내고 같은 구독을 다시 시작하는 클라이언트는 두 요청을 그 순서로 보낸다.

## 연결 종료

호스트는 다음 중 하나를 받으면 연결을 종료한다.

- 최대 길이보다 큰 길이 접두;
- 올바른 JSON이 아닌 본문;
- JSON-RPC 2.0 객체가 아닌 JSON 값;
- 선언되지 않은 메서드.

HTTP 요청 줄은 최대 길이보다 큰 길이 접두 또는 올바르지 않은 JSON으로 읽히므로, 호스트는 메서드를 실행하기 전에 연결을 종료한다.

## 시작

호스트는 창을 표시하기 전에 엔드포인트를 생성한다. 엔드포인트를 생성하지 못하면 애플리케이션은 오류와 함께 종료한다.

등록한 WebView의 포인터 수신 완료는 전송 전과 수신 후의 대기 마우스 처리 완료를 요구한다. 처리 완료 API가 없으면 등록을 거부한다. 전송 전에 기능이 사라지면 이벤트를 보내지 않고 전달을 거부하며, 수신 후 부재도 완료 실패와 해당 API 오류를 보고한다. 전송 전 처리 완료보다 먼저 timeout이나 등록 해제로 끝난 대기는 한 번만 완료하고 그 처리 완료를 취소하므로, 이후 이벤트를 보내지 않는다. 네이티브 비-WebView 대상과 명시적으로 등록하지 않은 WebView는 기존 선언된 전송 완료 계약을 유지한다.

## 기록

host는 선언된 메서드를 부른 client의 모든 요청을 성능 trace가 켜져 있는지와 상관없이 event `host.endpoint.call`로 저장한다. 메서드, 받은 그대로의 params(1024바이트로 자름), 결과, 마이크로초를 담는다([logging](logging.ko.md#입구)). 연결을 닫게 하는 frame(한도를 넘은 frame, 잘못된 JSON, JSON-RPC 2.0 요청이 아닌 값, 선언되지 않은 메서드)은 메서드의 요청이 아니므로 host는 닫는 이유를 `endpoint` 자리의 record로 저장한다.

## Log query

<a id="log-query"></a>메서드 `log.query`는 모든 빌드에 있고 `window`를 받지 않는다. host의 설정 디렉터리의 event 파일을 색인으로 읽는다([logging](logging.ko.md#질의)). 매개변수는 질의 매개변수 객체(`channel`, `level`, `class`, `layer`, `event`, `event_prefix`, `surface`, `session`, `cid`, `run`, `text`, `from_us`, `to_us`, `order`, `limit`, `after`, `since`, `around`, `earlier`, `later`. `{}`는 channel `other`의 처음 500행을 묻는다)이고 결과는 page `{rows, next, tail, scanned}`다(`around`가 있으면 한 행 둘레의 행이고 각 행에 `context`가 있다. [logging](logging.ko.md#질의)). 질의가 거절하는 매개변수는 invalid-params 오류(-32602)와 질의의 문구(`log query level "x" is not one of error, warn, info, debug, trace`)이고, event 구조를 어기는 파일이나 손상된 색인은 `<file>:<line>: <reason>` 문구나 색인을 밝히는 문구의 오류 -32000이다. host는 위의 한도 안의 frame으로 행 최대 5,000개와 줄 8,388,608바이트의 page 하나를 답한다. debug 화면의 page는 host 호출 `logQuery`([debug](debug.ko.md#타임라인))로 같은 질의다.

## 진단 빌드

다음 메서드는 진단 빌드(Go 빌드 태그 `diagnostics`, cargo feature `diagnostics`)에만 있다. 다른 빌드는 이 메서드를 선언되지 않은 메서드로 거부한다. `make wailsv3-build`와 `make tauriv2-build`는 진단 빌드를 만들고, 배포 대상은 진단 빌드를 만들지 않는다.

| 메서드 | 매개변수 | 용도 |
| --- | --- | --- |
| `diagnostics.fixture` | `{window, settings?}` | 빈 폴더 설정을 가진 `<config-dir>/test-project`를 만들고, 다른 프로젝트를 제거하고, 공통 설정을 초기화하고, 기본값 위에 `settings` 객체를 적용하고, 창에서 그 프로젝트를 연 뒤 `{root}`를 반환한다. 객체가 아닌 `settings`는 거부한다 |
| `diagnostics.drag` | `{window, axis, line, dx, dy, ms, times, capture?}` | `axis`의 경계 `line`을 `ms` 동안 `dx, dy`만큼 끌었다가 되돌리는 왕복을 `times`번 실행한다. 단계 시각은 호스트가 정한다. 동작이 화면에 표시된 뒤 페이지의 끌기 결과 `{from, steps, took, asked, late, deepest}`를 반환한다. 페이지 결과에는 끌기 전과 각 단계 뒤의 경계 위치 `boundary`와 페이지가 각 단계를 적용하는 데 쓴 밀리초 `handled`도 있다. `capture: true`이면 호스트가 창도 기록하고 프레임 폴더 `frames`, 각 단계의 시각 `ticks`, 네이티브 배치 트랜잭션마다 시작 시각, 앱 DOM이 표시를 확인한 시각, 커밋 시각을 담은 `{ticket, begun, presented, committed}`의 목록 `layouts`를 더한다. 일어나지 않은 단계는 `null`이다. 모든 시각은 기록 프레임과 같은 시계의 밀리초다. 끌기가 실패하면 호스트가 기록을 멈추고 폴더를 지운다 |
| `diagnostics.capture.start` | `{window, display?}` | `display`가 true이면 창의 중심이 있는 디스플레이에서 이 애플리케이션의 모든 창을 녹화하므로 녹화 중에 만든 창도 첫 프레임부터 기록하고, 아니면 그 창만 녹화한다. 창의 backing 배율에 맞는 장치 픽셀 해상도로 녹화를 시작하고 첫 프레임이 기록되고 stream 시작이 완료된 뒤(그 완료 전의 중지는 system이 거부한다) 배치 추적을 시작하여 프레임 폴더 `{frames}`를 반환한다 녹화 중 창의 장치 픽셀 크기가 바뀌면 recorder는 stream 출력 크기를 그 크기로 바꾼다. stream이 새 크기를 적용하기 전에 전달된 프레임은 헤더의 content scale과 함께 기록되며, 중지는 새 크기의 프레임을 기다린다 |
| `diagnostics.capture.stop` | `{window, after?}` | `after`(`host.window.presented`의 `displayed`)와 요청 시각 중 늦은 시각 이후에 표시된 화면을 스트림이 전달한 뒤 캡처를 중지하고 `{frames, count, limited, longestGap, layouts}`를 반환한다. `limited`가 true이면 녹화기가 프레임 상한에 도달한 정상적인 제한 결과이며 캡처 오류가 아니다. `longestGap`은 연속한 기록 프레임 사이의 가장 긴 표시 간격(ms)이다. 앱이 커밋한 상태는 요청보다 늦게 화면에 나올 수 있으므로, 그 상태로 끝나야 하는 녹화는 그 표시 시각을 넘긴다 |
| `diagnostics.modal.hold` | `{window, on}` | `on`이면 창의 모달 내용 요청에 대한 호스트 응답을 붙잡고, 아니면 붙잡은 응답을 보내고 붙잡기를 멈춘다 |
| `diagnostics.modal.held` | `{window}` | 창이 모달 내용 응답을 붙잡거나 붙잡기를 멈추면 답한다. 창이 응답을 붙잡고 있지 않으면 실패한다 |
| `diagnostics.page.request` | `{window, path}` | 메인 페이지가 애플리케이션의 파일 `path`(`/`로 시작)를 요청하고 `{path, status}`를 돌려준다. host는 없는 파일에 대해 `error host page asset: <path>: not found`를 그 경로에 대해 한 번 쓴다. 상태는 host의 파일 서버가 답한 값이다([진단](diagnostics.ko.md#실패-지점)) |
| `diagnostics.page.calls` | `{window, count}` | 메인 페이지가 host call `theme`을 `count`번(1부터 50까지) 차례로 보내고 경과 밀리초와 함께 `{count, ms}`를 돌려준다. 다른 window가 가린 window의 페이지에서 host call 하나가 두 host 모두 최대 35 ms 걸렸으므로, 이 상한은 요청 하나를 10초 page 요청 timeout보다 충분히 짧게 유지한다. `make host-calls`는 더 큰 수를 여러 요청으로 나누어 보내며 페이지의 host call이 페이지 process에 남기는 것을 측정할 때 쓴다 |
| `diagnostics.host.events` | `{window, count}` | host가 window의 메인 페이지에 data 없는 host event `diagnostics-unlistened`를 `count`번(1부터 1000까지) 보내고 `{count}`를 돌려준다. 페이지는 이 event의 listener를 선언하지 않으므로, `make host-calls EVENTS=N`은 페이지가 listen하지 않는 host event가 페이지 process에 남기는 것을 측정할 때 쓴다. 범위 밖의 `count`는 `diagnostics.host.events requires a count from 1 to 1000`으로 실패한다 |
| `diagnostics.surface.hold` | `{window, surface}` | 메인 페이지는 마운트된 표면 `surface`가 보내는 모든 exposure 답을 호스트가 그 표면의 제거를 알릴 때(`closed`가 있는 `exposure-registered`)까지 붙잡는다. 그다음 붙잡은 답을 순서대로 보내므로 각 답은 호스트가 그 요청을 1003으로 끝낸 뒤에 도착하며([exposure](exposure.ko.md#전달)), 호스트가 그 답들에 응답한 뒤 애플리케이션 로그에 `held exposure replies of surface "<surface>" were sent after the surface closed (<count>)` 줄을 쓴다. 비어 있지 않은 문자열이 아닌 `surface`는 `diagnostics.surface.hold requires surface`로, 마운트되지 않은 표면은 `surface <surface> is not mounted`로, 답을 이미 붙잡은 표면은 `exposure replies of surface "<surface>" are already held`로 실패한다 |
| `diagnostics.surface.held` | `{window, surface}` | 표면이 답 하나를 붙잡으면 답한다. 그 표면의 답을 붙잡고 있지 않으면 `exposure replies of surface "<surface>" are not held`로, 호스트가 먼저 표면을 제거하면 `surface "<surface>" closed before it held an exposure reply`로 실패한다 |
| `diagnostics.transcript` | `{window, on}` | 호스트 요청, 응답, 페이지 검증 줄에 대한 `diagnostics.log` 알림 `{window, line}`을 시작하거나 중지한다 |
| `diagnostics.notifications` | `{}` | 운영체제의 알림 센터가 아직 보이는 이 애플리케이션의 알림을 `[{identifier, title, body}]`로 반환한다. `identifier`는 `[window, surface]`의 JSON 문자열이다 |
| `diagnostics.capture.still` | `{window}` | 창에 포커스를 주지 않고 장치 픽셀 해상도의 정지 PNG를 쓰고, 비공개 `<config-dir>/logs/captures/still-*` 디렉터리 안의 `{path}`를 반환한다. 개발 중 관측 자료이며 측정에는 `diagnostics.capture.start`/`stop` 프레임을 쓴다. 요청자는 확인한 뒤 그 디렉터리를 지운다 |
| `diagnostics.page.collect` | `{window}` | window의 main page를 그리는 WebContent process가 JavaScript 객체를 수집하게 하고, 요청을 보내면 `null`을 반환한다. 메모리 검사는 결과가 다음 수집 시점에 좌우되지 않도록 재기 전에 부른다 |
| `diagnostics.native.objects` | `{window, equal?}` | 애플리케이션 정의 event 하나를 넣고, 애플리케이션이 그 event를 처리한 뒤 공용 macOS library가 window와 webview에 붙인 native 객체의 살아 있는 수 `{windowCompositions, surfaceHosts, inputRegistrations}`를 반환한다(window의 content view 안에서 main webview를 보유하는 composition view, 논리 surface와 붙인 surface webview의 container, main·modal·surface webview의 입력 등록). 수는 `window`만이 아니라 process 전체의 수다. window를 닫는 동안 autorelease된 객체는 AppKit이 그 event 반복의 autorelease pool을 비울 때 해제되고, pool은 애플리케이션이 event를 처리할 때 비워지므로 넣은 event 뒤에 센다. AppKit은 화면에 있던 window를 close animation이 끝날 때까지 유지하고, pool을 비우는 동안 autorelease된 객체를 다음 비우기에서 해제하므로, 닫은 window의 객체는 그 event 뒤에도 남을 수 있다. 세 이름의 음이 아닌 정수를 담은 객체 `equal`을 주면, 요청은 수가 `equal`과 같아질 때 응답한다. 기다리는 동안 library는 main run loop가 잠들기 전마다 event 하나를 더 넣고 그 event를 처리한 뒤마다 수를 비교한다. autorelease pool에 남은 객체를 알리는 event가 없기 때문이다. 10초 안에 수가 `equal`과 같아지지 않으면 요청은 `window object counts did not reach <equal> within 10s; they are <counts>`로 실패하며, 각 수는 `windowCompositions N, surfaceHosts N, inputRegistrations N`으로 쓴다. 그 밖의 `equal`은 `equal must be an object of windowCompositions, surfaceHosts and inputRegistrations, each a non-negative integer`로 실패한다. 애플리케이션이 10초 안에 그 event를 처리하지 않으면 요청은 `the application did not handle an event within 10s`로 실패한다. window check는 project window를 열기 전과 닫은 뒤의 수를 비교한다 |
| `diagnostics.objects` | `{window}` | 창의 객체 수 `{host, page, documents, sessions}`를 돌려준다: `host`는 host process가 그 창을 위해 가진 객체 `{surfaces, regions, documents, sidecarSessions, pendingReplies, eventSubscribers}`이다: 창의 surface, image region, document region(web view 없이 예약된 이름은 여기에 세고 `documents`에는 항목이 없다), surface의 sidecar session, 응답을 기다리는 sidecar 요청과 그 page 요청, 연결과 관찰되는 status의 쌍이다. `page`는 main page 문서의 요소 수(중첩된 것을 포함한 모든 open shadow root의 요소, 곧 보이는 surface의 DOM을 포함한다)와 그 문서 수(문서와 그 frame)이며 `{elements, documents}`다. 숨겨진 tab은 document에 요소를 두지 않으므로 `elements`에 더하지 않는다. `documents`는 창의 각 document region의(`elements`는 open shadow root의 요소도 포함한다) `{surface, document, elements, documents}`를 나열하며, `sessions`는 `sidecarSessions`가 세는 각 sidecar session의 `{sidecar, surface}`를 sidecar와 surface 순서로 나열한다: 실행 중인 사이드카에 보낸 창의 surface 하나가 그 사이드카의 session 하나다. 플랫폼에 그 interface가 없으므로 JavaScript heap 객체 수는 보고하지 않는다. Wails host는 `runtime` `{heapObjectsBytes, heapUnusedBytes, heapFreeBytes, heapReleasedBytes, stacksBytes, metadataOtherBytes, heapGoalBytes, goroutines}`를 더한다. 이것은 `runtime/metrics`로 읽은 process 전체의 Go runtime 수치(`/memory/classes/heap/objects`, `/memory/classes/heap/unused`, `/memory/classes/heap/free`, `/memory/classes/heap/released`, `/memory/classes/heap/stacks`, `/memory/classes/metadata/other`, `/gc/heap/goal`, `/sched/goroutines`)이며, 시스템이 untagged `VM_ALLOCATE`로 보고하는 메모리를 나눈다. Tauri host에는 garbage collection runtime이 없으므로 `runtime`이 없다. 메모리 검사는 가라앉은 기준값 뒤와 반복 조작 뒤에 이것을 읽고, 반복에 따라 늘어나는 수는 결함이다 |
| `diagnostics.heap.profile` | `{window}` | Wails host 전용: garbage를 수집하고 Go runtime의 heap profile(`runtime/pprof`, `go tool pprof -inuse_space`로 읽는다)을 설정 디렉터리 아래 `logs/heap-<pid>-<ms>.pprof`에 쓰고 `{path}`로 답한다. Tauri host에는 garbage collection heap이 없으므로 이 method를 선언하지 않는다 |
| `diagnostics.process.exit` | `{window, pid}` | process `pid`가 끝나면 `null`로 응답하며, kernel의 종료 알림으로 기다린다. 이미 없는 process는 끝난 것이다. window check는 닫은 window의 web content process를 기다리는 데 쓰며, 그 pid는 window가 열려 있을 때 `host.window` `pageProcess`에서 읽는다. 10초 안에 process가 끝나지 않으면 요청은 `process <pid> did not exit within 10s`로 실패한다. 1부터 2147483647 사이의 정수가 아닌 `pid`는 `pid must be a positive integer`로 실패한다 |
| `diagnostics.memory.pressure` | `{window, level}` | process의 memory pressure source가 전달하듯 memory pressure `level`(`normal`, `warn` 또는 `critical`)을 전달하고([호스트](hosts.ko.md#memory-pressure)) `null`로 응답한다. 수준이 바뀌면 다음 `seq`를 가진 보고가 되어 모든 창이 page event `memory-pressure`로 받고, 이미 그 수준이면 아무것도 보고하지 않는다. 다른 `level`은 `level must be normal, warn or critical`로 실패한다 |
| `diagnostics.log.flush` | `{window}` | 지금까지 쓴 기록이 host의 event log에 들어가면 `null`로 답한다(docs/spec/logging.ko.md). 기록은 writer가 다음 배치에 저장하므로 window 검사는 기록이 없음을 단언하기 전에 이것을 쓴다 |
| `diagnostics.host.relaunch` | `{window}` | 창의 저장을 포함해 `host.quit`처럼 애플리케이션을 종료하고, 프로세스가 끝나면 같은 애플리케이션 번들을 같은 인자(같은 `--config-dir` 포함)로 다시 시작한다. 따라서 새 프로세스는 검사가 설정 폴더에 남긴 파일(예: `log-policy.json`)을 읽는다. host는 실행 중인 번들의 `sok app relaunch --wait <pid> --target <실행 중인 번들> [-- <인자>]`를 새 세션에서 준비하고, event log의 마지막 flush 전에 event `host.relaunch.start`와 함께 시작하며, 애플리케이션 업데이트처럼 상주 service를 계속 실행한다. `sok`은 번들을 활성화하지 않고 시작하므로 새 프로세스는 focus를 가져가지 않는다. 종료가 시작되면 `null`로 답한다. 수정된 탭을 지키는 창은 종료를 끝내고 relaunch를 버린다. client는 새 `<config-dir>/endpoint.json`이 다른 프로세스를 가리키면 다시 연결하고, 새 프로세스는 page가 load되기 전에 `endpoint.json`을 쓰므로 page가 답하는 요청은 `host.windows`가 모든 창을 ready로 알린 뒤에 보낸다. 애플리케이션 번들에서 실행되지 않는 애플리케이션은 `application relaunch: <executable> does not run from an application bundle`로 실패한다 |
| `diagnostics.test.mark` | `{window, kind, name, run, result?}` | 시험의 시작이나 끝을 host의 event log에 저장하고, 그 줄이 파일에 들어가면 `{boot, seq}`로 답한다. `boot`는 event 파일의 식별자, `seq`는 줄 번호이며 둘이 함께 위치를 가리킨다. `kind`는 `start` 또는 `end`, `name`과 `run`(시험 실행기의 실행 식별자)은 빈 문자열이 아닌 문자열이고, `result`는 `pass`, `fail`, `skip`이며 `end`에는 필수이고 `start`에는 거부한다. event는 `host.test.start`와 `host.test.end`다(docs/spec/logging.ko.md). 다른 값은 invalid-params 오류 `kind must be start or end`, `name must be a non-empty string`, `run must be a non-empty string`, `result must be pass, fail or skip`, `result is only for an end mark`로 실패한다. event log가 연결되지 않은 host는 `the event log of the host is not attached`로 실패한다 |
| `diagnostics.stall.dump` | `{window, path}` | 창 검사가 쓴 정지 dump의 경로를 event `host.stall.dump`로 저장하고 `diagnostics.test.mark`처럼 `{boot, seq}`로 답한다. `path`는 존재하는 파일의 절대 경로이며, 다른 값은 invalid-params 오류 `path must be a non-empty string`, `path must be absolute`, `path does not name a file: <path>`로 실패한다. event log가 연결되지 않은 host는 `the event log of the host is not attached`로 실패한다 |
| `diagnostics.input.source` | `{window, select?}` | `select`가 있으면 켜진 키보드 입력 소스 가운데 그것을 선택하고 key view의 text input context가 그것을 가진 뒤에 답하며(2 s 안에 갖지 않으면 context가 가진 소스를 밝히는 오류), 선택된 입력 소스 식별자 `{current}`를 반환한다. 키보드 입력 소스가 없는 플랫폼은 오류를 반환한다. 활성화 등급 창 검사가 사용자의 입력 소스 순서를 재현할 때 쓴다 |

직접 capture.start/stop 녹화의 layouts는 시작 이후의 트랜잭션별 `{ticket, begun, requested, presented, committed}` 배열이며 시각은 프레임과 같은 ms 시계다. `requested`는 페이지가 그린 DOM의 표시를 기다리도록 host에 요청한 시각이고, `presented`는 그 표시가 확인된 시각이다. 일어나지 않은 단계는 null이며 트랜잭션이 없으면 빈 배열이다. diagnostics.drag는 기존 응답에 자신의 타임라인을 반환한다. 추적 종료 오류가 발생하면 요청자가 받지 못하는 프레임 폴더를 정리하고 오류를 보존한다.

녹화 콜백은 대기 중인 디스크 쓰기를 기다리지 않는다. 64프레임 쓰기 대기 용량이 소진되면 명시적 오류로 녹화를 거부하며 부분 캡처를 성공으로 반환하지 않는다. 종료는 녹화 오류를 보존하고 종료 오류를 추가한다. 600프레임 버스트 상한은 보고하는 유한한 결과로 유지한다. 상태가 없는 프레임과, 이미지·표시 시각·콘텐츠 사각형·콘텐츠 배율·장치 배율 중 하나가 없는 완성 프레임은 그 프레임 번호와 빠진 항목을 밝힌 오류로 녹화를 거부한다. idle 프레임은 이미지가 없으며 개수만 센다.

녹화 프레임 파일 `frame-NNNN.bgra`의 frame 번호는 한 process의 녹화 사이에서 이어지고 최소 네 자리이므로, 읽는 쪽은 파일 이름 문자열이 아니라 번호로 frame을 정렬한다. 이 파일은 단일 무손실 LZ4 블록 형식을 사용한다. 리틀 엔디언 헤더는 uint32 세 값(너비·높이·BGRA 행 간격), float64 일곱 값(콘텐츠 x/y/너비/높이·콘텐츠 배율·장치 배율·ms 표시 시각), ASCII 네 바이트 `LZ4B`, uint32 압축 블록 바이트 수, 복원한 모든 픽셀 바이트의 uint32 CRC-32로 구성한다. 헤더는 80바이트이며 선언한 압축 바이트가 정확히 뒤따른다. LZ4 블록은 다운샘플링이나 색상 변환 없이 행 패딩을 포함한 stride × height 바이트를 정확히 복원한다. 잘못된 표식·불완전하거나 추가된 바이트·잘못된 블록·복원 크기 불일치·체크섬 오류를 거부하며 오래된 원시 파일을 이 형식으로 해석하지 않는다. 압축 실패는 녹화를 명시적으로 실패시킨다.


배치 타임라인 응답의 상한은 트랜잭션 4096개다. 실제 기록이 상한을 넘으면 호스트는 오류를 반환하고 요청자가 받지 못하는 녹화 디렉터리를 정리한다. 잘린 타임라인을 성공 응답으로 반환하지 않는다.

호스트는 캡처 같은 큰 데이터를 `<config-dir>/logs/captures` 아래 파일에 기록하고, 응답에는 파일 경로를 담는다. 요청자는 측정 후 캡처 파일을 삭제한다.

`diagnostics.drag`는 호스트가 정한 시각에 페이지의 기존 surface-input 경로로 단계를 전달한다. 네이티브 녹화는 해당 제스처의 합성을 측정하며 OS 마우스 버튼 전달을 증명하지 않는다. 합성 검사는 실제 카드 이동과 요청한 모든 왕복도 측정해야 한다. 네이티브 포인터 전달은 별도의 `input.pointer` 검사 대상이다.

## 클라이언트

| 패키지 | 역할 |
| --- | --- |
| `packages/client` | `endpoint.json`을 읽고 연결해 요청을 보내는 라이브러리 |
| `packages/sok/<name>` | 각 애플리케이션의 command line `sok`. Wails는 Go, Tauri는 Rust다([command line](cli.ko.md)). 자기 애플리케이션 설정 폴더나 `--config-dir`의 `endpoint.json`을 읽고, 모든 endpoint method와 선언된 command를 실행한다 |
| `packages/mcp` | stdio MCP 서버. `exposure.list`로 도구를 생성하며 네트워크 포트를 열지 않는다 |

창 검사는 `packages/client`를 사용한다.

## 검사

각 플랫폼은 엔드포인트에 대해 다음 검사를 실행한다.

- HTTP 요청 줄을 보내면 연결이 종료되고 메서드가 실행되지 않는다;
- 다른 사용자는 연결할 수 없다;
- 선언되지 않은 메서드를 보내면 연결이 종료된다;
- 정상 종료 시 호스트가 `endpoint.json`을 삭제한다;
- 종료 신호는 정상 종료를 한 번 요청하고, 다음 신호는 프로세스를 끝낸다;
- 수신 전에 같은 애플리케이션의 끝난 프로세스 소켓을 제거한다.
- 같은 설정 디렉터리의 두 번째 프로세스를 거부하고 정상 종료 때 `process.lock`을 삭제한다.
