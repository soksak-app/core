// The heartbeat of the stall watch against a real main run loop: a waiting run loop takes no heartbeat and blocks the watch, a run
// loop that handles an event takes them again, and a run loop that does not turn stays late (docs/spec/logging.md, stalls).
#import <Foundation/Foundation.h>
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

// Runs the main run loop for the time, on a timer far beyond it, because a run loop without a source returns at once.
static void runLoop(double seconds) { CFRunLoopRunInMode(kCFRunLoopDefaultMode, seconds, false); }

static void onWorker(void (^work)(void)) { dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), work); }

// Runs block on the main run loop, from a worker, and wakes it.
static void sendToMain(void (^block)(void)) {
    CFRunLoopPerformBlock(CFRunLoopGetMain(), kCFRunLoopCommonModes, block);
    CFRunLoopWakeUp(CFRunLoopGetMain());
}

int main(void) { @autoreleasepool {
    CFRunLoopTimerRef far = CFRunLoopTimerCreateWithHandler(NULL, CFAbsoluteTimeGetCurrent() + 3600, 0, 0, 0, ^(CFRunLoopTimerRef t) {});
    CFRunLoopAddTimer(CFRunLoopGetMain(), far, kCFRunLoopCommonModes);
    uint64_t now = 0, answered = 0;
    sp_stall_heartbeat(&now, &answered);
    check(answered != 0, @"a heartbeat with no answer yet takes its own time as the reference");

    // The run loop waits, and a thread sends a heartbeat every 50 ms.
    runLoop(0.05);
    uint64_t wakesBefore = sp_observe_count("stall_watch.wakes");
    __block _Atomic int equalTimes = 0;
    dispatch_semaphore_t sent = dispatch_semaphore_create(0);
    onWorker(^{
        usleep(100000);
        for (int i = 0; i < 16; i++) {
            uint64_t a = 0, b = 0;
            sp_stall_heartbeat(&a, &b);
            if (a == b) atomic_fetch_add(&equalTimes, 1);
            usleep(50000);
        }
        dispatch_semaphore_signal(sent);
    });
    runLoop(1.1);
    dispatch_semaphore_wait(sent, DISPATCH_TIME_FOREVER);
    uint64_t wakes = sp_observe_count("stall_watch.wakes") - wakesBefore;
    check(wakes <= 1, [NSString stringWithFormat:@"16 heartbeats wake a waiting run loop %llu times, at most the end of the run", (unsigned long long)wakes]);
    check(atomic_load(&equalTimes) == 16, [NSString stringWithFormat:@"%d of 16 heartbeats read no lateness in a wait", atomic_load(&equalTimes)]);

    // A watch blocks for as long as the run loop waits, and it returns while the run loop handles an event, which holds until it
    // does. After the 1.2 s of the wait the wake is the reference, so a heartbeat is not late.
    __block _Atomic uint64_t awaitStarted = 0;
    __block _Atomic uint64_t heldAt = 0;
    __block _Atomic long heldUntilAwake = 0;
    __block uint64_t afterWakeNow = 0, afterWakeAnswered = 0;
    __block _Atomic uint64_t returnedAt = 0;
    dispatch_semaphore_t watchReturned = dispatch_semaphore_create(0);
    dispatch_semaphore_t finished = dispatch_semaphore_create(0);
    onWorker(^{
        usleep(100000);
        atomic_store(&awaitStarted, sp_mono_ns());
        sp_stall_await_awake();
        atomic_store(&returnedAt, sp_mono_ns());
        sp_stall_heartbeat(&afterWakeNow, &afterWakeAnswered);
        dispatch_semaphore_signal(watchReturned);
        dispatch_semaphore_signal(finished);
    });
    onWorker(^{
        usleep(1200000);
        sendToMain(^{
            atomic_store(&heldAt, sp_mono_ns());
            atomic_store(&heldUntilAwake, dispatch_semaphore_wait(watchReturned, dispatch_time(DISPATCH_TIME_NOW, 20 * NSEC_PER_SEC)));
        });
    });
    runLoop(1.6);
    dispatch_semaphore_wait(finished, DISPATCH_TIME_FOREVER);
    check(atomic_load(&heldUntilAwake) == 0, @"the watch returns while the run loop handles an event");
    check(atomic_load(&heldAt) != 0 && atomic_load(&returnedAt) >= atomic_load(&heldAt) - 5000000,
        [NSString stringWithFormat:@"the watch blocks for the %.1f ms of the wait", milliseconds(atomic_load(&returnedAt) - atomic_load(&awaitStarted))]);
    check(milliseconds(afterWakeNow - afterWakeAnswered) < 1000,
        [NSString stringWithFormat:@"the first heartbeat after a wait of 1.2 s is %.1f ms late", milliseconds(afterWakeNow - afterWakeAnswered)]);

    // A run loop that handles an event does not turn: heartbeats go on and grow late, and they end when it turns again.
    __block uint64_t heldNow = 0, heldAnswered = 0, endNow = 0, endAnswered = 0;
    dispatch_semaphore_t held = dispatch_semaphore_create(0);
    onWorker(^{
        usleep(100000);
        sendToMain(^{ usleep(1400000); });
        usleep(1300000);
        sp_stall_heartbeat(&heldNow, &heldAnswered);
        usleep(600000);
        sp_stall_heartbeat(&endNow, &endAnswered);
        dispatch_semaphore_signal(held);
    });
    runLoop(2.3);
    dispatch_semaphore_wait(held, DISPATCH_TIME_FOREVER);
    check(milliseconds(heldNow - heldAnswered) >= 1000,
        [NSString stringWithFormat:@"a heartbeat to a held main thread is %.1f ms late", milliseconds(heldNow - heldAnswered)]);
    check(endAnswered > heldAnswered, @"a heartbeat after the hold reads an answer after its start");
    check(endNow == endAnswered, @"the run loop waits again and the heartbeat reads no lateness");

    // A commit of Core Animation runs before the wait, so an observer that holds it holds an awake main thread.
    __block _Atomic int holdCommit = 0;
    sp_observe_run_loop("stall_watch_test.commit", SP_OBSERVE_COUNT, CFRunLoopGetMain(), kCFRunLoopBeforeWaiting, true, 2000000, ^{
        if (atomic_exchange(&holdCommit, 0)) usleep(1300000);
    });
    __block uint64_t commitNow = 0, commitAnswered = 0;
    dispatch_semaphore_t committed = dispatch_semaphore_create(0);
    onWorker(^{
        usleep(100000);
        atomic_store(&holdCommit, 1);
        sendToMain(^{});
        usleep(1200000);
        sp_stall_heartbeat(&commitNow, &commitAnswered);
        dispatch_semaphore_signal(committed);
    });
    runLoop(1.8);
    dispatch_semaphore_wait(committed, DISPATCH_TIME_FOREVER);
    check(milliseconds(commitNow - commitAnswered) >= 1000,
        [NSString stringWithFormat:@"a heartbeat during a held commit before the wait is %.1f ms late", milliseconds(commitNow - commitAnswered)]);

    CFRunLoopRemoveTimer(CFRunLoopGetMain(), far, kCFRunLoopCommonModes);
    CFRelease(far);
    return failures == 0 ? 0 : 1;
}}
