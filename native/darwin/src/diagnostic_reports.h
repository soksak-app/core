// The folder in which the system writes the crash reports of the current user. The system declares the Library folder of the user
// and the crash reports are in its subfolder Logs/DiagnosticReports, so the path is discovered from the Library folder and not
// assumed from the home folder.
// Returns the path, which the caller must free(), or NULL with *failure set to a UTF-8 error text that the caller must free().
char *sp_diagnostic_reports_directory(char **failure);
