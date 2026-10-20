// The cost of running many plugin views, each in its own WebContent process. For each count N of views in one window, the
// benchmark runs two variants:
//   D  the default process assignment of WebKit, which chooses the WebContent processes of the views;
//   P  each view forced into a new WebContent process by the navigation policy _WKNavigationActionPolicyAllowInNewProcess,
//      the private policy that src/webview_navigation.m uses for the main document of the app DOM webview.
// All views load the same small local page with one base URL, so they share one origin. For each variant and count the
// benchmark prints:
//   processes  the number of distinct WebContent processes of the views, the total and the per-process physical footprint
//              (ri_phys_footprint of RUSAGE_INFO_V4), and the time from creating the views to the navigation finish of all;
//   closed     after the views are removed, the processes that exit within closeWaitSeconds (exited) and the processes that
//              are still alive (retained), with the footprint of the retained processes. The exits are observed through
//              DISPATCH_PROC_EXIT events. A retained process is a measurement, not a failure: the benchmark sends no signal
//              to any WebContent process;
//   reuse      a fresh set of N views of the same variant, and how many of its views run in a process retained before it.
//              A count that stays bounded across the steps shows that the retained processes are reused, not accumulated.
// The benchmark fails when a navigation does not finish within stepLimit, or when a process cannot be observed. At the end it
// prints the number of retained processes and writes the pids of the retained processes to the file of --pid-file. The
// Makefile target checks that none of those pids exists after the benchmark exits.
// --counts N,N,... measures the listed counts in the listed order (default 1,5,10,20,40).
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <libproc.h>
#import <sys/resource.h>
#import <errno.h>
#import <stdlib.h>
#import <string.h>
#import "private/webkit.h"

// Waits at most this many seconds for each navigation (AGENTS: a step that cannot finish is reported with its measured state).
static const NSTimeInterval stepLimit = 120;
// The bound of the wait for the exit of the processes of closed views. It only ends the wait; a process alive after it is retained.
static const NSTimeInterval closeWaitSeconds = 10;
static const long kDefaultCounts[] = { 1, 5, 10, 20, 40 };
static const long kMaxCount = 200;
static const CGFloat kWindowWidth = 1200;
static const CGFloat kWindowHeight = 760;
static const CGFloat kCellWidth = 120;
static const CGFloat kCellHeight = 80;
static const int kColumns = 10;
static const double kMegabyte = 1048576;
static NSString *const kPage = @"<!doctype html><meta charset=\"utf-8\"><title>view</title><p>view process benchmark</p>";
static NSString *const kBaseURL = @"http://view-processes.benchmark/";

// Every WebContent process that the benchmark observed, and the observed processes whose exit event has arrived.
static NSMutableSet<NSNumber *> *observedProcesses;
static NSMutableSet<NSNumber *> *exitedProcesses;
// The id of the last view created; the view and its delegate of one creation share the id.
static unsigned long lastViewId = 0;

// Test-only subclass that logs its deallocation with the id of the view, to show whether WebKit releases the view after it closes.
@interface ViewProbe : WKWebView
@property (nonatomic) unsigned long probeId;
@end

@implementation ViewProbe
- (void)dealloc {
    fprintf(stdout, "dealloc view id=%lu\n", self.probeId);
    fflush(stdout);
    [super dealloc];
}
@end

// Records the navigation outcome of one view. The policy answers AllowInNewProcess for the main frame when forceNewProcess is set.
@interface ViewDelegate : NSObject <WKNavigationDelegate>
@property (nonatomic) BOOL forceNewProcess;
@property (nonatomic) BOOL finished;
@property (nonatomic, copy) NSString *failure;
@property (nonatomic) unsigned long delegateId;
@end

@implementation ViewDelegate
- (void)dealloc {
    fprintf(stdout, "dealloc delegate id=%lu\n", self.delegateId);
    fflush(stdout);
    [super dealloc];
}

- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)action
    decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    BOOL mainFrame = action.targetFrame.isMainFrame;
    decisionHandler(self.forceNewProcess && mainFrame ? SPNavigationActionPolicyAllowInNewProcess : WKNavigationActionPolicyAllow);
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    self.finished = YES;
}

- (void)webView:(WKWebView *)webView didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    self.failure = error.localizedDescription;
}

- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    self.failure = error.localizedDescription;
}
@end

static double nowSeconds(void) {
    return NSDate.date.timeIntervalSince1970;
}

// Sends the application events until done() holds or the limit passes. Returns done(). The run loop is driven here, not by
// NSApp run, so each turn has its own autorelease pool; the objects that WebKit autoreleases during a turn are released at its end.
static BOOL pumpUntil(NSTimeInterval limit, BOOL (^done)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:limit];
    while (!done() && deadline.timeIntervalSinceNow > 0) {
        @autoreleasepool {
            NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskAny untilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]
                inMode:NSDefaultRunLoopMode dequeue:YES];
            if (event) [NSApp sendEvent:event];
        }
    }
    return done();
}

// Exits with the step and the reason when a step cannot run. The benchmark leaves the WebContent processes it started as they are.
static void failStep(NSString *step, NSString *reason) {
    fprintf(stderr, "FAIL: step %s: %s\n", step.UTF8String, reason.UTF8String);
    exit(1);
}

// Observes the exit of the process unless it is already observed and alive. The handler records the exit in exitedProcesses.
// A pid that exited and is now used by another process is observed again.
static void observeProcess(pid_t process, NSString *step) {
    NSNumber *key = @(process);
    if ([observedProcesses containsObject:key] && ![exitedProcesses containsObject:key]) return;
    [exitedProcesses removeObject:key];
    dispatch_source_t source = dispatch_source_create(DISPATCH_SOURCE_TYPE_PROC, process, DISPATCH_PROC_EXIT,
        dispatch_get_main_queue());
    if (!source) failStep(step, [NSString stringWithFormat:@"the exit observation of the process %d cannot start", process]);
    dispatch_source_set_event_handler(source, ^{
        [exitedProcesses addObject:key];
        dispatch_source_cancel(source);
    });
    dispatch_resume(source);
    [observedProcesses addObject:key];
}

// The physical footprint of the process in bytes. Exits with the step when proc_pid_rusage cannot read the process.
static long long physicalFootprint(pid_t process, NSString *step) {
    struct rusage_info_v4 info;
    if (proc_pid_rusage(process, RUSAGE_INFO_V4, (rusage_info_t *)&info) != 0) {
        failStep(step, [NSString stringWithFormat:@"proc_pid_rusage cannot read the process %d: %s", process, strerror(errno)]);
    }
    return (long long)info.ri_phys_footprint;
}

// The observed processes whose exit event has not arrived.
static NSMutableSet<NSNumber *> *liveProcesses(void) {
    NSMutableSet<NSNumber *> *live = [NSMutableSet setWithSet:observedProcesses];
    [live minusSet:exitedProcesses];
    return live;
}

// Opens a window in which the views are placed. The window is ordered back, which does not activate the application.
static NSWindow *openWindow(void) {
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, kWindowWidth, kWindowHeight)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, kWindowWidth, kWindowHeight)] autorelease];
    [window orderBack:nil];
    return window;
}

// The WebContent process of each view in the order of the views. Exits with the step when a view has no process.
static NSArray<NSNumber *> *processesOf(NSArray<WKWebView *> *views, NSString *step) {
    NSMutableArray<NSNumber *> *processes = [NSMutableArray array];
    for (WKWebView *view in views) {
        pid_t process = view._webProcessIdentifier;
        if (process == 0) failStep(step, @"a view has no WebContent process after its navigation finished");
        [processes addObject:@(process)];
    }
    return processes;
}

