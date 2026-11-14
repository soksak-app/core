// The endpoint of an application for the tests of `open` (app.mjs): a case player of an endpoint case that writes endpoint.json
// with the name `application` for the application. The executable of the endpoint is the binary that the check names, and its
// start is after the build of that binary.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "@soksak/client";
import { startCasePlayer } from "@soksak/client/testing";

/**
 * Starts the case `name` for the application `application` and returns the player; `player.configDir` is the configuration
 * folder of the application with the logs folder of a host that has opened its log. The player closes when the test ends, and closing it throws when the case was not played to its end.
 */
export async function playApplication(t, name, application, options = {}) {
  const player = await startCasePlayer(name, options);
  t.after(() => player.close());
  const file = join(player.configDir, "endpoint.json");
  const endpoint = { ...JSON.parse(readFileSync(file, "utf8")), application };
  writeFileSync(file, JSON.stringify(endpoint));
  mkdirSync(join(player.configDir, "logs"));
  writeFileSync(join(player.configDir, "logs", `host-1-${endpoint.pid}.jsonl`),
    `${JSON.stringify({ ts_us: 1791000000000000, seq: 1, level: "info", layer: "host", event: "log.open", fields: { schema: 3 } })}\n`);
  return player;
}

/**
 * Plays the case `name` for the application `application` (playApplication) and returns a client connected to its endpoint
 * with the player; the client closes when the test ends, before the player.
 */
export async function playClient(t, name, application, options = {}) {
  const player = await playApplication(t, name, application, options);
  const client = await connect({ configDir: player.configDir });
  t.after(() => client.close());
  return { player, client };
}

/**
 * Plays the case `name` for the application `application` and returns a session of `Session` (app.mjs, which the caller imports
 * after it has set its environment) on a client connected to the endpoint of the player. `options.session` is the options of the
 * session.
 */
export async function playSession(t, Session, name, application, { session = {}, ...options } = {}) {
  const { player, client } = await playClient(t, name, application, options);
  return { player, client, session: new Session({ name: application, configDir: player.configDir }, client, session) };
}
