# 노출: status, command, dom

[English](exposure.md)

코어, 플러그인 API, 셸·브라우저 플러그인, macOS 호스트가 이 명세를 구현하며 [기능 상태](../features.ko.md)가 검증 결과를 기록한다.

코어(워크벤치와 네이티브 호스트)는 선언된 상태 값, 명령, DOM 요소를 [로컬 엔드포인트](endpoint.ko.md)로 외부 클라이언트에 공개한다. 임의 코드를 실행하는 메서드는 없다.

## 선언

플러그인은 `plugin.json`의 `exposes`에 항목을 선언한다([플러그인](plugins.ko.md)). 코어는 같은 형식으로 `packages/workbench/exposure.json`에 항목을 선언한다.

```json
{
  "exposes": {
    "status": [],
    "commands": [],
    "dom": []
  }
}
```

선언되지 않은 이름의 등록은 실패한다. 선언되었지만 등록되지 않은 이름을 요청하면 오류를 반환한다.

### 이름

이름의 형식은 `<소유자>.<이름>`이다. 소유자는 `core`, `host`, 또는 플러그인 id다. 이름에는 소문자, 숫자, 점, 하이픈을 사용한다.

### 항목 필드

| 종류 | 필드 | 의미 |
| --- | --- | --- |
| status | `name` | 항목 이름 |
| status | `description` | 한 문장 설명 |
| status | `schema` | 값 스키마 |
| command | `name` | 항목 이름 |
| command | `description` | 한 문장 설명 |
| command | `params` | 매개변수 스키마 |
| command | `result` | 결과 스키마 |
| command | `timeout` | 선택. 호스트가 표면 페이지의 답을 기다리는 시간(ms, 1–600000). 없으면 10초다 |
| dom | `name` | 항목 이름 |
| dom | `description` | 한 문장 설명 |
| dom | `many` | 선택. 여러 요소가 같은 이름을 쓰면 `true`이며, 요청은 `index`로 요소 하나를 지정한다 |

스키마는 `type`, `properties`, `items`, `enum` 키워드만 쓰는 JSON Schema 부분집합이다.

dom 항목의 요소는 `data-expose="<이름>"` 속성을 가진다. `many`가 없으면 그 이름을 가진 요소는 정확히 하나다.

## 사용자 인터페이스

사람과 외부 클라이언트는 같은 항목으로 문서를 조작한다.

- 문서의 모든 사용자 조작은 선언된 명령을 실행한다. 컨트롤은 `data-command="<이름>"`으로 명령을 가리키고, 고정 매개변수는 `data-params`에 JSON 객체로 적는다. 값을 입력하는 컨트롤은 그 값을 `data-value`가 가리키는 매개변수 이름(기본 `value`)으로 더한다. 명령을 먼저 선언하고(`exposure.json`, `plugin.json`), 문서는 `@soksak/plugin-api`의 `createBinder(run)`으로 선언된 명령에만 요소를 연결한다. `bind(요소, 이름, 매개변수, {event, when, stop, failed})`는 이벤트에서 명령을 실행하고, `mark(요소, 이름, 매개변수, 값 이름)`은 속성을 붙이며, `delegate(루트)`는 표시된 하위 요소의 누름과 값 변경을 실행한다. 선언되지 않은 이름을 연결하거나 표시하면 예외를 던진다. 워크벤치는 `packages/workbench/commands.js`(등록소 위의 연결기)를, 플러그인 페이지는 페이지가 등록한 명령을 실행하는 `expose.bind`, `expose.mark`, `expose.delegate`를 쓴다. 처리기는 모듈 함수를 직접 부르지 않는다. 탭 드래그 같은 연속 조작은 결과를 만드는 명령(`core.tab.move`)을 가지며, 키보드 단축키도 명령을 실행한다.
- 문서에 보이는 모든 상태는 status로 읽을 수 있다.
- 모든 조작 요소(`button`, `input`, `select`, `textarea`, `role="button"`, `contenteditable`)는 명령에 연결되고(직접 연결되거나, 위임한 루트 안에서 `data-command`를 가짐) dom 이름을 가진다.
- 네이티브 모달은 요소의 사본을 그리고 컨트롤의 key로 답한다. 메인 페이지는 자기 요소에서 그 컨트롤을 찾아 명령을 실행한다.

