#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

bool surfaceLayoutCommit(void *owner, uint64_t ticket);
// Returns whether owner has an open layout transaction. Call on the UI thread.
bool surfaceLayoutIsPreparing(void *owner);
// Returns whether a press at the point, in window coordinates, would reach another view once the open transaction of the
// window has reached the screen. The surface hosts give no hit target during a preparation, so such a press has no target yet.
bool surfaceLayoutPressWaits(void *owner, double x, double y);
// Lets the app DOM web view update rendering at the refresh interval of the display instead of being limited to about 60 fps.
// Returns false when WebKit does not have that feature.
bool surfaceLayoutRenderAtDisplayRate(void *webview);
// Returns 1 when the web view prefers rendering updates at about 60 fps, 0 when it does not, and -1 when the feature does not exist.
int surfaceLayoutPrefersNear60FPS(void *webview);
// Cancels the open transaction of owner and refuses its waiting preparations. The will-close of a window cancels it too.
void surfaceLayoutCancel(void *owner);
// Cancels only the queued or active request with this owner and ticket. Completed or superseded tickets are unaffected.
void surfaceLayoutCancelTicket(void *owner, uint64_t ticket);
// Diagnostics only. Starts recording, for each layout transaction, the times of the begin, the app DOM presentation check, the commit, and the presentation check request
// (ms, the same mach clock as the recording frames), the path that committed it, and how many of the CATransaction pairs of this
// code besides the layout transaction were open at its commit. Clears the earlier recording. While it records, the owner of
// every layout transaction that commits is a window (NSWindow), whose screen gives the display refresh of the commit; without a
// recording an owner is any pointer that names the transactions of one window.
void surfaceLayoutTraceStart(void);
// Number of values in the record of one transaction: ticket, begun, presented, committed, requested, commit path, open at commit,
// flushed, displayed, refreshed. Committed is the commit of the layout transaction; flushed is the end of the commit of the
// outermost Core Animation transaction of the thread that carried it to the render server, which is later when the commit was
// nested in another one; displayed is the display refresh that carried it, the target time of the refresh that follows the first
// refresh callback of the display of its window after the flush (CADisplayLink targetTimestamp); refreshed is the time of the
// refresh that came before that callback (CADisplayLink timestamp).
#define SURFACE_LAYOUT_TRACE_STAGES 10
// The commit path of a transaction in its record: the presentation of the host, the start transaction of a new page, the
// presentation of the last joined view, the abandon or close of the last joined view, a cancel, or a press or key event that
// ended the hold.
#define SURFACE_LAYOUT_COMMIT_PRESENT 1
#define SURFACE_LAYOUT_COMMIT_START 2
#define SURFACE_LAYOUT_COMMIT_VIEW_JOIN 3
#define SURFACE_LAYOUT_COMMIT_VIEW_ABANDON 4
#define SURFACE_LAYOUT_COMMIT_CANCEL 5
#define SURFACE_LAYOUT_COMMIT_INPUT 6
// Every CATransaction pair of this code opens and closes through these, so the layout trace can say how many were open when a
// layout transaction committed.
void surfaceTransactionBegin(void);
void surfaceTransactionCommit(void);
// Stops recording and writes SURFACE_LAYOUT_TRACE_STAGES values per transaction to out, at most capacity values.
// A stage that did not occur is NaN. Returns the total number of transactions. The caller treats exceeding capacity as an error.
size_t surfaceLayoutTraceStop(double *out, size_t capacity);
// Diagnostics only. Records the time at which the presentation of the open transaction was requested and returns its ticket.
uint64_t surfaceLayoutTraceRequested(void);
// Diagnostics only. Records the time at which the presentation of the transaction of the ticket was confirmed.
void surfaceLayoutTracePresented(uint64_t ticket);
// Diagnostics only. The display refresh of a transaction sent to the render server at flushed (ms), read from a refresh callback whose
// refresh came at timestamp and whose next refresh comes at target (ms): refreshed is the first refresh at or after flushed on the
// grid of that callback, and displayed the refresh that follows it, whenever the callback was delivered.
void surfaceLayoutTraceRefresh(double flushed, double timestamp, double target, double *refreshed, double *displayed);
// The key wait of a window (docs/spec/native-surfaces.md#keyboard-of-a-surface). The release of a left press on the workbench of a
// window opens the wait for the decision of the workbench, and surfaceLayoutKeysWaitForModal opens the wait for a modal web view
// that takes the keyboard. Only keys wait, in their order, while either waits; a press of the window ends the wait for the
// decision and gives the keys to the view that holds the keyboard before the press. No pointer event waits, and no time or count
// ends a wait. The close of the window drops the keys and records native.keyboard.wait_dropped. Call on the UI thread.
// surfaceLayoutKeysDecided ends the wait for the decision, at a decided call or at the end of the workbench: the keys go in
// their order to the view that holds the keyboard once the modal does not wait either. A window without a wait changes nothing.
void surfaceLayoutKeysDecided(void *owner);
void surfaceLayoutKeysWaitForModal(void *owner);
// Whether the keys of owner wait for a modal.
bool surfaceLayoutKeysModalWaits(void *owner);
// Ends the wait for the modal, after the modal took the keyboard or when it closed or failed before that.
void surfaceLayoutKeysModalEnded(void *owner);
// Follows a left press and its release that pass to the views of owner, at the point in window coordinates, before they reach a
// view. The release of a press that began on the workbench opens the wait for the decision. Events that pass
// -[NSApplication sendEvent:] are followed by the library; a driver that delivers a press to a window directly calls it.
void surfaceLayoutPointerPassing(void *owner, bool down, double x, double y);
#ifdef __BLOCKS__
// Registers once the test of a press on the workbench: a press at the point, in window coordinates, outside the surfaces of a
// window that holds a surface.
void surfaceLayoutObserveWorkbench(bool (^onWorkbench)(void *window, double x, double y));
void surfaceLayoutBegin(void *owner, uint64_t ticket, void (^ready)(int));
#ifdef __OBJC__
@class NSEvent;
// Adds an observer of the actions of the user: observer(event) runs on the main thread for every press (a mouse down of any
// button) and every key event (key down, key up, modifier change) that reaches -[NSApplication sendEvent:], a synthetic event
// sent through it included, before any monitor, gate or view sees the event, and once for each event: an event that a wait kept
// is not told again when it comes back. The end of the layout hold is one observer
// (docs/spec/native-surfaces.md#layout-transaction). An observer stays for the life of the process.
void surfaceInputActionObserve(void (^observer)(NSEvent *event));
#endif
// Keeps an injected pointer call behind the input of owner that waits and returns true, or returns false when it runs now. A press
// at the point, in window coordinates, waits as surfaceLayoutPressWaits says, and a press ends the wait of the keys for the
// decision and runs after the keys that waited. The event loop of the application runs the call in its turn.
bool surfaceLayoutHoldCall(void *owner, bool press, double x, double y, void (^call)(void));
// Keeps an injected key call behind the input of owner that waits, the keys of the key wait included, and returns true, or
// returns false when it runs now. dropped runs instead of call when the close of the window drops the key.
bool surfaceLayoutHoldKey(void *owner, void (^call)(void), void (^dropped)(void));
// Checks that the single app DOM is ready to present before committing an open layout.
void surfaceLayoutAfterPresentation(void *mainWebview, void (^done)(void));
// A block that brings the content of a window to the screen in its current state. It calls presented once on the main thread
// with NULL, or with the failure.
typedef void (^surfaceLayoutPresent)(void (^presented)(const char *error));
// Makes the block of a main web view, which reads the document and waits for the presentation update after that read. The
// result is autoreleased; surfaceLayoutAfterSettled keeps the block that it needs.
surfaceLayoutPresent surfaceLayoutMainPresentation(void *mainWebview);
// Calls done on the main thread when present has brought the content of window to the screen while no surface layout
// transaction holds the screen: the hold of every window is shared, so the open transaction of any window holds it. present is asked again when a transaction opened meanwhile. displayed is the time
// (ms, mach absolute time) at which that presentation appears on the screen. When the window is not on the screen, it is the time
// of the call.
void surfaceLayoutAfterSettled(void *window, surfaceLayoutPresent present, void (^done)(double displayed, const char *error));
// Registers the observer of the layout transactions of the process and replaces the earlier one. started(window) runs on the
// main thread when a preparation of the window starts, before its ready. ended(window) runs on the main thread when the
// transaction of the window ends by its commit, deferred or not, by its cancel, by the close of the window or by a press or key
// event, before the waiting preparations of the window start. It runs after the Core Animation hold commits when no other
// transaction is open, and inside the hold otherwise.
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
// When the commit of the window waits for joined views, ready is called after that commit ends. Call on the main thread.
void surfaceLayoutStartPage(void *owner, uint64_t ticket, double height, void (^ready)(const char *failure));
// Joins the view webview to the open layout transaction of owner with ticket. The transaction does not commit until the
// joined view presents or its join ends: the commit is deferred, and the next preparation of the window starts after the deferred
// commit; no other window waits for it. presented is called on the main thread once, when the view presents. Returns false when no
// transaction of owner with ticket is open or the transaction is already committing (docs/spec/plugin-processes.md, rule 6).
bool surfaceLayoutJoinView(void *owner, uint64_t ticket, void *viewWebview, void (^presented)(void));
// surfaceLayoutJoinView whose ended(reason) is called on the main thread once when the join ends without a presentation and
// without an abandon of the host: "input" when a press or key event ended the hold, "closed" when the view closed. A cancel ends
// the join without a call (docs/spec/native-surfaces.md#layout-transaction).
bool surfaceLayoutJoinViewEnds(void *owner, uint64_t ticket, void *viewWebview, void (^presented)(void),
    void (^ended)(const char *reason));
// Ends each join of the view webview in the turn of its close, because a view out of its window never presents.
void surfaceLayoutViewClosed(void *viewWebview);
// Ends the wait of the view webview for the transaction of owner without a presentation, so the deferred commit can finish.
// The presented callback of that join is not called afterward. Returns false when the view has no open join of owner.
bool surfaceLayoutAbandonView(void *owner, void *viewWebview);
// Returns the number of views that the open transactions of owner wait for. Used by the layout check.
size_t surfaceLayoutViewJoinCount(void *owner);
#endif
