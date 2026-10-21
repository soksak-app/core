# 분리 인계

[English](decouple-handoff.md)

이 문서는 plugin이나 sidecar의 구현을 설명하기 때문에 core에서 지우는 글을 담는다. 상위 작업이 각 절을 그것을 소유한 repository에 전달하며, 그 repository가 담으면 core에서 절을 지운다. 모든 절을 전달한 뒤 이 문서를 지운다.

## 사이드카 구현 절(F236-8)

아래 세 절은 [사이드카](../spec/sidecars.ko.md)에 있었다. 각 절은 자기 sidecar repository(`../sidecars/shell`, `../sidecars/files`, `../sidecars/vt`)의 명세로 옮긴다. 소유 repository가 자기 경로로 바꾸기 전까지 링크는 core 명세를 가리킨다.

### shell

`@soksak/sidecar-shell`(repository `../sidecars/shell`)은 `make build`로 `build/soksak-shell`을 빌드하고, 표면마다 셸 세션 하나를 실행한다. `open`은 세션이 시작할 디렉터리로, 있는 디렉터리의 절대 경로인 `directory`를 가질 수 있고, 다른 값은 명시적 오류다. 없으면 세션은 표면의 프로젝트 디렉터리(`root`)에서 시작한다. 셸 페이지는 표면의 `origin.directory`가 `null`이 아니면 그것을 보내고 디렉터리 이벤트마다 `tab.directory`로 알리므로([탭 알림](../spec/plugins.ko.md#탭-알림)), 셸에서 쪼갠 셸은 그 셸이 있던 곳에서 시작한다. 터미널 에뮬레이터가 아닌 줄 단위 콘솔이다. 코드는 `src/`에 있다: 진입점 `src/main.go`, 패키지 `src/shell`의 프로토콜, `src/platform/platform.go`를 통해 등록되는 `src/platform/{darwin,linux,windows}/`의 운영체제별 동작([플랫폼 선택](../spec/hosts.ko.md#플랫폼-선택)). 테스트는 `tests/`에 있다.

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

### files

`@soksak/sidecar-files`(repository `../sidecars/files`)는 `make build`로 `build/soksak-files`를 빌드하고 세션의 `root` 안의 디렉터리를 나열하고 감시한다. 코드는 `src/`에 있다: 진입점 `src/main.go`, 패키지 `src/files`의 프로토콜, `src/platform/platform.go`를 통해 등록되는 `src/platform/{darwin,linux,windows}/`의 디렉터리 감시. macOS는 디렉터리나 일반 파일에 kqueue `EVFILT_VNODE` 필터를 걸어 감시하고, Linux는 디렉터리를 inotify로 감시하며 일반 파일은 `watching files is not implemented on linux`로 실패하고, Windows는 `watching directories is not implemented on windows`로 실패한다. 세션은 감시하는 경로만 상태로 갖는다. 사이드카는 사이드카 출력 줄 한도와 같은 67108864 byte까지의 요청 줄을 읽고, 답을 HTML escape 없이 쓴다. JSON이 최대 여섯 배로 escape한 8 MiB 텍스트와 32 MiB bytes의 base64는 그 한도 안에 있다.

| 요청 본문 | 답 본문 |
| --- | --- |
| `{operation: "list", id, path}` | `{id, entries: [{name, directory}]}`: `root/path`의 항목. 디렉터리가 먼저 오고 각 묶음은 이름순이다. `path`는 `root` 기준 상대 경로이며 `""`는 `root` 자신이다 |
| `{operation: "watch", id, paths}` | `{id}`: 세션이 감시하는 경로를 `paths`(`root` 기준 상대 경로, `list`와 같이 검사)로 바꾼다. 빈 목록은 감시를 멈춘다. 그 뒤 감시하는 디렉터리의 항목이 생기거나 지워지거나 이름이 바뀔 때와, 감시하는 일반 파일의 내용이 쓰이거나 늘어날 때(파일의 kqueue `NOTE_WRITE`나 `NOTE_EXTEND`) 사이드카는 `id` 없이 `{changed: path}`를 보낸다 | |
| `{operation: "git", id}` | `{id, entries: [{path, status}]}`: `root`에서 `git status --porcelain=v1 -z --untracked-files=all`을 실행하고 각 항목을 `added`, `deleted`, `modified`, `renamed`, `untracked` 중 하나와 저장소 최상위 기준 경로를 `root` 기준으로 바꾼 경로로 옮긴다. `root` 밖의 항목은 뺀다. `root`가 git 저장소 안에 있지 않거나 git이 설치되지 않았으면 `entries`는 비어 있고, 다른 git 실패는 오류다 |
| `{operation: "read", id, path}` | `{id, text, version, newline, bom}`: 일반 파일 `root/path`의 내용을 텍스트로 돌려준다. `version`은 파일 byte의 소문자 16진수 SHA-256이고, `newline`은 `lf`, `crlf`, `cr`, `mixed`, `none`(줄바꿈 없음) 중 하나이며, `bom`은 파일이 UTF-8 byte order mark로 시작하면 `true`이고 `text`는 그것을 담지 않는다. 올바른 UTF-8이 아닌 파일은 `not UTF-8 text: <path>`로, 8388608 byte를 넘는 파일은 내용을 읽기 전에 `file is <n> bytes, above the 8388608-byte limit: <path>`로, 일반 파일이 아닌 경로는 `not a regular file: <path>`로 실패한다 |
| `{operation: "write", id, path, text, expect, bom}` | `{id, version}`: `bom`이 `true`면 UTF-8 byte order mark 뒤에 `text`를 `root/path`에 제자리로 쓰고, 쓴 byte의 SHA-256을 돌려준다. `expect`가 version이면 사이드카는 기존 일반 파일을 자르지 않고 쓰기로 열어 같은 descriptor로 읽고, 그 SHA-256이 `expect`와 다르면 쓰지 않고 `changed on disk: <path>`로 실패한다. 같으면 처음부터 전체 내용을 쓰고, 파일을 그 길이로 자르고, 디스크에 동기화한다. 제자리 쓰기는 파일의 inode, mode, 확장 속성, 접근 제어 목록, hard link, symbolic link의 대상을 유지한다. 첫 byte를 쓴 뒤의 실패는 `write incomplete: <path>: <error>`로 실패하며 그때 파일은 내용의 일부를 담을 수 있다. `expect`가 `null`이면 사이드카는 process umask로 가린 mode 0666의 새 파일을 만들고, 경로가 있으면 `exists: <path>`로 실패한다. 8388608 byte를 넘는 `text`는 큰 `read`와 같이 실패한다 |
| `{operation: "readBytes", id, path}` | `{id, data, version}`: 정규 파일 `root/path`의 bytes를 padding이 있는 표준 base64로 `data`에, 그 SHA-256을 `version`에 담는다. 33554432 bytes를 넘는 파일은 내용을 읽기 전에 `file is <n> bytes, above the 33554432-byte limit: <path>`로 실패하고, 정규 파일이 아닌 경로는 `not a regular file: <path>`로 실패한다 |
| `{operation: "writeBytes", id, path, data, expect}` | `{id, version}`: `data`가 padding이 있는 표준 base64로 담은 bytes를 `write`의 제자리, `expect`, 생성 규칙으로 `root/path`에 쓰고 그 SHA-256을 반환한다. 표준 base64가 아닌 `data`는 `writeBytes data is not base64`로 실패하고, 33554432 bytes를 넘는 decode한 bytes는 큰 `readBytes`처럼 실패한다 |
| `closed` | 세션의 감시를 멈춘다. 답하지 않는다 |
| 모든 실패 | `{id, error}`: `root`가 없거나, `path`가 절대 경로이거나 (심볼릭 링크를 따라간 뒤) `root`를 벗어나거나, 디렉터리를 읽을 수 없는 경우 |

### 터미널 사이드카 (vt-core)

터미널 사이드카(`@soksak/sidecar-vt-core`)는 [터미널 런타임](../spec/terminal-runtime.ko.md)이 정의한 영속 서비스의 클라이언트 모듈이다. 서비스는 애플리케이션 설정 디렉터리마다 하나의 프로세스로 실행되며 독립 PTY·셸 프로세스·VT 상태·스크롤백·IOSurface 렌더링을 소유한다. 사이드카는 터미널 세션 제어 요청을 받고 영역에 화면 그림을 공급한다.

| 요청 | 본문 | 의미 |
| --- | --- | --- |
| `open` | `{image?: 이름}` | 영속 서비스에서 터미널 세션을 만들거나 연결하고 호스트의 그림 `configure`를 받은 뒤 영역용 그림을 할당하고 그린다. 같은 생성 식별자에 대한 `open` 호출이 여러 번이면 아무것도 하지 않는다. |
| `input` | `{bytes?: base64-문자열 \| keys?: [{key: 이름, text?: 문자열, shift: bool, alt: bool, ctrl: bool}]}` | 터미널에 입력을 보낸다. 바이트는 base64 인코딩된 원시 터미널 입력이다. 키는 모드에 따라 터미널 수열로 디코드된다: 기능 키는 escape 수열로 매핑되고, 텍스트 입력은 UTF-8로 보내지고, 조합 키는 적절히 처리된다. `bytes`와 `keys` 모두 한 요청에 있을 수 있다. |
| `theme` | `{mode: "dark" \| "light", background, foreground, cursor, selection}` | 연결된 이미지 표면에 유효한 애플리케이션 외관을 적용한다. 네 색은 모두 필요한 `#rrggbb` 문자열이며 기본 배경과 전경, 커서 색, 선택 배경을 정한다. `mode`는 인덱스 ANSI 팔레트를 고른다. 세션과 셀 메트릭은 바꾸지 않는다. 다른 모드, 빠진 색, 다른 형식의 색은 `invalidParams`를 돌려주고 아무것도 바꾸지 않는다. 답은 적용한 배경을 담은 `{ack: true, event: "theme", mode, background}`다. |
| `cursor` | `{shape, blink, interval, idleTimeout, unfocused}` | 터미널 커서 정책을 적용한다. `shape`는 `block`·`underline`·`beam`, `blink`는 `Never`·`Off`·`On`·`Always`, `interval`은 양의 밀리초 정수, `idleTimeout`은 0 이상 밀리초 정수, `unfocused`는 `hollow`·`solid`·`underline`·`beam`·`unchanged`다. 잘못된 값은 `invalidParams`로 명시적으로 실패하며 대체하지 않는다. |
| `font` | `{family: string, size: number}` | `;`로 이은 우선순위 family 목록에서 터미널 글꼴을 선택하고 크기를 포인트(4–128, [글자 크기](../spec/text-size.ko.md)가 13 × 실제 배율로 정함)로 정한다. 서비스는 설치된 첫 family를 적용하며, 설치되어 있지 않은 family는 건너뛰고 로그에 남길 뿐 오류로 보고하지 않는다. 목록의 family가 하나도 설치되어 있지 않으면 시스템 고정폭 글꼴을 쓰고 그 사실을 로그에 남긴다. family가 하나도 없는 목록은 `{error: "invalidParams", reason, operation: "font"}`로 거부한다. 글꼴을 선택하면 셀 메트릭, 터미널 열과 행, 세션 크기, 표시 raster를 다시 계산하고, 적용한 family와 시스템 고정폭 글꼴 여부, 건너뛴 family, 크기를 담은 `{ack: true, event: "font", family, system, skipped, size}`로 답한다. 크기가 없거나 범위를 벗어나면 빈 family 목록처럼 거부한다. 첫 `font` 요청 전에는 13포인트 시스템 고정폭 글꼴을 쓴다. 앱은 글꼴을 포함하지 않으며, 터미널 페이지는 적용한 family를 `terminal.session`의 `font`와 `fontSystem`으로 보고한다. |
| `screen.read` | `{}` | 현재 화면 상태를 요청한다. 사이드카가 [터미널 런타임](../spec/terminal-runtime.ko.md#화면-메시지)에 정의된 `screen` 메시지로 응답한다. |
| `close` | `{}` | 터미널 세션을 종료하고 PTY를 종료한다. 호스트의 `{closed: true}` 봉투도 같은 close 동작을 사용하므로 표면을 제거해 PTY 세션을 남길 수 없다. 서비스는 세션의 프로세스 그룹을 끝낸다. 프로세스가 모두 끝났거나 끝나는 중인 그룹은(macOS가 `EPERM`으로 답한다. 읽히지 않은 출력을 남긴 셸은 터미널 출력이 비워진 뒤에야 끝난다) 이미 닫힌 것이고, 그 밖의 실패는 그룹과 남은 프로세스를 적은 오류다. |

사이드카는 터미널 화면이 바뀔 때마다 `{event: "screen", ...}`을 보내며, 그 `frame`은 그 화면을 보이는 frame의 `{generation, raster, sequence}`(보낸 frame의 답을 기다리는 동안 바뀐 것이 있으면 다음 frame)이거나 surface에 image가 없는 동안 null이다. 그리고 새 프레임이 그려질 때마다 호스트의 그림 릴레이를 통해 그림 봉투를 보낸다. 호스트 `configure`가 페이지 주도 `resize` 요청을 대체하며 최신 래스터 리비전으로 합쳐진다. 전송 그림이 `consumed`나 오류를 기다리는 동안 사이드카는 그 그림을 수정하지 않는다. 화면과 설정 변경은 대기 상태로 남고, 응답 뒤 다음 프레임이 최신 설정을 사용한다.
