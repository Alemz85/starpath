/**
 * seed.mjs — the fictional demo workspace, as data.
 *
 * Everything here is invented: the persona, her schools and employers, every
 * company (Microsoft-style fictional names), every person, URL and number.
 * scripts/demo/build-demo.mjs turns it into demo/ through the real scoring
 * engine (scripts/score-listing.mjs), so Match / Ease / verdict / tier always
 * match the current rubric. The seed only holds the agent's side of an
 * evaluation: JD facts, integer judgment scores and the prose that explains
 * them.
 *
 * Dates are day offsets from the build's as-of date (negative = past), so a
 * rebuild never looks stale. `expect` is the verdict the prose was written
 * for; the build fails if the engine disagrees (a rubric change moved the
 * listing and its prose needs a look).
 *
 * Bump SEED_VERSION whenever this file changes in a way that changes output.
 */

export const SEED_VERSION = 1

// ── Persona ──────────────────────────────────────────────────────────────────

export const persona = {
  name: 'Elise Varden',
  first: 'Elise',
  email: 'elise.varden@example.com',
  nationality: 'Belgium',
  base: 'Lyon, France',
  portfolio: 'https://example.com/elise-varden',
  linkedin: 'linkedin.com/in/example',
  languages: [
    { language: 'French', level: 'native', label: 'Native' },
    { language: 'English', level: 'C2', label: 'C2' },
    { language: 'Dutch', level: 'B2', label: 'B2' },
    { language: 'German', level: 'B1', label: 'B1' },
    { language: 'Portuguese', level: 'A2', label: 'A2' },
  ],
  msc: { degree: 'MSc in Business Analytics', school: 'Northfield Business School', city: 'Lyon, France' },
  bsc: { degree: 'BSc in Economics', school: 'Lakeside University', city: 'Ghent, Belgium' },
  internship: { title: 'Commercial Analytics Intern', org: 'Adventure Works', city: 'Lyon, France' },
  capstonePartner: 'Coho Winery',
  society: 'Northfield Analytics Society',
}

// Ordered by preference; City scores in the listings follow this order.
export const preferredCities = ['Lyon', 'Vienna', 'Munich', 'Prague', 'Brussels', 'Porto']

export const archetypes = [
  { name: 'Pricing & Commercial Analytics', level: 'Entry/Junior', fit: 'primary',
    axes: 'Price elasticity, promotions, markdowns, deal and margin analysis',
    buys: 'A thesis on private-label price elasticity and a markdown model that went live in an internship' },
  { name: 'Business / Data Analyst', level: 'Entry/Junior', fit: 'primary',
    axes: 'SQL, reporting, dashboards, decision support for a business team',
    buys: 'Clean SQL and Python, plus the habit of ending every analysis with a recommendation' },
  { name: 'Strategy & Operations', level: 'Entry/Junior', fit: 'primary',
    axes: 'Business cases, KPI design, planning and operating reviews',
    buys: 'Economics training and forecasting work that fed a real production plan' },
  { name: 'Graduate / Rotational Programme', level: 'Entry', fit: 'primary',
    axes: 'Analytics, strategy or commercial programmes with rotations',
    buys: 'A recent master’s graduate who has already worked on live company data',
    keywords: ['graduate programme', 'graduate program', 'rotational', 'trainee', 'early careers'] },
  { name: 'Product Analytics', level: 'Entry/Junior', fit: 'secondary',
    axes: 'Funnels, experiments, product metrics',
    buys: 'Experiment-design coursework and strong statistics' },
  { name: 'Marketing Analytics', level: 'Entry/Junior', fit: 'secondary',
    axes: 'Campaign measurement, segmentation, CRM analytics',
    buys: 'Customer segmentation from the capstone; comfortable with messy commercial data' },
]

export const calibration = {
  dream_companies: ['Northwind Analytics'],
  lower_tier_dream_companies: ['Contoso', 'Tailspin Toys'],
  brand_affinity_companies: ['Woodgrove Bank', 'Fabrikam'],
  extra_brand_bonuses: [
    { company: 'Lumen Freight', bonus: 0.5, reason: 'better known to Lyon logistics recruiters than its size suggests' },
  ],
  has_structured_onboarding: false,
}

// ── Demo location tables (illustrative values, not tax advice) ──────────────
// tax: effective rate by gross band (EUR, the band is gross rounded to €5K;
// the first band at or above the listing's band wins, else the last one).

export const places = {
  Lyon:       { country: 'FR', countryName: 'France',   baseline: 1700, tax: [[30000, 0.22], [35000, 0.23], [40000, 0.245], [45000, 0.255], [50000, 0.27], [55000, 0.28]] },
  Toulouse:   { country: 'FR', countryName: 'France',   baseline: 1550, tax: [[30000, 0.22], [35000, 0.23], [40000, 0.245]] },
  Vienna:     { country: 'AT', countryName: 'Austria',  baseline: 1850, tax: [[40000, 0.27], [45000, 0.29], [50000, 0.31], [55000, 0.32]] },
  Munich:     { country: 'DE', countryName: 'Germany',  baseline: 2300, tax: [[45000, 0.32], [50000, 0.335], [55000, 0.345]] },
  Prague:     { country: 'CZ', countryName: 'Czechia',  baseline: 1400, tax: [[25000, 0.22], [30000, 0.225], [35000, 0.23]] },
  Brussels:   { country: 'BE', countryName: 'Belgium',  baseline: 1800, tax: [[40000, 0.34], [45000, 0.355], [50000, 0.365]] },
  Porto:      { country: 'PT', countryName: 'Portugal', baseline: 1250, tax: [[20000, 0.19], [25000, 0.21], [30000, 0.235]] },
  Manchester: { country: 'GB', countryName: 'the United Kingdom', baseline: null, tax: [] },
}

// Title filter for user/portals.yml; the inbox's relevance notes are derived
// from it the way scan.mjs words them.
export const titleFilter = {
  positive: ['Pricing', 'Revenue', 'Analyst', 'Business Analyst', 'Data Analyst', 'Analytics', 'Insights', 'Strategy', 'Operations',
    'Planning', 'Graduate', 'Graduate Programme', 'Rotational', 'Trainee', 'Associate', 'Junior'],
  negative: ['Senior', 'Sr.', 'Principal', 'Staff', 'Lead', 'Head of', 'Director', 'VP', 'Software Engineer', 'Data Engineer',
    'Audit', 'Tax', 'Payroll', 'Clinical', 'Graphic Designer'],
  seniority_boost: ['Junior', 'Graduate', 'Associate', 'Analyst', 'Trainee'],
}

// Scanner runs, as day offsets. The last one is "yesterday's" scan.
export const scanRuns = [-44, -40, -37, -33, -30, -26, -23, -19, -16, -12, -9, -5, -1]

// ── Network, outreach, follow-ups ───────────────────────────────────────────

export const network = [
  { name: 'Inès Moreau', company: 'Northwind Analytics', title: 'Senior Analyst', relationship: 'strong', degree: 1, via: '', last: -6,
    notes: 'Northfield alumna, one cohort ahead of you; referred you for the graduate programme' },
  { name: 'Tomas Kral', company: 'Wingtip Labs', title: 'Product Analytics Lead', relationship: 'medium', degree: 1, via: '', last: -8,
    notes: 'Met at a Prague analytics meetup; sits next to the hiring team' },
  { name: 'Lukas Weber', company: 'Adventure Works', title: 'Pricing Manager', relationship: 'strong', degree: 1, via: '', last: -14,
    notes: 'Your internship manager; happy to be a reference' },
  { name: 'Sofia Brandt', company: 'Fabrikam', title: 'Supply Chain Planning Manager', relationship: 'weak', degree: 2, via: 'Lukas Weber', last: null,
    notes: 'Former colleague of Lukas; owns the supply-chain analyst hire' },
  { name: 'Hannah Peeters', company: 'Woodgrove Bank', title: 'Graduate Recruiter', relationship: 'medium', degree: 1, via: '', last: -25,
    notes: 'Met at the Northfield careers fair' },
  { name: 'Julien Faure', company: 'Lumen Freight', title: 'Network Planning Lead', relationship: 'medium', degree: 1, via: '', last: -50,
    notes: 'Guest lecturer in your logistics elective; offered to answer questions about the team' },
]

