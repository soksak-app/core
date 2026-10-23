// Measures how WebKit resolves a bare specifier when the import map is inserted directly after the doctype of a view page
// and the page module is in body (plugin-processes.md rule 4, F212.12-1-10-6). The page has no import map of its own. The
// test scheme handler is its own; it is not production code. The page is the served form that the host produces: the
// doctype, the import map, then the rest of the document. The assertion states the observed behavior that the host
// insertion depends on.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

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

static NSDictionary *probeResult;
static NSWindow *window;

// The served page: the doctype, the import map that the host inserts after the doctype, then the document with its module in
// body. The module imports the bare specifier core-m, which the map names.
static NSString *const insertedPage = @"<!doctype html>"
    "<script type=importmap>{\"imports\": {\"core-m\": \"soksak://core/m.js\"}}</script>"
    "<html><head><meta charset=utf-8><title>probe</title></head><body>"
    "<script type=module>"
    "const post = (value) => window.webkit.messageHandlers.probe.postMessage(value);"
    "import('core-m').then((m) => post({ imported: true, value: m.default }),"
    "(error) => post({ imported: false, error: String(error) }));"
    "</script></body></html>";

@interface ProbeMessageHandler : NSObject <WKScriptMessageHandler>
@end

@implementation ProbeMessageHandler
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    (void)controller;
    [probeResult release];
    probeResult = [(NSDictionary *)message.body retain];
}
@end

@interface InsertedMapSchemeHandler : NSObject <WKURLSchemeHandler>
@end

@implementation InsertedMapSchemeHandler
- (void)webView:(WKWebView *)webView startURLSchemeTask:(id<WKURLSchemeTask>)task {
    (void)webView;
    NSURL *url = task.request.URL;
    NSInteger status = 404;
    NSString *type = @"text/plain";
    NSString *body = @"not found";
    NSMutableDictionary *fields = [NSMutableDictionary dictionary];
    if ([url.scheme isEqualToString:@"soksak"] && [url.host isEqualToString:@"probe"] && [url.path isEqualToString:@"/index.html"]) {
        status = 200;
        type = @"text/html";
        body = insertedPage;
    } else if ([url.scheme isEqualToString:@"soksak"] && [url.host isEqualToString:@"core"] && [url.path isEqualToString:@"/m.js"]) {
        status = 200;
        type = @"text/javascript";
        body = @"export default 42;\n";
        fields[@"Access-Control-Allow-Origin"] = @"soksak://probe";
    }
    fields[@"Content-Type"] = type;
    NSHTTPURLResponse *response = [[[NSHTTPURLResponse alloc] initWithURL:url statusCode:status
        HTTPVersion:@"HTTP/1.1" headerFields:fields] autorelease];
    [task didReceiveResponse:response];
    [task didReceiveData:[body dataUsingEncoding:NSUTF8StringEncoding]];
    [task didFinish];
}

- (void)webView:(WKWebView *)webView stopURLSchemeTask:(id<WKURLSchemeTask>)task {
    (void)webView;
    (void)task;
}
@end

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 500, 400)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 500, 400)] autorelease];
    [window orderBack:nil];

    InsertedMapSchemeHandler *scheme = [[[InsertedMapSchemeHandler alloc] init] autorelease];
    ProbeMessageHandler *messages = [[[ProbeMessageHandler alloc] init] autorelease];
    WKWebViewConfiguration *configuration = [[[WKWebViewConfiguration alloc] init] autorelease];
    configuration.websiteDataStore = [WKWebsiteDataStore nonPersistentDataStore];
    [configuration setURLSchemeHandler:scheme forURLScheme:@"soksak"];
    [configuration.userContentController addScriptMessageHandler:messages name:@"probe"];
    WKWebView *web = [[[WKWebView alloc] initWithFrame:window.contentView.bounds configuration:configuration] autorelease];
    [window.contentView addSubview:web];
    [web loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:@"soksak://probe/index.html"]]];
    until(@"the inserted-map page posts its result", ^BOOL{ return probeResult != nil; });

    BOOL imported = [probeResult[@"imported"] boolValue];
    NSString *value = probeResult[@"value"] ? [probeResult[@"value"] description] : @"none";
    NSString *error = probeResult[@"error"] ?: @"none";
    printf("OBSERVED inserted map: imported=%s value=%s error=%s\n", imported ? "YES" : "NO", value.UTF8String, error.UTF8String);
    check(imported && [value isEqualToString:@"42"],
        @"inserted map after the doctype: the bare specifier core-m resolves through the map to soksak://core/m.js and yields 42");

    [configuration.userContentController removeScriptMessageHandlerForName:@"probe"];
    [web removeFromSuperview];
    [probeResult release];
    probeResult = nil;
    [window close];
    if (failures) fprintf(stderr, "%d failures\n", failures);
    return failures ? 1 : 0;
}}
