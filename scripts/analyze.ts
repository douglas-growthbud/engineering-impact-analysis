// Turn raw GraphQL pages into per-engineer lens credits + evidence → public/data.json.
// Every rule here is mirrored in README.md ("How it's scored"). Lines of code are never an input.
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

const RAW = "data/raw";
const DEFAULT_WEIGHTS = { shipped: 0.3, fixed: 0.25, leverage: 0.25, risk: 0.2 };
const TOP_K = 15;            // PR-based lenses sum an engineer's 15 strongest credits
const MIN_PRS = 8;           // eligibility: ≥8 counted PRs ...
const MIN_SPAN_DAYS = 21;    // ... spanning ≥21 days, or
const MIN_REVIEWS = 10;      // ≥10 substantive reviews
const HUB_THRESHOLD = 20;    // a file touched by >20 PRs is a hub: never used for overlap matching
const HOTFIX_HOURS = 72;
const EVIDENCE_ENGINEERS = 40;

// ---------- load ----------
type Issue = { number: number; title: string; url: string; author: string | null; association: string; createdAt: string; reactions: number; comments: number; labels: string[] };
type Review = { login: string; isBot: boolean; state: string; submittedAt: string; inline: number };
type PR = {
  number: number; title: string; url: string; body: string; createdAt: string; mergedAt: string; base: string;
  type: string; scope: string; author: string; authorIsBot: boolean; assignees: string[];
  autonomy: "fully" | "human" | "none"; agent: string | null; status: "no-feature-flag" | "behind-feature-flag" | "fully-available" | "unspecified"; statusSource: "marker" | "text";
  files: { path: string; additions: number; deletions: number }[]; reviews: Review[]; issues: Issue[];
  lastHumanCommitAt: string | null; additions: number; deletions: number; changedFiles: number; labels: string[];
  dri: string | null; bucket: "hd" | "fa" | "excluded"; isRevert: boolean; revertTarget: number | null;
};

const isBotLogin = (l: string | null | undefined, typename?: string) => !l || typename === "Bot" || /\[bot\]$/i.test(l) || /^(posthog-bot|dependabot|renovate)$/i.test(l);
const stripComments = (s: string) => s.replace(/<!--[\s\S]*?-->/g, "");

function parseTitle(title: string) {
  const m = title.match(/^(\w+)(?:\(([^)]*)\))?!?:\s*/);
  return { type: (m?.[1] ?? "").toLowerCase(), scope: (m?.[2] ?? "").trim().toLowerCase() };
}

const overflow = new Map<number, any>();
if (existsSync(`${RAW}/overflow`)) for (const f of readdirSync(`${RAW}/overflow`)) if (f.endsWith(".json")) { const o = JSON.parse(readFileSync(`${RAW}/overflow/${f}`, "utf8")); overflow.set(o.number, o); }

