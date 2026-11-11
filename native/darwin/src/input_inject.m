// Creates native input events and delivers them to the views of a window.
//
// Key events are delivered to the responder of the window with -[NSWindow sendEvent:]. A press, drag, and release of a
// key window pass -[NSApplication sendEvent:] as a person's press does: the local monitors see them, and AppKit moves the
// first responder and routes the gesture. When a window is not the key window, AppKit treats a pointer event as the first
// click and does not deliver it to the view, so the view at the coordinates is hit-tested and receives the press, and a
// drag and a release are delivered to the press target. A move is
// delivered to the owner of the tracking area that contains the coordinates. In every case the web view receives the
// native event and delivers a trusted event to the page. A scroll is created as an event that carries window
// information and is delivered with -[NSWindow sendEvent:]. The system cursor does not move, and no function activates
// the application: sp_input_activate emulates the activation.
//
// WebKit updates hover from a move without a button only when the page is active (the window is the key window)
// (WebFrame::handleMouseEvent). A move in a window that is not the key window is therefore rejected with
// SP_INPUT_INACTIVE only by an application that is really active; in an inactive application the move and a key enter the
// virtual key window (input_virtual.h), whose presses, releases and keys pass -[NSApplication sendEvent:] as a person's do.
#import <Cocoa/Cocoa.h>
#import <Carbon/Carbon.h>
#import <objc/runtime.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#include <stdatomic.h>
#import "input_inject.h"
#import "input_activity_wait.h"
#import "input_press_context.h"
#import "input_virtual.h"
#import "observe.h"
#import "surface_layout.h"
#import "application_log.h"
#import "webview_input.h"
#import "webview_geometry.h"
#import "window_facts.h"
#import "private/coregraphics.h"
#import "private/webkit.h"

@class SPPress;

// One named pointer. It holds the open press of each of its buttons. Pointers are created at their first input and live as long
// as the process; they are read and changed on the main thread.
@interface SPPointer : NSObject {
@public
    NSString *name;
    SPPress *presses[2]; // not retained: the window of a press holds it, and the press clears its slot when it ends
}
@end
@implementation SPPointer
@end

// The open press of one button of a pointer. Its window holds it, and the close of that window ends the press
// (docs/spec/exposure.md#methods).
@interface SPPress : NSObject {
@public
    SPPointer *pointer; // not retained: pointers live as long as the process
    int button;
    NSWindow *window; // not retained: the window holds the press
    NSView *view; // the press target, which receives the drags and the release
    NSView *page; // the web view that contains the target, or the target: what hears the gesture
    BOOL throughApplication; // the press passed -[NSApplication sendEvent:], and the gesture keeps that path
    BOOL shown; // the button of the press is in the buttons that +[NSEvent pressedMouseButtons] answers
}
@end

static NSMutableDictionary<NSString *, SPPointer *> *pointers;
// The pointer whose input is delivered on this thread, or nil outside a delivery.
static _Thread_local SPPointer *deliveringPointer = nil;
static _Thread_local sp_input_press_context *currentPressContext = NULL;
static char pressOriginsKey;
static uint64_t nextPressOriginToken = 1;

// The pointer of a name, or nil for a name that is not 1 to SP_INPUT_POINTER_NAME_MAX characters of a-z, 0-9 and -.
static SPPointer *pointerNamed(const char *name) {
    size_t length = name ? strlen(name) : 0;
    if (length == 0 || length > SP_INPUT_POINTER_NAME_MAX) return nil;
    for (size_t index = 0; index < length; index++) {
        char c = name[index];
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-')) return nil;
    }
    NSString *key = [NSString stringWithUTF8String:name];
    if (!pointers) pointers = [[NSMutableDictionary alloc] init];
    SPPointer *pointer = pointers[key];
    if (!pointer) {
        pointer = [[[SPPointer alloc] init] autorelease];
        pointer->name = [key copy];
        pointers[key] = pointer;
    }
    return pointer;
}

const char *sp_input_pointer_current_name(void) {
    NSCAssert(NSThread.isMainThread, @"pointer routing belongs to the main thread");
    return deliveringPointer ? deliveringPointer->name.UTF8String : SP_INPUT_POINTER_MAIN;
}

// The origins of a window are kept by pointer and button. The pointer is the one whose input is delivered; outside a delivery it is
// SP_INPUT_POINTER_MAIN, the pointer that also stands for a person's press.
static NSString *originKey(int button) {
    return [NSString stringWithFormat:@"%@ %d", deliveringPointer ? deliveringPointer->name : @SP_INPUT_POINTER_MAIN, button];
}

void sp_input_press_context_push(sp_input_press_context *context, void *window, double x, double y) {
    NSCAssert(NSThread.isMainThread, @"synthetic press contexts belong to the main thread");
    context->previous = currentPressContext;
    context->window = window;
    context->x = x;
    context->y = y;
    currentPressContext = context;
}

void sp_input_press_context_pop(sp_input_press_context *context) {
    NSCAssert(NSThread.isMainThread, @"synthetic press contexts belong to the main thread");
    NSCAssert(currentPressContext == context, @"synthetic press contexts must be restored in nested order");
    currentPressContext = context->previous;
    context->previous = NULL;
}

bool sp_input_press_context_point(void *window, double *x, double *y) {
    NSCAssert(NSThread.isMainThread, @"synthetic press contexts belong to the main thread");
    for (sp_input_press_context *context = currentPressContext; context; context = context->previous) {
        if (context->window != window) continue;
        if (x) *x = context->x;
        if (y) *y = context->y;
        return true;
    }
    return false;
}

