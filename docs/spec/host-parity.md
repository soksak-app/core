# Host parity

[한국어](host-parity.ko.md)

The two application hosts (`tauriv2`, `wailsv3`) implement the same product. Parity between them is not a review opinion: `make host-parity-check` (`scripts/check-host-parity.mjs`) decides each proposition below; it reads both hosts' sources and fails on any difference. A legitimate difference does not relax a proposition; it is a change to the proposition itself, made in this document together with the correction.

## Propositions

1. **Public bindings are the same set.** The page-facing command surface each host registers — Rust `generate_handler!` names and exported `Host` methods in Go, compared in snake case — is one set. A command that exists on one host and not the other fails the check.
2. **Endpoint methods are the same set.** The local [endpoint](endpoint.md) method names each build declares — base methods, subscription methods, and the diagnostics-only additions — are one set for both hosts in the same build flavor.
3. **The application menu is the declared contract.** Both hosts' menu bars contain the same items in the same order with the same shortcuts, per the menu contract table in [host contract](host-contract.md). The check runs against running hosts and enumerates the real menu bars; an item present on one host and missing on the other fails.
4. **A single-host exemption must still be true.** Every `<host> only: <reason>` row in the host contract's case table cites a difference that observation must still confirm. When the cited difference no longer holds, the exemption is stale and the check fails until the case becomes `both`.
5. **Tests live where their functionality lives, at one level for every language.** Production folders carry their owning tests in the same tree, and every language's suites run in the same gate. The check compares folder-by-folder and gate-by-gate; a language wired lower than another, or a test clustered away from its owner, fails.

The check's output is the difference report. Corrections run Red (the check fails on the unfixed tree) and Green (the check passes after the change) through the same tool.
