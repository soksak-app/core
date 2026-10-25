// Recognizes recorded content through Vision without activating an application.
#import <Foundation/Foundation.h>
#import <Vision/Vision.h>
#import <CoreText/CoreText.h>
#include <errno.h>
#include <string.h>

static NSArray<NSString *> *recognize(CGImageRef image, NSString *language, NSError **error) {
    VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] init];
    request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
    request.usesLanguageCorrection = NO;
    NSArray *languages = [request supportedRecognitionLanguagesAndReturnError:error];
    if (!languages) return nil;
    if (![languages containsObject:language]) {
        *error = [NSError errorWithDomain:@"capture.text" code:1 userInfo:@{
            NSLocalizedDescriptionKey: [NSString stringWithFormat:@"unsupported recognition language %@", language]}];
        return nil;
    }
    request.recognitionLanguages = @[language];
    VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:image options:@{}];
    if (![handler performRequests:@[request] error:error]) return nil;
    NSMutableArray *lines = [NSMutableArray array];
    for (VNRecognizedTextObservation *observation in request.results) {
        VNRecognizedText *candidate = [[observation topCandidates:1] firstObject];
        if (candidate) [lines addObject:candidate.string];
    }
    return lines;
}

static BOOL dimension(const char *text, size_t *value) {
    if (!text[0] || strspn(text, "0123456789") != strlen(text)) return NO;
    errno = 0;
    unsigned long long number = strtoull(text, NULL, 10);
    if (errno || number == 0 || number > 64 * 1024 * 1024) return NO;
    *value = (size_t)number;
    return YES;
}

static int readCapture(int argc, const char **argv) {
    size_t width, height, stride;
    if (argc != 7 || strcmp(argv[1], "--bgra") != 0 || !dimension(argv[3], &width)
        || !dimension(argv[4], &height) || !dimension(argv[5], &stride)
        || width > SIZE_MAX / 4 || stride < width * 4 || height > (64 * 1024 * 1024) / stride) {
        fprintf(stderr, "error: expected --bgra FILE WIDTH HEIGHT STRIDE LANGUAGE within 64 MiB\n");
        return 2;
    }
    NSError *error = nil;
    NSData *data = [NSData dataWithContentsOfFile:@(argv[2]) options:0 error:&error];
    if (!data || data.length != height * stride) {
        fprintf(stderr, "error: invalid BGRA capture length or read failure: %s\n", error ? error.description.UTF8String : "dimensions do not match");
        return 2;
    }
    CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGDataProviderRef provider = CGDataProviderCreateWithCFData((__bridge CFDataRef)data);
    CGImageRef image = CGImageCreate(width, height, 8, 32, stride, space,
        kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little, provider, NULL, false, kCGRenderingIntentDefault);
    CGDataProviderRelease(provider);
    CGColorSpaceRelease(space);
    if (!image) { fprintf(stderr, "error: cannot create the captured image\n"); return 2; }
    NSArray *lines = recognize(image, @(argv[6]), &error);
    CGImageRelease(image);
    if (!lines) { fprintf(stderr, "error: %s\n", error.description.UTF8String); return 1; }
    NSData *json = [NSJSONSerialization dataWithJSONObject:@{@"lines": lines} options:0 error:&error];
    if (!json) { fprintf(stderr, "error: %s\n", error.description.UTF8String); return 1; }
    fwrite(json.bytes, 1, json.length, stdout);
    fputc('\n', stdout);
    return 0;
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc != 1) return readCapture(argc, argv);
        CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
        CGContextRef context = CGBitmapContextCreate(NULL, 1000, 120, 8, 4000, space,
            kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little);
        CGColorSpaceRelease(space);
        CGContextSetRGBFillColor(context, 1, 1, 1, 1);
        CGContextFillRect(context, CGRectMake(0, 0, 1000, 120));
        CGImageRef blankImage = CGBitmapContextCreateImage(context);
        NSError *blankError = nil;
        NSArray *blankLines = recognize(blankImage, @"en-US", &blankError);
        BOOL blankPassed = blankLines && blankLines.count == 0 && !blankError;
        CGImageRelease(blankImage);
        CTFontRef font = CTFontCreateWithName(CFSTR("Helvetica"), 48, NULL);
        NSDictionary *attributes = @{(__bridge NSString *)kCTFontAttributeName: (__bridge id)font};
        NSAttributedString *text = [[NSAttributedString alloc] initWithString:@"SOKSAK CONTENT CHECK" attributes:attributes];
        CTLineRef line = CTLineCreateWithAttributedString((__bridge CFAttributedStringRef)text);
        CGContextSetTextPosition(context, 20, 40);
        CTLineDraw(line, context);
        CGImageRef image = CGBitmapContextCreateImage(context);
        NSError *error = nil;
        NSArray *lines = recognize(image, @"en-US", &error);
        BOOL passed = blankPassed && !error && [[lines componentsJoinedByString:@" "] containsString:@"SOKSAK CONTENT CHECK"];
        NSError *unsupported = nil;
        NSArray *invalid = recognize(image, @"unsupported-language", &unsupported);
        size_t size = 0;
        passed = passed && !invalid && unsupported != nil
            && !dimension("0", &size) && !dimension("invalid", &size)
            && !dimension("99999999999999999999999999", &size);
        fprintf(stderr, "%s captured text recognition: %s\n", passed ? "PASS" : "FAIL", error ? error.description.UTF8String : lines.description.UTF8String);
        CGImageRelease(image);
        CFRelease(line);
        CFRelease(font);
        CGContextRelease(context);
        return passed ? 0 : 1;
    }
}
