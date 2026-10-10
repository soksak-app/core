// Helpers of the tests that read the records of the native library. A record is an event of the ring of the process
// (docs/spec/logging.md#writers); the tests read it as the line `<time> <level> native <where>: <text>`.
#import <Foundation/Foundation.h>

/// The records that block stores in the ring of the process, one line each in the text form; a line feed in a text is
/// written as the two characters `\n`, so a record is one line. The ring is emptied before block runs.
NSString *capturedRecords(void (^block)(void));

/// The events that block stores in the ring of the process, each as {name, level, fields}. The ring is emptied before block
/// runs.
NSArray<NSDictionary *> *capturedEvents(void (^block)(void));
