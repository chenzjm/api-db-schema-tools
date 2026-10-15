// 测试运行器：esbuild 打包 tests/all.ts 为 CJS 后用 node 执行（node:test 内建 runner）
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outdir = join(root, ".testtmp");
mkdirSync(outdir, { recursive: true });

await build({
	entryPoints: [join(root, "tests/xxljob/all.ts")],
	bundle: true,
	platform: "node",
	format: "cjs",
	outfile: join(outdir, "tests.cjs"),
	sourcemap: "inline",
	logLevel: "warning",
});

const res = spawnSync(process.execPath, [join(outdir, "tests.cjs")], {
	stdio: "inherit",
	env: process.env,
});
process.exit(res.status ?? 1);
