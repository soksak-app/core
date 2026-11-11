// Window recording. frame-NNNN.bgra preserves the uint32 width, height, and row stride and seven float64 values
// (content x/y/width/height, content scale, device scale, and the display time in ms).
// An 80-byte header with the LZ4B marker, the uint32 compressed byte count, and the uint32 pixel CRC-32 follows,
// and a single LZ4 RAW block restores the intact BGRA pixels and row padding. The earlier raw format is rejected.
#include <stdbool.h>
#include <stdint.h>
// If display is true, the windows of this application are recorded from the display that holds the window. When the
// window moves to another Space (full screen), the window recording stops and the display recording continues to
// record that Space.
// The error of open/start is a required output pointer. Success sets NULL and failure sets a UTF-8 string that the
// caller releases with free(). A request during an active recording is rejected and does not change the recording
// state or error.
// Every call that waits for ScreenCaptureKit or for a frame takes token, a number that the caller gives no earlier call and that
// is larger than the token of every earlier call. No limit ends such a wait: it ends when its event comes or when
// sp_capture_end_wait ends the wait of its token, and an ended wait fails with `<what did not come> before <reason>`.
bool sp_capture_open(long windowNumber, bool display, uint64_t token, char **error);
// The diagnostic recording of a new window from its first frame (docs/spec/endpoint.md, diagnostics.capture.start newWindow).
// sp_capture_hold_new_window, on the main thread, holds the next show of a window that is not on screen (sp_window_show_hold_next)
// and fails while a recording runs or a hold is set. sp_capture_wait_new_window waits, off the main thread, until a show was held
// and returns the number of that window; the end of the wait of token (sp_capture_end_wait) ends the hold, puts a held window on
// screen and fails the wait with `no new window was shown before <reason>` in sp_capture_error, returning -1.
// sp_capture_open of the held window sizes the recording from the window, which the window server does not list yet, and the
// completion of the stream start of its recording, successful or not, puts the window on screen. sp_capture_release_new_window,
// from any thread, ends the hold at once: the caller calls it on every failure before the stream start.
bool sp_capture_hold_new_window(char **error);
long sp_capture_wait_new_window(uint64_t token);
void sp_capture_release_new_window(void);
// Starts a recording in directory. frame_identity is an opt-in diagnostic request and fails explicitly until the
// capture identity session is installed. false preserves the ordinary recorded-frame path.
bool sp_capture_start(const char *directory, bool frame_identity, char **error);
const char *sp_capture_error(void);
// Waits for the first written frame and for the completion of the stream start of the recording, and returns 1 once both
// came. The wait ends by that frame, by the end of the stream (its stop, the failure of its start or of its recording, the close
// of its window) or by sp_capture_end_wait of token.
int sp_capture_wait(uint64_t token);
// Ends the wait of the call of token with reason, from any thread: the call fails with its error `... before <reason>`. An
// end that comes before the call of token waits ends that call when it waits; an end for a call that returned changes nothing.
void sp_capture_end_wait(uint64_t token, const char *reason);
// Whether a native stream is currently owned by the capture module. False means no current stream; it does not
// establish that an earlier ScreenCaptureKit stop callback completed successfully.
bool sp_capture_has_stream(void);
// Stops the recording after the screen of the later of the display time after (ms, mach absolute time) and the call
// time
// has been delivered to the stream, and returns the number of recorded frames. Callback evidence capacity
// exhaustion rejects further samples and reports an error. Check sp_capture_limited for this capacity failure.
// If the write queue capacity is exhausted, the recording fails. Stopping keeps both the earlier recording error and
// the
// stop error in sp_capture_error, so success is not judged by the returned frame count alone.
// The stop waits for a callback at the boundary or for the end of the stream (see sp_capture_wait), then for the start
// completion and the stop completion, without a time limit; sp_capture_end_wait of token ends each of these waits. A start
// completion that has not come when the wait of token ends passes the stop to the late start callback, which owns exactly one
// deferred native stop; failed starts request none. Deferred cleanup cannot change a replacement recording or finalized
// artifacts.
int sp_capture_stop(double after, uint64_t token);
// Returns true if the last recording exhausted its callback evidence capacity.
bool sp_capture_limited(void);
// The longest display interval (ms) between consecutive completed frames of the last stopped recording. An interval
// longer than this holds a screen that was not recorded.
double sp_capture_longest_gap(void);
// The current time (ms), on the same clock as the display times of recorded frames. Used to compare the time an input
// was sent with the frames.
double sp_capture_clock(void);
// Takes one still of a window without giving it focus and writes it to path as PNG. windowNumbers holds count window
// server numbers: the window first, then its child windows, which the still shows in their places over it.
// It produces observation material for visual inspection during development. Measurement uses recorded frames. On
// failure it returns false and stores an error string owned by the caller in error. On success error is NULL, and the
// caller releases the error string with free(). It is independent of recording errors, and the error output pointer is
// required.
bool sp_capture_still(const long *windowNumbers, int count, const char *path, uint64_t token, char **error);

// Injects a capture failure on the calling thread for lifecycle cleanup tests.
void sp_capture_test_report_error(const char *message);
// Simulates a startup failure that ends matcher state before reporting an error.
void sp_capture_test_report_startup_failure(const char *message);
