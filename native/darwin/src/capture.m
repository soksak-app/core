// Records the application windows with a ScreenCaptureKit stream.
//
// The window server composites the page, the surfaces, and the modals, so the composite is what is measured. A
// screenshot
// requested one at a time returns a composite made at the time of the request, so a state that lasts one frame
// between a resize
// and the next render is not captured. The stream delivers the frames that the compositor presented
// as they are.
//
// CGWindowListCreateImage is rejected at compile time from macOS 15. ScreenCaptureKit is the
// replacement interface.
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
// Completion of the stream start request. ScreenCaptureKit can deliver the first frame before the start completes,
// and a
// stop request before the start finishes is rejected as a stream that already stopped (SCStreamErrorDomain -3808).
static dispatch_semaphore_t captureStartDone;
// The stop request time (mach absolute time) and the signal that a frame presented after it has arrived.
static uint64_t captureStopAfter;
static dispatch_semaphore_t captureCaughtUp;
static dispatch_queue_t captureQueue;
static int captureBefore;
// The serial queue that writes frames to disk, and the upper limit of frames that wait to be written.
static dispatch_queue_t captureWriter;
static dispatch_semaphore_t capturePending;
static const long kCapturePending = 64;
// A diagnostic recording is a short bounded continuous record, not an unbounded video output.
// Reaching the limit is reported as an incomplete recording. Frames are not dropped without notice and
// then accepted as a pass.
static const int kCaptureMaxFrames = 600;
// ScreenCaptureKit can deliver idle and incomplete callbacks between recorded images. Keep a bounded timeline so a display-time gap
// can be classified; a full timeline is a capture failure rather than silently omitted evidence.
static const int kCaptureMaxCallbackStatusRecords = 4096;
static bool captureLimitReached;
// Frames presented before the capture request do not belong to the measured gesture.
// ScreenCaptureKit can deliver one cached frame when the stream starts.
// Only frames whose display time is at or after this boundary time (including the same time) are kept.
static uint64_t captureStartedAt;
// True if the buffer of a completed frame differs from the device pixel size of the window. The stop waits until the
// stream
// sends a frame with the new output size. captureUpdating is true while a stream configuration change is requested
// and awaited.
static bool captureResizing;
static bool captureUpdating;
static void followWindowSize(size_t width, size_t height, size_t needWidth, size_t needHeight);

// Receives frames and writes them to files. The frames are delivered as messages, so a receiver object is required.
@interface SPCapture : NSObject <SCStreamOutput, SCStreamDelegate>
@property (nonatomic, copy) NSString* directory;
@property (nonatomic, retain) NSMutableArray<NSDictionary *> *callbackStatusTrace;
@property (nonatomic) BOOL callbackStatusTraceOverflowed;
@property (nonatomic) int written;
@property (nonatomic) int idle;
// The count of incomplete frames per status. The index is an SCFrameStatus value.
@property (nonatomic) int *statuses;
// The count of received complete frames, the count queued for writing, the count rejected by the write queue limit,
// the slowest write (seconds),
// and the longest display interval between consecutive complete frames (mach time). The write queue changes written
// and slowestWrite.
@property (nonatomic) int complete;
@property (nonatomic) int queued;
@property (nonatomic) int rejected;
@property (nonatomic) double slowestWrite;
@property (nonatomic) uint64_t lastShown;
@property (nonatomic) uint64_t longestGap;
- (BOOL)recordCallbackStatus:(SCFrameStatus)status hasStatus:(BOOL)hasStatus displayTime:(uint64_t)shown hasDisplayTime:(BOOL)hasDisplayTime;
@end

// frameInfo reads the value of key from the information dictionary attached to a frame. It is NULL if the dictionary
// or the value is missing.
static CFTypeRef frameInfo(CMSampleBufferRef sample, SCStreamFrameInfo key) {
    CFArrayRef list = CMSampleBufferGetSampleAttachmentsArray(sample, false);
    if (list == NULL || CFArrayGetCount(list) == 0) return NULL;
    return CFDictionaryGetValue(CFArrayGetValueAtIndex(list, 0), (__bridge CFStringRef)key);
}

