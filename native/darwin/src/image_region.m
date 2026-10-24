// An image region placed on a surface.
//
// The IOSurface is attached directly to the contents of the layer. The layer uses device pixel coordinates, so
// the layer scale is the number of device pixels that one unit covers. The pointer passes through (hitTest → nil).

#import <Carbon/Carbon.h>
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <IOSurface/IOSurface.h>
#import <QuartzCore/QuartzCore.h>
#import "application_log.h"
#import "event_ring.h"
#import "image_region.h"
#import "observe.h"
#import "webview_geometry.h"

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
@interface SPImageRegion : NSTextView
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
@property NSUInteger committedLength;       // The length from the document start already committed by insert.
@property(copy) NSString *unhandledKey;     // The report of a special key given to the input method first. Reported if the input method does not handle it.
@property NSUInteger reports;               // The number of reports sent. Used to check whether the input context answered a key.
@property(copy) NSString *activeCid;        // The correlation identifier of the input being processed; nil outside one.
- (void)applyInsets;
- (void)applyInsetsInTransaction;
- (void)applyInsetsNow;
- (void)report:(const char *)json;
- (void)reject:(NSString *)reason;
- (NSString *)jsonRange:(NSRange)range;
- (NSString *)jsonEscapedString:(NSString *)string;
- (NSString *)inputState;
- (void)performInsertText:(id)string text:(NSString *)text range:(NSRange)range;
- (void)logInput:(NSString *)call fields:(NSString *)fields before:(NSString *)before;
- (BOOL)enterInput;
- (void)leaveInput:(BOOL)opened;
- (NSString *)currentCid;
- (void)emitInput:(const char *)name fields:(NSString *)fields;
- (void)handleKeyDown:(NSEvent *)event;
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

// YES for a Hangul jamo (U+1100–U+11FF, U+3130–U+318F, U+A960–U+A97F, U+D7B0–U+D7FF) or a syllable (U+AC00–U+D7A3).
static BOOL isHangul(unichar ch) {
    return (ch >= 0x1100 && ch <= 0x11FF) || (ch >= 0x3130 && ch <= 0x318F) || (ch >= 0xA960 && ch <= 0xA97F)
        || (ch >= 0xAC00 && ch <= 0xD7A3) || (ch >= 0xD7B0 && ch <= 0xD7FF);
}

// The registry of live image regions (weak references). A closed region disappears when it is deallocated. Every
// region operation is
// on the main thread.
static NSHashTable *spLiveRegions = nil;

// Is the point of a press event inside a live image region of the same window? Returns that region (including the
// region itself, nil if none). Only the point of a mouse press is considered.
static SPImageRegion *spRegionUnderPress(SPImageRegion *view) {
    NSEvent *event = NSApp.currentEvent;
    if (!event || event.window != view.window) return nil;
    switch (event.type) {
        case NSEventTypeLeftMouseDown:
        case NSEventTypeRightMouseDown:
        case NSEventTypeOtherMouseDown:
            break;
        default:
            return nil;
    }
    NSPoint point = [view convertPoint:event.locationInWindow fromView:nil];
    if (NSPointInRect(point, view.bounds)) return view;
    for (SPImageRegion *other in spLiveRegions) {
        if (other == view || !other.window || other.window != view.window || other.closed) continue;
        NSPoint inOther = [other convertPoint:event.locationInWindow fromView:nil];
        if (NSPointInRect(inOther, other.bounds)) return other;
    }
    return nil;
}

@implementation SPImageRegion

