// Checks that the window state functions report screen and window coordinates, webview order, hit testing, and
// movement correctly. The check does not activate the application.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "webview_geometry.h"
#import "window_facts.h"
#import "input_virtual.h"
#import "support/event_wait.h"
#import <CommonCrypto/CommonDigest.h>
#import <objc/runtime.h>
#include <signal.h>
#import "support/run_until.h"

// Distinct responders make a global/current-window menu dispatch observable.
@interface MenuWindowResponder : NSView
@property NSUInteger selections;
@end
@implementation MenuWindowResponder
- (BOOL)acceptsFirstResponder { return YES; }
- (void)selectAll:(id)sender { (void)sender; self.selections++; }
@end

// An application delegate that owns an application action, as the Quit item of an application menu sends terminate:
// to the application and its delegate after the responders of the window.
@interface MenuApplicationDelegate : NSObject
@property NSUInteger quits;
@end
@implementation MenuApplicationDelegate
- (void)applicationMenuFixtureQuit:(id)sender { (void)sender; self.quits++; }
@end

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// The row of process in the rows of pagelessProcesses, or nil. Other processes without a page, such as the process that a page
// left when it moved to another, are facts of their own, and the check judges only the process that it closes.
static NSDictionary *rowOf(NSArray *rows, pid_t process) {
    for (NSDictionary *row in rows) {
        if ([row[@"pid"] intValue] == process) return row;
    }
    return nil;
}

static id parse(char *text) {
    if (!text) return nil;
    id value = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:text length:strlen(text)] options:0 error:nil];
    sp_facts_free(text);
    return value;
}

// Counts the reads of the WebKit feature list. A status watcher reads the window facts for each frame of a region, and each read of
// the list allocates every feature key in the WebKit heap of the application process.
static NSUInteger featureReads;
static id (*readFeatures)(id, SEL);

static id countedFeatures(id self, SEL command) {
    featureReads++;
    return readFeatures(self, command);
}

