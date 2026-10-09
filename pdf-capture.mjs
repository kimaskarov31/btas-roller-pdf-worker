// pdf-capture.mjs (worker v3, 9 Oct 2026)
//
// Takes the signed waiver PDF the moment Roller sends it, without letting the
// viewer draw it. Drawing the PDF in a second page is what pushed the worker to
// about 527 of its 537 MB. Nothing here logs names, emails or birth dates.

import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const CANDIDATE_TYPES = new Set(['document', 'xhr', 'fetch', 'other']);
const DROP_HEADERS = new Set(['range', 'if-range', 'host', 'connection', 'content-length']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function looksLikePdf(buf) {
  return !!buf && buf.length >= 1024 && buf.subarray(0, 5).toString('latin1') === '%PDF-';
}

export function hasPdfEnd(buf) {
  if (!buf || buf.length < 8) return false;
  return buf.subarray(Math.max(0, buf.length - 2048)).toString('latin1').includes('%%EOF');
}

// Best effort: PDFs that pack their objects in compressed streams report 0.
export function pdfPageCount(buf) {
  if (!buf) return 0;
  const m = buf.toString('latin1').match(/\/Type\s*\/Page(?![A-Za-z])/g);
  return m ? m.length : 0;
}

export function md5(buf) {
  return createHash('md5').update(buf).digest('hex');
}

// The shape of an address, safe for logs: numbers become #, long or file-like
// parts become *, and only the names of query keys are kept.
export function urlShape(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'blob:' || u.protocol === 'data:') return u.protocol;
    const path = u.pathname
      .split('/')
      .map((seg) => {
        if (!seg) return seg;
        if (/\.pdf$/i.test(seg)) return '*.pdf';
        if (seg.length > 24 || !/^[a-z0-9_-]+$/i.test(seg)) return '*';
        if (/[0-9]/.test(seg) && /[a-z]/i.test(seg) && seg.length > 12) return '*';
        return seg.replace(/\d+/g, '#');
      })
      .join('/');
    const keys = [...new Set(u.searchParams.keys())].join(',');
    return `${u.host}${path}${keys ? `?{${keys}}` : ''}`;
  } catch {
    return 'unparsed';
  }
}

// Memory that cannot be given back while the worker runs: the processes' own
// memory (anon) plus shared memory (shmem, where Chrome keeps its page
// buffers). File cache is left out: the kernel drops it when memory is short,
// so it is not what makes the container run out. Read from the container's
// memory.stat (cgroup v2 names first, then v1).
const CGROUP_STAT_FILES = [
  ['/sys/fs/cgroup/memory.stat', 'anon', 'shmem'],
  ['/sys/fs/cgroup/memory/memory.stat', 'total_rss', 'total_shmem'],
];

function readCgroupBytes() {
  for (const [statFile, anonKey, shmemKey] of CGROUP_STAT_FILES) {
    try {
      const text = readFileSync(statFile, 'utf8');
      const anon = text.match(new RegExp(`^${anonKey} (\\d+)$`, 'm'));
      if (!anon) continue;
      const shmem = text.match(new RegExp(`^${shmemKey} (\\d+)$`, 'm'));
      return Number(anon[1]) + (shmem ? Number(shmem[1]) : 0);
    } catch {
      // not available here
    }
  }
  return null;
}

function readProcRssBytes() {
  let total = 0;
  try {
    for (const pid of readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const pages = Number(readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ')[1]);
        if (Number.isFinite(pages)) total += pages * 4096;
      } catch {
        // process ended
      }
    }
  } catch {
    return null;
  }
  return total || null;
}

// The adding up of each process's memory counts shared pages many times, so
// it is only the fallback.
export function memorySource() {
  if (readCgroupBytes()) return 'container anon+shmem';
  if (readProcRssBytes()) return 'processes';
  return 'node';
}

export function memoryNowMb() {
  const bytes = readCgroupBytes() ?? readProcRssBytes() ?? process.memoryUsage().rss;
  return Math.round(bytes / 1048576);
}

// Samples memory every few hundred ms and remembers the highest value.
export function startMemorySampler(intervalMs = 300) {
  const source = memorySource();
  let peak = memoryNowMb();
  const timer = setInterval(() => {
    const v = memoryNowMb();
    if (v > peak) peak = v;
  }, intervalMs);
  if (timer.unref) timer.unref();
  return {
    source,
    peek: () => peak,
    stop() {
      clearInterval(timer);
      const v = memoryNowMb();
      if (v > peak) peak = v;
      return { peakMb: peak, source };
    },
  };
}

function cleanHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const key = k.toLowerCase();
    if (key.startsWith(':') || DROP_HEADERS.has(key)) continue;
    out[k] = v;
  }
  return out;
}

function hasRangeHeader(headers) {
  return Object.keys(headers || {}).some((k) => k.toLowerCase() === 'range');
}

function maybePdfContentType(ct) {
  return (
    ct === '' ||
    ct.includes('pdf') ||
    ct.includes('octet-stream') ||
    ct.includes('binary') ||
    ct.includes('download')
  );
}

