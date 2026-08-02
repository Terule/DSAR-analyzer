import { spawn } from "node:child_process";

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else
        reject(new Error(`${command} exited with code ${code ?? "unknown"}.`));
    });
  });
}

function capture(command, args) {
  return new Promise((resolve, reject) => {
    let output = "";
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "inherit"],
    });
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(output.trim());
      else
        reject(new Error(`${command} exited with code ${code ?? "unknown"}.`));
    });
  });
}

try {
  await run("docker", ["compose", "up", "-d", ...process.argv.slice(2)]);
  const published = await capture("docker", ["compose", "port", "app", "3000"]);
  const match = published.match(/:(\d+)$/);
  if (!match)
    throw new Error(`Could not read AIDA's published port: ${published}`);
  console.log(`\n[AIDA] Ready at http://localhost:${match[1]}\n`);
} catch (error) {
  console.error(
    `[AIDA] Startup failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
