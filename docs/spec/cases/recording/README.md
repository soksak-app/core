# Recording state cases

`decisions.json` is the case table of the decisions that the state of a diagnostic recording takes from the answers of its recorder and of the filesystem ([host contract](../../host-contract.md), the cases `recording.*`). The Go host (`packages/host/go/tests/recording_test.go`) and the Rust host (`packages/host/rust/tests/recording_test.rs`) replay the same table, so both hosts decide and report the same texts.

Each list names one decision function of the host:

| List | Function (Go / Rust) | Input | Result |
| --- | --- | --- | --- |
| `refuseStart` | `RefuseStart` / `refuse_start` | the folder that a recording or its cleanup owns | the refusal text, null for no owner |
| `refuseFinish` | `RefuseFinish` / `refuse_finish` | the owned folder and whether the native recording ended | the refusal text, null when the recording can end |
| `needsStop` | `NeedsStop` / `needs_stop` | the owned folder and whether the native recording ended | whether an abort stops the recording |
| `stopFailure` | `StopFailure` / `stop_failure` | the error of a failed stop | the reported text |
| `settleCleanup` | `SettleCleanup` / `settle_cleanup` | the error that led to the removal (`cause`, null for none) and the removal error (`removal`, null for a removal that succeeded) | whether the recording keeps the folder (`retainOwner`) and the reported text (`error`) |

The recorder itself gives the answers, and it needs the images of a window of a display, so `e2e/capture-state.test.mjs` judges it in the end-to-end tier. The removal error of a case is the text that the filesystem gives; the host tests also judge the same functions with the removal error of the real filesystem, which refuses to remove a folder whose permissions were removed.
