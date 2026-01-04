/**
 * Ferrari — Double Elimination (Version 2)
 *
 * NEW RULE: Every round (Start/WB/LB) may have at most ONE BYE.
 * - If a round needs a BYE, it goes to the LOWEST SEED among that round's entrants.
 * - BYE is shown as a match for layout, but does NOT count as a win.
 * - This requires dynamic round construction (cannot be fully pre-skeletoned).
 *
 * Determinism:
 * - Entrants are ordered deterministically.
 * - Pairing is 1v2, 3v4, ... in entrant order after removing the BYE recipient (if needed).
 * - When BYE occurs, we create a match (team vs BYE) and auto-advance that team.
 *
 * Saves:
 * - Autosave to localStorage
 * - Export/Load Save JSON
 *
 * Provenance:
 * - Matches are sequentially numbered as created (Match 1, Match 2, ...)
 * - Slots show provenance: W of M#, L of M#, ADV (BYE), Seeded
 */

const DATASET_URL = "./data/teams_live.json";
const SAVE_KEY = "ferrari_v2_save";

/** DOM */
const elTeamsList = document.getElementById("teamsList");
const elStartLane = document.getElementById("startLane");
const elWbRounds = document.getElementById("wbRounds");
const elLbRounds = document.getElementById("lbRounds");
const elFinalsLane = document.getElementById("finalsLane");
const elDebug = document.getElementById("debugOut");
const elChampionBanner = document.getElementById("championBanner");

const elBracketViewport = document.getElementById("bracketViewport");
const elStartLaneContainer = document.getElementById("startLaneContainer");

const elTxtDrawList = document.getElementById("txtDrawList");
const elSelDrawMode = document.getElementById("selDrawMode");
const elBtnGenerateTeams = document.getElementById("btnGenerateTeams");
const elBtnStartTournament = document.getElementById("btnStartTournament");
const elDrawListHint = document.getElementById("drawListHint");

const elBtnReloadDataset = document.getElementById("btnReloadDataset");
const elBtnRestartBrackets = document.getElementById("btnRestartBrackets");
const elBtnExportSave = document.getElementById("btnExportSave");
const elFileLoadSave = document.getElementById("fileLoadSave");
const elBtnHardResetAll = document.getElementById("btnHardResetAll");

/** State */
const state = {
  // setup
  drawMode: "team",      // "team" | "snake"
  drawList: [],          // list of player names
  teams: [],             // {id, seed, members:[m1,m2], name, wins, losses}
  teamById: new Map(),

  // tournament structure
  rounds: {
    start: null,         // {title, bracket, roundIndex, matches[]}
    wb: [],              // array of rounds
    lb: [],              // array of rounds
    finals: []           // array of rounds (Finals, Finals Reset optional)
  },

  matchesById: new Map(),      // matchId -> match object
  matchNumById: new Map(),     // matchId -> sequential Match #

  nextMatchNum: 1,

  // dynamic LB pool
  lbPool: [],            // teamIds waiting to be placed into the next LB round

  // finals
  finalsResetEnabled: false,
  championId: null
};

/* -----------------------------
   Utilities
------------------------------ */

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeLines(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function memberDisplay(name) {
  const s = String(name ?? "").trim();
  return s.length ? s : "TBD";
}

function computeTeamName(m1, m2) {
  return `${memberDisplay(m1)} / ${memberDisplay(m2)}`;
}

function makeTeamId(seed) {
  return `t${String(seed).padStart(2, "0")}`;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/**
 * Deterministic ordering for entrant lists:
 * - Primary: seed ascending (1,2,3...)
 * - This keeps everything stable and predictable.
 */
function sortTeamIdsBySeed(teamIds) {
  return [...teamIds].sort((a, b) => {
    const ta = state.teamById.get(a);
    const tb = state.teamById.get(b);
    return (ta?.seed ?? 9999) - (tb?.seed ?? 9999);
  });
}

/* -----------------------------
   Persistence
------------------------------ */

function allMatchesInCreationOrder() {
  // We number matches as we create them; render order uses that.
  return [...state.matchesById.values()].sort((a, b) => {
    const na = state.matchNumById.get(a.matchId) ?? 0;
    const nb = state.matchNumById.get(b.matchId) ?? 0;
    return na - nb;
  });
}

function makeSaveObject() {
  const matchDecisions = {};
  for (const m of allMatchesInCreationOrder()) {
    matchDecisions[m.matchId] = {
      decided: !!m.decided,
      decidedByBye: !!m.decidedByBye,
      winnerId: m.winnerId ?? null,
      loserId: m.loserId ?? null
    };
  }

  return {
    version: 2,
    savedAt: new Date().toISOString(),
    drawMode: state.drawMode,
    drawList: [...state.drawList],
    teams: state.teams.map((t) => ({
      id: t.id,
      seed: t.seed,
      members: [...t.members],
      name: t.name
    })),
    // For deterministic rebuild:
    // We do NOT save entire bracket geometry; we rebuild from decisions.
    matchDecisions
  };
}

function autosave() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(makeSaveObject()));
  } catch (e) {
    console.warn("Autosave failed:", e);
  }
}

function clearAutosave() {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {}
}

function loadAutosave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || obj.version !== 2) return null;
    return obj;
  } catch (e) {
    console.warn("Autosave load failed:", e);
    return null;
  }
}

/* -----------------------------
   Match + Round models
------------------------------ */

