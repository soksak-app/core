// A source transition is ready only after the key-view context observes its selection event.
#import <Cocoa/Cocoa.h>
#import "input_source.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static BOOL completionTokenDeallocated = NO;

@interface SPCompletionLifetimeToken : NSObject
@end

@implementation SPCompletionLifetimeToken
- (BOOL)isAlive { return !completionTokenDeallocated; }
- (void)dealloc {
    completionTokenDeallocated = YES;
    [super dealloc];
}
@end

@interface SPControlledInputSourceDriver : NSObject <SPInputSourceSelectionDriver>
@property(copy) NSString *global;
@property(copy) NSString *contextSource;
@property BOOL activeClient;
@property BOOL currentContext;
@property BOOL selectSucceeds;
@property BOOL notifyInsideSelect;
@property BOOL updateContextInsideSelect;
@property BOOL failTimeoutSchedule;
@property BOOL observerRetired;
@property BOOL timeoutRetired;
@property NSUInteger selections;
@property NSUInteger notifications;
@property(copy) void (^changed)(void);
@property(copy) void (^timeoutBlock)(void);
- (void)deliverSelectionNotification;
- (void)fireTimeout;
@end

@implementation SPControlledInputSourceDriver
- (NSString *)globalSource { return self.global; }
- (BOOL)hasActiveTextClient { return self.activeClient; }
- (BOOL)targetContextIsCurrent { return self.currentContext; }
- (NSString *)targetContextFailureDetails {
    return @"capturedWindow=0x1 currentWindow=0x1 windowIsCurrent=1 "
        @"capturedResponder=0x2(ControlledTextResponder) currentResponder=0x2(ControlledTextResponder) "
        @"responderIsCurrent=1 capturedContext=0x3(NSTextInputContext) "
        @"currentContext=0x4(NSTextInputContext) contextIsCurrent=0 "
        @"contextClient=0x2(ControlledTextResponder) clientIsResponder=1";
}
- (NSString *)targetContextSource { return self.contextSource; }
- (BOOL)selectGlobalSource:(NSString *)identifier error:(NSString **)error {
    self.selections++;
    if (self.updateContextInsideSelect) self.contextSource = identifier;
    if (self.notifyInsideSelect) [self deliverSelectionNotification];
    if (!self.selectSucceeds) {
        if (error) *error = @"controlled selection failure";
        return NO;
    }
    self.global = identifier;
    return YES;
}
- (id)observeSelection:(void (^)(void))changed {
    self.changed = changed;
    return @"observer";
}
- (void)removeSelectionObserver:(id)observer {
    if (observer) { self.observerRetired = YES; self.changed = nil; }
}
- (id)scheduleSelectionTimeout:(void (^)(void))timeout {
    if (self.failTimeoutSchedule) return nil;
    self.timeoutBlock = timeout;
    return @"timer";
}
- (void)cancelSelectionTimeout:(id)timer {
    if (timer) { self.timeoutRetired = YES; self.timeoutBlock = nil; }
}
- (void)deliverSelectionNotification {
    self.notifications++;
    if (self.changed) self.changed();
}
- (void)fireTimeout { if (self.timeoutBlock) self.timeoutBlock(); }
- (void)dealloc {
    [_global release]; [_contextSource release]; [_changed release]; [_timeoutBlock release];
    [super dealloc];
}
@end

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    char *current = sp_input_source_current();
    check(current != NULL, @"the current global keyboard source can be read");
    __block NSUInteger noClientCalls = 0;
    __block NSString *noClientError = nil;
    sp_input_source_select_and_await(current, ^(const char *error) {
        noClientCalls++;
        noClientError = error ? @(error) : nil;
    });
    check(noClientCalls == 1 && noClientError == nil,
        @"an idempotent global source request without an active text client completes once");
    free(current);

    SPControlledInputSourceDriver *driver = [[[SPControlledInputSourceDriver alloc] init] autorelease];
    driver.global = @"com.apple.keylayout.ABC";
    driver.contextSource = @"com.apple.keylayout.ABC";
    driver.activeClient = YES;
    driver.currentContext = YES;
    driver.selectSucceeds = YES;
    driver.updateContextInsideSelect = YES;
    __block NSUInteger transitionCalls = 0;
    __block NSString *transitionError = nil;
    __block BOOL retiredBeforeCallback = NO;
    sp_input_source_select_and_await_with_driver("com.apple.inputmethod.Korean.2SetKorean", driver,
        ^(const char *error) {
            transitionCalls++;
            transitionError = error ? @(error) : nil;
            retiredBeforeCallback = driver.observerRetired && driver.timeoutRetired;
        });
    check(transitionCalls == 0,
        @"an active context that reports the new property before its queued notification is not reported ready early");
    check(driver.selections == 1 && driver.changed != nil,
        @"a changed active context observes adoption before global source selection");
    [driver deliverSelectionNotification];
    check(transitionCalls == 1 && transitionError == nil && driver.observerRetired && driver.timeoutRetired,
        [NSString stringWithFormat:@"the active transition completes once after notification and retires its observer and timeout (calls %lu, error %@)",
            (unsigned long)transitionCalls, transitionError]);
    check(retiredBeforeCallback, @"the observer and timeout retire before the completion callback runs");
    [driver deliverSelectionNotification];
    check(transitionCalls == 1, @"a late source notification cannot complete the request twice");

    SPControlledInputSourceDriver *inlineFailure = [[[SPControlledInputSourceDriver alloc] init] autorelease];
    inlineFailure.global = @"com.apple.keylayout.ABC";
    inlineFailure.contextSource = @"com.apple.keylayout.ABC";
    inlineFailure.activeClient = YES;
    inlineFailure.currentContext = YES;
    inlineFailure.notifyInsideSelect = YES;
    inlineFailure.updateContextInsideSelect = YES;
    inlineFailure.selectSucceeds = NO;
    __block NSUInteger failedCalls = 0;
    __block NSString *failedReason = nil;
    sp_input_source_select_and_await_with_driver("com.apple.inputmethod.Korean.2SetKorean", inlineFailure,
        ^(const char *error) { failedCalls++; failedReason = error ? @(error) : nil; });
    check(failedCalls == 1 && [failedReason isEqual:@"controlled selection failure"]
        && inlineFailure.notifications == 1,
        @"a notification delivered inside a failed selection cannot make it succeed");
    check(inlineFailure.observerRetired && inlineFailure.timeoutRetired,
        @"a failed selection retires its observer and timeout before completion");

    SPControlledInputSourceDriver *same = [[[SPControlledInputSourceDriver alloc] init] autorelease];
    same.global = @"com.apple.inputmethod.Korean.2SetKorean";
    same.contextSource = same.global;
    same.activeClient = YES;
    same.currentContext = YES;
    same.selectSucceeds = YES;
    __block NSUInteger sameCalls = 0;
    sp_input_source_select_and_await_with_driver("com.apple.inputmethod.Korean.2SetKorean", same,
        ^(const char *error) { sameCalls++; check(error == NULL, @"an already-selected source has no error"); });
    check(sameCalls == 1 && same.selections == 0,
        @"matching global and active-context sources complete as an idempotent no-op");

    SPControlledInputSourceDriver *globalMismatch = [[[SPControlledInputSourceDriver alloc] init] autorelease];
    globalMismatch.global = @"com.apple.keylayout.ABC";
    globalMismatch.contextSource = @"com.apple.inputmethod.Korean.2SetKorean";
    globalMismatch.activeClient = YES;
    globalMismatch.currentContext = YES;
    globalMismatch.selectSucceeds = YES;
    __block NSUInteger mismatchSourceCalls = 0;
    sp_input_source_select_and_await_with_driver("com.apple.inputmethod.Korean.2SetKorean", globalMismatch,
        ^(const char *error) { mismatchSourceCalls++; check(error == NULL, @"a global-only change has no error"); });
    check(mismatchSourceCalls == 0 && globalMismatch.selections == 1 && globalMismatch.changed != nil
        && !globalMismatch.observerRetired,
        @"a global-source transition observes the active context before selecting even when its property already matches");
    [globalMismatch deliverSelectionNotification];
    check(mismatchSourceCalls == 1 && globalMismatch.observerRetired && globalMismatch.timeoutRetired,
        @"a global-source transition completes only after its source-change notification");

    SPControlledInputSourceDriver *restore = [[[SPControlledInputSourceDriver alloc] init] autorelease];
    restore.global = @"com.apple.keylayout.ABC";
    restore.activeClient = NO;
    restore.selectSucceeds = YES;
    __block NSUInteger restoreCalls = 0;
    sp_input_source_select_and_await_with_driver("com.apple.inputmethod.Korean.2SetKorean", restore,
        ^(const char *error) { restoreCalls++; check(error == NULL, @"global restoration without a text client succeeds"); });
    check(restoreCalls == 1 && restore.selections == 1,
        @"restoration without a text client selects globally and completes without a context notification");

    SPControlledInputSourceDriver *mismatch = [[[SPControlledInputSourceDriver alloc] init] autorelease];
    mismatch.global = @"com.apple.keylayout.ABC";
    mismatch.contextSource = @"com.apple.keylayout.ABC";
    mismatch.activeClient = YES;
    mismatch.currentContext = NO;
    mismatch.selectSucceeds = YES;
    __block NSUInteger mismatchCalls = 0;
    __block NSString *mismatchReason = nil;
    sp_input_source_select_and_await_with_driver("com.apple.inputmethod.Korean.2SetKorean", mismatch,
        ^(const char *error) { mismatchCalls++; mismatchReason = error ? @(error) : nil; });
    check(mismatchCalls == 1 && [mismatchReason containsString:@"contextIsCurrent=0"]
        && [mismatchReason containsString:@"capturedContext=0x3(NSTextInputContext)"]
        && [mismatchReason containsString:@"currentContext=0x4(NSTextInputContext)"]
        && mismatch.selections == 0,
        @"a stale active context rejection identifies captured and current text-context facts");

    SPControlledInputSourceDriver *timedOut = [[[SPControlledInputSourceDriver alloc] init] autorelease];
    timedOut.global = @"com.apple.keylayout.ABC";
    timedOut.contextSource = timedOut.global;
    timedOut.activeClient = YES;
    timedOut.currentContext = YES;
    timedOut.selectSucceeds = YES;
    __block NSUInteger timeoutCalls = 0;
    __block NSString *timeoutReason = nil;
    sp_input_source_select_and_await_with_driver("com.apple.inputmethod.Korean.2SetKorean", timedOut,
        ^(const char *error) { timeoutCalls++; timeoutReason = error ? @(error) : nil; });
    [timedOut fireTimeout];
    [timedOut deliverSelectionNotification];
    check(timeoutCalls == 1 && [timeoutReason containsString:@"after 2 s"]
        && timedOut.observerRetired && timedOut.timeoutRetired,
        @"timeout reports the adoption failure once and retires both pending callbacks");

    SPControlledInputSourceDriver *missingTimer = [[[SPControlledInputSourceDriver alloc] init] autorelease];
    missingTimer.global = @"com.apple.keylayout.ABC";
    missingTimer.contextSource = missingTimer.global;
    missingTimer.activeClient = YES;
    missingTimer.currentContext = YES;
    missingTimer.selectSucceeds = YES;
    missingTimer.failTimeoutSchedule = YES;
    __block NSUInteger timerFailureCalls = 0;
    __block NSString *timerFailureReason = nil;
    sp_input_source_select_and_await_with_driver("com.apple.inputmethod.Korean.2SetKorean", missingTimer,
        ^(const char *error) { timerFailureCalls++; timerFailureReason = error ? @(error) : nil; });
    check(timerFailureCalls == 1 && [timerFailureReason isEqual:@"the input source adoption timeout could not be scheduled"]
        && missingTimer.observerRetired && missingTimer.selections == 0,
        @"failure to schedule the adoption timeout fails the request and removes its observer");

    SPControlledInputSourceDriver *retained = [[SPControlledInputSourceDriver alloc] init];
    retained.global = @"com.apple.keylayout.ABC";
    retained.contextSource = retained.global;
    retained.activeClient = YES;
    retained.currentContext = YES;
    retained.selectSucceeds = YES;
    retained.updateContextInsideSelect = YES;
    __block NSUInteger retainedCalls = 0;
    __block NSString *retainedError = nil;
    completionTokenDeallocated = NO;
    SPCompletionLifetimeToken *token = [[SPCompletionLifetimeToken alloc] init];
    @autoreleasepool {
        sp_input_source_select_and_await_with_driver("com.apple.inputmethod.Korean.2SetKorean", retained,
            ^(const char *error) {
                check([token isAlive], @"the copied completion block remains alive while it runs");
                retainedCalls++;
                retainedError = error ? @(error) : nil;
            });
    }
    [token release];
    check(retainedCalls == 0 && retained.changed != nil,
        @"a pending selection remains alive after its caller's autorelease pool drains");
    [retained deliverSelectionNotification];
    check(retainedCalls == 1 && retainedError == nil && retained.observerRetired && retained.timeoutRetired,
        @"a pending selection completes after its caller's autorelease pool drains");
    [retained release];
    return failures == 0 ? 0 : 1;
} }
