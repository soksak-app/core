// The heartbeat of the stall watch of a host and the state of the main run loop that it reads (docs/spec/logging.md, stalls). A
// run loop that waits for an event cannot be stalled, so a watch sends it no heartbeat and does not wake it. The functions run on
// the thread of the watch; two observers on the main run loop write the state, and no code of a host runs on the main thread for
// it. The first call of either function installs the observers.
#pragma once

#include <stdbool.h>
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

// The counts of the heartbeats since the start of the process: those that sent their block to the main thread, those whose wake
// reached a run loop that waited, and the blocks that ran. A test reads them to state that the watch sent nothing through a wait.
void sp_stall_counts(uint64_t *sent, uint64_t *sent_in_wait, uint64_t *answered);

// The fault injection of the checks: while it is set, the next sp_stall_await_awake that finds the run loop waiting sends a heartbeat
// into that wait and returns instead of blocking, as a watch that does not block through a wait does, and clears it.
void sp_stall_set_send_in_next_wait_for_test(bool send);

// The hook of the checks that hears that a thread blocks in sp_stall_await_awake, which no event of the system tells: the thread
// calls it each time it is counted as blocked, before it blocks, so a wake from then on ends that block. NULL removes it.
void sp_stall_set_blocked_hook_for_test(void (*blocked)(void));
