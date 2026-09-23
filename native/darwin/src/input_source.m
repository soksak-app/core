// 선택된 키보드 입력 소스를 읽고 바꾼다. Text Input Sources(HIToolbox)의 공개 API 를 사용한다.
#import <Carbon/Carbon.h>
#import <Foundation/Foundation.h>
#import "input_source.h"

char *sp_input_source_current(void) {
    NSCAssert(NSThread.isMainThread, @"input sources are read on the main thread");
    TISInputSourceRef current = TISCopyCurrentKeyboardInputSource();
    if (!current) return NULL;
    NSString *identifier = (NSString *)TISGetInputSourceProperty(current, kTISPropertyInputSourceID);
    char *result = identifier ? strdup(identifier.UTF8String) : NULL;
    CFRelease(current);
    return result;
}

bool sp_input_source_select(const char *identifier) {
    NSCAssert(NSThread.isMainThread, @"input sources are selected on the main thread");
    if (!identifier) return false;
    NSString *wanted = [NSString stringWithUTF8String:identifier];
    if (!wanted) return false;
    NSArray *sources = (NSArray *)TISCreateInputSourceList(
        (CFDictionaryRef)@{(id)kTISPropertyInputSourceID: wanted}, false);
    bool selected = sources.count > 0 && TISSelectInputSource((TISInputSourceRef)sources[0]) == noErr;
    [sources release];
    return selected;
}
