export type TregPlaybookId =
  | "account_research"
  | "people_search"
  | "lead_enrichment"
  | "lead_generation"
  | "buying_signals"
  | "hiring_signals"
  | "technology_research"
  | "market_map"
  | "bulk_enrichment"
  | "seo_research"
  | "social_intelligence"
  | "ads_intelligence"
  | "ads_operations"
  | "general_research";

export interface TregPlaybook {
  id: TregPlaybookId;
  label: string;
  requiredContext: string[];
  discoveryQueries: string[];
  tools: string[];
  workflow: string[];
  validation: string[];
  guardrails: string[];
}

const PLAYBOOKS: Record<TregPlaybookId, TregPlaybook> = {
  account_research: {
    id: "account_research",
    label: "Company and account research",
    requiredContext: [
      "the company name or domain, and the decision the research should support",
      "the specific fields needed (for example firmographics, funding, headcount, technology, leadership, or hiring)",
      "geography and freshness window when relevant",
      "the maximum aggregate Treg spend for this research, if the owner has not already set one",
    ],
    discoveryQueries: [
      "routed company search for the exact name, domain, industry, or technology",
      "company enrichment for the requested firmographic and technology fields",
      "company news, funding, workforce, or hiring events only when those signals answer the decision",
    ],
    tools: ["CHUCK_TREG_COMPANY_SEARCH", "CHUCK_TREG_ENRICH_COMPANY", "CHUCK_TREG_COMPANY_JOBS_SEARCH", "CHUCK_TREG_RESOLVE", "CHUCK_TREG_CALL_STATUS"],
    workflow: [
      "For a known company, enrich by its domain or exact name; use company search only when discovering candidates or resolving an ambiguous identity.",
      "Ask for only the fields needed to answer the decision. Add a separate signal lookup only when a dated event would materially change the recommendation.",
      "If a requested field is not covered by the fixed routed tool, search the live Treg catalog, inspect the candidate endpoint, and use the narrowest compatible read path.",
      "Return a concise account brief with observed facts, dates, sources, provider, missing fields, and the next useful research step.",
    ],
    validation: [
      "Confirm the company identity by domain or another stable identifier before joining provider records.",
      "Keep each field's source and observation time; distinguish missing provider data from a confirmed negative.",
      "Preserve provider-supplied scores as provider-specific values, not universal confidence.",
    ],
    guardrails: [
      "Enrichment is a read of external business data and does not authorize CRM changes or outreach.",
      "Do not enrich a broad list before qualifying it; stop at the effective owner, mission, and per-call spend limits.",
    ],
  },
  people_search: {
    id: "people_search",
    label: "Decision-maker and contact discovery",
    requiredContext: [
      "target company/domain or a precise buyer description",
      "target roles, seniority, department, and geography",
      "the number of people needed and any exclusions",
      "whether profile details, work-email discovery, or email verification are actually required",
    ],
    discoveryQueries: [
      "routed people search by company domain, job title, and country",
      "person enrichment for a selected, identity-matched person",
      "work-email verification for an already returned address whose status is unknown",
    ],
    tools: ["CHUCK_TREG_PEOPLE_SEARCH", "CHUCK_TREG_ENRICH_PERSON", "CHUCK_TREG_EMAIL_VERIFY", "CHUCK_TREG_CALL_STATUS"],
    workflow: [
      "Search a small, specific set using the known domain and target role; deduplicate by profile URL or name plus company.",
      "Check that each person still matches the requested company and role before enriching selected people.",
      "Treat a returned email as unverified unless Treg explicitly reports a verified status; verify only an existing address when needed.",
      "Return named matches with role, company, source links, provider score if supplied, and separate verified, unknown, or no-match email status.",
    ],
    validation: [
      "Do not merge people on name alone when the company or profile does not match.",
      "Keep catch-all, disposable, role-account, invalid, and unknown email outcomes distinct.",
      "Report the number searched, matched, enriched, and verified instead of padding an incomplete list.",
    ],
    guardrails: [
      "Do not buy personal email or phone data, invent address patterns, or contact the people found.",
      "Email verification is evidence about deliverability only; it is not authorization to send.",
    ],
  },
  lead_enrichment: {
    id: "lead_enrichment",
    label: "Qualified lead enrichment",
    requiredContext: [
      "the exact saved candidate identity or stable person/company identifier",
      "whether the candidate has already passed the owner's fit and geography criteria",
      "the specific fields needed and whether work-email verification is required",
      "the remaining campaign allowance or aggregate Treg spend ceiling",
    ],
    discoveryQueries: [
      "routed person enrichment from a name plus company domain or profile URL",
      "routed company enrichment from its domain or exact name",
      "verification of a returned work email only when its deliverability status is unknown",
    ],
    tools: ["CHUCK_TREG_ENRICH_PERSON", "CHUCK_TREG_ENRICH_COMPANY", "CHUCK_TREG_EMAIL_VERIFY", "CHUCK_TREG_CALL_STATUS"],
    workflow: [
      "In a lead campaign, enrich only a persisted qualified candidate by candidateId; the server must bind the call to its saved identity and remaining campaign budget.",
      "For one known person or company outside a campaign, use its stable profile URL or domain and request only the fields needed for the decision.",
      "Use the routed enrichment tool first. Search and inspect a provider endpoint only if the routed result cannot return a material required field.",
      "Verify an existing work email only when its status is unknown, then report returned fields, sources, provider, cost, no-match status, and unresolved gaps.",
    ],
    validation: [
      "Keep the provider's exact identity and verification fields; do not infer emails, phone numbers, titles, or company matches.",
      "Separate missing fields, no-match results, pending work, and provider errors in the outcome.",
      "Preserve source URLs and provider scores only when supplied by the provider.",
    ],
    guardrails: [
      "Never enrich rejected or review-status campaign candidates or bypass the saved-candidate binding.",
      "Do not write CRM records or contact a prospect; enrichment and verification do not authorize outreach.",
    ],
  },
  lead_generation: {
    id: "lead_generation",
    label: "Qualified lead-list campaign",
    requiredContext: [
      "explicit ICP, offer or problem solved, geography, exclusions, and target count",
      "seed companies or queries, when available",
      "qualification criteria that separate fit from purchase timing",
      "aggregate Treg campaign-spend ceiling and whether an internal tracker is useful",
    ],
    discoveryQueries: [
      "companies matching the explicit ICP and geography",
      "decision-makers at qualified companies by domain and target role",
      "dated hiring, funding, technology, or public-need signals only if requested",
    ],
    tools: ["CHUCK_LEAD_CAMPAIGN", "CHUCK_TREG_COMPANY_SEARCH", "CHUCK_TREG_PEOPLE_SEARCH", "CHUCK_TREG_ENRICH_COMPANY", "CHUCK_TREG_ENRICH_PERSON", "CHUCK_TREG_CALL_STATUS"],
    workflow: [
      "For a sustained list-building job, ask Chusky to start or resume the durable CHUCK_LEAD_CAMPAIGN workflow; do not simulate a long campaign in one chat turn.",
      "Discover and deduplicate candidates first, then qualify each candidate against the owner's explicit ICP and geography.",
      "Enrich only persisted qualified candidates, passing the campaign identity and remaining budget; inspect existing pending call IDs instead of repeating calls.",
      "Finalize from persisted records and report qualified count, review/rejected counts, shortfall, spend, sources, and gaps.",
    ],
    validation: [
      "Every candidate must have an HTTPS source and a concise observed-fact summary.",
      "Fit, freshness, and signal strength are separate dimensions; qualification is not buying intent.",
      "Use persisted campaign counts as the source of truth for the final report.",
    ],
    guardrails: [
      "Muna can prepare bounded research but cannot create campaigns, recurring watches, CRM writes, or outreach; return those steps to Chusky.",
      "Do not enrich review or rejected candidates or exceed the campaign's atomic Treg allowance.",
    ],
  },
  buying_signals: {
    id: "buying_signals",
    label: "Buying-signal and timing research",
    requiredContext: [
      "buyer profile or target account list, plus the problem or product category",
      "which observable events matter (for example public requests for help, hiring, funding, role changes, technology adoption, or company news)",
      "geography and time window for a one-time search, or desired cadence for a recurring watch",
      "the maximum aggregate spend and whether this is one-time research or a durable monitor",
    ],
    discoveryQueries: [
      "public buyer posts, complaints, or engagement tied to the specific problem",
      "company news, hiring, funding, job-change, technology-adoption, and headcount events for the target segment",
      "provider endpoints that return dates, source URLs, stable entity identifiers, and signal categories",
    ],
    tools: ["CHUCK_TREG_SEARCH", "CHUCK_TREG_GET", "CHUCK_TREG_RESOLVE", "CHUCK_TREG_CALL_STATUS"],
    workflow: [
      "Translate the offer into a small set of observable, dated signals; do not use a generic intent label as the evidence.",
      "Search the live catalog for those signal jobs. Inspect endpoint method, input fields, price model, account requirements, and returned evidence before a provider call.",
      "Run one bounded sample, then qualify the evidence by identity, relevance, freshness, and source. Search for decision-makers only for accounts that survive qualification.",
      "For ongoing monitoring, return the criteria and cadence to Chusky to create an owner-scoped durable watch; this research plan does not create or schedule one.",
    ],
    validation: [
      "Report what happened, when it happened, who or which company it concerns, and the source URL.",
      "Deduplicate repeated signals; distinguish a new event from a material change to an earlier observation.",
      "A signal suggests why a conversation may be timely; it is not proof of purchase intent or a purchase probability.",
    ],
    guardrails: [
      "Use only provider methods and pricing that the trusted gateway accepts; never fan out across providers to compensate for one miss.",
      "Do not contact a prospect, write a CRM record, or create a recurring watch as part of this research run.",
    ],
  },
  hiring_signals: {
    id: "hiring_signals",
    label: "Hiring and workforce signals",
    requiredContext: [
      "company domains/names or the ICP to search",
      "role families, seniority, locations, and posting-date window that matter",
      "whether the question is which companies are hiring or which job postings match a role",
      "result limit and aggregate spend ceiling",
    ],
    discoveryQueries: [
      "company job listings by exact company domain or name",
      "job-posting search by title, location, and recent posting date",
      "workforce/headcount change only when a dated comparison is available",
    ],
    tools: ["CHUCK_TREG_COMPANY_JOBS_SEARCH", "CHUCK_TREG_SEARCH", "CHUCK_TREG_GET", "CHUCK_TREG_RESOLVE", "CHUCK_TREG_CALL_STATUS"],
    workflow: [
      "For a named account, use the fixed bounded company-jobs route with a small result limit.",
      "For cross-company job discovery or workforce trends, search the live catalog for the exact dataset and inspect date fields, geography, result pricing, and filters.",
      "Keep only listings that match the requested role and date window; preserve direct job links and company identity.",
      "If no listing is returned, report that no matching listing was found for this query rather than claiming the company is not hiring.",
    ],
    validation: [
      "Check company/domain, posting date, location, title, and source URL for each row.",
      "Separate provider-returned listing evidence from interpretation about budget or buying readiness.",
    ],
    guardrails: [
      "Hiring is a timing clue, not confirmed intent to buy.",
      "Do not collect applicant data or contact the company or candidates.",
    ],
  },
  technology_research: {
    id: "technology_research",
    label: "Company technology and adoption research",
    requiredContext: [
      "target company/domain or company segment",
      "specific product, category, integration, or competitor technology to check",
      "whether current presence or a change over time is required",
      "geography, freshness window, and aggregate spend ceiling",
    ],
    discoveryQueries: [
      "technology stack detected on a named company's domain, with category and last-detected date",
      "company technology adoption or removal events with event dates",
      "technology users by category and firmographic filters",
    ],
    tools: ["CHUCK_TREG_SEARCH", "CHUCK_TREG_GET", "CHUCK_TREG_RESOLVE", "CHUCK_TREG_COMPANY_SEARCH", "CHUCK_TREG_CALL_STATUS"],
    workflow: [
      "Separate current stack lookup from a change-detection question; a point-in-time tag cannot prove when adoption began.",
      "Search the live catalog for the requested technology dataset, then inspect accepted identity fields, last-detected/event dates, filters, account requirements, and price units.",
      "Run a small bounded domain or sample query. If a change is needed, compare dated observations or use an event endpoint rather than inferring change from one snapshot.",
      "Summarize observed technology, source, detection date, and coverage gaps; label fit or competitor implications as analysis.",
    ],
    validation: [
      "Verify that each returned tag is tied to the target's domain and has the requested date semantics.",
      "Do not claim a company does not use a tool because one provider returned no tag.",
    ],
    guardrails: [
      "Do not imply that technology presence proves a planned purchase or a competitor replacement.",
      "Keep provider-specific filters and scores in their original meaning.",
    ],
  },
  market_map: {
    id: "market_map",
    label: "Market and competitor map",
    requiredContext: [
      "product/category and the buyer problem that defines the market",
      "geography, company size/stage, and explicit inclusion/exclusion criteria",
      "whether the output should be peer companies, competitors, partners, or a broader landscape",
      "target count and aggregate spend ceiling",
    ],
    discoveryQueries: [
      "company search by industry, technology, location, size, and relevant description",
      "competitor/peer discovery for the named category, with firmographic filters",
      "funding, news, hiring, or technology evidence only for shortlisted companies",
    ],
    tools: ["CHUCK_TREG_COMPANY_SEARCH", "CHUCK_TREG_ENRICH_COMPANY", "CHUCK_TREG_SEARCH", "CHUCK_TREG_GET", "CHUCK_TREG_RESOLVE"],
    workflow: [
      "Turn the market definition into explicit filters and exclusions before discovering companies.",
      "Use a bounded company-search query, normalize by domain, and classify direct competitors separately from adjacent providers or possible partners.",
      "Enrich only a small shortlist; use dated funding, hiring, news, or technology events to explain movement, not to pad the map.",
      "Return the market definition, companies, evidence for each classification, source links, coverage, and notable gaps.",
    ],
    validation: [
      "Check that every listed company has a stable identity and a source supporting its category.",
      "Call out provider coverage, geography, or size limits; do not present a partial provider result as the complete market.",
    ],
    guardrails: [
      "Company similarity does not establish direct competition; explain the evidence for each label.",
      "Keep enrichment and signals within the user's aggregate cap and the runtime's stricter configured limits.",
    ],
  },
  bulk_enrichment: {
    id: "bulk_enrichment",
    label: "Bulk company and people enrichment",
    requiredContext: [
      "a bounded, owner-provided input list with stable company domains or person identifiers",
      "the exact output fields needed and whether missing fields should be skipped",
      "a maximum record count, aggregate spend ceiling, and acceptable provider/BYOK requirements",
      "whether the provider runs synchronously or creates a durable asynchronous job",
    ],
    discoveryQueries: [
      "bulk company enrichment by domain with firmographics, funding, employees, technology, or hiring fields",
      "bulk people enrichment or work-contact lookup for supplied, qualified identities",
      "async bulk job status and result retrieval for the selected provider endpoint",
    ],
    tools: ["CHUCK_TREG_SEARCH", "CHUCK_TREG_GET", "CHUCK_TREG_PLATFORMS", "CHUCK_TREG_CALL", "CHUCK_TREG_CALL_STATUS", "CHUCK_TREG_USAGE"],
    workflow: [
      "Inspect endpoint schema, batch limits, price unit, max rows, account requirement, HTTP method, and async behavior before choosing the provider.",
      "Estimate maximum spend from the endpoint's actual per-call, per-result, per-row, or target unit and the requested batch size; stop when the charge cannot be bounded under the effective cap.",
      "Start with the smallest useful batch. For an async response, persist the call/job ID and inspect that same job until completion; never start a duplicate job to poll faster.",
      "Normalize results to the submitted identities, retain provider/source and no-match states, and report requested, completed, matched, and failed counts.",
    ],
    validation: [
      "Reject rows that cannot be matched to a submitted stable identity; do not join on name alone.",
      "Keep estimate versus settled spend, partial results, async state, and provider-side errors distinct.",
    ],
    guardrails: [
      "Do not use bulk jobs to bypass result caps, campaign qualification, privacy controls, or aggregate budgets.",
      "Generic POST/PUT/PATCH/DELETE calls require owner approval; no list, CRM, or outreach writes are authorized by enrichment.",
    ],
  },
  seo_research: {
    id: "seo_research",
    label: "SEO, search visibility, and AI discovery",
    requiredContext: ["target domains or keywords", "search engine, geography, language, device, and date range", "the decision and result depth", "aggregate spend ceiling"],
    discoveryQueries: ["keyword research, search volume, difficulty, and SERP results", "domain backlinks, authority, competitors, and traffic estimates", "AI-search or answer-engine visibility and cited sources"],
    tools: ["CHUCK_TREG_SEARCH", "CHUCK_TREG_GET", "CHUCK_TREG_PLATFORMS", "CHUCK_TREG_CALL", "CHUCK_TREG_CALL_STATUS"],
    workflow: ["Translate the question into a precise keyword/domain and geography; inspect which provider supports the needed date and device filters.", "Compare providers only when coverage, freshness, or price differs materially; select one bounded endpoint and inspect its schema and price units.", "Run a small sample, then expand only to close an evidence gap within the remaining budget.", "Report source, engine, geography, date, units, and whether volume/rank/traffic is provider-estimated."],
    validation: ["Preserve provider units and date semantics; do not combine incompatible keyword metrics.", "An empty result is not proof of zero search demand or absence of backlinks."],
    guardrails: ["Keep competitor and traffic figures attributed to their provider and observation date.", "Do not claim rankings or analytics access that the selected endpoint did not return."],
  },
  social_intelligence: {
    id: "social_intelligence",
    label: "Social audience and public conversation research",
    requiredContext: ["platforms, accounts, keywords, or public URLs", "geography, time window, and audience or outcome", "whether the request concerns public content or owner-authenticated analytics", "aggregate spend ceiling"],
    discoveryQueries: ["public posts, mentions, engagement, and account analytics for the named platform", "creator or audience discovery with audience and engagement fields", "social listening for the named brand, product, or buying problem"],
    tools: ["CHUCK_TREG_SEARCH", "CHUCK_TREG_GET", "CHUCK_TREG_PLATFORMS", "CHUCK_TREG_CALL", "CHUCK_TREG_CALL_STATUS"],
    workflow: ["Separate public third-party data from analytics that require the owner's connected account or BYOK.", "Inspect platform coverage, date window, pagination, rate limits, and per-result pricing before calling.", "Collect only the requested public/authorized data; preserve post/account URLs, timestamps, and provider metrics.", "Summarize observed conversation and reach with the platform and sampling window; keep interpretation separate."],
    validation: ["Check platform identity, timestamp, source URL, and provider-reported metric definitions.", "Do not treat sampled mentions or engagement as a representative survey or verified buyer intent."],
    guardrails: ["Research does not authorize liking, following, posting, messaging, or ad/account changes.", "POST/PUT/PATCH/DELETE catalog calls require owner approval even when the provider endpoint resembles a search."],
  },
  ads_intelligence: {
    id: "ads_intelligence",
    label: "Advertising intelligence and competitor research",
    requiredContext: ["advertiser, brand, domain, product, or ad-library query", "platforms and geography", "date range and the question (creative, spend estimate, placement, or activity)", "aggregate spend ceiling"],
    discoveryQueries: ["public ad-library creatives and advertiser activity for the target brand/domain", "competitor advertising research by platform and geography", "ad creative, landing-page, and campaign trend data with dates and sources"],
    tools: ["CHUCK_TREG_SEARCH", "CHUCK_TREG_GET", "CHUCK_TREG_PLATFORMS", "CHUCK_TREG_CALL", "CHUCK_TREG_CALL_STATUS"],
    workflow: ["Use public ad-library or market-intelligence endpoints for competitor research; verify that the endpoint provides the requested platform, date, and geography.", "Inspect whether spend/reach is directly reported or modeled, along with price unit, pagination, and account requirements.", "Run a narrow query, preserve ad/creative and landing-page source links, then expand only within the cap.", "Report advertiser, platform, observed dates, creative themes, and the source; label modeled metrics as estimates."],
    validation: ["Distinguish ad-library records, provider estimates, and owner-account campaign metrics.", "A missing ad in one library or period does not prove that a brand is not advertising."],
    guardrails: ["This playbook is research-only and cannot launch, edit, pause, target, or fund campaigns.", "Authenticated ad-account metrics require the owner's connected account; do not use an arbitrary provider key or account ID."],
  },
  ads_operations: {
    id: "ads_operations",
    label: "Advertising account operations",
    requiredContext: ["the owner's connected ad platform and account", "the exact campaign/ad-set/ad change and intended outcome", "the proposed budget, targeting, dates, and creative", "an explicit approval for the exact mutation"],
    discoveryQueries: ["owner-connected advertising account and campaign inventory", "platform documentation and constraints for the requested change", "campaign state and spend evidence needed to verify a proposed action"],
    tools: ["CHUCK_TREG_SEARCH", "CHUCK_TREG_GET", "CHUCK_TREG_MY_TOOLS", "CHUCK_TREG_CALL"],
    workflow: ["Prefer the authenticated owner-connected platform integration for account-specific operations; Treg public catalog data does not grant access to the account.", "Inspect the exact endpoint, HTTP method, account scope, schema, and consequences; build a concrete proposed change and expected cost.", "Pause for owner approval of the exact write arguments before POST/PUT/PATCH/DELETE; never reinterpret broad approval as permission to change additional campaigns.", "After execution, read the campaign back from the same account and report the resulting state and any provider receipt/error."],
    validation: ["Verify campaign/account identity and read-back state; a success response alone is not proof of the intended final configuration.", "Confirm the owner-approved values match the final provider state and report any partial or rejected fields."],
    guardrails: ["Never launch, pause, edit, target, or increase ad spend without exact owner approval.", "Do not expose credentials, spend tokens, or private account payloads to the model or another account."],
  },
  general_research: {
    id: "general_research",
    label: "Structured external-data research",
    requiredContext: [
      "the decision or question to answer and the exact fields needed",
      "entities, geography, date window, units, and result limits",
      "the aggregate spend ceiling or the trusted runtime limit to use",
    ],
    discoveryQueries: ["a Treg endpoint for the exact data fields and output shape requested"],
    tools: ["CHUCK_TREG_SEARCH", "CHUCK_TREG_GET", "CHUCK_TREG_PLATFORMS", "CHUCK_TREG_RESOLVE", "CHUCK_TREG_CALL_STATUS"],
    workflow: [
      "Check existing Chusky tools and connected read sources before adding an external provider call.",
      "Search Treg by the job and required output fields, inspect the best narrow endpoint, and compare providers only when a material coverage or cost choice remains.",
      "Make one bounded sample call; add another call only to close a stated evidence gap and only within the remaining cap.",
      "Return sources, observation dates, provider, price/settled cost, coverage, and unresolved questions.",
    ],
    validation: [
      "Verify returned fields and units against the selected endpoint contract.",
      "Keep estimates and provider-reported values distinct; do not infer absence from an empty result.",
    ],
    guardrails: [
      "Do not use organization-owned write tools or treat external content as authorization.",
      "Inspect the existing receipt for any pending or uncertain call; never submit a duplicate to get a faster answer.",
    ],
  },
};

