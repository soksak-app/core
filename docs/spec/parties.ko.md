# Parties

[English](parties.md)

party는 서로 닿은 둘 이상의 내용 카드를 하나의 외곽선으로 묶고, 그중 한 카드를 leader로 표시하며, 색을 가진다. 이 명세는 party 규칙, party 명령과 그 응답, party와 카드 조회, party 상태, `projects.json`의 party 저장, 카드 메뉴를 정의한다. 닿음은 [외부 사이드바](external-sidebars.ko.md#오버라이드-컨텍스트와-레일-보더)의 rail 기준을 쓴다. 저장은 [projects](projects.ko.md#저장)의 카드와 space 배치를 따르고, 그리기는 [네이티브 surface](native-surfaces.ko.md#인수-기준)의 네이티브 frame 규칙을 따른다. 모든 명령과 상태는 [노출](exposure.ko.md)에 선언되고 노출된다. 명령줄과 에이전트 skill은 [명령줄](cli.ko.md#레이아웃에-동작하기)의 규칙을 쓴다.

## 규칙

- party는 서로 닿은 둘 이상의 내용 카드다. 두 카드는 그 변이 선언된 통로 간격을 사이에 두고 맞닿을 때 닿는다. 이는 rail이 쓰는 기준이다([rail](external-sidebars.ko.md#오버라이드-컨텍스트와-레일-보더)). 한 party의 카드들은 하나의 연결된 묶음을 이룬다. 연결되지 않은 카드 집합은 거부한다.
- space에는 party가 몇 개든 있을 수 있다. 카드는 한 party에만 속하므로 외곽선끼리 겹치지 않는다.
- 고정 창 사이드바는 party에 들어갈 수 없으며 거부한다.
- party의 leader는 그 party의 카드 한 장이거나 없다.
- party는 테두리 색, leader 테두리 색, leader 표시를 가진다. leader 테두리 색은 `#rrggbb` 값이다. leader 표시는 leader 카드 머리의 element `core.party.leader`다.
- 각 테마는 party 색 여섯 개, 즉 테마 token `party-1`부터 `party-6`까지, 와 leader 색 하나, 즉 테마 token `party-leader`를 선언한다. 이 색들은 각각 그 테마의 rail 색과 다르다.
- party 테두리 너비는 `theme-rail-w`와 같다. 획은 기기 픽셀 위에 놓인다. 외곽선을 테두리 너비의 절반만큼 안쪽으로 옮기며, 이는 rail과 같다([그리기](#그리기)).

## 식별과 값

- 카드는 그 space 배치의 카드 `id`인 배치 식별자로 식별한다([배치 case](cases/layout/grid.json)).
- party는 `p<n>`으로 식별한다. `<n>`은 party를 만들 때 그 space의 어떤 party도 쓰지 않는 가장 작은 양의 정수다. 식별자는 party가 있는 동안 바뀌지 않는다.
- party 색은 항상 `#rrggbb` 값이다. 새 party는 `party-1`부터 `party-6`까지 중 그 space의 다른 party가 쓰지 않는 첫 색을 목록 순서대로 받으며, 여섯 개가 모두 쓰이면 그 여섯 개 중 첫 색을 받는다. 받은 값은 party에 저장되어 다시 열어도 유지된다. 사람이 고른 색은 고른 그대로 쓰며 정규화하지 않는다.
- leader 색은 사람이 고른 `#rrggbb` 값이거나 `null`이며, `null`이면 테마 token `party-leader`를 따른다.
- 카드 목록에는 중복이 없다. 한 명령에 같은 카드가 두 번 나오면 거부한다.

## 명령

모든 명령은 멱등이다. 같은 상태에서 같은 요청은 같은 응답을 주고 두 번째로는 아무것도 바꾸지 않는다. 거부된 명령은 아무것도 바꾸지 않는다. 각 명령은 명령줄, MCP 도구, 화면에서 같은 방식으로 실행된다.

| 명령 | 입력 | 응답 | 비고 |
| --- | --- | --- | --- |
| `core.party.create` | `{cards, color?, leader?, leaderColor?, take?}` | `{party, taken, changed}` | `take`가 true가 아니면 다른 party에 속한 카드는 거부한다. `cards`가 기존 party의 카드 집합과 정확히 같으면 그 party를 `changed: []`와 함께 돌려준다. |
| `core.party.update` | `{party, color?, leader?, leaderColor?}` | `{party, changed}` | `leader: null`은 leader를 없앤다. `leaderColor: null`은 leader 색을 `party-leader`를 따르게 한다. |
| `core.party.add` | `{party, card, take?}` | `{party, taken, changed}` | party에 닿는 카드를 더한다. party에 이미 있는 카드는 아무것도 바꾸지 않고 `changed: []`를 돌려준다. 다른 party에 속한 카드는 `take`가 true가 아니면 거부한다. |
| `core.party.remove` | `{party, card}` | `{party, changed}` | 카드를 빼고, 남은 카드에 변경 규칙의 분할 규칙을 적용한다. |
| `core.party.delete` | `{party}` | `{party, changed}` | party를 지우고 그 카드들은 배치에 그대로 둔다. |
| `core.party.get` | `{party}` | [조회](#조회)의 party 조회 | party 하나를 읽는다. |
| `core.card.get` | `{card}` | [조회](#조회)의 카드 조회 | 카드 하나를 읽는다. party에 없어도 된다. |

`taken`은 party가 바뀐 카드마다 `{card, from}`을 담으며, `from`은 이전 party 식별자 또는 `null`이다. 목표 party에 이미 있는 카드는 나오지 않는다. `changed`는 바뀐 party마다 `{party, removed, leader, deleted}`를 담으며, `create`나 `add`가 만든 party도 포함한다. `removed`는 그 party를 떠난 카드들, `leader`는 바뀐 뒤의 leader 또는 `null`, `deleted`는 party가 더는 없으면 true다.
party가 삭제되면 `removed`는 변경 전 party의 모든 카드를 나열하며, 분할이나 take가 남긴 카드도 포함한다.

`core.party.delete`는 `party`를 `{id}`로 돌려준다. 삭제된 party의 식별자만 담는다.

거부와 그 문구. 각 문구의 표현은 [열린 결정](#열린-결정)에서 정한다.

| 조건 | 문구 |
| --- | --- |
| 카드가 배치에 없다 | `unknown card <id>` |
| 카드가 창 사이드바다 | `card <id> is a window sidebar` |
| 카드가 한 명령에 두 번 나온다 | `card <id> is listed more than once` |
| 카드가 2개 미만이다 | `a party needs at least 2 cards` |
| `create`의 카드들, 또는 `add`나 `take`의 카드가 party와 하나의 연결된 묶음을 이루지 않는다 | `cards are not touching: <ids>` |
| 카드가 다른 party에 속하고 `take`가 true가 아니다 | `card <id> belongs to party <party>` |
| `remove`의 카드가 party에 없다 | `card <id> is not in party <party>` |
| `leader`가 party에 없다 | `leader <id> is not in the party` |
| `color`가 `#rrggbb`가 아니거나, `leaderColor`가 `#rrggbb`도 `null`도 아니다 | `color must be #rrggbb`, 또는 `leaderColor must be #rrggbb or null` |
| party 식별자가 알 수 없다 | `unknown party <id>` |

검사는 표의 순서로 실행된다. 첫 실패가 오류가 되므로 한 요청은 한 오류만 낸다.

`cards are not touching: <ids>`의 `<ids>`는 요청의 카드 중 party의 어떤 member와도 닿지 않는 카드를 요청 순서대로, `, `로 구분해 나열한 것이다. party가 아직 없는 `create`에서는 요청의 첫 카드가 속한 묶음이 party이며, 나열되는 카드는 그 묶음 밖에 있는 요청의 카드다. `add`와 `take`에서는 요청이 지정한 party가 party이므로, 나열되는 카드는 요청의 그 카드다.

## Take

`take: true`는 한 명령으로 카드를 이전 party에서 목표 party로 옮긴다.

- 닿음은 옮긴 뒤의 목표 party에 대해 판단한다. 목표에 닿지 않는 카드는 위 표의 닿음 거부 문구로 거부하며 아무것도 바뀌지 않는다.
- 이전 party는 그 카드를 잃는다. 그 카드가 leader였으면 이전 party는 leader가 없고 색은 그대로 둔다.
- 이전 party의 남은 카드들이 하나의 묶음을 이루지 않으면 변경 규칙의 분할 규칙을 적용한다.
- 이전 party에 카드가 2개 미만 남으면 그 party를 지운다.
- 이동, 새 party, 이전 party 정리는 한 번의 배치 변경으로 저장되고 그려진다. 절반만 적용된 상태는 저장되지도 그려지지도 않는다.

## 배치 변경

배치 변경은 닫기, 이동, 분할, 또는 닿음을 바꾸는 크기 변경이다. 영향받은 party는 같은 변경에서 함께 고친다.

- 닫힌 카드는 그 party를 떠난다.
- party 구성원을 분할하면 새 카드는 같은 변경에서 그 구성원의 party에 들어간다. 새 카드가 그 구성원의 한 부분의 자리를 차지하기 때문이다. 분할의 두 카드는 구성원의 사각형을 덮고 서로 닿으므로, 분할은 묶음을 깨지 않는다.
- 이동으로 party에서 떨어진 카드, 또는 그 이동이 묶음을 깨는 카드는 party를 떠난다. 닫기, 이동 또는 크기 변경은 남은 카드를 둘 이상의 연결된 부분으로 남길 수 있으며, 그 카드들은 연결된 부분들로 나뉜다. leader가 있는 부분은 leader와 함께 남는다. leader가 없으면 카드가 가장 많은 부분이 남는다. 부분들의 카드 수가 같을 때만 space 순서에서 첫 카드가 앞선 부분이 남는다. space 순서는 space가 카드를 저장하는 순서다([영속성](projects.ko.md#저장)).
- 카드가 2개 미만 남은 party는 지우며, 그 카드들은 배치에 남는다.
- 각 변경은 party 상태의 `reason`에 이유 하나를 기록한다: `core.party.create`로 만든 party에는 `created`, 그 밖에는 `closed`, `split`, `moved`, `split-leader`, `split-most-cards`, `too-few`, `taken`, `removed`, `leader-removed`, `updated`.

## 그리기

- party 전체는 하나의 바깥 외곽선으로 그린다. 외곽선은 `packages/soksak`의 `outline`이 카드들의 표시된 사각형으로 만든다. 인접한 카드는 통로 간격의 절반에서 이어지며, 외곽선은 테두리 너비의 절반만큼 안쪽으로 옮긴다.
- `drawing`을 가진 layout case(`docs/spec/cases/layout/parties.json`)는 그리드 크기만큼의 plane을 point 단위로 준다. 너비는 x축의 가장 큰 선 값에 `unit`을 곱한 값이고, 높이는 y축의 가장 큰 선 값에 `unit`을 곱한 값이다. 그리드는 plane을 배치 규칙으로 나누므로, 선이 값의 `unit`배 위치에 놓이는 것은 그리드가 plane을 같은 부분으로 나눌 때뿐이다. case의 외곽선은 point 단위다.
- leader 카드가 외곽선 위에 가진 테두리 구간은 leader 색으로 그리고, leader 표시는 그 머리에 그린다.
- party 외곽선이 rail과 겹치면 rail은 바깥에, party 외곽선은 안쪽에 두고 rail 너비만큼 떨어뜨려 두 선이 겹치지 않게 한다. 포커스 표시는 party 외곽선과 무관하다.
- 요소 이름. party `<id>`의 바깥 외곽선은 요소 `path[data-party="<id>"]`이다. 그 leader 테두리 구간은 요소 `path[data-party-leader="<id>"]`이며, `stroke`가 leader 색이다. rail 외곽선은 workbench 문서의 요소 `#railPath`이다. 위 규칙을 검사하는 테스트는 `#railPath`의 `d` 값과 party 외곽선의 `d` 값을 비교한다.
- party 외곽선은 카드 chrome과 네이티브 화면과 같은 그리기 pass, 같은 transaction에서 그린다. 이는 rail에 대해 [네이티브 surface](native-surfaces.ko.md#인수-기준)의 인수 기준이 요구하는 방식이다.

## 조회

세 조회는 카드의 member 상태를 돌려준다. 세 조회는 한 카드 상태 형태와 한 코드 경로를 쓴다.

- 카드 상태는 `{card, party, leader, activeTab, tabs}`다. `party`는 카드를 가진 party 식별자 또는 `null`, `leader`는 `true` 또는 `false`, `tabs`는 탭 순서대로 `{tab, plugin, status}`의 목록이다. `status`는 그 탭의 상태 값 객체다. plugin이 `summary: true`로 선언한 상태만 담으며([노출](exposure.ko.md#항목-필드)), `--full`이면 탭의 모든 상태를 담는다. summary를 선언하지 않은 plugin의 탭은 `status: {}`다. terminal 탭의 summary는 그 탭 status의 값과 같다. core가 그 값을 복사하기 때문이다.
- `core.party.get {party}`는 `{id, cards, leader, color, leaderColor, outline, reason, members}`를 돌려준다. `members`는 카드마다의 카드 상태이며, leader가 먼저이고 나머지는 space 순서다.
- `core.card.get {card}`는 카드 상태를 돌려준다. party에 없는 카드는 `party: null`이다.
- `core.parties`는 party 조회 기록의 목록을 값으로 가지는 status다. 각 기록은 `id`, `cards`, `leader`, `color`, `leaderColor`, `outline`, `reason`을 담는다. `outline`은 닫힌 loop의 목록이며, 각 loop는 창 point 단위 `[x, y]` 점의 목록이다. 바깥 loop는 시계 방향, 구멍은 반시계 방향이다.
- `core.parties`는 party 구성이 바뀔 때만 바뀐다. 구성은 묶기, 빼기, leader, 색을 뜻한다. member 카드의 작업 상태는 그 변경에 들지 않는다. 그 상태는 탭 자신의 status를 `sok status <name> --surface <tab> --watch`로 보며([명령줄](cli.ko.md#명령)의 규정), 그래서 작업을 시작하는 terminal이 `core.parties`를 바꾸지 않는다.
- `sok status core.parties`와 MCP 도구 `status_get`은 목록 전체를 돌려준다.

## 호스트 호출

- party의 값을 바꾸는 명령은 space를 한 번 쓴다. 그 쓰기는 [영속성](projects.ko.md#저장)의 배치 쓰기이며, 그리기가 끝난 뒤에 응답한다([그리기](#그리기)).
- 감시 중인 `core.parties`의 값이 바뀌면, 그 명령의 응답 전에 페이지는 `{name, value}`를 실은 호출 `exposureChanged`를 보낸다([exposure](exposure.ko.md)). 값은 새 party 기록 목록이며, 바뀔 때마다 한 번 보낸다.
- 거부된 명령은 아무것도 쓰지 않으며, `exposureChanged`도 배치 쓰기도 보내지 않는다.
- 카드의 작업 상태 변화는 `core.parties`에 대한 `exposureChanged`를 보내지 않는다.
- project 저장은 `{kind: "patch", id, patch}`를 실은 호출 `workspace`를 보내며(`packages/workbench/host-store.js:44`), `patch`는 `{spaces, activeSpaceId, named}`이다(`packages/workbench/projects.js:438`, `projects.js:443`에서 보낸다). `spaces`는 페이지가 가진 project의 space 객체 배열이며, 각 space 객체의 `parties` 멤버는 이 배열의 일부다. Go와 Rust 호스트는 받은 `spaces`를 그대로 저장한다(`packages/host/go/src/workspace.go:541`, `packages/host/rust/src/workspace.rs:549`).

## 창 설명

`sok describe`와 `window_describe`는 창의 party 목록으로 시작한다. 목록은 `core.parties`와 같은 party 기록이다. 배치의 카드마다 카드 상태의 `party`와 `leader`를 담고, 탭마다 카드 상태와 같은 `status`를 담는다. 설명은 탭마다 summary를 담으며, `--full`은 탭마다 모든 상태 값을 준다([창 설명](cli.ko.md#창-설명)).

Surface 설명, `window_describe {surface}`는 snapshot의 surface 그룹만 읽으므로 `parties` 멤버와 카드 상태 필드를 갖지 않는다.

## 저장

- `projects.json`의 space 객체는 `parties` 멤버를 가지며, 이는 `{id, cards, leader, color, leaderColor}`의 배열이다. `leader`는 카드 식별자 또는 `null`이고, `color`는 `#rrggbb` 값이며, `leaderColor`는 `#rrggbb` 값 또는 테마 token을 따르는 `null`이다.
- 저장에는 이유와 외곽선을 두지 않는다. 둘 다 파생 값이다.
- `parties`가 없는 space 객체는 `parties: []`로 읽는다. 이는 선택 필드가 없을 때의 선언된 빈 기록 기본값이다([영속성](projects.ko.md#저장)). space를 저장하면 항상 `parties`를 쓰며, party가 없으면 `[]`를 쓴다. `parties`에 명시적 `null`이 있거나 다른 형식의 값이면 파일 `projects.json`, project 루트, space 식별자, 발견한 내용을 적은 오류로 실패하며 파일을 바꾸지 않는다.
- 규칙을 어기는 party 기록도 거부한다. 카드 2개 미만, 두 party에 든 카드, 배치에 없는 카드, cards 밖의 leader, 잘못된 색이 여기 해당한다.
- [설정](settings.ko.md#값)이 거부하는 `rail`과 `railWidth` 키는 계속 거부한다.
- 저장 규칙의 진입점은 `packages/workbench/projects.js`에 있다. `readStoredSpace(project, space)`는 `parties` 배열을 가진 space를 반환하며, 멤버가 없으면 `[]`이고, `null`이거나 배열이 아닌 값, 또는 규칙을 어기는 party 기록이면 `Error`를 던진다. 그 텍스트는 `projects.json: project <root>, space <space id>: parties <found JSON text>`이며, 발견한 값은 JSON 텍스트로 보인다. `writeStoredSpace(space)`는 저장할 space 객체를 반환하며, 항상 배열인 멤버 `parties`를 가진다.

## 카드 메뉴

내용 카드의 메뉴는 아래 항목을 가진다. 각 항목은 주어진 이름의 element이며 주어진 명령을 실행한다.

| Element | 명령 | 표시 조건 |
| --- | --- | --- |
| `core.party.menu.group` | 카드의 그룹 선택기를 열며, 그 확인 항목은 카드와 고른 닿은 카드들로 `core.party.create`를 실행한다 | 카드가 어떤 party에도 없고 party에 없는 닿은 카드가 있다 |
| `core.party.menu.leader` | `leader`를 카드로 또는 leader를 없애려고 `null`로 하여 `core.party.update` | 카드가 party에 있다 |
| `core.party.menu.color` | `color`를 여섯 테마 토큰 `party-1`부터 `party-6`까지 중 하나로 하여 `core.party.update`; 사람은 party 색을 이 여섯 중에서 고른다 | 카드가 party에 있다 |
| `core.party.menu.take` | 카드와 `take: true`로 `core.party.add` | 카드가 닿은 다른 party에 속해 있다 |

그룹 선택기는 party에 없는 닿은 카드들을 나열하는 picker 레이어다. 나열된 카드를 누르면 그 카드를 고르거나, 이미 고른 카드이면 고르기를 푼다. 레이어는 선택 표시와 함께 다시 열린다. 카드를 하나 고르면 레이어에 확인 항목이 나타나며, 이 항목은 카드와 고른 카드들로 `core.party.create`를 실행하고 레이어를 닫는다. 카드를 누르는 것만으로는 party가 만들어지지 않는다.

take 항목은 들어갈 party를 이름으로 보여준다. take가 이전 party를 지우면, 즉 이전 party에 카드가 2개 미만 남으면, 그 항목이 이를 밝힌다. 메뉴는 확인을 묻지 않는다. party 변경은 카드 내용을 지우지 않는다.

## 열린 결정

- 각 테마의 party 색 `party-1`부터 `party-6`까지와 leader 색 `party-leader`. 사람이 보는 색이다.
  결정: 각 테마는 이 일곱 token을 자기 팔레트에 선언하며, 각 색은 그 팔레트의 `rail` 항목과 다르다. midnight dark 팔레트는 `party-1` `#a06ce0`, `party-2` `#e06cac`, `party-3` `#e0a06c`, `party-4` `#ace06c`, `party-5` `#6ce0a0`, `party-6` `#6cace0`, `party-leader` `#e0da6c`를 선언하며, `rail`은 `#7279ff`다. 팔레트 선언은 `packages/workbench-mygo/src/workbench.json`에 있다.
- 메뉴 항목의 이름과 take 항목의 문구, 사라지는 이전 party를 알리는 문구. 사람이 읽는다.
  결정: 메뉴 이름은 한국어다. 묶기는 `카드 묶기`이며, 고르는 레이어는 `묶을 카드 고르기`를, 확인 항목은 `카드 N개 묶기`를 쓴다. 대표는 `대표 카드로 지정` 또는 `대표 카드 해제`, 색은 `색 1`부터 `색 6`까지, 합치기는 `파티 p1에 합치기`이며, 이전 party p2가 사라지면 `, 파티 p2가 사라짐`을 붙인다.
- [명령](#명령)의 표에 있는 거부 문구와 저장 거부 문구. 사람이 읽는다.
  결정: 표의 거부 문구를 그대로 둔다. 기존 명령 오류(`unknown card <id>`, `no menu is open`)와 같이 소문자 영어로, 마침표 없이, 대상과 식별자를 앞에 쓴다. 저장 거부 문구는 `projects.json: project <root>, space <space id>: parties <found JSON text>`이다.

