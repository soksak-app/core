#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "support/temporary_folder.h"
#import "document_view.h"
#import "webview_geometry.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static void changed(void *context, const char *text) {
    (void)context;
    (void)text;
}

@interface MenuActionSpy : NSObject
@property NSUInteger calls;
- (void)resetTextSize:(id)sender;
@end

@implementation MenuActionSpy
- (void)resetTextSize:(id)sender {
    (void)sender;
    self.calls++;
}
@end

static NSEvent *keyEvent(NSString *characters, NSEventModifierFlags modifiers, unsigned short keyCode, NSInteger windowNumber) {
    return [NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:modifiers
        timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:windowNumber context:nil
        characters:characters charactersIgnoringModifiers:characters isARepeat:NO keyCode:keyCode];
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 400, 300)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 400, 300)] autorelease];
    WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
    [window.contentView addSubview:main];
    void *surface = sp_surface_create(main);
    check(surface != NULL, @"the document surface is created");
    webviewSetFrame(surface, 0, 0, 400, 300);
    webviewSetSurfaceHidden(surface, false);

    NSString *temporary = temporaryFolder(@"soksak-document-menu-key-equivalent-");
    NSString *store = [temporary stringByAppendingPathComponent:@"store"];
    void *document = sp_document_create(surface, store.fileSystemRepresentation, NULL, NULL, NULL, changed, NULL);
    check(document != NULL, @"the document view is created");

    MenuActionSpy *spy = [MenuActionSpy new];
    NSMenu *mainMenu = [[[NSMenu alloc] initWithTitle:@"Main"] autorelease];
    NSMenu *viewMenu = [[[NSMenu alloc] initWithTitle:@"View"] autorelease];
    NSMenuItem *viewItem = [[[NSMenuItem alloc] initWithTitle:@"View" action:nil keyEquivalent:@""] autorelease];
    [viewItem setSubmenu:viewMenu];
    [mainMenu addItem:viewItem];
    NSMenuItem *reset = [viewMenu addItemWithTitle:@"Default Text Size" action:@selector(resetTextSize:) keyEquivalent:@"0"];
    reset.target = spy;
    reset.keyEquivalentModifierMask = NSEventModifierFlagCommand;
    [NSApp setMainMenu:mainMenu];

    BOOL handled = [(NSResponder *)document performKeyEquivalent:
        keyEvent(@"0", NSEventModifierFlagCommand, 29, window.windowNumber)];
    check(handled, @"the document view handles Command+0 through the application menu");
    check(spy.calls == 1, [NSString stringWithFormat:@"the matching menu action runs once, got %lu", (unsigned long)spy.calls]);

    handled = [(NSResponder *)document performKeyEquivalent:
        keyEvent(@"x", NSEventModifierFlagCommand, 7, window.windowNumber)];
    check(!handled, @"an unmatched Command key falls through to the responder chain");
    check(spy.calls == 1, @"an unmatched Command key does not run the menu action");

    handled = [(NSResponder *)document performKeyEquivalent:
        keyEvent(@"0", 0, 29, window.windowNumber)];
    check(!handled, @"a non-Command 0 key falls through to the responder chain");
    check(spy.calls == 1, @"a non-Command 0 key does not run the menu action");

    [NSApp setMainMenu:nil];
    sp_document_close(document);
    sp_surface_close(surface);
    [window close];
    [window release];
    [spy release];
    return failures ? 1 : 0;
}}
