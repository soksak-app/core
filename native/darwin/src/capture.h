// Window recording as a series of stills. Each still is the image of the window and its child windows that the window server
// composited, taken with CGWindowListCreateImageFromArray (capture.m).
//
// A frame file frame-NNNN.bgra is named by the index of its still from 0 and holds three uint32 (width, height, row stride),
// eight float64 (content x/y/width/height, content scale, device scale, and the request time and the completion time of its
// still in ms on the clock of sp_capture_clock), the marker LZ4S, the uint32 compressed byte count and the uint32 CRC-32 of
// the pixels: 88 bytes. A single LZ4 RAW block follows and restores the intact BGRA pixels and row padding. A reader rejects
// a frame of another marker.
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/types.h>
// The error of every call that has one is a required output pointer. Success sets NULL and failure sets a UTF-8 string that
// the caller releases with free(). A request during an active recording is rejected and does not change the recording state
// or error.
//
// Prepares the recording of a window: the window and its child windows, or, if display is true, every window of this
// application on the display that holds the centre of the window. It fails without CGWindowListCreateImageFromArray
// (`CGWindowListCreateImageFromArray is not available on this macOS`) and for a window that the window server does not list
// on screen (`window <n> is not on screen`), except the held new window.
bool sp_capture_open(long windowNumber, bool display, char **error);
// The diagnostic recording of a new window from its first still (docs/spec/endpoint.md, diagnostics.capture.start newWindow).
// sp_capture_hold_new_window, on the main thread, holds the next show of a window that is not on screen (sp_window_show_hold_next)
// and fails while a recording runs or a hold is set. sp_capture_wait_new_window waits, off the main thread, until a show was held
// and returns the number of that window; the end of the wait of token (sp_capture_end_wait) ends the hold, puts a held window on
// screen and fails the wait with `no new window was shown before <reason>` in sp_capture_error, returning -1.
// sp_capture_open accepts the held window off the screen. sp_capture_start puts it on screen on the main thread and requests
// still 0 in the same main-thread step, after the order has committed, whether or not the still succeeds.
// sp_capture_release_new_window, from any thread, ends the hold at once: the caller calls it on every failure before the start.
bool sp_capture_hold_new_window(char **error);
long sp_capture_wait_new_window(uint64_t token);
void sp_capture_release_new_window(void);
// Starts a recording of the prepared window in directory and returns once still 0 is written; a failed still 0 fails the start
// with its error. gap is the time in ms from the request of one still to the request of the next, from 1 to 1000. The length
// is seconds, above 0 and at most 600, or frames, an integer from 1 to 4096: the other is 0. Still n is planned at the start
// plus n·gap and requested at its planned time whether or not the stills before it completed; a plan of more than 4096 stills
// is refused. The arguments are checked before the prepared window. The wait for still 0 ends by its outcome or by
// sp_capture_end_wait of token.
bool sp_capture_start(const char *directory, double gap, double seconds, int frames, uint64_t token, char **error);
const char *sp_capture_error(void);
// Ends the wait of the call of token with reason, from any thread: the call fails with its error `... before <reason>`. An
// end that comes before the call of token waits ends that call when it waits; an end for a call that returned changes nothing.
void sp_capture_end_wait(uint64_t token, const char *reason);
// Stops the recording and returns the number of written frames. With after above 0 (ms on the clock of sp_capture_clock), the
// recording continues until a still requested at or after after has completed; a plan that ends before such a request is an
// error of the stop. With after 0 it requests no later still. It then waits for every still already requested, writes
// stills.jsonl and display-link.json, and answers. The error of the recording and of the stop stay in sp_capture_error, so
// success is not judged by the returned frame count alone. The wait for after ends by that still, by the end of the
// recording, or by sp_capture_end_wait of token.
int sp_capture_stop(double after, uint64_t token);
// The number of planned stills of the last stopped recording without a written frame: failed, or not requested because of the
// stop.
int sp_capture_missed(void);
// The number of stills of the last stopped recording requested more than one gap after their planned time.
int sp_capture_late(void);
// The longest interval (ms) between the request times of two consecutive written frames of the last stopped recording.
double sp_capture_longest_gap(void);
// The current time (ms), on the same clock as the request and completion times of the stills.
double sp_capture_clock(void);
// Takes one still of a window and its child windows, the same image as a still of a recording, without giving the window focus,
// and writes it to path as PNG. It fails as sp_capture_open does, and when the window server gives no image.
bool sp_capture_still(long windowNumber, const char *path, char **error);

// The values of one display-link callback, as the callback reads them: the timestamp (a prior refresh), the target timestamp (a
// forecast) and the duration of CADisplayLink in seconds; CACurrentMediaTime() of the sample and the raw Mach ticks read before
// the callback and after the sample; the Mach timebase; and the values of the previous accepted observation, where a zero
// timebase or callback time means there is none.
typedef struct {
    double timestamp;
    double targetTimestamp;
    double duration;
    double mediaClockTime;
    uint64_t callbackTime;
    uint64_t mediaClockAfter;
    uint32_t timebaseNumerator;
    uint32_t timebaseDenominator;
    uint32_t previousTimebaseNumerator;
    uint32_t previousTimebaseDenominator;
    uint64_t previousTimestampMach;
    uint64_t previousCallbackTime;
} SPDisplayLinkSample;

// Whether the values of a callback are in order (valid), with the Mach ticks of its timestamp and target timestamp; both are 0
// when the values are not in order.
typedef struct {
    bool valid;
    uint64_t timestampMach;
    uint64_t targetMach;
} SPDisplayLinkDecision;

// Decides one display-link callback from its values. The values are data: no clock or window is read.
SPDisplayLinkDecision sp_capture_display_link_decision(SPDisplayLinkSample sample);

// The Darwin notification that ends the held requests of the capture fault points (SOKSAK_FAULT_CAPTURE_IMAGE and
// SOKSAK_FAULT_CAPTURE_ENCODE, capture.m). Darwin notifications reach every process, so the name carries the id of the process whose
// requests it ends: a test process that runs beside another one ends only its own held requests. 64 bytes hold every name.
static inline void sp_capture_fault_release_name(pid_t pid, char *name, size_t size) {
    snprintf(name, size, "app.soksak.capture.fault.release.%d", (int)pid);
}

// Injects a capture failure on the calling thread for lifecycle cleanup tests.
void sp_capture_test_report_error(const char *message);
