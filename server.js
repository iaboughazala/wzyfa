const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
const MAX_JOBS = 500;
const EMAIL_JOBS_FILE = path.join(DATA_DIR, 'email-jobs.json');
const MAX_EMAIL_JOBS = 300;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── State ───
let scanning = false;
let lastScan = null;
let emailScanning = false;
let emailLastScan = null;

// ─── Keywords & Locations ───
const ALL_KEYWORDS = [
  'Digital Transformation Lead',
  'Business Excellence Manager',
  'Business Excellence Lead',
  'Transformation Manager',
  'Transformation Lead',
  'Enterprise Transformation Lead',
  'Strategy and Transformation Manager',
  'Program Manager',
  'PMO Manager',
  'Senior Project Manager Transformation',
  'Senior Project Manager ERP',
  'Product Owner Enterprise',
  'Product Owner ERP',
  'Digital Product Lead',
  'Solution Lead',
  'Transformation Director',
  'Business Excellence Director',
  'Operations Director Transformation',
  'Digital Transformation Manager'
];

const TOP5_KEYWORDS = ALL_KEYWORDS.slice(0, 5);

const LOCATIONS = [
  { label: 'Saudi Arabia', query: 'Saudi Arabia', indeedL: 'Saudi+Arabia', gulfCountry: 'saudi-arabia' },
  { label: 'UAE Dubai', query: 'UAE Dubai', indeedL: 'Dubai', gulfCountry: 'uae' }
];

// ─── Helpers ───
function loadJobs() {
  try {
    if (fs.existsSync(JOBS_FILE)) {
      return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('Error loading jobs:', e.message);
  }
  return [];
}

function saveJobs(jobs) {
  fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2), 'utf-8');
}

function deduplicateJobs(jobs) {
  const seen = new Map();
  for (const job of jobs) {
    const key = `${(job.title || '').toLowerCase().trim()}|||${(job.company || '').toLowerCase().trim()}`;
    if (!seen.has(key)) {
      seen.set(key, job);
    }
  }
  return Array.from(seen.values()).slice(0, MAX_JOBS);
}

function makeGoogleFallback(title, company) {
  const q = encodeURIComponent(`${title} ${company} jobs`);
  return `https://www.google.com/search?q=${q}`;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function detectWorkMode(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('remote') || t.includes('عن بعد')) return 'remote';
  if (t.includes('hybrid') || t.includes('هجين')) return 'hybrid';
  return 'onsite';
}

function detectCountry(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('saudi') || t.includes('riyadh') || t.includes('jeddah') || t.includes('ksa') || t.includes('dammam')) return 'Saudi Arabia';
  if (t.includes('dubai') || t.includes('uae') || t.includes('abu dhabi') || t.includes('emirates') || t.includes('sharjah')) return 'UAE';
  if (t.includes('qatar') || t.includes('doha')) return 'Qatar';
  if (t.includes('egypt') || t.includes('cairo')) return 'Egypt';
  if (t.includes('bahrain') || t.includes('manama')) return 'Bahrain';
  if (t.includes('kuwait')) return 'Kuwait';
  if (t.includes('oman') || t.includes('muscat')) return 'Oman';
  if (t.includes('jordan') || t.includes('amman')) return 'Jordan';
  if (t.includes('remote')) return 'Remote';
  return '';
}

// ─── Email Jobs Helpers ───
function loadEmailJobs() {
  try {
    if (fs.existsSync(EMAIL_JOBS_FILE)) {
      return JSON.parse(fs.readFileSync(EMAIL_JOBS_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('Error loading email jobs:', e.message);
  }
  return [];
}

function saveEmailJobs(jobs) {
  fs.writeFileSync(EMAIL_JOBS_FILE, JSON.stringify(jobs, null, 2), 'utf-8');
}

function deduplicateEmailJobs(jobs) {
  const seen = new Map();
  for (const job of jobs) {
    const key = `${(job.email || '').toLowerCase().trim()}|||${(job.title || '').toLowerCase().trim()}`;
    if (!seen.has(key)) {
      seen.set(key, job);
    }
  }
  return Array.from(seen.values()).slice(0, MAX_EMAIL_JOBS);
}

function extractEmails(text) {
  if (!text) return [];
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const matches = text.match(emailRegex) || [];
  const blocked = ['noreply', 'no-reply', 'mailer-daemon', 'postmaster', 'abuse@', 'spam@', 'admin@example', 'test@'];
  return [...new Set(matches)].filter(email => {
    const lower = email.toLowerCase();
    return !blocked.some(b => lower.includes(b)) && !lower.endsWith('.png') && !lower.endsWith('.jpg');
  });
}

function extractJobTitleFromText(text) {
  const patterns = [
    /(?:مطلوب|نبحث عن|وظيفة|فرصة عمل|hiring|looking for|we need|job opening|position)[:\s]*([^\n.،,]{5,60})/i,
    /(?:vacancy|role|opening)[:\s]*([^\n.،,]{5,60})/i
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1].trim();
  }
  // Fallback: use first meaningful line
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 10 && l.length < 100);
  return lines[0] || 'وظيفة شاغرة';
}

function extractCompanyFromText(text) {
  const patterns = [
    /(?:شركة|مؤسسة|company|at|@)\s+([^\n.،,]{3,40})/i,
    /(?:hiring at|join)\s+([^\n.،,]{3,40})/i
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1].trim();
  }
  return 'غير محدد';
}

