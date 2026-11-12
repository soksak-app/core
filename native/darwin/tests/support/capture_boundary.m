// The boundary cases of the native capture: an invalid window, the arguments of a start, a start without a prepared target, and
// the stop and folder of a capture that never started. They need no display, so the unit test capture_boundary_test runs them,
// and the acceptance check capture_test runs them first on its folder. The including file defines check().

// A start with these arguments fails before it looks at its target, with an error that holds want.
static void expectRefusedStart(const char *directory, double gap, double seconds, int frames, const char *want, NSString *what) {
    char *operationError = NULL;
    bool started = sp_capture_start(directory, gap, seconds, frames, 0, &operationError);
    check(!started && operationError != NULL && strstr(operationError, want) != NULL,
        [NSString stringWithFormat:@"%@ is refused with \"%s\" (got \"%s\")", what, want, operationError ?: ""]);
    free(operationError);
}

static void checkCaptureBoundary(const char *directory) {
    char *operationError = NULL;
    check(!sp_capture_open(-1, false, &operationError), @"an invalid window is rejected by the native capture boundary");
    check(operationError != NULL && strlen(operationError) > 0, @"open failure is observable to the caller");
    free(operationError); operationError = NULL;
    expectRefusedStart(directory, 0.5, 0, 10, "gap must be a number of milliseconds from 1 to 1000", @"a gap below 1 ms");
    expectRefusedStart(directory, 1000.5, 0, 10, "gap must be a number of milliseconds from 1 to 1000", @"a gap above 1000 ms");
    expectRefusedStart(directory, NAN, 0, 10, "gap must be a number of milliseconds from 1 to 1000", @"a gap that is not a number");
    expectRefusedStart(directory, 16.7, 1, 10, "give seconds or frames, not both", @"a start with seconds and frames");
    expectRefusedStart(directory, 16.7, 0, 0, "a recording needs seconds or frames", @"a start with neither seconds nor frames");
    expectRefusedStart(directory, 16.7, 600.5, 0, "seconds must be above 0 and at most 600", @"a length above 600 seconds");
    expectRefusedStart(directory, 16.7, -1, 0, "seconds must be above 0 and at most 600", @"a negative length");
    expectRefusedStart(directory, 16.7, 0, -1, "frames must be an integer from 1 to 4096", @"a negative number of frames");
    expectRefusedStart(directory, 16.7, 0, 4097, "frames must be an integer from 1 to 4096", @"more than 4096 frames");
    // 100 s at 10 ms plans the stills at 0, 10, ... 99990 ms: 10000 stills.
    expectRefusedStart(directory, 10, 100, 0, "the recording plans 10000 stills, more than 4096", @"a plan of more than 4096 stills");
    check(!sp_capture_start(directory, 16.7, 0, 1, 0, &operationError), @"starting without a capture target is rejected");
    check(operationError != NULL && strlen(operationError) > 0, @"start failure is observable to the caller");
    free(operationError); operationError = NULL;
    check(sp_capture_stop(0, 0) == 0, @"stopping an invalid capture reports no written frames");
    NSError *listError = nil;
    NSArray *files = [[NSFileManager defaultManager] contentsOfDirectoryAtPath:
        [NSString stringWithUTF8String:directory] error:&listError];
    // A folder whose listing failed is not accepted as an empty folder.
    check(files != nil && files.count == 0,
        [NSString stringWithFormat:@"an invalid capture leaves no frame files (listing error %@)", listError]);
}
