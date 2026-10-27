// Checks the core root of a view (docs/spec/plugin-processes.md, rule 4): a view configuration requests soksak://core/<path>
// from the core root resolver of the application and imports the files that the resolver serves, each with the header
// Access-Control-Allow-Origin of its plugin; a refused path fails with no such header; and a document region receives no
// core root grant, so its requests to soksak://core fail without calling the resolver.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "support/temporary_folder.h"
#import "support/view_import_map.h"
#import "document_view.h"
#import "webview_geometry.h"
#import "surface_layout.h"
#import "image_capture_match.h"
#import "private/webkit.h"

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

static NSDictionary *latest;
static NSString *frameIdentityReplyJSON;
static NSString *frameIdentityReplyError;
static int frameIdentityReplyCount;
static WKWebView *frameIdentityPresentationView;
static BOOL frameIdentityPresentationCallbackArrived;
static BOOL releaseFrameIdentityPresentationCallback;
static NSUInteger frameIdentityPresentationRequests;
static void (^heldFrameIdentityPresentationCompletion)(void);
static NSUInteger cancelledFrameIdentityStartReplies;
static NSString *cancelledFrameIdentityStartError;

static void cancelledFrameIdentityStartReply(void *context, const char *json, const char *error) {
    (void)context;
    (void)json;
    cancelledFrameIdentityStartReplies++;
    [cancelledFrameIdentityStartError release];
    cancelledFrameIdentityStartError = error ? [[NSString alloc] initWithUTF8String:error] : nil;
}

static void controlledFrameIdentityAfterUpdate(void *document, void (^completion)(void)) {
    WKWebView *view = (WKWebView *)document;
    if (view != frameIdentityPresentationView) return;
    frameIdentityPresentationRequests++;
    [view _doAfterNextPresentationUpdate:^{
        frameIdentityPresentationCallbackArrived = YES;
        if (releaseFrameIdentityPresentationCallback) {
            completion();
        } else {
            [heldFrameIdentityPresentationCompletion release];
            heldFrameIdentityPresentationCompletion = [completion copy];
        }
    }];
}

static void controlFrameIdentityPresentation(WKWebView *view) {
    frameIdentityPresentationView = view;
    frameIdentityPresentationCallbackArrived = NO;
    releaseFrameIdentityPresentationCallback = NO;
    frameIdentityPresentationRequests = 0;
    sp_document_frame_identity_test_set_after_update_hook(controlledFrameIdentityAfterUpdate);
}

static void releaseControlledFrameIdentityPresentation(void) {
    releaseFrameIdentityPresentationCallback = YES;
    void (^completion)(void) = [heldFrameIdentityPresentationCompletion retain];
    [heldFrameIdentityPresentationCompletion release];
    heldFrameIdentityPresentationCompletion = nil;
    if (completion) {
        completion();
        [completion release];
    }
    sp_document_frame_identity_test_set_after_update_hook(NULL);
    frameIdentityPresentationView = nil;
}

static void frameIdentityReply(void *context, const char *json, const char *error) {
    (void)context;
    [frameIdentityReplyJSON release];
    [frameIdentityReplyError release];
    frameIdentityReplyJSON = json ? [[NSString alloc] initWithUTF8String:json] : nil;
    frameIdentityReplyError = error ? [[NSString alloc] initWithUTF8String:error] : nil;
    frameIdentityReplyCount++;
}

static void clearFrameIdentityReply(void) {
    [frameIdentityReplyJSON release]; frameIdentityReplyJSON = nil;
    [frameIdentityReplyError release]; frameIdentityReplyError = nil;
    frameIdentityReplyCount = 0;
}

static void changed(void *context, const char *text) {
    (void)context;
    latest = [[NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:text length:strlen(text)] options:0 error:nil] retain];
}

// The calls of the resolver of the application, each written as "<plugin> <path>". Only the file of probe is served.
static NSMutableArray<NSString *> *resolverCalls;

static bool resolveCoreRoot(void *context, const char *plugin, const char *path, void **bytes, size_t *length, char **type) {
    (void)context;
    [resolverCalls addObject:[NSString stringWithFormat:@"%s %s", plugin, path]];
    if (strcmp(plugin, "probe") != 0 || strcmp(path, "/modules/probe/m.js") != 0) return false;
    const char *text = "export default 42;\n";
    *length = strlen(text);
    *bytes = malloc(*length);
    memcpy(*bytes, text, *length);
    *type = strdup("text/javascript");
    return true;
}

