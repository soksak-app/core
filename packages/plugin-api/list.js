// 목록을 제자리에서 갱신한다(F67). 다시 그리기가 바뀌지 않은 조작 요소를 문서에서 빼면, 누름과 뗌 사이에 그 그리기가
// 오는 경우 WebKit 은 click 을 보내지 않는다(core docs/spec/exposure.md). 그래서 key 가 같은 요소는 문서에 둔 채
// 고치고, 새 key 만 만들며, 순서가 틀린 요소만 옮긴다.

const KEY = "listKey";

/**
 * list 의 자식을 entries 의 순서로 맞춘다.
 *
 *   key(entry)            요소를 가리키는 값. 같은 key 의 요소는 다시 쓴다. 두 entry 가 같은 key 를 가지면 실패한다.
 *   create(entry)         새 key 의 요소를 만든다.
 *   update(element, entry) 요소를 entry 에 맞게 고친다. 새로 만든 요소에도 부른다.
 *
 * entries 에 없는 자식(글 노드 포함)은 뺀다.
 */
export function drawList(list, entries, { key, create, update }) {
  const kept = new Map();
  for (const child of list.children) {
    if (child.dataset[KEY] !== undefined) kept.set(child.dataset[KEY], child);
  }
  const seen = new Set();
  const nodes = entries.map((entry) => {
    const id = String(key(entry));
    if (seen.has(id)) throw new Error(`drawList: key ${JSON.stringify(id)} appears twice`);
    seen.add(id);
    let node = kept.get(id);
    if (!node) {
      node = create(entry);
      node.dataset[KEY] = id;
    }
    update(node, entry);
    return node;
  });
  const wanted = new Set(nodes);
  for (const child of [...list.childNodes]) if (!wanted.has(child)) child.remove();
  nodes.forEach((node, index) => {
    // 기본값: index 가 자식 수와 같으면 그 자리가 끝이므로 null 로 끝에 넣는다.
    if (list.childNodes[index] !== node) list.insertBefore(node, list.childNodes[index] ?? null);
  });
}
