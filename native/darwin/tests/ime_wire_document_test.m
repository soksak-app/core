#import <Cocoa/Cocoa.h>
#import "support/ime_reference_state.h"
#import "support/ime_wire_document.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static NSDictionary *preedit(NSString *text, NSUInteger selection) {
    id markedRange = text.length ? @{@"location": @0, @"length": @(text.length)} : NSNull.null;
    return @{@"text": text, @"markedRange": markedRange,
        @"selectedRange": @{@"location": @(selection), @"length": @0},
        @"replacementRange": NSNull.null, @"attributed": @NO};
}

static NSDictionary *input(NSArray<NSDictionary *> *actions, NSString *text, NSUInteger selection) {
    return @{@"type": @"input", @"actions": actions, @"preedit": preedit(text, selection), @"errors": @[]};
}

static NSDictionary *insertAction(NSString *text) {
    return @{@"type": @"insert", @"text": text,
        @"replacementRange": NSNull.null, @"attributed": @NO};
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    NSMutableArray<NSDictionary *> *transactions = [NSMutableArray array];
    NSMutableArray<NSString *> *documents = [NSMutableArray array];
    NSMutableArray<NSValue *> *selections = [NSMutableArray array];
    NSArray<NSString *> *expected = @[
        @"ㅏ", @"ㅏㅏ", @"ㅏㅏㅏ", @"ㅏㅏㅏㅏ", @"ㅏㅏㅏㅏㅏ",
        @"ㅏㅏㅏㅏㅏㅏ", @"ㅏㅏㅏㅏㅏㅏㅏ", @"ㅏㅏㅏㅏㅏㅏㅏㅏ",
        @"ㅏㅏㅏㅏㅏㅏㅏ", @"ㅏㅏㅏㅏㅏㅏㅏ ",
    ];

    NSRange selected = NSMakeRange(NSNotFound, 0);
    for (NSUInteger index = 0; index < 7; index++) {
        [transactions addObject:input(@[insertAction(@"ㅏ")], @"", 0)];
        [documents addObject:sp_ime_wire_document(transactions, &selected)];
        [selections addObject:[NSValue valueWithRange:selected]];
    }
    [transactions addObject:input(@[], @"ㅏ", 1)];
    [documents addObject:sp_ime_wire_document(transactions, &selected)];
    [selections addObject:[NSValue valueWithRange:selected]];
    [transactions addObject:input(@[
        insertAction(@"ㅏ"), @{@"type": @"command", @"selector": @"deleteBackward:"},
    ], @"", 0)];
    [documents addObject:sp_ime_wire_document(transactions, &selected)];
    [selections addObject:[NSValue valueWithRange:selected]];
    [transactions addObject:input(@[insertAction(@" ")], @"", 0)];
    [documents addObject:sp_ime_wire_document(transactions, &selected)];
    [selections addObject:[NSValue valueWithRange:selected]];

    for (NSUInteger checkpoint = 0; checkpoint < expected.count; checkpoint++) {
        check([documents[checkpoint] isEqual:expected[checkpoint]]
                && NSEqualRanges(selections[checkpoint].rangeValue,
                    NSMakeRange(expected[checkpoint].length, 0)),
            [NSString stringWithFormat:@"AppKit wire document checkpoint %lu is %@ (expected %@)",
                (unsigned long)checkpoint + 1, documents[checkpoint], expected[checkpoint]]);
    }

    NSDictionary *backspace = @{
        @"type": @"input",
        @"actions": @[
            @{@"type": @"insert", @"text": @"ㅏㅏ", @"replacementRange": NSNull.null, @"attributed": @NO},
            @{@"type": @"command", @"selector": @"deleteBackward:"},
        ],
        @"preedit": @{@"text": @"", @"markedRange": NSNull.null,
            @"selectedRange": @{@"location": @0, @"length": @0},
            @"replacementRange": NSNull.null, @"attributed": @NO},
        @"errors": @[],
    };
    selected = NSMakeRange(NSNotFound, 0);
    NSString *transactionDocument = sp_ime_wire_document(@[backspace], &selected);
    check([transactionDocument isEqual:@"ㅏ"] && NSEqualRanges(selected, NSMakeRange(1, 0)),
        [NSString stringWithFormat:@"current input transaction applies its ordered insert and Backspace command (document %@, selection %@)",
            transactionDocument, NSStringFromRange(selected)]);

    NSMutableDictionary *fractionalSnapshot = [preedit(@"", 0) mutableCopy];
    fractionalSnapshot[@"selectedRange"] = @{ @"location": @0.5, @"length": @0 };
    NSDictionary *fractionalRangeInput = @{@"type": @"input", @"actions": @[],
        @"preedit": fractionalSnapshot, @"errors": @[]};
    check(sp_ime_wire_document(@[fractionalRangeInput], NULL) == nil,
        @"fractional input ranges are rejected");
    [fractionalSnapshot release];

    NSMutableDictionary *booleanSnapshot = [preedit(@"", 0) mutableCopy];
    booleanSnapshot[@"selectedRange"] = @{@"location": @NO, @"length": @0};
    NSDictionary *booleanRangeInput = @{@"type": @"input", @"actions": @[],
        @"preedit": booleanSnapshot, @"errors": @[]};
    check(sp_ime_wire_document(@[booleanRangeInput], NULL) == nil,
        @"boolean input ranges are rejected");
    [booleanSnapshot release];

    NSDictionary *noncanonicalEmpty = @{@"type": @"input", @"actions": @[],
        @"preedit": @{@"text": @"", @"markedRange": @{@"location": @0, @"length": @0},
            @"selectedRange": @{@"location": @0, @"length": @0},
            @"replacementRange": NSNull.null, @"attributed": @NO}, @"errors": @[]};
    check(sp_ime_wire_document(@[noncanonicalEmpty], NULL) == nil,
        @"empty preedit requires the current null marked range");

    NSDictionary *offsetEmptySelection = @{@"type": @"input", @"actions": @[],
        @"preedit": @{@"text": @"", @"markedRange": NSNull.null,
            @"selectedRange": @{@"location": @1, @"length": @0},
            @"replacementRange": NSNull.null, @"attributed": @NO}, @"errors": @[]};
    check(sp_ime_wire_document(@[offsetEmptySelection], NULL) == nil,
        @"empty preedit requires a zero selection");

    NSDictionary *rangedInsert = @{@"type": @"input", @"actions": @[
            @{@"type": @"insert", @"text": @"x", @"replacementRange": @{@"location": @0, @"length": @0}, @"attributed": @NO}],
        @"preedit": preedit(@"", 0), @"errors": @[]};
    check(sp_ime_wire_document(@[rangedInsert], NULL) == nil,
        @"current committed insert rejects replacement ranges");
    return failures == 0 ? 0 : 1;
} }
