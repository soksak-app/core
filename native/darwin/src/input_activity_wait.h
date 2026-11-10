#import <Foundation/Foundation.h>

typedef void (^sp_input_activity_member_completion)(void);
typedef void (^sp_input_activity_register_member)(NSUInteger index, NSString *identifier,
    sp_input_activity_member_completion completion);
typedef void (^sp_input_activity_wait_completion)(void);

// Tracks the visible webviews enrolled in one aggregate activation wait. Identifiers are copied strings;
// the wait does not retain the webviews themselves.
@interface SPInputActivityWait : NSObject
- (instancetype)initWithIdentifiers:(NSArray<NSString *> *)identifiers completion:(sp_input_activity_wait_completion)completion;
- (BOOL)installIfActivationPending:(BOOL)pending store:(void (^)(SPInputActivityWait *wait))store;
- (void)startWithRegistration:(sp_input_activity_register_member)registration;
// Ends the wait before every member completed, at the event that ended its step, and returns the members that had not completed.
// A member that completes later completes nothing.
- (NSArray<NSString *> *)finish;
- (NSArray<NSString *> *)unresolvedIdentifiers;
@end

// Returns the error reason of a webview step that end, the text of an event, ended before every member completed, and nil before
// the application and the key window were active, where the step had not begun. A missing waiter means callback registration has
// not started; unresolved identifiers are available only after registration.
NSString *sp_input_activity_end_message(BOOL activationReady, BOOL registrationStarted,
    NSArray<NSString *> *unresolvedIdentifiers, NSString *end);
