// Runs the operations of the input source restoration (support/ime_source_restore.m) on the system: the selection of an input
// source through TISSelectInputSource, the activation of the outer application and the readings of both. The decisions of the
// restoration are judged on data in ime_source_restore_test. This test takes the front from the application of the person
// and changes the selected input source, so it runs only in make test-app-activation, with the approval of the person. It
// fails if the ABC or the Korean 2-set input source is not enabled. Each case ends with the input source and the frontmost
// application that the run began with, and the end of the run fails when either differs.
//
// A failure that the system gives on demand is a real input: the selection of an identifier that no input source has is
// refused, and an application activation for a process that is no application fails. The selection that changes the source
// and then reports a refusal is the fault point SOKSAK_FAULT_IME_SELECT of src/input_source.m
// (docs/operations/examples.md#test-kinds).
#import <Cocoa/Cocoa.h>
#include <stdlib.h>
#include <unistd.h>
#import "input_source.h"
#import "support/event_wait.h"
#import "support/ime_source_restore.h"

// tests/support/no_activation.m: this check activates the application in make test-app-activation.
void sp_test_declare_activation(void);

static NSString *const ABC = @"com.apple.keylayout.ABC";
static NSString *const KOREAN = @"com.apple.inputmethod.Korean.2SetKorean";
// An identifier that no input source has.
static NSString *const ABSENT = @"app.soksak.test.absent-input-source";
// A process that is no application: the system process that starts the others.
static const pid_t NOT_AN_APPLICATION = 1;

static int failures = 0;
// The operations that a case gave to the system, in order.
static NSMutableArray<NSString *> *calls;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static NSString *currentSourceID(void) {
    char *identifier = sp_input_source_current();
    NSString *result = identifier ? [NSString stringWithUTF8String:identifier] : nil;
    free(identifier);
    return result;
}

static pid_t frontmostProcess(void) { return NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier; }

// The answer of the selection can come from a timer of the library, which does not end a turn of the run loop, so the answer
// wakes the wait.
static BOOL selectAndAwait(NSString *source) {
    [calls addObject:[@"select:" stringByAppendingString:source]];
    __block BOOL answered = NO;
    __block BOOL selected = NO;
    sp_input_source_select_and_await(source.UTF8String, NULL, ^(const char *error) {
        answered = YES;
        selected = error == NULL;
        eventWake();
    });
    eventWait([NSString stringWithFormat:@"the selection of %@ answers", source], ^BOOL { return answered; });
    return selected && [currentSourceID() isEqualToString:source];
}

static BOOL activate(pid_t processIdentifier) {
    [calls addObject:[NSString stringWithFormat:@"activate:%d", processIdentifier]];
    NSRunningApplication *application = [NSRunningApplication runningApplicationWithProcessIdentifier:processIdentifier];
    if (!application) return NO;
    if (frontmostProcess() == processIdentifier) return YES;
    if (![application activateWithOptions:0]) return NO;
    eventWait(@"the application becomes the frontmost application", ^BOOL { return frontmostProcess() == processIdentifier; });
    return YES;
}

// Takes the front for this process, so that a restoration has an application to bring forward.
static void takeFront(void) {
    [NSApp activateIgnoringOtherApps:YES];
    eventWait(@"this process becomes the frontmost application", ^BOOL { return frontmostProcess() == getpid(); });
}

static NSString *sourceAtClose;
static void closeTestContext(void) {
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 100, 100)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    sourceAtClose = currentSourceID();
    [calls addObject:@"close"];
    [window close];
    [window release];
}

static NSArray<NSString *> *restore(NSString *baseline, NSString *outer, pid_t outerProcess) {
    return sp_ime_source_restore_errors(baseline, outer, outerProcess, ^NSString * { return currentSourceID(); },
        ^BOOL(pid_t processIdentifier) { return activate(processIdentifier); }, ^pid_t { return frontmostProcess(); },
        ^BOOL(NSString *source) { return selectAndAwait(source); });
}

static NSArray<NSString *> *cleanup(NSString *baseline, NSString *outer, pid_t outerProcess) {
    return sp_ime_source_cleanup_errors(baseline, outer, outerProcess, ^NSString * { return currentSourceID(); },
        ^BOOL(pid_t processIdentifier) { return activate(processIdentifier); }, ^pid_t { return frontmostProcess(); },
        ^BOOL(NSString *source) { return selectAndAwait(source); }, ^{ closeTestContext(); });
}

static BOOL mentions(NSArray<NSString *> *errors, NSString *text) { return [errors.description containsString:text]; }

static void beginCase(void) {
    calls = [NSMutableArray array];
    sourceAtClose = nil;
}

