// Private libsystem_malloc declarations that the checks of this library use.
// List and conditions of use: docs/operations/private-native-apis.md
#include <stdint.h>

// The logging hook of the allocator, which <malloc/malloc.h> does not declare: while it is set, the allocator calls it for each
// allocation and free of the process, on the thread that makes it.
typedef void(malloc_logger_t)(uint32_t type, uintptr_t arg1, uintptr_t arg2, uintptr_t arg3, uintptr_t result, uint32_t skip);
extern malloc_logger_t *malloc_logger;
