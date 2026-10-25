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
#import "image_capture_match.h"
#import "image_region.h"
#import "application_log.h"
#import "event_ring.h"
#import <ImageIO/ImageIO.h>
#include <math.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <objc/runtime.h>
#include <compression.h>
#include <zlib.h>

static void setCaptureError(NSString* message);
static bool hasCaptureError(void);
static void reportCaptureStreamFailure(SCStream *stream, NSString *message, NSError *error);

static dispatch_semaphore_t captureFirstFrame;
// Completion of the stream start request. ScreenCaptureKit can deliver the first frame before the start completes,
// and a
// stop request before the start finishes is rejected as a stream that already stopped (SCStreamErrorDomain -3808).
static dispatch_semaphore_t captureStartDone;
// The stop request time (mach absolute time) and the signal that a frame presented after it has arrived.
static uint64_t captureStopAfter;
static dispatch_semaphore_t captureCaughtUp;
static dispatch_queue_t captureQueue;
static SCStream* captureStream = nil;
static BOOL captureAcceptingSamples = NO;
static int captureBefore;
static long captureWindowNumber;
// The serial queue that writes frames to disk, and the upper limit of frames that wait to be written.
static dispatch_queue_t captureWriter;
static dispatch_semaphore_t capturePending;
static const long kCapturePending = 64;
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
static uint64_t (*captureRawClock)(void) = mach_absolute_time;
static kern_return_t (*captureReadTimebase)(mach_timebase_info_data_t *) = mach_timebase_info;
static CVReturn (*captureLockBaseAddress)(CVPixelBufferRef, CVPixelBufferLockFlags) = CVPixelBufferLockBaseAddress;
static CVReturn (*captureUnlockBaseAddress)(CVPixelBufferRef, CVPixelBufferLockFlags) = CVPixelBufferUnlockBaseAddress;
static void *(*captureGetBaseAddress)(CVPixelBufferRef) = CVPixelBufferGetBaseAddress;
static void (*captureDisplayLinkAfterWindowLookup)(NSWindow *window);

@class SPCaptureAttempt;
static char captureAttemptAssociationKey;
static uint64_t captureAttemptSequence;
static SPCaptureAttempt* captureAttempt = nil;

@interface SPCaptureAttempt : NSObject
@property (nonatomic, copy) NSString *session;
@property (nonatomic) long windowNumber;
@property (nonatomic) uint64_t requestMachTicks;
@property (nonatomic) mach_timebase_info_data_t timebase;
@property (nonatomic) BOOL startCompletionSeen;
@property (nonatomic) BOOL firstSampleSeen;
@property (nonatomic) BOOL delegateStopSeen;
@property (nonatomic) BOOL failed;
@property (nonatomic, retain) NSNumber *stopAfterMilliseconds;
@property (nonatomic) uint64_t stopTargetMachTicks;
@property (nonatomic) uint64_t stopRegistrationMachTicks;
@property (nonatomic) BOOL stopBoundaryRecorded;
@property (nonatomic) uint64_t latestSampleCallbackMachTicks;
@property (nonatomic) BOOL latestSampleStatusPresent;
@property (nonatomic, retain) NSNumber *latestSampleStatus;
@property (nonatomic) BOOL latestSampleDisplayTimePresent;
@property (nonatomic) uint64_t latestSampleDisplayTimeMachTicks;
@property (nonatomic) uint64_t factsObservedMachTicks;
@property (nonatomic, retain) NSNumber *visible;
@property (nonatomic, retain) NSNumber *occluded;
@property (nonatomic, retain) NSNumber *displayID;
@property (nonatomic, retain) NSNumber *applicationActive;
- (void)emit:(NSString *)phase level:(uint8_t)level callbackMachTicks:(NSNumber *)callbackMachTicks
    sampleType:(NSNumber *)sampleType statusPresent:(BOOL)statusPresent status:(NSNumber *)status
    displayTimePresent:(BOOL)displayTimePresent displayTimeMachTicks:(id)displayTimeMachTicks
    error:(NSError *)error reason:(NSString *)reason;
- (void)recordFirstSampleType:(SCStreamOutputType)type statusPresent:(BOOL)statusPresent status:(SCFrameStatus)status
    displayTimePresent:(BOOL)displayTimePresent displayTimeMachTicks:(uint64_t)displayTimeMachTicks
    callbackMachTicks:(uint64_t)callbackMachTicks;
- (void)recordStopBoundaryAfterMilliseconds:(double)after targetMachTicks:(uint64_t)targetMachTicks
    registrationMachTicks:(uint64_t)registrationMachTicks;
- (void)recordLatestSampleStatusPresent:(BOOL)statusPresent status:(SCFrameStatus)status
    displayTimePresent:(BOOL)displayTimePresent displayTimeMachTicks:(uint64_t)displayTimeMachTicks
    callbackMachTicks:(uint64_t)callbackMachTicks;
- (void)recordWindowNumber:(long)windowNumber displayID:(NSNumber *)displayID visible:(BOOL)visible
    occluded:(BOOL)occluded applicationActive:(BOOL)applicationActive callbackMachTicks:(uint64_t)callbackMachTicks;
- (void)recordFailure:(NSString *)reason error:(NSError *)error;
@end

