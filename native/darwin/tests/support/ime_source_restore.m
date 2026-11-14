#import "ime_source_restore.h"

NSArray<NSString *> *sp_ime_source_select_verdict(NSString *expected, BOOL selected, NSString *actual) {
    NSMutableArray<NSString *> *errors = [NSMutableArray array];
    if (expected.length == 0) {
        [errors addObject:@"the expected input source is empty"];
        return errors;
    }
    if (!selected) {
        [errors addObject:[NSString stringWithFormat:@"input source %@ was not selected and adopted", expected]];
    }
    if (![actual isEqualToString:expected]) {
        [errors addObject:[NSString stringWithFormat:@"input source after selection is %@, expected %@", actual ?: @"unknown", expected]];
    }
    return errors;
}

NSArray<NSString *> *sp_ime_source_select_errors(NSString *expected,
    SPIMESelectAndAwaitSource selectAndAwait, SPIMEReadSource readSource) {
    if (expected.length == 0) return sp_ime_source_select_verdict(expected, NO, nil);
    BOOL selected = selectAndAwait && selectAndAwait(expected);
    return sp_ime_source_select_verdict(expected, selected, readSource ? readSource() : nil);
}

NSArray<NSString *> *sp_ime_source_adoption_verdict(NSString *expected, NSArray<NSString *> *selectErrors,
    BOOL contextAdopted) {
    if (selectErrors.count > 0) return selectErrors;
    if (!contextAdopted) {
        return @[[NSString stringWithFormat:@"the active input context did not adopt %@", expected]];
    }
    return @[];
}

BOOL sp_ime_source_run_after_adoption(NSString *expected, SPIMESelectAndAwaitSource selectAndAwait,
    SPIMEReadSource readSource, BOOL (^contextAdopted)(void), void (^run)(void),
    NSMutableArray<NSString *> *errors) {
    if (!errors) return NO;
    NSArray<NSString *> *selectErrors = sp_ime_source_select_errors(expected, selectAndAwait, readSource);
    NSArray<NSString *> *verdict = sp_ime_source_adoption_verdict(expected, selectErrors,
        selectErrors.count == 0 && contextAdopted && contextAdopted());
    [errors addObjectsFromArray:verdict];
    if (verdict.count > 0) return NO;
    if (run) run();
    return YES;
}

BOOL sp_ime_source_outer_selection_needed(NSString *baselineSource, NSString *outerSource, NSString *afterBaseline) {
    if (outerSource.length == 0) return NO;
    return ![outerSource isEqualToString:baselineSource] || ![afterBaseline isEqualToString:outerSource];
}

NSArray<NSString *> *sp_ime_source_restore_verdict(NSString *baselineSource, NSString *outerSource,
    pid_t outerProcessIdentifier, SPIMERestoreReadings readings) {
    NSMutableArray<NSString *> *errors = [NSMutableArray array];
    if (baselineSource.length == 0) [errors addObject:@"the baseline input source is empty"];
    if (outerSource.length == 0) [errors addObject:@"the outer input source is empty"];
    if (outerProcessIdentifier <= 0) [errors addObject:@"the outer frontmost process identifier is invalid"];

    if (baselineSource.length > 0 && ![readings.before isEqualToString:baselineSource]) {
        [errors addObject:[NSString stringWithFormat:@"input source before baseline restoration is %@, expected %@",
            readings.before ?: @"unknown", baselineSource]];
    }
    if (!(outerProcessIdentifier > 0 && readings.activated)) [errors addObject:@"the outer frontmost application was not restored"];
    if (outerProcessIdentifier > 0 && readings.frontmost != outerProcessIdentifier) {
        [errors addObject:[NSString stringWithFormat:@"frontmost process after restoration is %d, expected %d",
            readings.frontmost, outerProcessIdentifier]];
    }
    if (baselineSource.length > 0 && ![readings.afterBaseline isEqualToString:baselineSource]) {
        [errors addObject:[NSString stringWithFormat:@"input source after baseline application restoration is %@, expected %@",
            readings.afterBaseline ?: @"unknown", baselineSource]];
    }
    if (sp_ime_source_outer_selection_needed(baselineSource, outerSource, readings.afterBaseline)) {
        [errors addObjectsFromArray:sp_ime_source_select_verdict(outerSource,
            readings.selectionRan && readings.selected, readings.selectionActual)];
    }
    if (outerSource.length > 0 && ![readings.finalSource isEqualToString:outerSource]) {
        [errors addObject:[NSString stringWithFormat:@"final input source is %@, expected outer source %@",
            readings.finalSource ?: @"unknown", outerSource]];
    }
    if (outerProcessIdentifier > 0 && readings.finalFrontmost != outerProcessIdentifier) {
        [errors addObject:[NSString stringWithFormat:@"frontmost process after outer source restoration is %d, expected %d",
            readings.finalFrontmost, outerProcessIdentifier]];
    }
    return errors;
}

NSArray<NSString *> *sp_ime_source_restore_errors(NSString *baselineSource, NSString *outerSource,
    pid_t outerProcessIdentifier, SPIMEReadSource readSource, SPIMEActivateProcess activateProcess,
    SPIMEReadFrontmostProcess readFrontmost, SPIMESelectAndAwaitSource selectAndAwait) {
    SPIMERestoreReadings readings = {0};
    readings.before = readSource ? readSource() : nil;
    readings.activated = outerProcessIdentifier > 0 && activateProcess && activateProcess(outerProcessIdentifier);
    readings.frontmost = readFrontmost ? readFrontmost() : 0;
    readings.afterBaseline = readSource ? readSource() : nil;
    if (sp_ime_source_outer_selection_needed(baselineSource, outerSource, readings.afterBaseline)) {
        readings.selectionRan = YES;
        readings.selected = selectAndAwait && selectAndAwait(outerSource);
        readings.selectionActual = readSource ? readSource() : nil;
    }
    readings.finalSource = readSource ? readSource() : nil;
    readings.finalFrontmost = readFrontmost ? readFrontmost() : 0;
    return sp_ime_source_restore_verdict(baselineSource, outerSource, outerProcessIdentifier, readings);
}

NSArray<NSString *> *sp_ime_source_cleanup_errors(NSString *baselineSource, NSString *outerSource,
    pid_t outerProcessIdentifier, SPIMEReadSource readSource, SPIMEActivateProcess activateProcess,
    SPIMEReadFrontmostProcess readFrontmost, SPIMESelectAndAwaitSource selectAndAwait,
    void (^closeTestContext)(void)) {
    NSMutableArray<NSString *> *errors = [NSMutableArray arrayWithArray:
        sp_ime_source_select_errors(baselineSource, selectAndAwait, readSource)];
    if (closeTestContext) closeTestContext();
    else [errors addObject:@"the active IME test context could not be closed"];
    [errors addObjectsFromArray:sp_ime_source_restore_errors(baselineSource, outerSource,
        outerProcessIdentifier, readSource, activateProcess, readFrontmost, selectAndAwait)];
    return errors;
}