function fetchJSON(url, options = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const reqOptions = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        ...(options.headers || {})
      },
      method: options.method || 'GET',
      timeout: 30000
    };

    const req = mod.request(url, reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });

    if (options.body) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

// ─── Puppeteer helpers ───
async function launchBrowser() {
  const puppeteer = require('puppeteer');
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--single-process',
    '--disable-blink-features=AutomationControlled',
    '--shm-size=1gb'
  ];
  const execPath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
  const browser = await puppeteer.launch({
    headless: 'new',
    args,
    executablePath: execPath,
    defaultViewport: { width: 1366, height: 768 }
  });
  return browser;
}

async function setupPage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  });
  page.setDefaultNavigationTimeout(30000);
  return page;
}

// ─── Source: RemoteOK API ───
async function fetchRemoteOK() {
  console.log('[RemoteOK] Fetching...');
  const jobs = [];
  try {
    const data = await fetchJSON('https://remoteok.com/api');
    const items = Array.isArray(data) ? data : [];
    for (const item of items) {
      if (!item.position) continue;
      const title = item.position || '';
      const titleLower = title.toLowerCase();
      const matches = ALL_KEYWORDS.some(kw => titleLower.includes(kw.toLowerCase()) || kw.toLowerCase().split(' ').every(w => titleLower.includes(w)));
      if (!matches) continue;
      jobs.push({
        title,
        company: item.company || 'Unknown',
        location: item.location || 'Remote',
        url: item.url || makeGoogleFallback(title, item.company),
        platform: 'RemoteOK',
        postedDate: item.date ? new Date(item.date).toISOString() : new Date().toISOString(),
        workMode: 'remote',
        country: detectCountry(item.location || 'Remote'),
        scrapedAt: new Date().toISOString()
      });
    }
    console.log(`[RemoteOK] Found ${jobs.length} matching jobs`);
  } catch (e) {
    console.error('[RemoteOK] Error:', e.message);
  }
  return jobs;
}

// ─── Source: Remotive API ───
async function fetchRemotive() {
  console.log('[Remotive] Fetching...');
  const jobs = [];
  try {
    const data = await fetchJSON('https://remotive.com/api/remote-jobs');
    const items = (data && data.jobs) ? data.jobs : [];
    for (const item of items) {
      const title = item.title || '';
      const titleLower = title.toLowerCase();
      const matches = ALL_KEYWORDS.some(kw => titleLower.includes(kw.toLowerCase()) || kw.toLowerCase().split(' ').every(w => titleLower.includes(w)));
      if (!matches) continue;
      jobs.push({
        title,
        company: item.company_name || 'Unknown',
        location: item.candidate_required_location || 'Remote',
        url: item.url || makeGoogleFallback(title, item.company_name),
        platform: 'Remotive',
        postedDate: item.publication_date ? new Date(item.publication_date).toISOString() : new Date().toISOString(),
        workMode: 'remote',
        country: detectCountry(item.candidate_required_location || 'Remote'),
        scrapedAt: new Date().toISOString()
      });
    }
    console.log(`[Remotive] Found ${jobs.length} matching jobs`);
  } catch (e) {
    console.error('[Remotive] Error:', e.message);
  }
  return jobs;
}

