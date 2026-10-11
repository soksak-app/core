// Helpers of the tests that read the records of the native library. A record is an event of the ring of the process
// (docs/spec/logging.md#writers); the tests read it as the line `<time> <level> native <where>: <text>`.
#import <Foundation/Foundation.h>
#include <stdint.h>

/// The records that block stores in the ring of the process, one line each in the text form; a line feed in a text is
/// written as the two characters `\n`, so a record is one line. The ring is emptied before block runs.
NSString *capturedRecords(void (^block)(void));

/// The events that block stores in the ring of the process, each as {ts_us, mono_ns, level, class, name, cids, fields} (see
/// decodedRecord). The ring is emptied before block runs.
NSArray<NSDictionary *> *capturedEvents(void (^block)(void));

/// One record of the ring of the process decoded from its bytes (the 4-byte length excluded): {ts_us, mono_ns, level, class,
/// name, cids, fields}, where class is a number of SP_CLASS_*, cids is an array of strings and fields is the JSON object of
/// the record. A record that is not well formed stops the test with a message that names what was found.
NSDictionary *decodedRecord(const uint8_t *body, uint32_t length);
