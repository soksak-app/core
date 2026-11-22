# soksak

[`layout.md`](layout.md) 의 한국어 번역이다.

공유 격자선 위의 분할 배치. 헤드리스 코어, 선택적인 DOM 바인딩, 런타임 의존성 없음.

## 규칙

**R1 — 경계는 숫자 하나다.**
`xs` 와 `ys` 가 모든 좌표를 갖는다. 카드는 그 배열에 대한 인덱스 구간이므로, 맞붙은
두 카드는 같은 인덱스를 읽고 공유하는 경계는 숫자 하나다. 카드가 어디에 있는지,
두 카드가 맞붙었는지를 허용 오차가 정하지 않는다. 그것은 정수 인덱스이고, 맞붙은
두 카드는 같은 값을 읽는다.

허용 오차는 다른 것을 정한다. 끌기가 이웃한 선에 얼마나 가까워야 그 선에
내려앉는지, 연산이 카드에 충분한 자리를 남겼는지, 모서리가 각지게 그릴 만큼
좁은지다. 그 전부는 px 에 대한 판단이지 어느 카드가 어디에 있는지에 대한 판단이
아니다.

**R2 — 모든 것이 카드다.**
사이드바, 레일, 페인이 하나의 타입, 하나의 사각형 규칙, 하나의 통로, 하나의 반경,
하나의 외곽선을 쓴다.

Identifier는 card를 식별하며 role을 결정하지 않는다. Identifier를 바꾸고 input
card array 순서를 바꾸어도 geometry, query 판단과 대응하는 operation 결과는
같아야 한다. 이름을 바꿀 때 opaque card data는 변경하지 않는다.

카드는 `width` 나 `height` 를 px 로 가질 수 있다. 그것은 속성이지 두 번째 타입이
아니다. 카드가 그것을 가졌다는 이유로 거절되는 연산은 없다.

`fixed` 는 별개이며 배치에 적용된다. `fixed` 카드는 배치가 쪼개거나 닫거나 옮기거나
키우지 않는다. `moveTo` 를 직접 호출하면 여전히 옮겨진다. 그것은 다른 카드의 구간도,
다른 축의 선도 바꾸지 않기 때문이다. `move` 는 거절한다. 드롭은 그 주변 카드를
재배치하기 때문이다.

**R3 — 카드는 자기 슬롯을 점유하므로 아무것도 그것을 가로지를 수 없다.**
한 열을 가진 카드는 다른 어떤 카드도 그것을 가로질러 걸치지 않음을 보장한다.
`canInsertAt` 은 좌표를 비교하지 않고 구간을 센다.

**R4 — 쪼개기는 카드 하나를 둘로 교체한다.**
그래서 배치는 언제나 슬라이싱 플로어플랜이고, 풍차 배치에는 도달할 수 없으며, 모든
카드가 닫을 수 있는 상태로 남는다.

**R5 — 통로는 모든 안쪽 가장자리에 반 갭씩이다.**
판의 경계에 있는 카드는 그쪽에 딱 붙는다. 어떤 카드도 참조하지 않는 선은 통로를
차지하지 않는다. 통로 합계가 판을 넘으면 갭은 판이 담을 수 있는 만큼으로 줄어든다.
한 자리에 겹쳐 선 선들은 하나의 경계다. 그 연속 옆의 슬롯이 통로를 갖는다. 너비가
없는 슬롯은 통로를 가질 수 없기 때문이다. 자기 두 선이 그 한 자리에 겹쳐 선 카드는
그릴 너비가 없다. 그 카드는 이웃을 떼어놓는 하나의 갭 안에 놓이므로 사각형이 뒤집히지
않는다.

통로는 슬롯이 가지므로 px 크기는 그려지는 크기다. `width: 180` 은 판의 가장자리에서도,
두 카드 사이에서도, 어떤 `gap` 에서도 180 으로 그려진다.

