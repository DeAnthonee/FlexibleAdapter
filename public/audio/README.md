# Audio files

`music.mp3` is the background music: the owner's own track, prepared for
looping. The last 2 seconds are crossfaded into the first 2 seconds so the
loop point is seamless, the level is lowered 2.4 dB to about -16 LUFS so it
sits under the game, and it is encoded at 128 kbps, 44.1 kHz stereo (about
2.2 MB, 2 min 21 s).

To replace it: drop in a new `music.mp3` and bump the version in
`package.json` so every player's browser fetches the new file. If the file is
missing the sound panel reports "No music track installed yet".
