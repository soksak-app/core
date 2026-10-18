// Checks the element and document counts that sp_webview_count_objects evaluates in a web view: the main page
// world and the document world of a document region. A count follows the DOM when an element or a frame is added and
// removed. The page world also counts the parked surface hosts through the function of the page.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "webview_geometry.h"
#import "support/records.h"

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

// The answer of one count request.
typedef struct {
    BOOL answered;
    BOOL ok;
    long elements;
    long documents;
    long parked;
} Answer;

static void counted(void *context, long elements, long documents, long parked, const char *error) {
    Answer *answer = context;
    answer->answered = YES;
    answer->ok = error == NULL;
    answer->elements = elements;
    answer->documents = documents;
    answer->parked = parked;
}

static Answer count(WKWebView *view, bool document) {
    __block Answer answer = {NO, NO, -1, -1, -1};
    sp_webview_count_objects(view, document, counted, &answer);
    until(@"the count did not answer", ^BOOL { return answer.answered; });
    return answer;
}

static WKWebView *load(NSView *content, NSString *html) {
    WKWebView *view = [[[WKWebView alloc] initWithFrame:content.bounds] autorelease];
    [content addSubview:view];
    [view loadHTMLString:html baseURL:[NSURL URLWithString:@"http://127.0.0.1/"]];
    // The blank page that the view shows before the load has readyState complete, so the wait is for the title of the loaded page.
    until(@"the page did not finish loading", ^BOOL {
        return [[evaluate(view, @"document.title") description] isEqualToString:@"loaded"];
    });
    return view;
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 500, 400)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 500, 400)] autorelease];
    [window orderBack:nil];

    // The page has html, head, title, body, two paragraphs and one iframe: seven elements, and the page with its frame is two documents.
    WKWebView *view = load(window.contentView,
        @"<!doctype html><title>loaded</title><body><p>a</p><p>b</p><iframe srcdoc='<p>frame</p>'></iframe></body>");

    // contract: diagnostics.objects.counts-parked-elements
    Answer missing = count(view, false);
    check(missing.answered && !missing.ok, @"a page without the parked element function answers an error");
    evaluate(view, @"window.__soksakParkedElements = () => 4; true");

    // contract: diagnostics.objects.counts-documents
    // contract: diagnostics.objects.counts-parked-elements
    Answer page = count(view, false);
    check(page.ok && page.elements == 7 && page.documents == 2 && page.parked == 4,
        [NSString stringWithFormat:@"the page world counts 7 elements, 2 documents and 4 parked elements (ok %d, elements %ld, documents %ld, parked %ld)",
            page.ok, page.elements, page.documents, page.parked]);

    // contract: diagnostics.objects.counts-documents
    Answer region = count(view, true);
    check(region.ok && region.elements == 7 && region.documents == 2 && region.parked == 0,
        [NSString stringWithFormat:@"the document world counts the same page (ok %d, elements %ld, documents %ld)",
            region.ok, region.elements, region.documents]);

    // contract: diagnostics.objects.counts-documents
    evaluate(view, @"document.querySelector('iframe').remove(); document.body.appendChild(document.createElement('i'));");
    Answer changed = count(view, false);
    check(changed.ok && changed.elements == 7 && changed.documents == 1,
        [NSString stringWithFormat:@"after the frame is removed and an element added the page counts 7 elements and 1 document (ok %d, elements %ld, documents %ld)",
            changed.ok, changed.elements, changed.documents]);

    [window close];
    if (failures) { fprintf(stderr, "%d check(s) failed\n", failures); return 1; }
    printf("PASS: page_objects_test\n");
} return 0; }
