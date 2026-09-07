# 네이티브 모달

[English](native-modals.md)

이 명세는 `data-native-modal`을 정의한다. 구현·검증·배포 상태는 [기능 상태](../features.ko.md)에 기록한다.

애플리케이션이 기존 설정과 선택 메뉴 DOM을 관리한다. `overlay.show()`는 표시된 요소를 메인 OS 창 내부의 다른 네이티브 웹뷰에 렌더링한다. 요소에는 `dialog` 또는 `menu`, 고유한 `id`, `aria-label`이 필요하다.

| 모드 | 웹뷰 영역 | 배경 | 닫기 |
| --- | --- | --- | --- |
| `dialog` | 메인 콘텐츠 뷰포트 | 불투명도 50%의 검정색; 각 배경 웹 문서에 3px CSS 블러 | 설정은 × 버튼으로 닫기 |
| `menu` | 선택 메뉴 사각형 | 배경색 및 블러 없음 | 선택, 외부 클릭, Escape |

메인 문서가 카드 사각형을 측정한다. 카드 이동은 전체 뷰포트 대화상자 웹뷰를 이동하지 않고 DOM 위치를 갱신한다. 대화상자 웹뷰는 메인 창과 함께 크기를 변경하고, 배경 입력을 차단하며, 새로 생성된 표면 위에 표시된다.

대화상자 문서가 CSS로 반투명 배경을 그린다. 각 배경 웹뷰는 자기 콘텐츠에 같은 CSS 블러를 적용한다. 대화상자의 CSS 필터는 다른 네이티브 웹뷰를 흐리게 만들 수 없다. 대화상자 내용은 선명하게 유지한다. 호스트는 웹뷰 API로 불리언 `window.__soksakBackground`를 설정한다. 배경 스크립트는 초기화 전에 설정된 상태를 적용하고 이후 설정도 같은 속성으로 처리한다.

열기, 닫기, 표면 생성, 표면 탐색에 현재 배경 상태를 적용해야 한다. 닫을 때 페이지의 기존 스타일을 변경하지 않고 적용한 스타일시트를 제거한다. 메인 문서를 다시 로드하면 해당 모달과 배경 효과를 제거한다. 모달 웹뷰와 해당 초기 문서는 투명하고 카드는 자체 배경을 그린다. 별도의 OS 창이나 플랫폼 시각 효과 뷰는 필요하지 않다.

인수 기준은 캡처 픽셀에서 확인되는 블러와 반투명 색상, 선명한 대화상자 내용, 배경 클릭과 스크롤 차단, 설정의 × 버튼 전용 닫기, 닫은 후 표시와 입력 복원이다. 카드 이동, 내용 갱신, 표면 교체와 탐색, 부모 창 크기 변경, 메인 문서 다시 로드에서도 이를 유지해야 한다. 추가 및 분할 메뉴는 두 배경 효과를 적용하지 않는다.

시각 효과 정의는 공통 웹 코드다. 각 플랫폼에는 작동하는 네이티브 웹뷰 호스트와 동작 검증이 필요하다. 현재 Wails의 추가 웹뷰 생성은 macOS에만 구현되어 있다. Windows와 Linux 실행은 미검증이다.

## 사용

빈 값이나 다른 값은 `show()`가 거절한다. 요소에는 비어 있지 않은 고유 `id`와
`aria-label`도 필요하다. 모드는 열기 전에 정하고, 바꾸려면 닫은 뒤 다시 연다.
한 번에 하나만 열린다. 다른 것을 열면 이전 네이티브 뷰가 닫히며, 이전 원본 DOM의
정리는 소유 컴포넌트가 맡는다.

아래 마크업은 예제의 `app.css` 클래스를 사용한다. scrim은 메인 문서에 남아 그
문서의 DOM 입력을 막고, 카드만 네이티브 웹뷰에 복사된다.

```html
<div class="set-scrim" id="preferences-scrim">
  <div id="preferences" class="set-card" data-native-modal="dialog"
       role="dialog" aria-modal="true" aria-label="설정">
    <header class="set-card__head">
      <span class="set-card__title">설정</span>
      <button class="act" type="button" data-key="close" aria-label="닫기">×</button>
    </header>
  </div>
</div>
```

네이티브 호스트 안에서 이 요소를 메인 문서에 붙인 뒤 다음과 같이 연다.

```js
import { overlay } from "./host.js";

const el = document.getElementById("preferences");
const scrim = document.getElementById("preferences-scrim");
const plane = document.getElementById("plane").getBoundingClientRect();
const r = el.getBoundingClientRect();
overlay.show(el, {
  x: r.left - plane.left, y: r.top - plane.top, w: r.width, h: r.height,
}, (key, value) => {
  if (key === "close") {
    overlay.hide(el);
    scrim.remove();
  }
  // 카드의 다른 응답은 여기서 처리한다.
});
el.style.visibility = "hidden";
```

`show()`와 `place()`의 프레임은 `#plane` 기준 CSS 픽셀이다. `show()`는 루트의
클래스, 내부 마크업, 페이지 스타일시트를 복사하며 원본 DOM을 감추거나 제거하지
않는다. 원본이 배치를 담당한다면 `visibility: hidden`으로 측정 가능하게 유지한다.
위치나 크기가 바뀌면 `overlay.place(el, rect)`, 내용이 바뀌면 `overlay.update(el)`을
호출한다. JavaScript 리스너와 폼 프로퍼티는 직렬화되지 않는다. 복사할 초기 상태는
`checked`, `selected`, `value` 등의 속성에 적는다.

[`browser/card.js`](../../examples/browser/card.js)가 `data-key` 클릭과 `data-set` 변경을
`(key, value)`로 전달한다. `menu`의 Escape는 빈 key를 보낸다. 응답의 의미를 처리하고
닫을 때 원본 DOM을 제거하는 것은 소유 컴포넌트의 일이다. 바깥 클릭 처리도 그
컴포넌트가 맡는다. 실제 소유자는 [`settings-ui.js`](../../examples/browser/settings-ui.js)와
[`plane.js`](../../examples/browser/plane.js)다.
