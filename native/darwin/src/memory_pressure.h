// The memory pressure owner of the process (docs/spec/hosts.md#memory-pressure). The host starts it once; it creates the one memory
// pressure source of the process through the entrance (observe.h), which observes the levels normal, warn and critical. Each change
// of level is one report: the owner numbers it with seq (1 for the first), stores it as the event native.memory.pressure
// {level, seq}, calls the document region consumer (sp_document_memory_pressure) and then the report block of the host. A report of
// the level in force is not a change; the level in force at the start is normal.
#pragma once

#include <stdbool.h>

// Creates the memory pressure source and keeps it until the process ends; report runs on the main thread with each report. Call it
// on the main thread. Returns false and registers nothing when the owner already started or report is missing, and false after the
// event native.observe.failed when the system refuses the source.
bool sp_memory_pressure_start(void (^report)(const char *level, unsigned long long seq));

// The fault injection of the checks: delivers the level `normal`, `warn` or `critical` as the source delivers it. Call it on the main
// thread. Returns false and reports nothing before the start or for another level.
bool sp_memory_pressure_inject(const char *level);
