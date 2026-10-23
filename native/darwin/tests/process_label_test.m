// Measure URL-derived and explicit WebKit process display names without activating the application.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <libproc.h>
#import <errno.h>
#import <signal.h>
#import <stdio.h>
#import <stdlib.h>
#import <string.h>
#import <unistd.h>
#include "soksak_process_identity.h"
#import "private/webkit.h"
#import "document_view.h"
#import "support/temporary_folder.h"
#import "support/view_import_map.h"
#import "webview_geometry.h"

static int failures;
static NSString *pluginViewState;
static NSString *pluginViewStateFailure;
static NSString *secondPluginViewState;

static int waitForControlByte(const char *helperName) {
    char controlByte = 0;
    ssize_t count;
    do {
        count = read(STDIN_FILENO, &controlByte, sizeof(controlByte));
    } while (count < 0 && errno == EINTR);
    if (count == 1) return 0;
    if (count == 0) {
        fprintf(stderr, "HELPER_ERROR %s control input reached EOF before handshake\n", helperName);
    } else {
        fprintf(stderr, "HELPER_ERROR %s control read failed: %s\n", helperName, strerror(errno));
    }
    return 1;
}

static BOOL writeControlByte(int descriptor, const char *helperName) {
    const char controlByte = 'x';
    ssize_t count;
    do {
        count = write(descriptor, &controlByte, sizeof(controlByte));
    } while (count < 0 && errno == EINTR);
    if (count == 1) return YES;
    fprintf(stderr, "CONTROL_ERROR %s write failed: %s\n", helperName,
        count == 0 ? "no data written" : strerror(errno));
    return NO;
}

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static void pluginStateChanged(void *context, const char *state) {
    NSString **target = context ? context : &pluginViewState;
    [*target release];
    *target = [[NSString alloc] initWithUTF8String:state];
    if (!*target && target == &pluginViewState) {
        [pluginViewStateFailure release];
        pluginViewStateFailure = [@"plugin state is not valid UTF-8" copy];
    }
}

static NSString *configuredValue(NSString *key, NSString *fallback) {
    NSString *value = NSProcessInfo.processInfo.environment[key];
    return value.length ? value : fallback;
}

static BOOL until(BOOL (^done)(void), NSTimeInterval seconds) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:seconds];
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

@interface SPJavaScriptResult : NSObject
@property BOOL completed;
@property (nonatomic, copy) NSString *url;
@property (nonatomic, copy) NSString *failure;
@end

@implementation SPJavaScriptResult
- (void)dealloc {
    [_url release];
    [_failure release];
    [super dealloc];
}
@end

@interface SPProcessOutput : NSObject
@property (nonatomic, copy) NSData *standardOutput;
@property (nonatomic, copy) NSData *standardError;
@end

@implementation SPProcessOutput
- (void)dealloc {
    [_standardOutput release];
    [_standardError release];
    [super dealloc];
}
@end

static NSString *processListing(pid_t pid, NSString **displayName, NSString **failure) {
    NSTask *task = [[[NSTask alloc] init] autorelease];
    task.executableURL = [NSURL fileURLWithPath:@"/usr/bin/lsappinfo"];
    task.arguments = @[@"list"];
    NSPipe *outputPipe = [NSPipe pipe];
    NSPipe *errorPipe = [NSPipe pipe];
    task.standardOutput = outputPipe;
    task.standardError = errorPipe;
    NSError *launchError = nil;
    if (![task launchAndReturnError:&launchError]) {
        *failure = [NSString stringWithFormat:@"lsappinfo launch failed: %@", launchError];
        return nil;
    }

    NSFileHandle *outputReader = outputPipe.fileHandleForReading;
    NSFileHandle *errorReader = errorPipe.fileHandleForReading;
    SPProcessOutput *processOutput = [[SPProcessOutput alloc] init];
    dispatch_group_t drained = dispatch_group_create();
    dispatch_group_enter(drained);
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        processOutput.standardOutput = [outputReader readDataToEndOfFile];
        dispatch_group_leave(drained);
    });
    dispatch_group_enter(drained);
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        processOutput.standardError = [errorReader readDataToEndOfFile];
        dispatch_group_leave(drained);
    });
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:5];
    while (task.isRunning && deadline.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                                 beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
    if (task.isRunning) {
        [task terminate];
        [task waitUntilExit];
        dispatch_group_wait(drained, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC));
        *failure = @"lsappinfo list exceeded 5000ms";
        dispatch_release(drained);
        [processOutput release];
        return nil;
    }
    if (dispatch_group_wait(drained, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC)) != 0) {
        *failure = @"lsappinfo output did not reach EOF after process exit";
        dispatch_release(drained);
        [processOutput release];
        return nil;
    }
    dispatch_release(drained);
    NSData *output = processOutput.standardOutput;
    NSData *errors = processOutput.standardError;
    if (task.terminationReason != NSTaskTerminationReasonExit || task.terminationStatus != 0) {
        NSString *errorText = [[[NSString alloc] initWithData:errors encoding:NSUTF8StringEncoding] autorelease];
        *failure = [NSString stringWithFormat:@"lsappinfo exited with reason %ld status %d: %@",
            (long)task.terminationReason, task.terminationStatus, errorText];
        [processOutput release];
        return nil;
    }
    NSString *text = [[[NSString alloc] initWithData:output encoding:NSUTF8StringEncoding] autorelease];
    if (text == nil) {
        *failure = @"lsappinfo output is not UTF-8";
        [processOutput release];
        return nil;
    }
    NSArray<NSString *> *lines = [text componentsSeparatedByCharactersInSet:NSCharacterSet.newlineCharacterSet];
    NSString *pidNeedle = [NSString stringWithFormat:@"pid = %d ", pid];
    NSUInteger entryLine = NSNotFound;
    for (NSUInteger index = 0; index < lines.count; index++) {
        if ([lines[index] containsString:pidNeedle]) {
            entryLine = index;
            break;
        }
    }
    if (entryLine == NSNotFound) {
        *failure = [NSString stringWithFormat:@"lsappinfo has no process entry for pid %d", pid];
        [processOutput release];
        return nil;
    }
    NSUInteger start = entryLine;
    while (start > 0 && ![lines[start] containsString:@" ASN:"]) start--;
    if (![lines[start] containsString:@" ASN:"]) {
        *failure = [NSString stringWithFormat:@"lsappinfo pid %d entry has no ASN display-name line", pid];
        [processOutput release];
        return nil;
    }
    NSRange labelRange = [lines[start] rangeOfString:@"^\\s*\\d+\\) \"([^\"]+)\" ASN:"
        options:NSRegularExpressionSearch];
    if (labelRange.location == NSNotFound) {
        *failure = [NSString stringWithFormat:@"lsappinfo pid %d entry has no quoted display name: %@", pid, lines[start]];
        [processOutput release];
        return nil;
    }
    NSRegularExpression *regex = [NSRegularExpression regularExpressionWithPattern:
        @"^\\s*\\d+\\) \"([^\"]+)\" ASN:" options:0 error:nil];
    NSTextCheckingResult *match = [regex firstMatchInString:lines[start] options:0
        range:NSMakeRange(0, lines[start].length)];
    if (match == nil || match.numberOfRanges < 2) {
        *failure = [NSString stringWithFormat:@"lsappinfo pid %d display name could not be parsed", pid];
        [processOutput release];
        return nil;
    }
    *displayName = [lines[start] substringWithRange:[match rangeAtIndex:1]];
    NSString *result = [[lines subarrayWithRange:NSMakeRange(start, entryLine - start + 1)] componentsJoinedByString:@"\n"];
    [processOutput release];
    return result;
}

