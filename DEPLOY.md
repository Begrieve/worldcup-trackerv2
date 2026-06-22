# Put the World Cup Tracker online (always-on, permanent link)

This turns your tracker into a real website with its own web address (like
`https://worldcup-tracker.onrender.com`) that works on any phone, on mobile
data, **without your PC running**.

You do this once. After that, the live scores keep updating on their own.

---

## What's in this folder

- `server.js`, `data.js` — the app (don't edit these)
- `package.json`, `Procfile`, `render.yaml` — tell the host how to run it
- `.gitignore` — keeps private files out of the upload
- `DEPLOY.md` — this guide

> You do **not** upload your `token-*.txt` or `pin.txt` files. On a website,
> secrets are typed into the host's "Environment Variables" box instead (Step 4).

---

## Recommended host: Render (easiest, free to start)

Render gives you a permanent web address and a friendly point-and-click setup.
The free plan **sleeps after 15 minutes of no visitors** and takes ~30–60 seconds
to wake on the next visit. For a tracker you check now and then, that's usually
fine. If you want it to **never** sleep, Render's "Starter" plan (about US$7/month)
keeps it awake 24/7. (A genuinely free *always-on* alternative is **Koyeb** — see
the bottom of this guide.)

### Step 1 — Put the files on GitHub (free account)
1. Create a free account at https://github.com
2. Click the **+** (top-right) → **New repository**.
3. Name it `worldcup-tracker`, choose **Public** (or Private), click
   **Create repository**.
4. On the next page click **uploading an existing file**.
5. Drag **all the files from this folder** into the box, then click
   **Commit changes**.

### Step 2 — Create the web service on Render
1. Sign up at https://render.com (you can click "Sign in with GitHub").
2. Click **New** → **Web Service**.
3. Connect your GitHub and pick the `worldcup-tracker` repository.

### Step 3 — Settings (most are auto-detected)
- **Language / Runtime:** Node
- **Build Command:** leave blank (or `npm install`)
- **Start Command:** `node server.js`
- **Instance Type:** Free (or Starter for always-on)

### Step 4 — Environment Variables (this is where your keys go)
Click **Advanced** → **Add Environment Variable** and add these as needed:

| Key                  | Value                              | What it's for |
|----------------------|------------------------------------|---------------|
| `TSDB_KEY`           | `123`                              | Free goals/lineups (TheSportsDB) |
| `APIFOOTBALLCOM_KEY` | *your apifootball.com key*         | Real-time scores (only if your key is still active) |
| `WC_API_TOKEN`       | *your football-data.org token*     | Optional backup score feed |
| `WC_PIN`             | *a PIN you choose, e.g. `1234`*    | Lets you edit scores from your phone |

Leave out any you don't have — the app automatically uses whatever free feeds
are available.

### Step 5 — Deploy
Click **Create Web Service**. After a minute or two you'll get your permanent
link at the top of the page. Open it on your phone and use the browser menu →
**Add to Home screen** to keep it as an app icon.

---

## Editing scores once it's online

On a public site, **everyone who has the link can view, but not change** the
scores — that's on purpose. To make edits yourself:

1. Make sure you set a `WC_PIN` in Step 4.
2. Open the site, scroll to the bottom, tap **"Enter edit PIN"**, type your PIN.
3. You can now use the Save buttons in *Fixtures & Results* like normal.

Most of the time you won't need to: with a working score feed the results fill
in automatically.

---

## A few honest things to know

- **Live feed is the source of truth.** The site refills scores from the feed on
  its own. If the host restarts (e.g. a free service waking from sleep, or a
  redeploy), any *manually typed* scores can reset — but feed-provided scores
  come right back. For safekeeping of manual edits, use a paid plan with a
  persistent disk, or keep entering them on a feed-less day.
- **Keep your API key valid.** If your apifootball.com trial ends, just remove
  that variable; the app falls back to the free feeds. No redeploy of code
  needed — change the variable and restart.
- **Free vs always-on.** Free Render sleeps when idle (slow first load after a
  quiet spell). Starter (~$7/mo) or Koyeb's free service avoid that.

---

## Free always-on alternative: Koyeb

Same files, same idea, no credit card, and it does **not** sleep:

1. Put the files on GitHub (Step 1 above).
2. Sign up at https://koyeb.com → **Create Web Service** → connect the repo.
3. Run command: `node server.js`. Add the same Environment Variables as Step 4.
4. Deploy — you get a permanent `…koyeb.app` address.

The free Koyeb service has a small CPU, which is plenty for this app.

---

## Updating the app later

When I send you a new `server.js`, just replace that one file in your GitHub
repo (open the file → pencil icon → paste → Commit, or re-upload it). The host
redeploys automatically within a minute. Your environment variables stay as they
are.
