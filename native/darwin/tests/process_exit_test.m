// Checks that sp_process_when_exited distinguishes a process that exits, a process that has already exited, and a wait that sp_process_exit_end ends.
// It does not activate the application.
#import <Cocoa/Cocoa.h>
#import <spawn.h>
#import <sys/wait.h>
#import "process_exit.h"
#import "support/records.h"
#import "event_ring.h"
#import "support/event_wait.h"

extern char **environ;

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

typedef struct {
    int calls;
    BOOL mainThread;
    bool exited;
} SPExited;

static void answered(void *context, bool exited) {
    SPExited *state = context;
    state->calls++;
    state->mainThread = NSThread.isMainThread;
    state->exited = exited;
}

static pid_t spawnSleep(const char *seconds) {
    pid_t pid = 0;
    char *argv[] = {"/bin/sleep", (char *)seconds, NULL};
    int error = posix_spawn(&pid, "/bin/sleep", NULL, NULL, argv, environ);
    if (error != 0) {
        check(NO, [NSString stringWithFormat:@"/bin/sleep %s starts (error %d)", seconds, error]);
        return 0;
    }
    return pid;
}

// Runs the main run loop until the answer comes. sp_process_when_exited answers in a block of the main queue.
static void runUntilAnswered(SPExited *state) {
    eventWait(@"sp_process_when_exited answers", ^BOOL { return state->calls != 0; });
}

int main(void) { @autoreleasepool {
    // The records that this test reads include events below the level error, which the default policy refuses (docs/spec/logging.md#policy):
    // the policy that stores every level is set here, and the default policy is tested in event_ring_test.
    const int8_t everything[SP_CLASS_COUNT] = {SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE};
    check(sp_event_set_policy(everything), @"the policy stores every level of every class");
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];

    // Like a child that another process reaps, this test receives the exit only as a notification. Reaping is done after the reply.
    pid_t ending = spawnSleep("0.3");
    SPExited ended = {0};
    sp_process_when_exited(ending, answered, &ended);
    runUntilAnswered(&ended);
    check(ended.calls == 1 && ended.mainThread && ended.exited, [NSString stringWithFormat:
        @"a process that ends is reported as exited once on the main thread (calls %d, exited %d)",
        ended.calls, ended.exited]);
    if (ending) waitpid(ending, NULL, 0);

    SPExited gone = {0};
    sp_process_when_exited(ending, answered, &gone);
    runUntilAnswered(&gone);
    check(gone.calls == 1 && gone.exited, [NSString stringWithFormat:
        @"a process that no longer exists is reported as exited (calls %d, exited %d)", gone.calls, gone.exited]);

    __block pid_t running = spawnSleep("30");
    __block SPExited missed = {0};
    NSArray<NSDictionary *> *waiting = capturedEvents(^{
        sp_process_when_exited(running, answered, &missed);
        check(missed.calls == 0, @"a process that runs leaves its wait open");
        // The wait has no limit: its end, which a host calls at the close of the connection or the window of the request, answers it.
        sp_process_exit_end(&missed);
    });
    NSMutableArray<NSString *> *names = [NSMutableArray array];
    for (NSDictionary *event in waiting) [names addObject:event[@"name"]];
    NSUInteger registered = [names indexOfObject:@"native.observe.registered"];
    NSUInteger ended_ = [names indexOfObject:@"native.process.exit_wait_ended"];
    check(registered != NSNotFound && ended_ != NSNotFound && registered < ended_ && [waiting[registered][@"fields"][@"source"] isEqual:@"process_exit"],
        [NSString stringWithFormat:@"the wait is a registration event and its end follows it: %@", names]);
    NSDictionary *end = ended_ == NSNotFound ? @{} : waiting[ended_];
    check([end[@"fields"][@"pid"] intValue] == running,
        [NSString stringWithFormat:@"the end of the wait is one event with the pid: %@", end]);
    check(missed.calls == 1 && !missed.exited, [NSString stringWithFormat:
        @"an ended wait of a process that runs is reported as not exited at its end (calls %d, exited %d)", missed.calls, missed.exited]);
    sp_process_exit_end(&missed);
    check(missed.calls == 1, @"the end of a wait that answered already gives nothing");
    if (running) {
        kill(running, SIGTERM);
        waitpid(running, NULL, 0);
    }
    // A process that exits after the end of its wait does not give the answer again.
    SPExited after = {0};
    sp_process_when_exited(running, answered, &after);
    runUntilAnswered(&after);
    // A process started after it was reaped exits after it, and its exit reaches the main queue through the same notification
    // path, so a second answer for the process whose wait ended would come before the answer for the later one.
    pid_t later = spawnSleep("0");
    SPExited afterLater = {0};
    sp_process_when_exited(later, answered, &afterLater);
    runUntilAnswered(&afterLater);
    if (later) waitpid(later, NULL, 0);
    check(afterLater.calls == 1 && afterLater.exited, [NSString stringWithFormat:
        @"a process started after the reap is reported as exited (calls %d, exited %d)", afterLater.calls, afterLater.exited]);
    check(missed.calls == 1, [NSString stringWithFormat:@"the answer is given once (calls %d)", missed.calls]);
    check(after.calls == 1 && after.exited, @"a wait of the ended process answers that it exited");
    check(!NSApp.isActive, @"application stays inactive");
    return failures ? 1 : 0;
}}
