/**
 * The labelled corpus for the chat's "numbers don't add up" note (docs/QUALITY.md Q3; scripts/test-numbers.mjs
 * measures the checker's precision on it). Every answer is labelled by hand:
 *
 *   right  every total equals its parts and every conversion matches its rate (the note must stay quiet)
 *   wrong  a total that isn't the sum of its parts, or a currency pair off by more than 1.5x (`why` says which)
 *
 * Sources: `synthetic` (written for this corpus in the shapes models answer with: tables, lists, prose, ranges,
 * lakh/crore, mixed currencies, and the traps a checker can fall into), `eval` (answers models gave in `pnpm eval`
 * runs, copied verbatim). The fixture chats (the K2 export, its fixed copy, the UI harness chats) are added by the
 * test itself. No stored user chat is in here.
 *
 * Arithmetic in the right answers was computed, not eyeballed: each carries the sum it relies on in `sum`.
 */

const right = (id, text, sum) => ({ id, source: "synthetic", label: "right", text, ...(sum && { sum }) })
const wrong = (id, why, text) => ({ id, source: "synthetic", label: "wrong", why, text })
const evalRight = (id, text) => ({ id, source: "eval", label: "right", text })

// ------------------------------------------------------------------------------------------------ tables with a total

const tables = [
  right(
    "table-usd-trip",
    `Here's a rough budget for a week in Lisbon for two:

| Item | Cost |
|---|---|
| Flights (2 return) | $1,240 |
| Hotel, 7 nights | $1,050 |
| Food | $560 |
| Transport and tickets | $180 |
| **Total** | **$3,030** |`,
    "1240+1050+560+180 = 3030",
  ),
  wrong(
    "table-usd-trip-missed-row",
    "total leaves out the transport row",
    `Here's a rough budget for a week in Lisbon for two:

| Item | Cost |
|---|---|
| Flights (2 return) | $1,240 |
| Hotel, 7 nights | $1,050 |
| Food | $560 |
| Transport and tickets | $180 |
| **Total** | **$2,850** |`,
  ),
  right(
    "table-range-k2",
    `| Cost item | Estimate (USD) |
|---|---|
| Climbing permit and royalty | $5,000 – $9,500 |
| Liaison officer and fees | $2,000 – $3,000 |
| Base camp services | $8,000 – $15,000 |
| Gear | $5,000 – $10,000 |
| Flights | $1,500 – $3,500 |
| **Total** | **$21,500 – $41,000** |`,
    "5000+2000+8000+5000+1500 = 21500; 9500+3000+15000+10000+3500 = 41000",
  ),
  wrong(
    "table-range-k2-stale-total",
    "the incident's shape: total kept from an earlier answer",
    `| Cost item | Estimate (USD) |
|---|---|
| Climbing permit and royalty | $5,000 – $9,500 |
| Liaison officer and fees | $2,000 – $3,000 |
| Base camp services | $8,000 – $15,000 |
| Gear | $5,000 – $10,000 |
| Flights | $1,500 – $3,500 |
| **Total** | **$15,000 – $25,000** |`,
  ),
  right(
    "table-pkr-hunza",
    `Estimated cost for 5 days in Hunza for two (PKR):

| Item | PKR |
|---|---|
| Hotel, 4 nights × 18,000 | 72,000 |
| Car with driver, 3 days × 22,000 | 66,000 |
| Flights ISB–GIL, 2 × 46,000 | 92,000 |
| Food, 2 people × 5 days × 4,500 | 45,000 |
| **Total** | **2,75,000** |`,
    "72000+66000+92000+45000 = 275000",
  ),
  wrong(
    "table-pkr-hunza-off",
    "total 2,57,000 against parts of 2,75,000",
    `Estimated cost for 5 days in Hunza for two (PKR):

| Item | PKR |
|---|---|
| Hotel, 4 nights × 18,000 | 72,000 |
| Car with driver, 3 days × 22,000 | 66,000 |
| Flights ISB–GIL, 2 × 46,000 | 92,000 |
| Food, 2 people × 5 days × 4,500 | 45,000 |
| **Total** | **2,57,000** |`,
  ),
  right(
    "table-two-columns",
    `| Phase | Low | High |
|---|---|---|
| Design | $4,000 | $6,000 |
| Build | $18,000 | $25,000 |
| Testing | $3,000 | $5,000 |
| Launch | $1,000 | $2,500 |
| **Total** | **$26,000** | **$38,500** |`,
    "4000+18000+3000+1000 = 26000; 6000+25000+5000+2500 = 38500",
  ),
  wrong(
    "table-two-columns-high-wrong",
    "high column says $36,500, rows add to $38,500",
    `| Phase | Low | High |
|---|---|---|
| Design | $4,000 | $6,000 |
| Build | $18,000 | $25,000 |
| Testing | $3,000 | $5,000 |
| Launch | $1,000 | $2,500 |
| **Total** | **$26,000** | **$36,500** |`,
  ),
  right(
    "table-subtotals",
    `| Item | Cost |
|---|---|
| Laptop | €1,499 |
| Monitor | €349 |
| *Subtotal hardware* | *€1,848* |
| Office licence | €99 |
| Antivirus | €39 |
| **Total** | **€1,986** |`,
    "1499+349+99+39 = 1986 (subtotal skipped)",
  ),
  right(
    "table-included-rows",
    `| Service | Price |
|---|---|
| Airport pickup | Included |
| City tour | $45 |
| Dinner cruise | $120 |
| Breakfast | — |
| **Total** | **$165** |`,
    "0+45+120+0 = 165",
  ),
  right(
    "table-discount-row",
    `| Line | Amount |
|---|---|
| 3 × Pro seats at $40 | $120 |
| 1 × Admin seat | $60 |
| Annual discount | -$18 |
| **Total per month** | **$162** |`,
    "120+60-18 = 162",
  ),
  wrong(
    "table-discount-ignored",
    "the total ignores the discount row ($180 vs $162)",
    `| Line | Amount |
|---|---|
| 3 × Pro seats at $40 | $120 |
| 1 × Admin seat | $60 |
| Annual discount | -$18 |
| **Total per month** | **$180** |`,
  ),
  right(
    "table-qty-unit-total-columns",
    `| Item | Qty | Unit price | Line total |
|---|---|---|---|
| Tent | 2 | $350 | $700 |
| Sleeping bag | 4 | $180 | $720 |
| Stove | 1 | $95 | $95 |
| **Total** | | | **$1,515** |`,
    "700+720+95 = 1515",
  ),
  right(
    "table-gbp-salary",
    `Monthly take-home on a £48,000 salary (2026/27, England):

| | Monthly |
|---|---|
| Gross pay | £4,000 |
| Income tax | -£586 |
| National Insurance | -£211 |
| Pension (5%) | -£200 |
| **Take-home** | **£3,003** |`,
    "no Total row; nothing to check",
  ),
  right(
    "table-total-is-average",
    `| Month | Visitors |
|---|---|
| January | 12,400 |
| February | 11,900 |
| March | 14,100 |
| **Average** | **12,800** |`,
  ),
  right(
    "table-alternatives-no-sum",
    `| Plan | Price per month |
|---|---|
| Starter | $9 |
| Team | $29 |
| Business | $79 |

All plans include unlimited projects.`,
  ),
  wrong(
    "table-inr-total-short",
    "total ₹1,32,500 against rows adding up to ₹1,52,500",
    `Here's the wedding catering estimate:

| Item | Cost (INR) |
|---|---|
| Food for 150 guests | ₹1,05,000 |
| Decoration | ₹25,000 |
| Sound and lights | ₹15,000 |
| Staff | ₹7,500 |
| **Total** | **₹1,32,500** |`,
  ),
  right(
    "table-inr-total",
    `Here's the wedding catering estimate:

| Item | Cost (INR) |
|---|---|
| Food for 150 guests | ₹1,05,000 |
| Decoration | ₹25,000 |
| Sound and lights | ₹15,000 |
| Staff | ₹7,500 |
| **Total** | **₹1,52,500** |`,
    "105000+25000+15000+7500 = 152500",
  ),
  right(
    "table-lakh-words",
    `| Expense | Amount |
|---|---|
| Tuition (year 1) | PKR 9.5 lakh |
| Hostel | PKR 2.4 lakh |
| Books and laptop | PKR 1.6 lakh |
| **Total** | **PKR 13.5 lakh** |`,
    "9.5+2.4+1.6 = 13.5 lakh",
  ),
  wrong(
    "table-lakh-crore-slip",
    "total written as 1.35 crore (13.5 crore lakh slip): rows add to 13.5 lakh",
    `| Expense | Amount |
|---|---|
| Tuition (year 1) | PKR 9.5 lakh |
| Hostel | PKR 2.4 lakh |
| Books and laptop | PKR 1.6 lakh |
| **Total** | **PKR 1.35 crore** |`,
  ),
  right(
    "table-optional-row",
    `| Item | Cost |
|---|---|
| Visa | $160 |
| Flights | $900 |
| Hotel | $1,100 |
| Travel insurance (optional) | $85 |
| **Total** | **$2,160** |

The total leaves out the optional insurance.`,
    "160+900+1100 = 2160 (optional row left out on purpose)",
  ),
  right(
    "table-rounded-total",
    `| Item | Estimate |
|---|---|
| Permit | ~$5,000 |
| Guide | ~$3,200 |
| Porters | ~$1,850 |
| **Total** | **~$10,000** |`,
    "5000+3200+1850 = 10050, total ~10,000 within rounding",
  ),
  wrong(
    "table-eur-mixed-total",
    "total €2,350 but rows add to €2,530",
    `| Room | Cost |
|---|---|
| Kitchen cabinets | €1,200 |
| Worktop | €680 |
| Sink and tap | €410 |
| Fitting | €240 |
| **Total** | **€2,350** |`,
  ),
  right(
    "table-eur-total",
    `| Room | Cost |
|---|---|
| Kitchen cabinets | €1,200 |
| Worktop | €680 |
| Sink and tap | €410 |
| Fitting | €240 |
| **Total** | **€2,530** |`,
    "1200+680+410+240 = 2530",
  ),
  right(
    "table-grand-total-after-totals",
    `| Category | Year 1 | Year 2 |
|---|---|---|
| Salaries | $180,000 | $210,000 |
| Cloud | $24,000 | $36,000 |
| Marketing | $40,000 | $55,000 |
| **Grand total** | **$244,000** | **$301,000** |`,
    "180+24+40 = 244; 210+36+55 = 301",
  ),
  wrong(
    "table-year2-carry",
    "Year 2 total $291,000, rows add to $301,000 (a carry slip)",
    `| Category | Year 1 | Year 2 |
|---|---|---|
| Salaries | $180,000 | $210,000 |
| Cloud | $24,000 | $36,000 |
| Marketing | $40,000 | $55,000 |
| **Grand total** | **$244,000** | **$291,000** |`,
  ),
  right(
    "table-k-shorthand",
    `| Round | Raised |
|---|---|
| Pre-seed | $250k |
| Seed | $1.2M |
| Series A | $8M |
| **Total raised** | **$9.45M** |`,
    "0.25+1.2+8 = 9.45M",
  ),
  wrong(
    "table-k-shorthand-wrong",
    "total $9.2M against $9.45M",
    `| Round | Raised |
|---|---|
| Pre-seed | $250k |
| Seed | $1.2M |
| Series A | $8M |
| **Total raised** | **$9.2M** |`,
  ),
  right(
    "table-percent-column",
    `| Channel | Share |
|---|---|
| Organic search | 46% |
| Direct | 31% |
| Social | 15% |
| Referral | 8% |
| **Total** | **100%** |`,
  ),
  right(
    "table-counts-not-money",
    `| Peak | Height (m) | Ascents |
|---|---|---|
| K2 | 8,611 | ~800 |
| Nanga Parbat | 8,126 | ~400 |
| Broad Peak | 8,051 | ~450 |
| **Total** | | **~1,650** |`,
  ),
]

