# Command line `sok`

[English](cli.md)

`sok`은 soksak 애플리케이션의 command line이며, 모든 명령을 이것으로 공개한다. 두 package가 한 계약으로 이것을 구현한다. Tauri 애플리케이션용 Rust `packages/sok/tauriv2`와 Wails 애플리케이션용 Go `packages/sok/wailsv3`이다([hosts](hosts.ko.md#command-line-트리)). 두 package는 애플리케이션 framework를 link하지 않는다. 각 애플리케이션 bundle은 실행 파일 옆에 자기 `sok`을 담고(macOS에서는 `Contents/MacOS/sok`), host는 설정 창의 plugin 명령에 그 `sok`을 실행하므로 언어마다 설치 구현은 하나다. `sok`은 `--config-dir`가 다른 폴더를 지정하지 않으면 자신이 속한 애플리케이션의 설정 폴더(`app.soksak.tauri` 또는 `app.soksak.wails`, 진단 빌드는 `.dev`를 붙인다. [projects](projects.ko.md#저장) 참조)를 쓴다. 그래서 `PATH`가 닿는 `sok`이 구현과 설정 폴더를 정한다. `PATH`는 bundle의 실행 파일 폴더를 담은 경로 항목 `/etc/paths.d/<application identifier>`로 bundle에 닿는다. `sok path install`은 그것을 실행한 `sok`의 항목을 쓰고 `sok path remove`는 지운다. 둘 다 관리자 권한(`sudo`)이 필요하고, 되풀이해도 결과가 같으며, 쓰기에 실패하면 파일과 이유를 보고한다. 새 shell이 항목을 읽는다. Command line은 symbolic link를 쓰지 않는다.

## 운영체제

`sok`은 macOS와 Linux에서 실행된다. platform key는 `arm64`나 `x64`를 쓴 `<os>-<arch>`다([설치](installation.ko.md)). Linux에서 설정 폴더는 `$XDG_CONFIG_HOME` 아래, 그것이 없으면 `~/.config` 아래의 애플리케이션 식별자이고, 엔드포인트는 macOS처럼 Unix socket이다([엔드포인트](endpoint.ko.md)). Linux에는 경로 항목 폴더가 없으므로 `sok path install`과 `sok path remove`는 거기서 `path entries are not implemented on linux`로 실패한다. Windows에서는 platform interface의 모든 동작이 `<operation> is not implemented on windows`로 실패한다.

## 명령

| 명령 | 동작 |
| --- | --- |
| `sok <command> [window] [--surface <id>] [--<parameter> <value>]... [--params <json>]` | 실행 중인 애플리케이션에서 core나 plugin이 선언한 command를 [endpoint](endpoint.ko.md) method `command.run`으로 실행한다 |
| `sok commands [window]` | `exposure.list`의 `commands` 목록을 출력한다. 선언된 command마다 설명, 매개변수 schema, 결과 schema다 |
| `sok windows` | 실행 중인 애플리케이션의 창을 나열한다 |
| `sok exposures [window]` | 선언된 모든 status, command, DOM 항목을 나열한다 |
| `sok status <name> [window] [--surface <id>] [--watch]` | Status 값을 출력한다. `--watch`는 값과 이후 바뀔 때마다 JSON 한 줄씩 출력한다 |
| `sok dom rect\|click\|input\|dispatch <name> [window] [--surface <id>] [--index <n>] [--value <text>] [--event <json>]` | 선언된 DOM 항목에 동작한다 |
| `sok input pointer [window] --x <x> --y <y> --phase move\|down\|drag\|up\|scroll [--button left\|right] [--delta-x <n>] [--delta-y <n>] [--activate]` | Native pointer 입력을 보낸다 |
| `sok input key [window] --key <key> --phase down\|up [--text <text>] [--modifiers shift,control,option,command]` | Native key 입력을 보낸다 |
| `sok capture [window]` | 진단 build: 창에 focus를 주지 않고 정지 이미지를 쓴다 |
| `sok path install\|remove` | 이 애플리케이션의 경로 항목을 쓰거나 지운다. `install`은 파일과 그 안의 폴더를 출력한다 |
| `sok plugin install\|update\|remove\|enable\|disable <id>` | 설치된 plugin을 바꾼다([설치](installation.ko.md)) |
| `sok plugin list` | 설치된 plugin을 나열한다 |
| `sok registry use <index>` | 설치가 읽는 registry index를 정한다 |
| `sok plugin pack <directory> <output directory> [--diagnostics]` | plugin release `<id>-<version>.tgz`를 쓴다. `--diagnostics`는 plugin의 진단 선언을 더한다 |
| `sok sidecar release <directory> <output directory> [--platform <platform>]` | Sidecar release를 쓰고 `SHA256SUMS`를 갱신한다 |
| `sok registry build <directory>` | Registry를 검증하고 그 `index.json`을 쓴다 |

선언된 command 이름에는 점이 있으므로(`core.card.split`, `terminal.input`) 위의 명령 단어와 겹치지 않는다.

## 창

`[window]`는 `--window <name>` 또는 `--project <directory>`다. `--project`는 둘을 canonical 경로로 바꾼 뒤, 열린 project 폴더가 그 폴더인 창을 고른다. 둘 다 없으면 창이 하나일 때 그 창을 쓰고, 여러 개면 실패하며 창 목록을 보인다.

## 매개변수

선언된 command의 flag는 고른 창에 대해 `exposure.list`가 보고하는 매개변수 schema에서 나온다. Surface가 등록하는 command는 `--surface`도 필요하다. 문자열 매개변수는 텍스트를, 숫자 매개변수는 유한한 숫자를, 정수 매개변수는 정수를, enum 매개변수는 그 값 중 하나를 받으며, boolean 매개변수는 참이면 `--<name>`, 거짓이면 `--<name>=false`다. 객체나 배열 매개변수는 JSON 텍스트를 받는다. Type이 목록인 매개변수는 나열된 type 중 하나를 받으며, 목록에 `null`이 있으면 텍스트 `null`은 null이다. Flag는 값을 `=` 뒤나 다음 인자로 받으므로, `--`로 시작하는 값은 `=` 뒤에 준다. `--params <json>`은 매개변수 객체 전체를 주며 매개변수 flag와 함께 쓸 수 없다. Schema가 선언하지 않은 flag나 schema와 맞지 않는 값은 command를 보내기 전에 실패한다.

## 출력과 종료 상태

명령은 결과를 표준 출력에 JSON으로 쓰며, 결과가 없는 명령은 `null`을 쓴다. 오류는 표준 오류에 `sok: <message>`로 쓰고, endpoint 오류 코드가 있으면 괄호 안에 함께 쓴다. 실패한 파일 작업은 파일과 소문자로 시작하는 운영체제 이유를 `<경로>: <이유>`로 적으며, 두 구현의 문구가 같다. 종료 상태는 성공 0, 실패한 명령 1, 사용법 오류 2이며, 사용법 오류는 사용법도 출력한다. sok이 오류를 표준 오류에 쓰지 못하면 종료 상태는 3이다. 실패한 쓰기나 풀기 뒤의 정리가 실패하면 오류에 `; cleanup <path>: <reason>`을, 닫지 못한 임시 파일은 `; close <path>: <reason>`을 덧붙인다. 애플리케이션과의 연결을 닫지 못하면 `endpoint connection: <reason>`을 보고한다.

## Package, release, registry

이 명령들은 파일을 쓰며 실행 중인 애플리케이션이 필요 없다.

`sok plugin pack <directory> <output directory>`는 plugin 폴더의 `package.json`과 `plugin.json`을 읽고, [plugin release](installation.ko.md#plugin-release)과 `plugin.json`의 `dependencies`를 검사한 뒤 `<id>-<version>.tgz`를 쓴다. `<id>`는 `plugin.json`의 `id`다. `plugin.json`의 surface module, section module, state module이 `files`가 나열한 경로 안에 없거나, `files`가 `diagnostics.json`이나 `diagnostics.json`이 지정한 `module`을 나열하면 실패한다([진단 선언](plugins.ko.md#진단-선언)). `--diagnostics`를 주고 `diagnostics.json`이 폴더 안의 존재하는 JavaScript module을 지정하면, release는 `diagnostics.json`과 그 module도 담는다. 이 진단 package는 진단 build와 window check용이다. 출력은 절대 release 경로를 담은 `{ id, version, archive, sha256 }`이다.

`sok sidecar release <directory> <output directory> [--platform <platform>]`는 sidecar 폴더의 `package.json`과 `sidecar.json`을 읽고, `package.json`에 package `name`, `version`, 그리고 `sidecar.json`과 `sidecar.json`의 `executable`을 나열한 `files`가 있는지 검사한 뒤 [release](installation.ko.md#sidecar-release) `<file name>-<version>-<platform>.tar.gz`를 쓴다. `--platform`이 다른 플랫폼을 지정하지 않으면 플랫폼은 `sok`이 실행되는 플랫폼이다. `sok`은 파일 내용을 보지 않으므로, 다른 플랫폼을 지정하면 그 플랫폼용으로 build한 파일에 이름을 붙이는 것이다. 그다음 출력 폴더에 `SHA256SUMS`를 쓴다. Release마다 `<sha256>  <archive name>` 한 줄이며 release 이름 순서이고, 같은 이름의 release 줄은 바꾼다. Release를 쓰기 전에 `SHA256SUMS`를 읽으므로, 형식이 틀린 파일이면 아무것도 쓰지 않고 실패한다. 출력은 `{ name, version, platform, archive, sha256 }`이다.

두 release는 gzip으로 압축한 tar 파일이다. `package.json`과 `files`의 모든 경로를 폴더 기준 상대 경로로 담으며, 폴더는 그 아래 파일까지 담는다. 항목은 경로 순서이고, 수정 시각 0, 소유자 0, mode 0644를 가지며 실행 bit가 있는 파일은 0755다. 나열한 경로가 없거나, 폴더 밖으로 나가거나, symbolic link이거나 그것을 담거나, 일반 파일도 폴더도 아닌 파일이면 명령은 실패하고 아무것도 쓰지 않는다. 두 구현은 같은 항목을 쓰지만 gzip stream이 다르므로, release의 `sha256`은 그것을 쓴 `sok`이 출력한 값이다.

`sok registry build <directory>`는 registry 폴더의 `plugins/<id>.json`, `sidecars/<file name>.json`, `packs/<name>.json`, `revoked.json`(`{ plugins, sidecars }`)을 읽는다. 각 파일은 [registry index](installation.ko.md#registry-index)의 항목 하나를 담고, 파일 이름은 항목과 맞는다. 명령은 항목을 하나의 index로 검사하고, 모든 release를 읽어 `sha256`을 비교하며, plugin release가 plugin id와 항목의 sidecar 범위를 `dependencies`로 가진 `plugin.json`, 항목의 package 이름, version, `engines.soksak`을 가진 `package.json`을 담는지 검사한다. 모든 검사를 통과할 때만 각 목록을 id나 이름 순서로 정렬하고 두 칸 들여쓰기와 [registry index](installation.ko.md#registry-index) 표의 필드 순서로 `index.json`을 쓰므로 두 구현이 같은 byte를 쓰며, 파일은 한 번에 바꾼다. `plugins`, `sidecars`, `packs` 폴더가 없으면 항목이 없는 것이고, `revoked.json`이 없으면 build는 실패한다. 출력은 경로와 항목 수를 담은 `{ index, plugins, sidecars, packs }`이다.

## Plugin 설치

이 명령들은 설정 폴더의 [설치 배치](installation.ko.md#설치-배치) 파일을 바꾼다. 설정 폴더 하나에는 설치가 하나이므로, 두 명령이 동시에 그것을 바꾸면 안 된다.

`sok registry use <index>`는 경로, 절대 `file:` URL, `https:` URL([받기](installation.ko.md#받기))의 registry index를 읽어 검사하고 `plugins/registry.json`(`{ "format": 1, "index": "<URL>" }`)을 쓰며, 경로는 그 절대 `file:` URL이 된다. 출력은 `{ index }`다. 애플리케이션은 첫 실행에서 자기 `environment.json`의 registry를 정하고, 이 명령은 local registry 폴더 같은 다른 registry를 정한다.

`sok plugin install <id>`는 `plugins/registry.json`이 지정한 index와 `plugins/installed.json`(없으면 설치된 것이 없다)을 읽고, 이 `sok`의 core version과 실행 중인 플랫폼에 맞는 version을 고른 뒤([version 선택](installation.ko.md#version-선택)) 다음을 한다.

1. 아직 설치되지 않은 고른 release마다 읽어 `sha256`을 비교하고, 설치 경로 옆 임시 폴더에 푼 뒤 이름을 바꿔 제자리에 둔다.
2. `plugins/installed.json`을 한 번에 쓴다. Plugin은 package, version, `enabled: true`, 그 version의 sidecar 범위, 다른 version을 바꿀 때의 `previous`를 가진다. 고른 sidecar version을 담고, 어느 plugin도 지정하지 않은 sidecar는 담지 않는다.
3. 설치된 plugin의 쓰는 version과 `previous`가 아닌 모든 plugin 폴더와 version 폴더, `installed.json`이 지정하지 않은 모든 sidecar 폴더와 version 폴더를 지운다.

이미 고른 version으로 설치된 plugin은 바꾸지 않는다. 1단계나 2단계가 실패하면 `installed.json`은 그대로이고 그 단계를 보고한다. 3단계가 실패하면 지우지 못한 폴더를 보고한다. 풀기는 `..` 없는 상대 경로의 일반 파일과 폴더만 받고, 실행 bit가 있는 파일은 mode 0755, 그 밖에는 0644로 둔다. 출력은 `{ plugin, sidecars }`이며, `installed.json`의 plugin 항목과 그것이 쓰는 sidecar version이다.

`sok plugin update <id>`는 설치된 plugin의 고른 version을 설치하며, 설치되지 않은 plugin이면 실패한다. `sok plugin remove <id>`는 `installed.json`에서 plugin을 지운 뒤 `plugins/<id>`와 `installed.json`이 더 이상 지정하지 않는 sidecar version 폴더를 지운다. `sok plugin enable <id>`와 `sok plugin disable <id>`는 `enabled`를 정한다. plugin을 설치하면 그 plugin 의존도 설치되고, 켜진 설치 plugin이 필요로 하는 plugin의 `remove`와 `disable`은 실패한다([version 선택](installation.ko.md#version-선택)). 이 셋은 plugin 항목을 출력하고, 제거 뒤에는 `null`을 출력한다. `sok plugin list`는 `installed.json`을 출력한다.

## 설치와 실행 중인 애플리케이션

Plugin과 sidecar 명령은 설정 폴더의 파일을 직접 바꾸므로 실행 중인 애플리케이션이 필요 없다. 실행 중인 애플리케이션은 그 변경을 관찰하지 않는다. 변경 뒤에 불러온 page가 새 plugin 목록을 읽고, 변경은 애플리케이션을 다시 시작할 때 적용된다([애플리케이션 안의 plugin 작업](installation.ko.md#애플리케이션-안의-plugin-작업)).