const prs = new Map<number, PR>();
let rawNodes = 0;
for (const f of readdirSync(RAW).sort()) {
  if (!/\.p\d+\.json$/.test(f)) continue;
  for (const n of JSON.parse(readFileSync(`${RAW}/${f}`, "utf8")).data.search.nodes) {
    if (!n || prs.has(n.number)) continue;
    rawNodes++;
    const body: string = n.body ?? "";
    const clean = stripComments(body);
    const { type, scope } = parseTitle(n.title);
    // Three template eras in the window: (A) no Release status section → classify from the PR's own
    // wording; (B) late Sep: all three option lines kept, one ticked "[x]"; (C) Oct: keep one line only.
    const VALID = ["no-feature-flag", "behind-feature-flag", "fully-available"];
    const ticked = [...body.matchAll(/^\s*-\s*\[[xX]\][^\n]*?release-status:\s*([a-z-]+)/gm)].map((m) => m[1]);
    const markers = [...new Set([...body.matchAll(/release-status:\s*([a-z-]+)/g)].map((m) => m[1]))];
    const hasSection = markers.length > 0 || /## Release status/.test(body);
    let status: PR["status"] = "no-feature-flag", statusSource: PR["statusSource"] = "text";
    if (ticked.length === 1 && VALID.includes(ticked[0])) { status = ticked[0] as PR["status"]; statusSource = "marker"; }
    else if (markers.length === 1 && VALID.includes(markers[0])) { status = markers[0] as PR["status"]; statusSource = "marker"; }
    else if (hasSection) { status = "unspecified"; statusSource = "marker"; } // author had the structured option and left it blank
    else {
      const ga = /\b(remov\w*|drop\w*|delet\w*|retir\w*|clean\w*[- ]up)\s+(the\s+|this\s+|its\s+|our\s+)?(`[^`]+`\s+)?(feature[- ]|release[- ]|experiment[- ])?flag(\s+gate|\s+check|\s+constant)?\b|\bflag(\s+gate|\s+check)?\s+(is|was|has been|gets|can be)\s+(removed|dropped|deleted|retired)\b|\broll\w*\s+out\s+to\s+(all|everyone|100)|\b(generally available|to GA|goes GA|now GA|went GA)\b|\b(available|enabled|on)\s+(to|for)\s+(all|everyone)\b/i.test(clean);
      const behind = /behind (a|the|an|its|this|our|new)?\s*(new |existing |temporary )?(feature[- ])?flag|gated behind|flag[- ]gated|behind `[^`]+`/i.test(clean);
      status = ga ? "fully-available" : behind ? "behind-feature-flag" : "no-feature-flag";
    }
    const autonomy: PR["autonomy"] = /\*\*Autonomy:\*\*\s*Fully autonomous\s*$/m.test(clean) ? "fully" : /\*\*Autonomy:\*\*|Agent context|\*\*Agent:\*\*/.test(clean) ? "human" : "none";
    const agentM = clean.match(/\*\*Agent:\*\*\s*([^\n]+)/);
    const agent = agentM && !/^tool,\s*model/i.test(agentM[1]) ? agentM[1].trim().slice(0, 60) : null;
    const ov = overflow.get(n.number);
    const files = (ov?.files ?? n.files.nodes).map((x: any) => ({ path: x.path, additions: x.additions, deletions: x.deletions }));
    const reviews: Review[] = (ov?.reviews ?? n.reviews.nodes).filter((r: any) => r.author).map((r: any) => ({ login: r.author.login, isBot: isBotLogin(r.author.login, r.author.__typename), state: r.state, submittedAt: r.submittedAt, inline: r.comments.totalCount }));
    const issues: Issue[] = n.closingIssuesReferences.nodes.map((i: any) => ({ number: i.number, title: i.title, url: i.url, author: i.author?.login ?? null, association: i.authorAssociation, createdAt: i.createdAt, reactions: i.reactions.totalCount, comments: i.comments.totalCount, labels: i.labels.nodes.map((l: any) => l.name) }));
    const humanCommits = n.commits.nodes.filter((c: any) => !isBotLogin(c.commit.author?.user?.login ?? "unknown")).map((c: any) => c.commit.committedDate as string);
    const author = n.author?.login ?? "ghost";
    const authorIsBot = isBotLogin(n.author?.login, n.author?.__typename);
    const assignees = n.assignees.nodes.map((a: any) => a.login).filter((l: string) => !isBotLogin(l));
    let dri: string | null = assignees[0] ?? (authorIsBot ? null : author);
    let bucket: PR["bucket"] = "hd";
    if (autonomy === "fully") { dri = assignees[0] ?? null; bucket = dri ? "fa" : "excluded"; }
    else if (authorIsBot && autonomy === "none") { dri = null; bucket = "excluded"; } // release/CI bots
    else if (!dri) bucket = "excluded";
    prs.set(n.number, {
      number: n.number, title: n.title, url: n.url, body: clean, createdAt: n.createdAt, mergedAt: n.mergedAt, base: n.baseRefName,
      type, scope, author, authorIsBot, assignees, autonomy, agent, status, statusSource, files, reviews, issues,
      lastHumanCommitAt: humanCommits.length ? humanCommits.sort().at(-1)! : null,
      additions: n.additions, deletions: n.deletions, changedFiles: n.changedFiles, labels: n.labels.nodes.map((l: any) => l.name),
      dri, bucket, isRevert: false, revertTarget: null,
    });
  }
}
const all = [...prs.values()].sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));
const windowStart = all[0]?.mergedAt.slice(0, 10), windowEnd = all.at(-1)?.mergedAt.slice(0, 10);
console.log(`loaded ${all.length} merged PRs (${rawNodes} raw nodes) ${windowStart}..${windowEnd}`);

