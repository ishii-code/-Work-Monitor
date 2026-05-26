import { execSync } from 'child_process';

const PLIST = `${process.env.HOME}/Library/LaunchAgents/com.peco.pc-work-monitor.plist`;

try {
  execSync(`launchctl load "${PLIST}"`, { stdio: 'inherit' });
  console.log('✅ pc-work-monitor を開始しました。');
} catch (e) {
  console.error('起動に失敗しました:', e);
}
