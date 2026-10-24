#import <Cocoa/Cocoa.h>
#import "support/ime_source_restore.h"

static int failures = 0;
static NSString *const ABC = @"com.apple.keylayout.ABC";
static NSString *const KOREAN = @"com.apple.inputmethod.Korean.2SetKorean";

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static NSMutableDictionary *fakeState(BOOL failABCSelection, BOOL failOuterSelection, BOOL failActivation) {
    return [[@{@"source": ABC, @"frontmost": @200, @"outerPID": @100,
        @"failABC": @(failABCSelection), @"failOuter": @(failOuterSelection), @"failActivation": @(failActivation),
        @"calls": [NSMutableArray array]} mutableCopy] autorelease];
}

static NSArray<NSString *> *restore(NSMutableDictionary *state) {
    SPIMESelectAndAwaitSource select = ^BOOL(NSString *source) {
        [state[@"calls"] addObject:[@"select:" stringByAppendingString:source]];
        if (([source isEqualToString:ABC] && [state[@"failABC"] boolValue])
            || ([source isEqualToString:KOREAN] && [state[@"failOuter"] boolValue])) return NO;
        state[@"source"] = source;
        return YES;
    };
    SPIMEReadSource read = ^NSString * { return state[@"source"]; };
    SPIMEActivateProcess activate = ^BOOL(pid_t processIdentifier) {
        [state[@"calls"] addObject:[NSString stringWithFormat:@"activate:%d", processIdentifier]];
        if ([state[@"failActivation"] boolValue]) return NO;
        state[@"frontmost"] = @(processIdentifier);
        return YES;
    };
    SPIMEReadFrontmostProcess frontmost = ^pid_t { return [state[@"frontmost"] intValue]; };
    return sp_ime_source_restore_errors(ABC, KOREAN, [state[@"outerPID"] intValue], read,
        activate, frontmost, select);
}

