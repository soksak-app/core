# 선언된 UI

[English](declared-ui.md)

선언된 UI(declared UI)는 모든 요소가 이 문서의 어휘 요소 가운데 하나인 사이드바 section이다. plugin은 선언된 UI status의 값을 보내고, workbench는 그 값을 그린다. 이 문서는 값, 각 요소, 각 요소가 선언된 명령에 묶이는 방식, status가 그리기에 대응하는 방식, 수신자가 거부하는 것, 그리고 선언된 UI status에서 그리는 사이드바 section의 형태를 정한다.

## 범위

- 어휘는 네 요소 `list`, `tree`, `button`, `status-line`이다. core는 다른 요소를 선언하지 않는다. 텍스트 입력, 자유 DOM, canvas, 문서 영역, 이미지 영역이 있는 화면은 view다. 인라인 이름 바꾸기, 끌어 놓기, 포인터 위치에 놓는 문맥 메뉴가 필요한 tree도 같은 이유로 view다. core는 그런 상호작용의 요소를 선언하지 않는다.
- workbench는 사이드바 section에서만 선언된 UI를 그린다. 카드와 다른 화면은 선언된 UI를 그리지 않는다.
- snapshot의 전달은 [plugin 프로세스](../plans/plugin-processes.ko.md) 규칙 2에 있다. 이름, 명령, DOM 규칙은 [노출](exposure.ko.md)에 있다. 사이드바 배치는 [plugin](plugins.ko.md#섹션)에 있다.
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

값은 `elements` 필드를 가진 객체이며, `elements`는 0개에서 64개 요소의 배열이다. 각 요소는 아래 요소 종류 가운데 하나를 고르는 `kind` 필드를 가진 객체다. 각 요소는 루트 요소들 사이에서 유일한 `key`를 가진다. 루트에서 다른 필드는 받지 않는다.

## 요소 종류

필드 `kind`가 각 요소의 종류를 정한다. `kind`는 모든 요소에서 받아들이며, 나열된 필드 가운데 하나가 아니다. 종류는 `list`, `tree`, `button`, `status-line`이다. 각 객체는 그 종류가 나열한 필드만 받는다. 나열되지 않은 필드는 거부한다.

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
| `tree` | `nodes` | 배열 | 예 | 루트 노드. 전체 트리에서 5000개 이하의 노드, 16단계 이하(루트 노드는 1단계). 가로 section에서는 tree를 그리지 않는다([사이드바 section 형태](#사이드바-section-형태)). |
| `tree` 노드 | `key` | 문자열 | 예 | 형제 사이에서 유일하다. |
| `tree` 노드 | `label` | 문자열 | 예 | 평문, 500 코드 포인트 이하. |
| `tree` 노드 | `command`, `params`, `icon`, `enabled` | `button`과 같음 | 아니오 | `command`가 있는 노드는 label을 누르면 그 명령을 실행한다. |
| `tree` 노드 | `expanded` | 불리언 | 아니오 | 가지에 대한 plugin의 값. 가지에만 허용하므로, 잎에 두면 거부한다. 기본값 `false`. [status 대응](#status-대응)이 우선순위를 정한다. |
| `tree` 노드 | `selected` | 불리언 | 아니오 | 노드를 선택된 것으로 그린다. 기본값 `false`. plugin의 값은 받아들인 모든 값에 적용된다. |
| `tree` 노드 | `children` | 배열 | 아니오 | 하위 노드. 같은 규칙을 따른다. `children`이 있고 비어 있지 않은 노드는 가지이며, 그 밖의 노드는 잎이다. |
| `status-line` | `key` | 문자열 | 예 | 아래 키 규칙. |
| `status-line` | `text` | 문자열 | 예 | 평문, 500 코드 포인트 이하. 한 줄로 그린다. |

키 규칙: 키는 `A-Z`, `a-z`, `0-9`, `.`, `_`, `:`, `-`로 이루어진 1 코드 포인트에서 128 코드 포인트의 문자열이다. 키는 정확한 문자열로 비교한다.

텍스트 규칙: 텍스트 필드는 평문이다. workbench는 그것을 마크업이 아니라 텍스트 내용으로 그린다. 제어 문자(U+0000에서 U+001F, U+007F, 또는 U+0080에서 U+009F)를 담은 텍스트 필드는 거부한다.

`status-line`에는 tone과 오류 값이 없다. 오류는 응용 프로그램 로그에 기록하는 표시 경로([AGENTS](../../AGENTS.ko.md))를 거쳐야 사용자에게 보이므로, 선언된 요소는 오류를 그릴 수 없다.

`list`는 행의 열이며, 행이 없으면 `empty` 텍스트를 그린다. `tree`는 들여쓴 개요이며, 노드가 없으면 `empty` 텍스트를 그린다. `button`은 한 개의 버튼이다. `status-line`은 한 줄의 텍스트다.

## 한도

각 한도는 이 문서가 선택한 값이다. 그 이유는 main page가 선언된 UI snapshot 하나에 하는 일이다. 값을 UI thread에서 파싱하고 검사하고 그리며, 그린 트리를 모두 문서에 둔다. 표의 한도가 계약 값이다.

| 한도 | 값 | 이유 |
| --- | --- | --- |
| 직렬화한 값 | 1048576바이트 | `JSON.stringify`한 값의 UTF-8 바이트 길이다. 선언된 UI snapshot마다 UI thread에서 파싱하고 검사한다. |
| 루트 요소 | 64 | 다른 한도와 같이 main page가 선언된 UI snapshot 하나에 하는 일이다. |
| list 항목 | list마다 1000 | list 하나가 선언된 UI snapshot마다 그리는 행을 제한한다. |
| tree 노드 | tree마다 5000 | tree 하나가 선언된 UI snapshot마다 그리는 노드를 제한한다. |
| tree 단계 | 16 | section 안에서 tree의 들여쓰기를 제한한다. |
| 텍스트 필드 | 500 코드 포인트 | section 안 텍스트 한 줄의 너비를 제한한다. |
| 키 | 128 코드 포인트 | workbench가 요소마다 보관하는 식별자를 제한한다. |
| 매개변수 키 | 객체마다 16개 | 묶기마다 보관하는 매개변수 기록을 제한한다. |
| 매개변수 키 길이 | 64 코드 포인트 | 묶기마다 보관하는 매개변수 기록을 제한한다. |
| 매개변수 문자열 값 | 1000 코드 포인트 | 묶기마다 보관하는 매개변수 기록을 제한한다. |

각 한도는 받을 때 검사한다. 키, 텍스트 필드, 매개변수의 모든 길이는 코드 포인트를 센다. 직렬화한 값은 UTF-8 바이트를 센다. 한도를 넘는 값은 잘라내지 않고 거부한다.

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
| `tree` 가지의 펼침 제어 | `core.declared-ui.tree.expand` | `{status, tree, path, expanded}` |
| 사이드바 section 머리 | `core.sidebar.section.fold` | `{sidebar, section}` |

선언된 UI 값의 명령 이름은 `<plugin>.<name>`이며, `<plugin>`은 status의 plugin이다. core의 이름이나 다른 plugin의 이름은 거부한다. plugin 값은 자기 plugin의 명령만 이름으로 지정하기 때문이다. 선언되지 않은 이름은 사용자가 요소를 누를 때가 아니라 선언된 UI snapshot을 받을 때 거부한다. binder가 표시 시점에 선언되지 않은 이름을 거부하기 때문이다([노출](exposure.ko.md#사용자-인터페이스)).

`core.declared-ui.tree.expand`는 `packages/workbench/exposure.json`에 그 처리기와 함께 선언한다. 이 명령은 설정 연산이다. 같은 인수로 다시 실행해도 한 번 실행한 것과 같은 결과다. `expanded` 인수는 제어가 요청하는 상태이며, 그릴 때 가지가 보이던 상태의 반대다. 명령은 `status`의 트리 `tree`에서 `path`에 있는 가지의 유지 상태를 설정하며, plugin에는 전달하지 않는다. `path`는 tree의 루트 노드에서 가지까지의 노드 key 배열이다. 그려진 가지가 없는 `path`, 또는 그려지지 않은 `status`나 `tree`는 `tree <tree> path <path> is not drawn`으로 명령을 실패시킨다. 그 메시지의 `<path>`는 문자열의 JSON 배열이다.

요청은 제어가 요청하는 `expanded` 값을 담으며, 이는 workbench가 그릴 때의 유지 상태와 반대다. 같은 요청을 되풀이하면 같은 상태를 설정한다.

비활성 요소(`enabled: false`)는 `disabled` 속성으로 그려지므로 어떤 클릭도 그 묶기에 닿지 않는다.
네이티브 `button` 요소를 가지는 요소는 `button`, `command`가 있는 list 항목, `command`가 있는 tree 노드, tree 가지의 펼침 제어다. 정적 list 행과 status line은 button을 가지지 않는다.


DOM 이름. 선언된 UI 값이 그리는 control은 모두 DOM 이름 `core.sidebar.section.control`과, 루트 요소의 `key`를 담은 속성 `data-key`를 가진다. list 항목과 tree 노드의 control은 `data-path`(루트 요소 아래의 key들의 JSON 배열)와 `data-role`(`label` 또는 `expand`)도 가진다. `command`가 없는 잎 노드는 두 속성 집합을 모두 갖지 않는다. `command`가 없는 가지는 펼침 제어의 속성만 가진다. 조작할 수 없는 요소, 예컨대 정적 list 행이나 status line은 둘 다 갖지 않는다. section 머리는 `core.sidebar.section.header`를 가진다([plugin](plugins.ko.md#섹션)). 사이드바가 이미 쓰는 이름이므로, 선언된 section과 모듈 section은 같은 방식으로 감사된다. 선언된 요소는 자기 종류의 DOM 이름을 따로 갖지 않는다. 종류는 값에 있다.

선언된 section의 control에 대한 요청은 section id와 그 속성으로 지정한다. `data-key`는 루트 요소의 key다. `data-path`(list 항목과 tree 노드)는 루트 요소 아래의 key들의 JSON 배열이며, button의 control은 `data-path`를 갖지 않는다. `data-role`(list 항목과 tree 노드)은 `label` 또는 `expand`다. 키는 형제 사이에서 유일하고 역할은 tree 노드의 두 control을 구별하므로, section id와 이 속성들은 유일한 주소다.

키보드 조작은 네이티브 `button` 요소를 쓰므로, Enter와 Space가 같은 묶기를 거쳐 명령에 닿는다. 선언된 UI 요소는 자기 키 처리기를 가지지 않는다.

## status 대응

선언된 UI status는 선언된 UI snapshot을 거쳐 다음과 같이 그려진다.

- 받아들인 선언된 UI snapshot마다 그 status의 트리를 대체한다. 요소는 key 경로로 맞춰서 workbench 상태를 유지한다.
- workbench는 status, tree key, 루트부터의 노드 key 경로로 가지마다 펼침 상태를 보관한다. 사용자는 `core.declared-ui.tree.expand`로만 유지된 상태를 설정한다. 받아들인 값도 아래 규칙으로 유지된 상태를 설정한다.
- 받아들인 값에서, 기준(baseline)의 `expanded`와 다른 가지는 plugin의 값을 받고, 유지된 상태를 그 값으로 바꾼다. `expanded`가 바뀌지 않은 가지는 유지된 상태를 그대로 둔다. 기준이 있으면 기준의 그 경로에 가지가 없을 때 가지는 새 것이다. 기준이 없으면 유지된 상태가 없는 가지가 새 것이다. 새 가지는 plugin의 값을 받고, 새 것이 아닌 가지는 유지된 상태를 유지한다.
- 거부된 값은 유지된 상태를 바꾸지 않는다. 기준은 마지막 거부나 출처 변경 이후에 받아들인 마지막 값이다. 거부와 출처 변경은 기준을 없앤다. 기준이 없으면 유지된 상태가, 받아들인 값에서 가지인 경로 가운데 유지된 상태를 가진 모든 경로에서 이긴다.
- 잎 노드가 된 경로는 기준이 있든 없든 유지된 상태를 잃는다. 새 가지는 기준이 있든 없든 plugin의 `expanded` 값을 받는다.
- pull 응답의 `value`가 `null`이면 출처에 아직 값이 없다는 뜻이다. section은 출처의 첫 push까지 비워진 채로 남는다. pull 응답의 `seq`는 출처의 마지막 선언된 UI snapshot의 seq이며, `value`가 `null`이면 0이다. 출처에서 마지막으로 받아들인 값의 `seq`보다 `seq`가 낮은 pull 응답은 검사 없이 버린다. 그 밖의 `null`이 아닌 pull 응답은 검사 규칙을 따른다.
- `selected`에는 유지된 상태가 없다. 이를 바꾸는 core 명령이 없으므로, plugin의 값이 받아들인 모든 값에 적용된다.
- 유지된 상태는 받아들인 값에 그 경로가 없을 때 지운다. plugin 프로세스의 재시작은 프로세스 종료인 전이 (d)와, 새 프로세스의 등록인 전이 (a)로 처리하며, 그 출처 변경은 전이 (b)와 (c)로 처리한다. 유지된 상태는 경로별로 살아남는다.
- 유지된 상태는 공간이나 프로젝트에 저장하지 않는다. main page를 다시 불러오면 plugin의 값으로 되돌아간다.
- 선언된 status는 plugin 프로세스가 제공한다. workbench는 그 status를 등록한 첫 선언된 status 출처에서 값을 읽는다. 첫째, 사이드바를 가진 카드의 활성 탭의 view이며, 그 view의 페이지가 status를 등록했을 때다. 카드 사이드바에서는 그 사이드바를 가진 카드다. 고정 창 사이드바에서는 plugin override([외부 사이드바](external-sidebars.ko.md#오버라이드-컨텍스트와-레일-보더))가 적용되는 동안 `core.sidebars`가 보고하는 포커스된 내용 카드와 그 활성 탭이며, plugin override가 적용되지 않으면 이 단계를 건너뛴다. 둘째, plugin의 plugin host이며 plugin이 host를 가질 때만 있다. 그 밖에는 누군가 등록할 때까지 section을 비운다. 상태 모듈의 등록은 선언된 UI status를 제공하지 않는다. 상태 모듈만 등록하는 선언된 UI status는 출처가 없으며, 그 section은 비워진다. 프로세스는 자기 페이지가 `page.exposure.register("status", name)`을 부르면 status를 등록하며, 등록은 그 프로세스의 것이다. 선언된 status 출처는 프로세스와 그 프로세스의 status 등록의 짝이다. 출처가 바뀌는 것은 다른 짝이 되는 것이다. 같은 프로세스가 같은 status를 다시 등록하는 것은 바뀜이 아니다.

출처가 바뀌는 규칙은 다음과 같다.

- (a) 사이드바 카드의 활성 탭, 고정 창 사이드바의 포커스된 카드, 또는 등록이 바뀌거나, 고정 창 사이드바의 plugin override가 적용되기 시작하거나 멈추면 출처를 다시 고른다.
- (b) 출처가 바뀌면 새 출처의 첫 값을 받아들일 때까지 section을 비운다. 유지된 상태는 경로별로 살아남는다([status 대응](#status-대응)).
- (c) 출처가 바뀌면 workbench는 새 출처의 현재 값을 한 번 pull한다. workbench는 고른 출처에서 pull하는 것을 메인 페이지 load 때, 출처가 바뀔 때, 방향이 바뀔 때만 허용하며, 다른 때는 허용하지 않는다. 실행 중인 view는 마지막 값을 새 독자에게 보낼 다른 수단이 없기 때문이다. pull한 값은 push된 선언된 UI snapshot과 같은 검사와 거부 규칙을 따른다.
- (d) 프로세스가 끝나면 그 등록을 지우고, 출처를 (a)처럼 다시 고른다.
- 선택된 출처가 아닌 짝에서 온 선언된 UI snapshot은 확인 응답한 뒤 검사 없이 버린다. 선택된 출처가 아닌 짝에서 온 pull 응답, 또는 `seq`가 출처에서 마지막으로 받아들인 값의 `seq`보다 낮은 pull 응답은 검사 없이 버린다. 트리, 기준, 유지된 상태, 오류 표시 중 어느 것도 바꾸지 않는다.

- 첫 받아들인 값 전에는 section이 트리를 보이지 않는다. 그 전에 보일 수 있는 내용은 거부 텍스트뿐이며, 거부된 값 뒤에만 보인다.
- 선언된 UI 값은 변경 흐름이 아니다. plugin은 어떤 요소가 바뀌어도 값 전체를 다시 보낸다.
- 메인 페이지가 load되면 workbench는 각 선언된 status의 현재 값을 그 status의 출처로 고른 곳에서 한 번 pull한다.

## 사이드바 section 형태

사이드바 section은 `plugin.json`에서 정확히 두 형태 가운데 하나로 선언한다([plugin](plugins.ko.md#섹션)). `module` 또는 `status`다. section은 `id`, `name`, 둘 중 하나, 선택 필드 `fill`을 선언한다. `fill: true`는 [plugin](plugins.ko.md#섹션)이 모듈 section에 주는 뜻과 같다. 펼친 section은 다른 section이 남긴 사이드바 높이를 나누어 갖고, 본문은 그 안에서 스크롤한다.
`status` 형태의 사이드바 section은 선언된 UI다. 뷰가 필요한 plugin은 카드 표면을 선언하고, 사이드바는 그 plugin의 명령이면서 카드 표면을 여는 `button`을 가진다.

- `module`을 가진 section은 그 모듈이 그린다. workbench는 모듈을 적재하고 section 요소에서 `mount(root, context)`를 부른다.
- `status`를 가진 section은 그 status의 선언된 UI 값으로 그린다. status는 같은 plugin의 status이어야 하며, `exposes.status`가 선언해야 한다.
- 두 필드가 모두 있거나 둘 다 없는 section은 `section <id> declares both module and status` 또는 `section <id> declares neither module nor status`로 거부한다. plugin의 status가 아닌 `status`는 `section <id> status <name> is not a status of plugin <plugin>`으로 거부한다. `exposes.status`는 `plugin.json`의 `exposes.status` 항목만 뜻한다.
- status 하나는 section 하나만 뒷받침한다. 같은 status를 이름 댄 두 번째 section은 manifest를 읽을 때 `status <plugin>.<name> backs section <first> and section <second>`로 거부한다. 이 검사는 manifest에서 하므로 값에 의존하지 않는다.

선언된 section은 루트 요소를 본문 안에 순서대로 그린다.

- 세로 방향에서는 요소를 위에서 아래로 쌓는다.
- 가로 방향에서는 요소를 왼쪽에서 오른쪽으로 한 행에 놓고, section 너비에서 줄바꿈한다. 가로 section의 `tree`는 값 검사로 `<tree의 포인터>: tree cannot be drawn in a horizontal section`이라고 거부한다. section의 방향은 값을 받아들일 때 알려지므로 이 검사는 값 검사다.
section의 방향이 바뀌면 방향 검사를 받아들인 값에 다시 한다. 검사에 실패한 값은 [거부](#거부)의 행으로 거부하며, 그 tree는 지우고 section은 비운다. 방향이 바뀌면 workbench는 출처의 현재 값을 출처가 바뀔 때처럼 한 번 pull한다. 이전 방향에서 버린 값은 새 방향에서 유효할 수 있고, 그 값을 가진 것은 출처뿐이기 때문이다.

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

모든 거부 텍스트는 `<포인터>: <이유>` 형식이다. 표의 각 행의 포인터는 그 행을 어기는 값이며, 포인터 열이 이를 정한다. 개수나 크기 한도는 초과한 배열, 객체, 문자열을 가리킨다. 필드의 존재를 다루는 행(`unknown field`, `missing`, `requires command`)은 그 필드를 가진 객체를 가리킨다. 필드 값을 다루는 행은 그 필드를 가리킨다. 중복 키는 두 번째 키를 가리킨다. `/`는 루트와 직렬화한 값 전체다. `<field>`는 JSON 필드 이름이다. 포인터는 JSON Pointer(RFC 6901)다. `<owner>`는 status의 plugin id다.
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
| `kind`가 없는 요소 | `missing kind` | 그 요소 |
| `kind`가 문자열이 아님 | `kind must be a string` | 그 요소 |
| 표에 없는 `kind` 값 | `unknown kind <value>` | `kind` 값 |
| list의 항목이 1000개를 넘음 | `exceeds 1000 items` | `/elements/<i>/items` |
| tree의 노드가 5000개를 넘음 | `exceeds 5000 nodes` | `/elements/<i>/nodes` |
| tree 노드가 16단계를 넘음 | `exceeds 16 levels` | 그 노드 |
| 텍스트 필드가 500 코드 포인트를 넘음 | `exceeds 500 code points` | 그 텍스트 필드 |
| 키가 128 코드 포인트를 넘음 | `exceeds 128 code points` | 그 키 |
| 키가 키 규칙에 맞지 않음 | `key must be 1 to 128 code points of A-Z, a-z, 0-9, ., _, : or -` | 그 키 |
| `params` 객체의 키가 16개를 넘음 | `exceeds 16 keys` | `params` 객체 |
| 매개변수 키가 64 코드 포인트를 넘음 | `exceeds 64 code points` | 그 매개변수 키 |
| 매개변수 문자열 값이 1000 코드 포인트를 넘음 | `exceeds 1000 code points` | 그 매개변수 값 |
| 매개변수 값이 문자열, 유한한 숫자, 불리언, `null`이 아님 | `params values must be string, number, boolean or null` | 그 매개변수 값 |
| 객체가 나열하지 않은 필드(루트, 요소, list 항목, tree 노드) | `unknown field <field>` | 그 객체 |
| 필수 필드가 없음 | `missing <field>` | 그 객체 |
| list 항목이나 tree 노드에 `command` 필드 없이 `params` 또는 `enabled` 필드가 있음 | `<field> requires command` | 그 객체 |
| 필드의 형이 맞지 않음 | `<field> must be <type>` | 그 필드 |
| 텍스트 필드에 제어 문자가 있음 | `<field> contains a control character` | 그 필드 |
| 형제 사이, 또는 list 항목 사이에 같은 키가 있음 | `duplicate key <key>` | 두 번째 키 |
| `command` 이름에 소유자가 없음(`.`이 없음) | `command <name> must be named <owner>.<name>` | `command` 필드 |
| `command` 이름의 소유자가 core이거나 다른 plugin임 | `command <name> is not a command of plugin <owner>` | `command` 필드 |
| `command` 이름이 선언되지 않음 | `undeclared command <name>` | `command` 필드 |
| 아이콘 이름이 core 아이콘 표에 없음 | `unknown icon <name>` | `icon` 필드 |
| 잎 노드에 `expanded`가 있음 | `expanded is allowed only on a branch` | `expanded` 필드 |
| 가로 section의 `tree` | `tree cannot be drawn in a horizontal section` | 그 tree |

manifest에 관한 거부, 즉 section 형태와 한 status 한 section 규칙은 값의 포인터가 아니라 manifest를 읽을 때 보고하며, 이유는 [사이드바 section 형태](#사이드바-section-형태)에 있다.

## 용어

용어는 [용어 목록](terms.ko.md)에 있다. 선언된 UI, 선언된 UI snapshot, 선언된 UI 값, 선언된 요소, 선언된 status line, 선언된 UI 스키마, 선언된 UI status, 가지, 선언된 section이다.
