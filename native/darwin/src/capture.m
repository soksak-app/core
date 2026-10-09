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
#import "application_log.h"
#import <ImageIO/ImageIO.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#include <compression.h>
#include <zlib.h>

static void setCaptureError(NSString* message);
static bool hasCaptureError(void);
static void reportCaptureStreamFailure(SCStream *stream, NSString *message);

static dispatch_semaphore_t captureFirstFrame;
// 스트림 시작 요청의 완료. ScreenCaptureKit 은 시작 완료 전에 첫 프레임을 전달할 수 있고, 시작이 끝나기 전의
// 종료 요청은 이미 멈춘 스트림으로 거부된다(SCStreamErrorDomain -3808).
static dispatch_semaphore_t captureStartDone;
// 종료 요청 시각(mach 절대 시각)과, 그 이후에 표시된 프레임이 도착했음을 알리는 신호.
static uint64_t captureStopAfter;
static dispatch_semaphore_t captureCaughtUp;
static dispatch_queue_t captureQueue;
static int captureBefore;
// 프레임을 디스크에 쓰는 직렬 큐와, 쓰기를 기다리는 프레임 수의 상한.
static dispatch_queue_t captureWriter;
static dispatch_semaphore_t capturePending;
static const long kCapturePending = 64;
// 진단 녹화는 상한이 있는 짧은 연속 기록이며, 상한 없는 비디오 출력이 아니다.
// 상한에 도달하면 불완전한 녹화로 보고한다. 프레임을 알리지 않고 버린 뒤
// 통과로 받아들이지 않는다.
static const int kCaptureMaxFrames = 600;
static bool captureLimitReached;
// 캡처 요청 전에 표시된 프레임은 측정 대상 제스처에 속하지 않는다.
// ScreenCaptureKit 은 stream 이 시작될 때 캐시된 프레임 하나를 전달할 수 있다.
// 표시 시각이 이 경계 시각 이후(같은 시각 포함)인 프레임만 보존한다.
static uint64_t captureStartedAt;
// 완성 프레임의 버퍼가 창의 장치 픽셀 크기와 다르면 true 다. 스트림이 새 출력 크기의 프레임을 보낼 때까지
// 종료는 기다린다. captureUpdating 은 스트림 설정 변경을 요청하고 완료를 기다리는 동안 true 다.
static bool captureResizing;
static bool captureUpdating;
static void followWindowSize(size_t width, size_t height, size_t needWidth, size_t needHeight);

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

// frameInfo 는 프레임에 붙은 정보 사전에서 key 의 값을 읽는다. 사전이나 값이 없으면 NULL 이다.
static CFTypeRef frameInfo(CMSampleBufferRef sample, SCStreamFrameInfo key) {
    CFArrayRef list = CMSampleBufferGetSampleAttachmentsArray(sample, false);
    if (list == NULL || CFArrayGetCount(list) == 0) return NULL;
    return CFDictionaryGetValue(CFArrayGetValueAtIndex(list, 0), (__bridge CFStringRef)key);
}

// displayTime 은 프레임이 화면에 표시된 mach 절대 시각을 읽는다. 시각이 없으면 NO 를 돌려준다.
static BOOL displayTime(CMSampleBufferRef sample, uint64_t *value) {
    CFTypeRef time = frameInfo(sample, SCStreamFrameInfoDisplayTime);
    return time != NULL && CFGetTypeID(time) == CFNumberGetTypeID()
        && CFNumberGetValue(time, kCFNumberSInt64Type, value);
}

// frameNumber 는 프레임에 붙은 숫자 정보를 읽는다. 값이 없으면 NO 를 돌려준다.
static BOOL frameNumber(CMSampleBufferRef sample, SCStreamFrameInfo key, double *number) {
    CFTypeRef value = frameInfo(sample, key);
    return value != NULL && CFGetTypeID(value) == CFNumberGetTypeID()
        && CFNumberGetValue(value, kCFNumberDoubleType, number);
}

