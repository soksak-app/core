// The box query of a document region (docs/spec/native-surfaces.md#box-query). A local site serves a page with three rows at known
// positions, a page with 501 elements, and a page with no element. The check requires that the query returns the border box in
// CSS pixels and the named computed style values of each match in document order, that an empty property list gives an empty
// style, that the 500-match bound reports the total and the truncation, and that a missing page, an empty selector, an invalid
// selector, a property that is not a string, and a property that is not a CSS property are each refused with their error text.
// The check does not activate the application.
#import <Cocoa/Cocoa.h>
#import <Network/Network.h>
#import <WebKit/WebKit.h>
#import <string.h>
#import "support/event_wait.h"
#import "support/temporary_folder.h"
#import "document_view.h"
#import "webview_geometry.h"
#import "window_facts.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// The latest state of the region.
static NSDictionary *latest;

static void changed(void *context, const char *text) {
    (void)context;
    [latest release];
    latest = [[NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:text length:strlen(text)] options:0 error:nil] retain];
}

static NSString *pageFor(NSString *path) {
    if ([path isEqualToString:@"/rows"]) {
        return @"<!doctype html><title>Rows</title><style>body{margin:0}.row{position:absolute;left:10px;width:100px;height:20px;"
            "font-size:13px;color:rgb(1,2,3)}</style>"
            "<div class=row id=a style='top:10px'></div><div class=row id=b style='top:40px'></div>"
            "<div class=row id=c style='top:70px'></div>";
    }
    if ([path isEqualToString:@"/many"]) {
        return @"<!doctype html><title>Many</title><body><script>for (let i = 0; i < 501; i++) document.body.appendChild("
            "document.createElement('i'));document.title = 'Many';</script></body>";
    }
    return nil;
}

// An HTTP server that sends one response per request and closes the connection.
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
            NSArray<NSString *> *parts = [request componentsSeparatedByString:@" "];
            NSString *body = parts.count >= 2 ? pageFor(parts[1]) : nil;
            NSString *status = body ? @"200 OK" : @"404 Not Found";
            body = body ?: @"missing";
            NSData *bytes = [body dataUsingEncoding:NSUTF8StringEncoding];
            NSString *head = [NSString stringWithFormat:@"HTTP/1.1 %@\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: %lu\r\nConnection: close\r\n\r\n",
                status, (unsigned long)bytes.length];
            NSMutableData *response = [NSMutableData dataWithData:[head dataUsingEncoding:NSUTF8StringEncoding]];
            [response appendData:bytes];
            dispatch_data_t out = dispatch_data_create(response.bytes, response.length, dispatch_get_main_queue(), DISPATCH_DATA_DESTRUCTOR_DEFAULT);
            nw_connection_send(connection, out, NW_CONNECTION_FINAL_MESSAGE_CONTEXT, true, ^(nw_error_t sent) {
                nw_connection_cancel(connection);
            });
        });
    });
    __block BOOL ready = NO;
    nw_listener_set_state_changed_handler(server, ^(nw_listener_state_t state, nw_error_t error) {
        if (state == nw_listener_state_ready) ready = YES;
    });
    nw_listener_start(server);
    eventWait(@"the test server starts", ^BOOL { return ready; });
    return server;
}

static void replied(void *context, const char *json) {
    NSDictionary **slot = (NSDictionary **)context;
    *slot = [[NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:json length:strlen(json)] options:0 error:nil] retain];
}

// Queries the boxes of the region and returns the reply, which is an object of the result or of the error.
static NSDictionary *boxes(void *document, NSString *selector, NSString *properties, NSString *step) {
    NSDictionary *reply = nil;
    NSDictionary **slot = &reply;
    sp_document_boxes(document, selector.UTF8String, properties.UTF8String, replied, slot);
    eventWait([NSString stringWithFormat:@"the boxes of %@ reply", step], ^BOOL { return *slot != nil; });
    return [reply autorelease];
}

