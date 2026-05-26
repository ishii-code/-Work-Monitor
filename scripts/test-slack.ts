import { loadEnv } from '../lib/load-env.js';
import { sendToSlack } from '../lib/notifier.js';

loadEnv();
await sendToSlack(':white_check_mark: *pc-work-monitor セットアップ完了！* 監視を開始します。');
console.log('Slack送信 OK!');
