#import "../src/image_capture_match.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int failures;
static void check(BOOL ok, NSString *label) {
    fprintf(stderr, "%s: %s\n", ok ? "PASS" : "FAIL", label.UTF8String);
    if (!ok) failures++;
}

static void frameIdentitySessionChecks(void) {
    const uint8_t regionA[16] = { 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 };
    const uint8_t regionB[16] = { 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 };
    const sp_image_capture_identity identity = { 3, 5, 7 };
    char *error = NULL;
    check(sp_image_capture_match_identity_session_begin(&error) && error == NULL,
        @"an active diagnostic capture starts an identity session");
    free(error); error = NULL;

    NSString *nonceA = nil, *nonceARepeat = nil, *nonceB = nil;
    check(sp_image_capture_match_identity_region_nonce(regionA, &nonceA, &error) && error == NULL,
        @"an issued region token derives its capture-scoped nonce");
    free(error); error = NULL;
    check(sp_image_capture_match_identity_region_nonce(regionA, &nonceARepeat, &error) && error == NULL
        && [nonceA isEqualToString:nonceARepeat], @"the same region token derives a stable nonce within a session");
    free(error); error = NULL;
    check(sp_image_capture_match_identity_region_nonce(regionB, &nonceB, &error) && error == NULL
        && ![nonceA isEqualToString:nonceB], @"distinct regions receive distinct identity nonces");
    free(error); error = NULL;

    NSString *payloadA = nil, *payloadB = nil;
    check(sp_image_capture_match_identity_issue(regionA, identity, &payloadA, &error) && error == NULL,
        @"the matcher issues an identity payload for a region source");
    free(error); error = NULL;
    check(sp_image_capture_match_identity_issue(regionB, identity, &payloadB, &error) && error == NULL
        && ![payloadA isEqualToString:payloadB], @"the same source tuple in another region has a different payload");
    free(error); error = NULL;
    NSString *payloadARepeat = nil;
    check(sp_image_capture_match_identity_issue(regionA, identity, &payloadARepeat, &error) && error == NULL
        && [payloadA isEqualToString:payloadARepeat], @"reissuing one region source returns the same canonical payload");
    free(error); error = NULL;
    [payloadARepeat release];
    NSSet<NSString *> *issuedA = nil, *issuedB = nil;
    check(sp_image_capture_match_identity_copy_payloads(regionA, &issuedA, &error) && error == NULL
        && [issuedA isEqualToSet:[NSSet setWithObject:payloadA]],
        @"decoder allowlisting contains exactly the issued payload for its region");
    free(error); error = NULL;
    check(sp_image_capture_match_identity_copy_payloads(regionB, &issuedB, &error) && error == NULL
        && [issuedB isEqualToSet:[NSSet setWithObject:payloadB]],
        @"decoder allowlisting is isolated from another region");
    free(error); error = NULL;

    check(sp_image_capture_match_identity_evict(regionA, identity, &error) && error == NULL,
        @"evicting an issued source is an explicit successful operation");
    free(error); error = NULL;
    [issuedA release]; issuedA = nil;
    check(sp_image_capture_match_identity_copy_payloads(regionA, &issuedA, &error) && error == NULL
        && issuedA.count == 0, @"evicting a retained source removes its payload from the decoder allowlist");
    free(error); error = NULL;
    [issuedB release]; issuedB = nil;
    check(sp_image_capture_match_identity_copy_payloads(regionB, &issuedB, &error) && error == NULL
        && [issuedB containsObject:payloadB], @"eviction in one region preserves another region's issued payload");
    free(error); error = NULL;

    bool capacityHeld = true;
    for (int sequence = 100; sequence < 611; sequence++) {
        sp_image_capture_identity next = { 3, 5, sequence };
        NSString *nextPayload = nil;
        if (!sp_image_capture_match_identity_issue(regionA, next, &nextPayload, &error) || error != NULL) {
            capacityHeld = false;
            [nextPayload release]; free(error); error = NULL;
            break;
        }
        [nextPayload release];
    }
    check(capacityHeld, @"the issued identity set accepts entries up to the shared 512-identity bound");
    sp_image_capture_identity overCapacity = { 3, 5, 700 };
    NSString *overCapacityPayload = nil;
    check(!sp_image_capture_match_identity_issue(regionA, overCapacity, &overCapacityPayload, &error)
        && overCapacityPayload == nil && error != NULL && strstr(error, "limit") != NULL,
        @"issuance above the 512-identity bound fails explicitly");
    [overCapacityPayload release]; free(error); error = NULL;
    sp_image_capture_identity releasedCapacity = { 3, 5, 100 };
    check(sp_image_capture_match_identity_evict(regionA, releasedCapacity, &error) && error == NULL,
        @"evicting one bounded identity releases its issued slot");
    free(error); error = NULL;
    check(sp_image_capture_match_identity_issue(regionA, overCapacity, &overCapacityPayload, &error) && error == NULL,
        @"issuance resumes after an identity slot is evicted");
    [overCapacityPayload release]; free(error); error = NULL;

    sp_image_capture_match_identity_session_end();
    [issuedA release]; issuedA = nil;
    [issuedB release]; issuedB = nil;
    [nonceARepeat release]; [nonceB release];
    [payloadA release]; [payloadB release];
    error = NULL;
    check(!sp_image_capture_match_identity_issue(regionA, identity, &payloadA, &error)
        && payloadA == nil && error != NULL, @"an ended session refuses new identity issuance explicitly");
    free(error);
    error = NULL;
    check(sp_image_capture_match_identity_session_begin(&error) && error == NULL,
        @"a stopped identity session can be restarted for a new capture");
    free(error); error = NULL;
    NSString *restartNonce = nil;
    check(sp_image_capture_match_identity_region_nonce(regionA, &restartNonce, &error) && error == NULL
        && ![restartNonce isEqualToString:nonceA], @"a restarted capture receives a fresh region nonce");
    free(error); error = NULL;
    [issuedA release]; issuedA = nil;
    check(sp_image_capture_match_identity_copy_payloads(regionA, &issuedA, &error) && error == NULL
        && issuedA.count == 0, @"a restarted capture has no payloads issued by its predecessor");
    free(error); error = NULL;
    [issuedA release]; [restartNonce release]; [nonceA release];
    sp_image_capture_match_identity_session_end();
}

