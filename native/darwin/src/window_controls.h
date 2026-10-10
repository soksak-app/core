#include <stdbool.h>

// Writes the area where the three window buttons are visible, as {x, y, width, height} relative to the
// top left of the content, to out.
void windowControls(void *window, double *out);

// Returns the title bar height (pt) of the window. It is 0 while the title bar is not visible, as in full
// screen, and -1 for a window that cannot have a title bar because it has no standard buttons or content view.
double windowTitlebarHeight(void *window);

// Sets the title bar of the window to height (pt). AppKit places the window buttons at the vertical center
// of that height, so the buttons are not moved. Returns false and writes a malloc'd sentence to failure when
// height is not a positive finite number or the window cannot have a title bar; the caller frees it. A
// window in full screen does not show the title bar, and AppKit restores the height from entry on exit, so
// it returns true without changing the height.
bool windowSetTitlebarHeight(void *window, double height, char **failure);
