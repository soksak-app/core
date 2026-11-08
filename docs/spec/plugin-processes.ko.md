# Plugin 프로세스

[English](plugin-processes.md)

이 명세는 plugin 코드가 어디에서 실행되고 그 프로세스들이 어떻게 통신하는지 정한다. plugin의 층, plugin view의 통과값, sidebar section, 프로세스 경계를 넘는 호출, view의 origin과 core root, 재시작, 표시, 입력, 테마, 메시지와 event, core와 plugin의 경계, view의 프로세스 배정, binary 경로, plugin의 신원, view의 context를 다룬다. [native surfaces](native-surfaces.ko.md#view-표면)는 view channel과 view의 배치를, [plugin](plugins.ko.md)은 manifest를 정한다.

## 결정

Plugin 코드는 workbench 페이지 밖에서 실행된다. 각 plugin view는 `soksak://<plugin id>` origin의 별도 웹뷰이며 탭마다 하나, sidebar section마다 하나다([섹션](plugins.ko.md#섹션)). Plugin은 자기가 가진 모든 화면을 어떤 수단으로든 자기 view에 그리며, workbench는 plugin 내용을 그리지 않는다.

측정은 이 결정을 뒤집지 않는다. 측정은 프로세스 수, plugin별 예산, 통과값을 정한다. 통과값을 만족하지 못하면 설계를 다시 연다. workbench 페이지에 plugin surface를 mount하는 방식으로 돌아가지 않는다.

## 운영체제 표시 이름

Plugin view의 WebContent process는 `soksak://plugin/<plugin id>` 표시 이름을 사용하고, document region의 WebContent process는 `soksak://plugin/<plugin id>/<region>`을 사용한다. `<region>`은 manifest가 그 region에 선언한 이름이다. Host가 이 이름을 만들어 web view의 WebKit process configuration에 설정하며, 분리된 `soksak://<plugin id>` origin을 바꾸거나 접근 권한을 주거나 요청을 라우팅하지 않는다. Plugin 식별자는 view 선언에서 가져온다. 이 private WebKit 설정은 configuration별이므로 이름이 다른 configuration은 WebContent process를 공유하면 안 된다. 한 process에는 표시 이름 하나만 설정할 수 있기 때문이다.

## 근거

- 메모리: WebKit은 마지막 수집 이후 할당된 바이트에 비례해 전체 JavaScript 수집을 미룬다(`heap/GCActivityCallback.cpp`의 `didAllocate`). workbench 페이지의 plugin 코드는 workbench와 같은 힙에 할당하므로, plugin 하나의 할당은 workbench의 쓰레기 수집도 미룬다. 이 지연을 줄이는 공개 API는 없다.
- 교체된 문서는 메모리 압박 전까지 `querySelectorAll` 결과 cache에 남는다.
- 새로 시작한 release build의 메인 페이지 프로세스는 약 70 MB였다. 재로드 뒤 메인 페이지 프로세스는 446.6 MB(Wails)와 399.9 MB(Tauri)였다.
- 숨은 browser tab 하나를 닫자 227 MB가 돌아왔다.
- 문서마다 새 프로세스를 띄우자 이동 시간이 0.6초에서 1.1초로 늘었고, 그 정책은 되돌렸다.
- 장애 격리와 측정 단위: plugin의 장애, 메모리, 측정은 그 plugin의 프로세스에 속한다.

## 층 규칙

- **view:** plugin의 모든 화면은 view다. 탭 표면 또는 section 표면이다. view는 자유 DOM, framework나 library, IME가 필요한 글 입력, canvas나 편집기, document region 또는 image region을 담는다.
- **sidebar section:** sidebar section은 [section 표면](plugins.ko.md#섹션)이다. 사이드바가 section의 본문에 배치하는 자기 plugin의 view이며, core는 사이드바의 틀만 그린다. 자기 plugin의 탭이 하나도 열려 있지 않은 동안 값을 보여야 하는 section은 자기 view에서 그 값을 읽는다. 값은 자기 plugin의 sidecar와 프로젝트 데이터에서 온다.
- **exposure:** 모든 view는 exposure 계약만 요구한다. 모든 조작 요소는 공유 binder로 선언된 명령에 연결되고 element 이름을 가지며, 보이는 모든 상태는 선언된 status다([exposure](exposure.ko.md)).
- **terminal surface:** `term` plugin은 mygo host를 포함한 모든 host에서 image region 하나(`input: "dom"`)를 가진 view composition을 유지한다. view page가 terminal의 화면 상태, 입력, exposure를 소유하기 때문이다.
- 화면의 층은 측정으로 정하지 않는다.

## 통과값

각 값은 행에 적힌 측정으로, 애플리케이션 안에서 도는 timer가 아니라 녹화에서 판정한다. 메모리 값은 SI megabyte를 사용하며 1 MB는 1,000,000 bytes다. 회수 측정은 process를 공유하는 전체 group과 그 group의 모든 view를 닫기 직전 physical footprint를 기록한다. 닫은 뒤 같은 process identity를 비교하며 종료한 process는 0으로 센다. View를 열기 전 baseline을 빼지 않는다. Group은 root view와 연결된 모든 native document-region process를 포함하며 포함한 process를 공유하는 모든 surface로 확장한다. 기록은 닫은 각 view의 root와 연결된 각 document region의 session history에 초기 document만 있음을 입증한다.

Total-footprint 측정은 process group을 수집할 때 정확히 N개 workload view만 열어 둔다. 각 process-group footprint sample 전후의 native monotonic clock 경계를 기록한다. OS footprint read는 순차 실행하므로 각 process read는 기록된 sample 경계 안에서 이뤄진다. 녹화, readiness 근거, 콘텐츠 값과 process identity를 수집한 뒤 footprint를 측정하고, one-view 및 N-view sample 후에 각 녹화의 내용 frame을 고른다. Offline frame decode는 어느 footprint sample도 늦추지 않는다. 독립적인 다섯 process-start 표본에 필요한 추가 view는 N-view 총값을 기록한 뒤에만 연다. 반복 reclaim 표본은 새 view를 녹화하고, 측정하는 close와 footprint 구간이 시작되기 전에 해당 녹화의 내용 frame을 고르므로 frame decode는 그 구간 밖에 있다. 최초 view의 content 근거는 반복 표본 전에 이미 기록한다.

### Source-frame 시계 상관

명시적으로 시작한 view-frame observer는 `{documentTimeOriginMs, sourceNowMs, sourceResolutionMs}`가 있는 `sourceClock` anchor를 반환한다. View는 성공한 시작 command를 처리하는 동안 자기 document의 `performance.timeOrigin`에서 `documentTimeOriginMs`를, 같은 document의 `performance.now()`에서 `sourceNowMs`를 읽는다. `sourceResolutionMs`는 runtime 측정값이 아니라 고정된 WebKit 시계 정밀도 상한 1 ms다. WebKit은 축소된 timer 정밀도를 1 ms라고 설명하고 `Performance` 구현의 기본 정밀도도 1 ms다. Cross-origin isolated 고정밀도는 이 상한보다 정밀하게 만들 뿐이다([WebKit timer-precision 정책](https://webkit.org/blog/8048/what-spectre-and-meltdown-mean-for-webkit/), [WebKit `Performance` 구현](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/page/Performance.cpp)).

호출자는 `diagnostics.clock`을 읽고, 같은 session client에서 시작 command가 성공할 때까지 기다린 뒤 `diagnostics.clock`을 다시 읽는다. 이 bracket 동안 session client·host process·대상 window는 같아야 한다. Start callback은 요청한 surface를 받고 성공 result는 source clock anchor를 포함한다. 성공한 command reply로 observer가 두 native clock 읽기 사이에 시작했음을 확인한다. Native event-log argument는 이 경계를 입증하지 않는다. Native reply 처리가 대상 view generation을 검증하므로 호출자는 불투명한 page 식별자로 generation을 추론하지 않는다. 모든 content-frame row의 `documentTimeOriginMs`는 anchor와 같아야 하며, 이를 통해 같은 view document clock임을 확인한다. Collector는 native clock 원본 두 개와 host process·window identity, surface, source clock 원본 두 개와 원본 frame event timestamp를 보존한다.

Content frame의 경우 `deltaMs = frameTimeMs - sourceNowMs`다. 각 source timestamp는 고정된 1 ms 상한만큼 coarsen될 수 있으므로 native monotonic clock에서 frame의 구간은 `[clockBeforeMs + deltaMs - 2 ms, clockAfterMs + deltaMs + 2 ms]`다. 구간의 하한이 시작 전 clock 읽기 이상일 때만 시작 후 frame으로 본다. 그 경계와 겹치는 구간은 모호한 상태로 보존하며 순서를 증명하는 데 사용할 수 없다. 다만 별도의 frame 구간이 시작 후임을 증명하면 그 모호한 구간 때문에 결과를 실패시키지 않는다. Event 도착 시각, wall-clock 빼기 또는 midpoint 추정으로 모호성을 해소하지 않는다. 선택한 source frame을 capture 또는 native placement와 비교할 때는 전체 구간을 유지하고 구간 전체에서 순서가 성립해야 한다. Source-frame cadence는 계속 같은 document clock의 frame timestamp 차이로 잰다.

| 기준 | 통과 조건 |
|---|---|
| (i) 합계 | 한 plugin의 view N개의 합계 footprint가 view 1개 footprint의 N배 + 10 MB 이하다. |
| (ii) 회수 | 다른 view와 프로세스를 함께 쓰지 않는 view에 적용한다. 함께 쓰는 view는 그 view들과 한 단위로 잰다. 세션 기록이 초기 문서 하나뿐인 상태로 열고 닫은 view를 닫으면, 그 footprint의 90% 이상이 10초 안에 돌아온다(3회 반복). 엔진 cache가 붙잡은 프로세스는 돌아오지 않은 것으로 센다. |
| (iii) 첫 표시 | 프로세스가 이미 실행 중인 view의 첫 표시: view 시작 요청부터 녹화에서 첫 내용 frame까지의 시간이, 같은 plugin과 host의 DOM mount 기준값 + 300 ms 이하다. DOM mount 기준값은 mount를 제거하기 전 표면 mount의 측정이 그 plugin과 host에 대해 기록한 중앙값이다(wailsv3와 tauriv2: browser 13과 22 ms, editor 13과 35 ms, hwp 701과 813 ms, terminal 17과 23 ms). mygo host의 DOM mount 기준값은 그 plugin에 대한 Wails host와 Tauri host의 기준값 중 낮은 값이다. 기준값이 잰 표면 mount는 제거되었으므로 그 기록이 고정 기준값이다. 기록된 값은 mount의 시작부터 끝까지의 시간이며 첫 내용 frame보다 늦지 않으므로, 녹화로 잰 기준값보다 기준이 엄격하거나 같다. 기록값이 없는 plugin(files, shell, flowmark)은 300 ms만으로 판정한다. |
| (iii-b) 새 프로세스의 첫 표시 | 새 프로세스의 첫 표시: (view 시작 요청부터 녹화에서 첫 내용 frame까지의 시간) − (프로세스 시작 시간 5회 중앙값, 각각은 프로세스 요청(`host.trace.view.process-request`)부터 view가 page 런타임을 시작할 때 쓰는 첫 `host.trace.view.process-ready`까지의 시간)이 DOM mount 기준값 + 300 ms 이하다(3회 반복, 성능 trace를 켠 상태로 잰다). |
| (v) 표시 판정값 | card 배치가 바뀐 녹화에서, view의 내용 frame이 그 변경의 첫 frame부터 100 ms 안에 새 크기로 나타난다. |
| (vi) 재시작 한도 | 실패 event가 올 때 실패 시각을 기록하고 그 자리에서 센다(timer를 쓰지 않는다). 최근 300초 안의 실패가 4번째에 이르면 재시작을 멈춘다. 300초보다 오래된 실패는 세지 않는다(sliding window). 멈춘 뒤에도 실패 기록은 남긴다. 그 프로세스가 필요한 표면을 사용자가 열 때만 기록을 비우고 프로세스를 다시 띄운다. |
| (iv) editor 측정 | editor view의 footprint와 숨긴 DOM editor의 footprint를 잰다. view 쪽 footprint가 50 MB를 넘으면 editor의 buffer와 분석을 sidecar로 옮긴다. 이것은 통과 조건이 아니라 측정 규칙이다. |
| (viii) 끌기 | gesture 동안 (a) 매 frame에서 native content 경계와 card 및 독립적으로 선언된 DOM inset으로 구한 예상 composition slot 경계의 차이가 2 pt 이하다(같은 commit, 기대값 0). (b) 내용 frame(view가 자기 document에 그린 frame이며, view의 ResizeObserver 다음 requestAnimationFrame이 내는 표시)의 연속 간격이 40 ms 이하이고, 측정 결과는 화면의 refresh rate를 밝힌다. (c) 최종 content viewport가 gesture 중 마지막 viewport와 다르면, gesture 후 최종 viewport 크기에 도달한 첫 content frame에 대응하는 기록 capture가 있어야 하며, 그 capture의 측정 content 경계는 독립적으로 선언된 composition slot과 2 pt 이내로 일치해야 한다. 해당 capture는 gesture 종료 뒤 40 ms 안에 있어야 한다. recorded frame의 시간은 capture 간격에 따라 달라지므로 한도는 recorded frame 수가 아니라 시간이다. 이후 successful presentation은 최종 target이 결국 표시되었음을 별도로 입증하며 convergence deadline을 늦추지 않는다. |

측정 evaluator는 다른 기준이 실패해도 입력을 수집한 모든 독립 기준을 검사한다. 실패가 하나면 해당 category의 기존 오류를 유지한다. 여러 기준이 실패하면 `AggregateError`로 보고하고, `error.json`에 각 중첩 오류와 원인을 기록해 실패한 모든 기준을 보존한다.

view의 콘텐츠는 view가 자기 namespace에 노출하는 값에서 읽는다. view가 보이는 text를 답하는 content read로, 검사가 그 이름을 정한다. 그리고 section view ready status의 `content`이다. core 검사는 plain view probe fixture의 `probeplain.content.read`를 읽으며, 그것은 그 document region의 text 한 줄을 답한다. (iii)과 (iii-b)의 첫 내용 frame은 값이 예상 콘텐츠를 가진 뒤 첫 presentation의 표시 시각(`host.window.presented`) 이후 첫 녹화 frame이다. 그 시각은 콘텐츠를 보여 준 첫 frame보다 이르지 않으므로, 기준은 pixel로 고른 frame일 때보다 적어도 같은 만큼 엄격하다. (v)의 내용 frame은 새 크기에서 읽은 값의 그 presentation 이후, 그 크기의 source frame보다 이르지 않으면서 측정 배치가 선언된 slot과 맞는 첫 녹화 frame이다.

모든 plugin view는 (i), (ii), (iii), (iii-b), (v), (viii)을 만족하고, 재시작 창 검사는 (vi)을 만족한다. (iv)는 잰다. 기구 값 (v), (vi), (viii)이 실패하면 그 기구에 기대는 일을 멈춘다. plugin 값 (i), (ii), (iii), (iii-b)가 실패하면 그 plugin만 멈추고, 그 plugin의 층이나 view 수는 adversarial review에 올리는 이 명세의 개정판에서 다시 연다. 개정 결정은 소유자가 한다.

### Main-page process 측정

두 window main-page benchmark는 main page 하나와 두 개가 열린 상태를 차례로 기록한다. 원래 window의 `host.window.pageProcess` identity가 두 sample에서 그대로여야 하며, identity가 바뀌면 비교가 유효하지 않다. 각 sample에 window identity와 `host.window.pageProcess`를 보존하고, sampler의 해당 window 및 PID에 대한 `role: "page"` 행을 연결한다. target window의 page sampler 오류 행에 PID가 없어도 오류를 보고한다. `footprint_kb`는 kernel physical footprint이며 `rss_kb`는 sampler 문맥으로만 남기고 대신 사용하지 않는다. 기록에는 sampler event timestamp와 근거를 수집한 시점의 시스템 load average를 포함한다. 같은 PID를 가리키는 owner 행은 하나의 process다. 각 footprint는 monotonic event timestamp와 sequence가 가장 큰 행을 사용해 한 번만 합산하고 window별 reading은 그대로 보존한다. 결과에는 window 수, window별 process identity와 footprint, 고유 process 수 및 전체 physical footprint를 기록한다. 이는 측정이며 통과 기준이 아니다. 새 reading은 sampler의 기존 5초 event와 `host.log` notification으로 기다리고 benchmark가 timer나 polling source를 추가하지 않는다. 성공과 실패 모두에서 추가한 window를 닫고 원래 window identity 집합을 복원한다.

Root document 크기는 CSS viewport 차원이며 native placement frame은 소수점 AppKit point를 보존한다. macOS에서 표면의 root view는 page zoom 1과 native frame 크기의 bounds를 유지하고 backing scale을 device scale factor로 쓰므로, backing scale은 raster 밀도만 바꾼다. root view 안의 document region은 `document.zoom`이 정한 page zoom을 가진다([native surfaces](native-surfaces.ko.md#배치-순서)). WebKit은 양수 bounds의 각 차원을 잘라 정수 layout viewport로 변환하며 [PageClientImpl](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/mac/PageClientImplMac.mm)과 [IntSizeCG](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/graphics/cg/IntSizeCG.cpp)가 이를 정의한다. Source 크기 비교는 이 명시적 투영을 사용하며 원본 native frame과 투영을 각각 보존한다. 실제 native 크기는 gesture 전 settled root-frame baseline과 같은 surface의 시각이 기록된 적용 placement에서 얻으며 capture pixel로 추정한 composition slot은 실제 native-frame 근거가 아니다. One-shot layout 측정은 표시된 capture 시각까지 적용된 요청 후 마지막 visible placement를 선택하고, resize 요청 이후의 source frame이 정확한 projected viewport 크기인지 확인한다. One-shot content capture는 표시된 presentation과 source 구간 상한 이후여야 한다. Placement readback은 resize 요청 뒤, 표시된 presentation 전에 있어야 하지만 source 구간보다 앞설 필요는 없다. Placement trace는 native setter 뒤에 이뤄지는 frame readback을 기록하므로 그 시각을 source frame의 하한으로 사용하지 않는다. Drag convergence는 성공한 최종 presentation의 target viewport와 gesture 중 마지막 source 크기를 비교한다. 둘이 다르면 gesture 후 최종 target 크기인 첫 source frame이 gesture 종료 뒤 40 ms 안에 캡처와 연결되어야 하며, 그 capture의 실제 content pixel도 독립적으로 선언된 composition slot과 2 pt 이내로 정렬되어야 한다. Recording은 기존 final presentation barrier까지 이어져 최종 target의 eventual presentation과 이후 경쟁 source frame을 관찰하지만, barrier 시각이 convergence deadline을 늦추지는 않는다. 개별 source frame에 native readback 시각을 연결하지 않는다. 물리 정렬은 point 단위와 기존 2 pt 기준을 유지하고 source cadence·convergence 기준도 유지한다. 소유 [native geometry 회귀 검사](../../native/darwin/tests/webview_geometry_test.m)는 200.5 pt root의 native 높이 보존, 1x·2x에서 200 CSS-pixel viewport 노출과 마지막 backing row 표시를 확인한다.

두 Editor 측정은 일반 Editor view 하나와 hidden Editor instance만 담은 diagnostic view 하나의 전체 process-group physical footprint 절대값을 사용한다. Hidden reference는 일반·warm Editor view를 모두 닫은 뒤 시작한다. 선언된 시작 모드는 일반 Editor 생성을 건너뛰어야 하며 readiness가 지정 문서, 줄 수와 initial-only history를 보고한다. 기록에 process identity와 sharing member를 포함하며 살아 있는 무관한 surface와 공유하는 reference는 비격리 상태로 거부한다. WebKit/runtime 메모리와 보존된 engine allocation을 포함한다. Before/after process 차이는 hidden Editor footprint가 아니며 유효한 감소를 component 비용으로 바꾸지 않는다. 50 MB 규칙은 계속 일반 view footprint를 사용한다.

HWP first-content recording은 첫 root presentation부터 기존 host DOM mount baseline과 300 ms가 지난 시점까지 계속한다. Root presentation은 독립 document의 표시 pixel을 보장하지 않는다. 이 observation window는 capture 범위만 제공하며 acceptance는 가장 이른 captured content timestamp를 사용하고 new process의 별도 five-start median 보정을 유지한다. HWP reclaim 및 reopen 측정은 layout과 drag 검사 후 초기 선언 card width를 복원하여 responsive editor chrome이 비교 viewport를 바꾸지 않도록 한다.

기준 (iii)은 열린 view가 시작 요청 직전에 이미 실행 중인 process에 배정된 경우에만 적용한다. 측정은 요청 전 process snapshot과 배정된 view process를 기록한다. 새 process에 배정된 열기는 (iii)을 통과가 아닌 해당 없음으로 보고하고 (iii-b)로 측정하며 process 재사용을 강제하지 않는다. 녹화한 pixel은 (viii)(a)의 표시 정렬을 입증하고 소유 layout transaction 검사는 card와 native 배치의 연결을 별도로 입증한다. 캡처 frame은 인과적 commit identifier를 입증하지 않는다.

Drag 중에는 source content-frame 구간이 cadence와 capture coverage를 입증하며 native placement readback과 timestamp를 연결하지 않는다. `placed` trace는 setter 이후 frame을 읽은 결과이며 setter 시각을 나타내지 않으므로 source 구간과 겹친다는 사실만으로 placement 순서 오류를 의미하지 않는다. 원본 native event를 보존하고, 물리 정렬은 기록한 각 capture frame에서 card slot 및 선언된 inset과 별도로 측정한다. Gesture 종료 시 source 차원이 이미 맞더라도 모든 drag에서 캡처한 최종 target paint를 요구한다. 조건을 충족하는 capture에는 upper bound가 해당 capture보다 늦지 않은 target-size source 구간이 있으며 source 구간은 gesture 종료보다 앞서거나 종료와 겹칠 수 있다. Gesture 종료 후 두 recorded frame 및 40 ms 안에 조건을 충족한 가장 이른 paint capture를 선택한다. 측정값에는 capture-derived AppKit point로 표현한 실제 최종 native rectangle이 포함된다. 조건을 충족한 capture와 이후 tail capture는 이 rectangle 및 독립적으로 선언한 card slot과 content inset에 2 pt 이내로 맞아야 한다. 성공한 최종 presentation은 target이 결국 표시되었음을 별도로 입증하며 시각이 convergence deadline을 늦추지 않는다. 기존 두 frame·40 ms convergence 기준을 적용한다. Source cadence와 captured-paint convergence는 각각 명시된 40 ms 이하 기준을 적용하며 40 ms를 넘으면 실패한다.

Native region bounds alignment는 명시적으로 시작한 `diagnostics.document.viewport-marker`를 사용할 수 있다. 불투명 border는 실제 document-region view layer에 붙고 implicit animation을 끈 상태에서 해당 view의 bounds, clipping, visibility 및 transform을 따른다. 배경이나 pointer 처리가 없고 frame이나 document 크기를 바꾸지 않는다. 캡처한 border pixel로 네 native view 경계를 독립적으로 선언된 slot 및 기존 2 pt 기준과 비교하며 보고된 host·DOM rectangle로 pixel을 대체하지 않는다. Border는 native bounds 안에 그리며 width를 AppKit point로 보고한다. Stop은 이전 border style을 복원하고 dispose 및 시작 실패 시 marker를 제거한다. 근거는 native region bounds alignment로 표시하며 CSS viewport paint, 자연 content 범위, source-frame identity 또는 정상 paint cadence를 입증하지 않는다. HTML fixed border는 WebKit viewport paint를 관측하므로 독립적으로 렌더링하는 document region의 native bounds 근거를 대신할 수 없다. HWP convergence는 inset HTML viewport paint marker를 native region bounds marker와 별도로 측정하며 한 측정값을 다른 근거로 사용하지 않는다.

Drag evaluator는 공통 recording 증거를 검증한 뒤 geometry, source cadence 및 final-paint convergence를 독립적으로 판정한다. 한 criterion의 실패가 다른 criterion 평가를 중단하지 않는다. 성공 결과와 직렬화한 오류 모두 개별 결과와 측정값을 보존한다. 유효하지 않은 공통 증거는 통과 criterion 없이 명시적으로 실패한다. 이 보고 규칙은 geometry, cadence 또는 convergence 기준을 변경하지 않는다.

### Section view

view benchmark `e2e/benchmark/section-view.test.mjs`는 section view fixture인 plain view probe `probeplain`의 각 section에 대해 (i), (ii), (iii), (iii-b), (v), (viii)을 그 `sections` 순서로 잰다; plugin은 자기 section view를 같은 계약으로 잰다. section view는 그 section만 담은 set을 보이는 layout probe 카드의 card-left sidebar에서 잰다. view 시작 한 번은 `core.card.split`과 새 layout probe tab으로 가장 높은 layout probe 카드를 아래쪽으로 나누어 새 카드의 card-left sidebar가 그 section을 보이게 하는 일이고, view N개는 그런 카드 N개다. (ii)의 회수는 그 카드를 닫고 section view의 process group만 잰다. 회수 뒤에 section 카드 하나를 더 나눈다. (v)는 `core.grid.size`로 y 축에서 그 카드를 80 pt 높이고, (viii)은 그 카드의 위쪽 경계를 80 pt 아래로 drag했다가 되돌리므로, section view는 자기 카드의 높이를 따른다.

section view의 plugin은 `diagnostics.json`([plugins](plugins.ko.md#진단-선언))에 세 항목을 선언한다. plugin의 command 둘은 plugin의 모든 section view가 자기 표면에서 제공하고, section마다 하나인 status는 그 section의 section view만 답한다:

- command `<plugin>.view.frames {action}`. `start`는 section view에서 `@soksak/plugin-api/diagnostic-view-frames`의 `observeViewDocumentFrames`를 시작하고(그 frame은 이 module의 event `view.content_frame`이다), `{enabled: true, sourceClock, markerColor}`를 답한다. `sourceClock`은 [source-frame 시계 상관](#source-frame-시계-상관)의 anchor이고, `markerColor`는 0부터 255까지의 정수 세 개로 된 RGB 색 `[r, g, b]`이며 활성 theme의 card, background, border 색과 적어도 한 channel에서 4보다 크게 다르다. 그 답부터 `stop`까지 section view는 자기 document root를 `markerColor`로 칠하므로, benchmark는 캡처한 각 frame에서 view의 영역을 찾는다. `stop`은 observer를 멈추고 root를 `start` 전처럼 칠한 뒤 `{enabled: false}`를 답한다.
- command `<plugin>.view.history`. section view의 session history 항목 수 `{length}`를 답한다. section view는 document region을 갖지 않으므로 benchmark는 그 region history를 세지 않으며, document region을 시작한 section view는 (ii)의 회수에서 `view <surface> has <n> started documents but reports 0 region history entries`로 실패한다.
- status `<section id>.view.ready {ready, content}`. `ready`는 section view에 `content`가 실제로 보일 때만 true이고, `content`는 section view가 보이는 text다. benchmark는 view의 콘텐츠를 이 status에서 읽는다. status의 schema는 `content`를 항목 하나짜리 문자열 `enum`으로 선언한다. 이 형식은 [노출의 schema subset](exposure.ko.md#항목-필드)이 허용하고 각 값을 그 형식으로 검사한다. benchmark는 section view를 시작하기 전에 선언에서 그 값을 읽고, status가 이 값과 함께 `{ready: true}`이고 `<plugin>.view.history`가 `{length: 1}`을 답하면 section view가 준비된 것이다.

benchmark는 각 section view를 한 상태에서 시작한다. [`diagnostics.fixture`](endpoint.ko.md#진단-빌드)의 project `test-project`가 열려 있고, section view가 있는 카드의 active tab이 layout probe tab이다. `content`는 section view가 그 상태에서 보이는 text이고, plugin은 측정을 위해 화면을 바꾸지 않는다. plain view probe의 section은 고정된 text `Plain section`을 보이며, 그것이 그 `content`다.

benchmark는 모든 section view를 잰다. benchmark는 설치된 `plugin.json`과 `diagnostics.json`을 `@soksak/plugin-api`의 `validateDiagnostics`로 검사하고, 그 검사가 거부한 선언은 진단 빌드의 시작과 같은 거부로 실패한다. plugin이 세 항목을 선언하지 않은 section view는 `<plugin> section view <id> does not declare <plugin>.view.frames, <plugin>.view.history and <section id>.view.ready in its diagnostics declaration`으로 실패하며, `<id>`와 `<section id>`는 같은 id다. status schema에 `content`의 항목 하나짜리 문자열 `enum`이 없는 section view는 `<plugin> section view <id> declares <id>.view.ready without a single-entry enum content`로 실패한다. 다른 상태에서 시작한 section view는 `<plugin> section view <id> starts with the project test-project, not with <root>`로 실패하며(`<root>`는 열린 project의 root이거나 `no project`다), `<plugin> section view <id> starts with a layoutprobe tab active in card <card>, not with <active tab의 plugin>`으로도 실패한다. active tab이 없는 카드에서는 그 자리가 `no active tab`이다. 올바른 `markerColor`가 없는 `start` 답은 observer를 멈추고 `<plugin> section view <id> trace start must declare a three-channel RGB paint marker color`로 실패한다.

## 규칙

1. workbench 페이지에서는 plugin 코드를 실행하지 않는다.
2. **Sidebar sections.** section 표면은 모든 view의 규칙을 따르는 view 표면이다. 규칙 4의 view channel, 규칙 5의 재시작, 규칙 6의 표시, 규칙 7의 입력, 규칙 10의 unload가 그것이다. section이 보여 주는 값은 탭 view가 받는 것과 같이 view call과 view event로 자기 view에 닿으며, section의 어떤 값도 그리기 위해 workbench를 거치지 않는다. section view는 탭 view와 같이 통과값을 만족하며, [section view](#section-view)의 선언으로 잰다.
3. **경계를 넘는 호출.**
   - 명령은 [exposure](exposure.ko.md)에 적힌 대로 `timeout`을 선언한다(최대 600000 ms, 없으면 10초). timer는 살아 있는 상대가 명령에 답하지 않는 경우에만 남긴다. 느린 명령 답을 알려 주는 event가 없기 때문이다. `host.trace.view.unresponsive`는 WebKit의 응답성 검사에 답하지 않는 view 프로세스를 알리며, 명령 답이 아니므로 timer를 대신하지 않는다. 기한을 넘기면 호출을 -32000과 `command <name> did not reply within <ms>ms`로 거부한다. 이 오류는 [exposure](exposure.ko.md)의 명령 `timeout` 항목이 적는 것이며, 이 설계는 메시지를 바꾸지 않는다. `host.call.timeout {plugin, command}`를 쓰고 `losses.timeouts`를 센다.
   - view는 메인 page의 요청에 자기 command로 답할 때 `{sok: 1, reply: id, result}` 또는 `{sok: 1, reply: id, error}`를 보내며, 호스트는 이를 `view-reply`로 전달한다([native surface](native-surfaces.ko.md#view-표면), view command). 메인 page는 그 요청에 command가 선언한 제한 시간을 적용하며, 제한 시간 뒤의 응답은 늦은 응답으로 버린다.
   - 상대가 사라지면 기한 전에 event로 호출을 끝낸다. 호출을 끝내는 상대는 view 프로세스의 종료, 표면 닫기, sidecar 종료다. promise는 그 이유를 밝힌 오류로 거부한다. reason은 `process-ended`, `surface-closed`, `sidecar-ended` 중 하나다. `process-ended`는 view가 열어 둔 call(메인 page가 답하지 않은 call)을 끝내며 `host.call.peer-lost {plugin, command, reason}`을 쓰고, `surface-closed`는 event를 쓰지 않으며 `losses.peerLost`를 센다. sidecar 종료는 sidecar 실패 계약이 알린다. 응답을 기다리는 식별자 있는 요청마다 surface, sidecar, 식별자를 밝힌 `host.sidecar.reply` 오류가 쓰이고, sidecar에 보낸 각 surface는 `sidecar-failure`를 받는다. host가 멈추거나 떼어내면 기다리는 요청마다 같은 오류를 쓴다. sidecar 요청은 command를 갖지 않으므로 그 경우에 `host.call.peer-lost`는 쓰지 않는다. `host.trace.view.unresponsive`는 호출을 끝내지 않는다. 이 event는 규칙 6의 presentation wait와 view의 status에서만 쓴다. 호출은 선언한 timeout이나 이 상대들 가운데 하나로만 끝난다.
   - 끝난 호출에 늦게 온 답은 버린다. promise에 전달하지 않으며, 답을 보낸 문서에 오류를 보내지도 않는다. 호스트는 `host.trace.call.late-reply {plugin, command, delay}`를 쓰고 `losses.lateReplies`를 센다. host-contract case `exposure-reply.removed-surface-discarded`와 `exposure.relay.foreign-document-reply-ignored-timeout-1005`가 이 동작을 명시한다.
   - 열린 호출 수와 가장 오래된 열린 호출의 시작 시각을 core status `core.plugin.open-calls {plugin, count, oldestStartedAt}`로 노출한다.
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
   - view bridge `@soksak/plugin-api/view`는 파일 `packages/plugin-api/view.js`다. `runtime/`이나 `@soksak/workbench/` 아래의 것을 import하지 않으며, view 쪽 call layer(`calls.js`)와 선언 UI snapshot(`snapshots.js`)을 view 통로로 내보낸다. `createViewReporter({reportError, console})`는 view 페이지가 `createViewBridge`에 넘기는 `report` 함수를 만든다. 오류 report, call timeout, reason이 `surface-closed`가 아닌 lost peer는 페이지의 전역 오류 hook인 `reportError`로 가고, view channel script가 그것을 `view.error`로 application log에 보낸다. open-call 수는 console `debug` 기록이고, 건너뛴 snapshot과 `surface-closed`로 끝난 call이나 snapshot은 console `info` 기록이다. view 페이지는 bridge의 report를 다른 경로로 보고하지 않으며 하나도 버리지 않는다.
   - view channel은 host가 각 view 구성에 주입하는 document-start script이며, 규칙 8의 테마 script와 같다. host 계약이 이름을 정한 message handler `sok-view`를 하나 정의한다. native/darwin은 두 호스트 모두에 대해 handler `sok-view`와 주입 script를 view의 web view 구성에 등록하며, host 계약이 handler 이름을 선언한다. host가 메시지를 view로 보내는 방식은 현재 문서 영역이 받는 방식과 같다: native 코드가 view의 page world에서 `window.postMessage(message, location.origin)`을 실행하며(`sp_document_post`의 형식). 주입된 document-start script는 document 시작 시점에, 어떤 page script보다 먼저 view의 `message` listener를 추가하고, source가 window인 message event를 `createViewChannel()`이 `onMessage`의 handler를 붙이기 전까지 queue에 보관한다. queue는 최대 256개 message를 담고, 호스트 계약에 계약 case와 함께 선언한다. queue가 찬 상태에서 message가 오면 script는 `sok-view` handler로 application log에 `error: view channel: queue full for <plugin>`을 쓰고, 호스트는 view 프로세스를 끝내서, 어떤 호스트 message도 조용히 버리지 않는다. 이 상한은 잰 값이 아니라 정한 값이다. view는 첫 module이 돌 때 통로를 붙이므로 queue는 그 전에 보낸 message만 담는다. `createViewChannel()`은 queue의 message를 순서대로, 이어서 들어오는 message를 모두 넘긴다. host message는 버리지 않는다. 주입된 document-start script는 script가 만든 문서 식별자를 담은 ready message를 `sok-view` handler로 보낸다. 호스트는 view마다 현재 문서의 식별자를 기록하고, ready message를 기록한 문서에만 호스트 message를 보낸다. ready message가 기록되지 않은 view로의 post는 false를 돌려주고, 호출한 쪽은 application log에 `error: view channel: <view> has no ready document`를 쓴다. navigation은 새 문서의 ready message가 올 때까지 기록한 식별자를 지운다. queue는 한 document의 message를 담으며, `core.plugin.views`는 `queued`를 보고하며, 이는 view가 attach하지 않아 queue에서 기다리는 message의 수다. 그래서 attach하지 않는 view가 보인다. host는 host message마다 `sok: 1` field를 붙이며, channel은 이 field가 없는 message를 application log에 error로 기록하고 어떤 handler에도 넘기지 않는다. 주입 script는 전역 `sokView` 하나를 더하며, 그 `attach`가 host 메시지를 읽는 유일한 방법이다. script는 `packages/plugin-api/view-start.js`다. handler 이름과 전달 형식은 host 계약에 선언한다. `@soksak/plugin-api/view`는 `createViewChannel()`을 내보내며, 이 함수는 그 handler 위의 `{send, onMessage}`를 돌려주고 이를 `createCalls`와 `createSnapshotSender`에 넘긴다. handler 이름과 주입 script는 host 계약에 선언하고 계약 case를 둔다.
   - 기여 module과 공용 module은 각각 자체완결 ES module 하나다. 그 안의 상대 import는 그 plugin의 빌드 오류이며, 그 plugin 저장소가 검사한다([경계](#경계-결합-금지)). 기여 module과 공용 module은 view import map의 항목에서만 bare specifier를 import한다. 그 밖의 bare specifier는 소유 plugin의 빌드 오류다.
   - core root는 애플리케이션 frontend로 넘기지 않는다. view는 `/runtime/` 경로를 받지 않으며, `/start.json`, `/environment.json`, `/index.html`, `/runtime/...`과 위에 없는 그 밖의 경로는 모두 not found다.
   - view에 보내는 모든 응답은 view 구성의 plugin id로 `Access-Control-Allow-Origin: soksak://<plugin id>`를 담는다. 요청의 `Origin`이나 `*`는 담지 않는다. 거부한 요청은 이 header를 담지 않는다. WebKit 측정(`native/darwin/tests/core_root_cors_test.m`의 시험 `core_root_cors_test`, macOS 26.6.2 arm64): `soksak://probe` page에서 `soksak://core/m.js`로의 module import는 `Origin: soksak://probe`를 보낸다. 응답이 `Access-Control-Allow-Origin: soksak://probe`를 담으면 import가 성공하며, 같은 module로 매핑하는 import map의 bare specifier도 이 header에서 성공한다. `Access-Control-Allow-Origin`이 없거나 `Access-Control-Allow-Origin: soksak://other`이면 import가 실패하고, CORS 거부를 알리는 TypeError가 난다. 이 절의 header 규칙은 시험이 단언하는 계약이다. WebKit은 `*`도 받아들이지만, 이 규칙은 `*`를 계속 보내지 않는다.
   - Rule 4가 허용하지 않은 plugin B의 파일 요청은 not found로 답하고, 두 호스트 모두 `error: core root: <path> is not granted to <plugin>`을 쓴다. 문서 영역은 core root grant를 받지 않는다.
   - core root는 host 계약이 선언하고 각 호스트가 scheme handler에 등록하는 callback으로 제공하며, 계약 case를 둔다.
   - plugin A의 view가 Rule 4에 따라 허용되지 않은 plugin B의 파일, A가 `dependencies`로 지정한 plugin의 파일, `/start.json`, `/environment.json`, `/index.html`, `/runtime/...`, 그리고 provider가 그 확장점을 선언하지 않은 기여 항목의 파일을 요청하면 각각 not found로 답한다.
5. **재시작.** sidecar와 view 프로세스는 통과값 (vi)의 한도 안에서 다시 띄운다. 한도를 넘으면 호스트는 `error:`를 보고하고 멈춘다.
   - 끝난 view 프로세스는 호스트가 다시 만들고, 새 view는 저장된 탭 상태에서 상태를 복원한다. 한도는 view 표면마다 센다. section 표면도 포함한다. 한도를 넘으면 card나 section 본문이 표시 경로로 오류를 보여 주며, 사용자가 탭을 다시 열 때에만 view를 다시 만든다. section 표면은 사용자가 section을 펼치거나, 그 탭을 고르거나, sidebar 집합을 바꿀 때 다시 만든다.
   - 한도를 넘은 뒤의 다음 요청은 프로세스를 띄우지 않고 `sidecar-failure`(reason `restart limit`)로 실패한다. 실패 기록은 남긴다. 그 프로세스가 필요한 표면을 사용자가 열 때만 기록을 비운다. section 표면에서는 section을 펼치거나, 그 탭을 고르거나, sidebar 집합을 바꾸는 것이 여는 일이다. 그 뒤 프로세스를 띄우며, 호스트는 `host.trace.sidecar.restart-reset {sidecar, surface}`를 쓴다.
   - 표준 입출력 sidecar의 재시작 한도는 [sidecars](sidecars.ko.md#실패)에, persistent service의 재시작 규칙은 [persistent services](persistent-services.ko.md)에 적는다.
   - 다시 띄우면 state는 마지막으로 저장한 값에서 복원한다. 저장하지 않은 state는 잃으며, plugin마다 어떤 state인지 밝힌다.
   - 고장 주입은 진단 build에서만 둔다.
6. **표시.** plugin root view의 위치, 크기 또는 visibility를 바꾸는 각 commit은 해당 view의 presentation을 layout transaction에 참여시킨다. 새로 표시되는 root view와 재생성된 root-view generation도 이전 generation과 기하가 같더라도 참여한다. commit된 위치, 크기, visibility, generation이 같은 placement는 join을 추가하지 않는다. 이 규칙은 gesture 중과 정착 후 모두 적용한다.
   - Join은 plugin root view document에만 적용한다. 하위 document region은 독립적으로 유지되며 root view transaction을 지연시키지 않는다. Join은 layout ticket과 view generation에 연결한다. 이전 ticket이나 generation의 완료는 새 wait를 지울 수 없다. Native 취소는 view-presentation callback을 호출하지 않으므로 ticket 취소 전에 host가 해당 ticket의 pending placement state를 제거하고 join을 포기한다. Ticket 취소는 owner와 ticket으로 범위를 제한해 현재 join 해제로 시작된 다음 request를 취소하지 않는다.
   - 계속되는 gesture(구분선이나 card 끌기) 동안 view의 native frame은 매 frame card와 같은 commit에서 새 기하로 놓는다. 변경된 root view의 presentation을 기다려 다음 native frame이 오래된 root-view pixel을 드러내지 않게 한다. 변경되거나 새로 표시되거나 재생성된 root view에만 wait를 적용해 변경 없는 placement의 barrier를 피한다. 이 수정은 통과값을 변경하지 않으며 전체 gesture는 기존 geometry와 frame 간격 기준을 충족해야 한다.
   - 끌기 gesture 전체의 녹화에서 frame 간격과 기하 오차를 얻고, 통과값 (viii)로 판정한다.
   - 기다림은 다음 가운데 먼저 오는 것으로 끝난다: 해당 ticket과 generation의 view presentation 완료, 해당 layout ticket 취소, view 프로세스 종료, view가 보이지 않게 됨(`hidden` 조상, 선택되지 않은 탭, 닫힌 표면. workbench가 표면마다 이미 알리는 상태를 읽는다), `host.trace.view.unresponsive` 응답 없음 알림. Ticket 취소는 해당 ticket의 pending placement state를 제거하고 native ticket 취소 전에 join을 포기한다. 마지막 join이 활성 transaction을 먼저 해제하면 완료된 ticket의 취소가 다음 queued ticket에 영향을 주지 않는다. 활성 native 취소는 owner와 ticket이 일치할 때만 transaction을 해제하고 대기 중인 request를 제거하며 적용된 기하를 되돌리지는 않는다. Window teardown은 owner-wide 취소로 해당 owner의 모든 queued request를 제거한다. 취소된 request는 오류를 반환하며 성공한 presentation으로 기록하지 않는다. 그 밖에 presentation 전에 끝나면 native join을 포기하고 해당 view 없이 layout을 계속 진행하며 `host.trace.view.presentation-abandoned {surface, reason}`을 쓰고 `losses.abandoned`를 센다. 취소되거나 대체된 ticket의 늦은 callback은 새 wait를 끝내지 못한다. host가 wait를 소유하고 각 종료를 관찰하므로 event도 host가 쓴다. timer는 쓰지 않는다.
   - performance trace가 켜져 있으면 `host.trace.view.presentation-join {phase, surface, generation, ticket}`가 root join 요청, 결과, native callback 및 presentation 없이 끝난 상태를 기록한다. `result`에는 `joined`, `abandoned`에는 `reason`도 포함한다. 요청은 native join 호출 전에, 결과는 호출이 반환된 뒤, callback event는 UI dispatch 전에 callback을 받은 시점에 쓴다. 따라서 동기 callback은 result event보다 먼저 기록될 수 있다. `presented`는 native callback 실행을 뜻하며 layout commit을 뜻하지 않는다. 포기 후 받은 callback도 같은 identity로 기록하지만 종료된 wait를 되살리거나 완료하지 않는다.
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
   - 넘긴 workbench 명령이 실패하면 `workbench.input.shortcut.failed {plugin, command}`로 알리고, call은 그 오류로 답한다.
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

RPC protocol 번호는 0.0 계열에서 1이다.

**Event.** 각 event 이름은 층(`host` 또는 `page`)으로 시작한다. class는 다루는 관심사(`call`, `lifecycle`, `input`)를 나타낸다. 각 event는 그것을 쓰는 코드와 함께 [event catalog](events.json)에 선언한다.

| event | class | level | field |
|---|---|---|---|
| `host.call.timeout` | call | error | `{plugin, command}`. 카운터 `losses.timeouts` |
| `host.call.peer-lost` | call | error | `{plugin, command, reason}`: `process-ended`(view call). `surface-closed`는 event를 쓰지 않고 `losses.peerLost`를 센다. sidecar 종료는 sidecar 실패 계약이 알린다 |
| `host.trace.call.late-reply` | call | debug | `{plugin, command, delay}`. 카운터 `losses.lateReplies` |
| `host.trace.view.unresponsive` | call | debug | `{plugin, surface}`. 상태 `core.plugin.views.responsive` |
| `host.trace.view.responsive` | call | debug | `{plugin, surface}`. 상태 `core.plugin.views.responsive` |
| `host.trace.view.process-request` | call | debug | `{plugin, surface}` |
| `host.trace.view.process-ready` | call | debug | `{plugin, surface}` |
| `host.trace.view.callback-cancelled` | call | debug | `{surface, reason}`; reason은 `retired-origin` 또는 `window-closed` |
| `host.trace.view.presentation-abandoned` | call | debug | `{surface, reason}`. 카운터 `losses.abandoned`. host가 wait를 소유하므로 host가 쓴다 |
| `host.trace.view.presentation-join` | call | debug | `{phase, surface, generation, ticket}`. `phase`는 `requested`, `result`, `presented`, `abandoned` 중 하나다. `result`에는 `joined`, `abandoned`에는 `reason`이 추가된다. abandonment 뒤 callback이 올 수 있으며 `presented`는 layout commit을 뜻하지 않는다 |
| `workbench.input.shortcut.failed` | input | error | `{plugin, command}` |
| `host.trace.sidecar.restart-reset` | call | debug | `{sidecar, surface}` |

status `core.plugin.open-calls`, `core.plugin.losses`, `core.plugin.views`는 `packages/workbench/exposure.json`에 선언한다.

**릴리스의 event level.** 0.0.x 릴리스는 error event만 저장한다(AGENTS.md, Diagnostic code). 따라서 이 설계의 각 발생은 한 번 분류한다.
(a) 실패나 거부된 연산은 level `error`의 event다.
(b) 손실, 건너뜀, 일시 상태, 표시 품질 저하는 event가 아니다. 선언된 status `core.plugin.losses {plugin, abandoned, lateReplies, timeouts, peerLost}`에 센다. 이것은 선언된 status `core.plugin.views {plugin, surface, responsive, queued}`의 상태이기도 하다. 각 수는 바뀔 때마다 status 구독자에게 알린다. 수는 plugin마다 세며 앱이 끝날 때까지 유지한다. 표면이 닫힐 때 0으로 되돌리지 않는다.
성능 trace가 켜져 있으면(설정 창의 디버그 switch) 수가 바뀔 때마다 표에 적힌 trace event도 쓴다. 릴리스의 event log는 error event만 저장한다.

코드의 식별자는 여기에 적은 이름을 그대로 쓴다.
## 경계 (결합 금지)

- core가 하는 일은 기구뿐이다. view 구성 종류, tab과 section view의 자리, RPC와 binary 통로, core root, 재시작 한도, 계약 case가 여기에 든다.
- 규칙 4의 view channel이 view의 유일한 전송 통로다.
- 각 plugin의 층, plugin state를 sidecar로 옮기는 일, editor buffer를 옮기는 일은 plugin과 sidecar 저장소의 일이다. core 코드와 시험은 plugin과 sidecar의 이름, 경로, 구현을 모른다.
- 관계는 manifest의 `dependencies`, `extends`, `contributes`로만 맺는다. core root가 plugin B의 파일을 plugin A에게 주는 것은 granted item이나 공용 대상일 때뿐이며, 그 판단도 이 선언과 설치 기록으로 한다(규칙 4).
- 플러그인 저장소 요구: 기여 module이나 공용 module을 제공하는 plugin의 저장소는 자기 시험에서 그 module이 각각 자체완결 ES module 하나인지 확인한다. 그 안의 상대 import는 그 plugin의 빌드 오류다.
- 시험:
  - core 시험은 자기 경계를 fake plugin fixture로 검증한다.
  - 공통 계약 case(RPC, 재시작)는 소유 package인 core와 두 호스트가 구현하고 실행한다. core는 소비자에게 필요한 fixture를 공개한다. 각 plugin 저장소는 그 fixture로 자기 module만 시험하며, core의 case를 실행하거나 core의 경로를 읽지 않는다. replay하는 각 fixture는 `contract-copies.json`이 선언하는 byte 사본으로 두고, registry 검사가 그 사본을 각 listed core의 게시된 파일과 비교한다([contract 사본](plugins.ko.md#contract-사본)).
  - 실제 plugin을 띄우는 측정과 창 검사는 설치된 환경의 end-to-end 검사이고, package 시험이 아니며, core 나 plugin 의 어떤 release 도 막지 않는다.

## 검증 경계

각 check 는 세 소유자 중 하나에 속하며, 앞의 둘만 release 를 막는다.

- core: core release 의 window check, benchmark, candidate acceptance 는 `e2e/fixtures` 의 fake plugin fixture 만으로 core 앱을 실행한다. registry index 를 설치하지 않고, plugin 이나 sidecar 저장소를 build 하지 않으며, 실제 plugin 이나 sidecar 를 이름 짓지 않는다.
- plugin: plugin 동작의 check 는 그 plugin 저장소에서, 공개된 core 앱을 대상으로, 공개된 `@soksak/window-check` 로 실행된다. 그 plugin 의 release 를 막는다.
- 환경: 공개된 core 와 plugin release 의 설치 cohort 는 양쪽이 공개된 뒤 registry 가 check 한다. 이 check 는 어떤 release 도 막지 않는다.

[verification-boundaries.json](verification-boundaries.json) 은 실제 plugin 이나 sidecar 를 설치, build 하거나 이름 짓는 core 의 모든 파일을 그 소유자에게 배정한다: `core`(check 가 plugin 을 거쳐 core 경계에 닿으며 core fixture 로 옮긴다), `plugin:<id>`(check 를 그 plugin 저장소로 옮긴다), `environment`, `tool`(실제 plugin 을 설치, build 하거나 이름 짓는 helper 로, 제거하거나 core fixture 로 줄인다), `mixed`(이유가 test 마다 배정한다). 파일이 더 이상 실제 plugin 이나 sidecar 를 이름 짓지 않으면 목록에서 빠진다.

`make check-boundaries` 는 어떤 plugin 도 알지 않고 core 소유자를 강제한다. core 의 window check, benchmark, harness module, 곧 `e2e/` 와 `scripts/` 의 source 중 `e2e/test/` 와 `scripts/test/` 의 headless test 와 ledger `scripts/check-tests.mjs` 를 뺀 것에서, check 가 이름 짓는 모든 plugin 은 `core`, host, `e2e/fixtures` 의 fixture plugin(그곳 `plugin.json` 의 `id`), 또는 check 가 설치되지 않은 plugin 으로 이름 짓는, `e2e/fixtures/absent-plugins.json` 이 선언한 absent plugin 이어야 한다. fixture registry 는 absent plugin 을 설치하지 않으며, 어떤 fixture `plugin.json` 도 그 id 를 쓰지 않는다: plugin id(`plugin: "<id>"`, `plugin === "<id>"`, `sok plugin install|remove|update <id>`, 설정 key `plugin:<id>` 와 `link:<place>:<id>`)와, check 가 `run`, `get`, `until`, `registered`, `watch` 에 넘기거나 section, set, element 로 이름 짓는 status, command, element, section, set `"<id>.<name>"` 의 namespace 다. check 가 event 나 status `"sidecar.<name>.<event>"` 로 이름 짓는 모든 sidecar 는 `e2e/fixtures/sidecars` 의 fake sidecar 여야 하며, 그 이름은 package 이름의 `sidecar-` 뒤 부분이다. `verification-boundaries.json` 이 나열한 파일은 변환이 그 행을 지울 때까지 면제되므로, 목록이 비면 면제도 끝난다. core release 의 gate 인 `Makefile`, `scripts/test-app.mjs`, `scripts/acceptance-run.mjs`, `scripts/candidate-acceptance.mjs` 가 registry index URL, plugin 저장소 경로(`../plugins`, `../sidecars`), `target/fixture-registry` 가 아닌 registry 폴더를 이름 지으면 감사는 실패한다. 각 발견은 파일, 줄, 이름을 밝힌다.

core check 의 fixture registry 는 `scripts/fixture-registry.mjs` 가 `e2e/fixtures` 만으로 build 한다: `plugin.json` 이 있는 모든 folder 는 plugin 이고, `sidecar.json` 이 있는 `e2e/fixtures/sidecars` 의 모든 folder 는 현재 platform 용으로 release 되는 fake sidecar 이며, pack `fixtures` 하나가 모든 fixture plugin 을 이름 짓는다. `make build-fixture-registry` 는 그것을 `target/fixture-registry` 에 쓰고, window check 는 `fixtureRegistry` 로 자기 folder 를 build 한다. `make test-app` 과 다른 end-to-end target 은 `make build-fixture-registry` 로 그것을 build 하고, `scripts/test-app.mjs` 는 pack `fixtures` 의 모든 plugin 을 각 앱에 설치한다. candidate 나 prebuilt run 은 `make fixture-registry` 와 시험하는 bundle 의 `sok` 으로 자기 checkout 에서 설정 root 에 그것을 build 한다.

core window check 의 시작 layout(`e2e/fixture.mjs` 의 `fresh`)은 앱 환경의 `workspace.grid` 가 선언하는 새 공간 layout 이며, core 코드는 그 layout 의 plugin 을 고르지 않는다. 그 layout 의 tab 은 공개 starter 의 plugin 을 이름 짓는데 fixture 설정은 그것을 불러오지 않으므로 placeholder 로 열리고, `fresh` 는 placeholder 마다 같은 card 에 layout probe `layoutprobe` 의 tab 을 대신 둔다. 시작 tab 은 초점 card 의 활성 tab 이다. layout probe 는 시작 값, 크기, document region 을 보고하고 check 의 card sidebar 가 보여 주는 section 과 set 을 선언하므로 plain-view probe 대신 고른다.

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

plugin 문서는 `POST soksak://<plugin>/.binary`로 byte를 올리고 `GET soksak://<plugin>/.binary/<id>`로 내려받는다. id는 host가 만들고, byte는 영역이나 view인 문서가 자기 binary store에 보관한다([native surfaces](native-surfaces.ko.md#문서-영역)). 소유자 검사는 문서의 `view.plugin`을 URL host와 비교하는 것이다. 한 번의 upload는 16 MiB 이하이며, 이는 두 호스트의 클립보드 상한이다(darwin 클립보드의 `MAX_BYTES`, wailsv3의 `clipboardMaxBytes`). 한 페이지는 64 MiB 이하를 가지며, 이는 가장 큰 upload 4개 분량이다. id는 download가 끝날 때, native take가 byte를 돌려줄 때, 또는 문서가 닫힐 때 해제한다. view call의 binary payload는 두 방향 모두 이 경로로 오간다. view는 byte를 올리고 call에 그 id를 보내며, host는 view의 store에서 byte를 take한다. 응답에서는 host가 upload의 한도로 byte를 view의 store에 put하고 그 id로 답하며, view가 byte를 내려받는다. view call `runtime.clipboard.read`의 `"png"`와 `runtime.clipboard.persistPNG`는 PNG를 이렇게 나른다([native surfaces](native-surfaces.ko.md#view-표면), view call). plugin release는 `.binary` 경로 부분을 거부한다. host가 파일 조회보다 먼저 그 경로에 응답하므로, 그 아래의 plugin 파일은 닿을 수 없기 때문이다. release 검사는 `@soksak/plugin-api`의 `validateReleaseFiles`이며, `sok plugin pack`도 같은 거부를 적용한다.

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

모든 plugin view의 continuous-drag 측정은 process와 one-shot layout 증거 수집 뒤에만 전역 performance tracer를 끄고 log policy를 `frame: trace`로 줄인다. 명시적인 source-frame observer, clock bracket, input과 capture pixel은 유지한다. 설정 command가 완료되고 policy 파일이 줄인 policy를 담은 뒤에 observer와 gesture를 시작한다. Recording과 observer 종료 및 event flush도 이 mode 안에서 수행한다. Action이 실패해도 reclaim 수집 전에 저장한 performance 설정과 log policy를 정확히 복원한다. 측정 artifact에는 phase mode와 두 log policy를 기록한다. 이 방법은 cadence, geometry 또는 convergence 기준을 바꾸지 않고 측정 gesture에서 무관한 profiling 작업과 call 기록을 제외한다.
