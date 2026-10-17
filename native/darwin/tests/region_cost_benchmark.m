// The cost of a document region (docs/spec/native-surfaces.md#document-regions) against a plain web view. One address loads in
// four variants, and each variant loads in a new view in a 1200×760 window with a 1180×400 region:
//   P  a plain web view with a nonpersistent data store;
//   Q  a plain web view with a persistent data store in a temp directory, as the hosts use;
//   R  a document region from sp_document_create with no stream subscribed;
//   S  R with the element and request streams subscribed, and each element snapshot acknowledged.
// For each variant the benchmark reads the physical footprint of the WebContent process of the view 10 seconds and 60 seconds
// after the load finished: the total (ri_phys_footprint), the dirty and reclaimable bytes of WebKit malloc, and the dirty
// bytes of the graphics and JS JIT rows of footprint. The benchmark prints the numbers and asserts nothing. It ends each view
// and its WebContent process before it starts the next variant.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <libproc.h>
#import <signal.h>
#import <errno.h>
#import <string.h>
#import <sys/types.h>
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
enum { kReads = 2, kVariants = 4, kMegabyte = 1048576 };
enum { kVariantP, kVariantQ, kVariantR, kVariantS };
static const char *kVariantNames[] = { "P", "Q", "R", "S" };
static const char *kVariantLabels[] = {
    "plain web view, nonpersistent data store",
    "plain web view, persistent data store in a temp directory",
    "document region, no stream subscribed",
    "document region, element and request streams subscribed and acknowledged",
};

// The footprint of one WebContent process in bytes. A row that footprint does not report is -1.
typedef struct {
    long total;
    long mallocDirty;
    long mallocReclaimable;
    long graphicsDirty;
    long jitDirty;
} Reading;

static double nowSeconds(void) {
    return NSDate.date.timeIntervalSince1970;
}

// Pumps the run loop until done() holds or the limit passes. Returns done().
static BOOL pumpUntil(NSTimeInterval limit, BOOL (^done)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:limit];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
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

