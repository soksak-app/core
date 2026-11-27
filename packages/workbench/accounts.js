// The accounts of the plugins of this window (docs/spec/plugins.md#accounts): the records of the plugin key accounts, the state that
// the status program of each account reports, the runs of the account programs through the host commands accountRun and
// accountRunCancel, and the homes through accountHomes, accountHomeCreate and accountHomeRemove. The settings tab draws the group
// Accounts from this state, and the core.accounts commands and status read and change it.

/** The form of the identifier of an account. */
const ACCOUNT_ID = /^[a-z][a-z0-9-]{0,39}$/;
/** The most characters of a name of an account and of a label of a usage line. */
const TEXT_MAX = 40;
/** The reads of the stored accounts before a change gives up, as runtime.data.change does (docs/spec/plugins.md#plugin-data). */
const CHANGE_READS = 64;
/** An ISO 8601 date and time. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

const characters = (text) => [...text].length;
// A control character is a character of the Unicode category Cc.
const hasControl = (text) => /\p{Cc}/u.test(text);
const isText = (text, max) => typeof text === "string" && characters(text) >= 1 && characters(text) <= max;
const isInstant = (text) => typeof text === "string" && INSTANT.test(text) && Number.isFinite(Date.parse(text));
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
// The names compare by their code points, so every workbench shows the same order.
const byName = (a, b) => {
  const one = [...a.name].map((c) => c.codePointAt(0));
  const other = [...b.name].map((c) => c.codePointAt(0));
  for (let i = 0; i < Math.min(one.length, other.length); i += 1) if (one[i] !== other[i]) return one[i] - other[i];
  return one.length - other.length;
};
const hasMembers = (value, members) => isObject(value) && Object.keys(value).sort().join() === [...members].sort().join();

/** Refuses a name that is not 1 to 40 characters without a control character. */
function checkName(name) {
  if (!isText(name, TEXT_MAX) || hasControl(name)) throw new Error("account name must be 1 to 40 characters without a control character");
}

/**
 * The reason why the stored records are not the current form, or null: an array of {id, name, kind} with an identifier, a name and a
 * declared kind, and no identifier and no name twice.
 */
function recordsReason(records, kinds) {
  if (!Array.isArray(records)) return "must be an array of {id, name, kind}";
  const ids = new Set();
  const names = new Set();
  for (const [index, record] of records.entries()) {
    if (!hasMembers(record, ["id", "name", "kind"])) return `record ${index} must be {id, name, kind}`;
    if (typeof record.id !== "string" || !ACCOUNT_ID.test(record.id)) return `record ${index} id ${JSON.stringify(record.id)} is not an account identifier`;
    if (!isText(record.name, TEXT_MAX) || hasControl(record.name)) return `record ${index} name must be 1 to 40 characters without a control character`;
    if (!kinds.some((kind) => kind.value === record.kind)) return `record ${index} kind ${JSON.stringify(record.kind)} is not declared`;
    if (ids.has(record.id)) return `id ${record.id} repeats`;
    if (names.has(record.name)) return `name ${record.name} repeats`;
    ids.add(record.id);
    names.add(record.name);
  }
  return null;
}

/** The reason why the output of a status program is not {login, until, usage}, or null. */
function statusReason(value) {
  if (!hasMembers(value, ["login", "until", "usage"])) return "printed no object {login, until, usage}";
  if (value.login !== true && value.login !== false && value.login !== null) return "printed a login that is not true, false or null";
  if (value.until !== null && !isInstant(value.until)) return "printed an until that is not an ISO 8601 text or null";
  if (!Array.isArray(value.usage)) return "printed a usage that is not a list";
  for (const [index, line] of value.usage.entries()) {
    if (!hasMembers(line, ["label", "used", "resets"])) return `printed usage ${index} that is not {label, used, resets}`;
    if (!isText(line.label, TEXT_MAX)) return `printed usage ${index} with a label that is not 1 to 40 characters`;
    if (typeof line.used !== "number" || !Number.isFinite(line.used) || line.used < 0 || line.used > 100) return `printed usage ${index} with a used that is not a number from 0 to 100`;
    if (line.resets !== null && !isInstant(line.resets)) return `printed usage ${index} with a resets that is not an ISO 8601 text or null`;
  }
  return null;
}

/** The reason why a run did not exit 0 with a whole output, or null. */
function exitReason(reply) {
  if (reply.code === 0 && !reply.truncated.stdout) return null;
  // The last line of the error output names the failure; a program that wrote nothing there adds no text to the reason.
  const last = reply.stderr.trim().split("\n").at(-1);
  const tail = last === "" ? "" : `: ${last}`;
  if (reply.code === null) return `ended without an exit status${tail}`;
  if (reply.code !== 0) return `exited with ${reply.code}${tail}`;
  return "printed a truncated output";
}

/**
 * The accounts of one window. host is the host transport of the page; declarations(plugin) answers {accounts, programs} of an installed
 * plugin or null; data(plugin) answers the plugin data of the plugin with get(key) and replace(key, base, value) (plugin-data.js);
 * changed() is called when the records, the state or the running logins change; failed(plugin, text) shows a failure through the error
 * display with the place settings <plugin>.
 */