static pid_t measure(NSWindow *window, SPProcessLabelScheme *handler,
    NSString *caseName, NSString *address, NSString *displayName) {
    WKWebViewConfiguration *configuration = [[WKWebViewConfiguration alloc] init];
    [configuration setURLSchemeHandler:handler forURLScheme:@"soksak"];
    if (displayName) [configuration _setProcessDisplayName:displayName];
    WKWebView *view = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 640, 240) configuration:configuration];
    [configuration release];
    [window.contentView addSubview:view];
    SPProcessLabelNavigation *navigation = [[SPProcessLabelNavigation alloc] init];
    view.navigationDelegate = navigation;
    [view loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:address]]];
    BOOL navigationFinished = until(^BOOL { return navigation.finished; }, 15);
    check(navigationFinished, [NSString stringWithFormat:@"%@ navigation finishes within 15000ms", caseName]);
    check(navigation.failure == nil, [NSString stringWithFormat:@"%@ navigation succeeds: %@", caseName, navigation.failure]);
    if (!navigationFinished || navigation.failure) {
        view.navigationDelegate = nil;
        [view stopLoading];
        [view removeFromSuperview];
        [view release];
        [navigation release];
        return 0;
    }

    SPJavaScriptResult *evaluation = [[SPJavaScriptResult alloc] init];
    [view evaluateJavaScript:@"location.href" completionHandler:^(id result, NSError *error) {
        if ([result isKindOfClass:NSString.class]) evaluation.url = result;
        if (error) evaluation.failure = error.localizedDescription;
        evaluation.completed = YES;
    }];
    BOOL evaluationFinished = until(^BOOL { return evaluation.completed; }, 5);
    check(evaluationFinished, [NSString stringWithFormat:@"%@ URL evaluation finishes within 5000ms", caseName]);
    check(evaluation.failure == nil, [NSString stringWithFormat:@"%@ URL evaluation succeeds: %@", caseName, evaluation.failure]);
    check(evaluation.url && [evaluation.url isEqualToString:address],
        [NSString stringWithFormat:@"%@ keeps the requested URL origin", caseName]);

    pid_t pid = view._webProcessIdentifier;
    check(pid > 0, [NSString stringWithFormat:@"%@ has a WebContent process", caseName]);
    char name[PROC_PIDPATHINFO_MAXSIZE] = {0};
    char path[PROC_PIDPATHINFO_MAXSIZE] = {0};
    int nameLength = pid > 0 ? proc_name(pid, name, sizeof(name)) : -1;
    int pathLength = pid > 0 ? proc_pidpath(pid, path, sizeof(path)) : -1;
    check(nameLength > 0, [NSString stringWithFormat:@"%@ proc_name succeeds for pid %d", caseName, pid]);
    check(pathLength > 0, [NSString stringWithFormat:@"%@ proc_pidpath succeeds for pid %d", caseName, pid]);
    NSString *reportedProcessName = nameLength > 0 ? [NSString stringWithUTF8String:name] : nil;
    NSString *reportedProcessPath = pathLength > 0 ? [NSString stringWithUTF8String:path] : nil;
    check(reportedProcessName != nil, [NSString stringWithFormat:@"%@ proc_name is valid UTF-8", caseName]);
    check(reportedProcessPath != nil, [NSString stringWithFormat:@"%@ proc_pidpath is valid UTF-8", caseName]);

    NSString *launchServicesName = nil;
    NSString *listingFailure = nil;
    NSString *listing = pid > 0 ? processListing(pid, &launchServicesName, &listingFailure) : nil;
    check(listing != nil, [NSString stringWithFormat:@"%@ LaunchServices lookup succeeds: %@", caseName, listingFailure]);
    if (listing) {
        printf("LAUNCHSERVICES case=%s displayName=%s %s\n", caseName.UTF8String,
            launchServicesName.UTF8String, listing.UTF8String);
        if (displayName) {
            check([launchServicesName isEqualToString:displayName],
                [NSString stringWithFormat:@"%@ LaunchServices display name equals %@ (got %@)", caseName,
                    displayName, launchServicesName]);
        } else {
            check(![launchServicesName isEqualToString:address],
                [NSString stringWithFormat:@"%@ URL path does not become the LaunchServices display name (got %@)",
                    caseName, launchServicesName]);
        }
    }
    printf("MEASURE case=%s requested=%s loaded=%s override=%s webContentPid=%d proc_name=%s proc_pidpath=%s\n",
        caseName.UTF8String, address.UTF8String, evaluation.url.UTF8String ?: "<unavailable>",
        displayName.UTF8String ?: "<none>", pid, reportedProcessName.UTF8String ?: "<unavailable>",
        reportedProcessPath.UTF8String ?: "<unavailable>");
    fflush(stdout);

    view.navigationDelegate = nil;
    [view stopLoading];
    [view removeFromSuperview];
    [view release];
    [navigation release];
    [evaluation release];
    return pid;
}

