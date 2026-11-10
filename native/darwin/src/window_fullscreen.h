#include <stdbool.h>

// Wails also has a windowFullscreen in its cgo code, and the linker picks one of the two when the names
// collide. Public names start with sp_.

// The result of a full screen request. The values are the FullscreenResult values of the hosts.
enum {
    // The transition ended in the asked state, or the window was already in it.
    SP_FULLSCREEN_DONE = 0,
    // The window is minimized, not shown or showing a sheet, macOS did not start the transition, or a later request
    // replaced the request.
    SP_FULLSCREEN_REFUSED = 1,
    // The window closed during the transition.
    SP_FULLSCREEN_CLOSED = 2,
    // macOS failed a started transition (windowDidFailToEnterFullScreen: or windowDidFailToExitFullScreen:).
    SP_FULLSCREEN_FAILED = 3,
};

// Switches the window to full screen or back, and calls done once on the main thread with the result and a static message
// (NULL for SP_FULLSCREEN_DONE). macOS ignores new requests while a transition is in progress, so a request made during a
// transition is applied after it ends, and the earlier request that waited is answered as replaced. A refusal is answered
// in the turn of the request. The request has no time limit: the end of the transition, its failure and the close of the
// window answer it. Returns false when the window does not support full screen.
#ifdef __BLOCKS__
bool sp_window_fullscreen(void *window, bool on, void (^done)(int result, const char *message));
#endif