- (id)initWithFrame:(NSRect)frame {
    self = [super initWithFrame:frame];
    if (!self) return nil;
    if (!spLiveRegions) spLiveRegions = [[NSHashTable alloc] initWithOptions:NSPointerFunctionsWeakMemory capacity:0];
    [spLiveRegions addObject:self];
    self.drawsBackground = NO;
    self.textColor = NSColor.clearColor;
    self.insertionPointColor = NSColor.clearColor;
    self.textContainerInset = NSZeroSize;
    self.markedTextAttributes = @{
        NSForegroundColorAttributeName: NSColor.clearColor,
        NSBackgroundColorAttributeName: NSColor.clearColor,
        NSUnderlineStyleAttributeName: @0,
    };
    self.selectedTextAttributes = @{
        NSForegroundColorAttributeName: NSColor.clearColor,
        NSBackgroundColorAttributeName: NSColor.clearColor,
    };
    self.richText = NO;
    self.allowsUndo = NO;
    // Only the string that the input method inserted is kept in the document. The automatic editing of AppKit changes
    // input, so it is turned off.
    self.automaticQuoteSubstitutionEnabled = NO;
    self.automaticDashSubstitutionEnabled = NO;
    self.automaticTextReplacementEnabled = NO;
    self.automaticSpellingCorrectionEnabled = NO;
    self.automaticLinkDetectionEnabled = NO;
    self.automaticDataDetectionEnabled = NO;
    self.automaticTextCompletionEnabled = NO;
    self.continuousSpellCheckingEnabled = NO;
    self.grammarCheckingEnabled = NO;
    self.smartInsertDeleteEnabled = NO;
    self.enabledTextCheckingTypes = 0;
    self.usesFindBar = NO;
    self.usesFontPanel = NO;
    self.usesRuler = NO;
    self.importsGraphics = NO;
    self.displaysLinkToolTips = NO;
    self.reportedPreedit = @"";
    sp_observe_notification_selector("image_region.input_source", SP_OBSERVE_RECORD, self, @selector(inputSourceChanged:),
        NSTextInputContextKeyboardSelectionDidChangeNotification, nil);
    self.editable = YES;
    self.selectable = YES;
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
    // Releases the immutable snapshot after the contents of the layer are cleared.
    self.imageLayer.contents = nil;
    if (_snapshot) CGImageRelease(_snapshot);
    [_imageLayer release];
    [_presentationError release];
    [_accessibilityText release];
    [_givenInputContext release];
    [super dealloc];
}

// The keys of the region go to the context that sp_region_set_input_context gave, and otherwise to the context of AppKit.
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

// NSTextView recreates the I-beam cursor tracking area in updateTrackingAreas.
// This view is not a pointer hit target, so that area is removed and the cursor of the page is kept.
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
    return [super validateUserInterfaceItem:item];
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
    if (opens) self.activeCid = [self currentCid];
    return opens && self.activeCid != nil;
}

- (void)leaveInput:(BOOL)opened {
    if (opened) self.activeCid = nil;
}

// Stores one event of the input class with the correlation identifier of the input being processed.
- (void)emitInput:(const char *)name fields:(NSString *)fields {
    NSString *cid = [self currentCid];
    // events: native.input.key_down, native.input.callback
    sp_event_cids(SP_CLASS_INPUT, SP_EVENT_INFO, name, cid.UTF8String ?: "", fields.UTF8String);
}

