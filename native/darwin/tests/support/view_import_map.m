#import "view_import_map.h"

NSString *viewImportMapFixture(void) {
    NSData *data = [NSData dataWithContentsOfFile:[NSString stringWithUTF8String:VIEW_PAGE_CASES]];
    NSDictionary *fixture = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    NSString *map = [fixture[@"map"] isKindOfClass:NSString.class] ? fixture[@"map"] : nil;
    if (!map) {
        fprintf(stderr, "FAIL: the view import map cannot be read from %s\n", VIEW_PAGE_CASES);
        exit(1);
    }
    return map;
}