uint64_t sp_input_press_origin_set(void *handle, int button, double x, double y) {
    NSCAssert(NSThread.isMainThread, @"mouse press origins belong to the main thread");
    NSWindow *window = (__bridge NSWindow *)handle;
    if (!window) return 0;
    NSMutableDictionary *origins = objc_getAssociatedObject(window, &pressOriginsKey);
    if (!origins) {
        origins = [NSMutableDictionary dictionary];
        objc_setAssociatedObject(window, &pressOriginsKey, origins, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
    uint64_t token = nextPressOriginToken++;
    if (token == 0) token = nextPressOriginToken++;
    origins[originKey(button)] = @{ @"token": @(token), @"x": @(x), @"y": @(y), @"active": @(NSApp.isActive), @"key": @(window.isKeyWindow) };
    return token;
}

bool sp_input_press_origin_point(void *handle, int button, double *x, double *y, uint64_t *token) {
    NSCAssert(NSThread.isMainThread, @"mouse press origins belong to the main thread");
    NSWindow *window = (__bridge NSWindow *)handle;
    NSDictionary *origins = window ? objc_getAssociatedObject(window, &pressOriginsKey) : nil;
    NSDictionary *origin = origins[originKey(button)];
    if (!origin) return false;
    if (x) *x = [origin[@"x"] doubleValue];
    if (y) *y = [origin[@"y"] doubleValue];
    if (token) *token = [origin[@"token"] unsignedLongLongValue];
    return true;
}

bool sp_input_press_origin_state(void *handle, int button, bool *active, bool *key) {
    NSCAssert(NSThread.isMainThread, @"mouse press origins belong to the main thread");
    NSWindow *window = (__bridge NSWindow *)handle;
    NSDictionary *origin = window ? objc_getAssociatedObject(window, &pressOriginsKey)[originKey(button)] : nil;
    if (!origin) return false;
    *active = [origin[@"active"] boolValue];
    *key = [origin[@"key"] boolValue];
    return true;
}

void sp_input_press_origin_clear(void *handle, int button, uint64_t token) {
    NSCAssert(NSThread.isMainThread, @"mouse press origins belong to the main thread");
    NSWindow *window = (__bridge NSWindow *)handle;
    NSMutableDictionary *origins = window ? objc_getAssociatedObject(window, &pressOriginsKey) : nil;
    NSString *key = originKey(button);
    NSDictionary *origin = origins[key];
    if (origin && [origin[@"token"] unsignedLongLongValue] == token) [origins removeObjectForKey:key];
}

// Converts coordinates relative to the top-left of the content area into window coordinates. Follows the coordinate system direction of the content view.
static NSPoint windowPoint(NSWindow *window, double x, double y) {
    NSView *content = window.contentView;
    NSPoint local = NSMakePoint(x, content.isFlipped ? y : content.bounds.size.height - y);
    return [content convertPoint:local toView:nil];
}

// The window point (origin at the top left of the content) of window at the screen point screen.
static NSPoint contentPointOf(NSWindow *window, NSPoint screen) {
    NSView *content = window.contentView;
    NSPoint local = [content convertPoint:[window convertPointFromScreen:screen] fromView:nil];
    return NSMakePoint(local.x, content.isFlipped ? local.y : NSHeight(content.bounds) - local.y);
}

// Whether candidate is window or a window that the application shows attached to it: a sheet of it, a child window of it, or
// such a window of such a window.
static BOOL attachedTo(NSWindow *candidate, NSWindow *window) {
    for (NSWindow *step = candidate; step; step = step.sheetParent ?: step.parentWindow) {
        if (step == window) return YES;
    }
    return NO; // silent: the predicate answers NO for a window that is not window and not attached to it, which its caller passes over
}

// The window that takes a pointer input of window at the window point x, y, which the call changes to the window point of that
// window. The window server gives a person's press to the front window at its point; the windows that the application shows
// attached to window (its sheets and its child windows) stand in front of it there, so the frontmost of them whose frame holds
// the point takes the input, as a sheet takes the press of its button. Other windows, of the application or of another, do not
// take the input of window: the caller names the window it reads, also while other windows cover it. The order is the order of
// the window server: -[NSApplication orderedWindows] leaves out panels, and an alert or a save panel sheet is a panel.
static NSWindow *pointerWindow(NSWindow *window, double *x, double *y) {
    NSPoint screen = [window convertPointToScreen:windowPoint(window, *x, *y)];
    for (NSNumber *number in [NSWindow windowNumbersWithOptions:0]) {
        NSWindow *candidate = [NSApp windowWithWindowNumber:number.integerValue];
        if (candidate == window) break;
        if (!candidate.isVisible || !attachedTo(candidate, window) || !NSPointInRect(screen, candidate.frame)) continue;
        NSPoint point = contentPointOf(candidate, screen);
        *x = point.x;
        *y = point.y;
        return candidate;
    }
    return window;
}

// The window that takes a key of window: the sheet that window shows, or the sheet of that sheet, since AppKit makes a sheet the
// key window while it is shown, and otherwise window.
static NSWindow *keyWindowOf(NSWindow *window) {
    while (window.attachedSheet.isVisible) window = window.attachedSheet;
    return window;
}

// The open or save panel that window is, or nil. The content of such a panel is a view of a service of the system
// (NSRemoteView), which takes no forwarded key other than a command equivalent and no forwarded press
// (-[ViewService keyboardEventHitRemoteView:from:reply:], -[NSRemoteView mouseDown:]); a person's typing reaches it only through
// the keyboard focus that the window server gives the service of the key window of an active application. The input of the panel
// is therefore taken by the panel object of this process, as a browser automation answers a file chooser through its API: the
// name, Return and Escape.
static NSSavePanel *systemPanelOf(NSWindow *window) {
    return [window isKindOfClass:NSSavePanel.class] ? (NSSavePanel *)window : nil;
}

static const char *const systemPanelRefusal =
    "the panel content runs in a system service; only the name, Return and Escape are taken";
static const char *const openPanelRefusal =
    "the content of an open panel runs in a system service and its selection is not known; only Escape is taken";

// The reason of the last refused Return of a panel, kept for the record of its key.
static NSString *systemPanelWhy;

static const char *systemPanelReason(NSString *reason) {
    systemPanelWhy = [[reason stringByReplacingOccurrencesOfString:@"\\" withString:@"\\\\"]
        stringByReplacingOccurrencesOfString:@"\"" withString:@"\\\""];
    return systemPanelWhy.UTF8String;
}

// Appends text to the name of panel, as typing at the end of its name field does.
static void systemPanelType(NSSavePanel *panel, NSString *text) {
    panel.nameFieldStringValue = [panel.nameFieldStringValue stringByAppendingString:text];
}

// Removes the last character of the name of panel, as Backspace at the end of its name field does.
static void systemPanelBackspace(NSSavePanel *panel) {
    NSString *name = panel.nameFieldStringValue;
    if (!name.length) return;
    panel.nameFieldStringValue = [name substringToIndex:[name rangeOfComposedCharacterSequenceAtIndex:name.length - 1].location];
}

// Saves panel under its name in its folder, as Save of a person does, or answers why it does not.
//
// The service of the panel runs the checks of Save and then sends its result, which -[NSSavePanel observeMostRecentCompletion:]
// passes to -[NSSavePanel completeWithReturnCode:url:urls:]: that ends the sheet and calls the completion handler. The panel of the
// application has no Save of its own (-[NSSavePanel ok:] raises "not implemented") and the service takes no OK from the
// application (NSOSPServiceExportedToHostProtocol), so the checks of the service are made here and the result is given to that
// method. They refuse what a person would be stopped at: a name that the service does not take (empty, with '/' or ':', starting
// with '.', longer than -[NSRemoteSavePanel _isSaveFilenameLengthLegal] allows: 255 bytes, and the folder and the name with 9 more
// bytes below 1025), an extension outside allowedContentTypes, an existing file, which a person is asked to replace, and the refusal
// of the delegate. The service is then told that the panel ended (-cancel:), whose completion the ended panel ignores.
static const char *systemPanelSave(NSSavePanel *panel) {
    NSString *name = panel.nameFieldStringValue;
    if (!name.length) return systemPanelReason(@"the name of the save panel is empty");
    if ([name rangeOfCharacterFromSet:[NSCharacterSet characterSetWithCharactersInString:@"/:"]].location != NSNotFound) {
        return systemPanelReason([NSString stringWithFormat:@"the name %@ contains '/' or ':'", name]);
    }
    if ([name hasPrefix:@"."]) return systemPanelReason([NSString stringWithFormat:@"the name %@ starts with '.'", name]);
    id<NSOpenSavePanelDelegate> delegate = panel.delegate;
    if ([delegate respondsToSelector:@selector(panel:userEnteredFilename:confirmed:)]) {
        NSString *entered = [delegate panel:panel userEnteredFilename:name confirmed:YES];
        if (!entered) return systemPanelReason([NSString stringWithFormat:@"the delegate of the save panel refused the name %@", name]);
        name = entered;
    }
    NSURL *folder = panel.directoryURL;
    if (!folder) return systemPanelReason(@"the save panel has no folder");
    size_t nameBytes = strlen(name.fileSystemRepresentation), folderBytes = strlen(folder.path.fileSystemRepresentation);
    if (nameBytes > 255 || folderBytes + nameBytes + 9 >= 1025) {
        return systemPanelReason([NSString stringWithFormat:@"the name %@ is longer than the save panel takes", name]);
    }
    NSArray<UTType *> *types = panel.allowedContentTypes;
    if (types.count) {
        UTType *type = [UTType typeWithFilenameExtension:name.pathExtension];
        BOOL allowed = NO;
        for (UTType *allowedType in types) allowed = allowed || (type && [type conformsToType:allowedType]);
        if (!allowed) {
            return systemPanelReason([NSString stringWithFormat:@"the extension of %@ is not one of the types of the save panel", name]);
        }
    }
    NSURL *url = [folder URLByAppendingPathComponent:name isDirectory:NO];
    if ([NSFileManager.defaultManager fileExistsAtPath:url.path]) {
        return systemPanelReason([NSString stringWithFormat:@"%@ exists; the save panel does not replace it", url.path]);
    }
    if ([delegate respondsToSelector:@selector(panel:validateURL:error:)]) {
        NSError *error = nil;
        if (![delegate panel:panel validateURL:url error:&error]) {
            return systemPanelReason(error.localizedDescription ?: [NSString stringWithFormat:@"the delegate of the save panel refused %@", url.path]);
        }
    }
    SEL complete = NSSelectorFromString(@"completeWithReturnCode:url:urls:");
    NSCAssert([panel respondsToSelector:complete], @"a save panel completes through completeWithReturnCode:url:urls:");
    ((void (*)(id, SEL, NSInteger, NSURL *, NSArray<NSURL *> *))[panel methodForSelector:complete])(panel, complete,
        NSModalResponseOK, url, @[url]);
    [panel cancel:nil];
    return NULL;
}

// A key of a panel of the system. In a save panel Return saves (systemPanelSave), Escape cancels (-cancel:), Backspace removes the
// last character of the name and a key with a stated text types it at the end of the name; Shift is the only modifier of such a
// key. An open panel takes only Escape. Any other key is refused in its turn with why.
static sp_input_result systemPanelKey(NSSavePanel *panel, const char *key, const char *text, unsigned modifiers, bool down,
    const char **why) {
    BOOL enter = strcmp(key, "Enter") == 0, escape = strcmp(key, "Escape") == 0, backspace = strcmp(key, "Backspace") == 0;
    BOOL typed = text && *text && !enter && !escape && !backspace;
    if ([panel isKindOfClass:NSOpenPanel.class] && !escape) {
        *why = openPanelRefusal;
        return SP_INPUT_REJECTED;
    }
    if ((!enter && !escape && !backspace && !typed) || (modifiers & ~1u) || ((enter || escape || backspace) && modifiers)) {
        *why = systemPanelRefusal;
        return SP_INPUT_REJECTED;
    }
    if (!down) return SP_INPUT_DELIVERED;
    if (enter) {
        const char *refused = systemPanelSave(panel);
        if (refused) {
            *why = refused;
            return SP_INPUT_REJECTED;
        }
    } else if (escape) [panel cancel:nil];
    else if (backspace) systemPanelBackspace(panel);
    else systemPanelType(panel, [NSString stringWithUTF8String:text]);
    return SP_INPUT_DELIVERED;
}

static NSEventModifierFlags flags(unsigned modifiers) {
    NSEventModifierFlags result = 0;
    if (modifiers & 1) result |= NSEventModifierFlagShift;
    if (modifiers & 2) result |= NSEventModifierFlagControl;
    if (modifiers & 4) result |= NSEventModifierFlagOption;
    if (modifiers & 8) result |= NSEventModifierFlagCommand;
    return result;
}

static NSView *hitView(NSWindow *window, NSPoint point) {
    NSView *content = window.contentView;
    return [content hitTest:[content.superview convertPoint:point fromView:nil]];
}

// The buttons of open synthetic presses of every pointer, by button. They are written on the main thread and read on any thread.
static _Atomic unsigned syntheticPresses[2];
static NSUInteger (*appKitPressedButtons)(id, SEL);

// The buttons of the open presses of a pointer that the pages see.
static NSUInteger pointerButtons(SPPointer *pointer) {
    NSUInteger buttons = 0;
    for (int button = 0; button < 2; button++) {
        SPPress *press = pointer->presses[button];
        if (press && press->shown) buttons |= 1u << button;
    }
    return buttons;
}

// WebKit makes the buttons of a page event from +[NSEvent pressedMouseButtons], not from the event, and an event delivered
// to a view does not change that value. It is replaced at the first delivered press, so an application that receives only
// a person's input keeps the implementation of AppKit. During the delivery of the input of a pointer it adds the buttons of that
// pointer to the value of AppKit, so a page sees the buttons of its own gesture; otherwise it adds the buttons of every pointer.
static NSUInteger pressedButtonsWithSynthetic(id self, SEL selector) {
    // A real button never enters a page event of a virtual key window.
    NSUInteger buttons = sp_input_virtual_any() ? 0 : appKitPressedButtons(self, selector);
    if (deliveringPointer) return buttons | pointerButtons(deliveringPointer);
    if (atomic_load(&syntheticPresses[0]) > 0) buttons |= 1;
    if (atomic_load(&syntheticPresses[1]) > 0) buttons |= 2;
    return buttons;
}

static void showSyntheticButtons(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        Method method = class_getClassMethod(NSEvent.class, @selector(pressedMouseButtons));
        NSUInteger (*appKit)(id, SEL) = (NSUInteger (*)(id, SEL))method_getImplementation(method);
        appKitPressedButtons = appKit;
        method_setImplementation(method, (IMP)pressedButtonsWithSynthetic);
    });
}

unsigned long sp_input_physical_buttons(void) {
    return appKitPressedButtons ? appKitPressedButtons(NSEvent.class, @selector(pressedMouseButtons)) : NSEvent.pressedMouseButtons;
}

unsigned long sp_input_person_buttons(void) {
    return sp_input_virtual_any() ? 0 : sp_input_physical_buttons();
}

// Enters the virtual key window. WebKit reads the buttons of a page event from then on through the replacement.
static bool enterVirtual(NSWindow *window) {
    if (!sp_input_virtual_enter((__bridge void *)window)) return false;
    showSyntheticButtons();
    return true;
}

// Whether input of window is input of a key window: the key window of the application that is really active, or the virtual
// key window.
static BOOL keyForInput(NSWindow *window) {
    void *handle = (__bridge void *)window;
    return sp_input_virtual_is(handle) || sp_input_virtual_through_application(handle);
}

@implementation SPPress
// Takes the button of the press out of the buttons that the pages see. The press stays open until it ends.
- (void)hide {
    if (!shown) return;
    shown = NO;
    atomic_fetch_sub(&syntheticPresses[button], 1);
}
- (void)dealloc {
    [self hide];
    if (pointer->presses[button] == self) pointer->presses[button] = nil;
    [view release];
    [page release];
    [super dealloc];
}
@end

// The web view that contains view, or view itself: the page whose gesture a press on view is.
static NSView *pageOf(NSView *view) {
    for (NSView *ancestor = view; ancestor; ancestor = ancestor.superview) {
        if ([ancestor isKindOfClass:WKWebView.class]) return ancestor;
    }
    return view;
}

static void observeWindowCloses(void);