function newMatchId(bracket, roundIndex, localIndex) {
  // matchId is stable-ish for that build, but Match # is what users care about.
  // bracket: START | WB | LB | FIN
  return `${bracket}-R${roundIndex}-M${localIndex}`;
}

function makeMatch({ matchId, bracket, roundIndex, slotA, slotB }) {
  // slot: {teamId, fromText}
  return {
    matchId,
    bracket,
    roundIndex,

    slotA: slotA ?? { teamId: null, fromText: "" },
    slotB: slotB ?? { teamId: null, fromText: "" },

    decided: false,
    decidedByBye: false,
    winnerId: null,
    loserId: null
  };
}

function registerMatch(match) {
  state.matchesById.set(match.matchId, match);
  state.matchNumById.set(match.matchId, state.nextMatchNum++);
}

function matchLabel(matchId) {
  const n = state.matchNumById.get(matchId);
  return n ? `M${n}` : matchId;
}

/* -----------------------------
   Tournament Initialization
------------------------------ */

function initEmptyTournament() {
  state.rounds.start = null;
  state.rounds.wb = [];
  state.rounds.lb = [];
  state.rounds.finals = [];
  state.matchesById = new Map();
  state.matchNumById = new Map();
  state.nextMatchNum = 1;
  state.lbPool = [];
  state.finalsResetEnabled = false;
  state.championId = null;
}

function initTournamentFromTeams(teams) {
  state.teams = teams.map((t) => ({ ...t, wins: 0, losses: 0 }));
  state.teamById = new Map(state.teams.map((t) => [t.id, t]));

  initEmptyTournament();

  // START round is simply "WB Round 1" in your UI.
  const entrants = state.teams.map((t) => t.id);
  const startRound = buildRoundFromEntrants({
    bracket: "START",
    title: "Start",
    roundIndex: 1,
    entrants,
    defaultFrom: "Seeded"
  });

  state.rounds.start = startRound;

  // If START had a BYE, it auto-decided that match; process consequences.
  reconcileAfterAnyDecision();

  // Ensure WB and LB rounds exist if possible.
  ensureWbProgress();
  ensureLbProgress();
  ensureFinalsProgress();
}

/* -----------------------------
   Round builder with 0/1 BYE policy
------------------------------ */

/**
 * Build matches for one round from a list of entrant teamIds.
 * Policy: at most one BYE; if odd count -> BYE to LOWEST seed among entrants.
 *
 * Pairing order after BYE removal: 1st vs 2nd, 3rd vs 4th, ...
 */
function buildRoundFromEntrants({ bracket, title, roundIndex, entrants, defaultFrom }) {
  const ordered = sortTeamIdsBySeed(entrants);
  const matches = [];

  let byeTeamId = null;
  let working = [...ordered];

  if (working.length % 2 === 1) {
    // BYE to lowest seed among entrants = highest seed number.
    byeTeamId = pickLowestSeedTeamId(working);
    working = working.filter((id) => id !== byeTeamId);
  }

  // Pair sequentially
  let localIndex = 1;
  for (let i = 0; i < working.length; i += 2) {
    const a = working[i];
    const b = working[i + 1];

    const m = makeMatch({
      matchId: newMatchId(bracket, roundIndex, localIndex++),
      bracket,
      roundIndex,
      slotA: { teamId: a, fromText: defaultFrom },
      slotB: { teamId: b, fromText: defaultFrom }
    });
    registerMatch(m);
    matches.push(m);
  }

  // Add BYE match (one only) if needed
  if (byeTeamId) {
    const m = makeMatch({
      matchId: newMatchId(bracket, roundIndex, localIndex++),
      bracket,
      roundIndex,
      slotA: { teamId: byeTeamId, fromText: defaultFrom },
      slotB: { teamId: null, fromText: "BYE" }
    });

    registerMatch(m);
    // Auto-advance via BYE (does NOT count as a win)
    decideMatchByBye(m, byeTeamId);
    matches.push(m);
  }

  return { title, bracket, roundIndex, matches };
}

function pickLowestSeedTeamId(teamIds) {
  // "lowest seed" in your definition = highest seed number (e.g., seed 15 is lower than seed 1)
  let best = teamIds[0];
  for (const id of teamIds) {
    const t = state.teamById.get(id);
    const b = state.teamById.get(best);
    if ((t?.seed ?? -1) > (b?.seed ?? -1)) best = id;
  }
  return best;
}

/* -----------------------------
   Deciding matches + consequences
------------------------------ */

function decideMatch(match, winnerId, loserId) {
  match.decided = true;
  match.decidedByBye = false;
  match.winnerId = winnerId;
  match.loserId = loserId;

  // slot provenance labels update
  const wLabel = matchLabel(match.matchId);
  // We'll set provenance on future rounds when we build them; here we just reconcile.
}

function decideMatchByBye(match, winnerId) {
  match.decided = true;
  match.decidedByBye = true;
  match.winnerId = winnerId;
  match.loserId = null;
}

/**
 * Recompute team W/L from match history (BYE doesn't count as a win).
 */
function recomputeStats() {
  for (const t of state.teams) {
    t.wins = 0;
    t.losses = 0;
  }

  for (const m of allMatchesInCreationOrder()) {
    if (!m.decided) continue;
    if (m.decidedByBye) continue;
    if (!m.winnerId || !m.loserId) continue;

    const w = state.teamById.get(m.winnerId);
    const l = state.teamById.get(m.loserId);
    if (w) w.wins += 1;
    if (l) l.losses += 1;
  }
}

