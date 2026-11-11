// Reads the native values of the window state that the host publishes (host.window, host.screens, host.dock).
#import <Cocoa/Cocoa.h>
#import <sys/sysctl.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#import <CommonCrypto/CommonDigest.h>
#include <errno.h>
#include <signal.h>
#import "window_facts.h"
#import "input_virtual.h"
#import "observe.h"
#import "activity_observers.h"
#import "application_log.h"
#import "event_ring.h"
#import "webview_geometry.h"
#import "private/webkit.h"
#import "surface_layout.h"
#import "webview_navigation.h"
#import "document_view.h"

static const char mainWebviewKey;

void *sp_window_set_main_webview(void *handle, void *mainHandle) {
    NSCAssert(NSThread.isMainThread, @"window registration requires the UI thread");
    NSWindow *window = (NSWindow *)handle;
    WKWebView *main = (WKWebView *)mainHandle;
    if (!window || ![main isKindOfClass:WKWebView.class] || main.window != window) {
        sp_log_error("window facts", "the main web view to register is missing or belongs to another window");
        return NULL;
    }
    NSValue *registered = objc_getAssociatedObject(window, &mainWebviewKey);
    if (registered && registered.nonretainedObjectValue != main) {
        sp_log_error("window facts", "the window already has another main web view");
        return NULL;
    }
    if (registered) return sp_webview_window_composition(main);
    // The layout indicator waits for the next presentation of this web view, so this web view must
    // render at the display refresh rate.
    if (!surfaceLayoutRenderAtDisplayRate(main)) {
        sp_log_error("window facts", "the main web view cannot render at the display rate");
        return NULL;
    }
    // For the same reason this web view renders while the window is occluded, so that the layout indicator of an
    // occluded window and the commands that wait for it finish.
    if (!sp_webview_render_occluded(main, true)) {
        sp_log_error("window facts", "the main web view cannot render while its window is occluded");
        return NULL;
    }
    // Open the new document of the main frame in a new process so that a reload and a page change do
    // not keep the previous document.
    if (!sp_webview_replace_documents_in_new_process(main)) {
        sp_log_error("window facts", "the main web view cannot open its documents in a new process");
        return NULL;
    }
    void *composition = sp_webview_window_composition(main);
    if (!composition) return NULL;
    objc_setAssociatedObject(window, &mainWebviewKey, [NSValue valueWithNonretainedObject:main], OBJC_ASSOCIATION_RETAIN);
    return composition;
}

void *sp_window_main_webview(void *handle) {
    NSWindow *window = (NSWindow *)handle;
    NSValue *registered = objc_getAssociatedObject(window, &mainWebviewKey);
    return registered.nonretainedObjectValue;
}

static WKWebView *mainWebview(NSWindow *window) { return sp_window_main_webview(window); }

static BOOL webviewFocused(NSView *view) {
    NSResponder *responder = view.window.firstResponder;
    if (responder == view) return YES;
    return [responder isKindOfClass:NSView.class] && [(NSView *)responder isDescendantOf:view];
}

static char *copyJSON(id value) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
    if (!data) {
        sp_log_error("window facts", "the facts could not be serialized");
        return NULL;
    }
    char *text = malloc(data.length + 1);
    memcpy(text, data.bytes, data.length);
    text[data.length] = 0;
    return text;
}

void sp_facts_free(char *text) { free(text); }

static CGFloat primaryTop(void) { return NSMaxY(NSScreen.screens.firstObject.frame); }

static NSDictionary *screenRect(NSRect rect) {
    return @{ @"x": @(rect.origin.x), @"y": @(primaryTop() - NSMaxY(rect)),
        @"width": @(rect.size.width), @"height": @(rect.size.height) };
}

// Converts a rectangle in window base coordinates (origin at the bottom left) to coordinates relative to
// the top left of the content area. The content view is at the origin of the window base coordinates.
static NSDictionary *windowRect(NSWindow *window, NSRect base) {
    CGFloat height = window.contentView.frame.size.height;
    return @{ @"x": @(base.origin.x), @"y": @(height - NSMaxY(base)),
        @"width": @(base.size.width), @"height": @(base.size.height) };
}

