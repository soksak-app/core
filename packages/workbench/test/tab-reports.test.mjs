// 표면이 알린 탭 제목과 작업 디렉터리, 새 탭의 출처 디렉터리.
import assert from "node:assert/strict";
import test from "node:test";
import { clearVisibleNotices, forgetTab, onTabReports, recordOrigin, reportDirectory, reportModified, reportNotice, reportTitle,
  setVisibleTab, tabLabel, tabModified, tabNotice, tabNotices, tabOrigin } from "../tab-reports.js";

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

test("a notice is kept for a tab out of view and removed when the tab comes into view", () => {
  let visible = "tab-shown";
  setVisibleTab((id) => id === visible);
  let notified = 0;
  const off = onTabReports(() => notified++);
  reportNotice("tab-shown", "build complete");
  assert.equal(tabNotice("tab-shown"), null, "a notice for the tab in view must change nothing");
  assert.equal(notified, 0);
  reportNotice("tab-hidden", "first");
  reportNotice("tab-hidden", "build complete");
  assert.equal(tabNotice("tab-hidden"), "build complete");
  assert.equal(notified, 2);
  clearVisibleNotices();
  assert.equal(tabNotice("tab-hidden"), "build complete");
  visible = "tab-hidden";
  clearVisibleNotices();
  assert.equal(tabNotice("tab-hidden"), null);
  assert.equal(notified, 3);
  visible = null;
  reportNotice("tab-closed", "x");
  forgetTab("tab-closed");
  assert.equal(tabNotice("tab-closed"), null);
  for (const invalid of ["", "x".repeat(1025), "line\n", null, 1]) {
    assert.throws(() => reportNotice("tab-hidden", invalid), /a tab notice must be 1 to 1024 characters/);
  }
  off();
});

test("a system notification policy hides the tab dot but exposes the notice to the notification center", () => {
  setVisibleTab(() => false);
  reportNotice("tab-system", "system body", "system");
  assert.equal(tabNotice("tab-system"), null);
  assert.deepEqual(tabNotices(), [["tab-system", "system body"]]);
  assert.throws(() => reportNotice("tab-invalid-policy", "body", "other"), /unknown tab notice policy/);
  forgetTab("tab-system");
});

test("a surface reports whether its tab holds unsaved changes until the tab is forgotten", () => {
  let notified = 0;
  const off = onTabReports(() => notified++);
  assert.equal(tabModified("tab-m"), false);
  reportModified("tab-m", true);
  reportModified("tab-m", true);
  assert.equal(tabModified("tab-m"), true);
  assert.equal(notified, 1);
  for (const invalid of ["yes", 1, null, undefined]) {
    assert.throws(() => reportModified("tab-m", invalid), /a modified state must be true or false/);
  }
  reportModified("tab-m", false);
  assert.equal(tabModified("tab-m"), false);
  reportModified("tab-m", true);
  forgetTab("tab-m");
  assert.equal(tabModified("tab-m"), false);
  assert.equal(notified, 4);
  off();
});
