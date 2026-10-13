import type * as Preset from "@docusaurus/preset-classic";
import type { Config } from "@docusaurus/types";

/*
  The documentation site of GA4 BigQuery Raw Export Simulator (decision D-87).

  It is a Docusaurus site: a tool that turns text files into a website. It is
  not a service of its own. `npm run build` here writes a folder of plain
  files, and the web app (apps/web) serves that folder at /docs. So `baseUrl`
  is `/docs/`: every address and every link the build writes starts with it.

  The pages live in `pages/`, not in `docs/`, and they are `.mdx` files, not
  `.md` ones. Both on purpose: `infra/app.gcloudignore` leaves every folder
  named `docs` and every `.md` file out of the upload to Cloud Build. That
  file also gains the lines that let this folder through; see the README.
*/

// Where the site will stand. Docusaurus wants it for the addresses it writes
// into the page itself. Nothing in the site depends on it, so a machine that
// builds without the setting gets the local address.
const url = process.env.SITE_URL ?? "http://localhost:3000";

/*
  The three addresses of the top bar.

  They are written here, by hand, and they are copies. The web app holds the
  same values, and the two must be kept in step. A shared module is not
  possible as the build stands: `apps/web/Dockerfile` builds this site before
  it copies `apps/web` into the image, so nothing here can import from there.
  Change one of these three and change its twin in the same pull request.
*/

/** Mirrors `SUPPORT_EMAIL` in `apps/web/lib/wording.ts`. Keep the two in step. */
const SUPPORT_EMAIL = "support@superformlabs.eu";

/**
 * Mirrors `BUG_REPORT_URL` in `apps/web/lib/wording.ts`. Keep the two in step.
 *
 * Empty today, as it is in the app: the public repository has no bug form
 * yet. While it is empty, "Report a bug" opens an email to `SUPPORT_EMAIL`.
 * Fill it with the address of the form and the link opens that instead, in a
 * new tab, and nothing else here changes.
 *
 * The address it is filled with already carries a question mark and one
 * parameter, `?template=bug-report.yml`, which names the form and is required
 * (`docs/contracts/bug-form.md`). So `page` is added to it with `&`, never
 * with a second `?`. The form is given the page and nothing else, and never a
 * project ID or a dataset name: the site never knows them.
 */
const BUG_REPORT_URL = "";

/** Mirrors `SOURCE_CODE_URL` in `apps/web/lib/links.ts`. Keep the two in step. */
const REPOSITORY_URL = "https://github.com/superformlabs/ga4-bigquery-raw-export-simulator";

/*
  Where "Report a bug" leads. The same two cases as the app's own link
  (`bugReportHref` in `apps/web/lib/wording.ts`), with the same subject and
  the same two questions, so a report from the site reads like a report from
  the app. The app adds the project and the dataset when it knows them; this
  site never knows either, so the page is all it names.
*/
const bugReportHref = BUG_REPORT_URL
  ? `${BUG_REPORT_URL}&page=${encodeURIComponent("documentation site")}`
  : `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Bug report: GA4 BigQuery Raw Export Simulator")}` +
    `&body=${encodeURIComponent("What happened:\n\nWhat you expected:\n\nPage: documentation site\n")}`;

/*
  An email opens in the same tab, as it does in the app (`components/TopLinks.tsx`
  gives its own bug link no target): a mail link in a new tab leaves an empty
  tab behind. A bug form is a web page, so that one opens in a new tab.
*/
const bugReportTarget = BUG_REPORT_URL ? ' target="_blank" rel="noopener noreferrer"' : "";

