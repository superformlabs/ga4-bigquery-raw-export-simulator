# apps/web

The pages of GA4 BigQuery Raw Export Simulator. A visitor signs in with
Google, answers a few questions, and watches a simulated GA4 dataset being
installed into their own Google Cloud project. Next.js and TypeScript, React
19, and no other runtime dependency.

The browser never talks to Google Cloud. It only calls the backend
(`apps/api`). Next.js forwards `/api/*` and `/auth/*` to `API_URL`, so the
session cookie the backend sets is a same-origin cookie for the pages. The
same forwarding serves the real backend and the mock below.

## Run it

From the repository root, after `npm install`. Node 22 or newer.

**Against the mock**, which invents its own answers. No Google account, no
Google Cloud, nothing installed anywhere:

```sh
PORT=3000 npm run dev --workspace apps/web
```

Open `http://localhost:3000`. That one command starts two processes: the mock
backend on `PORT + 1`, and the pages on `PORT`.

**Against the real backend**, with a real Google sign-in and a real install.
Two terminals:

```sh
PORT=3001 npm run dev:api                                                       # terminal 1
PORT=3000 API_URL=http://localhost:3001 npm run dev:live --workspace apps/web   # terminal 2
```

Open `http://localhost:3000`. Both ports matter: Google compares the OAuth
redirect URI exactly, and the backend sends the browser back to its
`APP_URL`.

| Command, in this folder | What it does |
|---|---|
| `npm run dev` | The mock backend and the pages together, through `mocks/dev.mjs` |
| `npm run dev:live` | The pages alone, forwarding to the real backend at `API_URL` |
| `npm run mock` | The mock backend alone, on `MOCK_PORT` |
| `npm run build` | The production build, `next build` |
| `npm start` | Serves that build, `next start` |
| `npm run typecheck` | Checks the types, writes nothing |

## The documentation at /docs

The documentation is a separate site, `apps/docs-site`, which these pages
serve as plain files out of `public/docs`. It is build output, so it is not in
git, and `/docs` answers 404 until it is built. From the repository root,
once:

```sh
npm run docs
```

That builds the site and copies it into `apps/web/public/docs`. Both the
development server and `npm start` then serve it. See
`apps/docs-site/README.md`.

## Settings

Three files read an environment variable. `lib/` reads none, and neither does
any page: a page gets its state from the page address, as below.

**`next.config.ts`**, which the build and the server read:

| Variable | Default | What it does |
|---|---|---|
| `API_URL` | `http://localhost:3001` | Where `/api/*` and `/auth/*` are forwarded. A slash at the end is dropped. Next.js resolves this when `next build` runs, so a container has to be built with the value it will use |

**`mocks/dev.mjs`**, the one command that starts both processes:

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | The port of the pages |
| `MOCK_PORT` | `PORT + 1` | The port of the mock backend. `dev.mjs` passes it to the pages as `API_URL` |

**`mocks/server.mjs`**, the mock backend. It stands in for `apps/api`, so
several of its settings carry the names the real backend uses:

| Variable | Default | What it does |
|---|---|---|
| `MOCK_PORT` | `3001` | The port the mock listens on |
| `APP_URL` | empty | Where the browser lands after the invented sign-in. Empty means a relative address, which works on whatever port the pages use |
| `MOCK_SPEED` | `1` | Multiplies the mock's waits. `0.25` makes an install four times faster |
| `MOCK_FLAKY` | `0` | `1` makes the step that creates the job fail once in every project. With `0`, only the project named `flaky-project` does |
| `MOCK_MANY_PROJECTS` | `0` | Adds that many invented projects to the list, to see the list with hundreds of names |
| `MOCK_EMAIL` | `you@example.com` | The account the invented sign-in reports |
| `MOCK_SESSION_MINUTES` | `60` | How long that sign-in lasts, in minutes. Under 15 the check before the install refuses it, which is the point of the setting |
| `SUPPORT_EMAIL` | `support@superformlabs.eu` | The address the mock's hints name, as in the real backend |
| `ALLOWED_EMAIL_DOMAINS`, `ALLOWED_EMAILS` | empty | The mock's sign-in allowlist, comma separated, as in the real backend |
| `UNINSTALL_ENABLED` | empty | `true` switches the mock's uninstall route on, as in the real backend. Off by default: the route answers 404 |

The mock's project list is invented, and each name stands for one case worth
seeing: a project without billing, one you cannot edit, one already
installed, one whose dataset was deleted, one where a step fails once, one
where Google is slow. Read the top of `mocks/server.mjs` for the full list.

## What is in here

| Path | What it is |
|---|---|
| `app/page.tsx` | The welcome page |
| `app/install/` | Every other screen: the questions, then the install itself |
| `app/layout.tsx`, `app/globals.css` | The frame and the styling of every screen |
| `components/` | The screens and the small pieces they share |
| `lib/flow.ts` | The order of the screens, the defaults, and the rules each answer has to pass |
| `lib/api.ts`, `lib/contract.ts` | The calls to the backend, and the shapes it answers with |
| `lib/wording.ts` | The words shown on the screens |
| `mocks/` | The mock backend and the launcher of the development server |
| `Dockerfile` | The container, built from the repository root |

### The answers travel in the page address

There is no store and no state kept between screens. Each answer is a query
parameter of the address, so a screen can be reopened, shared or bookmarked,
and the back arrow of the browser is the back arrow of the app. A value in the
address that cannot be right sends the visitor back to the screen that asks
for it.

### The container

`Dockerfile` is built from the **repository root**, not from this folder,
because the apps are npm workspaces that share one `package-lock.json`:

```sh
docker build -f apps/web/Dockerfile --build-arg API_URL=https://<api host> -t ga4fake-web .
```

`API_URL` and `SITE_URL` are build arguments, because `next build` and the
documentation site both resolve them at build time. The container listens on
`PORT`, which Cloud Run sets. `infra/deploy-app.sh` builds this image on
Cloud Build, after the backend is deployed and its address is known.