export const outreach = [
  { d: -34, company: 'Woodgrove Bank', role: 'Data & Strategy Graduate Programme', contact: 'Hannah Peeters', title: 'Recruiter', channel: 'Email', touch: 1,
    outcome: 'Pending', notes: 'Asked whether a pricing thesis fits the data track' },
  { d: -31, company: 'Northwind Analytics', role: 'Graduate Analyst Programme', contact: 'Inès Moreau', title: 'Peer', channel: 'Message', touch: 1,
    outcome: 'Replied — call booked, referral submitted', notes: 'Asked how the case round works' },
  { d: -27, company: 'Woodgrove Bank', role: 'Data & Strategy Graduate Programme', contact: 'Hannah Peeters', title: 'Recruiter', channel: 'Email', touch: 2,
    outcome: 'Replied — cohort is full, invited to reapply next intake', notes: 'Keep warm for the next intake' },
  { d: -9, company: 'Fabrikam', role: 'Business Analyst, Supply Chain', contact: 'Sofia Brandt', title: 'Hiring Manager', channel: 'Connection', touch: 1,
    outcome: 'Pending', notes: 'Mentioned Lukas in the note' },
  { d: -8, company: 'Wingtip Labs', role: 'Product Analyst', contact: 'Tomas Kral', title: 'Peer', channel: 'Message', touch: 1,
    outcome: 'Pending', notes: 'Asked how the team runs experiments' },
  { d: -3, company: 'Contoso', role: 'Strategy & Operations Analyst', contact: 'Clara Hofer', title: 'Recruiter', channel: 'Email', touch: 1,
    outcome: 'Pending', notes: 'Asked for the start date and the answer deadline on the offer' },
]

// appId refers to the application `id` below.
export const followUps = [
  { d: -34, appId: 'contoso-soa', channel: 'Email', contact: 'clara.hofer@example.com', notes: 'Thank-you note after the case interview' },
  { d: -16, appId: 'northwind-gap', channel: 'Email', contact: 'paul.girard@example.com', notes: 'Confirmed the case-round slot' },
  { d: -13, appId: 'wingtip-pa', channel: 'Email', contact: 'recruiting.prague@example.com', notes: 'Sent availability for the recruiter screen' },
]

// ── Listings ────────────────────────────────────────────────────────────────
//
// Shared shape (T4 listings use a subset):
//   id, company, role, archetype, city, location, remote, employment
//   (eligibility facts), employmentType (score-history), duration, seen /
//   evaluated (day offsets), lastSeen (optional), portal, jobId, source,
//   deadline (offset | 'Rolling' | 'n/d'), comp, compSource, salaryRaw,
//   soft, intern, onboarding, referral, facts (eligibility facts, dates as
//   offsets: start.in days, graduation.fromMonths / toMonths), scores
//   (judgment integers), expect (verdict), note (scouting Notes cell),
//   reasons (dimension cells), elig (Eligibility-row overrides), report.

const j = (growth_mobility, optionality_exit, brand_value, role_content, best_cities, work_life_balance, skills_match, experience_bar, competition) =>
  ({ growth_mobility, optionality_exit, brand_value, role_content, best_cities, work_life_balance, skills_match, experience_bar, competition })

const EN_C1 = { language: 'English', level: 'C1', required: true }

