// Opens a URL with the default application of the user for its scheme. The host checks the scheme restriction.
// Returns NULL on success, or a UTF-8 error string that the caller must free() on failure.
char *sp_link_open(const char *url);
