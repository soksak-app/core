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

static dispatch_semaphore_t captureFirstFrame;
static dispatch_queue_t captureQueue;
static int captureBefore;

// 프레임을 받아 파일로 적는다. 프레임이 메시지로 전달되므로 수신 객체가 필요하다.
@interface SPCapture : NSObject <SCStreamOutput, SCStreamDelegate>
@property (nonatomic, copy) NSString* directory;
@property (nonatomic) int written;
@property (nonatomic) int idle;
@end

// frameStatus 는 프레임에 붙은 상태를 읽는다. 상태가 없으면 완성된 프레임으로 본다.
static SCFrameStatus frameStatus(CMSampleBufferRef sample) {
    CFArrayRef list = CMSampleBufferGetSampleAttachmentsArray(sample, false);
    if (list == NULL || CFArrayGetCount(list) == 0) return SCFrameStatusComplete;
    CFDictionaryRef attached = CFArrayGetValueAtIndex(list, 0);
    CFNumberRef status =
        CFDictionaryGetValue(attached, (__bridge CFStringRef)SCStreamFrameInfoStatus);
    if (status == NULL) return SCFrameStatusComplete;
    int value = SCFrameStatusComplete;
    CFNumberGetValue(status, kCFNumberIntType, &value);
    return (SCFrameStatus)value;
}

@implementation SPCapture

- (void)stream:(SCStream*)stream
    didOutputSampleBuffer:(CMSampleBufferRef)sample
                   ofType:(SCStreamOutputType)type {
    if (type != SCStreamOutputTypeScreen) return;
    // 창이 다시 그려지지 않으면 프레임은 정해진 간격으로 계속 오되 모두 idle 로
    // 표시되고 이미지가 없다. 이것을 세어 두면 0 장인 이유를 말할 수 있다.
    if (frameStatus(sample) != SCFrameStatusComplete) {
        self.idle++;
        return;
    }
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
            [NSString stringWithFormat:@"frame-%04d.bgra", self.written + 1]];
        NSString* pending = [path stringByAppendingString:@".partial"];
        FILE* file = fopen(pending.UTF8String, "wb");
        if (file != NULL) {
            uint32_t head[3] = { (uint32_t)width, (uint32_t)height, (uint32_t)stride };
            fwrite(head, sizeof(head), 1, file);
            fwrite(base, stride, height, file);
            // Counted once the file holds the frame, so the count and the
            // directory cannot disagree.
            if (fclose(file) == 0 && rename(pending.UTF8String, path.UTF8String) == 0) {
                self.written++;
                if (self.written == captureBefore + 1) dispatch_semaphore_signal(captureFirstFrame);
            }
        }
    }
    CVPixelBufferUnlockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly);
}

- (void)stream:(SCStream*)stream didStopWithError:(NSError*)error {
    fprintf(stderr, "observe: capture stopped, %s\n", error.localizedDescription.UTF8String);
}

@end

// 모든 캡처가 사용하는 값. 윈도 서버의 창 목록 조회가 프레임 한 장보다 훨씬 느리므로
// 한 번만 조회한다.
static SCContentFilter* captureFilter = nil;
static SCStreamConfiguration* captureConfig = nil;
static SCStream* captureStream = nil;
static SPCapture* captureSink = nil;

// captureOpen 은 창을 조회해 캡처에 필요한 값을 보관한다.
//
// 조회는 비동기이므로 답을 기다린다. 기다리지 않으면 그 사이에 시작한 캡처가 조용히
// 아무 일도 하지 않고, 프레임이 0 장인 이유가 어디에도 남지 않는다.
static void captureOpen(long windowNumber) {
    dispatch_semaphore_t answered = dispatch_semaphore_create(0);
    [SCShareableContent getShareableContentWithCompletionHandler:
        ^(SCShareableContent* content, NSError* error) {
        if (error != nil) {
            fprintf(stderr, "observe: no screen recording permission, %s\n",
                error.localizedDescription.UTF8String);
            dispatch_semaphore_signal(answered);
            return;
        }
        for (SCWindow* window in content.windows) {
            if ((long)window.windowID != windowNumber) continue;
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
            // 필터를 마지막에 둔다. captureStart 가 필터로 준비 여부를 판단하므로,
            // 먼저 두면 설정이 없는 채로 스트림을 만들 수 있다.
            captureFilter =
                [[SCContentFilter alloc] initWithDesktopIndependentWindow:window];
            dispatch_semaphore_signal(answered);
            return;
        }
        fprintf(stderr, "observe: window %ld not found\n", windowNumber);
        dispatch_semaphore_signal(answered);
    }];
    dispatch_semaphore_wait(answered, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC));
    dispatch_release(answered);
}

static void captureStart(const char* directory) {
    if (captureFilter == nil) {
        fprintf(stderr, "observe: capture has no window to record\n");
        return;
    }
    if (captureStream != nil) return;
    // 수신 객체는 한 번만 만든다. 녹화마다 새로 만들면 프레임 번호가 1 부터 다시
    // 시작해 앞선 녹화가 적은 파일을 덮어쓴다.
    if (captureSink == nil) captureSink = [[SPCapture alloc] init];
    captureBefore = captureSink.written;
    captureSink.idle = 0;
    if (captureFirstFrame) dispatch_release(captureFirstFrame);
    captureFirstFrame = dispatch_semaphore_create(0);
    captureSink.directory = [NSString stringWithUTF8String:directory];
    captureStream = [[SCStream alloc] initWithFilter:captureFilter
                                       configuration:captureConfig
                                            delegate:captureSink];
    NSError* error = nil;
    captureQueue = dispatch_queue_create("sp.capture", NULL);
    [captureStream addStreamOutput:captureSink
                              type:SCStreamOutputTypeScreen
                sampleHandlerQueue:captureQueue
                             error:&error];
    if (error != nil) {
        fprintf(stderr, "observe: capture output not added, %s\n",
            error.localizedDescription.UTF8String);
        [captureStream release];
        captureStream = nil;
        return;
    }
    [captureStream startCaptureWithCompletionHandler:^(NSError* failed) {
        if (failed != nil) {
            fprintf(stderr, "observe: capture not started, %s\n",
                failed.localizedDescription.UTF8String);
        }
    }];
}

static int captureWait(void) {
    return captureStream != nil && dispatch_semaphore_wait(captureFirstFrame,
        dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC)) == 0;
}

// Stops the stream and reports how many frames reached disk.
//
// The stop is answered on another queue, and frames already handed over are
// written while it runs. Reading the count before that would under-report, and
// the process exiting then would leave the last file short.
static int captureStop(void) {
    if (captureStream == nil) return 0;
    SCStream* stream = captureStream;
    dispatch_semaphore_t stopped = dispatch_semaphore_create(0);
    [stream stopCaptureWithCompletionHandler:^(NSError* failed) {
        if (failed != nil) {
            fprintf(stderr, "observe: capture not stopped, %s\n",
                failed.localizedDescription.UTF8String);
        }
        dispatch_semaphore_signal(stopped);
    }];
    dispatch_semaphore_wait(stopped, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC));
    dispatch_sync(captureQueue, ^{});
    captureStream = nil;
    dispatch_release(captureQueue);
    dispatch_release(stopped);
    [stream release];
    if (captureSink.written == captureBefore && captureSink.idle > 0) {
        fprintf(stderr, "observe: the window was not redrawn during %d frames; "
            "the display is off or the window is not on screen\n", captureSink.idle);
    }
    return captureSink.written - captureBefore;
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

func captureStop() int  { return int(C.captureStop()) }
func captureWait() bool { return C.captureWait() != 0 }
