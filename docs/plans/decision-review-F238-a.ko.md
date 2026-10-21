# 결정 검토 F238-a: 뷰 영역(D4)과 origin 형식(D7)

[English](decision-review-F238-a.md)

이 기록은 적대적 검증 없이 내려진 두 결정을 검토한다: D4(뷰 영역, F228)와 D7(origin 형식, F235와 F237). 각 결정은 무엇을 결정하는지, 이유, 파일과 줄 번호가 있는 근거, 필요한 변경을 적는다. 새 감사자(claude-haiku-5-5)는 결정이 틀리거나 불완전한 곳만 반론하고 해결책을 제시한다. 표현과 인용 수정은 직접 반영한다. 한 라운드의 두 감사자가 실질적 반론이 없을 때까지 라운드를 반복한다.

인용은 코드가 있는 브랜치를 함께 적는다. `main`에는 F228과 F237이 없다.

브랜치: `feat/view-region-F228`, `fix/view-region-close-F228-5`, `fix/view-origin-F237`, `feat/view-bridge-F231`, `main`.

## D4. 뷰 영역(F228)

### 결정

1. 영역 작업은 뷰 호출이다. 뷰는 `sok-view`로 호스트를 호출하고, 워크벤치가 각 호출에 발신 surface를 찍어 영역 기록을 거쳐 영역 호출을 보낸다.
2. 거부 집합. `packages/workbench/view-calls.js`의 `REGION_HOST_CALLS`는 합성, 문서, 이미지 종류의 호스트 명령 중 명시적 허용 목록이다. 호스트가 명령 표(`packages/host/tauriv2/src/bindings.rs`와 Wails 대응본)에 등록한 영역 종류 명령이며, 각 이름에 이유를 단다. 이름은 Rust의 snake_case 식별자(`document_attach`)와 Go의 PascalCase 메서드(`DocumentAttach`)를 camelCase 이름(`documentAttach`)으로 바꾼 뒤 비교한다. `imagePlace`(`surface-modules.js:110`, 플러그인 `image.place` 호출)는 두 표 어디에도 호스트 명령이 없고 `packages/`와 `plugins/`에 호출자가 없다. 워크벤치 표면과 `REGION_HOST_CALLS`(`view-calls.js:82`)에서 제거하며, 허용 목록 테스트가 그 부재를 확인한다(필요한 변경). 테스트는 그 표를 읽어 영역 종류 항목이 허용 목록과 같음을 확인하고, `documentWebviews`(명령이 아니라 창 사실)가 어느 쪽에도 없음을 확인한다. 두 번째 테스트는 `packages/workbench/`에서 `invoke`, `composed`, `hostClose`, `bridge.call`, `scoped.native.call`에 전달되는 `document*`, `image*`, `composition*` 리터럴 이름을 스캔한다. 이 스캔은 보조이며, 리터럴이 허용 목록에 없으면 실패한다.
3. 모든 플러그인 쪽 경로에서 거부. 플러그인 코드는 둘 다 `invoke`(`packages/workbench/host.js:204`)로 이어지는 두 핸들로 호스트에 닿는다. `runtime.native`(`native: { call: invoke, on }`, `host.js:251-252`)와 `call(name)`(`host.js:257-261`, 점이 없는 이름은 `invoke`로 보낸다). `surface-modules.js:462`는 현재 원시 `scoped.native`를 `runtime.native`로 노출하며, 이를 게이트 래퍼로 바꾼다. 래퍼의 `call`은 `REGION_HOST_CALLS`의 모든 이름을 영역 오류로 거부하고, 래퍼의 `on`은 항목 4의 이름만 받는다. 워크벤치 페이지는 `pageRuntime`(`surface-modules.js:84`)에 원시 `scoped.native`를 유지한다. 그것은 플러그인 코드가 아니다. 거부는 공유 게이트 래퍼에 두어 모든 플러그인 쪽 경로가 통과하게 한다. 테스트는 허용 목록의 각 이름으로 뷰 런타임의 `native.call`(`surface-modules.js:280`)과 구독(`surface-modules.js:249`, `createViewSubscriptions`)도 같은 래퍼로 만들어, 뷰 `run`의 `runtime.native.on`도 게이트를 거친다. `VIEW_BRIDGE_CALLS = {viewRequest, viewEvent, viewReply}`(호스트 명령 `bindings.rs:494-510`, 워크벤치의 원시 호출 `surface-modules.js:257, 263, 333`)는 같은 래퍼가 거부한다. 테스트는 허용 목록과 `VIEW_BRIDGE_CALLS`의 각 이름으로 `runtime.native.call`, `call`, 뷰 `run`을 호출해 거부를 확인하고, 영역 이름이 `registry.handle`(`host.js:258`)에 닿지 않음을 확인한다.
4. `runtime.native.on`은 `REGION_EVENTS`의 이름만 받는다. `REGION_EVENTS`는 `surface-modules.js`가 구독하는 네 영역 이벤트 `document-stream`(`:103`), `document-state`(`:105`), `document-message`(`:106`), `image-event`(`:115`)와 정확히 같다. 테스트는 (a) `REGION_EVENTS`가 이 네 리터럴과 같음을, (b) `runtime.native.on`이 뷰 브리지 내부 이벤트 `view-call`, `view-reply`, `view-stopped`, `view-responsiveness`, `view-presentation-abandoned`(`surface-modules.js:320-507`)를 거부함을 확인한다.
5. 쌓임 순서(시각과 입력 모두, 위에서 아래): 뷰 DOM 오버레이, 뷰 영역, 뷰 페이지 DOM. 보이는 뷰 오버레이 사각형 안의 점은 그 뷰의 DOM에 히트가 있을 때 오버레이의 DOM 뷰(`webview` 또는 `mainWebview`)로 가고, 없으면 아무에게도 가지 않는다. 하이브리드 surface의 `mainWebview`도 `webview`와 같은 방식으로 히트 검사한다. 영역이나 네이티브 평면으로 가지 않는다.
6. 재적용: 이미지 영역은 로컬 `CATransaction` 안에서 insets를 다시 적용한다. 문서 영역은 배치 시점과 `NSViewFrameDidChangeNotification` 관찰자에서 다시 적용하며, 둘 다 `CATransaction` 안에서 실행되지 않는다. 명세는 문서 영역에 대해 창 트랜잭션을 주장하지 않는다.
7. hit-test 소유자. hit-test 수정의 소유자는 하나, `fix/view-region-close-F228-5`다. 이 브랜치가 이미 `hitTest`(`webview_geometry.m:283-300`)를 고쳐 쓴다. 같은 파일의 `SPWindowComposition.hitTest`(`:183-194`)도 같은 소유자가 고친다. 하이브리드 대응 경로이며, `:189`가 DOM 검사 없이 `mainWebview`의 히트를 반환한다. `feat/view-region-F228`은 `hitTest`를 바꾸지 않는다. 그 버전은 fix 브랜치가 병합될 때 대체되며, feat 브랜치는 자체 `hitTest` 변경을 병합하지 않는다.

### 감독자 결정 F238-a-14-5(확정)

F238-a-2는 `runtime.native.on`으로 view가 구독할 수 있는 event를 네 영역 event로 제한했다. 그 제한은 `exposure-request`도 함께 제거했다. 이 event는 view exposure의 선언된 경로(`docs/spec/exposure.ko.md`, F212.7-12)이며 영역 event가 아니다. 이를 되돌리는 것은 허용 목록을 넓히는 것이 아니다. 제한이 실수로 제거한 선언된 core 경로를 복원하는 것이다. 구독할 수 있는 집합은 네 영역 event와 `exposure-request`이며, `packages/workbench/view-calls.js`의 명시적 목록 `PLUGIN_NATIVE_EVENTS`에 한 번만 적는다(spec: `docs/spec/native-surfaces.ko.md#플러그인-host-호출`). 그 밖의 event 이름은 `native event <name> is not served`로 계속 거부한다. `REGION_EVENTS`는 네 영역 event를 유지한다. Red: `exposure-request`를 구독하고 요청을 받는 view 시험은 바뀌지 않은 gate에서 거부되었다(`native event exposure-request is not served`). 목록에 추가한 뒤 Green이며, 목록에 없는 event에 대한 거부 시험은 그대로 둔다.

이 결정으로 해결되는 항목: F238-a-14-3과 F238-a-14-4(shell과 editor의 `exposure-request` 구독)는 plugin 변경이 필요 없다. F238-a-14-1과 F238-a-14-2(`report` 호출)는 각 저장소 소유로 열려 있다.

### 이유

