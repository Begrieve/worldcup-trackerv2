// ============================================================================
//  2026 FIFA World Cup — Live Group Tracker  (local server)
//  Zero dependencies. Run:  node server.js   then open http://localhost:3000
//
//  • Serves a polished dashboard (standings, fixtures, venues, dates).
//  • Standings are COMPUTED from results, recalculated instantly on every change.
//  • Enter scores by hand in the Fixtures tab — they persist to results.json.
//  • Optional auto-update: set an API token (see README) to pull live scores.
//  • All connected browsers poll every 30s, so the view stays "real time".
// ============================================================================

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { FLAGS, GROUPS, MATCHES, TOURNAMENT } = require("./data");

const PORT = process.env.PORT || 3000;
const VERSION = "v38 · 2026-06-14 (narrow stats+fixtures, read-only scores, player/country search)";

// Best-guess LAN IPv4 so phones on the same Wi-Fi can reach this server.
function lanIP(){
  const nets = os.networkInterfaces();
  let candidate = null;
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family === "IPv4" && !ni.internal) {
        // Prefer typical home-LAN ranges
        if (/^192\.168\./.test(ni.address)) return ni.address;
        if (/^10\./.test(ni.address) || /^172\.(1[6-9]|2\d|3[01])\./.test(ni.address)) candidate = candidate || ni.address;
        else candidate = candidate || ni.address;
      }
    }
  }
  return candidate;
}

// When packaged into a single .exe, write/read files next to the executable
// rather than inside the read-only snapshot.
const BASE_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;
const RESULTS_FILE = path.join(BASE_DIR, "results.json");

// API token: environment variable first, else an optional token.txt placed
// next to the program (handy when sharing the .exe — no command line needed).
function readToken() {
  if (process.env.WC_API_TOKEN) return process.env.WC_API_TOKEN.trim();
  try {
    const t = fs.readFileSync(path.join(BASE_DIR, "token.txt"), "utf8").trim();
    return t || null;
  } catch { return null; }
}
const API_TOKEN = readToken();

