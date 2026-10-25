# 사이드카

[English](sidecars.md)

승인된 영속 서비스 계약은 [영속 서비스](persistent-services.ko.md)가 정의한다. 그 프로세스 소유권·전송·종료·복구 규칙은 `transport: "persistent"`를 선언한 모든 사이드카에 적용된다. 다른 stdio 사이드카 도메인은 각 수명주기를 유지한다. [기능 상태](../features.ko.md)는 구현과 앱 검증을 별도로 기록한다.

사이드카는 셸 세션처럼 한 영역의 기능을 담은 네이티브 프로세스다. 플러그인은 네이티브 호스트를 통해 사이드카를 사용하고, 호스트는 메시지를 전달하되 본문을 해석하지 않는다. 사이드카 구현 하나를 Wails와 Tauri가 함께 사용한다.

## 선언과 시작

사이드카는 자기 repository에 있고 `package.json`과 `sidecar.json` 파일을 가진 프로그램이다([Repository](plugins.ko.md#repository)). `package.json`의 `name`이 사이드카를 식별한다(예: `@soksak/sidecar-shell`). [`validateSidecar`](../../packages/plugin-api/index.js)가 이 파일을 검사한다.

| 필드 | 의미 |
| --- | --- |
| `executable` | 빌드된 실행 파일의 sidecar 안 경로 |
| `displayName` | 필수 프로세스 표시 이름으로 형식은 `soksak://sidecar/<id>`이며 `<id>`는 소문자 식별자 한 요소다. 사이드카는 자기 versioned `sidecar.json`에서 build time에 embed한 이 값을 운영체제 프로세스 identity에 적용한다. package dependency 이름과 실행 파일 경로와는 별개이며, 호스트는 이 값을 child environment에 설정하지 않는다. |
| `protocol` | 메시지 형식 버전. 현재 버전은 `1` |
| `helpers` | 선택 필드. 헬퍼 프로그램 목록. 각 항목은 `name`(헬퍼 `package.json`의 `name`)과 `executable`(헬퍼 폴더 안의 경로)을 가진다 |
| `events` | 선택 필드. sidecar의 event catalog 파일의 패키지 안 경로([logging](logging.ko.md#catalog)). 릴리스는 그 파일을 담는다 |
| `replay` | 화면을 만드는 sidecar의 선택 필드 `{role, executable, inputs}`. `role`은 event 파일의 role(소문자 낱말), `executable`은 sidecar 안의 재생 실행 파일 경로([replay](replay.ko.md#재생-실행-파일)), `inputs`는 재생 입력의 종류(`output`, `write`, `resize`, `selection`, `viewport`, `theme`)마다 그것을 저장하는 event 이름이며, 이름은 `sidecar.`로 시작하는 계층 `sidecar`의 이름이다([replay](replay.ko.md#기록)) |

플러그인은 페이지가 사용하는 사이드카를 version 범위와 함께 `plugin.json`의 `dependencies`로 선언한다([플러그인](plugins.ko.md#pluginjson)). 설치는 각 사이드카의 release를 설정 디렉터리에 푼다.

`sidecar.json`은 사용자 데이터가 아니라 버전이 지정된 release의 manifest다. 다른 사이드카 release를 설치하면 그 버전 패키지를 별도 설치 경로에 풀고 설치 선언을 그 패키지로 갱신한다. 필수 manifest 필드를 추가한 release는 package와 의존 plugin의 버전 범위를 함께 갱신하며, 설치가 이전 manifest를 새 manifest로 교체한다. 현재 reader는 `displayName`이 없는 이전 manifest를 파일 경로와 누락 필드를 표시해 거부한다. 이름을 추정하거나 두 manifest 형식을 함께 읽지 않는다. `protocol`은 wire message protocol이며 manifest 버전을 나타내지 않는다.

설치기는 이미 존재하는 sidecar version 폴더를 덮어쓰지 않는다. plugin을 제거하면 해당 package 폴더와 더 이상 설치된 plugin이 선언하지 않는 sidecar 폴더를 정리하며, 다시 설치할 때 선택된 release를 추출한다. 이는 설치된 package 파일을 교체하며 project 문서를 삭제하지 않는다. plugin은 package 폴더 밖에 자체 데이터를 저장할 수 있으므로 sidecar 교체를 위해 제거하기 전에 선언된 저장 계약을 확인한다.

호스트는 설치된 플러그인에서 사이드카를 찾는다([설치된 plugin 제공](installation.ko.md#설치된-plugin-제공)).

1. `plugins/installed.json`이 켜진 플러그인과 그 기록된 폴더, 각 사이드카와 그 기록된 폴더를 나열한다.
2. 각 플러그인 폴더의 `plugin.json`이 그 사이드카를 나열한다.
3. 각 사이드카 폴더의 `sidecar.json`이 그 사이드카의 `executable` 경로, `protocol`, 필수 `displayName`을 지정한다.

호스트는 plugin 작업마다 사이드카를 다시 선언하며([변경 적용](installation.ko.md#변경-적용)), 폴더가 바뀐 사이드카를 교체한다. 호스트는 그 폴더 안의 `executable`을 실행한다. `installed.json`이나 `sidecar.json`이 없거나 틀렸거나, `executable`이 sidecar 안의 경로가 아니거나, `protocol`이 `1`이 아니면 시작 시 실패한다. 페이지가 사이드카에 처음 요청을 보내면 사이드카를 시작한다. 어떤 플러그인도 선언하지 않은 사이드카에 대한 요청은 `sidecar <name> is not declared by any plugin`으로 실패하고, 호스트가 사이드카를 종료한 뒤의 요청도 실패한다.

사이드카가 남기는 자식 프로세스는 호스트의 파이프와 프로세스 그룹을 상속하지 않는다. 호스트가 사이드카의 표준 입력을 닫으면 사이드카는 2초 안에 끝나야 한다. 그렇지 않으면 호스트는 최대 5초까지 기다린 뒤 강제 종료 신호를 보내고 로그에 `sidecar <name>: did not end within the stop timeout and was killed`를 쓴다. 기다리는 동안 호스트는 사이드카의 표준 출력을 출력이 끝날 때까지 읽으므로, 끝나면서 하는 사이드카의 쓰기는 막히지도 실패하지도 않는다. 멈추는 동안 0이 아닌 종료 상태나 신호로 끝난 사이드카는 로그에 `sidecar <name>: exited while stopping: <exit>`로 쓴다. 호스트가 강제 종료한 프로세스와, [실패](#실패) 뒤 호스트가 출력을 더 읽지 않은 프로세스에는 이 줄을 쓰지 않는다. `<exit>`는 두 호스트에서 `exit status <code>`나 `signal <number>`다.

`sidecar.json` 파일을 가진 패키지만 실행 가능한 사이드카이고, 사이드카 repository의 다른 패키지는 그 사이드카가 사용하는 공유 라이브러리와 헬퍼다.

## 메시지

메시지 하나는 한 줄의 JSON 객체다. 표준 출력의 사이드카 메시지는 줄바꿈으로 끝나고 줄바꿈 앞이 최대 67108864 byte(64 MiB)다. 두 호스트가 이 한도를 사용한다. 이 한도는 데이터베이스 schema snapshot 같은 수 MB 메시지를 열 배 이상의 여유로 담고, 호스트가 메시지 하나에 잡는 메모리를 제한한다. 호스트는 읽는 동안 한도를 적용한다. 메시지 하나에 대해 한도와 줄바꿈보다 많이 버퍼링하지 않는다.

| 방향 | 메시지 |
| --- | --- |
| 호스트 → 사이드카 | 페이지 요청은 `{"surface": id, "root": 경로, "cids": [id, …], "body": 값}`. `cids`는 요청이 입력을 이어받을 때만 있고 그 입력들의 상관 식별자 목록이다([logging](logging.ko.md#event)). 요청을 기록하는 사이드카는 이를 자기 event에 옮긴다. `root`는 호스트가 그 표면을 처음 보낼 때 소유 창의 프로젝트 디렉터리다. 사이드카는 root와 표면으로 세션을 찾을 수 있으므로, 창의 프로젝트가 바뀐 뒤에도 그 표면의 이후 요청은 이 root를 유지한다 |
| 호스트 → 사이드카 | 논리 표면이 모든 프로젝트 레이아웃에서 제거되거나 그 창이 닫히면 표면의 root를 담은 `{"surface": id, "root": 경로, "closed": true}`를 그 표면에 요청을 보낸 사이드카 프로세스에만 보낸다. 받은 적이 없는 사이드카는 알림을 받지 않는다. 프로젝트 레이아웃이 표면을 보유한 채 native view만 제거하면 stdio 세션은 닫지만 영속 서비스 세션은 유지한다 |
| 사이드카 → 호스트 | `{"surface": id, "cids": [id, …], "body": 값}`. `cids`는 선택이며 메시지가 답하는 요청들의 상관 식별자 목록이다. `error` member를 가진 객체인 body는 실패한 요청을 밝힌다. host는 이런 메시지를 event `host.sidecar.reply`로 저장한다([결과 형식](logging.ko.md#결과-형식)) |
| 사이드카 → 호스트 | 닫힌 표면의 세션, 프로세스, 감시 같은 자원을 놓은 뒤 `{"surface": id, "closed": true}`, 놓지 못했으면 `{"surface": id, "closed": true, "error": 문장}` |

호스트는 표면에 처음 요청을 보낸 창을 기록하고, 사이드카 메시지를 그 창에만 `sidecar-message` 이벤트 `{sidecar, surface, body}`로 전달한다. `sidecar`는 사이드카 `package.json`의 `name`이다. 다른 창이 같은 표면에 보낸 요청은 실패한다. 애플리케이션이 종료되면 호스트는 각 사이드카의 표준 입력을 닫고 프로세스 종료를 기다린다.

호스트는 사이드카 프로세스마다 요청을 보낸 모든 표면을 그 프로세스가 끝날 때까지 기억한다. 그런 표면 중 소유 창이 없어진 표면의 메시지는 버린다. 호스트가 표면을 제거하고 `closed`를 보낸 뒤, 사이드카가 `closed`에 답하기 전에 보낸 것이다. 같은 표면의 후속 요청은 그 답을 받기 전에 보낼 수 있다. Host는 close 답 전에 이미 buffer에 있던 줄을 포함해 표준 출력 메시지를 현재 surface owner에 전달한다. Wire에는 surface와 선택적 request `cids`가 있으며 별도의 session generation은 없다. sidecar 출력 끝의 line feed 없는 줄은 쓰다가 끝난 process가 남긴 것으로 메시지가 아니다. 출력은 연결처럼 거기서 끝나고 host는 그 줄의 크기를 기록한다. 실행 중인 사이드카가 보낸 폐기 전송 그림에는 `closed`로 답한다([그림 소비](native-surfaces.ko.md#그림-영역)). 호스트가 표준 입출력 사이드카를 중지하기 시작한 뒤 받은 전송 그림은 응답 없이 취소한다. 호스트는 취소를 기록하고 사이드카 process가 끝나기를 기다린다. process 종료가 사이드카 소유 전송 그림 자원을 해제한다. 애플리케이션 연결이 끊겨도 실행을 유지하는 지속 service는 `close-owner`가 끝날 때까지 연결을 유지하고, `shutdown`을 보내 transport를 닫기 전에 폐기 전송 그림에 `closed`로 답한다.

사이드카는 받은 모든 `closed`에 답한다. 닫힌 뒤 다시 보내고 답이 오기 전에 다시 닫힌 표면은 보낸 `closed`마다 답을 기다리는 닫기를 하나씩 가지며, 답 하나가 그중 하나를 마친다. 호스트는 `closed`를 보낸 때부터 응답까지 그 표면을 애플리케이션 상태 `host.sidecars`에 사이드카와 표면 순으로 정렬한 `{closing: [{sidecar, surface}]}`로 두고, 목록이 바뀌면 감시하는 연결에 알린다. `error`가 있는 응답은 호스트 로그에 `sidecar <name>: close <surface>: <error>`로 쓴다. 그 표면에는 받을 소유 창이 없다. 사이드카 프로세스가 끝나거나 지속 연결이 끊기면 호스트는 그 사이드카의 표면을 목록에서 뺀다. 그 세션은 프로세스와 함께 끝났거나 service가 기록된 닫기를 스스로 마치기 때문이다. 호스트가 사이드카를 멈출 때는 표준 입출력 사이드카의 표면을 목록에서 뺀다. 그 프로세스는 끝나기 때문이다. 그 사이드카는 끝나면서도 그 닫기에 답한다. 호스트는 각 답을 받아들이고, `error`가 있는 답은 위와 같이 로그에 쓰며, 그 답을 실패로 다루지 않는다. 지속 service는 호스트가 중지 전에 보낸 닫기에 close-owner 응답보다 먼저 답하므로, 호스트는 각 답이 오거나 연결이 끝날 때까지 그 표면을 두며 그 답은 실패가 아니다. 호스트가 그 프로세스에 한 번도 보내지 않은 표면의 메시지는 [실패](#실패)다. 지속 transport는 애플리케이션 프로세스를 넘어 세션을 유지하므로 service가 이 애플리케이션 프로세스가 아직 보내지 않은 표면에 보낼 수 있다. 그래서 지속 transport는 소유 창이 없는 표면의 메시지를 버린다.

사이드카 요청 body의 동작 선택자는 기존 전송 세부사항이다. 플러그인 manifest는 그 wire 표기를 복사하지 않고 읽기 쉬운 `background.operation` 이름을 선언하며, 워크벤치가 하나의 전송 경계에서 해당 사이드카 요청으로 보낸다. 동작 누락과 사이드카 오류는 실패이며 대체하거나 버리지 않는다.

사이드카는 `sidecar.json`에 메시지 형식을 `message: {form, operationField}`로 선언한다. `form`은 `json-object`이고, `operationField`는 요청 본문에서 작업을 고르는 문자열 필드 이름이다. plugin host가 작업을 부를 수 있게 하는 사이드카는 `hostReadOperations`에 읽기 전용 작업을 나열하며, plugin 매니페스트는 그 가운데 것만 `hostOperations`에 쓸 수 있다([plugins](plugins.ko.md#pluginjson)). 나열이 없는 사이드카는 plugin host에 작업을 허용하지 않는다. 메인 페이지는 선언된 형식으로 각 host 요청을 검사하고, 그 밖의 작업을 사이드카에 닿기 전에 거절한다([plugin host](plugin-host.ko.md#channel)). `@soksak/plugin-api`는 이 선언을 `validateSidecar`와 `checkHostOperations`로 검사한다.

## 실패

표준 입출력을 쓰는 사이드카는 다음 경우에 실패한다.

- 메시지 한도보다 긴 줄을 보낸다.
- 문자열 `surface`와, `body`나 true인 `closed`를 가진 JSON 객체가 아닌 줄을 보낸다.
- 호스트가 닫고 있지 않고, 중지가 목록에서 그 닫기를 빼지도 않은 표면의 `closed`에 답한다.
- 호스트가 그 프로세스에 한 번도 보내지 않은 표면의 메시지를 보낸다.
- 표준 출력 읽기가 실패한다.
- 호스트가 사이드카를 종료하는 중이 아닐 때 표준 출력이 끝난다. 프로세스 종료도 포함한다.

실패 뒤의 프로토콜 상태는 정의되지 않으므로 호스트는 그 프로세스의 메시지를 더 읽지 않는다. 호스트는 프로세스를 실행 중인 사이드카에서 제거하고 강제 종료 신호를 보낸 뒤 끝나기를 기다린다. 그다음 실패를 로그에 쓰고, 그 프로세스에 요청을 보냈고 아직 소유 창이 있는 각 표면의 소유 창에 `sidecar-failure` 이벤트 `{sidecar, surface, reason}`을 전달한다. `reason`은 원인을 밝히는 텍스트로 `message exceeds 67108864 bytes`, `invalid message: <parser 오류>`, `unknown surface <surface>`, `unexpected close answer for <surface>`, `read: <오류>`, `output closed: <exit>` 중 하나다. `<exit>`는 [선언과 시작](#선언과-시작)의 종료 규칙과 같은 형식이다. 실패한 프로세스가 답하지 않은 요청은 답을 받지 않고, 페이지는 대신 실패를 관측한다.

실패 뒤의 전송은 시작 규칙을 따른다. 재시작 한도가 멈추지 않는 한 그 사이드카에 대한 다음 요청이 새 프로세스를 시작한다. 새 프로세스에는 실패한 프로세스의 세션이 없으므로 세션을 유지하는 페이지는 세션을 다시 연다. 각 표면은 소유 창과 첫 root를 유지한다.

재시작 한도는 두 transport의 사이드카에 적용된다. 표준 입출력 사이드카의 실패는 위의 것이고, 영속 서비스의 실패는 [영속 서비스](persistent-services.ko.md#서비스-전송)이 적는 것이다. 호스트는 각 실패의 시각으로 사이드카의 실패를 센다. 시각은 실패 event가 도착할 때 잡으며, timer는 돌지 않는다. 새 실패보다 300초 넘게 앞선 실패는 세지 않는다(sliding window). 네 번째 실패가 세어지면 호스트는 로그에 `error: sidecar <name>: restart limit: 4 failures within 300 s`를 쓰고, `{sidecar}`를 가진 event `host.sidecar.restart-limit`을 level `error`로 쓰며, 그 사이드카의 재시작을 멈춘다. 멈춘 사이드카에 대한 요청은 표면이 실패한 프로세스에 보냈든 나중에 열렸든 어느 표면에서 오든 프로세스를 시작하지 않는다. 호스트는 `error: sidecar <name>: restart limit: request for <surface> refused`를 쓰고, 표면의 소유 창에 `{sidecar, surface, reason: "restart limit"}`인 `sidecar-failure`를 전달하며, 전송은 `sidecar <name>: restart limit`로 실패한다. 거부된 전송의 `sidecar-failure` 전달은 표준 입출력 transport의 보고다. 영속 서비스는 [영속 서비스](persistent-services.ko.md#서비스-전송)이 적는 대로 거부된 전송을 연결 알림으로 보고한다.

멈춤을 푸는 것은 사람의 두 행위뿐이다. 표면을 여는 것과 plugin을 사용하는 것이다. 호스트가 `plugin.json`의 `dependencies`에 그 사이드카를 적은 plugin의 표면을 만들거나, 사람이 그런 plugin을 사용하면, 호스트는 그 사이드카의 실패 기록을 지우고 `{sidecar, surface}`(사용이면 `{sidecar, plugin}`)인 event `host.trace.sidecar.restart-reset`을 level `debug`로 쓰며, 다음 요청이 프로세스를 시작한다. 이미 열린 표면의 요청은 멈춤을 풀지 않으며, 그 사이드카를 적지 않은 plugin의 표면을 만드는 것도 풀지 않는다. 두 행위가 사이드카 멈춤을 푸는 트리거다. 각각은 같은 단계에서 그 plugin의 plugin host 멈춤도 풀므로([plugin host](plugin-host.ko.md#restarts)), 그 뒤 plugin host가 다시 여는 세션은 사이드카 멈춤도 풀린 상태를 만난다. 한도 안의 plugin host 자동 재시작은 어떤 사이드카 멈춤도 풀지 않는다. 표면이 없는 plugin에도 사용 행위는 있으므로, 그 멈춤은 사용으로 풀린다.

호스트가 사이드카를 종료하는 동안 출력의 끝은 실패가 아니다. 멈추는 동안의 다른 실패는 호스트 로그에 `sidecar <name>: failed: <reason>`으로 쓰고, 중지 뒤의 전송은 실패해 페이지가 세션을 다시 열 수 없으므로 호스트는 실패 이벤트를 보내지 않는다. 그다음 [선언과 시작](#선언과-시작)의 종료 규칙이 프로세스를 끝낸다. 멈추는 동안이든 아니든 실패 뒤 호스트가 사이드카의 출력을 더 읽지 않으면 파이프의 자기 쪽 끝을 닫으므로, 사이드카의 이후 쓰기는 막히지 않고 실패한다. 재시작 한도를 뺀 이 실패 규칙은 표준 입출력 transport에 적용된다. 영속 transport는 [영속 서비스](persistent-services.ko.md)이 정의하는 대로 연결 끊김을 알린다.

## Plugin host sessions

[plugin host](plugin-host.ko.md#channel)는 자기 plugin의 `dependencies`에 든 sidecar로 보낸다. 세션 id의 형식은 `plugin:<plugin id>:<project id>:<sidecar name>`이다. plugin id, project id, sidecar 이름 어디에도 `:`이 없으므로 형식은 모호하지 않게 분해된다. `plugin:` 세션에 대한 표면의 send는 `sidecar session <id> is reserved for a plugin host`로 거부되며, 그 세션에는 plugin의 host만 보낸다.

창의 메인 페이지는 host 호출 `pluginHostSidecarSend {plugin, sidecar, id, body, cids}`로 host의 요청을 보낸다. host 호출은 메인 창이 아닌 호출자, plugin이 목록에 두지 않은 sidecar, 다른 plugin이나 sidecar의 이름을 가진 세션 id를 거부한다. 전송은 창이 세션의 project id에 대해 기록한 폴더 root를 쓴다. 창이 보유하지 않은 project나 기록된 root가 빈 project는 시작 전에 거부된다. sidecar의 owner 기록은 다른 표면과 같이 세션에 적용된다. 첫 전송이 창을 owner로 기록한다.

plugin 세션의 실패는 그 sidecar의 실패 기록에 더해지며, 그 기록은 같은 sidecar의 다른 모든 세션과 공유된다. restart limit은 [실패](#실패)가 정하는 대로 적용된다. host는 자기 세션을 닫는다. 메인 페이지는 host가 끝날 때 host 호출 `pluginHostSidecarClose {plugin}`을 부르고, 이는 호출한 창이 소유한 그 plugin의 세션을 닫는다. host는 창이 reload되거나 닫힐 때, 그리고 보유 창이 project를 해제할 때 창의 세션을 닫는다. 각 닫기는 [메시지](#메시지)가 정하는 대로 세션에 `closed`를 보낸다.

## 로그

사이드카는 표준 오류의 한 줄을 글 기록 `<time> <level> <layer> <where>: <text>`([진단](diagnostics.ko.md#형태))로 쓰며 layer는 `sidecar`, `<where>`는 자기 이름이다. 호스트가 표준 입출력으로 시작한 사이드카는 아무 글이나 써도 되고, 호스트가 표준 오류의 각 줄을 읽어 level `info`의 기록으로 쓴다. 영속 서비스는 호스트로 파이프를 열지 않으므로 형식을 스스로 쓰며, 파일 `logs/<실행 파일 이름>.log`에는 그 형식의 기록만 있다.

호스트는 표준 입출력 sidecar든 지속 서비스(`--service-dir`도 받는다)든 모든 sidecar를 인자 `--log-dir <config-dir>/logs`(event 파일의 폴더)와 함께 시작한다. [event 계약](logging.ko.md#파일)을 따르는 sidecar는 그 폴더에 event 파일 `<role>-<boot>.jsonl`을 쓰고, 인자 없이 시작된 sidecar는 event 파일을 쓰지 않는다. 설정 디렉터리 없이 만든 호스트에는 그 폴더가 없으므로 인자를 넘기지 않는다.

## 페이지 인터페이스

`page.sidecar(name)`은 사이드카 이름을 받아 `send(surface, body, cids)`, `on(surface, fn)`, `onFailure(surface, fn)`을 반환한다. `cids`는 요청이 잇는 입력의 상관 식별자이며, host 호출 `sidecarSend`가 이를 요청 줄에 넘긴다([logging](logging.ko.md#상관-식별자)). `on`은 그 사이드카와 표면의 `sidecar-message` 이벤트마다 `fn(body)`를, `onFailure`는 그 사이드카와 표면의 `sidecar-failure` 이벤트마다 `fn(reason)`을 호출한다. 둘 다 구독 등록 후 완료되는 promise를 반환한다. 페이지는 첫 요청 전에 구독한다. 한 사이드카의 전송은 호출한 순서대로 host에 닿고, 실패한 전송은 호출자를 reject하되 이후 전송을 막지 않으며, 표면 문서는 `page.report({level, where, text})`로, 메인 페이지는 host 호출 `report`로 `error page sidecar <name>: send failed: <reason>`을 애플리케이션 로그에 쓴다. 표면의 문서는 `page.report({level, where, text})`로 layer page의 기록을 쓴다(메인 페이지의 host 호출 `report`도 같은 일을 한다).

애플리케이션 문서에서 워크벤치는 첫 사이드카 요청을 보내기 전에 `sidecar-failure` listener 하나를 설치한다. 이 listener는 view·plugin host·background 세션이 워크벤치를 통해 그 사이드카와 표면에 등록한 실패 handler를 호출한다. 등록된 handler가 없으면 워크벤치는 실패를 페이지 오류로 보고한다. 창에 `error` 이벤트를 보내고, 이 이벤트가 실패를 애플리케이션 로그에 쓰고 애플리케이션 오류 알림에 표시한다.

## 그림 봉투

[영역](native-surfaces.ko.md#그림-영역)에 그림을 제공하는 사이드카는 호스트에 그림 봉투를 보낸다.

```json
{
  "surface": "surface-id",
  "body": {
    "image": {
      "name": "region-name",
      "generation": 2,
      "raster": 7,
      "token": {
        "kind": "iosurface-global",
        "id": 12345,
        "nonce": "base64-encoded-16-bytes"
      },
      "width": 800,
      "height": 600,
      "scale": 1.0,
      "format": "bgra8",
      "sequence": 1
    }
  }
}
```

호스트는 봉투를 검증하고 `op` 필드가 없는 응답을 반환한다.

| 상황 | 응답 | 의미 |
| --- | --- | --- |
| 영역이 선언되지 않았거나 세대가 끝났거나 발신자가 권한이 없음 | `{"image": {"error": "notAttached", "name": "...", "generation": ..., "raster": ..., "sequence": ...}}` | 현재 선언 합성에 영역이 없거나 다른 세대·사이드카에 속함 |
| 형식이나 토큰 종류가 지원되지 않거나 논스가 잘못됨 | `{"image": {"error": "unsupported", "name": "...", "generation": ..., "raster": ..., "sequence": ...}}` | 형식은 `bgra8`, 토큰 종류는 `iosurface-global`이어야 함. 논스는 base64 디코딩하면 정확히 16바이트여야 함 |
| IOSurface를 찾지 못했거나 접근 거부됨 | `{"image": {"error": "notFound", "name": "...", "generation": ..., "raster": ..., "sequence": ...}}` | IOSurface 조회 실패 또는 권한 거부 |
| 선언한 크기가 IOSurface의 실제 크기와 맞지 않음 | `{"image": {"error": "size", "name": "...", "generation": ..., "raster": ..., "sequence": ...}}` | 봉투의 가로와 세로가 IOSurface의 실제 픽셀 크기와 같아야 함 |
| 그림 배율이 창의 백킹 배율과 다름 | `{"image": {"error": "scale", "name": "...", "generation": ..., "raster": ..., "sequence": ...}}` | 그림은 창의 현재 백킹 배율로 그려져야 함 |
| 세대, 래스터 리비전, 시퀀스 또는 예상 크기가 오래됨 | `{"image": {"error": "stale", "name": "...", "generation": ..., "raster": ..., "sequence": ...}}` | 프레임이 현재 래스터를 교체할 수 없음 |
| 성공 | `{"image": {"consumed": {"name": "...", "generation": ..., "raster": ..., "sequence": ...}}}` | 호스트가 전송 픽셀을 호스트 소유 불변 표시 저장소로 복사함 |

논스는 IOSurface에 붙은 16바이트 값이고, 호스트는 전역 식별자로 표면을 찾을 때 이를 이용해 표면의 정체성을 검증한다. 세대는 페이지 부착 하나를, 래스터 리비전은 정확한 네이티브 크기·배율 하나를 식별하고, 순서 번호는 그 쌍 안에서 증가한다. 호스트는 응답에 셋을 모두 포함한다.

호스트는 권한 있는 공급자에게 영역 이름, 세대, 래스터 리비전, 정확한 픽셀 크기, 배율을 담은 `configure` 본문을 보낸다. 공급자는 페이지 위치에서 이 값을 계산하면 안 된다. 보낸 전송 표면은 `consumed`나 오류가 올 때까지 수정하거나 재사용하면 안 된다. 호스트는 이 가변 전송 표면을 표시 레이어에 직접 연결하지 않으며, `consumed` 전에 완료한 복사가 재사용 경계다.

호스트가 native image region을 닫으면서 sidecar session은 유지할 때는 native region을 닫은 뒤 해당 region의 supplier에 `{"image":{"detach":{"request":"opaque-id","name":"region-name","generation":2}}}`를 보낸다. Supplier는 해당 generation의 render ownership, 요청된 image, 대기 중 configuration을 해제한 뒤에만 답한다. 미해결 transfer image는 기존 transfer 소유권 규칙에 따라 짝이 맞는 `consumed` 또는 오류 응답, 혹은 연결 종료까지 유지한다. Detach는 surface session과 process를 유지하고 headless 상태로 두므로 image 없는 `open`이 같은 session을 이어갈 수 있다. Supplier는 `image.detached`에 다음 결과 중 하나를 담는다.

| 상황 | 결과 | 상태 변경 |
| --- | --- | --- |
| 현재 설정된 image 이름과 generation이 정확히 일치 | `{ok: true, result: "detached"}` | 해당 image ownership과 configuration을 없애고 session 및 transfer lease 유지 |
| 같은 generation을 이미 detach했고 새 owner가 없음 | `{ok: true, result: "alreadyDetached"}` | 없음 |
| 해당 surface에 image, request, configuration이 없음 | `{ok: true, result: "alreadyAbsent"}` | 없음 |
| 요청 image는 일치하지만 아직 configuration이 없음 | `{ok: true, result: "detached"}` | request를 지우고 detached generation을 기록하며 session 유지 |
| 요청 image 이름이 현재 image와 다름 | `{ok: false, error: "imageNameMismatch"}` | 없음 |
| 요청 generation이 현재 또는 마지막 retired generation보다 오래됨 | `{ok: false, error: "staleGeneration", currentGeneration}` | 없음 |
| 요청 generation이 설정된 attachment보다 더 새로움 | `{ok: false, error: "futureGeneration", currentGeneration}` | 없음 |
| request id를 다른 surface, image 이름 또는 generation에 이미 사용함 | `{ok: false, error: "requestMismatch"}` | 없음 |

모든 결과는 opaque `request`, `name`, `generation`도 그대로 담는다. 같은 tuple이며 더 새 image owner가 생기지 않았을 때만 request id 재전송에 기존 결과를 돌려주며, 다른 tuple로 재사용하면 `requestMismatch`다. 호스트는 정확한 request id, sidecar, surface, image 이름, generation으로 응답을 연결하며 다른 surface, owner, request, generation의 응답은 기다리는 요청을 완료할 수 없다. 호스트는 JSON root, `image` 내부, acknowledgement object 내부의 무관한 member를 materialize하지 않고 선언된 경로의 `image.detached`를 인식한다. 더 깊은 무관한 member가 있어도 응답 처리를 막거나 원본 acknowledgement를 일반 메시지로 전달하지 않는다. Page 시작은 reload가 만든 모든 detach 응답을 받은 뒤 새 page의 background session open과 대체 image attach를 허용한다. 실패하거나 시간이 초과된 detach는 sidecar, surface, image 이름, generation, request id를 밝히며 page 시작을 실패시킨다.

## 테스트

각 사이드카는 자기 디렉터리에서 테스트를 실행한다. 각 호스트는 `tests/sidecars_test.*`에서 fake 사이드카 실행 파일로 전달, 메시지 한도, 실패 전달과 스테이징된 선언 파일을 통한 해석을 검사하고 실제 사이드카를 실행하지 않는다.