// ─── Source: Jooble API ───
async function fetchJooble() {
  console.log('[Jooble] Fetching...');
  const jobs = [];
  const JOOBLE_URL = 'https://jooble.org/api/3e6aabc5-5118-4e19-ae78-1a8956e1a5f0';

  for (const kw of ALL_KEYWORDS) {
    for (const loc of LOCATIONS) {
      if (loc.label === 'UAE Dubai' && !TOP5_KEYWORDS.includes(kw)) continue;
      try {
        const body = JSON.stringify({ keywords: kw, location: loc.query, page: 1 });
        const data = await fetchJSON(JOOBLE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body
        });
        const items = (data && data.jobs) ? data.jobs : [];
        for (const item of items) {
          jobs.push({
            title: item.title || kw,
            company: item.company || 'Unknown',
            location: item.location || loc.label,
            url: item.link || makeGoogleFallback(item.title || kw, item.company || ''),
            platform: 'Jooble',
            postedDate: item.updated ? new Date(item.updated).toISOString() : new Date().toISOString(),
            workMode: detectWorkMode(`${item.title} ${item.snippet} ${item.location}`),
            country: detectCountry(item.location || loc.label) || loc.label,
            scrapedAt: new Date().toISOString()
          });
        }
        await sleep(500);
      } catch (e) {
        console.error(`[Jooble] Error for "${kw}" in ${loc.label}:`, e.message);
      }
    }
  }
  console.log(`[Jooble] Found ${jobs.length} total jobs`);
  return jobs;
}

// ─── Source: LinkedIn Public ───
async function fetchLinkedIn(browser) {
  console.log('[LinkedIn] Fetching...');
  const jobs = [];
  let page;
  try {
    page = await setupPage(browser);
    for (const kw of ALL_KEYWORDS) {
      for (const loc of LOCATIONS) {
        if (loc.label === 'UAE Dubai' && !TOP5_KEYWORDS.includes(kw)) continue;
        try {
          const url = `https://www.linkedin.com/jobs/search?keywords=${encodeURIComponent(kw)}&location=${encodeURIComponent(loc.query)}&trk=public_jobs_jobs-search-bar_search-submit&position=1&pageNum=0`;
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await sleep(2000 + Math.random() * 2000);

          // Scroll to load more
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await sleep(1500);

          const results = await page.evaluate(() => {
            const cards = document.querySelectorAll('.base-card, .job-search-card, .base-search-card');
            const out = [];
            cards.forEach(card => {
              const titleEl = card.querySelector('.base-search-card__title, h3, h4');
              const companyEl = card.querySelector('.base-search-card__subtitle, h4.base-search-card__subtitle, .hidden-nested-link');
              const locationEl = card.querySelector('.job-search-card__location, .base-search-card__metadata');
              const linkEl = card.querySelector('a');
              out.push({
                title: titleEl ? titleEl.textContent.trim() : '',
                company: companyEl ? companyEl.textContent.trim() : 'Unknown',
                location: locationEl ? locationEl.textContent.trim() : '',
                url: linkEl ? linkEl.href : ''
              });
            });
            return out;
          });

          for (const r of results) {
            if (!r.title) continue;
            jobs.push({
              title: r.title,
              company: r.company,
              location: r.location || loc.label,
              url: r.url || makeGoogleFallback(r.title, r.company),
              platform: 'LinkedIn',
              postedDate: new Date().toISOString(),
              workMode: detectWorkMode(`${r.title} ${r.location}`),
              country: detectCountry(r.location || loc.label) || loc.label,
              scrapedAt: new Date().toISOString()
            });
          }
          console.log(`[LinkedIn] "${kw}" in ${loc.label}: ${results.length} results`);
          await sleep(1000 + Math.random() * 2000);
        } catch (e) {
          console.error(`[LinkedIn] Error for "${kw}" in ${loc.label}:`, e.message);
        }
      }
    }
  } catch (e) {
    console.error('[LinkedIn] Fatal:', e.message);
  } finally {
    if (page) await page.close().catch(() => {});
  }
  console.log(`[LinkedIn] Total: ${jobs.length} jobs`);
  return jobs;
}

