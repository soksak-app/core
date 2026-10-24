#import <AppKit/AppKit.h>
#import <Carbon/Carbon.h>
#include <unistd.h>

int main(void) {
    @autoreleasepool {
        TISInputSourceRef current = TISCopyCurrentKeyboardInputSource();
        if (!current) {
            fprintf(stderr, "source probe: the system returned no current keyboard input source\n");
            return 1;
        }
        CFTypeRef property = TISGetInputSourceProperty(current, kTISPropertyInputSourceID);
        NSString *source = [(id)property isKindOfClass:NSString.class] ? [(NSString *)property copy] : nil;
        CFRelease(current);
        NSRunningApplication *frontmost = NSWorkspace.sharedWorkspace.frontmostApplication;
        if (!source || !frontmost || frontmost.processIdentifier <= 0) {
            fprintf(stderr, "source probe: the current source or frontmost process is unavailable\n");
            [source release];
            return 1;
        }
        NSDictionary *snapshot = @{
            @"source": source,
            @"frontmostPID": @(frontmost.processIdentifier),
            @"processPID": @(getpid()),
        };
        [source release];
        NSError *error = nil;
        NSData *json = [NSJSONSerialization dataWithJSONObject:snapshot options:0 error:&error];
        if (!json) {
            fprintf(stderr, "source probe: JSON serialization failed: %s\n",
                error.localizedDescription.UTF8String ?: "unknown error");
            return 1;
        }
        fwrite(json.bytes, 1, json.length, stdout);
        fputc('\n', stdout);
        return 0;
    }
}
