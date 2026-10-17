// Checks that the window state functions report screen and window coordinates, webview order, hit testing, and
// movement correctly. The check does not activate the application.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "window_facts.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static id parse(char *text) {
    if (!text) return nil;
    id value = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:text length:strlen(text)] options:0 error:nil];
    sp_facts_free(text);
    return value;
}

// Occlusion state changes of the window server arrive as AppKit events. Takes and sends only window and screen change
// events. Application activation events are not taken (activation would make the check process active).
static void pumpOcclusion(void) {
    NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskAppKitDefined untilDate:[NSDate dateWithTimeIntervalSinceNow:0.02]
        inMode:NSDefaultRunLoopMode dequeue:NO];
    if (event && event.subtype != NSEventSubtypeApplicationActivated && event.subtype != NSEventSubtypeApplicationDeactivated) {
        [NSApp sendEvent:[NSApp nextEventMatchingMask:NSEventMaskAppKitDefined untilDate:nil inMode:NSDefaultRunLoopMode dequeue:YES]];
    }
    [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
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
    window.contentView = main;
    check(sp_window_set_main_webview(window, main), @"the app DOM is explicitly registered");
    [main addSubview:top];
    check(!sp_window_set_main_webview(window, top), @"another webview cannot replace the registered app DOM");
    [top setValue:@NO forKey:@"drawsBackground"];
    top.underPageBackgroundColor = NSColor.clearColor;

    [window makeFirstResponder:top];
    NSDictionary *responderFacts = parse(sp_window_facts(window));
    check([responderFacts[@"responder"][@"webview"] unsignedLongLongValue] == (uintptr_t)top,
        [NSString stringWithFormat:@"the first responder's webview is reported: %@", responderFacts[@"responder"]]);
    [window makeFirstResponder:main];
    responderFacts = parse(sp_window_facts(window));
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
    check(sp_menu_select("View", "Zoom In") && performed, @"a menu item is performed by its menu and title");
    check(!sp_menu_select("View", "Missing") && !sp_menu_select("Missing", "Zoom In"), @"an unknown menu item is rejected");

    check(sp_window_move(window, 120, 80), @"move accepted");
    NSDictionary *facts = parse(sp_window_facts(window));
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
    NSDate *loadDeadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (!pageLoaded && loadDeadline.timeIntervalSinceNow > 0)
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    NSDictionary *pageFacts = parse(sp_window_facts(window));
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
    check(![upper[@"draws"] boolValue] && [upper[@"alpha"] doubleValue] == 0 && [views[0][@"draws"] boolValue],
        @"background drawing and under-page alpha are reported per webview");
    check([views[0][@"near60fps"] isEqual:@NO] && [views[1][@"near60fps"] isEqual:@YES],
        [NSString stringWithFormat:@"registration lets only the app DOM render at the display rate: main %@, other %@",
            views[0][@"near60fps"], views[1][@"near60fps"]]);
    check(upper[@"focused"] != nil, @"document webview focus is reported");

    char *raw = sp_window_hit(window, 10, 10);
    check(strstr(raw, "\"main\":true") != NULL, [NSString stringWithFormat:@"main is a JSON boolean: %s", raw]);
    sp_facts_free(raw);
    NSDictionary *hit = parse(sp_window_hit(window, 150, 100));
    check([hit[@"view"] unsignedLongLongValue] == (uintptr_t)top && ![hit[@"main"] boolValue], @"a point inside the child webview hits it");
    NSDictionary *hitView = hit[@"hit"];
    NSDictionary *hitFrame = hitView[@"frame"];
    check([hitView[@"class"] isKindOfClass:NSString.class] && [hitView[@"class"] length] > 0
        && [hitFrame[@"x"] doubleValue] <= 150 && [hitFrame[@"x"] doubleValue] + [hitFrame[@"width"] doubleValue] > 150
        && [hitFrame[@"y"] doubleValue] <= 100 && [hitFrame[@"y"] doubleValue] + [hitFrame[@"height"] doubleValue] > 100,
        [NSString stringWithFormat:@"the hit result reports the actual leaf view class and containing frame: %@", hitView]);
    hit = parse(sp_window_hit(window, 150, 200));
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
    // When the window is shown or hidden on screen, the window server changes the occlusion state, and the
    // observation is called for each change.
    NSWindow *observed = [[[NSWindow alloc] initWithContentRect:NSMakeRect(40, 40, 200, 120)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO] autorelease];
    [observed setReleasedWhenClosed:NO];
    __block int changes = 0;
    check(sp_window_observe_occlusion(observed, ^{ changes++; }), @"occlusion observation starts");
    check(!sp_window_observe_occlusion(NULL, ^{}), @"occlusion observation without a window is rejected");
    [observed orderFrontRegardless];
    NSDate *limit = [NSDate dateWithTimeIntervalSinceNow:2];
    while (changes == 0 && [limit timeIntervalSinceNow] > 0) pumpOcclusion();
    check(changes > 0 && (observed.occlusionState & NSWindowOcclusionStateVisible) != 0,
        [NSString stringWithFormat:@"showing the window reports an occlusion change (%d changes)", changes]);
    int shown = changes;
    [observed orderOut:nil];
    limit = [NSDate dateWithTimeIntervalSinceNow:2];
    while (changes == shown && [limit timeIntervalSinceNow] > 0) pumpOcclusion();
    check(changes > shown, [NSString stringWithFormat:@"hiding the window reports an occlusion change (%d changes)", changes]);
    check(!NSApp.isActive, @"application stays inactive");
    [window close];
    return failures ? 1 : 0;
}}
