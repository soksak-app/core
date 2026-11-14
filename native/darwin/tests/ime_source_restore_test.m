// Judges the decisions of the input source restoration of the input method checks (support/ime_source_restore.m) as functions
// of the readings that the system gave. Each case is a table row: the readings in, the errors out. The operations on the system
// (TISSelectInputSource, the activation of the outer application) run in ime_source_restore_system_test, a test of
// make test-app-activation.
#import <Cocoa/Cocoa.h>
#import "support/ime_source_restore.h"

static int failures = 0;
static NSString *const ABC = @"com.apple.keylayout.ABC";
static NSString *const KOREAN = @"com.apple.inputmethod.Korean.2SetKorean";

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static void checkErrors(NSArray<NSString *> *errors, NSString *expected, NSString *name) {
    NSString *joined = [errors componentsJoinedByString:@"|"];
    check([joined isEqualToString:expected], [NSString stringWithFormat:@"%@ (errors %@, expected %@)", name, joined, expected]);
}

typedef struct {
    NSString *name;
    NSString *expected;
    BOOL selected;
    NSString *actual;
    NSString *errors;
} SelectRow;

typedef struct {
    NSString *name;
    NSString *baseline;
    NSString *outer;
    NSString *afterBaseline;
    BOOL needed;
} NeededRow;

typedef struct {
    NSString *name;
    NSString *baseline;
    NSString *outer;
    pid_t outerProcess;
    SPIMERestoreReadings readings;
    NSString *errors;
} RestoreRow;

int main(void) { @autoreleasepool {
    SelectRow selectRows[] = {
        {@"a selected source that the system reports passes", ABC, YES, ABC, @""},
        {@"a refused selection is reported with the source that stayed", ABC, NO, KOREAN,
            @"input source com.apple.keylayout.ABC was not selected and adopted|"
            @"input source after selection is com.apple.inputmethod.Korean.2SetKorean, expected com.apple.keylayout.ABC"},
        {@"an unreadable source after the selection is reported", ABC, YES, nil,
            @"input source after selection is unknown, expected com.apple.keylayout.ABC"},
        {@"an empty expected source is reported alone", @"", YES, ABC, @"the expected input source is empty"},
    };
    for (size_t i = 0; i < sizeof selectRows / sizeof selectRows[0]; i++) {
        checkErrors(sp_ime_source_select_verdict(selectRows[i].expected, selectRows[i].selected, selectRows[i].actual),
            selectRows[i].errors, selectRows[i].name);
    }

    NeededRow neededRows[] = {
        {@"an outer source that differs from the baseline is selected", ABC, KOREAN, ABC, YES},
        {@"an outer source that equals the baseline and the source after the restoration is not selected", ABC, ABC, ABC, NO},
        {@"an outer source that equals the baseline but not the source after the restoration is selected", ABC, ABC, KOREAN, YES},
        {@"an empty outer source is never selected", ABC, @"", ABC, NO},
    };
    for (size_t i = 0; i < sizeof neededRows / sizeof neededRows[0]; i++) {
        BOOL needed = sp_ime_source_outer_selection_needed(neededRows[i].baseline, neededRows[i].outer,
            neededRows[i].afterBaseline);
        check(needed == neededRows[i].needed, [NSString stringWithFormat:@"%@ (needed %d)", neededRows[i].name, needed]);
    }

    NSArray<NSString *> *selectError = @[@"input source com.apple.inputmethod.Korean.2SetKorean was not selected and adopted"];
    checkErrors(sp_ime_source_adoption_verdict(KOREAN, @[], YES), @"",
        @"a selected source and an adopting context let the gesture run");
    checkErrors(sp_ime_source_adoption_verdict(KOREAN, selectError, YES), selectError[0],
        @"a selection error prevents the gesture keys");
    checkErrors(sp_ime_source_adoption_verdict(KOREAN, @[], NO),
        @"the active input context did not adopt com.apple.inputmethod.Korean.2SetKorean",
        @"an unadopted context prevents the gesture keys");

    RestoreRow restoreRows[] = {
        {@"the baseline source and outer state restore without errors", ABC, KOREAN, 100,
            {ABC, YES, 100, ABC, YES, YES, KOREAN, KOREAN, 100}, @""},
        {@"an outer source that equals the baseline needs no selection", ABC, ABC, 100,
            {ABC, YES, 100, ABC, NO, NO, nil, ABC, 100}, @""},
        {@"an application restoration failure is retained with the frontmost process", ABC, KOREAN, 100,
            {ABC, NO, 200, ABC, YES, YES, KOREAN, KOREAN, 200},
            @"the outer frontmost application was not restored|"
            @"frontmost process after restoration is 200, expected 100|"
            @"frontmost process after outer source restoration is 200, expected 100"},
        {@"an outer source selection failure is reported with the final source", ABC, KOREAN, 100,
            {ABC, YES, 100, ABC, YES, NO, ABC, ABC, 100},
            @"input source com.apple.inputmethod.Korean.2SetKorean was not selected and adopted|"
            @"input source after selection is com.apple.keylayout.ABC, expected com.apple.inputmethod.Korean.2SetKorean|"
            @"final input source is com.apple.keylayout.ABC, expected outer source com.apple.inputmethod.Korean.2SetKorean"},
        {@"a source that is not the baseline before and after the application restoration is reported", ABC, ABC, 100,
            {KOREAN, YES, 100, KOREAN, YES, YES, ABC, ABC, 100},
            @"input source before baseline restoration is com.apple.inputmethod.Korean.2SetKorean, expected com.apple.keylayout.ABC|"
            @"input source after baseline application restoration is com.apple.inputmethod.Korean.2SetKorean, expected com.apple.keylayout.ABC"},
        {@"a needed selection that did not run is reported", ABC, KOREAN, 100,
            {ABC, YES, 100, ABC, NO, NO, nil, KOREAN, 100},
            @"input source com.apple.inputmethod.Korean.2SetKorean was not selected and adopted|"
            @"input source after selection is unknown, expected com.apple.inputmethod.Korean.2SetKorean"},
        {@"empty sources and an invalid process identifier are each reported", @"", @"", 0,
            {nil, NO, 0, nil, NO, NO, nil, nil, 0},
            @"the baseline input source is empty|the outer input source is empty|"
            @"the outer frontmost process identifier is invalid|the outer frontmost application was not restored"},
    };
    for (size_t i = 0; i < sizeof restoreRows / sizeof restoreRows[0]; i++) {
        checkErrors(sp_ime_source_restore_verdict(restoreRows[i].baseline, restoreRows[i].outer,
            restoreRows[i].outerProcess, restoreRows[i].readings), restoreRows[i].errors, restoreRows[i].name);
    }
    return failures ? 1 : 0;
} }
