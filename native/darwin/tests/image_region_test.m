#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <IOSurface/IOSurface.h>
#import <objc/runtime.h>
#import "image_region.h"
#import "webview_geometry.h"

static int failures = 0;
static NSUInteger countedSurfaceObserverRegistrations = 0;
static IMP originalAddObserverImplementation = NULL;

static void countSurfaceObserverRegistration(id self, SEL selector, id observer, SEL observerSelector,
    NSString *name, id object) {
    if ([name isEqual:NSViewFrameDidChangeNotification] && [observer isKindOfClass:NSClassFromString(@"SPImageRegion")]) {
        countedSurfaceObserverRegistrations++;
    }
    ((void (*)(id, SEL, id, SEL, NSString *, id))originalAddObserverImplementation)(self, selector,
        observer, observerSelector, name, object);
}

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// 이벤트를 JSON 형태로 모은다
static NSMutableArray *collectedEvents = nil;
// 두 영역의 초점 전환을 가릴 때 쓰는 별도 수집기들(V5-114 의 A->B 검사).
static NSMutableArray *eventsA16 = nil;
static NSMutableArray *eventsB16 = nil;

static void testEvent(void *context, const char *json) {
    if (context == (void *)1) {
        if (!eventsA16) eventsA16 = [NSMutableArray new];
        [eventsA16 addObject:[NSString stringWithUTF8String:json]];
        return;
    }
    if (context == (void *)2) {
        if (!eventsB16) eventsB16 = [NSMutableArray new];
        [eventsB16 addObject:[NSString stringWithUTF8String:json]];
        return;
    }
    if (!collectedEvents) collectedEvents = [NSMutableArray new];
    [collectedEvents addObject:[NSString stringWithUTF8String:json]];
}

// from 이후 insert 이벤트의 확정 문자열 목록.
static NSArray *committedTexts(NSUInteger from) {
    NSMutableArray *texts = [NSMutableArray array];
    for (NSUInteger i = from; i < collectedEvents.count; i++) {
        NSDictionary *event = [NSJSONSerialization JSONObjectWithData:[collectedEvents[i] dataUsingEncoding:NSUTF8StringEncoding]
            options:0 error:NULL];
        if ([event[@"type"] isEqual:@"insert"]) [texts addObject:event[@"text"] ?: NSNull.null];
    }
    return texts;
}

// from 이후 마지막 compose 이벤트의 조합 문자열. 없으면 nil.
static NSString *lastPreedit(NSUInteger from) {
    NSString *text = nil;
    for (NSUInteger i = from; i < collectedEvents.count; i++) {
        NSDictionary *event = [NSJSONSerialization JSONObjectWithData:[collectedEvents[i] dataUsingEncoding:NSUTF8StringEncoding]
            options:0 error:NULL];
        if ([event[@"type"] isEqual:@"compose"]) text = event[@"text"];
    }
    return text;
}

// 네 모서리를 다른 색으로 칠한 전역 IOSurface를 만든다
static IOSurfaceRef createColoredGlobalSurface(size_t width, size_t height, unsigned char *nonce) {
    IOSurfaceRef surface = IOSurfaceCreate((CFDictionaryRef)@{
        (id)kIOSurfaceWidth: @(width),
        (id)kIOSurfaceHeight: @(height),
        (id)kIOSurfaceBytesPerElement: @4,
        (id)kIOSurfacePixelFormat: @(kCVPixelFormatType_32BGRA),
    });

    if (!surface) return NULL;

    // 논스를 만들고 설정한다
    arc4random_buf(nonce, 16);
    CFDataRef nonceData = CFDataCreate(NULL, nonce, 16);
    IOSurfaceSetValue(surface, CFSTR("soksak.frame"), nonceData);
    CFRelease(nonceData);

    // 버퍼에 접근해서 네 모서리를 다르게 칠한다
    IOSurfaceLock(surface, 0, NULL);
    void *ptr = IOSurfaceGetBaseAddress(surface);
    size_t pitch = IOSurfaceGetBytesPerRow(surface);
    if (ptr) {
        uint32_t *pixels = (uint32_t *)ptr;
        // 왼쪽 위: 빨강
        pixels[0] = 0xFFFF0000;
        // 오른쪽 위: 초록
        pixels[width - 1] = 0xFF00FF00;
        // 왼쪽 아래
        uint32_t *bottomLeft = (uint32_t *)((char *)ptr + (height - 1) * pitch);
        bottomLeft[0] = 0xFF0000FF;
        // 오른쪽 아래
        bottomLeft[width - 1] = 0xFFFFFF00;
    }
    IOSurfaceUnlock(surface, 0, NULL);

    return surface;
}

void sp_test_declare_activation(void);

