// Reads and changes the selected keyboard input source. Uses the public Text Input Source Services and AppKit APIs.
#import <Carbon/Carbon.h>
#import <Cocoa/Cocoa.h>
#import "input_source.h"
#import "application_log.h"
#import "observe.h"

char *sp_input_source_current(void) {
    NSCAssert(NSThread.isMainThread, @"input sources are read on the main thread");
    TISInputSourceRef current = TISCopyCurrentKeyboardInputSource();
    if (!current) {
        sp_log_error("input source", "the system returned no current keyboard input source");
        return NULL;
    }
    NSString *identifier = (NSString *)TISGetInputSourceProperty(current, kTISPropertyInputSourceID);
    char *result = identifier ? strdup(identifier.UTF8String) : NULL;
    CFRelease(current);
    return result;
}

@interface SPLiveInputSourceSelectionDriver : NSObject <SPInputSourceSelectionDriver>
@property(assign) NSWindow *window;
@property(assign) id responder;
@property(retain) NSTextInputContext *context;
@end

@implementation SPLiveInputSourceSelectionDriver
- (instancetype)init {
    if ((self = [super init])) {
        self.window = NSApp.keyWindow;
        self.responder = self.window.firstResponder;
        if ([self.responder conformsToProtocol:@protocol(NSTextInputClient)]
            && [self.responder respondsToSelector:@selector(inputContext)]) {
            self.context = [self.responder inputContext];
        }
    }
    return self;
}
- (NSString *)globalSource {
    TISInputSourceRef current = TISCopyCurrentKeyboardInputSource();
    if (!current) return nil;
    NSString *identifier = [(NSString *)TISGetInputSourceProperty(current, kTISPropertyInputSourceID) copy];
    CFRelease(current);
    return [identifier autorelease];
}
- (BOOL)hasActiveTextClient {
    return [self.responder conformsToProtocol:@protocol(NSTextInputClient)];
}
- (BOOL)targetContextIsCurrent {
    return self.window && self.window == NSApp.keyWindow && self.window.firstResponder == self.responder
        && self.context && NSTextInputContext.currentInputContext == self.context
        && self.context.client == self.responder;
}
- (NSString *)targetContextFailureDetails {
    NSWindow *currentWindow = NSApp.keyWindow;
    id currentResponder = self.window.firstResponder;
    NSTextInputContext *currentContext = NSTextInputContext.currentInputContext;
    id contextClient = self.context.client;
    NSString *capturedResponderClass = self.responder ? NSStringFromClass([self.responder class]) : @"<nil>";
    NSString *currentResponderClass = currentResponder ? NSStringFromClass([currentResponder class]) : @"<nil>";
    NSString *capturedContextClass = self.context ? NSStringFromClass([self.context class]) : @"<nil>";
    NSString *currentContextClass = currentContext ? NSStringFromClass([currentContext class]) : @"<nil>";
    NSString *contextClientClass = contextClient ? NSStringFromClass([contextClient class]) : @"<nil>";
    return [NSString stringWithFormat:
        @"capturedWindow=%p currentKeyWindow=%p windowIsCurrent=%d "
        @"capturedResponder=%p(%@) currentResponder=%p(%@) responderIsCurrent=%d "
        @"capturedContext=%p(%@) currentContext=%p(%@) contextIsCurrent=%d "
        @"contextClient=%p(%@) clientIsResponder=%d",
        (void *)self.window, (void *)currentWindow, self.window == currentWindow,
        (void *)self.responder, capturedResponderClass, (void *)currentResponder, currentResponderClass,
        currentResponder == self.responder, (void *)self.context, capturedContextClass,
        (void *)currentContext, currentContextClass, currentContext == self.context,
        (void *)contextClient, contextClientClass, contextClient == self.responder];
}
- (NSString *)targetContextSource {
    return self.context.selectedKeyboardInputSource;
}
- (BOOL)selectGlobalSource:(NSString *)identifier error:(NSString **)error {
    NSArray *sources = (NSArray *)TISCreateInputSourceList(
        (CFDictionaryRef)@{(id)kTISPropertyInputSourceID: identifier}, false);
    OSStatus status = sources.count > 0 ? TISSelectInputSource((TISInputSourceRef)sources[0]) : paramErr;
    if (status != noErr) {
        NSString *reason = [NSString stringWithFormat:@"selecting %@ failed: %@ (status %d)", identifier,
            sources.count > 0 ? @"the system refused it" : @"no input source has this identifier", (int)status];
        if (error) *error = reason;
        sp_log_error("input source", reason.UTF8String);
    }
    [sources release];
    return status == noErr;
}
- (id)observeSelection:(void (^)(void))changed {
    return sp_observe_notification("input_source.selection", SP_OBSERVE_RECORD,
        NSTextInputContextKeyboardSelectionDidChangeNotification, nil, NSOperationQueue.mainQueue,
        ^(NSNotification *notification) { changed(); });
}
- (void)removeSelectionObserver:(id)observer {
    if (observer) [NSNotificationCenter.defaultCenter removeObserver:observer];
}
- (id)scheduleSelectionTimeout:(void (^)(void))timeout {
    return sp_observe_timer("input_source.selection.timeout", SP_OBSERVE_RECORD, 2, NO,
        @"key-view source adoption", ^(NSTimer *timer) { timeout(); });
}
- (void)cancelSelectionTimeout:(id)timer {
    [(NSTimer *)timer invalidate];
}
- (void)dealloc {
    [_context release];
    [super dealloc];
}
@end

