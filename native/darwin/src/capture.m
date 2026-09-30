// 애플리케이션 창을 ScreenCaptureKit 스트림으로 녹화한다.
//
// 윈도 서버가 페이지와 표면과 모달을 합성하므로, 측정 대상은 그 합성 결과다. 한 장씩
// 요청하는 스크린샷은 요청 시점에 맞춰 만들어진 합성을 반환하므로, 리사이즈와 다음
// 렌더 사이의 한 프레임짜리 상태는 담기지 않는다. 스트림은 합성기가 표시한 프레임을
// 그대로 전달한다.
//
// CGWindowListCreateImage 는 macOS 15 부터 컴파일이 거부된다. ScreenCaptureKit 이
// 대체 인터페이스다.
#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import "capture.h"
#import <ImageIO/ImageIO.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#include <compression.h>
#include <zlib.h>

static void setCaptureError(NSString* message);
static bool hasCaptureError(void);

static dispatch_semaphore_t captureFirstFrame;
// 종료 요청 시각(mach 절대 시각)과, 그 이후에 표시된 프레임이 도착했음을 알리는 신호.
static uint64_t captureStopAfter;
static dispatch_semaphore_t captureCaughtUp;
static dispatch_queue_t captureQueue;
static int captureBefore;
// 프레임을 디스크에 쓰는 직렬 큐와, 쓰기를 기다리는 프레임 수의 상한.
static dispatch_queue_t captureWriter;
static dispatch_semaphore_t capturePending;
static const long kCapturePending = 64;
// A diagnostic recording is a bounded burst, not an unbounded video sink.
// Reaching the bound is reported as an incomplete recording; frames are never
// silently discarded and accepted as a pass.
static const int kCaptureMaxFrames = 600;
static bool captureLimitReached;
// Frames displayed before the capture request are not part of the measured
// gesture. ScreenCaptureKit may deliver one cached frame when a stream starts;
// retain only frames whose display time is at or after this boundary.
static uint64_t captureStartedAt;

// 프레임을 받아 파일로 적는다. 프레임이 메시지로 전달되므로 수신 객체가 필요하다.
@interface SPCapture : NSObject <SCStreamOutput, SCStreamDelegate>
@property (nonatomic, copy) NSString* directory;
@property (nonatomic) int written;
@property (nonatomic) int idle;
// 완성되지 않은 프레임의 상태별 수. 인덱스는 SCFrameStatus 값이다.
@property (nonatomic) int *statuses;
// 받은 완성 프레임 수, 쓰기 큐에 넣은 수, 쓰기 대기 상한 때문에 거부한 수, 가장 느린 쓰기(초),
// 연속한 완성 프레임 사이의 가장 긴 표시 간격(mach 시각). written 과 slowestWrite 는 쓰기 큐가 바꾼다.
@property (nonatomic) int complete;
@property (nonatomic) int queued;
@property (nonatomic) int rejected;
@property (nonatomic) double slowestWrite;
@property (nonatomic) uint64_t lastShown;
@property (nonatomic) uint64_t longestGap;
@end

// displayTime 은 프레임이 화면에 표시된 mach 절대 시각을 읽는다. 없으면 0 이다.
static uint64_t displayTime(CMSampleBufferRef sample) {
    CFArrayRef list = CMSampleBufferGetSampleAttachmentsArray(sample, false);
    if (list == NULL || CFArrayGetCount(list) == 0) return 0;
    CFDictionaryRef attached = CFArrayGetValueAtIndex(list, 0);
    CFNumberRef time = CFDictionaryGetValue(attached, (__bridge CFStringRef)SCStreamFrameInfoDisplayTime);
    uint64_t value = 0;
    if (time != NULL) CFNumberGetValue(time, kCFNumberSInt64Type, &value);
    return value;
}

// frameNumber 는 프레임에 붙은 숫자 정보를 읽는다. 없으면 0 이다.
static double frameNumber(CMSampleBufferRef sample, SCStreamFrameInfo key) {
    CFArrayRef list = CMSampleBufferGetSampleAttachmentsArray(sample, false);
    if (list == NULL || CFArrayGetCount(list) == 0) return 0;
    CFNumberRef value = CFDictionaryGetValue(CFArrayGetValueAtIndex(list, 0), (__bridge CFStringRef)key);
    double number = 0;
    if (value != NULL) CFNumberGetValue(value, kCFNumberDoubleType, &number);
    return number;
}

