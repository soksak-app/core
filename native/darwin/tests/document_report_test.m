// The reports of a document region that the memory saver decides with (docs/spec/plugins.md#memory-saver). A local site serves a
// media page with a looping silent audio element, and a form page with a text field, a contenteditable element and a
// cross-origin frame that holds a form with a text field. The check requires that the query of the region answers whether it
// plays audible media (false for an element that has never played, true while it plays and false after it is paused), no
// capture, and the form flag: an input event of a script does not set it, native key
// events typed into a field of the main frame and of the cross-origin frame set it, and a reload, a form submit, the pagehide
// of the frame and a main frame navigation clear it. It then requires that the interactionState of the region, restored into a
// new region, gives back the history, and that a state that is not base64, a state that the web view refuses and a restore
// after a load are refused with their errors. The check does not activate the application.
#import <Cocoa/Cocoa.h>
#import <Network/Network.h>
#import <WebKit/WebKit.h>
#import <string.h>
#import "document_view.h"
#import "input_inject.h"
#import "webview_geometry.h"

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

// The latest state of the first region (context 1) and of the restored region (context 2).
static NSDictionary *latest[3];

static void changed(void *context, const char *text) {
    NSUInteger index = (NSUInteger)context;
    [latest[index] release];
    latest[index] = [[NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:text length:strlen(text)] options:0 error:nil] retain];
}

static void failStep(NSString *step, NSString *reason) {
    fprintf(stderr, "FAIL: step %s: %s (title=%s url=%s)\n", step.UTF8String, reason.UTF8String,
        [latest[1][@"title"] description].UTF8String, [latest[1][@"url"] description].UTF8String);
    exit(1);
}

static int framePort;
static NSData *silence;

static void respond(nw_connection_t connection, NSString *request) {
    NSArray<NSString *> *parts = [request componentsSeparatedByString:@" "];
    NSString *path = parts.count >= 2 ? parts[1] : @"";
    NSString *status = @"200 OK";
    NSString *type = @"text/html; charset=utf-8";
    NSData *bytes = nil;
    NSString *body = @"";
    if ([path isEqualToString:@"/media"]) {
        body = @"<!doctype html><title>Media</title><body><audio id=audio loop src=/silence.wav></audio></body>";
    } else if ([path isEqualToString:@"/silence.wav"]) {
        type = @"audio/wav";
        bytes = silence;
    } else if ([path isEqualToString:@"/form"]) {
        body = [NSString stringWithFormat:@"<!doctype html><title>Form</title><style>body{margin:0}</style><body>"
            "<input id=field style='position:absolute;left:0;top:0;width:200px;height:40px'>"
            "<div id=editable contenteditable style='position:absolute;left:250px;top:0;width:200px;height:40px'></div>"
            "<iframe id=frame style='position:absolute;left:0;top:100px;width:300px;height:100px;border:0'"
            " src=\"http://127.0.0.1:%d/frame\"></iframe>"
            "<script>let loads = 0; frame.addEventListener('load', () => { loads++; document.title = `Form ${loads}`; });"
            "let frameFocus = false; addEventListener('message', (event) => { frameFocus = event.data === 'focus'; });"
            "</script></body>", framePort];
    } else if ([path hasPrefix:@"/frame"]) {
        body = @"<!doctype html><title>Frame</title><style>body{margin:0}</style><body>"
            "<form id=form onsubmit='event.preventDefault()'>"
            "<input id=field style='position:absolute;left:0;top:0;width:200px;height:40px'></form>"
            "<script>addEventListener('message', (event) => { if (event.data === 'submit') form.requestSubmit(); });"
            "field.addEventListener('focus', () => parent.postMessage('focus', '*'));"
            "field.addEventListener('blur', () => parent.postMessage('blur', '*'));</script></body>";
    } else if ([path isEqualToString:@"/other"]) {
        body = @"<!doctype html><title>Other</title><body>other</body>";
    } else {
        status = @"404 Not Found";
    }
    if (!bytes) bytes = [body dataUsingEncoding:NSUTF8StringEncoding];
    NSString *head = [NSString stringWithFormat:@"HTTP/1.1 %@\r\nContent-Type: %@\r\nContent-Length: %lu\r\nConnection: close\r\n\r\n",
        status, type, (unsigned long)bytes.length];
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

// One second of 8-bit mono silence at 8000 Hz as a WAV file.
static NSData *silentWave(void) {
    const uint32_t samples = 8000;
    NSMutableData *data = [NSMutableData data];
    uint32_t chunk = 36 + samples, format = 16, rate = 8000, byteRate = 8000, size = samples;
    uint16_t pcm = 1, channels = 1, align = 1, bits = 8;
    [data appendBytes:"RIFF" length:4]; [data appendBytes:&chunk length:4]; [data appendBytes:"WAVEfmt " length:8];
    [data appendBytes:&format length:4]; [data appendBytes:&pcm length:2]; [data appendBytes:&channels length:2];
    [data appendBytes:&rate length:4]; [data appendBytes:&byteRate length:4]; [data appendBytes:&align length:2];
    [data appendBytes:&bits length:2]; [data appendBytes:"data" length:4]; [data appendBytes:&size length:4];
    NSMutableData *body = [NSMutableData dataWithLength:samples];
    memset(body.mutableBytes, 128, samples);
    [data appendData:body];
    return data;
}

static void queried(void *context, const char *json) {
    NSDictionary **out = (NSDictionary **)context;
    *out = [[NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:json length:strlen(json)] options:0 error:nil] retain];
}

