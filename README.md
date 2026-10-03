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

Game state is kept in memory. Players get a reconnect token stored in their
browser, so refreshing the page (or a dropped connection) keeps their seat.
Games are discarded after 6 hours of inactivity, or 10 minutes after everyone
has left.

## Project layout

```
server.js            HTTP static server + WebSocket game server
game/engine.js       Rules engine (pure logic, no networking)
game/cards.js        The card deck and card effects
public/index.html    Create/join screen, waiting room, game screen
public/app.js        Browser client
public/style.css     Styling
test/engine.test.js  Rules tests (node --test)
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
