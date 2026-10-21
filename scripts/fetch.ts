// Fetch every merged PR in PostHog/posthog for the window, one GraphQL search page at a time,
// split into daily `merged:` windows (search caps at 1,000 results per query; max observed ~340/day).
// Raw pages land in data/raw/<day>.p<n>.json; a <day>.done marker makes the run resumable.
// Phase 2 fetches the remainder for PRs whose files (>100) or reviews (>50) overflowed the nested limits.
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, appendFileSync } from "node:fs";

const REPO = "PostHog/posthog";
const START = process.env.START ?? "2026-07-22";
const END = process.env.END ?? new Date().toISOString().slice(0, 10);
const WORKERS = Number(process.env.WORKERS ?? 4);
const RAW = "data/raw";
mkdirSync(`${RAW}/overflow`, { recursive: true });

const token =
  process.env.GITHUB_TOKEN ?? Bun.spawnSync(["gh", "auth", "token"]).stdout.toString().trim();
if (!token) throw new Error("No GitHub token: run `gh auth login` or set GITHUB_TOKEN");

const log = (m: string) => {
  const line = `${new Date().toISOString().slice(11, 19)} ${m}`;
  console.log(line);
  appendFileSync("data/fetch.log", line + "\n");
};

const QUERY = `query($q:String!, $after:String) {
  rateLimit { cost remaining resetAt }
  search(query:$q, type:ISSUE, first:100, after:$after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      number title body url baseRefName createdAt mergedAt additions deletions changedFiles
      author { login __typename }
      assignees(first:3) { nodes { login } }
      labels(first:5) { nodes { name } }
      files(first:100) { totalCount nodes { path additions deletions } }
      reviews(first:50) { totalCount nodes { author { login __typename } state submittedAt comments { totalCount } } }
      closingIssuesReferences(first:5) { nodes { number title url authorAssociation author { login } createdAt reactions { totalCount } comments { totalCount } labels(first:5) { nodes { name } } } }
      commits(last:5) { totalCount nodes { commit { committedDate author { user { login } } } } }
    } }
  }
}`;

function listDays(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = new Date(start + "T00:00:00Z"); d.toISOString().slice(0, 10) <= end; d.setUTCDate(d.getUTCDate() + 1))
    out.push(d.toISOString().slice(0, 10));
  return out;
}

const BACKOFF = [5, 15, 30, 60, 90, 120];
async function gql(variables: Record<string, unknown>, attempt = 0): Promise<any> {
  try {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "posthog-impact-fetch" },
      body: JSON.stringify({ query: QUERY, variables }),
    });
    if (res.status === 403 || res.status === 429 || res.status >= 500) {
      const ra = res.headers.get("retry-after");
      throw new Error(`http ${res.status}${ra ? ` retry-after=${ra}` : ""}`);
    }
    const json = await res.json();
    if (!json.data?.search) throw new Error("gql: " + JSON.stringify(json.errors ?? json).slice(0, 300));
    if (json.errors) log(`partial errors: ${JSON.stringify(json.errors).slice(0, 200)}`);
    return json;
  } catch (e: any) {
    if (attempt >= BACKOFF.length) throw e;
    const wait = BACKOFF[attempt] * 1000;
    log(`retry ${attempt + 1} in ${wait / 1000}s: ${e.message}`);
    await Bun.sleep(wait);
    return gql(variables, attempt + 1);
  }
}

async function rest(path: string, attempt = 0): Promise<any> {
  try {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "posthog-impact-fetch" },
    });
    if (res.status === 403 || res.status === 429 || res.status >= 500) throw new Error(`http ${res.status}`);
    if (!res.ok) throw new Error(`http ${res.status} ${path}`);
    return res.json();
  } catch (e: any) {
    if (attempt >= BACKOFF.length) throw e;
    const wait = BACKOFF[attempt] * 1000;
    log(`rest retry ${attempt + 1} in ${wait / 1000}s: ${e.message}`);
    await Bun.sleep(wait);
    return rest(path, attempt + 1);
  }
}

type DayRec = { day: string; issueCount: number; fetched: number; pages: number };

