//go:build darwin

package darwin

// The physical footprint of a process is ri_phys_footprint of proc_pid_rusage (libproc.h of the macOS SDK, RUSAGE_INFO_V0). No
// library of the module reads it: the syscall package has no libproc interface, and gopsutil reports the resident size.

/*
#include <errno.h>
#include <stdint.h>
#include <libproc.h>
#include <sys/resource.h>

// sp_phys_footprint stores the physical footprint (bytes) of pid in footprint. It returns errno when proc_pid_rusage fails.
static int sp_phys_footprint(int pid, uint64_t *footprint) {
	struct rusage_info_v0 info;
	if (proc_pid_rusage(pid, RUSAGE_INFO_V0, (rusage_info_t *)&info) != 0) {
		return errno;
	}
	*footprint = info.ri_phys_footprint;
	return 0;
}
*/
import "C"

import "fmt"

// ProcessFootprintKB returns the physical footprint (KB) of the process pid, rounded down. The error names the errno number,
// which the Rust host also names.
func (implementation) ProcessFootprintKB(pid int) (uint64, error) {
	var footprint C.uint64_t
	if code := C.sp_phys_footprint(C.int(pid), &footprint); code != 0 {
		return 0, fmt.Errorf("proc_pid_rusage for pid %d: errno %d", pid, code)
	}
	return uint64(footprint) / 1024, nil
}
