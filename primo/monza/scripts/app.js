// MONZA VERSION: 2026-01-01 v4 (Full bracket + rename + reveal)
console.log("MONZA VERSION: 2026-01-01 v4");

/*
  ============================================================
  Monza – Full Single-Elimination Bracket (16 teams)
  Rounds 1–4 + Champion
  + Inline Rename (Round 1 source teams)
  + Champion Reveal Overlay (big-screen mode)
  ============================================================

  Design principles (for Phase 1):
  - Keep state simple (arrays of match objects)
  - Re-render on each click (reliable, easy to reason about)
  - Enforce integrity (downstream winners auto-clear if upstream changes)
  - Add fun UX (rename + reveal) without adding backend complexity
*/

const app = document.getElementById("app");

/* ------------------------------------------------------------
   1) UI STATE (non-tournament state)
   ------------------------------------------------------------
   revealOpen controls whether the fullscreen champion overlay is shown.
*/
let revealOpen = false;

/* ------------------------------------------------------------
   2) TEAMS (source of truth for names)
   ------------------------------------------------------------
   IMPORTANT:
   - All rounds reference teams by id.
   - If a team name changes here, it updates everywhere.
*/
const teams = Array.from({ length: 16 }, (_, i) => ({
  id: i + 1,
  name: `Team ${i + 1}`,
}));

/* ------------------------------------------------------------
   3) ROUND 1 (8 matches): sequential pairing
   ------------------------------------------------------------ */
const round1 = Array.from({ length: teams.length / 2 }, (_, i) => {
  const teamA = teams[i * 2];
  const teamB = teams[i * 2 + 1];

  return {
    id: i + 1,
    teamAId: teamA.id,
    teamBId: teamB.id,
    winnerTeamId: null,
  };
});

/* ------------------------------------------------------------
   4) ROUND 2 (4 matches): fed by Round 1 match winners
   ------------------------------------------------------------ */
const round2 = Array.from({ length: round1.length / 2 }, (_, i) => {
  const feederA = round1[i * 2].id;
  const feederB = round1[i * 2 + 1].id;

  return {
    id: i + 1,
    feederMatchIds: [feederA, feederB],
    winnerTeamId: null,
    lastPairKey: null,
  };
});

/* ------------------------------------------------------------
   5) ROUND 3 (2 matches): fed by Round 2 match winners
   ------------------------------------------------------------ */
const round3 = Array.from({ length: round2.length / 2 }, (_, i) => {
  const feederA = round2[i * 2].id;
  const feederB = round2[i * 2 + 1].id;

  return {
    id: i + 1,
    feederMatchIds: [feederA, feederB],
    winnerTeamId: null,
    lastPairKey: null,
  };
});

/* ------------------------------------------------------------
   6) ROUND 4 (Final) (1 match): fed by Round 3 match winners
   ------------------------------------------------------------ */
const round4 = Array.from({ length: round3.length / 2 }, (_, i) => {
  const feederA = round3[i * 2].id;     // 1
  const feederB = round3[i * 2 + 1].id; // 2

  return {
    id: i + 1, // only one final match => id 1
    feederMatchIds: [feederA, feederB],
    winnerTeamId: null,
    lastPairKey: null,
  };
});

/* ------------------------------------------------------------
   7) BASIC HELPERS
   ------------------------------------------------------------ */

/* Get a team object by id */
function getTeamById(teamId) {
  return teams.find(t => t.id === teamId) ?? null;
}

/* Rename a team at the source of truth */
function renameTeam(teamId, newNameRaw) {
  // Normalize input
  const newName = (newNameRaw ?? "").trim();

  // Reject empty
  if (!newName) return;

  const team = getTeamById(teamId);
  if (!team) return;

  team.name = newName;
}

/* ------------------------------------------------------------
   8) WINNER LOOKUP HELPERS (by round)
   ------------------------------------------------------------ */

/* Round 1 winner => team object */
function getRound1WinnerTeam(matchId) {
  const m = round1.find(x => x.id === matchId);
  if (!m || m.winnerTeamId == null) return null;
  return getTeamById(m.winnerTeamId);
}

