import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

// Synthetic values only; all four variables override any developer .env loaded by the commands.
const accounts = {
    WINDY_FREE_USER: 'audit-free@example.invalid',
    WINDY_FREE_PASSWORD: 'Synthetic-Free-Pass.[7319]',
    WINDY_PREMIUM_USER: 'audit-premium@example.invalid',
    WINDY_PREMIUM_PASSWORD: 'Synthetic-Premium-Pass+921',
};

function run(t, script: string, files: Record<string, string> = {}, overrides: Record<string, string> = {}) {
    const cwd = mkdtempSync(join(tmpdir(), 'alpine-security-'));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    for (const [name, contents] of Object.entries(files)) {
        const path = join(cwd, name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, contents);
    }
    const result = spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url))], {
        cwd,
        env: { ...process.env, ...accounts, ...overrides },
        encoding: 'utf8',
    });
    assert.ifError(result.error);
    const output = result.stdout + result.stderr;
    for (const value of Object.values(accounts)) {
        assert.ok(!output.includes(value), 'command must not print a credential');
    }
    return { status: result.status, output };
}

// One real ZIP member, stored or deflated, as embedded by Playwright's HTML report.
function report(text: string, method = 8): string {
    const name = Buffer.from('report.json');
    const raw = Buffer.from(text);
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length + name.length, 12);
    end.writeUInt32LE(local.length + name.length + data.length, 16);
    const zip = Buffer.concat([local, name, data, central, name, end]);
    return `<script>const tokenStyle = 1; const data = 'data:application/zip;base64,${zip.toString('base64')}';</script>`;
}

for (const password of [accounts.WINDY_FREE_PASSWORD, accounts.WINDY_PREMIUM_PASSWORD]) {
    test('a password-only artifact blocks upload without printing the password', t => {
        const result = run(t, './scan-report.ts', { 'test-results/failure.txt': password });
        assert.equal(result.status, 1);
        assert.match(result.output, /password: 1 matching entries/);
    });
}

test('credential-bearing file names are detected but never printed', t => {
    const result = run(t, './scan-report.ts', { [`test-results/${accounts.WINDY_FREE_PASSWORD}.txt`]: 'clean' });
    assert.equal(result.status, 1);
    assert.match(result.output, /password: 1 matching entries/);
});

test('credentials outside the embedded ZIP are detected too', t => {
    const result = run(t, './scan-report.ts', {
        'playwright-report/index.html': `${report('clean')}<p>${accounts.WINDY_FREE_PASSWORD}</p>`,
    });
    assert.equal(result.status, 1);
    assert.match(result.output, /password: 1 matching entries/);
});

for (const method of [0, 8]) {
    test(`password in an embedded ZIP blocks upload (method ${method})`, t => {
        const result = run(t, './scan-report.ts', {
            'playwright-report/index.html': report(accounts.WINDY_PREMIUM_PASSWORD, method),
        });
        assert.equal(result.status, 1);
        assert.match(result.output, /password: 1 matching entries/);
    });
    test(`clean report and attachments pass (method ${method})`, t => {
        const result = run(t, './scan-report.ts', {
            'playwright-report/index.html': report('{"status":"failed"}', method),
            'playwright-report/data/error.txt': 'Expected visible panel',
            'test-results/failure.txt': 'No login data',
        });
        assert.equal(result.status, 0);
    });
}

for (const html of ['<html>unknown format</html>', 'data:application/zip;base64,AAAA', report('clean', 99)]) {
    test('unrecognised, corrupt or unsupported report data blocks upload', t => {
        const result = run(t, './scan-report.ts', { 'playwright-report/index.html': html });
        assert.equal(result.status, 1);
        assert.match(result.output, /Artifact scan failed/);
    });
}

test('no artifacts cannot be reported as a successful scan', t => {
    assert.equal(run(t, './scan-report.ts').status, 1);
});

test('usernames, domains and token markers still block upload', t => {
    for (const text of [accounts.WINDY_FREE_USER, 'example.invalid', 'session token']) {
        assert.equal(run(t, './scan-report.ts', { 'test-results/failure.txt': text }).status, 1);
    }
});

test('CI preflight succeeds with both accounts configured', t => {
    assert.equal(run(t, './check-credentials.ts').status, 0);
});

for (const name of Object.keys(accounts)) {
    test(`CI preflight fails if ${name} is absent`, t => {
        const result = run(t, './check-credentials.ts', {}, { [name]: '' });
        assert.equal(result.status, 1);
        assert.match(result.output, new RegExp(name));
    });
}
