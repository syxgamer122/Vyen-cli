import { exec as execShell, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { parseVersion } from './release-version.mjs';

const exec = promisify(execFile);
const runShell = promisify(execShell);

// cmd.exe needs quotes around arguments with spaces and around `process.execPath` (which
// normally lives under "C:\Program Files"). Unquoted program names such as `npm` and `gh`
// keep PATHEXT resolution, so `npm.cmd` and a test's `gh.cmd` are found.
function windowsArg(value) {
  return /[\s"&|<>^()]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// cmd.exe expands %NAME% even inside quotes. Pass such values through a child
// environment variable instead: the expansion is single-pass, so a literal
// `%TEMP%` in a checkout path survives.
function windowsArgument(value, index, env) {
  if (!value.includes('%')) return windowsArg(value);
  const key = `VYEN_RELEASE_ARG_${index}`;
  env[key] = value;
  return `"%${key}%"`;
}

// `npm test` exports the caller's npm config as npm_config_* variables. npm 12
// rejects an inherited allow-scripts value for a project-scoped `--prefix`
// install, so remove that one override while preserving registry, proxy and
// authentication settings supplied by the caller.
function withoutAllowScriptsEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^npm_config_allow_scripts$/i.test(key)) delete env[key];
  }
  return env;
}

export async function command(program, args, cwd) {
  if (process.platform === 'win32') {
    const env = withoutAllowScriptsEnv();
    const line = [windowsArg(program), ...args.map((arg, index) => windowsArgument(arg, index, env))].join(' ');
    const { stdout } = await runShell(line, { cwd, env, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    return stdout.trim();
  }
  const { stdout } = await exec(program, args, { cwd, env: withoutAllowScriptsEnv(), maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

export async function packRelease(root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  parseVersion(version);
  const output = join(root, 'release-out');
  await mkdir(output, { recursive: true });
  await command('npm', ['run', 'build'], root);
  const packOutput = JSON.parse(await command('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', output], root));
  // npm 11 and earlier print an array; npm 12 prints an object keyed by package name.
  const packed = Array.isArray(packOutput) ? packOutput : Object.values(packOutput);
  const filename = packed.length === 1 ? packed[0]?.filename : undefined;
  if (typeof filename !== 'string' || /[\\/]/.test(filename)) throw new Error('Unexpected npm pack output.');
  const archive = join(output, filename);
  const prefix = await mkdtemp(join(tmpdir(), 'vyen-release-'));
  try {
    await command('npm', ['install', '--prefix', prefix, archive, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], root);
    const bin = join(prefix, 'node_modules', '@nguyenhuumanh/vyen', 'bin', 'vyen.mjs');
    const reported = await command(process.execPath, [bin, '--version'], root);
    if (reported !== `vyen cli ${version}`) throw new Error(`Installed archive reports the wrong version: ${reported}`);
    await command(process.execPath, [bin, '--help'], root);
  } finally { await rm(prefix, { recursive: true, force: true }); }
  await copyFile(archive, join(output, 'vyen.tgz'));
  const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
  const checksums = join(output, 'SHA256SUMS.txt');
  await writeFile(checksums, `${digest}  ${filename}\n${digest}  vyen.tgz\n`);
  return { version, files: [archive, join(output, 'vyen.tgz'), checksums], output };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await packRelease()));
}
