// The place of a window among the windows that the window server shows (host.window order).
#import <Foundation/Foundation.h>
#include <sys/types.h>

// The place of the window number among windows, the window list of the window server from front to back (rows of
// CGWindowListCopyWindowInfo with kCGWindowNumber, kCGWindowLayer, kCGWindowOwnerPID, kCGWindowBounds and kCGWindowAlpha), as
// {index, count, otherInFront}: index is the number of windows of its window level in front of it, so 0 is the front of the
// level, count the number of windows of that level, and otherInFront whether a window of another process than pid stands in
// front of it at that level over a part of its bounds. A window with an alpha of 0 shows nothing and is left out. Returns nil
// when windows holds no row of the number.
NSDictionary *sp_window_order_in(NSArray<NSDictionary *> *windows, NSInteger number, pid_t pid);

// The windows that stand in front of the window number over a part of its bounds, from front to back: every window that
// windows, the window list of the window server from front to back, holds before the row of the number, of any window level and
// of any process, the own process included, whose bounds meet the bounds of the window and whose alpha is not 0. Each is
// {number, owner, pid, layer, x, y, width, height}: its window number, the name of the application that owns it
// (kCGWindowOwnerName, which the window server gives without screen recording access), its process, its window level and its
// bounds in screen coordinates with the origin at the top left of the primary display. Returns nil when windows holds no row of
// the number.
NSArray<NSDictionary *> *sp_window_in_front_in(NSArray<NSDictionary *> *windows, NSInteger number);

// sp_window_in_front_in over the window list that the window server shows now (CGWindowListCopyWindowInfo of the windows on the
// screen). It only reads the list and changes no window. Returns nil when the window server does not show the window.
NSArray<NSDictionary *> *sp_window_in_front(NSInteger number);
