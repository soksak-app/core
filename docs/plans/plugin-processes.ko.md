# Plugin 프로세스 구조

[English](plugin-processes.md)

상태: F212.2의 검토 대기 제안서. 단일 작업 체크리스트는 [기능](../features.ko.md)(F212)이다. 이 제안서는 시작 전의 작업을 설명한다. 계약이 승인되면 명세로 옮기고, 명세가 내용을 담은 뒤 이 제안서를 제거한다.

## 결정

Plugin 코드는 workbench 페이지 밖에서 실행된다. 각 plugin view는 `sok://<plugin id>` origin의 별도 웹뷰이며 탭마다 하나다. 선언 UI는 plugin이 보내는 declared UI snapshot으로 workbench가 그린다. plugin host는 view나 sidecar가 맡을 수 없는 DOM 없는 로직이 있을 때만 존재한다.

측정은 이 결정을 뒤집지 않는다. 측정은 프로세스 수, plugin별 예산, 통과값을 정한다. 통과값을 만족하지 못하면 설계를 다시 연다. workbench 페이지에 plugin surface를 mount하는 방식으로 돌아가지 않는다.

## 근거

- 메모리: WebKit은 GC 시점을 할당량으로 정한다(`heap/GCActivityCallback.cpp`의 `didAllocate`, `runtime/OptionsList.h`; F196.20-2). workbench 페이지의 plugin 코드는 workbench와 힙을 공유하므로, plugin 하나의 할당이 모든 plugin과 workbench의 수집을 시작시킨다.
- 교체된 문서는 메모리 압박 전까지 `querySelectorAll` 결과 cache에 남는다(G1.4-64-1-4).
- release workbench 페이지는 약 70 MB다(G1.4-107).
- 숨은 document region 하나를 닫자 227 MB가 돌아왔다(F198.5).
- 문서마다 새 프로세스를 띄우자 이동 시간이 0.6초에서 1.1초로 늘었고, 그 정책은 되돌렸다(F196.27-1, F196.27-2).
- 장애 격리와 측정 단위: plugin의 장애, 메모리, 측정은 그 plugin의 프로세스에 속한다.

측정하지 않은 값은 F212.1에서 잰 뒤에 그 값에 기대는 단계를 진행한다.

## 층 규칙

- **선언 UI:** 화면 요소가 모두 선언 어휘(목록, tree, 메뉴, 명령, 상태줄)로 표현되는 화면이 선언 UI다.
- **view:** 그 밖의 화면은 view다. view는 자유 DOM, IME가 필요한 글 입력, canvas나 편집기, document region 또는 image region을 담은 화면을 맡는다.
- **sidebar section:** 선언 UI만 sidebar section이 될 수 있다. view가 필요한 section은 card 표면이 되고, sidebar에는 그것을 여는 선언 항목만 둔다.
- **plugin host:** view나 sidecar가 DOM 없는 로직을 맡을 수 없을 때만 만든다. 지금 그런 module은 files state 하나뿐이다. 그 module은 files sidecar나 files view로 옮기는 것을 먼저 검토하고, 옮길 수 없을 때만 host를 둔다.
- 화면의 층은 측정으로 정하지 않는다.

## 배치

| plugin | 표면 | section | state와 로직 | 확장점 | sidecar |
|---|---|---|---|---|---|
| editor | view (CodeMirror, IME) | – | – | 기여 plugin이 선언한 module을 core module root에서 import | files |
| flowmark | view (자유 DOM) | – | – | – | 기존 |
| shell | 설계에서 선언 UI로 표현할 수 있는지 확인하고, 안 되면 view | – | – | – | shell |
| files | – | 선언 tree | sidecar로 옮긴다. 불가하면 host | – | files |
| hwp | view와 document region | – | – | – | files |
| browser | view와 document region | 4개 section은 선언 UI 또는 card 표면 | – | – | – |
| terminal | view와 image region, 겹침 화면 | – | – | – | vt |

- modal page는 이 범위에서 뺀다. 이를 쓰는 plugin이 없기 때문이다.
- editor의 buffer와 분석을 sidecar로 옮길지는 통과값 (iv)로 정한다.

## 통과값

아래 값은 F212.1을 시작하기 전에 고정한다. 각 값은 행에 적힌 측정으로 판정한다.

