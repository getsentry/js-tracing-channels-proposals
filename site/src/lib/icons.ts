// Build-time icon rendering via Iconify. Icons are resolved from installed
// icon-set JSON and emitted as inline SVG strings — nothing is fetched at runtime.
import { getIconData, iconToSVG, iconToHTML, replaceIDs } from '@iconify/utils';
import lucide from '@iconify-json/lucide/icons.json';
import simpleIcons from '@iconify-json/simple-icons/icons.json';
import logos from '@iconify-json/logos/icons.json';

const SETS: Record<string, any> = { lucide, 'simple-icons': simpleIcons, logos };

/**
 * Returns an inline `<svg>` string for an Iconify name like "lucide:dices".
 * Pass `height` (without `size`) to scale by height only — preserves the aspect
 * ratio for non-square brand logos.
 */
export function icon(
  name: string,
  opts: { size?: string; height?: string; cls?: string } = {},
): string {
  const [prefix, iconName] = name.split(':');
  const set = SETS[prefix];
  if (!set) throw new Error(`Unknown icon set: ${prefix}`);
  const data = getIconData(set, iconName);
  if (!data) throw new Error(`Icon not found: ${name}`);
  const { size = '1em', height, cls } = opts;
  const rendered = iconToSVG(data, height ? { height } : { height: size, width: size });
  const attrs: Record<string, string> = { ...rendered.attributes, 'aria-hidden': 'true' };
  if (cls) attrs.class = cls;
  return iconToHTML(replaceIDs(rendered.body), attrs);
}

/** Semantic icon name maps shared between build-time markup and the client app. */
export const VERDICT_ICON = {
  yes: 'lucide:circle-check-big',
  soon: 'lucide:hammer',
  no: 'lucide:circle-slash-2',
  'no-go': 'lucide:ban',
  skipped: 'lucide:skip-forward',
  unknown: 'lucide:circle-help',
} as const;

export const STATUS_ICON = {
  shipped: 'lucide:circle-check-big',
  merged: 'lucide:git-merge',
  'pr-open': 'lucide:git-pull-request-arrow',
  discussion: 'lucide:message-circle',
  proposed: 'lucide:pencil-line',
  'not-started': 'lucide:circle-dashed',
  'no-go': 'lucide:ban',
  skipped: 'lucide:skip-forward',
  none: 'lucide:minus',
} as const;

export const UI_ICON = {
  pr: 'lucide:git-pull-request-arrow',
  issue: 'lucide:message-circle',
  npm: 'simple-icons:npm',
  suggest: 'lucide:plus',
  dices: 'lucide:dices',
  search: 'lucide:search',
  polyfill: 'lucide:bandage',
  book: 'lucide:book-open',
} as const;

/** Build a `{ key: svgString }` map for injecting into the client. */
export function iconMap(names: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, name] of Object.entries(names)) out[key] = icon(name);
  return out;
}
