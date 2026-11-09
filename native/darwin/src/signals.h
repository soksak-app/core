#pragma once

// Block asynchronous signals on the calling native main thread before starting the framework.
// Synchronous fault masks stay unchanged. Return 0, -1 off the main thread, or pthread_sigmask's error number.
int sp_block_async_signals(void);

// Records the process that sends each termination signal (SIGTERM, SIGINT, SIGHUP, from si_pid of SA_SIGINFO) and passes each
// signal on to the handler that was installed before, so the host installs its own handling first. Returns 0 or the error number
// of sigaction.
int sp_termination_signals_record(void);

// The process that sent the last termination signal of that number, or 0 when none was received or the signal is not one of them.
int sp_termination_signal_sender(int signal);