스탬프된 뷰 호출을 거친 라우팅은 revision, 영역 수명, 영역 기록을 영역에 닿는 유일한 경로로 만든다. 원시 호스트 호출은 이를 건너뛴다(feat `view-calls.js:74-76`). 이것은 그 근거를 가진 워크벤치 선택이지, 플러그인 프로세스 규칙 9의 결과가 아니다. 규칙 9는 봉투 검사만 제공한다.

쌓임은 표면 합성 계약을 따른다. "선언된 플러그인 오버레이와 워크벤치 메뉴/대화상자는 네이티브 문서 영역 위에서 입력을 소유한다"(main `docs/spec/surface-composition.md:24`), "네이티브 콘텐츠는 오버레이의 점을 소유할 수 없다"(`:28`). 영역은 네이티브 콘텐츠이므로 뷰 오버레이 아래에 놓인다.

### 근거

- E1(라우팅). feat의 `packages/workbench/view-calls.js` `runtime.native.call` 분기(`:105-118`)는 `REGION_HOST_CALLS`(`:78-83`)의 이름을 "뷰는 합성을 통해서만 영역을 다룬다" 메시지로 거부한다.
- E2(거부 집합 누락). feat의 `surface-modules.js`에서 영역 종류 호출이 나온다. `invoke`는 `:92`부터 `:113`까지(`documentAttach`, `documentLoad`, `documentZoom`, `documentGo`, `documentSubscribe`, `documentUnsubscribe`, `documentPost`, `imageAttach`, `imageFocus`, `imageCaret`, `imageText`, `imageDetach`), `composed`는 `:110`(`imagePlace`)과 `:131`(`compositionPlace`), `invoke`는 `:120`(`compositionDeclare`). `host.js:462-463`은 `bridge.call("documentQuery")`와 `bridge.call("documentInteractionState")`를 호출한다. `REGION_HOST_CALLS`(`view-calls.js:78-83`)에는 둘 다 없다. `invoke(`만 grep하면 놓치므로 결정 항목 2의 리터럴 스캔에 `bridge.call`을 포함한다.
- E3(플러그인 쪽 경로). `host.js:251-252`는 `native: { call: invoke, on }`을 노출하고, `call(name)`(`host.js:257-261`)은 점이 없는 이름을 `invoke`로 보낸다. `surface-modules.js:462`는 원시 `scoped.native`를 `runtime.native`로 준다. 따라서 플러그인 코드는 두 핸들로 거부를 우회할 수 있고, 리터럴 스캔은 변수로 전달된 이름을 보지 못한다. 결정 항목 3의 게이트 래퍼가 맡는다.
- E4(hit test, fix 브랜치). `fix/view-region-close-F228-5:native/darwin/src/webview_geometry.m:283-300`. 보이는 오버레이 사각형 안의 점에 대해, `self.webview`가 보이고 그 DOM 히트가 nil이 아니면 반환한다(`:292-293`). `self.mainWebview`가 설정되면 nil을 반환한다(`:296`). 그 밖에는 루프가 `continue`하고(`:287`) 점이 `self.nativePlane`으로 떨어진다(`:298-300`). 따라서 `webview`와 `mainWebview`가 없는 DOM 전용 surface에서 보이는 오버레이의 점은 네이티브 콘텐츠가 받는다. 명세(`surface-composition.md:28`)가 금지하는 상태다. fix 브랜치 주석(`:289-290`)은 하이브리드 앱 DOM이 "오버레이 아래 입력을 유지한다"고 쓰는데, 네이티브 평면이 그 입력을 받는 것이 결함이다.
- E5(hit test, feat 브랜치). `feat/view-region-F228:webview_geometry.m:283-303`은 `mainWebview`가 설정되면 보이는 오버레이 아래에서 nil을 반환하고(`:287`), `webview`가 nil이거나 그 DOM 히트가 nil이면 네이티브 평면으로 떨어진다(`:288-299`). 이 버전은 E4의 브랜치로 대체된다(결정 항목 7).
- E6(마스크 경로). `packages/host/tauriv2/src/composition.rs:315-325` → `platform/darwin/webview.rs:196-208` → `webview_geometry.m:761-771`(feat) / `:783-793`(fix) → `domOverlays` setter → `applyOverlayMask`. 마스크 경로는 존재한다. 통과 전에 뷰 오버레이가 마스크에 도달함을 단위 테스트로 증명해야 한다.
- E7(재적용). `image_region.m`의 `applyInsetsNow`는 `:363-368`에 있으며 `CATransaction`(`:371-372`) 안에서 실행되고 `:1244-1249`에서 호출된다. `document_view.m:1068`(feat)과 `:1076`(fix)은 문서 영역을 네이티브 평면에 붙이고, `:1266`(feat)과 `:1275`(fix)은 배치 시점에 insets를 적용하며, `:898-938`은 프레임 변경 관찰자에서 다시 적용한다. 문서 경로를 감싸는 `CATransaction`은 없다.
- E8(명세). main `docs/spec/native-surfaces.md:178`은 모든 구성에 대해 바깥 surface가 바뀔 때 insets를 다시 적용한다고 쓰며, 그 가운데 "같은 네이티브 트랜잭션에서"라고 쓰며, 이는 이미지 영역에만 참이다(E7).

### 필요한 변경

- 소유 `feat/view-region-F228`: `REGION_HOST_CALLS`를 허용 목록으로 고치고 `documentQuery`와 `documentInteractionState`를 추가한다. 결정 항목 2와 4의 테스트를 추가한다(수정 전 집합과 `runtime.native.on`에서 Red). `surface-modules.js:462`의 `runtime.native`를 게이트 래퍼로 바꾸고 결정 항목 3의 거부를 둔다(Red 먼저).
- 소유 `feat/view-region-F228`: `view-calls.js`에 `REGION_EVENTS`를 결정 항목 4의 네 이벤트로 정의하고, 래퍼의 `on`이 그 이름을 검사하게 한다.
- 소유 `feat/view-region-F228`: 플러그인 표면에서 `image.place`(`surface-modules.js:110`)와 `REGION_HOST_CALLS`의 `imagePlace`(`view-calls.js:82`)를 제거하고, 제거를 `docs/spec/plugins.md`에 적는다. `packages/plugin-api/image-region.js`의 `place` 경로(`placeAt`, `visible`의 place 호출, `_place`)와 그 테스트도 제거한다. `attachImage`는 남는다. `packages/plugin-api/surface-composition.js:239`가 합성의 이미지 영역에 `observe: false`로 호출하며, 그 영역은 `compositionPlace`로 호스트에 닿는다. 테스트는 제거 뒤에도 합성에 선언된 이미지 영역이 `compositionPlace`에 닿음을 확인한다. 허용 목록 테스트는 `imagePlace`가 명령 표와 `REGION_HOST_CALLS` 모두에 없음을 확인한다.
- 소유 `fix/view-region-close-F228-5`(`hitTest`를 바꾸는 유일한 브랜치): `webview_geometry.m:283-300`의 루프에서, 보이는 오버레이 사각형 안의 점은 오버레이의 DOM 히트 또는 nil을 반환하고 `self.nativePlane`에 닿지 않게 한다. `self.mainWebview`의 nil 반환(`:295`)은 `webview`와 같은 DOM 검사로 바꾼다. `mainWebview`가 보이고 그 DOM 히트가 nil이 아니면 그것을 반환하고, 아니면 nil을 반환한다. `SPWindowComposition.hitTest`(`:189`)는 `local`을 넘기고 DOM 검사 없이 `[self.mainWebview hitTest:local]`을 반환하므로 같은 규칙을 적용한다. 두 메서드 모두 들어온 점을 먼저 `self.superview`에서 변환한다(`SPWindowComposition`은 `:185`에서 그렇게 하고, `SPSurfaceHost`는 `:283-286`에서 하지 않으며 해야 한다). 각 하위 뷰는 직접 하위 뷰이므로 `[view hitTest:]`는 surface 호스트의 좌표를 받는다. 0이 아닌 프레임 원점을 쓰는 Red 단위 테스트가 두 메서드를 모두 다룬다. 단위 테스트: 투명한 오버레이 점은 nil, DOM 점은 그 뷰. `mainWebview`도 `webview`와 같이 DOM 히트가 있으면 그것을, 없으면 nil을 반환한다. 수정 전 코드에서 Red인 단위 테스트: (a) DOM 전용 surface, 네이티브 평면 위의 오버레이 점, nil 기대; (b) 투명한 DOM 점의 뷰 오버레이, 네이티브 히트 없음 기대; (c) 숨겨진 `webview`, 보이는 오버레이 사각형에서 네이티브 히트 없음 기대; (d) `mainWebview` 설정과 DOM 히트, 그 히트 기대. `mainWebview` 설정과 DOM 히트 없음, nil 기대.
- 소유 `fix/view-region-close-F228-5` 또는 `feat/view-region-F228`(먼저 병합되는 쪽): 뷰 오버레이가 `applyOverlayMask`에 도달함을 확인하는 단위 테스트(E6).
- main 명세(`docs/spec/surface-composition.md`, `docs/spec/native-surfaces.md:178`, ko 대응본): 결정 항목 5의 쌓임 순서를 적고, "같은 네이티브 트랜잭션"을 이미지 영역에만 한정한다.

