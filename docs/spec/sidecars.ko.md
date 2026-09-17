# 사이드카

[English](sidecars.md)

사이드카는 셸 세션처럼 한 영역의 기능을 담은 네이티브 프로세스다. 플러그인은 네이티브 호스트를 통해 사이드카를 사용하고, 호스트는 메시지를 전달하되 본문을 해석하지 않는다. 사이드카 구현 하나를 Wails와 Tauri가 함께 사용한다.

## 선언과 시작

사이드카는 `sidecars/<name>`에 있고 `sidecar.json` 파일을 가진 패키지다. 사이드카 식별자는 패키지 이름이다(예: `@soksak/sidecar-shell`). [`validateSidecar`](../../packages/plugin-api/index.js)가 이 파일을 검사한다.

| 필드 | 의미 |
| --- | --- |
| `executable` | 빌드된 실행 파일의 패키지 안 경로 |
| `protocol` | 메시지 형식 버전. 현재 버전은 `1` |

플러그인은 페이지가 사용하는 사이드카 패키지 이름을 `plugin.json`에 나열하고 각각을 자기 `package.json`의 의존성으로 선언한다([플러그인](plugins.ko.md)). `soksak-stage --executables <디렉터리>`는 각 `sidecar.json`을 스테이징된 프런트엔드에, 빌드된 각 실행 파일을 `<디렉터리>`에 복사한다.

호스트는 스테이징된 프런트엔드만 읽어 사이드카를 찾는다.

1. `environment.json`이 플러그인 패키지를 나열한다.
2. `modules/<플러그인>/plugin.json`이 각 플러그인의 사이드카 패키지를 나열한다.
3. `modules/<사이드카>/sidecar.json`이 각 사이드카의 `executable` 경로와 `protocol`을 지정한다.

호스트는 `<애플리케이션 실행 파일 디렉터리>/<executable의 파일 이름>`을 실행한다. `sidecar.json`이 없거나, `executable`이 패키지 안의 경로가 아니거나, `protocol`이 `1`이 아니면 시작 시 실패한다. 페이지가 사이드카에 처음 요청을 보내면 사이드카를 시작한다. 어떤 플러그인도 선언하지 않은 사이드카에 대한 요청은 `sidecar <name> is not declared by any plugin`으로 실패하고, 호스트가 사이드카를 종료한 뒤의 요청도 실패한다.

## 메시지

메시지 하나는 한 줄의 JSON 객체다.

| 방향 | 메시지 |
| --- | --- |
| 호스트 → 사이드카 | 페이지 요청은 `{"surface": id, "root": 경로, "body": 값}`. `root`는 표면을 소유한 창의 프로젝트 디렉터리다 |
| 호스트 → 사이드카 | 표면이 제거되거나 그 창이 닫히면 `{"surface": id, "closed": true}` |
| 사이드카 → 호스트 | `{"surface": id, "body": 값}` |

호스트는 표면에 처음 요청을 보낸 창을 기록하고, 사이드카 메시지를 그 창에만 `sidecar-message` 이벤트 `{sidecar, surface, body}`로 전달한다. `sidecar`는 패키지 이름이다. 다른 창이 같은 표면에 보낸 요청은 실패한다. 애플리케이션이 종료되면 호스트는 각 사이드카의 표준 입력을 닫고 프로세스 종료를 기다린다.

## 페이지 인터페이스

`page.sidecar(name)`은 사이드카 패키지 이름을 받아 `send(surface, body)`와 `on(surface, fn)`을 반환한다. `on`은 구독 등록 후 완료되는 promise를 반환한다. 페이지는 첫 요청 전에 구독한다.

## shell

`sidecars/shell`(`@soksak/sidecar-shell`)은 `pnpm run build`로 `build/soksak-shell`을 빌드하고, 표면마다 셸 프로세스 하나를 표면의 프로젝트 디렉터리에서 실행한다. 셸은 `$SHELL`이며 설정되지 않았으면 `/bin/sh`(Windows는 `%COMSPEC%` 또는 `cmd.exe`)다. 대화형으로 실행하지 않는다.

| 본문 | 동작 |
| --- | --- |
| `{"op": "open"}` | 표면의 셸을 시작한다. 실행 중인 셸에 대한 요청은 아무것도 하지 않는다 |
| `{"op": "write", "data": 텍스트}` | 셸의 표준 입력에 `텍스트`를 기록한다 |

사이드카는 출력 줄마다 줄바꿈을 포함한 `{"text": 줄}`을, 실패한 요청마다 `{"error": 메시지}`를 보낸다. 닫힌 표면의 셸은 종료한다. 표준 입력이 닫히면 모든 셸을 종료하고 끝난다.

## 테스트

각 사이드카는 자기 디렉터리에서 테스트를 실행한다. `shell`은 `go test ./...`로 프로토콜을, Node 테스트로 `sidecar.json`을 검사한다. 각 호스트는 fake 사이드카 실행 파일로 전달과 스테이징된 선언 파일을 통한 해석을 검사하고 실제 사이드카를 실행하지 않는다.
