# Group card

[English](groups.md)

group card는 space grid의 사각형 하나를 가리키고 그 안의 card를 담는다. 이 명세는 space의 group tree, 각 level의 leader, group header, command `core.group.*`, `core.layout`, `core.grid`, `core.card.get`과 창 설명의 group member, `projects.json`에 저장되는 group tree의 형태, group 그리기를 소유한다. space의 grid는 layout library의 규칙([soksak](../../packages/soksak/docs/layout.md))을 따른다. card command와 layout operation은 [layout에 대한 동작](cli.ko.md#레이아웃에-동작하기)을, 선언은 [노출](exposure.ko.md)을 따른다.

## 범위

card와 tab의 구조는 지금 그대로다. content card, 그 tab, card와 tab의 command, status, element, 그리고 저장되는 grid는 계약을 유지하며, `packages/soksak`은 바뀌지 않는다. space는 line 집합 하나를 가진 grid 하나를 유지한다. 더해지는 것은 group card 하나다. group card는 grid 옆에 저장되는 tree의 node이며, cell이 그 grid의 사각형 하나를 이루는 card 집합을 가리킨다. 이 명세는 group card가 더하는 것과 기존 command가 group 안의 card에 닿는 방법만 말한다. group 안의 content card는 다른 card와 같은 grid의 content card다.

## 모델

- space는 layout library의 grid 하나를 가진다. 곧 `packages/soksak`의 `toJSON`이 주는 상태 `{xs, ys, cards, paidBy}`이며, 그 card는 content card와 window sidebar([external window sidebars](external-sidebars.ko.md))다. layout library의 R1이 모든 경계에 대해 말하듯 grid의 각 line은 group 안팎을 가리지 않고 space 전체를 가로지르는 line 하나다.
- group card는 space group tree의 node다. 식별자, 이름, leader, 그리고 member를 가진다. member는 grid의 content card와 group card이며 둘 이상이다. window sidebar는 member가 아니다. 각 content card와 group card는 많아야 group card 하나의 member다. 어떤 group card의 member도 아닌 card는 root level의 member다.
- group card의 사각형은 그 안의 content card, 곧 그 member와 그 안의 group card의 member가 가진 가장 작은 첫 line부터 가장 큰 마지막 line까지의 line index span `[c0, c1) × [r0, r1)`이다. group card는 사각형 하나를 덮는다. 곧 그 안의 content card의 cell이 정확히 그 사각형의 cell이므로, grid의 다른 card는 그 사각형의 cell을 갖지 않는다. group card의 사각형은 그것을 담은 group card의 사각형 안에 놓인다.
- root level의 level은 0이고, group card의 member의 level은 그 group card의 level에 1을 더한 값이다. level은 tree에서 도출되며 저장되지 않는다.
- space가 group card를 가진 동안 workbench가 grid에 하는 모든 operation은 `tidy`로 끝나며 `paidBy` 기록을 남기지 않는다. 따라서 close하거나 move하는 card는 [닫기](#닫기)가 고르는 이웃에게 자기 cell을 주고, 남은 card가 쓰는 모든 line은 자기 좌표를 유지한다. group을 가진 layout은 이 형태로 저장된다.
- card의 식별자는 그 space에서 card 하나를 가리킨다. content card와 group card는 식별자를 한 sequence에서 받는다. 곧 `card-<n>`이며, `n`은 layout이 저장하는([저장](#저장)) 그 space가 낸 가장 큰 card 번호 `lastCard`보다 1 크다. 그래서 space는 끝난 식별자를 재시작 뒤에도 다시 내지 않는다. card는 group 안팎으로 옮겨도 식별자를 유지하며, card를 가리키는 모든 command(`core.layout.open`, `core.layout.select`, `core.layout.close`, `core.card.*`, `core.tab.move`, `core.group.*`)는 활성 space의 어느 level의 card든 받는다.
- group이라는 낱말 하나는 이름 `core.group.*`, `core.card.group`과 이 명세의 기록의 member `group`에서만 group card를 가리킨다. `core.picker` item의 member `group`과 창 snapshot의 groups는 원래 뜻을 유지한다.
- level의 reading order는 member를 card 또는 group card 사각형의 첫 row line `r0`, 다음으로 첫 column line `c0` 순으로 정렬한다. 이 순서는 layout library의 R2가 요구하듯 배열 순서가 아니라 line으로 정해진다. card의 workbench order는 root level의 reading order이며, 각 group card는 그 member의 reading order 앞에 선다.

### 그리는 사각형

layout library는 grid의 각 card의 사각형을 준다(R5). group card는 그 안 card를 두르는 frame이며, workbench는 library에 모든 content card의 frame(R5의 `setFrames`)을 준다: 그 왼쪽, 오른쪽, 아래쪽마다 그것을 담고 그쪽 line에서 끝나는 group card의 수다. group card의 header가 그 frame 안 맨 위에 서므로 위쪽은 frame을 갖지 않는다. 그래서 두 상자 사이의 모든 거리는 gap이다: content card는 그것을 담는 각 group card의 frame 안쪽으로 gap 하나만큼, frame은 그것을 담는 frame 안쪽으로 gap 하나만큼, line 양쪽의 두 상자는 gap 하나만큼 떨어지므로, line의 corridor는 gap 하나에 그 위 frame마다 gap 하나를 더한 것이다. group card의 header는 그 frame 안 위쪽을 가로지르는 card head 높이(chrome metrics의 `head-h`, [layout 값](settings.ko.md#배치-값)) 한 줄이며, 위 line을 공유하는 group card의 header는 가장 바깥 것부터 아래로 쌓인다. header는 card처럼 layout의 상자이므로, corridor `gap`이 그것을 그 아래의 모든 상자, 곧 nested header, 테두리, card와 떼어 놓는다. 그래서 content card는 그것을 담고 그 첫 row line에서 시작하는 group card의 header 아래에 그려진다. 그 그리는 사각형은 library의 사각형을 `k` × (`head-h` + `gap`)만큼 아래로 옮기고 그만큼 줄인 것이며, `k`는 그런 group card의 수다. 한 line 위에서 그쪽 변이 같은 수의 frame 안에 서는 두 card는 같은 좌표에 그려진다. group card의 그리는 사각형은 그 frame이다: 그 line 사이의 사각형을 각 line에서 그 corridor와 그것을 담고 그 line에서 끝나는 group card마다 gap 하나만큼 줄이고, content card처럼 그것을 담고 그 첫 row line에서 시작하는 group card의 header만큼 아래로 옮기고 줄인 것이다. 그 header는 그 안 맨 위 `head-h` 높이의 한 줄이며 그 폭 전체에 걸친다. 최소 크기와 split이 비교하는 그리는 높이는 이 높이다.

### 최소 크기

content card는 두 축에서 적어도 `minSize`로 그려진다. layout library는 자기 사각형에 대해 이 한계를 지킨다. header는 card를 짧게 그리므로, workbench는 각 operation(split, close, insert, move, balance, arrange, 경계 drag, group 변경)을 오늘의 drop 미리보기처럼 먼저 grid와 group tree의 복사본에 적용하고, 그 operation이 바꾸는 content card가 어느 축에서 `minSize`보다 작게 그려지면 그 operation을 거부한다. window 크기 변경이 이미 작게 남긴 card는 그 card를 바꾸지 않는 operation을 거부하지 않는다. drop 미리보기와 drop 놓기는 같은 검사를 쓰므로, 검사가 거부하는 위치는 미리보기를 보이지 않고 놓아도 아무것도 바꾸지 않는다. 경계 drag는 library의 drag이며 모든 group을 가로질러 line 전체를 옮긴다. line 옆의 모든 content card가 적어도 `minSize`로 그려지는 마지막 위치에서 멈춘다. operation이 아닌 변경, 곧 window 크기 변경, `gap`, `size`, 글자 크기의 변경은 R5가 말하듯 grid의 비율을 다시 표현하고 아무것도 거부하지 않는다. 그때 card는 공간이 돌아올 때까지 최소보다 작게 그려진다.

## Leader

content card나 group card를 담는 각 level은 leader를 정확히 하나 가진다. leader는 그 member 하나이며 content card 또는 group card다. window sidebar는 leader가 되지 않으므로, 오늘 마지막 content card를 닫으면 남는 것처럼 window sidebar만 담은 root level은 leader가 없고 `leader: null`을 저장한다. 나중의 변경이 그 안에 넣는 첫 card가 그 leader가 된다.

- 새 group card는 `core.group.create`가 묶는 card를 leader로 삼으며, 그 옆의 새 card가 아니다. 새 space는 root level에서 reading order로 window sidebar가 아닌 첫 card를 leader로 삼는다.
- `core.group.create`가 level의 leader를 묶으면 새 group card가 그 card의 자리를 받으므로 그 level의 leader mark도 받는다.
- `core.group.leader {card}`는 `card`를 자기 level의 leader로 만든다. 다른 level은 바꾸지 않는다.
- level의 leader가 close나 다른 level로의 move로 level을 떠나면, reading order로 window sidebar가 아닌 남은 첫 member가 leader가 된다.
- group card를 풀 때 group card가 자기를 담은 level의 leader였으면 그 member의 leader가 그 level의 leader가 되고, 그렇지 않으면 그 level이 leader를 유지한다.
- group card는 자기 level의 leader이면서 자기 member 하나가 그 member들의 leader일 수 있다. 두 mark는 서로 독립이다.

leader는 mark다. command, focus, 그리는 순서를 바꾸지 않는다. `core.layout`과 `core.grid`는 모든 level에서 leader를 보고하며, member가 둘 이상인 level에서는 leader의 header가 card header의 기존 수단, 곧 header 버튼의 눌린 상태로 그것을 보인다([header](#header)).

## Header

header의 버튼은 그 header의 상자에 동작한다. content card header에서는 그 card, group header에서는 그 group card의 사각형이다.

| Header | Element | Command | 효과 |
| --- | --- | --- | --- |
| content card | `core.card.add` | `core.card.menu {card, menu: "add"}` | 지금처럼 card에 tab을 더한다 |
| content card | `core.card.split-x`, `core.card.split-y` | `core.card.menu {card, menu}` | 지금처럼 card 옆에 새 content card를 그 group 안에 둔다 |
| content card | `core.card.group` | `core.card.menu {card, menu: "group"}` | 새 card의 plugin menu를 연다. 그 item은 card를 새 card와 묶는 `core.group.create {card, side, plugin}`을 실행한다 |
| content card | `core.card.leader` | `core.group.leader {card}` | card를 그 level의 leader로 만든다 |
| group card | `core.group.add` | `core.card.menu {card: <group>, menu: "add"}` | 고른 tab을 담은 content card를 group 안, 그 사각형의 오른쪽 가장자리에 더한다 |
| group card | `core.group.split-x`, `core.group.split-y` | `core.card.menu {card: <group>, menu}` | group card 사각형 옆에 새 content card를 그 group card를 담은 level에 둔다 |
| group card | `core.group.wrap` | `core.card.menu {card: <group>, menu: "group"}` | 새 card의 plugin menu를 연다. 그 item은 group card를 새 card와 묶는 `core.group.create {card: <group>, side, plugin}`을 실행한다 |
| group card | `core.card.leader` | `core.group.leader {card: <group>}` | group card를 그 level의 leader로 만든다 |
| group card | `core.group.fullscreen` | `core.card.fullscreen {card: <group>}` | group card를 작업 영역 전체에 보이거나 배치를 되돌린다 |
| group card | `core.group.close` | `core.group.menu {group}` | group의 닫기 menu를 연다 |

- split은 group을 만들지 않는다. content card의 split은 새 card를 그 card를 담은 group에 넣고, group card의 split은 그 group card를 담은 level에 넣는다.
- group 버튼의 side는 그 상자의 긴 축이다. 높이보다 넓게 그려지면 `right`, 아니면 `bottom`이다. `core.card.group`과 `core.group.wrap`은 그 card의 그 side 쪽 `core.group.create`가 성공할 동안에만 보인다. `core.card.menu`는 `add`, `split-x`, `split-y` 옆에 menu `group`을 받고, 그 item은 add menu와 split menu의 plugin이다.
- `core.card.leader`는 member가 둘 이상인 level의 모든 member header에 보인다. leader에서는 눌려(`aria-pressed` true) leader mark가 되고, 다른 member에서는 눌리지 않는다. member가 하나인 level은 보이지 않는다. 이것은 기존 card header 디자인의 head 버튼이다. leader가 아닌 member에서는 card tool의 header fit을 따르므로, tool에 너무 좁은 header는 그것을 tool menu(`core.card.tools`)에 담는다. leader에서는 mark가 모든 너비에서 header에 남는다: tool이 맞지 않으면 전체 화면 toggle을 뺀 다른 tool이 tool menu로 옮겨 가고 mark는 전체 화면 toggle과 menu button 앞에 서며([card tool](example-model.ko.md#카드-도구)), header fit은 mark를 그것들과 함께 세고, tool menu는 mark를 담지 않는다.
- group header는 기존 디자인의 card header다([card layout](example-model.ko.md)). head 높이 `head-h`, head 버튼, 그 icon, card header의 theme을 쓴다. tab strip 자리에 group 이름(`core.group.name`)을 보이고, head 버튼은 content card의 head 버튼 자리에 선다. `core.card.add`, `core.card.split-x`, `core.card.split-y`의 icon을 쓰는 `core.group.add`, `core.group.split-x`, `core.group.split-y`, 이어서 `core.group.wrap`, `core.card.leader`, `core.card.fullscreen`의 icon을 쓰는 `core.group.fullscreen`, 그리고 `core.card.close`의 icon을 쓰는 `core.group.close`다. group card가 더하는 icon은 group 버튼(`core.card.group`, `core.group.wrap`)의 icon과 leader mark(`core.card.leader`)의 icon뿐이며, 둘 다 다른 card head icon과 함께 `workbench.json`의 icon에 선언된다. level은 `core.layout`과 `core.grid`에 보고되고 그려지지 않는다.
- `core.group.name`을 double-click하면 `core.rename.begin {kind: "group", id}`를 실행하고, 이름 입력 칸(`core.rename.input`)은 `core.group.rename`을 실행하는 `core.rename.commit`으로 확정한다. `core.rename.begin`은 `project`와 `space` 옆에 kind `group`을 받는다.
- group의 닫기 menu는 picker이며, item은 `core.card.close {card: <group>}`을 실행하는 그룹 닫기와 `core.group.dissolve {group}`을 실행하는 그룹 풀기다. 그 item은 `core.picker.item` 항목이며, `core.picker`는 card의 add menu를 보고하듯 그 group card와 item으로 열린 menu를 보고한다.

## Command

각 command는 그 변경을 보이는 배치 뒤에 답한다. 활성이 아닌 space나 창의 어느 space에도 없는 card나 group은 [layout에 대한 동작](cli.ko.md#레이아웃에-동작하기)의 문구로 실패한다. card나 group card가 전체 화면인 동안의 layout 변경은 전체 화면 group card 안에서도 밖에서도 `card <id>: the layout does not change while card <shown> is fullscreen; restore the arrangement first`로 실패한다. 거부된 command는 아무것도 바꾸지 않는다. 오류 문구의 크기는 가장 가까운 point로 반올림한 정수 point의 그리는 크기이며 `<w>x<h>`로 쓴다.

### Group card의 사각형

세 operation이 layout library로 group card `G`의 사각형에 동작하며, 각각은 library operation을 사각형으로 일반화한 것이다.

- `G`의 member를 한 축의 사각형 `[a, b]`에 놓을 때, `G` 안의 content card가 그 축에서 쓰는 grid의 각 line은 `G`의 span `[a0, b0]` 안의 좌표 `t`에서 `a + (b − a) × (t − a0) / (b0 − a0)`로 쓰인다. 허용 오차 없이 숫자로서 grid의 한 line의 좌표와 같은 좌표는 그 line이며(R1), 나머지는 새 line이다. `G` 안의 content card는 그 line을 받고 `G` 밖의 card는 자기 line을 유지하므로, `G` 밖의 card가 쓰는 line은 움직이지 않는다. 그 뒤 어떤 card도 쓰지 않는 line은 지우고(`tidy`), 결과는 자기가 놓은 card의 `paidBy` 항목을 남기지 않는다. 그 card의 line이 움직였기 때문이다. workbench는 그 결과를 `checkState`를 실행하는 `replace`로 설치한다.
- `G`의 사각형을 `side` 쪽으로 나누는 것은 R4의 일반화다. 사각형은 `side` 축의 가운데에서 나뉜 두 사각형으로 바뀐다. 새 card가 `side` 쪽 절반을 받고, `G`의 member는 나머지 절반에 놓인다. `cardSplit`이 `even`이면 `balance()`가 뒤따른다([split 설정](#split-설정)).
- `G`를 card 하나로 만들 때는 `G` 안의 content card를 그 사각형을 덮는 card 하나로 바꾼다. 사각형의 cell이 정확히 그 card들의 cell이므로 이것은 library의 상태다. 이것은 `G`의 close와 move에 쓰이며, move 뒤에는 member를 그 card의 사각형에 놓는다.

| Command | Parameter | 결과 | 규칙 |
| --- | --- | --- | --- |
| `core.group.create` | `{card, side, plugin, params?, request?}` | `{group, card, tab}` | content card 또는 group card인 `card`를 새 content card와 묶는다. 새 card는 `card`를 `side`(`left`, `right`, `top`, `bottom`) 쪽으로 나눈 것에서 오며, content card는 library의 split(`splitToward`), group card는 사각형의 split이고, `plugin`의 tab을 `params`로 담는다. 새 group card는 다음 card 식별자를, 새 card는 그 다음 식별자를 받고, 이름 `그룹 <n>`을 받는다. `n`은 space의 어떤 group도 이름 `그룹 <n>`으로 갖지 않는 가장 작은 양의 정수다. group card는 그 level에서 `card`의 자리와 leader mark를 받고, member `card`와 새 card를 가지며 `card`가 그 leader다. 결과는 group card, 새 card, 그 tab을 가리키고, focus는 새 card로 옮긴다 |
| `core.group.dissolve` | `{group}` | `{dissolved: true}` | group card를 그것을 담은 level에서 그 member로 바꾼다. grid는 바뀌지 않는다. group 첫 row의 card는 group이 내놓은 header만큼 길게 그려진다. dissolve의 leader 규칙이 적용된다 |
| `core.group.rename` | `{group, name}` | `{group, name}` | group의 이름을 양끝 공백을 지운 `name`으로 정한다 |
| `core.group.leader` | `{card}` | `{card, group}` | content card 또는 group card인 `card`를 그 level의 leader로 만든다. header의 leader 버튼은 그 header의 card로 이것을 실행한다. `group`은 `card`를 담은 group card의 식별자이며, root level에서는 `null`이다 |
| `core.group.menu` | `{group}` | `null` | group의 닫기 menu를 열고, 열려 있으면 닫는다 |
| `core.card.move` | `{card, target, side}` | `{card}` | drop이 하듯 content card 또는 group card인 `card`를 `target`의 `side`(`left`, `right`, `top`, `bottom`) 옆, `target`의 level로 옮기거나, `side`가 `centre`이고 `target`이 group이면 그 group 안, 그 사각형의 오른쪽 가장자리로 옮긴다. content card는 library의 move(`move`)로 옮긴다. group card는 card 하나로 만들고, 그 card를 `move`로 옮긴 뒤 member를 새 사각형에 놓는다. group으로의 move는 그 자리에서 card를 닫고 그 card로 group card에 add하는 것이다. card는 식별자를 유지한다. level을 떠나는 card의 leader 규칙이 떠나는 level에 적용된다 |

grid의 모든 operation은 각 group card를 사각형 하나로 유지한다. content card의 split은 새 card를 그 card를 담은 group에 넣으며, split은 그 group 사각형의 한 cell을 나누므로 사각형이 유지된다. 결과가 group card를 사각형 하나가 아니게 남기는 close, move, drop, insert는 거부되며, content card를 최소보다 작게 그리는 것도 거부된다.

거부는 각 command가 검사하는 순서로 다음과 같다.

| Command | 조건 | 문구 |
| --- | --- | --- |
| `core.group.create` | `card`가 window sidebar | `card <id> is a window sidebar; a group holds content cards and group cards` |
| `core.group.create` | layout이 `card`의 `side` 쪽 split을 거부 | `card <id> cannot hold a group toward <side>` |
| `core.group.create` | content card가 최소보다 작게 그려짐 | `card <id> cannot hold a group toward <side>: card <c> would be <w>x<h>, below its minimum <m>x<m>`. `<c>`는 workbench order로 그런 첫 card, `<m>`은 `minSize` |
| `core.group.create` | `request`가 1에서 128자의 문자열이 아님 | `core.group.create: request must be a string of 1 to 128 characters` |
| `core.group.create` | `plugin`이나 `params`가 거부됨 | 그 plugin이나 parameter에 대한 `core.card.split`의 문구([layout에 대한 동작](cli.ko.md#레이아웃에-동작하기)) |
| `core.group.dissolve`, `core.group.rename`, `core.group.menu` | `group`이 content card나 window sidebar | `card <id> is not a group` |
| `core.group.rename` | 양끝 공백을 지운 이름이 Unicode scalar value 1개 미만이거나 40개 초과 | `group name must be 1 to 40 characters: <name>` |
| `core.group.leader` | `card`가 window sidebar | `card <id> is a window sidebar and cannot lead a level` |
| `core.card.move` | `card`가 window sidebar | `card <id> is a window sidebar and does not move` |
| `core.card.move` | `target`이 window sidebar | `card <target> is a window sidebar; a card does not move beside it` |
| `core.card.move` | `target`이 `card`이거나 `card` 안의 card | `card <id> cannot move into itself` |
| `core.card.move` | `side`가 `centre`이고 `target`이 content card | `card <target> is not a group; a card moves beside it` |
| `core.card.move` | layout이 move를 거부 | `card <id> cannot move to <side> of <target>` |
| 모든 operation | 결과가 group card를 사각형 하나가 아니게 남김 | `card <id> cannot <operation>: group <g> would not cover one rectangle`. `<g>`는 workbench order로 그런 첫 group card |
| 모든 operation | content card가 최소보다 작게 그려짐 | `card <id> cannot <operation>: card <c> would be <w>x<h>, below its minimum <m>x<m>` |

`<operation>`은 layout 거부 문구의 operation 문구다. 곧 `split toward <side>`, `close`, `move to <side> of <target>`이다.

### Idempotency

같은 식별자로 같은 command를 두 번째 적용하면 같은 상태를 남기고 같은 결과를 돌려준다.

- `core.group.create {card, side, plugin, params}`는 `card`가 member가 정확히 `card`와 `N`인 group card `G`의 member이고, `N`이 `core.layout.open`의 규칙으로 `side` 쪽 `card`의 이웃이며, `N`이 `plugin`의 tab `T`를 `params`로 담으면 `{group: G, card: N, tab: T}`를 돌려주고 아무것도 바꾸지 않는다. `request`, 곧 한 요청의 식별자가 있으면 command는 대신 그 식별자로 멱등이다: space가 전에 답한 `request`의 반복은 첫 실행의 답을 돌려주고 아무것도 바꾸지 않으며, space가 답하지 않은 `request`는 위 규칙이 group을 찾는 곳에서도 command를 실행한다. workbench는 각 space의 요청의 답을 그 window가 열린 동안 지니며 어느 것도 저장하지 않는다. group 버튼과 `core.card.menu {card, menu: "group"}`의 항목은 누를 때마다 새 `request`를 보내므로, 각 누름은 card를 한 번 묶고 두 번째 누름은 다시 묶는다.
- 이 창이 workbench 시작 뒤 푼 group card의 `core.group.dissolve {group}`은 `{dissolved: true}`로 답하고 아무것도 바꾸지 않는다. 창은 닫힌 tab을 기억하듯([layout에 대한 동작](cli.ko.md#레이아웃에-동작하기)) 자기가 푼 group card의 식별자를 기억한다. 이 실행에서 창이 풀지 않은 식별자는 tab의 반복 close처럼 재시작 뒤에도 layout에 없는 card의 문구로 실패한다. 식별자는 두 번 나오지 않으므로 그 식별자는 다른 card를 가리키지 않는다.
- 현재 이름으로의 `core.group.rename`, 현재 leader의 `core.group.leader`, 그리고 card가 이미 move가 두는 자리(`target`의 level의 member이며 `side` 쪽 그 이웃, 또는 `centre`이면 `target`의 member로서 그 사각형의 오른쪽 가장자리에서 위부터 아래까지 닿는 자리)에 있는 `core.card.move`는 layout을 부르지 않고 같은 결과를 돌려주므로 아무것도 바뀌지 않는다.
- `core.group.menu`는 `core.card.menu`가 card menu를 토글하듯 menu를 토글한다. `core.layout`은 바뀌지 않는다.

### Group card에 대한 card command

- `core.card.add-tab {card: <group>, plugin, params?}`는 tab을 담은 content card를 group 안, 그 사각형의 오른쪽 가장자리에 더한다. 곧 새 card가 group의 member가 되는 `right` 쪽 사각형 split이며, content card와 같이 `{tab}`을 돌려준다.
- `core.layout.open {card: <group>, plugin, params?}`는 group 안의 content card 중에서 workbench order로 `plugin`과 `params`의 첫 tab을 고르고, 없으면 `core.card.add-tab`처럼 card를 더한다. `side`가 있으면 group card를 담은 level에서 그 사각형을 `side` 쪽으로 나눈다.
- 어떤 level의 card든 `core.layout.open {card, side, plugin, params?}`는 `side` 쪽 이웃을 `card`의 level의 member 중에서만 찾는다: 가장자리가 같은 line 위에 있고 같은 두 line에 걸친 다른 level의 card는 이웃이 아니므로, group의 마지막 card에서 group 가장자리 쪽으로의 open은 group 밖 card가 같은 tab을 가져도 그 card를 group 안에서 나눈다. `core.group.create`와 `side`를 가진 `core.layout.open`의 반복도 같은 규칙으로 card를 찾는다.
- `core.card.menu {card: <group>, menu}`는 group header의 add, split, group menu를 연다. content card의 menu가 content card에 실행하듯, 그 item은 group card에 `core.card.add-tab`, `core.card.split`, `core.group.create {card: <group>, side, plugin}`을 실행한다.
- `core.card.split {card: <group>, side, plugin}`은 사각형의 split으로 group card 사각형 옆에 새 content card를 둔다. 새 card는 group card를 담은 level의 member가 된다.
- `core.card.close {card: <group>}`은 group card를 그 안의 모든 card와 함께 닫는다. group card를 card 하나로 만들고 library의 close(R7)로 닫는다. `core.card.close`가 card 하나의 tab을 묻듯 수정된 각 tab을 먼저 묻고, 물은 모든 tab이 저장되거나 버려질 때까지 결과는 `closed: false`다.
- `core.card.focus {card: <group>}`은 workbench order로 group 안의 첫 content card에 focus를 둔다.
- `core.card.fullscreen {card: <group>}`은 group card를 그것이 space 전체인 것처럼 배치해 작업 영역 전체에 보인다. 그 frame은 header를 맨 위에 두고 영역을 덮으며, 그 안의 line은 모든 corridor와 frame이 gap을 지키는 채로 영역에 늘어나고, 그 안의 각 content card와 group card는 [그리는 사각형](#그리는-사각형)이 space에 대해 말하듯 그것과 전체 화면 group card 사이에 있고 그 첫 row line에서 시작하는 group card의 header 아래에 자기 header와 함께 그려진다. 다른 모든 card는 전체 화면 content card처럼 빈 사각형으로 숨고, grid의 rule과 divider는 그려지지 않는다. grid는 바뀌지 않으며, group card의 두 번째 `core.card.fullscreen`은 배치를 되돌린다. group 안의 content card는 지금처럼 혼자 전체 화면이 된다. group card가 전체 화면인 동안 layout은 전체 화면 card의 규칙대로 group card 안에서도 밖에서도 바뀌지 않으며, 그 안 card의 focus는 전체 화면을 유지한다.
- `core.layout.balance`와 card 자동 정렬 command(`cardArrange`)는 grid에 동작한다. group이 없는 space에서는 지금처럼 layout library의 balance를 실행하고, slicing 배치가 아닌 grid는 `the layout cannot balance: the grid is not a slicing arrangement`로 거부한다. `cardArrange` `even`이면 layout library의 `arrange("even")`를 실행하고, 그것은 `the layout cannot balance: no equal grid keeps every card at its minimum size`로 거부되며, 그것이 더하는 빈 card는 `lastCard`에 센다. group이 있는 space에서는 `cardArrange`의 어느 값이든 `core.layout.balance`와 `cardSplit` `even`의 balance는 각 축에 layout library의 `shareLines`를 실행한다: 모든 card의 모든 line index를 유지하고 line의 좌표만 옮기므로, 모든 group card는 자기 사각형을 유지한다: 각 축에서 free length는 plane의 extent에서 모든 slot의 corridor와 px 크기를 가진 card가 차지하는 slot의 크기를 뺀 값이며, 그 slot은 그 크기를 유지한다. 다른 모든 slot은 free length의 같은 몫을 받고, y 축에서는 그 위 line에서 시작하는 group card의 head를 그 몫 위에 더 받으므로, 그 line의 header 아래에 가장 많이 놓인 content card가 그 몫으로 그려진다. content card를 최소 아래로 그릴 balance는 `the layout cannot balance: card <id> would be <w>x<h>, below its minimum <m>x<m>`로, `cardSplit` `even`의 balance는 `card <id> cannot split toward <side>: cardSplit even would draw card <c> at <w>x<h>, below its minimum <m>x<m>`로 거부되며 아무것도 바뀌지 않는다. divider의 gesture는 command를 실행한다: drag는 그 끝에서 끝난 위치로 `core.boundary.move`를, 화살표 key는 한 걸음 떨어진 위치로 그것을, double click, Enter, Space는 line을 이웃 line 사이 가운데에 두고 `{position}`으로 답하는 `core.boundary.center {axis, line}`를 실행한다. 두 command는 line을 그것이 닿은 line에 합치므로 두 line이 한 좌표에 서지 않으며, content card를 최소보다 작게 그릴 가운데 맞춤은 line을 그 자리에 둔다.

### Split 설정

설정 `cardSplit`([값](settings.ko.md#값))은 split 뒤의 크기를 정한다. 기본값 `exact`에서 split은 나누는 상자만 나눈다. 곧 card의 사각형(layout library의 R4) 또는 group card의 사각형([group card의 사각형](#group-card의-사각형))이다. split은 grid의 사각형이 아니라 그리는 사각형을 나눈다: 위쪽 절반이 header 아래에 서는 `top` 또는 `bottom` 쪽 split은, group 버튼의 split은 언제나 그러한데, 새 line에서 자르고 그 line을 두 그리는 사각형이 header를 뺀 뒤 같은 높이가 되는 곳에 놓으며, 그 line으로도 card가 최소보다 작게 그려질 때만 거부된다([최소 크기](#최소-크기)). `left` 또는 `right` 쪽 split과 위쪽 절반이 어떤 header 아래에도 서지 않는 split은 layout library처럼 나눈다. `even`에서는 workbench가 같은 변경에서 grid에 `core.layout.balance`의 balance([group card의 card command](#group-card에-대한-card-command))를 실행하므로, 모든 card가 공정한 크기를 받고 배치는 유지된다. 이것은 `core.card.split`과 split 버튼, `core.group.create`와 group 버튼의 split, group에 card를 더하는 것, `side`가 있는 `core.layout.open`에 적용된다. `balance()`는 모든 card에 공정한 몫을 주고 그리는 최소를 검사하지 않으므로, `even`에서 workbench는 모든 operation처럼([최소 크기](#최소-크기)) 복사본에서 balance된 grid를 검사하고, content card가 최소보다 작게 그려지면 `card <id> cannot split toward <side>: cardSplit even would draw card <c> at <w>x<h>, below its minimum <m>x<m>`로, `balance()`가 throw하면 `card <id> cannot split toward <side>: cardSplit even cannot balance the grid: <the error of balance>`로 split 전체를 거부한다. `<c>`는 workbench order로 그런 첫 card다. 아무것도 바뀌지 않는다. `side`가 있는 `core.layout.open`의 반복은 두 값 모두에서 새 card를 `side` 쪽 이웃으로 찾으므로 그 idempotency가 유지된다.

### 닫기

group card는 member 하나를 담지 않는다. close, move, tab drop이 group card에 member 하나를 남기면, move의 target이 정해진 뒤 같은 변경에서 그 member가 그 group card를 담은 level에서 group card를 대신한다. 그 member는 group card의 자리와 leader mark를 받고 식별자를 유지하며, group card는 dissolve처럼 끝난다. 이 대체에서 grid는 바뀌지 않으므로 거부되지 않는다. group card 안의 모든 card를 닫는 것은 group card의 close, 곧 `core.card.close {card: <group>}`다. grid의 마지막 card를 닫으려는 close는 layout의 마지막 card 규칙(layout library의 R7)을 따른다.

grid card의 close는, 그 자체로든, 한 card로 만든 group card의 close로든, move의 앞 절반으로든, layout library의 R7이 말하는 대로 자기 cell을 이웃 한 줄에 준다. side는 library의 fill 순서로 시도하되, 이웃 줄이 card의 level 안에 놓인 side를 먼저 시도하고, 모든 group card를 사각형 하나로 유지하는 첫 결과를 남긴다. 그래서 group 안의 card는 할 수 있으면 자기 group의 card에게 cell을 주고, root level의 card는 group을 키우지 않는다. 그런 줄이 없는 card는 library가 지우는 대로 자기 slot을 지운다. 어느 것도 허용하지 않는 close는 그 원인과 함께 거부된다: 첫 side가 깨는 group card와 함께 `card <id> cannot <operation>: group <g> would not cover one rectangle`, `card <id> cannot <operation>: it is the last card of the layout`, 또는 `card <id> cannot <operation>: no row of cards that can grow covers a side of it, and its slots hold other cards`.

## 이동과 drop

tab drag와 `core.tab.move`는 어느 level의 target card든 받는다. drop은 점을 담는 가장 안쪽 box, 곧 사람이 겨누는 box에서 결정되며, 그 box의 zone만 쓰인다. content card의 그리는 사각형 안의 점은 그 card가 그것을 담은 group card의 바깥 4분의 1에 있어도 그 card에서 grid의 `zoneAt`으로 다섯 zone을 가지고 결정된다. content card에는 없지만 group card의 테두리 안, 곧 그 header 위나 테두리와 그 안 card 사이 gap에 있는 점은 그런 group card 중 가장 안쪽의 것에서 결정된다. 그 header 위나 테두리 가운데의 점은 group card의 `centre`이고, 테두리의 한 side 쪽 바깥 4분의 1(`zoneAt`이 card body를 재듯 테두리의 `edge` 0.25) 안의 점은 group card의 그 side다. 어떤 box에도 없는 점은 zone이 아니다. 그래서 drop은 group 없는 space의 card 사이처럼 group 안에서, 밖에서, 다른 group에서 모든 level의 모든 content card의 모든 side와 centre, 그리고 모든 group card의 모든 side와 centre에 닿는다.

- content card의 `centre` 위 drop은 지금처럼 tab을 그 card로 옮긴다.
- content card의 side 위 drop은 library의 split으로 tab을 그 옆 새 card에 넣고, 새 card는 target을 담은 group의 member가 된다. card의 유일한 tab은 `move`로 그 card를 그리로 옮기고, card는 그 group의 member가 된다.
- group card의 `centre` 위 drop은 `core.card.add-tab`처럼 tab을 group 안, 그 사각형의 오른쪽 가장자리의 새 content card에 넣는다. card의 유일한 tab은 그 card를 그리로 옮긴다.
- group card의 side 위 drop은 사각형의 split으로 tab을 group card 사각형 옆, 그 group card를 담은 level의 새 card에 넣는다. card의 유일한 tab은 `core.card.move`가 옮기듯 그 card를 그리로 옮긴다.

card의 유일한 tab은 지금처럼 그 card를 옮기며, card는 식별자를 유지한다. group card header의 control 밖을 누르고 끌면 group card를 옮긴다. drop은 tab처럼 결정되고, 놓으면 `core.card.move {card, target, side}`를 실행한다. group card를 끄는 동안 결정은 오늘 tab drag가 자기 card의 centre를 빼듯(`centreOnly`) 끌리는 group card와 그 안의 card를 뺀다. zone 없이 놓으면 아무것도 바꾸지 않고 오류를 보이지 않는다.

## Focus

focus ring은 어느 level의 content card 하나 위에 있고, keyboard는 [keyboard는 focus ring을 따른다](exposure.ko.md#키보드는-focus-ring을-따른다)가 말하듯 어느 group이 card를 담든 그것을 따른다. group card는 focus ring도 keyboard도 받지 않는다. group card에 focus를 두는 command나 누르기는 `core.card.focus`가 주는 card에 focus를 둔다. focus를 받은 content card를 담은 group card는 각각 focus를 담고 있음을 보인다. `focusInd`가 `border`인 동안([값](settings.ko.md#값)) 그 frame은 focus 색을 frame 색 `edge`에 `f^d`의 비율로 섞은 색을 받는다. `d`는 focus를 받은 card에서 그 group card까지의 level 수로, card를 직접 담은 group card에서 1이고, `f`는 `packages/workbench/workbench.json`의 chrome 값 `group-focus-fade`인 0.6이다. 그래서 가장 안쪽 group card는 focus를 60 percent로, 그다음은 36 percent로 보이고, 그 바깥 group card는 더 옅다. 이 표시는 frame이 이미 그리는 선의 색만 바꾸며 seam에서도 그렇기 때문에 선을 더하지 않는다. 표시는 ring을 옮기는 draw에서 focus를 따르고, 더는 focus를 받은 card를 담지 않는 group card는 같은 draw에서 frame 색으로 돌아간다. `focusInd`가 `corner`인 동안에는 focus를 받은 card의 표시만 focus를 보인다. `Tab` key가 따르는 workbench element의 순서는 workbench order다. group card element와 그 header는 그 안의 card 앞에 선다. card를 group 안팎으로 옮겨도 focus는 그 card에 남는다.

## 상태와 조회

- `core.layout`은 layout의 저장 형태([저장](#저장))를 보고하며, 각 group node에 `level`을 더한 `{card, name, level, leader, members}`를 담는다. `level`은 그 member의 level, `leader`는 그 member의 leader다. `state` 옆에는 root level의 leader인 `leader`를 담는다.
- `core.grid`는 grid의 card에 대한 값을 그리는 사각형과 함께 유지하고, 그것을 workbench order로 나열하며, 각 card에 그것을 담은 group card의 식별자이고 root level에서는 `null`인 member `parent`와, 자기 level의 leader인 card에서는 level의 유일한 member여도 `true`이고 다른 모든 card에서는 `false`인 member `leader`를 더한다. `cards`는 각각 `tabs`를 가진 content card만 담으므로 `cards`를 읽는 쪽은 한 모양을 본다. member `groups`는 group card를 workbench order로 나열하며, 각각은 그리는 사각형을 가진 `{id, x, y, w, h, parent, leader, group: {name, level, leader}}`이고, group card가 없는 space에서는 비어 있다.
- `core.card.get {card}`는 어느 level의 card 하나를 읽으며, card 상태의 유일한 조회다. content card의 상태는 `{card, activeTab, tabs, groups}`다. `card`는 그 식별자, `activeTab`은 활성 tab의 식별자 또는 `null`, `tabs`는 tab 순서의 tab이며 각각 `{tab, plugin, status}`다. `status`는 그 tab의 status 값 객체로, 그 plugin이 `summary: true`로 선언한 status([노출](exposure.ko.md#항목-필드))이며, 선언하지 않은 plugin에서는 `{}`다. `groups`는 group 경로로, 그것을 담은 group card마다 가장 바깥부터 가장 안쪽까지 `{card, name}` 하나씩이며 root level에서는 `[]`이므로, 읽는 쪽은 경로를 `<name> > <name> > <name>`으로 보인다. group card는 `{card, groups, focus, group: {name, level, leader, members}}`를 돌려준다. `focus`는 focus를 받은 content card에서 그 group card까지의 level 수 `d`([focus](#focus))로, 그 card를 직접 담은 group card에서 1이고, focus를 받은 card가 group card 안에 없으면 `null`이다. `members`는 `core.layout`의 tree 형태의 member이며, content card는 식별자로, group card는 자기 node로 가장 안쪽 group까지 담는다. window sidebar는 `card <id> is a window sidebar`로 실패하고, 활성 space의 card가 아닌 식별자는 [layout에 대한 동작](cli.ko.md#레이아웃에-동작하기)의 문구로 실패한다.
- `core.card.get {card}`와 card를 가리키는 모든 command는 root level에서 group tree를 한 번 walk하여 card를 찾고, walk는 지나는 group card를 기록한다. walk가 식별자를 만나면 기록된 group card가 group 경로이고 그 node가 subtree다. walk가 만나지 않는 content card는 root level의 member다.
- [창 snapshot](exposure.ko.md#창-snapshot)과 `sok describe`의 `layout`은 root level member의 tree이며, 여기서 각 group card는 group `{name, level, leader, root}`를 가진 node이고 `root`는 root level의 tree처럼 grid의 line에서 얻은 그 사각형 안 member의 tree다. 각 content card node는 `core.grid`처럼 `parent`를 가지며, 각 level을 이끄는 member는 `leader: true`를 가진다. 여기에 `groups`를 더한다. 이것은 모든 group card를 workbench order로 한 번씩 그 그리는 사각형인 `frame`과 식별자로 된 member와 함께 나열하므로, 읽는 쪽은 각 group을 한 목록에서 이름으로 찾는다. `core.layout`은 저장 형태를 유지하며, 거기서 중첩된 group card는 그것을 담은 group card의 member 안의 node다.

## 저장

`projects.json`의 space layout([persistence](projects.ko.md#저장))은 grid를 `state`로, group tree를 `groups`로, space가 낸 가장 큰 card 번호를 `lastCard`로, root level의 leader를 `leader`로 저장한다. `lastCard`는 grid와 group tree의 모든 card 식별자의 번호 이상인 양의 정수다. `leader`는 root level의 member의 식별자이며, root level이 window sidebar만 담는 동안은 `null`이다. `groups`는 root level의 group card 목록이며, 각 node는 정확히 `{card, name, leader, members}`다. `card`는 그 식별자, `name`은 group의 이름, `members`는 그 member로서 각각 `state`의 content card 식별자 또는 group card의 node이고, `leader`는 그 member 하나의 식별자다. workbench는 각 level의 member와 root level의 group을 reading order로 쓴다. level은 node의 깊이가 주므로 저장되지 않는다. group이 없는 layout은 `groups: []`를 저장한다.

저장된 layout은 이 형태로만 읽힌다. 각 거부는 [persistence](projects.ko.md#저장)가 저장된 layout에 대해 말하듯 space의 거부다. 그 space를 여는 것은 실패하고 library 미리보기가 오류를 보이며, registry와 다른 space는 계속 읽힌다. 각 거부의 앞머리는 `projects.json: project <root> space <space>: `이며, `<level>`은 `root` 또는 `group <id>`다.

| 발견 | 문구 |
| --- | --- |
| layout library가 거부하는 grid | `checkState`의 오류 |
| `groups`가 없는 layout, 또는 목록이 아닌 `groups` | `layout stores groups <value>, which is not a list of groups` |
| 다른 형태의 node | `layout stores the group <value>, which is not {card, name, leader, members}` |
| 다른 형태의 이름 | `group <id> stores the name <value>, which is not 1 to 40 characters` |
| member가 둘 미만인 node | `group <id> holds fewer than two cards` |
| window sidebar인 member | `group <id> holds the window sidebar <side>` |
| `state`의 card도 node도 아닌 member | `group <id> holds <value>, which is not a content card of the layout` |
| group tree의 두 자리에 있는 식별자 하나, 또는 `state`의 card 식별자를 가진 group card | `card <id> is stored twice` |
| `leader`가 없는 layout, `leader`가 없는 node, 또는 content card나 group card를 담는 level의 `null` `leader` | `level <level> has no leader` |
| 자기 level의 member가 아닌 leader | `level <level> names the leader <id>, which is not a member of that level` |
| leader인 window sidebar | `level <level> names the window sidebar <id> as its leader` |
| 사각형 하나를 덮지 않는 group card | `group <id> does not cover one rectangle of the grid` |
| `paidBy` 기록을 저장한 group을 가진 layout | `layout with groups stores the paidBy record of card <id>; a layout with groups keeps none`. `<id>`는 정렬 순서로 기록의 첫 card다 |
| 어떤 card도 쓰지 않는 line을 저장한 group을 가진 layout | `layout with groups stores the <axis> line <k>, which no card uses; a layout with groups keeps none`. `x` line이 `y` line보다 먼저이고 `<k>`는 가장 작은 index다 |
| `lastCard`가 없는 layout, 또는 양의 정수가 아니거나 grid나 group tree의 card 식별자 번호보다 작은 `lastCard` | `layout stores lastCard <value>, which is not the largest issued card number` |

member `groups`, `leader`, `lastCard`는 필수이므로 이 형태는 이전 release의 형태가 아니다. `projects.json`은 format 2를 가지고, format 1 파일은 `<file>: projects.json: format must be 2`로 거부된다([저장 데이터 형식](installation.ko.md#저장-데이터-형식)). 이전 파일을 바꾸는 migration은 없다. 형식으로 거부된 파일은 거부된 space와 달리 통째로 거부된다. 그 파일은 registry, 화면 상태, space, plugin의 project 데이터(`plugins`)를 담으므로 그 어느 것도 읽히지 않으며, 파일을 지울 때까지 파일의 모든 쓰기는 그 오류로 실패한다. release는 사람이 `projects.json`을 지우고 project를 다시 더한다는 것, 그리고 project의 설정 파일(`.soksak/settings.json`)과 폴더는 남는다는 것을 말한다. `docs/spec/cases/layout/groups.json`의 layout case가 저장 검사, 그리는 사각형, command와 그 거부, 사각형 operation, drop 결정을 말하며, `packages/workbench`의 test와 `packages/workbench-mygo`의 Go layout model은 같은 파일을 실행한다.

## 그리기

group card는 기존 card 디자인의 container 하나로 그린다. 그 테두리는 그 그리는 사각형([그리는 사각형](#그리는-사각형)) 위의 card border와 radius이고, 그 header는 테두리 안 맨 위의 띠로, 폭 전체에 걸친 theme과 chrome metrics의 card header이며 그 이름과 head button은 content card head의 모양을 갖고 자기 상자를 갖지 않는다. 테두리는 그 옆의 모든 상자에서 gap 하나만큼 떨어지므로 어떤 card도 header도 덮지 않는다. 테두리 안의 영역, 곧 header와 그 안 상자 사이의 gap은 그 level의 색으로 채운다. 그 색은 theme의 색 `bg`에 theme 색 `group-<n>`을 설정 `group.tint`의 퍼센트만큼 섞은 것이며, `n`은 group card의 member의 level이고 3보다 큰 level은 `group-3`을 쓴다([값](settings.ko.md#값)). 각 theme과 mode의 theme 색은 각 level이 서는 표면에서 `fg` 쪽으로 한 걸음씩 나아간다: `group-1`은 `bg`와 card 색 `card`에서, `group-<n>`은 `group-<n−1>`에서 나아가며, 각각 그 아래 표면과 `card`에서 CIELAB L* 4 이상 떨어지므로, 모든 level이 stage, 그것을 담은 level, 그 card와 구별되어 보인다. group card는 가장 바깥 것부터 안쪽으로 채우므로, nested group card는 그것을 담은 group 안의 다른 색 영역이 되고, nested group card와 그것을 담은 group의 경계는 색이 바뀌는 곳으로 보인다. grid의 rule, line, divider는 header를 가로지르지 않는다: 각 rule과 divider의 grab 영역은 group card의 그리는 header를 가로지를 곳에서 잘리므로, group 안 line의 divider는 쌓인 header 아래에서 시작한다. group card 안 line의 rule은 그것을 담는 가장 안쪽 group card의 테두리 안, 그 header 아래에서만 그려지며 stage padding에 닿지 않는다. 모든 group card 밖의 rule은 테두리를 가로지를 곳에서 잘리며, 그런 rule만 plane 가장자리에서 stage padding에 닿는다. group card 안의 content card는 기존 디자인의 card로 그 그리는 사각형에 그린다([그리는 사각형](#그리는-사각형)). grid는 header 밖에서 오늘처럼 경계선과 divider(`sp-rule`, `sp-divider`)를 그린다: space를 가로지르는 line 집합 하나이므로, divider는 그 line 전체를 모든 group을 지나 옮긴다. rail은 오늘처럼 focus된 content card와 그 override된 window sidebar를 두른다([override context와 rail 테두리](external-sidebars.ko.md#오버라이드-컨텍스트와-레일-보더)). 두 workbench는 [native surfaces](native-surfaces.ko.md#인수-기준)의 수용 기준이 요구하듯 group 테두리, 채움, header를 card chrome과 native 화면과 같은 그리기와 transaction에서 그린다. library의 layout 미리보기는 오늘처럼 grid를 그리고, 각 group card를 그 안 pane을 두르는 테두리로 그린다.

## 노출

`packages/workbench/exposure.json`의 선언이다. 이 표의 설명은 같은 이름의 기존 항목 설명을 대신한다.

| 종류 | 이름 | 설명 |
| --- | --- | --- |
| command | `core.group.create` | Groups a card with a new content card toward side. |
| command | `core.group.dissolve` | Replaces a group card with its members in the level that holds it. |
| command | `core.group.rename` | Renames a group card. |
| command | `core.group.leader` | Makes a card the leader of its level. |
| command | `core.group.menu` | Opens or closes the close menu of a group header. |
| command | `core.card.move` | Moves a content card or a group card beside a card of any level, or into a group, as a drop does. |
| command | `core.card.fullscreen` | Shows a content card or a group card across the work area, or restores the arrangement. |
| status | `core.layout` | The stored form of the current space layout with the level of each group node, or null. |
| status | `core.grid` | The current grid as today, each card with the group card that holds it, and the group cards with their rectangles. |
| command | `core.card.get` | Reads the state of one content card of any level with its group path, or one group card. |
| element | `core.group` | The frames of the group cards in workbench order. |
| element | `core.group.header` | The headers of the group cards in workbench order. |
| element | `core.group.name` | The names in the group headers in workbench order; a double-click renames. |
| element | `core.group.add` | The add buttons of the group headers in workbench order. |
| element | `core.group.split-x` | The vertical split buttons of the group headers in workbench order. |
| element | `core.group.split-y` | The horizontal split buttons of the group headers in workbench order. |
| element | `core.group.wrap` | The group buttons of the group headers in workbench order, shown while the group card can be grouped with a new card toward its longer axis. |
| element | `core.group.fullscreen` | The fullscreen buttons of the group headers in workbench order. |
| element | `core.group.close` | The close buttons of the group headers in workbench order; each opens the close menu of its group. |
| element | `core.card.group` | The group buttons of the content card headers in workbench order, shown while the card can be grouped with a new card toward its longer axis. |
| element | `core.card.leader` | The leader buttons of the card and group headers of levels of two or more members in workbench order; pressed on the leader. |

`core.rename.begin`은 `project`와 `space` 옆에 kind `group`을, `core.card.menu`는 menu `group`을 선언한다. 모든 element는 `createBinder`로 bind되며, `core.workbench.audit`은 그 어느 것도 unbound로 나열하지 않는다.

## 결정

- space는 line 집합 하나를 가진 grid 하나를 유지하고, group card는 그 사각형 하나를 가리킨다. 한 group에서 다른 group으로, 또는 group을 지나 이어지는 line은 line 하나다. 그 위의 두 card는 같은 좌표에 그려지고, 보통 card 사이처럼 drag 한 번이 그것을 모든 group을 가로질러 옮긴다. group card마다 자기 line을 가진 child grid는 거부되었다. 두 grid는 line 하나를 가질 수 없으므로, group을 가로질러 이어지는 이음매가 두 좌표에 놓이고 두 line으로 drag된다.
- group tree는 card의 data가 아니라 grid 옆에 저장된다. group card는 grid의 card가 아니기 때문이다. 그것은 자기 cell을 갖지 않고 그 안 card의 cell만 가진다. grid는 정확히 layout library의 상태로 남고, grid를 읽는 모든 쪽은 그것을 바뀌지 않은 채 읽는다.
- 모든 group card는 grid의 사각형 하나를 정확히 덮는다. group card의 header, 테두리, drop 결정, 전체 화면은 사각형 하나를 필요로 하며, 그것을 깨는 operation은 깨는 group과 함께 거부되므로, tree는 상자 하나가 아닌 cell을 가리키지 않는다.
- group card는 container 하나다: 그 테두리가 header와 member를 담고, 모든 상자는 옆 상자에서 gap 하나만큼 떨어진다. 양쪽 card에서 gap 절반씩 떨어진 corridor 가운데의 테두리는 모든 content card의 변을 grid의 line 위에 두었지만, group을 상자가 아니라 card 사이의 선으로 그렸고, nested 테두리와 그것을 담은 테두리가 한 line에 겹쳤다. layout library는 frame을 각각 line의 corridor 안 gap 하나로 가지므로(R5), 거리는 gap으로 남고 slot의 합은 여전히 plane이다. 한 line에서 이웃보다 적은 frame 안에 선 card는 그 line에 더 가까이 서며, 이것이 고른 gap의 값이다.
- group card는 그 level의 색으로 채워지고 그 header는 폭 전체에 걸치며, rule이나 divider는 header를 가로지르지 않는다. nested 테두리는 그것을 담은 테두리 안쪽으로 gap 하나만큼 서고, 채움은 각 nested group을 자기 색의 영역으로 만든다. header를 가로지른 rule이나 divider는 header 줄을 두 header로 읽히는 조각으로 잘랐다. 색은 각 mode의 theme 색 `group-1`부터 `group-3`이며 설정 `group.tint`가 `bg`에 섞으므로, theme은 자기 색조를 지키고 사람은 채움을 줄이거나 끌 수 있다.
- group card 사각형에 대한 operation은 layout library를 쓴다. 사각형의 split은 card 여러 개의 상자에 대한 R4이며, 안의 card는 절반을 받아 비율을 유지하고 밖의 card는 자기 line을 유지한다. close와 move는 사각형을 card 하나로 만들고, library가 그것을 닫거나 옮긴다. 그래서 library는 바뀌지 않고 모든 결과는 `checkState`가 받는 상태다.
- 그리는 최소는 library의 option이 아니라 workbench가 drop 미리보기가 drop을 검사하듯 grid와 tree의 복사본에서 검사한다. header를 아는 것은 workbench뿐이기 때문이다.
- group은 언제나 member를 둘 이상 담는다. `core.group.create`는 card를 한 side 쪽 새 card와 묶으므로 group은 command 하나로 두 번째 card와 함께 만들어진다. member 하나가 남으면 그것이 group card를 대신한다. group 버튼은 그 상자의 긴 축, 곧 card 둘을 둘 공간이 있는 축을 쓴다.
- group card는 새 식별자를 받고, 그것이 묶는 card는 식별자와 tab을 유지한다. 그 card를 가리키는 모든 저장 참조, tab session, command가 계속 그것을 가리키기 때문이다. group card는 그 level에서 card의 자리와 leader mark를 받는다. card가 서 있던 자리에 서기 때문이다.
- root level의 leader는 `leader`로, group card member의 leader는 그 node에 저장된다. level은 node의 깊이에서 도출되고 저장되지 않으므로, 어떤 저장 값도 tree와 어긋날 수 없다.
- tree는 중첩되어 저장된다. group card의 member는 그 node에 있다. tree의 주된 조회는 card 식별자 하나에서 그 조상 경로 전체와 subtree 전체로 가는 것이기 때문이다. 중첩 형태에서 subtree는 저장된 node 자체이고 경로는 그것까지의 walk이므로 조립이 없다. card마다 parent 식별자를 가진 기록 하나씩의 평면 형태는 거부되었다. 중첩 형태가 구성으로 지키는 참조 검사가 필요하고, 파일은 어느 형태든 통째로 쓰이기 때문이다.
- workbench는 식별자 index가 아니라 tree의 walk 한 번으로 card에 닿는다. index는 card의 포함 관계를 두 번째로 가지며 모든 move가 그것을 고쳐야 하므로 tree와 어긋날 수 있다. space는 card를 수십 개 담으므로 조회마다 walk 한 번은 잴 만한 비용이 없다.
- `projects.json`은 format 2를 받는다. `groups`, `leader`, `lastCard`는 format 1 파일에 없는 상태이며, 저장 형식 규칙은 새 format 번호를 요구하고 migration을 두지 않는다. release는 사람이 다시 만드는 파일을 말한다.
- card 식별자는 기존 형태 `card-<n>`으로 남고, layout이 저장하는 `lastCard`에서 workbench가 낸다. 그래서 재시작을 지나도 식별자는 두 번 나오지 않는다. 무작위 식별자는 content card 식별자의 형태를 바꾸므로 거부되었다. 저장된 식별자에서 도출한 번호는 가장 큰 번호의 card가 끝난 뒤 끝난 식별자를 다시 내므로 거부되었다.
- `cardSplit` `even`은 grid를 balance한다. grid가 space의 line 집합 하나이기 때문이다. `exact`는 기본값으로 남으며, R4와 그 사각형 일반화의 동작이다. balance가 card를 최소보다 작게 그리면 `even`은 split을 거부한다. `exact` 결과로 돌아가면 말없이 고른 설정을 다른 값으로 바꾸게 되기 때문이다.
- group을 가진 space는 `paidBy` 기록과 어떤 card도 쓰지 않는 line을 남기지 않는다. `paidBy` 기록은 library가 close된 card의 자리를, 그 card를 split해 낸 card에게 둘 사이의 line을 옮겨 돌려주게 하며, group을 가진 space에서 그 line은 두 card 사이에 있는 group의 card들의 line이므로, operation이 이름을 대지 않은 card가 움직인다. 어떤 card도 쓰지 않는 line은 나중 split의 목표가 되어, split이 card의 가운데 대신 다른 group의 이음매에 놓인다. library는 바뀌지 않으며, group이 없는 space는 library가 남기는 대로 기록과 line을 남긴다.
- drop은 점을 담는 가장 안쪽 box에서 결정된다: content card는 grid의 `zoneAt`으로, 그 밖에는 가장 안쪽 group 테두리가 `zoneAt`의 edge 비율로 결정한다. 사람은 pointer 아래의 box를 겨누므로, group card의 바깥 4분의 1은 그 안의 card나 테두리 안에 있는 점을 가져가지 않는다. group card의 side는 그 테두리와 그 card 사이 gap에서 닿으며, 새 종류의 zone은 더해지지 않는다.
- group card는 group으로서 전체 화면이 된다. 사람은 card 하나를 보이듯 작업의 상자 하나를 보이므로, 그 사각형이 그 안의 모든 card와 header와 함께 작업 영역을 덮는다. 전체 화면인 동안 layout은 전체 화면 card의 규칙 하나대로 그 안에서도 밖에서도 바뀌지 않는다.
- group card는 focus ring을 받지 않는다. ring은 surface의 keyboard를 쥐는데 group card에는 surface가 없기 때문이다. group card의 focus는 그 첫 content card로 간다.
- focus를 받은 card를 담은 group card는 frame에 그것을 보이며, level마다 `group-focus-fade`만큼 옅어진다. 중첩된 group에서 card 하나의 ring만으로는 지금 일하는 곳을 어느 group이 담는지 보이지 않고, 모든 frame에 온전한 색의 ring을 그리면 어느 card가 keyboard를 쥐는지 보이지 않기 때문이다. 비율은 0.6이므로 card에서 두 level 위의 frame도 focus 색의 36 percent를 받는다. 이 표시는 frame의 선 색을 바꾸고 자기 선을 그리지 않는다. seam에서 frame 옆에 두 번째 선이 있으면 선이 seam보다 두꺼워지기 때문이다.

review는 다음 반론에 답했다.

- leader의 `create`는 그 level에 member가 아닌 leader를 남긴다: group card가 card의 leader mark를 받는다.
- close 뒤 window sidebar만 남은 root level에는 leader가 될 card가 없다: card가 들어올 때까지 그 `leader`는 `null`이다.
- 실행 안에서든 재시작 뒤든 다시 쓰인 식별자는 반복 dissolve가 다른 group을 풀게 한다: workbench는 모든 식별자를 저장된 `lastCard`에서 낸다.
- window 크기 변경이 card를 그리는 최소보다 작게 남기는 동안 모든 operation이 거부될 것이다: card를 바꾸는 operation만 검사되고, drop 미리보기와 놓기는 같은 검사를 쓴다.
- card가 이미 가진 자리로의 `core.card.move`는 그것을 닫고 다시 넣어 px 크기를 바꿀 것이다: layout을 부르지 않고 결과를 돌려준다.
- 사각형의 split은 그것이 대응시키는 line에 대해 같음이 필요하다: 좌표는 R1이 요구하듯 허용 오차 없이 숫자로서 같으며, group 밖의 card가 쓰는 line은 움직이지 않는다.
- 옮긴 card가 떠나는 group 옆으로의 move는 group이 대체될 때 target을 잃을 것이다: target은 대체 전에 정해지고, card는 group을 대신하는 card 옆에 놓인다.
- `core.card.get`은 member `leader`로 card 상태를 다시 정의할 것이다: card 상태는 유지되고 `groups`만 더해진다. leader는 `core.layout`과 `core.grid`에 보고된다.
- 낱말 group은 이미 picker group과 snapshot group을 가리킨다: group 하나는 이 명세가 나열하는 이름과 member에서만 group card를 가리키며, kit term 목록이 새 term을 받는다.
- 저장된 group의 거부는 파일 전체의 거부로 읽힐 수 있다: 그것은 space의 거부이며, 형식 거부만 파일을 거부한다.
- format 상승은 registry와 plugin의 project 데이터를 잃는다: release가 그것을 말하며, layout을 다른 파일로 옮기는 것은 `projects.json`의 형태도 바꾸고 같은 손실을 주므로 거부되었다.
- group 안의 close는 group 밖의 card에게 card의 자리를 줄 수 있다: 결과를 검사하여 group과 함께 거부하므로, tree는 상자 둘의 group card를 갖지 않는다.
- nested group card의 테두리는 한 변을 공유하는 곳에서 한 line으로 그려져 nesting을 숨겼고, 바깥 group의 header를 가로지르는 divider를 그렸다: 각 level은 자기 채움을 가지고, header는 어떤 rule도 가로지르지 않는 한 줄이다.
- header 아래 card의 bottom 쪽 split은 grid의 사각형을 나눠서, 위쪽 절반이 header만큼 잃고 들어맞는 card의 group이 최소 미만으로 거부되었다: split은 그리는 사각형을 새 line에서 나누므로 두 절반이 같은 높이로 그려진다.
- header가 그 아래 card나 nested header에 바로 붙어 그려져서, 다른 모든 상자 쌍을 떼어 놓는 corridor 없이 상자가 맞닿았다: header 뒤에는 card처럼 gap이 온다.
- layout library의 balance는 배치를 유지한다고 여겨졌지만 card를 다른 line에 놓을 수 있고, group이 있는 space의 balance가 group card를 다른 group의 cell 위에 두었다. group이 있는 space에서 balance는 library가 card를 다른 line으로 옮길 때마다 balance를 거부하는 대신 모든 line index를 유지하고 모든 slot에 free length의 같은 몫을 주며, 이는 group이 깨뜨릴 수 없는 고른 배치의 규칙이다. balance와 boundary 가운데 맞춤을 포함한 grid의 모든 결과는 같은 group 사각형 검사를 거치며, seed가 정해진 무작위 operation 순서가 매 단계 뒤에 불변식을 검사한다.
- group 안에서 split된 card의 `paidBy` 기록은 그 card가 close될 때 space를 가로질러 자리를 돌려줄 수 있다: group을 가진 space는 `paidBy` 기록을 남기지 않으므로, 그 cell을 받는 이웃만 바뀐다.
