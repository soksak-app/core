// A fatal signal and an uncaught exception write one `error: fatal: …` line to the standard error before the process
// ends (docs/spec/diagnostics.md). Each case runs in a child process whose standard error is a file.
#import <Foundation/Foundation.h>
#include <fcntl.h>
#include <signal.h>
#include <sys/wait.h>
#include <unistd.h>
#import "application_log.h"

typedef void (^Crash)(void);

/// Runs crash in a child process with its standard error in a file; returns the written text and the terminating signal.
static NSString *run(Crash crash, int *signalNumber) {
    char path[] = "/tmp/application_log_fatal_test.XXXXXX";
    int file = mkstemp(path);
    if (file < 0) { perror("mkstemp"); exit(1); }
    fflush(NULL);
    pid_t child = fork();
    if (child < 0) { perror("fork"); exit(1); }
    if (child == 0) {
        if (dup2(file, STDERR_FILENO) < 0) _exit(2);
        sp_log_install_fatal_handlers();
        crash();
        _exit(3);
    }
    int status = 0;
    if (waitpid(child, &status, 0) < 0) { perror("waitpid"); exit(1); }
    *signalNumber = WIFSIGNALED(status) ? WTERMSIG(status) : 0;
    close(file);
    NSString *written = [NSString stringWithContentsOfFile:@(path) encoding:NSUTF8StringEncoding error:nil];
    unlink(path);
    return written;
}

static BOOL check(const char *name, BOOL passed, NSString *written, int signalNumber) {
    fprintf(passed ? stdout : stderr, "%s: %s (written %s, signal %d)\n", passed ? "PASS" : "FAIL", name,
        written.UTF8String ?: "nothing", signalNumber);
    return passed;
}

int main(void) { @autoreleasepool {
    int signalNumber = 0;
    NSString *written = run(^{ abort(); }, &signalNumber);
    BOOL ok = check("an abort writes one fatal line and ends by the signal",
        [written isEqualToString:@"error: fatal: SIGABRT\n"] && signalNumber == SIGABRT, written, signalNumber);
    written = run(^{ raise(SIGSEGV); }, &signalNumber);
    ok = check("a segmentation fault writes one fatal line and ends by the signal",
        [written isEqualToString:@"error: fatal: SIGSEGV\n"] && signalNumber == SIGSEGV, written, signalNumber) && ok;
    written = run(^{ @throw [NSException exceptionWithName:@"TestException" reason:@"boom" userInfo:nil]; }, &signalNumber);
    // The system writes its own report of the exception to the same standard error; the check counts the fatal lines.
    NSMutableArray *fatal = [NSMutableArray array];
    for (NSString *line in [written componentsSeparatedByString:@"\n"]) {
        if ([line hasPrefix:@"error: fatal:"]) [fatal addObject:line];
    }
    ok = check("an uncaught exception writes one fatal line",
        [fatal isEqualToArray:@[@"error: fatal: uncaught exception TestException: boom"]], written, signalNumber) && ok;
    return ok ? 0 : 1;
}}
