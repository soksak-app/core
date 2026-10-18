#import <Foundation/Foundation.h>
#import "memory_pressure.h"
#import "document_view.h"
#import "event_ring.h"
#import "observe.h"

static dispatch_source_t source;
static void (^reportBlock)(const char *level, unsigned long long seq);
static const char *levelInForce = "normal";
static unsigned long long lastSeq;

// The name of the level as the contract spells it, or NULL for another text.
static const char *knownLevel(const char *level) {
    if (!level) return NULL;
    static const char *const levels[] = {"normal", "warn", "critical"};
    for (size_t index = 0; index < sizeof levels / sizeof levels[0]; index++) {
        if (strcmp(level, levels[index]) == 0) return levels[index];
    }
    return NULL;
}

static void receive(const char *level) {
    NSCAssert(NSThread.isMainThread, @"memory pressure reports belong to the main thread");
    if (strcmp(level, levelInForce) == 0) return;
    levelInForce = level;
    unsigned long long seq = ++lastSeq;
    char fields[64];
    snprintf(fields, sizeof fields, "{\"level\":\"%s\",\"seq\":%llu}", level, seq);
    sp_event(SP_CLASS_LIFECYCLE, SP_EVENT_INFO, "native.memory.pressure", fields);
    sp_document_memory_pressure(level);
    reportBlock(level, seq);
}

bool sp_memory_pressure_start(void (^report)(const char *level, unsigned long long seq)) {
    NSCAssert(NSThread.isMainThread, @"the memory pressure owner starts on the main thread");
    if (source || !report) return false;
    reportBlock = [report copy];
    source = sp_observe_memory_pressure("memory_pressure", SP_OBSERVE_STORED, dispatch_get_main_queue(), ^(const char *level) {
        receive(level);
    });
    if (!source) {
        [reportBlock release];
        reportBlock = nil;
        return false;
    }
    dispatch_resume(source);
    return true;
}

bool sp_memory_pressure_inject(const char *level) {
    NSCAssert(NSThread.isMainThread, @"the memory pressure owner runs on the main thread");
    const char *known = knownLevel(level);
    if (!source || !known) return false;
    receive(known);
    return true;
}
