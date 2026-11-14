#pragma once

// Included only by cgo bootstrap bindings, never by the native fixture implementation.
// These getters resolve the actual production object's functions without copying its state: the stall functions and the functions
// that sp_host_test_install_production_functions takes.
#include <stdint.h>
#include "document_view.h"
#include "event_ring.h"
#include "image_region.h"
#include "stall_watch.h"

// surface_layout.h declares Objective-C types, which the C of a cgo preamble cannot read, so the two key wait functions of
// native/darwin/src/surface_layout.m are declared here with the signatures of that header.
bool surfaceLayoutKeysWaitState(void *owner, bool *decision, bool *modal);
void surfaceLayoutKeysWaitOpen(void *owner, bool decision);

static inline uintptr_t sp_host_test_production_stall_counts_address(void) {
    return (uintptr_t)sp_stall_counts;
}
static inline uintptr_t sp_host_test_production_stall_setter_address(void) {
    return (uintptr_t)sp_stall_set_send_in_next_wait_for_test;
}
static inline uintptr_t sp_host_test_production_keys_wait_state_address(void) {
    return (uintptr_t)surfaceLayoutKeysWaitState;
}
static inline uintptr_t sp_host_test_production_keys_wait_open_address(void) {
    return (uintptr_t)surfaceLayoutKeysWaitOpen;
}
static inline uintptr_t sp_host_test_production_region_raster_address(void) {
    return (uintptr_t)sp_region_raster;
}
static inline uintptr_t sp_host_test_production_region_present_address(void) {
    return (uintptr_t)sp_region_present;
}
static inline uintptr_t sp_host_test_production_event_address(void) {
    return (uintptr_t)sp_event;
}
static inline uintptr_t sp_host_test_production_store_close_address(void) {
    return (uintptr_t)sp_document_store_close;
}
