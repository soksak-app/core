// An image region placed on a surface.
//
// The IOSurface is attached directly to the contents of the layer. The layer uses device pixel coordinates, so
// the layer scale is the number of device pixels that one unit covers. The pointer passes through (hitTest → nil).

#import <Carbon/Carbon.h>
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <IOSurface/IOSurface.h>
#import <QuartzCore/QuartzCore.h>
#include <stdlib.h>
#import "application_log.h"
#import "capture_frame_identity.h"
#import "event_ring.h"
#import "image_capture_match.h"
#import "image_region.h"
#import "input_press_context.h"
#import "webview_input.h"
#import "observe.h"
#import "webview_geometry.h"

static BOOL inputRangeFitsLength(NSRange range, NSUInteger length) {
    return range.location != NSNotFound && range.location <= length && range.length <= length - range.location;
}

static void failFrameIdentitySession(NSString *message) {
    char *error = NULL;
    if (!sp_image_capture_match_identity_session_fail(message.UTF8String, &error)) {
        sp_log_error("frame identity", error ?: "identity session could not record the tagging failure");
    }
    free(error);
    sp_log_error("frame identity", message.UTF8String);
    sp_region_restore_capture_identity();
}

@class SPImageRegion;

@interface SPImageClipView : NSClipView
@end

@implementation SPImageClipView
- (NSView *)hitTest:(NSPoint)point {
    NSPoint childPoint = [self.documentView convertPoint:point fromView:self];
    return [self.documentView hitTest:childPoint];
}
@end

// Image region implementation.
@interface SPImageRegion : NSView <NSTextInputClient>
@property sp_region_event event;
@property void *context;
@property(retain) CALayer *imageLayer;
@property(assign) CGImageRef snapshot;   // The immutable presentation snapshot that the host copies and owns.
@property size_t presentedWidth;
@property size_t presentedHeight;
@property double presentedScale;
@property uint64_t presentedGeneration;
@property uint64_t presentedRaster;
@property int presentedSequence;
@property(copy) NSString *presentationError;
@property(retain) NSTextInputContext *givenInputContext;  // The context of sp_region_set_input_context, or nil.
@property(assign) NSView *webSurface;  // The logical surface view. Not owned by this object.
@property NSEdgeInsets insets;
@property NSPoint caretPos;
@property double caretWidth;
@property double caretHeight;
@property(copy) NSString *accessibilityText;
@property(assign) NSView *observedSurface;
@property BOOL wanted;
@property BOOL placed;
@property BOOL closed;
@property BOOL hasFocus;
@property(copy) NSString *reportedPreedit;  // The composition string reported last.
@property(retain) NSMutableAttributedString *markedTextBuffer;
@property NSRange inputSelection;
@property BOOL unmarking;
@property BOOL hasReportedCompositionState;
@property NSRange reportedMarkedRange;
@property NSRange reportedSelectedRange;
@property BOOL reportedHasMarkedText;
@property(copy) NSString *unhandledKey;     // The report of a special key given to the input method first. Reported if the input method does not handle it.
@property NSUInteger reports;               // The number of reports sent. Used to check whether the input context answered a key.
@property(copy) NSString *activeCid;        // The correlation identifier of the input being processed; nil outside one.
@property(retain) NSMutableArray *inputActions;
@property(retain) NSMutableArray *inputErrors;
@property(retain) NSDictionary *inputPreedit;
@property(copy) NSString *inputFailureReason;
@property(copy) NSString *lastValidPreeditJSON;
- (void)applyInsets;
- (void)applyInsetsInTransaction;
- (void)applyInsetsNow;
- (void)report:(const char *)json;
- (void)reject:(NSString *)reason;
- (NSString *)jsonRange:(NSRange)range;
- (NSString *)jsonEscapedString:(NSString *)string;
- (NSString *)inputState;
- (NSString *)preeditSnapshotJSON:(BOOL *)changed;
- (void)reportInsert:(NSString *)text;
- (void)logInput:(NSString *)call fields:(NSString *)fields before:(NSString *)before;
- (BOOL)enterInput;
- (void)leaveInput:(BOOL)opened;
- (void)publishInput;
- (void)deliverReport:(NSString *)json cid:(NSString *)cid;
- (NSString *)currentCid;
- (void)emitInput:(const char *)name fields:(NSString *)fields;
- (void)handleKeyDown:(NSEvent *)event;
- (BOOL)handleBecomeFirstResponder;
- (BOOL)handleResignFirstResponder;
- (void)handleReportPreedit;
- (BOOL)rejectCallbackAfterInputFailure:(NSString *)call fields:(NSString *)fields before:(NSString *)before;
- (void)passToInputMethod:(NSEvent *)event;
- (void)failInput:(NSString *)reason where:(const char *)where text:(NSString *)text;
- (void)handleCommand:(SEL)selector;
- (void)handleInsertText:(id)string replacementRange:(NSRange)range;
- (void)handleSetMarkedText:(id)string selectedRange:(NSRange)selectedRange replacementRange:(NSRange)replacementRange;
- (void)surfaceScaleChanged;
- (void)observeSurface:(NSView *)surface;
@end

// The logical surface geometry is owned by the surface host. The weak import allows the existing WKWebView test
// surface to be used even while that owner is linked.
extern double sp_surface_scale(void *surface) __attribute__((weak_import));
extern void *sp_surface_main_webview(void *surface) __attribute__((weak_import));
extern void *sp_surface_native_plane(void *surface) __attribute__((weak_import));

static WKWebView *surfaceWebView(NSView *surface) {
    if (sp_surface_main_webview) return (WKWebView *)sp_surface_main_webview(surface);
    if ([surface isKindOfClass:WKWebView.class]) return (WKWebView *)surface;
    for (NSView *view = surface; view; view = view.superview) {
        if ([view isKindOfClass:WKWebView.class]) return (WKWebView *)view;
    }
    return nil;
}

static double surfaceScale(NSView *surface) {
    if (sp_surface_scale) {
        double scale = sp_surface_scale(surface);
        if (scale > 0) return scale;
    }
    WKWebView *webView = surfaceWebView(surface);
    return webView.pageZoom > 0 ? webView.pageZoom : 1;
}

static NSView *surfaceNativePlane(NSView *surface) {
    if (sp_surface_native_plane) return (NSView *)sp_surface_native_plane(surface);
    return (NSView *)webviewSurfaceNativePlane(surface);
}

static NSString *controlCharacterForANSIKeyCode(unsigned short keyCode) {
    static const unsigned short letterKeyCodes[] = {
        0, 11, 8, 2, 14, 3, 5, 4, 34, 38, 40, 37, 46,
        45, 31, 35, 12, 15, 1, 17, 32, 9, 13, 7, 16, 6,
    };
    static const char letters[] = "abcdefghijklmnopqrstuvwxyz";
    for (NSUInteger index = 0; index < sizeof(letterKeyCodes) / sizeof(letterKeyCodes[0]); index++) {
        if (keyCode == letterKeyCodes[index]) {
            return [NSString stringWithFormat:@"%c", letters[index]];
        }
    }
    switch (keyCode) {
        case 33: return @"[";
        case 42: return @"\\";
        case 30: return @"]";
        case 49: return @" ";
        default: return nil;
    }
}

// The name of a numeric keypad key. It is nil for a key that is not on the keypad. The sidecar decides the encoding
// of the application keypad mode (ESC =),
// so a keypad key is reported by name without passing through the input method.
static NSString *keypadKeyName(unsigned short keyCode) {
    switch (keyCode) {
        case 82: return @"Keypad0";
        case 83: return @"Keypad1";
        case 84: return @"Keypad2";
        case 85: return @"Keypad3";
        case 86: return @"Keypad4";
        case 87: return @"Keypad5";
        case 88: return @"Keypad6";
        case 89: return @"Keypad7";
        case 91: return @"Keypad8";
        case 92: return @"Keypad9";
        case 65: return @"KeypadDecimal";
        case 67: return @"KeypadMultiply";
        case 69: return @"KeypadPlus";
        case 75: return @"KeypadDivide";
        case 76: return @"KeypadEnter";
        case 78: return @"KeypadMinus";
        case 81: return @"KeypadEquals";
        default: return nil;
    }
}

// The registry of live image regions (weak references). A closed region disappears when it is deallocated. Every
// region operation is
// on the main thread.
static NSHashTable *spLiveRegions = nil;
static id spPressOriginMonitor = nil;
static NSUInteger spOpenRegionCount = 0;

void sp_region_restore_capture_identity(void) {
    NSCAssert(NSThread.isMainThread, @"image regions belong to the main thread");
    for (SPImageRegion *region in spLiveRegions) {
        if (region.closed || region.snapshot == NULL || region.imageLayer.contents == (id)region.snapshot) continue;
        [CATransaction begin];
        [CATransaction setDisableActions:YES];
        region.imageLayer.contents = (id)region.snapshot;
        [CATransaction commit];
    }
}

// Is the original point of a mouse press inside a live image region of the same window? Returns that region (including
// the region itself, nil if none). A paired drag or release is classified by its press origin.
static SPImageRegion *spRegionUnderPress(SPImageRegion *view) {
    double x = 0, y = 0;
    NSPoint windowPoint;
    if (sp_input_press_context_point(view.window, &x, &y)) {
        windowPoint = NSMakePoint(x, y);
    } else {
        NSEvent *event = NSApp.currentEvent;
        if (!event || event.window != view.window) return nil;
        switch (event.type) {
            case NSEventTypeLeftMouseDown:
            case NSEventTypeRightMouseDown:
            case NSEventTypeOtherMouseDown:
                windowPoint = event.locationInWindow;
                break;
            case NSEventTypeLeftMouseDragged:
            case NSEventTypeRightMouseDragged:
            case NSEventTypeOtherMouseDragged:
            case NSEventTypeLeftMouseUp:
            case NSEventTypeRightMouseUp:
            case NSEventTypeOtherMouseUp:
                if (!sp_input_press_origin_point(view.window, (int)event.buttonNumber, &x, &y, NULL)) return nil;
                windowPoint = NSMakePoint(x, y);
                break;
            default:
                return nil;
        }
    }
    NSPoint point = [view convertPoint:windowPoint fromView:nil];
    if (NSPointInRect(point, view.bounds)) return view;
    for (SPImageRegion *other in spLiveRegions) {
        if (other == view || !other.window || other.window != view.window || other.closed) continue;
        NSPoint inOther = [other convertPoint:windowPoint fromView:nil];
        if (NSPointInRect(inOther, other.bounds)) return other;
    }
    return nil;
}

