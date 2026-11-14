// Checks typing into a web view of the virtual key window (docs/spec/exposure.md#virtual-key-window): the test process is never
// active, so its window takes keys as the virtual key window and the input method of the system does not serve it. A key down
// whose text the caller stated reaches the page as a person's key does, keydown, keypress, beforeinput and input, and inserts
// that text through the text input of the web view whatever the input source of the system is: a Korean text and an accented
// Latin letter reach the focused field, a key down that the page cancels inserts nothing, and a named key runs the command of its
// key binding. The web view answers without an input context while such a key is delivered (docs/spec/exposure.md#virtual-key-window),
// so the key never reaches the input method and no result depends on the state of the input method of the system. The record of
// each key down states whether its text went through the text input of the web view (`virtualKeyText`).
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import "event_ring.h"
#import "input_inject.h"
#import "input_virtual.h"
#import "support/event_wait.h"
#import "support/records.h"
#import "webview_input.h"
#import "window_facts.h"

static int failures;
static void check(BOOL ok, NSString *message) {
    fprintf(ok ? stdout : stderr, "%s: %s\n", ok ? "PASS" : "FAIL", message.UTF8String);
    if (!ok) failures++;
}
static id evaluate(WKWebView *view, NSString *script) {
    __block id out = nil;
    __block BOOL done = NO;
    [view evaluateJavaScript:script completionHandler:^(id result, NSError *error) {
        out = [(error ? error.localizedDescription : result) retain];
        done = YES;
    }];
    eventWait(@"the page answers the evaluation", ^BOOL { return done; });
    return [out autorelease];
}
static sp_input_result lastResult;
static BOOL lastDone;
static void onDone(void *context, sp_input_result result, const sp_input_held *held) { lastResult = result; lastDone = YES; }
static sp_input_result pointer(NSWindow *window, double x, double y, int phase) {
    lastDone = NO;
    sp_input_pointer_then(window, SP_INPUT_POINTER_MAIN, x, y, phase, 0, 0, 0, 1, onDone, NULL);
    eventWait(@"the pointer input completes", ^BOOL { return lastDone; });
    return lastResult;
}

// A page with one field. Each keyboard, composition and text input event of the page is one entry "<type>:<key or data>",
// with "!" for an event that is not trusted. While cancel is set, the page cancels each keydown. seen(prefix) resolves when an
// entry that starts with prefix is in the list.
static NSString *const PAGE = @"<!doctype html><style>html,body{margin:0;height:100%}</style>"
    "<input id='field' style='position:absolute;left:10px;top:10px;width:300px;height:30px'><script>"
    "window.events=[];window.cancel=false;window.waiters=[];"
    "window.seen=p=>new Promise(r=>{const f=()=>events.some(e=>e.startsWith(p))?r(true):waiters.push(f);f();});"
    "for(const t of ['keydown','keypress','keyup','beforeinput','input','compositionstart','compositionupdate','compositionend'])"
    "addEventListener(t,e=>{events.push(t+':'+(e.key!==undefined?e.key:(e.data||''))+(e.isTrusted?'':'!'));"
    "if(t==='keydown'&&cancel)e.preventDefault();for(const w of waiters.splice(0))w();},true);</script>";

// Asks the page to answer when an entry that starts with prefix is in its list, and sets *seen at the answer. The question
// is sent to the web process before a key that the caller sends next, so the page answers at the event of that key.
static void whenSeen(WKWebView *view, NSString *prefix, BOOL *seen) {
    *seen = NO;
    [view callAsyncJavaScript:@"return await seen(prefix);" arguments:@{@"prefix": prefix} inFrame:nil
        inContentWorld:WKContentWorld.pageWorld completionHandler:^(id result, NSError *error) {
            (void)result;
            if (error) fprintf(stderr, "JavaScript: %s\n", error.localizedDescription.UTF8String);
            *seen = YES;
        }];
}

