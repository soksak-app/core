//go:build darwin

package darwin

// The heartbeat and the sample of a stall of the host on macOS: a C function on the main thread answers the heartbeat, and the
// system tool `sample` writes the stacks of every thread of this process.

/*
#include <stdatomic.h>
#include <stdint.h>
#include <CoreFoundation/CoreFoundation.h>
#include "event_ring.h"

// The time of the last answered heartbeat on the clock of sp_mono_ns, or of the first heartbeat while none was answered.
static _Atomic uint64_t stallAnswered;

// stallHeartbeat schedules the answer on the main run loop in the common modes, so a modal dialog, a menu or a drag does not
// hold it back while the run loop turns. The answer is C, so no Go code runs on the main thread for it.
static void stallHeartbeat(uint64_t *now, uint64_t *answered) {
    uint64_t sent = sp_mono_ns();
    uint64_t none = 0;
    atomic_compare_exchange_strong(&stallAnswered, &none, sent);
    CFRunLoopRef loop = CFRunLoopGetMain();
    CFRunLoopPerformBlock(loop, kCFRunLoopCommonModes, ^{ atomic_store(&stallAnswered, sp_mono_ns()); });
    CFRunLoopWakeUp(loop);
    *now = sent;
    *answered = atomic_load(&stallAnswered);
}
*/
import "C"

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

// SampleThreads writes the stacks of the threads of this process, sampled for one second, into path.
func (implementation) SampleThreads(path string) error {
	output, err := exec.Command("/usr/bin/sample", strconv.Itoa(os.Getpid()), "1", "-file", path).CombinedOutput()
	if err != nil {
		return fmt.Errorf("/usr/bin/sample: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func (implementation) StallHeartbeat() (uint64, uint64) {
	var now, answered C.uint64_t
	C.stallHeartbeat(&now, &answered)
	return uint64(now), uint64(answered)
}