static SPImageRegion *spRegionAtWindowPoint(NSWindow *window, NSPoint windowPoint) {
    for (SPImageRegion *region in spLiveRegions) {
        if (!region.closed && region.window == window && NSPointInRect([region convertPoint:windowPoint fromView:nil], region.bounds)) {
            return region;
        }
    }
    return nil;
}

static void spEnsurePressOriginMonitor(void) {
    if (spPressOriginMonitor) return;
    NSEventMask mask = NSEventMaskLeftMouseDown | NSEventMaskRightMouseDown | NSEventMaskOtherMouseDown
        | NSEventMaskLeftMouseUp | NSEventMaskRightMouseUp | NSEventMaskOtherMouseUp;
    spPressOriginMonitor = sp_observe_local_monitor("image_region.press_origin", SP_OBSERVE_COUNT, mask,
        ^NSEvent *(NSEvent *event) {
            NSWindow *window = event.window;
            if (!window) return event;
            int button = (int)event.buttonNumber;
            if (event.type == NSEventTypeLeftMouseDown || event.type == NSEventTypeRightMouseDown
                || event.type == NSEventTypeOtherMouseDown) {
                sp_input_press_origin_set(window, button, event.locationInWindow.x, event.locationInWindow.y);
            } else {
                double x = 0, y = 0;
                uint64_t token = 0;
                if (!sp_input_press_origin_point(window, button, &x, &y, &token)) return event;
                SPImageRegion *region = spRegionAtWindowPoint(window, NSMakePoint(x, y));
                if (region && region.webSurface) {
                    WKWebView *webView = surfaceWebView(region.webSurface);
                    if (!webView) {
                        sp_log_error("image region", "the press-origin surface has no page webview for release receipt");
                        sp_input_press_origin_clear(window, button, token);
                    } else {
                        webviewInputReceiveThenDrain(webView, @"pointerup", 1.0, ^(BOOL received) {
                            if (!received) sp_log_error("image region", "the paired pointer release was not received before press-origin cleanup");
                            sp_input_press_origin_clear(window, button, token);
                        });
                    }
                } else {
                    dispatch_async(dispatch_get_main_queue(), ^{
                        sp_input_press_origin_clear(window, button, token);
                    });
                }
            }
            return event;
        });
}

@implementation SPImageRegion

- (void)drawRect:(NSRect)dirtyRect {
    // TextKit state belongs to input only; the sidecar image is rendered by the child image layer.
}

- (id)initWithFrame:(NSRect)frame {
    self = [super initWithFrame:frame];
    if (!self) return nil;
    if (!spLiveRegions) spLiveRegions = [[NSHashTable alloc] initWithOptions:NSPointerFunctionsWeakMemory capacity:0];
    [spLiveRegions addObject:self];
    self.markedTextBuffer = [[[NSMutableAttributedString alloc] initWithString:@""] autorelease];
    self.inputSelection = NSMakeRange(0, 0);
    self.reportedPreedit = @"";
    self.lastValidPreeditJSON = @"{\"text\":\"\",\"markedRange\":null,\"selectedRange\":{\"location\":0,\"length\":0},\"replacementRange\":null,\"attributed\":false}";
    sp_observe_notification_selector("image_region.input_source", SP_OBSERVE_RECORD, self, @selector(inputSourceChanged:),
        NSTextInputContextKeyboardSelectionDidChangeNotification, nil);
    self.wantsLayer = YES;
    self.layerUsesCoreImageFilters = YES;
    self.imageLayer = [[[CALayer alloc] init] autorelease];
    [self.layer addSublayer:self.imageLayer];
    self.imageLayer.contentsScale = 1;
    // Raster pixels are neither enlarged nor reduced. After a raster that matches the new geometry is ready,
    // the outer surface transaction shows it on screen together with the DOM.
    self.imageLayer.contentsGravity = kCAGravityTopLeft;
    self.imageLayer.magnificationFilter = kCAFilterNearest;
    self.snapshot = NULL;
    return self;
}

- (void)dealloc {
    [NSNotificationCenter.defaultCenter removeObserver:self];
    [_reportedPreedit release];
    [_unhandledKey release];
    [_inputActions release];
    [_inputErrors release];
    [_inputPreedit release];
    [_inputFailureReason release];
    [_lastValidPreeditJSON release];
    [_markedTextBuffer release];
    // Releases the immutable snapshot after the contents of the layer are cleared.
    self.imageLayer.contents = nil;
    if (_snapshot) CGImageRelease(_snapshot);
    [_imageLayer release];
    [_presentationError release];
    [_accessibilityText release];
    [_givenInputContext release];
    [super dealloc];
}

// The keys of the region go to the supplied diagnostic context when present, and otherwise to AppKit's context.
- (NSTextInputContext *)inputContext {
    if (self.givenInputContext) return self.givenInputContext;
    return [super inputContext];
}

- (BOOL)acceptsFirstResponder {
    return YES;
}

- (NSView *)hitTest:(NSPoint)point {
    return nil;
}

// The image region is not a pointer hit target, so no cursor tracking area is needed.
- (void)updateTrackingAreas {
    [super updateTrackingAreas];
    for (NSTrackingArea *area in [[self.trackingAreas copy] autorelease]) {
        if (area.options & NSTrackingCursorUpdate) [self removeTrackingArea:area];
    }
}


// The Paste of the Edit menu notifies the page so that it runs the declared paste command. The paste of NSTextView
// puts the text into the input document,
// which is the workspace of the input method, so it is not used (docs/spec/persistent-services.md).
- (void)paste:(id)sender {
    [self report:"{\"type\":\"action\",\"name\":\"paste\"}"];
}

- (void)pasteAsPlainText:(id)sender {
    [self paste:sender];
}

// The Copy of the Edit menu makes the page run its copy command. The command copies the selection that the
// sidecar holds.
// The copy of NSTextView uses the selection of the input document and clears the pasteboard for an empty selection.
- (void)copy:(id)sender {
    [self report:"{\"type\":\"action\",\"name\":\"copy\"}"];
}

// The Edit actions that edit the input document are turned off because they are unrelated to the image region content.
- (BOOL)validateUserInterfaceItem:(id<NSValidatedUserInterfaceItem>)item {
    SEL action = item.action;
    if (action == @selector(paste:) || action == @selector(pasteAsPlainText:) || action == @selector(copy:)) return YES;
    if (action == @selector(cut:) || action == @selector(selectAll:) || action == @selector(delete:)) return NO; // silent: a turned-off Edit action is the answer of the menu validation, which AppKit shows as a disabled item
    return YES;
}

- (BOOL)validateMenuItem:(NSMenuItem *)item {
    return [self validateUserInterfaceItem:item];
}

// Keeps the Services menu from reading or changing the input document. The input document is the workspace of the
// input method, not the image region content.
- (id)validRequestorForSendType:(NSPasteboardType)sendType returnType:(NSPasteboardType)returnType {
    return nil;
}

- (void)applyInsetsInTransaction {
    NSView *clipView = self.superview;
    if (!clipView) return;
    NSView *surface = self.webSurface;
    if (!surface) return;

    NSView *nativePlane = clipView.superview;
    if (!nativePlane) return;
    NSSize planeFrameSize = nativePlane.frame.size;
    if (planeFrameSize.width > 0 && planeFrameSize.height > 0) {
        nativePlane.bounds = NSMakeRect(0, 0, planeFrameSize.width, planeFrameSize.height);
    }
    NSRect surfaceBounds = nativePlane.bounds;
    NSEdgeInsets insets = self.insets;

    // The surface geometry is expressed in AppKit points. The backing scale belongs to the image layer and
    // the raster size, not to the region frame or inset coordinates.
    // coordinates.
    CGFloat width = NSWidth(surfaceBounds) - (insets.left + insets.right);
    CGFloat height = NSHeight(surfaceBounds) - (insets.top + insets.bottom);

    // Clip view position: computed in the coordinate system of the superview of the surface
    CGFloat clipX = NSMinX(surfaceBounds) + insets.left;
    CGFloat clipTop = insets.top;
    CGFloat clipY = nativePlane.isFlipped ? NSMinY(surfaceBounds) + clipTop : NSMaxY(surfaceBounds) - clipTop - height;

    NSRect clipFrame = NSMakeRect(clipX, clipY, MAX(width, 0), MAX(height, 0));
    clipView.frame = clipFrame;

    // The region view occupies its bounds inside the clip view. Geometry changes occur on every frame
    // during a drag, so Core Animation must not interpolate between the old and new positions.
    self.frame = NSMakeRect(0, 0, MAX(width, 0), MAX(height, 0));
    self.imageLayer.frame = self.bounds;
    [self updateContentsScale];

    // The hiding of the surface is handled by the parent view hierarchy. If the child region also stored that state
    // in its own hidden
    // flag, the region would stay hidden permanently in a transition where showing the surface again
    // does not call applyInsets again.
    self.hidden = !self.wanted || width < 1 || height < 1;
}

- (void)applyInsetsNow {
    [CATransaction begin];
    [CATransaction setDisableActions:YES];
    [self applyInsetsInTransaction];
    [CATransaction commit];
}

// Applies the prepared geometry. The outer surface transaction owns the presentation of this change.
- (void)applyInsets {
    [self applyInsetsNow];
}


- (void)surfaceScaleChanged {
    if (self.placed) [self applyInsets];
}

- (void)viewWillMoveToSuperview:(NSView *)superview {
    [self observeSurface:nil];
    [super viewWillMoveToSuperview:superview];
}

- (void)observeSurface:(NSView *)surface {
    if (self.observedSurface == surface) return;
    if (self.observedSurface) {
        [NSNotificationCenter.defaultCenter removeObserver:self name:NSViewFrameDidChangeNotification object:self.observedSurface];
    }
    self.observedSurface = surface;
    if (!surface) return;
    surface.postsFrameChangedNotifications = YES;
    sp_observe_notification_selector("image_region.resized", SP_OBSERVE_COUNT, self, @selector(surfaceResized:),
        NSViewFrameDidChangeNotification, surface);
}

- (void)viewDidMoveToSuperview {
    [super viewDidMoveToSuperview];
    NSView *clipView = self.superview;
    [self observeSurface:clipView && clipView.superview ? clipView.superview : nil];
}

// The number of device pixels that one layer unit covers. The view hierarchy that holds the surface can have its own
// bounds scale
// (the webview container of one host has 0.5pt per unit), so AppKit is asked instead of assuming point units.
// Setting this value as contentsScale presents one pixel of the image as one device pixel.
- (CGFloat)backingPixelsPerUnit {
    NSRect bounds = self.bounds;
    if (NSWidth(bounds) <= 0) return 0;
    return NSWidth([self convertRectToBacking:bounds]) / NSWidth(bounds);
}

