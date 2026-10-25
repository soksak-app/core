// Checks that the argument check does not accept a failed listing or a failed cleanup of the recording folder as an empty folder or as success. After the first stop,
// the test makes the folder unreadable, and after a recording stops it makes the frame files undeletable.
#import <Cocoa/Cocoa.h>
#import "capture.h"
#include <sys/stat.h>
#include <unistd.h>

static char *fixtureDirectory;
static int stopCalls, stillCalls;
static BOOL listingFault, cleanupFault;

static bool startWithDirectory(const char *directory, bool frameIdentity, char **error) {
    if (fixtureDirectory == NULL) fixtureDirectory = strdup(directory);
    return sp_capture_start(directory, frameIdentity, error);
}

static int stopWithFaults(double after) {
    int count = sp_capture_stop(after);
    stopCalls++;
    if (stopCalls == 1) {
        // Makes the folder listing on the next line fail.
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
    // Restores the folder permissions after the listing and before the first still capture.
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
    // Restores the state that the fixture created and deletes the folder.
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
