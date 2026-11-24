import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  extractMarkdownLinks,
  findMarkdownFiles,
  headingAnchorSlug,
  stripInlineCode,
  validateLink,
  validateRepoMarkdownLinks,
} from './lib/validate_markdown_links.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function copyCheckDocPlacement(root) {
  const scriptsDir = path.join(root, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.copyFileSync(
    path.join(REPO_ROOT, 'scripts/check_doc_placement.js'),
    path.join(scriptsDir, 'check_doc_placement.js'),
  );
  fs.mkdirSync(path.join(root, 'server/node_modules'), { recursive: true });
  fs.cpSync(
    path.join(REPO_ROOT, 'server/node_modules/js-yaml'),
    path.join(root, 'server/node_modules/js-yaml'),
    { recursive: true },
  );
}

test('check_doc_placement fails on deliberate misplaced root doc (docs validation gate)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-fixture-'));
  copyCheckDocPlacement(root);
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'stray.md'), '# stray\n');

  const res = spawnSync(process.execPath, [path.join(root, 'scripts/check_doc_placement.js')], {
    encoding: 'utf8',
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr + res.stdout, /Misplaced root doc/);
});

test('check_doc_placement passes on allowed root docs layout', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-fixture-'));
  copyCheckDocPlacement(root);
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'README.md'), '# ok\n');

  const res = spawnSync(process.execPath, [path.join(root, 'scripts/check_doc_placement.js')], {
    encoding: 'utf8',
  });
  assert.equal(res.status, 0);
});

test('link checker: labels, relatives, repo root, fence, and spaces in filenames', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-links-'));
  fs.mkdirSync(path.join(root, 'docs', 'guides'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'docs', 'guides', 'my guide.md'),
    '# My Guide\n\nSee [API](/docs/api.md).\n',
  );
  fs.writeFileSync(path.join(root, 'docs', 'api.md'), '# API\n');
  const page = path.join(root, 'docs', 'index.md');
  const body = [
    '# Index',
    '',
    '[one](./sibling.md)',
    '[Multi Word Label](./guides/my guide.md)',
    '[sibling](./sibling.md)',
    '[root](/docs/api.md)',
    '',
    '```markdown',
    '[fenced example](./guides/my guide.md)',
    '```',
    '',
  ].join('\n');
  fs.writeFileSync(page, body);
  fs.writeFileSync(path.join(root, 'docs', 'sibling.md'), '# sibling\n');

  const lineLinks = extractMarkdownLinks(stripInlineCode('[API](./target.md) and [Multi Word Label](./guides/my guide.md)'));
  assert.equal(lineLinks.length, 2);

  assert.equal(validateLink(root, page, './guides/my guide.md'), null);
  assert.equal(validateLink(root, page, '/docs/api.md'), null);
  assert.match(validateLink(root, page, './missing.md'), /missing target/);

  const issues = validateRepoMarkdownLinks(root);
  assert.deepEqual(issues, []);
});

test('universal_babysit.sh documents --pr and --dry-run in usage', () => {
  const script = fs.readFileSync(path.join(REPO_ROOT, 'scripts/universal_babysit.sh'), 'utf8');
  assert.match(script, /--pr/);
  assert.match(script, /--dry-run/);
  assert.match(script, /push_iteration_changes/);
});

test('auto_fix_docs.sh is executable bash with documented --pr invocation', () => {
  const scriptPath = path.join(REPO_ROOT, 'scripts/auto_fix_docs.sh');
  const text = fs.readFileSync(scriptPath, 'utf8');
  const mode = fs.statSync(scriptPath).mode & 0o111;
  assert.ok(mode, 'auto_fix_docs.sh must be executable');
  assert.match(text.split('\n').slice(0, 5).join('\n'), /^#!\/bin\/bash/);
  assert.match(text, /--pr/);
});

test('heading anchor slug never leaves angle brackets (CodeQL incomplete sanitization)', () => {
  assert.equal(headingAnchorSlug('## My Heading'), 'my-heading');
  assert.doesNotMatch(headingAnchorSlug('## <scr<script>ipt>x'), /[<>]/);
});

test('heading anchors: valid fragment passes, missing fragment fails', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-anchors-'));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'target.md'), '# Target\n\n## My Heading\n');
  const page = path.join(root, 'docs', 'index.md');
  fs.writeFileSync(page, '# Index\n');
  assert.equal(validateLink(root, page, './target.md#my-heading'), null);
  assert.match(validateLink(root, page, './target.md#missing-heading'), /missing heading anchor/);
});

test('relative ./ and ../ targets resolve only from their source file (no fallback match)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-relative-'));
  fs.mkdirSync(path.join(root, 'docs', 'guides'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), '# root readme\n');
  const page = path.join(root, 'docs', 'guides', 'page.md');
  fs.writeFileSync(page, '# Page\n');
  // A repo-root README exists, but ../README.md from docs/guides/ is a dead link.
  assert.match(validateLink(root, page, '../README.md'), /missing target/);
});

test('findMarkdownFiles scans .agents/ and documents regulatory/ as an intentional exclusion', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-scope-'));
  for (const rel of ['.agents/plans/a.md', 'regulatory/legal/en/b.md', 'docs/c.md']) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), '# x\n');
  }
  const files = findMarkdownFiles(root).map((p) => path.relative(root, p)).sort();
  assert.deepEqual(files, ['.agents/plans/a.md', 'docs/c.md']);
});
