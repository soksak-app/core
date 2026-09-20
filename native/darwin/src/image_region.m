// 표면 위에 놓인 그림 영역.
//
// IOSurface 는 계층의 contents 에 직접 붙여진다. 레이어는 장치 픽셀 좌표를 쓰므로
// 레이어 배율은 한 단위가 덮는 장치 픽셀 수다. 포인터는 통과한다(hitTest → nil).

#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <IOSurface/IOSurface.h>
#import <QuartzCore/QuartzCore.h>
#import "image_region.h"
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

// 그림 영역 구현.
@interface SPImageRegion : NSView <NSTextInputClient>
@property sp_region_event event;
@property void *context;
@property(retain) CALayer *imageLayer;
@property(assign) CGImageRef snapshot;   // 호스트가 복사해 소유하는 불변 표시 스냅샷.
@property size_t presentedWidth;
@property size_t presentedHeight;
@property double presentedScale;
@property(assign) WKWebView *webSurface;  // 영역이 놓인 표면 웹뷰. 우리가 소유하지 않음.
@property NSEdgeInsets insets;
@property NSPoint caretPos;
@property double caretWidth;
@property double caretHeight;
@property(copy) NSString *accessibilityText;
@property BOOL wanted;
@property BOOL placed;
@property BOOL closed;
@property BOOL hasFocus;
@property(copy) NSString *markedText;
@property(nonatomic) NSRange selectedRange;
@property(nonatomic) NSRange markedRange;

- (void)applyInsets;
- (void)applyInsetsInTransaction;
- (void)applyInsetsNow;
- (void)report:(const char *)json;
- (void)surfaceScaleChanged;
@end

@implementation SPImageRegion

- (id)initWithFrame:(NSRect)frame {
    self = [super initWithFrame:frame];
    if (!self) return nil;
    self.wantsLayer = YES;
    self.layerUsesCoreImageFilters = YES;
    self.imageLayer = [[[CALayer alloc] init] autorelease];
    [self.layer addSublayer:self.imageLayer];
    self.imageLayer.contentsScale = 1;
    // 기하가 바뀌어 정확한 대체 래스터가 도착할 때까지 이전 불변 래스터가
    // 네이티브 영역 전체를 덮어야 한다. 비율 채우기는 이전 화면을 자르며
    // DOM 평면을 노출하지 않는다.
    self.imageLayer.contentsGravity = kCAGravityResizeAspectFill;
    self.imageLayer.magnificationFilter = kCAFilterNearest;
    self.markedText = @"";
    self.selectedRange = NSMakeRange(NSNotFound, 0);
    self.markedRange = NSMakeRange(NSNotFound, 0);
    self.snapshot = NULL;
    return self;
}

- (void)dealloc {
    // 레이어의 contents 를 정리한 후 불변 스냅샷을 해제한다.
    self.imageLayer.contents = nil;
    if (_snapshot) CGImageRelease(_snapshot);
    [_imageLayer release];
    [_accessibilityText release];
    [_markedText release];
    [super dealloc];
}

- (BOOL)acceptsFirstResponder {
    return YES;
}

- (NSView *)hitTest:(NSPoint)point {
    return nil;
}

- (void)applyInsetsInTransaction {
    NSView *clipView = self.superview;
    if (!clipView) return;
    WKWebView *surface = self.webSurface;
    if (!surface) return;

    NSView *nativePlane = clipView.superview;
    if (!nativePlane) return;
    NSRect surfaceBounds = nativePlane.bounds;
    CGFloat zoom = surface.pageZoom;
    NSEdgeInsets insets = self.insets;

    // 클립 뷰 크기: 표면 프레임에서 인셋 뺀 것 (CSS 픽셀 단위 인셋에 zoom 적용)
    CGFloat width = NSWidth(surfaceBounds) - (insets.left + insets.right) * zoom;
    CGFloat height = NSHeight(surfaceBounds) - (insets.top + insets.bottom) * zoom;

    // 클립 뷰 위치: 표면의 superview 좌표계에서 계산
    CGFloat clipX = NSMinX(surfaceBounds) + insets.left * zoom;
    CGFloat clipTop = insets.top * zoom;
    CGFloat clipY = nativePlane.isFlipped ? NSMinY(surfaceBounds) + clipTop : NSMaxY(surfaceBounds) - clipTop - height;

    NSRect clipFrame = NSMakeRect(clipX, clipY, MAX(width, 0), MAX(height, 0));
    clipView.frame = clipFrame;

    // 영역 뷰는 클립 뷰 안에서 bounds를 차지한다. 기하 변경은 드래그 중 매 프레임
    // 발생하므로 Core Animation이 이전 위치와 새 위치를 보간해서는 안 된다.
    self.frame = NSMakeRect(0, 0, MAX(width, 0), MAX(height, 0));
    self.imageLayer.frame = self.bounds;
    [self updateContentsScale];

    // 표면의 숨김은 부모 뷰 계층이 처리한다. 자식 영역까지 그 상태를 자체 hidden
    // 플래그에 저장하면, 표면을 다시 표시해도 applyInsets가 다시 호출되지 않는
    // 전환에서 영역이 영구히 숨겨진다.
    self.hidden = !self.wanted || width < 1 || height < 1;
}

