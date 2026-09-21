#import <Cocoa/Cocoa.h>
#import "dock_menu.h"

@interface NSObject (SPDockMenuTest)
- (NSMenu *)applicationDockMenu:(NSApplication *)sender;
@end

static int failures;
static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

@interface SPTestDelegate : NSObject <NSApplicationDelegate>
@end
@implementation SPTestDelegate
@end

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];
    SPTestDelegate *delegate = [[[SPTestDelegate alloc] init] autorelease];
    NSApp.delegate = delegate;
    __block BOOL invoked = NO;
    check(appInstallDockMenu(^{ invoked = YES; }), @"the application dock menu installs once");
    NSMenu *menu = [NSApp.delegate applicationDockMenu:NSApp];
    check(menu.numberOfItems == 1, @"the dock menu has one declared new-window command");
    [menu performActionForItemAtIndex:0];
    check(invoked, @"the declared new-window command invokes its callback");
    check(!appInstallDockMenu(^{ }), @"duplicate dock menu installation is rejected");
    return failures ? 1 : 0;
}}