static pid_t measureCorePluginViewLabel(NSWindow *window) {
    NSString *root = temporaryFolder(@"soksak-plugin-label-");
    NSString *folder = [root stringByAppendingPathComponent:@"probe"];
    NSString *store = [root stringByAppendingPathComponent:@"store"];
    NSString *page = [folder stringByAppendingPathComponent:@"page.html"];
    NSError *failure = nil;
    BOOL created = [[NSFileManager defaultManager] createDirectoryAtPath:folder withIntermediateDirectories:YES
        attributes:nil error:&failure];
    check(created, [NSString stringWithFormat:@"plugin fixture directory is created: %@", failure]);
    if (!created) return 0;
    NSString *html = @"<!doctype html><html><head><meta charset='utf-8'></head><body>plugin label</body></html>";
    failure = nil;
    BOOL written = [html writeToFile:page atomically:YES encoding:NSUTF8StringEncoding error:&failure];
    check(written,
        [NSString stringWithFormat:@"plugin fixture page is written: %@", failure]);
    if (!written) return 0;
    sp_view_import_map_set(viewImportMapFixture().UTF8String);
    WKWebView *main = [[WKWebView alloc] initWithFrame:window.contentView.bounds];
    [window.contentView addSubview:main];
    void *surface = sp_surface_create((__bridge void *)main);
    check(surface != NULL, @"core creates the plugin surface host");
    void *document = surface ? sp_document_create(surface, store.fileSystemRepresentation,
        folder.fileSystemRepresentation, "probe", "window.sokView = 1;", pluginStateChanged, NULL) : NULL;
    check(document != NULL, [NSString stringWithFormat:@"core creates the plugin view: %s", sp_document_last_error()]);
    if (!document) {
        if (surface) sp_surface_close(surface);
        [main removeFromSuperview];
        [main release];
        return 0;
    }
    WKWebView *view = (__bridge WKWebView *)document;
    [pluginViewState release];
    pluginViewState = nil;
    [pluginViewStateFailure release];
    pluginViewStateFailure = nil;
    check(sp_document_load(document, "soksak://probe/page.html"), @"core plugin view accepts its canonical isolated origin");
    BOOL pageLoaded = until(^BOOL {
        NSData *stateData = [pluginViewState dataUsingEncoding:NSUTF8StringEncoding];
        NSError *parseError = nil;
        NSDictionary *state = stateData ? [NSJSONSerialization JSONObjectWithData:stateData options:0 error:&parseError] : nil;
        if (stateData && !state && !pluginViewStateFailure) {
            pluginViewStateFailure = [(parseError.localizedDescription ?: @"plugin state JSON is absent or not an object") copy];
        }
        return [state[@"url"] isEqual:@"soksak://probe/page.html"] && ![state[@"loading"] boolValue];
    }, 15);
    check(pageLoaded, [NSString stringWithFormat:@"core plugin page reaches loaded state within 15000ms (got %@)", pluginViewState]);
    check(pluginViewStateFailure == nil, [NSString stringWithFormat:@"core plugin state JSON is valid: %@", pluginViewStateFailure]);
    SPJavaScriptResult *evaluation = [[SPJavaScriptResult alloc] init];
    [view evaluateJavaScript:@"location.href" completionHandler:^(id result, NSError *error) {
        if ([result isKindOfClass:NSString.class]) evaluation.url = result;
        if (error) evaluation.failure = error.localizedDescription;
        evaluation.completed = YES;
    }];
    BOOL evaluated = until(^BOOL { return evaluation.completed; }, 15);
    check(evaluated, @"core plugin page completes its URL query within 15000ms");
    check(evaluation.failure == nil, [NSString stringWithFormat:@"core plugin page URL query succeeds: %@", evaluation.failure]);
    check([evaluation.url isEqualToString:@"soksak://probe/page.html"],
        [NSString stringWithFormat:@"process display label preserves plugin origin (got %@)", evaluation.url]);
    pid_t pid = view._webProcessIdentifier;
    check(pid > 0, [NSString stringWithFormat:@"core plugin view has WebContent process %d", pid]);

    NSString *secondFolder = [root stringByAppendingPathComponent:@"other"];
    NSString *secondStore = [root stringByAppendingPathComponent:@"other-store"];
    NSString *secondPage = [secondFolder stringByAppendingPathComponent:@"page.html"];
    failure = nil;
    BOOL secondCreated = [[NSFileManager defaultManager] createDirectoryAtPath:secondFolder
        withIntermediateDirectories:YES attributes:nil error:&failure];
    check(secondCreated, [NSString stringWithFormat:@"second plugin fixture directory is created: %@", failure]);
    failure = nil;
    BOOL secondWritten = secondCreated && [html writeToFile:secondPage atomically:YES
        encoding:NSUTF8StringEncoding error:&failure];
    check(secondWritten, [NSString stringWithFormat:@"second plugin fixture page is written: %@", failure]);
    void *secondDocument = secondWritten ? sp_document_create(surface, secondStore.fileSystemRepresentation,
        secondFolder.fileSystemRepresentation, "other", "window.sokView = 1;", pluginStateChanged,
        &secondPluginViewState) : NULL;
    check(secondDocument != NULL, [NSString stringWithFormat:@"core creates a second plugin view: %s", sp_document_last_error()]);
    if (secondDocument) {
        [secondPluginViewState release];
        secondPluginViewState = nil;
        check(sp_document_load(secondDocument, "soksak://other/page.html"),
            @"second core plugin view accepts its canonical isolated origin");
        __block NSString *secondStateFailure = nil;
        BOOL secondLoaded = until(^BOOL {
            NSData *stateData = [secondPluginViewState dataUsingEncoding:NSUTF8StringEncoding];
            NSError *parseError = nil;
            NSDictionary *state = stateData ? [NSJSONSerialization JSONObjectWithData:stateData options:0 error:&parseError] : nil;
            if (stateData && !state && !secondStateFailure) {
                secondStateFailure = [(parseError.localizedDescription ?: @"second plugin state JSON is absent or not an object") copy];
            }
            return [state[@"url"] isEqual:@"soksak://other/page.html"] && ![state[@"loading"] boolValue];
        }, 15);
        check(secondLoaded, [NSString stringWithFormat:@"second plugin page reaches loaded state within 15000ms (got %@)",
            secondPluginViewState]);
        check(secondStateFailure == nil, [NSString stringWithFormat:@"second plugin state JSON is valid: %@", secondStateFailure]);
        [secondStateFailure release];
        pid_t secondPid = ((__bridge WKWebView *)secondDocument)._webProcessIdentifier;
        check(secondPid > 0 && secondPid != pid,
            [NSString stringWithFormat:@"distinct plugin identifiers use distinct WebContent processes (%d, %d)", pid, secondPid]);
        if (secondPid > 0) {
            printf("CORE_PLUGIN_PID %d\n", secondPid);
            printf("MEASURE case=core-plugin-view-other requested=soksak://other/page.html loaded=soksak://other/page.html override=soksak://plugin/other webContentPid=%d\n",
                secondPid);
            fflush(stdout);
        }
        NSString *secondName = nil;
        NSString *secondListingFailure = nil;
        NSString *secondListing = secondPid > 0 ? processListing(secondPid, &secondName, &secondListingFailure) : nil;
        check(secondListing != nil, [NSString stringWithFormat:@"second plugin LaunchServices lookup succeeds: %@",
            secondListingFailure]);
        if (secondListing) check([secondName isEqualToString:@"soksak://plugin/other"],
            [NSString stringWithFormat:@"second plugin process label is soksak://plugin/other (got %@)", secondName]);
        sp_document_close(secondDocument);
        [secondPluginViewState release];
        secondPluginViewState = nil;
    }

    NSString *launchServicesName = nil;
    NSString *listingFailure = nil;
    NSString *listing = pid > 0 ? processListing(pid, &launchServicesName, &listingFailure) : nil;
    check(listing != nil, [NSString stringWithFormat:@"core plugin LaunchServices lookup succeeds: %@", listingFailure]);
    if (listing) {
        check([launchServicesName isEqualToString:@"soksak://plugin/probe"],
            [NSString stringWithFormat:@"core plugin process label is soksak://plugin/probe (got %@)", launchServicesName]);
    }
    printf("MEASURE case=core-plugin-view requested=soksak://probe/page.html loaded=%s override=soksak://plugin/probe webContentPid=%d\n",
        evaluation.url.UTF8String ?: "<unavailable>", pid);
    fflush(stdout);
    sp_document_close(document);
    sp_surface_close(surface);
    [main removeFromSuperview];
    [main release];
    [evaluation release];
    [pluginViewState release];
    pluginViewState = nil;
    [pluginViewStateFailure release];
    pluginViewStateFailure = nil;
    return pid;
}