// contentRect 는 버퍼 안에서 창이 그려진 사각형(버퍼 포인트 단위)을 읽는다. 사각형이 없으면 NO 를 돌려준다.
static BOOL contentRect(CMSampleBufferRef sample, CGRect *rect) {
    CFTypeRef value = frameInfo(sample, SCStreamFrameInfoContentRect);
    return value != NULL && CFGetTypeID(value) == CFDictionaryGetTypeID()
        && CGRectMakeWithDictionaryRepresentation(value, rect);
}

// frameStatus 는 프레임에 붙은 상태를 읽는다. 상태가 없으면 NO 를 돌려준다.
static BOOL frameStatus(CMSampleBufferRef sample, SCFrameStatus *status) {
    CFTypeRef value = frameInfo(sample, SCStreamFrameInfoStatus);
    int number = 0;
    if (value == NULL || CFGetTypeID(value) != CFNumberGetTypeID()
        || !CFNumberGetValue(value, kCFNumberIntType, &number)) return NO;
    *status = (SCFrameStatus)number;
    return YES;
}

// 파일 작업 직후 저장한 원인을 경로와 함께 보고한다. 후속 정리 오류도 추가한다.
static void reportCaptureFileFailure(int number, NSString *operation, NSString *path, int error) {
    NSString *message = [NSString stringWithFormat:@"frame %d was not written: %@ %@: %s",
        number, operation, path, strerror(error)];
    setCaptureError(message);
    sp_log_error("capture", message.UTF8String);
}

@implementation SPCapture

- (void)stream:(SCStream*)stream
    didOutputSampleBuffer:(CMSampleBufferRef)sample
                   ofType:(SCStreamOutputType)type {
    if (type != SCStreamOutputTypeScreen) return;
    [self write:sample];
    // 종료 요청 이후에 표시된 프레임은 idle 이어도 그 시각까지의 화면이 모두 전달되었다는 뜻이다.
    // 시각이 없는 완성 프레임은 write: 가 녹화 오류로 남기고, 종료는 그 오류를 보고한다.
    // 창 크기를 따라가는 중이면 새 크기의 프레임이 올 때까지 종료를 미룬다.
    uint64_t shown = 0;
    if (captureCaughtUp != NULL && captureStopAfter != 0 && !captureResizing && displayTime(sample, &shown)
        && shown >= captureStopAfter) {
        captureStopAfter = 0;
        dispatch_semaphore_signal(captureCaughtUp);
    }
}

