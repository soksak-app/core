// Recognizes recorded content through Vision without activating an application.
#import <Foundation/Foundation.h>
#import <Vision/Vision.h>
#import <CoreText/CoreText.h>
#import <CoreML/CoreML.h>
#include <errno.h>
#include <string.h>

// The exit status and error code of a failure that Vision reports for a request. It is apart from text that is not found
// (status 1) and from invalid input (status 2): the system recognizer did not read the image, so nothing is known of its text.
enum { RecognizerFailed = 3 };

// Performs the requests of one image. Vision performs them; the default invocation replaces it to check the stated failure.
typedef BOOL (^PerformRequests)(VNImageRequestHandler *handler, NSArray<VNRequest *> *requests, NSError **error);

static PerformRequests const performWithVision = ^BOOL(VNImageRequestHandler *handler, NSArray<VNRequest *> *requests, NSError **error) {
    return [handler performRequests:requests error:error];
};

static NSError *recognizerFailure(NSError *cause) {
    NSString *reason = cause ? cause.description : @"Vision returned no error";
    NSMutableDictionary *info = [NSMutableDictionary dictionaryWithObject:
        [NSString stringWithFormat:@"the system text recognizer failed: %@", reason] forKey:NSLocalizedDescriptionKey];
    if (cause) info[NSUnderlyingErrorKey] = cause;
    return [NSError errorWithDomain:@"capture.text" code:RecognizerFailed userInfo:info];
}

static BOOL isRecognizerFailure(NSError *error) {
    return [error.domain isEqualToString:@"capture.text"] && error.code == RecognizerFailed;
}

static VNRecognizeTextRequest *textRequest(void) {
    VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] init];
    request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
    request.usesLanguageCorrection = NO;
    return request;
}

