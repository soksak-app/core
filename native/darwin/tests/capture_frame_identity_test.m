#import "capture_frame_identity.h"
#include <stdio.h>

static int failures;
static void check(BOOL ok, const char *label) {
    fprintf(stderr, "%s: %s\n", ok ? "PASS" : "FAIL", label);
    if (!ok) failures++;
}

int main(void) { @autoreleasepool {
    fprintf(stderr, "START: native capture frame identity\n");
    const size_t width = 256, height = 256, row_bytes = width * 4;
    NSMutableData *source = [NSMutableData dataWithLength:row_bytes * height];
    memset(source.mutableBytes, 0x70, source.length);
    CGColorSpaceRef color_space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    SPCaptureFrameIdentity expected = { 7, 11, 13 };
    CGImageRef image = NULL;
    NSData *instrumented = nil;
    NSString *payload = nil;
    NSString *error = nil;
    CGRect roi = CGRectMake(32, 32, 192, 192);
    BOOL encoded = sp_capture_frame_identity_encode(source.bytes, width, height, row_bytes, color_space,
        roi, @"0123456789abcdef0123456789abcdef", expected, &image, &instrumented, &payload, &error);
    check(encoded && image != NULL && instrumented.length == source.length && error == nil,
        "an issued source identity encodes to an immutable image and a diagnostic raster copy");
    if (encoded) {
        CFStringRef srgb_name = CGColorSpaceCopyName(CGImageGetColorSpace(image));
        check(srgb_name && CFEqual(srgb_name, kCGColorSpaceSRGB), "encoding preserves sRGB color metadata");
        if (srgb_name) CFRelease(srgb_name);
        BOOL outsideMatches = YES;
        for (size_t y = 0; y < height; y++) for (size_t x = 0; x < width; x++) {
            if (x >= (size_t)roi.origin.x && x < (size_t)CGRectGetMaxX(roi)
                && y >= (size_t)roi.origin.y && y < (size_t)CGRectGetMaxY(roi)) continue;
            if (memcmp((const uint8_t *)source.bytes + y * row_bytes + x * 4,
                (const uint8_t *)instrumented.bytes + y * row_bytes + x * 4, 4) != 0) outsideMatches = NO;
        }
        check(outsideMatches, "every BGRA pixel outside the reserved ROI remains byte-identical");
        SPCaptureFrameIdentity decoded = { 0 };
        NSString *unknown_reason = nil;
        NSSet *issued = [NSSet setWithObject:payload];
        BOOL didDecode = sp_capture_frame_identity_decode(image, roi, issued, &decoded, &unknown_reason, &error);
        check(didDecode && decoded.generation == expected.generation && decoded.raster == expected.raster
            && decoded.sequence == expected.sequence && unknown_reason == nil,
            "Vision decodes the exact issued nonce and source identity");
        [unknown_reason release];
        unknown_reason = nil;
        didDecode = sp_capture_frame_identity_decode(image, roi, [NSSet set], &decoded, &unknown_reason, &error);
        check(!didDecode && [unknown_reason isEqualToString:@"payload-unissued"],
            "a decodable payload not issued for this recording is explicitly unknown");
        [unknown_reason release];
        unknown_reason = nil;
        didDecode = sp_capture_frame_identity_decode(image, CGRectMake(0, 0, 64, 64), issued,
            &decoded, &unknown_reason, &error);
        check(!didDecode && [unknown_reason isEqualToString:@"code-outside-expected-roi"],
            "a complete code outside the expected ROI is explicitly unknown");
        [unknown_reason release];
        unknown_reason = nil;
        CGImageRef cropped = CGImageCreateWithImageInRect(image, CGRectMake(32, 32, 80, 192));
        didDecode = sp_capture_frame_identity_decode(cropped, CGRectMake(0, 0, 80, 192), issued,
            &decoded, &unknown_reason, &error);
        check(!didDecode && unknown_reason != nil,
            "a cropped code cannot yield a guessed source identity");
        [unknown_reason release];
        CGImageRelease(cropped);
        unknown_reason = nil;
        NSMutableData *pair_pixels = [NSMutableData dataWithLength:row_bytes * height * 2];
        CGContextRef pair_context = CGBitmapContextCreate(pair_pixels.mutableBytes, width * 2, height, 8,
            row_bytes * 2, CGImageGetColorSpace(image), kCGBitmapByteOrder32Little | kCGImageAlphaPremultipliedFirst);
        CGContextDrawImage(pair_context, CGRectMake(0, 0, width, height), image);
        CGContextDrawImage(pair_context, CGRectMake(width, 0, width, height), image);
        CGImageRef pair_image = CGBitmapContextCreateImage(pair_context);
        CGContextRelease(pair_context);
        didDecode = sp_capture_frame_identity_decode(pair_image, CGRectMake(0, 0, width * 2, height), issued,
            &decoded, &unknown_reason, &error);
        check(!didDecode && [unknown_reason isEqualToString:@"ambiguous-code-count"],
            "multiple complete codes in the expected ROI are explicitly ambiguous");
        [unknown_reason release];
        CGImageRelease(pair_image);
    }
    if (image) CGImageRelease(image);
    [instrumented release];
    [payload release];
    [error release];
    CGColorSpaceRelease(color_space);

    color_space = CGColorSpaceCreateWithName(kCGColorSpaceDisplayP3);
    image = NULL; instrumented = nil; payload = nil; error = nil;
    encoded = sp_capture_frame_identity_encode(source.bytes, width, height, row_bytes, color_space,
        roi, @"0123456789abcdef0123456789abcdef", expected, &image, &instrumented, &payload, &error);
    CGColorSpaceRef output_color_space = image ? CGImageGetColorSpace(image) : NULL;
    CFStringRef output_name = output_color_space ? CGColorSpaceCopyName(output_color_space) : NULL;
    check(encoded && output_name && CFEqual(output_name, kCGColorSpaceDisplayP3),
        "encoding preserves Display P3 color metadata");
    if (output_name) CFRelease(output_name);
    if (image) CGImageRelease(image);
    [instrumented release]; [payload release]; [error release];
    CGColorSpaceRelease(color_space);

    color_space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    image = NULL; instrumented = nil; payload = nil; error = nil;
    encoded = sp_capture_frame_identity_encode(source.bytes, width, height, row_bytes, color_space,
        roi, @"invalid", expected, &image, &instrumented, &payload, &error);
    check(!encoded && error != nil && image == NULL && instrumented == nil && payload == nil,
        "invalid nonce input returns an explicit error and no partial owned outputs");
    CGColorSpaceRelease(color_space);
    [error release];
    fprintf(stderr, "%s: native capture frame identity\n", failures ? "FAIL" : "PASS");
    return failures ? 1 : 0;
} }
