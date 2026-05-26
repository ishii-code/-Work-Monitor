import { execSync } from 'child_process';

const PLIST = `${process.env.HOME}/Library/LaunchAgents/com.peco.pc-work-monitor.plist`;

try {
  execSync(`launchctl unload "${PLIST}" 2>/dev/null`, { stdio: 'inherit' });
  console.log('✅ pc-work-monitor を停止しました。');
  console.log('   再開するには: npm run start-daemon');
} catch {
  console.log('デーモンは既に停止しています。');
}