static BOOL processExited(pid_t pid) {
    if (pid <= 0) return YES;
    char path[PROC_PIDPATHINFO_MAXSIZE] = {0};
    return proc_pidpath(pid, path, sizeof(path)) != 0;
}

static int runWebKitCases(void) {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(50, 50, 660, 280)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    SPProcessLabelScheme *handler = [[SPProcessLabelScheme alloc] init];
    [window orderBack:nil];

    NSString *originURL = configuredValue(@"SOKSAK_PROCESS_LABEL_ORIGIN_URL", @"soksak://sample/page");
    NSString *displayURL = configuredValue(@"SOKSAK_PROCESS_LABEL_DISPLAY_URL", @"soksak://plugin/sample");
    NSString *displayName = configuredValue(@"SOKSAK_PROCESS_LABEL_PLUGIN", @"soksak://plugin/sample");
    measure(window, handler, @"legacy-origin", originURL, nil);
    measure(window, handler, @"requested-display-path", displayURL, nil);
    measure(window, handler, @"explicit-display-name", originURL, displayName);
    pid_t corePluginPid = measureCorePluginViewLabel(window);

    [window close];
    [window release];
    [handler release];
    check(!NSApp.isActive, @"the measurement does not activate the application");
    if (corePluginPid > 0) printf("CORE_PLUGIN_PID %d\n", corePluginPid);
    return failures ? 1 : 0;
}