- (void)write:(CMSampleBufferRef)sample {
    // 창이 다시 그려지지 않으면 프레임은 정해진 간격으로 계속 오되 모두 idle 로
    // 표시되고 이미지가 없다. 이것을 세어 두면 0 장인 이유를 말할 수 있다.
    // 상태가 없는 프레임은 완성 여부를 알 수 없으므로 녹화를 실패시킨다.
    SCFrameStatus status = SCFrameStatusComplete;
    if (!frameStatus(sample, &status)) {
        if (!hasCaptureError()) setCaptureError([NSString stringWithFormat:@"frame %d has no status", self.queued + 1]);
        return;
    }
    if (status != SCFrameStatusComplete) {
        if (status == SCFrameStatusIdle) self.idle++;
        if ((int)status >= 0 && (int)status < 6) self.statuses[status]++;
        return;
    }
    if (hasCaptureError()) return;
    // 완성 프레임의 이미지, 표시 시각, 창 사각형, 배율은 프레임을 재는 데 필요하므로 하나라도 없으면 녹화를 실패시킨다.
    int number = self.queued + 1;
    CVImageBufferRef buffer = CMSampleBufferGetImageBuffer(sample);
    if (buffer == NULL) {
        setCaptureError([NSString stringWithFormat:@"frame %d has no image buffer", number]);
        return;
    }
    uint64_t shown = 0;
    if (!displayTime(sample, &shown)) {
        setCaptureError([NSString stringWithFormat:@"frame %d has no display time", number]);
        return;
    }
    CGRect rect = CGRectZero;
    if (!contentRect(sample, &rect)) {
        setCaptureError([NSString stringWithFormat:@"frame %d has no content rectangle", number]);
        return;
    }
    double contentScale = 0, scaleFactor = 0;
    if (!frameNumber(sample, SCStreamFrameInfoContentScale, &contentScale)) {
        setCaptureError([NSString stringWithFormat:@"frame %d has no content scale", number]);
        return;
    }
    if (!frameNumber(sample, SCStreamFrameInfoScaleFactor, &scaleFactor)) {
        setCaptureError([NSString stringWithFormat:@"frame %d has no scale factor", number]);
        return;
    }
    if (!(contentScale > 0) || !(scaleFactor > 0)) {
        setCaptureError([NSString stringWithFormat:@"frame %d has content scale %g and scale factor %g",
            number, contentScale, scaleFactor]);
        return;
    }
    // 스트림 출력 크기는 시작할 때의 창 크기다. 창이 커지면 프레임이 축소되고(content scale < 1) 작아지면
    // 버퍼가 남는다. 창의 장치 픽셀 크기가 버퍼와 다르면 출력 크기를 바꾼다. 바뀌기 전 프레임도 기록하며
    // 헤더의 content scale 로 구분된다.
    followWindowSize(CVPixelBufferGetWidth(buffer), CVPixelBufferGetHeight(buffer),
        (size_t)llround(rect.size.width / contentScale * scaleFactor),
        (size_t)llround(rect.size.height / contentScale * scaleFactor));
    if (captureStartedAt != 0 && shown < captureStartedAt) return;
    if (self.queued - captureBefore >= kCaptureMaxFrames) {
        if (!captureLimitReached) {
            captureLimitReached = true;
            sp_log_info("capture", [NSString stringWithFormat:@"frame limit reached (%d)", kCaptureMaxFrames].UTF8String);
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
    mach_timebase_info_data_t timebase;
    mach_timebase_info(&timebase);
    uint32_t head[3] = { (uint32_t)width, (uint32_t)height, (uint32_t)stride };
    double info[7] = { rect.origin.x, rect.origin.y, rect.size.width, rect.size.height,
        contentScale, scaleFactor,
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
        NSString *message = [NSString stringWithFormat:@"frame %d could not be copied: %s", self.queued + 1, strerror(errno)];
        setCaptureError(message);
        sp_log_error("capture", message.UTF8String);
        dispatch_semaphore_signal(capturePending);
        return;
    }
    self.queued = number;
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
        FILE *file = fopen(pending.UTF8String, "wb");
        if (file == NULL) {
            // 열지 못한 경로는 이 쓰기가 소유하지 않으므로 삭제하지 않는다.
            reportCaptureFileFailure(number, @"open", pending, errno);
        } else {
            bool whole = fwrite(encoded, 80 + compressed, 1, file) == 1;
            if (!whole) reportCaptureFileFailure(number, @"write", pending, errno);
            // 쓰기 실패 뒤에도 닫는다. 두 실패는 각각 원래 시스템 오류를 보존한다.
            bool closed = fclose(file) == 0;
            if (!closed) reportCaptureFileFailure(number, @"close", pending, errno);
            bool committed = false;
            if (whole && closed) {
                committed = rename(pending.UTF8String, path.UTF8String) == 0;
                if (!committed) reportCaptureFileFailure(number, @"commit", path, errno);
            }
            if (committed) {
                self.written++;
                if (self.written == captureBefore + 1) dispatch_semaphore_signal(captureFirstFrame);
            } else if (unlink(pending.UTF8String) != 0) {
                reportCaptureFileFailure(number, @"remove", pending, errno);
            }
        }
        free(encoded);
        self.slowestWrite = MAX(self.slowestWrite, CACurrentMediaTime() - began);
        dispatch_semaphore_signal(capturePending);
    });
}