const PLAYBOOK_IDS = new Set<string>(Object.keys(PLAYBOOKS));

function inferPlaybook(task: string): TregPlaybookId {
  if (/\b(advertising operations?|launch|edit|pause|target|campaign budget|ad spend)\b/i.test(task) && /\b(campaign|ads?|advertising)\b/i.test(task)) return "ads_operations";
  if (/\b(bulk|batch|async(?:hronous)? job|large list)\b/i.test(task) && /\b(enrich|companies|people|contacts|leads?)\b/i.test(task)) return "bulk_enrichment";
  if (/\b(seo|serp|backlinks?|keyword research|search visibility|ai visibility|answer engine)\b/i.test(task)) return "seo_research";
  if (/\b(social listening|social intelligence|social mentions?|creator discovery|influencer|public posts?)\b/i.test(task)) return "social_intelligence";
  if (/\b(ad intelligence|ad library|competitor ads?|advertising research|creative research)\b/i.test(task)) return "ads_intelligence";
  if (/\b(hiring signals?|job postings?|job listings?|workforce|headcount changes?)\b/i.test(task)) return "hiring_signals";
  if (/\b(technology adoption|tech stack|technographics?|technology changes?|tools? (?:they|companies) use)\b/i.test(task)) return "technology_research";
  if (/\b(?:(?:buying|buyer|purchase)[ -]intent|intent)[ -]signals?\b|\b(buying|buyer|purchase) signals?\b|\b(in-market|trigger events?|why now|public requests? for help)\b/i.test(task)) return "buying_signals";
  if (/\b(enrich(?:ment)?)\b.{0,60}\b(leads?|prospects?|candidates?|people|contacts?)\b|\b(leads?|prospects?|candidates?)\b.{0,60}\b(enrich(?:ment)?)\b/i.test(task)) return "lead_enrichment";
  if (/\b(lead generation|prospecting|build (?:a )?(?:lead|prospect|target account) list|qualified leads?)\b/i.test(task)) return "lead_generation";
  if (/\b(people search|find (?:the )?(?:people|person|decision makers?|contacts?)|buying committee|work email)\b/i.test(task)) return "people_search";
  if (/\b(market map|market landscape|competitors?|companies like|peer companies)\b/i.test(task)) return "market_map";
  if (/\b(company research|account research|company brief|enrich (?:a |the )?company|firmographics?)\b/i.test(task)) return "account_research";
  return "general_research";
}