static void collectWebViews(NSView *view, NSMutableArray<WKWebView *> *found) {
    // A parent is drawn before its children, and among the subviews of one parent a later one is drawn above.
    if ([view isKindOfClass:WKWebView.class]) [found addObject:(WKWebView *)view];
    for (NSView *child in view.subviews) collectWebViews(child, found);
}

// The WebContent processes that a reading of the window facts saw hold a page of the application. A process stays here while it
// lives after its last page is gone, so a reading reports it as a process without a page until it ends.
static NSMutableSet<NSNumber *> *pageProcesses;

// The WebContent processes that hold a page of a web view in a window of the application now.
static NSMutableSet<NSNumber *> *processesWithPages(void) {
    NSMutableSet<NSNumber *> *found = [NSMutableSet set];
    for (NSWindow *each in NSApp.windows) {
        NSMutableArray<WKWebView *> *views = [NSMutableArray array];
        if (each.contentView) collectWebViews(each.contentView, views);
        for (WKWebView *view in views) {
            pid_t process = view._webProcessIdentifier;
            if (process > 0) [found addObject:@(process)];
        }
    }
    return found;
}

// Whether process lives. A process that exits is marked exiting (P_WEXIT) before the system posts its exit and stays a zombie
// until its parent reaps it, and kill answers both as a process, so the state of the process decides: an exiting process and a
// zombie do not live.
static BOOL lives(pid_t process) {
    int name[] = { CTL_KERN, KERN_PROC, KERN_PROC_PID, process };
    struct kinfo_proc info;
    size_t size = sizeof info;
    if (sysctl(name, 4, &info, &size, NULL, 0) != 0) return errno != ESRCH; // silent: a process that the table cannot read for another reason than its absence lives, as kill answers it
    if (size == 0) return NO; // silent: a process that the table no longer holds answers no row, so it does not live
    return info.kp_proc.p_stat != SZOMB && !(info.kp_proc.p_flag & P_WEXIT);
}

// The rows {pid, ending} of the WebContent processes that held a page of the application and hold none now, while they live, in
// the order of their pid. ending is true when the process pool keeps no process cache (_processCacheCapacity 0): WebKit then ends
// a process whose last page is gone, so its exit is an event that the close of its pages makes. When the pool has a cache, a
// process without a page may stay in it, and ending is false.
static NSArray *pagelessProcesses(WKWebView *any) {
    NSMutableSet<NSNumber *> *current = processesWithPages();
    if (!pageProcesses) pageProcesses = [[NSMutableSet alloc] init];
    // A window without a web view reads the pool of a new configuration, which WebKit gives the one pool of the application. The
    // deprecation notice of WKProcessPool means that creating several pools has no effect; the cache capacity exists only in this class.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    WKProcessPool *pool = any ? any.configuration.processPool : [[[WKWebViewConfiguration alloc] init] autorelease].processPool;
#pragma clang diagnostic pop
    // A pool that does not answer the capacity may keep a process, so no process of it is reported ending.
    BOOL cache = !pool || ![pool respondsToSelector:@selector(_processCacheCapacity)] || pool._processCacheCapacity > 0;
    NSMutableArray *rows = [NSMutableArray array];
    for (NSNumber *process in [pageProcesses.allObjects sortedArrayUsingSelector:@selector(compare:)]) {
        if ([current containsObject:process]) continue;
        if (!lives(process.intValue)) {
            [pageProcesses removeObject:process];
            continue;
        }
        // `!cache` is an int, which boxes as a number; the fact is a boolean.
        [rows addObject:@{ @"pid": process, @"ending": cache ? @NO : @YES }];
    }
    [pageProcesses unionSet:current];
    return rows;
}

static void collectSurfaces(NSWindow *window, NSView *view, NSMutableArray *found) {
    NSView *plane = sp_surface_native_plane(view);
    if (plane && plane.superview == view) {
        NSMutableDictionary *row = [windowRect(window, [view convertRect:view.bounds toView:nil]) mutableCopy];
        row[@"view"] = @((unsigned long long)(uintptr_t)view);
        row[@"hidden"] = @(view.isHiddenOrHasHiddenAncestor);
        [found addObject:row];
        [row release];
    }
    for (NSView *child in view.subviews) collectSurfaces(window, child, found);
}

