const PRIVATE_APPS = new Set([
  '1Password', '1Password 7', '1Password 8',
  'Bitwarden', 'Keychain Access', 'LastPass',
  'Dashlane', 'Keeper', 'NordPass',
]);

const PRIVATE_URL_PATTERNS = [
  /smbc|mufg|mizuho|rakuten-bank|shinsei|jibun-bank/i,
  /paypal|stripe|square|gmo-pg|paygent/i,
  /moneyforward|freee|yayoi|bugyo/i,
  /visa|mastercard|jcb\.co\.jp|amex|diners/i,
  /credit|card|payment|checkout|billing/i,
  /mynumber|e-gov|medical|hospital/i,
  /nta\.go\.jp|etax|eltax/i,
  /reset.*password|password.*reset|verify.*email/i,
];

const SANITIZE_PATTERNS: RegExp[] = [
  /\b\d{4}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b/g,
  /\b\d{3}[\s\-]?\d{4}[\s\-]?\d{4}\b/g,
  /password[:=\s]+\S+/gi,
  /token[:=\s]+\S+/gi,
  /api[_\-]?key[:=\s]+\S+/gi,
  /Bearer\s+\S+/gi,
];

export interface FilteredWindow {
  appName: string;
  windowTitle: string;
  url: string;
  isPrivate: boolean;
}

export function applyPrivacyFilter(
  appName: string,
  windowTitle: string,
  url: string,
): FilteredWindow {
  if (PRIVATE_APPS.has(appName)) {
    return { appName, windowTitle: '[非表示]', url: '[非表示]', isPrivate: true };
  }
  if (url && PRIVATE_URL_PATTERNS.some(p => p.test(url))) {
    return { appName, windowTitle: '[非表示]', url: '[非表示]', isPrivate: true };
  }
  let sanitized = windowTitle;
  for (const pattern of SANITIZE_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[***]');
  }
  return { appName, windowTitle: sanitized, url, isPrivate: false };
}
