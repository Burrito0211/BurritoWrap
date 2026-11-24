# 🌯 BurritoWrap

A cross-device online clipboard at **https://wrap.burrito.rip**.
Pick a room number, paste on one device, copy on another.

<p>
  <img src="screenshots/light-desktop-room.png" alt="BurritoWrap on desktop" width="560">
  <img src="screenshots/dark-phone-room.png" alt="BurritoWrap on a phone in dark mode" width="200">
</p>

## How it works

```
 Phone ──┐                         ┌── Laptop
         │   wss:// (stays open)   │
         └──►  Cloudflare Worker ◄─┘
              wrap.burrito.rip
                    │
              Durable Object "Room"
              (one per room number)
```

- **A room is a number**, 4 to 8 digits, such as `1234`. Every device that opens `wrap.burrito.rip/1234` joins the same room.
- **One Worker** serves the webpage (`public/`) and handles the live connections (`/ws/1234`).
- **One Durable Object per room** keeps each device's WebSocket open and relays new clips to the others instantly.
  It keeps the last 20 clips for 24 hours, and wipes a room after a day of no activity.
- **Rate limiting.** Short numbers are easy to guess, so one visitor can try at most 30 rooms a minute.
  Anyone who knows a room number can still read that room's clips, so use more digits for anything private.

## Using it

1. Open wrap.burrito.rip. Type any room number and select **Enter room**, or select **Give me a random room** to get an unused 4-digit number.
2. On your other devices, open `wrap.burrito.rip/<number>`, type the same number, or scan the QR code.
3. Type or paste text and select **Send**. It appears on every device in the room. Select **Copy** on a clip to put it on that device's clipboard.

The page remembers your room. Select **Leave** to forget it on that device.
The button in the bottom-left corner switches between light and dark mode.

## Deploying (one-time setup)

You need [Node.js](https://nodejs.org) (version 18 or newer) on your computer.

```bash
npm install
```

```bash
npx wrangler login
```

```bash
npm run deploy
```

`wrangler login` opens a browser window so you can sign in to your Cloudflare account.
Because `burrito.rip` is on that account, deploying creates `wrap.burrito.rip` for you,
including its DNS record and HTTPS certificate. There's nothing to set up in the dashboard.
Everything fits in Cloudflare's free plan.

To deploy again after changing code, run `npm run deploy` again.

## Local development

```bash
npm run dev
```

Then open http://localhost:8787. Use two browser windows to act as two devices.
Opening `public/index.html` directly from disk won't work: the page needs the dev server.

## Files

| Path | What it is |
|---|---|
| `wrangler.toml` | Cloudflare config: the domain route, static assets, Durable Object, rate limit |
| `src/worker.js` | The server: routes requests and runs the `Room` relay |
| `public/index.html`, `style.css` | The webpage, styled after [burrito.rip](https://burrito.rip) |
| `public/app.js` | Browser logic: room numbers, WebSocket and reconnecting, theme toggle |
| `public/vendor/qrcode.js` | QR code generator ([qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator), MIT) |
