// Window recording. frame-NNNN.bgra preserves the uint32 width, height, and row stride and seven float64 values
// (content x/y/width/height, content scale, device scale, and the display time in ms).
// An 80-byte header with the LZ4B marker, the uint32 compressed byte count, and the uint32 pixel CRC-32 follows,
// and a single LZ4 RAW block restores the intact BGRA pixels and row padding. The earlier raw format is rejected.
#include <stdbool.h>
// If display is true, the windows of this application are recorded from the display that holds the window. When the
// window moves to another Space (full screen), the window recording stops and the display recording continues to
// record that Space.
// The error of open/start is a required output pointer. Success sets NULL and failure sets a UTF-8 string that the
// caller releases with free(). A request during an active recording is rejected and does not change the recording
// state or error.
bool sp_capture_open(long windowNumber, bool display, char **error);
// Starts a recording in directory. frame_identity is an opt-in diagnostic request and fails explicitly until the
// capture identity session is installed. false preserves the ordinary recorded-frame path.
bool sp_capture_start(const char *directory, bool frame_identity, char **error);
const char *sp_capture_error(void);
int sp_capture_wait(void);
// Stops the recording after the screen of the later of the display time after (ms, mach absolute time) and the call
// time
// has been delivered to the stream, and returns the number of recorded frames. Callback evidence capacity
// exhaustion rejects further samples and reports an error. Check sp_capture_limited for this capacity failure.
// If the write queue capacity is exhausted, the recording fails. Stopping keeps both the earlier recording error and
// the
// stop error in sp_capture_error, so success is not judged by the returned frame count alone.
// A start timeout keeps its existing error and wait bound. A successful late start owns exactly one deferred
// native stop; failed starts request none. Deferred cleanup cannot change a replacement recording or finalized artifacts.
int sp_capture_stop(double after);
// Returns true if the last recording exhausted its callback evidence capacity.
bool sp_capture_limited(void);
// The longest display interval (ms) between consecutive completed frames of the last stopped recording. An interval
// longer than this holds a screen that was not recorded.
double sp_capture_longest_gap(void);
// The current time (ms), on the same clock as the display times of recorded frames. Used to compare the time an input
// was sent with the frames.
double sp_capture_clock(void);
// Takes one still of the window with window server number windowNumber without giving it focus and writes it to path
// as PNG.
// It produces observation material for visual inspection during development. Measurement uses recorded frames. On
// failure
// it returns false and stores an error string owned by the caller in error. On success error is NULL, and the caller
// releases the error string with free(). It is independent of recording errors, and the error output pointer is
// required.
bool sp_capture_still(long windowNumber, const char *path, char **error);

#ifdef SOKSAK_DIAGNOSTIC
// Injects a capture failure on the calling thread for lifecycle cleanup tests.
void sp_capture_test_report_error(const char *message);
// Simulates a startup failure that ends matcher state before reporting an error.
void sp_capture_test_report_startup_failure(const char *message);
#endif