@implementation SPCaptureAttempt
- (void)emit:(NSString *)phase level:(uint8_t)level callbackMachTicks:(NSNumber *)callbackMachTicks
    sampleType:(NSNumber *)sampleType statusPresent:(BOOL)statusPresent status:(NSNumber *)status
    displayTimePresent:(BOOL)displayTimePresent displayTimeMachTicks:(id)displayTimeMachTicks
    error:(NSError *)error reason:(NSString *)reason {
    if (!sp_event_gate(SP_CLASS_LIFECYCLE, level)) return;
    @synchronized (self) {
        id null = [NSNull null];
        NSString *callbackMachTickString = callbackMachTicks == nil ? nil :
            [NSString stringWithFormat:@"%llu", callbackMachTicks.unsignedLongLongValue];
        NSDictionary *facts = @{
            @"factsObservedMachTicks": self.factsObservedMachTicks == 0 ? null :
                [NSString stringWithFormat:@"%llu", (unsigned long long)self.factsObservedMachTicks],
            @"visible": self.visible ?: null, @"occluded": self.occluded ?: null,
            @"displayID": self.displayID ?: null, @"applicationActive": self.applicationActive ?: null,
        };
        NSDictionary *fields = @{
            @"session": self.session, @"phase": phase,
            @"windowNumber": @(self.windowNumber),
            @"requestMachTicks": self.requestMachTicks == 0 ? null :
                [NSString stringWithFormat:@"%llu", (unsigned long long)self.requestMachTicks],
            @"callbackMachTicks": callbackMachTickString ?: null,
            @"elapsedMachTicks": callbackMachTickString == nil ? null :
                [NSString stringWithFormat:@"%llu", (unsigned long long)(callbackMachTicks.unsignedLongLongValue - self.requestMachTicks)],
            @"machTimebaseNumerator": self.timebase.numer ? @(self.timebase.numer) : null,
            @"machTimebaseDenominator": self.timebase.denom ? @(self.timebase.denom) : null,
            @"sampleType": sampleType ?: null, @"statusPresent": @(statusPresent),
            @"status": statusPresent ? (id)status : null,
            @"displayTimePresent": @(displayTimePresent), @"displayTimeMachTicks": displayTimeMachTicks ?: null,
            @"errorDomain": error.domain ?: null, @"errorCode": error == nil ? null : @(error.code),
            @"reason": reason ?: null,
            @"startCompletionSeen": @(self.startCompletionSeen), @"firstSampleSeen": @(self.firstSampleSeen),
            @"delegateStopSeen": @(self.delegateStopSeen),
            @"stopAfterMilliseconds": self.stopAfterMilliseconds ?: null,
            @"stopTargetMachTicks": self.stopBoundaryRecorded
                ? [NSString stringWithFormat:@"%llu", (unsigned long long)self.stopTargetMachTicks] : null,
            @"stopRegistrationMachTicks": self.stopBoundaryRecorded
                ? [NSString stringWithFormat:@"%llu", (unsigned long long)self.stopRegistrationMachTicks] : null,
            @"latestSampleCallbackMachTicks": self.latestSampleCallbackMachTicks == 0 ? null
                : [NSString stringWithFormat:@"%llu", (unsigned long long)self.latestSampleCallbackMachTicks],
            @"latestSampleStatusPresent": @(self.latestSampleStatusPresent),
            @"latestSampleStatus": self.latestSampleStatus ?: null,
            @"latestSampleDisplayTimePresent": @(self.latestSampleDisplayTimePresent),
            @"latestSampleDisplayTimeMachTicks": self.latestSampleDisplayTimePresent
                ? [NSString stringWithFormat:@"%llu", (unsigned long long)self.latestSampleDisplayTimeMachTicks] : null,
        };
        NSMutableDictionary *record = [NSMutableDictionary dictionaryWithDictionary:fields];
        [record addEntriesFromDictionary:facts];
        NSError *encodingError = nil;
        NSData *data = [NSJSONSerialization dataWithJSONObject:record options:0 error:&encodingError];
        if (data == nil || !sp_event(SP_CLASS_LIFECYCLE, level, "native.capture.lifecycle",
            data == nil ? "{}" : [[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] autorelease].UTF8String)) {
            NSString *message = data == nil ? [NSString stringWithFormat:@"capture lifecycle event encoding failed: %@", encodingError]
                : @"capture lifecycle event was not stored";
            sp_log_error("capture lifecycle", message.UTF8String);
        }
    }
}
- (void)recordFirstSampleType:(SCStreamOutputType)type statusPresent:(BOOL)statusPresent status:(SCFrameStatus)status
    displayTimePresent:(BOOL)displayTimePresent displayTimeMachTicks:(uint64_t)displayTimeMachTicks
    callbackMachTicks:(uint64_t)callbackMachTicks {
    @synchronized (self) { if (self.firstSampleSeen) return; self.firstSampleSeen = YES; }
    [self emit:@"first-sample" level:SP_EVENT_DEBUG callbackMachTicks:@(callbackMachTicks)
        sampleType:@(type) statusPresent:statusPresent status:statusPresent ? @(status) : nil
        displayTimePresent:displayTimePresent displayTimeMachTicks:displayTimePresent ?
            [NSString stringWithFormat:@"%llu", (unsigned long long)displayTimeMachTicks] : nil error:nil reason:nil];
}
- (void)recordStopBoundaryAfterMilliseconds:(double)after targetMachTicks:(uint64_t)targetMachTicks
    registrationMachTicks:(uint64_t)registrationMachTicks {
    @synchronized (self) {
        self.stopAfterMilliseconds = isfinite(after) ? @(after) : nil;
        self.stopTargetMachTicks = targetMachTicks;
        self.stopRegistrationMachTicks = registrationMachTicks;
        self.stopBoundaryRecorded = YES;
    }
}
- (void)recordLatestSampleStatusPresent:(BOOL)statusPresent status:(SCFrameStatus)status
    displayTimePresent:(BOOL)displayTimePresent displayTimeMachTicks:(uint64_t)displayTimeMachTicks
    callbackMachTicks:(uint64_t)callbackMachTicks {
    @synchronized (self) {
        if (!self.stopBoundaryRecorded || self.failed) return;
        self.latestSampleCallbackMachTicks = callbackMachTicks;
        self.latestSampleStatusPresent = statusPresent;
        self.latestSampleStatus = statusPresent ? @(status) : nil;
        self.latestSampleDisplayTimePresent = displayTimePresent;
        self.latestSampleDisplayTimeMachTicks = displayTimePresent ? displayTimeMachTicks : 0;
    }
}
- (void)recordWindowNumber:(long)windowNumber displayID:(NSNumber *)displayID visible:(BOOL)visible
    occluded:(BOOL)occluded applicationActive:(BOOL)applicationActive callbackMachTicks:(uint64_t)callbackMachTicks {
    if (windowNumber != self.windowNumber || !NSThread.isMainThread) return;
    @synchronized (self) {
        self.factsObservedMachTicks = callbackMachTicks;
        self.visible = @(visible); self.occluded = @(occluded);
        self.displayID = displayID; self.applicationActive = @(applicationActive);
    }
}
- (void)recordFailure:(NSString *)reason error:(NSError *)error {
    @synchronized (self) { if (self.failed) return; self.failed = YES; }
    [self emit:@"failed" level:SP_EVENT_ERROR callbackMachTicks:@(mach_absolute_time()) sampleType:nil
        statusPresent:NO status:nil displayTimePresent:NO displayTimeMachTicks:nil error:error reason:reason];
}
- (void)dealloc {
    [_session release]; [_visible release]; [_occluded release]; [_displayID release]; [_applicationActive release];
    [_stopAfterMilliseconds release]; [_latestSampleStatus release];
    [super dealloc];
}
@end

static SPCaptureAttempt *captureAttemptForStream(SCStream *stream) {
    return stream == nil ? nil : objc_getAssociatedObject(stream, &captureAttemptAssociationKey);
}


// Receives frames and writes them to files. The frames are delivered as messages, so a receiver object is required.
@interface SPCapture : NSObject <SCStreamOutput, SCStreamDelegate>
@property (nonatomic, copy) NSString* directory;
@property (nonatomic, retain) NSMutableArray<NSDictionary *> *callbackStatusTrace;
// The frame writer owns these immutable rows until finalization copies them on that serial queue.
@property (nonatomic, retain) NSMutableDictionary<NSString *, NSDictionary *> *frameWriterTimes;
@property (nonatomic, retain) NSMutableArray<NSDictionary *> *displayLinkObservations;
@property (nonatomic, retain) CADisplayLink *displayLink;
@property (nonatomic, retain) NSWindow *displayWindow;
@property (nonatomic, retain) SPCaptureAttempt *displayAttempt;
@property (nonatomic, copy) NSString *displayLinkState;
@property (nonatomic, copy) NSString *displayLinkReason;
@property (nonatomic) NSUInteger omittedDisplayLinkObservations;
@property (nonatomic) BOOL displayLinkStopped;
@property (nonatomic) BOOL displayLinkInvalidated;
@property (nonatomic) uint64_t lastDisplayLinkTimestampMach;
@property (nonatomic) uint64_t lastDisplayLinkCallbackTime;
@property (nonatomic) uint32_t displayLinkTimebaseNumerator;
@property (nonatomic) uint32_t displayLinkTimebaseDenominator;
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
@property (nonatomic) BOOL latestCallbackSeen;
@property (nonatomic) uint64_t latestCallbackMachTicks;
@property (nonatomic) BOOL latestCallbackStatusPresent;
@property (nonatomic) SCFrameStatus latestCallbackStatus;
@property (nonatomic) BOOL latestCallbackDisplayTimePresent;
@property (nonatomic) uint64_t latestCallbackDisplayTimeMachTicks;
- (BOOL)recordCallbackStatus:(SCFrameStatus)status hasStatus:(BOOL)hasStatus displayTime:(uint64_t)shown
    hasDisplayTime:(BOOL)hasDisplayTime callbackTime:(uint64_t)callbackTime writeStartTime:(uint64_t)writeStartTime
    timebase:(mach_timebase_info_data_t)timebase;
- (void)startDisplayLinkObservationForWindowNumber:(long)windowNumber;
- (void)stopDisplayLinkObservation;
- (void)invalidateDisplayLink:(CADisplayLink *)link window:(NSWindow *)window;
- (void)recordDisplayLinkTimestamp:(double)timestamp targetTimestamp:(double)targetTimestamp duration:(double)duration
    callbackTime:(uint64_t)callbackTime mediaClockTime:(double)mediaClockTime mediaClockAfter:(uint64_t)mediaClockAfter
    timebase:(mach_timebase_info_data_t)timebase windowNumber:(long)windowNumber
    displayID:(NSNumber *)displayID visible:(BOOL)visible occluded:(BOOL)occluded applicationActive:(BOOL)applicationActive;
- (void)rejectDisplayLinkObservation:(NSString *)reason;
- (NSDictionary *)displayLinkRecord;
- (void)write:(CMSampleBufferRef)sample callbackTime:(uint64_t)callbackTime;
- (void)processSample:(CMSampleBufferRef)sample status:(SCFrameStatus)status hasStatus:(BOOL)hasStatus
    displayTime:(uint64_t)shown hasDisplayTime:(BOOL)hasDisplayTime;
@end

static void closeCaptureSampleIntake(SCStream *stream) {
    @synchronized ([SPCapture class]) {
        if (captureStream == stream) captureAcceptingSamples = NO;
    }
}

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

