#pragma once

// Included only by cgo bootstrap bindings, never by the native fixture implementation.
// These getters resolve the actual production object's functions without copying its state.
#include <stdint.h>
#include "stall_watch.h"

static inline uintptr_t sp_host_test_production_stall_counts_address(void) {
    return (uintptr_t)sp_stall_counts;
}
static inline uintptr_t sp_host_test_production_stall_setter_address(void) {
    return (uintptr_t)sp_stall_set_send_in_next_wait_for_test;
}
