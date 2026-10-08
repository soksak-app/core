import assert from "node:assert/strict";
import test from "node:test";
import { commitMessageErrors, recordKind, recordViolations } from "../records.mjs";

test("record checks report each statement that is not a fact about the repository", () => {
  const cases = [
    ["Fixed in (3a57f77).", "commit reference"],
    ["See commit 3a57f77b for the change.", "commit reference"],
    ["Changes in 3a57f77..9f8e7d6 were reverted.", "commit reference"],
    ["Merged as PR #2.", "pull request number"],
    ["The pull request 12 adds entries.", "pull request number"],
    ["CI run 37439493900 failed.", "CI run number"],
    ["The log is /Users/somebody/log.txt.", "personal path"],
    ["Kept in ~/backup/logs.", "personal path"],
    ["Found on 2026-10-05 by the window check.", "account of who found or requested"],
    ["Found while the release was checked.", "account of who found or requested"],
    ["Requested by the user on 2026-10-07.", "account of who found or requested"],
    ["2026-10-05 R1-5-4에서 발견: 실패를 보고하지 않았다.", "account of who found or requested"],
    ["2026-10-07에 F95를 확인하다가 발견했다.", "account of who found or requested"],
    ["사용자 요청으로 추가한다.", "account of who found or requested"],
    ["It passes on this Mac.", "local environment"],
    ["이 머신에서 통과한다.", "local environment"],
  ];
  for (const [line, category] of cases) {
    assert.deepEqual(recordViolations(`# Title\n\n${line}\n`, "doc.md").map((error) => error.split(": ")[1]), [category], line);
    assert.match(recordViolations(`# Title\n\n${line}\n`, "doc.md")[0], /^doc\.md:3: /, line);
  }
});

test("record checks accept facts that contain hexadecimal values and the rule's own words", () => {
  for (const line of [
    "The session id is 4dc4a40a-1b2c-4d5e-8f90-123456789abc.",
    "The background is #8f98a080 and the accent (#4a90e2) follows the theme.",
    "The archive sha256 is 6e13c454c01f0261e99b6bb8b8d5cc493ad67ee5fd631cc538c810f2ad2004ee.",
    "A record does not name who requested, decided or found something.",
    "기록은 누가 요청·결정·발견했는지 적지 않는다.",
    "Plugin 발견/소유 규칙.",
    "The user's settings are kept.",
    "The build-machine rehearsal이 macOS에서 통과했다.",
    "The rehearsal of this macOS runner passed.",
  ]) assert.deepEqual(recordViolations(line, "doc.md"), [], line);
  assert.deepEqual(recordViolations("```\nFound on 2026-10-05\n```\n", "doc.md"), [], "a code block is not a record statement");
});

test("configuration files are checked in their comments only", () => {
  assert.equal(recordKind(".github/workflows/release.yml"), "config");
  assert.equal(recordKind("Makefile"), "config");
  assert.equal(recordKind("native/darwin/Makefile"), "config");
  assert.equal(recordKind("docs/spec/plugins.md"), "document");
  assert.equal(recordKind("scripts/records.mjs"), null);
  assert.deepEqual(recordViolations("# Found on 2026-10-05\nrun: echo 'Found on 2026-10-05'\n", "Makefile", "config"),
    ["Makefile:1: account of who found or requested: Found on"]);
});

test("commit messages use the subject form with a checklist ID, a body and no footer", () => {
  const body = "\n\nThe body states what changed and why.\n";
  assert.deepEqual(commitMessageErrors(`fix(vt): Run PTY shells in a UTF-8 locale (#S26)${body}`), []);
  assert.deepEqual(commitMessageErrors(`docs(features): Record the release (#F101.2)${body}`), []);
  assert.deepEqual(commitMessageErrors(`chore(release): Declare 0.0.6 (#G1.4-87-1)${body}`), []);
  assert.match(commitMessageErrors(`fix(vt): Run PTY shells${body}`)[0], /subject must be/);
  assert.match(commitMessageErrors(`fix: Run PTY shells (#S26)${body}`)[0], /subject must be/);
  assert.match(commitMessageErrors(`build(vt): Run PTY shells (#S26)${body}`)[0], /type must be/);
  assert.match(commitMessageErrors(`fix(vt): run PTY shells (#S26)${body}`)[0], /capital letter/);
  assert.match(commitMessageErrors(`fix(vt): Run PTY shells. (#S26)${body}`)[0], /period/);
  assert.match(commitMessageErrors(`fix(vt): ${"A".repeat(51)} (#S26)${body}`)[0], /above 50/);
  assert.match(commitMessageErrors("fix(vt): Run PTY shells (#S26)\n")[0], /non-empty body/);
  assert.match(commitMessageErrors(`fix(vt): Run PTY shells (#S26)\n\n${"word ".repeat(15)}\n`)[0], /above 72/);
  for (const footer of ["Refs: S26", "Co-Authored-By: Someone <someone@example.com>", "Signed-off-by: Someone <someone@example.com>"]) {
    assert.match(commitMessageErrors(`fix(vt): Run PTY shells (#S26)${body}\n${footer}\n`).join("\n"), /is a footer/, footer);
  }
  assert.match(commitMessageErrors(`fix(vt): Run PTY shells (#S26)\n\nFixed after PR #3 was merged.\n`).join("\n"), /pull request number/);
});
