# 결정 검토 F238-a: 뷰 영역(D4)과 origin 형식(D7)

[English](decision-review-F238-a.md)

이 기록은 적대적 검증 없이 내려진 두 결정을 검토한다: D4(뷰 영역, F228)와 D7(origin 형식, F235와 F237). 각 결정은 무엇을 결정하는지, 이유, 파일과 줄 번호가 있는 근거, 필요한 변경을 적는다. 새 감사자(claude-haiku-5-5)는 결정이 틀리거나 불완전한 곳만 반론하고 해결책을 제시한다. 표현과 인용 수정은 직접 반영한다. 한 라운드의 두 감사자가 실질적 반론이 없을 때까지 라운드를 반복한다.

인용은 코드가 있는 브랜치를 함께 적는다. `main`에는 F228과 F237이 없다.

브랜치: `feat/view-region-F228`, `fix/view-region-close-F228-5`, `fix/view-origin-F237`, `feat/view-bridge-F231`, `main`.

## D4. 뷰 영역(F228)

### 결정

1. 영역 작업은 뷰 호출이다. 뷰는 `sok-view`로 호스트를 호출하고, 워크벤치가 각 호출에 발신 surface를 찍어 영역 기록을 거쳐 영역 호출을 보낸다.
2. 거부 집합. `packages/workbench/view-calls.js`의 `REGION_HOST_CALLS`는 합성, 문서, 이미지 종류의 호스트 명령 중 명시적 허용 목록이다. 호스트가 명령 표(`packages/host/tauriv2/src/bindings.rs`와 Wails 대응본)에 등록한 영역 종류 명령이며, 각 이름에 이유를 단다. 이름은 Rust의 snake_case 식별자(`document_attach`)와 Go의 PascalCase 메서드(`DocumentAttach`)를 camelCase 이름(`documentAttach`)으로 바꾼 뒤 비교한다. `imagePlace`(`surface-modules.js:110`)는 두 표 어디에도 호스트 명령이 없어 허용 목록에 넣지 않으며, 열린 결함이다(필요한 변경). 테스트는 그 표를 읽어 영역 종류 항목이 허용 목록과 같음을 확인하고, `documentWebviews`(명령이 아니라 창 사실)가 어느 쪽에도 없음을 확인한다. 두 번째 테스트는 `packages/workbench/`에서 `invoke`, `composed`, `hostClose`, `bridge.call`, `scoped.native.call`에 전달되는 `document*`, `image*`, `composition*` 리터럴 이름을 스캔한다. 이 스캔은 보조이며, 리터럴이 허용 목록에 없으면 실패한다.
3. 모든 플러그인 쪽 경로에서 거부. 플러그인 코드는 둘 다 `invoke`(`packages/workbench/host.js:204`)로 이어지는 두 핸들로 호스트에 닿는다. `runtime.native`(`native: { call: invoke, on }`, `host.js:251-252`)와 `call(name)`(`host.js:257-261`, 점이 없는 이름은 `invoke`로 보낸다). `surface-modules.js:462`는 현재 원시 `scoped.native`를 `runtime.native`로 노출하며, 이를 게이트 래퍼로 바꾼다. 래퍼의 `call`은 `REGION_HOST_CALLS`의 모든 이름을 영역 오류로 거부하고, 래퍼의 `on`은 항목 4의 이름만 받는다. 워크벤치 페이지는 `pageRuntime`(`surface-modules.js:84`)에 원시 `scoped.native`를 유지한다. 그것은 플러그인 코드가 아니다. 거부는 공유 게이트 래퍼에 두어 모든 플러그인 쪽 경로가 통과하게 한다. 테스트는 허용 목록의 각 이름으로 뷰 런타임의 `native.call`(`surface-modules.js:280`)도 같은 래퍼로 만든다. `VIEW_BRIDGE_CALLS = {viewRequest, viewEvent, viewReply}`(호스트 명령 `bindings.rs:494-510`, 워크벤치의 원시 호출 `surface-modules.js:257, 263, 333`)는 같은 래퍼가 거부한다. 테스트는 허용 목록과 `VIEW_BRIDGE_CALLS`의 각 이름으로 `runtime.native.call`, `call`, 뷰 `run`을 호출해 거부를 확인하고, 영역 이름이 `registry.handle`(`host.js:258`)에 닿지 않음을 확인한다.
4. `runtime.native.on`은 `REGION_EVENTS`의 이름만 받는다. `REGION_EVENTS`는 `surface-modules.js`가 구독하는 네 영역 이벤트 `document-stream`(`:103`), `document-state`(`:105`), `document-message`(`:106`), `image-event`(`:115`)와 정확히 같다. 테스트는 (a) `REGION_EVENTS`가 이 네 리터럴과 같음을, (b) `runtime.native.on`이 뷰 브리지 내부 이벤트 `view-call`, `view-reply`, `view-stopped`, `view-responsiveness`, `view-presentation-abandoned`(`surface-modules.js:320-507`)를 거부함을 확인한다.
5. 쌓임 순서(시각과 입력 모두, 위에서 아래): 뷰 DOM 오버레이, 뷰 영역, 뷰 페이지 DOM. 보이는 뷰 오버레이 사각형 안의 점은 그 뷰의 DOM에 히트가 있을 때 오버레이의 DOM 뷰(`webview` 또는 `mainWebview`)로 가고, 없으면 아무에게도 가지 않는다. 하이브리드 surface의 `mainWebview`도 `webview`와 같은 방식으로 히트 검사한다. 영역이나 네이티브 평면으로 가지 않는다.
6. 재적용: 이미지 영역은 로컬 `CATransaction` 안에서 insets를 다시 적용한다. 문서 영역은 배치 시점과 `NSViewFrameDidChangeNotification` 관찰자에서 다시 적용하며, 둘 다 `CATransaction` 안에서 실행되지 않는다. 명세는 문서 영역에 대해 창 트랜잭션을 주장하지 않는다.
7. hit-test 소유자. hit-test 수정의 소유자는 하나, `fix/view-region-close-F228-5`다. 이 브랜치가 이미 `hitTest`(`webview_geometry.m:283-300`)를 고쳐 쓴다. `feat/view-region-F228`은 `hitTest`를 바꾸지 않는다. 그 버전은 fix 브랜치가 병합될 때 대체되며, feat 브랜치는 자체 `hitTest` 변경을 병합하지 않는다.

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
- 소유 `feat/view-region-F228`: `imagePlace`(`surface-modules.js:110`)를 해결한다. 호출을 지우거나 사유와 함께 호스트 명령을 추가한다. 허용 목록 테스트는 이 뒤에 실행된다.
- 소유 `fix/view-region-close-F228-5`(`hitTest`를 바꾸는 유일한 브랜치): `webview_geometry.m:283-300`의 루프에서, 보이는 오버레이 사각형 안의 점은 오버레이의 DOM 히트 또는 nil을 반환하고 `self.nativePlane`에 닿지 않게 한다. `mainWebview`도 `webview`와 같이 DOM 히트가 있으면 그것을, 없으면 nil을 반환한다. 수정 전 코드에서 Red인 단위 테스트: (a) DOM 전용 surface, 네이티브 평면 위의 오버레이 점, nil 기대; (b) 투명한 DOM 점의 뷰 오버레이, 네이티브 히트 없음 기대; (c) 숨겨진 `webview`, 보이는 오버레이 사각형에서 네이티브 히트 없음 기대; (d) `mainWebview` 설정과 DOM 히트, 그 히트 기대. `mainWebview` 설정과 DOM 히트 없음, nil 기대.
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

