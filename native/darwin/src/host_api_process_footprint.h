#pragma once

#include <stdbool.h>
#include <stdint.h>

// Converts the thirteen signed TASK_VM_INFO revision-three byte ledgers in this fixed SDK order:
// phys_footprint, internal, compressed, ledger_purgeable_nonvolatile,
// ledger_purgeable_novolatile_compressed, ledger_tag_graphics_footprint,
// ledger_tag_graphics_footprint_compressed, ledger_tag_media_footprint,
// ledger_tag_media_footprint_compressed, ledger_tag_network_nonvolatile,
// ledger_tag_network_nonvolatile_compressed, ledger_tag_neural_footprint,
// ledger_tag_neural_footprint_compressed.
// Every pointer is required and borrowed. The first negative ledger returns false, names its exact
// zero-based index/value and leaves all eight values unchanged. Success clears negative metadata
// (-1, 0) and returns the eight KB values in ProcessFootprint order, rounding each pair after summing.
// Both operands are converted to unsigned before addition, so two valid INT64_MAX ledgers are supported.
bool hostProcessFootprintValues(const int64_t *ledgers, uint64_t *values,
    int *negativeLedger, int64_t *negativeValue);

// Returns the Mach kern status. step names a failed call: 1 task_name_for_pid,
// 2 task_info, 3 mach_port_deallocate. count/expected expose short replies.
// On a complete reply, negativeLedger is -1 or the index in the host's ledgerOrder;
// negativeValue preserves that ledger's signed value. A negative ledger leaves
// values unset. Otherwise values contains eight KB counts, rounded down, in
// ProcessFootprint order: total, internal, compressed, purgeable, graphics, media,
// network, neural. Every output pointer is required and borrowed for this call.
int hostProcessFootprint(int pid, uint64_t *values, int *step, uint32_t *count,
    uint32_t *expected, int *negativeLedger, int64_t *negativeValue);