/* Round 2 winner => team object */
function getRound2WinnerTeam(matchId) {
  const m = round2.find(x => x.id === matchId);
  if (!m || m.winnerTeamId == null) return null;
  return getTeamById(m.winnerTeamId);
}

/* Round 3 winner => team object */
function getRound3WinnerTeam(matchId) {
  const m = round3.find(x => x.id === matchId);
  if (!m || m.winnerTeamId == null) return null;
  return getTeamById(m.winnerTeamId);
}

/* ------------------------------------------------------------
   9) PARTICIPANT COMPUTATION FOR FED ROUNDS
   ------------------------------------------------------------
   Returns:
     - teamA/teamB (or null)
     - pending boolean
     - pairKey string (for integrity clearing)
*/

function getParticipantsForRound2(r2Match) {
  const [f1, f2] = r2Match.feederMatchIds;

  const teamA = getRound1WinnerTeam(f1);
  const teamB = getRound1WinnerTeam(f2);

  const pending = !(teamA && teamB);
  const pairKey = pending ? "pending" : `${teamA.id}-${teamB.id}`;

  return { teamA, teamB, pending, pairKey };
}

function getParticipantsForRound3(r3Match) {
  const [f1, f2] = r3Match.feederMatchIds;

  const teamA = getRound2WinnerTeam(f1);
  const teamB = getRound2WinnerTeam(f2);

  const pending = !(teamA && teamB);
  const pairKey = pending ? "pending" : `${teamA.id}-${teamB.id}`;

  return { teamA, teamB, pending, pairKey };
}

function getParticipantsForRound4(r4Match) {
  const [f1, f2] = r4Match.feederMatchIds;

  const teamA = getRound3WinnerTeam(f1);
  const teamB = getRound3WinnerTeam(f2);

  const pending = !(teamA && teamB);
  const pairKey = pending ? "pending" : `${teamA.id}-${teamB.id}`;

  return { teamA, teamB, pending, pairKey };
}

/* ------------------------------------------------------------
   10) INTEGRITY ENFORCEMENT FOR FED ROUNDS
   ------------------------------------------------------------
   Prevent the bracket from "lying":
   - If participants change, clear winner
   - If pending, winner must be null
   - If winner is not one of participants, clear it
*/
function enforceIntegrityForFedRound(matches, participantFn) {
  for (const m of matches) {
    const { teamA, teamB, pending, pairKey } = participantFn(m);

    // If pairing changed since last time, clear winner
    if (m.lastPairKey !== pairKey) {
      m.winnerTeamId = null;
      m.lastPairKey = pairKey;
    }

    // If pending, must have no winner
    if (pending) {
      m.winnerTeamId = null;
      continue;
    }

    // If winner exists, validate
    if (m.winnerTeamId != null) {
      const valid = new Set([teamA.id, teamB.id]);
      if (!valid.has(m.winnerTeamId)) {
        m.winnerTeamId = null;
      }
    }
  }
}

/* ------------------------------------------------------------
   11) CHAMPION COMPUTATION
   ------------------------------------------------------------ */
function getChampionTeam() {
  const finalMatch = round4[0];
  if (!finalMatch || finalMatch.winnerTeamId == null) return null;
  return getTeamById(finalMatch.winnerTeamId);
}

/* ------------------------------------------------------------
   12) RENDER
   ------------------------------------------------------------ */
function render() {
  // Keep downstream rounds honest before rendering
  enforceIntegrityForFedRound(round2, getParticipantsForRound2);
  enforceIntegrityForFedRound(round3, getParticipantsForRound3);
  enforceIntegrityForFedRound(round4, getParticipantsForRound4);

  // Champion team (if crowned)
  const champion = getChampionTeam();

  // If champion goes away (due to upstream change), close reveal overlay
  if (!champion && revealOpen) {
    revealOpen = false;
  }

  // Render the entire app
  app.innerHTML = `
    ${renderChampionBanner(champion)}
    ${renderRevealOverlay(champion)}
    ${renderBracket()}
  `;
}