int main(void) { @autoreleasepool {
    fprintf(stderr, "START: native image capture identity matching\n");
    const uint8_t source[16] = { 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16 };
    uint8_t frame[4 * 4 * 4] = { 0 };
    memcpy(frame, source, 8);
    memcpy(frame + 4 * 4, source + 8, 8);
    CGRect bounds = CGRectMake(10, 20, 2, 2);
    sp_image_capture_identity first = { 7, 11, 13 };
    sp_image_capture_match_begin(NULL, NULL);
    check(sp_image_capture_match_retain(first, source, 2, 2, 8, bounds, 1, "DeviceRGB"),
        @"diagnostic matching retains the exact source raster");
    check(sp_image_capture_match_retain(first, source, 2, 2, 8, bounds, 1, "DeviceRGB"),
        @"repeating an identical source identity and raster is idempotent");

    sp_image_capture_match_result result = sp_image_capture_match_sample(frame, 4, 4, 16,
        CGRectMake(0, 0, 4, 4), CGRectMake(10, 20, 4, 4), 1, 1, "DeviceRGB", 987654321);
    check(result.state == SP_IMAGE_CAPTURE_MATCHED && result.candidate_count == 1
        && result.candidates[0].generation == first.generation && result.candidates[0].raster == first.raster
        && result.candidates[0].sequence == first.sequence && result.display_time == 987654321,
        @"the geometrically mapped ScreenCaptureKit crop matches its source identity and preserves displayTime");
    sp_image_capture_match_result_dispose(&result);

    sp_image_capture_match_begin(NULL, NULL);
    check(sp_image_capture_match_retain(first, source, 2, 2, 8, bounds, 1, "DeviceRGB"),
        @"the conflicting-identity fixture retains its first raster");
    uint8_t conflictingSource[sizeof source];
    memcpy(conflictingSource, source, sizeof source);
    conflictingSource[0] ^= 1;
    check(!sp_image_capture_match_retain(first, conflictingSource, 2, 2, 8, bounds, 1, "DeviceRGB"),
        @"the same source identity cannot be reused for different pixels");
    result = sp_image_capture_match_sample(frame, 4, 4, 16,
        CGRectMake(0, 0, 4, 4), CGRectMake(10, 20, 4, 4), 1, 1, "DeviceRGB", 987654330);
    check(result.state == SP_IMAGE_CAPTURE_UNKNOWN_RETENTION && result.dropped_snapshots == 1,
        @"a conflicting source identity is reported as dropped and prevents a confident match");
    sp_image_capture_match_result_dispose(&result);
    sp_image_capture_match_end();

    sp_image_capture_match_begin(NULL, NULL);
    check(sp_image_capture_match_retain(first, source, 2, 2, 8, bounds, 1, "DeviceRGB"),
        @"the ambiguity fixture retains its first source identity");
    sp_image_capture_identity second = { 7, 11, 14 };
    check(sp_image_capture_match_retain(second, source, 2, 2, 8, bounds, 1, "DeviceRGB"),
        @"a repeated source raster is retained as another candidate");
    result = sp_image_capture_match_sample(frame, 4, 4, 16,
        CGRectMake(0, 0, 4, 4), CGRectMake(10, 20, 4, 4), 1, 1, "DeviceRGB", 987654322);
    check(result.state == SP_IMAGE_CAPTURE_AMBIGUOUS && result.candidate_count == 2,
        @"identical pixels preserve both source identities as ambiguous candidates");
    sp_image_capture_match_result_dispose(&result);
    sp_image_capture_match_end();
    sp_image_capture_match_begin(NULL, NULL);
    check(!sp_image_capture_match_retain(first, source, SIZE_MAX / 4 + 1, 1, 4,
        bounds, 1, "DeviceRGB"), @"a source width whose BGRA byte size overflows is rejected");
    sp_image_capture_match_end();
    sp_image_capture_match_begin(NULL, NULL);
    check(sp_image_capture_match_retain(first, source, 2, 2, 8, bounds, 1, "DeviceRGB"),
        @"the next matching fixture starts with a fresh source history");

    result = sp_image_capture_match_sample(frame, 4, 4, 16,
        CGRectMake(0, 0, 4, 4), CGRectMake(10, 20, 4, 4), 1, 2, "DeviceRGB", 987654323);
    check(result.state == SP_IMAGE_CAPTURE_UNKNOWN_SCALE && result.candidate_count == 0,
        @"a capture scale mismatch is an explicit unknown state");
    sp_image_capture_match_result_dispose(&result);

    result = sp_image_capture_match_sample(frame, 4, 4, 16,
        CGRectMake(0, 0, 4, 4), CGRectMake(10, 20, 4, 4), 1, 1, "DisplayP3", 987654324);
    check(result.state == SP_IMAGE_CAPTURE_UNKNOWN_COLOR && result.candidate_count == 0,
        @"a color representation mismatch is an explicit unknown state");
    sp_image_capture_match_result_dispose(&result);

    uint8_t different[sizeof(frame)];
    memcpy(different, frame, sizeof(frame));
    different[0] ^= 1;
    result = sp_image_capture_match_sample(different, 4, 4, 16,
        CGRectMake(0, 0, 4, 4), CGRectMake(10, 20, 4, 4), 1, 1, "DeviceRGB", 987654325);
    check(result.state == SP_IMAGE_CAPTURE_UNMATCHED && result.candidate_count == 0,
        @"a pixel difference is not accepted as a source identity match");
    check(result.has_pixel_difference && result.different_pixels == 1
        && result.first_difference_x == 0 && result.first_difference_y == 0
        && memcmp(result.expected_bgra, source, 4) == 0
        && memcmp(result.actual_bgra, different, 4) == 0,
        @"an unmatched crop reports the differing-pixel count, first crop coordinate, and expected and actual BGRA values");
    sp_image_capture_match_result_dispose(&result);

    result = sp_image_capture_match_sample(frame, 4, 4, 16,
        CGRectMake(0, 0, 4, 4), CGRectMake(50, 50, 4, 4), 1, 1, "DeviceRGB", 987654326);
    check(result.state == SP_IMAGE_CAPTURE_UNKNOWN_GEOMETRY && result.candidate_count == 0,
        @"a source bound outside the captured screen rectangle is explicit unknown geometry");
    sp_image_capture_match_result_dispose(&result);
    result = sp_image_capture_match_sample(frame, SIZE_MAX / 4 + 1, 4, SIZE_MAX,
        CGRectMake(0, 0, 4, 4), CGRectMake(10, 20, 4, 4), 1, 1, "DeviceRGB", 987654329);
    check(result.state == SP_IMAGE_CAPTURE_UNKNOWN_GEOMETRY && result.candidate_count == 0,
        @"a capture width whose BGRA byte size overflows is rejected as unknown geometry");
    sp_image_capture_match_result_dispose(&result);
    sp_image_capture_match_end();

    uint8_t topLeftFrame[sizeof(frame)] = { 0 };
    memcpy(topLeftFrame, source, 8);
    memcpy(topLeftFrame + 4 * 4, source + 8, 8);
    sp_image_capture_match_begin(NULL, NULL);
    check(sp_image_capture_match_retain(first, source, 2, 2, 8, bounds, 1, "DeviceRGB"),
        @"the top-left coordinate fixture retains its source raster");
    result = sp_image_capture_match_sample(topLeftFrame, 4, 4, 16,
        CGRectMake(0, 0, 4, 4), CGRectMake(10, 20, 4, 4), 1, 1, "DeviceRGB", 987654328);
    check(result.state == SP_IMAGE_CAPTURE_MATCHED && result.candidate_count == 1,
        @"ScreenCaptureKit maps a source rectangle at the screenRect top-left origin to the frame top row");
    sp_image_capture_match_result_dispose(&result);
    sp_image_capture_match_end();

    sp_image_capture_match_begin(NULL, NULL);
    const size_t overLimitWidth = (64 * 1024 * 1024) / 4 + 1;
    uint8_t *overLimit = calloc(overLimitWidth, 4);
    check(overLimit != NULL, @"the bounded-retention fixture allocates its over-limit raster");
    if (overLimit) {
        check(sp_image_capture_match_retain(first, source, 2, 2, 8, bounds, 1, "DeviceRGB"),
            @"the bounded-retention fixture has an observed candidate");
        check(!sp_image_capture_match_retain(first, overLimit, overLimitWidth, 1,
            overLimitWidth * 4, bounds, 1, "DeviceRGB"),
            @"a source raster above the diagnostic byte limit is refused");
        free(overLimit);
        result = sp_image_capture_match_sample(frame, 4, 4, 16,
            CGRectMake(0, 0, 4, 4), CGRectMake(10, 20, 4, 4), 1, 1, "DeviceRGB", 987654327);
        check(result.state == SP_IMAGE_CAPTURE_UNKNOWN_RETENTION && result.dropped_snapshots == 1
            && result.candidate_count == 1,
            @"a retention drop prevents a seemingly unique observed candidate from being reported as matched");
        sp_image_capture_match_result_dispose(&result);
    }
    sp_image_capture_match_end();
    sp_image_capture_match_begin(NULL, NULL);
    frameIdentitySessionChecks();
    sp_image_capture_match_end();
    fprintf(stderr, "%s: native image capture identity matching\n", failures ? "FAIL" : "PASS");
    return failures ? 1 : 0;
} }
