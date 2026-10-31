# CrewCue

Tally, cues and pop-up alerts for vMix camera crews who shoot on phones with Iriun.

- **Director console** (on the vMix PC): every camera shows red when it's live and green when it's on preview. Tap a cue such as "Go wider" or "Tighter", or type a message, to send it to one camera or to everyone. You can see which cues reached each phone and who confirmed them. Crew replies (Ready, Battery low…) beep in.
- **Operator app** (on each phone, iPhone or Android): cues **pop up as notifications on top of Iriun**. Operators get automatic "🔴 YOU'RE LIVE", "🟢 STAND BY" and "⚪ Clear" alerts when you cut in vMix. With the app open (on a spare phone, or in Android split-screen), the whole screen turns red or green, with large cue text, a "Got it" button and quick replies. It can also read cues aloud.

```
 vMix (TCP 8099) ──tally──▶ CrewCue server (Node, on the vMix PC) ──Web Push──▶ phones (pop-ups)
                                     ▲  WebSocket                  ──WebSocket──▶ app open on phone
                          Director console (browser)
```

---

## 1. Install (on the vMix PC)

1. Install **Node.js 20 LTS or newer** from nodejs.org.
2. Unzip this folder, open a terminal in it, and run:
   ```
   npm install
   npm start
   ```
   The first start creates `config.json`. Stop it (Ctrl+C) and edit that file:
   - `cameras`: one entry per camera operator. `input` is the **vMix input number** for that Iriun feed.
   - `directorPin`: the PIN for your console. `crewCode`: what operators type to join.
   - `cues` and `replies`: the buttons. Change them to suit your productions.
   - `contactEmail`: your email (push services require one).
3. Run `npm start` again and open **http://localhost:3000/director**.

vMix's TCP API (port 8099) is on by default in vMix 21+. If the console says "vMix not connected", check that vMix is running and `vmix.host` in `config.json` is correct.

## 2. Give it an HTTPS address (required for iPhone pop-ups)

iPhones only allow pop-ups from an **installed web app on a real HTTPS address**. The easiest free option is a **Cloudflare Tunnel** on one of your domains:

```
cloudflared tunnel login
cloudflared tunnel create crewcue
cloudflared tunnel route dns crewcue cue.yourdomain.com
cloudflared tunnel run --url http://localhost:3000 crewcue
```

Operators then open **https://cue.yourdomain.com**.

- **Keep the same address permanently.** Installed apps and pop-up registrations are tied to it. A quick tunnel (`cloudflared tunnel --url …`) gives a random URL each time, so it's fine for a test but the crew would have to reinstall every show.
- **Back up `data/vapid.json`.** If that file is lost, every phone has to enable pop-ups again.
- The vMix PC needs **internet**, because pop-ups travel through Apple's and Google's push servers. Tally, cues and replies on open apps still work over the local network if the internet drops.

## 3. Set up each operator's phone (once)

**iPhone (iOS 16.4+)**
1. Open the link in **Safari**, tap **Share → Add to Home Screen**.
2. Open **CrewCue from the Home Screen**, then enter the crew code, your name and your camera.
3. Tap **Enable pop-ups → Allow**, then tap **Test pop-up**.

**Android**
1. Open the link in **Chrome**, then enter the crew code, your name and your camera.
2. Tap **Enable pop-ups → Allow**, then tap **Test pop-up**. Optional: menu → Install app.

## Pre-show checklist (operators)

- [ ] Focus / Do Not Disturb is **OFF**, because it hides pop-ups.
- [ ] Ringer is on, or vibration is on.
- [ ] Iriun is running. **Swipe pop-ups away, don't tap them.** On iPhone, tapping opens CrewCue and pauses Iriun.
- [ ] Your camera card on the console shows "1 phone gets pop-ups".

## Rehearse without vMix

```
npm run fake-vmix     # in one terminal: type 2 + Enter to cut to input 2, "p 3" for preview, "auto" to cycle
npm start             # in another
```

## Limits

- Pop-ups usually arrive in **1–3 seconds**. That's fine for cues, but not frame-accurate tally. For instant tally, use a spare phone with the app open.
- iPhones can't confirm a cue from the notification without leaving Iriun. The console shows "pop-ups sent" for every cue, and "✓ name" when someone confirms from the app.
- Voice talkback isn't included yet. A WhatsApp group call on earphones running behind Iriun is a quick fix for now.
