// 문서 영역 웹뷰의 이동, 기록, 상태 보고, 배치, 격리를 검사한다. 애플리케이션을 활성화하지 않는다.
//
// 검사 문서는 이 프로세스가 루프백 주소에서 제공한다.
#import <Cocoa/Cocoa.h>
#import <Network/Network.h>
#import <WebKit/WebKit.h>
#import "document_view.h"
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

// 검사 문서. 경로마다 제목과 본문이 다르다.
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
    return nil;
}

// 응답하지 않는 요청의 연결. 검사가 끝날 때 닫는다.
static NSMutableArray *held;

// 한 요청에 한 응답을 보내고 연결을 닫는 HTTP 서버. /slow 에는 응답하지 않는다.
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
// 설정되어 있으면 모든 보고를 이 조건으로 검사하고, 어긋난 보고를 남긴다.
static BOOL (^expected)(NSDictionary *state);
static NSDictionary *mismatch;

static void event(void *context, const char *text) {
    NSData *data = [NSData dataWithBytes:text length:strlen(text)];
    [latestNativeEvent release];
    latestNativeEvent = [[NSJSONSerialization JSONObjectWithData:data options:0 error:nil] retain];
    nativeEvents++;
}
static void scrollDone(void *context, sp_input_result result) {
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

// 표면 안의 WKWebView 수. 표면 자신의 내부 뷰는 WKWebView 가 아니다.
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

int main(void) { @autoreleasepool {
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
    void *document = sp_document_create(surface, "soksak-test/documents", changed, NULL);
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
    // 여백보다 작아졌던 표면이 다시 커져도 영역은 여백으로 정해진다.
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

    check(!sp_document_load(document, "file:///etc/hosts"), @"a file address is rejected");
    check(!sp_document_load(document, "not a url"), @"an invalid address is rejected");

    check(sp_document_load(document, [base stringByAppendingString:@"/one"].UTF8String), @"a web address is accepted");
    settle(@"the first document did not load", ^BOOL(NSDictionary *state) {
        return [state[@"title"] isEqual:@"One"] && ![state[@"loading"] boolValue];
    });
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
    check([latest[@"url"] hasSuffix:@"/one"] && ![latest[@"canGoBack"] boolValue] && latest[@"error"] == NSNull.null,
        [NSString stringWithFormat:@"the state reports the loaded document: %@", latest]);

    // 읽기를 막 끝낸 문서에 보낸 네이티브 휠 스크롤도 요청한 거리만큼 문서를 움직이고, 그 위치가 보고된다.
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

    evaluate(view, @"document.getElementById('app').click(); null");
    settle(@"an application-scheme link was not refused", ^BOOL(NSDictionary *state) {
        return [state[@"error"] isKindOfClass:NSString.class];
    });
    check([latest[@"url"] hasSuffix:@"/one"], @"an application-scheme link is refused and the document stays");

    check(sp_document_load(document, [base stringByAppendingString:@"/two"].UTF8String), @"a second address is accepted");
    settle(@"the second document did not load", ^BOOL(NSDictionary *state) {
        return [state[@"title"] isEqual:@"Two"] && ![state[@"loading"] boolValue] && [state[@"canGoBack"] boolValue];
    });
    check(latest[@"error"] == NSNull.null, @"a new navigation clears the previous error");

    check(sp_document_go(document, 0), @"back is accepted");
    settle(@"back did not return to the first document", ^BOOL(NSDictionary *state) {
        return [state[@"title"] isEqual:@"One"] && [state[@"canGoForward"] boolValue] && ![state[@"loading"] boolValue];
    });
    check(sp_document_go(document, 1), @"forward is accepted");
    settle(@"forward did not return to the second document", ^BOOL(NSDictionary *state) {
        return [state[@"title"] isEqual:@"Two"] && ![state[@"canGoForward"] boolValue];
    });
    check(!sp_document_go(document, 1), @"forward without a next document is refused");
    check(sp_document_go(document, 3), @"stop is accepted");

    check(sp_document_go(document, 0), @"back is accepted again");
    settle(@"back did not return to the first document", ^BOOL(NSDictionary *state) {
        return [state[@"title"] isEqual:@"One"] && ![state[@"loading"] boolValue];
    });
    evaluate(view, @"document.getElementById('blank').click(); null");
    settle(@"a new-window link did not open in the same region", ^BOOL(NSDictionary *state) {
        return [state[@"title"] isEqual:@"Blank"];
    });
    check(documents(nativePlane) == 1, @"a new-window link does not create another view");

    // 읽는 중인 문서를 새 이동이 대신하면, 이전 문서의 읽기가 끝났다고 보고하지 않는다. 제목은 읽기가
    // 끝난 뒤의 보고에 올 수 있으므로 이 조건에 넣지 않는다.
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

    // 닫기 직전에 보고를 예약해 두고, 닫은 뒤 그 차례가 지나도 보고가 없는지 본다.
    evaluate(view, @"scrollTo(0, 10); null");
    sp_document_close(document);
    int after = reports;
    __block BOOL passed = NO;
    CFRunLoopPerformBlock(CFRunLoopGetMain(), kCFRunLoopCommonModes, ^{ passed = YES; });
    until(@"the run loop did not continue", ^BOOL { return passed; });
    check(reports == after, @"a closed document reports nothing");
    check(documents(nativePlane) == 0, @"closing removes the document view");

    for (id connection in held) nw_connection_cancel((nw_connection_t)connection);
    nw_listener_cancel(listener);
    sp_surface_close(surface);
    [window close];
    [window release];
    return failures ? 1 : 0;
}}
