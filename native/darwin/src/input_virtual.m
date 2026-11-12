// The state of the virtual key window and the replaced methods that read it. See input_virtual.h.
//
// Replacing the class of a window breaks the key-value observers of WebKit, so the methods of NSWindow and NSApplication are
// replaced with public method_setImplementation (docs/operations/private-native-apis.md). A replaced method answers with
// the virtual state only while the application is not really active, so a real activation wins from its first moment, before
// its notification arrives. -[NSView inputContext] is replaced in the same way and answers differently only while a key down
// of the virtual key window is delivered to a web view without its input context.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#include <stdatomic.h>
#import "event_ring.h"
#import "input_virtual.h"
#import "observe.h"

// An observation of the cursor of one window. It refers to the window weakly.
@interface SPCursorObserver : NSObject {
@public
    id window;
}
@property(nonatomic, copy) void (^changed)(void);
@end
@implementation SPCursorObserver
- (void)dealloc {
    objc_storeWeak(&window, nil);
    [_changed release];
    [super dealloc];
}
@end

// Written on the main thread, read on any thread. It holds a retained reference while it is set.
static _Atomic(void *) current;
static id closeObserver, sheetObserver;
// The windows that the emulated input drives: each window that became the virtual key window since the last real activation,
// until it closes. A real move does not reach them while the set holds a window. Main thread; the set refers to them weakly.
static NSHashTable<NSWindow *> *drivenWindows;
static id drivenCloseObserver, moveMonitor;
// Set while the virtual key window moves between a sheet and the window it is attached to, whose main window does not change.
static BOOL keepMain;
static double pointX, pointY;
static bool hasPoint;
static BOOL (*appKitIsKey)(id, SEL), (*appKitIsMain)(id, SEL), (*appKitIsActive)(id, SEL), (*appKitPrivateIsKey)(id, SEL);
static NSWindow *(*appKitKeyWindow)(id, SEL), *(*appKitMainWindow)(id, SEL), *(*appKitPrivateKeyWindow)(id, SEL);
static void (*appKitOrderFront)(id, SEL, id), (*appKitMakeKeyAndOrderFront)(id, SEL, id), (*appKitOrderFrontRegardless)(id, SEL);
static void (*appKitMakeKeyWindow)(id, SEL);
static void (*appKitCursorSet)(id, SEL);
static NSCursor *(*appKitCurrentCursor)(id, SEL);
static NSPoint (*appKitMouseLocation)(id, SEL);
static NSInteger (*appKitWindowNumberAtPoint)(id, SEL, NSPoint, NSInteger);
static void (*appKitAddCursorRect)(id, SEL, NSRect, NSCursor *);
// The cursor that the application set for the virtual key window, and the observations of the cursor of a window. Main thread.
static NSCursor *virtualCursor;
static NSHashTable *cursorObservers;
// The cursor rects that resetCursorRects of a view adds while they are collected, or nil. Main thread.
static NSMutableArray<NSArray *> *collectedRects;
static NSTextInputContext *(*appKitInputContext)(id, SEL);
// The web view that takes a key down without its input context while the key is delivered. Main thread.
static WKWebView *keyWebView;

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

// The key state that AppKit reads inside its own event handling, such as the decision of -[NSWindow sendEvent:] whether a left
// press is the first click that activates the window, which it then gives to the view only when the view accepts the first
// mouse. It reads the flag of the window, not -isKeyWindow, so the virtual key window answers here as well.
static BOOL answerPrivateIsKey(NSWindow *self, SEL selector) {
    return self == answering() ? YES : appKitPrivateIsKey(self, selector);
}

// The main window of a key window: a sheet does not become main, so while a sheet is key its parent, or the parent of a sheet
// that is itself a sheet, stays the main window, as AppKit keeps it while a person types into the sheet.
static NSWindow *mainOf(NSWindow *window) {
    while (window.sheetParent) window = window.sheetParent;
    return window;
}

static BOOL answerIsMain(NSWindow *self, SEL selector) {
    NSWindow *virtual = answering();
    return virtual ? self == mainOf(virtual) : appKitIsMain(self, selector);
}

