#import <Cocoa/Cocoa.h>

static inline NSString *sp_ime_wire_document(NSArray<NSDictionary *> *events, NSRange *selectedRange) {
    NSTextView *consumer = [[[NSTextView alloc] initWithFrame:NSMakeRect(0, 0, 320, 80)] autorelease];
    consumer.editable = YES;
    NSString *preedit = @"";
    NSDictionary *lastCompose = nil;
    for (NSDictionary *event in events) {
        NSString *type = event[@"type"];
        if ([type isEqual:@"compose"] && [event[@"text"] isKindOfClass:NSString.class]) {
            preedit = event[@"text"];
            lastCompose = event;
        } else if ([type isEqual:@"insert"] && [event[@"text"] isKindOfClass:NSString.class]) {
            [consumer insertText:event[@"text"] replacementRange:NSMakeRange(NSNotFound, 0)];
        } else if ([type isEqual:@"key"] && [event[@"key"] isEqual:@"Backspace"]) {
            [consumer deleteBackward:nil];
        } else {
            return nil;
        }
    }
    if (selectedRange) {
        NSRange caret = consumer.selectedRange;
        NSDictionary *reported = lastCompose[@"selectedRange"];
        if (preedit.length && [reported isKindOfClass:NSDictionary.class]
            && [reported[@"location"] isKindOfClass:NSNumber.class]
            && [reported[@"length"] isKindOfClass:NSNumber.class]) {
            *selectedRange = NSMakeRange(caret.location + [reported[@"location"] unsignedIntegerValue],
                [reported[@"length"] unsignedIntegerValue]);
        } else {
            *selectedRange = caret;
        }
    }
    return [consumer.string stringByAppendingString:preedit];
}
