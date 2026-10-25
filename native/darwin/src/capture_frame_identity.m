#import "capture_frame_identity.h"
#import <CommonCrypto/CommonDigest.h>
#import <CoreImage/CoreImage.h>
#import <Vision/Vision.h>
#include <limits.h>
#include <math.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef SOKSAK_DIAGNOSTIC
static bool (*captureFrameIdentityDecodeTestHook)(void);
void sp_capture_frame_identity_test_set_decode_hook(bool (*hook)(void)) {
    captureFrameIdentityDecodeTestHook = hook;
}
#endif

static NSString *payloadPrefix(NSString *nonce, SPCaptureFrameIdentity identity) {
    return [NSString stringWithFormat:@"soksak-frame-id:v1:%@:%llu:%llu:%llu", nonce,
        (unsigned long long)identity.generation, (unsigned long long)identity.raster,
        (unsigned long long)identity.sequence];
}

static NSString *payloadFor(NSString *nonce, SPCaptureFrameIdentity identity) {
    NSData *bytes = [payloadPrefix(nonce, identity) dataUsingEncoding:NSUTF8StringEncoding];
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(bytes.bytes, (CC_LONG)bytes.length, digest);
    NSMutableString *hex = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
    for (NSUInteger index = 0; index < CC_SHA256_DIGEST_LENGTH; index++) [hex appendFormat:@"%02x", digest[index]];
    return [NSString stringWithFormat:@"%@:%@", payloadPrefix(nonce, identity), hex];
}

