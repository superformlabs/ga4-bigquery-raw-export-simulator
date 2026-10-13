import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

/*
  The five documents of the site, in the order a reader should meet them: the
  introduction, then what the tool does, what it costs and how to remove it,
  then how it is built.
*/
const sidebars: SidebarsConfig = {
  documentation: ["index", "what-it-does", "what-it-costs", "how-to-remove", "architecture"],
};

export default sidebars;