// Observe public capabilities without performing inference or assigning a compute device.
// Real captured-pixel requests use this same factory with the original Vision device-selection semantics.
static int computeDevices(void) {
    VNRecognizeTextRequest *request = textRequest();
    NSError *error = nil;
    NSDictionary *supported = [request supportedComputeStageDevicesAndReturnError:&error];
    if (!supported || supported.count == 0) {
        fprintf(stderr, "error: no supported Vision compute stages: %s\n", error ? error.description.UTF8String : "empty device map");
        return RecognizerFailed;
    }
    NSMutableDictionary *stages = [NSMutableDictionary dictionary];
    for (VNComputeStage stage in supported) {
        NSMutableArray *devices = [NSMutableArray array];
        for (id<MLComputeDeviceProtocol> device in supported[stage]) {
            if ([device isKindOfClass:MLCPUComputeDevice.class]) [devices addObject:@"cpu"];
            else if ([device isKindOfClass:MLGPUComputeDevice.class]) [devices addObject:@"gpu"];
            else if ([device isKindOfClass:MLNeuralEngineComputeDevice.class]) [devices addObject:@"neuralEngine"];
            else {
                fprintf(stderr, "error: unsupported Vision compute device %s\n", NSStringFromClass([device class]).UTF8String);
                return RecognizerFailed;
            }
        }
        stages[stage] = devices;
    }
    NSData *data = [NSJSONSerialization dataWithJSONObject:@{
        @"recognitionLevel": request.recognitionLevel == VNRequestTextRecognitionLevelAccurate ? @"accurate" : @"fast",
        @"recognitionLanguages": request.recognitionLanguages, @"usesLanguageCorrection": @(request.usesLanguageCorrection),
        @"revision": @(request.revision), @"stages": stages
    } options:NSJSONWritingSortedKeys error:&error];
    if (!data) {
        fprintf(stderr, "error: compute device report: %s\n", error.description.UTF8String);
        return RecognizerFailed;
    }
    printf("%s\n", [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
    return 0;
}

static NSArray<NSString *> *recognize(CGImageRef image, NSString *language, PerformRequests perform, NSError **error) {
    VNRecognizeTextRequest *request = textRequest();
    NSError *cause = nil;
    NSArray *languages = [request supportedRecognitionLanguagesAndReturnError:&cause];
    if (!languages) {
        *error = recognizerFailure(cause);
        return nil;
    }
    if (![languages containsObject:language]) {
        *error = [NSError errorWithDomain:@"capture.text" code:1 userInfo:@{
            NSLocalizedDescriptionKey: [NSString stringWithFormat:@"unsupported recognition language %@", language]}];
        return nil;
    }
    request.recognitionLanguages = @[language];
    VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:image options:@{}];
    if (!perform(handler, @[request], &cause)) {
        *error = recognizerFailure(cause);
        return nil;
    }
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
    NSArray *lines = recognize(image, @(argv[6]), performWithVision, &error);
    CGImageRelease(image);
    if (!lines) {
        fprintf(stderr, "error: %s\n", error.localizedDescription.UTF8String);
        return isRecognizerFailure(error) ? RecognizerFailed : 1;
    }
    NSData *json = [NSJSONSerialization dataWithJSONObject:@{@"lines": lines} options:0 error:&error];
    if (!json) { fprintf(stderr, "error: %s\n", error.description.UTF8String); return 1; }
    fwrite(json.bytes, 1, json.length, stdout);
    fputc('\n', stdout);
    return 0;
}

// A failure that Vision reports, with or without an error, is the stated recognizer failure that keeps its cause.
static BOOL statesRecognizerFailure(CGImageRef image) {
    NSError *cause = [NSError errorWithDomain:@"capture.text.check" code:13 userInfo:@{
        NSLocalizedDescriptionKey: @"injected recognizer failure"}];
    NSError *reported = nil;
    NSArray *lines = recognize(image, @"en-US", ^BOOL(VNImageRequestHandler *handler, NSArray *requests, NSError **error) {
        *error = cause;
        return NO;
    }, &reported);
    NSError *silent = nil;
    NSArray *silentLines = recognize(image, @"en-US", ^BOOL(VNImageRequestHandler *handler, NSArray *requests, NSError **error) {
        return NO;
    }, &silent);
    BOOL stated = !lines && isRecognizerFailure(reported) && reported.userInfo[NSUnderlyingErrorKey] == cause
        && [reported.localizedDescription hasPrefix:@"the system text recognizer failed: "]
        && [reported.localizedDescription containsString:@"injected recognizer failure"]
        && !silentLines && isRecognizerFailure(silent)
        && [silent.localizedDescription isEqualToString:@"the system text recognizer failed: Vision returned no error"];
    fprintf(stderr, "%s the system text recognizer failed is stated: %s | %s\n", stated ? "PASS" : "FAIL",
        reported ? reported.localizedDescription.UTF8String : "no error", silent ? silent.localizedDescription.UTF8String : "no error");
    return stated;
}

// A white 1000 by 120 image context.
static CGContextRef whiteContext(void) {
    CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef context = CGBitmapContextCreate(NULL, 1000, 120, 8, 4000, space,
        kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little);
    CGColorSpaceRelease(space);
    CGContextSetRGBFillColor(context, 1, 1, 1, 1);
    CGContextFillRect(context, CGRectMake(0, 0, 1000, 120));
    return context;
}

// The image of the context after the text is drawn into it.
static CGImageRef drawnText(CGContextRef context, NSString *string) {
    CTFontRef font = CTFontCreateWithName(CFSTR("Helvetica"), 48, NULL);
    NSDictionary *attributes = @{(__bridge NSString *)kCTFontAttributeName: (__bridge id)font};
    NSAttributedString *text = [[NSAttributedString alloc] initWithString:string attributes:attributes];
    CTLineRef line = CTLineCreateWithAttributedString((__bridge CFAttributedStringRef)text);
    CGContextSetTextPosition(context, 20, 40);
    CTLineDraw(line, context);
    CFRelease(line);
    CFRelease(font);
    [text release];
    return CGBitmapContextCreateImage(context);
}

// Prepares the text recognition model of each language before a check measures recognition. The first recognition of a language in
// the cache of the executable compiles the model of the system, which takes minutes and can fail in the process that compiled it, so a
// check runs this in a process of its own under a limit of its own and then recognizes in a new process.
static int warm(int argc, const char **argv) {
    if (argc < 3) {
        fprintf(stderr, "error: expected --warm LANGUAGE...\n");
        return 2;
    }
    CGContextRef context = whiteContext();
    CGImageRef image = drawnText(context, @"SOKSAK CONTENT CHECK");
    CGContextRelease(context);
    int status = 0;
    for (int index = 2; index < argc && status == 0; index++) {
        NSDate *started = [NSDate date];
        NSError *error = nil;
        if (recognize(image, @(argv[index]), performWithVision, &error)) {
            fprintf(stderr, "warmed %s in %.3fs\n", argv[index], -started.timeIntervalSinceNow);
        } else {
            fprintf(stderr, "error: %s\n", error.localizedDescription.UTF8String);
            status = isRecognizerFailure(error) ? RecognizerFailed : 2;
        }
    }
    CGImageRelease(image);
    return status;
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc == 2 && strcmp(argv[1], "--compute-devices") == 0) return computeDevices();
        if (argc >= 2 && strcmp(argv[1], "--warm") == 0) return warm(argc, argv);
        if (argc != 1) return readCapture(argc, argv);
        CGContextRef context = whiteContext();
        CGImageRef blankImage = CGBitmapContextCreateImage(context);
        BOOL stated = statesRecognizerFailure(blankImage);
        NSError *blankError = nil;
        NSArray *blankLines = recognize(blankImage, @"en-US", performWithVision, &blankError);
        BOOL blankPassed = blankLines && blankLines.count == 0 && !blankError;
        CGImageRelease(blankImage);
        CGImageRef image = drawnText(context, @"SOKSAK CONTENT CHECK");
        NSError *error = nil;
        NSArray *lines = recognize(image, @"en-US", performWithVision, &error);
        NSError *unsupported = nil;
        NSArray *invalid = recognize(image, @"unsupported-language", performWithVision, &unsupported);
        size_t size = 0;
        BOOL parsed = !dimension("0", &size) && !dimension("invalid", &size) && !dimension("99999999999999999999999999", &size);
        CGImageRelease(image);
        CGContextRelease(context);
        // A request that Vision did not perform states that failure; it is not a recognition result of this check.
        NSError *systemFailure = isRecognizerFailure(blankError) ? blankError
            : isRecognizerFailure(error) ? error : isRecognizerFailure(unsupported) ? unsupported : nil;
        if (systemFailure) {
            fprintf(stderr, "FAIL error: %s\n", systemFailure.localizedDescription.UTF8String);
            return RecognizerFailed;
        }
        BOOL passed = stated && blankPassed && !error && [[lines componentsJoinedByString:@" "] containsString:@"SOKSAK CONTENT CHECK"]
            && !invalid && unsupported != nil && parsed;
        fprintf(stderr, "%s captured text recognition: %s\n", passed ? "PASS" : "FAIL", error ? error.description.UTF8String : lines.description.UTF8String);
        return passed ? 0 : 1;
    }
}
