# Development

[한국어](AGENTS.ko.md)

`soksak` is a headless layout library. The library owns card geometry and optional DOM binding. Example applications own projects, tabs, styling, native views, and shells.

## Implementation

- Choose the simplest implementation that satisfies the current contract. Remove obsolete paths instead of adding compatibility layers, fallbacks, or migrations.
- Keep responsibilities separate. Add native platform code only when the required behavior cannot be implemented through existing APIs.
- Maintain the [private native API inventory](docs/operations/private-native-apis.md) with each API or call-condition change. Read it first when diagnosing failures after native source, framework, SDK, or OS updates; review each correction's necessity and actual API semantics.
- Remove harmful or unnecessary changes. Preserve correct unrelated changes separately and describe their actual purpose in the commit.
- Verify behavior before rewriting commits. Do not merge or push without authorization.

## Documentation

- Read the applicable specification before changing behavior. Update it first when the contract changes and mark incomplete implementation in [features](docs/features.md).
- Keep one canonical document per topic. `docs/spec/` defines contracts; `docs/features.md` separates implementation, validation, and release; `docs/operations/` contains current procedures; `CHANGELOG.md` records actual changes and validation.
- Keep README files limited to an introduction, minimum startup steps, and document links. Use `docs/plans/` only for pending proposals; remove a proposal after incorporating its approved content into the specification.
- English is canonical. Update its matching `.ko.md` translation in the same change with the same information.
- Describe current behavior and actual reasons. Personal preferences and conversation context belong in memory outside Git.
- Use direct action names and explicit subjects and objects. State a cause in one sentence. Do not use metaphors, personification, or colloquial wording in comments, documents, logs, or commits.
- Library comments use English; example comments use Korean. Identifiers, logs, errors, and test names use English.
- Commit messages have no trailers, generated-by text, or session links.

## Verification

- Run `make docs-check` for every change and review the documents against the code; structural checks do not verify meaning.
- Run `make verify` for library changes. Commit generated `dist/` changes together with their source; the final check requires no difference between source output and committed files.
- For native or example behavior, follow [example verification](docs/operations/examples.md). Build both hosts, then run the affected checks against those binaries.
- Window tests connect to applications already running with `--observe --config-dir PATH`, using a disposable configuration directory and project folders. They must not launch applications or independently activate windows. Project-window checks may invoke the application’s project-open command, which creates or focuses windows as specified.
- A recording must include the full gesture at the requested rate. Missing frames or incomplete input is a failure, not a passing measurement.
- Record the tested implementation and platform. Do not use an earlier result to validate later code or describe a test pass as a release.
