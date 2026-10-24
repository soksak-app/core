#import "../src/image_capture_match.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int failures;
static void check(BOOL ok, NSString *label) {
    fprintf(stderr, "%s: %s\n", ok ? "PASS" : "FAIL", label.UTF8String);
    if (!ok) failures++;
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
    fprintf(stderr, "%s: native image capture identity matching\n", failures ? "FAIL" : "PASS");
    return failures ? 1 : 0;
} }