// Reads the dirty and reclaimable bytes of the footprint row with the category name. Returns NO when footprint has no such row.
// A row has the form "<dirty> B <clean> B <reclaimable> B <regions> <category>".
static BOOL footprintRow(NSString *text, const char *name, long *dirty, long *reclaimable) {
    NSString *wanted = [NSString stringWithUTF8String:name];
    for (NSString *line in [text componentsSeparatedByString:@"\n"]) {
        long rowDirty = 0;
        long rowClean = 0;
        long rowReclaimable = 0;
        long rowRegions = 0;
        int consumed = 0;
        if (sscanf(line.UTF8String, " %ld B %ld B %ld B %ld %n", &rowDirty, &rowClean, &rowReclaimable, &rowRegions, &consumed) != 4) continue;
        NSString *category = [[line substringFromIndex:consumed] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
        if (![category isEqualToString:wanted]) continue;
        *dirty = rowDirty;
        *reclaimable = rowReclaimable;
        return YES;
    }
    return NO;
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
    Reading reading = { (long)info.ri_phys_footprint, -1, -1, -1, -1 };
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

// Loads the address in one variant, reads the footprint of its WebContent process at each read time, and ends the view and
// its process. The readings are stored in readings[0...kReads-1].
static void measureVariant(int variant, NSView *content, NSURL *address, WKWebsiteDataStore *persistentStore,
    NSString *documentDirectory, Reading readings[kReads]) {
    NSString *step = [NSString stringWithFormat:@"variant %s", kVariantNames[variant]];
    fprintf(stdout, "start %s: %s\n", kVariantNames[variant], kVariantLabels[variant]);
    fflush(stdout);
    double started = nowSeconds();

    WKWebView *view = nil;
    WKWebView *mainView = nil;
    void *surface = NULL;
    void *document = NULL;
    CGRect frame = NSMakeRect(kMarginLeft, kWindowHeight - kMarginTop - kRegionHeight, kRegionWidth, kRegionHeight);
    if (variant == kVariantP || variant == kVariantQ) {
        WKWebViewConfiguration *configuration = [[[WKWebViewConfiguration alloc] init] autorelease];
        configuration.websiteDataStore = variant == kVariantP ? WKWebsiteDataStore.nonPersistentDataStore : persistentStore;
        view = [[[WKWebView alloc] initWithFrame:frame configuration:configuration] autorelease];
        [content addSubview:view];
        [view loadRequest:[NSURLRequest requestWithURL:address]];
    } else {
        // The surface is the main web view of the application: the document region is placed inside it.
        mainView = [[[WKWebView alloc] initWithFrame:content.bounds] autorelease];
        mainView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        [content addSubview:mainView];
        surface = sp_surface_create(mainView);
        if (!surface) failStep(step, @"a logical surface is not created", 0);
        webviewSetFrame(surface, 0, 0, kWindowWidth, kWindowHeight);
        webviewSetSurfaceHidden(surface, false);
        document = sp_document_create(surface, documentDirectory.fileSystemRepresentation, NULL, NULL, documentChanged, NULL);
        if (!document) failStep(step, @"a document view is not created inside the surface", 0);
        view = (WKWebView *)document;
        sp_document_place(document, kMarginLeft, kMarginTop, kMarginRight, kMarginBottom, true);
        if (variant == kVariantS) {
            sp_document_set_stream(document, streamMessage, document);
            if (!sp_document_stream_on(document, "elements", true) || !sp_document_stream_on(document, "requests", true)) {
                failStep(step, @"a document stream is not turned on", view._webProcessIdentifier);
            }
        }
        if (!sp_document_load(document, address.absoluteString.UTF8String)) {
            failStep(step, @"the document refuses the address", view._webProcessIdentifier);
        }
    }

    // The load has finished when the page is not loading and it has a title.
    if (!pumpUntil(stepLimit, ^BOOL { return !view.loading && view.title.length > 0; })) {
        failStep(step, @"the page did not finish loading within 120 seconds", view._webProcessIdentifier);
    }
    pumpUntil(settleSeconds, ^BOOL { return NO; });
    double loaded = nowSeconds();
    pid_t process = view._webProcessIdentifier;
    fprintf(stdout, "loaded %s: pid=%d title=%s elapsed %.3f s\n", kVariantNames[variant], process,
        view.title.UTF8String, loaded - started);
    fflush(stdout);

    for (int i = 0; i < kReads; i++) {
        waitUntil(loaded + readSeconds[i]);
        readings[i] = readFootprint(view, step);
        fprintf(stdout, "read %s at %.0f s: total_mb=%s malloc_dirty_mb=%s malloc_reclaimable_mb=%s graphics_mb=%s jit_mb=%s\n",
            kVariantNames[variant], readSeconds[i], megabytes(readings[i].total),
            megabytes(readings[i].mallocDirty), megabytes(readings[i].mallocReclaimable),
            megabytes(readings[i].graphicsDirty), megabytes(readings[i].jitDirty));
        fflush(stdout);
    }

    // The view, its surface and its WebContent process end here. WebKit keeps an idle WebContent process after its last view
    // closes, so the benchmark ends each process it started.
    pid_t mainProcess = mainView ? mainView._webProcessIdentifier : 0;
    if (document) {
        sp_document_close(document);
    } else {
        [view removeFromSuperview];
    }
    if (surface) {
        sp_surface_close(surface);
        [mainView removeFromSuperview];
    }
    if (!endProcess(process, step)) exit(1);
    if (mainProcess != 0 && mainProcess != process && !endProcess(mainProcess, step)) exit(1);
    fprintf(stdout, "end %s elapsed %.3f s\n", kVariantNames[variant], nowSeconds() - started);
    fflush(stdout);
}

int main(int argc, const char *argv[]) { @autoreleasepool {
    double started = nowSeconds();
    NSString *address = argc > 1 ? [NSString stringWithUTF8String:argv[1]] : @"https://www.google.com/";
    NSURL *url = [NSURL URLWithString:address];
    if (!url.scheme || !url.host) {
        fprintf(stderr, "FAIL: the address %s is not an absolute address\n", address.UTF8String);
        return 1;
    }
    fprintf(stdout, "start benchmark address=%s\n", address.UTF8String);
    fflush(stdout);
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, kWindowWidth, kWindowHeight)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    NSView *content = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, kWindowWidth, kWindowHeight)] autorelease];
    window.contentView = content;
    // orderBack does not activate the application.
    [window orderBack:nil];

    // The persistent store of Q is one store for the directory, as the hosts keep one store per directory. The document
    // variants use another directory, so that two store objects never write the same files.
    NSString *root = [NSTemporaryDirectory() stringByAppendingPathComponent:
        [NSString stringWithFormat:@"soksak-region-cost-%d", getpid()]];
    NSString *persistentDirectory = [root stringByAppendingPathComponent:@"persistent"];
    NSString *documentDirectory = [root stringByAppendingPathComponent:@"documents"];
    if (![NSFileManager.defaultManager createDirectoryAtPath:persistentDirectory withIntermediateDirectories:YES attributes:nil error:nil]) {
        fprintf(stderr, "FAIL: the persistent directory %s cannot be created\n", persistentDirectory.UTF8String);
        return 1;
    }
    _WKWebsiteDataStoreConfiguration *storeConfiguration = [[[_WKWebsiteDataStoreConfiguration alloc]
        initWithDirectory:[NSURL fileURLWithPath:persistentDirectory isDirectory:YES]] autorelease];
    WKWebsiteDataStore *persistentStore = [[[WKWebsiteDataStore alloc] _initWithConfiguration:storeConfiguration] autorelease];
    if (!persistentStore) {
        fprintf(stderr, "FAIL: the persistent data store is not created\n");
        return 1;
    }

    Reading readings[kVariants][kReads];
    for (int variant = 0; variant < kVariants; variant++) {
        measureVariant(variant, content, url, persistentStore, documentDirectory, readings[variant]);
    }

    // The table: the reads of each variant, then the differences R-P and S-R at each read time.
    for (int i = 0; i < kReads; i++) {
        fprintf(stdout, "\nread at %.0f s (MB)\n", readSeconds[i]);
        fprintf(stdout, "%-8s %10s %16s %22s %14s %10s\n", "variant", "total", "malloc_dirty", "malloc_reclaimable", "graphics", "jit");
        for (int variant = 0; variant < kVariants; variant++) {
            Reading reading = readings[variant][i];
            fprintf(stdout, "%-8s %10s %16s %22s %14s %10s\n", kVariantNames[variant], megabytes(reading.total),
                megabytes(reading.mallocDirty), megabytes(reading.mallocReclaimable),
                megabytes(reading.graphicsDirty), megabytes(reading.jitDirty));
        }
        Reading p = readings[kVariantP][i];
        Reading q = readings[kVariantQ][i];
        Reading r = readings[kVariantR][i];
        Reading s = readings[kVariantS][i];
        fprintf(stdout, "%-8s %10s %16s %22s %14s %10s\n", "R-P", differenceMegabytes(p.total, r.total),
            differenceMegabytes(p.mallocDirty, r.mallocDirty), differenceMegabytes(p.mallocReclaimable, r.mallocReclaimable),
            differenceMegabytes(p.graphicsDirty, r.graphicsDirty), differenceMegabytes(p.jitDirty, r.jitDirty));
        fprintf(stdout, "%-8s %10s %16s %22s %14s %10s\n", "S-R", differenceMegabytes(r.total, s.total),
            differenceMegabytes(r.mallocDirty, s.mallocDirty), differenceMegabytes(r.mallocReclaimable, s.mallocReclaimable),
            differenceMegabytes(r.graphicsDirty, s.graphicsDirty), differenceMegabytes(r.jitDirty, s.jitDirty));
        fprintf(stdout, "%-8s %10s %16s %22s %14s %10s\n", "Q-P", differenceMegabytes(p.total, q.total),
            differenceMegabytes(p.mallocDirty, q.mallocDirty), differenceMegabytes(p.mallocReclaimable, q.mallocReclaimable),
            differenceMegabytes(p.graphicsDirty, q.graphicsDirty), differenceMegabytes(p.jitDirty, q.jitDirty));
    }
    fflush(stdout);

    [window close];
    [window release];
    [NSFileManager.defaultManager removeItemAtPath:root error:nil];
    fprintf(stdout, "end benchmark elapsed %.3f s\n", nowSeconds() - started);
    fflush(stdout);
    return 0;
}}
