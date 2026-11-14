// A host endpoint whose answers follow from the requests that it receives, for the stall tests of the window check:
//   node stall-host.mjs <configuration folder> [<pid that endpoint.json names>]
// It opens the log of a host (the logs folder with a log.open record), writes endpoint.json (the process of this program, or the
// given pid) and prints `ready`, then answers:
//   status.get of core.settings    no answer until status.get of core.verify arrives, then { done: true }
//   status.get of core.verify      true
//   diagnostics.drag               no answer
//   diagnostics.stall.dump         { boot: "b1", seq: 4, running: "wait_presented 3.0s" }
// Any other request gets the error 1000 that names the method. The program ends with its process or when its input ends.
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { encodeFrame, FrameReader } from "@soksak/client/frame.js";

const [configDir, pid = process.pid] = process.argv.slice(2);
mkdirSync(join(configDir, "logs"), { recursive: true });
writeFileSync(join(configDir, "logs", `host-1-${process.pid}.jsonl`),
  `${JSON.stringify({ ts_us: 1791000000000000, seq: 1, level: "info", layer: "host", event: "log.open", fields: { schema: 3 } })}\n`);
const address = join(configDir, "host.sock");
let held = null;
const server = createServer((socket) => {
  socket.on("error", () => {});
  const reader = new FrameReader();
  const reply = (id, result) => socket.write(encodeFrame({ jsonrpc: "2.0", id, result }));
  socket.on("data", (chunk) => {
    for (const { id, method, params } of reader.push(chunk)) {
      if (method === "status.get" && params.name === "core.settings") held = () => reply(id, { done: true });
      else if (method === "status.get" && params.name === "core.verify") {
        reply(id, true);
        held?.();
        held = null;
      } else if (method === "diagnostics.drag") {
        // No answer: the request stays pending until the connection ends.
      } else if (method === "diagnostics.stall.dump") reply(id, { boot: "b1", seq: 4, running: "wait_presented 3.0s" });
      else socket.write(encodeFrame({ jsonrpc: "2.0", id, error: { code: 1000, message: `the fixture host answers no ${method}` } }));
    }
  });
});
server.listen(address, () => {
  writeFileSync(join(configDir, "endpoint.json"), JSON.stringify({ transport: "unix", address, pid: Number(pid), application: "wailsv3",
    version: "0.0.40", executable: process.execPath, started: new Date().toISOString() }));
  process.stdout.write("ready\n");
});
