# 사이드카

[English](sidecars.md)

승인된 영속 터미널 서비스는 [터미널 런타임](terminal-runtime.ko.md)이 정의한다. 그 프로세스 소유권·전송·종료·복구 규칙은 터미널 사이드카에 적용된다. 다른 stdio 사이드카 도메인은 각 수명주기를 유지한다. [기능 상태](../features.ko.md)는 구현과 앱 검증을 별도로 기록한다.

사이드카는 셸 세션처럼 한 영역의 기능을 담은 네이티브 프로세스다. 플러그인은 네이티브 호스트를 통해 사이드카를 사용하고, 호스트는 메시지를 전달하되 본문을 해석하지 않는다. 사이드카 구현 하나를 Wails와 Tauri가 함께 사용한다.

## 선언과 시작

사이드카는 자기 repository에 있고 `sidecar.json` 파일을 가진 패키지다([Repository](plugins.ko.md#repository)). 사이드카 식별자는 패키지 이름이다(예: `@soksak/sidecar-shell`). [`validateSidecar`](../../packages/plugin-api/index.js)가 이 파일을 검사한다.

| 필드 | 의미 |
| --- | --- |
| `executable` | 빌드된 실행 파일의 패키지 안 경로 |
| `protocol` | 메시지 형식 버전. 현재 버전은 `1` |
| `helpers` | 선택 필드. 헬퍼 패키지 목록. 각 항목은 `package`(패키지 이름)와 `executable`(그 패키지 안의 경로)을 가진다 |

플러그인은 페이지가 사용하는 사이드카 패키지를 version 범위와 함께 `plugin.json`의 `dependencies`로 선언한다([플러그인](plugins.ko.md#pluginjson)). 설치는 각 사이드카의 release asset을 설정 디렉터리에 푼다.

호스트는 설치된 플러그인에서 사이드카를 찾는다([설치된 plugin 제공](installation.ko.md#설치된-plugin-제공)).

1. `plugins/installed.json`이 켜진 플러그인과 그 기록된 폴더, 각 사이드카와 그 기록된 폴더를 나열한다.
2. 각 플러그인 폴더의 `plugin.json`이 그 사이드카 패키지를 나열한다.
3. 각 사이드카 폴더의 `sidecar.json`이 그 사이드카의 `executable` 경로와 `protocol`을 지정한다.

호스트는 그 폴더 안의 `executable`을 실행한다. `installed.json`이나 `sidecar.json`이 없거나 틀렸거나, `executable`이 패키지 안의 경로가 아니거나, `protocol`이 `1`이 아니면 시작 시 실패한다. 페이지가 사이드카에 처음 요청을 보내면 사이드카를 시작한다. 어떤 플러그인도 선언하지 않은 사이드카에 대한 요청은 `sidecar <name> is not declared by any plugin`으로 실패하고, 호스트가 사이드카를 종료한 뒤의 요청도 실패한다.

사이드카가 남기는 자식 프로세스는 호스트의 파이프와 프로세스 그룹을 상속하지 않는다. 호스트가 사이드카의 표준 입력을 닫으면 사이드카는 2초 안에 끝나야 한다. 그렇지 않으면 호스트는 최대 5초까지 기다린 뒤 강제 종료 신호를 보내고 로그에 `sidecar <name>: did not end within the stop timeout and was killed`를 쓴다. 기다리는 동안 호스트는 사이드카의 표준 출력을 출력이 끝날 때까지 읽으므로, 끝나면서 하는 사이드카의 쓰기는 막히지도 실패하지도 않는다. 멈추는 동안 0이 아닌 종료 상태나 신호로 끝난 사이드카는 로그에 `sidecar <name>: exited while stopping: <exit>`로 쓴다. 호스트가 강제 종료한 프로세스와, [실패](#실패) 뒤 호스트가 출력을 더 읽지 않은 프로세스에는 이 줄을 쓰지 않는다. `<exit>`는 두 호스트에서 `exit status <code>`나 `signal <number>`다.

`sidecar.json` 파일을 가진 패키지만 실행 가능한 사이드카이고, 사이드카 repository의 다른 패키지는 그 사이드카가 사용하는 공유 라이브러리와 헬퍼다.

## 메시지

메시지 하나는 한 줄의 JSON 객체다. 표준 출력의 사이드카 메시지는 줄바꿈으로 끝나고 줄바꿈 앞이 최대 67108864 byte(64 MiB)다. 두 호스트가 이 한도를 사용한다. 이 한도는 데이터베이스 schema snapshot 같은 수 MB 메시지를 열 배 이상의 여유로 담고, 호스트가 메시지 하나에 잡는 메모리를 제한한다. 호스트는 읽는 동안 한도를 적용한다. 메시지 하나에 대해 한도와 줄바꿈보다 많이 버퍼링하지 않는다.

| 방향 | 메시지 |
| --- | --- |
| 호스트 → 사이드카 | 페이지 요청은 `{"surface": id, "root": 경로, "body": 값}`. `root`는 호스트가 그 표면을 처음 보낼 때 소유 창의 프로젝트 디렉터리다. 사이드카는 root와 표면으로 세션을 찾을 수 있으므로, 창의 프로젝트가 바뀐 뒤에도 그 표면의 이후 요청은 이 root를 유지한다 |
| 호스트 → 사이드카 | 표면이 제거되거나 그 창이 닫히면 표면의 root를 담은 `{"surface": id, "root": 경로, "closed": true}` |
| 사이드카 → 호스트 | `{"surface": id, "body": 값}` |
| 사이드카 → 호스트 | 닫힌 표면의 세션, 프로세스, 감시 같은 자원을 놓은 뒤 `{"surface": id, "closed": true}`, 놓지 못했으면 `{"surface": id, "closed": true, "error": 문장}` |

호스트는 표면에 처음 요청을 보낸 창을 기록하고, 사이드카 메시지를 그 창에만 `sidecar-message` 이벤트 `{sidecar, surface, body}`로 전달한다. `sidecar`는 패키지 이름이다. 다른 창이 같은 표면에 보낸 요청은 실패한다. 애플리케이션이 종료되면 호스트는 각 사이드카의 표준 입력을 닫고 프로세스 종료를 기다린다.

호스트는 사이드카 프로세스마다 요청을 보낸 모든 표면을 그 프로세스가 끝날 때까지 기억한다. 그런 표면 중 소유 창이 없어진 표면의 메시지는 버린다. 호스트가 표면을 제거하고 `closed`를 보낸 뒤, 사이드카가 `closed`에 답하기 전에 보낸 것이다.

사이드카는 받은 모든 `closed`에 답한다. 호스트는 `closed`를 보낸 때부터 응답까지 그 표면을 애플리케이션 상태 `host.sidecars`에 사이드카와 표면 순으로 정렬한 `{closing: [{sidecar, surface}]}`로 두고, 목록이 바뀌면 감시하는 연결에 알린다. `error`가 있는 응답은 호스트 로그에 `sidecar <name>: close <surface>: <error>`로 쓴다. 그 표면에는 받을 소유 창이 없다. 사이드카 프로세스가 끝나거나 지속 연결이 끊기면 호스트는 그 사이드카의 표면을 목록에서 뺀다. 그 세션은 프로세스와 함께 끝났거나 service가 기록된 닫기를 스스로 마치기 때문이다. 호스트가 사이드카를 멈출 때는 표준 입출력 사이드카의 표면을 목록에서 뺀다. 그 프로세스는 끝나기 때문이다. 그 사이드카는 끝나면서도 그 닫기에 답한다. 호스트는 각 답을 받아들이고, `error`가 있는 답은 위와 같이 로그에 쓰며, 그 답을 실패로 다루지 않는다. 지속 service는 호스트가 중지 전에 보낸 닫기에 close-owner 응답보다 먼저 답하므로, 호스트는 각 답이 오거나 연결이 끝날 때까지 그 표면을 두며 그 답은 실패가 아니다. 호스트가 그 프로세스에 한 번도 보내지 않은 표면의 메시지는 [실패](#실패)다. 지속 transport는 애플리케이션 프로세스를 넘어 세션을 유지하므로 service가 이 애플리케이션 프로세스가 아직 보내지 않은 표면에 보낼 수 있다. 그래서 지속 transport는 소유 창이 없는 표면의 메시지를 버린다.

사이드카 요청 body의 동작 선택자는 기존 전송 세부사항이다. 플러그인 manifest는 그 wire 표기를 복사하지 않고 읽기 쉬운 `background.operation` 이름을 선언하며, 워크벤치가 하나의 전송 경계에서 해당 사이드카 요청으로 보낸다. 동작 누락과 사이드카 오류는 실패이며 대체하거나 버리지 않는다.

## 실패

표준 입출력을 쓰는 사이드카는 다음 경우에 실패한다.

- 메시지 한도보다 긴 줄을 보낸다.
- 문자열 `surface`와, `body`나 true인 `closed`를 가진 JSON 객체가 아닌 줄을 보낸다.
- 호스트가 닫고 있지 않고, 중지가 목록에서 그 닫기를 빼지도 않은 표면의 `closed`에 답한다.
- 호스트가 그 프로세스에 한 번도 보내지 않은 표면의 메시지를 보낸다.
- 표준 출력 읽기가 실패한다.
- 호스트가 사이드카를 종료하는 중이 아닐 때 표준 출력이 끝난다. 프로세스 종료도 포함한다.

실패 뒤의 프로토콜 상태는 정의되지 않으므로 호스트는 그 프로세스의 메시지를 더 읽지 않는다. 호스트는 프로세스를 실행 중인 사이드카에서 제거하고 강제 종료 신호를 보낸 뒤 끝나기를 기다린다. 그다음 실패를 로그에 쓰고, 그 프로세스에 요청을 보냈고 아직 소유 창이 있는 각 표면의 소유 창에 `sidecar-failure` 이벤트 `{sidecar, surface, reason}`을 전달한다. `reason`은 원인을 밝히는 텍스트로 `message exceeds 67108864 bytes`, `invalid message: <parser 오류>`, `unknown surface <surface>`, `unexpected close answer for <surface>`, `read: <오류>`, `output closed: <exit>` 중 하나다. `<exit>`는 [선언과 시작](#선언과-시작)의 종료 규칙과 같은 형식이다. 실패한 프로세스가 답하지 않은 요청은 답을 받지 않고, 페이지는 대신 실패를 관측한다.

실패 뒤의 전송은 시작 규칙을 따른다. 그 사이드카에 대한 다음 요청이 새 프로세스를 시작한다. 새 프로세스에는 실패한 프로세스의 세션이 없으므로 세션을 유지하는 페이지는 세션을 다시 연다. 각 표면은 소유 창과 첫 root를 유지한다.

호스트가 사이드카를 종료하는 동안 출력의 끝은 실패가 아니다. 멈추는 동안의 다른 실패는 호스트 로그에 `sidecar <name>: failed: <reason>`으로 쓰고, 중지 뒤의 전송은 실패해 페이지가 세션을 다시 열 수 없으므로 호스트는 실패 이벤트를 보내지 않는다. 그다음 [선언과 시작](#선언과-시작)의 종료 규칙이 프로세스를 끝낸다. 멈추는 동안이든 아니든 실패 뒤 호스트가 사이드카의 출력을 더 읽지 않으면 파이프의 자기 쪽 끝을 닫으므로, 사이드카의 이후 쓰기는 막히지 않고 실패한다. 이 실패 규칙은 표준 입출력 transport에 적용된다. 영속 transport는 [터미널 런타임](terminal-runtime.ko.md)이 정의하는 대로 연결 끊김을 알린다.

## 페이지 인터페이스

`page.sidecar(name)`은 사이드카 패키지 이름을 받아 `send(surface, body)`, `on(surface, fn)`, `onFailure(surface, fn)`을 반환한다. `on`은 그 사이드카와 표면의 `sidecar-message` 이벤트마다 `fn(body)`를, `onFailure`는 그 사이드카와 표면의 `sidecar-failure` 이벤트마다 `fn(reason)`을 호출한다. 둘 다 구독 등록 후 완료되는 promise를 반환한다. 페이지는 첫 요청 전에 구독한다.

애플리케이션 문서에서 워크벤치는 첫 사이드카 요청을 보내기 전에 `sidecar-failure` listener 하나를 설치한다. 이 listener는 표면 모듈·상태 모듈·background 세션이 워크벤치를 통해 그 사이드카와 표면에 등록한 실패 handler를 호출한다. 등록된 handler가 없으면 워크벤치는 실패를 페이지 오류로 보고한다. 창에 `error` 이벤트를 보내고, 이 이벤트가 실패를 애플리케이션 로그에 쓰고 애플리케이션 오류 알림에 표시한다.

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
| 형식이나 토큰 종류가 지원되지 않거나 논스가 잘못됨 | `{"image": {"error": "unsupported", "name": "...", "sequence": ...}}` | 형식은 `bgra8`, 토큰 종류는 `iosurface-global`이어야 함. 논스는 base64 디코딩하면 정확히 16바이트여야 함 |
| IOSurface를 찾지 못했거나 접근 거부됨 | `{"image": {"error": "notFound", "name": "...", "sequence": ...}}` | IOSurface 조회 실패 또는 권한 거부 |
| 선언한 크기가 IOSurface의 실제 크기와 맞지 않음 | `{"image": {"error": "size", "name": "...", "sequence": ...}}` | 봉투의 가로와 세로가 IOSurface의 실제 픽셀 크기와 같아야 함 |
| 그림 배율이 창의 백킹 배율과 다름 | `{"image": {"error": "scale", "name": "...", "sequence": ...}}` | 그림은 창의 현재 백킹 배율로 그려져야 함 |
| 세대, 래스터 리비전, 시퀀스 또는 예상 크기가 오래됨 | `{"image": {"error": "stale", "name": "...", "generation": ..., "raster": ..., "sequence": ...}}` | 프레임이 현재 래스터를 교체할 수 없음 |
| 성공 | `{"image": {"consumed": {"name": "...", "generation": ..., "raster": ..., "sequence": ...}}}` | 호스트가 전송 픽셀을 호스트 소유 불변 표시 저장소로 복사함 |

논스는 IOSurface에 붙은 16바이트 값이고, 호스트는 전역 식별자로 표면을 찾을 때 이를 이용해 표면의 정체성을 검증한다. 세대는 페이지 부착 하나를, 래스터 리비전은 정확한 네이티브 크기·배율 하나를 식별하고, 순서 번호는 그 쌍 안에서 증가한다. 호스트는 응답에 셋을 모두 포함한다.

호스트는 권한 있는 공급자에게 영역 이름, 세대, 래스터 리비전, 정확한 픽셀 크기, 배율을 담은 `configure` 본문을 보낸다. 공급자는 페이지 위치에서 이 값을 계산하면 안 된다. 보낸 전송 표면은 `consumed`나 오류가 올 때까지 수정하거나 재사용하면 안 된다. 호스트는 이 가변 전송 표면을 표시 레이어에 직접 연결하지 않으며, `consumed` 전에 완료한 복사가 재사용 경계다.

## shell

`@soksak/sidecar-shell`(repository `../sidecars/shell`)은 `make build`로 `build/soksak-shell`을 빌드하고, 표면마다 셸 세션 하나를 실행한다. `open`은 세션이 시작할 디렉터리로, 있는 디렉터리의 절대 경로인 `directory`를 가질 수 있고, 다른 값은 명시적 오류다. 없으면 세션은 표면의 프로젝트 디렉터리(`root`)에서 시작한다. 셸 페이지는 표면의 `origin.directory`가 `null`이 아니면 그것을 보내고 디렉터리 이벤트마다 `tab.directory`로 알리므로([탭 알림](plugins.ko.md#탭-알림)), 셸에서 쪼갠 셸은 그 셸이 있던 곳에서 시작한다. 터미널 에뮬레이터가 아닌 줄 단위 콘솔이다. 코드는 `src/`에 있다: 진입점 `src/main.go`, 패키지 `src/shell`의 프로토콜, `src/platform/platform.go`를 통해 등록되는 `src/platform/{darwin,linux,windows}/`의 운영체제별 동작([플랫폼 선택](hosts.ko.md#플랫폼-선택)). 테스트는 `tests/`에 있다.

세션 셸은 `$SHELL`이 POSIX 셸(`sh`, `bash`, `zsh`, `ksh`, `dash`)이면 그것이고 아니면 `/bin/sh`다. 세션 스크립트가 POSIX 문법을 쓰기 때문이다. 셸은 터미널 없이 자기 프로세스 그룹에서 실행되며 다음 스크립트를 실행한다.

- `trap : INT`로 셸 자신은 중단 신호에 끝나지 않는다. 셸이 시작한 명령은 기본 동작을 유지한다.
- 별도의 명령 파이프(파일 기술자 3)에서 명령을 한 줄씩 읽어 `eval`로 실행한다. 여러 줄에 걸친 구문은 한 줄로 써야 한다.
- 시작할 때와 각 명령이 끝날 때 레코드 구분 문자(`\x1e`)와 `cwd `로 시작하는 한 줄로 현재 디렉터리를 출력한다.

명령의 표준 입력은 두 번째 파이프다. 세션의 표준 출력과 표준 오류는 한 파이프를 공유하므로 줄 순서가 유지된다.

`write`는 셸에 자식 프로세스가 없으면 명령 파이프로, 있으면 실행 중인 명령의 표준 입력으로 간다. 사이드카는 셸 프로세스의 자식 수를 센다(macOS는 `proc_listchildpids`, Linux는 `/proc`). 따라서 명령이 시작되기 전에 쓴 줄은 다음 명령이 되고, 실행 중에 쓴 줄은 그 명령의 입력이 된다.

| 본문 | 동작 |
| --- | --- |
| `{"operation": "open"}` | 표면의 세션을 시작한다. 실행 중인 세션에 대한 요청은 아무것도 하지 않는다 |
| `{"operation": "write", "data": 텍스트}` | 위 규칙에 따라 `텍스트`를 명령 파이프나 실행 중인 명령에 기록한다 |
| `{"operation": "run", "id": 요청, "command": 텍스트}` | 마지막으로 보고된 디렉터리에서 `텍스트`를 `-c`로 한 번, 자기 프로세스 그룹에서 실행하고 끝나면 응답한다. 세션의 변수와 디렉터리는 바뀌지 않는다 |
| `{"operation": "interrupt"}` | 세션의 프로세스 그룹과 실행 중인 모든 `run` 명령에 중단 신호를 보낸다 |

사이드카가 보내는 이벤트 본문은 다음과 같다.

| 이벤트 본문 | 의미 |
| --- | --- |
| `{"text": 줄}` | 줄바꿈을 포함한 출력 한 줄 |
| `{"cwd": 경로}` | 세션의 현재 디렉터리. 보고 줄은 텍스트로 보내지 않는다 |
| `{"id": 요청, "output": 텍스트, "exit": 코드}` | `run`의 병합된 출력과 종료 상태 |
| `{"id": 요청, "error": 메시지}` | 시작하지 못했거나 id나 명령이 없는 `run` |
| `{"error": 메시지}` | 그 밖의 실패한 요청 |

닫힌 표면의 세션과 그 `run` 명령은 프로세스 그룹째 종료한다. 프로세스가 모두 끝났거나 끝나는 중인 그룹은(macOS가 `EPERM`으로 답한다. 세션의 표준 입력을 닫으면 셸이 끝난다) 이미 종료된 것이고, 그 밖의 실패는 남은 프로세스를 적은 오류다. 표준 입력이 닫히면 모든 세션을 종료하고 끝난다. Windows에서는 모든 동작이 `shell sessions are not implemented on windows`로 실패한다.

사이드카와 그 헬퍼의 진단 용도 공개 심볼은 모두 `sp_diag_`로 시작한다. 릴리스 산출물 검사는 이 표지를 사용해 진단 코드를 담은 바이너리를 거부한다. 사이드카가 릴리스 빌드에 진단 심볼을 포함하면 검사가 심볼 이름을 가리키는 오류로 실패한다.

## files

`@soksak/sidecar-files`(repository `../sidecars/files`)는 `make build`로 `build/soksak-files`를 빌드하고 세션의 `root` 안의 디렉터리를 나열하고 감시한다. 코드는 `src/`에 있다: 진입점 `src/main.go`, 패키지 `src/files`의 프로토콜, `src/platform/platform.go`를 통해 등록되는 `src/platform/{darwin,linux,windows}/`의 디렉터리 감시. macOS는 디렉터리에 kqueue `EVFILT_VNODE` 필터를 걸어 감시하고, Linux와 Windows는 `watching directories is not implemented on <os>`를 반환한다. 세션은 감시하는 경로만 상태로 갖는다. 사이드카는 사이드카 출력 줄 한도와 같은 67108864 byte까지의 요청 줄을 읽고, 답을 HTML escape 없이 쓴다. JSON이 최대 여섯 배로 escape한 8 MiB 텍스트는 그 한도 안에 있다.

| 요청 본문 | 답 본문 |
| --- | --- |
| `{operation: "list", id, path}` | `{id, entries: [{name, directory}]}`: `root/path`의 항목. 디렉터리가 먼저 오고 각 묶음은 이름순이다. `path`는 `root` 기준 상대 경로이며 `""`는 `root` 자신이다 |
| `{operation: "watch", id, paths}` | `{id}`: 세션이 감시하는 경로를 `paths`(`root` 기준 상대 경로, `list`와 같이 검사)로 바꾼다. 빈 목록은 감시를 멈춘다. 그 뒤 감시하는 디렉터리의 항목이 생기거나 지워지거나 이름이 바뀔 때와, 감시하는 일반 파일의 내용이 쓰이거나 늘어날 때(파일의 kqueue `NOTE_WRITE`나 `NOTE_EXTEND`) 사이드카는 `id` 없이 `{changed: path}`를 보낸다 | |
| `{operation: "git", id}` | `{id, entries: [{path, status}]}`: `root`에서 `git status --porcelain=v1 -z --untracked-files=all`을 실행하고 각 항목을 `added`, `deleted`, `modified`, `renamed`, `untracked` 중 하나와 저장소 최상위 기준 경로를 `root` 기준으로 바꾼 경로로 옮긴다. `root` 밖의 항목은 뺀다. `root`가 git 저장소 안에 있지 않거나 git이 설치되지 않았으면 `entries`는 비어 있고, 다른 git 실패는 오류다 |
| `{operation: "read", id, path}` | `{id, text, version, newline, bom}`: 일반 파일 `root/path`의 내용을 텍스트로 돌려준다. `version`은 파일 byte의 소문자 16진수 SHA-256이고, `newline`은 `lf`, `crlf`, `cr`, `mixed`, `none`(줄바꿈 없음) 중 하나이며, `bom`은 파일이 UTF-8 byte order mark로 시작하면 `true`이고 `text`는 그것을 담지 않는다. 올바른 UTF-8이 아닌 파일은 `not UTF-8 text: <path>`로, 8388608 byte를 넘는 파일은 내용을 읽기 전에 `file is <n> bytes, above the 8388608-byte limit: <path>`로, 일반 파일이 아닌 경로는 `not a regular file: <path>`로 실패한다 |
| `{operation: "write", id, path, text, expect, bom}` | `{id, version}`: `bom`이 `true`면 UTF-8 byte order mark 뒤에 `text`를 `root/path`에 제자리로 쓰고, 쓴 byte의 SHA-256을 돌려준다. `expect`가 version이면 사이드카는 기존 일반 파일을 자르지 않고 쓰기로 열어 같은 descriptor로 읽고, 그 SHA-256이 `expect`와 다르면 쓰지 않고 `changed on disk: <path>`로 실패한다. 같으면 처음부터 전체 내용을 쓰고, 파일을 그 길이로 자르고, 디스크에 동기화한다. 제자리 쓰기는 파일의 inode, mode, 확장 속성, 접근 제어 목록, hard link, symbolic link의 대상을 유지한다. 첫 byte를 쓴 뒤의 실패는 `write incomplete: <path>: <error>`로 실패하며 그때 파일은 내용의 일부를 담을 수 있다. `expect`가 `null`이면 사이드카는 process umask로 가린 mode 0666의 새 파일을 만들고, 경로가 있으면 `exists: <path>`로 실패한다. 8388608 byte를 넘는 `text`는 큰 `read`와 같이 실패한다 |
| `closed` | 세션의 감시를 멈춘다. 답하지 않는다 |
| 모든 실패 | `{id, error}`: `root`가 없거나, `path`가 절대 경로이거나 (심볼릭 링크를 따라간 뒤) `root`를 벗어나거나, 디렉터리를 읽을 수 없는 경우 |

## 터미널 사이드카 (vt-core)

터미널 사이드카(`@soksak/sidecar-vt-core`)는 [터미널 런타임](terminal-runtime.ko.md)이 정의한 영속 서비스의 클라이언트 모듈이다. 서비스는 애플리케이션 설정 디렉터리마다 하나의 프로세스로 실행되며 독립 PTY·셸 프로세스·VT 상태·스크롤백·IOSurface 렌더링을 소유한다. 사이드카는 터미널 세션 제어 요청을 받고 영역에 화면 그림을 공급한다.

| 요청 | 본문 | 의미 |
| --- | --- | --- |
| `open` | `{image?: 이름}` | 영속 서비스에서 터미널 세션을 만들거나 연결하고 호스트의 그림 `configure`를 받은 뒤 영역용 그림을 할당하고 그린다. 같은 생성 식별자에 대한 `open` 호출이 여러 번이면 아무것도 하지 않는다. |
| `input` | `{bytes?: base64-문자열 \| keys?: [{key: 이름, text?: 문자열, shift: bool, alt: bool, ctrl: bool}]}` | 터미널에 입력을 보낸다. 바이트는 base64 인코딩된 원시 터미널 입력이다. 키는 모드에 따라 터미널 수열로 디코드된다: 기능 키는 escape 수열로 매핑되고, 텍스트 입력은 UTF-8로 보내지고, 조합 키는 적절히 처리된다. `bytes`와 `keys` 모두 한 요청에 있을 수 있다. |
| `theme` | `{mode: "dark" \| "light", background, foreground, cursor, selection}` | 연결된 이미지 표면에 유효한 애플리케이션 외관을 적용한다. 네 색은 모두 필요한 `#rrggbb` 문자열이며 기본 배경과 전경, 커서 색, 선택 배경을 정한다. `mode`는 인덱스 ANSI 팔레트를 고른다. 세션과 셀 메트릭은 바꾸지 않는다. 다른 모드, 빠진 색, 다른 형식의 색은 `invalidParams`를 돌려주고 아무것도 바꾸지 않는다. 답은 적용한 배경을 담은 `{ack: true, event: "theme", mode, background}`다. |
| `cursor` | `{shape, blink, interval, idleTimeout, unfocused}` | 터미널 커서 정책을 적용한다. `shape`는 `block`·`underline`·`beam`, `blink`는 `Never`·`Off`·`On`·`Always`, `interval`은 양의 밀리초 정수, `idleTimeout`은 0 이상 밀리초 정수, `unfocused`는 `hollow`·`solid`·`underline`·`beam`·`unchanged`다. 잘못된 값은 `invalidParams`로 명시적으로 실패하며 대체하지 않는다. |
| `font` | `{family: string, size: number}` | `;`로 이은 우선순위 family 목록에서 터미널 글꼴을 선택하고 크기를 포인트(4–128, [글자 크기](text-size.ko.md)가 13 × 실제 배율로 정함)로 정한다. 서비스는 설치된 첫 family를 적용하며, 설치되어 있지 않은 family는 건너뛰고 로그에 남길 뿐 오류로 보고하지 않는다. 목록의 family가 하나도 설치되어 있지 않으면 시스템 고정폭 글꼴을 쓰고 그 사실을 로그에 남긴다. family가 하나도 없는 목록은 `{error: "invalidParams", reason, operation: "font"}`로 거부한다. 글꼴을 선택하면 셀 메트릭, 터미널 열과 행, 세션 크기, 표시 raster를 다시 계산하고, 적용한 family와 시스템 고정폭 글꼴 여부, 건너뛴 family, 크기를 담은 `{ack: true, event: "font", family, system, skipped, size}`로 답한다. 크기가 없거나 범위를 벗어나면 빈 family 목록처럼 거부한다. 첫 `font` 요청 전에는 13포인트 시스템 고정폭 글꼴을 쓴다. 앱은 글꼴을 포함하지 않으며, 터미널 페이지는 적용한 family를 `terminal.session`의 `font`와 `fontSystem`으로 보고한다. |
| `screen.read` | `{}` | 현재 화면 상태를 요청한다. 사이드카가 `{event: "screen", cols, rows, cursor: {col, row, shape, visible, blinking, blinkVisible, focused}, lines: [[cell, ...]]}`로 응답한다. 각 셀은 `{ch?: 문자열, width: 수, fg?: 색상, bg?: 색상, bold: bool, italic: bool, underline: bool, inverse: bool}`을 가진다. <!-- cell size: pending code --> |
| `close` | `{}` | 터미널 세션을 종료하고 PTY를 종료한다. 호스트의 `{closed: true}` 봉투도 같은 close 동작을 사용하므로 표면을 제거해 PTY 세션을 남길 수 없다. 서비스는 세션의 프로세스 그룹을 끝낸다. 프로세스가 모두 끝났거나 끝나는 중인 그룹은(macOS가 `EPERM`으로 답한다. 읽히지 않은 출력을 남긴 셸은 터미널 출력이 비워진 뒤에야 끝난다) 이미 닫힌 것이고, 그 밖의 실패는 그룹과 남은 프로세스를 적은 오류다. |

사이드카는 터미널 화면이 바뀔 때마다 `{event: "screen", ...}`을 보내고, 새 프레임이 그려질 때마다 호스트의 그림 릴레이를 통해 그림 봉투를 보낸다. 호스트 `configure`가 페이지 주도 `resize` 요청을 대체하며 최신 래스터 리비전으로 합쳐진다. 전송 그림이 `consumed`나 오류를 기다리는 동안 사이드카는 그 그림을 수정하지 않는다. 화면과 설정 변경은 대기 상태로 남고, 응답 뒤 다음 프레임이 최신 설정을 사용한다.

## 테스트

각 사이드카는 자기 디렉터리에서 테스트를 실행한다. `shell`은 `go test ./...`로 프로토콜, 출력 순서, 디렉터리 보고, 명령 입력, `run` 결과, 중단을, `node --test tests/`로 `sidecar.json`을 검사한다. `files`는 `go test ./...`로 나열, 정렬, 감시, git 상태, `root` 밖 경로의 거부를 검사하고 같은 방법으로 `sidecar.json`을 검사한다. 각 호스트는 `tests/sidecars_test.*`에서 fake 사이드카 실행 파일로 전달, 메시지 한도, 실패 전달과 스테이징된 선언 파일을 통한 해석을 검사하고 실제 사이드카를 실행하지 않는다.
