// The Node APIs the end-to-end tests use. Declared here instead of adding @types/node: @playwright/test is the only
// dev dependency of the e2e suite.

declare const process: {
    env: Record<string, string | undefined>;
    exitCode: number | undefined;
    loadEnvFile(path?: string): void;
};

declare module 'node:fs' {
    export function existsSync(path: string): boolean;
    export function readdirSync(path: string): string[];
    export function readFileSync(path: string): Uint8Array;
    export function statSync(path: string): { mtimeMs: number; isDirectory(): boolean };
}

declare module 'node:url' {
    export function fileURLToPath(url: string | URL): string;
}

declare module 'node:zlib' {
    export function inflateRawSync(data: Uint8Array): Uint8Array;
}
