// The list of sites, the checks of the input and the report of tests/site_cost_benchmark.m (make benchmark-site-cost). Nothing here
// needs a window or the network, so tests/site_cost_test.m checks it without either.
#import <Foundation/Foundation.h>
#include <stdint.h>

// The report needs this many runs of each site at least, because the interquartile range of fewer runs says nothing.
enum { kSiteCostMinimumRuns = 5 };

// What one run of one site reports. The three memory values are megabytes over the baseline without the tab, so a process that
// shrinks has a negative value; the others are not negative.
typedef enum {
    SiteCostContent,        // content_mb: the physical footprint of the WebContent process of the tab
    SiteCostGraphics,       // graphics_mb: the increase of the physical footprint of the GPU process
    SiteCostNetwork,        // network_mb: the increase of the physical footprint of the network process
    SiteCostCpuRest,        // cpu_rest_percent: the three processes in percent of one core, with the tab shown and no input
    SiteCostCpuBackground,  // cpu_background_percent: the three processes in percent of one core, with the tab hidden
    SiteCostLoad,           // load_ms: from the load request to the end of the load
    SiteCostInputDelay,     // input_delay_ms: the median from the native event of a press to the first handler of the page
    SiteCostMetricCount,
} SiteCostMetric;

const char *siteCostMetricName(SiteCostMetric metric);

// The processes of a run, which end before the next run starts.
enum { kSiteCostProcessCount = 3 };

typedef struct {
    double values[SiteCostMetricCount];
    int processes[kSiteCostProcessCount]; // the WebContent, GPU and network process
} SiteCostRun;

// A site of the fixed list. `address` is NULL for the site that the benchmark serves itself: the page kSiteCostTreePage.
typedef struct {
    const char *name;
    const char *address;
} SiteCostSite;

extern const SiteCostSite kSiteCostSites[];
extern const int kSiteCostSiteCount;

// The page that changes its tree without pause: each turn of its timer replaces one element.
extern NSString *const kSiteCostTreePage;

// The site with the name, or NULL.
const SiteCostSite *siteCostSiteNamed(const char *name);

// The quartiles of a list of values with linear interpolation between the sorted values: the quartile p of n values is at the
// position (n - 1) p, counted from 0. `iqr` is q3 - q1.
typedef struct {
    double q1;
    double median;
    double q3;
    double iqr;
} SiteCostSummary;

// The functions that can refuse their input return the reason, or nil when the input is valid and the result is written.
NSString *siteCostSummarize(const double *values, int count, SiteCostSummary *summary);

// Reads the argument of --runs: a whole number of at least kSiteCostMinimumRuns.
NSString *siteCostParseRuns(const char *text, int *runs);

// Checks a run: every value is finite, a value that cannot be negative is not, and every process is a positive id.
NSString *siteCostCheckRun(const SiteCostRun *run);

// The file that a measuring process gives the process that runs the sites: a JSON object with one number for each metric and the
// list `processes`. Decoding refuses a missing or unknown member and a run that siteCostCheckRun refuses.
NSData *siteCostEncodeRun(const SiteCostRun *run);
NSString *siteCostDecodeRun(NSData *data, SiteCostRun *run);

// The increase from `baseline` to `reading`, in bytes, in megabytes.
double siteCostIncreaseMegabytes(long baseline, long reading);

// The CPU time between two readings of ri_user_time + ri_system_time in percent of one core over `wallSeconds`. These fields of
// proc_pid_rusage count mach ticks, so `numer` and `denom` are the mach timebase.
NSString *siteCostCpuPercent(uint64_t startTicks, uint64_t endTicks, double wallSeconds, uint32_t numer, uint32_t denom, double *percent);

// The report of `runCount` runs of each site of the fixed list: `runs` holds runCount runs of the first site, then of the second,
// and so on. It has a header line and, per site and metric, the median, q1, q3 and iqr. It returns nil and sets *error when a
// run is refused or there are fewer than kSiteCostMinimumRuns.
NSString *siteCostReport(const SiteCostRun *runs, int runCount, NSString **error);
