# 결정 검토 F238-a: 뷰 영역(D4)과 origin 형식(D7)

[English](decision-review-F238-a.md)

이 기록은 적대적 검증 없이 내려진 두 결정을 검토한다: D4(뷰 영역, F228)와 D7(origin 형식, F235와 F237). 각 결정은 무엇을 결정하는지, 이유, 파일과 줄 번호가 있는 근거, 필요한 변경을 적는다. 새 감사자(claude-haiku-5-5)는 결정이 틀리거나 불완전한 곳만 반론하고 해결책을 제시한다. 표현과 인용 수정은 직접 반영한다. 한 라운드의 두 감사자가 실질적 반론이 없을 때까지 라운드를 반복한다.

인용은 코드가 있는 브랜치를 함께 적는다. `main`에는 F228과 F237이 없다.

브랜치: `feat/view-region-F228`, `fix/view-region-close-F228-5`, `fix/view-origin-F237`, `feat/view-bridge-F231`, `main`.

## D4. 뷰 영역(F228)

### 결정

1. 영역 작업은 뷰 호출이다. 뷰는 `sok-view`로 호스트를 호출하고, 워크벤치가 각 호출에 발신 surface를 찍어 영역 기록을 거쳐 영역 호출을 보낸다.
2. 거부: 합성, 문서, 이미지 호스트 호출의 원시 `runtime.native.call`은 거부한다. 거부 집합은 `REGION_HOST_CALLS`이며, 테스트가 `packages/workbench/surface-modules.js`와 `host.js`(및 `invoke(`, `composed(`, `hostClose(` 호출을 grep으로 찾은 `packages/workbench/` 내 다른 파일)에서 영역 종류 이름을 도출한다. 영역 종류 이름이 집합에 없으면 테스트가 실패한다.
3. `runtime.native.on`은 `REGION_EVENTS`의 이름만 받는다. `REGION_EVENTS`는 두 브랜치 어디에도 없으며 `packages/workbench/view-calls.js`에 정의하고, 테스트가 `surface-modules.js`가 구독하는 이벤트 이름과 대조한다.
4. 쌓임 순서(시각과 입력 모두, 위에서 아래): 뷰 DOM 오버레이, 뷰 영역, 뷰 페이지 DOM. 보이는 뷰 오버레이 사각형 안의 점은 오버레이의 DOM 뷰(`mainWebview` 또는 `webview`)로 가거나 아무에게도 가지 않는다. 영역이나 네이티브 평면으로 가지 않는다.
5. 재적용: 이미지 영역은 로컬 `CATransaction` 안에서 insets를 다시 적용한다. 문서 영역은 배치 시점과 `NSViewFrameDidChangeNotification` 관찰자에서 다시 적용하며, 둘 다 `CATransaction` 안에서 실행되지 않는다. 명세는 문서 영역에 대해 창 트랜잭션을 주장하지 않는다.
6. 열린 결함: 각각 소유 브랜치에서 수정과 테스트가 필요하다. 항목 4의 hit-test 결함(근거 E3), 항목 2의 거부 집합 누락(E2), 항목 3의 `REGION_EVENTS` 부재.

### 이유

스탬프된 뷰 호출을 거친 라우팅은 revision, 영역 수명, 영역 기록을 영역에 닿는 유일한 경로로 만든다. 원시 호스트 호출은 이를 건너뛴다(`view-calls.js:74-76`, feat). 이것은 그 근거를 가진 워크벤치 선택이지, 플러그인 프로세스 규칙 9의 결과가 아니다. 규칙 9는 봉투 검사만 제공한다.

쌓임은 표면 합성 계약을 따른다. "선언된 플러그인 오버레이와 워크벤치 메뉴/대화상자는 네이티브 문서 영역 위에서 입력을 소유한다"(main `docs/spec/surface-composition.md:24`), "네이티브 콘텐츠는 오버레이의 점을 소유할 수 없다"(`:28`). 영역은 네이티브 콘텐츠이므로 뷰 오버레이 아래에 놓인다.

### 근거

