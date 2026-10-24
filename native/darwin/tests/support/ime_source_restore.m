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
