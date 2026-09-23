// 표면 위에 놓인 그림 영역.
//
// IOSurface 는 계층의 contents 에 직접 붙여진다. 레이어는 장치 픽셀 좌표를 쓰므로
// 레이어 배율은 한 단위가 덮는 장치 픽셀 수다. 포인터는 통과한다(hitTest → nil).

#import <Carbon/Carbon.h>
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
@interface SPImageRegion : NSTextView
@property sp_region_event event;
@property void *context;
@property(retain) CALayer *imageLayer;
@property(assign) CGImageRef snapshot;   // 호스트가 복사해 소유하는 불변 표시 스냅샷.
@property size_t presentedWidth;
@property size_t presentedHeight;
@property double presentedScale;
@property(copy) NSString *presentationError;
@property(assign) NSView *webSurface;  // 논리 표면 뷰. 우리가 소유하지 않음.
@property NSEdgeInsets insets;
@property NSPoint caretPos;
@property double caretWidth;
@property double caretHeight;
@property(copy) NSString *accessibilityText;
@property BOOL wanted;
@property BOOL placed;
@property BOOL closed;
@property BOOL hasFocus;
@property(copy) NSString *reportedPreedit;  // 마지막으로 보고한 조합 문자열.
@property NSUInteger committedLength;       // 문서 앞에서 이미 insert 로 확정한 길이.
- (void)applyInsets;
- (void)applyInsetsInTransaction;
- (void)applyInsetsNow;
- (void)report:(const char *)json;
- (void)reject:(NSString *)reason;
- (NSString *)jsonRange:(NSRange)range;
- (void)surfaceScaleChanged;
@end

// Logical-surface geometry is owned by the surface host. Weak imports keep
// legacy WKWebView test surfaces usable while that owner is linked in.
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

// 한글 자모(U+1100–U+11FF, U+3130–U+318F, U+A960–U+A97F, U+D7B0–U+D7FF)나 음절(U+AC00–U+D7A3)이 있으면 YES.
static BOOL containsHangul(NSString *text) {
    for (NSUInteger i = 0; i < text.length; i++) {
        unichar ch = [text characterAtIndex:i];
        if ((ch >= 0x1100 && ch <= 0x11FF) || (ch >= 0x3130 && ch <= 0x318F) || (ch >= 0xA960 && ch <= 0xA97F)
            || (ch >= 0xAC00 && ch <= 0xD7A3) || (ch >= 0xD7B0 && ch <= 0xD7FF)) return YES;
    }
    return NO;
}

@implementation SPImageRegion

- (id)initWithFrame:(NSRect)frame {
    self = [super initWithFrame:frame];
    if (!self) return nil;
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
    // 입력기가 넣은 문자열만 문서에 둔다. AppKit 의 자동 편집은 터미널 입력을 바꾸므로 끈다.
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
    self.reportedPreedit = @"";
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(inputSourceChanged:)
        name:NSTextInputContextKeyboardSelectionDidChangeNotification object:nil];
    self.editable = YES;
    self.selectable = YES;
    self.wantsLayer = YES;
    self.layerUsesCoreImageFilters = YES;
    self.imageLayer = [[[CALayer alloc] init] autorelease];
    [self.layer addSublayer:self.imageLayer];
    self.imageLayer.contentsScale = 1;
    // 래스터 픽셀은 늘리거나 줄이지 않는다. 새 기하와 일치하는 래스터가 준비된 뒤
    // 바깥 표면 트랜잭션이 DOM과 함께 화면에 반영한다.
    self.imageLayer.contentsGravity = kCAGravityTopLeft;
    self.imageLayer.magnificationFilter = kCAFilterNearest;
    self.snapshot = NULL;
    return self;
}

