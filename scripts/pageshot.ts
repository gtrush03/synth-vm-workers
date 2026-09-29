// 1920x1080 stills of result pages for the film, from a tab in the server's own Chrome, always the PUBLIC (redacted) view.
//   bun scripts/pageshot.ts <out-dir> <name>=<path-or-url> ...
import { mkdir } from "node:fs/promises";
import { makeEye } from "../src/browser";
const [dir, ...pairs] = process.argv.slice(2);
await mkdir(dir!, { recursive: true });
const eye = makeEye("pageshot", () => {}, { cdp: "http://127.0.0.1:9377", on: true, server: "", headers: { "x-public": "1" } });
await eye.viewport(1920, 1080);
for (const p of pairs) {
  const [name, target] = [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)];
  const url = target.startsWith("http") ? target : `http://127.0.0.1:7990${target}`;
  const ok = await eye.goto(url, name); await Bun.sleep(2500);
  const b = await eye.shot();
  if (b) await Bun.write(`${dir}/${name}.jpg`, Buffer.from(b, "base64"));
  console.log(name, ok ? "ok" : "did not load", url);
}
await eye.close(); process.exit(0);
