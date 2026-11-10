// A command that waits for a system dialog declares no time limit: the person decides how long the dialog stays open, and the
// answer of the dialog ends the command (`timeout` in docs/spec/exposure.md: a command has no time limit).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The host calls that show a system dialog or save panel, and the commands whose handlers await them. The declared commands
// must match this map exactly: a new dialog command is added here in the same change.
const DIALOG_COMMANDS = {
  "core.library.choose-folder": "folderChoose",
  "core.file.place": "filePlace",
  "core.debug.save": "debugSave",
  "core.debug.save-all": "debugSaveAll",
  "core.debug.timeline.save": "debugSaveText",
};

const { exposes } = JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8"));
const commands = new Map(exposes.commands.map((command) => [command.name, command]));

// The descriptions of the commands name the dialog they show, so a command that shows a dialog without being in the map fails.
const DIALOG_WORDS = /save panel|system dialog/;

test("every declared command that shows a dialog is listed with its host call", () => {
  const described = exposes.commands.filter(({ description }) => DIALOG_WORDS.test(description)).map(({ name }) => name).sort();
  assert.deepEqual(described, Object.keys(DIALOG_COMMANDS).sort());
});

for (const [name, call] of Object.entries(DIALOG_COMMANDS)) {
  test(`${name} waits for the ${call} dialog and declares no time limit`, () => {
    const command = commands.get(name);
    assert.ok(command, `${name} is not declared`);
    assert.equal(Object.hasOwn(command, "timeout"), false, `${name} declares timeout ${command.timeout} for the ${call} dialog`);
  });
}
