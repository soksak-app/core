#import "records.h"
#include <stdio.h>
#include <time.h>
#import "event_ring.h"

static NSString *const levelNames[] = {@"error", @"warn", @"info", @"debug", @"trace"};

NSDictionary *decodedRecord(const uint8_t *body, uint32_t length) {
    if (length < SP_EVENT_HEADER_BYTES) {
        fprintf(stderr, "records: a record of %u bytes is shorter than its header of %d bytes\n", length, SP_EVENT_HEADER_BYTES);
        exit(1);
    }
    uint64_t micros, mono;
    memcpy(&micros, body, sizeof micros);
    memcpy(&mono, body + 8, sizeof mono);
    uint8_t level = body[16];
    uint8_t class = body[17];
    uint8_t nameLength = body[18];
    uint16_t cidsLength;
    memcpy(&cidsLength, body + 19, sizeof cidsLength);
    if (SP_EVENT_HEADER_BYTES + (size_t)nameLength + cidsLength > length) {
        fprintf(stderr, "records: the name of %u bytes and the cids of %u bytes do not fit a record of %u bytes\n", nameLength, cidsLength, length);
        exit(1);
    }
    NSString *name = [[NSString alloc] initWithBytes:body + SP_EVENT_HEADER_BYTES length:nameLength encoding:NSUTF8StringEncoding];
    NSString *cidText = [[NSString alloc] initWithBytes:body + SP_EVENT_HEADER_BYTES + nameLength length:cidsLength encoding:NSUTF8StringEncoding];
    NSArray *cids = cidsLength == 0 ? @[] : [cidText componentsSeparatedByString:@","];
    size_t fieldsAt = SP_EVENT_HEADER_BYTES + (size_t)nameLength + cidsLength;
    NSData *json = [NSData dataWithBytes:body + fieldsAt length:length - fieldsAt];
    NSError *error = nil;
    NSDictionary *fields = [NSJSONSerialization JSONObjectWithData:json options:0 error:&error];
    if (level > 4 || class >= SP_CLASS_COUNT || ![fields isKindOfClass:NSDictionary.class]) {
        fprintf(stderr, "records: %s is not a record of the ring: %s\n", name.UTF8String, error.localizedDescription.UTF8String);
        exit(1);
    }
    return @{@"ts_us": @(micros), @"mono_ns": @(mono), @"level": @(level), @"class": @(class), @"name": name, @"cids": cids, @"fields": fields};
}

/// Calls block with each record that the ring of the process holds, after the ring was emptied and `produce` ran.
static void forEachRecord(void (^produce)(void), void (^each)(NSDictionary *record)) {
    uint8_t buffer[1 << 16];
    while (sp_event_drain(buffer, sizeof buffer) > 0) {}
    produce();
    size_t used;
    while ((used = sp_event_drain(buffer, sizeof buffer)) > 0) {
        for (size_t offset = 0; offset < used;) {
            uint32_t length;
            memcpy(&length, buffer + offset, sizeof length);
            each(decodedRecord(buffer + offset + 4, length));
            offset += 4 + length;
        }
    }
}

NSString *capturedRecords(void (^block)(void)) {
    NSMutableString *lines = [NSMutableString string];
    forEachRecord(block, ^(NSDictionary *record) {
        NSDictionary *fields = record[@"fields"];
        uint64_t micros = [record[@"ts_us"] unsignedLongLongValue];
        time_t seconds = (time_t)(micros / 1000000u);
        struct tm utc;
        gmtime_r(&seconds, &utc);
        char stamp[32];
        strftime(stamp, sizeof stamp, "%Y-%m-%dT%H:%M:%S", &utc);
        NSString *text = [fields[@"text"] stringByReplacingOccurrencesOfString:@"\n" withString:@"\\n"];
        [lines appendFormat:@"%s.%03uZ %@ %@ %@: %@\n", stamp, (unsigned)((micros / 1000u) % 1000u), levelNames[[record[@"level"] intValue]],
            [record[@"name"] componentsSeparatedByString:@"."].firstObject, fields[@"where"], text];
    });
    return lines;
}

NSArray<NSDictionary *> *capturedEvents(void (^block)(void)) {
    NSMutableArray *events = [NSMutableArray array];
    forEachRecord(block, ^(NSDictionary *record) { [events addObject:record]; });
    return events;
}
