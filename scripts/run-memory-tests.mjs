import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = resolve(root, '.tmp', 'memory-tests');
const outfiles = [
	'memory-document.test.mjs',
	'context-router.test.mjs',
].map((name) => resolve(outdir, name));

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await Promise.all([
	buildTest('memory-document.test.ts', outfiles[0]),
	buildTest('context-router.test.ts', outfiles[1]),
]);

const child = spawn(process.execPath, ['--test', ...outfiles], {
	cwd: root,
	stdio: 'inherit',
});

const code = await new Promise((resolveExit) => {
	child.on('exit', (exitCode) => resolveExit(exitCode ?? 1));
});

await rm(outdir, { recursive: true, force: true });
process.exitCode = code;

function buildTest(entry, outfile) {
	return build({
		entryPoints: [resolve(root, 'src', 'memory', entry)],
		outfile,
		bundle: true,
		format: 'esm',
		platform: 'node',
		target: 'node20',
		sourcemap: 'inline',
	});
}