// ------------------------------------------------------------------------------------------------ two currencies side by side

const conversions = [
  right(
    "table-usd-pkr-277",
    `At about 277 PKR per USD:

| Item | USD | PKR |
|---|---|---|
| Permit | $5,000 | PKR 13.85 lakh |
| Liaison officer | $3,000 | PKR 8.31 lakh |
| Base camp | $10,000 | PKR 27.7 lakh |
| **Total** | **$18,000** | **PKR 49.86 lakh** |`,
    "18000 × 277 = 49.86 lakh; 13.85+8.31+27.7 = 49.86",
  ),
  wrong(
    "table-usd-pkr-10x",
    "every PKR figure 10x too high (crore for lakh), the incident",
    `At about 277 PKR per USD:

| Item | USD | PKR |
|---|---|---|
| Permit | $5,000 | PKR 1.385 crore |
| Liaison officer | $3,000 | PKR 83.1 lakh |
| Base camp | $10,000 | PKR 2.77 crore |
| **Total** | **$18,000** | **PKR 4.986 crore** |`,
  ),
  wrong(
    "table-usd-pkr-crore-words",
    "4.1 crore for $15,000 (should be 41.55 lakh)",
    `| Budget | USD | PKR (approx.) |
|---|---|---|
| Lean | $15,000 | 4.1 crore |
| Comfortable | $25,000 | 6.9 crore |`,
  ),
  right(
    "table-usd-pkr-crore-words-right",
    `| Budget | USD | PKR (approx.) |
|---|---|---|
| Lean | $15,000 | 41.6 lakh |
| Comfortable | $25,000 | 69.3 lakh |`,
    "15000×277 = 41.55 lakh; 25000×277 = 69.25 lakh",
  ),
  right(
    "table-usd-inr",
    `Using ₹88 per US dollar:

| Item | USD | INR |
|---|---|---|
| MacBook Air | $1,099 | ₹96,712 |
| AirPods | $179 | ₹15,752 |`,
    "1099×88 = 96712; 179×88 = 15752",
  ),
  wrong(
    "table-usd-inr-pkr-rate",
    "used a PKR-sized rate (~277) for INR",
    `| Item | USD | INR |
|---|---|---|
| MacBook Air | $1,099 | ₹3,04,423 |
| AirPods | $179 | ₹49,583 |`,
  ),
  right(
    "prose-pkr-paren",
    "The permit is $5,000 (about PKR 13.9 lakh at 277 PKR/USD), and the liaison officer adds $3,000 (about PKR 8.3 lakh).",
  ),
  wrong(
    "prose-pkr-paren-10x",
    "PKR 1.39 crore for $5,000",
    "The permit is $5,000 (about PKR 1.39 crore at 277 PKR/USD), and the liaison officer adds $3,000 (about PKR 8.3 lakh).",
  ),
  right("prose-conversion-sentence", "At today's rate of roughly 1 USD = 277 PKR, $15,000 comes to about PKR 41.5 lakh."),
  wrong("prose-conversion-sentence-10x", "4.15 crore for $15,000", "At today's rate of roughly 1 USD = 277 PKR, $15,000 comes to about PKR 4.15 crore."),
  wrong("prose-million-slip", "41.5 million PKR for $15,000 (10x)", "That's $15,000, which is roughly 41.5 million PKR."),
  right("prose-million-right", "That's $15,000, which is roughly 4.15 million PKR."),
  right(
    "prose-eur-usd",
    "The hotel quoted €1,200 for the week (about $1,345), which is cheaper than the Airbnb at $1,500.",
    "1200/0.86 ≈ 1395; 1345 is 4% off: inside 1.5x",
  ),
  right(
    "list-usd-pkr-pairs",
    `Rough costs, at 1 USD = 278 PKR:

- Flights: $1,200 (PKR 3.34 lakh)
- Hotel: $800 (PKR 2.22 lakh)
- Food: $300 (PKR 83,400)`,
  ),
  wrong(
    "list-usd-pkr-pairs-slip",
    "the hotel line says PKR 22.2 lakh for $800 (10x)",
    `Rough costs, at 1 USD = 278 PKR:

- Flights: $1,200 (PKR 3.34 lakh)
- Hotel: $800 (PKR 22.2 lakh)
- Food: $300 (PKR 83,400)`,
  ),
  right(
    "heading-paren-next-line",
    `### Total: about $21,500 – $41,000
(roughly PKR 59.6 lakh – 1.14 crore)`,
  ),
  wrong(
    "heading-paren-next-line-10x",
    "the bracketed PKR range is 10x the USD range",
    `### Total: about $21,500 – $41,000
(roughly PKR 5.96 crore – 11.4 crore)`,
  ),
  right(
    "table-gbp-usd",
    `| Item | GBP | USD |
|---|---|---|
| Rent | £1,650 | $2,200 |
| Council tax | £160 | $213 |`,
    "1650/0.75 = 2200",
  ),
  right(
    "table-usd-eur-aed-mixed",
    `| City | Monthly rent (local) | In USD |
|---|---|---|
| Dubai | AED 9,000 | $2,450 |
| Berlin | €1,400 | $1,630 |`,
  ),
  right(
    "prose-two-currencies-not-a-conversion",
    "A Pakistani climber pays PKR 50,000 for the permit, while foreigners pay $5,000 for the same peak.",
  ),
  right(
    "prose-per-month-vs-per-year",
    "The plan is $20 per month, or PKR 66,000 a year if you pay annually.",
  ),
  right(
    "table-pkr-usd-salary",
    `| Role | PKR / month | USD / month |
|---|---|---|
| Junior developer | 1,50,000 | $540 |
| Senior developer | 4,50,000 | $1,620 |`,
  ),
  wrong(
    "table-pkr-usd-salary-slip",
    "4,50,000 PKR shown as $16,200 (10x)",
    `| Role | PKR / month | USD / month |
|---|---|---|
| Junior developer | 1,50,000 | $540 |
| Senior developer | 4,50,000 | $16,200 |`,
  ),
  right(
    "table-inr-crore",
    `| Flat | INR | USD (at ₹88) |
|---|---|---|
| 2BHK, Pune | ₹85 lakh | $96,600 |
| 3BHK, Mumbai | ₹2.4 crore | $272,700 |`,
  ),
  wrong(
    "table-inr-crore-slip",
    "₹2.4 crore shown as $27,270 (10x low)",
    `| Flat | INR | USD (at ₹88) |
|---|---|---|
| 2BHK, Pune | ₹85 lakh | $96,600 |
| 3BHK, Mumbai | ₹2.4 crore | $27,270 |`,
  ),
  right("prose-stated-rate-280", "I used 280 PKR to the dollar: the $8,500 package is PKR 23.8 lakh and the $15,000 one is PKR 42 lakh."),
  wrong("prose-stated-rate-280-off", "PKR 2.38 crore for $8,500 at 280 (10x)", "I used 280 PKR to the dollar: the $8,500 package is PKR 2.38 crore and the $15,000 one is PKR 42 lakh."),
]