static BOOL answerIsActive(id self, SEL selector) {
    return answering() ? YES : appKitIsActive(self, selector);
}

static NSWindow *answerKeyWindow(id self, SEL selector) {
    return answering() ?: appKitKeyWindow(self, selector);
}

// The key window that AppKit reads inside its own event handling: -[NSApplication sendEvent:] gives a key down or up to this
// window, not to the window of the event, and drops a key without it. It reads the reference of the application, not
// -keyWindow, so the virtual key window answers here as well.
static NSWindow *answerPrivateKeyWindow(id self, SEL selector) {
    return answering() ?: appKitPrivateKeyWindow(self, selector);
}

static NSWindow *answerMainWindow(id self, SEL selector) {
    return mainOf(answering()) ?: appKitMainWindow(self, selector);
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

static bool enter(NSWindow *window, const char *reason);
static void forgetDriven(NSWindow *window);

// The key equivalent of the default button of a window, which -[NSWindow becomeKeyWindow] gives back to the default button cell
// (Return) and -[NSWindow resignKeyWindow] takes from it, so Return presses the default button only of the key window. Private
// (docs/operations/private-native-apis.md): the virtual key window does not pass those methods, so it gives and takes the key
// equivalent as they do. Without it Return does not press the default button of the virtual key window, such as the first button of
// an alert sheet.
static void setDefaultButtonKey(NSWindow *window, BOOL key) {
    SEL selector = NSSelectorFromString(key ? @"_enableEnablingKeyEquivalentForDefaultButtonCell"
        : @"_disableEnablingKeyEquivalentForDefaultButtonCell");
    NSCAssert([window respondsToSelector:selector], @"AppKit gives and takes the key equivalent of the default button");
    [window performSelector:selector];
}

// While the application answers as active, a request of the application to make another window key moves the virtual key
// window there, as it makes that window key in an active application, so the windows hear the change of their key state as
// they do from a person's activation. The system key window does not change. The order of the other window keeps its meaning.
static BOOL movesKey(NSWindow *window) {
    NSWindow *virtual = answering();
    return virtual && window != virtual && window.canBecomeKeyWindow;
}

static void refuseMakeKeyAndOrderFront(NSWindow *self, SEL selector, id sender) {
    if (self == answering()) { record("order refused", "makeKeyAndOrderFront:"); return; }
    if (movesKey(self)) {
        appKitOrderFront(self, @selector(orderFront:), sender);
        enter(self, "key request");
        return;
    }
    appKitMakeKeyAndOrderFront(self, selector, sender);
}

static void moveMakeKeyWindow(NSWindow *self, SEL selector) {
    if (self == answering()) return;
    if (movesKey(self)) { enter(self, "key request"); return; }
    appKitMakeKeyWindow(self, selector);
}

static void refuseOrderFrontRegardless(NSWindow *self, SEL selector) {
    if (self == answering()) { record("order refused", "orderFrontRegardless"); return; }
    appKitOrderFrontRegardless(self, selector);
}

// The pointer of the application is the injected point of the virtual key window, as the pointer of a person is for a key
// window of an active application: +[NSEvent mouseLocation] answers it, and +[NSWindow windowNumberAtPoint:belowWindowWithWindowNumber:]
// answers the virtual key window for it, also while other windows cover it. WebKit sets the cursor of a page only for the window
// under that point (PageClientImpl::setCursor), so the page under the injected point sets its cursor.
static bool injectedScreenPoint(NSPoint *screen) {
    NSWindow *window = NSThread.isMainThread ? answering() : nil;
    if (!window || !hasPoint) return false;
    *screen = [window convertPointToScreen:NSMakePoint(pointX, pointY)];
    return true;
}

static NSPoint answerMouseLocation(id self, SEL selector) {
    NSPoint screen;
    return injectedScreenPoint(&screen) ? screen : appKitMouseLocation(self, selector);
}

static NSInteger answerWindowNumberAtPoint(id self, SEL selector, NSPoint point, NSInteger below) {
    NSPoint screen;
    if (below == 0 && injectedScreenPoint(&screen) && NSEqualPoints(point, screen)) return answering().windowNumber;
    return appKitWindowNumberAtPoint(self, selector, point, below);
}

static void cursorChanged(NSWindow *window) {
    for (SPCursorObserver *observer in cursorObservers.allObjects) {
        if (objc_loadWeak(&observer->window) == window) observer.changed();
    }
}

// The cursor that the application sets while the virtual key window answers is the cursor of that window: the system cursor of a
// person does not change, and +[NSCursor currentCursor] answers the cursor of the window.
static void keepCursor(NSCursor *self, SEL selector) {
    NSWindow *window = NSThread.isMainThread ? answering() : nil;
    if (!window) { appKitCursorSet(self, selector); return; }
    if (virtualCursor == self) return;
    [virtualCursor release];
    virtualCursor = [self retain];
    cursorChanged(window);
}

static NSCursor *answerCurrentCursor(id self, SEL selector) {
    if (NSThread.isMainThread && answering() && virtualCursor) return virtualCursor;
    return appKitCurrentCursor(self, selector);
}

static void collectCursorRect(NSView *self, SEL selector, NSRect rect, NSCursor *cursor) {
    if (collectedRects && cursor) { [collectedRects addObject:@[[NSValue valueWithRect:rect], cursor]]; return; }
    appKitAddCursorRect(self, selector, rect, cursor);
}

// The input method of the system does not serve the virtual key window, so a web view that takes a key down of it answers without
// an input context while the key is delivered. WebKit reads the input context of a web view through the method of NSView, which
// -[WKWebView inputContext] calls too, so the replacement of that method answers every reader of it. WebKit then interprets the
// key with the key bindings, as AppKit does for a view without an input context: the text of the event reaches insertText: of the
// web view as the command of the key, and a named key runs its command, such as deleteBackward: for Backspace.
static NSTextInputContext *answerInputContext(NSView *self, SEL selector) {
    return self == keyWebView ? nil : appKitInputContext(self, selector);
}

static IMP replace(Class class, SEL selector, IMP implementation) {
    return method_setImplementation(class_getInstanceMethod(class, selector), implementation);
}

static void install(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        Class window = NSWindow.class, application = NSApplication.class;
        appKitIsKey = (BOOL (*)(id, SEL))replace(window, @selector(isKeyWindow), (IMP)answerIsKey);
        // Private (docs/operations/private-native-apis.md). Without it a press of the virtual key window that passes the
        // application is a first click, which AppKit drops for a web view.
        NSCAssert(class_getInstanceMethod(window, NSSelectorFromString(@"_isKeyWindow")), @"AppKit has -[NSWindow _isKeyWindow]");
        appKitPrivateIsKey = (BOOL (*)(id, SEL))replace(window, NSSelectorFromString(@"_isKeyWindow"), (IMP)answerPrivateIsKey);
        appKitIsMain = (BOOL (*)(id, SEL))replace(window, @selector(isMainWindow), (IMP)answerIsMain);
        appKitIsActive = (BOOL (*)(id, SEL))replace(application, @selector(isActive), (IMP)answerIsActive);
        appKitKeyWindow = (NSWindow *(*)(id, SEL))replace(application, @selector(keyWindow), (IMP)answerKeyWindow);
        // Private (docs/operations/private-native-apis.md). Without it a key of the virtual key window that passes the
        // application reaches no window.
        NSCAssert(class_getInstanceMethod(application, NSSelectorFromString(@"_keyWindow")), @"AppKit has -[NSApplication _keyWindow]");
        appKitPrivateKeyWindow = (NSWindow *(*)(id, SEL))replace(application, NSSelectorFromString(@"_keyWindow"), (IMP)answerPrivateKeyWindow);
        appKitMainWindow = (NSWindow *(*)(id, SEL))replace(application, @selector(mainWindow), (IMP)answerMainWindow);
        appKitOrderFront = (void (*)(id, SEL, id))replace(window, @selector(orderFront:), (IMP)refuseOrderFront);
        appKitMakeKeyAndOrderFront = (void (*)(id, SEL, id))replace(window, @selector(makeKeyAndOrderFront:), (IMP)refuseMakeKeyAndOrderFront);
        appKitOrderFrontRegardless = (void (*)(id, SEL))replace(window, @selector(orderFrontRegardless), (IMP)refuseOrderFrontRegardless);
        appKitMakeKeyWindow = (void (*)(id, SEL))replace(window, @selector(makeKeyWindow), (IMP)moveMakeKeyWindow);
        appKitInputContext = (NSTextInputContext *(*)(id, SEL))replace(NSView.class, @selector(inputContext), (IMP)answerInputContext);
        appKitCursorSet = (void (*)(id, SEL))replace(NSCursor.class, @selector(set), (IMP)keepCursor);
        appKitCurrentCursor = (NSCursor *(*)(id, SEL))method_setImplementation(
            class_getClassMethod(NSCursor.class, @selector(currentCursor)), (IMP)answerCurrentCursor);
        appKitMouseLocation = (NSPoint (*)(id, SEL))method_setImplementation(
            class_getClassMethod(NSEvent.class, @selector(mouseLocation)), (IMP)answerMouseLocation);
        appKitWindowNumberAtPoint = (NSInteger (*)(id, SEL, NSPoint, NSInteger))method_setImplementation(
            class_getClassMethod(NSWindow.class, @selector(windowNumberAtPoint:belowWindowWithWindowNumber:)), (IMP)answerWindowNumberAtPoint);
        appKitAddCursorRect = (void (*)(id, SEL, NSRect, NSCursor *))replace(NSView.class, @selector(addCursorRect:cursor:), (IMP)collectCursorRect);
        sp_observe_notification("input_virtual.app_active", SP_OBSERVE_RECORD, NSApplicationDidBecomeActiveNotification, NSApp, nil,
            ^(NSNotification *note) {
                if (!sp_input_virtual_real_active()) return;
                sp_input_virtual_end("activation");
                forgetDriven(nil);
            });
    });
}

