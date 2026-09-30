// 실제 API의 결과를 그대로 전달하며 시작·종료·대리자 콜백 순서를 기록한다.
#import "../src/capture.m"
#import <objc/runtime.h>

static IMP originalStart, originalStop, originalDelegate;
static id observedStream;
static unsigned events, starts, startReplies, stops, stopReplies, delegateStops;
static CFTimeInterval began;

static void record(NSString *event, id stream, NSError *error) {
    @synchronized([SPCapture class]) {
        fprintf(stderr, "LIFECYCLE %u +%.3fms %s stream=%p current=%d complete=%d queued=%d written=%d "
            "error-domain=%s error-code=%ld error=%s\n", ++events,
            (CACurrentMediaTime() - began) * 1000, event.UTF8String, stream, stream == captureStream,
            captureSink.complete, captureSink.queued, captureSink.written,
            error == nil ? "none" : error.domain.UTF8String, (long)error.code,
            error == nil ? "none" : error.localizedDescription.UTF8String);
    }
}

static void start(id stream, SEL selector, void (^completion)(NSError *)) {
    if (stream != captureStream) {
        ((void (*)(id, SEL, void (^)(NSError *)))originalStart)(stream, selector, completion); return;
    }
    observedStream = stream; starts++;
    record(@"start-request", stream, nil);
    ((void (*)(id, SEL, void (^)(NSError *)))originalStart)(stream, selector, ^(NSError *error) {
        startReplies++; record(@"start-completion", stream, error); completion(error);
    });
}

static void stop(id stream, SEL selector, void (^completion)(NSError *)) {
    if (stream != observedStream) {
        ((void (*)(id, SEL, void (^)(NSError *)))originalStop)(stream, selector, completion); return;
    }
    stops++; record(@"stop-request", stream, nil);
    ((void (*)(id, SEL, void (^)(NSError *)))originalStop)(stream, selector, ^(NSError *error) {
        stopReplies++; record(@"stop-completion", stream, error); completion(error);
    });
}

static void delegateStop(id sink, SEL selector, SCStream *stream, NSError *error) {
    delegateStops++; record(@"delegate-stop", stream, error);
    ((void (*)(id, SEL, SCStream *, NSError *))originalDelegate)(sink, selector, stream, error);
}

#define main captureAcceptanceMain
#import "capture_test.m"
#undef main

int main(void) {
    began = CACurrentMediaTime();
    fprintf(stderr, "START: real native capture lifecycle observation\n");
    Method startMethod = class_getInstanceMethod([SCStream class], @selector(startCaptureWithCompletionHandler:));
    Method stopMethod = class_getInstanceMethod([SCStream class], @selector(stopCaptureWithCompletionHandler:));
    Method delegateMethod = class_getInstanceMethod([SPCapture class], @selector(stream:didStopWithError:));
    if (startMethod == NULL || stopMethod == NULL || delegateMethod == NULL) {
        fprintf(stderr, "FAIL: capture lifecycle methods are unavailable\n"); return 1;
    }
    originalStart = method_setImplementation(startMethod, (IMP)start);
    originalStop = method_setImplementation(stopMethod, (IMP)stop);
    originalDelegate = method_setImplementation(delegateMethod, (IMP)delegateStop);
    int result = captureAcceptanceMain();
    method_setImplementation(startMethod, originalStart);
    method_setImplementation(stopMethod, originalStop);
    method_setImplementation(delegateMethod, originalDelegate);
    BOOL observed = starts == 1 && startReplies == 1 && stops == 1 && stopReplies == 1;
    fprintf(stderr, "%s: real capture lifecycle start=%u/%u stop=%u/%u delegate=%u acceptance=%d (%.1fms)\n",
        result == 0 && observed ? "PASS" : "FAIL", starts, startReplies, stops, stopReplies, delegateStops,
        result, (CACurrentMediaTime() - began) * 1000);
    return result == 0 && observed ? 0 : 1;
}
