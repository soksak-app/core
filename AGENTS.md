# AGENTS.md

`soksak` is a headless layout library. One plane holds cards, and a card carries an id, its
slots, an optional px size and whatever payload the host attaches. It owns the arrangement and
nothing else: no DOM policy, no application state, no styling. Tabs are the example's model, not
the library's.

- [`README.md`](README.md) — the library: rules, model, API
- [`examples/README.md`](examples/README.md) — the example product and how to build it

The library's code comments are English. The example's are Korean, because the example is read
by this project's owner. Identifiers, log lines, error messages and test names are English
everywhere.
Documents use one English canonical and a Korean translation at the matching `.ko.md` path.

## Writing

This applies to commit messages, code comments and documents, in both languages.

- Name the action, the subject and the object: create, publish, receive, register, remove,
  return, fail.
- State a cause in one sentence.
- Use no metaphor, no personification and no colloquialism.
- The Korean and the English carry the same information.

A commit message carries no trailer: no `Co-Authored-By`, no session link, no "Generated with".
