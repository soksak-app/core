// 선택 레이어의 내용. 물음 한 줄과 묶음마다 제목(있으면)과 항목을 그린다. 제목은 누름을 받지 않으며 고르는 index 는
// 항목만 센다(docs/spec/example-model.md#card-fullscreen). 위치와 열기·닫기는 plane.js 가 한다.

/**
 * el 을 비우고 물음 ask 와 묶음 groups 를 그린 뒤, 고르는 순서의 항목 key 를 반환한다.
 *
 *   groups  [{ heading: null | { id, name, depth, map }, items: [{ key, name, mark, svg, viewBox?, active?, notice? }] }]
 *           map 은 묶음 제목 그림의 SVG 내용, depth 는 제목의 들여쓰기 단계다.
 *   mark    (button, index, item) 항목 단추에 고르기 명령을 붙인다.
 *
 * 항목 이름과 제목은 `textContent` 로 설정한다. 탭 제목은 사용자 입력이므로 마크업으로 넣으면 레이어 구조를 바꿀 수 있다.
 */
export function fillPicker(el, ask, groups, mark) {
  const document = el.ownerDocument;
  el.textContent = "";
  const head = document.createElement("div");
  head.className = "picker__head";
  head.textContent = ask;
  el.appendChild(head);
  const keys = [];
  for (const { heading, items } of groups) {
    if (heading) {
      const title = document.createElement("div");
      title.className = "picker__group";
      title.dataset.group = heading.id;
      title.style.setProperty("--depth", String(heading.depth));
      title.innerHTML = `<svg viewBox="0 0 16 10" aria-hidden="true">${heading.map}</svg><span class="picker__group-name"></span>`;
      title.querySelector(".picker__group-name").textContent = heading.name;
      el.appendChild(title);
    }
    for (const item of items) {
      const b = document.createElement("button");
      b.className = "picker__item";
      b.dataset.expose = "core.picker.item";
      b.type = "button";
      b.dataset.key = item.key;
      b.dataset.active = String(item.active === true);
      if (heading) b.dataset.group = heading.id;
      // 기본값: 플러그인 표시는 16 단위 그림이고, 다른 크기의 그림을 넘기는 항목만 viewBox 를 함께 준다.
      const box = item.viewBox === undefined ? "0 0 16 16" : item.viewBox;
      b.innerHTML = `<svg viewBox="${box}" aria-hidden="true">${item.svg}</svg>` +
        '<span class="picker__name"></span><small></small>';
      b.querySelector(".picker__name").textContent = item.name;
      b.querySelector("small").textContent = item.mark;
      mark(b, keys.length, item);
      keys.push(item.key);
      el.appendChild(b);
    }
  }
  return keys;
}

/** 그려진 항목의 상태. 묶음이 없는 항목의 group 은 null 이다. */
export function pickerItems(el) {
  return [...el.querySelectorAll(".picker__item")].map((b) => ({
    key: b.dataset.key,
    name: b.querySelector(".picker__name").textContent,
    active: b.dataset.active === "true",
    group: b.dataset.group === undefined ? null : b.dataset.group,
  }));
}
