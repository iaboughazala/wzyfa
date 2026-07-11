/**
 * Google Drive upload via OAuth2 refresh token — no SDK, plain REST.
 *
 * Uploads land in the folder GOOGLE_DRIVE_FOLDER_ID inside the personal
 * Drive of the account that granted the refresh token. Service accounts
 * do NOT have storage quota on personal (gmail.com) Drives, which is why
 * we use the owner's own OAuth grant instead.
 *
 * One-time setup: `node scripts/get-drive-refresh-token.mjs <ID> <SECRET>`
 *
 * Env: GOOGLE_DRIVE_CLIENT_ID, GOOGLE_DRIVE_CLIENT_SECRET,
 *      GOOGLE_DRIVE_REFRESH_TOKEN, GOOGLE_DRIVE_FOLDER_ID
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const UPLOAD_URL =
  'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink';

let cachedToken = null;

function isDriveConfigured() {
  return Boolean(
    process.env.GOOGLE_DRIVE_CLIENT_ID &&
      process.env.GOOGLE_DRIVE_CLIENT_SECRET &&
      process.env.GOOGLE_DRIVE_REFRESH_TOKEN &&
      process.env.GOOGLE_DRIVE_FOLDER_ID
  );
}

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) return cachedToken.token;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_DRIVE_CLIENT_ID,
      client_secret: process.env.GOOGLE_DRIVE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_DRIVE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`Drive token refresh failed: ${data.error || res.status}`);
  }
  cachedToken = { token: data.access_token, expiresAt: now + (data.expires_in || 3600) * 1000 };
  return data.access_token;
}

async function uploadToDrive({ buffer, fileName, mimeType, description, folderId }) {
  const token = await getAccessToken();
  const parentId = folderId || process.env.GOOGLE_DRIVE_FOLDER_ID;

  const metadata = {
    name: fileName,
    parents: [parentId],
    description: description || '',
  };

  const boundary = `wzyfa_${Math.random().toString(36).slice(2)}`;
  const head =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;
  const body = Buffer.concat([Buffer.from(head, 'utf8'), buffer, Buffer.from(tail, 'utf8')]);

  const res = await fetch(UPLOAD_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
      'Content-Length': String(body.length),
    },
    body,
    signal: AbortSignal.timeout(60_000),
  });
  const data = await res.json();
  if (!res.ok || !data.id) {
    throw new Error(`Drive upload failed: ${(data.error && data.error.message) || res.status}`);
  }
  return { id: data.id, webViewLink: data.webViewLink || null };
}

module.exports = { isDriveConfigured, uploadToDrive };
