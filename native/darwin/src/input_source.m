// Reads and changes the selected keyboard input source. Uses the public API of Text Input Sources (HIToolbox).
#import <Carbon/Carbon.h>
#import <Cocoa/Cocoa.h>
#import "input_source.h"
#import "application_log.h"

char *sp_input_source_current(void) {
    NSCAssert(NSThread.isMainThread, @"input sources are read on the main thread");
    TISInputSourceRef current = TISCopyCurrentKeyboardInputSource();
    if (!current) {
        sp_log_error("input source", "the system returned no current keyboard input source");
        return NULL;
    }
    NSString *identifier = (NSString *)TISGetInputSourceProperty(current, kTISPropertyInputSourceID);
    char *result = identifier ? strdup(identifier.UTF8String) : NULL;
    CFRelease(current);
    return result;
}

bool sp_input_source_select(const char *identifier) {
    NSCAssert(NSThread.isMainThread, @"input sources are selected on the main thread");
    if (!identifier) {
        sp_log_error("input source", "the identifier to select is missing");
        return false;
    }
    NSString *wanted = [NSString stringWithUTF8String:identifier];
    if (!wanted) {
        sp_log_error("input source", "the identifier to select is not valid UTF-8");
        return false;
    }
    NSArray *sources = (NSArray *)TISCreateInputSourceList(
        (CFDictionaryRef)@{(id)kTISPropertyInputSourceID: wanted}, false);
    OSStatus status = sources.count > 0 ? TISSelectInputSource((TISInputSourceRef)sources[0]) : paramErr;
    if (status != noErr) {
        sp_log_error("input source", [NSString stringWithFormat:@"selecting %@ failed: %@ (status %d)", wanted,
            sources.count > 0 ? @"the system refused it" : @"no input source has this identifier", (int)status].UTF8String);
        [sources release];
        return false;
    }
    [sources release];
    // The text input context of the key view adopts a source that the system selected only later, so a key typed at once
    // reaches the earlier source. The context of the key view takes the source here, and the selection answers after it holds it.
    NSTextInputContext *context = NSTextInputContext.currentInputContext;
    if (context) {
        context.selectedKeyboardInputSource = wanted;
        if (![context.selectedKeyboardInputSource isEqualToString:wanted]) {
            sp_log_error("input source", [NSString stringWithFormat:@"the text input context of the key view holds %@ after %@ was selected",
                context.selectedKeyboardInputSource, wanted].UTF8String);
            return false;
        }
    }
    return true;
}