### 반론과 답변

- 1라운드, 감사자 A: 테스트는 `host.js`가 아니라 `surface-modules.js`를 스캔해야 하고, `REGION_EVENTS`는 정의되지 않았다. 수용.
- 1라운드, 감사자 B: 같은 원천 누락, `hostClose`와 `composed`, 두 번째 hit-test 누출. 수용.
- 2라운드, 감사자 D, 반론 1: 변수로 전달되는 이름과 플러그인 쪽 `call`(`host.js:235`). 수용. 결정 항목 3이 그 경로에서 실행 시 거부한다.
- 2라운드, 감사자 D, 반론 2: `REGION_EVENTS`가 뷰 내부 이벤트를 누출할 수 있다. 수용. 결정 항목 4가 네 이벤트로 고정하고 다섯 내부 이벤트를 테스트한다.
- 2라운드, 감사자 D, 반론 3, 그리고 감사자 C, 반론 3: fix 브랜치는 `webview`와 `mainWebview`가 없을 때 오버레이 점을 네이티브 콘텐츠에 누출한다(E4). 수용. 이전 본문은 fix 브랜치가 깨끗하다고 잘못 적었다. 수정은 fix 브랜치에 있다(필요한 변경).
- 2라운드, 감사자 C, 반론 1: `REGION_EVENTS`는 "모든 구독"이 아니다. 수용(결정 항목 4).
- 2라운드, 감사자 C, 반론 2: `bridge.call` 이름에 리터럴 스캔이 필요하다. 수용(결정 항목 2).
- 2라운드, 감사자 D, 반론 3: hit-test 수정은 한 브랜치가 소유해야 한다. 수용(결정 항목 7).
- 3라운드, 감사자 E, 반론 1, 그리고 감사자 F, 반론 1: 플러그인 쪽 `runtime.native`가 원시 `scoped.native`라서 거부가 우회된다(E3). 수용. 게이트 래퍼가 `call`, `native.call`, `native.on`을 모두 맡는다(결정 항목 3).
- 3라운드, 감사자 F, 반론 2: `REGION_HOST_CALLS` 도출 규칙이 명시적이지 않다. 수용. 허용 목록과 명령 표 대조로 바꾼다(결정 항목 2).
- 3라운드, 감사자 E, 반론 2 가운데 호스트 명령 표 확인과 F, 반론 3: `mainWebview`는 DOM 히트를 반환해야 하는데 결정 항목 5와 테스트 (d)가 모순된다. 수용. 두 곳을 같은 규칙으로 고친다(결정 항목 5, 테스트 (d)).

## D7. origin 형식(F235, F237)

### 감독자 결정(16라운드)

다음 결정은 구속력이 있다. 각 결정은 이유를 함께 적는다. 아래 결정 항목이 이를 적용한다.

1. 형식. `projects.json`은 형식 1을 유지한다. AGENTS.md는 저장 형식이 바뀔 때 형식 번호를 올리고 이동을 제공하도록 요구하며, 이 규칙은 공개된 파일이 바뀐 형태를 담을 수 있을 때 적용된다. 공개된 core에는 뷰 surface가 없다. 뷰는 병합되지 않은 브랜치에만 있고 core `main`에도 공개된 뷰가 없다. 따라서 공개된 형식 1 파일은 뷰 탭을 담지 않고, 선택 origin 멤버는 어떤 공개 형태의 읽기도 바꾸지 않으며, 규칙은 촉발되지 않는다. 면제도 아니다. 규칙의 시험: 공개된 파일이 뷰 탭을 담을 수 있다면 규칙이 적용되어 형식을 올리고 이동을 둔다. 이유: 이 규칙은 설치된 데이터를 보호하며, 설치된 데이터 중 바뀐 형태를 담은 것은 없다.
2. 읽기 경계. origin은 레이아웃을 읽을 때 한 번 검증한다. `restoreOrigin`은 검사기 `checkViewOrigin`을 실행하고 각 거부를 그 탭의 데이터로 싣는다. 탭은 거부 상태로 복원되며, 그 상태는 항목 4의 이름 붙은 문구를 담고, 그것을 표시하고, 로그에 기록한다. 복원은 던지지 않으며, 뷰 시작은 거부 상태를 읽고 뷰를 시작하지 않는다. 이것은 감사자 A의 제안(15라운드, 반론 3)이다. 13라운드를 뒤집지 않는다. 13라운드는 복원이 던지지 않아야 한다고 요구했고 이 결정은 그것을 지킨다. 바뀌는 것은 검사기의 자리뿐이며 뷰 시작에서 레이아웃 읽기로 옮겨진다. 이유: 이름 붙은 오류가 레이아웃을 읽는 시점에 탭마다 한 번 나타나고, 뷰 시작은 찾은 상태를 보고할 뿐 다시 판단하지 않는다.
3. 15라운드에서 수용된 항목. 아래 결정 항목에 적용한다: 복원 문구 하나, 부재한 origin은 적재된 것으로 보고 거부, `tabOrigin` 폴백 제거는 엄격한 뷰 시작 거부와 같은 변경에서, NUL과 배열 분류, 거부마다 탭별로 로그와 표시이며 탭은 레이아웃에 남음, 저장 읽기 규칙 하나, 다운그레이드 결과. 이유: 각 항목은 15라운드에서 수용되었고, 결정 1과 2가 이를 일관되게 한다.
4. 플러그인/shell 항목. F238-a-17로 번호를 매기고, 소유는 shell 저장소다. 정확한 변경: `plugins/shell/ui/view.js:22`와 `plugins/shell/test/view.test.mjs:47-53`이 null을 기본 origin으로 취급하지 않게 한다. 뷰 시작은 origin 부재를 항목 4의 부재 문구로, null origin을 항목 4의 형식 문구로 거부한다. 테스트, Red 먼저, shell 저장소에서. 이유: 결함이 다른 저장소에 있어 추적할 체크리스트 번호가 필요하며, 그 하위 항목은 소유자 아래에서 열린 채로 남는다.

### 감독자 결정(15라운드, 읽기 경계와 형식 문구는 16라운드로 대체)

데이터의 이동은 없다. 항목 4의 origin 형식을 갖추지 못한 영속 탭은 탭별로 이름 붙은 오류로 거부된다. 오류는 로그에 기록되고 그 탭에 표시되며, 탭은 조용히 버려지지 않는다. 사용자는 탭을 다시 연다. 이유: Core는 0.0.x이고 공개되지 않은 뷰는 보존할 설치 상태가 없다. 바인딩 규칙은 하위 호환, 호환 계층, 폴백, 이동을 금지하고, 잘못된 입력을 그럴듯한 값으로 바꾸는 것을 금지한다. 이동이 쓰는 `{directory: null}`도 그런 값이므로, 이동과 11·14라운드의 논거를 제거한다. `projects.json`의 형식 번호는 1로 남는다(항목 7). 바뀌는 것은 항목 7의 업그레이드 부분뿐이다.

### 감독자 결정: 뷰가 아닌 탭(구속력 있음, 비뷰 탭의 읽기에 대해 R1을 대체)

1. 저장. 이제부터 쓰이는 모든 탭은 뷰 탭과 뷰가 아닌 탭 모두 origin을 `{directory}`로 저장한다(F238-a-9, F238-a-10). `capture()`는 콘텐츠 카드 탭마다 이를 쓴다.
2. 읽기, 뷰 탭. origin 멤버가 없거나 유효하지 않은 뷰 탭은 항목 4의 문구로 탭별 거부된다(16라운드 결정대로).
3. 읽기, 뷰가 아닌 탭. origin 멤버가 없는 뷰가 아닌 탭은 릴리스된 형식 1의 형태다. 그 릴리스된 읽기 규칙은 그대로 둔다. origin은 `{directory: null}`이다. 이를 바꾸면 릴리스된 형태의 읽기가 바뀌어 AGENTS.md의 형식 규칙이 발동한다. 규칙은 `packages/workbench/tab-reports.js`의 이름 붙은 함수 하나 `releasedNonViewOrigin()`이며, `docs/spec/projects.md`(및 ko 대응)에 형식 1의 뷰가 아닌 탭 읽기 규칙으로 적는다. 새 폴백이 아니다. `tabOrigin`의 일반 폴백을 포함해 다른 모든 폴백은 제거한다(F238-a-12).
4. 시험. 하나는 멤버가 없는 뷰가 아닌 탭의 분기(`releasedNonViewOrigin()`으로 `{directory: null}`을 읽음)이고, 다른 하나는 멤버가 없는 뷰 탭의 분기(항목 4의 origin 부재 문구로 거부됨)다.
5. 이유. 릴리스된 형태는 읽기를 유지해야 한다. 읽기가 바뀌면 형식 규칙이 발동한다. 뷰가 아닌 탭의 거부는 지킬 뷰 없이 오류만 보인다(R1). 이름 붙은 함수 하나는 릴리스된 규칙을 보이게 하고 나머지 코드는 폴백 없이 둔다.