- E1(라우팅). feat의 `packages/workbench/view-calls.js` `runtime.native.call` 분기(`:105-118`)는 `REGION_HOST_CALLS`(`:78-83`)의 이름을 "뷰는 합성을 통해서만 영역을 다룬다"라는 메시지로 거부한다.
- E2(거부 집합 누락). feat의 `packages/workbench/surface-modules.js`에서 영역 종류 호출이 나온다. `invoke`는 `:92`부터 `:113`까지(`documentAttach`, `documentLoad`, `documentZoom`, `documentGo`, `documentSubscribe`, `documentUnsubscribe`, `documentPost`, `imageAttach`, `imageFocus`, `imageCaret`, `imageText`, `imageDetach`), `composed`는 `:110`(`imagePlace`)과 `:131`(`compositionPlace`), `invoke`는 `:120`(`compositionDeclare`). `packages/workbench/host.js:462-463`은 `documentQuery`와 `documentInteractionState`를 호출한다. `REGION_HOST_CALLS`(`view-calls.js:78-83`)에는 이 둘이 없다. `documentWebviews`는 호스트 호출이 아니다. `host.js`만 읽는 테스트는 18개 중 16개를 놓친다.
- E3(hit test, 두 누출). feat의 `native/darwin/src/webview_geometry.m`, `SPSurfaceHost hitTest`(`:283-303`). 보이는 오버레이 사각형 안의 점에 대해: (a) `self.mainWebview`가 설정되면 메서드가 nil을 반환하여(`:287`) 오버레이 DOM이 그 점을 받지 못한다. (b) 오버레이 DOM이 nil을 반환하거나(`:288-292`, 투명한 점), `self.webview`가 없거나 숨겨져 있으면 루프가 반환하지 않고 점이 `self.nativePlane`으로 떨어진다(`:294-296`). 명세(`surface-composition.md:28`)는 둘 다 금지한다. `fix/view-region-close-F228-5`에서는 비뷰 분기가 `document_view.m:1070` 뒤에 네이티브 평면에 붙고(`webview_geometry.m:764`의 `sp_surface_place_view`), `hitTest`는 `self.webview`를 먼저 확인한다. 결함은 feat에만 기록한다.
- E4(마스크 경로). `packages/host/tauriv2/src/composition.rs:315-325` → `platform/darwin/webview.rs:196-208` → `webview_geometry.m:761-771`(feat) / `:783-793`(fix) → `domOverlays` setter → `applyOverlayMask`. 마스크 경로는 존재한다. 통과 전에 뷰 오버레이가 마스크에 도달함을 단위 테스트로 증명해야 한다.
- E5(재적용). `image_region.m`의 `applyInsetsNow`는 `:363-368`에 있으며 `CATransaction`(`:371-372`) 안에서 실행되고 `:1244-1249`에서 호출된다. `document_view.m:1068`(feat)과 `:1076`(fix)은 문서 영역을 네이티브 평면에 붙이고, `:1266`(feat)과 `:1275`(fix)은 배치 시점에 insets를 적용하며, `:898-938`은 프레임 변경 관찰자에서 다시 적용한다. 문서 경로를 감싸는 `CATransaction`은 없다.
- E6(명세). main `docs/spec/native-surfaces.md:102`는 영역에 대해 "같은 네이티브 트랜잭션에서"라고 쓰며, 이는 이미지 영역에만 참이다(E5).
- E7(거부 집합 범위). 거부 대상은 호스트 호출 이름이다. `runtime.native.on` 구독 이름은 `REGION_EVENTS`로 따로 검사한다(결정 항목 3).

### 필요한 변경

- 소유 `feat/view-region-F228`: `REGION_HOST_CALLS`에 `documentQuery`와 `documentInteractionState`를 추가한다. 결정 항목 2가 명시한 워크벤치 모듈을 스캔하여 모든 영역 종류 이름이 집합에 있음을 확인하는 테스트를 추가한다(현재 집합에서 Red).
- 소유 `feat/view-region-F228`: `view-calls.js`에 `REGION_EVENTS`를 정의하고, `runtime.native.on`이 그 이름을 검사하게 한다. 테스트가 `surface-modules.js`의 구독 이름과 대조한다(Red 먼저).
- 소유 `feat/view-region-F228`: `SPSurfaceHost hitTest`(`webview_geometry.m:283-303`)를 고쳐, 보이는 오버레이 사각형 안의 점이 오버레이 DOM 히트 또는 nil을 반환하고 네이티브 평면에 닿지 않게 한다. 단위 테스트는 mainWebview 경우, 투명한 오버레이 점(DOM이 nil), `webview`가 nil인 경우를 다룬다(수정 전 Red, 수정 후 Green).
- 소유 `feat/view-region-F228` 또는 `fix/view-region-close-F228-5`(먼저 병합되는 쪽): 뷰 오버레이가 `applyOverlayMask`에 도달함을 확인하는 단위 테스트(E4).
- main 명세(`docs/spec/surface-composition.md`, `docs/spec/native-surfaces.md:102`, ko 대응본): 결정 항목 4의 쌓임 순서를 적고, "같은 네이티브 트랜잭션"을 이미지 영역에만 한정한다.

### 반론과 답변

