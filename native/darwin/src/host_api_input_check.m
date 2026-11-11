// Native implementation of the host binding helpers of the drive of a window by a check (diagnostics.drag).
#include "host_api_input_check.h"

#include <stdbool.h>
#include <stdint.h>
#include "input_check.h"
#include "main_thread.h"

// The native calls run on the main thread (main_thread.h).
bool main_sp_input_check_begin(uintptr_t window) {
    return ON_MAIN(bool, sp_input_check_begin((void *)window));
}

uint64_t main_sp_input_check_end(uintptr_t window) {
    return ON_MAIN(uint64_t, sp_input_check_end((void *)window));
}