### 결정

1. `origin`은 항상 정확히 `directory`라는 한 멤버를 가진 객체 `{directory}`이다.
2. `directory`는 절대 경로 또는 null이다. null은 탭이 디렉터리를 기록하지 않았음을 뜻한다.
3. 절대 경로는 첫 글자가 `/`인 경로다. `//`(UNC 형식)와 `/<문자>:`(드라이브 형식) 접두도 거부한다. `/` 검사만으로는 이를 통과시키므로, 하나의 문자열 규칙이 모든 플랫폼에서 로컬이 아닌 형식을 거부하게 한다. 워크벤치는 `reportDirectory`(`tab-reports.js:125`, 지금은 `/` 접두만 검사한다)에서 같은 술어를 적용한다. 술어는 하나의 내보내기 함수가 되고 `reportDirectory`가 부르므로, 로컬이 아닌 디렉터리는 보고되는 시점에 거부된다(`/`가 아닌 경로에 지금 던지는 것과 같은 `TypeError`). 뷰 시작에서 처음 거부되지 않는다. 각 호스트와 페이지는 같은 문자열 검사를 쓴다: TypeScript `path.startsWith("/") && !path.startsWith("//") && !/^\/[A-Za-z]:/.test(path) && !path.includes("\u0000")`, Go와 Rust도 같은 네 검사를 `strings.HasPrefix`와 `strings.Contains`, `starts_with`와 `contains`로 쓴다. 플랫폼 경로 API는 쓰지 않는다. 드라이브 규칙은 합법적인 POSIX 이름 `/a:b`도 거부한다. 이 규칙은 이식성을 위한 선택이며 그렇게 적는다. `//` 형식도 같은 이식성 이유로 거부한다. Windows에서는 UNC 공유 접두이고, POSIX에서는 구현 정의다. 범위의 비로컬 형식은 `//`와 `/<문자>:` 접두뿐이다. `/\`는 합법적인 POSIX 이름이므로 거부하지 않는다. NUL 바이트는 항목 4의 절대 경로 아님 트리거에 속한다. 술어는 NUL을 담은 모든 문자열을 거부하므로 그런 경로는 네이티브 호출에 닿지 않는다.
4. 부재한 origin, null origin, 다른 형식의 객체, 문자열이 아닌 null이 아닌 `directory`, 빈 경로, `/`로 시작하지 않는 경로는 명시적 오류로 거부한다. 네 문구와 그 트리거는 다음과 같다.
   - `surface "<id>": view start origin is missing`: origin 필드가 없다.
   - `surface "<id>": view start origin is not {directory} with a path or null`: origin이 null이거나 객체가 아니거나(JSON 배열은 객체가 아니다), `directory` 외의 멤버를 가졌거나, `directory`가 문자열도 null도 아니다.
   - `surface "<id>": view start origin directory is empty`: `directory` 문자열이 비어 있다.
   - `surface "<id>": view start origin directory is not an absolute path`: `directory` 문자열이 항목 3의 절대 경로가 아니다(`/`로 시작하지 않거나, `//` 또는 `/<문자>:`로 시작하거나, NUL 바이트를 담는다).
5. 페이지는 강제 변환하지 않는다. `packages/plugin-api/surface.js:12`(기본값 `origin = { directory: null }`)과 `:72`(`origin.directory ?? null`)를 제거한다. `createSurfaceContext`는 origin이 정확히 `{directory}`이고 값이 null 또는 `/`로 시작하는 문자열이 아니면 `TypeError`를 던진다. `TypeError`의 메시지는 같은 결함에 대한 항목 4의 문구이므로, 페이지와 호스트가 한 결함을 한 가지로 부른다.
6. 모든 탭 생성은 origin을 명시적으로 넘긴다. `newTab(kind, params)`(`packages/workbench/plane.js:142`)는 필수 인자 `fromTabId`(원천 탭이 없으면 null)를 받고 스스로 `recordOrigin(tab.id, fromTabId)`를 호출한다. 호출자는 원천을 명시한다: 카드 생성 경로 `plane.js:779`, `:797`(이미 `recordOrigin` 호출), 마지막 탭 닫힘 경로 `plane.js:518`(`newTab(..., null)`, `{directory: null}` 기록; 닫힌 탭이 원천 탭을 남기지 않으므로 새 탭은 지금처럼 null로 시작한다. 새 탭은 닫힌 탭에서 파생되지 않으며, 닫힌 디렉터리를 이어 받는 것은 이 결정이 하지 않는 제품 변경이다), 새 공간 경로 `initial()`(`plane.js:163`, `tab(t.plugin, t.title)`로 탭을 만들고 `recordOrigin(id, null)`을 호출한다).
7. origin은 탭 세션이 아니라 탭 레이아웃과 함께 저장된다. 저장된 레이아웃의 카드 `tabs` 안에서 각 탭 항목은 `{id, plugin, origin: {directory}}` 형태이며, `projects.json`에 있다. 저장 경로는 origin을 기록한다: `capture()`(`packages/workbench/plane.js:1554`)가 `grid.toJSON()` 전에 `state`의 각 콘텐츠 카드 탭에 `originOf(tab.id)`로 기록된 origin을 넣는다. 이 접근자는 기록도 적재된 값도 없는 탭에 대해 던진다(폴백 없음). 기록된 origin이 없이 적재된 탭은 적재된 것으로 보며, `capture()`는 그 적재된 값을 그대로 이어 쓰고, 적재된 값이 부재하면 origin 멤버를 쓰지 않는다. `capture()`는 강제 변환하지 않고, 기록되지 않은 탭에 `{directory: null}`을 저장하지 않으며, 열린 레이아웃에 대해서는 던지지 않으므로 열린 레이아웃의 모든 저장이 성공한다. `tab()`(`plane.js:129`)은 origin을 담지 않는다. 필드는 선택 필드이고 `projects.json`은 형식 1을 유지한다(`docs/spec/projects.md:60`). 그러므로 origin은 그 탭을 만드는 같은 확인된 원자적 레이아웃 쓰기로 기록된다. 두 번째 저장소, 쓰기 순서, 대조가 필요 없고 `tab-state.json`은 쓰지 않는다. 그 계약은 잦은 상태를 위한 탭별 합쳐진 쓰기이며, origin은 탭당 한 번 쓰인다. origin이 없거나 항목 4의 형식과 경로 검사를 통과하지 못하는 탭은 항목 2에 따라 항목 4의 문구를 가진 거부 상태로 복원된다. 그 탭은 로그에 기록되고 탭에 표시되며 뷰를 시작하지 않는다. 탭은 레이아웃에 남고, 레이아웃은 여전히 열리고 저장도 된다. 거부는 탭별이며 공간 열기의 실패가 아니다(`docs/spec/projects.md:66`을 그렇게 바꾼다). 업그레이드: 이동은 없다(16라운드 결정 1). 이 변경 전에 저장된 레이아웃의 콘텐츠 카드 탭에는 `origin`이 없다. 그런 탭은 origin 부재에 대한 항목 4의 문구를 가진 거부 상태로 복원되며, 레이아웃은 여전히 열리고 저장된다. 사용자는 탭을 다시 연다. 다운그레이드: 이 변경 후에 저장된 레이아웃은 이전 빌드에서 지원되지 않는다. 그 빌드는 멤버를 무시하고 다음 저장에서 버리므로, 거기서 복원된 탭은 origin이 없다. 형식 번호는 1로 남는다(16라운드 결정 1). 형식 1 파일을 거부하면 레이아웃 전체가 거부되는데 8라운드가 이를 거부했다. 탭 세션 파일 `tab-sessions/<tab>.json`은 저장소가 아니다. `packages/workbench/tab-session.js`가 문서 영역이 없는 탭의 파일을 지우기 때문이다(`put(tab, null)`, `:55`, `:65`). 복원 시 `build(kept)`(`plane.js:1414`)와 `adopt(kept)`(`plane.js:1564`)는 내보낸 헬퍼 `recordStoredOrigins(kept)` 하나를 부른다. 이 헬퍼는 `restoreWindowState(kept)` 뒤, 탭을 만들기 전에 실행되며 레이아웃의 저장된 각 탭에 대해 `restoreOrigin(tab.id, tab.origin)`을 호출한다. `restoreOrigin`은 `tab-reports.js`의 새 내보내기다. 적재된 값을 그대로 저장하고, 하나의 검사기 `checkViewOrigin`(항목 4의 규칙)을 한 번 실행하며, 결과를 탭의 데이터로 싣는다. 거부면 항목 4의 문구를, 아니면 없음을 싣는다. 던지지 않는다. 레이아웃 항목에 `origin` 멤버가 없는 탭은 부재한 값으로 적재되며, `checkViewOrigin`은 이를 부재로 거부한다. 따라서 멤버가 없는 저장 탭은 origin 부재 거부로 읽히며, 판독기는 값을 채우지 않는다(저장 읽기 규칙 하나). 뷰 시작은 이 데이터를 먼저 읽는다. 거부된 탭은 문구를 로그에 기록하고 표시하며 뷰를 시작하지 않고, 거부되지 않은 탭만 origin을 읽는다. `recordOrigin(tabId, fromTabId)`(`tab-reports.js:135`)는 원천 탭 id를 받으므로 origin 객체를 복원할 수 없어 헬퍼를 쓴다. 테스트는 플레인을 마운트하지 않고 헬퍼를 직접 부른다.
8. 워크벤치 폴백은 항목 7의 엄격한 뷰 시작 거부와 같은 변경에서 제거한다. `tabOrigin`(`packages/workbench/tab-reports.js:141`, `?? Object.freeze({ directory: null })`)은 그 변경에서 폴백을 잃으므로, 어떤 중간 상태도 기록되지 않은 탭에 `{directory: null}`을 내지 않는다. 그 뒤 `tabOrigin`은 기록도 적재된 값도 없는 탭에 대해 던지며, 뷰 시작 경로는 origin을 읽기 전에 항목 2의 거부를 먼저 확인한다.

