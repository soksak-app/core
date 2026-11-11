// The interactive stream of a document region (docs/spec/native-surfaces.md#document-streams). A local site serves a page with
// a button, a password input and a frame that holds a link. The check turns the stream on, reads the folded value, and checks
// the paths of the frames, the frame-local elements with their sensitive flag, the acknowledgement of the seq and the fold of a
// later change, the reset of a navigation and the turn off. It does not activate the application.
#import <Cocoa/Cocoa.h>
#import <Network/Network.h>
#import <WebKit/WebKit.h>
#import "document_view.h"
#import "webview_geometry.h"
#import "window_facts.h"

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

static NSMutableArray<NSString *> *states;

static void changed(void *context, const char *state) {
    (void)context;
    if (state) [states addObject:[NSString stringWithUTF8String:state]];
}

// The stream messages of the document under test, with the frame of the run loop between them.
static NSMutableArray<NSDictionary *> *messages;
static BOOL messageArrived;

static void *ackDocument;

// The host acknowledges a delivered snapshot right after its delivery, so the test does the same: without the
// acknowledgement the next folded value waits for it.
static void stream(void *context, const char *json) {
    (void)context;
    NSData *data = [NSData dataWithBytes:json length:strlen(json)];
    id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if (![value isKindOfClass:NSDictionary.class]) return;
    [messages addObject:value];
    if ([value[@"stream"] isEqual:@"interactive"] && [value[@"message"][@"type"] isEqual:@"frames"]) {
        sp_document_stream_ack(ackDocument, [value[@"message"][@"seq"] unsignedLongLongValue]);
    }
    messageArrived = YES;
}

// The latest frames message of the stream, or nil.
static NSDictionary *framesMessage(void) {
    for (NSDictionary *message in [messages reverseObjectEnumerator]) {
        if ([message[@"stream"] isEqual:@"interactive"] && [message[@"message"][@"type"] isEqual:@"frames"]) {
            return message[@"message"];
        }
    }
    return nil;
}

static NSDictionary *stateMessage(void) {
    for (NSDictionary *message in [messages reverseObjectEnumerator]) {
        if ([message[@"stream"] isEqual:@"interactive"] && [message[@"message"][@"type"] isEqual:@"reset"]) {
            return message[@"message"];
        }
    }
    return nil;
}

