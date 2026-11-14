// A stall sample that a request starts after STALL_AFTER belongs to its session: the session finish waits for it and
// reports its result or its failure, so no sample process outlives the check (F292-47). The host is the tracked program
// fixtures/stall-host.mjs, a running process that sample records and that answers the requests of the check by rule.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { connect } from "@soksak/client";

delete process.env.SOKSAK_RUN_ID;
delete process.env.SOKSAK_RUN_FOLDER;
import { sessionEventBoot, sessionEventStart } from "../event-log.mjs";
const { finishSession, Session } = await import("../app.mjs");

const host = fileURLToPath(new URL("../fixtures/stall-host.mjs", import.meta.url));

/** The ordinary configuration folder of a host: its logs folder holds the log that the host opened and the sample reports. */
function folder(t) {
  const configDir = mkdtempSync(join(tmpdir(), "soksak-stall-session-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  return configDir;
}

/** Starts the fixture host in its folder, naming `pid` in endpoint.json when it is given, and connects a session with a stall delay of zero. */
async function stalledSession(t, pid) {
  const configDir = folder(t);
  const child = spawn(process.execPath, [host, configDir, ...(pid === undefined ? [] : [String(pid)])], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => child.kill("SIGKILL"));
  await once(child.stdout, "data");
  const client = await connect({ configDir });
  t.after(() => client.close());
  // Every request of the session has a stall delay of zero (the option stallAfter), so a pending request starts its sample at once.
  const session = new Session({ name: "probe", configDir }, client, { stallAfter: 0 });
  // The positions of the event log at the start of the check, as open reads them.
  session.eventStart = sessionEventStart(configDir);
  session.eventBoot = sessionEventBoot(configDir, client.endpoint.pid);
  return session;
}

function probe() {
  const diagnostics = [];
  return { diagnostics, check: { name: "probe check", passed: true, diagnostic: (line) => diagnostics.push(line) } };
}

/** Starts the request `ask` of the session and resolves to its reply when the stall of the session has announced its sample. */
async function stalled(session, ask) {
  const started = once(session.stalls, "started");
  const reply = ask();
  const [what] = await started;
  return { reply, what };
}

test("the session finish waits for a stall sample that a request answered after its stall delay started", { timeout: 60000 }, async (t) => {
  const session = await stalledSession(t);
  const { reply, what } = await stalled(session, () => session.get("core.settings"));
  assert.equal(what, "probe status.get core.settings");
  // The host answers the first request when the second arrives, while the sample of its process still runs. The second request goes
  // to the connection itself, so that it starts no stall of its own.
  assert.equal(await session.client.request("status.get", { window: "main", name: "core.verify" }), true);
  assert.deepEqual(await reply, { done: true });
  const { diagnostics, check } = probe();
  // The order in which the sample and the session finish end: the finish ends after the sample process.
  const order = [];
  const [sample] = session.stallSamples;
  const sampled = sample.then(() => order.push("sample ended"));
  await Promise.all([sampled, finishSession(check, session, () => {}).then(() => order.push("session finished"))]);
  assert.deepEqual(order, ["sample ended", "session finished"], "the session finished while its stall sample process still ran");
  const logs = join(session.app.configDir, "logs").replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  assert.deepEqual(diagnostics.filter((line) => line.startsWith("stall sample")).map((line) => new RegExp(
    `^stall sample: probe status\\.get core\\.settings still pending after 0 ms; the host's threads at that moment: ` +
    `${logs}/stall-\\d+-\\d+\\.txt; host\\.stall\\.dump at b1:4; running host calls of main: wait_presented 3\\.0s$`).test(line)), [true]);
});

// A stall sample is a record of the check, as a recording is: a sample that a loaded machine or the sample tool cannot finish
// is reported with its reason, and the result of the check stays the result of what it checked (F775).
test("the session finish reports a stall sample that failed and does not fail the check for it", { timeout: 60000 }, async (t) => {
  // The system process launchd of macOS: sample of another user's process fails, so the sample of the host fails with the reason of the tool.
  const session = await stalledSession(t, 1);
  const { reply } = await stalled(session, () => session.get("core.settings"));
  assert.equal(await session.client.request("status.get", { window: "main", name: "core.verify" }), true);
  await reply;
  const { diagnostics, check } = probe();
  await finishSession(check, session, () => {});
  assert.deepEqual(diagnostics.filter((line) => line.startsWith("cleanup failed")), []);
  const lines = diagnostics.filter((line) => line.startsWith("stall sample"));
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0], /^stall sample: probe status\.get core\.settings still pending after 0 ms; sampling the host failed: sample 1 exited with 255: .*sample cannot examine process 1 \(launchd\)/);
});
