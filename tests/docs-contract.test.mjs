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
  assert.equal(sourceFiles.length, 28);
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
