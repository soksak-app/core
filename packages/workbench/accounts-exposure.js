// The accounts of this window (accounts.js) and their exposed entries: the core.accounts status and the core.accounts commands
// (docs/spec/plugins.md#accounts). The settings window draws the group 계정 from the same accounts.
import { host } from "@soksak/runtime";
import { registry } from "./exposure.js";
import { createAccounts } from "./accounts.js";
import { pluginAccounts } from "./environment.js";
import { onDataChange, viewDataOf } from "./plugin-data.js";

const listeners = new Set();
let display = null;

export const accounts = createAccounts({
  host,
  declarations: pluginAccounts,
  data: (plugin) => viewDataOf(null, plugin),
  changed: () => { for (const fn of listeners) fn(); },
  failed: (plugin, text) => {
    // A run starts only after the start installed the entries, which gives the error display.
    if (!display) throw new Error(`the accounts error display is not installed: ${text}`);
    display(plugin, text);
  },
});

/**
 * Registers the accounts entries, follows the key window, and calls changed when the accounts change, also when another window stores
 * the records. showError(plugin, text) shows an error with the place settings <plugin>.
 */
export function installAccountsExposure({ showError, changed }) {
  display = showError;
  listeners.add(changed);
  registry.status("core.accounts", () => accounts.status(), (fn) => {
    const send = () => fn(accounts.status());
    listeners.add(send);
    return () => listeners.delete(send);
  });
  registry.command("core.accounts.add", (params) => accounts.add(params));
  registry.command("core.accounts.rename", (params) => accounts.rename(params));
  registry.command("core.accounts.remove", (params) => accounts.remove(params));
  registry.command("core.accounts.login", (params) => accounts.login(params));
  registry.command("core.accounts.login-cancel", (params) => accounts.loginCancel(params));
  registry.command("core.accounts.logout", (params) => accounts.logout(params));
  onDataChange((project, plugin, key) => {
    if (project === null && key === "accounts" && pluginAccounts(plugin)?.accounts) for (const fn of [...listeners]) fn();
  });
  accounts.follow();
}