static BOOL screenRect(CMSampleBufferRef sample, CGRect *rect) {
    CFTypeRef value = frameInfo(sample, SCStreamFrameInfoScreenRect);
    return value != NULL && CFGetTypeID(value) == CFDictionaryGetTypeID()
        && CGRectMakeWithDictionaryRepresentation(value, rect);
}

static NSDictionary *captureRectRecord(CGRect rect) {
    return @{ @"x": @(CGRectGetMinX(rect)), @"y": @(CGRectGetMinY(rect)),
        @"width": @(CGRectGetWidth(rect)), @"height": @(CGRectGetHeight(rect)) };
}

static NSDictionary *imageMatchRecord(sp_image_capture_match_result result, double processingMilliseconds,
    size_t frameWidth, size_t frameHeight, size_t frameStride, CGRect contentRect, CGRect screenRect,
    BOOL hasScreenRect, double contentScale, double scaleFactor, uint32_t pixelFormat, const char *colorSpace) {
    NSMutableArray *candidates = [NSMutableArray arrayWithCapacity:result.candidate_count];
    for (size_t index = 0; index < result.candidate_count; index++) {
        sp_image_capture_identity identity = result.candidates[index];
        [candidates addObject:@{ @"generation": [NSString stringWithFormat:@"%llu", (unsigned long long)identity.generation],
            @"raster": [NSString stringWithFormat:@"%llu", (unsigned long long)identity.raster],
            @"sequence": @(identity.sequence) }];
    }
    NSDictionary *source = result.has_latest_source ? @{ @"generation": [NSString stringWithFormat:@"%llu", (unsigned long long)result.latest_source.generation],
        @"raster": [NSString stringWithFormat:@"%llu", (unsigned long long)result.latest_source.raster],
        @"sequence": @(result.latest_source.sequence), @"width": @(result.latest_width), @"height": @(result.latest_height),
        @"stride": @(result.latest_stride), @"scale": @(result.latest_scale),
        @"colorSpace": result.latest_color_space[0] ? [NSString stringWithUTF8String:result.latest_color_space] : (id)NSNull.null,
        @"screenBounds": captureRectRecord(result.latest_screen_bounds) } : (id)NSNull.null;
    NSMutableDictionary *record = [NSMutableDictionary dictionaryWithDictionary:@{ @"state": [NSString stringWithUTF8String:sp_image_capture_match_state_name(result.state)],
        @"displayTime": [NSString stringWithFormat:@"%llu", (unsigned long long)result.display_time],
        @"candidates": candidates, @"droppedSnapshots": @(result.dropped_snapshots),
        @"processingMilliseconds": @(processingMilliseconds),
        @"captureFrame": @{ @"width": @(frameWidth), @"height": @(frameHeight), @"stride": @(frameStride),
            @"pixelFormat": @(pixelFormat), @"contentRect": captureRectRecord(contentRect),
            @"screenRect": hasScreenRect ? captureRectRecord(screenRect) : (id)NSNull.null,
            @"contentScale": @(contentScale), @"scaleFactor": @(scaleFactor),
            @"colorSpace": colorSpace ? [NSString stringWithUTF8String:colorSpace] : (id)NSNull.null },
        @"latestRetainedSource": source,
        @"latestSourceCrop": result.has_latest_crop ? captureRectRecord(result.latest_crop) : (id)NSNull.null }];
    if (result.has_pixel_difference) {
        record[@"differentPixels"] = @(result.different_pixels);
        record[@"firstDifference"] = @{
            @"x": @(result.first_difference_x),
            @"y": @(result.first_difference_y),
            @"expectedBGRA": @[@(result.expected_bgra[0]), @(result.expected_bgra[1]), @(result.expected_bgra[2]), @(result.expected_bgra[3])],
            @"actualBGRA": @[@(result.actual_bgra[0]), @(result.actual_bgra[1]), @(result.actual_bgra[2]), @(result.actual_bgra[3])],
        };
    }
    return record;
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

static void reportPixelBufferFailure(int number, NSString *operation, CVReturn result) {
    NSString *message = [NSString stringWithFormat:@"frame %d pixel buffer %@ failed: CVReturn %d",
        number, operation, result];
    setCaptureError(message);
    sp_log_error("capture", message.UTF8String);
}

@implementation SPCapture

- (instancetype)init {
    self = [super init];
    if (self) {
        _callbackStatusTrace = [[NSMutableArray alloc] init];
        _frameWriterTimes = [[NSMutableDictionary alloc] init];
        _displayLinkObservations = [[NSMutableArray alloc] init];
        _displayLinkState = [@"unavailable" copy];
        _displayLinkReason = [@"no display-link observation was recorded" copy];
    }
    return self;
}

- (void)dealloc {
    [self stopDisplayLinkObservation];
    [_callbackStatusTrace release];
    [_frameWriterTimes release];
    [_displayLinkObservations release];
    [_displayLink release];
    [_displayWindow release];
    [_displayAttempt release];
    [_displayLinkState release];
    [_displayLinkReason release];
    [_directory release];
    [super dealloc];
}

- (void)startDisplayLinkObservationForWindowNumber:(long)windowNumber {
    SPCaptureAttempt *attempt = nil;
    @synchronized ([SPCapture class]) { attempt = [captureAttempt retain]; }
    @synchronized (self) {
        self.displayAttempt = attempt;
        self.displayLinkStopped = NO;
        self.displayLinkInvalidated = NO;
        [self.displayLinkObservations removeAllObjects];
        self.omittedDisplayLinkObservations = 0;
        self.lastDisplayLinkTimestampMach = 0;
        self.lastDisplayLinkCallbackTime = 0;
        self.displayLinkTimebaseNumerator = 0;
        self.displayLinkTimebaseDenominator = 0;
        self.displayLinkState = @"unavailable";
        self.displayLinkReason = @"no display-link callback was delivered during the capture";
    }
    void (^install)(void) = ^{
        @synchronized (self) {
            if (self.displayLinkStopped || self.displayAttempt != attempt) return;
        }
        NSWindow *window = nil;
        for (NSWindow *candidate in NSApp.windows) {
            if (candidate.windowNumber == windowNumber) { window = candidate; break; }
        }
        if (captureDisplayLinkAfterWindowLookup != NULL) captureDisplayLinkAfterWindowLookup(window);
        if (window == nil) {
            @synchronized (self) {
                if (self.displayLinkStopped) return;
                self.displayLinkReason = @"the captured window is not available in AppKit";
            }
            return;
        }
        if (!window.isVisible) {
            @synchronized (self) {
                if (self.displayLinkStopped) return;
                self.displayLinkReason = @"the captured window is hidden";
            }
            return;
        }
        if (window.screen == nil) {
            @synchronized (self) {
                if (self.displayLinkStopped) return;
                self.displayLinkReason = @"the captured window is not on a display";
            }
            return;
        }
        CADisplayLink *link = [window displayLinkWithTarget:self selector:@selector(displayLinkDidRefresh:)];
        if (link == nil) {
            @synchronized (self) {
                if (self.displayLinkStopped) return;
                self.displayLinkReason = @"AppKit did not provide a display link for the captured window";
            }
            return;
        }
        if (attempt != nil) objc_setAssociatedObject(link, &captureAttemptAssociationKey, attempt, OBJC_ASSOCIATION_RETAIN);
        @synchronized (self) {
            if (self.displayLinkStopped || self.displayAttempt != attempt) {
                [link invalidate];
                return;
            }
            self.displayWindow = window;
            self.displayLink = link;
            self.displayLinkInvalidated = NO;
        }
        [link addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
    };
    if ([NSThread isMainThread]) install();
    else dispatch_async(dispatch_get_main_queue(), install);
    [attempt release];
}

- (void)stopDisplayLinkObservation {
    CADisplayLink *link = nil;
    NSWindow *window = nil;
    @synchronized (self) {
        self.displayLinkStopped = YES;
        self.displayAttempt = nil;
        link = [self.displayLink retain];
        self.displayLink = nil;
        window = [self.displayWindow retain];
        self.displayWindow = nil;
        if (self.displayLinkObservations.count == 0 && [self.displayLinkState isEqual:@"unavailable"]
            && self.displayLinkReason.length == 0) {
            self.displayLinkReason = @"no display-link callback was delivered during the capture";
        }
    }
    if (link == nil && window == nil) return;
    if ([NSThread isMainThread]) {
        [self invalidateDisplayLink:link window:window];
    } else {
        dispatch_async(dispatch_get_main_queue(), ^{
            [self invalidateDisplayLink:link window:window];
        });
    }
}

- (void)invalidateDisplayLink:(CADisplayLink *)link window:(NSWindow *)window {
    [link invalidate];
    [link release];
    [window release];
    @synchronized (self) { self.displayLinkInvalidated = YES; }
}

- (void)displayLinkDidRefresh:(CADisplayLink *)link {
    NSWindow *window = nil;
    @synchronized (self) {
        if (self.displayLinkStopped || link != self.displayLink) return;
        window = [self.displayWindow retain];
    }
    uint64_t callbackTime = captureRawClock();
    double mediaClockTime = CACurrentMediaTime();
    uint64_t mediaClockAfter = captureRawClock();
    mach_timebase_info_data_t timebase = {};
    if (captureReadTimebase(&timebase) != KERN_SUCCESS) {
        [self rejectDisplayLinkObservation:@"mach_timebase_info failed for a display-link callback"];
        [window release];
        return;
    }
    if (window == nil) {
        [self rejectDisplayLinkObservation:@"display-link callback arrived without its captured window"];
        [window release];
        return;
    }
    NSNumber *displayID = window.screen.deviceDescription[@"NSScreenNumber"];
    SPCaptureAttempt *attempt = objc_getAssociatedObject(link, &captureAttemptAssociationKey);
    [attempt recordWindowNumber:window.windowNumber displayID:displayID visible:window.isVisible
        occluded:(window.occlusionState & NSWindowOcclusionStateVisible) == 0
        applicationActive:NSApp.isActive callbackMachTicks:callbackTime];
    [self recordDisplayLinkTimestamp:link.timestamp targetTimestamp:link.targetTimestamp duration:link.duration
        callbackTime:callbackTime mediaClockTime:mediaClockTime mediaClockAfter:mediaClockAfter
        timebase:timebase windowNumber:window.windowNumber displayID:displayID
        visible:window.isVisible occluded:(window.occlusionState & NSWindowOcclusionStateVisible) == 0
        applicationActive:NSApp.isActive];
    [window release];
}

- (void)rejectDisplayLinkObservation:(NSString *)reason {
    @synchronized (self) {
        if (self.displayLinkStopped) return;
        BOOL firstFailure = ![self.displayLinkState isEqual:@"incomplete"];
        self.displayLinkState = @"incomplete";
        self.displayLinkReason = reason;
        self.omittedDisplayLinkObservations++;
        if (firstFailure) {
            setCaptureError([NSString stringWithFormat:@"display-link trace incomplete: %@", reason]);
        }
    }
}

- (void)recordDisplayLinkTimestamp:(double)timestamp targetTimestamp:(double)targetTimestamp duration:(double)duration
    callbackTime:(uint64_t)callbackTime mediaClockTime:(double)mediaClockTime mediaClockAfter:(uint64_t)mediaClockAfter
    timebase:(mach_timebase_info_data_t)timebase windowNumber:(long)windowNumber
    displayID:(NSNumber *)displayID visible:(BOOL)visible occluded:(BOOL)occluded applicationActive:(BOOL)applicationActive {
    @synchronized (self) {
        if (self.displayLinkStopped) return;
        if ([self.displayLinkState isEqual:@"incomplete"]) {
            self.omittedDisplayLinkObservations++;
            return;
        }
        BOOL valid = isfinite(timestamp) && isfinite(targetTimestamp) && isfinite(duration)
            && isfinite(mediaClockTime) && timestamp > 0 && targetTimestamp > timestamp && duration > 0
            && mediaClockTime > 0 && callbackTime > 0 && mediaClockAfter >= callbackTime
            && timebase.numer != 0 && timebase.denom != 0
            && (self.displayLinkTimebaseNumerator == 0
                || (timebase.numer == self.displayLinkTimebaseNumerator
                    && timebase.denom == self.displayLinkTimebaseDenominator))
            && (self.lastDisplayLinkCallbackTime == 0 || callbackTime > self.lastDisplayLinkCallbackTime);
        long double timestampRaw = (long double)timestamp * 1e9L * (long double)timebase.denom / (long double)timebase.numer;
        long double targetRaw = (long double)targetTimestamp * 1e9L * (long double)timebase.denom / (long double)timebase.numer;
        long double mediaRaw = (long double)mediaClockTime * 1e9L * (long double)timebase.denom / (long double)timebase.numer;
        long double mediaRounding = fabsl((long double)nextafter(mediaClockTime, INFINITY) - (long double)mediaClockTime)
            * 1e9L * (long double)timebase.denom / (long double)timebase.numer + 1;
        valid = valid && isfinite((double)timestampRaw) && isfinite((double)targetRaw)
            && isfinite((double)mediaRaw)
            && timestampRaw > 0 && timestampRaw < (long double)UINT64_MAX
            && targetRaw > timestampRaw && targetRaw < (long double)UINT64_MAX;
        long double roundedTimestamp = roundl(timestampRaw);
        long double roundedTarget = roundl(targetRaw);
        uint64_t timestampMach = valid && roundedTimestamp < (long double)UINT64_MAX ? (uint64_t)roundedTimestamp : 0;
        uint64_t targetMach = valid && roundedTarget < (long double)UINT64_MAX ? (uint64_t)roundedTarget : 0;
        valid = valid && timestampMach > self.lastDisplayLinkTimestampMach
            && targetMach > timestampMach && timestampMach <= callbackTime
            && mediaRaw + mediaRounding >= (long double)callbackTime
            && mediaRaw <= (long double)mediaClockAfter + mediaRounding;
        if (!valid) {
            BOOL firstFailure = ![self.displayLinkState isEqual:@"incomplete"];
            self.displayLinkState = @"incomplete";
            self.displayLinkReason = [NSString stringWithFormat:
                @"display-link timestamp or clock order invalid (timestamp %.9f target %.9f callback %llu media %.9f after %llu converted %llu/%llu previous %llu/%llu timebase %u/%u)",
                timestamp, targetTimestamp, (unsigned long long)callbackTime, mediaClockTime,
                (unsigned long long)mediaClockAfter, (unsigned long long)timestampMach, (unsigned long long)targetMach,
                (unsigned long long)self.lastDisplayLinkTimestampMach, (unsigned long long)self.lastDisplayLinkCallbackTime,
                timebase.numer, timebase.denom];
            self.omittedDisplayLinkObservations++;
            if (firstFailure) {
                setCaptureError([NSString stringWithFormat:@"display-link trace incomplete: %@", self.displayLinkReason]);
            }
        } else if (self.displayLinkObservations.count >= 4096) {
            BOOL firstFailure = ![self.displayLinkState isEqual:@"incomplete"];
            self.displayLinkState = @"incomplete";
            self.displayLinkReason = @"display-link observation capacity exceeded (4096 records)";
            self.omittedDisplayLinkObservations++;
            if (firstFailure) {
                setCaptureError([NSString stringWithFormat:@"display-link trace incomplete: %@", self.displayLinkReason]);
            }
        } else {
            [self.displayLinkObservations addObject:@{
                @"sequence": @(self.displayLinkObservations.count + 1),
                @"timestamp": @(timestamp),
                @"targetTimestamp": @(targetTimestamp),
                @"duration": @(duration),
                @"callbackTime": [NSString stringWithFormat:@"%llu", (unsigned long long)callbackTime],
                @"callbackMediaTime": @(mediaClockTime),
                @"mediaClockAfter": [NSString stringWithFormat:@"%llu", (unsigned long long)mediaClockAfter],
                @"machTimebaseNumerator": @(timebase.numer),
                @"machTimebaseDenominator": @(timebase.denom),
                @"windowNumber": @(windowNumber),
                @"displayID": displayID ?: [NSNull null],
                @"visible": @(visible),
                @"occluded": @(occluded),
                @"applicationActive": @(applicationActive),
            }];
            self.lastDisplayLinkTimestampMach = timestampMach;
            self.lastDisplayLinkCallbackTime = callbackTime;
            self.displayLinkTimebaseNumerator = timebase.numer;
            self.displayLinkTimebaseDenominator = timebase.denom;
            if (!visible || displayID == nil) {
                self.displayLinkState = @"unavailable";
                self.displayLinkReason = !visible
                    ? @"the captured window was hidden during a display-link observation"
                    : @"the captured window had no display during a display-link observation";
            } else if ([self.displayLinkState isEqual:@"unavailable"]
                && [self.displayLinkReason hasPrefix:@"no display-link"]) {
                self.displayLinkState = @"available";
                self.displayLinkReason = @"";
            }
        }
    }
}

- (NSDictionary *)displayLinkRecord {
    @synchronized (self) {
        NSString *state = self.displayLinkState;
        NSString *reason = self.displayLinkReason;
        if (self.displayLinkObservations.count == 0 && [state isEqual:@"unavailable"] && reason.length == 0) {
            reason = @"no display-link callback was delivered during the capture";
        }
        return @{
            @"state": state ?: @"unavailable",
            @"reason": reason ?: @"display-link state was not recorded",
            @"observations": [[self.displayLinkObservations copy] autorelease],
            @"omittedObservations": @(self.omittedDisplayLinkObservations),
        };
    }
}

- (BOOL)recordCallbackStatus:(SCFrameStatus)status hasStatus:(BOOL)hasStatus displayTime:(uint64_t)shown
    hasDisplayTime:(BOOL)hasDisplayTime callbackTime:(uint64_t)callbackTime writeStartTime:(uint64_t)writeStartTime
    timebase:(mach_timebase_info_data_t)timebase {
    if (self.callbackStatusTrace.count >= kCaptureMaxCallbackStatusRecords) {
        if (!self.callbackStatusTraceOverflowed) {
            self.callbackStatusTraceOverflowed = YES;
            captureLimitReached = true;
            setCaptureError([NSString stringWithFormat:@"capture callback status trace capacity exceeded (%d records)",
                kCaptureMaxCallbackStatusRecords]);
        }
        return NO; // silent: setCaptureError retains the capacity failure, which sp_capture_error returns after capture stop.
    }
    id statusValue = hasStatus ? @((int)status) : [NSNull null];
    id timeValue = hasDisplayTime ? [NSString stringWithFormat:@"%llu", (unsigned long long)shown] : [NSNull null];
    [self.callbackStatusTrace addObject:[NSMutableDictionary dictionaryWithDictionary:@{
        @"sequence": @(self.callbackStatusTrace.count + 1),
        @"status": statusValue,
        @"displayTime": timeValue,
        @"callbackTime": [NSString stringWithFormat:@"%llu", (unsigned long long)callbackTime],
        @"writeStartTime": [NSString stringWithFormat:@"%llu", (unsigned long long)writeStartTime],
        @"machTimebaseNumerator": @(timebase.numer),
        @"machTimebaseDenominator": @(timebase.denom),
        @"imageMatchStartTime": [NSNull null],
        @"imageMatchCompleteTime": [NSNull null],
        @"identityDecodeEnqueueStartTime": [NSNull null],
        @"identityDecodeEnqueueCompleteTime": [NSNull null],
        @"frameIdentityDecodeStartTime": [NSNull null],
        @"frameIdentityDecodeCompleteTime": [NSNull null],
        @"writeCompleteTime": [NSNull null],
        @"writerEnqueuedTime": [NSNull null],
        @"writerStartTime": [NSNull null],
        @"writerCompleteTime": [NSNull null],
        @"frame": [NSNull null],
    }]];
    return YES;
}

- (void)stream:(SCStream*)stream
    didOutputSampleBuffer:(CMSampleBufferRef)sample
                   ofType:(SCStreamOutputType)type {
    uint64_t callbackTime = captureRawClock();
    if (type != SCStreamOutputTypeScreen) return;
    SPCaptureAttempt *attempt = captureAttemptForStream(stream);
    if (attempt != nil) {
        SCFrameStatus sampleStatus = SCFrameStatusComplete;
        BOOL hasStatus = frameStatus(sample, &sampleStatus);
        uint64_t shown = 0;
        BOOL hasDisplayTime = displayTime(sample, &shown);
        [attempt recordFirstSampleType:type statusPresent:hasStatus status:sampleStatus
            displayTimePresent:hasDisplayTime displayTimeMachTicks:shown callbackMachTicks:callbackTime];
    }
    // Keep old-attempt diagnostics above, but retired streams cannot reach the shared recording.
    NSString *discardReason = nil;
    @synchronized ([SPCapture class]) {
        if (stream == nil || captureStream != stream) discardReason = @"stream-replaced";
        else if (!captureAcceptingSamples) discardReason = @"sample-intake-closed";
    }
    if (discardReason != nil) {
        if (attempt != nil) {
            SCFrameStatus sampleStatus = SCFrameStatusComplete;
            BOOL hasStatus = frameStatus(sample, &sampleStatus);
            uint64_t shown = 0;
            BOOL hasDisplayTime = displayTime(sample, &shown);
            [attempt emit:@"sample-discarded" level:SP_EVENT_DEBUG callbackMachTicks:@(callbackTime)
                sampleType:@(type) statusPresent:hasStatus status:@(sampleStatus)
                displayTimePresent:hasDisplayTime displayTimeMachTicks:hasDisplayTime
                    ? [NSString stringWithFormat:@"%llu", (unsigned long long)shown] : nil
                error:nil reason:discardReason];
        } else {
            sp_log_error("capture sample", "discarded callback has no stream attempt context");
        }
        return;
    }
    if (attempt != nil) {
        SCFrameStatus sampleStatus = SCFrameStatusComplete;
        BOOL hasStatus = frameStatus(sample, &sampleStatus);
        uint64_t shown = 0;
        BOOL hasDisplayTime = displayTime(sample, &shown);
        [attempt recordLatestSampleStatusPresent:hasStatus status:sampleStatus displayTimePresent:hasDisplayTime
            displayTimeMachTicks:shown callbackMachTicks:callbackTime];
    }
    [self write:sample callbackTime:callbackTime];
    // A frame presented after the stop request means that the screen up to that time has been fully delivered, even
    // if it is idle.
    // A complete frame without a time is left as a recording error by write:, and the stop reports that error.
    // While the stream follows the window size, the stop is deferred until a frame of the new size arrives.
    uint64_t shown = 0;
    BOOL hasDisplayTime = displayTime(sample, &shown);
    SCFrameStatus latestStatus = SCFrameStatusComplete;
    BOOL hasStatus = frameStatus(sample, &latestStatus);
    self.latestCallbackSeen = YES;
    self.latestCallbackMachTicks = callbackTime;
    self.latestCallbackStatusPresent = hasStatus;
    self.latestCallbackStatus = latestStatus;
    self.latestCallbackDisplayTimePresent = hasDisplayTime;
    self.latestCallbackDisplayTimeMachTicks = hasDisplayTime ? shown : 0;
    if (captureCaughtUp != NULL && attempt != nil) {
        [attempt recordLatestSampleStatusPresent:hasStatus status:latestStatus displayTimePresent:hasDisplayTime
            displayTimeMachTicks:shown callbackMachTicks:callbackTime];
    }
    if (captureCaughtUp != NULL && captureStopAfter != 0 && !captureResizing && hasDisplayTime
        && shown >= captureStopAfter) {
        captureStopAfter = 0;
        dispatch_semaphore_signal(captureCaughtUp);
    }
}

- (void)write:(CMSampleBufferRef)sample {
    [self write:sample callbackTime:captureRawClock()];
}

- (void)write:(CMSampleBufferRef)sample callbackTime:(uint64_t)callbackTime {
    uint64_t writeStartTime = captureRawClock();
    mach_timebase_info_data_t timebase = {};
    kern_return_t timebaseResult = captureReadTimebase(&timebase);
    if (timebaseResult != KERN_SUCCESS) {
        NSString *message = [NSString stringWithFormat:@"capture callback mach timebase failed: %d", timebaseResult];
        setCaptureError(message);
        sp_log_error("capture callback", message.UTF8String);
        return;
    }
    // If the window is not redrawn, frames keep arriving at the fixed interval but are all
    // marked idle and have no image. Counting them makes it possible to state why there are 0 frames.
    // A frame without a status cannot be known to be complete, so the recording fails.
    SCFrameStatus status = SCFrameStatusComplete;
    BOOL hasStatus = frameStatus(sample, &status);
    uint64_t shown = 0;
    BOOL hasDisplayTime = displayTime(sample, &shown);
    if (![self recordCallbackStatus:status hasStatus:hasStatus displayTime:shown hasDisplayTime:hasDisplayTime
        callbackTime:callbackTime writeStartTime:writeStartTime timebase:timebase]) return;
    NSMutableDictionary *record = (NSMutableDictionary *)self.callbackStatusTrace.lastObject;
    @try {
        [self processSample:sample status:status hasStatus:hasStatus displayTime:shown hasDisplayTime:hasDisplayTime];
    } @finally {
        record[@"writeCompleteTime"] = [NSString stringWithFormat:@"%llu", (unsigned long long)captureRawClock()];
    }
}

- (void)processSample:(CMSampleBufferRef)sample status:(SCFrameStatus)status hasStatus:(BOOL)hasStatus
    displayTime:(uint64_t)shown hasDisplayTime:(BOOL)hasDisplayTime {
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
    CVReturn lockResult = captureLockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly);
    if (lockResult != kCVReturnSuccess) {
        reportPixelBufferFailure(number, @"lock", lockResult);
        dispatch_semaphore_signal(capturePending);
        return;
    }
    size_t width = CVPixelBufferGetWidth(buffer);
    size_t height = CVPixelBufferGetHeight(buffer);
    size_t stride = CVPixelBufferGetBytesPerRow(buffer);
    const uint8_t* base = (const uint8_t*)captureGetBaseAddress(buffer);
    if (base == NULL) {
        NSString *message = [NSString stringWithFormat:@"frame %d has no pixel buffer", number];
        setCaptureError(message);
        sp_log_error("capture", message.UTF8String);
    }
    // Measuring a window whose size changes requires the drawn area, the scale, and the display time of each frame.
    mach_timebase_info_data_t timebase;
    mach_timebase_info(&timebase);
    uint32_t head[3] = { (uint32_t)width, (uint32_t)height, (uint32_t)stride };
    double info[7] = { rect.origin.x, rect.origin.y, rect.size.width, rect.size.height,
        contentScale, scaleFactor,
        (double)shown * timebase.numer / timebase.denom / 1e6 };
    size_t size = sizeof(head) + sizeof(info) + stride * height;
    uint8_t *copy = base == NULL ? NULL : malloc(size);
    if (copy != NULL) {
        memcpy(copy, head, sizeof(head));
        memcpy(copy + sizeof(head), info, sizeof(info));
        memcpy(copy + sizeof(head) + sizeof(info), base, stride * height);
    }
    CVReturn unlockResult = captureUnlockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly);
    if (unlockResult != kCVReturnSuccess) {
        reportPixelBufferFailure(number, @"unlock", unlockResult);
        free(copy);
        dispatch_semaphore_signal(capturePending);
        return;
    }
    if (base == NULL) {
        dispatch_semaphore_signal(capturePending);
        return;
    }
    if (copy == NULL) {
        NSString *message = [NSString stringWithFormat:@"frame %d could not be copied: %s", self.queued + 1, strerror(errno)];
        setCaptureError(message);
        sp_log_error("capture", message.UTF8String);
        dispatch_semaphore_signal(capturePending);
        return;
    }
    CGRect screen = CGRectZero;
    BOOL hasScreenRect = screenRect(sample, &screen);
    CFTypeRef colorAttachment = CVBufferCopyAttachment(buffer, kCVImageBufferCGColorSpaceKey, NULL);
    CGColorSpaceRef captureColorSpace = colorAttachment && CFGetTypeID(colorAttachment) == CGColorSpaceGetTypeID()
        ? (CGColorSpaceRef)colorAttachment : NULL;
    CFStringRef captureColorName = captureColorSpace ? CGColorSpaceGetName(captureColorSpace) : NULL;
    char colorNameBuffer[256];
    const char *colorName = CVPixelBufferGetPixelFormatType(buffer) == kCVPixelFormatType_32BGRA
        && captureColorName && CFStringGetCString(captureColorName, colorNameBuffer,
            sizeof(colorNameBuffer), kCFStringEncodingUTF8) ? colorNameBuffer : NULL;
    NSMutableDictionary *callbackRecord = (NSMutableDictionary *)self.callbackStatusTrace.lastObject;
    CFTimeInterval matchBegan = CACurrentMediaTime();
    uint64_t imageMatchStartTime = captureRawClock();
    sp_image_capture_match_result match = {0};
    @try {
        match = sp_image_capture_match_sample(copy + sizeof(head) + sizeof(info),
            width, height, stride, rect, hasScreenRect ? screen : CGRectZero,
            contentScale, scaleFactor, colorName, shown);
    } @finally {
        uint64_t imageMatchCompleteTime = captureRawClock();
        callbackRecord[@"imageMatchStartTime"] = [NSString stringWithFormat:@"%llu",
            (unsigned long long)imageMatchStartTime];
        callbackRecord[@"imageMatchCompleteTime"] = [NSString stringWithFormat:@"%llu",
            (unsigned long long)imageMatchCompleteTime];
    }
    double matchMilliseconds = (CACurrentMediaTime() - matchBegan) * 1000;
    callbackRecord[@"imageMatch"] = imageMatchRecord(match, matchMilliseconds, width, height, stride,
        rect, screen, hasScreenRect, contentScale, scaleFactor, CVPixelBufferGetPixelFormatType(buffer), colorName);
    sp_image_capture_match_result_dispose(&match);
    if (sp_image_capture_match_identity_session_active()) {
        char *identityError = NULL;
        uint64_t enqueueStart = captureRawClock();
        CGColorSpaceRef identityColorSpace = captureColorSpace ? captureColorSpace : CGColorSpaceCreateDeviceRGB();
        BOOL enqueued = sp_image_capture_match_identity_enqueue_frame(copy + sizeof(head) + sizeof(info),
            width, height, stride, identityColorSpace, rect,
            hasScreenRect ? screen : CGRectZero, contentScale, scaleFactor,
            (uint64_t)number, shown, &identityError);
        if (!captureColorSpace && identityColorSpace) CGColorSpaceRelease(identityColorSpace);
        uint64_t enqueueComplete = captureRawClock();
        callbackRecord[@"identityDecodeEnqueueStartTime"] = [NSString stringWithFormat:@"%llu",
            (unsigned long long)enqueueStart];
        callbackRecord[@"identityDecodeEnqueueCompleteTime"] = [NSString stringWithFormat:@"%llu",
            (unsigned long long)enqueueComplete];
        if (!enqueued) {
            NSString *message = [NSString stringWithUTF8String:identityError
                ?: "captured sample identity decode could not be queued"];
            free(identityError);
            setCaptureError([NSString stringWithFormat:@"frame identity decode failed: %@", message]);
            sp_log_error("frame identity", message.UTF8String);
        }
    }
    if (colorAttachment) CFRelease(colorAttachment);
    self.queued = number;
    NSString* path = [self.directory stringByAppendingPathComponent:[NSString stringWithFormat:@"frame-%04d.bgra", number]];
    callbackRecord[@"frame"] = path.lastPathComponent;
    callbackRecord[@"writerEnqueuedTime"] = [NSString stringWithFormat:@"%llu", (unsigned long long)mach_absolute_time()];
    dispatch_async(captureWriter, ^{
        uint64_t writerStarted = mach_absolute_time();
        @try {
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
        } @finally {
            uint64_t writerCompleted = mach_absolute_time();
            self.frameWriterTimes[path.lastPathComponent] = @{
                @"writerStartTime": [NSString stringWithFormat:@"%llu", (unsigned long long)writerStarted],
                @"writerCompleteTime": [NSString stringWithFormat:@"%llu", (unsigned long long)writerCompleted],
            };
        }
    });
}

