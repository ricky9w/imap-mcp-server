import { runCli } from './index.js';

// Entry for dist/cli.js (bin: imap-mcp-cli). The CLI itself lives in index.ts,
// free of side effects so tests can run it in-process.
runCli(process.argv.slice(2), {
  env: process.env,
  stdout: text => process.stdout.write(text),
  stderr: text => process.stderr.write(text),
}).then(code => {
  process.exitCode = code;
});