export const listings = [
  // ── 1 · Contoso · go → Offer ──────────────────────────────────────────────
  {
    id: 'contoso-soa', company: 'Contoso', role: 'Strategy & Operations Analyst',
    archetype: 'Strategy & Operations', city: 'Vienna', location: 'Vienna, Austria', remote: 'hybrid, three office days',
    employment: 'permanent', employmentType: 'full-time', duration: 'permanent',
    seen: -44, evaluated: -43, lastSeen: -23, portal: 'greenhouse-api', jobId: 4417, source: 'scan', deadline: 'n/d',
    comp: { base: 46000 }, compSource: 'disclosed', salaryRaw: '€46,000 (14 salaries)', soft: 0.3,
    facts: { languages: [EN_C1, { language: 'German', level: 'B2', required: false }], country: 'AT' },
    scores: j(8, 8, 7, 9, 8, 7, 8, 8, 6), expect: 'go',
    note: 'Real strategy seat with a ladder in Vienna; lead with the markdown model',
    reasons: {
      growth_mobility: 'A named step from analyst to senior analyst after 18 to 24 months, and analysts rotate across the regional business units.',
      optionality_exit: 'Operating-model and cost work at a well-known industrial group travels well, both into consulting and into in-house strategy teams.',
      brand_value: 'Recruiters across Central Europe know the name, but it won’t open doors on its own the way a global consultancy would.',
      role_content: 'Almost all of it is the work you want: business cases, KPI design and the quarterly review pack for the regional leadership team, with some meeting coordination around the reviews.',
      best_cities: 'Vienna is second on your list, and the role is hybrid with three office days.',
      work_life_balance: 'They describe a 40-hour week with heavier weeks around the quarterly reviews; nothing points to a crunch culture.',
      match: 'Carried by the work itself and a company you already rate highly',
      skills_match: 'Excel modelling, SQL and a dashboard tool are all on your CV. The one gap is the cost-allocation work they mention, which you have only met in coursework.',
      experience_bar: 'They want zero to one year and a relevant internship, which your six months at Adventure Works covers.',
      competition: 'A recognisable employer with one seat in Vienna, so expect a big pool of business-school graduates, and nothing in the posting gives you a special channel.',
      ease: 'Held up by a clean skills fit; the crowd is the main drag',
      best_fit: 'Strategy & Operations Analyst; Business Analyst, Finance Transformation; Operations Analyst, Shared Services',
    },
    report: {
      summary: {
        domain: 'Industrial and facility services group',
        function: 'Business cases, KPI design and the quarterly performance pack for the Central Europe leadership team',
        seniority: 'Entry level, permanent',
        remote: 'Hybrid, three office days in Vienna',
        tldr: 'A genuine strategy-and-operations seat with a ladder, in your second-favourite city.',
      },
      gaps: '**Cost allocation.** They want someone who can "build and maintain cost-allocation models for shared services". You have built pricing and forecasting models, not allocation keys, but the logic is the same: drivers, assumptions and a reconciliation back to the ledger. Rebuilding one coursework model as an allocation model over a weekend, with a one-page note on the assumptions, gives you something concrete to walk through in the case round.\n\nNothing else here needs closing before you apply.',
      comp: { source: 'Disclosed in the posting', band: '€46K gross a year, paid in 14 instalments', note: 'About {savings} a month left after Vienna living costs, before the two home-office days and the learning budget they list.' },
      recommendation: 'Apply this week and lead with the markdown-pricing model from your internship: it shows you can turn a model into a decision a business team acts on, which is exactly what the quarterly pack is for. The odds are decent rather than high because of the size of the pool, so rewrite the top third of your CV in operations language before you send it.',
      career: 'Two years here give you the planning and operating-model vocabulary that consulting and in-house strategy roles screen for, without leaving your target region. It does pull you a little away from pricing; if pricing stays your first choice, treat this as the broader door rather than the narrower one.',
    },
  },

  // ── 2 · Wide World Importers · skip ───────────────────────────────────────
  {
    id: 'wwi-isa', company: 'Wide World Importers', role: 'Inside Sales Analyst',
    archetype: 'Sales / Business Development', city: 'Lyon', location: 'Lyon, France',
    employment: 'permanent', employmentType: 'full-time', duration: 'permanent',
    seen: -44, evaluated: -43, portal: 'lever-api', jobId: 2290, source: 'scan', deadline: 'Rolling',
    comp: { base: 34000, bonusPct: 0.10 }, compSource: 'disclosed', salaryRaw: '€34,000 + up to 10% commission', soft: 0,
    facts: { languages: [{ language: 'French', level: 'C1', required: true }, { language: 'English', level: 'B2', required: true }], country: 'FR' },
    scores: j(6, 5, 5, 3, 9, 6, 7, 9, 8), expect: 'skip',
    note: 'T4 skip — about two-thirds of the week is outbound calling; the analysis is a side task',
  },

  // ── 3 · Woodgrove Bank · stretch → Rejected ───────────────────────────────
  {
    id: 'woodgrove-dsgp', company: 'Woodgrove Bank', role: 'Data & Strategy Graduate Programme',
    archetype: 'Graduate / Rotational Programme', city: 'Brussels', location: 'Brussels, Belgium', remote: 'hybrid, two office days',
    employment: 'graduate_programme', employmentType: 'graduate-program', duration: '24mo',
    seen: -40, evaluated: -39, lastSeen: -30, portal: 'smartrecruiters-api', jobId: 7731, source: 'scan', deadline: -30,
    comp: { base: 43000, thirteenthMonthMonths: 1, benefitsMonthlyEur: 160 }, compSource: 'disclosed', salaryRaw: '€43,000 + 13th month + meal vouchers', soft: 0.5, onboarding: true,
    facts: {
      start: { in: 75, flexible: false }, duration_months: 24,
      graduation: { fromMonths: -24, toMonths: 6, soft: false },
      languages: [EN_C1, { language: 'French', level: 'B2', required: true }], country: 'BE',
    },
    scores: j(9, 8, 8, 7, 7, 6, 8, 8, 4), expect: 'stretch',
    note: 'Guaranteed two-year path at a bank everyone recognises; the crowd is the hurdle',
    elig: { graduation: 'They take graduates from the last two years; your MSc is inside that window' },
    reasons: {
      growth_mobility: 'A two-year programme with four rotations, formal training weeks and a guaranteed role at the end.',
      optionality_exit: 'A bank’s data and strategy programme travels well into consulting, fintech and other banks.',
      brand_value: 'One of the best-known banks in Benelux, recognised by recruiters across Europe.',
      role_content: 'Mostly analysis, but two of the four rotations sit in operations teams with a reporting focus.',
      best_cities: 'Brussels is on your list, lower down; the programme is hybrid.',
      work_life_balance: 'Normal banking hours, with longer weeks during the training blocks.',
      match: 'Carried by the programme structure and the brand',
      skills_match: 'Python, SQL and statistics are covered; they would like some exposure to credit risk, which you don’t have.',
      experience_bar: 'Built for recent master’s graduates, and you fit the profile.',
      competition: 'A big-name graduate scheme with thousands of applicants for about fifteen seats, and they prefer candidates with a finance internship, which you don’t have.',
      ease: 'Held down by the size of the applicant pool',
      best_fit: 'Data & Strategy Graduate Programme; Graduate Analyst, Payments Strategy',
    },
    report: {
      strongest: 'A guaranteed two-year path through data and strategy teams, at a bank recruiters everywhere recognise.',
      biggest: 'The crowd. Thousands apply, and they say they prefer a previous finance internship, which your CV doesn’t show.',
      recommendation: 'Stretch — apply, but first make your finance angle visible: your thesis is about pricing, and a bank prices products too.',
      path: 'Rewrite your CV summary so the thesis and the forecasting capstone read as finance-relevant work before you submit.',
    },
  },

  // ── 4 · Fourth Coffee · skip ──────────────────────────────────────────────
  {
    id: 'fourth-coffee-rot', company: 'Fourth Coffee', role: 'Retail Operations Trainee',
    archetype: 'Graduate / Rotational Programme', city: 'Porto', location: 'Porto, Portugal',
    employment: 'graduate_programme', employmentType: 'graduate-program', duration: '12mo',
    seen: -40, evaluated: -39, portal: 'ashby-api', jobId: 1185, source: 'scan', deadline: 'Rolling',
    comp: { base: 21000 }, compSource: 'disclosed', salaryRaw: '€21,000', soft: 0,
    facts: { start: { in: 30, flexible: true }, duration_months: 12, languages: [{ language: 'Portuguese', level: 'B2', required: false }, { language: 'English', level: 'B2', required: true }], country: 'PT' },
    scores: j(5, 4, 5, 4, 7, 4, 7, 9, 7), expect: 'skip',
    note: 'T4 skip — store-operations rotations on weekend shifts; little analysis and a thin salary',
  },

  // ── 5 · Trey Research · skip ──────────────────────────────────────────────
  {
    id: 'trey-ra', company: 'Trey Research', role: 'Research Assistant, Consumer Insights',
    archetype: 'Market Research', city: 'Toulouse', location: 'Toulouse, France',
    employment: 'fixed_term', employmentType: 'contract', duration: '12mo',
    seen: -37, evaluated: -36, portal: 'lever-api', jobId: 3302, source: 'scan', deadline: 'n/d',
    comp: { base: 28000 }, compSource: 'disclosed', salaryRaw: '€28,000', soft: 0,
    facts: { start: { in: 20, flexible: false }, duration_months: 12, languages: [{ language: 'French', level: 'C1', required: true }], country: 'FR' },
    scores: j(4, 5, 4, 6, 6, 7, 8, 9, 7), expect: 'skip',
    note: 'T4 skip — a one-year survey-coding contract with no path after it',
  },

  // ── 6 · Alpine Ski House · growth ─────────────────────────────────────────
  {
    id: 'alpine-csa', company: 'Alpine Ski House', role: 'Corporate Strategy Associate',
    archetype: 'Strategy & Operations', city: 'Vienna', location: 'Vienna, Austria', remote: 'hybrid',
    employment: 'permanent', employmentType: 'full-time', duration: 'permanent',
    seen: -37, evaluated: -36, portal: 'greenhouse-api', jobId: 5520, source: 'scan', deadline: 'Rolling',
    comp: { base: 55000 }, compSource: 'estimate', salaryRaw: 'n/d', soft: 0,
    compBand: { min: 50000, max: 60000, confidence: 'medium' },
    facts: { languages: [EN_C1], country: 'AT' },
    scores: j(9, 9, 7, 9, 8, 5, 7, 3, 4), expect: 'growth',
    note: 'The strategy seat you want in five years; they hire from consultancies with two to three years behind them',
    reasons: {
      growth_mobility: 'A small corporate strategy team reporting to the executive board, with a known track into business-unit leadership.',
      optionality_exit: 'Corporate strategy at a well-run leisure group leads to consulting, investment portfolio roles and strategy jobs almost anywhere.',
      brand_value: 'A recognised leisure and travel group in the Alps and Central Europe.',
      role_content: 'Pure strategy work: market-entry cases, acquisition screening and the annual strategic plan.',
      best_cities: 'Vienna is second on your list.',
      work_life_balance: 'Board deadlines and acquisition work mean long weeks at regular intervals.',
      match: 'Carried by the work and where it leads',
      skills_match: 'Your modelling and analysis fit; they want valuation and deal-screening experience you don’t have yet.',
      experience_bar: 'They ask for two to three years in strategy consulting or corporate development.',
      competition: 'A small, sought-after team that mostly hires from consultancies.',
      ease: 'Held down by the years of experience they ask for',
      best_fit: 'Revenue Management Analyst; Corporate Strategy Associate, once you have the years',
    },
    report: {
      gap: 'Experience. They ask for "two to three years in strategy consulting or corporate development", and your CV shows one internship. That is a wall, not a skills gap: no course closes it.',
      revisit: 'Once your CV shows about two years in a strategy, pricing or planning role, ideally with one market-entry or acquisition case you can talk through in detail.',
    },
  },

  // ── 7 · First Up Consultants · blocked (work rights) ──────────────────────
  {
    id: 'firstup-gba', company: 'First Up Consultants', role: 'Graduate Business Analyst',
    archetype: 'Business / Data Analyst', city: 'Manchester', location: 'Manchester, United Kingdom',
    employment: 'permanent', employmentType: 'full-time', duration: 'permanent',
    seen: -33, evaluated: -33, portal: 'greenhouse-api', jobId: 6014, source: 'scan', deadline: 'n/d',
    salaryRaw: '£31,000',
    facts: { country: 'GB', work_auth: { requires_existing_right: true, sponsorship: 'not_offered' } },
    expect: 'blocked',
  },

  // ── 8 · Northwind Analytics · go → Interview (dream company) ─────────────
  {
    id: 'northwind-gap', company: 'Northwind Analytics', role: 'Graduate Analyst Programme',
    archetype: 'Graduate / Rotational Programme', city: 'Lyon', location: 'Lyon, France', remote: 'hybrid',
    employment: 'graduate_programme', employmentType: 'graduate-program', duration: '24mo',
    seen: -33, evaluated: -32, portal: 'url', jobId: 1042, source: 'url', deadline: 'Rolling',
    comp: { base: 41000, bonusPct: 0.05 }, compSource: 'disclosed', salaryRaw: '€41,000 + 5% bonus', soft: 0.5, onboarding: true, referral: 'warm-direct',
    facts: {
      start: { in: 40, flexible: false }, duration_months: 24,
      graduation: { fromMonths: -24, toMonths: 8, soft: true },
      languages: [EN_C1, { language: 'French', level: 'B2', required: true }], country: 'FR',
    },
    scores: j(9, 8, 7, 8, 9, 7, 7, 8, 7), expect: 'go',
    note: 'Dream company, your city, a programme built for your stage; Inès referred you',
    elig: { graduation: 'They want graduates from the last two years, ideally; your MSc is well inside that' },
    reasons: {
      growth_mobility: 'A two-year programme with three rotations, a named mentor and a promotion review at the end: the most structured path in your pipeline.',
      optionality_exit: 'Rotations across client analytics, pricing and data products leave you with skills every analytics employer in your target cities hires for.',
      brand_value: 'Well known to analytics recruiters in France and Benelux, less so further east.',
      role_content: 'Most rotations are hands-on analysis; expect some client presentations and internal training in the first months.',
      best_cities: 'Lyon is your first-choice city, and you already live there.',
      work_life_balance: 'Normal programme hours, with heavier weeks before client deliveries.',
      match: 'Carried by the programme structure and the Lyon base',
      skills_match: 'Python, SQL and a dashboard tool are covered; they also list dbt, where you only have the basics.',
      experience_bar: 'Built for recent graduates, and your internship and capstone are the profile they describe.',
      competition: 'A popular programme with a cohort of about twelve, and Northfield is one of their main recruiting schools. Inès’s referral puts your application in front of the team directly.',
      ease: 'Strong all round, helped by the referral',
      best_fit: 'Graduate Analyst Programme; Data Analyst, Customer Insights; Analytics Engineer, Junior',
    },
    report: {
      summary: {
        domain: 'Analytics consultancy and data products',
        function: 'Three eight-month rotations across client analytics, pricing and data products',
        seniority: 'Graduate programme, 24-month contract converting to permanent',
        remote: 'Hybrid, Lyon office',
        tldr: 'Your first-choice company, in your city, with a structure built for exactly your stage.',
      },
      gaps: '**dbt.** They list "experience with dbt or a similar transformation tool" as preferred, and you have used it in one course project. Rebuild the capstone’s data preparation as a small dbt project over a weekend and link it from your CV; it turns a preferred skill into something you can show.\n\nThe case round is the other thing to prepare for, but that is preparation, not a gap.',
      comp: { source: 'Disclosed in the posting', band: '€41K gross a year plus a 5% bonus', note: 'About {savings} a month left after Lyon living costs; the programme also pays for one certification a year.' },
      recommendation: 'Apply now, through Inès’s referral rather than the portal, and say in your note which rotation you would pick first. You match the profile they describe, so what decides this is the case round: practise a pricing case and a forecasting case out loud before the first interview.',
      career: 'This is the most direct route to leading a pricing or analytics team, your stated long-term aim: three rotations for breadth, then a permanent seat at a company you would stay with. The trade-off is two years on a programme salary, which your Lyon budget absorbs.',
    },
  },

  // ── 9 · Margie's Travel · skip ────────────────────────────────────────────
  {
    id: 'margies-csa', company: "Margie's Travel", role: 'Customer Success Associate',
    archetype: 'Customer Success', city: 'Brussels', location: 'Brussels, Belgium',
    employment: 'permanent', employmentType: 'full-time', duration: 'permanent',
    seen: -30, evaluated: -29, portal: 'ashby-api', jobId: 8840, source: 'scan', deadline: 'n/d',
    comp: { base: 38000 }, compSource: 'disclosed', salaryRaw: '€38,000', soft: 0,
    facts: { languages: [{ language: 'French', level: 'C1', required: true }, { language: 'Dutch', level: 'B2', required: true }], country: 'BE' },
    scores: j(6, 5, 5, 4, 7, 7, 8, 9, 7), expect: 'skip',
    note: 'T4 skip — account support with a reporting label; the analysis is a monthly slide',
  },

  // ── 10 · Adatum · thin → Discarded ────────────────────────────────────────
  {
    id: 'adatum-jda', company: 'Adatum', role: 'Junior Data Analyst',
    archetype: 'Business / Data Analyst', city: 'Vienna', location: 'Vienna, Austria', remote: 'on-site',
    employment: 'permanent', employmentType: 'full-time', duration: 'permanent',
    seen: -30, evaluated: -29, lastSeen: -12, portal: 'lever-api', jobId: 2716, source: 'scan', deadline: 'n/d',
    comp: { base: 41000 }, compSource: 'disclosed', salaryRaw: '€41,000', soft: 0,
    facts: { languages: [{ language: 'English', level: 'B2', required: true }, { language: 'German', level: 'B1', required: false }], country: 'AT' },
    scores: j(6, 7, 6, 8, 8, 7, 7, 6, 6), expect: 'thin',
    note: 'Straightforward SQL seat in Vienna; no path beyond it',
    reasons: {
      growth_mobility: 'Growth depends on the team; the posting describes the job but no path beyond it.',
      optionality_exit: 'Reporting and SQL skills transfer, though the domain is narrow.',
      brand_value: 'A solid mid-sized employer, known in Austria.',
      role_content: 'Mostly SQL reporting and ad-hoc analysis for the sales team.',
      best_cities: 'Vienna is second on your list.',
      work_life_balance: 'Standard hours, nothing unusual either way.',
      match: 'Fair across the board, with nothing that makes it stand out',
      skills_match: 'SQL and Excel are covered; they want their BI platform’s scripting language, which you haven’t used.',
      experience_bar: 'They would like a year of reporting experience, and you have a six-month internship.',
      competition: 'One seat with a moderate pool.',
      ease: 'Middling: a partial match on skills and on experience',
      best_fit: 'Junior Data Analyst; BI Analyst',
    },
    report: {
      strongest: 'A Vienna analyst seat with plain, hands-on SQL work.',
      biggest: 'There is no visible path beyond the job, and they want a year of reporting experience you don’t quite have.',
      recommendation: 'Only if your pipeline is thin: keep it as the fallback if the Contoso process stalls, since both are in Vienna and Contoso is the better seat.',
      path: 'Wait for the Contoso outcome before you spend time on this application.',
    },
  },

  // ── 11 · VanArsdel · skip ─────────────────────────────────────────────────
  {
    id: 'vanarsdel-sdr', company: 'VanArsdel', role: 'Business Development Analyst',
    archetype: 'Sales / Business Development', city: 'Munich', location: 'Munich, Germany',
    employment: 'permanent', employmentType: 'full-time', duration: 'permanent',
    seen: -26, evaluated: -25, portal: 'greenhouse-api', jobId: 9113, source: 'scan', deadline: 'Rolling',
    comp: { base: 42000, bonusPct: 0.25 }, compSource: 'disclosed', salaryRaw: '€42,000 + 25% on-target commission', soft: 0,
    facts: { languages: [{ language: 'English', level: 'C2', required: true }], country: 'DE' },
    scores: j(6, 5, 6, 2, 8, 5, 7, 9, 7), expect: 'skip',
    note: 'T4 skip — a cold-outreach quota seat with an analytics label',
  },

  // ── 12 · Lucerne Publishing · skip ────────────────────────────────────────
  {
    id: 'lucerne-mc', company: 'Lucerne Publishing', role: 'Marketing Operations Coordinator',
    archetype: 'Marketing Analytics', city: 'Lyon', location: 'Lyon, France',
    employment: 'permanent', employmentType: 'full-time', duration: 'permanent',
    seen: -26, evaluated: -25, portal: 'ashby-api', jobId: 4471, source: 'scan', deadline: 'n/d',
    comp: { base: 32000 }, compSource: 'disclosed', salaryRaw: '€32,000', soft: 0,
    facts: { languages: [{ language: 'French', level: 'C1', required: true }], country: 'FR' },
    scores: j(5, 5, 5, 4, 9, 7, 7, 9, 6), expect: 'skip',
    note: 'T4 skip — events and newsletters; the analytics is one KPI slide a month',
  },

  // ── 13 · Wingtip Labs · stretch → Responded ───────────────────────────────
  {
    id: 'wingtip-pa', company: 'Wingtip Labs', role: 'Product Analyst',
    archetype: 'Product Analytics', city: 'Prague', location: 'Prague, Czechia', remote: 'remote-friendly',
    employment: 'permanent', employmentType: 'full-time', duration: 'permanent',
    seen: -23, evaluated: -22, portal: 'ashby-api', jobId: 3089, source: 'scan', deadline: 'n/d',
    comp: { base: 31000 }, compSource: 'disclosed', salaryRaw: '€31,000 + stock options', soft: 1.0,
    facts: { languages: [EN_C1], country: 'CZ' },
    scores: j(8, 8, 6, 9, 8, 8, 7, 6, 6), expect: 'stretch',
    note: 'Experiment and funnel work where analysts grow into product roles',
    reasons: {
      growth_mobility: 'A fast-growing product company that promotes from within; analysts move into product roles after a year or two.',
      optionality_exit: 'Product analytics at a growing software company opens doors at most tech employers in Europe.',
      brand_value: 'Known among software people in Central Europe, not much beyond.',
      role_content: 'Almost entirely the analysis you want: experiment design, funnel analysis and the weekly product-metrics review.',
      best_cities: 'Prague is on your list, and the team works mostly remotely around a Prague office.',
      work_life_balance: 'Flexible hours and remote-first; people describe a calm pace outside launch weeks.',
      match: 'Carried by the work and the growth path',
      skills_match: 'SQL and statistics are covered; they want hands-on product event data and an experimentation platform, which you have only seen in coursework.',
      experience_bar: 'They ask for a year of product or growth analytics, and your internship was commercial, not product.',
      competition: 'A popular employer with a single analyst seat and an open remote pool.',
      ease: 'Held down by the product experience they ask for',
      best_fit: 'Product Analyst; Growth Analyst',
    },
    report: {
      strongest: 'Day-to-day experiment and funnel work at a company where analysts grow into product roles.',
      biggest: 'They ask for a year of product analytics, and your experience is commercial. Your experiment-design coursework is the closest thing you have.',
      recommendation: 'Stretch — apply, but first build one small product-analytics example you can show.',
      path: 'Write up a funnel and A/B analysis on a public product dataset and link it in your application.',
    },
  },

  // ── 14 · Fabrikam · blocked (German C1) ───────────────────────────────────
  {
    id: 'fabrikam-jcm', company: 'Fabrikam', role: 'Junior Category Manager, DACH',
    archetype: 'Pricing & Commercial Analytics', city: 'Munich', location: 'Munich, Germany',
    employment: 'permanent', employmentType: 'full-time', duration: 'permanent',
    seen: -23, evaluated: -22, portal: 'smartrecruiters-api', jobId: 5306, source: 'scan', deadline: 'n/d',
    salaryRaw: 'n/d',
    facts: { languages: [{ language: 'German', level: 'C1', required: true }, EN_C1], country: 'DE' },
    expect: 'blocked',
  },

  // ── 15 · Nimbus Robotics · growth ─────────────────────────────────────────
  {
    id: 'nimbus-cea', company: 'Nimbus Robotics', role: 'Commercial Excellence Associate',
    archetype: 'Pricing & Commercial Analytics', city: 'Lyon', location: 'Lyon, France', remote: 'hybrid',
    employment: 'permanent', employmentType: 'full-time', duration: 'permanent',
    seen: -19, evaluated: -18, portal: 'greenhouse-api', jobId: 7212, source: 'scan', deadline: 'Rolling',
    comp: { base: 50000 }, compSource: 'estimate', salaryRaw: 'n/d', soft: 0,
    compBand: { min: 46000, max: 54000, confidence: 'medium' },
    facts: { languages: [EN_C1, { language: 'French', level: 'C1', required: true }], country: 'FR' },
    scores: j(8, 8, 7, 9, 9, 6, 8, 2, 5), expect: 'growth',
    note: 'B2B pricing in Lyon, three years too early',
    reasons: {
      growth_mobility: 'A commercial excellence team with a path to pricing manager, and they describe mentoring by the head of pricing.',
      optionality_exit: 'B2B pricing at an industrial robotics company is valued across manufacturing and software.',
      brand_value: 'A known name in industrial automation in France and Germany.',
      role_content: 'Mostly pricing and deal analysis: price-waterfall work, discount governance and margin reviews.',
      best_cities: 'Lyon, your first-choice city.',
      work_life_balance: 'Busy around the quarter-end deal reviews.',
      match: 'Carried by the pricing work in your own city',
      skills_match: 'Pricing analysis, Excel modelling and SQL are all on your CV.',
      experience_bar: 'They ask for three or more years in B2B pricing or commercial finance.',
      competition: 'A specialist role with a small pool, most of it more experienced than you.',
      ease: 'Held down by the years of experience they ask for',
      best_fit: 'Operations Strategy Analyst; Commercial Excellence Associate, once you have the years',
    },
    report: {
      gap: 'Years. They ask for "three or more years of B2B pricing or commercial finance", and you have a six-month internship. Your skills already fit; the experience is the wall.',
      revisit: 'After you clear about three years in a pricing role. A retail pricing seat like the Tailspin Toys one is exactly the experience they would want to see.',
    },
  },

  // ── 16 · Southridge Video · skip ──────────────────────────────────────────
  {
    id: 'southridge-coa', company: 'Southridge Video', role: 'Content Operations Analyst',
    archetype: 'Business / Data Analyst', city: 'Prague', location: 'Prague, Czechia',
    employment: 'permanent', employmentType: 'full-time', duration: 'permanent',
    seen: -19, evaluated: -18, portal: 'lever-api', jobId: 6650, source: 'scan', deadline: 'n/d',
    comp: { base: 27000 }, compSource: 'estimate', salaryRaw: 'n/d', soft: 0,
    compBand: { min: 25000, max: 29000, confidence: 'low' },
    facts: { languages: [EN_C1], country: 'CZ' },
    scores: j(6, 5, 5, 5, 8, 7, 8, 8, 7), expect: 'skip',
    note: 'T4 skip — metadata clean-up and scheduling with light reporting',
  },

  // ── 17 · Fabrikam · stretch (German amber) → Applied ─────────────────────
  {
    id: 'fabrikam-basc', company: 'Fabrikam', role: 'Business Analyst, Supply Chain',
    archetype: 'Business / Data Analyst', city: 'Munich', location: 'Munich, Germany', remote: 'hybrid, three office days',
    employment: 'permanent', employmentType: 'full-time', duration: 'permanent',
    seen: -16, evaluated: -15, portal: 'smartrecruiters-api', jobId: 5381, source: 'scan', deadline: 'Rolling',
    comp: { base: 54000 }, compSource: 'disclosed', salaryRaw: '€54,000', soft: 0.3,
    facts: { languages: [{ language: 'German', level: 'B2', required: true }, EN_C1], country: 'DE' },
    scores: j(8, 8, 8, 8, 8, 6, 8, 7, 5), expect: 'stretch',
    note: 'Forecasting and inventory work at a manufacturer every recruiter knows; check the German bar first',
    reasons: {
      growth_mobility: 'A large supply-chain organisation with regular internal moves between planning, procurement and logistics teams.',
      optionality_exit: 'Supply-chain analytics at a well-known manufacturer transfers to almost any industrial or retail employer.',
      brand_value: 'A household name in manufacturing, recognised by recruiters throughout Europe.',
      role_content: 'Mostly analysis: inventory models, supplier-performance dashboards and preparation for the monthly planning meeting, with some coordination.',
      best_cities: 'Munich is third on your list; three office days a week.',
      work_life_balance: 'People describe long weeks during the planning cycle.',
      match: 'Carried by the brand and the work',
      skills_match: 'SQL, Python and forecasting are covered; they use a planning system you haven’t worked in.',
      experience_bar: 'They prefer a year of supply-chain exposure, and your capstone forecasting work gets you most of the way.',
      competition: 'A big employer with a large pool for one seat.',
      ease: 'Held down by the German requirement and the size of the pool',
      best_fit: 'Business Analyst, Supply Chain; Demand Planning Analyst',
    },
    report: {
      strongest: 'Forecasting and inventory work at a manufacturer every recruiter knows.',
      biggest: 'German. They ask for B2 and yours is B1, which could end the process at the first call.',
      recommendation: 'Stretch — apply, but ask the recruiter first whether B1 German is enough for this team.',
      path: 'Message the recruiter about the German level before you spend time on the cover letter.',
    },
  },

  // ── 18 · Consolidated Messenger · skip ────────────────────────────────────
  {
    id: 'consolidated-dpa', company: 'Consolidated Messenger', role: 'Dispatch Planning Analyst',
    archetype: 'Strategy & Operations', city: 'Lyon', location: 'Lyon, France',
    employment: 'permanent', employmentType: 'full-time', duration: 'permanent',
    seen: -16, evaluated: -15, portal: 'ashby-api', jobId: 1974, source: 'scan', deadline: 'n/d',
    comp: { base: 33000 }, compSource: 'disclosed', salaryRaw: '€33,000', soft: 0,
    facts: { languages: [{ language: 'French', level: 'C1', required: true }], country: 'FR' },
    scores: j(5, 4, 4, 6, 9, 4, 8, 9, 8), expect: 'skip',
    note: 'T4 skip — rotating early shifts running the daily dispatch plan',
  },

  // ── 19 · City Power & Light · skip (Match mid, Ease low) ──────────────────
  {
    id: 'cpl-eda', company: 'City Power & Light', role: 'Energy Data Analyst',
    archetype: 'Business / Data Analyst', city: 'Vienna', location: 'Vienna, Austria',
    employment: 'permanent', employmentType: 'full-time', duration: 'permanent',
    seen: -12, evaluated: -11, portal: 'smartrecruiters-api', jobId: 8127, source: 'scan', deadline: 'n/d',
    comp: { base: 44000 }, compSource: 'estimate', salaryRaw: 'n/d', soft: 0,
    compBand: { min: 40000, max: 48000, confidence: 'medium' },
    facts: { languages: [EN_C1, { language: 'German', level: 'B2', required: false }], country: 'AT' },
    scores: j(7, 7, 6, 8, 8, 7, 4, 4, 6), expect: 'skip',
    note: 'T4 skip — grid-data and power-systems experience you don’t have, for a role you only half match',
  },

  // ── 20 · Lumen Freight · solid ────────────────────────────────────────────
  {
    id: 'lumen-oa', company: 'Lumen Freight', role: 'Operations Analyst',
    archetype: 'Strategy & Operations', city: 'Lyon', location: 'Lyon, France', remote: 'four office days',
    employment: 'permanent', employmentType: 'full-time', duration: 'permanent',
    seen: -12, evaluated: -11, portal: 'lever-api', jobId: 2547, source: 'scan', deadline: 20,
    comp: { base: 38000 }, compSource: 'disclosed', salaryRaw: '€38,000', soft: 0,
    facts: { languages: [{ language: 'French', level: 'C1', required: true }, { language: 'English', level: 'B2', required: true }], country: 'FR' },
    scores: j(7, 6, 5, 8, 9, 8, 8, 8, 8), expect: 'solid',
    note: 'Hands-on operations analysis in Lyon with little competition; Julien works there',
    reasons: {
      growth_mobility: 'A growing freight company where analysts take on more lanes and regions as they prove themselves; there is no formal ladder.',
      optionality_exit: 'Operations analytics in logistics is useful, but it is mostly valued inside transport and logistics.',
      brand_value: 'Little known outside logistics, though Lyon’s logistics employers know it well.',
      role_content: 'Mostly the analysis you want: lane profitability, capacity planning and the weekly operations review.',
      best_cities: 'Lyon, your first-choice city.',
      work_life_balance: 'Regular hours and four office days; the planning team, not the analysts, absorbs the operational peaks.',
      match: 'Held up by the work and the city, pulled down by a modest name',
      skills_match: 'SQL, Excel modelling and a dashboard tool are all on your CV.',
      experience_bar: 'They want a first internship and some interest in logistics, which your capstone shows.',
      competition: 'A smaller employer hiring locally, and your Lyon school is well known to them.',
      ease: 'High: a fair fit with little competition',
      best_fit: 'Operations Analyst; Network Planning Graduate',
    },
    report: {
      strongest: 'Hands-on operations analysis in Lyon, with little competition for the seat.',
      biggest: 'The name. Outside logistics, recruiters won’t recognise it, so it does less for your next move than a bigger brand would.',
      recommendation: 'Solid — apply.',
      path: 'Message Julien Faure, who lectured your logistics elective and works on the network planning team, before you apply.',
    },
  },

  // ── 21 · Relecloud · skip ─────────────────────────────────────────────────
  {
    id: 'relecloud-bid', company: 'Relecloud', role: 'Junior BI Developer',
    archetype: 'Business / Data Analyst', city: 'Porto', location: 'Porto, Portugal',
    employment: 'permanent', employmentType: 'full-time', duration: 'permanent',
    seen: -9, evaluated: -8, portal: 'greenhouse-api', jobId: 3765, source: 'scan', deadline: 'n/d',
    comp: { base: 26000 }, compSource: 'disclosed', salaryRaw: '€26,000', soft: 0,
    facts: { languages: [EN_C1], country: 'PT' },
    scores: j(6, 6, 5, 5, 7, 7, 6, 7, 7), expect: 'skip',
    note: 'T4 skip — dashboard engineering with no analysis of its own',
  },

  // ── 22 · Proseware · thin ─────────────────────────────────────────────────
  {
    id: 'proseware-roa', company: 'Proseware', role: 'Revenue Operations Analyst',
    archetype: 'Strategy & Operations', city: 'Prague', location: 'Prague, Czechia', remote: 'hybrid',
    employment: 'permanent', employmentType: 'full-time', duration: 'permanent',
    seen: -5, evaluated: -4, portal: 'ashby-api', jobId: 4930, source: 'scan', deadline: 9,
    comp: { base: 30000 }, compSource: 'disclosed', salaryRaw: '€30,000', soft: 0,
    facts: { languages: [EN_C1], country: 'CZ' },
    scores: j(7, 7, 6, 6, 8, 7, 6, 7, 6), expect: 'thin',
    note: 'Forecast reporting at a growing software company; half the week is CRM administration',
    reasons: {
      growth_mobility: 'A growing software company where revenue operations analysts often move into finance or sales strategy.',
      optionality_exit: 'Revenue operations is in demand at software companies, less so elsewhere.',
      brand_value: 'Known in software circles in Central Europe.',
      role_content: 'About half analysis, pipeline and forecast reporting, and half administration of their CRM.',
      best_cities: 'Prague is fourth on your list.',
      work_life_balance: 'Regular hours with a busy quarter-end.',
      match: 'Held back by the CRM administration in the job',
      skills_match: 'They want hands-on CRM administration and a sales-forecasting tool; your analysis skills cover the reporting half only.',
      experience_bar: 'A first internship is enough, and you have one.',
      competition: 'A popular employer with one seat.',
      ease: 'Middling, because of the CRM skills you would need to pick up',
      best_fit: 'Revenue Operations Analyst; Customer Analytics Intern',
    },
    report: {
      strongest: 'Forecast and pipeline analysis at a growing software company.',
      biggest: 'Half the job is CRM administration, which is neither the work you want nor a skill you have yet.',
      recommendation: 'Only if your pipeline is thin: it is a reasonable job, but it pulls you towards sales operations rather than pricing.',
      path: 'If you apply, ask in the first call how the week splits between analysis and CRM administration.',
    },
  },

  // ── 23 · Humongous Insurance · skip (easy, weak match) ────────────────────
  {
    id: 'humongous-cda', company: 'Humongous Insurance', role: 'Claims Data Analyst',
    archetype: 'Business / Data Analyst', city: 'Brussels', location: 'Brussels, Belgium',
    employment: 'permanent', employmentType: 'full-time', duration: 'permanent',
    seen: -1, evaluated: -1, portal: 'smartrecruiters-api', jobId: 6198, source: 'scan', deadline: 'n/d',
    comp: { base: 42000, benefitsMonthlyEur: 160 }, compSource: 'disclosed', salaryRaw: '€42,000 + meal vouchers', soft: 0,
    facts: { languages: [{ language: 'French', level: 'B2', required: true }, EN_C1], country: 'BE' },
    scores: j(5, 5, 6, 7, 7, 8, 8, 8, 7), expect: 'skip',
    note: 'T4 skip — easy to get, but claims reporting leads away from pricing and strategy',
  },

  // ── 24 · Litware · solid ──────────────────────────────────────────────────
  {
    id: 'litware-maa', company: 'Litware', role: 'Marketing Analytics Associate',
    archetype: 'Marketing Analytics', city: 'Porto', location: 'Porto, Portugal', remote: 'hybrid',
    employment: 'permanent', employmentType: 'full-time', duration: 'permanent',
    seen: -1, evaluated: -1, portal: 'lever-api', jobId: 5862, source: 'scan', deadline: 12,
    comp: { base: 27000 }, compSource: 'disclosed', salaryRaw: '€27,000', soft: 0.5,
    facts: { languages: [EN_C1, { language: 'Portuguese', level: 'B1', required: false }], country: 'PT' },
    scores: j(7, 7, 6, 8, 7, 8, 8, 8, 7), expect: 'solid',
    note: 'A steady analytics seat you clearly qualify for; closes soon',
    reasons: {
      growth_mobility: 'A mid-sized software company with a growing marketing analytics team; promotions are performance-based.',
      optionality_exit: 'Marketing analytics skills are portable across most consumer and software companies.',
      brand_value: 'Known in the European software market, little beyond it.',
      role_content: 'Mostly campaign measurement, attribution and customer segmentation, with some dashboard upkeep.',
      best_cities: 'Porto is on your list, near the bottom; hybrid.',
      work_life_balance: 'A 35-hour week with flexible hours.',
      match: 'Steady work with nothing that stands out',
      skills_match: 'SQL, Python and segmentation are covered; attribution modelling would be new.',
      experience_bar: 'An entry-level role, and your internship is enough.',
      competition: 'A modest pool for a Porto role; Portuguese is a plus they mention, and yours is basic.',
      ease: 'High: you fit what they ask for',
      best_fit: 'Marketing Analytics Associate; CRM Analyst',
    },
    report: {
      strongest: 'A steady analytics role you clearly qualify for, with a short hiring process.',
      biggest: 'It is a step sideways from pricing, and Porto pays the least of your cities.',
      recommendation: 'Solid — apply; the posting closes soon.',
      path: 'Before you submit, move one line on customer segmentation from your capstone to the top of your CV.',
    },
  },

  // ── 25 · Tailspin Toys · go → Evaluated ───────────────────────────────────
  {
    id: 'tailspin-pa', company: 'Tailspin Toys', role: 'Pricing Analyst',
    archetype: 'Pricing & Commercial Analytics', city: 'Lyon', location: 'Lyon, France', remote: 'hybrid, two office days',
    employment: 'permanent', employmentType: 'full-time', duration: 'permanent',
    seen: -1, evaluated: -1, portal: 'greenhouse-api', jobId: 2204, source: 'scan', deadline: 5,
    comp: { base: 39000 }, compSource: 'disclosed', salaryRaw: '€39,000', soft: 0.5,
    facts: { languages: [{ language: 'French', level: 'C1', required: true }, { language: 'English', level: 'B2', required: true }], country: 'FR' },
    scores: j(7, 8, 7, 9, 9, 8, 9, 8, 7), expect: 'go',
    note: 'Closest match to your thesis and internship so far; closes in days',
    reasons: {
      growth_mobility: 'A small pricing team that is growing; they mention scope expanding into promotions planning, but there is no formal ladder.',
      optionality_exit: 'Retail pricing and promotion analytics is a skill set every consumer-goods and retail employer hires for.',
      brand_value: 'A known consumer brand in France; recruiters outside retail will recognise the name but not the team.',
      role_content: 'Nearly all pricing analysis: elasticity models, promotion post-mortems and the price-change calendar, with a little coordination with the category managers.',
      best_cities: 'Lyon, your first-choice city.',
      work_life_balance: 'A 37-hour week with two office days; seasonal peaks before the holiday range launches.',
      match: 'Carried by the work itself, which is exactly what you want to do',
      skills_match: 'Price elasticity, Python and SQL are your strongest skills; the only gap is the retail planning tool they use, and they say they will train it.',
      experience_bar: 'They ask for a first internship in pricing or commercial analytics, which you have.',
      competition: 'A mid-sized consumer brand with one seat; your Lyon school helps with their local recruiters.',
      ease: 'High, because the posting reads like your CV',
      best_fit: 'Pricing Analyst; Junior Category Analyst',
    },
    report: {
      summary: {
        domain: 'Toys and games retail',
        function: 'Elasticity modelling, promotion post-mortems and price-change planning for the French market',
        seniority: 'Entry level, permanent',
        remote: 'Hybrid, two office days in Lyon',
        tldr: 'The closest match to your thesis and internship you have seen, at a company you already like.',
      },
      gaps: 'Nothing here you need to close first. They mention a retail planning tool you haven’t used, and they say they will train it.',
      comp: { source: 'Disclosed in the posting', band: '€39K gross a year', note: 'About {savings} a month left after Lyon living costs; they also list a staff discount and a learning budget.' },
      recommendation: 'Apply this week: the posting closes soon, and this is the strongest fit in your pipeline. Lead with the thesis on private-label price elasticity and then the markdown model from your internship. If you get the call, ask how the team splits work with the category managers, because that decides how much of the job is analysis.',
      career: 'Two or three years of retail pricing make you a strong candidate for the larger pricing and revenue roles you are aiming for, including the commercial-excellence kind that currently asks for more years than you have. It narrows you towards consumer and retail, which matches the direction you have chosen.',
    },
  },
]

