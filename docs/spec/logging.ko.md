# 로그

[English](logging.md)

이 문서는 애플리케이션이 자기 자신에 대해 쓰는 기록의 계약이다: event란 무엇인지, 어떤 class가 있고 각각 어떻게 저장하는지, writer가 어떻게 동작하는지, 어떤 파일이 event를 담는지, event를 어떻게 선언하고 검사하는지. [진단](diagnostics.ko.md)은 `logs/`의 실패 지점과 파일을 나열하고, [debug](debug.ko.md)는 그 파일을 보여 준다. 구현을 이 계약에 맞추는 작업은 [관측 기반 계획](../plans/observability.ko.md)이며, 구현하지 않은 부분은 [기능](../features.ko.md)에 표시한다.

## 원칙

1. **하나의 event 계약.** 모든 층의 모든 기록은 아래 구조의 event 하나다. 둘째 형식은 없다. 사람이 읽는 글은 viewer가 event로 만들며 저장하지 않는다.
2. **생산자는 막히지 않는다.** UI 스레드, 입력 경로, frame 경로는 기록을 위해 디스크 접근, IPC, 락 대기, 한 runtime의 스레드에서 다른 runtime으로의 호출을 하지 않는다. 비활성 event는 분기 하나, 활성 event는 bounded 큐로의 복사 하나의 비용이다.
3. **손실은 세고 밝힌다.** 어떤 큐, rate limit, 회전, 절단도 조용히 버리지 않는다. 손실은 `log.dropped` event로 기록하고 모든 상한은 이 문서에 적는다.
4. **입력 경로는 완전하다.** `input` class의 event와 `io` class의 PTY 쓰기·읽기는 층이 본 모든 값과 모든 바이트를 담는다. 크기의 유일한 상한은 event의 크기 상한([상한](#상한))이며, 이는 입력의 크기보다 훨씬 크다. 큐는 자신의 바이트 상한보다 큰 event를 거절하므로, writer는 그보다 큰 event를 잘라 `truncated`를 붙여 저장한다.
5. **event는 선언한다.** 모든 event는 그것을 내는 저장소의 catalog에 항목이 있다. 개발과 지속적 통합은 선언하지 않은 event를 거부한다. 실행 중에는 선언하지 않은 event도 `undeclared` 표시를 붙여 쓰고 센다. 이름 오류가 증거를 버리지 않게 하기 위해서다.
6. **같은 종류의 event는 한 입구로 들어온다.** page→host 호출, 창·애플리케이션 이벤트, registry 명령, sidecar 수명, 오류 표시는 각각 기록하는 입구가 하나다. 호출 지점이 이를 위해 자기 기록을 쓰지 않는다.
7. **기록은 사실을 적는다.** event는 그때의 값과 함께 무슨 일이 있었는지를 적는다. 누가 요청했는지나 사람이 왜 했는지는 적지 않는다.

## event

event는 한 줄의 JSON 객체 하나다.

```json
{"ts_us":1791500000000000,"mono_ns":123456789012,"seq":812,"level":"info","layer":"native",
 "event":"native.input.key_down","window":"w1","surface":"tab-x","session":"s7","cids":["b3.1042"],
 "fields":{"keyCode":36,"characters":"\r"}}
```

| field | 뜻 |
| --- | --- |
| `ts_us` | epoch 기준 마이크로초 wall clock. 층 사이의 순서를 가린다. |
| `mono_ns` | 시스템 전체의 monotonic 시계(나노초; macOS는 `mach_absolute_time`, Linux는 `CLOCK_MONOTONIC`). 한 부팅 안의 프로세스 사이에서 비교할 수 있고 되감기지 않는다. page는 이 값이 없어 field를 생략한다. |
| `seq` | 프로세스의 writer가 직렬화할 때 붙이는 정수. 한 프로세스의 저장된 event는 연속된 `seq`를 가지며, 틈은 빠진 `seq`의 범위를 이름으로 밝히며 그 범위 다음에 자신이 저장되는 `log.dropped` event가 설명한다. |
| `level` | `error`, `warn`, `info`, `debug`, `trace`. |
| `layer` | `native`, `host`, `page`, `plugin`, `sidecar`. |
| `event` | catalog가 선언한 `<layer>.<subsystem>.<event>`. writer 자신의 event는 `log.<event>`(`log.open`, `log.dropped`)라 부르며 `layer`는 그것을 쓰는 프로세스의 층이다. |
| `window`, `surface`, `session` | event가 어떤 대상에 관한 것이면 그 대상의 식별자. |
| `cids` | event가 속한 입력의 상관 식별자 목록. 없으면 생략한다. |
| `fields` | catalog가 선언한 event의 값. |
| `truncated` | event의 fields 글이 event 크기 상한을 넘었을 때만 있다. 자르기 전 그 글의 바이트 크기다. 이런 event의 `fields`는 글의 첫 바이트인 `head`만 담는다([상한](#상한)). |

모든 파일의 첫 줄은 `log.open`이다. schema 번호(`schema`), `pid`, 프로세스의 역할(`role`), 실행의 식별자(`boot`), writer의 버전, 적용 중인 정책을 담는다. 모르는 schema 번호를 만난 reader는 파일 이름과 그 번호를 담은 오류로 그 파일을 거부한다.

writer가 회전하는 파일은 경계를 넘게 될 줄 앞에서 끝난다. 새 파일은 `log.open`으로 시작하고 이어서 `log.rotated` `{bytes, kept, removed}`가 온다. `bytes`는 닫은 파일의 크기, `kept`는 보관하는 세대 수, `removed`는 이 회전이 지운 세대의 파일 이름이며 지운 것이 없으면 `null`이다. `seq`는 회전을 건너 이어지므로 독자는 세대를 첫 `seq`로 정렬한다.

### 상관 식별자

native 입력 콜백 하나(키 event, 붙여넣기, drop, 포인터 보고)는 그것을 처음 본 층에서 식별자 `<boot>.<n>` 하나를 받는다. 그 콜백이 일으키는 콜백(`setMarkedText`, `insertText`, `commitThrough`)은 일으킨 콜백의 식별자를 쓴다. 식별자는 native 보고, host 중계, page event와 함께 가고, plugin이 전송에 실어 넘기며, host가 sidecar로 가는 요청 envelope에 넣으므로 요청의 본문은 plugin의 것으로 남는다. 입력 여럿을 합치는 전송은 그 식별자를 모두 나르고, sidecar는 그 요청이 일으키는 event, 곧 `pty_write`까지 이를 적는다. envelope field를 모르는 sidecar는 이를 무시한다.

## class와 정책

event는 class 하나에 속하며 catalog가 이를 선언한다. class가 저장 방식을 정한다.

| class | 예 | 발생률 | 저장 |
| --- | --- | --- | --- |
| `lifecycle` | 창, 애플리케이션, sidecar, 세션의 수명. 설정, 프로젝트, plugin, 업데이트의 변경 | 낮음 | 항상 저장 |
| `input` | 키, 입력기 콜백, 붙여넣기, 클릭 | 사람 속도 | 항상 완전하게 저장: 입력한 글, 범위, flag, 앞뒤 상태 |
| `call` | page→host 호출, registry 명령, endpoint 메서드: 이름, 인자, 결과, 마이크로초 | 중간 | 저장. catalog가 선언한 크기 상한을 넘는 인자는 상한까지 저장하고 `truncated`로 표시한다. catalog가 가림으로 표시한 인자(token, 문서 본문)는 크기와 hash로 저장한다. |
| `io` | sidecar 메시지, PTY 읽기와 쓰기 | 중간~높음 | 완전하게 저장. 유일한 상한은 파일의 회전이며 일어날 때 기록한다. |
| `frame` | 그림 frame, 화면, 포인터 이동, wheel, layout | 높음 | 집계: 선언한 간격마다 횟수, 극값, 마지막 값, 총 마이크로초를 담은 요약 event 하나. category를 켜 두는 동안은 모든 event를 저장한다. |

설정 `diagnostics.log`가 상세히 저장할 category를 고른다. host는 적용 중인 정책을 `<config-dir>/log-policy.json`에 쓴다. 모든 프로세스가 파일 시스템 event로 이 파일을 감시하고 바뀌면 다시 읽는다. 정책을 나르는 프로토콜 연산은 없다. 정책을 읽지 못한 프로세스는 `lifecycle`, `input`, `call`, `io`를 저장한다.

화면의 셀 같은 큰 값은 event에 쓰지 않고 크기와 hash를 쓴다. 값은 `frame` category를 켜 두는 동안 저장한다.

## writer

writer는 프로세스에서 event를 파일의 줄로 바꾸는 부분이다.

- 생산자는 먼저 정책을 확인한다(분기 하나). 그 뒤 event를 소유하는 메시지로 만들어 개수와 바이트로 제한한 큐에 막힘 없이 넣는다. 큐가 가득 차면 손실 카운터를 올린다. 만들기 비싼 field는 closure로 넘기거나 `enabled(name)`으로 감싼다.
- 프로세스마다 writer 스레드 하나가 `seq`를 붙이고, JSON으로 직렬화하고, 배치(100 ms마다, 64 KB가 쌓일 때, 또는 `error` 뒤 즉시)로 쓰고, 파일을 회전한다. `error`는 writer를 깨우고 돌아오며 생산자는 디스크를 기다리지 않는다.
- writer는 손실 카운터를 `log.dropped` event `{from_seq, to_seq, count, bytes, reason}`로 바꾼다. 쓰기가 실패하면(디스크 가득 참, 입출력 오류) writer는 손실을 세고 상태로 보이며, 쓰기가 다시 되면 `log.dropped`를 기록한다. heartbeat가 끝난 writer 스레드를 감지하면 프로세스는 fatal 오류를 보고하고 끝난다.
- 모든 종료 경로는 프로세스가 끝나기 전에 deadline을 두고 큐를 flush한다: Go host의 shutdown, Rust host의 exit, `panic = abort`, `os.Exit`.
- host의 writer는 같은 프로세스의 다른 계층의 event(page 배치, native ring)를 그 event가 가진 시각과 계층 그대로 받는다. 이런 event의 이름은 계층으로 시작해야 하고, 계약에 없는 계층과 JSON이 아닌 field는 오류로 거부하며, `seq`는 여전히 writer가 부여한다.
- native 라이브러리에는 writer가 없다. C의 bounded lock-free ring을 소유하며, `sp_event`가 어느 스레드에서든 event를 ring에 복사하고 host의 writer 스레드가 `sp_event_drain` 호출로 ring을 비운다. 어떤 생산자 스레드도 Go나 Rust를 부르지 않는다. host writer가 생기기 전에 쓴 event는 ring에서 기다린다. `sp_event(level, name, fields_json)`은 마이크로초 단위 wall clock, level, 이름(1~255바이트, 계층 `native`), JSON 텍스트인 field를 저장하며, 없거나 비었거나 더 긴 이름, 열거에 없는 level, 없는 field는 거부하고 센다. drain은 `ts_us`(8바이트), level(1바이트), 이름 길이(1바이트), 이름, field로 된 record를 각각 4바이트 길이 뒤에 돌려준다. ring은 4 MiB이며 가득 차면 event를 거부하고 세고, host writer가 그 수를 이유 `the native ring was full`의 `log.dropped`로 기록한다. writer는 플랫폼 연산 `PullNativeEvents`로 배치 간격마다와 flush할 때 ring을 pull하며, pull 한 번에 256 KiB씩 최대 64번 읽는다. ring에서 writer로 오는 event source는 없다. native 스레드가 Go나 Rust를 부르면 안 되므로 pull은 polling이다. writer는 pull한 record를 library가 준 시각 그대로 계층 `native`로 저장한다. 이름이 `native.`로 시작하지 않거나, level이 정의되지 않았거나, field가 JSON 객체가 아니거나, 길이가 buffer에 맞지 않는 record는 거부하고 표준 오류에 거부를 보고하며 이유 `a native record was refused`의 `log.dropped`로 센다. ring을 pull하지 못하는 플랫폼은 host의 시작에 실패한다.
- page는 `context.log.<level>(event, fields)`로 기록한다. event는 배열에 모였다가 host로 가는 배치 호출 하나로 나간다. 100 ms 타이머, 크기 상한에 닿을 때, `pagehide`와 `visibilitychange`에서 나가며 생산자는 응답을 기다리지 않는다. `console.*`, 전역 `error` event, `unhandledrejection` event도 같은 입구로 들어간다. 배치 호출은 요청 `{action: "batch", events}`를 가진 host 호출 `log`이며, host는 배치 전체를 검증한 뒤에야 event를 저장하고, 모든 event를 page가 준 `ts_us`로 계층 `page`에 저장하며, 이름이 `page.`로 시작하지 않는 event, 계약에 없는 level, 양의 정수가 아닌 `ts_us`, 객체가 아닌 `fields`는 `events[<index>]`를 가리키는 오류로 거부한다.
- fatal 신호 처리기는 프로세스가 시작할 때 열어 둔 파일 descriptor에 async-signal-safe 호출만으로 짧은 줄을 쓴다. Go의 runtime fatal 오류는 가로챌 수 없으므로 그 출력은 프로세스의 crash 파일로 가고, host의 모든 goroutine을 시작하는 진입점 `routine.Go`가 panic을 recover하고 `error` event `host.panic`을 저장한 뒤 프로세스를 끝낸다. Rust host는 같은 event를 panic hook에서 저장하며 panic한 스레드에서 writer를 기다리지 않고, 별도 스레드가 flush한 뒤 프로세스를 끝낸다([hosts](hosts.md#process-lifecycle)).

event를 쓰는 각 저장소는 자기 작은 writer 구현을 가지며 `packages/log-contract/fixtures`의 golden lines와 golden catalog로 시험한다. 저장소 사이에 runtime 코드를 공유하지 않으며 sidecar는 실행 중에 core 릴리스에 의존하지 않는다.

## 상한

event가 싣는 모든 buffer와 값에는 상한이 있고, 생산자는 값을 복사하거나 직렬화하기 전에 상한까지 자르므로 기록 비용은 값의 크기에 따르지 않는다. 상한에서 생기는 손실은 조용하지 않다. 세어서 catalog의 event로 저장한다.

| 상한 | 값 | 도달하면 |
| --- | --- | --- |
| event의 fields | JSON 글 1,048,576바이트 | writer는 `fields`를 `{"head": <글의 첫 4,096바이트, 문자 경계에서 자름>}`로, `truncated`를 원래 크기로 정해 event를 저장한다. 큐에는 저장한 크기만큼 청구한다. native ring은 한 번의 pull인 262,144바이트를 넘게 싣지 않는다. |
| 호출 event(`page.call`, `host.endpoint.call`)의 `args`와 `error` | 1,024바이트, 문자 경계에서 자름 | 상한까지 저장하고 event에 `truncated: true`가 붙는다. page는 `args`를 직렬화하는 동안 자르며 값 전체를 직렬화하지 않는다. |
| `page.console.<method>`의 `text` | 8,192바이트, 문자 경계에서 자름 | 글은 인자를 직렬화하는 동안 상한까지만 만들고, event에 `truncated: true`가 붙는다. |
| page writer의 큐 | event 4,096개 | page는 거절한 event를 세어 뒤따르는 event 앞에 `page.log.dropped`를 저장한다. |
| host writer의 큐 | event 8,192개와 16 MiB | writer는 거절한 event를 세어 `log.dropped`로 저장한다. |
| sidecar의 보류 응답(256줄의 쓰기 큐가 빈 뒤에 쓴다) | 메시지 1,024개와 4,194,304바이트 | 응답은 오류 `sidecar <name>: the pending replies reached <bound>, so a reply of surface <surface> is dropped`로 거절되고 `host.buffer.dropped`를 저장한다. |
| sidecar의 보류 close | 메시지 1,024개와 4,194,304바이트 | close는 보내지 않고, 표면은 답을 기다리는 목록에 올리지 않으며, `host.buffer.dropped`를 저장하고, sidecar는 끝날 때까지 그 표면의 session을 가진다. |
| relay의 만료된 요청(늦은 응답) | 요청 256개 | 가장 오래된 요청을 잊으므로 그 요청의 늦은 응답은 `exposure reply <id> has no matching request`로 답하고 `host.buffer.dropped`를 저장한다. |
| host record의 시작 buffer | record 1,024개 | 거절한 record는 writer가 생기면 세어서 `log.dropped`로 저장한다. |

모든 `host.buffer.dropped` event는 `count`가 1이고 거절한 메시지의 크기를 담으므로, 거절이 쏟아지면 event도 쏟아진다. 이는 writer의 큐가 상한으로 막고 다시 센다.

## 파일

프로세스 실행 하나가 설정 폴더 아래 `logs/<role>-<boot>.jsonl`을 쓴다. host 프로세스는 native 라이브러리, page, plugin의 event도 담는다. 각 writer는 자기 파일만 100 MB에서 회전하고 이전 세대 5개(`.1`에서 `.5`)를 남기며 다른 프로세스의 파일은 회전하지 않는다. 회전이 일으키는 유일한 손실은 가장 오래된 세대이며 writer가 회전을 기록한다.

event가 아닌 raw 파일이 둘 있다. `logs/<role>-<boot>.stderr`는 프로세스의 표준 오류(운영체제와 framework의 출력)를, `logs/<role>-<boot>.crash`는 runtime fatal 오류의 crash 출력을 담는다. viewer는 이를 event 파일과 함께 나열한다.

파일은 mode `0600`으로, 폴더는 mode `0700`으로 만들고 close-on-exec로 열어서 자식 프로세스가 물려받지 않는다.

상태 파일 `logs/state-<time>.json`과 capture는 event가 아니며 [debug](debug.ko.md)가 쓴다.

## catalog

event를 내는 각 저장소는 `events.json`에 event를 선언한다(이 저장소는 [events.json](events.json)이며 계층 `native`, `host`, `page`를 소유한다. `page.record.<level>`처럼 자리 표시자를 가진 이름은 계열을 선언한다. `level`은 level 하나 또는 level 목록이고, 이름이 `?`로 끝나는 field는 선택이며, `string|null` 같은 타입은 각 부분을 받아들이고, 계층 `sidecar`는 host가 저장하는 sidecar 표준 오류의 줄인 `sidecar.record.<level>`만 담는다. `make events-check`는 소스의 emit 지점을 읽어 선언되지 않은 채 emit된 이름, emit 지점이 없는 선언된 event, 선언이 허용하지 않는 literal 지점의 level이나 field를 실패로 보고한다. 지점은 이름을 literal로 주고(page의 template은 계열이다), 이름을 만드는 지점 위의 주석 `events: <names>`는 그것이 만드는 선언된 이름을 적으며, `events: forwarded`는 그 지점이 호출자의 이름을 넘긴다고 밝힌다. `node scripts/check-events.mjs --logs <config-dir>…`는 창 검사가 남긴 모든 층의 event 파일을 감사한다. [검사](#검사) 참고): event마다 이름, 층, class, level, 필수 field와 그 타입, 가릴 인자, 인자의 크기 상한, 설명. 저장소는 다른 모든 검사에서 자기 소스를 검사하듯 자기 소스를 자기 catalog로 검사한다. 이 저장소는 catalog의 schema와 `native`·`host` 층, page의 event를 소유한다. plugin이나 sidecar는 manifest(`events`, `executable`처럼 패키지 안의 경로)에 자기 catalog 파일을 적고, 릴리스는 그 파일을 담으며, viewer가 설치된 manifest의 catalog를 읽는다. 이 저장소는 그것을 이름으로 부르지 않는다.

catalog는 입력 종류마다 남겨야 하는 사슬도 선언한다. 첫 층에서 마지막 층까지 event의 순서 있는 목록이다(예: `native.input.key_down`, host 중계, `page.terminal.send`, `sidecar.vt.pty_write`). 로그 감사는 입력의 선언된 사슬이 모두 완결되어 있기를 요구한다.

### 입구

다음 입구는 호출 지점이 기록을 쓰지 않아도 기록한다.

- 메인 page의 host 호출: 두 runtime이 `host.call` 둘레에 두는 감싸개(`settlingCalls`)가 필드 `name`, `args`(인자의 JSON, 직렬화하는 동안 1024바이트에서 자르며 `truncated: true`), `micros`, `ok`, 거절된 호출이면 `error`를 가진 event `page.call`을 낸다. level은 `debug`이고 거절된 호출은 `warn`이다. 호출 `log`와 `performance`는 기록하지 않는다. 기록된 `log` 호출이 자기 자신을 기록하기 때문이다. `debugReadRange`도 기록하지 않는다. debug 화면은 기록기가 알린 event에 답해 읽기 때문이다. `overlayUpdate`와 `overlayPlace`도 기록하지 않는다. 네이티브 모달을 그리고 놓는 호출로 집계로 저장하는 class `frame`이고, event 파일을 따라가는 화면은 늘어난 행마다 다시 그리므로 기록하면 스스로 먹이가 되기 때문이다;
- 표면 문서의 host 호출: 각 application의 runtime `page` 객체는 모든 호출을 `surfaceCalls`(`packages/workbench/surface-calls.js`)로 보내고, 이것이 두 runtime에서 같은 이름과 같은 인자로 같은 event `page.call`을 낸다(인자는 Wails runtime이 넘기는 호출의 인자다). event는 문서의 batcher를 거치므로 한 turn의 호출은 호출 `log` 한 번으로 host에 가고, 문서의 `report`도 같은 batcher 뒤에 쌓여 문서의 기록과 호출이 순서를 지킨다. 호출 `log`는 기록하지 않는다. 중계가 실패하면 문서의 console에 쓴다. 문서에는 달리 알릴 곳이 없기 때문이다;
- 창 event: host가 창에 등록하는 모든 event는 `window`와 `kind`를 가진 event `host.window.event`다. host는 자기 framework가 알리는 kind를 낸다(Wails는 `show`, `hide`, `focus`, `lost_focus`, `web_process_ended`, `navigation_committed`를, Tauri는 `occlusion_changed`를 알린다). 그래서 host가 저장하는 kind는 [host 계약](host-contract.ko.md)의 목록의 부분집합이다;
- 애플리케이션 event: host가 애플리케이션에 등록하는 모든 event는 `kind`를 가진 event `host.app.event`다. host는 자기 framework가 알리는 kind를 저장한다(Wails는 `started`, `activated`, `deactivated`, `exit_requested`, `exit`를, Tauri는 `started`, `exit_requested`, `exit`를 알린다);
- endpoint 메서드: [endpoint](endpoint.md) client의 모든 요청은 필드 `name`(메서드), `args`(받은 그대로의 params, 요청에 없으면 `null`이며, 복사하기 전에 문자 경계에서 1024바이트로 자르고 잘렸으면 `truncated: true`), `micros`(요청을 받은 때부터 결과까지), `ok`, 실패한 요청이면 `error`(client가 받는 코드와 메시지 `<code>: <message>`이며 같은 방식으로 자른다)를 가진 event `host.endpoint.call`이다. level은 `debug`이고 실패한 요청은 `warn`이며, 성능 trace가 켜져 있는지와 상관없다. 구독 변경(`status.watch`, `status.unwatch`)은 답을 쓸 때 기록하고, event는 답을 쓰기 전에 저장한다;
- 한도가 있는 buffer: host의 buffer가 가득 차면 가장 새 메시지를 거절하고, 호출자가 있으면 오류를 돌려주며, level `warn`의 event `host.buffer.dropped`(`buffer`, `count`, `bytes`, `reason`)를 저장한다. 한도는 [상한](#상한)에 있다;
- registry 명령: page는 요청 `command.run`에 모두 함수 하나로 답하며, 그 함수가 필드 `name`, `micros`, `ok`, 실패한 명령이면 `error`를 가진 event `page.command`를 낸다(level은 `debug`, 실패한 명령은 `warn`). 성능 trace가 켜져 있든 꺼져 있든 같다;
- native 활동: native 라이브러리는 애플리케이션(`native.app.activated`, `native.app.deactivated`, `native.app.hidden`, `native.app.unhidden`), 창(창 번호와 first responder의 class를 가진 `native.window.key`, `native.window.resign_key`, `native.window.main`, `native.window.resign_main`, `native.window.miniaturized`, `native.window.deminiaturized`, 그리고 `visible`을 가진 `native.window.occlusion`), 입력 소스(`native.input.source_changed`)의 알림과 창의 first responder 변경마다(창 번호와 class `from`, `to`를 가진 `native.window.first_responder`. 창이 다음에 갱신될 때 이전 갱신의 first responder와 비교해 기록한다. AppKit은 text field의 창과 field editor를 거치므로 포커스 이동 하나가 event 여럿일 수 있다) level `info`로 기록한다. 그림 영역이 답하는 입력기 질의마다 level `debug`의 `native.input.query`가 `call`(`markedRange`, `selectedRange`, `hasMarkedText`, `firstRectForCharacterRange`, `characterIndexForPoint`), 인자, `answer`, 영역의 `focus`와 함께 있다. host는 writer를 시작할 때 observer를 설치한다;
- native 등록: native 라이브러리의 모든 observer, monitor, key-value observer, run loop observer, dispatch source, Apple event handler, delegate는 하나의 입구 `observe.m`(`native/darwin/src`)을 통해 등록한다. 입구는 등록마다 `native.observe.registered`(`source`, `kind`, `target`, `mode`, `registrations`)를 level `info`로, 거부된 등록마다 `native.observe.failed`(`source`, `kind`, `reason`)를 level `error`로 저장하고, 모든 전달을 `source` 이름으로 센다. source의 mode는 셋 중 하나다. `record`는 전달마다 `native.observe.delivered`(`source`, `count`)를 level `debug`로 저장하고, `stored`는 수신자가 발생마다 자기 event를 저장하므로 세기만 하며, `count`는 frame이나 장치 속도의 전달에 대해 `native.observe.counted`(`source`, `count`, `total`, `micros`)를 level `debug`로 초당 한 번 이하로 저장한다. 이 event는 이전 요약 이후 전달 수를 정확히 담는다. 마지막 요약 뒤의 수는 `sp_observe_flush`가 저장한다. 등록 호출에는 gate가 필요 없다. 전달 한 번은 atomic 덧셈 하나이고 `record` 전달은 stack의 제한된 buffer에 쓰며 할당하지 않는다. 실패하는 native 호출은 `sp_log_error`나 `sp_log_info`를 저장하며, census에서 이 둘은 `native.record.error`와 `native.record.info`의 emit 지점이다. `sp_process_when_exited`가 기다린 시간 안에 끝나지 않는 process는 `native.process.exit_timeout`(`pid`, `seconds`)을 level `warn`으로 저장한다;
- sidecar 수명: 표준 입출력 sidecar 프로세스는 host가 시작할 때 event `host.sidecar.start`(`name`, `pid`), 끝났을 때 `host.sidecar.exit`(`name`, `pid`, `status`, `stopping`)이고, 영구 service 연결은 `host.sidecar.connect`(`name`, `pid`, `spawned`)와 `host.sidecar.disconnect`(`name`, `pid`, `stopping`, `violation`)이며 모두 level은 `info`다;
- 허용된 제거: 프로젝트를 제거해도 되는지 질문을 받은 창이 끝나면 제거를 허용하며, 그 요청마다 event `host.project.removal_allowed`(`window`, `project`)를 level `info`로 저장한다;
- 설정 변경: 설정 파일의 변경마다 event `host.workspace.settings`(`scope`, `set`, `removed`)를 level `info`로 저장한다. `set`과 `removed`는 키만 담고 값은 담지 않는다;
- 알림 센터: 상태, 게시된 알림, 눌린 알림마다 event `host.notification.event`(`type`, `authorization`, `window`, `surface`)를 level `info`로 저장하고, 실패마다 장소 `notification`의 `error` 기록을 저장한다;
- 프로세스 질의: WebKit 자식에 대한 `ps` 질의가 실패하면 장소 `webkit children`의 `error` 기록이다. 프로세스가 없다는 `ps`의 답(상태 1과 빈 출력)은 실패가 아니다;
- 애플리케이션 업데이트: host는 분리 실행하는 `sok app update`를 event log의 마지막 flush 전에 시작하고 event `host.update.start`(명령의 `pid`, `command` 줄)를 level `info`로 저장한다. 시작에 실패하면 `error` 기록이다. `sok`은 writer가 없는 짧은 프로세스이므로 결과는 종료 상태와 표준 오류의 메시지다([명령줄](cli.ko.md#출력과-종료-상태)). 분리 실행한 명령은 host의 표준 오류를 그대로 쓰므로 메시지는 `logs/host-<boot>.stderr`에 있다. 종료 상태는 읽는 쪽이 없다. 읽을 수 있는 host가 명령이 번들을 바꾸기 전에 끝나기 때문이다. 실패한 명령은 이전 번들을 되돌려 시작하며, 그 실행은 `log.open`으로 시작한다;
- 메인 page 문서의 시작: page가 처음 적재하는 모듈이 필드 `time_origin`(문서 시계의 원점, `performance.timeOrigin`)과 `url`을 가진 event `page.start`를 내므로, 새 시계로 새 문서를 시작하는 reload가 timeline의 표시된 경계가 된다;
- 사람이 보는 오류의 표시. 이것이 `error` event를 낸다.

task의 종료처럼 어떤 입구도 덮지 못하는 원천은 소스 lint가 선언이나 사유 주석이 없는 event를 나열한다. lint는 증명이 아니다. 범위는 실행 중에 판단한다: window check가 선언된 명령과 native 입력으로 선언된 원천을 하나씩 구동하고 그 선언된 event를 요구한다.

### 시험 표시

window check는 시험 대상 애플리케이션의 event log에 시험마다 표시를 남기므로, 시험은 로그의 위치 범위다. 진단 method `diagnostics.test.mark`([endpoint](endpoint.ko.md))는 시험이 시작할 때 event `host.test.start`(`name`, `run`)를, 끝날 때 `host.test.end`(`name`, `run`, `pass`, `fail`, `skip` 중 하나인 `result`)를 저장한다. 둘 다 layer `host`, class `lifecycle`, level `info`이며, flush한 뒤 event 파일의 `boot`와 표시 줄의 `seq`인 `{boot, seq}`로 답한다. 위치는 `(boot, seq)`다. 한 애플리케이션이 여러 실행을 처리하므로 실행 식별자는 `log.open`이 아니라 이 event에 실린다. window-check 라이브러리는 검사가 session을 열 때 시작을, 검사의 정리와 오류 점검 뒤에 끝을 표시하며, 본문이나 정리가 실패했으면 `fail`이다. 표시마다 `{run, app, config, name, kind, boot, seq, ts_us}`(`config`는 애플리케이션의 설정 폴더)를 실행 폴더(`SOKSAK_RUN_FOLDER`)의 `marks.jsonl`에 덧붙이고, `expectError`를 부르면 실행 중인 시험에 대해 `{run, app, config, name, kind: "expect_error", pattern, flags, ts_us}`를, `expectEvent(name)`를 부르면 `{run, app, config, name, kind: "expect_event", event, ts_us}`를 덧붙인다. `SOKSAK_RUN_ID`가 있을 때만 표시하며, 이 값은 시험 실행기가 정한다([examples](../operations/examples.ko.md#창-검사)).

## 검사

`soksak-log-check`(패키지 `@soksak/log-contract`, `packages/log-contract`)는 로그를 schema와 catalog로 검증한다: 줄 구조, 선언된 event, 연속된 `seq`와 `log.dropped`로 설명되는 틈, 입력 종류마다 선언된 사슬, 시험이 선언한 것 외의 `error` 없음. 단위 시험과 window check는 자기 로그를 남기고, gate는 남은 모든 로그를 검증하며, 실패한 실행의 로그는 분류하기 전까지 보관한다.

실행의 감사 `node scripts/audit-run.mjs <실행 폴더>`는 `pnpm verify:windows`와 활성화 등급의 끝(`scripts/node-tests.mjs`의 `--script verify` 또는 `--script verify:<등급>`)에서 시험이 실패했을 때도 실행된다. 실행 폴더의 `marks.jsonl`을 읽고, 표시의 `config`에서 설정 폴더를 얻어, 그 안의 모든 층의 모든 event 파일(`host-`, `vt-`, `files-`, `shell-` 파일과 그 세대 `.1`부터 `.5`, debug 파일)을 catalog로 감사한다: 줄 구조, 선언 없는 event(catalog가 layer `sidecar`를 나열하므로 이 층도 감사한다), 한 process의 세대와 debug 파일을 건넌 연속된 `seq`, 폴더의 파일을 합쳐 본 선언된 사슬, 모든 `error` event. 시험의 범위는 애플리케이션 로그에서 `host.test.start`와 `host.test.end` 표시 사이의 줄이며 `(boot, seq)`로 정하고, 다른 process의 event는 `ts_us`로 범위에 놓는다. 범위에 `error`가 든 모든 시험이 그 text와 맞는 pattern(`expect_error`)을 선언했으면 `error`는 선언된 것이고, 그 밖의 `error`는(어떤 시험의 범위에도 없는 것 포함) finding이며, 끝 표시 없는 시작 표시도 finding이다. `expectEvent`로 event(`expect_event`)를 선언한 시험의 범위에 그 이름의 event가 없으면 끝 표시에서 빠진 event 이름을 밝히는 finding이다. 감사는 실행 폴더에 `judgment.json`을 쓰며, 시험과 애플리케이션마다 한 행 `{name, app, result, boot, from, to, errors, expected, missing}`이다. `from`과 `to`는 시작·끝 표시의 `{seq, file, line}`이고(끝 표시가 없으면 `to`는 null), `errors`는 범위의 `error` event를 `{file, line, text, declared}`로, `expected`는 선언한 event마다 범위에서 찾은 수를, `missing`은 하나도 없는 선언을 나열하며, 끝 표시가 있고 `missing`이 비고 모든 error가 선언된 경우에만 `result`가 `pass`다. finding은 표준 오류의 한 줄 `<file>:<line>: <message>`이고, finding이 있거나 실행에 `marks.jsonl`이 없으면 종료 상태는 1이다. `node scripts/check-events.mjs --logs <config-dir>…`는 표시 없이 설정 폴더를 감사하며 모든 `error` event를 보고한다. 지속적 통합은 창 검사를 실행하지 않으므로 결함 fixture를 쓰는 감사 시험(`pnpm test`)을 실행하고, 실제 실행의 감사는 개발 컴퓨터의 창 검사 실행에 속한다.

### Census

발생 원천은 기록 없이 사라질 수 있는 자리다: 빈 catch, 버려진 결과, goroutine, 등록된 observer, delegate, 오류 반환. census는 언어별 규칙으로 그런 원천을 모두 찾고, 같은 함수에 저장된 event나 reason marker 중 하나를 요구한다. marker의 형식은 하나, `(default|silent): <reason>`이다(`default:`는 기본값이 계약의 일부인 까닭을, `silent:`는 아무것도 기록하지 않는 까닭을 적는다). 원천의 줄, 일치한 범위 안, 또는 바로 위에 이어진 주석 줄에 적고, 까닭은 10자 이상이다. 단어의 다른 형식(`Default:`, `Silent:`, `fallback:`, 다른 구분자, 다른 언어)으로 시작하는 주석은 파일과 줄을 이름으로 말하는 오류다. 기준선은 없다: 둘 다 없는 원천은 `<file>:<line>: <rule> has neither an event nor a stated reason`으로 실패한다.

`soksak-events [--census <file>] [--catalog <file>] [--list] [repository]`(패키지 `@soksak/plugin-api`, `packages/plugin-api/events-check.js`)는 `packages/plugin-api/census-rules.json`의 규칙을 적용하며 모든 저장소가 호출한다. 규칙은 `id`, `language`, 주석을 뺀 코드에서 일치시키는 `pattern`, `event-or-reason` 또는 `entrance`인 `requires`(원천은 저장소의 입구 파일에서만 허용되고, 다른 곳에서는 event도 marker도 받아들이지 않는다), 설명을 가진다. 규칙은 `js.empty-catch`, `js.swallowing-catch`, `go.go-statement`, `go.recover`, `rs.ok-discard`, `rs.unwrap-or`, `rs.dropped-send`, `m.registration`(observer, monitor, KVO, event tap, run loop source, dispatch source, timer 등록), `m.delegate`, `m.error-return`(`return NO;`)이다. 원천의 event는 catalog 입구의 emit 지점(`sitesOf`)이고, 함수는 Go와 Rust에서는 가장 안쪽의 이름 있는 함수, JavaScript에서는 가장 안쪽의 함수 형태 block, Objective-C에서는 가장 바깥 block이다. 반환 경로 규칙은 근사이고 등록 규칙은 정확하다.

저장소의 선언 파일(`--census`)은 `exclude`(census가 뺄 경로의 pattern), `entrances`(규칙 id와 입구 파일의 pattern), `pending`(규칙 id와 입구를 만들어 규칙을 켜는 checklist 항목)을 가진다. 대기 중인 규칙은 강제하지 않으며, 명령은 그 항목과 대기하는 발견의 수를 출력하므로(`--list`는 각 발견을 출력한다) 꺼진 규칙은 침묵하지 않는다. 어떤 규칙에도 없는 규칙 id, 모르는 key, checklist id가 아닌 pending 값은 오류다. `--catalog`는 소스의 emit 지점도 그 경로의 catalog와 양방향으로 대조한다([Catalog](#catalog)). `make census-check`는 `scripts/census.json`으로 이 저장소에서 명령을 실행하고, `pnpm test`는 `scripts/test/census.test.mjs`에서 실행하며, `scripts/check-fallbacks.mjs`는 같은 marker를 쓰고 다른 형식을 거부한다.

입력은 독립 수신자와 비교한다: 기록된 `pty_write` 바이트는 shell 대역이 파일에 쓴 바이트와 같다.

## 개인정보

입력한 글은 이 컴퓨터의 `logs/`에 저장된다. 사람이 파일을 넘길 때만 컴퓨터를 떠난다. 파일이나 선택을 저장하는 동작은 파일이 입력한 내용을 담을 수 있다고 경고한다. catalog가 가림으로 표시한 인자는 크기와 hash로 저장한다.

## 한계

- wall clock은 되감기고 잠든 기계와 깨어난 기계 사이에서 어긋날 수 있다. `mono_ns`가 한 부팅 안의 프로세스 사이 event를 정렬하고 `cids`가 한 입력의 층을 정렬한다. page는 wall clock만 가진다.
- 신호 처리기는 async-signal-safe 함수만 호출할 수 있어서 시작할 때 준비한 짧은 줄을 쓴다. crash 때 마지막 배치 간격(최대 100 ms)의 `info` event를 잃을 수 있다. `error`는 writer에 바로 넘기지만 writer가 돌기 전에 프로세스가 죽으면 잃는다.
- page는 파일을 쓸 수 없어 배치 호출로 host를 거쳐 기록한다. page 프로세스가 끝날 때 아직 보내지 않은 배치는 잃는다(flush 간격까지).
- PTY 출력이 폭주해 파일을 채우면 회전이 가장 오래된 세대를 밀어낸다. writer가 각 회전을 기록한다.
- 입력기는 활성 애플리케이션의 key window에서만 답하므로, 조합한 입력의 검사에는 애플리케이션이 활성인 실행이 필요하다.
