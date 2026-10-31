// Private CoreGraphics declarations that this library uses.
// List and conditions of use: docs/operations/private-native-apis.md
#import <CoreGraphics/CoreGraphics.h>

// Number of the window that the event belongs to. +[NSEvent eventWithCGEvent:] sets NSEvent.window from this value.
static const CGEventField kSPEventWindowNumberField = (CGEventField)51;

// Event location relative to the top-left of the window. +[NSEvent eventWithCGEvent:] uses it as locationInWindow.
extern void CGEventSetWindowLocation(CGEventRef event, CGPoint location);
