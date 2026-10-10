// Held-out corpus for the "numbers don't add up" checker.
// Written independently of the checker. Every sum and conversion was computed in code.
// Rates: 1 USD = 277 PKR, 88 INR, 0.86 EUR, 0.75 GBP, 3.6725 AED.

export const HOLDOUT = [
  {
    id: "tokyo-week-table",
    source: "holdout",
    label: "right",
    why: "1240+1050+560+180 = 3030",
    text: `Here's a realistic budget for a **7-day solo trip to Tokyo** in spring:

| Category | Estimated Cost (USD) |
|---|---|
| Flights (round trip, economy) | $1,240 |
| Hotel (7 nights @ ~$150/night) | $1,050 |
| Food & drinks | $560 |
| Local transport (Suica, day trips) | $180 |
| **Total** | **$3,030** |

**A few notes:**
- Flights assume departure from the US West Coast; East Coast is usually $200–300 more.
- Cherry blossom season (late March to early April) pushes hotel prices up by 20–30%.
- A 7-day JR Pass is no longer worth it for a Tokyo-only trip.`,
  },
  {
    id: "lahore-mehndi-bullets",
    source: "holdout",
    label: "right",
    why: "450000+660000+180000+120000+45000 = 1455000; 1455000/277 = 5253",
    text: `For a mid-range **mehndi in Lahore** with around 300 guests, here's what you can expect to pay:

- **Venue (marquee, 300 guests):** PKR 450,000
- **Catering (300 × PKR 2,200 per head):** PKR 660,000
- **Decor & stage:** PKR 180,000
- **Photography & video:** PKR 120,000
- **Dhol & DJ:** PKR 45,000

**Total: PKR 1,455,000** (about 14.55 lakh, or roughly $5,250)

Prices go up 15–20% in peak wedding season (November–February), so book the marquee early.`,
  },
  {
    id: "saas-tiers-range",
    source: "holdout",
    label: "right",
    why: "tiers are alternatives; annual = monthly x 10 (2 months free); 8 x 39 = 312, 8 x 390 = 3120",
    text: `### Pricing overview

| Plan | Monthly (per user) | Annual (per user, billed yearly) |
|---|---|---|
| Basic | $12 | $120 |
| Pro | $39 | $390 |
| Business | $99 | $990 |

Annual billing gives you **2 months free**.

**What you'll actually pay:** anywhere from **$12 to $99 per user per month**, depending on the tier. For a team of 8 on Pro, that's 8 × $39 = **$312/month**, or **$3,120/year** on annual billing.

Enterprise pricing is custom and usually starts around 50 seats.`,
  },
  {
    id: "hunza-per-person-group",
    source: "holdout",
    label: "right",
    why: "per person 30000+25000+15000+5000 = 75000; group = x4 = 300000",
    text: `Here's a cost breakdown for a **6-day Hunza trip** for a group of 4 friends from Islamabad:

| Item | Per person (PKR) | Group of 4 (PKR) |
|---|---|---|
| Transport (Prado rental, shared) | 30,000 | 120,000 |
| Hotels (5 nights) | 25,000 | 100,000 |
| Food | 15,000 | 60,000 |
| Entry tickets & misc | 5,000 | 20,000 |
| **Total** | **75,000** | **300,000** |

Splitting the Prado between four people is what keeps this affordable. If you go as a couple, transport alone jumps to about PKR 60,000 each.`,
  },
  {
    id: "istanbul-rate-qty",
    source: "holdout",
    label: "right",
    why: "570+70+105+280 = 1025",
    text: `**Istanbul, 7 days — estimated budget for one person**

| Item | Rate | Qty | Cost |
|---|---|---|---|
| Hotel (Sultanahmet) | $95 | 6 nights | $570 |
| Airport transfer | $35 | 2 trips | $70 |
| Museum Pass Istanbul | $105 | 1 | $105 |
| Meals | $40 | 7 days | $280 |
| **Estimated total** |  |  | **$1,025** |

Flights aren't included since they depend heavily on where you're flying from.`,
  },
  {
    id: "laptop-discount-row",
    source: "holdout",
    label: "right",
    why: "1099+199+59-100 = 1257",
    text: `If you're a student, here's what the setup would cost:

| Item | Price |
|---|---|
| MacBook Air 13" (M4, 16GB/256GB) | $1,099 |
| AppleCare+ (3 years) | $199 |
| USB-C hub | $59 |
| Education discount | −$100 |
| **Total** | **$1,257** |

Sales tax isn't included and varies by state (0% in Oregon, around 9% in parts of California).`,
  },
  {
    id: "gst-invoice-inr",
    source: "holdout",
    label: "right",
    why: "85000+120000 = 205000; 18% = 36900; total 241900",
    text: `Here's how your invoice should look with GST applied:

| Description | Amount |
|:---|---:|
| UI/UX design (12 screens) | ₹85,000 |
| Frontend development | ₹1,20,000 |
| **Subtotal** | ₹2,05,000 |
| GST @ 18% | ₹36,900 |
| **Total payable** | **₹2,41,900** |

If your client is outside India and you have a LUT filed, you can invoice without GST, in which case the total is just the subtotal of ₹2,05,000.`,
  },
  {
    id: "startup-subtotals-grand",
    source: "holdout",
    label: "right",
    why: "114000+9600+24000 = 147600",
    text: `Here's a lean **first-year budget** for a two-person SaaS startup:

### People
- Founding engineer: $90,000
- Part-time designer: $24,000

**Subtotal: $114,000**

### Infrastructure & tools
- AWS: $6,000
- SaaS tools (Linear, Figma, Notion, etc.): $3,600

**Subtotal: $9,600**

### Marketing
- Paid ads: $18,000
- Content & SEO: $6,000

**Subtotal: $24,000**

---

**Grand total: $147,600**

That's roughly $12,300 a month in burn, so a $200K pre-seed gives you about 16 months of runway.`,
  },
  {
    id: "kitchen-optional-excluded",
    source: "holdout",
    label: "right",
    why: "8500+4200+6300+7500+2800 = 29300; with optional +650+1200 = 31150",
    text: `## Mid-range kitchen remodel estimate

| Item | Cost |
|---|---|
| Cabinets (semi-custom) | $8,500 |
| Quartz countertops | $4,200 |
| Appliances (mid-range package) | $6,300 |
| Labor | $7,500 |
| Plumbing & electrical | $2,800 |
| **Total** | **$29,300** |

**Optional extras (not included above):**
- Under-cabinet LED lighting: $650
- Built-in wine fridge: $1,200

Adding both optional items brings the project to **$31,150**. I'd also keep a 10–15% contingency for surprises behind the walls.`,
  },
  {
    id: "london-student-tips",
    source: "holdout",
    label: "right",
    why: "850+220+110+15+150 = 1345; tips are savings, not parts",
    text: `**Monthly budget for a student in London:**

- Rent (room in a shared flat, Zone 2): £850
- Groceries: £220
- Transport (student Oyster, Zones 1–2): £110
- Phone plan: £15
- Eating out & social: £150

**Total: £1,345 per month**

💡 **Ways to bring it down:**
- Cooking at home 5 days a week can save around £80/month.
- A 16–25 Railcard linked to your Oyster saves a third on off-peak fares.
- Student discounts (UNiDAYS, TOTUM) are worth £20–30 a month if you use them.`,
  },
  {
    id: "ebc-trek-heights",
    source: "holdout",
    label: "right",
    why: "440+50+360+420+60 = 1330; altitudes and days are not money",
    text: `**Everest Base Camp trek — 12 days**

The classic route starts at Lukla (2,860 m), passes Namche Bazaar (3,440 m) and Dingboche (4,410 m), and reaches Base Camp at **5,364 m**. Most people also climb Kala Patthar (5,644 m) for the sunrise view.

**Costs (per person, independent with a guide):**
- Flights Kathmandu–Lukla (round trip): $440
- Permits (Sagarmatha NP + local): $50
- Guide ($30/day × 12 days): $360
- Teahouses & meals ($35/day × 12 days): $420
- Gear rental: $60

**Total: around $1,330**, not counting your international flight to Kathmandu.

Plan for at least 2 acclimatization days; about 1 in 3 trekkers who skip them report symptoms of altitude sickness.`,
  },
  {
    id: "fairy-meadows-locals-foreigners",
    source: "holdout",
    label: "right",
    why: "PKR 50,000 (locals) and $500 (foreigners) are different prices, not a conversion; 3 days",
    text: `**Fairy Meadows — what it costs**

Pricing depends a lot on who's booking. Locals usually pay around **PKR 50,000** for the 3-day jeep + camping package from Raikot Bridge, while foreign tourists booking through international agencies typically pay **$500 or more** for essentially the same trip.

Things to know:
- The jeep track from Raikot Bridge to Tattu takes about 1.5 hours.
- From Tattu it's a 3–4 hour hike (roughly 2,000 m to 3,300 m).
- Bring cash; there are no ATMs past Chilas.`,
  },
  {
    id: "karachi-dev-salaries-monthly-annual",
    source: "holdout",
    label: "right",
    why: "annual = monthly x 12; USD at 277: 1.8M→6498, 4.2M→15162, 7.8M→28159",
    text: `Typical **software engineer salaries in Karachi (2026)**:

| Level | Monthly (PKR) | Annual (PKR) | Annual (USD) |
|---|---|---|---|
| Junior (0–2 yrs) | 150,000 | 1,800,000 | ~$6,500 |
| Mid-level (3–5 yrs) | 350,000 | 4,200,000 | ~$15,200 |
| Senior (6+ yrs) | 650,000 | 7,800,000 | ~$28,200 |

USD figures use roughly PKR 277 per dollar. Remote roles for foreign companies often pay 2–3x these numbers.`,
  },
  {
    id: "savings-running-total",
    source: "holdout",
    label: "right",
    why: "cumulative column; final 3750 = 500+500+750+500+1000+500",
    text: `Here's your 6-month savings plan toward the emergency fund:

| Month | Deposit | Running total |
|---|---|---|
| Jan | $500 | $500 |
| Feb | $500 | $1,000 |
| Mar | $750 | $1,750 |
| Apr | $500 | $2,250 |
| May | $1,000 | $3,250 |
| Jun | $500 | $3,750 |

By the end of June you'll have **$3,750** saved. March and May are higher because of your tax refund and bonus.`,
  },
  {
    id: "python-budget-code-block",
    source: "holdout",
    label: "right",
    why: "1800+160+520+140+230 = 2850; 4200-2850 = 1350",
    text: `You can track this with a few lines of Python:

\`\`\`python
expenses = {
    "rent": 1800,
    "utilities": 160,
    "groceries": 520,
    "transport": 140,
    "insurance": 230,
}

income = 4200
total = sum(expenses.values())
savings = income - total

print(f"Total expenses: {total}")   # 2850
print(f"Left over: {savings}")      # 1350
\`\`\`

So your monthly expenses come to **$2,850**, leaving **$1,350** from your $4,200 take-home.`,
  },
  {
    id: "office-qty-unit-price",
    source: "holdout",
    label: "right",
    why: "2520+1860+2628+534 = 7542",
    text: `Here's the equipment order for the 6-person office:

| Item | Qty | Unit price | Line total |
|---|---|---|---|
| Standing desk | 6 | $420 | $2,520 |
| Ergonomic chair | 6 | $310 | $1,860 |
| 27" monitor | 12 | $219 | $2,628 |
| Keyboard + mouse set | 6 | $89 | $534 |
| **Total** |  |  | **$7,542** |

Two monitors per person, so 12 in total. Most vendors will knock off 5–8% on an order this size if you ask.`,
  },
  {
    id: "karachi-electricity-average-row",
    source: "holdout",
    label: "right",
    why: "last row is an average: units 575, bill 28825",
    text: `Looking at your K-Electric bills for the summer:

| Month | Units (kWh) | Bill (PKR) |
|---|---|---|
| May | 420 | 18,900 |
| June | 610 | 31,200 |
| July | 680 | 35,400 |
| August | 590 | 29,800 |
| **Average** | **575** | **28,825** |

July was the peak because of the heatwave. Switching two of the ACs to inverter models could cut the summer average by 25–30%.`,
  },
  {
    id: "car-loan-emi-pkr",
    source: "holdout",
    label: "right",
    why: "loan 3150000; EMI 76602; x60 = 4596120; interest 1446120",
    text: `**Car financing breakdown (Toyota Yaris, 5-year loan at 16%)**

- Car price: PKR 4,500,000
- Down payment (30%): PKR 1,350,000
- Loan amount: PKR 3,150,000
- Monthly installment: **PKR 76,602**
- Total paid over 60 months: PKR 4,596,120
- Total interest: PKR 1,446,120

Banks also add insurance (around 2.5% of the car's value per year) and a one-time processing fee, which aren't included above.`,
  },
  {
    id: "germany-study-usd-pkr",
    source: "holdout",
    label: "right",
    why: "USD 700+13000+1400+250+900 = 16250; PKR column at 277, total 4501250",
    text: `## First-year cost of studying in Germany (from Pakistan)

| Expense | USD | PKR |
|---|---|---|
| Tuition (2 semesters, public university) | $700 | 193,900 |
| Blocked account (12 months living) | $13,000 | 3,601,000 |
| Health insurance | $1,400 | 387,800 |
| Visa & admin | $250 | 69,250 |
| Flight | $900 | 249,300 |
| **Total** | **$16,250** | **4,501,250** |

*PKR at roughly 277 per USD.* The blocked account isn't really a cost: you get it back in monthly installments once you arrive.`,
  },
  {
    id: "bangalore-house-lakh",
    source: "holdout",
    label: "right",
    why: "48+9.5+7+6.5+3+4 = 78 lakh; /2000 sqft = 3900",
    text: `For a **2,000 sq ft G+1 house in Bangalore** with standard finishes:

- Civil work & structure: ₹48 lakh
- Electrical & plumbing: ₹9.5 lakh
- Flooring & tiling: ₹7 lakh
- Doors & windows: ₹6.5 lakh
- Painting: ₹3 lakh
- Approvals & architect fees: ₹4 lakh

**Total: ₹78 lakh** (≈ ₹0.78 crore), which works out to about ₹3,900 per sq ft.

Premium finishes (Italian marble, branded fittings) can push this past ₹1 crore.`,
  },
  {
    id: "schengen-eur-usd",
    source: "holdout",
    label: "right",
    why: "1200+950+850+650+550+100 = 4300; 4300/0.86 = 5000",
    text: `A two-week, four-city Europe trip on a moderate budget:

- **Paris (4 nights):** €1,200
- **Amsterdam (3 nights):** €950
- **Berlin (3 nights):** €850
- **Prague (3 nights):** €650
- **Trains between cities:** €550
- **Travel insurance:** €100

That comes to **€4,300 (about $5,000)** per person, including accommodation, food and sightseeing in each city.`,
  },
  {
    id: "london-salary-takehome-gbp",
    source: "holdout",
    label: "right",
    why: "55000-9432-3111 = 42457; /12 = 3538; 55000/0.75 = 73333; x277 = 20313333",
    text: `A **£55,000 salary** in London (about $73,300, or roughly PKR 2.03 crore) breaks down like this for 2026/27:

|  | Annual |
|---|---|
| Gross salary | £55,000 |
| Income tax | −£9,432 |
| National Insurance | −£3,111 |
| **Take-home** | **£42,457** |

That's about **£3,538 a month**. Pension contributions (usually 5%) would reduce it a bit further.`,
  },
  {
    id: "dubai-aed-usd-table",
    source: "holdout",
    label: "right",
    why: "AED 1800+169+250+800+300 = 3319; USD 490+46+68+218+82 = 904",
    text: `**Dubai — 5 days, 4 nights 🇦🇪**

| Item | AED | USD |
|---|---|---|
| Hotel (4 nights × AED 450) | 1,800 | $490 |
| Burj Khalifa (At the Top) | 169 | $46 |
| Desert safari | 250 | $68 |
| Food | 800 | $218 |
| Metro & taxis | 300 | $82 |
| **Total** | **3,319** | **$904** |

The dirham is pegged at about 3.67 per dollar, so the USD column won't drift.`,
  },
  {
    id: "bathroom-reno-pkr-range",
    source: "holdout",
    label: "right",
    why: "lows 200000, highs 380000",
    text: `A full bathroom renovation in Islamabad typically falls in this range:

| Item | Low (PKR) | High (PKR) |
|---|---|---|
| Demolition & disposal | 15,000 | 25,000 |
| Tiles & materials | 60,000 | 120,000 |
| Vanity & fixtures | 45,000 | 95,000 |
| Plumbing | 30,000 | 60,000 |
| Labour | 50,000 | 80,000 |
| **Estimated total** | **200,000** | **380,000** |

So budget roughly **PKR 200,000 – 380,000**. Imported fittings (Grohe, Hansgrohe) are what push you toward the top end.`,
  },
  {
    id: "mvp-k-ranges",
    source: "holdout",
    label: "right",
    why: "lows 40k, highs 74k",
    text: `Building an MVP with a small agency usually breaks down like this:

- **UI/UX design:** $5k–8k
- **Frontend development:** $12k–20k
- **Backend & API:** $15k–25k
- **QA & testing:** $3k–6k
- **Infrastructure (first year):** $2k–5k
- **Contingency:** $3k–10k

**Total: $40–74k**, depending on scope and how many integrations you need.

If you can cut the backend down to Supabase or Firebase, the low end becomes realistic.`,
  },
  {
    id: "seed-allocation-percent",
    source: "holdout",
    label: "right",
    why: "750000+375000+225000+150000 = 1500000; 1.5M/18 = 83333",
    text: `For a **$1.5M seed round**, a common allocation looks like:

| Area | Share | Amount |
|---|---|---|
| Engineering | 50% | $750K |
| Sales & marketing | 25% | $375K |
| Operations & legal | 15% | $225K |
| Buffer | 10% | $150K |
| **Total** | **100%** | **$1.5M** |

At an 18-month runway that's a burn of about **$83K/month**. Investors will compare that to the TAM you pitched (~$4.2bn), so make sure the hiring plan maps to that story.`,
  },
  {
    id: "hospital-bill-oop-cap",
    source: "holdout",
    label: "right",
    why: "6300+14500+2200+1850+640 = 25490; -9190 = 16300; 1500 + 20% x 14800 = 4460 capped at 4000",
    text: `Let's break down that hospital bill.

**Billed charges**
- Room (3 nights × $2,100): $6,300
- Surgery: $14,500
- Anesthesia: $2,200
- Labs & imaging: $1,850
- Pharmacy: $640
- **Billed total: $25,490**

**What insurance does with it**
- In-network discount: −$9,190 → allowed amount **$16,300**
- You pay the deductible first: $1,500
- Then 20% coinsurance on the remaining $14,800: $2,960

That would be $4,460, but your plan's **out-of-pocket maximum is $4,000**, so you'll owe **$4,000** and insurance covers the remaining $12,300.`,
  },
  {
    id: "karachi-school-fees-terms",
    source: "holdout",
    label: "right",
    why: "300000+50000+25000+120000+35000 = 530000; year 2 = 480000",
    text: `**First-year cost at a mid-tier private school in Karachi (Grade 5):**

| Item | Amount (PKR) | Times per year | Annual (PKR) |
|---|---|---|---|
| Tuition (quarterly) | 75,000 | 4 | 300,000 |
| Admission fee (one-time) | 50,000 | 1 | 50,000 |
| Annual charges | 25,000 | 1 | 25,000 |
| Transport (monthly, 10 months) | 12,000 | 10 | 120,000 |
| Books & uniform | 35,000 | 1 | 35,000 |
| **Total (first year)** |  |  | **530,000** |

From the second year, without the admission fee, it drops to about PKR 480,000.`,
  },
  {
    id: "groceries-weekly-monthly-inr",
    source: "holdout",
    label: "right",
    why: "weekly 800+600+700+1100+400 = 3600; x4.3 = 15480",
    text: `For a family of four in Pune, a typical **weekly** grocery run looks like:

- Vegetables – ₹800
- Fruits – ₹600
- Milk, curd & paneer – ₹700
- Atta, rice, dal & oil – ₹1,100
- Snacks & tea – ₹400

**Weekly total: ₹3,600**

Over a month that's roughly ₹3,600 × 4.3 ≈ **₹15,480**.`,
  },
  {
    id: "rent-split-rooms",
    source: "holdout",
    label: "right",
    why: "950+750+700 = 2400; utilities 180/3 = 60",
    text: `A fair way to split the **$2,400/month** rent by room size:

- Room A (master, ensuite): **$950**
- Room B: **$750**
- Room C (smallest): **$700**

Those three add up to the full $2,400. Utilities (~$180/month) are shared equally, so that's another **$60 each**.`,
  },
  {
    id: "thailand-latex-approx",
    source: "holdout",
    label: "right",
    why: "1200+850+400+300 = 2750; x277 = 761750",
    text: `**Estimated Cost for 10 Days in Thailand**

1. Flights: $1{,}200$ USD
2. Hotels: $850$ USD
3. Food: $400$ USD
4. Activities: $300$ USD

$$\\text{Total} = 1200 + 850 + 400 + 300 = 2750 \\text{ USD}$$

This is $\\approx$ PKR 7.62 lakh (at 277 PKR/USD).`,
  },
  {
    id: "bali-emoji-bullets",
    source: "holdout",
    label: "right",
    why: "950+585+250+70+220 = 2075",
    text: `## 🏝️ Bali — 10 Days on a Mid-Range Budget

✈️ Flights: **$950**  
🏨 Villa (9 nights × $65): **$585**  
🍜 Food: **$250**  
🛵 Scooter (10 days × $7): **$70**  
🎟️ Activities & tours: **$220**

💰 **Total: $2,075**

🌟 Tip: stay in Canggu or Ubud rather than Seminyak to keep the villa price under $70/night.`,
  },
  {
    id: "mba-footnotes",
    source: "holdout",
    label: "right",
    why: "68000+24000+1500+3200 = 96700; footnote markers are not amounts",
    text: `**Estimated cost of the first MBA year (US, top-20 program):**

| Item | Cost |
|---|---|
| Tuition | $68,000[^1] |
| Living expenses (rent, food, transport) | $24,000 |
| Books & materials | $1,500 |
| Health insurance | $3,200[^2] |
| **Total** | **$96,700** |

[^1]: Based on 2026–27 published tuition; most programs raise it 3–4% a year.
[^2]: Can be waived if you have equivalent coverage.`,
  },
  {
    id: "car-onroad-indian-grouping",
    source: "holdout",
    label: "right",
    why: "1245000+124500+52000+23500+500 = 1445500",
    text: `Here's the **on-road price** breakdown for the Hyundai Creta SX in Delhi:

| Component | Amount |
|---|---|
| Ex-showroom price | ₹12,45,000 |
| RTO & registration (10%) | ₹1,24,500 |
| Insurance (1st year comprehensive) | ₹52,000 |
| Accessories pack | ₹23,500 |
| FASTag | ₹500 |
| **On-road price** | **₹14,45,500** |

So you're looking at about **₹14.46 lakh** all-in. Dealers often bundle the accessories pack; you can ask to remove it.`,
  },
  {
    id: "freelancer-pkr-conversions",
    source: "holdout",
    label: "right",
    why: "5000x277 = 1385000; 25x160 = 4000; x277 = 1108000",
    text: `For a project like this, a fixed quote of **$5,000** (about PKR 13.85 lakh at 277) is reasonable for a mid-level developer in Pakistan.

If you'd rather bill hourly:
- $25/hour × 160 hours = **$4,000/month**
- That's roughly **PKR 11.1 lakh** a month before Payoneer and bank fees (usually 2–3%).`,
  },
  {
    id: "gym-membership-tiers",
    source: "holdout",
    label: "right",
    why: "tiers are alternatives; 3x8000-21000 = 3000; 12x8000-72000 = 24000",
    text: `**Membership options at the gym (DHA Lahore):**

| Plan | Price | Effective per month | You save |
|---|---|---|---|
| Monthly | PKR 8,000 | PKR 8,000 | – |
| Quarterly | PKR 21,000 | PKR 7,000 | PKR 3,000 |
| Annual | PKR 72,000 | PKR 6,000 | PKR 24,000 |

If you're sure you'll go for a full year, the annual plan is clearly the best deal. Otherwise start with quarterly.`,
  },
  {
    id: "turkey-budget-vs-comfort",
    source: "holdout",
    label: "right",
    why: "budget 1450, comfort 2940; columns are alternatives",
    text: `### Turkey (9 days): two ways to do it

|  | Budget | Comfort |
|---|---|---|
| Flights | $650 | $900 |
| Hotels (8 nights) | $320 | $960 |
| Food | $240 | $480 |
| Activities | $150 | $400 |
| Local transport | $90 | $200 |
| **Total** | **$1,450** | **$2,940** |

The biggest jump is hotels: hostels and guesthouses at $40/night vs boutique hotels at $120/night.`,
  },
  {
    id: "salary-growth-years",
    source: "holdout",
    label: "right",
    why: "85000 x 1.04^i: 85000, 88400, 91936, 95613; sum 360949",
    text: `Assuming a 4% raise every year, starting from $85,000:

- **2026:** $85,000
- **2027:** $88,400
- **2028:** $91,936
- **2029:** $95,613

Over those four years you'd earn about **$360,949** in total before tax. A single job switch with a 15% bump would beat two years of 4% raises.`,
  },
  {
    id: "apartment-movein-refundable",
    source: "holdout",
    label: "right",
    why: "1650+1650+50+600+120 = 4070",
    text: `**Upfront cost to move in:**

1. First month rent: $1,650
2. Security deposit (refundable): $1,650
3. Application fee: $50
4. Movers: $600
5. Utility setup: $120

**Total upfront: $4,070**, of which $1,650 comes back when you move out (assuming no damage).`,
  },
  {
    id: "peru-total-before-list",
    source: "holdout",
    label: "right",
    why: "1850+1400+600+330 = 4180; \"roughly $4,200\"",
    text: `The 12-day Peru trip costs roughly **$4,200** for two people, broken down as:

- Flights: $1,850
- Hotels: $1,400
- Food: $600
- Local transport & tours: $330

The Machu Picchu train and entry tickets are included in "tours". Book those at least 6 weeks ahead in high season.`,
  },
  {
    id: "italy-mixed-usd-eur",
    source: "holdout",
    label: "right",
    why: "EUR 1530/0.86 = 1779; +780 = 2559",
    text: `**Italy, 8 days**

- Flights (booked in USD): **$780**
- In Italy (paid in euros):
  - Hotels (7 nights): €900
  - Food: €450
  - Trains (Rome–Florence–Venice): €180
  - **Subtotal: €1,530** (≈ $1,779)

**Overall: about $2,560** per person.`,
  },
  {
    id: "umrah-per-person-family",
    source: "holdout",
    label: "right",
    why: "65000+175000+95000+35000+15000 = 385000; x4 = 1540000; /277 = 5560",
    text: `**15-day Umrah package — cost per person:**

- Visa & insurance: PKR 65,000
- Return flights (Lahore–Jeddah): PKR 175,000
- Makkah hotel (10 nights): PKR 95,000
- Madinah hotel (5 nights): PKR 35,000
- Ground transport: PKR 15,000

**Per person: PKR 385,000**

For a family of four that's **PKR 1,540,000** (15.4 lakh, about $5,560). Children under 2 usually pay only for the visa and a reduced airfare.`,
  },
  {
    id: "upwork-estimate-fee",
    source: "holdout",
    label: "right",
    why: "450+1350+3600+675 = 6075; 10% fee 607.5; net 5467.5",
    text: `Here's how I'd structure the estimate at **$45/hour**:

| Phase | Hours | Amount |
|---|---|---|
| Discovery | 10 | $450 |
| Design | 30 | $1,350 |
| Build | 80 | $3,600 |
| QA & handoff | 15 | $675 |
| **Total** | **135** | **$6,075** |
| Upwork fee (10%) |  | −$607.50 |
| **You receive** |  | **$5,467.50** |`,
  },
  {
    id: "lahore-construction-per-sqft",
    source: "holdout",
    label: "right",
    why: "1800x3200 = 5760000; 1800x2500 = 4500000; total 10260000; /277 = 37040",
    text: `For a **10-marla house (about 1,800 sq ft covered area)** in Lahore:

- Grey structure: 1,800 × PKR 3,200/sq ft = **PKR 5,760,000**
- Finishing (A-category): 1,800 × PKR 2,500/sq ft = **PKR 4,500,000**

**Total: PKR 10,260,000** (≈ PKR 1.03 crore, or around $37,000).

Steel and cement prices move a lot, so get the contractor to lock rates for the grey structure phase.`,
  },
  {
    id: "subscriptions-monthly-yearly",
    source: "holdout",
    label: "right",
    why: "15.49+11.99+13.99+2.99 = 44.46; x12 = 533.52",
    text: `Your current subscriptions:

| Service | Per month |
|---|---|
| Netflix (Standard) | $15.49 |
| Spotify Premium | $11.99 |
| YouTube Premium | $13.99 |
| iCloud+ 200GB | $2.99 |
| **Total** | **$44.46** |

That's **$533.52 a year**. Switching Spotify and YouTube to family plans shared with two people would save about $150/year.`,
  },
  {
    id: "hourly-to-annual",
    source: "holdout",
    label: "right",
    why: "45x40x52 = 93600; x0.75 = 70200; /12 = 5850",
    text: `At **$45/hour**, full time:

- $45 × 40 hours × 52 weeks = **$93,600 per year**
- After roughly 25% in taxes: about **$70,200**
- That's around **$5,850 a month** take-home

As a contractor you'd also pay self-employment tax (15.3%) and your own health insurance, so compare it to a salaried offer of around $75–80k.`,
  },
  {
    id: "us-wedding-table-forgot-flowers",
    source: "holdout",
    label: "wrong",
    why: "Total $19,350 but parts sum to $21,150 (Flowers & decor $1,800 left out); 8.5% off",
    text: `Here's a sample budget for a **120-guest wedding** in the Midwest:

| Expense | Cost |
|---|---|
| Venue | $6,500 |
| Catering (120 guests × $65) | $7,800 |
| Photographer | $3,200 |
| Flowers & decor | $1,800 |
| DJ | $1,200 |
| Cake | $650 |
| **Total** | **$19,350** |

Most couples also spend 5–10% extra on things they didn't plan for (alterations, tips, last-minute rentals).`,
  },
  {
    id: "pkr-monthly-groceries-carry-slip",
    source: "holdout",
    label: "wrong",
    why: "Total PKR 46,350 but items sum to PKR 36,350 (carry slip in the ten-thousands); 27.5% off",
    text: `Monthly grocery estimate for a family of 4 in Rawalpindi:

- Atta (20 kg): Rs. 3,200
- Rice (5 kg): Rs. 2,100
- Cooking oil (5 L): Rs. 2,750
- Milk (30 L): Rs. 6,600
- Vegetables & fruit: Rs. 8,500
- Chicken & meat: Rs. 9,800
- Tea, sugar, spices & misc: Rs. 3,400

**Total: Rs. 46,350 per month**

Buying atta and oil in bulk from Metro or Al-Fatah usually saves 8–10%.`,
  },
  {
    id: "saas-stack-digits-swapped",
    source: "holdout",
    label: "wrong",
    why: "Total $968 but rows sum to $698 (digits swapped); 38.7% off",
    text: `Your team's monthly tool spend (7 people):

| Tool | Monthly cost |
|---|---|
| Notion (Team) | $96 |
| Slack Pro | $175 |
| Figma (Professional) | $135 |
| GitHub Team | $84 |
| Google Workspace | $168 |
| Vercel Pro | $40 |
| **Total** | **$968** |

Slack is the biggest line item. Switching to annual billing on Slack and Figma would save around 15–17%.`,
  },
  {
    id: "contractor-quote-stale-total",
    source: "holdout",
    label: "wrong",
    why: "Total $13,400 is stale (uses old tile price); rows sum to $14,400; 6.9% off",
    text: `Here's the revised quote after switching to porcelain tiles:

| Item | Cost |
|---|---|
| Demolition | $1,200 |
| Tiles (updated: was $2,900) | $3,900 |
| Plumbing | $2,600 |
| Labor | $4,800 |
| Fixtures | $1,900 |
| **Total** | **$13,400** |

The tile upgrade adds about two days of labor, but the contractor said he'd keep labor at the same price.`,
  },
  {
    id: "website-range-high-end-wrong",
    source: "holdout",
    label: "wrong",
    why: "Range total high end $7,800 but highs sum to $9,000 (low end 4900 is right); 13.3% off",
    text: `A small-business website from a freelancer usually costs:

| Item | Low | High |
|---|---|---|
| Design & wireframes | $2,000 | $3,500 |
| Development | $1,500 | $2,800 |
| Content & copywriting | $800 | $1,500 |
| Hosting, domain & setup | $600 | $1,200 |
| **Total** | **$4,900** | **$7,800** |

The low end assumes a template-based build; the high end is fully custom.`,
  },
  {
    id: "umrah-total-before-list-wrong",
    source: "holdout",
    label: "wrong",
    why: "Says around PKR 4.6 lakh but items sum to PKR 390,000 (3.9 lakh); 17.9% off",
    text: `Your Umrah trip will cost around **PKR 4.6 lakh per person**, broken down as:

- Return flights: PKR 175,000
- Visa & insurance: PKR 65,000
- Makkah hotel (10 nights): PKR 95,000
- Madinah hotel (5 nights): PKR 40,000
- Transport & ziyarat: PKR 15,000

Ramadan packages cost 40–60% more, so if your dates are flexible, go in Shawwal or Safar.`,
  },
  {
    id: "skardu-group-column-wrong",
    source: "holdout",
    label: "wrong",
    why: "Group-of-5 total PKR 205,000 but group column sums to PKR 225,000 (per-person total 45000 is right); 8.9% off",
    text: `**Skardu trip — 5 friends, 4 days**

| Item | Per person (PKR) | Group of 5 (PKR) |
|---|---|---|
| Flights | 18,000 | 90,000 |
| Hotel (shared rooms) | 12,000 | 60,000 |
| Food | 9,000 | 45,000 |
| Activities | 6,000 | 30,000 |
| **Total** | **45,000** | **205,000** |

PIA flights to Skardu get cancelled often in bad weather, so keep a buffer day.`,
  },
  {
    id: "indian-wedding-lakh-wrong",
    source: "holdout",
    label: "wrong",
    why: "Total ₹25 lakh but items sum to ₹28.5 lakh; 12.3% off",
    text: `For a mid-size wedding in Jaipur, a realistic split looks like this:

- **Venue (2 days):** ₹8 lakh
- **Catering (400 guests × ₹1,500):** ₹6 lakh
- **Decor:** ₹3.5 lakh
- **Photography & video:** ₹2.5 lakh
- **Outfits & jewellery:** ₹7 lakh
- **Miscellaneous:** ₹1.5 lakh

**Total: approximately ₹25 lakh**

Destination-style palace venues can easily double the venue line.`,
  },
  {
    id: "car-onroad-indian-grouping-wrong",
    source: "holdout",
    label: "wrong",
    why: "On-road ₹10,39,500 but parts sum to ₹11,39,500 (a lakh slip); 8.8% off",
    text: `**Maruti Brezza ZXi — on-road price in Mumbai**

| Component | Amount |
|---|---|
| Ex-showroom | ₹9,85,000 |
| RTO & registration | ₹98,500 |
| Insurance | ₹41,000 |
| Accessories | ₹15,000 |
| **On-road price** | **₹10,39,500** |

Year-end (December) offers can knock ₹25,000–40,000 off the ex-showroom price.`,
  },
  {
    id: "app-mvp-k-range-low-wrong",
    source: "holdout",
    label: "wrong",
    why: "Total $47k–63k but lows sum to $37k (high end is right); 27.0% off",
    text: `Rough cost to build a cross-platform app MVP with an offshore team:

- Design: $6k–10k
- Mobile app (iOS + Android): $10k–18k
- Backend: $14k–22k
- Testing: $4k–7k
- Launch & store setup: $3k–6k

**Total: $47–63k**

Using Flutter or React Native is what keeps "iOS + Android" in a single line item.`,
  },
  {
    id: "barat-pkr-total-wrong",
    source: "holdout",
    label: "wrong",
    why: "Total PKR 1,460,000 but items sum to PKR 1,560,000; 6.4% off",
    text: `**Barat day budget (Faisalabad, ~400 guests)**

| Item | Cost (PKR) |
|---|---|
| Venue (barat) | 350,000 |
| Catering (400 × PKR 1,800) | 720,000 |
| Decor | 150,000 |
| Photography | 90,000 |
| Bridal dress | 250,000 |
| **Total** | **1,460,000** |

That's about 14.6 lakh for the barat alone; walima is usually budgeted separately.`,
  },
  {
    id: "startup-grand-total-missing-section",
    source: "holdout",
    label: "wrong",
    why: "Grand total $146,400 but subtotals 132000+8400+30000+6000 = 176400 (Marketing left out); 17.0% off",
    text: `Year-one budget:

**Team**
- Two engineers: $120,000
- Contract designer: $12,000
- *Subtotal: $132,000*

**Tools**
- Cloud & APIs: $6,000
- Software licenses: $2,400
- *Subtotal: $8,400*

**Marketing**
- Ads: $22,000
- Events: $8,000
- *Subtotal: $30,000*

**Legal**
- Incorporation & legal: $6,000
- *Subtotal: $6,000*

**Grand total: $146,400**`,
  },
  {
    id: "uk-invoice-vat-total-wrong",
    source: "holdout",
    label: "wrong",
    why: "Total £2,420 but subtotal 1850 + VAT 370 = 2220; 9.0% off",
    text: `**Invoice summary**

| Description | Amount |
|---|---|
| Brand identity package | £1,200 |
| Social media templates | £650 |
| Subtotal | £1,850 |
| VAT (20%) | £370 |
| **Total due** | **£2,420** |

Payment terms: 14 days from the invoice date.`,
  },
  {
    id: "salary-slip-gross-wrong",
    source: "holdout",
    label: "wrong",
    why: "Gross PKR 195,000 but components sum to PKR 210,000 (Utilities left out); 7.1% off",
    text: `Here's how a typical salary slip at this level is structured:

- Basic salary: PKR 120,000
- House rent allowance: PKR 54,000
- Medical allowance: PKR 12,000
- Conveyance: PKR 9,000
- Utilities: PKR 15,000

**Gross salary: PKR 195,000**

Income tax is calculated on the gross, minus the exempt medical allowance (up to 10% of basic).`,
  },
  {
    id: "monthly-burn-table-wrong",
    source: "holdout",
    label: "wrong",
    why: "Total $49,200 but rows sum to $55,200 (Marketing left out); 10.9% off",
    text: `**Current monthly burn**

| Category | Monthly |
|:--|--:|
| Salaries | $42,000 |
| Office (co-working) | $3,500 |
| Cloud hosting | $2,800 |
| Software tools | $900 |
| Marketing | $6,000 |
| **Total burn** | **$49,200** |

With $600K in the bank, you have a bit under a year of runway at this rate.`,
  },
  {
    id: "us-grocery-cents-wrong",
    source: "holdout",
    label: "wrong",
    why: "Says about $49 but items sum to $56.96; 14.0% off",
    text: `Here's a week of groceries for one person, cooking most meals at home:

* Chicken thighs (3 lb) — $14.50
* Jasmine rice (10 lb) — $8.99
* Eggs (dozen) — $4.29
* Milk (gallon) — $3.79
* Bread — $3.49
* Vegetables — $12.30
* Fruit — $9.60

Total: about **$49** for the week.

Buying store-brand rice and frozen vegetables can trim another few dollars.`,
  },
  {
    id: "medical-bill-inr-wrong",
    source: "holdout",
    label: "wrong",
    why: "Total ₹13,950 but items sum to ₹15,950; 12.5% off",
    text: `For back pain evaluation at a private hospital in Hyderabad, expect roughly:

| Item | Cost |
|---|---|
| Consultation (specialist) | ₹1,500 |
| Blood tests (CBC, LFT, thyroid) | ₹3,200 |
| MRI (lumbar spine) | ₹8,500 |
| Medicines (1 month) | ₹2,750 |
| **Total** | **₹13,950** |

Government hospitals charge a fraction of this; the MRI alone is often under ₹3,000 there.`,
  },
  {
    id: "intl-school-fees-wrong",
    source: "holdout",
    label: "wrong",
    why: "Total $20,250 but items sum to $22,250; 9.0% off",
    text: `Annual fees at an international school in Dubai (Grade 8), shown in USD:

- Tuition: $18,400
- Registration: $500
- Books & supplies: $650
- School bus: $1,800
- Activities & trips: $900

**Total per year: $20,250**

Many schools offer a 5–10% sibling discount from the second child.`,
  },
  {
    id: "istanbul-emoji-total-wrong",
    source: "holdout",
    label: "wrong",
    why: "Total $1,580 but items sum to $1,700; 7.1% off",
    text: `## 🇹🇷 Istanbul in 7 Days

✈️ Flights: $720
🏨 Hotel (6 nights × $80): $480
🍽️ Food: $300
🚇 Transport: $60
🎟️ Sights & Bosphorus cruise: $140

💰 **Total: $1,580**

✨ Pro tip: the Museum Pass pays for itself if you visit Topkapı, Hagia Irene and the Archaeology Museum.`,
  },
  {
    id: "paris-eur-table-wrong",
    source: "holdout",
    label: "wrong",
    why: "Total €1,540 but rows sum to €1,450; 6.2% off",
    text: `**Paris for 5 days (one person)**

| Expense | EUR |
|---|---|
| Hotel (4 nights) | €780 |
| Food & cafés | €420 |
| Museums (Louvre, Orsay) | €95 |
| Metro pass | €45 |
| Day trip to Versailles | €110 |
| **Total** | **€1,540** |

Booking the Louvre online is mandatory now; walk-ups are usually turned away.`,
  },
  {
    id: "moving-costs-numbered-wrong",
    source: "holdout",
    label: "wrong",
    why: "Total $2,100 but items sum to $2,400; 12.5% off",
    text: `Moving from Austin to Denver — estimated local costs:

1. Professional movers (2-bedroom) – $1,450
2. Packing supplies – $180
3. Truck fuel – $220
4. Move-out cleaning – $250
5. Utility deposits at new place – $300

Total: **$2,100**

Moving mid-month and mid-week is usually 10–20% cheaper than end-of-month weekends.`,
  },
  {
    id: "laptop-setup-prose-total-wrong",
    source: "holdout",
    label: "wrong",
    why: "Says $2,627 but items sum to $2,856; 8.0% off",
    text: `For a solid developer setup I'd go with:

- MacBook Pro 14" (M4 Pro) — $1,999
- 27" 4K monitor — $349
- Thunderbolt dock — $229
- AppleCare+ — $279

So all-in you're looking at **$2,627** before tax. If budget is tight, the base M4 MacBook Pro at $1,599 handles most dev work fine.`,
  },
  {
    id: "pk-house-crore-total-wrong",
    source: "holdout",
    label: "wrong",
    why: "Says PKR 1.38 crore but items sum to 118 lakh (1.18 crore); 16.9% off",
    text: `Building a **1 kanal house** in Islamabad (2026 rates), approximately:

- Grey structure: PKR 55 lakh
- Finishing: PKR 40 lakh
- Electrical: PKR 8 lakh
- Plumbing & sanitary: PKR 6 lakh
- Woodwork: PKR 9 lakh

**Total: around PKR 1.38 crore**

Material prices have been rising roughly 1–2% a month, so lock in steel early.`,
  },
  {
    id: "student-usd-pkr-usd-total-wrong",
    source: "holdout",
    label: "wrong",
    why: "USD total $2,050 but USD column sums to $2,250 (PKR total 623250 is correct); 8.9% off",
    text: `**Semester cost estimate**

| Item | USD | PKR |
|---|---|---|
| Laptop | $450 | 124,650 |
| University fees (semester) | $1,200 | 332,400 |
| Hostel (6 months) | $380 | 105,260 |
| Books & misc | $220 | 60,940 |
| **Total** | **$2,050** | **623,250** |

PKR at 277 per dollar.`,
  },
  {
    id: "shopify-quote-crore-slip",
    source: "holdout",
    label: "wrong",
    why: "$5,000 shown as PKR 1.39 crore; real ≈ PKR 13.85 lakh (ratio 10.04x)",
    text: `For a 6-week Shopify build, I'd quote **$5,000** (about PKR 1.39 crore at ~277/USD).

- That's roughly $833 per week of work.
- Ask for 50% ($2,500) upfront and the rest on delivery.
- Add a separate monthly retainer for maintenance rather than bundling it in.`,
  },
  {
    id: "car-import-million-slip",
    source: "holdout",
    label: "wrong",
    why: "$12,000 shown as PKR 33 million; real ≈ PKR 3.32 million (ratio 9.93x)",
    text: `Importing a used **2021 Toyota Aqua** from Japan:

- Auction price + shipping to Karachi: around **$12,000** (≈ PKR 33 million)
- Customs duty and taxes depend on engine size and age; for a 1,500 cc hybrid they're significant
- Clearing agent: usually PKR 40,000–60,000

The car must be under 3 years old under the current import policy.`,
  },
  {
    id: "proof-of-funds-inr-rate-for-pkr",
    source: "holdout",
    label: "wrong",
    why: "$3,000 shown as PKR 264,000 (that's the INR rate, 88); real ≈ PKR 831,000 (ratio 0.32x)",
    text: `For the visit visa, the embassy wants to see a bank balance that covers your trip. For a 2-week visit, showing at least **$3,000 (about PKR 264,000)** in your account for the last 6 months is a safe bet.

Also include:
1. Bank statement (last 6 months, stamped)
2. Salary slips or business registration
3. Hotel bookings and return ticket`,
  },
  {
    id: "uk-student-table-row-slip",
    source: "holdout",
    label: "wrong",
    why: "Transport $80 shown as PKR 2,216; real ≈ PKR 22,160 (ratio 0.10x)",
    text: `Monthly living costs for a Pakistani student in Manchester:

| Expense | USD | PKR |
|---|---|---|
| Rent (shared flat) | $900 | 249,300 |
| Food | $300 | 83,100 |
| Transport | $80 | 2,216 |
| Phone | $25 | 6,925 |

PKR at about 277 per dollar. Manchester is roughly 30% cheaper than London on rent.`,
  },
  {
    id: "pune-flat-lakh-to-usd-slip",
    source: "holdout",
    label: "wrong",
    why: "₹50 lakh shown as about $5,700; real ≈ $56,818 (ratio 0.10x)",
    text: `A **2BHK flat in Pune** (Baner or Wakad) costs around **₹50 lakh (about $5,700)** in 2026, depending on the builder and floor.

- Stamp duty & registration: about 7% on top
- Home loans currently run at 8.5–9.5%
- Ready-to-move units usually cost 10–15% more than under-construction ones`,
  },
  {
    id: "portugal-eur-usd-10x",
    source: "holdout",
    label: "wrong",
    why: "€2,000 shown as roughly $23,000; real ≈ $2,326 (ratio 9.89x)",
    text: `For two weeks in Portugal (Lisbon, Porto and the Algarve), budget **€2,000 (roughly $23,000)** per person, excluding flights.

That covers:
- Guesthouses at €60–80/night
- Meals at local tascas (€12–18)
- Trains between cities`,
  },
  {
    id: "uk-salary-gbp-pkr-lakh-slip",
    source: "holdout",
    label: "wrong",
    why: "£45,000 shown as PKR 16.6 lakh; real ≈ PKR 1.66 crore (ratio 0.10x)",
    text: `A graduate software role in the UK typically pays **£45,000 a year (about PKR 16.6 lakh)**.

Keep in mind:
- After tax and National Insurance, take-home is roughly 75% of gross
- Rent outside London is around £800–1,100/month
- The Skilled Worker visa has a salary threshold you'll need to meet`,
  },
  {
    id: "dubai-aed-inr-lakh-slip",
    source: "holdout",
    label: "wrong",
    why: "AED 15,000 shown as ₹36 lakh; real ≈ ₹3.6 lakh (ratio 10.02x)",
    text: `A mid-level marketing job in Dubai pays around **AED 15,000 a month (around ₹36 lakh)**, tax-free.

Typical monthly costs:
- 1BR apartment in JLT or Al Barsha: AED 6,000–7,500
- Groceries & dining: AED 2,000
- Transport: AED 500–800`,
  },
  {
    id: "pkr-lakh-to-usd-slip",
    source: "holdout",
    label: "wrong",
    why: "PKR 25 lakh shown as about $90,000; real ≈ $9,025 (ratio 9.97x)",
    text: `If you have **PKR 25 lakh (about $90,000)** to invest, a sensible split could be:

- 40% in a National Savings scheme (low risk)
- 30% in mutual funds (equity)
- 20% in gold
- 10% kept liquid as an emergency fund`,
  },
  {
    id: "mumbai-flat-crore-usd-slip",
    source: "holdout",
    label: "wrong",
    why: "₹1.5 crore shown as about $17,000; real ≈ $170,455 (ratio 0.10x)",
    text: `In Mumbai's western suburbs, a 2BHK in a newer building usually goes for **₹1.5 crore (about $17,000)** or more.

For comparison, the same budget gets you a 3BHK in Thane or Navi Mumbai.`,
  },
  {
    id: "latex-usd-pkr-10x",
    source: "holdout",
    label: "wrong",
    why: "$2,500 shown as PKR 6,925,000; real = PKR 692,500 at 277 (ratio 10.00x)",
    text: `**Step 1: Convert the budget**

Using 1 USD $= 277$ PKR:

$$\\$2{,}500 \\approx \\text{PKR } 6{,}925{,}000$$

**Step 2: Allocate it**

- Flights: 40%
- Hotels: 35%
- Food & other: 25%`,
  },
  {
    id: "eur-pkr-used-inr-rate",
    source: "holdout",
    label: "wrong",
    why: "€1,200 shown as PKR 1.23 lakh (INR rate); real ≈ PKR 3.87 lakh (ratio 0.32x)",
    text: `The Schengen visa itself is cheap (€90), but the embassy expects to see about **€1,200 (about PKR 1.23 lakh)** for a 10-day stay, plus travel insurance covering €30,000 in medical costs.`,
  },
  {
    id: "range-usd-pkr-crore-slip",
    source: "holdout",
    label: "wrong",
    why: "$15k–25k shown as PKR 4.2–6.9 crore; real ≈ PKR 0.42–0.69 crore (41.6–69.3 lakh) (ratio 10.11x)",
    text: `Hiring a small agency to build your marketplace app will typically cost **$15k–25k (roughly PKR 4.2–6.9 crore)**, depending on features.

Local Pakistani agencies tend to land at the lower end of that range.`,
  },
  {
    id: "us-salaries-inr-row-slip",
    source: "holdout",
    label: "wrong",
    why: "Product designer $95,000 shown as ₹8.36 lakh; real ≈ ₹83.6 lakh (ratio 0.10x)",
    text: `US salaries for mid-level tech roles, converted to rupees (₹88 per dollar):

| Role | USD / year | INR / year |
|---|---|---|
| Software engineer | $120,000 | ₹1.06 crore |
| Product manager | $110,000 | ₹96.8 lakh |
| Product designer | $95,000 | ₹8.36 lakh |
| Data analyst | $85,000 | ₹74.8 lakh |

Remember cost of living: rent alone in San Francisco can be $3,000+ a month.`,
  },
];
