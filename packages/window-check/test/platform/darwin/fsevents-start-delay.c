// Fault injection for test/folder-wait-stream-start.test.mjs: a library that the test loads into a node process with
// DYLD_INSERT_LIBRARIES replaces FSEventStreamStart with a call of FSEventStreamStart followed by a pause of
// START_DELAY_US. The run loop thread delivers the events of the started stream during the pause, so a watcher that
// completes the state that its callback uses only after FSEventStreamStart returns has that state incomplete while the
// callback runs, and a watcher that completes it before it schedules the stream is unaffected. When dyld loads the
// library, its constructor writes the line LOADED_LINE to the standard error of the process, so the test can tell a
// process that runs with the delay from one whose dyld did not load the library.
#include <CoreServices/CoreServices.h>
#include <unistd.h>

enum { START_DELAY_US = 50000 };
static const char LOADED_LINE[] = "fsevents-start-delay: loaded\n";

__attribute__((constructor)) static void announceLoaded(void) {
  write(STDERR_FILENO, LOADED_LINE, sizeof LOADED_LINE - 1);
}

static Boolean delayedStart(FSEventStreamRef stream) {
  Boolean started = FSEventStreamStart(stream);
  usleep(START_DELAY_US);
  return started;
}

// dyld binds every call of the replacee in the other images of the process to the replacement; the call inside the
// replacement keeps the original function.
__attribute__((used, section("__DATA,__interpose"))) static const struct {
  const void *replacement;
  const void *replacee;
} interposeStart = { (const void *)delayedStart, (const void *)FSEventStreamStart };