// contentRect 는 버퍼 안에서 창이 그려진 사각형(버퍼 포인트 단위)을 읽는다.
static CGRect contentRect(CMSampleBufferRef sample) {
    CFArrayRef list = CMSampleBufferGetSampleAttachmentsArray(sample, false);
    CGRect rect = CGRectZero;
    if (list == NULL || CFArrayGetCount(list) == 0) return rect;
    CFDictionaryRef value = CFDictionaryGetValue(CFArrayGetValueAtIndex(list, 0),
        (__bridge CFStringRef)SCStreamFrameInfoContentRect);
    if (value != NULL) CGRectMakeWithDictionaryRepresentation(value, &rect);
    return rect;
}

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
    [self write:sample];
    // 종료 요청 이후에 표시된 프레임은 idle 이어도 그 시각까지의 화면이 모두 전달되었다는 뜻이다.
    if (captureCaughtUp != NULL && captureStopAfter != 0 && displayTime(sample) >= captureStopAfter) {
        captureStopAfter = 0;
        dispatch_semaphore_signal(captureCaughtUp);
    }
}

- (void)write:(CMSampleBufferRef)sample {
    // 창이 다시 그려지지 않으면 프레임은 정해진 간격으로 계속 오되 모두 idle 로
    // 표시되고 이미지가 없다. 이것을 세어 두면 0 장인 이유를 말할 수 있다.
    SCFrameStatus status = frameStatus(sample);
    if (status != SCFrameStatusComplete) {
        if (status == SCFrameStatusIdle) self.idle++;
        if ((int)status >= 0 && (int)status < 6) self.statuses[status]++;
        return;
    }
    if (hasCaptureError()) return;
    CVImageBufferRef buffer = CMSampleBufferGetImageBuffer(sample);
    if (buffer == NULL) return;
    uint64_t shown = displayTime(sample);
    if (captureStartedAt != 0 && shown != 0 && shown < captureStartedAt) return;
    if (self.queued - captureBefore >= kCaptureMaxFrames) {
        if (!captureLimitReached) {
            captureLimitReached = true;
            fprintf(stderr, "observe: capture frame limit reached (%d)\n", kCaptureMaxFrames);
        }
        return;
    }
    self.complete++;
    if (self.lastShown != 0 && shown > self.lastShown && shown - self.lastShown > self.longestGap) {
        self.longestGap = shown - self.lastShown;
    }
    self.lastShown = shown;
    // 샘플 콜백이 쓰기를 기다리면 스트림이 다음 프레임을 잃는다. 대기 용량이 소진되면
    // 녹화 자체를 실패시키고 다음 콜백과 종료 시각 전달을 막지 않는다.
    if (dispatch_semaphore_wait(capturePending, DISPATCH_TIME_NOW) != 0) {
        self.rejected++;
        setCaptureError([NSString stringWithFormat:@"capture pending writer capacity exceeded (%ld frames)", kCapturePending]);
        return;
    }
    CVPixelBufferLockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly);
    size_t width = CVPixelBufferGetWidth(buffer);
    size_t height = CVPixelBufferGetHeight(buffer);
    size_t stride = CVPixelBufferGetBytesPerRow(buffer);
    const uint8_t* base = (const uint8_t*)CVPixelBufferGetBaseAddress(buffer);
    if (base == NULL) {
        setCaptureError([NSString stringWithFormat:@"frame %d has no pixel buffer", self.queued + 1]);
        CVPixelBufferUnlockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly);
        dispatch_semaphore_signal(capturePending);
        return;
    }
    // 크기가 바뀌는 창을 재려면 프레임마다 창이 그려진 영역과 배율, 표시 시각이 필요하다.
    CGRect rect = contentRect(sample);
    mach_timebase_info_data_t timebase;
    mach_timebase_info(&timebase);
    uint32_t head[3] = { (uint32_t)width, (uint32_t)height, (uint32_t)stride };
    double info[7] = { rect.origin.x, rect.origin.y, rect.size.width, rect.size.height,
        frameNumber(sample, SCStreamFrameInfoContentScale), frameNumber(sample, SCStreamFrameInfoScaleFactor),
        (double)shown * timebase.numer / timebase.denom / 1e6 };
    size_t size = sizeof(head) + sizeof(info) + stride * height;
    uint8_t *copy = malloc(size);
    if (copy != NULL) {
        memcpy(copy, head, sizeof(head));
        memcpy(copy + sizeof(head), info, sizeof(info));
        memcpy(copy + sizeof(head) + sizeof(info), base, stride * height);
    }
    CVPixelBufferUnlockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly);
    if (copy == NULL) {
        setCaptureError([NSString stringWithFormat:@"frame %d could not be copied: %s", self.queued + 1, strerror(errno)]);
        fprintf(stderr, "observe: frame %d was not copied, %s\n", self.queued + 1, strerror(errno));
        dispatch_semaphore_signal(capturePending);
        return;
    }
    int number = ++self.queued;
    NSString* path = [self.directory stringByAppendingPathComponent:[NSString stringWithFormat:@"frame-%04d.bgra", number]];
    dispatch_async(captureWriter, ^{
        CFTimeInterval began = CACurrentMediaTime();
        // 헤더를 보존하고 모든 픽셀과 행 패딩을 무손실로 압축한다.
        size_t pixels = stride * height;
        size_t capacity = pixels + pixels / 255 + 16;
        uint8_t *encoded = capacity <= UINT32_MAX ? malloc(80 + capacity) : NULL;
        size_t compressed = 0;
        if (encoded != NULL) {
            memcpy(encoded, copy, sizeof(head) + sizeof(info));
            memcpy(encoded + 68, "LZ4B", 4);
            compressed = compression_encode_buffer(encoded + 80, capacity,
                copy + sizeof(head) + sizeof(info), pixels, NULL, COMPRESSION_LZ4_RAW);
            uint32_t count = (uint32_t)compressed;
            uint32_t checksum = (uint32_t)crc32(0, copy + sizeof(head) + sizeof(info), (uInt)pixels);
            memcpy(encoded + 72, &count, sizeof count);
            memcpy(encoded + 76, &checksum, sizeof checksum);
        }
        free(copy);
        if (encoded == NULL || compressed == 0) {
            setCaptureError([NSString stringWithFormat:@"frame %d could not be losslessly compressed (capacity %zu)", number, capacity]);
            free(encoded);
            dispatch_semaphore_signal(capturePending);
            return;
        }
        NSString* pending = [path stringByAppendingString:@".partial"];
        FILE* file = fopen(pending.UTF8String, "wb");
        // 파일이 프레임 전체를 담았을 때만 센다. 그래야 개수와 디렉터리가 어긋나지 않는다.
        // 쓰기에 실패한 파일은 남기지 않는다.
        bool whole = file != NULL && fwrite(encoded, 80 + compressed, 1, file) == 1;
        bool closed = file != NULL && fclose(file) == 0;
        if (!whole || !closed) {
            setCaptureError([NSString stringWithFormat:@"frame %d was not written: %s", number, strerror(errno)]);
            fprintf(stderr, "observe: frame %d was not written, %s\n", number, strerror(errno));
            unlink(pending.UTF8String);
        } else if (rename(pending.UTF8String, path.UTF8String) == 0) {
            self.written++;
            if (self.written == captureBefore + 1) dispatch_semaphore_signal(captureFirstFrame);
        } else {
            setCaptureError([NSString stringWithFormat:@"frame %d could not be committed: %s", number, strerror(errno)]);
            unlink(pending.UTF8String);
        }
        free(encoded);
        self.slowestWrite = MAX(self.slowestWrite, CACurrentMediaTime() - began);
        dispatch_semaphore_signal(capturePending);
    });
}

