# 선언된 UI

[English](declared-ui.md)

선언된 UI(declared UI)는 모든 요소가 이 문서의 어휘 요소 가운데 하나인 사이드바 section이다. plugin은 선언된 UI status의 값을 보내고, workbench는 그 값을 그린다. 이 문서는 값, 각 요소, 각 요소가 선언된 명령에 묶이는 방식, status가 그리기에 대응하는 방식, 수신자가 거부하는 것, 그리고 선언된 UI status에서 그리는 사이드바 section의 형태를 정한다.

## 범위

- 어휘는 네 요소 `list`, `tree`, `command`, `status-line`이다. core는 다른 요소를 선언하지 않는다. 텍스트 입력, 자유 DOM, canvas, 문서 영역, 이미지 영역이 있는 화면은 view다([plugin 프로세스](../plans/plugin-processes.ko.md)의 계층 규칙). 인라인 이름 바꾸기, 끌어 놓기, 포인터 위치에 놓는 문맥 메뉴가 필요한 tree도 같은 이유로 view다. core는 그런 상호작용의 요소를 선언하지 않는다.
- 이 버전에서 workbench는 사이드바 section에서만 선언된 UI를 그린다. 카드와 다른 화면은 선언된 UI를 그리지 않는다.
- plugin의 저장소가 그 plugin의 각 surface를 선언된 UI 또는 view로 선언한다. core는 plugin의 surface를 분류하지 않는다.
- snapshot의 전달은 [plugin 프로세스](../plans/plugin-processes.ko.md) 규칙 2에 있다. 이름, 명령, DOM 규칙은 [노출](exposure.ko.md)에 있다. 사이드바 배치는 [plugin](plugins.ko.md#섹션)에 있다.
- 접근성: 선언된 UI에 대해 접근성 주장은 하지 않는다. F212.12가 플랫폼 인터페이스를 기록할 때까지 그렇다([plugin 프로세스](../plans/plugin-processes.ko.md) 규칙 8). 이 문서는 ARIA 역할을 정의하지 않는다.
- core는 값을 자르지 않는다. 요소가 한도보다 많은 plugin은 자기 값을 스스로 자르고 자른 사실을 `status-line`에 적는다. 한도를 넘는 값은 줄이지 않고 거부한다. 이 버전에는 지연 적재가 없다.

## 선언된 status

plugin은 선언된 UI 값을 담는 status를 `plugin.json`의 `exposes.status`에 선언한다. 그 `schema`는 [노출](exposure.ko.md#항목-필드)이 받는 부분 집합이다.

```json
{"type": "object", "properties": {"elements": {"type": "array"}}}
```

이 부분 집합은 아래의 한도와 참조 규칙을 나타내지 못한다. 수신자는 그리기 전에 모든 snapshot에 이 규칙들을 적용한다.

각 snapshot은 변경이 아니라 status의 전체 값을 싣는다. 받아들인 값마다 그 status가 그린 트리 전체를 대체한다.

## 루트

값은 `elements` 필드를 가진 객체이며, `elements`는 0개에서 64개 요소의 배열이다. 각 요소는 아래 요소 종류 가운데 하나를 고르는 `kind` 필드를 가진 객체다. 각 요소는 루트 요소들 사이에서 유일한 `key`를 가진다. 루트에서 다른 필드는 받지 않는다.

## 요소 종류

종류는 `list`, `tree`, `command`, `status-line`이다. 각 객체는 그 종류가 나열한 필드만 받는다. 나열되지 않은 필드는 거부한다.

| 종류 | 필드 | 형 | 필수 | 한도와 뜻 |
| --- | --- | --- | --- | --- |
| `command` | `key` | 문자열 | 예 | 아래 키 규칙. `command`를 실행하는 버튼이다. |
| `command` | `label` | 문자열 | 예 | 평문, 500자 이하. |
| `command` | `command` | 문자열 | 예 | 선언된 명령 이름([묶기](#묶기)). |
| `command` | `params` | 객체 | 아니오 | 매개변수, [매개변수](#매개변수) 참조. |
| `command` | `icon` | 문자열 | 아니오 | core 아이콘 표(`packages/workbench/icons.js`)의 이름. |
| `command` | `enabled` | 불리언 | 아니오 | `false`이면 버튼을 끈다. 기본값 `true`. |
| `list` | `key` | 문자열 | 예 | 아래 키 규칙. |
| `list` | `empty` | 문자열 | 예 | 평문, 500자 이하. `items`가 비었을 때 행 대신 그린다. 모든 list는 빈 상태를 말한다. [plugin](plugins.ko.md#섹션)이 모든 list에 요구하는 규칙이다. |
| `list` | `items` | 배열 | 예 | 1000개 이하의 항목. 각 항목은 아래 필드를 가진다. |
| `list` 항목 | `key` | 문자열 | 예 | list 안에서 유일하다. |
| `list` 항목 | `label` | 문자열 | 예 | 평문, 500자 이하. |
| `list` 항목 | `command` | 문자열 | 아니오 | `command`가 있으면 항목은 버튼이다. 없으면 정적 행이다. |
| `list` 항목 | `params`, `icon`, `enabled` | `command`와 같음 | 아니오 | `command`와 같은 규칙. |
| `list` 항목 | `selected` | 불리언 | 아니오 | 항목을 선택된 것으로 그린다. 기본값 `false`. 이 값에 대해 workbench 상태를 유지하지 않는다. |
| `list` 항목 | `detail` | 문자열 | 아니오 | 평문, 500자 이하, label 뒤에 그린다. |
| `tree` | `key` | 문자열 | 예 | 아래 키 규칙. |
| `tree` | `nodes` | 배열 | 예 | 루트 노드. 전체 트리에서 5000개 이하의 노드, 16단계 이하(루트 노드는 1단계). 가로 section에서는 tree를 그리지 않는다([사이드바 section 형태](#사이드바-section-형태)). |
| `tree` 노드 | `key` | 문자열 | 예 | 형제 사이에서 유일하다. |
| `tree` 노드 | `label` | 문자열 | 예 | 평문, 500자 이하. |
| `tree` 노드 | `command`, `params`, `icon`, `enabled` | `command`와 같음 | 아니오 | `command`가 있는 노드는 label을 누르면 그 명령을 실행한다. |
| `tree` 노드 | `expanded` | 불리언 | 아니오 | 가지에 대한 plugin의 값. 기본값 `false`. [status 대응](#status-대응)이 우선순위를 정한다. |
| `tree` 노드 | `selected` | 불리언 | 아니오 | 노드를 선택된 것으로 그린다. 기본값 `false`. plugin의 값은 받아들인 모든 값에 적용된다. |
| `tree` 노드 | `children` | 배열 | 아니오 | 하위 노드. 같은 규칙을 따른다. `children`이 있는 노드는 가지다. |
| `status-line` | `key` | 문자열 | 예 | 아래 키 규칙. |
| `status-line` | `text` | 문자열 | 예 | 평문, 500자 이하. 한 줄로 그린다. |

키 규칙: 키는 `A-Z`, `a-z`, `0-9`, `.`, `_`, `:`, `-`로 이루어진 1자에서 128자의 문자열이다. 키는 정확한 문자열로 비교한다.

텍스트 규칙: 텍스트 필드는 평문이다. workbench는 그것을 마크업이 아니라 텍스트 내용으로 그린다. 제어 문자(U+0000에서 U+001F, 또는 U+007F)를 담은 텍스트 필드는 거부한다.

`status-line`에는 tone과 오류 값이 없다. 오류는 응용 프로그램 로그에 기록하는 표시 경로([AGENTS](../../AGENTS.ko.md))를 거쳐야 사용자에게 보이므로, 선언된 요소는 오류를 그릴 수 없다.

`list`는 행의 열이며, 행이 없으면 `empty` 텍스트를 그린다. `tree`는 들여쓴 개요다. `command`는 한 개의 버튼이다. `status-line`은 한 줄의 텍스트다.

## 한도

각 한도는 이 문서가 선택한 값이다. 그 이유는 main page가 snapshot 하나에 하는 일이다. 값을 UI thread에서 파싱하고 검사하고 그리며, 그린 트리를 모두 문서에 둔다. list 항목과 tree 노드의 한도는 workbench에서 측정한 tree 노드 5000개와 list 항목 1000개의 그리기 시간으로 확정 전에 고친다.

| 한도 | 값 | 이유 |
| --- | --- | --- |
| 직렬화한 값 | 1048576바이트 | snapshot마다 값 전체를 UI thread에서 파싱하고 검사한다. |
| 루트 요소 | 64 | section 본문 하나가 담는 별도 블록의 수다. |
| list 항목 | list마다 1000 | list 하나가 snapshot마다 그리는 행을 제한한다. 그리기 시간 측정으로 고친다. |
| tree 노드 | tree마다 5000 | tree 하나가 snapshot마다 그리는 노드를 제한한다. 그리기 시간 측정으로 고친다. |
| tree 단계 | 16 | section 안에서 tree의 들여쓰기를 제한한다. |
| 텍스트 필드 | 500자 | section 안 텍스트 한 줄의 너비를 제한한다. |
| 키 | 128자 | workbench가 요소마다 보관하는 식별자를 제한한다. |
| 매개변수 | 객체마다 16개 키, 키마다 64자, 문자열 값마다 1000자 | 묶기마다 보관하는 매개변수 기록을 제한한다. |

각 한도는 받을 때 검사한다. 한도를 넘는 값은 잘라내지 않고 거부한다.

## 아이콘

`icon` 필드는 core 아이콘 표의 이름을 받는다. 표에 없는 이름은 `unknown icon <name>`으로 거부한다. plugin은 아이콘 마크업을 공급할 수 없다.

## 매개변수

선언된 요소의 `params`는 최대 16개 키를 가진 JSON 객체다. 각 키는 64자 이하의 문자열이다. 각 값은 1000자 이하의 문자열, 유한한 숫자, 불리언, 또는 `null`이다. 배열, 객체, 그 밖의 값은 거부한다. 매개변수의 유일한 배열은 `core.declared-ui.tree.expand`의 `path`이며, workbench가 그 제어에 설정하고 plugin 값은 담을 수 없다.

## 묶기

사용자가 조작할 수 있는 요소는 모두 선언된 명령에 묶인다. 묶기는 [사용자 인터페이스](exposure.ko.md#사용자-인터페이스) 규칙을 따른다. 요소는 `data-command`로 명령을 가리키고, 매개변수는 `data-params`에 두며, `@soksak/plugin-api`의 binder `bind(element, name, params, {event: "click"})`로 연결한다.

선언된 UI 요소는 다음 명령에 묶인다.

| 요소 | 명령 | 매개변수 |
| --- | --- | --- |
| `command` | 그 `command` 필드 | 그 `params` 필드 |
| `command`가 있는 `list` 항목 | 그 `command` 필드 | 그 `params` 필드 |
| `command`가 있는 `tree` 노드 | 그 `command` 필드 | 그 `params` 필드 |
| `tree` 가지의 펼침 제어 | `core.declared-ui.tree.expand` | `{status, tree, path, expanded}` |
| 사이드바 section 머리 | `core.sidebar.section.fold` | `{sidebar, section}` |

선언된 UI 값의 명령 이름은 `<owner>.<name>`이다. owner는 status의 plugin 또는 `core`다. plugin은 자기 명령과 core 명령만 이름으로 지정할 수 있다. 선언되지 않은 이름은 사용자가 요소를 누를 때가 아니라 snapshot을 받을 때 거부한다. binder가 표시 시점에 선언되지 않은 이름을 거부하기 때문이다([노출](exposure.ko.md#사용자-인터페이스)).

`core.declared-ui.tree.expand`는 `packages/workbench/exposure.json`에 선언한다. 이 명령은 설정 연산이다. 같은 인수로 다시 실행해도 한 번 실행한 것과 같은 결과다. `expanded` 인수는 제어가 요청하는 상태이며, 그릴 때 가지가 보이던 상태의 반대다. 명령은 `status`의 트리 `tree`에서 `path`에 있는 가지의 유지 상태를 설정하며, plugin에는 전달하지 않는다. `path`는 루트 노드에서 가지까지의 노드 key 배열이다. 그려진 가지가 없는 `path`, 또는 그려지지 않은 `status`나 `tree`는 `tree <tree> path <path> is not drawn`으로 명령을 실패시킨다.

비활성 요소(`enabled: false`)는 `disabled` 속성으로 그려지므로 어떤 클릭도 그 묶기에 닿지 않는다.

DOM 이름. 선언된 UI 값이 그리는 조작 가능한 요소는 모두 DOM 이름 `core.sidebar.section.control`과, 자기 `key`를 담은 속성 `data-key`를 가진다. section 머리는 `core.sidebar.section.header`를 가진다([plugin](plugins.ko.md#섹션)). 사이드바가 이미 쓰는 이름이므로, 선언된 section과 모듈 section은 같은 방식으로 감사된다. 선언된 요소는 자기 종류의 DOM 이름을 따로 갖지 않는다. 종류는 값에 있다.

키보드 조작은 네이티브 `button` 요소를 쓰므로, Enter와 Space가 같은 묶기를 거쳐 명령에 닿는다. 선언된 UI 요소는 자기 키 처리기를 가지지 않는다.

## status 대응

선언된 UI status는 snapshot을 거쳐 다음과 같이 그려진다.

- 받아들인 snapshot마다 그 status의 트리를 대체한다. 요소는 루트부터의 key 경로로 맞춰서 workbench 상태를 유지한다.
- workbench는 status, tree key, 루트부터의 노드 key 경로로 가지마다 펼침 상태를 보관한다. 유지된 상태는 `core.declared-ui.tree.expand`로만 설정된다.
- 받아들인 값에서, 이전에 받아들인 값의 `expanded`와 다르거나 새로운 가지는 plugin의 값을 받고, 유지된 상태를 그 값으로 바꾼다. `expanded`가 바뀌지 않은 가지는 유지된 상태를 그대로 둔다. 유지된 상태가 없는 새 가지는 plugin의 값을 받는다.
- `selected`에는 유지된 상태가 없다. 이를 바꾸는 core 명령이 없으므로, plugin의 값이 받아들인 모든 값에 적용된다.
- 유지된 상태는 받아들인 값에 그 경로가 없을 때, 그리고 plugin 프로세스가 다시 시작할 때 지운다. workbench는 plugin 재시작 때 이전 프로세스의 snapshot에 대해 [plugin 프로세스](../plans/plugin-processes.ko.md) 규칙 2가 하는 것처럼 유지된 상태를 버린다.
- 유지된 상태는 공간이나 프로젝트에 저장하지 않는다. main page를 다시 불러오면 plugin의 값으로 되돌아간다.
- section은 plugin 문맥의 status 추적([plugin](plugins.ko.md#섹션))으로 자기 status를 읽는다. 첫 snapshot을 받아들이기 전까지 section 본문은 비어 있다.
- 선언된 UI 값은 변경 흐름이 아니다. plugin은 어떤 요소가 바뀌어도 값 전체를 다시 보낸다.

## 사이드바 section 형태

사이드바 section은 `plugin.json`에서 `module` 또는 `status`로 선언한다([plugin](plugins.ko.md#섹션)). 둘 중 정확히 하나만 받는다. 선언된 section은 `id`, `name`, `status`, 선택 필드 `fill`을 가진다. `fill: true`는 [plugin](plugins.ko.md#섹션)이 모듈 section에 주는 뜻과 같다. 펼친 section은 다른 section이 남긴 사이드바 높이를 나누어 갖고, 본문은 그 안에서 스크롤한다.

- `module`을 가진 section은 지금처럼 그 모듈이 그린다. workbench는 모듈을 적재하고 section 요소에서 `mount(root, context)`를 부른다.
- `status`를 가진 section은 그 status의 선언된 UI 값으로 그린다. status는 같은 plugin의 status이어야 하며, `exposes.status`가 선언된 UI 스키마로 선언해야 한다. section은 모듈이 없고 `mount` 호출이 없으며 `context.status`와 `context.bind`도 없다.
- 두 필드가 모두 있거나 둘 다 없는 section은 `section <id> declares both module and status` 또는 `section <id> declares neither module nor status`로 거부한다. plugin의 status가 아닌 `status`는 `section <id> status <name> is not a status of plugin <plugin>`으로 거부한다.

선언된 section은 루트 요소를 본문 안에 순서대로 그린다.

- 세로 방향에서는 요소를 위에서 아래로 쌓는다.
- 가로 방향에서는 요소를 왼쪽에서 오른쪽으로 한 행에 놓고, section 너비에서 줄바꿈한다. 가로 section의 `tree`는 값 전체를 `tree <key> cannot be drawn in a horizontal section`으로 거부한다. 행에서는 tree의 들여쓰기가 성립하지 않기 때문이다.

선언된 section은 사이드바 section의 머리, 접기 제어, 탭 선택을 바꾸지 않고 유지한다. 머리는 `core.sidebar.section.header`이며, 접으면 `core.sidebar.section.fold`를 실행한다. 선언된 section의 묶음은 [plugin](plugins.ko.md#섹션)의 묶음 규칙을 따른다. 적재되지 않은 plugin의 section은 다른 section과 같이 그리지 않는다.

`core.sidebars` status는 section마다 본문의 DOM 이름 `core.sidebar.section.control` 요소, 즉 선언된 값의 조작 가능한 요소를 센다. section 머리는 자기 요소로 센다. 그 `mounted` 필드는 section이 그리는 첫 받아들인 값부터 section이 비워질 때까지 true이고, 그 전에는 false다. `error` 필드는 현재 거부의 텍스트이며, 마지막 값을 받아들였으면 null이다. `text` 필드는 본문의 텍스트다.

## 거부

수신자는 그리기 전에 snapshot 값 전체를 검사한다. 이 문서의 규칙을 하나라도 어기는 값은 전체를 거부한다. 그 값의 어떤 요소도 그리지 않으며, 그 status의 이전 트리는 지운다. 거부 때 이전 트리를 남기지 않는다. 남긴 트리는 plugin이 더 이상 현재 값으로 보내지 않는 값을 보이기 때문이다.

수신자는 snapshot에 응답한다. 응답은 수신 확인이지 유효성 확인이 아니므로, plugin은 거부 신호를 받지 않는다. 거부는 section에서만 보인다.

표시 경로는 `showError(element, where, text)`다. 거부한 값에서 `where`는 `declared UI <owner>.<status>`이고 `text`는 `<JSON 포인터>: <이유>`다. section 본문이 `showError`가 보이는 요소이므로, section의 텍스트가 거부의 표시다. 같은 호출이 쓰는 응용 프로그램 로그 줄이 기록이다: `error: declared UI <owner>.<status>: <JSON 포인터>: <이유>`. section은 같은 오류를 두 번째 표시로 보이지 않는다.

`showError`는 같은 `where`와 같은 `text`에 대해 로그 줄을 한 번만 쓴다. 보이는 텍스트를 유지하므로, 같은 텍스트의 거부가 반복되면 같은 텍스트를 보이고 아무것도 더 쓰지 않는다. 다른 텍스트의 거부는 자기 줄을 쓴다. status의 다음 받아들인 값은 그 `where`에 대해 `hideError`를 부른다. 이는 표시를 거두므로, 그 뒤에 같은 텍스트가 다시 나오면 다시 쓴다.

수신자가 거부하는 이유는 다음과 같다.

| 조건 | 이유 |
| --- | --- |
| 루트가 객체가 아니거나 `elements`가 배열이 아님 | `elements must be an array` |
| 루트 요소 64개, list 항목 1000개, tree 노드 5000개, tree 단계 16을 넘음 | `<field> exceeds <limit>` |
| 종류가 나열하지 않은 필드 | `unknown field <name>` |
| 필수 필드가 없음 | `missing <field>` |
| 표에 없는 `kind` 값 | `unknown kind <value>` |
| 필드의 형이 맞지 않음 | `<field> must be <type>` |
| 텍스트 필드가 한도를 넘음 | `<field> exceeds 500 characters` |
| 텍스트 필드에 제어 문자가 있음 | `<field> contains a control character` |
| 키가 키 규칙에 맞지 않음 | `key must be 1 to 128 characters of A-Z, a-z, 0-9, ., _, : or -` |
| 형제 사이, 또는 list의 항목 사이에 같은 키가 있음 | `duplicate key <key>` |
| 명령 이름이 owner가 plugin이나 `core`인 `<owner>.<name>` 형식이 아님 | `command <name> must be named <owner>.<name>` |
| 명령 이름이 선언되지 않음 | `undeclared command <name>` |
| `params`가 허용된 값의 객체가 아니거나 16개 키를 넘음 | `params must be an object of at most 16 scalar values` |
| 아이콘 이름이 core 아이콘 표에 없음 | `unknown icon <name>` |
| 가로 section의 `tree` | `tree <key> cannot be drawn in a horizontal section` |
| 직렬화한 값이 1048576바이트보다 큼 | `value exceeds 1048576 bytes` |

JSON 포인터는 실패한 필드를 가리킨다. 예: `/elements/2/items/7/key`.

## 지금 section이 그리는 것

지금 section은 JavaScript 모듈이다. workbench는 그 모듈을 section 요소에 올리며, 문맥으로 `card`, `surface`, `orientation`, core `icon` 함수, plugin의 status를 위한 `status(name, fn)`, 명령을 위한 `bind(el, name, params, options)`를 준다. 모듈은 자기 DOM을 그리므로 workbench는 그 요소와 이름을 검사하지 못한다. 선언된 section은 이 모듈을 위의 어휘로 바꾸며, 그 어휘는 workbench가 검사하고 그린다.

## 용어

용어는 [용어 목록](terms.ko.md)에 있다. 선언된 UI, 선언된 UI snapshot, 선언된 요소, 선언된 status line, 선언된 UI 스키마다.
