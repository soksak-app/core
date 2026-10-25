import assert from "node:assert/strict";
import test from "node:test";
import { projectRecords } from "../projects-file.mjs";

test("project records read the current registry envelope without replacing it", { timeout: 1000 }, () => {
  const envelope = { format: 1, projects: [{ id: "project-one" }] };
  assert.equal(projectRecords(envelope, "projects.json").find((p) => p.id === "project-one"), envelope.projects[0]);
  projectRecords(envelope, "projects.json")[0].title = "Saved project";
  assert.deepEqual(envelope, { format: 1, projects: [{ id: "project-one", title: "Saved project" }] });
});

test("project records reject the obsolete bare array", { timeout: 1000 }, () => {
  assert.throws(() => projectRecords([], "fixture/projects.json"), /fixture\/projects\.json.*format/);
});

test("project records reject an unsupported format", { timeout: 1000 }, () => {
  assert.throws(() => projectRecords({ format: 2, projects: [] }, "projects.json"), /projects\.json.*format 2/);
});

test("project records reject a malformed current envelope", { timeout: 1000 }, () => {
  assert.throws(() => projectRecords({ format: 1, projects: {} }, "projects.json"), /projects\.json.*projects.*array/);
});
