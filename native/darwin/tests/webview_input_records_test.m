// Checks that the input registration of a web view emits its three records (registered, ended, released) with the same
// identifier of the web view, in that order, and that the count of live registrations in each record is the count after
// the change. The check does not activate the application.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "event_ring.h"
#import "webview_input.h"
#import "window_objects.h"
#import "support/records.h"

static int failures;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    // The records of the debug level are stored only under a policy that stores them (docs/spec/logging.md#policy).
    const int8_t everything[SP_CLASS_COUNT] = {SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE};
    check(sp_event_set_policy(everything), @"the policy stores every level of every class");

    NSInteger baseline = sp_window_objects_count().inputRegistrations;
    NSArray<NSDictionary *> *events = capturedEvents(^{
        @autoreleasepool {
            WKWebView *view = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 300, 200)];
            check(webviewInputRegister(view), @"the web view registers for input");
            webviewInputUnregister(view);
            [view release];
        }
    });

    NSMutableArray<NSDictionary *> *inputEvents = [NSMutableArray array];
    for (NSDictionary *event in events) {
        if ([event[@"name"] isEqualToString:@"native.webview.input"]) [inputEvents addObject:event];
    }
    check(inputEvents.count == 3, [NSString stringWithFormat:@"one registration cycle emits three input records (%lu)", (unsigned long)inputEvents.count]);
    if (inputEvents.count != 3) return 1;

    NSArray *phases = @[@"registered", @"ended", @"released"];
    NSString *identifier = inputEvents[0][@"fields"][@"view"];
    for (NSUInteger i = 0; i < inputEvents.count; i++) {
        NSDictionary *event = inputEvents[i];
        NSDictionary *fields = event[@"fields"];
        check([fields[@"phase"] isEqualToString:phases[i]],
            [NSString stringWithFormat:@"record %lu has the phase %@ (%@)", (unsigned long)i, phases[i], fields[@"phase"]]);
        check([event[@"level"] intValue] == SP_EVENT_DEBUG && [event[@"class"] intValue] == SP_CLASS_LIFECYCLE,
            [NSString stringWithFormat:@"record %lu is a lifecycle record of the debug level", (unsigned long)i]);
        check(identifier.length > 0 && [fields[@"view"] isEqualToString:identifier],
            [NSString stringWithFormat:@"record %lu names the same web view %@ (%@)", (unsigned long)i, identifier, fields[@"view"]]);
    }
    // The registration leaves the live count when it is released, so the count stays at the value after the registration
    // through the end and drops back to the baseline in the release record.
    check([inputEvents[0][@"fields"][@"count"] integerValue] == baseline + 1,
        [NSString stringWithFormat:@"the registered record counts the live registration (%@, baseline %ld)", inputEvents[0][@"fields"][@"count"], (long)baseline]);
    check([inputEvents[1][@"fields"][@"count"] integerValue] == baseline + 1,
        [NSString stringWithFormat:@"the ended record counts the registration until its release (%@)", inputEvents[1][@"fields"][@"count"]]);
    check([inputEvents[2][@"fields"][@"count"] integerValue] == baseline,
        [NSString stringWithFormat:@"the released record counts the registration out (%@, baseline %ld)", inputEvents[2][@"fields"][@"count"], (long)baseline]);
    return failures ? 1 : 0;
}}
