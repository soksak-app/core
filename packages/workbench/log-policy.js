// The policy of the event log as the page applies it (docs/spec/logging.md#classes-and-policy). The setting `diagnostics.log` names the
// least severe level that is stored for some classes; the page puts the policy in the gate that its batchers ask, and the host writes
// it to `<config-dir>/log-policy.json`, which the host and every sidecar watch.
import { host } from "@soksak/runtime";
import { logGate, logPolicyOf } from "./log-gate.js";

// The policy that the host wrote last for this document, as text; the same policy again is not written again.
let written = null;

/**
 * Puts the policy of the setting in force. A setting that names a class or a level outside the contract is refused before the gate
 * or the host sees it. The gate of the page changes at once; a refusal of the host is the error of the returned promise, and the same
 * policy is sent again by the next call.
 */
export async function setLogPolicy(setting) {
  const policy = logPolicyOf(setting);
  logGate.set(policy);
  const text = JSON.stringify(policy);
  if (!host || text === written) return;
  await host.call("log", { action: "policy", classes: policy });
  written = text;
}