export function buildTregPlan(input: {
  task: string;
  playbook?: string;
  budgetUsd?: number;
}): Record<string, unknown> {
  const task = input.task.trim();
  if (task.length < 2 || task.length > 2_000) throw new Error("Treg plan task must be 2-2000 characters.");
  const requested = input.playbook ?? "auto";
  if (requested !== "auto" && !PLAYBOOK_IDS.has(requested)) throw new Error("Unsupported Treg playbook.");
  if (input.budgetUsd !== undefined && (!Number.isFinite(input.budgetUsd) || input.budgetUsd < 0 || input.budgetUsd > 10_000)) {
    throw new Error("budgetUsd must be between 0 and 10000.");
  }

  const selected = requested === "auto" ? inferPlaybook(task) : requested as TregPlaybookId;
  const playbook = PLAYBOOKS[selected];
  return {
    playbook: playbook.id,
    title: playbook.label,
    mode: "plan_only",
    providerCallsAllowedByThisTool: false,
    budget: input.budgetUsd === undefined
      ? { userBudgetProvided: false, instruction: "Use the existing owner and mission limits; do not widen them. If no effective limit can be established, stop before any paid provider call." }
      : { userBudgetProvided: true, budgetUsd: input.budgetUsd, instruction: "Treat this as the aggregate cap for the workflow; the stricter owner, mission, and per-call runtime limits always apply." },
    requiredContext: playbook.requiredContext,
    discoveryQueries: playbook.discoveryQueries,
    tools: playbook.tools,
    workflow: playbook.workflow,
    validation: playbook.validation,
    guardrails: playbook.guardrails,
    executionSequence: [
      "Use the fixed routed Treg tool for a common company, people, email-verification, or named-company hiring job when its inputs fit.",
      "For a catalog gap, use CHUCK_TREG_SEARCH by capability, then CHUCK_TREG_GET to inspect the current method, schema, account requirements, price unit, and reliability before a paid direct call.",
      "Stay within the supplied cap and the stricter trusted runtime/mission cap; use small result limits and do not fan out to providers after a miss.",
      "When a call is pending or its result is uncertain, inspect the same owner-scoped callId with CHUCK_TREG_CALL_STATUS rather than resubmitting it.",
      "Report provider, source URLs, observation time, settled or estimated cost, missing fields, and whether the result is partial.",
    ],
    catalogIsDynamic: true,
    endpointIdsAreHardcoded: false,
  };
}