// Sends the key down and the key up of key with text, lets the page take each and returns the events that the page saw. records
// receives the records of the native library that the keys write. The key up is sent once the page saw the keydown, and the
// records end once the page saw the keyup, so a key that waited behind the input of its window is recorded in them too.
static NSArray<NSString *> *type(NSWindow *window, WKWebView *view, const char *key, NSString *text, NSString **records) {
    evaluate(view, @"events.length=0");
    __block BOOL down = NO, up = NO;
    static BOOL downSeen, upSeen;
    NSString *written = capturedRecords(^{
        whenSeen(view, @"keydown:", &downSeen);
        down = sp_input_key(window, key, text.UTF8String, 0, true) == SP_INPUT_DELIVERED;
        if (down) eventWait(@"the page sees the keydown", ^BOOL { return downSeen; });
        whenSeen(view, @"keyup:", &upSeen);
        up = sp_input_key(window, key, text.UTF8String, 0, false) == SP_INPUT_DELIVERED;
        if (up) eventWait(@"the page sees the keyup", ^BOOL { return upSeen; });
    });
    if (records) *records = written;
    check(down && up, [NSString stringWithFormat:@"the key %s with the text %@ is delivered", key, text ?: @"(none)"]);
    return evaluate(view, @"events.slice()");
}

// The key down record of the key states whether the web view took it without an input context, which keeps the key away from the
// input method (`inputContextAbsent`), for every key that reaches the web view.
static BOOL recordsContextAbsent(NSString *records) {
    BOOL seen = NO;
    for (NSString *line in [records componentsSeparatedByString:@"\n"]) {
        if (![line containsString:@"input inject"] || ![line containsString:@"\"down\":true"]) continue;
        seen = YES;
        if (![line containsString:@"\"inputContextAbsent\":true"]) return NO;
    }
    return seen;
}

// The key down record of the key states whether its stated text went through the text input of a web view.
static BOOL recordsTextInput(NSString *records, BOOL typed) {
    for (NSString *line in [records componentsSeparatedByString:@"\n"]) {
        if (![line containsString:@"input inject"] || ![line containsString:@"\"down\":true"]) continue;
        return [line containsString:typed ? @"\"virtualKeyText\":true" : @"\"virtualKeyText\":false"];
    }
    return NO;
}

// Notes when the navigation of the document finishes; the script of the document has run then.
@interface SPLoaded : NSObject <WKNavigationDelegate>
@property BOOL finished;
@end
@implementation SPLoaded
- (void)webView:(WKWebView *)view didFinishNavigation:(WKNavigation *)navigation {
    (void)view;
    (void)navigation;
    self.finished = YES;
}
@end

static NSString *value(WKWebView *view) { return evaluate(view, @"document.getElementById('field').value"); }