function isEliminated(teamId) {
  const t = state.teamById.get(teamId);
  return (t?.losses ?? 0) >= 2;
}

/**
 * Every time something is decided, we need to:
 * - update stats
 * - push WB losers into LB pool
 * - check if new rounds should be generated
 * - resolve champion
 */
function reconcileAfterAnyDecision() {
  // 1) stats
  recomputeStats();

  // 2) LB pool: collect any decided match loser who is NOT eliminated yet (after this loss)
  // But avoid duplicates in lbPool.
  const existing = new Set(state.lbPool);

  for (const m of allMatchesInCreationOrder()) {
    if (!m.decided) continue;
    if (!m.loserId) continue;
    if (isEliminated(m.loserId)) continue;
    // Losers of any WB or START match should feed into LB pool
    if (m.bracket === "START" || m.bracket === "WB") {
      if (!existing.has(m.loserId)) {
        state.lbPool.push(m.loserId);
        existing.add(m.loserId);
      }
    }
  }

  // Also: winners of completed LB rounds feed back into lbPool only when the entire LB round is decided.
  // We handle that inside ensureLbProgress() so it stays round-based.

  // 3) finals reset enablement handled in ensureFinalsProgress
}

/* -----------------------------
   Round progression (dynamic)
------------------------------ */

function getStartWinners() {
  if (!state.rounds.start) return [];
  const winners = [];
  for (const m of state.rounds.start.matches) {
    if (m.decided && m.winnerId) winners.push(m.winnerId);
  }
  return winners;
}

function getLastWbRound() {
  return state.rounds.wb.length ? state.rounds.wb[state.rounds.wb.length - 1] : null;
}

function getLastLbRound() {
  return state.rounds.lb.length ? state.rounds.lb[state.rounds.lb.length - 1] : null;
}

function roundIsComplete(round) {
  return round && round.matches.every((m) => m.decided);
}

/**
 * Ensure WB has the next round built whenever the prior WB round is complete.
 */
function ensureWbProgress() {
  // WB Round 1 entrants are START winners.
  // But we present START as its own lane; WB begins at "WB Round 2" in the UI.
  // Internally, our WB[0] will correspond to "WB Round 2".
  let entrants = getStartWinners();
  if (!entrants.length) return;

  // If we already have WB rounds, entrants for the next is winners of last WB round.
  if (state.rounds.wb.length) {
    const last = getLastWbRound();
    if (!roundIsComplete(last)) return;
    entrants = last.matches.map((m) => m.winnerId).filter(Boolean);
  }

  // If entrants count <= 1, WB champion exists; no further WB rounds.
  if (entrants.length <= 1) return;

  const nextIndex = state.rounds.wb.length + 2; // label purposes: WB Round 2,3,...
  const roundIndex = state.rounds.wb.length + 1; // internal WB round index 1,2,...

  const round = buildRoundFromEntrants({
    bracket: "WB",
    title: `WB Round ${nextIndex}`,
    roundIndex,
    entrants,
    defaultFrom: "" // we'll fill per-slot provenance below
  });

  // Set provenance: entrants are winners of previous round matches
  // For WB first round (WB Round 2), they come from START matches.
  // For WB later rounds, they come from prior WB matches.
  setWbProvenance(round);

  state.rounds.wb.push(round);

  // BYE auto-adv already decided; reconcile + continue building if possible
  reconcileAfterAnyDecision();
  ensureWbProgress();
}

function setWbProvenance(round) {
  // Determine origin match list
  const prevIsStart = state.rounds.wb.length === 0; // building WB Round 2
  const originMatches = prevIsStart
    ? state.rounds.start.matches
    : getLastWbRound().matches; // last built WB is previous at time of call? careful

  // Actually, when we build a new round, "previous" is:
  // - if this is first WB round, previous = START
  // - else previous = WB round just before this new one
  const prevRound = prevIsStart ? state.rounds.start : state.rounds.wb[state.rounds.wb.length - 1];

  // Map teamId -> source matchId where it was a winner
  const map = new Map();
  for (const m of prevRound.matches) {
    if (m.decided && m.winnerId) map.set(m.winnerId, m.matchId);
  }

  for (const m of round.matches) {
    if (m.slotA.teamId) {
      const src = map.get(m.slotA.teamId);
      m.slotA.fromText = src ? `W of ${matchLabel(src)}` : "W of ?";
    }
    if (m.slotB.teamId) {
      if (m.slotB.teamId === null) continue;
      const src = map.get(m.slotB.teamId);
      m.slotB.fromText = src ? `W of ${matchLabel(src)}` : "W of ?";
    }
    // BYE slot already has "BYE"
    if (m.decidedByBye && m.winnerId) {
      // Winner slot should show ADV (BYE) in rendering; we don’t store it here.
    }
  }
}

/**
 * Ensure LB creates rounds when appropriate.
 *
 * Rule:
 * - LB round is built only when there is no active (incomplete) LB round.
 * - Entrants for next LB round:
 *   - If there is no LB round yet: entrants = lbPool
 *   - Else if last LB round is complete:
 *       entrants = (winners of that LB round) + lbPool
 * - Then clear lbPool (since we've consumed it into the round), except any
 *   teams that were not used? (We will always use all entrants; BYE advances one.)
 */
