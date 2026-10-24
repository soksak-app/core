# 선언된 UI

[English](declared-ui.md)

선언된 UI(declared UI)는 모든 요소가 이 문서의 어휘 요소 가운데 하나인 사이드바 section이다. plugin은 선언된 UI status의 값을 보내고, workbench는 그 값을 그린다. 이 문서는 값, 각 요소, 각 요소가 선언된 명령에 묶이는 방식, status가 그리기에 대응하는 방식, 수신자가 거부하는 것, 그리고 선언된 UI status에서 그리는 사이드바 section의 형태를 정한다.

## 범위

- 어휘는 네 요소 `list`, `tree`, `button`, `status-line`이다. core는 다른 요소를 선언하지 않는다. 텍스트 입력, 자유 DOM, canvas, 문서 영역, 이미지 영역이 있는 화면은 view다. 인라인 이름 바꾸기, 끌어 놓기, 포인터 위치에 놓는 문맥 메뉴가 필요한 tree도 같은 이유로 view다. core는 그런 상호작용의 요소를 선언하지 않는다.
- workbench는 사이드바 section에서만 선언된 UI를 그린다. 카드와 다른 화면은 선언된 UI를 그리지 않는다.
- snapshot의 전달은 [plugin 프로세스](plugin-processes.ko.md) 규칙 2에 있다. 이름, 명령, DOM 규칙은 [노출](exposure.ko.md)에 있다. 사이드바 배치는 [plugin](plugins.ko.md#섹션)에 있다.
- 접근성: 선언된 UI에 대해 접근성 주장은 하지 않는다. 플랫폼 접근성 인터페이스가 검사로 기록될 때까지 그렇다. 이 문서는 ARIA 역할을 정의하지 않는다.
- core는 값을 자르지 않는다. 요소가 한도보다 많은 plugin은 자기 값을 스스로 자르고 자른 사실을 `status-line`에 적는다. 한도를 넘는 값은 줄이지 않고 거부한다. 지연 적재는 없다.

## 선언된 status

status는 사이드바 section이 그 section 선언의 `status` 형태로 이름을 댈 때만 선언된 UI status다([사이드바 section 형태](#사이드바-section-형태)). 그 밖의 경로는 없다. 선언된 UI status를 표시하는 스키마 표지는 없다.

선언된 UI status는 [노출](exposure.ko.md#항목-필드)이 받는 부분 집합으로 `exposes.status`에 `schema`를 선언한다.

```json
{"type": "object", "properties": {"elements": {"type": "array"}}}
```

이 부분 집합은 아래의 한도와 참조 규칙을 나타내지 못한다. 수신자는 그리기 전에 모든 선언된 UI snapshot과 `null`이 아닌 모든 pull 응답에 이 규칙들을 적용한다.

push된 선언된 UI snapshot은 변경이 아니라 status의 전체 값을 싣는다. pull 응답도 status의 전체 값을 싣지만, 그것은 응답이지 선언된 UI snapshot이 아니다. 받아들인 값마다 그 status가 그린 트리 전체를 대체한다.

## 루트

값은 `elements` 필드를 가진 객체이며, `elements`는 0개에서 64개 요소의 배열이다. 각 요소는 아래 요소 종류 가운데 하나를 고르는 `kind` 필드를 가진 객체다. 각 요소는 루트 요소들 사이에서 유일한 `key`를 가진다. 루트 요소는 배열 순서대로 그리므로, tree section은 tree 앞에 button 요소를 둘 수 있다. 루트에서 다른 필드는 받지 않는다.

## 요소 종류

필드 `kind`가 각 요소의 종류를 정한다. `kind`는 모든 루트 요소에서 받아들이며, 나열된 필드 가운데 하나가 아니다. list 항목과 tree 노드는 `kind`를 갖지 않는다. 종류는 `list`, `tree`, `button`, `status-line`이다. 각 객체는 그 종류가 나열한 필드만 받는다. 나열되지 않은 필드는 거부한다.

| 종류 | 필드 | 형 | 필수 | 한도와 뜻 |
| --- | --- | --- | --- | --- |
| `button` | `key` | 문자열 | 예 | 아래 키 규칙. `command`를 실행하는 버튼이다. |
| `button` | `label` | 문자열 | 예 | 평문, 500 코드 포인트 이하. |
| `button` | `command` | 문자열 | 예 | plugin의 명령([묶기](#묶기)). |
| `button` | `params` | 객체 | 아니오 | 매개변수, [매개변수](#매개변수) 참조. |
| `button` | `icon` | 문자열 | 아니오 | core 아이콘 표(`packages/workbench/icons.js`)의 이름. |
| `button` | `enabled` | 불리언 | 아니오 | `false`이면 버튼을 끈다. 기본값 `true`. |
| `list` | `key` | 문자열 | 예 | 아래 키 규칙. |
| `list` | `empty` | 문자열 | 예 | 평문, 500 코드 포인트 이하. `items`가 비었을 때 행 대신 그린다. 모든 list는 빈 상태를 말한다. [plugin](plugins.ko.md#섹션)이 모든 list에 요구하는 규칙이다. |
| `list` | `items` | 배열 | 예 | 1000개 이하의 항목. 각 항목은 아래 필드를 가진다. |
| `list` 항목 | `key` | 문자열 | 예 | list 안에서 유일하다. |
| `list` 항목 | `label` | 문자열 | 예 | 평문, 500 코드 포인트 이하. |
| `list` 항목 | `command` | 문자열 | 아니오 | `command`가 있으면 항목은 버튼이다. 없으면 정적 행이다. |
| `list` 항목 | `params`, `icon`, `enabled` | `button`과 같음 | 아니오 | `button`과 같은 규칙. |
| `list` 항목 | `selected` | 불리언 | 아니오 | 항목을 선택된 것으로 그린다. 기본값 `false`. 이 값에 대해 workbench 상태를 유지하지 않는다. |
| `list` 항목 | `detail` | 문자열 | 아니오 | 평문, 500 코드 포인트 이하, label 뒤에 그린다. |
| `tree` | `key` | 문자열 | 예 | 아래 키 규칙. |
| `tree` | `empty` | 문자열 | 예 | 평문, 500 코드 포인트 이하. `nodes`가 비었을 때 노드 대신 그린다. |
| `tree` | `nodes` | 배열 | 예 | 루트 노드. 전체 트리에서 5000개 이하의 노드, 16단계 이하(루트 노드는 1단계). |
| `tree` 노드 | `key` | 문자열 | 예 | 형제 사이에서 유일하다. |
| `tree` 노드 | `label` | 문자열 | 예 | 평문, 500 코드 포인트 이하. |
| `tree` 노드 | `command`, `params`, `icon`, `enabled` | `button`과 같음 | 아니오 | `command`가 있는 노드는 한 번 누르면 그 명령을 실행한다. `open`이 있으면 두 번 누르기의 두 번째 클릭은 `command` 대신 `open`을 실행한다. |
| `tree` 노드 | `open` | 문자열 | 아니오 | plugin의 명령. 이 노드에서 Enter keydown은 `open`을 실행하고 native click을 막는다. `event.detail === 2`인 클릭은 `open`을 실행한다. 노드의 `params`는 `command`와 `open` 모두에 적용한다. |
| `tree` 노드 | `branch` | 불리언 | 아니오 | `true`이면 자식 노드가 아직 없어도 가지로 선언한다. 불리언이 아니면 거부한다. |
| `tree` 노드 | `expanded` | 불리언 | 아니오 | 가지에 대한 plugin의 값. 가지에만 허용하므로, 잎에 두면 거부한다. 기본값 `false`. [status 대응](#status-대응)이 우선순위를 정한다. |
| `tree` 노드 | `selected` | 불리언 | 아니오 | 노드를 선택된 것으로 그린다. 기본값 `false`. plugin의 값은 받아들인 모든 값에 적용된다. |
| `tree` 노드 | `detail` | 문자열 | 아니오 | 평문, 최대 500 코드 포인트. 라벨 뒤에 `list` 항목의 `detail`과 같이 그린다. |
| `tree` 노드 | `actions` | 배열 | 아니오 | 최대 2개의 `button` 객체이며 `button` 규칙을 따른다. 라벨과 detail 뒤에 그린다. 각 action key는 노드 안에서 유일하다. |
| `tree` 노드 | `children` | 배열 | 아니오 | 하위 노드. 같은 규칙을 따른다. 비어 있지 않은 `children` 또는 `branch: true`가 있는 노드는 가지이며, 그 밖의 노드는 잎이다. |
| `status-line` | `key` | 문자열 | 예 | 아래 키 규칙. |
| `status-line` | `text` | 문자열 | 예 | 평문, 500 코드 포인트 이하. 한 줄로 그린다. |

키 규칙: 키는 `A-Z`, `a-z`, `0-9`, `.`, `_`, `:`, `-`로 이루어진 1 코드 포인트에서 128 코드 포인트의 문자열이다. 키는 정확한 문자열로 비교한다.

텍스트 규칙: 텍스트 필드는 평문이다. workbench는 그것을 마크업이 아니라 텍스트 내용으로 그린다. 제어 문자(U+0000에서 U+001F, U+007F, 또는 U+0080에서 U+009F)를 담은 텍스트 필드는 거부한다.

`status-line`에는 tone과 오류 값이 없다. 오류는 응용 프로그램 로그에 기록하는 표시 경로([AGENTS](../../AGENTS.ko.md))를 거쳐야 사용자에게 보이므로, 선언된 요소는 오류를 그릴 수 없다.

`list`는 행의 열이며, 행이 없으면 `empty` 텍스트를 그린다. `tree`는 들여쓴 개요이며, 노드가 없으면 `empty` 텍스트를 그린다. 비어 있지 않은 `children`이 있는 노드는 가지이며, `branch: true`도 아직 자식이 제공되지 않은 가지(미적재 가지)를 선언한다. 가지는 제공된 자식이 펼쳐져 있을 때만 그린다. 미적재 가지는 펼침 제어를 가지지만, 나중에 받아들인 값이 자식을 제공하기 전까지 하위 행은 없다. `button`은 한 개의 버튼이다. `status-line`은 한 줄의 텍스트다.

## 한도

각 한도는 이 문서가 선택한 값이다. 그 이유는 main page가 선언된 UI snapshot 하나에 하는 일이다. 값을 UI thread에서 파싱하고 검사하고 그리며, 그린 트리를 모두 문서에 둔다. 표의 한도가 계약 값이다.

| 한도 | 값 | 이유 |
| --- | --- | --- |
| 직렬화한 값 | 1048576바이트 | `JSON.stringify`한 값의 UTF-8 바이트 길이다. 선언된 UI snapshot마다 UI thread에서 파싱하고 검사한다. |
| 루트 요소 | 64 | 다른 한도와 같이 main page가 선언된 UI snapshot 하나에 하는 일이다. |
| list 항목 | list마다 1000 | list 하나가 선언된 UI snapshot마다 그리는 행을 제한한다. |
| tree 노드 | tree마다 5000 | tree 하나가 선언된 UI snapshot마다 그리는 노드를 제한한다. |
| tree 단계 | 16 | section 안에서 tree의 들여쓰기를 제한한다. |
| 텍스트 필드 | 500 코드 포인트 | 텍스트 필드 하나의 길이를 제한한다. 그린 너비는 제한하지 않는다: `tree` 상자는 상자보다 넓은 라벨을 가로 스크롤로 그리고, `list` 라벨은 공백에서 줄바꿈하며, 공백이 없는 한 단어가 section보다 넓으면 section 가장자리 밖으로 그려져 set과 함께 스크롤된다. status 줄 텍스트는 자기 상자에서 잘린다. |
| 키 | 128 코드 포인트 | workbench가 요소마다 보관하는 식별자를 제한한다. |
| 매개변수 키 | 객체마다 16개 | 묶기마다 보관하는 매개변수 기록을 제한한다. |
| 매개변수 키 길이 | 64 코드 포인트 | 묶기마다 보관하는 매개변수 기록을 제한한다. |
| 매개변수 문자열 값 | 1000 코드 포인트 | 묶기마다 보관하는 매개변수 기록을 제한한다. |

각 한도는 받을 때 검사한다. 키, 텍스트 필드, 매개변수의 모든 길이는 코드 포인트를 센다. 직렬화한 값은 UTF-8 바이트를 센다. 한도를 넘는 값은 잘라내지 않고 거부한다.

## 그리기 benchmark

전용 workbench benchmark는 모든 branch를 펼친 16 level 이내의 node 5000개 tree와 command item 1000개 list를 각각 한 번 검증하고 그리는 시간을 측정한다. 허용 bound는 tree 2000 ms, list 500 ms다. 측정 구간은 `validateValue`, expanded-state 구성 및 jsdom 안의 `drawValue`를 포함하며, binding attribute와 no-op binder 호출도 포함한다. fixture 생성, module 로드, 완전성 검사, layout, paint 및 command listener 연결은 제외한다. 단위 test는 경과 시간을 판정하지 않고 전체 그리기를 검사한다.

각 case는 30000 ms hang limit을 가진 별도 process에서 실행한다. 불완전한 그리기, 누락된 binding call, 잘못된 clock 값 또는 허용 bound를 넘는 경과 시간은 benchmark 실패다. 각 측정은 element 수, binding 수, 경과 밀리초, bound, 결과, package version, Node와 jsdom version, OS와 CPU 정보 및 load average를 기록한다. command와 supervisor는 [example 검증](../operations/examples.ko.md#declared-ui-benchmark)에 있다.

## 아이콘

`icon` 필드는 core 아이콘 표의 이름을 받는다. 표에 없는 이름은 거부한다. plugin은 아이콘 마크업을 공급할 수 없다.

## 매개변수

선언된 요소의 `params`는 최대 16개 키를 가진 JSON 객체다. 각 키는 64 코드 포인트 이하의 문자열이다. 각 값은 1000 코드 포인트 이하의 문자열, 유한한 숫자, 불리언, 또는 `null`이다. 배열, 객체, 그 밖의 값은 거부한다. 매개변수의 유일한 배열은 `core.declared-ui.tree.expand`의 `path`이며, workbench가 펼침 제어에 설정한다. plugin 값은 그것을 담을 수 없다.

## 묶기

사용자가 조작할 수 있는 요소는 모두 명령에 묶인다. 묶기는 [사용자 인터페이스](exposure.ko.md#사용자-인터페이스) 규칙을 따른다. 요소는 `data-command`로 명령을 가리키고, 매개변수는 `data-params`에 두며, `@soksak/plugin-api`의 binder `bind(element, name, params, {event: "click"})`로 연결한다.

선언된 UI 요소는 다음 명령에 묶인다.

| 요소 | 명령 | 매개변수 |
| --- | --- | --- |
| `button` | 그 `command` 필드 | 그 `params` 필드 |
| `command`가 있는 `list` 항목 | 그 `command` 필드 | 그 `params` 필드 |
| `command`가 있는 `tree` 노드 | 그 `command` 필드 | 그 `params` 필드 |
| `open`이 있는 `tree` 노드 | 그 `open` 필드 | 그 `params` 필드 |
| `tree` 노드 action | 그 `command` 필드 | 그 `params` 필드 |
| `tree` 가지의 펼침 제어 | `core.declared-ui.tree.expand` | `{status, tree, path, expanded}` |
| 사이드바 section 머리 | `core.sidebar.section.fold` | `{sidebar, section}` |

선언된 UI 값의 명령 이름은 `<plugin>.<name>`이며, `<plugin>`은 status의 plugin이다. core의 이름이나 다른 plugin의 이름은 거부한다. plugin 값은 자기 plugin의 명령만 이름으로 지정하기 때문이다. 선언되지 않은 이름은 사용자가 요소를 누를 때가 아니라 선언된 UI snapshot을 받을 때 거부한다. binder가 표시 시점에 선언되지 않은 이름을 거부하기 때문이다([노출](exposure.ko.md#사용자-인터페이스)).

`core.declared-ui.tree.expand`는 `packages/workbench/exposure.json`에 처리기와 함께 선언한다. 명령은 요청한 `expanded` 상태를 status의 선택된 출처에 `declared-ui.expanded {status, tree, path, expanded}`로 보낸다. event의 `status`는 plugin 안의 이름이고 command의 `status`는 `<plugin>.<name>`이다. workbench는 그리기를 바꾸지 않는다. 출처가 값을 갱신하고 다음 snapshot을 받아들인 뒤에만 tree가 바뀐다. 같은 요청을 반복하면 같은 희망 값을 보낸다. `path`는 tree의 루트 노드에서 가지까지의 노드 key 배열이고 `tree`는 tree 요소의 key다. 받아들인 값에 없는 `path`, 또는 그려지지 않은 `status`나 `tree`는 `tree <tree> path <path> is not drawn`으로 명령을 실패시킨다. 그 메시지의 `<path>`는 문자열의 JSON 배열이다.

요청의 `expanded`는 받아들인 plugin 값에 현재 있는 가지 상태의 반대다. 출처는 이 희망 값으로 plugin 값을 갱신한다.

비활성 요소(`enabled: false`)는 `disabled` 속성으로 그려지므로 어떤 클릭도 그 묶기에 닿지 않는다.
다시 그릴 때 남는 address의 각 루트 요소, list 행, tree 노드, 펼침 제어는 같은 요소를 유지한다. [exposure](exposure.ko.md#사용자-인터페이스)가 모든 다시 그리기에 요구하는 규칙이며, 명령 실행 뒤에도 키보드 초점이 제어에 남게 한다. 그런 각 제어는 명령에 한 번만 묶이며, 다시 그릴 때는 매개변수만 갱신한다. `command`가 바뀐 list 행이나 tree 노드는 새 요소다. key에 명령이 포함되기 때문이다.
네이티브 `button` 요소를 가지는 요소는 `button`, `command`가 있는 list 항목, `command` 또는 `open`이 있는 tree 노드, tree action, tree 가지의 펼침 제어다. 정적 list 행과 status line은 button을 가지지 않는다. 가지의 펼침 제어는 가지가 접혀 있으면 core의 chevron-right 아이콘을, 펼쳐 있으면 chevron-down 아이콘을 보인다.


DOM 이름. 선언된 UI 값이 그리는 control은 모두 DOM 이름 `core.sidebar.section.control`과, 루트 요소의 `key`를 담은 속성 `data-key`를 가진다. list 항목과 tree 노드의 control은 `data-path`(루트 요소 아래의 key들의 JSON 배열)와 `data-role`(`label`, `expand`, `action`)도 가진다. action button은 action key를 담은 `data-action`도 가진다. `command`나 `open`이 없는 잎은 label control을 갖지 않는다. `command`가 없는 가지는 actions가 없을 때 펼침 제어의 속성만 가진다. 조작할 수 없는 요소, 예컨대 정적 list 행이나 status line은 둘 다 갖지 않는다. section 머리는 `core.sidebar.section.header`를 가진다([plugin](plugins.ko.md#섹션)). 사이드바가 이미 쓰는 이름이므로, 선언된 section과 모듈 section은 같은 방식으로 감사된다. 선언된 요소는 자기 종류의 DOM 이름을 따로 갖지 않는다. 종류는 값에 있다.

선언된 section의 control에 대한 요청은 control address `{sidebar, section, key, path?, role?, action?}`로 지정한다. `sidebar`는 `core.sidebars`가 보고하는 사이드바 인스턴스(`left`, `right`, `cardId:side`)이고, `section`은 section id이며, `key`는 그 control을 가진 루트 요소의 key다. `sidebar`, `section`, `key`는 문자열이다. `path`는 루트 요소 아래의 key들로 이루어진 문자열 배열이고, `role`은 `label`, `expand`, `action` 중 하나다. control이 list 항목이나 tree 노드에 속하면 `path`와 `role`이 필수이며, 루트 button에는 허용하지 않는다. `role`이 `action`일 때만 `action`이 필수이고 그 밖에는 금지한다. `action`은 노드 actions 안에서 유일한 key다. 이 필드들로 주소는 유일하다. 한 사이드바 인스턴스는 section을 한 번 그리고, 키는 형제 사이에서 유일하며, path, role, 선택적 action key가 control 하나를 정한다. `core.sidebar.section.control` DOM 항목은 여러 요소가 그 이름을 공유하므로 `many`로 선언되어 있다. 다른 타입의 값은 [노출](exposure.ko.md#오류)이 정하는 대로 -32602로 거부하며, `address`의 여섯 필드가 아닌 필드도 -32602로 거부한다. 어느 control과도 맞지 않는 주소는 [노출](exposure.ko.md#오류)의 오류 코드로 실패한다.

네이티브 키보드 조작은 `button` 요소를 쓰므로 Enter와 Space가 같은 묶기를 거쳐 버튼 명령에 닿는다. `open`이 있는 tree 노드는 예외로 Enter keydown을 직접 처리한다. `open`을 실행하고 native click을 막는다. 선언 tree 노드는 수정자 없는 ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End 키도 처리한다. [트리 키](#트리-키) 절이 규정한다. 다른 선언 UI 요소에는 키 처리기가 없다. `command`와 `open`이 모두 있는 노드에서 두 번 누르기의 첫 클릭은 `command`를 실행하고 두 번째 클릭(`event.detail === 2`)은 `command` 대신 `open`을 실행한다.

## 트리 키

tree 노드의 focus target은 그 label 컨트롤이 있고 활성이면 label 컨트롤이다. 아니면 가지의 펼침 컨트롤이다. 둘 다 없는 노드에는 focus target이 없다. 모든 가지는 펼침 컨트롤을 가지므로 모든 가지는 focus target을 가진다. tree의 보이는 노드는 그리기가 보여 주는 노드이며 그리기 순서를 따른다. 가지의 자식 노드는 그 가지가 펼쳐져 있는 동안에만 보인다.

키는 보이는 노드의 label 컨트롤이나 펼침 컨트롤에 키보드 포커스가 있는 동안 적용된다. 수정자(Shift, Control, Alt, Meta)가 있는 키는 처리하지 않는다. 처리한 키는 `preventDefault`를 호출하므로, 키 때문에 사이드바가 스크롤되지 않는다. 아래 어떤 행에도 해당하지 않는 키는 처리하지 않으며 기본 동작을 유지한다.

- ArrowDown은 다음 보이는 노드 가운데 focus target이 있는 노드의 focus target으로 포커스를 옮긴다. 그런 마지막 노드에서는 포커스가 그대로 있다.
- ArrowUp은 이전 보이는 노드 가운데 focus target이 있는 노드의 focus target으로 포커스를 옮긴다. 그런 첫 노드에서는 포커스가 그대로 있다.
- Home과 End는 focus target이 있는 첫 보이는 노드와 마지막 보이는 노드의 focus target으로 포커스를 옮긴다.
- ArrowRight는 접힌 가지에서 `expanded: true`로 `core.declared-ui.tree.expand`를 실행한다. 펼쳐진 가지에서는 첫 자식 노드 가운데 focus target이 있는 노드의 focus target으로 포커스를 옮긴다. 그런 자식 노드가 없으면 포커스가 그대로 있다. 잎에서는 처리하지 않는다.
- ArrowLeft는 펼쳐진 가지에서 `expanded: false`로 `core.declared-ui.tree.expand`를 실행한다. 접힌 가지나 잎에서는 부모 노드의 focus target으로 포커스를 옮긴다. 부모가 없는 루트 노드에서는 포커스가 그대로 있다.

포커스 이동은 `core.declared-ui.tree.move {status, tree, path, key}`를 실행한다. `key`는 누른 키다. 이 명령은 `packages/workbench/exposure.json`에 처리기와 함께 선언된다. 펼침 행은 묶기 절이 정하는 대로 `core.declared-ui.tree.expand`를 실행한다. 키 행은 [exposure](exposure.ko.md#키보드-단축키)의 키보드 단축키 표에 있다. 이동 명령은 그려진 tree 안의 포커스만 바꾸며 source에 요청을 보내지 않는다.

다시 그릴 때 포커스는 남는 컨트롤에 머문다. 받아들인 값이 포커스가 있던 컨트롤을 없애면, 값을 받기 전 그리기에서 그 노드보다 앞에 있고 받아들인 값에서도 focus target을 가진 가장 가까운 노드의 focus target으로 포커스를 옮긴다. 그런 노드가 없으면 받아들인 값의 같은 tree에서 focus target을 가진 첫 노드의 focus target으로 옮긴다. 둘 다 없으면 포커스는 문서 body로 옮긴다. 거부된 값이나 source 변경이 포커스가 있던 컨트롤을 없애면 포커스는 문서 body로 옮긴다.

## status 대응

선언된 UI status는 선언된 UI snapshot을 거쳐 다음과 같이 그려진다.

- 받아들인 선언된 UI snapshot마다 그 status의 트리를 대체한다. 각 가지의 `expanded` 값은 plugin이 소유한다. `true`이면 자식을 그리고, 없거나 `false`이면 접어 둔다. workbench는 expansion override를 유지하지 않는다.
- 펼침 제어는 `declared-ui.expanded {status, tree, path, expanded}`를 status의 출처로 보낸다. 받아들인 plugin 값에서 현재 보이는 상태의 반대를 요청한다. 출처는 값을 갱신하고 snapshot을 보내며, 받아들인 뒤에만 tree가 갱신된다.
- 가지의 받아들인 `expanded` 값은 이전 값이나 요청으로 덮어쓰지 않는다. 가지가 처음 나타나거나, 사라졌다가 돌아오거나, 잎에서 바뀌면 해당 snapshot에서 plugin이 보낸 값을 사용한다.
- 거부된 값은 section을 비우며 plugin의 출처 상태를 바꾸지 않는다. 다음에 받아들인 값이 가지의 expansion을 다시 정한다. 출처가 바뀌어도 section을 비우며 새 출처의 값이 expansion을 정한다.
- 받아들인 값에서 잎이 된 경로에는 펼침 제어가 없다. 이후 그 경로가 가지가 되면 새로 받아들인 `expanded` 값으로 그린다.
- pull 응답의 `value`가 `null`이면 출처에 아직 값이 없다는 뜻이다. section은 출처의 첫 push까지 비워진 채로 남는다. pull 응답의 `seq`는 출처의 마지막 선언된 UI snapshot의 seq이며, `value`가 `null`이면 0이다. 출처에서 마지막으로 받아들인 값의 `seq`보다 `seq`가 낮은 pull 응답은 검사 없이 버린다. 그 밖의 `null`이 아닌 pull 응답은 검사 규칙을 따른다.
- pull이 실패하면(출처가 오류로 답하거나 호출이 거부되면) section은 비워진 채로 남는다. 마지막으로 받아들인 값도, 빈 트리도 그리지 않는다. 그 오류는 오류 표시 경로를 거쳐 한 번 보고된다(응용 프로그램 로그의 `error: <where>: <text>`, [오류 표시](native-surfaces.ko.md#view-표면)와 같다). section은 이 오류를 거부 문구로 보여주지 않는다. workbench는 실패한 pull을 타이머나 다른 일정으로 다시 시도하지 않는다. 다음 pull은 (c)의 다음 출처 변경 때 하나뿐이다.
- `selected`를 바꾸는 core 명령이 없으므로, 받아들인 모든 값에서 plugin의 값이 적용된다.
- plugin 프로세스가 재시작하면 이전 등록을 지우고 새 프로세스를 등록해 출처를 다시 고른다. 새 출처의 받아들인 값이 모든 가지 상태를 정한다.
- workbench는 expansion 상태를 공간이나 프로젝트에 저장하지 않는다. main page를 다시 불러오면 plugin의 받아들인 `expanded` 값으로 그린다.
- 선언된 status는 plugin 프로세스가 제공한다. workbench는 그 status를 등록한 첫 선언된 status 출처에서 값을 읽는다. 첫째, 사이드바를 가진 카드의 활성 탭의 view이며, 그 view의 페이지가 status를 등록했을 때다. 카드 사이드바에서는 그 사이드바를 가진 카드다. 고정 창 사이드바에서는 plugin override([외부 사이드바](external-sidebars.ko.md#오버라이드-컨텍스트와-레일-보더))가 적용되는 동안 `core.sidebars`가 보고하는 포커스된 내용 카드와 그 활성 탭이며, plugin override가 적용되지 않으면 이 단계를 건너뛴다. 둘째, plugin의 [plugin host](plugin-host.ko.md)이며 plugin이 host를 가질 때만 있다. 그 밖에는 누군가 등록할 때까지 section을 비운다. 상태 모듈의 등록은 선언된 UI status를 제공하지 않는다. 상태 모듈만 등록하는 선언된 UI status는 출처가 없으며, 그 section은 비워진다. 프로세스는 자기 페이지가 `page.exposure.register("status", name)`을 부르면 status를 등록하며, 등록은 그 프로세스의 것이다. 선언된 status 출처는 프로세스와 그 프로세스의 status 등록의 짝이다. 출처가 바뀌는 것은 다른 짝이 되는 것이다. 같은 프로세스가 같은 status를 다시 등록하는 것은 바뀜이 아니다.

출처가 바뀌는 규칙은 다음과 같다.

- (a) 사이드바 카드의 활성 탭, 고정 창 사이드바의 포커스된 카드, 또는 등록이 바뀌거나, 고정 창 사이드바의 plugin override가 적용되기 시작하거나 멈추면 출처를 다시 고른다.
- (b) 출처가 바뀌면 새 출처의 첫 값을 받아들일 때까지 section을 비운다. 이전 출처의 expansion 상태는 살아남지 않으며 새 출처의 값이 정한다.
- (c) 출처가 바뀌면 workbench는 새 출처의 현재 값을 한 번 pull한다. workbench는 고른 출처에서 pull하는 것을 메인 페이지 load 때, 출처가 바뀔 때만 허용하며, 다른 때는 허용하지 않는다. 실행 중인 view는 마지막 값을 새 독자에게 보낼 다른 수단이 없기 때문이다. pull한 값은 push된 선언된 UI snapshot과 같은 검사와 거부 규칙을 따른다.
- 메인 페이지는 window의 snapshot ingress listener를 하나 설치한다. 이 listener는 snapshot envelope를 검사하고 각 push에 정확히 한 번 확인 응답한 뒤 routing한다. Plugin, 출처, status로 현재 section recipient에게 전달한다. 일치하는 recipient가 없는 snapshot은 확인 응답한 뒤 버린다. section이 mount되지 않은 status도 이에 포함된다. 확인 응답 수는 mount된 recipient 수와 무관하다.
- Section subscription은 고른 출처를 pull하기 전에 window ingress에 recipient를 등록한다. Subscription readiness는 recipient 등록을 뜻한다. 메인 페이지가 view를 배치하거나 plugin host 생성을 위해 window ready를 알리기 전에 window ingress listener가 준비된다. Subscription 작업은 recipient 등록 뒤에만 unsubscribe 함수를 resolve한다. readiness 전에 출처가 바뀌거나 section이 닫히면 workbench는 readiness가 완료되는 즉시 recipient를 제거하고 해당 출처를 pull하지 않는다. readiness 뒤 pull 응답 전에 전달된 snapshot은 정상적으로 수락하므로, 더 낮은 sequence의 pull은 이를 덮어쓸 수 없다.
- (d) 프로세스가 끝나면 그 등록을 지우고, 출처를 (a)처럼 다시 고른다.
- 선택된 출처가 아닌 짝에서 온 선언된 UI snapshot은 확인 응답한 뒤 검사 없이 버린다. 선택된 출처가 아닌 짝에서 온 pull 응답, 또는 `seq`가 출처에서 마지막으로 받아들인 값의 `seq`보다 낮은 pull 응답은 검사 없이 버린다. 트리나 오류 표시를 바꾸지 않는다.

- 첫 받아들인 값 전에는 section이 트리를 보이지 않는다. 그 전에 보일 수 있는 내용은 거부 텍스트뿐이며, 거부된 값 뒤에만 보인다.
- 선언된 UI 값은 변경 흐름이 아니다. plugin은 어떤 요소가 바뀌어도 값 전체를 다시 보낸다.
- 메인 페이지가 load되면 workbench는 각 선언된 status의 현재 값을 그 status의 출처로 고른 곳에서 한 번 pull한다.

## 사이드바 section 형태

사이드바 section은 `plugin.json`에서 `status` 형태로 선언한다([plugin](plugins.ko.md#섹션)). 이것이 유일한 형태다. section은 `id`, `name`, `status`, 선택 필드 `fill`을 선언한다. `fill: true`는 [plugin](plugins.ko.md#섹션)이 section에 주는 뜻과 같다. 펼친 section은 다른 section이 남긴 사이드바 높이를 나누어 갖고, 본문은 그 안에서 스크롤한다.
`status` 형태의 사이드바 section은 선언된 UI다. 뷰가 필요한 plugin은 카드 표면을 선언하고, 사이드바는 그 plugin의 명령이면서 카드 표면을 여는 `button`을 가진다.

- `status`를 가진 section은 그 status의 선언된 UI 값으로 그린다. status는 같은 plugin의 status이어야 하며, `exposes.status`가 선언해야 한다.
- `module`을 가진 section은 `plugin <plugin>: section <id> module is removed; a section takes status`로 거부하고, `status`가 없는 section은 `plugin <plugin>: section <id> requires a status`로 거부한다. plugin의 status가 아닌 `status`는 `section <id> status <name> is not a status of plugin <plugin>`으로 거부한다. `exposes.status`는 `plugin.json`의 `exposes.status` 항목만 뜻한다.
- status 하나는 section 하나만 뒷받침한다. 같은 status를 이름 댄 두 번째 section은 manifest를 읽을 때 `status <plugin>.<name> backs section <first> and section <second>`로 거부한다. 이 검사는 manifest에서 하므로 값에 의존하지 않는다.

선언된 section은 루트 요소를 본문 안에 순서대로 그린다.

- 세로 방향에서는 요소를 위에서 아래로 쌓는다.
- 가로 방향에서는 요소를 왼쪽에서 오른쪽으로 한 행에 놓고, section 너비에서 줄바꿈한다. `tree`는 그 너비의 한 줄을 모두 차지하며, 아래 문단이 그 방식을 설명한다.
`tree`는 가로 section에서 section 너비의 한 줄을 모두 차지하고, 세로 방향과 같은 개요를 그린다. 그래서 줄바꿈은 tree 앞뒤에서만 일어난다. `list`는 내용 너비를 유지하며, 내용이 더 넓을 때만 그 줄의 너비로 줄어든다. tree의 너비는 가장 깊은 보이는 행을 따르므로, 가지를 펼치거나 접으면 너비가 바뀐다. 전체 줄은 그 변화가 옆 요소를 재배치하지 않게 한다. tree 상자는 라벨이 상자보다 넓으면 얇은 스크롤바와 함께 가로로 스크롤하며, 상자 밖 라벨은 스크롤로 닿는다. 세로 section에서 tree 상자는 section 너비이므로, 스크롤은 라벨이 section보다 넓을 때만 적용된다. 어떤 declared 값도 방향에 기대지 않으므로, 방향이 바뀌어도 declared 값을 검사하거나 pull하지 않으며 받아들인 값은 그대로 그린다.

선언된 section은 사이드바 section의 머리, 접기 제어, 탭 선택을 바꾸지 않고 유지한다. 머리는 `core.sidebar.section.header`이며, 접으면 `core.sidebar.section.fold`를 실행한다. 선언된 section의 묶음은 [plugin](plugins.ko.md#섹션)의 묶음 규칙을 따른다. 적재되지 않은 plugin의 section은 다른 section과 같이 그리지 않는다.

`core.sidebars` status는 section마다 다음 필드를 보고한다.

- `controls`는 section 본문에서 DOM 이름 `core.sidebar.section.control`을 가진 요소의 수다. 선언된 section에서는 그 조작 가능한 요소다.
- `mounted`는 section이 받아들인 값을 그리는 동안 true다. section이 비워지면 false다. section은 받아들인 값이 없을 때 비워진 것이다. 첫 받아들인 값 전, 거부된 값 뒤, 그리고 출처가 바뀐 뒤 새 출처의 첫 값을 받아들이기 전이 그 경우다([status 대응](#status-대응)의 (b) 규칙).
- `error`는 마지막 값이 거부된 동안의 현재 거부 텍스트이며, 그 밖에는 null이다.
- `text`는 본문의 텍스트다.

## 거부

수신자는 그리기 전에 선언된 UI snapshot 값 전체를 검사한다. 이 문서의 규칙을 하나라도 어기는 값은 전체를 거부한다. 그 값의 어떤 요소도 그리지 않으며, 그 status의 이전 트리는 지운다. 거부 때 이전 트리를 남기지 않는다. 거부는 값을 버리므로 다시 그릴 유지된 값이 없다. 남긴 트리는 plugin이 더 이상 현재 값으로 보내지 않는 값을 보이기 때문이다.

수신자는 선언된 UI snapshot에 응답한다. 응답은 수신 확인이지 유효성 확인이 아니므로, plugin은 거부 신호를 받지 않는다. 거부는 section에서만 보인다.

표시 경로는 `showError(element, where, text)`다. 거부한 값에서 `where`는 `declared UI <owner>.<status>`이고 `text`는 `<포인터>: <이유>`다. section 본문이 `showError`가 보이는 요소이므로, section의 텍스트가 거부의 표시다. 같은 호출이 쓰는 응용 프로그램 로그 줄이 기록이다: `error: declared UI <owner>.<status>: <포인터>: <이유>`. section은 같은 오류를 두 번째 표시로 보이지 않는다.

`showError`는 같은 `where`와 같은 `text`에 대해 로그 줄을 한 번만 쓴다. 보이는 텍스트를 유지하므로, 같은 텍스트의 거부가 반복되면 같은 텍스트를 보이고 아무것도 더 쓰지 않는다. 다른 텍스트의 거부는 자기 줄을 쓴다. status의 다음 받아들인 값은 그 `where`에 대해 `hideError`를 부른다. 이는 표시를 거두므로, 그 뒤에 같은 텍스트가 다시 나오면 다시 쓴다.
출처가 바뀌거나, 프로세스가 끝나거나, surface가 닫히면 그 status에 대해 `hideError`를 부르고 `error`를 null로 둔다.

모든 거부 텍스트는 `<포인터>: <이유>` 형식이다. 표의 각 행의 포인터는 그 행을 어기는 값이며, 포인터 열이 이를 정한다. 개수나 크기 한도는 초과한 배열, 객체, 문자열을 가리킨다. 필드의 존재를 다루는 행(`unknown field`, `missing`, `requires command`)은 그 필드를 가진 객체를 가리킨다. 필드 값을 다루는 행은 그 필드를 가리킨다. 중복 키는 두 번째 키를 가리킨다. `/`는 루트와 직렬화한 값 전체다. `<field>`는 JSON 필드 이름이다. 포인터는 JSON Pointer(RFC 6901)다. `<owner>`는 status의 plugin id다. 이유의 `<field>`, `<key>`, `<value>`, `<name>`, `<owner>` 자리는 JSON 문자열로 쓰며, 합성 자리 `<owner>.<name>`은 JSON 문자열 하나로 쓴다. 값은 먼저 이스케이프하여 제어 문자를 JSON 이스케이프로 바꾸고, 그다음 큰따옴표로 감싼다. 따옴표도 128 코드 포인트 한도에 포함된다. 128 코드 포인트를 넘는 따옴표 텍스트는 여는 따옴표와 처음 125 코드 포인트를 남기고, 표지 `…`(U+2026)와 닫는 따옴표를 붙여 잘린 텍스트가 128 코드 포인트가 되게 한다. `<type>` 자리는 이 문서의 고정 타입 이름이므로 따옴표로 감싸지 않는다.
요소의 필드 행은 `kind` 값이 고른 그 종류의 필드 목록을 쓰므로, `missing kind`, `kind must be a string`, `unknown kind` 행은 종류에 따라 달라지는 행보다 앞에 있다. 값이 여러 행을 어기면 값의 어느 부분이라도 어기는 표의 순서에서 첫 행이 적용된다. 그 행이 여럿 나타나면 문서 순서에서 첫 번째를 보고한다. 이름 행은 소유자 행보다 앞에 있으므로, 소유자가 없는 이름은 이름이 잘못되었다고 보고된다.

| 조건 | 이유 | 포인터 |
| --- | --- | --- |
| 루트가 객체가 아님 | `root must be an object` | `/` |
| `elements`가 배열이 아님 | `elements must be an array` | `/elements` |
| 직렬화한 값이 1048576바이트보다 큼 | `exceeds 1048576 bytes` | `/` |
| 루트 요소가 64개를 넘음 | `exceeds 64 elements` | `/elements` |
| 요소가 객체가 아님 | `element must be an object` | 그 요소 |
| list 항목이 객체가 아님 | `list item must be an object` | 그 항목 |
| tree 노드가 객체가 아님 | `tree node must be an object` | 그 노드 |
| action이 객체가 아님 | `tree action must be an object` | 그 action |
| `kind`가 없는 요소 | `missing kind` | 그 요소 |
| `kind`가 문자열이 아님 | `kind must be a string` | 그 요소 |
| 표에 없는 `kind` 값 | `unknown kind <value>` | `kind` 값 |
| list의 항목이 1000개를 넘음 | `exceeds 1000 items` | `/elements/<i>/items` |
| tree의 노드가 5000개를 넘음 | `exceeds 5000 nodes` | `/elements/<i>/nodes` |
| tree 노드의 actions가 두 개를 넘음 | `exceeds 2 actions` | 그 `actions` 배열 |
| tree 노드가 16단계를 넘음 | `exceeds 16 levels` | 그 노드 |
| 텍스트 필드가 500 코드 포인트를 넘음 | `exceeds 500 code points` | 그 텍스트 필드 |
| 키가 128 코드 포인트를 넘음 | `exceeds 128 code points` | 그 키 |
| 키가 키 규칙에 맞지 않음 | `key must be 1 to 128 code points of A-Z, a-z, 0-9, ., _, : or -` | 그 키 |
| `params` 객체의 키가 16개를 넘음 | `exceeds 16 keys` | `params` 객체 |
| 매개변수 키가 64 코드 포인트를 넘음 | `exceeds 64 code points` | 그 매개변수 키 |
| 매개변수 문자열 값이 1000 코드 포인트를 넘음 | `exceeds 1000 code points` | 그 매개변수 값 |
| 매개변수 값이 문자열, 유한한 숫자, 불리언, `null`이 아님 | `params values must be string, finite number, boolean or null` | 그 매개변수 값 |
| 객체가 나열하지 않은 필드(루트, 요소, list 항목, tree 노드) | `unknown field <field>` | 그 객체 |
| 필수 필드가 없음 | `missing <field>` | 그 객체 |
| list 항목이나 tree 노드에 `command` 필드 없이 `params` 또는 `enabled` 필드가 있음 | `<field> requires command` | 그 객체 |
| 있는 필드의 형이 맞지 않음. 없는 필드는 `missing <field>`다 | `<field> must be <type>` | 그 필드 |
| 텍스트 필드에 제어 문자가 있음 | `<field> contains a control character` | 그 필드 |
| 형제 사이, 또는 list 항목 사이에 같은 키가 있음 | `duplicate key <key>` | 두 번째 키 |
| `command` 이름에 소유자가 없음(`.`이 없음) | `command <name> must be named <owner>.<name>` | `command` 필드 |
| `command` 이름의 소유자가 core이거나 다른 plugin임 | `command <name> is not a command of plugin <owner>` | `command` 필드 |
| `command` 이름이 선언되지 않음 | `undeclared command <name>` | `command` 필드 |
| 아이콘 이름이 core 아이콘 표에 없음 | `unknown icon <name>` | `icon` 필드 |
| 잎 노드에 `expanded`가 있음 | `expanded is allowed only on a branch` | `expanded` 필드 |

manifest에 관한 거부, 즉 section 형태와 한 status 한 section 규칙은 값의 포인터가 아니라 manifest를 읽을 때 보고하며, 이유는 [사이드바 section 형태](#사이드바-section-형태)에 있다.

## 용어

용어는 [용어 목록](terms.ko.md)에 있다. 선언된 UI, 선언된 UI snapshot, 선언된 UI 값, 선언된 요소, 선언된 status line, 선언된 UI 스키마, 선언된 UI status, 가지, 선언된 section이다.
