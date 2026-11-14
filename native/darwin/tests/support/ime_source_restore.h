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

// The decisions of the restoration are functions of the readings that the system gave, so a table judges each of them. The
// functions above give the operations to the system and pass what it answered to these.

// The input source after a selection: selected is whether the selection answered that the source was selected and adopted, and
// actual is the source that the system reported afterwards (nil when it reported none).
NSArray<NSString *> *sp_ime_source_select_verdict(NSString *expected, BOOL selected, NSString *actual);

// Whether the outer source is selected after the baseline application restoration: when it differs from the baseline, or the
// source after that restoration is not the outer source.
BOOL sp_ime_source_outer_selection_needed(NSString *baselineSource, NSString *outerSource, NSString *afterBaseline);

// The errors that stop the gesture of a run after an adoption: the errors of the selection, or the context that did not
// adopt the source. No error means the gesture runs.
NSArray<NSString *> *sp_ime_source_adoption_verdict(NSString *expected, NSArray<NSString *> *selectErrors,
    BOOL contextAdopted);

// What the system answered during one restoration, in the order of its steps. before and afterBaseline are the sources read
// before and after the application restoration, frontmost the frontmost process after it, selectionRan whether the outer
// source was selected, selected and selectionActual the answer and the source read after that selection, and finalSource and
// finalFrontmost the state at the end. A string that the system did not give is nil.
typedef struct {
    NSString *before;
    BOOL activated;
    pid_t frontmost;
    NSString *afterBaseline;
    BOOL selectionRan;
    BOOL selected;
    NSString *selectionActual;
    NSString *finalSource;
    pid_t finalFrontmost;
} SPIMERestoreReadings;

NSArray<NSString *> *sp_ime_source_restore_verdict(NSString *baselineSource, NSString *outerSource,
    pid_t outerProcessIdentifier, SPIMERestoreReadings readings);
