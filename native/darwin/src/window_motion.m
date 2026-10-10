#import <Cocoa/Cocoa.h>
#import "window_motion.h"

void windowResizeInstant(void) {
    // It takes effect only when registered before AppKit first reads this value. 0 is ignored and the default
    // duration stays in use (measured: the content is about 400 ms late after zooming), so set a value shorter
    // than one display refresh. It goes into the registration domain, so a value the user set
    // explicitly takes precedence.
    [NSUserDefaults.standardUserDefaults registerDefaults:@{@"NSWindowResizeTime": @0.001}];
}
