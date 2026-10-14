# Stored data migration from shipped definitions

This proposal is pending; its approved content moves into `docs/spec/installation.md`, `docs/spec/plugins.md` and the agent guidance, and the proposal is then removed (checklist F188, F189).

## Background

The release 0.0.13 refuses to start on a configuration whose `plugins/installed.json` a release of the same product line wrote earlier: `installed plugins: <file>: browser: unknown field package`. The change that removed the `package` field and the npm-style `^` ranges from the entries (the vocabulary change of the plugin naming, 2026-10-08) did not raise the format number (`InstalledFormat` stayed 2), so no version difference announced the change, no migration could attach to it, and the reader—correct under the guidance that forbade migrations—left the person with no path: the host fails at startup, so not even a reinstall command runs.

The check suites never meet this transition: every check starts from a configuration the current installer just wrote, and no check executes a release build at all. The transition "data of the previous release plus the binary of the new one" has no coverage.

## Decision

Stored data migrates mechanically from definitions that ship with the package, for every owner of stored data (core, a plugin, a sidecar):

1. **A format change raises the format number and ships a migration definition.** A definition is data, not code: `from`, `to`, and mechanical operations (remove a field, rename a field, convert a value form).
2. **The definition ships with the package.** Core's definitions live in this repository as source files (`packages/sok/migrations/*.json`) and both `sok` builds embed them (`go:embed`, `include_str!`)—one source, both hosts identical. A plugin or sidecar ships its definitions in its release, and its manifest (`plugin.json`, `sidecar.json`) declares them; the form of a definition is the same for the three owners.
3. **Core performs every migration.** One engine (in `packages/sok`, Go and Rust twins) reads the definitions and applies them mechanically at the moment the new package takes ownership of the configuration folder: host start for core-owned files, the `sok` plugin and sidecar commands for the others. Plugins and sidecars carry no migration code.
4. **The engine is idempotent and bounded.** It reads the stored format number and applies the definitions step by step (2→3→…); a file already at the current format is untouched, and applying twice writes the same bytes. A form older than the previous released form, or a file that does not parse, is refused with an explicit error that names the file and what was found—the reader keeps accepting only the current format, and the reading code of an earlier form is not kept: the definition plus the engine replace it.

The guidance sentence that forbade migrations is wrong as it stood and changes with this decision: a stored format change raises the format number and ships a definition; the reader accepts only the current format.

## First application (F188)

- `plugins/installed.json` becomes format 3 (the current entry shape, without `package`); the first definition `2→3` removes the `package` member of every entry, converts a `^x.y.z` sidecar range to the finite range of npm caret semantics, and sets the format number. `enabled`, `previous` and the other members pass unchanged.
- Engine `MigrateInstalled` in both `sok` packages; application points: both hosts' start, and the `sok plugin *` commands.

## Checks (F189)

- The owning tests (both languages) start each host on the released format-2 form: the engine migrates it, the host starts, the file is format 3, a second start writes nothing. A format-1 or unparseable file is refused with the named error.
- A declared release step runs a release-built host once on the format-2 form and requires the migration and the first host log line; a workflows test asserts the step.

## Adversarial review

The decision goes through an adversarial review by agents; each objection is answered with evidence or changes the plan, and the review repeats until no objection remains. Objections and answers are recorded here.

_Pending: three reviewers examine (a) whether the definition form covers every format change of this repository's history, (b) the failure modes of the runtime model (partial writes, concurrency, translocation, version skew, hostile definitions), (c) the design against the standard alternatives and the defect class beyond `installed.json`._
