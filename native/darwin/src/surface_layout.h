#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

bool surfaceLayoutCommit(void *owner, uint64_t ticket);
// Lets the app DOM web view update rendering at the refresh interval of the display instead of being limited to about 60 fps.
// Returns false when WebKit does not have that feature.
bool surfaceLayoutRenderAtDisplayRate(void *webview);
// Returns 1 when the web view prefers rendering updates at about 60 fps, 0 when it does not, and -1 when the feature does not exist.
int surfaceLayoutPrefersNear60FPS(void *webview);
void surfaceLayoutCancel(void *owner);
// Diagnostics only. Starts recording, for each layout transaction, the times of the begin, the app DOM presentation check, the commit, and the presentation check request
// (ms, the same mach clock as the recording frames). Clears the earlier recording.
void surfaceLayoutTraceStart(void);
// Number of values in the record of one transaction: ticket, begun, presented, committed, requested.
#define SURFACE_LAYOUT_TRACE_STAGES 5
// Stops recording and writes SURFACE_LAYOUT_TRACE_STAGES values per transaction to out, at most capacity values.
// A stage that did not occur is NaN. Returns the total number of transactions. The caller treats exceeding capacity as an error.
size_t surfaceLayoutTraceStop(double *out, size_t capacity);
#ifdef __BLOCKS__
void surfaceLayoutBegin(void *owner, uint64_t ticket, void (^ready)(int));
// Checks that the single app DOM is ready to present before committing an open layout.
void surfaceLayoutAfterPresentation(void *mainWebview, void (^done)(void));
// Calls done on the main thread when the single app DOM finishes presenting while the window of the main document has no
// open surface layout transaction. displayed is the time (ms, mach absolute time) at which that presentation appears on
// the screen. When the window is not on the screen, it is the time of the call.
void surfaceLayoutAfterSettled(void *mainWebview, void (^done)(double displayed, const char *error));
// Injects a failure into the next settled-presentation request. Diagnostic builds only.
void surfaceLayoutInjectSettledFailure(void);
// Sets the title bar to height (pt) when the new page of the window owner starts (docs/spec/native-surfaces.md#title-bar-height).
// A window that is not visible yet shows no previous page, so the height is set immediately. A visible window shows the
// previous page until the new page presents its first draw, so the function starts a layout transaction of the window
// with ticket, sets the height inside it, and commits that transaction at the next presentation update after the read of
// the registered main web view finishes. When a new preparation of the same window takes over the transaction in the
// meantime, that preparation commits it. When the height is set, the function calls ready(NULL) on the main thread; when
// it cannot be set, it cancels the transaction it started and calls ready(failure sentence) on the main thread.
// When the transaction of another window is open, ready is called after that transaction ends. Call on the main thread.
void surfaceLayoutStartPage(void *owner, uint64_t ticket, double height, void (^ready)(const char *failure));
#endif