- 1라운드, 감사자 A, 반론 1: 테스트는 `host.js`가 아니라 `surface-modules.js`를 스캔해야 하고, `REGION_EVENTS`는 두 브랜치 모두에 정의되어 있지 않다. 수용. 테스트 원천과 `REGION_EVENTS` 정의는 결정 항목 2와 3에 있다.
- 1라운드, 감사자 B, 반론 1: 같은 원천 누락, `hostClose`와 `composed` 래퍼 포함. 수용. 결정 항목 2가 `invoke`, `composed`, `hostClose`를 모두 다룬다.
- 1라운드, 감사자 B, 반론 2: hit-test에 두 번째 누출(투명한 DOM 점과 nil `webview`가 네이티브로 떨어짐). 수용. E3와 필요한 변경이 두 경우를 모두 다룬다. 이전 본문은 mainWebview 경우만 다루었다.

## D7. origin 형식(F235, F237)

### 결정

1. `origin`은 항상 정확히 `directory`라는 한 멤버를 가진 객체 `{directory}`이다.
2. `directory`는 절대 경로 또는 null이다. null은 탭이 디렉터리를 기록하지 않았음을 뜻한다.
3. 절대 경로는 첫 글자가 `/`인 경로다. Windows 드라이브 경로와 UNC 경로는 거부한다. 워크벤치가 이미 거부하기 때문이다(근거 E5). 각 호스트와 페이지는 같은 문자열 검사를 쓴다: TypeScript는 `path.startsWith("/")`, Go는 `strings.HasPrefix(path, "/")`, Rust는 `path.starts_with('/')`. 플랫폼 경로 API를 쓰지 않으므로 결과는 호스트 OS에 따라 달라지지 않는다.
4. 부재한 origin, null origin, 다른 형식의 객체, 문자열이 아닌 null이 아닌 `directory`, 빈 경로, `/`로 시작하지 않는 경로는 명시적 오류로 거부한다. 다섯 문구는 다음과 같다.
   - `surface "<id>": view start origin is missing` (부재)
   - `surface "<id>": view start origin is not {directory} with a path or null` (그 밖의 형식)
   - `surface "<id>": view start origin directory is empty` (빈 경로)
   - `surface "<id>": view start origin directory is not an absolute path` (`/`로 시작하지 않는 경로)
5. 페이지는 강제 변환하지 않는다. `packages/plugin-api/surface.js:12`(기본값 `origin = { directory: null }`)과 `:72`(`origin.directory ?? null`)를 제거한다. `createSurfaceContext`는 origin이 정확히 `{directory}`이고 값이 null 또는 `/`로 시작하는 문자열이 아니면 `TypeError`를 던진다.
6. 워크벤치는 origin 기본값을 두지 않는다. main의 `tabOrigin`(`packages/workbench/tab-reports.js:141`, `?? Object.freeze({ directory: null })`)을 제거한다. 기록된 origin이 없는 탭은 뷰 시작 시 오류이며, 모든 탭 생성 경로가 `recordOrigin`을 호출한다.
7. 복원은 origin을 유지한다. 탭의 origin은 상호작용 상태와 함께 탭 세션 파일 `tab-sessions/<tab>.json`에 기록되고, 복원 시 그 파일에서 읽는다. 메모리 `origins` 맵(`tab-reports.js:5`, `:194`에서 삭제)만이 저장소가 아니다. 이 하위 항목이 들어가기 전까지 명세는 복원된 탭이 origin을 유지한다고 주장하지 않는다(필요한 변경 참조).

### 이유

워크벤치는 항상 객체를 보내므로(`packages/workbench/tab-reports.js:137`), 부재하거나 null인 origin을 거부해도 어떤 코드 경로도 깨지지 않는다. 부재한 origin에 `{directory: null}`을 강제로 채우면 누락된 기록이 숨겨지며, `AGENTS.md`가 금지하는 일("경계에서 잘못된 값을 거부한다")이다. `/` 규칙은 워크벤치가 이미 디렉터리에 적용하는 규칙이다(`reportDirectory`, main `tab-reports.js:125`). 따라서 뷰의 origin과 탭의 디렉터리가 어긋나지 않는다. Windows 지원은 그 워크벤치 규칙을 바꾸는 별도 변경이며, 이 결정의 차이가 아니다.

### 근거

