# 네이티브 표면 배치

[English](native-surfaces.md)

승인된 단일 DOM 모델은 [표면 합성](surface-composition.ko.md)과 [플러그인 모듈](plugins.ko.md#표면-모듈-소유권)이 정의한다. 논리 표면은 WebView가 아니다. 네이티브 창 상태는 그리기 순서가 아닌 등록한 네이티브 뷰로 앱 DOM을 식별하며 문서 WebView는 앱 DOM 아래에 있다. `appDomWebviews`와 `documentWebviews`는 네이티브 계층에서 측정한다. 상수를 개수로 보고하거나 첫 자식을 메인 뷰로 추정해서는 안 된다. [기능 상태](../features.ko.md)는 통합과 검증을 분리하여 기록한다.

이 명세는 예제 애플리케이션의 표면 배치를 정의한다. 구현 및 검증 상태는 [기능 상태](../features.ko.md)에 기록한다.

## 책임

- 배치 라이브러리는 카드 사각형을 계산하고 카드 DOM 요소를 갱신한다.
- 예제 컴포지터는 카드 사각형과 DOM 내부 여백으로 표면 사각형을 계산한다.
- 호스트는 네이티브 뷰를 생성하고 표면 사각형을 적용한 뒤 실제 좌표를 반환한다.
- macOS 표시 처리는 창의 단일 앱 DOM이 표시를 확인하고 보이는 모든 그림 영역에 정확한 현재 래스터가 준비된 뒤 네이티브 좌표를 커밋한다.

호스트는 DOM과 네이티브 렌더링의 차이가 최대 한 프레임이라고 가정하지 않는다.

## 배치 순서

1. 카드 DOM을 갱신하기 전에 페이지가 다음 표면 사각형을 제출한다.
2. 호스트는 해당 창의 배치를 위해 UI 스레드의 레이어 트랜잭션 사용을 시작하고 네이티브 사각형 전체를 적용한다. 응답에는 실제 좌표와 준비 전체의 식별자 하나를 포함한다.
3. 준비가 완료되면 페이지가 카드 DOM을 갱신하고 해당 식별자의 표시를 요청한다.
4. 창의 앱 DOM이 표시를 확인하고 필요한 그림 래스터가 준비되면 호스트가 트랜잭션을 커밋하고 실제 좌표를 반환한다. [문서 영역](#문서-영역)은 독립적으로 렌더링하며 URL 출처와 무관하게 DOM 표시 대기에 참여하지 않는다.
5. 응답 후 페이지가 대기 중인 최신 배치의 준비를 시작한다. 시작하지 않은 이전 배치는 더 새 배치로 대신되며, 대신된 배치의 준비와 그리기는 실행되지 않는다. 가장 새 배치는 앞선 입력을 모두 담는다. 표시가 정착하면 페이지는 대신된 배치의 수를 애플리케이션 로그에 기록한다.

워크벤치 배치 콜백은 대상 표면의 식별자·흐림·대상 슬롯 여백을 카드 사각형과 함께 캡처한다. 대상 여백은 측정한 슬롯에서 이전에 그린 사이드바 영역을 빼고 요청한 카드 상태의 영역을 더한다. 컴포지터는 이전 사이드바 배치를 다시 읽지 않고 캡처한 기하를 사용한다. 측정할 수 없는 기존 슬롯은 null로 명시하고 준비 동안 숨긴다. 잘못된 여백 값은 오류다.

네이티브 표면을 대기 중인 사각형들의 교집합으로 일시 축소하지 않는다. 다음 슬롯과 일치하지 않는 표면은 DOM 변경 전에 숨긴다. 페이지가 다음 슬롯을 잰 표면은 준비 동안 새 사각형에 보인 채로 둔다. 준비의 변경은 창의 열린 트랜잭션 안에 있어 화면에 나오지 않으며, 그때 표면을 숨기면 화면에 아직 그 표면이 보이는 자리의 누름이 표면 대신 페이지로 간다. 그리기 후 측정으로 새 사각형을 제공한다. 첫 응답자를 담은 뷰를 숨기면 AppKit은 첫 응답자를 다른 뷰나 창으로 옮기므로, 배치 중에 숨긴 표면은 키보드 소유자를 기록하고 다시 보일 때 포커스를 그 소유자에게 되돌린다. 숨긴 동안 포커스가 옮겨졌으면 되돌리지 않는다.

`hidden` 속성을 가진 요소 안의 표면은 마운트를 유지하지만 표시하지 않는 상태로 제출한다. 카드 전체 화면은 이 속성으로 다른 카드를 숨기며, 원래 배치를 복원할 때까지 해당 표면과 세션을 유지한다.

폭 또는 높이가 0인 네이티브 슬롯은 표시 영역이 없으므로 표면을 제거하지 않고 숨긴 상태로 제출한다. 영역이 다시 생기면 표시를 복원한다.

기존 표면을 숨길 때 적용된 네이티브 프레임과 이미지 스냅샷을 보존한다. 표시하지 않는 요청의 빈 사각형은 1×1 대체 뷰포트가 아니다. 바깥 표면이 숨겨져 있으면 공급자에게 래스터 설정을 보내지 않는다. 다시 표시할 때 보이는 사각형을 적용하고 필요한 경우 정확한 결과 래스터를 설정한다. 새로 부착한 숨긴 표면도 표시 배치를 갖기 전에는 그림 렌더링을 시작하지 않는다. 페이지는 호스트가 카드의 사각형을 적용하기 전에 새 카드를 그리므로, 표면 페이지는 준비가 표면에 네이티브 프레임을 주기 전에 보이는 그림 영역을 배치할 수 있다. 이런 영역은 래스터 크기가 없고, 호스트는 준비가 표면을 배치할 때 그 영역을 설정한다. 배치된 표면 안의 보이는 영역에 래스터 크기가 없으면 오류다.

바깥 표면의 사각형을 적용하면 페이지에 준비 응답을 돌려주기 전에 필요한 이미지 설정을 시작한다. 이미지 렌더링은 DOM 그리기·표시와 병행할 수 있다. 문서가 앵커 여백을 바꿀 수 있으므로 최종 표시 검사는 DOM 표시 후 네이티브 래스터 좌표를 다시 읽는다. 병행 준비가 오래된 래스터의 커밋을 허용하지는 않는다.

페이지는 해당 DOM을 그리기 전에 네이티브 준비 응답을 기다린다. 비동기 준비 요청을 시작한 것만으로 네이티브 트랜잭션이 시작됐다고 볼 수 없다. 페이지는 그 DOM을 응답이 도착한 자리가 아니라 응답 뒤 다음 task 에서 그린다: 응답은 ResizeObserver callback 의 checkpoint 를 포함한 어느 microtask checkpoint 에서든 도착할 수 있고, 거기서 그리면 관찰 round 가 이미 전달한 요소가 바뀌어 WebKit 이 그 관찰을 다음 frame 으로 미루고 ResizeObserver loop 오류를 낸다. task 는 rendering update 와 그 관찰 round 안에서 실행되지 않는다. 페이지는 그 뒤 호스트에 그리기의 표시를 기다리게 하고, 그 기다림은 곧바로 rendering update 를 시작해 그리기를 담으므로, 그리기는 animation frame 처럼 화면 갱신을 기다리지 않는다. 그 task 전에 배치 세대가 바뀌면 그리기를 취소한다. 준비가 거부되면 해당 DOM을 바꾸지 않고 오류를 전파한다. 실패한 준비는 시작한 트랜잭션을 남기지 않는다: 호스트는 트랜잭션을 시작하기 전에 창 덮개를 놓으므로 거부된 덮개는 트랜잭션을 시작하지 않고, 준비의 뒤 단계가 실패하면 시작한 트랜잭션을 취소한다. 준비 중 페이지 배치 세대가 바뀌면 이전 DOM 그리기를 취소한다.

이전 표시 확인은 이후 준비의 트랜잭션을 커밋하지 않는다. 메인 문서 탐색은 해당 창의 활성 준비와 대기 중인 준비를 취소한다. 네이티브 호출은 UI 스레드에서 실행하며 WebKit 응답을 기다리는 동안 UI 스레드를 차단하지 않는다.

창의 트랜잭션이 열린 동안에는 그 창의 어떤 변경도 화면에 나가지 않고, 같은 창의 새 준비는 열린 트랜잭션을 연장한다. 따라서 창의 표시 상태 대기(`host.window.presented`)는 그 창의 열렸거나 대기 중인 모든 준비가 커밋된 뒤의 표시 갱신이 끝나야 완료되며, 그 갱신 뒤 화면의 다음 갱신 목표 시각을 보고한다.

앱 배경의 페인트 구멍은 호스트가 해당 DOM을 그린 배치의 표시를 확인한 뒤에만 바뀐다. 준비 응답은 표시 확인이 아니다. 확인 뒤 기존 한 애니메이션 프레임 지연을 유지하고 해당 표시 스냅샷의 네이티브 적용 사각형·표시 여부를 뷰포트 좌표로 사용한다. 새 진행 중 DOM 배치는 자신의 표시가 확인되기 전에 이 구멍을 바꾸지 않는다. 배치 좌표 변환은 네이티브 표시 여부를 보존한다. 요청한 네이티브 표면, 불리언 표시 여부 또는 유한한 좌표·음수 아닌 크기가 없는 확인 응답은 명시적 오류이며 페인트 구멍 갱신을 예약하지 않는다.


표면은 호스트가 적용한 프레임을 유지한다. 웹 인스펙터는 메인 문서 웹뷰만 켜며, 그것을 붙이면 그 웹뷰의 크기가 바뀔 뿐 표면은 움직이지 않으므로 호스트는 바깥 변경에 맞서 표면 프레임을 붙잡지 않는다.

레이어 트랜잭션은 UI 스레드에서 공유한다. 다른 프로젝트 창의 준비는 현재 창의 커밋 또는 취소까지 대기한다. 창을 다시 로드하거나 닫으면 해당 창의 활성 준비와 대기 중인 준비만 취소한다. 대기 요청은 UI 스레드를 차단하지 않는다.

호스트는 네이티브 뷰의 좌표를 관리한다. 각 콘텐츠 웹뷰는 문서를 독립적으로 렌더링한다. 웹 문서 렌더러의 지연이 메인 창의 배치 갱신을 중단시키지 않아야 한다.

앱 DOM에는 모든 플러그인 DOM이 마운트된다. 앱 DOM의 표시 콜백은 해당 DOM 평면을 확인하며 다른 웹뷰의 콘텐츠를 확인하지 않는다. 문서 영역은 콘텐츠를 독립적으로 렌더링하며, 표면의 하위 뷰이므로 네이티브 프레임은 트랜잭션에서 카드 좌표를 따른다. URL 출처 비교로 표시 소유권을 정해서는 안 된다.

네이티브 표면 모듈은 호스트가 해당 네이티브 표면 핸들을 준비한 뒤에만 승인한다. 승인 알림은 현재 표면 세대마다 정확히 한 번 전달되며, 그 전에는 모듈이 합성을 선언하거나 이미지 영역을 붙이거나 사이드카 세션을 열 수 없다. 승인이 없다고 무기한 불러오는 중 상태를 유지해서는 안 되며, 호스트는 작업 제한시간 안에 귀속 가능한 오류를 보고해야 한다.

예제는 장치 픽셀 단위 배치를 유지하며, 배율이 2인 화면에서는 0.5 CSS 픽셀 크기를 포함한다. 카드, 구분선, 디바이더와 준비된 표면 사각형에 같은 격자를 적용한다. 렌더링된 콘텐츠는 푸터 앞에 빈 영역 없이 네이티브 표면을 채워야 한다. 배치 정밀도를 낮추거나 네이티브 배경색을 변경하는 것은 이 요구사항을 충족하지 않는다. 설정과 메뉴의 투명도는 별도로 설정한다.

macOS 콘텐츠 웹뷰는 장치 픽셀을 좌표 단위로 사용하는 공통 네이티브 컨테이너에 배치한다. 호스트는 네이티브 뷰 계층을 통해 창 사각형을 변환한다. 각 콘텐츠 웹뷰의 페이지 줌은 화면 배율과 같고, 로컬 좌표 한 단위는 backing 픽셀 하나다. CSS 크기와 장치 픽셀 배율을 유지하면서 정수 단위의 네이티브 렌더링 크기를 제공한다. 창 크기와 화면 배율이 변경되어도 이 변환을 유지한다. WebKit은 휠 이동량을 뷰의 좌표 단위로 쓰므로, 앱의 이벤트 모니터와 네이티브 스크롤 입력은 컨테이너 안 웹뷰로 가는 휠 이벤트의 이동량에 화면 배율을 곱한다. 스크롤은 모든 배율에서 포인트와 같은 수의 CSS 픽셀만큼 문서를 움직인다. 메인과 모달 웹뷰는 창의 포인트 좌표를 유지한다.

[비공개 네이티브 API 목록](../operations/private-native-apis.ko.md)에 좌표·표시·입력 의존성, 필요성, 네이티브 업데이트 후 우선 검토 절차를 기록한다.

그림 표시를 기다리기 전에 호스트는 표시 중인 모든 그림 영역의 실제 네이티브 래스터를 읽고 필요한 설정을 보낸다. 영역은 요소 크기나 인셋이 바뀌지 않고도 표시될 수 있으므로 이 검사는 새 DOM resize 알림에 의존하지 않는다. 설정 묶음 전송이 실패하면 오류를 보고하고 보내지 않은 모든 설정의 전송 예약을 해제해 다음 명시적 작업에서 설정할 수 있게 한다. 보내지 않은 작업을 완료로 처리하지 않는다.

바깥 표면은 문서 세대와 별개로 표시 상태를 소유한다. 문서의 첫 로드나 이동을 위해 그림 영역을 제거해도 이 표면 상태를 제거하면 안 된다. 바깥 표면 자체가 닫힐 때만 표시 상태의 소유권을 끝낸다.

## 제목줄 높이

창 제목줄은 배치 트랜잭션에 들어가므로, 창 단추는 페이지의 첫 행을 그리는 표시 프레임에서 함께 움직인다([창 단추](hosts.ko.md#창-단추)).

- 모든 준비는 `titlebar` 를 담는다. 준비 뒤에 오는 그리기가 끝나면 페이지가 보이는 첫 행의 높이(point)이며, 그 그리기의 프레임 배율에 대해 `round(max(40, 36 × 프레임 배율))` 이다. 그리기 뒤에 보내는 준비는 그린 행의 높이를 담는다.
- 호스트는 트랜잭션을 시작하기 전에 요청의 나머지와 함께 높이를 검사한다. 창의 트랜잭션을 시작한 뒤, 표면을 놓고 준비에 답하기 전에 창의 제목줄을 그 높이로 정하므로, 새 높이는 DOM 프레임의 커밋과 함께 화면에 나간다. 높이를 정하지 못하면 시작한 트랜잭션을 취소하고 그 오류로 준비를 실패시킨다. 준비의 뒤 단계가 실패하면 제목줄을 준비 전의 높이로 되돌린 뒤 트랜잭션을 취소한다. 취소는 트랜잭션을 커밋하므로, 되돌리지 않으면 새 제목줄이 이전 행과 함께 표시되기 때문이다.
- 준비의 답은 `chrome` 을 담는다. 호스트가 높이를 정한 뒤의 창 단추 영역과 제목줄 높이이며, `windowControls` 답의 형태(`{controls, row}`)다. 검증 W 는 첫 행을, 호스트가 표시를 확인한 가장 최근 준비의 `chrome` 에 있는 단추 영역, 곧 커밋된 상태와 비교하고 이전의 `windowControls` 답과 비교하지 않는다.
- 프레임 배율의 변경은 준비한 배치가 그린다. 페이지는 새 배율을 설정이 바뀔 때가 아니라 그 배치의 그리기에서 문서에 쓴다. 배치를 준비하기 전에 같은 task 안에서 배율을 쓰고, 판을 읽고, 그린 배율을 다시 써서 새 배율이 주는 판 크기를 잰다. 그 사이에 문서는 아무것도 렌더링하지 않고, 준비의 카드 사각형은 새 행에 맞는다. 판이 없는 창(라이브러리)은 높이를 담고 표면이 없는 준비로 배율 변경을 그린다. 라이브러리로의 전환도 같은 방식으로 그린다. 그 준비는 현재 배율의 행을 담고, 그 그리기는 판을 지우고 그 배율을 쓰고 라이브러리 화면을 보인다. 라이브러리 화면은 작업 영역을 숨기므로 ResizeObserver 가 관찰하는 그 요소가 0×0 이 된다. 이 화면은 그 그리기, 곧 준비 뒤 관찰 round 밖의 task 에서 보이며, WebKit 이 ResizeObserver callback 의 microtask checkpoint 에서 실행할 수 있는 이후 호스트 답의 반응에서 보이지 않는다. 전환은 그 전에 준비한 배치의 그리기를 취소하고(배치 epoch 가 바뀐다) 그 그리기가 새 배율을 쓰는 그리기였을 수 있다. 전환이 현재 배율을 그리므로 취소된 그리기의 배율은 사라지지 않는다.
- 전체 화면인 창은 제목줄을 보이지 않는다. AppKit 은 창이 전체 화면에 들어갈 때 제목줄 높이를 저장하고 지우며, 나올 때 저장한 높이를 되돌리므로 그 사이에 정한 높이는 바뀐다. 그래서 호스트는 창이 전체 화면인 동안 준비에서 제목줄을 바꾸지 않는다. 준비는 성공하고 그 `chrome.row` 는 0 이다.
- 페이지의 첫 그리기는 준비를 기다리지 않으므로([페이지 시작](native-host.ko.md#page-시작)) 제목줄은 그 그리기의 행을 이미 가져야 한다. 호스트는 창 페이지의 시작 문서에 답하기 전에, 보내는 작업 공간 스냅샷의 공통 설정 `textSize` 에 대해 창의 제목줄을 `round(max(40, 36 × textSize))` 로 정하고(설정이 없으면 40), 문서의 `controls` 는 그 뒤에 읽는다. `textSize` 는 공통 전용이므로([설정](projects.ko.md#저장)) 페이지는 같은 값으로 첫 행을 그린다. 아직 보이지 않는 창, 곧 첫 페이지가 표시될 때까지 투명한 새 창은 이전 페이지를 보이지 않으므로 호스트는 높이를 바로 정하고, 첫 보이는 프레임의 행과 제목줄은 같은 배율의 것이다. 보이는 창은 다시 읽기처럼 새 페이지가 첫 그리기를 표시할 때까지 이전 페이지를 보이므로, 호스트는 시작 트랜잭션 안에서 높이를 정한다. 페이지 시작이 창의 활성 준비와 대기 중인 준비를 취소한 뒤, 새 ticket 으로 창의 준비 하나인 배치 트랜잭션을 시작하고, 그 안에서 제목줄을 정하고, 시작 문서에 답한다. 메인 웹뷰의 읽기가 끝나고 그 다음 표시 갱신이 끝나면, 곧 첫 그리기가 표시되면 그 트랜잭션을 커밋한다. 시작 트랜잭션이 열린 동안 도착한 새 페이지의 준비는 그 트랜잭션을 연장하고 자기 표시와 함께 커밋하며, 그때 시작 커밋은 ticket 이 바뀐 것을 보고 아무것도 커밋하지 않는다. 높이를 정하지 못한 시작 트랜잭션은 취소하고 그 오류로 시작을 실패시킨다. 열린 트랜잭션은 새 페이지를 막지 않는다. 새 WebContent 프로세스는 창의 트랜잭션이 열린 동안 첫 화면을 그려 표시하고 표시 갱신은 끝난다([`window_titlebar_reload_test.m`](../../native/darwin/tests/window_titlebar_reload_test.m)). 0.5 이상 3 이하의 수가 아닌 `textSize` 는 `common setting textSize must be a number, not <type>` 이나 `common setting textSize must be from 0.5 through 3` 으로 시작을 실패시킨다. 창이 전체 화면인 동안에는 준비에서처럼 제목줄을 바꾸지 않는다.
- 창이 전체 화면에서 나올 때 AppKit 은 들어갈 때 저장한 높이를 되돌리며, 전체 화면 동안 프레임 배율이 바뀌었으면 그 높이는 행과 다르다. 페이지는 창 크기가 바뀔 때마다 `windowControls` 를 읽고, 전체 화면에서 나오면 창 크기가 바뀐다. 답에 제목줄이 있고(`row` 가 0 보다 큼) 그 높이가 현재 프레임 배율의 행과 다르면, 페이지는 그 행을 담은 배치를 준비하고 그 준비가 마지막으로 보낸 요청과 같아도 보낸다.

## view 표면

view는 `view` 합성을 가진 표면의 native 웹뷰다([plugins](plugins.ko.md#view-표면)). 각 view는 탭마다 하나의 웹뷰이며 `sok://<plugin id>` origin에서 그 plugin의 페이지를 실행한다. 워크벤치 페이지는 plugin 코드를 실행하지 않는다.

- **구성.** 호스트는 view를 다음을 가진 웹뷰 구성으로 만든다.
  - `isView` 설정. 이 구성만 `core` scheme을 core root resolver로 보낸다([문서 영역](#문서-영역));
  - 표면 plugin의 plugin id. view의 origin과 core root 응답의 `Access-Control-Allow-Origin`을 정한다. 요청은 plugin id를 제공하지 않는다;
  - `packages/plugin-api/view-start.js`의 text를 담은 document-start 사용자 script. view channel script이며 staged 사본에서 가져온다;
  - 테마 토큰을 담은 document-start 사용자 script(아래 테마 참조);
  - surface의 시작 값을 담은 document-start 사용자 script(아래 시작 값 참조);
  - [호스트 계약](host-contract.ko.md)이 이름으로 선언한 script message handler `sok-view`;
  - 그 plugin의 영구 website data store. plugin id로 구분하며, 문서 영역의 store와 같이 설정 디렉터리의 `document-data` 아래에 둔다([문서 영역](#문서-영역)).

  두 document-start script는 모든 페이지 script보다 먼저 실행된다. 둘은 서로에 의존하지 않으므로 주입 순서는 이 계약의 일부가 아니다.
- **load.** 구성을 만든 뒤 호스트는 `sok://<plugin id>/<page>`를 load한다. `<page>`는 합성의 `page`다. view의 파일은 문서 영역에 주는 plugin 파일과 같이 제공한다([문서 영역](#문서-영역)). 즉 `plugins/installed.json`이 기록한 폴더에서 가져오며, 같은 거부와 log 줄을 쓴다. view는 core root `sok://core/<path>`를 [문서 영역](#문서-영역)의 규칙과 [plugin process](../plans/plugin-processes.ko.md) 규칙 4의 grant 규칙에 따라 요청한다.
- **배치.** view의 frame은 card 사각형과 요소의 DOM inset에서 합성기가 구한 표면 사각형이다. hybrid 합성의 outer surface와 같다([배치 순서](#배치-순서)). 호스트는 그 frame을 card의 transaction에 적용하므로, 매 frame마다 view와 card가 함께 움직인다. `hidden` 속성이 있는 요소 안이거나 너비나 높이가 0인 view는 보이지 않음으로 제출하며, 다른 표면과 같이 웹뷰와 process를 유지한다.
- **영역.** view의 영역은 그 view의 표면 host 아래에 배치하고, inset은 view frame에 상대적이다. 영역을 배치하거나 바꾸는 호출마다 호출 envelope의 view id를 확인하므로 view는 다른 view의 영역을 조작할 수 없다([plugins](plugins.ko.md#view-표면)). 영역의 표시는 view frame과 같은 window transaction에 있다.
- **view channel.** view channel은 위 구성의 script와 handler `sok-view`다.
  1. document start에서 script는 `sok-view`로 ready message `{event: "view.ready", plugin, document}`를 보낸다. `document`는 script가 문서마다 만드는 식별자다. 호스트는 그것을 view의 ready 문서로 기록한다. 탐색(navigation)은 기록을 지우며, 새 문서의 ready message가 올 때까지 ready 문서가 없다.
  2. 호스트는 `window.postMessage(message, location.origin)`을 page world에서 실행해 view에 message를 보낸다. 이것은 [문서 영역](#문서-영역)의 문서 post와 같은 형식이다. 호스트 message마다 `sok: 1` 필드가 있다. ready 문서가 기록되지 않은 view에 대한 post는 false를 반환하고, 호출자가 `error: view channel: <view> has no ready document`를 application log에 쓴다. 테마는 예외다. 호스트는 테마를 그런 문서에 보내지 않는다(테마 참조).
  3. script는 event source가 window이고 `sok: 1`을 가진 message 이벤트를, document start부터 페이지가 `window.sokView.attach`를 부를 때까지 queue에 보관한다. attach는 queue의 message를 순서대로, 이어서 나중 message를 모두 전달한다. 전달 대상은 [view bridge](plugins.ko.md#view-표면)의 `createViewChannel()`이 붙이는 `onMessage` handler다. queue는 한 문서의 message만 담으며 최대 256개다.
  4. `sok: 1`이 없는 message는 application log에 error로 쓰고 어떤 handler에도 넘기지 않는다. queue가 256개인 상태에서 도착한 message는 queue에 들어가지 않는다. script는 `sok-view`를 거쳐 `view.error` message의 이유로 `queue full for <plugin>`을 보내고, 호스트는 `error: view channel: queue full for <plugin>`을 application log에 쓰며, view를 닫고 재시작 한도 안에서 다시 만든다. 기록 없이 버리는 호스트 message는 없다.
  5. `core.plugin.views`는 `queued`를 보고한다. 이는 view가 attach하지 않아 queue에서 기다리는 현재 문서의 message 수다.
- **view call.** view는 `sok-view`로 call 요청 `{sok: 1, id, command, params}`을 호스트에 보내고, `{sok: 1, id, cancel: true}`로 대기 중인 call을 취소한다. 요청은 [plugin process](../plans/plugin-processes.ko.md) 규칙 3의 call envelope이며, 그 응답은 view channel의 2번 항목 post 경로로 돌아온다.
  1. 호스트는 `id`가 정수이고 `command`가 빈 문자열이 아닌 요청을 `view-call {surface, plugin, id, command, params}` event로 창의 메인 page에 전달한다. `id`가 정수이고, `cancel`이 `true`이며, command를 담지 않은 취소는 `view-call {surface, plugin, id, cancel: true}` event로 전달한다. `surface`와 `plugin`은 메시지를 보낸 view의 값이다. 그 밖의 필드가 올바르지 않거나 `cancel`이 `true`가 아닌 메시지는 `error: view channel: <reason>`으로 application log에 쓰고 전달하지 않는다.
  2. 메인 page는 요청에 DOM surface context가 쓰는 handler로 답한다.
     - `tab.state.read`는 surface의 tab state를 돌려주고, `tab.state.write`는 params를 tab state로 저장한다. 저장 값은 `surface.unload`의 크기 한도 안에 있어야 한다. 두 call은 plugin이 `surface.unload`를 선언하지 않았으면 실패한다.
     - `runtime.native.call`은 `{name, payload}`로 surface의 host call `name`을 `payload`와 함께 실행한다. `name`은 빈 문자열이 아닌 문자열이다.
     - `runtime.sidecar.send`는 `{id, body, cids}`를 선언된 sidecar로 보낸다. `runtime.sidecar().send`와 같다.
     - `runtime.clipboard.read`는 `"text"` 또는 `"fileURLs"`로 그 형식의 클립보드 값을 돌려준다. `"png"` 읽기는 PNG bytes가 binary payload이므로 `view call runtime.clipboard.read png is not served`로 거부한다. `runtime.clipboard.writeText`는 문자열을 쓴다.
     - `runtime.links.open`은 빈 문자열이 아닌 URL 문자열로 링크를 연다.
     - `tab.title`, `tab.footer`, `tab.directory`, `tab.modified`, `tab.error`는 값을 params로 받아 surface의 tab report를 surface context 항목과 같은 방식으로 실행하며, 올바르지 않은 값은 같은 방식으로 거부한다. `tab.notify`는 `{text, policy}`를, `tab.keep`은 `{reason, on}`을 받는다. 각각은 `null`로 답한다.
     - `runtime.log`는 `{level, event, fields}`를 받아 페이지의 event writer로 기록을 쓰며, writer는 surface context와 같이 view의 plugin과 surface를 더한다. 페이지의 level gate는 전달 시점에 적용된다. gate가 거부한 기록은 writer의 gate가 세고, 조용히 버려지는 것은 없다. 이 call은 `null`로 답한다.
     - `runtime.error`는 view가 자기 page에 보여 주는 오류의 오류 줄 `{where, text}`를 받아, page의 오류 표시의 기록 경로로 `error page surface <surface> <where>: <text>`를 application log에 쓴다. 그래서 view는 main page의 오류 표시와 같이 각 오류를 보여 주는 순간 기록한다. `where`는 control 문자와 `: `가 없는 비어 있지 않은 문자열이고, `text`는 비어 있지 않은 문자열이다. 다른 값은 `view call runtime.error requires a non-empty where without a control character or ": "`나 `view call runtime.error requires a non-empty text`로 거부되고 아무것도 쓰이지 않는다. 이 call은 `null`로 답한다.
     - `runtime.contributions`는 `{point}`를 받아, surface context의 `contributions(point)`가 돌려주는 것처럼 view의 plugin의 extension point `point`에 연결된 항목을 각각 `{plugin, index, item, module}`로 돌려준다. `index`는 그 plugin의 `contributes` 안에서 항목의 위치이고, `module`은 core root 위 module의 URL(`sok://core/modules/...`)이다. plugin이 선언하지 않은 point는 surface context의 오류로 거부된다. `runtime.contributions.fail`은 `{point, plugin, index, reason}`을 받아 surface context의 `fail(reason)`처럼 그 연결된 항목을 `reason`과 함께 `invalid`로 만들고 `null`로 답한다. 비어 있지 않은 문자열이 아닌 `reason`은 `view call runtime.contributions.fail requires a non-empty reason`으로, 연결되지 않은 항목은 `view call runtime.contributions.fail: <point> has no connected item <index> of <plugin>`으로 거부된다.
     - `runtime.textSize.read`는 surface의 text scale을, `runtime.settings.read`는 plugin 설정의 값을 돌려준다. `runtime.textSize.on`과 `runtime.settings.on`은 아래 view event의 변경 구독을 등록한다. read가 아닌 각 call은 `null`로 답한다.
     - `core.*` command는 `runtime.command`가 실행하듯 실행한다. view plugin의 command는 exposure의 주인 검사를 거쳐 실행하므로, plugin이 등록한 command만 실행된다. 다른 주인의 이름은 `command <name> belongs to <owner>, not <plugin>`으로, 주인이 없는 이름은 `view call <name> names no owner`로 거부한다. 위 목록이 제공하지 않는 `tab.` 또는 `runtime.` 이름은 `view call <name> is not served`로 거부한다.
     - 이미 대기 중인 `id`의 요청은 `view call <id> is already pending`으로 거부한다.
  3. 메인 page는 `viewReply {surface, id, result}` 또는 `viewReply {surface, id, error: {code, message}}`로 답한다. 값을 돌려주지 않는 handler는 `result: null`을 보낸다. 호스트는 `{sok: 1, id, result}` 또는 `{sok: 1, id, error}`를 view의 ready 문서에 보낸다. ready 문서가 없는 view에 대한 응답은 page에서 `<surface> has no ready document`로 실패한다. 취소 message는 자신의 응답이 없다. 취소가 이름 붙인 대기 중인 call은 `{code: -32000, message: "cancelled"}` 오류로 답하며, 그 call의 handler는 계속 실행하고 결과는 버린다. 대기 중인 call이 없는 취소는 아무것도 끝내지 않는다.
  4. view의 call layer가 call을 resolve 또는 reject한다. 제한 시간은 command의 `timeout`이다. 그 시간이 지난 뒤 도착한 응답은 늦은 응답이며 버린다(plugin process 규칙 3). 호스트는 전달한 요청의 기록을 남기지 않는다. 취소된 call의 응답은 call layer가 그 call을 이미 끝낸 뒤 도착하므로, layer는 이를 늦은 응답으로 센다.
  - 페이지는 구독 call `runtime.native.on`(`{name}`), `runtime.sidecar.on`(`{id}`), `runtime.sidecar.onFailure`(`{id}`), `runtime.textSize.on`, `runtime.settings.on`에 아래 view event에서 정한 대로 답하고, 등록 call `runtime.command.register`(`{name}`)에 아래 view command에서 정한 대로 답한다. 각각은 적용되면 `null`로 답한다.
  - `runtime.theme`은 call이 아니다. 테마는 테마 message로 view에 가므로(테마 참조), `runtime.theme` call은 `view call runtime.theme is not served`로 거부한다.
- **view event.** view는 구독 call로 페이지의 event를 구독한다. 페이지는 구독의 각 event를 호스트 message `{sok: 1, event, data}`로 view에 보낸다.
  - `runtime.native.on`(`{name}`)은 surface의 호스트 event `name`을 전달한다. `data`는 DOM surface context가 받는 event 객체다.
  - `runtime.sidecar.on`(`{id}`)은 세션 `id`의 sidecar message를 `event: "sidecar.message"`와 `data: {id, body}`로 전달한다.
  - `runtime.sidecar.onFailure`(`{id}`)는 세션 `id`의 실패를 `event: "sidecar.failure"`와 `data: {id, reason}`로 전달한다.
  - `runtime.textSize.on`은 surface의 text scale이 바뀔 때마다 `event: "textSize"`와 `data`로 scale을 전달하고, `runtime.settings.on`은 plugin 설정이 바뀔 때마다 `event: "settings"`와 `data`로 값을 전달한다. 값이 바뀌지 않은 변경은 surface context가 전달하지 않듯 view에 전달하지 않는다.

  페이지는 구독을 한 번만 등록한다. 같은 name이나 id의 두 번째 call은 다시 등록하지 않고 `null`로 답한다. 페이지는 각 event를 `viewEvent {surface, event, data}`로 보내며, 호스트는 `{sok: 1, event, data}`를 view의 ready 문서에 post한다. ready 문서가 없는 view에 대한 event는 `<surface> has no ready document`로 실패하고, 페이지가 그 오류를 application log에 쓴다. 구독은 surface가 닫히면 끝난다. 재시작한 view는 다시 구독하며, 페이지는 그때까지 구독을 유지한다. view는 event 이름의 listener에 각 event를 전달하고, listener가 없는 event는 무시한다.
- **view command.** view는 시작할 때 자기가 제공하는 각 command를 `runtime.command.register`(`{name}`) call로 선언한다.
  1. 페이지는 등록을 exposure의 registry로 적용한다. plugin의 `exposes`가 선언하지 않은 name이나 다른 plugin의 name은 registry 오류로 거부되며, call은 그 오류로 답한다.
  2. core exposure의 command 요청이 페이지에 도착하면, 페이지는 `viewRequest {surface, id, command, params}`를 보낸다. `id`는 exposure 요청의 id이고 `params`는 그 params다. 호스트는 `{sok: 1, id, command, params}`를 view의 ready 문서에 post한다. ready 문서가 없는 view에 대한 요청은 `<surface> has no ready document`로 실패한다.
  3. view는 `sok-view`로 `{sok: 1, reply: id, result}` 또는 `{sok: 1, reply: id, error: {code, message}}`로 답한다. view는 `command`의 handler를 `params`로 실행하며, handler가 던진 오류가 응답의 error가 된다. view가 등록하지 않은 command의 요청은 `{code: 1002, message: "view command <command> is not registered"}` 오류로 답한다.
  4. 호스트는 `id`가 정수이고 `result`와 `error` 중 하나만 있으며 error에 message가 있는 응답을 `view-reply {surface, plugin, id, result}` 또는 `view-reply {surface, plugin, id, error: {code, message}}` event로 메인 page에 전달한다. 그 밖의 응답은 `error: view channel: <reason>`으로 application log에 쓰고 어떤 page에도 전달하지 않는다.
  5. 페이지는 응답으로 exposure 요청에 답한다. command가 선언한 timeout(plugin process 규칙 3, 기본 10000 ms, 1부터 600000까지)이 대기를 제한한다. view가 제때 답하지 않으면 페이지는 `{code: -32000, message: "command <name> did not reply within <ms>ms"}`로 요청에 답하며, 그 뒤 도착한 응답은 버리고 늦은 응답으로 센다.
- **view exposure.** view는 call `runtime.native.call`에 `{name: "registered", payload: {kind, name}}`로 status나 dom 항목을 등록한다. 페이지는 선언을 검증하고 registry로 등록을 반영한 뒤, surface의 `exposureRegister` 호출로 호스트에 전달한다. 그러면 호스트가 이를 기록하고 event `exposure-registered`로 알린다([exposure](exposure.ko.md#전달)). plugin의 `exposes`가 선언하지 않는 이름이나 surface가 등록할 수 없는 이름은 registry 또는 호스트의 오류로 거부된다. command는 `runtime.command.register`로 선언하며 `registered` 호출을 보내지 않는다. 전달된 exposure 요청(view가 등록한 command의 `status.get`, `status.watch`, `status.next`, `status.unwatch`, `command.run`, `dom.rect`, `dom.act`)은 구독 `runtime.native.on`(`{name: "exposure-request"}`)을 통한 호스트 event `exposure-request`로 view에 도착하며, `data`는 `{id, surface, method, params}`다. view는 `runtime.native.call`에 `{name: "exposureReply", payload: {id, result|error}}`로 답하고, 페이지는 이를 view surface의 `exposureReply` 호출로 호스트에 보낸다. 페이지는 view를 위한 port를 두어 전달된 각 요청을 소비하므로 요청이 두 번 전달되는 일은 없다. view가 답하지 않는 요청은 호스트의 제한 시간으로 끝난다.
- **declared UI snapshot.** view는 status의 declared UI snapshot을 message `{event: "declared-ui.snapshot", plugin, status, seq, value, skipped}`로 `sok-view`를 거쳐 push한다. 호스트는 field가 온전한 snapshot을 event `declared-ui.snapshot {surface, plugin, status, seq, value, skipped}`로 창의 메인 page에 전달하고, 페이지는 이를 확인하고 그린다([declared UI](declared-ui.ko.md#status-대응)). 호스트는 snapshot에 대한 자체 event는 쓰지 않는다([plugin process](../plans/plugin-processes.ko.md) 규칙 2). plugin이 없거나 view의 plugin이 아닌 plugin을 naming하거나, `status`가 없거나, 1 이상의 정수 `seq`가 없거나, `skipped` count가 없거나, `value`가 없는 snapshot은 `error: view channel: <reason>`으로 application log에 쓰고 어떤 page에도 전달하지 않는다. 메인 page는 snapshot을 view event `declared-ui.snapshot.ack`로 확인하며 그 `data`는 `{plugin, status, seq}`이고, status의 현재 값은 view command 경로의 call `declared-ui.snapshot.request`(`{status}`)로 pull하며 그 응답은 `{seq, value}`를 담는다. source가 아직 값이 없으면 `seq`는 0이고 값은 `null`이다.
- **presentation wait.** view는 card 배치가 바뀐 뒤 처음 표시될 때만 presentation wait에 참여한다. divider 끌기 같은 계속되는 gesture에서는 view의 frame이 매 frame마다 card와 같은 commit에 배치되며, commit은 그 뒤 view가 그리는 내용을 기다리지 않는다. wait는 다음 중 처음 일어나는 것으로 끝난다. view의 presentation 완료, view process의 종료, 변경이 끝날 때 view가 보이지 않게 되는 것, `host.trace.view.unresponsive` 알림. native 트랜잭션은 참여한 각 view가 표시되거나 wait가 끝날 때까지 commit을 잡는다. wait는 timer로 끝나지 않는다. host가 commit을 하고 각 끝을 보므로 wait는 host가 소유하며, presentation 완료 없이 끝나면 성능 trace가 켜져 있을 때 host가 `host.trace.view.presentation-abandoned {surface, reason}`을 쓴다. view는 변경마다 한 번만 wait에 참여한다. presentation 완료 없이 끝나면 commit은 그 view 없이 계속되고, host는 `view-presentation-abandoned {surface, reason}` 알림을 surface로 보내며, 손실은 `core.plugin.losses`의 `abandoned`로 센다.
- **테마.** 생성할 때 호스트는 현재 테마의 `{scheme, tokens}` 값을 동결해 `window.sokTheme`에 넣는 document-start script를 view 구성에 준다. 그래서 페이지의 첫 script가 어떤 페이지 script보다 먼저 `window.sokTheme`에서 토큰을 읽는다. 호스트는 view의 page를 불러오기 전에 이 script를 더한다. 나중의 테마 변경은 post 경로로 host message가 되어 view에 간다. 다만 ready 문서가 기록되지 않은 문서에는 보내지 않는다. 호스트는 ready message마다 현재 테마를 보내므로, ready 전의 변경은 오류도 아니고 유실도 아니다. 테마 message는 `{sok: 1, event: "theme", data: {scheme, tokens}}`이며, `data`는 호스트가 가진 현재 테마 값이다. view는 마지막 테마 message를 보관하며, 나중에 구독하는 `runtime.theme`의 listener는 그 값을 즉시 받는다.
- **시작 값.** 생성할 때 호스트는 테마 script와 함께 view 구성에 document-start script를 더해, 그 surface의 동결된 시작 값 `{surface, params, origin, project, declarations}`를 `window.sokSurface`에 넣는다. 그래서 페이지의 첫 script가 어떤 페이지 script보다 먼저 이를 읽는다. `surface`는 surface의 식별자이며 URL query가 아닌 context 멤버다. `params`는 탭의 매개변수 또는 `null`이다. `origin`은 탭을 연 탭이 그때 기록한 동결된 `{directory}`이거나 `null`이다. `project`는 창이 보이는 project의 동결된 `{root}`이고, project가 없는 창에서는 `null`이다. `declarations`는 plugin의 `exposes`다. 페이지는 surface의 준비(`syncSurfaces`)로 이 값들을 보내며, 호스트는 요청의 나머지와 함께 검사하고, 형식이 맞지 않는 값은 그 검사의 이유로 거부된다. 다른 구성의 surface는 이 값을 담지 않는다. 호스트는 view의 page를 불러오기 전에 이 script를 더하고, view를 다시 만들 때 surface의 기록에서 이 값을 다시 주입한다.
- **입력.** view는 시작할 때 shortcut table을 호스트에 등록한다. table은 각 workbench 단축키와 그 주인을 담는다([plugin process](../plans/plugin-processes.ko.md) 규칙 7). 등록 전에는 각 키가 기본 동작을 유지하며, view는 `page.view.shortcut-table-missing {plugin}`을 error 수준으로 쓴다. view는 table로 각 키를 동기적으로 판단한다. workbench가 주인인 키는 기본 동작을 막고 event 데이터와 함께 넘긴다. view가 주인인 키는 view가 처리하고 넘기지 않는다. 네이티브 메뉴가 주인인 키는 view의 기본 동작을 막지 않는다. 그 밖의 키는 기본 동작을 유지한다. 넘긴 명령이 실패하면 `page.input.shortcut.failed {plugin, key, command}`를 쓴다. 입력기 조합은 view의 first responder에 간다.
- **process 시작.** 호스트는 view를 만들 때 `host.trace.view.process-request {plugin, surface}`를 쓰고, 그 view의 첫 ready message에서 `host.trace.view.process-ready {plugin, surface}`를 쓴다.
- **응답성.** WebKit이 view의 WebContent process가 응답성 검사에 답하지 않는다고 알리면, 호스트는 `host.trace.view.unresponsive {plugin, surface}`를 쓰고 `view-responsiveness {surface, plugin, responsive: false}` event를 창의 메인 page에 보낸다. process가 다시 답하면 호스트는 `host.trace.view.responsive {plugin, surface}`를 쓰고 `responsive: true`를 보낸다. 이 알림은 view의 어떤 call도 끝내지 않는다. 메인 page는 view surface마다 상태를 `core.plugin.views {plugin, surface, responsive}`에 보관하고, surface가 dispose되면 이를 지운다. 문서 영역은 알림을 받지 않는다.
- **process 종료.** view process가 끝나면 호스트는 view가 열어 둔 각 call을 `process-ended` 이유로 끝내고, `host.call.peer-lost`를 쓰며, view의 presentation wait를 끝낸다. 그 뒤 호스트는 view를 다시 만들고, 새 view는 저장된 탭 상태에서 상태를 복원한다. 재시작 한도는 [plugins](plugins.ko.md#view-표면)의 한도다. 같은 표면의 실패가 300초 안에 4번 일어나면 재시작을 멈춘다. 네 번째 실패에서 호스트는 `error: view channel: <surface>: the view failed 4 times within 300 seconds and is created again when its tab is reopened`을 application log에 쓰고, 창의 메인 page에 `view-stopped {surface, plugin, reason}` event를 보낸다. reason은 `the view failed 4 times within 300 seconds and is created again when its tab is reopened`이다. 메인 page는 reason을 표시 경로로 card에 보여 주며, 사용자가 탭을 다시 열 때까지 card가 이를 유지한다.

## 영역

영역은 표면에서 네이티브 콘텐츠를 표시하는 장소다. 소유권, 계층, 완전한 스냅샷 위치, 쌓임, 입력, 세대, 래스터 규칙은 [표면 합성](surface-composition.ko.md)이 정의한다. 이 문서는 문서·그림 공급자에만 해당하는 동작을 정의한다.

모든 네이티브 영역은 자기 표면 `SurfaceHost.NativePlane`의 하위 뷰다. 호스트나 DOM 평면의 형제일 수 없다. 호스트는 적용한 완전한 합성에서 영역 프레임을 계산하고 호스트에 맞게 클리핑한다. 영역은 표면과 동기적으로 이동하고 숨겨지고 어두워지고 닫힌다.

영역은 모달 대화 상자 아래에 있다. 문서 영역 렌더러는 표시 대기에서 빠지지만, 보이는 그림 영역은 준비된 배치를 커밋하기 전에 정확한 현재 래스터를 가져야 한다. 각 영역은 표면 안에서 고유한 이름을 갖는다. 호스트는 영역의 이름, 사각형, 표시 여부, 초점 여부를 `host.window`로 보고한다.

영역의 공급자는 둘이다.

- **문서 영역**: 코어가 표면의 하위 뷰로 만들며, 웹 문서를 호스팅한다.
- **그림 영역**: 바깥 사이드카가 만들며, 공유 이미지를 네이티브 표면으로 공급한다.

### Region lifetime

place가 빼는 표면의 영역 종료는 호스트가 맡는다. 두 호스트는 place가 답하기 전에 page가 더 이상 나열하지 않는 각 표면의 문서 영역과 그림 영역을 모두 닫는다. page는 place를 먼저 실행하고, place가 성공한 뒤에만 그런 표면의 모듈을 release한다. 그 release는 영역의 page 쪽 handle만 버리고 `documentDetach`, `documentUnsubscribe`, `imageDetach`를 호출하지 않는다. place를 실행하기 전에 page는 place가 빼는 각 표면의 composition을 멈춘다: 호스트가 place 중에 그런 표면의 composition을 지우므로, 그 표면에 대해 `compositionPlace`와 `imagePlace`를 보내지 않고 아무것도 detach하지 않는다. 실패한 place는 아무것도 release하지 않으므로, 뺐을 표면은 마운트된 채 남고 그 composition은 다시 시작해 현재 형태를 다시 place한다. place는 host에서 그런 surface의 sidecar session도 끝내므로, place가 도는 동안 모듈이 sidecar로 보내는 send는 결과를 기다린다: 실패한 place 뒤에는 보내고, 성공한 place 뒤에는 그 send와 dispose가 보내는 session 종료 같은 모듈의 이후 send를 보내지 않는다. host로 보내면 project root 없는 session이 열리기 때문이다. 표면이 배치된 채로 page가 스스로 detach하는 영역은 호스트를 거쳐 detach하고, 그 detach의 실패는 보고한다. 이는 place를 거친 모든 제거에 적용된다: 탭 닫기, 탭 unload, commit이 더 이상 유지하지 않는 표면.

## 네이티브 뷰 위의 입력

네이티브 뷰는 DOM 위에 놓인다. 네이티브 뷰는 자신이 놓인 DOM 요소를 그리고, 그 요소의 입력을 소유하지 않는다. 그 위의 입력은 네이티브 뷰가 없는 것처럼, 페이지가 그 점 아래의 DOM 요소를 기준으로 정한다.

- 포인터와 휠 이벤트는 그림 영역을 지나 페이지로 가며, 커서를 포함한 그 의미는 페이지가 정한다.
- 네이티브 뷰는 커서 영역도 끌기 형식도 등록하지 않는다.
- 다른 애플리케이션에서 창으로 끈 파일은 창의 파일 놓기 뷰로 간다. 이 뷰는 창 합성 뷰의 유일한 네이티브 끌기 대상이다. 합성 뷰의 웹뷰들 위에 있고, 파일 URL만 받으며, 적중 검사에서 뷰를 돌려주지 않으므로 포인터 이벤트와 다른 끌기는 아래 뷰로 간다. 이 뷰는 Finder가 끌기 대지에 두는 파일 참조 URL을 파일 경로 URL로 바꾸고, 참조가 더 이상 파일을 가리키지 않는 놓기는 거절한다. 놓기는 페이지에 파일 URL과 페이지 좌표의 놓인 점인 `{urls, x, y}`의 JSON 문자열을 `files-dropped`로 보낸다. 호스트는 문자열을 바꾸지 않고 넘기며 페이지가 해석한다. 페이지는 그 점의 DOM 요소가 속한 표면을 찾고, 그 표면의 플러그인이 `plugin.json`에 `surface.drop`으로 선언한 놓기 명령을 그 표면에서 `{urls}`로 실행한다. `core.drop`은 마지막 놓기를 `{urls, x, y, surface, command, error}`로 알린다. 어느 표면에도 놓이지 않았거나 놓기 명령을 선언하지 않은 플러그인의 표면에 놓이면 `error`에 그 이유를 두고 아무것도 실행하지 않는다. 그런 객체가 아닌 문자열도 같다.
- 호스트는 프레임워크의 파일 놓기 처리를 끄므로, 놓인 파일은 파일 놓기 뷰만 받는다.

## 문서 영역

표면 페이지는 문서 영역으로 자기 요소 하나에 웹 문서를 표시한다. 표면은 항상 플러그인의 페이지를 표시하며([플러그인](plugins.ko.md)), 웹 주소는 표면이 아니다.

- manifest가 `^[a-z0-9][a-z0-9-]{0,63}$`와 일치하는 고유 이름을 선언한다. 페이지는 `createSurfaceComposition`에서 문서 손잡이를 얻는다. 개별 attach, place, detach 연산은 공개하지 않는다.
- 호스트는 호출한 표면의 `SurfaceHost.NativePlane` 아래에 웹뷰를 만들고, 호출마다 호출한 웹뷰가 요청에 적힌 표면에 속하는지 확인한다. 그 웹뷰는 hybrid 표면의 앱 DOM 웹뷰이거나 [view 표면](#view-표면)의 view다. 표면은 다른 표면의 영역을 조작할 수 없다.
- 완전한 합성이 뷰포트 가장자리에서 요소까지의 여백을 CSS 픽셀로 보고하고 요소가 보이는지를 함께 보낸다. 호스트는 여백을 저장하고 바깥 표면이 바뀔 때 같은 네이티브 트랜잭션에서 다시 적용한다.
- 페이지는 요소를 숨겨 영역을 숨긴다. 그러면 합성이 영역을 보이지 않는 것으로 보고하고, 호스트는 네이티브 뷰를 숨겨 그 뷰는 그리지도 입력을 받지도 않는다. 브라우저 플러그인은 `browser.location`이 빈 `url`을 보고하는 동안, 즉 첫 주소를 열기 전에 문서 요소를 숨긴다. 저장된 주소가 없는 브라우저 표면은 마운트할 때 브라우저 설정 `browser.home`(라벨 `홈 주소`, 기본값이 빈 주소 설정)의 주소를 연다. 그 설정이 비어 있으면 표면은 빈 상태로 시작한다. 그 자리에는 `주소를 입력하세요` 문구의 빈 상태 `browser.empty`를 표시하고, 이를 누르면 `browser.address.select`가 실행되어 주소창에 초점을 주고 값을 선택한다. 상태가 비어 있지 않은 `url`을 보고하면 플러그인은 빈 상태를 없애고 문서 요소를 다시 표시한다.
- 영역은 `http`, `https`, `file`, `sok` 주소를 연다([애플리케이션 주소](native-host.ko.md#애플리케이션-주소)). 앱 자체 스킴은 요청할 때와 문서가 이동할 때 모두 거부한다. `file` 주소는 loadFileURL:allowingReadAccessToURL: 로 열어 파일이 있는 디렉터리까지 읽기 권한을 준다. 영역 문서는 앱 문서와 분리된 영구 웹사이트 데이터 저장소 하나를 사용하며 앱 브리지를 받지 않는다. 저장소는 쿠키, 로컬 저장소, 캐시 같은 사이트 데이터를 앱 설정 디렉터리 안의 `document-data` 디렉터리에 둔다. 설정 디렉터리는 앱이 `--config-dir`로 시작하면 그 디렉터리이고, 아니면 기본 설정 디렉터리다. 따라서 두 설정 디렉터리는 사이트 데이터를 공유하지 않고, 설정 디렉터리를 지우면 그 사이트 데이터도 지워진다. 공개 `dataStoreForIdentifier:`는 모든 저장소를 앱의 WebKit 컨테이너에 두므로, 호스트는 `_WKWebsiteDataStoreConfiguration` `initWithDirectory:`로 저장소를 만든다([비공개 네이티브 API](../operations/private-native-apis.ko.md)).
- plugin 주소 `sok://<plugin id>/<path>`는 그 영역을 가진 표면의 plugin 안의 파일을 가리킨다. composition 선언은 표면의 `plugin`을 담고, host는 그 plugin이 설치되어 켜져 있으면 `plugins/installed.json`이 그 plugin에 기록한 폴더에서 `<path>`를 내보낸다. 다른 owner의 주소, 빈 부분이나 `.`, `..` 부분이 있는 경로, 없는 파일은 찾을 수 없다고 답한다. 거부된 페이지 요청마다 정규화된 주소 `<URL>`을 담아 응용 프로그램 log에 `error: document view: plugin file not found: <URL>`을 error 수준으로 쓰므로, log는 거부마다 URL과 사유를 남긴다. plugin이 자기 release에 없는 파일을 요청하면 그 plugin의 결함이므로 이 거부는 관찰이 아니라 오류다. host는 파일 확장자의 content type을 보낸다: `.html`은 `text/html`, `.js`와 `.mjs`는 `text/javascript`이고, `text/css`, `application/json`, `application/wasm`, `image/svg+xml`, `image/png`, `image/jpeg`, `image/webp`, `image/x-icon`, `font/woff2`, `font/woff`, `font/ttf`, `font/otf`, `text/plain`은 각자의 확장자에, 다른 확장자에는 `application/octet-stream`을 보낸다. plugin 문서의 origin은 `sok://<plugin id>`이므로, 한 plugin의 문서들은 사이트 데이터를 함께 쓰고 두 plugin의 문서들은 함께 쓰지 않는다.
- core root `sok://core/<path>`는 view가 요청하며 region은 요청하지 않는다. view 구성은 `isView`를 설정하여 만들며, 그 구성만 scheme의 host `core`를 처리한다. 요청은 host가 platform에 등록한 core root resolver로 간다([host contract](host-contract.ko.md#contract-cases), `document.core-root.native`). resolver는 view 구성의 plugin id와 path를 받아 파일과 content type을 내보내거나 path를 거부한다. 내보낸 응답은 그 view 구성의 `Access-Control-Allow-Origin: sok://<plugin id>`를 담으며, 요청의 Origin을 되돌려 보내지 않고 `*`도 보내지 않는다. 거부 응답은 이 헤더를 담지 않으므로 page의 fetch나 module import가 실패한다. 문서 영역(region)은 core root 허용을 받지 않는다. 그 `sok://core` 요청은 not found로 답하며 resolver는 호출되지 않는다. view가 받을 파일을 정하는 규칙은 [plugin 프로세스 rule 4](../plans/plugin-processes.ko.md)가 정한다.
- plugin 문서는 자기 영역의 binary store에 byte를 보관한다. 이 store는 영역의 plugin만을 위해 binary id 아래에 byte를 둔다. `POST sok://<plugin id>/.binary`는 요청 body를 저장하고 JSON 객체 `{"id", "length"}`를 답한다. `id`는 host가 만드는 소문자 16진수 32자이고, `length`는 저장한 byte 수다. host는 body를 `HTTPBody`에서 읽고, WebKit이 body를 stream으로 전달하면 `HTTPBodyStream`에서 읽는다. WebKit이 Blob body처럼 두 형태 중 어느 것으로도 전달하지 않는 요청은 400으로 거부하므로, 페이지는 byte를 ArrayBuffer view로 보낸다. byte는 요청의 `Content-Type`을 유지하며, `Content-Type`이 없는 upload는 `application/octet-stream`을 유지한다. `GET sok://<plugin id>/.binary/<id>`는 저장된 byte를 그 `Content-Type`과 `Content-Length`로 답하며, host는 응답이 끝날 때 id를 해제하므로 같은 id에 대한 두 번째 요청은 찾을 수 없다고 답한다. upload는 body가 비어 있으면(400), 16 MiB(16777216 byte)를 넘으면(413), 또는 영역이 저장한 byte가 64 MiB(67108864 byte)를 넘게 되면(413) 거부한다. 다른 plugin의 origin에 대한 요청은 403으로, `/.binary`에 대한 POST가 아닌 method나 `/.binary/<id>`에 대한 GET이 아닌 method는 405로, 저장되지 않은 id는 404로 거부한다. 각 거부는 `application/json`으로 `{"error": <reason>}`을 답하고, 그 사유를 응용 프로그램 log에 `error: document view: <reason>` 형식으로 쓴다. 다른 origin의 페이지는 응답에 CORS 헤더가 없어서 응답 body를 읽지 못하며, 네트워크 오류를 보고 사유는 log에 남는다. host는 native 코드에서 영역의 id를 가져가는 동작도 두며, 그 동작은 byte를 돌려주고 id를 해제한다. 영역을 닫으면 그 영역이 가진 모든 id를 해제한다. plugin release는 경로에 `.binary` 부분이 있는 파일을 거부한다. host가 그 경로를 파일 조회 전에 응답하기 때문이다.
- host는 document 영역의 binary id가 가진 byte를 플랫폼의 take 작업으로 가져온다. native take는 byte를 돌려주고 id를 놓으므로, 같은 id의 두 번째 take는 native 오류 문구로 실패한다. 연결되지 않은 document는 `document "<name>" is not attached`로 take를 거부한다. 이는 다른 document 작업의 문구다. binary id를 이름으로 받는 첫 명령은 view와 함께 온다.
- plugin 문서는 page와 메시지를 주고받는다. document handle의 `post(message)`는 JSON 값을 영역에 보낸다. host는 문서의 page world에서 `window.postMessage(message, location.origin)`을 실행하고, 현재 문서가 영역 plugin의 plugin 문서가 아니면 `document <name> shows no plugin document`로 실패한다. host content world의 스크립트는 문서의 window가 window 자신을 `source`로 받은 각 `message` 이벤트를 전달하므로, page는 자기가 보낸 메시지도 받는다. host는 `document-message {surface, document, message}`를 소유 표면에만 보내며, `message`는 이벤트의 data를 JSON으로 담는다. content world 스크립트는 null, boolean, 유한한 number, string 또는 이런 값으로 된 array나 plain object가 아닌 값(순환이 있거나 JSON이 버리는 property가 있는 값 포함, 예: ArrayBuffer, typed array, Date, Map)을 거부하고, `the message holds an ArrayBuffer, which is not JSON`처럼 type을 밝히는 이유로 `{error}`를 보내며, host는 애플리케이션 로그에 `error page document message <name>: <reason>`을 쓴다. 다른 문서에는 메시지 통로가 없다.
- 영역 문서는 소유 창의 다크 또는 라이트 모양을 따른다. `prefers-color-scheme`은 앱 모드와 일치하고 모드와 함께 바뀐다. 호스트는 같은 WebKit 위의 Safari 사용자 에이전트를 보낸다. 호스트는 `applicationNameForUserAgent`로 WebKit 사용자 에이전트 뒤에 `Version/<major>.<minor> Safari/605.1.15`를 붙이며, 버전은 `/Applications/Safari.app`에 있는 시스템 Safari의 `CFBundleShortVersionString`이다. 영역이 Safari로 자신을 밝히는 이유는 사이트가 사용자 에이전트의 브라우저 이름으로 페이지를 고르고 브라우저 이름이 없는 WebKit 사용자 에이전트에 축소된 페이지를 보내기 때문이다. Google 검색은 그 사용자 에이전트에 회색 버튼이 있는 기본 페이지를 보내고 Safari에는 현재 페이지를 보낸다. 사이트 자체의 라이트 또는 다크 디자인은 바꾸지 않는다. Google 검색은 Safari에서처럼 두 모드에서 같은 모양으로 남는다. 사이트는 같은 설정 디렉터리로 한 이전 방문에서 저장한 모양을 보일 수 있다. 호스트는 Safari 버전을 읽지 못하면 문서 생성에 실패한다.
- `go`는 `back`, `forward`, `reload`, `stop`, 또는 0이 아닌 정수 `offset`과 함께 `entry`를 실행하고 실행 여부를 반환한다. `entry`는 현재 항목에서 그 거리만큼 떨어진 세션 기록 항목을 연다. 기록 밖의 `offset`은 false를 반환하고, 다른 동작에 `offset`을 주거나 `entry`에 주지 않으면 오류다.
- WebKit은 영역이 떠난 각 page를 back-forward cache에 WebContent process와 함께 멈춰 두고, cache가 용량을 넘을 때까지 유지한다. 5분 동안 숨겨진 영역은 back-forward cache를 비우고, host의 [memory pressure](hosts.ko.md#memory-pressure) source가 `warn` 또는 `critical`을 알리면 모든 영역이 비우고, `normal` 알림은 아무것도 비우지 않는다. back 또는 forward 항목이 없는 영역은 비울 것이 없다. 비울 때마다 `reason`이 `hidden` 또는 `pressure`인 이벤트 `native.document.backforward_cleared`로 기록한다. 그 뒤 그 영역에서 뒤로 또는 앞으로 이동하면 page를 다시 불러오며, 기록 항목은 유지된다.
- 영역은 [메모리 절약](plugins.ko.md#메모리-절약)의 질의에 `{media, capture, form}`으로 답한다. `media`는 웹뷰의 private `_isPlayingAudio`, 곧 페이지의 media 요소가 재생 중이고 mute가 아니며 volume이 0보다 큰지이고, `capture`는 공개 `cameraCaptureState` 또는 `microphoneCaptureState`가 active인지이며, `form`은 어느 frame 문서가 form 표시를 가졌는지다. 공개 `requestMediaPlaybackStateWithCompletionHandler:`는 쓰지 않는다. 답이 `paused`인 것은 페이지의 media session이 paused일 때뿐이라서 WebKit은 한 번도 재생하지 않은 media 요소가 있는 페이지에 `playing`을 답한다. 영역의 content world 스크립트는 모든 frame에서 실행되어 자기 frame 문서의 식별자를 만들고, form field(`input`, `textarea`, `select`) 또는 `contenteditable` 요소의 첫 trusted `input` 이벤트를 알린다. 영역은 식별자마다 표시를 두고, 그 frame 문서의 `pagehide` 또는 form `submit`이 표시를 지우며, reload를 포함한 main frame navigation commit이 모든 표시를 지운다. 닫힌 영역의 질의는 오류로 답한다.
- 영역은 공개 `interactionState`를 base64로, 웹뷰가 주지 않으면 빈 글로 돌려준다. 아무것도 불러오지 않은 영역은 base64 `interactionState`를 복원한 뒤 그 기록의 현재 항목을 불러온다. 이미 문서를 불러온 영역(`the document region has already loaded a document`), base64가 아닌 값(`the interactionState is not base64`), 웹뷰가 기록 항목을 하나도 복원하지 않는 값(`the web view refused the interactionState`)은 거부한다.
- 호스트는 `document-state {surface, document, state}`를 소유 표면에만 보낸다. `state`는 `{url, title, loading, progress, canGoBack, canGoForward, error, scroll: {x, y}, history: {entries, index}, link}`이다. `link`는 문서에서 포인터 아래에 있는 링크의 주소이거나 빈 글이며, 영역의 분리된 content world 스크립트가 `mouseover`와 `mouseout`에서 알린다. `error`는 마지막 로드 실패 또는 null이고, `scroll`은 CSS 픽셀 단위의 문서 스크롤 위치이며, `history`는 영역의 세션 기록이다. `entries`는 가장 오래된 항목부터 가장 새 항목까지 `{url, title}`을 나열하고 `index`는 현재 항목의 위치다. 첫 로드 전에는 `entries`가 비어 있고 `index`는 -1이다. 기록은 웹뷰의 뒤로-앞으로 목록에서 오므로 그 목록이 유지하는 항목을 가진다. 요소와 요청 스트림은 `document-state`에 들어가지 않으며 [문서 스트림](#문서-스트림)에서 정의한다.
- 호스트는 표면이 제거될 때, 그리고 표면 페이지가 새 문서를 표시하기 시작할 때 그 문서가 다시 붙이기 전에 표면의 영역을 닫는다. 새 문서는 자기 영역을 직접 붙인다.
- 대화 상자가 열려 있는 동안 호스트는 표면 문서 블러와 같은 반경으로 영역을 흐리게 한다.
- 영역은 표면과 같이 네이티브 입력에 참여한다. 포인터 입력은 앱을 활성화하지 않고 좌표의 영역에 도달하며, 페이지 초점 변경은 앱의 키보드 초점을 옮기지 않는다. `host.window`는 영역을 `documents`로 나열하며, 각각 자기 web view의 WebContent process(`process`, 그 process가 시작되기 전에는 0)를 가지고, 문서 웹뷰 또는 그 자손이 창의 네이티브 first responder일 때만 `focused`를 참으로 보고한다. `host.hit`은 `{kind: "document", surface, document}`를 보고한다([공개 항목](exposure.ko.md)).
- 표시 완료 대기에는 영역이 포함되지 않는다. 영역의 콘텐츠는 독립적으로 렌더링된다.

### 문서 스트림

문서 영역의 요소와 요청 데이터는 스트림이다. 스트림은 페이지가 구독하는 동안에만 모으므로, 구독자가 없는 영역은 요소나 요청 데이터를 보내지 않는다. 스트림 메시지는 구독을 만든 표면에만 도달한다.

- `subscribe {document, stream}`은 구독을 열고 `handle`로 답한다. `stream`은 `elements` 또는 `requests`다. `unsubscribe {document, handle}`은 구독을 끝낸다. 알 수 없는 document나 handle, 또는 호출한 표면이 소유하지 않은 document를 지정한 호출은 명시적 오류로 거부한다.
- plugin-api의 document 손잡이는 `subscribe(stream, listener)`를 가지며, 이것은 `close()`가 구독을 끝내는 handle을 돌려준다. listener는 자기 구독의 메시지를 순서대로 받는다.
- 호스트는 영역과 스트림마다 구독 수를 센다. 첫 구독이 스트림의 수집을 시작하고, 마지막 제거가 수집을 멈춘다. 호스트는 구독을 만든 표면 페이지가 새 문서를 로드할 때, 그 페이지의 web content process가 종료할 때(`webViewWebContentProcessDidTerminate:`), 또는 구독의 영역이나 창이 닫힐 때 그 구독을 제거한다. 영역의 마지막 `requests` 구독이 제거되면 그 영역의 요청 기록이 해제된다.
- 스트림을 노출하는 plugin의 status는 subscribe 함수에서 구독하고 stop 함수에서 구독을 끝낸다([노출](exposure.ko.md)). 감시 없이 그 status를 읽으면 구독하여 첫 메시지를 기다린 뒤 구독을 끝내며, 10초 안에 메시지가 없으면 명시적 오류로 실패한다.
- `elements`는 스냅샷 스트림이다. 문서 스크립트는 문서 해석이 끝날 때와 요소 트리 또는 `id`, `class` 속성이 바뀔 때 트리를 바뀐 것으로 표시하며, 변경마다 트리를 순회하지 않는다. 트리가 바뀐 것으로 표시되었거나 구독이 시작되었고 확인되지 않은 스냅샷이 없으면, 네이티브는 문서에서 스냅샷을 모아 `seq` N으로 호스트에 보낸다. 네이티브는 호스트가 `stream.ack {document, stream, seq}`로 N을 확인할 때까지 다음 스냅샷을 보내지 않는다. 호스트는 스냅샷을 스트림의 모든 구독에 전달한 뒤 확인을 네이티브에 보낸다. 호스트는 영역과 스트림마다 전달 중인 스냅샷 하나를 보관한다. 구독은 받은 가장 최근 스냅샷 하나만 보관한다. 확인되지 않은 스냅샷 중에 시작된 구독은 확인 뒤 네이티브가 보내는 다음 스냅샷을 받는다. 확인되지 않은 스냅샷 동안의 변경은 확인 뒤 스냅샷 한 개를 더 만들므로, 순회는 변경마다가 아니라 확인된 스냅샷마다 한 번 실행된다.
- 스냅샷은 `{seq, nodes, total, truncated}`다. `nodes`는 주 프레임 문서의 요소를 문서 순서로 최대 500개 나열하며, 각각 `{depth, tag, id, class}`로 소문자 태그 이름과 `id`, `class` 속성 값 또는 빈 문자열이다. `total`은 주 프레임 문서의 요소 수이고, `total`이 500보다 크면 `truncated`가 참이다. 순회는 주 프레임 문서의 요소 트리만 대상으로 하며, shadow root와 프레임은 그 밖에 있다. `seq`는 영역과 스트림의 스냅샷마다 증가하고 이동을 지나도 계속 증가한다.
- `requests`는 항목 스트림이다. 문서 스크립트는 resource 항목을 `buffered: true`로 관찰하고, 새 항목의 묶음을 보내며 전체 목록을 다시 보내지 않는다. 각 항목은 `{url, type, start, duration}`이다. 탐색 항목이 먼저 오고 그다음 각 자원이 기록된 순서대로 온다. `type`은 `navigation` 또는 자원의 initiator 형식(`img`, `script`, `link`, `fetch`, `xmlhttprequest`, `css`, `other` 등)이고, `start`와 `duration`은 탐색 시작부터의 밀리초다. Performance API는 요청 메서드, 헤더, 본문, 응답 상태, 하위 프레임의 요청, 호스트 스크립트가 실행되기 전에 페이지가 만들고 자원 타이밍 버퍼가 버린 요청을 기록하지 않으므로 스트림에는 이것들이 없다. 스크립트는 페이지의 스크립트가 소유하는 자원 타이밍 버퍼를 비우지 않는다. 관찰자는 버퍼가 가득 찼는지와 관계없이 모든 항목을 받으므로, 가득 찬 버퍼가 스트림의 항목을 버리지 않는다.
- 영역은 최대 200개 항목의 기록을 보관한다. 새 구독은 첫 `entries` 메시지로 기록을 받고 그 뒤에 새 항목을 받는다. 각 `entries` 메시지는 마지막 `reset` 이후 기록이 버린 항목 수 `dropped`를 담는다.
- 영역의 새 문서는 두 스트림의 모든 구독에 `reset`을 보낸다. reset은 확인되지 않은 스냅샷을 버리고 요청 기록을 비운다. `seq`는 계속 증가하므로, reset 전에 보낸 스냅샷에 대한 확인은 아무것도 해제하지 않으며 오류도 아니다. 네이티브는 보내지 않은 `seq`에 대한 확인을 문서, 스트림, `seq`를 밝히는 명시적 오류로 거부한다. `reset` 뒤에는 각 스트림이 새 문서의 데이터를 모이는 대로 보낸다.
- 호스트는 `document-stream {surface, document, stream, handle, message}`를 구독을 만든 표면에만 보낸다. `message`는 `{type: "snapshot", seq, nodes, total, truncated}`, `{type: "entries", entries, dropped}` 또는 `{type: "reset"}`이다. `elements` 스트림은 `snapshot`과 `reset` 메시지를, `requests` 스트림은 `entries`와 `reset` 메시지를 보낸다.
- 호스트가 스냅샷을 확인하지 않으면 다음 스냅샷은 대기한다. 구독은 그 페이지, web content process 또는 영역과 함께 끝나며, 구독이 끝나면 대기 중인 스냅샷이 해제된다.
- 문서 스크립트는 호스트 자체 콘텐츠 월드에서 실행되고 그 월드의 스크립트 메시지 처리기로 보낸다. 페이지 스크립트는 다른 월드에서 실행되어 그 처리기에 보낼 수 없으므로, 페이지는 스트림 데이터를 쓸 수 없고 자기 문서를 바꿔서만 스트림이 보고하는 내용을 바꿀 수 있다.

## 그림 영역

그림은 사이드카가 만들고 영역을 통해 코어에 공급한다. 코어는 불투명한 토큰과 픽셀 크기만 받으며, 그림 버퍼도 공급자의 정체도 토큰 외에는 알 수 없다.

- **그림 공급과 크기 검증**: manifest가 공급 사이드카를 지정한다. 호스트는 적용한 네이티브 프레임에서 래스터 리비전과 정확한 크기를 계산해 공급자에게 보낸다. 프레임은 부착 세대, 래스터 리비전, 단조 증가 시퀀스, 실제 토큰 크기, 예상 크기, 창 배율이 모두 맞아야 한다. 불일치는 거절하며 이전 유효 스냅샷을 교체하지 않는다.
- **장치 픽셀 보고**: 영역은 CSS 픽셀이 아닌 장치 픽셀 단위로 크기를 보고한다.
- **입력 처리**: 포인터는 아래의 표면 문서로 통과하고, 포인터의 커서도 그 문서가 정한다. 영역은 커서 사각형이나 커서 추적 영역을 등록하지 않는다. 선택할 수 있는 `NSTextView`의 I-빔 커서 영역이, 키 창이 된 창의 커서 영역을 AppKit이 다시 만들 때 영역 위 페이지 요소의 커서를 덮었기 때문이다. 창의 뷰 배치가 바뀌면 AppKit은 포인터 아래 뷰에 커서 갱신을 요청한다. `WKWebView`는 이 요청에 답하지 않으므로 창이 화살표를 설정하게 된다. 창 합성 뷰는 현재 포인터 위치를 포인터 아래 WebKit 뷰의 추적 소유자에게 마우스 이동으로 넘겨 답하고, WebKit은 그 위치의 페이지 커서를 설정한다. 포인터 라우팅은 대상 WebKit 뷰가 바뀌거나 애플리케이션이 활성화된 뒤 첫 이동도 추적 소유자에게 전달한다. 이벤트 처리 중 해당 뷰의 마우스 추적을 켜면 포인터가 영역을 나갔다가 다시 들어오기 전까지 페이지 커서가 갱신되지 않을 수 있기 때문이다. 마우스 버튼을 누른 동안은 합성 이동을 넘기지 않는다. 키보드 입력, 입력 조합, 접근성은 영역이 갖는다. 영역이 키보드와 조합 이벤트를 받으며: `{type: "key", key: 이름, text?, shift, alt, ctrl}`, `{type: "insert", text}`, `{type: "compose", text?, caret?}`, `{type: "focus", focused: boolean}`. 키는 페이지에 전달된다. 명령 키 조합은 애플리케이션 메뉴가 가로챈다. 초점은 호스트의 요청으로 바뀌고, 현재 위치는 `host.window`로 관찰한다. 포인터 눌림은 영역을 지나 페이지로 통과하며, AppKit의 눌림 라우팅은 제스처 준비 동안 첫 응답자를 눌린 페이지 뷰에 넘긴다. 이 이관은 초점 변화가 아니다. 영역은 보고하는 초점을 유지하고 응답자를 스스로 되찾으므로 초점 보고를 지켜보는 프로그램은 아무것도 보지 못하고, 영역 밖 눌림은 여전히 초점 상실을 보고한다. 다른 그림 영역 안의 눌림은 영역-영역 전환이다: 초점을 가졌던 영역은 초점 상실을 보고하고 같은 이벤트 처리 안에서 응답자를 눌린 영역에게 넘긴다 — 페이지 웹뷰가 키보드를 가진 창이 남으면 문서가 자기 activeElement 에 초점을 되돌려 브라우저 카드의 주소 입력이 제스처 동안 눈에 보이게 초점을 받았다.
- **접근성**: 영역은 접근성 요소다. 그 값은 소유자가 `setAccessibleText`로 주는 화면 텍스트다.
- **그림 소비**: 호스트는 받은 전송 그림을 호스트 소유 불변 표시 저장소로 복사한 뒤 `consumed`로 답한다. 공급자는 그 답 전까지 전송 그림을 수정하거나 재사용하면 안 된다. 네이티브 레이어는 공급자가 덮어쓸 수 있는 저장소를 가리키지 않는다. 소유 창이 없는 표면의 전송 그림에는 `{image:{error:"closed",name,generation,raster,sequence}}`로 답하므로, 공급자는 그 그림을 놓고 같은 id 표면의 이후 답을 그 그림에 맞추지 않는다.
- **권한**: 영역이 공급을 허가할 사이드카를 지정한다. 호스트는 등록되지 않은 사이드카의 그림을 오류와 함께 거절한다.
- **오류 보고**: 호스트가 그림을 표시할 수 없으면 영역이 오류 이벤트를 보낸다: `{type: "error", reason}`. 사유에는 `notFound`(IOSurface를 찾지 못함), `forbidden`(접근 거부), `size`(선언한 크기가 IOSurface의 실제 크기와 맞지 않음), `scale`(창 배율과 다른 배율로 그린 그림), `presentFailed`(플랫폼 표시 실패)가 있다.
- **끝난 사이드카**: 어떤 plugin도 선언하지 않는 사이드카의 그림, 예를 들어 카드가 열린 채 plugin을 제거할 때 오가던 그림은 buffer와 함께 끝난 process의 것이다: 호스트는 그것을 표시하지 않고 `stale`로 답하고 기록하며, 오류 이벤트를 보내지 않고 복구를 시작하지 않는다. 끝난 사이드카에 닿지 못하는 답은 보내지 않음으로 기록된다.

`host.window.regions[].error`는 유효한 프레임이 표시될 때까지 마지막 네이티브 표시 거절을 유지한다. 이전의 유효 스냅샷이 이후 거절을 없애지는 않는다. 그림 픽셀은 네이티브 백킹 배율에서 크기를 유지하며, 레이어 크기 변경으로 글자를 늘려 새 영역을 채우면 안 된다.

두 호스트는 각 네이티브 그림 이벤트를 `image-event {surface, name, event}`로 소유 표면 웹뷰에만 전달한다. 빈 콜백, 전체 전송, 키보드 전달을 직접 사이드카 명령으로 대체하는 것은 계약 위반이다. 잘못된 이벤트 JSON과 전달 실패는 보고하며 null 이벤트로 대체하지 않는다.

터미널은 최신 셀 행을 `terminal.screen`으로 공개하고 사이드카 화면 이벤트마다 구독자에게 알린다. 입력 검사는 네이티브 클릭과 키를 사용하고 이 알림을 기다리며, 보이는 터미널 최소 3개에서 편집·명령 출력·입력 격리를 확인한다. `terminal.input`은 직접 사이드카 입력만 검사하며 네이티브 키보드 전달을 검증하지 않는다.

## 인수 기준

- 측정 가능한 모든 녹화 프레임에서 네이티브 콘텐츠가 해당 카드 내부에 있어야 한다. 네이티브 본문, 카드 UI, 레일 사이드바, 외곽 레일의 상대 좌표는 같은 프레임에서 유지되어야 한다. 일시적인 내부 여백 증가도 이 요구사항을 충족하지 않는다.
- 레일 외곽선처럼 카드를 따라가는 페이지 그리기는 마지막 그리기가 카드 요소에 쓴 사각형과 판의 CSS 픽셀을 쓴다. 준비가 대기 중인 동안 격자는 이미 다음 배치를 가지므로, 격자로 그리면 그림이 카드보다 먼저 움직인다.
- 경계를 끄는 동안 녹화된 프레임은 격자가 한 걸음의 배치를 떠난 뒤 최대 화면 네 프레임 안에 그 배치를 보여주고, 끌기 전체에서 지연의 중앙값은 2.5 프레임, 90번째 백분위수는 3 프레임 이하다(60Hz에서 66.7ms, 41.7ms, 50ms). 배치는 입력 도착, 앞 배치의 프레임, WebKit 렌더링 갱신, 화면 갱신의 네 프레임 경계를 지나 화면에 나온다. 배치는 앱 DOM 웹뷰의 다음 표시를 기다리므로, 그 웹뷰는 WebKit 기본값인 60fps 근처 렌더링 대신 화면의 갱신 주기로 렌더링한다. 같은 이유로 앱 DOM 웹뷰는 창이 가려져도 문서를 visible로 유지하고 animation frame을 계속 실행한다. 그렇지 않으면 배치와 그 배치를 기다리는 모든 command가 창이 드러날 때까지 끝나지 않는다. 붙인 surface 웹뷰도 같게 동작하므로, 창이 가려진 동안에도 그 비활성 capture와 paint 확인이 끝난다.
- 이 그리기는 요소의 상자에 맞춰지는 좌표계를 쓰지 않는다. 그 좌표계는 이전 그림을 새 상자에 맞추므로 그림이 카드보다 먼저 움직인다.
- 표시되기 전에 대신된 배치는 화면에 나오지 않으므로, 빠른 두 왕복 사이의 시작 위치처럼 포인터가 한 번의 표시보다 짧게 머문 위치는 녹화에 없을 수 있다. 드래그 녹화는 시작 위치에서 시작하고 끝나며, 왕복마다 먼 끝에 도달한다.
- 드래그 입력은 요청한 속도로 완료되어야 하며 녹화는 드래그 전체를 포함해야 한다. 입력 전에 녹화를 시작한다. 제어 검사는 캡처에서 최종 좌표를 확인한 뒤 녹화를 종료한다. 표시 콜백이나 프레임 시각만으로 종료하지 않는다.
- 녹화 프레임이 부족하거나 대부분의 프레임에서 표면과 카드를 식별하지 못하면 검사는 실패해야 한다.
- 연속 입력 중에도 화면 배치가 갱신되어야 한다. 입력 종료까지 모든 렌더링을 연기하는 구현은 이 명세를 충족하지 않는다.
- 표면 생성, 교체, 숨김, 창 크기 변경, 문서 다시 로드 중에도 이 요구사항을 유지해야 한다.
- 문서 영역은 표면이 이동하거나 크기가 바뀌어도 자기 요소 위에 있고, 앱을 활성화하지 않고 네이티브 스크롤 입력을 받으며, 표면과 함께 닫힌다.
- 소수점 크기 검사는 실제 CSS 사각형과 녹화된 픽셀을 측정한다. 정수 값을 반환하는 뷰포트 조회만으로 렌더링된 문서 영역을 판단하지 않는다.
- 네이티브 표면 내부의 마지막 장치 픽셀도 문서 히트테스트에 포함해야 한다.
- 창 크기 변경과 화면 배율 전환 후에도 네이티브 포인터 좌표가 문서 좌표와 일치해야 한다.
- 설정과 메뉴 웹뷰는 표면 위에 표시해야 한다. 동작은 [data-native-modal](native-modals.ko.md)에 정의한다.

## 플랫폼 범위

표면 배치, 표시 여부, 겹침 순서와 입력은 모든 호스트와 운영체제에서 같은 계약을 따른다. 네이티브 구현은 대상 플랫폼의 API와 좌표계를 사용한다.

플랫폼과 프레임워크의 결함은 필요한 경우 이 저장소 내부의 호스트 네이티브 코어에서 수정한다. 공개 API로 필요한 동작을 정확히 구현할 수 없으면 비공개 API를 사용할 수 있다. 각 수정은 원인을 확인하고, API의 실제 동작으로 사용 이유를 설명하며, 요구사항을 충족하는 최소 구현을 사용하고, 해당 플랫폼에서 좌표·렌더링·입력·생명주기를 검증해야 한다. 해롭거나 불필요한 수정은 제거한다. 테스트 통과는 검사한 동작의 근거이며, 구현 검토에서 필요성과 올바른 API 사용도 확인해야 한다. API 가용성과 유지보수 위험은 수정의 기술적 타당성과 구분해 기록한다. 호스트 간 차이는 프레임워크 연동과 네이티브 동작을 진단해야 하며, 차이 자체로 원인을 확정하지 않는다.

현재 네이티브 표시 검증 대상은 macOS다. Windows와 Linux 동작은 검증하지 않았다. 이 구현은 프레임워크 포크를 포함하지 않는다.

### darwin

macOS 그림 영역의 토큰은 전역 IOSurface 식별자와 그 표면에 붙인 16바이트 논스로 이루어진다. 호스트가 그림을 받으면 식별자로 표면을 조회하고, 논스가 일치하지 않으면 거절한다. 이는 재사용된 32비트 식별자를 방지한다.

IOSurface 식별자는 프로세스 소유자의 전역 사용자 네임스페이스에 있다. 같은 사용자의 다른 프로세스도 표면을 조회해 열 수 있다. 이 신뢰 경계는 사이드카 통신에 쓰는 엔드포인트 소켓과 같다.
