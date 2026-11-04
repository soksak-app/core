// Checks the part of the site cost benchmark that needs no window and no network (tests/support/site_cost.h): the fixed list of sites,
// the quartiles, the checks of the input, the file of a run and the report.
#import <Foundation/Foundation.h>
#include <math.h>
#include "support/site_cost.h"

static int failures = 0;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

static void checkText(NSString *actual, NSString *expected, NSString *message) {
    BOOL same = actual == expected || [actual isEqualToString:expected];
    check(same, same ? message : [NSString stringWithFormat:@"%@: got [%@], expected [%@]", message, actual, expected]);
}

static BOOL near(double a, double b) {
    return fabs(a - b) < 1e-9;
}

static SiteCostRun validRun(double base) {
    SiteCostRun run = { { base, base + 1, base + 2, base + 3, base + 4, base + 5, base + 6 }, { 10, 20, 30 } };
    return run;
}

static void checkSites(void) {
    const char *names[] = { "google", "google-business", "wikipedia", "github", "naver", "youtube", "tree" };
    check(kSiteCostSiteCount == 7, @"the fixed list has seven sites");
    int local = 0;
    for (int i = 0; i < kSiteCostSiteCount && i < 7; i++) {
        const SiteCostSite *site = &kSiteCostSites[i];
        check(strcmp(site->name, names[i]) == 0, [NSString stringWithFormat:@"site %d is %s", i, names[i]]);
        check(siteCostSiteNamed(names[i]) == site, [NSString stringWithFormat:@"the site %s is found by its name", names[i]]);
        if (site->address == NULL) {
            local++;
        } else {
            NSURL *url = [NSURL URLWithString:@(site->address)];
            check([url.scheme isEqualToString:@"https"] && url.host.length > 0, [NSString stringWithFormat:@"the address of %s is absolute and https", names[i]]);
        }
    }
    check(local == 1 && kSiteCostSites[6].address == NULL, @"only the tree page has no address, because the benchmark serves it");
    check(siteCostSiteNamed("other") == NULL, @"a site outside the list is not found");
    check([kSiteCostTreePage containsString:@"<title>"] && [kSiteCostTreePage containsString:@"setTimeout(change, 0)"],
        @"the tree page has a title and changes its tree on each turn of its timer");
}

static void checkSummary(void) {
    SiteCostSummary summary = { 0, 0, 0, 0 };
    const double odd[] = { 5, 1, 4, 2, 100 };
    check(siteCostSummarize(odd, 5, &summary) == nil, @"five values are summarized");
    check(near(summary.q1, 2) && near(summary.median, 4) && near(summary.q3, 5) && near(summary.iqr, 3),
        [NSString stringWithFormat:@"five values have the quartiles 2, 4 and 5, not %g, %g and %g", summary.q1, summary.median, summary.q3]);
    check(odd[0] == 5 && odd[4] == 100, @"the summary does not sort the values of the caller");
    const double even[] = { 6, 5, 4, 3, 2, 1 };
    check(siteCostSummarize(even, 6, &summary) == nil, @"six values are summarized");
    check(near(summary.q1, 2.25) && near(summary.median, 3.5) && near(summary.q3, 4.75) && near(summary.iqr, 2.5),
        [NSString stringWithFormat:@"six values interpolate to 2.25, 3.5 and 4.75, not %g, %g and %g", summary.q1, summary.median, summary.q3]);
    const double same[] = { 7, 7, 7, 7, 7 };
    check(siteCostSummarize(same, 5, &summary) == nil && near(summary.iqr, 0) && near(summary.median, 7), @"equal values have no range");
    checkText(siteCostSummarize(odd, 4, &summary), @"4 values are fewer than the 5 runs that a summary needs", @"four values are refused");
    const double notNumber[] = { 1, 2, NAN, 4, 5 };
    checkText(siteCostSummarize(notNumber, 5, &summary), @"value 3 of 5 is not finite", @"a value that is not a number is refused");
    const double infinite[] = { 1, 2, 3, 4, INFINITY };
    checkText(siteCostSummarize(infinite, 5, &summary), @"value 5 of 5 is not finite", @"an infinite value is refused");
}