// The system pointer in screen coordinates, or the injected position of a virtual key window, which is the position of its pages.
static NSDictionary *pointerFact(NSWindow *window) {
    double x = 0, y = 0;
    sp_input_virtual_real_mouse_location(&x, &y);
    NSPoint at = NSMakePoint(x, y);
    if (sp_input_virtual_point((__bridge void *)window, &x, &y)) at = [window convertPointToScreen:NSMakePoint(x, y)];
    return @{ @"x": @(at.x), @"y": @(primaryTop() - at.y) };
}

char *sp_window_facts(void *handle, void *surfaceView) {
    NSWindow *window = (NSWindow *)handle;
    if (!window || !window.contentView || ((NSView *)surfaceView).window != window) {
        sp_log_error("window facts", "the window has no content view or the view that holds its surfaces is not in it");
        return NULL;
    }
    NSView *content = window.contentView;
    NSMutableArray *controls = [NSMutableArray array];
    for (NSUInteger kind = NSWindowCloseButton; kind <= NSWindowZoomButton; kind++) {
        NSButton *button = [window standardWindowButton:kind];
        if (!button) continue;
        NSRect rect = [button convertRect:[button alignmentRectForFrame:button.bounds] toView:nil];
        NSMutableDictionary *row = [windowRect(window, rect) mutableCopy];
        row[@"hidden"] = @(button.isHiddenOrHasHiddenAncestor);
        [controls addObject:row];
        [row release];
    }
    NSMutableArray<WKWebView *> *views = [NSMutableArray array];
    collectWebViews(content, views);
    NSMutableArray *surfaces = [NSMutableArray array];
    collectSurfaces(window, content, surfaces);
    NSMutableArray *webviews = [NSMutableArray array];
    NSUInteger documents = 0;
    for (WKWebView *view in views) {
        NSRect rect = [view convertRect:view.bounds toView:nil];
        NSMutableDictionary *row = [windowRect(window, rect) mutableCopy];
        row[@"view"] = @((unsigned long long)(uintptr_t)view);
        row[@"hidden"] = @(view.isHiddenOrHasHiddenAncestor);
        row[@"focused"] = @(webviewFocused(view));
        // drawsBackground is a private KVC key. See docs/operations/private-native-apis.md.
        row[@"draws"] = [view valueForKey:@"drawsBackground"];
        row[@"alpha"] = @(view.underPageBackgroundColor.alphaComponent);
        row[@"main"] = @((BOOL)(view == mainWebview(window)));
        // _webProcessIdentifier is private (docs/operations/private-native-apis.md): the WebContent process of the view, 0
        // before it has one, so the memory of a document web view is attributed to its surface.
        row[@"process"] = @(view._webProcessIdentifier);
        // A document web view that the host blurs while a dialog is open carries the blur filter (sp_document_background).
        row[@"blurred"] = @((BOOL)(view.contentFilters.count > 0));
        int near60 = surfaceLayoutPrefersNear60FPS(view);
        row[@"near60fps"] = near60 < 0 ? (id)NSNull.null : @(near60 == 1);
        NSView *nativePlane = (NSView *)sp_surface_native_plane(view);
        BOOL document = view != mainWebview(window) && nativePlane && [view isDescendantOf:nativePlane];
        row[@"document"] = @(document);
        if (document) documents++;
        [webviews addObject:row];
        [row release];
    }
    // The first responder and the web view that contains it. Reports where keyboard input goes.
    // surface is the surface view that contains the first responder and uses the same reference as
    // view of nativeSurfaces.
    NSResponder *first = window.firstResponder;
    NSView *owner = [first isKindOfClass:NSView.class] ? (NSView *)first : nil;
    while (owner && ![owner isKindOfClass:WKWebView.class]) owner = owner.superview;
    NSView *surface = [first isKindOfClass:NSView.class] ? (NSView *)first : nil;
    while (surface) {
        NSView *plane = sp_surface_native_plane(surface);
        if (plane && plane.superview == surface) break;
        surface = surface.superview;
    }
    NSDictionary *responder = @{
        @"class": first ? NSStringFromClass(first.class) : @"",
        @"webview": @((unsigned long long)(uintptr_t)owner),
        @"surface": @((unsigned long long)(uintptr_t)surface),
        @"main": owner != nil && owner == mainWebview(window) ? @YES : @NO,
    };
    return copyJSON(@{
        @"responder": responder,
        @"frame": screenRect(window.frame),
        @"pointer": pointerFact(window),
        @"content": @{ @"width": @(content.bounds.size.width), @"height": @(content.bounds.size.height) },
        @"scale": @(window.backingScaleFactor),
        // The refresh rate cannot be determined when the window is on no screen, so it is null.
        @"refreshRate": window.screen ? (id)@(window.screen.maximumFramesPerSecond) : (id)NSNull.null,
        @"key": @(sp_input_virtual_real_key(handle)),
        @"virtualKey": @(sp_input_virtual_is(handle)),
        @"cursor": sp_input_virtual_cursor(handle) ? @(sp_input_virtual_cursor(handle)) : (id)NSNull.null,
        @"zoomed": @(window.isZoomed),
        @"active": @(sp_input_virtual_real_active()),
        @"activationObservation": @{
            @"registered": @(sp_activity_activation_registered()),
            @"count": [NSString stringWithFormat:@"%llu", sp_observe_count("activity.app.activated")],
        },
        // WebKit delays drawing of a window that other windows fully cover, which is a condition
        // of the presentation measurement.
        @"occluded": @((BOOL)((window.occlusionState & NSWindowOcclusionStateVisible) == 0)),
        @"children": @(window.childWindows.count),
        // WebContent process that draws the app page. It is 0 while the page process does not
        // exist yet (private
        // WKWebView property, docs/operations/private-native-apis.md).
        @"pageProcess": @(mainWebview(window) ? mainWebview(window)._webProcessIdentifier : 0),
        @"controls": controls,
        @"webviews": webviews,
        @"nativeSurfaces": surfaces,
        @"pagelessProcesses": pagelessProcesses(mainWebview(window) ?: views.firstObject),
        @"appDomWebviews": @(views.count - documents),
        @"documentWebviews": @(documents),
    });
}

