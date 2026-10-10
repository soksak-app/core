#import <Cocoa/Cocoa.h>
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