// Creates count views in the window, starts the load of the page in each, and waits for the navigation of all of them. It stores
// the seconds from the creation to the last finish. The autorelease pool of the step drains the objects that WebKit autoreleases
// while the views are created and loaded.
static void loadViews(NSWindow *window, NSUInteger count, BOOL forceNewProcess, NSString *step, double *seconds,
    NSMutableArray<WKWebView *> *views, NSMutableArray<ViewDelegate *> *delegates) {
    @autoreleasepool {
    NSURL *base = [NSURL URLWithString:kBaseURL];
    double created = nowSeconds();
    for (NSUInteger i = 0; i < count; i++) {
        @autoreleasepool {
            NSInteger column = (NSInteger)(i % kColumns);
            NSInteger row = (NSInteger)(i / kColumns);
            NSRect frame = NSMakeRect(column * kCellWidth, kWindowHeight - (row + 1) * kCellHeight, kCellWidth, kCellHeight);
            ViewProbe *view = [[ViewProbe alloc] initWithFrame:frame configuration:[[[WKWebViewConfiguration alloc] init] autorelease]];
            lastViewId++;
            view.probeId = lastViewId;
            ViewDelegate *delegate = [[ViewDelegate alloc] init];
            delegate.delegateId = lastViewId;
            delegate.forceNewProcess = forceNewProcess;
            view.navigationDelegate = delegate;
            [views addObject:view];
            [delegates addObject:delegate];
            [view release];
            [delegate release];
            [window.contentView addSubview:views.lastObject];
            [views.lastObject loadHTMLString:kPage baseURL:base];
        }
    }
    fprintf(stdout, "created %s views=%lu\n", step.UTF8String, (unsigned long)count);
    fflush(stdout);

    BOOL finished = pumpUntil(stepLimit, ^BOOL {
        for (ViewDelegate *delegate in delegates) {
            if (!delegate.finished && !delegate.failure) return NO;
        }
        return YES;
    });
    for (ViewDelegate *delegate in delegates) {
        if (delegate.failure) failStep(step, [NSString stringWithFormat:@"a navigation failed: %@", delegate.failure]);
    }
    if (!finished) {
        NSUInteger pending = 0;
        for (ViewDelegate *delegate in delegates) if (!delegate.finished) pending++;
        failStep(step, [NSString stringWithFormat:@"%lu of %lu navigations did not finish within %g seconds", (unsigned long)pending,
            (unsigned long)count, stepLimit]);
    }
    *seconds = nowSeconds() - created;
    }
}

