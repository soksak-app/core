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
 * policy is sent again by the next call. `cids` are the identifiers of the settings change that brings the policy; the host stores
 * them in the `log.policy` of the policy, so the audit places the policy at that change (docs/spec/logging.md#policy). A policy that
 * the stored settings give has no change and no `cids`.
 */
export async function setLogPolicy(setting, cids) {
  const policy = logPolicyOf(setting);
  logGate.set(policy);
  const text = JSON.stringify(policy);
  if (!host || text === written) return;
  await host.call("log", cids === undefined ? { action: "policy", classes: policy } : { action: "policy", classes: policy, cids });
  written = text;
}