@interface SPInputSourceSelection : NSObject
@property(copy) NSString *identifier;
@property(retain) id<SPInputSourceSelectionDriver> driver;
@property(copy) void (^completion)(const char *error);
@property(retain) id observer;
@property(retain) id timer;
@property BOOL selectionReturned;
@property BOOL selectionSucceeded;
@property BOOL notificationSeen;
@property BOOL finished;
- (void)start;
- (void)notification;
- (void)timeout;
- (void)finish:(NSString *)error;
@end

@implementation SPInputSourceSelection
- (void)start {
    if (![self.driver hasActiveTextClient]) {
        NSString *error = nil;
        BOOL selected = [self.driver selectGlobalSource:self.identifier error:&error];
        self.selectionReturned = YES;
        self.selectionSucceeded = selected;
        [self finish:selected ? nil : (error ?: @"the input source selection failed")];
        return;
    }
    if (![self.driver targetContextIsCurrent]) {
        NSString *details = [self.driver targetContextFailureDetails];
        [self finish:[NSString stringWithFormat:@"the key responder's text input context is not current (%@)",
            details ?: @"identity details unavailable"]];
        return;
    }
    NSString *globalBefore = [self.driver globalSource];
    NSString *contextBefore = [self.driver targetContextSource];
    if (!globalBefore || !contextBefore) {
        [self finish:@"the selected keyboard input source of the key view could not be read"];
        return;
    }
    if ([globalBefore isEqualToString:self.identifier] && [contextBefore isEqualToString:self.identifier]) {
        [self finish:nil];
        return;
    }

    // These callbacks own the selection until finish removes the observer and invalidates the timer.
    self.observer = [self.driver observeSelection:^{ [self notification]; }];
    if (!self.observer) {
        [self finish:@"keyboard source selection changes cannot be observed"];
        return;
    }
    self.timer = [self.driver scheduleSelectionTimeout:^{ [self timeout]; }];
    if (!self.timer) {
        [self finish:@"the input source adoption timeout could not be scheduled"];
        return;
    }
    NSString *error = nil;
    BOOL selected = [self.driver selectGlobalSource:self.identifier error:&error];
    self.selectionReturned = YES;
    self.selectionSucceeded = selected;
    if (!selected) {
        [self finish:error ?: @"the input source selection failed"];
        return;
    }
    if (self.notificationSeen && [self.driver targetContextIsCurrent]
        && [[self.driver targetContextSource] isEqualToString:self.identifier]) [self finish:nil];
}
- (void)notification {
    if (self.finished) return;
    self.notificationSeen = YES;
    if (!self.selectionReturned || !self.selectionSucceeded) return;
    if (![self.driver targetContextIsCurrent]) return;
    if ([[self.driver targetContextSource] isEqualToString:self.identifier]) [self finish:nil];
}
- (void)timeout {
    if (self.finished) return;
    NSString *held = [self.driver targetContextSource] ?: @"no active key-view context";
    [self finish:[NSString stringWithFormat:@"the key view's text input context holds %@, not %@, after 2 s",
        held, self.identifier]];
}
- (void)finish:(NSString *)error {
    [self retain];
    if (self.finished) {
        [self release];
        return;
    }
    self.finished = YES;
    id observer = self.observer;
    self.observer = nil;
    [self.driver removeSelectionObserver:observer];
    id timer = self.timer;
    self.timer = nil;
    [self.driver cancelSelectionTimeout:timer];
    void (^completion)(const char *) = [self.completion copy];
    self.completion = nil;
    if (completion) completion(error ? error.UTF8String : NULL);
    [completion release];
    [self release];
}
- (void)dealloc {
    [_identifier release];
    [_driver release];
    [_completion release];
    [_observer release];
    [_timer release];
    [super dealloc];
}
@end

void sp_input_source_select_and_await_with_driver(const char *identifier, id<SPInputSourceSelectionDriver> driver,
    void (^adopted)(const char *error)) {
    NSCAssert(NSThread.isMainThread, @"input sources are selected on the main thread");
    if (!adopted) { sp_log_error("input source", "the adoption callback is required"); return; }
    NSString *wanted = identifier ? [NSString stringWithUTF8String:identifier] : nil;
    if (!wanted) { adopted("the identifier to select is missing or not valid UTF-8"); return; }
    if (!driver) { adopted("the input source selection driver is missing"); return; }
    SPInputSourceSelection *selection = [[[SPInputSourceSelection alloc] init] autorelease];
    selection.identifier = wanted;
    selection.driver = driver;
    selection.completion = adopted;
    [selection start];
}

void sp_input_source_select_and_await(const char *identifier, void (^adopted)(const char *error)) {
    NSCAssert(NSThread.isMainThread, @"input sources are selected on the main thread");
    SPLiveInputSourceSelectionDriver *driver = [[[SPLiveInputSourceSelectionDriver alloc] init] autorelease];
    sp_input_source_select_and_await_with_driver(identifier, driver, adopted);
}
