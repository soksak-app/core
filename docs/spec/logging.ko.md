# 로그

[English](logging.md)

이 문서는 애플리케이션이 자기 자신에 대해 쓰는 기록의 계약이다: event란 무엇인지, 어떤 class가 있고 각각 어떻게 저장하는지, writer가 어떻게 동작하는지, 어떤 파일이 event를 담는지, event를 어떻게 선언하고 검사하는지. [진단](diagnostics.ko.md)은 `logs/`의 실패 지점과 파일을 나열하고, [debug](debug.ko.md)는 그 파일을 보여 준다. 구현을 이 계약에 맞추는 작업은 [관측 기반 계획](../plans/observability.ko.md)이며, 구현하지 않은 부분은 [기능](../features.ko.md)에 표시한다.

## 원칙

1. **하나의 event 계약.** 모든 층의 모든 기록은 아래 구조의 event 하나다. 둘째 형식은 없다. 사람이 읽는 글은 viewer가 event로 만들며 저장하지 않는다.
2. **생산자는 막히지 않는다.** UI 스레드, 입력 경로, frame 경로는 기록을 위해 디스크 접근, IPC, 락 대기, 한 runtime의 스레드에서 다른 runtime으로의 호출을 하지 않는다. 비활성 event는 분기 하나, 활성 event는 bounded 큐로의 복사 하나의 비용이다.
3. **손실은 세고 밝힌다.** 어떤 큐, rate limit, 회전, 절단도 조용히 버리지 않는다. 손실은 `log.dropped` event로 기록하고 모든 상한은 이 문서에 적는다.
4. **입력 경로는 완전하다.** `input` class의 event와 `io` class의 PTY 쓰기·읽기는 층이 본 모든 값과 모든 바이트를 담는다. writer는 그 크기를 제한하지 않는다.
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

모든 파일의 첫 줄은 `log.open`이다. schema 번호(`schema`), `pid`, 프로세스의 역할(`role`), 실행의 식별자(`boot`), writer의 버전, 적용 중인 정책을 담는다. 모르는 schema 번호를 만난 reader는 파일 이름과 그 번호를 담은 오류로 그 파일을 거부한다.

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
- writer는 손실 카운터를 `log.dropped` event `{from_seq, to_seq, class, count, bytes, reason}`로 바꾼다. 쓰기가 실패하면(디스크 가득 참, 입출력 오류) writer는 손실을 세고 상태로 보이며, 쓰기가 다시 되면 `log.dropped`를 기록한다. heartbeat가 끝난 writer 스레드를 감지하면 프로세스는 fatal 오류를 보고하고 끝난다.
- 모든 종료 경로는 프로세스가 끝나기 전에 deadline을 두고 큐를 flush한다: Go host의 shutdown, Rust host의 exit, `panic = abort`, `os.Exit`.
- native 라이브러리에는 writer가 없다. C의 bounded lock-free ring을 소유하며, `sp_event`가 어느 스레드에서든 event를 ring에 복사하고 host의 writer 스레드가 `sp_event_drain` 호출로 ring을 비운다. 어떤 생산자 스레드도 Go나 Rust를 부르지 않는다. host writer가 생기기 전에 쓴 event는 ring에서 기다린다.
- page는 `context.log.<level>(event, fields)`로 기록한다. event는 배열에 모였다가 host로 가는 배치 호출 하나로 나간다. 100 ms 타이머, 크기 상한에 닿을 때, `pagehide`와 `visibilitychange`에서 나가며 생산자는 응답을 기다리지 않는다. `console.*`, 전역 `error` event, `unhandledrejection` event도 같은 입구로 들어간다.
- fatal 신호 처리기는 프로세스가 시작할 때 열어 둔 파일 descriptor에 async-signal-safe 호출만으로 짧은 줄을 쓴다. Go의 runtime fatal 오류는 가로챌 수 없으므로 그 출력은 프로세스의 crash 파일로 가고, 각 goroutine 진입점의 `recover`가 `error` event를 쓴다. Rust host는 panic hook에서 `error` event를 쓰고 flush한다.

event를 쓰는 각 저장소는 자기 작은 writer 구현을 가지며 `packages/log-contract/fixtures`의 golden lines와 golden catalog로 시험한다. 저장소 사이에 runtime 코드를 공유하지 않으며 sidecar는 실행 중에 core 릴리스에 의존하지 않는다.

## 파일

프로세스 실행 하나가 설정 폴더 아래 `logs/<role>-<boot>.jsonl`을 쓴다. host 프로세스는 native 라이브러리, page, plugin의 event도 담는다. 각 writer는 자기 파일만 100 MB에서 회전하고 이전 세대 5개(`.1`에서 `.5`)를 남기며 다른 프로세스의 파일은 회전하지 않는다. 회전이 일으키는 유일한 손실은 가장 오래된 세대이며 writer가 회전을 기록한다.