- (void)updateContentsScale {
    CGFloat pixels = [self backingPixelsPerUnit];
    if (pixels > 0) self.imageLayer.contentsScale = pixels;
}

- (void)viewDidChangeBackingProperties {
    [super viewDidChangeBackingProperties];
    [self updateContentsScale];
}

- (void)surfaceResized:(NSNotification *)notification {
    sp_observe_delivered("image_region.resized");
    if (self.placed) [self applyInsets];
}

// The correlation identifier of the input that the region is processing, or the next identifier when no input is open.
// Without an identifier (the boot identifier of the run is not set) it is nil, and the record that follows has none, which
// the audit of the logs refuses.
- (NSString *)currentCid {
    if (self.activeCid) return self.activeCid;
    char buffer[96];
    if (!sp_cid_new(buffer, sizeof buffer)) {
        sp_log_error("input method", "no correlation identifier can be assigned: the boot identifier of the run is not set");
        return nil;
    }
    return @(buffer);
}

// Opens one input for the callbacks that follow: they and the reports they cause take one identifier. It returns YES when
// this call opened the input, and the caller closes it with leaveInput. A call inside an open input joins that input.
- (BOOL)enterInput {
    BOOL opens = self.activeCid == nil;
    if (opens) {
        self.activeCid = [self currentCid];
        if (self.activeCid) {
            self.inputActions = [NSMutableArray array];
            self.inputErrors = [NSMutableArray array];
            self.inputPreedit = nil;
            self.inputFailureReason = nil;
        }
    }
    return opens && self.activeCid != nil;
}

- (void)leaveInput:(BOOL)opened {
    if (!opened) return;
    @try {
        [self publishInput];
    } @finally {
        self.activeCid = nil;
        self.inputActions = nil;
        self.inputErrors = nil;
        self.inputPreedit = nil;
        self.inputFailureReason = nil;
    }
}

- (void)publishInput {
    if (self.inputActions.count == 0 && self.inputErrors.count == 0
        && !self.inputPreedit) return;
    NSDictionary *preedit = self.inputPreedit;
    if (!preedit) {
        NSData *data = [self.lastValidPreeditJSON dataUsingEncoding:NSUTF8StringEncoding];
        NSError *error = nil;
        preedit = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
        if (error) sp_log_error("input transaction", [NSString stringWithFormat:
            @"the stored preedit snapshot is invalid: %@", error.localizedDescription].UTF8String);
    }
    if (![preedit isKindOfClass:NSDictionary.class]) {
        NSString *reason = @"the final preedit snapshot is not a JSON object";
        sp_log_error("input transaction", reason.UTF8String);
        return;
    }
    NSDictionary *transaction = @{
        @"type": @"input",
        @"actions": self.inputActions ?: @[],
        @"preedit": preedit,
        @"errors": self.inputErrors ?: @[],
        @"cids": @[self.activeCid],
    };
    NSError *error = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:transaction options:0 error:&error];
    if (!data) {
        sp_log_error("input transaction", [NSString stringWithFormat:
            @"the native input transaction could not be serialized: %@", error.localizedDescription ?: @"serialization failed"].UTF8String);
        return;
    }
    NSString *json = [[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] autorelease];
    [self deliverReport:json cid:self.activeCid];
}

- (void)deliverReport:(NSString *)json cid:(NSString *)cid {
    NSError *error = nil;
    id parsed = [NSJSONSerialization JSONObjectWithData:[json dataUsingEncoding:NSUTF8StringEncoding]
        options:NSJSONReadingMutableContainers error:&error];
    if (error || ![parsed isKindOfClass:NSDictionary.class]) {
        sp_log_error("input transaction", [NSString stringWithFormat:
            @"native input report cannot be delivered as a JSON object: %@", error.localizedDescription ?: @"invalid JSON object"].UTF8String);
        return;
    }
    NSMutableDictionary *payload = [parsed mutableCopy];
    if (cid && !payload[@"cids"]) [payload setObject:@[cid] forKey:@"cids"];
    NSData *payloadData = [NSJSONSerialization dataWithJSONObject:payload options:0 error:&error];
    [payload release];
    if (!payloadData) {
        sp_log_error("input transaction", [NSString stringWithFormat:
            @"native input report cannot be serialized: %@", error.localizedDescription ?: @"serialization failed"].UTF8String);
        return;
    }
    NSString *report = [[[NSString alloc] initWithData:payloadData encoding:NSUTF8StringEncoding] autorelease];
    NSDictionary *record = @{ @"report": report, @"dropped": @((BOOL)(self.closed || !self.event)) };
    NSData *recorded = [NSJSONSerialization dataWithJSONObject:record options:0 error:NULL];
    NSString *fields = [[[NSString alloc] initWithData:recorded encoding:NSUTF8StringEncoding] autorelease];
    sp_event_cids(SP_CLASS_INPUT, SP_EVENT_INFO, "native.input.report", cid.UTF8String ?: "", fields.UTF8String);
    if (self.closed || !self.event) return;
    self.event(self.context, report.UTF8String);
}

// Stores one event of the input class with the correlation identifier of the input being processed.
- (void)emitInput:(const char *)name fields:(NSString *)fields {
    NSString *cid = [self currentCid];
    // events: native.input.key_down, native.input.callback
    sp_event_cids(SP_CLASS_INPUT, SP_EVENT_INFO, name, cid.UTF8String ?: "", fields.UTF8String);
}

- (BOOL)rejectCallbackAfterInputFailure:(NSString *)call fields:(NSString *)fields before:(NSString *)before {
    if (!self.inputFailureReason) return NO; // silent: NO means the input scope is still valid and the caller should continue.
    NSString *prefix = fields.length ? [fields stringByAppendingString:@","] : @"";
    NSString *record = [NSString stringWithFormat:
        @"%@\"dropped\":\"input scope already failed\",\"failure\":\"%@\"",
        prefix, [self jsonEscapedString:self.inputFailureReason]];
    [self logInput:call fields:record before:before];
    return YES;
}

// Records a report to the page as the event `native.input.report`, and sends it with the correlation identifier of the input
// as the member `cids`. A report that is dropped is recorded as dropped.
- (void)report:(const char *)json {
    NSString *cid = [self currentCid];
    self.reports++;
    NSString *text = @(json);
    if (self.activeCid && self.inputActions && self.inputErrors) {
        NSData *data = [text dataUsingEncoding:NSUTF8StringEncoding];
        NSError *parseError = nil;
        NSDictionary *value = [NSJSONSerialization JSONObjectWithData:data options:0 error:&parseError];
        if (parseError) {
            NSString *reason = [NSString stringWithFormat:@"native input report is invalid JSON: %@", parseError.localizedDescription];
            sp_log_error("input transaction", reason.UTF8String);
            [self.inputErrors addObject:@{ @"reason": reason }];
            if (!self.inputFailureReason) self.inputFailureReason = reason;
            return;
        }
        NSString *type = [value isKindOfClass:NSDictionary.class] ? value[@"type"] : nil;
        if ([type isEqual:@"compose"]) {
            NSMutableDictionary *snapshot = [value mutableCopy];
            [snapshot removeObjectForKey:@"type"];
            [snapshot removeObjectForKey:@"cids"];
            self.inputPreedit = [snapshot autorelease];
            return;
        }
        if ([type isEqual:@"insert"]) {
            NSDictionary *snapshot = value[@"preedit"];
            if ([snapshot isKindOfClass:NSDictionary.class]) self.inputPreedit = snapshot;
            NSMutableDictionary *action = [value mutableCopy];
            [action removeObjectForKey:@"type"];
            [action removeObjectForKey:@"cids"];
            [action removeObjectForKey:@"preedit"];
            [action setObject:type forKey:@"type"];
            [self.inputActions addObject:action];
            [action release];
            return;
        }
        if ([type isEqual:@"error"]) {
            NSString *reason = value[@"reason"] ?: @"input callback failed";
            [self.inputErrors addObject:@{ @"reason": reason }];
            if (!self.inputFailureReason) self.inputFailureReason = reason;
            return;
        }
        if ([type isEqual:@"key"] || [type isEqual:@"command"] || [type isEqual:@"focus"]) {
            NSMutableDictionary *action = [value mutableCopy];
            [action removeObjectForKey:@"type"];
            [action removeObjectForKey:@"cids"];
            [action setObject:type forKey:@"type"];
            [self.inputActions addObject:action];
            [action release];
            return;
        }
        sp_log_error("input transaction", [NSString stringWithFormat:@"unsupported report type %@ in input scope",
            type ?: @"<invalid JSON>"].UTF8String);
        NSString *reason = @"native input scope emitted an unsupported report";
        [self.inputErrors addObject:@{ @"reason": reason }];
        if (!self.inputFailureReason) self.inputFailureReason = reason;
        return;
    }
    [self deliverReport:text cid:cid];
}

// Records a failure of the input as the event `native.record.error` with the correlation identifier of the input, so the
// chain of the input ends at the error (docs/spec/logging.md#catalog), and reports the reason to the page as an error.
- (void)failInput:(NSString *)reason where:(const char *)where text:(NSString *)text {
    NSString *cid = [self currentCid];
    NSData *recorded = [NSJSONSerialization dataWithJSONObject:@{ @"where": @(where), @"text": text } options:0 error:NULL];
    NSString *fields = [[[NSString alloc] initWithData:recorded encoding:NSUTF8StringEncoding] autorelease];
    sp_event_cids(SP_CLASS_LIFECYCLE, SP_EVENT_ERROR, "native.record.error", cid.UTF8String ?: "", fields.UTF8String);
    NSData *data = [NSJSONSerialization dataWithJSONObject:@{ @"type": @"error", @"reason": reason } options:0 error:NULL];
    [self report:[[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] autorelease].UTF8String];
}

- (void)reject:(NSString *)reason {
    self.presentationError = reason;
    [self failInput:reason where:"image region" text:[NSString stringWithFormat:@"%@ (state %@)", reason, [self inputState]]];
}

- (BOOL)becomeFirstResponder {
    BOOL opened = [self enterInput];
    BOOL result = NO;
    @try {
        result = [self handleBecomeFirstResponder];
    } @finally {
        [self leaveInput:opened];
    }
    return result;
}

