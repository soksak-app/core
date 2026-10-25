/** Runs each reference key, reads its document, and checks it before starting the next key. */
export async function runReferenceSteps(keys, { press, read, verify, presented }) {
  for (const [index, key] of keys.entries()) {
    await press(key, index);
    const state = await read(key, index);
    await verify(state, key, index);
    await presented(key, index);
  }
}
