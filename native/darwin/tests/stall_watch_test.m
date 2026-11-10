// The heartbeat of the stall watch against a real main run loop: a waiting run loop takes no heartbeat and blocks the watch, a run
// loop that handles an event takes them again, and a run loop that does not turn stays late (docs/spec/logging.md, stalls). Each
// step waits for the state it checks: a worker starts at the wait of the run loop or at the hold of the main thread, and it ends
// the run of the main run loop when its step is done, so a slow schedule of the threads changes no result.
#import <Foundation/Foundation.h>
#include <limits.h>
#include <stdatomic.h>
#include <unistd.h>
#include "event_ring.h"
#include "observe.h"
#include "stall_watch.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static double milliseconds(uint64_t nanos) { return (double)nanos / 1e6; }

// Runs the main run loop until a worker stops it with CFRunLoopStop, and reports whether it did. A timer far beyond the run keeps
// the run loop from returning at once without a source. The run has no limit of its own: the limit of the case ends a run that
// no worker stops.
static BOOL runUntilStopped(void) { return CFRunLoopRunInMode(kCFRunLoopDefaultMode, 1.0e10, false) == kCFRunLoopRunStopped; }

static void onWorker(void (^work)(void)) { dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), work); }

// Runs block on the main run loop, from a worker, and wakes it.
static void sendToMain(void (^block)(void)) {
    CFRunLoopPerformBlock(CFRunLoopGetMain(), kCFRunLoopCommonModes, block);
    CFRunLoopWakeUp(CFRunLoopGetMain());
}

static void stopMain(void) { CFRunLoopStop(CFRunLoopGetMain()); }

// waitStarted is signaled at the first start of a wait of the main run loop after waitArmed is set. Its observer has the order of
// the observer of the watch that marks the wait and is added after it, and the run loop runs observers of one order in the order
// they were added, so a heartbeat after the signal reads the wait.
static _Atomic int waitArmed;
static dispatch_semaphore_t waitStarted;

static void awaitSignal(dispatch_semaphore_t semaphore) { dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER); }