// Queries the region and returns the reply.
static NSDictionary *query(void *document, NSString *step) {
    NSDictionary *reply = nil;
    NSDictionary **slot = &reply;
    sp_document_query(document, queried, slot);
    if (!pumpUntil(10, ^BOOL { return *slot != nil; })) failStep(step, @"the query did not reply within 10 seconds");
    return [reply autorelease];
}

// Queries the region until the field has the value, and returns the last reply.
static NSDictionary *queryUntil(void *document, NSString *step, NSString *field, id value) {
    __block NSDictionary *reply = nil;
    pumpUntil(stepLimit, ^BOOL {
        reply = query(document, step);
        return [reply[field] isEqual:value];
    });
    fprintf(stdout, "%s: %s\n", step.UTF8String, reply.description.UTF8String);
    return reply;
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

static void waitForTitle(NSUInteger index, NSString *step, NSString *title) {
    if (!pumpUntil(stepLimit, ^BOOL { return [latest[index][@"title"] isEqual:title] && ![latest[index][@"loading"] boolValue]; })) {
        failStep(step, [NSString stringWithFormat:@"the region did not show %@", title]);
    }
}

// Presses the window point, waits until the expression of the main frame focused is true, and types one key with native events.
static void type(NSWindow *window, WKWebView *view, double x, double y, NSString *focused, NSString *step) {
    BOOL pressed = sp_input_pointer(window, x, y, 1, 0, 0, 0) == SP_INPUT_DELIVERED
        && sp_input_pointer(window, x, y, 3, 0, 0, 0) == SP_INPUT_DELIVERED;
    if (!pressed) failStep(step, @"the native press is not delivered");
    NSString *script = [NSString stringWithFormat:@"return %@;", focused];
    if (!pumpUntil(stepLimit, ^BOOL { return [evaluate(view, script) isEqual:@YES]; })) {
        failStep(step, [NSString stringWithFormat:@"the press did not focus %@", focused]);
    }
    BOOL typed = sp_input_key(window, "a", "a", 0, true) == SP_INPUT_DELIVERED
        && sp_input_key(window, "a", "a", 0, false) == SP_INPUT_DELIVERED;
    if (!typed) failStep(step, @"the native key is not delivered");
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    silence = [silentWave() retain];
    nw_listener_t frameListener = serve();
    framePort = nw_listener_get_port(frameListener);
    nw_listener_t listener = serve();
    NSString *base = [NSString stringWithFormat:@"http://127.0.0.1:%d/", nw_listener_get_port(listener)];

    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 500, 400)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 500, 400)] autorelease];
    WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
    [window.contentView addSubview:main];
    [window orderBack:nil];
    void *surface = sp_surface_create(main);
    if (!surface) failStep(@"surface", @"a logical surface is not created");
    webviewSetFrame(surface, 0, 0, 500, 400);
    webviewSetSurfaceHidden(surface, false);
    NSString *temporary = [NSTemporaryDirectory() stringByAppendingPathComponent:
        [NSString stringWithFormat:@"soksak-document-report-%d", getpid()]];
    const char *store = [temporary stringByAppendingPathComponent:@"store"].fileSystemRepresentation;
    void *document = sp_document_create(surface, store, NULL, NULL, changed, (void *)1);
    if (!document) failStep(@"create", @"a document region is not created");
    WKWebView *view = (WKWebView *)document;
    sp_document_place(document, 0, 0, 0, 0, true);

    // Media playback and capture.
    sp_document_load(document, [base stringByAppendingString:@"media"].UTF8String);
    waitForTitle(1, @"media", @"Media");
    NSDictionary *idle = query(document, @"media idle");
    check([idle[@"media"] isEqual:@NO] && [evaluate(view, @"return audio.paused;") isEqual:@YES], [NSString stringWithFormat:
        @"a media element that has never played reports no audible media (%@)", idle]);
    check([idle[@"capture"] isEqual:@NO], [NSString stringWithFormat:@"a region without capture reports no capture (%@)", idle]);
    check([idle[@"form"] isEqual:@NO], [NSString stringWithFormat:@"a region without input reports no form (%@)", idle]);
    evaluate(view, @"await document.getElementById('audio').play(); return true;");
    NSDictionary *playing = queryUntil(document, @"media playing", @"media", @YES);
    check([playing[@"media"] isEqual:@YES], [NSString stringWithFormat:@"a playing audio element reports audible media (%@)", playing]);
    evaluate(view, @"document.getElementById('audio').pause(); return true;");
    NSDictionary *paused = queryUntil(document, @"media paused", @"media", @NO);
    check([paused[@"media"] isEqual:@NO], [NSString stringWithFormat:@"a paused audio element reports no audible media (%@)", paused]);

    // Form flags.
    sp_document_load(document, [base stringByAppendingString:@"form"].UTF8String);
    waitForTitle(1, @"form", @"Form 1");
    evaluate(view, @"field.value = 'script'; field.dispatchEvent(new Event('input', {bubbles: true})); return true;");
    pumpUntil(0.5, ^BOOL { return NO; });
    NSDictionary *scripted = query(document, @"script input");
    check([scripted[@"form"] isEqual:@NO], [NSString stringWithFormat:@"an input event of a script sets no form flag (%@)", scripted]);
    type(window, view, 50, 20, @"document.activeElement === field", @"main field");
    check([queryUntil(document, @"main field", @"form", @YES)[@"form"] isEqual:@YES], @"a key typed into a field of the main frame sets the form flag");
    // The title changes before the reload, so the title of the reloaded page shows that the reload ended.
    evaluate(view, @"document.title = 'Reloading'; return true;");
    sp_document_go(document, 2, 0);
    waitForTitle(1, @"reload", @"Form 1");
    check([queryUntil(document, @"reload", @"form", @NO)[@"form"] isEqual:@NO], @"a reload clears the form flag");
    type(window, view, 50, 120, @"frameFocus", @"frame field");
    check([queryUntil(document, @"frame field", @"form", @YES)[@"form"] isEqual:@YES], @"a key typed into a field of a cross-origin frame sets the form flag");
    evaluate(view, @"frame.contentWindow.postMessage('submit', '*'); return true;");
    check([queryUntil(document, @"frame submit", @"form", @NO)[@"form"] isEqual:@NO], @"a form submit of the frame clears its form flag");
    type(window, view, 50, 120, @"frameFocus", @"frame field again");
    check([queryUntil(document, @"frame field again", @"form", @YES)[@"form"] isEqual:@YES], @"a key typed after the submit sets the form flag again");
    evaluate(view, [NSString stringWithFormat:@"frame.src = 'http://127.0.0.1:%d/frame2'; return true;", framePort]);
    waitForTitle(1, @"frame navigation", @"Form 2");
    check([queryUntil(document, @"frame pagehide", @"form", @NO)[@"form"] isEqual:@NO], @"the pagehide of the frame clears its form flag");
    type(window, view, 300, 20, @"document.activeElement === editable", @"editable");
    check([queryUntil(document, @"editable", @"form", @YES)[@"form"] isEqual:@YES], @"a key typed into a contenteditable element sets the form flag");
    sp_document_load(document, [base stringByAppendingString:@"other"].UTF8String);
    waitForTitle(1, @"navigation", @"Other");
    check([queryUntil(document, @"navigation", @"form", @NO)[@"form"] isEqual:@NO], @"a main frame navigation clears the form flag");

    // The interactionState round trip.
    char *state = sp_document_interaction_state(document);
    check(state && strlen(state) > 0, @"the region returns its interactionState as base64");
    NSString *encoded = state ? [NSString stringWithUTF8String:state] : @"";
    free(state);
    check(sp_document_restore(document, encoded.UTF8String) != NULL
        && strcmp(sp_document_restore(document, encoded.UTF8String), "the document region has already loaded a document") == 0,
        @"a region that has loaded a document refuses a restore");
    void *restored = sp_document_create(surface, store, NULL, NULL, changed, (void *)2);
    if (!restored) failStep(@"restore", @"a second document region is not created");
    sp_document_place(restored, 0, 0, 0, 0, true);
    char *unloaded = sp_document_interaction_state(restored);
    check(unloaded && strlen(unloaded) == 0,
        [NSString stringWithFormat:@"a region that has loaded nothing returns no interactionState (%zu characters)", unloaded ? strlen(unloaded) : 0]);
    free(unloaded);
    const char *notBase64 = sp_document_restore(restored, "%%%");
    check(notBase64 && strcmp(notBase64, "the interactionState is not base64") == 0,
        [NSString stringWithFormat:@"a state that is not base64 is refused (%s)", notBase64 ?: "accepted"]);
    const char *refused = sp_document_restore(restored, "AAAAAAAAAAA=");
    check(refused && strcmp(refused, "the web view refused the interactionState") == 0,
        [NSString stringWithFormat:@"a state that the web view cannot decode is refused (%s)", refused ?: "accepted"]);
    const char *accepted = sp_document_restore(restored, encoded.UTF8String);
    check(accepted == NULL, [NSString stringWithFormat:@"the interactionState of the first region is restored (%s)", accepted ?: "accepted"]);
    waitForTitle(2, @"restored", @"Other");
    check([latest[2][@"canGoBack"] isEqual:@YES] && [latest[2][@"history"] isEqual:latest[1][@"history"]],
        [NSString stringWithFormat:@"the restored region has the history of the first region (%@, first %@)", latest[2][@"history"],
            latest[1][@"history"]]);
    check(!NSApp.isActive, @"the application stays inactive");

    sp_document_close(restored);
    sp_document_close(document);
    sp_surface_close(surface);
    [window close];
    [window release];
    nw_listener_cancel(listener);
    nw_listener_cancel(frameListener);
    [NSFileManager.defaultManager removeItemAtPath:temporary error:nil];
    printf("%s\n", failures ? "FAIL: document_report_test" : "PASS: document_report_test");
    return failures ? 1 : 0;
}}
