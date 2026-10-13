// Reads and changes the selected keyboard input source. Uses the public API of Text Input Sources (HIToolbox).
#import <Carbon/Carbon.h>
#import <Cocoa/Cocoa.h>
#import "input_source.h"
#import "application_log.h"
#import "observe.h"

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
    }
    [sources release];
    return status == noErr;
}

void sp_input_source_await(const char *identifier, void (^adopted)(const char *error)) {
    NSCAssert(NSThread.isMainThread, @"input sources are awaited on the main thread");
    NSString *wanted = identifier ? [NSString stringWithUTF8String:identifier] : nil;
    if (!wanted) {
        adopted("the identifier to await is missing or not valid UTF-8");
        return;
    }
    NSTextInputContext *context = NSTextInputContext.currentInputContext;
    if (!context || [context.selectedKeyboardInputSource isEqualToString:wanted]) {
        adopted(NULL);
        return;
    }
    __block BOOL answered = NO;
    __block id observer = nil;
    void (^answer)(const char *) = ^(const char *error) {
        if (answered) return;
        answered = YES;
        [NSNotificationCenter.defaultCenter removeObserver:observer];
        adopted(error);
    };
    observer = sp_observe_notification("input source await", SP_OBSERVE_RECORD, NSTextInputContextKeyboardSelectionDidChangeNotification,
                                       nil, NSOperationQueue.mainQueue, ^(NSNotification *note) {
        if ([NSTextInputContext.currentInputContext.selectedKeyboardInputSource isEqualToString:wanted]) answer(NULL);
    });
    if (!observer) {
        answer("the selection of the keyboard input source cannot be observed");
        return;
    }
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        NSString *held = NSTextInputContext.currentInputContext.selectedKeyboardInputSource ?: @"no source";
        answer([NSString stringWithFormat:@"the text input context of the key view holds %@, not %@, 2 s after the selection", held, wanted].UTF8String);
    });
}