### 16라운드 반론에 대한 판정(구속력 있음)

16라운드에 새 감사자 두 명이 반론했다(실행 c971e2d1, f6f5cd04). 아래 각 판정은 반론 하나에 답하며, 결정과 이유를 적는다. 항목 4, 5, 7은 이 판정을 따라 읽는다.

- R1, 범위(감사자 B, 반론 1). 뷰 탭은 surface가 뷰인 탭이다. 항목 4, 7, 8의 origin 규칙(레이아웃 읽기의 거부, `capture()`의 이어 쓰기, `originOf`의 던짐)은 뷰 탭에만 적용한다. 뷰 탭이 아닌 콘텐츠 카드 탭은 origin 멤버와 거부가 없으며, 저장할 때 origin 멤버를 쓰지 않는다. 뷰 탭 여부는 레이아웃 읽기가 플러그인의 선언된 뷰 surface로 정한다. 이유: 감독자 결정 1은 필요한 origin이 뷰 탭에만 적용된다고 적고, 공개된 core에는 뷰 탭이 없으므로 다른 탭의 거부는 지킬 뷰 없이 오류만 보인다. 복구: 거부된 뷰 탭은 사용자가 닫을 때까지 거부 상태로 남으며, 다시 열면 `newTab`과 `recordOrigin`으로 새 탭 id를 가진 탭이 만들어진다.
- R2, 우선순위(감사자 B, 반론 2). `recordStoredOrigins`는 레이아웃의 어떤 탭도 만들기 전에 실행된다. 복원된 탭 id는 새 것이므로 기록이 없고, `originOf`는 기록이 없을 때만 적재된 값을 준다. 복원된 탭에 `recordOrigin`을 부르는 경로는 없다.
- R3, 존재(감사자 B, 반론 3). `restoreOrigin`은 origin을 존재 여부로 받는다. 부재한 멤버는 TypeScript에서 `"origin" in tab`, Rust에서 `present_value`(`Option`), Go에서 키 검사로 본다. `null` 멤버는 있는 값이다. `??`로 부재와 null을 합치는 판독기는 없다.
- R4, 페이지 술어(감사자 A, 반론 1). 항목 5를 바꾼다. `createSurfaceContext`는 항목 3의 문자열 검사 전체를 적용하고, 처음 실패하는 검사의 항목 4 문구로 `TypeError`를 던진다. 술어는 `packages/plugin-api`에서 한 번 내보내며, 워크벤치가 이미 plugin-api를 가져오므로 `reportDirectory`도 그것을 가져온다. 각 호스트는 같은 형식의 사본을 유지한다. 적합성은 이 결정의 벡터로 정하며, 각 구현의 테스트가 이를 단언한다: `/a`는 받고, `//server/share`, `/C:/x`, `C:\x`, `relative`, NUL 바이트를 담은 경로는 거부한다. 이유: `/`만 보는 페이지 검사는 항목 3이 거부하는 형식을 받아, 페이지와 호스트가 같은 origin을 다르게 판정하게 된다.
- R5, 문구 순서(감사자 A, 반론 2). 항목 4의 네 검사는 적힌 순서대로 실행하고 처음 맞는 검사의 문구를 쓴다. 빈 문자열은 빈 문구(검사 3)를 받고, 절대 경로 아님 문구를 받지 않는다.
- R6, 검사기 하나(감사자 A, 반론 3). 거부를 정하는 곳은 레이아웃 읽기뿐이다. 뷰 시작의 호스트와 페이지 검사는 심층 방어이며, 같은 술어를 쓰고, 레이아웃 읽기가 거부한 탭에는 실행하지 않으며, 레이아웃 읽기가 받은 탭을 호스트가 거부하면 보고할 결함이다.
- R7, 다운그레이드. v0.0.9 명세는 저장된 레이아웃을 현재 형식으로만 읽고 실패하는 필드를 이름으로 적는다(`projects.md:62`). 알 수 없는 탭 멤버에 대한 결과는 적지 않는다. 따라서 다운그레이드 결과는 정해지지 않았고, 결정은 그것에 기대지 않는다. 변경 뒤 저장된 레이아웃은 이전 빌드에서 지원되지 않는다. 이것이 항목 7의 다운그레이드 문장을 대체한다.
- 형식(항목 1). 두 감사자 모두 근거가 지지한다고 했다(공개된 뷰 surface 없음). 그대로 둔다.
- 종결. 이 판정으로 D7은 닫힌다. 감독자 지시에 따라 17라운드는 돌리지 않는다. 하위 항목은 소유자 아래에서 열린 채로 둔다.

### 이유

워크벤치는 항상 객체를 보내므로(`tab-reports.js:137`), 호스트와 페이지에서 부재하거나 null인 origin을 거부해도 origin을 기록하는 코드 경로는 깨지지 않는다. 기록이 없을 때 `{directory: null}`을 강제로 채우면 결함이 숨겨지며, `AGENTS.md`가 금지하는 일("경계에서 잘못된 값을 거부한다")이다. `/` 규칙은 워크벤치가 이미 디렉터리에 적용하는 규칙이므로(`reportDirectory`, `tab-reports.js:125`), 항목 3이 그 규칙을 `//`와 `/<문자>:` 거부로 강화한다. 워크벤치도 같은 강화를 받으므로 뷰의 origin과 탭의 디렉터리가 어긋나지 않는다. Windows 지원은 그 규칙을 바꾸는 별도 변경이다. 객체 형식은 기존 계약이다. 워크벤치가 보내고(`tab-reports.js:137`), 페이지 기본값도 객체이며(`surface.js:12`), 두 호스트가 객체로 읽는다(`surfaces.rs:82-86`). 한 멤버 규칙은 미래의 멤버를 조용한 값이 아니라 거부로 만들므로, 형식을 문자열로 바꾸면 안전성 이득 없이 계약만 흔든다.

origin을 탭 세션이 아니라 레이아웃에 저장하는 이유는 E4에 있다. 탭 세션 파일은 평범한 surface에서 지워지므로 거기 저장된 origin은 사라진다.  origin은 탭당 한 번 그 탭과 함께 쓰이고, 복원은 탭이 온 레이아웃에서 읽으므로 `tab-state.json`이 아니라 레이아웃 항목에 둔다. 판독기는 없는 origin을 채우지 않으므로, origin이 없으면 항목 4의 거부로 드러난다. 형식 번호는 1로 남는다. 바뀌는 저장 형식은 선택 멤버뿐이며, 형식을 올리면 이동이 필요하거나 모든 형식 1 레이아웃을 거부하게 되기 때문이다. 두 단순한 대안은 기각했다. 복원 시 origin을 다시 유도하는 것은 origin이 메모리에만 있었으므로(E6) 데이터가 뒷받침하지 못한다. `plugins.md:223`을 세션 한정 origin으로 제한하면 복원된 탭이 뷰에 필요한 origin을 잃는다.

### 근거

