#pragma once

// Block asynchronous signals on the calling native main thread before starting the framework.
// Synchronous fault masks stay unchanged. Return 0, -1 off the main thread, or pthread_sigmask's error number.
int sp_block_async_signals(void);
