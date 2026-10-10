#import <Foundation/Foundation.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#import "application_log.h"
#import "event_ring.h"

// Writes the UTC time of now as `YYYY-MM-DDTHH:MM:SS.mmmZ` (24 characters and no terminator) to out. It uses clock_gettime
// and integer arithmetic only, so a signal handler may call it.
static void formatTime(char *out) {
    struct timespec now;
    clock_gettime(CLOCK_REALTIME, &now);
    long long seconds = now.tv_sec;
    long long days = seconds / 86400;
    long long secondOfDay = seconds % 86400;
    // The civil date of a day count since 1970-01-01 (the algorithm of Howard Hinnant, valid for every day of this epoch).
    days += 719468;
    long long era = (days >= 0 ? days : days - 146096) / 146097;
    long long dayOfEra = days - era * 146097;
    long long yearOfEra = (dayOfEra - dayOfEra / 1460 + dayOfEra / 36524 - dayOfEra / 146096) / 365;
    long long year = yearOfEra + era * 400;
    long long dayOfYear = dayOfEra - (365 * yearOfEra + yearOfEra / 4 - yearOfEra / 100);
    long long monthPart = (5 * dayOfYear + 2) / 153;
    long long day = dayOfYear - (153 * monthPart + 2) / 5 + 1;
    long long month = monthPart < 10 ? monthPart + 3 : monthPart - 9;
    if (month <= 2) year += 1;
    long long millis = now.tv_nsec / 1000000;
    long long fields[7] = {year, month, day, secondOfDay / 3600, (secondOfDay % 3600) / 60, secondOfDay % 60, millis};
    static const int widths[7] = {4, 2, 2, 2, 2, 2, 3};
    static const char separators[7] = {'-', '-', 'T', ':', ':', '.', 'Z'};
    size_t at = 0;
    for (int index = 0; index < 7; index++) {
        long long value = fields[index];
        for (int digit = widths[index] - 1; digit >= 0; digit--) { out[at + digit] = (char)('0' + value % 10); value /= 10; }
        at += (size_t)widths[index];
        out[at++] = separators[index];
    }
    out[23] = 'Z';
}

// Stores the record as the event `native.record.<level>` with the fields `where` and `text` (docs/spec/logging.md#writers).
// The fields are built with the JSON serializer of Foundation, so a quote, a control character and any text is kept as it
// is. The call does not wait: the ring refuses an event that does not fit and counts it. A text that cannot be serialized is a
// defect of the caller and ends the process, as a record that cannot be stored has nowhere to report to.
static void storeRecord(uint8_t level, const char *name, const char *where, const char *text) {
    NSError *error = nil;
    NSData *json = [NSJSONSerialization dataWithJSONObject:@{@"where": @(where), @"text": @(text)} options:0 error:&error];
    if (json == nil) {
        fprintf(stderr, "native record %s: %s\n", where, error.localizedDescription.UTF8String);
        abort();
    }
    NSString *fields = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
    sp_event(level, name, fields.UTF8String);
}

void sp_log_error(const char *where, const char *text) { storeRecord(SP_EVENT_ERROR, "native.record.error", where, text); }

void sp_log_info(const char *where, const char *text) { storeRecord(SP_EVENT_INFO, "native.record.info", where, text); }

// An uncaught exception ends the process by an abort. Its line is written once, so the abort does not add a second.
static volatile sig_atomic_t exceptionReported = 0;

static const int kFatalSignals[] = {SIGABRT, SIGBUS, SIGFPE, SIGILL, SIGSEGV, SIGTRAP};
#define FATAL_SIGNAL_COUNT (sizeof(kFatalSignals) / sizeof(kFatalSignals[0]))
static struct sigaction previousActions[FATAL_SIGNAL_COUNT];

static const char *fatalName(int signalNumber) {
    switch (signalNumber) {
    case SIGABRT: return "SIGABRT";
    case SIGBUS: return "SIGBUS";
    case SIGFPE: return "SIGFPE";
    case SIGILL: return "SIGILL";
    case SIGSEGV: return "SIGSEGV";
    case SIGTRAP: return "SIGTRAP";
    default: return "signal";
    }
}

// Runs inside a fatal signal, so it calls only write and the functions that a signal handler may call.
static void fatalSignal(int signalNumber, siginfo_t *info, void *context) {
    if (!exceptionReported) {
        // The record `<time> error native fatal: <signal name>\n` is built in a buffer of the stack with calls that a
        // signal handler may make.
        char line[96];
        formatTime(line);
        static const char prefix[] = " error native fatal: ";
        memcpy(line + 24, prefix, sizeof prefix - 1);
        size_t length = 24 + sizeof prefix - 1;
        const char *name = fatalName(signalNumber);
        size_t nameLength = strlen(name);
        memcpy(line + length, name, nameLength);
        length += nameLength;
        line[length++] = '\n';
        // The process ends after this handler, and the standard error is the only place that can take the record, so a
        // failed write has nowhere to report to.
        ssize_t written = write(STDERR_FILENO, line, length);
        (void)written;
    }
    for (size_t index = 0; index < FATAL_SIGNAL_COUNT; index++) {
        if (kFatalSignals[index] != signalNumber) continue;
        struct sigaction previous = previousActions[index];
        if (previous.sa_flags & SA_SIGINFO) {
            if (previous.sa_sigaction != NULL) previous.sa_sigaction(signalNumber, info, context);
        } else if (previous.sa_handler != SIG_DFL && previous.sa_handler != SIG_IGN && previous.sa_handler != NULL) {
            previous.sa_handler(signalNumber);
        }
        break;
    }
    signal(signalNumber, SIG_DFL);
    raise(signalNumber);
}

// The process ends by an abort after this handler, and nothing pulls the ring before it ends, so the record goes to the
// standard error as a line of the text form (F150.3.4 moves the fatal paths to the contract).
static void writeFatalLine(const char *text) {
    char time[25];
    formatTime(time);
    time[24] = 0;
    char *line = NULL;
    int length = asprintf(&line, "%s error native fatal: %s\n", time, text);
    if (length < 0) abort();
    for (ssize_t offset = 0; offset < length;) {
        ssize_t written = write(STDERR_FILENO, line + offset, (size_t)(length - offset));
        if (written < 0 && errno == EINTR) continue;
        if (written <= 0) abort();
        offset += written;
    }
    free(line);
}

static void uncaughtException(NSException *exception) {
    NSString *escaped = [[NSString stringWithFormat:@"uncaught exception %@: %@", exception.name, exception.reason]
        stringByReplacingOccurrencesOfString:@"\n" withString:@"\\n"];
    writeFatalLine(escaped.UTF8String);
    exceptionReported = 1;
}

void sp_log_install_fatal_handlers(void) {
    for (size_t index = 0; index < FATAL_SIGNAL_COUNT; index++) {
        struct sigaction action;
        memset(&action, 0, sizeof action);
        action.sa_sigaction = fatalSignal;
        action.sa_flags = SA_SIGINFO | SA_ONSTACK;
        sigemptyset(&action.sa_mask);
        if (sigaction(kFatalSignals[index], &action, &previousActions[index]) != 0) {
            writeFatalLine("install the signal handler failed");
        }
    }
    NSSetUncaughtExceptionHandler(&uncaughtException);
}
