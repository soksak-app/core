// Checks that a count of a closed gate waits before it wakes a writer that sleeps (docs/spec/logging.md#policy). The wait of a count
// and the second between two reports are rules of time, so the check sets them as its inputs: it holds the wake that a count
// schedules and runs it as the end of the wait, and it moves the clock of the report. It does not sleep.
#import <Foundation/Foundation.h>
#include <errno.h>
#include <unistd.h>
#import "event_ring.h"

static int failures;
static void check(BOOL condition, NSString *message) {
    printf("%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// The clock of the report. It starts above zero, because zero is the time of no earlier report.
static const uint64_t oneSecond = 1000000000ull;
static uint64_t reportNow = 1000000000ull;
static uint64_t reportClock(void) { return reportNow; }

// The wake that a count scheduled, with the wait it was scheduled for, until the check runs it.
static void (*scheduledWake)(void);
static uint64_t scheduledWait;
static int schedules;
static void holdWake(uint64_t waitNs, void (*wake)(void)) {
    scheduledWake = wake;
    scheduledWait = waitNs;
    schedules++;
}

// The end of the wait of a count: the wake that the gate scheduled runs now. A wait that no count scheduled is a failure.
static void endWait(void) {
    void (*wake)(void) = scheduledWake;
    scheduledWake = NULL;
    check(wake != NULL, @"a wake was scheduled for the end of the wait");
    if (wake) wake();
}

int main(void) { @autoreleasepool {
    sp_event_test_set_report_clock(reportClock);
    sp_event_test_set_gated_schedule(holdWake);
    int wake = sp_event_wake_fd();
    check(wake >= 0, @"the wake pipe opens");
    uint8_t bytes[64];
    uint8_t pulled[4096];
    while (sp_event_drain(pulled, sizeof pulled) > 0) {}
    while (read(wake, bytes, sizeof bytes) > 0) {}

    sp_event_set_gated_wait_ms(200);
    const int8_t closed[SP_CLASS_COUNT] = {-1, -1, -1, -1, -1};
    check(sp_event_set_policy(closed), @"a policy that closes every class is accepted");
    for (int index = 0; index < 5; index++) (void)sp_event_gate(SP_CLASS_INPUT, SP_EVENT_DEBUG);
    check(schedules == 1 && scheduledWait == 200ull * NSEC_PER_MSEC,
        [NSString stringWithFormat:@"five counts schedule one wake after the wait of 200 ms, got %d of %llu ns", schedules, (unsigned long long)scheduledWait]);
    check(read(wake, bytes, sizeof bytes) == -1 && errno == EAGAIN, @"a count leaves the pipe quiet during its wait");
    endWait();
    check(read(wake, bytes, sizeof bytes) == 1, @"a count writes the pipe once after its wait");

    size_t used = sp_event_drain(pulled, sizeof pulled);
    check(used > 0, @"the drain that the wake causes reports the count");
    // Only a stored event, a loss or a scheduled wake writes the pipe, and the drain left none of them.
    check(scheduledWake == NULL && read(wake, bytes, sizeof bytes) == -1 && errno == EAGAIN, @"the report leaves the pipe quiet");

    (void)sp_event_gate(SP_CLASS_INPUT, SP_EVENT_DEBUG);
    check(schedules == 2 && scheduledWake != NULL, @"a count after the report schedules its wake");
    reportNow += oneSecond - 1;
    used = sp_event_drain(pulled, sizeof pulled);
    check(used == 0, @"a drain within a second of the report reports no count");
    reportNow += 1;
    used = sp_event_drain(pulled, sizeof pulled);
    check(used > 0, @"a drain for another reason takes the count that waits");
    while (read(wake, bytes, sizeof bytes) > 0) {}
    endWait();
    check(read(wake, bytes, sizeof bytes) == -1 && errno == EAGAIN, @"a wake that finds no count left writes nothing");
    return failures ? 1 : 0;
}}