static int runSidecarProcessNameHelper(void) {
        NSString *displayName = configuredValue(@"SOKSAK_SIDECAR_DISPLAY_NAME", @"soksak://sidecar/sample");
        NSProcessInfo.processInfo.processName = displayName;
        printf("HELPER pid=%d processName=%s argv0=%s\n", NSProcessInfo.processInfo.processIdentifier,
            NSProcessInfo.processInfo.processName.UTF8String,
            NSProcessInfo.processInfo.arguments.firstObject.UTF8String);
        fflush(stdout);
        return waitForControlByte("process-name helper");
}

static int runRegisteredSidecarDisplayNameHelper(void) {
    NSString *requestedName = configuredValue(@"SOKSAK_SIDECAR_DISPLAY_NAME", @"soksak://sidecar/sample");
    char error[512] = {0};
    int status = soksak_process_set_display_name(requestedName.UTF8String, error, sizeof(error));
    if (status != 0) {
        fprintf(stderr, "HELPER_ERROR process identity status=%d: %s\n", status, error);
        return 2;
    }
    printf("REGISTERED_HELPER pid=%d displayName=%s executable=%s bundle=%s\n",
        NSProcessInfo.processInfo.processIdentifier, requestedName.UTF8String,
        NSBundle.mainBundle.executableURL.lastPathComponent.UTF8String,
        NSBundle.mainBundle.bundleURL.path.UTF8String);
    fflush(stdout);
    return waitForControlByte("registered display-name helper") ? 3 : 0;
}

static BOOL runWebKitWorkerAndCheckCleanup(void) {
    NSTask *task = [[[NSTask alloc] init] autorelease];
    task.executableURL = NSBundle.mainBundle.executableURL;
    task.arguments = @[@"--webkit-label-worker"];
    NSPipe *outputPipe = [NSPipe pipe];
    NSPipe *errorPipe = [NSPipe pipe];
    task.standardOutput = outputPipe;
    task.standardError = errorPipe;
    NSError *launchError = nil;
    check([task launchAndReturnError:&launchError], [NSString stringWithFormat:@"WebKit measurement worker launches: %@", launchError]);
    if (!task.isRunning) return NO;
    NSFileHandle *outputReader = outputPipe.fileHandleForReading;
    NSFileHandle *errorReader = errorPipe.fileHandleForReading;
    SPProcessOutput *processOutput = [[SPProcessOutput alloc] init];
    dispatch_group_t drained = dispatch_group_create();
    dispatch_group_enter(drained);
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        processOutput.standardOutput = [outputReader readDataToEndOfFile];
        dispatch_group_leave(drained);
    });
    dispatch_group_enter(drained);
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        processOutput.standardError = [errorReader readDataToEndOfFile];
        dispatch_group_leave(drained);
    });
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:60];
    while (task.isRunning && deadline.timeIntervalSinceNow > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                                 beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    }
    if (task.isRunning) {
        [task terminate];
        [task waitUntilExit];
        check(NO, @"WebKit measurement worker exits within 60000ms");
    }
    BOOL outputDrained = dispatch_group_wait(drained, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC)) == 0;
    check(outputDrained, @"WebKit measurement worker stdout and stderr reach EOF");
    dispatch_release(drained);
    NSString *output = [[[NSString alloc] initWithData:processOutput.standardOutput encoding:NSUTF8StringEncoding] autorelease];
    NSString *errors = [[[NSString alloc] initWithData:processOutput.standardError encoding:NSUTF8StringEncoding] autorelease];
    [processOutput release];
    if (output) fputs(output.UTF8String, stdout);
    if (errors.length) fprintf(stderr, "WebKit measurement worker stderr:\n%s\n", errors.UTF8String);
    check(task.terminationReason == NSTaskTerminationReasonExit && task.terminationStatus == 0,
        [NSString stringWithFormat:@"WebKit measurement worker exits successfully (reason %ld status %d)",
            (long)task.terminationReason, task.terminationStatus]);
    if (!output) {
        check(NO, @"WebKit measurement worker output is UTF-8");
        return NO;
    }
    NSRegularExpression *regex = [NSRegularExpression regularExpressionWithPattern:@"webContentPid=(\\d+)"
        options:0 error:nil];
    NSArray<NSTextCheckingResult *> *matches = [regex matchesInString:output options:0
        range:NSMakeRange(0, output.length)];
    check(matches.count == 5, [NSString stringWithFormat:@"the worker reports all five WebContent PIDs (got %lu)",
        (unsigned long)matches.count]);
    for (NSTextCheckingResult *match in matches) {
        pid_t pid = (pid_t)[[output substringWithRange:[match rangeAtIndex:1]] intValue];
        BOOL exited = until(^BOOL { return !processExited(pid); }, 10);
        check(exited, [NSString stringWithFormat:@"WebContent process %d exits within 10000ms after its owning worker exits", pid]);
    }
    return failures == 0;
}

