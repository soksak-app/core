// Measures how WebKit treats a module import from a page at sok://probe to a module at sok://core (plugin-processes.md
// rule 4). The test scheme handler is its own; it is not production code. Each case serves the module with one
// Access-Control-Allow-Origin value, loads a page that imports the module, and records the page result and the request
// headers that WebKit sends. The assertions state the observed behavior that the core root depends on.
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

// The page posts its result once: {imported: bool, value | error: string}.
static NSDictionary *probeResult;
static NSWindow *window;

static NSString *headerValue(NSDictionary *headers, NSString *name) {
    for (NSString *key in headers) {
        if ([key caseInsensitiveCompare:name] == NSOrderedSame) return headers[key];
    }
    return nil;
}

// The page imports the module with a dynamic import, so a failed import reports to the page instead of stopping
// the module before it posts.
static NSString *const directPage = @"<!doctype html><meta charset=utf-8><title>probe</title>"
    "<script type=module>"
    "const post = (value) => window.webkit.messageHandlers.probe.postMessage(value);"
    "import('sok://core/m.js').then((m) => post({ imported: true, value: m.default }),"
    "(error) => post({ imported: false, error: String(error) }));"
    "</script>";

// The import map maps the bare specifier core-m to the module, and the page imports the bare specifier.
static NSString *const mapPage = @"<!doctype html><meta charset=utf-8><title>probe</title>"
    "<script type=importmap>{\"imports\": {\"core-m\": \"sok://core/m.js\"}}</script>"
    "<script type=module>"
    "const post = (value) => window.webkit.messageHandlers.probe.postMessage(value);"
    "import('core-m').then((m) => post({ imported: true, value: m.default }),"
    "(error) => post({ imported: false, error: String(error) }));"
    "</script>";

@interface ProbeMessageHandler : NSObject <WKScriptMessageHandler>
@end

@implementation ProbeMessageHandler
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    (void)controller;
    [probeResult release];
    probeResult = [(NSDictionary *)message.body retain];
}
@end

// Serves the two pages and the module. Every request is recorded with its URL and all its header fields.
@interface ProbeSchemeHandler : NSObject <WKURLSchemeHandler>
@property (nonatomic, copy) NSString *corsValue;
@property (nonatomic, retain) NSMutableArray<NSDictionary *> *requests;
- (instancetype)initWithCORSValue:(NSString *)value;
@end

@implementation ProbeSchemeHandler
- (instancetype)initWithCORSValue:(NSString *)value {
    self = [super init];
    if (self) {
        _corsValue = [value copy];
        _requests = [NSMutableArray new];
    }
    return self;
}

- (void)dealloc {
    [_corsValue release];
    [_requests release];
    [super dealloc];
}