- (void)stream:(SCStream*)stream didStopWithError:(NSError*)error {
    SPCaptureAttempt *attempt = captureAttemptForStream(stream);
    if (attempt != nil) {
        @synchronized (attempt) { attempt.delegateStopSeen = YES; }
        [attempt emit:@"delegate-stop" level:SP_EVENT_DEBUG callbackMachTicks:@(mach_absolute_time())
            sampleType:nil statusPresent:NO status:nil displayTimePresent:NO displayTimeMachTicks:nil error:error reason:nil];
    }
    if (error != nil) {
        reportCaptureStreamFailure(stream,
            [NSString stringWithFormat:@"capture stopped with error: %@", error.localizedDescription], error);
    } else {
        sp_log_info("capture", [NSString stringWithFormat:@"stopped without a delegate error (stream=%p)", stream].UTF8String);
    }
}

@end

// The value that all captures use. The window list query of the window server is much slower than one frame, so
// it is queried only once.
static SCContentFilter* captureFilter = nil;
static SCStreamConfiguration* captureConfig = nil;
static SPCapture* captureSink = nil;
static NSString* captureError = nil;

static void clearCaptureError(void) {
    @synchronized([SPCapture class]) {
        [captureError release];
        captureError = nil;
    }
}

static void appendCaptureError(NSString *message) {
    NSString *combined = captureError == nil ? [message copy]
        : [[captureError stringByAppendingFormat:@"; %@", message] copy];
    [captureError release];
    captureError = combined;
}

