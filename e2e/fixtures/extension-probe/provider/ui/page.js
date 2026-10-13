// The surface of the provider probe: it imports the module of each connected item of its point items, calls its export
// describe with the item, and reports the answers as the status probeprovider.items (docs/spec/plugins.md#extension-points).
export async function mount(root, context) {
  const answers = [];
  for (const { plugin, item, module, fail } of context.contributions("items")) {
    try {
      const { describe } = await import(module);
      answers.push({ plugin, label: item.label, answer: describe(item) });
    } catch (error) {
      fail(error);
    }
  }
  root.textContent = answers.map((entry) => entry.answer).join("\n");
  context.exposure.status("probeprovider.items", () => answers, (fn) => { fn(answers); return () => {}; });
  context.status.report("ready");
  return { dispose() {} };
}