// displayTime reads the mach absolute time at which the frame was presented on the screen. It returns NO if there is
// no time.
static BOOL displayTime(CMSampleBufferRef sample, uint64_t *value) {
    CFTypeRef time = frameInfo(sample, SCStreamFrameInfoDisplayTime);
    return time != NULL && CFGetTypeID(time) == CFNumberGetTypeID()
        && CFNumberGetValue(time, kCFNumberSInt64Type, value);
}

// frameNumber reads the numeric information attached to a frame. It returns NO if there is no value.
static BOOL frameNumber(CMSampleBufferRef sample, SCStreamFrameInfo key, double *number) {
    CFTypeRef value = frameInfo(sample, key);
    return value != NULL && CFGetTypeID(value) == CFNumberGetTypeID()
        && CFNumberGetValue(value, kCFNumberDoubleType, number);
}

// contentRect reads the rectangle in which the window is drawn inside the buffer (in buffer points). It returns NO if
// there is no rectangle.
static BOOL contentRect(CMSampleBufferRef sample, CGRect *rect) {
    CFTypeRef value = frameInfo(sample, SCStreamFrameInfoContentRect);
    return value != NULL && CFGetTypeID(value) == CFDictionaryGetTypeID()
        && CGRectMakeWithDictionaryRepresentation(value, rect);
}

// frameStatus reads the status attached to a frame. It returns NO if there is no status.
static BOOL frameStatus(CMSampleBufferRef sample, SCFrameStatus *status) {
    CFTypeRef value = frameInfo(sample, SCStreamFrameInfoStatus);
    int number = 0;
    if (value == NULL || CFGetTypeID(value) != CFNumberGetTypeID()
        || !CFNumberGetValue(value, kCFNumberIntType, &number)) return NO; // silent: the answer NO is the result of the reader, and its caller records the capture error "has no status"
    *status = (SCFrameStatus)number;
    return YES;
}

// Reports the cause saved right after a file operation together with the path. A following cleanup error is added
// too.
static void reportCaptureFileFailure(int number, NSString *operation, NSString *path, int error) {
    NSString *message = [NSString stringWithFormat:@"frame %d was not written: %@ %@: %s",
        number, operation, path, strerror(error)];
    setCaptureError(message);
    sp_log_error("capture", message.UTF8String);
}

@implementation SPCapture

- (instancetype)init {
    self = [super init];
    if (self) _callbackStatusTrace = [[NSMutableArray alloc] init];
    return self;
}

- (void)dealloc {
    [_callbackStatusTrace release];
    [_directory release];
    [super dealloc];
}

- (BOOL)recordCallbackStatus:(SCFrameStatus)status hasStatus:(BOOL)hasStatus displayTime:(uint64_t)shown hasDisplayTime:(BOOL)hasDisplayTime {
    if (self.callbackStatusTrace.count >= kCaptureMaxCallbackStatusRecords) {
        if (!self.callbackStatusTraceOverflowed) {
            self.callbackStatusTraceOverflowed = YES;
            setCaptureError([NSString stringWithFormat:@"capture callback status trace capacity exceeded (%d records)",
                kCaptureMaxCallbackStatusRecords]);
        }
        return NO;
    }
    id statusValue = hasStatus ? @((int)status) : [NSNull null];
    id timeValue = hasDisplayTime ? [NSString stringWithFormat:@"%llu", (unsigned long long)shown] : [NSNull null];
    [self.callbackStatusTrace addObject:[NSMutableDictionary dictionaryWithDictionary:@{
        @"sequence": @(self.callbackStatusTrace.count + 1),
        @"status": statusValue,
        @"displayTime": timeValue,
        @"frame": [NSNull null],
    }]];
    return YES;
}

- (void)stream:(SCStream*)stream
    didOutputSampleBuffer:(CMSampleBufferRef)sample
                   ofType:(SCStreamOutputType)type {
    if (type != SCStreamOutputTypeScreen) return;
    [self write:sample];
    // A frame presented after the stop request means that the screen up to that time has been fully delivered, even
    // if it is idle.
    // A complete frame without a time is left as a recording error by write:, and the stop reports that error.
    // While the stream follows the window size, the stop is deferred until a frame of the new size arrives.
    uint64_t shown = 0;
    if (captureCaughtUp != NULL && captureStopAfter != 0 && !captureResizing && displayTime(sample, &shown)
        && shown >= captureStopAfter) {
        captureStopAfter = 0;
        dispatch_semaphore_signal(captureCaughtUp);
    }
}