// Real WebKit editing runs in the web process: inspect this fixture's own input after an evaluation roundtrip, not a timer.
static void checkWebKitEditEquivalents(NSWindow *window, WKWebView *view) {
    NSMenu *previousMenu = [NSApp.mainMenu retain];
    NSPasteboard *board = NSPasteboard.generalPasteboard;
    NSMutableArray<NSPasteboardItem *> *saved = [NSMutableArray array];
    for (NSPasteboardItem *item in board.pasteboardItems) {
        NSPasteboardItem *copy = [[[NSPasteboardItem alloc] init] autorelease];
        for (NSPasteboardType type in item.types) {
            NSData *data = [item dataForType:type];
            check(data != nil, [NSString stringWithFormat:@"the clipboard fixture saves %@", type]);
            if (data) [copy setData:data forType:type];
        }
        [saved addObject:copy];
    }
    @try {
        NSMenu *main = [[[NSMenu alloc] initWithTitle:@"Main"] autorelease];
        NSMenuItem *edit = [[[NSMenuItem alloc] initWithTitle:@"Edit" action:NULL keyEquivalent:@""] autorelease];
        NSMenu *menu = [[[NSMenu alloc] initWithTitle:@"Edit"] autorelease];
        for (NSArray *entry in @[@[@"Select All", @"selectAll:", @"a"], @[@"Copy", @"copy:", @"c"]]) {
            NSMenuItem *item = [[[NSMenuItem alloc] initWithTitle:entry[0] action:NSSelectorFromString(entry[1]) keyEquivalent:entry[2]] autorelease];
            item.target = nil;
            item.keyEquivalentModifierMask = NSEventModifierFlagCommand;
            [menu addItem:item];
        }
        edit.submenu = menu;
        [main addItem:edit];
        NSApp.mainMenu = main;
        NSString *expected = @"https://fixture.invalid/address-copy";
        evaluate(view, @"cancel=false;events=[];const f=document.getElementById('field');f.value='https://fixture.invalid/address-copy';f.focus();f.setSelectionRange(0,0);null;");
        check([window makeFirstResponder:view], @"the actual WebKit view is the native editing responder");
        [board clearContents];
        [board setString:@"ROUTING-SENTINEL" forType:NSPasteboardTypeString];
        NSString *selectRecords = capturedRecords(^{
            check(sp_input_key(window, "a", NULL, 8, true) == SP_INPUT_DELIVERED &&
                sp_input_key(window, "a", NULL, 8, false) == SP_INPUT_DELIVERED, @"real WebKit Command+A is delivered");
        });
        NSDictionary *selected = evaluate(view, @"(()=>{const f=document.getElementById('field');return {value:f.value,focused:document.activeElement===f,start:f.selectionStart,end:f.selectionEnd,events:events.slice()};})()");
        check([selected[@"value"] isEqual:expected] && [selected[@"focused"] boolValue] &&
            [selected[@"start"] integerValue] == 0 && [selected[@"end"] integerValue] == expected.length,
            [NSString stringWithFormat:@"Command+A selects the actual WebKit input after its evaluation roundtrip: %@; records %@; responder %@", selected, selectRecords, window.firstResponder]);
        NSString *copyRecords = capturedRecords(^{
            check(sp_input_key(window, "c", NULL, 8, true) == SP_INPUT_DELIVERED &&
                sp_input_key(window, "c", NULL, 8, false) == SP_INPUT_DELIVERED, @"real WebKit Command+C is delivered");
        });
        // The roundtrip observes the fixture context after native dispatch; it
        // never executes copy, writes the clipboard, or changes selection.
        id afterCopy = evaluate(view, @"(()=>{const f=document.getElementById('field');return {focused:document.activeElement===f,start:f.selectionStart,end:f.selectionEnd,events:events.slice()};})()");
        NSString *copied = [board stringForType:NSPasteboardTypeString];
        NSArray *keyDowns = [afterCopy[@"events"] filteredArrayUsingPredicate:[NSPredicate predicateWithFormat:@"SELF BEGINSWITH %@", @"keydown:"]];
        check(keyDowns.count == 0, [NSString stringWithFormat:@"menu Command+A/C reach no page keydown: %@; select records %@; copy records %@", keyDowns, selectRecords, copyRecords]);
        check([copied isEqual:expected], [NSString stringWithFormat:@"Command+C copies the actual WebKit selection after its evaluation roundtrip: clipboard %@; context %@; records %@; responder %@", copied, afterCopy, copyRecords, window.firstResponder]);
    } @finally {
        [board clearContents];
        if (saved.count) [board writeObjects:saved];
        NSApp.mainMenu = previousMenu;
        [previousMenu release];
    }
}