function ensureLbProgress() {
  // If there is an LB round in progress, do nothing until it’s complete.
  const lastLb = getLastLbRound();
  if (lastLb && !roundIsComplete(lastLb)) return;

  // Build entrant list for next LB round
  let entrants = [];

  if (!lastLb) {
    entrants = [...state.lbPool];
  } else {
    // winners of last LB round (who are not eliminated) plus any new lbPool
    const lbWinners = lastLb.matches
      .map((m) => m.winnerId)
      .filter(Boolean)
      .filter((id) => !isEliminated(id));
    entrants = [...lbWinners, ...state.lbPool];
  }

  // Remove eliminated (should be none, but safe)
  entrants = entrants.filter((id) => !isEliminated(id));

  // If fewer than 2 entrants, we might not be able to build a round yet.
  // But if exactly 1 entrant exists AND WB is finished (WB champ exists) AND
  // there will be no more WB losers coming, then that single team is LB champ.
  if (entrants.length < 2) {
    // consume lbPool anyway (otherwise it keeps duplicating)
    state.lbPool = [];
    return;
  }

  // Consume lbPool now (we're placing them into this round)
  state.lbPool = [];

  const nextIndex = state.rounds.lb.length + 1;
  const round = buildRoundFromEntrants({
    bracket: "LB",
    title: `LB Round ${nextIndex}`,
    roundIndex: nextIndex,
    entrants,
    defaultFrom: "" // provenance set below
  });

  setLbProvenance(round, entrants, lastLb);

  state.rounds.lb.push(round);

  reconcileAfterAnyDecision();

  // It’s possible a BYE auto-advanced and made the round complete immediately only if it was the sole match.
  // We still require user decisions for non-bye matches.
  // If round completed due to all matches being BYE (should not happen), progress again.
  ensureLbProgress();
}

function setLbProvenance(round, entrants, prevLbRound) {
  // For LB, entrants come from two pools:
  // - winners of previous LB round (if any)
  // - losers dropping from WB/START via lbPool at that time
  //
  // We reconstruct best-effort provenance:
  // - If entrant was a winner of prev LB round: "W of <match>"
  // - Else: find its most recent "drop loss" from WB/START: "L of <match>"
  const winnerMap = new Map();
  if (prevLbRound) {
    for (const m of prevLbRound.matches) {
      if (m.decided && m.winnerId) winnerMap.set(m.winnerId, m.matchId);
    }
  }

  const dropMap = new Map();
  for (const m of allMatchesInCreationOrder()) {
    if (!m.decided) continue;
    if (!m.loserId) continue;
    if (m.bracket === "START" || m.bracket === "WB") {
      // last loss is the best explanation
      dropMap.set(m.loserId, m.matchId);
    }
  }

  for (const m of round.matches) {
    if (m.slotA.teamId) {
      const id = m.slotA.teamId;
      const wsrc = winnerMap.get(id);
      if (wsrc) m.slotA.fromText = `W of ${matchLabel(wsrc)}`;
      else {
        const lsrc = dropMap.get(id);
        m.slotA.fromText = lsrc ? `L of ${matchLabel(lsrc)}` : "L of ?";
      }
    }
    if (m.slotB.teamId) {
      const id = m.slotB.teamId;
      const wsrc = winnerMap.get(id);
      if (wsrc) m.slotB.fromText = `W of ${matchLabel(wsrc)}`;
      else {
        const lsrc = dropMap.get(id);
        m.slotB.fromText = lsrc ? `L of ${matchLabel(lsrc)}` : "L of ?";
      }
    }
  }
}

/**
 * Finals are available when:
 * - WB champion exists (only one winner remains in WB)
 * - LB champion exists (only one active team remains in LB)
 *
 * Finals Reset is enabled only if LB champ beats WB champ in Finals.
 */
function ensureFinalsProgress() {
  // Determine WB champ:
  const wbChamp = getWbChampionId();
  const lbChamp = getLbChampionId();

  // Clear finals if champs not available
  if (!wbChamp || !lbChamp) {
    state.rounds.finals = [];
    state.finalsResetEnabled = false;
    state.championId = null;
    return;
  }

  // Build Finals if missing
  if (!state.rounds.finals.length) {
    const finalsRound = {
      title: "Finals",
      bracket: "FIN",
      roundIndex: 1,
      matches: []
    };

    const m = makeMatch({
      matchId: "FIN-R1-M1",
      bracket: "FIN",
      roundIndex: 1,
      slotA: { teamId: wbChamp, fromText: "WB Champ" },
      slotB: { teamId: lbChamp, fromText: "LB Champ" }
    });

    registerMatch(m);
    finalsRound.matches.push(m);

    const resetRound = {
      title: "Finals Reset",
      bracket: "FIN",
      roundIndex: 2,
      matches: []
    };

    const r = makeMatch({
      matchId: "FIN-R2-M1",
      bracket: "FIN",
      roundIndex: 2,
      slotA: { teamId: null, fromText: `W of ${matchLabel(m.matchId)}` },
      slotB: { teamId: null, fromText: `L of ${matchLabel(m.matchId)}` }
    });

    registerMatch(r);
    resetRound.matches.push(r);

    state.rounds.finals = [finalsRound, resetRound];
  }

  // Enable/disable finals reset based on Finals result
  const finalsMatch = state.rounds.finals[0].matches[0];
  const resetMatch = state.rounds.finals[1].matches[0];

  state.finalsResetEnabled = false;

  if (finalsMatch.decided && finalsMatch.winnerId) {
    // If WB champ wins, champion is decided immediately (no reset)
    if (finalsMatch.winnerId === wbChamp) {
      state.finalsResetEnabled = false;
      resetMatch.decided = false;
      resetMatch.winnerId = null;
      resetMatch.loserId = null;
      resetMatch.decidedByBye = false;
      resetMatch.slotA.teamId = null;
      resetMatch.slotB.teamId = null;
      state.championId = wbChamp;
      return;
    }

    // If LB champ wins, enable reset and wire its slots
    if (finalsMatch.winnerId === lbChamp) {
      state.finalsResetEnabled = true;
      resetMatch.slotA.teamId = finalsMatch.winnerId;
      resetMatch.slotB.teamId = finalsMatch.loserId;
      resetMatch.slotA.fromText = `W of ${matchLabel(finalsMatch.matchId)}`;
      resetMatch.slotB.fromText = `L of ${matchLabel(finalsMatch.matchId)}`;
    }
  }

  if (state.finalsResetEnabled && resetMatch.decided && resetMatch.winnerId) {
    state.championId = resetMatch.winnerId;
  } else if (!state.finalsResetEnabled) {
    // champ already set above if WB won
  } else {
    state.championId = null;
  }
}

