#import "capture_frame_identity.h"
#import <CommonCrypto/CommonDigest.h>
#import <CoreImage/CoreImage.h>
#import <Vision/Vision.h>
#include <limits.h>
#include <math.h>
#include <string.h>

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

static bool validRaster(const uint8_t *bgra, size_t width, size_t height, size_t row_bytes) {
    return bgra && width && height && width <= SIZE_MAX / 4 && row_bytes >= width * 4
        && height <= SIZE_MAX / row_bytes && width <= INT_MAX && height <= INT_MAX;
}

static bool validROI(CGRect roi, size_t width, size_t height) {
    if (!isfinite(roi.origin.x) || !isfinite(roi.origin.y) || !isfinite(roi.size.width)
        || !isfinite(roi.size.height) || roi.size.width < 64 || roi.size.height < 64) return false;
    return roi.origin.x >= 0 && roi.origin.y >= 0 && CGRectGetMaxX(roi) <= width && CGRectGetMaxY(roi) <= height
        && floor(roi.origin.x) == roi.origin.x && floor(roi.origin.y) == roi.origin.y
        && floor(roi.size.width) == roi.size.width && floor(roi.size.height) == roi.size.height;
}

static NSString *unknown(NSString *reason) { return [reason copy]; }

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

    NSString *issued = payloadFor(nonce, identity);
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
    CGFloat side = MIN(roi.size.width, roi.size.height) - 8;
    CGRect inset = CGRectMake(roi.origin.x + (roi.size.width - side) / 2,
        roi.origin.y + (roi.size.height - side) / 2, side, side);
    CGContextSetInterpolationQuality(context, kCGInterpolationNone);
    CGContextDrawImage(context, inset, qrImage);
    CGImageRelease(qrImage);
    CGContextRelease(context);

    CGDataProviderRef provider = CGDataProviderCreateWithCFData((CFDataRef)pixels);
    if (!provider) {
        [pixels release];
        *error = [@"frame identity image data provider creation failed" copy];
        return false;
    }
    *image = CGImageCreate(width, height, 8, 32, row_bytes, color_space,
        kCGBitmapByteOrder32Little | kCGImageAlphaPremultipliedFirst, provider, NULL, false,
        kCGRenderingIntentDefault);
    CGDataProviderRelease(provider);
    if (!*image) {
        [pixels release];
        *error = [@"frame identity image creation failed" copy];
        return false;
    }
    *instrumented_bgra = pixels;
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
    NSError *visionError = nil;
    BOOL performed = [handler performRequests:@[ request ] error:&visionError];
    NSArray<VNBarcodeObservation *> *codes = [[request.results copy] autorelease];
    [request release];
    [handler release];
    if (!performed) {
        *error = [[NSString alloc] initWithFormat:@"Vision QR decode failed: %@", visionError.localizedDescription ?: @"unknown error"];
        return false;
    }
    if (codes.count != 1) { *unknown_reason = unknown(@"ambiguous-code-count"); return false; }
    VNBarcodeObservation *code = codes.firstObject;
    CGRect box = CGRectMake(code.boundingBox.origin.x * CGImageGetWidth(image),
        code.boundingBox.origin.y * CGImageGetHeight(image), code.boundingBox.size.width * CGImageGetWidth(image),
        code.boundingBox.size.height * CGImageGetHeight(image));
    if (!CGRectContainsRect(roi, box)) { *unknown_reason = unknown(@"code-outside-expected-roi"); return false; }
    NSString *value = code.payloadStringValue;
    if (!value) { *unknown_reason = unknown(@"payload-unreadable"); return false; }
    if (![issued_payloads containsObject:value]) { *unknown_reason = unknown(@"payload-unissued"); return false; }
    NSArray<NSString *> *fields = [value componentsSeparatedByString:@":"];
    if (fields.count != 7 || ![fields[0] isEqualToString:@"soksak-frame-id"] || ![fields[1] isEqualToString:@"v1"]
        || !validNonce(fields[2])) { *unknown_reason = unknown(@"payload-malformed"); return false; }
    NSScanner *scanner = nil;
    uint64_t values[3] = { 0 };
    for (NSUInteger index = 0; index < 3; index++) {
        NSString *field = fields[index + 3];
        if (!field.length || (field.length > 1 && [field hasPrefix:@"0"])) {
            *unknown_reason = unknown(@"payload-malformed"); return false;
        }
        scanner = [NSScanner scannerWithString:field];
        if (![scanner scanUnsignedLongLong:&values[index]] || !scanner.isAtEnd || !values[index]) {
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
