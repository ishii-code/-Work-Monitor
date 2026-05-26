#!/bin/bash
#
# pc-work-monitor インストーラ（社員PC向け・macOS）
#
# 使い方:
#   curl -fsSL https://raw.githubusercontent.com/ishii-code/-Work-Monitor/main/install.sh | bash
#   または
#   bash install.sh
#
set -euo pipefail

REPO_URL="https://github.com/ishii-code/-Work-Monitor.git"
INSTALL_DIR="$HOME/workspace/pc-work-monitor"
PLIST_LABEL="com.peco.pc-work-monitor"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
LOG_DIR="$INSTALL_DIR/data"
MIN_NODE_MAJOR=20

bold()  { printf "\033[1m%s\033[0m\n" "$*"; }
red()   { printf "\033[31m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
yellow(){ printf "\033[33m%s\033[0m\n" "$*"; }

bold "🩺 pc-work-monitor インストーラ"

if [[ "$(uname)" != "Darwin" ]]; then
  red "❌ このスクリプトは macOS 専用です（uname: $(uname)）"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  red "❌ Node.js が見つかりません。https://nodejs.org/ から v${MIN_NODE_MAJOR} 以上をインストールしてください。"
  exit 1
fi
NODE_VERSION="$(node -v)"
NODE_MAJOR="${NODE_VERSION#v}"
NODE_MAJOR="${NODE_MAJOR%%.*}"
if [[ "${NODE_MAJOR}" -lt "${MIN_NODE_MAJOR}" ]]; then
  red "❌ Node.js v${MIN_NODE_MAJOR} 以上が必要です（現在: ${NODE_VERSION}）"
  exit 1
fi
green "✅ Node.js ${NODE_VERSION} を検出"

if ! command -v git >/dev/null 2>&1; then
  red "❌ git が見つかりません。Xcode Command Line Tools をインストールしてください。"
  red "   xcode-select --install"
  exit 1
fi

if [[ -d "${INSTALL_DIR}/.git" ]]; then
  yellow "📁 既存インストールを更新します: ${INSTALL_DIR}"
  git -C "${INSTALL_DIR}" pull --ff-only
else
  mkdir -p "$(dirname "${INSTALL_DIR}")"
  green "📥 リポジトリを clone します → ${INSTALL_DIR}"
  git clone "${REPO_URL}" "${INSTALL_DIR}"
fi

cd "${INSTALL_DIR}"

green "📦 依存パッケージをインストールします（npm install）…"
npm install --no-audit --no-fund

ENV_FILE="${INSTALL_DIR}/.env"
SKIP_ENV=0
if [[ -f "${ENV_FILE}" ]]; then
  yellow "⚠️  既存の .env を検出しました。上書きしますか？ [y/N]"
  read -r OVERWRITE </dev/tty || OVERWRITE="n"
  if [[ "${OVERWRITE}" != "y" && "${OVERWRITE}" != "Y" ]]; then
    yellow "→ 既存の .env を保持します"
    SKIP_ENV=1
  fi
fi

if [[ "${SKIP_ENV}" != "1" ]]; then
  bold "🔑 クラウド連携の設定を入力してください"
  printf "  CLOUD_API_URL（例: https://pc-work-monitor.example.com）: "
  read -r CLOUD_API_URL </dev/tty
  printf "  EMPLOYEE_API_KEY（管理者から配布された値）: "
  read -r EMPLOYEE_API_KEY </dev/tty

  if [[ -z "${CLOUD_API_URL}" || -z "${EMPLOYEE_API_KEY}" ]]; then
    red "❌ CLOUD_API_URL と EMPLOYEE_API_KEY は必須です"
    exit 1
  fi

  printf "  SLACK_WEBHOOK_URL（任意・空でも可）: "
  read -r SLACK_WEBHOOK_URL </dev/tty || SLACK_WEBHOOK_URL=""

  cat > "${ENV_FILE}" <<EOF
CLOUD_API_URL=${CLOUD_API_URL}
EMPLOYEE_API_KEY=${EMPLOYEE_API_KEY}
SLACK_WEBHOOK_URL=${SLACK_WEBHOOK_URL}
EOF
  chmod 600 "${ENV_FILE}"
  green "✅ .env を作成しました（パーミッション 600）"
fi

mkdir -p "${LOG_DIR}"

NODE_BIN="$(command -v node)"
NPX_BIN="$(command -v npx)"
NODE_BIN_DIR="$(dirname "${NODE_BIN}")"

mkdir -p "$(dirname "${PLIST_PATH}")"
cat > "${PLIST_PATH}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NPX_BIN}</string>
    <string>tsx</string>
    <string>${INSTALL_DIR}/scripts/daemon.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${INSTALL_DIR}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/daemon.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/daemon-error.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${NODE_BIN_DIR}:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
EOF
green "✅ launchd plist を作成しました: ${PLIST_PATH}"

launchctl unload "${PLIST_PATH}" 2>/dev/null || true
launchctl load "${PLIST_PATH}"
green "✅ デーモンを起動しました"

echo
bold "🎉 インストール完了！"
echo
echo "  インストール先: ${INSTALL_DIR}"
echo "  ログ:           ${LOG_DIR}/daemon.log"
echo
yellow "⚠️  次の手順を必ず実施してください："
echo "  1) システム設定 > プライバシーとセキュリティ > アクセシビリティ"
echo "     → node 実体（${NODE_BIN}）を追加してオン"
echo "  2) 動作確認: tail -f ${LOG_DIR}/daemon.log"
echo
echo "  停止:        launchctl unload ${PLIST_PATH}"
echo "  再開:        launchctl load   ${PLIST_PATH}"
echo "  アンインストール: cd ${INSTALL_DIR} && npm run uninstall"
echo
