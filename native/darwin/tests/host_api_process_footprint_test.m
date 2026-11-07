#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <mach/mach.h>
#include <mach/task_info.h>
#include "host_api_process_footprint.h"

static int failures;
#define CHECK(condition, label) do { if (condition) puts("PASS: " label); else { fputs("FAIL: " label "\n", stderr); failures++; } } while (0)

int main(void) {
    const int64_t ledgers[13] = {
        2049, 4095, 8193, 513, 512, 1023, 1025, 2048, 3073, 0, 1023, INT64_MAX, INT64_MAX,
    };
    const uint64_t expected[8] = {2, 3, 8, 1, 2, 5, 0, (UINT64_MAX - 1) / 1024};
    uint64_t values[8] = {0};
    int negativeLedger = 77;
    int64_t negativeValue = 99;
    CHECK(hostProcessFootprintValues(ledgers, values, &negativeLedger, &negativeValue),
        "nonnegative SDK ledgers produce footprint values");
    CHECK(!memcmp(values, expected, sizeof values), "all eight KB values preserve pair sums before rounding and unsigned range");
    CHECK(negativeLedger == -1 && negativeValue == 0, "valid conversion clears negative-ledger metadata");

    const uint64_t sentinel[8] = {91, 92, 93, 94, 95, 96, 97, 98};
    for (int index = 0; index < 13; index++) {
        int64_t invalid[13];
        memcpy(invalid, ledgers, sizeof invalid);
        invalid[index] = -(100 + index);
        memcpy(values, sentinel, sizeof values);
        negativeLedger = -1;
        negativeValue = 0;
        bool converted = hostProcessFootprintValues(invalid, values, &negativeLedger, &negativeValue);
        if (converted || negativeLedger != index || negativeValue != invalid[index] || memcmp(values, sentinel, sizeof values)) {
            fprintf(stderr, "FAIL: negative SDK ledger %d preserves exact index/value and every output\n", index);
            failures++;
        }
    }
    CHECK(failures == 0, "all thirteen negative SDK ledger positions preserve exact metadata without partial output");
    int64_t multiple[13];
    memcpy(multiple, ledgers, sizeof multiple);
    multiple[2] = -7;
    multiple[12] = -19;
    CHECK(!hostProcessFootprintValues(multiple, values, &negativeLedger, &negativeValue)
        && negativeLedger == 2 && negativeValue == -7, "the first negative SDK ledger wins in declared order");

    memcpy(values, sentinel, sizeof values);
    int step = 77;
    uint32_t count = 99, words = 0;
    int code = hostProcessFootprint(-1, values, &step, &count, &words, &negativeLedger, &negativeValue);
    CHECK(code != KERN_SUCCESS && step == 1 && count == 0 && words == TASK_VM_INFO_REV3_COUNT,
        "invalid pid reports the actual task-name failure and revision count metadata");
    CHECK(negativeLedger == -1 && negativeValue == 0 && !memcmp(values, sentinel, sizeof values),
        "failed native query preserves output values and clears negative-ledger metadata");
    code = hostProcessFootprint(getpid(), values, &step, &count, &words, &negativeLedger, &negativeValue);
    CHECK(code == KERN_SUCCESS && step == 0 && count >= words && words == TASK_VM_INFO_REV3_COUNT,
        "own process returns a complete real Mach revision-three reply");
    CHECK(negativeLedger == -1 && negativeValue == 0 && values[0] > 0,
        "own process produces a nonzero physical footprint through the conversion contract");
    return failures ? 1 : 0;
}