충족 여부는 실행 중인 문서에서 판단한다. 연결기의 `audit(루트)`는 연결되지 않았거나 dom 이름이 없는 조작 요소를 `{tag, expose, command, text}`로 나열한다. 메인 페이지는 이를 `core.page.audit`로, 모든 플러그인 페이지는 `core.surface.document`의 `unbound`로 공개한다. `e2e/audit.test.mjs`가 두 앱의 모든 화면, 모달 구역, 메뉴, 편집 상태, 보이는 플러그인 표면을 방문해 빈 목록을 요구한다. `scripts/check-exposure.mjs`(`make exposure-check`)는 워크벤치와 플러그인 페이지(`plugins/*/ui`)에서 소스가 적은 것만 검사한다. 소스에 적은 이름은 모두 선언되고, 선언한 status와 명령은 등록되며, 선언한 dom 이름은 공개 값으로 적혀 있다.

## 등록

워크벤치는 코어 항목을 메인 페이지의 등록소에 등록한다. 플러그인 표면 페이지는 `@soksak/plugin-api/page`로 항목을 등록한다. 코어 명령은 명령이 예약한 판의 그리기가 끝난 뒤 답한다. 배치를 바꾸는 명령 뒤에 배치를 읽는 쪽은 그려진 배치를 읽는다.

| 함수 | 등록 대상 |
| --- | --- |
| `expose.status(name, read, subscribe)` | `read()`는 현재 값을 반환하고, `subscribe(fn)`은 값이 바뀔 때마다 `fn(value)`를 호출한다 |
| `expose.command(name, run)` | `run(params)`는 결과 또는 결과의 Promise를 반환한다 |
| `expose.dom(name, element)` | dom 항목의 요소 |

네이티브 호스트는 [사이드카](sidecars.ko.md) 메시지를 전달하는 방식과 같은 방식으로 표면 페이지와 메인 페이지 등록소 사이에서 등록과 요청을 전달한다. 표면 페이지가 닫히면 등록소는 그 페이지의 등록을 제거한다.

### 표면 문서

`@soksak/plugin-api/page`는 모든 플러그인 표면 페이지에 다음 코어 항목을 등록하므로 플러그인이 구현하지 않는다. 코어는 이 항목을 `exposure.json`에 선언한다. 표면 페이지가 등록하는 코어 이름은 이 항목뿐이다.

| 종류 | 이름 | 의미 |
| --- | --- | --- |
| status | `core.surface.document` | `{url, timeOrigin, readyState, themed, scale, body, viewport, filter, unbound}`: 문서 주소, 시간 원점, 준비 상태, 첫 테마 적용 여부, 기기 픽셀 비율, CSS 픽셀 단위 body와 시각 뷰포트 크기, 루트 요소의 계산된 `filter`, 조작 요소의 audit(`core.page.audit`와 같은 형식) |
| status | `core.surface.input` | 문서의 최근 입력 이벤트 32개(신뢰 여부 포함)를 순서대로 담는다. `pointerdown`, `pointerup`, `pointermove`, `click`, `wheel`, `keydown`에 대한 `{sequence, type, trusted, x, y, key}`. `sequence`는 1부터 기록한 이벤트마다 1씩 증가한다 |
| command | `core.surface.hit` | CSS 픽셀 단위 `{x, y}`. 그 점에 문서의 요소가 있으면 `true`를 반환한다 |

### 모달 문서

