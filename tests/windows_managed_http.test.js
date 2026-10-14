import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseManagedCdpPort } from '../scripts/windows/http-managed.js';

test('managed HTTP task entrypoint accepts only pinned, qualified CDP port', () => {
  assert.equal(parseManagedCdpPort(['--cdp-port=9222']), 9222);
  assert.equal(parseManagedCdpPort(['--cdp-port=9333']), 9333);
  for (const args of [[], ['9222'], ['--cdp-port=0'], ['--cdp-port=8765'],
    ['--cdp-port=9222', '--cdp-port=9333'], ['--cdp-port=9222;foo']]) {
    assert.throws(() => parseManagedCdpPort(args));
  }
});

test('managed task migration uses an exact existing task and verifies stop/start ownership', () => {
  const script = readFileSync(fileURLToPath(new URL(
    '../scripts/windows/install-managed-http-task.ps1', import.meta.url)), 'utf8');
  assert.match(script, /TradingViewMcpHttpServer/);
  assert.match(script, /New-ScheduledTaskAction/);
  assert.match(script, /pythonw[.]exe/i);
  assert.match(script, /run-http-hidden[.]py/i);
  assert.match(script, /_job_process[.]py/i);
  assert.match(script, /Set-ScheduledTask/);
  assert.match(script, /Stop-ScheduledTask/);
  assert.match(script, /Start-ScheduledTask/);
  assert.match(script, /ProcessId.*ExcludePid/);
  assert.match(script, /127\.0\.0\.1/);
  assert.doesNotMatch(script, /Stop-Process\s+-Name/);
  assert.doesNotMatch(script, /Stop-Process\s+.*TradingView/i);
  assert.match(script, /Wait-HttpState/);
  assert.match(script, /Task XML backup/);
});

test('hidden launcher owns the Node lifetime through a Windows Job Object', () => {
  const launcher = readFileSync(fileURLToPath(new URL(
    '../scripts/windows/run-http-hidden.py', import.meta.url)), 'utf8');
  const helper = readFileSync(fileURLToPath(new URL(
    '../scripts/windows/_job_process.py', import.meta.url)), 'utf8');
  assert.match(launcher, /run_job_child/);
  assert.match(launcher, /"http[.]js"/);
  assert.match(helper, /CREATE_NO_WINDOW/);
  assert.match(helper, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/);
  assert.match(helper, /AssignProcessToJobObject/);
  assert.match(helper, /proc[.]wait/);
});
