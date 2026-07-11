/**
 * One-time Google Drive OAuth setup for the /careers CV upload.
 *
 * Prereq (once, in https://console.cloud.google.com):
 *   1. Create/pick a project → enable "Google Drive API".
 *   2. OAuth consent screen → External → add yourself as test user.
 *   3. Credentials → Create OAuth client ID → type "Web application"
 *      → authorized redirect URI: http://127.0.0.1:53682/callback
 *
 * Run:
 *   node scripts/get-drive-refresh-token.mjs <CLIENT_ID> <CLIENT_SECRET>
 *
 * Opens a consent URL, captures the refresh token, creates the
 * "وظيفة — طلبات التوظيف" folder in your Drive, and prints the four
 * env lines to paste into .env / the VPS environment.
 *
 * Scope is drive.file — the app can only see files/folders it created,
 * not the rest of your Drive.
 */

import http from 'node:http';

const [clientId, clientSecret] = process.argv.slice(2);
if (!clientId || !clientSecret) {
  console.error('Usage: node scripts/get-drive-refresh-token.mjs <CLIENT_ID> <CLIENT_SECRET>');
  process.exit(1);
}

const PORT = 53682;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
  });

console.log('\n1) افتح الرابط ده في المتصفح ووافق بحساب islam.aboughazala@gmail.com:\n');
console.log(authUrl + '\n');
console.log('2) مستني الرجوع على ' + REDIRECT + ' ...\n');

const code = await new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    const c = url.searchParams.get('code');
    const err = url.searchParams.get('error');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(c ? '<h2>تمام ✅ ارجع للترمنال</h2>' : `<h2>فشل: ${err}</h2>`);
    server.close();
    c ? resolve(c) : reject(new Error(err ?? 'no code'));
  });
  server.listen(PORT);
});

const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: REDIRECT,
    grant_type: 'authorization_code',
  }),
});
const tokens = await tokenRes.json();
if (!tokens.refresh_token) {
  console.error('لم يرجع refresh_token — الرد:', tokens);
  process.exit(1);
}

const folderRes = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,webViewLink', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${tokens.access_token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    name: 'وظيفة — طلبات التوظيف',
    mimeType: 'application/vnd.google-apps.folder',
  }),
});
const folder = await folderRes.json();
if (!folder.id) {
  console.error('فشل إنشاء المجلد:', folder);
  process.exit(1);
}

console.log('\n✅ تم. أضف السطور دي في .env (محلياً وعلى السيرفر):\n');
console.log(`GOOGLE_DRIVE_CLIENT_ID="${clientId}"`);
console.log(`GOOGLE_DRIVE_CLIENT_SECRET="${clientSecret}"`);
console.log(`GOOGLE_DRIVE_REFRESH_TOKEN="${tokens.refresh_token}"`);
console.log(`GOOGLE_DRIVE_FOLDER_ID="${folder.id}"`);
console.log(`\nمجلد الطلبات في درايفك: https://drive.google.com/drive/folders/${folder.id}\n`);