// ------------------------------------------------------------------------------------------------ lists and prose totals

const lists = [
  right(
    "list-k2-ranges",
    `Estimated costs:
- Permit and royalty: $11k–17k
- Agency package: $20k–40k
- Gear: $5k–10k
- Travel: $4k–7k

**Total: $40k–74k**`,
    "11+20+5+4 = 40; 17+40+10+7 = 74",
  ),
  wrong(
    "list-k2-ranges-incident",
    "turn 14 of the incident: $30k–65k against $40k–74k",
    `Estimated costs:
- Permit and royalty: $11k–17k
- Agency package: $20k–40k
- Gear: $5k–10k
- Travel: $4k–7k

**Total: $30k–65k**`,
  ),
  right(
    "list-total-last-item",
    `Monthly costs:
1. Rent: $1,400
2. Utilities: $180
3. Groceries: $520
4. Transport: $150
5. **Total: $2,250**`,
    "1400+180+520+150 = 2250",
  ),
  wrong(
    "list-total-last-item-wrong",
    "total $2,050 against $2,250",
    `Monthly costs:
1. Rent: $1,400
2. Utilities: $180
3. Groceries: $520
4. Transport: $150
5. **Total: $2,050**`,
  ),
  right(
    "list-total-before",
    `The whole trip costs about $3,900, broken down as:
- Flights: $1,400
- Lodging: $1,600
- Food and activities: $900`,
    "1400+1600+900 = 3900",
  ),
  wrong(
    "list-total-before-wrong",
    "says $3,400 broken down as parts adding to $3,900",
    `The whole trip costs about $3,400, broken down as:
- Flights: $1,400
- Lodging: $1,600
- Food and activities: $900`,
  ),
  right(
    "list-per-day-rates",
    `Typical daily costs in Skardu:
- Guesthouse: PKR 6,000 per night
- Jeep hire: PKR 15,000 per day
- Meals: PKR 2,500 a day

For a 5-day stay, expect a total of around PKR 1.2 lakh.`,
  ),
  right(
    "list-alternatives",
    `Price depends on the tier you pick:
- Budget: $30k
- Mid-range: $45k
- Luxury: $65k

So the total is anywhere from $30k to $65k.`,
  ),
  right(
    "list-pkr-lakh-total",
    `Car running costs per year:
- Fuel: PKR 3.6 lakh
- Insurance: PKR 85,000
- Maintenance: PKR 60,000
- Token tax: PKR 15,000

**Total: PKR 5.2 lakh a year**`,
    "360000+85000+60000+15000 = 520000",
  ),
  wrong(
    "list-pkr-lakh-total-wrong",
    "total 4.6 lakh against 5.2 lakh",
    `Car running costs per year:
- Fuel: PKR 3.6 lakh
- Insurance: PKR 85,000
- Maintenance: PKR 60,000
- Token tax: PKR 15,000

**Total: PKR 4.6 lakh a year**`,
  ),
  right(
    "list-open-ended-plus",
    `- Course fee: $2,000
- Equipment rental: $400
- Certification: $250

**Total: $2,650+** (more if you buy your own gear)`,
    "2000+400+250 = 2650",
  ),
  right(
    "list-some-items-unpriced",
    `What you'll need:
- A visa (free for most visitors)
- Travel insurance: $90
- Return flights: $1,100
- Patience for the queues

**Total: about $1,190**`,
    "90+1100 = 1190",
  ),
  right(
    "list-savings-not-parts",
    `A typical trip costs $40,000. You can save money with:
- Shared base camp: save $3,000
- Renting gear: save $1,500
- Off-season flights: save $800`,
  ),
  right(
    "list-key-segments",
    `The market is worth about $12 billion. Key segments:
- Enterprise: $5 billion
- SMB: $3 billion`,
  ),
  wrong(
    "list-key-segments-exceed",
    "parts ($13bn) exceed the stated $12bn total",
    `The market is worth about $12 billion, broken down as:
- Enterprise: $5 billion
- SMB: $3 billion
- Consumer: $5 billion`,
  ),
  right(
    "list-inr-wedding",
    `Total budget: ₹18 lakh, which breaks down as:
- Venue: ₹6 lakh
- Catering: ₹7.5 lakh
- Decor: ₹2.5 lakh
- Photography: ₹2 lakh`,
    "6+7.5+2.5+2 = 18",
  ),
  wrong(
    "list-inr-wedding-crore",
    "total stated as ₹1.8 crore for parts of ₹18 lakh",
    `Total budget: ₹1.8 crore, which breaks down as:
- Venue: ₹6 lakh
- Catering: ₹7.5 lakh
- Decor: ₹2.5 lakh
- Photography: ₹2 lakh`,
  ),
  right(
    "list-percentages",
    `Budget split:
- Rent: 35%
- Savings: 20%
- Food: 15%
- Everything else: 30%`,
  ),
  right(
    "list-ranges-total-prose",
    `**Costs**
- Visa: $160
- Flights: $900–1,400
- Hotel (6 nights): $600–1,200
- Food: $250–400

**Total: $1,910–3,160**`,
    "160+900+600+250 = 1910; 160+1400+1200+400 = 3160",
  ),
  wrong(
    "list-ranges-total-prose-wrong",
    "total $1,910–2,760 against $1,910–3,160",
    `**Costs**
- Visa: $160
- Flights: $900–1,400
- Hotel (6 nights): $600–1,200
- Food: $250–400

**Total: $1,910–2,760**`,
  ),
  right(
    "list-salary-annual-monthly",
    `- Base salary: $96,000 a year
- Bonus: $12,000 a year
- Stock: $20,000 a year

Total compensation: $128,000 a year (about $10,667 a month).`,
    "96+12+20 = 128",
  ),
  right(
    "list-steps-not-money",
    `1. Fly Islamabad to Skardu (1 hour).
2. Drive to Askole (7 hours).
3. Trek 8 days to base camp.

In total that's about 10 days from Islamabad.`,
  ),
  right(
    "list-subtotal-lines",
    `- Hardware: $2,400
- Software: $600
- Subtotal: $3,000
- Support contract: $500
- **Total: $3,500**`,
  ),
  right(
    "list-nested-items",
    `Here's the breakdown:
- Travel: $1,800
  - Flights: $1,500
  - Trains: $300
- Stay: $1,200
- **Total: $3,000**`,
  ),
  right(
    "prose-sum-inline",
    "Flights are $1,500 and the hotel is $900, so you're looking at $2,400 before food.",
  ),
  right(
    "prose-only-totals",
    "In total, most climbers spend between $40,000 and $70,000 on an 8,000 m peak with a Western operator, and $15,000 to $25,000 with a local one.",
  ),
  wrong(
    "list-usd-forgot-item",
    "total skips the $450 insurance item",
    `Your startup costs:
- Company registration: $300
- Laptop: $1,600
- Insurance: $450
- Domain and hosting: $120

**Total: $2,020**`,
  ),
  right(
    "list-usd-forgot-item-fixed",
    `Your startup costs:
- Company registration: $300
- Laptop: $1,600
- Insurance: $450
- Domain and hosting: $120

**Total: $2,470**`,
    "300+1600+450+120 = 2470",
  ),
  right(
    "list-mixed-currencies-no-total",
    `Fees you'll pay:
- Park entry: PKR 2,000
- Porter (per day): $25
- Guide (per day): $60`,
  ),
  right(
    "list-gbp-total-colon",
    `**Running total for the renovation**
- Plumbing: £3,200
- Electrics: £2,750
- Plastering: £1,900
- Decorating: £1,450
- Total: £9,300`,
    "3200+2750+1900+1450 = 9300",
  ),
  wrong(
    "list-gbp-total-colon-wrong",
    "£9,030 against £9,300 (digits swapped)",
    `**Running total for the renovation**
- Plumbing: £3,200
- Electrics: £2,750
- Plastering: £1,900
- Decorating: £1,450
- Total: £9,030`,
  ),
]

