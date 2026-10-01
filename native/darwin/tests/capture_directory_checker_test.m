// 인수 검사가 녹화 폴더의 나열 실패와 정리 실패를 빈 폴더나 성공으로 받아들이지 않는지 검사한다. 첫 종료 뒤
// 폴더를 읽을 수 없게 하고, 녹화 종료 뒤 프레임 파일을 지울 수 없게 한다.
#import <Cocoa/Cocoa.h>
#import "capture.h"
#include <sys/stat.h>
#include <unistd.h>

static char *fixtureDirectory;
static int stopCalls, stillCalls;
static BOOL listingFault, cleanupFault;

static bool startWithDirectory(const char *directory, char **error) {
    if (fixtureDirectory == NULL) fixtureDirectory = strdup(directory);
    return sp_capture_start(directory, error);
}

static int stopWithFaults(double after) {
    int count = sp_capture_stop(after);
    stopCalls++;
    if (stopCalls == 1) {
        // 다음 줄의 폴더 나열이 실패하게 한다.
        listingFault = chmod(fixtureDirectory, 0) == 0;
        if (!listingFault) fprintf(stderr, "fixture listing fault failed: %s\n", strerror(errno));
    } else if (count > 0) {
        NSString *file = [[NSString stringWithUTF8String:fixtureDirectory] stringByAppendingPathComponent:@"frame-0001.bgra"];
        cleanupFault = chflags(file.fileSystemRepresentation, UF_IMMUTABLE) == 0;
        if (!cleanupFault) fprintf(stderr, "fixture cleanup fault failed: %s\n", strerror(errno));
    }
    return count;
}

static bool stillAfterListing(long window, const char *path, char **error) {
    // 나열 뒤 첫 정지 캡처 전에 폴더 권한을 되돌린다.
    if (stillCalls++ == 0 && chmod(fixtureDirectory, 0700) != 0) fprintf(stderr, "fixture permission restore failed: %s\n", strerror(errno));
    return sp_capture_still(window, path, error);
}

#define sp_capture_start startWithDirectory
#define sp_capture_stop stopWithFaults
#define sp_capture_still stillAfterListing
#define main captureAcceptanceMain
#import "capture_test.m"
#undef main
#undef sp_capture_still
#undef sp_capture_stop
#undef sp_capture_start

int main(void) {
    CFTimeInterval began = CACurrentMediaTime();
    fprintf(stderr, "START: native capture directory checker\n");
    int result = captureAcceptanceMain();
    BOOL rejected = listingFault && cleanupFault && result != 0 && failures == 2;
    // 고정 장치가 만든 상태를 되돌리고 폴더를 지운다.
    NSString *directory = fixtureDirectory == NULL ? nil : [NSString stringWithUTF8String:fixtureDirectory];
    NSString *file = [directory stringByAppendingPathComponent:@"frame-0001.bgra"];
    if (file != nil && chflags(file.fileSystemRepresentation, 0) != 0 && errno != ENOENT) {
        fprintf(stderr, "FAIL: fixture flag reset failed: %s\n", strerror(errno)); rejected = NO;
    }
    NSError *removeError = nil;
    if (directory != nil && [[NSFileManager defaultManager] fileExistsAtPath:directory]
        && ![[NSFileManager defaultManager] removeItemAtPath:directory error:&removeError]) {
        fprintf(stderr, "FAIL: fixture directory removal failed: %s\n", removeError.localizedDescription.UTF8String); rejected = NO;
    }
    fprintf(stderr, "%s: capture acceptance rejects listing and cleanup failures (listing=%d, cleanup=%d, result=%d, failures=%d, %.1fms)\n",
        rejected ? "PASS" : "FAIL", listingFault, cleanupFault, result, failures, (CACurrentMediaTime() - began) * 1000);
    free(fixtureDirectory);
    return rejected ? 0 : 1;
}
