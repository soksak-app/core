// The page module of a view that fetches the files of its plugin relative to its own module, as a plugin page does.
/** Fetches the address relative to this module and reports the status and the text of the response (null when none is served). */
export async function read(path) {
  const response = await fetch(new URL(path, import.meta.url));
  return { status: response.status, body: response.ok ? await response.text() : null };
}
