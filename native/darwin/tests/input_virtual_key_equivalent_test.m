// Checks key equivalents of the virtual key window (docs/spec/exposure.md#virtual-key-window): the test process is never
// active, so its window takes keys as the virtual key window. A key down with Command is offered as a key equivalent to the
// main menu and then to the window before the first responder receives it, enforcing the project's native-menu ownership
// policy for virtual input: Command+C and Command+V run copy: and paste: of the first responder through the items of the Edit menu, a key
// equivalent of a view of the window runs there and not in the menu, a key that waits in the key wait of the window takes its
// key equivalent in its turn, and a key that no one takes as an equivalent, and a key without Command, reach the first
// responder as a key down. The record of each key down states whether the key waited.
#import <Cocoa/Cocoa.h>
#import "event_ring.h"
#import "input_inject.h"
#import "input_virtual.h"
#import "webview_geometry.h"
#import "support/event_wait.h"
#import "support/records.h"

static int failures;
static void check(BOOL ok, NSString *message) {
    fprintf(ok ? stdout : stderr, "%s: %s\n", ok ? "PASS" : "FAIL", message.UTF8String);
    if (!ok) failures++;
}

// The name of the physical key of an event. The characters of a key follow the input source of the system, which a person may
// change while the test runs, so the view names a key by its key code.
static NSString *keyName(NSEvent *event) {
    switch (event.keyCode) {
        case 0: return @"a";
        case 8: return @"c";
        case 9: return @"v";
        case 38: return @"j";
        case 40: return @"k";
        default: return [NSString stringWithFormat:@"code %u", event.keyCode];
    }
}

// The first responder of the window. It records each copy: and paste: with its sender, each key down and key up with its
// key, and takes Command+K as its own key equivalent.
@interface Clipboard : NSView
@property(retain) NSMutableArray<NSString *> *calls;
@property BOOL claimsSelectAll;
@end
@implementation Clipboard
- (BOOL)acceptsFirstResponder { return YES; }
- (void)copy:(id)sender { [self.calls addObject:[NSString stringWithFormat:@"copy:%@", [sender isKindOfClass:NSMenuItem.class] ? [sender title] : @"other"]]; }
- (void)paste:(id)sender { [self.calls addObject:[NSString stringWithFormat:@"paste:%@", [sender isKindOfClass:NSMenuItem.class] ? [sender title] : @"other"]]; }
- (void)selectAll:(id)sender { [self.calls addObject:[NSString stringWithFormat:@"selectAll:%@", [sender isKindOfClass:NSMenuItem.class] ? [sender title] : @"other"]]; }
- (void)keyDown:(NSEvent *)event { [self.calls addObject:[@"keyDown:" stringByAppendingString:keyName(event)]]; }
- (void)keyUp:(NSEvent *)event { [self.calls addObject:[@"keyUp:" stringByAppendingString:keyName(event)]]; }
- (BOOL)performKeyEquivalent:(NSEvent *)event {
    if (self.claimsSelectAll && event.type == NSEventTypeKeyDown && [keyName(event) isEqual:@"a"] &&
        (event.modifierFlags & NSEventModifierFlagDeviceIndependentFlagsMask) == NSEventModifierFlagCommand) {
        [self.calls addObject:@"equivalent:a"];
        return YES;
    }
    if (event.type != NSEventTypeKeyDown || (event.modifierFlags & NSEventModifierFlagDeviceIndependentFlagsMask) != NSEventModifierFlagCommand
        || ![keyName(event) isEqual:@"k"]) {
        return [super performKeyEquivalent:event];
    }
    [self.calls addObject:@"equivalent:k"];
    return YES;
}
- (void)dealloc { [_calls release]; [super dealloc]; }
@end

static NSMenuItem *item(NSString *title, SEL action, NSString *key) {
    NSMenuItem *made = [[[NSMenuItem alloc] initWithTitle:title action:action keyEquivalent:key] autorelease];
    made.keyEquivalentModifierMask = NSEventModifierFlagCommand;
    // The target is nil, so the action goes to the first responder of the key window.
    made.target = nil;
    return made;
}

// Runs the main queue until a marker block queued after every block already on it has run.
static void drainMainQueue(NSString *what) {
    __block BOOL passed = NO;
    dispatch_async(dispatch_get_main_queue(), ^{ passed = YES; });
    eventWait(what, ^BOOL { return passed; });
}

