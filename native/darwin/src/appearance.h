#include <stdbool.h>

// Applies the light or dark appearance, selected by dark, to the WebKit view.
// Returns false if the view or the appearance is not available.
bool sp_webview_set_appearance(void *view, bool dark);