// Removes the views and closes the window, then waits up to closeWaitSeconds for the exit of each process. Prints the exited and
// retained processes with the footprint of the retained ones, and returns the number of retained processes. The window is released.
static NSUInteger closeViews(NSWindow *window, NSOrderedSet<NSNumber *> *processes, NSString *step, const char *label,
    NSMutableArray<WKWebView *> *views, NSMutableArray<ViewDelegate *> *delegates) {
    double closing = nowSeconds();
    // The weak references and the ids are taken before the strong references are dropped. A weak reference does not keep its
    // object alive, so a non-nil weak reference after the wait shows that something else still holds the object.
    NSPointerArray *weakViews = [NSPointerArray weakObjectsPointerArray];
    NSPointerArray *weakDelegates = [NSPointerArray weakObjectsPointerArray];
    NSMutableArray<NSNumber *> *viewIds = [NSMutableArray array];
    // Growing a weak pointer array re-reads its entries as weak references, and each read returns the object autoreleased.
    // The pool of this block drains those reads here, so that they do not keep the views alive during the wait.
    @autoreleasepool {
        for (ViewProbe *view in views) {
            [weakViews addPointer:(void *)view];
            [viewIds addObject:@(view.probeId)];
        }
        for (ViewDelegate *delegate in delegates) [weakDelegates addPointer:(void *)delegate];
    }
    @autoreleasepool {
        for (WKWebView *view in views) {
            view.navigationDelegate = nil;
            [view removeFromSuperview];
        }
        [views removeAllObjects];
        [delegates removeAllObjects];
        [window close];
        [window release];
    }
    pumpUntil(closeWaitSeconds, ^BOOL {
        for (NSNumber *process in processes) {
            if (![exitedProcesses containsObject:process]) return NO;
        }
        return YES;
    });
    NSUInteger exited = 0;
    NSUInteger retained = 0;
    long long retainedBytes = 0;
    for (NSNumber *process in processes) {
        if ([exitedProcesses containsObject:process]) {
            exited++;
        } else {
            retained++;
            retainedBytes += physicalFootprint(process.intValue, step);
        }
    }
    NSUInteger viewsAlive = 0;
    NSUInteger delegatesAlive = 0;
    // Reading a weak entry returns the object retained and autoreleased, so the reads have their own pool that drains after them.
    for (NSUInteger i = 0; i < weakViews.count; i++) {
        @autoreleasepool {
            BOOL viewAlive = [weakViews pointerAtIndex:i] != NULL;
            BOOL delegateAlive = [weakDelegates pointerAtIndex:i] != NULL;
            if (viewAlive) viewsAlive++;
            if (delegateAlive) delegatesAlive++;
            fprintf(stdout, "%s %s view id=%lu view_alive=%d delegate_alive=%d\n", step.UTF8String, label,
                viewIds[i].unsignedLongValue, viewAlive, delegateAlive);
        }
    }
    fprintf(stdout, "%s %s closed exited=%lu retained=%lu retained_mb=%.1f views_alive=%lu delegates_alive=%lu exit_s=%.3f\n",
        step.UTF8String, label, (unsigned long)exited, (unsigned long)retained, (double)retainedBytes / kMegabyte,
        (unsigned long)viewsAlive, (unsigned long)delegatesAlive, nowSeconds() - closing);
    fflush(stdout);
    return retained;
}

// Measures one count and one variant: the views and their processes, the close, and a fresh set of views that reuses the
// processes retained by the close.
static void measure(NSUInteger count, BOOL forceNewProcess) {
    NSString *step = [NSString stringWithFormat:@"N=%lu variant=%@", (unsigned long)count, forceNewProcess ? @"P" : @"D"];
    fprintf(stdout, "start %s\n", step.UTF8String);
    fflush(stdout);

    NSWindow *window = openWindow();
    NSMutableArray<WKWebView *> *views = [NSMutableArray array];
    NSMutableArray<ViewDelegate *> *delegates = [NSMutableArray array];
    double loaded = 0;
    loadViews(window, count, forceNewProcess, step, &loaded, views, delegates);
    NSArray<NSNumber *> *viewProcesses = processesOf(views, step);
    NSOrderedSet<NSNumber *> *processes = [NSOrderedSet orderedSetWithArray:viewProcesses];
    long long total = 0;
    for (NSNumber *process in processes) {
        observeProcess(process.intValue, step);
        total += physicalFootprint(process.intValue, step);
    }
    double totalMegabytes = (double)total / kMegabyte;
    fprintf(stdout, "%s processes=%lu total_mb=%.1f per_process_mb=%.1f load_s=%.3f\n", step.UTF8String,
        (unsigned long)processes.count, totalMegabytes, totalMegabytes / processes.count, loaded);
    fflush(stdout);
    closeViews(window, processes, step, "views", views, delegates);

    // The fresh set reuses the processes that remain alive after the close. A view reuses a retained process when its process
    // is one of those.
    NSSet<NSNumber *> *retainedBefore = liveProcesses();
    NSString *freshStep = [step stringByAppendingString:@" fresh"];
    window = openWindow();
    [views removeAllObjects];
    [delegates removeAllObjects];
    loadViews(window, count, forceNewProcess, freshStep, &loaded, views, delegates);
    NSArray<NSNumber *> *freshProcesses = processesOf(views, freshStep);
    NSUInteger reused = 0;
    for (NSNumber *process in freshProcesses) {
        if ([retainedBefore containsObject:process]) reused++;
    }
    fprintf(stdout, "%s reuse views=%lu reused=%lu retained_before=%lu load_s=%.3f\n", step.UTF8String, (unsigned long)count,
        (unsigned long)reused, (unsigned long)retainedBefore.count, loaded);
    fflush(stdout);
    NSOrderedSet<NSNumber *> *freshSet = [NSOrderedSet orderedSetWithArray:freshProcesses];
    for (NSNumber *process in freshSet) observeProcess(process.intValue, freshStep);
    closeViews(window, freshSet, freshStep, "fresh views", views, delegates);
}

