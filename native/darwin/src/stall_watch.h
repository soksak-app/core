// The heartbeat of the stall watch of a host and the state of the main run loop that it reads (docs/spec/logging.md, stalls). A
// run loop that waits for an event cannot be stalled, so a watch sends it no heartbeat and does not wake it. The functions run on
// the thread of the watch; two observers on the main run loop write the state, and no code of a host runs on the main thread for
// it. The first call of either function installs the observers.
#pragma once

#include <stdint.h>

// Sends a heartbeat that a C block answers on the main thread, in the common modes, so a modal dialog, a menu or a drag does not
// hold it back while the run loop turns. Both times are on the clock of sp_mono_ns: `now` is the time of the call and `answered`
// the time of the last answer. A wake of the run loop and the start of its wait are answers, because the main thread ran at both;
// while no answer exists, `answered` is the time of the first heartbeat. While the run loop waits this sends nothing and both
// times are the time at which the wait started, so a stall that ended in that wait has its end and no lateness is read.
void sp_stall_heartbeat(uint64_t *now, uint64_t *answered);

// Blocks the calling thread while the main run loop waits for an event, and returns at once while it does not. It takes no timer.
// A wake that ends in the next wait before this thread runs keeps it blocked, because nothing of that turn was late.
void sp_stall_await_awake(void);
