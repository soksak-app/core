#include <stdbool.h>

// Live count of the objects that the library attaches to windows and web views and whose lifetime shows the
// release of the window and the web view. Each object increases the count in its initializer and decreases it
// in dealloc. When a closed window is released, the objects of that window leave the count.
typedef struct {
    // SPWindowComposition: lives in the content view of the window and retains the main web view. It
    // is released only when the window is released.
    long windowCompositions;
    // SPSurfaceHost: container of the logical surface and the web views attached to the surface. The
    // logical surface retains the main web view.
    long surfaceHosts;
    // SPInputRegistration: associated object of a web view that registered input (main, modal,
    // surface web view). It is released only when the web view is released.
    long inputRegistrations;
} sp_window_objects;

// Returns the current live count.
sp_window_objects sp_window_objects_count(void);

typedef void (*sp_window_objects_done)(void *context, const sp_window_objects *counts, bool reached);

// Puts an application-defined event into the event queue and, when the count after the application handled
// that event equals expected, gives that count and reached true to done. If the count does not equal expected
// within seconds, gives the count at that time and reached false. When expected is NULL, gives the count
// after the first queued event was handled, with reached true.
// AppKit empties the autorelease pool of an iteration when the iteration that handles one event ends, so an
// object autoreleased while a window is closing stays until the next user input if there is no event. An
// object autoreleased by an object that was released while the pool is emptied is released in the pool of
// the next iteration, and AppKit retains a window that was on screen until its close animation ends. So
// while a request waits, one event is queued before the main run loop sleeps each time, and the count is
// compared after each such event is handled. Call it on the main thread; done is called once on the main
// thread.
void sp_window_objects_when(const sp_window_objects *expected, double seconds, sp_window_objects_done done,
    void *context);

#ifdef __OBJC__
typedef enum {
    SP_WINDOW_OBJECT_COMPOSITION,
    SP_WINDOW_OBJECT_SURFACE_HOST,
    SP_WINDOW_OBJECT_INPUT_REGISTRATION,
} sp_window_object_kind;

// Called by the initialization (+1) and dealloc (-1) of library objects.
void sp_window_object_change(sp_window_object_kind kind, long delta);
#endif
