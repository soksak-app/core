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
- (NSArray<NSString *> *)finishAtTimeout;
- (NSArray<NSString *> *)unresolvedIdentifiers;
@end

// Returns an error reason only for the active/key webview-wait timeout. A missing waiter means callback
// registration has not started; unresolved identifiers are available only after registration.
NSString *sp_input_activity_timeout_message(BOOL activationReady, BOOL registrationStarted,
    NSArray<NSString *> *unresolvedIdentifiers);
