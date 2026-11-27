// Runs each request of docs/spec/cases/agent-layout/requests.json once with claude against the debug mygo application, and judges the
// layout that `core.grid` reports after the run (F959-2). Each run starts its own application and its own folders: a disposable HOME, a
// disposable CLAUDE_CONFIG_DIR, a configuration folder and a project folder. The session token of the keychain item soksak-soul-check
// is passed to claude as CLAUDE_CODE_OAUTH_TOKEN and is never printed. Run it through `make check-agent-layout-runs`; it is not part of
// `make test`.
import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { judge } from "./agent-layout.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const bin = join(root, "target/debug/sok-mygo.app/Contents/MacOS");
const claude = process.env.CLAUDE_BIN ?? "claude";
const skill = readFileSync(join(root, "packages/sok/go/src/agents/SKILL.md"), "utf8");
const { requests } = JSON.parse(readFileSync(join(root, "docs/spec/cases/agent-layout/requests.json"), "utf8"));

// The token is read from the keychain item and kept in memory only.
function sessionToken() {
  return execFileSync("security", ["find-generic-password", "-s", "soksak-soul-check", "-w"], { encoding: "utf8" }).trim();
}

function sok(config, args) {
  return JSON.parse(execFileSync(join(bin, "sok"), [...args, "--config-dir", config], { encoding: "utf8" }));
}

// There is no event for the window or the status of the application through the command line, so the wait reads the statuses
// again after a short pause.
// A read before the endpoint file exists fails with "the application is not running"; only that failure means "not yet", and every
// other failure stops the run.
const NOT_RUNNING = "the application is not running";
async function until(read, what, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = null;
    try {
      value = read();
    } catch (error) {
      if (!String(error.stderr ?? error.message).includes(NOT_RUNNING)) throw error;
    }
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 250));
  }
}

// The run keeps every event of the transcript as one JSON line (stream-json), so the commands of the agent can be read afterwards.
function runClaude(prompt, env) {
  return new Promise((done, fail) => {
    execFile(claude, ["-p", "--output-format", "stream-json", "--verbose", "--append-system-prompt", skill, "--allowedTools", "Bash",
      "--permission-mode", "bypassPermissions", prompt], { env, timeout: 900000, maxBuffer: 256 * 1024 * 1024 }, (error, stdout) => {
      if (error) fail(new Error(`claude exited with ${error.code ?? error.signal}`));
      else {
        const events = stdout.trim().split("\n").map((line) => JSON.parse(line));
        done({ events, reply: events.findLast((event) => event.type === "result") });
      }
    });
  });
}

async function runRequest(request, token) {
  const dir = mkdtempSync(join(tmpdir(), "agent-layout-"));
  const home = join(dir, "home"), claudeConfig = join(dir, "claude"), config = join(dir, "config"), project = join(dir, "project");
  for (const folder of [home, claudeConfig, config, project]) mkdirSync(folder, { recursive: true });
  const app = spawn(join(bin, "sok-mygo"), ["--config-dir", config], { stdio: "ignore" });
  try {
    await until(() => sok(config, ["windows"]).length > 0, "the window");
    sok(config, ["core.project.open", "--root", project]);
    await until(() => sok(config, ["status", "core.grid"]), "the layout of the project");
    const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: claudeConfig, CLAUDE_CODE_OAUTH_TOKEN: token,
      SOKSAK_CONFIG_DIR: config, PATH: `${bin}:${process.env.PATH}` };
    const prompt = `Request: ${request.request}\nBuild this layout in the running application now, using the sok commands of the skill.`;
    const before = sok(config, ["status", "core.grid"]);
    const { events, reply } = await runClaude(prompt, env);
    const grid = sok(config, ["status", "core.grid"]);
    const failures = judge(grid.cards, request.predicates);
    // The transcript and the layouts before and after the run are kept in the run folder of the check, outside the repository.
    if (process.env.AGENT_LAYOUT_OUT) {
      mkdirSync(process.env.AGENT_LAYOUT_OUT, { recursive: true });
      writeFileSync(join(process.env.AGENT_LAYOUT_OUT, `${request.name}.transcript.jsonl`), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
      writeFileSync(join(process.env.AGENT_LAYOUT_OUT, `${request.name}.layouts.json`), JSON.stringify({ before, after: grid }, null, 2));
    }
    return { name: request.name, pass: failures.length === 0, failures, turns: reply.num_turns, cost: reply.total_cost_usd,
      error: reply.is_error };
  } finally {
    if (app.exitCode === null && app.signalCode === null) {
      app.kill("SIGTERM");
      await new Promise((done) => app.once("exit", done));
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

const token = sessionToken();
const results = [];
// AGENT_LAYOUT_ONLY names the requests to run, separated by commas; each run is one request.
const only = process.env.AGENT_LAYOUT_ONLY ? process.env.AGENT_LAYOUT_ONLY.split(",") : null;
for (const request of requests.filter((r) => only === null || only.includes(r.name))) {
  const result = await runRequest(request, token);
  results.push(result);
  console.log(JSON.stringify(result));
}
const passed = results.filter((result) => result.pass).length;
console.log(`${passed} of ${results.length} requests meet their layout`);
process.exitCode = passed === results.length ? 0 : 1;
