import assert from "node:assert/strict";
import test from "node:test";

import {
  attributeWebKit,
  cpuPercent,
  hostProcess,
  lsofMentions,
  parseCpuSamples,
  parseCpuTime,
  parseFootprint,
  parseLstart,
  parseProcessTable,
  sidecarProcesses,
  totalsOf,
} from "../measure-app-usage.mjs";

const DIR = "/Users/tester/Library/Application Support/soksak-check";

test("parses the cpu time formats of ps", () => {
  assert.equal(parseCpuTime("0:01.23"), 1.23);
  assert.equal(parseCpuTime("1:02:03.50"), 3723.5);
  assert.equal(parseCpuTime("2-01:00:00.00"), 2 * 86400 + 3600);
});

test("rejects a cpu time outside the ps format", () => {
  assert.throws(() => parseCpuTime("1:2"), /cpu time "1:2" is not in the \[\[dd-\]hh:\]mm:ss\.ss format/);
  assert.throws(() => parseCpuTime("0:75.00"), /cpu time "0:75.00" has seconds of 60 or more/);
});

test("reads phys_footprint of footprint, not the summary or the peak", () => {
  const text = [
    "=====================",
    "zsh [31610]: 64-bit    Footprint: 1687936 B (16384 bytes per page)",
    "=====================",
    "Auxiliary data:",
    "    phys_footprint: 1704320 B",
    "    phys_footprint_peak: 2000000 B",
    "",
  ].join("\n");
  assert.equal(parseFootprint(text), 1704320);
});

test("reports footprint output without a phys_footprint line", () => {
  assert.throws(() => parseFootprint("Footprint: 1687936 B\n"), /footprint output has no phys_footprint line/);
});

test("cpu percent is the cpu seconds used over the interval", () => {
  assert.equal(cpuPercent(10, 12.5, 10), 25);
  assert.equal(cpuPercent(3, 3, 10), 0);
});

test("cpu percent rejects a decrease and a non-positive interval", () => {
  assert.throws(() => cpuPercent(5, 4, 10), /cpu time decreased from 5 to 4/);
  assert.throws(() => cpuPercent(1, 2, 0), /interval must be a positive number of seconds \(0\)/);
});

test("parses ps cpu samples into seconds per pid", () => {
  const samples = parseCpuSamples("  123  0:01.50\n  456 1:02:03.00\n");
  assert.deepEqual([...samples.entries()], [[123, 1.5], [456, 3723]]);
});

test("parses ps command rows and rejects a malformed row", () => {
  assert.deepEqual(parseProcessTable("  123 /a/b --config-dir /d\n  456 /c\n"), [
    { pid: 123, command: "/a/b --config-dir /d" },
    { pid: 456, command: "/c" },
  ]);
  assert.throws(() => parseProcessTable("not-a-row\n"), /process row "not-a-row" has no pid/);
});

test("finds the host by the config-dir argument and skips tools, sidecars and WebKit", () => {
  const table = parseProcessTable([
    `  10 /Applications/soksak-check.app/Contents/MacOS/soksak --config-dir ${DIR}`,
    `  11 node scripts/measure-app-usage.mjs --sok /x/sok --config-dir ${DIR}`,
    `  12 /x/target/debug/sok windows --config-dir ${DIR}`,
    `  13 ${DIR}/sidecars/vt-alacritty/build/vt --config-dir ${DIR}`,
    `  14 /System/Library/WebKit.framework/com.apple.WebKit.Networking --config-dir ${DIR}`,
    "  15 /usr/bin/other --config-dir /elsewhere",
  ].join("\n"));
  assert.deepEqual(hostProcess(table, DIR), { pid: 10 });
});

test("matches a data folder whose launch path has a doubled slash", () => {
  const launched = DIR.replace("/Library/", "//Library/");
  const table = parseProcessTable([
    `  10 /Applications/soksak-check.app/Contents/MacOS/soksak --config-dir ${launched} --registry-ca ${launched}/ca.pem`,
    `  11 ${launched}/sidecars/vt/bin/vt --config-dir ${launched}`,
  ].join("\n"));
  assert.deepEqual(hostProcess(table, DIR), { pid: 10 });
  assert.deepEqual(sidecarProcesses(table, DIR), [{ role: "sidecar vt", pid: 11, attribution: "executable path" }]);
});

test("finds the host and the sidecars of a data folder that the processes launch by its real path", () => {
  const given = "/var/tester/soksak-check";
  const real = "/private/var/tester/soksak-check";
  const table = parseProcessTable([
    `  10 /Applications/soksak-check.app/Contents/MacOS/soksak --config-dir ${real}`,
    `  11 ${real}/sidecars/vt/bin/vt --x`,
  ].join("\n"));
  assert.deepEqual(hostProcess(table, given, real), { pid: 10 });
  assert.deepEqual(sidecarProcesses(table, given, real), [{ role: "sidecar vt", pid: 11, attribution: "executable path" }]);
});

