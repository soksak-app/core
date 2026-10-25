#import "capture_frame_identity.h"
#import <CommonCrypto/CommonDigest.h>
#import <CoreImage/CoreImage.h>
#include <stdio.h>

static int failures;
static void check(BOOL ok, const char *label) {
    fprintf(stderr, "%s: %s\n", ok ? "PASS" : "FAIL", label);
    if (!ok) failures++;
}

static NSString *testPayload(NSString *prefix) {
    NSData *bytes = [prefix dataUsingEncoding:NSUTF8StringEncoding];
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(bytes.bytes, (CC_LONG)bytes.length, digest);
    NSMutableString *hex = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
    for (NSUInteger index = 0; index < CC_SHA256_DIGEST_LENGTH; index++) [hex appendFormat:@"%02x", digest[index]];
    return [NSString stringWithFormat:@"%@:%@", prefix, hex];
}

static BOOL testRasterHasIntegerQRGeometry(NSData *raster, size_t width, size_t height, size_t row_bytes,
    CGRect roi, NSString *payload, CGColorSpaceRef color_space) {
    CIFilter *filter = [CIFilter filterWithName:@"CIQRCodeGenerator"];
    if (!filter) { check(NO, "CoreImage creates a QR generator for ROI geometry checks"); return NO; }
    [filter setValue:[payload dataUsingEncoding:NSUTF8StringEncoding] forKey:@"inputMessage"];
    [filter setValue:@"H" forKey:@"inputCorrectionLevel"];
    CIImage *qr = filter.outputImage;
    CIContext *context = [CIContext contextWithOptions:@{ kCIContextWorkingColorSpace: (__bridge id)color_space }];
    CGImageRef matrix = qr && context ? [context createCGImage:qr fromRect:qr.extent] : NULL;
    if (!matrix) { check(NO, "CoreImage rasterizes a QR matrix for ROI geometry checks"); return NO; }
    size_t modules = CGImageGetWidth(matrix);
    size_t scale = (size_t)floor(MIN(roi.size.width, roi.size.height) / (modules + 8));
    size_t full_side = (modules + 8) * scale;
    size_t code_side = modules * scale;
    size_t left = (size_t)roi.origin.x + ((size_t)roi.size.width - full_side) / 2;
    size_t top = (size_t)roi.origin.y + ((size_t)roi.size.height - full_side) / 2;
    BOOL valid = scale >= 2 && left + full_side <= width && top + full_side <= height;
    const uint8_t *bytes = raster.bytes;
    for (size_t my = 0; valid && my < modules; my++) for (size_t mx = 0; mx < modules; mx++) {
        size_t x = left + 4 * scale + mx * scale;
        size_t y = top + 4 * scale + my * scale;
        const uint8_t *first = bytes + y * row_bytes + x * 4;
        for (size_t dy = 0; dy < scale; dy++) for (size_t dx = 0; dx < scale; dx++) {
            if (memcmp(first, bytes + (y + dy) * row_bytes + (x + dx) * 4, 4) != 0) valid = NO;
        }
    }
    for (size_t y = top; valid && y < top + full_side; y++) for (size_t x = left; x < left + full_side; x++) {
        BOOL quiet = x < left + 4 * scale || x >= left + 4 * scale + code_side
            || y < top + 4 * scale || y >= top + 4 * scale + code_side;
        if (!quiet) continue;
        const uint8_t *pixel = bytes + y * row_bytes + x * 4;
        if (pixel[0] != 255 || pixel[1] != 255 || pixel[2] != 255 || pixel[3] != 255) valid = NO;
    }
    CGImageRelease(matrix);
    return valid;
}

