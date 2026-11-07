//go:build darwin

package darwin

// The physical footprint of a process and its parts are the ledgers of task_info TASK_VM_INFO (mach/task_info.h of the macOS
// SDK, revision 3), read through the task name port of task_name_for_pid (mach/mach_traps.h), which a process of the same user
// grants. No library of the module reads them: the syscall package has no Mach task interface, and gopsutil reports the
// resident size.

import (
	"fmt"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// ProcessFootprint returns the physical footprint of the process pid and its ledger parts (KB, each rounded down). The error
// names the failed call and its kern_return_t, which the Rust host also names.
func (implementation) ProcessFootprint(pid int) (platform.ProcessFootprint, error) {
	var values [8]uint64
	var step, negativeLedger int32
	var count, expected uint32
	var negativeValue int64
	if code := native.HostProcessFootprint(int32(pid), &values[0], &step, &count, &expected, &negativeLedger, &negativeValue); code != 0 {
		call := [...]string{1: "task_name_for_pid", 2: "task_info", 3: "mach_port_deallocate"}[step]
		return platform.ProcessFootprint{}, fmt.Errorf("%s for pid %d: kern_return %d", call, pid, int(code))
	}
	if count < expected {
		return platform.ProcessFootprint{}, fmt.Errorf("task_info for pid %d: %d of %d words", pid, count, expected)
	}
	// Native code checks ledgers in ledgerOrder before producing the eight KB values.
	if negativeLedger >= 0 {
		return platform.ProcessFootprint{}, fmt.Errorf("task_info for pid %d: %s is %d", pid, ledgerOrder[negativeLedger], negativeValue)
	}
	return platform.ProcessFootprint{
		Total: values[0], Internal: values[1], Compressed: values[2], Purgeable: values[3],
		Graphics: values[4], Media: values[5], Network: values[6], Neural: values[7],
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