네이티브 모달 문서는 렌더, 배치, 테마 변경마다 모달 응답 경로로 키 `document`를 사용해 자기 상태를 메인 페이지에 보고한다. 메인 페이지는 이를 status `core.modal`로 공개한다. 열린 모달이 없으면 `null`이고, 있으면 `{id, mode, document}`다. `document`는 첫 보고 전에는 `null`이며 이후 `{mode, filter, htmlBackground, bodyBackground, scrimBackground, loaded, rect}`다: 렌더한 요소의 `data-native-modal`, 루트의 계산된 `filter`, 루트와 body의 계산된 배경색, 대화상자 scrim에 사용하는 `body::before`의 계산된 배경색, 문서가 첫 내용 요청의 응답을 처리했는지(적용한 변경보다 오래되어 버린 경우도 포함), CSS 픽셀 단위 요소 사각형.

### 표면 선택

여러 표면 페이지가 같은 이름을 등록할 수 있다. 이런 이름에 대한 `status.get`, `status.watch`, `status.unwatch`, `command.run`, `dom.rect`, `dom.act` 요청은 `core.surfaces`의 식별자인 `surface`를 포함할 수 있다. `surface`가 없으면 메인 페이지가 포커스된 카드의 활성 탭, 최근 배치의 보이는 표면, 마지막 등록 순서로 고른다. 그 이름을 등록하지 않은 `surface`는 1002를 반환한다.

## 창

애플리케이션에는 창이 하나 이상 있고, 창마다 메인 페이지와 등록소가 따로 있다. `windows.list`를 제외한 모든 메서드는 `window`를 받는다. 이 값은 `windows.list`가 반환하는 식별자다. 더 이상 없는 창을 요청하면 오류 1003을 반환한다.

## 호스트 항목

네이티브 호스트는 같은 형식으로 소유자가 `host`인 항목을 선언하고 직접 처리한다.

화면 좌표는 주 디스플레이의 왼쪽 위를 원점으로 하고 y가 아래로 증가하는 포인트 값이다. `shown`은 모달 웹뷰가 보이고 키보드 초점을 받은 뒤 참이 된다. `order`는 창 안 웹뷰의 그리기 순서다. 메인 페이지가 0이며 값이 클수록 위에 그려진다. `background`는 `{draws, alpha}`이며 모달 웹뷰가 자기 배경을 칠하는지와 페이지 아래 배경색의 알파다.

