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
| `closed` | 세션의 감시를 멈춘다. [메시지](../spec/sidecars.ko.md#메시지)가 정하는 대로 `closed`에 답한다 |
| 모든 실패 | `{id, error}`: `root`가 없거나, `path`가 절대 경로이거나 (심볼릭 링크를 따라간 뒤) `root`를 벗어나거나, 디렉터리를 읽을 수 없는 경우 |

### 터미널 사이드카 (vt-core)

터미널 사이드카(`@soksak/sidecar-vt-core`)는 [영속 서비스](../spec/persistent-services.ko.md)이 정의한 영속 서비스의 클라이언트 모듈이다. 서비스는 애플리케이션 설정 디렉터리마다 하나의 프로세스로 실행되며 독립 PTY·셸 프로세스·VT 상태·스크롤백·IOSurface 렌더링을 소유한다. 사이드카는 터미널 세션 제어 요청을 받고 영역에 화면 그림을 공급한다.

| 요청 | 본문 | 의미 |
| --- | --- | --- |
| `open` | `{image?: 이름}` | 영속 서비스에서 터미널 세션을 만들거나 연결하고 호스트의 그림 `configure`를 받은 뒤 영역용 그림을 할당하고 그린다. 같은 생성 식별자에 대한 `open` 호출이 여러 번이면 아무것도 하지 않는다. |
| `input` | `{bytes?: base64-문자열 \| keys?: [{key: 이름, text?: 문자열, shift: bool, alt: bool, ctrl: bool}]}` | 터미널에 입력을 보낸다. 바이트는 base64 인코딩된 원시 터미널 입력이다. 키는 모드에 따라 터미널 수열로 디코드된다: 기능 키는 escape 수열로 매핑되고, 텍스트 입력은 UTF-8로 보내지고, 조합 키는 적절히 처리된다. `bytes`와 `keys` 모두 한 요청에 있을 수 있다. |
| `theme` | `{mode: "dark" \| "light", background, foreground, cursor, selection}` | 연결된 이미지 표면에 유효한 애플리케이션 외관을 적용한다. 네 색은 모두 필요한 `#rrggbb` 문자열이며 기본 배경과 전경, 커서 색, 선택 배경을 정한다. `mode`는 인덱스 ANSI 팔레트를 고른다. 세션과 셀 메트릭은 바꾸지 않는다. 다른 모드, 빠진 색, 다른 형식의 색은 `invalidParams`를 돌려주고 아무것도 바꾸지 않는다. 답은 적용한 배경을 담은 `{ack: true, event: "theme", mode, background}`다. |
| `cursor` | `{shape, blink, interval, idleTimeout, unfocused}` | 터미널 커서 정책을 적용한다. `shape`는 `block`·`underline`·`beam`, `blink`는 `Never`·`Off`·`On`·`Always`, `interval`은 양의 밀리초 정수, `idleTimeout`은 0 이상 밀리초 정수, `unfocused`는 `hollow`·`solid`·`underline`·`beam`·`unchanged`다. 잘못된 값은 `invalidParams`로 명시적으로 실패하며 대체하지 않는다. |
| `font` | `{family: string, size: number}` | `;`로 이은 우선순위 family 목록에서 터미널 글꼴을 선택하고 크기를 포인트(4–128, [글자 크기](../spec/text-size.ko.md)가 13 × 실제 배율로 정함)로 정한다. 서비스는 설치된 첫 family를 적용하며, 설치되어 있지 않은 family는 건너뛰고 로그에 남길 뿐 오류로 보고하지 않는다. 목록의 family가 하나도 설치되어 있지 않으면 시스템 고정폭 글꼴을 쓰고 그 사실을 로그에 남긴다. family가 하나도 없는 목록은 `{error: "invalidParams", reason, operation: "font"}`로 거부한다. 글꼴을 선택하면 셀 메트릭, 터미널 열과 행, 세션 크기, 표시 raster를 다시 계산하고, 적용한 family와 시스템 고정폭 글꼴 여부, 건너뛴 family, 크기를 담은 `{ack: true, event: "font", family, system, skipped, size}`로 답한다. 크기가 없거나 범위를 벗어나면 빈 family 목록처럼 거부한다. 첫 `font` 요청 전에는 13포인트 시스템 고정폭 글꼴을 쓴다. 앱은 글꼴을 포함하지 않으며, 터미널 페이지는 적용한 family를 `terminal.session`의 `font`와 `fontSystem`으로 보고한다. |
| `screen.read` | `{}` | 현재 화면 상태를 요청한다. 사이드카가 [영속 서비스](../spec/persistent-services.ko.md#화면-메시지)에 정의된 `screen` 메시지로 응답한다. |
| `close` | `{}` | 터미널 세션을 종료하고 PTY를 종료한다. 호스트의 `{closed: true}` 봉투도 같은 close 동작을 사용하므로 표면을 제거해 PTY 세션을 남길 수 없다. 서비스는 세션의 프로세스 그룹을 끝낸다. 프로세스가 모두 끝났거나 끝나는 중인 그룹은(macOS가 `EPERM`으로 답한다. 읽히지 않은 출력을 남긴 셸은 터미널 출력이 비워진 뒤에야 끝난다) 이미 닫힌 것이고, 그 밖의 실패는 그룹과 남은 프로세스를 적은 오류다. |

사이드카는 터미널 화면이 바뀔 때마다 `{event: "screen", ...}`을 보내며, 그 `frame`은 그 화면을 보이는 frame의 `{generation, raster, sequence}`(보낸 frame의 답을 기다리는 동안 바뀐 것이 있으면 다음 frame)이거나 surface에 image가 없는 동안 null이다. 그리고 새 프레임이 그려질 때마다 호스트의 그림 릴레이를 통해 그림 봉투를 보낸다. 호스트 `configure`가 페이지 주도 `resize` 요청을 대체하며 최신 래스터 리비전으로 합쳐진다. 전송 그림이 `consumed`나 오류를 기다리는 동안 사이드카는 그 그림을 수정하지 않는다. 화면과 설정 변경은 대기 상태로 남고, 응답 뒤 다음 프레임이 최신 설정을 사용한다.

## 터미널 plugin 인수 기준(F236-12)

터미널 plugin repository가 그림 영역의 이 두 기준을 자기 명세에 담고 자기 창 검사로 확인한다. core는 [표면 합성](../spec/surface-composition.ko.md#인수-기준)의 일반 기준을 유지한다.

- 터미널 그림은 리사이즈 중 논리 텍스트를 보존한다. 폭을 줄이면 열 수를 줄여 긴 논리 행을 여러 화면 행으로 재배치하고, 폭을 늘리면 열 수를 늘려 잘림이나 좁은 상태의 영구 고착 없이 다시 재배치한다.
- 터미널 셀 너비와 높이는 배치 중에도 고정된 표시 메트릭이다. 디바이더 이동은 표면·래스터 기하만 바꾸고 글꼴이나 셀 메트릭을 바꾸지 않으며, 네이티브 기하 변경은 애니메이션하지 않는다.

## 영속 터미널 서비스 본문 (F236-10)

아래 절은 영속 서비스 명세에 있던 터미널 전용 본문이다. 그 명세는 터미널 부분을 뺀 [영속 서비스](../spec/persistent-services.ko.md)로 core에 남는다. 각 절은 터미널 서비스 계약을 가진 터미널 plugin repository(`../sidecars/vt`)가 전달한다. 그 repository가 자기 경로로 바꾸기 전까지 링크는 core 명세를 가리킨다.

### 터미널 세션 시작

세션은 터미널 설정 `terminal.shell`이 가리키는 셸을 시작한다. 기본값 `login`은 계정의 사용자 데이터베이스 항목에 있는 로그인 셸이고, 그 밖의 값은 실행할 수 있는 파일의 절대 경로여야 한다. 셸은 로그인 셸로 시작한다. `argv[0]`은 `-`와 파일 이름이고 `SHELL`은 셸 경로다. 터미널 페이지는 이 값을 `open` 요청의 `shell`로 보내고, 워크벤치는 백그라운드 세션에 플러그인의 `background.settings`를 통해 보낸다. 값이 없거나, 상대 경로이거나, 파일이 없거나 실행할 수 없거나, 계정에 로그인 셸이 없으면 명시적 오류이며 다른 셸을 대신 시작하지 않는다. 설정을 바꾸면 그 뒤에 여는 세션에 적용된다.

터미널의 문자 인코딩은 UTF-8이다. Shell은 terminal service의 환경을 받는다. 그 환경에서 `LANG`, `LC_ALL`, `LC_CTYPE`이 모두 없거나 비어 있으면, service는 현재 macOS locale의 언어 코드와 지역 코드로 `LANG`을 `<language>_<region>.UTF-8`로 정한다. 그 locale이 설치되어 있지 않거나 macOS locale에 언어 코드나 지역 코드가 없으면, service는 대신 `LC_CTYPE=UTF-8`을 정하고 service log에 `terminal: locale <name> is not installed; LC_CTYPE=UTF-8`을 쓴다. 비어 있지 않은 `LANG`, `LC_ALL`, `LC_CTYPE`은 바꾸지 않는다. Finder나 Dock에서 시작한 애플리케이션은 세 변수를 하나도 받지 않으므로, 이 규칙이 없으면 shell은 C locale로 실행되어 비 ASCII 문자의 byte를 각각 다른 문자로 세고 escape sequence로 보인다. 실행 중인 terminal service는 세션이 모두 끝날 때까지 시작할 때의 환경과 실행 파일을 유지한다.

`open` 요청은 셸이 시작할 디렉터리로, 있는 디렉터리의 절대 경로인 `directory`를 가질 수 있다. 다른 값은 명시적 오류이며 다른 디렉터리를 대신 쓰지 않는다. 없으면 셸은 계정의 홈 디렉터리에서 시작한다. 터미널 페이지는 표면의 `origin.directory`([탭 알림](../spec/plugins.ko.md#탭-알림))가 `null`이 아니면 그것을 보내므로, 터미널에서 쪼갠 터미널은 그 터미널이 마지막으로 알린 디렉터리에서 시작한다. 그렇지 않으면 표면 컨텍스트의 `project.root`를 보내므로 프로젝트의 새 터미널은 프로젝트 루트에서 시작한다. 프로젝트가 없는 창에서는 `directory`를 보내지 않는다.

사이드카는 zsh와 bash를 OSC 133 표시를 보내는 셸 통합과 함께 시작하며, 사용자의 파일은 바꾸지 않는다. 통합 스크립트는 사이드카에 포함되어 있고, 세션을 시작하기 전에 `<임시 디렉터리>/soksak-shell-<내용 해시>/`(모드 0700)에 기록된다. zsh에는 `ZDOTDIR`를 그 디렉터리로 지정하고 기존 `ZDOTDIR`는 `SOKSAK_ZSH_ZDOTDIR`에 보관한다. 그 디렉터리의 `.zshenv`는 원래 `ZDOTDIR`를 되돌리고, 사용자의 `.zshenv`를 읽고, 대화형 셸이면 훅을 설치한다. zsh는 나머지 시작 파일을 되돌린 디렉터리에서 읽는다. bash에는 스크립트 경로를 담은 `SOKSAK_BASH_INTEGRATION`과, 첫 항목이 현재 `DEBUG` 트랩을 기록한 뒤 그 스크립트를 읽는 `PROMPT_COMMAND`를 내보낸다. bash 3.2에서 `source`로 읽는 파일은 `DEBUG` 트랩을 보지 못하기 때문이다. 시작 파일이 `;`로 앞이나 뒤에 항목을 더할 수 있도록 항목 뒤에 구분자를 두지 않는다. 셸은 시작 파일을 그대로 읽고, 첫 프롬프트에서 스크립트가 `PROMPT_COMMAND`에서 자기 항목을 지우고(다른 항목 사이의 항목은 `:`가 된다), 두 변수의 내보내기를 멈추고, 사용자 항목의 앞과 뒤에 자기 훅을 둔다. bash 3.2는 `sh`로 실행될 때만 `ENV`를 읽고 셸은 `argv[0]`이 `-bash`인 로그인 셸이어야 하므로, 사이드카는 bash를 `ENV`와 POSIX 모드로 시작하지 않는다. 사용자의 시작 파일이 `PROMPT_COMMAND`를 바꿔 쓰면 스크립트는 실행되지 않고, 세션은 통합이 없는 셸처럼 동작한다. 다른 셸은 통합 없이 시작한다.

훅은 각 프롬프트 전에 `133;A`(readline은 프롬프트의 마지막 줄만 다시 그리므로 bash는 `133;A;redraw=last`), 명령 실행 전에 `133;C`, 다음 프롬프트 전에 `133;D;<상태>`를 보낸다. 각 프롬프트 전에는 작업 디렉터리도 `7;file://<호스트 이름><경로>`로 알리며, 경로는 예약되지 않은 문자와 `/` 밖의 문자를 퍼센트 인코딩한다. zsh는 `preexec` 훅에서 `C`를 보낸다. bash 3.2에는 그런 훅이 없으므로 `DEBUG` 트랩이 프롬프트 뒤 첫 명령에서 `C`를 보낸다. 빈 입력 행은 명령 없이 `PROMPT_COMMAND`를 실행하므로, `PROMPT_COMMAND`의 첫 항목이 대기를 취소한다. 스크립트가 자신을 설치하는 프롬프트에서는 자기 항목 뒤의 항목이 트랩이 생긴 뒤에 실행되므로, 그 프롬프트에서 그 항목들 중 하나와 텍스트가 같은 명령은 알리지 않는다. 트랩은 `$_`를 마지막 인수로 넘겨 다음 명령의 `$_`를 유지한다. 시작 파일이 `DEBUG` 트랩을 설정했으면, `C` 없는 `A`는 크기 변경 때 명령 출력을 지우므로 스크립트는 그 트랩을 바꾸지 않고 표시도 보내지 않는다.

### 터미널 서비스 구현

앱 설정 디렉터리마다 영속 터미널 서비스 하나가 PTY, VT 상태, 스크롤백, 렌더링을 소유한다. PTY 관리, 에뮬레이션, 렌더링, 클라이언트 전송은 같은 프로세스의 별도 모듈이며 별도 실행 파일이 아니다. 독립 세션은 각각 PTY 장치와 셸 프로세스를 소유한다. PTY 장치는 프로세스가 아니다. 독립 터미널 3개는 앱 호스트 외에 서비스 하나와 셸 3개를 요구한다. WebKit 프로세스와 셸이 실행한 프로그램은 별도로 센다.

서비스는 엔드포인트를 게시하기 전에 기본 터미널 글꼴을 읽으므로, 서비스 프로세스의 첫 CoreText 호출은 그 프로세스의 첫 터미널만 늦춘다. 이 비용은 서비스 프로세스마다 한 번 생기고 서비스가 앱 재시작보다 오래 살아 있으므로 받아들인다.

터미널 사이드카는 종료 사유를 `sidecar.vt.session_stop` 이벤트에 `folder-removed`, `endpoint-removed`, `endpoint-replaced` 중 하나로 기록한다.

터미널 페이지는 이것을 재연결 신호로 삼는다 — 남은 사이드카 오류를 해소하고, 세션 문을 닫아 입력이 다시 대기열에 쌓이게 하고, 세션 부트스트랩을 다시 실행한다(보존 세션에서 `open` 은 아무 일도 하지 않고, 재스폰된 서비스에서는 새 세션을 연다). 이어 마지막 테마, 선언된 글꼴, 커서 정책을 다시 보낸다.

### 터미널 입력과 표시

터미널을 한 번 클릭하면 선언된 `terminal.focus` 명령을 통해 네이티브 그림 영역으로 키보드 소유권을 옮긴다. 네이티브 터미널 입력 뒤 다음 합성 포인터를 전달하기 전에 host가 대상 문서 웹뷰를 응답자로 복원하므로 네이티브 그림 응답자가 다음 클릭을 가로막지 않는다. DOM 앵커는 포인터의 기본 DOM 포커스 동작을 막아 같은 클릭 중 WebKit이 소유권을 되찾지 않게 한다. 카드 선택은 여전히 이벤트를 받는다. 두 번째 클릭, 지연 재포커스, 테스트 전용 포커스 명령은 필요하지 않다. 포커스 요청 오류는 관측 가능해야 한다. 모달 포커스 복원과 그림 포커스 통지는 현재 AppKit/Tauri 콜백이 끝난 뒤로 미뤄야 하며 WebView 이벤트 경로에 동기 재진입해서는 안 된다.

엔진, PTY, 표시 래스터는 적용된 크기가 같아야 한다. 폭을 좁히면 기본 화면의 자동 줄바꿈 행을 재배치하고, 넓히면 같은 논리적 행을 합친다. 폭을 좁히는 재배치로 늘어난 행은 먼저 커서 아래의 빈 행을 차지한다. 위의 행은 화면에 남고 들어맞지 않는 행만 기록으로 옮기므로, 이후 행 수가 늘어도 그 행이 프롬프트 위로 돌아오지 않는다. 명시적 개행은 유지한다. 대체 화면 앱은 터미널 제어 배치 의미를 유지한다. 디바이더 이동은 글꼴 메트릭을 바꾸거나 래스터 기하를 애니메이션하지 않는다. 셀 하나의 공간도 없는 래스터는 잘못된 요청이 아니라 합성 과도 상태다. 사이드카는 현재 격자를 유지하고 래스터를 받아 프레임을 표시한다 — 그리기는 래스터 경계로 잘려 들어가므로 셀보다 작은 래스터에는 들어맞는 만큼만 보인다 — 그리고 PTY 는 크기를 유지하므로 자식은 창 변화를 보지 않는다. 래스터에 셀 하나의 공간이 없는 동안 연 표면은 셀이 들어맞는 래스터가 올 때까지 닫혀 있고, 둘 다 오류로 보고하지 않는다.

엔진은 OSC 133 표시로 셸 상태를 유지한다. `A`와 `B`는 표시의 `redraw` 매개변수(없으면 `1`, 또는 `0`, `last`; 다른 값은 거부한다)와 함께 프롬프트 상태를 정하고, `C`와 `D`는 출력 상태를 정한다. `A`는 커서가 0열에 있지 않으면 먼저 커서를 다음 행의 시작으로 옮기고, 그 행을 프롬프트 시작으로 기록한다. 셸은 새 표시 없이 맨 위 행에서 프롬프트를 다시 그리므로, 프롬프트 상태의 ED 2는 프롬프트 시작을 맨 위 행으로 옮긴다. 다시 그리는 영역은 `redraw=1`이면 프롬프트 시작에서, `redraw=last`이면 커서가 있는 논리적 행의 첫 행에서 시작한다. 프롬프트 상태에서 `redraw`가 `0`이 아닐 때 기본 화면의 크기가 바뀌면, 엔진은 재배치하고, 다시 그리는 영역의 첫 행부터 화면 끝까지의 행을 지우고, 재배치 전에 커서가 그 첫 행에서 떨어져 있던 행 수만큼 그 첫 행 아래에 있는 행의 0열로 커서를 옮긴다. 그 행이 화면 아래를 넘으면 화면을 위로 올린다. 재배치는 논리적 행을 유지하므로, 엔진은 그 첫 행과 커서 사이의 논리적 행 수로 첫 행을 다시 찾는다. zsh는 `SIGWINCH` 뒤 프롬프트 전체를, bash(readline)는 프롬프트의 마지막 줄을 다시 그린다. 둘 다 마지막으로 그린 폭에서의 커서 행 수만큼 올라가므로 영역의 첫 행에서 다시 시작하고, 지운 행에는 이전 폭의 행이 남지 않는다. 그래서 두 줄 프롬프트나 마지막 행을 채운 프롬프트처럼 자기 줄을 끝내는 프롬프트도 그 위의 출력을 유지한다. 기록이 가장 오래된 행을 버린 뒤에도 프롬프트 시작은 맞다. 프롬프트 시작이 가장 오래된 기록 행과 커서 사이에 더 이상 없으면 엔진은 오류를 보고하고 아무것도 지우지 않는다. 셸이 다시 그리기 전에 크기가 다시 바뀌면 셸은 더 이상 현재가 아닌 폭으로 그릴 수 있다. 이때 프롬프트 위의 행을 덮어쓸 수 있다. 현재 크기와 같은 크기로의 변경은 PTY가 `SIGWINCH`를 보내지 않으므로 아무것도 바꾸지 않는다. 통합이 없는 셸은 표시를 보내지 않으며, 크기 변경 뒤 셸 자신의 다시 그리기가 이전 폭의 행을 남길 수 있다.

화면 지우기 2(`ESC[2J`)는 현재 배경색으로 화면의 모든 칸을 지우고 기록과 커서를 그대로 둔다. 그래서 기록(`ESC[3J`)을 지운 뒤 화면을 지우는 `clear` 뒤에는 되돌려 볼 기록도 스크롤바도 없다. 화면 지우기 1(`ESC[1J`)은 커서 위의 모든 행과 커서 행의 처음부터 커서 칸까지 지운다. 엔진의 격자 라이브러리는 `ESC[2J`에서 보이는 행을 기록으로 올리고, 커서가 둘째 행이면 `ESC[1J`에서 첫 행을 남기므로, 엔진은 두 시퀀스를 라이브러리에 넘기지 않고 출력 안의 그 위치에서 직접 적용한다.

사이드카는 래스터를 그리는 것과 페이지의 `screen` 이벤트를 함께 보내며, 호스트가 앞 래스터에 `consumed`로 답한 뒤에만 그렇게 한다. 호스트가 래스터를 가진 동안 화면을 바꾸는 출력, 스크롤, 입력은 그리거나 보내지 않고 변경만 표시한다. 호스트가 답하면 사이드카는 현재 화면을 한 번 그리고 그 `screen` 이벤트 하나를 보낸다. 따라서 출력이 몰리면 출력 조각마다가 아니라 호스트의 답마다 래스터 하나와 `screen` 이벤트 하나가 생긴다. 그래서 페이지가 출력보다 뒤처지지 않는다. `screen` 이벤트의 멤버는 [화면 메시지](../spec/persistent-services.ko.md#화면-메시지)에서 정의한다.

터미널 래스터는 유효한 애플리케이션 외관을 따른다. 표면 페이지는 시작할 때와 애플리케이션 테마나 모드가 바뀔 때마다 `mode`(`dark` 또는 `light`)와 페이지가 받은 테마 토큰에서 가져온 네 색을 담은 `theme`를 터미널 사이드카에 보낸다. `background`는 `--card`, `foreground`와 `cursor`는 `--fg`로 터미널이 채우는 카드의 색이어서 터미널이 애플리케이션의 다른 표면처럼 카드의 일부로 보이고, `selection`은 테마 강조 레일인 `--rail`이다. 따라서 선택한 텍스트는 카드와 테두리에서 분명히 구분된다. 테마에는 따로 된 표면 색이 없다. 셸 페이지, 터미널, 네이티브 표면이 그리기 전에 보이는 대신 그림이 모두 `--card`와 `--fg`를 써서, 어떤 표면도 애플리케이션의 다른 곳에 없는 색을 보이지 않는다. 사이드카는 다른 모드와 `#rrggbb`가 아닌 색을 거부한다. 색은 기본 배경과 전경, 커서, 선택 배경을 바꾸며(선택한 칸은 프로그램이 OSC 17이나 19 강조 색을 정하지 않으면 그 배경 위에 자기 글자 색을 유지한다), `mode`는 인덱스 ANSI 팔레트를 고른다. 프로그램은 표준 팔레트와의 대비를 보고 그 색을 고르므로 테마는 인덱스 색을 바꾸지 않는다. 페이지는 적용된 모드와 배경을 `terminal.session`의 `theme`와 `background`로 알린다. 래스터는 칸 격자 밖, 즉 마지막 열의 오른쪽과 마지막 행의 아래를 현재 기본 배경으로 채운다. 현재 기본 배경은 테마 배경이거나 프로그램이 OSC 11로 정한 색이며, 화면은 그 색을 `background`로 알린다. 이 변경은 이후 및 기존 화면 셀에 적용하며 PTY, 세션, 텍스트, 커서 위치, 셀 메트릭을 다시 만들지 않는다. 모드는 이미지 표면 속성이며 다음 완전한 프레임에 적용된다. 전송 중인 래스터는 변경하지 않는다.

터미널 탭은 프로그램 제목을 보인다. 페이지는 OSC 0이나 OSC 2 제목을 `tab.title`로 알리고 제목 초기화에서 지운다. 터미널 설정 `terminal.title`은 `program`(기본값)이나 `name`을 고른다. `name`이면 페이지는 제목을 알리지 않고 보이던 제목을 지우며, 다시 `program`으로 바꾸면 프로그램이 마지막으로 정한 제목을 보인다. `tab.title`이 거부한 제목은 세션 오류다. OSC 8 하이퍼링크 안의 셀은 화면에서 URI를 `link`로 가지며, 래스터는 SGR 4 글자처럼 밑줄을 긋는다. 링크 셀 위의 포인터는 손 모양이다. 링크 셀을 Command와 함께 클릭하면 그 URI로 선언된 명령 `terminal.link.open`을 실행해 `runtime.links.open`([링크 열기](../spec/plugins.ko.md#링크-열기))으로 열며, 그 클릭은 선택을 시작하지 않는다. Command 없는 클릭은 선택 동작을 유지한다. 호스트가 거부한 URI는 입력 세션 오류다. 페이지는 `terminal.notifications` 정책(`tab` 기본값 또는 `system`)과 함께 OSC 9 알림을 `tab.notify`에 넘긴다. `tab`은 탭 알림만 보이고 `system`은 호스트 알림 센터에만 보낸다. 호스트가 `system`을 제공할 수 없으면 네이티브 오류가 남고 페이지는 fallback하지 않는다. 페이지는 OSC 7 이벤트마다 디렉터리를 `tab.directory`로 기록한다. 사이드카의 `directory` 이벤트는 URI와 `path`를 가지며, `path`는 스킴이 `file`이나 `kitty-shell-cwd`이고 호스트가 비었거나 `localhost`이거나 로컬 호스트 이름이면 퍼센트 디코딩한 절대 경로이고, 다른 컴퓨터의 디렉터리이면 `null`이며 이때 기록한 디렉터리를 지운다. 다른 스킴이나 상대 경로, 디코딩할 수 없는 경로의 URI는 엔진 오류로 거부한다.

커서 상태는 위치·표시 여부·모양·깜빡임 정책·색상을 포함한다. 커서 정책은 명시적으로 관리한다. 모양은 `block`·`underline`·`beam`, 깜빡임은 `Never`·`Off`·`On`·`Always`, 간격은 양의 밀리초(기본 750), 유휴 제한 시간은 0 이상 밀리초(기본 5000, 0은 제한 없음), 비포커스 모양은 `hollow`·`solid`·`underline`·`beam`·`unchanged`다. 기본은 포커스 시 채워진 block과 `Off`, 비포커스 시 steady hollow block이다. `Never`와 `Always`는 프로그램 깜빡임 요청보다 우선하고 `Off`와 `On`은 프로그램 요청을 허용한다. 프로그램 커서 모양은 설정 기본값보다 우선한다. 프로그램 가시성은 권위 값이다. 터미널 모듈은 사이드카가 `cursor` 연산에 답한 뒤에 그 정책을 `terminal.cursor`에 보고한다. 사이드카는 그 정책으로 그린 프레임을 표시한 뒤에 답한다. `terminal.cursor`는 `drawn`도 알린다. 이는 프로그램의 요청과 초점 규칙을 적용해 사이드카가 그린 모양(`block`, `underline`, `beam`, `hollowBlock`, `hidden`)과 깜빡임 요청이다. 사이드카가 표시하는 모든 래스터는 그 래스터가 그린 화면의 screen 이벤트를 함께 싣는다. 그래서 초점 변경이나 다른 다시 그리기가 위치, 초점, `drawn`을 픽셀과 함께 바꾼다. 렌더링은 커서 픽셀만 바꾸며 페이드·크기 애니메이션을 사용하지 않고 PTY나 셀 메트릭을 재생성하지 않는다. 커서는 그 위치에 표시된 조합 문자열을 포함해 그 위치 글자의 표시 폭만큼 덮는다. 넓은 글자는 두 칸 커서가 덮으며 커서는 마지막 열을 넘지 않는다. 조합 중 `selectedRange.location`이 있으면 그 UTF-16 그래핌 경계에 커서를 그린다. 끝 위치는 조합 문자열 뒤를 가리킨다. 그래핌 내부 위치는 오류이며 커서는 터미널 마지막 열 안에 둔다. 글리프 폭이 두 칸보다 좁은 넓은 글자(대체 글꼴로 그리는 한글 등)는 제 크기로 두 칸 안에서 가로 가운데에 그리고, 칸만큼 넓거나 더 넓은 글리프는 첫 칸에서 시작한다.

정책은 터미널 플러그인의 `plugin.json`에 선언하고, 애플리케이션의 초기값은 `environment.json`에서 받으며, 이후 유효한 공통/프로젝트 설정을 따른다. 워크벤치는 저장 전에 선언 규칙으로 각 값을 검증하고 잘못된 값이면 부분 patch를 적용하지 않고 명시적인 오류를 보고한다. 마운트된 터미널 표면에는 유효한 플러그인 내부 설정을 전달하며, 터미널 표면은 시작 시와 유효 설정이 바뀔 때마다 완전한 정책을 사이드카로 보낸다.

터미널 프로그램의 클립보드 접근은 사용자가 명시적으로 붙여넣는 동작과 별개다. 선언된 `clipboard.program` 설정은 `deny` 또는 `allow`이며 기본값은 `deny`다. 거부 시 OSC 클립보드 저장/조회 요청은 관측 가능한 정책 오류를 내고 호스트 클립보드에 쓰지 않으며 대기 중인 조회 callback도 남기지 않는다. 허용 시에도 선언된 텍스트 클립보드 대상만 처리하고, 지원하지 않는 selection 대상과 부재/비텍스트 값은 명시적 오류로 남긴다. 사용자 `terminal.paste` 명령에는 이 프로그램 권한을 적용하지 않는다.

네이티브 IME가 조합 문자를 소유한다. 조합 중에는 preedit를 표시하고 미완성 음절을 PTY에 쓰지 않는다. 확정 문자는 일반 입력과 같은 순서 보장 큐에서 정확히 한 번 전달한다. 캐럿 좌표가 후보창 위치를 정한다. 지원하지 않는 네이티브 텍스트 값과 입력 실패는 명시적 오류다.

네이티브 입력 어댑터는 Unicode 범위 검사가 아니라 텍스트 입력 클라이언트의 marked-text callback으로 조합과 확정을 구분한다. 유일한 예외는 아래에 적은 macOS 한국어 입력기의 확정 시점이다. 모든 `insert` callback은 바이트 단위로 순서대로 전달하며, 플러그인은 문자 스크립트나 코드 포인트를 근거로 조용히 버리거나 바꾸면 안 된다. 각 플랫폼 어댑터는 OS 텍스트 입력 수명주기를 사용하고 확정 callback을 정확히 한 번 노출해야 한다. 빈 `compose` callback은 조합 중 텍스트를 지우거나 취소하며, 이전 marked 문자열을 확정하지 않는다. PTY 확정 입력은 `insert` callback만 만든다. 플랫폼이 marked text를 입력으로 받아들이면(macOS의 `unmarkText`) 어댑터는 그 문자열을 `insert` 하나로 보고한다.

입력기는 marked text 대신 이전에 넣은 문자열을 고쳐 쓸 수 있다. 예를 들어 macOS 한국어 입력기는 `ㅎ`을 넣은 뒤 교체 범위로 `하`, `한`으로 바꾸며, 조합 중인 음절의 문서 위치를 기억한다. 따라서 선택된 입력 소스가 자판이 아니라 입력기인 동안 플랫폼 어댑터는 입력기가 넣은 문자열을 입력 문서에 두고 교체를 그곳에 적용하며, 입력기가 아직 고칠 수 있는 부분을 조합 문자열로 보고한다. 가장 최근 insert의 시작보다 앞의 문자열은 `insert` 하나로 확정하고, 위치가 바뀌지 않도록 확정한 문자열도 입력 문서에 남긴다. macOS 한국어 입력기는 한글 자모와 음절만 조합하며, 이 교체 방식에서는 조합이 끝났다는 콜백을 보내지 않는다. 음절 뒤의 Space나 숫자는 그 음절과 한글이 아닌 문자를 모두 편집 가능한 뒤쪽 문자열에 남길 수 있다. 앞서 관찰한 콜백은 음절을 자기 자신으로 교체한 뒤 공백이나 숫자를 넣었다. 이 입력기는 받침이 다음 음절로 옮겨 갈 때 가장 최근 insert 앞의 음절도 고치며, 그 음절을 바꾸기 전에 새 음절을 먼저 붙일 수 있으므로, 이 입력기가 선택된 동안 어댑터는 그 한글 음절을 다음 insert나 조합의 끝까지 편집 가능한 뒤쪽 문자열에 둔다. 따라서 이 입력기가 선택된 동안 어댑터는 편집 가능한 뒤쪽 문자열의 마지막 문자가 한글이 아니면 그 문자열을 즉시 확정한다. 마지막 음절과 Space가 한 문자열에 남는 경우를 처리하면서 새 한글 자모는 계속 조합 상태로 둔다. 이 규칙은 확정 시점만 정하며 입력을 버리거나 바꾸지 않는다. 다른 입력기는 일반 규칙을 따른다. 확정되지 않은 입력기 문자열이 있는 동안 Control이나 Option이 없는 특수 키는 먼저 입력기로 가므로, 텍스트 뷰처럼 Backspace가 조합을 편집한다(`한`이 `하`가 됨). 입력기가 키를 처리하지 않으면 AppKit이 클라이언트에 그 키의 명령을 요청하고, 어댑터는 남은 문자열을 확정한 뒤 명령 대신 원래 키를 보고한다. AppKit이 Enter를 처리하면서 `insertNewline:`을 호출하면 터미널 입력 경로는 확정 문자열 뒤에 Enter 키 하나를 보낸다. AppKit의 `noop:` 선택자는 동작이 없는 명령이므로 입력을 바꾸거나 확정하지 않고 네이티브 영역에서 처리한다. 그 밖에 지원하지 않는 네이티브 명령 선택자는 명시적 오류로 보고한다. 그 밖의 특수 키, 명령, 포커스 해제, 입력 소스 전환, 영역 닫기 전에는 남은 문자열을 확정하고 입력기의 조합을 끝낸 뒤 문서를 비운다. 자판에서 온 문자열은 즉시 확정한다. 이미 확정한 문자열에 대한 교체는 명시적 오류로 보고한다. 어댑터는 텍스트 저장소를 입력 문서로 쓰는 AppKit 텍스트 뷰다. 터미널이 선언하지 않은 텍스트 편집을 모두 끈다: 자동 치환, 대체, 맞춤법과 문법 검사, 감지, 완성, 텍스트 검사 종류, 실행 취소, 서식 있는 텍스트, 그림, 찾기 막대, 글꼴 패널, 눈금자. 서비스 메뉴는 입력 문서를 읽거나 바꿀 수 없으며, 포인터, 메뉴, 끌기 입력은 이 뷰를 대상으로 하지 않는다. 자기 문서를 가진 일반 뷰도 같은 한국어 결과를 냈지만 입력 클라이언트로 쓰면 영역이 닫힌 뒤 해제된 메모리를 계속 썼으므로 텍스트 뷰를 유지한다.

터미널 플러그인은 네이티브 callback과 같은 순서 보장 사이드카 경로로 현재 preedit를 설정하는 `terminal.compose.update` 명령을 `diagnostics.json`([진단 선언](../spec/plugins.ko.md#진단-선언))에 선언하므로, 이 명령은 진단 빌드에만 있다. 이 명령은 OS 입력기가 만드는 preedit를 주입한다. 문자열 `text`, 선택적 `selectedRange` 및 `replacementRange`(`null` 또는 음이 아닌 정수 `{location, length}`), 선택적 boolean `attributed`를 받는다. 생략한 범위는 `null`, 생략한 `attributed`는 `false`이며 빈 문자열은 preedit를 지운다. 이 명령은 PTY 바이트를 쓰지 않는다. 기존 `terminal.compose` status가 적용된 preedit를 보고하고, 이전 이미지 전송이 소비된 다음 네이티브 이미지가 각 갱신을 표시한다. 이 명령은 preedit 렌더링과 순서를 검증하며 실제 OS IME 검증을 대체하지 않는다.

터미널 플러그인은 명시적으로 시작하는 제한 크기 IME 진단 trace도 `diagnostics.json`에 선언한 `terminal.ime.trace` 명령과 status로 제공한다. 활성화 중 네이티브 `key`·`compose`·`insert` callback과 각 입력에 대응하는 순서 보장 터미널 입력 작업 및 텍스트를 기록한다. trace 용량에 도달하면 이벤트를 조용히 버리지 않고 trace를 명시적 실패 상태로 만든다. 중지하면 기록과 초과 상태를 반환한다. 기본은 비활성화이며, trace는 진단 증거일 뿐 네이티브 픽셀 조합 검증을 대체하지 않는다.

선택, 클립보드, 붙여넣기, 파일 드롭, 이미지 붙여넣기, 터미널 출력 이미지 표시는 서로 다른 동작이다. 붙여넣은 이미지는 소유 파일로 저장하고 자동 실행 없이 경로를 입력한다. 선언된 `terminal.paste` 명령만 텍스트 붙여넣기 진입점이다. 포커스된 터미널 영역에서 Edit > Paste(Command+V)와 Paste and Match Style은 `paste` 동작을 보고하고, 이 동작은 명령 레지스트리로 `terminal.paste`를 실행한다. Edit > Copy(Command+C)는 `copy` 동작을 보고하고, 이 동작은 `copy` 요청을 보내는 `terminal.copy`를 실행한다. 사이드카는 현재 선택 텍스트를 담은 `copy` 이벤트로 답하고 터미널 모듈은 이를 `userInitiated: true`로 클립보드에 쓴다. 선택이 없으면 `copied: false`로 답하고 클립보드는 바뀌지 않는다. 영역은 페이스트보드 내용을 입력기 문서에 넣지 않으며, 잘라내기, 전체 선택, 삭제는 영역에서 꺼져 있다. 이 명령은 범위가 지정된 클립보드 capability를 `userInitiated: true`로 사용해 텍스트를 읽고, 클립보드가 없거나 텍스트가 아니면 명시적으로 거부하며, 실패를 빈 입력으로 바꾸지 않는다. 선택 해제의 복사가 사이드카에서 아직 오는 중이면(사이드카는 해제를 그리는 raster 뒤에 보낸다) 명령이 그것을 기다려, 해제 뒤의 붙여넣기가 그 선택의 text를 돌려준다. 사이드카에는 하나의 `paste` 동작만 보내며, bracketed paste 모드에서는 제공된 UTF-8 payload를 바이트 단위로 보존하고 종료 시퀀스가 입력 안에 있으면 삭제하지 않고 거부한다. 전체 payload를 한 번 쓴 뒤에만 응답을 확인한다. 입력을 조용히 정제, 폐기, 재정렬하지 않는다. 터미널 프로토콜 지원은 시퀀스와 참조 판본별로 기록하며 파서가 수락해도 미구현 동작을 지원으로 세지 않는다.

터미널 위의 휠 입력은 스크롤 제스처다. 터미널 페이지는 자기 뷰의 DOM 휠 이동량을 정수 줄로 바꾸며, 픽셀 이동량은 칸 높이로 누적하고, `{operation: "scroll", lines, col, row}`를 보낸다. 양수 `lines`는 오래된 출력 쪽으로 움직이고, `col`과 `row`는 포인터가 있는 칸이다. 사이드카는 터미널 모드에 맞는 첫 규칙을 적용한다. 마우스 보고(모드 1000, 1002, 1003)가 켜져 있으면 포인터 칸에서 줄마다 휠 버튼 이벤트 하나(오래된 출력 쪽 버튼 64, 새 출력 쪽 65)를 현재 마우스 인코딩(SGR 1006, UTF-8 1005, 기본)으로 쓴다. 그렇지 않고 대체 화면에서 대체 스크롤(모드 1007)이 켜져 있으면 현재 커서 키 모드로 줄마다 위쪽 또는 아래쪽 커서 키 하나를 쓴다. 그 밖에는 기본 화면의 뷰포트를 보관된 기록 범위 안에서 `lines`만큼 스크롤백으로 움직인다. screen 이벤트는 뷰포트를 보이고, 커서 행이 뷰포트 밖이면 커서를 숨긴 것으로 보고한다. 키 입력, 텍스트 입력, 붙여넣기는 바이트를 쓰기 전에 뷰포트를 가장 새 출력으로 되돌린다. `terminal.session`은 `scrollback: {offset, history}`로 뷰포트가 가장 새 출력보다 위에 있는 줄 수와 보관된 기록 줄 수를 보고한다. 선택 좌표는 제스처가 일어날 때의 뷰포트 좌표다.

터미널이 기록을 보관하는 동안(`scrollback.history`가 0보다 큼) 터미널 페이지는 뷰 오른쪽 가장자리의 선언된 DOM overlay `scrollbar`에 네이티브 이미지 위로 스크롤바를 보이며, 가장 새 출력에서는 손잡이가 트랙 맨 아래에 있다. 호스트가 overlay 아래의 네이티브 그림을 잘라내므로 트랙은 screen 이벤트가 `background`로 보고하는 터미널의 현재 기본 배경색(OSC 11로 바뀐 값 포함)으로 칠한다. 손잡이 높이는 트랙 높이에 `rows / (rows + history)`를 곱한 값이며 최소 16포인트이고, 손잡이 위쪽은 트랙의 `(history - offset) / (rows + history)` 위치다. 손잡이 위의 포인터는 펼친 손이고, 손잡이를 끄는 동안은 쥔 손이다. 손잡이를 끌면 포인터 아래의 오프셋으로 선언된 명령 `terminal.scrollback.set`이 실행되고, 이 명령은 `{operation: "viewport", offset}`을 보낸다. 사이드카는 기본 뷰포트를 보관된 기록 범위 안에서 그 오프셋으로 옮기고, 프로그램에는 아무것도 쓰지 않으며, screen 이벤트로 답한다. 기록이 없으면 스크롤바를 숨긴다. 네 플러그인 설정이 스크롤바를 정한다. `terminal.scrollbar.track`은 `terminal`(터미널의 현재 기본 배경색, 기본값) 또는 색이고, `terminal.scrollbar.thumb`은 손잡이 색(기본 `#8f98a080`)이며, `terminal.scrollbar.width`는 4에서 24 사이의 트랙 폭(포인트, 기본 10)이고, `terminal.scrollbar.shape`는 `rounded`(기본) 또는 `square`다. 색은 `#rrggbb` 또는 `#rrggbbaa`이며, 그 밖의 값은 입력 오류로 보고하고 적용하지 않는다. 설정을 바꾸면 보이는 스크롤바에 바로 적용한다.

네 플러그인 설정이 터미널 padding을 정한다. `terminal.padding.top`, `terminal.padding.right`, `terminal.padding.bottom`, `terminal.padding.left`는 0에서 64 사이의 정수(포인트, 기본 0)다. 페이지는 네이티브 이미지 영역 `view`를 그만큼 안쪽으로 배치하므로 셀 격자는 padding 안쪽을 차지하고, 스크롤바는 그 영역의 오른쪽 가장자리에 둔다. 네이티브 anchor의 조상은 배경을 갖지 않으므로([표면 합성](../spec/surface-composition.ko.md)) 변마다 padding은 터미널의 현재 기본 배경색으로 칠한 선언된 DOM overlay 띠(`padding-top`, `padding-right`, `padding-bottom`, `padding-left`)이고, 크기가 0인 띠는 숨긴다. 그 밖의 값은 입력 오류로 보고하고 적용하지 않는다. 설정을 바꾸면 바로 적용한다.

터미널 선택은 DOM 텍스트 선택이 아니라 네이티브 영역의 제스처다. 네이티브 영역은 CSS 로컬 좌표와 modifier 상태를 포함한 왼쪽 버튼 누름·이동·해제를 보고하고, 사이드카가 이 좌표를 적용된 셀 그리드로 변환해 선택 상태를 소유한다. 이동은 왼쪽 버튼을 누른 채 움직인 포인터다. 창이 키 창이 될 때 WebKit이 보고하는 포인터 위치처럼 버튼 없는 이동은 선택을 시작하거나 바꾸지 않는다. 영역은 마지막 완전한 열과 행 뒤로 한 칸보다 작게 더 뻗는다. 뷰 안에서 누른 뒤에는 페이지가 뷰 밖의 끌기 점을 뷰 안의 가장 가까운 점으로 옮긴다. 줄의 처음이나 끝으로 끄는 동작은 뷰 가장자리를 지나기 때문이다. 뷰 밖의 누름은 선택을 시작하지 않는다. 사이드카는 누른 점과 끌기 점을 그 행의 가장 가까운 칸 경계로 옮기므로, macOS 터미널처럼 포인터가 칸의 가로 가운데를 지나야 그 칸이 선택에 든다. 어느 방향의 끌기든 선택은 두 경계 사이의 칸이며, 그려진 선택은 텍스트가 복사되는 칸과 정확히 같다. 그 여백의 점은 마지막 행과 가장 가까운 경계에 대응하며 마지막 열 뒤에서는 그 오른쪽 경계다. host가 네이티브 영역의 가장자리를 device pixel에 맞추므로 영역은 view보다 최대 한 device pixel 작을 수 있고, 영역을 한 device pixel 미만 지난 점은 여백의 점처럼 대응한다. 그보다 영역 밖의 점은 잘못된 좌표다. 일반 드래그는 simple 선택을 만들고 렌더링 선택 픽셀을 갱신하며, 해제 시 선택 텍스트를 담은 명시적 사용자 선택 복사 event를 한 번 낸다. 터미널 모듈은 `clipboard.program` 정책과 무관하게 범위가 지정된 클립보드 capability에 `userInitiated: true`로 기록한다. 빈 칸 위를 끈 경우처럼 글자를 담지 않은 선택의 해제는 선택을 지우고 클립보드를 바꾸지 않으며 `copied: false`인 `selection.end`를 낸다. 이는 정상 제스처이며 오류가 아니다. 클릭처럼 움직이지 않은 누름과 뗌, 또는 칸의 가운데를 지나지 않은 끌기는 한 경계에서 빈 선택을 시작하고 끝내므로, 클릭은 이전 선택을 지운다. `terminal.session`은 왼쪽 버튼 제스처가 진행 중이면 `selecting`을 보고하고, 사이드카가 복사나 `selection.end`로 답한 해제의 수를 `selectionReleases`로 센다. 클립보드 capability 부재, 잘못된 좌표, 텍스트 없는 복사 event, 기록 실패는 명시적 오류다. 선택 입력을 PTY로 보내지 않으며 DOM fallback도 사용하지 않는다.

페이지는 왼쪽 버튼의 모든 누름, 누른 채 움직임, 뗌과, 다른 칸으로 들어가는 버튼 없는 움직임도 `mouse` 연산 `{phase, x, y, pressed, shift, alt, ctrl}`로 보낸다. 프로그램이 마우스 보고를 켰으면 Shift 없는 누름은 보고 제스처를 시작하고 이전 텍스트 선택을 지운다. 사이드카는 누를 때 그 제스처의 움직임 소유권을 고정한 뒤 누름과 뗌, 그리고 고정된 소유권에 ?1002나 ?1003이 포함되면 누른 채 다른 칸으로 들어가는 움직임을 쓴다. 끄는 중에 프로그램의 마우스 모드가 바뀌어도 소유권을 텍스트 선택으로 넘기지 않으며, 그 제스처의 선택 연산은 아무것도 선택하지 않고 평소처럼 답한다. ?1003이면 다른 칸으로 들어가는 버튼 없는 움직임도 알린다. 허용된 모든 포인터 단계마다 `mouse` event를 내고 `terminal.session.mouse`에 단계·칸·modifier·활성 보고 모드·PTY 보고 선택 여부·기록 결과·있을 때의 정확한 PTY 바이트 base64 값을 남긴다. 보고하지 않은 단계도 `reported: false`, `bytes: null`로 내며 조용히 버리지 않는다. 이는 자식 프로그램이 제스처를 받았는지 판정하는 측정 근거다. 보고는 기본 인코딩, ?1005면 UTF-8 좌표, ?1006이면 SGR을 쓰고 Alt(8)와 Control(16) 비트를 싣는다. 기본 인코딩이 나타낼 수 없는 좌표는 명시적 오류다. 마우스 보고가 켜져 있어도 Shift를 누른 누름은 글자를 선택한다. 터미널 뷰는 OSC 22 포인터 모양이나 링크가 바꾸지 않는 한 래스터 글자 위에서 텍스트 선택 포인터를 쓰며, 천천히 움직여도 화살표 포인터가 잠깐 나타나지 않는다. 영역은 왼쪽 버튼만 알린다. 프로그램이 초점 보고(?1004)를 켰으면, 사이드카는 영역이 네이티브 초점을 얻을 때 `ESC[I`를, 잃을 때 `ESC[O`를 변경마다 한 번 쓴다. 영역은 숫자 키패드 키를 입력기로 넘기지 않고 이름(`Keypad0`–`Keypad9`, `KeypadDecimal`, `KeypadPlus`, `KeypadMinus`, `KeypadMultiply`, `KeypadDivide`, `KeypadEquals`, `KeypadEnter`)으로 보고한다. `ESC =` 뒤에 사이드카는 수정 키 없는 키패드 키를 `ESC O`와 `p`–`y`, `n`, `k`, `m`, `j`, `o`, `X`, `M` 중 하나로 보내고, 그 밖에는 키의 글자나 캐리지 리턴을 보낸다.

### 터미널 세션 오류

`terminal.session.error`는 표면에서 가장 최근에 해소되지 않은 오류다. 플러그인은 출처마다 마지막 오류를 두며, 한 출처의 이벤트는 다른 출처의 오류를 지우지 않는다. 스냅샷 출처의 오류는 같은 종류의 다음 유효한 이벤트가 해소한다. 다른 출처의 오류는 이후 어떤 이벤트도 실패한 연산의 성공을 보이지 않으므로 표면이 닫힐 때까지 남는다.

| 출처 | 오류 | 해소하는 이벤트 |
| --- | --- | --- |
| `state` | 잘못된 `state` 이벤트 | 다음 유효한 `state` 이벤트 |
| `session` | 잘못된 영속 `session` 이벤트 | 다음 유효한 `session` 이벤트 |
| `theme` | 잘못된 테마 확인 | 다음 유효한 `theme` 이벤트 |
| `screen` | [화면 메시지](../spec/persistent-services.ko.md#화면-메시지)가 거부하는 `screen` 이벤트(잘못된 커서, 정해진 색이 없는 칸 등) | 다음 유효한 `screen` 이벤트 |
| `trace` | IME trace 용량 초과(진단 빌드) | 새 trace 시작 |
| `sidecar` | 사이드카 `error` 이벤트 또는 오류 응답. 응답은 거부한 연산을 적지 않는다 | 해소되지 않음 |
| `native image` | 네이티브 이미지 영역의 `error` 이벤트 | 해소되지 않음 |
| `input` | 실패한 입력, 붙여넣기, 클립보드, 선택 연산과 잘못된 일회성 사이드카 이벤트 | 해소되지 않음 |
| `key` | 수정자가 불린이 아닌 네이티브 키 이벤트 | 해소되지 않음 |
| `cursor` | 사이드카의 잘못된 커서 위치 | 해소되지 않음 |

`sidecar`와 `native image` 출처는 카드가 표시하는 표면 오류도 보고한다. 둘 다 해소되지 않으므로 카드 표시기와 `terminal.session.error`는 표면이 닫힐 때까지 그 오류를 표시한다.

### 터미널 검증

- 각 수정 전에 실패 기준선을 기록하고 수정 후 같은 단언을 실행한다.
- 생성, 정상 종료, 충돌, 재연결에서 서비스 프로세스, 셸 식별자, PTY 디스크립터, 연결, 출력 시퀀스를 측정한다.
- 양쪽 네이티브 호스트에서 터미널 3개 이상을 사용한다. 빠른 디바이더 제스처 전체, 글리프 메트릭 유지, 네이티브 클리핑, 영역 채움, 복원된 영역을 캡처한다.
- 확정 문자열 주입뿐 아니라 실제 네이티브 키보드와 IME 입력을 관측한다. 의미 상태와 표시 픽셀은 독립 검증한다.
- loading, ready, error를 구분한다. Ready는 세션 생성뿐 아니라 실제 최초 네이티브 표시를 포함한다.

각 mouse 연산과 결과는 동일한 비어 있지 않은 `inputId`를 싣는다. 잘못된 좌표처럼 실패한 mouse 연산도 자기 mouse 결과로 답하며, 그 `x`와 `y`는 `null`이고 `error`는 `invalidParams: <reason>`이므로 결과의 짝이 유지된다. 페이지는 그 오류를 터미널 입력 오류로 보인다. 페이지는 연산마다 새 ID를 지정하며 이전 입력의 결과로 다음 제스처를 완료할 수 없다. `written`은 PTY 쓰기 성공이며 자식의 바이트 수신이나 선택 표시를 뜻하지 않는다. 진단 빌드는 `start`와 `stop` 동작을 가진 `terminal.pointer.trace`로 DOM 포인터·캡처 이벤트, 네이티브 포커스 통지, 대기열의 mouse 연산과 결과를 순서대로 제한된 크기로 기록한다. 한도 초과를 명시적으로 표시하고 측정을 실패시킨다. 쓰기 성공과 자식 수신을 구분하기 위해 사이드카는 열린 세션의 `pty.pending` 연산에 `{event: "pty.pending", pending, written}`으로 답한다. `pending`은 마스터가 쓰고 자식이 아직 읽지 않은 입력 바이트 수로 플랫폼 PTY 입력 큐(마스터 fd의 FIONREAD, macOS에서는 마스터와 슬레이브가 공유하는 tty를 읽는다)에서 재고, `written`은 세션 reader가 지금까지 읽은 자식 출력의 누적 바이트 수다. 한 번의 측정 왕복이 같은 시점의 두 값을 함께 돌려주며 세션이 없는 경우를 포함한 오류 응답도 같은 `pty.pending` 이벤트 표식을 실어 답이 자기 요청을 밝힌다. 진단 빌드는 이 측정을 `terminal.pty.pending` 명령으로 노출하며 0 이상 정수 `{pending, written}`으로 해소되고 사이드카의 명시적 오류는 거절한다. 큐는 전송 관측이다. 아직 조립되지 않은 canonical 모드의 줄은 세지 않으므로 raw 모드 자식이 측정 계약이고, 큐가 비었다는 사실은 자식에 대한 전달은 증명해도 프로그램이 바이트를 해석했음은 증명하지 않는다. 두 표본 사이 `written`의 증가는 자식이 출력을 했다는 관측으로 프로그램 파싱과 선택 렌더링을 나눈다.

반복 수락은 `?1003` motion과 `?1006` SGR 보고를 켜고 자기 선택을 직접 그리는 전체 화면 fixture TUI(`e2e/fixture-tui.mjs`)와 OS 포인터 입력으로 드래그, 같은 TUI의 제3지점 클릭, 포커스 보정이나 상태 초기화 없는 즉시 재드래그 순서로 검사한다. 실패 뒤에만 다른 카드를 클릭하고 돌아와 회복을 관측하며 회복으로 실패를 통과로 바꾸지 않는다. 호스트마다 제3지점 세 영역(입력·출력·빈 영역)을 한 번씩 거치고 가운데 주기는 느린 속도로 하는, 초기화 없는 3주기를 통과해야 한다. 간헐 실패는 repeat target으로 재현하고 수락한다. 각 제스처의 입력 결과를 연결하고 보이는 반응을 전체 녹화에서 수치로 측정한다. Shift 선택은 별도 대조군이다.

## 화면 hash 이동 목록(F236-9-2)

이 절은 [화면 hash 결정](screen-hash-decision.ko.md)의 결정 9-1이 정한 이동 목록과 출시 gate다. byte 정의의 소유자는 선언된 contract repository(화면 contract)다. core는 그것을 import하지 않고 registry 항목도 두지 않는다. 아래 행은 gate가 성립할 때만 core를 떠난다. 그전까지 core는 그 행, 포인터, 검사를 유지한다. 화면 contract repository는 아직 없다.

### contract repository가 가질 것

1. 두 언어의 byte 정의: `screenBytes`와 `screenHash`, 그 JavaScript(npm package)와 Rust(crate) 참조 구현, 그리고 magic `SKSCR1`.
2. golden vector와 거부 메시지, 그리고 두 구현에 이를 돌리는 contract repository 안의 시험.
3. 화면 message 형식과 그 검증기 `screenFromMessage`, 두 언어로. message가 sidecar와 page 사이의 wire이기 때문이다.
4. 이 부분을 정의하는 글: `docs/spec/replay.md`의 "Screen hash"와 "Golden vectors" 절, `docs/spec/persistent-services.md`의 "Screen message" 절, gate가 성립할 때의 내용 그대로.

byte가 바뀌면 magic이 바뀌므로 새 contract tag다. plugin과 sidecar는 같은 변경에서 pin을 옮긴다. contract repository는 plugin이나 sidecar 코드를 갖지 않고, 시험은 자기 fixture만 읽는다.

### core를 떠나는 것

각 행은 core 항목, 목적지, gate를 적는다. S1부터 S10까지는 아래 G1 뒤 core의 한 변경에서 함께 떠난다. 그래서 어떤 core 출시도 반쯤 옮긴 hash를 갖지 않는다.

| 행 | core 항목(경로, HEAD의 줄) | 목적지 | gate |
| --- | --- | --- | --- |
| S1 | `packages/plugin-api/screen-hash.js`: `screenBytes`(42줄), `screenHash`(90줄), `screenFromMessage`(110~134줄)과 그 helper `shown`, `isObject`, `messageRefuse`, `resolvedColor`; 1줄 | contract repository(두 언어). terminal plugin은 그 사본을 import한다 | G1 |
| S2 | `packages/plugin-api/package.json` 15줄과 23줄(export `./screen-hash`); `packages/plugin-api/index.js` 55줄(`PAGE_IMPORTS`); `packages/workbench/index.html` 12줄과 `overlay.html` 25줄(import map); `docs/spec/plugins.md` 309줄과 `docs/spec/plugins.ko.md` 310줄(page import 문장) | 제거. 항목을 import하는 설치된 terminal 버전은 동작을 멈추고 폐기된다(감독자 결정) | G1 |
| S3 | `packages/plugin-api/test/validate.test.mjs` 270줄(항목의 assertion); `packages/plugin-api/test/screen-hash.test.mjs` | contract repository 시험 | G1 |
| S4 | `packages/log-contract/fixtures/replay/screen-hash.json`, `screen-message.json`; 시험 `packages/log-contract/test/screen-hash.test.mjs`, `screen-message.test.mjs`; `replay-vectors-named.test.mjs`에서는 screen-hash vector의 assertion만(`inputs.json`의 assertion은 남는다) | contract repository(vector와 거부) | G1 |
| S5 | `docs/spec/replay.md`의 "Screen hash"(33~55줄)와 "Golden vectors"(56~70줄), `docs/spec/replay.ko.md` 39, 54, 58, 83줄: contract를 가리키는 포인터로 바꾼다. `scripts/check-docs.mjs`에서 `#screen-hash`와 `#golden-vectors`가 여전히 풀리도록 제목은 남는다 | contract repository(글) | G1 |
| S6 | `docs/spec/persistent-services.md` 51~68줄("Screen message")과 `docs/spec/persistent-services.ko.md` 68줄: 포인터로 바꾸고 제목은 남긴다 | contract repository(글) | G1 |
| S7 | `packages/plugin-api/terms.json`의 용어 "screen hash"(169줄) | contract 용어집 | G1 |
| S8 | `scripts/check-test-parity.mjs`의 항목 F160.35(2649~2663줄: 구현, 단위 시험, e2e 시험, expected 문구) | 파서와 함께 contract repository 또는 terminal plugin으로 옮긴다. 시험을 가진 쪽으로 | G1 |
| S9 | sidecar `../sidecars/vt/vt-core/src/screen_hash.rs`: hash 소유자를 뺀다. `message_cells`는 sidecar 모듈로 옮기고, message의 cell과 cursor 형식은 crate에서 온다. 호출자: `vt-core/src/protocol.rs` 1276줄과 1333줄; `vt-alacritty/src/replay.rs` 18줄과 309줄; `vt-core/tests/screen_hash_test.rs` 8줄; `vt-core/tests/screen_message_test.rs` 6줄과 `screen-message.json` 읽기 | sidecar repository, crate를 통해 | G1(crate에 의존하는 sidecar 출시) |
| S10 | sidecar 사본 `vt-core/tests/fixtures/log-contract/screen-hash.json`, `screen-message.json`과 README 8~11줄("Core owns all three") | sidecar repository가 제거 | G1(S9와 같은 sidecar 출시) |
| S11 | `scripts/check-test-parity.mjs`의 항목 F160.25(2617~2630줄): 구현 `screenHash`(`screen-hash.js`)가 contract repository로 옮기고, `sok` 시험 `replay_test.go`와 `replay_test.rs`, e2e 시험은 core에 남아 남은 소유자로 항목을 재배정한다. `packages/sok/tauriv2/tests/replay_test.rs`(590줄)와 `packages/sok/wailsv3/tests/replay_test.go`(340줄)의 screen message를 인용한 주석도 재배정한다 | contract repository(구현), core(시험, 재배정) | G1 |
| S12 | `docs/spec/events.json` 190줄(처음 분기의 설명): page frame의 layer를 `page`로 적고 있다. `replay.md` 22줄에 따라 `plugin`으로 바꾼다(감독자 결정). `page.*` 이벤트의 layer `page`는 남는다 | core | F236-9-3, gate 없음: 이름 정정만 하며 저장된 기록은 이미 `plugin`을 쓴다 |
| S13 | `packages/plugin-api/terms.json`: 용어 "replay"(150줄과 151줄)이 terminal 세션을 말한다 | core | F236-9-3, gate 없음: "세션"으로 |
| S14 | terminal page `../plugins/terminal/ui/terminal.js`: `screenFromMessage`와 `screenHash`를 import하는 2줄과 호출 1209줄과 1218줄은 (b)의 복사본을 쓴다. plugin의 `Makefile`에 `make pack` 전 복사 단계를 넣는다 | terminal plugin repository | G1 (b) |
| S15 | 복원 입력 검증기(gate V2): `docs/spec/replay.md` 72, 87, 109줄; `docs/spec/host-contract.md` 696줄과 `docs/spec/host-contract.ko.md` 697줄(명령 `cli.debug.replay-input-cases`); `packages/log-contract/test/replay-inputs.test.mjs`(7, 17, 23, 29줄); `packages/sok/tauriv2/tests/replay_inputs_test.rs`와 `packages/sok/wailsv3/tests/replay_inputs_test.go`; `scripts/check-test-parity.mjs`의 항목 F160.34(2633~2648줄) | V2가 성립할 때까지 core. 그 뒤 sidecar repository가 검증기 시험을 가지고 항목도 함께 온다. `replay.md`와 `host-contract.md`는 명령 문구를 남긴다 | V2 |
| S16 | `CHANGELOG.md`와 `CHANGELOG.ko.md`의 F160.25, F160.34, F160.35 항목, 그리고 `docs/features.md`와 `docs/features.ko.md`의 F236-9 항목은 기록으로 남고 바뀌지 않는다. G1 (e)는 사용자에게 미치는 결과를 담은 changelog 항목을 새로 추가한다 | core(새 changelog 항목만) | G1 (e) |

유지되는 일반 문구는 `docs/spec/replay.md` 5줄("각 화면의 hash"와 입력 종류 표)이며, terminal을 이름 부르지 않는다.

변경 뒤 core는 행 F160.25(`screenHash`)를 `screenHash`를 가지는 동안만 두고, S1과 같은 변경에서 contract repository로 재배정한다. `sok` 형식 검사는 core에 남는다. 문자열 형식만 검사하고 아무것도 계산하지 않기 때문이다: `packages/sok/tauriv2/src/replay.rs` 100줄의 `is_screen_hash`와 `packages/sok/wailsv3/src/replay.go` 26줄의 `screenHashText`. 설치 기반 창 검사 `e2e/terminal-replay.test.mjs`는 `AGENTS.md` 33줄의 예외로 core에 남고, G1 (d)의 관찰 동작 검사다.

### View state의 producer 규칙(gate V1)

`docs/spec/replay.md` 74~98줄("View state"와 그 "Decision")은 terminal 엔진이 그려진 화면을 계산하는 방식을 말한다: cell의 selection 강조, 테마에 따른 빈 cell 자르기, viewport 이동, viewport 밖의 cursor. 그 저장소가 가질 때 terminal sidecar(`../sidecars/vt`, 그 `docs/spec/`)의 명세로 옮긴다. core는 `replay.md`의 "### Hashed members" 제목 아래에 일반 문장 하나를 둔다. hash된 cell과 cursor는 sidecar가 그려진 화면에 대해 보고하는 것이며, 각 sidecar는 자기 명세에서 그것을 계산하는 방식을 말한다. 97줄(그려진 화면의 golden vector)은 vector가 contract에 남으므로 "Golden vectors"에 남는다. gate V1: sidecar 명세가 글을 가지고 그 저장소의 문서 검사가 통과한다. V1이 성립하면 `scripts/check-test-parity.mjs`의 행 F160.34는 view-state 문구가 아니라 `replay.md`의 입력 종류를 기대한다.

### replay 입력 검증기(gate V2)

검증기는 byte 정의가 아니라 terminal 경계(grid에 대한 selection, 테마 색)를 가진다. 이동 목록은 다음과 같다.

- core: `packages/log-contract/index.js`의 `replayInputProblem`과 `replaySessionProblem`, fixture `packages/log-contract/fixtures/replay/inputs.json`, 그리고 명령이 `replaySessionProblem`을 부르는 곳(`replay.md` 85줄)은 V2가 성립할 때까지 남는다.
- sidecar 사본: sidecar fixture(`vt-core/tests/fixtures/log-contract/`)의 `replay-inputs.json`.
- `sok` 사본: `packages/sok/tauriv2/src/replay_inputs.rs`와 `packages/sok/wailsv3/src/replay_inputs.go`.
- 계약 변경이 먼저다: `replay.md`의 "Replay executable"에 요구가 들어간다. 실행 파일은 검증기가 거부하는 `inputs.json`의 모든 입력을 같은 오류 문구로 거부한다. 요구는 그것을 담은 sidecar 출시에 적용된다.
- gate V2: 설치된 sidecar 출시가 `inputs.json`의 잘못된 경우를 자기 실행 파일로 end-to-end 창 검사에서 통과시킨다. 그다음 core는 검증기, `sok` 사본, sidecar 사본을 한 변경에서 제거하고, 명령은 더 이상 `replaySessionProblem`을 부르지 않는다.

### gate G1(행 S1~S10)

행 S1~S10은 다음이 모두 성립할 때만 core를 한 변경에서 떠난다.

- (a) contract repository에 byte, vector, message 형식을 담은 npm package와 crate를 공개하는 tag가 있고, 두 구현이 그 저장소의 vector를 통과한다.
- (b) terminal plugin 출시가 그 tag의 모듈을 `make pack` 전에 `ui/`로 복사하고 `files`에 적으며, npm package를 `devDependencies`가 아니라 `dependencies`에 선언한다(모듈이 실행 파일과 함께 배포되므로). page는 복사본을 상대 경로로 import한다. terminal sidecar 출시는 crate를 `Cargo.toml`의 `[dependencies]`에 선언하고 hash에 그것을 부른다.
- (c) `../registry/plugins/terminal.json`에서 core 항목을 import하는 terminal 출시가 모두 `../registry/revoked.json`에서 폐기된다. `engines.soksak`으로는 구분할 수 없으므로 `0.0.3`부터 최신까지 각 출시를 검사한다: `0.0.4`~`0.0.10`은 `*`, `0.0.11`~`0.0.14`는 `>=0.0.11`이다. import를 아직 확인하지 못한 출시는 확인될 때까지 gate를 막는다.
- (d) registry로 설치한 그 plugin과 sidecar로 `e2e/terminal-replay.test.mjs`가 통과한다.
- (e) 제품 결정을 사용자에게 보이는 결과와 함께 changelog에 적는다: 폐기된 terminal 버전의 설치된 page는 사용자가 registry에서 새 terminal 출시를 설치할 때까지 멈춘다(감독자 결정). 폐기만으로는 설치된 사본이 제거되지 않는다.

순서: (a) contract tag, (b) plugin과 sidecar 출시, (c) 폐기, (d) 창 검사, (e) changelog 항목, 그다음 S1~S10을 제거하고 parity 행을 재배정하는 core 변경.

### 기록한 공백(이 목록이 풀지 않는 것)

- core 변경 전까지 core의 사본, contract의 사본과 sidecar의 fixture 사본이 나란히 있고, core가 돌릴 수 있는 검사는 이를 비교하지 않는다. 어긋남은 설치된 쌍을 통한 `e2e/terminal-replay.test.mjs`에서만 드러난다. 이 공백은 G1과 함께 닫힌다.
- terminal plugin의 `sok plugin pack`이 `files` 목록을 어떻게 다루는지는 확인하지 않았다. (b)의 복사 단계는 출시를 만들 때만 검증된다.
- 폐기된 출시는 사용자 기기에 설치된 채 남는다. registry 조치로는 제거되지 않는다.
