/**
 * Telegram admin notifications.
 *
 * Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.
 *
 * `notify()` is fire-and-forget — a failed Telegram send never blocks the
 * request that triggered it. Errors are logged so we know about them without
 * failing user flows.
 */

function isTelegramConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

async function sendTelegram(text) {
  if (!isTelegramConfigured()) return { ok: false, error: 'not configured' };
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = new URLSearchParams({
    chat_id: process.env.TELEGRAM_CHAT_ID,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: 'true',
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(`Telegram send failed: ${data.description || res.status}`);
  }
  return { ok: true, messageId: data.result.message_id };
}

function notify(text) {
  sendTelegram(text).catch(err => {
    console.error('[telegram] notify failed:', err.message);
  });
}

// Escape user-provided values inside our HTML-formatted messages so a stray
// "<" in a name or company doesn't break Telegram's parser.
function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function notifyNewLead(lead) {
  const lines = [];
  lines.push('🎯 <b>طلب توظيف جديد</b>');
  lines.push('');
  lines.push(`👤 <b>الاسم:</b> ${esc(lead.name)}`);
  lines.push(`💼 <b>الوظيفة:</b> ${esc(lead.position)}`);
  if (lead.email) lines.push(`📧 <b>الإيميل:</b> ${esc(lead.email)}`);
  if (lead.phone) lines.push(`📱 <b>الموبايل:</b> ${esc(lead.phone)}`);
  if (lead.jobTitle) {
    lines.push('');
    lines.push(`🔗 <b>من بوست:</b> ${esc(lead.jobTitle)}`);
    if (lead.jobCompany) lines.push(`🏢 ${esc(lead.jobCompany)}`);
  }
  if (lead.notes) {
    lines.push('');
    lines.push(`📝 <i>${esc(lead.notes)}</i>`);
  }
  lines.push('');
  if (lead.driveLink) {
    lines.push(`📎 <a href="${esc(lead.driveLink)}">CV على Drive</a>`);
  } else if (lead.localFile) {
    lines.push('⚠️ CV محفوظ محلياً فقط (Drive unavailable)');
  }
  notify(lines.join('\n'));
}

const SLOT_LABELS_AR = {
  morning: 'صباحاً (10:00)',
  afternoon: 'ظهراً (2:00)',
  evening: 'مساءً (8:00)',
};

function notifyPostRun(result) {
  const results = result && result.results ? result.results : [];
  const fbOk = results.filter(r => r.facebook && r.facebook.ok).length;
  const fbFail = results.filter(r => r.facebook && !r.facebook.ok && r.facebook.error !== 'not configured').length;
  const xOk = results.filter(r => r.x && r.x.ok).length;
  const xFail = results.filter(r => r.x && !r.x.ok && r.x.error !== 'not configured').length;

  const lines = [];
  const slotLabel = result && result.slot && SLOT_LABELS_AR[result.slot];
  lines.push(slotLabel ? `📢 <b>نشر ${slotLabel}</b>` : '📢 <b>ملخص النشر</b>');
  lines.push('');
  lines.push(`✅ Facebook: ${fbOk}${fbFail ? ` (❌ ${fbFail} فشل)` : ''}`);
  if (xOk || xFail) lines.push(`✅ X: ${xOk}${xFail ? ` (❌ ${xFail} فشل)` : ''}`);
  if (result.skipped) {
    lines.push('');
    lines.push(`⚠️ تم التخطي: ${esc(result.reason || 'unknown')}`);
  }
  if (results.length) {
    lines.push('');
    lines.push('<b>الوظائف المنشورة:</b>');
    results.slice(0, 10).forEach(r => {
      const status = (r.facebook && r.facebook.ok) ? '✅' : '❌';
      lines.push(`${status} ${esc((r.title || '').slice(0, 60))}`);
    });
  }
  notify(lines.join('\n'));
}

function notifyError(context, err) {
  const text = [
    '🚨 <b>خطأ في Wzyfa</b>',
    '',
    `📍 <b>Context:</b> ${esc(context)}`,
    `💥 <b>Error:</b> <code>${esc(err && err.message ? err.message : err)}</code>`,
  ].join('\n');
  notify(text);
}

module.exports = {
  isTelegramConfigured,
  notify,
  notifyNewLead,
  notifyPostRun,
  notifyError,
};