- (void)stream:(SCStream*)stream didStopWithError:(NSError*)error {
    if (error != nil) {
        setCaptureError([NSString stringWithFormat:@"capture stopped with error: %@", error.localizedDescription]);
    }
    fprintf(stderr, "observe: capture stopped, %s\n", error.localizedDescription.UTF8String);
}

@end

// 모든 캡처가 사용하는 값. 윈도 서버의 창 목록 조회가 프레임 한 장보다 훨씬 느리므로
// 한 번만 조회한다.
static SCContentFilter* captureFilter = nil;
static SCStreamConfiguration* captureConfig = nil;
static SCStream* captureStream = nil;
static SPCapture* captureSink = nil;
static NSString* captureError = nil;

static void clearCaptureError(void) {
    @synchronized([SPCapture class]) {
        [captureError release];
        captureError = nil;
    }
}

static void setCaptureError(NSString* message) {
    @synchronized([SPCapture class]) {
        NSString *combined = captureError == nil ? [message copy]
            : [[captureError stringByAppendingFormat:@"; %@", message] copy];
        [captureError release];
        captureError = combined;
    }
}

static bool hasCaptureError(void) {
    @synchronized([SPCapture class]) { return captureError != nil; }
}

const char *sp_capture_error(void) {
    @synchronized([SPCapture class]) {
        return captureError == nil ? "" : captureError.UTF8String;
    }
}

