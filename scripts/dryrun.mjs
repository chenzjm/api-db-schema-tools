// 干跑运行器：esbuild 打包 scripts/dryrun.ts 为 CJS 后用 node 执行
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outdir = join(root, ".testtmp");
mkdirSync(outdir, { recursive: true });

await build({
	entryPoints: [join(root, "scripts/dryrun.ts")],
	bundle: true,
	platform: "node",
	format: "cjs",
	outfile: join(outdir, "dryrun.cjs"),
	sourcemap: "inline",
	logLevel: "warning",
});

const res = spawnSync(process.execPath, [join(outdir, "dryrun.cjs"), ...process.argv.slice(2)], {
	stdio: "inherit",
	env: process.env,
});
process.exit(res.status ?? 1);
