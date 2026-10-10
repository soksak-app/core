// Checks navigation, history, status reporting, placement, and isolation of the document region web view. The default run does not activate the application and
// confirms at the end that it was not activated. The --activation run activates the application and checks clicks and keys of the OS event queue.
//
// This process serves the test documents on a loopback address.
#import <Cocoa/Cocoa.h>
#import <Network/Network.h>
#import <WebKit/WebKit.h>
#import "document_view.h"
#import "support/records.h"
#import "input_inject.h"
#import "private/webkit.h"
#import "webview_geometry.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static void until(NSString *what, BOOL (^done)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
    if (!done()) { fprintf(stderr, "FAIL: %s within 10 seconds\n", what.UTF8String); exit(1); }
}

// Test documents. Each path has a different title and body.
static NSString *pageFor(NSString *path) {
    if ([path isEqualToString:@"/one"]) {
        return @"<!doctype html><title>One</title><body style='height:3000px;margin:0'>"
            "<input id='field' style='position:absolute;left:10px;top:10px'>"
            "<button id='click' style='position:absolute;left:10px;top:50px'>click</button>"
            "<script>window.nativeClicks=0;click.addEventListener('click',()=>nativeClicks++);</script>"
            "<a id='two' href='/two'>two</a> <a id='blank' target='_blank' href='/blank'>blank</a> "
            "<a id='app' href='wails://wails/index.html'>app</a></body>";
    }
    if ([path isEqualToString:@"/two"]) return @"<!doctype html><title>Two</title><body>two</body>";
    if ([path isEqualToString:@"/blank"]) return @"<!doctype html><title>Blank</title><body>blank</body>";
    if ([path isEqualToString:@"/inspect"]) {
        return @"<!doctype html><title>Inspect</title><body><div id='box' class='a b'><p>text</p></div>"
            "<script>fetch('/blank').then(() => { document.title = 'Inspected'; });</script></body>";
    }
    return nil;
}

// The User-Agent header of the last request that the server received.
static NSString *requestAgent;

// Connections of requests that are not answered. They are closed when the test ends.
static NSMutableArray *held;

// An HTTP server that sends one response per request and closes the connection. It does not respond to /slow.
static nw_listener_t serve(void) {
    nw_parameters_t parameters = nw_parameters_create_secure_tcp(NW_PARAMETERS_DISABLE_PROTOCOL, NW_PARAMETERS_DEFAULT_CONFIGURATION);
    nw_endpoint_t local = nw_endpoint_create_host("127.0.0.1", "0");
    nw_parameters_set_local_endpoint(parameters, local);
    nw_listener_t listener = nw_listener_create(parameters);
    nw_listener_set_queue(listener, dispatch_get_main_queue());
    nw_listener_set_new_connection_handler(listener, ^(nw_connection_t connection) {
        nw_connection_set_queue(connection, dispatch_get_main_queue());
        nw_connection_start(connection);
        nw_connection_receive(connection, 1, 65536, ^(dispatch_data_t content, nw_content_context_t context, bool complete, nw_error_t error) {
            NSString *request = content ? [[[NSString alloc] initWithData:(NSData *)content encoding:NSUTF8StringEncoding] autorelease] : @"";
            NSArray *words = [[request componentsSeparatedByString:@"\r\n"].firstObject componentsSeparatedByString:@" "];
            for (NSString *line in [request componentsSeparatedByString:@"\r\n"]) {
                if ([line.lowercaseString hasPrefix:@"user-agent: "]) {
                    [requestAgent release];
                    requestAgent = [[line substringFromIndex:12] copy];
                }
            }
            if (words.count > 1 && [words[1] isEqualToString:@"/slow"]) {
                [held addObject:(id)connection];
                return;
            }
            NSString *body = words.count > 1 ? pageFor(words[1]) : nil;
            NSString *head = body ? @"200 OK" : @"404 Not Found";
            body = body ?: @"missing";
            NSData *bytes = [body dataUsingEncoding:NSUTF8StringEncoding];
            NSString *response = [NSString stringWithFormat:@"HTTP/1.1 %@\r\nContent-Type: text/html; charset=utf-8\r\n"
                "Content-Length: %lu\r\nConnection: close\r\n\r\n%@", head, (unsigned long)bytes.length, body];
            NSData *data = [response dataUsingEncoding:NSUTF8StringEncoding];
            dispatch_data_t out = dispatch_data_create(data.bytes, data.length, dispatch_get_main_queue(), DISPATCH_DATA_DESTRUCTOR_DEFAULT);
            nw_connection_send(connection, out, NW_CONNECTION_FINAL_MESSAGE_CONTEXT, true, ^(nw_error_t sent) {
                nw_connection_cancel(connection);
            });
        });
    });
    __block BOOL ready = NO;
    nw_listener_set_state_changed_handler(listener, ^(nw_listener_state_t state, nw_error_t error) {
        if (state == nw_listener_state_ready) ready = YES;
    });
    nw_listener_start(listener);
    until(@"the test server did not start", ^BOOL { return ready; });
    return listener;
}

