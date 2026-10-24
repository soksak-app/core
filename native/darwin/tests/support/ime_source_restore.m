#import "ime_source_restore.h"

NSArray<NSString *> *sp_ime_source_select_errors(NSString *expected,
    SPIMESelectAndAwaitSource selectAndAwait, SPIMEReadSource readSource) {
    NSMutableArray<NSString *> *errors = [NSMutableArray array];
    if (expected.length == 0) {
        [errors addObject:@"the expected input source is empty"];
        return errors;
    }
    if (!selectAndAwait || !selectAndAwait(expected)) {
        [errors addObject:[NSString stringWithFormat:@"input source %@ was not selected and adopted", expected]];
    }
    NSString *actual = readSource ? readSource() : nil;
    if (![actual isEqualToString:expected]) {
        [errors addObject:[NSString stringWithFormat:@"input source after selection is %@, expected %@", actual ?: @"unknown", expected]];
    }
    return errors;
}

BOOL sp_ime_source_run_after_adoption(NSString *expected, SPIMESelectAndAwaitSource selectAndAwait,
    SPIMEReadSource readSource, BOOL (^contextAdopted)(void), void (^run)(void),
    NSMutableArray<NSString *> *errors) {
    if (!errors) return NO;
    [errors addObjectsFromArray:sp_ime_source_select_errors(expected, selectAndAwait, readSource)];
    if (errors.count > 0) return NO;
    if (!contextAdopted || !contextAdopted()) {
        [errors addObject:[NSString stringWithFormat:@"the active input context did not adopt %@", expected]];
        return NO;
    }
    if (run) run();
    return YES;
}

NSArray<NSString *> *sp_ime_source_restore_errors(NSString *baselineSource, NSString *outerSource,
    pid_t outerProcessIdentifier, SPIMEReadSource readSource, SPIMEActivateProcess activateProcess,
    SPIMEReadFrontmostProcess readFrontmost, SPIMESelectAndAwaitSource selectAndAwait) {
    NSMutableArray<NSString *> *errors = [NSMutableArray array];
    if (baselineSource.length == 0) [errors addObject:@"the baseline input source is empty"];
    if (outerSource.length == 0) [errors addObject:@"the outer input source is empty"];
    if (outerProcessIdentifier <= 0) [errors addObject:@"the outer frontmost process identifier is invalid"];

    NSString *before = readSource ? readSource() : nil;
    if (baselineSource.length > 0 && ![before isEqualToString:baselineSource]) {
        [errors addObject:[NSString stringWithFormat:@"input source before baseline restoration is %@, expected %@",
            before ?: @"unknown", baselineSource]];
    }

    BOOL activated = outerProcessIdentifier > 0 && activateProcess && activateProcess(outerProcessIdentifier);
    if (!activated) [errors addObject:@"the outer frontmost application was not restored"];
    pid_t frontmost = readFrontmost ? readFrontmost() : 0;
    if (outerProcessIdentifier > 0 && frontmost != outerProcessIdentifier) {
        [errors addObject:[NSString stringWithFormat:@"frontmost process after restoration is %d, expected %d",
            frontmost, outerProcessIdentifier]];
    }
    NSString *afterBaseline = readSource ? readSource() : nil;
    if (baselineSource.length > 0 && ![afterBaseline isEqualToString:baselineSource]) {
        [errors addObject:[NSString stringWithFormat:@"input source after baseline application restoration is %@, expected %@",
            afterBaseline ?: @"unknown", baselineSource]];
    }

    if (outerSource.length > 0 && ![outerSource isEqualToString:baselineSource]) {
        [errors addObjectsFromArray:sp_ime_source_select_errors(outerSource, selectAndAwait, readSource)];
    } else if (outerSource.length > 0 && ![afterBaseline isEqualToString:outerSource]) {
        [errors addObjectsFromArray:sp_ime_source_select_errors(outerSource, selectAndAwait, readSource)];
    }
    NSString *finalSource = readSource ? readSource() : nil;
    if (outerSource.length > 0 && ![finalSource isEqualToString:outerSource]) {
        [errors addObject:[NSString stringWithFormat:@"final input source is %@, expected outer source %@",
            finalSource ?: @"unknown", outerSource]];
    }
    pid_t finalFrontmost = readFrontmost ? readFrontmost() : 0;
    if (outerProcessIdentifier > 0 && finalFrontmost != outerProcessIdentifier) {
        [errors addObject:[NSString stringWithFormat:@"frontmost process after outer source restoration is %d, expected %d",
            finalFrontmost, outerProcessIdentifier]];
    }
    return errors;
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
