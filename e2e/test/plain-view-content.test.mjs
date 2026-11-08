// The content of the plain view probe (e2e/fixtures/plain-view/probe): its region document shows a known text, and the view answers
// probeplain.content.read with the text that the document reported.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { DOCUMENT_ADDRESS, startPlainContent, startPlainDocument } from "../fixtures/plain-view/probe/ui/plain-probe.js";

const FOLDER = new URL("../fixtures/plain-view/probe/", import.meta.url);
// The text of the region document and the content read of the probe.
const PLAIN_CONTENT = "Plain view probe content";
const PLAIN_CONTENT_READ = Object.freeze({ command: "probeplain.content.read", document: "page" });
const manifest = JSON.parse(readFileSync(new URL("plugin.json", FOLDER), "utf8"));

test("the plain view probe declares its content read and its region document shows the text of the content case", () => {
  const read = manifest.exposes.commands.find((entry) => entry.name === PLAIN_CONTENT_READ.command);
  assert.deepEqual(read?.result, { type: "string" });
  assert.deepEqual(manifest.surface.composition.regions.map((region) => region.name), [PLAIN_CONTENT_READ.document]);
  assert.match(readFileSync(new URL("ui/document.html", FOLDER), "utf8"), new RegExp(`<p id="content">${PLAIN_CONTENT}</p>`));
  assert.equal(DOCUMENT_ADDRESS, "soksak://probeplain/ui/document.html");
});

test("the region document posts the text of #content to its own window", () => {
  const posts = [];
  startPlainDocument({
    document: { getElementById: (id) => (id === "content" ? { textContent: PLAIN_CONTENT } : null) },
    location: { origin: "soksak://probeplain" },
    postMessage: (message, origin) => posts.push([message, origin]),
  });
  assert.deepEqual(posts, [[{ from: "probeplain.document", text: PLAIN_CONTENT }, "soksak://probeplain"]]);
});

test("the content read waits for the report of the region document and answers its text", async () => {
  const commands = new Map();
  const loads = [];
  let listener = null;
  await startPlainContent({
    bridge: { commands: { register: async (name, handler) => { commands.set(name, handler); } } },
    page: { onMessage: (next) => { listener = next; }, load: async (address) => { loads.push(address); } },
  });
  assert.deepEqual([[...commands.keys()], loads], [["probeplain.content.read"], [DOCUMENT_ADDRESS]]);
  const answer = commands.get("probeplain.content.read")();
  listener({ from: "other", text: "not this" });
  listener({ from: "probeplain.document", text: PLAIN_CONTENT });
  assert.equal(await answer, PLAIN_CONTENT);
  assert.equal(await commands.get("probeplain.content.read")(), PLAIN_CONTENT);
  assert.throws(() => listener({ from: "probeplain.document", text: 3 }), /reported no text/);
});
