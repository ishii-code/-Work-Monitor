import axios from 'axios';

export async function sendToSlack(text: string, channel?: string): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL ?? '';
  if (!webhookUrl) {
    console.warn('[notifier] SLACK_WEBHOOK_URL not set, skipping notification');
    return;
  }

  const payload: { text: string; channel?: string } = { text };
  if (channel) payload.channel = channel;

  await axios.post(webhookUrl, payload);
}

export function logToConsole(text: string): void {
  const timestamp = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  console.log(`[${timestamp}] ${text}`);
}