### 결정

1. `origin`은 항상 정확히 `directory`라는 한 멤버를 가진 객체 `{directory}`이다.
2. `directory`는 절대 경로 또는 null이다. null은 탭이 디렉터리를 기록하지 않았음을 뜻한다.
3. 절대 경로는 첫 글자가 `/`인 경로다. Windows 드라이브 경로와 UNC 경로는 거부한다. 워크벤치가 이미 거부하기 때문이다(E5). 각 호스트와 페이지는 같은 문자열 검사를 쓴다: TypeScript `path.startsWith("/")`, Go `strings.HasPrefix(path, "/")`, Rust `path.starts_with('/')`. 플랫폼 경로 API는 쓰지 않는다.
4. 부재한 origin, null origin, 다른 형식의 객체, 문자열이 아닌 null이 아닌 `directory`, 빈 경로, `/`로 시작하지 않는 경로는 명시적 오류로 거부한다. 네 문구와 그 트리거는 다음과 같다.
   - `surface "<id>": view start origin is missing`: origin 필드가 없다.
   - `surface "<id>": view start origin is not {directory} with a path or null`: origin이 null이거나 객체가 아니거나, `directory` 외의 멤버를 가졌거나, `directory`가 문자열도 null도 아니다.
   - `surface "<id>": view start origin directory is empty`: `directory` 문자열이 비어 있다.
   - `surface "<id>": view start origin directory is not an absolute path`: `directory` 문자열이 `/`로 시작하지 않는다.
