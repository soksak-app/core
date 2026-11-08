// Reads and changes the selected keyboard input source.
//
// Used by window checks that reproduce input method behavior to create the same input source order as a user (for
// example a Roman layout followed by Korean 2-set). Call selection and current-source operations on the main thread.
#pragma once
#import <Cocoa/Cocoa.h>
#include <stdbool.h>

@protocol SPInputSourceSelectionDriver <NSObject>
- (NSString *)globalSource;
- (BOOL)hasActiveTextClient;
- (BOOL)targetContextIsCurrent;
- (NSString *)targetContextFailureDetails;
- (NSString *)targetContextSource;
- (BOOL)selectGlobalSource:(NSString *)identifier error:(NSString **)error;
- (id)observeSelection:(void (^)(void))changed;
- (void)removeSelectionObserver:(id)observer;
- (id)scheduleSelectionTimeout:(void (^)(void))timeout;
- (void)cancelSelectionTimeout:(id)timer;
@end

// The input source roles of diagnostics.input.source (docs/spec/endpoint.md): `latin` types Latin letters without composition,
// `korean` composes Hangul with the 2-set layout and `japanese` composes kana from romaji. This table is the only place that names
// the Text Input Sources identifier of a role. Both functions are pure and may run on any thread.

// Returns the Text Input Sources identifier of `role` as a static string, or NULL when `role` is not an input source role.
const char *sp_input_source_role_identifier(const char *role);

// Returns the role whose input source has the identifier `identifier` as a static string, or NULL when the input source has no role.
const char *sp_input_source_identifier_role(const char *identifier);

// Returns the identifier of the currently selected keyboard input source as a malloc-allocated string; the caller frees it.
// Returns NULL when the input source cannot be read.
char *sp_input_source_current(void);

// Selects the enabled input source and calls adopted once on the main thread. A key-view text client completes only after
// its context reports the source following the selection notification. With no active text client, completion follows the
// global selection. A client whose context is not the current context fails explicitly. Call it on the main thread.
void sp_input_source_select_and_await(const char *identifier, void (^adopted)(const char *error));

// Returns the live selection driver for `responder` in `window`. The responder is an active text client only when it
// conforms to NSTextInputClient and has an input context; a responder without a context takes the global selection path.
id<SPInputSourceSelectionDriver> sp_input_source_live_driver(NSWindow *window, id responder);

// Runs the production selection coordinator with controlled source, notification, and timeout operations for its owner test.
void sp_input_source_select_and_await_with_driver(const char *identifier, id<SPInputSourceSelectionDriver> driver,
    void (^adopted)(const char *error));
