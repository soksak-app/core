// Controls the results of the actual open, write, close, commit, and delete operations of the frame writer of a still. A failed
// file operation fails its still with the original system error of each failed operation, also in the recording error, and
// leaves the partial file only when its removal failed; a healthy still commits its frame. Every result restores the pending
// writer capacity.
#import <Cocoa/Cocoa.h>
#import "support/temporary_folder.h"
#include <stdio.h>
#include <unistd.h>
#include <errno.h>

static BOOL failOpen, failWrite, failClose, failCommit, failRemove;
static int removes;
static FILE *controlledOpen(const char *path, const char *mode) {
    if (failOpen) { errno = EACCES; return NULL; }
    return fopen(path, mode);
}
static size_t controlledWrite(const void *data, size_t size, size_t count, FILE *file) {
    if (failWrite) {
        // Leave an actual partial file to distinguish delete success from delete failure.
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
    // The earlier write error must be preserved even if a later successful call changes errno.
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
static void check(BOOL condition, NSString *message) {
    fprintf(stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}
// A 4x4 opaque sRGB image: the still that the frame writer writes.
static CGImageRef image(void) {
    CGColorSpaceRef srgb = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef context = CGBitmapContextCreate(NULL, 4, 4, 8, 16, srgb,
        (CGBitmapInfo)kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little);
    CGColorSpaceRelease(srgb);
    if (context == NULL) { check(NO, @"the cleanup fixture allocates pixels"); return NULL; }
    CGContextSetRGBFillColor(context, 0.2, 0.4, 0.6, 1);
    CGContextFillRect(context, CGRectMake(0, 0, 4, 4));
    CGImageRef made = CGBitmapContextCreateImage(context);
    CGContextRelease(context);
    return made;
}
static void hasReason(int error, NSString *label) {
    check(strstr(sp_capture_error(), strerror(error)) != NULL, label);
}
int main(void) { @autoreleasepool {
    CFTimeInterval began = CACurrentMediaTime();
    fprintf(stderr, "START: native capture file failure and cleanup\n");
    [NSApplication sharedApplication];
    NSString *directory = temporaryFolder(@"soksak-capture-cleanup-");
    NSString *pending = [directory stringByAppendingPathComponent:@"frame-0000.bgra.partial"];
    NSString *committed = [directory stringByAppendingPathComponent:@"frame-0000.bgra"];
    prepareCaptureQueues();
    mach_timebase_info_data_t timebase;
    mach_timebase_info(&timebase);
    // The still covers the rectangle of a target without a window list, at scale 1.
    SPCaptureTarget *target = [[[SPCaptureTarget alloc] init] autorelease];
    target.screen = CGRectMake(0, 0, 4, 4);
    CGImageRef frame = image();
    const char *names[] = {"open", "write", "close", "write-close", "commit", "write-remove", "close-remove", "commit-remove", "healthy"};
    for (int index = 0; frame != NULL && index < 9; index++) {
        CFTimeInterval phase = CACurrentMediaTime();
        fprintf(stderr, "START: file failure %s\n", names[index]);
        failOpen = index == 0;
        failWrite = index == 1 || index == 3 || index == 5;
        failClose = index == 2 || index == 3 || index == 6;
        failCommit = index == 4 || index == 7;
        failRemove = index == 5 || index == 6 || index == 7;
        removes = 0; clearCaptureError();
        SPCaptureRecording *recording = [[SPCaptureRecording alloc] init];
        recording.directory = directory;
        recording.windowNumber = 1;
        recording.planned = 1;
        recording.timebase = timebase;
        [recording.rows addObject:[NSMutableDictionary dictionaryWithDictionary:@{
            @"index": @0, @"outcome": @"not-requested", @"error": NSNull.null, @"frame": NSNull.null }]];
        recording.nextIndex = 1;
        if (failOpen) {
            NSError *error = nil;
            check([@"existing file" writeToFile:pending atomically:NO encoding:NSUTF8StringEncoding error:&error],
                [NSString stringWithFormat:@"the open-failure control has a pre-existing path (%@)", error]);
        }
        uint64_t requested = mach_absolute_time();
        processStill(recording, 0, target, frame, requested, mach_absolute_time());
        dispatch_sync(captureWriter, ^{});
        NSDictionary *row = recording.rows[0];
        if (index == 8) {
            check(strlen(sp_capture_error()) == 0 && recording.written == 1,
                @"a healthy write commits without an error");
            check([row[@"outcome"] isEqual:@"written"] && [row[@"frame"] isEqual:@"frame-0000.bgra"] && row[@"error"] == NSNull.null,
                [NSString stringWithFormat:@"only a healthy committed frame settles its still as written (%@)", row]);
            check([[NSFileManager defaultManager] fileExistsAtPath:committed] && removes == 0,
                @"a healthy write publishes the frame without removing it");
        } else {
            check(recording.written == 0 && [row[@"outcome"] isEqual:@"failed"] && row[@"frame"] == NSNull.null
                && [row[@"error"] isKindOfClass:NSString.class],
                [NSString stringWithFormat:@"a failed frame never counts and fails its still with its error (%@)", row]);
            check(![[NSFileManager defaultManager] fileExistsAtPath:committed], @"a failed frame publishes no frame file");
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
        check(capturePendingBytes == 0, @"every file result restores pending writer capacity");
        [recording release];
        failOpen = failWrite = failClose = failCommit = failRemove = NO;
        NSError *error = nil;
        if ([[NSFileManager defaultManager] fileExistsAtPath:pending]) check([[NSFileManager defaultManager] removeItemAtPath:pending error:&error],
            [NSString stringWithFormat:@"the retained fixture is removed (%@)", error]);
        fprintf(stderr, "END: file failure %s (%.1fms)\n", names[index], (CACurrentMediaTime() - phase) * 1000);
    }
    if (frame != NULL) CGImageRelease(frame);
    fprintf(stderr, "%s: native capture file failure and cleanup (%d failed assertions, %.1fms)\n",
        failures ? "FAIL" : "PASS", failures, (CACurrentMediaTime() - began) * 1000);
    return failures ? 1 : 0;
}}
