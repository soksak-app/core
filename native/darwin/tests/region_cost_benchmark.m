// The cost of a document region (docs/spec/native-surfaces.md#document-regions) against a plain web view. One address loads in
// each variant in a new view in a 1200×760 window with a 1180×400 region at the same frame:
//   P  a plain web view with a nonpersistent data store;
//   Q  a plain web view with a persistent data store in a temp directory, as the hosts use (also the persistent store of T6);
//   R  a document region from sp_document_create with no stream subscribed;
//   S  R with the element and request streams subscribed, and each element snapshot acknowledged;
//   T1 P with applicationNameForUserAgent set as the region sets it;
//   T2 P with the three content-world user scripts and their message handlers as the region installs them;
//   T3 P with a sok scheme handler;
//   T4 P with view.appearance set to the effective appearance of the content view;
//   T5 P with pageZoom set to 1;
//   T7 P with the device scale override set to the backing scale of the window;
//   U  P with applicationNameForUserAgent as the region sets it (the same setting as T1), the baseline of the difference rows,
//      because the Safari user agent makes google.com serve its full page instead of the legacy page that P receives;
//   V1 U with the TemporaryTileCohortRetentionEnabled feature off (the tile cohorts of an earlier scale are not kept);
//   V2 U with the SupportHDRDisplayEnabled feature off (the layers do not take an extended range contents format);
//   V3 U with both features off;
//   W  U with the cache model of the engine set to DocumentBrowser instead of the default PrimaryWebBrowser (a smaller
//      memory cache: 96 MB instead of 128 MB, dead resources 12 to 24 MB instead of 32 to 64 MB, and no deletion of the
//      decoded data of dead resources after 60 seconds; the back-forward cache keeps 2 pages in both). The cache model is
//      one setting of the UI process for all process pools, so the benchmark sets it before the view of W and sets it back
//      to PrimaryWebBrowser after the view of W closes.
// --variants NAME,NAME measures only the named variants, in the order of the table.
// Each T variant differs from P by one setting. For each variant the benchmark reads the physical footprint of the WebContent
// process of the view 10 seconds and 60 seconds after the load finished: the total (ri_phys_footprint), the dirty and
// reclaimable bytes of WebKit malloc, and the dirty bytes of the graphics and JS JIT rows of footprint. After the 60 second
// read it prints the page facts (user agent, document length, resource count) and the layer and frame facts of the view.
// R and U also print the footprint and vmmap rows of the graphics, IOSurface, CoreAnimation and malloc allocations.
// The benchmark prints the numbers and asserts nothing. It ends each view and its WebContent process before the next variant.
//
// The long mode (--long MINUTES) measures only U and S, at the same time, each in its own window. Both windows are ordered
// front on the visible screen without activating the application. Each minute after both loads, it prints the footprint of
// the WebContent process of each variant: the total, the dirty bytes of the MALLOC categories, the dirty bytes of the
// WebKit malloc category, and the dirty bytes of the graphics and JS JIT rows. At the end it prints the least-squares slope
// of the total in megabytes per minute over the minutes 5 to MINUTES for each variant and the difference of the two slopes.
//
// The reload mode (--reload COUNT) measures U and then S, or the variants of --variants in the order of the table, each in
// the window of the table. After the first load and after
// COUNT reloads (each a navigation to the same address that starts 15 seconds after the previous load finished and is waited
// for), it prints the footprint total, the MALLOC_SMALL and WebKit malloc dirty bytes of the WebContent process, the time of
// the first load and the mean time of the reloads (from the load request to the end of loading), and the heap counts of
// WebCore::Text, WebCore::HTMLDocument, WebCore::CSSFontAccessor and NSCTFont. A count that grows with the
// reloads in one variant and not in the other shows earlier documents that the variant keeps. Then it sets the simulated
// memory pressure level of the system to warn (sudo -n memory_pressure -S -l warn), or to the level of --pressure LEVEL
// (warn or critical), back to normal 10 seconds later, and
// reads the process again 5 seconds after that, which shows whether memory pressure releases the kept documents.
//
// The collection mode (--collection MINUTES) measures U, R and S at the same time, each in its own window. The windows are
// ordered front on the visible screen without activating the application, spread so that a part of each is visible, so each
// page is visible and its window is not active; the mode fails when a window is occluded. Every 2 minutes after the loads it prints the load averages of the system
// and, for each variant, the footprint total, the WebKit malloc dirty bytes, and the heap counts of WebCore::Text,
// WebCore::HTMLDocument and the sum of the classes whose name starts with JSC::. After the last read it sets the
// simulated memory pressure level to warn, back to normal 10 seconds later, and reads again 5 seconds after that; memory
// pressure runs a full collection, so a growth that the read after it removes was garbage awaiting collection and a
// growth that stays is kept by the page.
//

// The three scripts and the names of the content world and the messages are copied from src/document_view.m, because the
// source keeps them as static strings and the benchmark does not change the source. A difference between the two copies is
// a defect of this benchmark.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <libproc.h>
#import <sys/sysctl.h>
#import <signal.h>
#import <errno.h>
#import <string.h>
#import <stdlib.h>
#import <sys/types.h>
#import "support/temporary_folder.h"
#import "document_view.h"
#import "private/webkit.h"
#import "webview_geometry.h"

static const CGFloat kWindowWidth = 1200;
static const CGFloat kWindowHeight = 760;
// The region of every variant: the margins (left, top, right, bottom) in CSS pixels of the surface viewport and the size of
// the region in window pixels. The plain web views use the same frame.
static const double kMarginLeft = 10;
static const double kMarginTop = 10;
static const double kMarginRight = 10;
static const double kMarginBottom = 350;
static const CGFloat kRegionWidth = 1180;
static const CGFloat kRegionHeight = 400;
// Waits at most this many seconds for each step (AGENTS: a step that cannot finish is reported with its measured state).
static const NSTimeInterval stepLimit = 120;
// The page settles for this long after the load finishes, before the first read.
static const NSTimeInterval settleSeconds = 2;
// The reads of each view, in seconds after the load finished.
static const NSTimeInterval readSeconds[] = { 10, 60 };
enum { kReads = 2, kMegabyte = 1048576 };

// The scripts and the names of src/document_view.m (copied; see the comment at the top).
static NSString *const kDocumentWorld = @"soksak-document";
static NSString *const kScrollMessage = @"soksakDocumentScroll";
static NSString *const kMessageMessage = @"soksakDocumentMessage";
static NSString *const kPageMessage = @"soksakDocumentPage";
static NSString *const kScrollScript = @"(() => {"
    "const post = () => window.webkit.messageHandlers.soksakDocumentScroll.postMessage("
    "{ x: window.scrollX, y: window.scrollY });"
    "addEventListener('scroll', post, { capture: true, passive: true });"
    "addEventListener('load', post);"
    "post();"
    "})();";
static NSString *const kMessageScript = @"(() => {"
    "if (location.protocol !== 'soksak:') return;"
    "addEventListener('message', (event) => {"
    "if (event.source !== window) return;"
    "let text;"
    "try { text = JSON.stringify(event.data); } catch (error) { text = undefined; }"
    "window.webkit.messageHandlers.soksakDocumentMessage.postMessage("
    "text === undefined ? { error: 'the message data is not JSON' } : { message: text });"
    "});"
    "})();";
static NSString *const kPageScript = @"(() => {"
    "const post = (value) => window.webkit.messageHandlers.soksakDocumentPage.postMessage(value);"
    "let elements = false; let marked = false;"
    "const tree = new MutationObserver(() => { if (marked) return; marked = true; post({ changed: true }); });"
    "globalThis.soksakSnapshot = () => {"
    "  marked = false; const nodes = []; let total = 0;"
    "  const walk = (element, depth) => {"
    "    total++;"
    "    if (nodes.length < 500) nodes.push({ depth, tag: element.localName, id: element.getAttribute('id') ?? '',"
    "      class: element.getAttribute('class') ?? '' });"
    "    for (const child of element.children) walk(child, depth + 1);"
    "  };"
    "  if (document.documentElement) walk(document.documentElement, 0);"
    "  return { nodes, total, truncated: total > 500 };"
    "};"
    "let resources = null;"
    "const entry = (item) => ({ url: item.name, type: item.entryType === 'navigation' ? 'navigation' : (item.initiatorType || 'other'),"
    "  start: item.startTime, duration: item.duration });"
    "globalThis.soksakStream = (name, on) => {"
    "  if (name === 'elements') {"
    "    if (on === elements) return null;"
    "    elements = on;"
    "    if (on) { tree.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['id', 'class'] });"
    "      marked = true; post({ changed: true }); }"
    "    else { tree.disconnect(); marked = false; }"
    "    return null;"
    "  }"
    "  if (name === 'requests') {"
    "    if (on === (resources !== null)) return null;"
    "    if (on) {"
    "      post({ entries: performance.getEntriesByType('navigation').map(entry) });"
    "      resources = new PerformanceObserver((list) => post({ entries: list.getEntries().map(entry) }));"
    "      resources.observe({ type: 'resource', buffered: true });"
    "    } else { resources.disconnect(); resources = null; }"
    "    return null;"
    "  }"
    "  throw new Error(`unknown stream ${name}`);"
    "};"
    "let link = null;"
    "const point = (target) => {"
    "  const anchor = target instanceof Element ? target.closest('a[href]') : null;"
    "  const next = anchor ? anchor.href : null;"
    "  if (next !== link) { link = next; post({ link: link ?? '' }); }"
    "};"
    "addEventListener('mouseover', (event) => point(event.target), true);"
    "addEventListener('mouseout', (event) => { if (!event.relatedTarget) point(null); }, true);"
    "addEventListener('pagehide', () => point(null));"
    "addEventListener('pageshow', (event) => { if (event.persisted) post({ ready: true }); });"
    "post({ ready: true });"
    "})();";

