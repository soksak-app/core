# Plugin 프로세스

[English](plugin-processes.md)

이 명세는 plugin 코드가 어디에서 실행되고 그 프로세스들이 어떻게 통신하는지 정한다. plugin의 층, plugin view의 통과값, declared UI snapshot, 프로세스 경계를 넘는 호출, view의 origin과 core root, 재시작, 표시, 입력, 테마, 메시지와 event, core와 plugin의 경계, view의 프로세스 배정, binary 경로, plugin host, plugin의 신원, view의 context를 다룬다. [선언 UI](declared-ui.ko.md)는 선언 UI schema를, [native surfaces](native-surfaces.ko.md#view-표면)는 view channel과 view의 배치를, [plugin](plugins.ko.md)은 manifest를 정한다.

## 결정

Plugin 코드는 workbench 페이지 밖에서 실행된다. 각 plugin view는 `soksak://<plugin id>` origin의 별도 웹뷰이며 탭마다 하나다. 선언 UI는 plugin이 보내는 [declared UI snapshot](native-surfaces.ko.md#view-표면)으로 workbench가 그린다. plugin host는 plugin의 view가 하나도 열려 있지 않은 동안 제공해야 하는 sidebar section의 선언 status가 있을 때만 존재한다([declared status](declared-ui.ko.md#선언된-status)).

측정은 이 결정을 뒤집지 않는다. 측정은 프로세스 수, plugin별 예산, 통과값을 정한다. 통과값을 만족하지 못하면 설계를 다시 연다. workbench 페이지에 plugin surface를 mount하는 방식으로 돌아가지 않는다.

## 운영체제 표시 이름

Plugin view의 WebContent process는 `soksak://plugin/<plugin id>` 표시 이름을 사용한다. 이 이름은 view의 WebKit process configuration에 설정하며, 분리된 `soksak://<plugin id>` origin을 바꾸거나 접근 권한을 주거나 요청을 라우팅하지 않는다. Plugin 식별자는 view 선언에서 가져온다. 이 private WebKit 설정은 configuration별이므로 식별자가 다른 plugin의 configuration은 WebContent process를 공유하면 안 된다. 한 process에는 표시 이름 하나만 설정할 수 있기 때문이다.

## 근거

- 메모리: WebKit은 마지막 수집 이후 할당된 바이트에 비례해 전체 JavaScript 수집을 미룬다(`heap/GCActivityCallback.cpp`의 `didAllocate`). workbench 페이지의 plugin 코드는 workbench와 같은 힙에 할당하므로, plugin 하나의 할당은 workbench의 쓰레기 수집도 미룬다. 이 지연을 줄이는 공개 API는 없다.
- 교체된 문서는 메모리 압박 전까지 `querySelectorAll` 결과 cache에 남는다.
- 새로 시작한 release build의 메인 페이지 프로세스는 약 70 MB였다. 재로드 뒤 메인 페이지 프로세스는 446.6 MB(Wails)와 399.9 MB(Tauri)였다.
- 숨은 browser tab 하나를 닫자 227 MB가 돌아왔다.
- 문서마다 새 프로세스를 띄우자 이동 시간이 0.6초에서 1.1초로 늘었고, 그 정책은 되돌렸다.
- 장애 격리와 측정 단위: plugin의 장애, 메모리, 측정은 그 plugin의 프로세스에 속한다.

## 층 규칙

- **선언 UI:** 요소가 모두 목록, tree, 버튼, 상태줄 가운데 하나인 사이드바 section이 선언 UI다.
- **view:** 그 밖의 화면은 view다. 인라인 이름 바꾸기가 필요한 tree, 끌어 놓기가 있는 tree, 포인터 위치에 놓는 문맥 메뉴가 있는 tree는 view다. view는 자유 DOM, IME가 필요한 글 입력, canvas나 편집기, document region 또는 image region을 담은 화면을 맡는다.
- **sidebar section:** 선언 UI만 sidebar section이 될 수 있다. 열린 view가 없는 동안에도 sidebar section이 값을 보여야 하는 plugin은 [plugin host](#plugin-host)가 필요하다. view가 필요한 section은 card 표면이 되고, sidebar에는 그것을 여는 선언 항목만 둔다. `core.declared-ui.tree.expand` 명령은 그 처리기와 함께 `packages/workbench/exposure.json`에 선언한다.
- **plugin host:** plugin의 view가 하나도 열려 있지 않은 동안 sidebar section의 선언 status를 제공해야 할 때만 만든다. sidecar는 한 domain의 native 기능을 갖고 view는 그 탭이 열려 있는 동안만 있으므로, host는 plugin의 sidecar가 주는 데이터로 그 status들의 선언 값을 만들어 제공하고, plugin의 sidecar 메시지와 명령 요청을 중계한다. 선언 status의 presentation은 host 자신의 로직이다. host는 native 로직을 갖지 않으며, sidecar는 데이터만 준다.
- 화면의 층은 측정으로 정하지 않는다.

## 통과값

각 값은 행에 적힌 측정으로, 애플리케이션 안에서 도는 timer가 아니라 녹화에서 판정한다. 메모리 값은 SI megabyte를 사용하며 1 MB는 1,000,000 bytes다. 회수 측정은 process를 공유하는 전체 group과 그 group의 모든 view를 닫기 직전 physical footprint를 기록한다. 닫은 뒤 같은 process identity를 비교하며 종료한 process는 0으로 센다. View를 열기 전 baseline을 빼지 않는다. Group은 root view와 연결된 모든 native document-region process를 포함하며 포함한 process를 공유하는 모든 surface로 확장한다. 기록은 닫은 각 view의 root와 연결된 각 document region의 session history에 초기 document만 있음을 입증한다.

| 기준 | 통과 조건 |
|---|---|
| (i) 합계 | 한 plugin의 view N개의 합계 footprint가 view 1개 footprint의 N배 + 10 MB 이하다. |
| (ii) 회수 | 다른 view와 프로세스를 함께 쓰지 않는 view에 적용한다. 함께 쓰는 view는 그 view들과 한 단위로 잰다. 세션 기록이 초기 문서 하나뿐인 상태로 열고 닫은 view를 닫으면, 그 footprint의 90% 이상이 10초 안에 돌아온다(3회 반복). 엔진 cache가 붙잡은 프로세스는 돌아오지 않은 것으로 센다. |
| (iii) 첫 표시 | 프로세스가 이미 실행 중인 view의 첫 표시: view 시작 요청부터 녹화에서 첫 내용 frame까지의 시간이, 같은 plugin과 host의 DOM mount 기준값 + 300 ms 이하다. DOM mount 기준값은 mount를 제거하기 전 표면 mount의 측정이 그 plugin과 host에 대해 기록한 중앙값이다(wailsv3와 tauriv2: browser 13과 22 ms, editor 13과 35 ms, hwp 701과 813 ms, terminal 17과 23 ms). 기준값이 잰 표면 mount는 제거되었으므로 그 기록이 고정 기준값이다. 기록된 값은 mount의 시작부터 끝까지의 시간이며 첫 내용 frame보다 늦지 않으므로, 녹화로 잰 기준값보다 기준이 엄격하거나 같다. 기록값이 없는 plugin(files, shell, flowmark)은 300 ms만으로 판정한다. |
| (iii-b) 새 프로세스의 첫 표시 | 새 프로세스의 첫 표시: (view 시작 요청부터 녹화에서 첫 내용 frame까지의 시간) − (프로세스 시작 시간 5회 중앙값, 각각은 프로세스 요청(`host.trace.view.process-request`)부터 view가 page 런타임을 시작할 때 쓰는 첫 `host.trace.view.process-ready`까지의 시간)이 DOM mount 기준값 + 300 ms 이하다(3회 반복, 성능 trace를 켠 상태로 잰다). |
| (v) 표시 판정값 | card 배치가 바뀐 녹화에서, view의 내용 frame이 그 변경의 첫 frame부터 100 ms 안에 새 크기로 나타난다. |
| (vi) 재시작 한도 | 실패 event가 올 때 실패 시각을 기록하고 그 자리에서 센다(timer를 쓰지 않는다). 최근 300초 안의 실패가 4번째에 이르면 재시작을 멈춘다. 300초보다 오래된 실패는 세지 않는다(sliding window). 멈춘 뒤에도 실패 기록은 남긴다. 그 프로세스가 필요한 표면을 사용자가 열 때만 기록을 비우고 프로세스를 다시 띄운다. |
| (iv) editor 측정 | editor view의 footprint와 숨긴 DOM editor의 footprint를 잰다. view 쪽 footprint가 50 MB를 넘으면 editor의 buffer와 분석을 sidecar로 옮긴다. 이것은 통과 조건이 아니라 측정 규칙이다. |
| (viii) 끌기 | gesture 동안 (a) 매 frame에서 native content 경계와 card 및 독립적으로 선언된 DOM inset으로 구한 예상 composition slot 경계의 차이가 2 pt 이하다(같은 commit, 기대값 0). (b) 내용 frame(view가 자기 document에 그린 frame이며, view의 ResizeObserver 다음 requestAnimationFrame이 내는 표시)의 연속 간격이 33 ms 이하다. (c) 내용 frame 크기가 native frame 크기와 다른 상태가 gesture 끝난 뒤 2 frame(33 ms) 안에 사라진다. |

모든 plugin view는 (i), (ii), (iii), (iii-b), (v), (viii)을 만족하고, 재시작 창 검사는 (vi)을 만족한다. (iv)는 잰다. 기구 값 (v), (vi), (viii)이 실패하면 그 기구에 기대는 일을 멈춘다. plugin 값 (i), (ii), (iii), (iii-b)가 실패하면 그 plugin만 멈추고, 그 plugin의 층이나 view 수는 adversarial review에 올리는 이 명세의 개정판에서 다시 연다. 개정 결정은 소유자가 한다.

기준 (iii)은 열린 view가 시작 요청 직전에 이미 실행 중인 process에 배정된 경우에만 적용한다. 측정은 요청 전 process snapshot과 배정된 view process를 기록한다. 새 process에 배정된 열기는 (iii)을 통과가 아닌 해당 없음으로 보고하고 (iii-b)로 측정하며 process 재사용을 강제하지 않는다. 녹화한 pixel은 (viii)(a)의 표시 정렬을 입증하고 소유 layout transaction 검사는 card와 native 배치의 연결을 별도로 입증한다. 캡처 frame은 인과적 commit identifier를 입증하지 않는다.

Viewport geometry는 실제 native document에서 명시적으로 시작한 diagnostic viewport marker를 사용할 수 있다. Overlay는 투명 배경, 고유한 불투명 border, viewport 기준 fixed 배치와 pointer 처리 없음을 유지하며 기존 layout node나 document 크기를 바꾸지 않는다. 측정은 먼저 visual viewport scale 1, viewport offset 0, 예약된 scrollbar gutter 없음과 변형된 fixed-position containing block 없음을 검증한다. 캡처한 border pixel로 네 viewport 경계를 독립적으로 선언된 slot 및 기존 2 pt 기준과 비교하며 보고된 host·DOM rectangle로 해당 pixel을 대체하지 않는다. 중지·dispose·시작 실패 시 overlay를 제거한다. 이 근거는 marker-assisted viewport geometry로 표시하며 자연 content 범위, source-frame identity나 정상 paint cadence를 입증하지 않는다. Document element는 content와 함께 커질 수 있어 그 border만으로는 부족하고, 관련 없는 card control이 같은 pixel predicate에 포함되면 foreground segmentation도 부족하다.

## 규칙

1. workbench 페이지에서는 plugin 코드를 실행하지 않는다.
2. **Declared UI snapshot.** plugin view나 plugin host는 declared UI snapshot을 workbench로 보낸다(push). 메인 페이지가 load될 때(reload 포함) workbench는 각 선언된 status의 현재 값을 그 status의 출처로 고른 곳에서 한 번 요청한다(pull). 상태의 출처가 바뀌면 workbench는 그 status의 현재 값을 한 번 pull한다. 실행 중인 view는 마지막 값을 새 독자에게 보낼 다른 수단이 없다. 다른 pull은 없다. 메시지의 이름과 field는 [메시지와 event](#메시지와-event)에 적는다.
   - status 하나에는 전송 중인 snapshot이 최대 1개다.
   - window ingress receiver 하나가 section recipient 수와 관계없이 pushed snapshot마다 한 번 검사하고 확인 응답한다. 일치하는 section이 mount되지 않은 snapshot도 확인 응답한 뒤 버리므로, mount되지 않은 status가 sender의 전송 중 슬롯을 유지하지 않는다. 출처와 status routing은 [선언된 UI](declared-ui.ko.md#status-대응)에 정의한다.
   - 전송 중에 생긴 변경은 dirty로 표시한다. 확인(ack)이 오면 최신 값을 담아 다음 snapshot을 보낸다.
   - 건너뛴 값의 수는 core status `core.plugin.losses`의 `losses.skipped`로 센다. 이 수는 각 snapshot message의 필드 `skipped`로 메인 페이지에 닿는다. 전송 중에 덮어쓴 값의 수이며, status의 이전 snapshot이 보내진 뒤의 수다. 성능 trace가 켜져 있으면 메인 페이지는 덮어쓴 값마다 `page.trace.declared-ui.snapshot.skipped {plugin, status, count}`를 쓴다. host는 snapshot을 중계하지 않으며 이 경우 event를 쓰지 않는다. `host.*` event는 host 코드만 쓰기 때문이다.
   - plugin 프로세스가 (다시) 시작하면 그 프로세스의 첫 snapshot이 각 status의 전체 값이다. workbench는 이전 프로세스의 멈춘 snapshot과 확인 대기를 버린다. 다시 시작한 plugin은 저장한 state에서 값을 만들어 보낸다(규칙 5).
   - 확인을 기다리는 동안 view 프로세스가 끝나거나 표면이 닫히면, 값은 `losses.stalled`로 세고 event는 쓰지 않는다. receiver는 각 snapshot을 즉시 확인하므로 확인을 기다리는 것은 view 안의 sender뿐이다. 기다리는 sender는 view 프로세스와 함께 끝나고, 표면이 닫히는 것도 view를 끝낸다. 따라서 이를 관찰하는 live 관찰자가 없으며, 규칙 2가 다시 시작한 프로세스에 대해 말하는 대로 다음 프로세스는 전체 값을 보낸다. 다시 시작한 프로세스는 첫 snapshot으로 각 status의 최신 값을 보내고 dirty 표시를 지운다. 표면이 닫힌 것이면 dirty 값은 버리고 그 사실을 reason에 적는다. timer는 쓰지 않는다.
3. **경계를 넘는 호출.**
   - 명령은 [exposure](exposure.ko.md)에 적힌 대로 `timeout`을 선언한다(최대 600000 ms, 없으면 10초). timer는 살아 있는 상대가 명령에 답하지 않는 경우에만 남긴다. 느린 명령 답을 알려 주는 event가 없기 때문이다. `host.trace.view.unresponsive`는 WebKit의 응답성 검사에 답하지 않는 view 프로세스를 알리며, 명령 답이 아니므로 timer를 대신하지 않는다. 기한을 넘기면 호출을 -32000과 `command <name> did not reply within <ms>ms`로 거부한다. 이 오류는 [exposure](exposure.ko.md)의 명령 `timeout` 항목이 적는 것이며, 이 설계는 메시지를 바꾸지 않는다. `host.call.timeout {plugin, command}`를 쓰고 `losses.timeouts`를 센다.
   - view는 메인 page의 요청에 자기 command로 답할 때 `{sok: 1, reply: id, result}` 또는 `{sok: 1, reply: id, error}`를 보내며, 호스트는 이를 `view-reply`로 전달한다([native surface](native-surfaces.ko.md#view-표면), view command). 메인 page는 그 요청에 command가 선언한 제한 시간을 적용하며, 제한 시간 뒤의 응답은 늦은 응답으로 버린다.
   - 상대가 사라지면 기한 전에 event로 호출을 끝낸다. 호출을 끝내는 상대는 view나 host 프로세스의 종료, 표면 닫기, sidecar 종료다. promise는 그 이유를 밝힌 오류로 거부한다. reason은 `process-ended`, `surface-closed`, `sidecar-ended` 중 하나다. `process-ended`는 view가 열어 둔 call(메인 page가 답하지 않은 call)을 끝내며 `host.call.peer-lost {plugin, command, reason}`을 쓰고, `surface-closed`는 event를 쓰지 않으며 `losses.peerLost`를 센다. sidecar 종료는 sidecar 실패 계약이 알린다. 응답을 기다리는 식별자 있는 요청마다 surface, sidecar, 식별자를 밝힌 `host.sidecar.reply` 오류가 쓰이고, sidecar에 보낸 각 surface는 `sidecar-failure`를 받는다. host가 멈추거나 떼어내면 기다리는 요청마다 같은 오류를 쓴다. sidecar 요청은 command를 갖지 않으므로 그 경우에 `host.call.peer-lost`는 쓰지 않는다. `host.trace.view.unresponsive`는 호출을 끝내지 않는다. 이 event는 규칙 6의 presentation wait와 view의 status에서만 쓴다. 호출은 선언한 timeout이나 이 상대들 가운데 하나로만 끝난다.
   - 끝난 호출에 늦게 온 답은 버린다. promise에 전달하지 않으며, 답을 보낸 문서에 오류를 보내지도 않는다. 호스트는 `host.trace.call.late-reply {plugin, command, delay}`를 쓰고 `losses.lateReplies`를 센다. host-contract case `exposure-reply.removed-surface-discarded`와 `exposure.relay.foreign-document-reply-ignored-timeout-1005`가 이 동작을 명시한다.
   - 열린 호출 수(확인을 기다리는 snapshot 포함)와 가장 오래된 열린 호출의 시작 시각을 core status `core.plugin.open-calls {plugin, count, oldestStartedAt}`로 노출한다.
   - relay timeout은 exposure의 제품 동작이다. 두 경로가 있다. 호스트는 surface page로 보낸 명령에 timeout을 적용하고, 메인 페이지는 자기가 직접 실행하는 handler에 timeout을 적용한다([exposure](exposure.ko.md), 명령 `timeout`). exposure.md는 두 경로를 이미 적고 있다(명령 timeout 항목과 relay 절).
   - 취소는 호출 envelope의 일부다. 호출은 `id`를 가지고, 응답은 같은 `id`로 결과나 오류를 담고, 취소는 `id`를 가진다. binary payload는 [binary 경로](#binary-경로)를 쓴다.
4. **Origin과 core root.**
   - 각 plugin HTML은 `soksak://<plugin id>`의 별도 웹뷰에서 돈다. 요청의 plugin id는 요청이 아니라 view 구성에서 온다.
   - core root는 plugin id로 쓸 수 없는 예약 host `core`다. `validateManifest`가 그 이름을 거부한다.
   - core root는 plugin A의 view에 다음 파일만 제공한다. 그 밖의 경로는 모두 not found로 답한다.
     - core 대상은 `index.js`, `view.js`, `soksak/dist/index.js`의 import closure가 닿는 `@soksak/plugin-api`와 `soksak`의 파일이며, 각각 `soksak://core/modules/<package>/<file>`에서 제공한다. 이들은 plugin 내용이 없는 core 파일이므로 패키지가 이름을 붙인 파일에서 제공하며, closure 시험이 그 집합을 계산하고 view import가 허가되지 않으면 실패한다;
     - plugin B의 granted item 가운데 A의 확장점에 대한 항목의 module: `soksak://core/modules/<B package>/<module path>`. `<module path>`는 그 항목의 `module`이다;
     - A의 `extends.<point>.modules`가 대응하는 각 파일: `soksak://core/shared/<A id>.<point>/<specifier>.js`. Contributor 연결 여부와 무관하다;
     - A가 provider point의 version을 포함하는 range-compatible granted item을 기여할 때 provider의 `extends.<point>.modules`가 대응한 파일: `soksak://core/shared/<provider id>.<point>/<specifier>.js`.
   - 기여 항목은 제공자가 설치되고 켜져 있으며 `range`가 확장점의 `version`을 담고 `schema`에 맞을 때 연결된 항목이다(workbench 상태). granted item은 제공자가 설치되고 켜져 있으며 `range`가 확장점의 `version`을 담을 때 성립하며, 범위 판정은 두 호스트가 이미 쓰는 설치 라이브러리의 range parser로 한다. Core root는 cross-plugin 파일에만 granted item 규칙으로 grant하며 `schema`를 확인하지 않는다. `schema`에 맞지 않는 항목은 workbench(`core.contributions`)가 `invalid`로 보고하며 가져오지 않는다. 그 항목의 선언된 module 파일도 grant되며, 이 over-grant는 기여자가 자기 manifest에 선언한 파일로 한정되고 이 명세가 이를 밝힌다. Provider page는 자기 `extends.<point>.modules`가 대응한 파일만 받으며 이를 다른 plugin에 허용하지 않는다. 이로써 provider import 규칙과 cross-plugin granted-item 규칙의 모순을 해소하면서 임의 requester에 대한 권한 확장은 방지한다. 두 호스트가 granted item 규칙을 적용한다. Provider가 해당 point의 `extends`를 선언하지 않거나 `version`이 없는 항목은 grant하지 않는다. Provider가 설치되지 않았거나 켜져 있지 않은 경우와 `module` 경로가 contributor 패키지 파일로 적혀 있지 않은 경우도 grant하지 않는다. `dependencies` 항목은 어떤 파일도 허용하지 않는다.
   - view import map은 항목이 정확히 다섯 개다: `soksak`, `@soksak/plugin-api`, `@soksak/plugin-api/view`, `@soksak/plugin-api/screen-hash`, 그리고 `soksak://core/shared/`에 대응하는 `@soksak/shared/`. plugin-api 항목은 plugin-api가 페이지용으로 내보내는 browser module이다(export 목록의 `view`와 `screen-hash`). view 페이지가 plugin-api의 browser module이 필요하면 이 map에서 import하며, plugin은 core 코드를 복사해 도달하지 않는다. 시험이 plugin-api 항목을 패키지의 export 목록과 대조한다. `@soksak/runtime`과 `@soksak/workbench/` 항목은 없다. map은 `@soksak/plugin-api`가 내보내는 상수 `VIEW_IMPORTS` 하나이다. 호스트가 각 view 페이지에 map을 넣는다. staging 도구가 `VIEW_IMPORTS`를 staged frontend의 `view-imports.json`으로 쓰고, 각 호스트는 시작할 때 그 텍스트를 native view handler에 설정하며, handler는 그 텍스트를 view 구성 페이지의 doctype 바로 뒤, 다른 태그 앞에 넣는다. doctype으로 시작하지 않거나 자기 import map을 가진 view 페이지는 거부된다. handler는 `error: document view: view page <URL>: <reason>`을 application log에 쓰고 페이지는 적재되지 않는다. 제공되는 page의 `Content-Length`는 삽입 뒤의 길이이며, 제공된 view 페이지마다 주소와 map 텍스트의 SHA-256을 담은 `info` 기록 하나를 쓴다. `@soksak/plugin-api`는 `checkViewPage(html)`을 제공하고 plugin의 build가 이것으로 page를 검사하며, closure 시험이 view 페이지의 모든 import가 항목 가운데 하나로 해석되는지 확인한다.
   - 페이지 검사는 map을 다섯 항목과 비교하며 module을 읽지 않는다. module graph 규칙(`checkViewModules`, `@soksak/plugin-api`의 `./view-modules` export)은 페이지가 불러오는 각 module의 import를 진입점부터 es-module-lexer(`es-module-lexer/js`)로 읽는다. 이 lexer는 코드를 어휘 분석하므로 문자열 리터럴과 주석의 텍스트를 건너뛴다. 상대 import는 페이지의 module을 가리켜야 하고, 정적 import, 재-export, 리터럴 specifier의 동적 import 중 상대 형식이 아닌 것은 다섯 항목 중 하나여야 한다. 리터럴이 아닌 specifier의 동적 import는 읽지 않는다. 그 밖의 것은 import하는 module과 specifier를 밝히는 오류이며, 그런 specifier는 어떤 module도 실행되기 전에 module graph 전체를 멈추기 때문이다. lexer가 import를 거부하는 module은 그 module을 밝히는 오류이다. 이 규칙은 `@soksak/plugin-api` index의 export가 아니다. view page는 index를 불러오고 lexer는 page가 불러올 수 없는 dependency이기 때문이다.
   - view bridge `@soksak/plugin-api/view`는 파일 `packages/plugin-api/view.js`다. `runtime/`이나 `@soksak/workbench/` 아래의 것을 import하지 않으며, view 쪽 call layer(`calls.js`)와 선언 UI snapshot(`snapshots.js`)을 view 통로로 내보낸다.
   - view channel은 host가 각 view 구성에 주입하는 document-start script이며, 규칙 8의 테마 script와 같다. host 계약이 이름을 정한 message handler `sok-view`를 하나 정의한다. native/darwin은 두 호스트 모두에 대해 handler `sok-view`와 주입 script를 view의 web view 구성에 등록하며, host 계약이 handler 이름을 선언한다. host가 메시지를 view로 보내는 방식은 현재 문서 영역이 받는 방식과 같다: native 코드가 view의 page world에서 `window.postMessage(message, location.origin)`을 실행하며(`sp_document_post`의 형식). 주입된 document-start script는 document 시작 시점에, 어떤 page script보다 먼저 view의 `message` listener를 추가하고, source가 window인 message event를 `createViewChannel()`이 `onMessage`의 handler를 붙이기 전까지 queue에 보관한다. queue는 최대 256개 message를 담고, 호스트 계약에 계약 case와 함께 선언한다. queue가 찬 상태에서 message가 오면 script는 `sok-view` handler로 application log에 `error: view channel: queue full for <plugin>`을 쓰고, 호스트는 view 프로세스를 끝내서, 어떤 호스트 message도 조용히 버리지 않는다. 이 상한은 잰 값이 아니라 정한 값이다. view는 첫 module이 돌 때 통로를 붙이므로 queue는 그 전에 보낸 message만 담는다. `createViewChannel()`은 queue의 message를 순서대로, 이어서 들어오는 message를 모두 넘긴다. host message는 버리지 않는다. 주입된 document-start script는 script가 만든 문서 식별자를 담은 ready message를 `sok-view` handler로 보낸다. 호스트는 view마다 현재 문서의 식별자를 기록하고, ready message를 기록한 문서에만 호스트 message를 보낸다. ready message가 기록되지 않은 view로의 post는 false를 돌려주고, 호출한 쪽은 application log에 `error: view channel: <view> has no ready document`를 쓴다. navigation은 새 문서의 ready message가 올 때까지 기록한 식별자를 지운다. queue는 한 document의 message를 담으며, `core.plugin.views`는 `queued`를 보고하며, 이는 view가 attach하지 않아 queue에서 기다리는 message의 수다. 그래서 attach하지 않는 view가 보인다. host는 host message마다 `sok: 1` field를 붙이며, channel은 이 field가 없는 message를 application log에 error로 기록하고 어떤 handler에도 넘기지 않는다. 주입 script는 전역 `sokView` 하나를 더하며, 그 `attach`가 host 메시지를 읽는 유일한 방법이다. script는 `packages/plugin-api/view-start.js`다. handler 이름과 전달 형식은 host 계약에 선언한다. `@soksak/plugin-api/view`는 `createViewChannel()`을 내보내며, 이 함수는 그 handler 위의 `{send, onMessage}`를 돌려주고 이를 `createCalls`와 `createSnapshotSender`에 넘긴다. handler 이름과 주입 script는 host 계약에 선언하고 계약 case를 둔다.
   - 기여 module과 공용 module은 각각 자체완결 ES module 하나다. 그 안의 상대 import는 그 plugin의 빌드 오류이며, 그 plugin 저장소가 검사한다([경계](#경계-결합-금지)). 기여 module과 공용 module은 view import map의 항목에서만 bare specifier를 import한다. 그 밖의 bare specifier는 소유 plugin의 빌드 오류다.
   - core root는 애플리케이션 frontend로 넘기지 않는다. view는 `/runtime/` 경로를 받지 않으며, `/start.json`, `/environment.json`, `/index.html`, `/runtime/...`과 위에 없는 그 밖의 경로는 모두 not found다.
   - view에 보내는 모든 응답은 view 구성의 plugin id로 `Access-Control-Allow-Origin: soksak://<plugin id>`를 담는다. 요청의 `Origin`이나 `*`는 담지 않는다. 거부한 요청은 이 header를 담지 않는다. WebKit 측정(`native/darwin/tests/core_root_cors_test.m`의 시험 `core_root_cors_test`, macOS 26.6.2 arm64): `soksak://probe` page에서 `soksak://core/m.js`로의 module import는 `Origin: soksak://probe`를 보낸다. 응답이 `Access-Control-Allow-Origin: soksak://probe`를 담으면 import가 성공하며, 같은 module로 매핑하는 import map의 bare specifier도 이 header에서 성공한다. `Access-Control-Allow-Origin`이 없거나 `Access-Control-Allow-Origin: soksak://other`이면 import가 실패하고, CORS 거부를 알리는 TypeError가 난다. 이 절의 header 규칙은 시험이 단언하는 계약이다. WebKit은 `*`도 받아들이지만, 이 규칙은 `*`를 계속 보내지 않는다.
   - Rule 4가 허용하지 않은 plugin B의 파일 요청은 not found로 답하고, 두 호스트 모두 `error: core root: <path> is not granted to <plugin>`을 쓴다. 문서 영역은 core root grant를 받지 않는다.
   - core root는 host 계약이 선언하고 각 호스트가 scheme handler에 등록하는 callback으로 제공하며, 계약 case를 둔다.
   - plugin A의 view가 Rule 4에 따라 허용되지 않은 plugin B의 파일, A가 `dependencies`로 지정한 plugin의 파일, `/start.json`, `/environment.json`, `/index.html`, `/runtime/...`, 그리고 provider가 그 확장점을 선언하지 않은 기여 항목의 파일을 요청하면 각각 not found로 답한다.
5. **재시작.** sidecar, plugin host와 view 프로세스는 통과값 (vi)의 한도 안에서 다시 띄운다. 한도를 넘으면 호스트는 `error:`를 보고하고 멈춘다.
   - 끝난 view 프로세스는 호스트가 다시 만들고, 새 view는 저장된 탭 상태에서 상태를 복원한다. 한도는 view 표면마다 센다. 한도를 넘으면 card가 표시 경로로 오류를 보여 주며, 사용자가 탭을 다시 열 때에만 view를 다시 만든다.
   - 한도를 넘은 뒤의 다음 요청은 프로세스를 띄우지 않고 `sidecar-failure`(reason `restart limit`)로 실패한다. 실패 기록은 남긴다. 그 프로세스가 필요한 표면을 사용자가 열 때만 기록을 비우고 프로세스를 띄우며, 호스트는 `host.trace.sidecar.restart-reset {sidecar, surface}`를 쓴다. plugin host는 `host.trace.plugin-host.restart-reset {plugin}`을 쓴다.
   - 표준 입출력 sidecar의 재시작 한도는 [sidecars](sidecars.ko.md#실패)에, persistent service의 재시작 규칙은 [persistent services](persistent-services.ko.md)에 적는다.
   - 다시 띄우면 state는 마지막으로 저장한 값에서 복원한다. 저장하지 않은 state는 잃으며, plugin마다 어떤 state인지 밝힌다.
   - 고장 주입은 진단 build에서만 둔다.
6. **표시.** plugin view는 card 배치가 바뀐 뒤(gesture의 첫 변경)의 첫 표시에만 presentation wait에 참여한다.
   - 계속되는 gesture(구분선이나 card 끌기) 동안 view의 native frame은 매 frame card와 같은 commit에서 새 기하로 놓는다. 내용 그리기를 기다리는 것은 첫 변경에서만 한다. 그 뒤 내용은 늦게 그려질 수 있으며, 그 늦음은 frame 간격으로 잰다.
   - 끌기 gesture 전체의 녹화에서 frame 간격과 기하 오차를 얻고, 통과값 (viii)로 판정한다.
   - 기다림은 다음 가운데 먼저 오는 것으로 끝난다: view의 presentation 완료, view 프로세스 종료, 변경이 끝났을 때 그 view가 보이지 않음(`hidden` 조상, 선택되지 않은 탭, 닫힌 표면. workbench가 표면마다 이미 알리는 상태를 읽는다), `host.trace.view.unresponsive`의 응답 없음 알림. presentation 완료가 아닌 것으로 끝나면 그 view 없이 commit을 진행하고 `host.trace.view.presentation-abandoned {surface, reason}`을 쓰고 `losses.abandoned`를 센다. host가 쓰는 이유는 wait를 host가 소유하기 때문이다. host가 commit을 하고 각 끝을 보기 때문이다. timer는 쓰지 않는다.
   - 통과값 (v)는 실행 중 기한이 아니다. 각 view의 측정이 적용하는 판정값이다.
   - [native surfaces](native-surfaces.ko.md)가 창 transaction의 presentation wait를 적는다.
7. **입력.**
   - workbench 단축키는 주인과 명령을 함께 [키보드 단축키](exposure.ko.md#키보드-단축키)에 적는다.
   - 명령 단축키는 native 메뉴를 거쳐 core 명령에 간다.
   - view에는 단축키 표도 키 listener도 없다. view가 주인인 키는 기본 동작을 유지하고 first responder가 받아 처리한다.
   - view는 넘길 키에 대해 `runtime.command(name, params)`로 workbench 명령을 실행한다. host는 view의 키로 아무것도 하지 않는다. bridge는 키 event에 대해 call을 보내지 않으며, main page는 view가 넘기지 않은 키 때문에 명령을 실행하지 않는다.
   - view는 `runtime.shortcuts.read`로 자기 행을 읽는다. 주인이 `workbench` 또는 `view`인 행을 `{key, owner, command}`로 받는다. native 메뉴 행은 돌려주지 않으므로 이 규칙을 따르는 view는 그것을 넘기지 않는다.
   - Escape는 보통의 키다. 자기 Escape 동작이 있는 view는 자기 handler에서 정하고, 없는 view는 page picker가 열려 있을 때 Escape에 `core.picker.close`를 실행한다. bridge는 이 규칙들을 강제하지 않는다.
   - 넘기지 않은 키나 workbench 행이 아닌 키는 기본 동작을 그대로 지킨다.
   - 넘긴 workbench 명령이 실패하면 `page.input.shortcut.failed {plugin, command}`로 알리고, call은 그 오류로 답한다.
   - IME는 view의 first responder가 받는다. 입력기 activation 검사로 확인한다.
   - Escape와 글 입력 키의 주인은 view다. view의 first responder가 이 키들을 받기 때문이다. View 메뉴의 메뉴 단축키(Command `=`, `-`, `0`)는 글자 크기 명령을 실행하는 native 메뉴 단축키다([글자 크기](text-size.ko.md)).
   - 단축키 표 전체는 [키보드 단축키](exposure.ko.md#키보드-단축키)이며, 기계가 읽는 선언은 `packages/workbench/shortcuts.json`이다. `scripts/test/shortcut-table.test.mjs`가 이 표를 두 호스트의 메뉴 표와 workbench 키 처리기에 대해 검사한다.

8. **테마와 접근성.**
   - 호스트는 view를 만들 때 현재 테마 token 묶음을 document-start user script로 view 설정에 넣는다. 그래서 페이지의 첫 script가 돌기 전에 token이 있다.
   - 그 뒤의 테마 변경은 post 경로로 보낸다. 다만 ready message가 기록되지 않은 문서에는 보내지 않는다. 호스트는 ready message마다 현재 테마를 보내므로, ready 전의 변경은 오류도 아니고 유실도 아니다. 규칙 4의 post 규칙(false와 오류)은 다른 모든 message에 적용한다.
   - native 연산이 두 호스트에서 document-start user script를 view 구성에 넣으며, 계약 case를 둔다. view의 첫 frame 색은 card token 색이다.
   - 접근성: view의 요소 tree가 플랫폼 접근성 interface로 닿는지 창 검사가 기록하기 전에는 view의 접근성에 대해 주장하지 않는다.
9. **View의 영역.** view의 영역(document region 또는 image region)은 그 view의 표면 host에 붙는다. 영역을 두거나 바꾸는 각 호출은 호출 envelope의 view id로 확인한다. insets는 view frame 기준이다. 영역의 presentation은 규칙 6에 따라 같은 창 transaction에 넣는다.
10. **View의 unload와 restore.** 탭을 unload하면 그 탭의 view와 그 프로세스를 닫는다. restore는 저장한 state에서 새 view를 만든다. 통과값 (ii)는 unload마다 적용한다.

## 메시지와 event

**메시지**

| 메시지 | 방향 | field | 비고 |
|---|---|---|---|
| `declared-ui.snapshot` | plugin → workbench (event) | `{plugin, status, seq, value, skipped}`. `skipped`는 status의 이전 snapshot이 보내진 뒤 덮어쓴 값의 수다 | 규칙 2의 push |
| `declared-ui.snapshot.ack` | workbench → plugin (event) | `{plugin, status, seq}` | 수신을 확인하고 전송 슬롯을 비운다 |
| `declared-ui.snapshot.request` | workbench → plugin (call) | `{status}`, 응답은 `{seq, value}`이며 `seq`는 출처의 마지막 선언된 UI snapshot의 seq이고, `value`가 `null`이면 0이다 | 규칙 2의 pull(load, 출처 변경). 출처에 아직 값이 없으면 `value`는 `null`이다 |

RPC protocol 번호는 0.0 계열에서 1이다.

**Event.** 각 event 이름은 층(`host` 또는 `page`)으로 시작한다. class는 다루는 관심사(`call`, `lifecycle`, `input`)를 나타낸다. 각 event는 그것을 쓰는 코드와 함께 [event catalog](events.json)에 선언한다.

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
| `host.trace.view.callback-cancelled` | call | debug | `{surface, reason}`; reason은 `retired-origin` 또는 `window-closed` |
| `host.trace.view.presentation-abandoned` | call | debug | `{surface, reason}`. 카운터 `losses.abandoned`. host가 wait를 소유하므로 host가 쓴다 |
| `page.input.shortcut.failed` | input | error | `{plugin, command}` |
| `host.plugin-host.restart` | lifecycle | error | `{plugin, attempt}` |
| `host.plugin-host.restart-limit` | lifecycle | error | `{plugin}` |
| `host.trace.plugin-host.restart-reset` | call | debug | `{plugin}` |
| `host.trace.plugin-host.message-stale` | call | debug | `{plugin}`: 처분된 host instance의 늦은 callback을 dispatch 전에 취소했다 |
| `host.trace.sidecar.restart-reset` | call | debug | `{sidecar, surface}` |

status `core.plugin.open-calls`, `core.plugin.losses`, `core.plugin.views`, `core.plugin.snapshots`는 `packages/workbench/exposure.json`에 선언한다. `core.plugin.snapshots`는 활성 process source와 선언된 status마다 마지막으로 수락된 `{plugin, status, surface, generation, seq}`를 담으며 `status`는 snapshot event에 실린 이름이다. Plugin host의 `surface`는 null이다. Source 등록은 이전 generation의 record를 지우고 source 종료는 해당 record를 제거한다. Workbench는 native host가 snapshot acknowledgment를 수락하고 동일 source generation이 여전히 현재일 때만 record를 갱신한다. 이 기록은 transport 수락을 뜻하며 sidebar가 그렸다는 뜻은 아니다. 같은 generation의 중복 또는 낮은 sequence는 record를 뒤로 움직이지 않는다. Mounted section이 없어도 snapshot을 기록하므로 consumer는 현재 값을 pull하기 전에 publisher event를 기다릴 수 있다. 이 status는 snapshot value를 포함하지 않는다. 각 변경은 status subscriber에 알린다. 이 명세의 event는 [event catalog](events.json)의 class 예산 안에서 level `error` 또는 `debug`만 쓴다. Plugin host와 sidecar의 재시작 상태는 `core.plugin.views` 또는 sidecar status에 보인다.

**릴리스의 event level.** 0.0.x 릴리스는 error event만 저장한다(AGENTS.md, Diagnostic code). 따라서 이 설계의 각 발생은 한 번 분류한다.
(a) 실패나 거부된 연산은 level `error`의 event다.
(b) 손실, 건너뜀, 일시 상태, 표시 품질 저하는 event가 아니다. 선언된 status `core.plugin.losses {plugin, skipped, stalled, abandoned, lateReplies, timeouts, peerLost}`에 센다. 이것은 선언된 status `core.plugin.views {plugin, surface, responsive, queued}`의 상태이기도 하다. 각 수는 바뀔 때마다 status 구독자에게 알린다. 수는 plugin마다 세며 앱이 끝날 때까지 유지한다. 표면이 닫힐 때 0으로 되돌리지 않는다. dirty 값이 있는 채로 닫히는 표면은 그 값을 버리기 전에 `losses.stalled`를 늘려, 모든 build에서 그 손실을 센다.
성능 trace가 켜져 있으면(설정 창의 디버그 switch) 수가 바뀔 때마다 표에 적힌 trace event도 쓴다. 릴리스의 event log는 error event만 저장한다.

코드의 식별자는 여기에 적은 이름을 그대로 쓴다.
## 경계 (결합 금지)

- core가 하는 일은 기구뿐이다. view 구성 종류, 선언 UI schema와 그리기, RPC와 binary 통로, core root, 재시작 한도, 계약 case가 여기에 든다.
- 규칙 4의 view channel이 view의 유일한 전송 통로다.
- 각 plugin의 층, plugin state를 sidecar로 옮기는 일, editor buffer를 옮기는 일은 plugin과 sidecar 저장소의 일이다. core 코드와 시험은 plugin과 sidecar의 이름, 경로, 구현을 모른다.
- core의 [plugin host](#plugin-host)는 view가 하나도 열려 있지 않은 동안 sidebar section의 선언 status를 제공해야 하는 plugin을 위한 것이다. 계약이 그것을 요구할 때만 만든다.
- 관계는 manifest의 `dependencies`, `extends`, `contributes`로만 맺는다. core root가 plugin B의 파일을 plugin A에게 주는 것은 granted item이나 공용 대상일 때뿐이며, 그 판단도 이 선언과 설치 기록으로 한다(규칙 4).
- 플러그인 저장소 요구: 기여 module이나 공용 module을 제공하는 plugin의 저장소는 자기 시험에서 그 module이 각각 자체완결 ES module 하나인지 확인한다. 그 안의 상대 import는 그 plugin의 빌드 오류다.
- 시험:
  - core 시험은 자기 경계를 fake plugin fixture로 검증한다.
  - 공통 계약 case(RPC, snapshot, 재시작)는 소유 package인 core와 두 호스트가 구현하고 실행한다. core는 소비자에게 필요한 fixture를 공개한다. 각 plugin 저장소는 그 fixture로 자기 module만 시험하며, core의 case를 실행하거나 core의 경로를 읽지 않는다.
  - 실제 plugin을 띄우는 측정과 창 검사는 설치된 환경의 end-to-end 검사이고, package 시험이 아니다.
## 탭과 프로세스

- view는 탭마다 하나다. 프로세스 배정을 정하는 공개 API는 없다.
- 저장소에는 새 프로세스를 강제하는 비공개 정책(`_WKNavigationActionPolicyAllowInNewProcess`, [`webview_navigation.m`](../../native/darwin/src/webview_navigation.m), [비공개 native API](../operations/private-native-apis.ko.md))이 있다. 메인 웹뷰는 이 정책을 쓴다(`native/darwin/src/window_facts.m`). 같은 정책은 문서마다 새 프로세스를 띄우는 데도 쓰였다. 그 결과 이동 시간이 약 0.6초에서 1.1초로 늘었고 프로세스 안 cache를 잃어서 그 쓰임은 되돌렸다. view는 이 정책을 쓰지 않으며, 그 정책을 위한 비공개 API는 추가하지 않는다.
- 한 plugin의 view 둘을 (a) 기본 배정과 (b) 이 정책을 쓴 배정으로 재어 프로세스 수, 프로세스 하나의 기본 비용, view 생성 시간을 얻었다. view에는 기본 배정을 쓴다.
- **측정** (`make -C native/darwin benchmark-view-processes`, load average 17):

  | view 수 | 프로세스 | 합계 | 프로세스당 | load (기본 / 강제) | 닫은 뒤 종료 |
  |---|---|---|---|---|---|
  | 1 | 1 | 10.8 MB | 10.8 MB | 0.24 / 0.13초 | 1/1, 0.017초 |
  | 5 | 5 | 54 MB | 10.9 MB | 0.20 / 0.28초 | 5/5, 0.015초 |
  | 10 | 10 | 110 MB | 11.0 MB | 0.44 / 0.58초 | 10/10, 0.036초 |
  | 20 | 20 | 220 MB | 11.0 MB | 0.81 / 1.01초 | 20/20, 0.05초 |
  | 40 | 40 | 422 MB | 10.5 MB | 1.46 / 2.10초 | 40/40, 0.12초 |

- WebKit은 기본 배정에서도 같은 origin의 view마다 프로세스를 따로 준다. view를 묶지 않는다.
- 합계는 view 수에 선형이다(작은 페이지 기준 프로세스당 약 11 MB). 닫으면 모든 프로세스가 0.13초 안에 끝나고 다시 쓰이지 않는다.
- 5개 이상의 view에서는 강제 정책이 더 느리게 load된다. 1개 view에서는 강제 정책이 더 빨랐다(0.13초 대 0.24초). 프로세스 재사용은 측정하지 않았다.
- run loop를 손으로 돌리는 코드는 한 바퀴마다 autorelease pool이 필요하고, weak 배열이 커질 때 읽은 항목을 autorelease한다. 이것을 지키지 않으면 닫은 view가 해제되지 않아 프로세스가 남는 것처럼 보인다.

## binary 경로

plugin 문서는 `POST soksak://<plugin>/.binary`로 byte를 올리고 `GET soksak://<plugin>/.binary/<id>`로 내려받는다. id는 host가 만들고, byte는 문서 영역이 자기 binary store에 보관한다([native surfaces](native-surfaces.ko.md#문서-영역)). 소유자 검사는 영역의 `view.plugin`을 URL host와 비교하는 것이다. 한 번의 upload는 16 MiB 이하이며, 이는 두 호스트의 클립보드 상한이다(darwin 클립보드의 `MAX_BYTES`, wailsv3의 `clipboardMaxBytes`). 한 페이지는 64 MiB 이하를 가지며, 이는 가장 큰 upload 4개 분량이다. id는 download가 끝날 때, native take가 byte를 돌려줄 때, 또는 영역이 닫힐 때 해제한다. plugin release는 `.binary` 경로 부분을 거부한다. host가 파일 조회보다 먼저 그 경로에 응답하므로, 그 아래의 plugin 파일은 닿을 수 없기 때문이다. release 검사는 `@soksak/plugin-api`의 `validateReleaseFiles`이며, `sok plugin pack`도 같은 거부를 적용한다.

## plugin host

- 플랫폼 연산이 plugin host 웹뷰를 만든다. 이 웹뷰는 `SurfaceHost`가 아니라 창에 붙인다. 숨었을 때의 throttle과 `requestAnimationFrame` 동작은 plugin이 이를 쓰기 전에 잰다.
- plugin host의 exposure owner key는 `plugin:<plugin id>`다. plugin id가 plugin의 신원이기 때문이다([신원](#신원)). view에는 새 key가 필요 없다. view는 모든 surface처럼 surface id 아래에 등록하고, owner는 그 tab의 plugin이다.
- plugin host는 규칙 5의 한도 안에서 다시 띄우고, state는 마지막으로 저장한 값에서 복원한다.

## 응답성

private `WKNavigationDelegatePrivate` selector `_webViewWebProcessDidBecomeUnresponsive:`와 `_webViewWebProcessDidBecomeResponsive:`가 `host.trace.view.unresponsive`와 `host.trace.view.responsive`의 event 원천이다. 공개 API는 없다(SDK의 `WKNavigationDelegate.h`에는 `webViewWebContentProcessDidTerminate:`만 있다). [비공개 native API](../operations/private-native-apis.ko.md)가 호출 조건과 함께 이를 적는다. 새로 쓰는 private API는 그것을 추가하는 변경이 호출 조건과 함께 그곳에 올린다.

## 신원

- `soksak` host의 식별자는 plugin id다.
- plugin id에서 plugin 이름으로 가는 대응은 설치 기록과 plugin 폴더에서 읽는다. [설치](installation.ko.md#설치된-plugin-제공)는 기록을 정한다. `plugins/installed.json`(format 3)은 각 plugin id를 기록된 `path`에 대응시키고, plugin의 이름은 그 폴더의 `package.json`의 `name`이다. 기록은 이름을 담지 않는다. `plugins/installed.json`의 쓰는 주체는 앱의 설치 과정이다. 읽는 주체는 호스트와 `sok`다. 호스트는 설치 기록을 요청마다 `/installed-plugins.json`으로 제공하고, `sok`는 기록된 경로에서 파일을 읽는다.
- `plugin.json`의 `id`는 기록의 plugin id와 같아야 한다. 다르면 명시적 오류로 거부한다.

## view의 context

| 항목 | view에서의 형식 |
|---|---|
| `root` | 제거. view는 자기 `document`를 쓴다 |
| `icon(name)`, `params`, `origin`, `project`, `declarations` | 시작할 때 받는 동기 값 |
| `tab.*`, `runtime.native`, `runtime.command`, `runtime.sidecar`, `runtime.clipboard`, `runtime.links`, `tab.state` | 비동기 호출 |
| `runtime.theme`, `runtime.settings`, `runtime.textSize`, `status.subscribe`, `events.on` | event |
| `contributions(point)` | core root에서 import하는 동기 module 목록 |
| `exposure`, binder | view 안에서 그대로. 등록은 통로로 보낸다 |
