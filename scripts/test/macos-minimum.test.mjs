// Verifies the reader of the declared macOS minimum and the reader of the linker warnings that the runners judge
// (docs/operations/examples.md#test-parity).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { linkerWarnings, macosMinimum } from "../macos-minimum.mjs";

const newer = (object, built, linked) => `ld: warning: object file (${object}) was built for newer 'macOS' version (${built}) than being linked (${linked})`;

test("a linker warning of an object built for a newer macOS version than the link is a failure that names the object and both versions", () => {
  const output = [
    "# github.com/soksak-app/core/packages/host/wailsv3/tests.test",
    newer("/private/var/folders/T/go-link-1/000029.o", "27.0", "14.4"),
    newer("/core/native/darwin/build/libsoksak-darwin.a[2](capture.o)", "14.4", "11.0"),
  ].join("\n");
  assert.deepEqual(linkerWarnings(output), {
    failures: [
      "ld built /private/var/folders/T/go-link-1/000029.o for macOS 27.0, newer than the macOS 14.4 of the link",
      "ld built /core/native/darwin/build/libsoksak-darwin.a[2](capture.o) for macOS 14.4, newer than the macOS 11.0 of the link",
    ],
    held: [],
  });
});

test("a linker message of rustc in the JSON of cargo is one failure", () => {
  const text = `linker stderr: ${newer("/target/debug/build/ring-1/out/libring_core.a(curve25519.o)", "27.0", "11.0")}`;
  const output = JSON.stringify({ reason: "compiler-message", message: { message: text, rendered: `warning: ${text}\n  |\n  = note: \`#[warn(linker_messages)]\` on by default\n\n` } });
  assert.deepEqual(linkerWarnings(output).failures, [
    "ld built /target/debug/build/ring-1/out/libring_core.a(curve25519.o) for macOS 27.0, newer than the macOS 11.0 of the link",
  ]);
});

test("the duplicate library warning of the link of two Objective-C packages is recognized and held, not a failure", () => {
  assert.deepEqual(linkerWarnings("ld: warning: ignoring duplicate libraries: '-lobjc'\nok"), {
    failures: [],
    held: ["ld ignored duplicate libraries: '-lobjc'"],
  });
  assert.deepEqual(linkerWarnings("ok\n--- PASS: TestA (0.00s)"), { failures: [], held: [] });
});

test("the declared minimum is the MACOS_MINIMUM of the Makefile, and a Makefile without it is refused", (t) => {
  assert.match(macosMinimum(), /^\d+\.\d+(?:\.\d+)?$/);
  const directory = mkdtempSync(join(tmpdir(), "soksak-macos-minimum-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "Makefile"), "MACOS_MINIMUM = 15.1\n");
  assert.equal(macosMinimum(directory), "15.1");
  writeFileSync(join(directory, "Makefile"), "MINIMUM = 15.1\n");
  assert.throws(() => macosMinimum(directory), new RegExp(`^Error: ${join(directory, "Makefile")} declares no MACOS_MINIMUM = <macOS version>$`));
});
