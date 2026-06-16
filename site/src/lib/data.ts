// Build-time loader for the canonical tracker data (repo-root data/libraries.json).
// We compute everything the UI needs here so the client script stays dumb.
import raw from '../../../data/libraries.json';

export type Status =
  | 'shipped'
  | 'merged'
  | 'pr-open'
  | 'discussion'
  | 'proposed'
  | 'not-started'
  | 'no-go'
  | 'skipped'
  | 'none';

export type Tier = 'AAA' | 'AA' | 'none';

export interface Channel {
  name: string;
  type: 'tracing' | 'diagnostics';
  desc: string;
}

export interface RawLibrary {
  package: string;
  name: string;
  group: 'otel' | 'sentry' | 'other' | 'logging';
  category: string;
  builtin: boolean;
  downloadsPerMonth: number | null;
  aliases: string[];
  status: Status;
  prerelease?: boolean;
  diagnostics_channel: Status;
  tracing_channel: Status;
  shippedVersion: string | null;
  channels: Channel[];
  pr: { label: string; url: string } | null;
  issue: { label: string; url: string } | null;
  driver: 'sentry' | 'other' | null;
  sentryLocation: string | null;
  notes: string;
}

export interface Library extends RawLibrary {
  /** Highest capability level actually available today. */
  tier: Tier;
  /** The headline yes/no the site is built around. */
  verdict: 'yes' | 'soon' | 'no' | 'no-go' | 'skipped';
  /** True once a published version exists you can install. */
  available: boolean;
}

const meta = (raw as { meta: Record<string, unknown> }).meta;
const libraries = (raw as { libraries: RawLibrary[] }).libraries;

const AVAILABLE: Status[] = ['shipped', 'merged'];
const IN_FLIGHT: Status[] = ['pr-open', 'discussion', 'proposed'];

function tierOf(lib: RawLibrary): Tier {
  if (AVAILABLE.includes(lib.tracing_channel)) return 'AAA';
  if (AVAILABLE.includes(lib.diagnostics_channel)) return 'AA';
  return 'none';
}

function verdictOf(lib: RawLibrary): Library['verdict'] {
  if (AVAILABLE.includes(lib.diagnostics_channel) || AVAILABLE.includes(lib.tracing_channel))
    return 'yes';
  if (IN_FLIGHT.includes(lib.status)) return 'soon';
  if (lib.status === 'no-go') return 'no-go';
  if (lib.status === 'skipped') return 'skipped';
  return 'no';
}

export const allLibraries: Library[] = libraries.map((lib) => ({
  ...lib,
  tier: tierOf(lib),
  verdict: verdictOf(lib),
  available: AVAILABLE.includes(lib.status),
}));

export const dataMeta = meta;

export const stats = {
  total: allLibraries.length,
  yes: allLibraries.filter((l) => l.verdict === 'yes').length,
  aaa: allLibraries.filter((l) => l.tier === 'AAA').length,
  soon: allLibraries.filter((l) => l.verdict === 'soon').length,
};
