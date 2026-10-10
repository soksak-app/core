// Stores one record as the event `native.record.error` with the fields `where` and `text` in the ring of the process
// (docs/spec/logging.md#writers). The text is kept as it is, a line feed included. The call does not wait; the writer of the
// host pulls the ring. A full ring refuses the record and counts it.
void sp_log_error(const char *where, const char *text);

// Stores one record as the event `native.record.info`, in the same way, for a state that is not a failure:
// each callback of the input method, each report to the page and the state of the document at that time.
void sp_log_info(const char *where, const char *text);

// Installs the handlers of the fatal signals and of the uncaught exception of the process. Each writes one record
// `<time> error native fatal: <signal name>` or `<time> error native fatal: uncaught exception <name>: <reason>` to the standard error, and the
// process then ends by the signal that it had received or by the abort that follows the exception
// (docs/spec/diagnostics.md). A handler that was installed before is called after the line.
void sp_log_install_fatal_handlers(void);