// sp_capture_open 은 창을 조회해 캡처에 필요한 값을 보관한다.
//
// 조회는 비동기이므로 답을 기다린다. 기다리지 않으면 그 사이에 시작한 캡처가 조용히
// 아무 일도 하지 않고, 프레임이 0 장인 이유가 어디에도 남지 않는다.
bool sp_capture_open(long windowNumber, bool display) {
    clearCaptureError();
    // 이전 대상을 지운다. 조회에 실패하면 이전 대상을 녹화하지 않고 녹화가 시작되지 않는다.
    captureFilter = nil;
    dispatch_semaphore_t answered = dispatch_semaphore_create(0);
    // The diagnostic target is owned by this process. Asking for all shareable
    // content unnecessarily enters the Screen Recording permission path and
    // makes an app-owned capture depend on TCC. The current-process query is
    // the compositor capture API for this exact case and still includes the
    // window's child webviews in the resulting composite.
    [SCShareableContent getCurrentProcessShareableContentWithCompletionHandler:
        ^(SCShareableContent* content, NSError* error) {
        if (error != nil) {
            setCaptureError([NSString stringWithFormat:@"current-process capture unavailable: %@", error.localizedDescription]);
            fprintf(stderr, "observe: current-process capture unavailable, %s\n",
                error.localizedDescription.UTF8String);
            dispatch_semaphore_signal(answered);
            return;
        }
        for (SCWindow* window in content.windows) {
            if ((long)window.windowID != windowNumber) continue;
            SCContentFilter* filter = nil;
            if (display) {
                // 창의 중심이 있는 디스플레이에서 이 앱의 창만 담는다. 다른 앱의 창은 기록하지 않는다.
                CGPoint centre = CGPointMake(CGRectGetMidX(window.frame), CGRectGetMidY(window.frame));
                for (SCDisplay* candidate in content.displays) {
                    if (!CGRectContainsPoint(candidate.frame, centre)) continue;
                    NSMutableArray* own = [NSMutableArray array];
                    if (window.owningApplication != nil) [own addObject:window.owningApplication];
                    filter = [[SCContentFilter alloc] initWithDisplay:candidate includingApplications:own exceptingWindows:@[]];
                    break;
                }
                if (filter == nil) {
                    setCaptureError([NSString stringWithFormat:@"window %ld is on no display", windowNumber]);
                    fprintf(stderr, "observe: window %ld is on no display\n", windowNumber);
                    dispatch_semaphore_signal(answered);
                    return;
                }
            } else {
                filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:window];
            }
            SCStreamConfiguration* config = [[SCStreamConfiguration alloc] init];
            // 장치 픽셀을 유지하여 가는 선의 색상이 축소 과정에서 혼합되지 않도록 한다.
            config.width = (size_t)(filter.contentRect.size.width * filter.pointPixelScale);
            config.height = (size_t)(filter.contentRect.size.height * filter.pointPixelScale);
            config.pixelFormat = kCVPixelFormatType_32BGRA;
            // 페이지는 sRGB 로 색을 지정한다. 디스플레이 색공간으로 받으면 연결된 디스플레이마다
            // 픽셀 값이 달라지므로, 측정하는 쪽과 같은 sRGB 로 받는다.
            config.colorSpaceName = kCGColorSpaceSRGB;
            config.showsCursor = NO;
            config.captureResolution = SCCaptureResolutionBest;
            // 화면이 갱신되는 만큼 받는다. 변경이 없으면 프레임도 오지 않는다.
            config.minimumFrameInterval = CMTimeMake(1, 120);
            config.queueDepth = 8;
            captureConfig = config;
            // 필터를 마지막에 둔다. sp_capture_start 가 필터로 준비 여부를 판단하므로,
            // 먼저 두면 설정이 없는 채로 스트림을 만들 수 있다.
            captureFilter = filter;
            dispatch_semaphore_signal(answered);
            return;
        }
        setCaptureError([NSString stringWithFormat:@"window %ld not found", windowNumber]);
        fprintf(stderr, "observe: window %ld not found\n", windowNumber);
        dispatch_semaphore_signal(answered);
    }];
    long wait = dispatch_semaphore_wait(answered, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC));
    dispatch_release(answered);
    if (wait != 0) {
        setCaptureError(@"shareable content query timed out after 10000ms");
        return false;
    }
    return captureFilter != nil;
}

