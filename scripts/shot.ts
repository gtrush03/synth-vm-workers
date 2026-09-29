// headless screenshot of the live page (own Playwright, never the shared Chrome). usage: bun scripts/shot.ts <out.png> [path] [w] [h]
// @ts-ignore  (playwright-core from the global MCP install)
import { chromium } from "/Users/georget/.local/share/mise/installs/node/22.22.0/lib/node_modules/@playwright/mcp/node_modules/playwright-core/index.mjs";
const [out, path = "/", w = "1440", h = "900"] = process.argv.slice(2);
const k = new URL((await Bun.file("runs/admin-url.txt").text()).trim()).searchParams.get("k");
const b = await chromium.launch({ headless: true, executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const p = await b.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 2 });
await p.goto(`${process.env.BASE ?? "http://localhost:7990"}${path}${path.includes("?") ? "&" : "?"}k=${k}`);
await p.waitForTimeout(Number(process.env.WAIT ?? 1500));
await p.screenshot({ path: out });
await b.close();
console.log(out);
