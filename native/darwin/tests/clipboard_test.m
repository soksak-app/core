#import <Cocoa/Cocoa.h>
#import "clipboard.h"

static int failures;
static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static NSDictionary *readJSON(char *value) {
    if (!value) return nil;
    NSData *data = [NSData dataWithBytes:value length:strlen(value)];
    free(value);
    return [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
}

static NSData *pngData(void) {
    NSBitmapImageRep *image = [[[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:2
        pixelsHigh:2 bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace
        bitmapFormat:0 bytesPerRow:0 bitsPerPixel:0] autorelease];
    unsigned char *pixels = image.bitmapData;
    for (NSUInteger i = 0; i < 16; i++) pixels[i] = (i % 4 == 3) ? 255 : 80;
    return [image representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    NSString *name = [NSString stringWithFormat:@"soksak-test-clipboard-%@", NSUUID.UUID.UUIDString];
    void *clipboard = sp_clipboard_open(name.UTF8String);
    check(clipboard != NULL, @"a named clipboard is opened for dependency injection");
    NSPasteboard *board = [NSPasteboard pasteboardWithName:name];

    [board clearContents];
    NSDictionary *absentText = readJSON(sp_clipboard_read_text(clipboard));
    check([absentText[@"status"] isEqual:@"absent"], @"missing text is reported as absent");
    NSDictionary *writeText = readJSON(sp_clipboard_write_text(clipboard, "hello"));
    NSDictionary *readText = readJSON(sp_clipboard_read_text(clipboard));
    check([writeText[@"status"] isEqual:@"ok"] && [readText[@"text"] isEqual:@"hello"],
        @"text writes and reads without coercion");
    readText = readJSON(sp_clipboard_write_text(clipboard, ""));
    NSDictionary *emptyText = readJSON(sp_clipboard_read_text(clipboard));
    check([readText[@"status"] isEqual:@"ok"] && [emptyText[@"status"] isEqual:@"ok"] && [emptyText[@"text"] isEqual:@""],
        @"empty text remains an explicit empty value");

    NSData *png = pngData();
    [board clearContents];
    [board declareTypes:@[ NSPasteboardTypeString, NSPasteboardTypePNG ] owner:nil];
    [board setString:@"caption" forType:NSPasteboardTypeString];
    [board setData:png forType:NSPasteboardTypePNG];
    NSDictionary *bothText = readJSON(sp_clipboard_read_text(clipboard));
    NSDictionary *bothPNG = readJSON(sp_clipboard_read_png(clipboard));
    NSData *decoded = [[[NSData alloc] initWithBase64EncodedString:bothPNG[@"base64"] options:0] autorelease];
    check([bothText[@"text"] isEqual:@"caption"] && [bothPNG[@"status"] isEqual:@"ok"] && decoded.length == png.length,
        @"text and PNG types remain independently readable with explicit priority");
    NSDictionary *writePNG = readJSON(sp_clipboard_write_png(clipboard, png.bytes, png.length));
    NSDictionary *readWrittenPNG = readJSON(sp_clipboard_read_png(clipboard));
    check([writePNG[@"status"] isEqual:@"ok"] && [readWrittenPNG[@"status"] isEqual:@"ok"],
        @"PNG bytes write and read without an image file side effect");

    [board clearContents];
    [board setData:[NSData dataWithBytes:"bad" length:3] forType:NSPasteboardTypePNG];
    NSDictionary *badPNG = readJSON(sp_clipboard_read_png(clipboard));
    check([badPNG[@"status"] isEqual:@"error"], @"malformed PNG is an explicit decode error");
    [board clearContents];
    NSDictionary *missingPNG = readJSON(sp_clipboard_read_png(clipboard));
    check([missingPNG[@"status"] isEqual:@"absent"], @"missing PNG is not coerced from text");

    [board clearContents];
    [board writeObjects:@[[NSURL fileURLWithPath:@"/tmp/soksak-a"], [NSURL fileURLWithPath:@"/tmp/soksak-b"]]];
    NSDictionary *files = readJSON(sp_clipboard_read_file_urls(clipboard));
    check([files[@"status"] isEqual:@"ok"] && [files[@"urls"] count] == 2,
        @"file URL items are returned as a list");
    [board clearContents];
    NSDictionary *missingFiles = readJSON(sp_clipboard_read_file_urls(clipboard));
    check([missingFiles[@"status"] isEqual:@"absent"], @"missing file URLs are explicit absent");

    NSMutableData *oversized = [NSMutableData dataWithLength:SP_CLIPBOARD_MAX_BYTES + 1];
    NSDictionary *tooLarge = readJSON(sp_clipboard_write_png(clipboard, oversized.bytes, oversized.length));
    check([tooLarge[@"status"] isEqual:@"error"], @"oversized PNG input is rejected before decoding");
    sp_clipboard_close(clipboard);
    return failures ? 1 : 0;
} }
