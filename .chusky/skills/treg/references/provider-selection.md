# Treg provider selection

Treg does not silently choose a provider or fail over every option. The agent
must choose using the data it actually has:

1. Match required inputs first. A profile-URL endpoint cannot replace one that
   accepts only a name and domain. A provider that cannot satisfy the scope is
   not a valid option regardless of price.
2. Prefer observed reliability with a meaningful sample size. A high success
   rate from one call is weaker evidence than a slightly lower rate from a
   substantial sample.
3. Compare price after input fit and reliability. Keep per-result costs and
   flat fees distinct; do not apply one endpoint's unit conversion to another.
4. Use speed and recency as tie-breakers. Health is evidence about availability,
   not proof that returned data is correct.
5. Treat `LAST OK`, freshness, provider notes, account requirements, and
   unsupported filters as part of the decision. Report filters that were
   ignored or only partially applied.

For people and companies, prefer precise domains, titles, geography, and
small result limits. For SEO, ads, social, and market data, preserve platform,
country, language, dates, device, and units. For a comparison, use compatible
providers and identical scope; otherwise label the comparison as directional
and explain the mismatch.

If a call fails with 429, 5xx, or timeout, inspect the failure and use a
different inspected provider only when the inputs still fit and the budget
allows it. Never fan out automatically. Never retry a 4xx at another provider
before correcting the request.