char *sp_window_color_space_facts(void *handle) {
    NSWindow *window = (NSWindow *)handle;
    if (!window) {
        sp_log_error("window color-space facts", "the window is gone");
        return NULL;
    }
    NSColorSpace *colorSpace = window.colorSpace;
    if (!colorSpace) {
        return copyJSON(@{ @"name": NSNull.null, @"iccSHA256": NSNull.null });
    }
    NSString *name = colorSpace.localizedName;
    if (!name) {
        sp_log_error("window color-space facts", "AppKit returned a color space without a localized name");
        return NULL;
    }
    NSData *profile = colorSpace.ICCProfileData;
    id digestValue = NSNull.null;
    if (profile) {
        if (profile.length > UINT32_MAX) {
            sp_log_error("window color-space facts", "the ICC profile exceeds the SHA-256 input limit");
            return NULL;
        }
        unsigned char digest[CC_SHA256_DIGEST_LENGTH];
        CC_SHA256(profile.bytes, (CC_LONG)profile.length, digest);
        NSMutableString *hex = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
        for (NSUInteger index = 0; index < CC_SHA256_DIGEST_LENGTH; index++)
            [hex appendFormat:@"%02x", digest[index]];
        digestValue = hex;
    }
    return copyJSON(@{ @"name": name, @"iccSHA256": digestValue });
}

