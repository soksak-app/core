// A fatal signal and an uncaught exception write one `<time> error native fatal: …` record to the standard error before the process
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

/// The record of a line without its time: `<ISO-8601 time with milliseconds> <rest>`; nil when line has another shape.
static NSString *withoutTime(NSString *line) {
    NSRegularExpression *shape = [NSRegularExpression regularExpressionWithPattern:
        @"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z (.*)$" options:0 error:nil];
    NSTextCheckingResult *match = [shape firstMatchInString:line options:0 range:NSMakeRange(0, line.length)];
    return match ? [line substringWithRange:[match rangeAtIndex:1]] : nil;
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
        [withoutTime([written stringByTrimmingCharactersInSet:NSCharacterSet.newlineCharacterSet]) isEqualToString:@"error native fatal: SIGABRT"] && [written componentsSeparatedByString:@"\n"].count == 2 && signalNumber == SIGABRT, written, signalNumber);
    written = run(^{ raise(SIGSEGV); }, &signalNumber);
    ok = check("a segmentation fault writes one fatal line and ends by the signal",
        [withoutTime([written stringByTrimmingCharactersInSet:NSCharacterSet.newlineCharacterSet]) isEqualToString:@"error native fatal: SIGSEGV"] && [written componentsSeparatedByString:@"\n"].count == 2 && signalNumber == SIGSEGV, written, signalNumber) && ok;
    written = run(^{ @throw [NSException exceptionWithName:@"TestException" reason:@"boom" userInfo:nil]; }, &signalNumber);
    // The system writes its own report of the exception to the same standard error; the check counts the fatal lines.
    NSMutableArray *fatal = [NSMutableArray array];
    for (NSString *line in [written componentsSeparatedByString:@"\n"]) {
        NSString *record = withoutTime(line);
        if ([record hasPrefix:@"error native fatal:"]) [fatal addObject:record];
    }
    ok = check("an uncaught exception writes one fatal line",
        [fatal isEqualToArray:@[@"error native fatal: uncaught exception TestException: boom"]], written, signalNumber) && ok;
    return ok ? 0 : 1;
}}
