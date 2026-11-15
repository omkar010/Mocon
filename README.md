# Mocon

An Android app that turns your phone into a Bluetooth motion controller for browser games.
Any game can use it: the phone streams orientation, rotation speed, acceleration, buttons and
an optional joystick, and each game decides which buttons the phone shows.

No server needed. The phone talks straight to Chrome/Edge over Bluetooth LE, so a game is just
static files (GitHub Pages, Cloudflare Pages, Netlify…).

```
app/            Android controller app (Kotlin, Jetpack Compose)
web/mocon.js    Browser SDK — copy into any game
web/demo.html   Test bench: live data, 3D sword, layout switching
web/index.html  Home page linking every game
web/sword/      Sword Duel: first-person sword fight
web/cadence/    Cadence: rhythm slashing to generated music
web/tiltway/    Tiltway: tilt-the-board marble maze
web/cricket/    Boundary: 3D cricket batting
PROTOCOL.md     Wire format, for anyone not using the SDK
```

## Try it

1. Build and install the app: open the project in Android Studio and press Run, or
   `./gradlew installDebug` with the phone plugged in.
2. Open the app, allow the Bluetooth permission. It shows "Waiting for a game…".
3. Serve the web folder on your laptop (Web Bluetooth only works on `https://` or `localhost`):
   `python3 tools/devserver.py` (serves `web/` on port 8080 and stops the browser caching old files),
   then open <http://localhost:8080/> in Chrome or Edge.
4. Press **Connect phone** and pick your phone in the browser's list.
5. Hold the phone like a sword hilt (top toward the screen, display up) and tap **Recenter** on the phone.

## Sword Duel

A first-person sword fight against three opponents, each faster and trickier than the last.

- **Slash:** swing fast. Opponents guard one side (their sword shows which); a slash into the
  guard is blocked, anywhere else lands. Harder swings do more damage.
- **Parry:** when a side of the screen glows red, point your sword at that side before the strike
  lands. A parried opponent is staggered and takes double damage.
- **Fury:** parries fill the meter. When full, press **Fury** on the phone (Space with a mouse) for
  4 seconds of triple damage that breaks any guard.
- The phone shows **Fury** and **Pause** buttons and vibrates on hits, blocks and parries.
- **Difficulty:** *Squire* is the forgiving 3-opponent version. *Knight* (default) and *Legend* add two
  more opponents, faster and harder-hitting attacks, tighter parry angles, less healing, and opponents that
  switch sides if you point at the attack too early, deflect a third quick hit into a counter, and leave
  you off balance after a blocked slash. Tune them in `DIFFICULTIES` in `web/sword/game.js`.

Open <http://localhost:8080/sword/> (served as in "Try it"). It also plays with a mouse: move to aim,
flick fast to slash.

## Cadence

Blocks fly toward you on the beat; swing the way each arrow points to cut them, and never cut the red
mines. Three songs (all synthesized in the browser, so there are no audio files or licenses), three
difficulties, combos, and grades. Bluetooth adds a little delay, so the menu has a **timing offset**,
and the results screen suggests a value if you're consistently early or late.

Open <http://localhost:8080/cadence/>. Mouse: flick in the arrow's direction. Keyboard: arrow keys,
Space for dot blocks.

## Tiltway

Hold the phone flat like a tray (screen up, top pointing at your screen) and tilt to roll a steel
ball to the goal. Six levels with walls, holes, and bridges over open air; a timer, gems, and up to
three stars per level (finish, collect every gem, beat par). The phone buzzes when the ball hits a wall.
Levels are ASCII maps in `LEVELS` at the top of `web/tiltway/game.js`, so adding one is a few lines.

Open <http://localhost:8080/tiltway/>. Mouse: the ball rolls toward the pointer. Keys: arrows or WASD.

## Boundary (cricket)

A 3D cricket batting game. Hold the phone upright like a bat handle (screen facing you); lift it back as
the bowler runs in and swing through as the ball arrives.

Take guard facing the screen with the phone upright like a bat handle and press Start, then play three practice
shots: straight, leg side and off side. Everyone holds and swings a phone a little differently, so real shots are
placed by comparing them with your practice shots (Start skips practice and keeps your last one). Hold the phone either way round:
the straight practice shot shows whether the screen faces the TV or you, and the leg-side and off-side shots
show which way is left and right, so the bat on screen always follows your swing.
The side facing the bowler is the bat face.

