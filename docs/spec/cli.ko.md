# Command line `sok`

[English](cli.md)

`sok`은 soksak 애플리케이션의 command line이며, 모든 명령을 이것으로 공개한다. 두 package가 한 계약으로 이것을 구현한다. Tauri 애플리케이션용 Rust `packages/sok/tauriv2`와 Wails 애플리케이션용 Go `packages/sok/wailsv3`이다([hosts](hosts.ko.md#command-line-트리)). 두 package는 애플리케이션 framework를 link하지 않는다. 각 애플리케이션 bundle은 실행 파일 옆에 자기 `sok`을 담고(macOS에서는 `Contents/MacOS/sok`), host는 설정 창의 plugin 명령에 그 `sok`을 실행하므로 언어마다 설치 구현은 하나다. `sok`은 `--config-dir`가 다른 폴더를 지정하지 않으면 자신이 속한 애플리케이션의 설정 폴더(`com.soksak.tauri` 또는 `com.soksak.wails`, [projects](projects.ko.md) 참조)를 쓴다. 그래서 `PATH`가 닿는 `sok`이 구현과 설정 폴더를 정한다. `PATH`는 bundle의 실행 파일 폴더를 담은 경로 항목 `/etc/paths.d/<application identifier>`로 bundle에 닿는다. `sok path install`은 그것을 실행한 `sok`의 항목을 쓰고 `sok path remove`는 지운다. 둘 다 관리자 권한(`sudo`)이 필요하고, 되풀이해도 결과가 같으며, 쓰기에 실패하면 파일과 이유를 보고한다. 새 shell이 항목을 읽는다. Command line은 symbolic link를 쓰지 않는다.

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
| `sok plugin pack <directory> <output directory>` | Plugin package archive를 쓴다 |
| `sok sidecar release <directory> <output directory> [--platform <platform>]` | Sidecar release archive를 쓰고 `SHA256SUMS`를 갱신한다 |
| `sok registry build <directory>` | Registry를 검증하고 그 `index.json`을 쓴다 |

선언된 command 이름에는 점이 있으므로(`core.card.split`, `terminal.input`) 위의 명령 단어와 겹치지 않는다.

## 창

`[window]`는 `--window <name>` 또는 `--project <directory>`다. `--project`는 둘을 canonical 경로로 바꾼 뒤, 열린 project 폴더가 그 폴더인 창을 고른다. 둘 다 없으면 창이 하나일 때 그 창을 쓰고, 여러 개면 실패하며 창 목록을 보인다.

## 매개변수

선언된 command의 flag는 고른 창에 대해 `exposure.list`가 보고하는 매개변수 schema에서 나온다. Surface가 등록하는 command는 `--surface`도 필요하다. 문자열 매개변수는 텍스트를, 숫자 매개변수는 유한한 숫자를, 정수 매개변수는 정수를, enum 매개변수는 그 값 중 하나를 받으며, boolean 매개변수는 참이면 `--<name>`, 거짓이면 `--<name>=false`다. 객체나 배열 매개변수는 JSON 텍스트를 받는다. Type이 목록인 매개변수는 나열된 type 중 하나를 받으며, 목록에 `null`이 있으면 텍스트 `null`은 null이다. Flag는 값을 `=` 뒤나 다음 인자로 받으므로, `--`로 시작하는 값은 `=` 뒤에 준다. `--params <json>`은 매개변수 객체 전체를 주며 매개변수 flag와 함께 쓸 수 없다. Schema가 선언하지 않은 flag나 schema와 맞지 않는 값은 command를 보내기 전에 실패한다.

## 출력과 종료 상태

명령은 결과를 표준 출력에 JSON으로 쓰며, 결과가 없는 명령은 `null`을 쓴다. 오류는 표준 오류에 `sok: <message>`로 쓰고, endpoint 오류 코드가 있으면 괄호 안에 함께 쓴다. 종료 상태는 성공 0, 실패한 명령 1, 사용법 오류 2이며, 사용법 오류는 사용법도 출력한다.

## Package, release, registry

이 명령들은 파일을 쓰며 실행 중인 애플리케이션이 필요 없다.

`sok plugin pack <directory> <output directory>`는 plugin 폴더의 `package.json`과 `plugin.json`을 읽고, [plugin package](installation.ko.md#plugin-package)와 `soksak.sidecars`가 `plugin.json`의 `sidecars`를 정확히 지정하는지 검사한 뒤 `<id>-<version>.tgz`를 쓴다. `<id>`는 `plugin.json`의 `id`다. 출력은 절대 archive 경로를 담은 `{ id, version, archive, sha256 }`이다.

`sok sidecar release <directory> <output directory> [--platform <platform>]`는 sidecar 폴더의 `package.json`과 `sidecar.json`을 읽고, `package.json`에 package `name`, `version`, 그리고 `sidecar.json`과 `sidecar.json`의 `executable`을 나열한 `files`가 있는지 검사한 뒤 [release asset](installation.ko.md#sidecar-release-asset) `<file name>-<version>-<platform>.tar.gz`를 쓴다. `--platform`이 다른 플랫폼을 지정하지 않으면 플랫폼은 `sok`이 실행되는 플랫폼이다. `sok`은 파일 내용을 보지 않으므로, 다른 플랫폼을 지정하면 그 플랫폼용으로 build한 파일에 이름을 붙이는 것이다. 그다음 출력 폴더에 `SHA256SUMS`를 쓴다. Archive마다 `<sha256>  <archive name>` 한 줄이며 archive 이름 순서이고, 같은 이름의 archive 줄은 바꾼다. Archive를 쓰기 전에 `SHA256SUMS`를 읽으므로, 형식이 틀린 파일이면 아무것도 쓰지 않고 실패한다. 출력은 `{ name, version, platform, archive, sha256 }`이다.

두 archive는 gzip으로 압축한 tar 파일이다. `package.json`과 `files`의 모든 경로를 폴더 기준 상대 경로로 담으며, 폴더는 그 아래 파일까지 담는다. 항목은 경로 순서이고, 수정 시각 0, 소유자 0, mode 0644를 가지며 실행 bit가 있는 파일은 0755다. 나열한 경로가 없거나, 폴더 밖으로 나가거나, symbolic link이거나 그것을 담거나, 일반 파일도 폴더도 아닌 파일이면 명령은 실패하고 아무것도 쓰지 않는다. 두 구현은 같은 항목을 쓰지만 gzip stream이 다르므로, archive의 `sha256`은 그것을 쓴 `sok`이 출력한 값이다.

`sok registry build <directory>`는 registry 폴더의 `plugins/<id>.json`, `sidecars/<file name>.json`, `packs/<name>.json`, `revoked.json`(`{ plugins, sidecars }`)을 읽는다. 각 파일은 [registry index](installation.ko.md#registry-index)의 항목 하나를 담고, 파일 이름은 항목과 맞는다. 명령은 항목을 하나의 index로 검사하고, 모든 archive를 읽어 `sha256`을 비교하며, plugin archive가 plugin id를 가진 `plugin.json`과 항목의 package 이름, version, `engines.soksak`, sidecar 범위를 가진 `package.json`을 담는지 검사한다. 모든 검사를 통과할 때만 각 목록을 id나 이름 순서로 정렬한 `index.json`을 쓰며, 파일은 한 번에 바꾼다. 출력은 경로와 항목 수를 담은 `{ index, plugins, sidecars, packs }`이다.

## 설치와 실행 중인 애플리케이션

Plugin과 sidecar 명령은 설정 폴더의 파일을 직접 바꾸므로 실행 중인 애플리케이션이 필요 없다. 실행 중인 애플리케이션은 `plugins/installed.json`을 관찰하고 바뀐 내용을 불러온다.