bool sp_capture_start(const char* directory) {
    clearCaptureError();
    if (captureFilter == nil) {
        setCaptureError(@"capture has no prepared window");
        fprintf(stderr, "observe: capture has no window to record\n");
        return false;
    }
    if (captureStream != nil) {
        setCaptureError(@"capture is already running");
        return false;
    }
    if (directory == NULL) {
        setCaptureError(@"capture directory is null");
        return false;
    }
    captureStartedAt = mach_absolute_time();
    captureLimitReached = false;
    // 수신 객체는 한 번만 만든다. 녹화마다 새로 만들면 프레임 번호가 1 부터 다시
    // 시작해 앞선 녹화가 적은 파일을 덮어쓴다.
    if (captureSink == nil) captureSink = [[SPCapture alloc] init];
    if (!captureWriter) {
        captureWriter = dispatch_queue_create("sp.capture.writer", DISPATCH_QUEUE_SERIAL);
        capturePending = dispatch_semaphore_create(kCapturePending);
    }
    captureBefore = captureSink.written;
    captureSink.queued = captureSink.written;
    captureSink.rejected = 0;
    captureSink.idle = 0;
    captureSink.complete = 0;
    captureSink.slowestWrite = 0;
    captureSink.lastShown = 0;
    captureSink.longestGap = 0;
    static int statuses[6];
    memset(statuses, 0, sizeof statuses);
    captureSink.statuses = statuses;
    if (captureFirstFrame) dispatch_release(captureFirstFrame);
    captureFirstFrame = dispatch_semaphore_create(0);
    captureSink.directory = [NSString stringWithUTF8String:directory];
    if (captureSink.directory == nil) {
        setCaptureError(@"capture directory is not valid UTF-8");
        return false;
    }
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
        setCaptureError([NSString stringWithFormat:@"capture output was not added: %@", error.localizedDescription]);
        fprintf(stderr, "observe: capture output not added, %s\n",
            error.localizedDescription.UTF8String);
        [captureStream release];
        captureStream = nil;
        return false;
    }
    [captureStream startCaptureWithCompletionHandler:^(NSError* failed) {
        if (failed != nil) {
            setCaptureError([NSString stringWithFormat:@"capture did not start: %@", failed.localizedDescription]);
            fprintf(stderr, "observe: capture not started, %s\n",
                failed.localizedDescription.UTF8String);
        }
    }];
    return true;
}

int sp_capture_wait(void) {
    if (captureStream == nil) {
        setCaptureError(@"capture is not running");
        return 0;
    }
    if (dispatch_semaphore_wait(captureFirstFrame,
        dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC)) != 0) {
        setCaptureError(@"no capture frame arrived within 10000ms");
        return 0;
    }
    return hasCaptureError() ? 0 : 1;
}

