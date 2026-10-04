#import <Foundation/Foundation.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#import "application_log.h"

void sp_log_error(const char *where, const char *text) {
    char *line = NULL;
    int length = asprintf(&line, "error: %s: %s\n", where, text);
    if (length < 0) abort();
    // 한 번의 write 는 같은 파일에 쓰는 다른 줄과 섞이지 않는다. 짧게 쓰인 나머지는 이어서 쓴다.
    for (ssize_t offset = 0; offset < length;) {
        ssize_t written = write(STDERR_FILENO, line + offset, (size_t)(length - offset));
        if (written < 0 && errno == EINTR) continue;
        if (written <= 0) abort();
        offset += written;
    }
    free(line);
}