// ─── Source: Indeed ───
async function fetchIndeed(browser) {
  console.log('[Indeed] Fetching...');
  const jobs = [];
  let page;
  try {
    page = await setupPage(browser);
    for (const kw of ALL_KEYWORDS) {
      for (const loc of LOCATIONS) {
        if (loc.label === 'UAE Dubai' && !TOP5_KEYWORDS.includes(kw)) continue;
        try {
          const url = `https://www.indeed.com/jobs?q=${encodeURIComponent(kw)}&l=${encodeURIComponent(loc.indeedL)}`;
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await sleep(2000 + Math.random() * 2000);

          const results = await page.evaluate(() => {
            const cards = document.querySelectorAll('.job_seen_beacon, .jobsearch-ResultsList > li, .result, .tapItem');
            const out = [];
            cards.forEach(card => {
              const titleEl = card.querySelector('h2 a, h2 span, .jobTitle a, .jobTitle span');
              const companyEl = card.querySelector('[data-testid="company-name"], .companyName, .company');
              const locationEl = card.querySelector('[data-testid="text-location"], .companyLocation, .location');
              const linkEl = card.querySelector('h2 a, a.jcs-JobTitle');
              let href = linkEl ? linkEl.getAttribute('href') : '';
              if (href && !href.startsWith('http')) href = 'https://www.indeed.com' + href;
              out.push({
                title: titleEl ? titleEl.textContent.trim() : '',
                company: companyEl ? companyEl.textContent.trim() : 'Unknown',
                location: locationEl ? locationEl.textContent.trim() : '',
                url: href
              });
            });
            return out;
          });

          for (const r of results) {
            if (!r.title) continue;
            jobs.push({
              title: r.title,
              company: r.company,
              location: r.location || loc.label,
              url: r.url || makeGoogleFallback(r.title, r.company),
              platform: 'Indeed',
              postedDate: new Date().toISOString(),
              workMode: detectWorkMode(`${r.title} ${r.location}`),
              country: detectCountry(r.location || loc.label) || loc.label,
              scrapedAt: new Date().toISOString()
            });
          }
          console.log(`[Indeed] "${kw}" in ${loc.label}: ${results.length} results`);
          await sleep(1500 + Math.random() * 2000);
        } catch (e) {
          console.error(`[Indeed] Error for "${kw}" in ${loc.label}:`, e.message);
        }
      }
    }
  } catch (e) {
    console.error('[Indeed] Fatal:', e.message);
  } finally {
    if (page) await page.close().catch(() => {});
  }
  console.log(`[Indeed] Total: ${jobs.length} jobs`);
  return jobs;
}

// ─── Source: GulfTalent ───
async function fetchGulfTalent(browser) {
  console.log('[GulfTalent] Fetching...');
  const jobs = [];
  let page;
  try {
    page = await setupPage(browser);
    for (const kw of ALL_KEYWORDS) {
      for (const loc of LOCATIONS) {
        if (loc.label === 'UAE Dubai' && !TOP5_KEYWORDS.includes(kw)) continue;
        try {
          const url = `https://www.gulftalent.com/jobs/search?keywords=${encodeURIComponent(kw)}&country=${loc.gulfCountry}`;
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await sleep(2000 + Math.random() * 1500);

          const results = await page.evaluate(() => {
            const cards = document.querySelectorAll('.job-listing, .job-card, .listing-item, article, .search-result, tr[class*="job"], div[class*="job"]');
            const out = [];
            cards.forEach(card => {
              const titleEl = card.querySelector('h2 a, h3 a, .job-title a, a[class*="title"]');
              const companyEl = card.querySelector('.company-name, .employer, [class*="company"]');
              const locationEl = card.querySelector('.location, [class*="location"]');
              const linkEl = card.querySelector('a');
              let href = linkEl ? linkEl.getAttribute('href') : '';
              if (href && !href.startsWith('http')) href = 'https://www.gulftalent.com' + href;
              out.push({
                title: titleEl ? titleEl.textContent.trim() : (card.querySelector('a') ? card.querySelector('a').textContent.trim() : ''),
                company: companyEl ? companyEl.textContent.trim() : 'Unknown',
                location: locationEl ? locationEl.textContent.trim() : '',
                url: href
              });
            });
            return out.filter(j => j.title.length > 3);
          });

          for (const r of results) {
            if (!r.title) continue;
            jobs.push({
              title: r.title,
              company: r.company,
              location: r.location || loc.label,
              url: r.url || makeGoogleFallback(r.title, r.company),
              platform: 'GulfTalent',
              postedDate: new Date().toISOString(),
              workMode: detectWorkMode(`${r.title} ${r.location}`),
              country: detectCountry(r.location || loc.label) || loc.label,
              scrapedAt: new Date().toISOString()
            });
          }
          console.log(`[GulfTalent] "${kw}" in ${loc.label}: ${results.length} results`);
          await sleep(1000 + Math.random() * 1500);
        } catch (e) {
          console.error(`[GulfTalent] Error for "${kw}" in ${loc.label}:`, e.message);
        }
      }
    }
  } catch (e) {
    console.error('[GulfTalent] Fatal:', e.message);
  } finally {
    if (page) await page.close().catch(() => {});
  }
  console.log(`[GulfTalent] Total: ${jobs.length} jobs`);
  return jobs;
}

