#pragma once

#include <stdint.h>

// Returns the Mach kern status. step names a failed call: 1 task_name_for_pid,
// 2 task_info, 3 mach_port_deallocate. count/expected expose short replies.
// On a complete reply, negativeLedger is -1 or the index in the host's ledgerOrder;
// negativeValue preserves that ledger's signed value. A negative ledger leaves
// values unset. Otherwise values contains eight KB counts, rounded down, in
// ProcessFootprint order: total, internal, compressed, purgeable, graphics, media,
// network, neural. Every output pointer is required and borrowed for this call.
int hostProcessFootprint(int pid, uint64_t *values, int *step, uint32_t *count,
    uint32_t *expected, int *negativeLedger, int64_t *negativeValue);