- E1(호스트, fix). `fix/view-origin-F237:packages/host/tauriv2/src/surfaces.rs:58-61`은 `origin`을 원시 값(`Option<Value>`, `present_value`)으로 보관한다. `view_origin_directory`(`:76-94`)는 부재(`:78`), 객체가 아니거나 멤버가 둘 이상인 값(`:82-86`), `directory`의 누락이나 잘못된 타입, 빈 경로를 거부한다. 절대 경로 검사는 없다.
- E2(호스트, fix). `fix/view-origin-F237:packages/host/wailsv3/src/surfaces.go:62-112`: `viewOriginDirectory`는 nil origin(`:70`), 맵이 아닌 값(`:76`), `directory` 누락(`:81`), 빈 경로(`:91`)를 거부한다. 절대 경로 검사는 없다.
- E3(페이지, main). `packages/plugin-api/surface.js:12`는 origin 기본값을 `{directory: null}`로 둔다. `:72`는 `origin.directory ?? null`로 강제 변환한다.
- E4(저장, main). `packages/workbench/tab-session.js`의 `put(tab, regions)`(`:33`)과 `:55`, `:65`의 호출(`put(tab, null)`)은 문서 영역이 없는 탭의 세션 파일을 지운다. `capture`는 상호작용 상태가 없으면 일찍 반환한다. 저장 형식(`docs/spec/plugins.md:142`)과 `host-store.js:16`(`tabSessionPut(tab, regions)`)에는 origin 필드가 없다.
- E5(워크벤치 규칙, main). `packages/workbench/tab-reports.js:125`는 `startsWith("/")`가 아닌 모든 디렉터리를 거부한다. origin은 같은 맵에서 복사된다(`:137`).
- E6(origin 원천, main). `recordOrigin`은 `plane.js:779`와 `:797`에서만 호출된다. `newTab`은 `plane.js:518`(마지막 탭이 닫히고 카드가 남음)에서도 호출되지만 `recordOrigin`은 없다. 따라서 그 탭은 `origins`에 항목이 없다. `origins`는 메모리에만 있으므로(`tab-reports.js:5`) 앱 재시작 후에는 모든 탭에 대해 비어 있다.
- E7(뷰 시작, main). `surface-modules.js:193`과 `:448`은 `tabOrigin(surface.surfaceId)`을 읽는다. 폴백을 E6보다 먼저 제거하면 E6의 탭에서 이 호출이 던진다.
- E8(복원 명세, main). `docs/spec/plugins.md:223`은 "언로드된 탭을 보이게 하면 같은 `origin`으로 surface를 마운트한다"라고 쓰며 세션 한정 표현이 없다. 결정 항목 7이 들어가기 전까지 재시작 뒤의 문장은 거짓이다. 그 전까지 명세는 복원된 탭의 origin이 `{directory: null}`이라고 적는다.

### 필요한 변경

- 소유 `fix/view-origin-F237`: 결정 항목 3의 `/` 접두 검사를 `view_origin_directory`(`surfaces.rs`)와 `viewOriginDirectory`(`surfaces.go`)에서 빈 경로 검사 뒤에 추가한다. 각 호스트 테스트에 `/` 경우와 `C:\` 경우를 둔다(Red 먼저).
- 소유 main, `packages/plugin-api/surface.js`: `:12`의 기본값과 `:72`의 강제 변환을 제거한다(결정 항목 5). 단위 테스트(Red 먼저). 페이지의 `TypeError` 메시지는 같은 결함에 대한 항목 4의 문구다.
- 소유 main, `packages/workbench/tab-reports.js`: 항목 3의 술어를 하나의 내보내기 함수로 만들고 `reportDirectory`(`:125`)가 부른다. 로컬이 아닌 디렉터리는 보고 시점에 `TypeError`로 거부된다. 테스트, Red 먼저: `//server/share`, `/C:/x`, `C:\x`와 NUL 바이트를 담은 경로는 보고 시점에 거부되고 `/a`는 받는다.
- 소유 main, `packages/workbench/plane.js`와 `tab-reports.js`: 결정 항목 6. 테스트: 마지막 탭 닫힘(`plane.js:518`)은 `{directory: null}`로 뷰를 시작하고 던지지 않는다. 새 탭은 원천 origin을 기록한다.
- 소유 main, 워크벤치 레이아웃과 복원: 결정 항목 7. 복원 함수는 `build(kept)`(`plane.js:1414`)와 `adopt(kept)`(`plane.js:1564`)다. 둘 다 내보낸 헬퍼 `recordStoredOrigins(kept)` 하나를 부르며, 이 헬퍼는 저장된 각 탭에 `restoreOrigin(tab.id, tab.origin)`을 호출한다. `restoreOrigin`은 `tab-reports.js`의 새 내보내기로, 검사기 `checkViewOrigin`(항목 4의 규칙)을 레이아웃을 읽을 때 한 번 실행하고 결과를 탭의 데이터로 싣는다(결정 항목 2). `recordOrigin(tabId, fromTabId)`(`tab-reports.js:135`)는 원천 탭 id를 받으므로 origin 객체를 복원할 수 없다. 테스트는 플레인을 마운트하지 않고 헬퍼를 부른다. origin의 `capture()` 기록은 탭을 만드는 같은 확인된 레이아웃 쓰기의 일부다. 테스트: 문서 영역이 없는 복원 탭은 재시작 뒤 저장된 origin으로 뷰를 시작한다(Red 먼저). origin이 없거나 항목 4의 검사를 통과하지 못하는 저장 탭은 거부 상태로 복원되어 항목 4의 문구를 로그에 적고 탭에 표시하며 뷰를 시작하지 않고, 레이아웃은 열린다.  변경 전 레이아웃을 연 뒤 저장하는 테스트(origin이 없는 탭이 적재된 값을 그대로 쓰고 던지지 않는다, Red 먼저)를 둔다. `restoreOrigin`은 적재된 값을 그대로 저장하고, 거부를 데이터로 싣고, 던지지 않는다. 잘못된 저장 origin을 가진 레이아웃을 열어, 그 탭이 거부 상태로 복원되고 항목 4의 문구로 로그에 기록되고 표시되며, 뷰를 시작하지 않고, 레이아웃에 목록으로 남는지 확인하는 테스트를 둔다.
- 소유 main, `tab-reports.js`: 결정 항목 7의 엄격한 뷰 시작 거부와 같은 변경에서 `tabOrigin` 폴백을 제거한다(결정 항목 8). 그 전에 제거하면 중간 상태가 null을 낸다. 그 변경에는 `packages/workbench/test/tab-reports.test.mjs:37-40`(기록되지 않은 `tab-f`와 `tab-unknown`에 `{directory: null}`을 기대)과 `packages/workbench/test/surface-tab-state.test.mjs:98`을 던짐을 기대하도록 바꾸는 일이 포함된다.
- 소유 shell 저장소(F238-a-17): `plugins/shell/ui/view.js:22`와 `plugins/shell/test/view.test.mjs:47-53`이 null을 기본 origin으로 취급하지 않게 한다. 뷰 시작은 origin 부재를 부재 문구로, null origin을 형식 문구로 거부한다. Red 먼저 테스트.
- 소유 main, `docs/spec/projects.md`: `projects.json`의 각 레이아웃 탭 항목에 있는 선택 필드 `origin`을 적는다(형식 1 유지, EN과 KO). 테스트: origin이 있는 형식 1 `projects.json` 고정본은 그것을 복원하고, origin이 없는 것은 열리되 그 탭이 항목 4의 문구를 가진 거부 상태로 복원된다.  `docs/spec/projects.md:66`은 탭별 origin 거부가 공간 열기를 실패시키지 않는다고 바꾼다.
- 소유 main(명세, EN과 KO): `native-surfaces.md:136`, `host-contract.md:196`, `plugins.md:142`, `:223`, `:225`에 네 문구와 트리거, `/` 규칙(`//`와 `/<문자>:` 거부), 레이아웃 탭 항목의 선택 origin 필드, 복원 문장은 복원 변경이 들어간 뒤에만 참이라고 적는다.

### 반론과 답변