int main(void) { @autoreleasepool {
    CFRunLoopTimerRef far = CFRunLoopTimerCreateWithHandler(NULL, CFAbsoluteTimeGetCurrent() + 3600, 0, 0, 0, ^(CFRunLoopTimerRef t) {});
    CFRunLoopAddTimer(CFRunLoopGetMain(), far, kCFRunLoopCommonModes);
    uint64_t now = 0, answered = 0;
    sp_stall_heartbeat(&now, &answered);
    check(answered != 0, @"a heartbeat with no answer yet takes its own time as the reference");
    waitStarted = dispatch_semaphore_create(0);
    sp_observe_run_loop("stall_watch_test.waits", SP_OBSERVE_COUNT, CFRunLoopGetMain(), kCFRunLoopBeforeWaiting, true, LONG_MAX, ^{
        if (atomic_exchange(&waitArmed, 0)) dispatch_semaphore_signal(waitStarted);
    });

    // The run loop waits, and a thread sends 16 heartbeats from the start of the wait. The stop of the run is its one wake, and the
    // count of wakes is read after it, so a wake that a heartbeat caused is counted.
    uint64_t wakesBefore = sp_observe_count("stall_watch.wakes");
    uint64_t sentBefore = 0, sentInWaitBefore = 0, answeredBefore = 0;
    sp_stall_counts(&sentBefore, &sentInWaitBefore, &answeredBefore);
    __block _Atomic int equalTimes = 0;
    atomic_store(&waitArmed, 1);
    onWorker(^{
        awaitSignal(waitStarted);
        for (int i = 0; i < 16; i++) {
            uint64_t a = 0, b = 0;
            sp_stall_heartbeat(&a, &b);
            if (a == b) atomic_fetch_add(&equalTimes, 1);
        }
        stopMain();
    });
    check(runUntilStopped(), @"the heartbeats in a wait end with the stop of the run");
    uint64_t wakes = sp_observe_count("stall_watch.wakes") - wakesBefore;
    check(wakes <= 1, [NSString stringWithFormat:@"16 heartbeats wake a waiting run loop %llu times, at most the end of the run", (unsigned long long)wakes]);
    check(atomic_load(&equalTimes) == 16, [NSString stringWithFormat:@"%d of 16 heartbeats read no lateness in a wait", atomic_load(&equalTimes)]);
    uint64_t sentAfter = 0, sentInWaitAfter = 0, answeredAfter = 0;
    sp_stall_counts(&sentAfter, &sentInWaitAfter, &answeredAfter);
    check(sentAfter == sentBefore && sentInWaitAfter == sentInWaitBefore,
        [NSString stringWithFormat:@"16 heartbeats in a wait send nothing, got %llu sent and %llu sent into a wait",
            (unsigned long long)(sentAfter - sentBefore), (unsigned long long)(sentInWaitAfter - sentInWaitBefore)]);

    // A watch blocks for as long as the run loop waits, and it returns while the run loop handles an event, which holds until it
    // does. No event tells that the watch is blocked inside sp_stall_await_awake, so the sender of the event pauses 1.2 s after the
    // call of the watch to send it after the watch blocked. After the wait the wake is the reference, so a heartbeat reads an
    // answer at or after the send and not the start of the wait.
    __block _Atomic uint64_t awaitStarted = 0;
    __block _Atomic uint64_t sentAt = 0;
    __block _Atomic long heldUntilAwake = -1;
    __block uint64_t afterWakeNow = 0, afterWakeAnswered = 0;
    __block _Atomic uint64_t returnedAt = 0;
    dispatch_semaphore_t awaiting = dispatch_semaphore_create(0);
    dispatch_semaphore_t watchReturned = dispatch_semaphore_create(0);
    atomic_store(&waitArmed, 1);
    onWorker(^{
        awaitSignal(waitStarted);
        atomic_store(&awaitStarted, sp_mono_ns());
        dispatch_semaphore_signal(awaiting);
        sp_stall_await_awake();
        atomic_store(&returnedAt, sp_mono_ns());
        sp_stall_heartbeat(&afterWakeNow, &afterWakeAnswered);
        dispatch_semaphore_signal(watchReturned);
        stopMain();
    });
    onWorker(^{
        awaitSignal(awaiting);
        usleep(1200000);
        atomic_store(&sentAt, sp_mono_ns());
        sendToMain(^{
            atomic_store(&heldUntilAwake, dispatch_semaphore_wait(watchReturned, DISPATCH_TIME_FOREVER));
        });
    });
    check(runUntilStopped(), @"the wait of the watch ends with the stop of the run");
    check(atomic_load(&heldUntilAwake) == 0, @"the watch returns while the run loop handles an event");
    check(atomic_load(&sentAt) != 0 && atomic_load(&returnedAt) >= atomic_load(&sentAt),
        [NSString stringWithFormat:@"the watch blocks for the %.1f ms of the wait", milliseconds(atomic_load(&returnedAt) - atomic_load(&awaitStarted))]);
    check(afterWakeAnswered >= atomic_load(&sentAt) && afterWakeNow >= afterWakeAnswered,
        [NSString stringWithFormat:@"the first heartbeat after a wait reads the wake as its answer, %.1f ms after the send, and is %.1f ms late",
            milliseconds(afterWakeAnswered - atomic_load(&sentAt)), milliseconds(afterWakeNow - afterWakeAnswered)]);

    // A run loop that handles an event does not turn: a heartbeat during the hold reads the last answer from before the hold, so
    // its lateness is the whole hold until it, and when the run loop waits again a heartbeat reads an answer after the hold and
    // no lateness.
    __block uint64_t heldNow = 0, heldAnswered = 0, endNow = 0, endAnswered = 0;
    __block _Atomic uint64_t holdStarted = 0;
    __block _Atomic long heldUntilBeat = -1;
    dispatch_semaphore_t holding = dispatch_semaphore_create(0);
    dispatch_semaphore_t released = dispatch_semaphore_create(0);
    atomic_store(&waitArmed, 1);
    onWorker(^{
        awaitSignal(waitStarted);
        sendToMain(^{
            atomic_store(&holdStarted, sp_mono_ns());
            dispatch_semaphore_signal(holding);
            atomic_store(&heldUntilBeat, dispatch_semaphore_wait(released, DISPATCH_TIME_FOREVER));
        });
        awaitSignal(holding);
        sp_stall_heartbeat(&heldNow, &heldAnswered);
        atomic_store(&waitArmed, 1);
        dispatch_semaphore_signal(released);
        awaitSignal(waitStarted);
        sp_stall_heartbeat(&endNow, &endAnswered);
        stopMain();
    });
    check(runUntilStopped(), @"the hold of the main thread ends with the stop of the run");
    check(atomic_load(&heldUntilBeat) == 0, @"the main thread is held until the heartbeat during the hold");
    check(heldAnswered <= atomic_load(&holdStarted) && heldNow >= atomic_load(&holdStarted),
        [NSString stringWithFormat:@"a heartbeat to a held main thread reads the answer from before the hold and is %.1f ms late",
            milliseconds(heldNow - heldAnswered)]);
    check(endAnswered > heldAnswered, @"a heartbeat after the hold reads an answer after its start");
    check(endNow == endAnswered, @"the run loop waits again and the heartbeat reads no lateness");

    // A commit of Core Animation runs before the wait, so an observer that holds it holds an awake main thread.
    __block _Atomic int holdCommit = 0;
    __block _Atomic long commitHeldUntilBeat = -1;
    __block _Atomic uint64_t commitHoldStarted = 0;
    dispatch_semaphore_t commitHeld = dispatch_semaphore_create(0);
    dispatch_semaphore_t commitReleased = dispatch_semaphore_create(0);
    sp_observe_run_loop("stall_watch_test.commit", SP_OBSERVE_COUNT, CFRunLoopGetMain(), kCFRunLoopBeforeWaiting, true, 2000000, ^{
        if (!atomic_exchange(&holdCommit, 0)) return;
        atomic_store(&commitHoldStarted, sp_mono_ns());
        dispatch_semaphore_signal(commitHeld);
        atomic_store(&commitHeldUntilBeat, dispatch_semaphore_wait(commitReleased, DISPATCH_TIME_FOREVER));
    });
    __block uint64_t commitNow = 0, commitAnswered = 0;
    atomic_store(&waitArmed, 1);
    onWorker(^{
        awaitSignal(waitStarted);
        atomic_store(&holdCommit, 1);
        sendToMain(^{});
        awaitSignal(commitHeld);
        sp_stall_heartbeat(&commitNow, &commitAnswered);
        dispatch_semaphore_signal(commitReleased);
        stopMain();
    });
    check(runUntilStopped(), @"the held commit ends with the stop of the run");
    check(atomic_load(&commitHeldUntilBeat) == 0, @"the commit is held until the heartbeat during the hold");
    check(commitAnswered <= atomic_load(&commitHoldStarted) && commitNow >= atomic_load(&commitHoldStarted),
        [NSString stringWithFormat:@"a heartbeat during a held commit before the wait reads the answer from before the hold and is %.1f ms late",
            milliseconds(commitNow - commitAnswered)]);

    // The fault injection of a watch that does not block through a wait: its send into the wait is counted, and its block wakes
    // the run loop and runs.
    uint64_t faultWakesBefore = sp_observe_count("stall_watch.wakes");
    uint64_t faultSentBefore = 0, faultSentInWaitBefore = 0, faultAnsweredBefore = 0;
    sp_stall_counts(&faultSentBefore, &faultSentInWaitBefore, &faultAnsweredBefore);
    atomic_store(&waitArmed, 1);
    onWorker(^{
        awaitSignal(waitStarted);
        // Armed while the run loop waits, the signal comes from the first wait after the wake that the injected send causes, and
        // the run ends there.
        atomic_store(&waitArmed, 1);
        sp_stall_set_send_in_next_wait_for_test(true);
        sp_stall_await_awake();
        awaitSignal(waitStarted);
        stopMain();
    });
    check(runUntilStopped(), @"the injected send ends with the stop of the run");
    uint64_t faultSentAfter = 0, faultSentInWait = 0, faultAnswered = 0;
    sp_stall_counts(&faultSentAfter, &faultSentInWait, &faultAnswered);
    check(faultSentInWait - faultSentInWaitBefore == 1 && faultSentAfter - faultSentBefore == 1,
        [NSString stringWithFormat:@"the injected send into a wait is counted once, got %llu sent and %llu sent into a wait",
            (unsigned long long)(faultSentAfter - faultSentBefore), (unsigned long long)(faultSentInWait - faultSentInWaitBefore)]);
    check(faultAnswered - faultAnsweredBefore == 1 && sp_observe_count("stall_watch.wakes") > faultWakesBefore,
        [NSString stringWithFormat:@"the injected send wakes the run loop and its block runs, got %llu blocks and %llu wakes",
            (unsigned long long)(faultAnswered - faultAnsweredBefore),
            (unsigned long long)(sp_observe_count("stall_watch.wakes") - faultWakesBefore)]);

    CFRunLoopRemoveTimer(CFRunLoopGetMain(), far, kCFRunLoopCommonModes);
    CFRelease(far);
    return failures == 0 ? 0 : 1;
}}
