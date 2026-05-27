import { google } from 'googleapis';
import {
  saveCalendarTokens,
  getCalendarTokens,
  upsertCalendarEvent,
} from './cloud-db.js';

const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];
const INTERNAL_DOMAIN = 'peco-japan.com';

export function getOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI が未設定');
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function buildAuthUrl(state: string): string {
  const oauth = getOAuthClient();
  return oauth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state,
  });
}

export async function handleOAuthCallback(code: string, employeeId: number): Promise<void> {
  const oauth = getOAuthClient();
  const { tokens } = await oauth.getToken(code);
  if (!tokens.access_token || !tokens.refresh_token) {
    throw new Error('OAuth tokens missing access_token/refresh_token');
  }
  const expiry = tokens.expiry_date ? new Date(tokens.expiry_date) : null;
  await saveCalendarTokens(employeeId, tokens.access_token, tokens.refresh_token, expiry);
}

function classifyMeetingType(attendeeDomains: string[]): string {
  if (attendeeDomains.length === 0) return 'focus';
  const hasExternal = attendeeDomains.some((d) => d && d !== INTERNAL_DOMAIN);
  return hasExternal ? 'external' : 'internal';
}

export async function syncCalendar(employeeId: number, date: string): Promise<number> {
  const tokens = await getCalendarTokens(employeeId);
  if (!tokens) return 0;

  const oauth = getOAuthClient();
  oauth.setCredentials({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry ? new Date(tokens.expiry).getTime() : undefined,
  });

  const calendar = google.calendar({ version: 'v3', auth: oauth });
  const dayStart = new Date(date + 'T00:00:00+09:00');
  const dayEnd = new Date(date + 'T23:59:59+09:00');

  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: dayStart.toISOString(),
    timeMax: dayEnd.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 100,
  });

  // OAuth client may refresh token; persist new access token if changed
  const newCreds = oauth.credentials;
  if (newCreds.access_token && newCreds.access_token !== tokens.access_token) {
    await saveCalendarTokens(
      employeeId,
      newCreds.access_token,
      newCreds.refresh_token ?? tokens.refresh_token,
      newCreds.expiry_date ? new Date(newCreds.expiry_date) : null
    );
  }

  const items = res.data.items ?? [];
  let count = 0;
  for (const ev of items) {
    if (!ev.id) continue;
    const attendees = (ev.attendees ?? [])
      .map((a) => (a.email ?? '').split('@')[1] ?? '')
      .filter((d) => d.length > 0);
    const meetingType = classifyMeetingType(attendees);
    await upsertCalendarEvent({
      employeeId,
      eventId: ev.id,
      title: ev.summary ?? null,
      startTime: ev.start?.dateTime ? new Date(ev.start.dateTime) : (ev.start?.date ? new Date(ev.start.date) : null),
      endTime: ev.end?.dateTime ? new Date(ev.end.dateTime) : (ev.end?.date ? new Date(ev.end.date) : null),
      meetingType,
      attendeeDomains: attendees,
      date,
    });
    count += 1;
  }
  return count;
}
