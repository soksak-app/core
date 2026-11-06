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

## Changed owners

`node scripts/check-breaks.mjs --changed <base>...<head>` selects the required defects and owning test files declared in `scripts/required-breaks.mjs`. A source change selects that implementation owner. A change to a named owning test selects its owners; shared tests, mutation scripts, layout contracts and shared build inputs select the complete required set. Unrelated packages select nothing, and a new implementation source without a required owner is an error. The first push without a previous tree selects from the current tree. `--required` runs the complete bounded set locally; the unfiltered command still runs the full declared defect inventory.

The required set contains at most eight defects and at most three test files per owner. Every selected test must first pass in one immutable package copy. Each defect then runs only its declared tests in a separate copy of that baseline, so an edit of the live checkout cannot change the tested input halfway through the experiment. A surviving required defect, invalid execution evidence or failing baseline refuses the gate.

The `core-node` CI job runs this selection after its package build and tests, using both revisions of the push or pull request. The existing required-job gate includes that result. Standard output, standard error and result records are retained as the `required-mutation-evidence` artifact, including successful detection; an unrelated change creates no mutation artifact. This gate establishes detection of the selected declared defects, not a complete exploratory mutation score or application acceptance.
