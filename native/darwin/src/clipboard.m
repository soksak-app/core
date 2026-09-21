#import <Cocoa/Cocoa.h>
#import "clipboard.h"

static char *json(NSDictionary *value) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:NULL];
    if (!data) return NULL;
    char *result = malloc(data.length + 1);
    if (!result) return NULL;
    memcpy(result, data.bytes, data.length);
    result[data.length] = 0;
    return result;
}

static char *status(NSString *value) {
    return json(@{ @"status": value });
}

static char *errorResult(NSString *reason) {
    return json(@{ @"status": @"error", @"error": reason });
}

void *sp_clipboard_open(const char *name) {
    NSCAssert(NSThread.isMainThread, @"clipboard access requires the main thread");
    NSPasteboard *pasteboard = name ? [NSPasteboard pasteboardWithName:
        [NSString stringWithUTF8String:name]] : NSPasteboard.generalPasteboard;
    return pasteboard ? [pasteboard retain] : NULL;
}

void sp_clipboard_close(void *handle) {
    NSCAssert(NSThread.isMainThread, @"clipboard access requires the main thread");
    [(NSPasteboard *)handle release];
}

char *sp_clipboard_read_text(void *handle) {
    NSCAssert(NSThread.isMainThread, @"clipboard access requires the main thread");
    NSPasteboard *pasteboard = (NSPasteboard *)handle;
    if (!pasteboard) return errorResult(@"invalid clipboard");
    for (NSPasteboardItem *item in pasteboard.pasteboardItems) {
        if (![item.types containsObject:NSPasteboardTypeString]) continue;
        NSString *text = [item stringForType:NSPasteboardTypeString];
        if (!text) return errorResult(@"text data could not be decoded");
        return json(@{ @"status": @"ok", @"type": @"text", @"text": text });
    }
    return json(@{ @"status": @"absent", @"type": @"text" });
}

char *sp_clipboard_write_text(void *handle, const char *value) {
    NSCAssert(NSThread.isMainThread, @"clipboard access requires the main thread");
    NSPasteboard *pasteboard = (NSPasteboard *)handle;
    if (!pasteboard || !value) return errorResult(@"invalid text");
    NSString *text = [NSString stringWithUTF8String:value];
    if (!text) return errorResult(@"text is not valid UTF-8");
    [pasteboard clearContents];
    if (![pasteboard setString:text forType:NSPasteboardTypeString]) return errorResult(@"text write failed");
    return status(@"ok");
}

static NSData *decodedPNG(NSData *data) {
    if (!data || data.length > SP_CLIPBOARD_MAX_BYTES) return nil;
    NSBitmapImageRep *image = [[[NSBitmapImageRep alloc] initWithData:data] autorelease];
    return image.CGImage ? data : nil;
}

char *sp_clipboard_read_png(void *handle) {
    NSCAssert(NSThread.isMainThread, @"clipboard access requires the main thread");
    NSPasteboard *pasteboard = (NSPasteboard *)handle;
    if (!pasteboard) return errorResult(@"invalid clipboard");
    for (NSPasteboardItem *item in pasteboard.pasteboardItems) {
        if (![item.types containsObject:NSPasteboardTypePNG]) continue;
        NSData *data = [item dataForType:NSPasteboardTypePNG];
        if (!data || data.length > SP_CLIPBOARD_MAX_BYTES) return errorResult(@"PNG exceeds the size limit");
        if (!decodedPNG(data)) return errorResult(@"PNG decode failed");
        return json(@{ @"status": @"ok", @"type": @"png", @"base64": [data base64EncodedStringWithOptions:0] });
    }
    return json(@{ @"status": @"absent", @"type": @"png" });
}

char *sp_clipboard_write_png(void *handle, const unsigned char *bytes, size_t length) {
    NSCAssert(NSThread.isMainThread, @"clipboard access requires the main thread");
    NSPasteboard *pasteboard = (NSPasteboard *)handle;
    if (!pasteboard || !bytes || !length) return errorResult(@"invalid PNG");
    if (length > SP_CLIPBOARD_MAX_BYTES) return errorResult(@"PNG exceeds the size limit");
    NSData *data = [NSData dataWithBytes:bytes length:length];
    if (!decodedPNG(data)) return errorResult(@"PNG decode failed");
    [pasteboard clearContents];
    if (![pasteboard setData:data forType:NSPasteboardTypePNG]) return errorResult(@"PNG write failed");
    return status(@"ok");
}

char *sp_clipboard_read_file_urls(void *handle) {
    NSCAssert(NSThread.isMainThread, @"clipboard access requires the main thread");
    NSPasteboard *pasteboard = (NSPasteboard *)handle;
    if (!pasteboard) return errorResult(@"invalid clipboard");
    NSMutableArray *urls = [NSMutableArray array];
    BOOL found = NO;
    for (NSPasteboardItem *item in pasteboard.pasteboardItems) {
        if (![item.types containsObject:NSPasteboardTypeFileURL]) continue;
        found = YES;
        NSString *value = [item stringForType:NSPasteboardTypeFileURL];
        NSURL *url = value ? [NSURL URLWithString:value] : nil;
        if (!url || ![url.scheme.lowercaseString isEqualToString:@"file"])
            return errorResult(@"file URL could not be decoded");
        [urls addObject:url.absoluteString];
    }
    if (!found) return json(@{ @"status": @"absent", @"type": @"fileURLs" });
    return json(@{ @"status": @"ok", @"type": @"fileURLs", @"urls": urls });
}
