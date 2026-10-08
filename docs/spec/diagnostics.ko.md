# 진단

[English](diagnostics.md)

사용자 컴퓨터에서 한 번 나타난 결함은 결함이 나타나기 전에 애플리케이션이 써 둔 기록으로만 원인을 찾는다. 이 문서는 어떤 기록이 있는지, 누가 쓰는지, 형태가 어떤지, 각 실패가 어디에 기록을 남기는지를 정하는 한 곳이다. [host](hosts.ko.md#애플리케이션-로그), [performance trace](performance-trace.ko.md), [debug view](debug.ko.md)는 자기 부분의 세부를 정하고 파일 표와 규칙은 여기를 가리킨다.

## 폴더

애플리케이션의 모든 진단 파일은 `<config-dir>/logs/` 아래에 있다. 결함을 만난 사람은 이 폴더를 넘기고, [debug view](debug.ko.md)가 이 폴더를 나열하고 저장한다. 진단 파일을 담는 다른 폴더는 없다. `webkit-children.json` 같은 운영 파일은 기록이 아니므로 `logs/` 밖에 둔다.

## 파일

| 파일 | 쓰는 쪽 | 형태 | 한계 |
|---|---|---|---|
| `application.log` | 두 host, `report`를 거친 page, `sp_log_error`를 거친 native 라이브러리, host가 시작한 sidecar의 standard error | 글줄 | 실행이 열 때 10 MB이면 `application.log.1`로 이름을 바꾼다 |
| `<executable-name>.log` | 상주 service. host가 service의 standard error로 연다 | 글 | host가 service를 시작할 때 10 MB이면 `<name>.1`로 이름을 바꾼다 |
| `performance.ndjson` | page, 두 host, sidecar, sampler | 한 줄에 JSON event 하나 | 10 MB에서 `performance.ndjson.1`로 회전한다 |
| `state-<time>.json` | debug view가 열릴 때 두 host | JSON 문서 하나 | 없음. 열 때마다 파일 하나 |
| `captures/…` | 진단 빌드의 두 host | PNG와 frame 파일 | 요청한 쪽이 지운다 |

`<time>`은 UTC 시각 `YYYYMMDDTHHMMSSZ`다. 응답 정지 sample은 애플리케이션이 아니라 창 검사 harness가 쓴다.

## 형태

기록은 세 형태이고, 각 사실은 맞는 형태로 기록한다.

1. **오류 줄.** `application.log`의 한 줄 `error: <where>: <text>`. `<where>`는 실패한 동작이나 대상, `<text>`는 실패다. 모든 실패는 쓰는 쪽의 helper 하나(Go `LogError`, Rust `log_error`, native 라이브러리 `sp_log_error`, page `report`)로 이 줄을 쓴다. 실패가 아닌 상태를 말하는 줄은 `error: `로 시작하지 않는다.
2. **Event.** `performance.ndjson`의 한 줄: `ts`(밀리초가 있는 ISO-8601), `pid`, `layer`, `event`와 그 event의 필드를 가진 JSON 객체. event는 무슨 일이 언제 일어났는지를 계층을 가로지르는 한 시간선의 순서로 기록한다.
3. **State file.** `state-<time>.json`: 한 시점의 애플리케이션 상태로, `time`, `host`, `versions`, `windows`, `page`를 가진다. 쓰는 쪽이 읽지 못한 부분은 그 오류와 함께 기록하고 파일 쓰기를 멈추지 않는다.

## 규칙

- 실패 지점의 기록은 아래 표에 있다. 표에 없는 실패 지점은 이 문서의 결함이다.
- 기록은 실패가 일어난 순간 그것을 알리는 event가 쓴다. timer나 polling으로 실패를 찾지 않는다. 한 원인은 한 줄을 쓰고, 같은 원인의 반복 보고는 아무것도 더하지 않는다.
- 한계는 파일을 열 때만이 아니라 쓰는 동안에도 적용한다.
- 기록은 종류와 길이만 담고 입력한 글자나 파일 내용은 담지 않는다.
- 기록을 쓰지 못하는 쪽은 할 수 있는 곳에 오류를 알린다. application log를 열지 못한 host는 시작하지 않는다.
- 각 실패 지점에는 그 실패를 일으키고 기록을 읽는 test가 있다.
- state file은 host가 가진 값만으로 완성된다. 그래서 page가 시작하지 못한 창도 `ready` 값과 마지막 오류 줄과 함께 그 안에 있다.

## 실패 지점

| 실패 | 기록 |
|---|---|
| main page의 module이 불러오지 못하거나 불러오는 중 던진다 | `error: page start: <text> @ <file>:<line>`([page 시작](native-host.ko.md#page-시작)) |
| host가 page가 요청한 파일을 내줄 수 없다 | `error: page asset: <path>: not found`, 경로마다 한 번 |
| main page가 첫 화면 뒤에 던지거나 reject한다 | page 오류 표시의 `error: <where>: <text>` |
| native 호출이 실패한다 | `sp_log_error`의 `error: <where>: <text>` |
| native 치명 오류(signal, 잡히지 않은 예외) | `error: fatal: <signal 또는 예외>` 한 줄, 그 뒤 process가 끝난다 |
| Rust host가 panic한다 | panic hook의 `error: panic: <where>: <text>` |
| 창의 WebContent process가 끝난다 | `error: page process: <window>: <reason>` |
| host가 실행되는 동안 표준 입출력 sidecar process가 끝난다 | `error: sidecar <name>: failed: output closed: <exit status>` |
| host가 실행되는 동안 상주 service의 연결이 끝난다 | `error: sidecar <name>: connection lost; restarted`, 또는 `connection lost; restart failed: <reason>` |
| document region이 navigation에 실패한다 | `error: document <surface>: <text>` |
| `sok` 명령이 실패한다 | standard error의 실패와 `application.log`의 `error: sok <command>: <text>` |

## 읽기

application log는 무엇이 어디서 실패했는지, performance trace는 언제 어떤 순서였는지, state file은 한 시점에 애플리케이션이 무엇을 가졌는지를 답한다. 결함 보고는 `logs/`의 파일과 결함의 시각을 밝힌다.
