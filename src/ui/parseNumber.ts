// A typed whole number: "1,800", "1 800", "1.800" and "1800 m" are 1800; "+200", "-200" and "−200" keep their sign.
// A leading sign is kept, everything that isn't a digit is dropped (separators, units). null without any digit.
// Pure, unit-tested (parseNumber.test.ts).
export function parseNumber(text: string): number | null {
    const trimmed = text.trim();
    const digits = trimmed.replace(/\D/g, '');
    if (digits === '') {
        return null;
    }
    const negative = trimmed.startsWith('-') || trimmed.startsWith('−'); // a hyphen or a proper minus sign
    return (negative ? -1 : 1) * parseInt(digits, 10);
}
