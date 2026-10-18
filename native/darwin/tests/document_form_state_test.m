// The form state of the session state of a web view. A local site serves a form page with a named text input and textarea in a
// form, a contenteditable element, and a cross-origin frame that holds a text input. The check sets text in each field with an
// input event, reads the public interactionState, closes the web view, sets that state on a new web view of the same
// configuration, and reads each field after the load. It does so once with the form page as the current entry and once with
// the form page left by a navigation and reached again by going back in the restored web view. The check records the measured
// behavior of WebKit: the encoded state holds the page addresses but no typed text, and no field is restored in either case,
// so interactionState does not carry the contents of form fields. The check fails when WebKit starts to carry them. The check
// does not activate the application.
#import <Cocoa/Cocoa.h>
#import <Network/Network.h>
#import <WebKit/WebKit.h>
#import <string.h>

static const NSTimeInterval stepLimit = 20;

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static BOOL pumpUntil(NSTimeInterval limit, BOOL (^done)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:limit];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
    return done();
}

static void failStep(NSString *step, NSString *reason) {
    fprintf(stderr, "FAIL: step %s: %s\n", step.UTF8String, reason.UTF8String);
    exit(1);
}

static int framePort;

static void respond(nw_connection_t connection, NSString *request) {
    NSArray<NSString *> *parts = [request componentsSeparatedByString:@" "];
    NSString *path = parts.count >= 2 ? parts[1] : @"";
    NSString *status = @"200 OK";
    NSString *body;
    if ([path isEqualToString:@"/form"]) {
        body = [NSString stringWithFormat:@"<!doctype html><title>Form</title><body>"
            "<form><input id=field name=field><textarea id=area name=area></textarea></form><div id=editable contenteditable></div>"
            "<iframe id=frame src=\"http://127.0.0.1:%d/frame\"></iframe></body>", framePort];
    } else if ([path isEqualToString:@"/frame"]) {
        body = @"<!doctype html><title>Frame</title><body><input id=field>"
            "<script>window.addEventListener('message', (event) => {"
            "  const field = document.getElementById('field');"
            "  if (event.data.type) { field.value = event.data.type; field.dispatchEvent(new Event('input', {bubbles: true})); }"
            "  event.source.postMessage({value: field.value}, '*');"
            "});</script></body>";
    } else if ([path isEqualToString:@"/other"]) {
        body = @"<!doctype html><title>Other</title><body>other</body>";
    } else {
        status = @"404 Not Found";
        body = @"";
    }
    NSData *bytes = [body dataUsingEncoding:NSUTF8StringEncoding];
    NSString *head = [NSString stringWithFormat:@"HTTP/1.1 %@\r\nContent-Type: text/html; charset=utf-8\r\n"
        "Content-Length: %lu\r\nConnection: close\r\n\r\n", status, (unsigned long)bytes.length];
    NSMutableData *response = [NSMutableData dataWithData:[head dataUsingEncoding:NSUTF8StringEncoding]];
    [response appendData:bytes];
    dispatch_data_t out = dispatch_data_create(response.bytes, response.length, dispatch_get_main_queue(), DISPATCH_DATA_DESTRUCTOR_DEFAULT);
    nw_connection_send(connection, out, NW_CONNECTION_FINAL_MESSAGE_CONTEXT, true, ^(nw_error_t sent) {
        nw_connection_cancel(connection);
    });
}

static nw_listener_t serve(void) {
    nw_parameters_t parameters = nw_parameters_create_secure_tcp(NW_PARAMETERS_DISABLE_PROTOCOL, NW_PARAMETERS_DEFAULT_CONFIGURATION);
    nw_parameters_set_local_endpoint(parameters, nw_endpoint_create_host("127.0.0.1", "0"));
    nw_listener_t server = nw_listener_create(parameters);
    nw_listener_set_queue(server, dispatch_get_main_queue());
    nw_listener_set_new_connection_handler(server, ^(nw_connection_t connection) {
        nw_connection_set_queue(connection, dispatch_get_main_queue());
        nw_connection_start(connection);
        nw_connection_receive(connection, 1, 65536, ^(dispatch_data_t content, nw_content_context_t context, bool complete, nw_error_t error) {
            NSString *request = content ? [[[NSString alloc] initWithData:(NSData *)content encoding:NSUTF8StringEncoding] autorelease] : @"";
            respond(connection, request ?: @"");
        });
    });
    __block BOOL ready = NO;
    nw_listener_set_state_changed_handler(server, ^(nw_listener_state_t state, nw_error_t error) {
        if (state == nw_listener_state_ready) ready = YES;
    });
    nw_listener_start(server);
    if (!pumpUntil(10, ^BOOL { return ready; })) failStep(@"serve", @"the test server did not start within 10 seconds");
    return server;
}

