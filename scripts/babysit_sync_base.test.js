#!/usr/bin/env node
/**
 * Regression tests for scripts/babysit_sync_base.sh --pr.
 *
 * The script must act on the PR head branch, not on whatever branch is checked out.
 * Uses throwaway git repos and a fake `gh` on PATH (answers `gh pr view`).
 */
const assert = require('node:assert/strict');
const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const SCRIPT = path.resolve(__dirname, 'babysit_sync_base.sh');
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

function commitFile(cwd, name, text) {
  fs.writeFileSync(path.join(cwd, name), text);
  git(cwd, 'add', name);
  git(cwd, 'commit', '-q', '-m', `add ${name}`);
}

/**
 * origin.git with main and feature. feature is then left one commit behind main.
 * The work clone is left on a local `other` branch that is also behind main.
 */
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'babysit-sync-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);

  git(root, 'init', '-q', '-b', 'main', work);
  git(work, 'remote', 'add', 'origin', origin);
  commitFile(work, 'base.txt', 'base\n');
  git(work, 'push', '-q', 'origin', 'main');

  git(work, 'checkout', '-q', '-b', 'feature');
  commitFile(work, 'feature.txt', 'feature\n');
  git(work, 'push', '-q', 'origin', 'feature');

  git(work, 'checkout', '-q', 'main');
  commitFile(work, 'main-2.txt', 'main advances\n');
  git(work, 'push', '-q', 'origin', 'main');

  git(work, 'checkout', '-q', '-b', 'other', 'main~1');
  fs.writeFileSync(
    path.join(bin, 'gh'),
    '#!/bin/sh\nprintf "main\\tfeature\\n"\n',
    { mode: 0o755 },
  );
  return { root, origin, work, bin };
}

function runSync(fixture, args) {
  return spawnSync('bash', [SCRIPT, ...args], {
    cwd: fixture.work,
    env: { ...GIT_ENV, PATH: `${fixture.bin}:${process.env.PATH}` },
    encoding: 'utf8',
  });
}

test('--pr checks out the PR head, rebases it and pushes it; the checked-out branch is untouched', () => {
  const fx = makeFixture();
  const otherBefore = git(fx.work, 'rev-parse', 'other');

  const res = runSync(fx, ['--pr', '1', '--push']);

  assert.equal(res.status, 0, res.stderr);
  assert.equal(git(fx.work, 'branch', '--show-current'), 'feature');
  git(fx.work, 'fetch', '-q', 'origin');
  assert.equal(
    spawnSync('git', ['merge-base', '--is-ancestor', 'origin/main', 'origin/feature'], { cwd: fx.work, env: GIT_ENV }).status,
    0,
    'origin/feature should now contain origin/main',
  );
  assert.equal(git(fx.work, 'rev-parse', 'other'), otherBefore, 'other branch must not be rebased or moved');
});

test('--pr refuses to switch when the working tree is dirty', () => {
  const fx = makeFixture();
  fs.writeFileSync(path.join(fx.work, 'scratch.txt'), 'uncommitted\n');

  const res = runSync(fx, ['--pr', '1', '--push']);

  assert.equal(res.status, 2, res.stderr);
  assert.match(res.stderr, /working tree not clean/);
  assert.equal(git(fx.work, 'branch', '--show-current'), 'other');
});

test('--pr refuses to push a local PR branch that has commits origin does not have', () => {
  const fx = makeFixture();
  git(fx.work, 'checkout', '-q', 'feature');
  commitFile(fx.work, 'local-only.txt', 'not pushed\n');
  git(fx.work, 'checkout', '-q', 'other');
  const featureBefore = git(fx.origin, 'rev-parse', 'feature');

  const res = runSync(fx, ['--pr', '1', '--push']);

  assert.equal(res.status, 2, res.stderr);
  assert.match(res.stderr, /has commits that origin\/feature does not/);
  assert.equal(git(fx.origin, 'rev-parse', 'feature'), featureBefore, 'origin/feature must not change');
});
