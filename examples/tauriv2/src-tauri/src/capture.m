// A window's own composite, read from inside the application.
//
// The window server draws the page, the surfaces and the modal together, and the
// result of that is what has to be looked at. It has to be read as a stream: a
// screenshot asked for one at a time is answered with a composite made for that
// request, so a state that lasts one frame between a view being resized and its
// page being painted is never in it. A stream delivers the frames the compositor
// actually showed.
//
// Written in Objective-C because the frames arrive as a message, which needs an
// object to arrive at. Rust calls the three functions at the bottom.

#import <Cocoa/Cocoa.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>

@interface SPCapture : NSObject <SCStreamOutput, SCStreamDelegate>
@property (nonatomic, copy) NSString* directory;
@property (nonatomic) int written;
@property (nonatomic) int idle;
@end

// The status attached to a frame. A frame with no status is a complete one.
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
    // A window that is not redrawn still delivers frames at the configured rate,
    // each marked idle and carrying no image. Counting them tells the reason for
    // a recording of no frames.
    if (frameStatus(sample) != SCFrameStatusComplete) {
        self.idle++;
        return;
    }
    CVImageBufferRef buffer = CMSampleBufferGetImageBuffer(sample);
    if (buffer == NULL) return;
    // The frame is written as it arrived. Encoding it here costs frames, and a
    // dropped frame is the one worth looking at.
    CVPixelBufferLockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly);
    size_t width = CVPixelBufferGetWidth(buffer);
    size_t height = CVPixelBufferGetHeight(buffer);
    size_t stride = CVPixelBufferGetBytesPerRow(buffer);
    const uint8_t* base = (const uint8_t*)CVPixelBufferGetBaseAddress(buffer);
    if (base != NULL) {
        NSString* path = [self.directory stringByAppendingPathComponent:
            [NSString stringWithFormat:@"frame-%04d.bgra", self.written + 1]];
        FILE* file = fopen(path.UTF8String, "wb");
        if (file != NULL) {
            uint32_t head[3] = { (uint32_t)width, (uint32_t)height, (uint32_t)stride };
            fwrite(head, sizeof(head), 1, file);
            fwrite(base, stride, height, file);
            // Counted once the file holds the frame, so the count and the
            // directory cannot disagree.
            if (fclose(file) == 0) self.written++;
        }
    }
    CVPixelBufferUnlockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly);
}

- (void)stream:(SCStream*)stream didStopWithError:(NSError*)error {
    fprintf(stderr, "observe: capture stopped, %s\n", error.localizedDescription.UTF8String);
}

@end

// What every capture goes through. Asking the system for the window list costs
// far more than a frame does, so it is asked once.
static SCContentFilter* captureFilter = nil;
static SCStreamConfiguration* captureConfig = nil;
static SCStream* captureStream = nil;
static SPCapture* captureSink = nil;

// Looks the window up and keeps what a capture needs.
//
// The lookup is answered later, so the answer is waited for. Without the wait a
// capture started in the meantime does nothing and leaves no reason why.
void sp_capture_open(long windowNumber) {
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
            // In points. In pixels a frame is four times the size, and writing it
            // takes long enough to lose frames.
            config.width = (size_t)window.frame.size.width;
            config.height = (size_t)window.frame.size.height;
            config.pixelFormat = kCVPixelFormatType_32BGRA;
            config.showsCursor = NO;
            config.captureResolution = SCCaptureResolutionBest;
            config.minimumFrameInterval = CMTimeMake(1, 120);
            config.queueDepth = 8;
            captureConfig = config;
            // The filter is assigned last. sp_capture_start reads it to decide
            // whether a capture can begin, so assigning it first would let a
            // stream be built with no configuration.
            captureFilter =
                [[SCContentFilter alloc] initWithDesktopIndependentWindow:window];
            dispatch_semaphore_signal(answered);
            return;
        }
        fprintf(stderr, "observe: window %ld not found\n", windowNumber);
        dispatch_semaphore_signal(answered);
    }];
    dispatch_semaphore_wait(answered, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC));
}

void sp_capture_start(const char* directory) {
    if (captureFilter == nil) {
        fprintf(stderr, "observe: capture has no window to record\n");
        return;
    }
    if (captureStream != nil) return;
    // The sink is made once. A new one per recording restarts the frame numbers
    // at one and overwrites the files an earlier recording wrote.
    if (captureSink == nil) captureSink = [[SPCapture alloc] init];
    captureSink.directory = [NSString stringWithUTF8String:directory];
    captureStream = [[SCStream alloc] initWithFilter:captureFilter
                                       configuration:captureConfig
                                            delegate:captureSink];
    NSError* error = nil;
    dispatch_queue_t handing = dispatch_queue_create("sp.capture", NULL);
    [captureStream addStreamOutput:captureSink
                              type:SCStreamOutputTypeScreen
                sampleHandlerQueue:handing
                             error:&error];
    if (error != nil) {
        fprintf(stderr, "observe: capture output not added, %s\n",
            error.localizedDescription.UTF8String);
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

// Stops the stream and reports how many frames reached disk.
//
// The stop is answered on another queue, and frames already handed over are
// written while it runs. Reading the count before that would under-report, and
// the process exiting then would leave the last file short.
int sp_capture_stop(void) {
    if (captureStream == nil) return 0;
    SCStream* stream = captureStream;
    captureStream = nil;
    dispatch_semaphore_t stopped = dispatch_semaphore_create(0);
    [stream stopCaptureWithCompletionHandler:^(NSError* failed) {
        if (failed != nil) {
            fprintf(stderr, "observe: capture not stopped, %s\n",
                failed.localizedDescription.UTF8String);
        }
        dispatch_semaphore_signal(stopped);
    }];
    dispatch_semaphore_wait(stopped, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC));
    if (captureSink.written == 0 && captureSink.idle > 0) {
        fprintf(stderr, "observe: the window was not redrawn during %d frames; "
            "the display is off or the window is not on screen\n", captureSink.idle);
    }
    return captureSink.written;
}
