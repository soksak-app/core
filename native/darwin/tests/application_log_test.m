// The records of the native library are text records of the form `<time> <level> native <where>: <text>`, each on one
// line of the standard error (docs/spec/diagnostics.md#forms). The host turns the standard error into the application log.
#import <Foundation/Foundation.h>
#include <fcntl.h>
#include <unistd.h>
#import "application_log.h"

/// The standard error of the process while block runs.
static NSString *captured(void (^block)(void)) {
    char path[] = "/tmp/application_log_test.XXXXXX";
    int file = mkstemp(path);
    if (file < 0) { perror("mkstemp"); exit(1); }
    int saved = dup(STDERR_FILENO);
    if (saved < 0 || dup2(file, STDERR_FILENO) < 0) { perror("dup2"); exit(1); }
    block();
    if (dup2(saved, STDERR_FILENO) < 0) { perror("dup2"); exit(1); }
    close(saved);
    close(file);
    NSString *written = [NSString stringWithContentsOfFile:@(path) encoding:NSUTF8StringEncoding error:nil];
    unlink(path);
    return written;
}

/// Whether line is `<ISO-8601 time with milliseconds> <rest>\n` and returns rest through out.
static BOOL splitTime(NSString *line, NSString **rest) {
    NSRegularExpression *shape = [NSRegularExpression regularExpressionWithPattern:
        @"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z (.*)\\n$" options:0 error:nil];
    NSTextCheckingResult *match = [shape firstMatchInString:line options:0 range:NSMakeRange(0, line.length)];
    if (!match) return NO;
    *rest = [line substringWithRange:[match rangeAtIndex:1]];
    return YES;
}

static BOOL check(const char *name, BOOL passed, NSString *written) {
    fprintf(passed ? stdout : stderr, "%s: %s (written %s)\n", passed ? "PASS" : "FAIL", name, written.UTF8String ?: "nothing");
    return passed;
}

int main(void) { @autoreleasepool {
    NSString *rest = nil;
    NSString *written = captured(^{ sp_log_error("surface settle", "the DOM evaluation failed"); });
    BOOL ok = check("an error is <time> error native <where>: <text>",
        splitTime(written, &rest) && [rest isEqualToString:@"error native surface settle: the DOM evaluation failed"], written);
    written = captured(^{ sp_log_info("input method", "insertText text=\"한\""); });
    ok = check("an observation is <time> info native <where>: <text>",
        splitTime(written, &rest) && [rest isEqualToString:@"info native input method: insertText text=\"한\""], written) && ok;
    written = captured(^{ sp_log_info("input method", "first\nsecond"); });
    ok = check("a line feed in the text is written as \\n and the record is one line",
        splitTime(written, &rest) && [rest isEqualToString:@"info native input method: first\\nsecond"]
        && [written componentsSeparatedByString:@"\n"].count == 2, written) && ok;
    return ok ? 0 : 1;
}}