- 1라운드, 감사자 A, 반론 2: 단일 규칙은 플랫폼 API로 만족될 수 없고 워크벤치는 `/`가 아닌 경로를 거부한다. 수용. 규칙은 `/` 접두 검사다.
- 1라운드, 감사자 A, 반론 3: 복원이 소유자 없이 남아 있고 `plugins.md:223`은 재시작 후 거짓이다. 수용. 결정 항목 7과 E8.
- 1라운드, 감사자 B, 반론 3: `tabOrigin` 폴백은 같은 강제 변환이다. 수용. 다만 먼저 제거하면 회귀한다(2라운드). 결정 항목 8이 마지막 단계로 둔다.
- 1라운드, 감사자 B, 반론 4: 순수 문자열 술어가 필요하다. 수용(결정 항목 3).
- 2라운드, 감사자 D, 반론 4(a): `tab-sessions`의 origin은 평범한 surface에서 지워지고 `capture`는 일찍 반환한다. 수용. origin은 레이아웃으로 옮긴다(결정 항목 7, E4).
- 2라운드, 감사자 D, 반론 4(b): 복원 경로는 `recordOrigin`을 호출하지 않는다. 수용(결정 항목 7).
- 2라운드, 감사자 C, 반론 1: `plane.js:518`과 복원된 탭은 `recordOrigin`을 우회하고, 폴백을 먼저 제거하면 회귀한다. 수용(결정 항목 6, 7, 8, E6, E7).
- 3라운드 답변(감사자 E와 F). 수용: 거부는 `surface-modules.js:462`에서 원시 `scoped.native`를 바꾸는 게이트 래퍼에 있으므로 `native.call`, `call`, `native.on`이 모두 통과한다(항목 3). `REGION_HOST_CALLS`는 호스트 명령 표와 대조하는 명시적 허용 목록이다(항목 2). `mainWebview`는 `webview`와 같이 히트 검사한다(항목 5, 테스트 d). D7은 다섯이 아니라 트리거가 있는 네 문구를 나열한다(항목 4). 복원 함수와 항목 형태가 이름으로 적혔다(항목 7). 이 변경 전에 저장된 레이아웃은 origin이 없으므로 변환하지 않고 열 때 거부한다(항목 7). 미수용: 없음. 감사자 E는 호스트 명령 표와 재적용 주장을 확인했고, 감사자 F는 D7 순서를 확인했다. 레거시 레이아웃 항목은 12라운드와 14라운드로 대체되었다. 항목 7을 보라(이동은 영속 탭이 이미 쓰던 값을 쓰며, origin이 없는 데이터에 대해서만 탭별로 거부한다).

## 라운드 기록

- 1라운드: 감사자 A와 B가 반론했다(각 3건과 4건). 모두 수용해 본문을 고쳤다.
- 2라운드: 감사자 C와 D가 반론했다(D4에서 각 3건과 3건, D7에서 각 1건과 2건). 모두 수용해 본문을 고쳤다.
- 3라운드: 감사자 E와 F가 반론했다(D4: 각 3건과 3건; D7: 각 3건과 3건). 모두 수용해 위 본문에 반영했다. 4라운드 답변(감사자 G와 H, 코드로 확인): 수용. `imagePlace`는 두 명령 표에 없어 허용 목록에서 빠지고 열린 결함이 된다. 이름은 snake_case와 PascalCase에서 camelCase로 바꾼다. 뷰 런타임의 `native.call`(`surface-modules.js:280`)과 뷰 브리지 명령(`bindings.rs:494-510`)은 게이트 래퍼를 거친다. 반영 시점의 문서 쌍은 `native-surfaces.md:178`이다. 새 공간 `initial()`(`plane.js:163`)과 `adopt`(`plane.js:1564`) 경로는 한 헬퍼로 origin을 기록한다. 확인하고 반론이 없는 항목: `runCore`와 `runtime.command`는 `core.` 접두 이름만 전달한다. 5라운드 답변(감사자 I와 J, 코드로 확인): 수용. `imagePlace`는 워크벤치 호출만 있고 호스트 명령과 플러그인 호출자가 없어 제거한다. 뷰 구독(`surface-modules.js:249`)은 게이트를 우회하므로 같은 래퍼를 쓴다. `mainWebview`는 `:295`에서 nil 전에 DOM 히트를 반환한다. `recordOrigin`은 원천 탭 id를 받으므로 복원 헬퍼는 새 `restoreOrigin`을 부른다. 저장 경로는 origin을 쓰지 않았으므로 `capture()`가 쓴다. `checkStoredLayout`은 저장된 origin에 형식과 절대 경로 검사를 적용한다. 6라운드 답변(감사자 K와 L, 코드로 확인): 수용. `SPWindowComposition.hitTest`(`:183-194`)는 둘째 하이브리드 hit 경로이므로 같은 규칙을 받는다. `image-region.js`는 `port.place`를 부르므로 place 경로를 테스트와 함께 제거한다. 저장 경로는 폴백을 저장하면 안 되므로 엄격한 접근자를 쓴다. `restoreOrigin`과 `checkStoredLayout`은 검사기를 공유한다. 저장 레이아웃은 항목 4의 문구를 쓴다(두 번째 문구 집합 없음). 레이아웃 변경은 형식 2 상향과 데이터 이동이다. AGENTS.md는 저장 형식 변경에 형식 번호와 이동 정의를 요구하며, 형식 1 데이터의 거부는 이동이 아니다. 7라운드 답변(감사자 M과 N, 코드로 확인): 수용. `SPSurfaceHost.hitTest`는 점을 상위 뷰에서 변환하지 않으므로(`:283-286`) 두 메서드 모두 먼저 변환하고, 0이 아닌 원점 Red 테스트를 둔다. `attachImage`에는 살아 있는 호출자가 있으므로(`surface-composition.js:239`) place 경로만 제거한다. Windows 근거는 틀렸으므로 술어는 워크벤치와 세 검증기에서 `//`와 `/<문자>:`도 거부한다. 이동은 버리고, 형식 1은 AGENTS.md의 교체 저장 형식 규칙에 따라 거부한다. 저장 인용은 `plane.js:1554`(`const`이며, 감사자의 `function capture` 검색에는 잡히지 않았다). 폴백을 확인하는 두 테스트는 Green 조건에 든다. 미수용: `NSView -hitTest:`가 자식 고유 좌표를 받는다는 M의 주장은 적용하지 않는다. 명시된 규칙은 상위 뷰 좌표다. 판정은 8라운드 대기 중이다.


- 8라운드 답변(감사자 두 명, 자식 실행 554afe9d와 425e481c, 결정 수준 질문만). D4: 두 감사자 모두 실질적 반론이 없었다. D4는 닫는다. D7: 두 감사자 모두 반론했다. 수용: 형식 1 `projects.json` 레이아웃의 전면 거부는 저장된 등록부와 plugin 데이터를 버리며, 명세의 tab-state 문단(`projects.md:62`)이 이미 탭별 추가 저장소를 보여 준다. 항목 7은 origin을 그곳에 선택 필드로 저장하고 레이아웃 전체는 거부하지 않으며, F238-a-10, -11, -13이 따른다. 미수용: 객체 형식 `{directory}` 대신 문자열. 근거는 기존 계약이다. 워크벤치가 객체를 보내고(`tab-reports.js:137`), 페이지 기본값도 객체이며(`surface.js:12`), 두 호스트가 객체로 읽는다(`surfaces.rs:82-86`). 한 멤버 규칙은 미래의 멤버를 조용한 값이 아니라 거부로 만들므로, 형식을 바꾸면 안전성 이득 없이 계약만 흔든다. 구현 메모: 플러그인 쪽 게이트는 거부 목록이므로 F238-a-14로 등록했다. 항목 3의 `//` 근거 문장은 wording을 바로잡았다. 9라운드 판정 대기(D7만).

- 9라운드 답변(감사자 두 명, 자식 실행 8dfca4e1과 fb4d8707, 결정 수준). D7: 두 감사자 모두 origin을 `tab-state.json`에 두는 것에 반론했다. 항목 7은 소유자를 둘로 적었고, 그 저장소 계약(탭별 합쳐진 쓰기, `projects.md:62`)은 탭당 한 번 쓰이는 값에 맞지 않으며, 파일 사이 쓰기 순서 규칙이 필요했다. 수용: origin은 `projects.json`의 레이아웃 탭 항목에 추가 선택 필드로 옮기며, 탭을 만드는 확인된 원자적 레이아웃 쓰기와 함께 기록한다. 두 번째 저장소, 순서, 대조가 필요 없다. 업그레이드 결과는 항목 7에 적었다. 변경 전에 저장된 레이아웃의 탭은 다시 만들 때까지 탭별로 뷰 시작에서 실패한다. 구현 메모는 설명으로 수용했다. 마지막 탭 닫힘이 null을 기록하는 것은 닫힌 탭이 원천 탭을 남기지 않기 때문이다(항목 6). 10라운드 판정 대기(D7만).

