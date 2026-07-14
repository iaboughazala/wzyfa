/**
 * Sponsored posts — daily rotating jobs for Wasla / Finalizat / Rezolyzer.
 *
 * Each sponsor cycles through its positions list once per day (stable
 * rotation based on day-of-year, so a restart doesn't reshuffle).
 *
 * The scheduler picks today's variant via `getTodaySponsorJob(id)` and
 * hands it to the same post pipeline the scraped jobs use. Since sponsors
 * have no HR email, the formatter branches on `job.sponsor` to render the
 * "Apply Now" variant instead of the "Send your CV / Submit your CV" one.
 */

const SPONSORS = [
  {
    id: 'wasla',
    displayName: 'وصلة',
    website: 'wasla.ws',
    applyUrl: 'https://wasla.ws/careers',
    positions: [
      'مبيعات',
      'تطوير وبرمجة',
      'تصميم UI/UX',
      'تسويق رقمي',
      'كتابة محتوى',
      'إدارة منتج',
      'إدارة عمليات',
    ],
  },
  {
    id: 'finalizat',
    displayName: 'Finalizat',
    website: 'finalizat.com',
    applyUrl: 'https://finalizat.com/joinus/',
    positions: [
      'Manager',
      'Graphic Designer',
      'Motion Graphic',
      '3D Designer',
      'Translator',
    ],
  },
  {
    id: 'rezolyzer',
    displayName: 'Rezolyzer',
    website: 'rezolyzer.com',
    // null → apply through wzyfa's own /careers form; the sponsor branding
    // is what the post + preview card show.
    applyUrl: null,
    positions: [
      'Frontend Developer',
      'Backend Developer',
      'AI Engineer',
      'Product Manager',
      'UX Designer',
      'Marketing Specialist',
      'Talent Acquisition Specialist',
    ],
  },
];

// Day-of-year (1–366), UTC-based so the whole system agrees on "today".
function dayOfYearUtc(date = new Date()) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const now = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Math.floor((now - start) / 86_400_000);
}

function getSponsor(id) {
  return SPONSORS.find(s => s.id === id) || null;
}

function listSponsors() {
  return SPONSORS.map(s => ({ id: s.id, displayName: s.displayName }));
}

// Returns a synthetic "job" the poster + /careers page can render.
// The id encodes sponsor + position index so the wzyfa form can look it up.
function getTodaySponsorJob(id, date = new Date()) {
  const sponsor = getSponsor(id);
  if (!sponsor) return null;
  const idx = dayOfYearUtc(date) % sponsor.positions.length;
  return sponsorJob(sponsor, idx);
}

function sponsorJob(sponsor, idx) {
  const position = sponsor.positions[idx];
  const applyUrl = sponsor.applyUrl || null; // null → wzyfa /careers form
  return {
    id: `sponsor-${sponsor.id}-${idx}`,
    sponsor: sponsor.id,
    title: position,
    company: sponsor.displayName,
    website: sponsor.website,
    applyUrl,
  };
}

// Resolve a "sponsor-<id>-<idx>" jobId back to a job. Used by
// /api/careers/job/:id and the /careers OG builder when someone clicks
// the CTA link on a sponsor post.
function findSponsorJobById(jobId) {
  if (!jobId || !jobId.startsWith('sponsor-')) return null;
  const rest = jobId.slice('sponsor-'.length);
  // Last "-" separates sponsor id from the numeric index.
  const dash = rest.lastIndexOf('-');
  if (dash < 0) return null;
  const sponsorId = rest.slice(0, dash);
  const idx = Number(rest.slice(dash + 1));
  const sponsor = getSponsor(sponsorId);
  if (!sponsor || !Number.isInteger(idx) || idx < 0 || idx >= sponsor.positions.length) return null;
  return sponsorJob(sponsor, idx);
}

module.exports = {
  SPONSORS,
  listSponsors,
  getSponsor,
  getTodaySponsorJob,
  findSponsorJobById,
};
