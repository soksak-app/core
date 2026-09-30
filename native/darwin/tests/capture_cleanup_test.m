// 실제 쓰기·닫기·커밋·삭제 결과를 제어하여 각 원인과 남은 파일을 검사한다.
#import <Cocoa/Cocoa.h>
#include <stdio.h>
#include <unistd.h>
#include <errno.h>
#include <signal.h>

static BOOL failOpen, failWrite, failClose, failCommit, failRemove;
static int removes;
static FILE *controlledOpen(const char *path, const char *mode) {
    if (failOpen) { errno = EACCES; return NULL; }
    return fopen(path, mode);
}
static size_t controlledWrite(const void *data, size_t size, size_t count, FILE *file) {
    if (failWrite) {
        // 실제 부분 파일을 남겨 삭제 성공·실패를 구분한다.
        if (fwrite(data, 1, 1, file) != 1) {
            fprintf(stderr, "FAIL: the partial-file fixture cannot write its byte: %s\n", strerror(errno));
            abort();
        }
        errno = ENOSPC; return 0;
    }
    return fwrite(data, size, count, file);
}
static int controlledClose(FILE *file) {
    int closed = fclose(file);
    if (closed != 0) return closed;
    if (failClose) { errno = EIO; return EOF; }
    // 성공한 다음 호출이 errno를 바꿔도 이전 쓰기 오류는 보존해야 한다.
    errno = EBADF; return 0;
}
static int controlledCommit(const char *from, const char *to) {
    if (failCommit) { errno = EEXIST; return -1; }
    return rename(from, to);
}
static int controlledRemove(const char *path) {
    removes++;
    if (failRemove) { errno = EPERM; return -1; }
    return unlink(path);
}
#define fopen controlledOpen
#define fwrite controlledWrite
#define fclose controlledClose
#define rename controlledCommit
#define unlink controlledRemove
#import "../src/capture.m"
#undef fopen
#undef fwrite
#undef fclose
#undef rename
#undef unlink

