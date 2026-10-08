import 'dotenv/config';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';

const {
  ROLLER_EMAIL,
  ROLLER_PASSWORD,
  ROLLER_BASE_URL = 'https://manage.roller.app',
  SUPABASE_URL,
  SUPABASE_SECRET_KEY,
  TARGET_SIGNED_WAIVER_ID = '',
  HEADLESS = 'true',
  POLL_INTERVAL_MS = '60000',
  KEEP_BROWSER_OPEN_ON_FAIL = 'false',
  RETRY_ALERT_THRESHOLD = '5',
  STALE_QUEUE_MINUTES = '30',
  DEBUG_SCREENSHOTS = 'false',
  ROW_TIMEOUT_MINUTES = '6',
} = process.env;

if (!ROLLER_EMAIL || !ROLLER_PASSWORD || !SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  throw new Error('Missing required environment variables.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

const HEADLESS_BOOL = String(HEADLESS).toLowerCase() !== 'false';
const KEEP_BROWSER_OPEN_ON_FAIL_BOOL =
  String(KEEP_BROWSER_OPEN_ON_FAIL).toLowerCase() === 'true';
const POLL_MS = Number(POLL_INTERVAL_MS) || 60000;
const ALERT_THRESHOLD = Number(RETRY_ALERT_THRESHOLD) || 5;
const STALE_QUEUE_MS = (Number(STALE_QUEUE_MINUTES) || 30) * 60 * 1000;
const DEBUG_SCREENSHOTS_BOOL = String(DEBUG_SCREENSHOTS).toLowerCase() === 'true';
const ROW_TIMEOUT_MS = (Number(ROW_TIMEOUT_MINUTES) || 6) * 60 * 1000;

// v2 (8 Oct 2026): keep Chromium inside the 512 MB Render plan.
// One renderer process for all frames, no /dev/shm, no GPU, no extras.
const CHROMIUM_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-zygote',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-sync',
  '--mute-audio',
  '--no-first-run',
  '--disable-site-isolation-trials',
  '--disable-features=site-per-process,IsolateOrigins,Translate,MediaRouter,OptimizationHints',
  '--renderer-process-limit=1',
  '--js-flags=--max-old-space-size=256',
];

// Third-party widgets on the Roller back office that the worker never needs.
const BLOCKED_HOST_PATTERNS = [
  /(^|\.)announcekit\.app$/i,
  /(^|\.)my\.site\.com$/i,
  /(^|\.)salesforce\.com$/i,
  /(^|\.)salesforceliveagent\.com$/i,
  /(^|\.)force\.com$/i,
  /(^|\.)google-analytics\.com$/i,
  /(^|\.)googletagmanager\.com$/i,
  /(^|\.)doubleclick\.net$/i,
  /(^|\.)hotjar\.com$/i,
  /(^|\.)intercom\.io$/i,
  /(^|\.)intercomcdn\.com$/i,
  /(^|\.)segment\.(io|com)$/i,
  /(^|\.)fullstory\.com$/i,
  /(^|\.)pendo\.io$/i,
  /(^|\.)clarity\.ms$/i,
  /(^|\.)facebook\.(net|com)$/i,
  /(^|\.)nr-data\.net$/i,
  /(^|\.)newrelic\.com$/i,
  /(^|\.)datadoghq\.(com|eu)$/i,
  /(^|\.)sentry\.io$/i,
  /(^|\.)launchdarkly\.com$/i,
  /(^|\.)zdassets\.com$/i,
  /(^|\.)zendesk\.com$/i,
];
const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font']);

function isBlockedRequest(request) {
  try {
    if (BLOCKED_RESOURCE_TYPES.has(request.resourceType())) return true;
    const host = new URL(request.url()).hostname;
    return BLOCKED_HOST_PATTERNS.some((re) => re.test(host));
  } catch {
    return false;
  }
}

function isRollerFrameUrl(url) {
  try {
    const host = new URL(url).hostname;
    return /(^|\.)roller\.app$/i.test(host);
  } catch {
    return false;
  }
}

function isRollerLoginUrl(url) {
  return /\/u\/login|\/login|my\.roller\.app\/u\//i.test(url || '');
}

async function debugShot(page, path) {
  if (!DEBUG_SCREENSHOTS_BOOL) return;
  await page.screenshot({ path, fullPage: false }).catch(() => {});
}

function memMb() {
  const m = process.memoryUsage();
  return `node rss ${Math.round(m.rss / 1048576)} MB`;
}

const MONTHS = {
  january: '01',
  february: '02',
  march: '03',
  april: '04',
  may: '05',
  june: '06',
  july: '07',
  august: '08',
  september: '09',
  october: '10',
  november: '11',
  december: '12',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value) {
  return (value || '').trim().toLowerCase();
}

function toIsoDateOnly(value) {
  if (!value) return null;

  const s = String(value).trim();

  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    return s.slice(0, 10);
  }

  return parseHumanDate(s);
}