function getWbChampionId() {
  // WB champ is winner of last WB round if it exists and complete.
  // If WB rounds are not yet built but START completed and only 1 winner exists, that team is WB champ.
  if (state.rounds.wb.length) {
    const last = getLastWbRound();
    if (!last || !roundIsComplete(last)) return null;
    const winners = last.matches.map((m) => m.winnerId).filter(Boolean);
    return winners.length === 1 ? winners[0] : null;
  }

  // No WB rounds built: check START winners
  const start = state.rounds.start;
  if (!start || !roundIsComplete(start)) return null;
  const winners = start.matches.map((m) => m.winnerId).filter(Boolean);
  return winners.length === 1 ? winners[0] : null;
}

function getLbChampionId() {
  // LB champ is the only team remaining with <2 losses and not in an undecided LB match.
  // If there is an active LB round not complete, no champ yet.
  const lastLb = getLastLbRound();
  if (lastLb && !roundIsComplete(lastLb)) return null;

  // Candidates are teams with losses <2 and not eliminated.
  const alive = state.teams.filter((t) => t.losses < 2).map((t) => t.id);

  // If WB champ exists, LB champ is "alive but not WB champ" only if WB champ still alive (it is).
  // But early in tournament there are many alive teams; not LB champ yet.
  // We define LB champ only when:
  // - WB champ exists
  // - Only two alive teams exist total (WB champ + LB champ)
  const wbChamp = getWbChampionId();
  if (!wbChamp) return null;

  const aliveNonWb = alive.filter((id) => id !== wbChamp);
  if (aliveNonWb.length === 1) return aliveNonWb[0];

  return null;
}

/* -----------------------------
   User clicking a slot to decide
------------------------------ */

function onSlotClick(match, clickedTeamId) {
  if (!clickedTeamId) return;
  if (match.decided) return;

  const aId = match.slotA?.teamId ?? null;
  const bId = match.slotB?.teamId ?? null;

  // Must have two real teams to click-decide
  if (!aId || !bId) return;

  const winnerId = clickedTeamId;
  const loserId = winnerId === aId ? bId : aId;

  decideMatch(match, winnerId, loserId);

  // After any decision:
  reconcileAfterAnyDecision();
  // Possibly create new rounds
  ensureWbProgress();
  ensureLbProgress();
  ensureFinalsProgress();

  // Update banner + render
  renderAll();
  autosave();
}

/* -----------------------------
   Rendering
------------------------------ */

function renderAll() {
  renderSetupHint();
  renderTeams();
  renderBracket();
  renderChampion();
  renderDebug();
  requestAnimationFrame(() => centerViewportOnStart());
}

function renderSetupHint() {
  if (!elDrawListHint) return;
  elDrawListHint.textContent = `Min teams: 4 (8 players). Max teams: 20 (40 players). Odd player count allowed → last team gets TBD.`;
}

function renderTeams() {
  if (!elTeamsList) return;
  elTeamsList.innerHTML = "";

  const teams = [...state.teams].sort((a, b) => a.seed - b.seed);

  for (const t of teams) {
    const alive = t.losses < 2;
    const card = document.createElement("div");
    card.className = `teamCard ${alive ? "teamCard--alive" : "teamCard--dead"}`;

    const status = state.championId === t.id ? "CHAMPION" : (!alive ? "ELIMINATED" : "ALIVE");

    card.innerHTML = `
      <div class="teamCard__title">
        <span>${escapeHtml(t.name)}</span>
        <span class="muted small">${escapeHtml(status)}</span>
      </div>
      <div class="teamCard__meta">
        <span>Seed ${t.seed}</span>
        <span>Wins: ${t.wins}</span>
        <span>Losses: ${t.losses}</span>
      </div>
      <div class="teamCard__inputs">
        <input data-team="${escapeHtml(t.id)}" data-member="0" value="${escapeHtml(t.members[0] ?? "")}" placeholder="Member 1" />
        <input data-team="${escapeHtml(t.id)}" data-member="1" value="${escapeHtml(t.members[1] ?? "")}" placeholder="Member 2 (blank = TBD)" />
      </div>
    `;

    elTeamsList.appendChild(card);
  }

  elTeamsList.querySelectorAll("input[data-team]").forEach((inp) => {
    inp.addEventListener("input", (e) => {
      const el = e.currentTarget;
      const teamId = el.getAttribute("data-team");
      const idx = Number(el.getAttribute("data-member"));
      const team = state.teamById.get(teamId);
      if (!team) return;
      team.members[idx] = el.value;
      team.name = computeTeamName(team.members[0], team.members[1]);
      renderTeams();
      autosave();
    });
  });
}

