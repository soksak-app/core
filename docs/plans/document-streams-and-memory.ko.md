# 문서 스트림과 메모리

[English](document-streams-and-memory.md)

## 문제

3일 사용 뒤 브라우저 탭 하나가 1.31 GB, workbench page가 242 MB(Wails)와 291 MB(Tauri), host가 각각 약 154 MB로 재어졌다. 그 탭은 browser plugin의 문서 영역이다. 그 비용의 일부는 host 스크립트가 정한다:

- 요소 트리가 바뀔 때마다 문서 트리 전체를 다시 훑는다. 요소가 n개면 변경마다 O(n)이다.
- 변경마다 바뀐 것이 아니라 요소 목록 전체를, 리소스마다 리소스 목록 전체를 보낸다.
- 소비자가 읽든 말든 목록을 만들고, 목록이 `document-state` 안에 실려 가므로 상태가 바뀔 때마다 직렬화되어 workbench page로 보내진다.

1단계가 Red로 커밋하는 `document_view_test`의 native 검사가 그 메시지 양을 쟀다: 50개 task에서 요소 트리를 50번 바꾸자 기대한 많아야 2번이 아니라 각각 전체 목록을 가진 상태 보고가 51번 나갔다. 이 양이 1.31 GB의 원인인지는 아직 보이지 않았고, 순서의 1단계가 그것을 잰다.

## 목표

- **엔진 비용만 쓰는 브라우저 탭.** host 스크립트가 있는 browser plugin 탭의 메모리와 CPU는 host 스크립트 없는 문서 영역에서 같은 page를 열 때와 다섯 번 실행의 사분위 범위 안에서 같다. 스크립트가 더하는 모든 비용은 없앤다.
- **늘어나지 않는 애플리케이션.** workbench page와 host는 반복 조작에서 객체 수를 일정하게 유지한다.
- **표준 방식만.** 각 변경은 엔진의 표준 방식이다. 어떤 변경도 기능을 없애거나 데이터를 숨겨 수치를 낮추지 않는다.

## 문서 스트림

문서의 요소와 요청은 `document-state`와 분리된 자기 스트림이 되고, inspector가 보이는 동안만 모으듯 page가 구독하는 동안만 모은다:

- **구독.** page는 영역의 요소 스트림이나 요청 스트림을 구독하고, 구독을 끝내는 handle을 받는다. host는 영역과 스트림마다 구독자 수를 세어 첫 구독자에서 수집을 시작하고 마지막 구독자에서 멈춘다. host는 각 구독을 그것을 만든 page에 묶고, 그 page가 새 문서를 불러오거나 그 web content process가 끝나거나(`webViewWebContentProcessDidTerminate:`), 그 영역이나 창이 닫히면 지운다. 마지막 제거는 요청 기록을 놓는다. 그래서 다시 불러오기나 비정상 종료가 수집을 새게 하지 않는다. browser plugin의 패널은 보이는 동안 구독한다. 스트림을 노출하는 plugin의 status는 subscribe 함수에서 스트림을 열고 stop 함수에서 닫는다. 관찰 없이 읽으면 스냅샷 하나를 위해 스트림을 열고 닫으며, 10초 안에 스냅샷이 오지 않으면 명시적 오류로 실패한다.
- **요소: 흐름 제어 아래 스냅샷.** 구독은 시작할 때 스냅샷 하나를 받는다. 문서의 observer는 트리가 바뀌었다고 표시만 한다. 스냅샷의 경로는 native, host, 구독자 page 순이다: native는 스냅샷 `seq` N을 host에 보내고, host가 N을 확인할 때까지(`stream.ack {document, stream, seq}`, host에서 native로) 다음 스냅샷을 보내지 않는다. host는 영역과 스트림마다 스트림 하나를 들고, 스냅샷을 모든 구독자 page에 전하고, 전했을 때 native에 확인한다. 각 구독자는 최신 스냅샷만 가진다. 그래서 확인되지 않은 스냅샷 동안의 변경은 정확히 스냅샷 하나를 더 만들고, 순회는 변경마다가 아니라 확인된 스냅샷마다 한 번 돈다. 스냅샷은 `{seq, nodes, total, truncated}`다: 많아야 500개 요소, 문서의 요소 수 `total`, `total`이 더 크면 `truncated`. 패널은 잘림을 전체 수와 함께 보인다. 순회는 주 프레임 문서의 요소 트리를 덮고, shadow root와 frame은 지금처럼 그 밖이며 명세가 그것을 밝힌다.
- **요청: 새 항목만.** 스크립트는 `buffered: true`로 리소스 항목을 관찰하고 새 항목 묶음만 보내며 전체 목록을 다시 보내지 않는다. page의 스크립트가 소유하는 resource timing buffer는 비우지 않는다. observer는 그 buffer가 찼든 아니든 모든 항목을 받으므로, 찬 buffer는 스트림의 항목을 버리지 않는다. 스트림은 새 구독자를 위해 많아야 200개 항목의 기록을 두고 그 넘어 버린 항목 수를 각 메시지의 `dropped`로 세며, 패널이 그것을 보인다.
- **탐색.** 새 문서는 `reset`을 보내고, 이것은 확인되지 않은 스냅샷을 버린다. `seq`는 탐색을 넘어 계속 늘어나므로 이전 스냅샷의 확인은 아무것도 놓지 않고, native는 보내지 않은 `seq`의 확인을 명시적 오류로 거부한다. 그다음 새 문서의 스냅샷이나 탐색 항목을 보낸다. 스냅샷을 확인하지 않는 host는 다음 스냅샷을 대기로 둔다. 구독은 page나 그 process와 함께 끝나고, 그때 대기 스냅샷을 놓는다.
- **한 release.** `document-state`에서 목록을 빼는 것과 스트림을 읽는 browser plugin은 함께 게시한다. browser plugin release는 그 core release를 요구하고, 3단계가 `document-state`의 모든 독자를 나열한다.
- **용어.** `stream`과 `snapshot`은 3단계에서 용어 목록에 더한다. 스트림의 status는 관찰되는 동안 구독하고, `subscribe`가 그 동작을 이름한다.
- **작은 상태.** `document-state`는 `url`, `title`, `loading`, `progress`, `canGoBack`, `canGoForward`, `error`, `scroll`, `history`, `link`를 가진다.

