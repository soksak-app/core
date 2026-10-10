// Checks that sp_process_when_exited distinguishes a process that exits, a process that has already exited, and a process that does not exit within the deadline.
// It does not activate the application.
#import <Cocoa/Cocoa.h>
#import <spawn.h>
#import <sys/wait.h>
#import "process_exit.h"

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

// Runs the main run loop until done is called.
static void runUntilAnswered(SPExited *state) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:15];
    while (state->calls == 0 && deadline.timeIntervalSinceNow > 0) {
        @autoreleasepool {
            [[NSRunLoop mainRunLoop] runMode:NSDefaultRunLoopMode beforeDate:deadline];
        }
    }
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];

    // Like a child that another process reaps, this test receives the exit only as a notification. Reaping is done after the reply.
    pid_t ending = spawnSleep("0.3");
    SPExited ended = {0};
    sp_process_when_exited(ending, 10, answered, &ended);
    runUntilAnswered(&ended);
    check(ended.calls == 1 && ended.mainThread && ended.exited, [NSString stringWithFormat:
        @"a process that ends within the bound is reported as exited once on the main thread (calls %d, exited %d)",
        ended.calls, ended.exited]);
    if (ending) waitpid(ending, NULL, 0);

    SPExited gone = {0};
    sp_process_when_exited(ending, 10, answered, &gone);
    runUntilAnswered(&gone);
    check(gone.calls == 1 && gone.exited, [NSString stringWithFormat:
        @"a process that no longer exists is reported as exited (calls %d, exited %d)", gone.calls, gone.exited]);

    pid_t running = spawnSleep("30");
    SPExited missed = {0};
    sp_process_when_exited(running, 0.2, answered, &missed);
    runUntilAnswered(&missed);
    check(missed.calls == 1 && !missed.exited, [NSString stringWithFormat:
        @"a process that runs past the bound is reported as not exited (calls %d, exited %d)", missed.calls, missed.exited]);
    if (running) {
        kill(running, SIGTERM);
        waitpid(running, NULL, 0);
    }
    // A process that exits after the deadline does not give the reply again.
    [[NSRunLoop mainRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.2]];
    check(missed.calls == 1, [NSString stringWithFormat:@"the answer is given once (calls %d)", missed.calls]);
    check(!NSApp.isActive, @"application stays inactive");
    return failures ? 1 : 0;
}}
