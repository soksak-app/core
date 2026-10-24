import assert from "node:assert/strict";

/** Waits for a newer accepted Files tree snapshot and returns it with its section state. */
export async function waitTreeSnapshot(s, afterSequence, predicate, message) {
  assert.ok(Number.isInteger(afterSequence), "the Files tree has no accepted snapshot sequence");
  let sequence = afterSequence;
  for (;;) {
    const sidebars = await s.until("core.sidebars", (value) => {
      const section = value.find((item) => item.sidebar === "left")?.sections.find((item) => item.id === "files.tree");
      return Number.isInteger(section?.acceptedSeq) && section.acceptedSeq > sequence;
    }, message);
    const section = sidebars.find((item) => item.sidebar === "left")?.sections.find((item) => item.id === "files.tree");
    sequence = section.acceptedSeq;
    const snapshot = await s.get("files.tree");
    if (predicate(snapshot, section)) return { sequence, snapshot, section };
  }
}

/** Waits for the file-open error to appear in the selected tree row. */
export async function openFailureRow(s, path, afterSequence, trigger) {
  await trigger();
  const observed = await waitTreeSnapshot(s, afterSequence,
    (snapshot, section) => {
      const nodes = treeNodes(snapshot);
      const selected = nodes.some((node) => node.params?.path === path && node.selected === true);
      const errorRow = nodes.find((node) => [node.label, node.detail].some((value) =>
        typeof value === "string" && value.includes("열 수 없음: ") && value.includes(path.split("/").at(-1))));
      return section.text.includes("열 수 없음: ") && selected && errorRow !== undefined;
    },
    "Enter on a file that no plugin opens left no failure row");
  const errorRow = treeNodes(observed.snapshot).find((node) => [node.label, node.detail].some((value) =>
    typeof value === "string" && value.includes("열 수 없음: ") && value.includes(path.split("/").at(-1))));
  assert.ok(errorRow,
    `the failure row does not name ${path}: ${observed.section.text}`);
  assert.equal(await s.get("core.page.error"), null, "the file-open failure reached the application error display");
  return observed;
}

/** Returns whether a declared tree snapshot contains a file-open failure row. */
export function hasOpenFailureRow(snapshot) {
  return treeNodes(snapshot).some((node) => [node.label, node.detail]
    .some((value) => typeof value === "string" && value.includes("열 수 없음: ")));
}

/** Flattens the nodes of the declared Files tree snapshot. */
export function treeNodes(snapshot) {
  const tree = snapshot.value?.elements.find((element) => element.kind === "tree" && element.key === "files");
  const flatten = (nodes) => (nodes ?? []).flatMap((node) => [node, ...flatten(node.children)]);
  return flatten(tree?.nodes);
}