box([모델](#모델))는 그 inner node 둘레에 프레임을 그린다: 프레임은 box의 왼쪽, 오른쪽,
아래쪽에서 box 안쪽으로 통로 하나만큼, 위쪽에서는 box의 head(`setHeads`)만큼 들어와 선다.
프레임과 head는 box를 담는 cut의 고정 비용이므로, 카드는 둘레의 프레임에서, 프레임은 다음
프레임에서, box는 선 건너 이웃에서 통로 하나만큼 떨어진다. 프레임은 그 축의 통로를 차지하고,
판이 통로와 프레임을 담을 수 없으면 그와 함께 줄어든다. px 크기는 둘레의 프레임 안에서
카드가 그려지는 크기다. 프레임은 tree에서 따라 나오며 상태의 일부가 아니다.

옵션 `frames`는 프레임이 차지하는 것을 정한다: 기본값 `"corridor"`는 위와 같이 통로 하나이고,
`"none"`은 아무것도 차지하지 않는다. 그때 box는 그 inner node의 사각형으로 그려지고 head는 여전히
그 위쪽 안에 서며, 선 양쪽의 두 box 사이 통로는 그 선에서 끝나는 box의 수와 무관하게 통로
하나다. 통로가 두 box가 공유하는 테두리 선 하나인 호스트는 `"none"`을 정한다. `frames` 변경은
모든 fraction을 유지하고, frame mode가 아닌 값은 `soksak: frames is <value>; use "corridor" or "none"`을
throw한다.

슬롯의 합은 언제나 판이고, 그것을 유지하기 위해 px 크기가 줄어든다. 축의 어떤 슬롯이
지분을 갖고 판에 자리가 있는 동안 px 크기는 선언한 값으로 그려진다.
지분을 가진 kid의 그려진 크기는 그 level의 범위에서 level의 고정 비용을 뺀 것의 fraction이다.
고정 비용은 corridor, px 크기를 가진 `fixed` 카드, box의 head와 frame이다. px 크기를 가진
`fixed` 카드는 corridor와 같이 그 level의 비용이고 지분을 가진 kid가 아니다. `fixed`가 아닌
px 크기의 카드는 지분을 가진 kid다. 그래서 px 크기는 두 class로 나뉜다.

- `fixed` 카드는 판이 그 level의 비용과 지분을 가진 kid의 `minSize` 하나를 담는 동안 px
  크기를 유지한다. 그것을 담지 못하는 판만 `fixed` 카드를 한 배율로 줄인다. operation이
  더하거나 빼는 corridor, frame, head는 지분을 가진 kid가 치른다.
- 판이 지분을 가진 kid의 px 크기를 담지 못하면 그 px 크기는 하나의 배율로 줄어들어
  서로의 비율이 유지되고 fraction을 받는 kid는 `minSize` 하나의 하한을 지킨다. 하한은
  fraction을 받는 kid 안의 corridor, frame, head를 세지 않으며, 그 비용을 담지 못하는 판만
  px 크기를 더 줄인다.

축의 어떤 슬롯도 지분을 갖지 않으면 판을 덮을 수 있는 것은 px 크기뿐이므로
양방향으로 판에 맞춰 조정되고 선언한 숫자가 비율이 된다. 1600 짜리 판에서 200 을
선언한 카드 하나는 1600 으로, 200 과 300 을 선언한 둘은 630 과 946 으로 그려진다.
카드가 실제로 그려진 값은 `rect(id)` 로 읽는다.

담고 있는 것에 비해 너무 작은 판은 모든 카드에 최소 크기를 줄 수 없다. 축의 통로는
갭을 그 범위를 통로를 가진 선과 프레임의 수로 나눈 값으로 제한한 것이고, 그래도 통로와
프레임을 담지 못하는 cut은 그 축의 통로를 절반씩 없음까지 줄인다. 각 kid는 적어도 그 안의
통로, px 크기, 프레임, head만큼 그려지고, fraction을 받는 kid는 나머지를 fraction대로
나누므로, 작은 fraction은 `minSize` 아래로 그려지고 판은 여전히 정확히 덮인다.

`minSize` 는 판이 아니라 연산을 구속한다. 자르기, 닫기, 삽입, 끌기는 각각 카드를 그
아래로 내리는 것을 거절하고, `gap` 과 `minSize` 와 `resize` 는 같은 fraction을 새 눈금으로
다시 표현한다. 그래서 바닥에 서 있는 지분 카드는 통로가 넓어지면 그 아래로 그려진다 —
갭이 더한 통로의 자기 fraction만큼 — 판에 아직 자리가 있어도 그렇다. 다시
쓰이는 것은 없다. 통로를 되돌리면 카드는 마지막 자리까지 그대로 그려진다. 통로와 무관하게
크기를 지켜야 하는 카드는 `setSize` 로 크기를 선언하고, 그 카드는 어떤 `gap` 에서도
선언한 대로 그려진다.

새로 들어온 카드는 ADD의 규칙으로 크기를 받는다([add and remove](#add-and-remove)).

px 크기는 tree의 자기 카드에 속하므로, 카드를 자르면 그것을 두 쪽으로 나누고, 카드 안에
놓이는 다른 cut의 선은 그것을 바꾸지 않는다. 선의 두 슬롯에 걸친 카드도 px 크기를 유지한다.

**R6 — 사각형은 한 곳에서 계산한다.**
`geometry.ts` 가 카드 사각형, 경계 규칙, 잡는 영역을 계산한다. `soksak.ts` 가
상태를 갖는다. `dom.ts` 는 자기 사각형 하나를 계산한다. rule 을 그리는 영역이며, 판을
둘러싼 프레임에 의존하므로 호스트만 아는 값이다.

**R7 — 배치가 대체할 카드를 옮길 수 없는 경우가 아니면 카드는 나갈 수 있다.**
마지막 하나를 제외한 모든 열린 카드는 닫을 수 있고, 그 결과는 다시 쪼개기로 만들 수
있었던 배치다. 카드는 자기 cut을 떠나고, 그 cut의 다른 kid가 한 인수로 그 share를
가지므로 그 비율이 유지된다. kid가 하나만 남은 cut은 그 kid로 바뀌며, cut을 홀로
채우는 카드는 그 cut의 축에 px 크기를 갖지 않는다.

`fixed` 카드는 sibling이 떠날 때 자기 크기를 유지한다. 그래서 cut에 자기 말고는
`fixed` 카드만 있는 카드는 남는다. `canClose` 가 무엇이 움직이기 전에 이것을
보고한다.

## 설치

```sh
pnpm add github:soksak-app/core#path:packages/soksak
```

git 에서 설치한다. npm 이름 `soksak` 은 무관한 패키지가 쓰고 있다. `dist/` 가
커밋되어 있으므로 빌드 단계가 없다.

ESM 전용이다. CommonJS 빌드는 없다.

## 모델

grid의 state는 그 slicing tree이며, tree가 저장 형태다. line과 cell은 tree에서
도출되고, tree를 그것들에서 다시 읽지 않는다.

```
state  {root}
root   node 하나
node   {card, data?, fixed?, width?, height?}     카드
       {box, data?, inner}                        host가 node 둘레에 그리는 box
       {cut, kids: [{share, node}, ...]}          축 cut("x" 또는 "y")을 따라가는 cut
```

cut은 그 node의 사각형을 그 축을 따라 kid의 순서대로 나누며, 각 kid는 cut 범위의
`share`를 받는다. share는 양수이고 합이 1이다. tree는 canonical이다. cut은 kid를
둘 이상 가지며, cut의 어떤 kid도 같은 축의 cut이 아니므로, 다섯 카드의 row는 어떻게
만들었든 다섯 kid를 가진 cut 하나다. box는 host가 node `inner` 둘레에 그리는
사각형이며(workbench의 group card 등), host의 data를 `data`에 둔다. layout은 box를
그 cut의 child 하나로 유지하므로 어떤 operation도 카드를 그것을 가로질러 놓지 않으며,
`setHeads({id: px})`는 host가 box 안쪽 위, inner node 위에 그리는 px를 주고, 그려진
크기와 최소가 그것을 센다. head는 frame처럼 state의 일부가 아니다. 모든 카드와 box는
tree에서 한 번만 가리키는 id를 가진다.

line은 node의 사각형이 시작하고 끝나는 좌표로, 한 축의 지분을 가진 slot 위에서
0부터 1까지다. `xs`는 세로 line, `ys`는 가로 line이다. 10억분의 1 안의 좌표는 한
line이므로, 한 좌표에서 끝나는 두 cut의 사각형은 한 line을 그리고, 카드는 그
사각형이 시작하고 끝나는 line 사이의 cell `{id, c0, c1, r0, r1}`이며, 규칙의
geometry가 그것을 읽는다(R1, R5). 한 line에 선 두 cut의 두 seam은 여전히 두
seam이다. tree의 operation은 카드나 box가 속한 cut을 tree에서 읽으므로, 두 row가
우연히 함께 쓰는 line은 어떤 결과도 바꾸지 않는다. 경계 drag는 사람이 보는 line을
옮기므로 그 line에 선 모든 seam을 옮기며, 각 seam은 자기 cut 안에서 움직인다
([경계](#경계)).

state는 payer를 기록하지 않는다. close는 카드의 share를 그 cut의 다른 kid에 한 인수로
주므로(R7), 카드의 자리는 그 카드가 어느 카드에서 왔는지에 따르지 않는다.

`Soksak.from(state, options?)`, 생성자, `replace(state)`와 `checkState(state)`는 이
형태만 읽는다. 이전 release의 형태인 `xs`, `ys` 또는 `cards`를 가진 state는
`soksak: the state holds xs, ys and cards, which is the earlier form; the state is
{root}`를 던지고, `paidBy`를 가진 state는 `soksak: the state holds paidBy, which the
layout does not record; the state is {root}`를, `root` 말고 다른 member를 가진 state는
`soksak: the state holds <members>; the state is {root}`를 던지며, 다른 형태의 node는 `soksak: the node <json> is not a card, a
box or a cut`을, kid가 둘 미만인 cut, 그 cut의 축을 따라가는 kid cut, 양수가 아니거나
합이 10억분의 1 안에서 1이 아닌 share는 `soksak: the cut <path> is not canonical:
<reason>`을, 두 node를 가리키는 id는 `soksak: card <id> is stored twice`를 던진다.
아무것도 변환하지 않는다.

### tree가 state인 이유

이전 state는 line과 cell이었고, 각 operation이 그것들에서 slicing tree를 다시
만들었다. line이 우연히 한 좌표에 선 두 cut은 한 cut으로 읽혔으므로, 한 row의
operation이 다른 row를 바꿨다. 생성한 operation 40개의 seed 32개에서
`docs/spec/groups.ko.md#불변식`의 불변식 I7, I8, I10이 63번 실패했고, 모두
line이 둘 이상의 tree로 읽히는 layout에서였으며 다른 layout에서는 없었다
(`docs/spec/cases/layout/invariants.json`).

반론과 답:

- *line은 geometry의 contract(R1, R5)이고, tree는 같은 layout의 두 번째 기술이다.*
  저장되는 기술은 tree뿐이다. line은 사각형이 line에서 계산되듯 변경마다 tree에서
  계산되므로, 어떤 reader도 두 형태를 갖지 않는다.
- *다른 row에서 line에 붙는 이후의 split이 더 이상 row를 잇지 않는다.* split은 여전히
  snap 거리 안의 line에 놓이고 두 row는 한 line을 그린다. row는 두 cut으로 남으므로
  한 row의 이후 operation은 다른 row를 옮기지 않는다. 그 line의 경계 drag는 사람이
  그려진 line을 끌므로 둘 다 옮긴다.
- *close가 더 이상 카드의 자리를 우연히 줄이 맞는 이웃에게 줄 수 없다.* 그런 이웃은
  카드의 cut의 kid가 아니므로 그들에게 자리를 주면 다른 cut의 구조를 가로지른다.
  close는 자리를 자기 cut의 kid에게 주며, 모든 cut이 kid를 둘 이상 가지므로 R7은
  언제나 그것을 찾는다.
- *이전 release의 저장된 layout이 열리지 않는다.* release가 0.0.x인 동안 어떤 저장
  형태도 정해지지 않았다. reader는 이전 형태를 file을 밝히는 error로 거부하고,
  layout을 담은 repository의 모든 file은 그 reader가 그것을 읽게 하는 변경에서
  tree 형태로 쓰인다([persistence](../../../docs/spec/projects.ko.md#저장)).

## 사이드바도 카드다

```js
const grid = new Soksak({
  root: { cut: "x", kids: [
    { share: 1 / 3, node: { card: "left", width: 180, fixed: true } },
    { share: 2 / 3, node: { cut: "y", kids: [
      { share: 0.5, node: { card: "terminal" } },
      { share: 0.5, node: { card: "browser" } },
    ] } },
  ] },
}, { width: 1200, height: 800 });
```

`width` 는 카드를 180px 폭으로 만들고 나머지가 남은 자리를 나눈다. `fixed` 는 배치가
그것을 쪼개거나 닫거나 옮기지 못하게 한다. 같은 카드가 가운데 열에 있으면 레일이다.
px 크기는 걸친 슬롯과 무관하게 카드에 속한다.

나머지 API 는 모든 카드에 동일하게 적용된다.

```js
grid.rects();               // Map<id, {x, y, w, h}>
grid.split("terminal", "x");
grid.close(id);
grid.move("rail", "browser", "right");
```

## 빠른 시작 — DOM

`SoksakView` 가 위치를 지정하고, 요소의 수명을 관리하고, 포인터 입력을 처리한다.
누름을 마우스 이벤트로 전달하는 호스트를 위해 마우스 입력도 처리한다. divider 의
`mousedown`, 그리고 그 문서의 `mousemove` 와 `mouseup` 이다. 카드 요소는
`createCard` 가 만든다. 뷰가 만드는 요소는 클래스 이름과 data 속성만 갖는다.

```js
import { Soksak, SoksakView } from "soksak";

const host = document.querySelector("#stage");   // position: relative 가 필요하다
const grid = new Soksak();

const view = new SoksakView(host, grid, {
  createCard(card) {
    const el = document.createElement("article");
    el.className = "card";
    el.append(mySurfaceFor(card.id));            // 렌더 사이에 재사용된다
    return el;
  },
  onChange() { drawOutline(); },
});
view.render();
```

카드 요소는 한 번 만들어 재사용하므로, 그 안의 살아 있는 표면 — 터미널, 웹뷰,
캔버스 — 은 배치 변경으로 파괴되지 않는다. 쪼개기는 원래 카드와 그 가까운 절반을
유지하고 새 카드가 먼 절반을 갖는다.

| 요소 | 클래스 | 뷰가 쓰는 속성 | 인라인 스타일 |
| --- | --- | --- | --- |
| `createCard` 가 만든 카드 | 호출자의 것 | `data-card-id`, `data-fullscreen`, `hidden` | `position`, `left`, `top`, `width`, `height` |
| 잡는 영역 | `sp-divider` | `data-axis`, `data-line`, 잡고 있는 동안 `data-dragging`, `tabindex="0"`, `role="separator"` | 위와 같고 `touch-action: none` 이 더해진다 |
| 경계선 | `sp-rule` | `data-axis`, `data-virtual` | 위와 같고 `pointer-events: none` 이 더해진다 |

rule 의 `data-virtual` 은 카드가 그 선에서 나뉘는 구간만이 아니라 판 전체를 지나는
rule 을 표시한다.

```css
#stage { position: relative; }
.card { box-sizing: border-box; }
.card[hidden] { display: none !important; }
.card > * { min-width: 0; }                /* 아래의 위험을 보라 */
```

## 선과 디바이더

뷰는 그것을 배치하고 생김새는 정하지 않는다. `installTheme` 이 그것을 정하는
스타일시트를 문서에 넣는다. 축마다의 커서, 잡는 영역 안의 가는 그립, 그리고 선이
교차하는 부분을 나머지보다 흐리게 그리는 규칙이다. 잡는 영역의 크기는 뷰가 정하며,
`grabSize` 와 통로 중 큰 쪽이다.

```js
import { installTheme } from "soksak";

installTheme(document);
```

색과 크기는 토큰에서 읽는다. 그래서 자기 색을 가진 호스트는 토큰을 그 색으로
가리키기만 하면 되고 나머지는 바꾸지 않는다. 토큰 이름은 뷰의 `classPrefix` 를
따르며 `themeTokens()` 가 그 이름을 보고한다.

```css
:root {
  --sp-line: var(--border);
  --sp-line-crossing: var(--border-faint);
  --sp-grip: var(--text-faint);
  --sp-grip-active: var(--accent);
  --sp-grip-thickness: 3px;
  --sp-grip-length: 24px;
}
```

라이트와 다크는 호스트의 것이다. 호스트는 테마가 바뀔 때 이미 그 색을 바꾸고, 이
값들은 그것을 따라 바뀐다. 여기서는 호스트의 토큰 이름도, 지금 적용된 모드도 읽지 않는다.

디바이더를 가리키거나 포커스하거나 쥐면 그립의 색이 0.12초에 걸쳐 바뀐다. 이 전환은
시트의 유일한 움직임이고 어느 토큰도 그것을 정하지 않으므로, `prefers-reduced-motion:
reduce` 에서는 시트가 스스로 그것을 끈다. 여기서 설정을 읽는 규칙은 이것 하나뿐이고,
그 설정은 호스트의 것이 아니라 사람의 것이다.

`themeCSS()` 는 같은 스타일시트를 문자열로 반환한다. 문서가 아니라 자기 파일에 넣는
호스트를 위한 것이다. 그 규칙도 함께 반환한다. `themeTokens()` 로 자기 시트를 쓰는
호스트는 그 규칙을 직접 쓴다.

디바이더를 끌면 경계가 움직인다. 더블클릭하면 (또는 포커스된 상태에서 Enter/Space 를
누르면) 경계를 가운데로 옮겨 양옆 두 카드를 같은 크기로 만든다. 고정 너비를 가진 카드
옆에서도 그렇다. 너비는 숫자이고 숫자에는 절반이 있다. 사이드바가 더블클릭으로
가운데 정렬되기를 원하지 않는 호스트는 그 디바이더에 이 제스처를 주지 않으면 된다.

제스처는 뷰가 만든 변경을 따라간다. 끌기와 가운데 정렬과 병합은 각각 선의 번호를
다시 매기고, 손가락 아래의 디바이더는 자기 경계가 지금 서 있는 선으로 옮겨진다.
호스트가 판에 가한 변경은 어떤 제스처도 옮기지 않는다. 뷰는 그것을 `render()` 로,
일어난 뒤에 전달받고, 카드가 들어오거나 나가면 선의 번호와 선이 서 있는 자리가
함께 바뀌기 때문이다. 그래서 그런 변경에 대해서는 제스처를 정리한다. 경계가
디바이더를 잡는 너비 안에 그대로 있으면 같은 손잡이이므로 제스처는 그 경계를 계속
잡고, 그보다 멀리 옮겨졌으면 제스처가 잡은 적 없는 경계이므로 제스처는 거기서
끝난다. 디바이더는 `data-dragging` 을 더 이상 달지 않고, 다음 이동은 아무 경계도
움직이지 않는다.

정리는 호스트가 부르는 `render()` 에서 — 거기에 어떤 이유를 적든 — 실행되고, 다른
어디에서도 실행되지 않는다. **호스트는 판을 바꾸고 같은 차례에 `render()` 를 부른다.**
그 사이에 제스처에 관여하는 것이 없으므로, 누름과 키와 이동과 놓음은 언제나 직전 변경의
렌더 뒤에 오고, 그 경로들은 요소와 일치하는 판을 읽는다. 판을 바꾸고 나중에 그리는
호스트는 자기 제스처에게 옮겨진 경계를 건네면서 그 사실을 알리지 않는 것이다. 뷰는
전달받지 못한 변경을 알 방법이 없다.

`commit` 훅이 뷰가 만든 변경의 그리기를 붙들고 있는 동안에는
디바이더가 그 변경만큼 뒤처져 있고 제스처는 그 변경을 따라 옮겨졌으므로, 그때의 누름은
평소대로 경계를 잡는다. 잡는 것은 그 제스처가 잡고 있는 경계다. 디바이더가 달고 있는
번호는 호스트가 아직 수행하지 않은 그리기가 쓰기 때문이다. 그 변경이 선을 하나
없앴다면 다른 모든 디바이더는 번호를 다시 매기며 밀려난 번호를 달고 있으므로, 그중
하나를 눌러도 그리기가 끝나기 전까지는 아무 경계도 잡지 못한다. `render()` 가 넘기는
그리기는 애초에 그런 그리기가 아니다. 뷰는 그 호출 앞에서 호스트가 판을 바꾸었는지
전달받지 못하므로 모든 `render()` 는 그랬을 수 있는 호출이다.

**카드의 자식이 뷰가 지정한 사각형을 부풀릴 수 있다.** flex 나 grid 의 자식은
`min-width: auto` 가 기본이라 열이 min-content 까지 늘어나고, 요소는 지정받은 크기보다
넓은 사각형을 보고한다. `overflow: hidden` 은 그것을 가리지만 사각형을 줄이지는
않으며, 카드가 클리핑하지 않는 채로 그 사각형을 기준으로 배치된 것은 — 예를 들어
페이지 위에 합성되는 OS 뷰는 — 카드 밖에 놓인다. 자식에게 `min-width: 0` 을 주라.

## 경계

경계는 그 축을 따라 자르는 cut들 가운데 그 선에 선 seam들이고, 끌기는 그 각각을 같은 px만큼
옮긴다. 각 seam은 자기 cut에서 그 seam에서 만나는 두 kid만 바꾸고 다른 것은 바꾸지 않는다.
seam 앞의 kid는 옮긴 만큼 크게, seam 뒤의 kid는 작게 그려진다. px 크기를 가진 kid는 그려지는
배율로 새 크기를 받고, fraction을 받는 kid들은 새 content의 fraction을 받는다. 다른 cut의
선은 한계가 아니다. 다른 cut의 kid는 바뀌지 않기 때문이다. 그 선 너머로 끌린 seam은 그 선을
지나가고, 그 선 위로 끌린 seam은 그 선과 합쳐지므로, 두 seam이 한 선에 서고 이후의 끌기는
둘을 함께 옮긴다. `moveBoundary`는 seam이 도달한 위치를 선이 다시 유도된 뒤, 그때 서 있는
선에서 읽어 돌려준다.

판이 한 축의 px 크기 선언을 담지 못하면 선언된 크기는 모두 한 인수로 축소되어
그려지고, 그 크기가 한쪽에만 있는 경계는 움직이지 않는다. 선언된 크기를 바꾸면 선언을
가진 다른 카드가 모두 다시 그려지고, 나누어 쓰는 슬롯들은 언제나 같은 나머지를 나눠
갖기 때문이다. `boundaryRange` 는 그 경계가 서 있는 위치를 두 번 반환해 이를 알리고,
가운데 정렬도 같은 이유로 아무 일도 하지 않는다. 양쪽 모두 선언을 가진 경계는 계속
움직인다. 그 쌍은 둘이 선언한 크기의 합을 유지하기 때문이다.

`boundaryRange` 는 같은 seam들에서 나온다. seam 옆의 각 kid는 그 안의 카드가 `minSize` 와
그 안의 head보다 작게 그려지기 전까지 잃을 수 있는 만큼을 내준다. 카드는 거기까지 잃고,
box는 inner node가 내주는 만큼, 축을 가로지르는 cut은 가장 적게 내주는 kid만큼 내주며, 축을
따라 자르는 cut은 그 손실을 fraction을 받는 kid들에 content에 비례해 나눈다. 카드가 아니면서
px 크기를 가진 node는 재귀 최소 크기([cuts](#cuts))까지 내준다. 범위는 경계의 위치에서 seam
앞의 kid들이 내주는 가장 적은 양을 뺀 곳부터, seam 뒤의 kid들이 내주는 가장 적은 양을 더한
곳까지다. 최소 크기 이하로 그려진 kid는 아무것도 내주지 않으므로, 범위는 언제나 경계가 서
있는 위치를 담는다. `minSize: 0` 이 허용하듯 카드를 면적 없이 남기는 이동은 아무것도 바꾸지
않는다. `boundaryRange` 는 끌기의 한계를 정할 뿐, 끌기가 어디서 멈출 수 있는지를 나열하지
않는다.

같은 규칙이 나타나거나 사라지는 카드를 정리한다. root의 kid i와 i+1 사이 경계에 삽입된
카드는 kid i 옆 kid i+1 쪽에 더해진다([add and remove](#add-and-remove)). fraction을
받는 root의 kid들이 하나의 fraction을 가지거나 kid i가 px 크기를 가지면, fraction을 받는
모든 kid가 비례해 몫을 내고 비율을 유지한다. 그렇지 않으면 kid i 혼자 span을 내고 다른
모든 kid는 fraction을 유지한다. 모든 kid가 px 크기를
가지면 모든 kid가 몫을 낸다. 판의 가장자리에 삽입된 카드는 root 옆에 더해지므로 px
크기가 없는 모든 kid가 비례해 몫을 낸다. 카드를 `minSize` 아래로 만드는 삽입은
거부된다. 닫히는 카드는 자기 cut을 떠나고, 그 cut의 다른 kid의 fraction은 한 인수로
늘어난다. px 크기가 없는 `fixed` 카드는 그 cut의 고정 비용이므로, 옆에 kid가 들어오거나
나가도 그려진 크기를 유지한다. 그래서 사이드바를 껐다 켜면 root가 고를 때 다른 모든 카드는 갖고 있던 너비를 유지하고,
고르지 않은 root에서는 자리를 낸 kid가 낸 것보다 적게 돌려받는다. 판이 그 축의 선언을
담지 못하면 지분을 가진 kid의 px 크기는 한 인수로 축소되어 그려지고, 그 cut에 카드가
들어오거나 나갈 때 그 인수가 바뀐다. `fixed` 카드는 판이 비용과 지분을 가진 kid의
`minSize` 하나를 담는 동안 px 크기를 유지한다.

px 크기는 호스트가 선언한다. 끌기가 그것을 바꾸고, 자르기는 그것을 두 쪽으로 나눈다.
닫기는 span을 자기 cut의 다른 kid에 주고, 삽입은 경계 앞의 kid나 모든 kid에서 그것을
가져온다.

```js
grid.dividers();                       // 각 경계를 어디서 잡을 수 있는지
grid.boundaryPos("x", 1);              // px
grid.boundaryRange("x", 1);            // [min, max] px, 무언가 minSize 에 도달하기 전까지
grid.moveBoundary("x", 1, 260);        // px
grid.centerBoundary("x", 1);
```

## Cuts

`even()`은 tree([모델](#모델))의 모든 cut에서 fraction을 받는 모든 kid에 같은 share를 준다. 그래서
결과는 배치를 만든 operation의 순서가 아니라 배치에 달려 있다. 다섯 카드의 row는
절반씩 만들었든 셋으로 나눠 만들었든 같은 다섯 카드이고, 같은 수의 카드를 가진 두
row는 seam을 같은 line에 그린다.

box `{box, data?, inner}`는 tree가 그 cut의 kid 하나로 유지하는 host의 사각형이므로
어떤 cut도 그것을 가로지르지 않는다. `setHeads({id: px})`는 host가 각 box 안쪽 위,
inner node 위에 그리는 px, 곧 head와 그 아래 간격을 준다. 항목이 없는 box는 head가
없다. inner node 맨 위의 카드나 box는 box의 위쪽부터 그려지므로 head는 그 위쪽 안에 선다. `setHeads`는 box가
아닌 id에 `soksak: heads name "<id>", which is no box`를, 음수이거나 유한하지 않은
head에 `soksak: the head of "<id>" is <value>`를 던지며, head는 state의 일부가 아니다.

크기의 모든 규칙은 tree의 fraction으로 일한다. cut은 먼저 자기 범위에서 고정 비용을
뺀다: kid 사이의 corridor, px 크기를 유지하는 kid의 px 크기, kid 가운데 box의 frame과
head다. fraction을 받는 각 kid는 자기 frame과 head에 나머지의 자기 fraction을 더한
크기로 그려지므로, fraction이 같은 kid는 plane의 경계에서나 두 corridor 사이에서나 frame
안에서 같은 크기로 그려진다. cut에서 fraction을 받는 kid들이 하나의 fraction을 가지면 그
kid는 형제와 고르며, `even`은 모든 cut의 그런 kid에 하나의 fraction을 준다. gap 변경,
head 변경, resize는 모든 fraction을 유지하므로, 고른 cut에서의 ADD와 REMOVE는 그 사이에
무엇이 바뀌었든 그것을 정확히 되돌린다. cut의 축에 px 크기를 가진 카드와 `fixed` 카드는
자기 크기를 유지하고 fraction을 받지 않는다. minimum 아래의 결과는 아래와 같이 던지며,
던지면 아무것도 바뀌지 않는다.

node의 minimum은 재귀적이며 head와 corridor를 고정 비용으로 센다. 카드는 `minSize`와
`y`에서 그 사각형 안에 그려지는 head를 필요로 하고, px 크기를 가진 카드는 그 크기와
`minSize` 가운데 작은 것을, px 크기를 가진 `fixed` 카드는 그 크기와 전에 가졌던 크기
가운데 작은 것을, 다른 `fixed` 카드는 그려진 크기를, box는 그 inner node가 필요로 하는
것을, cut은 자기 축에서 kid의 필요와 그 사이 corridor의 합을, 가로 축에서 kid 필요의
최댓값을 필요로 한다.
operation 뒤에 사각형이 바뀐 모든 카드와 box를 판정하고, 필요보다 작게 그려지는
가장 깊은 것이 `card <id> would be <w>x<h>, below its minimum <w>x<h>`를 던진다.
box는 그 안의 node가 필요보다 작을 때만 필요보다 작으므로, 이 문구는 자리가 없는
node를 가리키고, box 안의 content card를 box보다 먼저 가리킨다. 카드는 content의
크기로 가리킨다. 그 사각형 안에 그려지는 head를 가질 크기와 필요에서 빼므로, 그
필요는 `minSize`나 px 크기다. box는 그 안의 어떤 node도 필요보다 작지 않을 때 그
사각형과 필요로 가리킨다.

모든 operation은 건드리는 node 수에 선형이다. tree는 각 id에서 그 node로, 각
좌표에서 그 line으로 가는 map을 유지하므로, 어떤 operation도 카드 하나를 위해 tree
전체를 훑지 않는다. `visits`는 마지막 operation이 방문한 node 수를 읽으며, test는
시간 대신 큰 tree에서 그것을 제한한다.

```js
grid.setHeads({ "group-1": 44 }); // box의 head
grid.even();                      // 모든 cut을 고르게
grid.visits;                      // even이 방문한 node 수
```

### Add and remove

`withdraw(id)`는 카드나 box인 node `id`를 그 cut에서 꺼낸다. cut의 다른 kid의 fraction은
close와 같이 한 인수로 늘어나며, kid가 하나만 남은 cut은 그 kid로 바뀐다. 그 kid의 kid
가운데 그것을 담는 cut의 축을 따르는 cut은 그 cut에 합쳐지고, 모든 kid는 그려진 크기를
유지한다. px 크기를 유지하는 kid는 fraction과 상관없이 그 크기로 그려지고, 모든 kid가 px
크기를 유지하는 cut은 그 공간을 그 비율로 나누므로, 합쳐지기 전에 선언보다 크게 그려질 수
있다. 그래서 cut에서 `fixed`가 아니고 px 크기를 유지하는 각 카드는 px 크기를 유지하는
node를 거쳐 그려진 크기로 기록되고, `fixed` 카드는 그 px 크기로 cut의 비용으로 남는다.
합쳐지는 kid는 남은 것의 fraction을 받으므로 두 cut 밖의 어떤 kid도 바뀌지 않는다. 떠난 node, 곧
카드 node이거나 inner node를 가진 box node를 돌려주고 `insert`가 그것을 받으므로,
box는 member의 비율을 유지한 채 놓인다. 마지막 카드와 `fixed` 카드는 거부된다.

`insert(target, side, node)`는 새 카드 `{card, data?}`나 `withdraw`가 돌려준 것인
`node`를 `target` 옆 `side` 쪽에 더하고 그 id를 돌려준다. `target`은 id이거나 한
cut의 이웃한 kid들이 가진 id들이며 각 id는 한 번이다. id를 두 번 이름한 target은
거부된다. target의 cut을 따라서는, fraction을 받는 kid k개의
고른 cut은 node에 그 fraction의 1/(k+1)을 주고 다른 모든 fraction에 k/(k+1)을 곱하며,
fraction이 다른 cut은 node에 target fraction의 절반을 주고 다른 모든 fraction을
유지한다. px 크기를 유지하는 node는 자리를 내는 kid에서 새 corridor와 함께 크기를
가져온다. target이 cut 자체이면 `side` 쪽 끝의 kid가 target이다. side의 축을 따라 한
cut의 이웃한 kid들의 id는 그 cut 안의 run이다. node는 kid 옆에서와 같이 run 옆에서 그
cut에 더해지고, run은 자기 cut으로 감싸지지 않는다. cut을 가로질러서는
target을 두 절반의 새 cut으로 감싼다. operation이 바꾼 cut만 다시 놓으므로 다른 모든
카드는 사각형을 유지한다. move는 `withdraw`와 `insert`다.

`exchange(a, b)`는 카드나 box인 node `a`를 node `b`가 선 자리에, `b`를 `a`가 섰던
자리에 tree의 어느 두 자리에서든 둔다. 각 자리는 그려진 크기를 유지한다. 자리에
들어가는 node는 그 크기에서 자리의 비용인 자기 frame과 head를 뺀 크기를 받으므로,
box는 거기 섰던 카드의 fraction이 아닌 자리의 크기로 들어가고, 카드는 그 자리의
카드가 선언한 px 크기를 받는다. 다른 모든 node는 사각형을 유지한다. 하나가 다른 하나를 담는 두 node,
`fixed` 카드, layout이 담지 않은 id는 거부되고, 결과는 `insert`처럼 판정된다.

`vacates(id, target, side)`는 `target`과 `side`가 카드나 box인 node `id`의 vacated
slot을 가리키는지다(`docs/spec/groups.md#vacated-slot`). 곧 그 node 자신, 또는 그
cut에서 그 앞의 kid와 그쪽을 향한 side `right`나 `bottom`, 또는 그 뒤의 kid와 그쪽을
향한 side `left`나 `top`이며, kid는 그 id로, cut이면 그 member로 가리킨다. 거기로의
move는 `id`의 `withdraw`의 역이므로 workbench는 그것을 변화 없음으로 한다.

`vacatedSlot(id)`는 node `id`의 그런 slot 하나를 `{target, side}`로 준다
(`docs/spec/groups.ko.md#idempotency`). 곧 그 cut에서 그 앞의 kid와 그쪽을 향한 side,
없으면 그 뒤의 kid와 그쪽을 향한 side이며, kid는 그 id로, cut이면 그 member로
가리키고, 곁에 `fixed` 카드가 아닌 kid가 없으면 `{target: id, side: "right"}`다.
workbench는 move를 그것으로 답하므로, 그 답으로 되풀이해도 변화가 없다.

`group(target, side, node, {box, data?, head})`는 카드나 box인 `target`의 group
split이다. id가 `box`이고 페이로드가 `data`이며 head가 `head` px인 box가 그 cut에서
`target`의 자리를 그 fraction과 함께 차지하고, 그 inner node는 `side`의 축을 따르는
두 절반의 새 cut으로 `target`과 `side` 쪽의 `node`를 담는다. head는 `setHeads`의
head에 더해지고, 결과는 새 box의 head와 frame과 함께 한 번 판정되므로, 거부는 group이
최소보다 작게 그릴 가장 깊은 node를 head 아래 content 크기로 가리킨다. layout이 가진
id는 거부된다.
`unwrap(id)`는 그 반대다. box `id`의 inner node가 그 자리를 차지하고 head는 box와 함께
떠나며, box를 담은 cut의 축을 따르는 cut은 모든 kid를 그려진 크기로 두고 그 cut에
합쳐진다. box의 `close(id)`는 카드의 close와 같이 그 안의 모든 카드와 함께 box를 꺼낸다.

```js
const left = grid.withdraw("card-3");             // row가 비율대로 빈자리를 메운다
grid.insert("card-1", "right", left);             // card-3이 card-1 오른쪽에 놓인다
grid.insert(["card-1", "card-2"], "bottom", { card: "card-9" }); // 둘 아래에 새 row
```

workbench는 모든 layout operation을 [크기 규칙](../../../docs/spec/groups.ko.md#크기-규칙)으로 이 둘에서 조합하며,
`docs/spec/cases/layout/invariants.json`이 그 불변식을 두 언어에서 생성한 layout에
대해 검사한다.

## 균등 배치

`arrange("even")`은 현재 순서의 카드를 격자로 다시 배치한다. 분할과 합치기를
모두 제거하므로 결과에는 다른 카드를 가로지르는 카드가 없고, 격자선 외의 선이 없다.

- 카드 수 `n`은 레이아웃의 카드 수다.
- `rows * columns`가 `n` 또는 `n + 1`이 되도록 `rows`와 `columns`를 고른다.
  `n + 1`을 고르면 격자를 채우도록 빈 카드 하나를 더한다.
- 그 후보 중 셀이 양 축에서 `minSize` 이상인 것만 남기고, 셀이 정사각형에 가장
  가까운 것을 고른다. 동률이면 빈 카드가 없는 후보를 고른다.
- 카드는 읽는 순서대로 채운다. 첫 행을 왼쪽에서 오른쪽으로, 그다음 행을 이어서 채운다.
- 모든 셀은 같은 그려진 크기다.
- 어떤 후보도 모든 셀을 `minSize` 이상으로 두지 못하면 `arrange("even")`은 false를
  반환하고 아무것도 바꾸지 않는다.

격자는 평면 크기에 따라 정해진다. 평면이 넓을수록 열이 많고, 평면이 높을수록 행이 많다.

```js
grid.arrange("even");
```

## 판을 가로지르는 카드

레일은 페인 사이에 서서 판의 한쪽 끝에서 반대쪽 끝까지 이어진다. 카드를 쪼개서 만들 수
없다. 그러면 그것은 자기가 나온 카드의 범위를 갖게 되어 다른 페인과 다를 바 없다.
어떤 카드도 가로질러 걸치지 않은 경계에 들어가고, 그 뒤의 모든 카드가 그 구간만큼
밀린다.

```js
grid.standings("x");            // 그런 카드가 설 수 있는 경계들
grid.canInsertAt("x", 2);
grid.insertAt("x", 2, { id: "rail", size: 190 });
grid.setFixed("rail", true);           // 배치가 옮기지 않는다
grid.setSize("rail", "x", 210);        // 그리고 이만큼 넓다. null 이면 지분을 갖는다
grid.setData("rail", { pty: 3 });      // 호스트의 페이로드
grid.moveTo("rail", "x", 4);    // 한 열이 나가고 한 열이 들어온다
```

이 이동은 아무것도 닫지 않고 아무것도 쪼개지 않는다. 슬롯 자체가 움직인다. 그것이
지나간 카드들은 그 구간만큼 밀리고, 다른 모든 선은 갖고 있던 좌표를 유지하며, 다른
축의 경계는 하나도 움직이지 않는다. 안쪽 경계 사이에서는 다른 어떤 카드의 너비도
바뀌지 않는다.

판의 경계에 내려앉는 것만이 예외다. 경계는 통로를 갖지 않으므로 그 자리의 레일은 반
갭만큼 덜 쓰고, 경계에 딱 붙어 있던 카드는 이제 옆에 레일을 두고 반 갭을 내놓는다.
모든 카드가 판에서의 지분을 유지하며, 움직이는 것은 그 옆에 그려지는 통로다.

## 카드 옮기기

카드를 다른 곳으로 끄는 것은 하나의 연산이지, 호출자가 순서대로 실행하는 닫기와
쪼개기가 아니다. 순서가 중요하다. 먼저 닫으면 자리가 돌아오면서 목표의 형태가 바뀌므로
자르기는 그 뒤에 측정되고, 닫기가 불가능하면 이동 전체가 일어나지 않는다. 절반만
일어나지 않는다.

```js
grid.canMove("terminal", "browser", "right");   // 보고할 뿐 바꾸지 않는다
grid.move("terminal", "browser", "right");      // 거절되면 false 이고 아무것도 바뀌지 않는다
```

카드는 자기 id, 페이로드, px 크기를 유지한다. 다만 혼자 채우게 되는 cut의 축에서는 자기
크기를 갖지 않는다(R7).

`splitToward(id, side, init)` 는 지정한 쪽에 새 카드를 놓는다. `split` 은 먼 절반을
새 카드에 주므로 `left` 와 `top` 은 두 구간을 맞바꾼다. id 는 맞바꾸지 않는다.
거부된 split은 throw하고 아무것도 바꾸지 않는다. 모르는 축이나 쪽, layout이 가진 id,
모르는 카드나 `fixed` 카드, cut의 corridor보다 넓지 않게 그려진 카드(`card <id> would
be 0x<h>, below its minimum <m>x<m>`, `y`에서는 `<w>x0`. `minSize`가 0이면 `card <id> would be
<w>x<h> and have no area`), 그리고 node를 최소보다 작게
그리는 cut이며, 마지막은 그런 가장 깊은 node를 가리킨다.

## 드롭이 내려앉는 곳

```js
grid.zoneAt(x, y, { headerPx: 34, footerPx: 24, edge: 0.25, centreOnly: draggingId });
// → { id, zone: "centre" | "left" | "right" | "top" | "bottom" } | null
```

`centre` 는 카드 자체를 뜻한다. 방향은 그 옆의 새 자리를 뜻한다. `headerPx` 와
`footerPx` 는 제외되므로 크롬 위의 점은 방향이 아니라 카드를 반환한다. `edge` 는 각
가장자리가 차지하는 몫이며 px 가 아니라 몸통의 비율이다. 기본값은 `0.25` 이고
`0..0.5` 밖의 값은 다른 옵션과 같이 거절된다.

## 외곽선

통로로 떨어진 카드들은 서로 맞붙지 않으므로 그냥 합치면 각자 하나씩의 고리로 흩어진다.
먼저 키운다. `pad = gap / 2` 에서 키운 사각형들이 통로의 중앙선에서 만나 합집합이
하나의 형태로 닫힌다. 직각은 반경이 들어가는 곳에서 호가 되며, L 자의 우각도
포함한다. 반경은 그 자리에서 만나는 두 변 중 짧은 쪽의 절반으로 제한되고, 호를 넣기에
너무 좁은 모서리는 직선으로 잘려 그려진다. `Outline.corners` 가 모서리 수를,
`Outline.sharp` 가 그중 잘린 수를 센다.

```js
import { outline } from "soksak";

const rects = ["left", focused].map((id) => grid.rect(id)).filter((r) => r !== undefined);
const shape = outline(rects, { pad: grid.gap / 2, radius: 14 + grid.gap / 2 });
path.setAttribute("d", shape.path);   // fill(evenodd) 과 stroke 양쪽에 쓸 수 있다
shape.loops.length;                   // 카드가 붙어 있으면 1, 떨어져 있으면 2
```

`contains(shape.loops, x, y)` 가 한 점을 검사한다.

## 모든 카드가 닫을 수 있는 이유 (R7)

state는 slicing tree이므로(R4) 풍차 — 네 카드가 각각 가운데 카드에 걸쳐 있어 어느
쪽도 그 자리를 대신할 수 없는 배치 — 는 저장될 수 없고, 어떤 연산도 거기에 도달하지
않는다.

닫기는 카드를 자기 cut에서 빼고 그 share를 같은 cut의 다른 kid에 한 인수로 준다. 모든
cut은 kid가 둘 이상이므로 다른 kid는 항상 존재한다. `fixed` 카드는 자기 크기를 유지하므로
share를 받지 않는다. fixed 카드를 담은 cut이나 box는 다른 kid처럼 share를 받는다.

이로써 마지막 하나를 제외한 모든 열린 카드에 대해 `canClose` 가 참이다. 앞서 무슨 일이
있었든 그렇다. 위의 R7 경우 — 카드의 cut의 다른 kid가 모두 `fixed` 카드인 경우 — 만
예외다. `fixed` 카드에 대해서는 `canClose` 가 거짓을 반환한다. 배치가 그것을
옮기지 않기 때문이며, `setFixed` 로 먼저 플래그를 지우면 된다.

## 옵션

| 옵션 | 기본값 | 의미 |
| --- | --- | --- |
| `gap` | `24` | 카드 사이의 통로, px. 그 절반이 모든 안쪽 가장자리를 들여쓰고 외곽선의 `pad` 가 된다. |
| `minSize` | `96` | 카드 변의 최소 길이, px. |
| `grabSize` | `11` | 잡는 영역의 최소 크기, px. `gap` 과 별개이므로 `gap: 0` 에서도 끌 수 있다. |
| `snap` | `"merge"` | 끌린 경계가 거의 만난 선에 내려앉고, 둘은 그때부터 한 선이다. `"off"` 면 내려앉지 않는다. |
| `frames` | `"corridor"` | box의 프레임이 왼쪽, 오른쪽, 아래쪽에서 차지하는 것 (R5). `"none"` 이면 아무것도 차지하지 않는다. |
| `snapDistance` | `7` | 얼마나 가까워야 하는지, px. |
| `width`, `height` | `0` | 판의 크기. `resize(w, h)` 가 갱신하며 뷰가 대신 해 준다. |

## API

`Soksak`

| | |
| --- | --- |
| `cards`, `card(id)`, `rect(id)`, `rects()`, `rectOf(card)` | 배치를 읽는다. box의 `rect(id)`는 그 frame을 두르는 사각형이다 |
| `resize(w, h)`, `width`, `height` | 판의 크기 |
| `canSplit(id, axis)`, `split(id, axis, {id?, data?, newLine?})` | 카드 하나를 둘로 자른다 |
| `splitToward(id, side, {id?, data?, newLine?})` | 자르고 새 카드를 지정한 쪽에 놓는다. `newLine` 은 카드가 가로지르는 line이 안에 있어도 가운데의 새 line에서 자른다 |
| `canClose(id)`, `close(id)` | 카드를, 또는 그 안의 모든 카드와 함께 box를 제거한다. 그 cut의 다른 kid가 한 인수로 그 share를 가지고 `fixed` 카드는 그려진 크기를 유지한다(R7). 카드가 `fixed`이거나 마지막 카드일 때, box가 `fixed`가 아닌 모든 카드를 담을 때, 또는 cut의 다른 모든 kid가 `fixed` 카드일 때 false다 |
| `canMove(id, targetId, side)`, `move(id, targetId, side)` | 카드를 다른 카드의 옆으로 옮긴다. close와 insert다 |
| `setFixed(id, on)`, `setSize(id, axis, px)`, `setData(id, data)` | 카드를 변경하고, `setData`는 box의 페이로드도 바꾼다. 반환된 사본은 동결되어 있다 |
| `unwrap(id)`, `headsAbove(id)` | box `id`의 inner node를 head 없이 그 자리에 놓고, 그 cut의 축을 따르는 cut은 모든 kid를 그려진 크기로 두고 그 cut에 합쳐진다. 카드나 box 안쪽 위에 그려지는 head의 px ([add and remove](#add-and-remove)) |
| `standings(axis)`, `canInsertAt(axis, line)`, `insertAt`, `moveTo` | 판을 가로지르는 카드: 판의 가장자리와 그 축을 따르는 root cut의 seam |
| `zoneAt(x, y, options)` | 드롭이 내려앉는 곳 |
| `dividers()`, `rules()` | 잡는 영역과 그릴 경계 |
| `boundaryPos`, `boundaryRange`, `hasBoundary(axis, line)`, `moveBoundary(axis, line, px, allowSnap?)`, `centerBoundary` | 경계를 끈다 |
| `even()`, `setHeads(heads)`, `visits` | 모든 cut에서 fraction을 받는 모든 kid에 하나의 fraction을 준다. box의 head. 마지막 operation이 방문한 node 수 ([cuts](#cuts)) |
| `withdraw(id)` | 카드나 box를 그 cut에서 꺼낸다. 나머지의 fraction이 한 인수로 늘어난다 ([add and remove](#add-and-remove)) |
| `insert(target, side, node)` | target 옆에 카드를 더한다. 고른 cut에서는 1/(k+1), 고르지 않은 cut에서는 target의 절반, 가로질러서는 두 절반으로 감싼다 ([add and remove](#add-and-remove)) |
| `group(target, side, node, {box, data?, head})` | target 자리에 head를 가진 box를 놓고 그 안에서 target 옆에 node를 더하며, 한 번 판정한다 ([add and remove](#add-and-remove)) |
| `crossings(card)`, `cardsCrossing(axis, line)` | 카드가 가로지르는 선, 그리고 선을 가로지르는 카드 |
| `lines(axis)`, `toJSON()`, `Soksak.from(state, options?)`, `checkState(state)`, `replace(state)` | 검사와 상태 |
| `gap`, `minSize`, `grabSize`, `snapDistance`, `snap`, `frames` | 옵션. 생성 후에도 읽고 쓸 수 있다 |

축을 받는 모든 메서드는 `"x"` 나 `"y"` 가 아닌 값을 거절한다. 방향을 받는 모든
메서드는 `left`, `right`, `top`, `bottom` 이 아닌 값을 거절한다. 거절은 아무것도
바꾸지 않는다. `split`, `splitToward`, `insert`, `withdraw`, `group`, `unwrap` 은
거절을 그 text와 함께 throw하고, 다른 모든 메서드는 `null`, `false` 또는 빈 답을
반환한다.

`toJSON()` 은 `{root}` 를 돌려주며, close는 tree만 읽으므로 그것으로 다시 만든 grid 는
카드를 같은 방식으로 닫는다. `checkState` 는 생성자가
실행하는 것이다. 오래된 저장 배치를 설치하기 전에 거절하려면 직접 호출하라.

`fullscreen(id)`는 격자 모델을 바꾸지 않고 기존 카드 하나를 판 전체에 표시한다. `fullscreen(null)`은 배치를 복원한다. `fullscreenCard` 접근자는 현재 표시 선택을 보고한다. 다른 카드 요소는 살아 있지만 숨기며 표시 사각형의 넓이는 0이다. 전체 화면에는 선과 경계선 손잡이가 없다. 커밋 사각형과 그림은 크기 변경·비동기 복원 중에도 같은 스냅샷을 사용한다. 잘못된 ID는 상태를 바꾸지 않고 실패한다. 호스트는 전체 화면 카드를 제거하거나 배치를 변경하기 전에 일반 표시를 복원한다.

`SoksakView(host, grid, options)` — `render(reason?)`, `element(id)`,
`painted(id)`, `fullscreen(id)`, `fullscreenCard`, `destroy()`. 옵션: `createCard`(필수), `updateCard`, `destroyCard`,
`onChange(reason)`, `updateDivider`, `rules`(기본 켜짐), `commit(rects, draw, dividers)`,
`classPrefix`(기본 `sp`), `observeResize`(기본 켜짐), `bleed`(기본 0),
`boundary`(기본 grid 의 operation), `drawn`(기본 grid 의 배치),
`order(cards)`(기본 grid 의 reading order).

`order(cards)`는 grid 의 모든 card id 를 한 번씩, host element 가 card element 를 담는
순서로 돌려준다. 다른 목록은 빠진, 알 수 없는, 반복된 card 와 함께
`order gave <n> cards for the <m> cards of the grid`를 던진다. 없으면 순서는 grid 의
reading order 다: 첫 row line 순, 다음으로 첫 column line 순. 키보드와 문서를 읽는 쪽은
문서 순서로 card 를 만나므로, 뷰는 split 과 close 의 이력을 따르는 생성 순서 대신 배치의
순서로 문서를 유지한다. 여러 card 를 담는 상자처럼 자기 구조로 card 를 배치하는 호스트는
그 구조의 순서를 주고 자기 element 를 card 곁에 둔다. 순서가 바뀌면 자리가 순서와 더는
맞지 않는 card element 를 순서가 허락하는 만큼 적게 옮기며, focus 를 가진 element 는
옮기지 않으므로 그 focus 는 남는다. 옮긴 element 는 자식과 그 상태를 유지하지만 그 안의
frame(`iframe`)은 browser 가 다시 load 하므로, card 에 그런 frame 을 담는 호스트는 그것을
card element 밖에 둔다.

`commit(rects, draw, dividers)`는 모든 레이아웃 변경 전에 실행되고 장치 픽셀 격자에 맞춘
사각형과, 그리기가 그 격자에서 grab area에 주는 사각형을 가진 레이아웃의 divider를 받는다.
전체화면에서는 divider가 없다. 자기 뷰가 카드를 덮는 호스트는 그 위에서 grab area에
pointer를 준다. 호스트는 자기 뷰를 준비한 뒤 `draw()`를 호출한다. 각 콜백은 자기가 받은
레이아웃을 한 번 그린다. 이후의 격자 변경은 그려지기 전의 그 레이아웃을 바꾸지 못하고,
그리기 전에 바뀐 device pixel ratio도 그것이 쓰는 사각형을 바꾸지 않는다. 비율이 바뀌면
뷰는 새 픽셀 격자로 다시 그린다.
이전 콜백을 건너뛰는 호스트는 그 레이아웃을 건너뛴다. DOM과 네이티브 화면 표시는
호스트에서 별도로 동기화해야 한다.

`painted(id)`는 마지막 그리기가 카드 요소에 쓴 사각형을 반환하고, 카드가 그려지기
전에는 `undefined`를 반환한다. `commit` 훅이 있으면 그리기가 실행될 때까지 격자는 요소보다
새 레이아웃을 가지므로, 카드 옆에 그리는 호스트는 `rect(id)` 대신 이 사각형을 읽는다.

DOM 바인딩은 화면 해상도 변경을 관찰하고 호스트 CSS 크기가 같아도 새 장치 픽셀
격자로 다시 그린다. `destroy()`는 이 관찰을 제거한다.

뷰는 호스트의 크기를 animation frame 에서 관찰하기 시작한다. animation frame 은 그 frame 의
observation round 보다 먼저 실행된다. `observation` 이 그 상태를 `refused`, `pending`,
`observing`, `unavailable`, `stopped` 중 하나로 알린다. `hostResized(width, height)` 는
호스트 크기 관찰 한 번에 대한 반응이다. 격자의 크기를 바꾸고 격자가 그 크기를 받았는지
돌려준다. 소멸된 뷰와 너비나 높이가 0 인 호스트는 격자를 그대로 두고 `false` 를 돌려준다.

`bleed` 는 rule 이 자기를 둘러싼 프레임에 도달하기 위해 판 밖으로 얼마나 나갈 수 있는지다.
판을 프레임 안에 두는 호스트는 — 판 바깥 요소의 패딩으로 — 자기 테두리를 rule 이
끝나는 곳에서 그만큼 떨어뜨려 그리므로, rule 은 그 테두리에 못 미쳐 멈춘다. 그 거리를
아는 것은 호스트뿐이다. 뷰는 요소를 받고, 요소 자신의 패딩은 그 안에 절대 위치로 놓인
것을 옮기지 않는다. 판에 맞붙는 끝만 나간다. 카드에 막혀 멈추는 rule 은 멈춘 자리에
그대로 둔다. 그 카드가 rule 이 맞붙는 끝이기 때문이다.

이 값은 뷰에 대입할 수 있다(`view.bleed = px`). 사용자가 갭을 바꿀 수 있게 하는 호스트는
그것과 함께 이 값을 바꾸기 때문이다.

`boundary` 는 `BoundaryModel` 로, 모든 divider gesture 가 실행하는 boundary operation 이다.
drag 의 한 걸음은 `move(axis, line, px)`, 화살표 키는 `step(axis, line, px)`, 짝의 두 번째 press 와 Enter 는
`center(axis, line)`, drag 의 끝은 `end(axis, line)` 이며 end 는 line 이 합쳐졌는지를
돌려준다. 이것이 없으면 뷰는 grid 의 `moveBoundary`, `centerBoundary` 를 실행하고 `end` 는
false 를 돌려준다. 다른 선에 맞붙은 끌기는 이미 그 선과 합쳐졌기 때문이다([경계](#경계)). 카드를 grid 와 다른 rectangle 에 그리고 line 에 자기 규칙을 두는 호스트는 자기 것을
넘긴다. drag 의 결과를 자기 operation 으로 저장하는 호스트는 drag 가 boundary 를 둔 곳에서
그 operation 을 `end` 에서 실행한다.
`drawn` 은 `DrawnModel` 로, 뷰가 그리는 배치다. `rects(fullscreen)` 은 각 카드의 사각형을
주고, fullscreen id 가 있으면 그것과 함께 보이는 카드만 주며 다른 카드는 숨겨진다.
`rules()` 는 rule 을 `DrawnRule` 로 주며 `bleed` 가 false 인 rule 은 판을 둘러싼 프레임에
맞붙지 않는다. `dividers()` 는 divider 를 주고, `has(id)` 는 `fullscreen(id)` 가 grid 의 카드나
호스트의 상자인 `id` 를 보일 수 있는지 말한다. 이것이 없으면 뷰는 grid 의 `rects()`,
bleed 를 가진 `rules()`, `dividers()` 를 그리고 fullscreen 카드를 판 전체에 보인다. 카드를 자기
header 아래에 그리거나, rule 을 자기 상자에서 자르거나, 여러 카드의 상자를 fullscreen 으로
보이는 호스트는 자기 것을 넘긴다.
`reason` 은 `drag`, `center`, `merge`, `resize`, `render` 중 하나다.

`outline(rects, options)`, `unionLoops(rects)`, `roundedPath(loop, radius)`,
`contains(loops, x, y)`.

## 라이선스

MIT

## Random sequence 검증

Unit test와 fuzz command는 하나의 seed 기반 operation generator와 transition
invariant checker를 공유한다. Ordinary layout은 minimum-size를 검사하고,
fixed layout은 fixed-size 비율과 close 예측도 검사한다. Constrained layout은
크기가 0인 card와 축소된 corridor를 허용한다. 거부된 호출을 포함하여 각 public
호출을 다음 호출 전에 검사한다. Report는 successful/refused 호출 수와
changed/unchanged state 수를 전체 및 operation별로 기록한다. Profile별 weight는
기존 생성·제거 빈도를 유지하고, ordinary drag 후 merge 호출도 별도로 검사한다.
Coincident-line 고정 fixture는 merge 성공을 증명한다. 거부된 호출은 state를 변경하면
안 된다. 실패 report는 seed, initial state와 전체 operation trace를 보존한다.
독립적인 slicing oracle과 명시적인 geometry 기대값은 별도 test로 유지한다.

실패는 기록된 initial state와 snapping distance를 포함한 모든 layout option으로
재실행할 수 있다. Reduction은 먼저 같은 실패를 재현한 뒤 일정한 순서로
operation 묶음을 제거한다. 같은 이름의 invariant 실패만 후보로 수용하고,
성공한 sequence, 다른 invariant와 이름 없는 assertion은 수용하지 않는다.
원래 seed와 전체 trace는 reduced trace와 별도로 변경 없이 보존한다. 결과는
operation 하나를 제거하는 범위에서 최소이며, 가능한 가장 짧은 trace를
보장하지 않고 argument 값은 줄이지 않는다. Fuzz command는 reduction을
시도하기 전에 전체 원본을 출력한다.

Role-independence test는 별도의 고정 operation trace를 사용한다. Fixture의
card array 전체 순열과 변경된 identifier를 public constructor에 전달한다. 비교 단계에서만 identifier와 card 순서를
정규화한다. 각 operation마다 geometry, card 속성, close/split 예측과 결과를
비교하며, identifier 또는 array 위치에 의존하는 결함을 주입하면 비교가
실패해야 한다. Source ownership 검사는 구조 검사로 유지하며, 독립적인
slicing oracle은 sequence generator 및 role 비교와 별도로 유지한다.


## 다양한 role-independence case

한정된 입력 선택은 고정한 5-card test와 입력 순열 120개를 보완한다. Seed
0부터 20까지 public split operation으로 유효한 topology를 만든 뒤 선언한
option을 적용한다. 각 case는 실제 card 수, topology, dimension과 option을
검사하므로 generation이 하나의 입력군으로 축소되면 실패한다. 입력군은 다음과 같다.

| 입력 | 선택 |
| --- | --- |
| Topology | columns, rows와 mixed cut |
| Initial card | 2부터 8까지; mixed cut은 3개 이상 |
| Width / height | 320, 640, 1730 / 180, 900, 1440 px |
| Gap / minimum size | 0, 17, 64 / 24, 96, 160 px |
| Snap | merge와 off |
| Snap distance / grab size | 3과 29 / 7과 23 px |
| Card 속성 | fixed 및 sharing card, 선언한 px size와 constrained 상태의 크기 0인 card |
| Trace | refusal/recovery 호출 14개와 이어지는 seed 기반 호출 20개 |

각 initial array는 순환 이동하고, 뒤집고, case seed로 두 번 섞는다. 중복
순서를 제거하고 card 수에 3을 더한 개수 이하의 순서를 원래 identifier 및
변경한 identifier로 비교한다. 이 선택은 모든 조합이나 가능한 모든 layout을
검증한다고 주장하지 않는다. 고정 5-card test는 별도로 순열 120개를 모두 다룬다.

Fixed card의 split은 거부되어야 하며 fixed flag를 해제하고 공간을 주면
성공해야 한다. 1-pixel plane의 split은 거부되어야 하며 공간을 복원하면
성공해야 한다. 새 card를 닫아 각 회복 뒤에도 작업을 계속할 수 있음을 확인한다.
모든 전이는 successful 또는 refused 결과를 보고하고 거부는 serialized state와
public 관측값을 보존한다. Report는 입력군과 method별 결과 수를 assert하고
출력한다. 별도 control은 gap, minimum size, snapping과 grab size가
해당 geometry나 판단을 바꾼다는 것을 검증한다.

Slicing oracle은 layout 구현을 import하지 않는 순수 test module이며 기존
negative pinwheel case와 다양한 전이 검사가 사용한다. Mutation 검사는 정상
구현으로 입력을 만들고 검증한 뒤 동일한 입력을 격리한 구현 복사본에서 재생한다.
Identifier·array-order·size 의존 결함은 기존 R2 test를 통과하지만 새 narrow-plane
case의 지정한 assertion에서는 실패해야 한다. Loader, runtime, environment 오류는
검출로 세지 않는다. 실패는 seed, initial state, option, 전체 호출 목록과 선택한
입력 순서를 보존한다.