static void failIdentitySessionForCaptureError(NSString *message) {
    if (!sp_image_capture_match_identity_session_active()) return;
    char *identityError = NULL;
    if (!sp_image_capture_match_identity_session_fail(message.UTF8String, &identityError) && identityError != NULL)
        sp_log_error("frame identity", identityError);
    free(identityError);
}

static void restoreCaptureIdentityAfterFailure(SCStream *stream) {
    if (NSThread.isMainThread) {
        bool current = false;
        bool noCurrentStream = false;
        @synchronized([SPCapture class]) {
            current = stream != nil && captureStream == stream;
            noCurrentStream = captureStream == nil;
        }
        if (current || (noCurrentStream && !sp_image_capture_match_identity_session_active()))
            sp_region_restore_capture_identity();
    } else {
        // The stream retains this queued cleanup's identity until the main thread checks the current capture.
        if (stream != nil) [stream retain];
        dispatch_async(dispatch_get_main_queue(), ^{
            bool current = false;
            bool noCurrentStream = false;
            @synchronized([SPCapture class]) {
                current = stream != nil && captureStream == stream;
                noCurrentStream = captureStream == nil;
            }
            if (current || (noCurrentStream && !sp_image_capture_match_identity_session_active()))
                sp_region_restore_capture_identity();
            if (stream != nil) [stream release];
        });
    }
}

