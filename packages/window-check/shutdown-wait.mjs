// Waits for the end of the endpoint connection of an application process, and reads its endpoint.json at that moment.
//
// The kernel closes the socket of a process when the process ends, and the client reports that end through `ended`. The
// host removes endpoint.json before its process ends (docs/spec/endpoint.md#discovery), so the state of the file at the end
// of the connection is the state after the removal. The wait takes no time from a file event: the folder watch of
// @parcel/watcher delivers a change with a delay that grows with the load of the machine.
import { existsSync } from "node:fs";


/**
 * Resolves with `{ closedMs }`, the time from `from` (a Date.now() value taken before the request that ends the application)
 * to the end of `client`, when `endpointFile` does not exist at that moment. It rejects with an error that names the file
 * when the file exists then, and with the limit when the connection does not end within `limit` ms.
 */
export function untilShutdown(client, endpointFile, { from, limit }) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`endpoint connection did not end within ${limit}ms`)), limit);
    client.ended.then(() => {
      clearTimeout(timer);
      const closedMs = Date.now() - from;
      if (existsSync(endpointFile)) {
        reject(new Error(`${endpointFile} exists ${closedMs}ms after the request; the host removes it before its process ends`));
        return;
      }
      resolve({ closedMs });
    });
  });
}
