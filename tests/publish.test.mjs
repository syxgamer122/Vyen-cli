import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { command } from '../scripts/pack-release.mjs';

const exec = promisify(execFile);
test('publishing creates the first tag, bumps on update and repairs a rerun without another bump', { timeout: 120000 }, async t => {
  assert.equal(await command(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', 'literal-%TEMP%'], process.cwd()), 'literal-%TEMP%');
  const savedRegistry = process.env.npm_config_registry, savedProxy = process.env.npm_config_https_proxy;
  process.env.npm_config_registry = 'https://registry.example/';
  process.env.npm_config_https_proxy = 'http://proxy.example/';
  try {
    const config = await command(process.execPath, ['-e', 'process.stdout.write(JSON.stringify([process.env.npm_config_registry, process.env.npm_config_https_proxy]))'], process.cwd());
    assert.deepEqual(JSON.parse(config), ['https://registry.example/', 'http://proxy.example/']);
  } finally {
    if (savedRegistry === undefined) delete process.env.npm_config_registry; else process.env.npm_config_registry = savedRegistry;
    if (savedProxy === undefined) delete process.env.npm_config_https_proxy; else process.env.npm_config_https_proxy = savedProxy;
  }
  const root = await mkdtemp(join(tmpdir(), 'vyen-publish-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const work = join(root, 'work'), remote = join(root, 'remote.git'), bin = join(root, 'fake-bin');
  await mkdir(join(work, 'scripts'), { recursive: true });
  await mkdir(join(work, 'bin'));
  await mkdir(bin);
  const git = async (...args) => (await exec('git', args, { cwd: work })).stdout.trim();
  await exec('git', ['init', '--bare', '--initial-branch=main', remote]);
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'Release Test');
  await git('config', 'user.email', 'test@example.invalid');
  await git('remote', 'add', 'origin', remote);
  const manifest = { name: '@nguyenhuumanh/vyen', version: '0.1.0', private: true, type: 'module', bin: { vyen: 'bin/vyen.mjs' }, files: ['bin'], scripts: { build: 'node --version' } };
  await writeFile(join(work, 'package.json'), JSON.stringify(manifest));
  await writeFile(join(work, 'npm-shrinkwrap.json'), JSON.stringify({ name: '@nguyenhuumanh/vyen', version: '0.1.0', lockfileVersion: 3, requires: true, packages: { '': { name: '@nguyenhuumanh/vyen', version: '0.1.0' } } }));
  await writeFile(join(work, '.gitignore'), 'node_modules/\nrelease-out/\n');
  await writeFile(join(work, 'bin/vyen.mjs'), "#!/usr/bin/env node\nimport {readFileSync} from 'node:fs'; const p=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')); console.log('vyen cli '+p.version);\n");
  for (const file of ['pack-release.mjs', 'publish-release.mjs', 'release-version.mjs']) await copyFile(join('scripts', file), join(work, 'scripts', file));
  const state = join(root, 'releases.json'), log = join(root, 'gh.log');
  await writeFile(state, '{}');
  await writeFile(join(bin, 'gh'), `#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2), [resource,command,tag]=args;
if(resource!=='release') throw Error('Unexpected gh command');
const state=JSON.parse(fs.readFileSync(process.env.GH_TEST_STATE,'utf8'));
fs.appendFileSync(process.env.GH_TEST_LOG,JSON.stringify(args)+'\\n');
if(command==='create'){if(state[tag])throw Error('Duplicate release');state[tag]={draft:true};}
if(command==='upload'){for(const f of args.slice(3)){if(f.startsWith('--'))break;if(!fs.existsSync(f))throw Error('Missing asset '+f);}}
if(command==='edit')state[tag].draft=false;
fs.writeFileSync(process.env.GH_TEST_STATE,JSON.stringify(state));
`, { mode: 0o755 });
  if (process.platform === 'win32') {
    // The publishing helper runs `gh` through cmd.exe on Windows; an extensionless
    // shebang file is not executable there, so provide the .cmd shim.
    await writeFile(join(bin, 'gh.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0gh" %*\r\n`);
  }
  const preload = join(root, 'mock-fetch.mjs');
  await writeFile(preload, `import {readFileSync} from 'node:fs';
globalThis.fetch=async url=>{
 if(!String(url).startsWith('https://api.github.com/repos/test/vyen-cli/releases/tags/'))throw Error('Unexpected request '+url);
 const tag=String(url).split('/').at(-1), state=JSON.parse(readFileSync(process.env.GH_TEST_STATE,'utf8'));
 return new Response(JSON.stringify(state[tag]??{}),{status:state[tag]?200:404,headers:{'content-type':'application/json'}});
};\n`);
  await git('add', '.');
  await git('commit', '-m', 'initial source');
  await git('push', 'origin', 'main');
  const first = await git('rev-parse', 'HEAD');
  const publish = async source => exec(process.execPath, ['scripts/publish-release.mjs'], {
    cwd: work, timeout: 60000, env: { ...process.env, PATH: bin + delimiter + process.env.PATH,
      GH_TOKEN: 'fake-local-test-token', GITHUB_REPOSITORY: 'test/vyen-cli', SOURCE_SHA: source,
      GH_TEST_STATE: state, GH_TEST_LOG: log, NODE_OPTIONS: '--import=' + pathToFileURL(preload).href,
      // Reproduce an exported npm config value: npm 12 rejects it for a
      // project-scoped --prefix install unless pack-release removes it.
      npm_config_allow_scripts: 'opencode-ai' },
  });
  await publish(first);
  assert.equal(await git('rev-parse', 'v0.1.0^{commit}'), first);
  assert.equal(JSON.parse(await readFile(state, 'utf8'))['v0.1.0'].draft, false);
  await writeFile(join(work, 'change.txt'), 'new source');
  await git('add', 'change.txt');
  await git('commit', '-m', 'source update');
  await git('push', 'origin', 'main');
  const update = await git('rev-parse', 'HEAD');
  await publish(update);
  const released = await git('rev-parse', 'HEAD');
  assert.notEqual(released, update);
  assert.equal(await git('rev-parse', 'v0.1.1^{commit}'), released);
  assert.equal((await exec('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/main'])).stdout.trim(), released);
  assert.equal(JSON.parse(await readFile(join(work, 'package.json'), 'utf8')).version, '0.1.1');
  assert.equal(JSON.parse(await readFile(join(work, 'npm-shrinkwrap.json'), 'utf8')).packages[''].version, '0.1.1');
  await git('checkout', '--detach', update);
  await publish(update);
  assert.equal(await git('rev-parse', 'HEAD'), released);
  assert.deepEqual((await git('tag', '--list')).split('\n'), ['v0.1.0', 'v0.1.1']);
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(args => args[1] === 'create').length, 2);
  assert.equal(calls.filter(args => args[1] === 'upload').length, 3);
});
