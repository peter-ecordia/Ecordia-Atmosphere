# Ecordia Atmosphere

Atmosphere is the offline app for Ecordiatlas's Staff rubrics add-on (spec: *Ecordia Atmosphere – Spec*, 21 Nov 2026).
Staff use it to observe colleagues against the rubrics defined in Ecordiatlas, with no internet during the observation.
It is a web app that installs on a phone, tablet or computer (mobile first).

This repository is the app and a small web host for it. Everything else is Ecordiatlas's
([peter-ecordia/Ecordiatlas](https://github.com/peter-ecordia/Ecordiatlas)): sign-in, rubrics, observations, the
encryption keys and the API (`/api/v1/atmosphere/*`). Ecordiatlas's README, *Staff rubrics (add-on) → Atmosphere*,
describes the server side.

## How it works

1. **Prepare** (online): sign in with the Ecordiatlas account and choose who you'll observe (planned observations for the
   next 7 days are listed, today's ticked), with a rubric for each that fits their role.
2. **Cache**: each person's name, role and rubric go onto the device. Ecordiatlas locks that rubric version, so the
   observation is always kept against the version it was done on.
3. **Observe** (offline): levels, comments, photos (shrunk, location removed), overall comments and actions, saved on
   the device as you go (IndexedDB).
4. **Submit**: checked first (a level for every criterion, the comments and evidence the rubric asks for), then sent at
   once or, with no signal, by background sync when the signal is back (iPhone and iPad have no background sync, so
   there it goes when Atmosphere is next opened). It arrives in Ecordiatlas shared with the staff member.
5. **Clear**: once Ecordiatlas answers, the device deletes its copy.

Before submission an observation can only be changed here, on the device. After it, Ecordiatlas owns it: only the staff
member's manager can change it there, unless the manager lets the observer. Downloads and drafts stay on a device for up
to 14 days; a draft still there is sent to Ecordiatlas unfinished and the manager is emailed.

**On the device** everything is encrypted (AES-256-GCM) with a key only the observer's passcode opens (at least 6
characters; it locks after 5 minutes away). What is waiting to be sent is sealed to Ecordiatlas's public key, so the
phone can't read it back and the browser can send it in the background. *Forgotten your passcode?* unlocks after
signing in to Ecordiatlas again.

## Sign-in

Atmosphere has no sign-in of its own: it calls Ecordiatlas's API with the person's Ecordiatlas sign-in. For that:

- **Atmosphere and Ecordiatlas must share a parent domain**, e.g. `atmosphere.ecordia.co.uk` and `ilr.ecordia.co.uk`, so
  the sign-in cookie goes with Atmosphere's calls. (On different domains it would also need Ecordiatlas's
  `EcordiaApp:CrossSiteCookies` and browsers that allow third-party cookies, so don't.)
- Ecordiatlas's `Atmosphere:Url` names this site: it lets only this site call the API (CORS) and sends people here
  after signing in (`/sso/atmosphere`).
- From the Ecordia app, the Menu's *Atmosphere* opens it already signed in, with a one-time launch token
  (`/sso/ecordia-app`, `returnUrl=/atmosphere/`).
- From Ecordiatlas, Staff → Rubrics → *Observe offline (Atmosphere)*.

## Files

| | |
|---|---|
| `src/Atmosphere.Web/Program.cs` | The host: serves the files with security headers (CSP allows only this site and Ecordiatlas), and `/config.json` with Ecordiatlas's address |
| `wwwroot/index.html`, `atmosphere.js` | The screens: set-up and unlock, today's observations, choosing who to observe, observing |
| `wwwroot/store.js` | Storage on the device and encryption; sends what is waiting (used by the page and the service worker) |
| `wwwroot/sw.js` | Service worker: keeps the app's files for offline use, background sync |
| `wwwroot/base.css` | A copy of Ecordiatlas's look (colours, controls, rubric levels); `atmosphere.css` is Atmosphere's own layout |
| `wwwroot/manifest.json`, icons | Installing it |

## Settings

| Setting | |
|---|---|
| `Atlas:Url` | Ecordiatlas's address, e.g. `https://ilr.ecordia.co.uk` (required) |

And in Ecordiatlas: `Atmosphere:Url` = this site's address, e.g. `https://atmosphere.ecordia.co.uk`.

## Running it on this computer

1. Run Ecordiatlas with `Atmosphere__Url=http://localhost:5285` (its `appsettings.Development.json` already says so).
   The Claude preview entry `ilr-portal-atmosphere` runs it on http://localhost:5281.
2. `dotnet run --project src/Atmosphere.Web --launch-profile http` → http://localhost:5285 (`Atlas:Url` is
   http://localhost:5281 in `appsettings.Development.json`). Preview entry: `atmosphere`.
3. Sign in through Ecordiatlas's test page, http://localhost:5281/dev/ecordia-app, with return URL `/atmosphere/`
   (e.g. `team.manager@example.test`, organisation 10000001, which has the Staff rubrics add-on).

Both on `localhost` count as the same site, so the sign-in carries across as it will under ecordia.co.uk.

## Deploying

Any host for an ASP.NET Core 8 app (e.g. Azure App Service), HTTPS only, at a subdomain of the same parent domain as
Ecordiatlas. Set `Atlas:Url` here and `Atmosphere:Url` in Ecordiatlas. The service worker updates the app on the next
visit with a signal.

## Not built yet

- Going from Atmosphere into the Ecordia app already signed in: its *Ecordia* link opens the app, which asks for its
  own sign-in if it has none on that device. That needs Ecordia's server to accept a sign-in from Ecordiatlas, which
  Ecordia has to agree against its security standards.
- Tested in desktop Chrome (offline drafts, submitting with Ecordiatlas unreachable, sending when back, the 14-day
  send, passcode recovery, phone width); not yet on real phones.
