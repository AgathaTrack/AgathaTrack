import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  extractMarkdownLinks,
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

function writeFixtureTree(root) {
  const libDir = path.join(root, 'scripts/lib');
  fs.mkdirSync(libDir, { recursive: true });
  fs.copyFileSync(
    path.join(REPO_ROOT, 'scripts/lib/validate_markdown_links.mjs'),
    path.join(libDir, 'validate_markdown_links.mjs'),
  );
  fs.chmodSync(path.join(root, 'scripts/validate_docs.sh'), 0o755);
  fs.copyFileSync(path.join(REPO_ROOT, 'scripts/validate_docs.sh'), path.join(root, 'scripts/validate_docs.sh'));
  copyCheckDocPlacement(root);
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
  const mode = fs.statSync(scriptPath).mode & 0o111;
  assert.ok(mode, 'auto_fix_docs.sh must be executable');
  const head = fs.readFileSync(scriptPath, 'utf8').split('\n').slice(0, 5).join('\n');
  assert.match(head, /^#!\/bin\/bash/);
  assert.match(fs.readFileSync(scriptPath, 'utf8'), /--pr/);
});