function parseHumanDate(value) {
  if (!value) return null;

  const s = String(value).trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return s;
  }

  const m1 = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (m1) {
    const day = String(Number(m1[1])).padStart(2, '0');
    const monthName = m1[2].toLowerCase();
    const year = m1[3];
    const month = MONTHS[monthName];
    if (month) return `${year}-${month}-${day}`;
  }

  const m2 = s.match(/^(\d{4}-\d{2}-\d{2})[T\s]/);
  if (m2) {
    return m2[1];
  }

  return null;
}

function buildBucketPath(externalSignedWaiverId) {
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `roller/raw/${year}/${month}/${externalSignedWaiverId}.pdf`;
}

function getNextRetryAt(retryCount) {
  const minutes = [5, 15, 60, 240, 720, 1440];
  const index = Math.min(Math.max(retryCount, 1) - 1, minutes.length - 1);
  return new Date(Date.now() + minutes[index] * 60 * 1000).toISOString();
}

function isQueuedRowStale(row) {
  if (row.download_status !== 'queued') return false;
  if (!row.last_attempt_at) return true;
  const ageMs = Date.now() - new Date(row.last_attempt_at).getTime();
  return ageMs >= STALE_QUEUE_MS;
}

function isRowDue(row) {
  if (row.download_status === 'not_attempted') return true;

  if (row.download_status === 'failed') {
    if (!row.next_retry_at) return true;
    return new Date(row.next_retry_at).getTime() <= Date.now();
  }

  if (row.download_status === 'queued') {
    return isQueuedRowStale(row);
  }

  return false;
}

async function gotoWithRetry(page, url, attempts = 3) {
  let lastError = null;

  for (let i = 1; i <= attempts; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(1000);

      const current = page.url();
      if (current.startsWith('chrome-error://')) {
        throw new Error(`Browser navigation failed with ${current}`);
      }

      return;
    } catch (err) {
      lastError = err;
      if (i < attempts) {
        await page.waitForTimeout(2000);
      }
    }
  }

  throw lastError;
}

async function updateRawRow(externalSignedWaiverId, patch) {
  const { error } = await supabase
    .from('roller_waiver_raw')
    .update({
      ...patch,
      last_seen_at: new Date().toISOString(),
    })
    .eq('source_system', 'roller')
    .eq('external_signed_waiver_id', externalSignedWaiverId);

  if (error) throw error;
}