static void writeFile(NSString *root, NSString *path, NSString *text) {
    NSString *file = [root stringByAppendingPathComponent:path];
    [[NSFileManager defaultManager] createDirectoryAtPath:file.stringByDeletingLastPathComponent
        withIntermediateDirectories:YES attributes:nil error:nil];
    [text writeToFile:file atomically:YES encoding:NSUTF8StringEncoding error:nil];
}

// The page imports a file of its own core root and fetches the same file. Each result is written to the title as JSON:
// granted is the module value or fail, refused is imported or fail, served is the HTTP status of a fetch that the page
// reads with CORS, and refusedFetch is the status of a refused fetch or fail. A response without
// Access-Control-Allow-Origin makes the fetch reject, so refusedFetch is fail when the refusal carries no such header.
static NSString *const probePage = @"<!doctype html><meta charset=utf-8><title>loading</title>"
    "<script type=module>"
    "const steps = {};"
    "steps.granted = await import('soksak://core/modules/probe/m.js').then((m) => String(m.default), () => 'fail');"
    "steps.refused = await import('soksak://core/modules/other/secret.js').then(() => 'imported', () => 'fail');"
    "steps.served = await fetch('soksak://core/modules/probe/m.js').then((r) => String(r.status), () => 'fail');"
    "steps.refusedFetch = await fetch('soksak://core/modules/other/secret.js').then((r) => String(r.status), () => 'fail');"
    "document.title = JSON.stringify(steps);"
    "</script>";

