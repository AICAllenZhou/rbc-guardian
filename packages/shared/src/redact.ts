/**
 * Transcript redaction. Applied before anything is stored or shown by default.
 * Deliberately conservative about money ("$2,840") and case IDs ("GUARD-4821").
 */
const RULES: { name: string; re: RegExp; replacement: string }[] = [
  { name: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, replacement: "[email]" },
  // 13–19 digits, optionally grouped by spaces or dashes: card-like numbers.
  { name: "card", re: /(?<![\w$])(?:\d[ -]?){12,18}\d(?![\w])/g, replacement: "[card number]" },
  // North American phone numbers.
  { name: "phone", re: /(?<![\w$])(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]\d{4}(?![\w])/g, replacement: "[phone]" },
  // Standalone 4–8 digit codes (OTP, PIN). Not after "$", "-", "," or "." and not followed by ",digit" or ".digit".
  // "card ending 4417" is a last-4 reference, not a secret, and stays readable.
  { name: "code", re: /(?<![\w$,.-])(?<!ending )(?<!last four )(?<!last 4 )\d{4,8}(?![\w]|[.,]\d)/gi, replacement: "[code]" },
  // Spoken codes: four or more digit words in a row ("four eight two one").
  {
    name: "spoken_code",
    re: /\b(?:(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)[ ,-]+){3,}(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/gi,
    replacement: "[code]",
  },
];

export function redact(text: string): string {
  let out = text;
  for (const r of RULES) out = out.replace(r.re, r.replacement);
  return out;
}

export function containsSensitive(text: string): boolean {
  return redact(text) !== text;
}
