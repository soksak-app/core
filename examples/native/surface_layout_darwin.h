#include <stdbool.h>
#include <stdint.h>

void surfaceLayoutBegin(uint64_t ticket);
bool surfaceLayoutCommit(uint64_t ticket);
void surfaceLayoutCancel(void);
#ifdef __BLOCKS__
void surfaceLayoutAfterPresentation(void *mainWebview, void (^done)(void));
#endif
