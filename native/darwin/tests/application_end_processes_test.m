// Checks that the WebContent processes of an application end when the application ends through its termination command,
// and that the native library offers no operation that kills a WebContent process. The check starts itself as a child
// application that opens a main web view and a document region inside it, reports their WebContent processes and ends
// through -[NSApplication terminate:], as the quit of the hosts ends the process. WebKit ends a WebContent process when
// the connection to its application closes (AuxiliaryProcess::didClose), so no process outlives the application. It
// does not activate the application.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <dlfcn.h>
#import <libproc.h>
#import <spawn.h>
#import <sys/wait.h>
#import "support/temporary_folder.h"
#import "document_view.h"
#import "private/webkit.h"
#import "webview_geometry.h"
#import "window_facts.h"
#import "support/event_wait.h"

extern char **environ;

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// Waits as eventWait does and drains the references that the turns autoreleased before each judgment, as each turn of the run
// loop of an application does.
static void waitDrained(NSString *what, BOOL (^done)(void)) {
    __block NSAutoreleasePool *pool = [NSAutoreleasePool new];
    eventWait(what, ^BOOL {
        [pool drain];
        pool = [NSAutoreleasePool new];
        return done();
    });
    [pool drain];
}

static BOOL processRuns(pid_t pid) {
    struct proc_bsdinfo info;
    return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof info) == (int)sizeof info;
}

// Waits for the exit of a process that is not a child of the test: a dispatch source of the main queue reports the exit, and a
// process that ended before the source was registered is absent after the registration.
static void waitForExit(pid_t pid) {
    __block BOOL exited = NO;
    dispatch_source_t source = dispatch_source_create(DISPATCH_SOURCE_TYPE_PROC, (uintptr_t)pid, DISPATCH_PROC_EXIT,
        dispatch_get_main_queue());
    if (!source) {
        fprintf(stderr, "FAIL: the exit observation of the process %d cannot start\n", pid);
        exit(1);
    }
    dispatch_source_set_event_handler(source, ^{ exited = YES; });
    dispatch_resume(source);
    if (!processRuns(pid)) exited = YES;
    waitDrained([NSString stringWithFormat:@"the WebContent process %d exits", pid], ^BOOL { return exited; });
    dispatch_source_cancel(source);
    dispatch_release(source);
}

static NSDictionary *latest;

static void changed(void *context, const char *text) {
    NSData *data = [NSData dataWithBytes:text length:strlen(text)];
    [latest release];
    latest = [[NSJSONSerialization JSONObjectWithData:data options:0 error:nil] retain];
}

// The child application: opens a main web view with a page and a document region with a file page, writes
// `process <pid>` for each WebContent process to the standard output and ends through the termination command.
static int runApplication(NSString *folder) {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 500, 400)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 500, 400)] autorelease];
    WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
    [window.contentView addSubview:main];
    [window orderBack:nil];
    [main loadHTMLString:@"<title>Main</title><p>main</p>" baseURL:nil];
    waitDrained(@"the main page loads", ^BOOL { return !main.loading && [main.title isEqual:@"Main"]; });
    void *surface = sp_surface_create(sp_window_set_main_webview(main.window, main));
    if (!surface) {
        fprintf(stderr, "FAIL: a logical surface is not created\n");
        return 1;
    }
    webviewSetFrame(surface, 0, 0, 500, 400);
    webviewSetSurfaceHidden(surface, false);
    NSString *page = [folder stringByAppendingPathComponent:@"page.html"];
    if (![@"<title>Region</title><p>region</p>" writeToFile:page atomically:YES encoding:NSUTF8StringEncoding error:nil]) {
        fprintf(stderr, "FAIL: the region page is not written\n");
        return 1;
    }
    void *document = sp_document_create(surface, [folder stringByAppendingPathComponent:@"store"].fileSystemRepresentation,
        NULL, NULL, NULL, NULL, changed, NULL);
    if (!document) {
        fprintf(stderr, "FAIL: a document region is not created\n");
        return 1;
    }
    sp_document_place(document, 10, 20, 30, 40, true);
    if (!sp_document_load(document, [NSURL fileURLWithPath:page].absoluteString.UTF8String)) {
        fprintf(stderr, "FAIL: the document region refuses its file address\n");
        return 1;
    }
    waitDrained(@"the region page loads", ^BOOL { return [latest[@"title"] isEqual:@"Region"] && ![latest[@"loading"] boolValue]; });
    WKWebView *region = (WKWebView *)document;
    printf("process %d\n", main._webProcessIdentifier);
    printf("process %d\n", region._webProcessIdentifier);
    fflush(stdout);
    // The termination command ends the process; WebKit then ends the processes of the closed connections.
    [NSApp terminate:nil];
    fprintf(stderr, "FAIL: the termination command returned\n");
    return 1;
}