async function getRawRowBySignedWaiverId(externalSignedWaiverId) {
  const { data, error } = await supabase
    .from('roller_waiver_raw')
    .select('*')
    .eq('source_system', 'roller')
    .eq('external_signed_waiver_id', externalSignedWaiverId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function getSpecificRow() {
  return getRawRowBySignedWaiverId(TARGET_SIGNED_WAIVER_ID);
}

async function listCandidateRows(limit = 100) {
  const { data, error } = await supabase
    .from('roller_waiver_raw')
    .select('*')
    .eq('source_system', 'roller')
    .in('download_status', ['not_attempted', 'failed', 'queued'])
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

async function claimRow(row) {
  const patch = {
    download_status: 'queued',
    last_error: null,
    last_attempt_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('roller_waiver_raw')
    .update(patch)
    .eq('id', row.id)
    .eq('download_status', row.download_status)
    .select('*')
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function claimNextDueRow() {
  const rows = await listCandidateRows(100);
  const dueRows = rows.filter(isRowDue);

  for (const row of dueRows) {
    const claimed = await claimRow(row);
    if (claimed) return claimed;
  }

  return null;
}

async function uploadPdfToBucket(externalSignedWaiverId, pdfBuffer) {
  const storagePath = buildBucketPath(externalSignedWaiverId);
  const fileName = storagePath.split('/').pop();

  const { error } = await supabase.storage
    .from('waivers')
    .upload(storagePath, pdfBuffer, {
      contentType: 'application/pdf',
      upsert: true,
    });

  if (error) throw error;

  return {
    pdf_bucket_name: 'waivers',
    pdf_storage_path: storagePath,
    pdf_file_name: fileName,
    pdf_downloaded_at: new Date().toISOString(),
    pdf_uploaded_at: new Date().toISOString(),
    scrape_status: 'pdf_uploaded',
    download_status: 'uploaded',
    retry_count: 0,
    next_retry_at: null,
    last_success_at: new Date().toISOString(),
    alert_sent: false,
    last_error: null,
  };
}

async function createFailureAlert(raw, err, retryCount) {
  const { error } = await supabase
    .from('roller_worker_alerts')
    .insert({
      external_signed_waiver_id: raw.external_signed_waiver_id,
      alert_type: 'max_retries_reached',
      message: `Waiver download failed after ${retryCount} attempts`,
      payload: {
        external_signed_waiver_id: raw.external_signed_waiver_id,
        external_waiver_id: raw.external_waiver_id,
        download_status: raw.download_status,
        scrape_status: raw.scrape_status,
        retry_count: retryCount,
        error: err.message,
      },
    });

  if (error) throw error;
}

async function createScrapeRun(raw) {
  try {
    const runScope = TARGET_SIGNED_WAIVER_ID
      ? 'waiver_detail'
      : 'pdf_backfill';

    const triggerType = TARGET_SIGNED_WAIVER_ID
      ? 'manual'
      : ((raw.retry_count || 0) > 0 ? 'retry' : 'scheduled');

    const { data, error } = await supabase
      .from('roller_scrape_runs')
      .insert({
        source_system: 'roller',
        trigger_type: triggerType,
        run_scope: runScope,
        status: 'running',
        runner_name: 'playwright-worker',
        started_at: new Date().toISOString(),
        total_rows_seen: 1,
        notes: `Processing signed waiver ${raw.external_signed_waiver_id}`,
        metadata: {
          external_signed_waiver_id: raw.external_signed_waiver_id,
          external_waiver_id: raw.external_waiver_id,
          holder_first_name: raw.holder_first_name,
          holder_last_name: raw.holder_last_name,
          retry_count: raw.retry_count || 0,
        },
      })
      .select('id')
      .maybeSingle();

    if (error) throw error;
    return data?.id || null;
  } catch (err) {
    console.warn('Scrape run create failed:', err.message);
    return null;
  }
}

async function updateScrapeRun(runId, patch) {
  if (!runId) return;

  try {
    const { error } = await supabase
      .from('roller_scrape_runs')
      .update({
        ...patch,
        finished_at: patch.finished_at || null,
      })
      .eq('id', runId);

    if (error) throw error;
  } catch (err) {
    console.warn('Scrape run update failed:', err.message);
  }
}

async function firstVisibleLocator(page, factories, timeout = 8000) {
  const end = Date.now() + timeout;

  while (Date.now() < end) {
    for (const factory of factories) {
      try {
        const locator = factory().first();
        if (await locator.isVisible()) {
          return locator;
        }
      } catch {
        // ignore
      }
    }
    await page.waitForTimeout(250);
  }

  return null;
}

async function waitForRollerToSettle(page, timeoutMs = 25000) {
  // The Roller back office first loads /waivers and only then sends a
  // logged-out browser to the login page. Wait until one of the two is clear.
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const url = page.url();
    if (isRollerLoginUrl(url)) return 'login';
    const legacyFrame = page.frames().find((f) => /\/legacy\/waivers/i.test(f.url()));
    if (url.includes('manage.roller.app') && legacyFrame) return 'app';
    await page.waitForTimeout(500);
  }
  return isRollerLoginUrl(page.url()) ? 'login' : 'unknown';
}

async function login(page) {
  await gotoWithRetry(page, `${ROLLER_BASE_URL}/waivers`, 3);

  const state = await waitForRollerToSettle(page);
  console.log(`Roller page state: ${state}`);
  if (state === 'app') {
    return;
  }

  const emailInput = await firstVisibleLocator(page, [
    () => page.locator('input[type="email"]'),
    () => page.locator('input[name="email"]'),
    () => page.locator('input[name="username"]'),
    () => page.locator('input#username'),
    () => page.locator('input[inputmode="email"]'),
  ], 10000);

  if (!emailInput) {
    await debugShot(page, 'debug-login-no-email.png');
    throw new Error(`Could not find email input. Current URL: ${page.url()}`);
  }

  await emailInput.fill(ROLLER_EMAIL);

  const passwordSamePage = await firstVisibleLocator(page, [
    () => page.locator('input[type="password"]'),
    () => page.locator('input[name="password"]'),
    () => page.locator('input#password'),
  ], 1500);

  const buttonLocator = async () =>
    firstVisibleLocator(page, [
      () => page.locator('button[type="submit"]'),
      () => page.getByRole('button', { name: /continue/i }),
      () => page.getByRole('button', { name: /log in/i }),
      () => page.getByRole('button', { name: /login/i }),
      () => page.locator('button[name="action"]'),
    ], 5000);

  if (passwordSamePage) {
    await passwordSamePage.fill(ROLLER_PASSWORD);

    const submitBtn = await buttonLocator();
    if (!submitBtn) {
      await debugShot(page, 'debug-login-no-submit.png');
      throw new Error('Could not find submit button.');
    }

    await Promise.all([
      page.waitForLoadState('networkidle').catch(() => {}),
      submitBtn.click(),
    ]);
  } else {
    const continueBtn = await buttonLocator();
    if (!continueBtn) {
      await debugShot(page, 'debug-login-no-continue.png');
      throw new Error('Could not find Continue button after email.');
    }

    await Promise.all([
      page.waitForLoadState('networkidle').catch(() => {}),
      continueBtn.click(),
    ]);

    const passwordInput = await firstVisibleLocator(page, [
      () => page.locator('input[type="password"]'),
      () => page.locator('input[name="password"]'),
      () => page.locator('input#password'),
    ], 10000);

    if (!passwordInput) {
      await debugShot(page, 'debug-login-no-password.png');
      throw new Error(`Could not find password input after Continue. Current URL: ${page.url()}`);
    }

    await passwordInput.fill(ROLLER_PASSWORD);

    const submitBtn = await buttonLocator();
    if (!submitBtn) {
      await debugShot(page, 'debug-login-no-final-submit.png');
      throw new Error('Could not find final submit button.');
    }

    await Promise.all([
      page.waitForLoadState('networkidle').catch(() => {}),
      submitBtn.click(),
    ]);
  }

  await page.waitForTimeout(3000);

  if (!page.url().includes('manage.roller.app') || isRollerLoginUrl(page.url())) {
    await debugShot(page, 'debug-login-failed.png');
    throw new Error('Login failed: still on the Roller login page after submitting.');
  }
  console.log('Logged in to Roller.');
}

async function openWaiverHolders(page) {
  await gotoWithRetry(page, `${ROLLER_BASE_URL}/waivers`, 3);
  await page.waitForTimeout(3000);
}

async function allFrames(page) {
  return page.frames().filter((f) => isRollerFrameUrl(f.url()));
}

async function findWaiverSearchInput(page) {
  const frames = await allFrames(page);

  console.log(`Roller frames on page: ${frames.length}`);

  for (const frame of frames) {
    const exact = await (async () => {
      const candidates = [
        () => frame.getByPlaceholder(/search waivers/i),
        () => frame.locator('input[placeholder="Search waivers..."]'),
        () => frame.locator('input[placeholder*="Search waivers"]'),
        () => frame.locator('input[placeholder*="waiver" i]'),
        () => frame.locator('input[placeholder*="search" i]'),
        () => frame.locator('input[type="search"]'),
      ];

      for (const factory of candidates) {
        try {
          const loc = factory().first();
          if (await loc.isVisible()) return { frame, locator: loc };
        } catch {
          // ignore
        }
      }
      return null;
    })();

    if (exact) {
      console.log('Found waiver search input.');
      return exact.locator;
    }
  }

  let best = null;
  let bestScore = -Infinity;

  for (const frame of frames) {
    const inputs = frame.locator('input');
    let count = 0;

    try {
      count = await inputs.count();
    } catch {
      continue;
    }

    for (let i = 0; i < count; i++) {
      const locator = inputs.nth(i);

      try {
        if (!(await locator.isVisible())) continue;

        const box = await locator.boundingBox();
        if (!box) continue;

        const placeholder = ((await locator.getAttribute('placeholder')) || '').toLowerCase();
        const aria = ((await locator.getAttribute('aria-label')) || '').toLowerCase();
        const cls = ((await locator.getAttribute('class')) || '').toLowerCase();
        const type = ((await locator.getAttribute('type')) || '').toLowerCase();

        const meta = `${placeholder} ${aria} ${cls} ${type}`;

        let score = 0;
        if (meta.includes('waiver')) score += 200;
        if (meta.includes('search')) score += 120;
        if (box.x > 150 && box.x < 700) score += 50;
        if (box.y > 100 && box.y < 320) score += 70;
        if (box.width > 220) score += 30;
        if (box.x < 150) score -= 150;
        if (box.width < 180) score -= 40;

        if (score > bestScore) {
          bestScore = score;
          best = { frame, locator, meta, box, score };
        }
      } catch {
        // ignore
      }
    }
  }

  if (best) {
    console.log('Best search candidate score:', best.score);
    return best.locator;
  }

  return null;
}

async function searchWaivers(page, searchValue) {
  const searchInput = await findWaiverSearchInput(page);

  if (!searchInput) {
    await debugShot(page, 'debug-no-search-input.png');
    throw new Error('Could not find waiver search input.');
  }

  await searchInput.scrollIntoViewIfNeeded().catch(() => {});
  await searchInput.click({ clickCount: 3, force: true }).catch(() => {});
  await page.waitForTimeout(300);

  try {
    await searchInput.fill('');
  } catch {
    // ignore
  }

  await page.keyboard.press('Meta+A').catch(() => {});
  await page.keyboard.press('Backspace').catch(() => {});
  await page.waitForTimeout(200);

  try {
    await searchInput.fill(searchValue);
  } catch {
    await searchInput.focus().catch(() => {});
    await page.keyboard.type(searchValue, { delay: 40 });
  }

  await page.waitForTimeout(500);
  await searchInput.press('Enter').catch(() => {});
  await page.waitForTimeout(2500);

  await debugShot(page, 'debug-after-search.png');
}

async function findTableFrame(page) {
  const frames = await allFrames(page);

  let bestFrame = null;
  let bestCount = -1;

  for (const frame of frames) {
    try {
      const rows = frame.locator('table tbody tr');
      const count = await rows.count();
      if (count > bestCount) {
        bestCount = count;
        bestFrame = frame;
      }
    } catch {
      // ignore
    }
  }

  return bestFrame;
}

async function readVisibleTableRows(page) {
  const frame = await findTableFrame(page);

  if (!frame) {
    await debugShot(page, 'debug-no-table-frame.png');
    return [];
  }

  const rows = frame.locator('table tbody tr');
  const count = await rows.count();
  const output = [];

  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const cells = row.locator('td');
    const cellCount = await cells.count();
    if (cellCount < 6) continue;

    const nameText = (await cells.nth(0).innerText()).trim();
    const signedByText = (await cells.nth(1).innerText()).trim();
    const dobText = (await cells.nth(2).innerText()).trim();
    const signedText = (await cells.nth(3).innerText()).trim();
    const expiresText = (await cells.nth(4).innerText()).trim();
    const waiverIdText = (await cells.nth(5).innerText()).trim();

    if (
      !nameText ||
      normalizeText(nameText) === 'name' ||
      normalizeText(waiverIdText) === 'waiver id'
    ) {
      continue;
    }

    const parts = nameText.split(/\s+/);
    const firstName = parts[0] || '';
    const lastName = parts.slice(1).join(' ') || '';

    output.push({
      row,
      nameText,
      signedByText,
      firstName,
      lastName,
      dob: parseHumanDate(dobText),
      signedDate: parseHumanDate(signedText),
      expiresDate: parseHumanDate(expiresText),
      waiverId: waiverIdText,
    });
  }

  return output;
}

function isExactCandidateMatch(candidate, raw) {
  const rawSignedDate = toIsoDateOnly(raw.signed_at);

  const firstNameMatch =
    normalizeText(candidate.firstName) === normalizeText(raw.holder_first_name);

  const lastNameMatch =
    normalizeText(candidate.lastName) === normalizeText(raw.holder_last_name);

  const dobMatch =
    !!candidate.dob &&
    !!raw.holder_date_of_birth &&
    candidate.dob === raw.holder_date_of_birth;

  const waiverMatch =
    !!candidate.waiverId &&
    !!raw.external_waiver_id &&
    String(candidate.waiverId) === String(raw.external_waiver_id);

  const signedDateMatch =
    !!candidate.signedDate &&
    !!rawSignedDate &&
    candidate.signedDate === rawSignedDate;

  return {
    firstNameMatch,
    lastNameMatch,
    dobMatch,
    waiverMatch,
    signedDateMatch,
    exact:
      firstNameMatch &&
      lastNameMatch &&
      dobMatch &&
      waiverMatch &&
      signedDateMatch,
  };
}

async function chooseBestCandidate(page, raw) {
  const candidates = await readVisibleTableRows(page);

  console.log(`Target ${raw.external_signed_waiver_id} (waiver ${raw.external_waiver_id}); rows read: ${candidates.length}`);

  if (!candidates.length) {
    await debugShot(page, 'debug-no-candidates.png');
    return null;
  }

  const exactMatches = [];

  for (const candidate of candidates) {
    const check = isExactCandidateMatch(candidate, raw);

    console.log('Candidate check:', {
      waiverId: candidate.waiverId,
      first: check.firstNameMatch,
      last: check.lastNameMatch,
      dob: check.dobMatch,
      waiver: check.waiverMatch,
      signedDate: check.signedDateMatch,
    });

    if (check.exact) {
      exactMatches.push({
        ...candidate,
        matchDetails: check,
      });
    }
  }

  if (exactMatches.length === 1) {
    console.log('Found exactly one strict match.');
    return exactMatches[0];
  }

  if (exactMatches.length > 1) {
    await debugShot(page, 'debug-multiple-exact-matches.png');
    throw new Error('Multiple exact waiver matches found. Manual review needed.');
  }

  await debugShot(page, 'debug-no-exact-match.png');
  return null;
}

async function clickRowAndCapturePdf(context, candidate, raw) {
  let pdfBuffer = null;

  const responseHandler = async (response) => {
    try {
      const contentType = response.headers()['content-type'] || '';
      if (contentType.includes('application/pdf')) {
        pdfBuffer = await response.body();
      }
    } catch {
      // ignore
    }
  };

  context.on('response', responseHandler);

  let popup = null;
  try {
    const popupPromise = context.waitForEvent('page', { timeout: 8000 }).catch(() => null);

    await candidate.row.click();
    popup = await popupPromise;

    if (popup) {
      await popup.waitForLoadState('domcontentloaded').catch(() => {});
      await popup.waitForTimeout(4000);
      await debugShot(popup, 'debug-pdf-popup.png');
    } else {
      await candidate.row.page().waitForTimeout(4000);
    }

    if (pdfBuffer) {
      await updateRawRow(raw.external_signed_waiver_id, {
        scrape_status: 'pdf_discovered',
      });
    }
  } finally {
    context.off('response', responseHandler);
  }

  return { popup, pdfBuffer };
}

async function processRow(raw) {
  console.log(`Processing signedWaiverId ${raw.external_signed_waiver_id}`);

  const runId = await createScrapeRun(raw);

  await updateRawRow(raw.external_signed_waiver_id, {
    download_status: 'queued',
    last_error: null,
    last_attempt_at: new Date().toISOString(),
    ...(runId ? { last_seen_run_id: runId } : {}),
    ...(runId && !raw.first_seen_run_id ? { first_seen_run_id: runId } : {}),
  });

  const browser = await chromium.launch({
    headless: HEADLESS_BOOL,
    args: CHROMIUM_ARGS,
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    serviceWorkers: 'block',
  });
  await context.route('**/*', (route) => {
    if (isBlockedRequest(route.request())) return route.abort();
    return route.continue();
  });
  const page = await context.newPage();

  let timedOut = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    console.error(`Row ${raw.external_signed_waiver_id} took longer than ${ROW_TIMEOUT_MS / 60000} minutes; closing the browser.`);
    browser.close().catch(() => {});
  }, ROW_TIMEOUT_MS);

  try {
    await login(page);
    await openWaiverHolders(page);

    const searchValue =
      raw.contact_email ||
      `${raw.holder_first_name || ''} ${raw.holder_last_name || ''}`.trim();

    if (!searchValue) {
      throw new Error('No email or holder name available for Roller search.');
    }

    console.log(`Searching Roller by ${raw.contact_email ? 'email' : 'name'} (${memMb()})`);
    await searchWaivers(page, searchValue);

    const candidate = await chooseBestCandidate(page, raw);
    if (!candidate) {
      throw new Error('No exact waiver match found in Roller results.');
    }

    await updateRawRow(raw.external_signed_waiver_id, {
      scrape_status: 'discovered',
      ...(runId ? { last_seen_run_id: runId } : {}),
      ...(runId && !raw.first_seen_run_id ? { first_seen_run_id: runId } : {}),
    });

    await updateScrapeRun(runId, {
      status: 'running',
      notes: `Strict match accepted for ${raw.external_signed_waiver_id}`,
      total_rows_seen: 1,
      download_success_count: 0,
      download_failed_count: 0,
      skipped_count: 0,
      error_count: 0,
      metadata: {
        external_signed_waiver_id: raw.external_signed_waiver_id,
        external_waiver_id: raw.external_waiver_id,
        matched_name: candidate.nameText,
        matched_signed_by: candidate.signedByText,
        matched_dob: candidate.dob,
        matched_signed_date: candidate.signedDate,
        matched_waiver_id: candidate.waiverId,
      },
    });

    console.log('Strict match accepted.');

    const { popup, pdfBuffer } = await clickRowAndCapturePdf(context, candidate, raw);

    if (!pdfBuffer) {
      throw new Error('PDF response was not captured after opening the waiver.');
    }

    const uploadPatch = await uploadPdfToBucket(raw.external_signed_waiver_id, pdfBuffer);
    await updateRawRow(raw.external_signed_waiver_id, {
      ...uploadPatch,
      ...(runId ? { last_seen_run_id: runId } : {}),
      ...(runId && !raw.first_seen_run_id ? { first_seen_run_id: runId } : {}),
    });

    await updateScrapeRun(runId, {
      status: 'completed',
      finished_at: new Date().toISOString(),
      total_rows_seen: 1,
      download_success_count: 1,
      download_failed_count: 0,
      skipped_count: 0,
      error_count: 0,
      error_summary: null,
      notes: `PDF uploaded for ${raw.external_signed_waiver_id}`,
      metadata: {
        external_signed_waiver_id: raw.external_signed_waiver_id,
        external_waiver_id: raw.external_waiver_id,
        pdf_storage_path: uploadPatch.pdf_storage_path,
      },
    });

    if (popup) {
      await popup.close().catch(() => {});
    }

    console.log(`Success. PDF uploaded for ${raw.external_signed_waiver_id}.`);
  } catch (err) {
    const nextRetryCount = (raw.retry_count || 0) + 1;
    const shouldAlert = nextRetryCount >= ALERT_THRESHOLD && !raw.alert_sent;

    if (timedOut) {
      err = new Error(`Timed out after ${ROW_TIMEOUT_MS / 60000} minutes (${err.message})`);
    }
    console.error(`Failed for ${raw.external_signed_waiver_id}:`, err.message);

    await updateRawRow(raw.external_signed_waiver_id, {
      scrape_status: 'failed',
      download_status: 'failed',
      last_error: err.message,
      retry_count: nextRetryCount,
      next_retry_at: getNextRetryAt(nextRetryCount),
      last_attempt_at: new Date().toISOString(),
      ...(runId ? { last_seen_run_id: runId } : {}),
      ...(runId && !raw.first_seen_run_id ? { first_seen_run_id: runId } : {}),
    }).catch(() => {});

    await updateScrapeRun(runId, {
      status: 'failed',
      finished_at: new Date().toISOString(),
      total_rows_seen: 1,
      download_success_count: 0,
      download_failed_count: 1,
      skipped_count: 0,
      error_count: 1,
      error_summary: err.message,
      notes: `Failure for ${raw.external_signed_waiver_id}`,
      metadata: {
        external_signed_waiver_id: raw.external_signed_waiver_id,
        external_waiver_id: raw.external_waiver_id,
        retry_count: nextRetryCount,
        error: err.message,
      },
    });

    if (shouldAlert) {
      try {
        await createFailureAlert(raw, err, nextRetryCount);
        await updateRawRow(raw.external_signed_waiver_id, {
          alert_sent: true,
          ...(runId ? { last_seen_run_id: runId } : {}),
        });
      } catch (alertErr) {
        console.error(
          `Failed to create alert for ${raw.external_signed_waiver_id}:`,
          alertErr.message
        );
      }
    }

    throw err;
  } finally {
    clearTimeout(watchdog);
    if (!KEEP_BROWSER_OPEN_ON_FAIL_BOOL || timedOut) {
      await browser.close().catch(() => {});
    }
  }
}

async function processWithRetry(raw, attempts = 3) {
  let lastError = null;
  let currentRaw = raw;

  for (let i = 1; i <= attempts; i++) {
    try {
      console.log(`Attempt ${i}/${attempts} for ${currentRaw.external_signed_waiver_id}`);
      await processRow(currentRaw);
      return;
    } catch (err) {
      lastError = err;
      console.error(`Attempt ${i} failed for ${currentRaw.external_signed_waiver_id}:`, err.message);

      const refreshed = await getRawRowBySignedWaiverId(currentRaw.external_signed_waiver_id).catch(() => null);
      if (refreshed) {
        currentRaw = refreshed;
      }

      if (i < attempts) {
        await sleep(3000);
      }
    }
  }

  throw lastError;
}

async function getDueSpecificRow() {
  const row = await getSpecificRow();
  if (!row) return null;
  if (row.download_status === 'uploaded') return 'uploaded';
  if (!isRowDue(row)) return 'not_due';
  return await claimRow(row);
}

async function loopQueue() {
  while (true) {
    try {
      let raw = null;

      if (TARGET_SIGNED_WAIVER_ID) {
        const result = await getDueSpecificRow();

        if (result === 'uploaded') {
          console.log(`Target ${TARGET_SIGNED_WAIVER_ID} is already uploaded. Sleeping...`);
          await sleep(POLL_MS);
          continue;
        }

        if (result === 'not_due') {
          console.log(`Target ${TARGET_SIGNED_WAIVER_ID} is not due yet. Sleeping...`);
          await sleep(POLL_MS);
          continue;
        }

        if (!result) {
          console.log(`Target signedWaiverId ${TARGET_SIGNED_WAIVER_ID} not found or not claimable.`);
          await sleep(POLL_MS);
          continue;
        }

        raw = result;
      } else {
        raw = await claimNextDueRow();

        if (!raw) {
          console.log('No due rows. Sleeping...');
          await sleep(POLL_MS);
          continue;
        }
      }

      await processWithRetry(raw, 3);
    } catch (err) {
      console.error('Queue loop error:', err.message);
      await sleep(POLL_MS);
    }
  }
}

console.log(`Roller PDF worker v2 started (row timeout ${ROW_TIMEOUT_MS / 60000} min, debug screenshots ${DEBUG_SCREENSHOTS_BOOL ? 'on' : 'off'}).`);

loopQueue().catch((err) => {
  console.error(err);
  process.exit(1);
});
