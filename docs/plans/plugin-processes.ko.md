# Plugin 프로세스 구조

[English](plugin-processes.md)

상태: F212.2의 검토 대기 제안서. 단일 작업 체크리스트는 [기능](../features.ko.md)(F212)이다. 이 제안서는 시작 전의 작업을 설명한다. 계약이 승인되면 명세로 옮기고, 명세가 내용을 담은 뒤 이 제안서를 제거한다.

## 결정

Plugin 코드는 workbench 페이지 밖에서 실행된다. 각 plugin view는 `sok://<plugin id>` origin의 별도 웹뷰이며 탭마다 하나다. 선언 UI는 plugin이 보내는 [declared UI snapshot](../spec/native-surfaces.ko.md)으로 workbench가 그린다. plugin host는 view나 sidecar가 맡을 수 없는 DOM 없는 로직이 있을 때만 존재한다.

측정은 이 결정을 뒤집지 않는다. 측정은 프로세스 수, plugin별 예산, 통과값을 정한다. 통과값을 만족하지 못하면 설계를 다시 연다. workbench 페이지에 plugin surface를 mount하는 방식으로 돌아가지 않는다.

## 근거

- 메모리: WebKit은 마지막 수집 이후 할당된 바이트에 비례해 전체 JavaScript 수집을 미룬다(`heap/GCActivityCallback.cpp`의 `didAllocate`; features F196.20-2). workbench 페이지의 plugin 코드는 workbench와 같은 힙에 할당하므로, plugin 하나의 할당은 workbench의 쓰레기 수집도 미룬다. 이 지연을 줄이는 공개 API는 없다(F196.20-2).
- 교체된 문서는 메모리 압박 전까지 `querySelectorAll` 결과 cache에 남는다(G1.4-64-1-4).
- 새로 시작한 release build의 메인 페이지 프로세스는 약 70 MB였다. 재로드 뒤 메인 페이지 프로세스는 446.6 MB(Wails)와 399.9 MB(Tauri)였다(G1.4-107).
- 숨은 browser tab 하나를 닫자 227 MB가 돌아왔다(F198.5).
- 문서마다 새 프로세스를 띄우자 이동 시간이 0.6초에서 1.1초로 늘었고, 그 정책은 되돌렸다(F196.27-1, F196.27-2).
- 장애 격리와 측정 단위: plugin의 장애, 메모리, 측정은 그 plugin의 프로세스에 속한다.

측정하지 않은 값은 F212.1에서 잰 뒤에 그 값에 기대는 단계를 진행한다.

## 층 규칙

- **선언 UI:** 화면 요소가 모두 선언 어휘(목록, tree, 메뉴, 명령, 상태줄)로 표현되는 화면이 선언 UI다.
- **view:** 그 밖의 화면은 view다. view는 자유 DOM, IME가 필요한 글 입력, canvas나 편집기, document region 또는 image region을 담은 화면을 맡는다.
- **sidebar section:** 선언 UI만 sidebar section이 될 수 있다. view가 필요한 section은 card 표면이 되고, sidebar에는 그것을 여는 선언 항목만 둔다.
- **plugin host:** view나 sidecar가 DOM 없는 로직을 맡을 수 없을 때만 만든다. 그 로직을 files sidecar나 files view로 옮기는 것을 먼저 검토하고, 옮길 수 없을 때만 host를 둔다.
- 화면의 층은 측정으로 정하지 않는다.

## 배치

| plugin | 표면 | section | state와 로직 | 확장점 | sidecar |
|---|---|---|---|---|---|
| editor | view (CodeMirror, IME) | – | – | 기여 plugin이 선언한 module을 core module root에서 import | files |
| flowmark | view (자유 DOM) | – | – | – | 기존 |
| shell | view. 층은 shell 이전 전에 항목 F212.10-shell-layer에서 정한다 | – | – | – | shell |
| files | – | 선언 tree | sidecar로 옮긴다. 불가하면 host | – | files |
| hwp | view와 document region | – | – | – | files |
| browser | view와 document region | 4개 section은 각각 선언 UI 또는 card 표면이 되며, browser 이전 전에 항목 F212.10-browser-sections에서 정한다 | – | – | – |
| terminal | view와 image region, 겹침 화면 | – | – | – | vt |

- 이름 붙은 항목 F212.10-shell-layer와 F212.10-browser-sections는 shell과 browser plugin 저장소의 체크리스트에 올린다. 각 항목은 그 plugin의 F212.10 이전 전에 끝낸다. 이 표의 어느 칸도 그런 항목 없이 비워 두지 않는다.
- modal page는 이 범위에서 뺀다. 이를 쓰는 plugin이 없기 때문이다.
- editor의 buffer와 분석을 sidecar로 옮길지는 통과값 (iv)로 정한다.

## 통과값

아래 값은 F212.1을 시작하기 전에 고정한다. 각 값은 행에 적힌 측정으로 판정한다.

| 기준 | 통과 조건 |
|---|---|
| (i) 합계 | 한 plugin의 view N개의 합계 footprint가 view 1개 footprint의 N배 + 10 MB 이하다. |
| (ii) 회수 | 다른 view와 프로세스를 함께 쓰지 않는 view에 적용한다. 함께 쓰는 view는 그 view들과 한 단위로 잰다. 세션 기록이 초기 문서 하나뿐인 상태로 열고 닫은 view를 닫으면, 그 footprint의 90% 이상이 10초 안에 돌아온다(3회 반복). 엔진 cache가 붙잡은 프로세스는 돌아오지 않은 것으로 센다. |
| (iii) 첫 표시 | 프로세스가 이미 실행 중인 view의 첫 표시: view 시작 요청부터 녹화에서 첫 내용 frame까지의 시간이, 같은 plugin의 DOM mount 기준값 + 300 ms 이하다. 여기서 DOM mount 기준값은 메인 페이지에서 같은 plugin의 표면 mount를 녹화한 것의 표면 시작 요청부터 첫 내용 frame까지의 중앙값이며, 같은 녹화 방법으로 잰다. |
| (iii-b) 새 프로세스의 첫 표시 | 새 프로세스의 첫 표시: (view 시작 요청부터 녹화에서 첫 내용 frame까지의 시간) − (F212.7a의 프로세스 시작 시간 5회 중앙값, 각각은 프로세스 요청(`host.trace.view.process-request`)부터 view가 page 런타임을 시작할 때 쓰는 첫 `host.trace.view.process-ready`까지의 시간이며, 두 event는 F212.3에서 선언한다(class call, level debug))이 DOM mount 기준값 + 300 ms 이하다(3회 반복). F212.7a는 이 측정을 성능 trace를 켠 상태로 실행한다. |
| (v) 표시 판정값 | card 배치가 바뀐 녹화에서, view의 내용 frame이 그 변경의 첫 frame부터 100 ms 안에 새 크기로 나타난다. F212.7 전에 고정한다. |
| (vi) 재시작 한도 | 실패 event가 올 때 실패 시각을 기록하고 그 자리에서 센다(timer를 쓰지 않는다). 최근 300초 안의 실패가 4번째에 이르면 재시작을 멈춘다. 300초보다 오래된 실패는 세지 않는다(sliding window). 멈춘 뒤에도 실패 기록은 남긴다. 그 프로세스가 필요한 표면을 사용자가 열 때만 기록을 비우고 프로세스를 다시 띄운다. |
| (iv) editor 측정 | editor view의 footprint와 숨긴 DOM editor의 footprint를 잰다. view 쪽 footprint가 50 MB를 넘으면, F212.9 뒤에 buffer와 분석을 sidecar로 옮기는 항목을 체크리스트에 추가한다. 이것은 통과 조건이 아니라 측정과 항목 추가 규칙이다. |
| (viii) 끌기 | gesture 동안 (a) 매 frame에서 native frame 경계와 card 경계의 차이가 2 pt 이하다(같은 commit, 기대값 0). (b) 내용 frame(view가 자기 document에 그린 frame이며, view의 ResizeObserver 다음 requestAnimationFrame이 내는 표시)의 연속 간격이 33 ms 이하다. (c) 내용 frame 크기가 native frame 크기와 다른 상태가 gesture 끝난 뒤 2 frame(33 ms) 안에 사라진다. 이 값은 녹화에서 판정하며 실행 중 timer로 판정하지 않는다. F212.7c 전에 고정한다. |

값을 만족하지 못하면 측정값을 체크리스트에 기록한다. 기구 값 (v), (vi), (viii)이 실패하면 기구 항목(F212.7b, F212.7c, F212.8a)과 그것에 기대는 항목(F212.8 이후)을 멈춘다. plugin 값 (i), (ii), (iii), (iii-b)가 실패하면 그 plugin의 이전 항목만 멈춘다. 그 plugin의 층이나 view 수는 이 문서의 새 개정판에서 다시 연다. 개정판은 adversarial review에 올린다. 개정 결정은 소유자가 한다.

## 규칙

