// A selection of a keyboard input source that fails is an error record that states the reason, and a selection that succeeds stores none.
// The check selects the input source that is already selected, so the keyboard of the computer does not change. It does not activate the application.
#import <Cocoa/Cocoa.h>
#import "input_source.h"
#import "support/records.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    __block bool selected = true;
    NSArray<NSDictionary *> *unknown = capturedEvents(^{ selected = sp_input_source_select("test.no-such-input-source"); });
    check(!selected, @"an identifier that no input source has is not selected");
    check(unknown.count == 1 && [unknown[0][@"name"] isEqual:@"native.record.error"] && [unknown[0][@"fields"][@"where"] isEqual:@"input source"]
        && [unknown[0][@"fields"][@"text"] containsString:@"no input source has this identifier"],
        [NSString stringWithFormat:@"the failed selection is one error record that names the cause: %@", unknown]);
    __block bool missing = true;
    NSArray<NSDictionary *> *nothing = capturedEvents(^{ missing = sp_input_source_select(NULL); });
    check(!missing && nothing.count == 1 && [nothing[0][@"fields"][@"text"] isEqual:@"the identifier to select is missing"], @"a missing identifier is one error record");
    // Without a key window there is no text input context to wait for, so the wait answers at once and once.
    __block int calls = 0;
    __block BOOL failed = YES;
    sp_input_source_await("com.apple.keylayout.ABC", ^(const char *error) { calls++; failed = error != NULL; });
    check(calls == 1 && !failed, [NSString stringWithFormat:@"a wait without a text input context answers at once without an error (%d calls)", calls]);
    __block NSString *reason = nil;
    sp_input_source_await(NULL, ^(const char *error) { reason = error ? @(error) : nil; });
    check([reason isEqual:@"the identifier to await is missing or not valid UTF-8"], [NSString stringWithFormat:@"a wait without an identifier answers its reason: %@", reason]);
    return failures == 0 ? 0 : 1;
} }
