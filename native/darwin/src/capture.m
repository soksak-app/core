// Records the application windows as a series of stills.
//
// Each still is the image of the window and its child windows that the window server composited, which the application asks
// for its own windows with CGWindowListCreateImageFromArray. The window server answers with what it shows, so the page, the
// surfaces and the modals are measured as they appeared, also while other windows cover the window. A still is requested at
// its planned time whether or not the stills before it completed, and each still keeps the time of its request and of its
// completion: the window showed the content of the still at some time between the two.
//
// The macOS 15 SDK marks CGWindowListCreateImageFromArray obsolete, so the capture looks it up at run time
// (docs/operations/private-native-apis.md). A macOS without it fails the open and the still with an error that names it.
// ScreenCaptureKit is not used: the stream of a covered window stopped delivering frames one to two seconds after its start,
// and its still could not follow a refresh of 8.3 ms (docs/features.md, F746).
#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import <CommonCrypto/CommonDigest.h>
#import "capture.h"
#import "window_reveal.h"
#import "application_log.h"
#import "event_ring.h"
#import "observe.h"
#import "window_order.h"
#import <ImageIO/ImageIO.h>
#include <dlfcn.h>
#include <math.h>
#include <pthread.h>
#include <unistd.h>
#include <compression.h>
#include <zlib.h>

// The function that gives the image of a list of windows, looked up at each open and still through captureLookup, which a test
// replaces with the lookup of a macOS that lacks it.
typedef CGImageRef (*SPWindowImage)(CGRect, CFArrayRef, CGWindowImageOption);
static void *(*captureLookup)(void *, const char *) = dlsym;
static NSString *const kWindowImageMissing = @"CGWindowListCreateImageFromArray is not available on this macOS";

static SPWindowImage windowImageFunction(void) {
    return (SPWindowImage)captureLookup(RTLD_DEFAULT, "CGWindowListCreateImageFromArray");
}

// The clock of the stage ticks and the timebase reader of the display-link callback, which a test replaces with a clock of known
// values and with a reader that fails.
static uint64_t (*captureRawClock)(void) = mach_absolute_time;
static kern_return_t (*captureReadTimebase)(mach_timebase_info_t) = mach_timebase_info;

static uint64_t captureTicks(void) { return captureRawClock(); }

static double ticksToMilliseconds(uint64_t ticks, mach_timebase_info_data_t timebase) {
    return (double)ticks * timebase.numer / timebase.denom / 1e6;
}

static NSString *tickString(uint64_t ticks) {
    return [NSString stringWithFormat:@"%llu", (unsigned long long)ticks];
}

// Runs block on the main thread and returns after it ran. The capture reads AppKit windows only on the main thread; the
// callers that wait (the host's capture calls) run on threads that the main thread never waits for.
static void onMain(void (^block)(void)) {
    if (NSThread.isMainThread) block();
    else dispatch_sync(dispatch_get_main_queue(), block);
}

// What a still takes: the window server numbers of the windows, front to back, the rectangle of the request (CGRectNull for the
// bounds of the windows, or the bounds of a display), and the rectangle on screen that the image covers, in window server
// coordinates (top-left origin). A target that cannot be taken holds the reason instead.
@interface SPCaptureTarget : NSObject
@property (nonatomic, copy) NSArray<NSNumber *> *windows;
@property (nonatomic) CGRect request;
@property (nonatomic) CGRect screen;
@property (nonatomic) BOOL display;
@property (nonatomic, copy) NSString *error;
@property (nonatomic) CFArrayRef windowIDs;
@end

@implementation SPCaptureTarget
- (void)setWindows:(NSArray<NSNumber *> *)windows {
    if (_windows == windows) return;
    [_windows release];
    _windows = [windows copy];
    if (_windowIDs) CFRelease(_windowIDs);
    _windowIDs = NULL;
    if (_windows.count == 0) return;
    const void **ids = malloc(sizeof(void *) * _windows.count);
    if (ids == NULL) return;
    for (NSUInteger index = 0; index < _windows.count; index++)
        ids[index] = (const void *)(uintptr_t)_windows[index].unsignedIntValue;
    _windowIDs = CFArrayCreate(NULL, ids, (CFIndex)_windows.count, NULL);
    free(ids);
}
- (void)dealloc {
    [_windows release];
    [_error release];
    if (_windowIDs) CFRelease(_windowIDs);
    [super dealloc];
}
@end

static SPCaptureTarget *failedTarget(NSString *reason) {
    SPCaptureTarget *target = [[[SPCaptureTarget alloc] init] autorelease];
    target.error = reason;
    return target;
}

// The window and its child windows (recursively) that AppKit shows. A window that the application closed or ordered out is not
// shown from that call on, while the window server still lists it on screen until it applies the order.
static void collectWindows(NSWindow *window, NSMutableSet<NSNumber *> *numbers) {
    if (!window.isVisible) return;
    [numbers addObject:@(window.windowNumber)];
    for (NSWindow *child in window.childWindows) collectWindows(child, numbers);
}

static BOOL windowBounds(NSDictionary *info, CGRect *bounds) {
    NSDictionary *bound = info[(id)kCGWindowBounds];
    return [bound isKindOfClass:NSDictionary.class] && CGRectMakeWithDictionaryRepresentation((CFDictionaryRef)bound, bounds);
}

// The windows that AppKit shows of windowNumber, read on the main thread: the window and its child windows (recursively), or nil
// and the reason when the window is not shown.
static NSSet<NSNumber *> *shownWindowsOnMain(long windowNumber, NSString **failure) {
    NSCAssert(NSThread.isMainThread, @"the capture reads its AppKit windows on the main thread");
    NSWindow *window = nil;
    for (NSWindow *candidate in NSApp.windows) {
        if (candidate.windowNumber == windowNumber) { window = candidate; break; }
    }
    if (window == nil || windowNumber <= 0 || !window.isVisible) {
        *failure = [NSString stringWithFormat:@"window %ld is not on screen", windowNumber];
        return nil;
    }
    NSMutableSet<NSNumber *> *numbers = [NSMutableSet set];
    collectWindows(window, numbers);
    return numbers;
}

// Resolves what a still of windowNumber takes from the windows that AppKit shows of it (shownWindowsOnMain), through the window
// server, on any thread. In window mode these are the window and its child windows that the window server lists on screen, in
// its front-to-back order, so a child ordered below the window stays below it; with display, every on-screen window of this
// process on the display that holds the centre of the window.
static SPCaptureTarget *resolveShownTarget(long windowNumber, BOOL display, NSSet<NSNumber *> *numbers) {
    NSString *notOnScreen = [NSString stringWithFormat:@"window %ld is not on screen", windowNumber];
    NSArray<NSDictionary *> *list = nil;
    if (numbers.count == 1 && !display) {
        // A window without child windows needs no order, so the window server describes that window only.
        const void *ids[1] = { (const void *)(uintptr_t)windowNumber };
        CFArrayRef one = CFArrayCreate(NULL, ids, 1, NULL);
        list = [(NSArray *)CGWindowListCreateDescriptionFromArray(one) autorelease];
        CFRelease(one);
    } else {
        list = [(NSArray *)CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID) autorelease];
    }
    NSMutableArray<NSNumber *> *ordered = [NSMutableArray array];
    CGRect screen = CGRectNull, windowRect = CGRectNull;
    pid_t own = getpid();
    NSMutableArray<NSDictionary *> *process = [NSMutableArray array];
    for (NSDictionary *info in list) {
        NSNumber *number = info[(id)kCGWindowNumber];
        if (![number isKindOfClass:NSNumber.class] || ![info[(id)kCGWindowIsOnscreen] boolValue]) continue;
        if ([info[(id)kCGWindowOwnerPID] intValue] == own) [process addObject:info];
        if (![numbers containsObject:number]) continue;
        CGRect bounds;
        if (!windowBounds(info, &bounds)) continue;
        if (number.longValue == windowNumber) windowRect = bounds;
        [ordered addObject:number];
        screen = CGRectUnion(screen, bounds);
    }
    if (CGRectIsNull(windowRect)) return failedTarget(notOnScreen);
    SPCaptureTarget *target = [[[SPCaptureTarget alloc] init] autorelease];
    target.display = display;
    if (!display) {
        target.windows = ordered;
        target.request = CGRectNull;
        target.screen = screen;
        return target;
    }
    CGDirectDisplayID displayID = 0;
    uint32_t count = 0;
    CGPoint centre = CGPointMake(CGRectGetMidX(windowRect), CGRectGetMidY(windowRect));
    if (CGGetDisplaysWithPoint(centre, 1, &displayID, &count) != kCGErrorSuccess || count == 0)
        return failedTarget([NSString stringWithFormat:@"window %ld is on no display", windowNumber]);
    CGRect bounds = CGDisplayBounds(displayID);
    NSMutableArray<NSNumber *> *windows = [NSMutableArray array];
    for (NSDictionary *info in process) {
        CGRect rect;
        if (windowBounds(info, &rect) && CGRectIntersectsRect(rect, bounds)) [windows addObject:info[(id)kCGWindowNumber]];
    }
    target.windows = windows;
    target.request = bounds;
    target.screen = bounds;
    return target;
}

// Resolves what a still of windowNumber takes in one main-thread step: still 0, which is taken in the step that puts a held
// window on screen.
static SPCaptureTarget *resolveTargetOnMain(long windowNumber, BOOL display) {
    NSString *failure = nil;
    NSSet<NSNumber *> *numbers = shownWindowsOnMain(windowNumber, &failure);
    return numbers ? resolveShownTarget(windowNumber, display, numbers) : failedTarget(failure);
}

