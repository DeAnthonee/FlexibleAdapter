# King of Tokyo Online

A browser-based, real-time multiplayer implementation of Richard Garfield's
**King of Tokyo** (2010 Iello edition). 2 to 6 players, no accounts, no build
step: one Node.js process serves the page and runs the games.

## Running it

```bash
npm install
npm start          # listens on http://localhost:3000
PORT=8080 npm start
```

Open the URL, enter a name, pick a monster and click **Create game**. Share the
4-letter code (or the invite link, e.g. `https://your.site/ABCD`) with friends.
When everyone is in, the host clicks **Start game**.

### Hosting

The server is a single `node server.js` process. It serves the static files in
`public/` over HTTP and the game over a WebSocket on the **same port**, so any
host that can run a long-lived Node process works (Render, Railway, Fly.io, a
VPS with pm2/systemd, Docker, …). If you put it behind a reverse proxy such as
nginx or Caddy, make sure WebSocket upgrades are forwarded:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

The client connects to `ws://` or `wss://` on whatever host and port served the
page, so no configuration is needed on the client side. A `GET /health`
endpoint returns `{ ok: true, games: <count> }` for uptime checks.

Game state is kept in memory and snapshotted to `DATA_DIR/games.json` after
every action and on shutdown, so a restart (deploy, crash) brings running games
back. Players get a reconnect token stored in their browser, so refreshing the
page, a dropped connection, or a server restart keeps their seat. Games are
discarded after 6 hours of inactivity, or 10 minutes after everyone has left.

Environment variables:

| Variable    | Default   | Meaning |
|-------------|-----------|---------|
| `PORT`      | `3000`    | Listen port; binds all interfaces. |
| `DATA_DIR`  | `./data`  | Folder for the snapshot file; must be writable. `none` disables persistence. |
| `MAX_GAMES` | `500`     | Cap on simultaneous games. |
| `BOT_DELAY_MS` | `900`  | Pause before a computer player acts. |
| `BOT_ROLL_DELAY_MS` | `2400` | Pause after a computer player rolls, so the dice animation can finish. |

Stop the server with SIGTERM (what launchd, systemd and pm2 send) so the final
snapshot is written. Each connection is limited to 16 KB messages and a few
messages per second. Run one process only: state is per process.

`GET /health` returns `{"ok":true,"games":N,"playing":N,"lobby":N,"connections":N,"uptimeSec":N,"version":"…","persistence":true}`.
A deploy script can postpone a restart while `playing` is above 0.

Load test against a running server (not part of `npm test`):

```bash
node scripts/loadtest.js ws://localhost:3000 200 4   # 200 two-player games, 4 turns each
```

## Project layout

```
server.js            HTTP static server + WebSocket game server
game/engine.js       Rules engine (pure logic, no networking)
game/cards.js        The card deck and card effects
game/bot.js          Computer player strategy for practice games
public/index.html    Create/join screen, waiting room, game screen
public/app.js        Browser client
public/style.css     Styling
public/img/          Monster artwork (640px boards + 160px thumbnails, WebP with alpha)
test/engine.test.js  Rules tests (node --test)
test/server.test.js  Server tests: health, restart survival, limits
scripts/loadtest.js  Many concurrent lobbies against a running server
```

```bash
npm test
```

## What is implemented

- Full turn flow: roll, up to two rerolls with kept dice, resolve, buy, end turn.
- Dice scoring: number triples (+1 per extra), energy, hearts (not in Tokyo),
  claws hitting inside/outside Tokyo correctly.
- Tokyo City with entry bonus (+1 ★), start-of-turn bonus (+2 ★), yield
  decisions when attacked, automatic takeover when the occupant is eliminated.
- **Tokyo Bay** for 5–6 players, including the "City first" placement rule and
  the Bay closing when fewer than 5 monsters remain.
- Win by 20 ★ (claimed at the end of the turn, so you have to survive it) or by
  being the last monster standing.
- Card shop: three face-up cards, buy, sweep for 2 ⚡, Keep vs Discard cards,
  reshuffle when the deck runs out.
- All 61 cards from the base set, including the interactive ones:
  - **Wings** asks you whether to spend 2 ⚡ each time you would take damage.
  - **Opportunist** offers you every newly revealed shop card, even on other
    monsters' turns (clockwise order when several monsters have it).
  - **Mimic** copies any Keep card another monster has in play; move the
    counter at the start of your turn or while buying for 1 ⚡. The counter
    comes back if the copied card leaves play.
  - **Parasitic Tentacles** lets you buy Keep cards from other monsters
    during your buy step; they receive the Energy.
  - **Psychic Probe** lets you force a reroll of one die of the monster
    whose turn it is, once per turn; a Heart discards the Probe.
- Reconnection after refresh. Any player can leave a running game (their
  monster is out, the rest keep playing). The host can end the game for
  everyone, and can remove a player who dropped offline.
- Works on desktop and phones. On a phone the whole turn fits one screen:
  a compact Tokyo strip, a swipeable row of monster boards, your dice and
  buttons pinned to the bottom, and the shop and log as slide-up sheets.
  Portrait and landscape both work; the shop opens by itself when it is
  your turn to buy.
- Dice roll animation: dice enter one at a time, slide in, tumble through
  random faces and land on their value. A full roll takes about 2 seconds.
  Timings live in the `DICE_ANIM` block at the top of `public/app.js`.
  Only rerolled dice animate on a reroll; a die changed by a card animates
  alone. Roll buttons are disabled until the dice settle.
- Attack animations on the boards: the attacker's board lunges, the target
  shakes with a claw slash (or fire, poison, card blast), a damage number
  floats up, blocks show a shield, and knockouts stamp "K.O.". The engine
  reports these as events with each update, so every player sees them.
  Honours the reduced-motion setting.

### Practice mode (computer players)

For testing on your own, the host can add computer players in the waiting room
(**Add computer player**), or use **Practice vs computers** on the home screen
to start a lobby with two bots seated. Bots play a simple strategy: keep claws
when someone is in Tokyo, keep hearts when hurt, chase triples, yield when low,
use Wings when low, buy a card they can afford, end the turn. They pause so you
can watch the dice and attack animations (`BOT_DELAY_MS`, default 900, and
`BOT_ROLL_DELAY_MS`, default 2400). Bots run on the server, survive restarts,
and never count as disconnected.

### Game Plus (optional)

In the base game every monster is identical; only the artwork differs. The
host can switch on **Game Plus** in the waiting room to give each monster a
unique power. It is off by default so the classic game is unchanged.

| Monster | Power | Effect |
|---|---|---|
| The King | King of the Hill | Gain 1 extra ★ whenever you start your turn in Tokyo. |
| Gigazaur | Regenerating Scales | At the end of your turn, heal 1 if you are outside Tokyo. |
| Cyber Bunny | Overclocked | One extra reroll every turn. |
| Kraken | Ink Cloud | The first attack that hits you each turn deals 1 less damage. |
| Alienoid | Energy Siphon | Gain 1 ⚡ at the end of each of your turns. |
| Meka Dragon | Rocket Punch | Deal 1 extra damage when you attack from outside Tokyo. |

These are house powers written for this app, not the official Power Up
expansion.

### House rulings

- Hearts heal first; any hearts beyond full Life remove Shrink then Poison
  counters.
- Discard-card damage still goes through Armor Plating / Camouflage / Wings.
- Frenzy bought by an Opportunist on someone else's turn has no effect.

## Licence

MIT. King of Tokyo is a trademark of Iello; this is a fan project for private
play with friends.