// Adds window to the windows that the emulated input drives. The first window starts the monitor that keeps real moves from them
// and the observer of their closes.
static void addDriven(NSWindow *window) {
    if (!drivenWindows) drivenWindows = [[NSHashTable weakObjectsHashTable] retain];
    [drivenWindows addObject:window];
    if (moveMonitor) return;
    // A real move holds the position of a person's cursor, so it does not reach a page that a check drives. An injected move
    // does not pass the application and no monitor sees it.
    moveMonitor = [sp_observe_local_monitor("input_virtual.real_move", SP_OBSERVE_COUNT,
        NSEventMaskMouseMoved | NSEventMaskMouseEntered | NSEventMaskMouseExited | NSEventMaskCursorUpdate, ^NSEvent *(NSEvent *event) {
            return event.window && !sp_input_virtual_real_active() && [drivenWindows containsObject:event.window] ? nil : event;
        }) retain];
    drivenCloseObserver = [sp_observe_notification("input_virtual.driven_close", SP_OBSERVE_RECORD, NSWindowWillCloseNotification,
        nil, nil, ^(NSNotification *note) { forgetDriven(note.object); }) retain];
}

// Removes window from the windows that the emulated input drives, or all of them when window is nil. The last window stops the
// monitor and the observer.
static void forgetDriven(NSWindow *window) {
    if (window) [drivenWindows removeObject:window];
    else [drivenWindows removeAllObjects];
    if (drivenWindows.anyObject || !moveMonitor) return;
    [NSEvent removeMonitor:moveMonitor];
    [moveMonitor release];
    moveMonitor = nil;
    [NSNotificationCenter.defaultCenter removeObserver:drivenCloseObserver];
    [drivenCloseObserver release];
    drivenCloseObserver = nil;
}