int main(int argc, const char *argv[]) { @autoreleasepool {
    double started = nowSeconds();
    NSMutableArray<NSNumber *> *counts = [NSMutableArray array];
    NSString *pidFile = nil;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--counts") == 0) {
            if (i + 1 >= argc) {
                fprintf(stderr, "FAIL: --counts needs a comma-separated list of counts\n");
                return 1;
            }
            NSArray<NSString *> *parts = [@(argv[++i]) componentsSeparatedByString:@","];
            for (NSString *part in parts) {
                char *end = NULL;
                long value = strtol(part.UTF8String, &end, 10);
                if (part.length == 0 || *end != '\0' || value < 1 || value > kMaxCount) {
                    fprintf(stderr, "FAIL: --counts takes whole numbers from 1 to %ld, not %s\n", kMaxCount, part.UTF8String);
                    return 1;
                }
                [counts addObject:@(value)];
            }
        } else if (strcmp(argv[i], "--pid-file") == 0) {
            if (i + 1 >= argc) {
                fprintf(stderr, "FAIL: --pid-file needs a path\n");
                return 1;
            }
            pidFile = @(argv[++i]);
        } else {
            fprintf(stderr, "FAIL: the argument %s is not expected\n", argv[i]);
            return 1;
        }
    }
    if (!pidFile) {
        fprintf(stderr, "FAIL: --pid-file PATH is required\n");
        return 1;
    }
    if (counts.count == 0) {
        for (size_t i = 0; i < sizeof(kDefaultCounts) / sizeof(kDefaultCounts[0]); i++) [counts addObject:@(kDefaultCounts[i])];
    }
    fprintf(stdout, "start benchmark counts=%s\n", [[counts componentsJoinedByString:@","] UTF8String]);
    fflush(stdout);

    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    observedProcesses = [NSMutableSet set];
    exitedProcesses = [NSMutableSet set];
    for (NSNumber *count in counts) {
        // Each step has its own pool, so the objects that WebKit and the step autorelease are released when the step ends.
        @autoreleasepool {
            measure(count.unsignedIntegerValue, NO);
        }
        @autoreleasepool {
            measure(count.unsignedIntegerValue, YES);
        }
    }

    // The processes still alive at the end are written for the check of the Makefile target, which runs after this binary exits.
    NSSet<NSNumber *> *retained = liveProcesses();
    NSMutableArray<NSString *> *lines = [NSMutableArray array];
    for (NSNumber *process in retained) [lines addObject:[process stringValue]];
    NSError *writeError = nil;
    NSString *content = [lines componentsJoinedByString:@"\n"];
    if (![[content stringByAppendingString:@"\n"] writeToFile:pidFile atomically:YES encoding:NSUTF8StringEncoding error:&writeError]) {
        fprintf(stderr, "FAIL: the pid file %s cannot be written: %s\n", pidFile.UTF8String, writeError.localizedDescription.UTF8String);
        return 1;
    }
    fprintf(stdout, "end benchmark observed=%lu exited=%lu retained_total=%lu elapsed %.3f s\n",
        (unsigned long)observedProcesses.count, (unsigned long)exitedProcesses.count, (unsigned long)retained.count,
        nowSeconds() - started);
    fflush(stdout);
    return 0;
}}
