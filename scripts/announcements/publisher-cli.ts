import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildFeed } from "./build-feed.js";
import { newPost } from "./new-post.js";

export async function publisherMain(args: string[]): Promise<void> {
  const [command, root, output, previous] = args;
  if (command === "new-post" && root && output && previous && args.length === 4) {
    console.log(await newPost(root, { title: output, summary: previous })); return;
  }
  if (command !== "build" || !root || !output || args.length > 4) throw new Error("Usage: publisher-cli.ts build CONTENT_ROOT NEW_OUTPUT_DIR [PREVIOUS_CONTENT_ROOT] | new-post CONTENT_ROOT TITLE SUMMARY");
  const relative = path.relative(path.resolve(root, "announcements"), path.resolve(output));
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("Output must be outside author sources");
  const built = await buildFeed(root, { previousRoot: previous });
  await mkdir(output); // Existing outputs fail closed; no recursive removal/overwrite.
  await writeFile(path.join(output, "payload.json"), built.payloadBytes, { flag: "wx" });
  const site = path.join(output, "site"); const media = path.join(site, "announcements/v1/media");
  await mkdir(media, { recursive: true });
  await writeFile(path.join(site, ".nojekyll"), "", { flag: "wx" });
  await writeFile(path.join(site, "index.html"), '<!doctype html><html lang="vi"><meta charset="utf-8"><title>JudgeDesk</title><p>Thông báo dành cho ứng dụng JudgeDesk.</p></html>\n', { flag: "wx" });
  const manifest: { name: string; sizeBytes: number }[] = [];
  for (const [name, bytes] of built.media) { await writeFile(path.join(media, name), bytes, { flag: "wx" }); manifest.push({ name, sizeBytes: bytes.length }); }
  await writeFile(path.join(output, "media-manifest.json"), JSON.stringify(manifest), { flag: "wx" });
  console.log(`Built sequence ${built.payload.sequence}: ${built.payload.items.length} notifications, ${manifest.length} images. Unsigned; not deployed.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  publisherMain(process.argv.slice(2)).catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Publisher failed"); process.exitCode = 1; });
}
