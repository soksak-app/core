#import <Cocoa/Cocoa.h>
#import "support/ime_reference_state.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static NSDictionary *state(NSString *document, NSRange selected, NSRange marked) {
    BOOL hasMarked = marked.location != NSNotFound && marked.length > 0;
    return @{
        @"document": document,
        @"selectedRange": NSStringFromRange(selected),
        @"marked": @(hasMarked),
        @"markedRange": NSStringFromRange(marked),
    };
}

int main(void) { @autoreleasepool {
    NSArray<NSString *> *expectedDocuments = @[
        @"ㅏ", @"ㅏㅏ", @"ㅏㅏㅏ", @"ㅏㅏㅏㅏ", @"ㅏㅏㅏㅏㅏ", @"ㅏㅏㅏㅏㅏㅏ",
        @"ㅏㅏㅏㅏㅏㅏㅏ", @"ㅏㅏㅏㅏㅏㅏㅏㅏ", @"ㅏㅏㅏㅏㅏㅏㅏ", @"ㅏㅏㅏㅏㅏㅏㅏ ",
    ];
    for (NSUInteger checkpoint = 0; checkpoint < 10; checkpoint++) {
        NSString *document = sp_ime_reference_expected_document(checkpoint);
        NSString *expectedDocument = expectedDocuments[checkpoint];
        NSRange insertion = NSMakeRange(expectedDocument.length, 0);
        NSDictionary *actual = state(expectedDocument, insertion, insertion);
        check([document isEqual:expectedDocument]
                && sp_ime_reference_state_mismatch(actual, expectedDocument, insertion, insertion) == nil,
            [NSString stringWithFormat:@"reference checkpoint %lu accepts its exact document and ranges",
                (unsigned long)checkpoint + 1]);
    }

    NSString *expected = sp_ime_reference_expected_document(7);
    NSRange selected = NSMakeRange(expected.length, 0);
    NSDictionary *wrongDocument = state(@"wrong", selected, selected);
    NSDictionary *wrongRegion = state(@"wrong", selected, selected);
    BOOL oldPairwiseComparisonAccepts = [wrongDocument[@"document"] isEqual:wrongRegion[@"document"]]
        && [wrongDocument[@"marked"] isEqual:wrongRegion[@"marked"]]
        && [wrongDocument[@"markedRange"] isEqual:wrongRegion[@"markedRange"]]
        && [wrongDocument[@"selectedRange"] isEqual:wrongRegion[@"selectedRange"]];
    check(oldPairwiseComparisonAccepts
            && sp_ime_reference_state_mismatch(wrongDocument, expected, selected, selected) != nil,
        @"the former pairwise-only check accepts equal wrong documents, while fixed reference validation rejects them");

    NSDictionary *wrongSelection = state(expected, NSMakeRange(0, 0), selected);
    check(sp_ime_reference_state_mismatch(wrongSelection, expected, selected, selected) != nil,
        @"an incorrect selected range is rejected");

    NSDictionary *unexpectedMarked = state(expected, selected, NSMakeRange(expected.length - 1, 1));
    check(sp_ime_reference_state_mismatch(unexpectedMarked, expected, selected, selected) != nil,
        @"an unexpected marked range is rejected");

    NSDictionary *missingRange = @{@"document": expected, @"marked": @NO};
    check(sp_ime_reference_state_mismatch(missingRange, expected, selected, selected) != nil,
        @"missing selection and marked ranges are rejected");

    check(sp_ime_reference_expected_document(10) == nil, @"an unknown checkpoint has no expected document");
    return failures == 0 ? 0 : 1;
} }
