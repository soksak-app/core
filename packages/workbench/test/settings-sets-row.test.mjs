// The row of a set on the page Sidebar sets is one card: its head (the name, the layout badge and the places that use it), its
// section chips and its missing-plugin notes sit in one body, and its actions sit in the second column of the same row, so every row
// draws the same columns. The description of the page is drawn once, by the page head (docs/spec/settings.md#사이드바-세트).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { installExposure } from "../exposure.js";
import { beginSettings, setPluginSettings, setSidebarDefaults } from "../settings.js";
import { setsPage } from "../settings-sets.js";

installExposure(JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")));

const PAGE_DESCRIPTION = "사이드바에 보여 줄 섹션 묶음. 어느 변에 놓을지는 작업 공간과 플러그인에서 고른다.";

test("each set row has one body with its head, chips and notes, and its actions in the second column of the same row", (t) => {
  const dom = new JSDOM("<body></body>");
  t.after(() => dom.window.close());
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  setPluginSettings([]);
  const sets = [
    { id: "explorer", title: "탐색기", layout: "list", sections: ["files.tree", "files.bookmarks"] },
    { id: "page", title: "페이지", layout: "tabs", sections: ["browser.dom"] },
  ];
  setSidebarDefaults({ sets, links: [] });
  beginSettings({ common: { sets, links: [] }, projects: [] }, null);
  const root = dom.window.document.createElement("div");
  root.append(...setsPage());
  const rows = [...root.querySelectorAll(".set-set")];
  assert.equal(rows.length, 2, "one row per set");
  for (const row of rows) {
    assert.deepEqual([...row.children].map((child) => child.className), ["set-set__body", "set-set__actions"], "the row has a body and its actions");
    const body = row.children[0];
    assert.ok(body.querySelector(".set-set__head .set-set__title"), "the body holds the head with the name");
    assert.ok(body.querySelector(".set-chips"), "the body holds the section chips");
    assert.ok(body.querySelector(".missing-line"), "the body holds the missing-plugin note");
    assert.deepEqual([...row.children[1].querySelectorAll("button")].map((button) => button.textContent), ["편집", "삭제"], "the actions are 편집 and 삭제");
  }
  assert.equal(root.textContent.includes(PAGE_DESCRIPTION), false, "the page description is drawn by the page head, not by the list");
});
