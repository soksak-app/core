#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>
#import "activity_observers.h"
#import "event_ring.h"

static void emit(NSString *name, NSDictionary *fields) {
    NSError *error = nil;
    NSData *json = [NSJSONSerialization dataWithJSONObject:fields options:0 error:&error];
    if (!json) {
        NSLog(@"activity event %@ cannot be serialized: %@", name, error);
        return;
    }
    NSString *text = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
    sp_event(SP_EVENT_INFO, name.UTF8String, text.UTF8String);
}

static NSDictionary *windowFields(NSNotification *note) {
    NSWindow *window = note.object;
    if (![window isKindOfClass:NSWindow.class]) return @{};
    return @{@"window": @(window.windowNumber), @"first_responder": NSStringFromClass([window.firstResponder class])};
}

// The first responder of a window changes without a notification, and observing the window with key-value observing
// conflicts with the window classes of the hosts. The state after each update of a window is compared with the state at its
// earlier update, so a change is recorded when the window next updates; a move that the window undoes within one update is
// not recorded. The last first responder is an associated object of its window, so it ends with the window and holds no
// reference to it.
static const void *lastResponderKey = &lastResponderKey;

static void recordResponder(NSWindow *window) {
    NSResponder *responder = window.firstResponder;
    NSString *name = responder ? NSStringFromClass([responder class]) : @"";
    NSValue *identity = [NSValue valueWithPointer:(__bridge const void *)responder];
    NSDictionary *before = objc_getAssociatedObject(window, lastResponderKey);
    objc_setAssociatedObject(window, lastResponderKey, @{@"class": name, @"identity": identity}, OBJC_ASSOCIATION_RETAIN);
    if (!before || [before[@"identity"] isEqual:identity]) return;
    emit(@"native.window.first_responder", @{@"window": @(window.windowNumber), @"from": before[@"class"], @"to": name});
}

void sp_observe_activity(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
        NSDictionary<NSNotificationName, NSString *> *application = @{
            NSApplicationDidBecomeActiveNotification: @"native.app.activated",
            NSApplicationDidResignActiveNotification: @"native.app.deactivated",
            NSApplicationDidHideNotification: @"native.app.hidden",
            NSApplicationDidUnhideNotification: @"native.app.unhidden",
        };
        for (NSNotificationName notification in application) {
            NSString *name = application[notification];
            [center addObserverForName:notification object:nil queue:nil usingBlock:^(NSNotification *note) { emit(name, @{}); }];
        }
        NSDictionary<NSNotificationName, NSString *> *windows = @{
            NSWindowDidBecomeKeyNotification: @"native.window.key",
            NSWindowDidResignKeyNotification: @"native.window.resign_key",
            NSWindowDidBecomeMainNotification: @"native.window.main",
            NSWindowDidResignMainNotification: @"native.window.resign_main",
            NSWindowDidMiniaturizeNotification: @"native.window.miniaturized",
            NSWindowDidDeminiaturizeNotification: @"native.window.deminiaturized",
        };
        for (NSNotificationName notification in windows) {
            NSString *name = windows[notification];
            [center addObserverForName:notification object:nil queue:nil usingBlock:^(NSNotification *note) { emit(name, windowFields(note)); }];
        }
        [center addObserverForName:NSWindowDidUpdateNotification object:nil queue:nil usingBlock:^(NSNotification *note) {
            if ([note.object isKindOfClass:NSWindow.class]) recordResponder(note.object);
        }];
        [center addObserverForName:NSWindowDidChangeOcclusionStateNotification object:nil queue:nil usingBlock:^(NSNotification *note) {
            NSWindow *window = note.object;
            if (![window isKindOfClass:NSWindow.class]) return;
            emit(@"native.window.occlusion", @{@"window": @(window.windowNumber),
                @"visible": @((window.occlusionState & NSWindowOcclusionStateVisible) != 0)});
        }];
        [center addObserverForName:NSTextInputContextKeyboardSelectionDidChangeNotification object:nil queue:nil usingBlock:^(NSNotification *note) {
            emit(@"native.input.source_changed", @{});
        }];
    });
}
