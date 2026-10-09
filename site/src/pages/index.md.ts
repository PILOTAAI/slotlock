// The landing page as Markdown, built from the same copy module as the HTML page.
import type { APIRoute } from 'astro';
import {
  closing,
  compare,
  developers,
  facts,
  faq,
  footer,
  hero,
  heroAria,
  heroLog,
  legend,
  legendCounts,
  meta,
  model,
  ruleCode,
  openSource,
  proof,
  RACE_TEST_URL,
  REPO_URL,
  security,
  specStrip,
  steps,
} from '../data/landing';

const SITE = 'https://slotlock.pylota.io';
const abs = (href: string) => (href.startsWith('/') ? `${SITE}${href}` : href);
const heading = (h: { soft: string; strong: string }) => `## ${h.soft} ${h.strong}`;
const list = (items: string[]) => items.map((item) => `- ${item}`).join('\n');

export const GET: APIRoute = () => {
  const counts = legendCounts();
  const parts = [
    `# ${meta.title}`,
    `> ${meta.description}`,
    `${hero.eyebrow}. ${hero.pill.label}: [release notes](${abs(hero.pill.href)}).`,
    `## ${hero.heading.soft} ${hero.heading.strong}`,
    hero.lede,
    list(hero.install.map((target) => `${target.label}: \`${target.command}\` (${target.note})`)),
    `What the calendar at the top of the page shows: ${heroAria}`,
    `The calls, in order (mcp: MCP tool call, ts: TypeScript store):\n\n${list(
      heroLog.map(
        (line) =>
          `${line.time} agent ${line.agent}: \`${line.call}\` ${line.args} → ${line.result}`,
      ),
    )}`,
    list(specStrip),
    heading(proof.heading),
    proof.lede,
    `The constraint, from \`src/ddl.ts\`:\n\n\`\`\`sql\n${facts.excludeConstraint}\n\`\`\``,
    `${proof.resultCaption}:\n\n\`\`\`ts\n${proof.storeResult}\n\`\`\`\n\nOver MCP, a tool result:\n\n\`\`\`json\n${proof.mcpResult}\n\`\`\`\n\n[${proof.testLink}](${RACE_TEST_URL})`,
    heading(steps.heading),
    steps.items
      .map(
        (step) =>
          `${step.n}. **${step.title}.** ${step.body} [${step.link.label}](${abs(step.link.href)})`,
      )
      .join('\n'),
    steps.diagram.aria,
    heading(model.heading),
    model.lede,
    `Weekly rule for the van:\n\n\`\`\`ts\n${ruleCode()}\n\`\`\``,
    `Legend of the calendar above: ${legend.map((item) => `${item.label} ${counts[item.kind]}`).join(', ')}.`,
    heading(developers.heading),
    developers.lede,
    `\`\`\`sh\n${facts.claudeMcpAdd}\n\`\`\``,
    `Tools:\n\n${list(facts.tools.map((tool) => `\`${tool.name}\`: ${tool.description}`))}`,
    list(developers.links.map((link) => `[${link.label}](${abs(link.href)})`)),
    heading(security.heading),
    `An agent's write can wait for a person. The form reads: "${security.approval.message}" with one tick box, "${security.approval.checkbox}". ${security.approval.seal}.`,
    list(security.statements),
    heading(compare.heading),
    `| | ${compare.columns[1]} | ${compare.columns[2]} |\n| --- | --- | --- |\n${compare.rows
      .map((row) => `| ${row.join(' | ')} |`)
      .join('\n')}`,
    heading(openSource.heading),
    `[${openSource.repo.name}](${REPO_URL}), ${facts.license}. Run it: \`${openSource.repo.run}\`.`,
    list(openSource.statements),
    heading(faq.heading),
    faq.items.map((item) => `**${item.q}** ${item.a}`).join('\n\n'),
    heading(closing.heading),
    `[Get started](${SITE}/docs/quickstart/) · [Read the specification](${SITE}/docs/specification/) · [llms.txt](${SITE}/llms.txt)`,
    `${footer.legal}`,
  ];
  return new Response(`${parts.join('\n\n')}\n`, {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
};