- (BOOL)handleBecomeFirstResponder {
    NSString *before = [self inputState];
    BOOL result = [super becomeFirstResponder];
    [self logInput:@"becomeFirstResponder" fields:[NSString stringWithFormat:@"\"result\":%@", result ? @"true" : @"false"] before:before];
    if (result && !self.hasFocus) {
        self.hasFocus = YES;
        [self report:"{\"type\":\"focus\",\"focused\":true}"];
    }
    return result;
}

- (BOOL)resignFirstResponder {
    BOOL opened = [self enterInput];
    BOOL result = NO;
    @try {
        result = [self handleResignFirstResponder];
    } @finally {
        [self leaveInput:opened];
    }
    return result;
}

- (BOOL)handleResignFirstResponder {
    NSString *before = [self inputState];
    [self commitPending];
    BOOL result = [super resignFirstResponder];
    [self logInput:@"resignFirstResponder" fields:[NSString stringWithFormat:@"\"result\":%@", result ? @"true" : @"false"] before:before];
    if (result && self.hasFocus) {
        SPImageRegion *pressed = spRegionUnderPress(self);
        if (pressed == self) {
            // While the press passthrough makes the webview the first responder, no focus report is sent. Without a
            // report, the focus
            // command of the page also believes focus is already there and returns as a no-op, so this view takes the
            // responder back
            // itself. It runs right after the same event handling so that keyboard input is not delivered to the
            // page.
            dispatch_async(dispatch_get_main_queue(), ^{
                if (!self.closed && self.window && self.window.firstResponder != self && self.hasFocus) {
                    [self.window makeFirstResponder:self];
                }
            });
            return result;
        }
        if (pressed != nil) {
            // The press is inside another image region, so the focus moves for real from this region to that region.
            // It reports the loss and hands the responder to the pressed region. If a window remains whose responder
            // is
            // the page webview, the page gets keyboard focus and focus fires again on the address bar that is the
            // activeElement
            // (V5-114). It hands over right after the same event handling.
            self.hasFocus = NO;
            [self report:"{\"type\":\"focus\",\"focused\":false}"];
            dispatch_async(dispatch_get_main_queue(), ^{
                if (!pressed.closed && pressed.window && pressed.window.firstResponder != (NSResponder *)pressed) {
                    [pressed.window makeFirstResponder:(NSResponder *)pressed];
                }
            });
            return result;
        }
        self.hasFocus = NO;
        [self report:"{\"type\":\"focus\",\"focused\":false}"];
    }
    return result;
}

// A key is one input: the layer that first sees it assigns its correlation identifier, and every callback of the input method
// and every report that the key causes carries it (docs/spec/logging.md#correlation-identifier).
- (void)keyDown:(NSEvent *)event {
    BOOL opened = [self enterInput];
    [self handleKeyDown:event];
    [self leaveInput:opened];
}

- (void)handleKeyDown:(NSEvent *)event {
    // The event holds the whole key: the key code, the characters with and without the modifiers, the modifier flags,
    // the repeat flag and the time of the key, and the state of the input document.
    NSString *state = [self inputState];
    [self emitInput:"native.input.key_down" fields:[NSString stringWithFormat:
        @"{\"keyCode\":%hu,\"characters\":\"%@\",\"charactersIgnoringModifiers\":\"%@\",\"modifierFlags\":%lu,\"isARepeat\":%@,\"timestamp\":%.6f,\"before\":%@,\"after\":%@}",
        event.keyCode, [self jsonEscapedString:event.characters ?: @""],
        [self jsonEscapedString:event.charactersIgnoringModifiers ?: @""], (unsigned long)event.modifierFlags,
        event.isARepeat ? @"true" : @"false", event.timestamp, state, state]];
    // A Command combination is not reported but handed to the menu.
    if (event.modifierFlags & NSEventModifierFlagCommand) {
        [super keyDown:event];
        return;
    }

    // A marked buffer remains owned by this client until the input method commits or cancels it.
    if ([self hasMarkedText]) {
        [self passToInputMethod:event];
        return;
    }

    // Checks whether the key is a special key or a Ctrl/Option combination.
    NSString *characters = event.charactersIgnoringModifiers;
    if (characters.length == 0) {
        [super keyDown:event];
        return;
    }

    unichar ch = [characters characterAtIndex:0];
    NSEventModifierFlags flags = event.modifierFlags;
    BOOL hasCtrlOrOption = (flags & NSEventModifierFlagControl) || (flags & NSEventModifierFlagOption);

    NSString *keypad = keypadKeyName(event.keyCode);
    if (keypad) {
        NSString *json = [NSString stringWithFormat:@"{\"type\":\"key\",\"key\":\"%@\",\"shift\":%s,\"alt\":%s,\"ctrl\":%s}",
            keypad,
            (flags & NSEventModifierFlagShift) ? "true" : "false",
            (flags & NSEventModifierFlagOption) ? "true" : "false",
            (flags & NSEventModifierFlagControl) ? "true" : "false"];
        [self commitPending];
        [self report:json.UTF8String];
        return;
    }

    // Special key decision: function keys and specific character codes
    BOOL isSpecialKey = NO;
    NSString *keyName = nil;

    // Function keys
    if (ch == NSUpArrowFunctionKey) {
        isSpecialKey = YES;
        keyName = @"Up";
    } else if (ch == NSDownArrowFunctionKey) {
        isSpecialKey = YES;
        keyName = @"Down";
    } else if (ch == NSLeftArrowFunctionKey) {
        isSpecialKey = YES;
        keyName = @"Left";
    } else if (ch == NSRightArrowFunctionKey) {
        isSpecialKey = YES;
        keyName = @"Right";
    } else if (ch == NSHomeFunctionKey) {
        isSpecialKey = YES;
        keyName = @"Home";
    } else if (ch == NSEndFunctionKey) {
        isSpecialKey = YES;
        keyName = @"End";
    } else if (ch == NSPageUpFunctionKey) {
        isSpecialKey = YES;
        keyName = @"PageUp";
    } else if (ch == NSPageDownFunctionKey) {
        isSpecialKey = YES;
        keyName = @"PageDown";
    } else if (ch == NSDeleteFunctionKey) {  // forward delete
        isSpecialKey = YES;
        keyName = @"Delete";
    } else if (ch == NSInsertFunctionKey) {
        isSpecialKey = YES;
        keyName = @"Insert";
    } else if (ch >= NSF1FunctionKey && ch <= NSF12FunctionKey) {
        isSpecialKey = YES;
        NSUInteger fNum = ch - NSF1FunctionKey + 1;
        keyName = [NSString stringWithFormat:@"F%lu", (unsigned long)fNum];
    }
    // Specific characters
    else if (ch == '\r' || ch == NSEnterCharacter) {
        isSpecialKey = YES;
        keyName = @"Enter";
    } else if (ch == '\t') {
        isSpecialKey = YES;
        keyName = @"Tab";
    } else if (ch == NSBackTabCharacter) {
        isSpecialKey = YES;
        keyName = @"Tab";
    } else if (ch == 0x7f) {  // Backspace
        isSpecialKey = YES;
        keyName = @"Backspace";
    } else if (ch == 0x1b) {  // Escape
        isSpecialKey = YES;
        keyName = @"Escape";
    }

    // A special key or a Ctrl/Option combination reports a key event.
    if (isSpecialKey || hasCtrlOrOption) {
        BOOL shift = (flags & NSEventModifierFlagShift) != 0;
        BOOL alt = (flags & NSEventModifierFlagOption) != 0;
        BOOL ctrl = (flags & NSEventModifierFlagControl) != 0;

        // BackTab is reported as shift:true.
        if (ch == NSBackTabCharacter) {
            shift = YES;
        }

        NSString *json;
        if (isSpecialKey) {
            json = [NSString stringWithFormat:@"{\"type\":\"key\",\"key\":\"%@\",\"shift\":%s,\"alt\":%s,\"ctrl\":%s}",
                keyName,
                shift ? "true" : "false",
                alt ? "true" : "false",
                ctrl ? "true" : "false"];
        } else {
            // Ctrl/Option combination character
            NSString *keyCharacter = (flags & NSEventModifierFlagControl)
                ? controlCharacterForANSIKeyCode(event.keyCode)
                : nil;
            if ((flags & NSEventModifierFlagControl) && keyCharacter.length == 0) {
                NSString *reason = [NSString stringWithFormat:
                    @"unsupported Ctrl character: native keyCode=%hu, character=U+%04X",
                    event.keyCode, ch];
                [self failInput:reason where:"image region" text:reason];
                return;
            }
            unichar reportedCharacter = keyCharacter.length > 0 ? [keyCharacter characterAtIndex:0] : ch;
            NSString *textChar = [[NSString stringWithCharacters:&reportedCharacter length:1] stringByReplacingOccurrencesOfString:@"\\" withString:@"\\\\"];
            textChar = [textChar stringByReplacingOccurrencesOfString:@"\"" withString:@"\\\""];
            json = [NSString stringWithFormat:@"{\"type\":\"key\",\"key\":\"Char\",\"text\":\"%@\",\"shift\":%s,\"alt\":%s,\"ctrl\":%s}",
                textChar,
                shift ? "true" : "false",
                alt ? "true" : "false",
                ctrl ? "true" : "false"];
        }
        // If the input method still has a string it can revise, the special key is given to the input method first
        // (for example, Backspace
        // during composition turns a syllable with a final consonant into one without it). If the input method does
        // not handle the key, AppKit requests the command of that key, and
        // then the remaining string is committed and the original key is reported (doCommandBySelector:).
        if (isSpecialKey && !hasCtrlOrOption && self.markedTextBuffer.length > 0) {
            self.unhandledKey = json;
            [self interpretKeyEvents:@[event]];
            self.unhandledKey = nil;
            return;
        }
        [self commitPending];
        [self report:json.UTF8String];
        return;
    }

    // A normal character is passed to the input method.
    [self passToInputMethod:event];
}

// The input method answers only the key window of the active application. After the application has been activated once,
// the input context receives a key sent to another window but inserts no character, so no answer is reported as an error.
- (void)passToInputMethod:(NSEvent *)event {
    NSUInteger before = self.reports;
    [self interpretKeyEvents:@[event]];
    if (self.reports == before && !(NSApp.isActive && self.window.isKeyWindow)) {
        NSString *reason = [NSString stringWithFormat:
            @"input method did not answer native keyCode=%hu outside the key window of the active application",
            event.keyCode];
        [self failInput:reason where:"input method" text:[NSString stringWithFormat:@"%@: state %@", reason, [self inputState]]];
    }
}

