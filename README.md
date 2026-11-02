# WZQ · Five in a Row

A small, dark LAN board game for two players. Run one local server, then join from any browser on the same network. No account, database, build step, or runtime packages needed.

## Quick start

1. Install [Node.js 18 or newer](https://nodejs.org/) on the host computer.
2. Download this repository, then run `npm start` in its folder. On Windows, double-click `Start WZQ.cmd` instead.
3. Open `http://localhost:3000`, enter a name, and create a room.
4. Share the printed LAN address and six-digit code. The other player opens that LAN address on the same Wi-Fi and joins with the code.
5. Black moves first. Place a stone at an empty intersection. The first player to connect five or more stones in a row wins.

Only the host needs Node.js. For Windows Firewall prompts, allow access on private networks. Keep the host computer and server window running during the match.

## Rules

- 15 × 15 board, standard free-style Gomoku. Black goes first; turns alternate.
- Five or more consecutive stones horizontally, vertically, or diagonally wins. Overlines count as wins.
- Undo requests require the other player to accept. New games require both players to agree.
- Refresh to reconnect to a reserved seat for two minutes. A new player cannot take a reserved seat.
- Moves, undo votes, and new-game votes are checked by the server.

No Renju forbidden-move rules, time limit, or ranking. This is a casual game for a trusted LAN. Do not expose the server port to the public internet. Rooms are held in memory and reset when the server stops.

## Network troubleshooting

- Both devices must use the same local network. Use the `LAN` address printed by the server, not `localhost` on the joining device.
- Allow TCP port 3000 through the host firewall on private networks.
- Guest Wi-Fi and router AP isolation can prevent devices from reaching each other.
- Change the port: PowerShell `$env:PORT=3001; node server.mjs`.

## Structure

```text
server.mjs        HTTP, rooms, moves, undo and rematch votes
public/index.html Page structure
public/style.css  Responsive dark theme
public/app.js     Board rendering and interaction
Start WZQ.cmd     Windows launcher
```
