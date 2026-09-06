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
@end

@implementation SPCapture

- (void)stream:(SCStream*)stream
    didOutputSampleBuffer:(CMSampleBufferRef)sample
                   ofType:(SCStreamOutputType)type {
    if (type != SCStreamOutputTypeScreen) return;
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
    NSLog(@"관측: 캡처가 멈췄다 — %@", error.localizedDescription);
}

@end

// What every capture goes through. Asking the system for the window list costs
// far more than a frame does, so it is asked once.
static SCContentFilter* captureFilter = nil;
static SCStreamConfiguration* captureConfig = nil;
static SCStream* captureStream = nil;
static SPCapture* captureSink = nil;

// Looks the window up and keeps what a capture needs. The lookup is answered
// later, so a capture started before that answer does nothing.
void sp_capture_open(long windowNumber) {
    [SCShareableContent getShareableContentWithCompletionHandler:
        ^(SCShareableContent* content, NSError* error) {
        if (error != nil) {
            NSLog(@"관측: 화면 기록 권한이 없다 — %@", error.localizedDescription);
            return;
        }
        for (SCWindow* window in content.windows) {
            if ((long)window.windowID != windowNumber) continue;
            captureFilter =
                [[SCContentFilter alloc] initWithDesktopIndependentWindow:window];
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
            return;
        }
        NSLog(@"관측: 창 %ld 을 찾지 못했다", windowNumber);
    }];
}

void sp_capture_start(const char* directory) {
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
        NSLog(@"관측: 캡처를 붙이지 못했다 — %@", error.localizedDescription);
        captureStream = nil;
        return;
    }
    [captureStream startCaptureWithCompletionHandler:^(NSError* failed) {
        if (failed != nil) NSLog(@"관측: 캡처를 시작하지 못했다 — %@", failed.localizedDescription);
    }];
}

int sp_capture_stop(void) {
    if (captureStream == nil) return 0;
    SCStream* stream = captureStream;
    captureStream = nil;
    int written = captureSink.written;
    [stream stopCaptureWithCompletionHandler:^(NSError* failed) {
        if (failed != nil) NSLog(@"관측: 캡처를 멈추지 못했다 — %@", failed.localizedDescription);
    }];
    return written;
}