// Presses and releases key with modifiers on window. A key that does not wait is delivered within its call, and the main queue
// runs once for the blocks that it queued. -[NSApplication sendEvent:] gives a key up with Command to no window while the
// application has a key window, as for a person's key, so a key with Command records no key up. Returns the records of the
// native library that the key writes.
static NSString *press(NSWindow *window, const char *key, unsigned modifiers) {
    __block BOOL down = NO, up = NO;
    NSString *records = capturedRecords(^{
        down = sp_input_key(window, key, NULL, modifiers, true) == SP_INPUT_DELIVERED;
        up = sp_input_key(window, key, NULL, modifiers, false) == SP_INPUT_DELIVERED;
    });
    check(down && up, [NSString stringWithFormat:@"the key %s with modifiers %u is delivered", key, modifiers]);
    drainMainQueue([NSString stringWithFormat:@"the blocks that the key %s queued run", key]);
    return records;
}

// The key down records of the key with whether it was taken as an equivalent.
static BOOL recordsEquivalent(NSString *records, BOOL equivalent) {
    for (NSString *line in [records componentsSeparatedByString:@"\n"]) {
        if (![line containsString:@"input inject"] || ![line containsString:@"\"down\":true"]) continue;
        return [line containsString:equivalent ? @"\"equivalent\":true" : @"\"equivalent\":false"];
    }
    return NO;
}

// The key down record of the key with whether the key waited behind the held input of its window.
static BOOL recordsHeld(NSString *records, BOOL held) {
    for (NSString *line in [records componentsSeparatedByString:@"\n"]) {
        if (![line containsString:@"input inject"] || ![line containsString:@"\"down\":true"]) continue;
        return [line containsString:held ? @"\"held\":true" : @"\"held\":false"];
    }
    return NO;
}

