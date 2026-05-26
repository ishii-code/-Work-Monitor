import { execSync } from 'child_process';
import { existsSync, unlinkSync } from 'fs';
import { createInterface } from 'readline';

const PLIST = `${process.env.HOME}/Library/LaunchAgents/com.peco.pc-work-monitor.plist`;

const rl = createInterface({ input: process.stdin, output: process.stdout });

rl.question('⚠️  pc-work-monitor をアンインストールします。記録データも削除しますか？ (yes/no): ', (answer) => {
  rl.close();

  // デーモン停止
  try {
    execSync(`launchctl unload "${PLIST}" 2>/dev/null`);
    console.log('✅ デーモンを停止しました。');
  } catch {}

  // LaunchAgent plist 削除
  if (existsSync(PLIST)) {
    unlinkSync(PLIST);
    console.log('✅ LaunchAgent を削除しました。');
  }

  if (answer.trim().toLowerCase() === 'yes') {
    execSync(`rm -f "${process.cwd()}/data/work-monitor.db"`, { stdio: 'inherit' });
    execSync(`rm -f "${process.cwd()}/data/daemon.log"`, { stdio: 'inherit' });
    execSync(`rm -f "${process.cwd()}/data/daemon-error.log"`, { stdio: 'inherit' });
    console.log('✅ データを削除しました。');
  }

  console.log('\nアンインストール完了。フォルダ自体は残っています。');
  console.log('再インストール: launchctl load ~/Library/LaunchAgents/com.peco.pc-work-monitor.plist');
});
