#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

bool surfaceLayoutCommit(void *owner, uint64_t ticket);
// Returns whether owner has the active layout preparation. Call on the UI thread.
bool surfaceLayoutIsPreparing(void *owner);
// Returns whether a press at the point, in window coordinates, would reach another view once the open transaction of the
// window has reached the screen. The surface hosts give no hit target during a preparation, so such a press has no target yet.
bool surfaceLayoutPressWaits(void *owner, double x, double y);
// Lets the app DOM web view update rendering at the refresh interval of the display instead of being limited to about 60 fps.
// Returns false when WebKit does not have that feature.
bool surfaceLayoutRenderAtDisplayRate(void *webview);
// Returns 1 when the web view prefers rendering updates at about 60 fps, 0 when it does not, and -1 when the feature does not exist.
int surfaceLayoutPrefersNear60FPS(void *webview);
void surfaceLayoutCancel(void *owner);
// Cancels only the queued or active request with this owner and ticket. Completed or superseded tickets are unaffected.
void surfaceLayoutCancelTicket(void *owner, uint64_t ticket);
// Diagnostics only. Starts recording, for each layout transaction, the times of the begin, the app DOM presentation check, the commit, and the presentation check request
// (ms, the same mach clock as the recording frames). Clears the earlier recording.
void surfaceLayoutTraceStart(void);
// Number of values in the record of one transaction: ticket, begun, presented, committed, requested.
#define SURFACE_LAYOUT_TRACE_STAGES 5
// Stops recording and writes SURFACE_LAYOUT_TRACE_STAGES values per transaction to out, at most capacity values.
// A stage that did not occur is NaN. Returns the total number of transactions. The caller treats exceeding capacity as an error.
size_t surfaceLayoutTraceStop(double *out, size_t capacity);
// Diagnostics only. Records the time at which the presentation of the open transaction was requested and returns its ticket.
uint64_t surfaceLayoutTraceRequested(void);
// Diagnostics only. Records the time at which the presentation of the transaction of the ticket was confirmed.
void surfaceLayoutTracePresented(uint64_t ticket);
// The decision of the workbench about the keyboard (docs/spec/native-surfaces.md#keyboard-of-a-surface). surfaceLayoutKeyboardHold
// opens the hold of the input of owner: every later pointer and key event of the window waits, with the input that waits for a
// layout transaction, until surfaceLayoutKeyboardDecided, the end of the workbench or the close of the window ends the hold;
// time does not end it. A hold keeps up to 256 pieces of input. An open hold leaves the hold as it is. Call on the UI thread.
void surfaceLayoutKeyboardHold(void *owner);
void surfaceLayoutKeyboardDecided(void *owner);
bool surfaceLayoutKeyboardHeld(void *owner);
// Follows a left press and its release that pass to the views of owner, at the point in window coordinates, before they reach a
// view. The release of a press that began on the workbench opens the hold of the keyboard. Events that pass
// -[NSApplication sendEvent:] are followed by the library; a driver that delivers a press to a window directly calls it.
void surfaceLayoutPointerPassing(void *owner, bool down, double x, double y);
// Returns whether a left press of owner passed to its view and its release did not.
bool surfaceLayoutLeftPressPassed(void *owner);
#ifdef __BLOCKS__
// Registers once the test of a press on the workbench: a press at the point, in window coordinates, outside the surfaces of a
// window that holds a surface.
void surfaceLayoutObserveWorkbench(bool (^onWorkbench)(void *window, double x, double y));
void surfaceLayoutBegin(void *owner, uint64_t ticket, void (^ready)(int));
// Keeps an injected call behind the input of owner that waits and returns true, or returns false when it runs now. A press at the
// point, in window coordinates, waits as surfaceLayoutPressWaits says. The event loop of the application runs the call in its turn.
bool surfaceLayoutHoldCall(void *owner, bool press, double x, double y, void (^call)(void));
// Checks that the single app DOM is ready to present before committing an open layout.
void surfaceLayoutAfterPresentation(void *mainWebview, void (^done)(void));
// A block that brings the content of a window to the screen in its current state. It calls presented once on the main thread
// with NULL, or with the failure.
typedef void (^surfaceLayoutPresent)(void (^presented)(const char *error));
// Makes the block of a main web view, which reads the document and waits for the presentation update after that read. The
// result is autoreleased; surfaceLayoutAfterSettled keeps the block that it needs.
surfaceLayoutPresent surfaceLayoutMainPresentation(void *mainWebview);
// Calls done on the main thread when present has brought the content of window to the screen while window has no surface
// layout transaction that is open or waiting. present is asked again when a transaction opened meanwhile. displayed is the time
// (ms, mach absolute time) at which that presentation appears on the screen. When the window is not on the screen, it is the time
// of the call.
void surfaceLayoutAfterSettled(void *window, surfaceLayoutPresent present, void (^done)(double displayed, const char *error));
// Registers the observer of the layout transactions of the process and replaces the earlier one. started(window) runs on the
// main thread when a preparation of the window starts, before its ready. ended(window) runs on the main thread when the
// transaction of the window ends by its commit, deferred or not, or by its cancel, after the Core Animation transaction
// commits and before the next waiting transaction starts.
void surfaceLayoutObserve(void (^started)(void *window), void (^ended)(void *window));
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
// Joins the view webview to the open layout transaction of owner with ticket. The transaction does not commit until the
// joined view presents or the view is abandoned: the commit is deferred, and the next transaction of any window starts after
// the deferred commit. presented is called on the main thread once, when the view presents. Returns false when no transaction of
// owner with ticket is open or the transaction is already committing (docs/spec/plugin-processes.md, rule 6).
bool surfaceLayoutJoinView(void *owner, uint64_t ticket, void *viewWebview, void (^presented)(void));
// Ends the wait of the view webview for the transaction of owner without a presentation, so the deferred commit can finish.
// The presented callback of that join is not called afterward. Returns false when the view has no open join of owner.
bool surfaceLayoutAbandonView(void *owner, void *viewWebview);
// Returns the number of views that the open transactions of owner wait for. Used by the layout check.
size_t surfaceLayoutViewJoinCount(void *owner);
#endif