5. 페이지는 강제 변환하지 않는다. `packages/plugin-api/surface.js:12`(기본값 `origin = { directory: null }`)과 `:72`(`origin.directory ?? null`)를 제거한다. `createSurfaceContext`는 origin이 정확히 `{directory}`이고 값이 null 또는 `/`로 시작하는 문자열이 아니면 `TypeError`를 던진다.
6. 모든 탭 생성은 origin을 명시적으로 넘긴다. `newTab(kind, params)`(`packages/workbench/plane.js:142`)는 필수 인자 `fromTabId`(원천 탭이 없으면 null)를 받고 스스로 `recordOrigin(tab.id, fromTabId)`를 호출한다. 호출자는 원천을 명시한다: 카드 생성 경로 `plane.js:779`, `:797`(이미 `recordOrigin` 호출), 마지막 탭 닫힘 경로 `plane.js:518`(`newTab(..., null)`, `{directory: null}` 기록), 새 공간 경로 `initial()`(`plane.js:163`, `tab(t.plugin, t.title)`로 탭을 만들고 `recordOrigin(id, null)`을 호출한다).
7. origin은 탭 세션이 아니라 탭 레이아웃과 함께 저장된다. 저장된 레이아웃의 카드 `tabs` 안에서 각 탭 항목은 `{id, plugin, origin: {directory}}` 형태다. 저장 레이아웃 판독기 `checkStoredLayout`(`packages/workbench/stored-layout.js:7`)은 열 때 origin이 없는 콘텐츠 카드 탭을 명명된 오류 `stored tab <id> has no origin`으로 거부한다. 저장 레이아웃은 변환하지 않는다(`stored-layout.js:19`과 AGENTS.md). 이 변경 전에 저장된 레이아웃에는 origin이 기록되지 않았으므로 origin을 추론할 수 없다. 그 레이아웃은 열 때 거부되며 사용자가 탭을 다시 만든다. 이 사실은 `docs/spec/plugins.md`와 변경 기록에 적는다. 탭 세션 파일 `tab-sessions/<tab>.json`은 저장소가 아니다. `packages/workbench/tab-session.js`가 문서 영역이 없는 탭의 파일을 지우기 때문이다(`put(tab, null)`, `:55`, `:65`). 복원 함수는 `plane.js`의 `build(kept)`(`:1414`)와 `adopt(kept)`(`:1564`)다. 둘 다 내보낸 헬퍼 `recordStoredOrigins(kept)`를 부른다. 이 헬퍼는 `restoreWindowState(kept)` 뒤, 탭을 만들기 전에 저장된 각 탭에 대해 `recordOrigin(tab.id, tab.origin)`을 호출한다. 테스트는 플레인을 마운트하지 않고 헬퍼를 직접 부른다. `checkStoredLayout`(`stored-layout.js:7`)은 내보낸 순수 함수이므로 origin 거부를 직접 테스트한다.
8. 워크벤치 폴백 제거는 마지막 단계다. `tabOrigin`(`packages/workbench/tab-reports.js:141`, `?? Object.freeze({ directory: null })`)은 결정 항목 6과 7이 들어가고 테스트가 Green이 될 때까지 폴백을 유지한다. 그 뒤에 기록되지 않은 탭에 대해 던지며, 뷰 시작 경로가 그 오류를 드러낸다.

### 이유

워크벤치는 항상 객체를 보내므로(`tab-reports.js:137`), 호스트와 페이지에서 부재하거나 null인 origin을 거부해도 origin을 기록하는 코드 경로는 깨지지 않는다. 기록이 없을 때 `{directory: null}`을 강제로 채우면 결함이 숨겨지며, `AGENTS.md`가 금지하는 일("경계에서 잘못된 값을 거부한다")이다. `/` 규칙은 워크벤치가 이미 디렉터리에 적용하는 규칙이므로(`reportDirectory`, `tab-reports.js:125`), 뷰의 origin과 탭의 디렉터리가 어긋나지 않는다. Windows 지원은 그 규칙을 바꾸는 별도 변경이다.