// Stops the stream and reports how many frames reached disk.
//
// The stop is answered on another queue, and frames already handed over are
// written while it runs. Reading the count before that would under-report, and
// the process exiting then would leave the last file short.
int sp_capture_stop(double after) {
    if (captureStream == nil) {
        setCaptureError(@"capture is not running");
        return 0;
    }
    SCStream* stream = captureStream;
    // 호출 시점과 after 중 늦은 시각까지 표시된 화면이 스트림에 모두 전달된 뒤 멈춘다. 앱이 커밋한
    // 내용은 호출보다 늦게 표시될 수 있으므로 호출자가 그 표시 시각을 넘긴다. 스트림은 화면이 바뀌지
    // 않아도 idle 프레임을 minimumFrameInterval 마다 전달하므로 기다림은 한 간격 안에 끝난다.
    mach_timebase_info_data_t base;
    mach_timebase_info(&base);
    uint64_t now = mach_absolute_time();
    uint64_t shown = after > 0 ? (uint64_t)(after * 1e6 * base.denom / base.numer) : 0;
    uint64_t until = shown > now ? shown : now;
    dispatch_semaphore_t caughtUp = dispatch_semaphore_create(0);
    dispatch_sync(captureQueue, ^{
        captureCaughtUp = caughtUp;
        captureStopAfter = until;
    });
    if (dispatch_semaphore_wait(caughtUp, dispatch_time(until, NSEC_PER_SEC)) != 0) {
        setCaptureError(@"no frame arrived within 1000ms after the requested display time");
        fprintf(stderr, "observe: no frame displayed within 1 second after the requested display time\n");
    }
    dispatch_sync(captureQueue, ^{
        captureCaughtUp = NULL;
        captureStopAfter = 0;
    });
    dispatch_release(caughtUp);
    dispatch_semaphore_t stopped = dispatch_semaphore_create(0);
    [stream stopCaptureWithCompletionHandler:^(NSError* failed) {
        if (failed != nil) {
            setCaptureError([NSString stringWithFormat:@"capture did not stop: %@", failed.localizedDescription]);
            fprintf(stderr, "observe: capture not stopped, %s\n",
                failed.localizedDescription.UTF8String);
        }
        dispatch_semaphore_signal(stopped);
    }];
    if (dispatch_semaphore_wait(stopped, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) != 0) {
        setCaptureError(@"capture stop did not complete within 5000ms");
    }
    dispatch_sync(captureQueue, ^{});
    // 복사해 둔 프레임을 모두 쓴 뒤 센다.
    dispatch_sync(captureWriter, ^{});
    captureStream = nil;
    dispatch_release(captureQueue);
    dispatch_release(stopped);
    [stream release];
    // 기록되지 않은 프레임의 이유를 남긴다. blank 는 창이 보이지 않고, suspended 는 스트림이 멈췄다.
    int *counts = captureSink.statuses;
    mach_timebase_info_data_t timebase;
    mach_timebase_info(&timebase);
    fprintf(stderr, "observe: %d complete frames received, %d written, %d rejected for pending writer capacity, "
        "slowest write %.1fms, longest display gap %.1fms\n",
        captureSink.complete, captureSink.written - captureBefore, captureSink.rejected, captureSink.slowestWrite * 1000,
        (double)captureSink.longestGap * timebase.numer / timebase.denom / 1e6);
    if (counts[SCFrameStatusBlank] || counts[SCFrameStatusSuspended]) {
        fprintf(stderr, "observe: %d blank and %d suspended frames were not written\n",
            counts[SCFrameStatusBlank], counts[SCFrameStatusSuspended]);
    }
    if (captureSink.written == captureBefore && captureSink.idle > 0) {
        fprintf(stderr, "observe: the window was not redrawn during %d frames; "
            "the display is off or the window is not on screen\n", captureSink.idle);
    }
    return captureSink.written - captureBefore;
}

bool sp_capture_limited(void) {
    return captureLimitReached;
}

double sp_capture_longest_gap(void) {
    mach_timebase_info_data_t timebase;
    mach_timebase_info(&timebase);
    return (double)captureSink.longestGap * timebase.numer / timebase.denom / 1e6;
}

