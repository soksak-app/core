// Fixture program of the language adapter tests. It writes the files that its options name to the standard streams, touches a file,
// ends by the signal that --signal names, waits, or exits with the status of --exit (0 by default). The replies follow from the
// options and the files they name.
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
let exitCode = 0;
let signal;
let hang = false;
for (let index = 0; index < args.length; index += 1) {
  const option = args[index];
  if (option === '--stdout') process.stdout.write(readFileSync(args[++index]));
  else if (option === '--stderr') process.stderr.write(readFileSync(args[++index]));
  else if (option === '--touch') writeFileSync(args[++index], '');
  else if (option === '--exit') exitCode = Number(args[++index]);
  else if (option === '--signal') signal = args[++index];
  else if (option === '--hang') hang = true;
  else throw new Error(`unknown option ${option}`);
}
if (hang) setInterval(() => {}, 1000);
else if (signal !== undefined) process.kill(process.pid, signal);
else process.exitCode = exitCode;
