// The addresses of the Google Cloud console that the app links to, and the
// address of the app's own documentation. Nothing here is imported, so
// that node can load this file alone.

/**
 * The documentation site (decision D-87): a Docusaurus site built by
 * `apps/docs-site` and served by this app at this address. The book in the
 * top-right corner of every screen opens it in a new tab (decision D-77), and
 * so do the words "read the documentation" of the welcome text (decision
 * D-82), so that the visitor's place in the flow is never touched.
 *
 * Written without a slash at the end, as every address of the app is. The
 * site's own links use `/docs/`, with the slash; `next.config.ts` answers
 * both.
 */
export const DOCS_PATH = "/docs";

/**
 * The public repository that holds the app's code (decision D-88): a clean
 * copy of this app, published under the MIT licence. Written here once, so
 * that every place that links to it says the same address: the words "open
 * source code" of the welcome text (decision D-90), and the "Source code"
 * link of the top-right corner (decision D-89), which is not built yet.
 *
 * The repository is still private, so the link shows GitHub's 404 page until
 * it is made public. That is accepted (decision D-90).
 */
export const SOURCE_CODE_URL = "https://github.com/superformlabs/ga4-bigquery-raw-export-simulator";

/**
 * BigQuery, opened on one dataset (task UI-24).
 *
 * - `project` is the project the console works in. Google describes it in
 *   "Explore BigQuery in the Google Cloud console"
 *   (https://docs.cloud.google.com/bigquery/docs/bigquery-web-ui).
 * - `p`, `d` and `page=dataset` name the dataset to open. Google uses this
 *   form in the links of its own documentation, such as the one to the
 *   dataset `samples` in "BigQuery public datasets"
 *   (https://docs.cloud.google.com/bigquery/public-data). No page that was
 *   found describes these three names, so Google may change them. The
 *   address still holds `project`, as it did before this task.
 */
export function bigQueryUrl(projectId: string, datasetId: string): string {
  const q = new URLSearchParams({ project: projectId, p: projectId, d: datasetId, page: "dataset" });
  return `https://console.cloud.google.com/bigquery?${q}`;
}