async function fetchDay(day: string): Promise<DayRec> {
  const done = `${RAW}/${day}.done`;
  if (existsSync(done)) return JSON.parse(readFileSync(done, "utf8"));
  const q = `repo:${REPO} is:pr is:merged merged:${day}..${day}`;
  let after: string | null = null, page = 0, fetched = 0, issueCount = -1;
  for (;;) {
    const json = await gql({ q, after });
    const s = json.data.search;
    issueCount = s.issueCount;
    if (issueCount >= 1000) log(`WARN ${day}: issueCount ${issueCount} hits the 1,000 search cap`);
    page++;
    writeFileSync(`${RAW}/${day}.p${page}.json`, JSON.stringify(json));
    fetched += s.nodes.filter(Boolean).length;
    log(`${day} p${page} +${s.nodes.length}/${issueCount} cost=${json.data.rateLimit.cost} left=${json.data.rateLimit.remaining}`);
    if (!s.pageInfo.hasNextPage) break;
    after = s.pageInfo.endCursor;
  }
  const rec = { day, issueCount, fetched, pages: page };
  writeFileSync(done, JSON.stringify(rec));
  return rec;
}

async function phase1() {
  const queue = listDays(START, END);
  log(`phase 1: ${queue.length} days ${START}..${END}, ${WORKERS} workers`);
  const results: DayRec[] = [];
  await Promise.all(
    Array.from({ length: WORKERS }, async () => {
      for (;;) {
        const day = queue.shift();
        if (!day) return;
        results.push(await fetchDay(day));
      }
    }),
  );
  const total = results.reduce((a, r) => a + r.fetched, 0);
  const expected = results.reduce((a, r) => a + r.issueCount, 0);
  const bad = results.filter((r) => r.fetched !== r.issueCount);
  log(`phase 1 done: fetched ${total} of ${expected} expected; mismatched days: ${bad.map((b) => `${b.day}(${b.fetched}/${b.issueCount})`).join(" ") || "none"}`);
  writeFileSync(`${RAW}/_completeness.json`, JSON.stringify({ START, END, total, expected, days: results }, null, 2));
}

// Phase 2: PRs whose nested files/reviews were truncated get the full lists via REST.
async function phase2() {
  const todo: { number: number; files: boolean; reviews: boolean }[] = [];
  for (const f of readdirSync(RAW)) {
    if (!/\.p\d+\.json$/.test(f)) continue;
    const json = JSON.parse(readFileSync(`${RAW}/${f}`, "utf8"));
    for (const n of json.data.search.nodes) {
      if (!n) continue;
      const files = n.files.totalCount > 100, reviews = n.reviews.totalCount > 50;
      if ((files || reviews) && !existsSync(`${RAW}/overflow/${n.number}.json`)) todo.push({ number: n.number, files, reviews });
    }
  }
  log(`phase 2: ${todo.length} PRs overflowed nested limits`);
  await Promise.all(
    Array.from({ length: WORKERS }, async () => {
      for (;;) {
        const t = todo.shift();
        if (!t) return;
        const out: any = { number: t.number };
        if (t.files) {
          out.files = [];
          for (let p = 1; ; p++) {
            const page = await rest(`/repos/${REPO}/pulls/${t.number}/files?per_page=100&page=${p}`);
            out.files.push(...page.map((f: any) => ({ path: f.filename, additions: f.additions, deletions: f.deletions })));
            if (page.length < 100) break;
          }
        }
        if (t.reviews) {
          const reviews: any[] = [];
          for (let p = 1; ; p++) {
            const page = await rest(`/repos/${REPO}/pulls/${t.number}/reviews?per_page=100&page=${p}`);
            reviews.push(...page);
            if (page.length < 100) break;
          }
          const counts = new Map<number, number>();
          for (let p = 1; ; p++) {
            const page = await rest(`/repos/${REPO}/pulls/${t.number}/comments?per_page=100&page=${p}`);
            for (const c of page) counts.set(c.pull_request_review_id, (counts.get(c.pull_request_review_id) ?? 0) + 1);
            if (page.length < 100) break;
          }
          out.reviews = reviews.map((r: any) => ({
            author: r.user ? { login: r.user.login, __typename: r.user.type === "Bot" ? "Bot" : "User" } : null,
            state: r.state, submittedAt: r.submitted_at, comments: { totalCount: counts.get(r.id) ?? 0 },
          }));
        }
        writeFileSync(`${RAW}/overflow/${t.number}.json`, JSON.stringify(out));
        log(`overflow #${t.number} files=${out.files?.length ?? "-"} reviews=${out.reviews?.length ?? "-"}`);
      }
    }),
  );
  log("phase 2 done");
}

await phase1();
await phase2();