| 기준 | 통과 조건 |
|---|---|
| (i) 합계 | 한 plugin의 view N개의 합계 footprint가 view 1개 footprint의 N배 + 10 MB 이하다. |
| (ii) 회수 | 다른 view와 프로세스를 함께 쓰지 않는 view에 적용한다. 함께 쓰는 view는 그 view들과 한 단위로 잰다. 탐색 기록 없이 연 view를 닫으면, 그 footprint의 90% 이상이 10초 안에 돌아온다(3회 반복). 엔진 cache가 붙잡은 프로세스는 돌아오지 않은 것으로 센다. |
| (iii) 첫 표시 | 프로세스가 이미 실행 중인 view: 같은 plugin의 DOM mount 시간 + 300 ms 이하. |
| (iii-b) 새 프로세스의 첫 표시 | 새 프로세스를 시작하는 view: 첫 표시 시간에서 새 프로세스 시작 시간(F212.1에서 잰 값)을 뺀 나머지가 (iii)을 만족한다. 시작 시간은 5회 측정의 중앙값이며 load average와 함께 기록한다. 3회 반복. |
| (v) 표시 판정값 | 프로세스가 실행 중이고 페이지가 load된 view에 적용한다. card 배치가 바뀐 뒤 그 view의 frame이 새 크기로 그려지기까지 100 ms 이내다. 60 Hz에서 한 frame은 16.7 ms이므로 6 frame이다. F212.7 전에 고정한다. |
| (vi) 재시작 한도 | 실패 event가 올 때 실패 시각을 기록하고 그 자리에서 센다(timer를 쓰지 않는다). 최근 300초 안의 실패가 4번째에 이르면 재시작을 멈춘다. 300초보다 오래된 실패는 세지 않는다(sliding window). 멈춘 뒤에는 그 프로세스가 필요한 표면을 사용자가 열 때 실패 기록을 비우고 다시 띄운다. |
| (iv) editor 측정 | editor view의 footprint와 숨긴 DOM editor의 footprint를 잰다. view 쪽 footprint가 50 MB를 넘으면, F212.9 뒤에 buffer와 분석을 sidecar로 옮기는 항목을 체크리스트에 추가한다. 이것은 통과 조건이 아니라 측정과 항목 추가 규칙이다. |
| (viii) 끌기 | gesture 동안 (a) 매 frame에서 native frame 경계와 card 경계의 차이가 2 pt 이하다(같은 commit, 기대값 0). (b) 내용 frame(view가 자기 document에 그린 frame이며, view의 ResizeObserver 다음 requestAnimationFrame이 내는 표시)의 연속 간격이 33 ms 이하다. (c) 내용 frame 크기가 native frame 크기와 다른 상태가 gesture 끝난 뒤 2 frame(33 ms) 안에 사라진다. 이 값은 녹화에서 판정하며 실행 중 timer로 판정하지 않는다. F212.7c 전에 고정한다. |

값을 만족하지 못하면 측정값을 체크리스트에 기록한다. 기구 값 (v), (vi), (viii)이 실패하면 기구 항목(F212.7b, F212.7c, F212.8a)과 그것에 기대는 항목(F212.8 이후)을 멈춘다. plugin 값 (i), (ii), (iii), (iii-b)가 실패하면 그 plugin의 이전 항목만 멈춘다. 비용을 받아들일지, 그 plugin의 층을 바꿀지는 소유자가 정한다. 이 설계는 둘 중에서 고르지 않는다.

## 규칙

