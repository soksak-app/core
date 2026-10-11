#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>
#import "dock_menu.h"
#import "application_log.h"

@interface SPDockMenu : NSMenu
@property(copy) void (^newWindow)(void);
- (void)openWindow:(id)sender;
@end

@implementation SPDockMenu
- (void)openWindow:(id)sender { self.newWindow(); }
- (void)dealloc { [_newWindow release]; [super dealloc]; }
@end

static SPDockMenu *dockMenu;
static NSMenu *applicationDockMenu(id delegate, SEL command, NSApplication *app) {
    (void)delegate; (void)command; (void)app;
    return dockMenu;
}

bool appInstallDockMenu(void (^newWindow)(void)) {
    NSCAssert(NSThread.isMainThread, @"Dock menu registration requires the AppKit thread");
    id delegate = NSApp.delegate;
    SEL selector = @selector(applicationDockMenu:);
    if (!delegate || [delegate respondsToSelector:selector]) {
        sp_log_error("dock menu", delegate ? "the application delegate already answers the dock menu request" : "the application has no delegate");
        return false;
    }
    if (!class_addMethod([delegate class], selector, (IMP)applicationDockMenu, "@@:@")) {
        sp_log_error("dock menu", "the runtime refused the dock menu method for the application delegate");
        return false;
    }
    dockMenu = [[SPDockMenu alloc] initWithTitle:@"soksak"];
    dockMenu.newWindow = newWindow;
    NSMenuItem *item = [dockMenu addItemWithTitle:@"새 창" action:@selector(openWindow:) keyEquivalent:@""];
    item.target = dockMenu;
    return true;
}
