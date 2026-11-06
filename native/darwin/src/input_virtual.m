// The state of the virtual key window and the replaced methods that read it. See input_virtual.h.
//
// Replacing the class of a window breaks the key-value observers of WebKit, so the methods of NSWindow and NSApplication are
// replaced with public method_setImplementation (docs/operations/private-native-apis.md). A replaced method answers with
// the virtual state only while the application is not really active, so a real activation wins from its first moment, before
// its notification arrives. -[WKWebView inputContext] is replaced in the same way and answers differently only while a key
// down with a stated text of the virtual key window is delivered.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#include <stdatomic.h>
#import "event_ring.h"
#import "input_virtual.h"
#import "observe.h"

// Written on the main thread, read on any thread. It holds a retained reference while it is set.
static _Atomic(void *) current;
static id closeObserver, moveMonitor;
static double pointX, pointY;
static bool hasPoint;
static BOOL (*appKitIsKey)(id, SEL), (*appKitIsMain)(id, SEL), (*appKitIsActive)(id, SEL);
static NSWindow *(*appKitKeyWindow)(id, SEL), *(*appKitMainWindow)(id, SEL);
static void (*appKitOrderFront)(id, SEL, id), (*appKitMakeKeyAndOrderFront)(id, SEL, id), (*appKitOrderFrontRegardless)(id, SEL);
static NSTextInputContext *(*webKitInputContext)(id, SEL);
// The web view that takes a key down with a stated text while the key is delivered. Main thread.
static WKWebView *statedTextView;

bool sp_input_virtual_real_active(void) {
    return appKitIsActive ? appKitIsActive(NSApp, @selector(isActive)) : NSApp.isActive;
}

static NSWindow *answering(void) {
    NSWindow *window = (__bridge NSWindow *)atomic_load(&current);
    return window && !sp_input_virtual_real_active() ? window : nil;
}

bool sp_input_virtual_real_key(void *handle) {
    NSWindow *window = (__bridge NSWindow *)handle;
    if (appKitIsKey && (__bridge void *)window == atomic_load(&current)) return appKitIsKey(window, @selector(isKeyWindow));
    return window.isKeyWindow;
}

bool sp_input_virtual_through_application(void *window) {
    return window && sp_input_virtual_real_active() && sp_input_virtual_real_key(window);
}

bool sp_input_virtual_is(void *window) {
    return window && (__bridge void *)answering() == window;
}

bool sp_input_virtual_any(void) {
    return answering() != nil;
}

static BOOL answerIsKey(NSWindow *self, SEL selector) {
    return self == answering() ? YES : appKitIsKey(self, selector);
}

static BOOL answerIsMain(NSWindow *self, SEL selector) {
    return self == answering() ? YES : appKitIsMain(self, selector);
}

static BOOL answerIsActive(id self, SEL selector) {
    return answering() ? YES : appKitIsActive(self, selector);
}

static NSWindow *answerKeyWindow(id self, SEL selector) {
    return answering() ?: appKitKeyWindow(self, selector);
}

static NSWindow *answerMainWindow(id self, SEL selector) {
    return answering() ?: appKitMainWindow(self, selector);
}

static void record(const char *phase, const char *reason) {
    NSString *fields = [NSString stringWithFormat:@"{\"phase\":\"%s\",\"reason\":\"%s\"}", phase, reason];
    sp_event(SP_CLASS_LIFECYCLE, SP_EVENT_INFO, "native.input.virtual", fields.UTF8String);
}

// A virtual key window stays where it is in the order of windows. The order methods answer for any window, so another
// window and a real activation keep their meaning.
static void refuseOrderFront(NSWindow *self, SEL selector, id sender) {
    if (self == answering()) { record("order refused", "orderFront:"); return; }
    appKitOrderFront(self, selector, sender);
}

static void refuseMakeKeyAndOrderFront(NSWindow *self, SEL selector, id sender) {
    if (self == answering()) { record("order refused", "makeKeyAndOrderFront:"); return; }
    appKitMakeKeyAndOrderFront(self, selector, sender);
}

static void refuseOrderFrontRegardless(NSWindow *self, SEL selector) {
    if (self == answering()) { record("order refused", "orderFrontRegardless"); return; }
    appKitOrderFrontRegardless(self, selector);
}

// The input method of the system does not serve the virtual key window, so a web view that takes a key down with a stated text
// answers without an input context while the key is delivered. WebKit then interprets the key with the key bindings, as AppKit
// does for a view without an input context: the text of the event reaches insertText: of the web view as the command of the
// key, and the page receives keydown, keypress, beforeinput and input as for a person's key.
static NSTextInputContext *answerInputContext(WKWebView *self, SEL selector) {
    return self == statedTextView ? nil : webKitInputContext(self, selector);
}

static IMP replace(Class class, SEL selector, IMP implementation) {
    return method_setImplementation(class_getInstanceMethod(class, selector), implementation);
}

