Read README.md first: it covers the game rules, how to run it, the env vars and the file layout.

- Mobile-first: most players are on phones. Check UI changes at 320px and 375px wide.
- The UI text is Ukrainian. Keep new strings in Ukrainian.
- No build step: `public/` is plain ES modules served as-is. The CSP blocks inline scripts and styles, so put new JS/CSS in files under `public/`.
- `npm run dev` uses polling (`nodemon -L`, `fs.watchFile` in `server.js`) because inotify doesn't fire on `/mnt/c` under WSL. If the repo moves to the Linux filesystem, switch to `node --watch` and `fs.watch`.
- Game state lives only in memory: a server restart wipes all rooms.
- Screenshots: snap chromium can only write under `~/snap/chromium/common/`, e.g. `chromium-browser --headless --no-sandbox --window-size=375,700 --virtual-time-budget=2000 --screenshot=$HOME/snap/chromium/common/x.png http://localhost:3000/`
- Room codes are 4 digits (`src/game.js` `CODE_ALPHABET`).
- After every change, check whether README.md or this file is now out of date (commands, env vars, rules, layout, gotchas) and update it in the same change.
