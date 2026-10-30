//go:build darwin

package darwin

// The physical footprint of a process and its parts are the ledgers of task_info TASK_VM_INFO (mach/task_info.h of the macOS
// SDK, revision 3), read through the task name port of task_name_for_pid (mach/mach_traps.h), which a process of the same user
// grants. No library of the module reads them: the syscall package has no Mach task interface, and gopsutil reports the
// resident size.

/*
#include <stdint.h>
#include <mach/mach.h>
#include <mach/mach_traps.h>
#include <mach/task_info.h>

// sp_task_vm_info stores TASK_VM_INFO of pid in info and the number of words that task_info returned in count. It returns the
// kern_return_t of the failed call and names it in step: 1 task_name_for_pid, 2 task_info, 3 mach_port_deallocate.
static kern_return_t sp_task_vm_info(int pid, task_vm_info_data_t *info, mach_msg_type_number_t *count, int *step) {
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

static uint32_t sp_task_vm_info_rev3_count(void) { return TASK_VM_INFO_REV3_COUNT; }
*/
import "C"

import (
	"fmt"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
)

// ProcessFootprint returns the physical footprint of the process pid and its ledger parts (KB, each rounded down). The error
// names the failed call and its kern_return_t, which the Rust host also names.
func (implementation) ProcessFootprint(pid int) (platform.ProcessFootprint, error) {
	var info C.task_vm_info_data_t
	var count C.mach_msg_type_number_t
	var step C.int
	if code := C.sp_task_vm_info(C.int(pid), &info, &count, &step); code != C.KERN_SUCCESS {
		call := [...]string{1: "task_name_for_pid", 2: "task_info", 3: "mach_port_deallocate"}[step]
		return platform.ProcessFootprint{}, fmt.Errorf("%s for pid %d: kern_return %d", call, pid, int(code))
	}
	if want := C.sp_task_vm_info_rev3_count(); uint32(count) < uint32(want) {
		return platform.ProcessFootprint{}, fmt.Errorf("task_info for pid %d: %d of %d words", pid, uint32(count), uint32(want))
	}
	// Each ledger is a byte count that the kernel keeps at zero or above; a negative value is reported, not converted.
	ledgers := map[string]int64{
		"phys_footprint": int64(info.phys_footprint), "internal": int64(info.internal), "compressed": int64(info.compressed),
		"ledger_purgeable_nonvolatile": int64(info.ledger_purgeable_nonvolatile), "ledger_purgeable_novolatile_compressed": int64(info.ledger_purgeable_novolatile_compressed),
		"ledger_tag_graphics_footprint": int64(info.ledger_tag_graphics_footprint), "ledger_tag_graphics_footprint_compressed": int64(info.ledger_tag_graphics_footprint_compressed),
		"ledger_tag_media_footprint": int64(info.ledger_tag_media_footprint), "ledger_tag_media_footprint_compressed": int64(info.ledger_tag_media_footprint_compressed),
		"ledger_tag_network_nonvolatile": int64(info.ledger_tag_network_nonvolatile), "ledger_tag_network_nonvolatile_compressed": int64(info.ledger_tag_network_nonvolatile_compressed),
		"ledger_tag_neural_footprint": int64(info.ledger_tag_neural_footprint), "ledger_tag_neural_footprint_compressed": int64(info.ledger_tag_neural_footprint_compressed),
	}
	for _, name := range ledgerOrder {
		if ledgers[name] < 0 {
			return platform.ProcessFootprint{}, fmt.Errorf("task_info for pid %d: %s is %d", pid, name, ledgers[name])
		}
	}
	kb := func(names ...string) uint64 {
		var sum uint64
		for _, name := range names {
			sum += uint64(ledgers[name])
		}
		return sum / 1024
	}
	return platform.ProcessFootprint{
		Total:      kb("phys_footprint"),
		Internal:   kb("internal"),
		Compressed: kb("compressed"),
		Purgeable:  kb("ledger_purgeable_nonvolatile", "ledger_purgeable_novolatile_compressed"),
		Graphics:   kb("ledger_tag_graphics_footprint", "ledger_tag_graphics_footprint_compressed"),
		Media:      kb("ledger_tag_media_footprint", "ledger_tag_media_footprint_compressed"),
		Network:    kb("ledger_tag_network_nonvolatile", "ledger_tag_network_nonvolatile_compressed"),
		Neural:     kb("ledger_tag_neural_footprint", "ledger_tag_neural_footprint_compressed"),
	}, nil
}

// ledgerOrder is the order in which ProcessFootprint checks the ledgers, so the first negative ledger names itself in both hosts.
var ledgerOrder = []string{
	"phys_footprint", "internal", "compressed",
	"ledger_purgeable_nonvolatile", "ledger_purgeable_novolatile_compressed",
	"ledger_tag_graphics_footprint", "ledger_tag_graphics_footprint_compressed",
	"ledger_tag_media_footprint", "ledger_tag_media_footprint_compressed",
	"ledger_tag_network_nonvolatile", "ledger_tag_network_nonvolatile_compressed",
	"ledger_tag_neural_footprint", "ledger_tag_neural_footprint_compressed",
}