static NSDictionary *latest;
static int reports;
static int nativeEvents;
static NSDictionary *latestNativeEvent;
// When set, every report is checked against this condition, and a report that deviates is recorded.
static BOOL (^expected)(NSDictionary *state);
static NSDictionary *mismatch;

static void event(void *context, const char *text) {
    NSData *data = [NSData dataWithBytes:text length:strlen(text)];
    [latestNativeEvent release];
    latestNativeEvent = [[NSJSONSerialization JSONObjectWithData:data options:0 error:nil] retain];
    nativeEvents++;
}
static void scrollDone(void *context, sp_input_result result, const sp_input_held *held) {
    *(sp_input_result *)context = result;
}

static void changed(void *context, const char *text) {
    NSData *data = [NSData dataWithBytes:text length:strlen(text)];
    [latest release];
    latest = [[NSJSONSerialization JSONObjectWithData:data options:0 error:nil] retain];
    reports++;
    if (expected && !mismatch && !expected(latest)) mismatch = [latest retain];
}

static id evaluate(WKWebView *view, NSString *script) {
    __block BOOL done = NO;
    __block id result = nil;
    [view evaluateJavaScript:script completionHandler:^(id value, NSError *error) {
        result = [value retain];
        done = YES;
    }];
    until(@"JavaScript did not answer", ^BOOL { return done; });
    return [result autorelease];
}

// The number of WKWebViews in the surface. The internal view of the surface itself is not a WKWebView.
static NSUInteger documents(NSView *surface) {
    NSUInteger count = 0;
    for (NSView *child in surface.subviews) {
        count += [child isKindOfClass:WKWebView.class];
        count += documents(child);
    }
    return count;
}

static void settle(NSString *what, BOOL (^condition)(NSDictionary *state)) {
    until(what, ^BOOL { return latest && condition(latest); });
}

static void pumpEvents(NSString *what, BOOL (^done)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskAny
            untilDate:[NSDate dateWithTimeIntervalSinceNow:0.01] inMode:NSDefaultRunLoopMode dequeue:YES];
        if (event) [NSApp sendEvent:event];
    }
    if (!done()) { fprintf(stderr, "FAIL: %s within 10 seconds\n", what.UTF8String); exit(1); }
}

// tests/support/no_activation.m: this check activates the application in make test-activation.
void sp_test_declare_activation(void);