// 정지 캡처의 비동기 상태는 해당 호출의 콜백만 소유한다.
@interface SPCaptureStillResult : NSObject
@property (nonatomic, copy) NSString *error;
@property (nonatomic) bool written;
@property (nonatomic, assign) dispatch_semaphore_t answered;
- (void)complete:(bool)written error:(NSString *)error;
@end
@implementation SPCaptureStillResult
- (instancetype)init {
    self = [super init];
    if (self) _answered = dispatch_semaphore_create(0);
    return self;
}
- (void)complete:(bool)written error:(NSString *)error {
    self.written = written;
    self.error = error;
    // 호출자가 시간 초과로 돌아간 뒤 도착한 오류도 로그로 보고한다.
    if (error != nil) fprintf(stderr, "still capture callback failed: %s\n", error.UTF8String);
    dispatch_semaphore_signal(self.answered);
}
- (void)dealloc {
    [_error release];
    dispatch_release(_answered);
    [super dealloc];
}
@end

static bool failStillCapture(char **errorOut, NSString *message) {
    *errorOut = strdup(message.UTF8String);
    if (*errorOut == NULL) {
        fprintf(stderr, "still capture error allocation failed\n");
        abort();
    }
    return false;
}

bool sp_capture_still(long windowNumber, const char *path, char **errorOut) {
    if (errorOut == NULL) {
        fprintf(stderr, "still capture needs an error output\n");
        return false;
    }
    *errorOut = NULL;
    if (path == NULL) {
        return failStillCapture(errorOut, @"still capture needs a path");
    }
    NSString *decoded = [NSString stringWithUTF8String:path];
    if (decoded == nil) return failStillCapture(errorOut, @"still capture path is not valid UTF-8");
    NSURL *url = [NSURL fileURLWithPath:decoded];
    SPCaptureStillResult *result = [[SPCaptureStillResult alloc] init];
    [SCShareableContent getCurrentProcessShareableContentWithCompletionHandler:
        ^(SCShareableContent *content, NSError *error) {
        if (error != nil) {
            [result complete:NO error:[NSString stringWithFormat:@"current-process capture unavailable: %@", error.localizedDescription]];
            return;
        }
        SCWindow *target = nil;
        for (SCWindow *window in content.windows) {
            if ((long)window.windowID == windowNumber) target = window;
        }
        if (target == nil) {
            [result complete:NO error:[NSString stringWithFormat:@"window %ld not found", windowNumber]];
            return;
        }
        if (CGRectIsEmpty(target.frame)) {
            [result complete:NO error:[NSString stringWithFormat:@"window %ld has no on-screen frame", windowNumber]];
            return;
        }
        SCContentFilter *filter = [[[SCContentFilter alloc] initWithDesktopIndependentWindow:target] autorelease];
        SCStreamConfiguration *config = [[[SCStreamConfiguration alloc] init] autorelease];
        // 관측 이미지는 장치 픽셀을 유지한다.
        config.width = (size_t)(filter.contentRect.size.width * filter.pointPixelScale);
        config.height = (size_t)(filter.contentRect.size.height * filter.pointPixelScale);
        config.colorSpaceName = kCGColorSpaceSRGB;
        config.showsCursor = NO;
        [SCScreenshotManager captureImageWithFilter:filter configuration:config
            completionHandler:^(CGImageRef image, NSError *captureError) {
            if (image == NULL) {
                [result complete:NO error:[NSString stringWithFormat:@"still capture failed: %@",
                    captureError.localizedDescription ?: @"no image"]];
                return;
            }
            CGImageDestinationRef destination = CGImageDestinationCreateWithURL(
                (CFURLRef)url, (CFStringRef)@"public.png", 1, NULL);
            if (destination == NULL) {
                [result complete:NO error:[NSString stringWithFormat:@"cannot write %@", url.path]];
                return;
            }
            CGImageDestinationAddImage(destination, image, NULL);
            bool written = CGImageDestinationFinalize(destination);
            CFRelease(destination);
            [result complete:written error:written ? nil : [NSString stringWithFormat:@"cannot write %@", url.path]];
        }];
    }];
    long wait = dispatch_semaphore_wait(result.answered, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC));
    if (wait != 0) {
        [result release];
        return failStillCapture(errorOut, @"still capture timed out after 10000ms");
    }
    bool written = result.written;
    if (!written) failStillCapture(errorOut, result.error);
    [result release];
    return written;
}

double sp_capture_clock(void) {
    mach_timebase_info_data_t timebase;
    mach_timebase_info(&timebase);
    return (double)mach_absolute_time() * timebase.numer / timebase.denom / 1e6;
}
