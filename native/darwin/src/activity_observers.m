#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>
#import "activity_observers.h"
#import "event_ring.h"
#import "observe.h"

static void emit(uint8_t eventClass, NSString *name, NSDictionary *fields) {
    NSError *error = nil;
    NSData *json = [NSJSONSerialization dataWithJSONObject:fields options:0 error:&error];
    if (!json) {
        NSLog(@"activity event %@ cannot be serialized: %@", name, error);
        return;
    }
    NSString *text = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
    // events: forwarded
    sp_event(eventClass, SP_EVENT_INFO, name.UTF8String, text.UTF8String);
    [text release];
}

static NSDictionary *windowFields(NSNotification *note) {
    NSWindow *window = note.object;
    if (![window isKindOfClass:NSWindow.class]) return @{};
    return @{@"window": @(window.windowNumber), @"first_responder": NSStringFromClass([window.firstResponder class])};
}

// The first responder of a window changes without a notification, and observing the window with key-value observing
// conflicts with the window classes of the hosts. The state after each update of a window is compared with the state at its
// earlier update, so a change is recorded when the window next updates; a move that the window undoes within one update is
// not recorded. The identity of the last first responder is compared as an integer, so an update that finds no change
// allocates nothing. The state is an associated object of its window, so it ends with the window and holds no reference to
// the window or to the responder.
@interface ResponderState : NSObject {
@public
    uintptr_t identity;
    NSString *name;
}
@end

@implementation ResponderState
- (void)dealloc {
    [name release];
    [super dealloc];
}
@end

static const void *lastResponderKey = &lastResponderKey;

static void recordResponder(NSWindow *window) {
    NSResponder *responder = window.firstResponder;
    uintptr_t identity = (uintptr_t)(__bridge const void *)responder;
    ResponderState *before = objc_getAssociatedObject(window, lastResponderKey);
    if (before && before->identity == identity) return;
    ResponderState *now = [[ResponderState alloc] init];
    now->identity = identity;
    now->name = [(responder ? NSStringFromClass([responder class]) : @"") copy];
    // The event is emitted before the association is replaced, because replacing it releases the state that `before` points to.
    if (before) emit(SP_CLASS_INPUT, @"native.window.first_responder", @{@"window": @(window.windowNumber), @"from": before->name, @"to": now->name});
    objc_setAssociatedObject(window, lastResponderKey, now, OBJC_ASSOCIATION_RETAIN);
    [now release];
}

void sp_observe_activity(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSDictionary<NSNotificationName, NSString *> *application = @{
            NSApplicationDidBecomeActiveNotification: @"native.app.activated",
            NSApplicationDidResignActiveNotification: @"native.app.deactivated",
            NSApplicationDidHideNotification: @"native.app.hidden",
            NSApplicationDidUnhideNotification: @"native.app.unhidden",
        };
        // events: native.app.activated, native.app.deactivated, native.app.hidden, native.app.unhidden
        for (NSNotificationName notification in application) {
            NSString *name = application[notification];
            sp_observe_notification("activity.app", SP_OBSERVE_STORED, notification, nil, nil, ^(NSNotification *note) { emit(SP_CLASS_LIFECYCLE, name, @{}); });
        }
        NSDictionary<NSNotificationName, NSString *> *windows = @{
            NSWindowDidBecomeKeyNotification: @"native.window.key",
            NSWindowDidResignKeyNotification: @"native.window.resign_key",
            NSWindowDidBecomeMainNotification: @"native.window.main",
            NSWindowDidResignMainNotification: @"native.window.resign_main",
            NSWindowDidMiniaturizeNotification: @"native.window.miniaturized",
            NSWindowDidDeminiaturizeNotification: @"native.window.deminiaturized",
        };
        // events: native.window.key, native.window.resign_key, native.window.main, native.window.resign_main, native.window.miniaturized, native.window.deminiaturized
        for (NSNotificationName notification in windows) {
            NSString *name = windows[notification];
            sp_observe_notification("activity.window", SP_OBSERVE_STORED, notification, nil, nil, ^(NSNotification *note) { emit(SP_CLASS_LIFECYCLE, name, windowFields(note)); });
        }
        // A window updates at the rate of its frames, so the deliveries are counted and the change of the first responder is the event.
        sp_observe_notification("activity.update", SP_OBSERVE_COUNT, NSWindowDidUpdateNotification, nil, nil, ^(NSNotification *note) {
            if ([note.object isKindOfClass:NSWindow.class]) recordResponder(note.object);
        });
        sp_observe_notification("activity.occlusion", SP_OBSERVE_STORED, NSWindowDidChangeOcclusionStateNotification, nil, nil, ^(NSNotification *note) {
            NSWindow *window = note.object;
            if (![window isKindOfClass:NSWindow.class]) return;
            emit(SP_CLASS_LIFECYCLE, @"native.window.occlusion", @{@"window": @(window.windowNumber),
                @"visible": [NSNumber numberWithBool:(window.occlusionState & NSWindowOcclusionStateVisible) != 0]});
        });
        sp_observe_notification("activity.input_source", SP_OBSERVE_STORED, NSTextInputContextKeyboardSelectionDidChangeNotification, nil, nil, ^(NSNotification *note) {
            emit(SP_CLASS_INPUT, @"native.input.source_changed", @{});
        });
    });
}