- 10라운드 답변(감사자 두 명, 자식 실행 ac96d66e와 348885a2, 결정 수준). D7: 두 감사자 모두 같은 반론을 했다. 항목 7은 origin이 없는 탭이 뷰 시작에서 실패하고 레이아웃은 여전히 열린다고 했으나, `capture()`는 기록되지 않은 탭에 던지는 엄격한 접근자를 읽으므로 변경 전 레이아웃을 연 뒤 첫 저장이 레이아웃 전체에 대해 실패한다. 수용: 기록이 없는 탭에 대해 `capture()`는 적재된 값을 멤버 부재를 포함해 그대로 이어 쓴다. 강제 변환하지 않으며, 열린 레이아웃에 대해서는 던지지 않고, 기록도 적재된 값도 없는 탭에 대해서만 던진다. 거부는 탭별로 뷰 시작에서 유지하며, `projects.md:66`을 그에 맞춘다. 멤버를 생략하는 대안은 저장 때 잘못된 저장 값을 버리게 되므로 택하지 않았다. 이어 쓰기가 데이터를 지킨다. 11라운드 판정 대기(D7만).

- 11라운드 답변(감사자 두 명, 자식 실행 0765560f와 93052fed, 결정 수준). D7: 두 감사자 모두 반론했다. 수용: (1) 항목 3은 `reportDirectory`가 술어를 적용한다고 했으나 `tab-reports.js:125`는 `/` 접두만 검사한다. 술어를 하나의 내보내기 함수로 만들어 `reportDirectory`가 부르게 하므로, 로컬이 아닌 디렉터리는 보고 시점에 거부된다. (2) 업그레이드: 설치 시 한 번의 저장 데이터 이동(`docs/spec/installation.md#stored-data-migration`)이 형식 1 레이아웃의 각 콘텐츠 카드 탭에 `origin: {directory: null}`을 쓴다. 7라운드에서는 데이터에 없는 값을 쓸 것이라 보고 이동을 버렸으나, 그 레거시 탭들이 이미 가졌던 값은 `{directory: null}`이다(`tabOrigin` 폴백, `tab-reports.js:141`, 재시작 뒤 origin은 비어 있다). 그러므로 이동은 탭들이 쓰던 값을 쓰고 디렉터리를 추론하지 않는다. 업그레이드 시 탭별 파손은 수용하지 않는다. 이 변경 뒤에 저장된 레이아웃은 이전 빌드에서 지원되지 않는다. 항목 6은 null을 유지하고 이유를 적었다. 새 탭은 닫힌 탭에서 파생되지 않는다. 페이지의 `TypeError` 메시지는 항목 4의 문구다. 12라운드 판정 대기(D7만).

- 12라운드 답변(감사자 두 명, 자식 실행 76e64824와 f4b2a394, 결정 수준). D7: 두 감사자 모두 이동에 반론했다. 수용: AGENTS.md는 저장 형식 변경에 형식 번호를 올리고 이동 정의를 싣도록 요구하며, 엔진(`installation.md:97`)에는 값을 쓰는 연산이 없다. 그러므로 `projects.json`은 형식 2로 올라가고, 이동 `from 1 to 2`는 이름 붙은 `setField` 연산을 쓰며 설치 시 한 번 실행된다. 판독기는 형식 2만 받고, 이동되지 않은 형식 1 파일은 파일명과 형식을 적은 오류로 거부한다. 미수용: 탭별 파손(11라운드에서 거부), 읽을 때 없는 origin을 채우는 판독기(항목 7이 드러내려는 결함을 숨긴다). 3라운드의 '열 때 거부하고 변환하지 않는다' 답변은 이 라운드로 대체된다. 명확화로 수용: 드라이브 규칙은 합법적인 POSIX 이름 `/a:b`를 이식성 선택으로 거부하며 그렇게 적는다. 마지막 탭 닫힘의 null은 제품 선택이다(항목 6). 13라운드 판정 대기(D7만).

- 13라운드 답변(감사자 두 명, 자식 실행 319f13d0과 1927f2fa, 결정 수준). D7: 두 감사자 모두 반론했다. 수용: (1) 복원은 던지면 안 된다. `restoreOrigin`은 적재된 값을 그대로 저장하며, 하나의 검사기 `checkViewOrigin`은 뷰 시작 경로에서 한 번만 실행된다. 거부는 한 점에서 한 번의 검사다. (2) 이동의 계약은 한 번 적는다. 12라운드에 따라 유지하며, 폴백 제거는 그 테스트를 기다린다. 추론하지 않는다: 이동은 영속 탭이 이미 시작하던 값을 쓴다. origin은 메모리에만 있었다(E6). 3라운드의 '열 때 거부하고 변환하지 않는다' 답변과 '다시 만들 때까지 탭별로 뷰 시작에서 실패' 문구는 역사 기록이며 12라운드로 대체되었다. (3) `//` 거부에도 드라이브 규칙과 같은 이식성 이유를 적는다. (4) `setField` 연산은 기존 명세를 가리키지 않고 명세에 추가한다. 14라운드 판정 대기(D7만).

- 14라운드 답변(감사자 두 명, 자식 실행 c5010478과 38d68626, 결정 수준). D7: 감사자 1은 실질적 반론이 없었다. 감사자 2는 null 이동에 반론하고 레거시 탭을 탭별로 거부하자고 제안했다. 변경으로는 수용하지 않았다. 탭별 거부는 11라운드에서 거부되었다. 그 탭들이 이미 쓰던 값에 대해 업그레이드 시 모든 기존 탭의 뷰를 깨기 때문이다. 변경으로는 14라운드에서 수용하지 않았다. 15라운드 감독자 결정이 이 라운드가 논의한 null 이동을 제거한다. 3라운드의 레거시 레이아웃 답변은 대체되었다고 표시했다. 문구로 수용: 항목 4의 네 번째 문구가 `//`와 `/<문자>:` 형식을 덮는다. 워크벤치 술어는 `reportDirectory`의 강화이며 그렇게 적는다. 두 단순한 대안은 이유와 함께 Why에 적었다. 비로컬 형식과 NUL의 범위를 적었다. D7은 열린 채 둔다. 15라운드 판정 대기(D7만).

- 15라운드 답변(감사자 A와 B, 자식 실행 60bae32e와 07c07e50, 결정 수준, 새 감사자). D7: 두 감사자 모두 반론했으므로 D7은 열린 채 둔다. 15라운드 감독자 결정(이동 없음, 탭별 거부, 형식 1 유지)을 적용했고 이것이 구속력 있는 맥락이다. 감독자가 정할 열린 사항: (1) AGENTS.md는 저장 형식 변경에 형식 번호 상향과 이동 정의를 요구한다. 감독자 결정은 `projects.json`을 형식 1에 선택 멤버와 함께 둔다. 감독자는 형식 1이 릴리스된 형식인지(그러면 규칙이 적용되지 않는다) 또는 이 변경에 규칙을 면제하는지를 밝혀야 한다. (2) 감사자 A의 반론 3: 하나의 검사기를 레이아웃 읽기 시점으로 옮기고 거부를 데이터로 들고 간다. 13라운드 답변(복원은 던지면 안 된다)과 상충한다. 16라운드 수용, 아직 미적용: 복원 문구 하나(복원은 적재된 값을 그대로 저장하며, 복원 항목은 검사기나 `Object.freeze`를 적지 않는다). 적재된 origin 부재 탭은 적재된 것으로 보아 `capture()`가 origin 멤버를 쓰지 않고 던지지 않는다. `tabOrigin` 폴백 제거는 엄격한 뷰 시작 거부와 한 변경에서 함께 간다. 그래서 null을 내는 중간 상태가 없다. NUL은 절대 경로가 아니라는 트리거에 든다. JSON 배열은 형식 트리거에서 객체가 아니다. 거부마다 로그에 기록되고 그 탭에 항목 4의 문구로 표시되며, 탭은 레이아웃에 남는다(F238-a-16). 저장 형식 읽기 규칙 하나: 멤버가 없는 탭은 이름 붙은 origin 부재 거부로 읽는다. 변경 뒤에 저장된 레이아웃의 하향은 지원되지 않으며, 이전 빌드는 저장 시 멤버를 버린다. 16라운드 판정 대기(D7만).

- 16라운드(감독자 결정, 그 뒤 새 감사자 2명). 감독자 결정 1~4는 D7에 기록되고 적용되었다. 형식은 1로 남고 형식 규칙의 시험을 적었다. 검사기는 레이아웃 읽기로 옮겨지고 거부는 탭의 데이터로 실린다. 15라운드 항목은 결정 항목 3, 4, 7, 8과 필요한 변경에 적용되었다. 플러그인/shell 항목은 F238-a-17이다. 16라운드 감사자 답변(새 감사자 두 명, 실행 c971e2d1과 f6f5cd04, 결정 수준). 두 명 모두 반론했다. 반론은 D7의 판정 R1~R7로 답했다: 거부를 뷰 탭으로 한정(B1), 우선순위(B2), 존재(B3), 페이지 술어(A1), 문구 순서(A2), 레이아웃 읽기의 검사기 하나(A3), 다운그레이드 결과 미정(B, 형식). 형식 결정은 두 명 모두 지지했다. D7은 닫힌다. 17라운드는 돌리지 않는다.