// ── Applications (promoted listings) ────────────────────────────────────────
// `d` = the application date (applications.md has one date column). Listed in
// the order they were promoted; the build numbers them 1..N in that order.

export const applications = [
  { id: 'contoso-soa', d: -41, status: 'Offer', pdf: true,
    notes: 'Offer: €46K over 14 salaries, hybrid. Recruiter Clara Hofer (clara.hofer@example.com)' },
  { id: 'woodgrove-dsgp', d: -36, status: 'Rejected', pdf: true,
    notes: 'Cohort filled before the assessment centre; invited to reapply next intake' },
  { id: 'northwind-gap', d: -30, status: 'Interview', pdf: true,
    notes: 'Referred by Inès Moreau. Case round passed; final round next. Recruiter Paul Girard (paul.girard@example.com)' },
  { id: 'adatum-jda', d: -27, status: 'Discarded', pdf: false,
    notes: 'Dropped once the Contoso process moved to the final round' },
  { id: 'wingtip-pa', d: -20, status: 'Responded', pdf: true,
    notes: 'Recruiter screen requested (recruiting.prague@example.com)' },
  { id: 'fabrikam-basc', d: -12, status: 'Applied', pdf: true,
    notes: 'Applied through the portal; asked Sofia Brandt about the German level' },
  { id: 'tailspin-pa', d: 0, status: 'Evaluated', pdf: false,
    notes: 'Promoted today; tailor the CV around the thesis before the deadline' },
]

