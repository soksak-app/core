#import "records.h"
#include <stdio.h>
#include <time.h>
#import "event_ring.h"

static NSString *const levelNames[] = {@"error", @"warn", @"info", @"debug", @"trace"};

NSString *capturedRecords(void (^block)(void)) {
    uint8_t buffer[1 << 16];
    while (sp_event_drain(buffer, sizeof buffer) > 0) {}
    block();
    NSMutableString *lines = [NSMutableString string];
    size_t used;
    while ((used = sp_event_drain(buffer, sizeof buffer)) > 0) {
        for (size_t offset = 0; offset < used;) {
            uint32_t length;
            memcpy(&length, buffer + offset, sizeof length);
            const uint8_t *body = buffer + offset + 4;
            uint64_t micros;
            memcpy(&micros, body, sizeof micros);
            uint8_t level = body[8];
            uint8_t nameLength = body[9];
            NSString *name = [[NSString alloc] initWithBytes:body + 10 length:nameLength encoding:NSUTF8StringEncoding];
            NSData *json = [NSData dataWithBytes:body + 10 + nameLength length:length - 10 - nameLength];
            NSError *error = nil;
            NSDictionary *fields = [NSJSONSerialization JSONObjectWithData:json options:0 error:&error];
            if (level > 4 || ![fields isKindOfClass:NSDictionary.class]) {
                fprintf(stderr, "records: %s is not a record of the ring: %s\n", name.UTF8String, error.localizedDescription.UTF8String);
                exit(1);
            }
            time_t seconds = (time_t)(micros / 1000000u);
            struct tm utc;
            gmtime_r(&seconds, &utc);
            char stamp[32];
            strftime(stamp, sizeof stamp, "%Y-%m-%dT%H:%M:%S", &utc);
            NSString *text = [fields[@"text"] stringByReplacingOccurrencesOfString:@"\n" withString:@"\\n"];
            [lines appendFormat:@"%s.%03uZ %@ %@ %@: %@\n", stamp, (unsigned)((micros / 1000u) % 1000u), levelNames[level],
                [name componentsSeparatedByString:@"."].firstObject, fields[@"where"], text];
            offset += 4 + length;
        }
    }
    return lines;
}
