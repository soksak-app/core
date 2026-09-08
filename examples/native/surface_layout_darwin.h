#include <stdbool.h>
#include <stdint.h>

bool surfaceLayoutCommit(void *owner, uint64_t ticket);
void surfaceLayoutCancel(void *owner);
#ifdef __BLOCKS__
void surfaceLayoutBegin(void *owner, uint64_t ticket, void (^ready)(int));
void surfaceLayoutAfterPresentation(void *mainWebview, void (^done)(void));
#endif