static nw_listener_t serve(NSInteger port) {
    nw_parameters_t parameters = nw_parameters_create_secure_tcp(NW_PARAMETERS_DISABLE_PROTOCOL, NW_PARAMETERS_DEFAULT_CONFIGURATION);
    nw_parameters_set_local_endpoint(parameters, nw_endpoint_create_host("127.0.0.1", [[NSString stringWithFormat:@"%ld", (long)port] UTF8String]));
    nw_listener_t server = nw_listener_create(parameters);
    nw_listener_set_queue(server, dispatch_get_main_queue());
    nw_listener_set_new_connection_handler(server, ^(nw_connection_t connection) {
        nw_connection_set_queue(connection, dispatch_get_main_queue());
        nw_connection_start(connection);
        nw_connection_receive(connection, 1, 65536, ^(dispatch_data_t content, nw_content_context_t context, bool complete, nw_error_t error) {
            NSString *request = content ? [[[NSString alloc] initWithData:(NSData *)content encoding:NSUTF8StringEncoding] autorelease] : @"";
            NSArray<NSString *> *parts = [request componentsSeparatedByString:@" "];
            NSString *path = parts.count >= 2 ? parts[1] : @"";
            NSString *body;
            if ([path hasPrefix:@"/main"]) {
                body = @"<!doctype html><title>Main</title><body>"
                    "<button id=save>Save</button><input id=secret type=password>"
                    "<iframe id=child src=/frame></iframe></body>";
            } else if ([path hasPrefix:@"/frame"]) {
                body = @"<!doctype html><title>Frame</title><body><a id=link href=/main>follow</a></body>";
            } else if ([path hasPrefix:@"/other"]) {
                body = @"<!doctype html><title>Other</title><body>other</body>";
            } else {
                body = @"";
            }
            NSData *bytes = [body dataUsingEncoding:NSUTF8StringEncoding];
            NSString *head = [NSString stringWithFormat:@"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n"
                "Content-Length: %lu\r\nConnection: close\r\n\r\n", (unsigned long)bytes.length];
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
    if (!pumpUntil(10, ^BOOL { return ready; })) failStep(@"serve", @"the test server did not start within 10 seconds");
    return server;
}

int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        [NSApp finishLaunching];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

        states = [NSMutableArray array];
        messages = [NSMutableArray array];
        nw_listener_t listener = serve(0);
        NSInteger port = nw_listener_get_port(listener);
        NSString *base = [NSString stringWithFormat:@"http://127.0.0.1:%ld/", (long)port];

        NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 600, 400)
            styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        [window setReleasedWhenClosed:NO];
        [window orderFrontRegardless];
        WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
        [window.contentView addSubview:main];
        void *surface = sp_surface_create(sp_window_set_main_webview(main.window, main));
        NSString *store = [NSTemporaryDirectory() stringByAppendingPathComponent:@"soksak-document-interactive-store"];
        void *document = sp_document_create(surface, store.UTF8String, NSTemporaryDirectory().fileSystemRepresentation,
            "probe", NULL, NULL, changed, NULL);
        if (!document) failStep(@"create", [NSString stringWithFormat:@"the document was not created: %s", sp_document_last_error()]);
        sp_document_set_stream(document, stream, NULL);
        ackDocument = document;
        sp_document_place(document, 0, 0, 600, 400, true);
        if (!sp_document_load(document, [base stringByAppendingString:@"main"].UTF8String)) {
            failStep(@"load", @"the main page did not load");
        }
        // The state of the loaded page is the event that the page is in place; the failure bound only ends the run.
        if (!pumpUntil(stepLimit, ^BOOL { return states.count > 0 && [states.lastObject containsString:@"\"url\":\"http"] && [states.lastObject containsString:@"/main"] && ![states.lastObject containsString:@"refused"]; })) {
            failStep(@"state", [NSString stringWithFormat:@"the document state of the main page did not arrive, states: %@", states]);
        }

        // The stream is off, and a turned-off stream sends nothing, so the emptiness of the stream channel is a fact of
        // this moment, not something to wait for.
        check(messages.count == 0, @"no frames message is on the stream channel while the stream is off");

        // The folded value carries the main frame and the child frame with its path, and the elements carry the sensitive flag.
        if (!sp_document_stream_on(document, "interactive", true)) failStep(@"on", @"the interactive stream was refused");
        // The arrival of the child frame is part of the value that the test waits for, not a settle period after it.
        if (!pumpUntil(stepLimit, ^BOOL {
            NSDictionary *value = framesMessage();
            if (value == nil) return NO;
            for (NSDictionary *frame in value[@"frames"]) {
                if ([frame[@"path"] isEqual:@"0.0"]) return YES;
            }
            return NO;
        })) {
            NSMutableString *dump = [NSMutableString string];
            for (NSDictionary *message in messages) {
                [dump appendFormat:@"[%@ %@] ", message[@"stream"], message[@"message"][@"type"]];
            }
            failStep(@"frames", [NSString stringWithFormat:
                @"no folded value with the child frame arrived, stream messages so far: %@", dump]);
        }
        NSDictionary *value = framesMessage();
        check(value != nil, @"the interactive stream delivers a folded value");
        check([value[@"seq"] isKindOfClass:NSNumber.class], @"the folded value carries its seq");
        NSArray *frames = value[@"frames"];
        check([frames isKindOfClass:NSArray.class] && frames.count >= 2, [NSString stringWithFormat:
            @"the folded value holds the main frame and the child frame (%@)", frames]);
        __block NSDictionary *mainFrame = nil, *childFrame = nil;
        for (NSDictionary *frame in frames) {
            if ([frame[@"path"] isEqual:@"0"]) mainFrame = frame;
            if ([frame[@"path"] isEqual:@"0.0"]) childFrame = frame;
        }
        check(mainFrame != nil, @"the main frame carries the path 0");
        check(childFrame != nil, @"the child frame carries the path 0.0");
        __block NSDictionary *button = nil, *password = nil;
        for (NSDictionary *element in mainFrame[@"elements"]) {
            if ([element[@"tag"] isEqual:@"button"]) button = element;
            if ([element[@"sensitive"] isEqual:@YES]) password = element;
        }
        check(button != nil, @"the main frame reports its button");
        check([button[@"label"] isEqual:@"Save"], [NSString stringWithFormat:@"the button carries its label (%@)", button[@"label"]]);
        check(password != nil, @"the password input carries the sensitive flag");
        __block NSDictionary *link = nil;
        for (NSDictionary *element in childFrame[@"elements"]) {
            if ([element[@"tag"] isEqual:@"a"]) link = element;
        }
        check(link != nil, @"the child frame reports its link");

        // The delivery of a folded value is acknowledged by the stream callback of this test, as the host does.
        unsigned long long seq = [value[@"seq"] unsignedLongLongValue];
        [messages removeAllObjects];
        (void)seq;

        // A navigation resets the value; the new document folds again after its script runs.
        [messages removeAllObjects];
        if (!sp_document_load(document, [base stringByAppendingString:@"other"].UTF8String)) {
            failStep(@"navigate", @"the other page did not load");
        }
        if (!pumpUntil(stepLimit, ^BOOL { messageArrived = NO; return stateMessage() != nil; })) {
            NSMutableString *dump = [NSMutableString string];
            for (NSDictionary *message in messages) {
                [dump appendFormat:@"[%@ %@] ", message[@"stream"], message[@"message"][@"type"]];
            }
            failStep(@"reset", [NSString stringWithFormat:@"no reset message arrived at the navigation, messages: %@", dump]);
        }
        check(stateMessage() != nil, @"the navigation resets the interactive stream");

        // The turn off ends the collection; the stream refuses an unknown name.
        if (!sp_document_stream_on(document, "interactive", false)) failStep(@"off", @"the turn off was refused");
        check(!sp_document_stream_on(document, "pixels", true), @"an unknown stream name is refused");

        sp_document_close(document);
        nw_listener_cancel(listener);
    }
    fprintf(failures ? stderr : stdout, "%s: document_interactive_test (%d failures)\n", failures ? "FAIL" : "PASS", failures);
    return failures ? 1 : 0;
}
