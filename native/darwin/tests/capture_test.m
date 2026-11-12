#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import "support/run_until.h"
#import "capture.h"
#import "support/temporary_folder.h"
#import "support/capture_frame.m"

static int failures;
static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

#import "support/capture_boundary.m"

int main(void) { @autoreleasepool {
    CFTimeInterval began = CACurrentMediaTime();
    fprintf(stderr, "START: native capture acceptance\n");
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];
    const char *directory = temporaryFolder(@"soksak-capture-test-").fileSystemRepresentation;
    checkCaptureBoundary(directory);
    char *operationError = NULL;
    // Still capture: captures a window that is not activated as PNG. It is evidence; only its size is checked.
    NSString *still = [[NSString stringWithUTF8String:directory] stringByAppendingPathComponent:@"still.png"];
    char *stillError = NULL;
    check(!sp_capture_still(-1, still.UTF8String, &stillError) && stillError != NULL && strlen(stillError) > 0,
        @"a still capture of a missing window reports an error");
    free(stillError); stillError = NULL;
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(120, 120, 200, 100)
        styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    // A window during the appearing animation is composited as a small rectangle.
    window.animationBehavior = NSWindowAnimationBehaviorNone;
    window.backgroundColor = [NSColor colorWithSRGBRed:1 green:0 blue:0 alpha:1];
    // Puts the window in front without activating the application. When the occlusion state becomes visible, the window server has composited the window.
    [window orderFrontRegardless];
    // Captures after the window server has put the window on screen. A window before that has no screen rectangle. Other windows may cover it.
    BOOL (^onScreen)(void) = ^BOOL {
        NSArray *info = [(NSArray *)CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow,
            (CGWindowID)window.windowNumber) autorelease];
        return info.count == 1 && [info[0][(id)kCGWindowIsOnscreen] boolValue];
    };
    sp_run_until("the window is visible", ^BOOL { return (window.occlusionState & NSWindowOcclusionStateVisible) != 0; });
    check(onScreen(), @"the window server shows the capture window");
    bool stillWritten = sp_capture_still(window.windowNumber, still.UTF8String, &stillError);
    check(stillWritten, [NSString stringWithFormat:@"a still capture of an inactive window is written (%@)",
        [NSString stringWithUTF8String:stillError == NULL ? "" : stillError]]);
    free(stillError);
    NSBitmapImageRep *image = [NSBitmapImageRep imageRepWithData:[NSData dataWithContentsOfFile:still]];
    CGFloat scale = window.backingScaleFactor;
    check(image != nil && image.pixelsWide == (NSInteger)(200 * scale) && image.pixelsHigh == (NSInteger)(100 * scale),
        [NSString stringWithFormat:@"the still image has the window's device-pixel size (got %ldx%ld)",
            (long)image.pixelsWide, (long)image.pixelsHigh]);
    check(!NSApp.isActive, @"the still capture does not activate the application");
    // A recording of five stills, one every 1/60 s. The stop waits for the last planned still.
    NSString *root = [NSString stringWithUTF8String:directory];
    NSString *(^folder)(NSString *) = ^NSString *(NSString *name) {
        NSString *path = [root stringByAppendingPathComponent:name];
        [NSFileManager.defaultManager createDirectoryAtPath:path withIntermediateDirectories:NO attributes:nil error:NULL];
        return path;
    };
    NSString *plain = folder(@"plain");
    check(sp_capture_open(window.windowNumber, false, &operationError), @"a visible inactive window opens for recording");
    free(operationError); operationError = NULL;
    double gap = 1000.0 / 60, beforeStart = sp_capture_clock();
    int planned = 5;
    bool recordingStarted = sp_capture_start(plain.fileSystemRepresentation, gap, 0, planned, 1, &operationError);
    check(recordingStarted, [NSString stringWithFormat:@"recording starts on an unchanged inactive window (%@)",
        [NSString stringWithUTF8String:operationError == NULL ? "" : operationError]]);
    free(operationError); operationError = NULL;
    if (recordingStarted) {
        // The start answers once still 0 is written.
        check([NSFileManager.defaultManager fileExistsAtPath:[plain stringByAppendingPathComponent:@"frame-0000.bgra"]],
            @"the start answers after the first still is written");
        double after = beforeStart + (planned - 1) * gap;
        sp_run_until("the plan reaches its last still", ^BOOL { return sp_capture_clock() >= after; });
        int frames = sp_capture_stop(after, 2);
        const char *stopError = sp_capture_error();
        check(stopError != NULL && strlen(stopError) == 0,
            [NSString stringWithFormat:@"recording stops without error (%s)", stopError]);
        check(frames == planned && sp_capture_missed() == 0 && sp_capture_late() == 0,
            [NSString stringWithFormat:@"recording writes every planned still (%d written of %d, %d missed, %d late)", frames,
                planned, sp_capture_missed(), sp_capture_late()]);
        NSString *rowsText = [NSString stringWithContentsOfFile:[plain stringByAppendingPathComponent:@"stills.jsonl"]
            encoding:NSUTF8StringEncoding error:NULL];
        NSArray<NSString *> *lines = [[rowsText ?: @"" stringByTrimmingCharactersInSet:NSCharacterSet.newlineCharacterSet]
            componentsSeparatedByString:@"\n"];
        check(rowsText != nil && lines.count == (NSUInteger)planned,
            [NSString stringWithFormat:@"stills.jsonl holds one row for each planned still (%lu rows)", (unsigned long)lines.count]);
        double firstPlanned = NAN;
        for (NSUInteger index = 0; index < lines.count; index++) {
            NSDictionary *row = [NSJSONSerialization JSONObjectWithData:[lines[index] dataUsingEncoding:NSUTF8StringEncoding]
                options:0 error:NULL];
            double numerator = [row[@"machTimebaseNumerator"] doubleValue], denominator = [row[@"machTimebaseDenominator"] doubleValue];
            double (^ms)(NSString *) = ^double(NSString *key) {
                return [row[key] isKindOfClass:NSString.class]
                    ? strtoull([row[key] UTF8String], NULL, 10) * numerator / denominator / 1e6 : NAN;
            };
            double plannedTime = ms(@"planned"), requested = ms(@"requested"), completed = ms(@"completed");
            if (index == 0) firstPlanned = plannedTime;
            NSString *name = [NSString stringWithFormat:@"frame-%04lu.bgra", (unsigned long)index];
            check([row[@"index"] isEqual:@(index)] && [row[@"outcome"] isEqual:@"written"] && row[@"error"] == NSNull.null
                && [row[@"frame"] isEqual:name] && fabs([row[@"requestedGap"] doubleValue] - gap) < 1e-9
                && [row[@"windows"] isEqual:@[@(window.windowNumber)]],
                [NSString stringWithFormat:@"row %lu names its still, its frame, the requested gap and the window (%@)", (unsigned long)index, row]);
            check(fabs(plannedTime - firstPlanned - index * gap) < 0.001 && requested >= plannedTime - 0.001 && completed >= requested,
                [NSString stringWithFormat:@"still %lu is planned at the start plus %lu gaps, requested at or after that, and completed after "
                    "its request (planned %.3f, requested %.3f, completed %.3f)", (unsigned long)index, (unsigned long)index,
                    plannedTime - firstPlanned, requested - firstPlanned, completed - firstPlanned]);
            NSData *recorded = [NSData dataWithContentsOfFile:[plain stringByAppendingPathComponent:name]];
            uint32_t dimensions[3] = {0, 0, 0};
            if (recorded.length >= sizeof(dimensions)) [recorded getBytes:dimensions length:sizeof(dimensions)];
            check(dimensions[0] == (uint32_t)(200 * scale) && dimensions[1] == (uint32_t)(100 * scale),
                [NSString stringWithFormat:@"frame %lu has the window's device-pixel size (got %ux%u, expected %.0fx%.0f at scale %.1f)",
                    (unsigned long)index, dimensions[0], dimensions[1], 200 * scale, 100 * scale, scale]);
            NSData *decoded = readCaptureFrame(recorded);
            uint64_t payload = (uint64_t)dimensions[2] * dimensions[1];
            check(decoded != nil && decoded.length == kCaptureFrameHeader + payload,
                [NSString stringWithFormat:@"frame %lu holds its header and BGRA bytes (got %lu, expected %llu)", (unsigned long)index,
                    (unsigned long)decoded.length, (unsigned long long)(kCaptureFrameHeader + payload)]);
            // The header before the compressed block holds the times, so they are read from the file as it was written.
            double header[8] = {0};
            if (recorded.length >= kCaptureFrameHeader) [recorded getBytes:header range:NSMakeRange(12, sizeof header)];
            check(fabs(header[6] - requested) < 1e-6 && fabs(header[7] - completed) < 1e-6,
                [NSString stringWithFormat:@"frame %lu holds the request and completion times of its still (%.6f %.6f against %.6f %.6f)",
                    (unsigned long)index, header[6], header[7], requested, completed]);
        }
    }
    // A stop without a time requests no later still: it waits for the stills already requested, and the rest of the plan stays
    // not requested.
    NSString *early = folder(@"early");
    check(sp_capture_open(window.windowNumber, false, &operationError), @"the window opens for a recording that stops early");
    free(operationError); operationError = NULL;
    bool earlyStarted = sp_capture_start(early.fileSystemRepresentation, gap, 0, 4096, 3, &operationError);
    check(earlyStarted, [NSString stringWithFormat:@"a recording of 4096 planned stills starts (%s)", operationError ?: ""]);
    free(operationError); operationError = NULL;
    if (earlyStarted) {
        int written = sp_capture_stop(0, 4);
        NSString *rowsText = [NSString stringWithContentsOfFile:[early stringByAppendingPathComponent:@"stills.jsonl"]
            encoding:NSUTF8StringEncoding error:NULL];
        NSArray<NSString *> *lines = [[rowsText ?: @"" stringByTrimmingCharactersInSet:NSCharacterSet.newlineCharacterSet]
            componentsSeparatedByString:@"\n"];
        NSDictionary *last = lines.count ? [NSJSONSerialization JSONObjectWithData:[lines.lastObject dataUsingEncoding:NSUTF8StringEncoding]
            options:0 error:NULL] : nil;
        check(written >= 1 && sp_capture_missed() == 4096 - written && lines.count == 4096
            && [last[@"outcome"] isEqual:@"not-requested"] && last[@"requested"] == NSNull.null && last[@"frame"] == NSNull.null,
            [NSString stringWithFormat:@"an early stop keeps every planned still and counts the not requested ones as missed "
                "(%d written, %d missed, %lu rows, last %@)", written, sp_capture_missed(), (unsigned long)lines.count, last]);
    }
    check(!NSApp.isActive, @"recording an unchanged window does not activate the application");
    [window close];
    [window release];
    fprintf(stderr, "%s: native capture acceptance (%.1fms)\n", failures ? "FAIL" : "PASS",
        (CACurrentMediaTime() - began) * 1000);
    return failures ? 1 : 0;
}}
