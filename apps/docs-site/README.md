# apps/docs-site

The documentation of GA4 BigQuery Raw Export Simulator. It is a
[Docusaurus](https://docusaurus.io/) site: a tool that turns text files into
a website.

It is **not a service of its own.** `npm run build` here writes a folder of
plain files, and the web app (`apps/web`) serves that folder at `/docs`.
There is one web service, as there was before the site existed.

## The five pages

| Page | File | What it is |
|---|---|---|
| Overview | `pages/index.mdx` | A short introduction, and nothing else. It is the home page: `slug: /`, so `/docs` opens it |
| What the tool does | `pages/what-it-does.mdx` | What the tool puts in your project |
| What it costs | `pages/what-it-costs.mdx` | The section about money, then the measured figures and the Google list prices |
| How to remove an install | `pages/how-to-remove.mdx` | How to take it all out again |
| Architecture | `pages/architecture.mdx` | A technical diagram of the app, and a plain-English walk through it |

The section about money sits at the top of "What it costs", above that page's
first heading. The home page is the introduction only.

Every figure and price on "What it costs" is traced to a measurement or to a
Google price list. Do not round a figure, drop a price code or reword one of
those sentences.

The Architecture page is this site's own. Every component and every flow on
it is checked against the code it names. Do not add a box or an arrow you
cannot point to in `apps/web`, `apps/api` or `infra`.

## Run it while you write

From the repository root:

```sh
npm run dev --workspace apps/docs-site
```

That starts the site's own development server at
`http://localhost:3000/docs`, and reloads a page as you save it. Pick another
port with `--port`:

```sh
npm run dev --workspace apps/docs-site -- --port 3010
```

## Build it, and see it where a reader sees it

From the repository root, one command builds the site and puts it where the
web app serves it:

```sh
npm run docs
```

It writes `apps/docs-site/build`, then copies that into
`apps/web/public/docs`. Both are build output, and neither is in git. Then
start the web app and open `http://localhost:3000/docs`:

```sh
npm run build --workspace apps/web
npm run start --workspace apps/web
```

| Command, in this folder | What it does |
|---|---|
| `npm run dev` | The development server, `docusaurus start` |
| `npm run build` | Writes the site into `build/` |
| `npm run serve` | Serves what `build` wrote |
| `npm run clear` | Deletes the Docusaurus cache |
| `npm run typecheck` | Checks the types of the configuration files |

## Settings

One, read by `docusaurus.config.ts`:

| Variable | Default | What it does |
|---|---|---|
| `SITE_URL` | `http://localhost:3000` | The address the site will stand at. Docusaurus writes it into the pages themselves. Nothing in the site depends on it, so a machine that builds without it still gets a working site |

`apps/web/Dockerfile` passes it as a build argument, because the build is
where it is read.

The rest of the configuration is in the file, not in the environment. Worth
knowing:

- `baseUrl` puts the whole site under `/docs`. Every address and every link
  the build writes starts there.
- `trailingSlash` is `false`, so each page is one file, such as
  `what-it-costs.html`, and its address has no slash at the end.
  `apps/web/next.config.ts` serves each page at that address and at the same
  one with a slash, so neither is a detour through the other.
- `onBrokenLinks` and `onBrokenAnchors` are `throw`: a link that leads
  nowhere stops the build rather than reaching a reader.
- `staticDirectories` is empty. Every page is text, so there is no `static`
  folder to copy, and without this Docusaurus would look for one and stop
  when it found none.
- Dark mode is switched off. The app is a white page, so the site is one too,
  and there is no switch to look for.
- `markdown.mermaid` is `true` and `@docusaurus/theme-mermaid` is in
  `themes`. That is what draws the diagram of the Architecture page.

## The files

| Path | What it is |
|---|---|
| `pages/*.mdx` | The five pages above |
| `sidebars.ts` | Their order in the list on the left |
| `docusaurus.config.ts` | The name, `baseUrl`, the three addresses of the top bar, Mermaid, the line at the bottom |
| `src/css/custom.css` | The colours and the font of the app, applied to the theme |

### Two names chosen on purpose

The folder of pages is `pages`, not `docs`, and the pages are `.mdx` files,
not `.md` ones. Both because `infra/app.gcloudignore` decides what reaches
Cloud Build, and it drops every folder named `docs` and every `.md` file.
That file also carries lines that let this whole folder through, so the two
names are a second guard rather than the only one.

## The diagram: Mermaid

The Architecture page draws its diagram with
[Mermaid](https://mermaid.js.org/), through `@docusaurus/theme-mermaid` at the
version of `@docusaurus/core`. Mermaid is a text description of a picture,
which the browser turns into the picture. So the diagram is text in
`pages/architecture.mdx`, inside a fence marked `mermaid`, and it is
reviewable like any other text. The theme is given Mermaid's own `neutral`
theme, a light one, for both modes, because the site has no dark side.

One piece of plumbing goes with it, the plugin `ignore-mermaid-elk-layout` in
`docusaurus.config.ts`. Mermaid can also draw with ELK, a second layout
engine, which is an optional extra. This site does not use it and does not
install it: it unpacks to about 28 MB, and its published version does not
match the version the theme asks for. The theme switches that code off, but
the build still looks for the extra while it reads the theme's code, and stops
because it is not there. The plugin tells the build to read that one line as
nothing.

Mermaid is a build-time package of this folder only, so the packages installed
in the web service's runtime image do not change: `apps/web/Dockerfile` builds
the site in an earlier stage and copies only the built files across.

Those built files do grow, and by a lot. Mermaid's own code is served to the
browser, so the site went from about 0.7 MB of static files to about 6.0 MB,
measured on 2026-10-13 by building this folder with and without it. That 5 MB
is in the runtime image, under `/docs`. The browser only fetches it on the
Architecture page, because the theme loads Mermaid when that page asks for it
and not before, so no other page got slower.

## The top bar and the line at the bottom

- **Top bar:** the name of the app on the left, which opens the home page of
  the site. On the right, three links in this order, the same order as the
  top-right corner of the app: **Open the app**, which opens `/` in the same
  tab; **Source code**, which opens this repository in a new tab; and
  **Report a bug**. Words only, no icons.

  "Open the app" is plain HTML on purpose: every link Docusaurus draws itself
  goes through its own router, whose base is `baseUrl`, so a link to `/`
  would come out pointing back into the site.
- **At the bottom:** **Powered By GA4Dataform**, which opens
  `https://ga4dataform.com/` in a new tab, as the bottom of every screen of
  the app does.

### Three addresses that must be kept in step with the app

They are named constants at the top of `docusaurus.config.ts`, and they are
**copies** of values the web app holds:

| Constant here | Its twin in the app | What it is |
|---|---|---|
| `SUPPORT_EMAIL` | `SUPPORT_EMAIL` in `apps/web/lib/wording.ts` | Where a bug report goes while `BUG_REPORT_URL` is empty |
| `BUG_REPORT_URL` | `BUG_REPORT_URL` in `apps/web/lib/wording.ts` | The public bug form, set in both places since 2026-10-13 |
| `REPOSITORY_URL` | `SOURCE_CODE_URL` in `apps/web/lib/links.ts` | This repository |

**Change one and change its twin, in the same pull request.** A shared module
is not possible as the build stands: `apps/web/Dockerfile` runs
`npm run build --workspace apps/docs-site` before it copies `apps/web` into
the image, so nothing here can import from there.

"Report a bug" behaves as the app's own link does:

- `BUG_REPORT_URL` is set, so the link opens the bug-report form of this
  repository in a new tab, with `page` filled in as `documentation site` and
  nothing else. Never a project ID and never a dataset name: the site knows
  neither, and a public form is readable by everyone. The address carries a
  question mark and `template=bug-report.yml` already, which names the form
  and is required, so `page` is joined to it with `&`.
- Empty `BUG_REPORT_URL` and the link opens an email to `SUPPORT_EMAIL`
  instead, with the app's subject and the app's two questions, and the page
  named as `documentation site`. In the **same tab**, as in the app: a mail
  link in a new tab leaves an empty tab behind.
