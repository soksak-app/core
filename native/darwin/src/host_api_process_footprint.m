#include "host_api_process_footprint.h"

#include <mach/mach.h>
#include <mach/mach_traps.h>
#include <mach/task_info.h>

// Keep the Mach record and its revision entirely inside the native boundary.
static kern_return_t taskVMInfo(int pid, task_vm_info_data_t *info,
    mach_msg_type_number_t *count, int *step) {
    mach_port_name_t name = MACH_PORT_NULL;
    kern_return_t code = task_name_for_pid(mach_task_self(), pid, &name);
    if (code != KERN_SUCCESS) {
        *step = 1;
        return code;
    }
    *count = TASK_VM_INFO_REV3_COUNT;
    code = task_info(name, TASK_VM_INFO, (task_info_t)info, count);
    kern_return_t released = mach_port_deallocate(mach_task_self(), name);
    if (code != KERN_SUCCESS) {
        *step = 2;
        return code;
    }
    if (released != KERN_SUCCESS) {
        *step = 3;
        return released;
    }
    return KERN_SUCCESS;
}

int hostProcessFootprint(int pid, uint64_t *values, int *step, uint32_t *count,
    uint32_t *expected, int *negativeLedger, int64_t *negativeValue) {
    *step = 0;
    *count = 0;
    *expected = TASK_VM_INFO_REV3_COUNT;
    *negativeLedger = -1;
    *negativeValue = 0;
    task_vm_info_data_t info = {0};
    mach_msg_type_number_t words = 0;
    kern_return_t code = taskVMInfo(pid, &info, &words, step);
    *count = words;
    if (code != KERN_SUCCESS || words < TASK_VM_INFO_REV3_COUNT) return code;

    // This order matches ledgerOrder in the Go platform and the Rust host.
    const int64_t ledgers[] = {
        (int64_t)info.phys_footprint, (int64_t)info.internal, (int64_t)info.compressed,
        (int64_t)info.ledger_purgeable_nonvolatile,
        (int64_t)info.ledger_purgeable_novolatile_compressed,
        (int64_t)info.ledger_tag_graphics_footprint,
        (int64_t)info.ledger_tag_graphics_footprint_compressed,
        (int64_t)info.ledger_tag_media_footprint,
        (int64_t)info.ledger_tag_media_footprint_compressed,
        (int64_t)info.ledger_tag_network_nonvolatile,
        (int64_t)info.ledger_tag_network_nonvolatile_compressed,
        (int64_t)info.ledger_tag_neural_footprint,
        (int64_t)info.ledger_tag_neural_footprint_compressed,
    };
    for (int index = 0; index < 13; index++) {
        if (ledgers[index] < 0) {
            *negativeLedger = index;
            *negativeValue = ledgers[index];
            return KERN_SUCCESS;
        }
    }
    values[0] = (uint64_t)ledgers[0] / 1024;
    values[1] = (uint64_t)ledgers[1] / 1024;
    values[2] = (uint64_t)ledgers[2] / 1024;
    for (int index = 3; index < 8; index++) {
        int first = 3 + (index - 3) * 2;
        values[index] = ((uint64_t)ledgers[first] + (uint64_t)ledgers[first + 1]) / 1024;
    }
    return KERN_SUCCESS;
}
