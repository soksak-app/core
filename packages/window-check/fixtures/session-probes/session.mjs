// The session of a probe check: a real Session on a client that is connected to the player of the endpoint case
// window-check-open-idle, which a session that sends no request needs. The session reads the event log and the recordings of
// `configDir` (the folder of the player when it is not given), from `eventStart` (the positions of the log in that folder at this
// moment when it is not given).
import { connect } from "@soksak/client";
import { sessionEventStart } from "../../event-log.mjs";
import { Session } from "../../app.mjs";
import { playApplication } from "../endpoint-player.mjs";

export async function probeSession(t, { configDir, eventStart } = {}) {
  const player = await playApplication(t, "window-check-open-idle", "probe");
  const client = await connect({ configDir: player.configDir });
  const folder = configDir ?? player.configDir;
  const session = new Session({ name: "probe", configDir: folder }, client);
  session.eventStart = eventStart ?? sessionEventStart(folder);
  return { session, close: () => client.close() };
}