- (void)doCommandBySelector:(SEL)selector {
    BOOL opened = [self enterInput];
    [self handleCommand:selector];
    [self leaveInput:opened];
}

- (void)handleCommand:(SEL)selector {
    if (self.inputFailureReason) {
        NSString *fields = [NSString stringWithFormat:@"\"selector\":\"%@\",\"unhandledKey\":\"%@\"",
            [self jsonEscapedString:NSStringFromSelector(selector)], [self jsonEscapedString:self.unhandledKey ?: @""]];
        [self rejectCallbackAfterInputFailure:@"doCommandBySelector" fields:fields before:[self inputState]];
        return;
    }
    // A noop: command that no unhandled key accompanies is dropped below, and the record says so.
    BOOL dropped = !self.unhandledKey && selector == @selector(noop:);
    [self logInput:@"doCommandBySelector" fields:[NSString stringWithFormat:@"\"selector\":\"%@\",\"unhandledKey\":\"%@\"%@",
        [self jsonEscapedString:NSStringFromSelector(selector)], [self jsonEscapedString:self.unhandledKey ?: @""],
        dropped ? @",\"dropped\":\"noop\"" : @""] before:nil];
    // A special key that the input method did not handle is reported as the original key, not as a command.
    NSString *key = [[self.unhandledKey retain] autorelease];
    if (key) {
        self.unhandledKey = nil;
        [self commitPending];
        [self report:key.UTF8String];
        return;
    }
    // The standard key bindings of AppKit send noop: for input that performs no action.
    // Passing it to the sidecar would make a selector that is not a key input a sidecar error.
    if (selector == @selector(noop:)) return;
    // NSTextInputClient commands are part of the input stream. Discarding them would lose IME actions
    // such as cancel, delete, and accept.
    [self commitPending];
    NSString *name = NSStringFromSelector(selector);
    NSString *json = [NSString stringWithFormat:@"{\"type\":\"command\",\"selector\":\"%@\"}",
        [self jsonEscapedString:name]];
    [self report:json.UTF8String];
}

// The client owns only the current marked text. A commit emits the resolved replacement once and clears that buffer;
// terminal output, including previously committed text, is not an editable client document.
- (void)insertText:(id)string replacementRange:(NSRange)range {
    BOOL opened = [self enterInput];
    [self handleInsertText:string replacementRange:range];
    [self leaveInput:opened];
}

- (void)handleInsertText:(id)string replacementRange:(NSRange)range {
    BOOL attributed = [string isKindOfClass:NSAttributedString.class];
    NSString *text = attributed ? [(NSAttributedString *)string string]
        : ([string isKindOfClass:NSString.class] ? (NSString *)string : nil);
    NSString *before = [self inputState];
    NSString *fields = [NSString stringWithFormat:@"\"text\":%@,\"attributed\":%@,\"replacementRange\":%@",
        text ? [NSString stringWithFormat:@"\"%@\"", [self jsonEscapedString:text]] : @"null",
        attributed ? @"true" : @"false", [self jsonRange:range]];
    if ([self rejectCallbackAfterInputFailure:@"insertText" fields:fields before:before]) return;
    if (!text) {
        [self logInput:@"insertText" fields:[fields stringByAppendingString:@",\"dropped\":\"not text\""] before:before];
        return;
    }
    if (range.location != NSNotFound && !inputRangeFitsLength(range, self.markedTextBuffer.length)) {
        NSString *reason = [NSString stringWithFormat:@"replacement range %@ is outside the marked buffer of length %lu",
            [self jsonRange:range], (unsigned long)self.markedTextBuffer.length];
        [self failInput:reason where:"input method" text:[NSString stringWithFormat:
            @"%@: text \"%@\" replacement %@ state %@", reason, [self jsonEscapedString:text],
            [self jsonRange:range], [self inputState]]];
        [self logInput:@"insertText" fields:[fields stringByAppendingFormat:
            @",\"dropped\":\"invalid replacement range\",\"reason\":\"%@\"", [self jsonEscapedString:reason]] before:before];
        return;
    }
    NSString *committed = text;
    if (range.location != NSNotFound) {
        NSMutableString *replacement = [NSMutableString stringWithString:self.markedTextBuffer.string];
        [replacement replaceCharactersInRange:range withString:text];
        committed = replacement;
    }
    self.markedTextBuffer = [[[NSMutableAttributedString alloc] initWithString:@""] autorelease];
    self.inputSelection = NSMakeRange(0, 0);
    [self reportInsert:committed];
    [self logInput:@"insertText" fields:fields before:before];
}

- (void)setMarkedText:(id)string selectedRange:(NSRange)selectedRange replacementRange:(NSRange)replacementRange {
    BOOL opened = [self enterInput];
    [self handleSetMarkedText:string selectedRange:selectedRange replacementRange:replacementRange];
    [self leaveInput:opened];
}

- (void)handleSetMarkedText:(id)string selectedRange:(NSRange)selectedRange replacementRange:(NSRange)replacementRange {
    BOOL attributed = [string isKindOfClass:NSAttributedString.class];
    NSString *text = attributed ? [(NSAttributedString *)string string]
        : ([string isKindOfClass:NSString.class] ? (NSString *)string : nil);
    NSString *before = [self inputState];
    NSString *fields = [NSString stringWithFormat:
        @"\"text\":%@,\"attributed\":%@,\"selectedRange\":%@,\"replacementRange\":%@",
        text ? [NSString stringWithFormat:@"\"%@\"", [self jsonEscapedString:text]] : @"null",
        attributed ? @"true" : @"false", [self jsonRange:selectedRange], [self jsonRange:replacementRange]];
    if ([self rejectCallbackAfterInputFailure:@"setMarkedText" fields:fields before:before]) return;
    if (!text) {
        [self logInput:@"setMarkedText" fields:[fields stringByAppendingString:@",\"dropped\":\"not text\""] before:before];
        return;
    }
    if (text.length == 0) {
        self.markedTextBuffer = [[[NSMutableAttributedString alloc] initWithString:@""] autorelease];
        self.inputSelection = NSMakeRange(0, 0);
        [self reportPreedit];
        [self logInput:@"setMarkedText" fields:fields before:before];
        return;
    }
    BOOL selectedValid = selectedRange.location == NSNotFound
        ? selectedRange.length == 0 : inputRangeFitsLength(selectedRange, text.length);
    if (!selectedValid) {
        NSString *reason = [NSString stringWithFormat:@"selected range %@ is outside marked text of length %lu",
            [self jsonRange:selectedRange], (unsigned long)text.length];
        [self failInput:reason where:"input method" text:[NSString stringWithFormat:
            @"%@: text \"%@\" selected %@ state %@", reason, [self jsonEscapedString:text],
            [self jsonRange:selectedRange], [self inputState]]];
        [self logInput:@"setMarkedText" fields:[fields stringByAppendingFormat:
            @",\"dropped\":\"invalid selected range\",\"reason\":\"%@\"", [self jsonEscapedString:reason]] before:before];
        return;
    }
    BOOL replacementValid = replacementRange.location == NSNotFound
        || inputRangeFitsLength(replacementRange, self.markedTextBuffer.length);
    if (!replacementValid) {
        NSString *reason = [NSString stringWithFormat:@"replacement range %@ is outside marked buffer of length %lu",
            [self jsonRange:replacementRange], (unsigned long)self.markedTextBuffer.length];
        [self failInput:reason where:"input method" text:[NSString stringWithFormat:
            @"%@: text \"%@\" replacement %@ state %@", reason, [self jsonEscapedString:text],
            [self jsonRange:replacementRange], [self inputState]]];
        [self logInput:@"setMarkedText" fields:[fields stringByAppendingFormat:
            @",\"dropped\":\"unsupported replacement range\",\"reason\":\"%@\"", [self jsonEscapedString:reason]] before:before];
        return;
    }
    NSMutableString *replacement = [NSMutableString stringWithString:self.markedTextBuffer.string];
    NSUInteger insertionLocation = replacementRange.location == NSNotFound ? 0 : replacementRange.location;
    NSRange mutationRange = replacementRange.location == NSNotFound
        ? NSMakeRange(0, replacement.length) : replacementRange;
    [replacement replaceCharactersInRange:mutationRange withString:text];
    self.markedTextBuffer = [[[NSMutableAttributedString alloc] initWithString:replacement] autorelease];
    self.inputSelection = selectedRange.location == NSNotFound
        ? NSMakeRange(NSNotFound, 0) : NSMakeRange(insertionLocation + selectedRange.location, selectedRange.length);
    [self reportPreedit];
    [self logInput:@"setMarkedText" fields:fields before:before];
}

- (void)unmarkText {
    BOOL opened = [self enterInput];
    NSString *before = [self inputState];
    if (![self rejectCallbackAfterInputFailure:@"unmarkText" fields:@"" before:before]) {
        NSString *committed = [[self.markedTextBuffer.string copy] autorelease];
        self.markedTextBuffer = [[[NSMutableAttributedString alloc] initWithString:@""] autorelease];
        self.inputSelection = NSMakeRange(0, 0);
        if (committed.length) [self reportInsert:committed];
        else [self reportPreedit];
        [self logInput:@"unmarkText" fields:@"" before:before];
    }
    [self leaveInput:opened];
}

- (BOOL)hasMarkedText {
    BOOL marked = self.markedTextBuffer.length > 0;
    [self logQuery:@"hasMarkedText" fields:^NSString * { return [NSString stringWithFormat:@"\"answer\":%@", marked ? @"true" : @"false"]; }];
    return marked;
}

- (NSRange)markedRange {
    NSRange range = self.markedTextBuffer.length ? NSMakeRange(0, self.markedTextBuffer.length) : NSMakeRange(NSNotFound, 0);
    [self logQuery:@"markedRange" fields:^NSString * { return [NSString stringWithFormat:@"\"answer\":%@", [self jsonRange:range]]; }];
    return range;
}

- (NSRange)selectedRange {
    NSRange range = self.inputSelection;
    [self logQuery:@"selectedRange" fields:^NSString * { return [NSString stringWithFormat:@"\"answer\":%@", [self jsonRange:range]]; }];
    return range;
}

- (NSArray<NSAttributedStringKey> *)validAttributesForMarkedText {
    return @[];
}

- (NSAttributedString *)attributedSubstringForProposedRange:(NSRange)range actualRange:(NSRangePointer)actualRange {
    if (!inputRangeFitsLength(range, self.markedTextBuffer.length)) {
        if (actualRange) *actualRange = NSMakeRange(NSNotFound, 0);
        return nil;
    }
    if (actualRange) *actualRange = range;
    return [[[NSAttributedString alloc] initWithAttributedString:
        [self.markedTextBuffer attributedSubstringFromRange:range]] autorelease];
}

