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
