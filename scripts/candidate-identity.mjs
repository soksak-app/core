import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

export const hashValue = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** The bytes of a release file, streamed without retaining the payload. */
export async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Content, executable permissions and internal links; extraction timestamps do not identify a bundle. */
export async function hashTree(directory) {
  const root = resolve(directory);
  if (!(await lstat(root)).isDirectory()) throw new Error(`${directory}: candidate tree must be a directory`);
  const entries = [];
  async function visit(folder) {
    for (const name of (await readdir(folder)).sort()) {
      const path = join(folder, name);
      const member = relative(root, path).replaceAll('\\', '/');
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        const target = await readlink(path);
        const inside = relative(root, resolve(folder, target));
        if (isAbsolute(target) || inside === '..' || inside.startsWith('../')) throw new Error(`${path}: candidate symlink points outside its tree`);
        entries.push([member, 'link', target]);
      } else if (info.isDirectory()) {
        entries.push([member, 'directory']);
        await visit(path);
      } else if (info.isFile()) entries.push([member, 'file', info.mode & 0o111, await hashFile(path)]);
      else throw new Error(`${path}: unsupported candidate tree entry`);
    }
  }
  await visit(root);
  return hashValue(entries);
}
