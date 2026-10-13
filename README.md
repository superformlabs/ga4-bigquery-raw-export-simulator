# GA4 BigQuery Raw Export Simulator

A web page that installs a simulated Google Analytics 4 (GA4) BigQuery export
into your own Google Cloud project. You sign in with Google, pick a project,
and a few minutes later that project holds a BigQuery dataset shaped like a
real GA4 export: one `events_YYYYMMDD` table per day for an invented
e-commerce site. If you ask for it, a small scheduled job in your own project
adds a new day every morning.

It is made for people learning GA4 in BigQuery, people testing SQL models
such as GA4Dataform, and agencies building dashboards without client data.

Nothing is stored on our side. The install happens in your project, with
your own Google sign-in, and the daily job belongs to you.

## What this repository is

This is a **snapshot of the code**, copied from our private working
repository under the MIT licence (see `LICENSE`). It holds the application
and the cloud scripts, and nothing else: no history, no issues, no internal
notes, no design documents, and none of our own project settings.

**The comments in the code point at things you cannot see.** The private
repository keeps a decision log, a task list and a set of design documents,
and a comment often names one of them: a decision such as `D-82`, a task such
as `UI-29`, or a design file under `docs/`. None of those is published here.
None of them is needed either. Every comment also says in plain words why the
code does what it does, and the code runs exactly the same without the
reference. The README of each part of the app is a different matter: those are
written for this copy, and they name nothing you cannot see.

## What is inside

| Path | What it is |
|---|---|
| `apps/web/` | The pages a visitor uses. Next.js and TypeScript |
| `apps/api/` | The backend: Google sign-in, and the install into the visitor's project. Node and TypeScript |
| `apps/docs-site/` | The documentation, a Docusaurus site that `apps/web` serves at `/docs` |
| `packages/generator/` | The data generator itself, the Python package `ga4synth`, and the two configurations of the simulated site |
| `infra/` | The scripts that build the generator container and host the app on Google Cloud |

The generator is the Python package `ga4synth`, and its code is in
`packages/generator/src/ga4synth/`. The code is MIT like the rest of this
repository; the data it produces is public domain under CC0 1.0
(`packages/generator/LICENSE-DATA`). You can install it, run it and build its
container image from this copy alone. See `packages/generator/README.md`.

## Run it on your machine

You need Node 22 or newer. From the repository root:

```sh
npm install
```

**The pages alone**, against a mock backend. No Google account, no Google
Cloud, nothing installed anywhere:

```sh
PORT=3000 npm run dev --workspace apps/web
```

Open `http://localhost:3000`. One command starts two processes: the mock
backend on `PORT + 1` and the pages on `PORT`.

**The real thing**, with a real Google sign-in and a real install. You need
three things first: your own Google Cloud project, your own OAuth client whose
redirect URI is `http://localhost:3001/auth/callback`, and the generator
container image the install tells your project to run.

The image is the one part this copy cannot hold. The backend reads its name
from `infra/IMAGE`, which `./infra/build.sh` writes into **your** project, and
this snapshot carries no `infra/IMAGE`. Without it the backend stops at start
with "GENERATOR_IMAGE must be a full container image name with a tag". So
either build it, which also writes the file:

```sh
./infra/build.sh        # see "Run it in your own Google Cloud" below
```

That build needs a Google Cloud project of your own, and nothing else: the
generator's code is in this repository. If you already have an image, name it
instead, in `apps/api/.env`:

```
GENERATOR_IMAGE=us-central1-docker.pkg.dev/your-project-id/ga4synth/ga4synth:<tag>
```

Then, in two terminals:

```sh
cp apps/api/.env.example apps/api/.env   # then fill in your OAuth client values
PORT=3001 npm run dev:api                                                       # terminal 1
PORT=3000 API_URL=http://localhost:3001 npm run dev:live --workspace apps/web   # terminal 2
```

Open `http://localhost:3000`. The API port must stay 3001, because Google
compares the redirect URI exactly. `apps/api/README.md` lists every setting;
`apps/web/README.md` does the same for the pages. The mock above needs none of
this: it invents its own answers.

## Run it in your own Google Cloud

The scripts in `infra/` build the generator container and host the two
services on Cloud Run. They read their settings from a file you write,
`infra/env/dev.env`, which this snapshot does not include: ours holds our own
project. Write yours with these keys:

```
PROJECT=your-project-id
ACCOUNT=you@example.com
REGION=us-central1
LOCATION=US
GENERATOR_REPO=ga4synth
APP_REPO=ga4fake
ALLOWED_EMAIL_DOMAINS=
ALLOWED_EMAILS=
IMAGE_FILE=IMAGE
URLS_FILE=URLS
API_ENV_FILE=apps/api/.env
```

Then:

```sh
./infra/build.sh        # build the generator container, write its name to infra/IMAGE
./infra/install.sh      # install a dataset, a daily job and its schedule, by hand
./infra/deploy-app.sh   # host the pages and the backend on Cloud Run
./infra/check-app.sh    # check the hosted app from the outside
```

Every script that changes something accepts `PLAN=1`, which prints the
project, region and files it would use and then stops. `check-app.sh` changes
nothing, so it has no `PLAN`. `./infra/uninstall.sh` removes what `install.sh`
made, and `./infra/deploy-app-teardown.sh` removes the hosting.

## Reporting a bug

Open an issue with the bug form:
[report a bug](https://github.com/superformlabs/ga4-bigquery-raw-export-simulator/issues/new?template=bug-report.yml).
It is the one way to reach us here, and we read every report.

**Please do not put private details in an issue.** An issue is readable by
everyone. No Google Cloud project ID, no dataset name, no email address, no
key or token. The form says the same, and asks you to confirm it.

`CONTRIBUTING.md` says the same in short.

## Pull requests are not accepted

This repository is a one-way copy of a private working repository, so a pull
request cannot be merged into it, and pull requests are switched off. The
MIT licence lets you fork it and change your copy as you like. If something
is wrong here, tell us with the bug form above and we will fix it at the
source.
