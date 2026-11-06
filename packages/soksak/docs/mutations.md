# Mutation checks

[한국어](mutations.ko.md)

`pnpm check-breaks` requires each declared defect in `scripts/breaks.mjs` to be detected. A defect must match exactly one location. `pnpm mutate` explores operator substitutions and reports survivors; a survivor is a failing result only in the required check.

Both commands run in a disposable copy, leave the original package unchanged, and require the selected tests to pass before applying any defect. Node test acceptance uses the shared executed-test evidence: an empty file, a skipped test or a todo cannot establish a passing baseline. Each command runs a test file in its own process group, ends that group on a deadline or cancellation, and removes the copied package afterward.

Every execution retains standard output, standard error and a JSON result with the command outcome, elapsed time and test evidence. The command prints the evidence directory. `SOKSAK_MUTATION_RUN_FOLDER` selects its existing parent directory; otherwise the system temporary directory is used. Evidence is outside the disposable package and survives its cleanup. A final summary records the measured mutations and their outcomes.

| Classification | Meaning for a mutation |
| --- | --- |
| `passed` | The selected tests passed; the mutation survived. |
| `assertion-failure` | A test assertion detected the mutation. |
| `runtime-failure` | The mutation caused a test process or runtime failure. |
| `mutant-timeout` | The mutation reached its execution deadline. |
| `environment-error` | The command could not start, required dependencies or execution evidence were unavailable, or the experiment was interrupted. This is not mutation detection. |

A baseline accepts only `passed`. A required mutation accepts assertion failure, runtime failure or a mutant timeout and fails on a survivor, stale or ambiguous edit, or environment error. Exploratory runs stop on environment errors rather than counting them toward the score. The output and JSON record distinguish a deadline from cancellation or loss of the supervising process. A termination signal with no recorded supervisor cause is an environment error because it does not identify who ended the process; a source syntax error or thrown runtime error remains valid detection.