- (void)applyInsetsNow {
    [CATransaction begin];
    [CATransaction setDisableActions:YES];
    [self applyInsetsInTransaction];
    [CATransaction commit];
}

// Keep the last complete image geometry visible while a new raster is being
// produced. The requested insets are measured by sp_region_raster, and this
// geometry is committed only after sp_region_present validates that raster.
- (void)applyInsets {
    if (self.snapshot) return;
    [self applyInsetsNow];
}


- (void)surfaceScaleChanged {
    if (self.placed) [self applyInsets];
}

- (void)viewWillMoveToSuperview:(NSView *)superview {
    NSView *clipView = self.superview;
    if (clipView && clipView.superview) {
        [NSNotificationCenter.defaultCenter removeObserver:self name:NSViewFrameDidChangeNotification object:clipView.superview];
    }
    [super viewWillMoveToSuperview:superview];
}

- (void)viewDidMoveToSuperview {
    [super viewDidMoveToSuperview];
    NSView *clipView = self.superview;
    if (!clipView || !clipView.superview) return;
    NSView *surface = clipView.superview;
    surface.postsFrameChangedNotifications = YES;
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(surfaceResized:)
        name:NSViewFrameDidChangeNotification object:surface];
}

// 레이어 한 단위가 덮는 장치 픽셀 수. 표면을 담은 뷰 계층은 bounds 배율을 따로 가질 수 있으므로
// (Wails 의 웹뷰 컨테이너는 한 단위가 0.5pt 다) 점 단위를 가정하지 않고 AppKit 에 묻는다.
// 이 값을 contentsScale 로 두면 그림의 한 픽셀이 장치 한 픽셀로 표시된다.
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
    if (self.placed) [self applyInsets];
}

- (void)report:(const char *)json {
    if (self.closed || !self.event) return;
    self.event(self.context, json);
}

- (BOOL)becomeFirstResponder {
    BOOL result = [super becomeFirstResponder];
    if (result && !self.hasFocus) {
        self.hasFocus = YES;
        [self report:"{\"type\":\"focus\",\"focused\":true}"];
    }
    return result;
}

- (BOOL)resignFirstResponder {
    BOOL result = [super resignFirstResponder];
    if (result && self.hasFocus) {
        self.hasFocus = NO;
        [self report:"{\"type\":\"focus\",\"focused\":false}"];
    }
    return result;
}