// ---------- reverts ----------
const byTitle = new Map<string, PR[]>();
for (const p of all) { const k = p.title.trim().toLowerCase(); byTitle.set(k, [...(byTitle.get(k) ?? []), p]); }
for (const p of all) {
  if (!/revert/i.test(p.title)) continue;
  let target: number | null = null;
  const t1 = p.title.match(/\(#(\d+)\)/); if (t1) target = Number(t1[1]);
  if (!target) { const b = p.body.match(/\brevert(?:s|ed|ing)?\s+(?:(?:PR|pull request)\s+)?#(\d+)/i); if (b) target = Number(b[1]); }
  if (!target) { const q = p.title.match(/["“]([^"”]+)["”]/); if (q) { const key = q[1].replace(/\s*\(#\d+\)\s*$/, "").trim().toLowerCase(); const cands = (byTitle.get(key) ?? []).filter((x) => x.number !== p.number && x.mergedAt < p.mergedAt); if (cands.length) target = cands.at(-1)!.number; } }
  const quotedForm = p.type === "revert" || /^(?:\w+(?:\([^)]*\))?!?:\s*)?revert:?\s*["“]/i.test(p.title);
  if (target || quotedForm) { p.isRevert = true; p.revertTarget = target && prs.has(target) ? target : target; }
}
const revertedBy = new Map<number, PR>();
for (const p of all) if (p.isRevert && p.revertTarget) revertedBy.set(p.revertTarget, p);

// ---------- hub files, sharedness ----------
const counted = all.filter((p) => p.bucket !== "excluded");
const fileTouches = new Map<string, number>();
for (const p of counted) for (const f of p.files) fileTouches.set(f.path, (fileTouches.get(f.path) ?? 0) + 1);
const isHub = (path: string) => (fileTouches.get(path) ?? 0) > HUB_THRESHOLD;
const dirKey = (path: string) => path.split("/").slice(0, 3).join("/");
const fileOwners = new Map<string, Set<string>>();
for (const p of counted) for (const f of p.files) { if (!fileOwners.has(f.path)) fileOwners.set(f.path, new Set()); fileOwners.get(f.path)!.add(p.dri!); }
const sharedness = (path: string) => fileOwners.get(path)?.size ?? 1; // distinct engineers who changed this exact file in the window

// radius(file) = engineers sharing the file × multiplier + base; base makes a solo migration count like a file ~10 people work in.
const CATEGORIES: [string, RegExp, number, number][] = [
  ["tests/docs", /__snapshots__|\.ambr$|\.snap$|(^|\/)tests?\/|_test\.|\.test\.|\.stories\.|^docs\/|\.md$|storybook/i, 0.3, 0],
  ["migrations", /(^|\/)migrations\//, 2.0, 8],
  ["hogql/schema", /^posthog\/(hogql\/|schema)/, 1.5, 4],
  ["ingestion", /^rust\/|^nodejs\/src\/ingestion|plugin-server/, 1.5, 4],
  ["auth/billing", /^ee\/billing|^posthog\/api\/authentication|access_control|^ee\/api\/rbac|^products\/authz/, 1.5, 4],
  ["CI", /^\.github\/workflows/, 1.3, 3],
];
const category = (path: string): [string, number, number] => { for (const [n, re, m, b] of CATEGORIES) if (re.test(path)) return [n, m, b]; return ["product code", 1.0, 0]; };
const INFRA = /^(\.github\/|bin\/|devenv\/|common\/|docker\/|terraform\/|tools\/|\.agents\/|\.claude\/)/;

// ---------- credits ----------
type Credit = { pr: number; title: string; url: string; credit: number; why: string; bucket: "hd" | "fa"; mergedAt: string };
type Eng = {
  login: string; counts: { hd: number; fa: number; excludedAuthored: number; agentAssisted: number }; span: { hd: [string, string] | null; all: [string, string] | null };
  shipped: Credit[]; fixed: Credit[]; risk: Credit[]; infra: Credit[];
  reviews: { pr: number; title: string; url: string; author: string; credit: number; inline: number; pushedAfter: boolean; oversight: boolean; state: string; mergedAt: string }[];
  reverted: number; hotfixed: number;
};
const engs = new Map<string, Eng>();
const eng = (login: string): Eng => { if (!engs.has(login)) engs.set(login, { login, counts: { hd: 0, fa: 0, excludedAuthored: 0, agentAssisted: 0 }, span: { hd: null, all: null }, shipped: [], fixed: [], risk: [], infra: [], reviews: [], reverted: 0, hotfixed: 0 }); return engs.get(login)!; };
const span = (s: [string, string] | null, d: string): [string, string] => !s ? [d, d] : [s[0] < d ? s[0] : d, s[1] > d ? s[1] : d];
const short = (t: string) => (t.length > 90 ? t.slice(0, 87) + "…" : t);
const push = (arr: Credit[], p: PR, credit: number, why: string) => arr.push({ pr: p.number, title: short(p.title), url: p.url, credit: +credit.toFixed(3), why, bucket: p.bucket as "hd" | "fa", mergedAt: p.mergedAt.slice(0, 10) });

for (const p of counted) {
  const e = eng(p.dri!);
  e.counts[p.bucket as "hd" | "fa"]++;
  if (p.bucket === "hd" && p.autonomy === "human") e.counts.agentAssisted++;
  if (p.bucket === "hd") e.span.hd = span(e.span.hd, p.mergedAt.slice(0, 10));
  e.span.all = span(e.span.all, p.mergedAt.slice(0, 10));
}
for (const p of all) if (p.bucket === "excluded" && !p.authorIsBot) eng(p.author).counts.excludedAuthored++;

// Lens 1 — shipped to users (flag lineage). Every unflagged feature starts at 1.0; closing a request
// someone else filed adds to it, so the top-15 reflects features people asked for, not the count.
function featureQuality(p: PR) {
  let bonus = 0; const notes: string[] = [];
  const issue = [...p.issues].sort((a, b) => b.reactions + b.comments - (a.reactions + a.comments))[0];
  if (issue && issue.author !== p.dri) { const w = Math.min(0.5, 0.1 * (issue.reactions + issue.comments)); bonus += 0.5 + w; notes.push(`closed request #${issue.number}${issue.reactions + issue.comments ? ` (${issue.reactions} reactions / ${issue.comments} comments)` : ""}`); }
  return { bonus, notes };
}
const features: { anchor: number; title: string; url: string; scope: string; remover: string; removerCredit: number; builders: { login: string; prs: number[] }[]; mergedAt: string }[] = [];
const lifted = new Set<number>();
const buildPRs = counted.filter((p) => p.status === "behind-feature-flag" && ["feat", "fix", "perf"].includes(p.type));
const byScope = new Map<string, PR[]>();
for (const b of buildPRs) if (b.scope) byScope.set(b.scope, [...(byScope.get(b.scope) ?? []), b]);
for (const p of counted.filter((x) => x.status === "fully-available")) {
  const cleanup = /\b(stale|cleanup|clean[- ]up|unused|dead|legacy|obsolete)\b/i.test(p.title);
  const removerCredit = cleanup ? 0.1 : 0.25;
  const nonHub = new Set(p.files.filter((f) => !isHub(f.path)).map((f) => f.path));
  const lineage = (byScope.get(p.scope) ?? []).filter((b) => b.mergedAt < p.mergedAt && b.files.some((f) => nonHub.has(f.path)));
  const builders = new Map<string, number[]>();
  for (const b of lineage) { lifted.add(b.number); builders.set(b.dri!, [...(builders.get(b.dri!) ?? []), b.number]); }
  features.push({ anchor: p.number, title: short(p.title), url: p.url, scope: p.scope, remover: p.dri!, removerCredit, builders: [...builders].map(([login, prs]) => ({ login, prs })), mergedAt: p.mergedAt.slice(0, 10) });
  const src = p.statusSource === "marker" ? "" : " (inferred from PR text)";
  push(eng(p.dri!).shipped, p, removerCredit, lineage.length ? `made a flagged feature available to everyone (${cleanup ? "flag cleanup" : "gate removal"})${src}; built by ${[...builders.keys()].join(", ")}` : `made a flagged feature available to everyone (${cleanup ? "flag cleanup" : "gate removal"})${src}; builders not in window`);
}
for (const p of counted) {
  if (["feat", "perf"].includes(p.type) && p.status === "no-feature-flag") {
    const { bonus, notes } = featureQuality(p);
    push(eng(p.dri!).shipped, p, 1.0 + bonus, "shipped directly to users (no feature flag)" + (p.statusSource === "marker" ? "" : ", no flag mentioned") + (notes.length ? "; " + notes.join("; ") : ""));
  }
  else if (buildPRs.includes(p)) {
    const ga = lifted.has(p.number);
    const anchor = ga ? features.find((f) => f.builders.some((b) => b.prs.includes(p.number))) : null;
    push(eng(p.dri!).shipped, p, ga ? 1.0 : 0.5, (ga ? `built behind a flag; GA confirmed by #${anchor!.anchor}` : "built behind a flag; GA not observed in window") + (p.statusSource === "marker" ? "" : " (flag inferred from PR text)"));
  }
}

// Lens 2 — fixed what hurt. "External" means the issue filer is neither a public PostHog org member
// nor anyone who merged a PR in the window (private org membership shows as CONTRIBUTOR in the API).
const contributors = new Set<string>(); for (const p of all) { contributors.add(p.author); if (p.dri) contributors.add(p.dri); }
for (const p of counted) {
  if (p.isRevert) { push(eng(p.dri!).fixed, p, 0.75, p.revertTarget ? `reverted #${p.revertTarget} (firefighting)` : "revert (firefighting)"); continue; }
  if (p.type !== "fix") continue;
  if (!p.issues.length) { push(eng(p.dri!).fixed, p, 0.25, "fix with no linked issue (severity unknown)"); continue; }
  let best = 0, why = "";
  for (const i of p.issues) {
    const external = !["MEMBER", "OWNER", "COLLABORATOR"].includes(i.association) && !!i.author && !contributors.has(i.author);
    const selfFiled = i.author === p.dri;
    const waiting = Math.min(0.5, 0.1 * (i.reactions + i.comments));
    const c = (selfFiled ? 0.5 : 1.0) + (external ? 0.5 : 0) + waiting;
    if (c > best) { best = c; why = `closed #${i.number} filed by ${selfFiled ? "themselves" : i.author ? "@" + i.author : "someone"}${external ? " (not a PostHog contributor)" : ""}${i.reactions + i.comments ? `, ${i.reactions} reactions / ${i.comments} comments` : ""}`; }
  }
  push(eng(p.dri!).fixed, p, best, why);
}

// Lens 3 — multiplied others (reviews + shared infra)
for (const p of all) {
  const seen = new Map<string, { inline: number; first: string; cr: boolean }>();
  for (const r of p.reviews) {
    if (r.isBot || r.login === p.author || r.login === p.dri) continue;
    if (!(r.state === "CHANGES_REQUESTED" || r.inline > 0)) continue;
    const s = seen.get(r.login) ?? { inline: 0, first: r.submittedAt, cr: false };
    s.inline += r.inline; s.cr ||= r.state === "CHANGES_REQUESTED"; if (r.submittedAt < s.first) s.first = r.submittedAt;
    seen.set(r.login, s);
  }
  for (const [login, s] of seen) {
    const pushedAfter = !!p.lastHumanCommitAt && p.lastHumanCommitAt > s.first;
    eng(login).reviews.push({ pr: p.number, title: short(p.title), url: p.url, author: p.dri ?? p.author, credit: 1 + (pushedAfter ? 0.5 : 0), inline: s.inline, pushedAfter, oversight: p.autonomy === "fully" || p.authorIsBot, state: s.cr ? "changes requested" : "inline comments", mergedAt: p.mergedAt.slice(0, 10) });
  }
}
for (const p of counted) { const inf = p.files.filter((f) => INFRA.test(f.path)); if (p.files.length && inf.length * 2 >= p.files.length) push(eng(p.dri!).infra, p, 1.0, `changed shared tooling everyone depends on (${[...new Set(inf.map((f) => f.path.split("/")[0]))].join(", ")})`); }

const hotfixers = new Map<number, number>(); // fix PR → the PR it hot-fixed (filled in lens 4, credited in lens 2)
// Lens 4 — carried risk, and it held
const fixByFile = new Map<string, PR[]>();
for (const p of counted) if (p.type === "fix") for (const f of p.files) if (!isHub(f.path)) fixByFile.set(f.path, [...(fixByFile.get(f.path) ?? []), p]);
for (const p of counted) {
  if (!p.files.length) continue;
  let bestRaw = 0, bestPath = p.files[0].path, bestCat = category(p.files[0].path)[0];
  for (const f of p.files) { if (isHub(f.path)) continue; const [cat, mult, base] = category(f.path); const raw = sharedness(f.path) * mult + base; if (raw > bestRaw) { bestRaw = raw; bestPath = f.path; bestCat = cat; } }
  if (bestRaw === 0) bestRaw = 0.5; // only hub files touched (lockfiles, generated schema): minimal radius
  const radius = bestRaw;
  let held = 1.0, heldWhy = "held";
  const rv = revertedBy.get(p.number);
  if (rv) { held = 0; heldWhy = `reverted by #${rv.number}`; eng(p.dri!).reverted++; }
  else {
    const limit = new Date(new Date(p.mergedAt).getTime() + HOTFIX_HOURS * 3600e3).toISOString();
    const cands = new Set<PR>();
    for (const f of p.files) if (!isHub(f.path)) for (const q of fixByFile.get(f.path) ?? []) if (q.dri !== p.dri && q.mergedAt > p.mergedAt && q.mergedAt <= limit) cands.add(q);
    // A hotfix must either name the broken PR, or overwrite most of the same non-hub files (Jaccard ≥ 0.5)
    // while describing a regression or closing an issue opened after the change landed. Sharing one CI
    // file and saying "broke" is not enough: that fired on nearly every devex PR.
    const mine = new Set(p.files.filter((f) => !isHub(f.path)).map((f) => f.path));
    for (const q of cands) {
      const refRe = new RegExp(`#${p.number}\\b`);
      const refs = refRe.test(q.body) || refRe.test(q.title);
      const theirs = q.files.filter((f) => !isHub(f.path)).map((f) => f.path);
      const inter = theirs.filter((f) => mine.has(f)).length;
      const jaccard = inter / (mine.size + theirs.length - inter || 1);
      const words = /\b(regression|broke|broken|revert)\b/i.test(q.body);
      const scoped = q.scope && q.scope === p.scope && q.issues.some((i) => i.createdAt > p.mergedAt);
      if (refs || (jaccard >= 0.5 && (words || scoped))) { held = 0.5; heldWhy = `hot-fixed within ${HOTFIX_HOURS}h by #${q.number}${refs ? " (which names this PR)" : " (same files, regression noted)"}`; eng(p.dri!).hotfixed++; hotfixers.set(q.number, p.number); break; }
    }
  }
  push(eng(p.dri!).risk, p, radius * held, `${bestCat}: ${bestPath.split("/").slice(-3).join("/")} (${sharedness(bestPath)} engineer${sharedness(bestPath) === 1 ? "" : "s"} changed this file in the window); ${heldWhy}`);
}

// Lens 2 post-pass: the engineer who hot-fixed someone else's change within 72h gets firefighting credit.
for (const [fixNo, brokenNo] of hotfixers) {
  const q = prs.get(fixNo)!; const c = eng(q.dri!).fixed.find((x) => x.pr === fixNo);
  if (c) { c.credit = +(c.credit + 0.5).toFixed(3); c.why += `; hot-fixed #${brokenNo} within ${HOTFIX_HOURS}h of it landing`; }
}

// ---------- aggregate (server-side defaults; the client recomputes for toggles/sliders) ----------
// top-15 strongest credits; the full total enters only as a 0.1% tie-breaker so volume cannot buy rank
const topK = (cs: Credit[], buckets: Set<string>) => { const v = cs.filter((c) => buckets.has(c.bucket)).map((c) => c.credit).sort((a, b) => b - a); return v.slice(0, TOP_K).reduce((a, b) => a + b, 0) + 0.001 * v.reduce((a, b) => a + b, 0); };
const INFRA_K = 5;
const topInfra = (cs: Credit[], buckets: Set<string>) => cs.filter((c) => buckets.has(c.bucket)).map((c) => c.credit).sort((a, b) => b - a).slice(0, INFRA_K).reduce((a, b) => a + b, 0);
const reviewScore = (e: Eng) => { const byAuthor = new Map<string, number[]>(); for (const r of e.reviews) byAuthor.set(r.author, [...(byAuthor.get(r.author) ?? []), r.credit]); let s = 0; for (const cs of byAuthor.values()) s += Math.log1p(cs.length) * (cs.reduce((a, b) => a + b, 0) / cs.length); return s; };
const daysBetween = (s: [string, string] | null) => (s ? (new Date(s[1]).getTime() - new Date(s[0]).getTime()) / 864e5 : 0);
const HD = new Set(["hd"]);
const rows = [...engs.values()].map((e) => ({
  login: e.login, counts: e.counts, span: e.span, spanDays: Math.round(daysBetween(e.span.hd)),
  substantive: e.reviews.length, oversight: e.reviews.filter((r) => r.oversight).length, distinctAuthors: new Set(e.reviews.map((r) => r.author)).size,
  raw: { shipped: topK(e.shipped, HD), fixed: topK(e.fixed, HD), leverage: reviewScore(e) + topInfra(e.infra, HD), risk: topK(e.risk, HD) },
  reverted: e.reverted, hotfixed: e.hotfixed,
}));
const eligible = rows.filter((r) => (r.counts.hd >= MIN_PRS && r.spanDays >= MIN_SPAN_DAYS) || r.substantive >= MIN_REVIEWS);
const pct = (key: keyof (typeof rows)[0]["raw"]) => { const vals = eligible.map((r) => r.raw[key]); const n = vals.length; return (x: number) => (x <= 0 ? 0 : vals.filter((v) => v < x).length / Math.max(1, n - 1)); };
const P = { shipped: pct("shipped"), fixed: pct("fixed"), leverage: pct("leverage"), risk: pct("risk") };
const scored = eligible.map((r) => { const p = { shipped: P.shipped(r.raw.shipped), fixed: P.fixed(r.raw.fixed), leverage: P.leverage(r.raw.leverage), risk: P.risk(r.raw.risk) }; return { ...r, pct: p, composite: Object.entries(DEFAULT_WEIGHTS).reduce((a, [k, w]) => a + w * p[k as keyof typeof p], 0) }; }).sort((a, b) => b.composite - a.composite);

// ---------- output ----------
const evidenceFor = new Set<string>([...scored.slice(0, EVIDENCE_ENGINEERS).map((r) => r.login), ...(["shipped", "fixed", "leverage", "risk"] as const).flatMap((k) => [...scored].sort((a, b) => b.raw[k] - a.raw[k]).slice(0, 10).map((r) => r.login))]);
const slim = (cs: Credit[]) => [...cs].sort((a, b) => b.credit - a.credit);
const out = {
  meta: {
    repo: "PostHog/posthog", window: { start: windowStart, end: windowEnd }, generatedAt: new Date().toISOString(), methodVersion: "1.0",
    weights: DEFAULT_WEIGHTS, topK: TOP_K, infraK: INFRA_K, minPRs: MIN_PRS, minSpanDays: MIN_SPAN_DAYS, minReviews: MIN_REVIEWS, hubThreshold: HUB_THRESHOLD, hotfixHours: HOTFIX_HOURS,
    totals: {
      mergedPRs: all.length, counted: counted.filter((p) => p.bucket === "hd").length, fullyAutonomous: all.filter((p) => p.autonomy === "fully").length, fullyAutonomousAssigned: counted.filter((p) => p.bucket === "fa").length,
      botAuthored: all.filter((p) => p.authorIsBot).length, excluded: all.filter((p) => p.bucket === "excluded").length,
      agentAssisted: all.filter((p) => p.autonomy === "human").length, noAgentBlock: all.filter((p) => p.autonomy === "none").length,
      status: Object.fromEntries(["no-feature-flag", "behind-feature-flag", "fully-available", "unspecified"].map((s) => [s, all.filter((p) => p.status === s).length])),
      statusFromMarker: all.filter((p) => p.statusSource === "marker").length, statusFromText: all.filter((p) => p.statusSource === "text").length,
      markerEraStart: all.find((p) => p.statusSource === "marker")?.mergedAt.slice(0, 10) ?? null,
      reverts: all.filter((p) => p.isRevert).length, revertsResolved: revertedBy.size, hubFiles: [...fileTouches.values()].filter((v) => v > HUB_THRESHOLD).length,
      features: features.length, featuresWithBuilders: features.filter((f) => f.builders.length).length,
      engineers: rows.length, eligible: eligible.length, substantiveReviews: rows.reduce((a, r) => a + r.substantive, 0),
    },
  },
  engineers: rows.map((r) => {
    const e = engs.get(r.login)!;
    const withEvidence = evidenceFor.has(r.login);
    const lens = (cs: Credit[], k = TOP_K) => ({ hd: slim(cs.filter((c) => c.bucket === "hd")).slice(0, k).map((c) => c.credit), fa: slim(cs.filter((c) => c.bucket === "fa")).slice(0, k).map((c) => c.credit), nHd: cs.filter((c) => c.bucket === "hd").length, nFa: cs.filter((c) => c.bucket === "fa").length, totalHd: +cs.filter((c) => c.bucket === "hd").reduce((a, c) => a + c.credit, 0).toFixed(3), totalFa: +cs.filter((c) => c.bucket === "fa").reduce((a, c) => a + c.credit, 0).toFixed(3) });
    return {
      login: r.login, counts: r.counts, spanDays: r.spanDays, spanAllDays: Math.round(daysBetween(r.span.all)),
      shipped: lens(e.shipped), fixed: lens(e.fixed), risk: lens(e.risk), infra: lens(e.infra, INFRA_K),
      reviewScore: +reviewScore(e).toFixed(3), substantive: r.substantive, oversight: r.oversight, distinctAuthors: r.distinctAuthors, pushedAfter: e.reviews.filter((x) => x.pushedAfter).length,
      reverted: r.reverted, hotfixed: r.hotfixed,
      evidence: withEvidence ? { shipped: slim(e.shipped).slice(0, 4), fixed: slim(e.fixed).slice(0, 4), risk: slim(e.risk).slice(0, 4), infra: slim(e.infra).slice(0, 3), reviews: [...e.reviews].sort((a, b) => b.credit - a.credit || b.inline - a.inline).slice(0, 4), scopes: topScopes(e.login) } : null,
    };
  }),
  features: features.filter((f) => f.builders.length || evidenceFor.has(f.remover)),
};
function topScopes(login: string) { const c = new Map<string, number>(); for (const p of counted) if (p.dri === login && p.scope) c.set(p.scope, (c.get(p.scope) ?? 0) + 1); return [...c].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([s, n]) => ({ scope: s, n })); }

mkdirSync("public", { recursive: true });
writeFileSync("public/data.json", JSON.stringify(out));
writeFileSync("data/prs.json", JSON.stringify(all.map(({ body, files, reviews, ...rest }) => ({ ...rest, nFiles: files.length, nReviews: reviews.length }))));

// ---------- summary for README / sanity ----------
const t = out.meta.totals;
const lines = [
  `# Analysis summary (${windowStart} .. ${windowEnd}, generated ${out.meta.generatedAt})`, "",
  `- merged PRs: ${t.mergedPRs}; counted (human-driven, credited to a DRI): ${t.counted}; fully autonomous: ${t.fullyAutonomous} (${t.fullyAutonomousAssigned} with a human assignee, credited only with the toggle); bot-authored: ${t.botAuthored}; excluded: ${t.excluded}`,
  `- agent-assisted (Human-driven block): ${t.agentAssisted}; no agent block: ${t.noAgentBlock}`,
  `- release status: ${JSON.stringify(t.status)}`,
  `- reverts: ${t.reverts} (${t.revertsResolved} resolved to an original PR); hub files: ${t.hubFiles}; shipped-feature anchors: ${t.features} (${t.featuresWithBuilders} with in-window builders)`,
  `- engineers with any credit: ${t.engineers}; eligible: ${t.eligible}; substantive human reviews: ${t.substantiveReviews}`, "",
  `| # | engineer | composite | shipped | fixed | leverage | risk | PRs (agent-assisted) | reviews | reverted |`, `|---|---|---|---|---|---|---|---|---|---|`,
  ...scored.slice(0, 15).map((r, i) => `| ${i + 1} | ${r.login} | ${r.composite.toFixed(3)} | ${r.pct.shipped.toFixed(2)} (${r.raw.shipped.toFixed(1)}) | ${r.pct.fixed.toFixed(2)} (${r.raw.fixed.toFixed(1)}) | ${r.pct.leverage.toFixed(2)} (${r.raw.leverage.toFixed(1)}) | ${r.pct.risk.toFixed(2)} (${r.raw.risk.toFixed(1)}) | ${r.counts.hd} (${r.counts.agentAssisted}) | ${r.substantive} | ${r.reverted} |`),
];
writeFileSync("data/summary.md", lines.join("\n") + "\n");
console.log(lines.join("\n"));
console.log(`data.json: ${(JSON.stringify(out).length / 1e6).toFixed(2)} MB`);