// The variants in the order of the table. A plain variant has none of the region fields set; the region fields select the
// document region or the stream subscription.
typedef struct {
    const char *name;
    const char *label;
    BOOL region;         // sp_document_create, as the browser plugin gets it
    BOOL persistent;     // a persistent data store in the temp directory
    BOOL streams;        // the element and request streams are subscribed and acknowledged (region only)
    BOOL userAgent;      // applicationNameForUserAgent as the region sets it
    BOOL scripts;        // the three content-world user scripts and their message handlers
    BOOL scheme;         // a sok scheme handler
    BOOL appearance;     // view.appearance set to the effective appearance of the content view
    BOOL pageZoom;       // pageZoom set to 1
    BOOL overrideScale;  // the device scale override set to the backing scale of the window
    BOOL breakdown;      // footprint -v and vmmap rows of the graphics and malloc allocations are printed at the last read
    const char *featuresOff; // the WKPreferences feature keys turned off, separated by commas, or NULL
    BOOL documentBrowserCache; // the cache model of the engine is DocumentBrowser while the view is open
} Variant;

enum { kP, kQ, kR, kS, kT1, kT2, kT3, kT4, kT5, kT7, kU, kV1, kV2, kV3, kW, kVariantCount };

static const Variant kVariants[kVariantCount] = {
    { "P", "plain web view, nonpersistent data store", NO, NO, NO, NO, NO, NO, NO, NO, NO, NO },
    { "Q", "plain web view, persistent data store (also the store of T6)", NO, YES, NO, NO, NO, NO, NO, NO, NO, NO },
    { "R", "document region, no stream subscribed", YES, NO, NO, NO, NO, NO, NO, NO, NO, YES },
    { "S", "document region, element and request streams acknowledged", YES, NO, YES, NO, NO, NO, NO, NO, NO, NO },
    { "T1", "P + applicationNameForUserAgent as the region sets it", NO, NO, NO, YES, NO, NO, NO, NO, NO, NO },
    { "T2", "P + the three content-world user scripts and message handlers", NO, NO, NO, NO, YES, NO, NO, NO, NO, NO },
    { "T3", "P + the sok scheme handler", NO, NO, NO, NO, NO, YES, NO, NO, NO, NO },
    { "T4", "P + view.appearance of the content view", NO, NO, NO, NO, NO, NO, YES, NO, NO, NO },
    { "T5", "P + pageZoom 1", NO, NO, NO, NO, NO, NO, NO, YES, NO, NO },
    { "T7", "P + device scale override at the window backing scale", NO, NO, NO, NO, NO, NO, NO, NO, YES, NO },
    { "U", "P + applicationNameForUserAgent (the baseline of the difference rows)", NO, NO, NO, YES, NO, NO, NO, NO, NO, YES },
    { "V1", "U + TemporaryTileCohortRetentionEnabled off", NO, NO, NO, YES, NO, NO, NO, NO, NO, NO,
        "TemporaryTileCohortRetentionEnabled" },
    { "V2", "U + SupportHDRDisplayEnabled off", NO, NO, NO, YES, NO, NO, NO, NO, NO, NO, "SupportHDRDisplayEnabled" },
    { "V3", "U + both features off", NO, NO, NO, YES, NO, NO, NO, NO, NO, NO,
        "TemporaryTileCohortRetentionEnabled,SupportHDRDisplayEnabled" },
    { "W", "U + cache model DocumentBrowser", NO, NO, NO, YES, NO, NO, NO, NO, NO, NO, NULL, YES },
};

// The footprint of one WebContent process in bytes. A row that footprint does not report is -1.
typedef struct {
    long total;
    long mallocDirty;
    long mallocReclaimable;
    long graphicsDirty;
    long jitDirty;
    long allocDirty;     // the dirty bytes of the footprint rows whose category starts with MALLOC
} Reading;

// The user agent suffix that the region sets: the version of the system Safari (copied from src/document_view.m).
static NSString *safariApplicationName(void) {
    NSString *version = [NSBundle bundleWithPath:@"/Applications/Safari.app"].infoDictionary[@"CFBundleShortVersionString"];
    NSArray<NSString *> *parts = [version componentsSeparatedByString:@"."];
    if (parts.count < 2) return nil;
    return [NSString stringWithFormat:@"Version/%@.%@ Safari/605.1.15", parts[0], parts[1]];
}

// Counts the script messages. The benchmark does not act on them.
@interface ScriptSink : NSObject <WKScriptMessageHandler>
@end

@implementation ScriptSink
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    (void)controller;
    (void)message;
}
@end

// Fails every scheme task. The region's handler for a plugin without a folder fails every task in the same way.
@interface FailingSchemeHandler : NSObject <WKURLSchemeHandler>
@end

@implementation FailingSchemeHandler
- (void)webView:(WKWebView *)webView startURLSchemeTask:(id<WKURLSchemeTask>)task {
    (void)webView;
    [task didFailWithError:[NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorFileDoesNotExist userInfo:nil]];
}

- (void)webView:(WKWebView *)webView stopURLSchemeTask:(id<WKURLSchemeTask>)task {
    (void)webView;
    (void)task;
}
@end

static double nowSeconds(void) {
    return NSDate.date.timeIntervalSince1970;
}

// Sends the application events until done() holds or the limit passes. Returns done().
static BOOL pumpUntil(NSTimeInterval limit, BOOL (^done)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:limit];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        // The window server delivers the occlusion state of a window as an application event, so the pump dequeues and
        // sends events; a run of the run loop alone leaves occlusionState and the visibility of each page at the state
        // of the window's creation.
        NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskAny untilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]
            inMode:NSDefaultRunLoopMode dequeue:YES];
        if (event) [NSApp sendEvent:event];
    }
    return done();
}

// Pumps the run loop until the time t (seconds since 1970) passes.
static void waitUntil(double t) {
    pumpUntil(t - nowSeconds(), ^BOOL { return NO; });
}

// Exits with the step and the measured state when a step cannot run.
static void failStep(NSString *step, NSString *reason, pid_t process) {
    fprintf(stderr, "FAIL: step %s: %s\n", step.UTF8String, reason.UTF8String);
    fprintf(stderr, "  state: pid=%d\n", process);
    if (process != 0) kill(process, SIGKILL);
    exit(1);
}

// Ends a WebContent process and waits until it is gone. Returns NO when the process cannot be ended.
static BOOL endProcess(pid_t process, NSString *step) {
    if (kill(process, SIGKILL) != 0 && errno != ESRCH) {
        fprintf(stderr, "FAIL: step %s: the WebContent process %d cannot be ended: %s\n", step.UTF8String, process, strerror(errno));
        return NO;
    }
    if (!pumpUntil(10, ^BOOL { return kill(process, 0) != 0; })) {
        fprintf(stderr, "FAIL: step %s: the WebContent process %d remains after 10 seconds\n", step.UTF8String, process);
        return NO;
    }
    return YES;
}

// The output of footprint for the process, or nil when footprint cannot run or fails.
static NSString *footprintText(pid_t process) {
    NSTask *task = [[[NSTask alloc] init] autorelease];
    task.executableURL = [NSURL fileURLWithPath:@"/usr/bin/footprint"];
    task.arguments = @[@"-p", [NSString stringWithFormat:@"%d", process], @"-f", @"bytes"];
    NSPipe *pipe = [NSPipe pipe];
    task.standardOutput = pipe;
    NSError *error = nil;
    if (![task launchAndReturnError:&error]) {
        fprintf(stderr, "footprint cannot start: %s\n", error.localizedDescription.UTF8String);
        return nil;
    }
    NSData *data = [pipe.fileHandleForReading readDataToEndOfFile];
    [task waitUntilExit];
    if (task.terminationStatus != 0) return nil;
    return [[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] autorelease];
}

