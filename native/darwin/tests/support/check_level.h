// The window level of the windows of a native check that judges what the window server shows. A window of another application
// that a person brings forward during a check (docs/spec/verification.md) stands at a lower level, so it does not cover the
// windows of the check, and the occlusion state that the window server reports follows the windows of the check only. A cover
// window of a check stands at the same level and is ordered in front of the window it covers.
#import <AppKit/AppKit.h>

static const NSWindowLevel kCheckWindowLevel = NSPopUpMenuWindowLevel;