## 엔진 동작

문서 영역은 WKWebView 위에서 돈다. 아래 동작은 각각 쓰는 API, 단위 Red와 Green, private API일 때 목록 항목을 가진 자기 항목이며, 문서 영역의 전후 측정과 함께 채택한다:

- process 모델: 한 사이트의 문서 영역이 WebContent process와 website data store를 함께 쓴다.
- 숨은 영역: 보이지 않는 영역이 타이머, 렌더링, 미디어를 throttle한다.
- memory pressure: 영역이 시스템 memory pressure에 응답한다.
- cache: 영역의 back-forward cache와 memory cache에 한도가 있다.

## 브라우저 benchmark

추적되는 benchmark 타깃이 정해진 목록의 각 사이트를 문서 영역에서 잰다. 목록에는 트리를 쉬지 않고 바꾸는 page가 들어 있다. 사이트마다 탭이 없는 기준값 대비 content, graphics, network process의 메모리 증가, 쉴 때와 백그라운드의 CPU, 로딩 시간, 입력 지연을 적어도 다섯 번 실행의 중앙값과 사분위 범위로 보고한다. 이 저장소에 귀속되는 각 비용은 자기 단위 시험이 원인을 재현하고(Red) 수정 뒤 통과하는(Green) 항목이 된다. benchmark는 수정의 증거가 아니다.

## 측정 단계

0.0.x release는 event log와 performance trace가 켜진 진단 build이며, 그 둘이 자기 메모리와 CPU를 쓴다. 그래서 측정은 두 단계로 돈다:

1. **기록과 증명.** 모든 측정은 애플리케이션의 event log와 performance trace에서 얻는다: 각 process의 메모리, 객체 수, 스트림 메시지. 그 기록이 각 발견과 각 Red, Green의 증거다.
2. **최종 검증.** event log와 performance trace를 끄고 benchmark를 다시 돌린다. 설정 `diagnostics.log`를 가장 낮은 수준으로 두고 performance trace를 끄며, benchmark 명세가 그 방법을 밝힌다. 브라우저 benchmark와 애플리케이션의 일정한 수치는 이 실행으로만 판정한다.

## 메인 애플리케이션

workbench page와 host를 세 갈래로 조사한다:

1. **기반.** 창의 web view와 process를 만들고 설정하는 두 host의 코드, 그리고 그것이 메모리를 붙잡는 곳.
2. **개선.** 이 저장소가 설정이나 업스트림 수정 채택으로 없앨 수 있는 각 원인. 업스트림 결함은 재현과 함께 업스트림에 보고하고, 수정에 필요한 업스트림 release는 체크리스트 항목이며 그 release가 게시될 때까지 수정은 미게시다.
3. **우리 결함.** 이 저장소가 붙잡는 page나 host의 객체: listener, registry, 이전 page의 문서.

메인 애플리케이션 조사에서는 수치가 먼저다: page나 host의 객체 수는 아직 없고, page의 유일한 메모리 값은 WKWebView가 주지 않는 `usedJSHeapSize`다.