export function createAccounts({ host, declarations, data, changed, failed }) {
  // The state that the last status run of each account reported: plugin → id → {login, until, usage}.
  const states = new Map();
  // The run of the login of each account while it runs: plugin → id → run.
  const logins = new Map();
  // The end of the last queued status or logout run of each plugin, after which the next one starts.
  const queues = new Map();
  // The folder accounts/ of the data folder of each plugin, which accountHomes answered; it does not change in a window.
  const folders = new Map();
  let lastRun = 0;
  let shown = null;
  // The listeners of a finished add or rename, each called with (command, plugin).
  const finishedListeners = new Set();
  const finished = (command, plugin) => { for (const fn of [...finishedListeners]) fn(command, plugin); };

  const entries = (table, plugin) => {
    if (!table.has(plugin)) table.set(plugin, new Map());
    return table.get(plugin);
  };

  /** The declaration of the accounts and the programs of plugin; a plugin without accounts is refused. */
  function declared(plugin) {
    const found = declarations(plugin);
    if (!found?.accounts) throw new Error(`plugin ${plugin} declares no accounts`);
    return found;
  }

  /** The stored records of plugin; a record of another form fails with the plugin and the reason. */
  function records(plugin) {
    const { accounts } = declared(plugin);
    const stored = data(plugin).get("accounts");
    const reason = recordsReason(stored, accounts.kinds);
    if (reason !== null) throw new Error(`plugin ${plugin} data accounts: ${reason}`);
    return stored;
  }

  function recordOf(plugin, id) {
    const record = records(plugin).find((item) => item.id === id);
    if (!record) throw new Error(`account ${id} is not defined`);
    return record;
  }

  function refuseRunning(plugin, record) {
    if (entries(logins, plugin).has(record.id)) throw new Error(`the login of account ${record.name} is running`);
  }

  /**
   * Stores the records that next makes from the stored records, with the stored records as the base, and reads them again when another
   * window stored first. next throws its refusal against the records that stand.
   */
  async function change(plugin, next) {
    for (let reads = 0; reads < CHANGE_READS; reads += 1) {
      const base = records(plugin);
      const value = next(structuredClone(base));
      if (await data(plugin).replace("accounts", base, value)) {
        changed();
        return value;
      }
    }
    throw new Error(`accounts of ${plugin}: other writers changed the records ${CHANGE_READS} times`);
  }

  /** Runs the account program of the role for record and answers its reply, or null for a run that ended before its exit. */
  async function run(plugin, role, record, started = () => {}) {
    const { accounts, programs } = declared(plugin);
    const folder = folders.get(plugin) ?? (await homes(plugin)).folder; // default: the first run of a plugin reads its folder.
    lastRun += 1;
    const id = lastRun;
    started(id);
    const reply = await host.call("accountRun", { plugin, programs, run: id, name: accounts.programs[role], args: [record.kind, `${folder}/${record.id}`] });
    if (reply === null) return null;
    const reason = exitReason(reply);
    if (reason !== null) throw new Error(`account ${record.name}: ${accounts.programs[role]} ${reason}`);
    return reply;
  }

  /** The folder of the homes of plugin and the names of its folders, through accountHomes. */
  async function homes(plugin) {
    const answer = await host.call("accountHomes", { plugin });
    folders.set(plugin, answer.folder);
    return answer;
  }

  /** Queues fn after the last queued run of plugin, so the status and logout runs of a plugin follow one another. */
  function queue(plugin, fn) {
    // default: a plugin that queued no run starts at once.
    const previous = queues.get(plugin) ?? Promise.resolve();
    // The run starts after the previous run settles either way; the failure of the previous run is the answer of its own caller.
    const done = previous.then(() => fn(), () => fn());
    queues.set(plugin, done);
    return done;
  }

  /** Runs status for the account id of plugin and keeps what it printed; a failure is shown and keeps the state before. */
  function readState(plugin, id) {
    return queue(plugin, async () => {
      const record = records(plugin).find((item) => item.id === id);
      if (!record) return;
      try {
        const reply = await run(plugin, "status", record);
        if (reply === null) return;
        let value;
        try {
          value = JSON.parse(reply.stdout);
        } catch {
          throw new Error(`account ${record.name}: ${declared(plugin).accounts.programs.status} printed no JSON`);
        }
        const reason = statusReason(value);
        if (reason !== null) throw new Error(`account ${record.name}: ${declared(plugin).accounts.programs.status} ${reason}`);
        entries(states, plugin).set(id, value);
        changed();
      } catch (error) {
        failed(plugin, error.message);
      }
    });
  }

  /** Runs status for every account of plugin; a failure of the records is shown. */
  function readStates(plugin) {
    let stored;
    try {
      stored = records(plugin);
    } catch (error) {
      failed(plugin, error.message);
      return Promise.resolve();
    }
    return Promise.all(stored.map((record) => readState(plugin, record.id)));
  }

  /** The least account-<n> that no record and no home of plugin has. */
  function freeId(stored, names) {
    const used = new Set([...stored.map((record) => record.id), ...names]);
    for (let n = 1; ; n += 1) if (!used.has(`account-${n}`)) return `account-${n}`;
  }

  async function add({ plugin, name, kind }) {
    const { accounts } = declared(plugin);
    checkName(name);
    if (!accounts.kinds.some((item) => item.value === kind)) throw new Error(`account kind ${kind} is not declared by ${plugin}`);
    if (records(plugin).some((record) => record.name === name)) throw new Error(`account name ${name} is already used`);
    const { names } = await homes(plugin);
    const id = freeId(records(plugin), names);
    await host.call("accountHomeCreate", { plugin, id });
    try {
      await change(plugin, (stored) => {
        if (stored.some((record) => record.name === name)) throw new Error(`account name ${name} is already used`);
        if (stored.some((record) => record.id === id)) throw new Error(`account ${id} is already defined`);
        return [...stored, { id, name, kind }];
      });
    } catch (error) {
      // The home of an identifier that no record holds belongs to no account; a home that a record of another window holds stays.
      if (!records(plugin).some((record) => record.id === id)) await host.call("accountHomeRemove", { plugin, id });
      throw error;
    }
    finished("core.accounts.add", plugin);
    readState(plugin, id);
    return { id };
  }

  async function rename({ plugin, id, name }) {
    checkName(name);
    refuseRunning(plugin, recordOf(plugin, id));
    await change(plugin, (stored) => {
      const record = stored.find((item) => item.id === id);
      if (!record) throw new Error(`account ${id} is not defined`);
      if (stored.some((item) => item.id !== id && item.name === name)) throw new Error(`account name ${name} is already used`);
      record.name = name;
      return stored;
    });
    finished("core.accounts.rename", plugin);
    readState(plugin, id);
    return null;
  }

  async function remove({ plugin, id }) {
    refuseRunning(plugin, recordOf(plugin, id));
    await change(plugin, (stored) => {
      if (!stored.some((item) => item.id === id)) throw new Error(`account ${id} is not defined`);
      return stored.filter((item) => item.id !== id);
    });
    entries(states, plugin).delete(id);
    await host.call("accountHomeRemove", { plugin, id });
    changed();
    return null;
  }

  async function login({ plugin, id }) {
    const record = recordOf(plugin, id);
    refuseRunning(plugin, record);
    const running = entries(logins, plugin);
    try {
      const reply = await run(plugin, "login", record, (runId) => {
        running.set(id, runId);
        changed();
      });
      if (reply === null) return null;
    } finally {
      running.delete(id);
      changed();
    }
    readState(plugin, id);
    return null;
  }

  async function loginCancel({ plugin, id }) {
    const record = recordOf(plugin, id);
    const runId = entries(logins, plugin).get(id);
    if (runId === undefined) throw new Error(`no login of account ${record.name} is running`);
    await host.call("accountRunCancel", { plugin, run: runId });
    return null;
  }

  async function logout({ plugin, id }) {
    const record = recordOf(plugin, id);
    refuseRunning(plugin, record);
    await queue(plugin, () => run(plugin, "logout", record));
    readState(plugin, id);
    return null;
  }

  /** The accounts of plugin in the order of their names, with the state of their last status run and whether their login runs. */
  function list(plugin) {
    const state = entries(states, plugin);
    const running = entries(logins, plugin);
    return records(plugin).toSorted(byName).map((record) => {
      // default: an account before its first status run has no login state and no usage.
      const { login: now, until, usage } = state.get(record.id) ?? { login: null, until: null, usage: [] };
      return { ...record, login: now, until, usage, running: running.has(record.id) };
    });
  }

  /** Records the plugin whose page the settings tab shows, or null; a page of a plugin with accounts that appears reads them. */
  function show(plugin) {
    const appears = plugin !== shown;
    shown = plugin;
    if (appears && plugin !== null && declarations(plugin)?.accounts) readStates(plugin);
  }

  /** Reads the accounts of the shown page again when the window becomes the key window. */
  function follow() {
    host.on("window-active", () => {
      if (shown !== null && declarations(shown)?.accounts) readStates(shown);
    });
  }

  /** The status core.accounts: the accounts of the shown page of a plugin with accounts, or null. */
  function status() {
    if (shown === null || !declarations(shown)?.accounts) return null;
    try {
      return { plugin: shown, accounts: list(shown) };
    } catch (error) {
      // A record of another form is shown through the error display, and the status holds no account.
      failed(shown, error.message);
      return { plugin: shown, accounts: [] };
    }
  }

  /** Registers fn(command, plugin) for each finished add and rename; returns the function that removes it. */
  function onFinished(fn) {
    finishedListeners.add(fn);
    return () => { finishedListeners.delete(fn); };
  }

  return { add, rename, remove, login, loginCancel, logout, list, show, follow, status, records, onFinished };
}
