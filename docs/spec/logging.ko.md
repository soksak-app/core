# 로그

[English](logging.md)

이 문서는 애플리케이션이 자기 자신에 대해 쓰는 기록의 계약이다: event란 무엇인지, 어떤 class가 있고 각각 어떻게 저장하는지, writer가 어떻게 동작하는지, 어떤 파일이 event를 담는지, event를 어떻게 선언하고 검사하는지. [진단](diagnostics.ko.md)은 `logs/`의 실패 지점과 파일을 나열하고, [debug](debug.ko.md)는 그 파일을 보여 준다. 구현을 이 계약에 맞추는 작업은 [관측 기반 계획](../plans/observability.ko.md)이며, 구현하지 않은 부분은 [기능](../features.ko.md)에 표시한다.

## 원칙

1. **하나의 event 계약.** 모든 층의 모든 기록은 아래 구조의 event 하나다. 둘째 형식은 없다. 사람이 읽는 글은 viewer가 event로 만들며 저장하지 않는다.
2. **생산자는 막히지 않는다.** UI 스레드, 입력 경로, frame 경로는 기록을 위해 디스크 접근, IPC, 락 대기, 한 runtime의 스레드에서 다른 runtime으로의 호출을 하지 않는다. 정책이 저장하지 않는 event는 분기 하나의 비용이고 아무것도 만들지 않으며, 저장하는 event는 bounded 큐로의 복사 하나의 비용이다.
3. **손실은 세고 밝힌다.** 어떤 큐, 정책, 보존, rate limit, 절단도 조용히 버리지 않는다. 손실은 `log.dropped`, `log.gated`, `log.pruned` event로 기록하고 모든 상한은 이 문서에 적는다.
4. **입력 경로는 완전하다.** `input` class의 event와 `io` class의 PTY 쓰기·읽기는 층이 본 모든 값과 모든 바이트를 담는다. 크기의 유일한 상한은 event의 크기 상한([상한](#상한))이며, 이는 입력의 크기보다 훨씬 크다. 큐는 자신의 바이트 상한보다 큰 event를 거절하므로, writer는 그보다 큰 event를 잘라 `truncated`를 붙여 저장한다.
5. **event는 선언한다.** 모든 event는 그것을 내는 저장소의 catalog에 항목이 있다. 개발과 지속적 통합은 선언하지 않은 event를 거부한다. 실행 중에는 선언하지 않은 event도 `undeclared` 표시를 붙여 쓰고 센다. 이름 오류가 증거를 버리지 않게 하기 위해서다.
6. **같은 종류의 event는 한 입구로 들어온다.** page→host 호출, 창·애플리케이션 이벤트, registry 명령, sidecar 수명, 오류 표시는 각각 기록하는 입구가 하나다. 호출 지점이 이를 위해 자기 기록을 쓰지 않는다.
7. **기록은 사실을 적는다.** event는 그때의 값과 함께 무슨 일이 있었는지를 적는다. 누가 요청했는지나 사람이 왜 했는지는 적지 않는다.

## event

event는 한 줄의 JSON 객체 하나다.

```json
{"ts_us":1791500000000000,"mono_ns":123456789012,"seq":812,"level":"info","class":"input","layer":"native",
 "event":"native.input.key_down","window":"w1","surface":"tab-x","session":"s7","cids":["b3.1042"],
 "fields":{"keyCode":36,"characters":"\r"}}
```

| field | 뜻 |
| --- | --- |
| `ts_us` | 발생 시점의 epoch 기준 마이크로초 wall clock. 층 사이의 순서를 가린다. 모든 줄이 가진다. |
| `mono_ns` | 발생 시점의 시스템 전체 monotonic 시계(나노초). macOS는 `clock_gettime_nsec_np(CLOCK_UPTIME_RAW)`이며 `mach_absolute_time`을 나노초로 바꾼 값과 같고 Linux는 `CLOCK_MONOTONIC`이다. 한 부팅 안의 프로세스 사이에서 비교할 수 있고, 되감기지 않으며, 기계가 잠든 동안에는 늘지 않는다. 모든 줄이 가지며 감사는 이 field가 없는 줄을 거부한다. page는 host의 시계에서 이 값을 유도한다([writer](#writer)). |
| `seq` | 프로세스의 writer가 직렬화할 때 붙이는 정수. 한 프로세스의 저장된 event는 연속된 `seq`를 가지며, 틈은 빠진 `seq`의 범위를 이름으로 밝히며 그 범위 다음에 자신이 저장되는 `log.dropped` event가 설명한다. |
| `level` | `error`, `warn`, `info`, `debug`, `trace`. level은 뜻으로 정의한다: `error`는 실패, `warn`은 손실이나 성능 저하, `info`는 결정이나 객체 수명의 변화, `debug`와 `trace`는 경계 넘기나 입력이다. `error`, `warn`, `info`는 main 파일에, `debug`와 `trace`는 debug 파일에 저장한다([파일](#파일)). |
| `class` | event의 class([class와 정책](#class와-정책)): `lifecycle`, `input`, `call`, `io`, `frame`. catalog가 그 event 이름에 선언한 class다. class를 고르는 생산자(native 라이브러리)는 catalog의 class를 주고, host의 writer는 class가 다른 record를 거부한다. 이름을 catalog가 선언하지 않은 event에는 `class`가 없다. |
| `undeclared` | `true`이며, 이름을 catalog가 선언하지 않은 event에만 있다. writer는 그런 event를 `class` 없이 저장하고 이 표시로 센다. 이름 오류가 증거를 버리게 해서는 안 되기 때문이다([원칙](#원칙)). |
| `layer` | `native`, `host`, `page`, `plugin`, `sidecar`, `sok`. |
| `event` | catalog가 선언한 `<layer>.<subsystem>.<event>`. writer 자신의 event는 `log.<event>`(`log.open`, `log.dropped`)라 부르며 `layer`는 그것을 쓰는 프로세스의 층이다. |
| `window`, `surface`, `session` | event가 어떤 대상에 관한 것이면 그 대상의 식별자. |
| `page` | event를 쓴 문서의 time origin을 글로 적은 것으로, 그 문서의 `page.start`가 `time_origin`에 적는 값이다. layer `page`와 `plugin`의 모든 event가 가지며(`page.log.clock` 포함) 다른 layer의 event는 갖지 않고, 감사는 이를 어긴 줄을 거부한다. 문서의 event를 그 문서의 시계 anchor와 그 문서의 다른 event에 잇는다. |
| `cids` | event가 속한 입력의 상관 식별자 목록. 없으면 생략한다. |
| `fields` | catalog가 선언한 event의 값. |
| `truncated` | event의 fields 글이 event 크기 상한을 넘었을 때만 있다. 자르기 전 그 글의 바이트 크기다. 이런 event의 `fields`는 글의 첫 바이트인 `head`만 담는다([상한](#상한)). |

모든 파일의 첫 줄은 `log.open`이며 main 파일과 debug 파일 모두 그렇다. schema 번호(`schema`), `pid`, 프로세스의 역할(`role`), 실행의 식별자(`boot`)를 담는다. schema 번호는 2이며 schema 2는 모든 줄에 `mono_ns`와 `class`를 더한다. 다른 schema 번호를 만난 reader는, schema 1 파일도, 파일 이름과 그 번호를 담은 오류로 그 파일을 거부하며 어떤 reader도 이전 schema를 위한 코드를 두지 않는다. 감사는 선언된 event인데 `class`가 없는 줄을 보고한다.

writer가 회전하는 파일은 경계를 넘게 될 줄 앞에서 끝난다. 닫은 파일은 다음 번호의 세대 `<name>.<generation>`이 되며, 번호는 회전 순서대로 1부터 센다(`.1`이 가장 오래됨). 새 파일은 `log.open`으로 시작하고 이어서 `log.rotated` `{bytes, generation}`이 온다. `bytes`는 닫은 파일의 크기, `generation`은 그 번호다. 회전은 세대를 지우지 않는다. `seq`는 회전을 건너 이어지므로 독자는 세대를 첫 `seq`로 정렬한다.

### 상관 식별자

native 입력 콜백 하나(키 event, 붙여넣기, drop, 포인터 보고)는 그것을 처음 본 층에서 식별자 `<boot>.<n>` 하나를 받는다. 그 콜백이 일으키는 콜백(`setMarkedText`, `insertText`, `commitThrough`)은 일으킨 콜백의 식별자를 쓴다. 식별자는 native 보고, host 중계, page event와 함께 가고, plugin이 전송에 실어 넘기며, host가 sidecar로 가는 요청 envelope에 넣으므로 요청의 본문은 plugin의 것으로 남는다. 입력 여럿을 합치는 전송은 그 식별자를 모두 나르고, sidecar는 그 요청이 일으키는 event, 곧 `pty_write`까지 이를 적는다. envelope field를 모르는 sidecar는 이를 무시한다.

native 라이브러리는 image region의 키가 도착할 때 그 키의 식별자를 부여한다: `native.input.key_down`(키 코드, modifier 유무에 따른 문자, modifier flag, 반복 flag, 키의 시각, 입력 문서의 상태). 그 키가 일으키는 입력기 콜백과 page로의 보고마다 같은 식별자를 쓴다(`native.input.callback`, `native.input.report`). 키가 일으키지 않은 입력기 콜백(포인터로 고른 후보, 입력 소스 변경)은 그 자체로 하나의 입력이며 자기 식별자를 받는다. page로 보내는 보고는 식별자를 JSON의 member `cids`로 나른다. host는 그런 보고의 중계를 같은 식별자와 함께 `host.input.relay`(`surface`, `name`, `type`)로 기록하고 보고는 그대로 넘긴다. page는 호출 `sidecarSend`를 요청의 `cids`와 함께 `page.call`로 기록하고, host는 큐에 넣은 요청을 요청 줄이 나르는 식별자와 함께 `host.sidecar.request`(`name`, `surface`, `bytes`)로 기록한다. [Catalog](#catalog)의 사슬 `input`이 이 event를 잇기 때문에 감사는 sidecar에 닿기 전에 멈춘 키를 찾고, 한 키가 두 층 사이에서 지연된 시간은 두 event의 `mono_ns` 차이이다. 각 sidecar 저장소는 요청의 식별자를 터미널에 쓰기까지의 자기 event에 적고 자기 catalog에서 사슬을 확장한다.

## class와 정책

event는 class 하나에 속하며 catalog가 이를 선언한다. class가 저장 방식을 정하고, 아래 정책이 class마다 어느 level을 저장할지 정한다.

| class | 예 | 발생률 | 저장 |
| --- | --- | --- | --- |
| `lifecycle` | 창, 애플리케이션, sidecar, 세션의 수명. 설정, 프로젝트, plugin, 업데이트의 변경 | 낮음 | 저장 |
| `input` | 키, 입력기 콜백, 붙여넣기, 클릭 | 사람 속도 | 완전하게 저장: 입력한 글, 범위, flag, 앞뒤 상태 |
| `call` | page→host 호출, registry 명령, endpoint 메서드: 이름, 인자, 결과, 마이크로초 | 중간 | 저장. catalog가 선언한 크기 상한을 넘는 인자는 상한까지 저장하고 `truncated`로 표시한다. catalog가 가림으로 표시한 인자(token, 문서 본문)는 크기와 hash로 저장한다. |
| `io` | sidecar 메시지, PTY 읽기와 쓰기 | 중간~높음 | 완전하게 저장. 유일한 상한은 파일의 회전이며 일어날 때 기록한다. |
| `frame` | 그림 frame, 화면, 포인터 이동, wheel, layout | 높음 | 집계: 선언한 간격마다 횟수, 극값, 마지막 값, 총 마이크로초를 담은 요약 event 하나. 생산자가 발생마다 저장하는 event는 정책이 그 class를 그 level로 저장하는 동안 저장한다. |

설정 `diagnostics.log`가 상세히 저장할 category를 고른다. host는 적용 중인 정책을 `<config-dir>/log-policy.json`에 쓴다. [정책 파일](#정책-파일)이 그 schema와 프로세스가 바뀐 것을 아는 방법을 정한다. 정책을 나르는 프로토콜 연산은 없다.

화면의 셀 같은 큰 값은 event에 쓰지 않고 크기와 hash를 쓴다. 값은 정책이 class `frame`을 level `trace`로 저장하는 동안 저장한다. 터미널 화면의 내용은 저장하지 않는다. 입력과 화면마다의 hash를 저장하며, [재생](replay.ko.md)이 내용을 파생한다.

### 정책

정책은 class마다 저장할 가장 덜 심각한 level을 말한다: `off`(그 class의 event 없음), `error`, `warn`, `info`, `debug`, `trace`(모든 level). 기본 정책은 모든 class에서 `error`만 저장하므로, release는 `error` 아래의 event 비용을 치르지 않고 표시 경로가 보이는 모든 오류의 기록을 남긴다. 모든 writer와 native ring은 첫 정책 전과 정책 파일이 없는 동안 이것을 적용한다. 더 넓은 정책은 애플리케이션을 실행하는 사람이 switch 디버그([설정](settings.ko.md#진단))로 내리는 결정이다.

- **설정.** 설정 `diagnostics.log`([설정](settings.ko.md#진단))는 일부 class의 level을 이름 붙이는 객체(`{"call": "info"}`)이며, 이름이 없는 class는 기본 정책을 따른다. class 밖의 이름과 level 밖의 값은 설정 이름을 담은 오류로 거부한다. page는 설정의 정책을 batcher의 gate에 넣고, 다섯 class를 모두 담은 정책을 호출 `log`의 action `policy`(`{action: "policy", classes}`)로 host에 보낸다. host는 아래 파일의 규칙으로 검사한 뒤 파일을 쓰며, 규칙을 어긴 요청은 오류이고 아무것도 쓰지 않는다.
- **문서.** 정책을 적용하는 정책 파일의 각 load(source `default` 또는 `file`)는 모든 class 값인 `{classes}`를 담은 host event `log-policy`를 모든 window에 보내고, window의 모든 문서가 이를 받는다. 거부된 파일은 아무것도 보내지 않는다. 호출 `log`의 action `policy-read`(`{action: "policy-read"}`)는 적용 중인 정책의 `{classes}`로 답한다. host 호출 `log`는 다른 action을 `action must be batch, clock, policy or policy-read, not <action>`으로 거부한다. 주소에 `id`를 담은 surface나 modal의 문서는 자기 gate를 가진 별도의 web view다. load할 때 `log-policy`를 구독하고 `policy-read`를 물으며, 각 답과 이후의 각 event를 자기 gate에 넣고, 그중 처음 것이 올 때까지 기본 정책을 유지한다. event 뒤에 답한 read는 아무것도 바꾸지 않는다.
- **파일과 감시.** 파일의 schema, 쓰는 방법, 읽는 쪽의 거부, 프로세스가 변경을 아는 방법은 [정책 파일](#정책-파일)에 한 번만 적는다.
- **Gate.** 생산자는 event의 field를 만들기 전에 `enabled(class, level)`을 묻는다. 답이 아니오일 때 만들기를 건너뛰는 생산자는 세는 형태(`Gate`, `gate`, `sp_event_gate`)를 묻고, 모든 층의 writer도 자기에게 닿은 event에 대해 이를 묻는다. 그래서 정책이 저장하지 않는 event는 큐에 들어가거나 쓰이지 않는다. 인자를 직렬화하는 host의 생산자(`host.binding.call`, `host.endpoint.call`, trace), page(`page.call`, trace, surface의 문서), native 라이브러리(`native.input.query`, 센 관찰과 전달한 관찰)는 만들기 전에 묻는다. 이름을 catalog가 선언하지 않은 event에는 class도 gate도 없다.
- **세기.** gate가 거부한 모든 event는 class와 level별로 세고, 그 수는 모든 gate를 지나는 class `lifecycle`, level `info`의 event로 나간다: `log.gated`(host), `page.log.gated`(page), `native.log.gated`(native 라이브러리, writer가 ring을 비울 때 보고)이며 `class`, `level`, `count`(이전 보고 이후의 정확한 수)를 담는다. event `page.start`도 모든 gate를 지난다: main page의 첫 모듈은 setting의 policy가 page의 gate에 닿기 전에 이것을 내보내고, 읽는 쪽은 이것으로 각 문서의 시작을 찾는다. writer는 이전 보고 뒤 1초가 지났을 때, flush할 때, 멈출 때 보고하며 배치 간격마다 보고하지 않는다. 100 ms 간격마다의 보고는 좁은 policy가 main 파일에서 없앤 것보다 많은 event를 저장했다. native 라이브러리는 ring을 비울 때 이전 보고 뒤 1초가 지났으면 보고한다.
- **변경.** writer가 처음 적용하는 정책과 이후의 모든 변경은 event `log.policy`(`source`는 `default` 또는 `file`, 그리고 `classes`)이며, 같은 정책이 다시 오면 아무것도 저장하지 않는다. writer가 자기에 대해 보고하는 event(`log.open`, `log.rotated`, `log.dropped`, `log.policy`, `log.gated`, `log.pruned`)는 모든 gate를 지나므로 class `lifecycle`을 끈 정책도 끈 사실을 말한다. host는 자기 종료 때 최종 flush 전에 `log.closed`(`cause`는 quit 전의 첫 종료 signal이면 `signal`, 프로세스를 끝내라는 요청이면 `exit-request`, 프로세스의 끝이면 `exit`이며, `signal`은 종료 signal의 번호다)를 같은 경로로 쓰므로 이 event도 모든 gate를 지난다; 저장 데이터 migration의 기록 `log.migrated`도 모든 gate를 지난다. migration은 설치 순간에 한 번 일어나고 그 기록이 유일한 흔적이기 때문이다. host의 stall 기록 `host.stall`, `host.stall.sampled`, `host.stall.dump`는 level `warn`으로 모든 gate를 지난다. 이는 `passes_every_gate`(`soksak_sok::event_log`)와 `PassesEveryGate`(`sok`)가 이름 붙인 예외다. watch thread가 main thread 정지의 유일한 기록이고, 그 정지 중에는 host가 main thread로 event를 저장할 수 없기 때문이다. `page.start`도 이 예외에 이름이 붙어 있다.

### 정책 파일

정책 파일은 설정 디렉터리의 `log-policy.json`(`<config-dir>/log-policy.json`)이다. host가 설정 `diagnostics.log`에서 만들어, 같은 폴더의 새 파일로 쓴 뒤 mode `0600`으로 경로 위에 rename하므로 reader가 정책의 반쪽을 보는 일이 없다. 파일은 정확히 다음 member를 가진 JSON 객체이다.

| Member | 형 | 값 |
| --- | --- | --- |
| `schema` | 정수 | `1`. 다른 수는 거부한다. |
| `classes` | 객체 | [class와 정책](#class와-정책)의 class마다 member 하나, 곧 정확히 `lifecycle`, `input`, `call`, `io`, `frame`이며 값은 모두 문자열이다. class를 빼거나 더할 수 없다. |

class의 값은 그 class에서 저장하는 가장 덜 심각한 level이다. `off`(그 class의 event를 저장하지 않음), `error`, `warn`, `info`, `debug`, `trace`(모든 level)이다. 값은 아무것도 저장하지 않는 것에서 모두 저장하는 것의 순서로 놓이며, event는 level이 class의 값보다 더 verbose하지 않을 때 저장된다. 파일 안에 기본값을 가진 member는 없다. member를 뺀 파일은 거부한다. 파일이 없는 동안 적용되는 기본 정책은 모든 class가 `error`이며, host가 그 정책으로 쓰는 파일은 `{"schema":1,"classes":{"lifecycle":"error","input":"error","call":"error","io":"error","frame":"error"}}`이다.

reader는 다음 순서로 파일을 거부하고, 파일 이름과 찾은 것을 담은 오류를 낸다. JSON 객체가 아닌 text(`<file>: not JSON: <parser의 message>`), `schema`와 `classes` 밖의 member(`<file>: the member <name> is not one of schema, classes`, 이름 순서로 첫 번째), 정수가 아닌 `schema`(`<file>: schema must be the number 1, found <value>`)나 다른 수(`<file>: schema <n> is not 1`), 객체가 아닌 `classes`(`<file>: classes must be an object that names every class`), 계약 밖의 class(`<file>: the class <name> is not one of lifecycle, input, call, io, frame`), 빠진 class(`<file>: the class <name> is missing`, 위 순서로 첫 번째), 문자열이 아닌 값(`<file>: the level of the class <name> must be text, found <value>`), 여섯 값 밖의 문자열(`<file>: the level "<value>" of the class <name> is not one of off, error, warn, info, debug, trace`). 모든 host, 명령줄 도구, 모든 sidecar가 `not JSON:` 뒤의 text를 빼고 같은 파일을 같은 text로 거부한다.

**바뀐 것을 아는 방법.** 명령줄 도구 `sok`은 명령 하나를 실행하고 끝나므로 시작할 때 파일을 한 번 적용하고 감시하지 않는다. 거부된 파일은 장소 `log policy`의 기록 `sok.record.error`가 되고, 도구는 기본 정책을 유지한다. 그 밖의 모든 프로세스는 시작할 때 파일을 적용하고 운영체제의 파일 시스템 event로 감시하므로 파일을 읽는 timer가 없다. 생성, 쓰기, 교체, rename은 파일의 정책을 적용하고, 삭제는 기본 정책을 적용한다. 정책을 그대로 두는 알림은 아무것도 바꾸지 않는다. 비었거나 공백만 있는 파일은 writer가 잘라 내고 쓰는 중인 파일이므로 reader는 다음 알림을 기다리고 아무것도 보고하지 않는다. 위 규칙을 어기는 파일은 장소 `log policy`의 error record로 저장되고 적용 중인 정책은 그대로 남는다. writer가 처음 적용하는 정책과 그 뒤의 모든 변경은 event `log.policy`(`source`는 `default` 또는 `file`, `classes`는 모든 class의 값)로 저장되고, 같은 정책이 다시 오면 아무것도 저장하지 않는다. host가 `--log-dir <config-dir>/logs`로 시작한 sidecar([sidecars](sidecars.ko.md#선언과-시작))는 그 로그 폴더의 부모 폴더에 있는 `log-policy.json`을 자기 프로세스에서 읽는다.

**검사.** `@soksak/log-contract`의 `parsePolicy(file, text)`, `policyAllows(policy, class, level)`, `policyIsBeingWritten(text)`가 이 규칙을 구현하고, `packages/log-contract/fixtures/policy`가 골든 사례를 갖는다. `cases.json`은 받아들이는 text와 그 class, 정책이 저장하는 class와 level의 쌍과 저장하지 않는 쌍, 거부하는 text와 그 오류, reader가 기다리는 text를 나열하며, `log-policy.json`은 기본 정책의 파일이다. sidecar 시험은 사례(`@soksak/log-contract/fixtures/policy/cases.json`)를 읽고 자기 reader가 같은 결과를 내는지, `not JSON:` 뒤에는 어떤 text든 내는지 요구한다.

## writer

writer는 프로세스에서 event를 파일의 줄로 바꾸는 부분이다.

- 생산자는 먼저 gate `enabled(class, level)`을 묻는다([정책](#정책), 분기 하나). 그 뒤 event를 소유하는 메시지로 만들어 개수와 바이트로 제한한 큐에 막힘 없이 넣는다. 큐가 가득 차면 그 event의 channel의 손실 카운터를 올린다. 만들기 비싼 field는 closure나 builder 함수로 넘기거나 생산자가 만들기 전에 gate에 묻는다. 닫힌 gate는 field를 만들지 않는다.
- 프로세스마다 writer 스레드 하나가 `seq`를 붙이고, JSON으로 직렬화하고, 배치(100 ms마다, 64 KB가 쌓일 때, 또는 `error` 뒤 즉시)로 쓰고, 파일들을 회전한다. `seq`는 프로세스의 main 파일과 debug 파일에 걸쳐 이어진다. `error`는 writer를 깨우고 돌아오며 생산자는 디스크를 기다리지 않는다. writer는 channel `debug`의 첫 event를 쓸 때 `log.open`을 첫 줄로 하여 debug 파일을 만든다. 그런 event가 없는 실행에는 debug 파일이 없다.
- writer는 손실 카운터를 `log.dropped` event `{from_seq, to_seq, count, bytes, reason, channel, queued}`로 바꾸며, event를 잃은 channel과 reason마다 하나씩이다. `queued`는 기록이 세는 refusal 중 queue에서 기다리던 event 수의 최댓값이며, source가 pull로 보고한 손실에는 없다. `channel`은 `other`(level `error`, `warn`, `info`) 또는 `debug`(level `debug`, `trace`)이고, 해독할 수 없는 record에는 level이 없으므로 그 손실은 `other`로 센다. `log.dropped`는 자신이 가리키는 `seq` 범위 다음에 main 파일에 저장한다. 쓰기가 실패하면(디스크 가득 참, 입출력 오류) writer는 손실을 세고 상태로 보이며, 쓰기가 다시 되면 `log.dropped`를 기록한다. placed event(`EmitPlaced`, `emit_placed`)를 queue나 정책이 거부하면 원인을 밝히는 오류를 돌려준다. queue가 가득 찬 경우는 `the event writer refused <event> because its queue was full`이며 손실이다. 닫힌 gate의 경우는 `the event writer refused <event> because the policy does not store it`이며 gated event이고 손실이 아니다. heartbeat가 끝난 writer 스레드를 감지하면 프로세스는 fatal 오류를 보고하고 끝난다.
- 모든 종료 경로는 프로세스가 끝나기 전에 deadline을 두고 큐를 flush한다: Go host의 shutdown, Rust host의 exit, `panic = abort`, `os.Exit`.
- host의 writer는 같은 프로세스의 다른 계층의 event(page 배치, native ring)를 그 event가 가진 시계(`ts_us`, `mono_ns`), 상관 식별자, 계층 그대로 받는다. 이런 event의 이름은 계층으로 시작해야 하고, 계약에 없는 계층, JSON이 아닌 field, 0인 `mono_ns`, 비어 있거나 따옴표·역슬래시·제어 문자를 담은 식별자는 오류로 거부하며, `seq`는 여전히 writer가 부여한다. host의 생산자는 호출 시점에 두 시계를 읽고(monotonic 시계는 `sp_mono_ns`를 읽는 플랫폼 연산 `MonotonicNanos`로 읽으므로 host와 native 라이브러리가 한 시계를 쓴다), writer가 스스로 만드는 event(`log.open`, `log.rotated`, `log.dropped`)는 만들 때 읽는다. 입력 event를 내는 생산자는 식별자를 함께 준다(`EmitHostCids`, `emit_host_cids`).
- native 라이브러리에는 writer가 없다. C의 bounded lock-free ring을 소유하며, `sp_event`와 `sp_event_cids`가 어느 스레드에서든 event를 ring에 복사하고 host의 writer 스레드가 `sp_event_drain` 호출로 ring을 비운다. 어떤 생산자 스레드도 Go나 Rust를 부르지 않는다. host writer가 생기기 전에 쓴 event는 ring에서 기다린다. `sp_event_cids(class, level, name, cids, fields_json)`은 마이크로초 단위 wall clock, 나노초 단위 monotonic 시계(`sp_mono_ns`), level, class(생산자가 catalog에서 가져오는 `SP_CLASS_*`의 번호), 이름(1~255바이트, 계층 `native`), 상관 식별자(쉼표로 구분한 목록이며 없으면 빈 문자열), JSON 텍스트인 field를 저장하고 `sp_event`는 식별자 없는 호출이다. 없거나 비었거나 더 긴 이름, 열거에 없는 level이나 class, 없는 field, 없는 목록, 따옴표·역슬래시·제어 문자를 가진 목록은 거부하고 센다. 정책의 닫힌 gate도 event를 거부하고 세지만 손실이 아니라 gate된 event로 센다: `sp_event_set_policy(levels)`가 라이브러리에 정책을 주고(class마다 level 하나 또는 -1), `sp_event_enabled(class, level)`은 세지 않고 답하며, `sp_event_gate(class, level)`은 답하고 센다. 생산자는 field를 만들기 전에 후자를 묻는다(drain은 수를 `native.log.gated`로 저장한다). drain은 `ts_us`(8바이트), `mono_ns`(8), level(1바이트), class(1), 이름 길이(1바이트), cids 길이(2바이트), 이름, cids, field로 된 record를 각각 4바이트 길이 뒤에 돌려준다. ring은 4 MiB이며 가득 차면 event를 거부하고 그 level의 channel(error, warn, info는 `SP_EVENT_CHANNEL_OTHER`, debug와 trace는 `SP_EVENT_CHANNEL_DEBUG`)로 세고, host writer가 각 수를 이유 `the native ring was full`과 channel을 담은 `log.dropped`로 기록한다. writer는 플랫폼 연산 `PullNativeEvents`로 배치 간격마다와 flush할 때 ring을 pull하며, pull 한 번에 256 KiB씩 최대 64번 읽는다. ring에서 writer로 오는 event source는 없다. native 스레드가 Go나 Rust를 부르면 안 되므로 pull은 polling이다. writer는 pull한 record를 library가 준 시계와 식별자 그대로 계층 `native`로 저장한다. 이름이 `native.`로 시작하지 않거나, level이나 class가 정의되지 않았거나, class가 catalog가 그 이름에 선언한 class와 다르거나, field가 JSON 객체가 아니거나, `mono_ns`가 0이거나, 식별자가 비었거나 따옴표·역슬래시·제어 문자를 담았거나, 길이가 buffer에 맞지 않는 record는 거부하고 표준 오류에 거부를 보고하며 이유 `a native record was refused`의 `log.dropped`로 센다. ring을 pull하지 못하는 플랫폼은 host의 시작에 실패한다. host는 writer를 시작하기 전에 실행의 boot 식별자를 라이브러리에 준다(`sp_event_set_boot`, 플랫폼 연산 `SetEventBoot`). 그래서 라이브러리가 부여하는 식별자(`sp_cid_new`, `<boot>.<n>`)는 그 실행의 파일에 속한다.
- page는 `context.log.<level>(event, fields)`로 기록한다. event는 배열에 모였다가 host로 가는 배치 호출 하나로 나간다. 100 ms 타이머, 크기 상한에 닿을 때, `pagehide`와 `visibilitychange`에서 나가며 생산자는 응답을 기다리지 않는다. event의 class는 catalog에서 생성한 표(`packages/workbench/event-classes.js`, `scripts/generate-event-classes.mjs`가 씀)에서 그 이름의 class다. field는 그것을 만드는 함수일 수 있으며 gate가 저장하는 event에서만 실행된다. 닫힌 gate는 event를 세고 다음 배치에서 `page.log.gated`로 보고한다. 배치 호출은 action `policy`([정책](#정책))도 나른다. `console.*`, 전역 `error` event, `unhandledrejection` event도 같은 입구로 들어간다. 배치 호출은 요청 `{action: "batch", events}`를 가진 host 호출 `log`이며, host는 배치 전체를 검증한 뒤에야 event를 저장하고, 모든 event를 page가 준 `ts_us`, `mono_ns`, `cids`로 계층 `page`나 `plugin`에 저장하며, 이름이 `page.`나 `plugin.`으로 시작하지 않는 event, 계약에 없는 level, 양의 정수가 아닌 `ts_us`나 `mono_ns`, 따옴표·역슬래시·제어 문자 없는 비어 있지 않은 문자열의 배열이 아닌 `cids`, 객체가 아닌 `fields`는 `events[<index>]`를 가리키는 오류로 거부한다. page에는 마이크로초 시계가 없다. `Date.now()`는 밀리초 해상도이므로 page는 event마다 `performance.now()` 읽기값을 저장하고 배치가 나갈 때 변환한다. 첫 배치 전에 요청 `{action: "clock"}`을 다섯 번 보내고, host는 호출 시점에 읽은 `{ts_us, mono_ns}`로 답하며 event는 저장하지 않는다. page는 `performance.now()`로 잰 왕복이 가장 짧았던 답을 고르고 그 왕복의 한가운데를 답의 시점으로 삼는다. `performance.now()`의 읽기값은 engine 시계의 계단으로 진행하므로 page는 제한된 읽기에서 처음 관측된 계단도 잰다. 그러면 event의 `ts_us`와 `mono_ns`는 읽은 시점의 host 값이 되며 오차는 가장 짧은 왕복의 절반에 page 시계의 해상도를 더한 값 이하이다. page의 첫 batch가 이 둘을 event `page.log.clock`(`trip_us`, `resolution_us`)으로 적으므로, 읽는 쪽은 그 한도 안에서 page의 event를 host의 event 사이에 둔다. 입력을 이어받는 호출의 page event(`sidecarSend`의 `page.call`)는 요청의 식별자를 `cids`에 담는다.
- fatal 신호 처리기는 프로세스가 시작할 때 열어 둔 파일 descriptor에 async-signal-safe 호출만으로 짧은 줄을 쓴다. Go의 runtime fatal 오류는 가로챌 수 없으므로 그 출력은 프로세스의 crash 파일로 가고, host의 모든 goroutine을 시작하는 진입점 `routine.Go`가 panic을 recover하고 `error` event `host.panic`을 저장한 뒤 프로세스를 끝낸다. Rust host는 같은 event를 panic hook에서 저장하며 panic한 스레드에서 writer를 기다리지 않고, 별도 스레드가 flush한 뒤 프로세스를 끝낸다([hosts](hosts.md#process-lifecycle)).

- host와 명령줄 도구 `sok`은 언어마다 하나의 writer 구현을 시작한다. 구현은 도구 패키지(Go 패키지 `sok`의 `event_log.go`, Rust crate `soksak_sok`의 `event_log.rs`)에 있고 host 패키지가 이를 import한다. 구현은 [상한](#상한)의 큐, main 파일과 debug 파일에 걸친 `seq`, `class`, batch, `log.dropped`(channel 포함), 기한이 있는 flush, 옵션에 상한이 있을 때 각 파일의 rotate(세대는 지우지 않는다), gate와 적용 중인 정책([정책](#정책)), 줄, event 필드의 상한(`event_bounds.go`, `event_bounds.rs`)을 가진다. 프로세스는 층과 역할, 단조 시계, writer goroutine 또는 thread의 진입점(도구의 `Go`, `spawn_named`, host의 `routine.Go`와 thread), 그리고 writer에 호출할 수 없는 source가 있으면 그 source의 event와 channel별 손실을 writer에 주는 pull을 주어 시작한다. 보존을 적용하는 프로세스는 writer가 `log.open` 뒤와 회전 뒤에 실행하고 회차가 파일을 지웠으면 event `log.pruned`를 돌려주는 hook도 준다. 도구는 층과 역할 `sok`, [상한](#상한)의 큐 상한, rotate 없음(한 번의 실행은 많아야 `log.open`, `sok.command`, `sok.panic`, `log.dropped`를 저장한다), pull 없음, 정책 파일 없음, 보존 없음으로 시작한다. 정책을 적용하지 않으므로 모든 event를 저장하고, level `error`, `warn`, `info`는 `logs/sok-<boot>.jsonl`에, `debug`와 `trace`는 그 level의 첫 event로 만드는 `logs/sok-<boot>.debug.jsonl`에 쓰며, 끝나기 전 2초 기한으로 flush한다. 단조 시계는 플랫폼 인터페이스의 동작 `MonotonicNanos`(`monotonic_nanos`)로 읽으며, macOS에서는 `CLOCK_UPTIME_RAW`(`sp_mono_ns`의 시계), Linux에서는 `CLOCK_MONOTONIC`이다. host는 층과 역할 `host`, [상한](#상한)의 host 상한, [파일](#파일)의 rotate, 정책 파일, [보존](#보존), native ring pull로 시작한다. native record의 해독(class를 catalog와 대조), logs 폴더에서의 시작, 정책 파일의 쓰기와 감시, 보존을 위한 실행 탐색, host 플랫폼 인터페이스는 host 패키지에 남으며 host 패키지가 도구 패키지에 의존하고 반대는 아니다. 공유 구현은 `packages/log-contract/fixtures`의 golden 파일에 대한 도구 패키지의 시험([host 계약](host-contract.ko.md)의 사례 `cli.log.*`)과 host의 시험으로 지킨다. goroutine과 thread는 panic을 recover하고 프로세스를 끝내는 프로세스의 진입점으로 시작한다([명령줄](cli.ko.md#event-log), [hosts](hosts.ko.md#프로세스-생명주기)).

event를 쓰는 각 저장소는 언어마다 writer 구현 하나를 가지며 `packages/log-contract/fixtures`의 golden lines와 golden catalog로 시험한다. 저장소 사이에 runtime 코드를 공유하지 않으며 sidecar는 실행 중에 core 릴리스에 의존하지 않는다.

## 상한

event가 싣는 모든 buffer와 값에는 상한이 있고, 생산자는 값을 복사하거나 직렬화하기 전에 상한까지 자르므로 기록 비용은 값의 크기에 따르지 않는다. 상한에서 생기는 손실은 조용하지 않다. 세어서 catalog의 event로 저장한다.

| 상한 | 값 | 도달하면 |
| --- | --- | --- |
| event의 fields | JSON 글 1,048,576바이트 | writer는 `fields`를 `{"head": <글의 첫 4,096바이트, 문자 경계에서 자름>}`로, `truncated`를 원래 크기로 정해 event를 저장한다. 큐에는 저장한 크기만큼 청구한다. native ring은 한 번의 pull인 262,144바이트를 넘게 싣지 않는다. host의 생산자는 이 상한에서 fields의 직렬화를 멈추므로 `truncated`는 writer가 글을 쟀을 때는 그 크기이고, 생산자가 멈췄을 때는 멈출 때까지 쓴 바이트 수이며, 이는 상한보다 크고 값의 크기보다 작다. |
| 호출 event(`page.call`, `host.endpoint.call`, `host.binding.call`)의 `args`와 `error` | 1,024바이트, 문자 경계에서 자름 | 상한까지 저장하고 event에 `truncated: true`가 붙는다. page는 `args`를 직렬화하는 동안 자르며 값 전체를 직렬화하지 않는다. |
| `page.console.<method>`의 `text` | 8,192바이트, 문자 경계에서 자름 | 글은 인자를 직렬화하는 동안 상한까지만 만들고, event에 `truncated: true`가 붙는다. |
| page나 plugin의 event `fields` | JSON 글 65,536바이트 | page는 fields를 상한까지만 직렬화하고, event는 `fields` `{"head": <글의 첫 4,096바이트>, "truncated": true}`로 큐에 넣는다. JSON으로 직렬화할 수 없는 fields는 호출자의 오류다. |
| record(`page.record.<level>`, `host.record.<level>`, `sidecar.record.<level>`)의 `text`와 `where` | 각각 8,192바이트와 1,024바이트, 문자 경계에서 자름 | 생산자가 복사하기 전에 자르고 fields에 `truncated: true`가 붙는다. |
| page writer의 큐 | event 4,096개와 4,194,304바이트(각 event의 fields와 이름의 바이트) | page는 거절한 event와 그 바이트를 세어 뒤따르는 event 앞에 `page.log.dropped`(`count`, `bytes`, `reason`)를 저장하며, 거절한 상한마다 event 하나를 저장한다. |
| host writer의 큐 | event 8,192개와 16 MiB | writer는 거절한 event를 세어 `log.dropped`로 저장한다. |
| 명령줄 도구 writer의 큐 | event 1,024개와 1 MiB | writer는 거절한 event를 세어 `log.dropped`로 저장한다. |
| sidecar의 보류 응답(256줄의 쓰기 큐가 빈 뒤에 쓴다) | 메시지 1,024개와 4,194,304바이트 | 응답은 오류 `sidecar <name>: the pending replies reached <bound>, so a reply of surface <surface> is dropped`로 거절되고 `host.buffer.dropped`를 저장한다. |
| sidecar의 보류 close | 메시지 1,024개와 4,194,304바이트 | close는 보내지 않고, 표면은 답을 기다리는 목록에 올리지 않으며, `host.buffer.dropped`를 저장하고, sidecar는 끝날 때까지 그 표면의 session을 가진다. |
| relay의 만료된 요청(늦은 응답) | 요청 256개 | 가장 오래된 요청을 잊으므로 그 요청의 늦은 응답은 `exposure reply <id> has no matching request`로 답하고 `host.buffer.dropped`를 저장한다. |
| host record의 시작 buffer | record 1,024개와 4,194,304바이트 | 거절한 record는 writer가 생기면 세어서 `log.dropped`로 저장한다. |
| page의 답을 기다리는 endpoint topic 하나의 구독 변경 | 변경 256개 | 변경은 적용하지 않고 거절하며, client는 오류 `-32000: the subscription changes of <name> are not keeping up: 256 changes are pending, so this change is refused`를 받고 `host.buffer.dropped`를 저장한다. 닫힌 연결의 구독 해제는 거절하지 않는다. 그 연결이 가졌던 topic마다 변경 하나뿐이다. |
| endpoint 연결의 출력 큐(Wails host) | frame 256개와 16,777,216바이트 | frame을 거절하고 `host.buffer.dropped`를 저장하며, 읽지 않는 연결을 닫는다. Tauri host는 연결을 쥔 채 각 frame을 소켓에 쓰므로 큐가 없다. |

모든 `host.buffer.dropped` event는 `count`가 1이고 거절한 메시지의 크기를 담으므로, 거절이 쏟아지면 event도 쏟아진다. 이는 writer의 큐가 상한으로 막고 다시 센다.

## 파일

프로세스 실행 하나가 설정 폴더의 `logs/` 아래 파일 둘, main 파일과 debug 파일을 쓴다:

| 파일 | level | 질의의 channel |
| --- | --- | --- |
| `logs/<role>-<boot>.jsonl` | `error`, `warn`, `info` | `other` |
| `logs/<role>-<boot>.debug.jsonl` | `debug`, `trace` | `debug` |

사람은 실행 event의 약 5%를 담은 main 파일을 먼저 읽고, main 파일이 실패를 설명하지 못할 때 debug 파일을 연다. 그래서 debug 파일도 main 파일만큼 완전하다: 표본 추출이 없고, 어느 파일의 손실이든 channel을 밝힌 `log.dropped`가 센다. `seq`는 writer가 두 파일에 걸쳐 부여하므로 두 파일을 합치면 실행의 모든 `seq`가 한 번씩 있다. host 프로세스는 native 라이브러리, page, plugin의 event도 담는다. 각 파일은 따로 100 MB에서 회전하며 다른 프로세스의 파일은 회전하지 않는다. 닫은 파일은 세대 `<file>.<n>`이 되고 번호는 회전 순서대로 1부터 센다. 회전은 아무것도 지우지 않는다. 압축한 파일은 그 자리에서 검색할 수 없으므로 세대는 압축하지 않으며, 아래 보존이나 사람만 세대를 지운다.

event가 아닌 raw 파일이 둘 있다. `logs/<role>-<boot>.stderr`는 프로세스의 표준 오류(운영체제와 framework의 출력)를, `logs/<role>-<boot>.crash`는 runtime fatal 오류의 crash 출력을 담는다. viewer는 이를 event 파일과 함께 나열한다.

파일은 mode `0600`으로, 폴더는 mode `0700`으로 만들고 close-on-exec로 열어서 자식 프로세스가 물려받지 않는다.

상태 파일 `logs/state-<time>.json`과 capture는 event가 아니며 [debug](debug.ko.md)가 쓴다.

각 event 파일 옆에는 파일에서 파생한 색인 `<name>.idx`가 있으며 event 파일이 아니다([색인](#색인)).

## 보존

`logs/`에 있는 실행들의 파일은 6 GiB 상한 안에 머문다. *실행*은 이름이 `<role>-<boot>.`로 시작하는 파일 중 event 파일, 세대, debug 파일, 색인, 표준 오류, crash 출력, 고정 표시인 것이다. 폴더의 다른 파일(`application.log`, 상태 파일, capture, `crash-found.txt`)은 어느 실행에도 속하지 않으며 그대로 둔다. host의 writer는 시작할 때와 회전할 때마다 상한을 적용한다:

- 실행들의 파일이 상한을 넘으면 writer는 실행을 통째로, 가장 새로운 파일이 가장 오래된 실행부터 지우며, 파일이 상한 안에 들거나 지울 실행이 없을 때까지 계속한다.
- writer 자신의 실행과 고정 표시가 있는 실행은 지우지 않는다. 고정 표시는 실행 옆의 파일 `logs/<role>-<boot>.keep`이며, 아직 어떤 기록도 분류하지 못한 실패가 있는 실행에 사람이 만든다.
- 파일을 지우거나 상한을 넘은 채로 두는 각 회차는 main 파일의 event `log.pruned` 하나다: 지운 파일 수 `logs`와 `bytes`, 지운 실행의 이름 `runs`, 그 event 파일의 `ts_us` 범위 `from_us`와 `to_us`, 남은 파일의 크기 `remaining`, `bound`. level은 `info`이고, writer 자신의 실행과 고정된 실행만 남아 `remaining`이 여전히 `bound`를 넘으면 `warn`이다. 아무것도 지우지 않고 파일이 상한 안에 있는 회차는 event를 저장하지 않는다.
- 읽거나 지울 수 없는 파일은 경로와 함께 표준 오류에 보고하고 회차는 다음 파일로 계속한다.

상한은 같은 디스크에 있으므로 실행의 색인 파일과 표준 오류도 센다. 양의 상한 없이 시작한 writer는 옵션 이름을 담은 오류로 시작에 실패한다.

## 색인

event 파일이 기준이다. 각 event 파일 `logs/<name>`(`<role>-<boot>.jsonl`, `<role>-<boot>.debug.jsonl`과 그 세대 `.<n>`) 옆의 색인 `logs/<name>.idx`는 파일의 어느 부분이 질의에 맞는 event를 가질 수 있는지 알려 준다. 그래서 질의는 그 부분만 읽고 파일 전체를 읽지 않는다([질의](#질의)). 색인은 파생물이다. 지워도 잃는 것이 없으며 파일에서 다시 만든다.

**segment.** 파일의 줄은 첫 줄부터 세어 연속한 4,096줄씩 segment로 묶고, 마지막 segment는 마지막 가득 찬 segment 뒤의 줄을 담는다. 줄은 줄바꿈으로 끝나야 완전하며, 마지막 줄바꿈 뒤의 바이트는 색인하지 않는다. 색인은 segment마다 다음을 보관한다.

| 항목 | 값 |
| --- | --- |
| `offset`, `length` | 첫 줄의 바이트 offset과 바이트 크기 |
| `first_seq`, `last_seq`, `events` | 첫 줄과 마지막 줄의 `seq`, 줄 수 |
| `min_ts_us`, `max_ts_us` | 줄의 `ts_us` 중 가장 작은 값과 가장 큰 값(layer의 시계는 batch 간격만큼 어긋나므로 `ts_us`는 `seq`와 함께 커지지 않는다) |
| level, layer, class | 나타나는 값마다 비트 하나: `error`, `warn`, `info`, `debug`, `trace`, `native`, `host`, `page`, `plugin`, `sidecar`, `sok`, `lifecycle`, `input`, `call`, `io`, `frame`(줄의 `class` 항목이며 그 항목이 없는 줄은 class 비트를 세우지 않는다) |
| Bloom filter | 다음 표의 다섯 개 |

segment의 Bloom filter는 다음과 같다.

| filter | 줄마다 넣는 항목 | 바이트 | hash 수 |
| --- | --- | --- | --- |
| event | event 이름과 점 앞에서 끝나는 이름의 각 앞부분(`native.input.key_down`은 `native`, `native.input`, `native.input.key_down`을 넣는다) | 1,024 | 4 |
| surface | 줄의 `surface`와 `fields`의 문자열 항목 `surface` | 512 | 4 |
| session | 줄의 `session`과 `fields`의 문자열 항목 `session` | 512 | 4 |
| run | `fields`의 문자열 항목 `run` | 256 | 4 |
| cids | `cids`의 각 값 | 16,384 | 5 |

Bloom filter는 `8 × 바이트` 비트를 가진다. 항목의 hash는 UTF-8 바이트에 대한 FNV-1a 64(offset basis `0xcbf29ce484222325`, prime `0x100000001b3`)이며, `a`는 그 hash, `b`는 그 hash를 왼쪽으로 32비트 회전하고 비트 0을 세운 값이다. 항목의 비트 `i`(`i`는 0부터 hash 수 - 1)는 `(a + i × b) mod 2^64`에 마스크 `8 × 바이트 - 1`을 적용한 값이다. filter에는 false negative가 없다. filter가 받아들인 segment는 읽고 그 줄을 하나씩 검사하므로 false positive는 읽기 비용일 뿐 잘못된 행이 아니다. 한 segment에 서로 다른 식별자가 12,000개(줄마다 셋) 있을 때 `cids` filter가 식별자가 없는 segment를 받아들일 확률은 1% 미만이고, 다른 filter도 보통의 개수(이름 400, surface 100, session 100)에서 1% 미만이다.

**파일.** 모든 정수는 little-endian이다. 파일은 20,480바이트의 상태 block 둘과, 가득 찬 segment의 기록을 순서대로 이은 것이며 기록 하나는 18,760바이트다. 기록은 항목 64바이트, 표의 순서대로 다섯 filter, 검사합(앞 바이트의 FNV-1a 64)이다. 항목은 `offset`(u64), `length`(u64), `first_seq`(u64), `last_seq`(u64), `events`(u32), 0인 4바이트, `min_ts_us`(i64), `max_ts_us`(i64), level, layer, class의 비트(각각 1바이트), 0인 5바이트다. 상태 block은 차례로 magic `SKIX`, 버전 1(u32), segment의 줄 수 4,096(u32), 첫 줄의 바이트 길이(u32), block의 세대(u64), 줄바꿈을 포함한 첫 줄의 FNV-1a 64 hash, `indexed_bytes`(u64, 마지막으로 색인한 줄의 끝), 파일을 색인할 때 읽은 `source_size`(u64)와 `source_mtime_ns`(i64), `first_seq`, `last_seq`, 색인한 줄 수(각각 u64), 가득 찬 segment 수(u32), 마지막 부분 segment의 기록이 뒤따르는지(u32), 그 기록, 0 채움, 마지막 8바이트의 block 검사합(앞 바이트의 FNV-1a 64)을 담는다. 갱신은 새로 가득 찬 기록을 먼저 쓰고, 유효한 block이 차지하지 않은 block(짝수 세대는 block 0)에 세대가 하나 큰 block을 쓴다. 그래서 갱신 도중 끝난 프로세스에는 유효한 이전 block이 남고, 유효한 block의 가득 찬 segment 뒤에 있는 기록은 무시하며 다음 갱신이 덮어쓴다.

**최신 여부.** `source_size`와 `source_mtime_ns`가 파일의 크기와 수정 시각과 같으면 색인은 최신이다. 파일이 더 크고 첫 줄의 hash가 기록과 같으며 크기가 `indexed_bytes` 이상이면 색인이 파일보다 오래된 것이므로, 갱신은 `indexed_bytes` 뒤의 줄을 부분 segment부터 색인한다. 그 밖의 차이(더 작은 파일, 다른 첫 줄, 같은 크기에서 다른 수정 시각)는 색인한 파일이 아니라는 뜻이므로 갱신은 파일 전체를 다시 색인한다. 없는 색인은 만든다. 다음은 파일과 발견한 내용을 밝히는 명시적 오류다: 다른 버전의 색인, 검사합이 맞지 않는 block이나 기록, block과 기록보다 짧은 파일, schema 2의 `log.open`이 아닌 첫 줄, event 구조를 어기는 줄(`<file>:<line>: <reason>`). 다른 버전의 색인을 읽는 코드는 없고, 실패한 갱신은 색인의 이전 상태를 그대로 두며, 손상된 색인은 오류가 이름을 밝힌 뒤 사람이 지운다.

**색인을 쓰는 쪽.** 색인은 timer가 아니라 파일의 event로 파일을 따라간다. host의 writer가 batch를 쓴 뒤([writer](#writer)) 쓰기 알림이 깨우는 host의 goroutine이나 thread가 덧붙은 줄을 색인하고, 색인하는 동안 오는 알림은 갱신 한 번으로 합쳐진다. 질의도 읽을 각 파일의 색인을 쓰기 전에 최신으로 맞추므로, host가 쓰지 않은 색인(sidecar의 파일, host가 실행 중이 아닌 설정 디렉터리)은 `sok debug query`와 host의 질의가 만들고 갱신한다. 한 색인의 갱신은 색인 파일의 advisory lock(`flock`)으로 프로세스 사이에서 서로 배타적이며, 갱신은 lock을 잡은 뒤 연 파일이 아직 그 경로의 파일인지 확인하므로 회전이 두 파일을 섞을 수 없다. 색인이 이미 최신이면 갱신은 아무것도 바꾸지 않으므로 멱등이다. host는 파일 전체로 만든 색인마다 level `info`의 event `host.log.index_rebuilt`(`file`, `reason`, `lines`, `bytes`, `micros`)를 저장하고, 갱신의 다른 실패는 문구마다 한 번 application log에 장소 `log index`의 `error` 기록으로 보인다. 증분 갱신은 event를 저장하지 않는다. 그 event가 다음 갱신이 색인할 줄이 되기 때문이다. 각 갱신은 `announcing`(앞선 갱신 뒤에 색인한 줄 가운데 log의 변경을 알리는 줄의 수)과 `size`(색인이 덮는 파일의 크기)를 보고한다. log만 읽는 호출의 기록, 곧 host 호출 `logQuery`의 `host.binding.call`과 endpoint method `log.query`의 `host.endpoint.call`을 뺀 모든 줄이 변경을 알린다. 그 기록도 다른 줄처럼 저장되고 색인되며, 변경을 알리지 않을 뿐이다. log를 따라가는 화면이 알림마다 `logQuery`를 요청하므로, 자기 기록의 알림이 다시 요청을 부르면 끝이 없기 때문이다([debug](debug.ko.md#타임라인)).

**회전.** writer가 파일을 회전할 때 그 파일의 색인 lock을 잡고 색인을 최신으로 맞춘 뒤 파일을 자기 세대 이름으로 바꾸고 색인 파일도 함께 바꾼다(`<name>.idx`는 `<name>.<n>.idx`가 되며 다른 색인 파일은 옮기지 않는다). 닫힌 세대의 색인은 완전하며 다시 만들지 않는다.

**golden fixture.** `packages/log-contract/fixtures/query`는 event 파일, 두 구현이 각 파일에서 만들어야 하는 색인의 SHA-256(원본의 수정 시각을 1,000,000,000초로 정한 상태), 질의와 기대하는 page를 담는다. Go와 Rust 구현의 test는 파일에서 색인을 만들어 SHA-256을 비교하고 질의를 실행한다.

## 질의

언어마다 질의 구현이 하나씩 있고(Go는 module `sok`, Rust는 crate `soksak-sok-tauriv2`) `<config-dir>/logs/`의 event 파일을 색인으로 읽어 page 하나를 답한다. 두 구현은 같은 파일과 같은 매개변수에 같은 page, 같은 cursor, 같은 오류 문구를 주며 golden fixture가 이를 확인한다.

**파일.** 질의의 event 파일은 `logs/`에서 이름이 `<role>-<boot>.jsonl`, `<role>-<boot>.jsonl.<n>`(`n`은 앞에 0이 없는 양수), `<role>-<boot>.debug.jsonl`, `<role>-<boot>.debug.jsonl.<n>`인 파일이다. `role`은 소문자 단어이고 `boot`은 이름의 나머지다. `.stderr`, `.crash`, `.idx` 파일, 상태 파일, capture는 event 파일이 아니다. *프로세스*는 role과 boot의 쌍(`host-1791500000-4242`)이고, 한 프로세스의 파일(파일, 그 세대, 그 debug 파일)은 하나의 `seq` 공간을 공유한다([event](#event)). *channel*은 파일의 집합이다: `other`는 debug 파일이 아닌 파일, `debug`는 debug 파일, `all`은 둘 다다. writer는 `error`, `warn`, `info`를 파일에, `debug`와 `trace`를 debug 파일에 저장한다([파일](#파일)). channel `debug`의 event를 저장하지 않은 실행에는 debug 파일이 없으며 질의는 있는 파일을 읽는다.

**매개변수.** endpoint 메서드 `log.query`와 host 호출 `logQuery`의 매개변수는 객체 하나이고, 표에 없는 항목은 거절한다. 주지 않은 항목은 제한하지 않는다.

| 항목 | 뜻 |
| --- | --- |
| `channel` | `other`(기본), `debug`, `all` |
| `level` | 보이는 가장 낮은 심각도(`error`, `warn`, `info`, `debug`, `trace`, 기본 `trace`). 그 level이거나 더 심각한 줄이 통과한다 |
| `class` | class 하나: `lifecycle`, `input`, `call`, `io`, `frame` |
| `layer` | layer 하나: `native`, `host`, `page`, `plugin`, `sidecar`, `sok` |
| `event` | 정확한 event 이름 |
| `event_prefix` | 점 앞에서 끝나는 event 이름이나 그 앞부분: `native.input`은 `native.input`과 `native.input.`으로 시작하는 모든 이름을 통과시킨다. 점으로 끝나는 앞부분은 거절한다. `event`와 `event_prefix`를 함께 주지 않는다 |
| `surface`, `session` | 식별자 전체: 줄의 항목, 줄에 없으면 `fields`의 같은 이름의 문자열 항목(host writer는 그곳에 저장한다) |
| `cid` | 줄의 `cids`가 담은 상관 식별자 하나 |
| `run` | run 식별자: channel의 파일에서 `fields.run`이 그 식별자인 가장 이른 `host.test.start`부터 가장 늦은 `host.test.end`까지의 시간 범위(start에 end가 없으면 파일 끝까지). [감사](#검사)가 다른 프로세스의 event를 놓는 것처럼 모든 파일에 `ts_us`로 적용하며, `from_us`, `to_us`와는 교집합이다. `host.test.start`가 없는 run은 오류 `log query run "<run>" has no host.test.start in the channel`이다 |
| `text` | 파일에 적힌 JSON 글인 줄이 그 글을 포함한다. ASCII 글자는 대소문자를 구분하지 않는다 |
| `from_us`, `to_us` | `ts_us`의 양 끝 포함 경계, 음이 아닌 정수. `from_us`는 `to_us`보다 늦지 않다 |
| `order` | `asc`(기본, 오래된 것 먼저) 또는 `desc`(새 것 먼저) |
| `limit` | page의 행 수, 1부터 5,000까지의 정수(기본 500) |
| `after` | 앞 page의 마지막 행의 cursor `{ts_us, role, boot, seq}`: page는 순서에서 그 뒤의 행(`desc`는 앞의 행)을 담는다 |
| `since` | 프로세스 이름(`<role>-<boot>`)에서 `seq`로 가는 객체: 그 프로세스에서 `seq`가 그 값 이하인 행은 뺀다. 이름을 주지 않은 프로세스의 행은 제한하지 않는다 |
| `around` | 행의 cursor `{ts_us, role, boot, seq}`: 질의는 그 행 둘레의 행을 돌려준다(아래 둘레). 이 항목과 함께는 `channel`, `earlier`, `later`만 받는다 |
| `earlier`, `later` | `around`와 함께: 그 행 앞과 뒤의 행 수이며 0부터 500까지의 정수다(기본 5) |

거절한 매개변수의 오류 문구는 `log query <항목> <이유>`이다: `log query has no parameter <name>`, `log query channel "<value>" is not one of other, debug, all`, `log query level "<value>" is not one of error, warn, info, debug, trace`, `log query class "<value>" is not one of lifecycle, input, call, io, frame`, `log query layer "<value>" is not one of native, host, page, plugin, sidecar, sok`, `log query <member> must be a non-empty string, found <value>`, `log query <member> must be a non-negative integer, found <value>`, `log query from_us is later than to_us: <from_us> <to_us>`, `log query limit must be an integer from 1 to 5000, found <value>`, `log query order "<value>" is not one of asc, desc`, `log query after must be {ts_us, role, boot, seq}, found <value>`, `log query since must map process names to integers, found <value>`, `log query takes event or event_prefix, not both`, `log query event_prefix "<value>" must not end with a dot`, `log query around must be {ts_us, role, boot, seq}, found <value>`, `log query earlier must be an integer from 0 to 500, found <value>`(`later`도 같다), `log query earlier needs around`(`later`도 같다), `log query around takes only channel, earlier and later, not <member>`. 값은 JSON으로 보인다.

**둘레.** `around`가 있는 질의는 key가 cursor인 행과 그 곁의 행을 돌려준다: key 순서에서 key보다 앞선 `earlier`개 행과 뒤따르는 `later`개 행을, channel의 파일에서 filter 없이 오래된 것부터 담는다. 그래서 행의 이웃은 어떤 filter가 그 행을 찾았든 그 곁에 쓰인 줄이다. cursor의 key를 가진 행이 있으면 그 행도 답에 있고(회전으로 사라진 행의 cursor에는 없다), `next`는 `null`이다. 답의 각 행은 `context` 항목을 가진다: 이웃은 `true`, cursor의 행은 `false`이며, `around`가 없는 질의의 행에는 이 항목이 없다. 행의 줄 글은 page처럼 제한된다: cursor의 행을 먼저 담고, 그 앞의 행은 남은 8,388,608바이트의 절반까지 쓸 수 있으며, 그 뒤의 행이 나머지를 쓰고, 각 부분의 첫 행은 항상 담는다. `tail`은 마지막으로 읽은 것의 값이고, `scanned`의 `logs`, `segments`, `rebuilt`는 첫 읽기의 값이며 `read`와 `lines`는 읽기들의 합이다. `sok debug query`는 `context`가 `true`인 행의 줄 앞에 공백 둘을 붙여 출력한다.

**순서와 cursor.** 행은 `ts_us`, `role`, `boot`, `seq` 순으로 정렬하며 이것이 행의 key다. channel은 이 key로 합쳐지므로 debug 파일과 한 프로세스의 파일은 시각과 `seq`로 섞인다. 행의 cursor는 그 key다. page는 순서에서 cursor 뒤의 `limit`개 행을 담고, 파일이 끝나거나 행의 줄 글이 8,388,608바이트를 넘게 되면 더 적게 담는다(첫 행은 항상 담는다). `next`는 뒤따르는 행이 있으면 page의 마지막 행의 cursor이고 없으면 `null`이다.

**답.** `{rows, next, tail, scanned}`:

- `rows`는 객체 `{role, boot, file, offset, event}`의 목록이다: 프로세스, 줄을 가진 파일(설정 디렉터리 기준 `logs/...`), 줄의 바이트 offset, 파일에 적힌 event 객체인 줄.
- `next`는 `after`로 넘길 cursor 또는 `null`이다.
- `tail`은 질의가 읽은 시점에 각 프로세스의 색인이 덮는 가장 큰 `seq`다. 파일을 따라가는 client는 이를 `since`로 시작한다([debug](debug.ko.md#타임라인)).
- `scanned`는 `{logs, segments, read, lines, rebuilt}`다: channel의 파일 수, 그 segment 수, 줄을 읽은 segment 수, 검사한 줄 수, 질의 중에 파일 전체로 만든 색인 수.

**평가.** 질의는 각 파일의 색인을 최신으로 맞춘 뒤 행을 가질 수 있는 segment만 남긴다: 시간 범위가 경계와 cursor에 겹치고, level(그 level과 더 심각한 level), layer, class의 비트가 값을 담으며, event 이름이나 앞부분, surface, session, cid의 filter가 받아들이는 segment다. 남긴 segment를 `min_ts_us` 순(`desc`는 `max_ts_us` 내림차순)으로 읽고, segment의 줄을 하나씩 완전히 검사하며, 지금까지 찾은 key가 가장 작은(`desc`는 가장 큰) 행 `limit + 1`개를 유지한다. 다음 segment가 유지한 행보다 앞서는 행을 가질 수 없으면 멈춘다. 그래서 page의 비용은 파일 크기가 아니라 행을 가질 수 있는 segment의 수에 달려 있다. `text`만 있는 질의는 channel의 모든 segment를 읽는다. event 구조를 어기는 줄은 오류 `<file>:<line>: <reason>`이다.

**사용하는 쪽.** debug 화면은 `logQuery`를 호출하고([debug](debug.ko.md#타임라인)), `sok debug query`는 application에 연결하지 않고 도구 프로세스에서 같은 구현을 실행하며([command line](cli.ko.md#명령)), endpoint client는 `log.query`를 호출한다([endpoint](endpoint.ko.md#log-query)). host는 자기 언어의 구현으로 `log.query`와 `logQuery`에 답한다. host 밖의 script는 파일을 읽어도 된다: `scripts/audit-run.mjs`와 `scripts/check-events.mjs`는 모든 파일의 모든 줄(구조, 연속한 `seq`, chain)을 판정하므로 검색이 아니라 모든 줄을 한 번 지나는 일이고 색인으로 줄어들지 않는다. 줄의 일부(시험의 범위, `cids`의 chain)를 찾는 script는 `sok debug query`를 쓴다.

**측정.** event 1,000,000개 로그의 시간은 [features](../features.ko.md)(F160.24)에 있으며, 각 구현의 benchmark `log_query_benchmark`는 그 로그를 만들어 색인을 만드는 시간과 질의 종류별 시간을 출력한다.

## catalog

event를 내는 각 저장소는 `events.json`에 event를 선언한다(이 저장소는 [events.json](events.json)이며 계층 `native`, `host`, `page`를 소유한다. `page.record.<level>`처럼 자리 표시자를 가진 이름은 계열을 선언한다. `level`은 level 하나 또는 level 목록이고, 이름이 `?`로 끝나는 field는 선택이며, `string|null` 같은 타입은 각 부분을 받아들이고, 계층 `sidecar`는 host가 저장하는 sidecar 표준 오류의 줄인 `sidecar.record.<level>`만 담는다. `make events-check`는 소스의 emit 지점을 읽어 선언되지 않은 채 emit된 이름, emit 지점이 없는 선언된 event, 선언이 허용하지 않는 literal 지점의 level이나 field를 실패로 보고한다. 지점은 이름을 literal로 주고(page의 template은 계열이다), 이름을 만드는 지점 위의 주석 `events: <names>`는 그것이 만드는 선언된 이름을 적으며, `events: forwarded`는 그 지점이 호출자의 이름을 넘긴다고 밝힌다. `node scripts/check-events.mjs --logs <config-dir>…`는 창 검사가 남긴 모든 층의 event 파일을 감사한다. [검사](#검사) 참고): event마다 이름, 층, class, level, 필수 field와 그 타입, 가릴 인자, 인자의 크기 상한, 설명. 저장소는 다른 모든 검사에서 자기 소스를 검사하듯 자기 소스를 자기 catalog로 검사한다. 이 저장소는 catalog의 schema와 `native`·`host`·`sok` 층, page의 event를 소유한다. writer 자신의 event는 `log.open`, `log.rotated`, `log.dropped`, `log.policy`, `log.gated`, `log.pruned`이다. 선언된 모든 이름의 class는 catalog에서 그것이 필요한 언어마다 표로 쓴다(`scripts/generate-event-classes.mjs`가 `packages/sok/wailsv3/src/event_classes.go`, `packages/sok/tauriv2/src/event_classes.rs`, `packages/workbench/event-classes.js`를 쓴다). 표가 catalog와 다르면 `make events-check`가 실패하며, catalog 검사는 native emit 지점의 class 인자도 읽어 catalog와 다른 것을 거부한다. plugin이나 sidecar는 manifest(`events`, `executable`처럼 패키지 안의 경로)에 자기 catalog 파일을 적고, 릴리스는 그 파일을 담으며, viewer가 설치된 manifest의 catalog를 읽는다. 이 저장소는 그것을 이름으로 부르지 않는다.

JavaScript의 emit site는 `emitEvent(`와 page writer의 batcher 호출이며, plugin의 경우 `runtime.log.<level>(event, fields)`와 `runtime.log[level]` called with the same arguments([plugin logging](plugins.md#logging))도 emit site이므로 plugin은 자체 emitter 없이 runtime을 직접 호출한다. plugin 호출의 `event`에는 `plugin.<plugin>.` 접두어가 없다. 검사는 이를 catalog의 항목 `plugin.<plugin>.<event>` 하나에 대응시키고, catalog에 없으면 `plugin.*.<event>`로 보고하며, level은 member에서 읽고(계산된 key는 level을 지정하지 않으므로 level을 검사하지 않는다), fields는 object literal 또는 builder `() => ({…})`에서 읽는다. 호출이 이름을 만들어 내면 다른 site처럼 `events:` marker가 필요하고, 질의 `runtime.log.enabled(level)`는 site가 아니다.

입력 사슬의 한 단계인 event는 `"cids": "required"`로 선언하고, 감사는 비어 있지 않은 문자열 `cids`가 없는 그 event의 줄을 거부한다(입력 사슬의 guard). catalog는 입력 종류마다 남겨야 하는 사슬도(`chains`) 선언한다. 첫 층에서 마지막 층까지 event의 순서 있는 목록이다. 이 catalog는 `input`을 선언한다: `native.input.key_down`, `host.input.relay`, `page.call`(식별자를 나르는 호출 `sidecarSend`), `host.sidecar.request`. 요청이 일으키는 sidecar의 event(예: `sidecar.vt.pty_write`)는 sidecar 저장소의 catalog가 선언하며 그 저장소가 사슬을 거기서 확장한다([sidecar catalog](#sidecar-catalog)). catalog는 [page 작업](#작업-사슬)의 사슬(`plugin`, `project`, `window`, `settings`, `update`)도 선언한다. 로그 감사는 선언된 사슬이 모두 완결되어 있기를 요구한다. 사슬의 첫 event에 나타나는 각 식별자는 모든 계층의 파일을 통틀어 그 사슬의 뒤 event마다 나타나야 한다. 다만 `error` event가 그 식별자를 가지면 그렇지 않다. 첫 event의 process에서 사슬의 첫 event부터 마지막 event까지 적용된 policy(첫 event 앞의 마지막 `log.policy` 또는 기본 policy, 그리고 마지막 event까지의 모든 `log.policy`) 중 하나라도 선언된 class와 level(여러 level로 선언된 event는 그 모든 level)을 저장하지 않는 뒤 event는 요구하지 않는다. `diagnostics.log`를 이름하는 `page.settings.change` 뒤의 `log.policy`는 그 변경부터 적용된다. page가 setting이 바뀔 때 setting의 policy를 gate에 넣기 때문이다. 좁은 policy는 애플리케이션을 실행하는 사람의 결정이기 때문이다([정책](#정책)). 실패한 입력은 그 error에서 끝난다. native library는 키의 실패(active application의 key window 밖에서 응답하지 않는 input method, 지원하지 않는 Ctrl 문자, commit된 text의 교체, 거부된 presentation)를 키의 식별자와 함께 `native.record.error`로 기록하고 page에 오류를 보고하며, page는 sidecar에 아무것도 보내지 않는다.

### 메모리 절약 이벤트

[메모리 절약](plugins.ko.md#메모리-절약)은 class `lifecycle`의 다음 page 이벤트를 낸다. 이유는 [tab memory](exposure.ko.md#tab-memory)의 열거다.

| 이벤트 | 수준 | 필드 | 뜻 |
| --- | --- | --- | --- |
| `page.tab.unloaded` | info | `tab`, `plugin`, `trigger` | `host.place`가 답한 뒤 숨겨진 탭이 unload되었다. `trigger`는 `delay`, `pressure`, `command` 중 하나다 |
| `page.tab.restored` | info | `tab`, `plugin`, `history` | unload된 탭이 restore되었다. session history를 얻지 못했으면 `history`는 `false`다 |
| `page.tab.restore.failed` | error | `tab`, `plugin`, `reason` | restore가 실패했다. 표면이 마운트되지 않았거나 문서 영역이 session history를 거부했다. 하나의 오류 표시가 이를 보인다 |
| `page.tab.unload.failed` | error | `tab`, `plugin`, `trigger`, `reason` | unload 시도 중 탭의 문서 영역 읽기가 실패했다. 시도는 끝나고 탭은 loaded로 남으며 하나의 오류 표시가 이를 보인다 |
| `page.tab.unload.skipped` | info | `trigger`, `seq`, `reasons` | pressure 보고가 후보를 찾지 못했거나, 보호가 생기거나 탭이 보여 unload 시도가 끝났다. `seq`는 pressure 보고의 번호다 |
| `page.tab.state.stored` | debug | `tab`, `bytes` | 탭 상태 저장소가 탭의 항목을 썼다. 상태, 표시, label을 포함한다 |
| `page.tab.state.orphan` | info | `tab` | load할 때의 맞춤이 `projects.json`의 어떤 layout에도 없는 탭의 항목을 지웠다 |
| `page.tab.session.stored` | debug | `tab`, `bytes` | core가 탭의 document region session history를 `tab-sessions/<tab>.json`에 썼다 |
| `page.tab.session.dropped` | warn | `tab`, `region`, `bytes` | document region의 session history가 decode한 크기로 1 MiB를 넘어 저장하지 않았다 |
| `page.tab.session.orphan` | info | `tab` | load할 때의 맞춤이 `projects.json`의 어떤 layout에도 없는 탭의 session file을 지웠다 |
| `page.tab.keep.changed` | info | `tab`, `keep` | `core.tab.keep`이 탭의 표시 `kept`를 정하거나 지웠다 |

각 이벤트는 그 emit site를 더하는 변경에서 `events.json`에 들어간다. catalog 검사는 어떤 source도 내지 않는 선언된 이벤트를 거부하기 때문이다.

### Sidecar catalog

sidecar catalog(sidecar 저장소의 `events.json`)는 member `sidecar`에 자기 sidecar의 이름을 쓰고, `layers: ["sidecar"]`만 나열하며, layer `sidecar`의 event를 선언한다. `sidecar.<name>.*` event와 lifecycle event `log.open`, `log.dropped`, `log.rotated`이다. `composeCatalogs(base, ...sidecars)`(`packages/log-contract`)는 이 저장소의 catalog와 설치된 sidecar의 catalog를 감사가 받는 하나의 catalog로 합친다. catalog가 sidecar 이름을 쓰지 않거나, 다른 layer를 나열하거나, 다른 layer의 event 또는 `sidecar.<name>.`과 `log.` 밖의 이름을 선언하거나, `sidecar.<name>.*` event를 두 번 선언하거나, base의 선언과 class, level, field, `cids`가 다른 `log.*` event를 선언하면 sidecar와 event 이름을 담은 오류로 거부한다. 둘 다 선언한 `log.*` event는 하나의 선언이므로 sidecar 파일의 lifecycle event(`log.open`, `from_seq`, `to_seq`, `count`, `bytes`, `reason`을 가진 `log.dropped`, `log.rotated`)는 layer `sidecar`로 통과하고, 빠졌거나 형이 틀린 field는 다른 event처럼 줄 번호를 가진 발견이다.

sidecar catalog는 `extends`, 곧 `{chain, after, events}`의 목록으로 base의 사슬을 확장한다. `chain`은 base의 사슬, `after`는 그 사슬의 event 중 문자열 field `name`을 가진 것, `events`는 그 뒤를 잇는 sidecar의 선언된 event이다. 확장은 `name`이 catalog의 `sidecar`인 `after` event의 상관 식별자에만 적용하므로, 다른 sidecar로 가는 키는 이 event를 요구받지 않는다. 그런 식별자마다 `events`의 모든 event가 폴더의 어느 파일에든 그 식별자와 함께 나타나야 하며, 빠진 event는 `after` event의 파일과 줄에서 `chain <chain> of <cid> lacks <event> after <after> of <sidecar>` 발견이 된다. catalog에 선언되지 않은 사슬, 사슬 밖이거나 field `name`이 없는 `after`, 빈 event 목록, 선언되지 않은 event를 쓰는 확장은 발견이 아니라 catalog의 오류이다.

감사는 감사하는 설정 폴더에서 설치된 sidecar의 catalog를 찾는다. `plugins/installed.json`이 설치된 각 sidecar의 폴더를 기록하고([installation](installation.ko.md)), 그 폴더의 `sidecar.json`이 member `events`에 catalog 파일을 쓰며([sidecars](sidecars.ko.md#선언과-시작)), member가 없는 sidecar는 catalog가 없으므로 그 event는 선언되지 않은 것이다. `plugins/installed.json`이 없는 설정 폴더는 설치된 sidecar가 없다. 형식이 다른 `plugins/installed.json`, 유효하지 않은 `sidecar.json`, 없거나 JSON이 아닌 catalog 파일, `composeCatalogs`가 거부하는 catalog는 파일 이름을 담은 오류로 감사를 멈춘다. `scripts/audit-run.mjs`와 `scripts/check-events.mjs --logs`는 설정 폴더마다 catalog를 합치는데, 폴더마다 설치한 sidecar가 다르기 때문이다.

### Plugin catalog

plugin은 자기 `plugin.json`의 member `events`가 적는 catalog에 event를 선언하며([plugin.json](plugins.ko.md#pluginjson)), 각 event의 이름은 전체 이름 `plugin.<plugin>.<event>`다. 이 catalog에서 생성한 class 표는 plugin event를 선언하지 않으므로 host의 writer는 plugin catalog의 class도 가진다. host는 시작할 때와 설치된 plugin이 바뀔 때마다([변경 적용](installation.ko.md#변경-적용)) 활성화된 설치 plugin의 catalog를 읽고, plugin event에 그 plugin의 catalog가 선언한 class를 주므로, event는 그 class의 gate를 지나고 그 줄은 class를 담는다. 어느 catalog도 선언하지 않은 이름은 `undeclared`로 남는다. 없거나 JSON이 아니거나 `plugin.<plugin>.` 밖의 이름이나 다섯 class가 아닌 class를 선언해서 host가 쓸 수 없는 catalog는 장소 `plugin catalog`의 오류 기록이며 text에 파일을 담고(`<file>: the event catalog of plugin <plugin> is not JSON`, `<file>: the event catalog of plugin <plugin> does not exist`, `<file>: the event <name> is not an event of plugin <plugin> (plugin.<plugin>.<event>)`, `<file>: the event <name> has the class <class>, which is not lifecycle, input, call, io or frame`), 다른 plugin은 class를 유지한다. 도구는 `PluginEventClasses`(Go)와 `plugin_event_classes`(Rust)로 이를 읽는다.

### 입구

다음 입구는 호출 지점이 기록을 쓰지 않아도 기록한다.

- 메인 page의 host 호출: 두 runtime이 `host.call` 둘레에 두는 감싸개(`settlingCalls`)가 필드 `name`, `args`(인자의 JSON, 직렬화하는 동안 1024바이트에서 자르며 `truncated: true`), `micros`, `ok`, 거절된 호출이면 `error`를 가진 event `page.call`을 낸다. level은 `debug`이고 거절된 호출은 `warn`이다. 호출 `log`와 `performance`는 기록하지 않는다. 기록된 `log` 호출이 자기 자신을 기록하기 때문이다. `logQuery`도 기록하지 않는다. debug 화면은 기록기가 알린 event에 답해 묻기 때문이다. `overlayUpdate`와 `overlayPlace`도 기록하지 않는다. 네이티브 모달을 그리고 놓는 호출로 집계로 저장하는 class `frame`이고, event 파일을 따라가는 화면은 늘어난 행마다 다시 그리므로 기록하면 스스로 먹이가 되기 때문이다;
- 표면 문서의 host 호출: 각 application의 runtime `page` 객체는 모든 호출을 `surfaceCalls`(`packages/workbench/surface-calls.js`)로 보내고, 이것이 두 runtime에서 같은 이름과 같은 인자로 같은 event `page.call`을 낸다(인자는 Wails runtime이 넘기는 호출의 인자다). event는 문서의 batcher를 거치므로 한 turn의 호출은 호출 `log` 한 번으로 host에 가고, 문서의 `report`도 같은 batcher 뒤에 쌓여 문서의 기록과 호출이 순서를 지킨다. 호출 `log`는 기록하지 않는다. 중계가 실패하면 문서의 console에 쓴다. 문서에는 달리 알릴 곳이 없기 때문이다;
- 창 event: host가 창에 등록하는 모든 event는 `window`와 `kind`를 가진 event `host.window.event`다. host는 자기 framework가 알리는 kind를 낸다(Wails는 `show`, `hide`, `focus`, `lost_focus`, `web_process_ended`, `navigation_committed`를, Tauri는 `occlusion_changed`를 알린다). 그래서 host가 저장하는 kind는 [host 계약](host-contract.ko.md)의 목록의 부분집합이다;
- 애플리케이션 event: host가 애플리케이션에 등록하는 모든 event는 `kind`를 가진 event `host.app.event`다. host는 자기 framework가 알리는 kind를 저장한다(Wails는 `started`, `activated`, `deactivated`, `exit_requested`, `exit`를, Tauri는 `started`, `exit_requested`, `exit`를 알린다);
- endpoint 메서드: [endpoint](endpoint.md) client의 모든 요청은 필드 `name`(메서드), `args`(받은 그대로의 params, 요청에 없으면 `null`이며, 복사하기 전에 문자 경계에서 1024바이트로 자르고 잘렸으면 `truncated: true`), `micros`(요청을 받은 때부터 결과까지), `ok`, 실패한 요청이면 `error`(client가 받는 코드와 메시지 `<code>: <message>`이며 같은 방식으로 자른다)를 가진 event `host.endpoint.call`이다. level은 `debug`이고 실패한 요청은 `warn`이며, 성능 trace가 켜져 있는지와 상관없다. 구독 변경(`status.watch`, `status.unwatch`)은 답을 쓸 때 기록하고, event는 답을 쓰기 전에 저장한다;
- host 쪽의 host 호출: main page와 surface 문서가 host에 하는 모든 호출은 필드 `name`(호출의 snake case 이름이며 Tauri command의 이름), `args`(호출 순서대로의 인자를 담은 JSON 배열이며 각 값은 한도까지만 직렬화하고 문자 경계에서 1024바이트로 자르며 잘렸으면 `truncated: true`), `micros`(호출을 받은 때부터 결과까지), `ok`, 실패한 호출이면 `error`(page가 받는 글이며 같은 방식으로 자른다)를 가진 event `host.binding.call`이다. level은 `debug`이고 실패한 호출은 `warn`이며, 성능 trace가 켜져 있는지와 상관없고 host가 저장하므로 멈춘 page보다 오래 남는다. 결과 없이 끝난 호출(panic하는 command, Tauri host에서 프레임워크가 거절한 인자)은 오류 `the call ended without a result`를 가진 실패한 호출이다. Wails host는 main page의 호출을 바인딩 메서드 `Bindings.Call` 하나로, surface 문서의 호출을 `invokeNative`로 지나가게 하고, Tauri host는 모든 command를 `bindings!` 매크로 안에서 정의한다([hosts](hosts.ko.md)). 호출 `log`도 다른 호출처럼 기록한다;
- 한도가 있는 buffer: host의 buffer가 가득 차면 가장 새 메시지를 거절하고, 호출자가 있으면 오류를 돌려주며, level `warn`의 event `host.buffer.dropped`(`buffer`, `count`, `bytes`, `reason`)를 저장한다. 한도는 [상한](#상한)에 있다;
- registry 명령: page는 요청 `command.run`에 모두 함수 하나로 답하며, 그 함수가 필드 `name`, `micros`, `ok`, 실패한 명령이면 `error`를 가진 event `page.command`를 낸다(level은 `debug`, 실패한 명령은 `warn`). 성능 trace가 켜져 있든 꺼져 있든 같다;
- native 활동: native 라이브러리는 애플리케이션(`previous_pid`와 `previous_bundle`, 곧 그 앞에 workspace가 마지막으로 활성화한 애플리케이션을 가진 `native.app.activated`로 활성화의 출처가 기록에 남는다. `native.app.deactivated`, `native.app.hidden`, `native.app.unhidden`), 창(창 번호와 first responder의 class를 가진 `native.window.key`, `native.window.resign_key`, `native.window.main`, `native.window.resign_main`, `native.window.miniaturized`, `native.window.deminiaturized`, 그리고 `visible`을 가진 `native.window.occlusion`), 입력 소스(`native.input.source_changed`)의 알림과 창의 first responder 변경마다(창 번호와 class `from`, `to`를 가진 `native.window.first_responder`. 창이 다음에 갱신될 때 이전 갱신의 first responder와 비교해 기록한다. AppKit은 text field의 창과 field editor를 거치므로 포커스 이동 하나가 event 여럿일 수 있다) level `info`로 기록한다. 그림 영역이 답하는 입력기 질의마다 level `debug`의 `native.input.query`가 `call`(`markedRange`, `selectedRange`, `hasMarkedText`, `firstRectForCharacterRange`, `characterIndexForPoint`), 인자, `answer`, 영역의 `focus`와 함께 있다. host는 writer를 시작할 때 observer를 설치한다;
- native 등록: native 라이브러리의 모든 observer, monitor, key-value observer, run loop observer, dispatch source, Apple event handler, delegate는 하나의 입구 `observe.m`(`native/darwin/src`)을 통해 등록한다. 입구는 등록마다 `native.observe.registered`(`source`, `kind`, `target`, `mode`, `registrations`)를 level `info`로, 거부된 등록마다 `native.observe.failed`(`source`, `kind`, `reason`)를 level `error`로 저장하고, 모든 전달을 `source` 이름으로 센다. source의 mode는 셋 중 하나다. `record`는 전달마다 `native.observe.delivered`(`source`, `count`)를 level `debug`로 저장하고, `stored`는 수신자가 발생마다 자기 event를 저장하므로 세기만 하며, `count`는 frame이나 장치 속도의 전달에 대해 `native.observe.counted`(`source`, `count`, `total`, `micros`)를 level `debug`로 초당 한 번 이하로 저장한다. 이 event는 이전 요약 이후 전달 수를 정확히 담는다. 마지막 요약 뒤의 수는 `sp_observe_flush`가 저장하며, 두 host는 종료할 때 writer의 마지막 flush 전에 플랫폼(`FlushNativeObservers`, `flush_native_observers`)을 통해 이를 호출한다. key-value 등록은 context를 전달하고, 플랫폼의 view는 그 context를 비교한다. 플랫폼이 view를 자기 자신의 observer로 등록하므로 그 알림도 같은 method에 도달하기 때문이다. 등록 호출에는 gate가 필요 없다. 전달 한 번은 atomic 덧셈 하나이고 `record` 전달은 stack의 제한된 buffer에 쓰며 할당하지 않는다. 실패하는 native 호출은 `sp_log_error`나 `sp_log_info`를 저장하며, census에서 이 둘은 `native.record.error`와 `native.record.info`의 emit 지점이다. `sp_process_when_exited`가 기다린 시간 안에 끝나지 않는 process는 `native.process.exit_timeout`(`pid`, `seconds`)을 level `warn`으로 저장한다;
- sidecar 수명: 표준 입출력 sidecar 프로세스는 host가 시작할 때 event `host.sidecar.start`(`name`, `pid`), 끝났을 때 `host.sidecar.exit`(`name`, `pid`, `status`, `stopping`)이고, 영구 service 연결은 `host.sidecar.connect`(`name`, `pid`, `spawned`)와 `host.sidecar.disconnect`(`name`, `pid`, `stopping`, `violation`)이며 모두 level은 `info`다;
- sidecar 준비 시간: host가 시작한 sidecar가 시작 뒤 처음 보내는 메시지 줄은 level `debug`의 event `host.trace.sidecar.ready`(`sidecar`, `pid`, `ms`)다. `ms`는 시작부터 그 줄까지의 밀리초다. 다른 host가 시작한 프로세스는 이 event를 남기지 않는다;
- sidecar 쓰기: host의 writer는 한 줄이 queue에 들어간 때부터 쓰기를 시작할 때까지 1초 이상 기다렸거나, sidecar의 표준 입력이나 연결에 쓰는 데 10 ms 이상 걸리면 event `host.sidecar.write_wait`(`name`, `bytes`, `queued_us`, `write_us`)를 level `info`로 저장한다. `queued_us`는 앞의 시간이고 `write_us`는 뒤의 시간이다. 보류한 reply나 close는 보류한 때부터 센다. sidecar의 event `sidecar.<name>.read_wait`와 함께, log는 host가 늦게 쓴 줄과 깨어나지 않은 sidecar의 읽기를 구분한다.
- 허용된 제거: 프로젝트를 제거해도 되는지 질문을 받은 창이 끝나면 제거를 허용하며, 그 요청마다 event `host.project.removal_allowed`(`window`, `project`)를 level `info`로 저장한다;
- 설정 변경: 설정 파일의 변경마다 event `host.workspace.settings`(`scope`, `set`, `removed`)를 level `info`로 저장한다. `set`과 `removed`는 키만 담고 값은 담지 않는다;
- 알림 센터: 상태, 게시된 알림, 눌린 알림마다 event `host.notification.event`(`type`, `authorization`, `window`, `surface`)를 level `info`로 저장하고, 실패마다 장소 `notification`의 `error` 기록을 저장한다;
- 애플리케이션 업데이트: host는 분리 실행하는 `sok app update`를 event log의 마지막 flush 전에 시작하고 event `host.update.start`(명령의 `pid`, `command` 줄)를 level `info`로 저장한다. 시작에 실패하면 `error` 기록이다. `sok`은 대상 설정 폴더에 자신의 event 파일 `logs/sok-<boot>.jsonl`을 쓰고 `sok.command`(결과, 종료 상태, 오류 글)와 `sok.panic`을 저장한다([명령줄](cli.ko.md#event-log)). 분리 실행한 명령은 host의 표준 오류를 그대로 쓰므로 메시지는 `logs/host-<boot>.stderr`에도 있다. 종료 상태는 `sok.command` 밖에는 읽는 쪽이 없다. 읽을 수 있는 host가 명령이 번들을 바꾸기 전에 끝나기 때문이다. 실패한 명령은 이전 번들을 되돌려 시작하며, 그 실행은 `log.open`으로 시작한다;
- 진단 빌드의 relaunch: host는 `diagnostics.host.relaunch`의 분리 실행하는 `sok app relaunch`를 event log의 마지막 flush 전에 시작하고 event `host.relaunch.start`(명령의 `pid`, `command` 줄)를 level `info`로 저장한다. 시작에 실패하면 `error` 기록이다([endpoint](endpoint.ko.md#진단-빌드));
- crash report: host는 시작할 때 platform이 알려 주는 폴더(`DiagnosticReportsDirectory`, macOS에서는 사용자 Library 폴더의 `Logs/DiagnosticReports`)에서 애플리케이션의 crash report를 찾고, 전에 알리지 않은 report마다 level `warn`의 event `host.crash.found`(report의 `path`, `pid`, `time`)를 저장한다. report는 `<executable name>-<date>.ips` 파일이며, 첫 줄은 실행 파일 이름과 같은 `app_name`과 `timestamp`를 가진 JSON header이고 그 뒤에 `pid`가 있는 JSON 본문이 온다. 다른 이름이나 다른 애플리케이션의 파일은 이 애플리케이션의 report가 아니다. lookup은 이름 순서로 최신 64개 파일을 파일마다 최대 16 MiB까지 읽는다. 알린 경로는 `logs/crash-found.txt`(한 줄에 경로 하나, lookup마다 lookup이 아직 보는 report만 남기도록 다시 씀)에 두므로 report는 한 번만 알리고 파일은 폴더의 기록만큼 자라지 않는다. 읽을 수 없는 report와 나열할 수 없는 폴더는 파일을 밝힌 place `crash reports`의 `error` 기록이며, 읽을 수 없는 report도 목록에 올라 오류를 한 번만 쓴다. 없는 폴더는 report가 없는 것이다. macOS native 라이브러리가 폴더를 알려 주고(`sp_diagnostic_reports_directory`), 그렇지 못한 platform은 `crash reports is not implemented on <os>`를 돌려준다.
- 실행 종료: host가 이전 실행이 지우지 않고 남긴 `process.lock`을 넘겨받을 때, writer가 시작된 뒤 level `error`로 event `host.run.unrecorded-end`를 저장한다. 내용이 현재 형식이면 `boot`와 `pid`가 그 실행을 가리키고, 아니면 둘 다 null이다. 내용이 현재 형식이 아니면 256 바이트로 자른 내용이 `previous`로 들어간다([endpoint](endpoint.ko.md#주소-확인)).
- 정지: event를 쓰는 모든 process는 자기 event를 실행하는 것의 정지를 그 밖의 thread에서, window check 없이 기록한다. 감시받는 thread(host의 main thread)나 runtime(sidecar의 runtime)이 250 ms마다 heartbeat를 쓰고, 감시 thread가 250 ms마다 그것을 시계와 비교한다. 실행되지 않는 thread를 알리는 event 원천이 없기 때문이다. 1 s 이상 늦은 heartbeat는 process의 정지 event로 level `warn`과 `late_ms`를 가지며(host는 `host.stall`, sidecar는 `sidecar.<name>.runtime_stall`), 1초 동안 표본한 process thread들의 stack은 `logs/stall-<role>-<pid>-<ms>.txt`에 들어가 `path`와, 파일을 쓰지 못했을 때 `error`를 가진 dump event가 되고(`host.stall.sampled`, `sidecar.<name>.stall_dump`), 다음 heartbeat는 level `info`와 `stalled_ms`를 가진 재개 event다(`host.stall.resumed`, `sidecar.<name>.runtime_resumed`).
- 정지 dump: 창 검사의 요청이 3초 뒤에도 대기 중이면 검사는 같은 turn에 host와 page process의 thread를 `logs/stall-<pid>-<ms>.txt`와 `logs/stall-<pid>-<ms>-page-<pid>.txt`로 sample하고, host 파일의 경로를 진단 method `diagnostics.stall.dump`(`path`)로 보낸다. 요청 한도는 요청이 답에 이르지 못하면 다시 표본한다. host는 level `warn`의 event `host.stall.dump`(`path`)를 저장하고 `{boot, seq}`로 답하므로 dump를 log에서 찾는다. 정지는 host가 스스로 기록할 수 없는 유일한 출처다. host가 실행되지 않기 때문이며, method를 처리하는 endpoint thread는 page를 기다리지 않는다.
- 메인 page 문서의 시작: page가 처음 적재하는 모듈이 필드 `time_origin`(문서 시계의 원점, `performance.timeOrigin`)과 `url`을 가진 event `page.start`를 내므로, 새 시계로 새 문서를 시작하는 reload가 timeline의 표시된 경계가 된다;
- 사람이 보는 오류의 표시. 이것이 `error` event를 낸다.

task의 종료처럼 어떤 입구도 덮지 못하는 원천은 소스 lint가 선언이나 사유 주석이 없는 event를 나열한다. lint는 증명이 아니다. 범위는 실행 중에 판단한다: window check가 선언된 명령과 native 입력으로 선언된 원천을 하나씩 구동하고 그 선언된 event를 요구한다.

### 작업 사슬

page가 애플리케이션을 바꾸는 작업은 상관 식별자 `p<page의 time origin>.<n>`으로 묶인 event 사슬이다. page는 작업이 시작될 때 식별자를 부여하고(`beginOperation`, `packages/workbench/operations.js`), 사슬의 첫 event를 그 식별자와 함께 저장하며, 작업을 수행하는 host 호출에 `host.call(name, arg, {cids})`로 식별자를 함께 넘긴다. Wails page는 목록을 바인딩 메서드 `Bindings.Call`의 네 번째 인자(`method`, `args`, `cids`)로 보내고, Tauri page는 command의 인자 옆 key `cids`로 보낸다. page는 호출을 식별자와 함께 `page.call`로, host는 같은 식별자와 함께 `host.binding.call`로 기록하며, 호출이 성공했는지는 묻지 않는다. 줄이 담을 수 있는 식별자의 목록이 아닌 목록(빈 식별자, 따옴표, 역슬래시, 제어 문자가 든 식별자)은 그 식별자를 밝힌 오류로 거절한다. 메서드는 실행되지 않고, 실패한 `host.binding.call`은 식별자를 담지 않는다.

| 사슬 | 첫 event(필드) | 작업을 수행하는 host 호출 |
| --- | --- | --- |
| `plugin` | `page.plugin.operation`(`action`은 `install`, `update`, `remove`, `enable`, `disable`, `plugin`) | `pluginsRun` |
| `project` | `page.project.operation`(`action`은 `open` 또는 `remove`, `project`) | `projectOpen`, 제거는 `projectRemoveAsk`와 `projectRelease` |
| `window` | `page.window.operation`(`action`은 `new`, `close`, `close_kept`) | `windowNew`, `windowClose`, `windowCloseKept` |
| `settings` | `page.settings.change`(`scope`, `actor`, `keys`) | kind가 `settings`인 `workspace` |
| `update` | `page.update.operation`(`action`은 `update`, `version`) | `appUpdateStage`와 `appUpdateApply` |

사슬 `window`는 첫 event와 `host.binding.call`이다. 창을 닫는 호출은 page가 그 완료를 기록하기 전에 page를 끝내고 host는 사라진 창의 batch를 거부하므로, page는 호출 앞에서 첫 event를 저장하고 대기열을 비우며 그 사슬은 `page.call`을 요구하지 않는다. 그 외의 사슬은 첫 event, `page.call`, `host.binding.call`이며, 감사는 첫 event의 식별자마다 나머지에 나타나면 사슬이 완전하다고 본다. 자기 창을 닫는 것은 page를 끝내므로, page는 창을 닫는 host 호출 앞에서 자기 event 대기열을 비우고, 닫기 사슬의 첫 event가 page가 끝나기 전에 host의 writer에 도달한다. 첫 event는 작업이 시작될 때, 그리고 host 호출이 따를 때만 저장한다. 남은 탭이 거절한 제거와 잘못된 값으로 거절된 설정 변경은 작업을 시작하지 않는다. 설정 변경의 `actor`는 바꾼 주체이며 선언된 command(`core.settings.set`, `core.settings.theme`, `core.text.larger`)다. 변경의 모든 경로가 actor를 넘기고, `set`은 actor 없는 변경을 거절한다. `keys`는 바뀐 key를 쉼표로 이은 것이며 값은 담지 않는다(값의 기록은 설정 파일이다). 프로젝트 창을 닫는 것은 `window` 사슬이고, 프로젝트가 registry에서 빠지는 것은 `project` 사슬이다.

page 없이 host가 시작하는 작업(Dock 메뉴가 여는 창, 프로젝트 제거에 대한 창의 응답, 애플리케이션 종료)은 사슬이 아니다. host가 자기 event(`host.window.event`, `host.project.removal_allowed`, `host.app.event`)를 저장한다. `sok`으로 설치한 plugin은 그 도구의 파일에 `sok.command`를 남긴다.

### 결과 형식

호출의 입구는 결과를 한 형식으로 밝힌다. catalog가 `"result": true`로 표시하고 audit가 검사한다(`page.call`, `page.command`, `host.endpoint.call`, `host.binding.call`, `host.sidecar.reply`).

- `ok`는 boolean이다. `micros`는 음이 아닌 정수다. 호출을 받은 때(endpoint 요청, page의 호출, command, sidecar의 메시지)부터 결과까지의 시간을 event를 저장하는 layer의 단조 시계로 잰다. sidecar의 reply는 host가 queue에 넣은 요청부터 잰다.
- `error`는 `ok`가 `false`일 때만 있으며 `<code>: <text>`다. 입구의 호출자가 받는 code와 text이고 1,024 byte로 자른다. 자기 code가 없는 실패는 그 입구의 내부 code를 가진다. endpoint 요청, host 호출, sidecar의 reply는 `-32603`이고 command는 `-32000`이다(등록된 함수의 예외에 endpoint가 답하는 code). code가 있는 실패는 그 code를 유지한다(`RPCError`, `ExposureError`).
- 성공한 호출은 level `debug`(sidecar의 reply는 `info`), 실패한 호출은 `warn`이다.

sidecar는 요청의 correlation identifier를 reply 줄의 `cids` member에 `surface`, `body`와 나란히 쓰고, 실패한 요청은 body의 `error` member로 밝힌다. terminal sidecar는 프로토콜의 실패 88개를 `cids` 없이 body의 `error`로 답한다. 그 저장소가 요청 줄의 `cids`를 이 reply 줄에 써야 `host.sidecar.reply`가 요청을 가리킨다.

host는 sidecar의 reply를 event `host.sidecar.reply`(`name`, `surface`, `bytes`(body의 크기), `ok`, `micros?`, `error?`)로 저장한다. 대상은 줄의 `cids` member가 요청의 correlation identifier를 가리키거나 body가 `error` member를 가진 객체인 sidecar의 메시지이며, level은 `info`이고 오류는 `warn`이다. event는 줄의 `cids`를 나른다. `micros`는 host가 그 요청 중 첫 번째를 queue에 넣은 때(`host.sidecar.request`)부터의 시간이며, host가 요청을 더는 기억하지 않으면 없다: host는 식별자가 있는 요청을 최대 4,096개 기억하고, 한도에서 가장 오래된 요청을 잊으며, 잊은 요청마다 `host.buffer.dropped`(buffer `sidecar reply ledger`)로 세고, 두 event가 시각을 밝히므로 그 reply의 `micros`만 잃는다. 요청의 순서는 기억하는 한도의 두 배에 이를 때마다 기다리는 요청만 남기도록 줄이므로 응답한 요청이 순서를 키우지 않는다. `error`의 글은 body의 `error` member이고, 문자열은 그대로, 다른 값은 JSON 글로 쓴다. sidecar의 실패(멈춤 요청이 없는 `host.sidecar.exit`, `sidecar-failure`, 지속 service의 연결 끊김)는 기다리는 요청이 있는 표면마다 `ok: false`, `bytes: 0`과 실패 이유를 가진 event 하나를 저장하고 그 중 최신 64개의 식별자를 나열한다. host가 요청한 멈춤은 `host.sidecar.exit`가 밝히므로 저장하지 않는다. sidecar가 프로토콜상 답하지 않는 요청(예: 입력)은 한도나 실패까지 기억에 남으므로 실패는 그것을 sidecar가 답하지 않은 요청으로 나열한다.

### 시험 표시

window check는 시험 대상 애플리케이션의 event log에 시험마다 표시를 남기므로, 시험은 로그의 위치 범위다. 진단 method `diagnostics.test.mark`([endpoint](endpoint.ko.md))는 시험이 시작할 때 event `host.test.start`(`name`, `run`)를, 끝날 때 `host.test.end`(`name`, `run`, `pass`, `fail`, `skip` 중 하나인 `result`)를 저장한다. 둘 다 layer `host`, class `lifecycle`, level `info`이며, flush한 뒤 event 파일의 `boot`와 표시 줄의 `seq`인 `{boot, seq}`로 답한다. 위치는 `(boot, seq)`다. 한 애플리케이션이 여러 실행을 처리하므로 실행 식별자는 `log.open`이 아니라 이 event에 실린다. window-check 라이브러리는 검사가 session을 열 때 시작을, 검사의 정리와 오류 점검 뒤에 끝을 표시하며, 본문이나 정리가 실패했으면 `fail`이다. 표시마다 `{run, app, config, name, kind, boot, seq, ts_us}`(`config`는 애플리케이션의 설정 폴더)를 실행 폴더(`SOKSAK_RUN_FOLDER`)의 `marks.jsonl`에 덧붙이고, `expectError`를 부르면 실행 중인 시험에 대해 `{run, app, config, name, kind: "expect_error", pattern, flags, ts_us}`를, `expectEvent(name)`를 부르면 `{run, app, config, name, kind: "expect_event", event, ts_us}`를 덧붙인다. `SOKSAK_RUN_ID`가 있을 때만 표시하며, 이 값은 시험 실행기가 정한다([examples](../operations/examples.ko.md#창-검사)).

## 검사

`soksak-log-check`(패키지 `@soksak/log-contract`, `packages/log-contract`)는 로그를 schema와 catalog로 검증한다: 줄 구조, 선언된 event마다의 class(선언된 event인데 `class`가 없거나 다른 class이면 발견 사항이고, `undeclared`가 표시된 선언된 event도 그렇다), 파일마다의 level(main 파일은 `error`, `warn`, `info`, debug 파일은 `debug`, `trace`이며 `log.open`과 `log.rotated`가 모든 파일을 시작한다), 선언된 event, 연속된 `seq`와 `log.dropped`로 설명되는 틈, 입력 종류마다 선언된 사슬, 시험이 선언한 것 외의 `error` 없음. 단위 시험과 window check는 자기 로그를 남기고, gate는 남은 모든 로그를 검증하며, 실패한 실행의 로그는 분류하기 전까지 보관한다.

실행의 감사 `node scripts/audit-run.mjs <실행 폴더>`는 `pnpm verify:windows`와 활성화 등급의 끝(`scripts/node-tests.mjs`의 `--script verify` 또는 `--script verify:<등급>`)에서 시험이 실패했을 때도 실행된다. 실행 폴더의 `marks.jsonl`을 읽고, 표시의 `config`에서 설정 폴더를 얻어, 그 안의 모든 층의 모든 event 파일(host, `sok`, 각 sidecar의 `<role>-<pid>-<time>.jsonl` 파일과 그 세대 `.1`부터 `.5`, debug 파일)을, 이 저장소의 catalog에 그 폴더에 설치된 sidecar의 catalog를 합친 것(`composeCatalogs`, [sidecar catalog](#sidecar-catalog))으로 감사한다: 줄 구조, 선언 없는 event(catalog가 layer `sidecar`를 나열하므로 이 층도 감사한다), 한 process의 세대와 debug 파일을 건넌 연속된 `seq`, 폴더의 파일을 합쳐 본 선언된 사슬, 모든 `error` event. 시험의 범위는 애플리케이션 로그에서 `host.test.start`와 `host.test.end` 표시 사이의 줄이며 `(boot, seq)`로 정하고, 다른 process의 event는 `ts_us`로 범위에 놓는다. 범위에 `error`가 든 모든 시험이 그 text와 맞는 pattern(`expect_error`)을 선언했으면 `error`는 선언된 것이고, 실행의 첫 시작 표시부터 마지막 끝 표시까지의 그 밖의 `error`는(시험 사이의 것 포함) finding이며, 끝 표시 없는 시작 표시도 finding이다. 첫 시작 표시 앞이나 마지막 끝 표시 뒤의 줄에 놓인 finding(`error`, `seq`의 빈틈, 멈춘 사슬)은 실행이 판정하지 않는다. 설정 폴더는 이전 실행과 사람의 애플리케이션 사용의 로그도 담고, 하네스는 시험의 끝 표시를 cleanup과 그 오류 뒤에 쓰며, `scripts/check-events.mjs --logs`가 폴더의 모든 finding을 보고하기 때문이다. `expectEvent`로 event(`expect_event`)를 선언한 시험의 범위에 그 이름의 event가 없으면 끝 표시에서 빠진 event 이름을 밝히는 finding이다. 감사는 실행 폴더에 `judgment.json`을 쓰며, 시험과 애플리케이션마다 한 행 `{name, app, result, boot, from, to, errors, expected, missing}`이다. `from`과 `to`는 시작·끝 표시의 `{seq, file, line}`이고(끝 표시가 없으면 `to`는 null), `errors`는 범위의 `error` event를 `{file, line, text, declared}`로, `expected`는 선언한 event마다 범위에서 찾은 수를, `missing`은 하나도 없는 선언을 나열하며, 끝 표시가 있고 `missing`이 비고 모든 error가 선언된 경우에만 `result`가 `pass`다. finding은 표준 오류의 한 줄 `<file>:<line>: <message>`이고, finding이 있거나 실행에 `marks.jsonl`이 없으면 종료 상태는 1이다. `node scripts/check-events.mjs --logs <config-dir>…`는 표시 없이 설정 폴더를 감사하며 모든 `error` event를 보고한다. workflow `ci.yml`은 창 검사를 실행하지 않으므로 결함 fixture를 쓰는 감사 시험(`pnpm test`)을 실행한다. 실제 실행의 감사는 로그인한 데스크톱이 있는 self-hosted runner에서 `pnpm verify:windows`와 이 감사를 실행하고 실패한 job의 실행 폴더를 남기는 workflow `window-checks.yml`([지속적 통합](../operations/examples.ko.md#지속적-통합))과 개발 컴퓨터의 창 검사 실행에 속한다.

### 분량 예산

catalog는 로그 분량의 예산을 `budget`으로 선언한다: class마다 한 설정 폴더의 process들이 함께 저장해도 되는 분당 event 수와 byte 수(줄과 그 줄바꿈)이다. 실행의 감사(`scripts/audit-run.mjs`)는 실행의 첫 시작 표시부터 마지막 끝 표시까지 각 설정 폴더의 모든 파일의 모든 줄을 세어 그 구간의 분으로 나누고, 결과를 `judgment.json`의 `volume`(`{config, minutes, classes}`, class마다 `{events, bytes, eventsPerMinute, bytesPerMinute}`)에 쓰며, 구간이 1분 이상이면 예산을 넘은 class마다 finding을 보고한다. 더 짧은 구간의 비율은 몰림의 비율이므로 판정 없이 기록한다. 예산이 이름하지 않은 class는 모든 실행에서 finding이며, `budget`이 없는 catalog는 거부한다. 예산은 2026-10-14에 두 애플리케이션에서 돈 창 검사의 1분 이상 실행 23개에서 class마다 가장 큰 비율의 1.5배이다:

| class | 분당 event | 분당 byte | 측정한 최대 |
|---|---|---|---|
| `lifecycle` | 7,700 | 2,000,000 | event 5,092, byte 1,315,749 |
| `input` | 8,600 | 2,700,000 | event 5,722, byte 1,785,045 |
| `call` | 33,500 | 18,200,000 | event 22,192, byte 12,073,237 |
| `io` | 4,900 | 19,500,000 | event 3,205, byte 12,936,232 |
| `frame` | 2,300 | 750,000 | event 1,501, byte 496,215 |

예산의 합은 분당 약 43 MB이므로 6 GiB의 보존 한도([보존](#보존))는 예산에서 창 검사 최소 2.5시간을 담는다. 사람의 사용은 훨씬 적게 저장하고, `.keep` 파일이 있는 run은 지우지 않으므로 실패의 로그는 분류될 때까지 남는다.

### Census

발생 원천은 기록 없이 사라질 수 있는 자리다: 빈 catch, 버려진 결과, goroutine, 등록된 observer, delegate, 오류 반환. census는 언어별 규칙으로 그런 원천을 모두 찾고, 같은 함수에 저장된 event나 reason marker 중 하나를 요구한다. marker의 형식은 하나, `(default|silent): <reason>`이다(`default:`는 기본값이 계약의 일부인 까닭을, `silent:`는 아무것도 기록하지 않는 까닭을 적는다). 원천의 줄, 일치한 범위 안, 또는 바로 위에 이어진 주석 줄에 적고, 까닭은 10자 이상이다. 단어의 다른 형식(`Default:`, `Silent:`, `fallback:`, 다른 구분자, 다른 언어)으로 시작하는 주석은 파일과 줄을 이름으로 말하는 오류다. 기준선은 없다: 둘 다 없는 원천은 `<file>:<line>: <rule> has neither an event nor a stated reason`으로 실패한다.

`soksak-events [--census <file>] [--catalog <file>] [--list] [repository]`(패키지 `@soksak/plugin-api`, `packages/plugin-api/events-check.js`)는 `packages/plugin-api/census-rules.json`의 규칙을 적용하며 모든 저장소가 호출한다. 규칙은 `id`, `language`, 주석을 뺀 코드에서 일치시키는 `pattern`, `event-or-reason` 또는 `entrance`인 `requires`(원천은 저장소의 입구 파일에서만 허용되고, 다른 곳에서는 event도 marker도 받아들이지 않는다), 설명을 가진다. 규칙은 `js.empty-catch`, `js.swallowing-catch`, `go.go-statement`, `go.recover`, `rs.ok-discard`, `rs.unwrap-or`, `rs.dropped-send`, `m.registration`(observer, monitor, KVO, event tap, run loop source, dispatch source, timer 등록), `m.delegate`, `m.error-return`(`return NO;`)이다. 원천의 event는 catalog 입구의 emit 지점(`sitesOf`)이고, 함수는 Go와 Rust에서는 가장 안쪽의 이름 있는 함수, JavaScript에서는 가장 안쪽의 함수 형태 block, Objective-C에서는 가장 바깥 block이다. 반환 경로 규칙은 근사이고 등록 규칙은 정확하다.

저장소의 선언 파일(`--census`)은 `exclude`(census와 catalog 검사가 뺄 경로의 pattern. 제외된 파일(vendored bundle 등)은 읽거나 파싱하지 않는다), `entrances`(규칙 id와 입구 파일의 pattern), `pending`(규칙 id와 입구를 만들어 규칙을 켜는 checklist 항목)을 가진다. 대기 중인 규칙은 강제하지 않으며, 명령은 그 항목과 대기하는 발견의 수를 출력하므로(`--list`는 각 발견을 출력한다) 꺼진 규칙은 침묵하지 않는다. 어떤 규칙에도 없는 규칙 id, 모르는 key, checklist id가 아닌 pending 값은 오류다. `--catalog`는 소스의 emit 지점도 그 경로의 catalog와 양방향으로 대조한다([Catalog](#catalog)). `make census-check`는 `scripts/census.json`으로 이 저장소에서 명령을 실행하고, `pnpm test`는 `scripts/test/census.test.mjs`에서 실행하며, `scripts/check-fallbacks.mjs`는 같은 marker를 쓰고 다른 형식을 거부한다.

선언 파일은 `emitters`도 가진다. 저장소 자기 코드의 writer 메서드의 emit 지점이며, 이 package에 저장소 이름 표 없이도 catalog 검사가 그 지점을 찾는다. `emitters`는 언어(`go`, `rs`, `m`, `js`)를 emitter 목록에 대응시키고, emitter는 `{call, level | fixed, event, fields?, name?, only?}`이다. `call`은 메서드나 함수의 이름이다(검사는 `call(`을 찾고 정의 `fn call(`은 건너뛴다). `level`, `event`, `fields`는 level, event 이름, field 객체가 있는 인자의 0부터 센 위치이고(호출에 field가 없으면 `fields`는 쓰지 않는다), `fixed`는 level 인자가 없는 호출의 level이며(`level`과 `fixed`는 함께 쓸 수 없고 하나는 있어야 한다), `name`은 그런 호출이 저장하는 event이고(`event`는 그 첫 인자의 위치이다), `only`는 emitter가 지역인 경로의 pattern이다. 예를 들어 `emit(level, event, fields)`, `emit_for(level, event, subject, fields)`, `record_error(place, text)`를 가진 Rust writer는 다음과 같이 선언한다.

```json
{ "emitters": { "rs": [
  { "call": "emit", "level": 0, "event": 1, "fields": 2 },
  { "call": "emit_for", "level": 0, "event": 1, "fields": 3 },
  { "call": "record_error", "fixed": "error", "name": "sidecar.<name>.record.error", "event": 0 }
] } }
```

emitter는 catalog 검사에서 하나의 지점이고(이름, level, 리터럴 field를 다른 지점처럼 검사하며, 호출이 이름을 만들면 `events:` marker가 필요하다) census에서 그 함수의 event이다. 목록에 없는 언어, 이 key 밖의 key를 가진 emitter, 식별자가 아니거나 두 번 선언된 `call`, 음이 아닌 정수가 아닌 위치, pattern이 아닌 `only`는 파일, 언어, 목록의 위치를 담은 오류다.

입력은 독립 수신자와 비교한다: 기록된 `pty_write` 바이트는 shell 대역이 파일에 쓴 바이트와 같다.

## 개인정보

입력한 글은 이 컴퓨터의 `logs/`에 저장된다. 사람이 파일을 넘길 때만 컴퓨터를 떠난다. 파일이나 선택을 저장하는 동작은 파일이 입력한 내용을 담을 수 있다고 경고한다. catalog가 가림으로 표시한 인자는 크기와 hash로 저장한다.

## 한계

- wall clock은 되감기고 잠든 기계와 깨어난 기계 사이에서 어긋날 수 있다. `mono_ns`가 한 부팅 안의 프로세스 사이 event를 정렬하고 `cids`가 한 입력의 층을 정렬한다. page는 두 시계를 host에서 한 번 유도하므로, page가 시작한 뒤 wall clock이 되감기면 page의 `ts_us`는 host의 wall clock과 어긋나고, 해상도는 WebKit이 거칠게 만든 `performance.now()`의 것이며, page 값의 오차는 시계 요청의 가장 짧은 왕복의 절반 이하이다.
- 신호 처리기는 async-signal-safe 함수만 호출할 수 있어서 시작할 때 준비한 짧은 줄을 쓴다. `kill -9`이나 crash 뒤 파일에는 모든 level에 걸쳐 마지막 배치 간격(100 ms)의 event가 많아야 빠진다. `error`는 writer에 바로 넘기지만 writer가 돌기 전에 프로세스가 죽으면 잃는다.
- page는 파일을 쓸 수 없어 배치 호출로 host를 거쳐 기록한다. page 프로세스가 끝날 때 아직 보내지 않은 배치는 잃는다(flush 간격까지).
- 보존은 실행들의 파일이 6 GiB를 넘으면 가장 오래된 실행을 지우므로, PTY 출력이 폭주하면 디스크를 상한까지 채운 뒤 가장 오래된 실행을 교체한다. writer는 각 회전과 파일을 지우는 보존 회차를 기록한다.
- 입력기는 활성 애플리케이션의 key window에서만 답하므로, 조합한 입력의 검사에는 애플리케이션이 활성인 실행이 필요하다.