- (void)write:(CMSampleBufferRef)sample {
    // If the window is not redrawn, frames keep arriving at the fixed interval but are all
    // marked idle and have no image. Counting them makes it possible to state why there are 0 frames.
    // A frame without a status cannot be known to be complete, so the recording fails.
    SCFrameStatus status = SCFrameStatusComplete;
    BOOL hasStatus = frameStatus(sample, &status);
    uint64_t shown = 0;
    BOOL hasDisplayTime = displayTime(sample, &shown);
    if (![self recordCallbackStatus:status hasStatus:hasStatus displayTime:shown hasDisplayTime:hasDisplayTime]) return;
    if (!hasStatus) {
        if (!hasCaptureError()) setCaptureError([NSString stringWithFormat:@"frame %d has no status", self.queued + 1]);
        return;
    }
    if (status != SCFrameStatusComplete) {
        if (status == SCFrameStatusIdle) self.idle++;
        if ((int)status >= 0 && (int)status < 6) self.statuses[status]++;
        return;
    }
    if (hasCaptureError()) return;
    // The image, display time, window rectangle, and scale of a complete frame are required to measure the frame, so
    // the recording fails if any is missing.
    int number = self.queued + 1;
    CVImageBufferRef buffer = CMSampleBufferGetImageBuffer(sample);
    if (buffer == NULL) {
        setCaptureError([NSString stringWithFormat:@"frame %d has no image buffer", number]);
        return;
    }
    if (!hasDisplayTime) {
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
    // The stream output size is the window size at the start. If the window grows, frames are reduced (content scale
    // < 1), and if it shrinks,
    // the buffer has spare area. If the device pixel size of the window differs from the buffer, the output size is
    // changed. Frames before the
    // change are also recorded and are distinguished by the content scale of the header.
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
    // If the sample callback waits for a write, the stream loses the next frame. When the queue capacity is
    // exhausted,
    // the recording itself fails, and the next callback and the delivery of the stop time are not blocked.
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
    // Measuring a window whose size changes requires the drawn area, the scale, and the display time of each frame.
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
    NSMutableDictionary *callbackRecord = (NSMutableDictionary *)self.callbackStatusTrace.lastObject;
    callbackRecord[@"frame"] = path.lastPathComponent;
    dispatch_async(captureWriter, ^{
        CFTimeInterval began = CACurrentMediaTime();
        // Preserves the header and compresses all pixels and row padding losslessly.
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
            // A path that could not be opened is not owned by this write, so it is not deleted.
            reportCaptureFileFailure(number, @"open", pending, errno);
        } else {
            bool whole = fwrite(encoded, 80 + compressed, 1, file) == 1;
            if (!whole) reportCaptureFileFailure(number, @"write", pending, errno);
            // Closes also after a write failure. Each of the two failures preserves its original system error.
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

// The value that all captures use. The window list query of the window server is much slower than one frame, so
// it is queried only once.
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

// Errors of the previous stream are also reported but do not change the result of the current recording.
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

static NSString *const kCaptureCallbackStatusFile = @"callback-status.jsonl";

static bool writeCaptureCallbackStatusTrace(SPCapture *sink) {
    NSMutableData *contents = [NSMutableData data];
    NSUInteger recordNumber = 0;
    for (NSDictionary *record in sink.callbackStatusTrace) {
        recordNumber++;
        NSError *error = nil;
        NSData *line = nil;
        NSString *encodingFailure = nil;
        @try {
            line = [NSJSONSerialization dataWithJSONObject:record options:0 error:&error];
        } @catch (NSException *exception) {
            encodingFailure = exception.reason ?: exception.name;
        }
        if (line == nil) {
            NSString *reason = encodingFailure ?: error.localizedDescription ?: @"no encoding error was provided";
            NSString *message = [NSString stringWithFormat:@"capture callback status trace could not encode record %lu: %@",
                (unsigned long)recordNumber, reason];
            setCaptureError(message);
            sp_log_error("capture callback status", message.UTF8String);
            return false;
        }
        [contents appendData:line];
        [contents appendBytes:"\n" length:1];
    }
    NSString *path = [sink.directory stringByAppendingPathComponent:kCaptureCallbackStatusFile];
    NSError *error = nil;
    if (![contents writeToFile:path options:NSDataWritingAtomic error:&error]) {
        NSString *reason = error.localizedDescription ?: @"no write error was provided";
        NSString *message = [NSString stringWithFormat:@"capture callback status trace could not write %@: %@",
            path, reason];
        setCaptureError(message);
        sp_log_error("capture callback status", message.UTF8String);
        return false;
    }
    return true;
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


// The result of asynchronous preparation is owned only by the callback of that query. The waiting caller publishes
// the global target.
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

// Recording stream configuration. Device pixels and sRGB are kept so that the coordinates and colors of thin lines
// are measured as they are.
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

// If the buffer size width×height differs from the device pixel size needWidth×needHeight of the window, the output
// size of the current stream is
// changed. No new request is made while a change is awaited, and if it still differs after the change, the next frame
// requests again.
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
    // Releases the inactive preparation ownership so that a failed query is not followed by a recording of the
    // previous target.
    [captureFilter release]; captureFilter = nil;
    [captureConfig release]; captureConfig = nil;
    SPCapturePreparation *result = [[SPCapturePreparation alloc] init];
    // Only the windows of this process are queried, so the screen recording permission path of other applications is
    // not relied on.
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
                // Only the windows of this application are captured from the display that holds the center of the
                // window.
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
            // Keeps the window frame that was read and the output size that was prepared so that the cause can be
            // identified when the recording size differs from the window.
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
    // The receiver object is created only once. If it were created for each recording, the frame numbers would
    // start again from 1 and overwrite the files written by an earlier recording.
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
    captureSink.callbackStatusTraceOverflowed = NO;
    [captureSink.callbackStatusTrace removeAllObjects];
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
    // The copied completion block retains the original stream, so its identity is kept after a replacement.
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

// Waits until the stream start request completes. The awaited signal is raised again so that later calls also pass.
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
    // The first frame can arrive before the start completes. The recording has started only when the start finishes.
    if (!waitCaptureStart(10000)) return 0;
    return hasCaptureError() ? 0 : 1;
}

// Stops the stream and reports the number of frames recorded on disk.
//
// The stop reply arrives on another queue, and frames already handed over are recorded in the meantime.
// Reading the count before that reports fewer than the actual number, and if the process exits then,
// the last file remains truncated.
int sp_capture_stop(double after) {
    if (captureStream == nil) {
        setCaptureError(@"capture is not running");
        return 0;
    }
    SCStream* stream = captureStream;
    // Stops after the screen presented up to the later of the call time and after has been fully delivered to the
    // stream. The content committed by the
    // application can be presented later than the call, so the caller passes its display time. The stream delivers
    // idle frames every minimumFrameInterval
    // even if the screen does not change, so the wait ends within one interval.
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
    // A stop request before the start finishes is rejected, so the stop happens after the start completes.
    waitCaptureStart(5000);
    dispatch_semaphore_t stopped = dispatch_semaphore_create(0);
    // The completion block can arrive after the time limit has passed. The block owns one reference of the signal,
    // and an error becomes a recording error
    // only while that stream is still the current recording. The copied block retains the stream, so the address is
    // not reused.
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
    // Counts after all copied frames have been written.
    dispatch_sync(captureWriter, ^{});
    if (!writeCaptureCallbackStatusTrace(captureSink) && !hasCaptureError()) {
        setCaptureError(@"capture callback status trace failed without a reason");
    }
    @synchronized([SPCapture class]) { captureStream = nil; }
    dispatch_release(captureQueue);
    dispatch_release(stopped);
    [stream release];
    // Records the reason for frames that were not recorded. blank means the window is not visible, and suspended
    // means the stream stopped.
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

// The asynchronous state of a still capture is owned only by the callback of that call.
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
    // An error that arrives after the caller returned because of a timeout is also reported to the log.
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
        // The observation image keeps device pixels.
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
