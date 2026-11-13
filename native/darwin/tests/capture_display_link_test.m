// Checks the decision of one display-link callback of a still recording (sp_capture_display_link_decision, capture.m) on timestamp
// data: a refresh converts to Mach ticks on the arm64 timebase (125/3) and on the Intel timebase (1/1), a callback that follows
// an earlier observation is accepted, and each ordering rule rejects a callback that breaks it. The values are the seconds and
// the ticks that the callback reads; no display, window or clock is read.
#import <Foundation/Foundation.h>
#import "capture.h"
#include <math.h>

static int failures;

static void check(bool ok, const char *label) {
    fprintf(stderr, "%s: %s\n", ok ? "PASS" : "FAIL", label);
    if (!ok) failures++;
}

// A callback on the arm64 timebase: the timestamp is 2.0 s (48000000 ticks), the target is one refresh of 60 Hz later, the
// callback is 1 ms after the timestamp (48024000 ticks), and the media clock sample reads 2.001 s (48024000 ticks) between the
// raw reads 48024000 and 48025000.
static SPDisplayLinkSample armSample(void) {
    return (SPDisplayLinkSample){
        .timestamp = 2.0,
        .targetTimestamp = 2.0 + 1.0 / 60.0,
        .duration = 1.0 / 60.0,
        .mediaClockTime = 2.001,
        .callbackTime = 48024000,
        .mediaClockAfter = 48025000,
        .timebaseNumerator = 125,
        .timebaseDenominator = 3,
    };
}

// The same callback on the Intel timebase, where one tick is one nanosecond.
static SPDisplayLinkSample intelSample(void) {
    return (SPDisplayLinkSample){
        .timestamp = 2.0,
        .targetTimestamp = 2.0 + 1.0 / 60.0,
        .duration = 1.0 / 60.0,
        .mediaClockTime = 2.001,
        .callbackTime = 2001000000,
        .mediaClockAfter = 2001001000,
        .timebaseNumerator = 1,
        .timebaseDenominator = 1,
    };
}

int main(void) { @autoreleasepool {
    CFTimeInterval began = [NSDate timeIntervalSinceReferenceDate];
    fprintf(stderr, "START: native capture display-link decision\n");

    SPDisplayLinkDecision arm = sp_capture_display_link_decision(armSample());
    check(arm.valid && arm.timestampMach == 48000000,
        "the arm64 timebase converts a 2.0 s timestamp to 48000000 ticks and accepts the callback");
    check(arm.valid && arm.targetMach - arm.timestampMach >= 399999 && arm.targetMach - arm.timestampMach <= 400001,
        "the arm64 target timestamp is one 60 Hz refresh (400000 ticks, within 1) after the timestamp");

    SPDisplayLinkDecision intel = sp_capture_display_link_decision(intelSample());
    check(intel.valid && intel.timestampMach == 2000000000,
        "the Intel timebase converts a 2.0 s timestamp to 2000000000 ticks and accepts the callback");
    check(intel.valid && intel.targetMach - intel.timestampMach >= 16666666 && intel.targetMach - intel.timestampMach <= 16666668,
        "the Intel target timestamp is one 60 Hz refresh (16666667 ticks, within 1) after the timestamp");

    SPDisplayLinkSample following = armSample();
    following.previousTimestampMach = 47000000;
    following.previousCallbackTime = 47500000;
    following.previousTimebaseNumerator = 125;
    following.previousTimebaseDenominator = 3;
    check(sp_capture_display_link_decision(following).valid,
        "a callback after an earlier observation on the same timebase is accepted");

    SPDisplayLinkSample sample = armSample();
    sample.targetTimestamp = sample.timestamp;
    SPDisplayLinkDecision rejected = sp_capture_display_link_decision(sample);
    check(!rejected.valid && rejected.timestampMach == 0 && rejected.targetMach == 0,
        "a target timestamp that is not after the timestamp is rejected, with no ticks reported");

    sample = armSample();
    sample.duration = 0;
    check(!sp_capture_display_link_decision(sample).valid, "a zero duration is rejected");

    sample = armSample();
    sample.timestamp = NAN;
    check(!sp_capture_display_link_decision(sample).valid, "a timestamp that is not finite is rejected");

    sample = armSample();
    sample.timestamp = 1.0e12;
    check(!sp_capture_display_link_decision(sample).valid,
        "a timestamp beyond the 64-bit tick range is rejected");

    sample = armSample();
    sample.callbackTime = 47999999;
    check(!sp_capture_display_link_decision(sample).valid,
        "a callback that precedes the converted timestamp is rejected");

    sample = armSample();
    sample.mediaClockAfter = 48023999;
    check(!sp_capture_display_link_decision(sample).valid,
        "a media clock read after the sample that ends before the callback is rejected");

    sample = armSample();
    sample.mediaClockTime = 2.0;
    check(!sp_capture_display_link_decision(sample).valid,
        "a media clock sample taken before the callback is rejected");

    sample = armSample();
    sample.mediaClockTime = 2.002;
    check(!sp_capture_display_link_decision(sample).valid,
        "a media clock sample later than the read after it is rejected");

    sample = armSample();
    sample.previousTimestampMach = 48000000;
    check(!sp_capture_display_link_decision(sample).valid,
        "a timestamp that is not after the timestamp of the previous observation is rejected");

    sample = armSample();
    sample.previousCallbackTime = 48024000;
    check(!sp_capture_display_link_decision(sample).valid,
        "a callback that is not after the callback of the previous observation is rejected");

    sample = armSample();
    sample.previousTimebaseNumerator = 1;
    sample.previousTimebaseDenominator = 1;
    check(!sp_capture_display_link_decision(sample).valid,
        "a change of the Mach timebase since the previous observation is rejected");

    sample = armSample();
    sample.timebaseNumerator = 0;
    check(!sp_capture_display_link_decision(sample).valid, "a Mach timebase with a zero numerator is rejected");

    fprintf(stderr, "%s: native capture display-link decision (%.1fms)\n", failures ? "FAIL" : "PASS",
        ([NSDate timeIntervalSinceReferenceDate] - began) * 1000);
    return failures ? 1 : 0;
}}
