#include <stdbool.h>

// Applies the requested named appearance to a WebKit view.
// Returns false when the view or named appearance is unavailable.
bool sp_webview_set_appearance(void *view, bool dark);
