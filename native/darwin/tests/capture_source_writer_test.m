// Source artifact writes and their manifest finish while the frame writer of the still recording is held: the two writers are
// separate serial queues, so a slow frame write never holds the source manifest.
#import "../src/capture.m"
#import "support/temporary_folder.h"

static int failures;
static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    fflush(condition ? stdout : stderr);
    if (!condition) failures++;
}

int main(void) { @autoreleasepool {
    fprintf(stderr, "START: native capture source writer\n");
    NSString *directoryPath = [temporaryFolder(@"soksak-capture-source-writer-") retain];

    dispatch_semaphore_t writerStarted = dispatch_semaphore_create(0);
    dispatch_semaphore_t releaseWriter = dispatch_semaphore_create(0);
    dispatch_semaphore_t manifestFinished = dispatch_semaphore_create(0);
    dispatch_queue_t manifestQueue = dispatch_queue_create("capture.source-writer-test.manifest", DISPATCH_QUEUE_SERIAL);
    __block BOOL manifestWritten = NO;
    BOOL retained = NO;

    captureWriter = dispatch_queue_create("capture.source-writer-test.frame", DISPATCH_QUEUE_SERIAL);
    capturePending = dispatch_semaphore_create(kCapturePending);
    dispatch_async(captureWriter, ^{
        dispatch_semaphore_signal(writerStarted);
        dispatch_semaphore_wait(releaseWriter, DISPATCH_TIME_FOREVER);
    });

    @try {
        // The production frame writer reaches the controlled hold.
        dispatch_semaphore_wait(writerStarted, DISPATCH_TIME_FOREVER);
        BOOL began = beginCaptureSourceArtifacts(directoryPath, true);
        check(began, @"the production capture setup selects the source artifact writer");
        if (began) {
            const size_t width = 32, height = 32, stride = width * 4;
            NSMutableData *pixels = [NSMutableData dataWithLength:stride * height];
            memset(pixels.mutableBytes, 0x7f, pixels.length);
            sp_image_capture_identity identity = { 1, 1, 1 };
            retained = sp_image_capture_match_retain(identity, pixels.bytes, width, height, stride,
                CGRectMake(20, 30, width, height), 1, "kCGColorSpaceSRGB");
            check(retained, @"the source snapshot is accepted while the frame writer is held");

            // Queued behind the hold, so it runs only once the frame writer is released.
            __block BOOL frameWriterRan = NO;
            dispatch_async(captureWriter, ^{ frameWriterRan = YES; });
            dispatch_async(manifestQueue, ^{
                @autoreleasepool {
                    manifestWritten = sp_image_capture_match_write_manifest(directoryPath.fileSystemRepresentation);
                }
                dispatch_semaphore_signal(manifestFinished);
            });
            // Source artifacts and their manifest finish before the held frame writer is released. A manifest that waited
            // for the held frame writer would not finish: the runner ends that run, and this record names the wait.
            fprintf(stderr, "waiting: the manifest finishes while the frame writer is held\n");
            dispatch_semaphore_wait(manifestFinished, DISPATCH_TIME_FOREVER);
            fprintf(stderr, "reached: the manifest finishes while the frame writer is held\n");
            check(!frameWriterRan, @"source artifacts and their manifest finish before the held frame writer is released");
        }
    } @finally {
        dispatch_semaphore_signal(releaseWriter);
        if (captureWriter != NULL) dispatch_sync(captureWriter, ^{});
        endCaptureSourceArtifacts();
        check(captureSourceWriter == NULL, @"source writer ownership is released after matching ends");
        if (capturePending != NULL) { dispatch_release(capturePending); capturePending = NULL; }
        if (captureWriter != NULL) { dispatch_release(captureWriter); captureWriter = NULL; }
    }

    check(manifestWritten, @"the source artifact manifest is written");
    NSString *manifestPath = [directoryPath stringByAppendingPathComponent:@"sources/manifest.json"];
    NSData *manifestData = [NSData dataWithContentsOfFile:manifestPath];
    NSDictionary *manifest = manifestData
        ? [NSJSONSerialization JSONObjectWithData:manifestData options:0 error:NULL] : nil;
    check([manifest[@"artifacts"] count] == 1 && [manifest[@"droppedSources"] unsignedIntegerValue] == 0,
        @"the manifest records the accepted source with no retention drop");

    dispatch_release(manifestQueue);
    dispatch_release(writerStarted);
    dispatch_release(releaseWriter);
    dispatch_release(manifestFinished);
    [directoryPath release];
    fprintf(stderr, "END: native capture source writer (%d failures)\n", failures);
    return failures == 0 ? 0 : 1;
} }
