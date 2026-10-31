// The boundary cases of the native capture: an invalid window, a start without a prepared target, and the wait, stop and
// folder of a capture that never started. They need no display, so the unit test capture_boundary_test runs them, and the
// acceptance check capture_test runs them first on its folder. The including file defines check().

static void checkCaptureBoundary(const char *directory) {
    char *operationError = NULL;
    check(!sp_capture_open(-1, false, &operationError), @"an invalid window is rejected by the native capture boundary");
    check(operationError != NULL && strlen(operationError) > 0, @"open failure is observable to the caller");
    free(operationError); operationError = NULL;
    check(!sp_capture_start(directory, true, &operationError), @"identity capture without a prepared target is rejected");
    check(operationError != NULL && strstr(operationError, "capture has no prepared window") != NULL,
        @"identity start validates its capture target before creating a session");
    free(operationError); operationError = NULL;
    check(!sp_capture_start(directory, false, &operationError), @"starting without a capture target is rejected");
    check(operationError != NULL && strlen(operationError) > 0, @"start failure is observable to the caller");
    free(operationError); operationError = NULL;
    check(sp_capture_wait() == 0, @"an invalid window cannot produce a capture frame");
    check(sp_capture_stop(0) == 0, @"stopping an invalid capture reports no written frames");
    NSError *listError = nil;
    NSArray *files = [[NSFileManager defaultManager] contentsOfDirectoryAtPath:
        [NSString stringWithUTF8String:directory] error:&listError];
    // A folder whose listing failed is not accepted as an empty folder.
    check(files != nil && files.count == 0,
        [NSString stringWithFormat:@"an invalid capture leaves no frame files (listing error %@)", listError]);
}