char *sp_window_hit(void *handle, void *surfaceView, double x, double y) {
    NSWindow *window = (NSWindow *)handle;
    NSView *content = window.contentView;
    if (!window || !content || ((NSView *)surfaceView).window != window) {
        sp_log_error("window facts", "the window has no content view or the view that holds its surfaces is not in it for a hit test");
        return NULL;
    }
    NSPoint base = NSMakePoint(x, content.frame.size.height - y);
    NSView *hit = [content hitTest:[content.superview convertPoint:base fromView:nil]];
    NSView *owner = hit;
    while (owner && ![owner isKindOfClass:WKWebView.class]) owner = owner.superview;
    id hitFacts = NSNull.null;
    if (hit) {
        hitFacts = @{
            @"class": NSStringFromClass(hit.class),
            @"frame": windowRect(window, [hit convertRect:hit.bounds toView:nil]),
        };
    }
    // The workbench is the registered main web view; a window without one draws its workbench in the views outside its web views and
    // outside the view that holds its surface hosts.
    WKWebView *registered = mainWebview(window);
    BOOL workbench = registered ? owner != nil && owner == registered
        : hit != nil && owner == nil && ![hit isDescendantOf:(NSView *)surfaceView];
    return copyJSON(@{ @"view": @((unsigned long long)(uintptr_t)owner), @"main": @(workbench),
        @"identifier": hit.identifier ?: @"", @"hit": hitFacts });
}

char *sp_screens(void) {
    NSMutableArray *screens = [NSMutableArray array];
    for (NSScreen *screen in NSScreen.screens) {
        NSMutableDictionary *row = [screenRect(screen.frame) mutableCopy];
        row[@"scale"] = @(screen.backingScaleFactor);
        row[@"visible"] = screenRect(screen.visibleFrame);
        [screens addObject:row];
        [row release];
    }
    return copyJSON(screens);
}

bool sp_window_move(void *handle, double x, double y) {
    NSWindow *window = (NSWindow *)handle;
    if (!window) {
        sp_log_error("window facts", "the window to move is missing");
        return false;
    }
    [window setFrameOrigin:NSMakePoint(x, primaryTop() - y - window.frame.size.height)];
    return true;
}

static NSMenu *dockMenu(void) {
    id<NSApplicationDelegate> delegate = NSApp.delegate;
    return [delegate respondsToSelector:@selector(applicationDockMenu:)] ? [delegate applicationDockMenu:NSApp] : nil;
}

// Shortcut of a menu item. It is an empty string when the item has no shortcut.
static NSString *menuKey(NSMenuItem *item) {
    if (item.keyEquivalent.length == 0) return @"";
    NSEventModifierFlags mask = item.keyEquivalentModifierMask;
    NSMutableString *key = [NSMutableString string];
    if (mask & NSEventModifierFlagControl) [key appendString:@"ctrl+"];
    if (mask & NSEventModifierFlagOption) [key appendString:@"opt+"];
    if (mask & NSEventModifierFlagShift) [key appendString:@"shift+"];
    if (mask & NSEventModifierFlagCommand) [key appendString:@"cmd+"];
    [key appendString:item.keyEquivalent];
    return key;
}

// Primary tag of the preferred system language (for example "ko", "ja"). The caller's table decides which
// languages are supported, and the caller uses the default language when the tag is not in the table. Free the
// return value with sp_facts_free. It makes the initial menu, before the page sends the settings language,
// follow the system language (Application menu in docs/spec/host-contract.md).
char *sp_preferred_language(void) {
    NSArray<NSString *> *languages = [[NSUserDefaults standardUserDefaults] stringArrayForKey:@"AppleLanguages"];
    NSString *first = languages.firstObject ?: NSLocale.preferredLanguages.firstObject;
    NSString *tag = [[first componentsSeparatedByString:@"-"] firstObject].lowercaseString;
    const char *utf8 = tag.UTF8String ?: "en";
    char *copy = strdup(utf8);
    return copy;
}

bool sp_application_active(void) {
    return sp_input_virtual_real_active();
}

char *sp_menu_items(void) {
    NSMutableArray *menus = [NSMutableArray array];
    for (NSMenuItem *top in NSApp.mainMenu.itemArray) {
        NSMutableArray *items = [NSMutableArray array];
        // AppKit adds system items (for example, start full screen) late, only when the menu is first opened.
        // The item array before opening is incomplete, so read it after confirming it with update.
        [top.submenu update];
        for (NSMenuItem *item in top.submenu.itemArray) {
            if (item.isSeparatorItem) continue;
            [items addObject:@{ @"title": item.title, @"key": menuKey(item) }];
        }
        NSString *title = top.submenu.title.length ? top.submenu.title : top.title;
        [menus addObject:@{ @"title": title, @"items": items }];
    }
    return copyJSON(menus);
}