| 종류 | 이름 | 의미 |
| --- | --- | --- |
| status | `host.window` | `{frame, content, scale, maximized, key, active, children, controls, surfaces, documents, modal, responder}`: 창 프레임, 콘텐츠 크기, 백킹 배율, 프레임이 최대화 프레임인지, 키 창 여부, 애플리케이션 활성 여부, 자식 OS 창 수, `hidden`을 포함한 창 단추 프레임, 네이티브 표면 `{id, frame, visible, order}`, [문서 영역](native-surfaces.ko.md#문서-영역) `{surface, document, frame, visible, focused, order}`, 열린 네이티브 모달 `{id, mode, shown, frame, order, background}` 또는 `null`, 창의 첫 응답자 `{class, owner, surface, document}`. `owner`는 `page`, `surface`, `document`, `modal`, `webview`(등록되지 않은 웹뷰), `native`(이미지 영역처럼 모든 웹뷰 밖의 뷰) 중 하나다 |
| status | `host.windows` | `windows.list` 결과. 창이 열리거나 닫힐 때와 창의 제목, 프로젝트, 키 상태, 페이지 준비 상태가 바뀔 때 바뀐다 |
| status | `host.screens` | `[{x, y, width, height, scale, visible}]`: 화면 좌표의 디스플레이와 백킹 배율, 그리고 메뉴 막대와 Dock 을 뺀 영역 `visible`(최대화한 창의 프레임) |
| status | `host.dock` | 애플리케이션 Dock 메뉴 항목 제목의 순서 목록 |
| command | `host.menu.select` | 애플리케이션 메뉴 항목 `{menu, title}`을 실행한다. 제목이 `menu`인 하위 메뉴에서 제목이 `title`인 항목이다 |
| status | `host.menu` | 애플리케이션 메뉴. 구분선을 뺀 하위 메뉴마다 `[{title, items: [{title, key}]}]`이며, `key`는 수정 키 `ctrl`, `opt`, `shift`, `cmd`를 이 순서로 `+`로 이은 뒤 키를 붙인 단축키이거나 빈 문자열이다 |
| command | `host.window.close` | 창의 일반 닫기 동작으로 창을 닫는다 |
| command | `host.window.move` | 창 프레임 원점을 화면 좌표 `{x, y}`로 옮긴다 |
| command | `host.window.maximize` | 창을 최대화한다. `{on: false}`이면 원래 크기로 되돌린다 |
| command | `host.window.fullscreen` | 전체 화면으로 바꾸거나 `on`이 false 이면 되돌린다. 전환이 끝난 뒤에 답한다. macOS 는 전환 중의 요청을 무시하므로 호스트가 그 전환이 끝난 뒤에 적용한다 |
| command | `host.window.resize` | 콘텐츠 영역 크기를 `{width, height}`로 바꾼다 |
| command | `host.window.reload` | 메인 페이지를 다시 로드하고 새 페이지가 준비를 알린 뒤 완료한다. 10초 안에 알리지 않으면 1005다 |
| command | `host.window.presented` | 메인 페이지와 표시 중인 애플리케이션 문서가 현재 배치를 화면에 표시하고, 표시 중인 모든 그림 영역이 정확한 현재 래스터를 표시한 뒤 완료된다. 창의 열린 표면 배치 트랜잭션이 먼저 커밋되기를 기다리며 명령 제한 시간 안에 현재 래스터가 도착하지 않으면 실패한다([네이티브 표면](native-surfaces.ko.md), [표면 합성](surface-composition.ko.md)). 그 상태를 보여 주는 화면 갱신 시각(ms, 녹화 프레임 시각과 같은 시계) `{displayed}`를 반환한다(표시 뒤 창이 있는 화면의 다음 갱신. 창이 어느 화면에도 없으면 호출 시각) |
| command | `host.hit` | 창 좌표의 점 `{x, y}`를 소유한 대상을 반환한다: 메인 페이지면 `{kind: "page"}`(DOM 표면과 그림 영역은 DOM 입력을 받으므로 여기에 속한다, [표면 합성](surface-composition.ko.md)), 문서 영역이면 `{kind: "document", surface, document}`, 또는 `{kind: "native", identifier}` |
| command | `host.dock.select` | 제목이 `{title}`인 Dock 메뉴 항목을 실행한다 |
| command | `host.quit` | 대기 중인 저장을 포함한 일반 애플리케이션 종료를 요청한다 |

## 메서드

클라이언트는 다음 JSON-RPC 2.0 메서드를 호출한다.

| 메서드 | 매개변수 | 결과 |
| --- | --- | --- |
| `windows.list` | 없음 | `[{window, title, project, key, ready}]`. `project`는 창에 마지막으로 열린 프로젝트의 루트 디렉터리이며 없으면 `null`이다. `ready`는 창의 메인 페이지가 준비를 알린 뒤 참이고 로드하는 동안 거짓이다. 페이지가 로드 중인 창에 대한 요청은 1003으로 실패한다 |
| `exposure.list` | `{window}` | `{status, commands, dom}`: 코어, 호스트, 로드된 플러그인의 선언 항목을 선언 형식으로 반환한다. 각 항목에 `registered`가 있다 |
| `status.get` | `{window, name, surface?}` | 현재 값 |
| `status.watch` | `{window, name, surface?}` | `null`. 이후 `status.unwatch`를 받거나 연결이 닫힐 때까지 값이 바뀔 때마다 호스트가 `status.changed` 알림 `{window, name, surface?, value}`를 보낸다. `surface` 값이 다른 감시는 서로 별개다 |
| `status.unwatch` | `{window, name, surface?}` | `null` |
| `command.run` | `{window, name, params, surface?}` | 명령 결과 |
| `dom.rect` | `{window, name, index?}` | 소유 문서의 CSS 픽셀 좌표 `{x, y, width, height}`와, 창 좌표로 나타낸 문서 원점 `{document}` |
| `dom.act` | `{window, name, index?, action, value?, event?}` | `null`. `action`은 `click`, `input`, `dispatch` 중 하나다. 페이지는 `isTrusted`가 false인 합성 DOM 이벤트를 받는다 |
| `input.pointer` | `{window, x, y, phase, button?, deltaX?, deltaY?, activate?}` | `null`. 창 좌표를 쓴다. `phase`는 `move`, `down`, `drag`, `up`, `scroll` 중 하나다. `button`은 `left`(기본값) 또는 `right`다. `deltaX`, `deltaY`는 포인트 단위 스크롤 거리다. `activate`는 `move`에 적용한다 |
| `input.key` | `{window, key, text?, modifiers?, phase}` | `null`. `key`는 키 이름(`Enter`, `Tab`, `Escape`, `Backspace`, `Delete`, `Space`, `ArrowLeft`, `ArrowRight`, `ArrowUp`, `ArrowDown`, `Home`, `End`, `PageUp`, `PageDown`) 또는 문자 하나다. `modifiers`는 `shift`, `control`, `option`, `command`의 배열이다. `phase`는 `down` 또는 `up`이다 |

네이티브 영역을 포함하는 hybrid 합성도 마운트된 플러그인 모듈은 모두 앱 DOM 문서를 공유한다. `dom.rect` 사각형은 이미 앱 문서 좌표를 사용하며 `document` 원점은 `{x: 0, y: 0}`이다. 이 원점에 표면 위치를 더하지 않는다. 네이티브 모달은 별도 문서이므로 사각형은 모달 내부 좌표를 유지하고 `document` 원점은 실제 모달 프레임 원점이다. 클라이언트는 보고된 문서 원점을 정확히 한 번 더하며 표면 종류나 카드 위치에 따라 보정하지 않는다.

호스트는 `input.pointer`와 `input.key`를 네이티브 이벤트로 전달하며 페이지는 신뢰 이벤트를 받는다. `activate: true`인 `move`를 제외하면 애플리케이션을 활성화하지 않는다. macOS에서는 다음과 같다.

- 키와 스크롤은 `-[NSWindow sendEvent:]`로 보낸다. AppKit은 비활성 창의 누름을 뷰에 전달하지 않으므로 누름·끌기·뗌은 좌표의 뷰에 보낸다.
- 웹뷰에 대한 `down`과 `up`은 그 웹뷰의 문서가 신뢰 `pointerdown` 또는 `pointerup`을 받은 뒤 반환한다. 페이지가 볼 수 없는 별도 WebKit content world의 스크립트가 수신을 알린다. 입력 칸에 초점이 있으면 WebKit은 마우스 이벤트를 먼저 입력기에 비동기로 넘기므로, 이렇게 하지 않으면 이어서 보낸 누름과 뗌이 문서에 반대 순서로 도착할 수 있다. 문서가 2초 안에 받지 않으면 1005를 반환한다. `scroll`은 좌표의 웹뷰가 현재 상태를 표시한 뒤 전달한다. WebKit은 스크롤 트리가 표시되기 전에 받은 휠 이벤트로 새 문서를 스크롤하지 않기 때문이다. 웹뷰가 2초 안에 표시하지 않으면 1005를 반환한다.
- WebKit은 창이 키 창일 때만 호버(`pointerover`, 버튼 없는 `pointermove`, `:hover`)를 갱신한다. 키 창이 아닌 창에 대한 `move`는 1006을 반환한다.
- WebKit은 마우스 이벤트의 눌린 버튼을 이벤트가 아니라 시스템(`+[NSEvent pressedMouseButtons]`)에서 읽는다. 실제 마우스 버튼이 눌린 동안 합성한 누름이나 뗌은 `pointerdown`이나 `pointerup` 대신 `pointermove`로 문서에 도달하므로, `down`이나 `up`을 전달하지 않고 1007을 반환한다.
- `activate: true`이면 호스트가 애플리케이션을 활성화하고 창을 키 창으로 만든 뒤, 창의 모든 웹뷰가 활성 상태를 웹 프로세스에 보낼 때까지 기다렸다가 이동을 전달한다. 사용자가 쓰고 있는 애플리케이션의 키보드 포커스를 가져온다. 활성화가 5초 안에 끝나지 않으면 멈춘 단계를 적은 1006을 반환한다. 단계는 시스템이 애플리케이션을 활성화하지 않음, 창이 키 창이 되지 않음, 웹뷰가 활성 상태를 반영하지 않음, 반영 전에 창이 활성 상태를 잃음이다. 웹뷰 단계를 뺀 메시지에는 최전면 애플리케이션을 적는다.
- OS 입력기는 활성 애플리케이션의 키 창에 있는 활성 입력 컨텍스트만 처리한다. 그 키 창이 아닌 창에 보낸 `input.key`는 입력기에 도달하지 않으므로 그 결과는 입력기 증거가 아니다. 문자 키를 입력 컨텍스트에 넘기는 뷰(예: 터미널 그림 영역)는 애플리케이션이 한 번 활성화된 뒤에는 그 키 창 밖에서 그 키의 문자를 받지 못한다. 입력 컨텍스트가 키를 받고 입력기가 답하지 않기 때문이다. 터미널 그림 영역은 이런 키를 오류 `input method did not answer native keyCode=<code> outside the key window of the active application`으로 보고한다. 영역이 직접 보고하는 이름 있는 키와 Control 또는 Option 조합은 어느 창에서나 전달된다. 터미널 문자 입력과 입력기 동작은 활성화 등급 검사로만 검증한다.

실제 입력 경로를 검사하는 테스트는 `input.pointer`와 `input.key`만 사용한다. 테스트는 상태 준비에만 `dom.act`를 사용한다.

## 전달

호스트와 페이지는 다음 메시지를 주고받는다. 이 메시지는 코어 내부용이며 엔드포인트에 포함되지 않는다.

| 방향 | 메시지 | 내용 |
| --- | --- | --- |
| 호스트 → 메인 페이지 | 이벤트 `exposure-request` | 코어와 플러그인 이름에 대한 `exposure.list`, `status.*`, `command.run`, `dom.*`의 `{id, method, params}`. 호스트는 답을 10초 기다린다. `command.run`은 예외이며, 메인 페이지가 전달한 명령의 제한 시간 안에 답한다. 준비되지 않은 메인 페이지는 1003을 반환하고, 다시 읽히거나 닫히는 메인 페이지에 보낸 요청은 1003으로 끝난다 |
| 메인 페이지 → 호스트 | 호출 `exposureReply` | `{id, result}` 또는 `{id, error: {code, message}}` |
| 메인 페이지 → 호스트 | 호출 `exposureChanged` | 감시 중인 상태의 `{name, surface?, value}`. 감시가 표면을 지정했으면 `surface`가 있다 |
| 표면 페이지 → 호스트 | 호출 `exposureRegister` | `{surface, kind, name}` |
| 호스트 → 메인 페이지 | 이벤트 `exposure-registered` | `{surface, kind, name}`. 표면이 제거되면 `{surface, closed: true}`. 표면은 메인 페이지를 다시 읽어도 남으므로 메인 페이지가 준비를 알린 뒤 호스트가 살아 있는 등록을 모두 다시 보낸다 |
| 메인 페이지 → 호스트 | 호출 `exposureForward` | 표면 페이지가 등록한 이름에 대한 `{id, surface, method, params, timeout?}`. `timeout`은 명령 선언에서 가져온 1 이상 600000 이하의 정수 밀리초이며, 없으면 호스트는 10초를 기다린다. `status.next`는 `timeout`을 받지 않는다. 올바르지 않은 `timeout`은 -32602를 반환한다 |
| 호스트 → 표면 페이지 | 이벤트 `exposure-request` | `{id, method, params}` |
| 표면 페이지 → 호스트 | 호출 `exposureReply` | `{id, result}` 또는 `{id, error}`. 호스트는 이 값을 `exposureForward`의 결과로 메인 페이지에 반환한다 |
| 메인 페이지 → 표면 페이지(`exposureForward` 경유) | `status.watch`, `status.unwatch` | `{name}`. 표면 페이지가 값 추적을 시작하거나 멈춘다 |
| 메인 페이지 → 표면 페이지(`exposureForward` 경유) | `status.next` | `{name, version}`. 표면 페이지는 값이 `version`보다 새로우면 `{version, value}`를, `status.unwatch` 뒤에는 `{closed: true}`를 응답한다. 호스트는 이 요청에 제한 시간을 두지 않으며, 표면이 닫히면 1003으로 실패한다 |
| 호스트 → 메인 페이지 | 이벤트 `diagnostics-tick` | 내용 없음. 진단 빌드에서만 `diagnostics.drag`의 단계마다 한 번 보낸다 |

메인 페이지는 이름을 등록하거나 전달하기 전에 선언과 대조해 검증한다. 불러온 배치에 아직 없는 표면의 등록은 보관했다가, 그 표면을 담은 배치를 불러오면 반영하거나 거부한다. 메인 페이지의 `exposureReply`는 호스트의 `exposure-request`에 대한 응답이고, 표면 페이지의 `exposureReply`는 전달된 요청에 대한 응답이다. 호스트는 호출한 웹뷰로 호출자를 구분한다.

런타임 모듈은 이 호출을 프레임워크 바인딩에 대응시킨다.

| 호출 | Wails 메서드 | Tauri 명령 |
| --- | --- | --- |
| `exposureReply` | `ExposureReply` | `exposure_reply` |
| `exposureChanged` | `ExposureChanged` | `exposure_changed` |
| `exposureForward` | `ExposureForward` | `exposure_forward` |
| `exposureRegister` | `ExposureRegister` (표면 브리지) | `exposure_register` |

표면 페이지의 페이지 인터페이스는 `page.exposure`이며 `register(kind, name)`, 전달된 요청마다 `fn({id, method, params})`를 호출하는 `onRequest(fn)`, `reply(id, payload)`로 구성된다. 메인 페이지는 `host.on("exposure-request", fn)`, `host.on("exposure-registered", fn)`, 그리고 위 호출을 담은 `host.call(...)`을 사용한다. `surface`가 없는 응답은 창의 메인 문서 요청에 대한 답이고, `surface`가 있는 응답은 그 표면 문서 요청에 대한 답이며 비어 있지 않은 문자열로 표면을 가리킨다. `surface`가 `null`, 빈 값, 문자열이 아니면 메인 문서 응답으로 처리하지 않고 오류로 거부한다.

## 오류

| 코드 | 의미 |
| --- | --- |
| -32601 | 선언되지 않은 메서드 |
| -32602 | 잘못된 매개변수 |
| 1001 | 알 수 없는 이름 |
| 1002 | 선언되었지만 등록되지 않은 이름 |
| 1003 | 소유 문서가 더 이상 없음 |
| 1004 | 이 플랫폼에서 네이티브 입력을 사용할 수 없음 |
| 1005 | 요청 시간 초과: 소유 문서가 10초 안에 응답하지 않음 |
| 1006 | 창이 활성 상태가 아님: 포인터 `move`에는 키 창이 필요하거나, 시스템이 애플리케이션을 활성화하지 않음 |
| 1007 | 실제 마우스 버튼이 눌려 있어 포인터 `down`이나 `up`을 전달하지 않음 |
| -32000 | 등록된 명령이나 status 처리기가 실패함. `message`는 그 오류 메시지다 |

[로컬 엔드포인트](endpoint.ko.md)는 선언되지 않은 메서드를 받으면 연결을 종료한다.