// Resolves what a still of windowNumber takes from a thread other than the main thread: only the AppKit windows are read on the
// main thread, and the window server is asked on the calling thread.
static SPCaptureTarget *resolveTarget(long windowNumber, BOOL display) {
    __block NSSet<NSNumber *> *numbers = nil;
    __block NSString *failure = nil;
    onMain(^{
        numbers = [shownWindowsOnMain(windowNumber, &failure) retain];
        [failure retain];
    });
    [numbers autorelease];
    [failure autorelease];
    return numbers ? resolveShownTarget(windowNumber, display, numbers) : failedTarget(failure);
}

// The rectangle on screen that an image of target covers, read right after the image: the window server bounds of its windows,
// which can have moved since the target was resolved, or the bounds of its display.
static CGRect imageScreen(SPCaptureTarget *target) {
    if (target.display || target.windowIDs == NULL) return target.screen;
    NSArray<NSDictionary *> *list = [(NSArray *)CGWindowListCreateDescriptionFromArray(target.windowIDs) autorelease];
    CGRect screen = CGRectNull;
    for (NSDictionary *info in list) {
        CGRect bounds;
        if (windowBounds(info, &bounds)) screen = CGRectUnion(screen, bounds);
    }
    return CGRectIsNull(screen) ? target.screen : screen;
}

// The image of target with its pixels copied, or NULL. The image that the window server returns refers to the surfaces of the
// windows until its pixels are read, and a read after a later commit holds that later content, so the copy is part of the still:
// the time read after this call is the time by which the still holds its pixels. The caller releases the image.
static CGImageRef takeImage(SPWindowImage function, SPCaptureTarget *target) {
    CGWindowImageOption options = kCGWindowImageBestResolution | (target.display ? 0 : kCGWindowImageBoundsIgnoreFraming);
    CGImageRef image = function(target.request, target.windowIDs, options);
    if (image == NULL) return NULL;
    CFDataRef pixels = CGDataProviderCopyData(CGImageGetDataProvider(image));
    CGDataProviderRef provider = pixels ? CGDataProviderCreateWithCFData(pixels) : NULL;
    CGImageRef copied = provider ? CGImageCreate(CGImageGetWidth(image), CGImageGetHeight(image), CGImageGetBitsPerComponent(image),
        CGImageGetBitsPerPixel(image), CGImageGetBytesPerRow(image), CGImageGetColorSpace(image), CGImageGetBitmapInfo(image),
        provider, NULL, false, CGImageGetRenderingIntent(image)) : NULL;
    if (provider) CGDataProviderRelease(provider);
    if (pixels) CFRelease(pixels);
    CGImageRelease(image);
    return copied;
}

// The pixels of image in its own colour space as BGRA (premultiplied alpha first, little endian) into pixels with stride bytes
// per row: no colour is converted. The window server composites every layer into the 8-bit colour space of the display, and a
// conversion of those values to another space changes some of them by 1 to 3 (sRGB 32c8c8 came back as 31c8c9), so a frame
// holds the bytes that the window server gave and the recording names their colour space. An image in that layout gives its
// bytes as they are; another layout is drawn into its own colour space, which changes the layout and no colour. Returns nil, or
// why the pixels could not be given, which the caller records as the error of the still.
static NSString *drawOwnSpace(CGImageRef image, uint8_t *pixels, size_t width, size_t height, size_t stride) {
    CGColorSpaceRef space = CGImageGetColorSpace(image);
    if (space == NULL) return @"the image names no colour space";
    if (CGColorSpaceGetModel(space) != kCGColorSpaceModelRGB) {
        return [NSString stringWithFormat:@"the colour space of the image has the model %d, not RGB", (int)CGColorSpaceGetModel(space)];
    }
    CGBitmapInfo info = CGImageGetBitmapInfo(image);
    if (CGImageGetBitsPerComponent(image) == 8 && CGImageGetBitsPerPixel(image) == 32
        && (info & kCGBitmapByteOrderMask) == kCGBitmapByteOrder32Little && (info & kCGBitmapFloatComponents) == 0
        && CGImageGetAlphaInfo(image) == kCGImageAlphaPremultipliedFirst && CGImageGetBytesPerRow(image) >= stride) {
        CFDataRef data = CGDataProviderCopyData(CGImageGetDataProvider(image));
        size_t row = CGImageGetBytesPerRow(image), needed = row * (height - 1) + stride;
        size_t length = data != NULL ? (size_t)CFDataGetLength(data) : 0;
        NSString *failure = nil;
        if (data == NULL) failure = @"the window server gave no bytes of the image";
        else if (length < needed) {
            failure = [NSString stringWithFormat:@"the window server gave %zu bytes of the image, not %zu", length, needed];
        } else {
            const uint8_t *bytes = CFDataGetBytePtr(data);
            for (size_t y = 0; y < height; y++) memcpy(pixels + y * stride, bytes + y * row, stride);
        }
        if (data) CFRelease(data);
        return failure;
    }
    CGContextRef context = CGBitmapContextCreate(pixels, width, height, 8, stride, space,
        (CGBitmapInfo)kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little);
    if (context == NULL) {
        return [NSString stringWithFormat:@"no BGRA bitmap of %zux%zu could be made in the colour space of the image", width, height];
    }
    CGContextSetBlendMode(context, kCGBlendModeCopy);
    CGContextDrawImage(context, CGRectMake(0, 0, width, height), image);
    CGContextRelease(context);
    return nil;
}

// The frame file: header (12 bytes of uint32, 64 bytes of float64), marker, compressed count, checksum, then the LZ4 block.
static const size_t kFrameHeader = 3 * sizeof(uint32_t) + 8 * sizeof(double);
static const size_t kFrameEncodedHeader = kFrameHeader + 12;
// The bytes that the LZ4 encoder of libcompression leaves free at the end of its output; its open source form in xnu
// (osfmk/vm/lz4.h) names it LZ4_GOFAST_SAFETY_MARGIN.
static const size_t kLZ4OutputMargin = 128;

@class SPCaptureRecording;
static void setCaptureError(NSString *message);
static bool hasCaptureError(void);
static void stillOutcome(SPCaptureRecording *recording, NSUInteger index, NSString *outcome, NSString *error, NSString *frame);

// The serial queue that writes frames to disk and the upper limit of frames that wait to be written.
static dispatch_queue_t captureWriter;
static dispatch_semaphore_t capturePending;
static const long kCapturePending = 64;
// The upper limit of stills whose image the window server has not given yet. A still takes a median of 0.5 ms, so only a still
// that takes longer than 8 gaps reaches it; a still requested at the limit fails instead of adding a request to a window server
// that has not answered the earlier ones.
static const NSUInteger kCaptureInFlight = 8;
// The queue whose strict timer requests the stills at their planned times, and the queue on which each still is taken. Neither
// is the main queue, so a busy main thread does not move a request.
static dispatch_queue_t captureRequests;
static dispatch_queue_t captureWorkers;
// The serial queue that asks the window server for the windows of the next still and for the windows in front of a covered window,
// after a display-link callback read the AppKit windows on the main thread: the main thread never waits for the window server.
static dispatch_queue_t captureWindowReads;

static void prepareCaptureQueues(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        captureWriter = dispatch_queue_create("sp.capture.writer", DISPATCH_QUEUE_SERIAL);
        capturePending = dispatch_semaphore_create(kCapturePending);
        captureRequests = dispatch_queue_create("sp.capture.requests",
            dispatch_queue_attr_make_with_qos_class(DISPATCH_QUEUE_SERIAL, QOS_CLASS_USER_INTERACTIVE, 0));
        captureWorkers = dispatch_queue_create("sp.capture.stills",
            dispatch_queue_attr_make_with_qos_class(DISPATCH_QUEUE_CONCURRENT, QOS_CLASS_USER_INTERACTIVE, 0));
        captureWindowReads = dispatch_queue_create("sp.capture.windows",
            dispatch_queue_attr_make_with_qos_class(DISPATCH_QUEUE_SERIAL, QOS_CLASS_USER_INTERACTIVE, 0));
    });
}