- (NSString *)preeditSnapshotJSON:(BOOL *)changedOut {
    NSString *preedit = self.markedTextBuffer.string;
    BOOL hasMarkedText = preedit.length > 0;
    NSRange localMarked = hasMarkedText ? NSMakeRange(0, preedit.length) : NSMakeRange(NSNotFound, 0);
    NSRange selected = self.inputSelection;
    BOOL selectedValid = selected.location == NSNotFound
        ? selected.length == 0 : inputRangeFitsLength(selected, preedit.length);
    if (!selectedValid) {
        NSString *reason = [NSString stringWithFormat:@"selected range %@ is outside marked text of length %lu",
            [self jsonRange:selected], (unsigned long)preedit.length];
        [self failInput:reason where:"composition range" text:[NSString stringWithFormat:@"%@ (state %@)", reason, [self inputState]]];
        return nil;
    }
    NSRange localSelected = selected;
    BOOL changed = !self.hasReportedCompositionState
        || ![preedit isEqualToString:self.reportedPreedit]
        || hasMarkedText != self.reportedHasMarkedText
        || !NSEqualRanges(localMarked, self.reportedMarkedRange)
        || !NSEqualRanges(localSelected, self.reportedSelectedRange);
    if (changedOut) *changedOut = changed;
    self.reportedPreedit = preedit;
    self.hasReportedCompositionState = YES;
    self.reportedHasMarkedText = hasMarkedText;
    self.reportedMarkedRange = localMarked;
    self.reportedSelectedRange = localSelected;
    [self logInput:@"reportPreedit" fields:[NSString stringWithFormat:@"\"preedit\":\"%@\",\"changed\":%@",
        [self jsonEscapedString:preedit], changed ? @"true" : @"false"] before:nil];
    NSString *snapshot = [NSString stringWithFormat:@"{\"text\":\"%@\",\"markedRange\":%@,\"selectedRange\":%@,\"replacementRange\":null,\"attributed\":false}",
        [self jsonEscapedString:preedit], [self jsonRange:localMarked], [self jsonRange:localSelected]];
    self.lastValidPreeditJSON = snapshot;
    return snapshot;
}

- (void)reportPreedit {
    BOOL opened = [self enterInput];
    @try {
        [self handleReportPreedit];
    } @finally {
        [self leaveInput:opened];
    }
}

- (void)handleReportPreedit {
    BOOL changed = NO;
    NSString *snapshot = [self preeditSnapshotJSON:&changed];
    if (!snapshot || !changed) return;
    NSString *json = [NSString stringWithFormat:@"{\"type\":\"compose\",\"text\":\"%@\",\"markedRange\":%@,\"selectedRange\":%@,\"replacementRange\":null,\"attributed\":false}",
        [self jsonEscapedString:self.reportedPreedit], [self jsonRange:self.reportedMarkedRange],
        [self jsonRange:self.reportedSelectedRange]];
    [self report:json.UTF8String];
}

- (void)reportInsert:(NSString *)text {
    BOOL changed = NO;
    NSString *snapshot = [self preeditSnapshotJSON:&changed];
    if (!snapshot) return;
    NSString *json = [NSString stringWithFormat:@"{\"type\":\"insert\",\"text\":\"%@\",\"replacementRange\":null,\"attributed\":false,\"preedit\":%@}",
        [self jsonEscapedString:text], snapshot];
    [self report:json.UTF8String];
}

// Finalizes pending input before a command, focus transition, source change, or close. The input context may call
// unmarkText during a commit; the empty buffer prevents a duplicate action.
- (void)commitPending {
    NSString *pending = [[self.markedTextBuffer.string copy] autorelease];
    if (pending.length == 0) {
        [self logInput:@"commitPending" fields:@"\"committed\":false" before:nil];
        return;
    }
    self.markedTextBuffer = [[[NSMutableAttributedString alloc] initWithString:@""] autorelease];
    self.inputSelection = NSMakeRange(0, 0);
    [self reportInsert:pending];
    [self logInput:@"commitPending" fields:@"\"committed\":true" before:nil];
}

- (void)inputSourceChanged:(NSNotification *)notification {
    sp_observe_delivered("image_region.input_source");
    // The change itself is the event `native.input.source_changed` of the activity observers; this region only reacts to it.
    if (notification.object == self.inputContext) {
        BOOL opened = [self enterInput];
        [self commitPending];
        [self leaveInput:opened];
    }
}

// One query of the input method as the event `native.input.query` at the level debug: the name of the query, its arguments
// and its answer (fields builds `"name":value,…`). The queries arrive while a syllable is composed, so they are not records of
// the state of the document. The gate is asked first: the fields of an event that the policy does not store are not built, and the
// gate counts the query.
- (void)logQuery:(NSString *)call fields:(NSString * (^)(void))fields {
    if (!sp_event_gate(SP_CLASS_INPUT, SP_EVENT_DEBUG)) return;
    NSString *arguments = fields();
    NSString *json = [NSString stringWithFormat:@"{\"call\":\"%@\",%@\"focus\":%@}", call,
        arguments.length ? [arguments stringByAppendingString:@","] : @"", self.hasFocus ? @"true" : @"false"];
    sp_event(SP_CLASS_INPUT, SP_EVENT_DEBUG, "native.input.query", json.UTF8String);
}

- (NSRect)firstRectForCharacterRange:(NSRange)range actualRange:(NSRangePointer)actualRange {
    if (actualRange) *actualRange = NSMakeRange(NSNotFound, 0);

    NSWindow *window = self.window;
    NSRect answer = NSZeroRect;
    if (window) {
        NSRect caretRect = NSMakeRect(self.caretPos.x, self.caretPos.y,
            self.caretWidth, self.caretHeight);
        NSRect converted = [self convertRect:caretRect toView:window.contentView];
        answer = [window convertRectToScreen:converted];
    }
    [self logQuery:@"firstRectForCharacterRange" fields:^NSString * {
        return [NSString stringWithFormat:@"\"range\":%@,\"answer\":{\"x\":%.1f,\"y\":%.1f,\"width\":%.1f,\"height\":%.1f}", [self jsonRange:range],
            answer.origin.x, answer.origin.y, answer.size.width, answer.size.height];
    }];
    return answer;
}

- (NSUInteger)characterIndexForPoint:(NSPoint)point {
    [self logQuery:@"characterIndexForPoint" fields:^NSString * { return [NSString stringWithFormat:@"\"x\":%.1f,\"y\":%.1f,\"answer\":null", point.x, point.y]; }];
    return NSNotFound;
}

- (NSString *)jsonRange:(NSRange)range {
    if (range.location == NSNotFound) return @"null";
    return [NSString stringWithFormat:@"{\"location\":%lu,\"length\":%lu}",
        (unsigned long)range.location, (unsigned long)range.length];
}

- (NSString *)jsonEscapedString:(NSString *)string {
    NSMutableString *escaped = [[[NSMutableString alloc] init] autorelease];
    for (NSUInteger i = 0; i < string.length; i++) {
        unichar ch = [string characterAtIndex:i];
        switch (ch) {
            case '"': [escaped appendString:@"\\\""]; break;
            case '\\': [escaped appendString:@"\\\\"]; break;
            case '\n': [escaped appendString:@"\\n"]; break;
            case '\r': [escaped appendString:@"\\r"]; break;
            case '\t': [escaped appendString:@"\\t"]; break;
            default:
                if (ch < 0x20 || ch >= 0x7F) {
                    [escaped appendFormat:@"\\u%04x", ch];
                } else {
                    [escaped appendFormat:@"%c", (char)ch];
                }
        }
    }
    return escaped;
}

// The state of the marked buffer, its selection, the selected input source and focus. Every input record includes this
// state so callback behavior can be diagnosed from the trace.
- (NSString *)inputState {
    NSString *source = self.inputContext.selectedKeyboardInputSource;
    return [NSString stringWithFormat:
        @"{\"markedText\":\"%@\",\"marked\":%@,\"selected\":%@,\"reportedPreedit\":\"%@\","
        @"\"source\":%@,\"focus\":%@,\"closed\":%@,\"reports\":%lu,\"active\":%@,\"keyWindow\":%@}",
        [self jsonEscapedString:self.markedTextBuffer.string],
        [self hasMarkedText] ? [self jsonRange:self.markedRange] : @"null", [self jsonRange:self.selectedRange],
        [self jsonEscapedString:self.reportedPreedit ?: @""],
        source ? [NSString stringWithFormat:@"\"%@\"", [self jsonEscapedString:source]] : @"null",
        self.hasFocus ? @"true" : @"false", self.closed ? @"true" : @"false", (unsigned long)self.reports,
        NSApp.isActive ? @"true" : @"false", self.window.isKeyWindow ? @"true" : @"false"];
}

// One record of a callback of the input method: its name, its arguments (fields is `"name":value,…` or empty), the
// state of the document before the call (before, or the state now when nil) and the state after it.
- (void)logInput:(NSString *)call fields:(NSString *)fields before:(NSString *)before {
    NSString *after = [self inputState];
    NSString *json = [NSString stringWithFormat:@"{\"call\":\"%@\",%@\"before\":%@,\"after\":%@}",
        call, fields.length ? [fields stringByAppendingString:@","] : @"", before ?: after, after];
    [self emitInput:"native.input.callback" fields:json];
}

- (NSAccessibilityRole)accessibilityRole {
    return NSAccessibilityTextAreaRole;
}

- (id)accessibilityValue {
    return self.accessibilityText ?: @"";
}

@end

static IOSurfaceRef lookupSurface(unsigned int surface_id) {
    return IOSurfaceLookup(surface_id);
}

