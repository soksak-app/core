#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>
#import "input_reference.h"
#import "observe.h"

static char referenceKey;
static NSDictionary *rangeValue(NSRange range) {
    return @{ @"location": @(range.location), @"length": @(range.length) };
}
static void reply(sp_input_reference_done done, void *context, NSDictionary *value, NSString *failure) {
    if (failure) { done(context, NULL, failure.UTF8String); return; }
    NSError *error = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:&error];
    if (!data) { done(context, NULL, error.localizedDescription.UTF8String); return; }
    NSString *json = [[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] autorelease];
    done(context, json.UTF8String, NULL);
}

@class SPInputReference;
// The main queue retains this token, never the window-associated owner.
@interface SPInputReferenceCheck : NSObject
@property(assign) SPInputReference *reference;
@end
@implementation SPInputReferenceCheck
@end

@interface SPInputReference : NSObject
@property(assign) NSWindow *window;
@property(retain) NSTextView *view;
@property(copy) NSString *expected;
@property(retain) NSTimer *timer;
@property sp_input_reference_done completion;
@property void *context;
@property BOOL checkScheduled;
@property BOOL waitRequiresUnmarked;
@property(retain) SPInputReferenceCheck *check;
- (NSDictionary *)snapshot;
- (void)checkDocument;
- (void)finish:(NSString *)failure;
- (NSString *)close;
@end

