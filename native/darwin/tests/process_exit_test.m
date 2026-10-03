// sp_process_when_exited 가 끝나는 프로세스, 이미 끝난 프로세스, 기한 안에 끝나지 않는 프로세스를 구별하는지 검사한다.
// 애플리케이션을 활성화하지 않는다.
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

// done 이 불릴 때까지 메인 실행 반복을 돌린다.
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

    // 다른 프로세스가 회수하는 자식처럼 이 검사는 종료를 알림으로만 받는다. 회수는 답을 받은 뒤에 한다.
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
    // 기한 뒤에 끝난 프로세스는 답을 다시 주지 않는다.
    [[NSRunLoop mainRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.2]];
    check(missed.calls == 1, [NSString stringWithFormat:@"the answer is given once (calls %d)", missed.calls]);
    check(!NSApp.isActive, @"application stays inactive");
    return failures ? 1 : 0;
}}