int main(int argc, char **argv) { @autoreleasepool {
    // activation activates the application and checks clicks and keys of the OS event queue. Used only by make test-activation.
    BOOL activation = argc > 1 && strcmp(argv[1], "--activation") == 0;
    if (activation) sp_test_declare_activation();
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    held = [NSMutableArray new];
    nw_listener_t listener = serve();
    NSString *base = [NSString stringWithFormat:@"http://127.0.0.1:%d", nw_listener_get_port(listener)];

    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 500, 400)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 500, 400)] autorelease];
    WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
    main.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [window.contentView addSubview:main];
    [window orderBack:nil];
    void *surface = sp_surface_create(main);
    check(surface != NULL, @"a logical surface is created for the document");
    webviewSetFrame(surface, 0, 0, 500, 400);
    webviewSetSurfaceHidden(surface, false);
    NSView *nativePlane = (NSView *)sp_surface_native_plane(surface);

    window.appearance = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
    // The store directory is deleted when the test ends.
    NSString *stores = [NSTemporaryDirectory() stringByAppendingPathComponent:
        [NSString stringWithFormat:@"soksak-document-store-%d", getpid()]];
    NSString *storeA = [stores stringByAppendingPathComponent:@"a"];
    NSString *storeB = [stores stringByAppendingPathComponent:@"b"];
    void *document = sp_document_create(surface, storeA.fileSystemRepresentation, NULL, NULL, changed, NULL);
    check(document != NULL, @"a document view is created inside the surface");
    WKWebView *view = (WKWebView *)document;
    check([view.appearance.name isEqual:NSAppearanceNameDarkAqua],
        @"a document inherits the owner's resolved dark appearance");
    NSView *surfaceView = (NSView *)surface;
    check(nativePlane != nil && view.superview == nativePlane && nativePlane.superview == surfaceView,
        @"the document view is in the surface host native plane");
    check(view.configuration.websiteDataStore != WKWebsiteDataStore.defaultDataStore
        && view.configuration.websiteDataStore.persistent, @"the document uses its own persistent data store");

    double frame[5] = {0};
    sp_document_place(document, 10, 20, 30, 40, true);
    sp_document_frame(document, frame);
    check(frame[0] == 10 && frame[1] == 20 && frame[2] == 460 && frame[3] == 340 && frame[4] == 1,
        [NSString stringWithFormat:@"the region keeps its insets in window coordinates: %g %g %g %g %g", frame[0], frame[1], frame[2], frame[3], frame[4]]);
    webviewSetFrame(surface, 0, 0, 600, 450);
    sp_document_frame(document, frame);
    check(frame[0] == 10 && frame[1] == 20 && frame[2] == 560 && frame[3] == 390,
        [NSString stringWithFormat:@"the region follows the surface size: %g %g %g %g", frame[0], frame[1], frame[2], frame[3]]);
    // Even when a surface that had become smaller than the margins grows again, the margins determine the region.
    webviewSetFrame(surface, 0, 0, 30, 50);
    webviewSetFrame(surface, 0, 0, 500, 400);
    sp_document_frame(document, frame);
    check(frame[0] == 10 && frame[1] == 20 && frame[2] == 460 && frame[3] == 340 && frame[4] == 1,
        [NSString stringWithFormat:@"the region keeps its insets after the surface was smaller than them: %g %g %g %g %g",
            frame[0], frame[1], frame[2], frame[3], frame[4]]);
    sp_document_place(document, 10, 20, 30, 40, false);
    sp_document_frame(document, frame);
    check(frame[4] == 0, @"a region placed as not visible is hidden");
    sp_document_place(document, 10, 20, 30, 40, true);
    webviewSetSurfaceHidden(surface, true);
    sp_document_place(document, 10, 20, 30, 40, true);
    webviewSetSurfaceHidden(surface, false);
    sp_document_frame(document, frame);
    check(frame[4] == 1, @"restoring a visible surface restores a document placed while the surface was hidden");

    // The text size (docs/spec/text-size.md) is page zoom and is kept after placement and scale changes.
    check(sp_document_zoom(document, 1.5) && view.pageZoom == 1.5, @"the document page zoom is the text size factor");
    sp_document_place(document, 10, 20, 30, 40, true);
    webviewSetFrame(surface, 0, 0, 520, 420);
    check(view.pageZoom == 1.5, [NSString stringWithFormat:@"placement keeps the document page zoom: %g", view.pageZoom]);
    check(!sp_document_zoom(document, 0) && !sp_document_zoom(document, NAN) && view.pageZoom == 1.5,
        @"an invalid page zoom is rejected and leaves the zoom unchanged");
    check(sp_document_zoom(document, 1) && view.pageZoom == 1, @"the document page zoom returns to 1");

    // V5-103 policy: a file address is opened with read permission granted up to the directory that holds the file. In a bundled
    // application the file is really displayed (application measurement of V5-103). This test executable has no bundle,
    // so WebKit ends the file navigation with an internal error; here the test proves that the address is accepted and the navigation
    // has started, because, unlike a rejected address, the navigation result remains in the status.
    check(sp_document_load(document, "file:///etc/hosts"), @"a file address is accepted");
    settle(@"the file navigation did not report", ^BOOL(NSDictionary *state) {
        return ([state[@"url"] isEqual:@"file:///etc/hosts"] || state[@"error"] != NSNull.null)
            && ![state[@"loading"] boolValue];
    });
    check(!sp_document_load(document, "not a url"), @"an invalid address is rejected");

    check(sp_document_load(document, [base stringByAppendingString:@"/one"].UTF8String), @"a web address is accepted");
    settle(@"the first document did not load", ^BOOL(NSDictionary *state) {
        return [state[@"title"] isEqual:@"One"] && ![state[@"loading"] boolValue];
    });
    // The document sends the Safari user agent of the same WebKit (docs/spec/native-surfaces.md#document-regions).
    NSString *safari = [NSBundle bundleWithPath:@"/Applications/Safari.app"].infoDictionary[@"CFBundleShortVersionString"];
    NSArray *parts = [safari componentsSeparatedByString:@"."];
    NSString *suffix = [NSString stringWithFormat:@" Version/%@.%@ Safari/605.1.15", parts[0], parts[1]];
    NSString *pageAgent = evaluate(view, @"navigator.userAgent");
    check([requestAgent hasSuffix:suffix] && [requestAgent hasPrefix:@"Mozilla/5.0 "] && [requestAgent containsString:@"AppleWebKit/"],
        [NSString stringWithFormat:@"the document request sends the Safari user agent ending in '%@': %@", suffix, requestAgent]);
    check([pageAgent isEqual:requestAgent],
        [NSString stringWithFormat:@"the page user agent equals the request header: %@ / %@", pageAgent, requestAgent]);
    check([evaluate(view, @"matchMedia('(prefers-color-scheme: dark)').matches") boolValue],
        @"the document renderer matches the owner's dark appearance");
    window.appearance = [NSAppearance appearanceNamed:NSAppearanceNameAqua];
    until(@"the document renderer did not receive the light appearance", ^BOOL {
        return ![evaluate(view, @"matchMedia('(prefers-color-scheme: dark)').matches") boolValue];
    });
    check(![evaluate(view, @"matchMedia('(prefers-color-scheme: dark)').matches") boolValue],
        @"the document renderer follows the owner's light appearance change");
    window.appearance = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
    until(@"the document renderer did not receive the dark appearance again", ^BOOL {
        return [evaluate(view, @"matchMedia('(prefers-color-scheme: dark)').matches") boolValue];
    });
    check([evaluate(view, @"matchMedia('(prefers-color-scheme: dark)').matches") boolValue],
        @"the document renderer follows the owner's dark appearance again");
    if (activation) {
        evaluate(view, @"window.nativeClicks=0; document.getElementById('field').value=''; null");
        sp_document_set_event(document, event, NULL);
        nativeEvents = 0;
        [NSApp activateIgnoringOtherApps:YES];
        [window makeKeyAndOrderFront:nil];
        NSPoint windowPoint = NSMakePoint(25, NSHeight(window.contentView.bounds) - 35);
        NSEvent *down = [NSEvent mouseEventWithType:NSEventTypeLeftMouseDown location:windowPoint
            modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber
            context:nil eventNumber:1 clickCount:1 pressure:1];
        NSEvent *up = [NSEvent mouseEventWithType:NSEventTypeLeftMouseUp location:windowPoint
            modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber
            context:nil eventNumber:1 clickCount:1 pressure:0];
        [NSApp postEvent:down atStart:NO];
        [NSApp postEvent:up atStart:NO];
        pumpEvents(@"the OS click was not delivered", ^BOOL {
            return nativeEvents >= 1 && [evaluate(view, @"document.activeElement && document.activeElement.id") isEqual:@"field"];
        });
        check(nativeEvents == 1 && [latestNativeEvent[@"type"] isEqual:@"click"],
            @"the OS event queue reports one document click to the owner callback");
        NSView *firstResponder = [window.firstResponder isKindOfClass:NSView.class] ? (NSView *)window.firstResponder : nil;
        check(firstResponder == view || [firstResponder isDescendantOf:view],
            @"the OS click makes the document webview the window first responder");
        check(view.superview == nativePlane && view.window == window,
            @"the owner callback does not replace the document's WebKit target");
        check([evaluate(view, @"document.activeElement && document.activeElement.id") isEqual:@"field"],
            @"the OS click focuses the page field");
        NSEvent *keyDown = [NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint
            modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber
            context:nil characters:@"x" charactersIgnoringModifiers:@"x" isARepeat:NO keyCode:7];
        NSEvent *keyUp = [NSEvent keyEventWithType:NSEventTypeKeyUp location:NSZeroPoint
            modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber
            context:nil characters:@"x" charactersIgnoringModifiers:@"x" isARepeat:NO keyCode:7];
        [NSApp postEvent:keyDown atStart:NO];
        [NSApp postEvent:keyUp atStart:NO];
        pumpEvents(@"the OS key was not delivered", ^BOOL {
            return [evaluate(view, @"document.getElementById('field').value") isEqual:@"x"];
        });
        check([evaluate(view, @"document.getElementById('field').value") isEqual:@"x"],
            @"the page receives the OS key after the document click");
        check(nativeEvents == 1, @"keyboard input does not duplicate the document click callback");
    }
    check([latest[@"url"] hasSuffix:@"/one"] && ![latest[@"canGoBack"] boolValue] && latest[@"error"] == NSNull.null,
        [NSString stringWithFormat:@"the state reports the loaded document: %@", latest]);

    // A native wheel scroll sent to a document that has just finished loading also moves the document by the requested distance, and that position is reported.
    __block sp_input_result scrollResult = SP_INPUT_REJECTED;
    sp_input_pointer_then(window, 250, 200, 4, 0, 0, 120, 5, scrollDone, &scrollResult);
    until(@"the native scroll was not delivered", ^BOOL { return scrollResult != SP_INPUT_REJECTED; });
    check(scrollResult == SP_INPUT_DELIVERED, @"a native scroll into the region is delivered");
    settle(@"the native scroll did not reach 120 pixels", ^BOOL(NSDictionary *state) {
        return [state[@"scroll"][@"y"] doubleValue] >= 120;
    });
    check([latest[@"scroll"][@"y"] doubleValue] == 120,
        [NSString stringWithFormat:@"a native scroll moves the document by the requested 120 pixels (%@)", latest[@"scroll"]]);

    evaluate(view, @"scrollTo(0, 300); null");
    settle(@"the scroll position was not reported", ^BOOL(NSDictionary *state) {
        return [state[@"scroll"][@"y"] doubleValue] == 300;
    });
    check(YES, @"scrolling the document reports its position");

    check([evaluate(view, @"typeof window.webkit?.messageHandlers?.soksakDocumentScroll") isEqual:@"undefined"],
        @"the page cannot see the scroll message handler");
    check([evaluate(view, @"typeof window.__soksakNative + typeof window.__soksakBackground") isEqual:@"undefinedundefined"],
        @"the page has no application bridge or injected script");

    NSString *refusal = capturedRecords(^{
        evaluate(view, @"document.getElementById('app').click(); null");
        settle(@"an application-scheme link was not refused", ^BOOL(NSDictionary *state) {
            return [state[@"error"] isKindOfClass:NSString.class];
        });
    });
    check([latest[@"url"] hasSuffix:@"/one"], @"an application-scheme link is refused and the document stays");
    check([refusal containsString:@" info native document view: navigation refused: wails://wails/index.html is not a web address"],
        [NSString stringWithFormat:@"a refused address is recorded (got %@)", refusal]);

    // A navigation that fails and the end of the WebContent process are recorded with the address of the document.
    NSString *failed = capturedRecords(^{
        check(sp_document_load(document, "file:///nonexistent/soksak-document-missing.html"), @"a missing file address is accepted");
        // The state of the refused link still holds its error until the new navigation starts.
        settle(@"the missing file did not fail", ^BOOL(NSDictionary *state) {
            return [state[@"error"] isKindOfClass:NSString.class] && ![state[@"error"] containsString:@"is not a web address"];
        });
    });
    check([failed containsString:@" info native document view: navigation failed: "] && [failed containsString:@"soksak-document-missing.html"],
        [NSString stringWithFormat:@"a failed navigation is recorded with its address (got %@)", failed]);
    NSString *ended = capturedRecords(^{
        [(id<WKNavigationDelegate>)view webViewWebContentProcessDidTerminate:view];
    });
    check([ended containsString:@" error native document view: web content process terminated: "],
        [NSString stringWithFormat:@"the end of the WebContent process is recorded (got %@)", ended]);

    check(sp_document_load(document, [base stringByAppendingString:@"/two"].UTF8String), @"a second address is accepted");
    settle(@"the second document did not load", ^BOOL(NSDictionary *state) {
        return [state[@"title"] isEqual:@"Two"] && ![state[@"loading"] boolValue] && [state[@"canGoBack"] boolValue];
    });
    check(latest[@"error"] == NSNull.null, @"a new navigation clears the previous error");
    // The session history starts with the oldest entry, and index is the current entry.
    NSArray *entries = latest[@"history"][@"entries"];
    check(entries.count == 2 && [entries[0][@"url"] hasSuffix:@"/one"] && [entries[0][@"title"] isEqual:@"One"]
        && [entries[1][@"title"] isEqual:@"Two"] && [latest[@"history"][@"index"] intValue] == 1,
        [NSString stringWithFormat:@"the state reports the session history: %@", latest[@"history"]]);
    check(!sp_document_go(document, 4, -5), @"an entry outside the history is refused");
    check(!sp_document_go(document, 4, 0), @"an entry at offset 0 is refused");
    check(sp_document_go(document, 4, -1), @"the entry before the current one is accepted");
    settle(@"the entry did not load the first document", ^BOOL(NSDictionary *state) {
        return [state[@"title"] isEqual:@"One"] && ![state[@"loading"] boolValue] && [state[@"history"][@"index"] intValue] == 0;
    });
    check(sp_document_go(document, 4, 1), @"the entry after the current one is accepted");
    settle(@"the entry did not load the second document", ^BOOL(NSDictionary *state) {
        return [state[@"title"] isEqual:@"Two"] && ![state[@"loading"] boolValue] && [state[@"history"][@"index"] intValue] == 1;
    });

    check(sp_document_go(document, 0, 0), @"back is accepted");
    settle(@"back did not return to the first document", ^BOOL(NSDictionary *state) {
        return [state[@"title"] isEqual:@"One"] && [state[@"canGoForward"] boolValue] && ![state[@"loading"] boolValue];
    });
    check(sp_document_go(document, 1, 0), @"forward is accepted");
    settle(@"forward did not return to the second document", ^BOOL(NSDictionary *state) {
        return [state[@"title"] isEqual:@"Two"] && ![state[@"canGoForward"] boolValue];
    });
    check(!sp_document_go(document, 1, 0), @"forward without a next document is refused");
    check(sp_document_go(document, 3, 0), @"stop is accepted");

    check(sp_document_go(document, 0, 0), @"back is accepted again");
    settle(@"back did not return to the first document", ^BOOL(NSDictionary *state) {
        return [state[@"title"] isEqual:@"One"] && ![state[@"loading"] boolValue];
    });
    evaluate(view, @"document.getElementById('blank').click(); null");
    settle(@"a new-window link did not open in the same region", ^BOOL(NSDictionary *state) {
        return [state[@"title"] isEqual:@"Blank"];
    });
    check(documents(nativePlane) == 1, @"a new-window link does not create another view");

    // When a new navigation replaces a document that is still loading, the end of loading of the previous document is not reported. The title may arrive in the report after
    // the loading ends, so it is not part of this condition.
    check(sp_document_load(document, [base stringByAppendingString:@"/slow"].UTF8String), @"a slow address is accepted");
    settle(@"the slow document did not start", ^BOOL(NSDictionary *state) {
        return [state[@"url"] hasSuffix:@"/slow"] && [state[@"loading"] boolValue];
    });
    expected = ^BOOL(NSDictionary *state) {
        return [state[@"loading"] boolValue] || [state[@"url"] hasSuffix:@"/two"];
    };
    check(sp_document_load(document, [base stringByAppendingString:@"/two"].UTF8String), @"an address replacing a loading one is accepted");
    settle(@"the replacing document did not load", ^BOOL(NSDictionary *state) {
        return [state[@"title"] isEqual:@"Two"] && ![state[@"loading"] boolValue];
    });
    expected = nil;
    check(mismatch == nil, [NSString stringWithFormat:@"a replaced load reports loading until the new document loads: %@", mismatch]);

    sp_document_background(document, true);
    check(view.contentFilters.count == 1, @"the background state blurs the document");
    sp_document_background(document, false);
    check(view.contentFilters.count == 0, @"clearing the background state removes the blur");

    // The elements of the document and the recorded requests are carried in the status.
    check(sp_document_load(document, [base stringByAppendingString:@"/inspect"].UTF8String), @"the inspect address is accepted");
    settle(@"the inspect document did not report its elements and requests", ^BOOL(NSDictionary *state) {
        NSArray *entries = state[@"requests"][@"entries"];
        BOOL fetched = NO;
        for (NSDictionary *entry in entries) if ([entry[@"type"] isEqual:@"fetch"] && [entry[@"url"] hasSuffix:@"/blank"]) fetched = YES;
        return [state[@"title"] isEqual:@"Inspected"] && fetched && [state[@"elements"][@"nodes"] count] > 0;
    });
    NSArray *nodes = latest[@"elements"][@"nodes"];
    NSMutableArray *shown = [NSMutableArray array];
    for (NSDictionary *node in nodes) {
        [shown addObject:[NSString stringWithFormat:@"%@:%@#%@.%@", node[@"depth"], node[@"tag"], node[@"id"], node[@"class"]]];
    }
    check([[shown componentsJoinedByString:@" "] isEqual:@"0:html#. 1:head#. 2:title#. 1:body#. 2:div#box.a b 3:p#. 2:script#."]
        && ![latest[@"elements"][@"truncated"] boolValue],
        [NSString stringWithFormat:@"the elements are reported in document order with depth, tag, id, and class: %@", shown]);
    NSDictionary *first = [latest[@"requests"][@"entries"] firstObject];
    check([first[@"type"] isEqual:@"navigation"] && [first[@"url"] hasSuffix:@"/inspect"] && [first[@"duration"] doubleValue] >= 0,
        [NSString stringWithFormat:@"the navigation is the first request: %@", first]);
    evaluate(view, @"document.body.append(document.createElement('section')); null");
    settle(@"a new element was not reported", ^BOOL(NSDictionary *state) {
        return [[[state[@"elements"][@"nodes"] lastObject] objectForKey:@"tag"] isEqual:@"section"];
    });

    // The address of the link under the pointer is link in the status. Outside a link it is an empty string.
    check([latest[@"link"] isEqual:@""], [NSString stringWithFormat:@"a document without a pointed link reports an empty link: %@", latest[@"link"]]);
    evaluate(view, @"const a = document.createElement('a'); a.href = '/target'; a.textContent = 'go'; document.body.append(a);"
        " a.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); null");
    settle(@"the link under the pointer was not reported", ^BOOL(NSDictionary *state) {
        return [state[@"link"] isKindOfClass:NSString.class] && [state[@"link"] hasSuffix:@"/target"];
    });
    evaluate(view, @"document.querySelector('a').dispatchEvent(new MouseEvent('mouseout', { bubbles: true })); null");
    settle(@"leaving the link did not clear it", ^BOOL(NSDictionary *state) {
        return [state[@"link"] isEqual:@""];
    });

    // Documents in the same directory share site data, and documents in different directories do not.
    void *same = sp_document_create(surface, storeA.fileSystemRepresentation, NULL, NULL, changed, NULL);
    void *other = sp_document_create(surface, storeB.fileSystemRepresentation, NULL, NULL, changed, NULL);
    check(same != NULL && other != NULL, @"documents are created for a shared and a separate store directory");
    NSHTTPCookie *cookie = [NSHTTPCookie cookieWithProperties:@{
        NSHTTPCookieDomain: @"127.0.0.1", NSHTTPCookiePath: @"/", NSHTTPCookieName: @"store",
        NSHTTPCookieValue: @"a", NSHTTPCookieExpires: [NSDate dateWithTimeIntervalSinceNow:3600]}];
    __block BOOL stored = NO;
    [view.configuration.websiteDataStore.httpCookieStore setCookie:cookie completionHandler:^{ stored = YES; }];
    until(@"the cookie was not stored", ^BOOL { return stored; });
    NSArray<NSHTTPCookie *> *(^cookies)(void *) = ^NSArray<NSHTTPCookie *> *(void *handle) {
        __block NSArray<NSHTTPCookie *> *found = nil;
        [((WKWebView *)handle).configuration.websiteDataStore.httpCookieStore getAllCookies:^(NSArray<NSHTTPCookie *> *all) {
            found = [all retain];
        }];
        until(@"the cookie store did not answer", ^BOOL { return found != nil; });
        return [found autorelease];
    };
    BOOL (^hasStoreCookie)(NSArray<NSHTTPCookie *> *) = ^BOOL(NSArray<NSHTTPCookie *> *all) {
        for (NSHTTPCookie *item in all) if ([item.name isEqual:@"store"]) return YES;
        return NO;
    };
    check(hasStoreCookie(cookies(same)), @"a document with the same store directory sees the cookie");
    check(!hasStoreCookie(cookies(other)), @"a document with another store directory does not see the cookie");
    BOOL isDirectory = NO;
    check([NSFileManager.defaultManager fileExistsAtPath:storeA isDirectory:&isDirectory] && isDirectory,
        @"the store keeps its data in the given directory");
    sp_document_close(same);
    sp_document_close(other);

    // Schedules a report just before closing and checks that no report arrives after that turn passes following the close.
    evaluate(view, @"scrollTo(0, 10); null");
    sp_document_close(document);
    int after = reports;
    __block BOOL passed = NO;
    CFRunLoopPerformBlock(CFRunLoopGetMain(), kCFRunLoopCommonModes, ^{ passed = YES; });
    until(@"the run loop did not continue", ^BOOL { return passed; });
    check(reports == after, @"a closed document reports nothing");
    check(documents(nativePlane) == 0, @"closing removes the document view");

    [NSFileManager.defaultManager removeItemAtPath:stores error:nil];
    for (id connection in held) nw_connection_cancel((nw_connection_t)connection);
    nw_listener_cancel(listener);
    sp_surface_close(surface);
    [window close];
    [window release];
    return failures ? 1 : 0;
}}