/* Render the champion banner (top area) */
function renderChampionBanner(champion) {
  // Only enable Reveal button if champion exists
  const canReveal = Boolean(champion);

  return `
    <div class="champion-banner">
      <div>
        <h2 class="champion-title">Champion</h2>
        ${
          champion
            ? `<div class="champion-name">${champion.name}</div>`
            : `<div class="champion-muted">(not crowned yet)</div>`
        }
      </div>
      <div class="champion-muted">MONZA VERSION: 2026-01-01 v4</div>

      <div style="display:flex; gap:0.5rem; align-items:center;">
        <button
          class="action-btn"
          type="button"
          data-action="reveal-open"
          ${canReveal ? "" : "disabled"}
          title="${canReveal ? "Big-screen champion reveal" : "Crown a champion first"}"
        >
          Reveal Champion
        </button>

        <button
          class="action-btn"
          type="button"
          data-action="reset-all"
          title="Clear all winners (keeps team names)"
        >
          Reset Winners
        </button>
      </div>
    </div>
  `;
}

/* Render the fullscreen champion reveal overlay */
function renderRevealOverlay(champion) {
  // If no champion, keep overlay hidden
  const openClass = revealOpen ? "open" : "";

  // Choose display text
  const nameText = champion ? champion.name : "—";

  return `
    <div class="reveal-overlay ${openClass}" data-action="reveal-overlay">
      <div class="reveal-card" role="dialog" aria-modal="true" aria-label="Champion Reveal">
        <div class="reveal-sub">And your champion is…</div>
        <div class="reveal-name">${nameText}</div>
        <div class="reveal-sub">(Press ESC or click Close)</div>

        <button class="reveal-close" type="button" data-action="reveal-close">
          Close
        </button>
      </div>
    </div>
  `;
}

/* Render the 4-column bracket */
function renderBracket() {
  return `
    <div class="bracket">

      <section class="round" aria-label="Round 1">
        <h2 class="round-title">Round 1</h2>
        <p class="helper">Pick winners. Rename teams using ✎.</p>
        ${round1.map(renderRound1Match).join("")}
      </section>

      <section class="round" aria-label="Round 2">
        <h2 class="round-title">Round 2</h2>
        <p class="helper">Unlocks when both feeder matches in Round 1 have winners.</p>
        ${round2.map(renderRound2Match).join("")}
      </section>

      <section class="round" aria-label="Round 3">
        <h2 class="round-title">Round 3</h2>
        <p class="helper">Unlocks when both feeder matches in Round 2 have winners.</p>
        ${round3.map(renderRound3Match).join("")}
      </section>

      <section class="round" aria-label="Final">
        <h2 class="round-title">Final</h2>
        <p class="helper">Unlocks when both feeder matches in Round 3 have winners.</p>
        ${round4.map(renderRound4Match).join("")}
      </section>

    </div>
  `;
}

/* ------------------------------------------------------------
   13) RENDER: ROUND 1 MATCH (with rename buttons)
   ------------------------------------------------------------ */
function renderRound1Match(match) {
  const teamA = getTeamById(match.teamAId);
  const teamB = getTeamById(match.teamBId);

  // Winner state
  const teamAWon = match.winnerTeamId === match.teamAId;
  const teamBWon = match.winnerTeamId === match.teamBId;

  // Winner name (for the right slot)
  const winnerName = teamAWon
    ? teamA.name
    : teamBWon
      ? teamB.name
      : null;

  return `
    <section class="match" data-round="1" data-match-id="${match.id}">
      <div class="match-left">

        <!-- Team A row: select + rename -->
        <div class="team-row">
          ${renderTeamButton({
            round: 1,
            matchId: match.id,
            teamId: teamA.id,
            label: teamA.name,
            selected: teamAWon,
            disabled: false,
          })}

          ${renderRenameButton({
            teamId: teamA.id
          })}
        </div>

        <!-- Team B row: select + rename -->
        <div class="team-row">
          ${renderTeamButton({
            round: 1,
            matchId: match.id,
            teamId: teamB.id,
            label: teamB.name,
            selected: teamBWon,
            disabled: false,
          })}

          ${renderRenameButton({
            teamId: teamB.id
          })}
        </div>

      </div>

      <div class="match-right">
        <div class="winner-label">Winner →</div>
        <div class="winner-slot">
          ${
            winnerName
              ? `<strong>${winnerName}</strong>`
              : `<span style="color:#777;">(not selected)</span>`
          }
        </div>
      </div>
    </section>
  `;
}

