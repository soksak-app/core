// Runs ordered published screenHash cases against the core implementation.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { screenBytes, screenFromMessage, screenHash } from "../screen-hash.js";

const CONTRACT = JSON.parse(readFileSync(new URL("../contract/screen-hash.json", import.meta.url), "utf8"));
const EXPECTED_IDS = [
  "screen.bytes.canonical-order",
  "screen.hash.sha256",
  "screen.message.projects-hashed-fields",
  "screen.refusal.names-invalid-member",
  "screen.message.empty-one-cell",
  "screen.message.empty-one-cell-attributes-change",
  "screen.message.empty-one-cell.projects",
  "screen.message.empty-one-cell-attributes-change.projects",
  "screen.hash.empty-one-cell.sha256",
  "screen.hash.empty-one-cell-attributes-change.sha256",
  "screen.message.blank-underlined-cursor",
  "screen.message.korean-preedit",
  "screen.message.linked-word",
  "screen.message.empty-one-cell.frame-null",
  "screen.message.empty-one-cell-attributes-change.frame-null",
  "screen.message.refuses-missing-sequence.frame-null",
  "screen.message.refuses-zero-rows.frame-null",
  "screen.message.refuses-zero-cols.frame-null",
  "screen.message.refuses-cell-count.frame-null",
  "screen.message.refuses-cell-attributes.frame-null",
  "screen.message.refuses-empty-segment.frame-null",
  "screen.message.blank-cell-cursor-visible",
  "screen.message.letter-x-cursor-hidden",
  "screen.message.scrollback-offset-3",
  "screen.message.scrollback-offset-25",
  "screen.message.scrollback-background",
  "screen.message.background-color",
  "screen.message.attribute-flags",
  "screen.message.wide-cell-continuation",
  "screen.message.multiline-rows",
  "screen.message.frame-screen-read",
  "screen.message.null-frame-screen-read",
  "screen.message.frame-screen-good",
  "screen.message.frame-preedit",
  "screen.hash.frame-preedit.sha256",
  "screen.message.caret-8x4",
  "screen.message.hollow-block-cursor",
  "screen.message.cursor-preedit-null",
  "screen.message.blank-hidden-cursor",
  "screen.message.scrollback-background-offset-25",
  "screen.message.cursor-without-preedit",
  "screen.message.scrollback-offset-0",
  "screen.message.scrollback-offset-zero-hidden-cursor",
  "screen.message.empty-scrollback",
  "screen.hash.letter-x-hidden-cursor.sha256",
  "screen.hash.blank-hidden-cursor.sha256",
  "screen.hash.attribute-flags.sha256",
  "screen.hash.wide-cell-continuation.sha256",
  "screen.hash.multiline-rows.sha256",
  "screen.hash.single-row-five-cells.sha256",
  "screen.hash.blank-caret-8x4.sha256",
  "screen.hash.blank-two-cell-cursor.sha256",
  "screen.hash.linked-word.sha256",
];

const MESSAGE_HASH_PAIRS = [
  ["screen.message.letter-x-cursor-hidden", "screen.hash.letter-x-hidden-cursor.sha256"],
  ["screen.message.scrollback-offset-3", "screen.hash.blank-hidden-cursor.sha256"],
  ["screen.message.scrollback-offset-25", "screen.hash.blank-hidden-cursor.sha256"],
  ["screen.message.blank-hidden-cursor", "screen.hash.blank-hidden-cursor.sha256"],
  ["screen.message.scrollback-background-offset-25", "screen.hash.blank-hidden-cursor.sha256"],
  ["screen.message.scrollback-offset-zero-hidden-cursor", "screen.hash.blank-hidden-cursor.sha256"],
  ["screen.message.attribute-flags", "screen.hash.attribute-flags.sha256"],
  ["screen.message.wide-cell-continuation", "screen.hash.wide-cell-continuation.sha256"],
  ["screen.message.multiline-rows", "screen.hash.multiline-rows.sha256"],
  ["screen.message.frame-screen-read", "screen.hash.single-row-five-cells.sha256"],
  ["screen.message.null-frame-screen-read", "screen.hash.single-row-five-cells.sha256"],
  ["screen.message.caret-8x4", "screen.hash.blank-caret-8x4.sha256"],
  ["screen.message.blank-underlined-cursor", "screen.hash.blank-two-cell-cursor.sha256"],
  ["screen.message.hollow-block-cursor", "screen.hash.blank-two-cell-cursor.sha256"],
  ["screen.message.linked-word", "screen.hash.linked-word.sha256"],
];

