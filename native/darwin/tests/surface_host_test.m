// 논리 표면은 앱 DOM 웹뷰를 추가하지 않으며 네이티브 내용만 소유한다.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "webview_geometry.h"
#import "window_facts.h"

static int failures;
static void check(BOOL ok, const char *message) {
    fprintf(ok ? stdout : stderr, "%s: %s\n", ok ? "PASS" : "FAIL", message);
    if (!ok) failures++;
}
static NSUInteger webviews(NSView *view) {
    NSUInteger count = [view isKindOfClass:WKWebView.class] ? 1 : 0;
    for (NSView *child in view.subviews) count += webviews(child);
    return count;
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 800, 500)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    WKWebView *main = [[WKWebView alloc] initWithFrame:window.contentView.bounds];
    main.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [window.contentView addSubview:main];
    check(sp_window_set_main_webview(window, main), "the window registers its app DOM identity");
    check(sp_surface_create(window) == NULL, "a window is rejected instead of being treated as a webview");
    void *surfaces[3];
    for (int i = 0; i < 3; i++) {
        surfaces[i] = sp_surface_create(main);
        check(surfaces[i] != NULL, "a logical surface is created");
        webviewSetFrame(surfaces[i], 20 + i * 240, 50, 220, 300.5);
        webviewSetSurfaceHidden(surfaces[i], false);
    }
    check(main.underPageBackgroundColor.alphaComponent == 0 && ![[main valueForKey:@"drawsBackground"] boolValue],
        "the app DOM webview does not paint an opaque backing over native regions");
    check(webviews(window.contentView) == 1, "three surfaces use one app DOM webview");
    char *factsJSON = sp_window_facts(window);
    NSDictionary *facts = [NSJSONSerialization JSONObjectWithData:
        [NSData dataWithBytes:factsJSON length:strlen(factsJSON)] options:0 error:nil];
    sp_facts_free(factsJSON);
    check([facts[@"appDomWebviews"] unsignedIntegerValue] == 1 && [facts[@"documentWebviews"] unsignedIntegerValue] == 0,
        "window facts measure one app DOM and no external document views");
    check([facts[@"nativeSurfaces"] count] == 3, "window facts report all logical surface containers");
    WKWebView *documents[2];
    for (int i = 0; i < 2; i++) {
        documents[i] = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 100, 40)];
        [(NSView *)sp_surface_native_plane(surfaces[i + 1]) addSubview:documents[i]];
    }
    factsJSON = sp_window_facts(window);
    facts = [NSJSONSerialization JSONObjectWithData:
        [NSData dataWithBytes:factsJSON length:strlen(factsJSON)] options:0 error:nil];
    sp_facts_free(factsJSON);
    check([facts[@"appDomWebviews"] unsignedIntegerValue] == 1 && [facts[@"documentWebviews"] unsignedIntegerValue] == 2,
        "two external documents do not increase the app DOM webview count");
    BOOL hasExternalWebview = NO;
    for (NSDictionary *webview in facts[@"webviews"]) {
        if (![webview[@"main"] boolValue]) { hasExternalWebview = YES; break; }
    }
    check(hasExternalWebview, "the app DOM identity is not inferred from drawing order");
    check(sp_window_main_webview(window) == main, "registered app DOM identity survives native document creation");
    char *hitJSON = sp_window_hit(window, 790, 490);
    NSDictionary *mainHit = [NSJSONSerialization JSONObjectWithData:
        [NSData dataWithBytes:hitJSON length:strlen(hitJSON)] options:0 error:nil];
    sp_facts_free(hitJSON);
    check([mainHit[@"main"] boolValue], "main input identity is independent of external document drawing order");
    for (int i = 0; i < 2; i++) { [documents[i] removeFromSuperview]; [documents[i] release]; }
    check(main.pageZoom == 1, "logical surfaces do not change app DOM zoom");
    NSView *surface = (NSView *)surfaces[0];
    check(surface.layer.masksToBounds, "surface clips native descendants");
    check(sp_surface_main_webview(surface) == main, "surface points to the owning app DOM");
    NSView *plane = (NSView *)sp_surface_native_plane(surface);
    check(plane.superview == surface, "native plane belongs to its logical surface");
    NSView *coordinates = surface.superview;
    check(coordinates.superview == main.superview, "native coordinates and app DOM share a compositor");
    check([main.superview.subviews indexOfObject:coordinates] > [main.superview.subviews indexOfObject:main],
        "native content is placed in the compositor above the transparent app DOM backing");
    double rect[4] = {0};
    webviewGetFrame(surface, rect);
    check(rect[0] == 20 && rect[1] == 50 && rect[2] == 220,
        "surface placement preserves window coordinates");
    check(NSEqualRects(plane.frame, surface.bounds), "native plane fills its surface");
    NSTextField *field = [[[NSTextField alloc] initWithFrame:NSMakeRect(0, 0, 100, 40)] autorelease];
    [plane addSubview:field];
    NSPoint fieldPoint = [field convertPoint:NSMakePoint(10, 10) toView:window.contentView.superview];
    NSView *hit = [window.contentView hitTest:fieldPoint];
    check(hit == field || [hit isDescendantOf:field], "native content receives input through the app DOM");
    double overlay[5] = {0, 0, 0, 0, 1};
    webviewSetSurfaceOverlays(surface, overlay, 1);
    hit = [window.contentView hitTest:fieldPoint];
    check(hit == main || [hit isDescendantOf:main], "declared DOM overlay owns input above native content");
    webviewSetSurfaceOverlays(surface, NULL, 0);
    double modal[4] = {0, 0, 800, 500};
    sp_surface_set_window_overlays(main, modal, 1);
    hit = [window.contentView hitTest:fieldPoint];
    check(hit == main || [hit isDescendantOf:main], "window DOM modal blocks native document input");
    sp_surface_set_window_overlays(main, NULL, 0);
    hit = [window.contentView hitTest:fieldPoint];
    check(hit == field || [hit isDescendantOf:field], "closing a DOM modal restores native input");
    NSPoint outside = [surface convertPoint:NSMakePoint(-1, 10) toView:window.contentView.superview];
    hit = [window.contentView hitTest:outside];
    check(hit != field && ![hit isDescendantOf:field], "native input cannot cross the surface boundary");
    // 배치 준비는 DOM 이 그려질 때까지 표면을 숨겼다가 다시 보인다. 그 사이 키보드 소유자가 바뀌면 안 된다.
    WKWebView *focusedDocument = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 100, 40)] autorelease];
    [plane addSubview:focusedDocument];
    check([window makeFirstResponder:focusedDocument], "a document in the surface takes keyboard focus");
    webviewSetSurfaceHidden(surface, true);
    webviewSetSurfaceHidden(surface, false);
    check(window.firstResponder == focusedDocument,
        [[NSString stringWithFormat:@"a transient surface hide keeps the document's keyboard focus: %@",
            NSStringFromClass(window.firstResponder.class)] UTF8String]);
    webviewSetSurfaceHidden(surface, true);
    [window makeFirstResponder:main];
    webviewSetSurfaceHidden(surface, false);
    check(window.firstResponder == main, "a focus change while the surface is hidden is not replaced on show");
    [focusedDocument removeFromSuperview];
    webviewSetSurfaceAlpha(surface, 0.5);
    check(surface.alphaValue == 0.5, "dimming applies to the logical surface");
    webviewSetSurfaceHidden(surface, true);
    check(surface.hidden, "hiding a surface hides its native descendants");
    check(!main.hidden, "hiding one surface does not hide the app DOM");
    for (int i = 0; i < 3; i++) sp_surface_close(surfaces[i]);
    check(coordinates.subviews.count == 0, "closing all surfaces releases native containers");
    check(webviews(window.contentView) == 1, "surface closure preserves the app DOM");
    [main release];
    [window close];
    [window release];
    return failures ? 1 : 0;
} }