int main(void) { @autoreleasepool {
    NSMutableDictionary *state = fakeState(NO, NO, NO);
    NSArray<NSString *> *errors = restore(state);
    check(errors.count == 0, [NSString stringWithFormat:@"the baseline source and outer state restore without errors (%@)", errors]);
    check([[state[@"calls"] componentsJoinedByString:@","] isEqualToString:[NSString stringWithFormat:@"activate:100,select:%@", KOREAN]],
        [NSString stringWithFormat:@"the sequence restores the outer app before restoring the outer source (%@)", state[@"calls"]]);
    check([state[@"source"] isEqual:KOREAN] && [state[@"frontmost"] intValue] == 100,
        @"the original outer source and frontmost process are restored");

    state = fakeState(NO, NO, NO);
    NSMutableArray<NSString *> *adoptionErrors = [NSMutableArray array];
    __block NSUInteger keysSent = 0;
    BOOL ran = sp_ime_source_run_after_adoption(ABC,
        ^BOOL(NSString *source) { state[@"source"] = source; return YES; },
        ^NSString * { return state[@"source"]; }, ^BOOL { return YES; }, ^{ keysSent++; }, adoptionErrors);
    check(ran && keysSent == 1 && adoptionErrors.count == 0,
        @"the gesture callback runs once after the source and context are adopted");

    state = fakeState(YES, NO, NO);
    state[@"source"] = KOREAN;
    SPIMESelectAndAwaitSource select = ^BOOL(NSString *source) {
        [state[@"calls"] addObject:[@"select:" stringByAppendingString:source]];
        if (([source isEqualToString:ABC] && [state[@"failABC"] boolValue])
            || ([source isEqualToString:KOREAN] && [state[@"failOuter"] boolValue])) return NO;
        state[@"source"] = source;
        return YES;
    };
    errors = sp_ime_source_select_errors(ABC, select, ^NSString * { return state[@"source"]; });
    check(errors.count >= 2 && [errors.description containsString:@"not selected and adopted"]
        && [errors.description containsString:@"expected com.apple.keylayout.ABC"],
        [NSString stringWithFormat:@"failed ABC selection is reported before activation (%@)", errors]);
    check([state[@"frontmost"] intValue] == 200 && [state[@"source"] isEqual:KOREAN],
        @"a failed baseline selection does not claim that activation or the source changed");

    state = fakeState(NO, NO, YES);
    errors = restore(state);
    check([errors.description containsString:@"outer frontmost application was not restored"]
        && [errors.description containsString:@"frontmost process after restoration is 200"],
        [NSString stringWithFormat:@"application restoration failures are retained (%@)", errors]);
    check([state[@"source"] isEqual:KOREAN], @"outer source cleanup still runs when app activation fails");

    state = fakeState(NO, YES, NO);
    errors = restore(state);
    check([errors.description containsString:@"not selected and adopted"]
        && [errors.description containsString:[NSString stringWithFormat:@"final input source is %@, expected outer source %@", ABC, KOREAN]],
        [NSString stringWithFormat:@"outer source selection failure is reported (%@)", errors]);
    check([state[@"frontmost"] intValue] == 100, @"outer app restoration remains verified when outer source restoration fails");

    state = fakeState(NO, NO, NO);
    keysSent = 0;
    __block BOOL partialKoreanSelection = YES;
    SPIMESelectAndAwaitSource partialSelect = ^BOOL(NSString *source) {
        [state[@"calls"] addObject:[@"select:" stringByAppendingString:source]];
        state[@"source"] = source;
        if ([source isEqualToString:KOREAN] && partialKoreanSelection) {
            partialKoreanSelection = NO;
            return NO;
        }
        return YES;
    };
    adoptionErrors = [NSMutableArray array];
    ran = sp_ime_source_run_after_adoption(KOREAN, partialSelect,
        ^NSString * { return state[@"source"]; }, ^BOOL { return YES; }, ^{ keysSent++; }, adoptionErrors);
    check(!ran && keysSent == 0 && [adoptionErrors.description containsString:@"not selected and adopted"],
        [NSString stringWithFormat:@"a partial Korean selection failure prevents gesture keys (%@; keys %@)", adoptionErrors, @(keysSent)]);
    NSArray<NSString *> *cleanupErrors = sp_ime_source_cleanup_errors(ABC, KOREAN, [state[@"outerPID"] intValue],
        ^NSString * { return state[@"source"]; },
        ^BOOL(pid_t processIdentifier) {
            [state[@"calls"] addObject:[NSString stringWithFormat:@"activate:%d", processIdentifier]];
            state[@"frontmost"] = @(processIdentifier);
            return YES;
        },
        ^pid_t { return [state[@"frontmost"] intValue]; }, partialSelect,
        ^{ [state[@"calls"] addObject:[NSString stringWithFormat:@"close:%@", state[@"source"]]]; });
    NSArray *expectedCleanup = @[
        [@"select:" stringByAppendingString:KOREAN],
        [@"select:" stringByAppendingString:ABC],
        [@"close:" stringByAppendingString:ABC],
        @"activate:100",
        [@"select:" stringByAppendingString:KOREAN]
    ];
    check(cleanupErrors.count == 0 && [state[@"calls"] isEqual:expectedCleanup],
        [NSString stringWithFormat:@"partial Korean failure cleanup selects ABC before closing, restores the outer app, then restores its source (errors %@; calls %@)",
            cleanupErrors, state[@"calls"]]);
    check([state[@"source"] isEqual:KOREAN] && [state[@"frontmost"] intValue] == 100,
        @"partial selection failure cleanup verifies the original source and frontmost process");

    state = fakeState(NO, NO, NO);
    adoptionErrors = [NSMutableArray array];
    keysSent = 0;
    ran = sp_ime_source_run_after_adoption(KOREAN,
        ^BOOL(NSString *source) { state[@"source"] = source; return YES; },
        ^NSString * { return state[@"source"]; }, ^BOOL { return NO; }, ^{ keysSent++; }, adoptionErrors);
    check(!ran && keysSent == 0 && [adoptionErrors.description containsString:@"active input context did not adopt"],
        [NSString stringWithFormat:@"an unadopted context prevents gesture keys (%@; keys %@)", adoptionErrors, @(keysSent)]);

    state = fakeState(NO, NO, NO);
    state[@"source"] = KOREAN;
    NSMutableArray<NSString *> *failedCleanupCalls = [NSMutableArray array];
    cleanupErrors = sp_ime_source_cleanup_errors(ABC, KOREAN, [state[@"outerPID"] intValue],
        ^NSString * { return state[@"source"]; },
        ^BOOL(pid_t processIdentifier) {
            [failedCleanupCalls addObject:[NSString stringWithFormat:@"activate:%d", processIdentifier]];
            state[@"frontmost"] = @(processIdentifier);
            return YES;
        },
        ^pid_t { return [state[@"frontmost"] intValue]; },
        ^BOOL(NSString *source) {
            [failedCleanupCalls addObject:[@"select:" stringByAppendingString:source]];
            return NO;
        },
        ^{ [failedCleanupCalls addObject:[@"close:" stringByAppendingString:state[@"source"]]]; });
    check(failedCleanupCalls.count == 4
        && [failedCleanupCalls[0] isEqual:[@"select:" stringByAppendingString:ABC]]
        && [failedCleanupCalls[1] isEqual:[@"close:" stringByAppendingString:KOREAN]]
        && [failedCleanupCalls[2] isEqual:@"activate:100"]
        && [failedCleanupCalls[3] isEqual:[@"select:" stringByAppendingString:KOREAN]]
        && [cleanupErrors.description containsString:@"not selected and adopted"]
        && [cleanupErrors.description containsString:@"expected com.apple.keylayout.ABC"],
        [NSString stringWithFormat:@"failed ABC cleanup is reported while the context still closes before outer restoration (%@; calls %@)",
            cleanupErrors, failedCleanupCalls]);
    return failures ? 1 : 0;
} }