static bool recordCaptureError(NSString *message, SCStream *expectedStream, BOOL requireCurrentStream,
    SPCapture **sinkOut, NSError *eventError) {
    SCStream *cleanupStream = nil;
    SPCaptureAttempt *failedAttempt = nil;
    if (sinkOut != NULL) *sinkOut = nil;
    @synchronized([SPCapture class]) {
        if (requireCurrentStream && (expectedStream == nil || captureStream != expectedStream)) return false;
        appendCaptureError(message);
        failIdentitySessionForCaptureError(message);
        cleanupStream = [(expectedStream ?: captureStream) retain];
        failedAttempt = [(expectedStream == nil ? captureAttempt : captureAttemptForStream(expectedStream)) retain];
        if (sinkOut != NULL) *sinkOut = [captureSink retain];
    }
    [failedAttempt recordFailure:message error:eventError];
    [failedAttempt release];
    restoreCaptureIdentityAfterFailure(cleanupStream);
    [cleanupStream release];
    return true;
}

static void setCaptureError(NSString* message) {
    recordCaptureError(message, nil, NO, NULL, nil);
}

static bool setCaptureErrorForStream(SCStream *stream, NSString *message, SPCapture **sinkOut, NSError *error) {
    return recordCaptureError(message, stream, YES, sinkOut, error);
}

