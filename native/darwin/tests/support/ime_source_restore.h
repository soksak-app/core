#import <Cocoa/Cocoa.h>

typedef BOOL (^SPIMESelectAndAwaitSource)(NSString *identifier);
typedef NSString * (^SPIMEReadSource)(void);
typedef BOOL (^SPIMEActivateProcess)(pid_t processIdentifier);
typedef pid_t (^SPIMEReadFrontmostProcess)(void);

NSArray<NSString *> *sp_ime_source_select_errors(NSString *expected,
    SPIMESelectAndAwaitSource selectAndAwait, SPIMEReadSource readSource);
BOOL sp_ime_source_run_after_adoption(NSString *expected, SPIMESelectAndAwaitSource selectAndAwait,
    SPIMEReadSource readSource, BOOL (^contextAdopted)(void), void (^run)(void),
    NSMutableArray<NSString *> *errors);
NSArray<NSString *> *sp_ime_source_restore_errors(NSString *baselineSource, NSString *outerSource,
    pid_t outerProcessIdentifier, SPIMEReadSource readSource, SPIMEActivateProcess activateProcess,
    SPIMEReadFrontmostProcess readFrontmost, SPIMESelectAndAwaitSource selectAndAwait);
NSArray<NSString *> *sp_ime_source_cleanup_errors(NSString *baselineSource, NSString *outerSource,
    pid_t outerProcessIdentifier, SPIMEReadSource readSource, SPIMEActivateProcess activateProcess,
    SPIMEReadFrontmostProcess readFrontmost, SPIMESelectAndAwaitSource selectAndAwait,
    void (^closeTestContext)(void));
