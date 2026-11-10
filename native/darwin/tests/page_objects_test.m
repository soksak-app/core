// Checks the element and document counts that sp_webview_count_objects evaluates in a web view: the main page
// world and the document world of a document region. A count follows the DOM when an element or a frame is added and
// removed.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "webview_geometry.h"
#import "support/records.h"
#import "support/event_wait.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static id evaluate(WKWebView *view, NSString *script) {
    __block BOOL done = NO;
    __block id result = nil;
    [view evaluateJavaScript:script completionHandler:^(id value, NSError *error) {
        result = [value retain];
        done = YES;
    }];
    eventWait(@"the JavaScript evaluation answers", ^BOOL { return done; });
    return [result autorelease];
}

// The answer of one count request.
typedef struct {
    BOOL answered;
    BOOL ok;
    long elements;
    long documents;
} Answer;

static void counted(void *context, long elements, long documents, const char *error) {
    Answer *answer = context;
    answer->answered = YES;
    answer->ok = error == NULL;
    answer->elements = elements;
    answer->documents = documents;
}

static Answer count(WKWebView *view, bool document) {
    __block Answer answer = {NO, NO, -1, -1};
    sp_webview_count_objects(view, document, counted, &answer);
    eventWait(@"the object count answers", ^BOOL { return answer.answered; });
    return answer;
}

static WKWebView *load(NSView *content, NSString *html) {
    WKWebView *view = [[[WKWebView alloc] initWithFrame:content.bounds] autorelease];
    [content addSubview:view];
    [view loadHTMLString:html baseURL:[NSURL URLWithString:@"http://127.0.0.1/"]];
    // The blank page that the view shows before the load has no title, so the title of the loaded page names the new document,
    // and the end of loading after it is the end of the load of that document. The view changes both properties on the main
    // thread when the web process reports the change.
    eventWait(@"the navigation of the page finishes", ^BOOL {
        return [view.title isEqualToString:@"loaded"] && !view.isLoading;
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

    // contract: diagnostics.objects.counts-documents
    // The page world counts the elements and documents of the page alone: a parked element function of the page is not read.
    evaluate(view, @"window.__soksakParkedElements = () => { throw new Error('the parked count is removed'); }; true");
    Answer page = count(view, false);
    check(page.ok && page.elements == 7 && page.documents == 2,
        [NSString stringWithFormat:@"the page world counts 7 elements and 2 documents without reading a parked count (ok %d, elements %ld, documents %ld)",
            page.ok, page.elements, page.documents]);

    // contract: diagnostics.objects.counts-documents
    Answer region = count(view, true);
    check(region.ok && region.elements == 7 && region.documents == 2,
        [NSString stringWithFormat:@"the document world counts the same page (ok %d, elements %ld, documents %ld)",
            region.ok, region.elements, region.documents]);

    // contract: diagnostics.objects.counts-documents
    evaluate(view, @"document.querySelector('iframe').remove(); document.body.appendChild(document.createElement('i'));");
    Answer changed = count(view, false);
    check(changed.ok && changed.elements == 7 && changed.documents == 1,
        [NSString stringWithFormat:@"after the frame is removed and an element added the page counts 7 elements and 1 document (ok %d, elements %ld, documents %ld)",
            changed.ok, changed.elements, changed.documents]);

    // contract: diagnostics.objects.counts-documents
    // A surface draws in the open shadow root of its host, so the elements of open shadow roots, nested ones too, are counted.
    evaluate(view, @"const outer = document.body.appendChild(document.createElement('div')).attachShadow({mode: 'open'});"
        "outer.append(document.createElement('span'), document.createElement('span'));"
        "outer.firstChild.attachShadow({mode: 'open'}).append(document.createElement('b')); true");
    Answer shadow = count(view, false);
    check(shadow.ok && shadow.elements == 11,
        [NSString stringWithFormat:@"a host with an open shadow root of two elements, one holding a nested root of one element, adds 4 elements to 7 (ok %d, elements %ld)",
            shadow.ok, shadow.elements]);
    Answer shadowRegion = count(view, true);
    check(shadowRegion.ok && shadowRegion.elements == 11,
        [NSString stringWithFormat:@"the document world counts the same shadow root elements (ok %d, elements %ld)", shadowRegion.ok, shadowRegion.elements]);

    [window close];
    if (failures) { fprintf(stderr, "%d check(s) failed\n", failures); return 1; }
    printf("PASS: page_objects_test\n");
} return 0; }
