// 표면이 알린 탭 제목과 작업 디렉터리, 새 탭의 출처 디렉터리.
import assert from "node:assert/strict";
import test from "node:test";
import { forgetTab, onTabReports, recordOrigin, reportDirectory, reportTitle, tabLabel, tabOrigin } from "../tab-reports.js";

test("a reported title is the tab label until it is removed, and changes notify once", () => {
  let notified = 0;
  const off = onTabReports(() => notified++);
  reportTitle("tab-a", "vim README.md");
  reportTitle("tab-a", "vim README.md");
  assert.equal(tabLabel("tab-a"), "vim README.md");
  assert.equal(notified, 1);
  reportTitle("tab-a", null);
  assert.equal(tabLabel("tab-a"), null);
  assert.equal(notified, 2);
  off();
});

test("an invalid title throws and leaves the label unchanged", () => {
  reportTitle("tab-b", "kept");
  for (const invalid of ["", "x".repeat(257), "bell\u0007", "c1\u0085", 7, undefined]) {
    assert.throws(() => reportTitle("tab-b", invalid), /a tab title must be 1 to 256 characters/);
  }
  assert.equal(tabLabel("tab-b"), "kept");
  forgetTab("tab-b");
  assert.equal(tabLabel("tab-b"), null);
});

test("a new tab's origin is the directory its source tab recorded at that moment", () => {
  reportDirectory("tab-c", "/tmp/project");
  recordOrigin("tab-d", "tab-c");
  reportDirectory("tab-c", "/tmp/elsewhere");
  assert.deepEqual(tabOrigin("tab-d"), { directory: "/tmp/project" });
  reportDirectory("tab-c", null);
  recordOrigin("tab-e", "tab-c");
  assert.deepEqual(tabOrigin("tab-e"), { directory: null });
  recordOrigin("tab-f", undefined);
  assert.deepEqual(tabOrigin("tab-f"), { directory: null });
  assert.deepEqual(tabOrigin("tab-unknown"), { directory: null });
  for (const invalid of ["relative", "", 3]) {
    assert.throws(() => reportDirectory("tab-c", invalid), /a tab directory must be an absolute path/);
  }
});
