#include <stdint.h>

// Calls callback once in the next main queue run, regardless of the calling thread.
void sp_ui_enqueue(void (*callback)(uintptr_t), uintptr_t context);

// Calls callback once in a main queue run after delay nanoseconds, regardless of the calling thread.
void sp_ui_enqueue_after(uint64_t delay, void (*callback)(uintptr_t), uintptr_t context);