const config: Config = {
  title: "GA4 BigQuery Raw Export Simulator",
  tagline: "What it puts in your Google Cloud project, what it costs you, and how to remove it.",
  url,
  baseUrl: "/docs/",
  organizationName: "superformlabs",
  projectName: "ga4-bigquery-raw-export-simulator",
  // A link that leads nowhere stops the build, rather than reaching a reader.
  onBrokenLinks: "throw",
  onBrokenAnchors: "throw",
  // Mermaid draws the diagram of the Architecture page. It is a text
  // description of a picture, which the browser turns into the picture.
  markdown: { mermaid: true, hooks: { onBrokenMarkdownLinks: "throw" } },
  themes: ["@docusaurus/theme-mermaid"],
  plugins: [
    /*
      One line of plumbing for Mermaid, and nothing else.

      `@docusaurus/theme-mermaid` can also draw with ELK, a second layout
      engine. ELK is an optional extra, the theme switches it off when the
      extra is not installed, and this site does not use it. But the build
      still looks for it while it reads the theme's code, and stops because
      it is not there. This tells the build to read that one line as nothing.
      Not installing the extra is deliberate: it unpacks to about 28 MB, and
      its published version does not match the version the theme asks for.
    */
    function ignoreMermaidElkLayout() {
      return {
        name: "ignore-mermaid-elk-layout",
        configureWebpack() {
          return { resolve: { alias: { "@mermaid-js/layout-elk": false as const } } };
        },
      };
    },
  ],
  // One address per page, with no slash at the end: /docs/what-it-costs, as
  // the app's own addresses are written. apps/web/next.config.ts serves both
  // that address and the same one with a slash.
  trailingSlash: false,
  i18n: { defaultLocale: "en", locales: ["en"] },
  // No images, no files to copy as they are: every page is text. Without this
  // Docusaurus looks for a `static` folder and stops when it finds none.
  staticDirectories: [],

  presets: [
    [
      "classic",
      {
        docs: {
          path: "pages",
          // The pages are the whole site, so they sit at its root: /docs, not /docs/pages.
          routeBasePath: "/",
          sidebarPath: "./sidebars.ts",
        },
        // No blog and no free-standing pages: this site is five documents.
        blog: false,
        pages: false,
        // No sitemap: the site has no public address of its own yet.
        sitemap: false,
        theme: { customCss: "./src/css/custom.css" },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    // The app is a full white page and has no dark side (decision D-22), so
    // neither has the site, and there is no switch to look for.
    colorMode: { defaultMode: "light", disableSwitch: true, respectPrefersColorScheme: false },
    // The diagram of the Architecture page. `neutral` is Mermaid's own light
    // theme: grey boxes and dark text on white, which sits quietly next to
    // the app's blue. Both entries are the light one, because the site has
    // no dark side to switch to.
    mermaid: { theme: { light: "neutral", dark: "neutral" } },
    navbar: {
      title: "GA4 BigQuery Raw Export Simulator",
      items: [
        // Back to the app itself, in the same tab: the reader came from the
        // app and goes back to it. Plain HTML on purpose. Every link
        // Docusaurus draws itself goes through its own router, whose base is
        // `baseUrl`, so a link to `/` comes out as `/docs/` and the reader
        // never leaves the site. Checked on 2026-10-12 against `to: "/"`,
        // `href: "/"` and `pathname:///`: all three gave `/docs/`.
        {
          type: "html",
          position: "right",
          value: '<a class="navbar__item navbar__link" href="/">Open the app</a>',
        },
        // The same two links as the top-right corner of the app, in the same
        // order (decision D-89), in words rather than with the app's marks.
        {
          type: "html",
          position: "right",
          value:
            `<a class="navbar__item navbar__link" href="${REPOSITORY_URL}" target="_blank" rel="noopener noreferrer">Source code</a>`,
        },
        {
          type: "html",
          position: "right",
          value: `<a class="navbar__item navbar__link" href="${bugReportHref}"${bugReportTarget}>Report a bug</a>`,
        },
      ],
    },
    footer: {
      style: "light",
      // The words at the bottom centre of every screen of the app (decision D-86), with the two capital
      // letters the owner asked for on 2026-10-13 (decision D-93), so the site and the app read the same.
      copyright: 'Powered By <a href="https://ga4dataform.com/" target="_blank" rel="noopener">GA4Dataform</a>',
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
