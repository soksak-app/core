#import <Cocoa/Cocoa.h>
#import "support/ime_reference_state.h"
#import "support/ime_wire_document.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static NSDictionary *compose(NSString *text) {
    return @{ @"type": @"compose", @"text": text,
        @"selectedRange": @{ @"location": @(text.length), @"length": @0 } };
}

static NSDictionary *insert(NSString *text) {
    return @{ @"type": @"insert", @"text": text };
}

static NSDictionary *key(NSString *name) {
    return @{ @"type": @"key", @"key": name };
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    NSMutableArray<NSDictionary *> *events = [NSMutableArray array];
    NSMutableArray<NSString *> *documents = [NSMutableArray array];
    NSMutableArray<NSValue *> *selections = [NSMutableArray array];
    NSArray<NSString *> *expected = @[
        @"ㅏ", @"ㅏㅏ", @"ㅏㅏㅏ", @"ㅏㅏㅏㅏ", @"ㅏㅏㅏㅏㅏ",
        @"ㅏㅏㅏㅏㅏㅏ", @"ㅏㅏㅏㅏㅏㅏㅏ", @"ㅏㅏㅏㅏㅏㅏㅏㅏ",
        @"ㅏㅏㅏㅏㅏㅏㅏ", @"ㅏㅏㅏㅏㅏㅏㅏ ",
    ];

    [events addObject:compose(@"ㅏ")];
    NSRange selected = NSMakeRange(NSNotFound, 0);
    [documents addObject:sp_ime_wire_document(events, &selected)];
    [selections addObject:[NSValue valueWithRange:selected]];
    [events addObject:compose(@"ㅏㅏ")];
    [documents addObject:sp_ime_wire_document(events, &selected)];
    [selections addObject:[NSValue valueWithRange:selected]];
    for (NSUInteger index = 2; index < 8; index++) {
        [events addObject:insert(@"ㅏ")];
        [documents addObject:sp_ime_wire_document(events, &selected)];
        [selections addObject:[NSValue valueWithRange:selected]];
    }
    [events addObject:insert(@"ㅏㅏ")];
    [events addObject:compose(@"")];
    [events addObject:key(@"Backspace")];
    [documents addObject:sp_ime_wire_document(events, &selected)];
    [selections addObject:[NSValue valueWithRange:selected]];
    [events addObject:insert(@" ")];
    [documents addObject:sp_ime_wire_document(events, &selected)];
    [selections addObject:[NSValue valueWithRange:selected]];

    for (NSUInteger checkpoint = 0; checkpoint < expected.count; checkpoint++) {
        check([documents[checkpoint] isEqual:expected[checkpoint]]
                && NSEqualRanges(selections[checkpoint].rangeValue,
                    NSMakeRange(expected[checkpoint].length, 0)),
            [NSString stringWithFormat:@"AppKit wire document checkpoint %lu is %@ (expected %@)",
                (unsigned long)checkpoint + 1, documents[checkpoint], expected[checkpoint]]);
    }
    return failures == 0 ? 0 : 1;
} }