const char *sp_menu_select(void *handle, const char *menu, const char *title) {
    NSWindow *window = (__bridge NSWindow *)handle;
    if (!window) return "menu action window is missing";
    if (!menu || !title) return "menu or item title is missing";
    NSString *menuTitle = [NSString stringWithUTF8String:menu];
    NSString *itemTitle = [NSString stringWithUTF8String:title];
    if (!menuTitle || !itemTitle) return "menu or item title is not UTF-8";
    for (NSMenuItem *top in NSApp.mainMenu.itemArray) {
        NSString *name = top.submenu.title.length ? top.submenu.title : top.title;
        if (![name isEqualToString:menuTitle]) continue;
        NSInteger index = [top.submenu indexOfItemWithTitle:itemTitle];
        if (index < 0) return "menu item is missing";
        NSMenuItem *item = [top.submenu itemAtIndex:index];
        if (!item.action) return "menu item has no action";
        // Inactive framework callbacks read the same virtual window as injected input.
        // Explicit responder dispatch below remains window-owned even in an active application.
        if (!sp_input_virtual_real_active()) sp_input_virtual_enter(handle);
        // An item without a target goes up the responders of the requested window and then to the application, whose
        // tryToPerform:with: also asks its delegate, so an application action such as terminate: is performed. The key
        // window is never asked.
        BOOL performed = item.target
            ? [NSApp sendAction:item.action to:item.target from:item]
            : [(window.firstResponder ?: window) tryToPerform:item.action with:item]
                || [NSApp tryToPerform:item.action with:item];
        return performed ? NULL : "menu action has no responder";
    }
    return "menu is missing";
}

void *sp_app_main_window(void) {
    if (NSApp.mainWindow) return NSApp.mainWindow;
    // An application that was never activated has no main window. In that case it is the frontmost
    // visible window.
    for (NSWindow *window in NSApp.orderedWindows) {
        if (window.isVisible && window.canBecomeMainWindow) return window;
    }
    return NULL;
}

char *sp_dock_items(void) {
    NSMutableArray *titles = [NSMutableArray array];
    for (NSMenuItem *item in dockMenu().itemArray) [titles addObject:item.title];
    return copyJSON(titles);
}

bool sp_dock_select(const char *title) {
    NSMenu *menu = dockMenu();
    NSInteger index = menu && title ? [menu indexOfItemWithTitle:[NSString stringWithUTF8String:title]] : -1;
    if (index < 0) {
        sp_log_error("window facts", "the dock menu has no item with the requested title");
        return false;
    }
    [menu performActionForItemAtIndex:index];
    return true;
}

// Observation of the occlusion state of one window. It is an associated object of the window, so it is
// released with the window, which ends the observation.
@interface SPOcclusionObserver : NSObject
@property(nonatomic, retain) id token;
@end

@implementation SPOcclusionObserver
- (void)dealloc {
    if (_token) [NSNotificationCenter.defaultCenter removeObserver:_token];
    [_token release];
    [super dealloc];
}
@end

static const char occlusionObserverKey;

bool sp_window_on_screen(void *handle) {
    NSCAssert(NSThread.isMainThread, @"the window state requires the UI thread");
    NSWindow *window = (NSWindow *)handle;
    return window && (window.occlusionState & NSWindowOcclusionStateVisible) != 0;
}

bool sp_window_observe_occlusion(void *handle, void (^changed)(bool onScreen)) {
    NSCAssert(NSThread.isMainThread, @"occlusion observation requires the UI thread");
    NSWindow *window = (NSWindow *)handle;
    if (!window || !changed) {
        sp_log_error("window facts", "the window or the callback of the occlusion observation is missing");
        return false;
    }
    void (^callback)(bool) = [[changed copy] autorelease];
    SPOcclusionObserver *observer = [[SPOcclusionObserver new] autorelease];
    observer.token = sp_observe_notification("window_facts.occlusion", SP_OBSERVE_RECORD, NSWindowDidChangeOcclusionStateNotification,
        window, NSOperationQueue.mainQueue, ^(NSNotification *notification) { callback(sp_window_on_screen(notification.object)); });
    objc_setAssociatedObject(window, &occlusionObserverKey, observer, OBJC_ASSOCIATION_RETAIN);
    return true;
}

