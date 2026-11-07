// The exact public document transaction owns its native snapshot, issued QR,
// callback worker bridge and provider release. This fixture does not prove an
// application consumer's text or replace its captured-pixel comparison.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#include <stdlib.h>
#include <string.h>
#import "document_view.h"
#import "host_api_capture.h"
#import "host_callbacks.h"
#import "image_capture_match.h"
#import "main_thread.h"
#import "webview_geometry.h"
#import "window_facts.h"
#import "support/temporary_folder.h"
#import "support/view_import_map.h"

static int failures, replies;
static uintptr_t expectedContext, expectedIdentity;
static BOOL inWorker, callbackUsedWorker;
static NSString *replyJSON, *replyError, *title;
static void check(BOOL passed, NSString *message) {
    fprintf(passed ? stdout : stderr, "%s: %s\n", passed ? "PASS" : "FAIL", message.UTF8String);
    if (!passed) failures++;
}
static BOOL until(BOOL (^done)(void)) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:15];
    while (!done() && deadline.timeIntervalSinceNow > 0)
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    return done();
}
static void onMain(void (^work)(void)) { work(); }
static void onWorker(void (^work)(void)) { BOOL previous = inWorker; inWorker = YES; work(); inWorker = previous; }
static void completed(uintptr_t context, char *json, char *error) {
    check(context == expectedContext, @"the native observation preserves its exact integer callback owner");
    if (context != expectedContext) return;
    callbackUsedWorker = inWorker;
    [replyJSON release]; [replyError release];
    replyJSON = json ? [[NSString alloc] initWithUTF8String:json] : nil;
    replyError = error ? [[NSString alloc] initWithUTF8String:error] : nil;
    replies++;
}
#define STUB_V(result, name, parameters) static result stub_##name parameters {}
#define STUB_R(result, name, parameters) static result stub_##name parameters { return 0; }
#define STUB(mode, result, name, parameters, arguments) STUB_##mode(result, name, parameters)
SP_HOST_DIAGNOSTIC_CALLBACKS(STUB)
static void changed(void *context, const char *json) {
    (void)context;
    NSDictionary *record = [NSJSONSerialization JSONObjectWithData:[[NSString stringWithUTF8String:json] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:NULL];
    if ([record[@"title"] isKindOfClass:NSString.class]) { [title release]; title = [record[@"title"] copy]; }
}
static NSString *identityError;
static BOOL identityDone;
static void identityCompleted(void *context, const char *json, const char *error) {
    (void)json;
    check((uintptr_t)context == expectedIdentity, @"identity completion belongs to its exact requested generation");
    if ((uintptr_t)context != expectedIdentity) return;
    [identityError release]; identityError = error ? [[NSString alloc] initWithUTF8String:error] : nil;
    identityDone = YES;
}
static id evaluate(void *document, NSString *script) {
    __block BOOL done = NO;
    __block id answer = nil;
    [(WKWebView *)document evaluateJavaScript:script completionHandler:^(id value, NSError *error) {
        check(error == nil, [NSString stringWithFormat:@"the renderer fixture public operation succeeds: %@", error ?: @""]);
        answer = [value retain]; done = YES;
    }];
    check(until(^BOOL { return done; }), @"the renderer fixture operation completes");
    return [answer autorelease];
}
static NSString *const page = @"<!doctype html><meta charset=utf-8><title>loading</title>"
    "<style>body{margin:0;background:white}#paint{margin:12px;color:black;font:20px sans-serif}</style>"
    "<div id=paint>ACTUAL NATIVE REFERENCE</div><script>"
    "const root=document.getElementById('paint');let owner=null,revision=1,rejectPending=null;globalThis.releases=0;globalThis.referenceRevisionDomain='dom-layout';"
    "new MutationObserver(()=>revision++).observe(root,{subtree:true,characterData:true,childList:true,attributes:true});"
    "const rect=r=>({x:r.x,y:r.y,width:r.width,height:r.height});"
    "const read=()=>{const node=root.firstChild,range=document.createRange();const glyphs=[];"
    "for(const s of new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(node.textContent)){"
    "range.setStart(node,s.index);range.setEnd(node,s.index+s.segment.length);glyphs.push({grapheme:s.segment,rect:rect(range.getBoundingClientRect())});}"
    "return {rect:rect(root.getBoundingClientRect()),glyphRuns:[{text:node.textContent,glyphs}],viewport:{width:innerWidth,height:innerHeight}};};"
    "globalThis.soksakRenderedReference={version:1,async observe({requestId}){if(owner)throw Error('leased');owner={requestId,revision};globalThis.observationStarted=true;"
    "if(globalThis.holdObservation)await new Promise((_,reject)=>{rejectPending=reject});"
    "const result={schemaVersion:1,sourceKind:'native-document',provider:'fixture.native-dom',requestId,revision:{kind:globalThis.referenceRevisionDomain,value:revision},...read()};if(globalThis.invalidCarrier){const c=globalThis.invalidCarrier;if(c.field==='revision')result.revision.value=c.value;else result[c.field]=c.value;}return result;},"
    "async validate({requestId,revision:r}){return !globalThis.rejectValidation&&owner?.requestId===requestId&&r.kind===globalThis.referenceRevisionDomain&&r.value===revision;},"
    "async release({requestId}){if(owner?.requestId!==requestId)throw Error('wrong owner');owner=null;releases++;"
    "if(rejectPending){const reject=rejectPending;rejectPending=null;reject(Error('owner released'));}return true;}};document.title='reference-ready';</script>";

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited]; [NSApp finishLaunching]; [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    hostInstallMainThread(onWorker, onMain);
    sp_host_diagnostic_callbacks callbacks = {0};
#define INITIALIZE(mode, result, name, parameters, arguments) callbacks.name = stub_##name;
    SP_HOST_DIAGNOSTIC_CALLBACKS(INITIALIZE)
    callbacks.document_frame_identity_done = completed;
    check(sp_host_diagnostic_callbacks_install(&callbacks) == NULL, @"the native reference uses the registered SDK diagnostic callback table");
    NSString *temporary = temporaryFolder(@"soksak-reference-fixture-");
    NSString *folder = [temporary stringByAppendingPathComponent:@"plugin"];
    [[NSFileManager defaultManager] createDirectoryAtPath:[folder stringByAppendingPathComponent:@"ui"] withIntermediateDirectories:YES attributes:nil error:NULL];
    [page writeToFile:[folder stringByAppendingPathComponent:@"ui/reference.html"] atomically:YES encoding:NSUTF8StringEncoding error:NULL];
    sp_view_import_map_set(viewImportMapFixture().UTF8String);
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100,100,500,400) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
    [window.contentView addSubview:main]; [window orderBack:nil];
    void *surface = sp_surface_create(sp_window_set_main_webview(main.window, main));
    webviewSetFrame(surface,0,0,500,400); webviewSetSurfaceHidden(surface,false);
    char *evidenceTemplate = strdup([[NSTemporaryDirectory() stringByAppendingPathComponent:@"soksak-document-reference-evidence-XXXXXX"] fileSystemRepresentation]);
    char *created = mkdtemp(evidenceTemplate);
    if (!created) { free(evidenceTemplate); return 1; }
    NSString *evidence = [NSString stringWithUTF8String:created]; free(evidenceTemplate);
    fprintf(stdout,"document reference artifacts: %s\n",evidence.fileSystemRepresentation);
    NSArray<NSDictionary *> *invalidCarriers = @[
        @{@"field":@"schemaVersion", @"value":@"null"},
        @{@"field":@"schemaVersion", @"value":@"({})"},
        @{@"field":@"schemaVersion", @"value":@"[]"},
        @{@"field":@"schemaVersion", @"value":@"'1'"},
        @{@"field":@"schemaVersion", @"value":@"true"},
        @{@"field":@"requestId", @"value":@"null"},
        @{@"field":@"requestId", @"value":@"({})"},
        @{@"field":@"requestId", @"value":@"[]"},
        @{@"field":@"requestId", @"value":@"'1'"},
        @{@"field":@"requestId", @"value":@"true"},
        @{@"field":@"requestId", @"value":@"1.5"},
        @{@"field":@"requestId", @"value":@"9007199254740992"},
        @{@"field":@"revision", @"value":@"null"},
        @{@"field":@"revision", @"value":@"({})"},
        @{@"field":@"revision", @"value":@"[]"},
        @{@"field":@"revision", @"value":@"'1'"},
        @{@"field":@"revision", @"value":@"true"},
        @{@"field":@"revision", @"value":@"1.5"},
        @{@"field":@"revision", @"value":@"9007199254740992"},
    ];
    for (int mode=0; mode<4+(int)invalidCarriers.count; mode++) {
        [title release]; title=nil;
        NSString *store = [temporary stringByAppendingPathComponent:[NSString stringWithFormat:@"store-%d",mode]];
        void *document = sp_document_create(surface,store.fileSystemRepresentation,folder.fileSystemRepresentation,"probe",NULL,NULL,changed,NULL);
        check(document != NULL,@"the reference fixture creates its exact attached document");
        if (!document) continue;
        sp_document_place(document,0,0,0,0,true);
        check(sp_document_load(document,"soksak://probe/ui/reference.html"),@"the renderer-owned reference page loads");
        check(until(^BOOL { return [title isEqual:@"reference-ready"]; }),@"the public renderer provider is initialized");
        if (mode==1) evaluate(document,@"globalThis.rejectValidation=true;true");
        if (mode==2) evaluate(document,@"globalThis.holdObservation=true;true");
        if (mode==3) evaluate(document,@"globalThis.referenceRevisionDomain='fixture-provider-paint';true");
        NSDictionary *carrier = mode >= 4 ? invalidCarriers[mode-4] : nil;
        if (carrier) evaluate(document, [NSString stringWithFormat:
            @"globalThis.invalidCarrier={field:'%@',value:(%@)};true", carrier[@"field"], carrier[@"value"]]);
        sp_image_capture_match_begin(NULL,NULL); char *sessionError=NULL;
        check(sp_image_capture_match_identity_session_begin(&sessionError),@"reference identity session begins"); free(sessionError);
        identityDone=NO; [identityError release]; identityError=nil; expectedIdentity=44+mode;
        check(sp_document_reference_identity_start(document,44+mode,identityCompleted,(void *)expectedIdentity),@"the actual target identity producer starts");
        check(until(^BOOL { return identityDone; }) && !identityError,@"the actual target issues its initial QR draw");
        NSString *directory = [evidence stringByAppendingPathComponent:[NSString stringWithFormat:@"case-%d",mode]];
        [[NSFileManager defaultManager] createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:nil error:NULL];
        expectedContext=73+mode;
        replies=0; callbackUsedWorker=NO; [replyJSON release]; replyJSON=nil; [replyError release]; replyError=nil;
        check(scheduleDocumentReferenceObserve(document,carrier && [carrier[@"field"] isEqual:@"requestId"] ? 1 : 7,directory.fileSystemRepresentation,expectedContext),@"the public SDK native reference operation schedules");
        if (mode==2) {
            check([evaluate(document,@"globalThis.observationStarted===true") boolValue],@"the provider's observation is deliberately pending");
            sp_document_close(document); document=NULL;
        }
        check(until(^BOOL { return replies>0; }),@"the native reference callback completes");
        check(replies==1 && callbackUsedWorker,@"the asynchronous native reference completes once through the SDK worker bridge");
        if (mode==0 || mode==3) {
            NSDictionary *result = replyJSON ? [NSJSONSerialization JSONObjectWithData:[replyJSON dataUsingEncoding:NSUTF8StringEncoding] options:0 error:NULL] : nil;
            check(!replyError && [result[@"source"][@"identity"][@"generation"] isEqual:[NSString stringWithFormat:@"%d",44+mode]],
                [NSString stringWithFormat:@"the native snapshot decodes its actual issued target identity: %@",replyError ?: result]);
            check([result[@"source"][@"identity"][@"raster"] isEqual:@"18446744073709551615"],
                @"the decoded uint64 document raster is canonical text across the public JSON boundary");
            check([[NSFileManager defaultManager] fileExistsAtPath:[directory stringByAppendingPathComponent:@"native.png"]],@"the actual native PNG is retained for exact pixel consumers");
        } else if (mode==1) {
            check([replyError containsString:@"revision changed"], [NSString stringWithFormat:@"renderer revision validation failure is explicit: %@",replyError]);
            check([[NSFileManager defaultManager] fileExistsAtPath:[directory stringByAppendingPathComponent:@"native.png"]],@"revision failure preserves the actual native PNG");
        } else if (carrier) {
            check(replyJSON == nil && [replyError containsString:@"metadata is invalid"],
                [NSString stringWithFormat:@"malformed %@=%@ completes explicitly without crashing or accepting metadata: %@",
                    carrier[@"field"], carrier[@"value"], replyError ?: replyJSON]);
            check(![[NSFileManager defaultManager] fileExistsAtPath:[directory stringByAppendingPathComponent:@"native.png"]],
                @"malformed numeric carriers are rejected before native snapshot publication");
            check([[NSFileManager defaultManager] fileExistsAtPath:directory], @"malformed producer evidence directory is preserved");
        } else check([replyError containsString:@"closed"], [NSString stringWithFormat:@"closing a pending native target completes with its close cause: %@",replyError]);
        if (document) {
            check([evaluate(document,@"globalThis.releases") integerValue]==1,@"native success and error release the exact public provider lease once");
            sp_document_close(document);
        }
        sp_image_capture_match_end();
    }
    sp_surface_close(surface); [window close];
    if (!failures) [[NSFileManager defaultManager] removeItemAtPath:evidence error:NULL];
    else fprintf(stderr,"preserved document reference failure artifacts: %s\n",evidence.fileSystemRepresentation);
    return failures ? 1 : 0;
}}
