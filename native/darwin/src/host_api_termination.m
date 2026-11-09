#include "host_api_termination.h"

#include "signals.h"
#include <stdbool.h>
#include "quit_request.h"
#include "main_thread.h"
#include "host_callbacks.h"

// The request runs its Go function on the worker, and the native calls run on the main thread (main_thread.h).
bool installQuitRequest(void) {
    // The name of the sender is borrowed for the call of the request, and the worker runs it while the main thread waits.
    return ON_MAIN(bool, sp_quit_request_install(^(int senderPid, const char *sender) {
        hostRunOnWorker(^{ sp_host_callback_quit_request(senderPid, (char *)sender); });
    }));
}
int main_sp_quit_request_event_type(void) { return ON_MAIN(int, sp_quit_request_event_type()); }
void main_sp_quit_request_answer(void) { hostRunOnMain(^{ sp_quit_request_answer(); }); }
void main_sp_quit_request_cancel(void) { hostRunOnMain(^{ sp_quit_request_cancel(); }); }