// API-Football (optional second feed): goalscorers, lineups, assists.
const AF_KEY = (function(){
  if (process.env.APIFOOTBALL_KEY) return process.env.APIFOOTBALL_KEY.trim();
  try { return (fs.readFileSync(path.join(BASE_DIR, "token-apifootball.txt"), "utf8").trim()) || null; }
  catch { return null; }
})();
const AF_BASE = "https://v3.football.api-sports.io";
const AF_LEAGUE = 1, AF_SEASON = 2026;
let afFixtureMap = {};   // ourMatchId -> provider fixtureId
const EXTRA_FILE = path.join(BASE_DIR, "matchextra.json");
// Edit PIN: lets the owner edit scores remotely. Without it, remote = view-only.
function editPin(){
  if (process.env.WC_PIN) return String(process.env.WC_PIN).trim();
  try { return fs.readFileSync(path.join(BASE_DIR, "pin.txt"), "utf8").trim(); } catch { return ""; }
}
function isLocalReq(req){
  const a = (req.socket && req.socket.remoteAddress) || "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}
// A request arriving through a tunnel/proxy (Cloudflare, ngrok, etc.) carries
// forwarding headers. Such requests reach us *from* localhost, so we must NOT
// treat them as the trusted host — otherwise a public link could edit scores.
function isProxied(req){
  const h = req.headers || {};
  return !!(h["cf-connecting-ip"] || h["x-forwarded-for"] || h["cf-ray"] || h["x-forwarded-host"] || h["forwarded"]);
}
function suppliedPin(req, url){
  const q = url.searchParams.get("pin"); if (q) return q;
  const h = req.headers["x-wc-pin"]; if (h) return String(h);
  const c = req.headers.cookie || "";
  const m = c.match(/(?:^|;\s*)wcpin=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}
function canWrite(req, url){
  if (isLocalReq(req) && !isProxied(req)) return true;     // the host PC, directly (not via a tunnel)
  const pin = editPin();
  if (pin && suppliedPin(req, url) === pin) return true;    // anyone with the right edit PIN
  return false;                                            // otherwise view-only
}
function loadExtra(){ try { return JSON.parse(fs.readFileSync(EXTRA_FILE, "utf8")); } catch { return {}; } }
function saveExtra(){ try { fs.writeFileSync(EXTRA_FILE, JSON.stringify(matchExtra)); } catch {} }
let matchExtra = loadExtra();  // ourMatchId -> { scorers:[...], lineups:{home,away} } (persisted)
let afStatus = { enabled: !!AF_KEY, ok: null, error: null, mapped: 0, lastFetch: null, blocked: false };
let afBlocked = false;        // set when the plan can't access this season
let afScorersActive = false;  // true once API-Football provides scorers

// TheSportsDB (free, no signup): goalscorers + lineups, not season-locked.
const TSDB_KEY = (function(){
  if (process.env.TSDB_KEY) return process.env.TSDB_KEY.trim();
  try { return (fs.readFileSync(path.join(BASE_DIR, "token-thesportsdb.txt"), "utf8").trim()) || "123"; }
  catch { return "123"; }
})();
const TSDB_BASE = "https://www.thesportsdb.com/api/v1/json/" + TSDB_KEY;
let tsdbEventMap = {};   // ourMatchId -> idEvent
let tsdbStatus = { enabled: true, mapped: 0, error: null, lastFetch: null };
let tsdbDebug = {};      // raw samples to help tune field parsing

// apifootball.com (paid/trial): complete real-time scores, lineups, goals, penalties.
const APIFC_KEY = (function(){
  if (process.env.APIFOOTBALLCOM_KEY) return process.env.APIFOOTBALLCOM_KEY.trim();
  try { return (fs.readFileSync(path.join(BASE_DIR, "token-apifootballcom.txt"), "utf8").trim()) || null; }
  catch { return null; }
})();
const APIFC_BASE = "https://apiv3.apifootball.com/";
let apifcLeagueId = null;
let apifcCovered = new Set();   // matches apifootball.com is authoritatively driving
let apifcStatus = { enabled: !!APIFC_KEY, ok: null, error: null, leagueId: null, covered: 0, lastFetch: null, blocked: false };
let apifcDebug = {};
let apifcTopDebug = { lastFetch: null, count: 0, sample: null, error: null };
let apifcScorersOwned = false;   // once apifootball.com supplies the Golden Boot, it's the single source

// ---- Results store ---------------------------------------------------------
// Shape: { "M01": { home: 2, away: 1 }, ... }  (only finished/known matches)
function loadResults() {
  try { return JSON.parse(fs.readFileSync(RESULTS_FILE, "utf8")); }
  catch { return {}; }
}
function saveResults(r) {
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(r, null, 2));
}
let results = loadResults();
let scorers = []; // top-scorers leaderboard, populated from the live feed
let liveInfo = {}; // matchId -> { status, minute } from the live feed

// Team crests / badges (canonical team name -> image URL), captured from the live feed.
const BADGE_FILE = path.join(BASE_DIR, "badges.json");
function loadBadges(){ try { return JSON.parse(fs.readFileSync(BADGE_FILE, "utf8")); } catch { return {}; } }
let teamBadges = loadBadges();
let badgesDirty = false;
function setBadge(team, url){
  if (!team || !url || typeof url !== "string" || !/^https?:\/\//.test(url)) return;
  if (teamBadges[team] !== url){ teamBadges[team] = url; badgesDirty = true; }
}
function saveBadges(){ if(!badgesDirty) return; try { fs.writeFileSync(BADGE_FILE, JSON.stringify(teamBadges)); badgesDirty=false; } catch {} }

// ---- Standings engine ------------------------------------------------------
function computeStandings() {
  const tables = {};
  for (const [g, teams] of Object.entries(GROUPS)) {
    tables[g] = {};
    for (const t of teams) {
      tables[g][t] = { team: t, flag: FLAGS[t] || "", P: 0, W: 0, D: 0, L: 0, GF: 0, GA: 0, GD: 0, Pts: 0 };
    }
  }
  for (const m of MATCHES) {
    const r = results[m.id];
    if (!r || r.home == null || r.away == null) continue;
    const hs = Number(r.home), as = Number(r.away);
    if (Number.isNaN(hs) || Number.isNaN(as)) continue;
    const H = tables[m.group][m.home], A = tables[m.group][m.away];
    if (!H || !A) continue;
    H.P++; A.P++;
    H.GF += hs; H.GA += as; A.GF += as; A.GA += hs;
    if (hs > as) { H.W++; A.L++; H.Pts += 3; }
    else if (hs < as) { A.W++; H.L++; A.Pts += 3; }
    else { H.D++; A.D++; H.Pts++; A.Pts++; }
  }
  const out = {};
  for (const g of Object.keys(GROUPS)) {
    const rows = Object.values(tables[g]).map(r => ({ ...r, GD: r.GF - r.GA }));
    rows.sort((a, b) =>
      b.Pts - a.Pts || b.GD - a.GD || b.GF - a.GF || a.team.localeCompare(b.team));
    const anyPlayed = rows.some(r => r.P > 0);
    rows.forEach((r, i) => {
      r.pos = i + 1;
      if (!anyPlayed) r.status = "";
      else if (i < 2) r.status = "advance";        // top two qualify
      else if (i === 2) r.status = "maybe";        // best 8 third-placed may go
      else r.status = "out";
    });
    out[g] = rows;
  }
  // Qualification — brute force over every remaining group result (exact; never a false positive).
  const remByGroup = {};
  for (const g of Object.keys(GROUPS)) remByGroup[g] = [];
  for (const m of MATCHES) {
    const r = results[m.id];
    const done = r && r.home != null && r.away != null && !Number.isNaN(Number(r.home)) && !Number.isNaN(Number(r.away));
    if (!done) remByGroup[m.group].push(m);
  }
  for (const g of Object.keys(out)) {
    const rows = out[g], n = rows.length;
    const idx = {}; rows.forEach((r, i) => { idx[r.team] = i; });
    const basePts = rows.map(r => r.Pts);
    const rem = remByGroup[g], R = rem.length;
    const maxAtOrAbove = new Array(n).fill(0);        // worst case: others with pts >= mine
    const minStrictAbove = new Array(n).fill(Infinity); // best case: others strictly above me
    const total = Math.pow(3, R);
    for (let mask = 0; mask < total; mask++) {
      const pts = basePts.slice(); let mm = mask;
      for (let k = 0; k < R; k++) {
        const o = mm % 3; mm = Math.floor(mm / 3);
        const hi = idx[rem[k].home], ai = idx[rem[k].away];
        if (o === 0) pts[hi] += 3; else if (o === 1) { pts[hi]++; pts[ai]++; } else pts[ai] += 3;
      }
      for (let i = 0; i < n; i++) {
        let aoa = 0, sa = 0;
        for (let j = 0; j < n; j++) { if (j === i) continue; if (pts[j] >= pts[i]) aoa++; if (pts[j] > pts[i]) sa++; }
        if (aoa > maxAtOrAbove[i]) maxAtOrAbove[i] = aoa;
        if (sa < minStrictAbove[i]) minStrictAbove[i] = sa;
      }
    }
    const complete = rows.every(r => r.P >= 3);
    rows.forEach((r, i) => {
      let qual = "";
      if (maxAtOrAbove[i] <= 1) qual = "in";          // guaranteed top 2 in every scenario
      else if (minStrictAbove[i] >= 3) qual = "out";  // stuck in 4th in every scenario
      if (complete) { if (i < 2) qual = "in"; else if (i === 3) qual = "out"; } // 3rd decided globally
      r.qual = qual;
    });
  }
  // Best-8 third-placed teams — only once every group is finished.
  const allComplete = Object.values(out).every(rows => rows.every(r => r.P >= 3));
  if (allComplete) {
    const thirds = Object.values(out).map(rows => rows[2]).filter(Boolean);
    thirds.sort((a, b) => b.Pts - a.Pts || b.GD - a.GD || b.GF - a.GF);
    thirds.forEach((t, i) => { t.qual = i < 8 ? "in" : "out"; });
  }
  // Plain-English "what needs to happen" for teams still in contention.
  for (const g of Object.keys(out)) {
    const rows = out[g], rem = remByGroup[g];
    const complete = rows.every(r => r.P >= 3);
    rows.forEach(r => {
      if (r.qual === "in") r.scenario = "Through to the Round of 32.";
      else if (r.qual === "out") r.scenario = "Eliminated — out of the running.";
      else if (!complete && rem.length) r.scenario = scenarioFor(rows, rem, r.team);
      else r.scenario = "";
    });
  }
  return out;
}

// Build a conservative, always-correct "what needs to happen" line for one team.
function scenarioFor(rows, rem, team) {
  const idx = {}; rows.forEach((r, i) => { idx[r.team] = i; });
  const n = rows.length, ti = idx[team], base = rows.map(r => r.Pts);
  const remT = rem.filter(g => g.home === team || g.away === team);
  const remO = rem.filter(g => g.home !== team && g.away !== team);
  if (!remT.length) return "";
  const apply = (pts, games, outs) => { games.forEach((g, k) => {
    const h = idx[g.home], a = idx[g.away], o = outs[k];
    if (o === 0) pts[h] += 3; else if (o === 1) { pts[h]++; pts[a]++; } else pts[a] += 3;
  }); return pts; };
  // T's own games set to a chosen result: win / draw / loss
  const tOuts = res => remT.map(g => {
    const tHome = g.home === team;
    if (res === "win") return tHome ? 0 : 2;
    if (res === "draw") return 1;
    return tHome ? 2 : 0;
  });
  // For a given T result, scan every combination of the OTHER games.
  const scan = res => {
    let guaranteed = true, possible = false, worst = 0;
    const R = remO.length, total = Math.pow(3, R);
    for (let mask = 0; mask < total; mask++) {
      const outs = []; let mm = mask;
      for (let k = 0; k < R; k++) { outs.push(mm % 3); mm = Math.floor(mm / 3); }
      const pts = apply(base.slice(), remT, tOuts(res));
      apply(pts, remO, outs);
      let aoa = 0; for (let j = 0; j < n; j++) { if (j !== ti && pts[j] >= pts[ti]) aoa++; }
      if (aoa > worst) worst = aoa;
      if (aoa <= 1) possible = true; else guaranteed = false;
    }
    return { guaranteed, possible, worst };
  };
  const win = scan("win"), draw = scan("draw"), loss = scan("loss");
  const last = remT.length > 1 ? "their final games" : "their final game";
  let msg;
  if (draw.guaranteed) msg = "Avoid defeat in " + last + " to be sure of a top-two place.";
  else if (win.guaranteed) msg = (remT.length > 1 ? "Win out" : "Win") + " to lock up a top-two place in the group.";
  else if (win.possible) msg = "Need to win " + last + " — and hope other results help — to reach the top two.";
  else msg = "Can\u2019t reach the top two now; their hopes rest on being one of the eight best third-placed teams.";
  // Third-place lifeline: if even a loss leaves them no worse than 3rd.
  if (!draw.guaranteed && win.possible && loss.worst <= 2)
    msg += " Even a slip may not be fatal — third place could still go through.";
  return msg;
}

function buildState() {
  return {
    tournament: TOURNAMENT,
    version: VERSION,
    groups: GROUPS,
    matches: MATCHES.map(m => ({ ...m, result: results[m.id] || null })),
    standings: computeStandings(),
    scorers,
    liveInfo,
    matchExtra,
    afStatus,
    tsdbStatus,
    apifcStatus,
    badges: teamBadges,
    phoneUrl: (lanIP() ? "http://" + lanIP() + ":" + PORT : null),
    updated: new Date().toISOString()
  };
}

// ---- Optional live-score provider (football-data.org, free tier) -----------
// Enable by exporting WC_API_TOKEN before launching. Safe no-op if unset or
// if the network/competition is unavailable — manual entry always works.
// Normalize a country name: strip accents/punctuation, lowercase, "&"->"and".
function norm(s) {
  return (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
}
// Map the provider's spellings onto the names this app uses.
const NAME_ALIASES = {
  czechrepublic: "Czechia",
  korearepublic: "South Korea", republicofkorea: "South Korea",
  unitedstates: "USA", unitedstatesofamerica: "USA",
  turkey: "Türkiye",
  cotedivoire: "Ivory Coast",
  caboverde: "Cape Verde", capeverdeislands: "Cape Verde",
  holland: "Netherlands", thenetherlands: "Netherlands",
  congodr: "DR Congo", drcongo: "DR Congo",
  democraticrepublicofthecongo: "DR Congo", democraticrepublicofcongo: "DR Congo",
  iriran: "Iran",
  bosniaandherzegovina: "Bosnia & Herzegovina",
  bosniaherzegovina: "Bosnia & Herzegovina",
  southkorea: "South Korea"
};
// Index of this app's own team names by normalized form.
const NORM_INDEX = {};
for (const team of Object.keys(FLAGS)) NORM_INDEX[norm(team)] = team;
function resolveTeam(apiName) {
  const n = norm(apiName);
  return NAME_ALIASES[n] || NORM_INDEX[n] || null;
}

async function refreshLive() {
  const token = API_TOKEN;
  if (!token) return;
  try {
    const res = await fetch("https://api.football-data.org/v4/competitions/WC/matches", {
      headers: { "X-Auth-Token": token }
    });
    if (!res.ok) { console.warn("[live] provider responded", res.status, "(matches may not be open on the free tier yet)"); return; }
    const data = await res.json();
    let changed = 0, unmatched = 0, liveCount = 0;
    const seenLive = {};
    for (const fx of data.matches || []) {
      const isLive = fx.status === "IN_PLAY" || fx.status === "PAUSED";
      if (!["FINISHED", "IN_PLAY", "PAUSED"].includes(fx.status)) continue;
      let hs = fx.score?.fullTime?.home, as = fx.score?.fullTime?.away;
      if (hs == null || as == null) { hs = 0; as = 0; } // in-play before first goal
      const H = resolveTeam(fx.homeTeam?.name);
      const A = resolveTeam(fx.awayTeam?.name);
      if (!H || !A) { unmatched++; continue; }
      // Find the matching fixture (try as-is, then swapped, swapping the score too).
      let m = MATCHES.find(x => x.home === H && x.away === A), sh = hs, sa = as;
      if (!m) { m = MATCHES.find(x => x.home === A && x.away === H); if (m) { sh = as; sa = hs; } }
      if (!m) { unmatched++; continue; }
      if (apifcCovered.has(m.id)) continue; // apifootball.com owns this match
      if (isLive) { liveCount++; seenLive[m.id] = { status: fx.status, minute: fx.minute ?? null }; }
      else if (fx.status === "FINISHED") { seenLive[m.id] = { status: "FINISHED", minute: null }; }
      const cur = results[m.id];
      if (!cur || cur.home !== sh || cur.away !== sa) {
        results[m.id] = { home: sh, away: sa, source: "live" };
        changed++;
      }
    }
    for (const k in liveInfo) { if (apifcCovered.has(k)) seenLive[k] = liveInfo[k]; }
    liveInfo = seenLive;
    if (changed) { saveResults(results); console.log(`[live] updated ${changed} match(es)`); }
    if (unmatched) console.warn(`[live] ${unmatched} provider match(es) could not be name-matched`);
    return liveCount;
  } catch (e) {
    console.warn("[live] fetch failed:", e.message);
    return 0;
  }
}

// Top-scorers leaderboard (free tier exposes goals per player; assists/penalties
// may be null on free and are simply hidden when absent).
async function refreshScorers() {
  const token = API_TOKEN;
  if (!token || afScorersActive) return;
  if (apifcScorersOwned) return;   // apifootball.com is the authoritative Golden Boot source
  try {
    const res = await fetch("https://api.football-data.org/v4/competitions/WC/scorers?limit=30", {
      headers: { "X-Auth-Token": token }
    });
    if (!res.ok) { console.warn("[scorers] provider responded", res.status); return; }
    const data = await res.json();
    scorers = (data.scorers || []).map(s => ({
      name: s.player?.name || "Unknown",
      team: resolveTeam(s.team?.name) || s.team?.name || "",
      flag: FLAGS[resolveTeam(s.team?.name)] || "",
      goals: s.goals ?? 0,
      assists: s.assists,           // may be null on free tier
      matches: s.playedMatches ?? null
    })).filter(s => s.goals > 0);
    if (scorers.length) console.log(`[scorers] leaderboard: ${scorers.length} players`);
  } catch (e) {
    console.warn("[scorers] fetch failed:", e.message);
  }
}

async function afFetch(pathq){
  const res = await fetch(AF_BASE + pathq, { headers: { "x-apisports-key": AF_KEY } });
  const json = await res.json().catch(()=>({}));
  const errs = json.errors;
  if (errs && (Array.isArray(errs) ? errs.length : Object.keys(errs).length)) {
    afStatus.error = JSON.stringify(errs);
    const es = afStatus.error.toLowerCase();
    if (es.includes("season") || es.includes("plan") || es.includes("subscription")) {
      afBlocked = true; afStatus.blocked = true;
      console.warn("[api-football] free plan cannot access this season — disabling player-stats feed, scores unaffected");
    } else {
      console.warn("[api-football] API error:", afStatus.error);
    }
  }
  return json;
}

// Map this season's World Cup fixtures to our matches by team names.
async function afMapFixtures(){
  if (!AF_KEY || afBlocked) return;
  try {
    const j = await afFetch(`/fixtures?league=${AF_LEAGUE}&season=${AF_SEASON}`);
    const arr = j.response || [];
    let mapped = 0; afFixtureMap = {};
    for (const fx of arr){
      const H = resolveTeam(fx.teams?.home?.name), A = resolveTeam(fx.teams?.away?.name);
      if (!H || !A) continue;
      const m = MATCHES.find(x=>x.home===H && x.away===A) || MATCHES.find(x=>x.home===A && x.away===H);
      if (m){ afFixtureMap[m.id] = fx.fixture?.id; mapped++; }
    }
    afStatus.mapped = mapped; afStatus.ok = arr.length > 0; afStatus.lastFetch = new Date().toISOString();
    console.log(`[api-football] mapped ${mapped}/${MATCHES.length} fixtures (provider returned ${arr.length})`);
    if (arr.length === 0) console.warn("[api-football] no WC fixtures returned — your free tier may not cover this competition/season");
  } catch(e){ afStatus.error = e.message; console.warn("[api-football] map failed:", e.message); }
}

// Goals (with assists) + lineups for the given fixture ids, batched into one call.
async function afRefreshDetails(ids){
  if (!AF_KEY || afBlocked || !ids.length) return;
  try {
    const j = await afFetch(`/fixtures?ids=${ids.join("-")}`);
    for (const fx of j.response || []){
      const fid = fx.fixture?.id;
      const mid = Object.keys(afFixtureMap).find(k=>afFixtureMap[k]===fid);
      if (!mid) continue;
      const ours = MATCHES.find(x=>x.id===mid);
      const scorers = (fx.events||[])
        .filter(e=>e.type==="Goal" && e.detail!=="Missed Penalty")
        .map(e=>({
          name: e.player?.name || "?",
          team: resolveTeam(e.team?.name) || e.team?.name || "",
          minute: e.time?.elapsed!=null ? (e.time.elapsed + (e.time.extra?("+"+e.time.extra):"") + "'") : "",
          detail: e.detail || "", assist: e.assist?.name || null
        }));
      const luFor = name => {
        const lu = (fx.lineups||[]).find(l=>resolveTeam(l.team?.name)===name);
        return lu ? { formation: lu.formation || "", xi: (lu.startXI||[]).map(p=>p.player?.name).filter(Boolean) } : null;
      };
      matchExtra[mid] = { scorers, lineups: { home: luFor(ours?.home), away: luFor(ours?.away) } };
    }
  } catch(e){ console.warn("[api-football] details failed:", e.message); }
}

// Richer top scorers (goals + assists) from API-Football.
async function afTopScorers(){
  if (!AF_KEY || afBlocked) return;
  if (apifcScorersOwned) return;   // apifootball.com is the authoritative source
  try {
    const j = await afFetch(`/players/topscorers?league=${AF_LEAGUE}&season=${AF_SEASON}`);
    const arr = j.response || [];
    if (!arr.length) return;
    scorers = arr.map(r=>{
      const st = (r.statistics && r.statistics[0]) || {};
      const team = resolveTeam(st.team?.name) || st.team?.name || "";
      return { name: r.player?.name || "?", team, flag: FLAGS[team] || "",
        goals: st.goals?.total || 0, assists: st.goals?.assists ?? null,
        matches: st.games?.appearences ?? null };
    }).filter(s=>s.goals>0);
    if (scorers.length) afScorersActive = true;
    console.log(`[api-football] top scorers: ${scorers.length}`);
  } catch(e){ console.warn("[api-football] topscorers failed:", e.message); }
}

// Poll live (or about-to-start) fixtures for goals/lineups; relax when idle.
async function afLoop(){
  const ids = [];
  for (const m of MATCHES){
    const fid = afFixtureMap[m.id]; if(!fid) continue;
    const ko = new Date(m.kickoff).getTime(), now = Date.now();
    const li = liveInfo[m.id];
    const liveish = (li && (li.status==="IN_PLAY"||li.status==="PAUSED")) ||
                    (now >= ko - 40*60000 && now <= ko + 2.5*3600*1000);
    if (liveish) ids.push(fid);
  }
  if (afBlocked) return;
  if (ids.length) await afRefreshDetails(ids.slice(0,20));
  if (!afBlocked) setTimeout(afLoop, ids.length ? 15*60*1000 : 30*60*1000);
}

async function tsdbFetch(pathq){
  const res = await fetch(TSDB_BASE + pathq);
  return await res.json().catch(()=>({}));
}
// Resolve a TheSportsDB team name to one of our 48 teams: exact alias first,
// then a fuzzy fallback (one name contains the other) for odd spellings.
function tsdbResolve(name){
  const r = resolveTeam(name);
  if (r) return r;
  const n = norm(name);
  if (!n) return null;
  for (const team of Object.keys(FLAGS)){
    const tn = norm(team);
    if (tn === n) return team;
    if (n.length >= 4 && (tn.includes(n) || n.includes(tn))) return team;
  }
  return null;
}
async function tsdbMapDay(dateStr){
  const j = await tsdbFetch(`/eventsday.php?d=${dateStr}&s=Soccer`);
  const evs = j.events || [];
  // Keep only World Cup events (league 4429), so diagnostics stay readable.
  const wc = evs.filter(e => String(e.idLeague)==="4429" ||
                             (e.strLeague||"").toLowerCase().includes("world cup"));
  for (const e of wc){
    const H = tsdbResolve(e.strHomeTeam), A = tsdbResolve(e.strAwayTeam);
    const m = (H&&A) ? (MATCHES.find(x=>x.home===H && x.away===A) ||
                        MATCHES.find(x=>x.home===A && x.away===H)) : null;
    if (m && e.idEvent) tsdbEventMap[m.id] = e.idEvent;
    // record every WC event we see, matched or not, for tuning
    tsdbDebug.wcEvents = (tsdbDebug.wcEvents||[]);
    tsdbDebug.wcEvents.push({ date: dateStr, home: e.strHomeTeam, away: e.strAwayTeam,
      league: e.strLeague, resolvedHome: H, resolvedAway: A, matched: !!m });
  }
}
async function tsdbMapSeason(season){
  const j = await tsdbFetch(`/eventsseason.php?id=4429&s=${season}`);
  const evs = j.events || [];
  for (const e of evs){
    const H = tsdbResolve(e.strHomeTeam), A = tsdbResolve(e.strAwayTeam);
    const m = (H&&A) ? (MATCHES.find(x=>x.home===H && x.away===A) ||
                        MATCHES.find(x=>x.home===A && x.away===H)) : null;
    if (m && e.idEvent) tsdbEventMap[m.id] = e.idEvent;
    tsdbDebug.wcEvents = (tsdbDebug.wcEvents||[]);
    tsdbDebug.wcEvents.push({ src:"season", home:e.strHomeTeam, away:e.strAwayTeam,
      resolvedHome:H, resolvedAway:A, matched:!!m });
  }
  return evs.length;
}
async function tsdbMap(){
  if (!TSDB_KEY) return;
  try {
    tsdbDebug.wcEvents = [];
    const d = x => new Date(x).toISOString().slice(0,10);
    // yesterday / today / tomorrow (UTC) covers any date-convention boundary
    await tsdbMapDay(d(Date.now() - 86400000));
    await tsdbMapDay(d(Date.now()));
    await tsdbMapDay(d(Date.now() + 86400000));
    // season feed lists upcoming fixtures earlier than the day feed does
    let n = await tsdbMapSeason("2026");
    if (!n) await tsdbMapSeason("2026-2027"); // league lists current season this way
    tsdbStatus.mapped = Object.keys(tsdbEventMap).length;
    tsdbStatus.lastFetch = new Date().toISOString();
    console.log(`[thesportsdb] mapped ${tsdbStatus.mapped} match(es); saw ${tsdbDebug.wcEvents.length} WC event(s)`);
  } catch(e){ tsdbStatus.error = e.message; console.warn("[thesportsdb] map failed:", e.message); }
}
function tsdbTruthy(v){ return v==="Yes" || v===true || v==="1" || v===1; }
async function tsdbDetailsFor(mid, idEvent){
  try {
    const tj = await tsdbFetch(`/lookuptimeline.php?id=${idEvent}`);
    if (tj.timeline) tsdbDebug.lastTimelineSample = (tj.timeline||[]).slice(0,3);
    const goals = (tj.timeline||[]).filter(t=>{
      const ty = ((t.strTimeline||"")+" "+(t.strTimelineDetail||"")).toLowerCase();
      return ty.includes("goal");
    }).map(t=>{
      const dl = ((t.strTimelineDetail||t.strTimeline||"")+"").toLowerCase();
      const detail = dl.includes("penalty") ? "Penalty" : dl.includes("own") ? "Own Goal" : "Normal Goal";
      return { name: t.strPlayer || "?", team: resolveTeam(t.strTeam) || t.strTeam || "",
        minute: (t.intTime!=null && t.intTime!=="") ? (t.intTime+"'") : "",
        detail, assist: t.strAssist || null };
    });
    const lj = await tsdbFetch(`/lookuplineup.php?id=${idEvent}`);
    if (lj.lineup) tsdbDebug.lastLineupSample = (lj.lineup||[]).slice(0,3);
    const xiFor = (isHome)=>{
      const players = (lj.lineup||[])
        .filter(p => tsdbTruthy(p.strHome)===isHome && !tsdbTruthy(p.strSubstitute))
        .map(p => p.strPlayer).filter(Boolean);
      return players.length ? { formation: "", xi: players } : null;
    };
    const lineups = { home: xiFor(true), away: xiFor(false) };
    // Merge with what we already have so a sparse later fetch never shrinks good data.
    const prev = matchExtra[mid] || { scorers: [], lineups: { home: null, away: null } };
    const bestLU = (a,b)=>{ const al=((a&&a.xi)||[]).length, bl=((b&&b.xi)||[]).length; return al>=bl ? (a||b||null) : (b||null); };
    const merged = {
      scorers: goals.length >= (prev.scorers||[]).length ? goals : prev.scorers,
      lineups: { home: bestLU(lineups.home, prev.lineups && prev.lineups.home),
                 away: bestLU(lineups.away, prev.lineups && prev.lineups.away) }
    };
    if ((merged.scorers && merged.scorers.length) || merged.lineups.home || merged.lineups.away){
      matchExtra[mid] = merged;
      saveExtra();
    }
  } catch(e){ console.warn("[thesportsdb] details failed:", e.message); }
}
async function tsdbLoop(){
  if (!TSDB_KEY) return;
  const now = Date.now();
  let active = 0;
  for (const m of MATCHES){
    const id = tsdbEventMap[m.id]; if(!id) continue;
    if (apifcCovered.has(m.id)) continue; // apifootball.com is richer; let it own this match
    const since = now - new Date(m.kickoff).getTime();
    if (since < -45*60*1000 || since > 18*60*60*1000) continue; // roughly "today"
    // Stop re-polling a finished match once both lineups look complete.
    const ex = matchExtra[m.id];
    const full = ex && ex.lineups && ex.lineups.home && ex.lineups.away &&
                 ex.lineups.home.xi.length >= 11 && ex.lineups.away.xi.length >= 11;
    if (full && since > 3*60*60*1000) continue;
    await tsdbDetailsFor(m.id, id); active++;
  }
  setTimeout(tsdbLoop, active ? 8*60*1000 : 30*60*1000);
}

async function apifcFetch(params){
  const url = APIFC_BASE + "?" + params + "&APIkey=" + encodeURIComponent(APIFC_KEY);
  const res = await fetch(url);
  const j = await res.json().catch(()=>null);
  if (j && !Array.isArray(j) && (j.error || j.message)){
    apifcStatus.error = String(j.message || j.error).slice(0,200);
    const e = apifcStatus.error.toLowerCase();
    if (e.includes("not authoriz") || e.includes("invalid key") || e.includes("no record") ||
        e.includes("subscription") || e.includes("not in your") || e.includes("credit")){
      apifcStatus.blocked = true;
    }
  }
  return j;
}
async function apifcDiscoverLeague(){
  if (!APIFC_KEY) return;
  const j = await apifcFetch("action=get_leagues");
  if (!Array.isArray(j)) return;
  const cand = j.filter(L=>{
    const n=(L.league_name||"").toLowerCase();
    return n.includes("world cup") && !n.includes("qualif") && !n.includes("women") &&
           !/u-?\d/.test(n) && !n.includes("youth");
  });
  const pick = cand.find(L=>/international|world/i.test((L.country_name||""))) || cand[0];
  if (pick){ apifcLeagueId = pick.league_id; apifcStatus.leagueId = pick.league_id; }
  apifcDebug.leagueCandidates = cand.slice(0,8).map(L=>({id:L.league_id, name:L.league_name, country:L.country_name}));
  console.log("[apifootball.com] World Cup league_id = " + apifcLeagueId);
}
function apifcDetail(info){ const i=(info||"").toLowerCase(); return i.includes("penalty")?"Penalty":i.includes("own")?"Own Goal":"Normal Goal"; }
function apifcLiveOf(ev){
  const st=((ev.match_status==null?"":ev.match_status)+"").trim();
  // Status text wins: at the break apifootball sends match_live="1" AND match_status="Half Time".
  if (/half/i.test(st) || /^ht$/i.test(st)) return { status:"PAUSED", minute:null };
  if (/finish|aet|after|pen/i.test(st)) return { status:"FINISHED", minute:null };
  if (ev.match_live==="1" || /^\d+/.test(st)) return { status:"IN_PLAY", minute:(/^\d+/.test(st)?parseInt(st):null) };
  return null;
}
async function apifcRefresh(fromDate, toDate){
  if (!APIFC_KEY || apifcStatus.blocked) return;
  if (!apifcLeagueId){ await apifcDiscoverLeague(); if (!apifcLeagueId) return; }
  const d=x=>new Date(x).toISOString().slice(0,10);
  const from = fromDate || d(Date.now()-86400000);
  const to   = toDate   || d(Date.now()+86400000);
  const j = await apifcFetch("action=get_events&from="+from+"&to="+to+"&league_id="+apifcLeagueId);
  if (!Array.isArray(j)) return;
  apifcDebug.sample = j.slice(0,1);
  let covered=0, changed=false;
  for (const ev of j){
    const H=resolveTeam(ev.match_hometeam_name), A=resolveTeam(ev.match_awayteam_name);
    const m=(H&&A)?(MATCHES.find(x=>x.home===H&&x.away===A)||MATCHES.find(x=>x.home===A&&x.away===H)):null;
    if (!m) continue;
    const hs=ev.match_hometeam_score, as=ev.match_awayteam_score;
    const haveScore = hs!=="" && as!=="" && hs!=null && as!=null && !isNaN(+hs) && !isNaN(+as);
    const swapped = (H===m.away); // event home is our away
    if (haveScore){
      const home = swapped?+as:+hs, away = swapped?+hs:+as;
      const cur=results[m.id];
      if (!cur || cur.home!==home || cur.away!==away){ results[m.id]={home,away,source:"apifc"}; changed=true; }
    }
    const li=apifcLiveOf(ev); if(li) liveInfo[m.id]=li;
    // team crests (tied to the event's own home/away, no swap needed)
    setBadge(H, ev.team_home_badge); setBadge(A, ev.team_away_badge);
    const goals=[];
    for (const g of (ev.goalscorer||[])){
      if (g.home_scorer && (g.home_scorer+"").trim())
        goals.push({ name:g.home_scorer, team:resolveTeam(ev.match_hometeam_name)||ev.match_hometeam_name,
          minute:(g.time?g.time+"'":""), detail:apifcDetail(g.info), assist:g.home_assist||null });
      if (g.away_scorer && (g.away_scorer+"").trim())
        goals.push({ name:g.away_scorer, team:resolveTeam(ev.match_awayteam_name)||ev.match_awayteam_name,
          minute:(g.time?g.time+"'":""), detail:apifcDetail(g.info), assist:g.away_assist||null });
    }
    const xi=(side,sys)=>{ const a=(ev.lineup&&ev.lineup[side]&&ev.lineup[side].starting_lineups)||[];
      const names=a.map(p=>p.lineup_player).filter(Boolean);
      const pitch=a.map(p=>({n:p.lineup_player, num:p.lineup_number, p:parseInt(p.lineup_position)||0})).filter(x=>x.n);
      return names.length?{formation:(sys||""),xi:names,pitch:pitch}:null; };
    // event home/away -> our home/away (handle swap)
    const luEvHome=xi("home", ev.match_hometeam_system), luEvAway=xi("away", ev.match_awayteam_system);
    const lineups = swapped ? { home:luEvAway, away:luEvHome } : { home:luEvHome, away:luEvAway };
    // cards (red/yellow) with the player who received them
    const cards=[];
    for (const c of (ev.cards||[])){
      const type=/red/i.test(c.card||"")?"red":"yellow";
      if (c.home_fault && (c.home_fault+"").trim()) cards.push({ minute:c.time, player:c.home_fault, team:swapped?A:H, type });
      if (c.away_fault && (c.away_fault+"").trim()) cards.push({ minute:c.time, player:c.away_fault, team:swapped?H:A, type });
    }
    // key match statistics (deduped; apifootball repeats a few)
    const WANT=["Ball Possession","Shots Total","Shots On Goal","Shots Off Goal","Corners","Fouls","Offsides","Yellow Cards","Red Cards","Saves"];
    const seen={}; const statsRaw=(ev.statistics||[]).filter(st=>WANT.includes(st.type) && !seen[st.type] && (seen[st.type]=1));
    const stats = statsRaw.map(st=> swapped ? {type:st.type, home:st.away, away:st.home} : {type:st.type, home:st.home, away:st.away});
    // substitutions ("PlayerOff | PlayerOn")
    const subs=[];
    const addSubs=(arr, team)=>{ for(const s of (arr||[])){
      const p=(s.substitution||"").split("|").map(x=>x.trim());
      if(p[0]||p[1]) subs.push({ minute:s.time, off:p[0]||"", on:p[1]||"", team });
    } };
    if (ev.substitutions){ addSubs(ev.substitutions.home, swapped?A:H); addSubs(ev.substitutions.away, swapped?H:A); }
    if (goals.length || lineups.home || lineups.away || cards.length || stats.length || subs.length){
      matchExtra[m.id]={scorers:goals, lineups, cards, stats, subs}; saveExtra();
    }
    apifcCovered.add(m.id); covered++;
  }
  if (changed) saveResults(results);
  saveBadges();
  apifcStatus.covered=covered; apifcStatus.totalResults=Object.keys(results).length; apifcStatus.ok=true; apifcStatus.lastFetch=new Date().toISOString();
}
async function apifcLoop(){
  if (!APIFC_KEY || apifcStatus.blocked) return;
  try { await apifcRefresh(); } catch(e){ apifcStatus.error=e.message; }
  if (apifcStatus.blocked) return;
  const anyLive = MATCHES.some(m=>{ const li=liveInfo[m.id]; return li&&(li.status==="IN_PLAY"||li.status==="PAUSED"); });
  setTimeout(apifcLoop, anyLive ? 60*1000 : 5*60*1000);
}

// Pull the WHOLE tournament once (and periodically) so a fresh server (e.g. a cloud
// host with no saved results.json) shows full standings, not just the last few days.
const SEASON_FROM = (function(){ const ds=MATCHES.map(m=>m.date).filter(Boolean).sort(); return ds[0] || "2026-06-11"; })();
const SEASON_TO   = (function(){ const ds=MATCHES.map(m=>m.date).filter(Boolean).sort(); const last=ds[ds.length-1] || "2026-07-19";
  return new Date(new Date(last).getTime()+2*86400000).toISOString().slice(0,10); })();
async function apifcBackfill(){
  if (!APIFC_KEY || apifcStatus.blocked) return;
  try {
    await apifcRefresh(SEASON_FROM, SEASON_TO); apifcStatus.backfilled = true;
    console.log("[apifootball.com] full-tournament sync ("+SEASON_FROM+" → "+SEASON_TO+"): "+Object.keys(results).length+" results on record");
  } catch(e){ apifcStatus.error = e.message; }
}

// Dedicated, complete Golden Boot list straight from apifootball.com (includes assists when provided).
async function apifcTopScorers(){
  if (!APIFC_KEY || apifcStatus.blocked) return;
  if (!apifcLeagueId){ await apifcDiscoverLeague(); if (!apifcLeagueId) return; }
  try {
    const j = await apifcFetch("action=get_topscorers&league_id=" + apifcLeagueId);
    if (!Array.isArray(j)){
      apifcTopDebug.error = (j && (j.message || j.error)) ? String(j.message || j.error).slice(0,200) : "no array returned";
      return;
    }
    const list = j.map(r=>{
      const team = resolveTeam(r.team_name) || r.team_name || "";
      const g = parseInt(r.goals, 10);
      const a = (r.assists !== undefined && r.assists !== "" && r.assists !== null) ? parseInt(r.assists, 10) : null;
      return {
        name: r.player_name || r.player || "Unknown",
        team,
        flag: FLAGS[team] || "",
        goals: Number.isNaN(g) ? 0 : g,
        assists: (a === null || Number.isNaN(a)) ? null : a,
        matches: null
      };
    }).filter(s => s.name !== "Unknown");
    // Rank by the Golden Boot tiebreakers: goals, then assists (provider order isn't reliable).
    list.sort((a,b)=> b.goals - a.goals || ((b.assists||0) - (a.assists||0)));
    if (list.length){ scorers = list; apifcScorersOwned = true; }   // becomes the Golden Boot leaderboard
    apifcTopDebug = { lastFetch: new Date().toISOString(), count: list.length, sample: j.slice(0,3), error: null };
  } catch(e){ apifcTopDebug.error = String(e.message || e).slice(0,200); }
}



if (API_TOKEN) {
  // Adaptive polling: when a match is in play, refresh quickly (every 15s);
  // otherwise relax to once a minute. Both stay within the free 10-req/min cap.
  const LIVE_MS = 15_000, IDLE_MS = 60_000;
  async function liveLoop() {
    let live = 0;
    try { live = await refreshLive(); } catch {}
    setTimeout(liveLoop, live > 0 ? LIVE_MS : IDLE_MS);
  }
  liveLoop();
  refreshScorers(); setInterval(refreshScorers, 120_000);
}

if (AF_KEY) {
  afMapFixtures().then(afLoop);
  afTopScorers();
  setInterval(afTopScorers, 30*60*1000);
  setInterval(afMapFixtures, 12*60*60*1000);
}

if (TSDB_KEY) {
  tsdbMap().then(tsdbLoop);
  setInterval(tsdbMap, 60*60*1000);
}

if (APIFC_KEY) {
  apifcDiscoverLeague().then(async ()=>{
    await apifcBackfill();      // whole tournament first, so standings are complete on a fresh server
    apifcLoop();                // then keep the live window fresh
    apifcTopScorers();
  });
  setInterval(apifcBackfill, 30*60*1000);     // re-sync the full table every 30 min
  setInterval(apifcTopScorers, 10*60*1000);   // refresh the Golden Boot every 10 min
}


// ---- PWA assets (manifest, service worker, icons) --------------------------
const ICONS = {
  "/icon-192.png": "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",
  "/icon-512.png": "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",
  "/apple-touch-icon.png": "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"
};
const MANIFEST = JSON.stringify({
  name: "World Cup 2026 Tracker", short_name: "WC 2026",
  start_url: "/", scope: "/", display: "standalone",
  background_color: "#080a14", theme_color: "#080a14",
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" }
  ]
});
const SW_JS = `const C="wc2026-shell-v3";
self.addEventListener("install",e=>{self.skipWaiting();});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.map(k=>caches.delete(k))))).then(()=>self.clients.claim());});
self.addEventListener("fetch",e=>{
  const u=new URL(e.request.url);
  if(u.pathname.startsWith("/api")) return; // always network for data
  // Network-first: load the freshest page when online, fall back to cache offline.
  e.respondWith(
    fetch(e.request).then(resp=>{ const cp=resp.clone(); caches.open(C).then(c=>c.put(e.request,cp)); return resp; })
                    .catch(()=>caches.match(e.request).then(r=>r||caches.match("/")))
  );
});`;

// ---- HTTP server -----------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(PAGE);
  }

  if (url.pathname === "/manifest.webmanifest") {
    res.writeHead(200, { "Content-Type": "application/manifest+json" });
    return res.end(MANIFEST);
  }
  if (url.pathname === "/sw.js") {
    res.writeHead(200, { "Content-Type": "text/javascript" });
    return res.end(SW_JS);
  }
  if (ICONS[url.pathname]) {
    res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "max-age=86400" });
    return res.end(Buffer.from(ICONS[url.pathname], "base64"));
  }

  if (url.pathname === "/api/debug" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ afStatus, tsdbStatus, tsdbMapped: Object.keys(tsdbEventMap).length,
      tsdbDebug, apifcStatus, apifcDebug, apifcTopDebug,
      scorersCount: scorers.length,
      mappedFixtures: Object.keys(afFixtureMap).length,
      sampleExtra: Object.fromEntries(Object.entries(matchExtra).slice(0,3)), liveInfo }, null, 2));
  }
  if (url.pathname === "/api/state" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    const st = buildState();
    st.readOnly = !canWrite(req, url);
    st.pinSet = !!editPin();
    return res.end(JSON.stringify(st));
  }

  if (url.pathname === "/api/result" && req.method === "POST") {
    if (!canWrite(req, url)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "read-only" }));
    }
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", () => {
      try {
        const { matchId, home, away } = JSON.parse(body || "{}");
        if (!matchId || !MATCHES.some(m => m.id === matchId))
          throw new Error("unknown matchId");
        if (home === "" || away === "" || home == null || away == null) {
          delete results[matchId];                       // clear a result
        } else {
          const h = Number(home), a = Number(away);
          if (Number.isNaN(h) || Number.isNaN(a) || h < 0 || a < 0)
            throw new Error("invalid score");
          results[matchId] = { home: h, away: a, source: "manual" };
        }
        saveResults(results);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, standings: computeStandings() }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (url.pathname === "/api/reset" && req.method === "POST") {
    if (!canWrite(req, url)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "read-only" }));
    }
    results = {};
    saveResults(results);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`\n  ⚽  2026 World Cup tracker running`);
  console.log(`      →  http://localhost:${PORT}\n`);
  const ip = lanIP();
  if (ip) {
    console.log(`      📱  On your phone (same Wi-Fi):  http://${ip}:${PORT}`);
    console.log(`          Open that in your phone's browser, then use the browser`);
    console.log(`          menu → "Add to Home screen" to install it as an app.\n`);
  }
  console.log(`      Live auto-update: ${API_TOKEN ? "ON" : "OFF (using free live feeds)"}`);
  console.log(`      Player stats (API-Football): ${AF_KEY ? "ON" : "OFF"}`);
  console.log(`      Goals & lineups (TheSportsDB): ${TSDB_KEY ? "ON (free)" : "OFF"}`);
  console.log(`      Real-time (apifootball.com): ${APIFC_KEY ? "ON" : "OFF"}`);
  console.log(`      Version: ${VERSION}\n`);
});

