import type { NextConfig } from "next";

// Where the backend (or the mock standing in for it) listens. The browser
// never talks to it directly: Next.js forwards /api/* and /auth/* there, so
// the cookie the backend sets is a same-origin cookie for the UI.
const apiUrl = (process.env.API_URL ?? "http://localhost:3001").replace(/\/$/, "");

const nextConfig: NextConfig = {
  // Next.js 16 writes AGENTS.md and CLAUDE.md into this folder otherwise; the repo has its own.
  agentRules: false,
  // The badge of the development server sits in the bottom-left corner, where the back arrow is.
  devIndicators: false,
  // The documentation site (decision D-87) is a folder of plain files in
  // public/docs, built by apps/docs-site. Its own links point at /docs/, with
  // the slash, and the book in the top-right corner of the app opens /docs,
  // without it. Next.js would answer the first with a redirect to the second,
  // which would make the site's own home link a detour. So the redirect is
  // off and both addresses are answered below. Every other address of the app
  // is written without a slash at the end, so nothing else changes.
  skipTrailingSlashRedirect: true,
  async redirects() {
    return [
      // The documentation used to be a page of the app (decisions D-47 and
      // D-77). It is the Docusaurus site now (decision D-87), and the old
      // address still works, for anyone who bookmarked it.
      { source: "/read-more", destination: "/docs", permanent: true },
    ];
  },
  async rewrites() {
    return {
      // After the files of public/: a real file of the site, such as
      // /docs/assets/js/main.js, is served as it is, and only an address with
      // no file of its own reaches these.
      afterFiles: [
        { source: "/api/:path*", destination: `${apiUrl}/api/:path*` },
        { source: "/auth/:path*", destination: `${apiUrl}/auth/:path*` },
        // The home page of the documentation site, with and without the slash.
        { source: "/docs", destination: "/docs/index.html" },
        { source: "/docs/", destination: "/docs/index.html" },
        // Every other page of it: /docs/what-it-costs is the file
        // public/docs/what-it-costs.html (`trailingSlash: false` in
        // apps/docs-site/docusaurus.config.ts writes them that way). An
        // address that is no page of the site has no such file either, so it
        // falls through to the app's own "page not found", with a 404. The
        // site's own 404 page could be shown instead, but only with a 200,
        // which would tell a machine the page exists.
        { source: "/docs/:page*", destination: "/docs/:page*.html" },
      ],
    };
  },
};

export default nextConfig;
