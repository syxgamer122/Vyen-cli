import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { MAX_API_RETRIES } from '../dist/harness.js';
import { configSchema, DEFAULT_GATEWAY_URL } from '../dist/config.js';

test('SPEC matches the implemented retry, budget and MCP-resource contract, and README states the real release and gateway facts', async () => {
  const [spec, readme, agents, validation, roadmap, critique, workflow, mcp] = await Promise.all([
    readFile('docs/SPEC.md', 'utf8'),
    readFile('README.md', 'utf8'),
    readFile('AGENTS.md', 'utf8'),
    readFile('docs/VALIDATION.md', 'utf8'),
    readFile('docs/ROADMAP.md', 'utf8'),
    readFile('docs/CRITIQUE_VERIFICATION.md', 'utf8'),
    readFile('.github/workflows/release.yml', 'utf8'),
    readFile('src/mcp.ts', 'utf8'),
  ]);

  assert.equal(MAX_API_RETRIES, 3);
  assert.equal(configSchema.parse({}).runTokenBudget, 0);
  assert.equal(DEFAULT_GATEWAY_URL, 'https://api.yuristore.xyz/v1');
  assert.match(spec, /api\.yuristore\.xyz/);
  assert.match(readme, /api\.yuristore\.xyz/);
  assert.match(mcp, /registry\.register\('list_mcp_resources'/);
  assert.match(mcp, /registry\.register\('read_mcp_resource'/);
  assert.match(spec, /Three retries/);
  assert.match(spec, /Default run token budget: 0 \(unlimited\)/);
  assert.match(spec, /tools and\s+resources are supported/);
  assert.doesNotMatch(spec, /Two retries/);
  assert.doesNotMatch(spec, /Default run token budget: 100,000/);
  assert.doesNotMatch(spec, /No sampling, OAuth, resources/);

  const sourceFiles = (await readdir('src')).filter(name => name.endsWith('.ts'));
  assert.equal(sourceFiles.length, 30);
  for (const file of sourceFiles) assert.ok(agents.includes(`src/${file}`), `AGENTS.md omits src/${file}`);

  const validationText = validation.replace(/\s+/g, ' ');
  assert.match(validationText, /202 tests, 194 pass, 5 fail, 3 skipped/);
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const name of [
    'model-initiated image reads outside the workspace require approval; workspace images do not',
    'existing files require a fresh read; edits preserve file mode',
    'edits preserve exact permissions under restrictive umasks; new files obey umask',
    'workspace containment rejects ../ and symlink escapes including missing leaves',
    'portable search is bounded and skips symlinks',
  ]) assert.match(validationText, new RegExp(escape(name)));

  assert.match(workflow, /tags:\s*\['v\*'\]/);
  assert.match(workflow, /npm publish --provenance --access public/);
  assert.doesNotMatch(workflow, /npm version|gh release create/);
  assert.match(readme, /Job publish chỉ chạy\s+khi push tag `v\*`/);
  assert.match(spec, /## Automated npm releases/);
  assert.doesNotMatch(spec, /## Automated GitHub releases/);
  assert.match(validationText, /For the 0\.2\.2 upstream record/);
  assert.doesNotMatch(validationText, /No Android\/Termux device, ARM64, macOS or Windows was available/);
  assert.match(spec, /third-party destination/);
  assert.match(spec, /one-time warning/);
  assert.match(spec, /setup wizard/);
  assert.match(spec, /effectiveBaseUrl/);
  assert.match(readme, /cảnh báo một lần/);
  assert.match(readme, /effectiveBaseUrl/);
  assert.match(readme, /wizard setup/);
  assert.match(roadmap, /R0\.9 is resolved/);
  assert.doesNotMatch(roadmap, /R0\.9 is still an open/);
  assert.match(roadmap, /DEFAULT_GATEWAY_URL/);
  assert.match(critique, /R0\.9 resolved/);
  assert.match(validationText, /R0\.9 is covered/);
  assert.match(readme, /\[.*ROADMAP\.md.*\]/);
  assert.doesNotMatch(readme, /tự động tăng phiên bản patch/);
  assert.doesNotMatch(readme, /Cài bản GitHub Release/);
  assert.doesNotMatch(readme, /Bản cài và checksum/);
  assert.match(readme, /GitHub Releases hiện \*\*không\*\* được tạo tự động/);
  assert.match(readme, /Lưu ý bảo mật/);
  assert.match(critique, /Explicit flag-level prefix bypasses closed/);
  assert.doesNotMatch(critique, /Explicit prefix bypass closed/);
  assert.match(critique, /--test-reporter/);
  assert.match(roadmap, /--test-reporter/);
  assert.match(validationText, /--test-reporter/);
  assert.doesNotMatch(roadmap, /Fix the six document drifts/);
  assert.match(roadmap, /six document drifts and module tests landed on 2026-10-24/);
});

test('SPEC documents the 8 hook events table and Claude Code inspiration', async () => {
  const [spec, readme, roadmap, help] = await Promise.all([
    readFile('docs/SPEC.md', 'utf8'),
    readFile('README.md', 'utf8'),
    readFile('docs/ROADMAP.md', 'utf8'),
    readFile('src/help.ts', 'utf8'),
  ]);

  // Hook event matrix in SPEC
  for (const event of [
    'SessionStart', 'SessionEnd', 'UserPromptSubmit',
    'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
    'PreCompact', 'Stop',
  ]) {
    assert.match(spec, new RegExp(`\\|\\s*\`?${event}\`?\\s*\\|`));
  }

  // Claude Code disclosure
  assert.match(spec, /Claude Code/i);
  assert.match(roadmap, /Claude Code/i);

  // --trust-workspace documented
  assert.match(help, /--trust-workspace/);
  assert.match(readme, /--trust-workspace/);
});

test('SPEC documents accurate hook payloads and fail-closed exit codes', async () => {
  const spec = await readFile('docs/SPEC.md', 'utf8');
  assert.match(spec, /tokens.*trigger/);
  assert.match(spec, /Exit 2 or error\/timeout: Denies tool execution \(fail-closed\)/);
  assert.match(spec, /SessionStart.*Injects stdout as system context/);
  assert.match(spec, /UserPromptSubmit.*Injects stdout as prompt context/);
  assert.match(spec, /PostToolUse.*Injects stdout as context/);
  assert.match(spec, /Stop.*reason/);
  assert.doesNotMatch(spec, /stopHookActive/);
});

test('SPEC documents version-agnostic title, Base URL /v1 normalization, and subagent session lifecycle distinction', async () => {
  const spec = await readFile('docs/SPEC.md', 'utf8');
  assert.match(spec, /^# Vyen CLI\r?\n/, 'SPEC title must be version-agnostic "# Vyen CLI"');
  assert.doesNotMatch(spec, /^# Vyen CLI 0\.2/, 'SPEC title must not carry legacy 0.2 version');
  assert.match(spec, /localhost:8000|127\.0\.0\.1:8000/, 'SPEC must document gateway /v1 auto-normalization');
  assert.match(spec, /child (?:session|SessionStore)|subagents?.*SessionStore/i, 'SPEC must distinguish subagent child SessionStore');
  assert.match(spec, /\[REFERENCE_REVIEW\.md\]\(docs\/REFERENCE_REVIEW\.md\)/, 'SPEC must use relative path docs/REFERENCE_REVIEW.md');
});

test('AGENTS.md documents Vietnamese language exception, additional docs, and maintains character budget under 23000', async () => {
  const agents = await readFile('AGENTS.md', 'utf8');
  assert.match(agents, /README\.md.*CHANGELOG\.md.*Vietnamese|Vietnamese.*README\.md/i, 'AGENTS.md must permit Vietnamese for README.md and CHANGELOG.md');
  assert.match(agents, /docs\/MCP\.md/, 'AGENTS.md must list docs/MCP.md');
  assert.match(agents, /docs\/AUDIT\.md/, 'AGENTS.md must list docs/AUDIT.md');
  assert.match(agents, /docs\/ROADMAP\.md/, 'AGENTS.md must list docs/ROADMAP.md');
  assert.match(agents, /sessionLifecycle\s*:\s*false|child `SessionStore`/i, 'AGENTS.md must clarify subagent store vs sessionLifecycle false');
});

test('README.md documents that --trust-workspace activates both permissions.allow and hooks', async () => {
  const readme = await readFile('README.md', 'utf8');
  assert.match(readme, /--trust-workspace/, 'README must document --trust-workspace');
  assert.match(readme, /permissions\.allow.*hooks|hooks.*permissions\.allow/s, 'README must clarify trust covers both hooks and permissions.allow');
  assert.match(readme, /SHA-256.*script|script.*SHA-256/i, 'README must mention SHA-256 hash coverage over scripts');
});

test('CHANGELOG.md records 0.4.0 release notes for settings, permissions, hooks, and workspace trust', async () => {
  const changelog = await readFile('CHANGELOG.md', 'utf8');
  const section040 = changelog.slice(changelog.indexOf('## 0.4.0'), changelog.indexOf('## 0.3.1'));
  assert.match(section040, /\.vyen\/settings\.json|permissions\.(?:allow|ask|deny)/, 'CHANGELOG 0.4.0 must note layered settings/permissions');
  assert.match(section040, /PreToolUse|PostToolUse|HookBus|vòng đời/i, 'CHANGELOG 0.4.0 must note lifecycle hooks');
  assert.match(section040, /--trust-workspace/, 'CHANGELOG 0.4.0 must note --trust-workspace');
});

test('ROADMAP.md reflects completed Phase 1, 30 modules, and 5 Windows platform skips with zero test failures', async () => {
  const roadmap = await readFile('docs/ROADMAP.md', 'utf8');
  assert.match(roadmap, /30 modules/, 'ROADMAP.md must reflect 30 modules in src/');
  assert.match(roadmap, /Phase 1.*(?:completed|done)|R1\.1.*completed/i, 'ROADMAP.md must mark Phase 1 as completed');
  assert.match(roadmap, /0 failures|cleanly skipped|cleanly skips/i, 'ROADMAP.md must record 0 failures with platform skips on Windows');
});

test('docs contract covers project MCP trust and scope', async () => {
  const [mcp, spec, readme, help, roadmap] = await Promise.all([
    readFile('docs/MCP.md', 'utf8'),
    readFile('docs/SPEC.md', 'utf8'),
    readFile('README.md', 'utf8'),
    readFile('src/help.ts', 'utf8'),
    readFile('docs/ROADMAP.md', 'utf8'),
  ]);

  assert.match(mcp, /\.vyen\/mcp\.json/, 'docs/MCP.md must document .vyen/mcp.json');
  assert.match(mcp, /--trust-workspace/, 'docs/MCP.md must document --trust-workspace');
  assert.match(mcp, /--scope=project|--scope/, 'docs/MCP.md must document --scope=project');
  assert.match(spec, /project MCP.*(?:trust|workspace)|workspace trust.*project MCP/i, 'docs/SPEC.md must mention project MCP trust');
  assert.match(readme, /\.vyen\/mcp\.json/, 'README.md must mention .vyen/mcp.json');
  assert.match(help, /--scope/, 'src/help.ts must document --scope');
  assert.match(roadmap, /R1\.3.*(?:completed|done)/i, 'docs/ROADMAP.md must mark R1.3 completed');
});