/* ------------------------------------------------------------
   14) RENDER: ROUND 2 MATCH
   ------------------------------------------------------------ */
function renderRound2Match(r2Match) {
  const { teamA, teamB, pending, pairKey } = getParticipantsForRound2(r2Match);

  const teamAWon = !pending && r2Match.winnerTeamId === teamA.id;
  const teamBWon = !pending && r2Match.winnerTeamId === teamB.id;

  const winnerName = !pending
    ? (teamAWon ? teamA.name : teamBWon ? teamB.name : null)
    : null;

  const [f1, f2] = r2Match.feederMatchIds;

  return `
    <section class="match ${pending ? "pending" : ""}" data-round="2" data-match-id="${r2Match.id}" data-pair-key="${pairKey}">
      <div class="match-left">
        ${renderTeamButton({
          round: 2,
          matchId: r2Match.id,
          teamId: teamA?.id ?? -101,
          label: teamA?.name ?? `Winner of R1 Match ${f1}`,
          selected: teamAWon,
          disabled: pending,
        })}
        ${renderTeamButton({
          round: 2,
          matchId: r2Match.id,
          teamId: teamB?.id ?? -102,
          label: teamB?.name ?? `Winner of R1 Match ${f2}`,
          selected: teamBWon,
          disabled: pending,
        })}
      </div>

      <div class="match-right">
        <div class="winner-label">Winner →</div>
        <div class="winner-slot">
          ${
            pending
              ? `<span style="color:#777;">(waiting)</span>`
              : winnerName
                ? `<strong>${winnerName}</strong>`
                : `<span style="color:#777;">(not selected)</span>`
          }
        </div>

        ${
          pending
            ? `<div class="pending-note">Waiting for winners from R1 Matches ${f1} and ${f2}.</div>`
            : ``
        }
      </div>
    </section>
  `;
}

/* ------------------------------------------------------------
   15) RENDER: ROUND 3 MATCH
   ------------------------------------------------------------ */
function renderRound3Match(r3Match) {
  const { teamA, teamB, pending, pairKey } = getParticipantsForRound3(r3Match);

  const teamAWon = !pending && r3Match.winnerTeamId === teamA.id;
  const teamBWon = !pending && r3Match.winnerTeamId === teamB.id;

  const winnerName = !pending
    ? (teamAWon ? teamA.name : teamBWon ? teamB.name : null)
    : null;

  const [f1, f2] = r3Match.feederMatchIds;

  return `
    <section class="match ${pending ? "pending" : ""}" data-round="3" data-match-id="${r3Match.id}" data-pair-key="${pairKey}">
      <div class="match-left">
        ${renderTeamButton({
          round: 3,
          matchId: r3Match.id,
          teamId: teamA?.id ?? -201,
          label: teamA?.name ?? `Winner of R2 Match ${f1}`,
          selected: teamAWon,
          disabled: pending,
        })}
        ${renderTeamButton({
          round: 3,
          matchId: r3Match.id,
          teamId: teamB?.id ?? -202,
          label: teamB?.name ?? `Winner of R2 Match ${f2}`,
          selected: teamBWon,
          disabled: pending,
        })}
      </div>

      <div class="match-right">
        <div class="winner-label">Winner →</div>
        <div class="winner-slot">
          ${
            pending
              ? `<span style="color:#777;">(waiting)</span>`
              : winnerName
                ? `<strong>${winnerName}</strong>`
                : `<span style="color:#777;">(not selected)</span>`
          }
        </div>

        ${
          pending
            ? `<div class="pending-note">Waiting for winners from R2 Matches ${f1} and ${f2}.</div>`
            : ``
        }
      </div>
    </section>
  `;
}

