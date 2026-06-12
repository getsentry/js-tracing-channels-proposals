// Client-side search + card rendering for "Do I Have Diagnostic Channels?"
// Data is injected at build time onto window.__LIBS by index.astro.

type Status =
  | 'shipped' | 'merged' | 'pr-open' | 'discussion'
  | 'proposed' | 'not-started' | 'no-go' | 'skipped' | 'none';

interface Link { label: string; url: string }

interface Lib {
  package: string;
  name: string;
  category: string;
  group: 'otel' | 'sentry' | 'other' | 'logging';
  builtin: boolean;
  downloadsPerMonth: number | null;
  aliases: string[];
  status: Status;
  prerelease: boolean;
  diagnostics_channel: Status;
  tracing_channel: Status;
  shippedVersion: string | null;
  channels: string[];
  pr: Link | null;
  issue: Link | null;
  driver: 'sentry' | 'other' | null;
  notes: string;
  tier: 'AAA' | 'AA' | 'none';
  verdict: 'yes' | 'soon' | 'no';
}

interface IconMaps {
  verdict: Record<'yes' | 'soon' | 'no' | 'unknown', string>;
  status: Record<Status, string>;
  ui: Record<'pr' | 'issue' | 'npm' | 'suggest' | 'dices' | 'search' | 'polyfill' | 'book', string>;
}

declare global {
  interface Window {
    __LIBS: Lib[];
    __ICONS: IconMaps;
  }
}

const LIBS: Lib[] = window.__LIBS ?? [];
const ICONS: IconMaps = window.__ICONS;

const STATUS_LABEL: Record<Status, string> = {
  shipped: 'Shipped in a release',
  merged: 'Merged, awaiting release',
  'pr-open': 'Pull request open',
  discussion: 'In discussion upstream',
  proposed: 'Proposal drafted',
  'not-started': 'Not started',
  'no-go': 'Not viable',
  skipped: 'Skipped',
  none: 'Not pursued',
};

const VERDICT_TEXT = {
  yes: 'Yes!',
  soon: 'Not yet, but it’s in the works',
  no: 'Nope, not yet',
} as const;

const $ = <T extends Element>(sel: string, root: ParentNode = document): T =>
  root.querySelector(sel) as T;

const input = $<HTMLInputElement>('#q');
const list = $<HTMLUListElement>('#suggestions');
const result = $<HTMLElement>('#result');
const lucky = $<HTMLButtonElement>('#lucky');
const tpl = $<HTMLTemplateElement>('#card-tpl');

// --- search ---------------------------------------------------------------

function norm(s: string): string {
  return s.toLowerCase().replace(/[\s_.@/-]/g, '');
}

function score(lib: Lib, q: string): number {
  const nq = norm(q);
  if (!nq) return 0;
  const haystacks = [lib.package, lib.name, ...lib.aliases].map(norm);
  let best = 0;
  for (const h of haystacks) {
    if (h === nq) best = Math.max(best, 100);
    else if (h.startsWith(nq)) best = Math.max(best, 70 - (h.length - nq.length) * 0.5);
    else if (h.includes(nq)) best = Math.max(best, 35);
  }
  return best;
}