static int failures;
static void expired(int signalNumber) {
    const char message[] = "FAIL: capture cleanup test exceeded 5000ms\n";
    write(STDERR_FILENO, message, sizeof message - 1);
    _exit(1);
}
static void check(BOOL condition, NSString *message) {
    fprintf(stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}
static CMSampleBufferRef sample(void) {
    CVPixelBufferRef pixels = NULL;
    if (CVPixelBufferCreate(NULL, 4, 4, kCVPixelFormatType_32BGRA, NULL, &pixels) != kCVReturnSuccess) {
        check(NO, @"the cleanup fixture allocates pixels"); return NULL;
    }
    CVPixelBufferLockBaseAddress(pixels, 0);
    memset(CVPixelBufferGetBaseAddress(pixels), 42, CVPixelBufferGetBytesPerRow(pixels) * 4);
    CVPixelBufferUnlockBaseAddress(pixels, 0);
    CMVideoFormatDescriptionRef format = NULL;
    OSStatus formatted = CMVideoFormatDescriptionCreateForImageBuffer(NULL, pixels, &format);
    CMSampleBufferRef frame = NULL;
    CMSampleTimingInfo timing = {kCMTimeInvalid, kCMTimeZero, kCMTimeInvalid};
    if (formatted == noErr) check(CMSampleBufferCreateReadyWithImageBuffer(NULL, pixels, format, &timing, &frame) == noErr,
        @"the cleanup fixture creates a complete sample");
    else check(NO, @"the cleanup fixture creates its format");
    if (frame != NULL) {
        CFMutableDictionaryRef attached = (CFMutableDictionaryRef)CFArrayGetValueAtIndex(
            CMSampleBufferGetSampleAttachmentsArray(frame, true), 0);
        NSDictionary *rect = [(NSDictionary *)CGRectCreateDictionaryRepresentation(CGRectMake(0, 0, 4, 4)) autorelease];
        NSDictionary *metadata = @{SCStreamFrameInfoStatus: @(SCFrameStatusComplete),
            SCStreamFrameInfoDisplayTime: @(mach_absolute_time()), SCStreamFrameInfoContentRect: rect,
            SCStreamFrameInfoContentScale: @1, SCStreamFrameInfoScaleFactor: @1};
        for (NSString *key in metadata) CFDictionarySetValue(attached, key, metadata[key]);
    }
    if (format != NULL) CFRelease(format);
    CVPixelBufferRelease(pixels); return frame;
}
static void hasReason(int error, NSString *label) {
    check(strstr(sp_capture_error(), strerror(error)) != NULL, label);
}
int main(void) { @autoreleasepool {
    signal(SIGALRM, expired); alarm(5);
    CFTimeInterval began = CACurrentMediaTime();
    fprintf(stderr, "START: native capture file failure and cleanup\n");
    [NSApplication sharedApplication];
    char path[] = "/tmp/soksak-capture-cleanup-XXXXXX";
    if (mkdtemp(path) == NULL) { check(NO, @"the cleanup directory is created"); return 1; }
    NSString *directory = [NSString stringWithUTF8String:path];
    NSString *pending = [directory stringByAppendingPathComponent:@"frame-0001.bgra.partial"];
    NSString *committed = [directory stringByAppendingPathComponent:@"frame-0001.bgra"];
    captureWriter = dispatch_queue_create("capture.test.cleanup", DISPATCH_QUEUE_SERIAL);
    capturePending = dispatch_semaphore_create(1);
    captureFirstFrame = dispatch_semaphore_create(0);
    CMSampleBufferRef frame = sample();
    const char *names[] = {"open", "write", "close", "write-close", "commit", "write-remove", "close-remove", "commit-remove", "healthy"};
    for (int index = 0; frame != NULL && index < 9; index++) {
        CFTimeInterval phase = CACurrentMediaTime();
        fprintf(stderr, "START: file failure %s\n", names[index]);
        failOpen = index == 0;
        failWrite = index == 1 || index == 3 || index == 5;
        failClose = index == 2 || index == 3 || index == 6;
        failCommit = index == 4 || index == 7;
        failRemove = index == 5 || index == 6 || index == 7;
        removes = 0; clearCaptureError(); captureBefore = 0; captureStartedAt = 0;
        [captureSink release]; captureSink = [SPCapture new]; captureSink.directory = directory;
        static int statuses[6]; captureSink.statuses = statuses;
        if (failOpen) {
            NSError *error = nil;
            check([@"existing file" writeToFile:pending atomically:NO encoding:NSUTF8StringEncoding error:&error],
                [NSString stringWithFormat:@"the open-failure control has a pre-existing path (%@)", error]);
        }
        [captureSink write:frame]; dispatch_sync(captureWriter, ^{});
        if (index == 8) {
            check(strlen(sp_capture_error()) == 0 && captureSink.written == 1,
                @"a healthy write commits without an error");
            check(dispatch_semaphore_wait(captureFirstFrame, DISPATCH_TIME_NOW) == 0,
                @"only a healthy committed frame signals readiness");
            check([[NSFileManager defaultManager] fileExistsAtPath:committed] && removes == 0,
                @"a healthy write publishes the frame without removing it");
        } else {
            check(captureSink.written == 0 && dispatch_semaphore_wait(captureFirstFrame, DISPATCH_TIME_NOW) != 0,
                @"a failed frame never counts or signals first-frame readiness");
            if (failOpen) {
                hasReason(EACCES, @"open failure preserves its original system error");
                check(removes == 0 && [[NSFileManager defaultManager] fileExistsAtPath:pending],
                    @"an open failure cannot remove the pre-existing path");
            }
            if (failWrite) hasReason(ENOSPC, @"write failure survives the subsequent close result");
            if (failClose) hasReason(EIO, @"close failure has its own reported reason");
            if (failCommit) hasReason(EEXIST, @"commit failure preserves its original system error");
            if (failRemove) {
                hasReason(EPERM, @"partial-file removal failure has its own reported reason");
                check(strstr(sp_capture_error(), pending.UTF8String) != NULL,
                    @"the retained partial-file error identifies its actual path");
                check(removes == 1 && [[NSFileManager defaultManager] fileExistsAtPath:pending],
                    @"failed removal leaves the actual partial file observable");
            } else if (!failOpen) check(removes == 1 && ![[NSFileManager defaultManager] fileExistsAtPath:pending],
                @"successful cleanup removes the failed partial file");
        }
        check(dispatch_semaphore_wait(capturePending, DISPATCH_TIME_NOW) == 0,
            @"every file result restores pending writer capacity");
        dispatch_semaphore_signal(capturePending);
        failOpen = failWrite = failClose = failCommit = failRemove = NO;
        NSError *error = nil;
        if ([[NSFileManager defaultManager] fileExistsAtPath:pending]) check([[NSFileManager defaultManager] removeItemAtPath:pending error:&error],
            [NSString stringWithFormat:@"the retained fixture is removed (%@)", error]);
        fprintf(stderr, "END: file failure %s (%.1fms)\n", names[index], (CACurrentMediaTime() - phase) * 1000);
    }
    NSError *error = nil;
    check([[NSFileManager defaultManager] removeItemAtPath:directory error:&error],
        [NSString stringWithFormat:@"all cleanup fixture files are removed (%@)", error]);
    if (frame != NULL) CFRelease(frame);
    fprintf(stderr, "%s: native capture file failure and cleanup (%d failed assertions, %.1fms)\n",
        failures ? "FAIL" : "PASS", failures, (CACurrentMediaTime() - began) * 1000);
    alarm(0);
    return failures ? 1 : 0;
}}