static BOOL measureSidecarProcessNameSetter(void) {
    NSString *requestedName = configuredValue(@"SOKSAK_SIDECAR_DISPLAY_NAME", @"soksak://sidecar/sample");
    NSTask *task = [[[NSTask alloc] init] autorelease];
    task.executableURL = NSBundle.mainBundle.executableURL;
    task.arguments = @[@"--sidecar-process-name-helper"];
    NSPipe *outputPipe = [NSPipe pipe];
    NSPipe *controlPipe = [NSPipe pipe];
    task.standardOutput = outputPipe;
    task.standardInput = controlPipe;
    task.standardError = [NSFileHandle fileHandleWithNullDevice];
    NSError *launchError = nil;
    check([task launchAndReturnError:&launchError], [NSString stringWithFormat:@"process-name helper launches: %@", launchError]);
    if (!task.isRunning) return NO;
    pid_t pid = task.processIdentifier;
    NSFileHandle *reader = outputPipe.fileHandleForReading;
    SPProcessOutput *processOutput = [[SPProcessOutput alloc] init];
    dispatch_semaphore_t lineReady = dispatch_semaphore_create(0);
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        NSMutableData *line = [NSMutableData data];
        while (line.length == 0 || ((const char *)line.bytes)[line.length - 1] != '\n') {
            NSData *character = [reader readDataOfLength:1];
            if (character.length == 0) break;
            [line appendData:character];
        }
        processOutput.standardOutput = line;
        dispatch_semaphore_signal(lineReady);
    });
    BOOL ready = dispatch_semaphore_wait(lineReady, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) == 0;
    check(ready, @"process-name helper reports its configured name within 5000ms");
    dispatch_release(lineReady);
    NSString *helperLine = ready
        ? [[[NSString alloc] initWithData:processOutput.standardOutput encoding:NSUTF8StringEncoding] autorelease]
        : nil;
    if (helperLine) fputs(helperLine.UTF8String, stdout);
    check(helperLine != nil && [helperLine containsString:[NSString stringWithFormat:@"processName=%@", requestedName]],
        [NSString stringWithFormat:@"NSProcessInfo.processName returns %@ inside the helper (got %@)", requestedName, helperLine]);

    char name[PROC_PIDPATHINFO_MAXSIZE] = {0};
    char path[PROC_PIDPATHINFO_MAXSIZE] = {0};
    int nameLength = pid > 0 ? proc_name(pid, name, sizeof(name)) : -1;
    int pathLength = pid > 0 ? proc_pidpath(pid, path, sizeof(path)) : -1;
    NSString *reportedProcessName = nameLength > 0 ? [NSString stringWithUTF8String:name] : nil;
    NSString *reportedProcessPath = pathLength > 0 ? [NSString stringWithUTF8String:path] : nil;
    check(nameLength > 0 && reportedProcessName != nil,
        [NSString stringWithFormat:@"proc_name reports the helper process %d", pid]);
    check(pathLength > 0 && reportedProcessPath != nil,
        [NSString stringWithFormat:@"proc_pidpath reports the helper process %d", pid]);

    NSString *launchServicesName = nil;
    NSString *listingFailure = nil;
    NSString *listing = processListing(pid, &launchServicesName, &listingFailure);
    if (listing) {
        printf("LAUNCHSERVICES helper displayName=%s %s\n", launchServicesName.UTF8String, listing.UTF8String);
        check([launchServicesName isEqualToString:requestedName],
            [NSString stringWithFormat:@"the public process-name setter gives the LaunchServices label %@ (got %@)",
                requestedName, launchServicesName]);
    } else {
        printf("MEASURE helper launchServices=unregistered detail=%s\n", listingFailure.UTF8String);
    }
    printf("MEASURE helper requested=%s processName=%s proc_name=%s proc_pidpath=%s\n",
        requestedName.UTF8String, helperLine.UTF8String ?: "<unavailable>",
        reportedProcessName.UTF8String ?: "<unavailable>", reportedProcessPath.UTF8String ?: "<unavailable>");
    fflush(stdout);

    BOOL sentControl = writeControlByte(controlPipe.fileHandleForWriting.fileDescriptor, "process-name helper");
    check(sentControl, @"process-name helper control handshake writes one byte");
    @try {
        [controlPipe.fileHandleForWriting closeFile];
    } @catch (NSException *exception) {
        check(NO, [NSString stringWithFormat:@"process-name helper control pipe closes: %@", exception.reason]);
    }
    BOOL helperExited = until(^BOOL { return !task.isRunning; }, 5);
    if (!helperExited) {
        [task terminate];
        [task waitUntilExit];
    }
    check(helperExited && task.terminationReason == NSTaskTerminationReasonExit && task.terminationStatus == 0,
        @"the disposable process-name helper exits cleanly within 5000ms after measurement");
    BOOL exited = until(^BOOL { return !processExited(pid); }, 5);
    check(exited, [NSString stringWithFormat:@"process-name helper %d is gone within 5000ms", pid]);
    [processOutput release];
    return failures == 0;
}

static BOOL registeredHelperRejectsControlEOF(void) {
    NSTask *task = [[[NSTask alloc] init] autorelease];
    task.executableURL = NSBundle.mainBundle.executableURL;
    task.arguments = @[@"--registered-sidecar-display-name-helper"];
    task.standardInput = [NSFileHandle fileHandleWithNullDevice];
    task.standardOutput = [NSFileHandle fileHandleWithNullDevice];
    task.standardError = [NSFileHandle fileHandleWithNullDevice];
    NSError *launchError = nil;
    check([task launchAndReturnError:&launchError],
        [NSString stringWithFormat:@"control EOF helper launches: %@", launchError]);
    if (!task.isRunning) return NO;
    pid_t pid = task.processIdentifier;
    BOOL exited = until(^BOOL { return !task.isRunning; }, 5);
    if (!exited) {
        [task terminate];
        [task waitUntilExit];
    }
    check(exited, @"registered helper reports control EOF within 5000ms");
    check(exited && task.terminationReason == NSTaskTerminationReasonExit && task.terminationStatus != 0,
        [NSString stringWithFormat:@"registered helper rejects control EOF with nonzero exit (got %d)",
            task.terminationStatus]);
    check(until(^BOOL { return !processExited(pid); }, 5),
        [NSString stringWithFormat:@"control EOF helper process %d is gone within 5000ms", pid]);
    check(!writeControlByte(-1, "injected invalid descriptor"),
        @"control writer rejects and reports an invalid descriptor");
    return failures == 0;
}

