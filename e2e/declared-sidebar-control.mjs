import assert from "node:assert/strict";

const NAME = "core.sidebar.section.control";

/** Returns the exposed DOM index of one uniquely addressed control in its declared sidebar section. */
export async function declaredSidebarControlIndex(s, address) {
  const sidebars = await s.get("core.sidebars");
  let index = 0;
  let range;
  for (const sidebar of sidebars) {
    for (const section of sidebar.sections) {
      const end = index + section.controls;
      if (sidebar.sidebar === address.sidebar && section.id === address.section) {
        range = { start: index, end };
        break;
      }
      index = end;
    }
    if (range) break;
  }
  assert.ok(range, `no exposed controls for ${address.sidebar}/${address.section}`);

  const expected = await s.request("dom.rect", { name: NAME, address });
  const matches = [];
  for (let candidate = range.start; candidate < range.end; candidate += 1) {
    const rect = await s.request("dom.rect", { name: NAME, index: candidate });
    if (rect.x === expected.x && rect.y === expected.y && rect.width === expected.width && rect.height === expected.height) {
      matches.push(candidate);
    }
  }
  assert.equal(matches.length, 1, `the declared control address maps to ${matches.length} exposed DOM indices`);
  return matches[0];
}

/** Gives one declared sidebar control keyboard focus and waits until core.focus reports that exact element. */
export async function focusDeclaredSidebarControl(s, address) {
  const index = await declaredSidebarControlIndex(s, address);
  assert.equal(await s.run("core.focus.set", { name: NAME, index }), null);
  return s.until("core.focus", (focus) => focus?.name === NAME && focus.index === index,
    `core.focus.set did not focus ${address.sidebar}/${address.section} control ${index}`);
}
