// Scans the run's artifacts for anything secret: the HTML report's data (a zip embedded in index.html), its
// attachments (playwright-report/data) and test-results/. Counts "token", each test account's user name, password
// and domain part; prints counts only (file names can contain secrets too). Fails if anything matches or cannot be read.
// Run after a test run: npm run test:e2e:scan-report

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

import { credentials } from './env.ts';

type Entry = { name: string; text: string; template?: boolean };

// The entries of a zip file (stored or deflated), from its central directory.
function unzip(zip: Uint8Array): Entry[] {
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    let end = zip.length - 22;
    while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) {
        end--;
    }
    if (end < 0) {
        throw new Error('Missing ZIP directory');
    }
    const count = view.getUint16(end + 10, true);
    let at = view.getUint32(end + 16, true);
    const out: Entry[] = [];
    for (let i = 0; i < count; i++) {
        if (view.getUint32(at, true) !== 0x02014b50) {
            throw new Error('Invalid ZIP directory');
        }
        const method = view.getUint16(at + 10, true);
        if (![0, 8].includes(method) || (view.getUint16(at + 8, true) & 1)) {
            throw new Error('Unsupported ZIP entry');
        }
        const size = view.getUint32(at + 20, true);
        const nameLength = view.getUint16(at + 28, true);
        const skip = nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
        const local = view.getUint32(at + 42, true);
        if (view.getUint32(local, true) !== 0x04034b50) {
            throw new Error('Invalid ZIP entry');
        }
        const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLength));
        const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
        if (start + size > zip.length) {
            throw new Error('Truncated ZIP entry');
        }
        const data = zip.subarray(start, start + size);
        const decoded = method === 8 ? inflateRawSync(data) : data;
        if (decoded.length !== view.getUint32(at + 24, true)) {
            throw new Error('Invalid ZIP entry size');
        }
        out.push({ name, text: new TextDecoder().decode(decoded) });
        at += 46 + skip;
    }
    return out;
}

function files(dir: string): Entry[] {
    if (!existsSync(dir)) {
        return [];
    }
    return readdirSync(dir).flatMap(name => {
        const path = `${dir}/${name}`;
        return statSync(path).isDirectory() ? files(path) : [{ name: path, text: new TextDecoder().decode(readFileSync(path)) }];
    });
}

function reportEntries(): Entry[] {
    const entries: Entry[] = [...files('playwright-report/data'), ...files('test-results')];
    if (existsSync('playwright-report/index.html')) {
        const html = new TextDecoder().decode(readFileSync('playwright-report/index.html'));
        const data = html.match(/data:application\/zip;base64,([A-Za-z0-9+/=]+)/)?.[1];
        if (!data) {
            throw new Error('Unrecognised HTML report format');
        }
        const zip = Uint8Array.from(atob(data), c => c.charCodeAt(0));
        const embedded = unzip(zip);
        if (!embedded.length) {
            throw new Error('Empty report ZIP');
        }
        entries.push(...embedded, { name: 'index.html', text: html, template: true });
    }
    if (!entries.length) {
        throw new Error('No artifacts to scan');
    }
    return entries;
}

// The HTML viewer's own JavaScript contains the word "token". Search its text for credential literals only.
const needles: { label: string; pattern: RegExp; dataOnly?: boolean }[] = [
    { label: '"token"', pattern: /token/gi, dataOnly: true },
];
const literal = (text: string): RegExp => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
for (const account of ['free', 'premium'] as const) {
    const login = credentials(account);
    if (!login) {
        console.log(`the ${account} account: not set, not searched`);
        continue;
    }
    const { user, password } = login;
    needles.push({ label: `the ${account} account's user name`, pattern: literal(user) });
    needles.push({ label: `the ${account} account's password`, pattern: literal(password) });
    const domain = user.split('@')[1];
    if (domain) {
        needles.push({ label: `the ${account} account's domain`, pattern: literal(domain) });
    } else {
        console.log(`the ${account} account's user name has no domain part`);
    }
}

try {
    const entries = reportEntries();
    let found = 0;
    console.log(`Scanned ${entries.length} entries of the report and test-results.`);
    for (const { label, pattern, dataOnly } of needles) {
        const hits = entries.filter(e => !(dataOnly && e.template) && `${e.name}\n${e.text}`.match(pattern)).length;
        found += hits;
        console.log(`${label}: ${hits ? `${hits} matching entries` : 'not found'}`);
    }
    process.exitCode = found ? 1 : 0;
} catch {
    // Parsing and filesystem errors can include artifact text or paths containing credentials.
    console.error('Artifact scan failed: no artifacts found, or an artifact could not be fully read. Do not upload.');
    process.exitCode = 1;
}
