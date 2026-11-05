// Fault injection for test/folder-wait-drop.test.mjs: a library that the test loads into a node process with
// DYLD_INSERT_LIBRARIES replaces FSEventStreamCreate, so that the first event of every callback of a stream carries
// kFSEventStreamEventFlagMustScanSubDirs, as FSEvents marks a batch after events were lost. FSEVENTS_DROP_REPORT selects
// the report of the backend of @parcel/watcher: "client" adds kFSEventStreamEventFlagUserDropped, "kernel" adds
// kFSEventStreamEventFlagKernelDropped, and "overflow" adds neither; any other value ends the process. When dyld loads the
// library, its constructor writes LOADED_LINE to the standard error of the process, and the first callback that carries
// the flag writes REPORTED_LINE there, so the test can tell a process in which a report reached the watcher from one in
// which it did not. FSEVENTS_DROP_EVENTS selects the events of a callback: "kept" passes them, and "lost" replaces them with
// one event for the real path of the watched folder, the path that FSEvents names, that carries only the report, as a batch
// whose events FSEvents lost; any other value ends the process. The backend adds such an event for a folder that it knows
// with an unchanged time to no list of events.
#include <CoreServices/CoreServices.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

typedef struct {
  FSEventStreamCallback callback;
  void *info;
  char folder[PATH_MAX];
} Client;

static const char LOADED_LINE[] = "fsevents-drop: loaded\n";
static const char REPORTED_LINE[] = "fsevents-drop: reported\n";
static const char UNKNOWN_LINE[] = "fsevents-drop: FSEVENTS_DROP_REPORT is not client, kernel or overflow\n";
static const char UNKNOWN_EVENTS_LINE[] = "fsevents-drop: FSEVENTS_DROP_EVENTS is not kept or lost\n";
static const char UNRESOLVED_LINE[] = "fsevents-drop: the watched folder has no real path\n";
static FSEventStreamEventFlags reportFlags;
static int eventsLost;
static volatile int reported = 0;

__attribute__((constructor)) static void selectReport(void) {
  write(STDERR_FILENO, LOADED_LINE, sizeof LOADED_LINE - 1);
  const char *report = getenv("FSEVENTS_DROP_REPORT");
  if (report != NULL && strcmp(report, "client") == 0) {
    reportFlags = kFSEventStreamEventFlagMustScanSubDirs | kFSEventStreamEventFlagUserDropped;
  } else if (report != NULL && strcmp(report, "kernel") == 0) {
    reportFlags = kFSEventStreamEventFlagMustScanSubDirs | kFSEventStreamEventFlagKernelDropped;
  } else if (report != NULL && strcmp(report, "overflow") == 0) {
    reportFlags = kFSEventStreamEventFlagMustScanSubDirs;
  } else {
    write(STDERR_FILENO, UNKNOWN_LINE, sizeof UNKNOWN_LINE - 1);
    _exit(3);
  }
  const char *events = getenv("FSEVENTS_DROP_EVENTS");
  if (events != NULL && strcmp(events, "lost") == 0) {
    eventsLost = 1;
  } else if (events == NULL || strcmp(events, "kept") != 0) {
    write(STDERR_FILENO, UNKNOWN_EVENTS_LINE, sizeof UNKNOWN_EVENTS_LINE - 1);
    _exit(3);
  }
}

static void reportingCallback(ConstFSEventStreamRef stream, void *info, size_t count, void *paths,
                              const FSEventStreamEventFlags flags[], const FSEventStreamEventId ids[]) {
  Client *client = info;
  if (__sync_bool_compare_and_swap(&reported, 0, 1)) write(STDERR_FILENO, REPORTED_LINE, sizeof REPORTED_LINE - 1);
  if (eventsLost) {
    char *folder[1] = { client->folder };
    client->callback(stream, client->info, 1, folder, &reportFlags, ids);
    return;
  }
  FSEventStreamEventFlags *marked = malloc(count * sizeof *marked);
  memcpy(marked, flags, count * sizeof *marked);
  marked[0] |= reportFlags;
  client->callback(stream, client->info, count, paths, marked, ids);
  free(marked);
}

static FSEventStreamRef reportingCreate(CFAllocatorRef allocator, FSEventStreamCallback callback,
                                        FSEventStreamContext *context, CFArrayRef paths, FSEventStreamEventId since,
                                        CFTimeInterval latency, FSEventStreamCreateFlags flags) {
  Client *client = malloc(sizeof *client);
  client->callback = callback;
  client->info = context->info;
  char given[PATH_MAX];
  CFStringGetFileSystemRepresentation(CFArrayGetValueAtIndex(paths, 0), given, sizeof given);
  if (realpath(given, client->folder) == NULL) {
    write(STDERR_FILENO, UNRESOLVED_LINE, sizeof UNRESOLVED_LINE - 1);
    _exit(3);
  }
  FSEventStreamContext wrapped = { 0, client, NULL, NULL, NULL };
  return FSEventStreamCreate(allocator, reportingCallback, &wrapped, paths, since, latency, flags);
}

// dyld binds every call of the replacee in the other images of the process to the replacement; the call inside the
// replacement keeps the original function.
__attribute__((used, section("__DATA,__interpose"))) static const struct {
  const void *replacement;
  const void *replacee;
} interposeCreate = { (const void *)reportingCreate, (const void *)FSEventStreamCreate };
