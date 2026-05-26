import { loadEnv } from '../lib/load-env.js';
loadEnv();

import express from 'express';
import { getDailySummary, getTodayActivities, getLastInsight, getDb, deleteDayActivities } from '../lib/db.js';
import { analyzeDay, formatInsightForSlack } from '../lib/analyzer.js';
import { saveInsight } from '../lib/db.js';
import { sendToSlack } from '../lib/notifier.js';
import { CATEGORY_LABELS, formatDuration } from '../lib/categorizer.js';
import { execSync } from 'child_process';

const app = express();
const PORT = 3011;

app.use(express.json());

// ── API ──────────────────────────────────────────────

app.get('/api/today', (_req, res) => {
  const date = new Date().toLocaleDateString('sv-SE');
  const summary = getDailySummary(date);
  const activities = getTodayActivities(date);
  res.json({ summary, activities: activities.slice(-50).reverse() });
});

app.get('/api/week', (_req, res) => {
  const days: object[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const date = d.toLocaleDateString('sv-SE');
    days.push(getDailySummary(date));
  }
  res.json(days);
});

app.get('/api/insight/:date', (req, res) => {
  const insight = getLastInsight(req.params.date);
  res.json(insight ?? { error: 'No insight for this date' });
});

app.post('/api/report', async (_req, res) => {
  try {
    const date = new Date().toLocaleDateString('sv-SE');
    const summary = getDailySummary(date);
    if (summary.total_tracked_seconds < 60) {
      res.json({ error: 'Not enough data' }); return;
    }
    const insight = await analyzeDay(summary);
    saveInsight(insight);
    const msg = formatInsightForSlack(insight, summary);
    await sendToSlack(msg);
    res.json({ ok: true, insight });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/status', (_req, res) => {
  try {
    const out = execSync('launchctl list | grep pc-work-monitor').toString().trim();
    const running = out.length > 0 && !out.startsWith('-');
    res.json({ running, detail: out });
  } catch {
    res.json({ running: false, detail: '' });
  }
});

app.post('/api/daemon/stop', (_req, res) => {
  try {
    execSync(`launchctl unload "${process.env.HOME}/Library/LaunchAgents/com.peco.pc-work-monitor.plist" 2>/dev/null`);
    res.json({ ok: true });
  } catch { res.json({ ok: true }); }
});

app.post('/api/daemon/start', (_req, res) => {
  try {
    execSync(`launchctl load "${process.env.HOME}/Library/LaunchAgents/com.peco.pc-work-monitor.plist"`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.delete('/api/reset/:date', (req, res) => {
  const count = deleteDayActivities(req.params.date);
  res.json({ ok: true, deleted: count });
});

app.get('/api/privacy-rules', (_req, res) => {
  res.json({
    blockedApps: ['1Password', '1Password 7', '1Password 8', 'Bitwarden', 'Keychain Access', 'LastPass', 'Dashlane', 'NordPass'],
    blockedUrlPatterns: ['smbc', 'mufg', 'mizuho', 'paypal', 'stripe', 'credit', 'card', 'payment', 'mynumber', 'nta.go.jp'],
    sanitizedPatterns: ['クレジットカード番号', '電話番号', 'password=...', 'token=...', 'api_key=...'],
  });
});

// ── HTML ─────────────────────────────────────────────

app.get('/', (_req, res) => {
  res.send(HTML);
});

app.listen(PORT, () => {
  console.log(`\n📊 管理ダッシュボード: http://localhost:${PORT}\n`);
});

// ── ダッシュボード HTML ───────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Work Monitor</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f1117;color:#e2e8f0;min-height:100vh}
  header{background:#1a1d2e;border-bottom:1px solid #2d3748;padding:16px 24px;display:flex;align-items:center;justify-content:space-between}
  header h1{font-size:18px;font-weight:700;color:#FCB900;letter-spacing:.5px}
  .badge{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:99px;font-size:12px;font-weight:600}
  .badge.on{background:#064e3b;color:#34d399}.badge.off{background:#450a0a;color:#f87171}
  .dot{width:8px;height:8px;border-radius:50%}.dot.on{background:#34d399;animation:pulse 1.5s infinite}.dot.off{background:#f87171}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
  nav{display:flex;gap:4px;padding:12px 24px;background:#1a1d2e;border-bottom:1px solid #2d3748}
  .tab{padding:6px 16px;border-radius:6px;cursor:pointer;font-size:13px;font-weight:500;color:#94a3b8;border:none;background:none;transition:.2s}
  .tab.active{background:#FCB900;color:#0f1117}
  .tab:hover:not(.active){background:#2d3748;color:#e2e8f0}
  main{padding:24px;max-width:1200px;margin:0 auto}
  .page{display:none}.page.active{display:block}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-bottom:24px}
  .card{background:#1a1d2e;border:1px solid #2d3748;border-radius:12px;padding:20px}
  .card h3{font-size:11px;text-transform:uppercase;letter-spacing:.8px;color:#64748b;margin-bottom:8px}
  .card .value{font-size:32px;font-weight:700;color:#f1f5f9}
  .card .sub{font-size:12px;color:#64748b;margin-top:4px}
  .chart-wrap{background:#1a1d2e;border:1px solid #2d3748;border-radius:12px;padding:20px;margin-bottom:24px}
  .chart-wrap h2{font-size:14px;font-weight:600;margin-bottom:16px;color:#94a3b8}
  .table{width:100%;border-collapse:collapse;font-size:13px}
  .table th{text-align:left;padding:8px 12px;color:#64748b;font-weight:500;border-bottom:1px solid #2d3748;font-size:11px;text-transform:uppercase}
  .table td{padding:8px 12px;border-bottom:1px solid #1e293b;color:#cbd5e1}
  .table tr:last-child td{border:none}
  .cat-badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:500;background:#1e293b}
  .score{font-size:48px;font-weight:800;text-align:center;margin:8px 0}
  .score.high{color:#34d399}.score.mid{color:#fbbf24}.score.low{color:#f87171}
  .insight-box{background:#0f172a;border:1px solid #2d3748;border-radius:8px;padding:16px;margin-bottom:12px;line-height:1.6;font-size:14px}
  .suggestion{background:#1a1d2e;border:1px solid #2d3748;border-radius:8px;padding:14px;margin-bottom:10px}
  .suggestion .title{font-weight:600;color:#f1f5f9;margin-bottom:4px}
  .suggestion .savings{color:#34d399;font-size:13px}
  .suggestion .type{font-size:11px;padding:2px 8px;border-radius:4px;font-weight:600}
  .type-automation{background:#1d4ed8;color:#bfdbfe}
  .type-batch{background:#7c3aed;color:#ddd6fe}
  .type-ai_assist{background:#0f766e;color:#99f6e4}
  .type-eliminate{background:#9a3412;color:#fed7aa}
  .btn{padding:8px 18px;border-radius:8px;border:none;cursor:pointer;font-size:13px;font-weight:600;transition:.2s}
  .btn-primary{background:#FCB900;color:#0f1117}.btn-primary:hover{background:#f0b000}
  .btn-danger{background:#991b1b;color:#fecaca}.btn-danger:hover{background:#7f1d1d}
  .btn-success{background:#064e3b;color:#6ee7b7}.btn-success:hover{background:#065f46}
  .btn:disabled{opacity:.4;cursor:default}
  .actions{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:24px}
  .privacy-list{list-style:none}
  .privacy-list li{padding:8px 0;border-bottom:1px solid #1e293b;color:#94a3b8;font-size:13px;display:flex;align-items:center;gap:8px}
  .privacy-list li::before{content:"🔒";font-size:11px}
  .alert{background:#1e3a2f;border:1px solid #166534;border-radius:8px;padding:12px 16px;color:#86efac;font-size:13px;margin-bottom:16px}
</style>
</head>
<body>
<header>
  <h1>📊 Work Monitor</h1>
  <div id="daemonBadge" class="badge off"><div class="dot off"></div>確認中...</div>
</header>
<nav>
  <button class="tab active" onclick="showPage('today')">今日</button>
  <button class="tab" onclick="showPage('week')">週間</button>
  <button class="tab" onclick="showPage('insight')">AIレポート</button>
  <button class="tab" onclick="showPage('privacy')">プライバシー</button>
  <button class="tab" onclick="showPage('settings')">設定</button>
</nav>
<main>

<!-- 今日 -->
<div id="page-today" class="page active">
  <div class="grid" id="todayCards"></div>
  <div class="chart-wrap"><h2>カテゴリ別時間</h2><canvas id="catChart" height="80"></canvas></div>
  <div class="chart-wrap">
    <h2>直近の活動</h2>
    <table class="table">
      <thead><tr><th>時刻</th><th>アプリ</th><th>タイトル</th><th>カテゴリ</th><th>時間</th></tr></thead>
      <tbody id="activityTable"></tbody>
    </table>
  </div>
</div>

<!-- 週間 -->
<div id="page-week" class="page">
  <div class="chart-wrap"><h2>過去7日間 カテゴリ別時間推移</h2><canvas id="weekChart" height="100"></canvas></div>
  <div class="chart-wrap"><h2>効率スコア推移（AIレポートがある日）</h2><canvas id="scoreChart" height="80"></canvas></div>
</div>

<!-- AIレポート -->
<div id="page-insight" class="page">
  <div class="actions">
    <button class="btn btn-primary" onclick="generateReport()">今すぐ日報生成 &amp; Slack送信</button>
  </div>
  <div id="insightContent"></div>
</div>

<!-- プライバシー -->
<div id="page-privacy" class="page">
  <div class="alert">🔒 以下のアプリ・URLはウィンドウタイトルとURLを記録しません。時間のみ計測します。</div>
  <div class="chart-wrap">
    <h2>ブロック済みアプリ</h2>
    <ul class="privacy-list" id="blockedApps"></ul>
  </div>
  <div class="chart-wrap">
    <h2>ブロック済みURLパターン</h2>
    <ul class="privacy-list" id="blockedUrls"></ul>
  </div>
  <div class="chart-wrap">
    <h2>マスク済みパターン（タイトルから自動除去）</h2>
    <ul class="privacy-list" id="sanitizedPatterns"></ul>
  </div>
</div>

<!-- 設定 -->
<div id="page-settings" class="page">
  <div class="chart-wrap">
    <h2>デーモン制御</h2>
    <div style="display:flex;gap:12px;align-items:center;margin-top:8px">
      <button class="btn btn-success" onclick="startDaemon()">▶ 監視開始</button>
      <button class="btn btn-danger" onclick="stopDaemon()">■ 監視停止</button>
      <span id="daemonStatusText" style="font-size:13px;color:#64748b"></span>
    </div>
  </div>
  <div class="chart-wrap">
    <h2>データ管理</h2>
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:8px">
      <button class="btn btn-danger" onclick="resetToday()">今日のデータをリセット</button>
    </div>
    <p style="font-size:12px;color:#64748b;margin-top:12px">完全なアンインストールはターミナルで: <code style="background:#0f1117;padding:2px 6px;border-radius:4px">npm run uninstall</code></p>
  </div>
</div>

</main>

<script>
const CATS = {
  core_dev:'⚙️ コア開発', communication:'💬 コミュニケーション', meeting:'📹 ミーティング',
  research:'🔍 調査', admin:'🗂 管理', design:'🎨 デザイン', ai_tool:'🤖 AIツール',
  entertainment:'🎮 エンタメ', idle:'😴 アイドル', other:'❓ その他',
};
const CAT_COLORS = {
  core_dev:'#FCB900', communication:'#60a5fa', meeting:'#a78bfa', research:'#34d399',
  admin:'#94a3b8', design:'#f472b6', ai_tool:'#fb923c', entertainment:'#e879f9',
  idle:'#475569', other:'#334155',
};
let catChart, weekChart, scoreChart;

function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById('page-'+name).classList.add('active');
  event.target.classList.add('active');
  if (name==='today') loadToday();
  if (name==='week') loadWeek();
  if (name==='insight') loadInsight();
  if (name==='privacy') loadPrivacy();
  if (name==='settings') checkStatus();
}

function fmt(sec) {
  const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60);
  return h>0 ? h+'h'+m+'m' : m+'m';
}

async function checkStatus() {
  const r = await fetch('/api/status').then(r=>r.json());
  const badge = document.getElementById('daemonBadge');
  const dot = badge.querySelector('.dot');
  if (r.running) {
    badge.className = 'badge on'; dot.className = 'dot on'; badge.innerHTML = '<div class="dot on"></div>監視中';
  } else {
    badge.className = 'badge off'; dot.className = 'dot off'; badge.innerHTML = '<div class="dot off"></div>停止中';
  }
  const st = document.getElementById('daemonStatusText');
  if (st) st.textContent = r.running ? '監視中' : '停止中';
}

async function loadToday() {
  const { summary, activities } = await fetch('/api/today').then(r=>r.json());
  // カード
  const eff = summary.total_tracked_seconds;
  const coreTime = (summary.categories.find(c=>c.category==='core_dev')?.total_seconds??0);
  const corePct = eff>0 ? Math.round(coreTime/eff*100) : 0;
  document.getElementById('todayCards').innerHTML = \`
    <div class="card"><h3>合計追跡時間</h3><div class="value">\${fmt(eff)}</div><div class="sub">アイドル除く</div></div>
    <div class="card"><h3>コア開発</h3><div class="value">\${fmt(coreTime)}</div><div class="sub">\${corePct}%</div></div>
    <div class="card"><h3>カテゴリ数</h3><div class="value">\${summary.categories.length}</div><div class="sub">今日</div></div>
    <div class="card"><h3>アイドル</h3><div class="value">\${fmt(summary.idle_seconds)}</div><div class="sub">5分以上無操作</div></div>
  \`;
  // 円グラフ
  const labels = summary.categories.map(c=>CATS[c.category]??c.category);
  const data = summary.categories.map(c=>Math.round(c.total_seconds/60));
  const colors = summary.categories.map(c=>CAT_COLORS[c.category]??'#334155');
  if (catChart) catChart.destroy();
  catChart = new Chart(document.getElementById('catChart'), {
    type:'doughnut', data:{labels, datasets:[{data, backgroundColor:colors, borderWidth:0}]},
    options:{plugins:{legend:{position:'right',labels:{color:'#94a3b8',font:{size:12}}}}, cutout:'65%'},
  });
  // テーブル
  const tbody = document.getElementById('activityTable');
  tbody.innerHTML = activities.slice(0,30).map(a => {
    const t = new Date(a.start_time).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'});
    const dur = fmt(a.duration_seconds);
    const title = a.window_title && a.window_title !== '[非表示]' ? a.window_title.slice(0,40) : a.window_title||'';
    return \`<tr><td>\${t}</td><td>\${a.app_name}</td><td style="color:#64748b">\${title}</td><td><span class="cat-badge">\${CATS[a.category]??a.category}</span></td><td>\${dur}</td></tr>\`;
  }).join('');
}

async function loadWeek() {
  const days = await fetch('/api/week').then(r=>r.json());
  const labels = days.map(d=>d.date.slice(5));
  const catKeys = ['core_dev','communication','meeting','research','admin','ai_tool','other'];
  const datasets = catKeys.map(k=>({
    label: CATS[k], data: days.map(d=>{
      const c = d.categories.find(c=>c.category===k);
      return c ? Math.round(c.total_seconds/60) : 0;
    }), backgroundColor: CAT_COLORS[k], stack:'a',
  }));
  if (weekChart) weekChart.destroy();
  weekChart = new Chart(document.getElementById('weekChart'),{
    type:'bar', data:{labels, datasets},
    options:{plugins:{legend:{labels:{color:'#94a3b8',font:{size:11}}}},scales:{
      x:{stacked:true,ticks:{color:'#64748b'},grid:{color:'#1e293b'}},
      y:{stacked:true,ticks:{color:'#64748b',callback:v=>v+'m'},grid:{color:'#1e293b'}},
    }},
  });
  // スコアチャート（インサイトあり日）
  const scoreData = await Promise.all(days.map(d=>fetch('/api/insight/'+d.date).then(r=>r.json())));
  const scores = scoreData.map(s=>s.efficiency_score??null);
  if (scoreChart) scoreChart.destroy();
  scoreChart = new Chart(document.getElementById('scoreChart'),{
    type:'line', data:{labels, datasets:[{label:'効率スコア',data:scores,borderColor:'#FCB900',backgroundColor:'rgba(252,185,0,.15)',fill:true,tension:.4,pointRadius:4,pointBackgroundColor:'#FCB900'}]},
    options:{plugins:{legend:{display:false}},scales:{
      x:{ticks:{color:'#64748b'},grid:{color:'#1e293b'}},
      y:{min:0,max:100,ticks:{color:'#64748b'},grid:{color:'#1e293b'}},
    }},
  });
}

async function loadInsight() {
  const date = new Date().toLocaleDateString('sv-SE');
  const insight = await fetch('/api/insight/'+date).then(r=>r.json());
  const el = document.getElementById('insightContent');
  if (insight.error) {
    el.innerHTML = '<p style="color:#64748b;padding:16px">まだ今日のレポートがありません。「今すぐ日報生成」で作成できます。</p>';
    return;
  }
  const scoreClass = insight.efficiency_score>=70?'high':insight.efficiency_score>=50?'mid':'low';
  const suggestions = (insight.suggestions??[]).map(s=>\`
    <div class="suggestion">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <span class="type type-\${s.automation_type}">\${s.automation_type}</span>
        <span class="title">\${s.task_description}</span>
        <span style="color:#64748b;font-size:12px;margin-left:auto">\${s.time_spent_minutes}分/日</span>
      </div>
      <div class="savings">→ \${s.agent_name} で \${s.estimated_savings_minutes}分削減可能</div>
    </div>
  \`).join('');
  const actions = (insight.action_items??[]).map((a,i)=>\`<li style="padding:6px 0;color:#94a3b8;font-size:13px">\${i+1}. \${a}</li>\`).join('');
  el.innerHTML = \`
    <div class="grid">
      <div class="card" style="text-align:center">
        <h3>効率スコア</h3>
        <div class="score \${scoreClass}">\${insight.efficiency_score}</div>
        <div class="sub">/100</div>
      </div>
      <div class="card" style="grid-column:span 2">
        <h3>評価</h3>
        <div style="font-size:16px;font-weight:600;color:#f1f5f9;margin-top:8px">\${insight.summary}</div>
      </div>
    </div>
    <div class="chart-wrap"><h2>🤖 AI自動化提案</h2>\${suggestions||'<p style="color:#64748b">提案なし</p>'}</div>
    <div class="chart-wrap"><h2>✅ 明日のアクション</h2><ol style="list-style:none">\${actions}</ol></div>
  \`;
}

async function loadPrivacy() {
  const r = await fetch('/api/privacy-rules').then(r=>r.json());
  document.getElementById('blockedApps').innerHTML = r.blockedApps.map(a=>\`<li>\${a}</li>\`).join('');
  document.getElementById('blockedUrls').innerHTML = r.blockedUrlPatterns.map(a=>\`<li>\${a}</li>\`).join('');
  document.getElementById('sanitizedPatterns').innerHTML = r.sanitizedPatterns.map(a=>\`<li>\${a}</li>\`).join('');
}

async function generateReport() {
  const btn = event.target;
  btn.disabled = true; btn.textContent = '生成中...';
  try {
    const r = await fetch('/api/report',{method:'POST'}).then(r=>r.json());
    if (r.ok) { loadInsight(); alert('✅ Slackに送信しました！'); }
    else alert('エラー: ' + (r.error||'不明'));
  } finally { btn.disabled=false; btn.textContent='今すぐ日報生成 & Slack送信'; }
}

async function startDaemon() {
  await fetch('/api/daemon/start',{method:'POST'});
  setTimeout(checkStatus, 1500);
}
async function stopDaemon() {
  if (!confirm('監視を停止しますか？')) return;
  await fetch('/api/daemon/stop',{method:'POST'});
  setTimeout(checkStatus, 1500);
}
async function resetToday() {
  if (!confirm('今日のデータをすべて削除しますか？')) return;
  const date = new Date().toLocaleDateString('sv-SE');
  await fetch('/api/reset/'+date,{method:'DELETE'});
  loadToday();
}

// 起動時
loadToday();
checkStatus();
setInterval(()=>{ if(document.getElementById('page-today').classList.contains('active')) loadToday(); }, 30000);
setInterval(checkStatus, 10000);
</script>
</body>
</html>`;
