#import "site_cost.h"
#include <errno.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

enum { kMegabyte = 1048576 };

const SiteCostSite kSiteCostSites[] = {
    { "google", "https://www.google.com/" },
    { "google-business", "https://business.google.com/kr/business-profile/?ppsrc=GPDA2" },
    { "wikipedia", "https://en.wikipedia.org/wiki/Web_browser" },
    { "github", "https://github.com/" },
    { "naver", "https://www.naver.com/" },
    { "youtube", "https://www.youtube.com/" },
    { "tree", NULL },
};
const int kSiteCostSiteCount = (int)(sizeof kSiteCostSites / sizeof *kSiteCostSites);

NSString *const kSiteCostTreePage = @"<!doctype html><title>tree</title><main id=tree></main><script>"
    "let count = 0; const tree = document.getElementById('tree');"
    "const change = () => { const item = document.createElement('p'); item.textContent = String(++count);"
    " tree.replaceChildren(item); setTimeout(change, 0); };"
    "change();</script>";

static const char *const kMetricNames[SiteCostMetricCount] = {
    "content_mb", "graphics_mb", "network_mb", "cpu_rest_percent", "cpu_background_percent", "load_ms", "input_delay_ms",
};

const char *siteCostMetricName(SiteCostMetric metric) {
    return kMetricNames[metric];
}

const SiteCostSite *siteCostSiteNamed(const char *name) {
    for (int i = 0; i < kSiteCostSiteCount; i++) {
        if (strcmp(kSiteCostSites[i].name, name) == 0) return &kSiteCostSites[i];
    }
    return NULL;
}

static int compareValues(const void *a, const void *b) {
    double left = *(const double *)a;
    double right = *(const double *)b;
    return left < right ? -1 : left > right ? 1 : 0;
}

// The quartile p of the sorted values.
static double quartile(const double *sorted, int count, double p) {
    double position = (count - 1) * p;
    int lower = (int)floor(position);
    int upper = lower + 1 < count ? lower + 1 : lower;
    return sorted[lower] + (position - lower) * (sorted[upper] - sorted[lower]);
}

NSString *siteCostSummarize(const double *values, int count, SiteCostSummary *summary) {
    if (count < kSiteCostMinimumRuns) {
        return [NSString stringWithFormat:@"%d values are fewer than the %d runs that a summary needs", count, kSiteCostMinimumRuns];
    }
    for (int i = 0; i < count; i++) {
        if (!isfinite(values[i])) return [NSString stringWithFormat:@"value %d of %d is not finite", i + 1, count];
    }
    double *sorted = malloc(count * sizeof *sorted);
    if (!sorted) return @"the values cannot be sorted: no memory";
    memcpy(sorted, values, count * sizeof *sorted);
    qsort(sorted, count, sizeof *sorted, compareValues);
    summary->q1 = quartile(sorted, count, 0.25);
    summary->median = quartile(sorted, count, 0.5);
    summary->q3 = quartile(sorted, count, 0.75);
    summary->iqr = summary->q3 - summary->q1;
    free(sorted);
    return nil;
}

NSString *siteCostParseRuns(const char *text, int *runs) {
    NSString *refused = [NSString stringWithFormat:@"--runs takes a whole number of at least %d, not %s", kSiteCostMinimumRuns, text ? text : "nothing"];
    // strtol skips leading space, which is not a part of a number here.
    if (!text || text[0] < '0' || text[0] > '9') return refused;
    char *end = NULL;
    errno = 0;
    long value = strtol(text, &end, 10);
    if (errno != 0 || *end != '\0' || value < kSiteCostMinimumRuns || value > INT32_MAX) return refused;
    *runs = (int)value;
    return nil;
}

// The three memory values are increases over a baseline, so they can be negative.
static BOOL mayBeNegative(int metric) {
    return metric == SiteCostContent || metric == SiteCostGraphics || metric == SiteCostNetwork;
}

NSString *siteCostCheckRun(const SiteCostRun *run) {
    for (int metric = 0; metric < SiteCostMetricCount; metric++) {
        double value = run->values[metric];
        if (!isfinite(value)) return [NSString stringWithFormat:@"%s is not finite", kMetricNames[metric]];
        if (value < 0 && !mayBeNegative(metric)) return [NSString stringWithFormat:@"%s is negative: %g", kMetricNames[metric], value];
    }
    for (int i = 0; i < kSiteCostProcessCount; i++) {
        if (run->processes[i] <= 0) {
            return [NSString stringWithFormat:@"process %d of %d has the id %d", i + 1, kSiteCostProcessCount, run->processes[i]];
        }
    }
    return nil;
}

static NSString *const kProcessesKey = @"processes";

