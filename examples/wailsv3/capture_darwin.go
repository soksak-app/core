//go:build darwin

package main

// 이 애플리케이션의 창을 스스로 녹화한다.
//
// 윈도 서버가 페이지와 표면과 모달을 합성하므로, 측정 대상은 그 합성 결과다. 한 장씩
// 요청하는 스크린샷은 요청 시점에 맞춰 만들어진 합성을 반환하므로, 리사이즈와 다음
// 렌더 사이의 한 프레임짜리 상태는 담기지 않는다. 스트림은 합성기가 표시한 프레임을
// 그대로 전달한다.
//
// CGWindowListCreateImage 는 macOS 15 부터 컴파일이 거부된다. ScreenCaptureKit 이
// 대체 인터페이스다.

/*
#cgo CFLAGS: -x objective-c -fmodules
#cgo LDFLAGS: -framework Cocoa -framework ScreenCaptureKit -framework CoreGraphics  -framework CoreMedia -framework CoreVideo
#import <Cocoa/Cocoa.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>

// 프레임을 받아 파일로 적는다. 프레임이 메시지로 전달되므로 수신 객체가 필요하다.
@interface SPCapture : NSObject <SCStreamOutput, SCStreamDelegate>
@property (nonatomic, copy) NSString* directory;
@property (nonatomic) int written;
@end

@implementation SPCapture

- (void)stream:(SCStream*)stream
    didOutputSampleBuffer:(CMSampleBufferRef)sample
                   ofType:(SCStreamOutputType)type {
    if (type != SCStreamOutputTypeScreen) return;
    CVImageBufferRef buffer = CMSampleBufferGetImageBuffer(sample);
    if (buffer == NULL) return;
    // 프레임을 원시 데이터 그대로 적는다. 여기서 인코딩하면 그 시간 동안 프레임이
    // 버려지고, 버려진 프레임이 측정 대상이다.
    CVPixelBufferLockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly);
    size_t width = CVPixelBufferGetWidth(buffer);
    size_t height = CVPixelBufferGetHeight(buffer);
    size_t stride = CVPixelBufferGetBytesPerRow(buffer);
    const uint8_t* base = (const uint8_t*)CVPixelBufferGetBaseAddress(buffer);
    if (base != NULL) {
        NSString* path = [self.directory stringByAppendingPathComponent:
            [NSString stringWithFormat:@"frame-%04d.bgra", ++self.written]];
        FILE* file = fopen(path.UTF8String, "wb");
        if (file != NULL) {
            uint32_t head[3] = { (uint32_t)width, (uint32_t)height, (uint32_t)stride };
            fwrite(head, sizeof(head), 1, file);
            fwrite(base, stride, height, file);
            fclose(file);
        }
    }
    CVPixelBufferUnlockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly);
}

- (void)stream:(SCStream*)stream didStopWithError:(NSError*)error {
    NSLog(@"observe: capture stopped, %@", error.localizedDescription);
}

@end

// 모든 캡처가 사용하는 값. 윈도 서버의 창 목록 조회가 프레임 한 장보다 훨씬 느리므로
// 한 번만 조회한다.
static SCContentFilter* captureFilter = nil;
static SCStreamConfiguration* captureConfig = nil;
static SCStream* captureStream = nil;
static SPCapture* captureSink = nil;

// captureOpen 은 창을 조회해 캡처에 필요한 값을 보관한다. 조회는 비동기이므로 그
// 전에 시작한 캡처는 아무 일도 하지 않는다.
static void captureOpen(long windowNumber) {
    [SCShareableContent getShareableContentWithCompletionHandler:
        ^(SCShareableContent* content, NSError* error) {
        if (error != nil) {
            NSLog(@"observe: no screen recording permission, %@", error.localizedDescription);
            return;
        }
        for (SCWindow* window in content.windows) {
            if ((long)window.windowID != windowNumber) continue;
            captureFilter =
                [[SCContentFilter alloc] initWithDesktopIndependentWindow:window];
            SCStreamConfiguration* config = [[SCStreamConfiguration alloc] init];
            // 점 단위로 받는다. 픽셀 단위는 한 프레임이 네 배가 되어 적는 동안
            // 프레임이 버려진다.
            config.width = (size_t)window.frame.size.width;
            config.height = (size_t)window.frame.size.height;
            config.pixelFormat = kCVPixelFormatType_32BGRA;
            config.showsCursor = NO;
            config.captureResolution = SCCaptureResolutionBest;
            // 화면이 갱신되는 만큼 받는다. 변경이 없으면 프레임도 오지 않는다.
            config.minimumFrameInterval = CMTimeMake(1, 120);
            config.queueDepth = 8;
            captureConfig = config;
            return;
        }
        NSLog(@"observe: window %ld not found", windowNumber);
    }];
}

static void captureStart(const char* directory) {
    if (captureFilter == nil || captureStream != nil) return;
    captureSink = [[SPCapture alloc] init];
    captureSink.directory = [NSString stringWithUTF8String:directory];
    captureStream = [[SCStream alloc] initWithFilter:captureFilter
                                       configuration:captureConfig
                                            delegate:captureSink];
    NSError* error = nil;
    [captureStream addStreamOutput:captureSink
                              type:SCStreamOutputTypeScreen
                sampleHandlerQueue:dispatch_queue_create("sp.capture", NULL)
                             error:&error];
    if (error != nil) {
        NSLog(@"observe: capture output not added, %@", error.localizedDescription);
        captureStream = nil;
        return;
    }
    [captureStream startCaptureWithCompletionHandler:^(NSError* failed) {
        if (failed != nil) NSLog(@"observe: capture not started, %@", failed.localizedDescription);
    }];
}

static int captureStop(void) {
    if (captureStream == nil) return 0;
    SCStream* stream = captureStream;
    captureStream = nil;
    int written = captureSink.written;
    [stream stopCaptureWithCompletionHandler:^(NSError* failed) {
        if (failed != nil) NSLog(@"observe: capture not stopped, %@", failed.localizedDescription);
    }];
    return written;
}
*/
import "C"

import "unsafe"

func captureOpen(windowNumber int) { C.captureOpen(C.long(windowNumber)) }

func captureStart(directory string) {
	where := C.CString(directory)
	defer C.free(unsafe.Pointer(where))
	C.captureStart(where)
}

func captureStop() int { return int(C.captureStop()) }
