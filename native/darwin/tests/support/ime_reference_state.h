#import <Foundation/Foundation.h>

static inline NSString *sp_ime_reference_expected_document(NSUInteger checkpoint) {
    if (checkpoint < 8) {
        return [@"" stringByPaddingToLength:checkpoint + 1 withString:@"ㅏ" startingAtIndex:0];
    }
    if (checkpoint == 8) {
        return [@"" stringByPaddingToLength:7 withString:@"ㅏ" startingAtIndex:0];
    }
    if (checkpoint == 9) {
        return [[@"" stringByPaddingToLength:7 withString:@"ㅏ" startingAtIndex:0] stringByAppendingString:@" "];
    }
    return nil;
}

static inline NSString *sp_ime_reference_state_mismatch(NSDictionary *state, NSString *document,
    NSRange selectedRange, NSRange markedRange) {
    if (![state isKindOfClass:NSDictionary.class]) return @"state is not an object";
    if (![state[@"document"] isKindOfClass:NSString.class] || ![state[@"document"] isEqual:document]) {
        return [NSString stringWithFormat:@"document is %@, expected %@", state[@"document"], document];
    }
    if (![state[@"selectedRange"] isKindOfClass:NSString.class]
        || ![state[@"selectedRange"] isEqual:NSStringFromRange(selectedRange)]) {
        return [NSString stringWithFormat:@"selected range is %@, expected %@", state[@"selectedRange"],
            NSStringFromRange(selectedRange)];
    }
    BOOL expectedMarked = markedRange.location != NSNotFound && markedRange.length > 0;
    if (![state[@"marked"] isKindOfClass:NSNumber.class] || [state[@"marked"] boolValue] != expectedMarked) {
        return [NSString stringWithFormat:@"marked state is %@, expected %@", state[@"marked"], @(expectedMarked)];
    }
    if (![state[@"markedRange"] isKindOfClass:NSString.class]
        || ![state[@"markedRange"] isEqual:NSStringFromRange(markedRange)]) {
        return [NSString stringWithFormat:@"marked range is %@, expected %@", state[@"markedRange"],
            NSStringFromRange(markedRange)];
    }
    return nil;
}