// ------------------------------------------------------------------------------------------------ lakh/crore and big numbers

const indian = [
  right("lakh-plain-conversion", "1 crore is 100 lakh, so a budget of ₹2.5 crore is ₹250 lakh, or ₹2,50,00,000."),
  right("lakh-population", "Lahore has about 1.3 crore people (13 million); Karachi about 2 crore."),
  right(
    "crore-table-right",
    `| Project | Budget |
|---|---|
| Road repair | PKR 4.5 crore |
| School block | PKR 80 lakh |
| Water scheme | PKR 1.2 crore |
| **Total** | **PKR 6.5 crore** |`,
    "4.5+0.8+1.2 = 6.5",
  ),
  wrong(
    "crore-table-lakh-as-crore",
    "the school block's 80 lakh counted as 8 crore in the total",
    `| Project | Budget |
|---|---|
| Road repair | PKR 4.5 crore |
| School block | PKR 80 lakh |
| Water scheme | PKR 1.2 crore |
| **Total** | **PKR 13.7 crore** |`,
  ),
  right(
    "indian-grouping-right",
    `| Item | PKR |
|---|---|
| Down payment | 12,50,000 |
| Registration | 1,25,000 |
| Furnishing | 3,75,000 |
| **Total** | **17,50,000** |`,
    "1250000+125000+375000 = 1750000",
  ),
  wrong(
    "indian-grouping-wrong",
    "17,05,000 against 17,50,000",
    `| Item | PKR |
|---|---|
| Down payment | 12,50,000 |
| Registration | 1,25,000 |
| Furnishing | 3,75,000 |
| **Total** | **17,05,000** |`,
  ),
  right("lakh-usd-pair", "A salary of PKR 6 lakh a month is roughly $2,160 a month at 277 PKR per dollar."),
  wrong("lakh-usd-pair-10x", "PKR 6 lakh as $21,600 (10x)", "A salary of PKR 6 lakh a month is roughly $21,600 a month at 277 PKR per dollar."),
  right("inr-lakh-usd", "₹15 lakh is about $17,000 at ₹88 to the dollar."),
  wrong("inr-lakh-usd-wrong", "₹15 lakh as $1,700 (10x low)", "₹15 lakh is about $1,700 at ₹88 to the dollar."),
  right(
    "lakh-ranges-list",
    `For a family of four, budget roughly:
- School fees: PKR 4–6 lakh
- Rent: PKR 9–12 lakh
- Living costs: PKR 7–9 lakh

**Total: PKR 20–27 lakh a year**`,
    "4+9+7 = 20; 6+12+9 = 27",
  ),
  wrong(
    "lakh-ranges-list-wrong",
    "total 20–25 lakh against 20–27",
    `For a family of four, budget roughly:
- School fees: PKR 4–6 lakh
- Rent: PKR 9–12 lakh
- Living costs: PKR 7–9 lakh

**Total: PKR 20–25 lakh a year**`,
  ),
  right("arab-words", "The project is worth Rs 2 arab, which is 200 crore."),
  right("million-billion", "Revenue grew from $850 million to $1.2 billion, up 41%."),
  right(
    "table-pkr-k2-fixed-shape",
    `Using 277 PKR per USD:

| Item | USD | PKR |
|---|---|---|
| Permit and royalty | $5,000 – $9,500 | 13.85 – 26.32 lakh |
| Base camp services | $8,000 – $15,000 | 22.16 – 41.55 lakh |
| Gear | $5,000 – $10,000 | 13.85 – 27.7 lakh |
| Flights | $1,500 – $3,500 | 4.16 – 9.7 lakh |
| **Total** | **$19,500 – $38,000** | **54.02 lakh – 1.05 crore** |`,
    "5+8+5+1.5 = 19.5k; 9.5+15+10+3.5 = 38k; ×277 = 54.02 lakh – 1.05 crore",
  ),
  wrong(
    "table-pkr-k2-total-10x",
    "PKR total 5.4 – 10.5 crore for $19.5k–38k (10x)",
    `Using 277 PKR per USD:

| Item | USD | PKR |
|---|---|---|
| Permit and royalty | $5,000 – $9,500 | 13.85 – 26.32 lakh |
| Base camp services | $8,000 – $15,000 | 22.16 – 41.55 lakh |
| Gear | $5,000 – $10,000 | 13.85 – 27.7 lakh |
| Flights | $1,500 – $3,500 | 4.16 – 9.7 lakh |
| **Total** | **$19,500 – $38,000** | **5.4 – 10.5 crore** |`,
  ),
]