bool sp_input_virtual_enter(void *handle) {
    return enter((__bridge NSWindow *)handle, "input");
}

static bool enter(NSWindow *window, const char *reason) {
    NSCAssert(NSThread.isMainThread, @"the virtual key window belongs to the main thread");
    if (!window || sp_input_virtual_real_active()) return false;
    if ((__bridge void *)window == atomic_load(&current)) return true;
    install();
    NSWindow *previousMain = mainOf((__bridge NSWindow *)atomic_load(&current));
    keepMain = previousMain && previousMain == mainOf(window);
    sp_input_virtual_end("another window");
    keepMain = NO;
    atomic_store(&current, (__bridge void *)[window retain]);
    closeObserver = [sp_observe_notification("input_virtual.close", SP_OBSERVE_RECORD, NSWindowWillCloseNotification, window, nil,
        ^(NSNotification *note) { sp_input_virtual_end("closed"); }) retain];
    // When a sheet ends, AppKit makes its parent key again; the virtual key window returns to the parent the same way, so an
    // ended sheet that is ordered out without a close does not stay the key window.
    NSWindow *parent = window.sheetParent;
    if (parent) {
        sheetObserver = [sp_observe_notification("input_virtual.sheet_end", SP_OBSERVE_RECORD, NSWindowDidEndSheetNotification, parent,
            nil, ^(NSNotification *note) {
                if ((__bridge void *)window == atomic_load(&current) && !window.isVisible) enter(parent, "sheet ended");
            }) retain];
    }
    addDriven(window);
    NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
    setDefaultButtonKey(window, YES);
    [center postNotificationName:NSWindowDidBecomeKeyNotification object:window];
    if (mainOf(window) != previousMain) [center postNotificationName:NSWindowDidBecomeMainNotification object:mainOf(window)];
    record("entered", reason);
    return true;
}