int main(int argc, char **argv) { @autoreleasepool {
    if (argc == 3 && strcmp(argv[1], "--application") == 0) return runApplication(@(argv[2]));

    check(dlsym(RTLD_DEFAULT, "sp_webview_kill_content_process") == NULL,
        @"the native library offers no operation that kills a WebContent process");

    int output[2];
    if (pipe(output) != 0) {
        fprintf(stderr, "FAIL: the pipe of the child application is not created: %s\n", strerror(errno));
        return 1;
    }
    posix_spawn_file_actions_t actions;
    posix_spawn_file_actions_init(&actions);
    posix_spawn_file_actions_adddup2(&actions, output[1], STDOUT_FILENO);
    posix_spawn_file_actions_addclose(&actions, output[0]);
    posix_spawn_file_actions_addclose(&actions, output[1]);
    // The parent owns the folder of the child, because the child ends with its document open.
    NSString *folder = temporaryFolder(@"soksak-application-end-");
    char *arguments[] = {argv[0], "--application", (char *)folder.fileSystemRepresentation, NULL};
    pid_t child = 0;
    int spawned = posix_spawn(&child, argv[0], &actions, NULL, arguments, environ);
    posix_spawn_file_actions_destroy(&actions);
    close(output[1]);
    if (spawned != 0) {
        fprintf(stderr, "FAIL: the child application does not start: %s\n", strerror(spawned));
        return 1;
    }
    NSData *data = [[[NSFileHandle alloc] initWithFileDescriptor:output[0] closeOnDealloc:YES] autorelease].readDataToEndOfFile;
    int status = 0;
    if (waitpid(child, &status, 0) != child) {
        fprintf(stderr, "FAIL: the child application cannot be waited for: %s\n", strerror(errno));
        return 1;
    }
    check(WIFEXITED(status) && WEXITSTATUS(status) == 0,
        [NSString stringWithFormat:@"the child application ends through its termination command with status 0 (status %d)", status]);

    NSString *text = [[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] autorelease];
    NSMutableArray<NSNumber *> *processes = [NSMutableArray array];
    for (NSString *line in [text componentsSeparatedByString:@"\n"]) {
        if ([line hasPrefix:@"process "]) [processes addObject:@([line substringFromIndex:8].intValue)];
    }
    check(processes.count == 2 && processes[0].intValue > 0 && processes[1].intValue > 0,
        [NSString stringWithFormat:@"the child application reports the WebContent processes of its main view and its region (%@)",
            [processes componentsJoinedByString:@" "]]);
    for (NSNumber *process in processes) {
        NSDate *start = [NSDate date];
        waitForExit(process.intValue);
        check(!processRuns(process.intValue), [NSString stringWithFormat:@"the WebContent process %d ends after its application ends (%.3f s)",
            process.intValue, [NSDate.date timeIntervalSinceDate:start]]);
    }
    printf("%s\n", failures ? "FAIL: application_end_processes_test" : "PASS: application_end_processes_test");
    return failures ? 1 : 0;
}}
