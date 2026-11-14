# Command line `sok`

[English](cli.md)

`sok`은 soksak 애플리케이션의 command line이며, 모든 명령을 이것으로 공개한다. 두 package가 한 계약으로 이것을 구현한다. Tauri 애플리케이션용 Rust `packages/sok/rust`와 Wails·mygo 애플리케이션용 Go `packages/sok/go`이다([hosts](hosts.ko.md#command-line-트리)). 두 package는 애플리케이션 framework를 link하지 않는다. 각 애플리케이션 bundle은 실행 파일 옆에 자기 `sok`을 담고(macOS에서는 `Contents/MacOS/sok`), host는 설정 창의 plugin 명령에 그 `sok`을 실행하므로 언어마다 설치 구현은 하나다. `sok`은 `--config-dir`가 다른 폴더를 지정하지 않으면 자신이 속한 애플리케이션의 설정 폴더(`app.soksak.tauri`, `app.soksak.wails` 또는 `app.soksak.mygo`, `dev` 플래그 빌드는 `.dev`를 붙인다. [projects](projects.ko.md#저장) 참조)를 쓴다. 그래서 `PATH`가 닿는 `sok`이 구현과 설정 폴더를 정한다. `PATH`는 bundle의 실행 파일 폴더를 담은 경로 항목 `/etc/paths.d/<application identifier>`로 bundle에 닿는다. `sok path install`은 그것을 실행한 `sok`의 항목을 쓰고 `sok path remove`는 지운다. 둘 다 관리자 권한(`sudo`)이 필요하고, 되풀이해도 결과가 같으며, 쓰기에 실패하면 파일과 이유를 보고한다. 새 shell이 항목을 읽는다. Command line은 symbolic link를 쓰지 않는다.

## 운영체제

`sok`은 macOS와 Linux에서 실행된다. platform key는 `arm64`나 `x64`를 쓴 `<os>-<arch>`다([설치](installation.ko.md)). Linux에서 설정 폴더는 `$XDG_CONFIG_HOME` 아래, 그것이 없으면 `~/.config` 아래의 애플리케이션 식별자이고, 엔드포인트는 macOS처럼 Unix socket이다([엔드포인트](endpoint.ko.md)). Linux에는 경로 항목 폴더가 없으므로 `sok path install`과 `sok path remove`는 거기서 `path entries are not implemented on linux`로 실패한다. Windows에서는 private event-log 디렉터리와 파일, process ownership lock file을 지원하지 않는다. 이 동작은 경로를 만들기 전에 `event log directory <path> is not implemented on windows`, `event log file <path> is not implemented on windows`, `process lock file <path> is not implemented on windows`를 보고한다. Event-log 준비 실패는 표준 오류에 보고한 뒤 기록 없이 명령을 실행하며, process-lock 실패는 쓰기 명령을 거부한다.

현재 Linux와 Windows platform 구현은 process 종료 대기를 지원하지 않는다고 보고한다. interrupt signal을 감시하지 않는 Rust CLI의 Windows platform은 기다림이 시작 전에 SIGINT와 SIGTERM을 감시하므로 interrupt signal이 지원되지 않는다고 먼저 보고한다. 따라서 해당 시스템에서 `sok process wait`는 명시적인 오류로 실패한다. macOS에서는 kernel process-exit notification을 사용한다.

## 명령

| 명령 | 동작 |
| --- | --- |
| `sok <command> [window] [--surface <id>] [--<parameter> <value>]... [--params <json>]` | 실행 중인 애플리케이션에서 core나 plugin이 선언한 command를 [endpoint](endpoint.ko.md) method `command.run`으로 실행한다 |
| `sok commands [window] [--query <text>]` | `exposure.list`의 `commands` 목록을 출력한다. 선언된 command마다 설명, 매개변수 schema, 결과 schema다. `--query`는 query에 맞는 command만 남긴다([탐색](#탐색)) |
| `sok windows` | 실행 중인 애플리케이션의 창을 나열한다 |
| `sok exposures [window] [--kind status\|command\|element] [--query <text>]` | 선언된 모든 status, command, element 항목을 나열한다. `--kind`는 목록 하나만, `--query`는 query에 맞는 항목만 남긴다([탐색](#탐색)) |
| `sok status <name> [window] [--surface <id>] [--watch]` | Status 값을 출력한다. `--watch`는 값과 이후 바뀔 때마다 JSON 한 줄씩 출력한다. SIGINT나 SIGTERM은 watch를 끝낸다: signal을 받은 routine이 연결을 닫고, 닫힘의 결과와 함께 명령을 기록하고, 상태 0으로, 또는 닫힘의 오류와 함께 1로 프로세스를 끝낸다. 명령이 표준 출력 쓰기에서 기다리는 동안에도 같다 |
| `sok element rect\|click\|input\|dispatch <name> [window] [--surface <id>] [--index <n>] [--value <text>] [--event <json>]` | 선언된 element 항목에 동작한다 |
| `sok input pointer [window] --x <x> --y <y> --phase move\|down\|drag\|up\|scroll [--button left\|right] [--delta-x <n>] [--delta-y <n>] [--clicks <n>] [--activate]` | Native pointer 입력을 보낸다. 누름은 그 명령의 연결의 것이므로 `--phase down` 명령이 끝나면 그 점에서 누름을 뗀다([메서드](exposure.ko.md#메서드)). 여러 점에 걸친 제스처는 `sok input gesture`다 |
| `sok input gesture [window] [--pointer <name>] [--button left\|right] [--clicks <n>] --points <x>,<y>[;<x>,<y>]...` | 연결 하나로 native 제스처 하나를 보낸다: 첫 점에서 `down`, 뒤의 각 점으로 `drag`, 마지막 점에서 `up`이므로 점 하나는 click이다. 아무것도 출력하지 않고 전달된 `up` 뒤에 끝난다. 실패한 단계는 그 단계의 오류와 번호로 명령을 끝내고, 연결의 끝이 누름을 뗀다 |
| `sok input text [window] --phase mark\|insert\|unmark [--text <text>] [--selection <start>,<length>] [--replacement <start>,<length>]` | 조합의 한 단계를 key responder의 text input client에 준다(`input.text`) |
| `sok input key [window] --key <key> --phase down\|up [--text <text>] [--modifiers shift,control,option,command]` | Native key 입력을 보낸다 |
| `sok debug query [--channel <channel>] [--level <level>] [--class <class>] [--layer <layer>] [--event <name>] [--event-prefix <prefix>] [--surface <id>] [--session <id>] [--cid <id>] [--run <id>] [--text <text>] [--from <time>] [--to <time>] [--order asc\|desc] [--limit <n>] [--after <cursor>] [--around <cursor> [--earlier <n>] [--later <n>]]` | 설정 폴더의 event 파일에서 filter를 통과한 event의 page 하나를 파일의 색인으로 찾아 한 행에 한 줄의 글로 출력하고, 빠뜨린 schema 번호가 다른 파일을 표준 오류에 밝힌다([logging](logging.ko.md#질의), [debug](debug.ko.md#타임라인)). 실행 중인 애플리케이션이 필요 없다 |
| `sok debug replay <session> [--until <sequence>]` | 저장된 입력에서 해당 sidecar의 재생 실행 파일로 session의 화면을 다시 만들고, 저장된 sidecar와 page의 모든 hash를 재생한 hash와 비교해 첫 불일치를 session, 순번, 층을 이름으로 가진 `error` event로 보고하며 종료 상태 1로 끝난다([replay](replay.ko.md#명령)). 실행 중인 애플리케이션이 필요 없다 |
| `sok capture [window]` | 진단 build: 창에 focus를 주지 않고 정지 이미지를 쓴다 |
| `sok app update --wait <pid> --bundle <path> --target <path> [-- <argument>...]` | 프로세스 `<pid>`가 끝난 뒤 애플리케이션 번들 `<target>`을 `<bundle>`로 바꾸고 시작한다([애플리케이션 업데이트](installation.ko.md#애플리케이션-업데이트)) |
| `sok app relaunch --wait <pid> --target <path> [-- <argument>...]` | 프로세스 `<pid>`가 끝난 뒤 애플리케이션 번들 `<target>`을 인자와 함께 활성화하지 않고 다시 시작한다([진단 빌드](endpoint.ko.md#진단-빌드)) |
| `sok process wait <pid>` | 애플리케이션이나 service에 연결하지 않고 운영체제가 process ID의 종료를 보고할 때까지 기다린다 |
| `sok path install\|remove` | 이 애플리케이션의 경로 항목을 쓰거나 지운다. `install`은 파일과 그 안의 폴더를 출력한다 |
| `sok skill print\|install` | Agent skill을 표준 출력에 쓰거나, 있는 agent folder마다 그 skill 폴더에 쓴다([에이전트 skill](#에이전트-skill)) |
| `sok mcp [window]` | 애플리케이션의 엔드포인트를 표준 입출력의 MCP server로 agent에게 제공한다([MCP server](#mcp-server)) |
| `sok mcp install` | `sok mcp`를 `claude` 명령의 user scope에 등록한다([MCP 등록](#mcp-등록)) |
| `sok setup check` | Setup part마다 상태와 설치 단계를 출력하고 아무것도 바꾸지 않는다([setup part](#setup-part)) |
| `sok setup install [path\|skill\|mcp]...` | 지정한 종류의, 이름이 없으면 모든 종류의 빠진 setup part를 설치한다([setup part](#setup-part)) |
| `sok setup environment` | 자기 환경의 `{HOME, PATH, CLAUDE_CONFIG_DIR}`를 출력한다. Login shell의 환경을 읽는 host가 쓴다([애플리케이션 안의 에이전트](#애플리케이션-안의-에이전트)) |
| `sok plugin install\|update\|remove\|enable\|disable <id>` | 설치된 plugin을 바꾼다([설치](installation.ko.md)) |
| `sok plugin list` | 설치된 plugin을 나열한다 |
| `sok registry use <index>` | 설치가 읽는 registry index를 정한다 |
| `sok registry build <directory>` | Registry를 검증하고 그 `index.json`을 쓴다 |

선언된 command 이름에는 점이 있으므로(`core.card.split`, `terminal.input`) 위의 명령 단어와 겹치지 않는다.

## 창

`[window]`는 `--window <name>` 또는 `--project <directory>`다. `--project`는 둘을 canonical 경로로 바꾼 뒤, 열린 project 폴더가 그 폴더인 창을 고른다. 둘 다 없으면 창이 하나일 때 그 창을 쓰고, 여러 개면 실패하며 창 목록을 보인다.

## 매개변수

선언된 command의 flag는 고른 창에 대해 `exposure.list`가 보고하는 매개변수 schema에서 나온다. Surface가 등록하는 command는 `--surface`도 필요하다. 문자열 매개변수는 텍스트를, 숫자 매개변수는 유한한 숫자를, 정수 매개변수는 정수를, enum 매개변수는 그 값 중 하나를 받으며, boolean 매개변수는 참이면 `--<name>`, 거짓이면 `--<name>=false`다. 객체나 배열 매개변수는 JSON 텍스트를 받는다. Type이 목록인 매개변수는 나열된 type 중 하나를 받으며, 목록에 `null`이 있으면 텍스트 `null`은 null이다. Flag는 값을 `=` 뒤나 다음 인자로 받으므로, `--`로 시작하는 값은 `=` 뒤에 준다. `--params <json>`은 매개변수 객체 전체를 주며 매개변수 flag와 함께 쓸 수 없다. Schema가 선언하지 않은 flag나 schema와 맞지 않는 값은 command를 보내기 전에 실패한다.

## 출력과 종료 상태

명령은 결과를 표준 출력에 JSON으로 쓰며, 결과가 없는 명령은 `null`을 쓴다. 오류는 표준 오류에 `sok: <message>`로 쓰고, endpoint 오류 코드가 있으면 괄호 안에 함께 쓴다. 실패한 파일 작업은 파일과 소문자로 시작하는 운영체제 이유를 `<경로>: <이유>`로 적으며, 두 구현의 문구가 같다. 종료 상태는 성공 0, 실패한 명령 1, 사용법 오류 2이며, 사용법 오류는 사용법도 출력한다. sok이 오류를 표준 오류에 쓰지 못하면 종료 상태는 3이고, 명령이나 그 goroutine, thread가 panic하면 4이다([event log](#event-log)). 실패한 쓰기나 풀기 뒤의 정리가 실패하면 오류에 `; cleanup <path>: <reason>`을, 닫지 못한 임시 파일은 `; close <path>: <reason>`을 덧붙인다. 애플리케이션과의 연결을 닫지 못하면 `endpoint connection: <reason>`을 보고한다.

sok은 애플리케이션에 연결하기 전에 명령의 인자를 검사하므로, 사용법 오류는 endpoint 연결을 열지 않고 요청도 보내지 않는다.

`process wait`는 1부터 2147483647까지의 process ID를 반드시 받는다. 기다림에는 시간 제한이 없다. 운영체제가 PID가 없거나 종료 event가 발생했다고 보고하면 `{"pid": <pid>, "ended": true}`를 출력하고, `sok`이 받은 SIGINT나 SIGTERM은 exit 1, 표준 출력 없음, `process <pid> wait was interrupted by <SIGINT or SIGTERM>`으로 기다림을 끝낸다. 그래서 호출자는 `sok watch`를 끝내듯 signal로 기다림을 끝낸다. 지원하지 않는 process wait를 포함한 platform 오류는 명령 실패로 보고한다. 이 명령은 process ID를 기다리며, 임의의 PID 재사용을 넘어 process identity를 보장하지 않는다.

`process wait`는 `--help`와 `--config-dir` 밖의 option을 받지 않으며, `--timeout-ms` 같은 알 수 없는 option은 모든 명령에서처럼 exit 2로 끝난다. 이 명령은 다른 CLI 명령과 같은 option parser를 사용한다. 다른 boolean flag와 같이 반복한 `--help`는 같은 flag를 한 번 설정한 것처럼 처리하고, value option을 반복하면 거부한다.

## Event log

`sok`을 실행할 때마다 명령이 대상으로 삼는 설정 디렉터리에 자신의 event 파일 `logs/sok-<boot>.jsonl`을 쓴다. 대상은 명령을 해석하기 전에, 인자 `--` 앞에서만 읽는 `--config-dir`의 값이거나 애플리케이션의 기본 디렉터리다. `registry build`처럼 설정을 읽지 않는 명령도 기본 디렉터리에 기록한다. 파일은 층 `sok`으로 [event 계약](logging.ko.md)을 따르고, boot 식별자는 시작 시각(초)과 프로세스 식별자다. 도구는 `logs/`(mode 0700)와 파일(mode 0600, 새로 만듦)이 없으면 만든다. 파일은 level `error`, `warn`, `info`를 담고, level `debug`와 `trace`의 event(상태 0으로 끝나는 명령의 `sok.command`)는 `logs/sok-<boot>.debug.jsonl`에 있다. 도구는 이 파일을 첫 event와 함께 만들고 `log.open`으로 시작한다. 한 번의 실행이 저장하는 것은 다음과 같다.

- 첫 줄 `log.open`.
- 명령이 끝날 때 한 번 `sok.command`: 명령 단어(`name`), 공백으로 이은 인자(`args`), 실행의 마이크로초, `ok`, 종료 상태(`status`), 상태가 0이 아니면 표준 오류의 첫 줄(`error`). `args`와 `error`는 문자 경계에서 1024바이트로 자르고, 둘 중 하나라도 잘렸으면 event에 `truncated: true`가 붙는다. level은 `debug`이고, 상태가 0이 아니면 `warn`이다.
- `sok debug replay`가 저장된 hash와 재생한 hash가 다른 것을 찾으면 level `error`의 `sok.replay.divergence`: session, segment, 순번, 층, 기대한 hash와 찾은 hash([replay](replay.ko.md#명령)).
- panic이면 level `error`의 `sok.panic`: panic한 goroutine이나 thread(명령이면 `main`), panic의 글, panic 시점의 stack. 도구는 `sok: panic: <text>`와 stack을 표준 오류에 쓰고, event와 상태 4의 `sok.command`를 저장하고, 파일을 flush한 뒤 상태 4로 끝난다. 명령이 아닌 goroutine이나 thread의 panic도 같은 방식으로 프로세스를 끝낸다.

Go 도구의 모든 goroutine은 `Go`(`src/routine.go`)로, Rust 도구의 모든 thread는 `spawn_named`(`src/routine.rs`)로 시작한다. 이 둘이 도구에서 goroutine이나 thread를 시작하고 panic을 recover하는 유일한 곳이며, [event source check](logging.ko.md#event-sources)가 이를 요구한다. writer는 [상한](logging.ko.md#상한)의 한도를 가진 event 계약의 writer이고, 한 번의 실행이 저장하는 event는 위 몇 개뿐이므로 두 파일 모두 rotate하지 않는다. 만들 수 없는 폴더나 파일은 표준 오류에 `sok: event log: <path>: <reason>`로 보고하고, 명령은 기록 없이 실행되며 자기 종료 상태를 유지한다. 도구는 이 파일을 읽지 않으며, 읽는 쪽은 로그 감사와 사람뿐이다.

## Release, registry

이 명령들은 파일을 쓰며 실행 중인 애플리케이션이 필요 없다.



두 release는 gzip으로 압축한 tar 파일이다. `package.json`과 `files`의 모든 경로를 폴더 기준 상대 경로로 담으며, 폴더는 그 아래 파일까지 담는다. 항목은 경로 순서이고, 수정 시각 0, 소유자 0, mode 0644를 가지며 실행 bit가 있는 파일은 0755다. 나열한 경로가 없거나, 폴더 밖으로 나가거나, symbolic link이거나 그것을 담거나, 일반 파일도 폴더도 아닌 파일이면 명령은 실패하고 아무것도 쓰지 않는다. 두 구현은 같은 항목을 쓰지만 gzip stream이 다르므로, release의 `sha256`은 그것을 쓴 `sok`이 출력한 값이다.

`sok registry build <directory>`는 registry 폴더의 `plugins/<id>.json`, `sidecars/<file name>.json`, `packs/<name>.json`, `revoked.json`(`{ plugins, sidecars }`)을 읽는다. 각 파일은 [registry index](installation.ko.md#registry-index)의 항목 하나를 담고, 파일 이름은 항목과 맞는다. 명령은 항목을 하나의 index로 검사하고, 모든 release를 읽어 `sha256`을 비교하며, plugin release가 plugin id와 항목의 sidecar 범위를 `dependencies`로 가진 `plugin.json`, 항목의 `name`, version, `engines.soksak`을 가진 `package.json`을 담는지 검사한다. 모든 검사를 통과할 때만 각 목록을 id나 이름 순서로 정렬하고 두 칸 들여쓰기와 [registry index](installation.ko.md#registry-index) 표의 필드 순서로 `index.json`을 쓰므로 두 구현이 같은 byte를 쓰며, 파일은 한 번에 바꾼다. `plugins`, `sidecars`, `packs` 폴더가 없으면 항목이 없는 것이고, `revoked.json`이 없으면 build는 실패한다. 출력은 경로와 항목 수를 담은 `{ index, plugins, sidecars, packs }`이다.

## Plugin 설치

이 명령들은 설정 폴더의 [설치 배치](installation.ko.md#설치-배치) 파일을 바꾼다. 설정 폴더 하나에는 설치가 하나이므로, 두 명령이 동시에 그것을 바꾸면 안 된다.

`sok registry use <index>`는 경로, 절대 `file:` URL, `https:` URL([받기](installation.ko.md#받기))의 registry index를 읽어 검사하고 `plugins/registry.json`(`{ "format": 1, "index": "<URL>" }`)을 쓰며, 경로는 그 절대 `file:` URL이 된다. 출력은 `{ index }`다. 애플리케이션은 첫 실행에서 자기 `environment.json`의 registry를 정하고, 이 명령은 local registry 폴더 같은 다른 registry를 정한다.

`sok plugin install <id>`는 `plugins/registry.json`이 지정한 index와 `plugins/installed.json`(없으면 설치된 것이 없다)을 읽고, 이 `sok`의 core version과 실행 중인 플랫폼에 맞는 version을 고른 뒤([version 선택](installation.ko.md#version-선택)) 다음을 한다.

1. 아직 설치되지 않은 고른 release마다 읽어 `sha256`을 비교하고, 설치 경로 옆 임시 폴더에 푼 뒤 이름을 바꿔 제자리에 둔다.
2. `plugins/installed.json`을 한 번에 쓴다. Plugin은 version, `enabled: true`, 그 version의 sidecar 범위, 다른 version을 바꿀 때의 `previous`를 가진다. 고른 sidecar version을 담고, 어느 plugin도 지정하지 않은 sidecar는 담지 않는다.
3. 설치된 plugin의 쓰는 version과 `previous`가 아닌 모든 plugin 폴더와 version 폴더, `installed.json`이 지정하지 않은 모든 sidecar 폴더와 version 폴더를 지운다.

이미 고른 version으로 설치된 plugin은 바꾸지 않는다. 1단계나 2단계가 실패하면 `installed.json`은 그대로이고 그 단계를 보고한다. 3단계가 실패하면 지우지 못한 폴더를 보고한다. 풀기는 `..` 없는 상대 경로의 일반 파일과 폴더만 받고, 실행 bit가 있는 파일은 mode 0755, 그 밖에는 0644로 둔다. 1단계 전에 명령은 고른 각 version의 `plugin.json`을 [plugin release](installation.ko.md#plugin-release)의 규칙으로 검사한다. 거부되는 manifest는 위치와 reader의 문구로 명령을 실패시키며, 아무것도 바꾸지 않는다. 출력은 `{ plugin, sidecars }`이며, `installed.json`의 plugin 항목과 그것이 쓰는 sidecar version이다.

`sok plugin update <id>`는 설치된 plugin의 고른 version을 설치하며, 설치되지 않은 plugin이면 실패한다. `sok plugin remove <id>`는 `installed.json`에서 plugin을 지운 뒤 `plugins/<id>`와 `installed.json`이 더 이상 지정하지 않는 sidecar version 폴더를 지운다. `sok plugin enable <id>`와 `sok plugin disable <id>`는 `enabled`를 정한다. plugin을 설치하면 그 plugin 의존도 설치되고, 켜진 설치 plugin이 필요로 하는 plugin의 `remove`와 `disable`은 실패한다([version 선택](installation.ko.md#version-선택)). 이 셋은 plugin 항목을 출력하고, 제거 뒤에는 `null`을 출력한다. `sok plugin list`는 `installed.json`을 출력한다.

## 설치와 실행 중인 애플리케이션

Plugin과 sidecar 명령은 설정 폴더의 파일을 직접 바꾸므로 실행 중인 애플리케이션이 필요 없다. 실행 중인 애플리케이션은 그 변경을 관찰하지 않는다. 변경 뒤에 불러온 page가 새 plugin 목록을 읽고, 변경은 애플리케이션을 다시 시작할 때 적용된다([애플리케이션 안의 plugin 작업](installation.ko.md#애플리케이션-안의-plugin-작업)).

## 에이전트

Agent는 사람의 컴퓨터에서 사람을 위해 명령을 실행하고 도구를 호출하는 프로그램이다. Agent는 agent skill로 애플리케이션을 배우고, `sok`이나 MCP server `sok mcp`로 실행 중인 애플리케이션에 닿는다. 둘 다 자기 `sok`의 설정 폴더에 있는 [엔드포인트](endpoint.ko.md)를 읽는다. 세 종류의 setup part가 누구도 agent에게 알려 주지 않아도 이것을 가능하게 한다. `sok`을 `PATH`에 두는 경로 항목, agent skill, MCP 등록이다. `sok setup check`는 setup part마다 상태와 설치 단계를 보고하고, `sok setup install`은 빠진 것을 설치하며, 설정 창은 같은 part를 보여 준다([설정 창](settings.ko.md#에이전트)).

이 절의 명령은 환경에서 `HOME`, `PATH`, `CLAUDE_CONFIG_DIR`를 읽는다. `<home>`은 `HOME`의 값이고, 그것이 필요한 명령은 그 값이 없거나 비면 `HOME is not set`으로 실패한다. `<sok>`은 symbolic link를 푼 실행 중인 `sok`의 절대 경로다(Go `os.Executable`과 `filepath.EvalSymlinks`, Rust `std::env::current_exe`와 `std::fs::canonicalize`). 사람이 shell에 입력하는 단계에서 `<sok>`은 `A-Z`, `a-z`, `0-9`, `/`, `.`, `_`, `-`만 가지면 그대로 쓰고, 그렇지 않으면 작은따옴표 사이에 쓰며 경로의 작은따옴표 하나는 `'\''`로 쓴다.

### 에이전트 글

`packages/sok/agents/`는 agent가 읽는 글을 두 구현을 위해 한 벌로 담는다.

| 파일 | 내용 |
| --- | --- |
| `SKILL.md` | Agent skill([에이전트 skill](#에이전트-skill)) |
| `mcp.json` | `{instructions, tools}`: UTF-8로 4096 byte 이하인 MCP server의 instructions와, `tools/list` 순서의 각 도구의 `name`, `description`, `inputSchema`([MCP server](#mcp-server)) |

Rust `sok`은 이 폴더의 파일을 `include_str!`로 포함한다. Go `sok`은 `go:embed`가 embed하는 package의 폴더 아래 파일만 읽으므로 그 사본을 `packages/sok/go/src/`에 두고 embed한다. `cli.agents.copies-equal-the-sources`의 Go test가 각 사본을 원본과 비교하며, 이는 `make check-exposure`가 `packages/workbench-mygo`의 선언 사본을 원본과 같게 유지하는 것과 같다. 이 폴더는 package가 아니다. Manifest가 없고, 두 package의 test는 `docs/spec/cases`의 case를 읽듯 이것을 읽는다. 두 server는 library가 type에서 만드는 schema가 아니라 `mcp.json`의 input schema를 그대로 도구에 등록하므로 두 목록은 같은 JSON이다.

### 탐색

애플리케이션은 agent가 한 번에 읽을 수 있는 것보다 많은 command, status, element를 선언하고, 설치된 plugin마다 자기 것을 더한다([노출](exposure.ko.md#선언)). 그래서 agent는 필요한 항목을 필요할 때 실행 중인 애플리케이션의 노출에서 찾으며, 미리 쓴 목록에서 찾지 않는다. Plugin을 설치, 제거, 사용, 사용 안 함으로 바꾸면 창이 workbench를 다시 시작한 뒤 `exposure.list`가 바뀌고([변경 적용](installation.ko.md#변경-적용)), 다음 탐색은 바뀐 목록을 읽는다. 더는 선언되지 않은 항목의 요청은 그 이름을 밝히는 엔드포인트 오류로 실패한다.

Query의 각 단어가 항목의 이름이나 설명의 일부이면 query는 그 항목에 맞는다. 단어는 query에서 space, tab, 줄바꿈 사이의 부분이고, 빈 부분은 단어가 아니다. `A`부터 `Z`와 `a`부터 `z`는 대소문자를 가리지 않고 맞으며, 다른 모든 문자는 자기 자신에만 맞는다. 빈 query는 모든 항목에 맞는다. `sok exposures --query`와 `sok commands --query`는 맞는 항목을 `exposure.list`의 순서로 전체 선언과 함께 출력하고, MCP 도구 `exposure_search`도 같은 규칙을 쓴다.

### 에이전트 skill

Agent skill은 공유 skill 형식의 `packages/sok/agents/SKILL.md`다. 폴더 이름과 같은 `name: soksak`과, agent가 언제 그것을 쓰는지 밝히는 1024 Unicode scalar value 이하의 `description`을 담은 front matter 다음에 지시가 온다. Agent는 이름과 설명만 context에 두고, skill을 쓸 때 지시를 읽는다.

Skill은 정적이다. Command, status, element, plugin의 목록을 담지 않는다. 그런 목록은 plugin이 바뀐 뒤 낡고 읽기에 너무 길기 때문이다. 한 설치의 내용도 담지 않으므로 plugin이 바뀌어도 새 skill이 필요 없다. 모든 설치에 맞는 것을 담는다.

- soksak이 무엇인지, `sok`과 MCP 도구가 그 `sok`이 쓰는 설정 폴더의 실행 중인 애플리케이션에 닿는다는 것. MCP 도구는 MCP server가 등록된 agent에만 있고, `sok`은 어느 shell에서든 애플리케이션에 닿는다;
- 실행 중인 애플리케이션과 그 창을 찾는 법(`sok windows`, `windows_list`), 그리고 실행 중인 애플리케이션이 없을 때 요청은 엔드포인트 파일이 없다는 글로 실패한다는 것;
- 항목을 찾는 법([탐색](#탐색)): `sok commands --query`, `sok exposures --kind --query`, `exposure_search`, 그리고 쓰기 전에 항목 하나의 선언을 읽는 것(`exposure_describe`);
- schema의 매개변수로 command를 실행하는 법(`sok <command>`, `command_run`), status를 읽고 기다리는 법(`sok status`, `status_get`, `status_watch_once`), element에 동작하는 법(`sok element`, `element_rect`, `element_act`), 그리고 native 입력이 맞는 때(`sok input`, `input_pointer`, `input_key`, `input_text`);
- 실행 중인 애플리케이션 옆의 `sok plugin`은 거부되므로([설치](installation.ko.md#애플리케이션-안의-plugin-작업)) plugin은 실행 중인 애플리케이션의 선언된 command `core.plugins.*`로 바꾼다는 것;
- agent가 따르는 규칙: 선언된 command만 실행한다. command를 실행하기 전에 그 schema를 읽는다. 시간이 아니라 status를 기다린다. 수정된 탭 닫기, plugin 제거, 애플리케이션 종료처럼 사람의 작업을 없애는 변경은 먼저 사람에게 묻는다. 시스템 대화상자의 응답, 입력기를 위한 애플리케이션 활성화, 관리자 권한처럼 사람이 필요한 작업은 사람에게 묻고 우회하지 않는다. 오류는 그 글과 함께 사람에게 보고한다.

Agent가 읽을 때 skill은 명령을 실행하지 않는다. 모든 agent가 그것을 실행하지는 않고, 실패한 명령은 읽기를 끝내기 때문이다.

`sok skill print`는 skill 글을 덧붙이는 것 없이 표준 출력에 쓴다.

Agent folder는 이 순서로 `<home>/.claude`, 설정되어 비지 않았을 때의 `$CLAUDE_CONFIG_DIR`, `<home>/.agents`다. Agent folder는 symbolic link를 따라간 뒤 폴더이면 있는 것이다. 없는 agent folder는 사람이 쓰지 않는 agent의 것이다. Agent folder의 skill 파일은 `<agent folder>/skills/soksak/SKILL.md`이고, skill 폴더가 같은 canonical 폴더로 풀리는 두 agent folder는 skill 파일 하나를 가지며, 순서에서 처음 자리에 한 번 나열된다. Skill 파일은 그 byte가 실행 중인 `sok`의 skill 글과 같으면 최신이다.

`sok skill install`은 있는 agent folder마다 skill 파일을 쓰고, 하나도 없으면 아무것도 쓰지 않고 `no agent folder: neither <home>/.claude nor <home>/.agents is a directory; sok skill print writes the skill to standard output`로 실패한다. `CLAUDE_CONFIG_DIR`가 설정되어 있으면 그 글은 `<home>/.claude` 다음에 그 폴더를 밝힌다. 파일을 쓰기 전에 먼저 있는 agent folder마다 빠진 `skills`와 `skills/soksak` 폴더를 만든다(mode 0755). Agent는 session 시작 때 `skills` 폴더가 있었을 때만 실행 중인 session에서 그 폴더의 변경을 따르기 때문이다. 최신인 skill 파일은 그대로 둔다. 다른 파일은 같은 폴더에 고유한 이름으로 만든 임시 파일(Go `os.CreateTemp`, Rust `tempfile::NamedTempFile::new_in`과 `persist`)로 써서 mode 0644로 skill 파일 위에 rename한다. 그래서 읽는 쪽은 일부만 쓰인 skill을 읽지 않고, 동시에 쓰는 둘이 한 임시 파일에 쓰지 않는다. `{"skills": [{"file": <path>, "state": "written" | "current"}]}`를 출력한다. 쓰기에 실패하면 그 앞에 쓴 파일은 두고 `<path>: <reason>`로 실패하며 임시 파일을 지운다. 되풀이하면 모든 파일에 `current`를 출력하고 아무것도 쓰지 않는다.

Skill 글과 다른 skill 파일은 사람이 고친 것이라도 바꾼다. 그 파일은 `sok`의 것이고, 실행 중인 `sok`의 skill 글이 그것을 설명하기 때문이다. 글은 release로만 바뀌므로 다시 쓰기는 애플리케이션 업데이트를 따른다. 다른 release인 두 설치된 애플리케이션은 각자의 글을 쓰고, 마지막에 시작한 애플리케이션의 글이 남는다. 두 `skills` 폴더를 다 읽는 agent는 같은 이름에 같은 byte인 skill 둘을 읽으며, 둘은 같은 도구를 설명한다. Agent는 새 skill 파일을 그 뒤에 시작한 session에서 읽고, 어떤 agent는 실행 중인 session에서도 읽는다.

### MCP server

`sok mcp [window]`는 stdio MCP server다. 표준 입력에서 MCP message를 읽고, 표준 출력에는 한 줄에 JSON-RPC 2.0 message 하나씩 MCP message만 쓰며, 진단은 표준 오류에 쓴다. 네트워크 port를 열지 않는다. 각 구현은 그 언어의 공식 MCP library, Go는 `github.com/modelcontextprotocol/go-sdk`, Rust는 `rmcp`를 쓰고, library가 주는 protocol code를 쓰지 않는다. 둘 다 protocol revision `2026-07-28`과 `2025-11-25`에 답하고 다른 모든 revision을 거부한다. 이전 server와 같고, 계약 case가 message를 밝히는 revision이 이 둘이기 때문이다. Go server는 library가 그렇지 않으면 이전 revision에도 답하므로 `ServerOptions.SupportedProtocolVersions`를 이 둘로 정하고, Rust server는 pin한 `rmcp` release의 server option으로 같은 목록을 정한다. Case `mcp-protocol-2026-07-28`, `mcp-protocol-2025-11-25`, `mcp-protocol-unsupported`(`2025-06-18`의 요청)가 이것을 지킨다. Server 정보는 `{"name": "soksak", "version": <core version>}`이고, instructions는 `mcp.json`의 것이다. 도구가 닿는 곳, agent가 실행 전에 찾는다는 것, skill의 규칙을 짧게 담는다. Agent는 server의 instructions를 context에 두기 때문이다.

`sok mcp`는 시작할 때 첫 message를 읽기 전에 skill을 최신으로 만든다. 있는 agent folder마다 `sok skill install`처럼 skill 파일을 쓴다. 여기서 agent folder가 없는 것은 오류가 아니고, 쓰기 실패는 표준 오류에 `sok: skill: <path>: <reason>`로 쓰고 event log에 저장한다. 어느 경우든 server는 시작한다.

Server는 표준 입력이 열려 있는 동안, 실행 중인 애플리케이션이 없을 때와 애플리케이션이 끝나거나 다시 시작하는 동안에도 계속 응답한다. 엔드포인트가 필요한 첫 도구 호출에서 연결하고, 연결이 끝난 뒤의 다음 호출에서 다시 연결한다. 실행 중인 애플리케이션이 없을 때의 호출은 없는 엔드포인트 파일이나 실행 중이지 않은 process의 글을 담은 도구 오류이고, 다음 호출이 다시 시도한다. 호출의 창은 그 `window` 인자, 없으면 시작의 `[window]`(모든 명령처럼 `--window <name>`이나 `--project <directory>`), 없으면 `windows.list`의 key window, 없으면 그 첫 창이다.

도구는 고정된 집합이며, 노출로 만드는 도구는 없다.

| 도구 | 인자 | 엔드포인트 요청과 결과 |
| --- | --- | --- |
| `windows_list` | 없음 | `windows.list` |
| `exposure_search` | `window?`, `kind?`(`status`, `command`, `element`), `query?`, `offset?`, `limit?` | 그 창의 `exposure.list`. `{entries, total, next}`: 맞는 항목([탐색](#탐색))을 schema 없이 `{kind, name, description, registered}`로 `exposure.list` 순서에서 `offset`(기본 0)부터 최대 `limit`개(1부터 200, 기본 50), 맞는 항목의 수, 다음 page의 `offset` 또는 `null` |
| `exposure_describe` | `window?`, `kind`, `name` | 그 창의 `exposure.list`. 항목의 선언과 `registered`, 목록에 없는 이름은 도구 오류 `<kind> <name> is not declared` |
| `command_run` | `window?`, `surface?`, `name`, `params?` | `params`, 없으면 `{}`로 `command.run` |
| `status_get` | `window?`, `name`, `surface?` | `status.get` |
| `status_watch_once` | `window?`, `name`, `surface?`, `equals?` | `status.watch`, `status.get`, `status.unwatch`: 현재 값을 포함해 `equals`와 같은 값, `equals`가 없으면 다음 변경의 값. 시간 제한 없음 |
| `element_rect` | `window?`, `name`, `surface?`, `index?` | `element.rect` |
| `element_act` | `window?`, `name`, `surface?`, `index?`, `action`, `value?`, `event?` | `element.act` |
| `input_pointer` | `window?`, `x`, `y`, `phase`, `button?`, `deltaX?`, `deltaY?`, `clicks?`, `activate?` | `input.pointer` |
| `input_key` | `window?`, `key`, `text?`, `modifiers?`, `phase` | `input.key` |
| `input_text` | `window?`, `phase`, `text?`, `selection?`, `replacement?` | `input.text` |

`tools/list`는 엔드포인트 요청을 보내지 않고 `mcp.json`의 도구로 답한다. 결과는 엔드포인트 결과의 JSON 글이고, 결과가 없으면 `null`이다. 엔드포인트 오류, 끝난 연결, 세 목록이 없거나 `params` 없는 command를 담은 노출 목록은 `<message>` 글의 도구 오류이며, 엔드포인트 오류는 뒤에 ` (<code>)`가 붙는다. 탐색마다 실행 중인 애플리케이션의 `exposure.list`를 읽으므로 plugin 변경은 도구 목록의 변경 없이 다음 검색에서 agent에게 닿고, server는 `tools.listChanged`를 false로 선언한다.

`status_watch_once`의 watch는 그 호출의 것이다. Server는 기다리는 호출들을 위해 창, status, surface마다 엔드포인트 watch 하나를 두고, 그 마지막 호출이 끝나면 `status.unwatch`를 보낸다. Client가 취소한 호출은 결과 없이 끝나고 같은 방식으로 watch의 자기 몫을 끝낸다.

`docs/spec/cases/endpoint/`의 엔드포인트 case `mcp-*`는 server의 계약 case이고, 두 구현이 그것을 재생한다([검사](endpoint.ko.md#검사)). 이 도구 집합에 맞춰 바뀐다. `mcp-tools-list`는 window 없는 `exposure_search`의 엔드포인트 요청(`windows.list` 다음 `exposure.list`)인 `mcp-exposure-search`가 된다. `mcp-exposure-without-element`와 `mcp-exposure-without-params`는 `exposure_search`와 `exposure_describe`가 거부하는 응답을 밝힌다. `mcp-tools-call`은 같은 `command.run` frame의 command를 `command_run`으로 보낸다. 새 `mcp-watch-shared`는 한 status의 두 기다림을 한 watch에 둔다. `mcp-reconnect`는 엔드포인트 파일 없이도 시작한다. 다른 case는 frame을 그대로 두고 client로 `sok mcp`를 밝힌다.

### MCP 등록

MCP 등록은 `claude` 명령의 user scope에 있는 항목 `soksak`이고, `claude` 명령이 `PATH`에 있을 때 해당한다. 그 파일은 실행 환경에서 그 명령의 설정 파일이다. `CLAUDE_CONFIG_DIR`가 설정되어 비지 않았으면 `$CLAUDE_CONFIG_DIR/.claude.json`, 아니면 `<home>/.claude.json`이다. 없는 파일에는 등록이 없고, parse되지 않는 파일은 `<file>: <reason>`로 실패한다. 파일의 `mcpServers.soksak`이 `type` `"stdio"`, `command` `<sok>`, `args` `["mcp"]`를 가지고 `env`가 없거나 빈 object이면 등록은 최신이다. 그 파일은 다른 프로그램의 설정이다. `claude` 명령은 server를 시작하지 않고는 등록을 답하지 않으므로, `sok`은 그 파일의 `mcpServers.soksak`만 읽고, 파일은 `claude` 명령으로만 바꾼다.

`sok mcp install`은 등록을 읽고,

- 최신 등록이 있으면 아무것도 바꾸지 않고 `{"registration": <entry>, "state": "current"}`를 출력한다;
- 다른 등록이 있으면 `claude mcp remove --scope user soksak`을 실행한 다음 `claude mcp add --scope user soksak -- <sok> mcp`를 실행하고, 등록이 없으면 두 번째만 실행한다. 그 뒤 파일을 다시 읽어 등록이 최신이면 `{"registration": <entry>, "state": "registered"}`를 출력하고, 아니면 `claude mcp add did not write the registration to <file>`로 실패한다.

0이 아닌 상태로 끝난 `claude` 명령은 설치를 `claude mcp <add or remove> failed with status <n>: <first line of its standard error>`로 실패시킨다. Remove 뒤에 실패한 add는 `; the earlier registration <command> was removed`를 덧붙인다. `PATH`에 `claude` 명령이 없으면 설치는 `the claude command is not on PATH; register the MCP server "<sok> mcp" (standard input and output) with the agent`로 실패하고 아무것도 바꾸지 않는다. 등록은 `sok` 하나를 가리키므로 애플리케이션 하나의 설정 폴더에 닿는다. 실행 중인 agent session은 session 중에 등록된 server를 다음 session에서야 시작한다.

`<sok>`은 실행보다 오래 남아야 한다. 읽기 전용 disk image나, 사람이 옮기지 않은 내려받은 애플리케이션을 시스템이 실행하는 읽기 전용 mount(App Translocation)처럼 읽기 전용으로 mount된 volume의 `sok`은 `sok mcp install`과 `sok path install`이 `<sok> is on a read-only volume; move the application to a folder such as /Applications and start it again`로 거부한다. `<sok>`의 file system의 읽기 전용 flag가 정한다. Go는 두 platform에서 `golang.org/x/sys/unix.Statfs`를 읽고 `Flags`를 macOS에서는 `unix.MNT_RDONLY`로, Linux에서는 그 package가 정의하지 않는 kernel의 `ST_RDONLY`와 값이 같은 `unix.MS_RDONLY`로 검사한다. Rust는 `rustix::fs::statvfs`를 읽고 `StatVfsMountFlags::RDONLY`를 검사한다.

### Setup part

| Part | 해당 | 파일 | 최신인 때 | 설치 단계 |
| --- | --- | --- | --- | --- |
| `path` | 경로 항목 폴더가 있는 platform | `/etc/paths.d/<application identifier>` | 내용이 `sok path install`이 `<sok>`에 대해 쓰는 내용이다 | `sudo <sok> path install` |
| `skill` | 있는 agent folder마다 | `<agent folder>/skills/soksak/SKILL.md` | byte가 skill 글과 같다 | `<sok> skill install` |
| `mcp` | `claude` 명령이 `PATH`에 있을 때 | `claude` 명령의 설정 파일 | 등록이 최신이다 | `<sok> mcp install` |

`sok setup check`는 `{"parts": [{part, file, state, step, reason?, command?, error?}]}`를 이 member 순서로, part는 표의 순서로, skill 파일은 agent folder의 순서로 출력한다. `state`는 `ok`, `missing`, `error`다. 빠진 part는 `reason`을 가진다. 없는 파일이나 등록은 `absent`, 설치가 쓰는 것과 다른 것은 `differs`, `command`가 다른 설치된 애플리케이션의 `sok`인 등록은 `other`이고 그때 `command`가 그것을 밝힌다. 다른 애플리케이션의 `sok`은 `<sok>`이 아닌 절대 경로로, macOS에서는 이름이 `.app`으로 끝나는 폴더의 `Contents/MacOS`에 있는 실행 가능한 일반 파일 `sok`, Linux에서는 실행 가능한 일반 파일 `sok`이다. 최신이 아닌 다른 모든 등록은 `differs`다. 상태를 읽을 수 없는 part는 실패의 글인 `error`를 가진다. 해당하지 않는 part는 나열하지 않는다. Linux에는 `path` part가 없다. 이 명령은 아무것도 바꾸지 않으며, 나열된 모든 part가 `ok`이면 0으로, 아니면 표준 출력의 JSON 뒤에 표준 오류에 `sok: setup parts are not current: <part> <file>, ...`를 쓰고 1로 끝난다.

`sok setup install`은 지정한 종류의, 이름이 없으면 모든 종류의 `ok`가 아닌 나열된 part를 각자의 명령의 규칙으로 설치하고, `ok`인 part는 그대로 둔다. 빠진 경로 항목은 관리자 권한이 필요하지만 skill 파일과 등록은 사람의 것이다. 이 명령은 다른 사용자로 실행되지 않으며, 표준 입력이 terminal이면 `sudo <sok> path install`을 child로 실행해 거기서 password를 묻고, 그렇지 않으면 경로 항목을 빠진 채로 둔다. 설치 뒤의 part를 `sok setup check`처럼 출력하며, 각 part는 자기가 바꾸었으면 true인 `changed`를 가진다. 나열된 모든 part가 `ok`이면 0으로, 아니면 `sok: setup parts are not current: <part> <file>, ...`와 설치에 실패한 part마다 그 오류를 쓰고 1로 끝난다. 되풀이해도 아무것도 바꾸지 않는다.

### 애플리케이션 안의 에이전트

Host는 plugin 작업을 실행하듯([애플리케이션 안의 plugin 작업](installation.ko.md#애플리케이션-안의-plugin-작업)) setup 작업을 command line(`packages/sok`)의 setup library로 실행한다. 그래서 애플리케이션과 `sok setup`은 같은 code로 같은 파일을 읽고 바꾼다. `<sok>`은 애플리케이션 bundle의 `sok`이다.

시스템이 애플리케이션을 위해 시작한 process는 사람의 shell이 아니라 session의 환경을 받으므로, 그 `PATH`에는 shell이 더하는 폴더가 없고 거기서 `claude` 명령을 찾지 못한다. 그래서 host는 host 시작마다 한 번 사람의 login shell, 곧 사용자 database(`getpwuid`)의 shell의 환경을 읽는다. `<shell> -l -i -c <sok> setup environment`를 실행하며, `<sok>`은 단계의 규칙으로 따옴표를 붙이고 명령은 인자 하나로 준다. 이 shell은 자기 process group(Go `Setpgid`, Rust `process_group(0)`)에서 표준 입력을 `/dev/null`로 하여 실행한다. `sok setup environment`가 출력한 JSON 줄의 `HOME`, `PATH`, `CLAUDE_CONFIG_DIR`를 setup library에 주므로 사람의 shell 문법은 관여하지 않는다. 읽기는 출력의 끝이나 shell의 끝이 아니라 그 줄이 표준 출력에 도착할 때 끝난다. Shell의 시작 파일이 시작한 process가 출력을 열어 둘 수 있기 때문이다. 그 뒤 host는 process group을 끝내며, 다른 모든 결과에서도 끝낸다. 표준 출력과 표준 오류는 따로 읽고, 줄 앞에 나온 시작 파일의 출력은 버린다. 줄 앞에 끝난 shell은 setup 작업을 `login shell <shell>: <reason>`로 실패시키며, reason은 종료 상태와 표준 오류의 첫 줄이다. 10 s 안에 줄을 주지 않은 shell은 `login shell <shell>: no environment within 10 s`로 실패시킨다. 입력을 기다리는 shell에는 그것을 끝내는 event가 없기 때문이다. 읽기는 시작 경로가 아니라 첫 창이 시작한 뒤에 실행된다. Agent session 하나의 환경은 login shell과 다를 수 있다. 예를 들어 session이 `CLAUDE_CONFIG_DIR`를 정할 수 있다. 설정 창은 login shell 환경의 part를 보여 주고, session 안의 `sok setup`은 그 session의 part를 보여 준다.

환경을 읽은 뒤 host는 `sok mcp`처럼 skill을 최신으로 만들고, 실패한 쓰기는 파일과 이유와 함께 오류 `host.setup.skill`로 기록한다. 경로 항목과 등록은 설치하지 않는다. 그것은 사람의 시스템과 agent의 설정을 바꾸므로 사람이 요청할 때만 한다.

| Host call 또는 event | 뜻 |
| --- | --- |
| `setupState()` | 환경을 읽은 뒤, `sok setup check`가 출력하는 `{parts}`를 돌려준다 |
| `setupInstall({parts})` | 지정한 종류의 `skill`과 `mcp`를 `sok setup install`처럼 설치하고 그 `{parts}`를 돌려준다. 애플리케이션에는 `sudo`를 위한 terminal이 없으므로 `path`는 `the path entry needs administrator rights: run <step> in a terminal`로 거부한다. Host는 setup 작업을 한 번에 하나 실행하고, 다른 것은 `another setup operation is running`으로 거부한다 |
| `setup-changed` | `setupInstall` 뒤와 시작 시 skill 쓰기 뒤에 모든 창에 값 없이 보낸다. 그래서 모든 창이 part를 다시 읽는다 |

### 결정

- Skill은 정적이다. `exposure.list`에서의 탐색이 요청 시점에 설치된 모든 plugin을 덮으므로, 한 설치의 내용은 노출의 두 번째 낡은 사본이 되고 plugin이 바뀔 때마다 쓰는 쪽이 필요하다. Skill은 `sok`의 release로만 바뀐다.
- MCP 도구는 선언된 command마다 도구 하나가 아니라, 이름과 schema가 안정된 고정 집합과 검색, 설명 도구다. Core 선언만으로 command 115개, status 36개, element 150개이고, host와 plugin 항목 전에 이전 server가 만든 방식의 도구 목록이 약 60 KB다. 그 크기의 도구 목록은 모든 session에서 agent의 context를 차지하고, 도구 선택을 떨어뜨리며, plugin이 바뀔 때마다 낡는다. 바뀐 도구 목록은 `notifications/tools/list_changed`를 따르는 client를 통해서만 실행 중인 session에 닿는데, 모든 client가 그렇지는 않고, 노출 변경의 엔드포인트 event도 없다. 고정 도구는 호출마다 노출을 읽으므로 plugin 변경에 알림이 필요 없고, 검색 결과는 작은 page로 남는다.
- Agent 글은 원본 폴더 하나와 검사되는 Go 사본으로 둔다. `go:embed`는 그 package의 폴더 밖을 읽지 못하고, Rust package는 Go package의 파일을 읽지 않기 때문이다.
- `sok setup install`은 terminal의 `sudo`로만 관리자 권한을 얻는다. 그래서 skill 파일과 등록은 관리자 계정이 아니라 사람이 쓴다. 애플리케이션은 경로 항목의 단계를 실행하지 않고 보여 준다.
- 등록은 그 설정 파일을 가진 `claude` 명령으로만 쓴다. `sok`은 등록이 최신인지 판단하려고만 그 파일을 읽고, `sok`이 읽지 못하는 그 파일의 형식은 파일을 밝히는 오류다.
- 설정 창의 setup 상태는 그룹을 보여 줄 때, 창이 key window가 될 때(`window-active`), `setup-changed` 뒤, `core.setup.check`로 읽으며, 파일을 감시하지 않는다. `claude` 명령의 설정 파일은 agent session마다 다시 쓰이고, 상태는 사람이 볼 때 중요하기 때문이다.

이 계약의 검토는 다음 반론에 답했다.

- 등록 이름 하나는 한 번에 애플리케이션 하나를 위한다. 애플리케이션은 스스로 등록하지 않으므로 설치된 두 애플리케이션이 서로의 등록을 가져가지 않는다. 검사는 다른 애플리케이션의 등록을 `other`로 보고하고, 설정 창의 버튼은 그것을 바꾼다고 밝힌다.
- Agent session은 `CLAUDE_CONFIG_DIR`를 정할 수 있으므로, agent folder는 `<home>/.claude`와 그 폴더를 둘 다 받고 canonical skill 폴더마다 skill 파일 하나를 두며, 등록 파일은 실행 환경의 것이다.
- 여럿이 동시에 skill을 최신으로 만들 수 있으므로(모든 agent session이 `sok mcp`를 시작한다), 각자는 고유한 이름의 임시 파일과 rename으로 쓴다.
- Library는 type에서 schema를 다른 형태로 만들므로, 도구 목록은 두 server가 그 schema를 그대로 등록하는 JSON 파일 하나다.
- Go의 library는 목록을 받지 않으면 이전 revision에도 답하므로, 두 server는 case의 두 revision을 받는다.
- 출력한 뒤 기다리거나 background process가 출력을 잡는 login shell은 스스로 읽기를 끝내지 않으므로, 읽기는 JSON 줄이나 한도에서 끝나고 host가 shell의 process group을 끝낸다.
- 읽기 전용 mount의 `sok`은 실행 뒤 사라지므로, 그 경로를 쓰는 설치는 그것을 거부한다. 검사는 file system의 읽기 전용 flag를 Go에서는 `statfs`로, Rust에서는 `statvfs`로 읽는다.
- `claude` 명령의 설정 파일 감시는 agent session마다 그 파일을 다시 쓰므로 거부했다. 상태는 사람이 볼 때 읽는다.
- `claude` 명령의 local이나 project scope의 `soksak` 항목은 검사가 갖지 않은 작업 폴더에 달려 있으므로 검사하지 않는다.
- Load 중인 창은 1003으로 답하고 도구 오류가 그것을 전하므로, 도구에는 자기 준비 규칙이 필요 없다.
