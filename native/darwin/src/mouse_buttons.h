#include <stdbool.h>

// Reports the pressed mouse button mask that AppKit reports (+[NSEvent pressedMouseButtons]: bit 0 left, bit 1 right,
// higher bits other buttons). Called on the main thread.
typedef void (*sp_mouse_buttons_changed)(void *context, unsigned long long mask);

// Installs the mouse button monitors. It reports the current mask once in the turn of installation, and afterwards
// reports the mask of the turn each time AppKit delivers a mouse button press or release to this application (local
// event monitor) or to another application (global event monitor). The same mask is reported again, so the receiver
// decides whether it changed. Synthetic input (input_inject.h) goes to the view without passing through the AppKit
// event delivery, so it is not reported. The monitors remain until the process ends.
//
// Call once on the main thread. When the caller is not on the main thread, the monitors are already installed, or AppKit
// does not create a monitor, the function returns false and reports nothing.
bool sp_mouse_buttons_watch(sp_mouse_buttons_changed changed, void *context);