// ------------------------------------------------------------------------------------------------ traps: right answers a careless checker would flag

const traps = [
  right("trap-years", "In 1954 an Italian team of 11 climbers made the first ascent; by 2024 about 800 people had summited."),
  right("trap-heights", "K2 is 8,611 m tall, 237 m lower than Everest's 8,848 m."),
  right("trap-phone-numbers", "Call the office on +92 51 111 222 333 or +1 415 555 0100 before 5 pm."),
  right("trap-versions", "Upgrade from Node 20.11.1 to 24.11.1, then run pnpm 11.17.0."),
  right(
    "trap-per-person-and-group",
    `| | Per person | Group of 4 |
|---|---|---|
| Permit | $1,500 | $6,000 |
| Guide | $500 | $2,000 |
| **Total** | **$2,000** | **$8,000** |`,
  ),
  right(
    "trap-total-row-per-night",
    `| Hotel | Per night | 3 nights |
|---|---|---|
| Serena | $220 | $660 |
| PC | $180 | $540 |`,
  ),
  right(
    "trap-cumulative-column",
    `| Month | Saved | Running total |
|---|---|---|
| Jan | $500 | $500 |
| Feb | $700 | $1,200 |
| Mar | $600 | $1,800 |`,
  ),
  right(
    "trap-tax-percent-row",
    `| Item | Amount |
|---|---|
| Subtotal | $1,000 |
| Tax (8%) | $80 |
| **Total** | **$1,080** |`,
  ),
  right(
    "trap-code-block",
    "```js\nconst total = 1500 + 900 // $2,400\nconsole.log(`Total: $${total}`)\n```\n\nThat prints `Total: $2400`.",
  ),
  right("trap-dates-ranges", "The season runs June–August; the 2026–27 permit window opens on 1 March."),
  right("trap-percent-change", "Prices rose from $40,000 to $46,000, a 15% increase."),
  right(
    "trap-two-totals-two-tables",
    `**Option A**

| Item | Cost |
|---|---|
| Flight | $800 |
| Hotel | $600 |
| **Total** | **$1,400** |

**Option B**

| Item | Cost |
|---|---|
| Train | $300 |
| Hostel | $250 |
| **Total** | **$550** |`,
  ),
  right(
    "trap-total-with-quantity-text",
    `- 2 × tickets at $45: $90
- 1 × parking: $20
- **Total: $110**`,
  ),
  right(
    "trap-rate-only-line",
    "The open-market rate today is about 1 USD = 278 PKR, and the interbank rate is 1 USD = 277.4 PKR.",
  ),
  right(
    "trap-btc-not-checked",
    "1 BTC is about $62,000 right now, roughly PKR 1.72 crore.",
  ),
  right(
    "trap-each-not-sum",
    `Each tier costs:
- Bronze: $500 each
- Silver: $1,000 each
- Gold: $2,500 each

Total sponsorship raised last year: $48,000.`,
  ),
  right(
    "trap-midpoint-hint",
    `| Item | Estimate |
|---|---|
| Permit | $5,000 – $9,500 |
| Agency | $8,500 – $15,000 |
| **Typical total** | **$17,000** |`,
  ),
  right(
    "trap-table-total-word-in-label",
    `| Item | Cost |
|---|---|
| Total station rental | $350 |
| Survey crew | $1,200 |`,
  ),
  right("trap-negative-balance", "You owe $1,200 and paid $1,500, so you have a $300 credit."),
  right(
    "trap-latex",
    "The total is $T = \\$1{,}500 + \\$900 = \\$2{,}400$, and in PKR that's about 6.65 lakh at 277.",
  ),
]