- (void)stream:(SCStream*)stream didStopWithError:(NSError*)error {
    if (error != nil) {
        reportCaptureStreamFailure(stream,
            [NSString stringWithFormat:@"capture stopped with error: %@", error.localizedDescription]);
    } else {
        sp_log_info("capture", [NSString stringWithFormat:@"stopped without a delegate error (stream=%p)", stream].UTF8String);
    }
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

// 이전 스트림의 오류도 보고하되 현재 녹화의 결과를 변경하지 않는다.
static void reportCaptureStreamFailure(SCStream *stream, NSString *message) {
    @synchronized([SPCapture class]) {
        bool current = stream != nil && stream == captureStream;
        if (current) setCaptureError(message);
        sp_log_error("capture", [NSString stringWithFormat:@"%@ (stream=%p current=%d)", message, stream, current].UTF8String);
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

static bool captureOperationFailure(char **errorOut, NSString *message) {
    *errorOut = strdup(message.UTF8String);
    if (*errorOut == NULL) {
        sp_log_error("capture", "the error text could not be allocated");
        abort();
    }
    return false;
}


// 비동기 준비 결과는 해당 조회의 콜백만 소유한다. 전역 대상은 대기한 호출자가 게시한다.
@interface SPCapturePreparation : NSObject
@property (nonatomic, retain) SCContentFilter *filter;
@property (nonatomic, retain) SCStreamConfiguration *configuration;
@property (nonatomic, copy) NSString *error;
@property (nonatomic, assign) dispatch_semaphore_t answered;
- (void)completeWithFilter:(SCContentFilter *)filter
    configuration:(SCStreamConfiguration *)configuration error:(NSString *)error;
@end
@implementation SPCapturePreparation
- (instancetype)init {
    self = [super init];
    if (self) _answered = dispatch_semaphore_create(0);
    return self;
}
- (void)completeWithFilter:(SCContentFilter *)filter
    configuration:(SCStreamConfiguration *)configuration error:(NSString *)error {
    self.filter = filter;
    self.configuration = configuration;
    self.error = error;
    if (error != nil) sp_log_error("capture preparation", error.UTF8String);
    dispatch_semaphore_signal(self.answered);
}
- (void)dealloc {
    [_filter release]; [_configuration release]; [_error release];
    dispatch_release(_answered);
    [super dealloc];
}
@end

// 녹화 스트림 설정. 장치 픽셀과 sRGB를 유지하여 얇은 선의 좌표·색을 그대로 측정한다.
static SCStreamConfiguration *recordingConfiguration(size_t width, size_t height) {
    SCStreamConfiguration *config = [[[SCStreamConfiguration alloc] init] autorelease];
    config.width = width;
    config.height = height;
    config.pixelFormat = kCVPixelFormatType_32BGRA;
    config.colorSpaceName = kCGColorSpaceSRGB;
    config.showsCursor = NO;
    config.captureResolution = SCCaptureResolutionBest;
    config.minimumFrameInterval = CMTimeMake(1, 120);
    config.queueDepth = 8;
    return config;
}

// 버퍼 크기 width×height 가 창의 장치 픽셀 크기 needWidth×needHeight 와 다르면 현재 스트림의 출력 크기를
// 바꾼다. 변경을 기다리는 동안 다시 요청하지 않으며, 변경 뒤에도 다르면 다음 프레임이 다시 요청한다.
static void followWindowSize(size_t width, size_t height, size_t needWidth, size_t needHeight) {
    @synchronized([SPCapture class]) {
        if (width == needWidth && height == needHeight) {
            captureResizing = false;
            return;
        }
        captureResizing = true;
        if (captureUpdating || captureStream == nil) return;
        captureUpdating = true;
        SCStream *stream = captureStream;
        SCStreamConfiguration *config = recordingConfiguration(needWidth, needHeight);
        [stream updateConfiguration:config completionHandler:^(NSError *failed) {
            if (failed != nil) {
                reportCaptureStreamFailure(stream, [NSString stringWithFormat:
                    @"capture did not follow the window size %zux%zu: %@", needWidth, needHeight, failed.localizedDescription]);
            }
            @synchronized([SPCapture class]) {
                if (stream == captureStream) captureUpdating = false;
            }
        }];
    }
}

bool sp_capture_open(long windowNumber, bool display, char **errorOut) {
    if (errorOut == NULL) {
        sp_log_error("capture open", "an error output is required");
        return false;
    }
    *errorOut = NULL;
    if (captureStream != nil) return captureOperationFailure(errorOut, @"capture is already running");
    // 조회 실패 뒤 이전 대상으로 녹화하지 않도록 비활성 준비 소유를 해제한다.
    [captureFilter release]; captureFilter = nil;
    [captureConfig release]; captureConfig = nil;
    SPCapturePreparation *result = [[SPCapturePreparation alloc] init];
    // 이 프로세스의 창만 조회하여 다른 앱의 화면 녹화 권한 경로에 의존하지 않는다.
    [SCShareableContent getCurrentProcessShareableContentWithCompletionHandler:
        ^(SCShareableContent *content, NSError *error) {
        if (error != nil) {
            [result completeWithFilter:nil configuration:nil error:
                [NSString stringWithFormat:@"current-process capture unavailable: %@", error.localizedDescription]];
            return;
        }
        for (SCWindow *window in content.windows) {
            if ((long)window.windowID != windowNumber) continue;
            SCContentFilter *filter = nil;
            if (display) {
                // 창의 중심이 있는 디스플레이에서 이 앱의 창만 담는다.
                CGPoint centre = CGPointMake(CGRectGetMidX(window.frame), CGRectGetMidY(window.frame));
                for (SCDisplay *candidate in content.displays) {
                    if (!CGRectContainsPoint(candidate.frame, centre)) continue;
                    NSMutableArray *own = [NSMutableArray array];
                    if (window.owningApplication != nil) [own addObject:window.owningApplication];
                    filter = [[[SCContentFilter alloc] initWithDisplay:candidate
                        includingApplications:own exceptingWindows:@[]] autorelease];
                    break;
                }
                if (filter == nil) {
                    [result completeWithFilter:nil configuration:nil error:
                        [NSString stringWithFormat:@"window %ld is on no display", windowNumber]];
                    return;
                }
            } else {
                filter = [[[SCContentFilter alloc] initWithDesktopIndependentWindow:window] autorelease];
            }
            SCStreamConfiguration *config = recordingConfiguration(
                (size_t)(filter.contentRect.size.width * filter.pointPixelScale),
                (size_t)(filter.contentRect.size.height * filter.pointPixelScale));
            // 녹화 크기가 창과 다를 때 원인을 가릴 수 있도록 읽은 창 frame 과 준비한 출력 크기를 남긴다.
            sp_log_info("capture", [NSString stringWithFormat:@"prepared window %ld frame %@ filter %@ scale %g output %zux%zu",
                windowNumber, NSStringFromRect(NSRectFromCGRect(window.frame)),
                NSStringFromRect(NSRectFromCGRect(filter.contentRect)), filter.pointPixelScale,
                config.width, config.height].UTF8String);
            [result completeWithFilter:filter configuration:config error:nil];
            return;
        }
        [result completeWithFilter:nil configuration:nil error:
            [NSString stringWithFormat:@"window %ld not found", windowNumber]];
    }];
    long wait = dispatch_semaphore_wait(result.answered, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC));
    if (wait != 0) {
        [result release];
        return captureOperationFailure(errorOut, @"shareable content query timed out after 10000ms");
    }
    if (result.error != nil) {
        captureOperationFailure(errorOut, result.error);
        [result release];
        return false;
    }
    if (result.filter == nil || result.configuration == nil) {
        [result release];
        return captureOperationFailure(errorOut, @"capture preparation completed without filter or configuration");
    }
    if (captureStream != nil) {
        [result release];
        return captureOperationFailure(errorOut, @"capture became active during preparation");
    }
    captureConfig = [result.configuration retain];
    captureFilter = [result.filter retain];
    [result release];
    return true;
}

bool sp_capture_start(const char* directory, char **errorOut) {
    if (errorOut == NULL) {
        sp_log_error("capture start", "an error output is required");
        return false;
    }
    *errorOut = NULL;
    if (captureStream != nil) return captureOperationFailure(errorOut, @"capture is already running");
    clearCaptureError();
    if (captureFilter == nil) {
        setCaptureError(@"capture has no prepared window");
        sp_log_error("capture start", "capture has no prepared window");
        return captureOperationFailure(errorOut, @"capture has no prepared window");
    }
    if (directory == NULL) {
        setCaptureError(@"capture directory is null");
        return captureOperationFailure(errorOut, @"capture directory is null");
    }
    captureStartedAt = mach_absolute_time();
    captureLimitReached = false;
    @synchronized([SPCapture class]) {
        captureResizing = false;
        captureUpdating = false;
    }
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
        return captureOperationFailure(errorOut, @"capture directory is not valid UTF-8");
    }
    SCStream *stream = [[SCStream alloc] initWithFilter:captureFilter
                                       configuration:captureConfig
                                            delegate:captureSink];
    @synchronized([SPCapture class]) { captureStream = stream; }
    NSError* error = nil;
    captureQueue = dispatch_queue_create("sp.capture", NULL);
    [stream addStreamOutput:captureSink
                              type:SCStreamOutputTypeScreen
                sampleHandlerQueue:captureQueue
                             error:&error];
    if (error != nil) {
        NSString *message = [NSString stringWithFormat:@"capture output was not added: %@", error.localizedDescription];
        setCaptureError(message);
        sp_log_error("capture start", message.UTF8String);
        @synchronized([SPCapture class]) { captureStream = nil; }
        [stream release];
        return captureOperationFailure(errorOut,
            [NSString stringWithFormat:@"capture output was not added: %@", error.localizedDescription]);
    }
    // 복사된 완료 블록은 원래 스트림을 보유하여 교체 뒤에도 동일성을 유지한다.
    if (captureStartDone) dispatch_release(captureStartDone);
    captureStartDone = dispatch_semaphore_create(0);
    dispatch_semaphore_t startDone = captureStartDone;
    dispatch_retain(startDone);
    [stream startCaptureWithCompletionHandler:^(NSError* failed) {
        if (failed != nil) {
            reportCaptureStreamFailure(stream,
                [NSString stringWithFormat:@"capture did not start: %@", failed.localizedDescription]);
        }
        dispatch_semaphore_signal(startDone);
        dispatch_release(startDone);
    }];
    return true;
}

// 스트림 시작 요청이 완료될 때까지 기다린다. 기다린 신호는 다시 올려 이후 호출도 통과하게 한다.
static bool waitCaptureStart(int64_t milliseconds) {
    if (captureStartDone == NULL) {
        setCaptureError(@"capture start was not requested");
        return false;
    }
    if (dispatch_semaphore_wait(captureStartDone,
        dispatch_time(DISPATCH_TIME_NOW, milliseconds * NSEC_PER_MSEC)) != 0) {
        setCaptureError([NSString stringWithFormat:@"capture start did not complete within %lldms", milliseconds]);
        return false;
    }
    dispatch_semaphore_signal(captureStartDone);
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
    // 첫 프레임은 시작 완료보다 먼저 올 수 있다. 시작이 끝나야 녹화가 시작된 것이다.
    if (!waitCaptureStart(10000)) return 0;
    return hasCaptureError() ? 0 : 1;
}

// stream 을 멈추고 디스크에 기록된 프레임 수를 보고한다.
//
// 멈춤 응답은 다른 queue 에서 오며, 이미 넘겨진 프레임은 그동안 기록된다.
// 그 전에 개수를 읽으면 실제보다 적게 보고하고, 그때 프로세스가 종료되면
// 마지막 파일이 잘린 채 남는다.
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
        NSString *message = captureResizing
            ? @"no frame at the window's device-pixel size arrived within 1000ms after the requested display time"
            : @"no frame arrived within 1000ms after the requested display time";
        setCaptureError(message);
        sp_log_error("capture stop", message.UTF8String);
    }
    dispatch_sync(captureQueue, ^{
        captureCaughtUp = NULL;
        captureStopAfter = 0;
    });
    dispatch_release(caughtUp);
    // 시작이 끝나기 전의 종료 요청은 거부되므로 시작 완료 뒤에 멈춘다.
    waitCaptureStart(5000);
    dispatch_semaphore_t stopped = dispatch_semaphore_create(0);
    // 완료 블록은 제한 시간이 지난 뒤에도 올 수 있다. 블록이 신호의 참조 하나를 소유하고, 오류는 그 스트림이
    // 아직 현재 녹화일 때만 녹화 오류가 된다. 복사된 블록이 스트림을 보유하므로 주소가 재사용되지 않는다.
    dispatch_retain(stopped);
    [stream stopCaptureWithCompletionHandler:^(NSError* failed) {
        if (failed != nil) {
            reportCaptureStreamFailure(stream,
                [NSString stringWithFormat:@"capture did not stop: %@", failed.localizedDescription]);
        }
        dispatch_semaphore_signal(stopped);
        dispatch_release(stopped);
    }];
    if (dispatch_semaphore_wait(stopped, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) != 0) {
        setCaptureError(@"capture stop did not complete within 5000ms");
    }
    dispatch_sync(captureQueue, ^{});
    // 복사해 둔 프레임을 모두 쓴 뒤 센다.
    dispatch_sync(captureWriter, ^{});
    @synchronized([SPCapture class]) { captureStream = nil; }
    dispatch_release(captureQueue);
    dispatch_release(stopped);
    [stream release];
    // 기록되지 않은 프레임의 이유를 남긴다. blank 는 창이 보이지 않고, suspended 는 스트림이 멈췄다.
    int *counts = captureSink.statuses;
    mach_timebase_info_data_t timebase;
    mach_timebase_info(&timebase);
    sp_log_info("capture", [NSString stringWithFormat:@"%d complete frames received, %d written, %d rejected for pending writer capacity, "
        "slowest write %.1fms, longest display gap %.1fms",
        captureSink.complete, captureSink.written - captureBefore, captureSink.rejected, captureSink.slowestWrite * 1000,
        (double)captureSink.longestGap * timebase.numer / timebase.denom / 1e6].UTF8String);
    if (counts[SCFrameStatusBlank] || counts[SCFrameStatusSuspended]) {
        sp_log_info("capture", [NSString stringWithFormat:@"%d blank and %d suspended frames were not written",
            counts[SCFrameStatusBlank], counts[SCFrameStatusSuspended]].UTF8String);
    }
    if (captureSink.written == captureBefore && captureSink.idle > 0) {
        sp_log_info("capture", [NSString stringWithFormat:@"the window was not redrawn during %d frames; "
            "the display is off or the window is not on screen", captureSink.idle].UTF8String);
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
    if (error != nil) sp_log_error("still capture", error.UTF8String);
    dispatch_semaphore_signal(self.answered);
}
- (void)dealloc {
    [_error release];
    dispatch_release(_answered);
    [super dealloc];
}
@end


bool sp_capture_still(long windowNumber, const char *path, char **errorOut) {
    if (errorOut == NULL) {
        sp_log_error("still capture", "an error output is required");
        return false;
    }
    *errorOut = NULL;
    if (path == NULL) {
        return captureOperationFailure(errorOut, @"still capture needs a path");
    }
    NSString *decoded = [NSString stringWithUTF8String:path];
    if (decoded == nil) return captureOperationFailure(errorOut, @"still capture path is not valid UTF-8");
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
        return captureOperationFailure(errorOut, @"still capture timed out after 10000ms");
    }
    bool written = result.written;
    if (!written) captureOperationFailure(errorOut, result.error);
    [result release];
    return written;
}

double sp_capture_clock(void) {
    mach_timebase_info_data_t timebase;
    mach_timebase_info(&timebase);
    return (double)mach_absolute_time() * timebase.numer / timebase.denom / 1e6;
}