int main(void) { @autoreleasepool {
    setvbuf(stdout, NULL, _IOLBF, 0);
    const int8_t everything[SP_CLASS_COUNT] = {SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE};
    check(sp_event_set_policy(everything), @"the policy stores every level of every class");
    [NSApplication sharedApplication];

    // The main menu has an Edit menu with Copy (Command+C) and Paste (Command+V).
    NSMenu *main = [[[NSMenu alloc] initWithTitle:@"Main"] autorelease];
    NSMenuItem *editItem = [[[NSMenuItem alloc] initWithTitle:@"Edit" action:NULL keyEquivalent:@""] autorelease];
    NSMenu *edit = [[[NSMenu alloc] initWithTitle:@"Edit"] autorelease];
    [edit addItem:item(@"Copy", @selector(copy:), @"c")];
    [edit addItem:item(@"Paste", @selector(paste:), @"v")];
    [edit addItem:item(@"Select All", @selector(selectAll:), @"a")];
    editItem.submenu = edit;
    [main addItem:editItem];
    NSApp.mainMenu = main;

    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 400, 300)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    Clipboard *clipboard = [[[Clipboard alloc] initWithFrame:window.contentView.bounds] autorelease];
    clipboard.calls = [NSMutableArray array];
    [window.contentView addSubview:clipboard];
    check([window makeFirstResponder:clipboard], @"the clipboard view holds the keyboard of the window");

    // Command+C runs copy: through the Copy item, and the key does not also reach the view as a key down.
    NSString *records = press(window, "c", 8);
    check(sp_input_virtual_is(window), @"the window of the key is the virtual key window");
    check([clipboard.calls isEqual:@[@"copy:Copy"]],
        [NSString stringWithFormat:@"Command+C runs copy: once through the Copy item (calls %@)", clipboard.calls]);
    check(recordsEquivalent(records, YES) && recordsHeld(records, NO),
        [NSString stringWithFormat:@"the key down record states the equivalent and that the key did not wait (records %@)", records]);

    // Command+V runs paste: through the Paste item.
    [clipboard.calls removeAllObjects];
    records = press(window, "v", 8);
    check([clipboard.calls isEqual:@[@"paste:Paste"]],
        [NSString stringWithFormat:@"Command+V runs paste: once through the Paste item (calls %@)", clipboard.calls]);
    check(recordsEquivalent(records, YES), [NSString stringWithFormat:@"the key down record states the equivalent (records %@)", records]);

    // A key not owned by the menu reaches the equivalent of the view.
    [clipboard.calls removeAllObjects];
    records = press(window, "k", 8);
    check([clipboard.calls isEqual:@[@"equivalent:k"]],
        [NSString stringWithFormat:@"Command+K runs the equivalent of the view (calls %@)", clipboard.calls]);
    check(recordsEquivalent(records, YES), [NSString stringWithFormat:@"the key down record states the equivalent (records %@)", records]);

    // Project native-menu ownership wins a collision with a view equivalent.
    clipboard.claimsSelectAll = YES;
    check(NSApp.mainMenu == main && editItem.submenu == edit, @"the collision uses the actual installed main/Edit menus");
    check([edit itemWithTitle:@"Select All"] != nil, @"the collision has an actual Select All item");
    [clipboard.calls removeAllObjects];
    records = press(window, "a", 8);
    check([clipboard.calls isEqual:@[@"selectAll:Select All"]],
        [NSString stringWithFormat:@"an enabled native-menu equivalent owns the key before a claiming view (calls %@)", clipboard.calls]);
    // Disabled menu entries do not own an equivalent; NSMenu performs the
    // enabled-state decision and the view still gets its unclaimed shortcut.
    edit.autoenablesItems = NO;
    NSMenuItem *selectAll = [edit itemWithTitle:@"Select All"];
    selectAll.enabled = NO;
    [clipboard.calls removeAllObjects];
    records = press(window, "a", 8);
    check([clipboard.calls isEqual:@[@"equivalent:a"]],
        [NSString stringWithFormat:@"a disabled menu equivalent leaves the key to the view (calls %@)", clipboard.calls]);
    selectAll.enabled = YES;
    edit.autoenablesItems = YES;
    clipboard.claimsSelectAll = NO;

    // A key that waits in the key wait of the window takes its key equivalent in its turn: Command+A runs selectAll: through the
    // Select All item and does not reach the view as a key down, and the record of the key down states that it waited. The
    // wait for a modal stands for any wait of the keys.
    [clipboard.calls removeAllObjects];
    sp_window_modal_hold(window);
    records = capturedRecords(^{
        check(sp_input_key(window, "a", NULL, 8, true) == SP_INPUT_DELIVERED && sp_input_key(window, "a", NULL, 8, false) == SP_INPUT_DELIVERED,
            @"the held key Command+A is kept");
        check(clipboard.calls.count == 0, [NSString stringWithFormat:@"a held key waits for its turn (calls %@)", clipboard.calls]);
        sp_window_modal_hold_end(window);
        eventWait(@"the held Command+A runs its equivalent", ^BOOL { return clipboard.calls.count > 0; });
        drainMainQueue(@"the blocks that the held key queued run");
    });
    check([clipboard.calls isEqual:@[@"selectAll:Select All"]],
        [NSString stringWithFormat:@"a held Command+A runs selectAll: once through the Select All item (calls %@)", clipboard.calls]);
    check(recordsEquivalent(records, YES) && recordsHeld(records, YES),
        [NSString stringWithFormat:@"the key down record states the equivalent and that the key waited (records %@)", records]);

    // A Command key that no one takes as an equivalent reaches the first responder as a key down, and its key up reaches no view.
    [clipboard.calls removeAllObjects];
    records = press(window, "j", 8);
    check([clipboard.calls isEqual:@[@"keyDown:j"]],
        [NSString stringWithFormat:@"Command+J reaches the first responder as a key down (calls %@)", clipboard.calls]);
    check(recordsEquivalent(records, NO), [NSString stringWithFormat:@"the key down record states no equivalent (records %@)", records]);

    // A key without Command reaches the first responder as before, and the menu does not run.
    [clipboard.calls removeAllObjects];
    records = press(window, "c", 0);
    check([clipboard.calls isEqual:@[@"keyDown:c", @"keyUp:c"]],
        [NSString stringWithFormat:@"C without Command reaches the first responder as a key down (calls %@)", clipboard.calls]);
    check(recordsEquivalent(records, NO), [NSString stringWithFormat:@"the key down record states no equivalent (records %@)", records]);

    [window close];
    [window release];
    return failures == 0 ? 0 : 1;
}}