static CGImageRef copySurfaceImage(IOSurfaceRef surface, char *declaredColorSpaceName, size_t nameCapacity) {
    if (IOSurfaceLock(surface, kIOSurfaceLockReadOnly, NULL) != kIOReturnSuccess) return NULL;
    size_t width = IOSurfaceGetWidth(surface);
    size_t height = IOSurfaceGetHeight(surface);
    size_t bytesPerRow = IOSurfaceGetBytesPerRow(surface);
    void *base = IOSurfaceGetBaseAddress(surface);
    CFDataRef data = base ? CFDataCreate(NULL, base, bytesPerRow * height) : NULL;
    IOSurfaceUnlock(surface, kIOSurfaceLockReadOnly, NULL);
    if (!data) return NULL;
    CGDataProviderRef provider = CGDataProviderCreateWithCFData(data);
    CFPropertyListRef colorProperties = IOSurfaceCopyValue(surface, kIOSurfaceColorSpace);
    CGColorSpaceRef colors = colorProperties ? CGColorSpaceCreateWithPropertyList(colorProperties)
        : CGColorSpaceCreateDeviceRGB();
    if (colorProperties && !colors) {
        CFRelease(colorProperties);
        if (provider) CGDataProviderRelease(provider);
        CFRelease(data);
        return NULL;
    }
    if (colorProperties && declaredColorSpaceName && nameCapacity) {
        CFStringRef name = CGColorSpaceGetName(colors);
        if (!name || !CFStringGetCString(name, declaredColorSpaceName, nameCapacity, kCFStringEncodingUTF8))
            declaredColorSpaceName[0] = '\0';
    }
    if (colorProperties) CFRelease(colorProperties);
    CGImageRef image = provider && colors ? CGImageCreate(width, height, 8, 32, bytesPerRow, colors,
        kCGBitmapByteOrder32Little | kCGImageAlphaPremultipliedFirst,
        provider, NULL, false, kCGRenderingIntentDefault) : NULL;
    if (colors) CGColorSpaceRelease(colors);
    if (provider) CGDataProviderRelease(provider);
    CFRelease(data);
    return image;
}

void *sp_region_create(void *surfaceHandle, const char *name, sp_region_event event, void *context) {
    NSCAssert(NSThread.isMainThread, @"image regions belong to the main thread");
    NSView *surface = (NSView *)surfaceHandle;
    if (!surface || !name || !event || !surface.window) return NULL;

    SPImageRegion *view = [[SPImageRegion alloc] initWithFrame:NSZeroRect];
    view.event = event;
    view.context = context;
    view.webSurface = surface;
    view.hidden = YES;

    NSView *nativePlane = surfaceNativePlane(surface);
    if (!nativePlane) { [view release]; return NULL; }
    spEnsurePressOriginMonitor();
    spOpenRegionCount++;
    NSClipView *clipView = [[SPImageClipView alloc] initWithFrame:NSZeroRect];
    clipView.drawsBackground = NO;
    [clipView addSubview:view];
    [nativePlane addSubview:clipView];
    [clipView release];

    return view;
}

void sp_region_place(void *handle, double left, double top, double right, double bottom, bool visible) {
    NSCAssert(NSThread.isMainThread, @"image regions belong to the main thread");
    SPImageRegion *view = (SPImageRegion *)handle;
    view.insets = NSEdgeInsetsMake(top, left, bottom, right);
    view.wanted = visible;
    view.placed = YES;

    // Registers the surface frame change notification only once. Placement is called on every layout frame, so
    // registering at the call site directly would accumulate observers on the same surface.
    NSView *clipView = view.superview;
    [view observeSurface:clipView && clipView.superview ? clipView.superview : nil];

    [view applyInsets];
}

bool sp_region_raster(void *handle, double *out) {
    NSCAssert(NSThread.isMainThread, @"image regions belong to the main thread");
    SPImageRegion *view = (SPImageRegion *)handle;
    if (!view || !out || !view.placed) return false;
    NSRect backing = [view convertRectToBacking:view.bounds];
    CGFloat scale = surfaceScale(view.webSurface);
    if (NSWidth(backing) < 1 || NSHeight(backing) < 1 || scale <= 0) return false;
    out[0] = round(NSWidth(backing));
    out[1] = round(NSHeight(backing));
    out[2] = scale;
    return true;
}

bool sp_region_surface_placed(void *handle) {
    NSCAssert(NSThread.isMainThread, @"image regions belong to the main thread");
    SPImageRegion *view = (SPImageRegion *)handle;
    // The region is inside the clip view, and the clip view is inside the native plane of the surface.
    NSView *nativePlane = view.superview.superview;
    return nativePlane && NSWidth(nativePlane.bounds) > 0 && NSHeight(nativePlane.bounds) > 0;
}

bool sp_region_present(void *handle, unsigned int token_id, const unsigned char *nonce, double width, double height,
    double scale, uint64_t generation, uint64_t raster, int sequence) {
    NSCAssert(NSThread.isMainThread, @"image regions belong to the main thread");
    SPImageRegion *view = (SPImageRegion *)handle;
    if (!nonce) return false;

    IOSurfaceRef surface = lookupSurface(token_id);
    if (!surface) {
        [view reject:@"notFound"];
        return false;
    }

    // Despite its name, IOSurfaceCopyValue is not CF_RETURNS_RETAINED (see the header).
    // The returned value is not owned by this code, so it is not released. Releasing it would crash when the real
    // owner releases it later.
    CFTypeRef nonceRef = IOSurfaceCopyValue(surface, CFSTR("soksak.frame"));
    BOOL nonceMatches = NO;
    if (nonceRef && CFGetTypeID(nonceRef) == CFDataGetTypeID()) {
        CFDataRef nonceData = (CFDataRef)nonceRef;
        if (CFDataGetLength(nonceData) == 16) {
            nonceMatches = memcmp(nonce, CFDataGetBytePtr(nonceData), 16) == 0;
        }
    }

    if (!nonceMatches) {
        [view reject:@"forbidden"];
        CFRelease(surface);
        return false;
    }

    size_t surfaceWidth = IOSurfaceGetWidth(surface);
    size_t surfaceHeight = IOSurfaceGetHeight(surface);
    if ((int)width != (int)surfaceWidth || (int)height != (int)surfaceHeight) {
        [view reject:@"size"];
        CFRelease(surface);
        return false;
    }

    if (IOSurfaceGetBytesPerElement(surface) != 4 ||
        IOSurfaceGetPixelFormat(surface) != kCVPixelFormatType_32BGRA ||
        IOSurfaceGetBytesPerRow(surface) < surfaceWidth * 4) {
        [view reject:@"unsupported"];
        CFRelease(surface);
        return false;
    }

    // scale must be positive.
    if (scale <= 0) {
        [view reject:@"scale"];
        CFRelease(surface);
        return false;
    }

    double expected[3] = {0};
    if (!sp_region_raster(view, expected) || (int)width != (int)expected[0] ||
        (int)height != (int)expected[1]) {
        [view reject:@"size"];
        CFRelease(surface);
        return false;
    }

    if (fabs(scale - expected[2]) > 0.000001) {
        [view reject:@"scale"];
        CFRelease(surface);
        return false;
    }

    // The image must be drawn at the scale of the window. A different scale distorts the text size, so it is not
    // shown.
    if (!view.window || fabs(scale - view.window.backingScaleFactor) > 0.001) {
        [view reject:@"scale"];
        CFRelease(surface);
        return false;
    }

    char declaredColorSpaceName[256] = {0};
    CGImageRef snapshot = copySurfaceImage(surface, declaredColorSpaceName, sizeof(declaredColorSpaceName));
    CFRelease(surface);
    if (!snapshot) {
        [view reject:@"presentFailed"];
        return false;
    }

    BOOL identityTagging = sp_image_capture_match_identity_session_active() && !view.isHiddenOrHasHiddenAncestor;
    CGImageRef displaySnapshot = snapshot;
    CGImageRef taggedSnapshot = NULL;
    CFDataRef sourceBytes = NULL;
    if (identityTagging) {
        CGDataProviderRef provider = CGImageGetDataProvider(snapshot);
        sourceBytes = provider ? CGDataProviderCopyData(provider) : NULL;
        sp_image_capture_identity identity = { generation, raster, sequence };
        const char *colorSpaceName = declaredColorSpaceName[0] ? declaredColorSpaceName : NULL;
        NSRect localBounds = [view convertRect:view.bounds toView:nil];
        NSRect screenBounds = [view.window convertRectToScreen:localBounds];
        NSScreen *primaryScreen = NSScreen.screens.firstObject;
        if (primaryScreen) {
            // ScreenCaptureKit screenRect and window_facts use top-left coordinates. AppKit screen rectangles use a
            // bottom-left origin, so normalize before retaining bounds for crop mapping.
            screenBounds.origin.y = NSMaxY(primaryScreen.frame) - NSMaxY(screenBounds);
        } else {
            screenBounds = NSZeroRect;
        }
        size_t imageWidth = CGImageGetWidth(snapshot);
        size_t imageHeight = CGImageGetHeight(snapshot);
        size_t imageStride = CGImageGetBytesPerRow(snapshot);
        bool sourceRetained = sourceBytes && sp_image_capture_match_retain(identity,
            CFDataGetBytePtr(sourceBytes), imageWidth, imageHeight, imageStride,
            NSRectToCGRect(screenBounds), scale, colorSpaceName);
        NSString *identityFailure = nil;
        if (!sourceBytes) {
            sp_image_capture_match_drop();
            identityFailure = @"frame identity source raster bytes could not be copied";
        } else if (!sourceRetained) {
            identityFailure = @"frame identity source raster could not be retained within its diagnostic bounds";
        } else if (imageWidth < 192 || imageHeight < 192) {
            identityFailure = @"frame identity source raster is too small for the reserved 192x192 ROI";
        } else if (!CGImageGetColorSpace(snapshot)) {
            identityFailure = @"frame identity source image has no color-space metadata";
        } else {
            CGRect roi = CGRectMake(imageWidth - 192, 0, 192, 192);
            NSString *regionNonce = nil;
            NSString *issuedPayload = nil;
            char *identityError = NULL;
            if (!sp_image_capture_match_identity_region_nonce(nonce, &regionNonce, &identityError)) {
                identityFailure = [NSString stringWithUTF8String:identityError ?: "region nonce derivation failed"];
            }
            free(identityError); identityError = NULL;
            if (!identityFailure && !sp_image_capture_match_identity_issue(nonce, identity,
                &issuedPayload, &identityError)) {
                identityFailure = [NSString stringWithUTF8String:identityError ?: "source identity issuance failed"];
            }
            free(identityError); identityError = NULL;
            NSData *taggedPixels = nil;
            NSString *encodedPayload = nil;
            NSString *encodeError = nil;
            if (!identityFailure && !sp_capture_frame_identity_encode(CFDataGetBytePtr(sourceBytes), imageWidth,
                imageHeight, imageStride, CGImageGetColorSpace(snapshot), roi, regionNonce,
                (SPCaptureFrameIdentity){ generation, raster, sequence }, &taggedSnapshot,
                &taggedPixels, &encodedPayload, &encodeError)) {
                identityFailure = encodeError ?: @"frame identity QR encoding failed";
            }
            if (!identityFailure && ![issuedPayload isEqualToString:encodedPayload])
                identityFailure = @"frame identity encoder returned a payload outside the issued set";
            if (!identityFailure && !sp_image_capture_match_identity_record(nonce, identity, roi,
                taggedPixels.bytes, imageWidth, imageHeight, imageStride, colorSpaceName, &identityError)) {
                identityFailure = [NSString stringWithUTF8String:identityError ?: "tagged source artifact was not accepted"];
            }
            free(identityError);
            if (!identityFailure && !sp_image_capture_match_identity_session_active()) {
                char *sessionError = sp_image_capture_match_identity_session_error_copy();
                identityFailure = sessionError
                    ? [NSString stringWithUTF8String:sessionError]
                    : @"frame identity artifact failed before tagged presentation";
                free(sessionError);
            }
            if (!identityFailure) displaySnapshot = taggedSnapshot;
            else if (issuedPayload) {
                char *evictionError = NULL;
                if (!sp_image_capture_match_identity_evict(nonce, identity, &evictionError))
                    sp_log_error("frame identity", evictionError ?: "failed to remove an unpresented issued payload");
                free(evictionError);
            }
            [regionNonce release]; [issuedPayload release]; [taggedPixels release];
            [encodedPayload release]; [encodeError release];
        }
        if (identityFailure) failFrameIdentitySession(identityFailure);
    }

    // The previous snapshot is replaced only after all validation and copying are done. The layer never points at
    // the IOSurface that the provider rewrites; snapshot remains the unmodified source while displaySnapshot may
    // carry the opt-in diagnostic QR.
    CGImageRef previous = view.snapshot;
    [CATransaction begin];
    [CATransaction setDisableActions:YES];
    [view applyInsetsInTransaction];
    view.imageLayer.contents = (id)displaySnapshot;
    [view updateContentsScale];
    [CATransaction commit];
    view.snapshot = snapshot;
    view.presentedWidth = surfaceWidth;
    view.presentedHeight = surfaceHeight;
    view.presentedScale = scale;
    view.presentedGeneration = generation;
    view.presentedRaster = raster;
    view.presentedSequence = sequence;
    view.presentationError = nil;
    if (!identityTagging && sp_image_capture_match_active() && !view.isHiddenOrHasHiddenAncestor) {
        CGDataProviderRef provider = CGImageGetDataProvider(snapshot);
        CFDataRef snapshotBytes = provider ? CGDataProviderCopyData(provider) : NULL;
        const char *colorSpaceName = declaredColorSpaceName[0] ? declaredColorSpaceName : NULL;
        NSRect localBounds = [view convertRect:view.bounds toView:nil];
        NSRect screenBounds = [view.window convertRectToScreen:localBounds];
        NSScreen *primaryScreen = NSScreen.screens.firstObject;
        if (primaryScreen) {
            // ScreenCaptureKit screenRect and window_facts use top-left coordinates. AppKit screen rectangles use a
            // bottom-left origin, so normalize before retaining bounds for crop mapping.
            screenBounds.origin.y = NSMaxY(primaryScreen.frame) - NSMaxY(screenBounds);
        } else {
            screenBounds = NSZeroRect;
        }
        sp_image_capture_identity identity = { generation, raster, sequence };
        if (snapshotBytes) {
            if (!sp_image_capture_match_retain(identity, CFDataGetBytePtr(snapshotBytes), CGImageGetWidth(snapshot),
                CGImageGetHeight(snapshot), CGImageGetBytesPerRow(snapshot), NSRectToCGRect(screenBounds), scale,
                colorSpaceName)) sp_log_error("image capture match", "source snapshot exceeded or failed the diagnostic retention bound");
            CFRelease(snapshotBytes);
        } else {
            sp_image_capture_match_drop();
            sp_log_error("image capture match", "source snapshot bytes could not be copied for diagnostic retention");
        }
    }
    if (sourceBytes) CFRelease(sourceBytes);
    if (taggedSnapshot) CGImageRelease(taggedSnapshot);
    if (previous) CGImageRelease(previous);

    return true;
}

