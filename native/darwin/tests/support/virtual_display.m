// Adds a virtual display to the window server for the native presentation tests on a machine whose display presents no frames,
// such as a hosted CI runner, and keeps it until the program receives SIGTERM or SIGINT. Usage: virtual_display <width> <height>
// in points; the display has two pixels per point and a refresh rate of 60 Hz. The program prints `virtual display <id> online
// <width>x<height> scale <scale>` when the display is online and an NSScreen reports it, and exits with status 1 and the reason when
// the display cannot be created or the window server ends it.
#import <AppKit/AppKit.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>

#import "private/coregraphics.h"

static void fail(NSString *text) {
  fprintf(stderr, "virtual_display: %s\n", text.UTF8String);
  exit(1);
}

static unsigned int dimension(const char *text, const char *name) {
  char *end = NULL;
  long value = strtol(text, &end, 10);
  if (end == text || *end != '\0' || value < 320 || value > 4096) {
    fail([NSString stringWithFormat:@"%s must be a whole number of points from 320 to 4096, found %s", name, text]);
  }
  return (unsigned int)value;
}

static NSScreen *screenOf(CGDirectDisplayID display) {
  for (NSScreen *screen in NSScreen.screens) {
    NSNumber *number = screen.deviceDescription[@"NSScreenNumber"];
    if (number.unsignedIntValue == display) return screen;
  }
  return nil;
}

int main(int argc, const char **argv) {
  @autoreleasepool {
    if (argc != 3) fail(@"usage: virtual_display <width> <height>");
    unsigned int width = dimension(argv[1], "width");
    unsigned int height = dimension(argv[2], "height");
    [NSApplication sharedApplication];
    NSApp.activationPolicy = NSApplicationActivationPolicyProhibited;

    CGVirtualDisplayDescriptor *descriptor = [CGVirtualDisplayDescriptor new];
    descriptor.queue = dispatch_get_main_queue();
    descriptor.name = @"soksak check display";
    descriptor.maxPixelsWide = width * 2;
    descriptor.maxPixelsHigh = height * 2;
    // 96 points per inch, the size that AppKit assumes for a display without a stated size.
    descriptor.sizeInMillimeters = CGSizeMake(width * 25.4 / 96, height * 25.4 / 96);
    descriptor.vendorID = 0x736f;
    descriptor.productID = 0x6b73;
    descriptor.serialNum = 1;
    descriptor.terminationHandler = ^(id __unused source, CGVirtualDisplay *__unused ended) {
      fail(@"the window server ended the virtual display");
    };
    CGVirtualDisplay *display = [[CGVirtualDisplay alloc] initWithDescriptor:descriptor];
    if (display == nil || display.displayID == 0) fail(@"CGVirtualDisplay initWithDescriptor: returned no display");
    CGVirtualDisplaySettings *settings = [CGVirtualDisplaySettings new];
    settings.hiDPI = 1;
    settings.modes = @[ [[CGVirtualDisplayMode alloc] initWithWidth:width height:height refreshRate:60] ];
    if (![display applySettings:settings]) fail(@"CGVirtualDisplay applySettings: refused the mode");

    CGDirectDisplayID identifier = display.displayID;
    __block BOOL announced = NO;
    void (^announce)(void) = ^{
      NSScreen *screen = screenOf(identifier);
      if (announced || !CGDisplayIsOnline(identifier) || screen == nil) return;
      announced = YES;
      printf("virtual display %u online %.0fx%.0f scale %.0f\n", identifier, screen.frame.size.width, screen.frame.size.height,
             screen.backingScaleFactor);
      fflush(stdout);
    };
    // AppKit updates NSScreen.screens when the window server reports the new display; the notification is the event of that change.
    [NSNotificationCenter.defaultCenter addObserverForName:NSApplicationDidChangeScreenParametersNotification
                                                    object:nil
                                                     queue:NSOperationQueue.mainQueue
                                                usingBlock:^(NSNotification *__unused note) {
                                                  announce();
                                                }];
    dispatch_async(dispatch_get_main_queue(), announce);

    signal(SIGTERM, SIG_IGN);
    signal(SIGINT, SIG_IGN);
    dispatch_source_t terminate = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGTERM, 0, dispatch_get_main_queue());
    dispatch_source_t interrupt = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGINT, 0, dispatch_get_main_queue());
    dispatch_block_t end = ^{
      printf("virtual display %u removed\n", identifier);
      fflush(stdout);
      exit(0);
    };
    dispatch_source_set_event_handler(terminate, end);
    dispatch_source_set_event_handler(interrupt, end);
    dispatch_resume(terminate);
    dispatch_resume(interrupt);
    (void)display;
    [NSApp run];
  }
  return 0;
}
