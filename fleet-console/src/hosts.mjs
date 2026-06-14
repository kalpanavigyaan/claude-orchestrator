/**
 * Host adapters: build the child-process spawn for a session's runner.
 *
 *   local → run the runner with the host's Node, cwd = a Windows/native path.
 *   wsl   → run the runner inside a WSL distribution (cwd = a native Linux path), which
 *           avoids the Windows "UNC path as working directory" problem entirely because the
 *           runner executes inside the distro.
 *
 * The session's runner config is passed as a base64 `--config` argument so it survives the
 * Windows→WSL boundary without relying on environment-variable propagation.
 */

import process from "node:process";

/**
 * Translate a Windows path to its WSL `/mnt/<drive>/...` form.
 *
 * @example
 *   toMnt("E:\\\\GitHub\\\\app\\\\src\\\\runner.mjs");  // "/mnt/e/GitHub/app/src/runner.mjs"
 */
export function toMnt(winPath) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(winPath);
  if (!m) {
    return winPath.replace(/\\/g, "/");
  }
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
}

/**
 * Build the spawn descriptor for a session's runner.
 *
 * @param {object} session - the session record (host, distro, runnerPath, runnerConfig).
 * @param {string} runnerLocalPath - absolute path to runner.mjs on the host.
 * @returns {{ command: string, args: string[] }}
 *
 * @example
 *   buildSpawn({ host: "local", runnerConfig: { cwd: "E:/app" } }, "E:/fc/src/runner.mjs");
 *   // { command: <node>, args: ["E:/fc/src/runner.mjs", "--config", "<base64>"] }
 */
export function buildSpawn(session, runnerLocalPath) {
  const configB64 = Buffer.from(JSON.stringify(session.runnerConfig || {})).toString("base64");

  if (session.host === "wsl") {
    const distro = session.distro || "Ubuntu";
    const runnerLinux = session.runnerPath || toMnt(runnerLocalPath);
    if (session.node) {
      // A concrete node path was registered for this distro (setup-wsl-distro.ps1) — use it
      // directly; this is the proven path.
      return {
        command: "wsl.exe",
        args: ["-d", distro, "--", session.node, runnerLinux, "--config", configB64],
      };
    }
    // No registered node: `wsl -d distro -- node …` runs in a *non-login* shell where nvm has
    // not put node on PATH, which fails with "node: command not found" (exit 127). Resolve node
    // through a login shell that sources nvm, then exec it (no interactive flag → no job-control
    // noise on stderr).
    const inner =
      'export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; ' +
      'command -v node >/dev/null 2>&1 || { echo "fleet-console: node not found in distro" >&2; exit 127; }; ' +
      'exec node "$@"';
    return {
      command: "wsl.exe",
      args: ["-d", distro, "--", "bash", "-lc", inner, "fcrunner", runnerLinux, "--config", configB64],
    };
  }

  // local (Windows host or any native OS where the orchestrator runs)
  return {
    command: process.execPath,
    args: [runnerLocalPath, "--config", configB64],
  };
}
