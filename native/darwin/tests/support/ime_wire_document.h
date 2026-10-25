#import <Cocoa/Cocoa.h>

static inline BOOL sp_ime_wire_is_boolean(id value) {
    return [value isKindOfClass:NSNumber.class] && CFGetTypeID((CFTypeRef)value) == CFBooleanGetTypeID();
}

static inline BOOL sp_ime_wire_range(id value, NSRange *range) {
    if (![value isKindOfClass:NSDictionary.class]) return NO;
    id location = value[@"location"];
    id length = value[@"length"];
    if (![location isKindOfClass:NSNumber.class] || ![length isKindOfClass:NSNumber.class]
        || sp_ime_wire_is_boolean(location) || sp_ime_wire_is_boolean(length)
        || CFNumberIsFloatType((CFNumberRef)location) || CFNumberIsFloatType((CFNumberRef)length)) return NO;
    long long rawLocation = [location longLongValue];
    long long rawLength = [length longLongValue];
    if (rawLocation < 0 || rawLength < 0 || rawLocation > NSIntegerMax - rawLength) return NO;
    if (range) *range = NSMakeRange((NSUInteger)rawLocation, (NSUInteger)rawLength);
    return YES;
}

static inline NSString *sp_ime_wire_document(NSArray<NSDictionary *> *transactions, NSRange *selectedRange) {
    NSTextView *consumer = [[[NSTextView alloc] initWithFrame:NSMakeRect(0, 0, 320, 80)] autorelease];
    consumer.editable = YES;
    NSString *preedit = @"";
    NSRange preeditSelection = NSMakeRange(0, 0);

    for (NSDictionary *transaction in transactions) {
        if (![transaction isKindOfClass:NSDictionary.class] || ![transaction[@"type"] isEqual:@"input"]
            || ![transaction[@"actions"] isKindOfClass:NSArray.class]
            || ![transaction[@"errors"] isKindOfClass:NSArray.class] || [transaction[@"errors"] count] != 0) return nil;

        NSDictionary *snapshot = transaction[@"preedit"];
        if (![snapshot isKindOfClass:NSDictionary.class]
            || ![snapshot[@"text"] isKindOfClass:NSString.class]
            || !sp_ime_wire_is_boolean(snapshot[@"attributed"])) return nil;
        NSRange markedRange = NSMakeRange(NSNotFound, 0);
        if (snapshot[@"markedRange"] != NSNull.null
            && !sp_ime_wire_range(snapshot[@"markedRange"], &markedRange)) return nil;
        if (!sp_ime_wire_range(snapshot[@"selectedRange"], &preeditSelection)) return nil;
        if (snapshot[@"replacementRange"] != NSNull.null) return nil;
        preedit = snapshot[@"text"];
        if (preedit.length) {
            if (markedRange.location != 0 || markedRange.length != preedit.length
                || NSMaxRange(preeditSelection) > preedit.length) return nil;
        } else if (markedRange.location != NSNotFound || markedRange.length != 0
            || !NSEqualRanges(preeditSelection, NSMakeRange(0, 0))) {
            return nil;
        }

        for (NSDictionary *action in transaction[@"actions"]) {
            if (![action isKindOfClass:NSDictionary.class] || ![action[@"type"] isKindOfClass:NSString.class]) return nil;
            NSString *type = action[@"type"];
            if ([type isEqual:@"insert"]) {
                id text = action[@"text"];
                if (![text isKindOfClass:NSString.class] || !sp_ime_wire_is_boolean(action[@"attributed"])) return nil;
                if (action[@"replacementRange"] != NSNull.null) return nil;
                [consumer insertText:text replacementRange:NSMakeRange(NSNotFound, 0)];
            } else if ([type isEqual:@"command"]) {
                id selectorName = action[@"selector"];
                if (![selectorName isKindOfClass:NSString.class]) return nil;
                if ([selectorName isEqual:@"deleteBackward:"]) [consumer deleteBackward:nil];
                else if ([selectorName isEqual:@"insertNewline:"])
                    [consumer insertText:@"\n" replacementRange:NSMakeRange(NSNotFound, 0)];
                else return nil;
            } else if ([type isEqual:@"key"]) {
                if (![action[@"key"] isKindOfClass:NSString.class]) return nil;
                if ([action[@"key"] isEqual:@"Backspace"]) [consumer deleteBackward:nil];
                else return nil;
            } else if ([type isEqual:@"focus"]) {
                if (!sp_ime_wire_is_boolean(action[@"focused"])) return nil;
            } else {
                return nil;
            }
        }
    }

    if (selectedRange) {
        NSRange caret = consumer.selectedRange;
        if (preedit.length) {
            *selectedRange = NSMakeRange(caret.location + preeditSelection.location, preeditSelection.length);
        } else {
            *selectedRange = caret;
        }
    }
    return [consumer.string stringByAppendingString:preedit];
}