static void install(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        Class window = NSWindow.class, application = NSApplication.class;
        appKitIsKey = (BOOL (*)(id, SEL))replace(window, @selector(isKeyWindow), (IMP)answerIsKey);
        appKitIsMain = (BOOL (*)(id, SEL))replace(window, @selector(isMainWindow), (IMP)answerIsMain);
        appKitIsActive = (BOOL (*)(id, SEL))replace(application, @selector(isActive), (IMP)answerIsActive);
        appKitKeyWindow = (NSWindow *(*)(id, SEL))replace(application, @selector(keyWindow), (IMP)answerKeyWindow);
        appKitMainWindow = (NSWindow *(*)(id, SEL))replace(application, @selector(mainWindow), (IMP)answerMainWindow);
        appKitOrderFront = (void (*)(id, SEL, id))replace(window, @selector(orderFront:), (IMP)refuseOrderFront);
        appKitMakeKeyAndOrderFront = (void (*)(id, SEL, id))replace(window, @selector(makeKeyAndOrderFront:), (IMP)refuseMakeKeyAndOrderFront);
        appKitOrderFrontRegardless = (void (*)(id, SEL))replace(window, @selector(orderFrontRegardless), (IMP)refuseOrderFrontRegardless);
        webKitInputContext = (NSTextInputContext *(*)(id, SEL))replace(WKWebView.class, @selector(inputContext), (IMP)answerInputContext);
        sp_observe_notification("input_virtual.app_active", SP_OBSERVE_RECORD, NSApplicationDidBecomeActiveNotification, NSApp, nil,
            ^(NSNotification *note) { if (sp_input_virtual_real_active()) sp_input_virtual_end("activation"); });
    });
}

bool sp_input_virtual_enter(void *handle) {
    NSCAssert(NSThread.isMainThread, @"the virtual key window belongs to the main thread");
    NSWindow *window = (__bridge NSWindow *)handle;
    if (!window || sp_input_virtual_real_active()) return false;
    if (handle == atomic_load(&current)) return true;
    install();
    sp_input_virtual_end("another window");
    atomic_store(&current, (__bridge void *)[window retain]);
    closeObserver = [sp_observe_notification("input_virtual.close", SP_OBSERVE_RECORD, NSWindowWillCloseNotification, window, nil,
        ^(NSNotification *note) { sp_input_virtual_end("closed"); }) retain];
    // A real move holds the position of a person's cursor, so it does not reach a page that a check drives. An injected move
    // does not pass the application and no monitor sees it.
    moveMonitor = [sp_observe_local_monitor("input_virtual.real_move", SP_OBSERVE_COUNT,
        NSEventMaskMouseMoved | NSEventMaskMouseEntered | NSEventMaskMouseExited | NSEventMaskCursorUpdate, ^NSEvent *(NSEvent *event) {
            return event.window && event.window == answering() ? nil : event;
        }) retain];
    NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
    [center postNotificationName:NSWindowDidBecomeKeyNotification object:window];
    [center postNotificationName:NSWindowDidBecomeMainNotification object:window];
    record("entered", "input");
    return true;
}

void sp_input_virtual_end(const char *reason) {
    NSCAssert(NSThread.isMainThread, @"the virtual key window belongs to the main thread");
    NSWindow *window = (__bridge NSWindow *)atomic_load(&current);
    if (!window) return;
    atomic_store(&current, NULL);
    hasPoint = false;
    [NSNotificationCenter.defaultCenter removeObserver:closeObserver];
    [closeObserver release];
    closeObserver = nil;
    [NSEvent removeMonitor:moveMonitor];
    [moveMonitor release];
    moveMonitor = nil;
    record("ended", reason);
    // The window that a real activation made key has heard that from AppKit, and a closing window has no state to resign.
    if (strcmp(reason, "closed") != 0 && !window.isKeyWindow) {
        NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
        [center postNotificationName:NSWindowDidResignKeyNotification object:window];
        [center postNotificationName:NSWindowDidResignMainNotification object:window];
    }
    // It is not released inside the notification of its close, and the turn after it holds no pool that outlives the window.
    dispatch_async(dispatch_get_main_queue(), ^{ [window release]; });
}

void sp_input_virtual_set_point(void *window, double x, double y) {
    if (!sp_input_virtual_is(window)) return;
    pointX = x;
    pointY = y;
    hasPoint = true;
}

bool sp_input_virtual_point(void *window, double *x, double *y) {
    if (!sp_input_virtual_is(window) || !hasPoint) return false;
    *x = pointX;
    *y = pointY;
    return true;
}

// The view that takes the text of a key of window: the nearest view from the first responder up that is a text input client.
static NSView *textInputClient(NSWindow *window) {
    NSResponder *responder = window.firstResponder;
    NSView *view = [responder isKindOfClass:NSView.class] ? (NSView *)responder : nil;
    while (view && ![view respondsToSelector:@selector(insertText:replacementRange:)]) view = view.superview;
    return view;
}

bool sp_input_virtual_type_stated_text(void *handle, void *event) {
    NSCAssert(NSThread.isMainThread, @"the virtual key window belongs to the main thread");
    NSWindow *window = (__bridge NSWindow *)handle;
    NSView *client = textInputClient(window);
    if (!sp_input_virtual_is(window) || ![client isKindOfClass:WKWebView.class]) return false;
    statedTextView = (WKWebView *)client;
    [window sendEvent:(__bridge NSEvent *)event];
    statedTextView = nil;
    return true;
}
