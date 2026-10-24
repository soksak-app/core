#include <stdbool.h>

// Returns the state of windows and screens as a JSON string. Free the returned string with sp_facts_free.
// Call every function on the main thread. Screen coordinates are point values relative to the top left of
// the primary display with y increasing downward, and window coordinates are relative to the top left of
// the content area.

// Registers the app DOM web view of a window explicitly. The main view is not guessed from the drawing
// order. Returns false when the web view is not attached to the window or another main view is already
// registered.
bool sp_window_set_main_webview(void *window, void *main);

// Returns only the registered app DOM web view. A window that is not registered gives NULL.
void *sp_window_main_webview(void *window);

// {frame, content, scale, key, active, children, controls, webviews, nativeSurfaces, appDomWebviews, documentWebviews}
//   frame     window frame {x, y, width, height}, screen coordinates
//   content   content area {width, height}
//   controls  window buttons [{x, y, width, height, hidden}], window coordinates
//   webviews  lists the WKWebViews in the window in drawing order (the main position is not assumed)
//             [{view, x, y, width, height, hidden, focused, draws, alpha}], window coordinates.
//             view is the view address, draws tells whether it paints its own background, and alpha is the
//             alpha of the background color under the page
//   nativeSurfaces logical surface containers [{view, x, y, width, height, hidden}], window coordinates.
// Returns NULL when there is no window or registered main web view.
char *sp_window_facts(void *window);

// Returns {name, iccSHA256} for the window's current AppKit backing color space. Both values are null when
// the window has no backing color space; iccSHA256 is null when AppKit supplies no ICC profile data.
// This is called only for one-shot diagnostic queries. It does not change the window.
char *sp_window_color_space_facts(void *window);

// Hit test result {view, main, identifier, hit} at window coordinates (x, y). view is the address of the
// WKWebView that contains the point and is 0 when there is none. main tells whether that web view is the
// main page. identifier is the identifier of the hit view. hit is {class, frame} and is null when there is
// no leaf view. frame is in window coordinates with the top left of the content area as the origin.
// Returns NULL when there is no window or main web view.
char *sp_window_hit(void *window, double x, double y);

// Displays [{x, y, width, height, scale}], screen coordinates.
char *sp_screens(void);

// Moves the top left of the window frame to screen coordinates (x, y).
bool sp_window_move(void *window, double x, double y);

// Application menu (JSON array). Each submenu is {title, items: [{title, key}]}; separators are omitted.
// key is the shortcut: the modifier keys in the order ctrl, opt, shift, cmd joined with +, followed by
// the key character.
char *sp_menu_items(void);

/** Primary tag of the preferred system language. The caller's table decides which languages are supported.
 * Free it with sp_facts_free. */
char *sp_preferred_language(void);

// Runs the item titled title in the submenu titled menu. Returns false when there is no such item.
bool sp_menu_select(const char *menu, const char *title);

// Main window of the application. When there is no main window (an application that was never activated),
// it is the frontmost visible window, and NULL when there is none.
void *sp_app_main_window(void);

// Titles of the Dock menu items (JSON array).
char *sp_dock_items(void);

// Runs the Dock menu item titled title. Returns false when there is no such item.
bool sp_dock_select(const char *title);

void sp_facts_free(char *text);

// Calls changed on the main thread each time the occlusion state of the window changes
// (NSWindowDidChangeOcclusionStateNotification). The observation ends when the window is released. An
// existing observation of the window is replaced. Returns false when there is no window.
#ifdef __BLOCKS__
bool sp_window_observe_occlusion(void *window, void (^changed)(void));
#endif
