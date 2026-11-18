// The limited wait of the native checks (tests/support/event_wait.h): a wait whose condition never holds ends at its limit and
// returns the state that its measure function reports, and a wait whose condition holds returns nil.
#import <Cocoa/Cocoa.h>
#import "support/event_wait.h"

static int failures;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

int main(void) { @autoreleasepool {
    setvbuf(stdout, NULL, _IOLBF, 0);
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];

    // A condition that never holds ends at the limit with the measured state, and the wait does not end before the limit.
    NSDate *started = NSDate.date;
    NSString *state = eventWaitUntil(@"a condition that never holds", 0.5, ^BOOL { return NO; },
        ^NSString *{ return @"cursor arrow, page moves 0"; });
    NSTimeInterval elapsed = -[started timeIntervalSinceNow];
    check([state isEqual:@"cursor arrow, page moves 0"],
        [NSString stringWithFormat:@"the limit returns the measured state (%@)", state]);
    check(elapsed >= 0.5 && elapsed < 5, [NSString stringWithFormat:@"the wait ends at its limit (%.3f s)", elapsed]);

    // A condition that a block on the main queue makes true ends the wait with nil before the limit.
    __block BOOL flagged = NO;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 100000000), dispatch_get_main_queue(), ^{
        flagged = YES;
        eventWake();
    });
    NSString *none = eventWaitUntil(@"a condition that a block makes true", 10, ^BOOL { return flagged; },
        ^NSString *{ return @"not flagged"; });
    check(none == nil && flagged, [NSString stringWithFormat:@"a wait whose condition holds returns nil (%@)", none]);

    fprintf(stdout, failures ? "FAIL: %d checks failed\n" : "PASS: all checks\n", failures);
    return failures ? 1 : 0;
} }
