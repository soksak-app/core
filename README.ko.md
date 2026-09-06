# soksak

[`README.md`](README.md) 의 한국어 번역이며 독자적인 규칙을 정의하지 않는다.

공유 격자선 위의 분할 배치. 헤드리스 코어, 선택적인 DOM 바인딩, 런타임 의존성 없음.

## 규칙

**R1 — 경계는 숫자 하나다.**
`xs` 와 `ys` 가 모든 좌표를 갖는다. 카드는 그 배열에 대한 인덱스 구간이므로, 맞닿은
두 카드는 같은 인덱스를 읽고 공유하는 경계는 숫자 하나다. 카드가 어디에 있는지,
두 카드가 맞닿았는지를 허용 오차가 정하지 않는다. 그것은 정수 인덱스이고, 맞닿은
두 카드는 같은 값을 읽는다.

허용 오차는 다른 것을 정한다. 끌기가 이웃한 선에 얼마나 가까워야 그 선에
내려앉는지, 연산이 카드에 충분한 자리를 남겼는지, 모서리가 각지게 그릴 만큼
좁은지다. 그 전부는 px 에 대한 판단이지 어느 카드가 어디에 있는지에 대한 판단이
아니다.

**R2 — 모든 것이 카드다.**
사이드바, 레일, 페인이 하나의 타입, 하나의 사각형 규칙, 하나의 통로, 하나의 반경,
하나의 외곽선을 쓴다.

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

슬롯의 합은 언제나 판이고, px 크기가 양보하는 대상이 그 규칙이다. 축의 어떤 슬롯이
지분을 갖고 판에 자리가 있는 동안 px 크기는 지켜진다. 판에 자리가 없으면 모든 px
크기가 하나의 배율로 줄어들어 서로의 비율이 유지되고 지분을 가진 슬롯은 하한을
지킨다. 축의 어떤 슬롯도 지분을 갖지 않으면 판을 덮을 수 있는 것은 px 크기뿐이므로
양방향으로 판에 맞춰 조정되고 선언한 숫자가 비율이 된다. 1600 짜리 판에서 200 을
요구한 카드 하나는 1600 으로, 200 과 300 을 요구한 둘은 630 과 946 으로 그려진다.
카드가 실제로 그려진 값은 `rect(id)` 로 읽는다.

담고 있는 것에 비해 너무 작은 판은 모든 카드에 최소 크기를 줄 수 없다. 그때 양보하는
것은 카드의 너비이지 그 옆의 갭이 아니다. 지분을 가진 슬롯은 자신이 가진 통로에서
멈추고, 나머지가 남은 자리를 나누며, 자리가 없어진 카드는 가까운 가장자리에 너비 없이
그려진다. 이웃한 두 카드 사이의 통로는 여전히 정확히 `gap` 이고 판은 여전히 정확히
덮인다.

새로 들어온 카드는 끌기와 같은 방식으로 옆 슬롯에서 너비를 가져온다.

px 크기는 슬롯 하나를 기술하므로, 자르기는 그것을 두 쪽으로 나눈다. 두 슬롯에 걸친
카드는 px 크기를 갖지 않는다.

**R6 — 사각형은 한 곳에서 계산한다.**
`geometry.ts` 가 카드 사각형, 경계 규칙, 잡는 영역을 계산한다. `soksak.ts` 가
상태를 갖는다.

**R7 — 배치가 대체할 카드를 옮길 수 없는 경우가 아니면 카드는 나갈 수 있다.**
마지막 하나를 제외한 모든 열린 카드는 닫을 수 있고, 그 결과는 다시 쪼개기로 만들 수
있었던 배치다. 나가는 길은 둘이다. 이웃 한 줄이 그 자리를 덮으며 커지거나, 그 카드의
슬롯이 제거된다.

`fixed` 카드는 떠나는 이웃 위로 커지지 않는다. 그래서 채울 이웃이 `fixed` 뿐이고 자기
슬롯에 다른 카드가 있는 카드는 남는다. `canClose` 가 무엇이 움직이기 전에 이것을
보고한다.

## 설치

```sh
pnpm add github:min-median-max/soksak
```