// ── Inbox: pending pipeline URLs (company, title, city, relevance, seen) ────

export const pending = [
  ['Northwind Analytics', 'Data Analyst, Customer Insights', 'Lyon, France', 7.4, -1, 'greenhouse-api', 1106],
  ['Lumen Freight', 'Network Planning Graduate', 'Lyon, France', 6.9, -1, 'lever-api', 2611],
  ['Contoso', 'Business Analyst, Finance Transformation', 'Vienna, Austria', 6.8, -1, 'greenhouse-api', 4472],
  ['Tailspin Toys', 'Junior Category Analyst', 'Lyon, France', 6.6, -1, 'greenhouse-api', 2231],
  ['Wingtip Labs', 'Growth Analyst', 'Prague, Czechia', 6.5, -1, 'ashby-api', 3127],
  ['Alpine Ski House', 'Revenue Management Analyst', 'Vienna, Austria', 6.3, -1, 'greenhouse-api', 5588],
  ['Woodgrove Bank', 'Graduate Analyst, Payments Strategy', 'Brussels, Belgium', 6.0, -1, 'smartrecruiters-api', 7790],
  ['Fabrikam', 'Demand Planning Analyst', 'Munich, Germany', 5.9, -1, 'smartrecruiters-api', 5412],
  ['Litware', 'CRM Analyst', 'Porto, Portugal', 5.6, -1, 'lever-api', 5891],
  ['Proseware', 'Customer Analytics Intern', 'Prague, Czechia', 5.2, -1, 'ashby-api', 4977],
  ['City Power & Light', 'Graduate Programme, Strategy & Planning', 'Vienna, Austria', 6.4, -5, 'smartrecruiters-api', 8170],
  ['Nimbus Robotics', 'Operations Strategy Analyst', 'Lyon, France', 6.2, -5, 'greenhouse-api', 7266],
  ["Margie's Travel", 'Pricing Data Analyst', 'Brussels, Belgium', 5.8, -5, 'ashby-api', 8893],
  ['Humongous Insurance', 'Pricing Analyst Graduate', 'Brussels, Belgium', 5.7, -5, 'smartrecruiters-api', 6233],
  ['Wide World Importers', 'Trade Analytics Associate', 'Lyon, France', 5.5, -5, 'lever-api', 2334],
  ['Southridge Video', 'Business Intelligence Analyst', 'Prague, Czechia', 5.3, -5, 'lever-api', 6702],
  ['Relecloud', 'Product Operations Analyst', 'Porto, Portugal', 5.1, -5, 'greenhouse-api', 3790],
  ['Trey Research', 'Market Research Analyst', 'Toulouse, France', 4.2, -5, 'lever-api', 3355],
  ['VanArsdel', 'Strategy & Operations Associate', 'Munich, Germany', 6.0, -9, 'greenhouse-api', 9160],
  ['Consolidated Messenger', 'Operations Excellence Trainee', 'Lyon, France', 5.6, -9, 'ashby-api', 2012],
  ['Adatum', 'BI Analyst', 'Vienna, Austria', 5.5, -9, 'lever-api', 2788],
  ['Lucerne Publishing', 'Audience Insights Analyst', 'Lyon, France', 5.4, -9, 'ashby-api', 4515],
  ['Lamna Healthcare', 'Business Analyst', 'Munich, Germany', 5.2, -9, 'greenhouse-api', 1590],
  ['Fourth Coffee', 'Supply Planning Analyst', 'Porto, Portugal', 5.0, -9, 'ashby-api', 1222],
  ['Contoso', 'Operations Analyst, Shared Services', 'Prague, Czechia', 5.9, -12, 'greenhouse-api', 4490],
  ['First Up Consultants', 'Junior Data Consultant', 'Brussels, Belgium', 5.8, -12, 'greenhouse-api', 6077],
  ['Northwind Analytics', 'Analytics Engineer, Junior', 'Lyon, France', 5.7, -12, 'greenhouse-api', 1131],
  ['Lamna Healthcare', 'Pricing & Reimbursement Analyst', 'Brussels, Belgium', 5.0, -12, 'greenhouse-api', 1618],
  ['Wide World Importers', 'Inside Sales Analyst', 'Lyon, France', 4.8, -12, 'lever-api', 2391],
  ['Adventure Works', 'Junior Merchandise Planner', 'Lyon, France', 6.1, -12, 'lever-api', 9944],
]