// Records a report to the page as the event `native.input.report`, and sends it with the correlation identifier of the input
// as the member `cids`. A report that is dropped is recorded as dropped.
- (void)report:(const char *)json {
    NSString *cid = [self currentCid];
    // The disjunction of C is an int, and @(int) writes a number; the catalog declares the member as a boolean.
    NSData *recorded = [NSJSONSerialization dataWithJSONObject:@{ @"report": @(json), @"dropped": @((BOOL)(self.closed || !self.event)) } options:0 error:NULL];
    NSString *fields = [[[NSString alloc] initWithData:recorded encoding:NSUTF8StringEncoding] autorelease];
    sp_event_cids(SP_CLASS_INPUT, SP_EVENT_INFO, "native.input.report", cid.UTF8String ?: "", fields.UTF8String);
    if (self.closed || !self.event) return;
    self.reports++;
    // The report is a JSON object that ends with its closing brace; the identifier is added as its last member.
    NSString *text = @(json);
    NSRange end = [text rangeOfString:@"}" options:NSBackwardsSearch];
    if (cid && end.location != NSNotFound) {
        text = [NSString stringWithFormat:@"%@,\"cids\":[\"%@\"]}", [text substringToIndex:end.location], cid];
    }
    self.event(self.context, text.UTF8String);
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

    // NSTextView owns the lifecycle of the AppKit input method events and the composition state.
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
        if (isSpecialKey && !hasCtrlOrOption && self.textStorage.length > self.committedLength) {
            self.unhandledKey = json;
            [super keyDown:event];
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
    [super keyDown:event];
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

// The input method can rewrite a string it inserted earlier by using a replacement range (for example, the macOS
// Korean input method composes a syllable in steps).
// The input method remembers the document position of the syllable being composed, so while an input source that
// composes is selected, the string the input method inserted
// stays in the document even after it is committed. The input method no longer revises the part before the start of
// the newly inserted string, except that the Korean input method revises the one syllable before it, so that part is
// committed by insert, and the rest is reported as the composition string. The Korean input method composes only
// Hangul, so when the string it inserted
// ends with a non-Hangul character (for example, a space or digit after a syllable), the input method no longer
// revises it and it is committed at once.
// The document is cleared when the composition of the input method ends.
- (void)insertText:(id)string replacementRange:(NSRange)range {
    BOOL opened = [self enterInput];
    [self handleInsertText:string replacementRange:range];
    [self leaveInput:opened];
}

- (void)handleInsertText:(id)string replacementRange:(NSRange)range {
    NSString *text = [string isKindOfClass:NSAttributedString.class]
        ? [(NSAttributedString *)string string]
        : ([string isKindOfClass:NSString.class] ? (NSString *)string : nil);
    NSString *before = [self inputState];
    NSString *fields = [NSString stringWithFormat:@"\"text\":%@,\"attributed\":%@,\"replacementRange\":%@",
        text ? [NSString stringWithFormat:@"\"%@\"", [self jsonEscapedString:text]] : @"null",
        [string isKindOfClass:NSAttributedString.class] ? @"true" : @"false", [self jsonRange:range]];
    if (!text) {
        [self logInput:@"insertText" fields:[fields stringByAppendingString:@",\"dropped\":\"not text\""] before:before];
        return;
    }
    [self performInsertText:string text:text range:range];
    [self logInput:@"insertText" fields:fields before:before];
}

// The processing of an insert of the input method: the replacement of committed text is reported as an error, the text
// enters the document, and what the document holds is committed or reported as preedit.
- (void)performInsertText:(id)string text:(NSString *)text range:(NSRange)range {
    if (range.location != NSNotFound && range.location < self.committedLength) {
        // A string already sent to the PTY cannot be undone. The replacement is reported as an error instead of being
        // discarded.
        NSString *reason = [NSString stringWithFormat:@"input method replaced committed text at %lu (committed %lu)",
            (unsigned long)range.location, (unsigned long)self.committedLength];
        [self failInput:reason where:"input method" text:[NSString stringWithFormat:@"%@: text \"%@\" replacement %@ state %@",
            reason, [self jsonEscapedString:text], [self jsonRange:range], [self inputState]]];
    }
    [super insertText:string replacementRange:range];
    if (self.hasMarkedText) {
        [self reportPreedit];
        return;
    }
    if (![self selectedSourceComposes]) {
        [self commitThrough:self.textStorage.length];
        [self clearDocument];
        return;
    }
    NSUInteger end = self.selectedRange.location;
    NSUInteger start = end >= text.length ? end - text.length : 0;
    // The Korean input method revises the syllable before its newest insert (a final consonant that a vowel follows moves to
    // the next syllable), and it can append the new syllable before it replaces that one, so that syllable stays in the
    // document until the next insert or the end of the composition commits it.
    NSUInteger through = start;
    if ([self selectedSourceComposesOnlyHangul] && through > self.committedLength
        && isHangul([self.textStorage.string characterAtIndex:through - 1])) {
        through -= 1;
    }
    if (through > self.committedLength) [self commitThrough:through];
    if ([self selectedSourceComposesOnlyHangul] && self.textStorage.length > self.committedLength) {
        unichar last = [self.textStorage.string characterAtIndex:self.textStorage.length - 1];
        if (!isHangul(last)) [self commitThrough:self.textStorage.length];
    }
    [self reportPreedit];
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
    if (!text) {
        [self logInput:@"setMarkedText" fields:[fields stringByAppendingString:@",\"dropped\":\"not text\""] before:before];
        return;
    }
    [super setMarkedText:string selectedRange:selectedRange replacementRange:replacementRange];
    [self reportPreedit];
    [self logInput:@"setMarkedText" fields:fields before:before];
}

- (void)unmarkText {
    BOOL opened = [self enterInput];
    NSString *before = [self inputState];
    [super unmarkText];
    [self logInput:@"unmarkText" fields:@"" before:before];
    [self leaveInput:opened];
}

// Checks whether the selected input source is an input method. A keyboard layout does not rewrite the strings it
// inserted.
- (BOOL)selectedSourceComposes {
    NSString *identifier = self.inputContext.selectedKeyboardInputSource;
    if (!identifier) {
        sp_log_error("input method", "the input context has no selected keyboard input source");
        return NO;
    }
    NSArray *sources = (NSArray *)TISCreateInputSourceList(
        (CFDictionaryRef)@{(id)kTISPropertyInputSourceID: identifier}, false);
    BOOL composes = NO;
    if (sources.count > 0) {
        CFStringRef type = TISGetInputSourceProperty((TISInputSourceRef)sources[0], kTISPropertyInputSourceType);
        composes = type && !CFEqual(type, kTISTypeKeyboardLayout);
    }
    [sources release];
    return composes;
}

// YES if the selected input source is the macOS Korean input method. This input method composes only Hangul jamo and
// syllables, and while composing by replacement range
// it sends no callback that the composition ended (a Space after a syllable is insert(" ") after the syllable is
// committed again).
- (BOOL)selectedSourceComposesOnlyHangul {
    return [self.inputContext.selectedKeyboardInputSource hasPrefix:@"com.apple.inputmethod.Korean."];
}

// Reports the part of the document from the commit position to end as committed input. It does not change the
// document.
- (void)commitThrough:(NSUInteger)end {
    if (end <= self.committedLength) return;
    NSString *committed = [self.textStorage.string substringWithRange:
        NSMakeRange(self.committedLength, end - self.committedLength)];
    NSUInteger from = self.committedLength;
    self.committedLength = end;
    [self logInput:@"commitThrough" fields:[NSString stringWithFormat:@"\"from\":%lu,\"to\":%lu,\"committed\":\"%@\"",
        (unsigned long)from, (unsigned long)end, [self jsonEscapedString:committed]] before:nil];
    NSString *json = [NSString stringWithFormat:@"{\"type\":\"insert\",\"text\":\"%@\",\"replacementRange\":null,\"attributed\":false}",
        [self jsonEscapedString:committed]];
    [self report:json.UTF8String];
}

// Reports the string after the commit position that the input method can still revise as the composition string.
// Reports only when it changed.
- (void)reportPreedit {
    NSString *storage = self.textStorage.string;
    NSString *preedit = self.committedLength <= storage.length ? [storage substringFromIndex:self.committedLength] : @"";
    if ([preedit isEqualToString:self.reportedPreedit]) {
        [self logInput:@"reportPreedit" fields:[NSString stringWithFormat:@"\"preedit\":\"%@\",\"changed\":false",
            [self jsonEscapedString:preedit]] before:nil];
        return;
    }
    self.reportedPreedit = preedit;
    [self logInput:@"reportPreedit" fields:[NSString stringWithFormat:@"\"preedit\":\"%@\",\"changed\":true",
        [self jsonEscapedString:preedit]] before:nil];
    NSRange selected = self.selectedRange;
    NSRange local = selected.location != NSNotFound && selected.location >= self.committedLength
        ? NSMakeRange(selected.location - self.committedLength, selected.length) : NSMakeRange(NSNotFound, 0);
    NSString *json = [NSString stringWithFormat:@"{\"type\":\"compose\",\"text\":\"%@\",\"selectedRange\":%@,\"replacementRange\":null,\"attributed\":false}",
        [self jsonEscapedString:preedit], [self jsonRange:local]];
    [self report:json.UTF8String];
}

- (void)clearDocument {
    NSString *before = [self inputState];
    [self.textStorage deleteCharactersInRange:NSMakeRange(0, self.textStorage.length)];
    self.committedLength = 0;
    [self reportPreedit];
    [self logInput:@"clearDocument" fields:@"" before:before];
}

// Commits the remaining string and ends the composition of the input method before a command, a special key, focus
// release, an input source switch, or close.
// While the input method holds marked text, the input method decides the commit.
- (void)commitPending {
    if (self.hasMarkedText || self.textStorage.length == 0) {
        [self logInput:@"commitPending" fields:@"\"skipped\":true" before:nil];
        return;
    }
    [self logInput:@"commitPending" fields:@"\"skipped\":false" before:nil];
    [self commitThrough:self.textStorage.length];
    [self.inputContext discardMarkedText];
    [self clearDocument];
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

- (NSRange)markedRange {
    NSRange range = [super markedRange];
    [self logQuery:@"markedRange" fields:^NSString * { return [NSString stringWithFormat:@"\"answer\":%@", [self jsonRange:range]]; }];
    return range;
}

- (NSRange)selectedRange {
    NSRange range = [super selectedRange];
    [self logQuery:@"selectedRange" fields:^NSString * { return [NSString stringWithFormat:@"\"answer\":%@", [self jsonRange:range]]; }];
    return range;
}

- (BOOL)hasMarkedText {
    BOOL marked = [super hasMarkedText];
    [self logQuery:@"hasMarkedText" fields:^NSString * { return [NSString stringWithFormat:@"\"answer\":%@", marked ? @"true" : @"false"]; }];
    return marked;
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

// The state of the input document as JSON: the text, the committed length, the marked and selected ranges, the preedit
// that was reported last, the selected input source and the focus. Every record of the input holds it, so a defect of the
// input is located from the files alone.
- (NSString *)inputState {
    NSString *source = self.inputContext.selectedKeyboardInputSource;
    return [NSString stringWithFormat:
        @"{\"document\":\"%@\",\"committed\":%lu,\"marked\":%@,\"selected\":%@,\"reportedPreedit\":\"%@\","
        @"\"source\":%@,\"focus\":%@,\"closed\":%@,\"reports\":%lu,\"active\":%@,\"keyWindow\":%@}",
        [self jsonEscapedString:self.textStorage.string], (unsigned long)self.committedLength,
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

static CGImageRef copySurfaceImage(IOSurfaceRef surface) {
    if (IOSurfaceLock(surface, kIOSurfaceLockReadOnly, NULL) != kIOReturnSuccess) return NULL;
    size_t width = IOSurfaceGetWidth(surface);
    size_t height = IOSurfaceGetHeight(surface);
    size_t bytesPerRow = IOSurfaceGetBytesPerRow(surface);
    void *base = IOSurfaceGetBaseAddress(surface);
    CFDataRef data = base ? CFDataCreate(NULL, base, bytesPerRow * height) : NULL;
    IOSurfaceUnlock(surface, kIOSurfaceLockReadOnly, NULL);
    if (!data) return NULL;
    CGDataProviderRef provider = CGDataProviderCreateWithCFData(data);
    CGColorSpaceRef colors = CGColorSpaceCreateDeviceRGB();
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

    CGImageRef snapshot = copySurfaceImage(surface);
    CFRelease(surface);
    if (!snapshot) {
        [view reject:@"presentFailed"];
        return false;
    }

    // The previous snapshot is replaced only after all validation and copying are done. The layer does not point
    // directly at the
    // IOSurface that the provider rewrites.
    CGImageRef previous = view.snapshot;
    [CATransaction begin];
    [CATransaction setDisableActions:YES];
    [view applyInsetsInTransaction];
    view.imageLayer.contents = (id)snapshot;
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

void sp_region_set_input_context(void *handle, void *context) {
    NSCAssert(NSThread.isMainThread, @"image regions belong to the main thread");
    ((SPImageRegion *)handle).givenInputContext = (NSTextInputContext *)context;
}

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
    [view commitPending];
    view.closed = YES;
    view.event = NULL;
    NSView *clipView = view.superview;  // The clip view that sp_region_create made.
    [view removeFromSuperview];
    [clipView removeFromSuperview];     // Does not leave an empty clip view on the surface.
    [view release];                     // The +1 that the handle held.
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