@implementation SPInputReference
- (NSDictionary *)snapshot {
    if (!self.view) return @{ @"open": @NO };
    NSView *content = self.window.contentView;
    NSRect rect = [self.view convertRect:self.view.bounds toView:content];
    CGFloat y = content.isFlipped ? rect.origin.y : NSHeight(content.bounds) - NSMaxY(rect);
    NSTextInputContext *context = self.view.inputContext;
    return @{ @"open": @YES, @"document": self.view.string,
        @"selected": rangeValue(self.view.selectedRange),
        @"marked": self.view.hasMarkedText ? rangeValue(self.view.markedRange) : NSNull.null,
        @"focused": self.window.firstResponder == self.view ? @YES : @NO,
        @"inputContextCurrent": context && NSTextInputContext.currentInputContext == context ? @YES : @NO,
        @"frame": @{ @"x": @(rect.origin.x), @"y": @(y), @"w": @(rect.size.width), @"h": @(rect.size.height) } };
}
- (void)finish:(NSString *)failure {
    if (!self.completion) return;
    sp_input_reference_done done = self.completion;
    void *context = self.context;
    self.completion = NULL;
    self.context = NULL;
    [self.timer invalidate];
    self.timer = nil;
    self.expected = nil;
    reply(done, context, failure ? nil : [self snapshot], failure);
}
- (void)checkDocument {
    if (self.completion && [self.view.string isEqual:self.expected]
        && (!self.waitRequiresUnmarked || !self.view.hasMarkedText)) [self finish:nil];
}
- (void)changed:(NSNotification *)notification {
    sp_observe_delivered("input.reference.change");
    // Text-storage notifications can arrive before AppKit updates its selection and marked range.
    if (self.checkScheduled) return;
    self.checkScheduled = YES;
    if (!self.check) {
        self.check = [[[SPInputReferenceCheck alloc] init] autorelease];
        self.check.reference = self;
    }
    SPInputReferenceCheck *check = self.check;
    dispatch_async(dispatch_get_main_queue(), ^{
        SPInputReference *reference = check.reference;
        reference.checkScheduled = NO;
        [reference checkDocument];
    });
}
- (void)windowClosed:(NSNotification *)notification {
    sp_observe_delivered("input.reference.close");
    [self retain];
    NSWindow *window = self.window;
    // A closing window no longer has an input target; removing its reference cannot restore a responder.
    [self finish:@"input reference window closed before the expected document"];
    [NSNotificationCenter.defaultCenter removeObserver:self];
    [self.view removeFromSuperview];
    self.view = nil;
    self.window = nil;
    objc_setAssociatedObject(window, &referenceKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    [self release];
}
- (NSString *)close {
    if (self.window.firstResponder == self.view && ![self.window makeFirstResponder:nil]) {
        return @"input reference refused to resign first responder";
    }
    [self finish:@"input reference closed before the expected document"];
    [NSNotificationCenter.defaultCenter removeObserver:self];
    [self.view removeFromSuperview];
    self.view = nil;
    self.window = nil;
    return nil;
}
- (void)dealloc {
    _check.reference = nil;
    [_check release];
    [self finish:@"input reference window released before the expected document"];
    [NSNotificationCenter.defaultCenter removeObserver:self];
    [_view removeFromSuperview];
    [_view release];
    [_timer invalidate];
    [_timer release];
    [_expected release];
    [super dealloc];
}
@end

void sp_input_reference(void *pointer, const char *action, const char *expected, sp_input_reference_done done, void *context) {
    @autoreleasepool {
        if (!done) { NSLog(@"error: input reference: completion callback is required"); return; }
        if (!NSThread.isMainThread) { reply(done, context, nil, @"input reference requires the main thread"); return; }
        NSString *operation = action ? [NSString stringWithUTF8String:action] : nil;
        if (![@[@"open", @"read", @"focus", @"wait-document", @"wait", @"close"] containsObject:operation ?: @""]) {
            reply(done, context, nil, @"input reference action must be open, read, focus, wait-document, wait or close"); return;
        }
        BOOL waits = [operation isEqual:@"wait"] || [operation isEqual:@"wait-document"];
        BOOL waitRequiresUnmarked = [operation isEqual:@"wait"];
        NSString *document = expected ? [NSString stringWithUTF8String:expected] : nil;
        if ((waits && !document) || (!waits && expected)) {
            reply(done, context, nil, @"input reference document is required only for wait-document and wait and must be valid UTF-8"); return;
        }
        NSWindow *window = pointer;
        if (!window || !window.contentView) { reply(done, context, nil, @"input reference requires a window with a content view"); return; }
        SPInputReference *reference = [objc_getAssociatedObject(window, &referenceKey) retain];
        @try {
            if ([operation isEqual:@"close"]) {
                NSString *failure = [reference close];
                if (!failure) objc_setAssociatedObject(window, &referenceKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
                reply(done, context, @{ @"open": @NO }, failure);
                return;
            }
            if ([operation isEqual:@"open"] && !reference) {
                NSView *content = window.contentView;
                NSRect bounds = content.bounds;
                if (NSWidth(bounds) < 80 || NSHeight(bounds) < 80) {
                    reply(done, context, nil, @"input reference requires a content area of at least 80 by 80 points"); return;
                }
                CGFloat width = MIN(360, NSWidth(bounds) - 40), height = MIN(160, NSHeight(bounds) - 40);
                CGFloat y = content.isFlipped ? 20 : NSHeight(bounds) - 20 - height;
                reference = [[SPInputReference alloc] init];
                reference.window = window;
                reference.view = [[[NSTextView alloc] initWithFrame:NSMakeRect(20, y, width, height)] autorelease];
                reference.view.richText = NO;
                reference.view.autoresizingMask = content.isFlipped ? NSViewMaxYMargin : NSViewMinYMargin;
                BOOL observed = sp_observe_notification_selector("input.reference.close", SP_OBSERVE_RECORD, reference, @selector(windowClosed:), NSWindowWillCloseNotification, window);
                for (NSArray *entry in @[@[NSTextDidChangeNotification, reference.view],
                    @[NSTextViewDidChangeSelectionNotification, reference.view],
                    @[NSTextStorageDidProcessEditingNotification, reference.view.textStorage]]) {
                    observed = sp_observe_notification_selector("input.reference.change", SP_OBSERVE_RECORD, reference, @selector(changed:), entry[0], entry[1]) && observed;
                }
                if (!observed) { [reference close]; reply(done, context, nil, @"input reference observation could not be registered"); return; }
                [content addSubview:reference.view positioned:NSWindowAbove relativeTo:nil];
                objc_setAssociatedObject(window, &referenceKey, reference, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
            }
            if ([operation isEqual:@"focus"]) {
                if (!reference) { reply(done, context, nil, @"input reference is closed"); return; }
                if (![window makeFirstResponder:reference.view]) { reply(done, context, nil, @"input reference refused first responder"); return; }
            }
            if (!waits) { reply(done, context, reference ? [reference snapshot] : @{ @"open": @NO }, nil); return; }
            if (!reference) { reply(done, context, nil, @"input reference is closed"); return; }
            if (reference.completion) { reply(done, context, nil, @"input reference already has a pending wait"); return; }
            reference.expected = document;
            reference.waitRequiresUnmarked = waitRequiresUnmarked;
            reference.completion = done;
            reference.context = context;
            __block SPInputReference *timerReference = reference;
            reference.timer = sp_observe_timer("input.reference.timeout", SP_OBSERVE_RECORD, 5, NO,
                @"input reference document wait", ^(NSTimer *timer) {
                [timerReference finish:[NSString stringWithFormat:@"input reference did not reach the expected document within 5 seconds: %@", [timerReference snapshot]]];
            });
            if (!reference.timer) [reference finish:@"input reference timeout registration failed"];
            [reference checkDocument];
        } @finally {
            [reference release];
        }
    }
}
