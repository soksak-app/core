# Group card

[English](groups.md)

group card는 body가 자기 plane인 card다. 이 명세는 plane의 tree, 각 plane의 leader, group header, command `core.group.*`, `core.layout`, `core.grid`, `core.card.get`과 창 설명의 group member, `projects.json`에 저장되는 tree의 형태, plane의 그리기를 정한다. plane 하나의 grid는 layout library의 규칙([soksak](../../packages/soksak/docs/layout.ko.md))을 따르고, card command와 layout operation은 [layout에 대한 작업](cli.ko.md#레이아웃에-동작하기)을, 선언은 [노출](exposure.ko.md)을 따른다.

## 범위

card와 tab의 구조는 지금 그대로다. content card, 그 tab, card와 tab의 command, status, element, 그리고 저장 형태는 계약을 유지하며, `packages/soksak`은 바뀌지 않은 채 plane 하나의 library로 남는다. 더해지는 것은 group card 하나다. group card는 content card가 tab을 담는 자리에 자기 plane에 child card를 담는 card다. 이 명세는 group card가 더하는 것과 기존 command가 group 안의 card에 닿는 방식만 정한다. group 안의 content card는 root plane에서와 같은 content card다.

## 모델

- plane은 layout library의 grid 하나다. 곧 `packages/soksak`의 `toJSON`이 주는 상태 `{xs, ys, cards, paidBy}`다. library는 plane 하나의 library로 남고, workbench가 plane의 tree를 가진다.
- space에는 level 0의 root plane이 하나 있다. plane의 card는 tab을 하나 이상 담는 content card, child plane 하나를 담는 group card, 또는 root plane에서만 window sidebar([external window sidebars](external-sidebars.ko.md))다. group card의 child plane의 level은 그 group card가 있는 plane의 level에 1을 더한 값이다.
- group card는 이름, header, body를 가진다. header는 card 위쪽의 card head 높이(chrome metrics의 `head-h`, [layout 값](settings.ko.md#배치-값)) 한 줄이다. body는 card의 나머지이며, child plane은 root plane이 stage 안에 gap 절반의 여백을 두고 놓이듯([값](settings.ko.md#값)) body 안에 모든 변에서 gap 절반만큼 들여 놓인다. 그려진 크기 `w`×`h`의 group card는 child plane에 크기 (`w` − gap)×(`h` − `head-h` − gap)를 준다. group card는 tab, surface, card sidebar를 갖지 않는다.
- group은 card를 둘 이상 담는다. card 하나의 group은 없다. child plane은 content card와 group card를 담고 window sidebar는 담지 않는다.
- card의 식별자는 그 space의 모든 plane에서 card 하나를 가리킨다. content card와 group card는 식별자를 한 sequence에서 받는다. 곧 `card-<n>`이며, `n`은 layout이 저장하는([저장](#저장)) 그 space가 낸 가장 큰 card 번호 `lastCard`보다 1 크다. 그래서 두 plane이 같은 식별자를 갖지 않고, space는 끝난 식별자를 재시작 뒤에도 다시 내지 않는다. card는 한 plane에서 다른 plane으로 옮겨도 식별자를 유지하고, card를 가리키는 모든 command(`core.layout.open`, `core.layout.select`, `core.layout.close`, `core.card.*`, `core.tab.move`, `core.group.*`)는 active space의 어느 plane의 card든 받는다.
- group이라는 낱말 하나는 이름 `core.group.*`, `core.card.group`과 이 명세의 기록의 member `group`에서만 group card를 가리킨다. `core.picker` item의 member `group`과 창 snapshot의 groups는 원래 뜻을 유지한다.
- plane의 reading order는 card를 첫 row line `r0`, 다음으로 첫 column line `c0` 순으로 정렬한다. 이 순서는 layout library의 R2가 요구하듯 `cards` 배열의 순서가 아니라 line으로 정해진다.

### 최소 크기

content card의 가장 작은 변은 두 축에서 `minSize`다. 한 축에서 plane의 가장 작은 extent는 그 slicing tree(`sliceTree`)로 계산한다. card는 자기의 가장 작은 extent를 센다. 그 축을 따른 cut은 양쪽의 합에 그 사이 line마다 gap 하나를 더해 센다. 다른 축을 따른 cut은 양쪽 중 가장 큰 쪽을 센다. group card의 가장 작은 크기는 `x` 축에서 child plane의 가장 작은 extent에 gap을 더한 값이고, `y` 축에서 gap과 `head-h`를 더한 값이다.

group card가 child plane에 주는 크기에서 child plane이 모든 card를 가장 작은 크기 이상으로 담으면 group이 맞는다. 이를 위해 layout library는 바뀌지 않는다. workbench는 plane의 각 operation(split, close, insert, move, balance, arrange)을 오늘의 drop preview처럼 먼저 plane의 사본에 적용하고, operation이 group card의 그려진 크기를 바꾸어 그 group card가 가장 작은 크기보다 작아지면 operation을 거부한다. 그래서 어떤 operation도 card를 `minSize` 아래로 줄이지 않듯 group card를 가장 작은 크기 아래로 줄이지 않는다. 창 크기 변경으로 이미 가장 작은 크기보다 작아진 group card는 자기 크기를 바꾸지 않는 operation을 거부하지 않는다. drop preview와 drop의 release는 같은 검사를 쓰므로, 검사가 거부하는 위치에는 preview가 없고 그 release는 아무것도 바꾸지 않는다. 경계 drag는 경계 옆의 모든 group card가 가장 작은 크기를 유지하는 마지막 위치에서 멈춘다. plane의 operation은 그 plane의 group card 크기를 바꾸므로 workbench는 바뀐 각 group card 안의 plane에 같은 변경으로 적용하고, 그중 하나가 거부하면 operation 전체를 거부한다. operation이 아닌 변경, 곧 창 크기 변경, `gap`, `size`, 글자 크기의 변경은 R5가 plane 하나에 대해 말하듯 모든 plane의 비율을 다시 표현하고 아무것도 거부하지 않는다. 그동안 card는 공간이 돌아올 때까지 가장 작은 크기보다 작게 그려진다.

## Leader

content card나 group card를 담는 각 plane은 leader를 정확히 하나 가진다. leader는 그 plane의 card 하나이며 content card 또는 group card다. window sidebar는 leader가 되지 않으므로, 오늘 마지막 content card를 닫으면 남는 것처럼 window sidebar만 담은 root plane은 leader가 없고 `leader: null`을 저장한다. 그 뒤의 변경이 넣는 첫 card가 그 leader가 된다.

- 새 plane은 첫 card를 leader로 삼는다. 곧 `core.group.create`가 group으로 바꾸는 card이며, 그 옆의 새 card가 아니다. 새 space는 root plane에서 reading order로 window sidebar가 아닌 첫 card를 leader로 삼는다.
- `core.group.create`가 plane의 leader를 group에 넣으면 새 group card가 그 card의 자리를 받으므로 그 plane의 leader mark도 받는다.
- `core.group.leader {card}`는 `card`를 자기 plane의 leader로 만든다. 다른 plane은 바꾸지 않는다.
- plane의 leader가 close나 다른 plane으로의 move로 plane을 떠나면, reading order로 window sidebar가 아닌 남은 첫 card가 leader가 된다.
- group을 풀 때 group card가 parent plane의 leader였으면 child plane의 leader가 parent plane의 leader가 되고, 그렇지 않으면 parent plane이 leader를 유지한다.
- group card는 parent plane의 leader이면서 자기 child plane의 card 하나가 그 child plane의 leader일 수 있다. 두 mark는 서로 독립이다.

leader는 mark다. command, focus, 그리는 순서를 바꾸지 않는다. `core.layout`과 `core.grid`는 모든 plane에서 leader를 보고하며, card가 둘 이상인 plane에서는 leader card의 header가 card header의 기존 수단, 곧 header 버튼의 눌린 상태로 그것을 보인다([header](#header)).

## Header

header의 버튼은 그 header의 상자에 작용한다.

| Header | Element | Command | 효과 |
| --- | --- | --- | --- |
| content card | `core.card.add` | `core.card.menu {card, menu: "add"}` | 지금처럼 card에 tab을 더한다 |
| content card | `core.card.split-x`, `core.card.split-y` | `core.card.menu {card, menu}` | 지금처럼 같은 plane에서 card 옆에 새 content card를 놓는다 |
| content card | `core.card.group` | `core.card.menu {card, menu: "group"}` | 새 card의 plugin menu를 연다. 그 item은 `core.group.create {card, side, plugin}`을 실행하며, 이는 card를 그 card와 새 card의 group card로 바꾼다 |
| content card | `core.card.leader` | `core.group.leader {card}` | card를 자기 plane의 leader로 만든다 |
| group card | `core.group.add` | `core.card.menu {card: <group>, menu: "add"}` | 고른 tab을 가진 content card를 child plane의 오른쪽 끝에 더한다 |
| group card | `core.group.split-x`, `core.group.split-y` | `core.card.menu {card: <group>, menu}` | parent plane에서 group card 옆에 새 content card를 놓는다 |
| group card | `core.group.wrap` | `core.card.menu {card: <group>, menu: "group"}` | 새 card의 plugin menu를 연다. 그 item은 `core.group.create {card: <group>, side, plugin}`을 실행하며, 이는 group card와 새 card를 새 group card에 넣는다 |
| group card | `core.card.leader` | `core.group.leader {card: <group>}` | group card를 parent plane의 leader로 만든다 |
| group card | `core.group.close` | `core.group.menu {group}` | group의 close menu를 연다 |

- split은 group을 만들지 않는다. content card의 split과 group card의 split은 각각 자기가 나누는 card의 plane에 새 content card를 놓는다.
- group 버튼의 side는 그 card의 긴 축이다. card가 높이보다 넓게 그려지면 `right`, 아니면 `bottom`이다. `core.card.group`과 `core.group.wrap`은 그 card의 그 side로의 `core.group.create`가 성공할 때만 보인다. 곧 card가 줄 child plane (`w` − gap)×(`h` − `head-h` − gap)이 그 card를 가장 작은 크기로, content card 하나를 `minSize`로, 그 side 방향으로 gap 하나를 두고 나란히 담을 때이며, 이것이 `core.group.create` 거부의 크기 `mw`×`mh`다. `core.card.menu`는 `add`, `split-x`, `split-y` 옆에 menu `group`을 받고, 그 item은 add menu와 split menu의 plugin이다.
- `core.card.leader`는 card가 둘 이상인 plane의 모든 card header에 보인다. leader에서는 눌려 있고(`aria-pressed` true) 그것이 leader mark이며, 다른 card에서는 눌려 있지 않다. card가 하나인 plane에는 없다. 이 버튼은 기존 card header 디자인의 head 버튼이며 card tool의 header fit을 따르므로, 너무 좁은 header는 이를 tool menu(`core.card.tools`)에 둔다.
- group header는 기존 디자인의 card header다([card 배치](example-model.ko.md)). head 높이 `head-h`, head 버튼, 그 icon, card header의 theme이 같다. tab strip 자리에 group 이름(`core.group.name`)을 보이고, head 버튼은 content card의 head 버튼 자리에 놓인다. `core.group.add`, `core.group.split-x`, `core.group.split-y`는 `core.card.add`, `core.card.split-x`, `core.card.split-y`의 icon을 쓰고, 그다음 `core.group.wrap`, `core.card.leader`, `core.card.close`의 icon을 쓰는 `core.group.close`가 온다. group card가 더하는 icon은 group 버튼(`core.card.group`, `core.group.wrap`)의 icon과 leader mark(`core.card.leader`)의 icon뿐이며, 둘 다 다른 card head icon과 함께 `workbench.json`의 icons에 선언한다. plane의 level은 `core.layout`과 `core.grid`에 보고되고 그려지지 않는다.
- `core.group.name`을 double-click하면 `core.rename.begin {kind: "group", id}`를 실행하고, 이름 바꾸기 field(`core.rename.input`)는 `core.group.rename`을 실행하는 `core.rename.commit`으로 확정한다. `core.rename.begin`은 `project`와 `space` 옆에 kind `group`을 받는다.
- group의 close menu는 item 그룹 닫기와 그룹 풀기를 가진 picker다. 그룹 닫기는 `core.card.close {card: <group>}`을, 그룹 풀기는 `core.group.dissolve {group}`을 실행한다. 그룹 풀기는 풀기가 성공할 때만 보인다. 그 item은 `core.picker.item` 항목이며, `core.picker`는 card의 add menu를 보고하듯 menu가 열려 있음을 그 group card와 item과 함께 보고한다.

## Command

각 command는 자기 변경을 보이는 placement 뒤에 답한다. active가 아닌 space에 있거나 창의 어느 space에도 없는 card나 group은 [layout에 대한 작업](cli.ko.md#레이아웃에-동작하기)의 문구로 실패한다. card가 fullscreen인 동안의 layout 변경은 `card <id>: the layout does not change while card <shown> is fullscreen; restore the arrangement first`로 실패한다. 거부된 command는 아무것도 바꾸지 않는다. 오류 문구의 크기는 가장 가까운 point로 반올림한 정수 point의 그려진 크기이며 `<w>x<h>`로 쓴다.

| Command | Parameter | 결과 | 규칙 |
| --- | --- | --- | --- |
| `core.group.create` | `{card, side, plugin, params?}` | `{group, card, tab}` | `card`를 card 둘의 group으로 바꾼다. group card는 자기 plane에서 `card`의 자리, px 크기, leader mark를 받고, 다음 card 식별자와 이름 `그룹 <n>`을 받는다. `n`은 space의 어느 group도 이름 `그룹 <n>`으로 갖지 않은 가장 작은 양의 정수다. `card`는 식별자와, tab 또는 child plane을 유지하며, child plane에서 `side`의 반대쪽 card가 되고, px 크기 없이 child plane의 leader가 된다. child plane은 `core.card.split`이 side 쪽에 새 card를 놓듯 `side`(`left`, `right`, `top`, `bottom`) 쪽으로 `card`와, group card 다음 식별자와 `plugin`의 `params` tab을 가진 새 content card로 나뉜다. 결과는 group card, 새 card, 그 tab을 가리키며 focus는 새 card로 옮겨 간다 |
| `core.group.dissolve` | `{group}` | `{dissolved: true}` | group card를 그 child plane의 card로 바꾼다. child plane의 각 line은 group card의 span 안에서 parent plane의 좌표 `a + (b − a) × t`에 들어간다. `a`와 `b`는 span의 첫 line과 마지막 line의 좌표이고 `t`는 child plane에서 그 line의 좌표다. 좌표가 parent plane의 line 좌표와 tolerance 없이 수로서 같은 line은(R1) 그 line이다. mapping은 line 좌표로 하므로, card의 그려진 크기는 group card가 내어 준 header와 inset만큼 바뀐다. 각 card는 식별자, data, px 크기를 유지한다. group card의 px 크기는 옮기지 않는다. 그 card들은 parent plane의 여러 slot에 걸치거나 자기 slot이 없기 때문이다(R5). 풀기의 leader 규칙이 적용된다 |
| `core.group.rename` | `{group, name}` | `{group, name}` | group 이름을 양 끝 공백을 뺀 `name`으로 정한다 |
| `core.group.leader` | `{card}` | `{card, plane}` | content card 또는 group card인 `card`를 자기 plane의 leader로 만든다. header의 leader 버튼은 그 header의 card로 이를 실행한다. `plane`은 `card`를 담은 child plane의 group card 식별자이며, root plane이면 `null`이다 |
| `core.group.menu` | `{group}` | `null` | group의 close menu를 열거나, 열려 있으면 닫는다 |
| `core.card.move` | `{card, target, side}` | `{card}` | content card 또는 group card인 `card`를 tab 또는 child plane과 함께 `target`의 plane에서 `target`의 `side`(`left`, `right`, `top`, `bottom`) 옆으로, 또는 `side` `centre`와 group `target`이면 drop처럼 `target`의 child plane 오른쪽 끝으로 옮긴다. card는 식별자를 유지한다. 떠나는 plane에는 card가 plane을 떠날 때의 leader 규칙이 적용된다 |

각 command가 검사하는 순서의 거부:

| Command | 조건 | 문구 |
| --- | --- | --- |
| `core.group.create` | `card`가 window sidebar | `card <id> is a window sidebar; a group holds content cards and group cards` |
| `core.group.create` | card가 자기와 `side` 쪽 새 card의 group을 담을 수 없음 | `card <id> cannot hold a group toward <side>: it is <w>x<h> and the group needs <mw>x<mh>`. `card`의 가장 작은 크기를 `cw`×`ch`라 할 때, `left`나 `right` 쪽이면 `mw`는 `cw` + `minSize` + 2 × gap이고 `mh`는 max(`ch`, `minSize`) + `head-h` + gap이며, `top`이나 `bottom` 쪽이면 `mw`는 max(`cw`, `minSize`) + gap이고 `mh`는 `ch` + `minSize` + `head-h` + 2 × gap이다 |
| `core.group.create` | `plugin` 또는 `params`가 거부됨 | 그 plugin이나 parameter에 대한 `core.card.split`의 문구([layout에 대한 작업](cli.ko.md#레이아웃에-동작하기)) |
| `core.group.dissolve`, `core.group.rename`, `core.group.menu` | `group`이 content card나 window sidebar를 가리킴 | `card <id> is not a group` |
| `core.group.dissolve` | child plane의 card가 parent plane에서 가장 작은 크기보다 작게 그려질 것 | `group <id> cannot be dissolved: card <c> would be <w>x<h>, below its minimum <mw>x<mh>`. `<c>`는 child plane의 reading order로 그런 첫 card다 |
| `core.group.rename` | 양 끝 공백을 뺀 이름이 Unicode scalar value 1개보다 적거나 40개보다 많음 | `group name must be 1 to 40 characters: <name>` |
| `core.group.leader` | `card`가 window sidebar | `card <id> is a window sidebar and cannot lead a plane` |
| `core.card.move` | `card`가 window sidebar | `card <id> is a window sidebar and does not move` |
| `core.card.move` | `target`이 window sidebar | `card <target> is a window sidebar; a card does not move beside it` |
| `core.card.move` | `target`이 `card`이거나 `card`의 child plane 안의 card | `card <id> cannot move into itself` |
| `core.card.move` | content card `target`에 `side` `centre` | `card <target> is not a group; a card moves beside it` |
| `core.card.move` | layout이 move를 거부함 | `card <id> cannot move to <side> of <target>` |

### Idempotency

같은 식별자로 같은 command를 두 번째 적용하면 같은 상태를 남기고 같은 결과를 돌려준다.

- `core.group.create {card, side, plugin, params}`는 `card`가 정확히 `card`와 `N`을 담은 group card `G`의 child plane의 card이고, `N`이 `core.layout.open`의 규칙으로 `card`의 `side` 쪽 이웃이며, `N`이 `plugin`의 `params` tab `T`를 담으면 `{group: G, card: N, tab: T}`를 돌려주고 아무것도 바꾸지 않는다.
- 이 창이 workbench 시작 뒤 푼 group card에 대한 `core.group.dissolve {group}`은 `{dissolved: true}`로 답하고 아무것도 바꾸지 않는다. 창은 닫은 tab을 기억하듯 푼 group card의 식별자를 기억한다([layout에 대한 작업](cli.ko.md#레이아웃에-동작하기)). 이 실행에서 창이 풀지 않은 식별자는 재시작 뒤에도 tab의 반복 close처럼 layout에 없는 card의 문구로 실패하고, 설명은 group이 없어졌음을 보인다. 어떤 식별자도 두 번 내지 않으므로 그 식별자는 다른 card를 가리키지 않는다.
- 현재 이름으로의 `core.group.rename`, 현재 leader에 대한 `core.group.leader`, 그리고 move가 놓을 자리(`target`의 `side` 쪽 이웃, 또는 `centre`이면 `target`의 child plane 오른쪽 끝에서 위부터 아래까지 닿는 card)에 이미 있는 card의 `core.card.move`는 layout을 부르지 않고 같은 결과를 돌려주므로 아무것도 바뀌지 않는다.
- `core.group.menu`는 `core.card.menu`가 card menu를 toggle하듯 menu를 toggle하며 `core.layout`은 바뀌지 않는다.

### Group card에 대한 card command

- `core.card.add-tab {card: <group>, plugin, params?}`는 tab을 가진 새 content card를 child plane의 오른쪽 끝에 위부터 아래까지 닿게 넣고(`x` 축 마지막 line에서 `insertAt`), content card에서처럼 `{tab}`을 돌려준다. child plane이 담을 수 없으면 `group <id> has no room for a card at its right edge`로 실패한다.
- `core.layout.open {card: <group>, plugin, params?}`는 child plane의 content card 중 reading order로 `plugin`의 `params` 첫 tab을 고르고, 없으면 `core.card.add-tab`처럼 card를 더한다. `side`가 있으면 어느 card에서처럼 parent plane에서 group card를 나눈다.
- `core.card.menu {card: <group>, menu}`는 group header의 add, split, group menu를 연다. 그 item은 content card의 menu가 content card에 하듯 group card에 `core.card.add-tab`, `core.card.split`, `core.group.create {card: <group>, side, plugin}`을 실행한다.
- `core.card.split {card: <group>, side, plugin}`은 parent plane에서 group card 옆에 새 content card를 놓는다.
- `core.card.close {card: <group>}`은 group card를 그 child plane의 모든 card와 그 안의 plane과 함께 닫는다. `core.card.close`가 card 하나의 tab에 묻듯 수정된 각 tab을 먼저 묻고, 물은 tab이 모두 저장되거나 버려질 때까지 결과는 `closed: false`다.
- `core.card.focus {card: <group>}`은 child plane의 reading order로 첫 content card에 focus를 주며, 첫 card가 group card면 그 첫 group card로 내려간다.
- `core.card.fullscreen {card: <group>}`은 `card <id> is a group; fullscreen shows a content card`로 실패한다. 어느 plane의 content card든 지금처럼 작업 영역 전체로 fullscreen이 된다.
- `core.layout.balance`와 card 자동 정렬 command(`cardArrange`)는 root plane부터 안쪽으로 각 plane에 따로 적용되므로, parent plane이 group card에 주는 크기가 그 child plane을 정한다. group card는 자기 plane의 card 하나로 센다. 한 plane이 거부하면 아무것도 바뀌지 않는다.

### Split 설정

설정 `cardSplit`([값](settings.ko.md#값))은 split 뒤의 크기를 정한다. 기본값 `exact`이면 split은 지금처럼 자기가 나누는 card의 사각형만 나눈다(layout library의 R4). `even`이면 workbench는 같은 변경에서 split이 일어난 plane에 `balance()`를 실행하므로, 그 plane의 card가 구조를 유지한 채 공정한 크기를 받고, 그 plane의 group card 크기를 통한 것 외에는 다른 plane이 바뀌지 않는다. 이 설정은 `core.card.split`과 split 버튼, `core.group.create`와 group 버튼의 새 group 안 split, 그리고 `side`가 있는 `core.layout.open`에 적용된다. plane이 거부한 `balance()`는 split을 `exact`가 만든 대로 둔다. `side`가 있는 `core.layout.open`의 반복은 두 값 모두에서 새 card를 `side` 쪽 이웃으로 찾으므로 idempotency가 유지된다.

### 닫기

group은 card 하나를 담지 않는다. close, move, tab drop이 child plane에 card 하나를 남기면, move의 target을 정한 뒤 같은 변경에서 그 card가 parent plane에서 group card를 대신한다. 그래서 옮겨진 card가 떠나는 group card 옆으로의 move는 그것을 대신한 card 옆에 놓이고, card가 떠나는 group card의 `centre`로의 move나 drop은 card를 먼저 child plane에 넣으므로 child plane이 다시 card 둘을 담아 대체되지 않는다. 남은 card는 그곳에서 group card의 자리, px 크기, leader mark를 받고 식별자를 유지하며, group card는 풀기에서처럼 끝난다. 남은 card가 group card의 자리 전체를 받으므로 이 대체는 거부되지 않는다. child plane의 모든 card를 닫는 것은 group card의 close, `core.card.close {card: <group>}`이다. root plane의 마지막 card를 닫을 close는 layout의 마지막 card 규칙(layout library의 R7)을 따른다.

## 이동과 drop

tab drag와 `core.tab.move`는 어느 plane의 target card든 받는다. drop은 root plane부터 안쪽으로 정해진다. plane의 `zoneAt`이 card와 zone을 주며, card가 group card이고 zone이 `centre`면 같은 점으로 그 child plane에서 계속 정하고, group header 위의 점이나 child plane이 어느 card로도 정하지 않는 body의 점은 group card의 `centre`다. 그래서 group card body의 각 변 바깥쪽 4분의 1(`edge` 0.25)은 parent plane에서 group card의 side이고, body의 나머지는 child plane에 속한다. group card의 `centre`에 놓은 drop은 `core.card.add-tab`처럼 tab을 child plane 오른쪽 끝의 새 content card에 넣고, side에 놓은 drop은 target의 plane에서 target 옆에 놓는다. 자기 card의 유일한 tab은 지금처럼 그 card를 옮기며, card는 식별자를 유지한다.

group card header의 control 밖을 눌러 drag하면 group card를 옮긴다. drop은 tab에서처럼 정해지고 release는 `core.card.move {card, target, side}`를 실행한다. group card를 drag하는 동안에는, tab drag가 오늘 자기 card의 centre를 빼듯(`centreOnly`) 드래그한 card와 그 child plane을 빼고 정한다. zone이 없는 release는 아무것도 바꾸지 않고 오류도 보이지 않는다.

## Focus

focus ring은 어느 plane의 content card 하나에 서고, 키보드는 그 card를 어느 plane이 담든 [키보드는 focus ring을 따른다](exposure.ko.md#키보드는-focus-ring을-따른다)가 말하듯 그것을 따른다. group card는 focus ring도 키보드도 받지 않는다. group card에 focus를 주는 command나 press는 `core.card.focus`가 주는 card에 focus를 준다. `Tab` 키가 따르는 workbench element의 순서는 element tree다. group card element는 자기 header, 그다음 child plane의 card를 reading order로 담는다. card를 다른 plane으로 옮겨도 focus는 그 card에 남는다.

## 상태와 조회

- `core.layout`은 layout의 저장 형태([저장](#저장))를 보고하며, 각 group 기록에 `level`을 더한 `group: {name, level, leader, plane}`을 가진다. `level`은 그 child plane의 level이고 `leader`는 그 child plane의 leader다. 그리고 `state` 옆에 root plane의 leader `leader`를 가진다.
- `core.grid`는 root plane의 card에 대해 값을 유지하고, child plane의 card를 workbench 순서로 더한다. 각 card는 자기를 담은 child plane의 group card 식별자인 member `plane`을 더 가진다. 그 사각형은 root plane의 사각형처럼 root plane 좌표다. 자기 plane의 leader인 각 card는 plane의 유일한 card도 포함해 member `leader: true`를 더 가진다. group card는 member `group: {name, level, leader}`를 더하고 tab 없이 나열된다.
- `core.card.get {card}`는 어느 plane의 card든 하나를 읽는다. content card는 card 상태를 그대로 두고 member `groups`를 더한다. `groups`는 그 card를 담은 group card마다 `{card, name}` 하나씩, 가장 바깥부터 가장 안쪽까지의 group 경로이며 root plane에서는 `[]`다. 그래서 읽는 쪽은 경로를 `<name> > <name> > <name>`으로 보인다. group card는 `{card, groups, group: {name, level, leader, plane}}`을 돌려준다. `plane`은 `core.layout`의 tree 형식으로 된 child plane이다: 그 plane의 모든 card를 reading order로 담고, 그 안의 group card는 자기 `group` record를 가지며, 가장 안쪽 plane까지 이어진다.
- [창 snapshot](exposure.ko.md#창-snapshot)과 `sok describe`의 `layout`은 group card를 node `{card, size, frame, group: {name, level, leader, root}}`로 담는다. `root`는 root plane의 tree 형태인 child plane의 tree다. tree의 각 node는 자기 plane의 leader에서 `leader: true`를 가진다.

## 저장

`projects.json`의 space layout([저장](projects.ko.md#저장))은 root plane을 `state`로, space가 낸 가장 큰 card 번호를 `lastCard`로, root plane의 leader를 `leader`로 저장한다. `lastCard`는 tree의 모든 card 식별자 번호 이상인 양의 정수다. `leader`는 root plane의 card 식별자이며, root plane이 window sidebar만 담는 동안은 `null`이다. 어느 plane의 group card든 `data`가 정확히 `{group: {name, leader, plane}}`인 그 plane의 card다. `name`은 group 이름, `plane`은 `state` 형태의 child plane, `leader`는 `plane`의 card 식별자다. level은 기록의 깊이가 주므로 저장하지 않는다. group이 없는 layout은 `leader`를 저장하고 group 기록은 없다.

저장된 layout은 이 형태로만 읽는다. 각 거부는 [저장](projects.ko.md#저장)이 저장된 layout에 대해 말하듯 space의 거부다. 그 space를 여는 일이 실패하고 library 미리보기가 오류를 보이며, project 목록과 다른 space는 읽힌다. 각 거부의 접두어는 `projects.json: project <root> space <space>: `이고, `<plane>`은 `root` 또는 `group <id>`다.

| 찾은 것 | 문구 |
| --- | --- |
| `leader`가 없는 layout, `leader`가 없는 group 기록, 또는 content card나 group card를 담은 plane의 `leader` `null` | `plane <plane> has no leader` |
| 자기 plane의 card가 아닌 leader | `plane <plane> names the leader <id>, which is not a card of that plane` |
| leader인 window sidebar | `plane <plane> names the window sidebar <id> as its leader` |
| 다른 형태의 group 기록, 또는 `data`에 다른 member가 있는 group card | `card <id> stores the group <value>, which is not {name, leader, plane}` |
| card가 둘보다 적은 child plane | `group <id> holds fewer than two cards` |
| child plane의 window sidebar | `group <id> holds the window sidebar <side>` |
| tree의 두 곳에 있는 한 식별자 | `card <id> is stored twice` |
| 다른 형태의 이름 | `group <id> stores the name <value>, which is not 1 to 40 characters` |
| layout library가 거부하는 child plane | `group <id>: <the error of checkState>` |
| `lastCard`가 없는 layout, 또는 양의 정수가 아니거나 tree의 card 식별자 번호보다 작은 `lastCard` | `layout stores lastCard <value>, which is not the largest issued card number` |

member `leader`와 `lastCard`가 필수이므로 이 형태는 이전 release의 형태가 아니다. `projects.json`은 형식 2를 가지며, 형식 1의 file은 `<file>: projects.json: format must be 2`로 거부된다([저장 데이터 형식](installation.ko.md#저장-데이터-형식)). 이전 file을 바꾸는 migration은 없다. 형식으로 거부된 file은 거부된 space와 달리 통째로 거부된다. 그 file은 project 목록, 화면 상태, space, plugin의 project data(`plugins`)를 담으므로 그 어느 것도 읽히지 않고, file을 지울 때까지 file의 모든 쓰기가 그 오류로 실패한다. release는 사람이 `projects.json`을 지우고 project를 다시 더하며, project의 설정 file(`.soksak/settings.json`)과 folder는 남는다고 밝힌다. `docs/spec/cases/layout/groups.json`의 layout case는 저장 검사, 가장 작은 extent, command와 그 거부, drop 결정을 기술하며, `packages/workbench`의 test와 `packages/workbench-mygo`의 Go layout model이 같은 file을 실행한다.

## 그리기

group card는 기존 디자인의 card로 그린다. 그 background, border, radius, header, focus 처리는 theme과 chrome metrics에서 온 content card의 것이며, group을 위한 색, border, label은 더하지 않는다. child plane은 [모델](#모델)이 말하듯 body 안에 놓이고, child plane의 card는 그 안에서 기존 디자인의 card로 그린다. 각 plane은 자기 경계선과 divider(`sp-rule`, `sp-divider`)를 자기 사각형 안에 그린다. group card 옆의 parent plane divider는 group card의 크기를 바꾸고 child plane은 비율을 유지한다. rail은 지금처럼 focus된 content card와 그것이 override한 window sidebar의 외곽을 그린다([override context와 rail 테두리](external-sidebars.ko.md#오버라이드-컨텍스트와-레일-보더)). 두 workbench는 [native surfaces](native-surfaces.ko.md#인수-기준)의 수용 기준이 요구하듯 group card, 그 header, child plane을 card chrome과 native 화면과 같은 draw와 transaction에서 그린다. library의 layout 미리보기는 group card를 그 child plane의 도식을 담은 card로 그린다.

## 노출

`packages/workbench/exposure.json`의 선언이다. 이 표의 설명은 같은 이름의 기존 항목 설명을 대신한다.

| 종류 | 이름 | 설명 |
| --- | --- | --- |
| command | `core.group.create` | Turns a card into a group card that holds the card and a new content card toward side. |
| command | `core.group.dissolve` | Replaces a group card with the cards of its child plane inside its span. |
| command | `core.group.rename` | Renames a group card. |
| command | `core.group.leader` | Makes a card the leader of its plane. |
| command | `core.group.menu` | Opens or closes the close menu of a group header. |
| command | `core.card.move` | Moves a content card or a group card beside a card of any plane, or into a group, as a drop does. |
| status | `core.layout` | The stored form of the current space layout with the level of each group record, or null. |
| status | `core.grid` | The current grid as today, with the cards of the child planes, each with its plane, and each group card with its group record. |
| command | `core.card.get` | Reads the state of one content card of any plane with its group path, or one group card. |
| element | `core.group` | The group cards in workbench order. |
| element | `core.group.header` | The headers of the group cards in workbench order. |
| element | `core.group.name` | The names in the group headers in workbench order; a double-click renames. |
| element | `core.group.add` | The add buttons of the group headers in workbench order. |
| element | `core.group.split-x` | The vertical split buttons of the group headers in workbench order. |
| element | `core.group.split-y` | The horizontal split buttons of the group headers in workbench order. |
| element | `core.group.wrap` | The group buttons of the group headers in workbench order, shown while the group card can hold a group of itself and a new card toward its longer axis. |
| element | `core.group.close` | The close buttons of the group headers in workbench order; each opens the close menu of its group. |
| element | `core.card.group` | The group buttons of the content card headers in workbench order, shown while the card can hold a group of itself and a new card toward its longer axis. |
| element | `core.card.leader` | The leader buttons of the card and group headers of planes of two or more cards in workbench order; pressed on the leader. |

`core.rename.begin`은 `project`와 `space` 옆에 kind `group`을, `core.card.menu`는 menu `group`을 선언한다. 모든 element는 `createBinder`로 묶이며, `core.workbench.audit`은 그중 어느 것도 묶이지 않은 것으로 나열하지 않는다.

## 결정

- card와 tab의 구조, 그 command, status, element, 저장 형태, 그리고 layout library는 바뀌지 않는다. group card가 유일한 추가다. 그래서 group card의 가장 작은 크기는 library의 option이 아니라, drop preview가 drop을 검사하듯 workbench가 plane의 사본에서 검사한다.
- group card는 기존 디자인의 card로 그린다. 새 시각 요소는 group 버튼의 icon과, 눌린 header 버튼인 leader mark뿐이다. level은 보고하고 그리지 않는다.
- group은 언제나 card를 둘 이상 담는다. `core.group.create`는 card를 그 card와 side 쪽 새 card의 group card로 바꾸므로, group은 command 하나로 두 번째 card와 함께 만들어진다. card 하나가 남으면 그것이 group card를 대신한다. group 버튼은 card 둘을 담을 공간이 있는 축인 그 card의 긴 축을 쓴다.
- group card는 새 식별자를 받고, group이 되는 card는 식별자와 tab을 유지한다. 그 card를 가리키는 모든 저장 참조, tab session, command가 계속 그것을 가리키기 때문이다. group card는 card가 서 있던 곳에 서므로 parent plane에서 card의 자리, px 크기, leader mark를 받는다.
- root plane의 leader는 `state` 옆의 `leader`로, child plane의 leader는 그 group 기록에 저장한다. 그래서 plane은 정확히 layout library의 상태이고, plane을 읽는 모든 reader가 그것을 바꾸지 않고 읽는다. level은 기록의 깊이에서 얻고 저장하지 않으므로, 어떤 저장 값도 tree와 어긋날 수 없다.
- `projects.json`은 형식 2를 받는다. `leader`는 `core.group.leader`가 바꾸는 상태이고 형식 1의 file에는 없으며, 저장 형식 규칙은 새 형식 번호와 migration 없음을 요구한다. release는 사람이 다시 만드는 file을 밝힌다.
- card 식별자는 기존 형태 `card-<n>`을 유지하고, workbench가 layout이 저장한 `lastCard`에서 모든 plane에 대해 낸다. 그래서 plane의 식별자가 충돌하지 않고 재시작을 넘어서도 어떤 식별자도 두 번 내지 않는다. random 식별자는 content card 식별자의 형태를 바꾸므로, 저장된 식별자에서 얻은 번호는 가장 큰 번호의 card가 끝난 뒤 끝난 식별자를 다시 내므로 받아들이지 않았다.
- `cardSplit` `even`은 split이 일어난 plane만 balance한다. 사람은 상자 하나 안에서 나누고, 그 주변 상자는 크기를 유지하기 때문이다. `exact`는 R4의 동작인 기본값으로 남는다.
- drop은 기존 `zoneAt`과 그 edge 비율로 root plane부터 안쪽으로 정하므로, group body의 바깥 4분의 1은 group card의 side이고 나머지는 그 plane에 속한다. 새 종류의 zone은 더하지 않는다.
- group card는 focus ring을 받지 않는다. ring은 surface를 위해 키보드를 잡는데 group card에는 surface가 없기 때문이다. group card의 focus는 그 첫 content card로 간다.

review가 답한 반론:

- leader의 `create`는 그 plane에 plane의 card가 아닌 leader를 남긴다: group card가 card의 leader mark를 받는다.
- close 뒤 window sidebar만 남은 root plane에는 leader가 될 card가 없다: card가 들어올 때까지 `leader`는 `null`이다.
- 따로인 library instance의 card 식별자가 충돌하고, 실행 안에서나 재시작 뒤에 다시 쓴 식별자가 반복한 풀기로 다른 group을 풀게 한다: workbench가 저장된 `lastCard`에서 모든 plane의 식별자를 낸다.
- 창 크기 변경이 group을 가장 작은 크기 아래로 두는 동안 plane의 모든 operation이 거부된다: group card의 크기를 바꾸는 operation만 검사하며, drop preview와 release가 같은 검사를 쓴다.
- card가 이미 있는 자리로의 `core.card.move`가 그것을 닫고 다시 넣어 px 크기를 바꾼다: layout을 부르지 않고 결과를 돌려준다.
- 풀기의 line mapping에는 같음의 기준이 필요하다: R1이 요구하듯 좌표는 tolerance 없이 수로서 같으며, group card의 px 크기는 옮기지 않는다.
- 옮겨진 card가 떠나는 group 옆으로의 move는 group이 대체될 때 target을 잃는다: target은 대체 전에 정해지고 card는 group을 대신한 card 옆에 놓인다.
- `core.card.get`이 member `leader`로 card 상태를 다시 정의한다: card 상태는 유지되고 `groups`만 더하며, leader는 `core.layout`과 `core.grid`에 보고된다.
- `create`의 거부 크기가 정의되지 않았다: 각 side에 대해 `mw`×`mh`를 밝힌다.
- group이라는 낱말은 이미 picker group과 snapshot groups를 가리킨다: group 하나는 이 명세가 나열한 이름과 member에서만 group card를 가리키며, kit 용어 목록이 새 용어를 받는다.
- card가 떠나는 group의 `centre`로의 move는 결과가 정의되지 않았다: card가 먼저 child plane에 들어가므로 group은 card 둘을 유지한다.
- 저장된 group의 거부가 file 전체의 거부로 읽힐 수 있다: 그것은 space의 거부이며, 형식 거부만 file을 거부한다.
- 형식 변경은 project 목록과 plugin의 project data를 잃게 한다: release가 그것을 밝히며, layout을 다른 file로 옮기는 안은 `projects.json`의 형태도 바꾸어 같은 손실을 주므로 받아들이지 않았다.