// Parses one footprint row: a row has the form "<dirty> B <clean> B <reclaimable> B <regions> <category>". Returns NO for a
// line that is not a row.
static BOOL footprintLine(NSString *line, long *dirty, long *reclaimable, NSString **category) {
    long rowDirty = 0;
    long rowClean = 0;
    long rowReclaimable = 0;
    long rowRegions = 0;
    int consumed = 0;
    if (sscanf(line.UTF8String, " %ld B %ld B %ld B %ld %n", &rowDirty, &rowClean, &rowReclaimable, &rowRegions, &consumed) != 4) return NO;
    *dirty = rowDirty;
    *reclaimable = rowReclaimable;
    *category = [[line substringFromIndex:consumed] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
    return YES;
}

// Reads the dirty and reclaimable bytes of the footprint row with the category name. Returns NO when footprint has no such row.
static BOOL footprintRow(NSString *text, const char *name, long *dirty, long *reclaimable) {
    NSString *wanted = [NSString stringWithUTF8String:name];
    for (NSString *line in [text componentsSeparatedByString:@"\n"]) {
        long rowDirty = 0;
        long rowReclaimable = 0;
        NSString *category = nil;
        if (!footprintLine(line, &rowDirty, &rowReclaimable, &category)) continue;
        if (![category isEqualToString:wanted]) continue;
        *dirty = rowDirty;
        *reclaimable = rowReclaimable;
        return YES;
    }
    return NO;
}

// Sums the dirty bytes of the footprint rows whose category starts with MALLOC (the malloc zones of the process). Returns -1
// when footprint has no such row.
static long footprintMallocDirty(NSString *text) {
    long total = -1;
    for (NSString *line in [text componentsSeparatedByString:@"\n"]) {
        long rowDirty = 0;
        long rowReclaimable = 0;
        NSString *category = nil;
        if (!footprintLine(line, &rowDirty, &rowReclaimable, &category)) continue;
        if (![category hasPrefix:@"MALLOC"]) continue;
        total = (total < 0 ? 0 : total) + rowDirty;
    }
    return total;
}

// Reads the footprint of the WebContent process of the view.
static Reading readFootprint(WKWebView *view, NSString *step) {
    pid_t process = view._webProcessIdentifier;
    if (process == 0) failStep(step, @"the web view has no WebContent process", 0);
    struct rusage_info_v0 info;
    if (proc_pid_rusage(process, RUSAGE_INFO_V0, (rusage_info_t *)&info) != 0) {
        failStep(step, @"proc_pid_rusage did not read the WebContent process", process);
    }
    NSString *text = footprintText(process);
    if (!text) failStep(step, @"footprint did not report the process", process);
    Reading reading = { (long)info.ri_phys_footprint, -1, -1, -1, -1, footprintMallocDirty(text) };
    long dirty = 0;
    long reclaimable = 0;
    if (footprintRow(text, "WebKit malloc", &dirty, &reclaimable)) {
        reading.mallocDirty = dirty;
        reading.mallocReclaimable = reclaimable;
    }
    if (footprintRow(text, "Owned physical footprint (unmapped) (graphics)", &dirty, &reclaimable)) reading.graphicsDirty = dirty;
    if (footprintRow(text, "JS JIT generated code", &dirty, &reclaimable)) reading.jitDirty = dirty;
    return reading;
}

// Counts of the document stream messages that the benchmark receives.
static long elementSnapshots;
static long requestMessages;

// The state reports of the document are not read by this benchmark.
static void documentChanged(void *context, const char *state) {
    (void)context;
    (void)state;
}

// Counts each stream message and acknowledges each element snapshot, so that the document keeps sending snapshots.
static void streamMessage(void *context, const char *json) {
    NSDictionary *value = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:json length:strlen(json)] options:0 error:nil];
    if (![value isKindOfClass:NSDictionary.class]) {
        fprintf(stderr, "FAIL: a document stream message is not a JSON object\n");
        exit(1);
    }
    NSString *stream = value[@"stream"];
    NSDictionary *message = value[@"message"];
    if ([stream isEqualToString:@"requests"]) {
        requestMessages++;
    } else if ([stream isEqualToString:@"elements"]) {
        if (![message[@"type"] isEqualToString:@"snapshot"]) return;
        elementSnapshots++;
        unsigned long long seq = [message[@"seq"] unsignedLongLongValue];
        if (!sp_document_stream_ack(context, seq)) {
            fprintf(stderr, "FAIL: the element snapshot %llu is not acknowledged\n", seq);
            exit(1);
        }
    } else {
        fprintf(stderr, "FAIL: a document stream message names an unknown stream\n");
        exit(1);
    }
}

// Formats bytes as megabytes, or "n/a" for a row that footprint did not report. The string lives until the pool of main drains.
static const char *megabytes(long bytes) {
    if (bytes < 0) return "n/a";
    return [NSString stringWithFormat:@"%.2f", (double)bytes / kMegabyte].UTF8String;
}

// Formats the difference to - from in megabytes, or "n/a" when either row is missing.
static const char *differenceMegabytes(long from, long to) {
    if (from < 0 || to < 0) return "n/a";
    return [NSString stringWithFormat:@"%+.2f", (double)(to - from) / kMegabyte].UTF8String;
}

// The configuration of a plain web view of a variant. The region variants are created by sp_document_create.
static WKWebViewConfiguration *plainConfiguration(const Variant *variant, WKWebsiteDataStore *persistentStore) {
    WKWebViewConfiguration *configuration = [[[WKWebViewConfiguration alloc] init] autorelease];
    configuration.websiteDataStore = variant->persistent ? persistentStore : WKWebsiteDataStore.nonPersistentDataStore;
    if (variant->userAgent) configuration.applicationNameForUserAgent = safariApplicationName();
    if (variant->featuresOff) {
        NSArray<NSString *> *keys = [@(variant->featuresOff) componentsSeparatedByString:@","];
        NSUInteger found = 0;
        for (_WKFeature *feature in WKPreferences._features) {
            if (![keys containsObject:feature.key]) continue;
            [configuration.preferences _setEnabled:NO forFeature:feature];
            found++;
        }
        if (found != keys.count) {
            fprintf(stderr, "FAIL: variant %s: WebKit has %lu of the features %s\n", variant->name, (unsigned long)found, variant->featuresOff);
            exit(1);
        }
    }
    if (variant->scheme) {
        FailingSchemeHandler *handler = [[[FailingSchemeHandler alloc] init] autorelease];
        [configuration setURLSchemeHandler:handler forURLScheme:@"soksak"];
    }
    if (variant->scripts) {
        WKContentWorld *world = [WKContentWorld worldWithName:kDocumentWorld];
        ScriptSink *sink = [[[ScriptSink alloc] init] autorelease];
        WKUserContentController *controller = configuration.userContentController;
        [controller addScriptMessageHandler:sink contentWorld:world name:kScrollMessage];
        [controller addScriptMessageHandler:sink contentWorld:world name:kPageMessage];
        [controller addScriptMessageHandler:sink contentWorld:world name:kMessageMessage];
        [controller addUserScript:[[[WKUserScript alloc] initWithSource:kMessageScript
            injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES inContentWorld:world] autorelease]];
        [controller addUserScript:[[[WKUserScript alloc] initWithSource:kScrollScript
            injectionTime:WKUserScriptInjectionTimeAtDocumentEnd forMainFrameOnly:YES inContentWorld:world] autorelease]];
        [controller addUserScript:[[[WKUserScript alloc] initWithSource:kPageScript
            injectionTime:WKUserScriptInjectionTimeAtDocumentEnd forMainFrameOnly:YES inContentWorld:world] autorelease]];
    }
    return configuration;
}

