// Matches the content of a native modal document to the HTML that the main page sent (docs/spec/native-modals.md).
//
// Replacing the whole content removes every operation element from the document. If an update arrives between a press and a release, WebKit sees that the pressed element
// left and sends no click (docs/spec/exposure.md), so elements of the same kind and the same command are kept and only their attributes and
// text are matched. Only elements of a different kind or command are replaced with new elements.

/** Matches the content of root to html. Elements that did not change stay in the document. */
export function updateContent(root, html) {
  const template = root.ownerDocument.createElement("template");
  template.innerHTML = html;
  patchChildren(root, template.content);
}

/** Whether two nodes are the same element at the same position. Elements must have the same tag, the same connected command, and the same exposure name. */
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
    // default: when there are not enough children, that position is the end, so the node is appended with null.
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
  // The current value of an input is a property, not an attribute, so it is matched to the value of the new content.
  if (have.tagName === "INPUT") {
    if (have.checked !== want.checked) have.checked = want.checked;
    if (have.value !== want.value) have.value = want.value;
  }
  patchChildren(have, want);
  // The value of a select must be set after its options are matched, so that a new option can be chosen too.
  if (have.tagName === "SELECT" && have.value !== want.value) have.value = want.value;
}