static void checkRuns(void) {
    int runs = 0;
    check(siteCostParseRuns("5", &runs) == nil && runs == 5, @"five runs are accepted");
    check(siteCostParseRuns("12", &runs) == nil && runs == 12, @"twelve runs are accepted");
    NSString *refused = @"--runs takes a whole number of at least 5";
    const char *texts[] = { "4", "0", "-5", "", "five", "5x", " 5", "5.5", "99999999999999999999" };
    for (size_t i = 0; i < sizeof texts / sizeof *texts; i++) {
        checkText(siteCostParseRuns(texts[i], &runs), [NSString stringWithFormat:@"%@, not %s", refused, texts[i]],
            [NSString stringWithFormat:@"--runs [%s] is refused", texts[i]]);
    }
    checkText(siteCostParseRuns(NULL, &runs), @"--runs takes a whole number of at least 5, not nothing", @"--runs without a value is refused");
}

static void checkRun(void) {
    SiteCostRun run = validRun(1);
    check(siteCostCheckRun(&run) == nil, @"a run of finite values and processes is valid");
    run.values[SiteCostGraphics] = -3;
    run.values[SiteCostNetwork] = -1;
    run.values[SiteCostContent] = -2;
    check(siteCostCheckRun(&run) == nil, @"a process that shrinks over the baseline has a negative increase");
    const SiteCostMetric notNegative[] = { SiteCostCpuRest, SiteCostCpuBackground, SiteCostLoad, SiteCostInputDelay };
    for (size_t i = 0; i < sizeof notNegative / sizeof *notNegative; i++) {
        run = validRun(1);
        run.values[notNegative[i]] = -0.5;
        checkText(siteCostCheckRun(&run), [NSString stringWithFormat:@"%s is negative: -0.5", siteCostMetricName(notNegative[i])],
            [NSString stringWithFormat:@"a negative %s is refused", siteCostMetricName(notNegative[i])]);
    }
    run = validRun(1);
    run.values[SiteCostContent] = NAN;
    checkText(siteCostCheckRun(&run), @"content_mb is not finite", @"a memory value that is not a number is refused");
    run = validRun(1);
    run.processes[1] = 0;
    checkText(siteCostCheckRun(&run), @"process 2 of 3 has the id 0", @"a process that does not exist is refused");
}

static void checkFile(void) {
    SiteCostRun run = validRun(1.5);
    run.values[SiteCostNetwork] = -0.25;
    SiteCostRun read;
    memset(&read, 0, sizeof read);
    // The fields are compared one by one, because the struct has padding that a copy need not keep.
    check(siteCostDecodeRun(siteCostEncodeRun(&run), &read) == nil && memcmp(run.values, read.values, sizeof run.values) == 0
        && memcmp(run.processes, read.processes, sizeof run.processes) == 0, @"a run survives its file");
    NSDictionary *object = [NSJSONSerialization JSONObjectWithData:siteCostEncodeRun(&run) options:0 error:nil];
    NSArray *keys = [object.allKeys sortedArrayUsingSelector:@selector(compare:)];
    check([keys isEqual:@[@"content_mb", @"cpu_background_percent", @"cpu_rest_percent", @"graphics_mb", @"input_delay_ms", @"load_ms", @"network_mb", @"processes"]],
        @"the file has one member for each metric and the processes");
    NSData *(^file)(void (^)(NSMutableDictionary *)) = ^NSData *(void (^change)(NSMutableDictionary *)) {
        NSMutableDictionary *copy = [[object mutableCopy] autorelease];
        change(copy);
        return [NSJSONSerialization dataWithJSONObject:copy options:0 error:nil];
    };
    checkText(siteCostDecodeRun(file(^(NSMutableDictionary *value) { [value removeObjectForKey:@"load_ms"]; }), &read),
        @"the file of a run has no number load_ms", @"a missing metric is refused");
    checkText(siteCostDecodeRun(file(^(NSMutableDictionary *value) { value[@"load_ms"] = @"fast"; }), &read),
        @"the file of a run has no number load_ms", @"a metric that is not a number is refused");
    checkText(siteCostDecodeRun(file(^(NSMutableDictionary *value) { value[@"other"] = @1; }), &read),
        @"the file of a run has the unknown member other", @"an unknown member is refused");
    checkText(siteCostDecodeRun(file(^(NSMutableDictionary *value) { value[@"processes"] = @[@1, @2]; }), &read),
        @"the file of a run has no list of 3 processes", @"a short process list is refused");
    checkText(siteCostDecodeRun(file(^(NSMutableDictionary *value) { value[@"load_ms"] = @-1; }), &read),
        @"load_ms is negative: -1", @"a run that the check refuses is refused");
    checkText(siteCostDecodeRun([@"[1]" dataUsingEncoding:NSUTF8StringEncoding], &read),
        @"the file of a run is not a JSON object", @"a file of another form is refused");
    checkText(siteCostDecodeRun([NSData data], &read), @"the file of a run is not a JSON object", @"an empty file is refused");
}

