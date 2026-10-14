#include <stdbool.h>

// An image region placed on a surface. It shows an IOSurface provided from outside and supports the keyboard, the
// input
// method (IME), and accessibility. Every function is called on the main thread.

// Called when an event occurs. json represents a JSON object and is released when the call returns.
// Called on the main thread.
typedef void (*sp_region_event)(void *context, const char *json);

// Creates an image region over the surface webview.
void *sp_region_create(void *surface, const char *name, sp_region_event event, void *context);

// Sets the region by the CSS pixel margins (left, top, right, bottom) of the surface viewport. The margins are kept
// when the surface size changes.
void sp_region_place(void *region, double left, double top, double right, double bottom, bool visible);

// Writes the device pixel width and height of the applied region and the device pixels per CSS pixel to out[0..2].
// Returns false if the region is not placed yet or the size and scale cannot be obtained.
bool sp_region_raster(void *region, double *out);

// Returns true if the surface of the region has a native size. The region of a surface that is not placed yet has no
// raster size.
bool sp_region_surface_placed(void *region);

// Shows an external IOSurface. token_id is the global ID of the IOSurface, nonce is 16 bytes of data for the nonce
// comparison, width and height are the size in device pixels, and scale is the scale at which the image was made
// (used as contentsScale). Returns true on success and false if the surface is not found or the size does not match.
bool sp_region_present(void *region, unsigned int token_id, const unsigned char *nonce, double width, double height, double scale);

// Returns the reason of the last presentation rejection as a malloc() string. Returns NULL if there is no error.
char *sp_region_last_error(void *region);

// Makes the region the first responder and sends a focus event. If it leaves the previous responder, it also sends a
// focus release event.
void sp_region_focus(void *region);

// Stores the caret (input cursor) position. The input method uses the caret height to place its candidate window.
void sp_region_caret(void *region, double x, double y, double w, double h);

// Gives the region the input context (an NSTextInputContext) that its keys go to; NULL returns them to the context of
// AppKit. The region retains the context. A test gives a context that answers nothing, which is how the input method
// treats a key outside the key window of the active application, to reach the error report of that key.
void sp_region_set_input_context(void *region, void *context);

// Stores the string that is exposed as the accessibility value.
void sp_region_text(void *region, const char *utf8);

// Writes the region in window coordinates, the visibility, and the focus state {x, y, width, height, visible,
// focused}
// to out[0..5].
void sp_region_frame(void *region, double *out);

// Returns all information of the region as JSON. The caller must free the malloc() allocated string.
const char *sp_region_facts(void *region);

// Removes and releases the region. event is not called afterward.
void sp_region_close(void *region);
