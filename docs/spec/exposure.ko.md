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

## 메서드

클라이언트는 다음 JSON-RPC 2.0 메서드를 호출한다.

| 메서드 | 매개변수 | 결과 |
| --- | --- | --- |
| `exposure.list` | 없음 | 코어와 로드된 플러그인의 선언 항목 |
| `status.get` | `{name}` | 현재 값 |
| `status.watch` | `{name}` | `null`. 이후 `status.unwatch` 전까지 호스트가 `status.changed` 알림 `{name, value}`를 보낸다 |
| `status.unwatch` | `{name}` | `null` |
| `command.run` | `{name, params}` | 명령 결과 |
| `dom.rect` | `{name, index?}` | `{x, y, width, height, window}`: 소유 문서의 CSS 픽셀 좌표와, 창 좌표로 나타낸 문서 위치 |
| `dom.act` | `{name, index?, action, value?, event?}` | `null`. `action`은 `click`, `input`, `dispatch` 중 하나다. 페이지는 `isTrusted`가 false인 합성 DOM 이벤트를 받는다 |
| `input.pointer` | `{window, x, y, phase, button?, scroll?}` | `null`. `phase`는 `move`, `down`, `drag`, `up` 중 하나다 |
| `input.key` | `{window, key, text?, modifiers?, phase}` | `null`. `phase`는 `down` 또는 `up`이다 |
| `host.status` | `{window}` | 창 단추 프레임, 네이티브 뷰 프레임, 백킹 배율, 표시 상태 |

호스트는 `input.pointer`와 `input.key`를 네이티브 이벤트로 전달한다. macOS에서는 `-[NSWindow sendEvent:]`로 보내며, 페이지는 신뢰 이벤트를 받고 애플리케이션은 활성화되지 않는다.

실제 입력 경로를 검사하는 테스트는 `input.pointer`와 `input.key`만 사용한다. 테스트는 상태 준비에만 `dom.act`를 사용한다.

## 오류

| 코드 | 의미 |
| --- | --- |
| -32601 | 선언되지 않은 메서드 |
| -32602 | 잘못된 매개변수 |
| 1001 | 알 수 없는 이름 |
| 1002 | 선언되었지만 등록되지 않은 이름 |
| 1003 | 소유 문서가 더 이상 없음 |
| 1004 | 이 플랫폼에서 네이티브 입력을 사용할 수 없음 |

[로컬 엔드포인트](endpoint.ko.md)는 선언되지 않은 메서드를 받으면 연결을 종료한다.
