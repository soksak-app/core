#include <stdint.h>

// Calls callback once in the next main queue run, regardless of the calling thread.
void sp_ui_enqueue(void (*callback)(uintptr_t), uintptr_t context);
