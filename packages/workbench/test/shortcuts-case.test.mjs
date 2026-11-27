// The workbench shortcut table (shortcuts.json) holds the rows that the page-wire case view-calls-shortcuts-read declares as the reply of
// its shortcut read. A row added to the table alone, or removed from it alone, fails here (docs/spec/exposure.md#keyboard-shortcuts).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import shortcutTable from "../shortcuts.json" with { type: "json" };

const kase = JSON.parse(readFileSync(new URL("../../../docs/spec/cases/page-wire/view-calls-shortcuts-read.json", import.meta.url), "utf8"));

test("the shortcut table holds the rows that the view-calls-shortcuts-read case declares, in the same order", () => {
  const reply = kase.steps.find((step) => step.call?.name === "viewReply" && step.call.payload.id === 1);
  const declared = reply.call.payload.result.map(({ key, owner, command }) => ({ key, owner, command }));
  const table = shortcutTable.shortcuts
    .filter((row) => row.owner !== "native menu")
    .map(({ key, owner, command }) => ({ key, owner, command }));
  assert.deepEqual(table, declared);
});
