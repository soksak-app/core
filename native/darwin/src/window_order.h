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
