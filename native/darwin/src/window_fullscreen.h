#include <stdbool.h>

// Wails also has a windowFullscreen in its cgo code, and the linker picks one of the two when the names
// collide. Public names start with sp_.
//
// Switches the window to full screen or back, and calls done on the main thread when the transition ends.
// macOS ignores new requests while a transition is in progress, so a request made during a transition is
// applied after it ends.
// When the window is already in the requested state, done is called immediately. Returns false when the
// window does not support full screen.
#ifdef __BLOCKS__
bool sp_window_fullscreen(void *window, bool on, void (^done)(void));
#endif
