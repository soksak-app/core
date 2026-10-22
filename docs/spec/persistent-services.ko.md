# 영속 서비스

소유자 정리와 retain은 액터 하나가 이미 종료됐거나 실패해도 선택한 모든 표면 액터의 닫기를 시도하고 종료를 기다린다. 남은 액터를 방치하지 않고 실패한 표면을 모두 명시적으로 보고한다. 보고된 실패는 정리 성공이 아니다.

새 연결이 영속 표면에 부착하면 이전 연결의 EOF는 이전 연결의 출력 송신자만 분리한다. 새 부착의 송신자를 지우거나 출력 스트림을 닫으면 안 된다.

[English](persistent-services.md)

이 계약은 승인된 영속 서비스 계약을 정의한다. 구현과 검증은 [기능 상태](../features.ko.md)에서 추적하며, 계약 승인이 구현 완료를 뜻하지 않는다.

## 소유권과 프로세스 수

앱 설정 디렉터리마다 영속 서비스 하나가 세션과 그 자원을 소유한다. 독립 세션은 각각 자식 프로세스를 소유하며, 장치 핸들은 프로세스가 아니다. 독립 세션 3개는 앱 호스트 외에 서비스 하나와 자식 프로세스 3개를 요구한다. 앱 호스트 프로세스와 자식 프로세스가 실행한 프로그램은 별도로 센다.

표면 연결은 세션이 아니다. 표면 키에 대한 첫 열기는 레지스트리 actor 하나를 생성하고 자식 프로세스 시작 전에 안정적인 세션 식별자를 배정하며, 같은 생성 식별자의 반복 요청은 같은 결과를 반환한다. 대체 표면 연결은 자식 프로세스를 생성하지 않는다. 활성 연결이 입력과 크기 변경 권한을 소유하고 오래된 연결에는 명시적 오류를 반환한다. 연결된 표면이 없으면 세션의 크기를 유지한다.

서비스 엔드포인트는 설정 디렉터리로 범위를 제한하고 인증, 버전, 단일 인스턴스 잠금을 갖춘다. 테스트 설정은 다른 설정의 서비스를 탐색하지 않는다. 세션 상태와 입력 큐는 격리한다. 바쁜 세션이 읽기, 쓰기, 출력 처리 중 전역 잠금을 점유해서는 안 된다.

## 종료와 복구

### 서비스 전송

사이드카 선언은 `transport: "persistent"`를 선택한다. 이 필드가 없는 사이드카는 해당 도메인의 stdio 전송을 사용한다. 호스트는 선언한 실행 파일을 `--service-dir <config-dir>/services/<executable-name>`으로 시작한다. 서비스는 해당 디렉터리의 독점 잠금을 얻은 뒤 리스너를 생성한다. Unix 소켓 경로 제한을 지키도록 접근 제한된 짧은 임시 디렉터리에 소켓을 만들고 `{protocol: 1, pid, socket, token}`의 `endpoint.json`을 원자적으로 게시한다. 디렉터리 권한은 0700, 토큰을 담은 파일은 0600이다. stdout 준비 줄은 리스너가 준비된 뒤에만 해당 엔드포인트를 담는다. 서비스는 엔드포인트를 게시하기 전에 시작 작업을 마치므로, 그 비용은 서비스 프로세스마다 한 번 생기고 서비스는 앱 재시작보다 오래 살아 있다. 호스트는 준비 줄을 최대 30초 기다린다. 이 상한은 그 비용보다 훨씬 크며, 준비되지 않는 서비스가 그 사이드카로의 요청과 호스트의 stop을 계속 기다리게 하지 않으려는 것이다. 상한이 지나면 호스트는 자신이 시작한 서비스를 끝내고 회수한 뒤 `sidecar <name>: the service did not print its endpoint within 30s`로 실패한다. 준비 줄 전에 끝난 서비스는 `sidecar <name>: service exited before endpoint`로 시작을 실패시킨다. 호스트는 hello 응답을 최대 5초 기다린 뒤 `sidecar <name>: the service did not answer hello within 5s`로 실패한다.