NSData *siteCostEncodeRun(const SiteCostRun *run) {
    NSMutableDictionary *object = [NSMutableDictionary dictionary];
    for (int metric = 0; metric < SiteCostMetricCount; metric++) object[@(kMetricNames[metric])] = @(run->values[metric]);
    NSMutableArray *processes = [NSMutableArray array];
    for (int i = 0; i < kSiteCostProcessCount; i++) [processes addObject:@(run->processes[i])];
    object[kProcessesKey] = processes;
    NSError *error = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:object options:0 error:&error];
    if (!data) {
        fprintf(stderr, "FAIL: a run cannot be written as JSON: %s\n", error.localizedDescription.UTF8String);
        exit(1);
    }
    return data;
}

NSString *siteCostDecodeRun(NSData *data, SiteCostRun *run) {
    id object = data.length > 0 ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    if (![object isKindOfClass:NSDictionary.class]) return @"the file of a run is not a JSON object";
    NSDictionary *file = object;
    SiteCostRun read;
    for (int metric = 0; metric < SiteCostMetricCount; metric++) {
        NSNumber *value = file[@(kMetricNames[metric])];
        if (![value isKindOfClass:NSNumber.class]) return [NSString stringWithFormat:@"the file of a run has no number %s", kMetricNames[metric]];
        read.values[metric] = value.doubleValue;
    }
    NSArray *processes = file[kProcessesKey];
    if (![processes isKindOfClass:NSArray.class] || processes.count != kSiteCostProcessCount) {
        return [NSString stringWithFormat:@"the file of a run has no list of %d processes", kSiteCostProcessCount];
    }
    for (int i = 0; i < kSiteCostProcessCount; i++) {
        if (![processes[i] isKindOfClass:NSNumber.class]) {
            return [NSString stringWithFormat:@"the file of a run has no list of %d processes", kSiteCostProcessCount];
        }
        read.processes[i] = [processes[i] intValue];
    }
    for (NSString *key in [file.allKeys sortedArrayUsingSelector:@selector(compare:)]) {
        BOOL known = [key isEqualToString:kProcessesKey];
        for (int metric = 0; metric < SiteCostMetricCount && !known; metric++) known = [key isEqualToString:@(kMetricNames[metric])];
        if (!known) return [NSString stringWithFormat:@"the file of a run has the unknown member %@", key];
    }
    NSString *refused = siteCostCheckRun(&read);
    if (refused) return refused;
    *run = read;
    return nil;
}

double siteCostIncreaseMegabytes(long baseline, long reading) {
    return (double)(reading - baseline) / kMegabyte;
}

NSString *siteCostCpuPercent(uint64_t startTicks, uint64_t endTicks, double wallSeconds, uint32_t numer, uint32_t denom, double *percent) {
    if (endTicks < startTicks) {
        return [NSString stringWithFormat:@"the CPU time went back from %llu to %llu ticks, so a process of the reading was replaced",
            startTicks, endTicks];
    }
    if (!(wallSeconds > 0)) return [NSString stringWithFormat:@"the CPU window is %g seconds", wallSeconds];
    if (denom == 0) return [NSString stringWithFormat:@"the mach timebase is %u/%u", numer, denom];
    double seconds = (double)(endTicks - startTicks) * numer / denom / 1e9;
    *percent = seconds / wallSeconds * 100;
    return nil;
}

NSString *siteCostReport(const SiteCostRun *runs, int runCount, NSString **error) {
    if (runCount < kSiteCostMinimumRuns) {
        *error = [NSString stringWithFormat:@"%d runs of each site are fewer than the %d that a report needs", runCount, kSiteCostMinimumRuns];
        return nil;
    }
    NSMutableString *report = [NSMutableString stringWithFormat:@"%-16s %-24s %4s %10s %10s %10s %10s\n",
        "site", "metric", "runs", "median", "q1", "q3", "iqr"];
    double *values = malloc(runCount * sizeof *values);
    if (!values) {
        *error = @"the values of a metric cannot be held: no memory";
        return nil;
    }
    for (int site = 0; site < kSiteCostSiteCount; site++) {
        const SiteCostRun *ofSite = &runs[site * runCount];
        for (int run = 0; run < runCount; run++) {
            NSString *refused = siteCostCheckRun(&ofSite[run]);
            if (refused) {
                free(values);
                *error = [NSString stringWithFormat:@"site %s run %d: %@", kSiteCostSites[site].name, run + 1, refused];
                return nil;
            }
        }
        for (int metric = 0; metric < SiteCostMetricCount; metric++) {
            for (int run = 0; run < runCount; run++) values[run] = ofSite[run].values[metric];
            SiteCostSummary summary;
            NSString *refused = siteCostSummarize(values, runCount, &summary);
            if (refused) {
                free(values);
                *error = [NSString stringWithFormat:@"site %s %s: %@", kSiteCostSites[site].name, kMetricNames[metric], refused];
                return nil;
            }
            [report appendFormat:@"%-16s %-24s %4d %10.2f %10.2f %10.2f %10.2f\n", kSiteCostSites[site].name, kMetricNames[metric],
                runCount, summary.median, summary.q1, summary.q3, summary.iqr];
        }
    }
    free(values);
    return report;
}
