# Scope of release 0.0.45

This plan fixes which open checklist rows 0.0.45 contains. The rule covers every row, so the release is neither
held by unrelated work nor shipped with partial work.

## Rule

0.0.45 contains:

- the rows already in `main` and marked complete,
- the rows that have a branch in progress now: F914 (gpuikit adapter), F915 and its follow-up F915-1 (discovery
  listing limit), F906-1 (screen message answers), and the F906 row close,
- the rows that CI needs in order to pass the release gate.

Every other open row stays open, unchanged, for 0.0.46 and later.

## Reason

The checklist has 225 open rows on `main`. Requiring all of them before a release would prevent every release. The
rows named above have active branches or are needed for the gate, so they can close in this release. Each row
remains a separate checklist item, and its completion follows its own Red and Green evidence.