origin을 탭 세션이 아니라 레이아웃에 저장하는 이유는 E4에 있다. 탭 세션 파일은 평범한 surface에서 지워지므로 거기 저장된 origin은 사라진다.

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
- 소유 main, `packages/plugin-api/surface.js`: `:12`의 기본값과 `:72`의 강제 변환을 제거한다(결정 항목 5). 단위 테스트(Red 먼저).
- 소유 main, `packages/workbench/plane.js`와 `tab-reports.js`: 결정 항목 6. 테스트: 마지막 탭 닫힘(`plane.js:518`)은 `{directory: null}`로 뷰를 시작하고 던지지 않는다. 새 탭은 원천 origin을 기록한다.
- 소유 main, 워크벤치 레이아웃과 복원: 결정 항목 7. 테스트: 문서 영역이 없는 복원된 탭은 재시작 후 저장된 origin으로 뷰를 시작한다(Red 먼저). origin이 없는 탭을 가진 레이아웃은 `checkStoredLayout`이 명명된 오류로 거부한다.
- 소유 main, `tab-reports.js`: 위 두 테스트가 Green인 뒤에만 `tabOrigin` 폴백을 제거한다(결정 항목 8).
- 소유 shell 저장소: `plugins/shell/ui/view.js:22`와 `plugins/shell/test/view.test.mjs:47-53`이 null을 기본값으로 취급하지 않게 한다. "다른 곳에 기록"에 적는다.
- 소유 main(명세, EN과 KO): `native-surfaces.md:136`, `host-contract.md:196`, `plugins.md:142`, `:223`, `:225`에 네 문구와 트리거, `/` 규칙, 레이아웃 origin 필드, 이 변경 전 레이아웃의 거부를 적는다.

### 반론과 답변

- 1라운드, 감사자 A, 반론 2: 단일 규칙은 플랫폼 API로 만족될 수 없고 워크벤치는 `/`가 아닌 경로를 거부한다. 수용. 규칙은 `/` 접두 검사다.
- 1라운드, 감사자 A, 반론 3: 복원이 소유자 없이 남아 있고 `plugins.md:223`은 재시작 후 거짓이다. 수용. 결정 항목 7과 E8.
- 1라운드, 감사자 B, 반론 3: `tabOrigin` 폴백은 같은 강제 변환이다. 수용. 다만 먼저 제거하면 회귀한다(2라운드). 결정 항목 8이 마지막 단계로 둔다.
- 1라운드, 감사자 B, 반론 4: 순수 문자열 술어가 필요하다. 수용(결정 항목 3).
- 2라운드, 감사자 D, 반론 4(a): `tab-sessions`의 origin은 평범한 surface에서 지워지고 `capture`는 일찍 반환한다. 수용. origin은 레이아웃으로 옮긴다(결정 항목 7, E4).
- 2라운드, 감사자 D, 반론 4(b): 복원 경로는 `recordOrigin`을 호출하지 않는다. 수용(결정 항목 7).
- 2라운드, 감사자 C, 반론 1: `plane.js:518`과 복원된 탭은 `recordOrigin`을 우회하고, 폴백을 먼저 제거하면 회귀한다. 수용(결정 항목 6, 7, 8, E6, E7).
- 3라운드, 감사자 F, 반론 4: 다섯 문구라고 적었으나 네 문구만 있다. 수용. 네 문구와 트리거로 고친다(결정 항목 4).
- 3라운드, 감사자 F, 반론 5: 복원 함수와 항목 형태가 이름 없이 남아 있다. 수용. 함수와 형태를 적는다(결정 항목 7).
- 3라운드, 감사자 F, 반론 6, 그리고 감사자 E, 반론 3: 이 변경 전 저장 레이아웃은 origin이 없어 복원 시 모두 실패한다. 수용. origin을 추론할 수 없으므로 변환하지 않고 열 때 거부하며, 사용자가 탭을 다시 만든다(결정 항목 7). 변경 기록과 명세에 적는다.
- 3라운드, 감사자 F, 반론 7: 항목 5–8의 순서는 문제없다. 기록(확인).

## 라운드 기록

- 1라운드: 감사자 A와 B가 반론했다(각 3건과 4건). 모두 수용해 본문을 고쳤다.
- 2라운드: 감사자 C와 D가 반론했다(D4에서 각 3건과 3건, D7에서 각 1건과 2건). 모두 수용해 본문을 고쳤다.
- 3라운드: 감사자 E와 F가 반론했다(D4: 각 3건과 3건; D7: 각 3건과 3건). 모두 수용해 위 본문에 반영했다. 4라운드 답변(감사자 G와 H, 코드로 확인): 수용. `imagePlace`는 두 명령 표에 없어 허용 목록에서 빠지고 열린 결함이 된다. 이름은 snake_case와 PascalCase에서 camelCase로 바꾼다. 뷰 런타임의 `native.call`(`surface-modules.js:280`)과 뷰 브리지 명령(`bindings.rs:494-510`)은 게이트 래퍼를 거친다. 반영 시점의 문서 쌍은 `native-surfaces.md:178`이다. 새 공간 `initial()`(`plane.js:163`)과 `adopt`(`plane.js:1564`) 경로는 한 헬퍼로 origin을 기록한다. 확인하고 반론이 없는 항목: `runCore`와 `runtime.command`는 `core.` 접두 이름만 전달한다. 판정은 5라운드 대기 중이다.