/* ------------------------------------------------------------
   16) RENDER: ROUND 4 MATCH (Final)
   ------------------------------------------------------------ */
function renderRound4Match(r4Match) {
  const { teamA, teamB, pending, pairKey } = getParticipantsForRound4(r4Match);

  const teamAWon = !pending && r4Match.winnerTeamId === teamA.id;
  const teamBWon = !pending && r4Match.winnerTeamId === teamB.id;

  const winnerName = !pending
    ? (teamAWon ? teamA.name : teamBWon ? teamB.name : null)
    : null;

  const [f1, f2] = r4Match.feederMatchIds;

  return `
    <section class="match ${pending ? "pending" : ""}" data-round="4" data-match-id="${r4Match.id}" data-pair-key="${pairKey}">
      <div class="match-left">
        ${renderTeamButton({
          round: 4,
          matchId: r4Match.id,
          teamId: teamA?.id ?? -301,
          label: teamA?.name ?? `Winner of R3 Match ${f1}`,
          selected: teamAWon,
          disabled: pending,
        })}
        ${renderTeamButton({
          round: 4,
          matchId: r4Match.id,
          teamId: teamB?.id ?? -302,
          label: teamB?.name ?? `Winner of R3 Match ${f2}`,
          selected: teamBWon,
          disabled: pending,
        })}
      </div>

      <div class="match-right">
        <div class="winner-label">Champion →</div>
        <div class="winner-slot">
          ${
            pending
              ? `<span style="color:#777;">(waiting)</span>`
              : winnerName
                ? `<strong>${winnerName}</strong>`
                : `<span style="color:#777;">(not selected)</span>`
          }
        </div>

        ${
          pending
            ? `<div class="pending-note">Waiting for winners from R3 Matches ${f1} and ${f2}.</div>`
            : ``
        }
      </div>
    </section>
  `;
}

/* ------------------------------------------------------------
   17) RENDER: SHARED TEAM BUTTON
   ------------------------------------------------------------
   Note:
   - For pending matches, disabled=true so the button is inert.
   - teamId may be placeholder negative ids in pending states, so we
     validate click selections later.
*/
function renderTeamButton({ round, matchId, teamId, label, selected, disabled }) {
  return `
    <button
      type="button"
      class="team-btn ${selected ? "selected" : ""}"
      data-round="${round}"
      data-match-id="${matchId}"
      data-team-id="${teamId}"
      ${disabled ? "disabled" : ""}
    >
      ${label}
    </button>
  `;
}

/* Render: rename button (Round 1 only) */
function renderRenameButton({ teamId }) {
  return `
    <button
      type="button"
      class="rename-btn"
      data-action="rename"
      data-team-id="${teamId}"
      title="Rename team"
    >
      ✎
    </button>
  `;
}

/* ------------------------------------------------------------
   18) RESET WINNERS (keeps team names)
   ------------------------------------------------------------ */
function resetWinnersOnly() {
  // Round 1: clear winners
  for (const m of round1) m.winnerTeamId = null;

  // Round 2/3/4: clear winners + pairing memory
  for (const m of round2) { m.winnerTeamId = null; m.lastPairKey = null; }
  for (const m of round3) { m.winnerTeamId = null; m.lastPairKey = null; }
  for (const m of round4) { m.winnerTeamId = null; m.lastPairKey = null; }

  // Close reveal if it was open
  revealOpen = false;
}