- (void)dealloc {
    [NSNotificationCenter.defaultCenter removeObserver:self];
    [_reportedPreedit release];
    // 레이어의 contents 를 정리한 후 불변 스냅샷을 해제한다.
    self.imageLayer.contents = nil;
    if (_snapshot) CGImageRelease(_snapshot);
    [_imageLayer release];
    [_presentationError release];
    [_accessibilityText release];
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

    // Surface geometry is expressed in AppKit points. Backing scale belongs
    // to the image layer and raster dimensions, not to region frame or inset
    // coordinates.
    CGFloat width = NSWidth(surfaceBounds) - (insets.left + insets.right);
    CGFloat height = NSHeight(surfaceBounds) - (insets.top + insets.bottom);

    // 클립 뷰 위치: 표면의 superview 좌표계에서 계산
    CGFloat clipX = NSMinX(surfaceBounds) + insets.left;
    CGFloat clipTop = insets.top;
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

// 준비 기하를 적용한다. 이 변경의 표시는 바깥 표면 트랜잭션이 소유한다.
- (void)applyInsets {
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

- (void)reject:(NSString *)reason {
    self.presentationError = reason;
    NSData *data = [NSJSONSerialization dataWithJSONObject:@{ @"type": @"error", @"reason": reason } options:0 error:NULL];
    NSString *json = [[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] autorelease];
    [self report:json.UTF8String];
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
    [self commitPending];
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

    // NSTextView 가 AppKit 입력기 이벤트와 조합 상태의 수명주기를 소유한다.
    if ([self hasMarkedText]) {
        [super keyDown:event];
        return;
    }

    // 특수 키 또는 Ctrl/Option 조합인지 확인한다.
    NSString *characters = event.charactersIgnoringModifiers;
    if (characters.length == 0) {
        [super keyDown:event];
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
            NSString *keyCharacter = (flags & NSEventModifierFlagControl)
                ? controlCharacterForANSIKeyCode(event.keyCode)
                : nil;
            if ((flags & NSEventModifierFlagControl) && keyCharacter.length == 0) {
                NSString *reason = [NSString stringWithFormat:
                    @"unsupported Ctrl character: native keyCode=%hu, character=U+%04X",
                    event.keyCode, ch];
                NSString *escapedReason = [reason stringByReplacingOccurrencesOfString:@"\\" withString:@"\\\\"];
                escapedReason = [escapedReason stringByReplacingOccurrencesOfString:@"\"" withString:@"\\\""];
                NSString *errorJSON = [NSString stringWithFormat:@"{\"type\":\"error\",\"reason\":\"%@\"}", escapedReason];
                [self report:errorJSON.UTF8String];
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
        [self commitPending];
        [self report:json.UTF8String];
        return;
    }

    // 일반 문자는 입력기로 넘긴다.
    [super keyDown:event];
}

- (void)doCommandBySelector:(SEL)selector {
    // NSTextInputClient commands are part of the input stream. Dropping them
    // loses IME actions such as cancel, delete, and accept.
    [self commitPending];
    NSString *name = NSStringFromSelector(selector);
    NSString *json = [NSString stringWithFormat:@"{\"type\":\"command\",\"selector\":\"%@\"}",
        [self jsonEscapedString:name]];
    [self report:json.UTF8String];
}

// 입력기는 이전에 넣은 문자열을 교체 범위로 고쳐 쓸 수 있다(예: macOS 한국어 입력기의 ㅎ → 하 → 한).
// 입력기는 조합 중인 음절의 문서 위치를 기억하므로, 조합하는 입력 소스가 선택된 동안 입력기가 넣은
// 문자열은 확정한 뒤에도 문서에 남긴다. 새로 넣은 문자열의 시작보다 앞은 입력기가 더 고치지 않으므로
// insert 로 확정하고, 그 뒤는 조합 문자열로 보고한다. 한국어 입력기는 한글만 조합하므로, 이 입력기가 넣은
// 문자열에 한글이 없으면(예: 음절 뒤의 공백이나 숫자) 입력기가 더 고치지 않으므로 바로 확정한다.
// 문서는 입력기의 조합을 끝낼 때 비운다.
- (void)insertText:(id)string replacementRange:(NSRange)range {
    NSString *text = [string isKindOfClass:NSAttributedString.class]
        ? [(NSAttributedString *)string string]
        : ([string isKindOfClass:NSString.class] ? (NSString *)string : nil);
    if (!text) return;

    if (range.location != NSNotFound && range.location < self.committedLength) {
        // 이미 PTY 로 보낸 문자열은 되돌릴 수 없다. 교체를 버리지 않고 오류로 알린다.
        NSString *reason = [NSString stringWithFormat:@"input method replaced committed text at %lu (committed %lu)",
            (unsigned long)range.location, (unsigned long)self.committedLength];
        NSData *data = [NSJSONSerialization dataWithJSONObject:@{ @"type": @"error", @"reason": reason } options:0 error:NULL];
        [self report:[[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] autorelease].UTF8String];
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
    if (start > self.committedLength) [self commitThrough:start];
    if ([self selectedSourceComposesOnlyHangul] && !containsHangul([self.textStorage.string substringFromIndex:self.committedLength])) {
        [self commitThrough:self.textStorage.length];
    }
    [self reportPreedit];
}

- (void)setMarkedText:(id)string selectedRange:(NSRange)selectedRange replacementRange:(NSRange)replacementRange {
    if (![string isKindOfClass:NSAttributedString.class] && ![string isKindOfClass:NSString.class]) return;
    [super setMarkedText:string selectedRange:selectedRange replacementRange:replacementRange];
    [self reportPreedit];
}

// 선택된 입력 소스가 입력기인지 확인한다. 자판(keyboard layout)은 넣은 문자열을 고쳐 쓰지 않는다.
- (BOOL)selectedSourceComposes {
    NSString *identifier = self.inputContext.selectedKeyboardInputSource;
    if (!identifier) return NO;
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

// 선택된 입력 소스가 macOS 한국어 입력기이면 YES. 이 입력기는 한글 자모와 음절만 조합하며, 교체 범위로
// 조합하는 동안 조합이 끝났다는 콜백을 보내지 않는다(음절 뒤 Space 는 음절 재확정 뒤 insert(" ") 이다).
- (BOOL)selectedSourceComposesOnlyHangul {
    return [self.inputContext.selectedKeyboardInputSource hasPrefix:@"com.apple.inputmethod.Korean."];
}

// 문서의 확정 위치부터 end 까지를 확정 입력으로 보고한다. 문서는 바꾸지 않는다.
- (void)commitThrough:(NSUInteger)end {
    if (end <= self.committedLength) return;
    NSString *committed = [self.textStorage.string substringWithRange:
        NSMakeRange(self.committedLength, end - self.committedLength)];
    self.committedLength = end;
    NSString *json = [NSString stringWithFormat:@"{\"type\":\"insert\",\"text\":\"%@\",\"replacementRange\":null,\"attributed\":false}",
        [self jsonEscapedString:committed]];
    [self report:json.UTF8String];
}

// 확정 위치 뒤, 입력기가 아직 고칠 수 있는 문자열을 조합 문자열로 보고한다. 바뀐 경우에만 보고한다.
- (void)reportPreedit {
    NSString *storage = self.textStorage.string;
    NSString *preedit = self.committedLength <= storage.length ? [storage substringFromIndex:self.committedLength] : @"";
    if ([preedit isEqualToString:self.reportedPreedit]) return;
    self.reportedPreedit = preedit;
    NSRange selected = self.selectedRange;
    NSRange local = selected.location != NSNotFound && selected.location >= self.committedLength
        ? NSMakeRange(selected.location - self.committedLength, selected.length) : NSMakeRange(NSNotFound, 0);
    NSString *json = [NSString stringWithFormat:@"{\"type\":\"compose\",\"text\":\"%@\",\"selectedRange\":%@,\"replacementRange\":null,\"attributed\":false}",
        [self jsonEscapedString:preedit], [self jsonRange:local]];
    [self report:json.UTF8String];
}

- (void)clearDocument {
    [self.textStorage deleteCharactersInRange:NSMakeRange(0, self.textStorage.length)];
    self.committedLength = 0;
    [self reportPreedit];
}

// 명령·특수 키·포커스 해제·입력 소스 전환·닫기 전에 남은 문자열을 확정하고 입력기의 조합을 끝낸다.
// 입력기가 marked text 를 가진 동안은 입력기가 확정을 결정한다.
- (void)commitPending {
    if (self.hasMarkedText || self.textStorage.length == 0) return;
    [self commitThrough:self.textStorage.length];
    [self.inputContext discardMarkedText];
    [self clearDocument];
}

- (void)inputSourceChanged:(NSNotification *)notification {
    if (notification.object == self.inputContext) [self commitPending];
}

- (NSRect)firstRectForCharacterRange:(NSRange)range actualRange:(NSRangePointer)actualRange {
    if (actualRange) *actualRange = NSMakeRange(NSNotFound, 0);

    NSWindow *window = self.window;
    if (!window) return NSZeroRect;

    NSRect caretRect = NSMakeRect(self.caretPos.x, self.caretPos.y,
        self.caretWidth, self.caretHeight);
    NSRect converted = [self convertRect:caretRect toView:window.contentView];
    return [window convertRectToScreen:converted];
}

- (NSUInteger)characterIndexForPoint:(NSPoint)point {
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
    NSRect backing = [view convertRectToBacking:view.bounds];
    CGFloat scale = surfaceScale(view.webSurface);
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
        [view reject:@"notFound"];
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

    // scale 은 양수여야 한다.
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

    // 그림은 창의 배율로 그려져야 한다. 다르면 글자 크기가 틀어지므로 표시하지 않는다.
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

    [json appendFormat:@"\"error\":%@", view.presentationError
        ? [NSString stringWithFormat:@"\"%@\"", view.presentationError] : @"null"];
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