function renderBracket() {
  // START lane
  if (elStartLane) {
    elStartLane.innerHTML = "";
    if (state.rounds.start) {
      elStartLane.appendChild(renderRoundColumn(state.rounds.start));
    }
  }

  // WB
  if (elWbRounds) {
    elWbRounds.innerHTML = "";
    for (const r of state.rounds.wb) {
      elWbRounds.appendChild(renderRoundColumn(r));
    }
  }

  // LB (CSS reverses the order via rounds--lb)
  if (elLbRounds) {
    elLbRounds.innerHTML = "";
    for (const r of state.rounds.lb) {
      elLbRounds.appendChild(renderRoundColumn(r));
    }
  }

  // Finals
  if (elFinalsLane) {
    elFinalsLane.innerHTML = "";
    for (const r of state.rounds.finals) {
      if (r.title === "Finals Reset" && !state.finalsResetEnabled) continue;
      elFinalsLane.appendChild(renderRoundColumn(r));
    }
  }
}

function renderRoundColumn(roundObj) {
  const col = document.createElement("div");
  col.className = "round";

  const list = document.createElement("div");
  list.className = "round__list";

  const title = document.createElement("div");
  title.className = "round__title";
  title.textContent = roundObj.title;

  col.appendChild(title);

  for (const m of roundObj.matches) {
    list.appendChild(renderMatch(m));
  }

  col.appendChild(list);
  return col;
}

function renderMatch(match) {
  const wrap = document.createElement("div");
  wrap.className = "match";

  const head = document.createElement("div");
  head.className = "match__head";
  head.innerHTML = `
    <div class="match__id">Match ${state.matchNumById.get(match.matchId) ?? "?"}</div>
    <div class="match__tag">${escapeHtml(match.matchId)}</div>
  `;
  wrap.appendChild(head);

  wrap.appendChild(renderSlot(match, match.slotA));
  wrap.appendChild(renderSlot(match, match.slotB));

  return wrap;
}

function renderSlot(match, slot) {
  const teamId = slot?.teamId ?? null;
  const isByeSlot = teamId === null && (slot?.fromText === "BYE");
  const isEmpty = teamId === null && !isByeSlot;

  let name = "—";
  let meta = "";
  let from = slot?.fromText ?? "";

  if (isByeSlot) {
    name = "BYE";
    meta = "";
    from = "BYE";
  } else if (isEmpty) {
    name = "—";
    meta = "";
  } else {
    const t = state.teamById.get(teamId);
    name = t ? t.name : teamId;
    meta = t ? `Seed ${t.seed}` : "";
  }

  const decided = match.decided;
  const winner = decided && match.winnerId === teamId && teamId;
  const loser = decided && match.loserId === teamId && teamId;

  const clickable =
    !decided &&
    teamId &&
    match.slotA?.teamId &&
    match.slotB?.teamId; // both real teams present

  const div = document.createElement("div");
  div.className =
    "slot" +
    (clickable ? " slot--clickable" : "") +
    (winner ? " slot--winner" : "") +
    (loser ? " slot--loser" : "");

  // ADV (BYE) label: if match decided by bye and this slot is the winner
  const adv = match.decidedByBye && match.winnerId === teamId ? "ADV (BYE)" : "";

  div.innerHTML = `
    <div class="slot__left">
      <div class="slot__name">${escapeHtml(name)}</div>
      <div class="slot__from">${escapeHtml(adv || from || "")}</div>
    </div>
    <div class="slot__right">
      <div class="slot__meta">${escapeHtml(meta)}</div>
    </div>
  `;

  if (clickable) {
    div.addEventListener("click", () => onSlotClick(match, teamId));
  }

  return div;
}

function renderChampion() {
  if (!elChampionBanner) return;

  if (state.championId) {
    const t = state.teamById.get(state.championId);
    elChampionBanner.style.display = "block";
    elChampionBanner.textContent = `Champion: ${t ? t.name : state.championId}`;
  } else {
    elChampionBanner.style.display = "none";
    elChampionBanner.textContent = "";
  }
}

function renderDebug() {
  if (!elDebug) return;

  const decidedCount = allMatchesInCreationOrder().filter((m) => m.decided).length;
  const totalMatches = state.matchesById.size;

  const wbRounds = state.rounds.wb.length;
  const lbRounds = state.rounds.lb.length;

  const wbChamp = getWbChampionId();
  const lbChamp = getLbChampionId();

  elDebug.textContent = JSON.stringify(
    {
      teams: state.teams.length,
      decidedMatches: decidedCount,
      totalMatches,
      lbPoolSize: state.lbPool.length,
      wbRounds,
      lbRounds,
      wbChampion: wbChamp ? state.teamById.get(wbChamp)?.name : null,
      lbChampion: lbChamp ? state.teamById.get(lbChamp)?.name : null,
      finalsResetEnabled: state.finalsResetEnabled,
      champion: state.championId ? state.teamById.get(state.championId)?.name : null
    },
    null,
    2
  );
}

