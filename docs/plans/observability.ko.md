# 관측 기반 계획

[English](observability.md)

상태: 미결 제안. 단일 작업 체크리스트는 [기능](../features.ko.md)(F149, F150, F151)에 있다. 이 제안은 작업을 시작하기 전의 내용을 설명한다. 작업이 만드는 계약은 명세에 두며, 명세가 그 내용을 담으면 이 제안을 제거한다.

## 구조를 다시 세우는 이유

- 기록 형식이 둘이다: `application.log`의 글 기록([진단](../spec/diagnostics.ko.md#형태))과 `performance.ndjson`의 JSON lines([성능 trace](../spec/performance-trace.ko.md)). 기록기는 언어와 목적마다 따로다: native 라이브러리(`sp_log_*`), Go host, Rust host, page(`performance.js`), terminal sidecar(`performance.rs`, `service_log.rs`). Go sidecar(files, shell)에는 없다. 파서도 따로다(window check의 `readErrors`와 개별 검사의 파서).
- 비용이 구조에 있다. page trace는 이벤트마다 host 호출을 하고 호출을 promise 체인으로 직렬화한다. native 라이브러리는 UI 스레드를 포함해 호출한 스레드에서 기록마다 `write(2)`를 한다. 화면 이벤트는 셀 배열 전체를 싣는다. 이벤트 볼륨을 분류하는 기준이 없다.
- 누락이 구조적이다. 사건을 기록해야 하는 곳마다 기록을 쓰는 일이 사람의 기억에 달려 있다. native 라이브러리, 두 host, page, plugin, sidecar의 감사는 기록이 없는 사건 원천 수백 곳을 찾았다: 기록이 하나도 없는 native 소스 파일 17개, Rust page 명령 69개 중 68개, terminal sidecar의 조용한 task·connection 종료 약 88곳, Go sidecar의 모든 연산. 새 원천이 기록 없이 들어오는 것을 막는 장치가 없다.
- 로그가 열리기 전의 기록은 터미널로 가고, Go host에는 panic hook이 없으며, 입력 하나를 native 콜백에서 PTY 쓰기까지 잇는 식별자가 없어 두 층 사이에서 입력한 글이 바뀐 곳을 찾을 수 없다.
- F145.6은 `orderedSidecar`의 실패 처리기를 필수로 바꾸면서 `packages/workbench/host.js`의 호출부를 바꾸지 않았다. 한 번 실패한 뒤에는 메인 페이지에서 같은 sidecar 이름의 이후 전송이 모두 거부된다. 이 변경은 어떤 릴리스에도 들어 있지 않다.

## 원칙

1. **하나의 event 계약.** 모든 층의 모든 기록은 같은 구조의 event 하나다. 글 기록 형식과 trace 형식은 합쳐 없앤다. 사람이 읽는 글은 저장 형식이 아니라 보기(view)다.
2. **생산자는 막히지 않는다.** UI 스레드, 입력 경로, frame 경로는 기록을 위해 디스크 접근, IPC, 락 대기, 큰 할당을 하지 않는다. 비활성 event는 분기 하나, 활성 event는 고정 크기 enqueue 하나의 비용이다.
3. **손실은 센다.** 어떤 큐, rate limit, 절단도 조용히 버리지 않는다. 버린 event의 수와 바이트를 `log.dropped` event로 기록한다.
4. **event는 선언한다.** 모든 event는 이름, 층, class, 기본 level, 필수 field와 함께 catalog `docs/spec/events.json`에 선언한다. 선언하지 않은 event는 시험이 실패하고, 선언했지만 아무도 내지 않는 event는 감사가 실패한다.
5. **병목 지점이 자동으로 기록한다.** 같은 종류의 event는 한 입구에서 기록한다: page→host 호출, 창·애플리케이션 이벤트, registry 명령, sidecar 수명, 오류 표시. 호출 지점이 자기 기록을 쓰지 않는다.
6. **구조가 완결된 뒤에 닫는다.** 목표를 맞추려고 기준값을 낮추거나, 기능을 끄거나, 층을 빼지 않는다. 표준 설계가 제공하지 못하는 부분은 *한계*에 밝힌다.
7. **하위 호환이 없다.** 새 계약이 서면 옛 기록기, 파일 형식, 파서를 제거한다. 다른 schema를 만난 reader는 파일 이름과 발견한 값을 담은 오류로 그 파일을 거부한다.

## 설계

### event 모델 (계약은 `docs/spec/logging.md`에 둔다)

```
{"ts_us":1791..., "seq":812, "level":"info", "layer":"native", "event":"native.input.key_down",
 "window":"w1", "surface":"tab-x", "session":"...", "cid":"b3.1042", "fields":{...}}
```

- `ts_us`는 마이크로초 단위 wall clock이며 층 사이의 순서를 가린다. `seq`는 프로세스 안에서 증가하며 같은 마이크로초 안의 순서와 손실된 event를 보인다. 프로세스의 정체(`pid`, `process`, `boot`)는 첫 줄 `log.open`에 한 번 쓰고, 이 줄이 schema 번호도 담는다.
- `level`은 `error`, `warn`, `info`, `debug`, `trace`다. `layer`는 `native`, `host`, `page`, `plugin`, `sidecar`다.
- 이름은 `<layer>.<subsystem>.<event>`다(`native.input.key_down`, `host.endpoint.close`, `page.terminal.send`, `sidecar.vt.pty_write`). 이름은 catalog가 정한다.
- `cid`는 상관 식별자다. 입력을 처음 본 층이 발급하고(`<boot>.<n>`), 그 입력의 native 보고, host 중계, page event, plugin 전송, sidecar 요청, `pty_write`가 같은 값을 나른다. 한 입력의 층을 잇는다.
- 파일: 프로세스마다 `logs/<process>.jsonl` 하나이며 host 프로세스는 native, page, plugin event도 담는다. 프로세스의 raw 표준 오류(운영체제와 framework 출력)는 event와 분리해 `logs/<process>.stderr`에 둔다. 회전은 100 MB와 이전 세대 5개다.

### class와 정책

| class | 예 | 발생률 | 기본 정책 |
| --- | --- | --- | --- |
| `lifecycle` | 창, 애플리케이션, sidecar, 세션의 수명. 설정, 프로젝트, plugin, 업데이트의 변경 | 낮음 | 항상 저장 |
| `input` | 키, 입력기 콜백, 붙여넣기, 클릭 | 사람 속도 | 항상 저장. 입력한 글, 범위, flag를 담는다 |
| `call` | page→host 호출, registry 명령, endpoint 메서드(이름, 인자, 결과, 마이크로초) | 중간 | 저장. 크기 상한을 넘는 인자는 상한까지 저장하고 `truncated`로 표시한다 |
| `io` | sidecar 메시지, PTY 읽기와 쓰기 | 중간~높음 | 쓰기는 저장. 읽기는 token bucket으로 제한하고 초과분을 `log.dropped`로 센다 |
| `frame` | 그림 frame, 화면, 포인터 이동, wheel, layout | 높음 | flight recorder: 메모리 ring에 보관하고, error·fatal 신호·요청 때 직전 몇 초의 ring을 `log.ring_dump`로 저장한다. category를 켜면 계속 저장한다 |

- 설정 `diagnostics.log`가 정책을 고르고 `diagnostics.performance`를 대체한다. host가 모든 프로세스에 정책을 전달하며, sidecar는 연결할 때와 정책이 바뀔 때 프로토콜 연산 `log.policy`를 받는다. 0.0.x 진단 빌드의 기본은 `lifecycle`, `input`, `call`, `io`를 저장하고 `frame`을 ring에 둔다.
- 화면 본문 같은 큰 값은 event에 쓰지 않고 크기와 hash를 쓴다. 본문은 `frame` class를 켜면 얻는다.

### 기록기

- 생산자는 event가 켜져 있는지 확인하고(분기 하나), 고정 크기 구조체를 bounded multi-producer queue에 막힘 없이 넣고, 전용 writer 스레드가 JSON으로 직렬화해 배치(100 ms 또는 64 KB)로 쓴다. `error`는 즉시 flush한다. fatal 신호 처리기는 미리 만들어 둔 짧은 JSON 줄을 `write(2)`로 쓴다.
- 위치: core의 `packages/log/{rust,go,js}`. host와 sidecar가 같은 라이브러리를 쓴다. 다른 저장소의 sidecar는 plugin이 `@soksak/plugin-api`를 고정하듯 core tag를 고정한 의존으로 가져온다. 각 라이브러리는 자기 패키지에서 계약 시험(golden JSON lines와 검사기 `soksak-log-check`)을 실행한다.
- native: 라이브러리는 writer를 갖지 않는다. C 인터페이스 `sp_event(level, class, name, fields)`가 host가 설치하는 sink에 event를 넘기고, sink가 생기기 전의 event는 bounded 시작 버퍼에서 기다렸다가 sink가 설치될 때 쓴다. host가 없는 native 시험은 기본 sink를 쓴다.
- page: `context.log.<level>(event, fields)`가 event를 배열에 모아 microtask나 animation frame에서 `logBatch(events)` 호출 한 번으로 보낸다. `console.*`, 전역 `error`, `unhandledrejection`도 같은 입구로 들어간다. surface와 modal 문서는 같은 `page.log`를 쓴다.
- Go sidecar는 지금 기록이 없으므로 처음부터 Go 라이브러리를 쓴다.

### catalog와 자동 입구

- `docs/spec/events.json`이 각 event의 이름, 층, class, level, 필수 field의 이름과 타입, 설명을 선언한다. 시험은 catalog가 선언하지 않은 event를 거부한다.
- 자동 입구가 수백 곳의 호출 지점을 대체한다: Go `Host`의 page 호출을 감싸는 함수 하나, Rust host의 invoke 인터셉터 하나, 창·애플리케이션 이벤트의 등록 helper 하나, registry 명령의 `exposure.js` `timed`, sidecar 수명의 launch와 exit, 사람이 보는 오류의 단일 표시 경로가 내는 `error` event.
- 입구가 덮지 못하는 원천(native 알림 observer, delegate, key-value observer, 타이머, sidecar의 task 종료)은 `make events-check`가 패턴으로 찾으며, 각 원천에는 선언된 event나 사유 주석이 있어야 한다. 이 검사에는 기준선이 없다. 감사가 찾은 기록 없는 원천을 먼저 catalog에 넣어 개수가 0에서 시작한다.

## 단계

각 단계는 변경 전에 기록한 실패 시험과 변경 뒤의 통과, 영어와 한국어 명세, changelog, parity inventory, 전체 gate, 실행 중인 애플리케이션의 관측, 커밋으로 끝난다. 각 단계는 같은 시리즈에서 자기가 대체하는 옛 경로를 제거한다.

- **S0 정리.** F145.6의 회귀를 고친다(실패 시험: 메인 페이지에서 실패한 전송 뒤의 두 번째 전송이 전달된다). 열려 있는 기록(endpoint timeout, native 필드, 입력 경로 검사)을 커밋해 작업 트리를 비운다. 옛 형식 기록은 catalog의 씨앗이 된다. F149, F150, F151을 등록한다.
- **S1 계약.** `logging.md`: 원칙, event 모델, class와 정책, 파일, 시계, 상관 식별자, 손실 계수, 개인정보(입력한 글은 이 컴퓨터의 `logs/`에만 있고 사람이 넘길 때만 나간다). catalog schema, golden fixtures, `soksak-log-check`, 용어(`event`, `class`, `cid`, `ring`), AGENTS.md 규칙의 변경. 성능 예산: 비활성 event는 분기 하나, 활성 enqueue는 99번째 백분위수에서 1 마이크로초 이하, 생산자 스레드는 막히지 않는다. 전용 benchmark가 측정하고, 키 주입에서 `pty_write`까지의 입력 지연을 기록을 켠 경우와 끈 경우로 측정한다.
- **S2 라이브러리.** Rust, Go, JavaScript, C sink와 계약 시험, benchmark(켠 경우와 끈 경우의 enqueue, writer 처리량, 큐가 가득 찬 때의 손실 계수, 시작 버퍼, JavaScript 배치).
- **S3 core.** Go host, Rust host, native 라이브러리, page API를 새 writer로 옮긴다. `application_log.*`, `performance.*`, `sp_log_*`, `performance.js`, host 호출 `report`와 `log`, window check와 검사들의 옛 파서를 제거한다. 시작 버퍼, panic hook과 fatal 처리(Go는 신규), 표준 오류 분리. 두 host에서 모든 창 검사가 통과한다.
- **S4 sidecar와 plugin.** terminal sidecar(`performance.rs`, `service_log.rs` 제거), files와 shell(신규), 프로토콜 field `cid`와 연산 `log.policy`, `context.log`를 쓰는 plugin. `cid`가 한 입력의 모든 층을 지난다.
- **S5 catalog.** 감사가 찾은 기록 없는 원천을 class별로 모두 선언한다. 자동 입구와 native observer(애플리케이션 active·resign, key·main window, occlusion, workspace, 입력 소스 변경, pasteboard, first responder 변경 전후, `keyDown` 분기, 입력기 질의), host event(창, sidecar, endpoint, 설정, 프로젝트, plugin, 업데이트, 종료), terminal sidecar(task 종료, 거부, 빈 키 바이트, control·alt와 함께 잘리는 `Char`, replay 절단), page(입력을 버리는 분기)를 더한다. `make events-check`가 gate에 들어간다. F145.13에서 F145.18은 이 단계에 속한다.
- **S6 보기.** 같은 파서 위의 debug 화면: 필터(층, level, event, 표면, 세션, 글자, 시간 범위)가 있는 타임라인, 파일 변경 알림으로 따라가기, 한 `cid` 따라가기, 앞뒤 줄, `state-*.json`의 상태 보기와 비교, 파일 목록, 선택 저장. 명령 `sok debug timeline`이 같은 목록을 출력한다. 명령, 상태, DOM 이름은 exposure 규칙으로 선언한다.
- **S7 관측과 마감.** 두 host의 실행 중인 애플리케이션에서 입력한다: Enter, 영문, 조합한 한글(활성화 등급), 붙여넣기, control·alt 키, 한 번에 2000자. `cid` 하나가 native 콜백에서 PTY까지 모든 층을 잇고 기록된 바이트가 입력과 같다. 예산을 측정한다. 문서를 갱신한다. core 0.0.11을 릴리스하고 registry에 등록한다.

## 문서, 규칙, 메모리

- 명세: `logging.md`와 `events.md`, `events.json`(신규, 영어와 한국어). `diagnostics.md`, `performance-trace.md`의 기록 형식과 `hosts.md`, `native-host.md`, `sidecars.md`의 로그 부분을 대체한다. `debug.md`를 갱신한다. host 계약의 `log.*` 행은 새 계약 시험의 행으로 대체한다.
- AGENTS.md와 한국어 사본: 글 기록 규칙과 진단 빌드의 성능 trace 문구를 event와 정책 용어로 바꾸고, 새 event 원천은 catalog에 선언하고, 생산자는 막히지 않고, 손실은 세고, `console`은 입구로 캡처한다는 규칙을 더한다.
- F138의 글 기록 형식은 연결된 후속 항목이 대체한다. 완료한 항목은 다시 열지 않는다.

## 기각한 대안

- 지금 구조에 field와 기록을 더하기: 형식 둘, 기록기 다섯, 수백 곳의 호출 지점이 남아 누락과 비용이 반복된다.
- binary나 memory-mapped 형식(시스템 로그 방식): crash에는 더 강하지만 도구, 검사, 사람이 읽는 비용이 이 필요에 비해 크다. `error`를 즉시 flush하는 JSON lines로 충분하다.
- 모든 프로세스를 host 한 곳에 모으는 집계기: 지속 terminal service가 host보다 오래 살아서 host가 죽으면 증거가 사라진다. 프로세스마다 파일 하나를 쓰고 보기에서 병합한다.
- 글을 저장 형식으로 유지하기: 파서 둘과 규칙 둘이 남고 field가 구조화되지 않는다. 글은 보기에서 만든다.
- 공유 binary 라이브러리 하나: 저장소 경계와 Go, Rust, JavaScript, Objective-C의 도구 체인에 맞지 않는다. 계약, 언어별 얇은 라이브러리, 같은 계약 시험이 표준 설계다.

## 한계

- 서로 다른 프로세스의 monotonic 시계는 비교할 수 없다. 층 사이의 순서는 wall clock과 `cid`에서 얻는다. `cid` 없이 같은 마이크로초 안에 있는 다른 프로세스의 event 순서는 정할 수 없다.
- 신호 처리기는 async-signal-safe 함수만 호출할 수 있어서 미리 만든 짧은 JSON 줄을 쓴다. 마지막 배치 간격(최대 100 ms)의 `info` event는 잃을 수 있다. `error`는 즉시 flush되므로 잃지 않는다.
- page는 파일을 쓸 수 없어 배치 호출로 host를 거쳐 기록한다. page 프로세스가 끝날 때 아직 보내지 않은 배치는 잃는다(최대 한 frame).
- 입력기는 활성 애플리케이션의 key window에서만 답하므로, 조합한 한글 입력의 관측에는 활성화 등급 실행이 필요하다.

## 검증

- 모든 단계의 교차 검증. 세 출처가 일치해야 단계를 닫는다: 시험의 단언(변경 전 실패, 변경 후 통과), 단위 시험과 창 시험이 남긴 로그, 실행 중인 애플리케이션의 관측. 변경 전에는 실패한 시험과 로그에 event가 없음을 함께 기록한다. 변경 뒤에는 시험이 통과하고, 남은 로그에 기대한 event가 field와 함께 있으며, 예상하지 못한 `error`, `log.dropped`, `seq`의 틈이 없다. 로그 감사 gate는 시험이 남긴 모든 로그를 `soksak-log-check`로 검증한다(schema, 선언된 event만, 연속된 `seq`, 완결된 `cid` 사슬, 선언한 예상 오류 외의 `error` 없음). 실패한 실행의 로그는 분류하기 전까지 보관한다. 각 host의 실행 중인 애플리케이션에서 같은 시나리오를 실행해 시험의 로그와 event, field, 순서를 비교하며, 차이는 결함이다.
- gate: `make docs-check native-test boundaries exposure-check parity-check platforms hosts-check rust-format-check go-format-check rust-clippy-check host-contract-check events-check`, 이어서 `pnpm test`를 `&&`로 묶어 종료 줄로 판단하고, push마다 CI를 읽는다.
- 사람이 쓰는 애플리케이션과 그 데이터 폴더는 읽기만 한다. 검사 애플리케이션은 자기 설정 폴더와 프로세스를 쓴다.