/**
 * Clicks the waiver row and catches the PDF on its way to the viewer.
 *
 * Every GET for a page, frame, fetch or XHR made after the click is fetched by
 * Playwright itself (with any Range header removed, so the whole file comes in
 * one piece). If the answer is a PDF it is kept and the viewer receives an
 * empty answer, so it never draws the PDF. Anything else is passed on unchanged.
 * The old way (listening for a PDF answer) runs next to it as a safety net.
 */
export async function capturePdfDirect({
  context,
  mainPage,
  click,
  isBlocked = () => false,
  timeoutMs = 30000,
}) {
  const started = Date.now();
  const info = { method: 'direct', found: false, via: null };
  let pdf = null;
  let listenerPdf = null;
  let listenerInfo = null;
  let popup = null;
  let checked = 0;

  const onPage = (p) => {
    if (p !== mainPage && !popup) popup = p;
  };
  // A popup that opened before this function was called is not ours to judge.
  const pagesBefore = new Set(context.pages());

  const handler = async (route) => {
    const req = route.request();
    if (pdf) return route.fallback().catch(() => {});

    let type = 'other';
    try {
      type = req.resourceType();
    } catch {
      // keep "other"
    }

    const method = req.method();
    const methodOk = method === 'GET' || (method === 'POST' && (type === 'xhr' || type === 'fetch'));
    if (!CANDIDATE_TYPES.has(type) || !methodOk || isBlocked(req)) {
      return route.fallback().catch(() => {});
    }

    let origin = 'unknown';
    try {
      const frame = req.frame();
      if (frame.page() === mainPage) {
        if (req.isNavigationRequest() && frame === mainPage.mainFrame()) {
          return route.fallback().catch(() => {});
        }
        origin = frame === mainPage.mainFrame() ? 'main' : 'main-frame-child';
      } else {
        origin = 'popup';
      }
    } catch {
      // service worker or detached frame
    }

    checked++;
    const headers = req.headers();
    const hadRange = hasRangeHeader(headers);

    let resp;
    try {
      resp = await route.fetch(hadRange ? { headers: cleanHeaders(headers) } : undefined);
    } catch {
      return route.fallback().catch(() => {});
    }

    const status = resp.status();
    const ct = (resp.headers()['content-type'] || '').toLowerCase();
    const redirected = resp.url() !== req.url();

    if (status >= 200 && status < 300 && maybePdfContentType(ct)) {
      let body = null;
      try {
        body = await resp.body();
      } catch {
        body = null;
      }

      if (body && looksLikePdf(body) && !pdf) {
        pdf = body;
        Object.assign(info, {
          found: true,
          via: 'route',
          resourceType: type,
          origin,
          hadRange,
          status,
          contentType: ct.split(';')[0] || '(none)',
          urlShape: urlShape(req.url()),
          redirected,
          finalUrlShape: redirected ? urlShape(resp.url()) : undefined,
          bytes: body.length,
        });
        return route.fulfill({ status: 200, contentType: 'text/plain', body: '' }).catch(() => {});
      }

      if (body) return route.fulfill({ response: resp, body }).catch(() => {});
    }

    if (method === 'GET' && (status >= 400 || (type === 'document' && redirected))) {
      // An error answer to the worker's own fetch (a block page, for example), or
      // a page that was redirected: let the browser ask again by itself, so the
      // page gets exactly what it would have got without this step.
      return route.continue().catch(() => {});
    }

    return route.fulfill({ response: resp }).catch(() => {});
  };

  const onResponse = async (response) => {
    if (pdf || listenerPdf) return;
    try {
      const ct = (response.headers()['content-type'] || '').toLowerCase();
      if (!ct.includes('application/pdf')) return;
      const body = await response.body();
      if (looksLikePdf(body) && !listenerPdf) {
        listenerPdf = body;
        let type = 'other';
        try {
          type = response.request().resourceType();
        } catch {
          // keep "other"
        }
        listenerInfo = {
          resourceType: type,
          status: response.status(),
          contentType: ct.split(';')[0],
          urlShape: urlShape(response.url()),
          bytes: body.length,
        };
      }
    } catch {
      // body not available
    }
  };

  context.on('page', onPage);
  context.on('response', onResponse);
  await context.route('**/*', handler);

  try {
    await click();
    const end = started + timeoutMs;
    while (Date.now() < end && !pdf && !listenerPdf) {
      await sleep(200);
    }
  } finally {
    await context.unroute('**/*', handler).catch(() => {});
    context.off('response', onResponse);
    context.off('page', onPage);
  }

  if (!pdf && listenerPdf) {
    pdf = listenerPdf;
    Object.assign(info, listenerInfo, { found: true, via: 'listener' });
  }

  if (pdf) await sleep(300); // let a popup that is still opening show up, so it is closed too

  info.popupOpened = !!popup;
  info.requestsChecked = checked;
  info.seconds = Math.round((Date.now() - started) / 100) / 10;

  // Close every page the click opened; only the main page stays.
  let closed = 0;
  for (const p of context.pages()) {
    if (p !== mainPage && !pagesBefore.has(p)) {
      await p.close().catch(() => {});
      closed++;
    }
  }
  info.pagesClosed = closed;

  return { pdfBuffer: pdf, info };
}
