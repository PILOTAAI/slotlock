// The landing page as Markdown, built from the same copy module as the HTML page.
import type { APIRoute } from 'astro';
import {
  closing,
  dashboard,
  developers,
  facts,
  faq,
  footer,
  hero,
  heroAria,
  heroLog,
  industries,
  meta,
  pricing,
  proof,
  REPO_URL,
  security,
  signIn,
  source,
  story,
  strip,
} from '../data/landing';

const SITE = 'https://slotlock.pylota.io';
const abs = (href: string) => (href.startsWith('/') ? `${SITE}${href}` : href.startsWith('#') ? `${SITE}/${href}` : href);
const heading = (h: { soft: string; strong: string }) => `## ${h.soft} ${h.strong}`;
const list = (items: string[]) => items.map((item) => `- ${item}`).join('\n');
const link = (l: { label: string; href: string }) => `[${l.label}](${abs(l.href)})`;
const siteLinks = (text: string) => text.replace(/\]\(\//g, `](${SITE}/`);

export const GET: APIRoute = () => {
  const parts = [
    `# ${meta.title}`,
    `> ${meta.description}`,
    `## ${hero.heading.soft} ${hero.heading.strong}`,
    hero.lede,
    `[${signIn.start}](${signIn.href}) · ${link(hero.docs)}. ${hero.note}`,
    `What the dashboard at the top of the page shows: ${heroAria}`,
    `The agents' activity, in order, over MCP:\n\n${list(
      heroLog.map((line) => `Agent ${line.agent}: ${line.ask} (\`${line.call}\`) → ${line.result}`),
    )}`,
    list(strip.items.map((item) => item.text)),
    `[${strip.proof.name}](${strip.proof.href}), ${strip.proof.text}`,
    heading(story.heading),
    story.items
      .map((step) => `${step.n}. **${step.title}.** ${siteLinks(step.body)} ${link(step.link)}`)
      .join('\n'),
    heading(proof.heading),
    proof.lede,
    `\`\`\`\n${proof.race.map((line) => `${line.who}  ${line.what}  ${line.result}`).join('\n')}\n\`\`\``,
    proof.links.map(link).join(' · '),
    `| | ${proof.compare.columns[1]} | ${proof.compare.columns[2]} |\n| --- | --- | --- |\n${proof.compare.rows
      .map((row) => `| ${row.join(' | ')} |`)
      .join('\n')}`,
    heading(dashboard.heading),
    dashboard.lede,
    dashboard.aria,
    list(dashboard.points.map((point) => `**${point.title}.** ${point.body}`)),
    link(dashboard.link),
    heading(industries.heading),
    list(industries.items.map((item) => `**${item.title}.** ${item.body}`)),
    link(industries.link),
    heading(developers.heading),
    developers.lede,
    `\`\`\`sh\n${developers.cloudMcpAdd}\n\`\`\``,
    `${developers.endpoints.caption}:\n\n${list(developers.endpoints.items.map((item) => `${item.label}: \`${item.value}\``))}`,
    list(developers.rows.map((row) => `${link(row)}: ${row.body}`)),
    list(developers.install.map((target) => `${target.label}: \`${target.command}\` (${siteLinks(target.note)})`)),
    `Tools:\n\n${list(facts.tools.map((tool) => `\`${tool.name}\`: ${tool.description}`))}`,
    list(developers.capabilities.map((item) => `[${item.title}](${abs(item.href)}): ${item.body}`)),
    heading(security.heading),
    list(security.statements),
    link(security.link),
    heading(pricing.heading),
    pricing.lede,
    list(
      pricing.plans.map(
        (plan) =>
          `**${plan.name}** (${plan.host.toLowerCase()}): ${plan.price}${plan.per ? `, ${plan.per}` : ''}. ${plan.tagline} ${plan.features.join('; ')}. ${link(plan.cta)}`,
      ),
    ),
    `${siteLinks(signIn.terms)} ${pricing.note} [${pricing.contact.label}](${pricing.contact.href}) ${link(pricing.link)}`,
    heading(source.heading),
    `[${source.repo.name}](${REPO_URL}), ${facts.license}.`,
    list(source.statements),
    heading(faq.heading),
    faq.items.map((item) => `**${item.q}** ${siteLinks(item.a)}`).join('\n\n'),
    heading(closing.heading),
    `[${signIn.start}](${signIn.href}) · ${link(hero.docs)} · [llms.txt](${SITE}/llms.txt)`,
    `${footer.version.label}. ${footer.legal}`,
  ];
  return new Response(`${parts.join('\n\n')}\n`, {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
};