// ============================================================================
//  Frontend (served as a single page)
// ============================================================================
const PAGE = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>World Cup 2026 · Live Group Tracker</title>
<meta name="theme-color" content="#080a14">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="WC 2026">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Oswald:wght@300;400;500;600;700&family=Mulish:ital,wght@0,400;0,500;0,600;0,700;0,800;1,400&display=swap" rel="stylesheet">
<style>
  :root{
    --bg:#070b12; --bg2:#0b111c; --panel:#101a28; --panel2:#0b1320;
    --line:#1c2738; --line2:#2b3a52;
    --ink:#eaf2ff; --muted:#8595ad; --faint:#566578;
    --pitch:#19e57c;
    --live:#ff2d55; --gold:#ffd23f;
    --advance:#19e57c; --maybe:#ffd23f; --out:#3c485f;
    --shadow:0 22px 60px rgba(0,0,0,.66);
    /* broadcast accent set (cool, disciplined) */
    --c1:#2bd9ff; --c2:#19e57c; --c3:#ffd23f; --c4:#ff5d73; --c5:#5b8cff; --c6:#11b3a6;
    --hero:linear-gradient(100deg,#2f7bff,#13d0ff,#19e57c);
  }
  *{box-sizing:border-box}
  html,body{margin:0}
  body{
    background:
      radial-gradient(1100px 600px at 82% -12%, rgba(43,217,255,.12), transparent 60%),
      radial-gradient(900px 520px at 2% 6%, rgba(25,229,124,.08), transparent 60%),
      linear-gradient(180deg, #0a121e 0%, var(--bg) 58%);
    color:var(--ink); font-family:"Mulish",sans-serif;
    -webkit-font-smoothing:antialiased; min-height:100vh;
  }
  body::after{ /* broadcast accent rail */
    content:"";position:fixed;top:0;left:0;right:0;height:3px;z-index:5;
    background:var(--hero);background-size:200% 100%;animation:slide 9s linear infinite;
    box-shadow:0 0 18px rgba(43,217,255,.35);
  }
  @keyframes slide{to{background-position:200% 0}}
  body::before{ content:""; position:fixed; inset:0; pointer-events:none; opacity:.035;
    background-image:repeating-linear-gradient(115deg,#fff 0 1px,transparent 1px 76px);
  }
  .wrap{max-width:1180px;margin:0 auto;padding:28px 22px 80px}

  /* Header */
  header.top{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;flex-wrap:wrap;
    border-bottom:1px solid var(--line);padding-bottom:22px;margin-bottom:26px}
  .brand{display:flex;flex-direction:column;gap:6px}
  .kicker{font-family:"Oswald";font-weight:600;letter-spacing:.32em;text-transform:uppercase;
    font-size:11px;display:flex;align-items:center;gap:9px;color:var(--ink)}
  .kicker .dots{display:inline-flex;gap:4px}
  .kicker .dots i{width:8px;height:8px;border-radius:50%}
  .kicker .dots i:nth-child(1){background:var(--c1)}
  .kicker .dots i:nth-child(2){background:var(--c3)}
  .kicker .dots i:nth-child(3){background:var(--c5)}
  h1{font-family:"Oswald";font-weight:700;font-style:italic;letter-spacing:.004em;text-transform:uppercase;
    font-size:clamp(36px,6.4vw,66px);line-height:.88;margin:2px 0;color:var(--ink);
    text-shadow:0 4px 26px rgba(43,217,255,.18)}
  h1 span{background:var(--hero);background-size:220% 100%;-webkit-background-clip:text;background-clip:text;
    -webkit-text-fill-color:transparent;animation:slide 8s linear infinite;
    padding-left:.12em;filter:drop-shadow(0 3px 16px rgba(25,229,124,.3))}
  .meta{display:flex;gap:24px;flex-wrap:wrap;font-size:12.5px;color:var(--muted)}
  .meta b{color:var(--ink);font-weight:700}
  .status{display:flex;align-items:center;gap:9px;font-family:"Oswald";text-transform:uppercase;
    letter-spacing:.14em;font-size:12px;color:var(--muted)}
  .dot{width:8px;height:8px;border-radius:50%;background:var(--pitch);box-shadow:0 0 12px var(--pitch)}
  .dot.pulse{animation:pulse 1.6s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}

  /* Tabs */
  nav.tabs{display:flex;gap:6px;margin-bottom:22px;flex-wrap:wrap}
  nav.tabs button{font-family:"Oswald";text-transform:uppercase;letter-spacing:.13em;font-size:13px;
    color:var(--muted);background:transparent;border:1px solid var(--line);border-radius:999px;
    padding:9px 18px;cursor:pointer;transition:.18s}
  nav.tabs button:hover{color:var(--ink);border-color:var(--line2)}
  nav.tabs button.active{color:#06121f;background:var(--hero);background-size:200% 100%;
    border-color:transparent;font-weight:700;animation:slide 8s linear infinite;
    box-shadow:0 6px 20px rgba(43,217,255,.30)}

  /* Today strip */
  .today{margin-bottom:26px}
  .today h2,.section-title{font-family:"Oswald";text-transform:uppercase;letter-spacing:.16em;
    font-size:13px;color:var(--ink);margin:0 0 12px;display:flex;align-items:center;gap:12px}
  .today h2::before,.section-title::before{content:"";width:18px;height:3px;border-radius:2px;background:var(--hero)}
  .today h2::after,.section-title::after{content:"";flex:1;height:1px;
    background:linear-gradient(90deg,var(--line2),transparent)}
  .today-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px}
  .tcard{background:linear-gradient(180deg,var(--panel),var(--panel2));border:1px solid var(--line);
    border-radius:14px;padding:14px 16px 14px 18px;position:relative;overflow:hidden}
  .tcard::before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--c5)}
  .tcard .gtag{position:absolute;top:0;right:0;font-family:"Oswald";font-size:11px;letter-spacing:.1em;
    background:var(--line);color:var(--muted);padding:3px 10px;border-bottom-left-radius:10px}
  .tcard .when{font-size:11px;color:var(--faint);margin-bottom:9px}
  .tcard .row{display:flex;align-items:center;justify-content:space-between;gap:8px;font-weight:700;font-size:15px}
  .tcard .row .sc{font-family:"Oswald";font-size:20px;color:var(--c4)}
  .tcard .vs{font-size:11px;color:var(--faint);text-align:center;margin:3px 0}
  .tcard.live{border-color:var(--live);box-shadow:0 0 0 1px var(--live),0 10px 30px rgba(255,46,99,.25)}
  .tcard.live::before{background:var(--live)}
  .tcard.live .gtag{background:var(--live);color:#fff}
  .tcard.done::before{background:var(--faint)}
  .tcard.done .gtag{background:var(--line);color:var(--muted)}
  .tcard.done .row .sc{color:var(--ink)}
  .livebadge{display:inline-flex;align-items:center;gap:6px;color:var(--live);font-family:"Oswald";
    font-size:11px;letter-spacing:.12em}
  .livebadge i{width:7px;height:7px;border-radius:50%;background:var(--live);animation:pulse 1.2s infinite}
  .livedot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#fff;
    margin-right:5px;vertical-align:middle;animation:pulse 1.1s infinite}
  .fxlive{display:inline-flex;align-items:center;gap:2px;color:#fff;background:var(--live);
    font-family:"Oswald";font-size:11px;letter-spacing:.06em;padding:3px 8px;border-radius:6px}
  .fx.islive{border-color:var(--live);box-shadow:0 0 0 1px var(--live),0 8px 22px rgba(255,46,99,.18)}
  @keyframes goalflash{0%{box-shadow:0 0 0 0 rgba(25,229,124,.0)}
    12%{box-shadow:0 0 0 3px rgba(25,229,124,.7),0 0 26px rgba(25,229,124,.55)}
    100%{box-shadow:0 0 0 0 rgba(25,229,124,0)}}
  .flash{animation:goalflash 1.8s ease-out}
  .flash .sc,.flash .score input{animation:scorepop 1.8s ease-out}
  @keyframes scorepop{0%,100%{transform:scale(1)}18%{transform:scale(1.35)}}

  /* Group tables */
  .groups{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:18px}
  .group{position:relative;background:linear-gradient(180deg,var(--panel),var(--panel2));
    border:1px solid var(--line);border-radius:16px;overflow:hidden;box-shadow:var(--shadow);
    --acc:var(--c4)}
  .group::before{content:"";position:absolute;top:0;left:0;right:0;height:4px;
    background:linear-gradient(90deg,var(--acc),transparent 85%)}
  .group .ghead{display:flex;align-items:center;justify-content:space-between;
    padding:15px 18px 13px;border-bottom:1px solid var(--line);
    background:linear-gradient(90deg,color-mix(in srgb,var(--acc) 14%,transparent),transparent 70%)}
  .group .ghead .gname{font-family:"Oswald";font-weight:700;text-transform:uppercase;letter-spacing:.12em;
    font-size:17px;display:flex;align-items:center;gap:9px}
  .group .ghead .gname .badge{display:inline-flex;align-items:center;justify-content:center;
    width:26px;height:26px;border-radius:8px;font-size:15px;color:#0a0c18;font-weight:700;
    background:var(--acc);box-shadow:0 4px 12px color-mix(in srgb,var(--acc) 45%,transparent)}
  .group .ghead .gname b{color:var(--acc)}
  .group .ghead .gprog{font-size:11px;color:var(--faint)}
  table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
  thead th{font-family:"Oswald";font-weight:500;text-transform:uppercase;letter-spacing:.08em;
    font-size:10.5px;color:var(--faint);text-align:center;padding:9px 4px}
  thead th.tl{text-align:left;padding-left:18px}
  tbody td{padding:9px 4px;text-align:center;font-size:13.5px;border-top:1px solid var(--line)}
  tbody td.tl{text-align:left;padding-left:14px;font-weight:700}
  tbody td.pts{font-family:"Oswald";font-weight:700;font-size:16px}
  .teamcell{display:flex;align-items:center;gap:9px}
  .teamcell .fl{font-size:17px;line-height:1;filter:drop-shadow(0 1px 2px rgba(0,0,0,.4))}
  .teamcell .pos{width:18px;color:var(--faint);font-family:"Oswald";font-size:12px;flex:none}
  tr.advance td.tl{box-shadow:inset 3px 0 0 var(--advance)}
  tr.maybe td.tl{box-shadow:inset 3px 0 0 var(--maybe)}
  tr.out{opacity:.62}
  .legend{display:flex;gap:18px;flex-wrap:wrap;font-size:11.5px;color:var(--muted);margin:16px 2px 0}
  .legend span{display:flex;align-items:center;gap:7px}
  .legend i{width:10px;height:10px;border-radius:2px}
  .lg-adv{background:var(--advance)} .lg-may{background:var(--maybe)} .lg-out{background:var(--out)}
  .qtag{display:inline-block;font:800 9.5px/1.4 Oswald,sans-serif;letter-spacing:.5px;padding:1px 5px;border-radius:5px;margin-left:6px;vertical-align:middle}
  .qtag.qin{background:var(--advance);color:#04210f}
  .qtag.qout{background:var(--out);color:#fff;opacity:.85}
  .teamcell .tnm{overflow:hidden;text-overflow:ellipsis}
  .mini{font:700 11px Mulish,sans-serif;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.18);color:#fff;padding:3px 9px;border-radius:999px;cursor:pointer;margin-left:8px}
  .mini:hover{background:rgba(255,255,255,.16)}
  .mini.on{background:var(--advance);border-color:transparent;color:#04210f}
  .crest{display:inline-flex;align-items:center;justify-content:center;vertical-align:middle;width:22px;height:22px;flex:0 0 auto}
  .crest img{width:21px;height:21px;object-fit:contain;display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))}
  .crest.isflag{font-size:18px;line-height:1}
  .crest.big{width:38px;height:38px}.crest.big img{width:38px;height:38px}.crest.big.isflag{font-size:32px}
  .tnm2{display:inline-flex;align-items:center;gap:7px}
  .teamcell .crest{margin-right:2px}
  /* Knockout bracket */
  .bnote{color:var(--faint);font-size:12.5px;line-height:1.6;margin:2px 2px 14px;max-width:920px}
  .bracket{display:flex;gap:16px;overflow-x:auto;padding:4px 2px 16px;scroll-snap-type:x proximity}
  .bcol{flex:0 0 auto;width:210px;scroll-snap-align:start}
  .bcol h4{font:800 12px Oswald,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:var(--c2);
    margin:0 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line)}
  .bmatch{background:var(--card);border:1px solid var(--line);border-radius:11px;padding:7px 9px;margin-bottom:10px;box-shadow:var(--shadow)}
  .bmatch.small{opacity:.85}
  .bmnum{font-size:9.5px;letter-spacing:.04em;color:var(--faint);margin-bottom:5px;text-transform:uppercase}
  .brow{display:flex;align-items:center;min-height:26px;padding:3px 0}
  .brow+.brow{border-top:1px dashed var(--line)}
  .bteam{display:flex;align-items:center;gap:7px;font-weight:700;font-size:13px}
  .bteam .bnm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:135px}
  .bteam.prov{font-style:italic;color:var(--faint);font-weight:600}
  .bteam .pdot{width:6px;height:6px;border-radius:50%;background:var(--maybe);display:inline-block;flex:0 0 auto}
  .bslot{font-size:12px;color:var(--faint)}
  @media(max-width:640px){ .bcol{width:188px} .bteam .bnm{max-width:118px} }
  /* Form guide */
  .fcol{text-align:center}
  .formdots{display:inline-flex;gap:3px;justify-content:center}
  .fd{width:15px;height:15px;border-radius:4px;font:800 9px/15px Mulish,sans-serif;color:#fff;text-align:center;display:inline-block}
  .fd-w{background:var(--advance);color:#04210f}.fd-d{background:#6b7280}.fd-l{background:var(--live)}
  .fd-none{color:var(--faint)}
  /* Scenarios */
  .scen{margin:8px 4px 2px;border-top:1px solid var(--line)}
  .scen summary{cursor:pointer;font:800 11px Oswald,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:var(--c2);padding:9px 2px;list-style:none}
  .scen summary::-webkit-details-marker{display:none}
  .scen summary:before{content:"▸";margin-right:7px;display:inline-block;transition:transform .15s}
  .scen[open] summary:before{transform:rotate(90deg)}
  .scrow{display:flex;align-items:flex-start;gap:8px;padding:6px 2px;font-size:13px;line-height:1.45}
  .scrow .sicon{flex:0 0 auto;font-weight:800;width:14px;text-align:center}
  .scrow .sicon.in{color:var(--advance)}.scrow .sicon.out{color:var(--live)}.scrow .sicon{color:var(--maybe)}
  .scrow .snm{flex:0 0 auto;font-weight:800;min-width:96px}
  .scrow .stx{color:var(--muted)}
  /* Match timeline */
  .tlWrap{margin-top:14px}
  .tlTitle{font:800 11px Oswald,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:var(--c2);margin:0 0 10px;text-align:center}
  .tl{position:relative}
  .tl:before{content:"";position:absolute;left:50%;top:2px;bottom:2px;width:2px;background:var(--line);transform:translateX(-1px)}
  .tlr{display:grid;grid-template-columns:1fr 46px 1fr;align-items:center;margin:6px 0;font-size:12.5px;font-weight:700}
  .tlc{padding:2px 9px;overflow-wrap:anywhere}
  .tlc.h{text-align:right}.tlc.a{text-align:left}
  .tlm{text-align:center;font:800 10.5px Oswald,sans-serif;color:var(--faint);background:var(--card);border:1px solid var(--line);border-radius:999px;padding:3px 0;z-index:1}
  .tgd,.tga{color:var(--faint);font-weight:600;font-size:11px}
  /* Stats hub segmented control */
  .seg{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 14px}
  .seg button{font:800 12px Oswald,sans-serif;letter-spacing:.06em;text-transform:uppercase;
    background:var(--card);border:1px solid var(--line);color:var(--muted);padding:7px 13px;border-radius:999px;cursor:pointer}
  .seg button:hover{color:var(--ink);border-color:var(--line2)}
  .seg button.active{background:var(--hero);background-size:200% 100%;color:#0a0c18;border-color:transparent;animation:slide 6s linear infinite}
  .sc-row .stat .k{font-size:10px}
  @media(max-width:560px){
    .group th:nth-child(6),.group td:nth-child(6),
    .group th:nth-child(7),.group td:nth-child(7){display:none} /* hide GF/GA, keep GD/Pts/Form */
    .fd{width:14px;height:14px;line-height:14px}
    .scrow .snm{min-width:80px}
  }

  /* Fixtures */
  .day{margin-bottom:24px}
  .day .dhead{font-family:"Oswald";text-transform:uppercase;letter-spacing:.14em;font-size:14px;
    color:var(--ink);margin:0 0 12px;display:flex;align-items:center;gap:12px}
  .day .dhead .num{color:var(--pitch)}
  .day .dhead::after{content:"";flex:1;height:1px;background:var(--line)}
  .fx{display:flex;align-items:center;gap:14px;background:var(--panel2);border:1px solid var(--line);
    border-radius:12px;padding:11px 16px;margin-bottom:8px;flex-wrap:wrap}
  .fxx{flex-basis:100%;width:100%;margin-top:8px;border-top:1px solid var(--line);padding-top:9px}
  .fxx .goals{border-top:none;padding-top:0;margin-top:0}
  .fx .gp{font-family:"Oswald";font-size:11px;letter-spacing:.08em;color:var(--faint);width:54px;flex:none}
  .fx .gp b{color:var(--muted)}
  .fx .time{font-size:11.5px;color:var(--faint);width:78px;flex:none}
  .fx .match{display:flex;align-items:center;gap:10px;flex:1;min-width:230px;justify-content:center}
  .fx .side{display:flex;align-items:center;gap:8px;flex:1}
  .fx .side.h{justify-content:flex-end;text-align:right}
  .fx .side .nm{font-weight:700;font-size:14px}
  .fx .fl{font-size:18px}
  .fx .score{display:flex;align-items:center;gap:8px}
  .fx .score .scv{min-width:26px;text-align:center;font-family:"Oswald";font-size:20px;font-weight:600;color:var(--ink)}
  .fx .score .scv.win{color:var(--pitch)}
  .fx .score .sep{color:var(--faint)}
  .fx .venue{font-size:11px;color:var(--faint);width:185px;flex:none;text-align:right}
  .fx .venue b{color:var(--muted);font-weight:600;display:block}
  .fx.played{border-color:var(--line2)}
  .fx.played .nm.win{color:var(--pitch)}
  #scorers,#fixtures{max-width:640px;margin-left:auto;margin-right:auto}
  .statSearch{position:relative;margin:0 0 14px}
  .statSearch input{width:100%;box-sizing:border-box;background:var(--panel2);border:1px solid var(--line);
    color:var(--ink);border-radius:10px;padding:11px 36px 11px 14px;font-size:14px;font-family:inherit;outline:none}
  .statSearch input:focus{border-color:color-mix(in srgb,var(--ink) 32%,transparent)}
  .statSearch input::placeholder{color:var(--faint)}
  .ssClear{position:absolute;right:8px;top:50%;transform:translateY(-50%);cursor:pointer;color:var(--faint);
    font-size:20px;line-height:1;padding:2px 7px;border-radius:7px;user-select:none}
  .ssClear:hover{color:var(--ink);background:color-mix(in srgb,var(--ink) 9%,transparent)}

  .filter{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:20px}
  .filter button{font-family:"Oswald";font-size:12px;letter-spacing:.08em;color:var(--muted);
    background:transparent;border:1px solid var(--line);border-radius:8px;width:34px;height:32px;cursor:pointer}
  .filter button.active{color:#06120b;background:var(--pitch);border-color:var(--pitch);font-weight:600}
  .filter .lbl{font-family:"Oswald";font-size:12px;letter-spacing:.1em;color:var(--faint);
    text-transform:uppercase;align-self:center;margin-right:6px}

  /* Venues */
  .venues{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}
  .vcard{background:var(--panel2);border:1px solid var(--line);border-radius:14px;padding:16px 18px}
  .vcard .vn{font-family:"Oswald";text-transform:uppercase;letter-spacing:.06em;font-size:17px;font-weight:600}
  .vcard .vc{font-size:12.5px;color:var(--muted);margin-top:3px}
  .vcard .vcount{margin-top:11px;font-size:11px;color:var(--faint);font-family:"Oswald";letter-spacing:.08em}
  .vcard .vcount b{color:var(--pitch);font-size:14px}
  .footer{margin-top:40px;padding-top:18px;border-top:1px solid var(--line);font-size:11.5px;
    color:var(--faint);display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap}
  .footer button{color:var(--muted);background:none;border:none;text-decoration:underline;cursor:pointer;font:inherit}
  /* Scorers */
  .sc-row{display:flex;align-items:center;gap:16px;background:var(--panel2);border:1px solid var(--line);
    border-radius:12px;padding:13px 18px;margin-bottom:8px}
  .sc-row:nth-child(1){background:linear-gradient(90deg,color-mix(in srgb,var(--gold) 14%,var(--panel2)),var(--panel2));
    border-color:color-mix(in srgb,var(--gold) 40%,var(--line))}
  .sc-row .rank{font-family:"Oswald";font-size:20px;font-weight:600;color:var(--faint);width:34px;flex:none;text-align:center}
  .sc-row:nth-child(1) .rank{color:var(--gold)}
  .sc-row:nth-child(2) .rank{color:#cfd8e3}
  .sc-row:nth-child(3) .rank{color:#d29a6a}
  .sc-row .fl{font-size:22px;flex:none}
  .sc-row .who{flex:1;min-width:0}
  .sc-row .who .nm{font-weight:800;font-size:15px}
  .sc-row .who .tm{font-size:12px;color:var(--muted)}
  .gb{display:inline-block;margin-left:8px;padding:2px 8px;border-radius:999px;font-size:10.5px;font-weight:700;
    letter-spacing:.03em;vertical-align:middle;white-space:nowrap;
    color:#1a1206;background:linear-gradient(90deg,var(--gold),#ffe39a);border:1px solid color-mix(in srgb,var(--gold) 60%,#000)}
  .gbnote{font-size:11.5px;color:var(--muted);margin:0 2px 10px;display:flex;gap:6px;align-items:center}
  .sc-row.expandable{cursor:pointer}
  .sc-row.expandable .who .nm::after{content:"›";display:inline-block;margin-left:7px;color:var(--muted);transform:rotate(90deg);transition:transform .15s;font-weight:700}
  .sc-row.expandable.open .who .nm::after{transform:rotate(-90deg)}
  .pdtl{margin:-2px 0 8px;padding:4px 6px 6px;display:flex;flex-direction:column;gap:4px}
  .pdrow{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:9px;background:var(--card2,rgba(255,255,255,.03));font-size:12.5px}
  .pdrow .crest,.pdrow img{width:18px;height:18px}
  .pdrow .pdopp{font-weight:600}
  .pdrow .pdwhen{color:var(--muted);font-size:11px}
  .pdrow .pdmin{margin-left:auto;color:var(--muted);font-size:11.5px;font-variant-numeric:tabular-nums}
  .pdrow .pdn{min-width:54px;text-align:right;font-weight:700;color:var(--gold)}
  .pdrow .pen{display:inline-block;font-size:9px;font-weight:800;line-height:1;padding:2px 4px;border-radius:4px;
    background:color-mix(in srgb,var(--c2,#39f) 30%,transparent);color:var(--text);vertical-align:middle;letter-spacing:.03em}
  .bdg{display:inline-flex;align-items:center;gap:3px;font-size:10px;font-weight:700;line-height:1;
    padding:2px 7px;border-radius:999px;vertical-align:middle;white-space:nowrap;margin-left:5px;
    background:color-mix(in srgb,var(--ink,#fff) 9%,transparent);color:var(--muted);
    border:1px solid color-mix(in srgb,var(--ink,#fff) 12%,transparent)}
  .cbdg{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}
  .cbdg .bdg{margin-left:0}
  .sc-row .stat{font-family:"Oswald";text-align:center;flex:none}
  .sc-row .stat .v{font-size:22px;font-weight:700;color:var(--pitch);line-height:1}
  .sc-row .stat .k{font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint)}
  .sc-row .stat.sub .v{color:var(--ink);font-size:18px}
  .sc-empty{background:var(--panel2);border:1px dashed var(--line2);border-radius:14px;padding:34px 22px;
    text-align:center;color:var(--muted)}
  .sc-empty b{color:var(--ink);font-family:"Oswald";letter-spacing:.04em;display:block;margin-bottom:6px;font-size:16px}
  .hidden{display:none}
  @media(max-width:560px){
    .fx .venue{display:none} .fx .gp{width:42px}
  }

  /* ---- Mobile / Android layout ---- */
  @media(max-width:640px){
    .wrap{padding:16px 13px 72px}
    header.top{padding-bottom:16px;margin-bottom:18px}
    h1{font-size:clamp(30px,12vw,46px)}
    .meta{gap:12px;font-size:11px}
    .status{font-size:10.5px}
    nav.tabs{gap:5px}
    nav.tabs button{padding:8px 12px;font-size:12px;letter-spacing:.06em}
    .groups{grid-template-columns:1fr}
    .group table{table-layout:fixed}
    thead th{font-size:9.5px;padding:8px 1px}
    thead th.tl{padding-left:12px}
    tbody td{font-size:12.5px;padding:8px 1px}
    tbody td.tl{padding-left:10px}
    .teamcell{gap:6px}
    .teamcell .fl{font-size:14px}
    .teamcell>span:last-child{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:34vw}
    .teamcell .pos{width:14px}
    .today-grid{grid-template-columns:1fr 1fr;gap:8px}
    .tcard{padding:11px 12px 11px 14px}
    .tcard .row{font-size:14px}
    .fx{gap:9px;padding:10px 12px}
    .fx .venue{display:none}
    .fx .match{min-width:0}
    .fx .side .nm{font-size:13px}
    .fx .time{width:62px;font-size:11px}
    .sc-row{gap:10px;padding:11px 13px}
    .sc-row .who .nm{font-size:14px}
  }
  @media(max-width:380px){
    .today-grid{grid-template-columns:1fr}
    .fx .gp{display:none}
    .fx .time{width:54px}
  }
  /* API-Football extras */
  .goals{margin-top:9px;border-top:1px solid var(--line);padding-top:8px;display:flex;flex-direction:column;gap:3px}
  .goals .g{font-size:12px;color:var(--ink)}
  .goals .gm{font-family:"Oswald";color:var(--pitch);font-size:11px;margin-right:2px}
  .goals .gd{color:var(--faint);font-size:10.5px}
  .goals .ga{color:var(--muted);font-size:10.5px}
  .luBtn{margin-top:9px;font-family:"Oswald";font-size:11px;letter-spacing:.06em;color:var(--muted);
    background:transparent;border:1px solid var(--line2);border-radius:7px;padding:5px 10px;cursor:pointer}
  .luBtn:hover{color:var(--ink)}
  .luPanel{margin-top:8px;display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .luPanel .xi{font-size:11.5px;color:var(--muted)}
  .luPanel .xih{font-family:"Oswald";text-transform:uppercase;letter-spacing:.06em;color:var(--ink);font-size:11px;margin-bottom:5px}
  .luPanel .xi>div{padding:1.5px 0}
  .statschip{font-family:"Oswald";font-size:10.5px;letter-spacing:.08em;text-transform:uppercase}
  .statschip.ok{color:var(--pitch)} .statschip.warn{color:var(--gold)}
  .cards{margin-top:8px;display:flex;flex-direction:column;gap:3px}
  .cards .cd{font-size:12px;color:var(--muted)}
  .statPanel{display:block}
  .statHd{display:grid;grid-template-columns:1fr 2fr 1fr;gap:6px;font-family:"Oswald";text-transform:uppercase;
    font-size:10.5px;letter-spacing:.05em;color:var(--ink);padding-bottom:5px;border-bottom:1px solid var(--line);margin-bottom:5px}
  .statHd span:first-child{text-align:left}.statHd span:last-child{text-align:right}.statHd span:nth-child(2){text-align:center}
  .statRow{display:grid;grid-template-columns:1fr 2fr 1fr;gap:6px;font-size:12px;color:var(--ink);padding:2px 0}
  .statRow span:first-child{text-align:left;font-family:"Oswald"}.statRow span:last-child{text-align:right;font-family:"Oswald"}
  .statRow .stT{text-align:center;color:var(--muted);font-size:11px}
  /* Match Center */
  .mcSel{display:flex;gap:8px;overflow-x:auto;padding-bottom:8px;margin-bottom:4px}
  .mcTab{flex:none;display:flex;align-items:center;gap:5px;background:var(--panel2);border:1px solid var(--line);
    border-radius:999px;padding:7px 13px;cursor:pointer;color:var(--muted);font-size:12.5px;white-space:nowrap}
  .mcTab.on{border-color:var(--c5);color:var(--ink);box-shadow:0 0 0 1px var(--c5)}
  .mcTab .fl{font-size:15px}
  .mcTab .mcTag{font-family:"Oswald";font-size:10px;color:var(--faint);margin-left:3px}
  .mcHead{display:grid;grid-template-columns:1fr auto 1fr;align-items:start;gap:10px;margin:10px 0 2px;max-width:540px;margin-left:auto;margin-right:auto}
  .mcTeam{display:flex;flex-direction:column;align-items:center;gap:3px;font-family:"Oswald";font-size:14px;color:var(--ink);text-align:center}
  .mcTeam .fl{font-size:30px;line-height:1}
  .mcForm{font-size:11px;color:var(--muted);letter-spacing:.06em}
  .mcScore{display:flex;flex-direction:column;align-items:center;gap:3px}
  .mcSc{display:flex;align-items:center;gap:6px}
  .mcSc b{font-family:"Oswald";font-size:30px;color:var(--ink)}
  .mcSc span{font-size:18px;color:var(--muted)}
  .mcSc .vsd{font-size:14px;color:var(--faint)}
  .mcStatus{font-family:"Oswald";font-size:11px;color:var(--live);display:flex;align-items:center;gap:5px}
  .pitch{position:relative;width:100%;max-width:540px;margin:14px auto;aspect-ratio:100/150;
    background:linear-gradient(180deg,#11774a 0%,#0c5a37 50%,#11774a 100%);border-radius:14px;overflow:hidden;box-shadow:0 16px 44px rgba(0,0,0,.45)}
  .pitch::before{content:"";position:absolute;inset:0;background:repeating-linear-gradient(180deg,rgba(255,255,255,.03) 0 10%,transparent 10% 20%)}
  .pitchsvg{position:absolute;inset:0;width:100%;height:100%}
  .pm{position:absolute;transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center;width:56px;pointer-events:none}
  .pm .num{position:relative;width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;
    font-family:"Oswald";font-size:12px;color:#fff;box-shadow:0 2px 7px rgba(0,0,0,.5)}
  .pm.home .num{background:var(--c5)}
  .pm.away .num{background:var(--live)}
  .pm .pmb{position:absolute;top:-8px;right:-13px;font-size:11px;line-height:1;white-space:nowrap;letter-spacing:-2px}
  .pm .pn{font-size:9.5px;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.9);margin-top:2px;text-align:center;line-height:1.05}
  .mcDetail{max-width:540px;margin:12px auto 0}
  .mcGoals{display:flex;flex-direction:column;gap:3px;margin-bottom:8px}
  .mcGoals .g{font-size:13px;color:var(--ink)}
  .mcGoals .gt{color:var(--faint);font-size:11px}
  .mcEmpty{text-align:center;color:var(--muted);padding:50px 20px;display:flex;flex-direction:column;gap:8px}
  .mcEmpty b{font-family:"Oswald";font-size:18px;color:var(--ink)}
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <div class="brand">
      <div class="kicker"><span class="dots"><i></i><i></i><i></i></span>United States · Canada · Mexico</div>
      <h1>World Cup <span>2026</span></h1>
      <div class="meta">
        <div>Group stage · <b id="m-stage"></b></div>
        <div>48 teams · 12 groups · 72 matches</div>
      </div>
    </div>
    <div class="status"><span class="dot pulse" id="dot"></span><span id="m-updated">connecting…</span>
      <button id="alertsBtn" class="mini" title="Browser notification when a goal is scored in a live match">🔔 Alerts: off</button>
      <button id="soundBtn" class="mini" title="Play a sound when a goal is scored in a live match">🔇 Sound: off</button>
    </div>
  </header>

  <nav class="tabs">
    <button data-view="standings" class="active">Standings</button>
    <button data-view="fixtures">Fixtures &amp; Results</button>
    <button data-view="bracket">Bracket</button>
    <button data-view="scorers">Top Scorers</button>
    <button data-view="matchcenter">Match Center</button>
  </nav>

  <!-- TODAY -->
  <section class="today" id="todaySection"></section>

  <!-- STANDINGS -->
  <section id="view-standings">
    <div class="section-title">Group Standings</div>
    <div class="groups" id="groups"></div>
    <div class="legend">
      <span><i class="lg-adv"></i> Top 2 — advance to Round of 32</span>
      <span><i class="lg-may"></i> 3rd — may advance (8 best third-placed)</span>
      <span><i class="lg-out"></i> Eliminated</span>
      <span><span class="qtag qin">Q</span> Clinched a spot &nbsp; <span class="qtag qout">OUT</span> Out (confirmed)</span>
      <span style="color:var(--faint)">Order: Points → Goal difference → Goals for</span>
    </div>
  </section>

  <!-- FIXTURES -->
  <section id="view-fixtures" class="hidden">
    <div class="filter" id="filter"></div>
    <div id="fixtures"></div>
  </section>

  <!-- BRACKET -->
  <section id="view-bracket" class="hidden">
    <div class="section-title">Road to the Final</div>
    <div id="bracketNote" class="bnote"></div>
    <div id="bracket" class="bracket"></div>
  </section>

  <!-- MATCH CENTER -->
  <section id="view-matchcenter" class="hidden">
    <div class="section-title">Match Center</div>
    <div class="mcSel" id="mcSel"></div>
    <div id="mcBody"></div>
  </section>

  <section id="view-scorers" class="hidden">
    <div class="section-title">Tournament Stats</div>
    <div id="scorers"></div>
  </section>

  <div class="footer">
    <div>Group order uses FIFA tiebreakers (points, goal difference, goals scored). Times shown in U.S. Eastern (ET).<div id="roNote" style="margin-top:6px;color:var(--maybe)"></div><div id="phoneHint" style="margin-top:6px"></div><div id="statsStatus" style="margin-top:6px"></div><div id="appVersion" style="margin-top:6px;color:var(--faint)"></div></div>
    <div><button id="resetBtn">Reset all results</button></div>
  </div>
</div>

<script>
const $ = s => document.querySelector(s);
let STATE = null, VIEW = "standings", GROUP_FILTER = "ALL", MC_MATCH = null, STAT_VIEW = "goals", STAT_Q = "";

let lastScores = {};   // matchId -> "h-a", to detect changes between polls
let changedIds = {};   // ids whose score changed on the latest poll
let primed = false;    // skip flashing on the very first load

// Goal-alert preferences (persisted on this device).
let ALERTS_ON = localStorage.getItem("wc_alerts")==="1";
let SOUND_ON  = localStorage.getItem("wc_sound")==="1";

async function load(){
  try{
    const r = await fetch("/api/state");
    STATE = await r.json();
    // detect score changes since last poll
    changedIds = {};
    const goals = [];
    for(const m of STATE.matches){
      const key = m.result ? (m.result.home+"-"+m.result.away) : "";
      const prev = lastScores[m.id];
      if(primed && prev!==undefined && prev!==key && key!==""){
        changedIds[m.id] = true;
        // A goal = total score went up while the match is live.
        if(matchPhase(m)==="live"){
          const pv=(prev||"0-0").split("-").map(Number), nv=key.split("-").map(Number);
          const pT=(pv[0]||0)+(pv[1]||0), nT=(nv[0]||0)+(nv[1]||0);
          if(nT>pT){ const scorer = (nv[0]||0)>(pv[0]||0) ? m.home : m.away;
            goals.push({m, scorer, score:(nv[0]||0)+" – "+(nv[1]||0)}); }
        }
      }
      lastScores[m.id] = key;
    }
    primed = true;
    $("#dot").classList.toggle("pulse", false);
    renderAll();
    flashChanges();
    if(goals.length) fireGoalAlerts(goals);
  }catch(e){ $("#m-updated").textContent = "offline"; }
}

// ---- Goal alerts ----
let _audioCtx = null;
function ensureAudio(){
  try{ _audioCtx = _audioCtx || new (window.AudioContext||window.webkitAudioContext)();
       if(_audioCtx.state==="suspended") _audioCtx.resume(); }catch(e){}
}
function goalSound(){
  ensureAudio(); if(!_audioCtx) return;
  const beep=(freq,start,dur)=>{
    const o=_audioCtx.createOscillator(), g=_audioCtx.createGain();
    o.type="triangle"; o.frequency.value=freq; o.connect(g); g.connect(_audioCtx.destination);
    const t=_audioCtx.currentTime+start;
    g.gain.setValueAtTime(0.0001,t);
    g.gain.exponentialRampToValueAtTime(0.32,t+0.02);
    g.gain.exponentialRampToValueAtTime(0.0001,t+dur);
    o.start(t); o.stop(t+dur+0.02);
  };
  beep(784,0,0.45); beep(1175,0.16,0.55);   // two-note chime
}
function fireGoalAlerts(list){
  if(SOUND_ON) goalSound();
  if(ALERTS_ON && "Notification" in window && Notification.permission==="granted"){
    list.forEach(g=>{
      try{ const n=new Notification("⚽ GOAL — "+g.scorer,
        { body:g.m.home+"  "+g.score+"  "+g.m.away, tag:g.m.id, renotify:true, icon:"/icon-192.png" });
        setTimeout(()=>{ try{n.close();}catch(_){} }, 9000);
      }catch(e){}
    });
  }
}
function syncAlertButtons(){
  const a=$("#alertsBtn"), s=$("#soundBtn");
  if(a){ a.classList.toggle("on",ALERTS_ON); a.textContent="🔔 Alerts: "+(ALERTS_ON?"on":"off"); }
  if(s){ s.classList.toggle("on",SOUND_ON); s.textContent=(SOUND_ON?"🔊":"🔇")+" Sound: "+(SOUND_ON?"on":"off"); }
}

function flashChanges(){
  for(const id of Object.keys(changedIds)){
    document.querySelectorAll('[data-mid="'+id+'"]').forEach(el=>{
      el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
    });
  }
}

function anyLive(){ return STATE && STATE.matches && STATE.matches.some(m=>matchPhase(m)==="live"); }

function fmtUpdated(iso){
  const d = new Date(iso);
  return "Updated " + d.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",second:"2-digit"});
}

function liveOf(m){ return (STATE.liveInfo && STATE.liveInfo[m.id]) || null; }
function liveMinute(m){ const li=liveOf(m); return li && li.minute!=null ? (li.minute+"'") : (li && li.status==="PAUSED" ? "HT" : "LIVE"); }

// A match is "live" if the feed says so, OR it's within its play window.
// The result check comes LAST so a just-scored match doesn't get marked done.
function matchPhase(m){
  const li = liveOf(m);
  const now = Date.now();
  const ko = new Date(m.kickoff).getTime();
  const since = now - ko; // ms since kickoff
  // Feed explicitly in play -> live.
  if (li && (li.status==="IN_PLAY" || li.status==="PAUSED")) return "live";
  // Honor a FINISHED only once enough time has passed for it to be genuine
  // (~95'+). A FINISHED arriving earlier is treated as feed noise and ignored.
  if (li && li.status==="FINISHED" && since > 95*60*1000) return "done";
  // The clock is the source of truth during the match window — a delayed or
  // incorrect FINISHED from the free feed can't yank a live card off the board.
  if (since >= -60*1000 && since <= 2.25*60*60*1000) return "live";
  if (m.result || (li && li.status==="FINISHED")) return "done";
  return "scheduled";
}
function isToday(m){
  const ko = new Date(m.kickoff);
  const now = new Date();
  // compare in ET-ish terms using the stored date label window (±18h of "now")
  return Math.abs(ko.getTime() - now.getTime()) < 14*60*60*1000;
}

const OPEN = Object.create(null);
function _luLabel(luval){ return /^st-/.test(luval) ? "Match stats" : "Lineups"; }
function captureOpen(){
  document.querySelectorAll("[data-okey]").forEach(function(el){
    const k=el.dataset.okey; let open=false;
    if(el.classList.contains("luPanel")) open = el.style.display!=="none";
    else if(el.classList.contains("sc-item")){ const p=el.querySelector(".pdtl"); open = !!(p && !p.hidden); }
    else if(el.tagName==="DETAILS") open = el.open;
    if(open) OPEN[k]=1; else delete OPEN[k];
  });
}
function restoreOpen(){
  document.querySelectorAll("[data-okey]").forEach(function(el){
    const k=el.dataset.okey, want=!!OPEN[k];
    if(el.classList.contains("luPanel")){
      el.style.display = want?"block":"none";
      const luval=k.replace(/^lu-/,""), b=document.querySelector('[data-lu="'+luval+'"]');
      if(b) b.textContent=_luLabel(luval)+(want?" ▴":" ▾");
    } else if(el.classList.contains("sc-item")){
      const p=el.querySelector(".pdtl"), row=el.querySelector(".sc-row");
      if(p){ p.hidden=!want; if(row) row.classList.toggle("open",want); }
    } else if(el.tagName==="DETAILS"){ el.open=want; }
  });
}
function renderAll(){
  if(!STATE) return;
  captureOpen();
  $("#m-stage").textContent = STATE.tournament.groupStage;
  $("#m-updated").textContent = fmtUpdated(STATE.updated);
  renderToday();
  if(VIEW==="standings") renderGroups();
  if(VIEW==="fixtures") renderFixtures();
  if(VIEW==="bracket") renderBracket();
  if(VIEW==="matchcenter") renderMatchCenter();
  if(VIEW==="scorers") renderScorers();
  updateStatsChip();
  const av = $("#appVersion"); if(av && STATE.version) av.textContent = "Build: " + STATE.version;
  const ph = $("#phoneHint");
  if(ph){ ph.innerHTML = STATE.phoneUrl
    ? '📱 On your phone (same Wi-Fi): <b style="color:var(--ink)">'+esc(STATE.phoneUrl)+'</b> — then your browser menu → “Add to Home screen”.'
    : ''; }
  const rb = $("#resetBtn"); if(rb) rb.style.display = STATE.readOnly ? "none" : "";
  const ro = $("#roNote");
  if(ro){ ro.innerHTML = STATE.readOnly
    ? '🔒 View-only on this device — scores are managed on the host PC.'+(STATE.pinSet?' <a href="#" id="roUnlock">Enter edit PIN</a>':'')
    : ''; 
    const u=$("#roUnlock"); if(u) u.onclick=(e)=>{ e.preventDefault(); unlockEditing(); };
  }
  restoreOpen();
}
function updateStatsChip(){
  const ss = $("#statsStatus"); if(!ss) return;
  const fc = STATE.apifcStatus;
  if(fc && fc.enabled && !fc.blocked && fc.covered>0){ ss.innerHTML='<span class="statschip ok">● Real-time: apifootball.com ('+fc.covered+' matches)</span>'; return; }
  if(fc && fc.enabled && fc.blocked){ ss.innerHTML='<span class="statschip warn">● apifootball.com key active but this plan lacks World Cup access'+(fc.error?' — '+esc(fc.error):'')+'</span>'; return; }
  const t = STATE.tsdbStatus;
  if(t && t.enabled && t.mapped>0){ ss.innerHTML='<span class="statschip ok">● Goals &amp; lineups: TheSportsDB ('+t.mapped+' matches)</span>'; return; }
  if(t && t.enabled){ ss.innerHTML='<span class="statschip warn">● TheSportsDB connected — waiting for today’s match events &amp; lineups</span>'; return; }
  const af = STATE.afStatus;
  if(!af || !af.enabled){ ss.innerHTML=""; return; }
  if(af.blocked){ ss.innerHTML='<span class="statschip warn">● API-Football free plan can\u2019t access the 2026 season \u2014 live scores, standings &amp; top scorers still work</span>'; return; }
  if(af.mapped>0) ss.innerHTML='<span class="statschip ok">● Player stats: API-Football ('+af.mapped+' matches mapped)</span>';
  else ss.innerHTML='<span class="statschip warn">● API-Football connected, no World Cup data yet'+(af.error?' \u2014 '+esc(af.error):'')+'</span>';
}

function scorerRoster(){
  const r={}; const ex=STATE.matchExtra||{};
  const byId={}; (STATE.matches||[]).forEach(m=>byId[m.id]=m);
  for(const id in ex){ const e=ex[id], m=byId[id]; if(!e.lineups||!m) continue;
    [["home",m.home],["away",m.away]].forEach(function(pair){
      const lu=e.lineups[pair[0]]; if(!lu) return;
      const names=(lu.pitch&&lu.pitch.length)?lu.pitch.map(p=>p.n):(lu.xi||[]);
      r[pair[1]]=r[pair[1]]||[]; names.forEach(n=>{ if(n && r[pair[1]].indexOf(n)<0) r[pair[1]].push(n); });
    });
  }
  return r;
}
function prettyName(abbrev, team, roster){
  const cand=roster[team]||[]; let best=abbrev, sc=0;
  for(const full of cand){ const s=mcMatchScore(abbrev, full); if(s>sc){ sc=s; best=full; } }
  return sc>=4 ? best : abbrev;   // upgrade "L. Messi" -> "Lionel Messi" when we can match it
}
function statAgg(){
  const goals={}, assists={}, cards={};
  const ex=STATE.matchExtra||{};
  for(const id in ex){ const e=ex[id];
    (e.scorers||[]).forEach(g=>{
      const og=/o\.?g\.?|own goal/i.test((g.name||"")+" "+(g.detail||""));
      if(!og){ const k=g.name+"|"+g.team; (goals[k]=goals[k]||{name:g.name,team:g.team,v:0}).v++; }
      if(g.assist){ const k=g.assist+"|"+g.team; (assists[k]=assists[k]||{name:g.assist,team:g.team,v:0}).v++; }
    });
    (e.cards||[]).forEach(c=>{ const k=c.player+"|"+c.team; const o=(cards[k]=cards[k]||{name:c.player,team:c.team,y:0,r:0}); if(c.type==="red")o.r++; else o.y++; });
  }
  return {goals,assists,cards};
}
// Which matches a player scored in, and how many — mirrors statAgg's goal rule so totals match.
function playerGoalBreakdown(raw, team){
  const ex=STATE.matchExtra||{}; const byId={}; (STATE.matches||[]).forEach(m=>byId[m.id]=m);
  const out=[];
  for(const id in ex){ const e=ex[id], mt=byId[id]; if(!mt) continue;
    const gs=[];
    (e.scorers||[]).forEach(g=>{
      const og=/o\.?g\.?|own goal/i.test((g.name||"")+" "+(g.detail||""));
      if(!og && g.name===raw && g.team===team) gs.push({ minute:g.minute||"", pen:/pen/i.test(g.detail||"") });
    });
    if(gs.length){
      const home = mt.home===team;
      out.push({ opp: home?mt.away:mt.home, home, n:gs.length, goals:gs, pens:gs.filter(x=>x.pen).length, date:mt.date });
    }
  }
  out.sort((a,b)=> (a.date||"").localeCompare(b.date||""));
  return out;
}
function bdgChips(list){ return (list||[]).map(b=>'<span class="bdg">'+b[0]+' '+esc(b[1])+'</span>').join(""); }
function playerBadges(raw, team){
  const bd=playerGoalBreakdown(raw, team); const out=[];
  const maxG=bd.reduce((mx,g)=>Math.max(mx,g.n),0);
  if(maxG>=3) out.push(["🎩","Hat-trick"]);
  const pens=bd.reduce((a,g)=>a+g.pens,0);
  if(pens>0) out.push(["🎯", pens+" pen"]);
  return out;
}
function matchBadges(m){
  const out=[]; if(matchPhase(m)!=="done") return out;
  const r=m.result; if(!r) return out;
  const ex=STATE.matchExtra && STATE.matchExtra[m.id];
  const tot=(r.home||0)+(r.away||0);
  if(tot>=4) out.push(["🎉","Thriller"]);
  if(r.home!==r.away && (r.home===0||r.away===0)) out.push(["🧤","Clean sheet"]);
  if(ex && ex.scorers && r.home!==r.away && ex.scorers.some(g=>/^90\+/.test((g.minute||"")))) out.push(["⏱️","Last-gasp"]);
  return out;
}
function cleanSheets(){
  const cs={};
  (STATE.matches||[]).forEach(m=>{ if(!m.result) return;
    if(m.result.away===0) cs[m.home]=(cs[m.home]||0)+1;
    if(m.result.home===0) cs[m.away]=(cs[m.away]||0)+1;
  });
  return Object.keys(cs).map(t=>({team:t,v:cs[t]})).sort((a,b)=>b.v-a.v||a.team.localeCompare(b.team));
}
function teamCards(){
  const t={}; const c=statAgg().cards;
  Object.values(c).forEach(p=>{ const k=p.team||"—"; (t[k]=t[k]||{team:k,y:0,r:0}); t[k].y+=p.y; t[k].r+=p.r; });
  // worst record first; reds weigh heavier than yellows
  return Object.values(t).map(x=>({team:x.team,y:x.y,r:x.r,score:x.y + x.r*3}))
    .filter(x=>x.y||x.r)
    .sort((a,b)=> b.score-a.score || b.r-a.r || a.team.localeCompare(b.team));
}
function scRow(rank, flagHtml, name, sub, statHtml, badge){
  return '<div class="sc-row" data-srch="'+esc((name+" "+sub).toLowerCase())+'"><div class="rank">'+rank+'</div>'+flagHtml+
    '<div class="who"><div class="nm">'+esc(name)+(badge||'')+'</div><div class="tm">'+esc(sub)+'</div></div>'+statHtml+'</div>';
}
function filterScorers(){
  const q=(STAT_Q||"").toLowerCase().trim(); let shown=0;
  document.querySelectorAll("#scorers .sc-row[data-srch]").forEach(function(r){
    const unit=r.closest(".sc-item")||r, hit=!q || r.dataset.srch.indexOf(q)>=0;
    unit.classList.toggle("hidden", !hit); if(hit) shown++;
  });
  const ne=document.getElementById("statNoMatch"); if(ne) ne.hidden = !(q && shown===0);
}
function renderScorers(){
  const el = $("#scorers");
  const tabs=[["goals","Goals"],["assists","Assists"],["cards","Discipline"],["team","Team cards"],["clean","Clean sheets"]];
  const seg='<div class="seg">'+tabs.map(t=>'<button data-stat="'+t[0]+'" class="'+(STAT_VIEW===t[0]?"active":"")+'">'+t[1]+'</button>').join("")+'</div>';
  let body='';
  if(STAT_VIEW==="goals"){
    // Count goals from the actual match events (complete for the whole tournament after backfill),
    // not the provider's stage-limited top-scorers endpoint.
    const agg=statAgg();
    let list=Object.values(agg.goals).map(g=>{ const a=agg.assists[g.name+"|"+g.team]; return {name:g.name,raw:g.name,team:g.team,v:g.v,assists:a?a.v:0}; });
    if(list.length){
      const roster=scorerRoster();
      list.forEach(s=>{ s.name=prettyName(s.raw,s.team,roster); });
      list.sort((a,b)=> b.v-a.v || b.assists-a.assists);
    } else if(STATE.scorers&&STATE.scorers.length){   // fallback before match data has loaded
      list=STATE.scorers.map(s=>({name:s.name,raw:s.name,team:s.team,v:s.goals,assists:s.assists||0}));
    }
    body = list.length ? (function(){
      const top=list[0];
      const tied=list.filter(s=> s.v===top.v && (s.assists||0)===(top.assists||0)).length;
      const lbl = tied>1 ? '🥇 Golden Boot co-leader' : '🥇 Golden Boot leader';
      const isLeader = s => s.v===top.v && (s.assists||0)===(top.assists||0) && top.v>0;
      const note='<div class="gbnote">🥇 Current Golden Boot leader — updates live as goals go in (the award is decided at the final).</div>';
      return note + list.slice(0,30).map((s,i)=>{
        const bd = playerGoalBreakdown(s.raw, s.team);
        const gbChip = isLeader(s) ? '<span class="gb" title="Provisional — decided at the final">'+lbl+'</span>' : '';
        const row = scRow(i+1,
          crest(s.team), s.name, s.team,
          (s.assists?'<div class="stat sub"><div class="v">'+s.assists+'</div><div class="k">Ast</div></div>':'')+
          '<div class="stat"><div class="v">'+s.v+'</div><div class="k">Goals</div></div>',
          gbChip + bdgChips(playerBadges(s.raw, s.team)));
        if(!bd.length) return '<div class="sc-item" data-okey="sc:'+esc(s.raw)+'|'+esc(s.team)+'">'+row+'</div>';
        const detail = '<div class="pdtl" hidden>'+ bd.map(g=>
          '<div class="pdrow">'+crest(g.opp)+
            '<span class="pdopp">'+(g.home?'vs ':'@ ')+esc(g.opp)+'</span>'+
            '<span class="pdwhen">'+(g.date?esc(g.date.slice(5)):'')+'</span>'+
            '<span class="pdmin">'+g.goals.map(x=> esc(x.minute)+(x.pen?' <span class="pen">P</span>':'')).filter(Boolean).join(", ")+'</span>'+
            '<span class="pdn">'+g.n+(g.n>1?' goals':' goal')+(g.pens?' · '+g.pens+' pen':'')+'</span>'+
            (g.n>=3?'<span class="bdg">🎩 Hat-trick</span>':g.n===2?'<span class="bdg">⚽ Brace</span>':'')+
          '</div>').join("") +'</div>';
        return '<div class="sc-item" data-okey="sc:'+esc(s.raw)+'|'+esc(s.team)+'">'+row+detail+'</div>';
      }).join("");
    })()
      : emptyStat("No goals yet","The Golden Boot race will fill in here as goals go in.");
  } else if(STAT_VIEW==="assists"){
    const agg=statAgg(); const roster=scorerRoster();
    const list=Object.values(agg.assists).map(a=>({name:prettyName(a.name,a.team,roster),team:a.team,v:a.v})).sort((x,y)=>y.v-x.v);
    body = list.length ? list.slice(0,30).map((s,i)=> scRow(i+1,
      crest(s.team), s.name, s.team,
      '<div class="stat"><div class="v">'+s.v+'</div><div class="k">Assists</div></div>',
      (i===0 && s.v>0) ? '<span class="bdg">🅰️ Playmaker</span>' : '')).join("")
      : emptyStat("No assists recorded yet","Assist data appears as goals with a provider are logged.");
  } else if(STAT_VIEW==="cards"){
    const c=statAgg().cards; const roster=scorerRoster();
    const list=Object.values(c).sort((x,y)=> y.r-x.r || y.y-x.y || (y.r*2+y.y)-(x.r*2+x.y));
    body = list.length ? list.slice(0,40).map((s,i)=> scRow(i+1,
      crest(s.team), prettyName(s.name,s.team,roster), s.team,
      '<div class="stat sub"><div class="v">'+s.y+'</div><div class="k">🟨</div></div>'+
      '<div class="stat"><div class="v">'+s.r+'</div><div class="k">🟥</div></div>')).join("")
      : emptyStat("No cards yet","Bookings and dismissals will be tallied here.");
  } else if(STAT_VIEW==="team"){
    const list=teamCards();
    body = list.length ? list.map((s,i)=> scRow(i+1,
      crest(s.team), s.team, (s.y+s.r)+" total · "+s.r+" red"+(s.r===1?"":"s"),
      '<div class="stat sub"><div class="v">'+s.y+'</div><div class="k">🟨</div></div>'+
      '<div class="stat"><div class="v">'+s.r+'</div><div class="k">🟥</div></div>')).join("")
      : emptyStat("No cards yet","Team bookings will be tallied here as matches are played.");
  } else { // clean sheets
    const list=cleanSheets();
    body = list.length ? list.map((s,i)=> scRow(i+1,
      crest(s.team), s.team, "Matches without conceding",
      '<div class="stat"><div class="v">'+s.v+'</div><div class="k">Clean</div></div>')).join("")
      : emptyStat("No clean sheets yet","A team earns one for each completed match without conceding.");
  }
  const prevFocused = document.activeElement && document.activeElement.id==="statSearch";
  const prevCaret = prevFocused ? document.activeElement.selectionStart : null;
  const search='<div class="statSearch"><input id="statSearch" type="text" autocomplete="off" spellcheck="false" '+
    'placeholder="Search a player or country…" value="'+esc(STAT_Q)+'">'+
    (STAT_Q?'<span class="ssClear" id="statClear" title="Clear">×</span>':'')+'</div>';
  el.innerHTML = seg + search + '<div class="scList">'+body+'</div>'+
    '<div id="statNoMatch" class="sc-empty" hidden><b>No matches</b>Nothing for that player or country — check the spelling, or try the country name.</div>';
  el.querySelectorAll(".seg button").forEach(b=> b.onclick=()=>{ STAT_VIEW=b.dataset.stat; renderScorers(); });
  el.querySelectorAll(".sc-item").forEach(it=>{
    const row=it.querySelector(".sc-row"), dtl=it.querySelector(".pdtl");
    if(dtl){ row.classList.add("expandable"); row.onclick=()=>{ const open=dtl.hidden; dtl.hidden=!open; row.classList.toggle("open",open); }; }
  });
  const si=$("#statSearch");
  if(si){
    si.oninput=function(){ STAT_Q=this.value; const had=!!$("#statClear");
      if((!!STAT_Q)!==had) renderScorers(); else filterScorers(); };
    const sc=$("#statClear"); if(sc) sc.onclick=()=>{ STAT_Q=""; renderScorers(); };
    if(prevFocused){ si.focus(); try{ si.setSelectionRange(prevCaret,prevCaret); }catch(e){} }
  }
  filterScorers();
}
function emptyStat(t,s){ return '<div class="sc-empty"><b>'+esc(t)+'</b>'+esc(s)+'</div>'; }

function esc(t){ return (t==null?"":String(t)).replace(/[&<>]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;"}[c];}); }
function cardExtras(m, ctx){
  ctx = ctx || "";
  const ex = STATE.matchExtra && STATE.matchExtra[m.id];
  if(!ex) return "";
  let html = "";
  if(ex.scorers && ex.scorers.length){
    html += '<div class="goals">'+ex.scorers.map(function(g){
      var d = (g.detail && g.detail!=="Normal Goal")
        ? ' <span class="gd">('+esc(g.detail.replace("Penalty","pen").replace("Own Goal","OG"))+')</span>' : '';
      var a = g.assist ? ' <span class="ga">↳ '+esc(g.assist)+'</span>' : '';
      return '<div class="g"><span class="gm">'+esc(g.minute)+'</span> ⚽ '+esc(g.name)+d+a+'</div>';
    }).join("")+'</div>';
  }
  const lh = ex.lineups && ex.lineups.home, la = ex.lineups && ex.lineups.away;
  const has = (lu)=> lu && lu.xi && lu.xi.length;
  if(has(lh) || has(la)){
    const xi = function(lu,team){ return has(lu)
      ? '<div class="xi"><div class="xih">'+esc(team)+(lu.formation?' · '+esc(lu.formation):'')+'</div>'+
        lu.xi.map(function(n){return '<div>'+esc(n)+'</div>';}).join("")+'</div>' : ''; };
    html += '<button class="luBtn" data-lu="'+ctx+m.id+'">Lineups ▾</button>'+
            '<div class="luPanel" id="lu-'+ctx+m.id+'" data-okey="lu-'+ctx+m.id+'" style="display:none">'+xi(lh,m.home)+xi(la,m.away)+'</div>';
  }
  if(ex.cards && ex.cards.length){
    html += '<div class="cards">'+ex.cards.map(function(c){
      var sq = c.type==="red" ? '🟥' : '🟨';
      return '<div class="cd"><span class="gm">'+esc(c.minute)+'</span> '+sq+' '+esc(c.player)+'</div>';
    }).join("")+'</div>';
  }
  if(ex.stats && ex.stats.length){
    html += '<button class="luBtn" data-lu="st-'+ctx+m.id+'">Match stats ▾</button>'+
            '<div class="luPanel statPanel" id="lu-st-'+ctx+m.id+'" data-okey="lu-st-'+ctx+m.id+'" style="display:none">'+
              '<div class="statHd"><span>'+esc(m.home)+'</span><span></span><span>'+esc(m.away)+'</span></div>'+
              ex.stats.map(function(s){
                return '<div class="statRow"><span>'+esc(s.home)+'</span><span class="stT">'+esc(s.type)+'</span><span>'+esc(s.away)+'</span></div>';
              }).join("")+'</div>';
  }
  return html;
}

function renderToday(){
  const isLive = m => matchPhase(m)==="live";
  // Board window: live now, kicking off within ~14h, OR finished within the last ~30h.
  let todays = STATE.matches.filter(m=>{
    if(isLive(m)) return true;
    const since = Date.now() - new Date(m.kickoff).getTime();
    return since >= -14*60*60*1000 && since <= 30*60*60*1000;
  });
  let list, mode;
  if(todays.length){
    const rank = m => isLive(m) ? 0 : (matchPhase(m)==="scheduled" ? 1 : 2);
    list = todays.sort((a,b)=>{
      if(rank(a)!==rank(b)) return rank(a)-rank(b);
      // upcoming: soonest first; finished: most recent first; live: by kickoff
      const dir = rank(a)===2 ? -1 : 1;
      return dir*(new Date(a.kickoff)-new Date(b.kickoff));
    });
    mode = "today";
  } else {
    list = STATE.matches.filter(m=>m.result).slice(-4).reverse();
    mode = "recent";
  }
  if(!list.length){ $("#todaySection").innerHTML=""; return; }
  const anyL = todays.some(isLive);
  const anyUpcoming = todays.some(m=>matchPhase(m)==="scheduled");
  const title = anyL ? '<span class="livebadge"><i></i>LIVE NOW</span>'
              : mode!=="today" ? "Latest Results"
              : anyUpcoming ? "Recent &amp; Upcoming" : "Recent Results";
  $("#todaySection").innerHTML =
    '<h2>'+title+'</h2><div class="today-grid">'+
    list.map(m=>{
      try{
      const ph = matchPhase(m);
      const sc = m.result ? '<span class="sc">'+m.result.home+'</span>' : '<span class="sc">–</span>';
      const sa = m.result ? '<span class="sc">'+m.result.away+'</span>' : '<span class="sc">–</span>';
      const tag = ph==="live" ? ('<span class="livedot"></span>'+liveMinute(m))
                : ph==="done" ? "FT" : ("GRP "+m.group);
      return '<div class="tcard '+(ph==="live"?"live":"")+(ph==="done"?" done":"")+'" data-mid="'+m.id+'">'+
        '<span class="gtag">'+tag+'</span>'+
        '<div class="when">'+m.date.slice(5)+' · '+m.time+' · '+m.city+'</div>'+
        '<div class="row"><span class="tnm2">'+crest(m.home)+m.home+'</span>'+sc+'</div>'+
        '<div class="vs">vs</div>'+
        '<div class="row"><span class="tnm2">'+crest(m.away)+m.away+'</span>'+sa+'</div>'+
        (function(){ const mb=matchBadges(m); return mb.length?'<div class="cbdg">'+bdgChips(mb)+'</div>':''; })()+
        cardExtras(m)+
      '</div>';
      }catch(e){ return ''; }
    }).join("")+'</div>';
}

function renderGroups(){
  const wrap = $("#groups"); wrap.innerHTML="";
  const ACC=["var(--c1)","var(--c2)","var(--c3)","var(--c4)","var(--c5)","var(--c6)"];
  Object.keys(STATE.standings).forEach((g,gi)=>{
    const rows = STATE.standings[g];
    const total = STATE.matches.filter(m=>m.group===g).length;
    const played = STATE.matches.filter(m=>m.group===g && m.result).length;
    const groupComplete = total>0 && played===total;
    const maxGF = rows.length ? Math.max.apply(null, rows.map(r=>r.GF)) : 0;
    const minGA = rows.length ? Math.min.apply(null, rows.map(r=>r.GA)) : 0;
    const el = document.createElement("div");
    el.className="group"; el.style.setProperty("--acc",ACC[gi%6]);
    el.innerHTML =
      '<div class="ghead"><div class="gname"><span class="badge">'+g+'</span>Group <b>'+g+'</b></div>'+
        '<div class="gprog">'+played+' / '+total+' played</div></div>'+
      '<table><thead><tr>'+
        '<th class="tl">Team</th><th>P</th><th>W</th><th>D</th><th>L</th>'+
        '<th>GF</th><th>GA</th><th>GD</th><th>Pts</th><th class="fcol">Form</th></tr></thead><tbody>'+
        rows.map(r=>
          '<tr class="'+(r.status||"")+'">'+
            '<td class="tl"><div class="teamcell"><span class="pos">'+r.pos+'</span>'+
              crest(r.team)+'<span class="tnm">'+r.team+'</span>'+
              (r.qual==="in"?'<span class="qtag qin" title="Qualified for the Round of 32">Q</span>'
               :r.qual==="out"?'<span class="qtag qout" title="Eliminated — cannot reach the Round of 32">OUT</span>':'')+
              (function(){ const tb=[];
                if(groupComplete && r.pos===1) tb.push(["👑","Group winner"]);
                if(r.W===3) tb.push(["💯","Perfect run"]);
                if(groupComplete && r.GF===maxGF && r.GF>0) tb.push(["🔥","Best attack"]);
                if(groupComplete && r.GA===minGA) tb.push(["🧱","Wall"]);
                return bdgChips(tb); })()+
            '</div></td>'+
            '<td>'+r.P+'</td><td>'+r.W+'</td><td>'+r.D+'</td><td>'+r.L+'</td>'+
            '<td>'+r.GF+'</td><td>'+r.GA+'</td><td>'+(r.GD>0?"+":"")+r.GD+'</td>'+
            '<td class="pts">'+r.Pts+'</td>'+
            '<td class="fcol"><span class="formdots">'+formDots(r.team)+'</span></td>'+
          '</tr>').join("")+
      '</tbody></table>'+
      (function(){
        const alive = rows.filter(r=>r.qual!=="in" && r.qual!=="out" && r.scenario);
        if(played===0 || !alive.length) return "";
        return '<details class="scen" data-okey="scen:'+g+'"><summary>What needs to happen</summary>'+
          rows.filter(r=>r.scenario).map(r=>
            '<div class="scrow"><span class="sicon '+(r.qual||"")+'">'+
              (r.qual==="in"?"✓":r.qual==="out"?"✗":"•")+'</span>'+
              crest(r.team)+'<span class="snm">'+r.team+'</span>'+
              '<span class="stx">'+r.scenario+'</span></div>').join("")+
        '</details>';
      })();
    wrap.appendChild(el);
  });
}

function renderFixtures(){
  // filter bar
  const fb = $("#filter");
  if(!fb.dataset.built){
    fb.innerHTML = '<span class="lbl">Group</span>'+
      ['ALL',...Object.keys(STATE.groups)].map(g=>
        '<button data-g="'+g+'" class="'+(g==="ALL"?"active":"")+'">'+(g==="ALL"?"All":g)+'</button>').join("");
    fb.querySelectorAll("button").forEach(b=>b.onclick=()=>{
      GROUP_FILTER=b.dataset.g;
      fb.querySelectorAll("button").forEach(x=>x.classList.toggle("active",x===b));
      renderFixtures();
    });
    fb.dataset.built="1";
  }
  const matches = STATE.matches.filter(m=>GROUP_FILTER==="ALL"||m.group===GROUP_FILTER);
  const byDay = {};
  for(const m of matches){ (byDay[m.date]=byDay[m.date]||[]).push(m); }

  const out = Object.keys(byDay).sort().map(date=>{
    const d = new Date(date+"T12:00:00");
    const label = d.toLocaleDateString([], {weekday:"long",month:"long",day:"numeric"});
    return '<div class="day"><h3 class="dhead"><span class="num">'+date.slice(5).replace("-","/")+'</span> '+label+'</h3>'+
      byDay[date].map(m=>{
        const r = m.result;
        const hw = r && r.home>r.away, aw = r && r.away>r.home;
        const ph = matchPhase(m);
        const liveTag = ph==="live" ? '<span class="fxlive"><span class="livedot"></span>'+liveMinute(m)+'</span>' : '';
        const fxx = cardExtras(m,"fx"); const fxxHtml = fxx ? '<div class="fxx">'+fxx+'</div>' : '';
        return '<div class="fx '+(r?"played":"")+(ph==="live"?" islive":"")+'" data-mid="'+m.id+'">'+
          '<div class="gp">GRP <b>'+m.group+'</b></div>'+
          '<div class="time">'+(ph==="live"?liveTag:m.time.replace(" ET",""))+'</div>'+
          '<div class="match">'+
            '<div class="side h"><span class="nm '+(hw?"win":"")+'">'+m.home+'</span>'+crest(m.home)+'</div>'+
            '<div class="score">'+
              '<span class="scv '+(hw?"win":"")+'">'+(r?r.home:"–")+'</span>'+
              '<span class="sep">:</span>'+
              '<span class="scv '+(aw?"win":"")+'">'+(r?r.away:"–")+'</span>'+
            '</div>'+
            '<div class="side a">'+crest(m.away)+'<span class="nm '+(aw?"win":"")+'">'+m.away+'</span></div>'+
          '</div>'+
          '<div class="venue"><b>'+m.stadium+'</b>'+m.city+'</div>'+
          (function(){ const mb=matchBadges(m); return mb.length?'<div class="cbdg">'+bdgChips(mb)+'</div>':''; })()+
          fxxHtml+
        '</div>';
      }).join("")+'</div>';
  }).join("");
  $("#fixtures").innerHTML = out;
}

const FLAGCACHE = {};
function flagOf(team){
  if(FLAGCACHE[team]!==undefined) return FLAGCACHE[team];
  for(const g of Object.keys(STATE.standings))
    for(const r of STATE.standings[g]) if(r.team===team){ FLAGCACHE[team]=r.flag; return r.flag; }
  return "";
}
// Real crest if the feed has supplied one, otherwise the flag emoji.
// If the image fails to load (e.g. offline), it swaps back to the flag.
function crest(team, cls){
  const fl = flagOf(team);
  const url = STATE.badges && STATE.badges[team];
  if(url){
    return '<span class="crest '+(cls||"")+'" data-fb="'+esc(fl)+'">'+
      '<img src="'+esc(url)+'" alt="" loading="lazy" '+
      'onerror="var p=this.parentNode;p.textContent=p.getAttribute(\'data-fb\');p.classList.add(\'isflag\')"></span>';
  }
  return '<span class="crest '+(cls||"")+' isflag">'+fl+'</span>';
}
// Recent W/D/L for a team, oldest → newest (group stage = up to 3).
function formOf(team){
  const ms = STATE.matches.filter(m=>m.result && (m.home===team||m.away===team))
    .sort((a,b)=> new Date(a.kickoff)-new Date(b.kickoff));
  return ms.map(m=>{
    const us=m.home===team?m.result.home:m.result.away, th=m.home===team?m.result.away:m.result.home;
    return us>th?"W":us<th?"L":"D";
  });
}
function formDots(team){
  const f=formOf(team);
  if(!f.length) return '<span class="fd-none">–</span>';
  return f.map(x=>'<span class="fd fd-'+x.toLowerCase()+'" title="'+(x==="W"?"Win":x==="D"?"Draw":"Loss")+'">'+x+'</span>').join("");
}

// Attach the edit PIN (if the user has set one on this device) to write requests.
function pinHeaders(extra){ const h=Object.assign({}, extra||{}); const p=localStorage.getItem("wc_pin"); if(p) h["X-WC-PIN"]=p; return h; }
async function unlockEditing(){
  const p = prompt("Enter the edit PIN to make changes from this device:");
  if(p){ localStorage.setItem("wc_pin", p.trim()); await load(); return true; }
  return false;
}
async function saveMatch(id, btn){
  const h = $('input[data-fid="'+id+'"][data-sd="home"]').value;
  const a = $('input[data-fid="'+id+'"][data-sd="away"]').value;
  const res = await fetch("/api/result",{method:"POST",headers:pinHeaders({"Content-Type":"application/json"}),
    body:JSON.stringify({matchId:id, home:h, away:a})});
  if(res.status===403){
    btn.textContent="Locked";
    if(STATE.pinSet){ if(await unlockEditing()) saveMatch(id, btn); }
    else alert("This tracker is view-only on this device. Scores are entered on the host PC.");
    return;
  }
  const data = await res.json();
  if(data.ok){
    btn.textContent="Saved"; btn.classList.add("saved");
    setTimeout(()=>{ btn.textContent="Save"; btn.classList.remove("saved"); },1100);
    await load();
  } else { btn.textContent="Error"; }
}

const PITCH_SVG='<svg class="pitchsvg" viewBox="0 0 100 150" preserveAspectRatio="none">'+
 '<g stroke="rgba(255,255,255,.28)" stroke-width="0.5" fill="none">'+
 '<rect x="3" y="3" width="94" height="144" rx="2"/>'+
 '<line x1="3" y1="75" x2="97" y2="75"/>'+
 '<circle cx="50" cy="75" r="11"/><circle cx="50" cy="75" r="1" fill="rgba(255,255,255,.35)" stroke="none"/>'+
 '<rect x="22" y="3" width="56" height="20"/><rect x="38" y="3" width="24" height="8"/>'+
 '<rect x="22" y="127" width="56" height="20"/><rect x="38" y="139" width="24" height="8"/>'+
 '</g></svg>';
function mcShort(n){ const parts=(n||"").trim().split(/\s+/); return parts.length>1 ? parts[parts.length-1] : n; }
function mcGuessRows(n){ if(n===10) return [4,3,3]; const r=[]; let left=n; while(left>0){ const c=Math.min(4,left); r.push(c); left-=c; } return r; }
function mcRows(lineup){
  let players = (lineup.pitch && lineup.pitch.length) ? lineup.pitch.slice()
              : (lineup.xi||[]).map((n,i)=>({n:n, num:"", p:i+1}));
  players.sort((a,b)=>(a.p||99)-(b.p||99));
  if(!players.length) return [];
  let parts=(lineup.formation||"").split("-").map(x=>parseInt(x)).filter(x=>x>0);
  const outfield=players.slice(1);
  if(!parts.length || parts.reduce((s,x)=>s+x,0)!==outfield.length) parts=mcGuessRows(outfield.length);
  const rows=[[players[0]]]; let idx=0;
  for(const c of parts){ rows.push(outfield.slice(idx, idx+c)); idx+=c; }
  return rows;
}
function mcMatchScore(a,b){
  const tok=s=>(s||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().split(/\s+/).map(t=>t.replace(/[^a-z0-9]/g,"")).filter(t=>t.length>=3);
  const A=tok(a), B=tok(b); let sc=0; for(const t of A){ if(B.includes(t)) sc+=t.length; } return sc;
}
function mcAssign(events, names){
  const res={};
  for(const e of events){
    let best=null, bestScore=0;
    for(const nm of names){ const sc=mcMatchScore(e.name, nm); if(sc>bestScore){ bestScore=sc; best=nm; } }
    if(best && bestScore>=4){ res[best]=res[best]||{goals:0,yellow:false,red:false};
      if(e.goal) res[best].goals++; if(e.card==="yellow") res[best].yellow=true; if(e.card==="red") res[best].red=true; }
  }
  return res;
}
function mcNames(lu){ return lu ? ((lu.pitch&&lu.pitch.length)?lu.pitch.map(p=>p.n):(lu.xi||[])) : []; }
function mcPlace(rows, side, badges){
  if(!rows||!rows.length) return '';
  const R=rows.length; let out='';
  rows.forEach((row,i)=>{
    let y = side==="home" ? (R>1 ? 96 - i*((96-54)/(R-1)) : 75)
                          : (R>1 ? 4 + i*((46-4)/(R-1)) : 25);
    const c=row.length;
    row.forEach((p,j)=>{
      const x=(j+1)/(c+1)*100;
      const b=badges&&badges[p.n];
      let bdg=''; if(b){ if(b.goals) bdg+='⚽'+(b.goals>1?b.goals:''); if(b.red) bdg+='🟥'; else if(b.yellow) bdg+='🟨'; }
      out+='<div class="pm '+side+'" style="left:'+x+'%;top:'+y+'%"><span class="num">'+esc(p.num||"")+(bdg?'<span class="pmb">'+bdg+'</span>':'')+'</span><span class="pn">'+esc(mcShort(p.n))+'</span></div>';
    });
  });
  return out;
}
function mcPitch(home, away, ex, m){
  const hasH = home && ((home.pitch&&home.pitch.length)||(home.xi&&home.xi.length));
  const hasA = away && ((away.pitch&&away.pitch.length)||(away.xi&&away.xi.length));
  const evFor=team=> ((ex.scorers||[]).filter(g=>g.team===team).map(g=>({name:g.name,goal:true})))
    .concat((ex.cards||[]).filter(c=>c.team===team).map(c=>({name:c.player,card:c.type})));
  const bH=mcAssign(evFor(m.home), mcNames(home)), bA=mcAssign(evFor(m.away), mcNames(away));
  return '<div class="pitch">'+PITCH_SVG+(hasH?mcPlace(mcRows(home),"home",bH):'')+(hasA?mcPlace(mcRows(away),"away",bA):'')+'</div>';
}
function mcEligible(){
  const ok = lu => lu && ((lu.xi&&lu.xi.length)||(lu.pitch&&lu.pitch.length));
  return STATE.matches.filter(m=>{ const ex=STATE.matchExtra&&STATE.matchExtra[m.id];
    return ex && ex.lineups && (ok(ex.lineups.home) || ok(ex.lineups.away)); });
}
function mcBodyHtml(m){
  const ex=STATE.matchExtra[m.id], ph=matchPhase(m), r=m.result;
  const lf=ex.lineups.home&&ex.lineups.home.formation, af=ex.lineups.away&&ex.lineups.away.formation;
  const status = ph==="live" ? ('<span class="livedot"></span>'+liveMinute(m)) : ph==="done" ? "FT" : m.time.replace(" ET","");
  const head='<div class="mcHead">'+
    '<div class="mcTeam">'+crest(m.home,"big")+'<span>'+esc(m.home)+'</span>'+(lf?'<span class="mcForm">'+esc(lf)+'</span>':'')+'</div>'+
    '<div class="mcScore"><div class="mcSc">'+(r?('<b>'+r.home+'</b><span>:</span><b>'+r.away+'</b>'):'<span class="vsd">vs</span>')+'</div><div class="mcStatus">'+status+'</div></div>'+
    '<div class="mcTeam">'+crest(m.away,"big")+'<span>'+esc(m.away)+'</span>'+(af?'<span class="mcForm">'+esc(af)+'</span>':'')+'</div>'+
  '</div>';
  let detail='';
  detail += mcTimeline(ex, m);
  if(ex.stats&&ex.stats.length){ detail+='<div class="statPanel" style="margin-top:12px">'+
    '<div class="statHd"><span>'+esc(m.home)+'</span><span></span><span>'+esc(m.away)+'</span></div>'+
    ex.stats.map(function(st){ return '<div class="statRow"><span>'+esc(st.home)+'</span><span class="stT">'+esc(st.type)+'</span><span>'+esc(st.away)+'</span></div>'; }).join("")+'</div>'; }
  return head+mcPitch(ex.lineups.home, ex.lineups.away, ex, m)+(detail?'<div class="mcDetail">'+detail+'</div>':'');
}
// Chronological match timeline: goals ⚽, cards 🟨🟥, subs 🔁 — home on the left, away on the right.
function mcTimeline(ex, m){
  const E=[];
  const mn=v=>{ const s=String(v||"").replace(/[^0-9+]/g,""); const p=s.split("+"); return (parseInt(p[0]||"0",10)||0)+(p[1]?(parseInt(p[1],10)||0)/100:0); };
  const lab=v=>esc(String(v||"").replace(/'/g,""))+"'";
  (ex.scorers||[]).forEach(g=>E.push({n:mn(g.minute),m:g.minute,s:g.team===m.away?"a":"h",
    t:'⚽ '+esc(g.name)+(g.detail&&g.detail!=="Normal Goal"?' <span class="tgd">('+esc(g.detail.replace("Penalty","pen").replace("Own Goal","OG"))+')</span>':'')+(g.assist?' <span class="tga">· '+esc(g.assist)+'</span>':'')}));
  (ex.cards||[]).forEach(c=>E.push({n:mn(c.minute),m:c.minute,s:c.team===m.away?"a":"h",
    t:(c.type==="red"?'🟥':'🟨')+' '+esc(c.player)}));
  (ex.subs||[]).forEach(s=>E.push({n:mn(s.minute),m:s.minute,s:s.team===m.away?"a":"h",
    t:'🔁 '+esc(s.on||'')+(s.off?' <span class="tgd">'+esc(s.off)+' ↓</span>':'')}));
  if(!E.length) return '';
  E.sort((a,b)=>a.n-b.n);
  return '<div class="tlWrap"><div class="tlTitle">Match timeline</div><div class="tl">'+E.map(e=>
    '<div class="tlr '+e.s+'"><div class="tlc h">'+(e.s==="h"?e.t:'')+'</div>'+
    '<div class="tlm">'+lab(e.m)+'</div><div class="tlc a">'+(e.s==="a"?e.t:'')+'</div></div>').join("")+'</div></div>';
}
// ---- Knockout bracket (official FIFA 2026 slotting) ----
const BRACKET = [
  { r:"Round of 32", ms:[
    {id:73, a:{t:"ru",g:"A"}, b:{t:"ru",g:"B"}, v:"Los Angeles"},
    {id:74, a:{t:"w",g:"E"},  b:{t:"3",g:"A/B/C/D/F"}, v:"Boston"},
    {id:75, a:{t:"w",g:"F"},  b:{t:"ru",g:"C"}, v:"Guadalajara"},
    {id:76, a:{t:"w",g:"C"},  b:{t:"ru",g:"F"}, v:"Houston"},
    {id:77, a:{t:"w",g:"I"},  b:{t:"3",g:"C/D/F/G/H"}, v:"New York / NJ"},
    {id:78, a:{t:"ru",g:"E"}, b:{t:"ru",g:"I"}, v:"Dallas"},
    {id:79, a:{t:"w",g:"A"},  b:{t:"3",g:"C/E/F/H/I"}, v:"Mexico City"},
    {id:80, a:{t:"w",g:"L"},  b:{t:"3",g:"E/H/I/J/K"}, v:"Atlanta"},
    {id:81, a:{t:"w",g:"D"},  b:{t:"3",g:"B/E/F/I/J"}, v:"SF Bay Area"},
    {id:82, a:{t:"w",g:"G"},  b:{t:"3",g:"A/E/H/I/J"}, v:"Seattle"},
    {id:83, a:{t:"ru",g:"K"}, b:{t:"ru",g:"L"}, v:"Toronto"},
    {id:84, a:{t:"w",g:"H"},  b:{t:"ru",g:"J"}, v:"Los Angeles"},
    {id:85, a:{t:"w",g:"B"},  b:{t:"3",g:"E/F/G/I/J"}, v:"Vancouver"},
    {id:86, a:{t:"w",g:"J"},  b:{t:"ru",g:"H"}, v:"Miami"},
    {id:87, a:{t:"w",g:"K"},  b:{t:"3",g:"D/E/I/J/L"}, v:"Kansas City"},
    {id:88, a:{t:"ru",g:"D"}, b:{t:"ru",g:"G"}, v:"Dallas"}
  ]},
  { r:"Round of 16", ms:[
    {id:89, a:{t:"m",m:74}, b:{t:"m",m:77}, v:"Philadelphia"},
    {id:90, a:{t:"m",m:73}, b:{t:"m",m:75}, v:"Houston"},
    {id:91, a:{t:"m",m:76}, b:{t:"m",m:78}, v:"New York / NJ"},
    {id:92, a:{t:"m",m:79}, b:{t:"m",m:80}, v:"Mexico City"},
    {id:93, a:{t:"m",m:83}, b:{t:"m",m:84}, v:"Dallas"},
    {id:94, a:{t:"m",m:81}, b:{t:"m",m:82}, v:"Seattle"},
    {id:95, a:{t:"m",m:86}, b:{t:"m",m:88}, v:"Atlanta"},
    {id:96, a:{t:"m",m:85}, b:{t:"m",m:87}, v:"Vancouver"}
  ]},
  { r:"Quarter-finals", ms:[
    {id:97,  a:{t:"m",m:89}, b:{t:"m",m:90}, v:"Boston"},
    {id:98,  a:{t:"m",m:93}, b:{t:"m",m:94}, v:"Los Angeles"},
    {id:99,  a:{t:"m",m:91}, b:{t:"m",m:92}, v:"Miami"},
    {id:100, a:{t:"m",m:95}, b:{t:"m",m:96}, v:"Kansas City"}
  ]},
  { r:"Semi-finals", ms:[
    {id:101, a:{t:"m",m:97}, b:{t:"m",m:98}, v:"Arlington, TX"},
    {id:102, a:{t:"m",m:99}, b:{t:"m",m:100}, v:"Atlanta"}
  ]},
  { r:"Final", ms:[
    {id:104, a:{t:"m",m:101}, b:{t:"m",m:102}, v:"MetLife · Jul 19"},
    {id:103, a:{t:"l",m:101}, b:{t:"l",m:102}, v:"3rd place · Miami", small:true}
  ]}
];
function bSlot(s){
  if(s.t==="w" || s.t==="ru"){
    const rows = (STATE.standings && STATE.standings[s.g]) || [];
    const lbl = (s.t==="w" ? "Winner " : "Runner-up ") + s.g;
    if(rows.length){
      const done = rows.every(r=>r.P>=3), played = rows.some(r=>r.P>0);
      const tm = rows[s.t==="w"?0:1];
      if(played && tm){
        return '<span class="bteam '+(done?"fin":"prov")+'" title="'+(done?esc(tm.team):"Provisional — "+lbl+" (group not finished)")+'">'+
          crest(tm.team)+'<span class="bnm">'+esc(tm.team)+'</span>'+(done?'':'<i class="pdot"></i>')+'</span>';
      }
    }
    return '<span class="bslot">'+lbl+'</span>';
  }
  if(s.t==="3") return '<span class="bslot">3rd · '+esc(s.g)+'</span>';
  if(s.t==="m") return '<span class="bslot">Winner M'+s.m+'</span>';
  if(s.t==="l") return '<span class="bslot">Loser M'+s.m+'</span>';
  return '<span class="bslot">TBD</span>';
}
function renderBracket(){
  const anyComplete = Object.values(STATE.standings||{}).some(rows=>rows.length&&rows.every(r=>r.P>=3));
  $("#bracketNote").innerHTML =
    'The full path to the MetLife final. Group winners &amp; runners-up fill in as each group is decided '+
    '(<span class="bteam prov" style="display:inline-flex"><i class="pdot"></i></span> = provisional while the group is still being played). '+
    'The eight best third-placed teams are slotted by FIFA\u2019s Annex C table once all groups finish on June 27.';
  $("#bracket").innerHTML = BRACKET.map(col=>
    '<div class="bcol"><h4>'+col.r+'</h4>'+
      col.ms.map(m=>
        '<div class="bmatch'+(m.small?" small":"")+'">'+
          '<div class="bmnum">M'+m.id+' · '+esc(m.v)+'</div>'+
          '<div class="brow">'+bSlot(m.a)+'</div>'+
          '<div class="brow">'+bSlot(m.b)+'</div>'+
        '</div>').join("")+
    '</div>').join("");
}

function renderMatchCenter(){
  const elS=$("#mcSel"), elB=$("#mcBody"); if(!elS||!elB) return;
  const list=mcEligible();
  if(!list.length){ elS.innerHTML=""; elB.innerHTML='<div class="mcEmpty"><b>No lineups yet</b><span>Lineups appear here around an hour before kickoff and stay afterward — check back when a match is near.</span></div>'; return; }
  const rank=m=>matchPhase(m)==="live"?0:1;
  list.sort((a,b)=> rank(a)-rank(b) || (new Date(b.kickoff)-new Date(a.kickoff)));
  if(!MC_MATCH || !list.find(m=>m.id===MC_MATCH)) MC_MATCH=list[0].id;
  elS.innerHTML=list.map(function(m){ const ph=matchPhase(m);
    const tag=ph==="live"?liveMinute(m):ph==="done"?"FT":m.time.replace(" ET","");
    return '<button class="mcTab '+(m.id===MC_MATCH?"on":"")+'" data-mc="'+m.id+'">'+
      '<span class="fl">'+flagOf(m.home)+'</span> '+esc(m.home)+' v '+esc(m.away)+' <span class="fl">'+flagOf(m.away)+'</span>'+
      '<span class="mcTag">'+tag+'</span></button>'; }).join("");
  elS.querySelectorAll("[data-mc]").forEach(b=>b.onclick=()=>{ MC_MATCH=b.dataset.mc; renderMatchCenter(); });
  elB.innerHTML=mcBodyHtml(list.find(x=>x.id===MC_MATCH));
}
function renderVenues(){
  const counts={};
  for(const m of STATE.matches){ const k=m.stadium; counts[k]=counts[k]||{...m,n:0}; counts[k].n++; }
  $("#venues").innerHTML = Object.values(counts)
    .sort((a,b)=>b.n-a.n)
    .map(v=>'<div class="vcard"><div class="vn">'+v.stadium+'</div>'+
      '<div class="vc">'+v.city+' · '+v.country+'</div>'+
      '<div class="vcount"><b>'+v.n+'</b> group matches</div></div>').join("");
}

// tab switching
document.querySelectorAll("nav.tabs button").forEach(b=>{
  b.onclick=()=>{
    VIEW=b.dataset.view;
    document.querySelectorAll("nav.tabs button").forEach(x=>x.classList.toggle("active",x===b));
    ["standings","fixtures","bracket","matchcenter","scorers"].forEach(v=>
      $("#view-"+v).classList.toggle("hidden", v!==VIEW));
    renderAll();
  };
});

$("#resetBtn").onclick = async ()=>{
  if(!confirm("Clear every saved score?")) return;
  const res = await fetch("/api/reset",{method:"POST",headers:pinHeaders()});
  if(res.status===403){
    if(STATE.pinSet){ if(await unlockEditing()) $("#resetBtn").onclick(); }
    else alert("This tracker is view-only on this device. Scores are managed on the host PC.");
    return;
  }
  await load();
};

// Goal-alert toggles
$("#alertsBtn").onclick = async ()=>{
  if(!ALERTS_ON){
    if("Notification" in window){
      let perm = Notification.permission;
      if(perm==="default"){ try{ perm = await Notification.requestPermission(); }catch(e){} }
      if(perm!=="granted"){ alert("Your browser blocked notifications. Allow them for this site, then try again."); return; }
    } else { alert("This browser doesn't support notifications."); return; }
    ALERTS_ON = true;
  } else { ALERTS_ON = false; }
  localStorage.setItem("wc_alerts", ALERTS_ON?"1":"0");
  syncAlertButtons();
};
$("#soundBtn").onclick = ()=>{
  SOUND_ON = !SOUND_ON;
  localStorage.setItem("wc_sound", SOUND_ON?"1":"0");
  if(SOUND_ON){ ensureAudio(); goalSound(); }   // unlock audio + preview the chime
  syncAlertButtons();
};
syncAlertButtons();

document.addEventListener("click",function(e){
  const b = e.target.closest && e.target.closest("[data-lu]");
  if(!b) return;
  const p = document.getElementById("lu-"+b.dataset.lu);
  if(p){ const open = p.style.display!=="none"; p.style.display = open?"none":"block";
    b.textContent = _luLabel(b.dataset.lu)+(open?" ▾":" ▴");
    OPEN["lu-"+b.dataset.lu] = open?undefined:1; }
});
if("serviceWorker" in navigator){window.addEventListener("load",function(){navigator.serviceWorker.register("/sw.js").catch(function(){});});}
load();
// Adaptive refresh: every 10s when a match is live, every 30s otherwise.
(function pollLoop(){
  setTimeout(function(){
    load().finally(pollLoop);
  }, anyLive() ? 10000 : 30000);
})();
</script>
</body>
</html>`;
