// 로컬 엔드포인트 전송 방식별 JSON-RPC 왕복 지연 측정.
// 사용법: node bench/transport.mjs [--requests <n>] [--json]

import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { encodeFrame, FrameReader } from "../frame.js";

const WARMUP = 1000;
const CONCURRENCY = 100;
const METHOD = "status.get";
const PARAMS = { name: "core.screen" };
const RESULT = { value: "workspace" };

function parseArgs(argv) {
  const options = { requests: 20000, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--requests") {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`--requests expects a positive integer, got ${argv[i + 1]}`);
      }
      options.requests = value;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

// 요청 형식을 검사하고 고정 응답을 돌려준다.
function handleServerSocket(socket, onError) {
  socket.setNoDelay?.(true);
  const reader = new FrameReader();
  socket.on("data", (chunk) => {
    try {
      for (const message of reader.push(chunk)) {
        if (
          message?.jsonrpc !== "2.0" ||
          !Number.isInteger(message.id) ||
          message.method !== METHOD ||
          message.params?.name !== PARAMS.name
        ) {
          throw new Error(`Server received malformed request: ${JSON.stringify(message)}`);
        }
        socket.write(encodeFrame({ jsonrpc: "2.0", id: message.id, result: RESULT }));
      }
    } catch (error) {
      socket.destroy();
      onError(error);
    }
  });
  socket.on("error", onError);
}

// 하나의 영속 연결 위에서 id로 응답을 대응시킨다.
class Client {
  #socket;
  #reader = new FrameReader();
  #pending = new Map();
  #nextId = 1;
  #failure = null;

  constructor(socket) {
    this.#socket = socket;
    socket.on("data", (chunk) => {
      try {
        for (const message of this.#reader.push(chunk)) this.#settle(message);
      } catch (error) {
        this.#fail(error);
      }
    });
    socket.on("error", (error) => this.#fail(error));
    socket.on("close", () => {
      if (this.#pending.size > 0) this.#fail(new Error("Connection closed with pending requests"));
    });
  }

  request() {
    if (this.#failure) return Promise.reject(this.#failure);
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.write(encodeFrame({ jsonrpc: "2.0", id, method: METHOD, params: PARAMS }));
    });
  }

  close() {
    this.#socket.end();
  }

  #settle(message) {
    if (message?.jsonrpc !== "2.0" || !Number.isInteger(message.id)) {
      throw new Error(`Client received malformed response: ${JSON.stringify(message)}`);
    }
    const entry = this.#pending.get(message.id);
    if (!entry) {
      throw new Error(`Client received response for unknown id ${message.id}`);
    }
    if (message.result?.value !== RESULT.value) {
      throw new Error(`Client received unexpected result for id ${message.id}: ${JSON.stringify(message)}`);
    }
    this.#pending.delete(message.id);
    entry.resolve();
  }

  #fail(error) {
    if (this.#failure) return;
    this.#failure = error;
    for (const entry of this.#pending.values()) entry.reject(error);
    this.#pending.clear();
    this.#socket.destroy();
  }
}

// 오름차순 정렬 배열에서 nearest-rank 백분위수를 구한다.
function percentile(sorted, p) {
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

async function runSequential(client, count) {
  const samples = new Float64Array(count);
  const start = process.hrtime.bigint();
  for (let i = 0; i < count; i += 1) {
    const t0 = process.hrtime.bigint();
    await client.request();
    samples[i] = Number(process.hrtime.bigint() - t0) / 1000;
  }
  const elapsedNs = Number(process.hrtime.bigint() - start);
  samples.sort();
  return {
    p50: percentile(samples, 50),
    p90: percentile(samples, 90),
    p99: percentile(samples, 99),
    max: samples[count - 1],
    reqPerSec: count / (elapsedNs / 1e9),
  };
}

// 동시 진행 요청 수를 CONCURRENCY로 유지한다.
async function runPipelined(client, count) {
  let issued = 0;
  const worker = async () => {
    while (issued < count) {
      issued += 1;
      await client.request();
    }
  };
  const start = process.hrtime.bigint();
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, count) }, worker));
  const elapsedNs = Number(process.hrtime.bigint() - start);
  return count / (elapsedNs / 1e9);
}

async function benchTransport(name, listenArg, connectArg, requests) {
  let serverError = null;
  const server = net.createServer((socket) =>
    handleServerSocket(socket, (error) => {
      serverError ??= error;
    }),
  );
  server.listen(listenArg);
  await once(server, "listening");
  const target = connectArg(server);
  const socket = net.createConnection(target);
  await once(socket, "connect");
  socket.setNoDelay(true);
  const client = new Client(socket);
  try {
    for (let i = 0; i < WARMUP; i += 1) await client.request();
    const sequential = await runSequential(client, requests);
    const pipelined = await runPipelined(client, requests);
    if (serverError) throw serverError;
    return { transport: name, ...sequential, pipelinedReqPerSec: pipelined };
  } finally {
    client.close();
    server.close();
    await once(server, "close");
  }
}

function formatTable(rows) {
  const header = ["transport", "p50 µs", "p90 µs", "p99 µs", "max µs", "sequential req/s", "pipelined req/s"];
  const body = rows.map((r) => [
    r.transport,
    r.p50.toFixed(1),
    r.p90.toFixed(1),
    r.p99.toFixed(1),
    r.max.toFixed(1),
    Math.round(r.reqPerSec).toString(),
    Math.round(r.pipelinedReqPerSec).toString(),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
  const line = (cells) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
  return [line(header), widths.map((w) => "-".repeat(w)).join("  "), ...body.map(line)].join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const environment = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0]?.model ?? "unknown",
    requests: options.requests,
    warmup: WARMUP,
    concurrency: CONCURRENCY,
  };
  const rows = [];

  rows.push(
    await benchTransport("tcp-loopback", { host: "127.0.0.1", port: 0 }, (server) => ({
      host: "127.0.0.1",
      port: server.address().port,
    }), options.requests),
  );

  if (process.platform === "win32") {
    const pipePath = `\\\\.\\pipe\\soksak-bench-${process.pid}`;
    rows.push(await benchTransport("named-pipe", pipePath, () => pipePath, options.requests));
  } else {
    // 소켓 파일은 소유자 전용 임시 디렉터리에 둔다.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soksak-bench-"));
    try {
      fs.chmodSync(dir, 0o700);
      const socketPath = path.join(dir, "endpoint.sock");
      rows.push(await benchTransport("unix-socket", socketPath, () => socketPath, options.requests));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ environment, results: rows }, null, 2)}\n`);
    return;
  }
  console.log(`node ${environment.node}  platform ${environment.platform}  arch ${environment.arch}`);
  console.log(`cpu ${environment.cpu}`);
  console.log(`requests ${environment.requests}  warmup ${environment.warmup}  pipelined concurrency ${environment.concurrency}`);
  console.log("");
  console.log(formatTable(rows));
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});
