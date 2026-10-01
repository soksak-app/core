# Command line `sok`

[English](cli.md)

`sok`은 soksak 애플리케이션의 command line이며, 모든 명령을 이것으로 공개한다. 각 native host package가 한 계약으로 이것을 build한다. Tauri host는 Rust로, Wails host는 Go로 build한다. 각 애플리케이션 bundle은 실행 파일 옆에 자기 `sok`을 담는다(macOS에서는 `Contents/MacOS/sok`). `sok`은 `--config-dir`가 다른 폴더를 지정하지 않으면 자신이 속한 애플리케이션의 설정 폴더(`com.soksak.tauri` 또는 `com.soksak.wails`, [projects](projects.ko.md) 참조)를 쓴다. 그래서 `PATH`가 닿는 `sok`이 구현과 설정 폴더를 정한다. `PATH`는 bundle의 실행 파일 폴더를 담은 경로 항목 `/etc/paths.d/<application identifier>`로 bundle에 닿으며, 이 항목을 쓰려면 관리자 권한이 필요하다. Command line은 symbolic link를 쓰지 않는다.

## 명령

| 명령 | 동작 |
| --- | --- |
| `sok <command> [window] [--surface <id>] [--<parameter> <value>]... [--params <json>]` | 실행 중인 애플리케이션에서 core나 plugin이 선언한 command를 [endpoint](endpoint.ko.md) method `command.run`으로 실행한다 |
| `sok commands [window]` | 선언된 command를 매개변수 schema와 함께 나열한다 |
| `sok windows` | 실행 중인 애플리케이션의 창을 나열한다 |
| `sok exposures [window]` | 선언된 모든 status, command, DOM 항목을 나열한다 |
| `sok status <name> [window] [--surface <id>] [--watch]` | Status 값을 출력한다. `--watch`는 값과 이후 바뀔 때마다 JSON 한 줄씩 출력한다 |
| `sok dom rect\|click\|input\|dispatch <name> [window] [--surface <id>] [--index <n>] [--value <text>] [--event <json>]` | 선언된 DOM 항목에 동작한다 |
| `sok input pointer [window] --x <x> --y <y> --phase move\|down\|drag\|up\|scroll [--button left\|right] [--delta-x <n>] [--delta-y <n>] [--activate]` | Native pointer 입력을 보낸다 |
| `sok input key [window] --key <key> --phase down\|up [--text <text>] [--modifiers shift,control,option,command]` | Native key 입력을 보낸다 |
| `sok capture [window]` | 진단 build: 창에 focus를 주지 않고 정지 이미지를 쓴다 |
| `sok plugin install\|update\|remove\|enable\|disable <id>` | 설치된 plugin을 바꾼다([설치](installation.ko.md)) |
| `sok plugin list` | 설치된 plugin을 나열한다 |
| `sok plugin pack <directory> <output directory>` | Plugin package archive를 쓴다 |
| `sok sidecar release <directory> <output directory> [--platform <platform>]` | Sidecar release archive를 쓰고 `SHA256SUMS`를 갱신한다 |
| `sok registry build <directory>` | Registry를 검증하고 그 `index.json`을 쓴다 |

선언된 command 이름에는 점이 있으므로(`core.card.split`, `terminal.input`) 위의 명령 단어와 겹치지 않는다.

## 창

`[window]`는 `--window <name>` 또는 `--project <directory>`다. `--project`는 둘을 canonical 경로로 바꾼 뒤, 열린 project 폴더가 그 폴더인 창을 고른다. 둘 다 없으면 창이 하나일 때 그 창을 쓰고, 여러 개면 실패하며 창 목록을 보인다.

## 매개변수

선언된 command의 flag는 선언된 매개변수 schema에서 나온다. 문자열 매개변수는 텍스트를, 숫자 매개변수는 유한한 숫자를, enum 매개변수는 그 값 중 하나를 받으며, boolean 매개변수는 참이면 `--<name>`, 거짓이면 `--<name>=false`다. 객체나 배열 매개변수는 JSON 텍스트를 받는다. `--params <json>`은 매개변수 객체 전체를 주며 매개변수 flag와 함께 쓸 수 없다. Schema가 선언하지 않은 flag나 schema와 맞지 않는 값은 command를 보내기 전에 실패한다.

## 출력과 종료 상태

명령은 결과를 표준 출력에 JSON으로 쓰며, 결과가 없는 명령은 `null`을 쓴다. 오류는 표준 오류에 `sok: <message>`로 쓰고, endpoint 오류 코드가 있으면 괄호 안에 함께 쓴다. 종료 상태는 성공 0, 실패한 명령 1, 사용법 오류 2이며, 사용법 오류는 사용법도 출력한다.

## 설치와 실행 중인 애플리케이션

Plugin과 sidecar 명령은 설정 폴더의 파일을 직접 바꾸므로 실행 중인 애플리케이션이 필요 없다. 실행 중인 애플리케이션은 `plugins/installed.json`을 관찰하고 바뀐 내용을 불러온다.
