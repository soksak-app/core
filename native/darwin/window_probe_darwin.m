#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "window_probe_darwin.h"
#import "surface_layout_darwin.h"

static void probeViews(NSView *parent, NSMutableArray *views) {
    if ([parent isKindOfClass:WKWebView.class]) { [views addObject:parent]; return; }
    for (NSView *child in parent.subviews) probeViews(child, views);
}

static void probeReply(NSDictionary *request, id result, NSString *error, void (*reply)(const char *)) {
    NSDictionary *message = @{ @"ticket": request[@"ticket"] ?: @"", @"result": result ?: NSNull.null,
        @"error": error ?: NSNull.null };
    NSData *data = [NSJSONSerialization dataWithJSONObject:message options:NSJSONWritingFragmentsAllowed error:nil];
    NSString *text = [[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] autorelease];
    reply(text.UTF8String ?: "{}");
}

void spNativeProbe(void *handle, const char *text, void (*reply)(const char *)) {
    NSCAssert(NSThread.isMainThread, @"native probes run on the AppKit thread");
    NSDictionary *request = [NSJSONSerialization JSONObjectWithData:
        [[NSString stringWithUTF8String:text] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
    if (![request isKindOfClass:NSDictionary.class]) { probeReply(@{}, nil, @"invalid native request", reply); return; }
    if ([request[@"op"] isEqualToString:@"dock"]) {
        id<NSApplicationDelegate> delegate = NSApp.delegate;
        NSMenu *menu = [delegate respondsToSelector:@selector(applicationDockMenu:)] ? [delegate applicationDockMenu:NSApp] : nil;
        NSMutableArray *items = [NSMutableArray array];
        for (NSMenuItem *item in menu.itemArray) [items addObject:item.title];
        if (request[@"select"]) {
            NSInteger index = [menu indexOfItemWithTitle:request[@"select"]];
            if (!menu || index < 0) { probeReply(request, nil, @"Dock menu item not found", reply); return; }
            [menu performActionForItemAtIndex:index];
        }
        probeReply(request, items, nil, reply);
        return;
    }
    NSWindow *window = request[@"window"] ? [NSApp windowWithWindowNumber:[request[@"window"] integerValue]] : (NSWindow *)handle;
    if (!window) { probeReply(request, nil, @"window not found", reply); return; }
    NSMutableArray *views = [NSMutableArray array];
    probeViews(window.contentView, views);
    NSString *op = request[@"op"];
    if ([op isEqualToString:@"close"]) {
        [window performClose:nil];
        probeReply(request, @YES, nil, reply);
        return;
    }
    if ([op isEqualToString:@"position"]) {
        [window setFrameOrigin:NSMakePoint([request[@"x"] doubleValue], [request[@"y"] doubleValue])];
        probeReply(request, @YES, nil, reply);
        return;
    }
    if ([op isEqualToString:@"mouse"]) {
        NSView *content = window.contentView;
        NSPoint point = NSMakePoint([request[@"x"] doubleValue], content.bounds.size.height - [request[@"y"] doubleValue]);
        NSView *hit = [content hitTest:[content convertPoint:point toView:content.superview]];
        point = [content convertPoint:point toView:nil];
        NSString *phase = request[@"phase"];
        if (![phase isEqualToString:@"down"] && ![phase isEqualToString:@"up"]) {
            probeReply(request, nil, @"mouse phase must be down or up", reply); return;
        }
        BOOL down = [phase isEqualToString:@"down"];
        NSEvent *event = [NSEvent mouseEventWithType:down ? NSEventTypeLeftMouseDown : NSEventTypeLeftMouseUp location:point
            modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber
            context:nil eventNumber:1 clickCount:1 pressure:0];
        if (down) [hit mouseDown:event]; else [hit mouseUp:event];
        probeReply(request, @YES, nil, reply);
        return;
    }
    if ([op isEqualToString:@"presentation"]) {
        if (!views.count) { probeReply(request, nil, @"main webview not found", reply); return; }
        surfaceLayoutAfterPresentation(views.firstObject, ^{ probeReply(request, @YES, nil, reply); });
        return;
    }
    if ([op isEqualToString:@"state"]) {
        NSMutableArray *rows = [NSMutableArray array];
        NSMutableArray *controls = [NSMutableArray array];
        for (NSUInteger kind = NSWindowCloseButton; kind <= NSWindowZoomButton; kind++) {
            NSButton *button = [window standardWindowButton:kind];
            if (!button) continue;
            NSRect drawn = [button alignmentRectForFrame:button.bounds];
            NSRect rect = [window.contentView convertRect:drawn fromView:button];
            [controls addObject:@{ @"x": @(rect.origin.x), @"y": @(window.contentView.bounds.size.height - NSMaxY(rect)),
                @"w": @(rect.size.width), @"h": @(rect.size.height), @"hidden": @(button.isHiddenOrHasHiddenAncestor),
                @"parent": NSStringFromClass(button.superview.class) }];
        }
        for (WKWebView *view in views) {
            NSRect rect = [view convertRect:view.bounds toView:window.contentView];
            [rows addObject:@{ @"url": view.URL.absoluteString ?: @"", @"hidden": @(view.isHiddenOrHasHiddenAncestor),
                @"layer": @([view.superview.subviews indexOfObject:view]),
                @"drawsBackground": [view valueForKey:@"drawsBackground"],
                @"backgroundAlpha": @(view.underPageBackgroundColor.alphaComponent),
                @"x": @(rect.origin.x), @"y": @(window.contentView.bounds.size.height - NSMaxY(rect)),
                @"w": @(rect.size.width), @"h": @(rect.size.height),
                @"keyboard": @([window.firstResponder isKindOfClass:NSView.class] && [(NSView *)window.firstResponder isDescendantOf:view]) }];
        }
        NSMutableArray *windows = [NSMutableArray array];
        for (id item in NSApp.accessibilityWindows) {
            if (![item isKindOfClass:NSWindow.class]) continue;
            [windows addObject:@{ @"number": @([(NSWindow *)item windowNumber]),
                @"role": [item accessibilityRole] ?: @"", @"title": [item accessibilityTitle] ?: @"" }];
        }
        NSMutableArray *screens = [NSMutableArray array];
        for (NSScreen *screen in NSScreen.screens) {
            NSRect frame = screen.visibleFrame;
            [screens addObject:@{ @"x": @(frame.origin.x), @"y": @(frame.origin.y),
                @"w": @(frame.size.width), @"h": @(frame.size.height), @"scale": @(screen.backingScaleFactor) }];
        }
        probeReply(request, @{ @"views": rows, @"controls": controls, @"windows": windows, @"window": @(window.windowNumber),
            @"screens": screens, @"scale": @(window.backingScaleFactor),
            @"x": @(window.frame.origin.x), @"y": @(window.frame.origin.y),
            @"children": @(window.childWindows.count), @"key": @(window.isKeyWindow),
            @"front": @(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier),
            @"pid": @(NSProcessInfo.processInfo.processIdentifier),
            @"w": @(window.contentView.bounds.size.width), @"h": @(window.contentView.bounds.size.height) }, nil, reply);
        return;
    }
    if ([op isEqualToString:@"hit"]) {
        NSView *content = window.contentView;
        NSPoint point = NSMakePoint([request[@"x"] doubleValue], content.bounds.size.height - [request[@"y"] doubleValue]);
        NSView *hit = [content hitTest:[content convertPoint:point toView:content.superview]];
        for (WKWebView *view in views) {
            if ([hit isDescendantOf:view]) { probeReply(request, @{ @"url": view.URL.absoluteString ?: @"" }, nil, reply); return; }
        }
        probeReply(request, @{ @"identifier": hit.identifier ?: @"" }, nil, reply);
        return;
    }
    if ([op isEqualToString:@"eval"]) {
        NSString *match = request[@"match"] ?: @"index.html";
        WKWebView *selected = nil;
        for (WKWebView *view in views) {
            if ([view.URL.absoluteString containsString:match] || ([match isEqualToString:@"main"] && view == views.firstObject)) { selected = view; break; }
        }
        if (!selected) { probeReply(request, nil, @"webview not found", reply); return; }
        [selected evaluateJavaScript:request[@"script"] completionHandler:^(id value, NSError *error) {
            probeReply(request, value, error.localizedDescription, reply);
        }];
        return;
    }
    probeReply(request, nil, @"unknown native operation", reply);
}