static void checkConversions(void) {
    check(near(siteCostIncreaseMegabytes(1048576, 3145728), 2), @"two megabytes over the baseline are 2");
    check(near(siteCostIncreaseMegabytes(3145728, 1048576), -2), @"a process below its baseline has a negative increase");
    double percent = 0;
    check(siteCostCpuPercent(100, 100 + 24000000, 2, 125, 3, &percent) == nil && near(percent, 50),
        [NSString stringWithFormat:@"one second in mach ticks of 125/3 over two seconds is 50 percent, not %g", percent]);
    check(siteCostCpuPercent(0, 3000000000, 1, 1, 1, &percent) == nil && near(percent, 300), @"three busy cores are 300 percent");
    checkText(siteCostCpuPercent(5, 4, 1, 1, 1, &percent), @"the CPU time went back from 5 to 4 ticks, so a process of the reading was replaced",
        @"a CPU time that goes back is refused");
    checkText(siteCostCpuPercent(1, 2, 0, 1, 1, &percent), @"the CPU window is 0 seconds", @"an empty window is refused");
    checkText(siteCostCpuPercent(1, 2, 1, 1, 0, &percent), @"the mach timebase is 1/0", @"a timebase without a denominator is refused");
}

static void checkReport(void) {
    const int runCount = 5;
    int total = kSiteCostSiteCount * runCount;
    SiteCostRun *runs = calloc(total, sizeof *runs);
    for (int site = 0; site < kSiteCostSiteCount; site++) {
        for (int run = 0; run < runCount; run++) runs[site * runCount + run] = validRun(site * 10 + run);
    }
    NSString *error = nil;
    NSString *report = siteCostReport(runs, runCount, &error);
    check(report != nil && error == nil, @"a report of five runs of each site is made");
    NSArray<NSString *> *lines = [report componentsSeparatedByString:@"\n"];
    check(lines.count == 2 + (NSUInteger)(kSiteCostSiteCount * SiteCostMetricCount), @"the report has a header, a row for each site and metric, and an end of line");
    checkText(lines[0], @"site             metric                   runs     median         q1         q3        iqr", @"the header names the columns");
    checkText(lines[1], @"google           content_mb                  5       2.00       1.00       3.00       2.00", @"the first row is the first metric of the first site");
    checkText(lines[7], @"google           input_delay_ms              5       8.00       7.00       9.00       2.00", @"the last metric of the first site");
    checkText(lines[8], @"google-business  content_mb                  5      12.00      11.00      13.00       2.00", @"the runs of the second site are its own");
    checkText(lines[49], @"tree             input_delay_ms              5      68.00      67.00      69.00       2.00", @"the last row is the last metric of the last site");

    error = nil;
    check(siteCostReport(runs, 4, &error) == nil, @"a report of four runs is not made");
    checkText(error, @"4 runs of each site are fewer than the 5 that a report needs", @"the refusal names the runs");
    runs[kSiteCostSiteCount * runCount - 1].values[SiteCostLoad] = -1;
    error = nil;
    check(siteCostReport(runs, runCount, &error) == nil, @"a report with a refused run is not made");
    checkText(error, @"site tree run 5: load_ms is negative: -1", @"the refusal names the site, the run and the metric");
    free(runs);
}

int main(void) { @autoreleasepool {
    checkSites();
    checkSummary();
    checkRuns();
    checkRun();
    checkFile();
    checkConversions();
    checkReport();
    fprintf(failures ? stderr : stdout, "%s: %d failures\n", failures ? "FAIL" : "PASS", failures);
    return failures ? 1 : 0;
}}
