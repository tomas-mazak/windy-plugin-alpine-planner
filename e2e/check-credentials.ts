// Release/nightly preflight: local Playwright runs may skip accounts, but CI must exercise both.
import { missingCredentialVariables } from './env.ts';

const missing = missingCredentialVariables();
if (missing.length) {
    console.error(`Missing required E2E credentials: ${missing.join(', ')}`);
    process.exitCode = 1;
} else {
    console.log('Both E2E accounts are configured.');
}