#ifdef SOKSAK_DIAGNOSTIC
void sp_capture_test_report_error(const char *message) {
    if (message == NULL) {
        sp_log_error("capture", "a failure message is required");
        return;
    }
    NSString *decoded = [NSString stringWithUTF8String:message];
    if (decoded == nil) {
        sp_log_error("capture", "the failure message is not valid UTF-8");
        return;
    }
    setCaptureError(decoded);
}

void sp_capture_test_report_startup_failure(const char *message) {
    sp_image_capture_match_end();
    sp_capture_test_report_error(message);
}
#endif

// Errors of the previous stream are also reported but do not change the result of the current recording.
static void reportCaptureStreamFailure(SCStream *stream, NSString *message, NSError *error) {
    SPCapture *sink = nil;
    bool current = setCaptureErrorForStream(stream, message, &sink, error);
    if (!current) [captureAttemptForStream(stream) recordFailure:message error:error];
    sp_log_error("capture", [NSString stringWithFormat:@"%@ (stream=%p current=%d)", message, stream, current].UTF8String);
    [sink stopDisplayLinkObservation];
    [sink release];
}

static bool hasCaptureError(void) {
    @synchronized([SPCapture class]) { return captureError != nil; }
}

static NSString *const kCaptureCallbackStatusFile = @"callback-status.jsonl";
static NSString *const kCaptureDisplayLinkFile = @"display-link.json";