static CGImageRef testImageForMessage(NSData *message, size_t width, size_t height, CGColorSpaceRef color_space) {
    CIFilter *filter = [CIFilter filterWithName:@"CIQRCodeGenerator"];
    if (!filter) { check(NO, "CoreImage test QR generator is available"); return NULL; }
    [filter setValue:message forKey:@"inputMessage"];
    [filter setValue:@"H" forKey:@"inputCorrectionLevel"];
    CIImage *qr = filter.outputImage;
    if (!qr) { check(NO, "CoreImage test QR output exists"); return NULL; }
    CIContext *ci = [CIContext contextWithOptions:@{ kCIContextWorkingColorSpace: (__bridge id)color_space }];
    CGImageRef qr_image = [ci createCGImage:qr fromRect:qr.extent];
    if (!qr_image) { check(NO, "CoreImage test QR rasterization succeeds"); return NULL; }
    NSMutableData *pixels = [NSMutableData dataWithLength:width * height * 4];
    CGContextRef context = CGBitmapContextCreate(pixels.mutableBytes, width, height, 8, width * 4,
        color_space, kCGBitmapByteOrder32Little | kCGImageAlphaPremultipliedFirst);
    if (!context) { check(NO, "test QR bitmap context is created"); CGImageRelease(qr_image); return NULL; }
    CGContextSetRGBFillColor(context, 1, 1, 1, 1);
    CGContextFillRect(context, CGRectMake(0, 0, width, height));
    CGContextSetInterpolationQuality(context, kCGInterpolationNone);
    CGFloat side = MIN(width, height) - 64;
    CGContextDrawImage(context, CGRectMake(32, 32, side, side), qr_image);
    CGImageRef image = CGBitmapContextCreateImage(context);
    CGContextRelease(context);
    CGImageRelease(qr_image);
    if (!image) check(NO, "test QR output image is created");
    return image;
}

static CGImageRef testImageForPayload(NSString *payload, size_t width, size_t height, CGColorSpaceRef color_space) {
    return testImageForMessage([payload dataUsingEncoding:NSUTF8StringEncoding], width, height, color_space);
}

static NSData *testBGRAForImage(CGImageRef image) {
    size_t width = image ? CGImageGetWidth(image) : 0;
    size_t height = image ? CGImageGetHeight(image) : 0;
    if (!width || !height || width > SIZE_MAX / 4 || height > SIZE_MAX / (width * 4)) return nil;
    size_t row_bytes = width * 4;
    NSMutableData *pixels = [NSMutableData dataWithLength:row_bytes * height];
    CGColorSpaceRef color_space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef context = color_space ? CGBitmapContextCreate(pixels.mutableBytes, width, height, 8,
        row_bytes, color_space, kCGBitmapByteOrder32Little | kCGImageAlphaPremultipliedFirst) : NULL;
    if (context) CGContextDrawImage(context, CGRectMake(0, 0, width, height), image);
    if (context) CGContextRelease(context);
    if (color_space) CGColorSpaceRelease(color_space);
    return context ? pixels : nil;
}

static NSData *testRotateBGRA(NSData *pixels, size_t width, size_t height) {
    if (!pixels || width != height || width > SIZE_MAX / 4 || height > SIZE_MAX / (width * 4)
        || pixels.length != width * height * 4) return nil;
    NSMutableData *rotated = [NSMutableData dataWithLength:pixels.length];
    const uint8_t *source = pixels.bytes;
    uint8_t *destination = rotated.mutableBytes;
    for (size_t y = 0; y < height; y++) for (size_t x = 0; x < width; x++) {
        size_t sourceOffset = (y * width + x) * 4;
        size_t destinationOffset = (x * width + (height - 1 - y)) * 4;
        memcpy(destination + destinationOffset, source + sourceOffset, 4);
    }
    return rotated;
}

static NSData *testInvertBGRA(NSData *pixels, size_t width, size_t height) {
    if (!pixels || width > SIZE_MAX / 4 || height > SIZE_MAX / (width * 4)
        || pixels.length != width * height * 4) return nil;
    NSMutableData *inverted = [NSMutableData dataWithData:pixels];
    uint8_t *bytes = inverted.mutableBytes;
    for (size_t index = 0; index < width * height; index++) {
        bytes[index * 4] = 255 - bytes[index * 4];
        bytes[index * 4 + 1] = 255 - bytes[index * 4 + 1];
        bytes[index * 4 + 2] = 255 - bytes[index * 4 + 2];
    }
    return inverted;
}

