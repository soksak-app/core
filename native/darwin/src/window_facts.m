// Reads the native values of the window state that the host publishes (host.window, host.screens, host.dock).
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#import "window_facts.h"
#import "observe.h"
#import "application_log.h"
#import "webview_geometry.h"
#import "private/webkit.h"
#import "surface_layout.h"
#import "webview_navigation.h"

static const char mainWebviewKey;

bool sp_window_set_main_webview(void *handle, void *mainHandle) {
    NSCAssert(NSThread.isMainThread, @"window registration requires the UI thread");
    NSWindow *window = (NSWindow *)handle;
    WKWebView *main = (WKWebView *)mainHandle;
    if (!window || ![main isKindOfClass:WKWebView.class] || main.window != window) {
        sp_log_error("window facts", "the main web view to register is missing or belongs to another window");
        return false;
    }
    NSValue *registered = objc_getAssociatedObject(window, &mainWebviewKey);
    if (registered && registered.nonretainedObjectValue != main) {
        sp_log_error("window facts", "the window already has another main web view");
        return false;
    }
    // The layout indicator waits for the next presentation of this web view, so this web view must
    // render at the display refresh rate.
    if (!registered && !surfaceLayoutRenderAtDisplayRate(main)) {
        sp_log_error("window facts", "the main web view cannot render at the display rate");
        return false;
    }
    // For the same reason the document is not hidden when the window is occluded. WebKit hides the document
    // of an occluded window and stops animation frames, so the layout indicator of an occluded window and
    // the commands that wait for it would not finish.
    if (![main respondsToSelector:@selector(_setWindowOcclusionDetectionEnabled:)]) {
        sp_log_error("window facts", "_setWindowOcclusionDetectionEnabled: is unavailable");
        return false;
    }
    main._windowOcclusionDetectionEnabled = NO;
    // Open the new document of the main frame in a new process so that a reload and a page change do
    // not keep the previous document.
    if (!sp_webview_replace_documents_in_new_process(main)) {
        sp_log_error("window facts", "the main web view cannot open its documents in a new process");
        return false;
    }
    objc_setAssociatedObject(window, &mainWebviewKey, [NSValue valueWithNonretainedObject:main], OBJC_ASSOCIATION_RETAIN);
    return true;
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

char *sp_window_facts(void *handle) {
    NSWindow *window = (NSWindow *)handle;
    if (!window || !window.contentView || !mainWebview(window)) {
        sp_log_error("window facts", "the window has no content view or no registered main web view");
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
        @"pointer": @{ @"x": @(NSEvent.mouseLocation.x), @"y": @(primaryTop() - NSEvent.mouseLocation.y) },
        @"content": @{ @"width": @(content.bounds.size.width), @"height": @(content.bounds.size.height) },
        @"scale": @(window.backingScaleFactor),
        // The refresh rate cannot be determined when the window is on no screen, so it is null.
        @"refreshRate": window.screen ? (id)@(window.screen.maximumFramesPerSecond) : (id)NSNull.null,
        @"key": @(window.isKeyWindow),
        @"zoomed": @(window.isZoomed),
        @"active": @(NSApp.isActive),
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
        @"appDomWebviews": @(views.count - documents),
        @"documentWebviews": @(documents),
    });
}

char *sp_window_hit(void *handle, double x, double y) {
    NSWindow *window = (NSWindow *)handle;
    NSView *content = window.contentView;
    if (!window || !content || !mainWebview(window)) {
        sp_log_error("window facts", "the window has no content view or no registered main web view for a hit test");
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
    return copyJSON(@{ @"view": @((unsigned long long)(uintptr_t)owner), @"main": owner && owner == mainWebview(window) ? @YES : @NO,
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

bool sp_menu_select(const char *menu, const char *title) {
    if (!menu || !title) {
        sp_log_error("window facts", "the menu or the item title to select is missing");
        return false;
    }
    NSString *menuTitle = [NSString stringWithUTF8String:menu];
    NSString *itemTitle = [NSString stringWithUTF8String:title];
    for (NSMenuItem *top in NSApp.mainMenu.itemArray) {
        NSString *name = top.submenu.title.length ? top.submenu.title : top.title;
        if (![name isEqualToString:menuTitle]) continue;
        NSInteger index = [top.submenu indexOfItemWithTitle:itemTitle];
        if (index < 0) {
            sp_log_error("window facts", [NSString stringWithFormat:@"the menu %@ has no item %@", menuTitle, itemTitle].UTF8String);
            return false;
        }
        NSMenuItem *item = [top.submenu itemAtIndex:index];
        if (!item.action) {
            sp_log_error("window facts", [NSString stringWithFormat:@"the menu item %@ has no action", itemTitle].UTF8String);
            return false;
        }
        // performActionForItemAtIndex: defers the action to the run loop on this system (V5-108), so choose
        // the item with the equivalent synchronous form. Without a target it passes through the responder
        // chain and returns whether the action was delivered.
        return [NSApp sendAction:item.action to:item.target from:item];
    }
    sp_log_error("window facts", [NSString stringWithFormat:@"the main menu has no menu %@", menuTitle].UTF8String);
    return false;
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

bool sp_window_observe_occlusion(void *handle, void (^changed)(void)) {
    NSCAssert(NSThread.isMainThread, @"occlusion observation requires the UI thread");
    NSWindow *window = (NSWindow *)handle;
    if (!window || !changed) {
        sp_log_error("window facts", "the window or the callback of the occlusion observation is missing");
        return false;
    }
    void (^callback)(void) = [[changed copy] autorelease];
    SPOcclusionObserver *observer = [[SPOcclusionObserver new] autorelease];
    observer.token = sp_observe_notification("window_facts.occlusion", SP_OBSERVE_RECORD, NSWindowDidChangeOcclusionStateNotification,
        window, NSOperationQueue.mainQueue, ^(NSNotification *notification) { callback(); });
    objc_setAssociatedObject(window, &occlusionObserverKey, observer, OBJC_ASSOCIATION_RETAIN);
    return true;
}
