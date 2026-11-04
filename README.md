# Wavelength

A small cooperative party game for 2–12 players, played in the browser (use voice chat alongside).
Each player gets secret targets on a 180° dial and writes clues; the team then guesses every
clue's target. The closer the team's average guess, the more points.

Node + Express + `ws` on the backend (in-memory, no database), Preact + htm on the frontend
(plain ES modules, **no build step**).

## Run

```
npm install      # also copies Preact+htm to public/vendor via the postinstall script
npm start        # http://localhost:3000
npm run dev      # restarts on server/src changes, auto-reloads the browser on public/ changes
npm test         # server + UI smoke tests
```

Open two or more tabs, create a game in one and join with the 4-digit code (or the `/#1234` link).

## How a game works

1. **Lobby** – host shares the code, everyone enters a name. Host starts (minimum 2 players).
2. **Writing** – each player gets secret tasks: a spectrum (e.g. *Гарячий — Холодний*) and a target on the dial.
   Clues per player: 3 for 2–3 players, 2 for 4–5, 1 for 6+. Tasks are shown one at a time (Далі / Назад,
   submit on the last one). One 6-minute timer for all of a player's clues;
   drafts are autosaved, so whatever is typed when time runs out still counts, empty clues are skipped.
   Ends early when everyone has submitted.
3. **Voting** – clues are shown one by one, round-robin in join order (everyone's 1st clue, then everyone's 2nd, …). Everyone except the author moves a dial (others' dials are
   visible, semi-transparent, with a live team-average arrow) and locks it in. Anyone can tap reaction emojis
   (`votingReactions`: agree, doubt, mock) to comment on the others' needles; they float up on everyone's screen. When all connected guessers have locked, the round reveals.
4. **Reveal** – the target, every guess and the team average (the mean of all dials) are shown.
   Zones: ±4° = 4 points, ±10° = 3, ±18° = 2, otherwise 0. Everyone taps "Далі" when done
   discussing; the next clue starts when all connected players are ready, or after 60 s.
   Players can tap reaction emojis (cheerful for a good score, mocking for a miss); they float up on everyone's screen.
5. **Summary** – a replay: clues one by one (4 s each, small dial) fading in and out, stacking segments in the author's colour in a vertical score
   gauge marked at the verdict thresholds, with one random emoji flying per clue, then the total and a verdict.
   Players can send reactions from a fixed emoji set (`summaryReactions`) throughout. Host can start a new game with the same players.

The server is the single source of truth: it holds the room state, generates tasks, and sends each
player a snapshot. Targets are only sent to the clue's author until the reveal, so there is nothing to
peek at in dev tools. If the host disconnects for 5 min, host passes to the next connected player. During writing, voting and reveal the host has a button at the bottom to skip the wait and move on.

Any player can leave mid-game ("Вийти з гри", with a confirm). Their written clues stay in the game and are still guessed;
their token stops working, so they can't rejoin. The host passes on immediately. If fewer than `minPlayers` remain,
the game jumps to the summary with only the clues played so far.

## Configuration

Game rules live in `src/config.js` (`GAME`: zones, writing/reveal timers, player limits, clue length, reaction emojis per phase and score).
Spectrums are in `src/spectrums.json` as `["left", "right"]` pairs — just add more.

Environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | Listen port |
| `TRUST_PROXY` | 0 | Number of proxy hops in front of the app (set `1` on Render/Koyeb/etc., needed for correct per-IP rate limits) |
| `MAX_ROOMS` | 20 | Max parallel games |
| `IDLE_TTL_MIN` | 30 | Room is destroyed after this many idle minutes |
| `MAX_AGE_MIN` | 240 | Hard lifetime limit of a room |
| `ADMIN_USER` / `ADMIN_PASS` | `admin` / unset | Basic-auth for `/admin/*`. **If `ADMIN_PASS` is unset the admin routes return 404.** |
| `DEV` | unset | `1` enables live reload (`npm run dev` sets it) |
| `LOG_SILENT` | unset | `1` disables console logging (the in-memory log still works) |

Abuse limits: per-IP HTTP rate limits (general, room creation, join), per-IP WebSocket connection cap,
per-connection message rate limit, 4 KB message size cap, helmet with a strict CSP.

## Logs

Events are kept in an in-memory ring buffer (last 5000, clue text is never logged) and echoed to stdout.

```
curl -u admin:$ADMIN_PASS "https://your.host/admin/logs?room=1234&limit=100"
curl -u admin:$ADMIN_PASS "https://your.host/admin/logs?format=json"
curl -u admin:$ADMIN_PASS  https://your.host/admin/rooms
```

## Deploying

`is-a.dev` only gives you a DNS subdomain (a CNAME) — you still need something that runs Node.
Any host that runs a long-lived Node process with WebSocket support works: build command
`npm install`, start command `npm start`, set `TRUST_PROXY=1` and `ADMIN_PASS`. Free tiers usually
sleep when idle, and a restart drops active games (state is in memory). Check each provider's current
free-tier terms before choosing; then point your `is-a.dev` CNAME at the provider's hostname.

## Layout

```
server.js            express + ws wiring, rate limits, admin routes
src/game.js          Room state machine + RoomManager (no express/ws dependency)
src/config.js        game rules and limits
src/logger.js        in-memory ring buffer
src/spectrums.json   spectrum library (Ukrainian)
public/              frontend: app.js, net.js (socket/store), dial.js, views.js, style.css
scripts/vendor.js    copies Preact+htm into public/vendor
test/                server.test.js, ui-smoke.test.js
```