- 두 host의 선언된 진단 명령이 host의 객체 수(surface, region, document, sidecar session, 대기 중인 응답, event 구독자)와, page와 각 문서의 요소 수와 문서 수를 돌려준다. JavaScript heap 객체 수는 플랫폼이 주고 private API 목록이 기록하는 interface로만 더하고, 그렇지 않으면 쓸 수 없다고 밝힌다.
- performance trace의 메모리 표본이 host, page process, 모든 문서 process를 그 window, surface와 함께 잰다.
- 추적되는 benchmark 타깃이 일회용 설정으로 돌고 있는 host에 `endpoint.json`으로 연결하고, 조작을 끝내는 status 알림 뒤마다 읽은 연속된 두 수치가 같아지면 기준값을 기록하고, 정해진 조작 묶음을 N번 반복하고(종류별 탭 열고 닫기, 카드 분할과 닫기, plugin 다시 불러오기, project 창 열고 닫기) 같은 가라앉힘 뒤 수치와 resident 크기를 다시 기록한다. 가라앉힘 뒤에도 N에 따라 늘어나는 수치마다 자기 항목을 가진 결함이다: 추적되는 시험이 늘어남을 재현하고(Red), 변경이 객체를 붙잡는 참조를 없애고, 같은 시험이 일정한 수치를 보인다(Green).
- host 메모리에서 performance trace의 몫을 trace를 켜고 끈 상태로 잰다. trace는 0.0.x release에서 켜진 채 남고, 잰 비용은 trace를 끄는 것이 아니라 trace 안에서 줄인다.

## 검증

- 원인 benchmark: 추적되는 타깃이 큰 요소 트리를 쉬지 않고 바꾸는 page를 문서 영역에 열고, 현재 스크립트일 때와 수집을 끈 때의 1000번 변경당 WebContent footprint 증가를 숫자로 밝힌다. 1.31 GB를 낸 같은 사이트도 잰다. 그 크기가 재현되지 않으면 그 크기의 원인은 증명되지 않은 채 그렇게 기록된다.
- native: 구독자 없는 문서는 50개 task의 50번 변경에 요소나 요청 데이터를 보내지 않는다. 구독자가 있으면 확인되지 않은 스냅샷 하나 동안의 50번 변경이 정확히 스냅샷 하나를 더 만든다. 요청 스트림은 새 항목만 보내고 timing buffer를 비우지 않는다. 탐색은 `reset`을 보내고 확인되지 않은 스냅샷을 버리고 `seq`를 계속 늘린다. 보내지 않은 `seq`의 확인은 거부된다. 마지막 구독이 끝난 뒤와 구독의 영역이 닫힌 뒤 구독자 수는 0이고 요청 기록에 항목이 없다.
- host: 구독 호출, 구독자 수, native로의 확인, 다시 불러오거나 process가 끝난 page의 구독 제거, 그 오류를 두 host의 계약 사례로 둔다. 구독을 끝내지 않고 다시 불러온 구독자 page는 50번 변경에 요소 데이터를 남기지 않고, process가 끝난 page는 구독자 수 0을 남긴다.
- 객체 수: 진단 명령과 각 수치를 두 host의 계약 사례로 둔다.
- plugin-api: 구독 handle이 스트림을 끝내고, 스냅샷이 이전 것을 바꾸며, 확인이 다음 스냅샷을 보낸다.
- browser plugin: DOM, Network 패널이 보이는 동안 구독하고, status `browser.elements`, `browser.requests`가 관찰되는 동안 구독하고 관찰 없는 읽기에 스냅샷 하나를 받으며, 둘 다 이전과 같은 내용을 그린다.
- 브라우저: [브라우저 benchmark](#브라우저-benchmark)의 타깃이 사이트마다 각 수치를 보고한다.
- 메모리: 메인 애플리케이션의 benchmark 타깃이 반복마다 수치를 보고한다.
- 각 변경은 `make docs-check`와 닿는 구조 검사를 돌린다: `make boundaries`, status에 `make exposure-check`, 스트림 event에 `make events-check`, host에 `make parity-check`.

## 순서

1. 메시지 양의 native Red.
2. WebContent process의 footprint를 읽는 자기 타깃인 원인 benchmark. 그 수치는 1단계 측정에서 원인을 찾고, 11단계가 그것을 확인한다.
3. 스트림과 구독의 명세, 용어, 그리고 명세가 그 내용을 가지면 이 계획의 제거.
4. native 스트림과 그 검사.
5. 두 host와 plugin-api의 구독 호출, `document-state`에서 목록 제거, 그리고 그것을 싣는 core release. 이 release는 6단계의 release와 함께 게시한다.
6. browser plugin 저장소에서 그 core release를 선언하고 패널과 status를 스트림 위로 옮긴다. 그 release는 core 체크리스트 항목이며, 수정은 그 release가 게시될 때까지 미게시다.
7. 객체 수 명령과 모든 web process의 메모리 표본.
8. 엔진 동작과 브라우저 benchmark. 발견마다 항목 하나.
9. 메인 애플리케이션 조사(기반, 개선, 우리 결함)와 그 benchmark. 발견마다 항목 하나.
10. host 메모리의 trace 몫.
11. event log와 performance trace를 끈 최종 검증.

2, 8, 9, 10단계는 재어서 발견을 낸다. 각 발견은 자기 단위 Red와 Green을 가진 항목이다.
