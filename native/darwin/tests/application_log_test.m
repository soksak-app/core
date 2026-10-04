// native 라이브러리의 오류 줄이 호스트와 같은 `error: <where>: <text>` 형식으로 표준 오류에 한 줄로 쓰이는지
// 검사한다(docs/spec/hosts.md#application-log). 호스트는 표준 오류를 애플리케이션 로그로 바꾼다.
#import <Foundation/Foundation.h>
#include <fcntl.h>
#include <unistd.h>
#import "application_log.h"

int main(void) { @autoreleasepool {
    char path[] = "/tmp/application_log_test.XXXXXX";
    int file = mkstemp(path);
    if (file < 0) { perror("mkstemp"); return 1; }
    int saved = dup(STDERR_FILENO);
    if (saved < 0 || dup2(file, STDERR_FILENO) < 0) { perror("dup2"); return 1; }
    sp_log_error("surface settle", "the DOM evaluation failed");
    if (dup2(saved, STDERR_FILENO) < 0) { perror("dup2"); return 1; }
    close(saved);
    close(file);
    NSString *written = [NSString stringWithContentsOfFile:@(path) encoding:NSUTF8StringEncoding error:nil];
    unlink(path);
    BOOL passed = [written isEqualToString:@"error: surface settle: the DOM evaluation failed\n"];
    fprintf(passed ? stdout : stderr, "%s: an error line is error: <where>: <text> (written %s)\n",
        passed ? "PASS" : "FAIL", written.UTF8String ?: "nothing");
    return passed ? 0 : 1;
}}
