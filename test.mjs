// Negative tests that need no browser: flag parsing and the folder boundary.
// Run with: node --test test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseArgs, startStaticServer, listPublishedPages } from './check-mobile.mjs';

const CLI = fileURLToPath(new URL('./check-mobile.mjs', import.meta.url));

/** A published folder with one real page, plus a secret file next to it. */
function sandbox() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mobile-gate-')));
  const root = join(dir, 'site');
  const outside = join(dir, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>ok</title>');
  writeFileSync(join(outside, 'secret.html'), '<!doctype html><title>secret</title>SECRET');
  return { dir, root, outside, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Windows without developer mode cannot create file symlinks: skip, never pass silently. */
function trySymlink(t, target, path, type) {
  try {
    symlinkSync(target, path, type);
    return true;
  } catch (error) {
    if (error.code === 'EPERM') {
      t.skip(`this machine cannot create a ${type} symlink (EPERM)`);
      return false;
    }
    throw error;
  }
}

test('an empty --fonts-css is a collection failure, not a disabled check', () => {
  assert.throws(() => parseArgs(['--fonts-css=']), (error) => error.isCollectionFailure === true);
  const run = spawnSync(process.execPath, [CLI, 'fixtures/good', '--fonts-css='], {
    cwd: fileURLToPath(new URL('.', import.meta.url)),
  });
  assert.equal(run.status, 2);
});

test('an empty --font-canon and an unknown flag are collection failures', () => {
  assert.throws(() => parseArgs(['--font-canon=']), (error) => error.isCollectionFailure === true);
  assert.throws(() => parseArgs(['--bogus']), (error) => error.isCollectionFailure === true);
});

test('the server serves a real page and refuses a file symlink that leaves the root', async (t) => {
  const box = sandbox();
  t.after(box.cleanup);
  if (!trySymlink(t, join(box.outside, 'secret.html'), join(box.root, 'leak.html'), 'file')) return;
  const server = await startStaticServer(box.root);
  t.after(server.close);
  assert.equal((await fetch(`${server.origin}/index.html`)).status, 200);
  const leak = await fetch(`${server.origin}/leak.html`);
  assert.equal(leak.status, 403);
  assert.ok(!(await leak.text()).includes('SECRET'));
});

test('the server refuses a directory symlink that leaves the root', async (t) => {
  const box = sandbox();
  t.after(box.cleanup);
  // 'junction' needs no privilege on Windows and is ignored elsewhere.
  if (!trySymlink(t, box.outside, join(box.root, 'linked'), 'junction')) return;
  const server = await startStaticServer(box.root);
  t.after(server.close);
  const leak = await fetch(`${server.origin}/linked/secret.html`);
  assert.equal(leak.status, 403);
  assert.ok(!(await leak.text()).includes('SECRET'));
});

test('listing refuses a file symlink that leaves the root', (t) => {
  const box = sandbox();
  t.after(box.cleanup);
  if (!trySymlink(t, join(box.outside, 'secret.html'), join(box.root, 'leak.html'), 'file')) return;
  assert.throws(() => listPublishedPages(box.root), (error) => error.isCollectionFailure === true);
});

test('listing refuses a directory symlink that leaves the root', (t) => {
  const box = sandbox();
  t.after(box.cleanup);
  if (!trySymlink(t, box.outside, join(box.root, 'linked'), 'junction')) return;
  assert.throws(() => listPublishedPages(box.root), (error) => error.isCollectionFailure === true);
});

test('listing a folder without symlinks still finds its pages', (t) => {
  const box = sandbox();
  t.after(box.cleanup);
  assert.deepEqual(listPublishedPages(box.root), ['index.html']);
});