// Prints the page facts and the layer and frame facts of the view after its last read. The page facts are the user agent, the
// length of the document and the number of resource timing entries.
static void printFacts(const Variant *variant, WKWebView *view, NSWindow *window, NSView *content) {
    NSString *step = [NSString stringWithFormat:@"facts %s", variant->name];
    __block id result = nil;
    __block NSError *failure = nil;
    __block BOOL done = NO;
    [view callAsyncJavaScript:@"return [navigator.userAgent, document.documentElement.outerHTML.length, performance.getEntriesByType('resource').length];"
        arguments:@{} inFrame:nil inContentWorld:WKContentWorld.pageWorld completionHandler:^(id value, NSError *error) {
        result = [value retain];
        failure = [error retain];
        done = YES;
    }];
    if (!pumpUntil(stepLimit, ^BOOL { return done; })) failStep(step, @"the page did not answer the facts script within 120 seconds", view._webProcessIdentifier);
    NSString *userAgent = @"n/a";
    NSString *length = @"n/a";
    NSString *resources = @"n/a";
    if (failure) {
        fprintf(stderr, "facts %s: the script failed: %s\n", variant->name, failure.localizedDescription.UTF8String);
    } else if ([result isKindOfClass:NSArray.class] && [result count] == 3) {
        userAgent = result[0];
        length = [NSString stringWithFormat:@"%@", result[1]];
        resources = [NSString stringWithFormat:@"%@", result[2]];
    }
    fprintf(stdout, "facts %s: user_agent=\"%s\" html_length=%s resource_entries=%s\n", variant->name, userAgent.UTF8String,
        length.UTF8String, resources.UTF8String);
    NSView *superview = view.superview;
    fprintf(stdout, "facts %s: frame=(%g, %g, %g, %g) superview=%s superview_wants_layer=%d wants_layer=%d layer_contents_scale=%g "
        "page_zoom=%g window_backing_scale=%g content_appearance=%s\n", variant->name,
        view.frame.origin.x, view.frame.origin.y, view.frame.size.width, view.frame.size.height,
        superview ? NSStringFromClass(superview.class).UTF8String : "none", superview ? superview.wantsLayer : 0,
        view.wantsLayer, view.layer ? view.layer.contentsScale : 0.0, view.pageZoom, window.backingScaleFactor,
        content.effectiveAppearance.name.UTF8String);
    fflush(stdout);
}

// The output of a tool that reports the memory of a process, or nil when the tool cannot run or fails.
static NSString *toolText(NSString *path, NSArray<NSString *> *arguments) {
    NSTask *task = [[[NSTask alloc] init] autorelease];
    task.executableURL = [NSURL fileURLWithPath:path];
    task.arguments = arguments;
    NSPipe *pipe = [NSPipe pipe];
    task.standardOutput = pipe;
    NSError *error = nil;
    if (![task launchAndReturnError:&error]) {
        fprintf(stderr, "%s cannot start: %s\n", path.UTF8String, error.localizedDescription.UTF8String);
        return nil;
    }
    NSData *data = [pipe.fileHandleForReading readDataToEndOfFile];
    [task waitUntilExit];
    if (task.terminationStatus != 0) return nil;
    return [[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] autorelease];
}

// Prints the rows of footprint -v and vmmap -summary that name the graphics, IOSurface, CoreAnimation, malloc and JS
// allocations of the WebContent process, each row as the tool reports it. A tool that reports no matching rows prints a count of zero.
static void printBreakdown(const Variant *spec, pid_t process) {
    NSString *step = [NSString stringWithFormat:@"breakdown %s", spec->name];
    NSString *pidText = [NSString stringWithFormat:@"%d", process];
    NSArray<NSString *> *keys = @[@"IOSurface", @"IOAccelerator", @"CoreAnimation", @"IOKit", @"WebKit malloc", @"MALLOC",
        @"JS", @"graphics", @"Owned physical", @"TOTAL"];
    NSArray<NSString *> *commands = @[@"/usr/bin/footprint", @"/usr/bin/vmmap"];
    NSArray<NSArray<NSString *> *> *arguments = @[@[@"-p", pidText, @"-v", @"-f", @"bytes"], @[@"-summary", pidText]];
    for (NSUInteger tool = 0; tool < commands.count; tool++) {
        NSString *name = commands[tool].lastPathComponent;
        NSString *text = toolText(commands[tool], arguments[tool]);
        if (!text) failStep(step, [NSString stringWithFormat:@"%@ did not report the process", commands[tool]], process);
        NSUInteger printed = 0;
        for (NSString *line in [text componentsSeparatedByString:@"\n"]) {
            for (NSString *key in keys) {
                if ([line rangeOfString:key].location == NSNotFound) continue;
                fprintf(stdout, "breakdown %s %s: %s\n", spec->name, name.UTF8String,
                    [line stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet].UTF8String);
                printed++;
                break;
            }
        }
        fprintf(stdout, "breakdown %s %s: %lu matching rows\n", spec->name, name.UTF8String, (unsigned long)printed);
    }
    fflush(stdout);
}

// The view of one variant and the objects that own it. A plain variant has the view only. A document variant has the main web
// view of the application with the logical surface on it, and the document region (the view) inside the surface.
typedef struct {
    WKWebView *view;
    WKWebView *mainView;
    void *surface;
    void *document;
    BOOL cacheModelSet;  // the view set the cache model, and closing it sets the default back
} OpenView;

// Creates the view of the variant in the content view of the window and starts the load of the address. The step names the
// variant in the failure messages.
static OpenView openVariant(const Variant *spec, NSWindow *window, NSView *content, NSURL *address,
    WKWebsiteDataStore *persistentStore, NSString *documentDirectory, NSString *step) {
    OpenView opened = { nil, nil, NULL, NULL, NO };
    if (spec->documentBrowserCache) {
        WKContextSetCacheModel(NULL, kWKCacheModelDocumentBrowser);
        if (WKContextGetCacheModel(NULL) != kWKCacheModelDocumentBrowser) failStep(step, @"the cache model is not DocumentBrowser", 0);
        opened.cacheModelSet = YES;
    }
    CGRect frame = NSMakeRect(kMarginLeft, kWindowHeight - kMarginTop - kRegionHeight, kRegionWidth, kRegionHeight);
    if (!spec->region) {
        opened.view = [[[WKWebView alloc] initWithFrame:frame configuration:plainConfiguration(spec, persistentStore)] autorelease];
        [content addSubview:opened.view];
        if (spec->appearance) opened.view.appearance = content.effectiveAppearance;
        if (spec->pageZoom) opened.view.pageZoom = 1;
        if (spec->overrideScale) [opened.view _setOverrideDeviceScaleFactor:window.backingScaleFactor];
        [opened.view loadRequest:[NSURLRequest requestWithURL:address]];
    } else {
        // The surface is the main web view of the application: the document region is placed inside it.
        opened.mainView = [[[WKWebView alloc] initWithFrame:content.bounds] autorelease];
        opened.mainView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        [content addSubview:opened.mainView];
        opened.surface = sp_surface_create(opened.mainView);
        if (!opened.surface) failStep(step, @"a logical surface is not created", 0);
        webviewSetFrame(opened.surface, 0, 0, kWindowWidth, kWindowHeight);
        webviewSetSurfaceHidden(opened.surface, false);
        opened.document = sp_document_create(opened.surface, documentDirectory.fileSystemRepresentation, NULL, NULL, NULL, documentChanged, NULL);
        if (!opened.document) failStep(step, @"a document view is not created inside the surface", 0);
        opened.view = (WKWebView *)opened.document;
        sp_document_place(opened.document, kMarginLeft, kMarginTop, kMarginRight, kMarginBottom, true);
        if (spec->streams) {
            sp_document_set_stream(opened.document, streamMessage, opened.document);
            if (!sp_document_stream_on(opened.document, "elements", true) || !sp_document_stream_on(opened.document, "requests", true)) {
                failStep(step, @"a document stream is not turned on", opened.view._webProcessIdentifier);
            }
        }
        if (!sp_document_load(opened.document, address.absoluteString.UTF8String)) {
            failStep(step, @"the document refuses the address", opened.view._webProcessIdentifier);
        }
    }
    return opened;
}

// Closes the view and its surface, and ends their WebContent processes. The processes are read before the views close.
// WebKit keeps an idle WebContent process after its last view closes, so the benchmark ends each process it started.
static void closeOpenView(OpenView *opened, NSString *step) {
    pid_t process = opened->view._webProcessIdentifier;
    pid_t mainProcess = opened->mainView ? opened->mainView._webProcessIdentifier : 0;
    if (opened->document) {
        sp_document_close(opened->document);
    } else {
        [opened->view removeFromSuperview];
    }
    if (opened->surface) {
        sp_surface_close(opened->surface);
        [opened->mainView removeFromSuperview];
    }
    if (!endProcess(process, step)) exit(1);
    if (mainProcess != 0 && mainProcess != process && !endProcess(mainProcess, step)) exit(1);
    if (opened->cacheModelSet) {
        WKContextSetCacheModel(NULL, kWKCacheModelPrimaryWebBrowser);
        if (WKContextGetCacheModel(NULL) != kWKCacheModelPrimaryWebBrowser) failStep(step, @"the cache model is not PrimaryWebBrowser", 0);
    }
}