function search(q: string, limit = 7): Lib[] {
  return LIBS.map((lib) => ({ lib, s: score(lib, q) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || (b.lib.downloadsPerMonth ?? 0) - (a.lib.downloadsPerMonth ?? 0))
    .slice(0, limit)
    .map((x) => x.lib);
}

function findExact(q: string): Lib | undefined {
  const nq = norm(q);
  return LIBS.find(
    (l) => norm(l.package) === nq || norm(l.name) === nq || l.aliases.some((a) => norm(a) === nq),
  );
}

// --- npm registry (for packages we don't track) ---------------------------
// The registry search/metadata endpoints are CORS-enabled, so we can query
// them straight from the static page. npm can't tell us about channel support,
// so npm-only results are always shown as "not tracked".

interface NpmPkg {
  name: string;
  version: string;
  description: string;
  links: { repository?: string; homepage?: string; npm?: string };
}

type Sugg = { kind: 'lib'; lib: Lib } | { kind: 'npm'; pkg: NpmPkg };

const knownNames = new Set(LIBS.flatMap((l) => [norm(l.package), ...l.aliases.map(norm)]));

// scoped names need the slash encoded but the @ kept
function npmPath(name: string): string {
  return name.startsWith('@') ? name.replace('/', '%2F') : encodeURIComponent(name);
}

function cleanRepoUrl(u?: string): string | undefined {
  if (!u) return undefined;
  return u.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/\.git$/, '');
}

async function npmSearch(q: string): Promise<NpmPkg[]> {
  try {
    const r = await fetch(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(q)}&size=10`);
    if (!r.ok) return [];
    const data = await r.json();
    return (data.objects ?? []).map((o: any) => o.package as NpmPkg);
  } catch {
    return [];
  }
}

async function npmPackage(name: string): Promise<NpmPkg | null> {
  try {
    const r = await fetch(`https://registry.npmjs.org/${npmPath(name)}/latest`);
    if (!r.ok) return null;
    const m = await r.json();
    return {
      name: m.name,
      version: m.version,
      description: m.description ?? '',
      links: {
        npm: `https://www.npmjs.com/package/${m.name}`,
        homepage: m.homepage,
        repository: typeof m.repository === 'string' ? m.repository : m.repository?.url,
      },
    };
  } catch {
    return null;
  }
}

async function npmMonthlyDownloads(name: string): Promise<number | null> {
  try {
    const r = await fetch(`https://api.npmjs.org/downloads/point/last-week/${npmPath(name)}`);
    if (!r.ok) return null;
    const d = await r.json();
    return d.downloads ? Math.round(d.downloads * 4.345) : null; // weekly → ~monthly
  } catch {
    return null;
  }
}

// --- autocomplete UI ------------------------------------------------------

let active = -1;
let current: Sugg[] = [];

function closeList() {
  list.hidden = true;
  list.innerHTML = '';
  input.setAttribute('aria-expanded', 'false');
  active = -1;
}

function fmtDl(n: number | null): string {
  if (n == null) return 'built-in';
  if (n >= 1_000_000) return `~${Math.round(n / 1_000_000)}M/mo`;
  return `~${Math.round(n / 1000)}K/mo`;
}

function renderList(items: Sugg[]) {
  current = items;
  active = -1;
  if (!items.length) {
    closeList();
    return;
  }
  list.innerHTML = items
    .map((s, i) =>
      s.kind === 'lib'
        ? `<li role="option" id="opt-${i}" aria-selected="false">
            <span class="opt-verdict v-${s.lib.verdict}">${ICONS.verdict[s.lib.verdict]}</span>
            <span class="opt-name"><b>${escapeHtml(s.lib.package)}</b><small>${escapeHtml(s.lib.name)}</small></span>
            <span class="opt-meta">${s.lib.tier !== 'none' ? `<span class="opt-tier t-${s.lib.tier}">${s.lib.tier}</span>` : ''}${fmtDl(s.lib.downloadsPerMonth)}</span>
          </li>`
        : `<li role="option" id="opt-${i}" aria-selected="false">
            <span class="opt-verdict v-unknown">${ICONS.verdict.unknown}</span>
            <span class="opt-name"><b>${escapeHtml(s.pkg.name)}</b><small>${escapeHtml(s.pkg.description || 'npm package')}</small></span>
            <span class="opt-meta"><span class="opt-npm">npm · untracked</span></span>
          </li>`,
    )
    .join('');
  list.hidden = false;
  input.setAttribute('aria-expanded', 'true');
}

function setActive(i: number) {
  const opts = Array.from(list.children) as HTMLElement[];
  opts.forEach((o, idx) => o.setAttribute('aria-selected', String(idx === i)));
  active = i;
  if (opts[i]) opts[i].scrollIntoView({ block: 'nearest' });
}

// --- card rendering -------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

function capState(s: Status): 'on' | 'soon' | 'off' {
  if (s === 'shipped' || s === 'merged') return 'on';
  if (s === 'pr-open' || s === 'discussion' || s === 'proposed') return 'soon';
  return 'off';
}

function renderCard(lib: Lib) {
  const node = tpl.content.firstElementChild!.cloneNode(true) as HTMLElement;
  node.dataset.verdict = lib.verdict;

  $('.pkg', node).textContent = lib.package;
  $('.pkg-name', node).textContent = `${lib.name}${lib.builtin ? ' · Node built-in' : ''}`;

  // tier stamp
  const stamp = $<HTMLElement>('.stamp', node);
  stamp.dataset.tier = lib.tier;
  $('.stamp-rating', node).textContent = lib.tier === 'none' ? '—' : lib.tier;
  $('.stamp-sub', node).textContent =
    lib.tier === 'AAA' ? 'TracingChannel' : lib.tier === 'AA' ? 'diagnostics_channel' : 'no channels';

  // verdict
  $('.verdict-emoji', node).innerHTML = ICONS.verdict[lib.verdict];
  $('.verdict-text', node).textContent =
    VERDICT_TEXT[lib.verdict] + (lib.prerelease && lib.verdict === 'yes' ? ' (pre-release)' : '');

  // capability cards
  renderCap($<HTMLElement>('[data-cap="dc"]', node), lib.diagnostics_channel);
  renderCap($<HTMLElement>('[data-cap="tc"]', node), lib.tracing_channel);

  // meta rows
  if (lib.shippedVersion) showRow(node, 'version', escapeHtml(lib.shippedVersion) + (lib.prerelease ? ' <em>(pre-release)</em>' : ''));
  if (lib.downloadsPerMonth != null) showRow(node, 'dl', fmtDl(lib.downloadsPerMonth));
  if (lib.builtin && lib.downloadsPerMonth == null) showRow(node, 'dl', 'ships with Node');
  if (lib.channels.length)
    showRow(node, 'channels', lib.channels.map((c) => `<code>${escapeHtml(c)}</code>`).join(' '));
  if (lib.notes) showRow(node, 'notes', escapeHtml(lib.notes));

  // links
  const links = $<HTMLElement>('.links', node);
  const btns: string[] = [];
  if (lib.pr) btns.push(linkBtn(lib.pr.url, lib.pr.label, 'ghost pr', ICONS.ui.pr));
  if (lib.issue) btns.push(linkBtn(lib.issue.url, lib.issue.label, '', ICONS.ui.issue));
  if (!lib.builtin)
    btns.push(linkBtn(`https://www.npmjs.com/package/${lib.package}`, 'npm', 'ghost', ICONS.ui.npm));
  links.innerHTML = btns.join('');

  result.innerHTML = '';
  result.appendChild(node);
  // restart entrance animation
  node.getBoundingClientRect();
  node.classList.add('in');
}

function renderCap(el: HTMLElement, status: Status) {
  const state = capState(status);
  el.dataset.state = state;
  $('.cap-icon', el).innerHTML = ICONS.status[status];
  $('.cap-status', el).textContent = STATUS_LABEL[status];
}

function showRow(node: HTMLElement, row: string, html: string) {
  const el = $<HTMLElement>(`[data-row="${row}"]`, node);
  el.hidden = false;
  $('dd', el).innerHTML = html;
}

function linkBtn(url: string, label: string, kind: string, ico = ''): string {
  return `<a class="btn ${kind}" href="${url}" target="_blank" rel="noopener">${ico}<span>${escapeHtml(label)}</span></a>`;
}

function renderUnknown(q: string) {
  result.innerHTML = `
    <article class="card unknown in">
      <div class="verdict"><span class="verdict-emoji">${ICONS.verdict.unknown}</span>
        <span class="verdict-text">Not on our radar</span></div>
      <p class="unknown-body">
        <code>${escapeHtml(q)}</code> isn't in the TracingChannel tracker (yet).
        That doesn't necessarily mean it has no channels, just that we're not tracking it.
      </p>
      <div class="links">
        ${linkBtn('https://github.com/getsentry/js-tracing-channels-proposals/issues/new', 'Suggest it', 'primary', ICONS.ui.suggest)}
        ${linkBtn(`https://www.npmjs.com/package/${encodeURIComponent(q)}`, 'npm', 'ghost', ICONS.ui.npm)}
      </div>
    </article>`;
}

function renderLoading(q: string) {
  result.innerHTML = `
    <article class="card unknown in">
      <div class="verdict"><span class="verdict-text loading">Looking up <code>${escapeHtml(q)}</code> on npm…</span></div>
    </article>`;
}

function renderNpmCard(pkg: NpmPkg) {
  const repo = cleanRepoUrl(pkg.links.repository || pkg.links.homepage);
  result.innerHTML = `
    <article class="card unknown in">
      <h2 class="pkg npm-title">${escapeHtml(pkg.name)}</h2>
      <p class="pkg-name">v${escapeHtml(pkg.version)} · npm package</p>
      <div class="verdict"><span class="verdict-emoji">${ICONS.verdict.unknown}</span>
        <span class="verdict-text">Not in our tracker</span></div>
      <p class="unknown-body">
        ${pkg.description ? escapeHtml(pkg.description) + ' ' : ''}We haven't checked this one for
        native <code>diagnostics_channel</code> / <code>TracingChannel</code> support; it isn't in
        the tracker. If you think it should be, let us know.
      </p>
      <p class="npm-dl" hidden></p>
      <div class="links">
        ${linkBtn('https://github.com/getsentry/js-tracing-channels-proposals/issues/new', 'Suggest it', 'ghost pr', ICONS.ui.suggest)}
        ${repo ? linkBtn(repo, 'Repo', 'ghost', ICONS.ui.pr) : ''}
        ${linkBtn(pkg.links.npm || `https://www.npmjs.com/package/${pkg.name}`, 'npm', 'ghost', ICONS.ui.npm)}
      </div>
    </article>`;
  npmMonthlyDownloads(pkg.name).then((m) => {
    if (m == null || norm(input.value) !== norm(pkg.name)) return;
    const el = result.querySelector('.npm-dl') as HTMLElement | null;
    if (el) {
      el.textContent = `${fmtDl(m)} on npm`;
      el.hidden = false;
    }
  });
}

// --- selection / routing --------------------------------------------------

function setUrl(q: string) {
  const url = new URL(location.href);
  url.searchParams.set('q', q);
  history.replaceState(null, '', url);
}

function selectSugg(s: Sugg) {
  if (s.kind === 'lib') select(s.lib);
  else selectNpm(s.pkg);
}

function select(lib: Lib, pushUrl = true) {
  input.value = lib.package;
  closeList();
  renderCard(lib);
  if (pushUrl) setUrl(lib.package);
  input.blur();
}

function selectNpm(pkg: NpmPkg) {
  input.value = pkg.name;
  closeList();
  renderNpmCard(pkg);
  setUrl(pkg.name);
  input.blur();
}

async function submit() {
  const q = input.value.trim();
  if (!q) return;
  const exact = findExact(q);
  if (exact) return select(exact);
  const hits = search(q, 1);
  if (hits.length) return select(hits[0]);
  // not tracked → resolve against npm
  closeList();
  renderLoading(q);
  const pkg = await npmPackage(q);
  if (norm(input.value) !== norm(q)) return; // query moved on
  if (pkg) renderNpmCard(pkg);
  else renderUnknown(q);
}

// --- events ---------------------------------------------------------------

// Local results render instantly; if they're thin we augment with npm hits.
let seq = 0;
async function update() {
  const q = input.value.trim();
  const mine = ++seq;
  if (!q) {
    closeList();
    return;
  }
  const local: Sugg[] = search(q).map((lib) => ({ kind: 'lib', lib }));
  renderList(local);
  if (q.length >= 2 && local.length < 6) {
    const npm = await npmSearch(q);
    if (mine !== seq) return; // a newer keystroke won
    const localNames = new Set(local.map((s) => (s.kind === 'lib' ? norm(s.lib.package) : '')));
    const extras: Sugg[] = npm
      .filter((p) => !knownNames.has(norm(p.name)) && !localNames.has(norm(p.name)))
      .slice(0, 6)
      .map((pkg) => ({ kind: 'npm', pkg }));
    if (extras.length) renderList(local.concat(extras));
  }
}

let t: number | undefined;
input.addEventListener('input', () => {
  window.clearTimeout(t);
  t = window.setTimeout(update, 120);
});

input.addEventListener('keydown', (e) => {
  if (list.hidden) {
    if (e.key === 'Enter') submit();
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    setActive((active + 1) % current.length);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    setActive((active - 1 + current.length) % current.length);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (active >= 0 && current[active]) selectSugg(current[active]);
    else submit();
  } else if (e.key === 'Escape') {
    closeList();
  }
});

list.addEventListener('mousedown', (e) => {
  // mousedown (not click) so it fires before input blur
  const li = (e.target as HTMLElement).closest('li');
  if (!li) return;
  const idx = Array.from(list.children).indexOf(li);
  if (idx >= 0 && current[idx]) selectSugg(current[idx]);
});

input.addEventListener('focus', () => {
  if (input.value.trim()) update();
});

document.addEventListener('click', (e) => {
  if (!(e.target as HTMLElement).closest('.combo, #suggestions')) closeList();
});

lucky.addEventListener('click', () => {
  const yes = LIBS.filter((l) => l.verdict === 'yes');
  const pool = yes.length ? yes : LIBS;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  select(pick);
});

// deep link: ?q=express
const initial = new URLSearchParams(location.search).get('q');
if (initial) {
  const lib = findExact(initial) ?? search(initial, 1)[0];
  if (lib) {
    input.value = lib.package;
    renderCard(lib);
  } else {
    input.value = initial;
    renderLoading(initial);
    npmPackage(initial).then((pkg) => {
      if (norm(input.value) !== norm(initial)) return;
      if (pkg) renderNpmCard(pkg);
      else renderUnknown(initial);
    });
  }
}