- E1(호스트, fix). `fix/view-origin-F237:packages/host/tauriv2/src/surfaces.rs:58-61`은 `origin`을 원시 값(`Option<Value>`, `present_value`)으로 보관한다. `view_origin_directory`(`:76-94`)는 부재(`:78`), 객체가 아니거나 멤버가 둘 이상인 값(`:82-86`), `directory`의 누락이나 잘못된 타입, 빈 경로를 거부한다. 절대 경로 검사는 아직 없다.
- E2(호스트, fix). `fix/view-origin-F237:packages/host/wailsv3/src/surfaces.go:62-112`: `viewOriginDirectory`는 nil origin(`:70`), 맵이 아닌 값(`:76`), `directory` 누락(`:81`), 빈 경로(`:91`)를 거부한다. 절대 경로 검사는 아직 없다.
- E3(페이지, main). `packages/plugin-api/surface.js:12`는 origin 기본값을 `{directory: null}`로 둔다. `:72`는 `origin.directory ?? null`로 강제 변환한다. 이 때문에 E1과 E2의 호스트 거부는 페이지 경로에서 도달할 수 없다.
- E4(shell 페이지). `plugins/shell/ui/view.js:22`와 `plugins/shell/test/view.test.mjs:47-53`은 null origin을 기본 디렉터리로 취급한다. 이들은 shell 저장소에서 바뀐다.
- E5(워크벤치 규칙, main). `packages/workbench/tab-reports.js:125`는 `startsWith("/")`가 아닌 모든 디렉터리를 거부하므로, Windows나 UNC origin은 워크벤치를 거쳐 뷰에 도달할 수 없다.
- E6(복원, main). `docs/spec/plugins.md:223`은 "언로드된 탭을 보이게 하면 같은 `origin`으로 surface를 마운트한다"라고 쓰며 세션 한정 표현이 없다. 앱 재시작 후에는 메모리 `origins` 맵이 비어 있고 `tabOrigin`이 `{directory: null}`을 반환한다(`tab-reports.js:141`). 따라서 재시작에 대해 이 문장은 거짓이다. `plugins.md:225`는 탭이 언로드되었는지를 저장하지 않는다고 쓰며, 탭 세션 파일은 상호작용 상태만 저장한다(`plugins.md:223`).
- E7(`directory: null`은 유효하다). 디렉터리 없이 열린 탭은 아무것도 기록하지 않는다(원천 탭이 없을 때의 `recordOrigin`, `tab-reports.js:137`).

### 필요한 변경

- 소유 `fix/view-origin-F237`: 아직 없는 절대 경로 검사를 결정 항목 3의 `/` 접두 검사로 대체한다. `view_origin_directory`(`surfaces.rs`)와 `viewOriginDirectory`(`surfaces.go`)에서 빈 경로 검사 뒤에 둔다. 각 호스트 테스트에 `/`와 `C:\` 경우를 추가한다(수정 전 Red).
- 소유 main, `packages/plugin-api/surface.js`: `:12`의 기본값과 `:72`의 강제 변환을 제거한다. `createSurfaceContext`는 결정 항목 5에 따라 거부한다. `packages/plugin-api`에 단위 테스트를 둔다(Red 먼저).
- 소유 main, `packages/workbench/tab-reports.js`: `tabOrigin`의 폴백(`:141`)을 제거한다. 뷰 시작 시 origin이 없으면 명명된 오류를 던진다. `recordOrigin` 없이 뷰를 시작할 수 없음을 확인하는 테스트를 둔다(Red 먼저).
- 소유 main, 워크벤치(`tab-reports.js`, 탭 세션 파일): origin을 탭 세션과 함께 저장하고 복원한다. 재시작 후 복원된 탭이 origin을 유지하는 테스트를 둔다(Red 먼저). 이것이 들어가기 전까지 `plugins.md:223`과 `:225`는 앱 재시작 후 복원된 탭의 origin이 유지되지 않는다고 적는다.
- 소유 shell 저장소: `plugins/shell/ui/view.js:22`와 그 테스트 `view.test.mjs:47-53`이 null을 기본값으로 취급하지 않게 한다. "다른 곳에 기록"에 적는다.
- 소유 main(명세, EN과 KO): `native-surfaces.md:136`, `host-contract.md:196`, `plugins.md:223`, `:225`에 다섯 문구와 `/` 규칙을 적는다.

### 반론과 답변

- 1라운드, 감사자 A, 반론 2: 단일 규칙은 플랫폼 API로 만족될 수 없고 워크벤치는 `/`가 아닌 경로를 거부한다. 수용. 규칙은 이제 워크벤치의 기존 규칙인 `/` 접두 검사뿐이다. Windows는 워크벤치 규칙이 바뀌기 전까지 범위 밖이다.
- 1라운드, 감사자 A, 반론 3: 복원이 소유자 없이 남아 있고, `plugins.md:223`은 재시작 후 거짓이다. 수용. 복원은 소유자가 있는 필요 변경이 되었고(탭 세션 파일에 origin 저장), 들어가기 전까지 명세 문장은 거짓으로 적는다.
- 1라운드, 감사자 B, 반론 3: `tabOrigin` 폴백은 결정이 금지하는 강제 변환과 같다. 수용. 폴백을 제거한다(결정 항목 6).
- 1라운드, 감사자 B, 반론 4: 순수 문자열 술어가 필요하다. 수용. `/` 접두 문자열 검사가 그 술어다(결정 항목 3).

## 라운드 기록

- 1라운드: 두 감사자가 반론했다(A 3건, B 4건). 모두 수용해 위에 반영했다. 판정은 2라운드 대기 중이다.