// One recording: its plan, the record of each planned still, the strict timer that requests them, and the display-link
// observation of its window, whose callback also refreshes the windows that the next still takes.
@interface SPCaptureRecording : NSObject
@property (nonatomic, copy) NSString *session;
@property (nonatomic, copy) NSString *directory;
@property (nonatomic) long windowNumber;
@property (nonatomic) BOOL display;
@property (nonatomic) double gap;
@property (nonatomic) NSUInteger planned;
@property (nonatomic) uint64_t startTicks;
@property (nonatomic) double gapTicks;
@property (nonatomic) mach_timebase_info_data_t timebase;
@property (nonatomic) SPWindowImage function;
// The rows of stills.jsonl, one per planned still, and the counts of their outcomes. Guarded by the recording.
@property (nonatomic, retain) NSMutableArray<NSMutableDictionary *> *rows;
// The names of the ICC profile files that the stills of the recording wrote. Guarded by the recording.
@property (nonatomic, retain) NSMutableSet<NSString *> *profiles;
@property (nonatomic) NSUInteger nextIndex;
@property (nonatomic) NSUInteger completedCount;
// The stills requested on the workers whose image the window server has not given yet. Guarded by the recording.
@property (nonatomic) NSUInteger awaitingImages;
@property (nonatomic) NSUInteger outcomes;
@property (nonatomic) int written;
@property (nonatomic) BOOL closed;
@property (nonatomic) BOOL requestsDone;
@property (nonatomic) uint64_t stopAfterTicks;
@property (nonatomic) BOOL stopArmed;
@property (nonatomic) BOOL stopReached;
@property (nonatomic, assign) dispatch_semaphore_t stopSignal;
@property (nonatomic, assign) dispatch_semaphore_t firstStill;
@property (nonatomic, assign) dispatch_group_t inflight;
@property (nonatomic, assign) dispatch_source_t timer;
// The windows that the next still takes, refreshed on the main thread at each display-link callback. Guarded by targetLock.
@property (nonatomic, retain) SPCaptureTarget *target;
// The display-link observation of the window. Guarded by the recording.
@property (nonatomic, retain) NSMutableArray<NSDictionary *> *displayLinkObservations;
@property (nonatomic, retain) CADisplayLink *displayLink;
@property (nonatomic, retain) NSWindow *displayWindow;
@property (nonatomic, copy) NSString *displayLinkState;
@property (nonatomic, copy) NSString *displayLinkReason;
@property (nonatomic) NSUInteger omittedDisplayLinkObservations;
@property (nonatomic) BOOL displayLinkStopped;
@property (nonatomic) uint64_t lastDisplayLinkTimestampMach;
@property (nonatomic) uint64_t lastDisplayLinkCallbackTime;
@property (nonatomic) uint32_t displayLinkTimebaseNumerator;
@property (nonatomic) uint32_t displayLinkTimebaseDenominator;
// Whether the window was covered at the last display-link callback, so the first callback of a covered stretch reads the windows in
// front of it (sp_window_in_front).
@property (nonatomic) BOOL displayLinkCovered;
// Whether a read of the windows of the next still waits on captureWindowReads, and the display-link callbacks that read no windows
// because one did. Guarded by the recording.
@property (nonatomic) BOOL readingWindows;
@property (nonatomic) NSUInteger skippedWindowReads;
- (SPCaptureTarget *)currentTarget;
- (uint64_t)plannedTicks:(NSUInteger)index;
- (void)startDisplayLinkObservation;
- (void)stopDisplayLinkObservation;
- (NSDictionary *)displayLinkRecord;
@end

static pthread_mutex_t targetLock = PTHREAD_MUTEX_INITIALIZER;
static uint64_t captureSessionSequence;
// The current recording, the window that the next recording records, and the error of the last recording. Guarded by
// [SPCaptureRecording class].
static SPCaptureRecording *captureRecording;
static long captureWindowNumber = -1;
static BOOL captureDisplay;
static NSString *captureError;
static int captureMissed;
static int captureLate;
static double captureLongestGap;

static void emitLifecycle(SPCaptureRecording *recording, NSString *phase, uint8_t level, NSDictionary *still, NSString *reason) {
    if (!sp_event_gate(SP_CLASS_LIFECYCLE, level)) return;
    id null = NSNull.null;
    int written = 0;
    NSUInteger outcomes = 0, skipped = 0;
    @synchronized (recording) {
        written = recording.written;
        outcomes = recording.outcomes;
        skipped = recording.skippedWindowReads;
    }
    NSDictionary *fields = @{
        @"session": recording.session ?: @"", @"phase": phase,
        @"windowNumber": @(recording.windowNumber), @"display": @(recording.display),
        @"gap": @(recording.gap), @"plannedStills": @(recording.planned),
        @"index": still[@"index"] ?: null,
        @"plannedMachTicks": still[@"index"] ? tickString([recording plannedTicks:[still[@"index"] unsignedIntegerValue]]) : null,
        @"requestedMachTicks": still[@"requested"] ?: null,
        @"completedMachTicks": still[@"completed"] ?: null,
        @"machTimebaseNumerator": @(recording.timebase.numer),
        @"machTimebaseDenominator": @(recording.timebase.denom),
        @"written": @(written), @"settled": @(outcomes), @"skippedWindowReads": @(skipped),
        @"reason": reason ?: null,
    };
    NSError *encodingError = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:fields options:0 error:&encodingError];
    if (data == nil || !sp_event(SP_CLASS_LIFECYCLE, level, "native.capture.lifecycle",
        [[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] autorelease].UTF8String)) {
        NSString *message = data == nil ? [NSString stringWithFormat:@"capture lifecycle event encoding failed: %@", encodingError]
            : @"capture lifecycle event was not stored";
        sp_log_error("capture lifecycle", message.UTF8String);
    }
}

@implementation SPCaptureRecording

- (instancetype)init {
    self = [super init];
    if (self) {
        _rows = [[NSMutableArray alloc] init];
        _profiles = [[NSMutableSet alloc] init];
        _displayLinkObservations = [[NSMutableArray alloc] init];
        _displayLinkState = [@"unavailable" copy];
        _displayLinkReason = [@"no display-link callback was delivered during the capture" copy];
        _stopSignal = dispatch_semaphore_create(0);
        _firstStill = dispatch_semaphore_create(0);
        _inflight = dispatch_group_create();
    }
    return self;
}

- (void)dealloc {
    [_session release];
    [_directory release];
    [_rows release];
    [_profiles release];
    [_target release];
    [_displayLinkObservations release];
    [_displayLink release];
    [_displayWindow release];
    [_displayLinkState release];
    [_displayLinkReason release];
    dispatch_release(_stopSignal);
    dispatch_release(_firstStill);
    dispatch_release(_inflight);
    if (_timer) dispatch_release(_timer);
    [super dealloc];
}

- (SPCaptureTarget *)currentTarget {
    pthread_mutex_lock(&targetLock);
    SPCaptureTarget *target = [_target retain];
    pthread_mutex_unlock(&targetLock);
    return [target autorelease];
}

- (void)replaceTarget:(SPCaptureTarget *)target {
    pthread_mutex_lock(&targetLock);
    self.target = target;
    pthread_mutex_unlock(&targetLock);
}

- (uint64_t)plannedTicks:(NSUInteger)index {
    return self.startTicks + (uint64_t)llround((double)index * self.gapTicks);
}