int main(void) { @autoreleasepool {
    setvbuf(stdout, NULL, _IOLBF, 0);
    sp_test_declare_activation();
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];

    NSString *original = currentSourceID();
    NSRunningApplication *outerApplication = [[NSWorkspace.sharedWorkspace.frontmostApplication retain] autorelease];
    if (!original || outerApplication.processIdentifier <= 0) {
        fprintf(stderr, "FAIL: the selected input source or the frontmost application could not be read\n");
        return 1;
    }
    pid_t outer = outerApplication.processIdentifier;
    beginCase();
    if (!selectAndAwait(KOREAN) || !selectAndAwait(ABC)) {
        fprintf(stderr, "FAIL: the input sources %s and %s are not both enabled\n", ABC.UTF8String, KOREAN.UTF8String);
        return 1;
    }

    // The cleanup selects the baseline, closes the context, brings the outer application forward and then selects the outer source.
    beginCase();
    check(selectAndAwait(KOREAN), @"Korean 2-Set is the source that the cleanup restores");
    takeFront();
    [calls removeAllObjects];
    NSArray<NSString *> *errors = cleanup(ABC, KOREAN, outer);
    NSArray *order = @[@"select:com.apple.keylayout.ABC", @"close", [NSString stringWithFormat:@"activate:%d", outer],
        @"select:com.apple.inputmethod.Korean.2SetKorean"];
    check(errors.count == 0 && [calls isEqual:order],
        [NSString stringWithFormat:@"the cleanup selects ABC before closing, restores the outer application, then the outer source (errors %@; calls %@)", errors, calls]);
    check([sourceAtClose isEqualToString:ABC], [NSString stringWithFormat:@"ABC is the source when the context closes (%@)", sourceAtClose]);
    check([currentSourceID() isEqualToString:KOREAN] && frontmostProcess() == outer,
        @"the cleanup restores the outer source and the frontmost application");

    // A refused selection changes nothing: no input source has the identifier.
    beginCase();
    errors = sp_ime_source_select_errors(ABSENT, ^BOOL(NSString *source) { return selectAndAwait(source); },
        ^NSString * { return currentSourceID(); });
    check(mentions(errors, @"not selected and adopted") && mentions(errors, [@"expected " stringByAppendingString:ABSENT]),
        [NSString stringWithFormat:@"a refused selection is reported (%@)", errors]);
    check([currentSourceID() isEqualToString:KOREAN] && frontmostProcess() == outer,
        @"a refused selection changes neither the source nor the frontmost application");

    // An activation of a process that is no application fails, and the outer source is still restored.
    beginCase();
    check(selectAndAwait(ABC), @"ABC is the baseline of the activation failure");
    takeFront();
    pid_t frontmostBefore = frontmostProcess();
    errors = restore(ABC, KOREAN, NOT_AN_APPLICATION);
    check(mentions(errors, @"outer frontmost application was not restored")
        && mentions(errors, [NSString stringWithFormat:@"frontmost process after restoration is %d, expected %d", frontmostBefore, NOT_AN_APPLICATION]),
        [NSString stringWithFormat:@"an application restoration failure is retained (%@)", errors]);
    check([currentSourceID() isEqualToString:KOREAN], @"the outer source is restored when the application activation fails");

    // A selection of the outer source that the system refuses is reported, and the outer application stays restored.
    beginCase();
    check(selectAndAwait(ABC), @"ABC is the baseline of the outer selection failure");
    takeFront();
    errors = restore(ABC, ABSENT, outer);
    check(mentions(errors, @"not selected and adopted")
        && mentions(errors, [NSString stringWithFormat:@"final input source is %@, expected outer source %@", ABC, ABSENT]),
        [NSString stringWithFormat:@"an outer source selection failure is reported (%@)", errors]);
    check(frontmostProcess() == outer, @"the outer application restoration is verified when the outer source restoration fails");

    // The selection that changes the source and then reports a refusal prevents the gesture keys, and the cleanup recovers.
    beginCase();
    check(selectAndAwait(ABC), @"ABC is the baseline of the partial selection failure");
    takeFront();
    [calls removeAllObjects];
    __block NSUInteger keysSent = 0;
    NSMutableArray<NSString *> *adoptionErrors = [NSMutableArray array];
    setenv("SOKSAK_FAULT_IME_SELECT", KOREAN.UTF8String, 1);
    BOOL ran = sp_ime_source_run_after_adoption(KOREAN, ^BOOL(NSString *source) { return selectAndAwait(source); },
        ^NSString * { return currentSourceID(); }, ^BOOL { return YES; }, ^{ keysSent++; }, adoptionErrors);
    unsetenv("SOKSAK_FAULT_IME_SELECT");
    check(!ran && keysSent == 0 && mentions(adoptionErrors, @"not selected and adopted"),
        [NSString stringWithFormat:@"a partial Korean selection failure prevents the gesture keys (%@; keys %@)", adoptionErrors, @(keysSent)]);
    check([currentSourceID() isEqualToString:KOREAN], @"the source changed although the selection reported a refusal");
    [calls removeAllObjects];
    errors = cleanup(ABC, KOREAN, outer);
    check(errors.count == 0 && [calls isEqual:order],
        [NSString stringWithFormat:@"the cleanup after a partial failure selects ABC before closing, restores the outer application, then the outer source (errors %@; calls %@)", errors, calls]);
    check([currentSourceID() isEqualToString:KOREAN] && frontmostProcess() == outer,
        @"the cleanup after a partial failure verifies the original source and frontmost application");

    // A baseline that cannot be selected is reported, while the context still closes before the outer restoration.
    beginCase();
    takeFront();
    errors = cleanup(ABSENT, KOREAN, outer);
    NSArray *absentOrder = @[[@"select:" stringByAppendingString:ABSENT], @"close", [NSString stringWithFormat:@"activate:%d", outer],
        @"select:com.apple.inputmethod.Korean.2SetKorean"];
    check([calls isEqual:absentOrder] && mentions(errors, @"not selected and adopted")
        && mentions(errors, [@"expected " stringByAppendingString:ABSENT]),
        [NSString stringWithFormat:@"a failed baseline cleanup is reported while the context still closes before the outer restoration (%@; calls %@)", errors, calls]);

    // The end of the run returns the source and the application that it began with.
    beginCase();
    takeFront();
    check(selectAndAwait(original), @"the source that the run began with is selected again");
    errors = restore(original, original, outer);
    check(errors.count == 0 && [currentSourceID() isEqualToString:original] && frontmostProcess() == outer,
        [NSString stringWithFormat:@"the run ends with its original source and frontmost application (%@)", errors]);
    return failures ? 1 : 0;
} }