export async function runScreenHashCase(testCase) {
  const outputs = [];
  for (const step of testCase.steps) {
    assert.ok(step && typeof step === "object" && !Array.isArray(step), `${testCase.id}: step must be an object`);
    const operations = ["bytes", "hash", "message"].filter((name) => Object.hasOwn(step, name));
    assert.equal(operations.length, 1, `${testCase.id}: every step must have exactly one operation`);
    try {
      if (operations[0] === "bytes") {
        outputs.push({ bytes: Buffer.from(screenBytes(step.bytes.screen)).toString("hex") });
      } else if (operations[0] === "hash") {
        outputs.push({ hash: await screenHash(step.hash.screen) });
      } else {
        outputs.push({ screen: screenFromMessage(step.message.value) });
      }
    } catch (error) {
      outputs.push({ error: error.message });
    }
  }
  return outputs;
}

test("screenHash publishes ordered canonicalization, message, and refusal cases", () => {
  assert.deepEqual(CONTRACT.cases.map(({ id }) => id), EXPECTED_IDS);
});

for (const testCase of CONTRACT.cases) {
  test('screenHash ' + testCase.id + ' matches each ordered step', async () => {
    assert.deepEqual(await runScreenHashCase(testCase), testCase.steps.map(({ output }) => output));
  });
}

test("screenHash contract runner refuses steps with no operation or multiple operations", async () => {
  await assert.rejects(runScreenHashCase({ id: "invalid-missing", steps: [{ unknown: true }] }), /exactly one operation/);
  await assert.rejects(runScreenHashCase({ id: "invalid-multiple", steps: [{ bytes: { screen: {} }, hash: { screen: {} } }] }), /exactly one operation/);
});

test("screenHash frame and preedit message pairs with its projected screen hash", async () => {
  const messageCase = CONTRACT.cases.find(({ id }) => id === "screen.message.frame-preedit");
  const hashCase = CONTRACT.cases.find(({ id }) => id === "screen.hash.frame-preedit.sha256");
  assert.ok(messageCase, "frame and preedit message case is published");
  assert.ok(hashCase, "projected screen hash case is published");
  const [{ screen }] = await runScreenHashCase(messageCase);
  assert.deepEqual(hashCase.steps[0].hash.screen, screen);
  assert.equal(hashCase.steps[0].output.hash, await screenHash(screen));
});

test("screenHash publishes one unique hash input for each valid message projection", async () => {
  const hashInputs = CONTRACT.cases.flatMap(({ id, steps }) => steps.flatMap((step) =>
    step.hash ? [{ id, screen: step.hash.screen }] : []));
  for (const [messageId, hashId] of MESSAGE_HASH_PAIRS) {
    const messageCase = CONTRACT.cases.find(({ id }) => id === messageId);
    const hashCase = CONTRACT.cases.find(({ id }) => id === hashId);
    assert.ok(messageCase, `${messageId} is published`);
    assert.ok(hashCase, `${hashId} is published`);
    const [{ screen }] = await runScreenHashCase(messageCase);
    assert.deepEqual(hashCase.steps[0].hash.screen, screen, `${hashId} does not hash ${messageId}'s projection`);
    assert.equal(hashCase.steps[0].output.hash, await screenHash(screen), `${hashId} is not the SDK hash`);
    const matches = hashInputs.filter(({ screen: candidate }) => JSON.stringify(candidate) === JSON.stringify(screen));
    assert.deepEqual(matches.map(({ id }) => id), [hashId], `${messageId} projection has an ambiguous hash input`);
  }
});
