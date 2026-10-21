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

- **선언 UI:** 요소가 모두 목록, tree, 버튼, 상태줄 가운데 하나인 사이드바 section이 선언 UI다.
- **view:** 그 밖의 화면은 view다. 인라인 이름 바꾸기가 필요한 tree, 끌어 놓기가 있는 tree, 포인터 위치에 놓는 문맥 메뉴가 있는 tree는 view다. view는 자유 DOM, IME가 필요한 글 입력, canvas나 편집기, document region 또는 image region을 담은 화면을 맡는다.
- **sidebar section:** 선언 UI만 sidebar section이 될 수 있다. 열린 view가 없는 동안에도 sidebar section이 값을 보여야 하는 plugin은 plugin host가 필요하므로 F212.9를 요구한다. view가 필요한 section은 card 표면이 되고, sidebar에는 그것을 여는 선언 항목만 둔다. `core.declared-ui.tree.expand` 명령은 tree 요소를 만들 때 그 처리기와 함께 `packages/workbench/exposure.json`에 선언한다(F212.8-2).
- **모듈 section(지금):** 모듈 section은 sidebar section의 지금의 형태다. workbench는 모듈을 section 요소에 올리며, 문맥으로 `card`, `surface`, `orientation`, core `icon` 함수, plugin의 status를 위한 `status(name, fn)`, 명령을 위한 `bind(el, name, params, options)`를 준다. 모듈은 자기 DOM을 그리므로 workbench는 그 요소와 이름을 검사하지 못한다. 규칙 1이 workbench 페이지에서 plugin 코드를 실행하지 않는다고 하므로, 이 형태는 페이지 마운트(F212.11)가 제거될 때까지만 지금의 형태다.
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
2. **Declared UI snapshot.** plugin view나 plugin host는 declared UI snapshot을 workbench로 보낸다(push). 메인 페이지가 load될 때(reload 포함) workbench는 각 선언된 status의 현재 값을 그 status의 출처로 고른 곳에서 한 번 요청한다(pull). 상태의 출처가 바뀌거나 section의 방향이 바뀌면 workbench는 그 status의 현재 값을 한 번 pull한다. 실행 중인 view는 마지막 값을 새 독자에게 보낼 다른 수단이 없고, 이전 방향에서 버린 값은 새 방향에서 유효할 수 있으며 그 값을 가진 것은 출처뿐이기 때문이다. 다른 pull은 없다. 메시지의 이름과 field는 [메시지와 event](#메시지와-event)에 적는다.
   - status 하나에는 전송 중인 snapshot이 최대 1개다.
   - 전송 중에 생긴 변경은 dirty로 표시한다. 확인(ack)이 오면 최신 값을 담아 다음 snapshot을 보낸다.
   - 건너뛴 값의 수는 core status `core.plugin.losses`의 `losses.skipped`로 센다. 이 수는 각 snapshot message의 필드 `skipped`로 메인 페이지에 닿는다. 전송 중에 덮어쓴 값의 수이며, status의 이전 snapshot이 보내진 뒤의 수다. 성능 trace가 켜져 있으면 메인 페이지는 덮어쓴 값마다 `page.trace.declared-ui.snapshot.skipped {plugin, status, count}`를 쓴다. host는 snapshot을 중계하지 않으며 이 경우 event를 쓰지 않는다. `host.*` event는 host 코드만 쓰기 때문이다.
   - plugin 프로세스가 (다시) 시작하면 그 프로세스의 첫 snapshot이 각 status의 전체 값이다. workbench는 이전 프로세스의 멈춘 snapshot과 확인 대기를 버린다. 다시 시작한 plugin은 저장한 state에서 값을 만들어 보낸다(규칙 5).
   - 확인을 기다리는 동안 view 프로세스가 끝나거나 표면이 닫히면, 값은 `losses.stalled`로 세고 event는 쓰지 않는다. receiver는 각 snapshot을 즉시 확인하므로 확인을 기다리는 것은 view 안의 sender뿐이다. 기다리는 sender는 view 프로세스와 함께 끝나고, 표면이 닫히는 것도 view를 끝낸다. 따라서 이를 관찰하는 live 관찰자가 없으며, 규칙 2가 다시 시작한 프로세스에 대해 말하는 대로 다음 프로세스는 전체 값을 보낸다. 다시 시작한 프로세스는 첫 snapshot으로 각 status의 최신 값을 보내고 dirty 표시를 지운다. 표면이 닫힌 것이면 dirty 값은 버리고 그 사실을 reason에 적는다. timer는 쓰지 않는다.
3. **경계를 넘는 호출.**
   - 명령은 [exposure](../spec/exposure.ko.md)에 적힌 대로 `timeout`을 선언한다(최대 600000 ms, 없으면 10초). timer는 살아 있는 상대가 명령에 답하지 않는 경우에만 남긴다. 느린 명령 답을 알려 주는 event가 없기 때문이다. `host.trace.view.unresponsive`는 WebKit의 응답성 검사에 답하지 않는 view 프로세스를 알리며, 명령 답이 아니므로 timer를 대신하지 않는다. 기한을 넘기면 호출을 -32000과 `command <name> did not reply within <ms>ms`로 거부한다. 이 오류는 [exposure](../spec/exposure.ko.md)의 명령 `timeout` 항목이 적는 것이며, 이 설계는 메시지를 바꾸지 않는다. `host.call.timeout {plugin, command}`를 쓰고 `losses.timeouts`를 센다.
   - view는 메인 page의 요청에 자기 command로 답할 때 `{sok: 1, reply: id, result}` 또는 `{sok: 1, reply: id, error}`를 보내며, 호스트는 이를 `view-reply`로 전달한다([native surface](../spec/native-surfaces.ko.md#view-표면), view command). 메인 page는 그 요청에 command가 선언한 제한 시간을 적용하며, 제한 시간 뒤의 응답은 늦은 응답으로 버린다.
   - 상대가 사라지면 기한 전에 event로 호출을 끝낸다. 호출을 끝내는 상대는 view나 host 프로세스의 종료, 표면 닫기, sidecar 종료다. promise는 그 이유를 밝힌 오류로 거부한다. reason은 `process-ended`, `surface-closed`, `sidecar-ended` 중 하나다. `process-ended`는 view가 열어 둔 call(메인 page가 답하지 않은 call)을 끝내며 `host.call.peer-lost {plugin, command, reason}`을 쓰고, `surface-closed`는 event를 쓰지 않으며 `losses.peerLost`를 센다. sidecar 종료는 sidecar 실패 계약이 알린다. 응답을 기다리는 식별자 있는 요청마다 surface, sidecar, 식별자를 밝힌 `host.sidecar.reply` 오류가 쓰이고, sidecar에 보낸 각 surface는 `sidecar-failure`를 받는다. host가 멈추거나 떼어내면 기다리는 요청마다 같은 오류를 쓴다. sidecar 요청은 command를 갖지 않으므로 그 경우에 `host.call.peer-lost`는 쓰지 않는다. `host.trace.view.unresponsive`는 호출을 끝내지 않는다. 이 event는 규칙 6의 presentation wait와 view의 status에서만 쓴다. 호출은 선언한 timeout이나 이 상대들 가운데 하나로만 끝난다.
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
   - 기여 항목은 제공자가 설치되고 켜져 있으며 `range`가 확장점의 `version`을 담고 `schema`에 맞을 때 연결된 항목이다(workbench 상태). granted item은 제공자가 설치되고 켜져 있으며 `range`가 확장점의 `version`을 담을 때 성립하며, 범위 판정은 두 호스트가 이미 쓰는 설치 라이브러리의 range parser로 한다. core root는 이 granted item 규칙만으로 grant하며, 그곳에서는 `schema`를 확인하지 않는다. `schema`에 맞지 않는 항목은 workbench(`core.contributions`)가 `invalid`로 보고하며 가져오지 않는다. 그 항목의 선언된 module 파일도 grant되며, 이 over-grant는 기여자가 자기 manifest에 선언한 파일로 한정되고 설계가 이를 밝힌다. F212.5-3은 두 호스트에서 granted item 규칙을 구현한다. provider가 그 확장점의 `extends` 항목을 선언하지 않거나 그 항목에 `version`이 없는 항목은 grant하지 않는다. provider가 설치되지 않았거나 켜져 있지 않은 경우와, `module` 경로가 소유 manifest에 기여자 패키지의 파일로 적혀 있지 않은 경우도 grant하지 않는다. `dependencies` 항목은 어떤 파일도 허용하지 않는다.
   - view import map은 항목이 정확히 네 개다: `soksak`, `@soksak/plugin-api`, `@soksak/plugin-api/view`, 그리고 `sok://core/shared/`에 대응하는 `@soksak/shared/`. `@soksak/runtime`과 `@soksak/workbench/` 항목은 없다. map은 `@soksak/plugin-api`가 내보내는 상수 `VIEW_IMPORTS` 하나이며, 페이지 HTML에 있는 정적 inline `<script type="importmap">`이다. plugin의 빌드가 그 상수로 이를 쓴다. `@soksak/plugin-api`는 `checkViewPage(html)`을 제공하고 plugin 저장소의 시험이 이를 부른다. closure 시험이 view 페이지의 모든 import가 이 항목 가운데 하나로 해석되는지 확인한다. 호스트는 map을 주입하지 않는다.
   - view bridge `@soksak/plugin-api/view`는 파일 `packages/plugin-api/view.js`다. `runtime/`이나 `@soksak/workbench/` 아래의 것을 import하지 않으며, view 쪽 call layer(`calls.js`)와 선언 UI snapshot(`snapshots.js`)을 view 통로로 내보낸다.
   - view channel은 host가 각 view 구성에 주입하는 document-start script이며, 규칙 8의 테마 script와 같다. host 계약이 이름을 정한 message handler `sok-view`를 하나 정의한다. native/darwin은 두 호스트 모두에 대해 handler `sok-view`와 주입 script를 view의 web view 구성에 등록하며, host 계약이 handler 이름을 선언한다. host가 메시지를 view로 보내는 방식은 현재 문서 영역이 받는 방식과 같다: native 코드가 view의 page world에서 `window.postMessage(message, location.origin)`을 실행하며(`sp_document_post`의 형식). 주입된 document-start script는 document 시작 시점에, 어떤 page script보다 먼저 view의 `message` listener를 추가하고, source가 window인 message event를 `createViewChannel()`이 `onMessage`의 handler를 붙이기 전까지 queue에 보관한다. queue는 최대 256개 message를 담고, 호스트 계약에 계약 case와 함께 선언한다. queue가 찬 상태에서 message가 오면 script는 `sok-view` handler로 application log에 `error: view channel: queue full for <plugin>`을 쓰고, 호스트는 view 프로세스를 끝내서, 어떤 호스트 message도 조용히 버리지 않는다. 이 상한은 잰 값이 아니라 정한 값이다. view는 첫 module이 돌 때 통로를 붙이므로 queue는 그 전에 보낸 message만 담고, F212.5-4와 F212.5-7은 관찰한 가장 긴 queue 길이를 기록한다. `createViewChannel()`은 queue의 message를 순서대로, 이어서 들어오는 message를 모두 넘긴다. host message는 버리지 않는다. 주입된 document-start script는 script가 만든 문서 식별자를 담은 ready message를 `sok-view` handler로 보낸다. 호스트는 view마다 현재 문서의 식별자를 기록하고, ready message를 기록한 문서에만 호스트 message를 보낸다. ready message가 기록되지 않은 view로의 post는 false를 돌려주고, 호출한 쪽은 application log에 `error: view channel: <view> has no ready document`를 쓴다. navigation은 새 문서의 ready message가 올 때까지 기록한 식별자를 지운다. F212.5-4는 가짜 handler로 ready message를 시험하고, F212.5-7은 navigation 중의 post를 window check로 시험한다. F212.5-4는 `createViewChannel()` 호출 전에 전달된 message로 queue를 시험하고, F212.5-7은 window check에서 첫 pull의 전달을 시험한다. queue는 한 document의 message를 담으며, `core.plugin.views`는 `queued`를 보고하며, 이는 view가 attach하지 않아 queue에서 기다리는 message의 수다. 그래서 attach하지 않는 view가 보인다. host는 host message마다 `sok: 1` field를 붙이며, channel은 이 field가 없는 message를 application log에 error로 기록하고 어떤 handler에도 넘기지 않는다. 주입 script는 전역 `sokView` 하나를 더하며, 그 `attach`가 host 메시지를 읽는 유일한 방법이다. script는 `packages/plugin-api/view-start.js`다. handler 이름과 전달 형식은 host 계약에 선언하며, F212.5-4는 가짜 handler로 `createViewChannel()`을 두 방향 모두 시험한다. `@soksak/plugin-api/view`는 `createViewChannel()`을 내보내며, 이 함수는 그 handler 위의 `{send, onMessage}`를 돌려주고 이를 `createCalls`와 `createSnapshotSender`에 넘긴다. handler 이름과 주입 script는 host 계약에 선언하고 계약 case를 둔다. view 구성은 F212.7에서만 존재하므로, F212.5-4는 가짜 handler로 `createViewChannel()`을 시험하고 F212.7이 이를 host에 연결한다.
   - 기여 module과 공용 module은 각각 자체완결 ES module 하나다. 그 안의 상대 import는 그 plugin의 빌드 오류이며, 그 plugin 저장소가 검사한다([경계](#경계-결합-금지)). 기여 module과 공용 module은 view import map의 네 항목에서만 bare specifier를 import한다. 그 밖의 bare specifier는 소유 plugin의 빌드 오류다.
   - core root는 애플리케이션 frontend로 넘기지 않는다. view는 `/runtime/` 경로를 받지 않으며, `/start.json`, `/environment.json`, `/index.html`, `/runtime/...`과 위에 없는 그 밖의 경로는 모두 not found다.
   - view에 보내는 모든 응답은 view 구성의 plugin id로 `Access-Control-Allow-Origin: sok://<plugin id>`를 담는다. 요청의 `Origin`이나 `*`는 담지 않는다. 거부한 요청은 이 header를 담지 않는다. WebKit 측정(F212.5-2, `native/darwin/tests/core_root_cors_test.m`의 시험 `core_root_cors_test`, macOS 26.6.2 arm64): `sok://probe` page에서 `sok://core/m.js`로의 module import는 `Origin: sok://probe`를 보낸다. 응답이 `Access-Control-Allow-Origin: sok://probe`를 담으면 import가 성공하며, 같은 module로 매핑하는 import map의 bare specifier도 이 header에서 성공한다. `Access-Control-Allow-Origin`이 없거나 `Access-Control-Allow-Origin: sok://other`이면 import가 실패하고, CORS 거부를 알리는 TypeError가 난다. 이 절의 header 규칙은 시험이 단언하는 계약이다. WebKit은 `*`도 받아들이지만, 이 규칙은 `*`를 계속 보내지 않는다.
   - granted item이나 공용 대상이 지정하지 않은 plugin B의 파일 요청은 not found로 답하고, 두 호스트 모두 `error: core root: <path> is not granted to <plugin>`을 쓴다. 문서 영역은 core root grant를 받지 않는다.
   - core root는 host 계약이 선언하고 각 호스트가 scheme handler에 등록하는 callback으로 제공하며, 계약 case를 둔다(F212.5-6).
   - Red 시험: plugin A의 view가 granted item이 지정하지 않은 plugin B의 파일, A가 `dependencies`로 지정한 plugin의 파일, 또는 `/start.json`, `/environment.json`, `/index.html`, `/runtime/...`을 요청하면 각각 not found를 받고, provider가 그 확장점을 선언하지 않은 기여 항목의 파일도 not found를 받는다.
5. **재시작.** sidecar, plugin host와 view 프로세스는 통과값 (vi)의 한도 안에서 다시 띄운다. 한도를 넘으면 호스트는 `error:`를 보고하고 멈춘다.
   - 끝난 view 프로세스는 호스트가 다시 만들고, 새 view는 저장된 탭 상태에서 상태를 복원한다. 한도는 view 표면마다 센다. 한도를 넘으면 card가 표시 경로로 오류를 보여 주며, 사용자가 탭을 다시 열 때에만 view를 다시 만든다.
   - 한도를 넘은 뒤의 다음 요청은 프로세스를 띄우지 않고 `sidecar-failure`(reason `restart limit`)로 실패한다. 실패 기록은 남긴다. 그 프로세스가 필요한 표면을 사용자가 열 때만 기록을 비우고 프로세스를 띄우며, 호스트는 `host.trace.sidecar.restart-reset {sidecar, surface}`를 쓴다. plugin host는 `host.trace.plugin-host.restart-reset {plugin}`을 쓴다.
   - 이 규칙은 두 명세 위치를 바꾼다. [sidecars](../spec/sidecars.ko.md)의 `## Failure` 절은 67행에서 실패 뒤의 다음 요청이 한도 없이 새 프로세스를 띄운다고 적는다. F212.8a가 그 문장을 규칙 5의 한도로 바꾼다. [terminal runtime](../spec/terminal-runtime.ko.md)의 43행이 적는 재시작 규칙(연결 끊김마다 한 번 시도하고, 다음 전송이 같은 경로를 다시 시도)도 F212.8a에서 바꾼다.
   - 다시 띄우면 state는 마지막으로 저장한 값에서 복원한다. 저장하지 않은 state는 잃으며, plugin마다 어떤 state인지 밝힌다.
   - 고장 주입은 진단 build에서만 둔다.
6. **표시.** plugin view는 card 배치가 바뀐 뒤(gesture의 첫 변경)의 첫 표시에만 presentation wait에 참여한다.
   - 계속되는 gesture(구분선이나 card 끌기) 동안 view의 native frame은 매 frame card와 같은 commit에서 새 기하로 놓는다. 내용 그리기를 기다리는 것은 첫 변경에서만 한다. 그 뒤 내용은 늦게 그려질 수 있으며, 그 늦음은 frame 간격으로 잰다.
   - F212.7c에서 끌기 gesture 전체를 녹화해 frame 간격과 기하 오차를 재고, 통과값 (viii)로 판정한다.
   - 기다림은 다음 가운데 먼저 오는 것으로 끝난다: view의 presentation 완료, view 프로세스 종료, 변경이 끝났을 때 그 view가 보이지 않음(`hidden` 조상, 선택되지 않은 탭, 닫힌 표면. workbench가 표면마다 이미 알리는 상태를 읽는다), `host.trace.view.unresponsive`의 응답 없음 알림. presentation 완료가 아닌 것으로 끝나면 그 view 없이 commit을 진행하고 `host.trace.view.presentation-abandoned {surface, reason}`을 쓰고 `losses.abandoned`를 센다. host가 쓰는 이유는 wait를 host가 소유하기 때문이다. host가 commit을 하고 각 끝을 보기 때문이다. timer는 쓰지 않는다.
   - 통과값 (v)는 실행 중 기한이 아니다. F212.7b와 각 plugin 항목이 재는 판정값이다.
   - F212.7b는 view가 있는 card의 전체 화면 전환과 탭 전환을 녹화해, 두 기다림이 모두 끝나는지 확인한다.
   - [native surfaces](../spec/native-surfaces.ko.md)의 해당 규칙을 고친다.
7. **입력.**
   - workbench 단축키는 주인과 명령을 함께 [키보드 단축키](../spec/exposure.ko.md#키보드-단축키)에 적는다.
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

   - Escape와 글 입력 키의 주인은 view다. view의 first responder가 이 키들을 받기 때문이다. View 메뉴의 메뉴 단축키(Command `=`, `-`, `0`)는 글자 크기 명령을 실행하는 native 메뉴 단축키다([글자 크기](../spec/text-size.ko.md)).
   - 단축키 표 전체는 [키보드 단축키](../spec/exposure.ko.md#키보드-단축키)이며, 기계가 읽는 선언은 `packages/workbench/shortcuts.json`이다. `scripts/test/shortcut-table.test.mjs`가 이 표를 두 호스트의 메뉴 표와 workbench 키 처리기에 대해 검사한다.

8. **테마와 접근성.**
   - 호스트는 view를 만들 때 현재 테마 token 묶음을 document-start user script로 view 설정에 넣는다. 그래서 페이지의 첫 script가 돌기 전에 token이 있다.
   - 그 뒤의 테마 변경은 post 경로로 보낸다. 다만 ready message가 기록되지 않은 문서에는 보내지 않는다. 호스트는 ready message마다 현재 테마를 보내므로, ready 전의 변경은 오류도 아니고 유실도 아니다. 규칙 4의 post 규칙(false와 오류)은 다른 모든 message에 적용한다.
   - F212.7d에서 첫 frame의 색을 card token 색과 비교한다. document-start user script는 미결 항목 9다.
   - 접근성: F212.12에서 view의 요소 tree가 플랫폼 접근성 interface로 닿는지 기록한다. 검사가 생기기 전에는 접근성에 대해 다른 주장을 하지 않는다.
9. **View의 영역.** view의 영역(document region 또는 image region)은 그 view의 표면 host에 붙는다. 영역을 두거나 바꾸는 각 호출은 호출 envelope의 view id로 확인한다. insets는 view frame 기준이다. 영역의 presentation은 규칙 6에 따라 같은 창 transaction에 넣는다. F212.7이 이 규칙의 계약 case를 정한다.
10. **View의 unload와 restore.** 탭을 unload하면 그 탭의 view와 그 프로세스를 닫는다. restore는 저장한 state에서 새 view를 만든다. 통과값 (ii)는 unload마다 적용한다.

## 메시지와 event

**메시지**

| 메시지 | 방향 | field | 비고 |
|---|---|---|---|
| `declared-ui.snapshot` | plugin → workbench (event) | `{plugin, status, seq, value, skipped}`. `skipped`는 status의 이전 snapshot이 보내진 뒤 덮어쓴 값의 수다 | 규칙 2의 push |
| `declared-ui.snapshot.ack` | workbench → plugin (event) | `{plugin, status, seq}` | 수신을 확인하고 전송 슬롯을 비운다 |
| `declared-ui.snapshot.request` | workbench → plugin (call) | `{status}`, 응답은 `{seq, value}`이며 `seq`는 출처의 마지막 선언된 UI snapshot의 seq이고, `value`가 `null`이면 0이다 | 규칙 2의 pull(load, 출처 변경, 방향 변경). 출처에 아직 값이 없으면 `value`는 `null`이다 |

RPC protocol 번호는 0.0 계열에서 1이다.

**Event.** 각 event 이름은 층(`host` 또는 `page`)으로 시작한다. class는 다루는 관심사(`call`, `lifecycle`, `input`)를 나타낸다. event는 F212.3에서 선언하며, `host.trace.sidecar.restart-reset`은 F212.8a가 선언한다.

| event | class | level | field |
|---|---|---|---|
| `page.trace.declared-ui.snapshot.skipped` | call | debug | `{plugin, status, count}`: 전송 중일 때 건너뛴 값. 카운터 `losses.skipped`. 메인 페이지가 쓴다 |
| `host.call.timeout` | call | error | `{plugin, command}`. 카운터 `losses.timeouts` |
| `host.call.peer-lost` | call | error | `{plugin, command, reason}`: `process-ended`(view call). `surface-closed`는 event를 쓰지 않고 `losses.peerLost`를 센다. sidecar 종료는 sidecar 실패 계약이 알린다 |
| `host.trace.call.late-reply` | call | debug | `{plugin, command, delay}`. 카운터 `losses.lateReplies` |
| `host.trace.view.unresponsive` | call | debug | `{plugin, surface}`. 상태 `core.plugin.views.responsive` |
| `host.trace.view.responsive` | call | debug | `{plugin, surface}`. 상태 `core.plugin.views.responsive` |
| `host.trace.view.process-request` | call | debug | `{plugin, surface}` |
| `host.trace.view.process-ready` | call | debug | `{plugin, surface}` |
| `host.trace.view.presentation-abandoned` | call | debug | `{surface, reason}`. 카운터 `losses.abandoned`. host가 wait를 소유하므로 host가 쓴다 |
| `page.view.shortcut-table-missing` | input | error | `{plugin}` |
| `page.input.shortcut.failed` | input | error | `{plugin, key, command}` |
| `host.plugin-host.restart` | lifecycle | error | `{plugin, attempt}` |
| `host.plugin-host.restart-limit` | lifecycle | error | `{plugin}` |
| `host.trace.plugin-host.restart-reset` | call | debug | `{plugin}` |
| `host.trace.sidecar.restart-reset` | call | debug | `{sidecar, surface}`, F212.8a가 선언 |

F212.3은 status `core.plugin.open-calls`, `core.plugin.losses`, `core.plugin.views`를 선언한다. 이 설계의 event는 level `error` 또는 `debug`로만 선언한다. catalog 항목을 쓰기 전에 [events](../spec/events.json)의 class 예산을 확인한다(F212.3). plugin host와 sidecar의 재시작 상태는 `core.plugin.views` 또는 sidecar status에 보인다.

**릴리스의 event level.** 0.0.x 릴리스는 error event만 저장한다(AGENTS.md, Diagnostic code). 따라서 이 설계의 각 발생은 한 번 분류한다.
(a) 실패나 거부된 연산은 level `error`의 event다.
(b) 손실, 건너뜀, 일시 상태, 표시 품질 저하는 event가 아니다. 선언된 status `core.plugin.losses {plugin, skipped, stalled, abandoned, lateReplies, timeouts, peerLost}`에 센다. 이것은 선언된 status `core.plugin.views {plugin, surface, responsive, queued}`의 상태이기도 하다. 각 수는 바뀔 때마다 status 구독자에게 알린다. 수는 plugin마다 세며 앱이 끝날 때까지 유지한다. 표면이 닫힐 때 0으로 되돌리지 않는다. dirty 값이 있는 채로 닫히는 표면은 그 값을 버리기 전에 `losses.stalled`를 늘려, 모든 build에서 그 손실을 센다.
성능 trace가 켜져 있으면(설정 창의 디버그 switch) 수가 바뀔 때마다 표에 적힌 trace event도 쓴다. 릴리스의 event log는 error event만 저장한다.

코드의 식별자는 여기에 적은 이름을 그대로 쓴다.

## 경계 (결합 금지)

- 이 설계에서 core가 하는 일은 기구뿐이다. view 구성 종류, 선언 UI schema와 그리기, RPC와 binary 통로, core root, 재시작 한도, 계약 case가 여기에 든다.
- 규칙 4의 view channel이 view의 유일한 전송 통로다.
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
6. view import map은 `@soksak/plugin-api`의 상수 `VIEW_IMPORTS` 하나이며, plugin의 빌드가 각 view 페이지에 inline importmap으로 쓰고 F212.5-4의 `checkViewPage`와 closure 시험이 확인한다(규칙 4). 문서 영역은 core root grant를 받지 않는다.
7. plugin host를 가리키는 exposure owner key는 `plugin:<plugin id>`로 한다. view에는 새 key가 필요 없다. view는 모든 surface처럼 surface id 아래에 등록하고, owner는 그 tab의 plugin이다(F212.6-3). plugin의 identity인 plugin id를 쓰므로([신원](#신원)) 그렇게 정한다.
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

아래 반론은 첫 번째, 두 번째, 세 번째, 네 번째, 다섯 번째, 여섯 번째 검토와 core root 검토 1, 2, 3의 답변이다. 각 항목은 반론, 판정, 해결을 적는다. 해결은 이 제안서의 규칙에 기록한다. 두 번째 검토의 항목은 검토의 id(C, H, M)를 쓴다. 세 번째 검토의 항목은 검토의 id(N, D)를 쓴다. 두 번째 검토의 잘못된 답변 세 개는 C1, C7, H3에 대한 답변이다.

**첫 번째 검토**

- 반론: 모든 view를 정책으로 새 프로세스에 띄워 문서마다 격리한다. 판정: 기각. 해결: 측정한 새 프로세스 정책은 이득이 없고 load가 더 느렸다(F196.27-1, F196.27-2). 기본 배정을 유지하고 그 정책은 쓰지 않는다.
- 반론: 죽는 프로세스가 끝없이 다시 떠서 페이지를 붙잡는다. 판정: 수용. 해결: 300초 sliding window에서 4번째 실패에 재시작을 멈추고, 표면을 열면 기록을 비운다(규칙 5, 통과값 (vi)).
- 반론: 현재 sidecar 실패 규칙은 한도 없이 다시 띄우므로 같은 위험이 있다. 판정: 수용. 해결: 한도를 모든 sidecar에 적용하고, 계약 변경은 F212.8a에서 host package의 Red 시험과 함께 한다.
- 반론: 호출마다 거는 timer는 응답을 polling하는 것이다. 판정: 일부 수용. 해결: 상대가 사라지면 event(`host.call.peer-lost`)로 호출을 끝내고, timer는 살아 있는데 답하지 않는 상대에만 남기며 그 이유를 규칙 3에 적는다.
- 반론: view의 presentation 기다림이 commit을 무한히 막을 수 있다. 판정: 수용. 해결: 규칙 6의 event 가운데 먼저 오는 것으로 끝나며 timer를 쓰지 않고, presentation 없이 끝나면 `host.trace.view.presentation-abandoned`를 쓴다(규칙 6). 두 번째 검토가 event 목록을 바로잡았다(C1).
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

**core root 검토 3**

- S1: host가 view로 보내는 경로가 없었고 전달 형식이 선언되지 않았다. 판정: 부분 수용. 해결: host는 각 host-to-view 메시지를 view의 page world에서 `window.postMessage(message, location.origin)`으로 전달한다(`sp_document_post`의 형식이며 문서 영역이 이미 이 방식으로 받는다). `createViewChannel()`은 source가 window인 message event를 `onMessage`의 handler에 넘긴다. 제안된 전역 함수 `sokViewDeliver`는 기각하며 page에 전역 함수를 더하지 않으므로, 영역과 view가 전달 형식 하나를 쓴다. handler 이름과 전달 형식은 host 계약에 선언하며, F212.5-4는 가짜 handler로 두 방향을 시험한다(규칙 4).
- S2: granted item 규칙이 provider가 확장점을 선언하지 않은 경우, `version`이 없는 entry, 소유 manifest에 없는 `module` 경로의 세 경우를 다루지 않았다. 판정: 수용. 해결: 이 항목들은 grant하지 않으며, 규칙이 그 경우를 적는다(규칙 4). 확장점을 선언하지 않은 기여 항목의 파일을 시험하는 Red 시험을 둔다(규칙 4).
- N1: handler와 주입 script의 native 등록에 담당이 없었다. 판정: 수용. 해결: native/darwin이 두 호스트 모두에 대해 handler와 주입 script를 view의 web view 구성에 등록하며, host 계약이 handler 이름을 선언한다(규칙 4).
- N2: 기여 module과 공용 module의 bare import 규칙이 없었다. 판정: 수용. 해결: 그 module은 view import map의 네 항목에서만 bare specifier를 import한다. 그 밖의 bare specifier는 소유 plugin의 빌드 오류다(규칙 4).

**core root 검토 4**

- S3: `createViewChannel()`이 handler를 붙이기 전에 도착한 host message를 보관하는 queue가 없었고, attach하지 않는 view가 보이지 않았다. 판정: 수용. 해결: 주입된 document-start script가 document 시작부터 attach 전까지 view의 message를 queue에 보관하고, `createViewChannel()`은 queue를 순서대로, 이어서 모든 이후 message를 넘긴다. 이로써 host message를 버리지 않는다. script를 아직 commit하지 않은 view에 보낸 message는 `sp_document_post`에서 실패하며 application log에 error로 기록된다. queue 수는 `core.plugin.views`에 `queued`로 보고된다. F212.5-4와 F212.5-7이 이를 시험한다(규칙 4).
- N4: handler 등록이 규칙 4의 두 문장에 서술되어 있었다. 판정: 수용. 해결: 등록은 한 번만 서술하며, native/darwin이 두 호스트 모두에 대해 handler `sok-view`와 주입 script를 등록하고 host 계약이 handler 이름을 선언한다(규칙 4).
- N5: channel이 host 표지가 없는 message를 받아들였다. 판정: 수용. 해결: host는 host message마다 `sok: 1` field를 붙이며, channel은 이 field가 없는 message를 application log에 error로 기록하고 어떤 handler에도 넘기지 않는다(규칙 4).
**core root 검토 5**

- T1: navigation 중의 post가 URL 검사를 통과하고 사라졌다. 판정: 수용. 해결: 문서 식별자를 담은 ready message. 기록된 ready 문서에만 보낸다.
- T2: queue에 상한이 없었다. 판정: 수용. 해결: 정한 상한 256개, 관찰한 길이는 F212.5-4와 F212.5-7이 기록한다. queue가 차면 error이고 view 프로세스를 끝낸다.

**선언된 UI 스키마 검토**

아래 이의는 [선언된 UI](../spec/declared-ui.ko.md)(F212.8-0)의 적대적 검토에 대한 답변이다. 각 항목은 이의, 판정, 해결을 적으며, 명세가 그 해결을 기록한다.

- D1: 범위가 인라인 이름 바꾸기, 끌어 놓기, 포인터 위치의 문맥 메뉴가 필요한 tree를 어떻게 하는지 말하지 않았다. 판정: 수용. 해결: 그런 tree는 계층 규칙에 따라 view다. core는 그런 상호작용의 요소를 선언하지 않는다. plugin의 저장소가 각 surface를 선언된 UI 또는 view로 선언한다.
- D2: 노드 한도를 넘는 tree의 동작이 정해지지 않았고, 지연 적재는 자른 사실을 workbench에서 숨긴다. 판정: 수용. 해결: core는 자르지 않으며 지연 적재가 없다. 더 큰 값을 가진 plugin은 view를 쓰거나, 자기 값을 스스로 자르고 자른 사실을 status-line에 적는다.
- D3: 한도에 이유가 없었다. 판정: 수용. 해결: 각 한도를 선택값으로 표시하고, snapshot 하나에 대한 main page의 작업을 이유로 적는다. list 항목과 tree 노드의 한도는 tree 노드 5000개와 list 항목 1000개의 측정된 그리기 시간으로 고친다(F212.8-7).
- D4: 노드 key로 키 잡은 유지 트리 상태는 key가 다른 부모 밑에서 반복되면 깨지고, 수명이 정해지지 않았다. 판정: 수용. 해결: 유지 상태는 루트부터의 노드 key 경로로 키 잡는다. plugin의 바뀐 `expanded` 값이 유지 상태보다 우선한다. plugin 프로세스가 다시 시작하면 유지 상태는 초기화되고, 공간에 저장하지 않으며, 받아들인 값에 그 경로가 없으면 지운다.
- D5: `selected`에는 정해진 유지 상태가 없었다. 판정: 부분 수용. 해결: plugin의 바뀐 값이 유지 상태보다 우선한다는 규칙은 `expanded`에 적용한다. `selected`는 이를 바꾸는 core 명령이 없으므로 workbench 상태를 보관하지 않으며, plugin의 값이 받아들인 모든 값에 적용된다. 유지되는 `selected`는 쓰는 주체가 없기 때문이다.
- D6: 전환 명령을 두 번 실행하면 변경이 반복된다. 판정: 수용. 해결: `core.declared-ui.tree.expand {status, tree, path, expanded}`는 유지 상태를 설정하므로, 같은 인수는 같은 결과를 낸다.
- D7: section DOM 이름이 기존 `core.sidebar.section.*` 이름과 겹쳤고, `core.sidebars`는 어떤 요소를 세는지 말하지 않았다. 판정: 수용. 해결: `core.sidebar.section.header`와 `core.sidebar.section.control`을 재사용하고, `core.declared-ui.section-header`는 제거한다. `core.sidebars`는 본문의 제어 요소, 첫 받아들인 값부터의 mounted 상태, 현재 거부의 텍스트를 센다.
- D8: `data-key`가 노출 명세에 없었다. 판정: 수용. 해결: 노출 명세는 선언된 UI 값이 그리는 요소에만 `data-key`를 적고, 다른 요소에는 적지 않는다.
- D9: 역할 정의가 접근성 주장을 함의했다. 판정: 수용. 해결: F212.12가 플랫폼 인터페이스를 기록할 때까지 접근성 주장도 ARIA 역할도 정하지 않는다(규칙 8).
- D10: 거부가 로그와 section에서 두 번 보일 수 있었고, 같은 거부가 반복되면 다시 쓰였다. 판정: 수용. 해결: section은 `showError`가 쓰는 텍스트를 보인다. 로그 줄은 같은 자리와 같은 텍스트에 대해 한 번 쓰는데, `showError`가 보이는 텍스트를 유지하기 때문이다. 다음 받아들인 값이 표시를 거둔다.
- D11: plugin은 자기 값이 거부되었다는 것을 알 수 없다. 판정: 부분 수용. 해결: 응답은 수신 확인이지 유효성 확인이 아니므로 plugin은 거부 신호를 받지 않으며, 거부는 section에서만 보인다. 거부 메시지는 snapshot channel에 새 메시지를 요구하는데, 이를 요구하는 소비자가 없다.
- D12: `fill`과 빈 list 규칙이 정해지지 않았다. 판정: 수용. 해결: `fill`은 plugins가 모듈 section에 주는 뜻을 가진다. 각 list는 필수 `empty` 텍스트를 가진다. 가로 section의 tree는 거부한다.
- D13: menu 요소, busy tone, list label에는 소비자가 없다. 판정: 수용. 해결: 셋을 제거하며, menu의 명령, DOM 이름, 한도도 요소와 함께 제거한다. 제거한 menu 하위 항목의 checklist ID는 재사용하지 않는다.
- D14: 진행 또는 배지 요소가 필요하다. 판정: 거부. 해결: 소비자가 없으므로 요소를 더하지 않는다.
- D15: 거부된 값은 마지막으로 받아들인 트리를 계속 그려야 한다. 판정: 거부. 해결: 유지 트리는 대체 동작이다. plugin이 더 이상 현재 값으로 보내지 않는 값을 보이고 거부를 숨긴다. 값 전체 거부를 유지한다.
- D16: tree label을 list label과 같은 규칙으로 제거했다. 판정: 검토의 요구가 아니라 개정의 판단으로 수용한다. 해결: 소비자가 tree 이름을 정하지 않으며, section 머리가 내용을 이름 짓는다.

**선언된 UI 스키마 검토 2차**

아래 이의는 [선언된 UI](../spec/declared-ui.ko.md)의 두 번째 적대적 검토에 대한 답변이다. 열두 건을 모두 수용한다. 각 항목은 이의, 판정, 해결을 적으며, 명세가 그 해결을 기록한다.

- R2-1: 선언된 section의 status를 따라가는 규칙이 없었다. section은 문맥이 없기 때문이다. 판정: 수용. 해결: workbench는 plugin의 `context.status` 규칙으로 status를 따라가며, 그 section을 그리는 사이드바의 카드와 활성 탭을 쓴다.
- R2-2: 첫 값 전 section의 내용이 정해지지 않았다. 판정: 수용. 해결: 첫 받아들인 값 전에는 section이 트리를 보이지 않는다. 그 전에 보일 수 있는 내용은 거부 텍스트뿐이며, 거부된 값 뒤에만 보인다.
- R2-3: 펼침 명령이 선언된 것으로 기술되었으나 선언이 없었다. 판정: 수용, 해결을 바꿈. 해결: 처리기가 없는 선언은 `make exposure-check`에서 `declared but not registered`로 실패하므로, 이 개정에서는 선언을 더하지 않는다. 명세는 그 명령이 tree 요소가 구현될 때 처리기와 함께 `packages/workbench/exposure.json`에 선언된다고 적는다.
- R2-4: `data-key`가 모든 요소에 붙었고, 요청의 주소가 정해지지 않았다. 판정: 수용. 해결: `data-key`는 조작 가능한 요소에만 붙으며, 요청은 요소를 section id와 루트 요소에서 그 요소까지의 key 경로로 지정한다. 키는 형제 사이에서 유일하므로 그 경로는 유일하다. 노출 명세가 그렇게 적는다.
- R2-5: status 하나가 여러 section을 뒷받침할 수 있었다. 판정: 수용. 해결: 같은 status를 이름 댄 두 번째 section은 manifest를 읽을 때 두 section의 이름을 담은 오류로 거부한다. 가로 tree 검사는 section의 방향이 값을 받아들일 때만 알려지므로 값 검사로 남긴다.
- R2-6: tree에 `empty` 텍스트가 없었고, 잎 노드에 `expanded`가 허용되었다. 판정: 수용. 해결: tree는 list와 같이 `empty`를 요구한다. `expanded`는 가지에만 허용하며, 가지는 `children`이 있고 비어 있지 않은 노드다. `expanded`를 가진 잎은 거부한다.
- R2-7: 거부 템플릿이 하나가 아니었고, 크기 오류의 필드와 포인터가 정해지지 않았다. 판정: 수용. 해결: 모든 거부 텍스트는 `<포인터>: <이유>` 형식이다. 한도 이유는 `exceeds <n> <unit>` 형식이다. `<field>`는 JSON 필드 이름이며, 루트와 값 전체 크기의 포인터는 `/`이다. 표에는 매개변수 키 길이 64자와 매개변수 문자열 값 1000자의 행을 더한다.
- R2-8: 종류 `command`가 명령 용어와 겹쳤고, 선언된 UI 용어에 메뉴가 남았다. 판정: 수용. 해결: 종류를 두 명세 언어 모두에서 `button`으로 바꾼다. 메뉴는 용어 목록의 선언된 UI 용어와 이 계획의 두 언어 계층 규칙에서 뺀다.
- R2-9: 개수 필드, 비워진 상태, 거부 뒤의 `mounted`, 노출 설명이 정해지지 않았다. 판정: 수용. 해결: 개수 필드는 `controls`다. section은 받아들인 값이 없을 때 비워진다. 첫 받아들인 값 전과 거부된 값 뒤가 그 경우다. section이 비워지면 `mounted`는 false다. workbench 노출의 `core.sidebar.section`, `core.sidebar.section.control`, `core.sidebar.section.header` 설명은 선언된 section을 포함하도록 이 개정에서 고친다.
- R2-10: plugin 명세의 sections 형태 변경을 미루었다. 판정: 수용. 해결: 이 개정에서 변경한다. section은 `module`과 `status` 가운데 정확히 하나를 선언하며, plugin 명세의 manifest 행과 sections 문단이 두 언어로 그렇게 적는다.
- R2-11: plugin 값이 core 명령을 이름으로 지정할 수 있었고, 펼침 제어의 멱등성이 논증되지 않았다. 판정: 수용. 해결: plugin 값은 자기 plugin의 명령만 이름으로 지정하며, 값의 core 명령은 `command <name> is not a command of plugin <plugin>`으로 거부한다. workbench는 가지 제어를 `core.declared-ui.tree.expand`로 그린다. 제어의 다음 요청은 workbench가 제어를 그릴 때의 유지 상태를 담으므로, 다시 그리기 전의 반복 요청은 같은 인수를 보내 같은 상태를 설정하고, 다시 그린 뒤의 요청은 다시 그린 상태를 담는다.
- R2-12: 어떤 status가 선언된 UI인지 정한 규칙이 없었다. 판정: 수용. 해결: sidebar section이 `status` 형태로 이름을 대면 선언된 UI status다. 스키마 표지는 쓰지 않는다. 첫 답변의 surface 경로는 3차 검토에서 제거한다(R3-1).

**선언된 UI 스키마 검토 3차**

아래 이의는 [선언된 UI](../spec/declared-ui.ko.md)의 세 번째 적대적 검토에 대한 답변이다. 열 건을 모두 수용한다.

- R3-1: surface가 status를 선언된 UI로 선언할 수 있었으나 명세가 그 선언 형식을 정하지 않았다. 판정: 수용. 해결: surface 문장 두 곳을 범위와 status 규칙에서 모두 뺀다. status는 section의 `status` 형태로만 선언된 UI다. R2-12는 그에 맞게 고친다.
- R3-2: section 방향이 바뀌어도 받아들인 값에 검사를 다시 하지 않았다. 판정: 수용. 해결: 방향이 바뀌면 받아들인 값에 검사를 다시 한다. 검사에 실패한 값은 기존 행으로 거부하고, 그 tree는 지우며, section은 비운다.
- R3-3: 용어 목록과 계획이 어휘를 명령(commands, command)으로 적었다. 판정: 수용. 해결: 선언된 UI 용어와 그 계층 규칙(용어 목록과 계획의 두 언어)은 list, tree, button, status-line 가운데 하나인 요소만 가진 사이드바 section이라고 적는다. 선언된 요소 용어는 button이라고 적는다.
- R3-4: 한도가 확정되지 않은 것으로 적혔고, 개정 칸이 끝나지 않은 계약을 말했다. 판정: 수용. 해결: 표의 한도가 계약 값이다(list 항목 1000개, tree 노드 5000개). "확정 전에 고친다" 문장과 개정 칸을 뺀다. 측정은 그리기 시간 하위 항목과 이 기록에 남는다.
- R3-5: list 항목과 tree 노드에 명시적인 알 수 없는 필드 행이 없었다. 판정: 수용. 해결: `unknown field <field>` 행이 루트, 요소, list 항목, tree 노드를 덮는다. 포인터는 그 객체이며, 루트에서는 `/`다.
- R3-6: 소유자가 없는 이름과 core의 이름이 두 행에 모두 맞을 수 있었고, 행의 순서가 정해지지 않았다. 판정: 수용. 해결: 표의 순서에서 첫 행이 적용되며, 이름 행(`.`이 없는, 소유자가 없는 이름)이 소유자 행(소유자가 core이거나 다른 plugin)보다 앞에 있다. `core.` 접두어를 가진 이름은 따라서 core 명령으로 보고되며, 이름이 없다고 보고되지 않는다.
- R3-7: `core.sidebars` 설명이 선언된 section의 필드를 말하지 않았다. 판정: 수용. 해결: workbench 노출의 설명이 선언된 section에 대해 R2-9가 정한 `mounted`, `error`, `text`, `controls`를 적고, 모듈 section에 대해서는 mount 상태, mount 오류, 그린 텍스트, 제어 수를 적는다.
- R3-8: 모듈 section은 workbench 페이지에서 plugin 코드를 실행하며, 계획의 규칙 1이 이를 금지한다. 판정: 수용. 해결: 모듈 형태는 페이지 마운트와 함께 제거될 때(F212.11)까지 지금의 형태다. 선언된 UI 명세는 `status` 형태의 사이드바 section이 선언된 UI이며, 뷰가 필요한 section은 카드 표면이 된다고 적는다. plugin 명세는 모듈 형태를 지금의 형태로, 페이지 마운트와 함께 제거되는 것으로 적는다. "지금처럼"이라는 표현을 고친다.
- R3-9: 거부된 값이 유지 상태를 바꿀 수 있었다. 판정: 수용. 해결: 거부는 유지 상태를 바꾸지 않으며, 비교는 마지막으로 받아들인 값을 쓴다.
- R3-10: 선언된 section의 따라가기 규칙이 규칙이 아니라 참조였고, snapshot 용어에 `skipped`가 없었다. 판정: 수용. 해결: 따라가기 규칙을 순서와 함께 적는다. 상태 모듈, 활성 탭의 surface(이름을 등록했을 때), 기본 surface, 등록될 때까지 null, 등록이 바뀌면 다시 고르고, 실패는 페이지 오류다. 선언된 UI snapshot 용어는 `skipped`를 포함한다.

**선언된 UI 스키마 검토 4차**

아래 이의는 [선언된 UI](../spec/declared-ui.ko.md)의 네 번째 적대적 검토에 대한 답변이다. 열 건을 모두 수용한다.

- R4-1: 선언된 status의 따라가기 규칙에 상태 모듈 단계가 있었고, plugin 명세를 가리키며 그 명세는 다시 이 규칙을 가리켰다. 판정: 수용. 해결: 상태 모듈 단계를 뺀다. 선언된 UI 명세가 순서를 직접 적는다. 사이드바를 가진 카드의 활성 탭의 view(그 view의 페이지가 status를 등록했을 때), 다음 plugin의 plugin host, 그 밖에는 누군가 등록할 때까지 section을 비운다.
- R4-2: 열린 view가 없는 동안에도 sidebar section이 값을 보여야 하는 plugin은 plugin host가 필요하다. 판정: 수용. 해결: 이 결과를 sidebar section의 계층 규칙과 plugin host 항목의 참고에 적는다. 그래서 그런 plugin은 그 항목을 요구한다.
- R4-3: 창 사이드바의 카드가 적히지 않았다. 판정: 수용. 해결: 고정 창 사이드바에서 카드는 재정의가 적용되는 동안 `core.sidebars`가 보고하는 포커스된 내용 카드와 그 활성 탭이다. 재정의가 적용되지 않으면 view 단계를 건너뛴다. plugin 명세를 맞춘다.
- R4-4: "등록"이 정의되지 않았다. 판정: 수용. 해결: 프로세스는 자기 페이지가 `page.exposure.register("status", name)`을 부르면 status를 등록하며, 등록은 그 프로세스의 것이다.
- R4-5: 선언된 UI 명세가 선언된 UI snapshot을 뜻하면서 "snapshot"이라고 적었다. 판정: 수용. 해결: 선언된 status의 snapshot을 설명하는 줄, 즉 스키마 부분 집합, 전체 값, 그리기에서 두 언어 모두 "선언된 UI snapshot"을 쓴다.
- R4-6: 선언된 UI status, branch, 선언된 section 용어가 없었다. 판정: 수용. 해결: 세 용어를 용어 목록에 더한다. 용어 문서는 규칙만 적고 용어 목록이 없으므로 고칠 미러가 없다.
- R4-7: 개수와 길이 이유가 초과한 값을 가리키지 않았다. 판정: 수용. 해결: 한도 이유는 초과한 배열, 객체, 문자열을 가리킨다. 템플릿 문단이 각 한도의 포인터를 적고, 직렬화한 값의 크기는 `/`다.
- R4-8: `command`가 없는 `params`나 `enabled`에 대한 행이 없었다. 판정: 수용. 해결: `<field> requires command` 행을 더한다.
- R4-9: 세 가지 view 사례(인라인 이름 바꾸기, 끌어 놓기, 포인터 위치 문맥 메뉴)가 계층 규칙에 없었다. 판정: 수용. 해결: 두 언어의 view 규칙에 더한다.
- R4-10: 명세에 추적 식별자, plugin 명세 sections 문단의 보류 문장, "지금 section이 그리는 것" 절, "이 형태는 지금의 형태다" 문장, "이 버전에서"라는 말이 있었다. 판정: 수용. 해결: 식별자를 빼고 접근성 문장은 검사를 가리킨다. 보류 문장을 뺀다. 절을 빼고, 모듈 형태의 설명은 이 계획의 계층 규칙에 둔다. 모듈 bullet의 문장을 빼고, 모듈 형태는 이 계획에 적는다. 명세에서 "이 버전에서"를 뺀다.

**선언된 UI 스키마 검토 5차**

아래 이의는 [선언된 UI](../spec/declared-ui.ko.md)의 다섯 번째 적대적 검토에 대한 답변이다. 아홉 건을 모두 수용한다.

- R5-1: 선언된 status의 출처가 바뀌는데 명세가 바뀔 때의 동작을 말하지 않았다. 판정: 수용. 해결: 전이를 명세에 적는다. (a) 사이드바 카드의 활성 탭, 고정 창 사이드바의 포커스된 카드, 또는 등록이 바뀌면 출처를 다시 고른다. (b) 출처가 바뀌면 새 출처의 첫 값을 받아들일 때까지 section을 비우며, 유지된 상태는 경로별로 살아남는다. (c) 출처가 바뀌면 workbench는 새 출처의 현재 값을 한 번 pull한다. (d) 프로세스가 끝나면 그 등록을 지우고, 출처를 (a)처럼 다시 고른다. 계획의 규칙 2는 메인 페이지 load 때와 출처가 바뀔 때만 pull을 허용하며, 다른 때는 허용하지 않는다. 실행 중인 view는 마지막 값을 새 독자에게 보낼 다른 수단이 없기 때문이다.
- R5-2: manifest는 상태 모듈만 등록하는 status를 거부했으나, manifest는 상태 모듈이 어떤 status를 제공하는지 말하지 않는다. 판정: 수용. 해결: manifest 시점의 거부를 뺀다. `exposes.status`는 `plugin.json`의 `exposes.status` 항목만 뜻한다.
- R5-3: status의 상태를 설명하는 문장이 계약을 되풀이했다. 판정: 수용. 해결: plugin 명세와 선언된 UI 명세에서 설명 문장을 뺀다. 계약은 남긴다.
- R5-4: 포인터 규칙이 모든 행에 적용되지 않았다. 판정: 수용. 해결: 포인터 규칙 하나를 모든 행에 적용하며, 표는 두 언어 모두 포인터 열을 가진다. 중복 키는 두 번째 키를 가리킨다. 필드의 존재를 다루는 행은 그 필드를 가진 객체를 가리킨다. 개수나 크기 한도는 초과한 값을 가리킨다.
- R5-5: 펼침 명령의 path 배열이 거부 메시지에서 타입으로 적혀 있지 않았다. 판정: 수용. 해결: `<path>`는 문자열의 JSON 배열이다.
- R5-6: 네이티브 button을 가지는 요소가 나열되지 않았다. 판정: 수용. 해결: 명세가 나열한다. `button`, `command`가 있는 list 항목, `command`가 있는 tree 노드, tree 가지의 펼침 제어.
- R5-7: 용어 문단이 세 용어를 빠뜨렸고, "선언된 UI 값"이 용어가 아니었다. 판정: 수용. 해결: 용어 문단이 세 용어를 나열하며, "선언된 UI 값"을 용어 목록에 더한다. 제어 문자는 선언된 UI 명세에서 U+0000에서 U+001F, U+007F, U+0080에서 U+009F다. plugin 명세는 범위를 적지 않으므로 충돌이 없다.
- R5-8: 펼침 명령의 시기가 명세에 있었고, "snapshot"이 일부 맨 말로 쓰였다. 판정: 수용. 해결: 펼침 명령의 구현 시기만 이 계획의 계층 규칙으로 옮긴다(F212.8-2). 명령은 처리기와 함께 선언한다는 요구는 명세에 남는다. 이의가 지정한 줄의 맨 "snapshot"을 "선언된 UI snapshot"으로 바꾸며, 같은 종류의 맨 말 두 곳(등록이 없는 요청 규칙과 이전 프로세스 규칙)도 바꾼다.
- R5-9: `command`가 없음 행이 버튼에도 적용되었으나, 버튼의 명령이 없으면 이미 필드 누락이다. 판정: 수용. 해결: 행을 list 항목과 tree 노드로 한정한다.

**선언된 UI 스키마 검토 6차**

아래 이의는 [선언된 UI](../spec/declared-ui.ko.md)의 여섯 번째 적대적 검토에 대한 답변이다. 여덟 건은 수용하고, 한 건은 부분 수용한다.

- R6-1: plugin 명세의 상태 문단이 선언된 section이 status를 받는 순서를 되풀이했다. 판정: 수용. 해결: 그 문장을 빼고, 출처를 적은 선언된 UI 명세로의 링크는 남긴다.
- R6-2: 묶기 부분의 멱등성 문장이 진행 보고로 읽혔다. 판정: 부분 수용. 해결: 문장은 계약, 즉 반복 요청이 같은 상태를 설정한다는 것을 적으므로 남긴다. 5차에서 옮긴 것은 펼침 명령의 구현 시기뿐이며, R5-8이 그렇게 적는다.
- R6-3: 모듈 형태와 제거를 말하는 문장이 plugin 명세와 선언된 UI 명세에 남아 있었다. 지난 보고는 그것들을 뺐다고 했으나, 검사는 문단의 문구만 보고 모듈 bullet과 sections 형태는 보지 않았다. 판정: 수용. 해결: 두 언어에서 문장을 뺀다. 두 언어에서 현재 형태와 제거 문구를 검색하여 선언된 UI 명세와 plugin 명세의 sections 문단에 없음을 확인한다.
- R6-4: 루트가 객체가 아닌 경우와 `elements`가 배열이 아닌 경우가 한 행과 한 포인터를 공유했다. 판정: 수용. 해결: 두 행이다. 루트가 객체가 아니면 `/`를 가리키며 `root must be an object`로 보고한다. `elements`가 배열이 아니면 `/elements`를 가리킨다.
- R6-5: `unknown kind`가 `unknown field` 뒤에 있었으나, 요소의 필드 행은 `kind` 값이 고른 종류의 필드 목록을 쓴다. 판정: 수용. 해결: `unknown kind`를 필드 행 위에 두며, 그 순서를 본문이 적는다.
- R6-6: 잎이 된 경로가 유지된 상태를 유지했다. 판정: 수용. 해결: 잎 경로는 유지된 상태를 잃으며, 유지된 상태가 없는 가지는 plugin의 `expanded` 값을 받는다.
- R6-7: 요소의 주소에 역할이 없었으나 tree 노드에는 두 제어가 있다. 판정: 수용. 해결: 주소는 section id, key 경로, 역할(`label` 또는 `expand`)이다. 선언된 UI 명세와 노출 명세에 두 언어 모두 적는다.
- R6-8: 거부는 다시 그릴 값을 남기지 않으며, 방향 변경에는 출처에서의 pull이 없었다. 판정: 수용. 해결: 거부는 값을 버린다. 방향이 바뀌는 것은 규칙 2의 세 번째 pull 시점이다. 이전 방향에서 버린 값은 새 방향에서 유효할 수 있고, 그 값을 가진 것은 출처뿐이기 때문이다.
- R6-9: `value`가 `null`인 pull 응답이 정해지지 않았다. 판정: 수용. 해결: `value`가 `null`이면 출처에 아직 값이 없으며, section은 첫 push까지 비워진 채로 남는다. 이 계획의 메시지 표와 선언된 UI 명세가 그렇게 정한다.

**선언된 UI 스키마 검토 7차**

아래 이의는 [선언된 UI](../spec/declared-ui.ko.md)의 일곱 번째 적대적 검토에 대한 답변이다. 여덟 건을 모두 수용한다.

- R7-1: 6차 기록은 계획의 세 변경을 적용되었다고 보고했다. 규칙 2의 방향 pull, 메시지 표의 `null` 값, `unknown kind` 행의 순서다. 파일에는 앞의 두 가지가 없었다. 원인은 6차에서 계획의 기록을 덧붙일 때 파일을 다시 읽었는데, 그 전에 같은 차수에서 한 계획의 세 변경(R5-8 정정 포함)을 버린 것이다. 판정: 수용. 해결: 규칙 2에 방향 pull이 있고, 메시지 행은 rule 2의 load pull을 말하며, R5-8을 되살린다. 각 변경은 커밋 전에 두 언어의 검색으로 확인한다.
- R7-2: 메시지 표가 출처에 아직 값이 없을 때 `value`가 `null`이라고 말하지 않았다. 판정: 수용. 해결: `declared-ui.snapshot.request` 행의 마지막 열이 두 언어 모두 그렇게 말한다.
- R7-3: `unknown kind` 행이 종류에 따라 달라지는 행보다 위에 있지 않았다. 판정: 수용. 해결: 두 표 모두 list 항목 행보다 위에 둔다. 종류가 요소에 어떤 한도와 필드 행이 적용되는지를 정하기 때문이다.
- R7-4: 거부 행이 쓰는 `<owner>`의 소유자가 정의되지 않았다. 판정: 수용. 해결: `<owner>`는 status의 plugin id다. 거부 템플릿 옆에 정의한다.
- R7-5: 출처가 바뀌거나, 프로세스가 끝나거나, surface가 닫힐 때 status의 오류가 지워지지 않았다. 판정: 수용. 해결: 셋 모두 그 status에 `hideError`를 부르고 `error`를 null로 둔다.
- R7-6: 멱등성 문단이 다음 요청이 유지된 상태를 담는다고 적었다. 판정: 수용. 해결: 요청은 제어가 요청하는 `expanded` 값을 담으며, 이는 workbench가 그릴 때의 유지 상태와 반대다.
- R7-7: "직렬화한 값"의 길이가 정의되지 않았다. 판정: 수용. 해결: `JSON.stringify`한 값의 UTF-8 바이트 길이다.
- R7-8: 포인터가 표준과 연결되지 않았다. 판정: 수용. 해결: 포인터는 JSON Pointer(RFC 6901)다.

**선언된 UI 스키마 검토 8차**

아래 이의는 [선언된 UI](../spec/declared-ui.ko.md)의 여덟 번째 적대적 검토에 대한 답변이다. 여섯 건을 모두 수용한다.

- R8-1: 표 끝의 명령 거부 행이 규칙이 정한 `<owner>` 대신 plugin 자리 표시자를 썼다. 판정: 수용. 해결: 두 행이 두 언어 모두 `<owner>`를 쓴다.
- R8-2: pull 응답의 `seq`가 정해지지 않았고, pull의 시점이 load pull로만 적혔다. 판정: 수용. 해결: pull 응답의 `seq`는 출처의 마지막 선언된 UI snapshot의 seq이며, `value`가 `null`이면 0이다. 메시지 행은 규칙 2의 pull이 load, 출처 변경, 방향 변경 때 일어난다고 적는다.
- R8-3: `null`이 아닌 pull 응답의 검사가 정해지지 않았다. 판정: 수용. 해결: `null`이 아닌 pull 응답은 push된 선언된 UI snapshot과 같은 검사와 거부 규칙을 따른다. pull 응답 규칙과 (c) 전이에 적는다.
- R8-4: `expanded` 비교의 기준이 정해지지 않았다. 판정: 수용. 해결: 기준은 마지막으로 받아들인 값이다. 거부와 출처 변경은 기준을 없앤다. 기준이 없으면 유지된 상태가 그 상태를 가진 모든 경로에서 이긴다.
- R8-5: path의 형식이 명령과 주소에서 달랐다. 판정: 수용. 해결: `path`는 루트 요소 아래의 key들이며, tree 노드는 tree의 루트 노드에서 그 노드까지의 노드 key들이다. 주소는 section id, 요소 key, path, 역할이다. 이는 명령, 선언된 UI 명세의 주소, 노출 명세의 주소에 두 언어 모두 적용한다.
- R8-6: `kind`가 없는 요소와 문자열이 아닌 `kind`에 대한 행이 없었다. 판정: 수용. 해결: `missing kind`와 `kind must be a string` 행을 요소에 가리키게 하고 `unknown kind` 위에 두며, 두 언어 모두 그렇게 한다.

**선언된 UI 스키마 검토 9차**

아래 이의는 [선언된 UI](../spec/declared-ui.ko.md)의 아홉 번째 적대적 검토에 대한 답변이다. 세 건을 모두 수용한다.

- R9-1: load pull이 표면의 각 view와 host에 대한 pull로 적혀 있었고, 각 선언된 status에 대해 workbench가 고른 출처를 적지 않았다. 판정: 수용. 해결: load pull은 각 선언된 status에 대해 그 status의 출처로 고른 곳에서 snapshot을 한 번 요청한다. 계획의 규칙 2와 선언된 UI 명세에 적으며, 명세는 load pull이 load 때 고른 출처에서 이루어진다고도 적는다.
- R9-2: element의 주소가 요소 key, path, 역할로 적혀 있었고, 그것들을 담는 속성이 이름으로 적혀 있지 않았다. 판정: 수용. 해결: 모든 control은 루트 요소의 key를 담은 `data-key`를 가진다. list 항목과 tree 노드의 control은 루트 요소 아래의 key들의 JSON 배열인 `data-path`와 `data-role`(`label` 또는 `expand`)도 가진다. 이것들이 section id와 함께 주소를 이룬다. 선언된 UI 명세와 노출 명세에 두 언어 모두 적는다.
- R9-3: pull 응답을 snapshot이라고 부른 문장이 전체 값을 설명하는 자리에 있었고, 용어 선언된 UI snapshot이 workbench로 보내지는 메시지로 적혀 있었다. 판정: 수용. 해결: 문장은 pull 응답도 status의 전체 값을 싣지만 응답이지 선언된 UI snapshot이 아니라고 적는다. 용어는 plugin이 {plugin, status, seq, value, skipped}로 push하고 seq로 확인응답하는 snapshot이다. pull 응답은 같은 방식으로 검사한다(R8-3).

- R9-4: (c) 전이가 load 경우를 되풀이했다("메인 페이지 load 때와 load 때 고른 출처에서의 load 때"). 판정: 수용. 해결: 규칙 2는 메인 페이지 load 때, 출처가 바뀔 때, 방향이 바뀔 때만 고른 출처에서 pull을 허용하며, 다른 때는 허용하지 않는다. load 경우는 한 번만 적는다.
- R9-5: 계획의 규칙 2가 각 선언된 status의 snapshot을 한 번 요청한다고 적었으나, R9-3에 따라 pull 응답은 snapshot이 아니다. 판정: 수용. 해결: 규칙 2는 각 선언된 status의 현재 값을 그 status의 출처로 고른 곳에서 한 번 요청한다(pull)고 적는다. 계획, 선언된 UI 명세, 노출 명세, 용어 목록을 두 언어로 검색하여 pull 응답을 snapshot이라고 부르는 다른 곳을 찾지 못했다. pull 응답의 seq를 적는 곳은 출처의 마지막 snapshot의 seq를 말하며 다른 진술이다.

**선언된 UI 스키마 검토 10차**

아래 이의는 [선언된 UI](../spec/declared-ui.ko.md)의 열 번째 적대적 검토에 대한 답변이다. 네 건을 모두 수용한다.

- R10-1: status 대응에 각 선언된 status의 load pull이 적혀 있지 않았다. 판정: 수용. 해결: 메인 페이지가 load되면 workbench는 각 선언된 status의 현재 값을 그 status의 출처로 고른 곳에서 한 번 pull한다는 항목을 두 언어에 적는다.
- R10-2: 기준 없이 적용된 가지의 "새" 의미 때문에 유지된 상태가 있는 가지를 잃을 수 있었다. 판정: 수용. 해결: 가지는 기준이 있고 기준의 그 경로에 가지가 없을 때만 새 것이다. 기준이 없으면 유지된 상태가 있는 가지는 그 상태를 유지하고, 유지된 상태가 없는 가지는 plugin의 값을 받는다.
- R10-3: 노출 명세의 주소가 모든 요소에 같은 속성을 적었다. 판정: 수용. 해결: 요청은 control을 section id와 `data-key`로 지정하며, list 항목과 tree 노드의 control은 `data-path`와 `data-role`을 더한다. 두 언어에 적는다.
- R10-4: 용어 정의가 선언된 UI snapshot만 적었으나, pull 응답도 snapshot과 같은 방식으로 검사된다. 판정: 수용. 해결: 선언된 UI와 선언된 UI 값의 정의가 용어 목록에서 선언된 UI snapshot과 pull 응답을 함께 적는다.

**선언된 UI 스키마 검토 11차**

아래 이의는 [선언된 UI](../spec/declared-ui.ko.md)의 열한 번째 적대적 검토에 대한 답변이다. 다섯 건은 수용하고, 한 건은 부분 수용한다.

- R11-1: 부분 수용. 선언된 UI 명세가 계약을 계획에 기대고 있었다. 판정: 부분 수용. 해결: 명세가 자기 계약을 직접 적는다. pull 시점, 출처 순서, 사이드바 section 계층 규칙, 접근성 규칙이다. 계획은 snapshot 전달의 근거로만 참조한다. 이 계획의 승인된 계약을 명세로 옮기고, 링크를 바꾸고, 계획을 제거하는 일은 브랜치를 합치기 전에 해야 하는 항목으로 등록한다. 문서를 바꾸는 일이며 합치는 자리에서 할 일이 아니기 때문이다. 검토 기록을 어디에 둘지는 그 항목이 정한다.
- R11-2: 용어 "pull 응답"과 "유지된 상태"가 없었다. 판정: 수용. 해결: 두 용어를 용어 목록에 더한다.
- R11-3: 사이드바가 카드 표면을 여는 선언 항목만 가진다는 문장이 어휘에 없는 용어를 썼다. 판정: 수용. 해결: 사이드바는 카드 표면을 여는 명령을 가진 `button`을 가진다고 적는다.
- R11-4: 출처가 짝으로 정의되지 않았다. 판정: 수용. 해결: 출처는 프로세스와 그 프로세스의 status 등록의 짝이다. 출처가 바뀌는 것은 다른 짝이 되는 것이고, 같은 프로세스가 같은 status를 다시 등록하는 것은 바뀜이 아니다.
- R11-5: 길이가 무엇을 세는지 정해지지 않았다. 판정: 수용. 해결: 길이는 두 언어 모두 한도 표와 거부 행에서 유니코드 코드 포인트를 센다.
- R11-6: 노출 명세가 list 항목과 tree 노드의 control에 대한 문장을 되풀이했다. 판정: 수용. 해결: 두 언어에서 되풀이한 문장을 뺀다.

**선언된 UI 스키마 검토 12차**

아래 이의는 [선언된 UI](../spec/declared-ui.ko.md)의 열두 번째 적대적 검토에 대한 답변이다. 다섯 건을 모두 수용한다.

- R12-1: control의 속성이 선언된 UI 명세와 노출 명세 두 곳에서 정의되었다. 판정: 수용. 해결: 속성의 정의는 선언된 UI 명세가 한 번 가진다. 노출 명세는 그것을 가리키는 문장 하나만 두고 스스로는 정의하지 않는다.
- R12-2: 길이 규칙이 모든 길이는 코드 포인트를 센다고 하여 직렬화한 값을 구별하지 않았다. 판정: 수용. 해결: 키, 텍스트 필드, 매개변수의 모든 길이는 코드 포인트를 세고, 직렬화한 값은 UTF-8 바이트를 센다.
- R12-3: 고른 출처가 아닌 짝에서 온 snapshot의 처리가 정해지지 않았다. 판정: 수용. 해결: 확인 응답한 뒤 검사 없이 버리며, 트리, 기준, 유지된 상태, 오류 표시 중 어느 것도 바꾸지 않는다.
- R12-4: 잎 규칙과 새 가지 규칙이 기준이 있는 경우에만 적혀 있었다. 판정: 수용. 해결: 잎 경로는 기준이 있든 없든 유지된 상태를 잃는다. 새 가지는 기준이 있든 없든 plugin의 `expanded` 값을 받으며, 기준이 없으면 유지된 상태가 없는 가지가 새 가지다.
- R12-5: control의 주소가 두 곳에서 정의되었다. 판정: 수용. 해결: 선언된 UI 명세가 `data-key`, `data-path`, `data-role` 속성으로 주소를 한 번 정의하며, 노출 명세는 그것을 가리킨다.

**선언된 UI 스키마 검토 13차**

아래 이의는 [선언된 UI](../spec/declared-ui.ko.md)의 열세 번째 적대적 검토에 대한 답변이다. 여섯 건을 모두 수용한다.

- R13-1: 유지된 상태가 펼침 명령으로도, 받아들인 값으로도 설정되었고, 사용자가 명령으로만 설정한다는 말이 없었다. 판정: 수용. 해결: 사용자는 `core.declared-ui.tree.expand`로만 유지된 상태를 설정하며, 받아들인 값도 status 대응의 규칙으로 유지된 상태를 설정한다.
- R13-2: pull 응답이 순서를 어겨 도착할 수 있었고, 오래된 응답을 어떻게 할지 적히지 않았다. 판정: 수용. 해결: `seq`가 출처에서 마지막으로 받아들인 값의 `seq`보다 낮은 pull 응답은 버린다. 이 규칙은 pull 응답 규칙과 버림 규칙에 적용하며, 버림 규칙은 pull 응답을 명시한다.
- R13-3: 사이드바 문장이 button의 명령이 카드 표면을 연다고만 하고 누구의 명령인지 말하지 않았다. 판정: 수용. 해결: button의 명령은 카드 표면을 여는 plugin의 명령이다. plugin 값은 자기 명령만 이름으로 지정하므로 그 명령은 core 명령이 아니다. 용어 카드 표면은 사이드바의 `button`을 가리킨다.
- R13-4: 요소, list 항목, tree 노드가 객체가 아닐 때의 거부 행이 없었다. 판정: 수용. 해결: `<kind> must be an object` 행이 그 값을 가리키며, `missing kind` 행 위에 둔다.
- R13-5: 각 요소의 종류를 정하는 필드가 나열되지 않았다. 판정: 수용. 해결: 필드 `kind`가 각 요소의 종류를 정한다고 요소 종류 문단에 적는다.
- R13-6: plugin 프로세스 재시작에 전이와 다른 고유 규칙이 있었다. 판정: 수용. 해결: 재시작은 프로세스 종료인 전이 (d)와 새 프로세스의 등록인 전이 (a)로 처리하므로 출처 변경이며, 전이 (b)로 처리하고 유지된 상태는 경로별로 살아남는다. 고유한 재시작 규칙은 뺀다. 결과: 출처 변경이 기준을 없애므로, 재시작 뒤에는 기준이 없는 규칙대로 유지된 상태가 plugin의 값보다 이긴다.

**선언된 UI 스키마 검토 14차**

아래 이의는 [선언된 UI](../spec/declared-ui.ko.md)의 열네 번째 적대적 검토에 대한 답변이다. 여섯 건을 모두 수용하며, 각 해결은 검토자가 쓴 대로 적용한다.

- R14-1: 사이드바 문장이 뷰가 필요한 것을 section이라고 했으나, 카드 표면을 선언하는 것은 plugin이다. 판정: 수용. 해결: 뷰가 필요한 plugin은 카드 표면을 선언하고, 사이드바는 그 plugin의 명령이면서 그것을 여는 `button`을 가진다.
- R14-2: pull 응답 규칙이 `null`이 아닌 모든 pull 응답을 push된 snapshot과 같은 규칙으로 보았으나, 이는 오래된 응답을 버리는 규칙과 어긋났다. 판정: 수용. 해결: `seq`가 출처에서 마지막으로 받아들인 값의 `seq`보다 낮은 pull 응답은 검사 없이 버리며, 그 밖의 `null`이 아닌 pull 응답은 검사 규칙을 따른다.
- R14-3: `kind` 필드가 모든 요소에서 받아들여지고 나열된 필드가 아니라는 말이 없었다. 판정: 수용. 해결: `kind`는 모든 요소에서 받아들이며, 나열된 필드 가운데 하나가 아니다.
- R14-4: 객체가 아닌 요소, list 항목, tree 노드를 한 행이 덮었고 이유가 자리 표시자였다. 판정: 수용. 해결: 세 개의 문자 그대로인 행이 그것을 대신한다. `element must be an object`, `list item must be an object`, `tree node must be an object`.
- R14-5: `command`가 없는 잎과 가지의 속성이 적혀 있지 않았다. 판정: 수용. 해결: `command`가 없는 잎은 두 속성 집합을 모두 갖지 않으며, `command`가 없는 가지는 펼침 제어의 속성만 가진다.
- R14-6: 수신자 규칙이 선언된 UI snapshot만 적었으나, 이는 `null`이 아닌 모든 pull 응답에도 적용된다. 판정: 수용. 해결: 수신자는 모든 선언된 UI snapshot과 `null`이 아닌 모든 pull 응답에 규칙을 적용한다.

**선언된 UI 스키마 검토 15차**

아래 이의는 [선언된 UI](../spec/declared-ui.ko.md)의 열다섯 번째 적대적 검토에 대한 답변이다. 네 건을 모두 수용하며, 각 해결은 검토자가 쓴 대로 적용한다.

- R15-1: 기준이 없을 때의 규칙이 유지된 상태를 가진 모든 경로에서 유지된 상태가 이기게 하여, 받아들인 값에서 가지가 아닌 경로도 포함되었다. 판정: 수용. 해결: 기준이 없으면 유지된 상태가, 받아들인 값에서 가지인 경로 가운데 유지된 상태를 가진 모든 경로에서 이긴다.
- R15-2: 용어 카드 표면이 사이드바 section을 트리거로 적었으나, 그것을 선언한 plugin이 아니다. 판정: 수용. 해결: 용어는 그 plugin이 뷰가 필요할 때 사이드바의 `button`이 여는 표면이라고 적는다.
- R15-3: 상태 모듈의 등록이 선언된 UI status를 제공하지 않는다는 말이 없었다. 판정: 수용. 해결: 상태 모듈의 등록은 선언된 UI status를 제공하지 않으며, 상태 모듈만 등록하는 선언된 UI status는 출처가 없어 그 section을 비운다.
- R15-4: 재시작 규칙이 전이 (b)만 적었으나, 출처 변경은 전이 (c)에 따라 현재 값도 pull한다. 판정: 수용. 해결: 재시작은 전이 (b)와 (c)로 처리한다.

**선언된 UI 스키마 검토 16차**

아래 이의는 [선언된 UI](../spec/declared-ui.ko.md)의 열여섯 번째 적대적 검토에 대한 답변이다. 네 건을 모두 수용하며, 각 해결은 검토자가 쓴 대로 적용한다.

- R16-1: 새 가지 규칙과 잎 규칙이 기준의 경우를 두 곳에서 서로 어긋나게 적었다. 판정: 수용. 해결: 기준이 있으면 기준의 그 경로에 가지가 없을 때 가지는 새 것이다. 기준이 없으면 유지된 상태가 없는 가지가 새 것이다. 잎 규칙의 충돌하는 절은 뺀다.
- R16-2: 용어 선언된 status 출처와 기준(baseline)이 용어 목록에 없었고, 명세가 프로세스와 등록의 짝을 출처라고 썼다. 판정: 수용. 해결: 두 용어를 용어 목록에 더한다. 선언된 UI 명세의 정의 문장은 짝을 선언된 status 출처라고 쓴다. plugin 명세의 source는 그대로 둔다.
- R16-3: 선언된 UI snapshot의 정의가 한 status의 값들을 가리켰고, 한 값을 실어 나르는 메시지를 가리키지 않았다. 판정: 수용. 해결: 한 status의 선언된 UI 값 하나를 실어 나르는 메시지이며, plugin이 {plugin, status, seq, value, skipped}로 push하고 seq로 확인응답한다.
- R16-4: 루트 요소 한도가 main page의 일이 아닌 이유를 들었고, 선택된 계약 값이라는 말이 없었다. 판정: 수용. 해결: 64는 다른 한도와 같은 이유, 즉 선언된 UI snapshot 하나에 대한 main page의 일을 가진 선택된 계약 값이다. 별도 블록에 관한 이유는 뺀다. 그리기 시간 측정으로 고칠 수 있다.

**선언된 UI 스키마 검토 17차**

아래 이의는 [선언된 UI](../spec/declared-ui.ko.md)의 열일곱 번째 적대적 검토에 대한 답변이다. 세 건을 모두 수용한다. 첫 건은 이전 차수에서 조정자의 지시로 추가된 문장을 고치는 것이다.

- R17-1: 루트 요소 한도에 측정 결과로 고칠 수 있다는 문장이 있었다. 측정에 따른 수정은 명세의 나중 변경이므로, 그 문장은 계약이 아니라 미래의 편집을 적는다. 판정: 수용. 해결: 두 언어에서 그 문장을 뺀다.
- R17-2: 출처 규칙이 고정 창 사이드바의 plugin override가 적용되기 시작하거나 멈추는 경우를 말하지 않았으나, 그 경우는 출처가 읽는 카드를 바꾼다. 판정: 수용. 해결: 전이 (a)가 두 언어에서 그 경우를 적는다.
- R17-3: plugin override 개념에 용어가 없었고, 출처 문장이 정의 없이 그 말을 썼다. 판정: 수용. 해결: 용어 plugin override를 용어 목록에 더하며, 외부 사이드바 명세의 "Override context and rail border" 절을 인용한다. 그 명세가 이 개념을 이미 plugin override라고 부르므로 다른 이름은 쓰지 않는다. 출처 문장은 그 절로 연결되는 링크와 함께 용어를 쓴다. 두 언어 모두 그렇게 한다.

**선언된 UI 스키마 검토 18차**

아래 이의는 [선언된 UI](../spec/declared-ui.ko.md)의 열여덟 번째 적대적 검토에 대한 답변이다. 네 건을 모두 수용한다.

- R18-1: 노출 명세가 many 항목을 `index`로만 지정했고, 선언된 section의 control을 어떻게 지정하는지 말하지 않았다. 판정: 수용. 해결: many 항목은 `index`로, 선언된 UI가 주소를 정하는 곳에서는 주소로 지정한다. dom 요청은 DOM 이름 `core.sidebar.section.control`을 가진 요소에 대해 선택적인 `address` 객체 {section, key, path?, role?}를 받는다. 요청은 `index`나 `address` 가운데 하나만 주며, 둘 다 주면 명시적 오류로 거부한다. 이 형태의 처리기는 기능 체크리스트의 sidebar section 항목에 포함한다.
- R18-2: 기준이 마지막으로 받아들인 값으로만 정의되어, 거부나 출처 변경 뒤의 기준이 정해지지 않았다. 판정: 수용. 해결: 기준은 마지막 거부나 출처 변경 이후에 받아들인 마지막 값이다. 명세와 용어 목록에 같이 적는다.
- R18-3: 거부 순서 규칙이 값이 어기는 첫 행을 말했으나, 값은 한 행을 여러 곳에서 어길 수 있다. 판정: 수용. 해결: 값의 어느 부분이라도 어기는 표의 순서에서 첫 행이 적용되며, 그 행이 여럿이면 문서 순서에서 첫 번째를 보고한다.
- R18-4: 외부 사이드바 명세로의 한국어 링크가 영어 제목의 앵커를 가리켰다. 판정: 수용. 해결: 링크는 한국어 파일의 한국어 제목 앵커를 쓰며, 문서 검사의 링크 검사가 그것을 해석한다.

**선언된 UI 스키마 검토 19차**

아래 이의는 [선언된 UI](../spec/declared-ui.ko.md)의 열아홉 번째 적대적 검토에 대한 답변이다. 여섯 건을 모두 수용한다.

- R19-1: control의 주소가 section id, key, 역할로만 유일했고, section을 가진 사이드바는 그 일부가 아니었다. 판정: 수용. 해결: 주소는 `{sidebar, section, key, path?, role?}`이며, `sidebar`는 `core.sidebars`가 보고하는 사이드바 인스턴스다. list 항목이나 tree 노드의 control에는 `path`와 `role`이 필수이고, button에는 허용하지 않는다. 이 필드들로 어떤 주소도 둘 이상의 control과 맞지 않는다. 검사 결과 `core.sidebar.section.control`은 이미 `many`로 선언되어 있다.
- R19-2: 오류 표에 어느 control과도 맞지 않는 주소의 코드가 없었고, -32602로 거부하는 요청을 적지 않았다. 판정: 수용. 해결: `index`와 `address`를 둘 다 준 경우, 타입이 틀린 경우, 허용되지 않거나 빠진 `path`나 `role`은 -32602를 돌려주고, 어느 control과도 맞지 않는 주소는 새 코드 1009를 돌려준다. 타입을 적는다. `path`는 문자열 배열이고, `role`은 `label` 또는 `expand`다.
- R19-3: 타입이 틀린 행이 없는 필드도 다루었다. 판정: 수용. 해결: 없는 필드는 `missing <field>`이고, `<field> must be <type>`은 있는 필드에만 적용한다.
- R19-4: 매개변수 값의 이유가 유한한 숫자를 적지 않았다. 판정: 수용. 해결: 이유는 `params values must be string, finite number, boolean or null`이다.
- R19-5: 이유에 넣는 이름과 값의 형식이 정해지지 않았다. 판정: 수용. 해결: JSON 문자열로 쓰고 제어 문자를 이스케이프하며, 잘린 값이 128 코드 포인트가 되도록 자른다. 마지막 코드 포인트는 표지 `…`(U+2026)다.
- R19-6: 노출 명세의 메인 페이지 요청이 응답하기 전에 주소를 검증한다는 것과, 호스트가 그 요청을 읽지 않고 중계한다는 것을 적지 않았다. 판정: 수용. 해결: 메인 페이지는 `core.sidebar.section.control` 요청에 응답하기 전에 `index`나 `address`를 검증하며, 호스트는 그 요청을 읽지 않고 중계한다.

- R19-7: 덧붙인 문장, 즉 DOM 항목이 `many`로 선언되어 어떤 주소도 둘 이상의 control과 맞지 않는다는 문장은 잘못된 이유를 들었다. `many`는 여러 요소가 이름을 공유한다는 뜻이며 주소를 유일하게 만들지 않기 때문이다. 판정: 수용. 해결: 유일성은 필드에서 나온다. 한 사이드바 인스턴스는 section을 한 번 그리고, 키는 형제 사이에서 유일하며, path와 역할이 control 하나를 정한다. `many` 선언은 여러 요소가 이름을 공유한다는 이유와 함께 사실로만 남는다.
