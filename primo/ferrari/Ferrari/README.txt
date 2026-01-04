# Ferrari_Version2 (Project Primo)

## Purpose
Ferrari is a browser-based double-elimination tournament tracker.

Version 2 adds:
- Team Setup UI (live draw entry)
- Team generation modes (Team Fill / Snake Fill)
- Stable Team IDs + editable member names (stats stick to team)
- Save/Load + autosave

## Critical Rule Change (Version 2)
**Every round may have 0 or 1 BYE.**
- Applies to Start (Winners R1), Winners Bracket rounds, and Losers Bracket rounds.
- If a round needs a BYE, it goes to the **lowest seed** among that round’s entrants (highest seed number).
- BYE appears as a match for layout, but **does not count as a win**.

This requires *dynamic round generation* (the bracket cannot be fully pre-built).

## Workflow (Tournament Day)
1. In **Draw List**, type one participant name per line as people are drawn.
2. Choose Draw Mode:
   - **Team Fill**: A1, A2, then B1, B2...
   - **Snake Fill**: A1, B1, C1… then A2, B2, C2…
3. Click **Generate Teams**.
4. Click **Start Tournament**.
5. Click a team within a match to select the winner.
6. Teams are editable any time (names change; stats remain).

## Controls
- **Reload Dataset**: reloads `data/teams_live.json`
- **Restart Brackets**: wipes results but retains teams + draw list
- **Export Save**: downloads a JSON save file
- **Load Save**: loads a previously exported save file
- **Hard Reset All**: clears autosave and wipes everything

## Data Files
- `data/teams_live.json` is the live dataset used for Version 2.