// ═══════════════════════════════════════════════════════
// ─── Email Jobs Scraping Sources ───
// ═══════════════════════════════════════════════════════

const EMAIL_SEARCH_QUERIES_EN = [
  '"send your CV to" OR "send resume to" OR "email your CV"',
  '"apply by email" OR "submit your CV" OR "forward your resume"',
];

const EMAIL_SEARCH_QUERIES_AR = [
  '"ارسل السيرة الذاتية" OR "ارسال السي في" OR "يرجى ارسال"',
  '"مطلوب" AND "ايميل" OR "البريد الالكتروني"',
];

const EMAIL_SEARCH_LOCATIONS = ['Saudi Arabia', 'UAE', 'Dubai', 'Qatar'];

// ─── Source: Google Search for Email Jobs ───
async function fetchGoogleEmailJobs(browser) {
  console.log('[EmailJobs-Google] Fetching...');
  const jobs = [];
  let page;
  try {
    page = await setupPage(browser);

    const allQueries = [];
    for (const q of [...EMAIL_SEARCH_QUERIES_EN, ...EMAIL_SEARCH_QUERIES_AR]) {
      for (const loc of EMAIL_SEARCH_LOCATIONS) {
        for (const kw of TOP5_KEYWORDS) {
          allQueries.push(`${kw} ${loc} ${q}`);
        }
      }
    }

    // Limit to avoid rate limiting — pick a subset
    const queries = allQueries.slice(0, 20);

    for (const query of queries) {
      try {
        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=10`;
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(2000 + Math.random() * 3000);

        const results = await page.evaluate(() => {
          const items = document.querySelectorAll('.g, .tF2Cxc');
          const out = [];
          items.forEach(item => {
            const titleEl = item.querySelector('h3');
            const snippetEl = item.querySelector('.VwiC3b, .IsZvec, .s3v9rd');
            const linkEl = item.querySelector('a[href]');
            out.push({
              title: titleEl ? titleEl.textContent.trim() : '',
              snippet: snippetEl ? snippetEl.textContent.trim() : '',
              url: linkEl ? linkEl.href : ''
            });
          });
          return out;
        });

        for (const r of results) {
          const fullText = `${r.title} ${r.snippet}`;
          const emails = extractEmails(fullText);
          if (emails.length === 0) continue;

          for (const email of emails) {
            jobs.push({
              title: r.title || extractJobTitleFromText(fullText),
              company: extractCompanyFromText(fullText),
              email,
              location: EMAIL_SEARCH_LOCATIONS.find(loc => fullText.toLowerCase().includes(loc.toLowerCase())) || '',
              url: r.url || '',
              source: 'Google',
              country: detectCountry(fullText),
              postedDate: new Date().toISOString(),
              scrapedAt: new Date().toISOString()
            });
          }
        }

        console.log(`[EmailJobs-Google] Query done, total so far: ${jobs.length}`);
        await sleep(3000 + Math.random() * 4000); // Be gentle with Google
      } catch (e) {
        console.error(`[EmailJobs-Google] Query error:`, e.message);
      }
    }
  } catch (e) {
    console.error('[EmailJobs-Google] Fatal:', e.message);
  } finally {
    if (page) await page.close().catch(() => {});
  }
  console.log(`[EmailJobs-Google] Total: ${jobs.length} email jobs`);
  return jobs;
}

// ─── Source: Twitter/X Search for Email Jobs ───
async function fetchTwitterEmailJobs(browser) {
  console.log('[EmailJobs-Twitter] Fetching...');
  const jobs = [];
  let page;
  try {
    page = await setupPage(browser);

    const twitterQueries = [
      'hiring "send CV" OR "send resume" Saudi OR UAE OR Dubai OR Qatar',
      'مطلوب "ارسل السيرة" OR "ايميل" توظيف',
      '"send your CV to" hiring OR job OR vacancy',
      'وظيفة "ارسال السي في" OR "البريد"',
    ];

    for (const query of twitterQueries) {
      try {
        // Use Twitter search via Nitter or direct Twitter search
        const searchUrl = `https://twitter.com/search?q=${encodeURIComponent(query)}&f=live`;
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(3000 + Math.random() * 2000);

        // Scroll to load tweets
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await sleep(2000);

        const tweets = await page.evaluate(() => {
          const tweetEls = document.querySelectorAll('[data-testid="tweetText"], article [lang]');
          const out = [];
          tweetEls.forEach(el => {
            out.push(el.textContent.trim());
          });
          return out;
        });

        for (const tweetText of tweets) {
          const emails = extractEmails(tweetText);
          if (emails.length === 0) continue;

          for (const email of emails) {
            jobs.push({
              title: extractJobTitleFromText(tweetText),
              company: extractCompanyFromText(tweetText),
              email,
              location: detectCountry(tweetText) || '',
              url: '',
              source: 'Twitter',
              country: detectCountry(tweetText),
              postedDate: new Date().toISOString(),
              scrapedAt: new Date().toISOString()
            });
          }
        }

        console.log(`[EmailJobs-Twitter] Query done, total so far: ${jobs.length}`);
        await sleep(3000 + Math.random() * 3000);
      } catch (e) {
        console.error(`[EmailJobs-Twitter] Query error:`, e.message);
      }
    }
  } catch (e) {
    console.error('[EmailJobs-Twitter] Fatal:', e.message);
  } finally {
    if (page) await page.close().catch(() => {});
  }
  console.log(`[EmailJobs-Twitter] Total: ${jobs.length} email jobs`);
  return jobs;
}

