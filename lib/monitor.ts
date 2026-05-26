import { exec } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';

const execAsync = promisify(exec);
const require = createRequire(import.meta.url);

// active-win はCJSモジュールのためrequireで読み込む
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const activeWin = require('active-win') as (opts?: unknown) => Promise<{
  title: string;
  owner: { name: string; bundleId: string; processId: number; path: string };
  url?: string;
  memoryUsage: number;
} | undefined>;

export interface WindowInfo {
  appName: string;
  windowTitle: string;
  url: string;
  isIdle: boolean;
}

async function getIdleSeconds(): Promise<number> {
  try {
    const { stdout } = await execAsync(
      "ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print $NF/1000000000; exit}'"
    );
    return parseFloat(stdout.trim()) || 0;
  } catch {
    return 0;
  }
}

async function getBrowserUrl(appName: string): Promise<string> {
  const scriptMap: Record<string, string> = {
    'Google Chrome': `tell application "Google Chrome" to get URL of active tab of front window`,
    Chrome: `tell application "Google Chrome" to get URL of active tab of front window`,
    Safari: `tell application "Safari" to get URL of current tab of window 1`,
    Arc: `tell application "Arc" to get URL of active tab of front window`,
    Firefox: `tell application "Firefox" to get URL of active tab of front window`,
    Brave: `tell application "Brave Browser" to get URL of active tab of front window`,
  };

  const script = scriptMap[appName];
  if (!script) return '';

  try {
    const { stdout } = await execAsync(`osascript -e '${script}'`);
    return stdout.trim();
  } catch {
    return '';
  }
}

export async function getActiveWindow(): Promise<WindowInfo> {
  const idleSeconds = await getIdleSeconds();
  const IDLE_THRESHOLD = 300;

  if (idleSeconds >= IDLE_THRESHOLD) {
    return { appName: 'idle', windowTitle: '', url: '', isIdle: true };
  }

  try {
    const win = await activeWin();

    if (!win) {
      return { appName: 'unknown', windowTitle: '', url: '', isIdle: false };
    }

    const appName = win.owner?.name ?? 'unknown';
    const windowTitle = win.title ?? '';

    const browserApps = ['Google Chrome', 'Chrome', 'Safari', 'Arc', 'Firefox', 'Brave', 'Brave Browser'];
    const url = browserApps.includes(appName) ? await getBrowserUrl(appName) : '';

    return { appName, windowTitle, url, isIdle: false };
  } catch (e: unknown) {
    const err = e as { stdout?: string; message?: string };
    const stdout = err.stdout ?? '';
    const msg = err.message ?? String(e);
    if (stdout.includes('accessibility') || msg.includes('accessibility') || msg.includes('Command failed')) {
      return { appName: 'no-permission', windowTitle: '', url: '', isIdle: false };
    }
    return { appName: 'unknown', windowTitle: '', url: '', isIdle: false };
  }
}

export async function checkAccessibilityPermission(): Promise<boolean> {
  try {
    const win = await activeWin();
    return win !== undefined || true;
  } catch (e: unknown) {
    const err = e as { stdout?: string; message?: string };
    const stdout = err.stdout ?? '';
    const msg = err.message ?? String(e);
    if (stdout.includes('accessibility') || msg.includes('accessibility')) {
      return false;
    }
    return true;
  }
}
