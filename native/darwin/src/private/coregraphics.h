// Private CoreGraphics declarations that this library uses.
// List and conditions of use: docs/operations/private-native-apis.md
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>

// Number of the window that the event belongs to. +[NSEvent eventWithCGEvent:] sets NSEvent.window from this value.
static const CGEventField kSPEventWindowNumberField = (CGEventField)51;

// Event location relative to the top-left of the window. +[NSEvent eventWithCGEvent:] uses it as locationInWindow.
extern void CGEventSetWindowLocation(CGEventRef event, CGPoint location);

// Virtual display classes of CoreGraphics (macOS 11 and later). A CGVirtualDisplay adds a display to the window server while the
// object lives. Only the CI display program uses them (tests/support/virtual_display.m).
@class CGVirtualDisplay;

@interface CGVirtualDisplayDescriptor : NSObject
@property(retain, nonatomic) dispatch_queue_t queue;
@property(retain, nonatomic) NSString *name;
@property(nonatomic) unsigned int maxPixelsWide;
@property(nonatomic) unsigned int maxPixelsHigh;
@property(nonatomic) CGSize sizeInMillimeters;
@property(nonatomic) unsigned int productID;
@property(nonatomic) unsigned int vendorID;
@property(nonatomic) unsigned int serialNum;
@property(copy, nonatomic) void (^terminationHandler)(id, CGVirtualDisplay *);
@end

@interface CGVirtualDisplayMode : NSObject
- (instancetype)initWithWidth:(unsigned int)width height:(unsigned int)height refreshRate:(double)refreshRate;
@end

@interface CGVirtualDisplaySettings : NSObject
@property(retain, nonatomic) NSArray<CGVirtualDisplayMode *> *modes;
@property(nonatomic) unsigned int hiDPI;
@end

@interface CGVirtualDisplay : NSObject
- (instancetype)initWithDescriptor:(CGVirtualDisplayDescriptor *)descriptor;
- (BOOL)applySettings:(CGVirtualDisplaySettings *)settings;
@property(readonly, nonatomic) unsigned int displayID;
@end