@interface LoadWatcher : NSObject <WKNavigationDelegate>
@property(nonatomic) NSInteger finished;
@end

@implementation LoadWatcher
- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    self.finished++;
}
@end

// Whether the encoded state holds the text in UTF-8 or UTF-16.
static BOOL holds(NSData *state, NSString *text) {
    for (NSNumber *encoding in @[ @(NSUTF8StringEncoding), @(NSUTF16LittleEndianStringEncoding) ]) {
        NSData *bytes = [text dataUsingEncoding:encoding.unsignedIntegerValue];
        if ([state rangeOfData:bytes options:0 range:NSMakeRange(0, state.length)].location != NSNotFound) return YES;
    }
    return NO;
}

static NSWindow *window;
static WKWebViewConfiguration *configuration;
static LoadWatcher *watcher;

static WKWebView *createView(void) {
    WKWebView *view = [[WKWebView alloc] initWithFrame:window.contentView.bounds configuration:configuration];
    view.navigationDelegate = watcher;
    [window.contentView addSubview:view];
    return view;
}

static void closeView(WKWebView *view) {
    [view removeFromSuperview];
    [view release];
}

static id evaluate(WKWebView *view, NSString *script) {
    __block BOOL done = NO;
    __block id result = nil;
    [view callAsyncJavaScript:script arguments:nil inFrame:nil inContentWorld:WKContentWorld.pageWorld
        completionHandler:^(id value, NSError *error) {
            if (error) fprintf(stderr, "script error: %s\n", error.description.UTF8String);
            result = [value retain];
            done = YES;
        }];
    if (!pumpUntil(10, ^BOOL { return done; })) failStep(@"evaluate", @"JavaScript did not answer within 10 seconds");
    return [result autorelease];
}

// Waits until the web view shows the title with its frame loaded and returns the four field values.
static NSDictionary *fields(WKWebView *view, NSString *step, NSString *type) {
    if (!pumpUntil(stepLimit, ^BOOL { return [view.title isEqual:@"Form"] && !view.loading; })) {
        failStep(step, [NSString stringWithFormat:@"the web view did not show the form (title %@)", view.title]);
    }
    NSString *typeLiteral = type ? [NSString stringWithFormat:@"'%@'", type] : @"null";
    NSString *script = [NSString stringWithFormat:
        @"const type = %@;"
        "const frame = document.getElementById('frame');"
        "if (!frame.contentWindow || frame.dataset.ready !== '1') await new Promise((resolve) => {"
        "  const ask = () => { frame.contentWindow.postMessage({}, '*'); };"
        "  const timer = setInterval(ask, 50);"
        "  window.addEventListener('message', function first() { clearInterval(timer); window.removeEventListener('message', first);"
        "    frame.dataset.ready = '1'; resolve(); });"
        "  ask();"
        "});"
        "const field = document.getElementById('field');"
        "const area = document.getElementById('area');"
        "const editable = document.getElementById('editable');"
        "if (type) {"
        "  field.value = type + ' input'; field.dispatchEvent(new Event('input', {bubbles: true}));"
        "  area.value = type + ' area'; area.dispatchEvent(new Event('input', {bubbles: true}));"
        "  editable.textContent = type + ' editable'; editable.dispatchEvent(new Event('input', {bubbles: true}));"
        "}"
        "const frameValue = await new Promise((resolve) => {"
        "  window.addEventListener('message', function answer(event) { window.removeEventListener('message', answer);"
        "    resolve(event.data.value); });"
        "  frame.contentWindow.postMessage(type ? {type: type + ' frame'} : {}, '*');"
        "});"
        "return {input: field.value, area: area.value, editable: editable.textContent, frame: frameValue};", typeLiteral];
    NSDictionary *values = evaluate(view, script);
    fprintf(stdout, "%s: input=\"%s\" area=\"%s\" editable=\"%s\" frame=\"%s\"\n", step.UTF8String,
        [values[@"input"] UTF8String], [values[@"area"] UTF8String], [values[@"editable"] UTF8String], [values[@"frame"] UTF8String]);
    return values;
}