1. workbench 페이지에서는 plugin 코드를 실행하지 않는다.
2. **Declared UI snapshot.** plugin view나 plugin host는 declared UI snapshot을 workbench로 보낸다(push). 메인 페이지가 load될 때(reload 포함) workbench는 그 페이지의 표면이 선언한 plugin view와 host의 각 status에 대해 snapshot을 한 번 요청한다(pull). 다른 pull은 없다. 메시지의 이름과 field는 [메시지와 event](#메시지와-event)에 적는다.
   - status 하나에는 전송 중인 snapshot이 최대 1개다.
   - 전송 중에 생긴 변경은 dirty로 표시한다. 확인(ack)이 오면 최신 값을 담아 다음 snapshot을 보낸다.
   - 건너뛴 값의 수는 core status `core.plugin.losses`의 `losses.skipped`로 센다. 성능 trace가 켜져 있으면 수가 바뀔 때마다 `host.trace.declared-ui.snapshot.skipped`도 쓴다.
   - plugin 프로세스가 (다시) 시작하면 그 프로세스의 첫 snapshot이 각 status의 전체 값이다. workbench는 이전 프로세스의 멈춘 snapshot과 확인 대기를 버린다. 다시 시작한 plugin은 저장한 state에서 값을 만들어 보낸다(규칙 5).
   - 확인을 기다리는 동안 view 프로세스가 끝나거나 표면이 닫히면 workbench는 `host.trace.status.stalled {plugin, status, reason}`을 쓴다. 다시 시작한 프로세스는 첫 snapshot으로 각 status의 최신 값을 보내고 dirty 표시를 지운다. 표면이 닫힌 것이면 dirty 값은 버리고 그 사실을 reason에 적는다. timer는 쓰지 않는다.
3. **경계를 넘는 호출.**
   - 명령은 [exposure](../spec/exposure.ko.md)에 적힌 대로 `timeout`을 선언한다(최대 600000 ms, 없으면 10초). timer는 살아 있는 상대가 명령에 답하지 않는 경우에만 남긴다. 느린 명령 답을 알려 주는 event가 없기 때문이다. `host.trace.view.unresponsive`는 WebKit의 응답성 검사에 답하지 않는 view 프로세스를 알리며, 명령 답이 아니므로 timer를 대신하지 않는다. 기한을 넘기면 호출을 -32000과 `command <name> did not reply within <ms>ms`로 거부한다. 이 오류는 [exposure](../spec/exposure.ko.md)의 명령 `timeout` 항목이 적는 것이며, 이 설계는 메시지를 바꾸지 않는다. `host.call.timeout {plugin, command}`를 쓰고 `losses.timeouts`를 센다.
   - 상대가 사라지면 기한 전에 event로 호출을 끝낸다. 호출을 끝내는 상대는 view나 host 프로세스의 종료, 표면 닫기, sidecar 종료다. promise는 그 이유를 밝힌 오류로 거부한다. reason은 `process-ended`, `surface-closed`, `sidecar-ended` 중 하나다. `process-ended`와 `sidecar-ended`는 `host.call.peer-lost {plugin, command, reason}`을 쓰고, `surface-closed`는 event를 쓰지 않으며 `losses.peerLost`를 센다. `host.trace.view.unresponsive`는 호출을 끝내지 않는다. 이 event는 규칙 6의 presentation wait와 view의 status에서만 쓴다. 호출은 선언한 timeout이나 이 상대들 가운데 하나로만 끝난다.
   - 끝난 호출에 늦게 온 답은 버린다. promise에 전달하지 않으며, 답을 보낸 문서에 오류를 보내지도 않는다. 호스트는 `host.trace.call.late-reply {plugin, command, delay}`를 쓰고 `losses.lateReplies`를 센다. host-contract case `exposure-reply.removed-surface-discarded`와 `exposure.relay.foreign-document-reply-ignored-timeout-1005`가 이 동작을 명시한다.
   - 열린 호출 수(확인을 기다리는 snapshot 포함)와 가장 오래된 열린 호출의 시작 시각을 core status `core.plugin.open-calls {plugin, count, oldestStartedAt}`로 노출한다. 이름과 위치는 여기서 정하며, F212.3이 status를 선언한다.
   - relay timeout은 exposure의 제품 동작이다. 두 경로가 있다. 호스트는 surface page로 보낸 명령에 timeout을 적용하고, 메인 페이지는 자기가 직접 실행하는 handler에 timeout을 적용한다([exposure](../spec/exposure.ko.md), 명령 `timeout`). exposure.md는 두 경로를 이미 적고 있다(명령 timeout 항목과 relay 절).
   - 취소는 호출 envelope의 일부다. binary payload는 별도 경로를 쓴다(미결 항목 2).
4. **Origin과 core root.**
   - 각 plugin HTML은 `sok://<plugin id>`의 별도 웹뷰에서 돈다. 요청의 plugin id는 요청이 아니라 view 구성에서 온다.
   - core root는 plugin id로 쓸 수 없는 예약 host `core`다. `validateManifest`가 그 이름을 거부한다. 예약 id 검사(F212.5-9)는 F212.5-6의 core root resolver가 완료되기 전에 끝낸다.
   - core root는 plugin A의 view에 다음 파일만 제공한다. 그 밖의 경로는 모두 not found로 답한다.
     - core 대상은 `index.js`, `view.js`, `soksak/dist/index.js`의 import closure가 닿는 `@soksak/plugin-api`와 `soksak`의 파일이며, 각각 `sok://core/modules/<package>/<file>`에서 제공한다. 이들은 plugin 내용이 없는 core 파일이므로 패키지가 이름을 붙인 파일에서 제공하며, closure 시험(F212.5-4)이 그 집합을 계산하고 view import가 허가되지 않으면 실패한다;
     - plugin B의 granted item 가운데 A의 확장점에 대한 항목의 module: `sok://core/modules/<B package>/<module path>`. `<module path>`는 그 항목의 `module`이다;
     - 다른 plugin의 granted item이 있는 A의 확장점, 또는 A가 granted item을 기여하는 확장점에서, `extends.<point>.modules`가 specifier에 대응한 파일: `sok://core/shared/<plugin id>.<point>/<specifier>.js`.
   - 기여 항목은 제공자가 설치되고 켜져 있으며 `range`가 확장점의 `version`을 담고 `schema`에 맞을 때 연결된 항목이다(workbench 상태). granted item은 제공자가 설치되고 켜져 있으며 `range`가 확장점의 `version`을 담을 때 성립하며, 범위 판정은 두 호스트가 이미 쓰는 설치 라이브러리의 range parser로 한다. core root는 이 granted item 규칙만으로 grant하며, 그곳에서는 `schema`를 확인하지 않는다. `schema`에 맞지 않는 항목은 workbench(`core.contributions`)가 `invalid`로 보고하며 가져오지 않는다. 그 항목의 선언된 module 파일도 grant되며, 이 over-grant는 기여자가 자기 manifest에 선언한 파일로 한정되고 설계가 이를 밝힌다. F212.5-3은 두 호스트에서 granted item 규칙을 구현한다. `dependencies` 항목은 어떤 파일도 허용하지 않는다.
   - view import map은 항목이 정확히 네 개다: `soksak`, `@soksak/plugin-api`, `@soksak/plugin-api/view`, 그리고 `sok://core/shared/`에 대응하는 `@soksak/shared/`. `@soksak/runtime`과 `@soksak/workbench/` 항목은 없다. staging 도구가 `@soksak/plugin-api`의 상수 하나에서 이를 쓰며, closure 시험이 view 페이지의 모든 import가 이 항목 가운데 하나로 해석되는지 확인한다.
   - view bridge `@soksak/plugin-api/view`는 파일 `packages/plugin-api/view.js`다. `runtime/`이나 `@soksak/workbench/` 아래의 것을 import하지 않으며, view 쪽 call layer(`calls.js`)와 선언 UI snapshot(`snapshots.js`)을 view 통로로 내보낸다.
   - view channel은 host가 각 view 구성에 주입하는 document-start script이며, 규칙 8의 테마 script와 같다. host 계약이 이름을 정한 message handler `sok-view`를 하나 정의하고, 두 호스트가 view의 web view 구성에 이를 등록한다. `@soksak/plugin-api/view`는 `createViewChannel()`을 내보내며, 이 함수는 그 handler 위의 `{send, onMessage}`를 돌려주고 이를 `createCalls`와 `createSnapshotSender`에 넘긴다. handler 이름과 주입 script는 host 계약에 선언하고 계약 case를 둔다. view 구성은 F212.7에서만 존재하므로, F212.5-4는 가짜 handler로 `createViewChannel()`을 시험하고 F212.7이 이를 host에 연결한다.
   - 기여 module과 공용 module은 각각 자체완결 ES module 하나다. 그 안의 상대 import는 그 plugin의 빌드 오류이며, 그 plugin 저장소가 검사한다([경계](#경계-결합-금지)).
   - core root는 애플리케이션 frontend로 넘기지 않는다. view는 `/runtime/` 경로를 받지 않으며, `/start.json`, `/environment.json`, `/index.html`, `/runtime/...`과 위에 없는 그 밖의 경로는 모두 not found다.
   - view에 보내는 모든 응답은 view 구성의 plugin id로 `Access-Control-Allow-Origin: sok://<plugin id>`를 담는다. 요청의 `Origin`이나 `*`는 담지 않는다. 거부한 요청은 이 header를 담지 않는다. 이 절의 header 규칙은 F212.5-2가 WebKit 결과를 기록하기 전까지 잠정이다. WebKit이 custom scheme module에 대해 `Access-Control-Allow-Origin: sok://<plugin id>`를 거부하면 F212.5-2가 실패한 단언을 기록하고, F212.5-7이 시작하기 전에 이 절을 새 검토 라운드에서 고친다.
   - granted item이나 공용 대상이 지정하지 않은 plugin B의 파일 요청은 not found로 답하고, 두 호스트 모두 `error: core root: <path> is not granted to <plugin>`을 쓴다. 문서 영역은 core root grant를 받지 않는다.
   - core root는 host 계약이 선언하고 각 호스트가 scheme handler에 등록하는 callback으로 제공하며, 계약 case를 둔다(F212.5-6).
   - Red 시험: plugin A의 view가 granted item이 지정하지 않은 plugin B의 파일, A가 `dependencies`로 지정한 plugin의 파일, 또는 `/start.json`, `/environment.json`, `/index.html`, `/runtime/...`을 요청하면 각각 not found를 받는다.
5. **재시작.** sidecar와 plugin host는 통과값 (vi)의 한도 안에서 다시 띄운다. 한도를 넘으면 호스트는 `error:`를 보고하고 멈춘다.
   - 한도를 넘은 뒤의 다음 요청은 프로세스를 띄우지 않고 `sidecar-failure`(reason `restart limit`)로 실패한다. 실패 기록은 남긴다. 그 프로세스가 필요한 표면을 사용자가 열 때만 기록을 비우고 프로세스를 띄우며, 호스트는 `host.trace.sidecar.restart-reset {sidecar, surface}`를 쓴다. plugin host는 `host.trace.plugin-host.restart-reset {plugin}`을 쓴다.
   - 이 규칙은 두 명세 위치를 바꾼다. [sidecars](../spec/sidecars.ko.md)의 `## Failure` 절은 67행에서 실패 뒤의 다음 요청이 한도 없이 새 프로세스를 띄운다고 적는다. F212.8a가 그 문장을 규칙 5의 한도로 바꾼다. [terminal runtime](../spec/terminal-runtime.ko.md)의 43행이 적는 재시작 규칙(연결 끊김마다 한 번 시도하고, 다음 전송이 같은 경로를 다시 시도)도 F212.8a에서 바꾼다.
   - 다시 띄우면 state는 마지막으로 저장한 값에서 복원한다. 저장하지 않은 state는 잃으며, plugin마다 어떤 state인지 밝힌다.
   - 고장 주입은 진단 build에서만 둔다.
6. **표시.** plugin view는 card 배치가 바뀐 뒤(gesture의 첫 변경)의 첫 표시에만 presentation wait에 참여한다.
   - 계속되는 gesture(구분선이나 card 끌기) 동안 view의 native frame은 매 frame card와 같은 commit에서 새 기하로 놓는다. 내용 그리기를 기다리는 것은 첫 변경에서만 한다. 그 뒤 내용은 늦게 그려질 수 있으며, 그 늦음은 frame 간격으로 잰다.
   - F212.7c에서 끌기 gesture 전체를 녹화해 frame 간격과 기하 오차를 재고, 통과값 (viii)로 판정한다.
   - 기다림은 다음 가운데 먼저 오는 것으로 끝난다: view의 presentation 완료, view 프로세스 종료, 변경이 끝났을 때 그 view가 보이지 않음(`hidden` 조상, 선택되지 않은 탭, 닫힌 표면. workbench가 표면마다 이미 알리는 상태를 읽는다), `host.trace.view.unresponsive`의 응답 없음 알림. presentation 완료가 아닌 것으로 끝나면 그 view 없이 commit을 진행하고 `page.trace.view.presentation-abandoned {surface, reason}`을 쓰고 `losses.abandoned`를 센다. timer는 쓰지 않는다.
   - 통과값 (v)는 실행 중 기한이 아니다. F212.7b와 각 plugin 항목이 재는 판정값이다.
   - F212.7b는 view가 있는 card의 전체 화면 전환과 탭 전환을 녹화해, 두 기다림이 모두 끝나는지 확인한다.
   - [native surfaces](../spec/native-surfaces.ko.md)의 해당 규칙을 고친다.
7. **입력.**
   - workbench 단축키는 아래 표에 주인과 함께 적는다.
   - 명령 단축키는 native 메뉴를 거쳐 core 명령에 간다.
   - view는 시작할 때 호스트에 단축키 표를 등록한다. 표에는 workbench 단축키와 각각의 주인이 들어 있다. 표가 등록되기 전에는 키가 기본 동작을 지키며, view는 `page.view.shortcut-table-missing {plugin}`을 쓴다.
   - view는 그 표를 보고 자기 안에서 동기로 판단한다.
     - 주인이 workbench인 키만 기본 동작을 막고, event 정보와 함께 넘긴다.
     - 주인이 view인 키는 view가 처리하고 넘기지 않는다.
     - 주인이 native 메뉴인 키는 메뉴가 먼저 받으므로 view의 기본 동작을 막지 않는다.
     - 표에 없는 키는 기본 동작을 그대로 지킨다.
   - 넘긴 명령이 실패하면 `page.input.shortcut.failed {plugin, key, command}`로 알리고, 기본 동작을 다시 실행하지 않는다.
   - F212.7 시작 전에 F212.6a에서 Escape의 왕복 시간을 메뉴 닫기와 비교해 재고 결과를 기록한다. Escape의 주인은 view이며, 측정은 주인을 정하지 않는다.
   - IME는 view의 first responder가 받는다. activation 검사(F212.13)로 확인한다.

   | 단축키 | 주인 | 이유 |
   |---|---|---|
   | Command `=`, `-`, `0` (View 메뉴의 글자 크기, [글자 크기](../spec/text-size.ko.md)) | native 메뉴 → core 명령 `core.text.larger`, `core.text.smaller`, `core.text.reset` | 메뉴 단축키는 어느 view가 포커스를 가져도 동작한다 |
   | Escape | view | view가 자기 글 입력에 Escape를 쓰기 때문이다. F212.6a의 측정은 메뉴 닫기와 비교한 왕복을 검증하고 결과를 기록하며, 주인을 정하지 않는다 |
   | 글 입력과 IME 키 | view | view의 first responder가 받는다 |

   workbench 단축키 전체 목록은 두 호스트의 메뉴 선언과 workbench의 키 처리기에서 얻는다. 이 표는 지금 명세가 선언한 단축키만 담는다. 나머지는 F212.7 시작 전에 F212.6a가 이 표에 더한다.

8. **테마와 접근성.**
   - 호스트는 view를 만들 때 현재 테마 token 묶음을 document-start user script로 view 설정에 넣는다. 그래서 페이지의 첫 script가 돌기 전에 token이 있다.
   - 그 뒤의 테마 변경은 post 경로로 보낸다.
   - F212.7d에서 첫 frame의 색을 card token 색과 비교한다. document-start user script는 미결 항목 9다.
   - 접근성: F212.12에서 view의 요소 tree가 플랫폼 접근성 interface로 닿는지 기록한다. 검사가 생기기 전에는 접근성에 대해 다른 주장을 하지 않는다.
9. **View의 영역.** view의 영역(document region 또는 image region)은 그 view의 표면 host에 붙는다. 영역을 두거나 바꾸는 각 호출은 호출 envelope의 view id로 확인한다. insets는 view frame 기준이다. 영역의 presentation은 규칙 6에 따라 같은 창 transaction에 넣는다. F212.7이 이 규칙의 계약 case를 정한다.
10. **View의 unload와 restore.** 탭을 unload하면 그 탭의 view와 그 프로세스를 닫는다. restore는 저장한 state에서 새 view를 만든다. 통과값 (ii)는 unload마다 적용한다.

## 메시지와 event

**메시지**

| 메시지 | 방향 | field | 비고 |
|---|---|---|---|
| `declared-ui.snapshot` | plugin → workbench (event) | `{plugin, status, seq, value}` | 규칙 2의 push |
| `declared-ui.snapshot.ack` | workbench → plugin (event) | `{plugin, status, seq}` | 수신을 확인하고 전송 슬롯을 비운다 |
| `declared-ui.snapshot.request` | workbench → plugin (call) | `{status}`, 응답은 `{seq, value}` | 메인 페이지 load 때의 유일한 pull |

RPC protocol 번호는 0.0 계열에서 1이다.

**Event.** 각 event 이름은 층(`host` 또는 `page`)으로 시작한다. class는 다루는 관심사(`call`, `lifecycle`, `input`)를 나타낸다. event는 F212.3에서 선언하며, `host.trace.sidecar.restart-reset`은 F212.8a가 선언한다.

| event | class | level | field |
|---|---|---|---|
| `host.trace.declared-ui.snapshot.skipped` | call | debug | `{plugin, status, count}`: 전송 중일 때 건너뛴 값. 카운터 `losses.skipped` |
| `host.trace.status.stalled` | call | debug | `{plugin, status, reason}`. 카운터 `losses.stalled` |
| `host.call.timeout` | call | error | `{plugin, command}`. 카운터 `losses.timeouts` |
| `host.call.peer-lost` | call | error | `{plugin, command, reason}`: `process-ended`와 `sidecar-ended`. `surface-closed`는 event를 쓰지 않고 `losses.peerLost`를 센다 |
| `host.trace.call.late-reply` | call | debug | `{plugin, command, delay}`. 카운터 `losses.lateReplies` |
| `host.trace.view.unresponsive` | call | debug | `{plugin, surface}`. 상태 `core.plugin.views.responsive` |
| `host.trace.view.responsive` | call | debug | `{plugin, surface}`. 상태 `core.plugin.views.responsive` |
| `host.trace.view.process-request` | call | debug | `{plugin, surface}` |
| `host.trace.view.process-ready` | call | debug | `{plugin, surface}` |
| `page.trace.view.presentation-abandoned` | call | debug | `{surface, reason}`. 카운터 `losses.abandoned` |
| `page.view.shortcut-table-missing` | input | error | `{plugin}` |
| `page.input.shortcut.failed` | input | error | `{plugin, key, command}` |
| `host.plugin-host.restart` | lifecycle | error | `{plugin, attempt}` |
| `host.plugin-host.restart-limit` | lifecycle | error | `{plugin}` |
| `host.trace.plugin-host.restart-reset` | call | debug | `{plugin}` |
| `host.trace.sidecar.restart-reset` | call | debug | `{sidecar, surface}`, F212.8a가 선언 |

F212.3은 status `core.plugin.open-calls`, `core.plugin.losses`, `core.plugin.views`를 선언한다. 이 설계의 event는 level `error` 또는 `debug`로만 선언한다. catalog 항목을 쓰기 전에 [events](../spec/events.json)의 class 예산을 확인한다(F212.3). plugin host와 sidecar의 재시작 상태는 `core.plugin.views` 또는 sidecar status에 보인다.

**릴리스의 event level.** 0.0.x 릴리스는 error event만 저장한다(AGENTS.md, Diagnostic code). 따라서 이 설계의 각 발생은 한 번 분류한다.
(a) 실패나 거부된 연산은 level `error`의 event다.
(b) 손실, 건너뜀, 일시 상태, 표시 품질 저하는 event가 아니다. 선언된 status `core.plugin.losses {plugin, skipped, stalled, abandoned, lateReplies, timeouts, peerLost}`에 센다. 이것은 선언된 status `core.plugin.views {plugin, surface, responsive}`의 상태이기도 하다. 각 수는 바뀔 때마다 status 구독자에게 알린다. 수는 plugin마다 세며 앱이 끝날 때까지 유지한다. 표면이 닫힐 때 0으로 되돌리지 않는다. dirty 값이 있는 채로 닫히는 표면은 그 값을 버리기 전에 `losses.stalled`를 늘려, 모든 build에서 그 손실을 센다.
성능 trace가 켜져 있으면(설정 창의 디버그 switch) 수가 바뀔 때마다 표에 적힌 trace event도 쓴다. 릴리스의 event log는 error event만 저장한다.

코드의 식별자는 여기에 적은 이름을 그대로 쓴다.

## 경계 (결합 금지)

- 이 설계에서 core가 하는 일은 기구뿐이다. view 구성 종류, 선언 UI schema와 그리기, RPC와 binary 통로, core root, 재시작 한도, 계약 case가 여기에 든다.
- view channel은 host가 각 view 구성에 주입하는 document-start script이며, 규칙 8의 테마 script와 같다. host 계약이 이름을 정한 message handler `sok-view`를 하나 정의하고, 두 호스트가 view의 web view 구성에 이를 등록한다. `@soksak/plugin-api/view`는 `createViewChannel()`을 내보내며, 이 함수는 그 handler 위의 `{send, onMessage}`를 돌려주고 이를 `createCalls`와 `createSnapshotSender`에 넘긴다. handler 이름과 주입 script는 host 계약에 선언하고 계약 case를 둔다. view 구성은 F212.7에서만 존재하므로, F212.5-4는 가짜 handler로 `createViewChannel()`을 시험하고 F212.7이 이를 host에 연결한다.
- 위 plugin 표는 각 plugin 저장소의 체크리스트에 올라갈 이전 항목의 입력이다. core 코드와 시험은 plugin과 sidecar의 이름, 경로, 구현을 모른다.
  - files state를 sidecar로 옮기는 일은 files plugin과 files sidecar 저장소의 항목이다.
  - editor buffer를 옮길지는 editor 저장소의 항목이다.
- core의 F212.9는 view나 sidecar가 맡을 수 없는 DOM 없는 로직을 가진 plugin을 위한 plugin host 기구다. 계약이 그것을 요구할 때만 만든다.
- 관계는 manifest의 `dependencies`, `extends`, `contributes`로만 맺는다. core root가 plugin B의 파일을 plugin A에게 주는 것은 granted item이나 공용 대상일 때뿐이며, 그 판단도 이 선언과 설치 기록으로 한다(규칙 4).
- 플러그인 저장소 요구: 기여 module이나 공용 module을 제공하는 plugin의 저장소는 자기 시험에서 그 module이 각각 자체완결 ES module 하나인지 확인한다. 그 안의 상대 import는 그 plugin의 빌드 오류다.
- 시험:
  - core 시험은 자기 경계를 fake plugin fixture로 검증한다.
  - 공통 계약 case(RPC, snapshot, 재시작, 단축키 표)는 소유 package인 core와 두 호스트가 구현하고 실행한다. core는 소비자에게 필요한 fixture를 공개한다. 각 plugin 저장소는 그 fixture로 자기 module만 시험하며, core의 case를 실행하거나 core의 경로를 읽지 않는다.
  - 실제 plugin을 띄우는 측정과 창 검사(F212.1, F212.7a, F212.12, F212.14)는 설치된 환경의 end-to-end 검사이고, package 시험이 아니다.

## 탭과 프로세스

- view는 탭마다 하나다. 프로세스 배정을 정하는 공개 API는 없다.
- 저장소에는 새 프로세스를 강제하는 비공개 정책(`_WKNavigationActionPolicyAllowInNewProcess`, [`webview_navigation.m`](../../native/darwin/src/webview_navigation.m), [비공개 native API](../operations/private-native-apis.ko.md))이 있다. 메인 웹뷰는 이 정책을 쓴다(`native/darwin/src/window_facts.m:43-44`). 같은 정책은 문서마다 새 프로세스를 띄우는 데도 쓰였다. 그 결과 이동 시간이 약 0.6초에서 1.1초로 늘었고 프로세스 안 cache를 잃어서 그 쓰임은 되돌렸다(F196.27-1, F196.27-2). view는 이 정책을 쓰지 않는다. F212.1 측정에서 이득이 없었기 때문이다.
- F212.1은 한 plugin의 view 둘을 (a) 기본 배정과 (b) 이 정책을 쓴 배정으로 재고, 프로세스 수, 프로세스 하나의 기본 비용, view 생성 시간을 적는다. 어느 쪽을 쓸지는 F212.2(이 문서)에서 정한다. 기본 배정을 쓰므로 그 정책을 위한 비공개 API는 추가하지 않는다.
- **측정** (F212.1, `make -C native/darwin benchmark-view-processes`, load average 17):

  | view 수 | 프로세스 | 합계 | 프로세스당 | load (기본 / 강제) | 닫은 뒤 종료 |
  |---|---|---|---|---|---|
  | 1 | 1 | 10.8 MB | 10.8 MB | 0.24 / 0.13초 | 1/1, 0.017초 |
  | 5 | 5 | 54 MB | 10.9 MB | 0.20 / 0.28초 | 5/5, 0.015초 |
  | 10 | 10 | 110 MB | 11.0 MB | 0.44 / 0.58초 | 10/10, 0.036초 |
  | 20 | 20 | 220 MB | 11.0 MB | 0.81 / 1.01초 | 20/20, 0.05초 |
  | 40 | 40 | 422 MB | 10.5 MB | 1.46 / 2.10초 | 40/40, 0.12초 |

- WebKit은 기본 배정에서도 같은 origin의 view마다 프로세스를 따로 준다. 이 설계는 그것을 묶지 않는다.
- 합계는 view 수에 선형이다(작은 페이지 기준 프로세스당 약 11 MB). 닫으면 모든 프로세스가 0.13초 안에 끝나고 다시 쓰이지 않는다.
- 5개 이상의 view에서는 강제 정책이 더 느리게 load된다. 1개 view에서는 강제 정책이 더 빨랐다(0.13초 대 0.24초). 프로세스 재사용은 측정하지 않았다. view에는 기본 배정을 쓴다.
- 측정 중 확인한 사실: run loop를 손으로 돌리는 코드는 한 바퀴마다 autorelease pool이 필요하고, weak 배열이 커질 때 읽은 항목을 autorelease한다. 이것을 지키지 않으면 닫은 view가 해제되지 않아 프로세스가 남는 것처럼 보인다.
- 통과값 (i)을 넘으면 그 plugin의 층이나 view 수를 이 문서의 새 개정판에서 다시 연다. 개정판은 adversarial review에 올린다. 개정 결정은 소유자가 한다.

## 기존 기반과 미결 항목

**있음**

- document region: 별도 WKWebView, insets 배치, 입력과 포커스, 테마, 메모리 절약과 복원, `sok://` 파일.
- JSON 통로 `post`와 `document-message`(`document_view.m:39,855`, `surface-modules.js:98-100`, `documents.go:41`, `documents.rs:42`).
- exposure 전달(`exposure.js:95,108`).
- 별도 문서 런타임 틀(`page.js`).

**미결 항목**

1. [native surfaces](../spec/native-surfaces.ko.md)의 113행("application bridge 없음")과 115행(`post` 통로)의 모순을 바로잡는다. region 문서는 bridge를 받지 않으며, 그 메시지는 origin을 확인하는 `window.postMessage`뿐이고 호스트가 보내고 받는다. 이 정정은 F212.4에서 한다.
2. 호출 envelope에 id, 확인, 취소를 넣는다. 호출은 `id`를 가지고, 응답은 같은 `id`로 결과나 오류를 담고, 취소는 `id`를 가진다. binary 경로는 F212.4에서 두 호스트에 native로 만든다. 결정(F212.4-2): plugin 문서는 `POST sok://<plugin>/.binary`로 byte를 올리고 `GET sok://<plugin>/.binary/<id>`로 내려받는다. id는 host가 만들고, byte는 문서 영역이 자기 binary store에 보관한다([네이티브 표면](../spec/native-surfaces.ko.md#문서-영역)). 소유자 검사는 영역의 `view.plugin`을 URL host와 비교하는 것이다. 한 번의 upload는 16 MiB 이하이며, 이는 두 호스트의 클립보드 상한이다(darwin 클립보드의 `MAX_BYTES`, wailsv3의 `clipboardMaxBytes`). 한 페이지는 64 MiB 이하를 가지며, 이는 가장 큰 upload 4개 분량이다. id는 download가 끝날 때, native take가 byte를 돌려줄 때, 또는 영역이 닫힐 때 해제한다. plugin release는 `.binary` 경로 부분을 거부한다. host가 파일 조회보다 먼저 그 경로에 응답하므로, 그 아래의 plugin 파일은 닿을 수 없기 때문이다. release 검사는 `@soksak/plugin-api`의 `validateReleaseFiles`이며, `sok plugin pack`은 F212.4-4에서 같은 거부를 적용한다.
3. plugin host 웹뷰를 만드는 플랫폼 연산을 둔다. 이 웹뷰는 `SurfaceHost`가 아니라 창에 붙인다. 숨었을 때의 throttle과 `requestAnimationFrame` 동작은 F212.1과 F212.9a에서 잰다.
4. Wails에는 앱이 만든 웹뷰로 가는 호출 통로가 없다(H3). Objective-C 쪽에서 통로를 만들고, 계약 case로 두 호스트가 같게 동작하는지 검증한다(F212.4).
5. core root를 F212.5-4와 F212.5-6에서 만들고, 그 scheme은 F212.5-7에서 제공한다. 복사본과 link는 쓰지 않는다.
6. view import map은 `@soksak/plugin-api`의 상수 하나이며, staging 도구가 쓰고 F212.5-4의 closure 시험이 확인한다(규칙 4). 문서 영역은 core root grant를 받지 않는다.
7. plugin host를 가리키는 exposure owner key는 `plugin:<plugin id>`로 한다. plugin의 identity인 plugin id를 쓰므로([신원](#신원)) 그렇게 정한다.
8. 새로 쓰는 private API는 그것을 추가하는 단계에서 호출 조건과 함께 [비공개 native API](../operations/private-native-apis.ko.md)에 올린다. 미결 항목 10의 응답 없음 selector는 F212.3에서 올린다. 이 문서는 그 밖의 새 private API를 정하지 않는다.
9. document-start user script를 view 설정에 넣는 native 연산을 두 호스트에 만들고 계약 case를 둔다(F212.7d).
10. 결정: 이벤트 원천은 private `WKNavigationDelegatePrivate` selector `_webViewWebProcessDidBecomeUnresponsive:`와 `_webViewWebProcessDidBecomeResponsive:`다. 공개 API는 없다(SDK의 `WKNavigationDelegate.h`에는 `webViewWebContentProcessDidTerminate:`만 있다). 아직 선언하지 않았다. F212.3이 이 selector를 `native/darwin/src/private/webkit.h`와 [비공개 native API](../operations/private-native-apis.ko.md)에 더하며, 호출 조건과 사용 중인 SDK의 WebKit 소스에서 읽은 소스 줄(ResponsivenessTimer, 기본값과 발동 조건)을 함께 적는다. 규칙 6은 그 기록이 생긴 뒤에만 이를 쓴다.

## 신원

- sok host의 식별자는 plugin id다.
- plugin id에서 plugin 이름으로 가는 대응은 설치 기록과 plugin 폴더에서 읽는다. [설치](../spec/installation.ko.md#설치된-plugin-제공)는 기록을 정한다. `plugins/installed.json`(format 3)은 각 plugin id를 기록된 `path`에 대응시키고, plugin의 이름은 그 폴더의 `package.json`의 `name`이다. 기록은 이름을 담지 않는다. `plugins/installed.json`의 쓰는 주체는 앱의 설치 과정이다. 읽는 주체는 호스트와 `sok`다. 호스트는 설치 기록을 요청마다 `/installed-plugins.json`으로 제공하고, `sok`는 기록된 경로에서 파일을 읽는다.
- `plugin.json`의 `id`는 기록의 plugin id와 같아야 한다. 다르면 명시적 오류로 거부한다.
- 고칠 곳: pagePackage의 `index.js:1127`, `page.js:78`, `page.js:169`를 이 대응을 쓰도록 바꾼다. id와 plugin 이름이 다른 plugin에 대한 Red 시험을 둔다.

## context 항목

| 항목 | 새 형식 |
|---|---|
| `root` | 제거. view는 자기 `document`를 쓴다 |
| `icon(name)`, `params`, `origin`, `project`, `declarations` | 시작할 때 받는 동기 값 |
| `tab.*`, `runtime.native`, `runtime.command`, `runtime.sidecar`, `runtime.clipboard`, `runtime.links`, `tab.state` | 비동기 호출 |
| `runtime.theme`, `runtime.settings`, `runtime.textSize`, `status.subscribe`, `events.on` | event |
| `contributions(point)` | core root에서 import하는 동기 module 목록 |
| `exposure`, binder | view 안에서 그대로. 등록은 통로로 보낸다 |

## 단계

각 단계는 기능 하나의 체크리스트 항목이다. 명세, Red, 구현, Green, 기록, 커밋 순서로 진행하며, main은 병합하는 매 단계 뒤에도 green이다. F212.7, F212.7b, F212.7d, F212.10-editor, F212.7a, F212.7c, F212.8, F212.8a, F212.9, F212.9a 항목은 branch `feat/view-kind-F212.7`에서 개발하며, 체크리스트 항목마다 commit 하나를 쓴다. branch를 main에 합칠 때까지 main은 `dom` 종류를 유지한다. branch는 한 번만 합치며, F212.9a 뒤 `dom`을 선언하는 모든 plugin의 migration이 각 저장소에 합쳐지고 branch build에서 검증된 뒤에 합친다. `engines.soksak` 범위를 가진 plugin release는 F212.15 core release 전에는 발행하지 않는다. 각 plugin release는 그 plugin 저장소의 체크리스트 항목이며, F212.15가 요구하는 core 버전을 발행할 때까지 미출시로 기록한다.

단계 순서: F212.7, F212.7b, F212.7d, F212.10-editor, F212.7a, F212.7c, F212.8, F212.8a, F212.9, F212.9a, F212.10(나머지 plugin), F212.11~F212.15. F212.7c는 F212.10-editor가 만든 editor view를 재므로 F212.10-editor와 F212.7a 뒤에 온다. F212.7a와 F212.7c는 둘 다 F212.10-editor에 기댄다.

1. **F212.1 측정.** 창마다 모든 WebContent의 합계, 웹뷰 기본 비용, plugin host의 비용과 throttle, DOM editor와 flowmark(메모리 절약 켬과 끔)와 같은 화면을 view로 띄운 경우, 한 plugin의 view 둘을 (a)와 (b)로 잰 값, 프로세스 공유 쌍(한 plugin의 view 둘, 두 plugin의 view, 한 plugin의 view와 document region), 창 두 개의 메인 페이지 공유, 설치 기록의 표면을 가진 모든 plugin의 DOM mount 시간(page trace, plugin 버전과 함께 기록. (iii) 기준값은 F212.1-3), 첫 표시 시간과 첫 status 시간, 새 WebContent 프로세스 시작 시간. trace가 켜졌을 때 페이지는 표면 mount마다 `page.trace.surface.mount {plugin, surface, ms}`를 쓰며, `make events-check`는 workbench의 `trace(` 호출을 catalog와 대조한다.
   - **F212.1-3:** 설치 기록의 모든 표면 plugin에 대해 녹화에서 얻은 DOM mount 기준값(녹화에서 첫 내용 frame)이며, (iii)의 기준값이다. F212.1-2의 `page.trace.surface.mount` 중앙값은 mount의 trace 값이며 (iii)의 기준값이 아니다.
2. **F212.2 설계 문서.** 이 문서와 한국어 번역. 검토 결과는 [검토된 반론 답변](#검토된-반론-답변)에 적는다.
3. **F212.3 호출 메시지 계층(plugin-api).** [메시지와 event](#메시지와-event)의 event를 event catalog에 선언하고(`host.trace.sidecar.restart-reset`은 F212.8a가 선언), status `core.plugin.open-calls`, `core.plugin.losses`, `core.plugin.views`를 선언하며, 응답 없음 selector를 `native/darwin/src/private/webkit.h`와 [비공개 native API](../operations/private-native-apis.ko.md)에 넣고, 호출 조건과 사용 중인 SDK의 WebKit 소스에서 읽은 소스 줄을 함께 적는다(미결 항목 10), `make events-check`를 돌린다.
4. **F212.4 binary 경로**(native 코드와 두 호스트).
5. **F212.5 core root와 view import map.** [설치](../spec/installation.ko.md)의 `/modules`와 `/shared`를 바꾸고 규칙 4의 core root 경로를 더한다. 항목은 F212.5-1(설계), F212.5-2(WebKit Origin 측정, CORS 규칙이 확정되기 전), F212.5-3(`packages/sok`의 granted item 규칙), F212.5-4(view bridge, view channel과 import map 상수), F212.5-5(page origin), F212.5-9(예약 id 검사), F212.5-6(resolver, F212.5-9의 예약 id 검사 뒤), F212.5-7(native scheme), F212.5-8(거부된 page 요청의 수준)이다.
6. **F212.6 신원과 exposure 등록.** plugin id 대응과 exposure 등록을 더한다.
   - **F212.6a:** 단축키 표. Escape의 왕복 시간을 메뉴 닫기와 비교해 재고 결과를 기록한다. Escape의 주인은 view이며 측정은 주인을 정하지 않는다. 그 뒤 두 호스트의 메뉴 선언과 workbench 키 처리기에서 얻은 나머지 workbench 단축키를 규칙 7의 표에 더한다. F212.7 전에 끝낸다.
7. **F212.7 view 구성 종류**(manifest, workbench, native 배치, `view` 구성 종류). F212.7은 `view` 종류를 더하고 `dom`을 branch `feat/view-kind-F212.7`의 한 commit에서 제거한다. plugin은 각자의 F212.10 항목에서 그 branch에 맞춰 옮기며, 그 migration은 release 없이 각 저장소에 합친다. branch의 main 병합은 F212.10 release 전에 하며, plugin release는 F212.15 뒤에 따른다. 병합 뒤에는 reader가 `dom`을 plugin 이름과 manifest field를 밝힌 명시적 오류로 거부한다. 되돌림은 이전 `engines` 범위의 plugin release로 하며, 두 번째 reader 형식으로 되돌리지 않는다. 규칙 9와 10은 여기서 구현하고, 규칙 4의 view channel은 여기서 두 호스트에 연결하며, F212.7이 그 계약 case를 정한다.
   - **F212.7b:** presentation wait 참여와 예산 (v).
   - **F212.7d:** 첫 frame 테마 user script(미결 항목 9).
   - **F212.10-editor:** editor plugin을 view로 옮긴다(그 저장소의 항목). F212.7a와 F212.7c 전에 한다.
   - **F212.7a:** F212.10-editor 뒤, editor view로 (i), (ii), (iii), (iii-b), (v)를 재고; (viii)은 F212.7a 뒤에 실행하는 F212.7c가 잰다. (iii-b)는 성능 trace를 켠 상태로 잰다.
   - **F212.7c:** 끌기 녹화와 기하 오차 (viii). 측정은 첫 view(F212.10-editor의 editor view)로 한다. 모든 plugin view는 각자의 F212.10 항목과 F212.14에서 잰다. F212.10-editor와 F212.7a 뒤에 온다.
8. **F212.8 선언 UI schema와 workbench 그리기**(sidebar section 포함).
   - **F212.8a:** 재시작 한도 (vi)를 [sidecars](../spec/sidecars.ko.md)의 `## Failure`와 [terminal runtime](../spec/terminal-runtime.ko.md)의 43행에 넣는다(번역 포함). sidecar 실패를 맡은 호스트 package(Go, Rust, 계약 case)에 Red 시험을 둔다. F212.9보다 먼저 한다. `host.trace.sidecar.restart-reset`을 선언한다.
9. **F212.9 plugin host 기구**(플랫폼 연산, owner key, 재시작). files 저장소가 state를 sidecar로 옮기는 항목을 먼저 마치고, 그래도 필요한 plugin이 있을 때만 만든다.
   - **F212.9a:** plugin host를 둔다면 그 footprint와 throttle을 F212.10보다 먼저 잰다.
10. **F212.10 plugin 이전**(각 plugin 저장소의 항목, `engines.soksak`). 이름 붙은 항목 F212.10-shell-layer와 F212.10-browser-sections는 shell과 browser 이전 전에 끝낸다. 각 plugin 항목은 release 전에 그 view의 (iii), (v), (viii)을 잰다.
11. **F212.11 남은 페이지 mount 코드 경로 제거**(페이지 mount, parking, 페이지의 section과 state mount).
12. **F212.12 기능별 창 검사**(표시, 입력과 포커스, 끌기, 재시작). 기능 하나당 항목 하나다.
13. **F212.13 IME activation 검사**(사용자 승인).
14. **F212.14** 마지막 배치에서 모든 plugin view로 (i), (ii), (iii), (iii-b), (v)를 다시 재고, 모든 plugin view로 (viii)을 잰다. (vi)은 F212.12의 재시작 창 검사가 만든다.
15. **F212.15 core release.** F212.10의 plugin release는 이 release 뒤에 발행하며, 각 release는 요구하는 core 버전의 `engines.soksak` 범위를 가진다.

## 검증

- 각 항목: 소유 module의 단위 Red/Green과, 변경이 닿는 구조 검사. 전체 suite는 항목 완료에 쓰지 않는다.
- 완료 판정: (i), (ii), (iii), (iii-b), (v), (vi), (viii)은 통과해야 한다. (iv)는 측정을 마쳐야 하며, 초과하면 그 후속 항목이 체크리스트에 있어야 한다.

## 되돌림

- core 단계는 그 단계를 요구하는 plugin release를 이전 `engines` 범위로 되돌려 release한 뒤에만 되돌린다. F212.10의 plugin release는 각각 이전 `engines` 범위로 되돌린다.
- 순서: F212.3부터 F212.6까지는 기구를 더하고 기존 plugin의 동작을 바꾸지 않으므로, 그 commit을 되돌려서 되돌린다. F212.7부터 F212.9까지와 F212.10-editor는 그것을 쓰는 plugin release를 되돌린 뒤에 되돌린다. F212.10은 각 plugin을 이전 `engines` 범위로 release하여 되돌린다. F212.11은 옛 경로를 제거하므로, F212.10을 되돌린 뒤에만 그 commit을 되돌린다.
- 각 단계의 되돌림 순서는 그 단계를 쓸 때 그 단계의 체크리스트 항목에 기록한다.

## 명세 변경

이 설계가 모순되게 만드는 명세 위치와, 그것을 바꾸는 단계.

| 위치 | 변경 | 단계 |
|---|---|---|
| [native surfaces](../spec/native-surfaces.ko.md) 14, 23, 57행 | app DOM presentation wait. document region은 기다림에서 빠진다(규칙 6) | F212.7b |
| native surfaces 110, 111행 | 호출한 view 아래의 region 배치와 view frame 기준 insets(규칙 9) | F212.7 |
| native surfaces 113행 | region 주소. core root 경로와, 문서 영역이 core root grant를 받지 않는 규칙을 포함한다(규칙 4) | F212.5 |
| native surfaces 114행 | 설치된 폴더에서 주는 plugin 주소. plugin id 대응에 따른다(신원) | F212.6 |
| native surfaces 115행 | `post` 통로와 bridge 설명(미결 항목 1) | F212.4 |
| [plugins](../spec/plugins.ko.md) 51행 | surface module이 app DOM에 mount된다. view 종류(규칙 1) | F212.7 |
| plugins 96행 | section이 자기 module을 sidebar 요소에 import한다(선언 UI section) | F212.8 |
| plugins 151행 | app DOM WebView 하나가 plugin이 mount한 DOM을 소유한다 | F212.11 |
| plugins 183~215행 | view가 있는 탭의 unload와 restore(규칙 10) | F212.7 |
| plugins 183~215행의 DOM 탭 문단 | DOM 탭 | F212.11 |
| [surface composition](../spec/surface-composition.md) 9행 | 단일 app DOM 설명 | F212.11 |
| surface composition 104행 | app DOM reload가 view를 바꾸지 않는다(규칙 1, 규칙 2) | F212.7 |
| [exposure](../spec/exposure.ko.md) 160행 | 공유 app DOM에 mount된 plugin module의 좌표 | F212.11 |
| [endpoint](../spec/endpoint.ko.md) 99행 | exposure 답의 `diagnostics.surface.hold`. 늦은 답은 버린다(규칙 3) | F212.6 |
| [installation](../spec/installation.ko.md) 129~130행 | `/modules`와 `/shared` 경로, core root 경로 `sok://core/modules/<package>/<path>`와 `sok://core/shared/<plugin id>.<point>/<specifier>.js`(규칙 4) | F212.5 |
| [terminal runtime](../spec/terminal-runtime.ko.md) 43행 | sidecar 연결의 재시작 규칙(규칙 5) | F212.8a |
| [sidecars](../spec/sidecars.ko.md) `## Failure` | 재시작 한도(규칙 5) | F212.8a |

## 위험

- 높은 위험: IME, 끌기와 배치, 프로세스 수와 첫 표시 시간, Wails 통로.

## 검토된 반론 답변

아래 반론은 첫 번째, 두 번째, 세 번째, 네 번째, 다섯 번째, 여섯 번째 검토와 core root 검토 1, 2의 답변이다. 각 항목은 반론, 판정, 해결을 적는다. 해결은 이 제안서의 규칙에 기록한다. 두 번째 검토의 항목은 검토의 id(C, H, M)를 쓴다. 세 번째 검토의 항목은 검토의 id(N, D)를 쓴다. 두 번째 검토의 잘못된 답변 세 개는 C1, C7, H3에 대한 답변이다.

**첫 번째 검토**

- 반론: 모든 view를 정책으로 새 프로세스에 띄워 문서마다 격리한다. 판정: 기각. 해결: 측정한 새 프로세스 정책은 이득이 없고 load가 더 느렸다(F196.27-1, F196.27-2). 기본 배정을 유지하고 그 정책은 쓰지 않는다.
- 반론: 죽는 프로세스가 끝없이 다시 떠서 페이지를 붙잡는다. 판정: 수용. 해결: 300초 sliding window에서 4번째 실패에 재시작을 멈추고, 표면을 열면 기록을 비운다(규칙 5, 통과값 (vi)).
- 반론: 현재 sidecar 실패 규칙은 한도 없이 다시 띄우므로 같은 위험이 있다. 판정: 수용. 해결: 한도를 모든 sidecar에 적용하고, 계약 변경은 F212.8a에서 host package의 Red 시험과 함께 한다.
- 반론: 호출마다 거는 timer는 응답을 polling하는 것이다. 판정: 일부 수용. 해결: 상대가 사라지면 event(`host.call.peer-lost`)로 호출을 끝내고, timer는 살아 있는데 답하지 않는 상대에만 남기며 그 이유를 규칙 3에 적는다.
- 반론: view의 presentation 기다림이 commit을 무한히 막을 수 있다. 판정: 수용. 해결: 규칙 6의 event 가운데 먼저 오는 것으로 끝나며 timer를 쓰지 않고, presentation 없이 끝나면 `page.trace.view.presentation-abandoned`를 쓴다(규칙 6). 두 번째 검토가 event 목록을 바로잡았다(C1).
- 반론: 끌기 중 모든 내용 frame을 기다리면 끌기가 밀린다. 판정: 수용. 해결: 첫 변경만 기다리고, native frame은 card와 같은 commit에서 움직이며, 이후 frame은 통과값 (viii)의 간격으로 판정한다(규칙 6).
- 반론: 모든 키를 처리하는 view가 native 메뉴 단축키를 막는다. 판정: 수용. 해결: 단축키마다 주인을 표에 적고, 메뉴 키는 기본 동작을 막지 않으며, view가 주인인 키는 view 안에서 처리한다(규칙 7).
- 반론: 공용 module을 plugin마다 복사하면 코드와 버전이 중복된다. 판정: 기각. 해결: core의 예약 root가 module을 제공하며, 복사와 link를 쓰지 않는다(규칙 4, 미결 항목 5).
- 반론: core root가 어떤 view에도 어떤 plugin 파일이든 준다. 판정: 수용. 해결: `extends`/`contributes`와 `dependencies`가 가리키는 파일만 준다. 그 밖의 경로는 not found이며 Red 시험을 둔다(규칙 4).
- 반론: 테마 token이 페이지 script가 돈 뒤에야 보여 첫 frame이 깜박인다. 판정: 수용. 해결: document-start user script가 token을 싣는다(규칙 8, 미결 항목 9). F212.7d에서 확인한다.
- 반론: view를 접근성이 있다고 주장하려면 요소 tree 검사가 필요하다. 판정: 일부 수용. 해결: F212.12의 검사가 플랫폼 interface를 기록하기 전까지 접근성 주장을 하지 않는다(규칙 8).
- 반론: files state에는 plugin host가 필요하다. 판정: 일부 수용. 해결: state를 files sidecar로 먼저 옮기고, 옮길 수 없을 때만 host를 만든다(층 규칙, F212.9).
- 반론: plugin id와 plugin 이름이 다를 수 있다. 판정: 수용. 해결: 대응은 설치 기록에서 읽고, 불일치한 `id`는 거부하며, Red 시험을 둔다(신원). 첫 번째 검토의 audit 주장은 틀렸으며 제거한다(H3, 아래).
- 반론: 선언 UI의 모든 변경을 보내면 workbench가 넘친다. 판정: 수용. 해결: status마다 전송 중인 snapshot은 하나이고, 변경은 dirty로 표시하며, 건너뛴 값은 event log에 센다(규칙 2).
- 반론: editor buffer는 지금 sidecar로 옮겨야 한다. 판정: 규칙으로는 기각, 측정으로는 수용. 해결: 통과값 (iv)가 footprint를 재고, 50 MB를 넘으면 후속 항목을 추가한다.

**두 번째 검토**

- C1: 응답 없음 감지. 판정: 수용. 해결: 미결 항목 10을 정했다. private selector `_webViewWebProcessDidBecomeUnresponsive:`와 `_webViewWebProcessDidBecomeResponsive:`를 event 원천으로 채택하고 그 목적으로 쓴다. `native/darwin/src/private/webkit.h`와 [비공개 native API](../operations/private-native-apis.ko.md)에 호출 조건과 함께 F212.3에서 올린다. 규칙 2, 3, 6은 `host.trace.view.unresponsive`와 `host.trace.view.responsive`를 확정된 끝으로 적는다. 첫 번째 검토의 presentation 답변은 결정되지 않은 네 번째 event를 포함했으므로, 이제 규칙 6의 event(응답 없음 알림 포함)로 끝난다.
- C2: event에 층 접두어, class, level이 없다. 판정: 수용. 해결: 모든 event에 층 접두어와 class, level, field 표를 둔다(메시지와 event). status `core.plugin.open-calls`는 F212.3에서 선언한다.
- C3: 늦은 답. 판정: 수용. 해결: 늦은 답은 버리며 문서에 오류를 보내지 않는다. host-contract case `exposure-reply.removed-surface-discarded`와 `exposure.relay.foreign-document-reply-ignored-timeout-1005`가 이를 명시하고, `host.trace.call.late-reply`를 쓴다(규칙 3).
- C4: 모순되는 명세 위치. 판정: 수용. 해결: 명세 변경 절이 각 위치와 단계를 적는다.
- C5: view의 영역. 판정: 수용. 해결: 규칙 9가 각 영역을 그 view의 표면 host에 붙이고, 각 호출을 호출 envelope의 view id로 확인하며, insets를 view frame 기준으로 하고, presentation을 규칙 6에 따라 같은 창 transaction에 넣는다. F212.7이 계약 case를 정한다.
- C6: 통과값의 정의. 판정: 수용. 해결: (iii), (iii-b), (v), (ii)의 정의를 검토의 정의로 바꾼다(통과값).
- C7: 실패한 plugin 값과 창마다 view 하나 대안. 판정: 일부 수용. 해결: 통과값이 실패하면 지정된 항목을 멈추고, 그 plugin의 층이나 view 수를 이 문서의 새 개정판에서 다시 연다. 개정판은 adversarial review에 올린다. 개정 결정은 소유자가 한다. 창마다 plugin당 view 하나라는 대안은 설계 본문과 이 답변에서 뺐다.
- C8: 실패 기록. 판정: 수용. 해결: 한도를 넘은 뒤에도 실패 기록을 남기고, 그 프로세스가 필요한 표면을 사용자가 열 때만 비운다(규칙 5, 통과값 (vi)).
- C9: 단계 순서. 판정: 수용. 해결: 단계는 F212.7, 7b, 7c, 7d, F212.10-editor, 7a, 8, 8a, 9, 9a, 10(나머지), 11~15 순서로 진행하며, F212.6a는 F212.7 전에 한다(단계).
- H1: 메인 웹뷰의 정책. 판정: 수용. 해결: 메인 웹뷰는 새 프로세스 정책을 쓴다(`native/darwin/src/window_facts.m:43-44`). view는 F212.1 측정에서 이득이 없었으므로 쓰지 않는다(탭과 프로세스).
- H2: 근거 1. 판정: 수용. 해결: 메모리 근거는 할당 바이트에 따른 수집 지연과 공유 힙을 적고, 이 지연을 줄이는 공개 API가 없다고 적는다.
- H3: 신원과 audit. 판정: 수용. 해결: 고칠 곳은 pagePackage의 `index.js:1127`, `page.js:78`, `page.js:169`이며, F212.6이 `validateManifest`에 예약 core 검사를 더한다. `e2e/audit.test.mjs:12`에 대한 주장은 틀렸으므로 제거한다. 첫 번째 검토의 audit 답변도 같은 방식으로 고친다.
- H4: shell 층, browser section, Escape 측정. 판정: 일부 수용. 해결: shell 층과 browser 네 section은 각 plugin 저장소의 이름 붙은 항목(F212.10-shell-layer, F212.10-browser-sections)에서 그 plugin의 F212.10 이전 전에 정한다. Escape와 나머지 단축키는 F212.6a가 F212.7 전에 표에 모은다. 항목 없이 남은 칸은 없다(배치, 단계).
- H5: view의 unload와 restore. 판정: 수용. 해결: 규칙 10은 unload에서 탭의 view와 프로세스를 닫고, restore에서 저장한 state로 새 view를 만들며, 통과값 (ii)를 unload마다 적용한다.
- H6: `dom` 옆의 `view` 구성 종류. 판정: 세 번째 검토(D1)에서 수용. 이전의 기각을 뒤집는다. 해결: F212.7이 `view` 종류를 더하고 `dom`을 같은 항목에서 제거한다. 검사 환경의 plugin은 각자의 F212.10 항목에서 F212.7 branch에 맞춰 옮기며, F212.7은 F212.9a 뒤 plugin migration이 각 저장소에 합쳐진 뒤, F212.10 release 전에 main에 합친다(단계, F212.7). F212.7부터 reader는 `dom`을 plugin 이름과 manifest field를 밝힌 명시적 오류로 거부한다. 되돌림은 이전 `engines` 범위의 plugin release로 하며, 두 번째 reader 형식으로 되돌리지 않는다(F212.7).
- H7: RPC protocol 번호. 판정: 수용. 해결: RPC protocol 번호는 0.0 계열에서 1이다(메시지).
- M1: core root 경로 형식. 판정: 수용. 해결: core root 경로 형식은 `sok://core/<plugin id>/<path>`이며, installation.md 129~130행을 명세 변경에 더한다(규칙 4, 명세 변경).
- M2: 용어. 판정: 수용. 해결: card surface, presentation wait, shortcut table, call envelope, core root, installation record, owner key, snapshot in transit, plugin name을 `packages/plugin-api/terms.json`에 더한다. 신원 절은 "package name" 대신 "plugin name"을 쓴다. 용어 "declared UI snapshot"은 이 제안서가 아니라 [native surfaces](../spec/native-surfaces.ko.md)를 가리킨다. 그 절은 명세로 옮길 때 쓴다.
- M3: 'files state가 유일한 host'라는 주장. 판정: 수용. 해결: "지금 그런 module은 files state 하나뿐이다"라는 문장을 뺐다(층 규칙).
- M4: 강제 정책 측정. 판정: 수용. 해결: 측정 문장을 바꾼다. 5개 이상의 view에서는 강제 정책이 더 느리게 load되고, 1개 view에서는 더 빨랐다(0.13초 대 0.24초). 프로세스 재사용은 측정하지 않았다(탭과 프로세스).
- M5: 근거 3과 숨은 영역. 판정: 수용. 해결: 근거 3은 release 메인 페이지 프로세스 크기와 재로드 크기를 적는다(G1.4-107). 근거 4는 F198.5의 표현인 "숨은 browser tab"을 쓴다.
- M6: blank 번호. 판정: 수용. 해결: 모든 "blank N"을 "open item N"으로 바꾼다.
- M7: 등록 전의 단축키 기본 동작. 판정: 수용. 해결: 규칙 7은 표가 등록되기 전까지 키의 기본 동작을 지키고, view는 `page.view.shortcut-table-missing`을 error level로 쓴다.

**세 번째 검토**

- N1: 단계 순서. 판정: 수용. 해결: 단계 절은 순서 F212.7, F212.7b, F212.7d, F212.10-editor, F212.7a, F212.7c, F212.8, F212.8a, F212.9, F212.9a, F212.10(나머지), F212.11~F212.15를 정한다. F212.7c는 F212.10-editor가 만든 editor view를 재므로 F212.10-editor와 F212.7a 뒤에 온다. F212.7a와 F212.7c는 둘 다 F212.10-editor에 기대며, F212.7a는 (i), (ii), (iii), (iii-b), (v)를 재고, (viii)은 F212.7c가 잰다.
- N2: peer-lost reason. 판정: 수용. 해결: `host.trace.view.unresponsive`는 호출을 끝내지 않는다. 호출을 끝내는 상대는 view나 host 프로세스의 종료, 표면 닫기, sidecar 종료이며, reason은 `process-ended`, `surface-closed`, `sidecar-ended`다(규칙 3). `host.trace.view.unresponsive`는 규칙 6의 presentation wait와 view의 status에서만 쓴다. reason `unresponsive`는 모든 곳에서 뺐다.
- N3: 미결 항목 10. 판정: 수용. 해결: 미결 항목 10을 결정으로 다시 적는다. 공개 API에는 종료만 있으므로 private `WKNavigationDelegatePrivate` selector가 event 원천이다. F212.3이 호출 조건과 WebKit 소스 줄 기록을 더한 뒤에야 규칙 6이 이를 쓴다.
- N4: (iii) 기준값. 판정: 수용. 해결: (iii)의 DOM mount 기준값은 메인 페이지에서 같은 plugin의 표면 mount를 녹화한 것의 표면 시작 요청부터 첫 내용 frame까지의 중앙값이며, 같은 녹화 방법으로 잰다. F212.1-3이 잰다. F212.1-2의 `page.trace.surface.mount` 중앙값은 mount의 trace 값이고 (iii)의 기준값이 아니다.
- N5: (iii-b)의 프로세스 시작 시간. 판정: 수용. 해결: 각 시간은 `host.trace.view.process-request`부터 첫 `host.trace.view.process-ready`까지다. 두 event는 F212.3에서 선언한다(class call, level debug). 시간은 성능 trace를 켠 F212.7a에서 잰다. 별도 F212.1-4 항목은 만들지 않는다.
- N6: sidecar 재시작 문장. 판정: 수용. 해결: sidecars.md 67행의 `## Failure` 문장, 즉 한도 없는 재시작은 F212.8a가 규칙 5의 한도로 바꾼다. terminal runtime의 43행 문장도 F212.8a에서 바뀐다(규칙 5).
- N7: event level. 판정: 수용. 해결: 답변은 네 번째 검토의 규칙으로 대체한다(아래 네 번째 검토).
- D1: `dom`을 같은 항목에서 `view`로 바꾼다. 판정: 세 번째 검토에서 수용하며 H6을 뒤집는다. 해결: H6과 단계 절에 적은 대로 F212.7이 `view` 종류를 더하고 `dom`을 같은 항목에서 제거한다. F212.11은 남은 페이지 mount 코드 경로만 제거한다.
- D2: Escape의 주인. 판정: 일부 수용. 해결: Escape의 주인은 view다. view가 자기 글 입력에 Escape를 쓰기 때문이다. F212.6a는 왕복을 메뉴 닫기와 비교해 검증하고 결과를 기록하며, 주인은 정하지 않는다. shell 층과 browser section은 각 plugin 저장소의 항목(F212.10-shell-layer, F212.10-browser-sections)에 남는다. core는 plugin 내부의 배치를 정하지 않는다. plugin 기능은 그 plugin에 속하고 각 저장소는 자기 체크리스트를 가지기 때문이다.

**네 번째 검토**

- 반론: N7 답변은 손실이나 실패를 기록하는 event를 모두 warn 이상으로 두었지만, 0.0.x 릴리스는 error event만 저장한다. 판정: 수용. 해결: 각 발생을 한 번 분류한다. 실패나 거부된 연산은 `error` event다. 손실, 건너뜀, 일시 상태, 표시 품질 저하는 status `core.plugin.losses` 또는 상태 `core.plugin.views`에 세고, 진단 build에서는 수와 함께 `debug` event를 쓴다([메시지와 event](#메시지와-event), 릴리스의 event level). `lateReplies`는 `core.plugin.open-calls`에서 제거하며, 그 수는 `core.plugin.losses`에만 보고한다.


**다섯 번째 검토**

- F1: N1 답변이 F212.7a를 (viii)의 측정자로 적었지만, F212.7a는 F212.7c보다 먼저 실행한다. 판정: 수용. 해결: F212.7a는 (i), (ii), (iii), (iii-b), (v)를 재고, (viii)은 F212.7c가 잰다(단계의 F212.7a, N1).
- F2: F212.7에서 main의 `dom`을 제거하면 `dom`을 선언한 plugin의 이전보다 앞서게 된다. 판정: 수용. 해결: F212.7은 branch `feat/view-kind-F212.7`에서 개발하며, `dom`을 선언하는 모든 plugin의 F212.10 migration release가 migration이 F212.9a 뒤 각 저장소에 합쳐진 뒤, F212.10 release 전에 main에 합친다(단계, F212.7).
- F3: 표면이 닫힐 때 수가 0으로 되돌아가, 닫힐 때 잃은 dirty 값이 세어지지 않았다. 판정: 수용. 해결: 수는 plugin마다 세고 앱이 끝날 때까지 유지하며, dirty 값을 가진 채 닫히는 표면은 `losses.stalled`를 늘린다(릴리스의 event level).
- F4: 디버그 event를 진단 build로 거르는 것은 릴리스 규칙과 맞지 않는다. 판정: 수용. 해결: 성능 trace가 수가 바뀔 때의 기록을 거르며, trace event는 `host.trace.<event>`와 `page.trace.<event>`로 바꾼다(규칙 2, 규칙 3, (iii-b), 메시지와 event).
- F5: 호출 timeout의 오류 문장이 적히지 않았다. 판정: 수용. 해결: 호출은 -32000과 `command <name> did not reply within <ms>ms`로 거부하며, 이것은 exposure.md가 적는 오류다. 이 설계는 메시지를 바꾸지 않는다(규칙 3).
- F6: 검토자가 한국어 파일의 영어 문자열을 셌다. 판정: 기각. 해결: 한국어 파일은 같은 절, 표 행, 단계, 반론 항목을 가지며 네 번째 검토의 변경도 한국어로 담는다. 절별 비교는 네 가지 차이를 찾았고 모두 고쳤다: 규칙 4의 영어 문장에 빠진 `contributes` field 이름, 한국어 미결 항목 3에 빠진 `requestAnimationFrame` code span, 탭과 프로세스 절의 한국어 문장에 빠진 F212.2 참조, 그리고 M6 답변에 있던 영어에 없는 한국어 번역 주석(삭제).

**여섯 번째 검토**

- K1: F212.7 병합과 plugin release 순서. 판정: 수용. 해결: branch는 F212.9a 뒤 plugin migration이 각 저장소에 합쳐진 뒤, F212.10 release 전에 한 번 main에 합친다. plugin release는 F212.15 core release 뒤에 발행한다. F212.10 release는 각각 이전 `engines` 범위로 되돌린다(단계, F212.7, F212.10, F212.15, 되돌림).
- F6: 식별자와 절 개수를 확인한 뒤 반론이 철회되었다. 판정: 철회. 해결: 다섯 번째 검토의 F6 답변은 그대로 둔다.

**core root 검토 1**

- C1: view에게 주는 경로. 판정: 수용. 해결: 주는 것은 plugin B의 연결된 기여 항목이 A의 확장점에 대해 가진 module(`/modules/<B package>/` 아래)과, A가 기여하는 확장점의 `extends.<point>.modules` 대상(`/shared/` 아래)뿐이다. B의 그 밖의 경로는 모두 not found다(규칙 4). 기여 module과 공용 module은 각각 자체완결 ES module 하나이며, 상대 import 검사는 plugin 저장소의 요구다(규칙 4, 경계). 이 답변은 M1의 경로 형식과 첫 번째 검토의 core root 파일 답변을 대체한다.
- C2: view에는 `/runtime/`이 없다. 판정: 수용. 해결: view bridge는 `@soksak/plugin-api/view`이며 파일은 `packages/plugin-api/view.js`, 제공 경로는 `sok://core/modules/@soksak/plugin-api/view.js`다. `runtime/`이나 `@soksak/workbench/` 아래를 import하지 않고, `calls.js`와 `snapshots.js`의 view 쪽을 view 통로로 내보낸다(규칙 4, F212.5-4).
- C3: view import map. 판정: 수용. 해결: view import map은 항목이 정확히 네 개다: `soksak`, `@soksak/plugin-api`, `@soksak/plugin-api/view`, 그리고 `sok://core/shared/`에 대응하는 `@soksak/shared/`. `@soksak/runtime`과 `@soksak/workbench/` 항목은 없다. staging 도구가 상수 하나에서 쓰며, closure 시험이 이를 확인한다(규칙 4, F212.5-4).
- C4: CORS header. 판정: 수용. 해결: view에 보내는 응답은 view 구성의 `Access-Control-Allow-Origin: sok://<plugin id>`를 담고, 요청의 `Origin`이나 `*`는 담지 않는다. 거부한 요청은 이 header가 없다. 이 header에 대한 WebKit 동작은 규칙을 확정하기 전에 native 시험으로 기록한다(규칙 4, F212.5-2).
- C5: 애플리케이션 frontend로 넘기지 않는다. 판정: 수용. 해결: core root는 애플리케이션 frontend로 넘기지 않는다. `/start.json`, `/environment.json`, `/index.html`, `/runtime/...`과 규칙 4에 없는 그 밖의 경로는 not found다(규칙 4).
- C6: dependencies grant. 판정: 수용. 해결: `dependencies` grant를 제거한다. `dependencies` 항목은 어떤 파일도 허용하지 않으며, 첫 번째 검토의 core root 파일 답변을 대체한다(규칙 4).
- C7: 연결 규칙. 판정: 수용. 해결: 연결 규칙(제공자가 설치되고 켜져 있음, 항목의 `range`가 확장점의 `version`을 담음, 항목이 확장점의 `schema`에 맞음)은 두 언어의 `packages/sok` 설치 라이브러리에 두며, 공용 host 계약 case를 함께 둔다(규칙 4, F212.5-3).
- N1: 문서 영역. 판정: 수용. 해결: 문서 영역은 core root grant를 받지 않는다(규칙 4, 미결 항목 6).
- N2: callback. 판정: 수용. 해결: core root는 host 계약이 선언하고 각 호스트가 등록하는 callback으로 제공하며, 계약 case를 둔다(규칙 4, F212.5-6).
- N3: 거부 오류. 판정: 수용. 해결: 거부된 grant는 두 호스트 모두 `error: core root: <path> is not granted to <plugin>`을 쓴다(규칙 4, F212.5-6).
- 순서: F212.6의 예약 id 검사는 F212.5-6의 resolver보다 먼저 들어가므로, resolver가 `core` 아래의 plugin을 제공하지 않는다(단계, F212.5). F212.5의 첫 native 단계는 F212.5-2의 WebKit Origin 측정이다.

**core root 검토 2**

- R1: view import map의 core 대상. 판정: 수용. 해결: core 대상은 `index.js`, `view.js`, `soksak/dist/index.js`의 import closure가 닿는 `@soksak/plugin-api`와 `soksak`의 파일이며, 각각 `sok://core/modules/<package>/<file>`에서 제공한다. closure 시험(F212.5-4)이 집합을 계산하고 view import가 허가되지 않으면 실패한다(규칙 4).
- R2: 공용 대상. 판정: 수용. 해결: `extends.<point>.modules`는 다른 plugin의 granted item이 있는 A의 확장점, 그리고 A가 granted item을 기여하는 확장점에 대해 제공한다(규칙 4).
- R3: 예약 id. 판정: 수용. 해결: 예약 id 검사는 F212.5-9 항목이며 F212.5-6 전에 끝낸다. F212.6에는 그 검사가 없다(규칙 4, 단계).
- R4: 연결된 항목과 granted item. 판정: 수용. 해결: 연결된 항목은 workbench 상태로 남고 `schema`를 확인한다. core root grant는 별도 용어 granted item을 쓴다. granted item은 제공자가 설치되고 켜져 있으며 `range`가 확장점의 `version`을 담는 항목이다. grant는 `schema`를 확인하지 않으므로, `schema`에 맞지 않는 항목의 선언된 module 파일도 grant된다. 이 over-grant는 기여자가 자기 manifest에 선언한 파일로 한정되며, 설계가 이를 밝힌다. F212.5-3은 두 호스트에서 granted item 규칙을 구현한다(규칙 4).
- R5: view channel. 판정: 수용. 해결: view channel은 host가 주입하는 document-start script이며, host 계약이 정한 handler `sok-view`를 가진다. `createViewChannel()`은 F212.5-4에서 가짜 handler로 시험하고, F212.7에서 host에 연결한다(규칙 4, 경계).
- N1: header 규칙. 판정: 수용. 해결: 규칙 4의 header 규칙은 F212.5-2가 WebKit 결과를 기록하기 전까지 잠정이다. WebKit이 header를 거부하면 F212.5-7 전에 이 절을 새 검토 라운드에서 고친다(규칙 4).