// Opens the press of a button of a pointer on view. The window holds the press, and the pages see its button.
static SPPress *openPress(SPPointer *pointer, int button, NSWindow *window, NSView *view, BOOL throughApplication) {
    observeWindowCloses();
    showSyntheticButtons();
    SPPress *press = [[SPPress alloc] init];
    press->pointer = pointer;
    press->button = button;
    press->window = window;
    press->view = [view retain];
    press->page = [pageOf(view) retain];
    press->throughApplication = throughApplication;
    press->shown = YES;
    atomic_fetch_add(&syntheticPresses[button], 1);
    pointer->presses[button] = press;
    objc_setAssociatedObject(window, press, press, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    [press release];
    return press;
}

// Ends a press: the pointer no longer holds it, and its window lets it go.
static void endPress(SPPress *press) {
    [press retain];
    [press hide];
    if (press->pointer->presses[press->button] == press) press->pointer->presses[press->button] = nil;
    objc_setAssociatedObject(press->window, press, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    [press release];
}

// The first open press of a pointer other than pointer for which match answers YES, or nil.
static SPPress *otherPress(SPPointer *pointer, BOOL (^match)(SPPress *press)) {
    for (SPPointer *other in pointers.objectEnumerator) {
        if (other == pointer) continue;
        for (int button = 0; button < 2; button++) {
            SPPress *press = other->presses[button];
            if (press && match(press)) return press;
        }
    }
    return nil;
}

// Whether a press of button by a pointer other than pointer is open in window.
static BOOL otherPressIn(SPPointer *pointer, NSWindow *window, int button) {
    return otherPress(pointer, ^BOOL(SPPress *press) { return press->window == window && press->button == button; }) != nil;
}

// Whether any pointer holds an open press in window.
static BOOL windowPressOpen(NSWindow *window) {
    return otherPress(nil, ^BOOL(SPPress *press) { return press->window == window; }) != nil;
}

// Whether the input method of the system serves the input context of page: the application is really active, the window is
// really its key window, and the context is the current one. WebKit passes a mouse event of a page with an input context to that
// context first (the mouse handlers of WebViewImpl), and the input method answers after the delivery has returned, so WebKit reads
// +[NSEvent pressedMouseButtons] outside the delivery of the pointer. A context that the input method does not serve answers inside
// the delivery (tests/input_pointers_test.m).
static BOOL passesInputMethod(NSView *page) {
    if (![page isKindOfClass:WKWebView.class] || !page.window) return NO; // silent: the predicate answers NO for a view that is not a web page in a window, which no input method serves
    NSTextInputContext *context = page.inputContext;
    return context && context == NSTextInputContext.currentInputContext && sp_input_virtual_real_active()
        && sp_input_virtual_real_key((__bridge void *)page.window);
}

// The open press of another pointer that refuses an input of pointer, with the reason, or nil. page is the page of the input (nil
// when there is none) and window its window. A press shares no page with another press, a press of a window that passes the
// application and a move share no window with another press, and no input shares a page of the input method with another press.
static SPPress *heldBy(SPPointer *pointer, NSWindow *window, NSView *page, int phase, BOOL throughApplication, const char **reason) {
    __block const char *why = NULL;
    SPPress *found = otherPress(pointer, ^BOOL(SPPress *press) {
        if (passesInputMethod(page) || passesInputMethod(press->page)) {
            why = "the input method of a page answers after the delivery";
            return YES;
        }
        if (press->window != window) return NO; // silent: the match answers NO for a press of another window, which this input shares nothing with
        if (phase == 0) {
            why = "the window has one hover position";
            return YES;
        }
        if (phase == 1 && throughApplication) {
            why = "AppKit keeps one press of a window that passes the application";
            return YES;
        }
        if (phase == 1 && press->page == page) {
            why = "the page at the point holds its press";
            return YES;
        }
        return NO; // silent: the match answers NO for a press that shares no state with this input, which may go on
    });
    *reason = why;
    return found;
}

bool sp_input_press_open(void *handle, int button) {
    NSCAssert(NSThread.isMainThread, @"mouse presses belong to the main thread");
    NSWindow *window = (__bridge NSWindow *)handle;
    return window && otherPressIn(nil, window, button);
}

// The number of presses whose delivery has not returned. A view that tracks its press, such as a button or a menu, runs an
// event loop of its own inside the delivery of the press and reads the next events of the gesture from the event queue of the
// application, as it reads a person's; an input that arrives while that loop runs reaches the loop only through the queue.
static NSInteger pressesDelivering;

// The ends of the releases that went to the event queue. The press of such a release stays open, so +[NSEvent pressedMouseButtons]
// keeps answering its button while the event loop of the view reads the drags before it, and it ends when the delivery of the
// press returns, after that loop has read the release.
static NSMutableArray *queuedReleaseEnds;
static void endQueuedReleases(void) {
    if (pressesDelivering > 0 || !queuedReleaseEnds.count) return;
    NSArray *ends = [queuedReleaseEnds autorelease];
    queuedReleaseEnds = nil;
    for (dispatch_block_t end in ends) end();
}

// Delivers one event of a gesture on the path of its press. An event that passes the application while the delivery of a press
// runs an event loop of its own goes to the event queue, which that loop reads.
static void deliverGesture(NSView *hit, NSEvent *event, BOOL throughApplication) {
    if (throughApplication && pressesDelivering > 0 && event.type != NSEventTypeLeftMouseDown
        && event.type != NSEventTypeRightMouseDown) {
        [NSApp postEvent:event atStart:NO];
        return;
    }
    if (throughApplication) {
        [NSApp sendEvent:event];
        return;
    }
    switch (event.type) {
        case NSEventTypeLeftMouseDown: [hit mouseDown:event]; break;
        case NSEventTypeRightMouseDown: [hit rightMouseDown:event]; break;
        case NSEventTypeLeftMouseDragged: [hit mouseDragged:event]; break;
        case NSEventTypeRightMouseDragged: [hit rightMouseDragged:event]; break;
        case NSEventTypeLeftMouseUp: [hit mouseUp:event]; break;
        case NSEventTypeRightMouseUp: [hit rightMouseUp:event]; break;
        default: break;
    }
}

static NSEvent *mouseEvent(NSWindow *window, NSEventType type, NSPoint point, NSInteger clicks, float pressure) {
    return [NSEvent mouseEventWithType:type location:point modifierFlags:0
        timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber
        context:nil eventNumber:0 clickCount:clicks pressure:pressure];
}

// The tracking areas of a window that hold the pointer of its last move, so a move crosses their enter and exit.
static char enteredAreasKey;

// The rect of area in view by which AppKit decides whether a point is inside the area, as its direct method
// -[NSTrackingArea _effectiveRectInView:] answers it: the rect of the area, or for NSTrackingInVisibleRect the private
// -[NSView _interactiveBounds], the bounds of the view within its visible rect, its enclosing scroll views and the safe area
// (docs/operations/private-native-apis.md). The visible rect of a view that does not clip to its bounds reaches beyond them, so it
// alone is not the rect of such an area.
static NSRect areaRect(NSTrackingArea *area, NSView *view) {
    if (!(area.options & NSTrackingInVisibleRect)) return area.rect;
    SEL selector = NSSelectorFromString(@"_interactiveBounds");
    Method method = class_getInstanceMethod(object_getClass(view), selector);
    NSCAssert(method, @"-[NSView _interactiveBounds] is unavailable");
    return ((NSRect (*)(id, SEL))method_getImplementation(method))(view, selector);
}

static bool areaHolds(NSView *view, NSTrackingArea *area, NSPoint point) {
    if ((area.options & NSTrackingActiveWhenFirstResponder) && view.window.firstResponder != view) return false;
    return NSPointInRect([view convertPoint:point fromView:nil], NSIntersectionRect(areaRect(area, view), view.visibleRect));
}

// Gathers each tracking area of the shown views under view. A view that covers another does not hide its area from AppKit.
static void gatherAreas(NSView *view, NSPoint point, NSMutableArray<NSTrackingArea *> *held, NSMutableArray<NSTrackingArea *> *left) {
    if (view.isHidden) return;
    [view updateTrackingAreas];
    for (NSTrackingArea *area in view.trackingAreas) [(areaHolds(view, area, point) ? held : left) addObject:area];
    for (NSView *child in view.subviews) gatherAreas(child, point, held, left);
}

// The crossing of area as AppKit sends it: -[NSEvent trackingArea] answers the area, which an AppKit crossing carries in its
// tracking number. An owner of several areas tells them apart by it: WebKit takes the crossing of its area for modifier key
// changes as the start or end of that monitor and every other crossing as a mouse move, so a crossing without its area reaches
// the page as one more move.
static NSEvent *crossing(NSWindow *window, NSEventType type, NSPoint point, NSTrackingArea *area) {
    return [NSEvent enterExitEventWithType:type location:point modifierFlags:0
        timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber context:nil
        eventNumber:0 trackingNumber:(NSInteger)area userData:NULL];
}

// Delivers a move as a person's move arrives: the web view routing runs as for an event that AppKit dispatches, each tracking area
// that the point leaves or enters hears that, and the owner of each area that holds the point and tracks moves hears the move,
// also under a view that covers it. In the virtual key window the cursor follows as AppKit sets it for a person's pointer: the
// owner of each area with NSTrackingCursorUpdate that the point enters hears cursorUpdate:, and the cursor rect of the deepest
// view under the point sets its cursor (input_virtual.h). It reports whether any owner or cursor rect heard anything.
static bool moveTo(NSWindow *window, NSPoint point) {
    NSEvent *event = mouseEvent(window, NSEventTypeMouseMoved, point, 0, 0);
    webviewInputRoutePointer(event);
    NSMutableArray<NSTrackingArea *> *held = [NSMutableArray array], *left = [NSMutableArray array];
    gatherAreas(window.contentView.superview ?: window.contentView, point, held, left);
    NSHashTable<NSTrackingArea *> *entered = objc_getAssociatedObject(window, &enteredAreasKey);
    if (!entered) {
        entered = [NSHashTable weakObjectsHashTable];
        objc_setAssociatedObject(window, &enteredAreasKey, entered, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
    bool heard = false;
    BOOL cursor = sp_input_virtual_is((__bridge void *)window);
    for (NSTrackingArea *area in left) {
        if (![entered containsObject:area]) continue;
        [entered removeObject:area];
        if ((area.options & NSTrackingMouseEnteredAndExited) && [area.owner respondsToSelector:@selector(mouseExited:)]) {
            [area.owner mouseExited:crossing(window, NSEventTypeMouseExited, point, area)];
            heard = true;
        }
    }
    for (NSTrackingArea *area in held) {
        if (!(area.options & (NSTrackingMouseEnteredAndExited | NSTrackingCursorUpdate)) || [entered containsObject:area]) continue;
        [entered addObject:area];
        if ((area.options & NSTrackingMouseEnteredAndExited) && [area.owner respondsToSelector:@selector(mouseEntered:)]) {
            [area.owner mouseEntered:crossing(window, NSEventTypeMouseEntered, point, area)];
            heard = true;
        }
        if (cursor && (area.options & NSTrackingCursorUpdate) && [area.owner respondsToSelector:@selector(cursorUpdate:)]) {
            [area.owner cursorUpdate:crossing(window, NSEventTypeCursorUpdate, point, area)];
            heard = true;
        }
    }
    for (NSTrackingArea *area in held) {
        if (!(area.options & NSTrackingMouseMoved) || ![area.owner respondsToSelector:@selector(mouseMoved:)]) continue;
        [area.owner mouseMoved:event];
        heard = true;
    }
    if (cursor && sp_input_virtual_cursor_rect((__bridge void *)window, point.x, point.y)) heard = true;
    return heard;
}

// Measurement of the turn rejected with SP_INPUT_BUTTON_HELD, or the pointer whose press rejected the input with
// SP_INPUT_POINTER_HELD. front is a retained reference that heldDone releases.
typedef struct {
    NSUInteger buttons;
    NSRunningApplication *front;
    SPPointer *holder;
    // Reason for the rejection; an empty string when the input was delivered.
    const char *why;
} SPHeld;

// The view that receives an input of pointer: for a drag and a release the target of the press of the pointer and button in
// window, otherwise the view at the point.
static NSView *pointerTarget(SPPointer *pointer, NSWindow *window, NSPoint point, int phase, int button) {
    if (phase != 2 && phase != 3) return hitView(window, point);
    SPPress *press = pointer->presses[button];
    return press && press->window == window ? press->view : nil;
}

// Whether the open press of another pointer refuses the input; held then names that pointer and the reason.
static bool heldByOther(SPPointer *pointer, NSWindow *window, NSView *page, int phase, BOOL throughApplication, SPHeld *held) {
    const char *reason = NULL;
    SPPress *press = heldBy(pointer, window, page, phase, throughApplication, &reason);
    if (!press) return false;
    held->holder = press->pointer;
    held->why = reason;
    return true;
}

// The page under a point of window, or nil.
static NSView *pageAt(NSWindow *window, NSPoint point) {
    NSView *hit = hitView(window, point);
    return hit ? pageOf(hit) : nil;
}

// Delivers an input of pointer while +[NSEvent pressedMouseButtons] answers the buttons of that pointer. When the result is
// SP_INPUT_BUTTON_HELD, held receives the mask of the rejected turn and the frontmost application; when it is
// SP_INPUT_POINTER_HELD, held names the pointer whose press rejected it.
static sp_input_result deliverPointer(SPPointer *pointer, NSWindow *window, double x, double y, int phase, int button,
    double deltaX, double deltaY, int clicks, SPHeld *held) {
    void *handle = (__bridge void *)window;
    NSPoint point = windowPoint(window, x, y);
    // No person points at a window that is not shown, and AppKit gives no press to it:
    // -[NSWindow _handleLeftMouseDownEvent:isDelayedEvent:] ends before its hit test unless the window is visible. Its move,
    // press, drag and release are refused in their turn instead of being answered as delivered.
    if (phase != 4 && (!window.isVisible || window.isMiniaturized)) {
        held->why = "the window is not shown";
        return SP_INPUT_REJECTED;
    }
    if (phase == 0) {
        if (heldByOther(pointer, window, pageAt(window, point), 0, NO, held)) return SP_INPUT_POINTER_HELD;
        if (!keyForInput(window) && !enterVirtual(window)) {
            held->why = "the application is active and the window is not its key window";
            return SP_INPUT_INACTIVE;
        }
        sp_input_virtual_set_point(handle, point.x, point.y);
        if (!moveTo(window, point)) { held->why = "no tracking area at the point"; return SP_INPUT_REJECTED; }
        return SP_INPUT_DELIVERED;
    }
    if (phase == 4) {
        // The public API has no way to create a scroll event that carries window information. Setting the window number
        // (field 51) and the window location (CGEventSetWindowLocation) on a CGEvent yields an NSEvent with a window and
        // locationInWindow, and -[NSWindow sendEvent:] delivers it to the view at the coordinates. Both are CoreGraphics
        // features that are not public, so they are recorded in docs/operations/private-native-apis.md and
        // tests/input_inject_test.m checks that the scroll actually happens.
        CGEventRef scroll = CGEventCreateScrollWheelEvent2(NULL, kCGScrollEventUnitPixel, 2,
            (int32_t)-deltaY, (int32_t)-deltaX, 0);
        if (!scroll) { held->why = "the scroll event cannot be created"; return SP_INPUT_REJECTED; }
        // An event without a source inherits the real modifier key state. Pointer input takes no modifier keys, so the state is cleared.
        CGEventSetFlags(scroll, 0);
        NSPoint screen = [window convertPointToScreen:point];
        CGFloat top = NSMaxY(NSScreen.screens.firstObject.frame);
        CGEventSetLocation(scroll, CGPointMake(screen.x, top - screen.y));
        CGEventSetIntegerValueField(scroll, kSPEventWindowNumberField, window.windowNumber);
        CGEventSetWindowLocation(scroll, CGPointMake(point.x, NSHeight(window.frame) - point.y));
        NSEvent *event = [NSEvent eventWithCGEvent:scroll];
        CFRelease(scroll);
        if (event.window != window) { held->why = "the scroll event has another window"; return SP_INPUT_REJECTED; }
        [window sendEvent:event];
        return SP_INPUT_DELIVERED;
    }
    NSView *hit = pointerTarget(pointer, window, point, phase, button);
    if (!hit) { held->why = phase == 2 || phase == 3 ? "no open press of the pointer and button in the window" : "no view at the point"; return SP_INPUT_REJECTED; }
    if (hit.window != window) {
        uint64_t token = 0;
        if (sp_input_press_origin_point(window, button, NULL, NULL, &token)) sp_input_press_origin_clear(window, button, token);
        endPress(pointer->presses[button]);
        held->why = "the target view left the window";
        return SP_INPUT_REJECTED;
    }
    // WebKit reads the pressed buttons of a mouse event from +[NSEvent pressedMouseButtons], not from the event.
    // While AppKit reports a pressed button, WebKit can handle a press and a release as pointermove instead of pointerdown
    // or pointerup, so they are not delivered and the rejection is reported. This state alone does not identify the cause
    // of the button state, so the mask and the frontmost application are measured in the same rejected turn and reported together.
    NSUInteger buttons = sp_input_person_buttons();
    if ((phase == 1 || phase == 3) && buttons != 0) {
        held->buttons = buttons;
        held->front = [NSWorkspace.sharedWorkspace.frontmostApplication retain];
        held->why = "AppKit reports a pressed mouse button";
        return SP_INPUT_BUTTON_HELD;
    }
    if ((phase == 1 || phase == 3) && (clicks < 1 || clicks > SP_INPUT_CLICKS_MAX)) {
        held->why = "the click count is out of range";
        return SP_INPUT_REJECTED;
    }
    BOOL right = button == 1;
    switch (phase) {
        case 1: {
            // A delivered release ends an open press. A rejected release leaves the press open, so the next press reports that fact.
            if (pointer->presses[button]) { held->why = "a press of this button of the pointer is still open"; return SP_INPUT_PRESS_OPEN; }
            // A press of the key window of the application that is really active and a press of the virtual key window pass
            // -[NSApplication sendEvent:], as the press of a person does, so the local monitors see it; the virtual key window
            // answers as the key window of an active application there, so AppKit does not drop it as a first click. AppKit
            // follows one press of a window, so a press while another press of the window is open goes to the view directly.
            BOOL throughApplication = sp_input_virtual_through_application(handle)
                || (sp_input_virtual_is(handle) && !windowPressOpen(window));
            if (heldByOther(pointer, window, pageOf(hit), 1, throughApplication, held)) return SP_INPUT_POINTER_HELD;
            sp_input_virtual_set_point(handle, point.x, point.y);
            // The left press of the window is followed for the workbench once, while any pointer holds it.
            BOOL firstLeft = button == 0 && !otherPressIn(pointer, window, 0);
            // A person moves to the point before the press. A window that is not the key window hears no move.
            if (keyForInput(window)) moveTo(window, point);
            openPress(pointer, button, window, hit, throughApplication);
            // The monitor of the press origin records the press of the application as it records a person's press. A press
            // delivered directly passes no monitor, so the driver records it.
            if (!throughApplication) sp_input_press_origin_set(window, button, point.x, point.y);
            // A press that passes the application is followed there; this one passes no -[NSApplication sendEvent:] on its way.
            if (!throughApplication && firstLeft) surfaceLayoutPointerPassing(window, true, point.x, point.y);
            // NSApp.currentEvent is not this event, so the explicit context lets click-through native regions classify the
            // synchronous responder change.
            sp_input_press_context context = {0};
            sp_input_press_context_push(&context, window, point.x, point.y);
            @try {
                // -[NSWindow sendEvent:] makes the pressed view first responder before the press. Direct delivery follows that
                // order without activating the window or application.
                if (!throughApplication && hit != window.firstResponder && hit.acceptsFirstResponder) [window makeFirstResponder:hit];
                NSEventType down = right ? NSEventTypeRightMouseDown : NSEventTypeLeftMouseDown;
                pressesDelivering++;
                @try {
                    deliverGesture(hit, mouseEvent(window, down, point, clicks, 1), throughApplication);
                } @finally {
                    pressesDelivering--;
                    endQueuedReleases();
                }
            } @finally {
                sp_input_press_context_pop(&context);
            }
            return SP_INPUT_DELIVERED;
        }
        case 2:
        case 3: {
            SPPress *press = [[pointer->presses[button] retain] autorelease];
            if (heldByOther(pointer, window, press->page, phase, press->throughApplication, held)) return SP_INPUT_POINTER_HELD;
            sp_input_virtual_set_point(handle, point.x, point.y);
            BOOL lastLeft = button == 0 && !otherPressIn(pointer, window, 0);
            double originX = point.x, originY = point.y;
            uint64_t originToken = 0;
            bool hasOrigin = sp_input_press_origin_point(window, button, &originX, &originY, &originToken);
            BOOL gestureThroughApplication = press->throughApplication;
            sp_input_press_context context = {0};
            BOOL queued = phase == 3 && gestureThroughApplication && pressesDelivering > 0;
            if (hasOrigin) sp_input_press_context_push(&context, window, originX, originY);
            @try {
                NSEvent *event = phase == 2
                    ? mouseEvent(window, right ? NSEventTypeRightMouseDragged : NSEventTypeLeftMouseDragged, point, 0, 1)
                    : mouseEvent(window, right ? NSEventTypeRightMouseUp : NSEventTypeLeftMouseUp, point, clicks, 0);
                // A release that goes to the event queue ends when the delivery of its press returns.
                if (queued) {
                    deliverGesture(hit, event, gestureThroughApplication);
                    if (!queuedReleaseEnds) queuedReleaseEnds = [[NSMutableArray alloc] init];
                    [queuedReleaseEnds addObject:[[^{
                        [press hide];
                        endPress(press);
                        if (lastLeft) sp_surface_press_released(window);
                    } copy] autorelease]];
                    return SP_INPUT_DELIVERED;
                }
                // The release has no button, and the press stays open for the view until the release returns.
                if (phase == 3) [press hide];
                if (phase == 3 && lastLeft && !gestureThroughApplication) surfaceLayoutPointerPassing(window, false, point.x, point.y);
                deliverGesture(hit, event, gestureThroughApplication);
            } @finally {
                if (hasOrigin) sp_input_press_context_pop(&context);
                if (phase == 3 && !queued) {
                    endPress(press);
                    if (hasOrigin && !gestureThroughApplication) sp_input_press_origin_clear(window, button, originToken);
                    if (lastLeft) sp_surface_press_released(window);
                }
            }
            return SP_INPUT_DELIVERED;
        }
        default:
            held->why = "unknown phase";
            return SP_INPUT_REJECTED;
    }
}

// Delivers an input of pointer. pointer is nil for a name that is not of its form.
static sp_input_result pointerInput(SPPointer *pointer, void *handle, double x, double y, int phase, int button, double deltaX,
    double deltaY, int clicks, SPHeld *held) {
    NSWindow *window = (__bridge NSWindow *)handle;
    held->why = "";
    if (!window || !NSThread.isMainThread) { held->why = "no window or not the main thread"; return SP_INPUT_REJECTED; }
    if (!pointer) { held->why = "the pointer name is not 1 to 32 characters of a-z, 0-9 and -"; return SP_INPUT_REJECTED; }
    if (button != 0 && button != 1) { held->why = "the button is not left or right"; return SP_INPUT_REJECTED; }
    // A drag or a release follows its press to the attached window that took the press; any other input goes to the attached
    // window at its point.
    SPPress *pressed = phase == 2 || phase == 3 ? pointer->presses[button] : nil;
    if (pressed && pressed->window != window && attachedTo(pressed->window, window)) {
        NSPoint point = contentPointOf(pressed->window, [window convertPointToScreen:windowPoint(window, x, y)]);
        window = pressed->window;
        x = point.x;
        y = point.y;
    } else if (!pressed) {
        NSWindow *named = window;
        window = pointerWindow(window, &x, &y);
        // AppKit makes the sheet or child window that a person presses the key window; in an application that is not really
        // active the pressed attached window becomes the virtual key window, so its press passes the application as the
        // press of a person does and a control that tracks it reads the rest of the gesture from the event queue.
        if (phase == 1 && window != named && window.canBecomeKeyWindow) enterVirtual(window);
    }
    if (systemPanelOf(window)) { held->why = systemPanelRefusal; return SP_INPUT_REJECTED; }
    SPPointer *previous = deliveringPointer;
    deliveringPointer = pointer;
    @try {
        return deliverPointer(pointer, window, x, y, phase, button, deltaX, deltaY, clicks, held);
    } @finally {
        deliveringPointer = previous;
    }
}

// The origin of the press of button of pointer in window.
static bool pointerOrigin(SPPointer *pointer, NSWindow *window, int button, double *x, double *y) {
    SPPointer *previous = deliveringPointer;
    deliveringPointer = pointer;
    bool found = sp_input_press_origin_point(window, button, x, y, NULL);
    deliveringPointer = previous;
    return found;
}

// Name of the result of the injected input.
static const char *resultName(sp_input_result result) {
    switch (result) {
        case SP_INPUT_DELIVERED: return "delivered";
        case SP_INPUT_REJECTED: return "rejected";
        case SP_INPUT_INACTIVE: return "inactive";
        case SP_INPUT_UNRECEIVED: return "unreceived";
        case SP_INPUT_BUTTON_HELD: return "button held";
        case SP_INPUT_PRESS_OPEN: return "press open";
        case SP_INPUT_POINTER_HELD: return "pointer held";
    }
    return "unknown";
}

// Records one injected pointer input with its pointer, arguments, result, and rejection reason, and the pointer whose press rejected
// it. Every path by which the caller receives a result uses it. A pointer name has only a-z, 0-9 and -, so it needs no escape.
static void logPointer(SPPointer *pointer, double x, double y, int phase, int button, double deltaX, double deltaY, int clicks,
    sp_input_result result, const char *why, SPPointer *holder) {
    NSString *text = [NSString stringWithFormat:
        @"{\"kind\":\"pointer\",\"pointer\":%@,\"x\":%g,\"y\":%g,\"phase\":%d,\"button\":%d,\"deltaX\":%g,\"deltaY\":%g,\"clicks\":%d,\"result\":\"%s\",\"reason\":\"%s\",\"holder\":%@}",
        pointer ? [NSString stringWithFormat:@"\"%@\"", pointer->name] : @"null", x, y, phase, button, deltaX, deltaY, clicks,
        resultName(result), why ?: "", holder ? [NSString stringWithFormat:@"\"%@\"", holder->name] : @"null"];
    sp_log_info("input inject", text.UTF8String);
}

// Delivers a phase of a gesture of the pointer SP_INPUT_POINTER_MAIN behind the input of its window that waits. Whether the input is
// kept is the only answer the caller has until its turn, and the record of that turn states the result.
static sp_input_result pointerAt(void *handle, double x, double y, int phase, int button, double deltaX, double deltaY, int clicks) {
    NSWindow *window = (__bridge NSWindow *)handle;
    SPPointer *pointer = NSThread.isMainThread ? pointerNamed(SP_INPUT_POINTER_MAIN) : nil;
    NSPoint at = window && NSThread.isMainThread ? windowPoint(window, x, y) : NSZeroPoint;
    if (window && NSThread.isMainThread && surfaceLayoutHoldCall(window, phase == 1, at.x, at.y, ^{
            SPHeld kept = {0, nil, nil, ""};
            sp_input_result result = pointerInput(pointer, window, x, y, phase, button, deltaX, deltaY, clicks, &kept);
            logPointer(pointer, x, y, phase, button, deltaX, deltaY, clicks, result, kept.why, kept.holder);
            [kept.front release];
        })) {
        return SP_INPUT_DELIVERED;
    }
    SPHeld held = {0, nil, nil, ""};
    sp_input_result result = pointerInput(pointer, handle, x, y, phase, button, deltaX, deltaY, clicks, &held);
    logPointer(pointer, x, y, phase, button, deltaX, deltaY, clicks, result, held.why, held.holder);
    [held.front release];
    return result;
}

sp_input_result sp_input_pointer(void *handle, double x, double y, int phase, int button, double deltaX, double deltaY) {
    return pointerAt(handle, x, y, phase, button, deltaX, deltaY, 1);
}

sp_input_result sp_input_pointer_clicks(void *handle, double x, double y, int phase, int button, int clicks) {
    return pointerAt(handle, x, y, phase, button, 0, 0, clicks);
}

// Calls done and releases the reference of held. held is reported only when result is SP_INPUT_BUTTON_HELD or
// SP_INPUT_POINTER_HELD.
static void heldDone(sp_input_done done, void *context, sp_input_result result, SPHeld held) {
    if (result == SP_INPUT_POINTER_HELD) {
        sp_input_held report = { .mask = 0, .pid = -1, .bundleIdentifier = NULL, .pointer = held.holder->name.UTF8String, .reason = held.why };
        [held.front release];
        done(context, result, &report);
        return;
    }
    if (result != SP_INPUT_BUTTON_HELD) {
        [held.front release];
        done(context, result, NULL);
        return;
    }
    sp_input_held report = {
        .mask = held.buttons,
        .pid = held.front ? held.front.processIdentifier : -1,
        .bundleIdentifier = held.front.bundleIdentifier.UTF8String,
        .pointer = NULL,
        .reason = NULL,
    };
    done(context, result, &report);
    [held.front release];
}

// Delivers the input and reports the result to done immediately.
static void pointerNow(SPPointer *pointer, void *handle, double x, double y, int phase, int button, double deltaX, double deltaY,
    int clicks, sp_input_done done, void *context) {
    SPHeld held = {0, nil, nil, ""};
    sp_input_result result = pointerInput(pointer, handle, x, y, phase, button, deltaX, deltaY, clicks, &held);
    logPointer(pointer, x, y, phase, button, deltaX, deltaY, clicks, result, held.why, held.holder);
    heldDone(done, context, result, held);
}

// The facts of view for the record of a press or release that its document did not receive: class, address, frame in window
// coordinates, whether it is in window and hidden, and for a web view its address of document and whether it loads.
static id viewFacts(NSView *view, NSWindow *window) {
    if (!view) return NSNull.null;
    NSRect frame = [view convertRect:view.bounds toView:nil];
    NSMutableDictionary *facts = [NSMutableDictionary dictionaryWithDictionary:@{
        @"class": NSStringFromClass(view.class),
        @"view": [NSString stringWithFormat:@"%p", view],
        @"frame": @[@(frame.origin.x), @(frame.origin.y), @(frame.size.width), @(frame.size.height)],
        @"inWindow": @((BOOL)(view.window == window)),
        @"hidden": @(view.isHiddenOrHasHiddenAncestor),
    }];
    if ([view isKindOfClass:WKWebView.class]) {
        WKWebView *web = (WKWebView *)view;
        facts[@"url"] = web.URL.absoluteString ?: (id)NSNull.null;
        facts[@"loading"] = @(web.loading);
    }
    return facts;
}

// Records, at the level error, a press or release whose wait ended before the document of target received it: the web view
// whose receipt was awaited, the view the press reached when it was sent (nil when it was not sent) and its page, and the key
// state of window, so a press that reached another page is told from a page that did not answer.
static void logUnreceived(NSWindow *window, WKWebView *target, NSView *reached, NSString *type, double x, double y) {
    NSView *page = reached ? pageOf(reached) : nil;
    NSResponder *first = window.firstResponder;
    NSDictionary *record = @{
        @"kind": @"unreceived",
        @"type": type,
        @"x": @(x),
        @"y": @(y),
        @"target": viewFacts(target, window),
        @"reached": viewFacts(reached, window),
        @"reachedPage": viewFacts(page, window),
        @"samePage": @((BOOL)(page == target)),
        @"firstResponder": first ? NSStringFromClass(first.class) : (id)NSNull.null,
        @"key": @(window.isKeyWindow),
        @"virtual": @(sp_input_virtual_is((__bridge void *)window)),
        @"throughApplication": @(sp_input_virtual_through_application((__bridge void *)window)),
    };
    NSData *json = [NSJSONSerialization dataWithJSONObject:record options:NSJSONWritingSortedKeys | NSJSONWritingWithoutEscapingSlashes
        error:nil];
    sp_log_error("input inject", [[[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding] autorelease].UTF8String);
}

// Innermost web view that receives the event at the coordinates.
static WKWebView *webViewAt(NSWindow *window, double x, double y) {
    NSView *view = hitView(window, windowPoint(window, x, y));
    while (view && ![view isKindOfClass:WKWebView.class]) view = view.superview;
    return (WKWebView *)view;
}

static void pointerThen(SPPointer *pointer, void *handle, double x, double y, int phase, int button, double deltaX, double deltaY,
    int clicks, sp_input_done done, void *context);
static void afterWebViewsActive(NSWindow *window, WKWebView *target, BOOL waitForAll, void (^done)(void),
    void (^ended)(NSString *end, NSArray<NSString *> *unresolved), void (^waitCreated)(SPInputActivityWait *));

// One request of sp_input_pointer_then that waits for its turn. It keeps its window and a copy of the borrowed pointer name until
// it starts or its window closes.
@interface SPPointerRequest : NSObject {
@public
    NSWindow *window;
    char *name;
    double x, y, deltaX, deltaY;
    int phase, button, clicks;
    sp_input_done done;
    void *context;
}
@end
@implementation SPPointerRequest
- (void)dealloc {
    [window release];
    free(name);
    [super dealloc];
}
@end

static void pointerStart(void *handle, const char *name, double x, double y, int phase, int button, double deltaX,
    double deltaY, int clicks, sp_input_done done, void *context);

// The injected pointer requests of the application run one at a time, in the order in which they reached the main thread: the
// answer of a request is the event that starts the next (docs/spec/exposure.md#named-pointers). A request that waits for its
// turn holds no lock and no thread; the close of its window answers it in the close turn.
static NSMutableArray<SPPointerRequest *> *pointerRequests;
static BOOL pointerRequestRuns;
static BOOL pointerRequestsStarting;

static void pointerRequestAnswered(void *context, sp_input_result result, const sp_input_held *held);

static void startPointerRequests(void) {
    if (pointerRequestsStarting) return;
    pointerRequestsStarting = YES;
    while (!pointerRequestRuns && pointerRequests.count > 0) {
        SPPointerRequest *request = [pointerRequests[0] retain];
        [pointerRequests removeObjectAtIndex:0];
        pointerRequestRuns = YES;
        // The request is released when it answers, which may happen inside pointerStart.
        pointerStart(request->window, request->name, request->x, request->y, request->phase, request->button, request->deltaX,
            request->deltaY, request->clicks, pointerRequestAnswered, request);
    }
    pointerRequestsStarting = NO;
}

static void pointerRequestAnswered(void *context, sp_input_result result, const sp_input_held *held) {
    SPPointerRequest *request = context;
    request->done(request->context, result, held);
    [request release];
    pointerRequestRuns = NO;
    startPointerRequests();
}

// The close of a window ends the open presses in it and answers the pointer requests of it that wait for their turn, in the
// close turn: the pointer presses again in another window, and a later release finds its press ended.
static void observeWindowCloses(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        pointerRequests = [[NSMutableArray alloc] init];
        sp_observe_notification("input_inject.window_close", SP_OBSERVE_COUNT, NSWindowWillCloseNotification, nil, nil,
            ^(NSNotification *notification) {
                NSWindow *closed = notification.object;
                NSMutableArray<SPPress *> *presses = [NSMutableArray array];
                for (SPPointer *pointer in pointers.objectEnumerator) {
                    for (int button = 0; button < 2; button++) {
                        SPPress *press = pointer->presses[button];
                        if (press && press->window == closed) [presses addObject:press];
                    }
                }
                for (SPPress *press in presses) {
                    sp_log_info("input inject", "an open press of a window that closed is ended");
                    endPress(press);
                }
                NSMutableArray<SPPointerRequest *> *ended = [NSMutableArray array];
                for (SPPointerRequest *request in pointerRequests) if (request->window == closed) [ended addObject:request];
                [pointerRequests removeObjectsInArray:ended];
                for (SPPointerRequest *request in ended) {
                    sp_log_info("input inject", "a pointer request of a window that closed before its turn is answered rejected");
                    request->done(request->context, SP_INPUT_REJECTED, NULL);
                }
            });
    });
}

void sp_input_pointer_then(void *handle, const char *name, double x, double y, int phase, int button, double deltaX,
    double deltaY, int clicks, sp_input_done done, void *context) {
    if (!NSThread.isMainThread) {
        pointerStart(handle, name, x, y, phase, button, deltaX, deltaY, clicks, done, context);
        return;
    }
    observeWindowCloses();
    SPPointerRequest *request = [[[SPPointerRequest alloc] init] autorelease];
    request->window = [(__bridge NSWindow *)handle retain];
    request->name = name ? strdup(name) : NULL;
    request->x = x;
    request->y = y;
    request->phase = phase;
    request->button = button;
    request->deltaX = deltaX;
    request->deltaY = deltaY;
    request->clicks = clicks;
    request->done = done;
    request->context = context;
    [pointerRequests addObject:request];
    startPointerRequests();
}

static void pointerStart(void *handle, const char *name, double x, double y, int phase, int button, double deltaX,
    double deltaY, int clicks, sp_input_done done, void *context) {
    NSWindow *window = (__bridge NSWindow *)handle;
    SPPointer *pointer = NSThread.isMainThread ? pointerNamed(name) : nil;
    NSPoint at = window && NSThread.isMainThread ? windowPoint(window, x, y) : NSZeroPoint;
    // A press that has no target before the open layout reaches the screen waits for that, and all input waits behind it.
    if (!(window && NSThread.isMainThread && surfaceLayoutHoldCall(window, phase == 1, at.x, at.y, ^{
            pointerThen(pointer, window, x, y, phase, button, deltaX, deltaY, clicks, done, context);
        }))) {
        pointerThen(pointer, handle, x, y, phase, button, deltaX, deltaY, clicks, done, context);
    }
}

static void pointerThen(SPPointer *pointer, void *handle, double x, double y, int phase, int button, double deltaX, double deltaY,
    int clicks, sp_input_done done, void *context) {
    NSWindow *window = (__bridge NSWindow *)handle;
    if (!pointer || !window || !NSThread.isMainThread || (button != 0 && button != 1)) {
        pointerNow(pointer, handle, x, y, phase, button, deltaX, deltaY, clicks, done, context);
        return;
    }
    const char *reason = NULL;
    if (phase == 0 && window.isVisible && !window.isMiniaturized && !keyForInput(window) && !heldBy(pointer, window, pageAt(window, windowPoint(window, x, y)), 0, NO, &reason)
        && enterVirtual(window)) {
        // WebKit drops a move until the page has heard that it is active, so the move waits for the state of the web views. The
        // wait has no limit: the report of each web view ends it, and so do the ends of a web view.
        __block BOOL finished = NO;
        afterWebViewsActive(window, nil, YES, ^{
            if (finished) return;
            finished = YES;
            pointerNow(pointer, handle, x, y, phase, button, deltaX, deltaY, clicks, done, context);
        }, ^(NSString *end, NSArray<NSString *> *unresolved) {
            if (finished) return;
            finished = YES;
            NSString *why = [NSString stringWithFormat:@"the web views did not hear the virtual key window before %@", end];
            logPointer(pointer, x, y, phase, button, deltaX, deltaY, clicks, SP_INPUT_UNRECEIVED, why.UTF8String, nil);
            done(context, SP_INPUT_UNRECEIVED, NULL);
        }, nil);
        return;
    }
    NSView *pressed = pointerTarget(pointer, window, windowPoint(window, x, y), phase, button);
    while (pressed && ![pressed isKindOfClass:WKWebView.class]) pressed = pressed.superview;
    WKWebView *target = (WKWebView *)pressed;
    if (phase == 4 && target) {
        // A window that is minimized or not shown presents nothing until it shows, so its scroll is refused in its turn.
        if (!window.isVisible || window.isMiniaturized) {
            logPointer(pointer, x, y, phase, button, deltaX, deltaY, clicks, SP_INPUT_UNRECEIVED,
                "the window is not shown, so the scroll target presents nothing until it shows", nil);
            done(context, SP_INPUT_UNRECEIVED, NULL);
            return;
        }
        // A wheel event received before the scroll tree of a new document is rendered does not move the document. The event is
        // delivered after the target web view has rendered its current state; the ends of the web view end the wait without it.
        __block BOOL finished = NO;
        __block id ends = nil;
        ends = [webviewInputObserveEnd(target, ^(NSString *end) {
            if (finished) return;
            finished = YES;
            [ends release];
            ends = nil;
            NSString *why = [NSString stringWithFormat:@"the scroll target did not present before %@", end];
            logPointer(pointer, x, y, phase, button, deltaX, deltaY, clicks, SP_INPUT_UNRECEIVED, why.UTF8String, nil);
            done(context, SP_INPUT_UNRECEIVED, NULL);
        }) retain];
        [target _doAfterNextPresentationUpdate:^{
            if (finished) return;
            finished = YES;
            webviewInputForgetEnd(ends);
            [ends release];
            ends = nil;
            pointerNow(pointer, handle, x, y, phase, button, deltaX, deltaY, clicks, done, context);
        }];
        return;
    }
    if (phase != 1 && phase != 3) {
        pointerNow(pointer, handle, x, y, phase, button, deltaX, deltaY, clicks, done, context);
        return;
    }
    if (!target) {
        pointerNow(pointer, handle, x, y, phase, button, deltaX, deltaY, clicks, done, context);
        return;
    }
    // Completes after the document has received pointerdown or pointerup. After receipt, it waits for the pending mouse
    // handling of WebKit, so the click that a release creates is also processed before the next request.
    __block sp_input_result result = SP_INPUT_REJECTED;
    __block SPHeld held = {0, nil, nil, "the press or release was not sent"};
    double originX = 0, originY = 0;
    BOOL hasPressContext = NO;
    if (phase == 1) {
        NSPoint pressPoint = windowPoint(window, x, y);
        originX = pressPoint.x;
        originY = pressPoint.y;
        hasPressContext = YES;
    } else if (phase == 3) {
        hasPressContext = pointerOrigin(pointer, window, button, &originX, &originY);
    }
    sp_input_press_context pressContext = {0};
    if (hasPressContext) sp_input_press_context_push(&pressContext, window, originX, originY);
    NSString *type = phase == 3 ? @"pointerup" : @"pointerdown";
    // The view that the press or release reaches when it is sent, which deliverPointer chooses in the same way.
    __block NSView *reached = nil;
    @try {
        webviewInputSendThen(target, type, ^SPInputSend {
            reached = [pointerTarget(pointer, window, windowPoint(window, x, y), phase, button) retain];
            result = pointerInput(pointer, handle, x, y, phase, button, deltaX, deltaY, clicks, &held);
            if (result != SP_INPUT_DELIVERED) return SPInputSendRefused;
            // A press or release that reached another view never reaches the awaited document, which ends its wait in this turn.
            NSView *page = reached;
            while (page && ![page isKindOfClass:WKWebView.class]) page = page.superview;
            return page == target ? SPInputSendDelivered : SPInputSendElsewhere;
        }, ^(BOOL received) {
            sp_input_result final = result == SP_INPUT_DELIVERED && received ? SP_INPUT_DELIVERED :
                result == SP_INPUT_DELIVERED ? SP_INPUT_UNRECEIVED : result;
            if (final == SP_INPUT_UNRECEIVED) logUnreceived(window, target, reached, type, x, y);
            [reached release];
            reached = nil;
            logPointer(pointer, x, y, phase, button, deltaX, deltaY, clicks, final,
                final == SP_INPUT_UNRECEIVED ? "the document did not receive the press or release" : held.why, held.holder);
            heldDone(done, context, final, held);
        });
    } @finally {
        if (hasPressContext) sp_input_press_context_pop(&pressContext);
    }
}

static void collectVisibleWebViews(NSView *view, NSMutableArray<WKWebView *> *found, BOOL ancestorVisible) {
    BOOL visible = ancestorVisible && !view.hidden && view.alphaValue > 0 && view.window != nil;
    if (visible && [view isKindOfClass:WKWebView.class]) [found addObject:(WKWebView *)view];
    for (NSView *child in view.subviews) collectVisibleWebViews(child, found, visible);
}

@implementation SPInputActivityWait {
    NSArray<NSString *> *_identifiers;
    sp_input_activity_wait_completion _completion;
    NSMutableIndexSet *_completedMembers;
    BOOL _finished;
}

- (instancetype)initWithIdentifiers:(NSArray<NSString *> *)identifiers completion:(sp_input_activity_wait_completion)completion {
    self = [super init];
    if (!self) return nil;
    _identifiers = [identifiers copy];
    _completion = [completion copy];
    _completedMembers = [[NSMutableIndexSet alloc] init];
    return self;
}

- (BOOL)installIfActivationPending:(BOOL)pending store:(void (^)(SPInputActivityWait *))store {
    if (!pending) {
        [self finish];
        return NO; // silent: a completed activation discards this late waiter after releasing its completion callback.
    }
    store(self);
    return YES;
}

- (void)startWithRegistration:(sp_input_activity_register_member)registration {
    NSCAssert(NSThread.isMainThread, @"webview activity waits belong to the main thread");
    if (_finished) return;
    for (NSUInteger index = 0; index < _identifiers.count; index++) {
        if (_finished) return;
        registration(index, _identifiers[index], ^{
            if (_finished) return;
            if ([_completedMembers containsIndex:index]) return;
            [_completedMembers addIndex:index];
            if (_completedMembers.count == _identifiers.count) {
                _finished = YES;
                sp_input_activity_wait_completion completion = [_completion copy];
                [_completion release];
                _completion = nil;
                if (completion) completion();
                [completion release];
            }
        });
    }
}

- (NSArray<NSString *> *)unresolvedIdentifiers {
    if (_finished) return @[];
    NSMutableArray<NSString *> *unresolved = [NSMutableArray array];
    for (NSUInteger index = 0; index < _identifiers.count; index++) {
        if (![_completedMembers containsIndex:index]) [unresolved addObject:_identifiers[index]];
    }
    return unresolved;
}

- (NSArray<NSString *> *)finish {
    if (_finished) return @[];
    NSArray<NSString *> *unresolved = [[self unresolvedIdentifiers] copy];
    _finished = YES;
    [_completion release];
    _completion = nil;
    return [unresolved autorelease];
}

- (void)dealloc {
    [_identifiers release];
    [_completion release];
    [_completedMembers release];
    [super dealloc];
}

@end

NSString *sp_input_activity_end_message(BOOL activationReady, BOOL registrationStarted,
    NSArray<NSString *> *unresolvedIdentifiers, NSString *end) {
    if (!activationReady) return nil;
    if (!registrationStarted) return [NSString stringWithFormat:@"webview activity-state registration pending when %@", end];
    if (unresolvedIdentifiers.count == 0) return nil;
    return [NSString stringWithFormat:@"webview activity state not applied when %@; unresolved members: %@", end,
        [unresolvedIdentifiers componentsJoinedByString:@", "]];
}

// Calls done after every web view in the window has sent its activity state to the web process. When WebKit receives
// the key window notification, it schedules the activity state transmission, and _doAfterActivityStateUpdate: is called
// after the scheduled transmission finishes (immediately when none is scheduled). The registration is made in the next
// main queue turn so that it runs after every other observer of the notification has run.
static NSArray<NSString *> *activityWaitIdentifiers(NSWindow *window, NSArray<WKWebView *> *views) {
    void *main = sp_window_main_webview(window);
    NSMutableArray<NSString *> *identifiers = [NSMutableArray arrayWithCapacity:views.count];
    [views enumerateObjectsUsingBlock:^(WKWebView *view, NSUInteger index, BOOL *stop) {
        (void)stop;
        NSString *identity = (__bridge void *)view == main
            ? @"role=main"
            : [NSString stringWithFormat:@"view=%p", view];
        [identifiers addObject:[NSString stringWithFormat:@"%@ registrationIndex=%lu",
            identity, (unsigned long)index]];
    }];
    return identifiers;
}

// The ends of a web view (webviewInputObserveEnd) end the wait with the text of the end and the members that had not reported.
static void afterWebViewsActive(NSWindow *window, WKWebView *target, BOOL waitForAll, void (^done)(void),
    void (^ended)(NSString *end, NSArray<NSString *> *unresolved), void (^waitCreated)(SPInputActivityWait *)) {
    dispatch_async(dispatch_get_main_queue(), ^{
        NSMutableArray<WKWebView *> *views = [NSMutableArray array];
        if (target) [views addObject:target];
        else if (waitForAll) collectVisibleWebViews(window.contentView.superview ?: window.contentView, views, YES);
        // A web view without a WebContent process (no page loaded yet) has no process to send the activity state to: WebKit
        // never reports the transmission, so waiting for it would never end. The process that a later load starts reads the
        // activity state of the view when it starts. _webProcessIdentifier is private (docs/operations/private-native-apis.md).
        [views filterUsingPredicate:[NSPredicate predicateWithBlock:^BOOL(WKWebView *view, NSDictionary *bindings) {
            (void)bindings;
            return view._webProcessIdentifier != 0;
        }]];
        if (views.count == 0) { if (waitCreated) waitCreated(nil); done(); return; }
        NSMutableArray *ends = [NSMutableArray array];
        void (^stop)(void) = ^{
            for (id token in ends) webviewInputForgetEnd(token);
            [ends removeAllObjects];
        };
        SPInputActivityWait *activityWait = [[[SPInputActivityWait alloc]
            initWithIdentifiers:activityWaitIdentifiers(window, views) completion:^{ stop(); done(); }] autorelease];
        if (waitCreated) waitCreated(activityWait);
        // A step that ended before this turn finished the wait, which then observes and registers nothing.
        if ([activityWait unresolvedIdentifiers].count == 0) return;
        for (WKWebView *view in views) {
            [ends addObject:webviewInputObserveEnd(view, ^(NSString *end) {
                NSArray<NSString *> *unresolved = [activityWait finish];
                stop();
                ended(end, unresolved);
            })];
        }
        [activityWait startWithRegistration:^(NSUInteger index, NSString *identifier,
            sp_input_activity_member_completion completion) {
            (void)identifier;
            [views[index] _doAfterActivityStateUpdate:completion];
        }];
    });
}

static void report(sp_activate_done done, void *context, sp_activate_result result) {
    if (result == SP_ACTIVATE_DONE) { done(context, result, NULL); return; }
    NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
    NSString *name = front.bundleIdentifier ?: front.localizedName;
    done(context, result, name.UTF8String);
}

// The activation is emulated (docs/spec/exposure.md#methods): it never asks the system to activate the application or to order
// the window, so it takes the keyboard from no other application and works for a covered window and a window on no display. In an
// application that is not really active the window becomes the virtual key window, which answers as the key window of an active
// application; in an application that is really active the window becomes its key window.
static void activateWindow(NSWindow *window, WKWebView *target, BOOL waitForAll, sp_activate_done done, void *context) {
    if (!window || !NSThread.isMainThread) { report(done, context, SP_ACTIVATE_REJECTED); return; }
    // A window that cannot become key or is minimized is refused in its turn: an active application cannot make it key either.
    if (!window.canBecomeKeyWindow || window.isMiniaturized) { report(done, context, SP_ACTIVATE_NOT_KEY); return; }
    if (sp_input_virtual_real_active()) [window makeKeyWindow];
    else sp_input_virtual_enter(window);
    if (!NSApp.isActive || !window.isKeyWindow) { report(done, context, SP_ACTIVATE_NOT_KEY); return; }
    NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
    __block bool finished = false;
    NSMutableArray *observers = [NSMutableArray array];
    __block SPInputActivityWait *activityWait = nil;
    void (^finish)(sp_activate_result) = ^(sp_activate_result result) {
        if (finished) return;
        finished = true;
        for (id observer in observers) [center removeObserver:observer];
        [observers removeAllObjects];
        [activityWait finish];
        [activityWait release];
        activityWait = nil;
        report(done, context, result);
    };
    // Checks that the window is still active after the web view sent its activity state. Input to another window or a real
    // activation of another window can take the key in between.
    void (^applied)(void) = ^{
        finish(NSApp.isActive && window.isKeyWindow ? SP_ACTIVATE_DONE : SP_ACTIVATE_LOST);
    };
    // Each visible web view reports that it sent the active state. The loss of the activation of the application or of the window
    // ends the wait at once, and the close of the window and the ends of a web view end it as pending.
    [observers addObject:sp_observe_notification("input_inject.app_resign", SP_OBSERVE_RECORD,
        NSApplicationDidResignActiveNotification, NSApp, nil, ^(NSNotification *note) { finish(SP_ACTIVATE_LOST); })];
    [observers addObject:sp_observe_notification("input_inject.key_resign", SP_OBSERVE_RECORD,
        NSWindowDidResignKeyNotification, window, nil, ^(NSNotification *note) { finish(SP_ACTIVATE_LOST); })];
    void (^pending)(NSString *, NSArray<NSString *> *) = ^(NSString *end, NSArray<NSString *> *unresolved) {
        if (finished) return;
        NSString *message = sp_input_activity_end_message(YES, activityWait != nil, unresolved, end);
        if (message) sp_log_error("input inject", message.UTF8String);
        finish(SP_ACTIVATE_PENDING);
    };
    [observers addObject:sp_observe_notification("input_inject.activate_close", SP_OBSERVE_RECORD,
        NSWindowWillCloseNotification, window, nil, ^(NSNotification *note) {
            pending(@"the window closed", [activityWait finish]);
        })];
    afterWebViewsActive(window, target, waitForAll, applied, pending, ^(SPInputActivityWait *wait) {
        [wait installIfActivationPending:!finished store:^(SPInputActivityWait *installed) {
            [activityWait release];
            activityWait = [installed retain];
        }];
    });
}

void sp_input_activate(void *handle, sp_activate_done done, void *context) {
    activateWindow((__bridge NSWindow *)handle, nil, YES, done, context);
}

void sp_input_activate_at(void *handle, double x, double y, sp_activate_done done, void *context) {
    NSWindow *window = (__bridge NSWindow *)handle;
    WKWebView *target = window && NSThread.isMainThread ? webViewAt(window, x, y) : nil;
    activateWindow(window, target, NO, done, context);
}

typedef struct { const char *name; unsigned short code; } SPKey;

// macOS key code of a named key. AppKit derives a character from the key code and the current input source.
static const SPKey keys[] = {
    {"Enter", 36}, {"Tab", 48}, {"Escape", 53}, {"Backspace", 51},
    {"Delete", 117}, {"Space", 49},
    {"ArrowLeft", 123}, {"ArrowRight", 124},
    {"ArrowDown", 125}, {"ArrowUp", 126},
    {"Home", 115}, {"End", 119},
    {"PageUp", 116}, {"PageDown", 121},
};

// An NSEvent that carries only a character has no physical key identity. NSTextInputContext needs a key code to
// apply the current keyboard input source, and Korean composition is included. The code below converts the
// character specified by the endpoint to a macOS ANSI keyboard position, and rejects an unknown character instead of
// replacing it with a guessed code.
static unsigned short characterKeyCode(unichar character) {
    static const char punctuation[] = "=-'`[];,./\\";
    static const unsigned short punctuationCodes[] = {kVK_ANSI_Equal, kVK_ANSI_Minus, kVK_ANSI_Quote, kVK_ANSI_Grave,
        kVK_ANSI_LeftBracket, kVK_ANSI_RightBracket, kVK_ANSI_Semicolon, kVK_ANSI_Comma, kVK_ANSI_Period, kVK_ANSI_Slash,
        kVK_ANSI_Backslash};
    for (NSUInteger i = 0; i < sizeof punctuationCodes / sizeof punctuationCodes[0]; i++) {
        if (character == (unichar)punctuation[i]) return punctuationCodes[i];
    }
    static const char *letters = "abcdefghijklmnopqrstuvwxyz";
    static const unsigned short letterCodes[] = {0, 11, 8, 2, 14, 3, 5, 4, 34, 38, 40, 37, 46, 45, 31, 35, 12, 15, 1, 17, 32, 9, 13, 7, 16, 6};
    for (NSUInteger i = 0; i < 26; i++) if (character == letters[i]) return letterCodes[i];
    static const char digits[] = "1234567890";
    static const unsigned short digitCodes[] = {18, 19, 20, 21, 23, 22, 26, 28, 25, 29};
    for (NSUInteger i = 0; i < 10; i++) if (character == digits[i]) return digitCodes[i];
    return USHRT_MAX;
}

static CGEventFlags cgFlags(unsigned modifiers) {
    CGEventFlags result = 0;
    if (modifiers & 1) result |= kCGEventFlagMaskShift;
    if (modifiers & 2) result |= kCGEventFlagMaskControl;
    if (modifiers & 4) result |= kCGEventFlagMaskAlternate;
    if (modifiers & 8) result |= kCGEventFlagMaskCommand;
    return result;
}

// Sets the time of a key event that is made now. NSEvent.timestamp, which a web view gives its key event as event.timeStamp,
// counts the uptime of the system, and both paths of keyInput take their time from here. AppKit converts that uptime into the
// timestamp of the CGEvent of a key event, so no unit of CGEventTimestamp is assumed here. Returns false when AppKit makes no
// such event.
static bool stampNow(CGEventRef event) {
    NSEvent *now = [NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:0
        timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:0 context:nil characters:@"" charactersIgnoringModifiers:@""
        isARepeat:NO keyCode:0];
    CGEventRef stamped = now.CGEvent;
    if (!stamped) return false;
    CGEventSetTimestamp(event, CGEventGetTimestamp(stamped));
    return true;
}

// equivalent is set when a key down of the virtual key window is taken as a key equivalent, and typed when a key down of the
// virtual key window types its stated text through the text input of a web view.
static sp_input_result keyInput(void *handle, const char *key, const char *text, unsigned modifiers, bool down,
    const char **why, bool *equivalent, bool *typed) {
    NSWindow *window = (__bridge NSWindow *)handle;
    *why = "";
    *equivalent = false;
    *typed = false;
    if (!window || !key || !NSThread.isMainThread) { *why = "no window, no key or not the main thread"; return SP_INPUT_REJECTED; }
    window = keyWindowOf(window);
    NSSavePanel *panel = systemPanelOf(window);
    if (panel) return systemPanelKey(panel, key, text, modifiers, down, why);
    NSString *name = [NSString stringWithUTF8String:key];
    unsigned short code = USHRT_MAX;
    for (size_t i = 0; i < sizeof(keys) / sizeof(keys[0]); i++) {
        if (strcmp(keys[i].name, key) == 0) {
            code = keys[i].code;
            break;
        }
    }
    BOOL named = code != USHRT_MAX;
    if (code == USHRT_MAX) {
        if (name.length != 1) { *why = "unknown key name"; return SP_INPUT_REJECTED; }
        code = characterKeyCode([name characterAtIndex:0]);
        if (code == USHRT_MAX) { *why = "unknown key name"; return SP_INPUT_REJECTED; }
    }
    NSString *characters = text ? [NSString stringWithUTF8String:text] : nil;
    NSEvent *event = nil;
    if (!text) {
        // AppKit derives the character from the physical key and the current input source. The same applies to a named key.
        // An event with a character inserted directly from the caller does not pass through the input method (for example Backspace during composition).
        // CGEventCreateKeyboardEvent sets a time of its own; the key takes the time that the stated-text path takes.
        CGEventRef raw = CGEventCreateKeyboardEvent(NULL, code, down);
        if (raw) {
            CGEventSetFlags(raw, cgFlags(modifiers));
            CGEventSetIntegerValueField(raw, kSPEventWindowNumberField, window.windowNumber);
            if (stampNow(raw)) event = [NSEvent eventWithCGEvent:raw];
            CFRelease(raw);
        }
    } else {
        event = [NSEvent keyEventWithType:down ? NSEventTypeKeyDown : NSEventTypeKeyUp
            location:NSZeroPoint modifierFlags:flags(modifiers)
            timestamp:0 windowNumber:window.windowNumber
            context:nil characters:characters charactersIgnoringModifiers:characters
            isARepeat:NO keyCode:code];
        // The event carries the mark of a stated text, so a region that types it without the input method types that text,
        // also when it receives the key later than its delivery. The copy is the delivered event, so it takes the time.
        CGEventRef marked = event ? CGEventCreateCopy(event.CGEvent) : NULL;
        event = nil;
        if (marked) {
            CGEventSetIntegerValueField(marked, kCGEventSourceUserData, SP_INPUT_STATED_TEXT);
            // The copy of an event whose text has more than one character carries the character of the key code instead, so the
            // whole text is set on it again. AppKit still gives a key up of such a text the character of the key code.
            unichar *units = malloc(characters.length * sizeof(unichar));
            [characters getCharacters:units range:NSMakeRange(0, characters.length)];
            CGEventKeyboardSetUnicodeString(marked, characters.length, units);
            free(units);
            if (stampNow(marked)) event = [NSEvent eventWithCGEvent:marked];
            CFRelease(marked);
        }
    }
    if (!event) { *why = "the key event cannot be created"; return SP_INPUT_REJECTED; }
    // Bind the complete immutable key payload at its producer boundary. An
    // NSEvent wrapping a CGEvent can materialize these fields lazily: leaving
    // that work to a consumer made native menu matching depend on whether an
    // earlier observer had read them. Keep the original event, input-source
    // translation, flags and stated-text mark; never substitute characters.
    (void)event.characters;
    (void)event.charactersIgnoringModifiers;
    // A key of the virtual key window passes -[NSApplication sendEvent:] as the key of a person does, so the local monitors see
    // it; there the virtual key window answers as the key window of an active application. The virtual path enforces this project's declared native-menu ownership (shortcuts.json): an enabled menu equivalent
    // owns the key before a view. NSMenu resolves and validates that owner; an unclaimed key reaches window equivalents,
    // then the first responder. This is project policy, not AppKit's default view-first dispatch order. A key down of a
    // named key or with a stated text goes to a web view without its input context: a stated text is typed through the text
    // input of the web view, and a named key runs the command of its key binding.
    if (enterVirtual(window)) {
        if (down && (event.modifierFlags & (NSEventModifierFlagCommand | NSEventModifierFlagControl))) {
            *equivalent = [NSApp.mainMenu performKeyEquivalent:event] || [window performKeyEquivalent:event];
        }
        bool toWebView = !*equivalent && down && (named || text) && sp_input_virtual_send_key_to_web_view(window, event);
        *typed = toWebView && text && !named;
        if (!*equivalent && !toWebView) [NSApp sendEvent:event];
        return SP_INPUT_DELIVERED;
    }
    // A human key goes only to the key window. When another window is the key window, the key is not delivered to the target window and the
    // result says so.
    NSWindow *keyWindow = NSApp.keyWindow;
    if (keyWindow && keyWindow != window) { *why = "another window is the key window"; return SP_INPUT_INACTIVE; }
    // When the target window is the key window, the key is dispatched with -[NSApplication sendEvent:] like a human key.
    // AppKit also decides the menu key equivalents (Command+C, Command+V).
    if (keyWindow == window) [NSApp sendEvent:event];
    else [window sendEvent:event];
    return SP_INPUT_DELIVERED;
}

sp_input_result sp_input_text(void *handle, sp_input_text_phase phase, const char *text, long selectionStart, long selectionLength,
    long replacementStart, long replacementLength) {
    NSCAssert(NSThread.isMainThread, @"text input belongs to the main thread");
    NSWindow *window = (__bridge NSWindow *)handle;
    if (!window || phase < SP_INPUT_TEXT_MARK || phase > SP_INPUT_TEXT_UNMARK) return SP_INPUT_REJECTED;
    NSString *string = text ? [NSString stringWithUTF8String:text] : nil;
    if (phase != SP_INPUT_TEXT_UNMARK && !string) return SP_INPUT_REJECTED;
    if (phase == SP_INPUT_TEXT_MARK && (selectionStart < 0 || selectionLength < 0
        || (NSUInteger)selectionStart + (NSUInteger)selectionLength > string.length)) {
        return SP_INPUT_REJECTED;
    }
    if (replacementStart >= 0 && replacementLength < 0) return SP_INPUT_REJECTED;
    // The name of a panel of the system takes a committed text at its end; a composition or a replacement has no field of this
    // process to show it in.
    NSSavePanel *panel = systemPanelOf(keyWindowOf(window));
    if (panel) {
        if (phase != SP_INPUT_TEXT_INSERT || replacementStart >= 0 || [panel isKindOfClass:NSOpenPanel.class]) return SP_INPUT_REJECTED;
        systemPanelType(panel, string);
        return SP_INPUT_DELIVERED;
    }
    // The window takes the keyboard as for a key: in an application that is not really active it becomes the virtual key window, so
    // the page holds its focus; in an application that is really active the step goes to the window whether it is key or not.
    if (!keyForInput(window)) enterVirtual(window);
    id<NSTextInputClient> client = (__bridge id<NSTextInputClient>)sp_input_virtual_text_client(handle);
    if (!client) return SP_INPUT_REJECTED;
    NSRange replacement = replacementStart < 0 ? NSMakeRange(NSNotFound, 0) : NSMakeRange((NSUInteger)replacementStart, (NSUInteger)replacementLength);
    switch (phase) {
        case SP_INPUT_TEXT_MARK:
            [client setMarkedText:string selectedRange:NSMakeRange((NSUInteger)selectionStart, (NSUInteger)selectionLength)
                 replacementRange:replacement];
            break;
        case SP_INPUT_TEXT_INSERT: [client insertText:string replacementRange:replacement]; break;
        case SP_INPUT_TEXT_UNMARK: [client unmarkText]; break;
    }
    return SP_INPUT_DELIVERED;
}

// JSON string of text; null when text is NULL.
static NSString *jsonText(const char *text) {
    if (!text) return @"null";
    NSData *data = [NSJSONSerialization dataWithJSONObject:[NSString stringWithUTF8String:text]
        options:NSJSONWritingFragmentsAllowed error:NULL];
    return data ? [[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] autorelease] : @"null";
}

static sp_input_result keyNow(void *handle, const char *key, const char *text, unsigned modifiers, bool down, bool held);
static void logKey(NSWindow *window, const char *key, const char *text, unsigned modifiers, bool down, sp_input_result result,
    const char *why, NSString *responderName, bool equivalent, bool typed, bool held);

// Delivers a key behind the input of its window that waits. Whether the key is kept is the only answer the caller has until its
// turn, and the record of that turn states the result and that the key waited; a key that the close of its window drops is
// recorded as rejected, so each kept key has one result.
sp_input_result sp_input_key(void *handle, const char *key, const char *text, unsigned modifiers, bool down) {
    NSWindow *window = (__bridge NSWindow *)handle;
    NSString *keptKey = key ? [NSString stringWithUTF8String:key] : nil, *keptText = text ? [NSString stringWithUTF8String:text] : nil;
    if (window && NSThread.isMainThread && surfaceLayoutHoldKey(window, ^{
            keyNow(window, keptKey.UTF8String, keptText.UTF8String, modifiers, down, true);
        }, ^{
            logKey(window, keptKey.UTF8String, keptText.UTF8String, modifiers, down, SP_INPUT_REJECTED,
                "the window closed while the key waited", @"none", false, false, true);
        })) {
        return SP_INPUT_DELIVERED;
    }
    return keyNow(handle, key, text, modifiers, down, false);
}

static sp_input_result keyNow(void *handle, const char *key, const char *text, unsigned modifiers, bool down, bool held) {
    const char *why = "";
    bool equivalent = false, typed = false;
    // The view that holds the keyboard when the key is sent receives it; the record names it with the key window.
    NSWindow *window = (__bridge NSWindow *)handle;
    NSResponder *responder = window.firstResponder;
    NSString *responderName = responder ? NSStringFromClass(responder.class) : @"none";
    sp_input_result result = keyInput(handle, key, text, modifiers, down, &why, &equivalent, &typed);
    logKey(window, key, text, modifiers, down, result, why, responderName, equivalent, typed, held);
    return result;
}

// Records the result of a key: the view that held the keyboard when the key was sent, with the key window.
static void logKey(NSWindow *window, const char *key, const char *text, unsigned modifiers, bool down, sp_input_result result,
    const char *why, NSString *responderName, bool equivalent, bool typed, bool held) {
    NSString *record = [NSString stringWithFormat:
        @"{\"kind\":\"key\",\"key\":%@,\"text\":%@,\"modifiers\":%u,\"down\":%s,\"result\":\"%s\",\"reason\":\"%s\","
        "\"responder\":\"%@\",\"keyWindow\":%s,\"equivalent\":%s,\"virtualKeyText\":%s,\"held\":%s}",
        jsonText(key), jsonText(text), modifiers, down ? "true" : "false", resultName(result), why, responderName,
        window.isKeyWindow ? "true" : "false", equivalent ? "true" : "false", typed ? "true" : "false", held ? "true" : "false"];
    sp_log_info("input inject", record.UTF8String);
}
