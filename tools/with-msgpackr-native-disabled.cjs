const { spawn } = require("node:child_process");

const [command, ...args] = process.argv.slice(2);

if (!command) {
  console.error(
    "Usage: node with-msgpackr-native-disabled.cjs <command> [args...]",
  );
  process.exit(2);
}

// BullMQ's optional msgpackr native extractor segfaults under the required Node 22 runtime.
// Its pure JavaScript fallback preserves behavior and keeps app/test processes stable.
process.env.MSGPACKR_NATIVE_ACCELERATION_DISABLED ??= "true";

const child = spawn(command, args, {
  env: process.env,
  shell: process.platform === "win32",
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.once("error", (error) => {
  console.error(`Failed to start ${command}: ${error.message}`);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
