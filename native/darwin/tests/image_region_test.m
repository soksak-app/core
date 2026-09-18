#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <IOSurface/IOSurface.h>
#import "image_region.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// 이벤트를 JSON 형태로 모은다
static NSMutableArray *collectedEvents = nil;

static void testEvent(void *context, const char *json) {
    if (!collectedEvents) collectedEvents = [NSMutableArray new];
    [collectedEvents addObject:[NSString stringWithUTF8String:json]];
}

// 네 모서리를 다른 색으로 칠한 전역 IOSurface를 만든다
static IOSurfaceRef createColoredGlobalSurface(size_t width, size_t height, unsigned char *nonce) {
    IOSurfaceRef surface = IOSurfaceCreate((CFDictionaryRef)@{
        (id)kIOSurfaceWidth: @(width),
        (id)kIOSurfaceHeight: @(height),
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

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];

    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 500, 400)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    WKWebView *surface = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 500, 400)] autorelease];
    surface.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    window.contentView = surface;
    [window orderBack:nil];

    // TEST 1: 방향·크기 - 레이어 속성과 표면 ID 확인
    {
        [collectedEvents removeAllObjects];
        unsigned char nonce1[16];
        IOSurfaceRef testSurface1 = createColoredGlobalSurface(100, 100, nonce1);
        check(testSurface1 != NULL, @"TEST 1: IOSurface created with global flag");

        IOSurfaceID sid1 = IOSurfaceGetID(testSurface1);

        void *region1 = sp_region_create(surface, "test1", testEvent, NULL);
        check(region1 != NULL, @"TEST 1: region created");

        sp_region_place(region1, 10, 20, 30, 40, true);
        BOOL presented = sp_region_present(region1, sid1, nonce1, 100, 100);
        check(presented, @"TEST 1: sp_region_present succeeded");

        // 레이어를 찾아서 속성을 확인한다
        NSView *regionView = (NSView *)region1;
        // 구현에서 imageLayer는 SPImageRegion의 sublayer
        NSArray *sublayers = regionView.layer.sublayers;
        CALayer *imageLayer = [sublayers firstObject];
        check(imageLayer != NULL, @"TEST 1: image layer found");

        if (imageLayer) {
            IOSurfaceRef layerSurface = (IOSurfaceRef)imageLayer.contents;
            IOSurfaceID layerSurfaceID = IOSurfaceGetID(layerSurface);
            check(layerSurfaceID == sid1,
                [NSString stringWithFormat:@"TEST 1: layer surface ID matches (%u == %u)", layerSurfaceID, sid1]);

            check(imageLayer.contentsScale == 1,
                [NSString stringWithFormat:@"TEST 1: contentsScale is 1 (got %g)", imageLayer.contentsScale]);

            check([imageLayer.contentsGravity isEqualToString:kCAGravityTopLeft],
                [NSString stringWithFormat:@"TEST 1: contentsGravity is TopLeft (got %@)", imageLayer.contentsGravity]);

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
        BOOL presented = sp_region_present(region2, sid2, wrongNonce, 100, 100);
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
        BOOL presented = sp_region_present(region3, 0xdeadbeef, nonce3, 100, 100);
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
        BOOL presented = sp_region_present(region4, sid4, nonce4, 200, 200);  // 잘못된 크기
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
        unsigned char nonce5[16];
        IOSurfaceRef testSurface5 = createColoredGlobalSurface(100, 100, nonce5);
        IOSurfaceID sid5 = IOSurfaceGetID(testSurface5);

        void *region5 = sp_region_create(surface, "test5", testEvent, NULL);
        sp_region_place(region5, 50, 60, 70, 80, true);
        sp_region_present(region5, sid5, nonce5, 100, 100);

        double frame[6] = {0};
        sp_region_frame(region5, frame);
        // 초기: 500x400, 여백 L:50, T:60, R:70, B:80 → 실제 크기: 500-50-70=380, 400-60-80=260
        check(frame[0] == 50 && frame[1] == 60 && frame[2] == 380 && frame[3] == 260,
            [NSString stringWithFormat:@"TEST 5: initial frame has correct insets (%.0f, %.0f, %.0f, %.0f)",
                frame[0], frame[1], frame[2], frame[3]]);

        // 창 크기를 바꾼다
        [window setContentSize:NSMakeSize(600, 500)];
        // 위도우의 contentView가 자동으로 크기 조정되지 않을 수 있으므로 명시적으로 설정한다
        [surface setFrame:NSMakeRect(0, 0, 600, 500)];
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

        sp_region_close(region5);
        CFRelease(testSurface5);
    }

    // TEST 6: 포인터 통과 - hitTest이 nil 반환
    {
        [collectedEvents removeAllObjects];
        unsigned char nonce6[16];
        IOSurfaceRef testSurface6 = createColoredGlobalSurface(100, 100, nonce6);
        IOSurfaceID sid6 = IOSurfaceGetID(testSurface6);

        void *region6 = sp_region_create(surface, "test6", testEvent, NULL);
        sp_region_place(region6, 10, 10, 10, 10, true);
        sp_region_present(region6, sid6, nonce6, 100, 100);

        NSView *regionView = (NSView *)region6;
        NSPoint testPoint = NSMakePoint(20, 20);  // 영역 내의 점
        NSView *hitView = [regionView hitTest:testPoint];
        check(hitView == nil, @"TEST 6: hitTest returns nil for point inside region");

        sp_region_close(region6);
        CFRelease(testSurface6);
    }

    // TEST 7: 초점 - focus 이벤트 및 hasFocus 상태
    {
        [collectedEvents removeAllObjects];
        unsigned char nonce7[16];
        IOSurfaceRef testSurface7 = createColoredGlobalSurface(100, 100, nonce7);
        IOSurfaceID sid7 = IOSurfaceGetID(testSurface7);

        void *region7 = sp_region_create(surface, "test7", testEvent, NULL);
        sp_region_place(region7, 10, 10, 10, 10, true);
        sp_region_present(region7, sid7, nonce7, 100, 100);

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
        CFRelease(testSurface7);
    }

    // TEST 8: IME 순서 및 markedText 상태
    {
        [collectedEvents removeAllObjects];
        unsigned char nonce8[16];
        IOSurfaceRef testSurface8 = createColoredGlobalSurface(100, 100, nonce8);
        IOSurfaceID sid8 = IOSurfaceGetID(testSurface8);

        void *region8 = sp_region_create(surface, "test8", testEvent, NULL);
        sp_region_place(region8, 10, 10, 10, 10, true);
        sp_region_present(region8, sid8, nonce8, 100, 100);
        sp_region_focus(region8);

        [collectedEvents removeAllObjects];  // focus 이벤트 제거

        id regionView = (id)region8;
        // setMarkedText를 두 번 호출
        [(id<NSTextInputClient>)regionView setMarkedText:@"한" selectedRange:NSMakeRange(1, 0) replacementRange:NSMakeRange(NSNotFound, 0)];
        [(id<NSTextInputClient>)regionView setMarkedText:@"한글" selectedRange:NSMakeRange(2, 0) replacementRange:NSMakeRange(NSNotFound, 0)];
        [(id<NSTextInputClient>)regionView insertText:@"한글" replacementRange:NSMakeRange(NSNotFound, 0)];

        // 이벤트 순서: compose, compose, insert
        check([collectedEvents count] >= 3,
            [NSString stringWithFormat:@"TEST 8: at least 3 events (got %lu)", [collectedEvents count]]);

        if ([collectedEvents count] >= 3) {
            BOOL hasCompose1 = [[collectedEvents objectAtIndex:0] rangeOfString:@"\"type\":\"compose\""].location != NSNotFound;
            BOOL hasCompose2 = [[collectedEvents objectAtIndex:1] rangeOfString:@"\"type\":\"compose\""].location != NSNotFound;
            BOOL hasInsert = [[collectedEvents objectAtIndex:2] rangeOfString:@"\"type\":\"insert\""].location != NSNotFound;
            check(hasCompose1 && hasCompose2 && hasInsert, @"TEST 8: events are compose, compose, insert");
        }

        // doCommandBySelector 호출 (이벤트 증가 없음)
        int eventCountBefore = [collectedEvents count];
        [(id<NSTextInputClient>)regionView doCommandBySelector:@selector(deleteForward:)];
        int eventCountAfter = [collectedEvents count];
        check(eventCountBefore == eventCountAfter,
            [NSString stringWithFormat:@"TEST 8: doCommandBySelector doesn't create event (%d -> %d)",
                eventCountBefore, eventCountAfter]);

        sp_region_close(region8);
        CFRelease(testSurface8);
    }

    // TEST 9: 접근성 및 캐럿
    {
        [collectedEvents removeAllObjects];
        unsigned char nonce9[16];
        IOSurfaceRef testSurface9 = createColoredGlobalSurface(100, 100, nonce9);
        IOSurfaceID sid9 = IOSurfaceGetID(testSurface9);

        void *region9 = sp_region_create(surface, "test9", testEvent, NULL);
        sp_region_place(region9, 10, 10, 10, 10, true);
        sp_region_present(region9, sid9, nonce9, 100, 100);

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
        CFRelease(testSurface9);
    }

    [window close];
    [window release];

    return failures ? 1 : 0;
}}