// ── Story bank (STAR+R) ─────────────────────────────────────────────────────

export const stories = [
  {
    title: 'The markdown ladder that cleared the season',
    themes: 'analytical, impact, stakeholder-management',
    situation: 'During my internship at Adventure Works, the end-of-season sale was planned by gut feel, and the previous season had left a large share of stock unsold.',
    task: 'I was asked to propose discount levels for about 1,800 end-of-season items before the sale started.',
    action: 'I estimated price sensitivity by product family from three past seasons of sales, built a simple model of stock left at each discount step, and turned it into a recommended discount ladder. I walked the category managers through it item family by item family so they could overrule it where they knew something the data didn’t.',
    result: 'Leftover stock fell 18% against the previous season, and the team kept the ladder for the next sale.',
    reflection: 'A model gets used when the people who own the decision can see where they are allowed to disagree with it.',
  },
  {
    title: 'The forecast that beat the spreadsheet',
    themes: 'analytical, ambiguity, learning-new-domain',
    situation: 'Our capstone partner, Coho Winery, planned production from a moving-average spreadsheet and kept running out of its best sellers.',
    task: 'With two classmates, I owned the forecasting model for 240 products across three sales channels.',
    action: 'I spent the first two weeks learning how orders actually arrive, then built a gradient-boosted model with promotions, holidays and channel effects, and compared it against their spreadsheet on a full season the model had never seen.',
    result: 'Forecast error came down 14% against their method, and the winery used the model for its next production plan.',
    reflection: 'Two weeks spent understanding the business saved more error than any modelling trick did.',
  },
  {
    title: 'Six hours back every week',
    themes: 'ownership, innovation, efficiency',
    situation: 'The weekly trading report at Adventure Works took an analyst most of Monday, copying figures from four exports into a slide deck.',
    task: 'Nobody had asked me to fix it, but it was eating the time I needed for the pricing work.',
    action: 'I rewrote the extraction in SQL, generated the tables and charts with a Python script, and kept the slide layout the managers were used to so nothing changed for them except the arrival time.',
    result: 'The report went from about 6 hours of work to 20 minutes of checking, and it ran every week for the rest of my internship.',
    reflection: 'Keeping the output familiar was what got the change accepted so quickly.',
  },
  {
    title: 'The teammate who went quiet',
    themes: 'conflict, collaboration, communication',
    situation: 'Halfway through the capstone, one of my two teammates stopped replying and missed two deadlines on the data-cleaning work.',
    task: 'We had five weeks left, and the forecasting model depended on that data.',
    action: 'I asked to meet in person rather than writing another message, learned he was struggling with a part-time job, and we split the work again around the hours he actually had. I also set up a short Monday check-in so delays surfaced early.',
    result: 'We delivered on time, the project scored 17 out of 20, and he took on the final presentation.',
    reflection: 'Asking what was going on before deciding what to do was the step I had nearly skipped.',
  },
  {
    title: 'The elasticity number that was wrong',
    themes: 'failure, learning, integrity',
    situation: 'Three weeks before my thesis deadline, I found that store closures in the price panel had been coded as zero sales.',
    task: 'My headline elasticity estimate rested on that data, and my supervisor had already seen the draft.',
    action: 'I told my supervisor straight away, recoded the closures, reran every model and rewrote the results chapter, noting in an appendix what had changed and why.',
    result: 'The estimate moved from −2.4 to −1.6, the thesis was submitted on time, and my supervisor now hands the cleaning notes to the next cohort.',
    reflection: 'I now check the data against reality, store by store and week by week, before I trust any coefficient.',
  },
  {
    title: 'Case night for 120 students',
    themes: 'leadership, communication, ownership',
    situation: 'As vice-president of the Northfield Analytics Society, I inherited a case-competition night that had shrunk to a handful of teams.',
    task: 'I wanted to make it the society’s main recruiting event again within one semester.',
    action: 'I recruited four companies to set real cases, built a judging guide so scores were comparable, and ran the night with a team of six volunteers.',
    result: '120 students took part, against 30 the year before, and three participants were offered internships by the partner companies.',
    reflection: 'Giving every volunteer one clear job mattered more than any part of the plan I wrote.',
  },
]