int main(void) { @autoreleasepool {
    setvbuf(stdout, NULL, _IOLBF, 0);
    const int8_t everything[SP_CLASS_COUNT] = {SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE, SP_EVENT_TRACE};
    check(sp_event_set_policy(everything), @"the policy stores every level of every class");
    [NSApplication sharedApplication];

    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 420, 300)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    WKWebView *view = [[[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 420, 300)] autorelease];
    [window.contentView addSubview:view];
    check(sp_window_set_main_webview(window, view) != NULL, @"the page is the main web view of its window");
    check(webviewInputRegister(view), @"the page registers for pointer input");
    SPLoaded *loaded = [[SPLoaded new] autorelease];
    view.navigationDelegate = loaded;
    [view loadHTMLString:PAGE baseURL:nil];
    [window orderFront:nil];
    eventWait(@"the navigation of the document finishes", ^BOOL { return loaded.finished; });
    view.navigationDelegate = nil;
    check([evaluate(view, @"Boolean(window.events)") boolValue], @"the page defines its event list");

    // A move makes the window the virtual key window, and a press on the field gives it the focus of the page.
    check(pointer(window, 50, 25, 0) == SP_INPUT_DELIVERED && sp_input_virtual_is(window), @"a move makes the window the virtual key window");
    check(pointer(window, 50, 25, 1) == SP_INPUT_DELIVERED && pointer(window, 50, 25, 3) == SP_INPUT_DELIVERED, @"a press on the field is delivered");
    // The press focuses the field in the task of its mouse down, which the web process runs before the receipt of the up that
    // ended the input above.
    check([evaluate(view, @"document.activeElement.id") isEqual:@"field"], @"the press focuses the field");
    check(window.firstResponder == view, @"the web view holds the keyboard of the window");

    // A Korean text and an accented Latin letter: each key reaches the page as a person's key and inserts its stated text. The
    // key up of a text of one character carries that text; AppKit gives the key up of a longer text the character that the
    // keyboard layout of the system gives the key code, which the person can change while the test runs.
    NSString *records = nil;
    for (NSArray *typed in @[@[@"g", @"한글"], @[@"e", @"é"]]) {
        NSString *text = typed[1];
        NSArray *events = type(window, view, [typed[0] UTF8String], text, &records);
        NSArray *expected = @[[@"keydown:" stringByAppendingString:text], [@"keypress:" stringByAppendingString:text],
            [@"beforeinput:" stringByAppendingString:text], [@"input:" stringByAppendingString:text],
            text.length == 1 ? [@"keyup:" stringByAppendingString:text] : @"keyup:"];
        BOOL same = events.count == expected.count;
        for (NSUInteger i = 0; same && i < expected.count; i++) {
            same = i == 4 && text.length > 1 ? [events[i] hasPrefix:expected[i]] && ![events[i] hasSuffix:@"!"]
                : [events[i] isEqual:expected[i]];
        }
        check(same, [NSString stringWithFormat:@"the key with the text %@ gives the page %@ (got %@)",
            text, [expected componentsJoinedByString:@", "], [events componentsJoinedByString:@", "]]);
        check(recordsTextInput(records, YES), [NSString stringWithFormat:@"the key down record states the text input (records %@)", records]);
        check(recordsContextAbsent(records), [NSString stringWithFormat:@"the web view takes the key down without an input context (records %@)", records]);
    }
    check([value(view) isEqual:@"한글é"], [NSString stringWithFormat:@"the field holds the stated texts (value %@)", value(view)]);

    // A key down that the page cancels inserts nothing, as a person's key does.
    evaluate(view, @"cancel=true");
    NSArray *events = type(window, view, "k", @"ㅋ", &records);
    check([events isEqual:@[@"keydown:ㅋ", @"keyup:ㅋ"]] && [value(view) isEqual:@"한글é"],
        [NSString stringWithFormat:@"a cancelled key down inserts nothing (events %@, value %@)", [events componentsJoinedByString:@", "], value(view)]);
    check(recordsContextAbsent(records), [NSString stringWithFormat:@"the web view takes the cancelled key down without an input context (records %@)", records]);
    evaluate(view, @"cancel=false");

    // A named key runs the command of its key binding: Backspace deletes the last character.
    events = type(window, view, "Backspace", nil, &records);
    check([value(view) isEqual:@"한글"], [NSString stringWithFormat:@"Backspace deletes the last character (events %@, value %@)",
        [events componentsJoinedByString:@", "], value(view)]);
    check(recordsTextInput(records, NO), [NSString stringWithFormat:@"the key down record of a named key states no text input (records %@)", records]);
    check(recordsContextAbsent(records), [NSString stringWithFormat:@"the web view takes the named key down without an input context (records %@)", records]);

    checkWebKitEditEquivalents(window, view);

    [window close];
    [window release];
    return failures == 0 ? 0 : 1;
}}
