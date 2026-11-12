// Checks that the argument check does not accept a failed listing of the recording folder as an empty folder or as success. After
// the first stop, the test makes the folder unreadable. The removal of the folder is not a step of the acceptance: the folder is
// a temporary folder of the process, and a removal that fails is judged by temporary_folder_test.
#import <Cocoa/Cocoa.h>
#import "capture.h"
#include <sys/stat.h>
#include <unistd.h>

static char *fixtureDirectory;
static int stopCalls, stillCalls;
static BOOL listingFault;

static bool startWithDirectory(const char *directory, double gap, double seconds, int frames, bool frameIdentity,
    uint64_t token, char **error) {
    if (fixtureDirectory == NULL) fixtureDirectory = strdup(directory);
    return sp_capture_start(directory, gap, seconds, frames, frameIdentity, token, error);
}

static int stopWithFaults(double after, uint64_t token) {
    int count = sp_capture_stop(after, token);
    stopCalls++;
    if (stopCalls == 1) {
        // Makes the folder listing on the next line fail.
        listingFault = chmod(fixtureDirectory, 0) == 0;
        if (!listingFault) fprintf(stderr, "fixture listing fault failed: %s\n", strerror(errno));
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
    // The listing fault is the only failure of the acceptance.
    BOOL rejected = listingFault && result != 0 && failures == 1;
    fprintf(stderr, "%s: capture acceptance rejects a listing failure (listing=%d, result=%d, failures=%d, %.1fms)\n",
        rejected ? "PASS" : "FAIL", listingFault, result, failures, (CACurrentMediaTime() - began) * 1000);
    free(fixtureDirectory);
    return rejected ? 0 : 1;
}