- **Footwork:** the batter moves their feet to the delivery like a real player: forward to full balls, back
  and across to short ones (pitching more than about 6 m away). It's timed to the median phase lengths of
  about 8,200 annotated strokes in the UJ-AQA CricketVision dataset (Moodley & van der Haar, WACV 2025):
  ~0.75 s build-up, ~0.14 s downswing, ~0.45 s follow-through. Only these summary timings are used; no data
  from the dataset is included.
- **Field map:** the circle in the top right shows the ground from above (bowler at the top, you at the
  bottom): every fielder, the ball, the current shot, and the shots you have scored from this innings.
- **Direction:** at contact the game reads the bat face pulled halfway toward the swing path, and places the
  shot between your straight, leg-side and off-side practice shots. Early timing pulls it to the leg side, late
  timing to the off side.
- **Loft:** a face opened upward (more than 12°) or a big swing (over 18 rad/s) lofts the ball; finishing with the
  bat above roughly horizontal confirms it, and a low finish keeps it on the ground.
- **Contact** is timed at the bottom of the swing's arc, and the ball leaves the bat immediately.
- **A swing** is the bat turning faster than 8 rad/s, so gentle drives count but moving in your stance doesn't.
- **Right- or left-handed:** pick it in the menu. Left-handed mirrors the batter, the field and the controls.

- **Lofted shots** can go for six, but deep fielders can catch them (Shift lofts with a keyboard).
- **Timing:** windows depend on the level (Club: ±80 ms perfect, ±150 good, ±250 edge; International:
  ±50/100/170). Edges can carry to the keeper; later than that is a miss and the ball may hit the stumps.
  Swinging too early just shows how early you were; you can still swing again for that ball.
- **Feedback:** every swing shows how many ms early or late it was, and a swing meter (bottom left)
  shows bat speed against the line a swing has to cross. Lifting the bat back never counts as a swing.
- **Bluetooth delay** is learned from your swings: if you're consistently judged late, the game shifts
  its timing to match your phone and computer (saved in the browser).
- Pace and spin overs alternate; bowlers mix yorkers, full balls, good lengths and bouncers. Fielders react,
  cut off the ball, and run to catch lofted shots. Runs depend on how far the ball goes before it's stopped.
- Modes: **Chase** (2 overs, 3 wickets), **Super Over** (6 balls, 2 wickets), **Nets** (endless practice).
  Three bowling levels: Club (with a marker where the ball will pitch), County, International.

Open <http://localhost:8080/cricket/>. Mouse: move up to lift the bat, flick down and sideways to swing.
Keys: ← ↓ → to swing, hold Shift to loft. Tuning lives at the top of `web/cricket/game.js`.

## Put it online for free

The `web/` folder is plain static files, so any free static host works. With GitHub Pages:

1. Push this project to a GitHub repository.
2. In the repository: Settings → Pages → Build and deployment → Source: GitHub Actions,
   and add a workflow that uploads the `web/` folder (the "Static HTML" starter workflow,
   with `path: web`).
3. The games are then at `https://<user>.github.io/<repo>/`. Pages serves https, which
   Web Bluetooth requires.

Cloudflare Pages or Netlify work the same way: set the output/publish directory to `web`.

## Using it in a game

```js
import { Mocon } from './mocon.js';
const pad = new Mocon();

connectButton.onclick = async () => {
  await pad.connect(); // must be in a click handler
  await pad.setLayout({ title: 'Sword Duel', buttons: ['Block', 'Special'] });
};

// Every frame, or listen for 'motion' events:
const q = Mocon.toThree(pad.state.quaternion);
sword.quaternion.set(q.x, q.y, q.z, q.w);

pad.addEventListener('buttondown', (e) => { if (e.detail.index === 0) block(); });
pad.addEventListener('motion', (e) => {
  if (Mocon.speed(e.detail.gyro) > 8) slash(); // rad/s
});
pad.vibrate(60); // on hit
```

Events: `connect`, `disconnect`, `motion`, `input`, `buttondown`, `buttonup`, `recenter`.
Methods: `connect()`, `reconnect()`, `disconnect()`, `setLayout()`, `resetLayout()`, `recenter()`,
`vibrate(ms, amplitude)`, `setRate(hz)`, `isPressed(i)`.

## Limits

- Browsers: Chrome or Edge on Windows, macOS, ChromeOS and Android. Not Safari or Firefox.
  On Linux, Web Bluetooth may need `chrome://flags/#enable-experimental-web-platform-features`.
- The phone must support acting as a BLE peripheral (most phones from the last several years do;
  the app tells you if yours doesn't).
- The app streams only while it's on screen. Switching away disconnects the game.
- One game per phone at a time. For two players, use two phones; each game page can create
  two `Mocon` instances.
