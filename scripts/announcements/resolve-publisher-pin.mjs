import { execFileSync } from "node:child_process";
import { readFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const SOURCE = "ducminh25/judgedesk-source";
/** @param {string} text */
export function parsePublisherPin(text) {
  const value = JSON.parse(text);
  if (!value || Object.keys(value).sort().join(",") !== "sourceCommit,sourceRepo" || value.sourceRepo !== SOURCE || !/^[0-9a-f]{40}$/.test(value.sourceCommit)) throw new Error("Publisher lock must pin judgedesk-source to a full reviewed commit SHA");
  return { sourceCommit: String(value.sourceCommit), sourceRepo: SOURCE };
}
async function main() {
  const root = process.argv[2]; const candidate = process.env.GITHUB_SHA;
  if (!root || !candidate || !/^[0-9a-f]{40}$/.test(candidate) || !process.env.GITHUB_EVENT_PATH || !process.env.GITHUB_OUTPUT) throw new Error("GitHub publication context is incomplete");
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
  const base = event.pull_request?.base?.sha;
  if (base && !/^[0-9a-f]{40}$/.test(base)) throw new Error("Invalid PR base commit");
  // No shell, no ref/path supplied by author HTML. PR tool code comes only from base main.
  const text = base ? execFileSync("git", ["-C", root, "show", `${base}:announcements/publisher.lock.json`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) : await readFile(path.join(root, "announcements/publisher.lock.json"), "utf8");
  const pin = parsePublisherPin(text);
  if (pin.sourceCommit !== process.env.ANNOUNCEMENTS_PUBLISHER_SOURCE_COMMIT) throw new Error("Publisher pin is not the separately approved source commit");
  const previous = base || (event.before && !/^0+$/.test(event.before) ? event.before : execFileSync("git", ["-C", root, "rev-parse", `${candidate}^`], { encoding: "utf8" }).trim());
  if (!/^[0-9a-f]{40}$/.test(previous)) throw new Error("Previous source commit is unavailable");
  let hasPrevious = false;
  try { execFileSync("git", ["-C", root, "cat-file", "-e", `${previous}:announcements/catalog.json`], { stdio: ["ignore", "pipe", "pipe"] }); hasPrevious = true; }
  catch (error) { if (candidate !== process.env.ANNOUNCEMENTS_BOOTSTRAP_COMMIT) throw new Error("Previous publication catalog is unavailable; explicit first-publication approval is required", { cause: error }); }
  await appendFile(process.env.GITHUB_OUTPUT, `publisher_sha=${pin.sourceCommit}\nprevious_sha=${hasPrevious ? previous : ""}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { console.error("Could not resolve approved publisher/base pin; no floating ref or automatic bootstrap is used."); process.exitCode = 1; });