// ─── Source: Bayt.com Email Jobs ───
async function fetchBaytEmailJobs(browser) {
  console.log('[EmailJobs-Bayt] Fetching...');
  const jobs = [];
  let page;
  try {
    page = await setupPage(browser);

    for (const kw of TOP5_KEYWORDS) {
      try {
        const url = `https://www.bayt.com/en/international/jobs/${encodeURIComponent(kw.toLowerCase().replace(/\s+/g, '-'))}-jobs/`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(2000 + Math.random() * 2000);

        const results = await page.evaluate(() => {
          const cards = document.querySelectorAll('[class*="job"], .card, li[class*="has-icon"]');
          const out = [];
          cards.forEach(card => {
            const titleEl = card.querySelector('h2 a, h3 a, [class*="title"] a');
            const companyEl = card.querySelector('[class*="company"], [class*="info"]');
            const locationEl = card.querySelector('[class*="location"]');
            const linkEl = card.querySelector('a');
            let href = linkEl ? linkEl.getAttribute('href') : '';
            if (href && !href.startsWith('http')) href = 'https://www.bayt.com' + href;
            const text = card.textContent || '';
            out.push({
              title: titleEl ? titleEl.textContent.trim() : '',
              company: companyEl ? companyEl.textContent.trim() : '',
              location: locationEl ? locationEl.textContent.trim() : '',
              url: href,
              text
            });
          });
          return out;
        });

        // Visit individual job pages to find email addresses
        for (const r of results.slice(0, 5)) {
          if (!r.url) continue;
          try {
            await page.goto(r.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await sleep(1500);
            const pageText = await page.evaluate(() => document.body.innerText);
            const emails = extractEmails(pageText);
            if (emails.length === 0) continue;

            for (const email of emails) {
              jobs.push({
                title: r.title || extractJobTitleFromText(pageText),
                company: r.company || extractCompanyFromText(pageText),
                email,
                location: r.location || '',
                url: r.url,
                source: 'Bayt',
                country: detectCountry(r.location || pageText),
                postedDate: new Date().toISOString(),
                scrapedAt: new Date().toISOString()
              });
            }
          } catch (e) {
            // Skip individual page errors
          }
        }

        console.log(`[EmailJobs-Bayt] "${kw}": ${jobs.length} total so far`);
        await sleep(2000 + Math.random() * 2000);
      } catch (e) {
        console.error(`[EmailJobs-Bayt] Error for "${kw}":`, e.message);
      }
    }
  } catch (e) {
    console.error('[EmailJobs-Bayt] Fatal:', e.message);
  } finally {
    if (page) await page.close().catch(() => {});
  }
  console.log(`[EmailJobs-Bayt] Total: ${jobs.length} email jobs`);
  return jobs;
}

// ─── Email Jobs Scan Orchestrator ───
async function runEmailJobsScan() {
  if (emailScanning) {
    console.log('[EmailScan] Already running, skipping...');
    return;
  }
  emailScanning = true;
  console.log('[EmailScan] ═══════════════════════════════════════');
  console.log('[EmailScan] Email jobs scan started at', new Date().toISOString());

  let allEmailJobs = loadEmailJobs();
  let browser = null;

  try {
    browser = await launchBrowser();
    console.log('[EmailScan] Browser launched');

    // Source 1: Google
    const googleJobs = await fetchGoogleEmailJobs(browser);
    allEmailJobs = deduplicateEmailJobs([...googleJobs, ...allEmailJobs]);
    saveEmailJobs(allEmailJobs);

    // Source 2: Twitter
    const twitterJobs = await fetchTwitterEmailJobs(browser);
    allEmailJobs = deduplicateEmailJobs([...twitterJobs, ...allEmailJobs]);
    saveEmailJobs(allEmailJobs);

    // Source 3: Bayt
    const baytJobs = await fetchBaytEmailJobs(browser);
    allEmailJobs = deduplicateEmailJobs([...baytJobs, ...allEmailJobs]);
    saveEmailJobs(allEmailJobs);

    console.log(`[EmailScan] Total: ${allEmailJobs.length} email jobs saved`);
  } catch (e) {
    console.error('[EmailScan] Fatal error:', e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  emailScanning = false;
  emailLastScan = new Date().toISOString();
  console.log('[EmailScan] Complete at', emailLastScan);
  console.log('[EmailScan] ═══════════════════════════════════════');
}

// ─── Deep Scan Orchestrator ───
async function runDeepScan() {
  if (scanning) {
    console.log('[Scan] Already running, skipping...');
    return;
  }
  scanning = true;
  console.log('[Scan] ═══════════════════════════════════════');
  console.log('[Scan] Deep scan started at', new Date().toISOString());

  let allJobs = loadJobs();
  let browser = null;

  try {
    // Phase 1: APIs (fast, no browser needed)
    console.log('[Scan] Phase 1: API sources...');
    const [remoteokJobs, remotiveJobs, joobleJobs] = await Promise.all([
      fetchRemoteOK(),
      fetchRemotive(),
      fetchJooble()
    ]);

    allJobs = deduplicateJobs([...remoteokJobs, ...remotiveJobs, ...joobleJobs, ...allJobs]);
    saveJobs(allJobs);
    console.log(`[Scan] Phase 1 done — ${allJobs.length} jobs saved`);

    // Phase 2: Browser scraping
    console.log('[Scan] Phase 2: Browser sources...');
    try {
      browser = await launchBrowser();
      console.log('[Scan] Browser launched');

      const linkedinJobs = await fetchLinkedIn(browser);
      allJobs = deduplicateJobs([...linkedinJobs, ...allJobs]);
      saveJobs(allJobs);

      const indeedJobs = await fetchIndeed(browser);
      allJobs = deduplicateJobs([...indeedJobs, ...allJobs]);
      saveJobs(allJobs);

      const gulfJobs = await fetchGulfTalent(browser);
      allJobs = deduplicateJobs([...gulfJobs, ...allJobs]);
      saveJobs(allJobs);
    } catch (browserError) {
      console.error('[Scan] Browser phase error:', browserError.message);
    } finally {
      if (browser) await browser.close().catch(() => {});
    }

    console.log(`[Scan] Phase 2 done — ${allJobs.length} total jobs`);
  } catch (e) {
    console.error('[Scan] Fatal error:', e.message);
  }

  scanning = false;
  lastScan = new Date().toISOString();
  console.log('[Scan] Complete at', lastScan);
  console.log('[Scan] ═══════════════════════════════════════');
}

// ─── Routes ───

// Serve the HTML dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Jobs API with filters
app.get('/api/jobs', (req, res) => {
  let jobs = loadJobs();
  const { q, platform, country, city, workMode, date } = req.query;

  if (q) {
    const search = q.toLowerCase();
    jobs = jobs.filter(j =>
      (j.title || '').toLowerCase().includes(search) ||
      (j.company || '').toLowerCase().includes(search)
    );
  }

  if (platform && platform !== 'all') {
    jobs = jobs.filter(j => (j.platform || '').toLowerCase() === platform.toLowerCase());
  }

  if (country && country !== 'all') {
    const c = country.toLowerCase();
    jobs = jobs.filter(j =>
      (j.country || '').toLowerCase().includes(c) ||
      (j.location || '').toLowerCase().includes(c)
    );
  }

  if (city) {
    const ct = city.toLowerCase();
    jobs = jobs.filter(j => (j.location || '').toLowerCase().includes(ct));
  }

  if (workMode && workMode !== 'all') {
    jobs = jobs.filter(j => (j.workMode || '') === workMode);
  }

  if (date) {
    const days = parseInt(date, 10);
    if (!isNaN(days)) {
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      jobs = jobs.filter(j => new Date(j.postedDate || j.scrapedAt) >= cutoff);
    }
  }

  res.json({ total: jobs.length, jobs });
});

// Stats
app.get('/api/stats', (req, res) => {
  const jobs = loadJobs();
  const byPlatform = {};
  for (const j of jobs) {
    const p = j.platform || 'Unknown';
    byPlatform[p] = (byPlatform[p] || 0) + 1;
  }
  res.json({
    total: jobs.length,
    platforms: Object.keys(byPlatform).length,
    byPlatform,
    lastScan
  });
});

// Status
app.get('/api/status', (req, res) => {
  const jobs = loadJobs();
  res.json({
    scanning,
    lastScan,
    totalJobs: jobs.length
  });
});

// Manual scan trigger
app.post('/api/scan', (req, res) => {
  if (scanning) {
    return res.json({ message: 'Scan already in progress' });
  }
  res.json({ message: 'Scan started' });
  runDeepScan();
});

// ═══════════════════════════════════════
// ─── Email Jobs Routes ───
// ═══════════════════════════════════════

// Serve email jobs page
app.get('/email-jobs', (req, res) => {
  res.sendFile(path.join(__dirname, 'email-jobs.html'));
});

// Email Jobs API with filters
app.get('/api/email-jobs', (req, res) => {
  let jobs = loadEmailJobs();
  const { q, country, date } = req.query;

  if (q) {
    const search = q.toLowerCase();
    jobs = jobs.filter(j =>
      (j.title || '').toLowerCase().includes(search) ||
      (j.company || '').toLowerCase().includes(search) ||
      (j.email || '').toLowerCase().includes(search)
    );
  }

  if (country && country !== 'all') {
    const c = country.toLowerCase();
    jobs = jobs.filter(j =>
      (j.country || '').toLowerCase().includes(c) ||
      (j.location || '').toLowerCase().includes(c)
    );
  }

  if (date) {
    const days = parseInt(date, 10);
    if (!isNaN(days)) {
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      jobs = jobs.filter(j => new Date(j.postedDate || j.scrapedAt) >= cutoff);
    }
  }

  res.json({ total: jobs.length, jobs });
});

// Email Jobs Stats
app.get('/api/email-jobs/stats', (req, res) => {
  const jobs = loadEmailJobs();
  const bySource = {};
  for (const j of jobs) {
    const s = j.source || 'Unknown';
    bySource[s] = (bySource[s] || 0) + 1;
  }
  res.json({
    total: jobs.length,
    sources: Object.keys(bySource).length,
    bySource,
    lastScan: emailLastScan
  });
});

// Email Jobs Status
app.get('/api/email-jobs/status', (req, res) => {
  const jobs = loadEmailJobs();
  res.json({
    scanning: emailScanning,
    lastScan: emailLastScan,
    totalJobs: jobs.length
  });
});

// Email Jobs Manual Scan
app.post('/api/email-jobs/scan', (req, res) => {
  if (emailScanning) {
    return res.json({ message: 'Email scan already in progress' });
  }
  res.json({ message: 'Email scan started' });
  runEmailJobsScan();
});

// ─── Start ───
app.listen(PORT, () => {
  console.log(`[Server] وظيفة running on http://localhost:${PORT}`);
  console.log(`[Server] Initial scan in 30 seconds...`);

  // Initial scan after 30 seconds
  setTimeout(() => {
    runDeepScan();
  }, 30000);

  // Initial email jobs scan after 2 minutes
  setTimeout(() => {
    runEmailJobsScan();
  }, 120000);

  // Scheduled scan every 4 hours
  cron.schedule('0 */4 * * *', () => {
    console.log('[Cron] Scheduled scan triggered');
    runDeepScan();
  });

  // Scheduled email jobs scan every 6 hours (offset by 2 hours)
  cron.schedule('0 2,8,14,20 * * *', () => {
    console.log('[Cron] Scheduled email jobs scan triggered');
    runEmailJobsScan();
  });
});
