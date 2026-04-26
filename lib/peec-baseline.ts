/**
 * Single-shot Peec brand-baseline lookup.
 *
 * Re-uses the same algorithm the orchestrator uses inside `lib/research.ts`
 * (`fetchPeecHits`) but exposes it as an isolated helper so the per-prompt
 * Test button can rebaseline one prompt without re-running the whole
 * Council. The lookup is *portfolio-wide* — Peec doesn't have our
 * generated prompt ids in its system, so we approximate "channels
 * surfacing the user's brand for prompts in this neighbourhood" by
 * pulling the most recent 30-day brand SOV report and counting channels
 * with any hits. Same approximation, fresh window.
 *
 * Returns:
 *   - `hits`: number of channels with any brand mention in the window
 *   - `totalChannels`: number of currently active Peec model channels
 *   - `channels`: id + description per active channel, in Peec's order
 *
 * If anything fails (no project, no own brand, network error), the
 * caller should surface this to the user — unlike the orchestrator,
 * we don't want to silently mark a Test as "no Peec data".
 */
import 'server-only';
import {
  PeecKeyMissingError,
  getBrandsReport,
  listBrands,
  listModelChannels,
  listProjects,
  type PeecBrand,
  type PeecModelChannel,
  type PeecTrackingOptions,
} from './peec';

export interface PeecBaselineResult {
  hits: number;
  totalChannels: number;
  channels: Array<{ id: string; description: string }>;
}

export class PeecNoProjectError extends Error {
  readonly code = 'peec_no_project';
  constructor() {
    super('Peec returned no projects for this key.');
    this.name = 'PeecNoProjectError';
  }
}

export class PeecNoBrandError extends Error {
  readonly code = 'peec_no_brand';
  constructor() {
    super('Peec project has no "own brand" configured — set one in Peec to enable hit scoring.');
    this.name = 'PeecNoBrandError';
  }
}

export async function fetchPeecBaseline(
  apiKey: string,
  tracking: PeecTrackingOptions,
): Promise<PeecBaselineResult> {
  if (!apiKey) throw new PeecKeyMissingError();

  const projects = await listProjects(apiKey, tracking);
  if (projects.length === 0) throw new PeecNoProjectError();
  const project = projects[0]!;

  const [brands, channels] = await Promise.all([
    listBrands(apiKey, { projectId: project.id }, tracking),
    listModelChannels(apiKey, { projectId: project.id }, tracking),
  ]);
  const ownBrand = brands.find((b: PeecBrand) => b.is_own);
  const activeChannels = channels.filter((c: PeecModelChannel) => c.is_active);
  const totalChannels = activeChannels.length;
  const channelLabels = activeChannels.map((c) => ({
    id: c.id,
    description: c.description,
  }));

  if (!ownBrand) throw new PeecNoBrandError();
  if (totalChannels === 0) {
    return { hits: 0, totalChannels: 0, channels: [] };
  }

  // 30-day window matching the orchestrator's baseline. We re-anchor
  // the window every Test so the count drifts as Peec ingests fresh
  // data — that's the whole point of "Test" vs. the cached run value.
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const startDate = since.toISOString().slice(0, 10);
  const endDate = new Date().toISOString().slice(0, 10);

  const channelIds = activeChannels.map((c) => c.id);
  const report = await getBrandsReport(
    apiKey,
    {
      project_id: project.id,
      start_date: startDate,
      end_date: endDate,
      dimensions: ['model_channel_id'],
      filters: [
        { field: 'brand_id', operator: 'in', values: [ownBrand.id] },
        { field: 'model_channel_id', operator: 'in', values: channelIds },
      ],
    },
    tracking,
  );

  const rows = (report.data ?? []) as Array<Record<string, unknown>>;
  let hits = 0;
  for (const row of rows) {
    const mentions =
      Number(row['mentions']) ||
      Number(row['mention_count']) ||
      Number(row['hit_count']) ||
      Number(row['count']) ||
      0;
    if (mentions > 0) hits += 1;
  }

  return { hits, totalChannels, channels: channelLabels };
}