test("reports a missing or duplicate host", () => {
  const none = parseProcessTable("  15 /usr/bin/other --config-dir /elsewhere\n");
  assert.throws(() => hostProcess(none, DIR), /no host process has --config-dir .*soksak-check/);
  const two = parseProcessTable(`  10 /a/soksak --config-dir ${DIR}\n  20 /b/soksak --config-dir ${DIR}\n`);
  assert.throws(() => hostProcess(two, DIR), /2 host processes have --config-dir/);
});

test("lists the sidecars whose executable is under the config dir", () => {
  const table = parseProcessTable([
    `  21 ${DIR}/sidecars/vt-alacritty/build/vt-alacritty --flag`,
    `  22 ${DIR}/sidecars/terminal/bin/terminal`,
    `  23 /other/sidecars/terminal/bin/terminal`,
  ].join("\n"));
  assert.deepEqual(sidecarProcesses(table, DIR), [
    { role: "sidecar vt-alacritty", pid: 21, attribution: "executable path" },
    { role: "sidecar terminal", pid: 22, attribution: "executable path" },
  ]);
});

test("finds the config dir in the lsof output of a process", () => {
  const text = [
    "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME",
    `com.apple 300 me txt REG 1,2 3 4 ${DIR}/cache/store.db`,
    "com.apple 300 me cwd DIR 1,2 96 2 /",
  ].join("\n");
  assert.equal(lsofMentions(text, DIR), true);
  assert.equal(lsofMentions(text.replace(DIR, "/Users/tester/other"), DIR), false);
});

test("reads the start time of ps lstart", () => {
  assert.equal(parseLstart("Sun Oct 18 06:52:13 2026"), new Date(2026, 9, 18, 6, 52, 13).getTime());
  assert.throws(() => parseLstart("yesterday"), /lstart "yesterday" is not a start time/);
});

test("attributes each WebKit process by data folder or by the start second of its networking process", () => {
  const second = new Date(2026, 9, 18, 6, 52, 13).getTime();
  const result = attributeWebKit([
    { pid: 300, kind: "networking", startedAt: second + 200, configDir: DIR },
    { pid: 301, kind: "gpu", startedAt: second + 900, configDir: null },
    { pid: 302, kind: "gpu", startedAt: second - 5000, configDir: null },
    { pid: 310, kind: "networking", startedAt: second, configDir: null },
    { pid: 320, kind: "networking", startedAt: second + 60_000, configDir: DIR },
    { pid: 330, kind: "gpu", startedAt: second + 61_000, configDir: null },
    { pid: 331, kind: "gpu", startedAt: second + 61_500, configDir: null },
    { pid: 340, kind: "networking", startedAt: second + 120_000, configDir: DIR },
  ]);
  assert.deepEqual(result.attributed, [
    { configDir: DIR, role: "webkit networking", pid: 300, attribution: "data folder" },
    { configDir: DIR, role: "webkit gpu", pid: 301, attribution: "start time" },
    { configDir: DIR, role: "webkit networking", pid: 320, attribution: "data folder" },
    { configDir: DIR, role: "webkit networking", pid: 340, attribution: "data folder" },
  ]);
  assert.deepEqual(result.unattributed, [
    { role: "webkit gpu", pid: 302, attribution: "unattributed" },
    { role: "webkit networking", pid: 310, attribution: "unattributed" },
    { role: "webkit gpu", pid: 330, attribution: "unattributed" },
    { role: "webkit gpu", pid: 331, attribution: "unattributed" },
  ]);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0], /webkit networking pid 320 .* no webkit gpu process/);
  assert.match(result.errors[1], /webkit networking pid 340 .* no webkit gpu process/);
});

test("two GPU processes in the start second of one networking process are an error, and both stay unattributed", () => {
  const second = new Date(2026, 9, 18, 6, 52, 13).getTime();
  const result = attributeWebKit([
    { pid: 400, kind: "networking", startedAt: second, configDir: DIR },
    { pid: 401, kind: "gpu", startedAt: second + 100, configDir: null },
    { pid: 402, kind: "gpu", startedAt: second + 900, configDir: null },
  ]);
  assert.deepEqual(result.attributed, [{ configDir: DIR, role: "webkit networking", pid: 400, attribution: "data folder" }]);
  assert.deepEqual(result.unattributed, [
    { role: "webkit gpu", pid: 401, attribution: "unattributed" },
    { role: "webkit gpu", pid: 402, attribution: "unattributed" },
  ]);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /webkit networking pid 400 .* 2 webkit gpu processes/);
});

test("totals count the attributed rows only", () => {
  const rows = [
    { role: "host", pid: 10, bytes: 100, cpuPercent: 1 },
    { role: "page w1", pid: 20, bytes: 50, cpuPercent: 0.5 },
  ];
  assert.deepEqual(totalsOf(rows), { bytes: 150, cpuPercent: 1.5 });
  assert.deepEqual(totalsOf([]), { bytes: 0, cpuPercent: 0 });
});