static BOOL testDecodeImage(CGImageRef image, CGRect roi, NSSet<NSString *> *issued,
    SPCaptureFrameIdentity *identity, NSString **unknown_reason, NSString **error) {
    NSData *pixels = testBGRAForImage(image);
    if (!pixels) {
        if (unknown_reason) *unknown_reason = nil;
        if (error) *error = [@"test BGRA image conversion failed" copy];
        return NO;
    }
    size_t width = CGImageGetWidth(image), height = CGImageGetHeight(image);
    return sp_capture_frame_identity_decode(pixels.bytes, pixels.length, width, height, width * 4,
        roi, issued, identity, unknown_reason, error);
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
        CIFilter *qr_filter = [CIFilter filterWithName:@"CIQRCodeGenerator"];
        check(qr_filter != nil, "CoreImage creates a QR generator for module checks");
        CIImage *qr_ci_image = nil;
        [qr_filter setValue:[payload dataUsingEncoding:NSUTF8StringEncoding] forKey:@"inputMessage"];
        [qr_filter setValue:@"H" forKey:@"inputCorrectionLevel"];
        qr_ci_image = qr_filter.outputImage;
        check(qr_ci_image != nil, "CoreImage creates a QR matrix for module checks");
        CIContext *qr_context = [CIContext contextWithOptions:@{ kCIContextWorkingColorSpace: (__bridge id)color_space }];
        CGImageRef qr_matrix = qr_ci_image && qr_context
            ? [qr_context createCGImage:qr_ci_image fromRect:qr_ci_image.extent] : NULL;
        check(qr_matrix != NULL, "CoreImage rasterizes a QR matrix for module checks");
        size_t modules = qr_matrix ? CGImageGetWidth(qr_matrix) : 0;
        size_t scale = (size_t)floor(MIN(roi.size.width, roi.size.height) / (modules + 8));
        size_t full_side = (modules + 8) * scale;
        size_t code_side = modules * scale;
        size_t left = (size_t)roi.origin.x + ((size_t)roi.size.width - full_side) / 2;
        size_t top = (size_t)roi.origin.y + ((size_t)roi.size.height - full_side) / 2;
        size_t blackLeft = code_side, blackTop = code_side, blackRight = 0, blackBottom = 0;
        for (size_t y = 0; y < code_side; y++) for (size_t x = 0; x < code_side; x++) {
            const uint8_t *pixel = (const uint8_t *)instrumented.bytes
                + (top + 4 * scale + y) * row_bytes + (left + 4 * scale + x) * 4;
            if (pixel[0] < 128 && pixel[1] < 128 && pixel[2] < 128) {
                if (x < blackLeft) blackLeft = x;
                if (x > blackRight) blackRight = x;
                if (y < blackTop) blackTop = y;
                if (y > blackBottom) blackBottom = y;
            }
        }
        CGRect qrModuleBounds = CGRectMake(left + 4 * scale + blackLeft, top + 4 * scale + blackTop,
            blackRight - blackLeft + 1, blackBottom - blackTop + 1);
        BOOL integer_modules = qr_matrix && scale > 0;
        for (size_t module_y = 0; integer_modules && module_y < modules; module_y++) {
            for (size_t module_x = 0; module_x < modules; module_x++) {
                size_t pixel_x = left + 4 * scale + module_x * scale;
                size_t pixel_y = top + 4 * scale + module_y * scale;
                const uint8_t *first = (const uint8_t *)instrumented.bytes + pixel_y * row_bytes + pixel_x * 4;
                for (size_t dy = 0; dy < scale; dy++) for (size_t dx = 0; dx < scale; dx++) {
                    const uint8_t *sample = (const uint8_t *)instrumented.bytes
                        + (pixel_y + dy) * row_bytes + (pixel_x + dx) * 4;
                    if (memcmp(first, sample, 4) != 0) integer_modules = NO;
                }
            }
        }
        BOOL four_module_quiet_zone = integer_modules;
        for (size_t y = top; four_module_quiet_zone && y < top + full_side; y++) {
            for (size_t x = left; x < left + full_side; x++) {
                BOOL quiet = x < left + 4 * scale || x >= left + 4 * scale + code_side
                    || y < top + 4 * scale || y >= top + 4 * scale + code_side;
                if (!quiet) continue;
                const uint8_t *pixel = (const uint8_t *)instrumented.bytes + y * row_bytes + x * 4;
                if (pixel[0] != 255 || pixel[1] != 255 || pixel[2] != 255 || pixel[3] != 255)
                    four_module_quiet_zone = NO;
            }
        }
        check(integer_modules && four_module_quiet_zone,
            "QR modules use integer pixel blocks surrounded by four white quiet modules");
        if (qr_matrix) CGImageRelease(qr_matrix);
        SPCaptureFrameIdentity decoded = { 0 };
        NSString *unknown_reason = nil;
        NSSet *issued = [NSSet setWithObject:payload];
        BOOL didDecode = testDecodeImage(image, roi, issued, &decoded, &unknown_reason, &error);
        check(didDecode && decoded.generation == expected.generation && decoded.raster == expected.raster
            && decoded.sequence == expected.sequence && unknown_reason == nil,
            "local CPU decoder decodes the exact issued nonce and source identity");
        NSData *sourcePixels = testBGRAForImage(image);
        NSData *rotatedPixels = testRotateBGRA(sourcePixels, width, height);
        SPCaptureFrameIdentity rotatedIdentity = { 0 };
        NSString *rotatedReason = nil, *rotatedError = nil;
        BOOL rotatedDecode = rotatedPixels && sp_capture_frame_identity_decode(rotatedPixels.bytes,
            rotatedPixels.length, width, height, row_bytes, roi, issued, &rotatedIdentity,
            &rotatedReason, &rotatedError);
        check(rotatedDecode && rotatedIdentity.sequence == expected.sequence && rotatedReason == nil
            && rotatedError == nil, "the decoder reads an issued QR code rotated within an asymmetric pixel raster");
        NSData *invertedPixels = testInvertBGRA(sourcePixels, width, height);
        SPCaptureFrameIdentity invertedIdentity = { 0 };
        NSString *invertedReason = nil, *invertedError = nil;
        BOOL invertedDecode = invertedPixels && sp_capture_frame_identity_decode(invertedPixels.bytes,
            invertedPixels.length, width, height, row_bytes, roi, issued, &invertedIdentity,
            &invertedReason, &invertedError);
        check(invertedDecode && invertedIdentity.sequence == expected.sequence && invertedReason == nil
            && invertedError == nil, "the decoder reads an issued QR code with inverted foreground and background");
        [rotatedReason release]; [rotatedError release]; [invertedReason release]; [invertedError release];
        NSString *builder_payload = nil;
        NSString *builder_error = nil;
        BOOL built_payload = sp_capture_frame_identity_payload(@"0123456789abcdef0123456789abcdef", expected,
            &builder_payload, &builder_error);
        check(built_payload && [builder_payload isEqualToString:payload] && builder_error == nil,
            "canonical payload generation matches the payload embedded by image encoding");
        [builder_payload release]; [builder_error release];
        builder_payload = nil; builder_error = nil;
        built_payload = sp_capture_frame_identity_payload(@"invalid", expected, &builder_payload, &builder_error);
        check(!built_payload && builder_payload == nil && [builder_error containsString:@"nonce"],
            "invalid nonce payload generation returns an explicit error and no output");
        [builder_payload release]; [builder_error release];
        [unknown_reason release];
        unknown_reason = nil;
        didDecode = testDecodeImage(image, roi, [NSSet set], &decoded, &unknown_reason, &error);
        check(!didDecode && [unknown_reason isEqualToString:@"payload-unissued"],
            "a decodable payload not issued for this recording is explicitly unknown");
        [unknown_reason release];
        unknown_reason = nil;
        NSMutableData *nulSuffixBytes = [NSMutableData dataWithData:[payload dataUsingEncoding:NSUTF8StringEncoding]];
        const uint8_t nul = 0;
        [nulSuffixBytes appendBytes:&nul length:1];
        [nulSuffixBytes appendData:[@"tail" dataUsingEncoding:NSUTF8StringEncoding]];
        CGImageRef nulSuffixImage = testImageForMessage(nulSuffixBytes, width, height, color_space);
        BOOL nulSuffixDecoded = nulSuffixImage && testDecodeImage(nulSuffixImage, roi, issued,
            &decoded, &unknown_reason, &error);
        NSString *nulSuffixMessage = [NSString stringWithFormat:
            @"a QR payload with an embedded NUL and suffix cannot match a shorter issued payload (decoded=%d, reason=%@, error=%@)",
            nulSuffixDecoded, unknown_reason ?: @"nil", error ?: @"nil"];
        check(!nulSuffixDecoded && [unknown_reason isEqualToString:@"payload-malformed"],
            nulSuffixMessage.UTF8String);
        [unknown_reason release]; unknown_reason = nil;
        [error release]; error = nil;
        if (nulSuffixImage) CGImageRelease(nulSuffixImage);
        didDecode = testDecodeImage(image, CGRectMake(0, 0, 64, 64), issued,
            &decoded, &unknown_reason, &error);
        check(!didDecode && [unknown_reason isEqualToString:@"no-code-in-expected-roi"],
            "a complete code outside the expected ROI is explicitly unknown");
        [unknown_reason release];
        unknown_reason = nil;
        CGImageRef cropped = CGImageCreateWithImageInRect(image, CGRectMake(32, 32, 80, 192));
        didDecode = testDecodeImage(cropped, CGRectMake(0, 0, 80, 192), issued,
            &decoded, &unknown_reason, &error);
        check(!didDecode && unknown_reason != nil,
            "a cropped code cannot yield a guessed source identity");
        [unknown_reason release];
        CGImageRelease(cropped);
        CGRect clippedROIs[] = {
            CGRectMake(32, CGRectGetMinY(qrModuleBounds) + scale, 192,
                CGRectGetMaxY(roi) - CGRectGetMinY(qrModuleBounds) - scale),
            CGRectMake(32, 32, 192, CGRectGetMinY(qrModuleBounds) + qrModuleBounds.size.height - scale - 32),
            CGRectMake(CGRectGetMinX(qrModuleBounds) + scale, 32,
                CGRectGetMaxX(roi) - CGRectGetMinX(qrModuleBounds) - scale, 192),
            CGRectMake(32, 32, CGRectGetMinX(qrModuleBounds) + qrModuleBounds.size.width - scale - 32, 192)
        };
        const char *clippedLabels[] = {
            "QR modules clipped at the top ROI edge are unknown",
            "QR modules clipped at the bottom ROI edge are unknown",
            "QR modules clipped at the left ROI edge are unknown",
            "QR modules clipped at the right ROI edge are unknown"
        };
        for (NSUInteger edge = 0; edge < sizeof(clippedROIs) / sizeof(clippedROIs[0]); edge++) {
            NSString *edgeReason = nil, *edgeError = nil;
            SPCaptureFrameIdentity edgeIdentity = { 0 };
            check(!CGRectContainsRect(clippedROIs[edge], qrModuleBounds),
                "each clipped-edge ROI excludes a measured nonwhite QR module bound");
            BOOL edgeDecoded = testDecodeImage(image, clippedROIs[edge], issued,
                &edgeIdentity, &edgeReason, &edgeError);
            NSString *edgeMessage = [NSString stringWithFormat:@"%s (decoded=%d, reason=%@, error=%@)",
                clippedLabels[edge], edgeDecoded, edgeReason ?: @"nil", edgeError ?: @"nil"];
            check(!edgeDecoded && [edgeReason isEqualToString:@"cropped-code-in-expected-roi"] && edgeError == nil,
                edgeMessage.UTF8String);
            [edgeReason release]; [edgeError release];
        }
        CGRect moduleClipRects[] = {
            CGRectMake(0, CGRectGetMinY(qrModuleBounds) + scale, width,
                height - CGRectGetMinY(qrModuleBounds) - scale),
            CGRectMake(0, 0, width, CGRectGetMinY(qrModuleBounds) + qrModuleBounds.size.height - scale),
            CGRectMake(CGRectGetMinX(qrModuleBounds) + scale, 0,
                width - CGRectGetMinX(qrModuleBounds) - scale, height),
            CGRectMake(0, 0, CGRectGetMinX(qrModuleBounds) + qrModuleBounds.size.width - scale, height)
        };
        const char *moduleClipLabels[] = {
            "a compact raster clipped through top QR modules cannot identify the source",
            "a compact raster clipped through bottom QR modules cannot identify the source",
            "a compact raster clipped through left QR modules cannot identify the source",
            "a compact raster clipped through right QR modules cannot identify the source"
        };
        for (NSUInteger edge = 0; edge < sizeof(moduleClipRects) / sizeof(moduleClipRects[0]); edge++) {
            check(!CGRectContainsRect(moduleClipRects[edge], qrModuleBounds),
                "each compact raster clip removes measured QR modules");
            CGImageRef clippedImage = CGImageCreateWithImageInRect(image, moduleClipRects[edge]);
            CGRect compactROI = CGRectMake(0, 0, CGImageGetWidth(clippedImage), CGImageGetHeight(clippedImage));
            NSString *clipReason = nil, *clipError = nil;
            SPCaptureFrameIdentity clipIdentity = { 0 };
            BOOL clipDecoded = clippedImage && testDecodeImage(clippedImage, compactROI, issued,
                &clipIdentity, &clipReason, &clipError);
            NSString *clipMessage = [NSString stringWithFormat:@"%s (decoded=%d, reason=%@, error=%@)",
                moduleClipLabels[edge], clipDecoded, clipReason ?: @"nil", clipError ?: @"nil"];
            check(!clipDecoded && clipReason != nil && clipError == nil, clipMessage.UTF8String);
            [clipReason release]; [clipError release];
            if (clippedImage) CGImageRelease(clippedImage);
        }
        unknown_reason = nil;
        NSMutableData *pair_pixels = [NSMutableData dataWithLength:row_bytes * height * 2];
        CGContextRef pair_context = CGBitmapContextCreate(pair_pixels.mutableBytes, width * 2, height, 8,
            row_bytes * 2, CGImageGetColorSpace(image), kCGBitmapByteOrder32Little | kCGImageAlphaPremultipliedFirst);
        check(pair_context != NULL, "multiple-code fixture bitmap context is created");
        if (pair_context) {
            CGContextDrawImage(pair_context, CGRectMake(0, 0, width, height), image);
            CGContextDrawImage(pair_context, CGRectMake(width, 0, width, height), image);
        }
        CGImageRef pair_image = pair_context ? CGBitmapContextCreateImage(pair_context) : NULL;
        if (pair_context) CGContextRelease(pair_context);
        check(pair_image != NULL, "multiple-code fixture image is created");
        didDecode = pair_image && testDecodeImage(pair_image, roi, issued,
            &decoded, &unknown_reason, &error);
        check(didDecode && decoded.sequence == expected.sequence,
            "a complete target code decodes when a second QR code is outside the expected ROI");
        [unknown_reason release]; unknown_reason = nil;
        didDecode = pair_image && testDecodeImage(pair_image, CGRectMake(0, 0, width * 2, height), issued,
            &decoded, &unknown_reason, &error);
        check(!didDecode && [unknown_reason isEqualToString:@"ambiguous-code-count"],
            "multiple complete codes in the expected ROI are explicitly ambiguous");
        [unknown_reason release];
        if (pair_image) CGImageRelease(pair_image);

        BOOL immutable_raster = ![instrumented isKindOfClass:[NSMutableData class]];
        NSMutableData *raster_copy = [instrumented mutableCopy];
        uint8_t original_first_byte = ((const uint8_t *)instrumented.bytes)[0];
        ((uint8_t *)raster_copy.mutableBytes)[0] ^= 0xff;
        CFDataRef provider_bytes = CGDataProviderCopyData(CGImageGetDataProvider(image));
        check(immutable_raster && ((const uint8_t *)instrumented.bytes)[0] == original_first_byte
            && ((const uint8_t *)CFDataGetBytePtr(provider_bytes))[0] == original_first_byte,
            "mutating the returned raster cannot mutate the immutable image backing");
        CFRelease(provider_bytes);
        [raster_copy release];

        CGImageRef other_region = NULL;
        NSData *other_region_raster = nil;
        NSString *other_region_payload = nil;
        BOOL other_region_encoded = sp_capture_frame_identity_encode(source.bytes, width, height, row_bytes,
            color_space, CGRectMake(0, 0, 192, 192), @"fedcba9876543210fedcba9876543210", expected,
            &other_region, &other_region_raster, &other_region_payload, &error);
        unknown_reason = nil;
        didDecode = other_region_encoded && testDecodeImage(other_region, CGRectMake(0, 0, 192, 192),
            issued, &decoded, &unknown_reason, &error);
        check(!didDecode && [unknown_reason isEqualToString:@"payload-unissued"],
            "an identity nonce issued for one region cannot identify the same tuple in another region");
        [unknown_reason release];
        CGImageRelease(other_region); [other_region_raster release]; [other_region_payload release];
    }
    if (image) CGImageRelease(image);
    [instrumented release];
    [payload release];
    [error release];
    CGColorSpaceRelease(color_space);

    const size_t asymmetric_size = 320, asymmetric_stride = asymmetric_size * 4;
    NSMutableData *asymmetric_source = [NSMutableData dataWithLength:asymmetric_stride * asymmetric_size];
    memset(asymmetric_source.mutableBytes, 0x70, asymmetric_source.length);
    color_space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGRect top_roi = CGRectMake(8, 16, 160, 144);
    CGRect bottom_roi = CGRectMake(152, 176, 160, 144);
    CGRect asymmetric_rois[] = { top_roi, bottom_roi };
    for (NSUInteger roi_index = 0; roi_index < 2; roi_index++) {
        image = NULL; instrumented = nil; payload = nil; error = nil;
        encoded = sp_capture_frame_identity_encode(asymmetric_source.bytes, asymmetric_size, asymmetric_size,
            asymmetric_stride, color_space, asymmetric_rois[roi_index],
            roi_index ? @"11111111111111111111111111111111" : @"22222222222222222222222222222222",
            expected, &image, &instrumented, &payload, &error);
        BOOL changed_only_inside_roi = YES;
        for (size_t y = 0; encoded && y < asymmetric_size; y++) for (size_t x = 0; x < asymmetric_size; x++) {
            BOOL inside = x >= (size_t)asymmetric_rois[roi_index].origin.x
                && x < (size_t)CGRectGetMaxX(asymmetric_rois[roi_index])
                && y >= (size_t)asymmetric_rois[roi_index].origin.y
                && y < (size_t)CGRectGetMaxY(asymmetric_rois[roi_index]);
            if (!inside && memcmp((const uint8_t *)asymmetric_source.bytes + y * asymmetric_stride + x * 4,
                (const uint8_t *)instrumented.bytes + y * asymmetric_stride + x * 4, 4) != 0) changed_only_inside_roi = NO;
        }
        check(encoded && image && changed_only_inside_roi,
            roi_index ? "bottom ROI writes only within its top-left pixel rectangle"
                : "top ROI writes only within its top-left pixel rectangle");
        SPCaptureFrameIdentity decoded = { 0 };
        NSString *unknown_reason = nil;
        BOOL didDecode = encoded && image && testDecodeImage(image, asymmetric_rois[roi_index],
            [NSSet setWithObject:payload], &decoded, &unknown_reason, &error);
        check(didDecode && decoded.sequence == expected.sequence,
            roi_index ? "bottom top-left ROI identity round-trips" : "top top-left ROI identity round-trips");
        if (!roi_index && encoded && image) {
            CGImageRef top_crop = CGImageCreateWithImageInRect(image, top_roi);
            SPCaptureFrameIdentity crop_identity = { 0 };
            NSString *crop_reason = nil;
            NSString *crop_error = nil;
            BOOL crop_decoded = top_crop && testDecodeImage(top_crop,
                CGRectMake(0, 0, top_roi.size.width, top_roi.size.height), [NSSet setWithObject:payload],
                &crop_identity, &crop_reason, &crop_error);
            check(crop_decoded && crop_identity.sequence == expected.sequence,
                "CGImage top-left crop contains the code written to the top-left BGRA ROI");
            [crop_reason release]; [crop_error release]; if (top_crop) CGImageRelease(top_crop);
        }
        [unknown_reason release]; [error release]; [instrumented release]; [payload release];
        if (image) CGImageRelease(image);
    }
    CGRect odd_roi = CGRectMake(9, 11, 161, 145);
    image = NULL; instrumented = nil; payload = nil; error = nil;
    encoded = sp_capture_frame_identity_encode(asymmetric_source.bytes, asymmetric_size, asymmetric_size,
        asymmetric_stride, color_space, odd_roi, @"33333333333333333333333333333333", expected,
        &image, &instrumented, &payload, &error);
    check(encoded && testRasterHasIntegerQRGeometry(instrumented, asymmetric_size, asymmetric_size,
        asymmetric_stride, odd_roi, payload, color_space),
        "an odd-sized ROI centers integer QR modules and the complete quiet zone on pixel boundaries");
    SPCaptureFrameIdentity odd_decoded_identity = { 0 };
    NSString *odd_reason = nil;
    BOOL odd_decoded = encoded && testDecodeImage(image, odd_roi, [NSSet setWithObject:payload],
        &odd_decoded_identity, &odd_reason, &error);
    check(odd_decoded && odd_decoded_identity.sequence == expected.sequence,
        "an odd-sized top-left ROI identity round-trips");
    [odd_reason release]; [error release]; [instrumented release]; [payload release];
    if (image) CGImageRelease(image);
    CGColorSpaceRelease(color_space);

    color_space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    NSString *malformed_prefixes[] = {
        @"soksak-frame-id:v1:0123456789abcdef0123456789abcdef:+7:11:13",
        @"soksak-frame-id:v1:0123456789abcdef0123456789abcdef: 7:11:13",
        @"soksak-frame-id:v1:0123456789abcdef0123456789abcdef:18446744073709551616:11:13"
    };
    for (NSUInteger index = 0; index < sizeof(malformed_prefixes) / sizeof(malformed_prefixes[0]); index++) {
        NSString *issued_malformed = testPayload(malformed_prefixes[index]);
        CGImageRef malformed_image = testImageForPayload(issued_malformed, width, height, color_space);
        check(malformed_image != NULL, "CoreImage creates a malformed-payload fixture image");
        SPCaptureFrameIdentity decoded = { 0 };
        NSString *unknown_reason = nil;
        NSString *error = nil;
        BOOL didDecode = malformed_image && testDecodeImage(malformed_image, roi,
            [NSSet setWithObject:issued_malformed], &decoded, &unknown_reason, &error);
        check(!didDecode && [unknown_reason isEqualToString:@"payload-malformed"],
            "an issued payload with noncanonical or overflowing uint64 text is rejected");
        [unknown_reason release]; [error release]; if (malformed_image) CGImageRelease(malformed_image);
    }
    NSString *max_prefix = @"soksak-frame-id:v1:0123456789abcdef0123456789abcdef:18446744073709551615:18446744073709551615:18446744073709551615";
    NSString *max_payload = testPayload(max_prefix);
    CGImageRef max_image = testImageForPayload(max_payload, width, height, color_space);
    check(max_image != NULL, "CoreImage creates the maximum-uint64 fixture image");
    SPCaptureFrameIdentity max_identity = { 0 };
    NSString *max_reason = nil;
    NSString *max_error = nil;
    BOOL max_decoded = max_image && testDecodeImage(max_image, roi, [NSSet setWithObject:max_payload],
        &max_identity, &max_reason, &max_error);
    check(max_decoded && max_identity.generation == UINT64_MAX && max_identity.raster == UINT64_MAX
        && max_identity.sequence == UINT64_MAX,
        "canonical uint64 maximum values decode without overflow or coercion");
    [max_reason release]; [max_error release]; if (max_image) CGImageRelease(max_image);
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
        CGRectMake(0, 0, 64, 64), @"0123456789abcdef0123456789abcdef", expected,
        &image, &instrumented, &payload, &error);
    check(!encoded && error != nil && image == NULL,
        "an ROI too small for QR modules and the quiet zone is explicitly rejected");
    [error release]; error = nil;

    image = NULL; instrumented = nil; payload = nil;
    encoded = sp_capture_frame_identity_encode(source.bytes, width, height, row_bytes, color_space,
        roi, @"invalid", expected, &image, &instrumented, &payload, &error);
    check(!encoded && error != nil && image == NULL && instrumented == nil && payload == nil,
        "invalid nonce input returns an explicit error and no partial owned outputs");
    CGColorSpaceRelease(color_space);
    [error release];
    fprintf(stderr, "%s: native capture frame identity\n", failures ? "FAIL" : "PASS");
    return failures ? 1 : 0;
} }