// ------------------------------------------------------------------------------------------------ answers models gave in `pnpm eval` runs (verbatim)

const evals = [
  // 2026-10-09, num-percent: a right answer the checker first flagged (a derivation list read as a breakdown).
  evalRight(
    "eval-num-percent-derivation",
    `The annual total is $12,472.51.

Here is the breakdown:
*   **Monthly cost:** $1,127
*   **Annual cost (before discount):** $13,524
*   **Discounted annual cost (15% off):** $11,495.40
*   **Sales tax (8.5%):** $977.11`,
  ),
  // 2026-10-09, after Q3: Gemini 3.5 Flash-Lite with syrup_calc (k2-pkr, trials 1–5).
  evalRight(
    "eval-k2-pkr-q3-1",
    "For a Pakistani climber using a local outfitter, the estimated cost of **$15,000 to $25,000 USD** comes out to approximately **41.5 lakh to 69.2 lakh PKR** (at the current exchange rate of 1 USD = 276.72 PKR).",
  ),
  evalRight(
    "eval-k2-pkr-q3-2",
    `For a Pakistani citizen, the total estimated cost in PKR is approximately **4,170,000 to 6,950,000 PKR** (~4.2m to 7m PKR), using an exchange rate of roughly 278 PKR per USD.

This covers local outfitting, permits, and shared logistics, though specialized imported gear (such as 8,000-meter down suits and triple boots) will add to the total if you don't already own them.`,
  ),
  evalRight(
    "eval-k2-pkr-q3-3",
    "For a Pakistani climber using a local outfitter, the total all-in cost translates to roughly **41.7 lakh to 69.5 lakh PKR** ($15,000 to $25,000 USD at an exchange rate of 278 PKR per USD), assuming you already have or can source specialized 8,000m gear.",
  ),
  evalRight(
    "eval-k2-pkr-q3-4",
    "For a Pakistani climber, an all-in K2 expedition typically ranges from **41.51 lakh to 69.18 lakh PKR** ($15,000 to $25,000 USD), using an exchange rate of approximately 276.72 PKR per USD.",
  ),
  evalRight(
    "eval-k2-pkr-2026-10-08-flashlite",
    `Assuming an exchange rate of roughly **280 PKR to 1 USD**, here is the estimated cost breakdown for a Pakistani citizen climbing K2 with a local operator:

* **Local Operator Package (Logistics, Base Camp & Support):**
  * $\\approx \\$8,500 - \\$15,000\\text{ USD}$ $\\rightarrow$ **2.38 Million to 4.2 Million PKR**
* **Government Permits, Royalties & Fees:**
  * $\\approx \\$3,000 - \\$5,000\\text{ USD}$ $\\rightarrow$ **840,000 to 1.4 Million PKR**
* **Specialized High-Altitude Gear (Imported Boots, Down Suit, etc.):**
  * $\\approx \\$5,000 - \\$10,000\\text{ USD}$ $\\rightarrow$ **1.4 Million to 2.8 Million PKR**
* **Insurance, Local Travel & Incidentals:**
  * $\\approx \\$1,000 - \\$2,000\\text{ USD}$ $\\rightarrow$ **280,000 to 560,000 PKR**

**Total Estimated Cost:** Roughly **4.9 Million to 9 Million PKR** (approx. $17,500 to $32,000 USD), depending on the level of high-altitude support, supplementary oxygen, and whether you already own essential gear.`,
  ),
]

export const CORPUS = [...tables, ...conversions, ...lists, ...indian, ...traps, ...evals]