- (void)keyDown:(NSEvent *)event {
    // Command 조합은 보고하지 않고 메뉴에 넘긴다.
    if (event.modifierFlags & NSEventModifierFlagCommand) {
        [super keyDown:event];
        return;
    }

    // 조합 중이면 입력기로 넘긴다.
    if ([self hasMarkedText]) {
        [self interpretKeyEvents:@[ event ]];
        return;
    }

    // 특수 키 또는 Ctrl/Option 조합인지 확인한다.
    NSString *characters = event.charactersIgnoringModifiers;
    if (characters.length == 0) {
        [self interpretKeyEvents:@[ event ]];
        return;
    }

    unichar ch = [characters characterAtIndex:0];
    NSEventModifierFlags flags = event.modifierFlags;
    BOOL hasCtrlOrOption = (flags & NSEventModifierFlagControl) || (flags & NSEventModifierFlagOption);

    // 특수 키 판정 - function keys와 특정 문자 코드
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
    } else if (ch == NSDeleteFunctionKey) {  // 앞으로 지우기
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
    // 특정 문자들
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

    // 특수 키이거나 Ctrl/Option 조합인 경우 key 이벤트를 보고한다.
    if (isSpecialKey || hasCtrlOrOption) {
        BOOL shift = (flags & NSEventModifierFlagShift) != 0;
        BOOL alt = (flags & NSEventModifierFlagOption) != 0;
        BOOL ctrl = (flags & NSEventModifierFlagControl) != 0;

        // BackTab은 shift:true로 보고한다.
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
            // Ctrl/Option 조합 문자
            NSString *textChar = [[NSString stringWithCharacters:&ch length:1] stringByReplacingOccurrencesOfString:@"\\" withString:@"\\\\"];
            textChar = [textChar stringByReplacingOccurrencesOfString:@"\"" withString:@"\\\""];
            json = [NSString stringWithFormat:@"{\"type\":\"key\",\"key\":\"Char\",\"text\":\"%@\",\"shift\":%s,\"alt\":%s,\"ctrl\":%s}",
                textChar,
                shift ? "true" : "false",
                alt ? "true" : "false",
                ctrl ? "true" : "false"];
        }
        [self report:json.UTF8String];
        return;
    }

    // 일반 문자는 입력기로 넘긴다.
    [self interpretKeyEvents:@[ event ]];
}

- (void)doCommandBySelector:(SEL)selector {
    // 아무것도 하지 않는다. keyDown: 에서 특수 키를 이미 처리했으므로
    // 이 경로로 오는 키가 없다.
}

- (void)insertText:(id)string replacementRange:(NSRange)range {
    if (![string isKindOfClass:NSString.class]) return;
    NSString *text = (NSString *)string;

    self.markedText = @"";
    self.markedRange = NSMakeRange(NSNotFound, 0);

    NSString *json = [NSString stringWithFormat:@"{\"type\":\"insert\",\"text\":\"%@\"}",
        [self jsonEscapedString:text]];
    [self report:json.UTF8String];
}

- (void)setMarkedText:(id)string selectedRange:(NSRange)selectedRange replacementRange:(NSRange)replacementRange {
    if (![string isKindOfClass:NSString.class]) return;
    NSString *text = (NSString *)string;

    if (text.length == 0) {
        self.markedText = @"";
        self.markedRange = NSMakeRange(NSNotFound, 0);
        [self report:"{\"type\":\"compose\",\"text\":\"\"}"];
    } else {
        self.markedText = text;
        self.markedRange = NSMakeRange(0, text.length);
        self.selectedRange = selectedRange;
        NSString *json = [NSString stringWithFormat:@"{\"type\":\"compose\",\"text\":\"%@\",\"caret\":%lu}",
            [self jsonEscapedString:text], (unsigned long)selectedRange.location];
        [self report:json.UTF8String];
    }
}

- (void)unmarkText {
    if (self.markedText.length > 0) {
        self.markedText = @"";
        self.markedRange = NSMakeRange(NSNotFound, 0);
        [self report:"{\"type\":\"compose\",\"text\":\"\"}"];
    }
}

- (BOOL)hasMarkedText {
    return self.markedText.length > 0;
}

- (NSAttributedString *)attributedSubstringForProposedRange:(NSRange)range actualRange:(NSRangePointer)actualRange {
    if (actualRange) *actualRange = NSMakeRange(NSNotFound, 0);
    return nil;
}

- (NSRect)firstRectForCharacterRange:(NSRange)range actualRange:(NSRangePointer)actualRange {
    if (actualRange) *actualRange = NSMakeRange(NSNotFound, 0);

    NSWindow *window = self.window;
    if (!window) return NSZeroRect;

    CGFloat zoom = self.webSurface.pageZoom > 0 ? self.webSurface.pageZoom : 1;
    NSRect caretRect = NSMakeRect(self.caretPos.x * zoom, self.caretPos.y * zoom,
        self.caretWidth * zoom, self.caretHeight * zoom);
    NSRect converted = [self convertRect:caretRect toView:window.contentView];
    return [window convertRectToScreen:converted];
}

- (NSUInteger)characterIndexForPoint:(NSPoint)point {
    return NSNotFound;
}