- (void)startDisplayLinkObservation {
    NSAssert(NSThread.isMainThread, @"the display link of the recorded window is installed on the main thread");
    NSWindow *window = nil;
    for (NSWindow *candidate in NSApp.windows) {
        if (candidate.windowNumber == self.windowNumber) { window = candidate; break; }
    }
    NSString *reason = window == nil ? @"the captured window is not available in AppKit"
        : !window.isVisible ? @"the captured window is hidden"
        : window.screen == nil ? @"the captured window is not on a display" : nil;
    CADisplayLink *link = reason == nil ? [window displayLinkWithTarget:self selector:@selector(displayLinkDidRefresh:)] : nil;
    if (reason == nil && link == nil) reason = @"AppKit did not provide a display link for the captured window";
    @synchronized (self) {
        if (reason != nil) {
            self.displayLinkReason = reason;
            return;
        }
        self.displayWindow = window;
        self.displayLink = link;
    }
    [link addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
}

- (void)stopDisplayLinkObservation {
    CADisplayLink *link = nil;
    NSWindow *window = nil;
    @synchronized (self) {
        self.displayLinkStopped = YES;
        link = [self.displayLink retain];
        self.displayLink = nil;
        window = [self.displayWindow retain];
        self.displayWindow = nil;
    }
    if (link == nil && window == nil) return;
    // The link retains the recording as its target until it is invalidated on the main thread.
    onMain(^{
        [link invalidate];
        [link release];
        [window release];
    });
}

- (void)displayLinkDidRefresh:(CADisplayLink *)link {
    NSWindow *window = nil;
    @synchronized (self) {
        if (self.displayLinkStopped || link != self.displayLink) return;
        window = [[self.displayWindow retain] autorelease];
    }
    uint64_t callbackTime = captureTicks();
    double mediaClockTime = CACurrentMediaTime();
    uint64_t mediaClockAfter = captureTicks();
    // The windows of the next still follow the windows of this refresh: a child window that appeared since the last refresh is in
    // the next still. The callback reads the AppKit windows; the window server is asked on captureWindowReads.
    [self readWindowsOfNextStill];
    mach_timebase_info_data_t timebase = {};
    if (captureReadTimebase(&timebase) != KERN_SUCCESS) {
        [self rejectDisplayLinkObservation:@"mach_timebase_info failed for a display-link callback"];
        return;
    }
    NSNumber *displayID = window.screen.deviceDescription[@"NSScreenNumber"];
    BOOL occluded = (window.occlusionState & NSWindowOcclusionStateVisible) == 0;
    // The first callback of a stretch in which no part of the window shows reads the windows in front of it from the window list of
    // the window server, which tells what covers it; the reading changes no window, and the callbacks after it in the stretch do
    // not read the list again.
    BOOL wasCovered = NO;
    @synchronized (self) {
        wasCovered = self.displayLinkCovered;
        self.displayLinkCovered = occluded;
    }
    NSMutableDictionary *observation = [self recordDisplayLinkTimestamp:link.timestamp targetTimestamp:link.targetTimestamp
        duration:link.duration callbackTime:callbackTime mediaClockTime:mediaClockTime mediaClockAfter:mediaClockAfter
        timebase:timebase windowNumber:window.windowNumber displayID:displayID
        visible:window.isVisible occluded:occluded applicationActive:NSApp.isActive inFront:nil];
    // The window list of the window server is read on captureWindowReads right after the callback, and its windows in front are
    // added to the observation of the callback.
    if (observation != nil && occluded && !wasCovered) {
        long number = window.windowNumber;
        dispatch_async(captureWindowReads, ^{ @autoreleasepool {
            NSArray *inFront = sp_window_in_front(number) ?: @[];
            @synchronized (self) { observation[@"inFront"] = inFront; }
        } });
    }
}

// Reads on the main thread the AppKit windows of the next still and asks the window server for their order on captureWindowReads.
// While an earlier read waits there, the callback reads no windows, the next still keeps the windows of the earlier read, and
// the skip is counted (skippedWindowReads of the lifecycle events), so a slow window server is not given a request per refresh.
- (void)readWindowsOfNextStill {
    @synchronized (self) {
        if (self.readingWindows) {
            self.skippedWindowReads++;
            return;
        }
        self.readingWindows = YES;
    }
    NSString *failure = nil;
    NSSet<NSNumber *> *numbers = shownWindowsOnMain(self.windowNumber, &failure);
    long number = self.windowNumber;
    BOOL display = self.display;
    dispatch_async(captureWindowReads, ^{ @autoreleasepool {
        [self replaceTarget:numbers ? resolveShownTarget(number, display, numbers) : failedTarget(failure)];
        @synchronized (self) { self.readingWindows = NO; }
    } });
}

- (void)rejectDisplayLinkObservation:(NSString *)reason {
    @synchronized (self) {
        if (self.displayLinkStopped) return;
        BOOL firstFailure = ![self.displayLinkState isEqual:@"incomplete"];
        self.displayLinkState = @"incomplete";
        self.displayLinkReason = reason;
        self.omittedDisplayLinkObservations++;
        if (firstFailure) setCaptureError([NSString stringWithFormat:@"display-link trace incomplete: %@", reason]);
    }
}

- (NSMutableDictionary *)recordDisplayLinkTimestamp:(double)timestamp targetTimestamp:(double)targetTimestamp duration:(double)duration
    callbackTime:(uint64_t)callbackTime mediaClockTime:(double)mediaClockTime mediaClockAfter:(uint64_t)mediaClockAfter
    timebase:(mach_timebase_info_data_t)timebase windowNumber:(long)windowNumber
    displayID:(NSNumber *)displayID visible:(BOOL)visible occluded:(BOOL)occluded applicationActive:(BOOL)applicationActive
    inFront:(NSArray *)inFront {
    NSMutableDictionary *recorded = nil;
    @synchronized (self) {
        if (self.displayLinkStopped) return nil;
        if ([self.displayLinkState isEqual:@"incomplete"]) {
            self.omittedDisplayLinkObservations++;
            return nil;
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
            NSMutableDictionary *observation = [NSMutableDictionary dictionaryWithDictionary:@{
                @"sequence": @(self.displayLinkObservations.count + 1),
                @"timestamp": @(timestamp),
                @"targetTimestamp": @(targetTimestamp),
                @"duration": @(duration),
                @"callbackTime": tickString(callbackTime),
                @"callbackMediaTime": @(mediaClockTime),
                @"mediaClockAfter": tickString(mediaClockAfter),
                @"machTimebaseNumerator": @(timebase.numer),
                @"machTimebaseDenominator": @(timebase.denom),
                @"windowNumber": @(windowNumber),
                @"displayID": displayID ?: [NSNull null],
                @"visible": @(visible),
                @"occluded": @(occluded),
                @"applicationActive": @(applicationActive),
            }];
            if (inFront) observation[@"inFront"] = inFront;
            [self.displayLinkObservations addObject:observation];
            recorded = observation;
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
    return recorded;
}

- (NSDictionary *)displayLinkRecord {
    @synchronized (self) {
        return @{
            @"state": self.displayLinkState ?: @"unavailable",
            @"reason": self.displayLinkReason ?: @"display-link state was not recorded",
            // Each observation is copied under the lock, because a read on captureWindowReads adds the windows in front to it.
            @"observations": [[[NSArray alloc] initWithArray:self.displayLinkObservations copyItems:YES] autorelease],
            @"omittedObservations": @(self.omittedDisplayLinkObservations),
        };
    }
}
@end

// The error of the recordings.
static void appendCaptureError(NSString *message) {
    NSString *combined = captureError == nil ? [message copy]
        : [[captureError stringByAppendingFormat:@"; %@", message] copy];
    [captureError release];
    captureError = combined;
}

static void clearCaptureError(void) {
    @synchronized ([SPCaptureRecording class]) {
        [captureError release];
        captureError = nil;
    }
}

static void setCaptureError(NSString *message) {
    @synchronized ([SPCaptureRecording class]) { appendCaptureError(message); }
    sp_log_error("capture", message.UTF8String);
}

static bool hasCaptureError(void) {
    @synchronized ([SPCaptureRecording class]) { return captureError != nil; }
}

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

const char *sp_capture_error(void) {
    @synchronized ([SPCaptureRecording class]) {
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

// Settles still index: its outcome, its error and its frame. The first settled still 0 ends the wait of the start, and the
// stop waits until every requested still settled.
static void stillOutcome(SPCaptureRecording *recording, NSUInteger index, NSString *outcome, NSString *error, NSString *frame) {
    NSDictionary *row = nil;
    BOOL plannedDone = NO;
    @synchronized (recording) {
        NSMutableDictionary *record = recording.rows[index];
        record[@"outcome"] = outcome;
        record[@"error"] = error ?: (id)NSNull.null;
        record[@"frame"] = frame ?: (id)NSNull.null;
        // A still without a frame names no colour space.
        if (frame == nil) {
            record[@"colorSpace"] = NSNull.null;
            record[@"colorProfile"] = NSNull.null;
        }
        if ([outcome isEqual:@"written"]) recording.written++;
        recording.outcomes++;
        row = [[record copy] autorelease];
        plannedDone = recording.requestsDone && recording.outcomes == recording.nextIndex;
    }
    if (error != nil) {
        setCaptureError([NSString stringWithFormat:@"still %lu: %@", (unsigned long)index, error]);
        emitLifecycle(recording, @"still-failed", SP_EVENT_ERROR, row, error);
    } else if (index == 0) {
        emitLifecycle(recording, @"first-still", SP_EVENT_DEBUG, row, nil);
    }
    if (index == 0) dispatch_semaphore_signal(recording.firstStill);
    if (plannedDone) dispatch_semaphore_signal(recording.stopSignal);
}

// Reports the cause saved right after a file operation together with the path.
static NSString *fileFailure(NSString *operation, NSString *path, int error) {
    return [NSString stringWithFormat:@"%@ %@: %s", operation, path, strerror(error)];
}

// Writes the frame of still index on the serial writer: the header and the lossless LZ4 block of all pixels and row padding,
// first to a .partial file that is renamed when whole.
static void writeFrame(SPCaptureRecording *recording, NSUInteger index, uint8_t *frame, size_t pixels) {
    NSString *name = [NSString stringWithFormat:@"frame-%04lu.bgra", (unsigned long)index];
    NSString *path = [recording.directory stringByAppendingPathComponent:name];
    @synchronized (recording) {
        recording.rows[index][@"writerEnqueuedTime"] = tickString(captureTicks());
    }
    dispatch_async(captureWriter, ^{
        uint64_t writerStarted = captureTicks();
        NSString *failure = nil;
        // The worst case of an LZ4 block and the margin that the LZ4 encoder keeps free at the end of its output: with the worst
        // case alone, the encoder failed the 64 bytes of a 4x4 still (capacity 80).
        size_t capacity = pixels + pixels / 255 + 16 + kLZ4OutputMargin;
        uint8_t *encoded = capacity <= UINT32_MAX ? malloc(kFrameEncodedHeader + capacity) : NULL;
        size_t compressed = 0;
        if (encoded != NULL) {
            memcpy(encoded, frame, kFrameHeader);
            memcpy(encoded + kFrameHeader, "LZ4S", 4);
            compressed = compression_encode_buffer(encoded + kFrameEncodedHeader, capacity, frame + kFrameHeader, pixels, NULL,
                COMPRESSION_LZ4_RAW);
            uint32_t count = (uint32_t)compressed;
            uint32_t checksum = (uint32_t)crc32(0, frame + kFrameHeader, (uInt)pixels);
            memcpy(encoded + kFrameHeader + 4, &count, sizeof count);
            memcpy(encoded + kFrameHeader + 8, &checksum, sizeof checksum);
        }
        free(frame);
        if (encoded == NULL || compressed == 0) {
            failure = [NSString stringWithFormat:@"the frame could not be losslessly compressed (capacity %zu)", capacity];
        } else {
            NSString *pending = [path stringByAppendingString:@".partial"];
            FILE *file = fopen(pending.fileSystemRepresentation, "wb");
            if (file == NULL) {
                // A path that could not be opened is not owned by this write, so it is not deleted.
                failure = fileFailure(@"open", pending, errno);
            } else {
                bool whole = fwrite(encoded, kFrameEncodedHeader + compressed, 1, file) == 1;
                if (!whole) failure = fileFailure(@"write", pending, errno);
                // Closes also after a write failure. Each failure keeps its own system error.
                bool closed = fclose(file) == 0;
                if (!closed) {
                    NSString *closeFailure = fileFailure(@"close", pending, errno);
                    failure = failure ? [failure stringByAppendingFormat:@"; %@", closeFailure] : closeFailure;
                }
                if (whole && closed && rename(pending.fileSystemRepresentation, path.fileSystemRepresentation) != 0)
                    failure = fileFailure(@"commit", path, errno);
                if (failure != nil && unlink(pending.fileSystemRepresentation) != 0 && errno != ENOENT)
                    failure = [failure stringByAppendingFormat:@"; %@", fileFailure(@"remove", pending, errno)];
            }
        }
        free(encoded);
        @synchronized (recording) {
            recording.rows[index][@"writerStartTime"] = tickString(writerStarted);
            recording.rows[index][@"writerCompleteTime"] = tickString(captureTicks());
        }
        dispatch_semaphore_signal(capturePending);
        if (failure != nil) stillOutcome(recording, index, @"failed", [NSString stringWithFormat:@"the frame was not written: %@", failure], nil);
        else stillOutcome(recording, index, @"written", nil, name);
    });
}

// The name of the ICC profile file of space inside the recording folder, color-<first 16 hex digits of its SHA-256>.icc, which
// the first still in that space writes; nil with reason when the space has no profile or the file cannot be written.
static NSString *colorProfileFile(SPCaptureRecording *recording, CGColorSpaceRef space, NSString **reason) {
    NSData *profile = space ? [(NSData *)CGColorSpaceCopyICCData(space) autorelease] : nil;
    if (profile.length == 0) {
        *reason = @"the colour space of the image has no ICC profile";
        return nil;
    }
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(profile.bytes, (CC_LONG)profile.length, digest);
    NSMutableString *name = [NSMutableString stringWithString:@"color-"];
    for (int index = 0; index < 8; index++) [name appendFormat:@"%02x", digest[index]];
    [name appendString:@".icc"];
    @synchronized (recording) {
        if ([recording.profiles containsObject:name]) return name;
        NSError *error = nil;
        NSString *path = [recording.directory stringByAppendingPathComponent:name];
        if (![profile writeToFile:path options:NSDataWritingAtomic error:&error]) {
            *reason = [NSString stringWithFormat:@"the colour profile %@ could not be written: %@", name,
                error.localizedDescription ?: @"no write error was provided"];
            return nil;
        }
        [recording.profiles addObject:name];
    }
    return name;
}

// Processes the image of still index after its completion: its pixels as BGRA in the colour space of the image with the header,
// the ICC profile of that space, and the frame write. image is released by the caller.
static void processStill(SPCaptureRecording *recording, NSUInteger index, SPCaptureTarget *target, CGImageRef image,
    uint64_t requested, uint64_t completed) {
    uint64_t processStarted = captureTicks();
    NSString *failure = nil;
    size_t width = image ? CGImageGetWidth(image) : 0, height = image ? CGImageGetHeight(image) : 0;
    CGRect screen = image ? imageScreen(target) : CGRectNull;
    double scale = width > 0 && !CGRectIsNull(screen) && CGRectGetWidth(screen) > 0 ? width / CGRectGetWidth(screen) : 0;
    if (image == NULL) {
        failure = [NSString stringWithFormat:@"the window server gave no image of window %ld", recording.windowNumber];
    } else if (width == 0 || height == 0) {
        failure = [NSString stringWithFormat:@"the window server gave an empty image of window %ld", recording.windowNumber];
    } else if (!(scale > 0) || !isfinite(scale)) {
        failure = [NSString stringWithFormat:@"window %ld has no bounds in the window server", recording.windowNumber];
    }
    if (failure != nil) {
        stillOutcome(recording, index, @"failed", failure, nil);
        return;
    }
    size_t stride = width * 4, pixels = stride * height;
    uint8_t *frame = pixels / height == stride ? malloc(kFrameHeader + pixels) : NULL;
    NSString *drawFailure = frame == NULL ? @"no memory for the frame" : drawOwnSpace(image, frame + kFrameHeader, width, height, stride);
    if (drawFailure != nil) {
        free(frame);
        stillOutcome(recording, index, @"failed", [NSString stringWithFormat:@"the image of %zux%zu pixels could not be drawn: %@",
            width, height, drawFailure], nil);
        return;
    }
    CGColorSpaceRef space = CGImageGetColorSpace(image);
    NSString *profileFailure = nil;
    NSString *profile = colorProfileFile(recording, space, &profileFailure);
    if (profile == nil) {
        free(frame);
        stillOutcome(recording, index, @"failed", profileFailure, nil);
        return;
    }
    // A named colour space keeps its name; another one is named by its profile.
    NSString *spaceName = [(NSString *)CGColorSpaceCopyName(space) autorelease];
    @synchronized (recording) {
        recording.rows[index][@"colorSpace"] = spaceName ?: (id)NSNull.null;
        recording.rows[index][@"colorProfile"] = profile;
    }
    CGRect content = CGRectMake(0, 0, width / scale, height / scale);
    mach_timebase_info_data_t timebase = recording.timebase;
    uint32_t head[3] = { (uint32_t)width, (uint32_t)height, (uint32_t)stride };
    double info[8] = { CGRectGetMinX(content), CGRectGetMinY(content), CGRectGetWidth(content), CGRectGetHeight(content), 1, scale,
        ticksToMilliseconds(requested, timebase), ticksToMilliseconds(completed, timebase) };
    memcpy(frame, head, sizeof head);
    memcpy(frame + sizeof head, info, sizeof info);
    @synchronized (recording) {
        NSMutableDictionary *row = recording.rows[index];
        row[@"writeStartTime"] = tickString(processStarted);
        row[@"writeCompleteTime"] = tickString(captureTicks());
    }
    // A still that waits for the writer would move the requests after it, so a full writer fails the still instead.
    if (dispatch_semaphore_wait(capturePending, DISPATCH_TIME_NOW) != 0) {
        free(frame);
        stillOutcome(recording, index, @"failed",
            [NSString stringWithFormat:@"capture pending writer capacity exceeded (%ld frames)", kCapturePending], nil);
        return;
    }
    writeFrame(recording, index, frame, pixels);
}

// Takes still index: reads the request time right before the window server call and the completion time right after the pixels
// of its image are copied (takeImage), and records both with the windows that the still took.
static void takeStill(SPCaptureRecording *recording, NSUInteger index, SPCaptureTarget *target) {
    uint64_t requested = captureTicks();
    if (target.error != nil) {
        @synchronized (recording) {
            recording.awaitingImages--;
            recording.rows[index][@"requested"] = tickString(requested);
            recording.rows[index][@"windows"] = @[];
        }
        stillOutcome(recording, index, @"failed", target.error, nil);
        return;
    }
    requested = captureTicks();
    CGImageRef image = takeImage(recording.function, target);
    uint64_t completed = captureTicks();
    BOOL reached = NO;
    @synchronized (recording) {
        recording.awaitingImages--;
        NSMutableDictionary *row = recording.rows[index];
        row[@"requested"] = tickString(requested);
        row[@"completed"] = tickString(completed);
        row[@"windows"] = target.windows ?: @[];
        recording.completedCount++;
        reached = recording.stopArmed && !recording.stopReached && requested >= recording.stopAfterTicks;
        if (reached) recording.stopReached = YES;
    }
    if (reached) dispatch_semaphore_signal(recording.stopSignal);
    processStill(recording, index, target, image, requested, completed);
    if (image) CGImageRelease(image);
}

// Fails still index at its request because kCaptureInFlight stills wait for their image: it takes no window, as a still whose
// windows could not be taken.
static void refuseStill(SPCaptureRecording *recording, NSUInteger index, uint64_t requested) {
    @synchronized (recording) {
        recording.rows[index][@"requested"] = tickString(requested);
        recording.rows[index][@"windows"] = @[];
    }
    stillOutcome(recording, index, @"failed",
        [NSString stringWithFormat:@"capture in-flight capacity exceeded (%lu stills)", (unsigned long)kCaptureInFlight], nil);
}

// Requests on the worker queue every still whose planned time has come, then sets the strict timer for the next planned still. A
// still whose request finds kCaptureInFlight stills waiting for their image fails at once (refuseStill): it does not wait, so the
// requests after it keep their planned times.
static void requestDueStills(SPCaptureRecording *recording) {
    uint64_t now = captureTicks();
    BOOL done = NO;
    NSMutableArray<NSNumber *> *refused = [NSMutableArray array];
    @synchronized (recording) {
        while (!recording.closed && recording.nextIndex < recording.planned && [recording plannedTicks:recording.nextIndex] <= now) {
            NSUInteger index = recording.nextIndex;
            recording.nextIndex = index + 1;
            if (recording.awaitingImages >= kCaptureInFlight) {
                // The stop waits for the group, so it also waits for the refusal, which settles the still after the lock.
                dispatch_group_enter(recording.inflight);
                [refused addObject:@(index)];
                continue;
            }
            recording.awaitingImages++;
            dispatch_group_async(recording.inflight, captureWorkers, ^{
                @autoreleasepool { takeStill(recording, index, [recording currentTarget]); }
            });
        }
        if (recording.closed || recording.nextIndex >= recording.planned) {
            if (recording.timer) dispatch_source_cancel(recording.timer);
            if (!recording.requestsDone) {
                recording.requestsDone = YES;
                done = recording.outcomes == recording.nextIndex;
            }
        } else {
            uint64_t next = [recording plannedTicks:recording.nextIndex];
            mach_timebase_info_data_t timebase = recording.timebase;
            uint64_t ticks = next > now ? next - now : 0;
            int64_t nanoseconds = (int64_t)((double)ticks * timebase.numer / timebase.denom);
            dispatch_source_set_timer(recording.timer, dispatch_time(DISPATCH_TIME_NOW, nanoseconds), DISPATCH_TIME_FOREVER, 0);
        }
    }
    for (NSNumber *index in refused) {
        refuseStill(recording, index.unsignedIntegerValue, now);
        dispatch_group_leave(recording.inflight);
    }
    // Every planned still was requested and every one settled already: a stop that waits for a later request learns the end.
    if (done) dispatch_semaphore_signal(recording.stopSignal);
}

// Closes the requests of a recording: no later still is requested. The stills not requested stay not requested, or fail with
// failure when it is given. They fail under the lock that closes the requests, so a stop that learns the end sees them failed.
static void closeRequests(SPCaptureRecording *recording, NSString *failure) {
    BOOL done = NO;
    @synchronized (recording) {
        recording.closed = YES;
        if (recording.timer) dispatch_source_cancel(recording.timer);
        for (NSUInteger index = recording.nextIndex; failure != nil && index < recording.planned; index++) {
            recording.rows[index][@"outcome"] = @"failed";
            recording.rows[index][@"error"] = failure;
        }
        if (!recording.requestsDone) {
            recording.requestsDone = YES;
            done = recording.outcomes == recording.nextIndex;
        }
    }
    if (done) dispatch_semaphore_signal(recording.stopSignal);
}

// The ends of the capture waits. The host ends the wait of a call by the token of that call (sp_capture_end_wait), from any
// thread, because each call waits on the thread that made it. The reason of each ended token is kept until its call returns;
// the host gives every call a new, larger token, so the return of a call forgets the ends of its token and of every earlier
// token, and an end that comes after its call returned changes no later call. Calls of several tokens can wait at once, so
// each token keeps the semaphore that its call awaits.
static pthread_mutex_t captureEndLock = PTHREAD_MUTEX_INITIALIZER;
static NSMutableDictionary<NSNumber *, NSString *> *captureEnds;
static NSMutableDictionary<NSNumber *, NSValue *> *captureAwaited;

// Waits on signal until it is raised or until sp_capture_end_wait ends the wait of token. A raised signal is taken before an
// end, so a wait whose event already came is not ended. It returns nil for a raised signal and `<missing> before <reason>` for
// an ended wait. The end raises signal once, which this wait takes back.
static NSString *awaitCaptureSignal(dispatch_semaphore_t signal, uint64_t token, NSString *missing) {
    if (dispatch_semaphore_wait(signal, DISPATCH_TIME_NOW) == 0) return nil;
    pthread_mutex_lock(&captureEndLock);
    NSString *ended = [[captureEnds[@(token)] retain] autorelease];
    if (!ended) {
        if (!captureAwaited) captureAwaited = [[NSMutableDictionary alloc] init];
        captureAwaited[@(token)] = [NSValue valueWithPointer:signal];
    }
    pthread_mutex_unlock(&captureEndLock);
    if (!ended) {
        dispatch_semaphore_wait(signal, DISPATCH_TIME_FOREVER);
        pthread_mutex_lock(&captureEndLock);
        [captureAwaited removeObjectForKey:@(token)];
        ended = [[captureEnds[@(token)] retain] autorelease];
        pthread_mutex_unlock(&captureEndLock);
    }
    if (!ended) return nil;
    NSString *message = [NSString stringWithFormat:@"%@ before %@", missing, ended];
    sp_log_error("capture wait", message.UTF8String);
    return message;
}

// Forgets the ends of token and of every earlier token when the call of token returns.
static void forgetCaptureEnd(uint64_t token) {
    pthread_mutex_lock(&captureEndLock);
    for (NSNumber *ended in captureEnds.allKeys) {
        if (ended.unsignedLongLongValue <= token) [captureEnds removeObjectForKey:ended];
    }
    pthread_mutex_unlock(&captureEndLock);
}

void sp_capture_end_wait(uint64_t token, const char *reason) {
    @autoreleasepool {
        NSString *end = reason ? [NSString stringWithUTF8String:reason] : nil;
        pthread_mutex_lock(&captureEndLock);
        if (!captureEnds) captureEnds = [[NSMutableDictionary alloc] init];
        captureEnds[@(token)] = end ?: @"its wait ended";
        dispatch_semaphore_t awaited = (dispatch_semaphore_t)captureAwaited[@(token)].pointerValue;
        if (awaited) dispatch_semaphore_signal(awaited);
        pthread_mutex_unlock(&captureEndLock);
    }
}

// The recording of a new window from its first still (sp_capture_hold_new_window). The window that the hold took is off the
// screen until the start of its recording, which puts it on screen and takes still 0 in the same main-thread step.
static pthread_mutex_t heldWindowLock = PTHREAD_MUTEX_INITIALIZER;
static dispatch_semaphore_t heldWindowShown;
static long heldWindowNumber = -1;

static bool isHeldWindow(long windowNumber) {
    pthread_mutex_lock(&heldWindowLock);
    bool held = heldWindowNumber >= 0 && heldWindowNumber == windowNumber;
    pthread_mutex_unlock(&heldWindowLock);
    return held;
}

// Ends the hold on the main thread: the held window goes on screen, its order is committed, and the hold is dropped.
static void releaseHeldWindowOnMain(void) {
    sp_window_show_release_held();
    pthread_mutex_lock(&heldWindowLock);
    heldWindowNumber = -1;
    if (heldWindowShown) dispatch_release(heldWindowShown);
    heldWindowShown = NULL;
    pthread_mutex_unlock(&heldWindowLock);
}

static bool recordingActive(void) {
    @synchronized ([SPCaptureRecording class]) { return captureRecording != nil; }
}

bool sp_capture_hold_new_window(char **errorOut) {
    NSCAssert(NSThread.isMainThread, @"the hold of a new window requires the UI thread");
    if (errorOut == NULL) {
        sp_log_error("capture hold", "an error output is required");
        return false;
    }
    *errorOut = NULL;
    if (recordingActive()) return captureOperationFailure(errorOut, @"capture is already running");
    dispatch_semaphore_t shown = dispatch_semaphore_create(0);
    bool set = sp_window_show_hold_next(^(void *handle) {
        NSWindow *window = (NSWindow *)handle;
        pthread_mutex_lock(&heldWindowLock);
        heldWindowNumber = window.windowNumber;
        pthread_mutex_unlock(&heldWindowLock);
        dispatch_semaphore_signal(shown);
    });
    if (!set) {
        dispatch_release(shown);
        return captureOperationFailure(errorOut, @"a new window is already held for a recording");
    }
    pthread_mutex_lock(&heldWindowLock);
    if (heldWindowShown) dispatch_release(heldWindowShown);
    heldWindowShown = shown;
    heldWindowNumber = -1;
    pthread_mutex_unlock(&heldWindowLock);
    return true;
}

long sp_capture_wait_new_window(uint64_t token) {
    pthread_mutex_lock(&heldWindowLock);
    dispatch_semaphore_t shown = heldWindowShown;
    if (shown) dispatch_retain(shown);
    pthread_mutex_unlock(&heldWindowLock);
    if (!shown) {
        setCaptureError(@"no new window is held for a recording");
        forgetCaptureEnd(token);
        return -1;
    }
    NSString *ended = awaitCaptureSignal(shown, token, @"no new window was shown");
    forgetCaptureEnd(token);
    if (ended) {
        dispatch_release(shown);
        setCaptureError(ended);
        sp_capture_release_new_window();
        return -1;
    }
    // A later wait for the same window passes too.
    dispatch_semaphore_signal(shown);
    dispatch_release(shown);
    pthread_mutex_lock(&heldWindowLock);
    long number = heldWindowNumber;
    pthread_mutex_unlock(&heldWindowLock);
    return number;
}

void sp_capture_release_new_window(void) {
    if (NSThread.isMainThread) {
        releaseHeldWindowOnMain();
        return;
    }
    dispatch_async(dispatch_get_main_queue(), ^{ releaseHeldWindowOnMain(); });
}

bool sp_capture_open(long windowNumber, bool display, char **errorOut) {
    if (errorOut == NULL) {
        sp_log_error("capture open", "an error output is required");
        return false;
    }
    *errorOut = NULL;
    if (recordingActive()) return captureOperationFailure(errorOut, @"capture is already running");
    // A failed open leaves no prepared window, so a later start does not record the window of an earlier open.
    @synchronized ([SPCaptureRecording class]) { captureWindowNumber = -1; }
    if (windowImageFunction() == NULL) return captureOperationFailure(errorOut, kWindowImageMissing);
    // The held window is off the screen until the start puts it there.
    if (!(isHeldWindow(windowNumber) && !display)) {
        SPCaptureTarget *target = resolveTarget(windowNumber, display);
        if (target.error != nil) return captureOperationFailure(errorOut, target.error);
    }
    @synchronized ([SPCaptureRecording class]) {
        captureWindowNumber = windowNumber;
        captureDisplay = display;
    }
    return true;
}

// Ends the current recording when its window closes: a window that closes is not drawn again, so the stills not requested fail
// with the close, and the recording fails with `the recorded window <n> closed`.
static void observeCaptureWindows(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        sp_observe_notification("capture.window_close", SP_OBSERVE_COUNT, NSWindowWillCloseNotification, nil, nil,
            ^(NSNotification *note) {
            SPCaptureRecording *recording = nil;
            @synchronized ([SPCaptureRecording class]) {
                if (captureRecording == nil || [(NSWindow *)note.object windowNumber] != captureRecording.windowNumber) return;
                recording = [captureRecording retain];
            }
            NSString *closed = [NSString stringWithFormat:@"the recorded window %ld closed", recording.windowNumber];
            // The error of the close is set before the requests close: closing them can end the wait of a stop on another
            // thread, and that stop reads whether the recording has an error to decide whether the plan ended before its time.
            setCaptureError(closed);
            closeRequests(recording, closed);
            dispatch_semaphore_signal(recording.stopSignal);
            [recording release];
        });
    });
}

static NSString *const kCaptureStillsFile = @"stills.jsonl";
static NSString *const kCaptureDisplayLinkFile = @"display-link.json";

static bool writeCaptureStills(SPCaptureRecording *recording) {
    NSMutableData *contents = [NSMutableData data];
    NSArray<NSDictionary *> *rows = nil;
    @synchronized (recording) {
        NSMutableArray *copies = [NSMutableArray arrayWithCapacity:recording.rows.count];
        // The planned time of a still follows from the plan (plannedTicks:), so the record names it as it is written.
        for (NSDictionary *row in recording.rows) {
            NSMutableDictionary *copied = [[row mutableCopy] autorelease];
            copied[@"planned"] = tickString([recording plannedTicks:[row[@"index"] unsignedIntegerValue]]);
            [copies addObject:copied];
        }
        rows = copies;
    }
    for (NSDictionary *row in rows) {
        NSError *error = nil;
        NSData *line = nil;
        NSString *encodingFailure = nil;
        @try {
            line = [NSJSONSerialization dataWithJSONObject:row options:0 error:&error];
        } @catch (NSException *exception) { // silent: preserve the exception reason for the explicit capture error below.
            encodingFailure = exception.reason ?: exception.name;
        }
        if (line == nil) {
            NSString *reason = encodingFailure ?: error.localizedDescription ?: @"no encoding error was provided";
            setCaptureError([NSString stringWithFormat:@"stills.jsonl could not encode the row of still %@: %@", row[@"index"], reason]);
            return false;
        }
        [contents appendData:line];
        [contents appendBytes:"\n" length:1];
    }
    NSString *path = [recording.directory stringByAppendingPathComponent:kCaptureStillsFile];
    NSError *error = nil;
    if (![contents writeToFile:path options:NSDataWritingAtomic error:&error]) {
        setCaptureError([NSString stringWithFormat:@"stills.jsonl could not be written to %@: %@", path,
            error.localizedDescription ?: @"no write error was provided"]);
        return false;
    }
    return true;
}

static bool writeCaptureDisplayLinkTrace(SPCaptureRecording *recording) {
    NSError *error = nil;
    NSData *data = nil;
    NSString *encodingFailure = nil;
    @try {
        data = [NSJSONSerialization dataWithJSONObject:[recording displayLinkRecord] options:NSJSONWritingPrettyPrinted error:&error];
    } @catch (NSException *exception) { // silent: preserve the exception reason for the explicit capture error below.
        encodingFailure = exception.reason ?: exception.name;
    }
    if (data == nil) {
        NSString *reason = encodingFailure ?: error.localizedDescription ?: @"no encoding error was provided";
        setCaptureError([NSString stringWithFormat:@"capture display-link trace could not be encoded: %@", reason]);
        return false;
    }
    NSString *path = [recording.directory stringByAppendingPathComponent:kCaptureDisplayLinkFile];
    if (![data writeToFile:path options:NSDataWritingAtomic error:&error]) {
        NSString *reason = error.localizedDescription ?: @"no write error was provided";
        setCaptureError([NSString stringWithFormat:@"capture display-link trace could not write %@: %@", path, reason]);
        return false;
    }
    return true;
}

// Finalizes the artifacts of a recording whose stills all settled: writes stills.jsonl and display-link.json.
static bool finalizeCaptureArtifacts(SPCaptureRecording *recording) {
    [recording stopDisplayLinkObservation];
    // The window reads that the last callbacks queued add their windows in front to the record before it is written.
    dispatch_sync(captureWindowReads, ^{});
    bool stillsWritten = writeCaptureStills(recording);
    bool displayLinkWritten = writeCaptureDisplayLinkTrace(recording);
    return stillsWritten && displayLinkWritten;
}

// Ends the recording: no later still is requested, every requested still settles, the artifacts are written, and the counts of
// the recording become those of sp_capture_missed, sp_capture_late and sp_capture_longest_gap.
static int finishRecording(SPCaptureRecording *recording) {
    closeRequests(recording, nil);
    dispatch_group_wait(recording.inflight, DISPATCH_TIME_FOREVER);
    // The writer settles every queued frame before the record is written.
    dispatch_sync(captureWriter, ^{});
    finalizeCaptureArtifacts(recording);
    int written = 0, missed = 0, late = 0;
    double longest = 0;
    @synchronized (recording) {
        written = recording.written;
        uint64_t previous = 0;
        for (NSDictionary *row in recording.rows) {
            if (![row[@"outcome"] isEqual:@"written"]) {
                missed++;
            } else {
                uint64_t requested = strtoull([row[@"requested"] UTF8String], NULL, 10);
                if (previous != 0 && requested > previous)
                    longest = MAX(longest, ticksToMilliseconds(requested - previous, recording.timebase));
                previous = requested;
            }
            if ([row[@"requested"] isKindOfClass:NSString.class]) {
                uint64_t requested = strtoull([row[@"requested"] UTF8String], NULL, 10);
                uint64_t planned = [recording plannedTicks:[row[@"index"] unsignedIntegerValue]];
                if (requested > planned && (double)(requested - planned) > recording.gapTicks) late++;
            }
        }
    }
    @synchronized ([SPCaptureRecording class]) {
        captureMissed = missed;
        captureLate = late;
        captureLongestGap = longest;
    }
    emitLifecycle(recording, @"end", hasCaptureError() ? SP_EVENT_ERROR : SP_EVENT_DEBUG, nil,
        hasCaptureError() ? [NSString stringWithUTF8String:sp_capture_error()] : nil);
    @synchronized ([SPCaptureRecording class]) {
        if (captureRecording == recording) {
            [captureRecording release];
            captureRecording = nil;
        }
    }
    sp_log_info("capture", [NSString stringWithFormat:@"%d of %lu planned stills written, %d missed, %d late, longest gap %.1fms",
        written, (unsigned long)recording.planned, missed, late, longest].UTF8String);
    return written;
}

// The plan of a start, or the reason it is refused. The arguments are checked before the prepared window.
static NSString *planStills(double gap, double seconds, int frames, NSUInteger *planned) {
    if (!isfinite(gap) || gap < 1 || gap > 1000) return @"gap must be a number of milliseconds from 1 to 1000";
    bool hasSeconds = seconds != 0, hasFrames = frames != 0;
    if (hasSeconds && hasFrames) return @"give seconds or frames, not both";
    if (!hasSeconds && !hasFrames) return @"a recording needs seconds or frames";
    if (hasSeconds) {
        if (!(seconds > 0 && seconds <= 600)) return @"seconds must be above 0 and at most 600";
        // Every still whose planned time n·gap is before the length.
        double count = ceil(seconds * 1000 / gap);
        if (count > 4096) return [NSString stringWithFormat:@"the recording plans %.0f stills, more than 4096", count];
        *planned = (NSUInteger)count;
        return nil;
    }
    if (frames < 1 || frames > 4096) return @"frames must be an integer from 1 to 4096";
    *planned = (NSUInteger)frames;
    return nil;
}

bool sp_capture_start(const char *directory, double gap, double seconds, int frames, uint64_t token, char **errorOut) {
    if (errorOut == NULL) {
        sp_log_error("capture start", "an error output is required");
        return false;
    }
    *errorOut = NULL;
    if (recordingActive()) return captureOperationFailure(errorOut, @"capture is already running");
    clearCaptureError();
    NSUInteger planned = 0;
    NSString *refused = planStills(gap, seconds, frames, &planned);
    if (refused != nil) {
        forgetCaptureEnd(token);
        return captureOperationFailure(errorOut, refused);
    }
    long windowNumber = -1;
    BOOL display = NO;
    @synchronized ([SPCaptureRecording class]) {
        windowNumber = captureWindowNumber;
        display = captureDisplay;
    }
    if (windowNumber < 0) {
        forgetCaptureEnd(token);
        return captureOperationFailure(errorOut, @"capture has no prepared window");
    }
    if (directory == NULL) {
        forgetCaptureEnd(token);
        return captureOperationFailure(errorOut, @"capture directory is null");
    }
    NSString *folder = [NSString stringWithUTF8String:directory];
    if (folder == nil) {
        forgetCaptureEnd(token);
        return captureOperationFailure(errorOut, @"capture directory is not valid UTF-8");
    }
    SPWindowImage function = windowImageFunction();
    if (function == NULL) {
        forgetCaptureEnd(token);
        return captureOperationFailure(errorOut, kWindowImageMissing);
    }
    prepareCaptureQueues();
    SPCaptureRecording *recording = [[[SPCaptureRecording alloc] init] autorelease];
    mach_timebase_info_data_t timebase = {};
    mach_timebase_info(&timebase);
    @synchronized ([SPCaptureRecording class]) {
        captureSessionSequence++;
        recording.session = [NSString stringWithFormat:@"capture-%llu", (unsigned long long)captureSessionSequence];
    }
    recording.directory = folder;
    recording.windowNumber = windowNumber;
    recording.display = display;
    recording.gap = gap;
    recording.planned = planned;
    recording.timebase = timebase;
    recording.gapTicks = gap * 1e6 * timebase.denom / timebase.numer;
    recording.function = function;
    for (NSUInteger index = 0; index < planned; index++) {
        [recording.rows addObject:[NSMutableDictionary dictionaryWithDictionary:@{
            @"index": @(index), @"planned": NSNull.null, @"requested": NSNull.null, @"completed": NSNull.null,
            @"outcome": @"not-requested", @"error": NSNull.null, @"frame": NSNull.null, @"windows": NSNull.null,
            @"colorSpace": NSNull.null, @"colorProfile": NSNull.null, @"requestedGap": @(gap), @"machTimebaseNumerator": @(timebase.numer), @"machTimebaseDenominator": @(timebase.denom),
            @"writeStartTime": NSNull.null, @"writeCompleteTime": NSNull.null, @"writerEnqueuedTime": NSNull.null,
            @"writerStartTime": NSNull.null, @"writerCompleteTime": NSNull.null,
        }]];
    }
    @synchronized ([SPCaptureRecording class]) {
        [captureRecording release];
        captureRecording = [recording retain];
    }
    observeCaptureWindows();
    emitLifecycle(recording, @"start", SP_EVENT_DEBUG, nil, nil);
    // The strict timer requests stills 1 and later at their planned times.
    // The entrance counts each request of the timer; a refused timer was recorded as native.observe.failed, no still after still 0
    // can be requested, and the start fails once still 0 has settled.
    recording.timer = sp_observe_dispatch_timer("capture.requests", SP_OBSERVE_COUNT, DISPATCH_TIMER_STRICT, captureRequests,
        ^{ @autoreleasepool { requestDueStills(recording); } });
    NSString *timerFailure = recording.timer == NULL ? @"the timer of the still requests could not be made" : nil;
    // Still 0 is requested in one main-thread step with the windows it takes: a held window goes on screen first and its order
    // is committed, so still 0 holds the first content that the window server shows of it. The plan starts at that request, and
    // the timer is armed for still 1 before still 0 is taken: still 1 and later are requested at their planned times whether or
    // not still 0 has completed, as every still after a slow still is.
    __block SPCaptureTarget *first = nil;
    __block CGImageRef image = NULL;
    __block uint64_t requested = 0, completed = 0;
    onMain(^{
        if (isHeldWindow(windowNumber)) releaseHeldWindowOnMain();
        first = [resolveTargetOnMain(windowNumber, display) retain];
        [recording replaceTarget:first];
        [recording startDisplayLinkObservation];
        requested = captureTicks();
        recording.startTicks = requested;
        @synchronized (recording) { recording.nextIndex = 1; }
        if (timerFailure == nil) {
            if (planned > 1) {
                uint64_t now = captureTicks(), next = [recording plannedTicks:1];
                int64_t nanoseconds = next > now ? (int64_t)((double)(next - now) * timebase.numer / timebase.denom) : 0;
                dispatch_source_set_timer(recording.timer, dispatch_time(DISPATCH_TIME_NOW, nanoseconds), DISPATCH_TIME_FOREVER, 0);
            } else {
                @synchronized (recording) { recording.requestsDone = YES; }
            }
            dispatch_resume(recording.timer);
        }
        if (first.error == nil) image = takeImage(function, first);
        completed = captureTicks();
    });
    [first autorelease];
    if (timerFailure != nil) closeRequests(recording, nil);
    @synchronized (recording) {
        NSMutableDictionary *row = recording.rows[0];
        row[@"requested"] = tickString(requested);
        row[@"windows"] = first.windows ?: @[];
        if (first.error == nil) {
            row[@"completed"] = tickString(completed);
            recording.completedCount = 1;
        }
    }
    // The block retains the target and the recording; it releases the image.
    SPCaptureTarget *firstTarget = first;
    CGImageRef firstImage = image;
    uint64_t firstRequested = requested, firstCompleted = completed;
    dispatch_group_async(recording.inflight, captureWorkers, ^{
        @autoreleasepool {
            if (firstTarget.error != nil) stillOutcome(recording, 0, @"failed", firstTarget.error, nil);
            else processStill(recording, 0, firstTarget, firstImage, firstRequested, firstCompleted);
        }
        if (firstImage) CGImageRelease(firstImage);
    });
    NSString *ended = awaitCaptureSignal(recording.firstStill, token, @"the first still was not written");
    forgetCaptureEnd(token);
    NSString *firstError = nil;
    @synchronized (recording) {
        if (ended == nil && ![recording.rows[0][@"outcome"] isEqual:@"written"]) firstError = recording.rows[0][@"error"];
    }
    if (ended == nil && firstError == nil && timerFailure == nil) return true;
    NSString *failure = ended ?: firstError != nil ? [NSString stringWithFormat:@"%@", firstError] : timerFailure;
    if (ended) setCaptureError(ended);
    else if (firstError == nil) setCaptureError(timerFailure);
    finishRecording(recording);
    return captureOperationFailure(errorOut, failure);
}

int sp_capture_stop(double after, uint64_t token) {
    SPCaptureRecording *recording = nil;
    @synchronized ([SPCaptureRecording class]) { recording = [[captureRecording retain] autorelease]; }
    if (recording == nil) {
        setCaptureError(@"capture is not running");
        forgetCaptureEnd(token);
        return 0;
    }
    mach_timebase_info_data_t timebase = recording.timebase;
    uint64_t afterTicks = after > 0 ? (uint64_t)(after * 1e6 * timebase.denom / timebase.numer) : 0;
    emitLifecycle(recording, @"stop", SP_EVENT_DEBUG, nil, after > 0 ? [NSString stringWithFormat:@"after %.3f ms", after] : nil);
    if (afterTicks > 0) {
        // Waits until a still requested at or after after completed, the plan ended without one, or the recording ended.
        BOOL reached = NO, ended = NO;
        while (YES) {
            @synchronized (recording) {
                recording.stopAfterTicks = afterTicks;
                recording.stopArmed = YES;
                for (NSDictionary *row in recording.rows) {
                    if ([row[@"completed"] isKindOfClass:NSString.class]
                        && strtoull([row[@"requested"] UTF8String], NULL, 10) >= afterTicks) reached = YES;
                }
                recording.stopReached = reached;
                ended = recording.requestsDone && recording.outcomes == recording.nextIndex;
            }
            if (reached || ended) break;
            NSString *waitEnded = awaitCaptureSignal(recording.stopSignal, token, @"no still was requested at the requested time");
            if (waitEnded) {
                setCaptureError(waitEnded);
                break;
            }
        }
        if (!reached && ended && !hasCaptureError()) {
            uint64_t last = 0;
            @synchronized (recording) {
                for (NSDictionary *row in recording.rows) {
                    if ([row[@"requested"] isKindOfClass:NSString.class]) last = strtoull([row[@"requested"] UTF8String], NULL, 10);
                }
            }
            setCaptureError([NSString stringWithFormat:@"the recording ended at %.3f ms, before the requested time %.3f ms",
                ticksToMilliseconds(last, timebase), after]);
        }
    }
    forgetCaptureEnd(token);
    return finishRecording(recording);
}

int sp_capture_missed(void) {
    @synchronized ([SPCaptureRecording class]) { return captureMissed; }
}

int sp_capture_late(void) {
    @synchronized ([SPCaptureRecording class]) { return captureLate; }
}

double sp_capture_longest_gap(void) {
    @synchronized ([SPCaptureRecording class]) { return captureLongestGap; }
}

bool sp_capture_still(long windowNumber, const char *path, char **errorOut) {
    if (errorOut == NULL) {
        sp_log_error("still capture", "an error output is required");
        return false;
    }
    *errorOut = NULL;
    if (path == NULL) return captureOperationFailure(errorOut, @"still capture needs a path");
    NSString *decoded = [NSString stringWithUTF8String:path];
    if (decoded == nil) return captureOperationFailure(errorOut, @"still capture path is not valid UTF-8");
    SPWindowImage function = windowImageFunction();
    if (function == NULL) return captureOperationFailure(errorOut, kWindowImageMissing);
    SPCaptureTarget *target = resolveTarget(windowNumber, NO);
    if (target.error != nil) return captureOperationFailure(errorOut, target.error);
    CGImageRef image = takeImage(function, target);
    if (image == NULL) {
        return captureOperationFailure(errorOut, [NSString stringWithFormat:@"the window server gave no image of window %ld",
            windowNumber]);
    }
    size_t width = CGImageGetWidth(image), height = CGImageGetHeight(image), stride = width * 4;
    // The still holds the pixels as a frame does: BGRA in the colour space of the image, which the PNG names by its ICC profile.
    NSMutableData *pixels = width && height && stride / 4 == width ? [NSMutableData dataWithLength:stride * height] : nil;
    CGImageRef converted = NULL;
    NSString *drawFailure = pixels == nil ? @"the image is empty or has no memory" : drawOwnSpace(image, pixels.mutableBytes, width,
        height, stride);
    if (drawFailure == nil) {
        CGDataProviderRef provider = CGDataProviderCreateWithCFData((CFDataRef)pixels);
        converted = provider ? CGImageCreate(width, height, 8, 32, stride, CGImageGetColorSpace(image),
            (CGBitmapInfo)kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little, provider, NULL, false,
            kCGRenderingIntentDefault) : NULL;
        if (provider) CGDataProviderRelease(provider);
    }
    CGImageRelease(image);
    if (converted == NULL) {
        return captureOperationFailure(errorOut, [NSString stringWithFormat:@"the image of window %ld (%zux%zu) could not be drawn: %@",
            windowNumber, width, height, drawFailure ?: @"its pixels could not be made into an image"]);
    }
    CGImageDestinationRef destination = CGImageDestinationCreateWithURL((CFURLRef)[NSURL fileURLWithPath:decoded],
        (CFStringRef)@"public.png", 1, NULL);
    bool written = false;
    if (destination != NULL) {
        CGImageDestinationAddImage(destination, converted, NULL);
        written = CGImageDestinationFinalize(destination);
        CFRelease(destination);
    }
    CGImageRelease(converted);
    if (!written) return captureOperationFailure(errorOut, [NSString stringWithFormat:@"cannot write %@", decoded]);
    return true;
}

double sp_capture_clock(void) {
    mach_timebase_info_data_t timebase;
    mach_timebase_info(&timebase);
    return ticksToMilliseconds(mach_absolute_time(), timebase);
}