char *sp_region_last_error(void *handle) {
    NSCAssert(NSThread.isMainThread, @"image regions belong to the main thread");
    SPImageRegion *view = (SPImageRegion *)handle;
    if (!view.presentationError) return NULL;
    const char *text = view.presentationError.UTF8String;
    return strdup(text);
}

void sp_region_focus(void *handle) {
    NSCAssert(NSThread.isMainThread, @"image regions belong to the main thread");
    SPImageRegion *view = (SPImageRegion *)handle;
    NSWindow *window = view.window;
    if (window) [window makeFirstResponder:view];
}

void sp_region_caret(void *handle, double x, double y, double w, double h) {
    NSCAssert(NSThread.isMainThread, @"image regions belong to the main thread");
    SPImageRegion *view = (SPImageRegion *)handle;
    view.caretPos = NSMakePoint(x, y);
    view.caretWidth = w;
    view.caretHeight = h;
}

#ifdef SOKSAK_DIAGNOSTIC
void sp_region_set_input_context(void *handle, void *context) {
    NSCAssert(NSThread.isMainThread, @"image regions belong to the main thread");
    ((SPImageRegion *)handle).givenInputContext = (NSTextInputContext *)context;
}
#endif

void sp_region_text(void *handle, const char *utf8) {
    NSCAssert(NSThread.isMainThread, @"image regions belong to the main thread");
    SPImageRegion *view = (SPImageRegion *)handle;
    if (!utf8) {
        view.accessibilityText = @"";
    } else {
        view.accessibilityText = [NSString stringWithUTF8String:utf8];
    }
}

void sp_region_frame(void *handle, double *out) {
    NSCAssert(NSThread.isMainThread, @"image regions belong to the main thread");
    SPImageRegion *view = (SPImageRegion *)handle;
    NSView *content = view.window.contentView;
    if (!content || !out) return;

    NSRect frame = [view convertRect:view.bounds toView:content];
    out[0] = frame.origin.x;
    out[1] = content.isFlipped ? frame.origin.y : NSHeight(content.bounds) - NSMaxY(frame);
    out[2] = frame.size.width;
    out[3] = frame.size.height;
    out[4] = view.isHiddenOrHasHiddenAncestor ? 0 : 1;
    out[5] = view.hasFocus ? 1 : 0;
}

void sp_region_close(void *handle) {
    NSCAssert(NSThread.isMainThread, @"image regions belong to the main thread");
    SPImageRegion *view = (SPImageRegion *)handle;
    BOOL opened = [view enterInput];
    @try {
        [view commitPending];
        NSWindow *window = view.window;
        if (window.firstResponder == view) [window makeFirstResponder:window.contentView];
        [view.inputContext discardMarkedText];
        view.givenInputContext = nil;
        view.markedTextBuffer = [[[NSMutableAttributedString alloc] initWithString:@""] autorelease];
        view.inputSelection = NSMakeRange(0, 0);
    } @finally {
        [view leaveInput:opened];
    }
    view.closed = YES;
    view.event = NULL;
    NSView *clipView = view.superview;  // The clip view that sp_region_create made.
    [view removeFromSuperview];
    [clipView removeFromSuperview];     // Does not leave an empty clip view on the surface.
    [view release];                     // The +1 that the handle held.
    if (spOpenRegionCount) spOpenRegionCount--;
    if (!spOpenRegionCount && spPressOriginMonitor) {
        [NSEvent removeMonitor:spPressOriginMonitor];
        spPressOriginMonitor = nil;
    }
}

const char *sp_region_facts(void *handle) {
    NSCAssert(NSThread.isMainThread, @"image regions belong to the main thread");
    SPImageRegion *view = (SPImageRegion *)handle;
    NSView *content = view.window.contentView;
    if (!content) return NULL;

    // Read the frame information
    NSRect frame = [view convertRect:view.bounds toView:content];
    double x = frame.origin.x;
    double y = content.isFlipped ? frame.origin.y : NSHeight(content.bounds) - NSMaxY(frame);
    double width = frame.size.width;
    double height = frame.size.height;
    int visible = view.isHiddenOrHasHiddenAncestor ? 0 : 1;
    int focused = view.hasFocus ? 1 : 0;

    // Read the layer information
    CGRect layerBounds = view.imageLayer.bounds;
    double layerWidth = layerBounds.size.width;
    double layerHeight = layerBounds.size.height;
    double contentsScale = view.imageLayer.contentsScale;

    // Read the IOSurface information (the image currently presented)
    int presentedWidth = 0;
    int presentedHeight = 0;
    double presentedScale = 0;
    BOOL hasPresented = NO;

    if (view.snapshot != NULL) {
        presentedWidth = (int)view.presentedWidth;
        presentedHeight = (int)view.presentedHeight;
        presentedScale = view.presentedScale;
        hasPresented = YES;
    }

    // Build the JSON (assembled directly as a string, without cJSON)
    NSMutableString *json = [NSMutableString string];
    [json appendString:@"{"];
    [json appendFormat:@"\"frame\":{\"x\":%.1f,\"y\":%.1f,\"width\":%.1f,\"height\":%.1f},", x, y, width, height];
    [json appendFormat:@"\"visible\":%@,", visible ? @"true" : @"false"];
    // The raster size is decided by the backing size of the placed region and the surface scale (sp_region_raster).
    [json appendFormat:@"\"placed\":%@,\"surfaceScale\":%.2f,", view.placed ? @"true" : @"false", surfaceScale(view.webSurface)];
    [json appendFormat:@"\"focused\":%@,", focused ? @"true" : @"false"];
    [json appendFormat:@"\"layer\":{\"bounds\":{\"x\":0,\"y\":0,\"width\":%.1f,\"height\":%.1f},\"contentsScale\":%.2f},",
          layerWidth, layerHeight, contentsScale];

    if (hasPresented) {
        [json appendFormat:@"\"presented\":{\"width\":%d,\"height\":%d,\"scale\":%.1f,\"generation\":%llu,\"raster\":%llu,\"sequence\":%d},",
              presentedWidth, presentedHeight, presentedScale, (unsigned long long)view.presentedGeneration,
              (unsigned long long)view.presentedRaster, view.presentedSequence];
    }

    [json appendFormat:@"\"error\":%@", view.presentationError
        ? [NSString stringWithFormat:@"\"%@\"", view.presentationError] : @"null"];
    [json appendString:@"}"];

    // Return the result in a copy allocated with malloc() (the caller must free it after use)
    const char *result = [json UTF8String];
    char *output = malloc(strlen(result) + 1);
    if (output) {
        strcpy(output, result);
    }
    return output;
}
