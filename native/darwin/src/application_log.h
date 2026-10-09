// Writes one text record `<time> error native <where>: <text>` to the standard error with one write
// (docs/spec/diagnostics.md#forms). The time is the UTC time of the write with milliseconds. A line feed in the text is
// written as the two characters `\n`, so a record is one line. The host turns the standard error into the application
// log. A process that cannot write to its standard error has no place to report that, so it ends.
void sp_log_error(const char *where, const char *text);

// Writes one text record `<time> info native <where>: <text>`, in the same way, for a state that is not a failure:
// each callback of the input method, each report to the page and the state of the document at that time.
void sp_log_info(const char *where, const char *text);

// Installs the handlers of the fatal signals and of the uncaught exception of the process. Each writes one record
// `<time> error native fatal: <signal name>` or `<time> error native fatal: uncaught exception <name>: <reason>` to the standard error, and the
// process then ends by the signal that it had received or by the abort that follows the exception
// (docs/spec/diagnostics.md). A handler that was installed before is called after the line.
void sp_log_install_fatal_handlers(void);
