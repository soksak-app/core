# layout operation의 크기

[English](layout-sizes.md)

이 제안은 plane의 layout을 바꾸는 모든 operation에 대한 크기 규칙 하나를 기술한다. 이것은 보류 중이다. 이것과 [groups](../spec/groups.ko.md)의 현재 규칙 사이의 선택은 열려 있고, 어떤 workbench도 이것을 구현하지 않는다. layout library가 그 두 primitive를 구현하며([add and remove](../../packages/soksak/docs/layout.ko.md#add-and-remove)), `docs/spec/cases/layout/grid.json`이 그 예를, `docs/spec/cases/layout/invariants.json`이 그 불변식을 검사한다. 모든 level에 같은 몫을 주는 balance와 card의 크기를 밝히는 거부는 모든 후보에서 성립하며 현재 contract의 일부다.

## 모델

- plane의 저장된 layout은 그 canonical slicing tree다. 사각형은 tree에서 나오며, tree는 결코 사각형에서 다시 만들어지지 않는다. level은 축(row 또는 column)과 fraction의 합이 1인 child를 가진다. level은 같은 축의 child level을 결코 가지지 않는다.
- leaf는 content card 또는 group card다. group card는 자기 plane을 가진다.
- 고정된 leaf, 곧 window sidebar는 point 단위의 크기를 유지한다. 몫, 고름, 지불은 level의 다른 child만 센다.
- 고정되지 않은 child의 fraction이 같으면 level은 고르다.

## 두 primitive

- REMOVE(X): X가 자기 level을 떠나고, 고정되지 않은 형제가 한 배율로 늘어 level을 채우므로 그 비율이 유지된다. child 하나만 남은 level은 그 child로 바뀐다. card 하나만 남은 group은 operation이 commit될 때, 그 target이 정해진 뒤에 그 card로 바뀐다. root plane의 마지막 content card는 제거되지 않는다.
- ADD(M, N, side). N은 leaf, 한 level의 이어진 형제들, level, 또는 plane의 root이고 `a`는 side의 축이다.
  - 따라서: N을 담은 level이, 또는 N이 축 `a`의 level이고 side가 그 끝이면 N 자신이 축 `a`를 가지며, M은 N 옆 side 쪽에 들어간다. 고른 level에서 M은 level의 1/(k+1)을 받고 모든 child는 비율을 유지하므로 level은 고르게 남는다. 고르지 않은 level에서는 N만 지불한다. M은 N의 절반을 받고 다른 모든 child는 크기를 유지한다.
  - 가로질러: N은 N과 M을 side 쪽으로 담는 축 `a`의 새 level로 감싸지며, 각각 1/2이다.
  - 거부: 사각형이 바뀌는 node가 header와 gap을 고정 비용으로 재귀적으로 계산한 최소([최소 크기](../spec/groups.ko.md#최소-크기)) 아래로 떨어지면 operation은 거부된다. error는 그 node, 그것이 필요한 크기, 그것이 가질 크기를 밝힌다.

## 모든 operation은 조합이다

| Operation | 정의 |
| --- | --- |
| split 버튼, card X의 `core.layout.open {side}` | ADD(new, X, side) |
| card X의 side 쪽 group split 버튼 | X와 새 card가 X의 자리와 크기를 받는 group card에 들어간다. group의 plane은 ADD(new, X, side)다 |
| card X의 side zone에 drop | ADD(moving, X, side) |
| 한 level의 형제 i와 i+1 사이 line 조각에 drop | ADD(moving, 형제 i, i+1 쪽 side) |
| 한 level의 이어진 형제 범위에 drop | ADD(moving, 범위, side) |
| plane 또는 group의 plane의 가장자리에 drop | ADD(moving, 그 plane의 root, side) |
| group header 또는 group의 tab에 drop | ADD(moving, group의 plane의 root, right) |
| card X의 가운데 또는 tab strip에 tab | tab이 그 index에서 X에 합류한다. tab 없이 남은 원래 card는 REMOVE된다 |
| card X의 tab strip에 card | card의 모든 tab이 그 index에서 X에 합류한다. card는 REMOVE된다 |
| card X의 가운데에 card | 두 leaf가 자리를 바꾸고, 각 자리는 크기를 유지한다 |
| card, tab 하나인 card의 tab, group의 close | REMOVE |
| tab 하나인 card의 tab, card, group의 move | REMOVE(moving) 다음 target의 ADD, 변경 하나로 commit된다 |
| balance | 모든 level이 고르게 된다 |
| boundary drag | boundary 옆의 두 fraction만 바꾼다 |
| fullscreen | fullscreen인 card나 group은 layout 변경을 거부한다. tab drag는 먼저 배치를 되돌린다 |

## target 찾기

- hit 영역은 현재 layout에 그려지고, 결과는 REMOVE(moving) 뒤의 tree에서 계산된다.
- line의 각 조각은 tree의 한 level에 속한다. level을 넘어 이어지는 line은 각각 preview를 가진 별개의 조각이다. line 조각의 면은 pointer 쪽이다.
- 움직이는 node나 그 빈 자리를 가리키는 target은 빈 slot(level, index, fraction)에 대응하며, 그 ADD는 REMOVE의 역이므로 제자리 drop은 변경이 없다.
- 한 화면 line을 공유하는 중첩된 side는 gap과 관계없이 바깥에서 안쪽으로 깊이 순서인 띠를 받는다. 결과가 같은 target은 한 띠다. card가 그 띠를 모두 담는 동안 그 card의 띠는 point 단위의 표준 폭을 가지며, 그렇지 않으면 그 card의 모든 띠가 한 비율로 좁아져 card의 가운데 앞에서 끝난다. side는 점이 그 side에서 떨어진 거리를 그 side가 가진 거리로 나눈 값으로 고른다. 고정된 띠 폭으로는 최소 크기의 card에서 모든 side에 닿을 수 없기(I4) 때문이다.
- 범위는 drag가 line에 들어온 점과 현재 점으로 고른다.
- pointer가 끌리는 card 위에 있다는 이유로 제외되는 target은 없다. drop은 그 결과가 현재 layout과 같을 때 정확히 변경이 없다. 지금 두 workbench는 card의 유일한 tab을 그 card 위에 놓는 drop을 그 가운데로 정하므로, 다른 card 아래에 있던 card 밑의 plane 전체 폭 side에 닿을 수 없다.

## 불변식

생성된 layout, 모든 anchor, 모든 점에서 검사한다.

- I1 tiling: card가 빈틈이나 겹침 없이 plane을 덮는다.
- I2 최소: 바뀐 node가 재귀적 최소 아래에 있지 않다. 그렇지 않으면 operation은 거부되고 그 node를 밝힌다.
- I3 모든 anchor와 점에서 preview는 결과와 같다.
- I4 도달성: 현재 tree의 모든 (node, side), 모든 빈 slot, 모든 가운데, 모든 strip index는 같은 결과를 합친 뒤 그것을 고르는 anchor와 점을 가진다.
- I5 move는 모든 tab과 surface를 유지한다.
- I6 drop은 그 결과가 현재 layout과 같을 때 정확히 변경이 없다.
- I7 비율: ADD와 REMOVE는 그것이 넣거나, 빼거나, 고르지 않은 level에서 절반으로 나누지 않는 모든 형제의 fraction 비율을 유지한다. fraction을 받는 kid가 모두 같은 fraction을 가진 고른 level은 그 안의 ADD나 REMOVE 뒤에도 고르게 남는다.
- I8 국소성: canonical 병합 뒤 원래 level과 target level의 subtree 밖의 사각형은 바뀌지 않는다.
- I9 command는 그것이 돌려준 identifier로 idempotent하다.
- I10 역: 방금 더한 node의 REMOVE는 고른 level의 fraction을 되돌리고, 옮긴 node를 그 빈 slot에 놓는 drop은 변경이 없다.

## 반론과 답

- 반론: 사각형에서 tree를 읽는 규칙은 line이 우연히 맞춰질 때 결과가 바뀐다. 답: 저장된 layout은 canonical tree이고 사각형은 그것에서 나온다. 지금 두 workbench는 line을 저장하고 operation마다 그것에서 tree를 다시 만든다.
- 반론: 모든 operation에서 고르게 남는 고른 level은 모든 layout에 대한 불변식 하나로 기술할 수 없다. 답: I7은 각 primitive가 유지하는 비율을 기술한다. 고름은 고른 level에서 그것으로부터 따라 나오며, I10은 역을 기술한다.
- 반론: move가 지나가는 동안 card 하나인 group은 drop target을 가질 수 없다. 답: group은 target이 정해진 뒤 operation이 commit될 때 줄어든다.
- 반론: card마다의 최소는 중첩된 group의 header와 gap을 놓친다. 답: 최소는 header와 gap을 고정 비용으로 재귀적으로 계산되며, 거부는 그 node를 밝힌다.
- 반론: 사람이 고르지 않게 크기를 정한 card에 drop할 때 같은 몫은 그 크기 조정을 없앤다. 답: 고르지 않은 level에서는 target만 절반을 지불한다. 고른 level에서 split 버튼과 agent open은 같은 몫으로 넣는다. 반복된 split이 고르게 남기 때문이다.
- 반론: 제거 뒤 tree에서 계산한 target은 pointer 아래에서 움직인다. 답: hit 영역은 현재 layout에 그려진다. 결과만 제거 뒤에 계산되며 빈 slot이 target이다.
- 반론: 한 화면 line 위의 중첩된 side는 구별할 수 없다. 답: 그것은 깊이 순서의 최소 폭 띠를 받고, 같은 결과는 한 띠를 공유한다.
- 반론: group header의 drop은 side가 필요하다. 답: 그것은 group의 plane의 root 오른쪽 끝에 더한다. group에 대한 `core.card.move` `centre`의 side다.
- 반론: 가장자리 drop은 새 card에 preview가 보이는 zone의 크기를 줄 수 있다. 답: M은 언제나 그것이 들어간 level의 같은 몫을 받는다. 둘로 된 새 level은 1/2을 주므로 가장자리도 다른 모든 add와 같은 규칙을 따른다.
- 반론: level이 줄어들 때 원래와 target level 밖의 변경을 배제할 수 없다. 답: I8은 canonical 병합 뒤의 국소성을 기술한다.
- 반론: I7과 I10은 I1, I2처럼 그려진 크기로 판정할 수 있다. 답: 그려진 비율은 저장된 비율이 아니다. cut은 kid에게 fraction을 주기 전에 고정 비용(kid 사이의 corridor, px size, box의 frame과 head)을 먼저 빼고, 그 비용은 gap, head, node 주변의 kid에 따라 바뀐다. 그래서 그려진 비율의 기준은 fraction이 정확한 layout을 실패로 판정하고, 비용을 상쇄하도록 fraction을 고쳐 쓴 layout만 통과시켰다. 모든 규칙은 fraction으로 일하고, 각 kid는 비용이 남긴 크기의 자기 fraction으로 그려지므로 같은 fraction의 kid는 같은 크기로 그려지며, gap 변경은 모든 fraction을 유지한다. I7과 I10은 저장된 tree의 fraction으로 판정하고, I1과 I2는 그려진 사각형으로 판정한다.
