// Mock data — challenger-brand context (DTC, sustainability, niche fitness, indie beauty)
// The "brand under analysis" is a fictional sustainable activewear brand, "Loftway".

const INITIAL_SOURCES = [
  {
    id: 's1',
    type: 'pdf',
    title: 'Loftway_Brand_Positioning_2026.pdf',
    meta: '14 pages · uploaded 2 min ago',
    snippet: '"…we exist for runners who don\'t identify as athletes. Our buyer is the 32-year-old who started running during the pandemic and wants kit that doesn\'t scream Strava."',
  },
  {
    id: 's2',
    type: 'url',
    title: 'tracksmith.com/about',
    meta: 'tracksmith.com · competitor',
    snippet: 'Heritage running brand. Premium positioning ($88 tee, $148 short). Anchors on "amateur spirit" and Boston/New England running culture. Strong editorial content moat.',
  },
  {
    id: 's3',
    type: 'paste',
    title: 'Pasted: Q1 customer interview transcript',
    meta: '1,840 words · pasted 8 min ago',
    snippet: '"I asked ChatGPT for sustainable running shorts under $80 and it just gave me Patagonia and Girlfriend Collective. I\'d never heard of half the brands my friends actually wear."',
  },
  {
    id: 's4',
    type: 'db',
    title: 'AEO Benchmark — Activewear Category',
    meta: 'Internal database · 1.2k queries',
    snippet: 'Across 1,247 buyer-intent prompts in activewear, 6 brands captured 71% of mentions. Long-tail challengers appeared in <4% of "best for…" queries.',
  },
];

const INITIAL_MESSAGES = [
  {
    id: 'm1', role: 'agent', time: '2:14 PM',
    text: "I've taken a first pass at your four sources. Before I generate the prompt portfolio, I want to make sure I have the positioning right.",
  },
  {
    id: 'm2', role: 'agent', time: '2:14 PM',
    text: "From the brand brief, Loftway is going after runners who don't see themselves as athletes — late-starters, casual milers, post-pandemic adopters. Is that still the wedge, or has it broadened since the brief was written?",
  },
  {
    id: 'm3', role: 'user', time: '2:16 PM',
    text: "Still the wedge. We've leaned harder into it actually — the new SS26 line is built around 5K and 10K runners specifically, not marathon types.",
  },
  {
    id: 'm4', role: 'agent', time: '2:16 PM',
    text: "Good. That sharpens the prompt set considerably. One competitor signal worth flagging: in the Tracksmith source, their content moat is heritage and Boston-marathon adjacency. You'll want to avoid colliding head-on there. Where do you see your strongest gap?",
  },
  {
    id: 'm5', role: 'user', time: '2:18 PM',
    text: "Sustainability + sub-$100 price point. Tracksmith is $148 for shorts. We're $74. And we're using recycled ocean plastic for the entire SS26 line.",
  },
  {
    id: 'm6', role: 'agent', time: '2:18 PM',
    text: "That's the angle. I've drafted twelve prompts in the right column — six head-on category queries (\"best running shorts under $80\"), four buyer-persona queries (\"running gear for beginners who hate looking athletic\"), and two competitor-comparison queries. Want me to add a sustainability cluster?",
  },
];

const INITIAL_PROMPTS = [
  { id: 'p1',  cluster: 'Category',     text: "Best running shorts for women under $80",                            hits: 3, intent: 'High' },
  { id: 'p2',  cluster: 'Category',     text: "Sustainable activewear brands made from recycled ocean plastic",     hits: 1, intent: 'High' },
  { id: 'p3',  cluster: 'Category',     text: "Running clothes that don't look like running clothes",               hits: 0, intent: 'Med'  },
  { id: 'p4',  cluster: 'Category',     text: "Affordable alternatives to Tracksmith",                              hits: 2, intent: 'High' },
  { id: 'p5',  cluster: 'Category',     text: "Best 5K training kit under $200 total",                              hits: 0, intent: 'Med'  },
  { id: 'p6',  cluster: 'Category',     text: "Minimalist running apparel that's actually durable",                 hits: 1, intent: 'Med'  },
  { id: 'p7',  cluster: 'Persona',      text: "Running gear for beginners who hate looking athletic",               hits: 0, intent: 'High' },
  { id: 'p8',  cluster: 'Persona',      text: "What should I wear for my first 10K — I'm not a real runner",        hits: 0, intent: 'High' },
  { id: 'p9',  cluster: 'Persona',      text: "Activewear for women in their 30s who started running recently",     hits: 1, intent: 'Med'  },
  { id: 'p10', cluster: 'Persona',      text: "Comfortable running shorts that don't ride up — not for athletes",   hits: 0, intent: 'High' },
  { id: 'p11', cluster: 'Comparison',   text: "Tracksmith vs sustainable challenger brands",                        hits: 0, intent: 'Med'  },
  { id: 'p12', cluster: 'Comparison',   text: "Patagonia running shorts vs newer sustainable alternatives",          hits: 2, intent: 'Med'  },
];

const PROMPT_FILTERS = ['All', 'Category', 'Persona', 'Comparison'];

const SOURCE_TYPES = {
  pdf:   { label: 'PDF',       icon: 'pdf',     dot: 'oklch(62% 0.14 25)'  },
  url:   { label: 'URL',       icon: 'globe',   dot: 'oklch(60% 0.10 240)' },
  paste: { label: 'Pasted',    icon: 'quote',   dot: 'oklch(60% 0.10 150)' },
  db:    { label: 'Database',  icon: 'database',dot: 'oklch(55% 0.10 300)' },
};

Object.assign(window, { INITIAL_SOURCES, INITIAL_MESSAGES, INITIAL_PROMPTS, PROMPT_FILTERS, SOURCE_TYPES });