// Observation of the first responder of one window. The window holds it as an associated object, and the caller holds it
// as the observation that sp_window_end_responder_observation ends. It refers to the window weakly, so an end after AppKit
// released the window touches no window; key-value observing unregisters an observer of an object that is released. A later
// observation of the window ends it.
@interface SPResponderObserver : NSObject {
    id _window;
}
@property(nonatomic, copy) void (^changed)(void);
- (instancetype)initWithWindow:(NSWindow *)window;
- (void)end;
@end

static char responderContext;
static const char responderObserverKey;

// The class name of a responder, or an empty name when the change has no responder (KVO reports nil as NSNull).
static NSString *responderClassName(id responder) {
    return [responder isKindOfClass:NSResponder.class] ? NSStringFromClass([responder class]) : @"";
}

static void emitResponderChange(NSInteger windowNumber, id from, id to) {
    NSDictionary *fields = @{@"window": @(windowNumber), @"from": responderClassName(from), @"to": responderClassName(to)};
    NSError *error = nil;
    NSData *json = [NSJSONSerialization dataWithJSONObject:fields options:0 error:&error];
    if (!json) {
        NSLog(@"window facts event native.window.first_responder cannot be serialized: %@", error);
        return;
    }
    NSString *text = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
    sp_event(SP_CLASS_INPUT, SP_EVENT_INFO, "native.window.first_responder", text.UTF8String);
    [text release];
}

@implementation SPResponderObserver
- (void)observeValueForKeyPath:(NSString *)keyPath ofObject:(id)object change:(NSDictionary *)change context:(void *)context {
    if (context != &responderContext) {
        [super observeValueForKeyPath:keyPath ofObject:object change:change context:context];
        return;
    }
    id from = change[NSKeyValueChangeOldKey];
    id to = change[NSKeyValueChangeNewKey];
    if (from != to) {
        sp_surface_responder_moved(from == NSNull.null ? nil : from, to == NSNull.null ? nil : to);
        emitResponderChange(((NSWindow *)object).windowNumber, from, to);
    }
    _changed();
}
- (instancetype)initWithWindow:(NSWindow *)window {
    if ((self = [super init])) objc_storeWeak(&_window, window);
    return self;
}
// Ends the observation once; a second end and an end after the window was released do nothing to the window.
- (void)end {
    NSWindow *window = [objc_loadWeak(&_window) retain];
    objc_storeWeak(&_window, nil);
    if (!window) return;
    [window removeObserver:self forKeyPath:@"firstResponder" context:&responderContext];
    if (objc_getAssociatedObject(window, &responderObserverKey) == self) {
        objc_setAssociatedObject(window, &responderObserverKey, nil, OBJC_ASSOCIATION_RETAIN);
    }
    [window release];
}
- (void)dealloc {
    objc_storeWeak(&_window, nil);
    [_changed release];
    [super dealloc];
}
@end

void *sp_window_observe_responder(void *handle, void (^changed)(void)) {
    NSCAssert(NSThread.isMainThread, @"first responder observation requires the UI thread");
    NSWindow *window = (NSWindow *)handle;
    if (!window || !changed) {
        sp_log_error("window facts", "the window or the callback of the first responder observation is missing");
        return NULL;
    }
    [(SPResponderObserver *)objc_getAssociatedObject(window, &responderObserverKey) end];
    SPResponderObserver *observer = [[SPResponderObserver alloc] initWithWindow:window];
    observer.changed = changed;
    if (!sp_observe_key_path("window_facts.responder", SP_OBSERVE_RECORD, window, observer, @"firstResponder", NSKeyValueObservingOptionOld | NSKeyValueObservingOptionNew, &responderContext)) {
        [observer release];
        return NULL;
    }
    objc_setAssociatedObject(window, &responderObserverKey, observer, OBJC_ASSOCIATION_RETAIN);
    return observer;
}

void sp_window_end_responder_observation(void *observation) {
    NSCAssert(NSThread.isMainThread, @"first responder observation requires the UI thread");
    SPResponderObserver *observer = (SPResponderObserver *)observation;
    if (!observer) return;
    [observer end];
    [observer release];
}
