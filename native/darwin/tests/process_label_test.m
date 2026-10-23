// Measure the URL and OS-reported process fields for path-only and explicit WebKit process display names.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <libproc.h>
#import <stdio.h>
#import <stdlib.h>
#import <string.h>
#import "private/webkit.h"

static int failures;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static BOOL until(BOOL (^done)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:15];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                                 beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
    return done();
}

@interface SPProcessLabelScheme : NSObject <WKURLSchemeHandler>
@end

@implementation SPProcessLabelScheme
- (void)webView:(WKWebView *)webView startURLSchemeTask:(id<WKURLSchemeTask>)task {
    (void)webView;
    NSString *html = [NSString stringWithFormat:@"<!doctype html><meta charset='utf-8'><p>%@</p>", task.request.URL.absoluteString];
    NSData *data = [html dataUsingEncoding:NSUTF8StringEncoding];
    NSHTTPURLResponse *response = [[[NSHTTPURLResponse alloc] initWithURL:task.request.URL statusCode:200
        HTTPVersion:@"HTTP/1.1" headerFields:@{@"Content-Type": @"text/html; charset=utf-8"}] autorelease];
    [task didReceiveResponse:response];
    [task didReceiveData:data];
    [task didFinish];
}
- (void)webView:(WKWebView *)webView stopURLSchemeTask:(id<WKURLSchemeTask>)task {
    (void)webView;
    (void)task;
}
@end

@interface SPProcessLabelNavigation : NSObject <WKNavigationDelegate>
@property BOOL finished;
@property (nonatomic, retain) NSError *failure;
@end

@implementation SPProcessLabelNavigation
- (void)dealloc { [_failure release]; [super dealloc]; }
- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    (void)webView; (void)navigation; self.finished = YES;
}
- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    (void)webView; (void)navigation; self.failure = error; self.finished = YES;
}
- (void)webView:(WKWebView *)webView didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    (void)webView; (void)navigation; self.failure = error; self.finished = YES;
}
@end

static NSString *processListing(pid_t pid) {
    FILE *pipe = popen("/usr/bin/lsappinfo list", "r");
    if (!pipe) return @"lsappinfo unavailable";
    char *line = NULL;
    size_t capacity = 0;
    NSMutableArray<NSString *> *previous = [NSMutableArray array];
    NSMutableString *listing = nil;
    while (getline(&line, &capacity, pipe) >= 0) {
        NSString *current = [NSString stringWithUTF8String:line];
        if ([current containsString:[NSString stringWithFormat:@"pid = %d ", pid]]) {
            listing = [NSMutableString string];
            NSUInteger start = previous.count;
            while (start > 0 && ![previous[start - 1] containsString:@" ASN:"]) start--;
            if (start > 0) start--;
            for (NSUInteger index = start; index < previous.count; index++) [listing appendString:previous[index]];
            [listing appendString:current];
            break;
        }
        [previous addObject:current];
        if (previous.count > 8) [previous removeObjectAtIndex:0];
    }
    free(line);
    int result = pclose(pipe);
    (void)result;
    return listing.length ? listing : @"no LaunchServices process entry";
}

static void measure(NSWindow *window, SPProcessLabelScheme *handler,
    NSString *caseName, NSString *address, NSString *displayName) {
    WKWebViewConfiguration *configuration = [[[WKWebViewConfiguration alloc] init] autorelease];
    [configuration setURLSchemeHandler:handler forURLScheme:@"sok"];
    [configuration setURLSchemeHandler:handler forURLScheme:@"soksak"];
    if (displayName) [configuration _setProcessDisplayName:displayName];
    WKWebView *view = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 640, 240) configuration:configuration] autorelease];
    [window.contentView addSubview:view];
    SPProcessLabelNavigation *navigation = [[[SPProcessLabelNavigation alloc] init] autorelease];
    view.navigationDelegate = navigation;
    [view loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:address]]];
    check(until(^BOOL { return navigation.finished; }), [NSString stringWithFormat:@"%@ navigation finishes", caseName]);
    check(navigation.failure == nil, [NSString stringWithFormat:@"%@ navigation succeeds: %@", caseName, navigation.failure]);
    if (navigation.failure) return;

    __block BOOL evaluated = NO;
    __block NSString *loadedURL = nil;
    [view evaluateJavaScript:@"location.href" completionHandler:^(id result, NSError *error) {
        if ([result isKindOfClass:NSString.class]) loadedURL = [result copy];
        if (error) fprintf(stderr, "FAIL: %s URL evaluation: %s\n", caseName.UTF8String, error.localizedDescription.UTF8String);
        evaluated = YES;
    }];
    check(until(^BOOL { return evaluated; }), [NSString stringWithFormat:@"%@ exposes its loaded URL", caseName]);
    pid_t pid = view._webProcessIdentifier;
    char name[PROC_PIDPATHINFO_MAXSIZE] = {0};
    char path[PROC_PIDPATHINFO_MAXSIZE] = {0};
    int nameLength = proc_name(pid, name, sizeof(name));
    int pathLength = proc_pidpath(pid, path, sizeof(path));
    printf("MEASURE case=%s requested=%s loaded=%s override=%s webContentPid=%d proc_name=%s proc_pidpath=%s\n",
        caseName.UTF8String, address.UTF8String, loadedURL.UTF8String ?: "<unavailable>",
        displayName.UTF8String ?: "<none>", pid, nameLength > 0 ? name : "<unavailable>",
        pathLength > 0 ? path : "<unavailable>");
    printf("LAUNCHSERVICES case=%s %s\n", caseName.UTF8String, processListing(pid).UTF8String);
    fflush(stdout);
    check(loadedURL && [loadedURL isEqualToString:address], [NSString stringWithFormat:@"%@ keeps the requested URL origin", caseName]);
    check(pid > 0, [NSString stringWithFormat:@"%@ has a WebContent process", caseName]);
    [loadedURL release];
    view.navigationDelegate = nil;
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    NSWindow *window = [[[NSWindow alloc] initWithContentRect:NSMakeRect(50, 50, 660, 280)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO] autorelease];
    SPProcessLabelScheme *handler = [[[SPProcessLabelScheme alloc] init] autorelease];
    [window orderBack:nil];

    measure(window, handler, @"legacy-origin", @"sok://terminal/page", nil);
    measure(window, handler, @"requested-path", @"soksak://plugin/terminal", nil);
    measure(window, handler, @"explicit-display-name", @"sok://terminal/page",
        @"soksak://plugin/terminal");

    [window close];
    return failures ? 1 : 0;
} }
