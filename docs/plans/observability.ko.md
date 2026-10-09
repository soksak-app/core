# 관측 기반 계획

[English](observability.md)

상태: 적대적 검토를 거쳐 고친 미결 제안. 단일 작업 체크리스트는 [기능](../features.ko.md)(F149, F150, F151)에 있다. 이 제안은 작업을 시작하기 전의 내용을 설명한다. 작업이 만드는 계약은 명세에 두며, 명세가 그 내용을 담으면 이 제안을 제거한다.

## 구조를 다시 세우는 이유

- 기록 형식이 둘이다: `application.log`의 글 기록([진단](../spec/diagnostics.ko.md#형태))과 `performance.ndjson`의 JSON lines([성능 trace](../spec/performance-trace.ko.md)). 기록기는 언어와 목적마다 따로다: native 라이브러리(`sp_log_*`), Go host, Rust host, page(`performance.js`), terminal sidecar(`performance.rs`, `service_log.rs`). Go sidecar(files, shell)는 구조화된 기록을 쓰지 않고 host가 그 표준 오류 줄을 감싼다. 파서도 따로다(window check의 `readErrors`와 개별 검사의 파서).
- 비용이 구조에 있다. page trace는 이벤트마다 host 호출을 하고 호출을 promise 체인으로 직렬화한다. native 라이브러리는 UI 스레드를 포함해 호출한 스레드에서 기록마다 `write(2)`를 한다. 화면 이벤트는 셀 배열 전체를 싣는다(Enter 한 번이 약 40개 기록을 만들었다). 이벤트 볼륨을 분류하는 기준이 없다.
- 누락이 구조적이다. 사건을 기록해야 하는 곳마다 기록을 쓰는 일이 사람의 기억에 달려 있다. native 라이브러리, 두 host, page, plugin, sidecar의 감사는 기록이 없는 사건 원천 수백 곳을 찾았다: 기록이 하나도 없는 native 소스 파일 17개, Rust page 명령 69개 중 68개, terminal sidecar의 조용한 task·connection 종료 약 88곳, Go sidecar의 모든 연산. 새 원천이 기록 없이 들어오는 것을 막는 장치가 없다.
- 로그가 열리기 전의 기록은 터미널로 가고, Go host는 runtime fatal 오류를 가로챌 수 없으며, 입력 하나를 native 콜백에서 PTY 쓰기까지 잇는 식별자가 없어 두 층 사이에서 입력한 글이 바뀐 곳을 찾을 수 없다.
- F145.6은 `orderedSidecar`의 실패 처리기를 필수로 바꾸면서 `packages/workbench/host.js`의 호출부를 바꾸지 않았다. 한 번 실패한 뒤에는 메인 페이지에서 같은 sidecar 이름의 이후 전송이 모두 거부된다. 이 변경은 어떤 릴리스에도 들어 있지 않다.

## 원칙

1. **하나의 event 계약.** 모든 층의 모든 기록은 같은 구조의 event 하나다. 글 기록 형식과 trace 형식은 합쳐 없앤다. 사람이 읽는 글은 저장 형식이 아니라 보기(view)다.
2. **생산자는 막히지 않는다.** UI 스레드, 입력 경로, frame 경로는 기록을 위해 디스크 접근, IPC, 락 대기, 다른 runtime으로의 외부 스레드 호출을 하지 않는다. 비활성 event는 분기 하나, 활성 event는 bounded 큐로의 복사 하나의 비용이다.
3. **손실은 세고 밝힌다.** 어떤 큐, rate limit, 회전, 절단도 조용히 버리지 않는다. 버린 event의 수와 바이트를 `log.dropped` event로 기록하고 모든 상한을 계약에 적는다.
4. **입력 경로에서 층이 본 것을 자르지 않는다.** `input` class의 기록과 `io` class의 PTY 쓰기·읽기는 [진단](../spec/diagnostics.ko.md#규칙)이 이미 요구하는 대로 모든 값과 모든 바이트를 담는다. event는 가변 길이다.
5. **event는 선언한다.** 모든 event는 이름, 층, class, 기본 level, 필수 field와 함께 catalog에 선언한다. event를 내는 저장소가 자기 catalog를 소유한다. 개발과 CI는 선언하지 않은 event를 거부한다. 실행 중에는 선언하지 않은 event도 `undeclared`로 표시해 세고 쓴다. 이름 오류가 증거를 버리지 않게 하기 위해서다.
6. **병목 지점이 자동으로 기록한다.** 같은 종류의 event는 한 입구에서 기록한다: page→host 호출, 창·애플리케이션 이벤트, registry 명령, sidecar 수명, 오류 표시. 호출 지점이 자기 기록을 쓰지 않는다.
7. **구조가 완결된 뒤에 닫는다.** 목표를 맞추려고 기준값을 낮추거나, 기능을 끄거나, 층을 빼지 않는다. 표준 설계가 제공하지 못하는 부분은 *한계*에 밝힌다.
8. **끝 상태에는 하위 호환이 없다.** 층이 새 계약으로 옮겨가면 그 층의 옛 기록기, 파일 형식, 파서를 같은 시리즈에서 제거한다. 다른 schema를 만난 reader는 파일 이름과 발견한 값을 담은 오류로 그 파일을 거부한다. 백엔드를 바꾸는 동안 옛 호출 서명을 유지하는 과도기 adapter는 그렇게 이름 붙이고, 작업을 닫기 전에 제거한다.

## 설계

### event 모델 (계약은 `docs/spec/logging.md`에 둔다)

```
{"ts_us":1791..., "mono_ns":..., "seq":812, "level":"info", "layer":"native", "event":"native.input.key_down",
 "window":"w1", "surface":"tab-x", "session":"...", "cids":["b3.1042"], "fields":{...}}
```

- `ts_us`는 마이크로초 단위 wall clock이다. `mono_ns`는 시스템 전체의 monotonic 시계(macOS는 `mach_absolute_time`, Linux는 `CLOCK_MONOTONIC`)로, 한 부팅 안의 프로세스 사이에서 비교할 수 있고 되감기지 않는다. page는 `ts_us`만 가진다. `seq`는 writer가 직렬화할 때 붙이므로 한 프로세스의 저장된 event는 생산자의 공유 카운터 없이 연속된 `seq`를 가진다. 버린 event는 그 범위와 함께 `log.dropped`로 따로 기록한다. 프로세스의 정체(`pid`, `role`, `boot`)는 첫 줄 `log.open`에 한 번 쓰고, 이 줄이 schema 번호도 담는다.
- `level`은 `error`, `warn`, `info`, `debug`, `trace`다. `layer`는 `native`, `host`, `page`, `plugin`, `sidecar`다.
- 이름은 `<layer>.<subsystem>.<event>`다(`native.input.key_down`, `host.endpoint.close`, `page.terminal.send`, `sidecar.vt.pty_write`). 이름은 catalog가 정한다.
- `cids`는 상관 식별자의 목록이다. native 입력 콜백 하나(키 event, 붙여넣기, drop, 포인터 보고)를 처음 본 층이 식별자 `<boot>.<n>` 하나를 발급하고, 그 콜백이 일으키는 콜백(`setMarkedText`, `insertText`, `commitThrough`)은 이를 이어받는다. 입력 여럿을 합치는 전송은 그 식별자를 모두 나른다. 식별자는 native 보고, host 중계, page event와 함께 가고, plugin이 전송에 실어 넘기며, host가 sidecar로 가는 요청 envelope에 실어 나르므로 plugin 본문은 plugin의 것으로 남는다.
- 파일: `logs/<role>-<boot>.jsonl`, 프로세스 실행마다 하나이며 host 프로세스는 native, page, plugin event도 담는다. 각 writer는 자기 파일만 회전한다(100 MB, 이전 세대 5개). 프로세스의 raw 표준 오류는 `logs/<role>-<boot>.stderr`에, runtime fatal 오류의 crash 출력은 `logs/<role>-<boot>.crash`에 둔다. 둘은 event가 아닌 raw 파일이며 viewer가 목록에 보인다. 파일은 mode 0600, 폴더는 mode 0700으로 만들고 close-on-exec로 연다.

### class와 정책

| class | 예 | 발생률 | 기본 정책 |
| --- | --- | --- | --- |
| `lifecycle` | 창, 애플리케이션, sidecar, 세션의 수명. 설정, 프로젝트, plugin, 업데이트의 변경 | 낮음 | 항상 저장 |
| `input` | 키, 입력기 콜백, 붙여넣기, 클릭 | 사람 속도 | 항상 완전하게 저장: 입력한 글, 범위, flag, 앞뒤 상태 |
| `call` | page→host 호출, registry 명령, endpoint 메서드(이름, 인자, 결과, 마이크로초) | 중간 | 저장. 선언한 크기 상한을 넘는 인자는 상한까지 저장하고 `truncated`로 표시한다. catalog는 가릴 인자(token, 문서 본문)를 표시하고 그 크기와 hash를 저장한다 |
| `io` | sidecar 메시지, PTY 읽기와 쓰기 | 중간~높음 | 완전하게 저장. 상한은 파일의 회전뿐이며 이것이 유일한 shedding으로 문서화되고, 일어날 때 기록한다 |
| `frame` | 그림 frame, 화면, 포인터 이동, wheel, layout | 높음 | 집계: 선언한 간격마다 요약 event 하나(횟수, 극값, 마지막 값, 총 마이크로초). category를 켜 두는 동안은 전체 상세를 저장한다 |

- 정책은 host가 설정 `diagnostics.log`로 쓰는 파일 `<config-dir>/log-policy.json`이다. 모든 프로세스가 파일 시스템 event로 이 파일을 감시하고 바뀌면 다시 읽는다. sidecar 프로토콜 연산은 더하지 않는다. 이 설정은 `diagnostics.performance`를 대체하며, 설정 loader가 옛 키를 어떻게 다루는지는 R1에서 확인해 명세에 적는다.
- 화면 본문 같은 큰 값은 event에 쓰지 않고 크기와 hash를 쓴다. 본문은 `frame` category를 켜면 얻는다.

### writer

- 생산자: 정책을 확인하고(분기 하나), event를 소유하는 메시지로 만들어, 개수와 바이트로 제한한 큐에 막힘 없이 넣는다. 큐가 가득 차면 손실 카운터를 올리고 writer가 이를 `log.dropped`로 바꾼다. 만들기 비싼 field는 closure로 넘기거나 `enabled(name)`으로 감싼다. 전용 writer 스레드가 `seq`를 붙이고, JSON으로 직렬화하고, 배치(100 ms, 64 KB, 또는 `error`는 즉시)로 쓰고, 회전한다. `error`는 writer를 깨우고 돌아오며, 생산자는 디스크를 기다리지 않는다.
- writer 실패: 쓰기 오류(디스크 가득 참, 입출력 오류)는 세어 상태로 보이고 쓰기가 다시 되면 `log.dropped` event로 남긴다. 죽은 writer 스레드는 heartbeat로 감지해 fatal 보고와 함께 프로세스를 끝낸다. 모든 종료 경로가 프로세스를 끝내기 전에 `Flush(deadline)`을 부른다: Go shutdown, Rust exit, `panic = abort`, `os.Exit`.
- 라이브러리는 작고 저장소마다 있다: core의 Go host와 Rust host, 각자 저장소의 terminal sidecar와 Go sidecar 둘. core는 계약을 둔다: 명세, schema, golden JSON lines, 검사기 `soksak-log-check`. 각 저장소는 golden lines로 자기 라이브러리를 시험한다(core의 fixture는 plugin이 오늘 `@soksak/plugin-api`를 쓰듯 시험 전용 의존으로 가져온다). 저장소 사이에 runtime 코드를 공유하지 않으며 sidecar는 실행 중에 core tag에 의존하지 않는다. 라이브러리는 platform 배치(`src/`, `src/platform/<os>/`, `tests/`)를 따르고 parity inventory에 시험 lane을 선언한다.
- native: 라이브러리가 C의 bounded lock-free ring을 소유한다. `sp_event`는 어느 스레드에서든 event를 ring에 복사하고, host의 writer 스레드가 pull 호출 `sp_event_drain`으로 비운다. 어떤 생산자 스레드도 Go나 Rust를 부르지 않는다. host writer가 생기기 전의 event는 ring에서 기다리므로 시작 때의 기록을 잃지 않는다. host 없는 native 시험은 ring을 직접 비운다.
- page: `context.log.<level>(event, fields)`가 event를 모아 `logBatch(events)` 호출 하나로 보낸다. flush는 100 ms 타이머, 크기 상한, `pagehide`와 `visibilitychange`에서 일어나며 생산자는 응답을 기다리지 않는다. `console.*`, 전역 `error`, `unhandledrejection`도 같은 입구로 들어간다. surface와 modal 문서는 같은 `page.log`를 쓴다.
- fatal: 신호 처리기는 시작할 때 열어 둔 파일 descriptor에 async-signal-safe 호출만으로 짧은 줄을 쓴다. Go는 runtime fatal 오류를 가로챌 수 없으므로 `debug.SetCrashOutput`이 그 출력을 `.crash` 파일로 보내고, goroutine 진입점의 `recover`가 `error` event를 쓴다. Rust는 `error` event를 쓰고 flush하는 panic hook을 쓴다.

### catalog와 범위

- 각 저장소가 `events.json`(이름, 층, class, level, 필수 field의 이름과 타입, 가릴 인자, 설명)에 자기 event를 선언하고, 모든 저장소가 이미 자기 소스를 검사하듯 자기 소스를 검사한다. core는 schema와 `native`·`host` 층, page의 event를 소유한다. plugin이나 sidecar는 manifest(`events`)로 자기 catalog를 선언하고, viewer가 설치된 manifest의 catalog를 읽는다. core는 그것을 이름으로 부르지 않는다.
- 사슬(chain): catalog가 입력 종류마다 남겨야 하는 지점(`native.input.key_down`, host 중계, `page.terminal.send`, `sidecar.vt.pty_write`)을 선언하므로 빠진 지점은 더 짧은 목록이 아니라 실패다.
- 자동 입구가 수백 곳의 호출 지점을 대체한다: Go `Host`의 page 호출을 감싸는 함수 하나, Rust host의 invoke 인터셉터 하나, 창·애플리케이션 이벤트의 등록 helper 하나, registry 명령의 `exposure.js` `timed`, sidecar 수명의 launch와 exit, 사람이 보는 오류의 단일 표시 경로가 내는 `error` event.
- 범위는 exposure 규칙이 명령과 상태에 요구하듯 실행 중에 판단한다: window check가 선언된 명령과 native 입력으로 선언된 원천을 하나씩 구동하고 선언한 event가 나타나는지 단언한다. 소스 lint(`NSNotificationCenter addObserver`, `observeValueForKeyPath`, delegate, 타이머, `makeFirstResponder`, `TISSelectInputSource`, task 종료)는 선언한 event나 사유 주석이 없는 원천을 나열한다. lint는 증명이 아니다.

## 단계

각 단계는 변경 전에 기록한 실패 시험과 변경 뒤의 통과, 영어와 한국어 명세, changelog, parity inventory, 전체 gate, 실행 중인 애플리케이션의 관측, 커밋으로 끝난다. 각 커밋은 트리를 통과 상태로 둔다. 작업 단위마다 자기 체크리스트 ID를 가지며, 완료한 항목은 다시 열지 않는다.

- **R0 열린 단위 마치기.** F145.6의 회귀를 고친다(실패 시험: 메인 페이지에서 실패한 전송 뒤의 두 번째 전송이 전달된다. `orderedSidecar`는 없는 실패 처리기를 경계에서 거부하고 `host.js`는 실패를 보고한다). F145.12(endpoint timeout 기록), native 입력 상태 field(`responder`, `keyWindow`, `active`), 입력 경로 검사를 각자의 단위로 마친다. 새 ID를 등록한다.
- **R1 계약(문서만).** `logging.md`: 원칙, event 모델, class와 정책, 파일, 시계, 상관 식별자와 그 범위, 손실 계수, 권한, 개인정보(입력한 글은 이 컴퓨터의 `logs/`에만 있고 사람이 넘길 때만 나가며, 저장 동작에서 경고한다), 가림, crash 경로, 언어별 예산. 계약이 바꾸는 [진단](../spec/diagnostics.ko.md)과 [성능 trace](../spec/performance-trace.ko.md)를 고친다. schema, golden fixtures, `soksak-log-check`, 용어(`event`, `class`, `cid`), AGENTS.md 규칙의 변경. 옛 설정 키의 처리를 확인해 명세에 적는다.
- **R2 prototype과 측정.** pull 호출이 있는 C ring, Rust와 Go writer, page 배치 중계를 계약 시험과 전용 benchmark로 실제 host에서 cgo와 FFI를 건너 측정한다: 비활성 비용, host와 언어별 활성 enqueue 비용, writer 처리량, 큐가 가득 찬 때의 손실 계수, 시작 버퍼, 기록을 켠 경우와 끈 경우의 키 주입에서 PTY 쓰기까지의 입력 지연. 예산(비활성 event는 분기 하나, 활성 enqueue는 짧은 복사, 생산자는 막히지 않음)은 benchmark가 기록하는 목표이며, 목표를 놓치면 목표가 아니라 설계를 바꾼다.
- **R3 host 백엔드.** 기존 기록 호출(`LogError`, `LogInfo`, `log_error`, `log_info`, `sp_log_*`, `report`, `log`)의 백엔드를 서명을 유지한 채 새 writer로 바꾸되, window check parser와 줄을 정확히 단언하는 시험과 같은 커밋에서 바꾸고 옛 writer와 형식을 제거한다. 서명 adapter는 과도기이며 호출 지점이 선언된 event로 옮겨가는 R5에서 제거한다. 시작 버퍼, 표준 오류와 crash 파일.
- **R4 page.** `performance.js`의 event별 promise 체인을 배치 중계로 바꾸고 `console.*`와 전역 오류를 캡처한다.
- **R5 입구와 호출 지점.** 입구마다 커밋 하나(page→host 호출, registry 명령, 창·애플리케이션 이벤트, sidecar 수명, 오류)로 catalog 항목을 더하고 그것이 덮는 호출 지점을 제거한다. 이어 남은 호출 지점을 선언된 event로 옮기고 adapter를 제거한다. F145.13에서 F145.18은 이 단계에 속한다.
- **R6 sidecar와 plugin, 각자 저장소에서.** terminal sidecar(`performance.rs`, `service_log.rs` 제거), files와 shell(신규). 각자 라이브러리 사본, catalog, 체크리스트 항목, 릴리스를 가진다. 요청 envelope가 `cids`를 나른다(추가 field이며 모르는 sidecar는 무시한다). plugin API에 `sidecar.send(surface, body, { cids })`를 더하고 plugin이 이를 넘긴다. 정책은 감시하는 파일로 sidecar에 닿는다.
- **R7 viewer.** 같은 파서 위의 debug 화면: 필터(층, level, event, 표면, 세션, 글자, 시간 범위)가 있는 타임라인, 파일 변경 알림으로 따라가기, 한 상관 식별자 따라가기, 앞뒤 줄, `state-*.json`의 상태 보기와 비교, raw 파일을 포함한 파일 목록, 선택 저장. 명령 `sok debug timeline`이 같은 목록을 출력한다. 명령, 상태, DOM 이름은 exposure 규칙으로 선언한다.
- **R8 native observer와 실행 중 감사.** 감사가 찾은 native 원천(애플리케이션 active·resign, key·main window, occlusion, workspace, 입력 소스 변경, pasteboard, first responder 변경 전후, `keyDown` 분기, 입력기 질의), host event(창, sidecar, endpoint, 설정, 프로젝트, plugin, 업데이트, 종료), terminal sidecar(task 종료, 거부, 빈 키 바이트, control·alt와 함께 잘리는 `Char`, replay 절단), page(입력을 버리는 분기)를 각각 한 단위로 선언·기록하고 그것을 구동하는 window check를 둔다.
- **R9 관측과 마감.** 두 host의 실행 중인 애플리케이션에서 입력한다: Enter, 영문, 조합한 한글(활성화 등급), 붙여넣기, control·alt 키, 한 번에 2000자. 상관 식별자 하나가 native 콜백에서 PTY까지 모든 층을 잇고, 기록된 `pty_write` 바이트가 독립 수신자(읽은 것을 파일에 쓰는 shell 대역)가 받은 바이트와 같다. benchmark를 기록한다. 문서를 갱신한다. 모든 manifest에 버전을 선언한 core 0.0.11을 릴리스하고, 바뀐 sidecar와 plugin의 릴리스와 registry 항목을 만든다.

## 문서, 규칙, 메모리

- 명세: `logging.md`와 `events.md`, schema(신규, 영어와 한국어). `diagnostics.md`, `performance-trace.md`의 기록 형식과 `hosts.md`, `native-host.md`, `sidecars.md`의 로그 부분을 대체한다. `debug.md`, `settings.md`, `plugins.md`(manifest의 `events` field)를 갱신한다. host 계약의 `log.*` 행은 새 계약 시험의 행으로 대체한다.
- AGENTS.md와 한국어 사본: 글 기록 규칙과 진단 빌드의 성능 trace 문구를 event와 정책 용어로 바꾸고, 새 event 원천은 자기 저장소의 catalog에 선언하고, 생산자는 막히지 않고, 손실은 세고, `console`은 입구로 캡처한다는 규칙을 더한다.
- F138의 글 기록 형식은 연결된 후속 항목이 대체한다.
- 저장소 밖 메모리에 바닥부터의 설계, 성능, 표준 방식에 대한 선호를 기록한다.

## 기각한 대안

- 지금 구조에 field와 기록을 더하기: 형식 둘, 기록기 다섯, 수백 곳의 호출 지점이 남아 누락과 비용이 반복된다.
- binary나 memory-mapped 형식(시스템 로그 방식): crash에는 더 강하지만 도구, 검사, 사람이 읽는 비용이 이 필요에 비해 크다. `error`를 바로 넘기는 JSON lines로 충분하며, crash 뒤 마지막 배치 간격의 기록을 약속하지 않는다.
- flight recorder(오류 때 덤프하는 메모리 ring): 다른 프로세스에서의 덤프는 새 wire 연산과 멈췄을지 모르는 page로의 프로세스 간 호출이 필요하고, crash는 가장 필요할 때 ring을 잃는다. 집계한 `frame` 요약과 켜고 끄는 상세 category가 그 경로 없이 같은 범위를 준다.
- host 한 곳에 모든 프로세스를 모으는 집계기: 지속 terminal service가 host보다 오래 살아서 host가 죽으면 증거가 사라진다. 프로세스마다 파일 하나를 쓰고 보기에서 병합한다.
- 글을 저장 형식으로 유지하기: 파서 둘과 규칙 둘이 남고 field가 구조화되지 않는다. 글은 보기에서 만든다.
- core의 tag로 가져가는 공유 라이브러리: 하위 폴더의 Go module은 core가 만들지 않는 경로 접두 tag가 필요하고, sidecar의 offline 빌드가 네트워크를 요구하게 되며, sidecar가 실행 중에 core 릴리스에 의존하게 된다. 계약, golden fixture, 저장소별 작은 라이브러리가 셋을 모두 피한다.
- native 라이브러리에서 Go writer로의 callback: Go runtime이 만들지 않은 스레드에서의 호출은 마이크로초에서 수십 마이크로초가 든다. host가 native ring에서 pull한다.

## 한계

- wall clock은 되감기고 잠든 기계와 깨어난 기계 사이에서 어긋날 수 있다. `mono_ns`가 한 부팅 안의 프로세스 사이 event를 정렬하고 `cids`가 한 입력의 층을 정렬한다. page는 wall clock만 가진다.
- 신호 처리기는 async-signal-safe 함수만 호출할 수 있어서 시작 때 열어 둔 descriptor에 짧은 줄을 쓴다. crash 때 마지막 배치 간격(최대 100 ms)의 `info` event를 잃을 수 있다. `error`는 writer에 바로 넘기지만 writer가 돌기 전에 프로세스가 죽으면 잃는다.
- page는 파일을 쓸 수 없어 배치 호출로 host를 거쳐 기록한다. page 프로세스가 끝날 때 아직 보내지 않은 배치는 잃는다(flush 간격까지).
- 입력기는 활성 애플리케이션의 key window에서만 답하므로, 조합한 한글 입력의 관측에는 활성화 등급 실행이 필요하다.
- PTY 출력이 폭주해 파일을 채우면 회전이 파일의 가장 오래된 기록을 밀어낸다. 계약이 이 상한을 적는다.

## 검증

- 모든 단계의 교차 검증. 세 출처가 일치해야 단계를 닫는다: 시험의 단언(변경 전 실패, 변경 후 통과), 단위 시험과 창 시험이 남긴 로그, 실행 중인 애플리케이션의 관측. 변경 전에는 실패한 시험과 로그에 event가 없음을 함께 기록한다. 변경 뒤에는 시험이 통과하고, 남은 로그에 기대한 event가 field와 함께 있으며, 예상하지 못한 `error`와 설명되지 않는 `log.dropped`가 없다. 로그 감사 gate는 시험이 남긴 모든 로그를 `soksak-log-check`로 검증한다(schema, 선언된 event, 연속된 `seq`, `log.dropped`로 설명되는 손실, 입력 종류마다 완결된 선언 사슬, 선언한 예상 오류 외의 `error` 없음). 실패한 실행의 로그는 분류하기 전까지 보관한다.
- 독립 oracle: 입력은 shell 대역이 받은 바이트를 기록된 `pty_write` 바이트와 비교하므로 검사가 로그를 로그와 비교하지 않는다. 각 host의 실행 중인 애플리케이션에서 같은 시나리오를 실행해 시험의 로그와 event, field, 순서를 비교하며, 차이는 결함이다.
- gate: `make docs-check native-test boundaries exposure-check parity-check platforms hosts-check rust-format-check go-format-check rust-clippy-check host-contract-check`, 이어서 `pnpm test`를 `&&`로 묶어 종료 줄로 판단하고, push마다 CI를 읽는다. benchmark는 단계의 개발이 끝난 뒤 기록하며 부하에 따른 시간 때문에 항목을 열어 두지 않는다.
- 사람이 쓰는 애플리케이션과 그 데이터 폴더는 읽기만 한다. 검사 애플리케이션은 자기 설정 폴더와 프로세스를 쓴다.
