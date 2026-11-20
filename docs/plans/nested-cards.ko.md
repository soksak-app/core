# Nested cards

[English](nested-cards.md)

이 제안은 release 0.0.45에서 party(F908)를 nested card로 바꾼다. 승인된 내용이 specification에 들어가면 이 문서를 지운다.

## 모델

- group card는 body가 자기 plane인 plane의 card다. plane은 layout library `packages/soksak`의 grid 하나(slicing tree `{root}`)다. library는 plane 하나의 library로 남고, workbench가 plane의 tree를 가진다.
- space는 root plane 하나를 가진다. plane의 card는 tab을 가진 content card이거나, child plane을 가진 group card다. content card의 각 tab은 지금처럼 다른 card와 독립이다.
- card와 tab 구조는 그대로이고, 더하는 것은 group card뿐이다.
  - header는 기존 card header design을 따르며, 이름, leader mark, button을 가진다.
  - level(그 plane의 깊이, root plane은 level 0)은 status에 보고한다.
  - body는 child plane이고, 그 plane의 corridor만큼 안으로 들어간다.
  - 이 생각을 처음 보인 mockup은 따라 그릴 design이 아니다.
- group은 card를 두 개 이상 가진다. card로 group을 만들면 그 card는 group card가 되고, 그 안에 card 두 개가 생긴다: tab을 가진 원래 card와 `side` 쪽의 새 card다. close나 move로 group에 card가 하나만 남으면, 그 card가 parent plane에서 group card를 대신한다.
- child plane이 group header 아래에서 모든 card에 두 축 모두 `minSize`를 줄 수 있는 동안 group card 안을 split할 수 있다. 이를 깨는 split, move, resize는 지금 한 plane에서처럼 거부된다.
- 각 plane에는 leader가 정확히 하나 있다. leader는 그 plane의 card 하나이며, content card일 수도 group card일 수도 있다.
  - 새 plane은 첫 card를 leader로 삼는다.
  - `core.group.leader`는 mark를 같은 plane의 다른 card로 옮긴다.
  - leader를 닫으면 mark는 남은 첫 card로 넘어간다.
  - group card는 parent plane의 leader이면서, 자기 plane 안에서는 따로 card 하나가 그 plane의 leader일 수 있다.
  - leader는 mark일 뿐이다. leader card의 header가 mark를 보이고, group header는 자기 plane의 leader 이름을 보이며, `core.layout`이 leader를 보고한다.
- header의 button은 그 header의 상자에 작용한다.
  - content card header: `+`는 tab을 더하고, 두 split button은 같은 plane에서 card 옆에 새 card를 놓는다.
  - group card header: `+`는 group 안에 content card를 더하고, 두 split button은 parent plane에서 group card를 split한다.
  - split은 group을 만들지 않는다.
  - group button은 card를 card 두 개의 group으로 바꾼다. 이 button은 card가 group header를 담고 그 card들에 `minSize`를 줄 수 있을 때만 보인다.
  - group 해제는 group header의 close menu에 있다.
- card는 plane 사이를 옮겨도 identifier를 유지한다. card를 지정하는 모든 command(`core.layout.open`, `core.layout.select`, `core.layout.close`, `core.card.get`)는 어느 plane의 card에도 동작한다.

- setting `cardSplit`은 split 뒤의 크기를 정한다. 값은 둘이다.
  - `exact`(기본값): split되는 card의 rect만 나눈다.
  - `even`: 그 plane의 card들을 `balance()`로 고른 크기로 다시 배치한다.
  - 이 setting은 split button, group button의 안쪽 split, `side`를 준 `core.layout.open`에 적용된다.

## Command와 status

- `core.group.create {card, side}`는 card를 group card로 바꾼다. 그 plane은 원래 card와 `side` 쪽의 새 content card를 가진다. group button은 card의 긴 축을 쓴다: 너비가 높이보다 크면 `right`, 아니면 `bottom`.
- `core.group.dissolve {group}`은 group card를 그 plane의 card들로 바꾼다. child plane의 line을 parent plane의 group card span 안에 넣는다. parent plane이 각 card에 `minSize`를 줄 수 없으면 거부된다.
- `core.group.rename {group, name}`, `core.group.leader {card}`(card가 자기 plane의 leader가 된다).
- status `core.layout`은 tree를 보고한다. group card는 `group: {name, level, leader, plane}`을 가진다. `core.card.get`은 card의 group 경로를 보고한다. `sok describe`는 tree를 보인다.
- drag나 command로 card를 옮기면 drop 지점 아래의 plane에 놓인다. 모든 plane에 drop zone이 있다.

## 그리기

- 각 plane은 corridor를 그 level의 몸통, 곧 stage 색을 level마다 `group-fill-fade`만큼 card 색에 섞은 색으로 그린다([그리기](../spec/groups.ko.md#그리기)). corridor가 0이면 group은 header와 몸통으로 구분된다.
- 각 content card surface는 token `--card`를 받는다. `--card`는 card background에 그 plane의 tint를 섞은 값이고, per-surface theme channel(F926-5 `setTheme {scheme, tokens, surfaces}`)로 전달된다. plugin은 `--card`를 칠하고 자기 background를 칠하지 않는다.
- rail은 지금처럼 focus된 content card의 외곽선을 그린다. leader border는 theme token `group-leader`를 쓴다.

## Party 제거

- party는 release된 적이 없다(v0.0.44에 없다). 제거할 것:
  - `docs/spec/parties.md`
  - `core.party.*` command와 status `core.parties`
  - theme token `party-*`
  - `packages/workbench/parties.js`
  - mygo `layout/parties*.go`와 `shell_parties.go`
  - party test와 `e2e/parties.test.mjs`
  - space layout의 `parties` 멤버
- `projects.json`에서 `parties`를 찾은 reader는 그 파일 이름을 대며 거부한다.
- party 작업에서 가져가는 것은 둘이다.
  - per-surface theme channel(F926-5)
  - level마다의 corridor tint와 그 opacity setting

## 순서

1. specification(layout, projects, settings, exposure, plugins, terms)과 적대적 review.
2. party 제거, host마다 한 unit.
3. mygo: plane tree, group header, command, status, storage, 그리기. debug application에서 사람에게 보인다.
4. page workbench(Wails와 Tauri)를 같은 contract case로 만들고, 그다음 host 부분.
5. host마다 window check 한 번, 그다음 release 0.0.45.
