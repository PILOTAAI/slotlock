// Every page outside the docs that is built from data (src/lib/page.ts): the routes in src/pages/,
// their Markdown twins (src/pages/[...twin].md.ts) and llms.txt read this list.
import type { MarketingPage } from '../../lib/page';
import { aboutPage } from './about';
import { bookingApiPage } from './booking-api';
import { compareHub, comparePages } from './compare';
import { mcpServerPage } from './mcp-server';
import { openSourcePage } from './open-source';
import { pricingPage } from './pricing';
import { useCasePages, useCasesHub } from './use-cases';

export const MARKETING_PAGES: MarketingPage[] = [
  pricingPage,
  mcpServerPage,
  bookingApiPage,
  openSourcePage,
  useCasesHub,
  ...useCasePages,
  compareHub,
  ...comparePages,
  aboutPage,
];
