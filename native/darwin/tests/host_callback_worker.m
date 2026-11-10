// The real framework worker invokes these test operations through the public native dispatch contract.
#include "host_callbacks.h"
#include "main_thread.h"
#include <Block.h>
#include <pthread.h>
#include <stdint.h>
#include <string.h>

uint64_t sp_test_worker_thread(void) {
    uint64_t identifier = 0;
    if (pthread_threadid_np(NULL, &identifier)) return 0;
    return identifier;
}

typedef struct {
    uint64_t main, worker, touch, completion;
    int completions;
    char *borrowed;
} WorkerProbe;

int sp_test_worker_touch(void *context) {
    WorkerProbe *probe = context;
    __block int result = -1;
    hostRunOnMain(^{
        probe->touch = sp_test_worker_thread();
        if (!pthread_main_np() || probe->touch != probe->main) return;
        strcpy(probe->borrowed, "borrowed-after!");
        result = 53;
    });
    return result;
}

void sp_test_worker_present(void *completion) {
    hostRunOnMain(^{ sp_host_presentation_complete(completion, NULL); });
}

int sp_test_worker_probe(uintptr_t token, uint64_t *record) {
    __block int result = 0;
    hostRunOnMain(^{
        if (!pthread_main_np()) { result = 1; return; }
        WorkerProbe probe = {0};
        WorkerProbe *state = &probe;
        state->main = sp_test_worker_thread();
        char borrowed[] = "borrowed-before";
        state->borrowed = borrowed;
        hostRunOnWorker(^{
            state->worker = sp_test_worker_thread();
            if (pthread_main_np()) { result = 2; return; }
            sp_host_callback_surface_pressed(token, state);
            sp_host_callback_native_message(token, state->borrowed);
            void *completion = Block_copy(^(const char *failure) {
                state->completion = sp_test_worker_thread();
                state->completions++;
                if (failure || !pthread_main_np()) result = 4;
            });
            sp_host_callback_native_settled_present(token, completion);
        });
        record[0] = state->main;
        record[1] = state->worker;
        record[2] = state->touch;
        record[3] = state->completion;
        record[4] = state->completions;
        record[5] = !strcmp(borrowed, "borrowed-after!");
    });
    return result;
}