static void waitForTitle(WKWebView *view, NSString *step, NSString *title) {
    if (!pumpUntil(stepLimit, ^BOOL { return [view.title isEqual:title] && !view.loading; })) {
        failStep(step, [NSString stringWithFormat:@"the web view did not show %@ (title %@)", title, view.title]);
    }
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    nw_listener_t frameListener = serve();
    framePort = nw_listener_get_port(frameListener);
    nw_listener_t listener = serve();
    NSString *base = [NSString stringWithFormat:@"http://127.0.0.1:%d/", nw_listener_get_port(listener)];
    NSURL *form = [NSURL URLWithString:[base stringByAppendingString:@"form"]];
    NSURL *other = [NSURL URLWithString:[base stringByAppendingString:@"other"]];

    window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 500, 400)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    [window orderFrontRegardless];
    configuration = [[WKWebViewConfiguration alloc] init];
    configuration.websiteDataStore = [WKWebsiteDataStore nonPersistentDataStore];
    watcher = [[LoadWatcher alloc] init];
    NSDictionary *empty = @{@"input": @"", @"area": @"", @"editable": @"", @"frame": @""};

    // The current entry: the typed page is the current entry when the state is read.
    WKWebView *view = createView();
    [view loadRequest:[NSURLRequest requestWithURL:form]];
    NSDictionary *typed = fields(view, @"type current", @"current");
    check([typed isEqual:(@{@"input": @"current input", @"area": @"current area", @"editable": @"current editable",
        @"frame": @"current frame"})], @"the typed values are in every field before the state is read");
    NSData *state = [[view.interactionState retain] autorelease];
    fprintf(stdout, "current entry state: %lu bytes, typed input %s\n", (unsigned long)state.length,
        holds(state, @"current input") ? "present" : "absent");
    check([state isKindOfClass:[NSData class]] && state.length > 0, @"interactionState returns data");
    check(holds(state, @"/form") && !holds(state, @"current input"), @"the state of the current form page holds no typed text");
    closeView(view);

    view = createView();
    view.interactionState = state;
    NSDictionary *restored = fields(view, @"restore current", nil);
    check([restored isEqual:empty], [NSString stringWithFormat:
        @"a restored current entry shows empty fields (%@)", restored]);
    closeView(view);

    // A history entry: the typed page is left by a navigation, so the commit saves its form state into its history item.
    view = createView();
    [view loadRequest:[NSURLRequest requestWithURL:form]];
    fields(view, @"type history", @"history");
    [view loadRequest:[NSURLRequest requestWithURL:other]];
    waitForTitle(view, @"navigate away", @"Other");
    state = [[view.interactionState retain] autorelease];
    fprintf(stdout, "history entry state: %lu bytes, typed input %s, frame input %s, address /other %s\n", (unsigned long)state.length,
        holds(state, @"history input") ? "present" : "absent", holds(state, @"history frame") ? "present" : "absent", holds(state, @"/other") ? "present" : "absent");
    check(holds(state, @"/other") && !holds(state, @"history input") && !holds(state, @"history frame"),
        @"the state of a left form page holds the addresses and no typed text");
    closeView(view);

    view = createView();
    view.interactionState = state;
    waitForTitle(view, @"restore history", @"Other");
    check(view.canGoBack, @"the restored web view can go back to the form page");
    [view goBack];
    NSDictionary *back = fields(view, @"back in restored view", nil);
    check([back isEqual:empty], [NSString stringWithFormat:
        @"the form page reached by going back in the restored web view shows empty fields (%@)", back]);
    closeView(view);

    nw_listener_cancel(listener);
    nw_listener_cancel(frameListener);
    [window close];
    if (failures) fprintf(stderr, "FAIL: %d checks failed\n", failures);
    else fprintf(stdout, "PASS: document form state\n");
    return failures ? 1 : 0;
}}
