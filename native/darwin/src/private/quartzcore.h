// Private Core Animation declarations that this library uses.
// List and conditions of use: docs/operations/private-native-apis.md
#import <QuartzCore/QuartzCore.h>

// The phase of the commit of the outermost transaction of a thread after which a commit handler runs. After the post-commit
// phase the commit has sent the transaction to the render server.
static const unsigned int kSPTransactionPhasePostCommit = 2;

@interface CATransaction (SPPrivate)
// Runs block on the thread of the transaction when its outermost transaction reaches phase. Returns NO when that phase of the
// current commit has passed, and block is not run.
+ (BOOL)addCommitHandler:(void (^)(void))block forPhase:(unsigned int)phase;
@end