git 에서 설치한다. npm 이름 `soksak` 은 무관한 패키지가 쓰고 있다. `dist/` 가
커밋되어 있으므로 빌드 단계가 없다.

ESM 전용이다. CommonJS 빌드는 없다.

## 모델

```
xs   세로 격자선, 지분을 가진 슬롯 위에서 0..1 로 정규화된다
ys   가로 격자선
```

카드는 `{ id, c0, c1, r0, r1 }`, 즉 자신이 점유한 슬롯이다. 선을 옮기면 그 선을
참조하는 모든 카드가 움직인다. 그 선을 가로질러 걸친 카드는 영향을 받지 않고, 그
카드에게 그 선은 참조되지 않은 선이다. 이후의 쪼개기가 그 선에 붙으므로 서로 다른
행의 쪼개기가 한 줄로 맞는다.

트리도 그룹도 없다.

## 사이드바도 카드다

```js
const grid = new Soksak({
  xs: [0, 1 / 3, 1],
  ys: [0, 0.5, 1],
  cards: [
    { id: "left", c0: 0, c1: 1, r0: 0, r1: 2, width: 180, fixed: true },
    { id: "terminal", c0: 1, c1: 2, r0: 0, r1: 1 },
    { id: "browser", c0: 1, c1: 2, r0: 1, r1: 2 },
  ],
}, { width: 1200, height: 800 });
```

`width` 는 카드를 180px 폭으로 만들고 나머지가 남은 자리를 나눈다. `fixed` 는 배치가
그것을 쪼개거나 닫거나 옮기지 못하게 한다. 같은 카드가 가운데 열에 있으면 레일이다.
한 슬롯에만 걸친 카드만 그 축에 px 크기를 지정할 수 있다.

나머지 API 는 모든 카드에 동일하게 적용된다.

```js
grid.rects();               // Map<id, {x, y, w, h}>
grid.split("terminal", "x");
grid.close(id);
grid.move("rail", "browser", "right");
```

## 빠른 시작 — DOM

`SoksakView` 가 위치를 지정하고, 요소의 수명을 관리하고, 포인터 입력을 처리한다.
카드 요소는 `createCard` 가 만든다. 뷰가 만드는 요소는 클래스 이름과 data 속성만
갖는다.

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
| `createCard` 가 만든 카드 | 호출자의 것 | `data-card-id` | `position`, `left`, `top`, `width`, `height` |
| 잡는 영역 | `sp-divider` | `data-axis`, `data-line`, 잡고 있는 동안 `data-dragging`, `tabindex="0"`, `role="separator"` | 위와 같고 `touch-action: none` 이 더해진다 |
| 경계선 | `sp-rule` | `data-axis`, `data-virtual` | 위와 같고 `pointer-events: none` 이 더해진다 |

rule 의 `data-virtual` 은 카드가 그 선에서 나뉘는 구간만이 아니라 판 전체를 지나는
rule 을 표시한다. `isVirtual` 은 다른 것을 보고한다. 어떤 카드든 그 선을 읽는지
여부다.

```css
#stage { position: relative; }
.card { box-sizing: border-box; }
.card > * { min-width: 0; }                /* 아래의 위험을 보라 */
```

## 선과 디바이더

뷰는 그것을 배치하고 생김새는 정하지 않는다. `installTheme` 이 그것을 정하는
스타일시트를 문서에 넣는다. 축마다의 커서, 손가락 너비의 잡는 영역과 그 안의 가는
그립, 그리고 선이 교차하는 부분을 나머지보다 흐리게 그리는 규칙이다.

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
값들은 그것을 따라 바뀐다. 여기서는 호스트의 토큰 이름을 읽지도, 지금 어느 모드인지
묻지도 않는다.

`themeCSS()` 는 같은 스타일시트를 문자열로 반환한다. 문서가 아니라 자기 파일에 넣는
호스트를 위한 것이다.

디바이더를 끌면 경계가 움직인다. 더블클릭하면 (또는 포커스된 상태에서 Enter/Space 를
누르면) 경계를 가운데로 옮겨 양옆 두 카드를 같은 크기로 만든다. 고정 너비를 가진 카드
옆에서도 그렇다. 너비는 숫자이고 숫자에는 절반이 있다. 사이드바가 더블클릭으로
가운데 정렬되기를 원하지 않는 호스트는 그 디바이더에 이 제스처를 주지 않으면 된다.