// Loads the address in one variant, reads the footprint of its WebContent process at each read time, and ends the view and
// its process. The readings are stored in readings[0...kReads-1].
static void measureVariant(int variant, NSWindow *window, NSView *content, NSURL *address, WKWebsiteDataStore *persistentStore,
    NSString *documentDirectory, Reading readings[kReads]) {
    const Variant *spec = &kVariants[variant];
    NSString *step = [NSString stringWithFormat:@"variant %s", spec->name];
    fprintf(stdout, "start %s: %s\n", spec->name, spec->label);
    fflush(stdout);
    double started = nowSeconds();

    OpenView opened = openVariant(spec, window, content, address, persistentStore, documentDirectory, step);
    WKWebView *view = opened.view;

    // The load has finished when the page is not loading and it has a title.
    if (!pumpUntil(stepLimit, ^BOOL { return !view.loading && view.title.length > 0; })) {
        failStep(step, @"the page did not finish loading within 120 seconds", view._webProcessIdentifier);
    }
    pumpUntil(settleSeconds, ^BOOL { return NO; });
    double loaded = nowSeconds();
    pid_t process = view._webProcessIdentifier;
    fprintf(stdout, "loaded %s: pid=%d title=%s elapsed %.3f s\n", spec->name, process, view.title.UTF8String, loaded - started);
    fflush(stdout);

    for (int i = 0; i < kReads; i++) {
        waitUntil(loaded + readSeconds[i]);
        readings[i] = readFootprint(view, step);
        fprintf(stdout, "read %s at %.0f s: total_mb=%s malloc_dirty_mb=%s malloc_reclaimable_mb=%s graphics_mb=%s jit_mb=%s\n",
            spec->name, readSeconds[i], megabytes(readings[i].total),
            megabytes(readings[i].mallocDirty), megabytes(readings[i].mallocReclaimable),
            megabytes(readings[i].graphicsDirty), megabytes(readings[i].jitDirty));
        fflush(stdout);
    }
    if (spec->breakdown) printBreakdown(spec, process);
    printFacts(spec, view, window, content);

    closeOpenView(&opened, step);
    fprintf(stdout, "end %s elapsed %.3f s\n", spec->name, nowSeconds() - started);
    fflush(stdout);
}

// Prints one table row: the name and the total, malloc dirty, malloc reclaimable, graphics and JIT columns.
static void printRow(const char *name, Reading reading) {
    fprintf(stdout, "%-8s %10s %16s %22s %14s %10s\n", name, megabytes(reading.total), megabytes(reading.mallocDirty),
        megabytes(reading.mallocReclaimable), megabytes(reading.graphicsDirty), megabytes(reading.jitDirty));
}

// Prints one difference row: to - from in each column.
static void printDifference(const char *name, Reading from, Reading to) {
    fprintf(stdout, "%-8s %10s %16s %22s %14s %10s\n", name, differenceMegabytes(from.total, to.total),
        differenceMegabytes(from.mallocDirty, to.mallocDirty), differenceMegabytes(from.mallocReclaimable, to.mallocReclaimable),
        differenceMegabytes(from.graphicsDirty, to.graphicsDirty), differenceMegabytes(from.jitDirty, to.jitDirty));
}

// The long mode measures U and S at the same time, each in its own window. The first minute of the least-squares fit and the
// fewest minutes that a fit accepts (a fit needs two minutes).
static const int kLongSlopeFirstMinute = 5;
static const long kLongMinimumMinutes = 6;

// The sums of a least-squares line fit of the total (y, megabytes) against the minute (x).
typedef struct {
    double count;
    double sumX;
    double sumY;
    double sumXY;
    double sumXX;
} Fit;

static void fitAdd(Fit *fit, double x, double y) {
    fit->count += 1;
    fit->sumX += x;
    fit->sumY += y;
    fit->sumXY += x * y;
    fit->sumXX += x * x;
}

// The slope of the fitted line. The minutes of a fit differ, so the denominator is not zero.
static double fitSlope(Fit fit) {
    return (fit.count * fit.sumXY - fit.sumX * fit.sumY) / (fit.count * fit.sumXX - fit.sumX * fit.sumX);
}

// Loads the address in U and S at the same time, prints the footprint of each WebContent process at each minute after the
// loads, and prints the slopes of the totals. The windows are placed at the top of the visible screen: U at the left edge
// and S at the right edge. A window is ordered front without activating the application.
static void measureLong(int minutes, NSURL *address, WKWebsiteDataStore *persistentStore, NSString *documentDirectory) {
    NSRect screen = NSScreen.mainScreen.visibleFrame;
    if (screen.size.width < kWindowWidth || screen.size.height < kWindowHeight) {
        fprintf(stderr, "FAIL: the visible screen %gx%g is smaller than the %gx%g window\n", (double)screen.size.width,
            (double)screen.size.height, (double)kWindowWidth, (double)kWindowHeight);
        exit(1);
    }
    const Variant *specs[2] = { &kVariants[kU], &kVariants[kS] };
    NSWindow *windows[2];
    NSView *contents[2];
    NSString *steps[2];
    OpenView opened[2];
    WKWebView *views[2];
    Fit fits[2] = { { 0, 0, 0, 0, 0 }, { 0, 0, 0, 0, 0 } };
    for (int j = 0; j < 2; j++) {
        windows[j] = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, kWindowWidth, kWindowHeight)
            styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        [windows[j] setReleasedWhenClosed:NO];
        contents[j] = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, kWindowWidth, kWindowHeight)] autorelease];
        windows[j].contentView = contents[j];
        CGFloat left = screen.origin.x + j * (screen.size.width - kWindowWidth);
        [windows[j] setFrameTopLeftPoint:NSMakePoint(left, NSMaxY(screen))];
        steps[j] = [NSString stringWithFormat:@"long %s", specs[j]->name];
    }
    for (int j = 0; j < 2; j++) {
        [windows[j] orderFront:nil];
        NSRect frame = windows[j].frame;
        fprintf(stdout, "window %s frame=(%g, %g, %g, %g) backing_scale %g\n", specs[j]->name, (double)frame.origin.x,
            (double)frame.origin.y, (double)frame.size.width, (double)frame.size.height, (double)windows[j].backingScaleFactor);
    }
    fflush(stdout);

    for (int j = 0; j < 2; j++) {
        fprintf(stdout, "start %s: %s\n", specs[j]->name, specs[j]->label);
        fflush(stdout);
        opened[j] = openVariant(specs[j], windows[j], contents[j], address, persistentStore, documentDirectory, steps[j]);
        views[j] = opened[j].view;
    }
    for (int j = 0; j < 2; j++) {
        WKWebView *view = views[j];
        if (!pumpUntil(stepLimit, ^BOOL { return !view.loading && view.title.length > 0; })) {
            failStep(steps[j], @"the page did not finish loading within 120 seconds", view._webProcessIdentifier);
        }
    }
    pumpUntil(settleSeconds, ^BOOL { return NO; });
    double loaded = nowSeconds();
    for (int j = 0; j < 2; j++) {
        fprintf(stdout, "loaded %s: pid=%d title=%s\n", specs[j]->name, views[j]._webProcessIdentifier, views[j].title.UTF8String);
    }
    fflush(stdout);

    for (int minute = 1; minute <= minutes; minute++) {
        waitUntil(loaded + 60.0 * minute);
        for (int j = 0; j < 2; j++) {
            Reading reading = readFootprint(views[j], steps[j]);
            fprintf(stdout, "minute=%d variant=%s elapsed_s=%.1f total_mb=%s malloc_dirty_mb=%s webkit_malloc_mb=%s graphics_mb=%s jit_mb=%s\n",
                minute, specs[j]->name, nowSeconds() - loaded, megabytes(reading.total), megabytes(reading.allocDirty),
                megabytes(reading.mallocDirty), megabytes(reading.graphicsDirty), megabytes(reading.jitDirty));
            fflush(stdout);
            if (minute >= kLongSlopeFirstMinute) fitAdd(&fits[j], minute, (double)reading.total / kMegabyte);
        }
    }

    double slopes[2];
    for (int j = 0; j < 2; j++) {
        slopes[j] = fitSlope(fits[j]);
        fprintf(stdout, "slope %s total_mb_per_minute=%+.3f minutes=%d..%d\n", specs[j]->name, slopes[j], kLongSlopeFirstMinute, minutes);
    }
    fprintf(stdout, "difference S-U total_mb_per_minute=%+.3f\n", slopes[1] - slopes[0]);
    fflush(stdout);

    for (int j = 0; j < 2; j++) {
        closeOpenView(&opened[j], steps[j]);
        [windows[j] close];
        [windows[j] release];
    }
}

