// Checks that the release body resolves each relative link of its document to the file at the release tag, because the
// release page resolves a relative link against the root of the tag (docs/operations/examples.md#release).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { releaseNotes } from "../release-notes.mjs";

const BASE = "https://github.com/soksak-app/core/blob/v0.0.24/";

test("each relative link of the release body names its file at the release tag", { timeout: 1000 }, () => {
  const text = [
    "[한국어](install.ko.md)",
    "the [registry](../spec/installation.md#application-update) and [this part](#install)",
    "an [address](https://soksak-app.github.io/registry/index.json) and `[code](kept.md)`",
  ].join("\n");
  assert.equal(releaseNotes(text, { file: "docs/operations/install.md", repository: "soksak-app/core", tag: "v0.0.24" }), [
    `[한국어](${BASE}docs/operations/install.ko.md)`,
    `the [registry](${BASE}docs/spec/installation.md#application-update) and [this part](${BASE}docs/operations/install.md#install)`,
    "an [address](https://soksak-app.github.io/registry/index.json) and `[code](kept.md)`",
  ].join("\n"));
});

test("the publish job writes the release body with the release notes script", { timeout: 1000 }, () => {
  const release = readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.match(release, /run: node scripts\/release-notes\.mjs docs\/operations\/install\.md "\$GITHUB_REPOSITORY" "v\$VERSION" > "\$RUNNER_TEMP\/release-notes\.md"/);
  assert.match(release, /body_path: \$\{\{ runner\.temp \}\}\/release-notes\.md/);
  assert.doesNotMatch(release, /body_path: docs\//, "the release body is a document whose links are relative to its folder");
});