**카드의 자식이 뷰가 지정한 사각형을 부풀릴 수 있다.** flex 나 grid 의 자식은
`min-width: auto` 가 기본이라 열이 min-content 까지 늘어나고, 요소는 지정받은 크기보다
넓은 사각형을 보고한다. `overflow: hidden` 은 그것을 가리지만 사각형을 줄이지는
않으며, 카드가 클리핑하지 않는 채로 그 사각형을 기준으로 배치된 것은 — 예를 들어
페이지 위에 합성되는 OS 뷰는 — 카드 밖에 놓인다. 자식에게 `min-width: 0` 을 주라.

## 경계

끌기는 그 경계에서 만나는 두 슬롯만 바꾸고 다른 것은 바꾸지 않는다. 고정 크기로 자기
슬롯을 잡고 있는 카드 옆에서는 그 크기를 바꾸고 반대쪽 슬롯이 그것을 부담한다. 그
밖에서는 선을 옮기고 양쪽이 따라온다.

같은 규칙이 나타나거나 사라지는 카드를 정리한다. 닫히는 카드의 너비와 그것이 내놓는
통로는 옆 슬롯으로 가고, 경계에 삽입된 카드는 옆 슬롯에서 너비를 가져온다. 그래서
사이드바를 껐다 켜면 다른 모든 카드는 갖고 있던 너비를 유지한다.

px 크기는 호스트가 선언한다. 그것을 바꾸는 것은 끌기뿐이다. 닫기와 삽입은 지분을 가진
슬롯으로 정리하고, 가장 가까운 슬롯이 카드를 `minSize` 아래로 만들지 않고는 자리를 낼
수 없으면 더 바깥을 본다.

```js
grid.dividers();                       // 각 경계를 어디서 잡을 수 있는지
grid.boundaryPos("x", 1);              // px
grid.boundaryRange("x", 1);            // [min, max] px, 무언가 minSize 에 닿기 전까지
grid.moveBoundary("x", 1, 260);        // px
grid.centerBoundary("x", 1);
```

## 판을 가로지르는 카드

레일은 페인 사이에 서서 판의 한쪽 끝에서 반대쪽 끝까지 닿는다. 카드를 쪼개서 만들 수
없다. 그러면 그것은 자기가 나온 카드의 범위를 갖게 되어 다른 페인과 다를 바 없다.
어떤 카드도 가로질러 걸치지 않은 경계에 들어가고, 그 뒤의 모든 카드가 함께 밀린다.

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

판의 경계에 내려앉는 것만이 예외다. 경계는 통로를 부과하지 않으므로 그 자리의 레일은
반 갭만큼 덜 쓰고, 경계에 딱 붙어 있던 카드는 이제 옆에 레일을 두고 반 갭을 부담한다.
모든 카드가 판에서의 지분을 유지하며, 움직이는 것은 그 옆에 그려지는 통로다.

## 카드 옮기기

카드를 다른 곳으로 끄는 것은 하나의 연산이지, 호출자가 순서대로 실행하는 닫기와
쪼개기가 아니다. 순서가 중요하다. 먼저 닫으면 자리가 돌아오면서 목표의 형태가 바뀌므로
자르기는 그 뒤에 측정되고, 닫기가 불가능하면 이동 전체가 일어나지 않는다. 절반만
일어나지 않는다.

```js
grid.canMove("terminal", "browser", "right");   // 묻는 것은 하는 것이 아니다
grid.move("terminal", "browser", "right");      // 거절되면 false 이고 아무것도 바뀌지 않는다
```

카드는 자기 id 와 페이로드를 유지한다. px 크기는 그 축에서 한 슬롯에 걸치도록
내려앉을 때만 유지한다. 두 슬롯에 걸친 카드는 px 크기를 갖지 않으므로(R5), 카드를
넓히는 쪽으로 옮기면 크기가 사라진다.