event가 아닌 raw 파일이 둘 있다. `logs/<role>-<boot>.stderr`는 프로세스의 표준 오류(운영체제와 framework의 출력)를, `logs/<role>-<boot>.crash`는 runtime fatal 오류의 crash 출력을 담는다. viewer는 이를 event 파일과 함께 나열한다.

파일은 mode `0600`으로, 폴더는 mode `0700`으로 만들고 close-on-exec로 열어서 자식 프로세스가 물려받지 않는다.

상태 파일 `logs/state-<time>.json`과 capture는 event가 아니며 [debug](debug.ko.md)가 쓴다.

## catalog

event를 내는 각 저장소는 `events.json`에 event를 선언한다: event마다 이름, 층, class, level, 필수 field와 그 타입, 가릴 인자, 인자의 크기 상한, 설명. 저장소는 다른 모든 검사에서 자기 소스를 검사하듯 자기 소스를 자기 catalog로 검사한다. 이 저장소는 catalog의 schema와 `native`·`host` 층, page의 event를 소유한다. plugin이나 sidecar는 manifest(`events`)에 자기 catalog를 선언하고, viewer가 설치된 manifest의 catalog를 읽는다. 이 저장소는 그것을 이름으로 부르지 않는다.

catalog는 입력 종류마다 남겨야 하는 사슬도 선언한다. 첫 층에서 마지막 층까지 event의 순서 있는 목록이다(예: `native.input.key_down`, host 중계, `page.terminal.send`, `sidecar.vt.pty_write`). 로그 감사는 입력의 선언된 사슬이 모두 완결되어 있기를 요구한다.

### 입구

다음 입구는 호출 지점이 기록을 쓰지 않아도 기록한다.

- host의 page 호출(Go host는 감싸는 함수 하나, Rust host는 invoke 인터셉터 하나);
- 창·애플리케이션 이벤트(각 host의 등록 helper 하나);
- registry 명령(page의 `timed`);
- sidecar 수명(launch와 exit);
- 사람이 보는 오류의 표시. 이것이 `error` event를 낸다.

알림 observer, delegate, key-value observer, 타이머, task의 종료처럼 어떤 입구도 덮지 못하는 원천은 소스 lint가 선언이나 사유 주석이 없는 event를 나열한다. lint는 증명이 아니다. 범위는 실행 중에 판단한다: window check가 선언된 명령과 native 입력으로 선언된 원천을 하나씩 구동하고 그 선언된 event를 요구한다.

## 검사

`soksak-log-check`(패키지 `@soksak/log-contract`, `packages/log-contract`)는 로그를 schema와 catalog로 검증한다: 줄 구조, 선언된 event, 연속된 `seq`와 `log.dropped`로 설명되는 틈, 입력 종류마다 선언된 사슬, 시험이 선언한 것 외의 `error` 없음. 단위 시험과 window check는 자기 로그를 남기고, gate는 남은 모든 로그를 검증하며, 실패한 실행의 로그는 분류하기 전까지 보관한다.

입력은 독립 수신자와 비교한다: 기록된 `pty_write` 바이트는 shell 대역이 파일에 쓴 바이트와 같다.

## 개인정보

입력한 글은 이 컴퓨터의 `logs/`에 저장된다. 사람이 파일을 넘길 때만 컴퓨터를 떠난다. 파일이나 선택을 저장하는 동작은 파일이 입력한 내용을 담을 수 있다고 경고한다. catalog가 가림으로 표시한 인자는 크기와 hash로 저장한다.

## 한계

- wall clock은 되감기고 잠든 기계와 깨어난 기계 사이에서 어긋날 수 있다. `mono_ns`가 한 부팅 안의 프로세스 사이 event를 정렬하고 `cids`가 한 입력의 층을 정렬한다. page는 wall clock만 가진다.
- 신호 처리기는 async-signal-safe 함수만 호출할 수 있어서 시작할 때 준비한 짧은 줄을 쓴다. crash 때 마지막 배치 간격(최대 100 ms)의 `info` event를 잃을 수 있다. `error`는 writer에 바로 넘기지만 writer가 돌기 전에 프로세스가 죽으면 잃는다.
- page는 파일을 쓸 수 없어 배치 호출로 host를 거쳐 기록한다. page 프로세스가 끝날 때 아직 보내지 않은 배치는 잃는다(flush 간격까지).
- PTY 출력이 폭주해 파일을 채우면 회전이 가장 오래된 세대를 밀어낸다. writer가 각 회전을 기록한다.
- 입력기는 활성 애플리케이션의 key window에서만 답하므로, 조합한 입력의 검사에는 애플리케이션이 활성인 실행이 필요하다.