static void checkFactsKeepTheFeature(NSWindow *window) {
    Method method = class_getClassMethod(WKPreferences.class, NSSelectorFromString(@"_features"));
    readFeatures = (id (*)(id, SEL))method_setImplementation(method, (IMP)countedFeatures);
    NSDictionary *first = parse(sp_window_facts(window, sp_window_composition(window)));
    featureReads = 0;
    NSDictionary *last = nil;
    for (int read = 0; read < 3; read++) last = parse(sp_window_facts(window, sp_window_composition(window)));
    method_setImplementation(method, (IMP)readFeatures);
    check(featureReads == 0, [NSString stringWithFormat:@"a later read of the window facts reads no feature list (%lu reads)", (unsigned long)featureReads]);
    NSArray *views = last[@"webviews"];
    check(views.count == 2, [NSString stringWithFormat:@"the window facts list the two web views: %@", views]);
    for (NSUInteger index = 0; index < views.count; index++)
        check([views[index][@"near60fps"] isKindOfClass:NSNumber.class] && [views[index][@"near60fps"] isEqual:first[@"webviews"][index][@"near60fps"]],
            [NSString stringWithFormat:@"a later read reports the rendering preference of the view: %@", views[index][@"near60fps"]]);
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 400, 300)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    WKWebView *main = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 400, 300)];
    WKWebView *top = [[WKWebView alloc] initWithFrame:NSMakeRect(100, 50, 200, 100)];
    [window.contentView addSubview:main];
    check(sp_window_set_main_webview(window, main), @"the app DOM is explicitly registered");
    [main addSubview:top];
    check(!sp_window_set_main_webview(window, top), @"another webview cannot replace the registered app DOM");

    window.colorSpace = NSColorSpace.sRGBColorSpace;
    NSColorSpace *queriedColorSpace = window.colorSpace;
    NSData *icc = queriedColorSpace.ICCProfileData;
    if (!icc) {
        check(NO, @"AppKit provides ICC profile data for the configured sRGB color space");
    } else {
        unsigned char expectedDigest[CC_SHA256_DIGEST_LENGTH];
        CC_SHA256(icc.bytes, (CC_LONG)icc.length, expectedDigest);
        NSMutableString *expectedHash = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
        for (NSUInteger index = 0; index < CC_SHA256_DIGEST_LENGTH; index++)
            [expectedHash appendFormat:@"%02x", expectedDigest[index]];
        NSDictionary *colorFacts = parse(sp_window_color_space_facts(window));
        check(colorFacts.count == 2
            && [colorFacts[@"name"] isEqual:queriedColorSpace.localizedName]
            && [colorFacts[@"iccSHA256"] isEqual:expectedHash]
            && window.colorSpace == queriedColorSpace,
            [NSString stringWithFormat:@"the one-shot facts report the actual AppKit color space and ICC digest without changing it: %@", colorFacts]);
    }

    [window makeFirstResponder:top];
    NSDictionary *responderFacts = parse(sp_window_facts(window, sp_window_composition(window)));
    check([responderFacts[@"responder"][@"webview"] unsignedLongLongValue] == (uintptr_t)top,
        [NSString stringWithFormat:@"the first responder's webview is reported: %@", responderFacts[@"responder"]]);
    [window makeFirstResponder:main];
    responderFacts = parse(sp_window_facts(window, sp_window_composition(window)));
    check([responderFacts[@"responder"][@"webview"] unsignedLongLongValue] == (uintptr_t)main
        && [responderFacts[@"responder"][@"class"] length] > 0
        && responderFacts[@"responder"][@"main"] == (id)kCFBooleanTrue,
        [NSString stringWithFormat:@"a responder change is reported with its class: %@", responderFacts[@"responder"]]);
    // The application menu reports, for each submenu, the title and the item titles and shortcuts. Separators are
    // left out.
    NSMenu *mainMenu = [[[NSMenu alloc] initWithTitle:@""] autorelease];
    NSMenuItem *viewItem = [[[NSMenuItem alloc] initWithTitle:@"View" action:nil keyEquivalent:@""] autorelease];
    NSMenu *viewMenu = [[[NSMenu alloc] initWithTitle:@"View"] autorelease];
    [viewMenu addItemWithTitle:@"Zoom In" action:nil keyEquivalent:@"+"];
    [viewMenu addItem:NSMenuItem.separatorItem];
    NSMenuItem *full = [viewMenu addItemWithTitle:@"Toggle Full Screen" action:nil keyEquivalent:@"f"];
    full.keyEquivalentModifierMask = NSEventModifierFlagCommand | NSEventModifierFlagControl;
    viewItem.submenu = viewMenu;
    [mainMenu addItem:viewItem];
    NSApp.mainMenu = mainMenu;
    NSArray *menus = parse(sp_menu_items());
    check([menus isEqual:@[@{ @"title": @"View", @"items": @[
            @{ @"title": @"Zoom In", @"key": @"cmd++" },
            @{ @"title": @"Toggle Full Screen", @"key": @"ctrl+cmd+f" } ] }]],
        [NSString stringWithFormat:@"the application menu is reported with titles and keys: %@", menus]);

    __block BOOL performed = NO;
    NSMenuItem *zoomIn = [viewMenu itemWithTitle:@"Zoom In"];
    zoomIn.target = [NSBlockOperation blockOperationWithBlock:^{ performed = YES; }];
    zoomIn.action = @selector(main);
    check(sp_menu_select(window, "View", "Zoom In") == NULL && performed, @"a menu item is performed by its menu and title");
    check(sp_menu_select(window, "View", "Missing") != NULL && sp_menu_select(window, "Missing", "Zoom In") != NULL, @"an unknown menu item is rejected");

    // Request B while A owns the virtual input context. Neither action may borrow A's responder.
    NSWindow *menuA = [[NSWindow alloc] initWithContentRect:NSMakeRect(20, 20, 160, 100)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable backing:NSBackingStoreBuffered defer:NO];
    menuA.releasedWhenClosed = NO;
    NSWindow *menuB = [[NSWindow alloc] initWithContentRect:NSMakeRect(40, 40, 160, 100)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable backing:NSBackingStoreBuffered defer:NO];
    menuB.releasedWhenClosed = NO;
    MenuWindowResponder *responderA = [[[MenuWindowResponder alloc] initWithFrame:menuA.contentView.bounds] autorelease];
    MenuWindowResponder *responderB = [[[MenuWindowResponder alloc] initWithFrame:menuB.contentView.bounds] autorelease];
    [menuA.contentView addSubview:responderA];
    [menuB.contentView addSubview:responderB];
    [menuA makeFirstResponder:responderA];
    [menuB makeFirstResponder:responderB];
    [menuA orderBack:nil];
    [menuB orderBack:nil];
    check(sp_input_virtual_enter(menuA), @"the menu fixture owns an inactive virtual window A");
    BOOL realActiveBefore = sp_input_virtual_real_active();
    NSArray *orderBefore = [NSApp.orderedWindows copy];
    NSMenuItem *select = [viewMenu addItemWithTitle:@"Select All" action:@selector(selectAll:) keyEquivalent:@""];
    select.target = nil;
    check(sp_menu_select(menuB, "View", "Select All") == NULL && responderA.selections == 0 && responderB.selections == 1,
        @"a nil-target Edit menu action reaches only requested window B");
    performed = NO;
    check(sp_menu_select(menuB, "View", "Zoom In") == NULL && performed,
        @"window-scoped selection preserves an explicit menu target");
    NSMenuItem *unhandled = [viewMenu addItemWithTitle:@"Unclaimed" action:NSSelectorFromString(@"unclaimedMenuFixtureAction:") keyEquivalent:@""];
    unhandled.target = nil;
    const char *missingError = sp_menu_select(menuB, "View", "Missing");
    const char *unhandledError = sp_menu_select(menuB, "View", "Unclaimed");
    check(missingError && unhandledError && strcmp(missingError, unhandledError) != 0,
        @"missing menu items and actions without a responder have distinct errors");
    check(!realActiveBefore && !sp_input_virtual_real_active() && [orderBefore isEqual:NSApp.orderedWindows],
        @"window-scoped Edit dispatch neither activates nor changes window order");
    [orderBefore release];
    NSMenuItem *close = [viewMenu addItemWithTitle:@"Close Fixture" action:@selector(performClose:) keyEquivalent:@""];
    close.target = nil;
    check(sp_menu_select(menuB, "View", "Close Fixture") == NULL && !menuB.visible && menuA.visible,
        @"a nil-target Close menu action closes only requested window B");
    check(!sp_input_virtual_real_active(), @"window-scoped Close does not activate the application");
    MenuApplicationDelegate *applicationDelegate = [[MenuApplicationDelegate alloc] init];
    id<NSApplicationDelegate> previousDelegate = NSApp.delegate;
    NSApp.delegate = (id<NSApplicationDelegate>)applicationDelegate;
    NSMenuItem *quit = [viewMenu addItemWithTitle:@"Quit Fixture" action:@selector(applicationMenuFixtureQuit:) keyEquivalent:@""];
    quit.target = nil;
    check(sp_menu_select(menuA, "View", "Quit Fixture") == NULL && applicationDelegate.quits == 1 && responderA.selections == 0,
        @"a nil-target application action that no responder of the window handles reaches the application delegate");
    NSApp.delegate = previousDelegate;
    [applicationDelegate release];
    [menuA close];
    [menuA release];
    [menuB release];

    check(sp_window_move(window, 120, 80), @"move accepted");
    checkFactsKeepTheFeature(window);
    NSDictionary *facts = parse(sp_window_facts(window, sp_window_composition(window)));
    CGFloat primary = NSMaxY(NSScreen.screens.firstObject.frame);
    check([facts[@"frame"][@"x"] doubleValue] == 120 && [facts[@"frame"][@"y"] doubleValue] == 80,
        [NSString stringWithFormat:@"the frame is reported at the moved top-left screen point: %@", facts[@"frame"]]);
    check(NSMaxY(window.frame) == primary - 80, @"the move places the frame top 80 points below the primary display top");
    check([facts[@"content"][@"width"] doubleValue] == 400 && [facts[@"content"][@"height"] doubleValue] == 300, @"content size");
    // The refresh rate is the maximum frame rate of the screen that holds the window. Recording checks derive their
    // frame count criterion from this value.
    check(window.screen != nil && [facts[@"refreshRate"] isKindOfClass:NSNumber.class]
        && [facts[@"refreshRate"] integerValue] == window.screen.maximumFramesPerSecond && [facts[@"refreshRate"] integerValue] > 0,
        [NSString stringWithFormat:@"the refresh rate of the window's screen is reported: %@", facts[@"refreshRate"]]);
    // The WebContent process in which the app page is drawn. The memory check measures only this process. The process
    // may not exist before the page is read, so the check measures after the page is read.
    __block BOOL pageLoaded = NO;
    [main loadHTMLString:@"<p>page</p>" baseURL:nil];
    [main evaluateJavaScript:@"1" completionHandler:^(id result, NSError *error) { (void)result; (void)error; pageLoaded = YES; }];
    eventWait(@"the script of the read page answers", ^BOOL{ return pageLoaded; });
    NSDictionary *pageFacts = parse(sp_window_facts(window, sp_window_composition(window)));
    pid_t pageProcess = [[main valueForKey:@"_webProcessIdentifier"] intValue];
    check(pageProcess > 0 && [pageFacts[@"pageProcess"] intValue] == pageProcess,
        [NSString stringWithFormat:@"the app page's WebContent process is reported: %@ for %d", pageFacts[@"pageProcess"], pageProcess]);
    // Each web view row reports the WebContent process of its view, so the memory of a document web view is attributed to
    // its surface.
    NSArray *pageRows = pageFacts[@"webviews"];
    check(pageRows.count == 2 && [pageRows[0][@"process"] intValue] == pageProcess
            && [pageRows[1][@"process"] intValue] == [[top valueForKey:@"_webProcessIdentifier"] intValue],
        [NSString stringWithFormat:@"each web view row reports its WebContent process: %@, %@ for %d",
            pageRows.firstObject[@"process"], pageRows.lastObject[@"process"], pageProcess]);
    // A WebContent process that held a page of the application and holds none is reported without a page while it lives, ending
    // because the pool of the check keeps no process cache, and is no longer reported once it has exited.
    // The closing web view lives in a pool of its own: the reading of the facts while it is in the window autoreleases the list of
    // the views of the window, which holds it, so its page and with it its process end only when that pool is emptied.
    pid_t closingProcess = 0;
    __block BOOL closingExited = NO;
    dispatch_source_t exitSource = NULL;
    @autoreleasepool {
        WKWebView *closing = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 100, 100)];
        [window.contentView addSubview:closing];
        __block BOOL closingLoaded = NO;
        [closing loadHTMLString:@"<p>closing</p>" baseURL:nil];
        [closing evaluateJavaScript:@"1" completionHandler:^(id result, NSError *error) { (void)result; (void)error; closingLoaded = YES; }];
        sp_run_until("the closing page answers its script", ^BOOL { return closingLoaded; });
        closingProcess = [[closing valueForKey:@"_webProcessIdentifier"] intValue];
        NSDictionary *withPage = parse(sp_window_facts(window, sp_window_composition(window)));
        check(closingProcess > 0 && closingProcess != pageProcess
                && [withPage[@"pagelessProcesses"] isKindOfClass:NSArray.class]
                && !rowOf(withPage[@"pagelessProcesses"], closingProcess) && !rowOf(withPage[@"pagelessProcesses"], pageProcess),
            [NSString stringWithFormat:@"a process that holds a page is not reported without one: %d, %@", closingProcess,
                withPage[@"pagelessProcesses"]]);
        exitSource = dispatch_source_create(DISPATCH_SOURCE_TYPE_PROC, (uintptr_t)closingProcess, DISPATCH_PROC_EXIT,
            dispatch_get_main_queue());
        dispatch_source_set_event_handler(exitSource, ^{ closingExited = YES; });
        dispatch_resume(exitSource);
        [closing removeFromSuperview];
        [closing release];
    }
    NSDictionary *withoutPage = parse(sp_window_facts(window, sp_window_composition(window)));
    NSDictionary *closingRow = rowOf(withoutPage[@"pagelessProcesses"], closingProcess);
    NSArray *pageless = withoutPage[@"pagelessProcesses"];
    // The process may have exited before this reading, which then reports nothing for it.
    check(closingExited || kill(closingProcess, 0) != 0
            || (closingRow && [closingRow[@"ending"] boolValue]
               // The hosts read ending as a JSON boolean, so a number is a wrong fact.
               && CFGetTypeID((CFTypeRef)closingRow[@"ending"]) == CFBooleanGetTypeID()),
        [NSString stringWithFormat:@"the process whose page closed is reported without a page and ending: %@", pageless]);
    sp_run_until("the process of the closed page exits", ^BOOL { return closingExited; });
    dispatch_source_cancel(exitSource);
    dispatch_release(exitSource);
    NSDictionary *afterExit = parse(sp_window_facts(window, sp_window_composition(window)));
    check([afterExit[@"pagelessProcesses"] isKindOfClass:NSArray.class] && !rowOf(afterExit[@"pagelessProcesses"], closingProcess),
        [NSString stringWithFormat:@"a process without a page that exited is no longer reported: %@", afterExit[@"pagelessProcesses"]]);
    check(![facts[@"active"] boolValue] && ![facts[@"key"] boolValue], @"an inactive window is reported as not key and not active");
    check([facts[@"children"] integerValue] == 0, @"no child windows");
    check([facts[@"controls"] count] == 3, @"three window buttons are reported");
    NSArray *views = facts[@"webviews"];
    check(views.count == 2, @"both webviews are reported");
    check([facts[@"appDomWebviews"] integerValue] == 2 && [facts[@"documentWebviews"] integerValue] == 0,
        @"an extra non-document webview is counted instead of reporting a constant app DOM count");
    check([views[0][@"view"] unsignedLongLongValue] == (uintptr_t)main && [views[1][@"view"] unsignedLongLongValue] == (uintptr_t)top,
        @"webviews are listed in drawing order with the main page first");
    BOOL mainFlagIsBoolean = CFGetTypeID((CFTypeRef)views[0][@"main"]) == CFBooleanGetTypeID();
    BOOL childFlagIsBoolean = CFGetTypeID((CFTypeRef)views[1][@"main"]) == CFBooleanGetTypeID();
    check(mainFlagIsBoolean && childFlagIsBoolean && [views[0][@"main"] boolValue] && ![views[1][@"main"] boolValue],
        [NSString stringWithFormat:@"webview ownership flags are JSON booleans: %@, %@", views[0][@"main"], views[1][@"main"]]);
    NSDictionary *upper = views[1];
    // WKWebView has a flipped coordinate system, so the frame of a subview is relative to the top left of the content
    // area.
    check(main.isFlipped, @"the main webview is a flipped view");
    check([upper[@"x"] doubleValue] == 100 && [upper[@"y"] doubleValue] == 50 && [upper[@"width"] doubleValue] == 200
        && [upper[@"height"] doubleValue] == 100, [NSString stringWithFormat:@"child webview frame in window coordinates: %@", upper]);
    // The registration makes the main web view transparent, because the composition places native content below it.
    check([upper[@"draws"] boolValue] && [upper[@"alpha"] doubleValue] > 0 && ![views[0][@"draws"] boolValue] && [views[0][@"alpha"] doubleValue] == 0,
        @"background drawing and under-page alpha are reported per webview");
    check([views[0][@"near60fps"] isEqual:@NO] && [views[1][@"near60fps"] isEqual:@YES],
        [NSString stringWithFormat:@"registration lets only the app DOM render at the display rate: main %@, other %@",
            views[0][@"near60fps"], views[1][@"near60fps"]]);
    check(upper[@"focused"] != nil, @"document webview focus is reported");

    char *raw = sp_window_hit(window, sp_window_composition(window), 10, 10);
    check(strstr(raw, "\"main\":true") != NULL, [NSString stringWithFormat:@"main is a JSON boolean: %s", raw]);
    sp_facts_free(raw);
    NSDictionary *hit = parse(sp_window_hit(window, sp_window_composition(window), 150, 100));
    check([hit[@"view"] unsignedLongLongValue] == (uintptr_t)top && ![hit[@"main"] boolValue], @"a point inside the child webview hits it");
    NSDictionary *hitView = hit[@"hit"];
    NSDictionary *hitFrame = hitView[@"frame"];
    check([hitView[@"class"] isKindOfClass:NSString.class] && [hitView[@"class"] length] > 0
        && [hitFrame[@"x"] doubleValue] <= 150 && [hitFrame[@"x"] doubleValue] + [hitFrame[@"width"] doubleValue] > 150
        && [hitFrame[@"y"] doubleValue] <= 100 && [hitFrame[@"y"] doubleValue] + [hitFrame[@"height"] doubleValue] > 100,
        [NSString stringWithFormat:@"the hit result reports the actual leaf view class and containing frame: %@", hitView]);
    hit = parse(sp_window_hit(window, sp_window_composition(window), 150, 200));
    hitView = hit[@"hit"];
    hitFrame = hitView[@"frame"];
    check([hit[@"view"] unsignedLongLongValue] == (uintptr_t)main && [hit[@"main"] boolValue]
        && [hitView[@"class"] isKindOfClass:NSString.class] && [hitFrame[@"x"] doubleValue] <= 150
        && [hitFrame[@"x"] doubleValue] + [hitFrame[@"width"] doubleValue] > 150
        && [hitFrame[@"y"] doubleValue] <= 200 && [hitFrame[@"y"] doubleValue] + [hitFrame[@"height"] doubleValue] > 200,
        [NSString stringWithFormat:@"a point outside the child webview reports the actual main-page hit frame: %@", hitView]);

    NSArray *screens = parse(sp_screens());
    check(screens.count == NSScreen.screens.count && [screens[0][@"x"] doubleValue] == 0 && [screens[0][@"y"] doubleValue] == 0
        && [screens[0][@"scale"] doubleValue] >= 1, @"the primary display is reported at the screen origin with its scale");
    check(parse(sp_dock_items()) != nil, @"Dock items are reported as an array");
    check(!sp_dock_select("No such item"), @"an unknown Dock item is rejected");
    // The observation calls its callback with the state of sp_window_on_screen for each occlusion change of the window. The
    // window goes behind every window, as an application that is not active shows one (docs/spec/hosts.md#launch-activation),
    // so whether the window server reports a change when it shows depends on the windows of a person in front of it; the
    // check therefore posts the change notification of AppKit itself, once for the ordered window and once after it is
    // ordered out, which no window covers.
    NSWindow *observed = [[[NSWindow alloc] initWithContentRect:NSMakeRect(40, 40, 200, 120)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO] autorelease];
    [observed setReleasedWhenClosed:NO];
    __block int changes = 0;
    __block bool reportedOnScreen = false;
    check(sp_window_observe_occlusion(observed, ^(bool onScreen) {
        changes++;
        reportedOnScreen = onScreen;
    }), @"occlusion observation starts");
    check(!sp_window_observe_occlusion(NULL, ^(bool onScreen) { (void)onScreen; }), @"occlusion observation without a window is rejected");
    [observed orderBack:nil];
    int before = changes;
    [NSNotificationCenter.defaultCenter postNotificationName:NSWindowDidChangeOcclusionStateNotification object:observed];
    // The observation takes the notification on the main queue, which the wait runs.
    eventWait(@"the ordered window reports an occlusion change", ^BOOL{ return changes > before; });
    check(changes == before + 1 && reportedOnScreen == sp_window_on_screen(observed),
        [NSString stringWithFormat:@"an occlusion change of the ordered window reports its on-screen state (%d changes, reported %d, "
            "state %d)", changes - before, reportedOnScreen, sp_window_on_screen(observed)]);
    int shown = changes;
    [observed orderOut:nil];
    [NSNotificationCenter.defaultCenter postNotificationName:NSWindowDidChangeOcclusionStateNotification object:observed];
    eventWait(@"the hidden window reports an occlusion change", ^BOOL{ return changes > shown; });
    check(changes == shown + 1, [NSString stringWithFormat:@"hiding the window reports an occlusion change (%d changes)",
        changes - shown]);
    check(!reportedOnScreen, @"the observation of a hidden window reports that it is not on screen");
    // A sheet of the window: none before it begins, its kind and frame while it is attached, none again after it ends, and one
    // change of the sheet observation at the begin and one at the end. The window goes behind every window, as the window of an
    // application that is not active, and its sheets go with it. The change of the begin comes after AppKit attached the sheet,
    // so the facts that the change reads hold the sheet.
    [window orderBack:nil];
    check(parse(sp_window_facts(window, sp_window_composition(window)))[@"sheet"] == NSNull.null,
        @"a window without a sheet reports no sheet");
    __block int sheetChanges = 0;
    __block id sheetAtChange = nil;
    void *sheetObservation = sp_window_observe_sheet(window, ^{
        sheetChanges++;
        [sheetAtChange release];
        sheetAtChange = [parse(sp_window_facts(window, sp_window_composition(window)))[@"sheet"] retain];
    });
    check(sheetObservation != NULL, @"the sheet observation starts");
    check(sp_window_observe_sheet(NULL, ^{}) == NULL, @"a sheet observation without a window is refused");
    NSAlert *alert = [[[NSAlert alloc] init] autorelease];
    alert.messageText = @"window_facts_test";
    // A save panel reports its folder and the name in its name field, an open panel its folder, so a check knows where Return
    // saves before it presses it.
    NSSavePanel *savePanel = NSSavePanel.savePanel;
    savePanel.nameFieldStringValue = @"window_facts_test.txt";
    NSArray *sheets = @[
        @[@"save", savePanel],
        @[@"open", NSOpenPanel.openPanel],
        @[@"alert", alert],
    ];
    for (NSArray *row in sheets) {
        NSString *kind = row[0];
        int before = sheetChanges;
        [row[1] beginSheetModalForWindow:window completionHandler:^(NSModalResponse response) { (void)response; }];
        eventWait([NSString stringWithFormat:@"the begin of the %@ sheet", kind], ^BOOL{ return sheetChanges > before; });
        NSWindow *sheet = window.attachedSheet;
        NSRect frame = sheet.frame;
        CGFloat top = NSMaxY(NSScreen.screens.firstObject.frame);
        id directory = [sheet isKindOfClass:NSSavePanel.class] ? (id)((NSSavePanel *)sheet).directoryURL.path : nil;
        id name = [kind isEqual:@"save"] ? (id)@"window_facts_test.txt" : nil;
        NSDictionary *expected = @{ @"kind": kind, @"frame": @{ @"x": @(frame.origin.x), @"y": @(top - NSMaxY(frame)),
            @"width": @(frame.size.width), @"height": @(frame.size.height) },
            @"directory": directory ?: NSNull.null, @"name": name ?: NSNull.null };
        NSDictionary *reported = parse(sp_window_facts(window, sp_window_composition(window)))[@"sheet"];
        check(sheet != nil && [reported isEqual:expected],
            [NSString stringWithFormat:@"a %@ sheet is reported with its kind, frame, folder and name (%@, expected %@)", kind, reported, expected]);
        check(sheetChanges == before + 1 && [sheetAtChange isEqual:expected],
            [NSString stringWithFormat:@"the begin of a %@ sheet is one change whose facts hold the sheet (%d changes, %@)", kind,
                sheetChanges - before, sheetAtChange]);
        if (![kind isEqual:@"alert"]) {
            check([reported[@"directory"] isKindOfClass:NSString.class] && [reported[@"directory"] length] > 0,
                [NSString stringWithFormat:@"a %@ panel reports the folder that it shows (%@)", kind, reported[@"directory"]]);
        }
        int attached = sheetChanges;
        [window endSheet:sheet];
        eventWait([NSString stringWithFormat:@"the end of the %@ sheet", kind], ^BOOL{ return sheetChanges > attached; });
        check(parse(sp_window_facts(window, sp_window_composition(window)))[@"sheet"] == NSNull.null,
            [NSString stringWithFormat:@"a window whose %@ sheet ended reports no sheet", kind]);
        check(sheetChanges == attached + 1 && sheetAtChange == NSNull.null,
            [NSString stringWithFormat:@"the end of a %@ sheet is one change whose facts hold no sheet (%d changes, %@)", kind,
                sheetChanges - attached, sheetAtChange]);
    }
    sp_window_end_sheet_observation(sheetObservation);
    int ended = sheetChanges;
    [NSSavePanel.savePanel beginSheetModalForWindow:window completionHandler:^(NSModalResponse response) { (void)response; }];
    NSWindow *unobserved = window.attachedSheet;
    [window endSheet:unobserved];
    // The changes of the observation come on the main queue, so a block queued after the end runs after any change of the sheet.
    __block BOOL drained = NO;
    dispatch_async(dispatch_get_main_queue(), ^{ drained = YES; });
    eventWait(@"the main queue after a sheet without observation", ^BOOL{ return drained; });
    check(unobserved != nil && sheetChanges == ended, @"an ended sheet observation reports no change");
    [sheetAtChange release];
    [window orderOut:nil];
    check(!NSApp.isActive, @"application stays inactive");
    [window close];
    return failures ? 1 : 0;
}}
