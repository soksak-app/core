#include "support/host_test_api.h"
#import "support/run_until.h"
#include <Block.h>
#include <CoreFoundation/CoreFoundation.h>
#include <IOSurface/IOSurface.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

static int failures;
#define CHECK(value, text) do { if (!(value)) { fprintf(stderr, "FAIL: %s\n", text); failures++; } else puts("PASS: " text); } while (0)
static bool injected;
static bool fired;
static void timerFired(CFRunLoopTimerRef timer, void *info) { (void)timer; (void)info; fired = true; }
static void counts(uint64_t *sent, uint64_t *waiting, uint64_t *answered) { *sent = 17; *waiting = 3; *answered = 11; }
static void setter(bool value) { injected = value; }
static void otherCounts(uint64_t *sent, uint64_t *waiting, uint64_t *answered) { *sent = 99; *waiting = 99; *answered = 99; }
static void *captureOffMain(void *unused) { (void)unused; return (void *)(uintptr_t)sp_host_test_sampler_capture_main(); }

int main(void) {
    CHECK(SP_HOST_TEST_SAMPLER_PHASES == 8 && SP_HOST_TEST_RECORDER_CAPACITY == 4096, "native sampling limits remain unchanged");
    CHECK(SP_HOST_TEST_RUN_LOOP_ENTRY == kCFRunLoopEntry && SP_HOST_TEST_RUN_LOOP_BEFORE_TIMERS == kCFRunLoopBeforeTimers
        && SP_HOST_TEST_RUN_LOOP_BEFORE_SOURCES == kCFRunLoopBeforeSources && SP_HOST_TEST_RUN_LOOP_BEFORE_WAITING == kCFRunLoopBeforeWaiting
        && SP_HOST_TEST_RUN_LOOP_AFTER_WAITING == kCFRunLoopAfterWaiting && SP_HOST_TEST_RUN_LOOP_EXIT == kCFRunLoopExit,
        "activity aliases follow the SDK");
    fflush(NULL);
    pid_t child = fork();
    if (child == 0) {
        uint64_t sent, waiting, answered;
        sp_host_test_read_stall_counts(&sent, &waiting, &answered);
        _exit(0);
    }
    int childStatus = 0;
    CHECK(child > 0 && waitpid(child, &childStatus, 0) == child && WIFSIGNALED(childStatus) && WTERMSIG(childStatus) == SIGABRT,
        "reading production state before address installation aborts");
    CHECK(sp_host_test_install_stall_functions(0, (uintptr_t)setter) != NULL, "missing count address is rejected");
    CHECK(sp_host_test_install_stall_functions((uintptr_t)counts, 0) != NULL, "missing setter address is rejected");
    CHECK(sp_host_test_install_stall_functions((uintptr_t)counts, (uintptr_t)setter) == NULL, "real native addresses install once");
    CHECK(sp_host_test_install_stall_functions((uintptr_t)otherCounts, (uintptr_t)setter) != NULL, "replacement addresses are rejected");
    uint64_t sent = 0, waiting = 0, answered = 0;
    sp_host_test_read_stall_counts(&sent, &waiting, &answered);
    CHECK(sent == 17 && waiting == 3 && answered == 11, "rejected replacement preserves the production address contract");
    sp_host_test_set_send_in_next_wait(true);
    CHECK(injected, "fault injection uses the installed native setter");
    sp_host_test_set_send_in_next_wait(false);
    CHECK(!injected, "fault injection can be cleared");
    __block bool ran = false;
    void (*direct)(void (^)(void)) = (void (*)(void (^)(void)))sp_host_test_direct_runner_address();
    direct(^{ ran = true; });
    CHECK(ran, "standalone direct dispatcher invokes the native block");
    CHECK(sp_host_test_sampler_start() != 0, "sampling cannot start before capturing native main");
    pthread_t offMain;
    void *offMainResult = NULL;
    int created = pthread_create(&offMain, NULL, captureOffMain, NULL);
    CHECK(created == 0, "off-main capture test thread starts");
    if (created == 0) CHECK(pthread_join(offMain, &offMainResult) == 0 && offMainResult == NULL, "capture rejects a non-main thread");
    CHECK(sp_host_test_sampler_capture_main() == 1, "native main stack is captured");
    CHECK(sp_host_test_sampler_start() == 0, "native sampler thread starts");
    sp_host_test_sampler_set_phase(0);
    // The sampler signals each sample that it took, so the check waits for the first sample of the phase.
    sp_host_test_sampler_await_samples(0, 1);
    CHECK(sp_host_test_sampler_stop() == 0, "sampler thread joins");
    CHECK(sp_host_test_sampler_phase_samples(0) > 0, "native stack samples are required");
    CHECK(sp_host_test_sampler_phase_outside(0) == 0 && sp_host_test_sampler_phase_first_outside(0) == 0, "samples remain inside the real native main stack");
    CHECK(sp_host_test_sampler_failure_count() == 0 && sp_host_test_sampler_failure_last() == 0, "suspend read and resume all succeed");
    CHECK(sp_host_test_sampler_stack_low() != 0 && sp_host_test_sampler_stack_low() < sp_host_test_sampler_stack_high(), "native stack bounds are exposed");
    sp_host_test_recorder_start();
    CFRunLoopTimerRef timer = CFRunLoopTimerCreate(NULL, CFAbsoluteTimeGetCurrent() + 0.001, 0, 0, 0, timerFired, NULL);
    CFRunLoopAddTimer(CFRunLoopGetMain(), timer, kCFRunLoopDefaultMode);
    sp_run_until("the timer of the recorded turn fires", ^BOOL { return fired; });
    CFRunLoopTimerInvalidate(timer);
    CFRelease(timer);
    uint64_t recorded = sp_host_test_recorder_stop();
    CHECK(recorded > 0 && sp_host_test_recorder_dropped() == 0, "native observer records a complete run-loop turn");
    for (uint64_t i = 0; i < recorded; i++) {
        uint64_t at, observedWaiting, observedAnswered;
        int32_t activity, defaultMode, hasTimer;
        int64_t timerIn;
        CHECK(sp_host_test_recorder_entry_at(i, &at, &activity, &defaultMode, &hasTimer, &timerIn, &observedWaiting, &observedAnswered) == 1,
            "every stopped recorder entry is readable");
        CHECK(at > 0 && observedWaiting == 3 && observedAnswered == 11, "recorder reads the installed production counts on the raw clock");
    }
    const unsigned char nonce[16] = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16};
    void *frame = sp_host_test_frame_create(12, 9, nonce);
    CHECK(frame != NULL && sp_host_test_frame_id(frame) != 0, "frame creation returns a real global IOSurface identifier");
    if (frame) {
        CFTypeRef data = IOSurfaceCopyValue((IOSurfaceRef)frame, CFSTR("soksak.frame"));
        CHECK(data && CFGetTypeID(data) == CFDataGetTypeID() && CFDataGetLength(data) == 16
            && !memcmp(CFDataGetBytePtr(data), nonce, 16), "transfer frame carries the exact nonce");
        if (data) CFRelease(data);
        CHECK(!sp_host_test_frame_in_use(frame), "unpresented frame has no window-server use mark");
        sp_host_test_frame_release(frame);
    }
    return failures ? 1 : 0;
}