1. workbench 페이지에서는 plugin 코드를 실행하지 않는다.
2. **declared UI snapshot.** plugin view나 plugin host는 declared UI snapshot을 workbench로 보낸다(push). 메인 페이지가 load될 때(reload 포함) workbench는 그 페이지의 표면이 선언한 plugin view와 host의 각 status에 대해 snapshot을 한 번 요청한다(pull). 다른 pull은 없다. 메시지의 이름과 field는 [메시지와 event](#메시지와-event)에 적는다.
   - status 하나에는 전송 중인 snapshot이 최대 1개다.
   - 전송 중에 생긴 변경은 dirty로 표시한다. 확인(ack)이 오면 최신 값을 담아 다음 snapshot을 보낸다.
   - 건너뛴 값의 수는 event log에 남긴다.
   - plugin 프로세스가 (다시) 시작하면 그 프로세스의 첫 snapshot이 각 status의 전체 값이다. workbench는 이전 프로세스의 멈춘 snapshot과 확인 대기를 버린다. 다시 시작한 plugin은 저장한 state에서 값을 만들어 보낸다(규칙 5).
   - 확인을 기다리는 동안 view 프로세스가 끝나거나 표면이 닫히면 workbench는 `status.stalled {plugin, status, reason}`을 쓴다. 다시 시작한 프로세스는 첫 snapshot으로 각 status의 최신 값을 보내고 dirty 표시를 지운다. 표면이 닫힌 것이면 dirty 값은 버리고 그 사실을 reason에 적는다. timer는 쓰지 않는다.
3. **경계를 넘는 호출.**
   - 명령은 [exposure](../spec/exposure.md)에 적힌 대로 `timeout`을 선언한다(최대 600000 ms, 없으면 10초). timer는 살아 있는 상대가 답하지 않는 경우에만 남긴다. 느린 살아 있는 답을 알려 주는 event가 없기 때문이며, 이 이유를 여기에 적는다. 기한을 넘기면 현재 계약대로 지난 시간과 timeout을 밝힌 오류로 거부하고 `call.timeout {plugin, command}`를 쓴다.
   - 상대가 사라지면 기한 전에 event로 호출을 끝낸다. 상대는 view나 host 프로세스의 종료, 표면 닫기, sidecar 종료다. promise는 그 이유를 밝힌 오류로 거부하고 `call.peer-lost {plugin, command, reason}`을 쓴다. 응답 없음 감지(빈칸 10)는 그것을 정한 뒤에만 자기 event를 추가한다.
   - 끝난 호출에 늦게 온 답은 promise에 전달하지 않는다. 호스트는 답을 보낸 문서에 [host contract](../spec/host-contract.md)의 오류로 답하고, `call.late-reply {plugin, command, delay}`로 센다.
   - 열린 호출 수(확인을 기다리는 snapshot 포함)와 가장 오래된 열린 호출의 시작 시각을 core status `core.plugin.open-calls {plugin, count, oldestStartedAt}`로 노출한다. 이름과 위치는 여기서 정하며, F212.3이 status를 선언한다.
   - relay timeout은 exposure의 제품 동작이다. 두 경로가 있다. 호스트는 surface page로 보낸 명령에 timeout을 적용하고, 메인 페이지는 자기가 직접 실행하는 handler에 timeout을 적용한다([exposure](../spec/exposure.md), 명령 `timeout`). 두 경로는 F212.2에서 exposure.md에 적는다.
   - 취소는 호출 envelope의 일부다. binary payload는 별도 경로를 쓴다(빈칸 2).
4. **Origin과 공용 module.**
   - 각 plugin HTML은 `sok://<plugin id>`의 별도 웹뷰에서 돈다.
   - 공용 module은 plugin id로 쓸 수 없는 예약 host `core`의 root로 제공한다. `validateManifest`가 그 이름을 거부한다.
   - core root가 제공하는 것은 core module 묶음과, plugin B의 파일 가운데 다음 경우에 해당하는 것이다. 요청마다 설치 기록에서 확인한다.
     - plugin A의 view가 요청했고, A가 `extends`로 선언한 확장점에 B가 `contributes`로 항목을 선언했을 때
     - A의 `dependencies`가 B를 지정할 때
   - 그 밖의 경로는 [native surfaces](../spec/native-surfaces.ko.md#문서-영역)와 같이 not found로 답한다.
   - Red 시험: plugin A의 view가 A의 확장점에 대한 기여도 아니고 A의 의존 대상도 아닌 plugin B의 파일을 요청하면 not found를 받는다.
5. **재시작.** sidecar와 plugin host는 통과값 (vi)의 한도 안에서 다시 띄운다. 한도를 넘으면 호스트는 `error:`를 보고하고 멈춘다.
   - 한도를 넘은 뒤의 다음 요청은 프로세스를 띄우지 않고 `sidecar-failure`(reason `restart limit`)로 실패한다. 그 프로세스가 필요한 표면을 사용자가 열면 기록을 비우고 다시 띄우며, `sidecar.restart-reset {sidecar, surface}`를 쓴다. plugin host는 `plugin.host.restart-reset`을 쓴다.
   - 이 규칙은 [sidecars](../spec/sidecars.ko.md)의 `## Failure` 절을 바꾼다. 그 절은 지금 한도 없이 다음 요청 때 새로 띄운다고 적는다. 이 변경은 F212.8a에서 한다.
   - 다시 띄우면 state는 마지막으로 저장한 값에서 복원한다. 저장하지 않은 state는 잃으며, plugin마다 어떤 state인지 밝힌다.
   - 고장 주입은 진단 build에서만 둔다.
6. **표시.** plugin view는 card 배치가 바뀐 뒤(gesture의 첫 변경)의 첫 표시에만 presentation wait에 참여한다.
   - 계속되는 gesture(구분선이나 card 끌기) 동안 view의 native frame은 매 frame card와 같은 commit에서 새 기하로 놓는다. 내용 그리기를 기다리는 것은 첫 변경에서만 한다. 그 뒤 내용은 늦게 그려질 수 있으며, 그 늦음은 frame 간격으로 잰다.
   - F212.7c에서 끌기 gesture 전체를 녹화해 frame 간격과 기하 오차를 재고, 통과값 (viii)로 판정한다.
   - 기다림은 다음 가운데 먼저 오는 것으로 끝난다: view의 presentation 완료, view 프로세스 종료, 변경이 끝났을 때 그 view가 보이지 않음(`hidden` 조상, 선택되지 않은 탭, 닫힌 표면. workbench가 표면마다 이미 알리는 상태를 읽는다), 빈칸 10이 정하면 응답 없음 알림. presentation 완료가 아닌 것으로 끝나면 그 view 없이 commit을 진행하고 `view.presentation-abandoned {surface, reason}`을 쓴다. timer는 쓰지 않는다.
   - 통과값 (v)는 실행 중 기한이 아니다. F212.7b와 각 plugin 항목이 재는 판정값이다.
   - F212.7b는 view가 있는 card의 전체 화면 전환과 탭 전환을 녹화해, 두 기다림이 모두 끝나는지 확인한다.
   - [native surfaces](../spec/native-surfaces.ko.md)의 해당 규칙을 고친다.
7. **입력.**
   - workbench 단축키는 아래 표에 주인과 함께 적는다.
   - 명령 단축키는 native 메뉴를 거쳐 core 명령에 간다.
   - view는 시작할 때 호스트에 단축키 표를 등록한다. 표에는 workbench 단축키와 각각의 주인이 들어 있다.
   - view는 그 표를 보고 자기 안에서 동기로 판단한다.
     - 주인이 workbench인 키만 기본 동작을 막고, event 정보와 함께 넘긴다.
     - 주인이 view인 키는 view가 처리하고 넘기지 않는다.
     - 주인이 native 메뉴인 키는 메뉴가 먼저 받으므로 view의 기본 동작을 막지 않는다.
     - 표에 없는 키는 기본 동작을 그대로 지킨다.
   - 넘긴 명령이 실패하면 event로 알리고, 기본 동작을 다시 실행하지 않는다.
   - F212.12에서 Escape의 왕복 시간을 메뉴 닫기와 비교해 잰다.
   - IME는 view의 first responder가 받는다. activation 검사(F212.13)로 확인한다.

   | 단축키 | 주인 | 이유 |
   |---|---|---|
   | Command `=`, `-`, `0` (View 메뉴의 글자 크기, [글자 크기](../spec/text-size.ko.md)) | native 메뉴 → core 명령 `core.text.larger`, `core.text.smaller`, `core.text.reset` | 메뉴 단축키는 어느 view가 포커스를 가져도 동작한다 |
   | Escape | F212.12에서 정한다(메뉴 닫기 또는 view) | F212.12에서 메뉴 닫기와 비교해 잰다 |
   | 글 입력과 IME 키 | view | view의 first responder가 받는다 |

   workbench 단축키 전체 목록은 두 호스트의 메뉴 선언과 workbench의 키 처리기에서 얻는다. 이 표는 지금 명세가 선언한 단축키만 담는다. 나머지는 F212.7 시작 전에 이 표에 더한다.

8. **테마와 접근성.**
   - 호스트는 view를 만들 때 현재 테마 token 묶음을 document-start user script로 view 설정에 넣는다. 그래서 페이지의 첫 script가 돌기 전에 token이 있다.
   - 그 뒤의 테마 변경은 post 경로로 보낸다.
   - F212.7d에서 첫 frame의 색을 card token 색과 비교한다. document-start user script는 빈칸 9다.
   - 접근성: F212.12에서 view의 요소 tree가 플랫폼 접근성 interface로 닿는지 기록한다. 검사가 생기기 전에는 접근성에 대해 다른 주장을 하지 않는다.

## 메시지와 event

**메시지**

| 메시지 | 방향 | field | 비고 |
|---|---|---|---|
| `declared-ui.snapshot` | plugin → workbench (event) | `{plugin, status, seq, value}` | 규칙 2의 push |
| `declared-ui.snapshot.ack` | workbench → plugin (event) | `{plugin, status, seq}` | 수신을 확인하고 전송 슬롯을 비운다 |
| `declared-ui.snapshot.request` | workbench → plugin (call) | `{status}`, 응답은 `{seq, value}` | 메인 페이지 load 때의 유일한 pull |

**Event** (F212.3에서 선언하며, `sidecar.restart-reset`은 제외한다)

| event | field |
|---|---|
| `declared-ui.snapshot.skipped` | `{plugin, status, count}`: 전송 중일 때 건너뛴 값 |
| `status.stalled` | `{plugin, status, reason}` |
| `call.timeout` | `{plugin, command}` |
| `call.peer-lost` | `{plugin, command, reason}` |
| `call.late-reply` | `{plugin, command, delay}` |
| `view.presentation-abandoned` | `{surface, reason}` |
| `input.shortcut.failed` | `{plugin, key, command}` |
| `plugin.host.restart` | `{plugin, attempt}` |
| `plugin.host.restart-limit` | `{plugin}` |
| `plugin.host.restart-reset` | `{plugin}` |
| `sidecar.restart-reset` | `{sidecar, surface}`, F212.8a가 선언 |

위 메시지와 event의 이름은 각 단계가 선언하는 이름이다. 코드의 식별자는 여기에 적은 이름을 그대로 쓴다.

## 경계 (결합 금지)

- 이 설계에서 core가 하는 일은 기구뿐이다. view 구성 종류, 선언 UI schema와 그리기, RPC와 binary 통로, 예약 module root, 재시작 한도, 계약 case가 여기에 든다.
- 위 plugin 표는 각 plugin 저장소의 체크리스트에 올라갈 이전 항목의 입력이다. core 코드와 시험은 plugin과 sidecar의 이름, 경로, 구현을 모른다.
  - files state를 sidecar로 옮기는 일은 files plugin과 files sidecar 저장소의 항목이다.
  - editor buffer를 옮길지는 editor 저장소의 항목이다.
- core의 F212.9는 view나 sidecar가 맡을 수 없는 DOM 없는 로직을 가진 plugin을 위한 plugin host 기구다. 계약이 그것을 요구할 때만 만든다.
- 관계는 manifest의 `dependencies`, `extends`, `contributes`로만 맺는다. core root가 plugin B의 파일을 plugin A에게 주는 근거도 이 선언과 설치 기록뿐이다.
- 시험:
  - core 시험은 자기 경계를 fake plugin fixture로 검증한다.
  - 공통 계약 case(RPC, snapshot, 재시작, 단축키 표)는 소유 package인 core와 두 호스트가 구현하고 실행한다. core는 소비자에게 필요한 fixture를 공개한다. 각 plugin 저장소는 그 fixture로 자기 module만 시험하며, core의 case를 실행하거나 core의 경로를 읽지 않는다.
  - 실제 plugin을 띄우는 측정과 창 검사(F212.1, F212.7a, F212.12, F212.14)는 설치된 환경의 end-to-end 검사이고, package 시험이 아니다.

## 탭과 프로세스

- view는 탭마다 하나다. 프로세스 배정을 정하는 공개 API는 없다.
- 저장소에는 새 프로세스를 강제하는 비공개 정책(`_WKNavigationActionPolicyAllowInNewProcess`, [`webview_navigation.m`](../../native/darwin/src/webview_navigation.m), [비공개 native API](../operations/private-native-apis.ko.md))이 있다. 이것은 문서마다 새 프로세스를 띄우는 데 쓰였다. 그 결과 이동 시간이 약 0.6초에서 1.1초로 늘었고 프로세스 안 cache를 잃어서 되돌렸다(F196.27-1, F196.27-2).
- F212.1은 한 plugin의 view 둘을 (a) 기본 배정과 (b) 이 정책을 쓴 배정으로 재고, 프로세스 수, 프로세스 하나의 기본 비용, view 생성 시간을 적는다. 어느 쪽을 쓸지는 이 문서에서 정한다. 기본 배정을 쓰므로 그 정책을 위한 비공개 API는 추가하지 않는다.
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
- 새 프로세스를 강제하는 정책은 이득이 없고 load가 더 느리다. 따라서 기본 배정을 쓰고 그 정책은 쓰지 않는다.
- 측정 중 확인한 사실: run loop를 손으로 돌리는 코드는 한 바퀴마다 autorelease pool이 필요하고, weak 배열이 커질 때 읽은 항목을 autorelease한다. 이것을 지키지 않으면 닫은 view가 해제되지 않아 프로세스가 남는 것처럼 보인다.
- 통과값 (i)을 넘으면 소유자가 정한다. 대안은 "창마다 plugin당 view 하나가 그 plugin의 탭을 모두 그린다"이다. 이 대안은 프로세스 수를 줄이지만, 한 탭의 장애가 같은 plugin의 탭 모두에 미친다.

## 기존 기반과 빈칸

**있음**

- document region: 별도 WKWebView, insets 배치, 입력과 포커스, 테마, 메모리 절약과 복원, `sok://` 파일.
- JSON 통로 `post`와 `document-message`(`document_view.m:39,855`, `surface-modules.js:98-100`, `documents.go:41`, `documents.rs:42`).
- exposure 전달(`exposure.js:95,108`).
- 별도 문서 런타임 틀(`page.js`).

**빈칸 (설계 문서의 native 절)**

1. [native surfaces](../spec/native-surfaces.ko.md)의 113행("application bridge 없음")과 115행(`post` 통로)의 모순을 바로잡는다. region 문서는 bridge를 받지 않으며, 그 메시지는 origin을 확인하는 `window.postMessage`뿐이고 호스트가 보내고 받는다. 이 정정은 F212.4에서 한다.
2. 호출 envelope에 id, 확인, 취소를 넣는다. 호출은 `id`를 가지고, 응답은 같은 `id`로 결과나 오류를 담고, 취소는 `id`를 가진다. binary 경로는 F212.4에서 두 호스트에 native로 만든다.
3. plugin host 웹뷰를 만드는 플랫폼 연산을 둔다. 이 웹뷰는 `SurfaceHost`가 아니라 창에 붙인다. 숨었을 때의 throttle과 requestAnimationFrame 동작은 F212.1과 F212.9a에서 잰다.
4. Wails에는 앱이 만든 웹뷰로 가는 호출 통로가 없다(H3). Objective-C 쪽에서 통로를 만들고, 계약 case로 두 호스트가 같게 동작하는지 검증한다(F212.4).
5. core의 공용 module 예약 root를 F212.5에서 만든다. 복사본과 link는 쓰지 않는다.
6. region 페이지에는 F212.5에서 import map을 준다.
7. plugin host를 가리키는 exposure owner key는 `plugin:<plugin id>`로 한다. plugin의 identity인 plugin id를 쓰므로([신원](#신원)) 그렇게 정한다.
8. 새로 쓰는 private API는 추가할 때(F212.4) 호출 조건과 함께 [비공개 native API](../operations/private-native-apis.ko.md)에 올린다. 이 문서는 새 private API를 정하지 않는다.
9. document-start user script를 view 설정에 넣는 native 연산을 두 호스트에 만들고 계약 case를 둔다(F212.7d).
10. 응답 없음 감지: 공개 API가 있는지 먼저 확인한다. 공개 API와 private API를 확인한 기록은 아직 이 제안서에 없다. 확인 기록이 생기기 전까지 이 설계에는 응답 없음 event가 없으며, 멈춘 view는 열린 호출 status `core.plugin.open-calls`로만 보인다. private API가 있으면 쓰기 전에 호출 조건을 [비공개 native API](../operations/private-native-apis.ko.md)에 올린다.

## 신원

- sok host의 식별자는 plugin id다.
- plugin id에서 package 이름으로 가는 대응은 설치 기록과 plugin 폴더에서 읽는다. [설치](../spec/installation.ko.md#설치된-plugin-제공)는 기록을 정한다. `plugins/installed.json`(format 3)은 각 plugin id를 기록된 `path`에 대응시키고, plugin의 이름은 그 폴더의 `package.json`의 `name`이다. 기록은 이름을 담지 않는다. `plugins/installed.json`의 쓰는 주체는 앱의 설치 과정이다. 읽는 주체는 호스트와 `sok`다. 호스트는 설치 기록을 요청마다 `/installed-plugins.json`으로 제공하고, `sok`는 기록된 경로에서 파일을 읽는다.
- `plugin.json`의 `id`는 기록의 plugin id와 같아야 한다. 다르면 명시적 오류로 거부한다.
- 고칠 곳: `page.js:77,169`와 `index.js:1127`은 이 대응을 쓰도록 바꾼다. id와 package 이름이 다른 plugin에 대한 Red 시험을 둔다. `e2e/audit.test.mjs:12`는 이런 plugin을 조용히 건너뛰므로, 건너뛰기를 실패로 바꾼다.

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

각 단계는 기능 하나의 체크리스트 항목이다. 명세, Red, 구현, Green, 기록, 커밋 순서로 진행하며, main은 매 단계 뒤에도 green이다.

1. **F212.1 측정.** 창마다 모든 WebContent의 합계, 웹뷰 기본 비용, plugin host의 비용과 throttle, DOM editor와 flowmark(메모리 절약 켬과 끔)와 같은 화면을 view로 띄운 경우, 한 plugin의 view 둘을 (a)와 (b)로 잰 값, 프로세스 공유 쌍(한 plugin의 view 둘, 두 plugin의 view, 한 plugin의 view와 document region), 창 두 개의 메인 페이지 공유, 설치 기록의 표면을 가진 모든 plugin의 DOM mount 시간((iii)의 기준값, plugin 버전과 함께 기록), 첫 표시 시간과 첫 status 시간, 새 WebContent 프로세스 시작 시간. trace가 켜졌을 때 페이지는 표면 mount마다 `page.trace.surface.mount {plugin, surface, ms}`를 쓰며, `make events-check`는 workbench의 `trace(` 호출을 catalog와 대조한다.
2. **F212.2 설계 문서.** 이 문서와 한국어 번역. 검토 결과는 [검토된 반론 답변](#검토된-반론-답변)에 적는다.
3. **F212.3 호출 메시지 계층(plugin-api).** [메시지와 event](#메시지와-event)의 event를 event catalog에 선언하고(`sidecar.restart-reset`은 F212.8a가 선언), `make events-check`를 돌린다.
4. **F212.4 binary 경로**(native 코드와 두 호스트).
5. **F212.5 공용 module 예약 root와 import map.**
6. **F212.6 신원, exposure 등록, 건너뛰지 않는 audit.**
7. **F212.7 view 구성 종류**(manifest, workbench, native 배치).
   - **F212.7b:** presentation wait 참여와 예산 (v).
   - **F212.7c:** 끌기 녹화와 기하 오차 (viii). 측정은 첫 view(F212.7a의 editor view)로 한다. 모든 plugin view는 각자의 F212.10 항목과 F212.14에서 잰다.
   - **F212.7d:** 첫 frame 테마 user script(native 항목 9).
   - **F212.7a:** F212.7b~7d 뒤, F212.8 전에 editor의 첫 view로 (i), (ii), (iii), (iii-b), (v), (viii)을 잰다.
8. **F212.8 선언 UI schema와 workbench 그리기**(sidebar section 포함).
   - **F212.8a:** 재시작 한도 (vi)를 [sidecars](../spec/sidecars.ko.md)의 `## Failure`와 번역에 넣는다. sidecar 실패를 맡은 호스트 package(Go, Rust, 계약 case)에 Red 시험을 둔다. F212.9보다 먼저 한다.
9. **F212.9 plugin host 기구**(플랫폼 연산, owner key, 재시작). files 저장소가 state를 sidecar로 옮기는 항목을 먼저 마치고, 그래도 필요한 plugin이 있을 때만 만든다.
   - **F212.9a:** plugin host를 둔다면 그 footprint와 throttle을 F212.10보다 먼저 잰다.
10. **F212.10 plugin 이전**(각 plugin 저장소의 항목, `engines.soksak`). 각 plugin 항목은 release 전에 그 view의 (iii), (v), (viii)을 잰다.
11. **F212.11 옛 경로 제거**(페이지 mount, parking, `dom` 구성, 페이지의 section과 state mount). manifest는 새 형식만 받는다.
12. **F212.12 기능별 창 검사**(표시, 입력과 포커스, 끌기, 재시작). 기능 하나당 항목 하나다.
13. **F212.13 IME activation 검사**(사용자 승인).
14. **F212.14** 마지막 배치에서 모든 plugin view로 (i), (ii), (iii), (iii-b), (v)를 다시 재고, 모든 plugin view로 (viii)을 잰다. (vi)은 F212.12의 재시작 창 검사가 만든다.
15. **F212.15 core release.** plugin은 각 저장소에서 release한다.

## 검증

- 각 항목: 소유 module의 단위 Red/Green과, 변경이 닿는 구조 검사. 전체 suite는 항목 완료에 쓰지 않는다.
- 완료 판정: (i), (ii), (iii), (iii-b), (v), (vi), (viii)은 통과해야 한다. (iv)는 측정을 마쳐야 하며, 초과하면 그 후속 항목이 체크리스트에 있어야 한다.

## 되돌림

- core 단계는 그 단계를 요구하는 plugin release를 이전 `engines` 범위로 되돌려 release한 뒤에만 되돌린다.
- 순서: F212.3부터 F212.6까지는 기구를 더하고 기존 plugin의 동작을 바꾸지 않으므로, 그 commit을 되돌려서 되돌린다. F212.7a부터 F212.9까지는 그것을 쓰는 plugin release를 되돌린 뒤에 되돌린다. F212.10은 각 plugin을 이전 `engines` 범위로 release하여 되돌린다. F212.11은 옛 경로를 제거하므로, F212.10을 되돌린 뒤에만 그 commit을 되돌린다.
- 각 단계의 되돌림 순서는 그 단계를 쓸 때 그 단계의 체크리스트 항목에 기록한다.

## 위험

- 높은 위험: IME, 끌기와 배치, 프로세스 수와 첫 표시 시간, Wails 통로.

## 검토된 반론 답변

이 제안서의 검토 기록에는 반론의 단일 목록이 없다. 아래 각 항목은 이 제안서의 규칙이 답하도록 바뀐 반론이며, 판정과 해결은 그 규칙에 적혀 있다.

- 반론: 모든 view를 정책으로 새 프로세스에 띄워 문서마다 격리한다. 판정: 기각. 해결: 측정한 새 프로세스 정책은 이득이 없고 load가 더 느렸다(F196.27-1, F196.27-2). 기본 배정을 유지하고 그 정책은 쓰지 않는다.
- 반론: 죽는 프로세스가 끝없이 다시 떠서 페이지를 붙잡는다. 판정: 수용. 해결: 300초 sliding window에서 4번째 실패에 재시작을 멈추고, 표면을 열면 기록을 비운다(규칙 5, 통과값 (vi)).
- 반론: 현재 sidecar 실패 규칙은 한도 없이 다시 띄우므로 같은 위험이 있다. 판정: 수용. 해결: 한도를 모든 sidecar에 적용하고, 계약 변경은 F212.8a에서 host package의 Red 시험과 함께 한다.
- 반론: 호출마다 거는 timer는 응답을 polling하는 것이다. 판정: 일부 수용. 해결: 상대가 사라지면 event(`call.peer-lost`)로 호출을 끝내고, timer는 살아 있는데 답하지 않는 상대에만 남기며 그 이유를 규칙 3에 적는다.
- 반론: view의 presentation 기다림이 commit을 무한히 막을 수 있다. 판정: 수용. 해결: 네 event 가운데 먼저 오는 것으로 끝나며 timer를 쓰지 않고, presentation 없이 끝나면 `view.presentation-abandoned`를 쓴다(규칙 6).
- 반론: 끌기 중 모든 내용 frame을 기다리면 끌기가 밀린다. 판정: 수용. 해결: 첫 변경만 기다리고, native frame은 card와 같은 commit에서 움직이며, 이후 frame은 통과값 (viii)의 간격으로 판정한다(규칙 6).
- 반론: 모든 키를 처리하는 view가 native 메뉴 단축키를 막는다. 판정: 수용. 해결: 단축키마다 주인을 표에 적고, 메뉴 키는 기본 동작을 막지 않으며, view가 주인인 키는 view 안에서 처리한다(규칙 7).
- 반론: 공용 module을 plugin마다 복사하면 코드와 버전이 중복된다. 판정: 기각. 해결: core의 예약 root가 module을 제공하며, 복사와 link를 쓰지 않는다(규칙 4, 빈칸 5).
- 반론: core root가 어떤 view에도 어떤 plugin 파일이든 준다. 판정: 수용. 해결: `extends`/`contributes`와 `dependencies`가 가리키는 파일만 준다. 그 밖의 경로는 not found이며 Red 시험을 둔다(규칙 4).
- 반론: 테마 token이 페이지 script가 돈 뒤에야 보여 첫 frame이 깜박인다. 판정: 수용. 해결: document-start user script가 token을 싣는다(규칙 8, 빈칸 9). F212.7d에서 확인한다.
- 반론: view를 접근성이 있다고 주장하려면 요소 tree 검사가 필요하다. 판정: 일부 수용. 해결: F212.12의 검사가 플랫폼 interface를 기록하기 전까지 접근성 주장을 하지 않는다(규칙 8).
- 반론: files state에는 plugin host가 필요하다. 판정: 일부 수용. 해결: state를 files sidecar로 먼저 옮기고, 옮길 수 없을 때만 host를 만든다(층 규칙, F212.9).
- 반론: plugin id와 package 이름이 다를 수 있고, audit이 그런 plugin을 조용히 건너뛴다. 판정: 수용. 해결: 대응은 설치 기록에서 읽고, 불일치한 `id`는 거부하며, audit의 건너뛰기는 실패로 바꾸고 Red 시험을 둔다([신원](#신원)).
- 반론: 선언 UI의 모든 변경을 보내면 workbench가 넘친다. 판정: 수용. 해결: status마다 전송 중인 snapshot은 하나이고, 변경은 dirty로 표시하며, 건너뛴 값은 event log에 센다(규칙 2).
- 반론: editor buffer는 지금 sidecar로 옮겨야 한다. 판정: 규칙으로는 기각, 측정으로는 수용. 해결: 통과값 (iv)가 footprint를 재고, 50 MB를 넘으면 후속 항목을 추가한다.
- 반론: 창마다 plugin당 view 하나면 프로세스가 적다. 판정: 지금은 기각. 해결: 통과값 (i)이 실패할 때 소유자에게 줄 대안으로 남긴다. 한 탭의 장애가 같은 plugin의 모든 탭에 미치기 때문이다.