- (void)webView:(WKWebView *)webView startURLSchemeTask:(id<WKURLSchemeTask>)task {
    (void)webView;
    NSURLRequest *request = task.request;
    NSDictionary *headers = request.allHTTPHeaderFields ?: @{};
    [self.requests addObject:@{ @"url": request.URL.absoluteString, @"headers": headers }];

    NSString *host = request.URL.host;
    NSString *path = request.URL.path;
    NSInteger status = 404;
    NSString *type = @"text/plain";
    NSString *body = @"not found";
    NSMutableDictionary *fields = [NSMutableDictionary dictionary];
    if ([request.URL.scheme isEqualToString:@"sok"] && [host isEqualToString:@"probe"] && [path isEqualToString:@"/index.html"]) {
        status = 200;
        type = @"text/html";
        body = directPage;
    } else if ([request.URL.scheme isEqualToString:@"sok"] && [host isEqualToString:@"probe"] && [path isEqualToString:@"/map.html"]) {
        status = 200;
        type = @"text/html";
        body = mapPage;
    } else if ([request.URL.scheme isEqualToString:@"sok"] && [host isEqualToString:@"core"] && [path isEqualToString:@"/m.js"]) {
        status = 200;
        type = @"text/javascript";
        body = @"export default 42;\n";
        if (self.corsValue) fields[@"Access-Control-Allow-Origin"] = self.corsValue;
    }
    fields[@"Content-Type"] = type;
    NSHTTPURLResponse *response = [[[NSHTTPURLResponse alloc] initWithURL:request.URL statusCode:status
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

// Loads one page in a fresh web view with its own non-persistent data store, so no module response is cached from
// an earlier case. Prints the observed values and returns whether the page reported a successful import.
static BOOL runCase(NSString *label, NSString *corsValue, NSString *page) {
    [probeResult release];
    probeResult = nil;
    ProbeSchemeHandler *scheme = [[[ProbeSchemeHandler alloc] initWithCORSValue:corsValue] autorelease];
    ProbeMessageHandler *messages = [[[ProbeMessageHandler alloc] init] autorelease];
    WKWebViewConfiguration *configuration = [[[WKWebViewConfiguration alloc] init] autorelease];
    configuration.websiteDataStore = [WKWebsiteDataStore nonPersistentDataStore];
    [configuration setURLSchemeHandler:scheme forURLScheme:@"sok"];
    [configuration.userContentController addScriptMessageHandler:messages name:@"probe"];
    WKWebView *web = [[[WKWebView alloc] initWithFrame:window.contentView.bounds configuration:configuration] autorelease];
    [window.contentView addSubview:web];
    [web loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:[@"sok://probe/" stringByAppendingString:page]]]];
    until([NSString stringWithFormat:@"the %@ page posts its result", label], ^BOOL{ return probeResult != nil; });

    NSString *moduleOrigin = nil;
    NSString *moduleHeaders = @"none";
    NSUInteger moduleRequests = 0;
    for (NSDictionary *request in scheme.requests) {
        if (![request[@"url"] isEqualToString:@"sok://core/m.js"]) continue;
        moduleRequests++;
        NSDictionary *headers = request[@"headers"];
        moduleOrigin = headerValue(headers, @"Origin");
        NSMutableArray<NSString *> *pairs = [NSMutableArray new];
        for (NSString *name in headers) [pairs addObject:[NSString stringWithFormat:@"%@: %@", name, headers[name]]];
        moduleHeaders = [pairs componentsJoinedByString:@"; "];
        [pairs release];
    }
    BOOL imported = [probeResult[@"imported"] boolValue];
    NSString *value = probeResult[@"value"] ? [probeResult[@"value"] description] : @"none";
    NSString *error = probeResult[@"error"] ?: @"none";
    printf("OBSERVED %s: page=%s Access-Control-Allow-Origin=%s module-requests=%lu Origin=%s imported=%s value=%s error=%s\n",
        label.UTF8String, page.UTF8String, corsValue ? corsValue.UTF8String : "none", (unsigned long)moduleRequests,
        moduleOrigin ? moduleOrigin.UTF8String : "none", imported ? "YES" : "NO", value.UTF8String, error.UTF8String);
    printf("OBSERVED %s: module request header fields: %s\n", label.UTF8String, moduleHeaders.UTF8String);

    [configuration.userContentController removeScriptMessageHandlerForName:@"probe"];
    [web removeFromSuperview];
    return imported;
}

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

    BOOL allowed = runCase(@"case (a)", @"sok://probe", @"index.html");
    check(allowed, @"case (a): the module from sok://core imports into a page of sok://probe when it sends Access-Control-Allow-Origin: sok://probe");

    BOOL none = runCase(@"case (b)", nil, @"index.html");
    check(!none, @"case (b): the module import fails when the response has no Access-Control-Allow-Origin");

    // Case (c) has no assertion; the value is recorded because the specification states that WebKit accepts it.
    runCase(@"case (c)", @"*", @"index.html");

    BOOL other = runCase(@"case (d)", @"sok://other", @"index.html");
    check(!other, @"case (d): the module import fails when the response names another origin, sok://other");

    BOOL mapped = runCase(@"import map (a)", @"sok://probe", @"map.html");
    check(mapped, @"import map under case (a): the bare specifier core-m maps to sok://core/m.js and imports into a page of sok://probe");

    [probeResult release];
    probeResult = nil;
    [window close];
    if (failures) fprintf(stderr, "%d failures\n", failures);
    return failures ? 1 : 0;
}}