static BOOL measureRegisteredDisplayNameHelper(NSString *executable, NSString *caseName, pid_t baselineFrontmostPid) {
    NSString *requestedName = configuredValue(@"SOKSAK_SIDECAR_DISPLAY_NAME", @"soksak://sidecar/vt");
    NSTask *task = [[[NSTask alloc] init] autorelease];
    task.executableURL = [NSURL fileURLWithPath:executable];
    task.arguments = @[@"--registered-sidecar-display-name-helper"];
    NSPipe *outputPipe = [NSPipe pipe];
    NSPipe *controlPipe = [NSPipe pipe];
    task.standardOutput = outputPipe;
    task.standardError = outputPipe;
    task.standardInput = controlPipe;
    NSMutableDictionary *environment = [NSMutableDictionary dictionaryWithDictionary:NSProcessInfo.processInfo.environment];
    environment[@"SOKSAK_SIDECAR_DISPLAY_NAME"] = requestedName;
    task.environment = environment;
    NSError *launchError = nil;
    check([task launchAndReturnError:&launchError],
        [NSString stringWithFormat:@"%@ helper launches without activating the application: %@", caseName, launchError]);
    if (!task.isRunning) return NO;

    pid_t pid = task.processIdentifier;
    NSFileHandle *reader = outputPipe.fileHandleForReading;
    SPProcessOutput *processOutput = [[SPProcessOutput alloc] init];
    dispatch_semaphore_t lineReady = dispatch_semaphore_create(0);
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        NSMutableData *line = [NSMutableData data];
        while (line.length == 0 || ((const char *)line.bytes)[line.length - 1] != '\n') {
            NSData *character = [reader readDataOfLength:1];
            if (character.length == 0) break;
            [line appendData:character];
        }
        processOutput.standardOutput = line;
        dispatch_semaphore_signal(lineReady);
    });
    BOOL ready = dispatch_semaphore_wait(lineReady, dispatch_time(DISPATCH_TIME_NOW, 5000 * NSEC_PER_MSEC)) == 0;
    check(ready, [NSString stringWithFormat:@"%@ helper checks into LaunchServices and reports within 5000ms", caseName]);
    dispatch_release(lineReady);
    NSString *helperLine = ready
        ? [[[NSString alloc] initWithData:processOutput.standardOutput encoding:NSUTF8StringEncoding] autorelease]
        : nil;
    if (helperLine) fputs(helperLine.UTF8String, stdout);
    check(helperLine != nil && [helperLine containsString:[NSString stringWithFormat:@"displayName=%@", requestedName]],
        [NSString stringWithFormat:@"%@ helper sets the exact LaunchServices display name %@ (got %@)",
            caseName, requestedName, helperLine ?: @"<no output>"]);

    NSString *launchServicesName = nil;
    NSString *listingFailure = nil;
    NSString *listing = processListing(pid, &launchServicesName, &listingFailure);
    check(listing != nil, [NSString stringWithFormat:@"%@ helper is registered while running: %@", caseName, listingFailure]);
    if (listing) {
        printf("LAUNCHSERVICES case=%s displayName=%s %s\n", caseName.UTF8String,
            launchServicesName.UTF8String, listing.UTF8String);
        check([launchServicesName isEqualToString:requestedName],
            [NSString stringWithFormat:@"%@ LaunchServices name exactly equals %@ (got %@)",
                caseName, requestedName, launchServicesName]);
    }
    NSRunningApplication *runningApplication = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
    check(runningApplication != nil,
        [NSString stringWithFormat:@"%@ has an NSRunningApplication record", caseName]);
    if (runningApplication) {
        printf("NSRUNNINGAPPLICATION case=%s localizedName=%s bundleIdentifier=%s\n", caseName.UTF8String,
            runningApplication.localizedName.UTF8String ?: "<nil>",
            runningApplication.bundleIdentifier.UTF8String ?: "<nil>");
        check([runningApplication.localizedName isEqualToString:requestedName],
            [NSString stringWithFormat:@"%@ NSRunningApplication.localizedName equals %@ (got %@)",
                caseName, requestedName, runningApplication.localizedName ?: @"<nil>"]);
    }

    char name[PROC_PIDPATHINFO_MAXSIZE] = {0};
    char path[PROC_PIDPATHINFO_MAXSIZE] = {0};
    int nameLength = pid > 0 ? proc_name(pid, name, sizeof(name)) : -1;
    int pathLength = pid > 0 ? proc_pidpath(pid, path, sizeof(path)) : -1;
    NSString *reportedName = nameLength > 0 ? [NSString stringWithUTF8String:name] : nil;
    NSString *reportedPath = pathLength > 0 ? [NSString stringWithUTF8String:path] : nil;
    check(nameLength > 0 && reportedName != nil,
        [NSString stringWithFormat:@"%@ proc_name succeeds for pid %d", caseName, pid]);
    check(pathLength > 0 && reportedPath != nil,
        [NSString stringWithFormat:@"%@ proc_pidpath succeeds for pid %d", caseName, pid]);
    check([reportedPath.lastPathComponent isEqualToString:[executable lastPathComponent]],
        [NSString stringWithFormat:@"%@ keeps executable basename %@ (got %@)", caseName,
            executable.lastPathComponent, reportedPath.lastPathComponent]);
    check(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == baselineFrontmostPid,
        [NSString stringWithFormat:@"%@ check-in leaves frontmost application pid %d unchanged", caseName, baselineFrontmostPid]);
    printf("MEASURE case=%s requested=%s pid=%d proc_name=%s proc_pidpath=%s\n", caseName.UTF8String,
        requestedName.UTF8String, pid, reportedName.UTF8String ?: "<unavailable>",
        reportedPath.UTF8String ?: "<unavailable>");
    fflush(stdout);

    if (task.isRunning) {
        BOOL sentControl = writeControlByte(controlPipe.fileHandleForWriting.fileDescriptor, caseName.UTF8String);
        check(sentControl, [NSString stringWithFormat:@"%@ helper control handshake writes one byte", caseName]);
        @try {
            [controlPipe.fileHandleForWriting closeFile];
        } @catch (NSException *exception) {
            check(NO, [NSString stringWithFormat:@"%@ helper control pipe closes: %@", caseName, exception.reason]);
        }
    }
    BOOL exited = until(^BOOL { return !task.isRunning; }, 5);
    if (!exited) {
        [task terminate];
        [task waitUntilExit];
    }
    check(exited && task.terminationReason == NSTaskTerminationReasonExit && task.terminationStatus == 0,
        [NSString stringWithFormat:@"%@ helper exits successfully within 5000ms", caseName]);
    check(until(^BOOL { return !processExited(pid); }, 5),
        [NSString stringWithFormat:@"%@ helper process %d is gone within 5000ms", caseName, pid]);
    check(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == baselineFrontmostPid,
        [NSString stringWithFormat:@"%@ helper exit leaves frontmost application pid %d unchanged", caseName, baselineFrontmostPid]);
    [processOutput release];
    return failures == 0;
}

