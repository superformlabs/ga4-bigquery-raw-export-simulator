# apps/api

The backend of GA4 BigQuery Raw Export Simulator. It signs the visitor in
with Google, keeps their access token in an encrypted cookie, and uses that
token to install the simulated GA4 dataset, the generator job and the daily
schedule into the visitor's own Google Cloud project. Node and TypeScript,
with [Hono](https://hono.dev/) as the web framework.

Nothing is stored on the server. There is no database and no session store:
the cookie carries the token, and the state of an install is read back from
the visitor's project each time it is asked for.

## Run it

From the repository root:

```sh
npm install                              # once
cp apps/api/.env.example apps/api/.env   # then fill in the OAuth client values
npm run dev:api                          # http://localhost:3001, restarts on change
```

`npm run dev:api` at the root is the same as `npm run dev` in this folder.

| Command, in this folder | What it does |
|---|---|
| `npm run dev` | Runs `src/server.ts` with `tsx watch`, restarting on every change |
| `npm run typecheck` | Checks the types, writes nothing |
| `npm run build` | Compiles TypeScript to `dist/` |
| `npm start` | Runs the compiled `dist/server.js` with plain Node |

Node 22 or newer. Two things have to be true before a real sign-in works:

- the OAuth client's **authorised redirect URI** must match
  `GOOGLE_REDIRECT_URI` exactly, port included. That is why the port stays
  3001 in development;
- `GENERATOR_IMAGE` must name a generator container image. The server reads
  `infra/IMAGE` when the variable is unset, and that file is written by
  `./infra/build.sh` into your own project. It is not part of this snapshot,
  so set the variable or build the image first. Without either, the server
  stops at start with "GENERATOR_IMAGE must be a full container image name
  with a tag".

A quick look at a running server:

```sh
curl -i http://localhost:3001/api/health
# 200 {"ok":true,"version":"<git sha>"}

curl -i http://localhost:3001/api/me
# 401 {"error":{"code":"UNAUTHENTICATED", ...}}
```

## Settings

`src/server.ts` loads `apps/api/.env` if that file exists, then reads
everything from the process environment. `src/config.ts` checks the values
and stops the server at start when one of them cannot work.
`.env.example` is the template.

| Variable | Required | Default | What it does |
|---|---|---|---|
| `GOOGLE_CLIENT_ID` | yes | | The OAuth client ID of your own Google Cloud project |
| `GOOGLE_CLIENT_SECRET` | yes | | The OAuth client secret |
| `GOOGLE_REDIRECT_URI` | no | `http://localhost:3001/auth/callback` | Where Google sends the browser back. Must match a redirect URI registered on the OAuth client, exactly |
| `PORT` | no | `3001` | The port the server listens on. A whole number from 1 to 65535 |
| `APP_URL` | no | `http://localhost:3000` | The address of the pages. The browser is sent there after signing in and out. A slash at the end is dropped |
| `SESSION_SECRET` | in production | a new random one each run | Key material for the encrypted session cookie. Required when `NODE_ENV=production`; without it in development, sessions do not survive a restart. Make one with `openssl rand -base64 32` |
| `COOKIE_SECURE` | no | `true` when `NODE_ENV=production`, else `false` | Adds the `Secure` flag to the cookies. `true` or `1` switches it on |
| `GENERATOR_IMAGE` | yes, unless `infra/IMAGE` exists | the one line of `infra/IMAGE` | The full name, with a tag or a digest, of the generator container image the visitor's Cloud Run job pulls |
| `ALLOWED_EMAIL_DOMAINS` | no | empty | Sign-in allowlist: domains, comma separated, such as `example.com`. No `@`, no address |
| `ALLOWED_EMAILS` | no | empty | Sign-in allowlist: whole addresses, comma separated |
| `SUPPORT_EMAIL` | no | `support@superformlabs.eu` | The address every hint names when it asks the visitor to report a problem. Must be one address |
| `UNINSTALL_ENABLED` | no | off | `true` switches `POST /api/install/uninstall` on. Off by default, and the route then answers 404, as a route that does not exist. Only `true` or `false` are accepted |
| `NODE_ENV` | no | empty | `production` makes `SESSION_SECRET` required and `COOKIE_SECURE` true by default |
| `GIT_SHA` | no | what `git rev-parse --short HEAD` prints, or `unknown` | The version `GET /api/health` reports |

### The sign-in allowlist

Both allowlist variables are empty by default, and then every Google account
may sign in. When either one is set, an account may sign in only if its
address is in `ALLOWED_EMAILS` or the part after its last `@` is in
`ALLOWED_EMAIL_DOMAINS`. Values are trimmed and compared without regard to
case, the domain has to match in full (`example.com` does not admit
`you@sub.example.com`), and the address has to be one Google reports as
verified. A refused account is sent to `APP_URL/?error=ACCOUNT_NOT_ALLOWED`,
no cookie is set, and the token Google just issued is revoked.

## Google OAuth scopes

Three, asked for at sign-in with `access_type=online`. Google then issues no
refresh token, so nothing outlives the access token, which lasts about an
hour. They are listed in `src/google.ts`.

| Scope | Why it is needed |
|---|---|
| `openid` | Makes Google return an ID token. That token is the proof of who signed in |
| `email` | Puts the visitor's email address in that ID token. `GET /api/me` shows it, and the sign-in allowlist reads it |
| `https://www.googleapis.com/auth/cloud-platform` | Does the whole install in the visitor's project: list their projects, enable the APIs, create the BigQuery dataset, the service account, the Cloud Run job and the Cloud Scheduler schedule, and start the backfill. No narrower scope covers Cloud Run and Cloud Scheduler, so this one scope stands for all of it |

The third scope is wide: it is full access to the project the visitor
chooses, for as long as the token lasts. Two things limit it. The token is
only ever used for the calls of the install, and it is held in a cookie in
the visitor's own browser, never on the server.

## What is in here

| Path | What it is |
|---|---|
| `src/server.ts` | Entry point: loads `.env`, builds the app, listens on `PORT` |
| `src/app.ts` | Every route, listed below |
| `src/config.ts` | Every setting above, checked at start |
| `src/google.ts` | The sign-in, the scopes, and the list of the visitor's projects |
| `src/session.ts` | The encrypted cookie that holds the visitor's token |
| `src/cloud.ts` | Every call to Google Cloud, behind one interface |
| `src/install.ts` | The install steps, each one safe to call again |
| `src/preflight.ts`, `src/permissions.ts` | The check run before the install: billing, permissions, policies |
| `src/existing.ts`, `src/uninstall.ts` | Finding an earlier install, and removing one |
| `src/account-retry.ts`, `src/scheduler-retry.ts` | The two waits for Google to catch up, one of them described below |
| `src/errors.ts` | The error codes and the wording of the hints |

The routes: `GET /auth/login`, `GET /auth/callback`, `POST /auth/logout`,
`GET /api/health`, `GET /api/me`, `GET /api/projects`,
`POST /api/install/preflight`, `POST /api/install/steps/:step`,
`GET /api/install/status`, `GET /api/install/existing`, and
`POST /api/install/uninstall` when `UNINSTALL_ENABLED` is `true`.

Each install step is idempotent: calling it again when its result already
exists changes nothing. That is what makes the "Try again" button safe.

## When Google does not know the new service account yet

Google creates a service account at once, but its other services need a few
seconds before they know it exists. Until then, a grant that names the
account is refused with "Service account ... does not exist". The longest
wait measured was 14 seconds.

So the `create-service-account` step tries both of its grants again on that
answer: the roles on the project, and the `WRITER` access on the dataset.

- The waits are 1, 2, 3, 4, 5 and 5 seconds, 20 seconds in all. The two
  grants share them.
- Each try reads the policy, or the dataset, again, so the etag it sends is
  a fresh one.
- No wait ends later than 22 seconds after the step began. That leaves 8
  seconds of the web app's 30 second limit for the calls that follow.
- If Google still does not know the account, the answer is
  `502 UPSTREAM_ERROR`, and its hint is "Try again in a moment. The install
  continues where it stopped."
- Only that one answer is retried, recognised by its words: "does not
  exist" together with the address of the account or the words "service
  account". A missing permission, or any other error, is answered at once.

`infra/lib/dataset.sh` recognises the same answer the same way, so the
install by hand behaves like this one.
