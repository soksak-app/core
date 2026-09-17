# 노출: status, command, dom

[English](exposure.md)

이 명세는 아직 구현되지 않았으며, [기능 상태](../features.ko.md)가 구현 여부를 기록한다.

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
| dom | `name` | 항목 이름 |
| dom | `description` | 한 문장 설명 |
| dom | `many` | 선택. 여러 요소가 같은 이름을 쓰면 `true`이며, 요청은 `index`로 요소 하나를 지정한다 |

스키마는 `type`, `properties`, `items`, `enum` 키워드만 쓰는 JSON Schema 부분집합이다.

dom 항목의 요소는 `data-expose="<이름>"` 속성을 가진다. `many`가 없으면 그 이름을 가진 요소는 정확히 하나다.

## 등록

워크벤치는 코어 항목을 메인 페이지의 등록소에 등록한다. 플러그인 표면 페이지는 `@soksak/plugin-api/page`로 항목을 등록한다.

| 함수 | 등록 대상 |
| --- | --- |
| `expose.status(name, read, subscribe)` | `read()`는 현재 값을 반환하고, `subscribe(fn)`은 값이 바뀔 때마다 `fn(value)`를 호출한다 |
| `expose.command(name, run)` | `run(params)`는 결과 또는 결과의 Promise를 반환한다 |
| `expose.dom(name, element)` | dom 항목의 요소 |

네이티브 호스트는 [사이드카](sidecars.ko.md) 메시지를 전달하는 방식과 같은 방식으로 표면 페이지와 메인 페이지 등록소 사이에서 등록과 요청을 전달한다. 표면 페이지가 닫히면 등록소는 그 페이지의 등록을 제거한다.

## 창

애플리케이션에는 창이 하나 이상 있고, 창마다 메인 페이지와 등록소가 따로 있다. `windows.list`를 제외한 모든 메서드는 `window`를 받는다. 이 값은 `windows.list`가 반환하는 식별자다. 더 이상 없는 창을 요청하면 오류 1003을 반환한다.

## 호스트 항목

네이티브 호스트는 같은 형식으로 소유자가 `host`인 항목을 선언하고 직접 처리한다.

| 종류 | 이름 | 의미 |
| --- | --- | --- |
| status | `host.window` | `{frame, content, scale, key, controls, surfaces, modal}`: 창 프레임, 콘텐츠 크기, 백킹 배율, 키 창 여부, 창 단추 프레임, 표시 여부와 레이어를 포함한 네이티브 표면 프레임, 열린 네이티브 모달 |
| command | `host.window.close` | 창의 일반 닫기 동작으로 창을 닫는다 |
| command | `host.window.maximize` | 창을 최대화한다. `{on: false}`이면 원래 크기로 되돌린다 |
| command | `host.window.resize` | 콘텐츠 영역 크기를 `{width, height}`로 바꾼다 |
| command | `host.window.reload` | 메인 페이지를 다시 로드한다 |
| command | `host.window.presented` | 메인 페이지와 표시 중인 애플리케이션 문서가 현재 배치를 화면에 표시한 뒤 완료된다 |
| command | `host.hit` | 창 좌표의 점 `{x, y}`를 소유한 대상을 반환한다: `{kind: "page"}`, `{kind: "surface", surface}`, 또는 `{kind: "native", identifier}` |
| command | `host.quit` | 대기 중인 저장을 포함한 일반 애플리케이션 종료를 요청한다 |

## 메서드

클라이언트는 다음 JSON-RPC 2.0 메서드를 호출한다.