// Loads the probe page in a document of the given kind and returns its steps once the page has written them.
static NSDictionary *runPage(void *document) {
    latest = nil;
    check(sp_document_load(document, "soksak://probe/ui/core/probe.html"), @"the probe page starts a load");
    until(@"the probe page writes its steps", ^BOOL{ return [latest[@"title"] hasPrefix:@"{"]; });
    return [NSJSONSerialization JSONObjectWithData:[latest[@"title"] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    NSString *temporary = temporaryFolder(@"soksak-document-core-root-");
    sp_view_import_map_set(viewImportMapFixture().UTF8String);
    NSString *folder = [temporary stringByAppendingPathComponent:@"plugin"];
    writeFile(folder, @"ui/core/probe.html", probePage);

    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 500, 400)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 500, 400)] autorelease];
    WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
    [window.contentView addSubview:main];
    [window orderBack:nil];
    void *surface = sp_surface_create(main);
    webviewSetFrame(surface, 0, 0, 500, 400);
    webviewSetSurfaceHidden(surface, false);
    NSString *store = [temporary stringByAppendingPathComponent:@"store"];
    resolverCalls = [NSMutableArray new];
    sp_core_root_set_resolver(resolveCoreRoot, NULL);

    @autoreleasepool {
        // A view without its plugin is not created, so the core root is never granted to an unnamed requester.
        check(sp_document_create(surface, store.fileSystemRepresentation, folder.fileSystemRepresentation, NULL, "", changed, NULL) == NULL,
            @"a view without a plugin is not created");

        void *view = sp_document_create(surface, store.fileSystemRepresentation, folder.fileSystemRepresentation, "probe", "", changed, NULL);
        check(view != NULL, @"a view is created with the folder and the plugin of its page");
        check(surfaceLayoutPrefersNear60FPS(view) == 0,
            [NSString stringWithFormat:@"a plugin root view renders at the display refresh rate (preference %d)",
                surfaceLayoutPrefersNear60FPS(view)]);
        sp_document_place(view, 0, 0, 0, 0, true);
        NSDictionary *steps = runPage(view);
        check([steps[@"granted"] isEqual:@"42"],
            [NSString stringWithFormat:@"a view imports the granted module of its core root: %@", steps]);
        check([resolverCalls containsObject:@"probe /modules/probe/m.js"],
            [NSString stringWithFormat:@"the resolver receives the plugin of the view and the path: %@", resolverCalls]);
        check([steps[@"refused"] isEqual:@"fail"], [NSString stringWithFormat:@"a view imports a refused core path and fails: %@", steps]);
        check([resolverCalls containsObject:@"probe /modules/other/secret.js"],
            [NSString stringWithFormat:@"the resolver receives the refused path: %@", resolverCalls]);
        check([steps[@"served"] isEqual:@"200"],
            [NSString stringWithFormat:@"a served core response has the header that a fetch of the view reads: %@", steps]);
        check([steps[@"refusedFetch"] isEqual:@"fail"],
            [NSString stringWithFormat:@"a refused core response carries no Access-Control-Allow-Origin and the fetch fails: %@", steps]);

        sp_image_capture_match_begin(NULL, NULL);
        char *identitySessionError = NULL;
        BOOL identitySession = sp_image_capture_match_identity_session_begin(&identitySessionError);
        check(identitySession && identitySessionError == NULL,
            @"the document identity producer owner starts an opt-in capture identity session");
        free(identitySessionError);
        clearFrameIdentityReply();
        controlFrameIdentityPresentation((WKWebView *)view);
        BOOL identityScheduled = sp_document_frame_identity_start(view, 41, frameIdentityReply, NULL);
        check(identityScheduled, @"the current visible plugin root accepts the diagnostic QR producer");
        NSDate *presentationDeadline = [NSDate dateWithTimeIntervalSinceNow:10];
        while (frameIdentityReplyCount == 0 && !frameIdentityPresentationCallbackArrived
            && presentationDeadline.timeIntervalSinceNow > 0) {
            [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
        }
        check(frameIdentityPresentationRequests == 1 && frameIdentityPresentationCallbackArrived,
            [NSString stringWithFormat:@"the start waits for the target root WebKit presentation callback before replying (requests=%lu callback=%d reply=%d)",
                (unsigned long)frameIdentityPresentationRequests, frameIdentityPresentationCallbackArrived,
                frameIdentityReplyCount]);
        check(frameIdentityReplyCount == 0,
            @"the start reply remains pending while the target root presentation callback is held");
        releaseControlledFrameIdentityPresentation();
        until(@"the visible root reports its first QR draw", ^BOOL { return frameIdentityReplyCount == 1; });
        NSDictionary *identityStart = frameIdentityReplyJSON
            ? [NSJSONSerialization JSONObjectWithData:[frameIdentityReplyJSON dataUsingEncoding:NSUTF8StringEncoding]
                options:0 error:nil] : nil;
        check(frameIdentityReplyError == nil && [identityStart[@"generation"] unsignedLongLongValue] == 41
            && [identityStart[@"atlasSlots"] unsignedIntegerValue] == 512
            && [identityStart[@"roi"] isKindOfClass:NSDictionary.class],
            [NSString stringWithFormat:@"the asynchronous start reply follows initial marker draw with measured ROI: %@ %@",
                identityStart, frameIdentityReplyError ?: @""]);
        clearFrameIdentityReply();
        BOOL freezeScheduled = sp_document_frame_identity_freeze(41, frameIdentityReply, NULL);
        check(freezeScheduled, @"freezing the producer schedules on the main thread");
        until(@"the producer reports its final issued slots", ^BOOL { return frameIdentityReplyCount == 1; });
        NSDictionary *identityFreeze = frameIdentityReplyJSON
            ? [NSJSONSerialization JSONObjectWithData:[frameIdentityReplyJSON dataUsingEncoding:NSUTF8StringEncoding]
                options:0 error:nil] : nil;
        NSUInteger issuedSlots = [identityFreeze[@"issuedSlots"] unsignedIntegerValue];
        check(frameIdentityReplyError == nil && [identityFreeze[@"generation"] unsignedLongLongValue] == 41
            && [identityFreeze[@"atlasSlots"] unsignedIntegerValue] == 512 && issuedSlots >= 1 && issuedSlots <= 512,
            [NSString stringWithFormat:@"freeze reports the bounded count of distinct atlas cells drawn: %@ %@",
                identityFreeze, frameIdentityReplyError ?: @""]);
        clearFrameIdentityReply();
        BOOL removeScheduled = sp_document_frame_identity_remove(41, frameIdentityReply, NULL);
        check(removeScheduled, @"marker removal schedules after capture intake stops");
        until(@"the marker removal completes", ^BOOL { return frameIdentityReplyCount == 1; });
        NSDictionary *identityRemove = frameIdentityReplyJSON
            ? [NSJSONSerialization JSONObjectWithData:[frameIdentityReplyJSON dataUsingEncoding:NSUTF8StringEncoding]
                options:0 error:nil] : nil;
        check(frameIdentityReplyError == nil && [identityRemove[@"generation"] unsignedLongLongValue] == 41
            && [identityRemove[@"removed"] boolValue],
            [NSString stringWithFormat:@"the matching generation marker is removed: %@ %@",
                identityRemove, frameIdentityReplyError ?: @""]);
        clearFrameIdentityReply();
        BOOL retryRemoveScheduled = sp_document_frame_identity_remove(41, frameIdentityReply, NULL);
        check(retryRemoveScheduled, @"a retry after an earlier removal callback schedules cleanup confirmation");
        until(@"the idempotent removal retry completes", ^BOOL { return frameIdentityReplyCount == 1; });
        NSDictionary *retryRemove = frameIdentityReplyJSON
            ? [NSJSONSerialization JSONObjectWithData:[frameIdentityReplyJSON dataUsingEncoding:NSUTF8StringEncoding]
                options:0 error:nil] : nil;
        check(frameIdentityReplyError == nil && [retryRemove[@"generation"] unsignedLongLongValue] == 41
            && [retryRemove[@"removed"] boolValue],
            [NSString stringWithFormat:@"a repeated removal confirms the already removed generation: %@ %@",
                retryRemove, frameIdentityReplyError ?: @""]);
        sp_image_capture_match_end();
        clearFrameIdentityReply();

        sp_image_capture_match_begin(NULL, NULL);
        identitySessionError = NULL;
        identitySession = sp_image_capture_match_identity_session_begin(&identitySessionError);
        check(identitySession && identitySessionError == NULL,
            @"the pending-start cancellation case begins a separate identity session");
        free(identitySessionError);
        cancelledFrameIdentityStartReplies = 0;
        [cancelledFrameIdentityStartError release]; cancelledFrameIdentityStartError = nil;
        controlFrameIdentityPresentation((WKWebView *)view);
        BOOL pendingIdentityScheduled = sp_document_frame_identity_start(view, 42,
            cancelledFrameIdentityStartReply, NULL);
        check(pendingIdentityScheduled, @"a second generation accepts a diagnostic QR producer");
        until(@"WebKit reaches the held target update for the second generation",
            ^BOOL { return frameIdentityPresentationCallbackArrived; });
        check(cancelledFrameIdentityStartReplies == 0,
            @"the second generation start remains pending before its target update completion");
        BOOL pendingRemoveScheduled = sp_document_frame_identity_remove(42, frameIdentityReply, NULL);
        check(pendingRemoveScheduled, @"removing a generation cancels its pending target update reply");
        until(@"the pending start error and generation removal complete",
            ^BOOL { return cancelledFrameIdentityStartReplies == 1 && frameIdentityReplyCount == 1; });
        check(cancelledFrameIdentityStartError != nil,
            @"removal reports one explicit error to the pending start callback");
        NSDictionary *pendingRemove = frameIdentityReplyJSON
            ? [NSJSONSerialization JSONObjectWithData:[frameIdentityReplyJSON dataUsingEncoding:NSUTF8StringEncoding]
                options:0 error:nil] : nil;
        check(frameIdentityReplyError == nil && [pendingRemove[@"generation"] unsignedLongLongValue] == 42
            && [pendingRemove[@"removed"] boolValue],
            [NSString stringWithFormat:@"the pending generation is removed before its update callback is released: %@ %@",
                pendingRemove, frameIdentityReplyError ?: @""]);
        releaseControlledFrameIdentityPresentation();
        check(cancelledFrameIdentityStartReplies == 1,
            @"the late target update callback cannot reply again after generation removal");
        sp_image_capture_match_end();
        clearFrameIdentityReply();
        sp_document_close(view);

        // A region gets no core root grant: its core requests fail and the resolver is not called for them.
        [resolverCalls removeAllObjects];
        void *region = sp_document_create(surface, store.fileSystemRepresentation, folder.fileSystemRepresentation, "probe", NULL, changed, NULL);
        check(region != NULL, @"a document region is created with the folder of its plugin");
        sp_document_place(region, 0, 0, 0, 0, true);
        steps = runPage(region);
        check([steps[@"granted"] isEqual:@"fail"] && [steps[@"served"] isEqual:@"fail"],
            [NSString stringWithFormat:@"a region cannot import or fetch a granted core path: %@", steps]);
        check(resolverCalls.count == 0, [NSString stringWithFormat:@"a region does not call the core root resolver: %@", resolverCalls]);
        check(surfaceLayoutPrefersNear60FPS(region) == 0,
            [NSString stringWithFormat:@"a document region renders at the display refresh rate (preference %d)",
                surfaceLayoutPrefersNear60FPS(region)]);
        sp_document_close(region);
    }
    sp_core_root_set_resolver(NULL, NULL);
    sp_surface_close(surface);
    [window close];
    if (failures) fprintf(stderr, "%d failures\n", failures);
    return failures ? 1 : 0;
}}
