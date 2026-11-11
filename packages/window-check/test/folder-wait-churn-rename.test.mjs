// The rename of a change of the churn writer (folder-wait-churn-rename.mjs): a rename that answered ENOENT and took place is
// a change, and a rename whose source something removed or that answered another failure fails with its report.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renameChange } from "./folder-wait-churn-rename.mjs";

function folder(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), "folder-wait-churn-rename-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(join(dir, "state"), "6663");
  fs.writeFileSync(join(dir, ".state.tmp"), "6664");
  return { from: join(dir, ".state.tmp"), to: join(dir, "state") };
}

function answering(code, act) {
  return (from, to) => {
    act(from, to);
    throw Object.assign(new Error(`${code}: rename '${from}' -> '${to}'`), { code });
  };
}

test("a rename that answers no failure is a change", (t) => {
  const { from, to } = folder(t);
  assert.equal(renameChange(from, to, "6664", 6664), false);
  assert.equal(fs.readFileSync(to, "utf8"), "6664");
  assert.equal(fs.existsSync(from), false);
});

test("a rename that took place and answered ENOENT is a change", (t) => {
  const { from, to } = folder(t);
  assert.equal(renameChange(from, to, "6664", 6664, answering("ENOENT", fs.renameSync)), true);
  assert.equal(fs.readFileSync(to, "utf8"), "6664");
});

test("a rename whose source something removed fails with what the target holds", (t) => {
  const { from, to } = folder(t);
  assert.throws(() => renameChange(from, to, "6664", 6664, answering("ENOENT", (source) => fs.rmSync(source))), {
    code: "ENOENT",
    message: /^ENOENT: rename '.*' -> '.*' at change 6664; state holds 6663; \.state\.tmp is not listed and not found$/,
  });
});

test("a rename that answered ENOENT while its source is listed fails", (t) => {
  const { from, to } = folder(t);
  assert.throws(() => renameChange(from, to, "6664", 6664, answering("ENOENT", (source, target) => fs.copyFileSync(source, target))), {
    code: "ENOENT",
    message: / at change 6664; state holds 6664; \.state\.tmp is listed and found$/,
  });
});

test("a rename that took place and answered another failure fails", (t) => {
  const { from, to } = folder(t);
  assert.throws(() => renameChange(from, to, "6664", 6664, answering("EIO", fs.renameSync)), {
    code: "EIO",
    message: / at change 6664; state holds 6664; \.state\.tmp is not listed and not found$/,
  });
});