static bool writeCaptureCallbackStatusTrace(SPCapture *sink) {
    __block NSDictionary *writerTimes = nil;
    if (captureWriter) {
        dispatch_sync(captureWriter, ^{ writerTimes = [sink.frameWriterTimes copy]; });
    } else {
        writerTimes = [sink.frameWriterTimes copy];
    }
    [writerTimes autorelease];
    NSMutableData *contents = [NSMutableData data];
    NSUInteger recordNumber = 0;
    for (NSDictionary *callback in sink.callbackStatusTrace) {
        NSMutableDictionary *record = [[callback mutableCopy] autorelease];
        NSDictionary *writer = writerTimes[record[@"frame"]];
        if (writer) [record addEntriesFromDictionary:writer];
        recordNumber++;
        NSError *error = nil;
        NSData *line = nil;
        NSString *encodingFailure = nil;
        @try {
            line = [NSJSONSerialization dataWithJSONObject:record options:0 error:&error];
        } @catch (NSException *exception) { // silent: preserve the exception reason for the explicit capture error below.
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

static bool writeCaptureDisplayLinkTrace(SPCapture *sink) {
    NSError *error = nil;
    NSData *data = nil;
    NSString *encodingFailure = nil;
    @try {
        data = [NSJSONSerialization dataWithJSONObject:[sink displayLinkRecord] options:NSJSONWritingPrettyPrinted error:&error];
    } @catch (NSException *exception) { // silent: preserve the exception reason for the explicit capture error below.
        encodingFailure = exception.reason ?: exception.name;
    }
    if (data == nil) {
        NSString *reason = encodingFailure ?: error.localizedDescription ?: @"no encoding error was provided";
        setCaptureError([NSString stringWithFormat:@"capture display-link trace could not be encoded: %@", reason]);
        return false;
    }
    NSString *path = [sink.directory stringByAppendingPathComponent:kCaptureDisplayLinkFile];
    if (![data writeToFile:path options:NSDataWritingAtomic error:&error]) {
        NSString *reason = error.localizedDescription ?: @"no write error was provided";
        setCaptureError([NSString stringWithFormat:@"capture display-link trace could not write %@: %@", path, reason]);
        return false;
    }
    return true;
}

// Finalizes the artifacts produced by a stopped recording. Keeping this boundary separate lets the recording owner
// verify finalization with controlled callback records without creating a live ScreenCaptureKit stream.
static bool finalizeCaptureArtifacts(SPCapture *sink) {
    [sink stopDisplayLinkObservation];
    if (NSThread.isMainThread) {
        sp_region_restore_capture_identity();
    } else {
        // Finalization runs after capture and artifact queues have drained, without holding matcher history state.
        dispatch_sync(dispatch_get_main_queue(), ^{ sp_region_restore_capture_identity(); });
    }
    bool sourceManifestWritten = sp_image_capture_match_write_manifest(sink.directory.fileSystemRepresentation);
    char *identityError = sp_image_capture_match_identity_session_error_copy();
    NSString *identityReason = identityError ? [NSString stringWithUTF8String:identityError] : nil;
    free(identityError);
    if (identityReason) setCaptureError([NSString stringWithFormat:@"frame identity capture failed: %@", identityReason]);
    else if (!sourceManifestWritten)
        setCaptureError(@"diagnostic image source artifact manifest or source write failed");
    bool callbackStatusWritten = writeCaptureCallbackStatusTrace(sink);
    if (!callbackStatusWritten && !hasCaptureError()) {
        setCaptureError(@"capture callback status trace failed without a reason");
    }
    bool displayLinkWritten = writeCaptureDisplayLinkTrace(sink);
    sp_image_capture_match_end();
    return sourceManifestWritten && identityReason == nil && callbackStatusWritten && displayLinkWritten;
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
                    @"capture did not follow the window size %zux%zu: %@", needWidth, needHeight, failed.localizedDescription], failed);
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
    captureWindowNumber = windowNumber;
    [result release];
    return true;
}

bool sp_capture_start(const char* directory, bool frameIdentity, char **errorOut) {
    if (errorOut == NULL) {
        sp_log_error("capture start", "an error output is required");
        return false;
    }
    *errorOut = NULL;
    if (captureStream != nil) return captureOperationFailure(errorOut, @"capture is already running");
    clearCaptureError();
    SPCaptureAttempt *attempt = [[SPCaptureAttempt alloc] init];
    @synchronized ([SPCapture class]) {
        captureAttemptSequence++;
        attempt.session = [NSString stringWithFormat:@"capture-%llu", (unsigned long long)captureAttemptSequence];
        attempt.windowNumber = captureWindowNumber;
        [captureAttempt release];
        captureAttempt = [attempt retain];
    }
    mach_timebase_info_data_t attemptTimebase = {};
    if (captureReadTimebase(&attemptTimebase) == KERN_SUCCESS) attempt.timebase = attemptTimebase;
    if (captureFilter == nil) {
        setCaptureError(@"capture has no prepared window");
        sp_log_error("capture start", "capture has no prepared window");
        [attempt release];
        return captureOperationFailure(errorOut, @"capture has no prepared window");
    }
    if (directory == NULL) {
        setCaptureError(@"capture directory is null");
        [attempt release];
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
    captureSink.latestCallbackSeen = NO;
    captureSink.latestCallbackMachTicks = 0;
    captureSink.latestCallbackStatusPresent = NO;
    captureSink.latestCallbackStatus = SCFrameStatusComplete;
    captureSink.latestCallbackDisplayTimePresent = NO;
    captureSink.latestCallbackDisplayTimeMachTicks = 0;
    captureSink.queued = captureSink.written;
    captureSink.rejected = 0;
    captureSink.idle = 0;
    captureSink.complete = 0;
    captureSink.callbackStatusTraceOverflowed = NO;
    [captureSink.callbackStatusTrace removeAllObjects];
    [captureSink.frameWriterTimes removeAllObjects];
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
        [attempt release];
        return captureOperationFailure(errorOut, @"capture directory is not valid UTF-8");
    }
    sp_image_capture_match_begin(captureSink.directory.fileSystemRepresentation, captureWriter);
    if (frameIdentity) {
        char *identityError = NULL;
        if (!sp_image_capture_match_identity_session_begin(&identityError)) {
            NSString *reason = [NSString stringWithUTF8String:identityError ?: "identity session could not start"];
            free(identityError);
            sp_image_capture_match_end();
            setCaptureError(reason);
            [attempt release];
            return captureOperationFailure(errorOut, reason);
        }
        if (!sp_image_capture_match_identity_prepare_decoder(&identityError)) {
            NSString *reason = [NSString stringWithUTF8String:identityError ?: "frame identity Vision readiness failed"];
            free(identityError);
            sp_image_capture_match_identity_session_end();
            sp_image_capture_match_end();
            setCaptureError(reason);
            [attempt release];
            return captureOperationFailure(errorOut, reason);
        }
    }
    SCStream *stream = [[SCStream alloc] initWithFilter:captureFilter
                                       configuration:captureConfig
                                            delegate:captureSink];
    if (!stream) {
        sp_image_capture_match_end();
        setCaptureError(@"capture stream allocation failed");
        [attempt release];
        return captureOperationFailure(errorOut, @"capture stream allocation failed");
    }
    objc_setAssociatedObject(stream, &captureAttemptAssociationKey, attempt, OBJC_ASSOCIATION_RETAIN);
    @synchronized([SPCapture class]) {
        captureStream = stream;
        captureAcceptingSamples = YES;
    }
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
        @synchronized([SPCapture class]) {
            captureAcceptingSamples = NO;
            captureStream = nil;
        }
        [stream release];
        sp_image_capture_match_end();
        [attempt release];
        return captureOperationFailure(errorOut,
            [NSString stringWithFormat:@"capture output was not added: %@", error.localizedDescription]);
    }
    [captureSink startDisplayLinkObservationForWindowNumber:captureWindowNumber];
    // The copied completion block retains the original stream, so its identity is kept after a replacement.
    if (captureStartDone) dispatch_release(captureStartDone);
    captureStartDone = dispatch_semaphore_create(0);
    dispatch_semaphore_t startDone = captureStartDone;
    dispatch_retain(startDone);
    attempt.requestMachTicks = captureRawClock();
    [attempt emit:@"start-request" level:SP_EVENT_DEBUG callbackMachTicks:nil sampleType:nil
        statusPresent:NO status:nil displayTimePresent:NO displayTimeMachTicks:nil error:nil reason:nil];
    [stream startCaptureWithCompletionHandler:^(NSError* failed) {
        uint64_t completedAt = captureRawClock();
        @synchronized (attempt) { attempt.startCompletionSeen = YES; }
        [attempt emit:@"start-completion" level:SP_EVENT_DEBUG callbackMachTicks:@(completedAt) sampleType:nil
            statusPresent:NO status:nil displayTimePresent:NO displayTimeMachTicks:nil error:failed
            reason:failed.localizedDescription];
        if (failed != nil) {
            reportCaptureStreamFailure(stream,
                [NSString stringWithFormat:@"capture did not start: %@", failed.localizedDescription], failed);
        }
        dispatch_semaphore_signal(startDone);
        dispatch_release(startDone);
    }];
    [attempt release];
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

static void registerCaptureStopBoundary(SPCapture *sink, SPCaptureAttempt *attempt, double after,
    uint64_t targetMachTicks, uint64_t registrationMachTicks, dispatch_semaphore_t caughtUp) {
    captureCaughtUp = caughtUp;
    captureStopAfter = targetMachTicks;
    [attempt recordStopBoundaryAfterMilliseconds:after targetMachTicks:targetMachTicks
        registrationMachTicks:registrationMachTicks];
    if (sink.latestCallbackSeen) {
        [attempt recordLatestSampleStatusPresent:sink.latestCallbackStatusPresent status:sink.latestCallbackStatus
            displayTimePresent:sink.latestCallbackDisplayTimePresent
            displayTimeMachTicks:sink.latestCallbackDisplayTimeMachTicks callbackMachTicks:sink.latestCallbackMachTicks];
    }
    // The serial capture queue may have processed a qualifying callback before this boundary was registered.
    // Reuse that callback instead of waiting for another one; idle callbacks also satisfy the stop predicate.
    if (!captureResizing && sink.latestCallbackSeen && sink.latestCallbackDisplayTimePresent
        && sink.latestCallbackDisplayTimeMachTicks >= targetMachTicks) {
        captureStopAfter = 0;
        dispatch_semaphore_signal(caughtUp);
    }
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
    SPCaptureAttempt *attempt = captureAttemptForStream(stream);
    // Stops after a callback delivers a display time at or beyond the later of the call time and requested
    // presentation time. A pending size change must finish first. If no qualifying callback arrives within the
    // existing one-second wait, the stop reports an explicit error.
    mach_timebase_info_data_t base;
    mach_timebase_info(&base);
    uint64_t now = mach_absolute_time();
    uint64_t shown = after > 0 ? (uint64_t)(after * 1e6 * base.denom / base.numer) : 0;
    uint64_t until = shown > now ? shown : now;
    dispatch_semaphore_t caughtUp = dispatch_semaphore_create(0);
    dispatch_sync(captureQueue, ^{
        registerCaptureStopBoundary(captureSink, attempt, after, until, captureRawClock(), caughtUp);
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
        // The boundary has been observed (or timed out). Seal intake at this sample-queue fence before
        // waiting for start completion or asking ScreenCaptureKit to stop the stream.
        closeCaptureSampleIntake(stream);
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
                [NSString stringWithFormat:@"capture did not stop: %@", failed.localizedDescription], failed);
        }
        dispatch_semaphore_signal(stopped);
        dispatch_release(stopped);
    }];
    if (dispatch_semaphore_wait(stopped, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) != 0) {
        setCaptureError(@"capture stop did not complete within 5000ms");
    }
    // Source manifest finalization closes source intake and drains the shared writer queue.
    finalizeCaptureArtifacts(captureSink);
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
