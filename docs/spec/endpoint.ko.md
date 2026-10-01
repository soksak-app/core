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

호스트는 듣기를 시작하기 전에 `<config-dir>/process.lock`도 원자적으로 생성한다. 파일 내용은 소유 호스트 PID다. 설정 디렉터리 하나의 소유 앱 프로세스는 정확히 하나이며, 그 프로세스가 여러 창을 소유할 수 있다. 같은 설정 디렉터리를 사용하는 두 번째 프로세스는 `endpoint.json`을 기록하거나 바꾸기 전에 명시적인 소유권 오류와 함께 종료한다. 다른 설정 디렉터리를 사용하는 프로세스는 설정·endpoint·잠금·사이드카 상태가 독립적이므로 동시에 실행할 수 있다. 정상 종료는 잠금을 삭제한다. 비정상 종료 뒤 다음 호스트는 기록된 PID가 더 이상 실행 중일 때만 잠금을 삭제할 수 있으며, 잘못된 형식이거나 살아 있는 잠금은 오류다.

```json
{
  "transport": "unix",
  "address": "/path/to/socket",
  "pid": 1234,
  "application": "wailsv3",
  "version": "0.0.1",
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

등록한 WebView의 포인터 수신 완료는 전송 전과 수신 후의 대기 마우스 처리 완료를 요구한다. 처리 완료 API가 없으면 등록을 거부한다. 전송 전에 기능이 사라지면 이벤트를 보내지 않고 전달을 거부하며, 수신 후 부재도 완료 실패와 해당 API 오류를 보고한다. 네이티브 비-WebView 대상과 명시적으로 등록하지 않은 WebView는 기존 선언된 전송 완료 계약을 유지한다.

## 진단 빌드

다음 메서드는 진단 빌드(Go 빌드 태그 `diagnostics`, cargo feature `diagnostics`)에만 있다. 다른 빌드는 이 메서드를 선언되지 않은 메서드로 거부한다. `make wailsv3-build`와 `make tauriv2-build`는 진단 빌드를 만들고, 배포 대상은 진단 빌드를 만들지 않는다.

| 메서드 | 매개변수 | 용도 |
| --- | --- | --- |
| `diagnostics.fixture` | `{window, settings?}` | 빈 폴더 설정을 가진 `<config-dir>/test-project`를 만들고, 다른 프로젝트를 제거하고, 공통 설정을 초기화하고, 기본값 위에 `settings` 객체를 적용하고, 창에서 그 프로젝트를 연 뒤 `{root}`를 반환한다. 객체가 아닌 `settings`는 거부한다 |
| `diagnostics.drag` | `{window, axis, line, dx, dy, ms, times, capture?}` | `axis`의 경계 `line`을 `ms` 동안 `dx, dy`만큼 끌었다가 되돌리는 왕복을 `times`번 실행한다. 단계 시각은 호스트가 정한다. 동작이 화면에 표시된 뒤 페이지의 끌기 결과 `{from, steps, took, asked, late, deepest}`를 반환한다. 페이지 결과에는 끌기 전과 각 단계 뒤의 경계 위치 `boundary`와 페이지가 각 단계를 적용하는 데 쓴 밀리초 `handled`도 있다. `capture: true`이면 호스트가 창도 기록하고 프레임 폴더 `frames`, 각 단계의 시각 `ticks`, 네이티브 배치 트랜잭션마다 시작 시각, 앱 DOM이 표시를 확인한 시각, 커밋 시각을 담은 `{ticket, begun, presented, committed}`의 목록 `layouts`를 더한다. 일어나지 않은 단계는 `null`이다. 모든 시각은 기록 프레임과 같은 시계의 밀리초다. 끌기가 실패하면 호스트가 기록을 멈추고 폴더를 지운다 |
| `diagnostics.capture.start` | `{window}` | 창의 backing 배율에 맞는 장치 픽셀 해상도로 녹화를 시작하고 첫 프레임이 기록되고 stream 시작이 완료된 뒤(그 완료 전의 중지는 system이 거부한다) 배치 추적을 시작하여 프레임 폴더 `{frames}`를 반환한다 |
| `diagnostics.capture.stop` | `{window, after?}` | `after`(`host.window.presented`의 `displayed`)와 요청 시각 중 늦은 시각 이후에 표시된 화면을 스트림이 전달한 뒤 캡처를 중지하고 `{frames, count, limited, longestGap, layouts}`를 반환한다. `limited`가 true이면 녹화기가 프레임 상한에 도달한 정상적인 제한 결과이며 캡처 오류가 아니다. `longestGap`은 연속한 기록 프레임 사이의 가장 긴 표시 간격(ms)이다. 앱이 커밋한 상태는 요청보다 늦게 화면에 나올 수 있으므로, 그 상태로 끝나야 하는 녹화는 그 표시 시각을 넘긴다 |
| `diagnostics.modal.hold` | `{window, on}` | `on`이면 창의 모달 내용 요청에 대한 호스트 응답을 붙잡고, 아니면 붙잡은 응답을 보내고 붙잡기를 멈춘다 |
| `diagnostics.modal.held` | `{window}` | 창이 모달 내용 응답을 붙잡거나 붙잡기를 멈추면 답한다. 창이 응답을 붙잡고 있지 않으면 실패한다 |
| `diagnostics.transcript` | `{window, on}` | 호스트 요청, 응답, 페이지 검증 줄에 대한 `diagnostics.log` 알림 `{window, line}`을 시작하거나 중지한다 |
| `diagnostics.notifications` | `{}` | 운영체제의 알림 센터가 아직 보이는 이 애플리케이션의 알림을 `[{identifier, title, body}]`로 반환한다. `identifier`는 `[window, surface]`의 JSON 문자열이다 |
| `diagnostics.capture.still` | `{window}` | 창에 포커스를 주지 않고 장치 픽셀 해상도의 정지 PNG를 쓰고, 비공개 `<config-dir>/captures/still-*` 디렉터리 안의 `{path}`를 반환한다. 개발 중 관측 자료이며 측정에는 `diagnostics.capture.start`/`stop` 프레임을 쓴다. 요청자는 확인한 뒤 그 디렉터리를 지운다 |
| `diagnostics.navigation.delay` | `{window, ms}` | window의 main webview가 이후 받는 navigation callback마다 host 처리를 `ms` 밀리초 늦추고(정수 0–10000, 0이면 지연 제거) `null`을 반환한다. window check가 새 page가 시작된 뒤에 navigation callback을 전달할 때 쓴다 |
| `diagnostics.input.source` | `{window, select?}` | `select`가 있으면 켜진 키보드 입력 소스 가운데 그것을 선택하고, 선택된 입력 소스 식별자 `{current}`를 반환한다. 키보드 입력 소스가 없는 플랫폼은 오류를 반환한다. 활성화 등급 창 검사가 사용자의 입력 소스 순서를 재현할 때 쓴다 |

직접 capture.start/stop 녹화의 layouts는 시작 이후의 트랜잭션별 `{ticket, begun, presented, committed}` 배열이며 시각은 프레임과 같은 ms 시계다. 일어나지 않은 단계는 null이며 트랜잭션이 없으면 빈 배열이다. diagnostics.drag는 기존 응답에 자신의 타임라인을 반환한다. 추적 종료 오류가 발생하면 요청자가 받지 못하는 프레임 폴더를 정리하고 오류를 보존한다.

녹화 콜백은 대기 중인 디스크 쓰기를 기다리지 않는다. 64프레임 쓰기 대기 용량이 소진되면 명시적 오류로 녹화를 거부하며 부분 캡처를 성공으로 반환하지 않는다. 종료는 녹화 오류를 보존하고 종료 오류를 추가한다. 600프레임 버스트 상한은 보고하는 유한한 결과로 유지한다.

녹화 프레임 파일 `frame-NNNN.bgra`는 단일 무손실 LZ4 블록 형식을 사용한다. 리틀 엔디언 헤더는 uint32 세 값(너비·높이·BGRA 행 간격), float64 일곱 값(콘텐츠 x/y/너비/높이·콘텐츠 배율·장치 배율·ms 표시 시각), ASCII 네 바이트 `LZ4B`, uint32 압축 블록 바이트 수, 복원한 모든 픽셀 바이트의 uint32 CRC-32로 구성한다. 헤더는 80바이트이며 선언한 압축 바이트가 정확히 뒤따른다. LZ4 블록은 다운샘플링이나 색상 변환 없이 행 패딩을 포함한 stride × height 바이트를 정확히 복원한다. 잘못된 표식·불완전하거나 추가된 바이트·잘못된 블록·복원 크기 불일치·체크섬 오류를 거부하며 오래된 원시 파일을 이 형식으로 해석하지 않는다. 압축 실패는 녹화를 명시적으로 실패시킨다. 생성자와 리더는 이 형식을 구현하며 소유 검사와 재빌드한 호스트 인수는 V5-117-1-3-4-5-2에 기록한다.


배치 타임라인 응답의 상한은 트랜잭션 4096개다. 실제 기록이 상한을 넘으면 호스트는 오류를 반환하고 요청자가 받지 못하는 녹화 디렉터리를 정리한다. 잘린 타임라인을 성공 응답으로 반환하지 않는다.

호스트는 캡처 같은 큰 데이터를 설정 디렉터리 아래 파일에 기록하고, 응답에는 파일 경로를 담는다. 요청자는 측정 후 캡처 파일을 삭제한다.

`diagnostics.drag`는 호스트가 정한 시각에 페이지의 기존 surface-input 경로로 단계를 전달한다. 네이티브 녹화는 해당 제스처의 합성을 측정하며 OS 마우스 버튼 전달을 증명하지 않는다. 합성 검사는 실제 카드 이동과 요청한 모든 왕복도 측정해야 한다. 네이티브 포인터 전달은 별도의 `input.pointer` 검사 대상이다.

## 클라이언트

| 패키지 | 역할 |
| --- | --- |
| `packages/client` | `endpoint.json`을 읽고 연결해 요청을 보내는 라이브러리 |
| `packages/cli` | 하위 명령 `windows`, `list`, `status`(`--watch`는 변경마다 출력), `run`, `dom`, `input`, `capture`(진단 빌드, 관측용 창 정지 이미지)를 가진 `soksak` 명령. 모든 하위 명령에 `--config-dir`가 필요하다 |
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