static BOOL measureRegisteredDisplayNameCases(void) {
    NSString *root = temporaryFolder(@"process-label-registration-");
    if (root == nil) return NO;
    NSString *source = NSBundle.mainBundle.executableURL.path;
    NSString *bareDirectory = [root stringByAppendingPathComponent:@"bare"];
    NSString *bundleExecutable = [root stringByAppendingPathComponent:@"SidecarLabel.app/Contents/MacOS/process_label_test"];
    NSString *bundleContents = [[bundleExecutable stringByDeletingLastPathComponent] stringByDeletingLastPathComponent];
    NSError *error = nil;
    check([NSFileManager.defaultManager createDirectoryAtPath:bareDirectory withIntermediateDirectories:YES attributes:nil error:&error],
        [NSString stringWithFormat:@"create bare helper folder: %@", error]);
    error = nil;
    check([NSFileManager.defaultManager createDirectoryAtPath:[bundleExecutable stringByDeletingLastPathComponent]
        withIntermediateDirectories:YES attributes:nil error:&error],
        [NSString stringWithFormat:@"create genuine helper app bundle folder: %@", error]);
    NSString *bareExecutable = [bareDirectory stringByAppendingPathComponent:@"process_label_test"];
    error = nil;
    check([NSFileManager.defaultManager copyItemAtPath:source toPath:bareExecutable error:&error],
        [NSString stringWithFormat:@"copy bare helper executable: %@", error]);
    error = nil;
    check([NSFileManager.defaultManager copyItemAtPath:source toPath:bundleExecutable error:&error],
        [NSString stringWithFormat:@"copy helper executable into app bundle: %@", error]);
    NSDictionary *info = @{
        @"CFBundleExecutable": @"process_label_test",
        @"CFBundleIdentifier": @"app.soksak.test.process-label-sidecar",
        @"CFBundleName": @"process_label_test",
        @"CFBundleDisplayName": @"process_label_test",
        @"CFBundlePackageType": @"APPL",
        @"CFBundleShortVersionString": @"0.0.1",
        @"CFBundleVersion": @"0.0.1",
        @"LSUIElement": @YES,
    };
    error = nil;
    check([info writeToURL:[NSURL fileURLWithPath:[bundleContents stringByAppendingPathComponent:@"Info.plist"]]
        atomically:YES], @"write valid temporary LSUIElement app bundle metadata");
    pid_t baselineFrontmostPid = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
    check(baselineFrontmostPid > 0, @"capture frontmost application before LaunchServices check-in");
    BOOL bare = measureRegisteredDisplayNameHelper(bareExecutable, @"bare-helper", baselineFrontmostPid);
    BOOL bundled = measureRegisteredDisplayNameHelper(bundleExecutable, @"bundled-helper", baselineFrontmostPid);
    return bare && bundled;
}

int main(int argc, const char **argv) { @autoreleasepool {
    if (argc == 2 && strcmp(argv[1], "--webkit-label-worker") == 0) return runWebKitCases();
    if (argc == 2 && strcmp(argv[1], "--sidecar-process-name-helper") == 0) {
        return runSidecarProcessNameHelper();
    }
    if (argc == 2 && strcmp(argv[1], "--registered-sidecar-display-name-helper") == 0) {
        return runRegisteredSidecarDisplayNameHelper();
    }
    check(signal(SIGPIPE, SIG_IGN) != SIG_ERR, @"ignore SIGPIPE so failed helper handshakes report EPIPE");
    BOOL sidecarMeasured = measureSidecarProcessNameSetter();
    BOOL controlFailureMeasured = registeredHelperRejectsControlEOF();
    BOOL registrationMeasured = measureRegisteredDisplayNameCases();
    BOOL webKitMeasured = runWebKitWorkerAndCheckCleanup();
    return sidecarMeasured && controlFailureMeasured && registrationMeasured && webKitMeasured ? 0 : 1;
} }
