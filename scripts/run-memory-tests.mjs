import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = resolve(root, '.tmp', 'memory-tests');
const outfile = resolve(outdir, 'memory-document.test.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await build({
	entryPoints: [resolve(root, 'src', 'memory', 'memory-document.test.ts')],
	outfile,
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node20',
	sourcemap: 'inline',
});

const child = spawn(process.execPath, ['--test', outfile], {
	cwd: root,
	stdio: 'inherit',
});

const code = await new Promise((resolveExit) => {
	child.on('exit', (exitCode) => resolveExit(exitCode ?? 1));
});

await rm(outdir, { recursive: true, force: true });
process.exitCode = code;
