#!/usr/bin/env node
/**
 * Stores the event-issued Qloo key in .env.local for the app server, without echoing it.
 *
 *   npm run qloo:key
 *
 * The key is read with hidden input (never a CLI argument, so it stays out of shell history),
 * written with owner-only permissions, and never printed. .env.local is git-ignored.
 * The harness's own private config (`qloo setup --qloo`) also works; this script is for running
 * the app server with QLOO_API_KEY in its environment, as the kit's deploy guide describes.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const HACKATHON_BASE_URL = "https://hackathon.api.qloo.com";
const envFile = path.join(process.cwd(), ".env.local");

if (!process.stdin.isTTY) {
  console.error("Run this in an interactive terminal: the key is read with hidden input, never from a pipe or argument.");
  process.exit(1);
}

function readHidden(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const finish = (result) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
      resolve(result);
    };
    function onData(chunk) {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return finish(value);
        if (ch === "\u0003") { finish(null); process.exit(130); } // Ctrl-C
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    }
    stdin.on("data", onData);
  });
}

const key = (await readHidden("Qloo API key (input hidden, press Enter when done): "))?.trim();
if (!key) {
  console.error("No key entered; nothing changed.");
  process.exit(1);
}
if (/\s/.test(key) || key.length < 16) {
  console.error("That does not look like a Qloo key (too short or contains spaces); nothing changed.");
  process.exit(1);
}

// Replace any existing (or commented-out) Qloo lines and keep everything else, e.g. GEMINI_API_KEY.
const kept = (existsSync(envFile) ? readFileSync(envFile, "utf8") : "")
  .split(/\r?\n/)
  .filter((line) => line.trim() && !/^#?\s*QLOO_(API_KEY|BASE_URL|TRUSTED_BASE_URL)\s*=/.test(line.trim()));
const lines = [...kept, `QLOO_API_KEY=${key}`, `QLOO_BASE_URL=${HACKATHON_BASE_URL}`, `QLOO_TRUSTED_BASE_URL=${HACKATHON_BASE_URL}`];
const tmp = `${envFile}.tmp-${process.pid}`;
writeFileSync(tmp, lines.join("\n") + "\n", { mode: 0o600 });
renameSync(tmp, envFile);
console.log(`Saved QLOO_API_KEY (${key.length} characters) to .env.local with owner-only permissions.`);

// Readiness check without a network call; prints only the harness's status fields.
const status = spawnSync("qloo", ["setup", "--status", "--json"], {
  env: { ...process.env, QLOO_API_KEY: key, QLOO_BASE_URL: HACKATHON_BASE_URL, QLOO_TRUSTED_BASE_URL: HACKATHON_BASE_URL },
  encoding: "utf8",
});
try {
  const qloo = JSON.parse(status.stdout).qloo;
  console.log(`Harness sees the credential: ready=${qloo.ready}, source=${qloo.source}, mode=${qloo.mode}`);
} catch {
  console.log("Could not run `qloo setup --status`; is @qloo/qloo-harness installed?");
}
console.log("Next: restart the dev server, then run `npm run qloo:verify` for one small live check of every workflow the app uses.");