static bool validNonce(NSString *nonce) {
    if (nonce.length != 32) return false;
    NSCharacterSet *hex = [NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"];
    return [nonce rangeOfCharacterFromSet:hex.invertedSet].location == NSNotFound;
}

bool sp_capture_frame_identity_payload(NSString *nonce, SPCaptureFrameIdentity identity,
    NSString **payload, NSString **error) {
    if (payload) *payload = nil;
    if (error) *error = nil;
    if (!payload || !error || !validNonce(nonce) || !identity.generation || !identity.raster || !identity.sequence) {
        if (error) *error = [@"frame identity payload nonce or source identity is invalid" copy];
        return false;
    }
    *payload = [payloadFor(nonce, identity) copy];
    if (!*payload) {
        *error = [@"frame identity payload allocation failed" copy];
        return false;
    }
    return true;
}

static bool validRaster(const uint8_t *bgra, size_t width, size_t height, size_t row_bytes) {
    return bgra && width && height && width <= SIZE_MAX / 4 && row_bytes >= width * 4
        && height <= SIZE_MAX / row_bytes && width <= INT_MAX && height <= INT_MAX;
}

static bool validROI(CGRect roi, size_t width, size_t height) {
    if (!isfinite(roi.origin.x) || !isfinite(roi.origin.y) || !isfinite(roi.size.width)
        || !isfinite(roi.size.height) || roi.size.width < 1 || roi.size.height < 1) return false;
    return roi.origin.x >= 0 && roi.origin.y >= 0 && CGRectGetMaxX(roi) <= width && CGRectGetMaxY(roi) <= height
        && floor(roi.origin.x) == roi.origin.x && floor(roi.origin.y) == roi.origin.y
        && floor(roi.size.width) == roi.size.width && floor(roi.size.height) == roi.size.height;
}

static NSString *unknown(NSString *reason) { return [reason copy]; }

bool sp_capture_frame_identity_parse_canonical_uint64(NSString *field, uint64_t *value) {
    if (value) *value = 0;
    if (!value || ![field isKindOfClass:[NSString class]]) return false;
    if (!field.length || (field.length > 1 && [field hasPrefix:@"0"])) return false;
    for (NSUInteger index = 0; index < field.length; index++) {
        unichar character = [field characterAtIndex:index];
        if (character < '0' || character > '9') return false;
    }
    const char *text = field.UTF8String;
    errno = 0;
    char *end = NULL;
    unsigned long long parsed = strtoull(text, &end, 10);
    if (errno == ERANGE || !end || *end != '\0' || end == text) return false;
    char canonical[32];
    int count = snprintf(canonical, sizeof(canonical), "%llu", parsed);
    if (count < 0 || (NSUInteger)count != strlen(text) || memcmp(canonical, text, (size_t)count) != 0) return false;
    *value = (uint64_t)parsed;
    return *value != 0;
}

bool sp_capture_frame_identity_encode(const uint8_t *bgra, size_t width, size_t height, size_t row_bytes,
    CGColorSpaceRef color_space, CGRect roi, NSString *nonce, SPCaptureFrameIdentity identity,
    CGImageRef *image, NSData **instrumented_bgra, NSString **payload, NSString **error) {
    if (image) *image = NULL;
    if (instrumented_bgra) *instrumented_bgra = nil;
    if (payload) *payload = nil;
    if (error) *error = nil;
    if (!image || !instrumented_bgra || !payload || !error || !validRaster(bgra, width, height, row_bytes)
        || !color_space || !validNonce(nonce) || !identity.generation || !identity.raster || !identity.sequence
        || !validROI(roi, width, height)) {
        if (error) *error = [@"frame identity encode arguments are invalid" copy];
        return false;
    }

    NSString *issuedOwned = nil;
    NSString *payloadError = nil;
    if (!sp_capture_frame_identity_payload(nonce, identity, &issuedOwned, &payloadError)) {
        *error = payloadError;
        return false;
    }
    NSString *issued = [issuedOwned autorelease];
    CIFilter *filter = [CIFilter filterWithName:@"CIQRCodeGenerator"];
    if (!filter) { *error = [@"CoreImage QR generator is unavailable" copy]; return false; }
    [filter setValue:[issued dataUsingEncoding:NSUTF8StringEncoding] forKey:@"inputMessage"];
    [filter setValue:@"H" forKey:@"inputCorrectionLevel"];
    CIImage *qr = filter.outputImage;
    if (!qr) { *error = [@"CoreImage QR generator returned no image" copy]; return false; }

    NSMutableData *pixels = [[NSMutableData alloc] initWithLength:row_bytes * height];
    if (!pixels) { *error = [@"frame identity raster allocation failed" copy]; return false; }
    memcpy(pixels.mutableBytes, bgra, pixels.length);
    CGContextRef context = CGBitmapContextCreate(pixels.mutableBytes, width, height, 8, row_bytes, color_space,
        kCGBitmapByteOrder32Little | kCGImageAlphaPremultipliedFirst);
    if (!context) {
        [pixels release];
        *error = [@"frame identity bitmap context creation failed" copy];
        return false;
    }
    CIContext *ciContext = [CIContext contextWithOptions:@{ kCIContextWorkingColorSpace: (__bridge id)color_space }];
    CGImageRef qrImage = [ciContext createCGImage:qr fromRect:qr.extent];
    if (!qrImage) {
        CGContextRelease(context);
        [pixels release];
        *error = [@"CoreImage QR rasterization failed" copy];
        return false;
    }
    size_t module_width = CGImageGetWidth(qrImage);
    size_t module_height = CGImageGetHeight(qrImage);
    const size_t quiet_modules = 4;
    if (!module_width || module_width != module_height || module_width > SIZE_MAX - quiet_modules * 2) {
        CGImageRelease(qrImage);
        CGContextRelease(context);
        [pixels release];
        *error = [@"CoreImage QR generator returned invalid module dimensions" copy];
        return false;
    }
    size_t total_modules = module_width + quiet_modules * 2;
    size_t scale = (size_t)floor(MIN(roi.size.width, roi.size.height) / total_modules);
    if (!scale) {
        CGImageRelease(qrImage);
        CGContextRelease(context);
        [pixels release];
        *error = [@"frame identity ROI cannot fit QR modules and four-module quiet zone" copy];
        return false;
    }
    CGFloat total_side = (CGFloat)(total_modules * scale);
    CGFloat code_side = (CGFloat)(module_width * scale);
    CGFloat left = roi.origin.x + floor((roi.size.width - total_side) / 2);
    CGFloat top = roi.origin.y + floor((roi.size.height - total_side) / 2);
    CGRect fullRect = CGRectMake(left, (CGFloat)height - top - total_side, total_side, total_side);
    CGRect codeRect = CGRectInset(fullRect, (CGFloat)(quiet_modules * scale), (CGFloat)(quiet_modules * scale));
    CGContextSetBlendMode(context, kCGBlendModeCopy);
    CGContextSetRGBFillColor(context, 1, 1, 1, 1);
    CGContextFillRect(context, fullRect);
    CGContextSetInterpolationQuality(context, kCGInterpolationNone);
    if (codeRect.size.width != code_side || codeRect.size.height != code_side) {
        CGImageRelease(qrImage);
        CGContextRelease(context);
        [pixels release];
        *error = [@"frame identity QR module geometry is not integral" copy];
        return false;
    }
    CGContextDrawImage(context, codeRect, qrImage);
    CGImageRelease(qrImage);
    CGContextRelease(context);

    NSData *immutablePixels = [pixels copy];
    [pixels release];
    if (!immutablePixels) {
        *error = [@"frame identity immutable raster copy failed" copy];
        return false;
    }
    CGDataProviderRef provider = CGDataProviderCreateWithCFData((CFDataRef)immutablePixels);
    if (!provider) {
        [immutablePixels release];
        *error = [@"frame identity image data provider creation failed" copy];
        return false;
    }
    *image = CGImageCreate(width, height, 8, 32, row_bytes, color_space,
        kCGBitmapByteOrder32Little | kCGImageAlphaPremultipliedFirst, provider, NULL, false,
        kCGRenderingIntentDefault);
    CGDataProviderRelease(provider);
    if (!*image) {
        [immutablePixels release];
        *error = [@"frame identity image creation failed" copy];
        return false;
    }
    *instrumented_bgra = immutablePixels;
    *payload = [issued copy];
    return true;
}

bool sp_capture_frame_identity_decode(CGImageRef image, CGRect roi, NSSet<NSString *> *issued_payloads,
    SPCaptureFrameIdentity *identity, NSString **unknown_reason, NSString **error) {
    if (identity) memset(identity, 0, sizeof(*identity));
    if (unknown_reason) *unknown_reason = nil;
    if (error) *error = nil;
    if (!image || !issued_payloads || !identity || !unknown_reason || !error
        || !validROI(roi, CGImageGetWidth(image), CGImageGetHeight(image))) {
        if (error) *error = [@"frame identity decode arguments are invalid" copy];
        return false;
    }
    VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:image options:@{}];
    VNDetectBarcodesRequest *request = [[VNDetectBarcodesRequest alloc] init];
    request.symbologies = @[ VNBarcodeSymbologyQR ];
    CGRect visionROI = CGRectMake(roi.origin.x / CGImageGetWidth(image),
        (CGImageGetHeight(image) - CGRectGetMaxY(roi)) / CGImageGetHeight(image),
        roi.size.width / CGImageGetWidth(image), roi.size.height / CGImageGetHeight(image));
    request.regionOfInterest = visionROI;
    NSError *visionError = nil;
#ifdef SOKSAK_DIAGNOSTIC
    if (captureFrameIdentityDecodeTestHook && !captureFrameIdentityDecodeTestHook()) {
        [request release];
        [handler release];
        *error = [@"Vision QR decode test failure" copy];
        return false;
    }
#endif
    BOOL performed = [handler performRequests:@[ request ] error:&visionError];
    NSArray<VNBarcodeObservation *> *codes = [[request.results copy] autorelease];
    [request release];
    [handler release];
    if (!performed) {
        *error = [[NSString alloc] initWithFormat:@"Vision QR decode failed: %@", visionError.localizedDescription ?: @"unknown error"];
        return false;
    }
    if (codes.count == 0) { *unknown_reason = unknown(@"no-code-in-expected-roi"); return false; }
    if (codes.count > 1) { *unknown_reason = unknown(@"ambiguous-code-count"); return false; }
    VNBarcodeObservation *code = codes.firstObject;
    CGRect lowerLeftBox = VNImageRectForNormalizedRectUsingRegionOfInterest(code.boundingBox,
        CGImageGetWidth(image), CGImageGetHeight(image), visionROI);
    CGRect box = CGRectMake(lowerLeftBox.origin.x,
        CGImageGetHeight(image) - CGRectGetMaxY(lowerLeftBox), lowerLeftBox.size.width, lowerLeftBox.size.height);
    if (!CGRectContainsRect(roi, box)) { *unknown_reason = unknown(@"code-outside-expected-roi"); return false; }
    NSString *value = code.payloadStringValue;
    if (!value) { *unknown_reason = unknown(@"payload-unreadable"); return false; }
    if (![issued_payloads containsObject:value]) { *unknown_reason = unknown(@"payload-unissued"); return false; }
    NSArray<NSString *> *fields = [value componentsSeparatedByString:@":"];
    if (fields.count != 7 || ![fields[0] isEqualToString:@"soksak-frame-id"] || ![fields[1] isEqualToString:@"v1"]
        || !validNonce(fields[2])) { *unknown_reason = unknown(@"payload-malformed"); return false; }
    uint64_t values[3] = { 0 };
    for (NSUInteger index = 0; index < 3; index++) {
        if (!sp_capture_frame_identity_parse_canonical_uint64(fields[index + 3], &values[index])) {
            *unknown_reason = unknown(@"payload-malformed"); return false;
        }
    }
    NSString *prefix = [NSString stringWithFormat:@"%@:%@:%@:%@:%@:%@", fields[0], fields[1], fields[2],
        fields[3], fields[4], fields[5]];
    NSData *data = [prefix dataUsingEncoding:NSUTF8StringEncoding];
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
    NSMutableString *hex = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
    for (NSUInteger index = 0; index < CC_SHA256_DIGEST_LENGTH; index++) [hex appendFormat:@"%02x", digest[index]];
    if (![fields[6] isEqualToString:hex]) {
        *unknown_reason = unknown(@"payload-checksum-invalid"); return false;
    }
    identity->generation = values[0]; identity->raster = values[1]; identity->sequence = values[2];
    return true;
}