static void waitForTitle(NSString *title) {
    eventWait([NSString stringWithFormat:@"the region shows %@", title], ^BOOL {
        return [latest[@"title"] isEqual:title] && ![latest[@"loading"] boolValue];
    });
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    // A key typed into a field opens the correction panel of AppKit when automatic spelling correction is on, and this check types
    // no key, so the correction setting is only recorded.
    nw_listener_t listener = serve();
    NSString *base = [NSString stringWithFormat:@"http://127.0.0.1:%d/", nw_listener_get_port(listener)];

    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 500, 400)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 500, 400)] autorelease];
    WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
    [window.contentView addSubview:main];
    [window orderBack:nil];
    void *surface = sp_surface_create(sp_window_set_main_webview(main.window, main));
    if (!surface) { fprintf(stderr, "FAIL: a logical surface is not created\n"); return 1; }
    webviewSetFrame(surface, 0, 0, 500, 400);
    webviewSetSurfaceHidden(surface, false);
    NSString *temporary = temporaryFolder(@"soksak-document-boxes-");
    const char *store = [temporary stringByAppendingPathComponent:@"store"].fileSystemRepresentation;

    // A region that has loaded no page refuses the query.
    void *empty = sp_document_create(surface, store, NULL, NULL, NULL, NULL, false, changed, (void *)2);
    if (!empty) { fprintf(stderr, "FAIL: the empty region is not created\n"); return 1; }
    sp_document_place(empty, 0, 0, 0, 0, true);
    NSDictionary *noPage = boxes(empty, @".row", @"[]", @"an empty region");
    check([noPage[@"error"] isEqual:@"the document region shows no page"], [NSString stringWithFormat:
        @"a region without a page refuses the query (%@)", noPage]);
    sp_document_close(empty);

    void *document = sp_document_create(surface, store, NULL, NULL, NULL, NULL, false, changed, (void *)1);
    if (!document) { fprintf(stderr, "FAIL: the document region is not created\n"); return 1; }
    sp_document_place(document, 0, 0, 0, 0, true);

    sp_document_load(document, [base stringByAppendingString:@"rows"].UTF8String);
    waitForTitle(@"Rows");

    NSDictionary *reply = boxes(document, @".row", @"[\"font-size\",\"color\"]", @"the rows");
    NSArray *list = reply[@"boxes"];
    check([reply[@"total"] isEqual:@3] && [reply[@"truncated"] isEqual:@NO] && list.count == 3, [NSString stringWithFormat:
        @"the three matches are counted and not truncated (%@)", reply]);
    if (list.count == 3) {
        NSDictionary *first = list[0];
        check([first[@"x"] doubleValue] == 10 && [first[@"y"] doubleValue] == 10 && [first[@"width"] doubleValue] == 100
            && [first[@"height"] doubleValue] == 20, [NSString stringWithFormat:@"the first match has its border box (%@)", first]);
        check([first[@"style"][@"font-size"] isEqual:@"13px"] && [first[@"style"][@"color"] isEqual:@"rgb(1, 2, 3)"],
            [NSString stringWithFormat:@"the first match has its computed style values (%@)", first[@"style"]]);
        check([list[1][@"y"] doubleValue] == 40 && [list[2][@"y"] doubleValue] == 70,
            @"the matches are in document order");
    }

    NSDictionary *none = boxes(document, @".row", @"[]", @"no properties");
    check([none[@"boxes"] count] == 3 && [[none[@"boxes"] firstObject][@"style"] count] == 0,
        [NSString stringWithFormat:@"an empty property list gives an empty style (%@)", none]);

    NSDictionary *invalid = boxes(document, @"[", @"[]", @"an invalid selector");
    check([[invalid[@"error"] description] hasPrefix:@"invalid selector [: "],
        [NSString stringWithFormat:@"an invalid selector is refused with its text (%@)", invalid]);
    NSDictionary *blank = boxes(document, @"", @"[]", @"an empty selector");
    check([blank[@"error"] isEqual:@"selector must not be empty"], [NSString stringWithFormat:
        @"an empty selector is refused (%@)", blank]);
    NSDictionary *misspelled = boxes(document, @".row", @"[\"font-siz\"]", @"a misspelled property");
    check([misspelled[@"error"] isEqual:@"unknown style property font-siz"], [NSString stringWithFormat:
        @"a property that is not a CSS property is refused (%@)", misspelled]);
    NSDictionary *custom = boxes(document, @".row", @"[\"--size\"]", @"a custom property");
    check([custom[@"error"] isEqual:@"unknown style property --size"], [NSString stringWithFormat:
        @"a custom property is refused (%@)", custom]);
    NSDictionary *number = boxes(document, @".row", @"[1]", @"a property that is a number");
    check([number[@"error"] isEqual:@"property must be a string"], [NSString stringWithFormat:
        @"a property that is not a string is refused (%@)", number]);

    sp_document_load(document, [base stringByAppendingString:@"many"].UTF8String);
    waitForTitle(@"Many");
    NSDictionary *many = boxes(document, @"i", @"[]", @"the many elements");
    check([many[@"total"] isEqual:@501] && [many[@"truncated"] isEqual:@YES] && [many[@"boxes"] count] == 500, [NSString stringWithFormat:
        @"more than 500 matches are reported with the total and the truncation (%@ of boxes %lu)", many[@"total"],
        (unsigned long)[many[@"boxes"] count]]);

    sp_document_close(document);
    sp_surface_close(surface);
    [window close];
    [window release];
    nw_listener_cancel(listener);
    printf("%s\n", failures ? "FAIL: document_boxes_test" : "PASS: document_boxes_test");
    return failures ? 1 : 0;
}}