/* ------------------------------------------------------------
   19) CLICK HANDLER (event delegation)
   ------------------------------------------------------------
   Handles:
   - Team winner selection
   - Rename button
   - Champion reveal open/close
   - Reset winners
*/
app.addEventListener("click", (event) => {
  const actionEl = event.target.closest("[data-action]");
  const teamBtn = event.target.closest(".team-btn");

  /* ---------- ACTION BUTTONS (banner + overlay + rename) ---------- */
  if (actionEl) {
    const action = actionEl.dataset.action;

    // Open champion reveal
    if (action === "reveal-open") {
      const champion = getChampionTeam();
      if (champion) {
        revealOpen = true;
        render();
      }
      return;
    }

    // Close champion reveal (button)
    if (action === "reveal-close") {
      revealOpen = false;
      render();
      return;
    }

    // Clicking the dark overlay area closes it (but not clicks inside the card)
    if (action === "reveal-overlay") {
      // Only close if they clicked the overlay itself, not the inner card
      if (event.target === actionEl) {
        revealOpen = false;
        render();
      }
      return;
    }

    // Reset winners only (keep team names)
    if (action === "reset-all") {
      resetWinnersOnly();
      render();
      return;
    }

    // Rename team (Round 1 source)
    if (action === "rename") {
      const teamId = Number(actionEl.dataset.teamId);
      const team = getTeamById(teamId);
      if (!team) return;

      // Use prompt for name entry (simple + reliable for Phase 1)
      const newName = window.prompt("Rename team:", team.name);

      // If user cancels prompt, newName is null -> do nothing
      if (newName == null) return;

      renameTeam(teamId, newName);
      render();
      return;
    }
  }

  /* ---------- TEAM BUTTONS (winner selection) ---------- */
  if (teamBtn) {
    // Disabled buttons should do nothing
    if (teamBtn.disabled) return;

    const round = Number(teamBtn.dataset.round);
    const matchId = Number(teamBtn.dataset.matchId);
    const teamId = Number(teamBtn.dataset.teamId);

    // Defensive: ignore placeholder ids (negative) even if something goes sideways
    if (teamId <= 0) return;

    // ----- Round 1: direct selection -----
    if (round === 1) {
      const match = round1.find(m => m.id === matchId);
      if (!match) return;

      // Toggle winner: click winner again clears it
      match.winnerTeamId = (match.winnerTeamId === teamId) ? null : teamId;

      render();
      return;
    }

    // ----- Round 2: must be unlocked + teamId must be one of participants -----
    if (round === 2) {
      const match = round2.find(m => m.id === matchId);
      if (!match) return;

      const { pending, teamA, teamB } = getParticipantsForRound2(match);
      if (pending) return;

      const valid = new Set([teamA.id, teamB.id]);
      if (!valid.has(teamId)) return;

      match.winnerTeamId = (match.winnerTeamId === teamId) ? null : teamId;

      render();
      return;
    }

    // ----- Round 3 -----
    if (round === 3) {
      const match = round3.find(m => m.id === matchId);
      if (!match) return;

      const { pending, teamA, teamB } = getParticipantsForRound3(match);
      if (pending) return;

      const valid = new Set([teamA.id, teamB.id]);
      if (!valid.has(teamId)) return;

      match.winnerTeamId = (match.winnerTeamId === teamId) ? null : teamId;

      render();
      return;
    }

    // ----- Round 4 (Final) -----
    if (round === 4) {
      const match = round4.find(m => m.id === matchId);
      if (!match) return;

      const { pending, teamA, teamB } = getParticipantsForRound4(match);
      if (pending) return;

      const valid = new Set([teamA.id, teamB.id]);
      if (!valid.has(teamId)) return;

      match.winnerTeamId = (match.winnerTeamId === teamId) ? null : teamId;

      render();
      return;
    }
  }
});

/* ------------------------------------------------------------
   20) KEYBOARD HANDLING (ESC closes reveal)
   ------------------------------------------------------------
   This is global (document-level).
*/
document.addEventListener("keydown", (event) => {
  // If overlay is open and user hits Escape, close it
  if (revealOpen && event.key === "Escape") {
    revealOpen = false;
    render();
  }
});

/* ------------------------------------------------------------
   21) INITIAL RENDER
   ------------------------------------------------------------ */
render();