/* -----------------------------
   Setup: Generate teams
------------------------------ */

function generateTeamsFromDraw(drawList, mode) {
  const players = [...drawList];
  const teamCount = Math.ceil(players.length / 2);

  if (teamCount < 4) throw new Error("Need at least 8 players (4 teams).");
  if (teamCount > 20) throw new Error("Max is 20 teams (40 players).");

  const slots = Array.from({ length: teamCount }, () => ["", ""]);

  if (mode === "team") {
    let p = 0;
    for (let t = 0; t < teamCount; t++) {
      slots[t][0] = players[p++] ?? "";
      slots[t][1] = players[p++] ?? "";
    }
  } else {
    // snake: first pass fills member1, second fills member2
    let p = 0;
    for (let t = 0; t < teamCount; t++) slots[t][0] = players[p++] ?? "";
    for (let t = 0; t < teamCount; t++) slots[t][1] = players[p++] ?? "";
  }

  const teams = [];
  for (let i = 0; i < teamCount; i++) {
    const seed = i + 1;
    const id = makeTeamId(seed);
    const m1 = slots[i][0] ?? "";
    const m2 = slots[i][1] ?? "";
    teams.push({
      id,
      seed,
      members: [m1, m2],
      name: computeTeamName(m1, m2),
      wins: 0,
      losses: 0
    });
  }

  return teams;
}

function readSetupFromUi() {
  state.drawMode = elSelDrawMode?.value === "snake" ? "snake" : "team";
  state.drawList = normalizeLines(elTxtDrawList?.value ?? "");
}

function applySetupToUi() {
  if (elSelDrawMode) elSelDrawMode.value = state.drawMode;
  if (elTxtDrawList) elTxtDrawList.value = state.drawList.join("\n");
}

/* -----------------------------
   Dataset load
------------------------------ */

async function loadDataset() {
  const res = await fetch(DATASET_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load ${DATASET_URL} (${res.status})`);
  const data = await res.json();

  state.drawMode = data.drawMode === "snake" ? "snake" : "team";
  state.drawList = Array.isArray(data.drawList) ? data.drawList.map((s) => String(s ?? "")) : [];

  const teamsRaw = Array.isArray(data.teams) ? data.teams : [];
  const teams = teamsRaw
    .map((t, i) => {
      const seed = Number(t.seed ?? i + 1);
      const id = String(t.id ?? makeTeamId(seed));
      const members = Array.isArray(t.members)
        ? [String(t.members[0] ?? ""), String(t.members[1] ?? "")]
        : ["", ""];
      const name = String(t.name ?? computeTeamName(members[0], members[1]));
      return { id, seed, members, name, wins: 0, losses: 0 };
    })
    .sort((a, b) => a.seed - b.seed);

  state.teams = teams;
  state.teamById = new Map(teams.map((t) => [t.id, t]));

  applySetupToUi();

  // Don’t automatically start tournament unless teams exist and you want it.
  // We’ll render setup + empty bracket.
  initEmptyTournament();
  renderAll();
}

/* -----------------------------
   Save load / export / import
------------------------------ */

function applySaveObject(obj) {
  state.drawMode = obj.drawMode === "snake" ? "snake" : "team";
  state.drawList = Array.isArray(obj.drawList) ? obj.drawList.map((s) => String(s ?? "")) : [];

  const teams = Array.isArray(obj.teams) ? obj.teams : [];
  const normalizedTeams = teams
    .map((t, i) => {
      const seed = Number(t.seed ?? i + 1);
      const id = String(t.id ?? makeTeamId(seed));
      const members = Array.isArray(t.members)
        ? [String(t.members[0] ?? ""), String(t.members[1] ?? "")]
        : ["", ""];
      const name = String(t.name ?? computeTeamName(members[0], members[1]));
      return { id, seed, members, name, wins: 0, losses: 0 };
    })
    .sort((a, b) => a.seed - b.seed);

  applySetupToUi();

  if (!normalizedTeams.length) {
    initEmptyTournament();
    renderAll();
    return;
  }

  // Rebuild tournament deterministically by replaying saved decisions in match creation order.
  initTournamentFromTeams(normalizedTeams);

  const md = obj.matchDecisions || {};
  // We must replay decisions only for matches that exist; BUT because geometry is dynamic,
  // we rebuild rounds progressively and apply decisions as we encounter them.
  //
  // Strategy:
  // - Iterate matches in Match # order as saved, apply if match exists.
  // - After each apply, progress rounds.
  //
  // Caveat: If a saved file was from an older incompatible engine, behavior may differ.

  // We'll apply in ascending numeric order of saved matches (by the key’s stored matchNum if possible).
  // If not possible, just apply by matchId iteration.
  const savedEntries = Object.entries(md).filter(([, v]) => v && v.decided);

  // Build a map of saved matchId -> decision
  const savedMap = new Map(savedEntries);

  // Apply in current match creation order, repeatedly, until no more changes:
  let safety = 0;
  while (safety++ < 5000) {
    let appliedAny = false;

    for (const m of allMatchesInCreationOrder()) {
      const d = savedMap.get(m.matchId);
      if (!d) continue;
      if (m.decided) continue;

      if (d.decidedByBye) {
        if (m.slotA?.teamId) decideMatchByBye(m, m.slotA.teamId);
        else continue;
      } else {
        // Need both teams present
        if (!m.slotA?.teamId || !m.slotB?.teamId) continue;
        if (!d.winnerId || !d.loserId) continue;
        // Only apply if the same teams are in the match (prevent garbage)
        const present = new Set([m.slotA.teamId, m.slotB.teamId]);
        if (!present.has(d.winnerId) || !present.has(d.loserId)) continue;

        decideMatch(m, d.winnerId, d.loserId);
      }

      appliedAny = true;

      reconcileAfterAnyDecision();
      ensureWbProgress();
      ensureLbProgress();
      ensureFinalsProgress();
    }

    if (!appliedAny) break;
  }

  renderAll();
  autosave();
}

function exportSave() {
  const blob = new Blob([JSON.stringify(makeSaveObject(), null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `ferrari_save_${new Date().toISOString().replaceAll(":", "-")}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

/* -----------------------------
   Controls + UX
------------------------------ */

function startTournament() {
  if (!state.teams.length) {
    readSetupFromUi();
    const teams = generateTeamsFromDraw(state.drawList, state.drawMode);
    state.teams = teams;
    state.teamById = new Map(teams.map((t) => [t.id, t]));
  }

  initTournamentFromTeams([...state.teams].sort((a, b) => a.seed - b.seed));
  renderAll();
  autosave();
}

function restartBrackets() {
  if (!state.teams.length) return;
  initTournamentFromTeams([...state.teams].sort((a, b) => a.seed - b.seed));
  renderAll();
  autosave();
}

function hardResetAll() {
  clearAutosave();

  state.drawMode = "team";
  state.drawList = [];
  state.teams = [];
  state.teamById = new Map();

  initEmptyTournament();

  applySetupToUi();
  renderAll();
}

function centerViewportOnStart() {
  if (!elBracketViewport || !elStartLaneContainer) return;

  const viewport = elBracketViewport;
  const start = elStartLaneContainer;

  const targetScrollLeft =
    start.offsetLeft - viewport.clientWidth / 2 + start.offsetWidth / 2;

  const maxScroll = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
  viewport.scrollLeft = clamp(targetScrollLeft, 0, maxScroll);
}

function enableDragPan(el) {
  if (!el) return;
  let isDown = false;
  let startX = 0;
  let scrollLeft = 0;

  el.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    isDown = true;
    startX = e.pageX - el.offsetLeft;
    scrollLeft = el.scrollLeft;
  });

  window.addEventListener("mouseup", () => (isDown = false));
  el.addEventListener("mouseleave", () => (isDown = false));

  el.addEventListener("mousemove", (e) => {
    if (!isDown) return;
    e.preventDefault();
    const x = e.pageX - el.offsetLeft;
    const walk = (x - startX) * 1.1;
    el.scrollLeft = scrollLeft - walk;
  });

  // SHIFT+wheel for horizontal pan (don’t hijack normal vertical scrolling)
  el.addEventListener(
    "wheel",
    (e) => {
      if (!e.shiftKey) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    },
    { passive: false }
  );
}

