// 네이티브 모달 문서의 내용을 메인 페이지가 보낸 HTML 로 맞춘다(docs/spec/native-modals.md).
//
// 내용을 통째로 바꾸면 모든 조작 요소가 문서에서 빠진다. 누름과 뗌 사이에 갱신이 오면 WebKit 은 눌린 요소가 빠진
// 것을 보고 click 을 보내지 않으므로(docs/spec/exposure.md), 같은 종류와 같은 명령의 요소는 그대로 두고 속성과
// 글만 맞춘다. 종류나 명령이 다른 요소만 새 요소로 바꾼다.

/** root 의 내용을 html 과 같게 맞춘다. 바뀌지 않은 요소는 문서에 그대로 남는다. */
export function updateContent(root, html) {
  const template = root.ownerDocument.createElement("template");
  template.innerHTML = html;
  patchChildren(root, template.content);
}

/** 두 노드가 같은 자리의 같은 요소인지. 요소는 태그와 연결된 명령, 노출 이름이 같아야 한다. */
function same(have, want) {
  if (have.nodeType !== want.nodeType) return false;
  if (have.nodeType !== 1) return true;
  return have.tagName === want.tagName
    && have.getAttribute("data-command") === want.getAttribute("data-command")
    && have.getAttribute("data-expose") === want.getAttribute("data-expose");
}

function patchChildren(parent, source) {
  const wanted = [...source.childNodes];
  wanted.forEach((want, index) => {
    const have = parent.childNodes[index];
    if (have && same(have, want)) patchNode(have, want);
    // 기본값: 자식이 모자라면 그 자리가 끝이므로 null 로 끝에 넣는다.
    else parent.insertBefore(want, parent.childNodes[index] ?? null);
  });
  while (parent.childNodes.length > wanted.length) parent.lastChild.remove();
}

function patchNode(have, want) {
  if (have.nodeType !== 1) {
    if (have.nodeValue !== want.nodeValue) have.nodeValue = want.nodeValue;
    return;
  }
  for (const { name } of [...have.attributes]) if (!want.hasAttribute(name)) have.removeAttribute(name);
  for (const { name, value } of [...want.attributes]) {
    if (have.getAttribute(name) !== value) have.setAttribute(name, value);
  }
  // 입력의 현재 값은 속성이 아니라 속성값(property)이므로 새 내용의 값으로 맞춘다.
  if (have.tagName === "INPUT") {
    if (have.checked !== want.checked) have.checked = want.checked;
    if (have.value !== want.value) have.value = want.value;
  }
  patchChildren(have, want);
  // select 의 값은 그 option 을 맞춘 뒤에 정해야 새 option 도 고를 수 있다.
  if (have.tagName === "SELECT" && have.value !== want.value) have.value = want.value;
}