- (NSArray<NSString *> *)validAttributesForMarkedText {
    return @[];
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
    WKWebView *surface = (WKWebView *)surfaceHandle;
    if (!surface || !name || !event || !surface.window) return NULL;

    SPImageRegion *view = [[SPImageRegion alloc] initWithFrame:NSZeroRect];
    view.event = event;
    view.context = context;
    view.webSurface = surface;
    view.hidden = YES;

    NSView *nativePlane = (NSView *)webviewSurfaceNativePlane(surface);
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

    // 표면 프레임 변경 알림을 등록한다. viewDidMoveToSuperview에서는 표면이 설정되지 않았을 수 있으므로
    // 여기서 명시적으로 등록한다.
    NSView *clipView = view.superview;
    if (clipView && clipView.superview) {
        NSView *surface = clipView.superview;
        surface.postsFrameChangedNotifications = YES;
        [NSNotificationCenter.defaultCenter addObserver:view selector:@selector(surfaceResized:)
            name:NSViewFrameDidChangeNotification object:surface];
    }

    [view applyInsets];
}

bool sp_region_raster(void *handle, double *out) {
    NSCAssert(NSThread.isMainThread, @"image regions belong to the main thread");
    SPImageRegion *view = (SPImageRegion *)handle;
    if (!view || !out || !view.placed) return false;
    NSClipView *clipView = (NSClipView *)view.superview;
    NSRect oldClipFrame = clipView.frame;
    NSRect oldFrame = view.frame;
    NSRect oldLayerFrame = view.imageLayer.frame;
    CGFloat oldContentsScale = view.imageLayer.contentsScale;
    BOOL oldHidden = view.hidden;
    if (view.snapshot) [view applyInsetsNow];
    NSRect backing = [view convertRectToBacking:view.bounds];
    if (view.snapshot) {
        [CATransaction begin];
        [CATransaction setDisableActions:YES];
        clipView.frame = oldClipFrame;
        view.frame = oldFrame;
        view.imageLayer.frame = oldLayerFrame;
        view.imageLayer.contentsScale = oldContentsScale;
        view.hidden = oldHidden;
        [CATransaction commit];
    }
    CGFloat scale = view.webSurface.pageZoom;
    if (NSWidth(backing) < 1 || NSHeight(backing) < 1 || scale <= 0) return false;
    out[0] = round(NSWidth(backing));
    out[1] = round(NSHeight(backing));
    out[2] = scale;
    return true;
}

bool sp_region_present(void *handle, unsigned int token_id, const unsigned char *nonce, double width, double height, double scale) {
    NSCAssert(NSThread.isMainThread, @"image regions belong to the main thread");
    SPImageRegion *view = (SPImageRegion *)handle;
    if (!nonce) return false;

    IOSurfaceRef surface = lookupSurface(token_id);
    if (!surface) {
        [view report:"{\"type\":\"error\",\"reason\":\"notFound\"}"];
        return false;
    }

    // IOSurfaceCopyValue 는 이름과 달리 CF_RETURNS_RETAINED 가 아니다(헤더를 보라).
    // 돌려받은 값은 우리 것이 아니므로 해제하지 않는다. 해제하면 나중에 진짜 주인이 놓을 때 죽는다.
    CFTypeRef nonceRef = IOSurfaceCopyValue(surface, CFSTR("soksak.frame"));
    BOOL nonceMatches = NO;
    if (nonceRef && CFGetTypeID(nonceRef) == CFDataGetTypeID()) {
        CFDataRef nonceData = (CFDataRef)nonceRef;
        if (CFDataGetLength(nonceData) == 16) {
            nonceMatches = memcmp(nonce, CFDataGetBytePtr(nonceData), 16) == 0;
        }
    }

    if (!nonceMatches) {
        [view report:"{\"type\":\"error\",\"reason\":\"forbidden\"}"];
        CFRelease(surface);
        return false;
    }

    size_t surfaceWidth = IOSurfaceGetWidth(surface);
    size_t surfaceHeight = IOSurfaceGetHeight(surface);
    if ((int)width != (int)surfaceWidth || (int)height != (int)surfaceHeight) {
        [view report:"{\"type\":\"error\",\"reason\":\"size\"}"];
        CFRelease(surface);
        return false;
    }

    if (IOSurfaceGetBytesPerElement(surface) != 4 ||
        IOSurfaceGetPixelFormat(surface) != kCVPixelFormatType_32BGRA ||
        IOSurfaceGetBytesPerRow(surface) < surfaceWidth * 4) {
        [view report:"{\"type\":\"error\",\"reason\":\"unsupported\"}"];
        CFRelease(surface);
        return false;
    }

    // scale 은 양수여야 한다.
    if (scale <= 0) {
        [view report:"{\"type\":\"error\",\"reason\":\"scale\"}"];
        CFRelease(surface);
        return false;
    }

    double expected[3] = {0};
    if (!sp_region_raster(view, expected) || (int)width != (int)expected[0] ||
        (int)height != (int)expected[1]) {
        [view report:"{\"type\":\"error\",\"reason\":\"size\"}"];
        CFRelease(surface);
        return false;
    }

    if (fabs(scale - expected[2]) > 0.000001) {
        [view report:"{\"type\":\"error\",\"reason\":\"scale\"}"];
        CFRelease(surface);
        return false;
    }

    // 그림은 창의 배율로 그려져야 한다. 다르면 글자 크기가 틀어지므로 표시하지 않는다.
    if (!view.window || fabs(scale - view.window.backingScaleFactor) > 0.001) {
        [view report:"{\"type\":\"error\",\"reason\":\"scale\"}"];
        CFRelease(surface);
        return false;
    }

    CGImageRef snapshot = copySurfaceImage(surface);
    CFRelease(surface);
    if (!snapshot) {
        [view report:"{\"type\":\"error\",\"reason\":\"presentFailed\"}"];
        return false;
    }

    // The new raster and its geometry become visible in one native commit.
    // 모든 검증과 복사가 끝난 뒤에만 이전 스냅샷을 교체한다. 레이어는 공급자가 다시 쓸
    // IOSurface를 직접 가리키지 않는다.
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
    if (previous) CGImageRelease(previous);

    return true;
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
    view.closed = YES;
    view.event = NULL;
    NSView *clipView = view.superview;  // sp_region_create 가 만든 클립 뷰.
    [view removeFromSuperview];
    [clipView removeFromSuperview];     // 빈 클립 뷰를 표면에 남기지 않는다.
    [view release];                     // 손잡이가 들고 있던 +1.
}