첫 줄 단위 JSON 메시지는 `{operation: "hello", protocol: 1, token, client}`이며 `client`는 애플리케이션의 설정 폴더다. 서비스는 `{operation: "hello", protocol: 1, version, ok: true}`(`version`은 그 사이드카의 version) 또는 `{operation: "hello", ok: false, error}`로 답한다. 인증 후 표면 메시지는 선언된 사이드카 봉투를 유지한다. `{operation: "close-owner", request}`는 인증한 클라이언트의 세션을 종료하고 정리 뒤 `{operation: "closed-owner", request, ok: true}` 또는 `ok: false`와 `error`로 답한다. `{operation: "shutdown", request}`는 소유자 닫기 이후에만 수락하고 `{operation: "shutdown", request, ok: true}`로 답하며, 클라이언트 연결이 모두 종료된 뒤 서비스를 종료하도록 허용한다. 소켓 EOF는 세션을 보존한다. 엔드포인트 파일만으로 해당 PID를 종료하지 않으며 프로토콜·인증 실패 시 경쟁 서비스를 시작하지 않는다. 좀비로만 남은 프로세스 — 죽은 클라이언트가 기다리지 않은 스폰 — 는 존재하는 서비스로 치지 않으므로 그것이 게시한 낡은 엔드포인트는 교체된다.

표면 숨김, 라이브러리 이동, 앱 연결 단절은 세션을 보존한다. 세션의 명시적 닫기는 해당 세션을 종료한다. 정상 창 닫기는 그 창 소유 세션을, 정상 앱 종료는 모든 소유 세션을 종료한다. 관리 대상 작업 종료, 자식 회수, 장치 핸들 해제, 출력 완료 또는 실패 보고, 연결 작업 제거 후에만 종료 완료다. 종료 오류를 성공으로 바꾸지 않는다.

앱 충돌과 명시적 업데이트 재시작은 서비스를 유지한다. 재연결은 같은 세션, 자식 프로세스, 세션 상태를 복원하며 새 앱 프로세스의 네이티브 이미지는 새로 만들고 프로세스 사이에서 재사용하지 않는다. 서비스는 연결이 없어도 출력을 읽고 처리한다. EOF는 연결 단절이며 세션 종료 명령이 아니다. 서비스가 EOF를 읽기 전에 출력 쪽이 닫힌 클라이언트도 연결 단절이므로, 서비스는 그 클라이언트를 분리하고 세션을 유지한다. 종료 의도를 응답 전에 기록하여 중단된 닫기가 의도적으로 종료한 세션을 복원하지 않게 한다.

앱이 실행 중인 동안 끊긴 연결은 다음 전송을 기다리지 않고 즉시 다시 맺는다. 호스트의 영속 읽기 스레드가 소켓 EOF를 감지하고 같은 단일 생성 경로로 전송을 다시 시작한다 — 살아 있는 서비스에는 다시 붙어 보존된 세션이 `session` 이벤트로 답하고, 죽은 서비스는 낡은 엔드포인트를 지운 뒤 재스폰한다. 재시작은 끊김마다 한 번만 시도하고 실패는 보고하며, 다음 전송이 아래 재시작 한도 안에서 같은 경로를 다시 지나간다. 그림 등록부는 확인한 연결과 함께 죽는다 — 호스트는 정확히 그 사이드카의 그림 configure 상태를 무효화하고 같은 크기의 configure 를 다시 보낸다. 새 서비스에는 그림 상태가 없기 때문이다. 그 사이드카로 전송한 모든 표면은 `sidecar-message` 본문 `{"event": "connection", "connected": true}` 를 받고, 재시작 실패 시 `{"event": "connection", "connected": false, "reason"}` 을 받는다. 표면 페이지는 이것을 재연결 신호로 삼는다 — 남은 사이드카 오류를 해소하고, 세션 부트스트랩을 다시 실행한다(보존 세션에서 `open` 은 아무 일도 하지 않고, 재스폰된 서비스에서는 새 세션을 연다). 이어 사이드카가 선언한 설정을 다시 보낸다. 숨은 탭의 백그라운드 세션도 같은 방식으로 매니페스트 열기 연산을 다시 보낸다. 재스폰된 서비스는 죽은 프로세스의 세션을 보존할 수 없으므로, 다시 마운트되지 않는 숨은 탭은 연결 알림이 도착할 때 새 세션을 시작한다.

