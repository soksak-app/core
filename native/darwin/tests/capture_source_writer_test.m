// Verifies source artifact writes can finish while the capture frame writer is held.
#import "../src/capture.m"
#include <signal.h>
#include <unistd.h>

static int failures;
static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    fflush(condition ? stdout : stderr);
    if (!condition) failures++;
}

static void expired(int signalNumber) {
    (void)signalNumber;
    const char message[] = "FAIL: capture source writer test exceeded 15000ms\n";
    write(STDERR_FILENO, message, sizeof message - 1);
    _exit(1);
}

int main(void) { @autoreleasepool {
    signal(SIGALRM, expired);
    alarm(15);
    fprintf(stderr, "START: native capture source writer\n");
    char directoryTemplate[] = "/tmp/soksak-capture-source-writer-XXXXXX";
    BOOL directoryCreated = mkdtemp(directoryTemplate) != NULL;
    check(directoryCreated, @"the source artifact directory is created");
    if (!directoryCreated) return 1;
    NSString *directoryPath = [[NSString alloc] initWithUTF8String:directoryTemplate];

    dispatch_semaphore_t writerStarted = dispatch_semaphore_create(0);
    dispatch_semaphore_t releaseWriter = dispatch_semaphore_create(0);
    dispatch_semaphore_t manifestFinished = dispatch_semaphore_create(0);
    dispatch_queue_t manifestQueue = dispatch_queue_create("capture.source-writer-test.manifest", DISPATCH_QUEUE_SERIAL);
    __block BOOL manifestWritten = NO;
    BOOL sourceWriterStarted = NO;
    BOOL retained = NO;
    BOOL completedBeforeFrameWriterRelease = NO;

    captureWriter = dispatch_queue_create("capture.source-writer-test.frame", DISPATCH_QUEUE_SERIAL);
    capturePending = dispatch_semaphore_create(kCapturePending);
    dispatch_async(captureWriter, ^{
        dispatch_semaphore_signal(writerStarted);
        dispatch_semaphore_wait(releaseWriter, DISPATCH_TIME_FOREVER);
    });

    @try {
        sourceWriterStarted = dispatch_semaphore_wait(writerStarted,
            dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC)) == 0;
        check(sourceWriterStarted, @"the production frame writer reaches the controlled hold");
        if (sourceWriterStarted) {
            BOOL began = beginCaptureSourceArtifacts(directoryPath);
            check(began, @"the production capture setup selects the source artifact writer");
            if (began) {
                const size_t width = 32, height = 32, stride = width * 4;
                NSMutableData *pixels = [NSMutableData dataWithLength:stride * height];
                memset(pixels.mutableBytes, 0x7f, pixels.length);
                sp_image_capture_identity identity = { 1, 1, 1 };
                retained = sp_image_capture_match_retain(identity, pixels.bytes, width, height, stride,
                    CGRectMake(20, 30, width, height), 1, "kCGColorSpaceSRGB");
                check(retained, @"the source snapshot is accepted while the frame writer is held");

                dispatch_async(manifestQueue, ^{
                    @autoreleasepool {
                        manifestWritten = sp_image_capture_match_write_manifest(directoryPath.fileSystemRepresentation);
                    }
                    dispatch_semaphore_signal(manifestFinished);
                });
                completedBeforeFrameWriterRelease = dispatch_semaphore_wait(manifestFinished,
                    dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) == 0;
                check(completedBeforeFrameWriterRelease,
                    @"source artifacts and their manifest finish before the held frame writer is released");
            }
        }
    } @finally {
        dispatch_semaphore_signal(releaseWriter);
        if (captureWriter != NULL) dispatch_sync(captureWriter, ^{});
        if (sourceWriterStarted && !completedBeforeFrameWriterRelease) {
            BOOL drained = dispatch_semaphore_wait(manifestFinished,
                dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) == 0;
            check(drained, @"the manifest worker drains after the frame writer is released");
        }
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
    NSError *cleanupError = nil;
    BOOL removed = [[NSFileManager defaultManager] removeItemAtPath:
        directoryPath error:&cleanupError];
    check(removed, [NSString stringWithFormat:@"the temporary source artifact directory is removed (%@)", cleanupError]);
    [directoryPath release];
    fprintf(stderr, "END: native capture source writer (%d failures)\n", failures);
    return failures == 0 ? 0 : 1;
} }