void sp_input_virtual_end(const char *reason) {
    NSCAssert(NSThread.isMainThread, @"the virtual key window belongs to the main thread");
    NSWindow *window = (__bridge NSWindow *)atomic_load(&current);
    if (!window) return;
    atomic_store(&current, NULL);
    hasPoint = false;
    [virtualCursor release];
    virtualCursor = nil;
    [NSNotificationCenter.defaultCenter removeObserver:closeObserver];
    [closeObserver release];
    closeObserver = nil;
    if (sheetObserver) [NSNotificationCenter.defaultCenter removeObserver:sheetObserver];
    [sheetObserver release];
    sheetObserver = nil;
    record("ended", reason);
    // The window that a real activation made key has heard that from AppKit, and a closing window has no state to resign.
    if (strcmp(reason, "closed") != 0 && !window.isKeyWindow) {
        NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
        setDefaultButtonKey(window, NO);
        [center postNotificationName:NSWindowDidResignKeyNotification object:window];
        if (!keepMain) [center postNotificationName:NSWindowDidResignMainNotification object:mainOf(window)];
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

void sp_input_virtual_real_mouse_location(double *x, double *y) {
    NSPoint at = appKitMouseLocation ? appKitMouseLocation(NSEvent.class, @selector(mouseLocation)) : NSEvent.mouseLocation;
    *x = at.x;
    *y = at.y;
}

bool sp_input_virtual_cursor_rect(void *handle, double x, double y) {
    NSCAssert(NSThread.isMainThread, @"the virtual key window belongs to the main thread");
    NSWindow *window = (__bridge NSWindow *)handle;
    if (!sp_input_virtual_is(handle) || !window.contentView) return false;
    NSPoint point = NSMakePoint(x, y);
    NSView *content = window.contentView;
    NSView *hit = [content hitTest:content.superview ? [content.superview convertPoint:point fromView:nil] : point];
    for (NSView *view = hit; view; view = view == content ? nil : view.superview) {
        collectedRects = [NSMutableArray array];
        [view resetCursorRects];
        NSArray<NSArray *> *rects = collectedRects;
        collectedRects = nil;
        NSPoint local = [view convertPoint:point fromView:nil];
        for (NSArray *entry in rects.reverseObjectEnumerator) {
            if (!NSPointInRect(local, [entry[0] rectValue])) continue;
            [(NSCursor *)entry[1] set];
            return true;
        }
    }
    return false;
}

// The names of the standard cursors, which a cursor matches by identity or by its image.
static NSString *cursorName(NSCursor *cursor) {
    NSMutableDictionary<NSString *, NSCursor *> *named = [NSMutableDictionary dictionaryWithDictionary:@{
        @"arrow": NSCursor.arrowCursor, @"pointingHand": NSCursor.pointingHandCursor, @"iBeam": NSCursor.IBeamCursor,
        @"openHand": NSCursor.openHandCursor, @"closedHand": NSCursor.closedHandCursor, @"crosshair": NSCursor.crosshairCursor,
        @"resizeLeftRight": NSCursor.resizeLeftRightCursor, @"resizeUpDown": NSCursor.resizeUpDownCursor,
        @"operationNotAllowed": NSCursor.operationNotAllowedCursor,
    }];
    if (@available(macOS 15.0, *)) {
        named[@"columnResize"] = NSCursor.columnResizeCursor;
        named[@"rowResize"] = NSCursor.rowResizeCursor;
    }
    for (NSString *name in named) if (named[name] == cursor) return name;
    NSData *image = cursor.image.TIFFRepresentation;
    for (NSString *name in named) if ([named[name].image.TIFFRepresentation isEqualToData:image]) return name;
    return @"other";
}

const char *sp_input_virtual_cursor(void *window) {
    NSCAssert(NSThread.isMainThread, @"the virtual key window belongs to the main thread");
    return sp_input_virtual_is(window) && virtualCursor ? cursorName(virtualCursor).UTF8String : NULL;
}

void *sp_input_virtual_observe_cursor(void *handle, void (^changed)(void)) {
    NSCAssert(NSThread.isMainThread, @"the virtual key window belongs to the main thread");
    if (!handle || !changed) return NULL;
    if (!cursorObservers) cursorObservers = [[NSHashTable alloc] initWithOptions:NSPointerFunctionsStrongMemory capacity:4];
    SPCursorObserver *observer = [[SPCursorObserver alloc] init];
    objc_storeWeak(&observer->window, (__bridge NSWindow *)handle);
    observer.changed = changed;
    [cursorObservers addObject:observer];
    return observer;
}

void sp_input_virtual_end_cursor_observation(void *observation) {
    NSCAssert(NSThread.isMainThread, @"the virtual key window belongs to the main thread");
    SPCursorObserver *observer = (SPCursorObserver *)observation;
    if (!observer) return;
    [cursorObservers removeObject:observer];
    [observer release];
}

// The view that takes the text of a key of window: the nearest view from the first responder up that is a text input client.
static NSView *textInputClient(NSWindow *window) {
    NSResponder *responder = window.firstResponder;
    NSView *view = [responder isKindOfClass:NSView.class] ? (NSView *)responder : nil;
    while (view && ![view respondsToSelector:@selector(insertText:replacementRange:)]) view = view.superview;
    return view;
}

void *sp_input_virtual_text_client(void *handle) {
    NSCAssert(NSThread.isMainThread, @"the text input client belongs to the main thread");
    NSResponder *responder = ((__bridge NSWindow *)handle).firstResponder;
    NSView *view = [responder isKindOfClass:NSView.class] ? (NSView *)responder : nil;
    while (view && !([view respondsToSelector:@selector(setMarkedText:selectedRange:replacementRange:)]
        && [view respondsToSelector:@selector(insertText:replacementRange:)] && [view respondsToSelector:@selector(unmarkText)])) {
        view = view.superview;
    }
    return (__bridge void *)view;
}

bool sp_input_virtual_send_key_to_web_view(void *handle, void *event) {
    NSCAssert(NSThread.isMainThread, @"the virtual key window belongs to the main thread");
    NSWindow *window = (__bridge NSWindow *)handle;
    NSView *client = textInputClient(window);
    if (!sp_input_virtual_is(window) || ![client isKindOfClass:WKWebView.class]) return false;
    keyWebView = (WKWebView *)client;
    [NSApp sendEvent:(__bridge NSEvent *)event];
    keyWebView = nil;
    return true;
}