function wireUi() {
  elBtnGenerateTeams?.addEventListener("click", () => {
    readSetupFromUi();
    try {
      const teams = generateTeamsFromDraw(state.drawList, state.drawMode);
      state.teams = teams;
      state.teamById = new Map(teams.map((t) => [t.id, t]));
      renderAll();
      autosave();
    } catch (e) {
      alert(String(e?.message ?? e));
    }
  });

  elBtnStartTournament?.addEventListener("click", () => {
    readSetupFromUi();
    try {
      startTournament();
    } catch (e) {
      alert(String(e?.message ?? e));
    }
  });

  elSelDrawMode?.addEventListener("change", () => {
    state.drawMode = elSelDrawMode.value === "snake" ? "snake" : "team";
    autosave();
  });

  elTxtDrawList?.addEventListener("input", () => {
    state.drawList = normalizeLines(elTxtDrawList.value);
    autosave();
  });

  elBtnReloadDataset?.addEventListener("click", async () => {
    try {
      await loadDataset();
      autosave();
    } catch (e) {
      alert(String(e?.message ?? e));
    }
  });

  elBtnRestartBrackets?.addEventListener("click", () => {
    if (!confirm("Restart Brackets? This clears results but keeps teams and draw list.")) return;
    restartBrackets();
  });

  elBtnExportSave?.addEventListener("click", () => exportSave());

  elFileLoadSave?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const obj = JSON.parse(text);
      applySaveObject(obj);
    } catch (err) {
      alert("Failed to load save: " + String(err?.message ?? err));
    } finally {
      e.target.value = "";
    }
  });

  elBtnHardResetAll?.addEventListener("click", () => {
    if (!confirm("Hard Reset All? This clears autosave and wipes everything.")) return;
    hardResetAll();
  });

  enableDragPan(elBracketViewport);

  window.addEventListener("resize", () => {
    centerViewportOnStart();
  });
}

/* -----------------------------
   Boot
------------------------------ */

async function boot() {
  wireUi();

  const saved = loadAutosave();
  if (saved) {
    applySaveObject(saved);
    return;
  }

  try {
    await loadDataset();
  } catch (e) {
    console.warn("Dataset load failed, starting empty:", e);
    applySetupToUi();
    initEmptyTournament();
    renderAll();
  }
}

boot();