int main(int argc, char **argv) { @autoreleasepool {
    // --activation 은 앱을 활성화해 OS 이벤트 대기열의 눌림이 웹뷰를 첫 응답자로 만드는지 검사한다.
    // make test-activation 만 사용한다.
    BOOL activation = argc > 1 && strcmp(argv[1], "--activation") == 0;
    if (activation) sp_test_declare_activation();
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 500, 400)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 500, 400)] autorelease];
    WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
    main.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [window.contentView addSubview:main];
    WKWebView *surface = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 500, 400)] autorelease];
    [window.contentView addSubview:surface];
    [window orderBack:nil];
    check(sp_surface_create(main) != NULL,
        @"the main webview creates the composition before a surface webview is attached");
    webviewAttachSurface(surface, main);
    webviewSetFrame(surface, 0, 0, 500, 400);
    NSView *nativePlane = (NSView *)webviewSurfaceNativePlane(surface);

    // TEST 1: 방향·크기 - 레이어 속성과 표면 ID 확인
    {
        [collectedEvents removeAllObjects];
        Class notificationCenterClass = NSNotificationCenter.class;
        Method addObserverMethod = class_getInstanceMethod(notificationCenterClass,
            @selector(addObserver:selector:name:object:));
        originalAddObserverImplementation = method_getImplementation(addObserverMethod);
        method_setImplementation(addObserverMethod, (IMP)countSurfaceObserverRegistration);
        // 등록부는 생성 호출의 autorelease pool보다 오래 살아야 한다(V5-116-4-1).
        void *bootstrapRegion = NULL;
        @autoreleasepool {
            bootstrapRegion = sp_region_create(surface, "pool-lifetime", testEvent, NULL);
            check(bootstrapRegion != NULL, @"region registry initializes inside a short-lived autorelease pool");
        }
        void *region1 = sp_region_create(surface, "test1", testEvent, NULL);
        check(region1 != NULL, @"region registry survives the first creation autorelease pool drain");
        sp_region_close(bootstrapRegion);
        check(region1 != NULL, @"TEST 1: region created");

        countedSurfaceObserverRegistrations = 0;
        sp_region_place(region1, 10, 20, 30, 40, true);
        for (NSUInteger placement = 0; placement < 20; placement++) {
            sp_region_place(region1, 10 + placement, 20, 30, 40, true);
        }
        check(countedSurfaceObserverRegistrations == 1,
            [NSString stringWithFormat:@"TEST 1: repeated placement keeps one frame observer (got %lu registrations)",
                (unsigned long)countedSurfaceObserverRegistrations]);
        method_setImplementation(addObserverMethod, originalAddObserverImplementation);
        originalAddObserverImplementation = NULL;
        double raster1[3] = {0};
        check(sp_region_raster(region1, raster1), @"TEST 1: placed region reports its native raster");
        unsigned char nonce1[16];
        IOSurfaceRef testSurface1 = createColoredGlobalSurface((size_t)raster1[0], (size_t)raster1[1], nonce1);
        check(testSurface1 != NULL, @"TEST 1: IOSurface created with global flag");
        BOOL presented = sp_region_present(region1, IOSurfaceGetID(testSurface1), nonce1,
            raster1[0], raster1[1], raster1[2]);
        check(presented, @"TEST 1: sp_region_present succeeded");

        // 레이어를 찾아서 속성을 확인한다
        NSView *regionView = (NSView *)region1;
        [regionView updateTrackingAreas];
        NSUInteger cursorAreas = 0;
        for (NSTrackingArea *area in regionView.trackingAreas) {
            if (area.options & NSTrackingCursorUpdate) cursorAreas++;
        }
        check(cursorAreas == 0, [NSString stringWithFormat:@"TEST 1: image input view has no cursor tracking area (%lu)",
            (unsigned long)cursorAreas]);
        // 구현에서 imageLayer는 SPImageRegion의 sublayer
        NSArray *sublayers = regionView.layer.sublayers;
        CALayer *imageLayer = [sublayers firstObject];
        check(imageLayer != NULL, @"TEST 1: image layer found");

        if (imageLayer) {
            check([imageLayer.contentsGravity isEqualToString:kCAGravityTopLeft],
                @"TEST 1: terminal pixels are never scaled to fill a pending geometry");
            CGImageRef snapshot = (CGImageRef)imageLayer.contents;
            check(snapshot != NULL && CGImageGetWidth(snapshot) == (size_t)raster1[0]
                && CGImageGetHeight(snapshot) == (size_t)raster1[1],
                @"TEST 1: layer owns a copied snapshot at the exact native raster");
            check((CFTypeRef)snapshot != (CFTypeRef)testSurface1,
                @"TEST 1: layer does not point at the supplier IOSurface");
            IOSurfaceLock(testSurface1, 0, NULL);
            *(uint32_t *)IOSurfaceGetBaseAddress(testSurface1) = 0;
            IOSurfaceUnlock(testSurface1, 0, NULL);
            CFDataRef copied = CGDataProviderCopyData(CGImageGetDataProvider(snapshot));
            uint32_t firstPixel = *(const uint32_t *)CFDataGetBytePtr(copied);
            check(firstPixel == 0xFFFF0000,
                @"TEST 1: mutating the transfer IOSurface does not change the presented snapshot");
            CFRelease(copied);

            // 레이어 한 단위가 덮는 장치 픽셀 수와 같아야 그림 한 픽셀이 장치 한 픽셀이 된다.
            NSView *regionView1 = (NSView *)region1;
            CGFloat perUnit = NSWidth([regionView1 convertRectToBacking:regionView1.bounds]) / NSWidth(regionView1.bounds);
            check(imageLayer.contentsScale == perUnit,
                [NSString stringWithFormat:@"TEST 1: contentsScale is backing pixels per unit %g (got %g)", perUnit, imageLayer.contentsScale]);

            check([imageLayer.magnificationFilter isEqualToString:kCAFilterNearest],
                [NSString stringWithFormat:@"TEST 1: magnificationFilter is Nearest (got %@)", imageLayer.magnificationFilter]);
        }

        sp_region_close(region1);
        CFRelease(testSurface1);
    }

    // TEST 2: 논스 불일치 - false 반환 및 "forbidden" 이벤트
    {
        [collectedEvents removeAllObjects];
        unsigned char nonce2[16];
        unsigned char wrongNonce[16];
        IOSurfaceRef testSurface2 = createColoredGlobalSurface(100, 100, nonce2);
        IOSurfaceID sid2 = IOSurfaceGetID(testSurface2);
        arc4random_buf(wrongNonce, 16);

        void *region2 = sp_region_create(surface, "test2", testEvent, NULL);
        BOOL presented = sp_region_present(region2, sid2, wrongNonce, 100, 100, window.backingScaleFactor);
        check(!presented, @"TEST 2: sp_region_present returns false with wrong nonce");

        check([collectedEvents count] > 0, @"TEST 2: event received");
        if ([collectedEvents count] > 0) {
            NSString *eventStr = [collectedEvents objectAtIndex:0];
            check([eventStr rangeOfString:@"\"reason\":\"forbidden\""].location != NSNotFound,
                [NSString stringWithFormat:@"TEST 2: event contains 'forbidden' reason (got: %@)", eventStr]);
        }

        sp_region_close(region2);
        CFRelease(testSurface2);
    }

    // TEST 3: 없는 ID - false 반환 및 "notFound" 이벤트
    {
        [collectedEvents removeAllObjects];
        unsigned char nonce3[16];
        arc4random_buf(nonce3, 16);

        void *region3 = sp_region_create(surface, "test3", testEvent, NULL);
        BOOL presented = sp_region_present(region3, 0xdeadbeef, nonce3, 100, 100, window.backingScaleFactor);
        check(!presented, @"TEST 3: sp_region_present returns false with non-existent ID");

        check([collectedEvents count] > 0, @"TEST 3: event received");
        if ([collectedEvents count] > 0) {
            NSString *eventStr = [collectedEvents objectAtIndex:0];
            check([eventStr rangeOfString:@"\"reason\":\"notFound\""].location != NSNotFound,
                [NSString stringWithFormat:@"TEST 3: event contains 'notFound' reason (got: %@)", eventStr]);
        }

        sp_region_close(region3);
    }

    // TEST 4: 크기 불일치 - false 반환 및 "size" 이벤트
    {
        [collectedEvents removeAllObjects];
        unsigned char nonce4[16];
        IOSurfaceRef testSurface4 = createColoredGlobalSurface(100, 100, nonce4);
        IOSurfaceID sid4 = IOSurfaceGetID(testSurface4);

        void *region4 = sp_region_create(surface, "test4", testEvent, NULL);
        BOOL presented = sp_region_present(region4, sid4, nonce4, 200, 200, window.backingScaleFactor);  // 잘못된 크기
        check(!presented, @"TEST 4: sp_region_present returns false with wrong size");

        check([collectedEvents count] > 0, @"TEST 4: event received");
        if ([collectedEvents count] > 0) {
            NSString *eventStr = [collectedEvents objectAtIndex:0];
            check([eventStr rangeOfString:@"\"reason\":\"size\""].location != NSNotFound,
                [NSString stringWithFormat:@"TEST 4: event contains 'size' reason (got: %@)", eventStr]);
        }

        sp_region_close(region4);
        CFRelease(testSurface4);
    }

    // TEST 5: 배치 - 여백 유지
    {
        [collectedEvents removeAllObjects];

        void *region5 = sp_region_create(surface, "test5", testEvent, NULL);
        sp_region_place(region5, 50, 60, 70, 80, true);

        double frame[6] = {0};
        sp_region_frame(region5, frame);
        // 초기: 500x400, 여백 L:50, T:60, R:70, B:80 → 실제 크기: 500-50-70=380, 400-60-80=260
        check(frame[0] == 50 && frame[1] == 60 && frame[2] == 380 && frame[3] == 260,
            [NSString stringWithFormat:@"TEST 5: initial frame has correct insets (%.0f, %.0f, %.0f, %.0f)",
                frame[0], frame[1], frame[2], frame[3]]);

        // 창 크기를 바꾼다
        [window setContentSize:NSMakeSize(600, 500)];
        // 위도우의 contentView가 자동으로 크기 조정되지 않을 수 있으므로 명시적으로 설정한다
        webviewSetFrame(surface, 0, 0, 600, 500);
        // 런루프를 처리해서 프레임 변경 알림이 전달되도록 한다
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
        sp_region_frame(region5, frame);
        // 600x500, 여백 유지: 600-50-70=480, 500-60-80=360
        check(frame[0] == 50 && frame[1] == 60 && frame[2] == 480 && frame[3] == 360,
            [NSString stringWithFormat:@"TEST 5: frame follows surface size (%.0f, %.0f, %.0f, %.0f)",
                frame[0], frame[1], frame[2], frame[3]]);

        // 창을 다시 원래 크기로
        [window setContentSize:NSMakeSize(500, 400)];
        webviewSetFrame(surface, 0, 0, 500, 400);

        sp_region_close(region5);
    }

    // TEST 5A: 준비 프레임은 새 래스터의 정확한 크기를 사용한다.
    {
        [collectedEvents removeAllObjects];

        void *region5a = sp_region_create(surface, "test5a", testEvent, NULL);
        sp_region_place(region5a, 50, 60, 70, 80, true);
        double raster5a[3] = {0};
        check(sp_region_raster(region5a, raster5a), @"TEST 5A: initial raster exists");
        unsigned char nonce5a[16];
        IOSurfaceRef testSurface5a = createColoredGlobalSurface((size_t)raster5a[0], (size_t)raster5a[1], nonce5a);
        check(sp_region_present(region5a, IOSurfaceGetID(testSurface5a), nonce5a,
            raster5a[0], raster5a[1], raster5a[2]), @"TEST 5A: initial snapshot is presented");

        // 실제 표시 중에는 SurfaceHost의 열린 CATransaction이 이 준비 기하를
        // 가리며, 호스트가 일치하는 래스터와 함께 한 번에 커밋한다.
        sp_region_place(region5a, 100, 40, 20, 30, true);
        double frame5a[6] = {0};
        sp_region_frame(region5a, frame5a);
        check(frame5a[0] == 100 && frame5a[1] == 40 && frame5a[2] == 380 && frame5a[3] == 330,
            [NSString stringWithFormat:@"TEST 5A: prepared frame follows new insets (%.0f, %.0f, %.0f, %.0f)",
                frame5a[0], frame5a[1], frame5a[2], frame5a[3]]);

        double raster5aNew[3] = {0};
        check(sp_region_raster(region5a, raster5aNew), @"TEST 5A: new raster dimensions are measured");
        unsigned char nonce5aNew[16];
        IOSurfaceRef testSurface5aNew = createColoredGlobalSurface(
            (size_t)raster5aNew[0], (size_t)raster5aNew[1], nonce5aNew);
        check(sp_region_present(region5a, IOSurfaceGetID(testSurface5aNew), nonce5aNew,
            raster5aNew[0], raster5aNew[1], raster5aNew[2]),
            @"TEST 5A: matching raster commits new frame");
        sp_region_frame(region5a, frame5a);
        check(frame5a[0] == 100 && frame5a[1] == 40 && frame5a[2] == 380 && frame5a[3] == 330,
            [NSString stringWithFormat:@"TEST 5A: matching raster commits new insets (%.0f, %.0f, %.0f, %.0f)",
                frame5a[0], frame5a[1], frame5a[2], frame5a[3]]);

        sp_region_close(region5a);
        CFRelease(testSurface5a);
        CFRelease(testSurface5aNew);
    }

    // TEST 6: pointer input remains owned by the DOM anchor.
    {
        [collectedEvents removeAllObjects];

        void *region6 = sp_region_create(surface, "test6", testEvent, NULL);
        sp_region_place(region6, 10, 10, 10, 10, true);

        NSView *regionView = (NSView *)region6;
        NSPoint testPoint = NSMakePoint(20, 20);  // 영역 내의 점
        NSView *hitView = [regionView hitTest:testPoint];
        check(hitView == nil, @"TEST 6: hitTest returns nil so the DOM receives pointer input");

        sp_region_close(region6);
    }

    // TEST 7: 초점 - focus 이벤트 및 hasFocus 상태
    {
        [collectedEvents removeAllObjects];

        void *region7 = sp_region_create(surface, "test7", testEvent, NULL);
        sp_region_place(region7, 10, 10, 10, 10, true);

        sp_region_focus(region7);

        double frame[6] = {0};
        sp_region_frame(region7, frame);
        check(frame[5] == 1, @"TEST 7: region frame out[5] (focused) is 1");

        check([collectedEvents count] > 0, @"TEST 7: focus event received");
        BOOL foundFocusEvent = NO;
        for (NSString *eventStr in collectedEvents) {
            if ([eventStr rangeOfString:@"\"type\":\"focus\""].location != NSNotFound &&
                [eventStr rangeOfString:@"\"focused\":true"].location != NSNotFound) {
                foundFocusEvent = YES;
                break;
            }
        }
        check(foundFocusEvent, @"TEST 7: focus event has correct format");

        sp_region_close(region7);
    }

    // TEST 8: synthetic NSTextInputClient calls. This does not exercise the active input
    // source. Whether inserted text is committed at once or kept as editable preedit depends
    // on the selected input source, so each case commits through a focus change and then
    // checks the committed text, which is the same for every input source.
    {
        void *region8 = sp_region_create(surface, "test8", testEvent, NULL);
        sp_region_place(region8, 10, 10, 10, 10, true);
        sp_region_focus(region8);
        NSTextView *regionView = (NSTextView *)region8;
        check([window.firstResponder isKindOfClass:NSTextView.class],
            @"TEST 8: image input responder delegates text-system state to NSTextView");
        // F8-9: NSTextView 가 상속하는 편집은 모두 꺼져 있거나 입력에 영향이 없다.
        check(!regionView.automaticQuoteSubstitutionEnabled && !regionView.automaticDashSubstitutionEnabled
            && !regionView.automaticTextReplacementEnabled && !regionView.automaticSpellingCorrectionEnabled
            && !regionView.automaticLinkDetectionEnabled && !regionView.automaticDataDetectionEnabled
            && !regionView.automaticTextCompletionEnabled && !regionView.continuousSpellCheckingEnabled
            && !regionView.grammarCheckingEnabled && !regionView.smartInsertDeleteEnabled
            && regionView.enabledTextCheckingTypes == 0,
            @"TEST 8: automatic substitution, replacement, spelling, grammar, detection, completion, and text checking are off");
        check(!regionView.allowsUndo && !regionView.isRichText && !regionView.importsGraphics
            && !regionView.usesFindBar && !regionView.usesFontPanel && !regionView.usesRuler,
            @"TEST 8: undo, rich text, graphics, find, font panel, and ruler are off");
        check([regionView validRequestorForSendType:NSPasteboardTypeString returnType:NSPasteboardTypeString] == nil
            && [regionView validRequestorForSendType:NSPasteboardTypeString returnType:nil] == nil,
            @"TEST 8: the Services menu cannot read or replace the input document");
        check([regionView hitTest:NSMakePoint(1, 1)] == nil,
            @"TEST 8: pointer, menu, and drag input never target the input client");
        NSUInteger beforeSubstitution = [collectedEvents count];
        [regionView insertText:@"\"a\" -- (c) teh" replacementRange:NSMakeRange(NSNotFound, 0)];
        [window makeFirstResponder:nil];
        check([[committedTexts(beforeSubstitution) componentsJoinedByString:@""] isEqual:@"\"a\" -- (c) teh"],
            [NSString stringWithFormat:@"TEST 8: inserted text is committed without substitution or correction (got %@)", committedTexts(beforeSubstitution)]);
        sp_region_focus(region8);

        [collectedEvents removeAllObjects];
        [(id<NSTextInputClient>)regionView setMarkedText:@"한" selectedRange:NSMakeRange(1, 0) replacementRange:NSMakeRange(NSNotFound, 0)];
        check(regionView.hasMarkedText && [lastPreedit(0) isEqual:@"한"],
            [NSString stringWithFormat:@"TEST 8: marked text is reported as preedit (got %@)", collectedEvents]);
        [(id<NSTextInputClient>)regionView setMarkedText:@"한글" selectedRange:NSMakeRange(2, 0) replacementRange:NSMakeRange(NSNotFound, 0)];
        check(NSEqualRanges(regionView.markedRange, NSMakeRange(0, 2)) && [lastPreedit(0) isEqual:@"한글"],
            @"TEST 8: a replacement preedit updates the marked range and the reported preedit");
        check(committedTexts(0).count == 0, @"TEST 8: marked text is not committed");
        [(id<NSTextInputClient>)regionView insertText:@"한글" replacementRange:NSMakeRange(NSNotFound, 0)];
        [window makeFirstResponder:nil];
        check([committedTexts(0) isEqualToArray:@[@"한글"]] && [lastPreedit(0) isEqual:@""]
            && regionView.textStorage.length == 0,
            [NSString stringWithFormat:@"TEST 8: inserted text is committed exactly once by the focus change (got %@)", collectedEvents]);

        // An input method edits its previous insert through a replacement range: ㅎ → 하 → 한.
        sp_region_focus(region8);
        void (^inputMethod)(NSString *, NSRange) = ^(NSString *text, NSRange range) {
            [(id<NSTextInputClient>)regionView insertText:text replacementRange:range];
        };
        NSUInteger beforeEdit = [collectedEvents count];
        inputMethod(@"ㅎ", NSMakeRange(NSNotFound, 0));
        NSArray *afterFirst = committedTexts(beforeEdit);
        inputMethod(@"하", NSMakeRange(0, 1));
        inputMethod(@"한", NSMakeRange(0, 1));
        if (afterFirst.count == 0) {
            check(committedTexts(beforeEdit).count == 0 && [lastPreedit(beforeEdit) isEqual:@"한"],
                [NSString stringWithFormat:@"TEST 8: replaced input-method text stays editable preedit (got %@)", collectedEvents]);
            inputMethod(@"ㄱ", NSMakeRange(NSNotFound, 0));
            check([committedTexts(beforeEdit) isEqualToArray:@[@"한"]] && [lastPreedit(beforeEdit) isEqual:@"ㄱ"],
                [NSString stringWithFormat:@"TEST 8: an appended insert commits the text before it (got %@)", collectedEvents]);
            [(id<NSTextInputClient>)regionView doCommandBySelector:@selector(insertNewline:)];
            check([committedTexts(beforeEdit) isEqualToArray:(@[@"한", @"ㄱ"])] && [lastPreedit(beforeEdit) isEqual:@""]
                && [[collectedEvents lastObject] rangeOfString:@"insertNewline:"].location != NSNotFound,
                [NSString stringWithFormat:@"TEST 8: a command commits the remaining preedit before it is reported (got %@)", collectedEvents]);

            // F8-16-1: the Korean input method composes only Hangul. The text it inserts after it confirms a syllable
            // (Space or a digit) is committed with the syllable at once; a new jamo stays preedit.
            if ([regionView.inputContext.selectedKeyboardInputSource hasPrefix:@"com.apple.inputmethod.Korean."]) {
                NSUInteger beforeSpace = [collectedEvents count];
                NSUInteger base = regionView.textStorage.length;
                inputMethod(@"ㅎ", NSMakeRange(NSNotFound, 0));
                inputMethod(@"하", NSMakeRange(base, 1));
                inputMethod(@"한", NSMakeRange(base, 1));
                inputMethod(@"한", NSMakeRange(base, 1));
                inputMethod(@" ", NSMakeRange(NSNotFound, 0));
                check([[committedTexts(beforeSpace) componentsJoinedByString:@""] isEqual:@"한 "]
                    && [lastPreedit(beforeSpace) isEqual:@""],
                    [NSString stringWithFormat:@"TEST 8: a space after a Korean syllable is committed at once (got %@)", collectedEvents]);
                inputMethod(@"1", NSMakeRange(NSNotFound, 0));
                inputMethod(@"ㄱ", NSMakeRange(NSNotFound, 0));
                check([[committedTexts(beforeSpace) componentsJoinedByString:@""] isEqual:@"한 1"]
                    && [lastPreedit(beforeSpace) isEqual:@"ㄱ"],
                    [NSString stringWithFormat:@"TEST 8: a digit is committed at once and a new jamo stays preedit (got %@)", collectedEvents]);
                [(id<NSTextInputClient>)regionView doCommandBySelector:@selector(insertNewline:)];
                NSUInteger beforeBatch = [collectedEvents count];
                NSUInteger batchStart = regionView.textStorage.length;
                inputMethod(@"은", NSMakeRange(NSNotFound, 0));
                inputMethod(@"은 ", NSMakeRange(batchStart, 1));
                check([[committedTexts(beforeBatch) componentsJoinedByString:@""] isEqual:@"은 "]
                    && [lastPreedit(beforeBatch) isEqual:@""],
                    [NSString stringWithFormat:@"TEST 8: a Korean syllable and Space in one insert are committed at once (got %@)", collectedEvents]);
            } else {
                printf("TEST 8: the selected input source is not the Korean input method; the Korean commit rule needs it\n");
            }
            [window makeFirstResponder:nil];
            sp_region_focus(region8);
        } else {
            printf("TEST 8: the selected input source is a keyboard layout; replacement cases need an input method\n");
        }

        NSUInteger beforeDelete = [collectedEvents count];
        [(id<NSTextInputClient>)regionView doCommandBySelector:@selector(deleteForward:)];
        check([collectedEvents count] == beforeDelete + 1 &&
            [[collectedEvents lastObject] rangeOfString:@"deleteForward:"].location != NSNotFound,
            @"TEST 8: doCommandBySelector reports its selector");

        NSAttributedString *attributed = [[[NSAttributedString alloc] initWithString:@"한글"] autorelease];
        [(id<NSTextInputClient>)regionView setMarkedText:attributed selectedRange:NSMakeRange(1, 0)
            replacementRange:NSMakeRange(NSNotFound, 0)];
        check([lastPreedit(0) isEqual:@"한글"], @"TEST 8: attributed marked text is reported as preedit");
        NSUInteger beforeUnmark = [collectedEvents count];
        [regionView unmarkText];
        [window makeFirstResponder:nil];
        // NSTextInputClient 계약에서 unmarkText 는 marked text 를 일반 입력으로 받아들인다.
        check([committedTexts(beforeUnmark) isEqualToArray:@[@"한글"]] && [lastPreedit(beforeUnmark) isEqual:@""]
            && !regionView.hasMarkedText && regionView.textStorage.length == 0,
            [NSString stringWithFormat:@"TEST 8: unmarkText commits the marked text exactly once (got %@)", collectedEvents]);
        NSUInteger afterUnmark = [collectedEvents count];
        [regionView unmarkText];
        check([collectedEvents count] == afterUnmark,
            [NSString stringWithFormat:@"TEST 8: unmarkText without marked text reports nothing (got %lu events)",
                [collectedEvents count] - afterUnmark]);

        NSUInteger beforeNoop = [collectedEvents count];
        [(id<NSTextInputClient>)regionView setMarkedText:@"pending" selectedRange:NSMakeRange(7, 0)
            replacementRange:NSMakeRange(NSNotFound, 0)];
        NSUInteger beforeNoopCommand = [collectedEvents count];
        [(id<NSTextInputClient>)regionView doCommandBySelector:@selector(noop:)];
        check([collectedEvents count] == beforeNoopCommand && [regionView.string isEqual:@"pending"]
            && [lastPreedit(beforeNoop) isEqual:@"pending"],
            [NSString stringWithFormat:@"TEST 8: noop: preserves pending input without reporting a command (got %@)", collectedEvents]);

        sp_region_close(region8);
    }

    // TEST 9: 접근성 및 캐럿
    {
        [collectedEvents removeAllObjects];

        void *region9 = sp_region_create(surface, "test9", testEvent, NULL);
        sp_region_place(region9, 10, 10, 10, 10, true);

        id regionView = (id)region9;

        // 접근성 텍스트 설정
        const char *testText = "Hello 접근성";
        sp_region_text(region9, testText);

        // 접근성 값 확인
        NSString *accessibilityValue = [regionView accessibilityValue];
        check([accessibilityValue isEqualToString:@"Hello 접근성"],
            [NSString stringWithFormat:@"TEST 9: accessibility text matches (got: %@)", accessibilityValue]);

        // 역할 확인
        NSAccessibilityRole role = [regionView accessibilityRole];
        check([role isEqualToString:NSAccessibilityTextAreaRole],
            [NSString stringWithFormat:@"TEST 9: accessibility role is TextAreaRole (got: %@)", role]);

        // 캐럿 위치 설정 및 확인
        sp_region_caret(region9, 25, 30, 2, 16);
        NSRange charRange = NSMakeRange(0, 1);
        NSRect caretRect = [(id<NSTextInputClient>)regionView firstRectForCharacterRange:charRange actualRange:NULL];
        // 넣은 크기가 그대로 돌아와야 한다("0이 아니다" 는 상수를 돌려줘도 통과한다).
        check(caretRect.size.width == 2 && caretRect.size.height == 16,
            [NSString stringWithFormat:@"TEST 9: caret rect keeps the size we set (x:%.0f y:%.0f w:%.0f h:%.0f)",
                caretRect.origin.x, caretRect.origin.y, caretRect.size.width, caretRect.size.height]);

        // 다른 캐럿을 넣으면 결과가 따라 움직인다.
        NSRect first = caretRect;
        sp_region_caret(region9, 25, 60, 3, 20);
        NSRect second = [(id<NSTextInputClient>)regionView firstRectForCharacterRange:charRange actualRange:NULL];
        check(second.size.width == 3 && second.size.height == 20 && second.origin.y != first.origin.y,
            @"TEST 9: a new caret replaces the reported rect");

        sp_region_close(region9);
    }

    // TEST 10: 키 이벤트 - 위 화살표
    {
        [collectedEvents removeAllObjects];

        void *region10 = sp_region_create(surface, "test10", testEvent, NULL);
        sp_region_place(region10, 10, 10, 10, 10, true);
        sp_region_focus(region10);

        id regionView = (id)region10;
        NSEvent *upEvent = [NSEvent keyEventWithType:NSEventTypeKeyDown
            location:NSZeroPoint
            modifierFlags:0
            timestamp:0
            windowNumber:0
            context:nil
            characters:@""
            charactersIgnoringModifiers:@""  // NSUpArrowFunctionKey
            isARepeat:NO
            keyCode:126];

        [collectedEvents removeAllObjects];
        [regionView keyDown:upEvent];

        check([collectedEvents count] == 1,
            [NSString stringWithFormat:@"TEST 10: exactly 1 event for Up arrow (got %lu)", [collectedEvents count]]);
        if ([collectedEvents count] > 0) {
            NSString *eventStr = [collectedEvents objectAtIndex:0];
            BOOL isKeyEvent = [eventStr rangeOfString:@"\"type\":\"key\""].location != NSNotFound;
            BOOL hasKeyUp = [eventStr rangeOfString:@"\"key\":\"Up\""].location != NSNotFound;
            BOOL noInsert = [eventStr rangeOfString:@"\"insert\""].location == NSNotFound;
            BOOL correctFlags = [eventStr rangeOfString:@"\"shift\":false,\"alt\":false,\"ctrl\":false"].location != NSNotFound;
            check(isKeyEvent && hasKeyUp && noInsert && correctFlags,
                [NSString stringWithFormat:@"TEST 10: event is correct key event (got: %@)", eventStr]);
        }

        sp_region_close(region10);
    }

    // TEST 11: 키 이벤트 - Return
    {
        [collectedEvents removeAllObjects];

        void *region11 = sp_region_create(surface, "test11", testEvent, NULL);
        sp_region_place(region11, 10, 10, 10, 10, true);
        sp_region_focus(region11);

        id regionView = (id)region11;
        NSEvent *returnEvent = [NSEvent keyEventWithType:NSEventTypeKeyDown
            location:NSZeroPoint
            modifierFlags:0
            timestamp:0
            windowNumber:0
            context:nil
            characters:@"\r"
            charactersIgnoringModifiers:@"\r"
            isARepeat:NO
            keyCode:36];

        [collectedEvents removeAllObjects];
        [regionView keyDown:returnEvent];

        check([collectedEvents count] == 1,
            [NSString stringWithFormat:@"TEST 11: exactly 1 event for Return (got %lu)", [collectedEvents count]]);
        if ([collectedEvents count] > 0) {
            NSString *eventStr = [collectedEvents objectAtIndex:0];
            BOOL hasKeyEnter = [eventStr rangeOfString:@"\"key\":\"Enter\""].location != NSNotFound;
            check(hasKeyEnter,
                [NSString stringWithFormat:@"TEST 11: event has key:Enter (got: %@)", eventStr]);
        }

        sp_region_close(region11);
    }

    // 포인터 입력과 같이 끌어 놓기도 영역을 지나 페이지로 간다. 영역은 끌기 형식을 등록하지 않는다.
    {
        void *region = sp_region_create(surface, "drag", testEvent, NULL);
        sp_region_place(region, 10, 10, 10, 10, true);
        NSArray *types = [(NSView *)region registeredDraggedTypes];
        check(types.count == 0, [NSString stringWithFormat:@"drag: the region registers no dragged types (got %@)", types]);
        // NSTextView 는 초점을 받거나 편집 상태가 바뀔 때 끌기 형식을 다시 등록한다.
        sp_region_focus(region);
        [(NSTextView *)region setEditable:YES];
        types = [(NSView *)region registeredDraggedTypes];
        check(types.count == 0, [NSString stringWithFormat:@"drag: a focused region registers no dragged types (got %@)", types]);
        sp_region_close(region);
    }

    // 숫자 키패드 키는 입력기를 거치지 않고 키패드 키 이름으로 보고한다. 응용 키패드 모드의 인코딩은 사이드카가 정한다.
    {
        void *region = sp_region_create(surface, "keypad", testEvent, NULL);
        sp_region_place(region, 10, 10, 10, 10, true);
        sp_region_focus(region);
        id regionView = (id)region;
        NSArray *cases = @[@[@"5", @87, @"Keypad5"], @[@".", @65, @"KeypadDecimal"], @[@"+", @69, @"KeypadPlus"],
            @[@"\x03", @76, @"KeypadEnter"], @[@"=", @81, @"KeypadEquals"]];
        for (NSArray *item in cases) {
            NSString *characters = [item[0] isEqualToString:@"\x03"] ? [NSString stringWithFormat:@"%C", (unichar)0x03] : item[0];
            NSEvent *event = [NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint
                modifierFlags:NSEventModifierFlagNumericPad timestamp:0 windowNumber:0 context:nil
                characters:characters charactersIgnoringModifiers:characters isARepeat:NO keyCode:[item[1] unsignedShortValue]];
            [collectedEvents removeAllObjects];
            [regionView keyDown:event];
            NSString *expected = [NSString stringWithFormat:@"\"key\":\"%@\"", item[2]];
            check(collectedEvents.count == 1 && [collectedEvents[0] rangeOfString:expected].location != NSNotFound,
                [NSString stringWithFormat:@"keypad: keyCode %@ reports %@ (got %@)", item[1], item[2], collectedEvents]);
        }
        sp_region_close(region);
    }

    // TEST 12: 키 이벤트 - Backspace
    {
        [collectedEvents removeAllObjects];

        void *region12 = sp_region_create(surface, "test12", testEvent, NULL);
        sp_region_place(region12, 10, 10, 10, 10, true);
        sp_region_focus(region12);

        id regionView = (id)region12;
        NSEvent *backspaceEvent = [NSEvent keyEventWithType:NSEventTypeKeyDown
            location:NSZeroPoint
            modifierFlags:0
            timestamp:0
            windowNumber:0
            context:nil
            characters:@"\x7f"
            charactersIgnoringModifiers:@"\x7f"
            isARepeat:NO
            keyCode:51];

        [collectedEvents removeAllObjects];
        [regionView keyDown:backspaceEvent];

        check([collectedEvents count] == 1,
            [NSString stringWithFormat:@"TEST 12: exactly 1 event for Backspace (got %lu)", [collectedEvents count]]);
        if ([collectedEvents count] > 0) {
            NSString *eventStr = [collectedEvents objectAtIndex:0];
            BOOL hasKeyBackspace = [eventStr rangeOfString:@"\"key\":\"Backspace\""].location != NSNotFound;
            check(hasKeyBackspace,
                [NSString stringWithFormat:@"TEST 12: event has key:Backspace (got: %@)", eventStr]);
        }

        sp_region_close(region12);
    }

    // TEST 13: 키 이벤트 - Ctrl+C
    {
        [collectedEvents removeAllObjects];

        void *region13 = sp_region_create(surface, "test13", testEvent, NULL);
        sp_region_place(region13, 10, 10, 10, 10, true);
        sp_region_focus(region13);

        id regionView = (id)region13;
        NSEvent *ctrlCEvent = [NSEvent keyEventWithType:NSEventTypeKeyDown
            location:NSZeroPoint
            modifierFlags:NSEventModifierFlagControl
            timestamp:0
            windowNumber:0
            context:nil
            characters:@"c"
            charactersIgnoringModifiers:@"c"
            isARepeat:NO
            keyCode:8];

        [collectedEvents removeAllObjects];
        [regionView keyDown:ctrlCEvent];

        check([collectedEvents count] == 1,
            [NSString stringWithFormat:@"TEST 13: exactly 1 event for Ctrl+C (got %lu)", [collectedEvents count]]);
        if ([collectedEvents count] > 0) {
            NSString *eventStr = [collectedEvents objectAtIndex:0];
            BOOL isKeyEvent = [eventStr rangeOfString:@"\"type\":\"key\""].location != NSNotFound;
            BOOL hasKeyChar = [eventStr rangeOfString:@"\"key\":\"Char\""].location != NSNotFound;
            BOOL hasTextC = [eventStr rangeOfString:@"\"text\":\"c\""].location != NSNotFound;
            BOOL hasCtrl = [eventStr rangeOfString:@"\"ctrl\":true"].location != NSNotFound;
            BOOL noInsert = [eventStr rangeOfString:@"\"insert\""].location == NSNotFound;
            check(isKeyEvent && hasKeyChar && hasTextC && hasCtrl && noInsert,
                [NSString stringWithFormat:@"TEST 13: event is correct Ctrl+C event (got: %@)", eventStr]);
        }

        sp_region_close(region13);
    }

    // TEST 13a: 한글 입력 소스 문자가 와도 Ctrl 키는 물리 ANSI 키로 전달한다
    {
        [collectedEvents removeAllObjects];

        void *region13a = sp_region_create(surface, "test13a", testEvent, NULL);
        sp_region_place(region13a, 10, 10, 10, 10, true);
        sp_region_focus(region13a);

        id regionView = (id)region13a;
        NSEvent *ctrlUEvent = [NSEvent keyEventWithType:NSEventTypeKeyDown
            location:NSZeroPoint
            modifierFlags:NSEventModifierFlagControl
            timestamp:0
            windowNumber:0
            context:nil
            characters:@"ㅕ"
            charactersIgnoringModifiers:@"ㅕ"
            isARepeat:NO
            keyCode:32];

        [collectedEvents removeAllObjects];
        [regionView keyDown:ctrlUEvent];

        check([collectedEvents count] == 1,
            [NSString stringWithFormat:@"TEST 13a: exactly 1 event for Ctrl+U (got %lu)", [collectedEvents count]]);
        if ([collectedEvents count] > 0) {
            NSString *eventStr = [collectedEvents objectAtIndex:0];
            BOOL hasKeyChar = [eventStr rangeOfString:@"\"key\":\"Char\""].location != NSNotFound;
            BOOL hasTextU = [eventStr rangeOfString:@"\"text\":\"u\""].location != NSNotFound;
            BOOL hasCtrl = [eventStr rangeOfString:@"\"ctrl\":true"].location != NSNotFound;
            check(hasKeyChar && hasTextU && hasCtrl,
                [NSString stringWithFormat:@"TEST 13a: Korean character payload maps by physical ANSI key (got: %@)", eventStr]);
        }

        sp_region_close(region13a);
    }

    // TEST 13b: unsupported physical Ctrl key reports the native key and received scalar
    {
        [collectedEvents removeAllObjects];

        void *region13b = sp_region_create(surface, "test13b", testEvent, NULL);
        sp_region_place(region13b, 10, 10, 10, 10, true);
        sp_region_focus(region13b);
        [collectedEvents removeAllObjects];

        id regionView = (id)region13b;
        NSEvent *unsupportedCtrlEvent = [NSEvent keyEventWithType:NSEventTypeKeyDown
            location:NSZeroPoint
            modifierFlags:NSEventModifierFlagControl
            timestamp:0
            windowNumber:0
            context:nil
            characters:@"ㅕ"
            charactersIgnoringModifiers:@"ㅕ"
            isARepeat:NO
            keyCode:104];

        [regionView keyDown:unsupportedCtrlEvent];

        check([collectedEvents count] == 1,
            [NSString stringWithFormat:@"TEST 13b: exactly 1 explicit error for unsupported Ctrl key (got %lu)", [collectedEvents count]]);
        if ([collectedEvents count] > 0) {
            NSString *eventStr = [collectedEvents objectAtIndex:0];
            BOOL isError = [eventStr rangeOfString:@"\"type\":\"error\""].location != NSNotFound;
            BOOL hasKeyCode = [eventStr rangeOfString:@"native keyCode=104"].location != NSNotFound;
            BOOL hasScalar = [eventStr rangeOfString:@"character=U+3155"].location != NSNotFound;
            BOOL noKeyFallback = [eventStr rangeOfString:@"\"type\":\"key\""].location == NSNotFound;
            check(isError && hasKeyCode && hasScalar && noKeyFallback,
                [NSString stringWithFormat:@"TEST 13b: unsupported Ctrl input reports its physical key and character without forwarding a substitute (got: %@)", eventStr]);
        }

        sp_region_close(region13b);
    }

    // TEST 14: 키 이벤트 - 일반 문자 'a'
    {
        [collectedEvents removeAllObjects];

        void *region14 = sp_region_create(surface, "test14", testEvent, NULL);
        sp_region_place(region14, 10, 10, 10, 10, true);
        sp_region_focus(region14);

        id regionView = (id)region14;
        NSEvent *aEvent = [NSEvent keyEventWithType:NSEventTypeKeyDown
            location:NSZeroPoint
            modifierFlags:0
            timestamp:0
            windowNumber:0
            context:nil
            characters:@"a"
            charactersIgnoringModifiers:@"a"
            isARepeat:NO
            keyCode:0];

        [collectedEvents removeAllObjects];
        [regionView keyDown:aEvent];
        [window makeFirstResponder:nil];

        BOOL noKeyEvent = YES;
        for (NSString *eventStr in collectedEvents) {
            if ([eventStr rangeOfString:@"\"type\":\"key\""].location != NSNotFound) noKeyEvent = NO;
        }
        check([committedTexts(0) isEqualToArray:@[@"a"]] && noKeyEvent,
            [NSString stringWithFormat:@"TEST 14: 'a' is committed once as text, not as a key event (got %@)", collectedEvents]);

        sp_region_close(region14);
    }

    // TEST 15: 키 이벤트 - Shift+Tab
    {
        [collectedEvents removeAllObjects];

        void *region15 = sp_region_create(surface, "test15", testEvent, NULL);
        sp_region_place(region15, 10, 10, 10, 10, true);
        sp_region_focus(region15);

        id regionView = (id)region15;
        NSEvent *backTabEvent = [NSEvent keyEventWithType:NSEventTypeKeyDown
            location:NSZeroPoint
            modifierFlags:NSEventModifierFlagShift
            timestamp:0
            windowNumber:0
            context:nil
            characters:@"\x19"  // NSBackTabCharacter
            charactersIgnoringModifiers:@"\x19"
            isARepeat:NO
            keyCode:48];

        [collectedEvents removeAllObjects];
        [regionView keyDown:backTabEvent];

        check([collectedEvents count] == 1,
            [NSString stringWithFormat:@"TEST 15: exactly 1 event for Shift+Tab (got %lu)", [collectedEvents count]]);
        if ([collectedEvents count] > 0) {
            NSString *eventStr = [collectedEvents objectAtIndex:0];
            BOOL hasKeyTab = [eventStr rangeOfString:@"\"key\":\"Tab\""].location != NSNotFound;
            BOOL hasShift = [eventStr rangeOfString:@"\"shift\":true"].location != NSNotFound;
            check(hasKeyTab && hasShift,
                [NSString stringWithFormat:@"TEST 15: event has key:Tab and shift:true (got: %@)", eventStr]);
        }

        sp_region_close(region15);
    }

    // TEST 16: 조합 중 Return - key 이벤트 없음
    {
        [collectedEvents removeAllObjects];

        void *region16 = sp_region_create(surface, "test16", testEvent, NULL);
        sp_region_place(region16, 10, 10, 10, 10, true);
        sp_region_focus(region16);

        id regionView = (id)region16;

        // 조합 시작
        [(id<NSTextInputClient>)regionView setMarkedText:@"ㅎ" selectedRange:NSMakeRange(1, 0) replacementRange:NSMakeRange(NSNotFound, 0)];
        [collectedEvents removeAllObjects];

        // 조합 중에 Return
        NSEvent *returnEvent = [NSEvent keyEventWithType:NSEventTypeKeyDown
            location:NSZeroPoint
            modifierFlags:0
            timestamp:0
            windowNumber:0
            context:nil
            characters:@"\r"
            charactersIgnoringModifiers:@"\r"
            isARepeat:NO
            keyCode:36];

        [regionView keyDown:returnEvent];

        BOOL foundKeyEvent = NO;
        for (NSString *eventStr in collectedEvents) {
            if ([eventStr rangeOfString:@"\"type\":\"key\""].location != NSNotFound) {
                foundKeyEvent = YES;
                break;
            }
        }
        check(!foundKeyEvent,
            [NSString stringWithFormat:@"TEST 16: no key event during composition (got %lu events)", [collectedEvents count]]);

        sp_region_close(region16);
    }

    // TEST 17: Command+C - key/insert 이벤트 없음
    {
        [collectedEvents removeAllObjects];

        void *region17 = sp_region_create(surface, "test17", testEvent, NULL);
        sp_region_place(region17, 10, 10, 10, 10, true);
        sp_region_focus(region17);

        id regionView = (id)region17;
        NSEvent *cmdCEvent = [NSEvent keyEventWithType:NSEventTypeKeyDown
            location:NSZeroPoint
            modifierFlags:NSEventModifierFlagCommand
            timestamp:0
            windowNumber:0
            context:nil
            characters:@"c"
            charactersIgnoringModifiers:@"c"
            isARepeat:NO
            keyCode:8];

        [collectedEvents removeAllObjects];
        [regionView keyDown:cmdCEvent];

        BOOL foundKeyOrInsert = NO;
        for (NSString *eventStr in collectedEvents) {
            if ([eventStr rangeOfString:@"\"type\":\"key\""].location != NSNotFound ||
                [eventStr rangeOfString:@"\"type\":\"insert\""].location != NSNotFound) {
                foundKeyOrInsert = YES;
                break;
            }
        }
        check(!foundKeyOrInsert,
            [NSString stringWithFormat:@"TEST 17: no key or insert event for Command+C (got %lu events)", [collectedEvents count]]);

        sp_region_close(region17);
    }

    // TEST 18: 클립 뷰가 SurfaceHost의 네이티브 평면 안에서 DOM 평면 아래에 있는지 확인
    {
        [collectedEvents removeAllObjects];

        void *region18 = sp_region_create(surface, "test18", testEvent, NULL);
        check(region18 != NULL, @"TEST 18: region created");

        sp_region_place(region18, 10, 10, 10, 10, true);

        NSView *regionView = (NSView *)region18;
        NSView *clipView = regionView.superview;
        check(clipView != nil && ![clipView isKindOfClass:[WKWebView class]],
            @"TEST 18: region has a non-WebView superview (clipView)");

        NSView *surfaceSuperSuperview = clipView.superview;
        check(surfaceSuperSuperview == nativePlane && nativePlane.superview == surface.superview,
            @"TEST 18: clipView is inside the surface host native plane");

        // SurfaceHost 내부에서는 DOM 웹뷰가 native plane 위에 있고,
        // 바깥 compositor에서 SurfaceHost 전체가 앱 DOM backing 위에 있다.
        NSArray *subviews = surface.superview.subviews;
        NSUInteger surfaceIndex = [subviews indexOfObject:surface];
        NSUInteger nativeIndex = [subviews indexOfObject:nativePlane];
        check(nativeIndex != NSNotFound && surfaceIndex != NSNotFound && nativeIndex < surfaceIndex,
            [NSString stringWithFormat:@"TEST 18: native plane is below DOM plane inside SurfaceHost (native:%lu, DOM:%lu)",
                (unsigned long)nativeIndex, (unsigned long)surfaceIndex]);

        sp_region_close(region18);
    }

    // TEST 19: 표시된 이미지의 scale이 실제 창 backing scale로 설정되는지 확인한다.
    {
        [collectedEvents removeAllObjects];
        void *region19 = sp_region_create(surface, "test19", testEvent, NULL);
        // 인셋을 크게 설정해서 영역 크기 = 대략 100x80이 되도록
        // 500 - 200 - 200 = 100, 400 - 160 - 160 = 80
        sp_region_place(region19, 200, 160, 200, 160, true);
        double raster19[3] = {0};
        CGFloat backingScale19 = window.backingScaleFactor;
        check(backingScale19 > 0, @"TEST 19: window reports a positive backing scale");
        check(sp_region_raster(region19, raster19), @"TEST 19: region reports its backing-scale raster");
        unsigned char nonce19[16];
        IOSurfaceRef testSurface19 = createColoredGlobalSurface((size_t)raster19[0], (size_t)raster19[1], nonce19);
        BOOL presented = sp_region_present(region19, IOSurfaceGetID(testSurface19), nonce19,
            raster19[0], raster19[1], raster19[2]);
        check(presented, @"TEST 19: image presented with scale 2");

        NSView *regionView = (NSView *)region19;
        NSView *clipView = regionView.superview;

        // SurfaceHost의 로컬 단위는 AppKit point이고 backing scale은 레이어에만
        // 적용한다. 100x80 point 영역은 raster에서 200x160 device pixel이다.
        double clipWidth = NSWidth(clipView.bounds);
        double clipHeight = NSHeight(clipView.bounds);
        check(clipWidth == 100 && clipHeight == 80,
            [NSString stringWithFormat:@"TEST 19: clipView bounds are point units (expected 100x80, got %.0f x%.0f)",
                clipWidth, clipHeight]);

        // imageLayer의 bounds도 마찬가지
        CALayer *imageLayer = [regionView.layer.sublayers firstObject];
        double layerWidth = NSWidth(imageLayer.bounds);
        double layerHeight = NSHeight(imageLayer.bounds);
        check(layerWidth == 100 && layerHeight == 80,
            [NSString stringWithFormat:@"TEST 19: imageLayer bounds are point units (expected 100x80, got %.0f x%.0f)",
                layerWidth, layerHeight]);

        check(fabs(imageLayer.contentsScale - backingScale19) < 0.000001,
            [NSString stringWithFormat:@"TEST 19: contentsScale is the window backing scale %g (got %g)",
                backingScale19, imageLayer.contentsScale]);

        sp_region_close(region19);
        CFRelease(testSurface19);
    }

    // TEST 20: 영역의 wanted 플래그가 작동한다
    {
        [collectedEvents removeAllObjects];

        void *region20 = sp_region_create(surface, "test20", testEvent, NULL);
        sp_region_place(region20, 10, 10, 10, 10, true);  // visible=true

        NSView *regionView = (NSView *)region20;
        check(!regionView.isHidden, @"TEST 20: region is visible initially");

        // 영역을 숨기기 위해 placement를 업데이트한다 (visible=false)
        sp_region_place(region20, 10, 10, 10, 10, false);

        check(regionView.isHidden,
            @"TEST 20: region is hidden when placed with visible=false");

        // 다시 표시한다
        sp_region_place(region20, 10, 10, 10, 10, true);

        check(!regionView.isHidden,
            @"TEST 20: region is visible again when placed with visible=true");

        sp_region_close(region20);
    }

    // TEST 21: SurfaceHost의 장치 픽셀 좌표에서 그림 한 픽셀은 장치 한 픽셀이다.
    {
        void *region21 = sp_region_create(surface, "test21", testEvent, NULL);
        sp_region_place(region21, 0, 0, 0, 0, true);
        double raster21[3] = {0};
        check(sp_region_raster(region21, raster21), @"TEST 21: full region reports its native raster");
        size_t pixelWidth = (size_t)raster21[0], pixelHeight = (size_t)raster21[1];
        unsigned char nonce21[16];
        IOSurfaceRef testSurface21 = createColoredGlobalSurface(pixelWidth, pixelHeight, nonce21);
        bool presented = sp_region_present(region21, IOSurfaceGetID(testSurface21), nonce21,
            pixelWidth, pixelHeight, raster21[2]);
        check(presented, @"TEST 21: image is presented in SurfaceHost coordinates");

        NSView *regionView = (NSView *)region21;
        CALayer *imageLayer = regionView.layer.sublayers.firstObject;
        CGFloat shownPixels = NSWidth([regionView convertRectToBacking:regionView.bounds]);
        CGFloat layerPixels = NSWidth(imageLayer.bounds) * imageLayer.contentsScale;
        check(shownPixels == pixelWidth && layerPixels == pixelWidth,
            [NSString stringWithFormat:@"TEST 21: region covers %zu device pixels and the layer maps them one to one (region %g, layer %g)",
                pixelWidth, shownPixels, layerPixels]);

        sp_region_close(region21);
        CFRelease(testSurface21);
    }

    // TEST 22: 숨겨진 표면에서 배치한 영역은 표면을 다시 표시하면 함께 표시된다.
    {
        void *region22 = sp_region_create(surface, "test22", testEvent, NULL);
        [surface setHidden:YES];
        sp_region_place(region22, 10, 10, 10, 10, true);
        NSView *regionView = (NSView *)region22;
        check(!regionView.hidden, @"TEST 22: region keeps its wanted visibility while its surface is hidden");
        [surface setHidden:NO];
        check(!regionView.isHiddenOrHasHiddenAncestor,
            @"TEST 22: region becomes visible when its surface is shown again");
        sp_region_close(region22);
    }

    // TEST 22: 창 배율과 다른 배율로 그린 그림은 표시하지 않는다(글자 크기가 틀어진다).
    {
        [collectedEvents removeAllObjects];
        void *region22 = sp_region_create(surface, "test22", testEvent, NULL);
        sp_region_place(region22, 0, 0, 0, 0, true);
        double raster22[3] = {0};
        check(sp_region_raster(region22, raster22), @"TEST 22: full region reports its native raster");
        unsigned char nonce22[16];
        IOSurfaceRef testSurface22 = createColoredGlobalSurface((size_t)raster22[0], (size_t)raster22[1], nonce22);
        bool presented = sp_region_present(region22, IOSurfaceGetID(testSurface22), nonce22,
            raster22[0], raster22[1], raster22[2] + 1);
        BOOL reported = NO;
        for (NSString *event in collectedEvents) if ([event containsString:@"\"reason\":\"scale\""]) reported = YES;
        check(!presented && reported, @"TEST 22: an image drawn at another scale is refused with reason scale");
        const char *failedFacts = sp_region_facts(region22);
        check(failedFacts && strstr(failedFacts, "\"error\":\"scale\""),
            @"TEST 22: host facts retain the actual presentation error");
        free((void *)failedFacts);
        check(sp_region_present(region22, IOSurfaceGetID(testSurface22), nonce22,
            raster22[0], raster22[1], raster22[2]), @"TEST 22: a valid frame presents after an error");
        const char *recoveredFacts = sp_region_facts(region22);
        check(recoveredFacts && strstr(recoveredFacts, "\"error\":null"),
            @"TEST 22: only successful presentation clears the error");
        free((void *)recoveredFacts);
        sp_region_close(region22);
        CFRelease(testSurface22);
    }

    // 바깥 표면을 바꾼 직후, 페이지 배치 통보 없이 영역과 래스터가 같은 크기여야 한다.
    {
        void *region = sp_region_create(surface, "fractional-resize", testEvent, NULL);
        sp_region_place(region, 0, 0, 0, 0, true);
        const double widths[] = { 597.5, 96, 751.5, 598, 96.5, 800 };
        for (size_t n = 0; n < sizeof(widths)/sizeof(widths[0]); n++) {
            webviewSetFrame(surface, 7.5, 33, widths[n], 286.5);
            double outer[4] = {0}, inner[6] = {0}, raster[3] = {0};
            webviewGetFrame(surface, outer);
            sp_region_frame(region, inner);
            check(inner[2] == outer[2] && inner[3] == outer[3],
                @"fractional resize: native region follows the prepared outer surface synchronously");
            check(sp_region_raster(region, raster) && raster[0] == round(outer[2]*raster[2])
                && raster[1] == round(outer[3]*raster[2]),
                @"fractional resize: raster dimensions match the actual native frame");
        }
        sp_region_close(region);
    }

    // Edit 메뉴의 붙여넣기는 입력기 문서가 아니라 페이지의 붙여넣기 명령으로 간다(V5-42).
    {
        void *region = sp_region_create(surface, "edit-actions", testEvent, NULL);
        sp_region_place(region, 0, 0, 0, 0, true);
        NSTextView *regionView = (NSTextView *)region;
        NSUInteger before = collectedEvents.count;
        [NSApp sendAction:@selector(paste:) to:regionView from:nil];
        [NSApp sendAction:@selector(pasteAsPlainText:) to:regionView from:nil];
        NSArray *reported = [collectedEvents subarrayWithRange:NSMakeRange(before, collectedEvents.count - before)];
        check([reported isEqualToArray:@[@"{\"type\":\"action\",\"name\":\"paste\"}", @"{\"type\":\"action\",\"name\":\"paste\"}"]]
            && regionView.textStorage.length == 0,
            [NSString stringWithFormat:@"edit actions: paste reports one paste action and leaves the input document empty (got %@)", reported]);
        // 복사는 터미널 선택을 복사하는 페이지 명령으로 가며, 입력기 문서를 페이스트보드에 쓰지 않는다.
        NSInteger changes = NSPasteboard.generalPasteboard.changeCount;
        NSUInteger beforeCopy = collectedEvents.count;
        [NSApp sendAction:@selector(copy:) to:regionView from:nil];
        NSArray *copied = [collectedEvents subarrayWithRange:NSMakeRange(beforeCopy, collectedEvents.count - beforeCopy)];
        check([copied isEqualToArray:@[@"{\"type\":\"action\",\"name\":\"copy\"}"]]
            && NSPasteboard.generalPasteboard.changeCount == changes,
            [NSString stringWithFormat:@"edit actions: copy reports one copy action and leaves the pasteboard unchanged (got %@)", copied]);
        NSMenuItem *item = [[[NSMenuItem alloc] initWithTitle:@"" action:@selector(copy:) keyEquivalent:@""] autorelease];
        check([regionView validateMenuItem:item], @"edit actions: Copy is enabled for a terminal region");
        item.action = @selector(paste:);
        check([regionView validateMenuItem:item], @"edit actions: Paste is enabled for a terminal region");
        for (NSString *name in @[@"cut:", @"selectAll:", @"delete:"]) {
            item.action = NSSelectorFromString(name);
            check(![regionView validateMenuItem:item],
                [NSString stringWithFormat:@"edit actions: %@ is disabled for a terminal region", name]);
        }
        sp_region_close(region);
    }

    // 첫 배치를 받지 않은 표면의 영역은 래스터 크기가 없고, 표면이 배치되지 않았다고 알린다.
    // 표면이 배치되면 두 값이 함께 생긴다.
    {
        WKWebView *unplaced = [[[WKWebView alloc] initWithFrame:NSZeroRect] autorelease];
        [window.contentView addSubview:unplaced];
        webviewAttachSurface(unplaced, main);
        void *region = sp_region_create(unplaced, "unplaced", testEvent, NULL);
        sp_region_place(region, 0, 0, 0, 0, true);
        double raster[3] = {0};
        check(!sp_region_raster(region, raster) && !sp_region_surface_placed(region),
            @"unplaced surface: a shown region has no raster geometry and reports its surface as not placed");
        webviewSetFrame(unplaced, 0, 0, 200, 100);
        CGFloat backingScale = window.backingScaleFactor;
        double expectedWidth = 200 * backingScale;
        double expectedHeight = 100 * backingScale;
        check(sp_region_raster(region, raster) && sp_region_surface_placed(region)
            && raster[0] == expectedWidth && raster[1] == expectedHeight,
            [NSString stringWithFormat:@"unplaced surface: placing the surface gives the region a %.0fx%.0f raster (got %.0fx%.0f)",
                expectedWidth, expectedHeight, raster[0], raster[1]]);
        sp_region_close(region);
    }

    // 영역 프레임 안의 포인터 눌림은 터미널 초점 상실로 보고되지 않는다. 포인터는 이 뷰를 뚫고
    // 페이지로 가므로(hitTest 가 nil) WebKit 이 눌린 웹뷰를 첫 응답자로 만들고, 페이지의 포커스
    // 명령이 영역으로 되돌린다. 그 왕복의 resign 을 ?1004 자식에게 보고하면 자식이 진행 중인
    // 드래그를 취소하므로, 눌림 지점이 영역 안일 때의 resign 은 초점 변화가 아니다.
    if (activation) {
        void *region15 = sp_region_create(surface, "test15", testEvent, NULL);
        sp_region_place(region15, 100, 150, 100, 50, true);
        sp_region_focus(region15);
        check(window.firstResponder == (NSResponder *)region15,
            @"press focus: the focused region starts as the window first responder");
        [collectedEvents removeAllObjects];

        [NSApp activateIgnoringOtherApps:YES];
        [window makeKeyAndOrderFront:nil];
        NSView *regionView15 = (NSView *)region15;
        NSRect frame15 = [regionView15 convertRect:regionView15.bounds toView:nil];
        NSPoint inside15 = NSMakePoint(NSMidX(frame15), NSMidY(frame15));
        NSEvent *down15 = [NSEvent mouseEventWithType:NSEventTypeLeftMouseDown location:inside15
            modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber
            context:nil eventNumber:1 clickCount:1 pressure:1];
        NSEvent *up15 = [NSEvent mouseEventWithType:NSEventTypeLeftMouseUp location:inside15
            modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber
            context:nil eventNumber:1 clickCount:1 pressure:0];
        [NSApp postEvent:down15 atStart:NO];
        [NSApp postEvent:up15 atStart:NO];
        NSDate *drain15 = [NSDate dateWithTimeIntervalSinceNow:2.0];
        while ([drain15 timeIntervalSinceNow] > 0) {
            NSEvent *pending = [NSApp nextEventMatchingMask:NSEventMaskAny untilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]
                inMode:NSDefaultRunLoopMode dequeue:YES];
            if (pending) [NSApp sendEvent:pending];
        }

        BOOL reportedLoss15 = NO;
        for (NSString *eventStr in collectedEvents) {
            if ([eventStr rangeOfString:@"\"type\":\"focus\""].location != NSNotFound &&
                [eventStr rangeOfString:@"\"focused\":false"].location != NSNotFound) reportedLoss15 = YES;
        }
        check(!reportedLoss15,
            [NSString stringWithFormat:@"press focus: a pointer press inside the region frame does not report a focus loss (events %@)",
                collectedEvents]);
        check(window.firstResponder == (NSResponder *)region15,
            @"press focus: the pass-through press does not leave the page webview holding the terminal responder");

        // 영역 밖 눌림은 실제 초점 이동이므로 그대로 보고한다. 과억제 방지 대조군이다.
        [collectedEvents removeAllObjects];
        NSPoint outside15 = NSMinX(frame15) - 40 > 0 ? NSMakePoint(NSMinX(frame15) - 40, NSMidY(frame15))
            : NSMakePoint(NSMaxX(frame15) + 40, NSMidY(frame15));
        NSEvent *downOut15 = [NSEvent mouseEventWithType:NSEventTypeLeftMouseDown location:outside15
            modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber
            context:nil eventNumber:2 clickCount:1 pressure:1];
        NSEvent *upOut15 = [NSEvent mouseEventWithType:NSEventTypeLeftMouseUp location:outside15
            modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber
            context:nil eventNumber:2 clickCount:1 pressure:0];
        [NSApp postEvent:downOut15 atStart:NO];
        [NSApp postEvent:upOut15 atStart:NO];
        NSDate *drainOut15 = [NSDate dateWithTimeIntervalSinceNow:2.0];
        while ([drainOut15 timeIntervalSinceNow] > 0) {
            NSEvent *pending = [NSApp nextEventMatchingMask:NSEventMaskAny untilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]
                inMode:NSDefaultRunLoopMode dequeue:YES];
            if (pending) [NSApp sendEvent:pending];
        }
        BOOL reportedOutsideLoss15 = NO;
        for (NSString *eventStr in collectedEvents) {
            if ([eventStr rangeOfString:@"\"type\":\"focus\""].location != NSNotFound &&
                [eventStr rangeOfString:@"\"focused\":false"].location != NSNotFound) reportedOutsideLoss15 = YES;
        }
        check(reportedOutsideLoss15,
            @"press focus: a pointer press outside the region frame still reports the focus loss");

        sp_region_close(region15);
    }

    // 영역 A에 초점이 있는 상태에서 다른 영역 B의 프레임 안을 누르면, 눌림은 B 를 뚫고 페이지
    // 웹뷰로 가며 NSWindow 가 웹뷰를 첫 응답자로 만든다. 이 창 동안 페이지가 키보드 초점을
    // 얻어 activeElement 인 브라우저 주소창에 focus 가 재발화된다(V5-114 의 도약). 올바른
    // 동작: A 는 초점 상실을 보고하고(실제 전이다) 응답자는 B 로 곧바로 옮겨간다 — 페이지
    // 웹뷰가 응답자를 가진 창이 없어야 한다.
    if (activation) {
        // 앞 구간의 마지막 mouse-up 이 대기열에 남아 이 구간 도중에 처리되면 응답자 전환이
        // 눌림이 아닌 뗌 중에 일어난다. 눌림 중의 전환만 재기 위해 대기열을 먼저 비운다.
        while (YES) {
            NSEvent *pending = [NSApp nextEventMatchingMask:NSEventMaskAny
                untilDate:[NSDate dateWithTimeIntervalSinceNow:0.1] inMode:NSDefaultRunLoopMode dequeue:YES];
            if (!pending) break;
            [NSApp sendEvent:pending];
        }
        void *regionA16 = sp_region_create(surface, "testA16", testEvent, (void *)1);
        void *regionB16 = sp_region_create(surface, "testB16", testEvent, (void *)2);
        // 배치 인자는 인셋(left, top, right, bottom)이다. B 는 test15 와 같은 자리(눌림 라우팅이
        // 검증된 좌표), A 는 아래쪽 띠로 겹치지 않게 나눈다.
        sp_region_place(regionA16, 100, 20, 100, 340, true);
        sp_region_place(regionB16, 100, 150, 100, 50, true);
        // 활성화·선행 창을 먼저 마친 뒤 A 에 초점을 둔다 — 활성화가 응답자를 다시 정하면
        // A 의 resign 이 눌림이 아닌 곳에서 일어나 재현이 흐트러진다.
        [NSApp activateIgnoringOtherApps:YES];
        [window makeKeyAndOrderFront:nil];
        NSDate *settleB16 = [NSDate dateWithTimeIntervalSinceNow:0.3];
        while ([settleB16 timeIntervalSinceNow] > 0) {
            NSEvent *pending = [NSApp nextEventMatchingMask:NSEventMaskAny
                untilDate:[NSDate dateWithTimeIntervalSinceNow:0.05] inMode:NSDefaultRunLoopMode dequeue:YES];
            if (pending) [NSApp sendEvent:pending];
        }
        sp_region_focus(regionA16);
        check(window.firstResponder == (NSResponder *)regionA16,
            @"press focus A->B: region A starts as the window first responder");
        [collectedEvents removeAllObjects];

        NSView *regionViewB16 = (NSView *)regionB16;
        NSRect frameB16 = [regionViewB16 convertRect:regionViewB16.bounds toView:nil];
        NSPoint insideB16 = NSMakePoint(NSMidX(frameB16), NSMidY(frameB16));
        NSEvent *downB16 = [NSEvent mouseEventWithType:NSEventTypeLeftMouseDown location:insideB16
            modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber
            context:nil eventNumber:3 clickCount:1 pressure:1];
        NSEvent *upB16 = [NSEvent mouseEventWithType:NSEventTypeLeftMouseUp location:insideB16
            modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber
            context:nil eventNumber:3 clickCount:1 pressure:0];
        [NSApp postEvent:downB16 atStart:NO];
        [NSApp postEvent:upB16 atStart:NO];
        NSDate *drainB16 = [NSDate dateWithTimeIntervalSinceNow:2.0];
        while ([drainB16 timeIntervalSinceNow] > 0) {
            NSEvent *pending = [NSApp nextEventMatchingMask:NSEventMaskAny untilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]
                inMode:NSDefaultRunLoopMode dequeue:YES];
            if (pending) [NSApp sendEvent:pending];
        }
        // 비동기 반환(makeFirstResponder) 이 흐르도록 대기열을 한 번 더 돈다.
        NSDate *drainB16b = [NSDate dateWithTimeIntervalSinceNow:0.3];
        while ([drainB16b timeIntervalSinceNow] > 0) {
            NSEvent *pending = [NSApp nextEventMatchingMask:NSEventMaskAny untilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]
                inMode:NSDefaultRunLoopMode dequeue:YES];
            if (pending) [NSApp sendEvent:pending];
        }

        BOOL reportedA16Loss = NO;
        BOOL reportedB16Gain = NO;
        for (NSString *eventStr in eventsA16) {
            if ([eventStr rangeOfString:@"\"focused\":false"].location != NSNotFound) reportedA16Loss = YES;
        }
        for (NSString *eventStr in eventsB16) {
            if ([eventStr rangeOfString:@"\"focused\":true"].location != NSNotFound) reportedB16Gain = YES;
        }
        check(reportedA16Loss,
            [NSString stringWithFormat:@"press focus A->B: region A reports its focus loss (A events %@ B events %@)", eventsA16, eventsB16]);
        NSString *who = window.firstResponder == (NSResponder *)regionA16 ? @"A"
            : (window.firstResponder == (NSResponder *)regionB16 ? @"B" : @"other");
        check(window.firstResponder == (NSResponder *)regionB16,
            [NSString stringWithFormat:@"press focus A->B: the responder moves to the pressed region B, not the page webview (responder %@ at point %@)",
                who, NSStringFromPoint(insideB16)]);
        check(reportedB16Gain,
            [NSString stringWithFormat:@"press focus A->B: region B reports its focus gain (events %@)", collectedEvents]);
        sp_region_close(regionA16);
        sp_region_close(regionB16);
    }

    [window close];
    [window release];

    return failures ? 1 : 0;
}}