// The reload mode: the seconds between the end of a load and the start of the next reload, and the classes that heap counts.
static const NSTimeInterval kReloadGapSeconds = 15;
static const char *const kHeapClasses[] = { "WebCore::Text", "WebCore::HTMLDocument",
    "WebCore::CSSFontAccessor", "NSCTFont" };
enum { kHeapClassCount = sizeof(kHeapClasses) / sizeof(kHeapClasses[0]) };
// The reading of one WebContent process in the reload mode. A count or row that the tool does not report is -1.
typedef struct {
    long total;
    long mallocSmallDirty;
    long webkitMallocDirty;
    double loadSeconds;  // the first load, or the mean of the reloads; -1 for a reading after memory pressure
    long counts[kHeapClassCount];
} ReloadReading;
// Reads the footprint total, the MALLOC_SMALL row and the heap counts of the WebContent process of the view.
static ReloadReading readReload(WKWebView *view, NSString *step) {
    pid_t process = view._webProcessIdentifier;
    ReloadReading reading;
    Reading footprint = readFootprint(view, step);
    reading.total = footprint.total;
    reading.webkitMallocDirty = footprint.mallocDirty;
    reading.loadSeconds = -1;
    reading.mallocSmallDirty = -1;
    NSString *text = footprintText(process);
    if (!text) failStep(step, @"footprint did not report the process", process);
    long dirty = 0;
    long reclaimable = 0;
    if (footprintRow(text, "MALLOC_SMALL", &dirty, &reclaimable)) reading.mallocSmallDirty = dirty;
    // heap prints one row per class: "<count> <bytes> <average> <class> <type> <binary>".
    NSString *heap = toolText(@"/usr/bin/heap", @[[NSString stringWithFormat:@"%d", process]]);
    if (!heap) failStep(step, @"heap did not report the process", process);
    for (int c = 0; c < kHeapClassCount; c++) reading.counts[c] = -1;
    for (NSString *line in [heap componentsSeparatedByString:@"\n"]) {
        long count = 0;
        long bytes = 0;
        double average = 0;
        int consumed = 0;
        if (sscanf(line.UTF8String, " %ld %ld %lf %n", &count, &bytes, &average, &consumed) != 3) continue;
        NSArray<NSString *> *words = [[line substringFromIndex:consumed]
            componentsSeparatedByCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
        if (words.count == 0) continue;
        for (int c = 0; c < kHeapClassCount; c++) {
            if ([words[0] isEqualToString:@(kHeapClasses[c])]) reading.counts[c] = count;
        }
    }
    return reading;
}
static void printReload(const char *name, const char *when, ReloadReading reading) {
    fprintf(stdout, "%-4s %-12s %10s %16s %16s %10.2f", name, when, megabytes(reading.total), megabytes(reading.mallocSmallDirty),
        megabytes(reading.webkitMallocDirty), reading.loadSeconds);
    for (int c = 0; c < kHeapClassCount; c++) fprintf(stdout, " %24ld", reading.counts[c]);
    fprintf(stdout, "\n");
}
// Sets the simulated memory pressure level of the system. The level stays until the next call sets another.
static void setPressure(NSString *level, NSString *step, pid_t process) {
    if (!toolText(@"/usr/bin/sudo", @[@"-n", @"/usr/bin/memory_pressure", @"-S", @"-l", level])) {
        failStep(step, [NSString stringWithFormat:@"sudo -n memory_pressure -S -l %@ failed", level], process);
    }
    fprintf(stdout, "pressure level %s\n", level.UTF8String);
    fflush(stdout);
}
// Waits until the navigation that the caller started has finished: the view reports loading, then not loading.
static void waitNavigation(WKWebView *view, NSString *step) {
    if (!pumpUntil(stepLimit, ^BOOL { return view.loading; })) {
        failStep(step, @"the reload did not start within 120 seconds", view._webProcessIdentifier);
    }
    if (!pumpUntil(stepLimit, ^BOOL { return !view.loading && view.title.length > 0; })) {
        failStep(step, @"the reload did not finish within 120 seconds", view._webProcessIdentifier);
    }
}
// Loads the address in each of the variants, reloads it count times in each, and prints the readings after the first load,
// after the last reload and after memory pressure.
static void measureReload(int count, NSString *pressureLevel, NSWindow *window, NSView *content, NSURL *address, WKWebsiteDataStore *persistentStore,
    NSString *documentDirectory, const int *variants, int variantCount) {
    ReloadReading readings[kVariantCount][3];
    for (int j = 0; j < variantCount; j++) {
        const Variant *spec = &kVariants[variants[j]];
        NSString *step = [NSString stringWithFormat:@"reload %s", spec->name];
        fprintf(stdout, "start %s: %s\n", spec->name, spec->label);
        fflush(stdout);
        double requested = nowSeconds();
        OpenView opened = openVariant(spec, window, content, address, persistentStore, documentDirectory, step);
        WKWebView *view = opened.view;
        if (!pumpUntil(stepLimit, ^BOOL { return !view.loading && view.title.length > 0; })) {
            failStep(step, @"the page did not finish loading within 120 seconds", view._webProcessIdentifier);
        }
        pid_t process = view._webProcessIdentifier;
        double loaded = nowSeconds();
        double firstLoad = loaded - requested;
        double reloadSum = 0;
        waitUntil(loaded + kReloadGapSeconds);
        readings[j][0] = readReload(view, step);
        readings[j][0].loadSeconds = firstLoad;
        fprintf(stdout, "loaded %s: pid=%d title=%s\n", spec->name, process, view.title.UTF8String);
        printReload(spec->name, "load", readings[j][0]);
        fflush(stdout);
        for (int r = 1; r <= count; r++) {
            requested = nowSeconds();
            if (opened.document) {
                if (!sp_document_load(opened.document, address.absoluteString.UTF8String)) {
                    failStep(step, @"the document refuses the address", view._webProcessIdentifier);
                }
            } else {
                [view loadRequest:[NSURLRequest requestWithURL:address]];
            }
            waitNavigation(view, step);
            loaded = nowSeconds();
            reloadSum += loaded - requested;
            if (view._webProcessIdentifier != process) {
                failStep(step, [NSString stringWithFormat:@"the reload %d moved the page to the process %d", r,
                    view._webProcessIdentifier], process);
            }
            fprintf(stdout, "reloaded %s: %d of %d\n", spec->name, r, count);
            fflush(stdout);
            waitUntil(loaded + kReloadGapSeconds);
        }
        readings[j][1] = readReload(view, step);
        readings[j][1].loadSeconds = reloadSum / count;
        printReload(spec->name, "reloads", readings[j][1]);
        fflush(stdout);
        setPressure(pressureLevel, step, process);
        waitUntil(nowSeconds() + 10);
        setPressure(@"normal", step, process);
        waitUntil(nowSeconds() + 5);
        readings[j][2] = readReload(view, step);
        printReload(spec->name, "pressure", readings[j][2]);
        fflush(stdout);
        closeOpenView(&opened, step);
    }
    fprintf(stdout, "\nreload table: %d reloads (MB and heap counts)\n", count);
    fprintf(stdout, "%-4s %-12s %10s %16s %16s %10s", "var", "when", "total", "malloc_small", "webkit_malloc", "load_s");
    for (int c = 0; c < kHeapClassCount; c++) fprintf(stdout, " %24s", kHeapClasses[c]);
    fprintf(stdout, "\n");
    for (int j = 0; j < variantCount; j++) {
        printReload(kVariants[variants[j]].name, "load", readings[j][0]);
        printReload(kVariants[variants[j]].name, "reloads", readings[j][1]);
        printReload(kVariants[variants[j]].name, "pressure", readings[j][2]);
    }
    fflush(stdout);
}
// The collection mode: the minutes between two reads and the classes that heap counts.
static const int kCollectionReadMinutes = 2;
static const char *const kCollectionClasses[] = { "WebCore::Text", "WebCore::HTMLDocument" };
enum { kCollectionClassCount = sizeof(kCollectionClasses) / sizeof(kCollectionClasses[0]) };
// Prints one read of the collection mode: the footprint total and WebKit malloc row, the heap counts of the classes, and the
// count and bytes of the classes whose name starts with JSC::. A count that heap does not report is -1.
static void printCollection(WKWebView *view, NSString *step, const char *name, const char *when, double elapsed) {
    pid_t process = view._webProcessIdentifier;
    Reading reading = readFootprint(view, step);
    NSString *heap = toolText(@"/usr/bin/heap", @[[NSString stringWithFormat:@"%d", process]]);
    if (!heap) failStep(step, @"heap did not report the process", process);
    long counts[kCollectionClassCount];
    for (int c = 0; c < kCollectionClassCount; c++) counts[c] = -1;
    long jscCount = 0;
    long jscBytes = 0;
    // heap prints one row per class: "<count> <bytes> <average> <class> <type> <binary>".
    for (NSString *line in [heap componentsSeparatedByString:@"\n"]) {
        long count = 0;
        long bytes = 0;
        double average = 0;
        int consumed = 0;
        if (sscanf(line.UTF8String, " %ld %ld %lf %n", &count, &bytes, &average, &consumed) != 3) continue;
        NSArray<NSString *> *words = [[line substringFromIndex:consumed]
            componentsSeparatedByCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
        if (words.count == 0) continue;
        for (int c = 0; c < kCollectionClassCount; c++) {
            if ([words[0] isEqualToString:@(kCollectionClasses[c])]) counts[c] = count;
        }
        if ([words[0] hasPrefix:@"JSC::"]) {
            jscCount += count;
            jscBytes += bytes;
        }
    }
    fprintf(stdout, "%-10s %-2s elapsed_s=%7.1f total_mb=%s webkit_malloc_mb=%s", when, name, elapsed, megabytes(reading.total),
        megabytes(reading.mallocDirty));
    for (int c = 0; c < kCollectionClassCount; c++) fprintf(stdout, " %s=%ld", kCollectionClasses[c], counts[c]);
    fprintf(stdout, " JSC::*=%ld JSC::*_mb=%s\n", jscCount, megabytes(jscBytes));
    fflush(stdout);
}
// The variants of the collection mode, each in its own window.
static const int kCollectionVariants[] = { kU, kR, kS };
enum { kCollectionVariantCount = sizeof(kCollectionVariants) / sizeof(kCollectionVariants[0]) };
// Prints the load averages of the system over 1, 5 and 15 minutes (sysctl vm.loadavg).
static void printLoad(const char *when) {
    struct loadavg load;
    size_t size = sizeof(load);
    if (sysctlbyname("vm.loadavg", &load, &size, NULL, 0) != 0) {
        fprintf(stderr, "FAIL: sysctl vm.loadavg failed: %s\n", strerror(errno));
        exit(1);
    }
    fprintf(stdout, "%-10s loadavg=%.2f %.2f %.2f\n", when, (double)load.ldavg[0] / load.fscale,
        (double)load.ldavg[1] / load.fscale, (double)load.ldavg[2] / load.fscale);
    fflush(stdout);
}
// Prints the occlusion state, the space, the level and the window number of the window, its window list entry, and each
// window of the window list that is ordered above it with an intersecting frame, so that a failed visibility check names
// the windows that cover it.
static void printWindowOrder(NSWindow *window, const char *name) {
    fprintf(stdout, "window %s occlusion=0x%lx visible=%d on_active_space=%d level=%ld number=%ld\n", name,
        (unsigned long)window.occlusionState, (window.occlusionState & NSWindowOcclusionStateVisible) != 0,
        window.isOnActiveSpace, (long)window.level, (long)window.windowNumber);
    CGWindowID number = (CGWindowID)window.windowNumber;
    NSArray *own = [(NSArray *)CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, number) autorelease];
    NSArray *above = [(NSArray *)CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenAboveWindow, number) autorelease];
    if (own.count != 1) {
        fprintf(stdout, "window %s list_entries=%lu\n", name, (unsigned long)own.count);
        fflush(stdout);
        return;
    }
    CGRect frame;
    CGRectMakeWithDictionaryRepresentation((CFDictionaryRef)own[0][(id)kCGWindowBounds], &frame);
    fprintf(stdout, "window %s list onscreen=%d layer=%d alpha=%g bounds=(%g, %g, %g, %g) above=%lu\n", name,
        [own[0][(id)kCGWindowIsOnscreen] intValue], [own[0][(id)kCGWindowLayer] intValue],
        [own[0][(id)kCGWindowAlpha] doubleValue], frame.origin.x, frame.origin.y, frame.size.width, frame.size.height,
        (unsigned long)above.count);
    for (NSDictionary *entry in above) {
        CGRect bounds;
        CGRectMakeWithDictionaryRepresentation((CFDictionaryRef)entry[(id)kCGWindowBounds], &bounds);
        if (!CGRectIntersectsRect(bounds, frame)) continue;
        fprintf(stdout, "window %s covered_by owner=%s pid=%d number=%d layer=%d alpha=%g bounds=(%g, %g, %g, %g)\n", name,
            [entry[(id)kCGWindowOwnerName] UTF8String], [entry[(id)kCGWindowOwnerPID] intValue],
            [entry[(id)kCGWindowNumber] intValue], [entry[(id)kCGWindowLayer] intValue],
            [entry[(id)kCGWindowAlpha] doubleValue], bounds.origin.x, bounds.origin.y, bounds.size.width, bounds.size.height);
    }
    fflush(stdout);
}
// Loads the address in U, R and S at the same time, each in its own window at the top of the visible screen. The windows
// are spread from the left edge to the right edge, so that a part of each window is visible and no window is occluded. It
// reads each process every 2 minutes for the minutes, then reads them after a simulated warn memory pressure.
static void measureCollection(int minutes, NSURL *address, WKWebsiteDataStore *persistentStore, NSString *documentDirectory) {
    NSRect screen = NSScreen.mainScreen.visibleFrame;
    if (screen.size.width < kWindowWidth || screen.size.height < kWindowHeight) {
        fprintf(stderr, "FAIL: the visible screen %gx%g is smaller than the %gx%g window\n", (double)screen.size.width,
            (double)screen.size.height, (double)kWindowWidth, (double)kWindowHeight);
        exit(1);
    }
    NSWindow *windows[kCollectionVariantCount];
    OpenView opened[kCollectionVariantCount];
    NSString *steps[kCollectionVariantCount];
    const Variant *specs[kCollectionVariantCount];
    CGFloat spacing = (screen.size.width - kWindowWidth) / (kCollectionVariantCount - 1);
    for (int j = 0; j < kCollectionVariantCount; j++) {
        specs[j] = &kVariants[kCollectionVariants[j]];
        steps[j] = [NSString stringWithFormat:@"collection %s", specs[j]->name];
        windows[j] = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, kWindowWidth, kWindowHeight)
            styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        [windows[j] setReleasedWhenClosed:NO];
        NSView *content = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, kWindowWidth, kWindowHeight)] autorelease];
        windows[j].contentView = content;
        [windows[j] setFrameTopLeftPoint:NSMakePoint(screen.origin.x + j * spacing, NSMaxY(screen))];
        [windows[j] orderFront:nil];
        fprintf(stdout, "start %s: %s window_active=%d\n", specs[j]->name, specs[j]->label, windows[j].isKeyWindow);
        fflush(stdout);
        opened[j] = openVariant(specs[j], windows[j], content, address, persistentStore, documentDirectory, steps[j]);
    }
    for (int j = 0; j < kCollectionVariantCount; j++) {
        WKWebView *view = opened[j].view;
        if (!pumpUntil(stepLimit, ^BOOL { return !view.loading && view.title.length > 0; })) {
            failStep(steps[j], @"the page did not finish loading within 120 seconds", view._webProcessIdentifier);
        }
    }
    pumpUntil(settleSeconds, ^BOOL { return NO; });
    double loaded = nowSeconds();
    for (int j = 0; j < kCollectionVariantCount; j++) {
        fprintf(stdout, "loaded %s: pid=%d visible=%d title=%s\n", specs[j]->name, opened[j].view._webProcessIdentifier,
            (windows[j].occlusionState & NSWindowOcclusionStateVisible) != 0, opened[j].view.title.UTF8String);
    }
    fflush(stdout);
    for (int j = 0; j < kCollectionVariantCount; j++) printWindowOrder(windows[j], specs[j]->name);
    // An occluded window throttles its page, so a read of it does not measure a visible page.
    for (int j = 0; j < kCollectionVariantCount; j++) {
        if (!(windows[j].occlusionState & NSWindowOcclusionStateVisible)) {
            failStep(steps[j], @"the window is occluded, so the page is not visible", opened[j].view._webProcessIdentifier);
        }
    }
    for (int minute = 0; minute <= minutes; minute += kCollectionReadMinutes) {
        waitUntil(loaded + 60.0 * minute);
        char when[32];
        snprintf(when, sizeof(when), "minute=%d", minute);
        printLoad(when);
        for (int j = 0; j < kCollectionVariantCount; j++) {
            printCollection(opened[j].view, steps[j], specs[j]->name, when, nowSeconds() - loaded);
        }
    }
    pid_t process = opened[0].view._webProcessIdentifier;
    setPressure(@"warn", steps[0], process);
    waitUntil(nowSeconds() + 10);
    setPressure(@"normal", steps[0], process);
    waitUntil(nowSeconds() + 5);
    printLoad("pressure");
    for (int j = 0; j < kCollectionVariantCount; j++) {
        printCollection(opened[j].view, steps[j], specs[j]->name, "pressure", nowSeconds() - loaded);
    }
    for (int j = 0; j < kCollectionVariantCount; j++) {
        closeOpenView(&opened[j], steps[j]);
        [windows[j] close];
        [windows[j] release];
    }
}
int main(int argc, const char *argv[]) { @autoreleasepool {
    double started = nowSeconds();
    const char *addressArgument = NULL;
    long longMinutes = 0;
    long reloadCount = 0;
    long collectionMinutes = 0;
    NSString *pressureLevel = @"warn";
    BOOL selected[kVariantCount];
    BOOL variantsGiven = NO;
    for (int variant = 0; variant < kVariantCount; variant++) selected[variant] = YES;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--variants") == 0) {
            if (i + 1 >= argc) {
                fprintf(stderr, "FAIL: --variants needs the names of the variants\n");
                return 1;
            }
            NSArray<NSString *> *names = [@(argv[++i]) componentsSeparatedByString:@","];
            variantsGiven = YES;
            for (int variant = 0; variant < kVariantCount; variant++) selected[variant] = NO;
            for (NSString *name in names) {
                int found = -1;
                for (int variant = 0; variant < kVariantCount; variant++) {
                    if ([name isEqualToString:@(kVariants[variant].name)]) found = variant;
                }
                if (found < 0) {
                    fprintf(stderr, "FAIL: the variant %s is not in the table\n", name.UTF8String);
                    return 1;
                }
                selected[found] = YES;
            }
        } else if (strcmp(argv[i], "--long") == 0) {
            if (i + 1 >= argc) {
                fprintf(stderr, "FAIL: --long needs the number of minutes\n");
                return 1;
            }
            char *end = NULL;
            errno = 0;
            long minutes = strtol(argv[++i], &end, 10);
            if (errno != 0 || *end != '\0' || minutes < kLongMinimumMinutes) {
                fprintf(stderr, "FAIL: --long takes a whole number of minutes of at least %ld, not %s\n", kLongMinimumMinutes, argv[i]);
                return 1;
            }
            longMinutes = minutes;
        } else if (strcmp(argv[i], "--collection") == 0) {
            char *end = NULL;
            errno = 0;
            long minutes = i + 1 < argc ? strtol(argv[++i], &end, 10) : 0;
            if (errno != 0 || end == NULL || *end != '\0' || minutes < kCollectionReadMinutes) {
                fprintf(stderr, "FAIL: --collection takes a whole number of minutes of at least %d\n", kCollectionReadMinutes);
                return 1;
            }
            collectionMinutes = minutes;
        } else if (strcmp(argv[i], "--pressure") == 0) {
            if (i + 1 >= argc || (strcmp(argv[i + 1], "warn") != 0 && strcmp(argv[i + 1], "critical") != 0)) {
                fprintf(stderr, "FAIL: --pressure takes warn or critical\n");
                return 1;
            }
            pressureLevel = @(argv[++i]);
        } else if (strcmp(argv[i], "--reload") == 0) {
            char *end = NULL;
            errno = 0;
            long reloads = i + 1 < argc ? strtol(argv[++i], &end, 10) : 0;
            if (errno != 0 || end == NULL || *end != '\0' || reloads < 1) {
                fprintf(stderr, "FAIL: --reload takes a whole number of reloads of at least 1\n");
                return 1;
            }
            reloadCount = reloads;
        } else if (addressArgument == NULL) {
            addressArgument = argv[i];
        } else {
            fprintf(stderr, "FAIL: the argument %s is not expected\n", argv[i]);
            return 1;
        }
    }
    NSString *address = addressArgument ? [NSString stringWithUTF8String:addressArgument] : @"https://www.google.com/";
    NSURL *url = [NSURL URLWithString:address];
    if (!url.scheme || !url.host) {
        fprintf(stderr, "FAIL: the address %s is not an absolute address\n", address.UTF8String);
        return 1;
    }
    fprintf(stdout, "start benchmark address=%s mode=%s\n", address.UTF8String, longMinutes > 0 ? "long" : collectionMinutes > 0 ? "collection" : reloadCount > 0 ? "reload" : "table");
    fflush(stdout);
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    // The persistent store of Q is one store for the directory, as the hosts keep one store per directory. The document
    // variants use another directory, so that two store objects never write the same files.
    NSString *root = temporaryFolder(@"soksak-region-cost-");
    NSString *persistentDirectory = [root stringByAppendingPathComponent:@"persistent"];
    NSString *documentDirectory = [root stringByAppendingPathComponent:@"documents"];
    NSError *createError = nil;
    if (![NSFileManager.defaultManager createDirectoryAtPath:persistentDirectory withIntermediateDirectories:YES attributes:nil error:&createError]) {
        fprintf(stderr, "FAIL: the persistent directory %s cannot be created: %s\n", persistentDirectory.UTF8String,
            createError.localizedDescription.UTF8String);
        return 1;
    }
    _WKWebsiteDataStoreConfiguration *storeConfiguration = [[[_WKWebsiteDataStoreConfiguration alloc]
        initWithDirectory:[NSURL fileURLWithPath:persistentDirectory isDirectory:YES]] autorelease];
    WKWebsiteDataStore *persistentStore = [[[WKWebsiteDataStore alloc] _initWithConfiguration:storeConfiguration] autorelease];
    if (!persistentStore) {
        fprintf(stderr, "FAIL: the persistent data store is not created\n");
        return 1;
    }

    if (collectionMinutes > 0) {
        measureCollection((int)collectionMinutes, url, persistentStore, documentDirectory);
    } else if (longMinutes > 0) {
        measureLong((int)longMinutes, url, persistentStore, documentDirectory);
    } else {
        NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, kWindowWidth, kWindowHeight)
            styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        [window setReleasedWhenClosed:NO];
        NSView *content = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, kWindowWidth, kWindowHeight)] autorelease];
        window.contentView = content;
        // orderBack does not activate the application.
        [window orderBack:nil];
        fprintf(stdout, "window %gx%g backing_scale %g\n", (double)kWindowWidth, (double)kWindowHeight, (double)window.backingScaleFactor);
        fflush(stdout);
        if (reloadCount > 0) {
            int reloadVariants[kVariantCount] = { kU, kS };
            int reloadVariantCount = 2;
            if (variantsGiven) {
                reloadVariantCount = 0;
                for (int variant = 0; variant < kVariantCount; variant++) {
                    if (selected[variant]) reloadVariants[reloadVariantCount++] = variant;
                }
            }
            measureReload((int)reloadCount, pressureLevel, window, content, url, persistentStore, documentDirectory,
                reloadVariants, reloadVariantCount);
            [window close];
            [window release];
            fprintf(stdout, "end benchmark elapsed %.3f s\n", nowSeconds() - started);
            return 0;
        }

        Reading readings[kVariantCount][kReads];
        for (int variant = 0; variant < kVariantCount; variant++) {
            for (int i = 0; i < kReads; i++) readings[variant][i] = (Reading){ -1, -1, -1, -1, -1, -1 };
            if (!selected[variant]) continue;
            measureVariant(variant, window, content, url, persistentStore, documentDirectory, readings[variant]);
        }

        // The tables: each variant at each read time, then the difference of each variant to P (S to R for the streams).
        for (int i = 0; i < kReads; i++) {
            fprintf(stdout, "\nread at %.0f s (MB)\n", readSeconds[i]);
            fprintf(stdout, "%-8s %10s %16s %22s %14s %10s\n", "variant", "total", "malloc_dirty", "malloc_reclaimable", "graphics", "jit");
            for (int variant = 0; variant < kVariantCount; variant++) {
                if (!selected[variant]) continue;
                printRow(kVariants[variant].name, readings[variant][i]);
            }
            for (int variant = 0; variant < kVariantCount; variant++) {
                if (variant == kU || !selected[variant] || !selected[kU]) continue;
                char name[16];
                snprintf(name, sizeof(name), "%s-U", kVariants[variant].name);
                printDifference(name, readings[kU][i], readings[variant][i]);
            }
            if (selected[kR] && selected[kS]) printDifference("S-R", readings[kR][i], readings[kS][i]);
        }
        fflush(stdout);

        [window close];
        [window release];
    }
    fprintf(stdout, "end benchmark elapsed %.3f s\n", nowSeconds() - started);
    fflush(stdout);
    return 0;
}}