`splitToward(id, side, init)` 는 지정한 쪽에 새 카드를 놓는다. `split` 은 먼 절반을
새 카드에 주므로 `left` 와 `top` 은 두 구간을 맞바꾼다. id 는 맞바꾸지 않는다.

## 드롭이 내려앉는 곳

```js
grid.zoneAt(x, y, { headerPx: 34, footerPx: 24, centreOnly: draggingId });
// → { id, zone: "centre" | "left" | "right" | "top" | "bottom" } | null
```

`centre` 는 카드 자체를 뜻한다. 방향은 그 옆의 새 자리를 뜻한다. `headerPx` 와
`footerPx` 는 제외되므로 크롬 위의 점은 방향이 아니라 카드를 반환한다. 가장자리 띠는 px 가 아니라
몸통의 비율이다.

## 외곽선

통로로 떨어진 카드들은 서로 닿지 않으므로 그냥 합치면 각자 하나씩의 고리로 흩어진다.
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

쪼개기는 언제나 카드 하나를 둘로 교체할 뿐이므로(R4) 배치는 항상 **슬라이싱**
플로어플랜이다. 풍차 — 네 카드가 각각 가운데 카드에 걸쳐 있어 어느 쪽도 그 자리를
대신할 수 없는 배치 — 가 슬라이싱이 아닌 대표적인 배치이고, 쪼개기로는 거기에 도달할
수 없다.

닫기는 그 성질을 보존한다. 닫기는 맞아떨어지는 이웃 하나만이 아니라 이웃 한 줄이 함께
커지게 하고, 배치를 슬라이싱으로 남기는 쪽만 받아들인다. 그런 배치에는 그런 쪽이 항상
존재한다.

고정 카드는 빈자리를 채우지 않는다. 그 크기는 그 카드의 것이다. 그래서 고정 카드 둘
사이에 선 카드에는 커질 수 있는 이웃이 없다. 그 카드는 다른 길로 나간다. 판의 한쪽
끝에서 반대쪽 끝까지 닿으므로 그것이 걸친 모든 슬롯이 자기 것이고, 그 슬롯이 그대로
사라진다. 슬롯이 몇 개인지는 상관없다.

이로써 마지막 하나를 제외한 모든 열린 카드에 대해 `canClose` 가 참이다. 앞서 무슨 일이
있었든 그렇다. 위의 R7 경우 — 채울 이웃이 `fixed` 뿐이고 그 슬롯에 다른 카드가 있는
경우 — 만 예외다. `fixed` 카드에 대해서는 `canClose` 가 거짓을 반환한다. 배치가 그것을
옮기지 않기 때문이며, `setFixed` 로 먼저 플래그를 지우면 된다.
`grid.isSlicing()` 은 그 성질 자체를 직접 검사한다.

## 옵션

| 옵션 | 기본값 | 의미 |
| --- | --- | --- |
| `gap` | `24` | 카드 사이의 통로, px. 그 절반이 모든 안쪽 가장자리를 들여쓰고 외곽선의 `pad` 가 된다. |
| `minSize` | `96` | 카드 변의 최소 길이, px. |
| `grabSize` | `11` | 잡는 영역의 최소 크기, px. `gap` 과 별개이므로 `gap: 0` 에서도 끌 수 있다. |
| `snap` | `"merge"` | 끌린 경계가 거의 만난 이웃에 내려앉는다. `mergeCoincident` 가 둘을 한 선으로 접으며, 포인터를 놓을 때 `SoksakView` 가 그것을 호출한다. `"off"` 면 둘 다 하지 않는다. |
| `snapDistance` | `7` | 얼마나 가까워야 하는지, px. |
| `fillOrder` | `"v"` | 닫기가 먼저 시도하는 축. `"v"` 는 위아래에서, `"h"` 는 좌우에서. |
| `width`, `height` | `0` | 판의 크기. `resize(w, h)` 가 갱신하며 뷰가 대신 해 준다. |

## API

`Soksak`

