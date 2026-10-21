# 선언된 UI

[English](declared-ui.md)

선언된 UI(declared UI)는 모든 요소가 이 문서의 어휘 요소 가운데 하나인 화면이다. plugin은 선언된 UI status의 값을 보내고, workbench는 그 값을 그린다. 이 문서는 값, 각 요소, 각 요소가 선언된 명령에 묶이는 방식, status가 그리기에 대응하는 방식, 수신자가 거부하는 것, 그리고 선언된 UI status에서 그리는 사이드바 section의 형태를 정한다. snapshot의 전달은 [plugin 프로세스](../plans/plugin-processes.ko.md) 규칙 2에 있다. 이름, 명령, DOM 규칙은 [노출](exposure.ko.md)에 있다. 텍스트 입력, 자유 DOM, canvas, 문서 영역이 있는 화면은 선언된 UI가 아니라 view다([plugin 프로세스](../plans/plugin-processes.ko.md)의 계층 규칙).

이 문서는 요소 그리기와 사이드바 section 그리기의 계약이다. [기능 상태](../features.ko.md)는 아직 구현하지 않은 부분을 나열한다.

## 선언된 status

plugin은 선언된 UI 값을 담는 status를 `plugin.json`의 `exposes.status`에 선언한다. 그 `schema`는 [노출](exposure.ko.md#항목-필드)이 받는 부분 집합이다.

```json
{"type": "object", "properties": {"elements": {"type": "array"}}}
```

이 부분 집합은 아래의 한도와 참조 규칙을 나타내지 못한다. 수신자는 그리기 전에 모든 snapshot에 이 규칙들을 적용하며, 규칙을 어기는 값은 [거부](#거부)에 적힌 대로 거부된다.

각 snapshot은 변경이 아니라 status의 전체 값을 싣는다. 받아들인 값마다 그 status가 그린 트리 전체를 대체한다.

## 루트

값은 `elements` 필드를 가진 객체이며, `elements`는 0개에서 64개 요소의 배열이다. 각 요소는 아래 요소 종류 가운데 하나를 고르는 `kind` 필드를 가진 객체다. 각 요소는 루트 요소들 사이에서 유일한 `key`를 가진다. 루트에서 다른 필드는 받지 않는다.

## 요소 종류

종류는 `list`, `tree`, `menu`, `command`, `status-line`이다. 각 객체는 그 종류가 나열한 필드만 받는다. 나열되지 않은 필드는 거부한다.

| 종류 | 필드 | 형 | 필수 | 한도와 뜻 |
| --- | --- | --- | --- | --- |
| `command` | `key` | 문자열 | 예 | 아래 키 규칙. `command`를 실행하는 버튼이다. |
| `command` | `label` | 문자열 | 예 | 평문, 500자 이하. |
| `command` | `command` | 문자열 | 예 | 선언된 명령 이름([묶기](#묶기)). |
| `command` | `params` | 객체 | 아니오 | 매개변수, [매개변수](#매개변수) 참조. |
| `command` | `icon` | 문자열 | 아니오 | core 아이콘 표(`packages/workbench/icons.js`)의 이름. |
| `command` | `enabled` | 불리언 | 아니오 | `false`이면 버튼을 끈다. 기본값 `true`. |
| `list` | `key` | 문자열 | 예 | 아래 키 규칙. |
| `list` | `label` | 문자열 | 아니오 | 평문, 500자 이하. |
| `list` | `items` | 배열 | 예 | 1000개 이하의 항목. 각 항목은 아래 필드를 가진다. |
| `list` 항목 | `key` | 문자열 | 예 | list 안에서 유일하다. |
| `list` 항목 | `label` | 문자열 | 예 | 평문, 500자 이하. |
| `list` 항목 | `command` | 문자열 | 아니오 | `command`가 있으면 항목은 버튼이다. 없으면 정적 행이다. |
| `list` 항목 | `params`, `icon`, `enabled` | `command`와 같음 | 아니오 | `command`와 같은 규칙. |
| `list` 항목 | `selected` | 불리언 | 아니오 | 항목을 선택된 것으로 그린다. 기본값 `false`. |
| `list` 항목 | `detail` | 문자열 | 아니오 | 평문, 500자 이하, label 뒤에 그린다. |
| `tree` | `key` | 문자열 | 예 | 아래 키 규칙. |
| `tree` | `label` | 문자열 | 아니오 | 평문, 500자 이하. |
| `tree` | `nodes` | 배열 | 예 | 루트 노드. 전체 트리에서 5000개 이하의 노드, 16단계 이하(루트 노드는 1단계). |
| `tree` 노드 | `key` | 문자열 | 예 | 형제 사이에서 유일하다. |
| `tree` 노드 | `label` | 문자열 | 예 | 평문, 500자 이하. |
| `tree` 노드 | `command`, `params`, `icon`, `enabled` | `command`와 같음 | 아니오 | `command`가 있는 노드는 label을 누르면 그 명령을 실행한다. |
| `tree` 노드 | `expanded` | 불리언 | 아니오 | workbench가 상태를 가지기 전 가지(branch)의 상태. 기본값 `false`. |
| `tree` 노드 | `children` | 배열 | 아니오 | 하위 노드. 같은 규칙을 따른다. `children`이 있는 노드는 가지다. |
| `menu` | `key` | 문자열 | 예 | 아래 키 규칙. |
| `menu` | `label` | 문자열 | 예 | 평문, 500자 이하. 메뉴를 여는 버튼의 이름이다. |
| `menu` | `items` | 배열 | 예 | 64개 이하의 항목. 각 항목은 `key`(menu 안에서 유일), `label`, `command`(필수), `params`, `icon`, `enabled`를 가지며 `command`와 같은 규칙을 따른다. |
| `status-line` | `key` | 문자열 | 예 | 아래 키 규칙. |
| `status-line` | `text` | 문자열 | 예 | 평문, 500자 이하. |
| `status-line` | `tone` | 문자열 | 아니오 | `neutral`(기본값) 또는 `busy`. |

키 규칙: 키는 `A-Z`, `a-z`, `0-9`, `.`, `_`, `:`, `-`로 이루어진 1자에서 128자의 문자열이다. 키는 정확한 문자열로 비교한다.

텍스트 규칙: 텍스트 필드는 평문이다. workbench는 그것을 마크업이 아니라 텍스트 내용으로 그린다. 제어 문자(U+0000에서 U+001F, 또는 U+007F)를 담은 텍스트 필드는 거부한다.

`status-line`의 tone에는 `error` 값이 없다. 오류는 응용 프로그램 로그에 기록하는 표시 경로([AGENTS](../../AGENTS.ko.md))를 거쳐야 사용자에게 보이므로, 선언된 요소는 오류를 그릴 수 없다.

`list`는 한 열의 행이다. `tree`는 들여쓴 개요다. `menu`는 명령 목록을 여는 버튼이다. `status-line`은 한 줄의 텍스트다. `command`는 한 개의 버튼이다.

## 아이콘

`icon` 필드는 core 아이콘 표의 이름을 받는다. 표에 없는 이름은 `unknown icon <name>`으로 거부한다. plugin은 아이콘 마크업을 공급할 수 없다.

## 매개변수

`params`는 최대 16개 키를 가진 JSON 객체다. 각 키는 64자 이하의 문자열이다. 각 값은 1000자 이하의 문자열, 유한한 숫자, 불리언, 또는 `null`이다. 배열, 객체, 그 밖의 값은 거부한다.

## 묶기

사용자가 조작할 수 있는 요소는 모두 선언된 명령에 묶인다. 묶기는 [사용자 인터페이스](exposure.ko.md#사용자-인터페이스) 규칙을 따른다. 요소는 `data-command`로 명령을 가리키고, 매개변수는 `data-params`에 두며, `@soksak/plugin-api`의 binder `bind(element, name, params, {event: "click"})`로 연결한다.

선언된 UI 요소는 다음 명령에 묶인다.

| 요소 | 명령 | 매개변수 |
| --- | --- | --- |
| `command` | 그 `command` 필드 | 그 `params` 필드 |
| `command`가 있는 `list` 항목 | 그 `command` 필드 | 그 `params` 필드 |
| `command`가 있는 `tree` 노드 | 그 `command` 필드 | 그 `params` 필드 |
| `tree` 가지의 펼침 제어 | `core.declared-ui.tree.toggle` | `{status, tree, node}` |
| `menu` 버튼 | `core.declared-ui.menu.toggle` | `{status, menu}` |
| `menu` 항목 | 그 `command` 필드 | 그 `params` 필드 |
| 사이드바 section 머리 | `core.sidebar.section.fold` | `{sidebar, section}` |

선언된 UI 값의 명령 이름은 `<owner>.<name>`이다. owner는 status의 plugin 또는 `core`다. plugin은 자기 명령과 core 명령만 이름으로 지정할 수 있다. 선언되지 않은 이름은 사용자가 요소를 누를 때가 아니라 snapshot을 받을 때 거부한다. binder가 표시 시점에 선언되지 않은 이름을 거부하기 때문이다([노출](exposure.ko.md#사용자-인터페이스)).

core 명령 `core.declared-ui.tree.toggle`과 `core.declared-ui.menu.toggle`은 `packages/workbench/exposure.json`에 선언한다. 펼침이나 열림 상태는 문서 조작이므로 다른 조작과 같이 선언된 명령을 실행한다.

비활성 요소(`enabled: false`)는 `disabled` 속성으로 그려지므로 어떤 클릭도 그 묶기에 닿지 않는다.

DOM 이름. 조작할 수 있는 각 요소는 그 종류의 DOM 이름을 `data-expose`로 가진다. 이름은 core 선언이며 `many` 플래그를 가지고, `packages/workbench/exposure.json`에 있다.

| 요소 | DOM 이름 |
| --- | --- |
| `command` | `core.declared-ui.command` |
| `command`가 있는 `list` 항목 | `core.declared-ui.list-item` |
| `tree` 노드 | `core.declared-ui.tree-node` |
| `tree` 가지의 펼침 제어 | `core.declared-ui.tree-toggle` |
| `menu` 버튼 | `core.declared-ui.menu` |
| `menu` 항목 | `core.declared-ui.menu-item` |
| 사이드바 section 머리 | `core.declared-ui.section-header` |

DOM 이름이 붙은 각 요소는 `data-key`에 자기 `key`를 가져서, 외부 요청이 key로 그 요소를 지정할 수 있다.

키보드 조작은 네이티브 `button` 요소를 쓰므로, Enter와 Space가 같은 묶기를 거쳐 명령에 닿는다. 선언된 UI 요소는 자기 키 처리기를 가지지 않는다.

## status 대응

선언된 UI status는 snapshot을 거쳐 다음과 같이 그려진다.

- 받아들인 snapshot마다 그 status의 트리를 대체한다. 요소는 key로만 맞춰서 workbench 상태를 유지한다.
- workbench는 status와 요소 key마다 트리 가지의 상태(펼침 또는 접힘)와 메뉴의 상태(열림 또는 닫힘)를 유지한다. 상태는 snapshot에 그 key가 있는 동안 유지되고, 받아들인 snapshot에 그 key가 없으면 지운다.
- `expanded`와 `selected` 필드는 plugin이 보낸 값이다. 유지된 상태가 있는 가지는 그 상태를 유지하고, `expanded`는 유지된 상태가 없는 가지에만 적용한다.
- section은 plugin 문맥의 status 추적([plugin](plugins.ko.md#섹션))으로 자기 status를 읽는다. 첫 snapshot을 받아들이기 전까지 section 본문은 비어 있다.
- 선언된 UI 값은 변경 흐름이 아니다. plugin은 어떤 요소가 바뀌어도 값 전체를 다시 보낸다.

## 거부

수신자는 그리기 전에 snapshot 값 전체를 검사한다. 이 문서의 규칙을 하나라도 어기는 값은 전체를 거부한다. 그 값의 어떤 요소도 그리지 않으며, 그 status의 이전 트리는 지운다. 수신자는 여전히 snapshot에 응답한다. 응답은 수신 확인이지 유효성 확인이 아니기 때문이다.

거부한 값은 표시 경로를 거쳐 응용 프로그램 로그에 `error: declared UI <owner>.<status>: <JSON 포인터>: <이유>` 줄을 쓰고, 사이드바 section은 오류 상태에서 같은 텍스트를 보인다. section은 다음 받아들인 값이 올 때까지 오류를 보인다.

수신자가 거부하는 이유는 다음과 같다.

| 조건 | 이유 |
| --- | --- |
| 루트가 객체가 아니거나 `elements`가 배열이 아님 | `elements must be an array` |
| 루트 요소 64개, list 항목 1000개, menu 항목 64개, tree 노드 5000개, tree 단계 16을 넘음 | `<field> exceeds <limit>` |
| 종류가 나열하지 않은 필드 | `unknown field <name>` |
| 필수 필드가 없음 | `missing <field>` |
| 표에 없는 `kind` 값 | `unknown kind <value>` |
| 필드의 형이 맞지 않음 | `<field> must be <type>` |
| 텍스트 필드가 한도를 넘음 | `<field> exceeds 500 characters` |
| 텍스트 필드에 제어 문자가 있음 | `<field> contains a control character` |
| 키가 키 규칙에 맞지 않음 | `key must be 1 to 128 characters of A-Z, a-z, 0-9, ., _, : or -` |
| 형제 사이, 또는 list나 menu의 항목 사이에 같은 키가 있음 | `duplicate key <key>` |
| `kind`가 `status-line`이고 tone이 `neutral`이나 `busy`가 아님 | `tone must be neutral or busy` |
| 명령 이름이 owner가 plugin이나 `core`인 `<owner>.<name>` 형식이 아님 | `command <name> must be named <owner>.<name>` |
| 명령 이름이 선언되지 않음 | `undeclared command <name>` |
| `params`가 허용된 값의 객체가 아니거나 16개 키를 넘음 | `params must be an object of at most 16 scalar values` |
| 아이콘 이름이 core 아이콘 표에 없음 | `unknown icon <name>` |
| 직렬화한 값이 1048576바이트보다 큼 | `value exceeds 1048576 bytes` |

JSON 포인터는 실패한 필드를 가리킨다. 예: `/elements/2/items/7/key`.

## 사이드바 section 형태

사이드바 section은 `plugin.json`에서 `module` 또는 `status`로 선언한다([plugin](plugins.ko.md#섹션)). 둘 중 정확히 하나만 받는다.

- `module`을 가진 section은 지금처럼 그 모듈이 그린다. workbench는 모듈을 적재하고 section 요소에서 `mount(root, context)`를 부른다.
- `status`를 가진 section은 그 status의 선언된 UI 값으로 그린다. status는 같은 plugin의 status이어야 하며, `exposes.status`가 선언된 UI 스키마로 선언해야 한다. section은 모듈이 없고 `mount` 호출이 없으며 `context.status`와 `context.bind`도 없다. 요소는 이 문서의 규칙으로 묶인다.
- 두 필드가 모두 있거나 둘 다 없는 section은 `section <id> declares both module and status` 또는 `section <id> declares neither module nor status`로 거부한다. plugin의 status가 아닌 `status`는 `section <id> status <name> is not a status of plugin <plugin>`으로 거부한다.

선언된 section은 루트 요소를 본문 안에 순서대로 그린다. 사이드바의 방향에 맞는 배치를 쓴다. 세로 방향에서는 요소를 위에서 아래로 쌓는다. 가로 방향에서는 요소를 왼쪽에서 오른쪽으로 한 행에 놓고, section 너비에서 줄바꿈한다.

선언된 section은 사이드바 section의 머리, 접기 제어, 탭 선택을 바꾸지 않고 유지한다. 머리는 `core.declared-ui.section-header` 요소이며, 접으면 `core.sidebar.section.fold`를 실행한다. 선언된 section의 묶음은 [plugin](plugins.ko.md#섹션)의 묶음 규칙을 따른다.

적재되지 않은 plugin의 section은 다른 section과 같이 그리지 않는다.

## 지금 section이 그리는 것

지금 section은 JavaScript 모듈이다. workbench는 그 모듈을 section 요소에 올리며, 문맥으로 `card`, `surface`, `orientation`, core `icon` 함수, plugin의 status를 위한 `status(name, fn)`, 명령을 위한 `bind(el, name, params, options)`를 준다. 모듈은 자기 DOM을 그리므로 workbench는 그 요소와 이름을 검사하지 못한다. 선언된 section은 이 모듈을 위의 어휘로 바꾸며, 그 어휘는 workbench가 검사하고 그린다.

## 한도

| 한도 | 값 |
| --- | --- |
| 직렬화한 값 | 1048576바이트 |
| 루트 요소 | 64 |
| list 항목 | list마다 1000 |
| tree 노드 | tree마다 5000 |
| tree 단계 | 16 |
| menu 항목 | menu마다 64 |
| 텍스트 필드 | 500자 |
| 키 | 128자 |
| 매개변수 | 객체마다 16개 키, 키마다 64자, 문자열 값마다 1000자 |

각 한도는 받을 때 검사한다. 한도를 넘는 값은 잘라내지 않고 거부한다.

## 용어

용어는 [용어 목록](terms.ko.md)에 있다. 선언된 UI, 선언된 UI snapshot, 선언된 요소, 선언된 status line, 선언된 UI 스키마다.
