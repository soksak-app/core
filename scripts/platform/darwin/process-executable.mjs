import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// proc_pidpath is the public kernel process path API. ps reports argv text, which a process can change independently of its executable.
const SCRIPT = `ObjC.import('Foundation');
ObjC.bindFunction('dlopen', ['void *', ['char *', 'int']]);
$.dlopen('/usr/lib/libproc.dylib', 2);
ObjC.bindFunction('proc_pidpath', ['int', ['int', 'void *', 'unsigned int']]);
function run(argv) {
  const data = $.NSMutableData.dataWithLength(4096);
  const length = $.proc_pidpath(Number(argv[0]), data.mutableBytes, 4096);
  if (length <= 0) throw Error('process executable identity unavailable');
  data.length = length;
  return ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
}`;

/** Reads the executable the kernel associates with the live PID; no application is activated. */
export async function processExecutable(pid, { execute = promisify(execFile) } = {}) {
  const { stdout } = await execute('/usr/bin/osascript', ['-l', 'JavaScript', '-e', SCRIPT, String(pid)],
    { encoding: 'utf8', timeout: 10000, maxBuffer: 64 * 1024 });
  return stdout.replace(/\r?\n$/, '');
}