| | |
| --- | --- |
| `cards`, `card(id)`, `rect(id)`, `rects()`, `rectOf(card)` | 배치를 읽는다 |
| `resize(w, h)`, `width`, `height` | 판의 크기 |
| `canSplit(id, axis)`, `split(id, axis, {id?, data?})` | 카드 하나를 둘로 자른다 |
| `splitToward(id, side, {id?, data?})` | 자르고 새 카드를 지정한 쪽에 놓는다 |
| `canClose(id)`, `close(id)`, `fill(id)` | 카드를 제거한다. `fill` 은 어느 이웃이 그 자리를 갖는지 보고한다 |
| `canMove(id, targetId, side)`, `move(id, targetId, side)` | 카드를 다른 카드의 옆으로 옮긴다 |
| `setFixed(id, on)`, `setSize(id, axis, px)`, `setData(id, data)` | 카드를 변경한다. 반환된 사본은 동결되어 있다 |
| `standings(axis, without?)`, `canInsertAt(axis, line, without?)`, `insertAt`, `moveTo` | 판을 가로지르는 카드 |
| `zoneAt(x, y, options)` | 드롭이 내려앉는 곳 |
| `dividers()`, `rules()` | 잡는 영역과 그릴 경계 |
| `boundaryPos`, `boundaryRange`, `hasBoundary(axis, line)`, `moveBoundary(axis, line, px, allowSnap?)`, `centerBoundary` | 경계를 끈다 |
| `mergeCoincident(axis, line)` | 이제 같은 자리에 있는 이웃 선으로 접는다 |
| `tidy()`, `virtualCount()`, `isVirtual(axis, line)`, `crossings(card)`, `cardsCrossing(axis, line)` | 가상 선 |
| `isSlicing()`, `lines(axis)`, `toJSON()`, `Soksak.from(state, options?)`, `checkState(state)`, `replace(state)` | 검사와 상태 |
| `gap`, `minSize`, `grabSize`, `snapDistance`, `snap`, `fillOrder` | 옵션. 생성 후에도 읽고 쓸 수 있다 |

축을 받는 모든 메서드는 `"x"` 나 `"y"` 가 아닌 값을 거절한다. 방향을 받는 모든
메서드는 `left`, `right`, `top`, `bottom` 이 아닌 값을 거절한다. 거절은 `null`,
`false` 또는 빈 답을 반환하고 아무것도 바꾸지 않는다.

`toJSON()` 은 `paidBy` 를 함께 담는다. 각 슬롯을 어느 카드에서 가져왔는지 기록하므로,
그것으로 다시 만든 grid 는 카드를 같은 방식으로 닫는다. `checkState` 는 생성자가
실행하는 것이다. 오래된 저장 배치를 설치하기 전에 거절하려면 직접 호출하라.

`SoksakView(host, grid, options)` — `render(reason?)`, `element(id)`,
`destroy()`. 옵션: `createCard`(필수), `updateCard`, `destroyCard`,
`onChange(reason)`, `updateDivider`, `rules`(기본 켜짐), `commit(rects, draw)`,
`classPrefix`(기본 `sp`), `observeResize`(기본 켜짐), `bleed`(기본 0).

`bleed` 는 rule 이 자기를 둘러싼 프레임에 닿기 위해 판 밖으로 얼마나 나갈 수 있는지다.
판을 프레임 안에 두는 호스트는 — 판 바깥 요소의 패딩으로 — 자기 테두리를 rule 이
끝나는 곳에서 그만큼 떨어뜨려 그리므로, rule 은 그 테두리에 못 미쳐 멈춘다. 그 거리를
아는 것은 호스트뿐이다. 뷰는 요소를 받고, 요소 자신의 패딩은 그 안에 절대 위치로 놓인
것을 옮기지 않는다. 판에 닿는 끝만 나간다. 카드에 막혀 멈추는 rule 은 멈춘 자리에
그대로 둔다. 거기서는 카드가 벽이기 때문이다.

이 값은 뷰에서 쓸 수 있다(`view.bleed = px`). 사용자가 갭을 바꿀 수 있게 하는 호스트는
그것과 함께 이 값을 바꾸기 때문이다.
`reason` 은 `drag`, `center`, `merge`, `resize`, `render` 중 하나다.

`outline(rects, options)`, `unionLoops(rects)`, `roundedPath(loop, radius)`,
`contains(loops, x, y)`.

## 라이선스

MIT