| 메서드 | 매개변수 | 결과 |
| --- | --- | --- |
| `windows.list` | 없음 | `[{window, title, project, key}]` |
| `exposure.list` | `{window}` | 코어, 호스트, 로드된 플러그인의 선언 항목. 각 항목에 `registered`가 있다 |
| `status.get` | `{window, name}` | 현재 값 |
| `status.watch` | `{window, name}` | `null`. 이후 `status.unwatch`를 받거나 연결이 닫힐 때까지 값이 바뀔 때마다 호스트가 `status.changed` 알림 `{window, name, value}`를 보낸다 |
| `status.unwatch` | `{window, name}` | `null` |
| `command.run` | `{window, name, params}` | 명령 결과 |
| `dom.rect` | `{window, name, index?}` | 소유 문서의 CSS 픽셀 좌표 `{x, y, width, height}`와, 창 좌표로 나타낸 문서 원점 `{document}` |
| `dom.act` | `{window, name, index?, action, value?, event?}` | `null`. `action`은 `click`, `input`, `dispatch` 중 하나다. 페이지는 `isTrusted`가 false인 합성 DOM 이벤트를 받는다 |
| `input.pointer` | `{window, x, y, phase, button?, deltaX?, deltaY?}` | `null`. 창 좌표를 쓴다. `phase`는 `move`, `down`, `drag`, `up`, `scroll` 중 하나다 |
| `input.key` | `{window, key, text?, modifiers?, phase}` | `null`. `phase`는 `down` 또는 `up`이다 |

호스트는 `input.pointer`와 `input.key`를 네이티브 이벤트로 전달한다. macOS에서는 `-[NSWindow sendEvent:]`로 보내며, 페이지는 신뢰 이벤트를 받고 애플리케이션은 활성화되지 않는다.

실제 입력 경로를 검사하는 테스트는 `input.pointer`와 `input.key`만 사용한다. 테스트는 상태 준비에만 `dom.act`를 사용한다.

## 전달

호스트와 페이지는 다음 메시지를 주고받는다. 이 메시지는 코어 내부용이며 엔드포인트에 포함되지 않는다.

| 방향 | 메시지 | 내용 |
| --- | --- | --- |
| 호스트 → 메인 페이지 | 이벤트 `exposure-request` | 코어와 플러그인 이름에 대한 `exposure.list`, `status.*`, `command.run`, `dom.*`의 `{id, method, params}` |
| 메인 페이지 → 호스트 | 호출 `exposureReply` | `{id, result}` 또는 `{id, error: {code, message}}` |
| 메인 페이지 → 호스트 | 호출 `exposureChanged` | 감시 중인 상태의 `{name, value}` |
| 표면 페이지 → 호스트 | 호출 `exposureRegister` | `{surface, kind, name}` |
| 호스트 → 메인 페이지 | 이벤트 `exposure-registered` | `{surface, kind, name}`. 표면이 제거되면 `{surface, closed: true}` |
| 메인 페이지 → 호스트 | 호출 `exposureForward` | 표면 페이지가 등록한 이름에 대한 `{id, surface, method, params}` |
| 호스트 → 표면 페이지 | 이벤트 `exposure-request` | `{id, method, params}` |
| 표면 페이지 → 호스트 | 호출 `exposureReply` | `{id, result}` 또는 `{id, error}`. 호스트는 이 값을 `exposureForward`의 결과로 메인 페이지에 반환한다 |

메인 페이지는 이름을 등록하거나 전달하기 전에 선언과 대조해 검증한다. 메인 페이지의 `exposureReply`는 호스트의 `exposure-request`에 대한 응답이고, 표면 페이지의 `exposureReply`는 전달된 요청에 대한 응답이다. 호스트는 호출한 웹뷰로 호출자를 구분한다.

런타임 모듈은 이 호출을 프레임워크 바인딩에 대응시킨다.

| 호출 | Wails 메서드 | Tauri 명령 |
| --- | --- | --- |
| `exposureReply` | `ExposureReply` | `exposure_reply` |
| `exposureChanged` | `ExposureChanged` | `exposure_changed` |
| `exposureForward` | `ExposureForward` | `exposure_forward` |
| `exposureRegister` | `ExposureRegister` (표면 브리지) | `exposure_register` |

표면 페이지의 페이지 인터페이스는 `page.exposure`이며 `register(kind, name)`, 전달된 요청마다 `fn({id, method, params})`를 호출하는 `onRequest(fn)`, `reply(id, payload)`로 구성된다. 메인 페이지는 `host.on("exposure-request", fn)`, `host.on("exposure-registered", fn)`, 그리고 위 호출을 담은 `host.call(...)`을 사용한다.

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

[로컬 엔드포인트](endpoint.ko.md)는 선언되지 않은 메서드를 받으면 연결을 종료한다.
