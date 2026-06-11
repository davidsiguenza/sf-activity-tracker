import { load } from '../lib/config-store.js';
import { analyze } from '../services/matcher.js';

/**
 * POST /api/analyze
 * Body: { fromIso, toIso }
 */
export async function post({ body, sendJson, res }) {
  const cfg = load();
  if (!cfg || !cfg.seUserId) {
    return sendJson(res, 400, { error: 'Setup not complete. Run /api/setup first.' });
  }
  const { fromIso, toIso, forceRefresh, forceReclassify, cacheOnly } = body || {};
  if (!fromIso || !toIso) {
    return sendJson(res, 400, { error: 'fromIso and toIso required (ISO 8601)' });
  }

  // Validate dates
  const from = new Date(fromIso);
  const to = new Date(toIso);
  if (isNaN(from.getTime()) || isNaN(to.getTime())) {
    return sendJson(res, 400, { error: 'invalid ISO dates' });
  }
  if (to < from) {
    return sendJson(res, 400, { error: 'toIso must be >= fromIso' });
  }

  const result = await analyze({
    fromIso,
    toIso,
    config: cfg,
    forceRefresh: !!forceRefresh,
    forceReclassify: !!forceReclassify,
    cacheOnly: !!cacheOnly,
  });

  // Compute summary
  const summary = computeSummary(result);

  return sendJson(res, 200, { ...result, summary });
}

function computeSummary(result) {
  const counts = {
    total: result.events.length,
    identified: 0,
    flagged: 0,
    excluded: 0,
    skip: 0,
    alreadyLogged: 0,
    unclassified: 0, // pending claude classification (cacheOnly mode)
    fresh: 0,        // freshly classified this run (not from cache, not already-logged)
  };
  let cfHours = 0;
  let crHours = 0;

  for (const e of result.events) {
    const c = result.classifications.find((x) => x.eventId === e.id);
    if (!c) continue;
    counts[c.status === 'already-logged' ? 'alreadyLogged' : c.status]++;
    if (c._fromCache === false) counts.fresh++;
    if (c.status === 'identified') {
      const dur = e.durationHours || 0;
      if (c.isCF) cfHours += dur;
      if (c.isCR) crHours += dur;
    }
  }
  return {
    counts,
    cfHours: Math.round(cfHours * 100) / 100,
    crHours: Math.round(crHours * 100) / 100,
  };
}