영속 서비스의 재시작에는 표준 입출력 transport의 [재시작 한도](sidecars.ko.md#실패)가 적용된다. 호스트는 각 실패를 그 시각으로 세고, 새 실패보다 300초 넘게 앞선 실패는 세지 않으며, timer는 돌지 않는다. 영속 서비스의 실패는 다음 중 하나다.

- 호스트가 사이드카를 종료하고 있지도 않고 그 사이드카를 교체하고 있지도 않을 때 서비스 프로세스가 끝나는 것: 끊긴 연결의 부활이 낡은 엔드포인트를 지운 뒤 또는 남은 것이 없을 때 살아 있는 서비스를 찾지 못하면, 서비스를 스폰하기 전에 그 끝을 센다.
- 호스트가 사이드카를 종료하고 있지도 않고 그 사이드카를 교체하고 있지도 않을 때 생성 경로의 시작이 `the service did not print its endpoint within 30s`, `service exited before endpoint`, `the service did not answer hello within 5s`로 실패하는 것.
- 호스트가 사이드카를 종료하고 있지 않을 때 읽기 스레드가 다음 문단의 이유나 [실패](sidecars.ko.md#실패) 규칙이 거부하는 close 응답으로 연결을 끝내는 것. 읽기 스레드는 연결을 끝낼 때 그것을 세고, 서비스는 계속 돈다.

부활이 살아 있는 서비스에 다시 붙는 끊김은 실패가 아니다. 끊김 하나는 실패를 많아야 하나 센다. 거부 뒤 connect를 다시 시도하는 부활은 그 재시도와 함께 한 번으로 세고, 재스폰한 서비스의 시작이 실패한 부활은 그 시작 실패로 한 번 센다. 전송이 실행한 시작은 자기 실패를 센다. 300초 안의 네 번째 실패는 `error: sidecar <name>: restart limit: 4 failures within 300 s`와 event `host.sidecar.restart-limit` `{sidecar}`를 level `error`로 쓰고, 부활이나 전송이 생성 경로를 다시 실행하기 전에 재시작을 멈춘다. 실패한 시작인 네 번째 실패는 다른 실패한 시작과 같이 보고된다. 부활의 알림은 그 시작 오류를 담고, 전송은 그 오류로 실패한다. 네 번째 실패가 서비스 프로세스의 끝이면 부활은 아무것도 스폰하지 않고, 그 사이드카로 전송한 표면들은 `{"event": "connection", "connected": false, "reason": "restart limit"}`을 받는다. 사이드카가 멈춘 동안 호스트는 부활도 생성도 실행하지 않는다. 전송은 `sidecar <name>: restart limit`으로 실패하고, 호스트는 `error: sidecar <name>: restart limit: request for <surface> refused`를 쓰며, 전송한 표면은 `{"event": "connection", "connected": false, "reason": "restart limit"}`을 받는다. 멈춤이 풀릴 때까지 다른 연결 알림은 쓰지 않고, 멈춤은 `sidecar-failure` 전달을 더하지 않는다. 표면 열기는 [실패](sidecars.ko.md#실패)가 정한 대로 멈춤을 풀고, 다음 전송이 생성 경로를 실행한다. 실패 기록은 애플리케이션 프로세스 안에 있으므로 새 애플리케이션 프로세스는 기록 없이 시작한다.

Host는 service 연결을 한 줄씩 읽고 각 줄에 stdio transport의 [메시지 한도](sidecars.ko.md#메시지)를 적용한다. 한도를 넘는 줄, JSON 객체가 아닌 줄, `operation`, `request`, `ok`, `error`, `closed` field의 형이 틀린 답, 문자열 `surface`와 `body`가 없는 surface event는 그 이유로 연결을 끝낸다. Host는 연결을 닫고, 기다리는 close-owner, shutdown, retain 요청을 실패시키고, 이유를 애플리케이션 log에 쓰고, stdio의 [실패](sidecars.ko.md#실패) 규칙처럼 그 sidecar에 보낸 각 surface에 이유와 함께 `sidecar-failure`를 보낸다. Service는 공유되므로 계속 실행된다. 같은 메시지가 다음 연결도 다시 끝내므로 host는 곧바로 다시 연결하지 않는다. 아래 재시작 한도가 사이드카를 멈추지 않는 한 다음 전송이 생성 경로로 다시 연결하고 연결을 알린다.

서비스는 명시적 shutdown 요청 뒤 클라이언트가 모두 없을 때, SIGTERM이나 SIGINT를 받았을 때, 그리고 서비스 폴더나 `endpoint.json`이 지워지거나 다른 서비스를 가리킬 때 종료한다. 모든 종료는 endpoint, socket 폴더, event 파일의 같은 정리를 거치며, 서비스는 `endpoint.json`이 자기를 가리키는 동안에만 그것을 지운다. 프로젝트 레이아웃이 표면을 가지고 있는 동안 세션은 복구할 수 있고, 그동안 세션은 닫히지 않으며 그 표면은 다른 자식 프로세스를 시작하지 않는다. 세션을 가진 표면의 `open`은 아무것도 시작하지 않고, `open`의 시작 설정은 자식 프로세스를 시작할 때만 적용된다. image와 함께 열렸거나 configure된 image를 가진 표면에 대한 `image` 없는 `open`은 `{error: "imageAttached", reason}`으로 거부되고 아무것도 바꾸지 않는다. 그 `open`은 image가 보이는 채로 표면을 headless로 만들어 세션 출력을 그리지 않고 처리하게 하기 때문이다. `open`과 적용된 `image.configure`마다 표면에 남긴 그리기 mode를 `sidecar.<name>.surface_mode` `{mode, cause}`로 기록하며, `mode`는 `image` 또는 `headless`다. 모든 `retain` 항목은 그 표면을 가진 레이아웃의 프로젝트 root를 담는다. root가 없는 항목은 거부되며 그 잘못은 보낸 쪽에 있다. `{operation: "retain", request, surfaces: [{surface, root}]}`은 인증된 클라이언트의 세션 가운데 root와 표면이 목록에 없는 세션을 모두 닫고, 닫은 수와 함께 `{operation: "retained", request, ok: true, closed}`로, 또는 `ok: false`와 `error`로 답한다. 페이지는 시작할 때, 공간을 닫은 뒤, 그리고 프로젝트가 registry에서 빠진 뒤(각 창은 registry 변경 알림으로 이를 읽고 그 프로젝트 탭들의 surface module을 정리한 다음 보낸다, [프로젝트 창](projects.ko.md#설정)), 모든 프로젝트의 모든 공간 레이아웃의 표면을 프로젝트 root와 함께 보낸다. 호스트는 이 앱 프로세스가 보낸 모든 표면을 더하고, 실행 중이거나 엔드포인트를 게시한 각 영속 서비스에 요청을 전달한다. 따라서 충돌이나 실패한 페이지가 닫힘 알림 없이 남긴, 어떤 레이아웃도 갖지 않은 표면의 세션은 앱이 다시 시작할 때 끝난다. 서비스 장애와 OS 재시작은 실행 프로세스 복구 범위 밖이며 새 자식 프로세스 생성은 복구 증거가 아니다. 공유 서비스는 하나의 프로세스 장애 범위다. 세션 격리가 프로세스 수준 충돌 격리를 의미하지 않는다.

앱 업데이트는 프로토콜 버전이 일치할 때만 실행 중 서비스에 재연결한다. 불일치는 명시적 실패이며 두 번째 서비스 시작, 기존 작업 종료, 호환 경로 사용으로 처리하지 않는다.

### Updates

`hello` 응답의 `version`이 `installed.json`이 그 사이드카에 기록한 version과 다르면(사이드카를 update한 뒤, 또는 애플리케이션이 시작할 때 이전 애플리케이션이 남긴 서비스를 찾았을 때) host는 서비스와 그 세션을 유지하고 그 사이드카를 `host.sidecars`에 `outdated: [{sidecar, running, installed, sessions}]`로 사이드카 순으로 보고한다. `version`을 보내지 않은 서비스는 이전 version의 서비스이므로 `running`이 `null`이고, `sessions`는 그 서비스에 보낸 적이 있는 이 애플리케이션의 열린 표면 수다. host는 목록이 바뀌면 `host.sidecars`를 감시하는 연결에 알린다. host는 `sessions`가 0이 될 때와 page가 host 호출 `sidecarsReplace({sidecar})`를 실행할 때 서비스를 교체한다. `close-owner`와 `shutdown`을 보내고 연결을 닫은 뒤 서비스 endpoint의 process가 끝날 때까지 기다리고, 생성 경로로 설치된 실행 파일을 시작한다. 교체된 서비스의 세션은 끝나고, 그 사이드카에 보낸 적이 있는 표면은 모두 연결 알림을 받아 새 세션을 연다. plugin 화면은 각 outdated 사이드카를 `core.plugins.replace {sidecar}`에 연결된 동작 세션 <sessions>개를 끝내고 적용과 함께 보인다. 실패한 교체는 그 까닭과 함께 보고되고 사이드카는 outdated로 남는다. host는 다른 경로로 서비스를 끝내지 않는다. application log는 `sidecar <name>: service <running> replaced by <installed>`를 기록한다.

## 화면 메시지

사이드카가 페이지에 보내는 `screen` 이벤트는 그려진 화면 전체를 담으므로 페이지는 메시지만으로 [화면 hash](replay.ko.md#화면-hash)를 계산한다. 페이지는 칸을 그리지 않는다. 래스터는 사이드카가 그리며, 메시지의 칸은 래스터가 보여 주는 화면이다. 사이드카 화면 읽기의 응답은 `{rows, frame}`이다: 그 칸의 행과, 그 행을 보이는 frame을 가리키는 event의 `frame`([사이드카](sidecars.ko.md)).

| 멤버 | 형식 |
| --- | --- |
| `event` | `"screen"` |
| `sequence` | 1 이상의 정수: 사이드카가 이 화면에 저장하는 frame 기록의 `sequence`([replay](replay.ko.md#기록)), 곧 화면이 포함하는 마지막 재생 입력의 순번 |
| `segment` | 비어 있지 않은 문자열: 화면을 그린 사이드카 실행의 event 파일의 `boot`이며, `sequence`가 속한 [segment](replay.ko.md#segment)다 |
| `rows`, `cols` | 양의 정수: 격자의 크기 |
| `cursor` | hash가 덮는 `{visible, row, col}`([replay](replay.ko.md#보기-상태), 커서): `visible`은 `true` 또는 `false`, `row`는 0부터 `rows`−1(커서가 viewport 밖이면 `0`), `col`은 0부터 `cols`−1. 런타임의 커서 멤버(`shape`, `blinking`, `blinkVisible`, `focused`)는 hash가 덮지 않는 추가 멤버이고, page는 있는 멤버를 각각 검사하며(`shape`는 `Block`, `Underline`, `Beam`, `HollowBlock`, `Hidden` 또는 소문자로 쓴 같은 단어, `blinking`과 `focused`는 boolean) 없는 멤버는 이전 값을 유지한다 |
| `cells` | 행 우선 순서의 `rows` × `cols`개 칸 |

각 칸은 `grapheme`(칸의 텍스트: 빈 칸과 넓은 문자의 이어지는 칸은 빈 문자열, 그 밖에는 grapheme cluster 하나), `width`(`1`, 넓은 문자의 첫 칸은 `2`, 이어지는 칸은 `0`), `fg`와 `bg`(테마, 반전 속성, 선택 강조를 적용해 정해진 색: 기본색은 `null`, 인덱스 색은 0에서 255까지의 정수, 트루컬러는 소문자 `"#rrggbb"`), `attributes`(화면 hash가 정한 플래그의 0에서 255까지의 정수: bold `01`, dim `02`, italic `04`, underline `08`, blink `10`, inverse `20`, hidden `40`, strikethrough `80`)를 가진다. 칸은 hash가 덮지 않는 `link`를 가질 수 있다. 위의 모든 멤버는 필수다. 메시지에는 생략된 색도 빠진 멤버의 기본값도 없으며, 사이드카는 기본색을 `null`로 적는다.

화면을 만드는 모든 사이드카가 같은 규칙을 따른다. 사이드카가 페이지에 화면을 싣는 메시지는 화면 hash의 멤버와 자신의 frame 기록의 `sequence`를 담으므로 페이지의 frame 기록과 사이드카의 frame 기록을 비교할 수 있다. 멤버와 frame 기록은 사이드카가 쓰며, 페이지는 메시지에 없는 멤버를 만들어 내지 않는다.

`@soksak/plugin-api/screen-hash`의 `screenFromMessage(message)`는 이 형식의 메시지를 검증하고 `screenHash`가 받는 화면을 돌려준다. `sequence`, `segment`, `cursor`, `cells`가 없는 메시지와 정해진 `fg`, `bg`, `attributes`가 없는 칸에는 멤버 이름이 든 오류를 던지고, 값의 범위는 hash가 거부한다. 페이지는 `message.sequence`, `segment`로서의 `message.segment`, 크기, 그 화면의 hash로 page frame 기록을 저장한다. `docs/spec/cases/log-contract/replay/screen-message.json`은 화면 hash의 각 vector마다 같은 hash를 가진 메시지와, 함수가 거부하는 메시지와 그 오류 문구를 담는다. 거부되는 메시지는 `sequence missing`, `sequence zero`, `segment missing`, `event is not screen`, `foreground missing`, `background missing`, `attributes missing`, `cursor missing`, `cells missing`, `color outside the forms`다. 사이드카는 이 hash를 재현하는 메시지를 쓰고, 페이지는 `screenFromMessage`와 `screenHash`로 재현한다.