const char *sp_region_facts(void *handle) {
    NSCAssert(NSThread.isMainThread, @"image regions belong to the main thread");
    SPImageRegion *view = (SPImageRegion *)handle;
    NSView *content = view.window.contentView;
    if (!content) return NULL;

    // 프레임 정보 읽기
    NSRect frame = [view convertRect:view.bounds toView:content];
    double x = frame.origin.x;
    double y = content.isFlipped ? frame.origin.y : NSHeight(content.bounds) - NSMaxY(frame);
    double width = frame.size.width;
    double height = frame.size.height;
    int visible = view.isHiddenOrHasHiddenAncestor ? 0 : 1;
    int focused = view.hasFocus ? 1 : 0;

    // 레이어 정보 읽기
    CGRect layerBounds = view.imageLayer.bounds;
    double layerWidth = layerBounds.size.width;
    double layerHeight = layerBounds.size.height;
    double contentsScale = view.imageLayer.contentsScale;

    // IOSurface 정보 읽기 (현재 표시 중인 이미지)
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

    // JSON 생성 (cJSON 없이 직접 문자열 구성)
    NSMutableString *json = [NSMutableString string];
    [json appendString:@"{"];
    [json appendFormat:@"\"frame\":{\"x\":%.1f,\"y\":%.1f,\"width\":%.1f,\"height\":%.1f},", x, y, width, height];
    [json appendFormat:@"\"visible\":%@,", visible ? @"true" : @"false"];
    [json appendFormat:@"\"focused\":%@,", focused ? @"true" : @"false"];
    [json appendFormat:@"\"layer\":{\"bounds\":{\"x\":0,\"y\":0,\"width\":%.1f,\"height\":%.1f},\"contentsScale\":%.2f},",
          layerWidth, layerHeight, contentsScale];

    if (hasPresented) {
        [json appendFormat:@"\"presented\":{\"width\":%d,\"height\":%d,\"scale\":%.1f},",
              presentedWidth, presentedHeight, presentedScale];
    }

    [json appendString:@"\"error\":null"];
    [json appendString:@"}"];

    // 정적 버퍼에 결과를 반환 (호출자가 사용 후 해제해야 함)
    const char *result = [json UTF8String];
    // 메모리를 malloc으로 할당하여 반환
    char *output = malloc(strlen(result) + 1);
    if (output) {
        strcpy(output, result);
    }
    return output;
}
