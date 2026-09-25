const css = `:host{display:flex;height:100%;flex-direction:column;background:var(--surface);color:var(--surface-fg);font:11px/1.45 ui-monospace,monospace}#out{flex:1;overflow:auto;padding:6px 9px;white-space:pre-wrap}#line{display:flex;gap:6px;padding:4px 9px 6px;border-top:1px solid color-mix(in srgb,var(--surface-fg) 22%,transparent)}input{flex:1;min-width:0;border:0;background:transparent;color:inherit;font:inherit;outline:0}button{border:0;background:transparent;color:inherit}`;

export async function mount(root, context) {
  root.innerHTML = `<style>${css}</style><div id="out" data-expose="shell.output"></div><div id="line"><span>$</span><input id="in" data-expose="shell.input" autocomplete="off"><button type="button" data-expose="shell.interrupt" data-command="shell.interrupt">^C</button><button type="button" data-expose="shell.clear" data-command="shell.clear">⌫</button></div>`;
  const composition = await context.composition.create({ regions: {}, overlays: {} });
  const out = root.querySelector("#out");
  const input = root.querySelector("#in");
  let open = false;
  let cwd = null;
  const shell = context.runtime.sidecar();
  const runs = new Map();
  let nextRun = 0;
  // 세션에 쓴 줄. 사이드바의 실행 기록 섹션이 shell.history 로 보인다.
  const history = [];
  const listeners = new Map(["output", "screen", "cwd", "runs", "history", "jobs"].map((name) => [name, new Set()]));
  const read = { output: () => [...out.children].map((line) => line.textContent), cwd: () => cwd,
    screen: () => ({ lines: [...out.children].map((line) => line.textContent), rows: Math.floor(out.clientHeight / 16), scrollTop: out.scrollTop }), runs: () => runs.size,
    history: () => history.slice(), jobs: () => [...runs].map(([id, run]) => ({ id, command: run.command })) };
  const runsChanged = () => { changed("runs"); changed("jobs"); };
  const changed = (name) => listeners.get(name)?.forEach((fn) => fn(read[name]()));
  const write = (text) => { for (const [i, part] of text.split("\n").entries()) { if (i || !open) out.append(document.createElement("div")); if (part) out.lastElementChild.append(part); } open = !text.endsWith("\n"); changed("output"); changed("screen"); };
  const registrations = [
    context.exposure.command("shell.write", ({ data }) => {
      const written = data.split("\n").filter((line) => line.trim());
      if (written.length) { history.push(...written); changed("history"); }
      return shell.send(context.surfaceId, { operation: "write", data });
    }),
    context.exposure.command("shell.interrupt", () => shell.send(context.surfaceId, { operation: "interrupt" })),
    context.exposure.command("shell.clear", async () => {
      out.replaceChildren(); open = false; changed("output"); changed("screen"); return null;
    }),
    context.exposure.command("shell.run", ({ command }) => {
    const id = `run-${++nextRun}`;
    const result = new Promise((resolve, reject) => runs.set(id, { resolve, reject, command }));
    runsChanged();
    shell.send(context.surfaceId, { operation: "run", id, command }).catch((error) => {
      const pending = runs.get(id);
      if (!pending) return;
      runs.delete(id);
      runsChanged();
      pending.reject(error);
    });
    return result;
    }),
  ];
  const watch = (name, fn) => (listener) => { listeners.get(name).add(listener); return () => listeners.get(name).delete(listener); };
  registrations.push(
    context.exposure.status("shell.output", read.output, watch("output")),
    context.exposure.status("shell.screen", read.screen, watch("screen")),
    context.exposure.status("shell.cwd", read.cwd, watch("cwd")),
    context.exposure.status("shell.runs", read.runs, watch("runs")),
    context.exposure.status("shell.history", read.history, watch("history")),
    context.exposure.status("shell.jobs", read.jobs, watch("jobs")),
    context.exposure.dom("shell.input", input),
    context.exposure.dom("shell.output", out),
    context.exposure.dom("shell.interrupt", root.querySelector('[data-command="shell.interrupt"]')),
    context.exposure.dom("shell.clear", root.querySelector('[data-command="shell.clear"]')),
  );
  await Promise.all(registrations);
  await context.exposure.delegate(root);
  await context.exposure.bind(input, "shell.write", () => {
    const data = input.value; input.value = ""; write(`$ ${data}\n`); return { data: `${data}\n` };
  }, { event: "keydown", when: (event) => event.key === "Enter" });
  await shell.on(context.surfaceId, (body) => {
    if (body.cwd !== undefined) { cwd = body.cwd; context.tab?.directory(cwd); changed("cwd"); return; }
    if (body.id !== undefined) {
      const pending = runs.get(body.id); runs.delete(body.id);
      runsChanged();
      if (body.error !== undefined) pending?.reject(new Error(body.error));
      else pending?.resolve({ output: body.output, exit: body.exit });
      return;
    }
    if (body.text !== undefined) write(body.text);
    else if (body.error !== undefined) write(`error: ${body.error}\n`);
  });
  // 셸에서 쪼갠 셸은 그 셸이 있던 곳에서, 아니면 사이드카가 프로젝트 루트에서 시작한다(docs/spec/sidecars.md).
  const directory = context.origin?.directory ?? null;
  await shell.send(context.surfaceId, { operation: "open", ...(directory === null ? {} : { directory }) });
  context.status.report("ready");
  return { async dispose() {
    await shell.send(context.surfaceId, { operation: "close" });
    await composition.dispose();
    root.replaceChildren();
  } };
}
