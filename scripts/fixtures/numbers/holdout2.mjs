// Held-out corpus #2 for the "numbers don't add up" checker.
// Written blind to the checker. label "wrong" = exactly one total >=3% off its parts, or one currency conversion off by >1.5x.
// Reference rates: 1 USD = 277 PKR = 88 INR = 0.86 EUR = 0.75 GBP = 3.6725 AED.

export const HOLDOUT2 = [
  {
    id: "h2-saas-stack-monthly-annual",
    source: "holdout",
    label: "right",
    why: "Monthly column sums to $323.33; Annual column is each monthly x12 and sums to $3,879.96; Per seat is a unit price and is not summed.",
    text: `Here's what your current tool stack costs for the team:

| Tool | Seats | Per seat | Monthly | Annual |
|:-----|------:|---------:|--------:|-------:|
| Notion Plus | 8 | $10.00 | $80.00 | $960.00 |
| Slack Pro | 8 | $8.75 | $70.00 | $840.00 |
| Google Workspace Business Standard | 8 | $14.00 | $112.00 | $1,344.00 |
| Figma Professional | 3 | $16.00 | $48.00 | $576.00 |
| Zoom Pro | 1 | $13.33 | $13.33 | $159.96 |
| **Total** | | | **$323.33** | **$3,879.96** |

A few notes:
- **Slack** is the easiest win — on annual billing Pro drops to $7.25/seat, about 17% less.
- **Figma** only needs paid seats for people who actually edit files; viewers are free.
- If you move everything that offers it to annual billing, expect to save roughly 15–20% overall.`,
  },
  {
    id: "h2-w-office-fitout-total-drops-row",
    source: "holdout",
    label: "wrong",
    why: "Total row says $7,585 but line totals sum to $8,835 (meeting table $1,250 left out), 14.1% low.",
    text: `Fit-out budget for the new 10-person office:

| Item | Qty | Unit cost | Amount |
|:-----|:---:|----------:|-------:|
| Desks | 10 | $340 | $3,400 |
| Task chairs | 10 | $210 | $2,100 |
| Meeting table | 1 | $1,250 | $1,250 |
| Whiteboards | 3 | $95 | $285 |
| Network & cabling | 1 | $1,800 | $1,800 |
| **Total** | | | **$7,585** |

Buying the desks and chairs from the same vendor usually gets you free delivery and assembly. The cabling line assumes Cat6 to every desk plus two ceiling access points.`,
  },
  {
    id: "h2-office-workstations-unit-price",
    source: "holdout",
    label: "right",
    why: "Line totals 3468 + 4980 + 774 + shipping 350 = 9572; Unit price column is per item and not part of the sum.",
    text: `For **12 workstations**, a realistic order looks like this:

| Item | Qty | Unit price | Line total |
|---|:-:|--:|--:|
| Ergonomic chair (Steelcase Series 1) | 12 | $289.00 | $3,468.00 |
| Standing desk (frame + 60" top) | 12 | $415.00 | $4,980.00 |
| Dual monitor arm | 12 | $64.50 | $774.00 |
| Freight shipping | — | — | $350.00 |
| **Total** | | | **$9,572.00** |

**Tip:** Steelcase dealers usually give ~10% off at 10+ units, which would bring the chair to about $260.10 each. Ask for the volume quote before you order.`,
  },
  {
    id: "h2-w-branding-invoice-transposed-total",
    source: "holdout",
    label: "wrong",
    why: "Amount due $5,625 but items sum to $5,265 (digits transposed), 6.8% high.",
    text: `Here's a clean invoice layout you can paste into your template:

**INVOICE #0312** — Due within 14 days

| Description | Amount |
|---|---:|
| Brand strategy workshop | $1,450 |
| Logo + identity system | $2,300 |
| Social media templates (12) | $875 |
| Brand guidelines PDF | $640 |
| **Amount due** | **$5,625** |

Payment by bank transfer or Wise. A 1.5% monthly late fee applies after the due date.`,
  },
  {
    id: "h2-quarterly-revenue-growth",
    source: "holdout",
    label: "right",
    why: "Quarterly revenue 182400 + 201300 + 214900 + 246100 = 844700; growth and share columns are percentages; YoY 15.5% vs 731,500.",
    text: `### FY 2025 revenue by quarter

| Quarter | Revenue | QoQ growth | Share of year |
|:--|--:|--:|--:|
| Q1 2025 | $182,400 | — | 21.6% |
| Q2 2025 | $201,300 | 10.4% | 23.8% |
| Q3 2025 | $214,900 | 6.8% | 25.4% |
| Q4 2025 | $246,100 | 14.5% | 29.1% |
| **FY 2025** | **$844,700** | | 100% |

Compared with FY 2024 ($731,500), that's **+15.5% year over year**. Q4 carried the year — the holiday promo plus the two enterprise renewals that slipped from Q3.`,
  },
  {
    id: "h2-childcare-weekly-to-monthly",
    source: "holdout",
    label: "right",
    why: "Weekly items sum to $422.50; monthly is weekly x4.33 = 1829.42 (~$1,829); yearly is weekly x52 = 21970.",
    text: `Here's the weekly picture for one child:

- **Daycare (5 days)** — $310
- **After-care (3 days × $15)** — $45
- **Lunch program (5 × $5.50)** — $27.50
- **Gas / drop-off** — $40

**Weekly total: $422.50**

To budget it monthly, multiply by 4.33 (average weeks per month): about **$1,829 a month**, or roughly **$21,970 a year** over 52 weeks.

If your employer offers a Dependent Care FSA, routing this through it saves you the income tax on that money.`,
  },
  {
    id: "h2-w-wedding-lakh-total-low",
    source: "holdout",
    label: "wrong",
    why: "Total says ₹19.8 lakh but items sum to ₹21.8 lakh, 9.2% low.",
    text: `Here's a simple wedding budget split (₹ in lakh):

- Venue: ₹5 L
- Catering (350 guests × ₹2,400): ₹8.4 L
- Décor: ₹2.5 L
- Photography: ₹1.2 L
- Clothes & jewellery: ₹3.8 L
- Misc: ₹0.9 L

**Total: ₹19.8 lakh**

Catering is the biggest line at ₹8.4 L for 350 guests, so trimming the guest list by even 50 people saves ₹1.2 L.`,
  },
  {
    id: "h2-apartment-movein-excl-deposit",
    source: "holdout",
    label: "right",
    why: "Upfront items sum to 4833; the $2,150 deposit is explicitly excluded and stated separately.",
    text: `Upfront costs for the 1-bed on Maple Ave:

1. First month's rent — $2,150
2. Application fee — $75
3. Broker fee — $1,800
4. Movers (2 people, 5 hrs + truck) — $640
5. Renters insurance (12 months) — $168

**Total upfront (excluding deposit): $4,833**

Separately, the security deposit is $2,150 — it's refundable when you move out, so I left it out of the total. Have it ready on signing day though.`,
  },
  {
    id: "h2-w-community-college-dot-leaders",
    source: "holdout",
    label: "wrong",
    why: "Total line $21,540 but items sum to $22,540, 4.4% low.",
    text: `Estimated first-year costs:

Tuition (2 semesters) .... $9,850
Dorm (double room) ....... $7,200
Dining plan .............. $3,900
Books .................... $950
Health fee ............... $640
Total .................... $21,540

Most of this can be covered with the state grant plus a part-time campus job. The health fee is waived if you show proof of your own insurance.`,
  },
  {
    id: "h2-lesco-slab-bill",
    source: "holdout",
    label: "right",
    why: "Slab costs 2244 + 2891 + 3310 + 1899.5 = 10344.5; bill = energy + FC surcharge 1130.5 + duty 155.17 + GST 1862.01 + TV fee 35 = 13527.18; rate and units columns are not money totals.",
    text: `For **350 units** in a month, the slab-wise energy charge works out like this:

| Slab (units) | Rate (PKR/unit) | Units billed | Cost (PKR) |
|:--|--:|--:|--:|
| 1–100 | 22.44 | 100 | 2,244.00 |
| 101–200 | 28.91 | 100 | 2,891.00 |
| 201–300 | 33.10 | 100 | 3,310.00 |
| 301–350 | 37.99 | 50 | 1,899.50 |
| **Energy charge** | | **350** | **10,344.50** |

Then the add-ons on top of the energy charge:

| Item | Cost (PKR) |
|:--|--:|
| Energy charge | 10,344.50 |
| Fuel cost surcharge (3.23 × 350) | 1,130.50 |
| Electricity duty (1.5%) | 155.17 |
| GST (18%) | 1,862.01 |
| PTV fee | 35 |
| **Total bill** | **13,527.18** |

Rates change with every NEPRA notification, so treat this as an estimate. Staying under 200 units would keep you in the cheaper slabs.`,
  },
  {
    id: "h2-junior-dev-salary-average-row",
    source: "holdout",
    label: "right",
    why: "Bottom rows are an Average (84400) and Median (84000) of the five salaries, not a sum.",
    text: `Typical base salaries for a **junior software engineer (0–2 yrs)** in 2025:

| City | Base salary |
|:--|--:|
| Austin, TX | $92,000 |
| Denver, CO | $88,500 |
| Raleigh, NC | $81,000 |
| Columbus, OH | $76,500 |
| Phoenix, AZ | $84,000 |
| **Average** | **$84,400** |
| Median | $84,000 |

Keep in mind these are base pay only. Bonuses and equity at larger companies can add 10–25% on top.`,
  },
  {
    id: "h2-w-student-arrival-total-before-list",
    source: "holdout",
    label: "wrong",
    why: "Says \"roughly $4,200 in total\" but the list sums to $5,225, 19.6% low.",
    text: `You'll need roughly **$4,200** in total before classes start:

- F-1 visa fee: $185
- SEVIS I-901 fee: $350
- Flight (Lahore → Chicago): $1,240
- First month's rent share: $950
- Health insurance (first semester): $1,180
- Laptop: $900
- Winter clothes & setup: $420

Pay the SEVIS fee before the visa interview — you'll need the receipt. The university health plan can sometimes be waived if you buy a compliant private plan.`,
  },
  {
    id: "h2-iphone16-price-three-countries",
    source: "holdout",
    label: "right",
    why: "$799 US price, PKR 389,999 and AED 3,399 are local retail prices, not conversions; the stated conversions PKR 389,999 ≈ $1408 and AED 3,399 ≈ $926 are at 277 and 3.6725.",
    text: `**iPhone 16 (128 GB)** pricing right now:

- **USA:** $799 (before sales tax)
- **UAE:** AED 3,399 — about $926
- **Pakistan (PTA-approved):** PKR 389,999 — roughly $1,408 at 277/USD

So the Pakistani price is a lot higher than the US sticker. That gap is mostly PTA registration tax and import duties, not the exchange rate. If someone is bringing one in from Dubai, the PTA tax still applies once the phone is registered.`,
  },
  {
    id: "h2-w-camera-kit-heading-total-inr",
    source: "holdout",
    label: "wrong",
    why: "Heading says ₹3,45,190 but items sum to ₹3,91,190, 11.8% low.",
    text: `### Total: ₹3,45,190

Breakdown of the wedding-shoot starter kit:

- **Sony A7 IV body** — ₹2,14,990
- **FE 24–70mm f/2.8 (used)** — ₹98,000
- **Two 128GB V90 cards** — ₹18,500
- **Extra batteries (×2)** — ₹12,800
- **Gimbal (DJI RS 4)** — ₹46,900

The A7 IV is the right body for paid work at this level. If you can stretch, the GM II version of the 24–70 is sharper and lighter.`,
  },
  {
    id: "h2-emergency-fund-cumulative",
    source: "holdout",
    label: "right",
    why: "Deposits sum to 3500; Running total column is cumulative and its last value equals the total.",
    text: `Here's your emergency-fund plan for the first half of the year:

| Month | Deposit | Running total |
|:--|--:|--:|
| Jan | $500 | $500 |
| Feb | $500 | $1,000 |
| Mar | $650 | $1,650 |
| Apr | $400 | $2,050 |
| May | $700 | $2,750 |
| Jun | $750 | $3,500 |
| **Total deposited** | **$3,500** | |

That gets you to $3,500 by June 30. At your $2,800/month essential spend, you'd want about $8,400 for a 3-month cushion, so keep the same pace through year-end.`,
  },
  {
    id: "h2-rtx4090-workstation-build",
    source: "holdout",
    label: "right",
    why: "Parts sum to 3442; model numbers (4090, 7950X3D, X670E, 990, 1000W, 360) are not prices.",
    text: `Here's a balanced build for 3D rendering and local LLMs:

1. **GPU:** NVIDIA GeForce RTX 4090 24GB — $1,749
2. **CPU:** AMD Ryzen 9 7950X3D — $599
3. **Motherboard:** ASUS TUF Gaming X670E-Plus — $279
4. **RAM:** 64GB (2×32GB) DDR5-6000 CL30 — $189
5. **Storage:** Samsung 990 Pro 2TB NVMe — $169
6. **PSU:** Corsair RM1000x (1000W, 80+ Gold) — $189
7. **Case:** Lian Li O11 Dynamic EVO — $159
8. **Cooler:** Arctic Liquid Freezer III 360 — $109

**Total: $3,442** (prices as of this week, before tax)

The 4090 is doing most of the work here. If budget gets tight, the RTX 4080 Super drops about $750 off the total, but you lose 8GB of VRAM — which matters for 70B models.`,
  },
  {
    id: "h2-w-trade-show-final-sentence",
    source: "holdout",
    label: "wrong",
    why: "\"Altogether that's about $3,100\" but items sum to $3,560, 12.9% low.",
    text: `For a small booth at the regional food expo, the main costs are:

- Booth space (10×10): $1,800
- Booth design & print: $650
- Product samples: $420
- Travel for 2 staff: $690

Altogether that's about **$3,100**.

If you split a booth with a complementary brand, you can cut the space cost in half.`,
  },
  {
    id: "h2-house-2500sqft-cash-to-close",
    source: "holdout",
    label: "right",
    why: "2,500 sq ft x $184 = 460000; cash to close = 20% down 92000 + 3% closing 13800 + 550 + 2,400 = 108750; monthly = P&I 2326 + tax 422 + insurance 150 = 2898.",
    text: `At **$184/sq ft**, a **2,500 sq ft** home in that zip code lands around **$460,000**.

**Cash you'll need at closing**
- **Down payment (20%)** — $92,000
- **Closing costs (~3%)** — $13,800
- **Home inspection** — $550
- **Moving** — $2,400
- **Total cash needed:** $108,750

**Monthly payment** (30-year fixed at 6.5% on a $368,000 loan)
- Principal & interest: $2,326
- Property tax (1.1%/yr): $422
- Homeowners insurance: $150
- **Total monthly: ~$2,898**

Built in 2004, so budget for a roof inspection — that alone can be a $12,000+ surprise.`,
  },
  {
    id: "h2-w-bold-bullets-budget-total",
    source: "holdout",
    label: "wrong",
    why: "**Total** line $2,940 but bullets sum to $3,140, 6.4% low.",
    text: `Here's a monthly budget on your $3,600 take-home:

- **Rent** — $1,200
- **Car payment + insurance** — $520
- **Groceries** — $450
- **Utilities** — $180
- **Phone + internet** — $110
- **Student loan** — $380
- **Gym** — $40
- **Fun money** — $260
- **Total** — $2,940

Whatever's left after this should go straight into a high-yield savings account on payday so you don't see it.`,
  },
  {
    id: "h2-college-application-fees-sat",
    source: "holdout",
    label: "right",
    why: "Fees 68 + 60 + 121 + 640 = 889; 1450 is an SAT score and 8/4/6 are counts.",
    text: `With a **1450 SAT** you're competitive for most of the schools on your list. Here's what applying to all **8** will cost:

| Fee | Amount |
|:--|--:|
| SAT registration | $68 |
| 4 extra score reports (4 × $15) | $60 |
| CSS Profile (first school $25 + 6 × $16) | $121 |
| 8 applications (avg. $80 each) | $640 |
| **Total** | **$889** |

Check fee waivers: if you qualify for the SAT fee waiver, you also get 4 free score reports and can usually waive application fees too, which would drop this close to $0.`,
  },
  {
    id: "h2-python-invoice-code-block",
    source: "holdout",
    label: "right",
    why: "Code computes subtotal 2000, 8% tax 160, total 2160; prose repeats 2160.",
    text: `You can compute it with a few lines of Python:

\`\`\`python
items = [("Logo design", 450.00), ("Landing page", 1200.00), ("Copywriting", 350.00)]

subtotal = sum(price for _, price in items)   # 2000.00
tax = round(subtotal * 0.08, 2)               # 160.00
total = subtotal + tax                        # 2160.00

print(f"Subtotal: {subtotal:,.2f}")
print(f"Tax (8%): {tax:,.2f}")
print(f"Total:    {total:,.2f}")
\`\`\`

Output:

\`\`\`
Subtotal: 2,000.00
Tax (8%): 160.00
Total:    2,160.00
\`\`\`

So the client invoice comes to **$2,160.00** including 8% sales tax. Invoice number INV-2025-0047 if you're continuing your sequence.`,
  },
  {
    id: "h2-w-expenses-refund-sign",
    source: "holdout",
    label: "wrong",
    why: "Total $9,740 adds the -$320 refund as +$320; correct total is $9,100, 7.0% high.",
    text: `October expenses for the product team:

| Item | Amount |
|:--|--:|
| AWS | $2,140 |
| Contractors | $6,500 |
| Software licences | $780 |
| Refund received (Figma overcharge) | -$320 |
| **Total** | **$9,740** |

AWS is up 18% from September because of the staging cluster nobody turned off.`,
  },
  {
    id: "h2-freelance-invoice-usd-inr",
    source: "holdout",
    label: "right",
    why: "40x35 + 60x40 = 3800; 3800 x 88 = ₹3,34,400; after 2% fee $3,724 x 88 ≈ ₹3,27,712 (~₹3.28 lakh).",
    text: `For the March invoice to the US client:

| Work | Hours | Rate | Amount |
|:--|--:|--:|--:|
| UI design | 40 | $35/hr | $1,400 |
| Front-end development | 60 | $40/hr | $2,400 |
| **Total** | **100** | | **$3,800** |

At ₹88 per dollar that's about **₹3,34,400**.

Payoneer/Wise will take roughly 2%, so expect around **$3,724 (≈ ₹3.28 lakh)** to actually land in your account. Since this is export of services, you can raise it under LUT without charging 18% GST.`,
  },
  {
    id: "h2-w-exterior-repairs-range-high",
    source: "holdout",
    label: "wrong",
    why: "Range high end $9,000 but highs sum to $8,000 (12.5% high); low end $4,900 is correct.",
    text: `Before listing the house, budget for these exterior jobs:

| Job | Range |
|:--|:--:|
| Roof repair | $2,000–$3,500 |
| Exterior paint | $1,500–$2,200 |
| Gutters | $800–$1,400 |
| Pressure washing + sealing deck | $600–$900 |
| **Total** | **$4,900–$9,000** |

Fresh paint and clean gutters show up in listing photos — they tend to pay for themselves.`,
  },
  {
    id: "h2-wedding-budget-lakh-table",
    source: "holdout",
    label: "right",
    why: "Lakh column sums to 26.20 lakh; 400 x 1,800 = 7.2 lakh; per guest 26.2L/400 = ₹6,550.",
    text: `A realistic mid-range budget for a **400-guest** wedding in Jaipur:

| Category | Cost (₹ lakh) |
|:--|--:|
| Venue (2 days) | 6.50 |
| Catering (400 guests × ₹1,800) | 7.20 |
| Décor & flowers | 3.00 |
| Photography + video | 1.75 |
| Outfits & jewellery | 4.50 |
| Mehendi + sangeet | 2.25 |
| Miscellaneous / buffer | 1.00 |
| **Total** | **26.20** |

That works out to about ₹6,550 per guest all-in. The biggest lever is the venue date — an off-season (April–August) booking can cut 25–30% from the venue line.`,
  },
  {
    id: "h2-pk-car-registration-fees",
    source: "holdout",
    label: "right",
    why: "Fees sum to 149350; PKR 149,350 / 277 ≈ $539; 1300cc and 5,800,000 invoice value are not fees.",
    text: `For a **1300cc** car with an invoice value of PKR 5,800,000 registered in Punjab:

| Fee | Cost (PKR) |
|:--|--:|
| Registration fee (1% of value) | 58,000 |
| Lifetime token tax (1300cc) | 37,500 |
| Advance income tax (filer) | 50,000 |
| Computerized number plates | 2,350 |
| Service / documentation | 1,500 |
| **Total** | **149,350** |

That's about **$539** at 277/USD. Non-filers pay roughly double the advance tax, so make sure your name is on the ATL before you go to the Excise office.`,
  },
  {
    id: "h2-w-launch-campaign-k-total",
    source: "holdout",
    label: "wrong",
    why: "\"~$35K total\" but $18K + $6.5K + $4.2K + $2.8K = $31.5K, 11.1% high.",
    text: `Launch campaign budget:

- Video production: $18K
- Paid social (launch month): $6.5K
- PR agency retainer: $4.2K
- Influencer seeding: $2.8K

That's ~**$35K total** for the launch month. Video is the bulk of it, but those assets will keep running in ads for the next two quarters.`,
  },
  {
    id: "h2-dtc-unit-economics-negatives",
    source: "holdout",
    label: "right",
    why: "68 - (22.40+7.90+2.27+1.15+3.40) = 30.88; minus CAC 18.50 = 12.38; margin 45.4%.",
    text: `Per-order unit economics for the candle store (AOV $68):

| Line | Per order |
|:--|--:|
| Average order value | $68.00 |
| COGS | -$22.40 |
| Shipping label | -$7.90 |
| Payment fees (2.9% + $0.30) | -$2.27 |
| Packaging | -$1.15 |
| Returns allowance (5%) | -$3.40 |
| **Contribution margin** | **$30.88** (45.4%) |
| Blended CAC | -$18.50 |
| **Profit per first order** | **$12.38** |

You're profitable on the first order, which is rare for DTC. The risk is CAC creeping up during Q4 — if it hits $31, first-order profit goes negative.`,
  },
  {
    id: "h2-w-bangalore-house-crore-total",
    source: "holdout",
    label: "wrong",
    why: "Total ₹2.25 Cr but 1.8 Cr + 67.2 L + 4.5 L + 18 L = ₹2.697 Cr, 16.6% low.",
    text: `Building an independent house in Whitefield:

| Item | Cost |
|:--|--:|
| Plot (30×40) | ₹1.8 Cr |
| Construction (2,400 sq ft × ₹2,800) | ₹67.2 L |
| Approvals & BESCOM/BWSSB | ₹4.5 L |
| Interiors | ₹18 L |
| **Total** | **₹2.25 Cr** |

Construction rates have gone up roughly 12% in the last two years, so get a fixed-price contract if you can.`,
  },
  {
    id: "h2-monthly-pnl-parentheses",
    source: "holdout",
    label: "right",
    why: "Gross profit 48,200 - 19,600 = 28600; opex 23650; operating income 4950; net 4950 - 420 - 1,130 = 3400.",
    text: `**September P&L (USD)**

| | Amount |
|:--|--:|
| Revenue | 48,200 |
| Cost of goods sold | (19,600) |
| **Gross profit** | **28,600** |
| Salaries | (14,500) |
| Rent | (3,200) |
| Software | (1,150) |
| Marketing | (4,800) |
| Total operating expenses | (23,650) |
| **Operating income** | **4,950** |
| Interest | (420) |
| Income tax | (1,130) |
| **Net income** | **3,400** |

Gross margin is 59.3%, which is healthy. Marketing at 10.0% of revenue is where I'd look first if you want to widen the net margin.`,
  },
  {
    id: "h2-dubai-rent-aed-usd-table",
    source: "holdout",
    label: "right",
    why: "AED column sums to 106720; each USD cell is AED/3.6725; total ≈ $29059.",
    text: `What you'll pay up front for a 1-bedroom in JLT at AED 95,000/year:

| Item | AED | USD |
|:--|--:|--:|
| Annual rent (1BR, JLT) | 95,000 | 25,868 |
| Agency fee (5%) | 4,750 | 1,293 |
| Security deposit (5%) | 4,750 | 1,293 |
| Ejari registration | 220 | 60 |
| DEWA connection deposit | 2,000 | 545 |
| **Total upfront** | **106,720** | **29,059** |

Most landlords accept 1–4 cheques, so you won't hand over the full rent at once. The security and DEWA deposits are refundable at the end of the tenancy.`,
  },
  {
    id: "h2-w-hospital-bill-pkr-total",
    source: "holdout",
    label: "wrong",
    why: "Total PKR 331,700 but items sum to PKR 351,700, 5.7% low.",
    text: `Estimated bill at a private hospital in Karachi:

| Item | Cost (PKR) |
|:--|--:|
| Room charges (3 nights × 18,000) | 54,000 |
| Surgery (laparoscopic appendectomy) | 220,000 |
| Anaesthesia | 35,000 |
| Medicines & consumables | 28,500 |
| Lab tests & ultrasound | 14,200 |
| **Total** | **331,700** |

If you have Sehat Card coverage, check whether this hospital is on the panel — it can cover the full procedure.`,
  },
  {
    id: "h2-uk-monthly-bills-gbp",
    source: "holdout",
    label: "right",
    why: "Bills sum to £404.54; £404.54 / 0.75 ≈ $539.",
    text: `Typical monthly household bills for a 2-bed flat in Manchester:

- **Council tax (Band C)** — £168
- **Energy (gas + electric)** — £142
- **Water** — £48
- **Broadband** — £32
- **TV licence** — £14.54

**Total: £404.54 a month** (about $539)

Rent is on top of that. Energy is the one that swings most — expect it closer to £200 in January and under £90 in summer.`,
  },
  {
    id: "h2-w-site-costs-annual-total",
    source: "holdout",
    label: "wrong",
    why: "Monthly total $89.75 is right but Annual total $1,020.00 should be $1,077.00, 5.3% low.",
    text: `Running costs for the store website:

| Service | Monthly | Annual |
|:--|--:|--:|
| Domain + DNS | $3.75 | $45.00 |
| Hosting (VPS) | $29.00 | $348.00 |
| Email (Workspace, 1 user) | $12.00 | $144.00 |
| Email marketing | $45.00 | $540.00 |
| **Total** | **$89.75** | **$1,020.00** |

Email marketing pricing jumps once you pass 2,500 contacts, so keep an eye on list growth.`,
  },
  {
    id: "h2-conference-budget-ranges",
    source: "holdout",
    label: "right",
    why: "Low ends sum to 21450, high ends to 33800; catering 150 x 45 = 6,750 and 150 x 70 = 10,500.",
    text: `For a one-day, **150-person** product conference, I'd plan on these ranges:

| Line item | Low | High |
|:--|--:|--:|
| Venue (1 day, 150 people) | $8,000 | $12,000 |
| Catering (150 × $45–$70) | $6,750 | $10,500 |
| AV & livestream | $2,500 | $4,000 |
| Speaker travel | $3,000 | $5,500 |
| Swag & signage | $1,200 | $1,800 |
| **Estimated total** | **$21,450** | **$33,800** |

So somewhere between **$21.45k and $33.8k**. If a sponsor covers catering, you're closer to the bottom of that range.`,
  },
  {
    id: "h2-er-bill-insurance-split",
    source: "holdout",
    label: "right",
    why: "Charges sum to 3965; you pay 1,000 deductible + 20% of 2965 = 1593; insurer pays 2372.",
    text: `Here's how the ER bill breaks down (allowed amounts after the network discount):

- ER facility fee: $1,850
- CT scan (abdomen): $1,200
- Lab work: $340
- Medications: $95
- ER physician: $480

**Total allowed: $3,965**

With your plan ($1,000 deductible, then 20% coinsurance):
- You pay the first **$1,000**, plus 20% of the remaining $2,965 = **$593**
- **Your share: $1,593**; insurance pays **$2,372**

Your out-of-pocket max is $4,500, so you're well under it. Ask billing for an itemized statement before paying — ER bills often have duplicate lab charges.`,
  },
  {
    id: "h2-w-pk-govt-documents-fees",
    source: "holdout",
    label: "wrong",
    why: "Total PKR 18,750 but fees sum to PKR 20,750, 9.6% low.",
    text: `Documents you need before applying abroad, with current fees:

1. Passport (urgent, 36 pages) — Rs. 12,000
2. NADRA CNIC renewal (executive) — Rs. 2,500
3. Police character certificate — Rs. 1,500
4. Degree attestation (HEC) — Rs. 3,800
5. MOFA attestation — Rs. 950

**Total: Rs. 18,750**

HEC attestation is now fully online, but the courier step still takes 7–10 working days.`,
  },
  {
    id: "h2-in-state-tuition-dot-leaders",
    source: "holdout",
    label: "right",
    why: "Items sum to 27310.",
    text: `Estimated cost of attendance for 2025–26 (in-state, living on campus):

\`\`\`
Tuition .............. $14,200
Housing .............. $6,800
Meal plan ............ $4,350
Books & supplies ..... $1,100
Student fees ......... $860
Total ................ $27,310
\`\`\`

Your aid letter lists a $9,500 Pell + state grant, which brings what you actually owe down considerably. Separately, the housing deposit is $300, due by May 1.`,
  },
  {
    id: "h2-w-office-supplies-cents-total",
    source: "holdout",
    label: "wrong",
    why: "Total $86.60 but items sum to $96.60, 10.4% low.",
    text: `Here's the supply order:

- Printer paper (5 reams): $18.50
- Toner cartridge (HP 26A): $24.75
- Sticky notes (12-pack): $12.00
- Pens & markers: $9.95
- Desk organizers (×4): $31.40

**Total: $86.60**

Ordering through a business account usually gets free next-day delivery over $50.`,
  },
  {
    id: "h2-startup-runway-k-shorthand",
    source: "holdout",
    label: "right",
    why: "Burn 32 + 4.5 + 3.2 + 1.1 + 4.2 = $45K/month; $1.35M / $45K = 30 months.",
    text: `Your monthly burn:

- Salaries (5 FTE): **$32K**
- Cloud & infra: **$4.5K**
- Office: **$3.2K**
- Tools & SaaS: **$1.1K**
- Marketing: **$4.2K**

That's **$45K/month**. With the $1.2M seed plus ~$150K already in the bank ($1.35M total), you have about **30 months of runway**.

Most investors want you raising with 9–12 months left, so start the Series A process around month 18.`,
  },
  {
    id: "h2-cafe-fitout-three-tables",
    source: "holdout",
    label: "right",
    why: "Subtotals 7670, 5300, 1630; grand total 14600; 8x180 and 24x65 correct.",
    text: `Opening costs for the coffee kiosk, split into three buckets:

**1. Espresso setup**

| Item | Cost |
|:--|--:|
| La Marzocco Linea Mini | $5,900 |
| Mazzer Philos grinder | $1,450 |
| Water filtration | $320 |
| **Subtotal** | **$7,670** |

**2. Furniture**

| Item | Cost |
|:--|--:|
| Tables (8 × $180) | $1,440 |
| Chairs (24 × $65) | $1,560 |
| Service counter | $2,300 |
| **Subtotal** | **$5,300** |

**3. Opening stock**

| Item | Cost |
|:--|--:|
| Coffee beans (30 kg) | $900 |
| Milk & dairy | $250 |
| Cups, lids, sleeves | $480 |
| **Subtotal** | **$1,630** |

**Grand total: $14,600**

You could save ~$2,000 by buying a used Linea Mini, but get the boiler checked first.`,
  },
  {
    id: "h2-w-two-tables-second-total",
    source: "holdout",
    label: "wrong",
    why: "Second table Total $4,420 but items sum to $4,920, 10.2% low; first table $2,750 is right.",
    text: `**One-time brand setup**

| Item | Cost |
|:--|--:|
| Website (Shopify theme + setup) | $1,200 |
| Logo & packaging design | $900 |
| Product photography | $650 |
| **Total** | **$2,750** |

**Launch inventory**

| Item | Cost |
|:--|--:|
| First inventory run (300 units) | $4,200 |
| Packaging (300 boxes) | $540 |
| Shipping supplies | $180 |
| **Total** | **$4,420** |

Order a 50-unit sample batch first if the manufacturer allows it — it's worth the slightly higher unit cost to check quality.`,
  },
  {
    id: "h2-wfh-setup-heading-total-inr",
    source: "holdout",
    label: "right",
    why: "Items sum to ₹1,84,500, matching the heading.",
    text: `### Total: ₹1,84,500

Here's how that splits:

- MacBook Air M3 (16GB/512GB) — ₹1,14,900
- LG 27" 4K monitor — ₹24,500
- Ergonomic chair — ₹18,600
- Height-adjustable desk — ₹14,200
- Keyboard, mouse, webcam, hub — ₹12,300

If you claim this under your company's WFH allowance, keep the GST invoices. The MacBook alone is about 62% of the spend, so that's where a refurbished unit would save the most.`,
  },
  {
    id: "h2-w-gala-numbered-subbullets",
    source: "holdout",
    label: "wrong",
    why: "Estimated total $9,960 but sub-items sum to $8,860, 12.4% high.",
    text: `Budget for the 120-guest company holiday party:

1. **Venue**
   - Hall rental (6 hrs): $2,400
   - Cleaning fee: $250
2. **Food & drink**
   - Buffet (120 × $28): $3,360
   - Bar package: $1,500
3. **Entertainment**
   - DJ: $900
   - Photo booth: $450

**Estimated total: $9,960**

If you move the party to a Thursday, most venues knock 15–20% off the hall rental.`,
  },
  {
    id: "h2-relocation-roughly-before-list",
    source: "holdout",
    label: "right",
    why: "Items sum to 6385; \"roughly $6,400\" is a sensible rounding.",
    text: `You'll need roughly **$6,400** in total for the move to Toronto:

1. Flights (2 adults, one-way): $1,380
2. Pet relocation (cat, cargo + vet paperwork): $1,650
3. Shipping 6 boxes: $720
4. Temporary rental (2 weeks): $1,960
5. Setup (SIM, bedding, kitchen basics): $675

The pet relocation line is the one people underestimate — book the vet health certificate within 10 days of the flight.`,
  },
  {
    id: "h2-galaxy-s24-ultra-repair-model-numbers",
    source: "holdout",
    label: "right",
    why: "329 + 109 + 89 + 0 = 527; SM-S928U, S24, 1-800-726-7864 and 5,000 mAh are not money.",
    text: `For a **Galaxy S24 Ultra (SM-S928U)** with a cracked screen and back, an authorized repair shop quoted:

| Repair | Price |
|:--|--:|
| Screen assembly (OEM) | $329 |
| Back glass | $109 |
| Battery | $89 |
| Diagnostic | Waived |
| **Total** | **$527** |

The battery swap is optional, but the 5,000 mAh pack is easy to do while the phone's already open. If you have Samsung Care+, call **1-800-726-7864** first — the screen deductible is much lower than paying out of pocket.`,
  },
  {
    id: "h2-w-shopify-launch-cost-usd-header",
    source: "holdout",
    label: "wrong",
    why: "Total 3,122 but items sum to 2,822, 10.6% high.",
    text: `Lean launch budget for your skincare store:

| Item | Cost (USD) |
|:--|--:|
| Shopify (3 months, Basic) | 117 |
| Premium theme | 350 |
| Apps (reviews, upsell, email) | 135 |
| Initial ad test budget | 1,500 |
| Product samples | 420 |
| Business registration | 300 |
| **Total** | **3,122** |

Keep the ad test small and spread across 3–4 creatives so you learn which angle works before scaling.`,
  },
  {
    id: "h2-federal-tax-brackets-2025",
    source: "holdout",
    label: "right",
    why: "Income in brackets 11925 + 36550 + 36525 = 85000; tax 1192.5 + 4386 + 8035.5 = 13614; effective 16.0%.",
    text: `For **$85,000 of taxable income** (single filer, 2025 brackets):

| Bracket | Rate | Income taxed | Tax |
|:--|:-:|--:|--:|
| $0 – $11,925 | 10% | $11,925 | $1,192.50 |
| $11,925 – $48,475 | 12% | $36,550 | $4,386.00 |
| $48,475 – $103,350 | 22% | $36,525 | $8,035.50 |
| **Total** | | **$85,000** | **$13,614.00** |

Your marginal rate is 22%, but your **effective rate is about 16.0%**. A $7,000 traditional IRA contribution would save you $1,540 since it comes off the 22% bracket.`,
  },
  {
    id: "h2-w-workshop-empty-cells-total",
    source: "holdout",
    label: "wrong",
    why: "Estimated total $5,620 but filled cells sum to $6,120, 8.2% below; the empty recording cell is $0.",
    text: `Budget for the half-day leadership workshop (60 people):

| Item | Cost | Notes |
|:--|--:|:--|
| Venue (half day) | $1,200 |  |
| Coffee & lunch (60 × $32) | $1,920 |  |
| Keynote speaker | $2,500 | Travel included |
| Printed workbooks | $360 |  |
| Recording |  | Volunteer |
| Name badges & lanyards | $140 |  |
| **Estimated total** | **$5,620** | |

If a sponsor picks up lunch, you're well under the department's cap.`,
  },
  {
    id: "h2-gym-plans-first-year",
    source: "holdout",
    label: "right",
    why: "First-year column = monthly x12 + joining fee per row (348.88, 479.88, 878.88); no column total.",
    text: `Comparing the three plans over your first year:

| Plan | Monthly | Joining fee | First-year cost |
|:--|--:|--:|--:|
| Basic | $24.99 | $49 | $348.88 |
| Plus | $39.99 | — | $479.88 |
| Premium | $64.99 | $99 | $878.88 |

**Plus** is the sweet spot if you'll use classes twice a week. Premium only makes sense if you'll actually use the pool and sauna — otherwise you're paying $399.00 extra a year for amenities.`,
  },
  {
    id: "h2-dinner-bill-tip-split-cents",
    source: "holdout",
    label: "right",
    why: "Subtotal 168.75; tax 8.875% = 14.98; tip 20% pre-tax = 33.75; total 217.48; per person /4 = 54.37.",
    text: `Here's the split for the four of you:

- 2 × Ribeye ($42.00): $84.00
- Salmon: $31.50
- 3 × Cocktails ($14.00): $42.00
- Shared dessert: $11.25

**Subtotal: $168.75**
- Tax (8.875%): $14.98
- Tip (20% on pre-tax): $33.75

**Total: $217.48** → **$54.37 each**

If the person who skipped cocktails wants a fairer split, take $14.00 off their share and spread it over the other three.`,
  },
  {
    id: "h2-w-london-house-move-gbp",
    source: "holdout",
    label: "wrong",
    why: "Total £1,397 but items sum to £1,597, 12.5% low.",
    text: `Moving from Croydon to Islington — what to budget:

- **Removal van + 2 movers:** £685
- **Packing materials:** £75
- **End-of-tenancy clean:** £260
- **Holding deposit (new flat):** £400
- **Broadband install:** £35
- **Council tax (first month):** £142

**Total: £1,397**

The holding deposit is normally deducted from your first rent payment, so it isn't money lost.`,
  },
  {
    id: "h2-auto-loan-emi-total-interest",
    source: "holdout",
    label: "right",
    why: "Payment on 28,000 at 7.2%/60 = 557.08; x60 = 33424.8; interest = 33424.8 - 28,000 = 5424.8.",
    text: `For a **$28,000** auto loan at **7.2% APR** over **60 months**:

- **Monthly payment:** $557.08
- **Total of payments:** $33,424.80 (60 × $557.08)
- **Total interest:** $5,424.80

\`\`\`
M = P * r / (1 - (1 + r)^-n)
P = 28000, r = 0.072 / 12 = 0.006, n = 60
\`\`\`

Putting another $3,000 down would cut the payment by roughly $60 a month. If your credit union offers 5.9%, refinancing after 12 on-time payments is worth a look.`,
  },
  {
    id: "h2-w-uae-company-setup-aed-total",
    source: "holdout",
    label: "wrong",
    why: "Total AED 31,300 but items sum to AED 27,300, 14.7% high.",
    text: `Setting up a one-person consultancy in a Dubai free zone:

| Item | Cost (AED) |
|:--|--:|
| Free zone trade licence | 12,500 |
| Establishment card | 2,000 |
| Investor visa | 3,750 |
| Emirates ID + medical | 1,050 |
| Flexi-desk (1 year) | 8,000 |
| Bank account (minimum balance) | — |
| **Total** | **31,300** |

Some free zones bundle the licence and one visa for around AED 15,000, so compare packages before you commit.`,
  },
  {
    id: "h2-lahore-10-marla-crore",
    source: "holdout",
    label: "right",
    why: "Charges 9.6L + 6.4L + 9.6L + 3.2L = 28.8 lakh on 3.2 crore; total 3.488 crore ≈ 3.49 crore; /277 ≈ $126000.",
    text: `For a **10 marla** house in DHA Phase 6 at **PKR 3.2 crore**, the buyer-side costs add up like this:

- Stamp duty (3%): PKR 9.6 lakh
- Capital value tax (2%): PKR 6.4 lakh
- Advance tax 236K (3%, filer): PKR 9.6 lakh
- Agent commission (1%): PKR 3.2 lakh

Taxes and commission come to **PKR 28.8 lakh**, so the all-in cost is about **PKR 3.49 crore** (≈ $126,000).

Non-filers pay a much higher 236K rate, so get on the ATL before the transfer date. Rates differ slightly between DHA and LDA-approved societies.`,
  },
  {
    id: "h2-shopify-plan-tiers-fees",
    source: "holdout",
    label: "right",
    why: "Per plan: subscription + (20,000 x rate + 400 x 0.30): 739, 765, 1019; tier rows are alternatives, not summed.",
    text: `Shopify's plans (monthly billing) and what each would cost you at **$20,000/month in sales across 400 orders**:

| Plan | Subscription | Card rate | Processing fees | Monthly cost |
|:--|--:|:-:|--:|--:|
| Basic | $39 | 2.9% + 30¢ | $700 | **$739** |
| Grow | $105 | 2.7% + 30¢ | $660 | **$765** |
| Advanced | $399 | 2.5% + 30¢ | $620 | **$1,019** |

At your volume **Basic is cheapest**. Grow only wins once sales pass roughly $33,000/month — that's where the 0.2% lower card rate covers the extra $66 subscription. Paying yearly drops the subscriptions to $29 / $79 / $299.`,
  },
  {
    id: "h2-w-bathroom-remodel-total",
    source: "holdout",
    label: "wrong",
    why: "Total $9,850 but items sum to $11,080, 11.1% low.",
    text: `Rough budget for a full bathroom remodel (5×8 ft):

| Item | Estimate |
|---|---:|
| Demolition & disposal | $1,100 |
| Plumbing rough-in | $2,400 |
| Tile (floor + shower walls) | $3,200 |
| Vanity + countertop | $1,450 |
| Toilet & fixtures | $980 |
| Glass shower door | $1,250 |
| Electrical + fan | $700 |
| **Total** | **$9,850** |

Add 10–15% contingency — old bathrooms often hide water damage behind the tile.`,
  },
  {
    id: "h2-office-move-optional-excluded",
    source: "holdout",
    label: "right",
    why: "Core items sum to 8530; optional items (2,400 and 350) are explicitly excluded from the total.",
    text: `Core costs for moving the team to the new floor:

| Item | Cost |
|---|---:|
| Commercial movers | $3,800 |
| IT relocation (network, 22 desks) | $2,600 |
| New signage | $950 |
| Deep clean of old unit | $680 |
| Lease admin fee | $500 |
| **Total** | **$8,530** |

Optional (not included in the total above):
- Standing desk converters for 8 people — $2,400
- Plants and a small lounge area — $350

I'd hold off on the optional items until after the first month so you can see how people actually use the space.`,
  },
  {
    id: "h2-w-utilities-cents-total-high",
    source: "holdout",
    label: "wrong",
    why: "Total $313.27 but items sum to $333.27, 6.0% high.",
    text: `Your shared house utilities this month:

- Electricity: $118.42
- Gas: $64.10
- Water & sewer: $52.75
- Internet: $70.00
- Trash pickup: $28.00

**Total: $313.27**

Internet and trash are flat every month; the other three swing with the season.`,
  },
  {
    id: "h2-electric-bill-six-month-average",
    source: "holdout",
    label: "right",
    why: "Bottom row is the average of six bills = 124.13, not a sum.",
    text: `Your electric bills for the first half of 2025:

| Month | Bill |
|:--|--:|
| Jan | $142.18 |
| Feb | $131.40 |
| Mar | $118.75 |
| Apr | $96.30 |
| May | $104.90 |
| Jun | $151.27 |
| **Average** | **$124.13** |

June jumped once the AC came on. If you switch to budget billing, the utility would bill roughly that average every month and true it up in the spring.`,
  },
  {
    id: "h2-masters-germany-vs-us-not-conversion",
    source: "holdout",
    label: "right",
    why: "€3,000 and $45,000 are different programs' fees, not a conversion; €3,000 ≈ $3490 is at 0.86; living-cost range €11,904 = 12 x 992.",
    text: `Rough yearly costs for a **master's in data science**:

- **Public university in Germany (non-EU student):** about €3,000/year in tuition where a state charges it (≈ $3,490), plus a ~€300 semester contribution
- **US state university (out-of-state):** around $45,000/year in tuition

Living costs flip the picture a bit: Germany's blocked account requirement is €11,904 a year (€992/month), while a US public university in a mid-size city is closer to $18,000.

Germany is still far cheaper overall, but check each program — TUM, for example, charges €4,000–6,000 per semester for non-EU students.`,
  },
  {
    id: "h2-w-grad-school-grand-total",
    source: "holdout",
    label: "wrong",
    why: "Subtotals $26,150 and $16,500 are right, but Grand total $38,650 should be $42,650, 9.4% low.",
    text: `One-year cost estimate for the MS program:

**School costs**
- Tuition (1 year): $24,500
- Health insurance: $1,650
- Subtotal: $26,150

**Living costs**
- Rent (12 × $950): $11,400
- Food: $4,200
- Transport: $900
- Subtotal: $16,500

### Grand total: $38,650

A half-tuition RA position would change this picture a lot — email the labs you're interested in now.`,
  },
  {
    id: "h2-monthly-budget-table-commentary",
    source: "holdout",
    label: "right",
    why: "Rows sum to 3205; prose \"rent and utilities $1,650\" = 1,400 + 250, 51% of total; $4,100 take-home minus 3205 = 895.",
    text: `Here's a monthly budget that fits your $4,100 take-home:

| Category | Monthly |
|:--|--:|
| Rent | $1,400 |
| Utilities + internet | $250 |
| Groceries | $520 |
| Transport | $180 |
| Insurance | $210 |
| Subscriptions | $45 |
| Savings | $600 |
| **Total** | **$3,205** |

Rent and utilities alone are $1,650 — about 51% of the plan, which is on the high side but workable. That leaves **$895** of slack each month for eating out and the unexpected. If you can push savings to $750 later this year, you'd hit the 6-month emergency fund by next summer.`,
  },
  {
    id: "h2-w-creator-tools-monthly-sentence",
    source: "holdout",
    label: "wrong",
    why: "\"That's $69.20 a month\" but tools sum to $79.20, 12.6% low.",
    text: `Your marketing tool stack:

- Canva Pro: $15/mo
- Later (social scheduler): $25/mo
- Mailchimp Standard: $20/mo
- Google Workspace: $7.20/mo
- Calendly: $12/mo

That's $69.20 a month. Canva and Later both have overlapping scheduling features, so you could probably drop Later.`,
  },
  {
    id: "h2-ielts-fees-pkr-usd",
    source: "holdout",
    label: "right",
    why: "PKR 72,000 + 25,000 + 6,500 = 103500; 72,000/277 ≈ $260; 103500/277 ≈ $374; band 7.0 and 6 weeks are not money.",
    text: `To aim for a **band 7.0**, here's what to budget in Pakistan:

1. **IELTS Academic (British Council)** — PKR 72,000 (≈ $260)
2. **Preparation course (6 weeks)** — PKR 25,000
3. **Practice books + mock tests** — PKR 6,500

Altogether that's about **PKR 103,500**, or roughly $374.

If you're confident in your English, skipping the course brings it down to PKR 78,500. Book the test at least 5 weeks before your university deadline.`,
  },
  {
    id: "h2-pk-pharmacy-startup-L-shorthand",
    source: "holdout",
    label: "right",
    why: "L values sum to 25.85 L (~25.9 L); PKR 25.85 lakh / 277 ≈ $9330.",
    text: `Startup budget for a small pharmacy in Rawalpindi:

- **Shop rent advance (3 months):** PKR 4.5L
- **Renovation & shelving:** PKR 6L
- **Initial inventory:** PKR 12L
- **POS system + laptop:** PKR 1.8L
- **Trade licence & registration:** PKR 0.35L
- **Launch marketing:** PKR 1.2L

**Total ≈ PKR 25.9L** (~$9,330)

Inventory is the biggest chunk. Many distributors give 30-day credit to new pharmacies, which could cut what you need on day one by 5–6L. You'll also need the DRAP licence before stocking anything.`,
  },
  {
    id: "h2-w-ivf-cycle-inr-total",
    source: "holdout",
    label: "wrong",
    why: "Estimated total ₹2,55,000 but items sum to ₹3,05,000, 16.4% low.",
    text: `Approximate cost of one IVF cycle at a mid-range clinic in Delhi:

| Step | Cost (₹) |
|:--|--:|
| Consultations & scans | 25,000 |
| Stimulation medicines | 1,10,000 |
| Egg retrieval + anaesthesia | 60,000 |
| Lab / ICSI | 55,000 |
| Embryo transfer | 30,000 |
| Freezing (1 year) | 25,000 |
| **Estimated total** | **2,55,000** |

Medicine costs vary the most because dosing depends on your response. Ask whether the clinic offers a package price for two cycles.`,
  },
  {
    id: "h2-mumbai-flat-crore-shorthand",
    source: "holdout",
    label: "right",
    why: "Price 240 L + stamp duty 6% 14.4 L + registration 0.3 L + GST 5% 12 L = 266.7 L = ₹2.667 Cr ≈ ₹2.67 Cr.",
    text: `For an under-construction **2BHK in Thane** at ₹2.4 Cr:

| Component | Amount |
|:--|--:|
| Agreement value | ₹2.4 Cr |
| Stamp duty (6%) | ₹14.4 L |
| Registration | ₹30,000 |
| GST (5%, under-construction) | ₹12 L |
| **Total cost** | **~₹2.67 Cr** |

If you buy a ready-to-move flat instead, GST doesn't apply, which saves you the ₹12 L. Women buyers in Maharashtra get a 1% stamp duty concession, worth ₹2.4 L here.`,
  },
  {
    id: "h2-w-mba-lakh-total-low",
    source: "holdout",
    label: "wrong",
    why: "Total ₹30.5 L but rows sum to ₹34 L, 10.3% low.",
    text: `Two-year MBA cost estimate:

| Item | Amount |
|:--|--:|
| Tuition (2 years) | ₹24.5 L |
| Hostel & mess | ₹4.8 L |
| Laptop & books | ₹1.2 L |
| Placement & alumni fees | ₹3.5 L |
| **Total** | **₹30.5 L** |

Most banks will finance up to ₹40 L for this program without collateral if you have an admit letter.`,
  },
  {
    id: "h2-kitchen-reno-range-spellings",
    source: "holdout",
    label: "right",
    why: "Lows 4200+2100+3500+6000 = 15800; highs 6800+3400+5200+9000 = 24400; total range $15.8k–$24.4k.",
    text: `Ballpark for a mid-range kitchen refresh (no layout changes):

- **Cabinets (refaced):** $4.2k–6.8k
- **Quartz countertops:** 2,100 to 3,400 USD
- **Appliance package:** between $3,500 and $5,200
- **Labor (plumbing, electrical, install):** $6K–$9K

**Total: $15.8k–$24.4k**

Permits usually add a few hundred dollars depending on your city. Get at least three contractor quotes — they vary wildly on the labor line.`,
  },
  {
    id: "h2-family-groceries-weekly-x52",
    source: "holdout",
    label: "right",
    why: "Weekly 215 = 165 + 22 + 28; annual = 215 x 52 = 11180.",
    text: `For your family of four:

- Groceries: $165/week
- Household supplies: $22/week
- Diapers & wipes: $28/week

That's **$215 a week**, so over a year it's **$215 × 52 = $11,180**.

Switching to a warehouse club for diapers and staples typically trims 10–15%. The $65 membership pays for itself within a couple of months at your spend.`,
  },
  {
    id: "h2-w-conv-remittance-lakh-10x",
    source: "holdout",
    label: "wrong",
    why: "$5,000 restated as PKR 1.39 lakh; at 277 it's ~PKR 13.85 lakh (off by ~10.0x).",
    text: `Sending **$5,000 (≈ PKR 1.39 lakh)** home through Remitly:

- Transfer fee: $4.99
- Total charged to your card: $5,004.99
- Delivery: bank deposit, usually same day

Under the Pakistan Remittance Initiative, banks don't deduct anything on the receiving side for amounts over $100.`,
  },
  {
    id: "h2-home-sale-net-proceeds",
    source: "holdout",
    label: "right",
    why: "640,000 - 5% 32,000 - 3,200 - 0.4% 2,560 - 410,000 payoff = 192240.",
    text: `Estimated net proceeds on the sale:

| | Amount |
|:--|--:|
| Sale price | $640,000 |
| Agent commission (5%) | -$32,000 |
| Title & escrow | -$3,200 |
| Transfer tax (0.4%) | -$2,560 |
| Mortgage payoff | -$410,000 |
| **Net to you** | **$192,240** |

Since you've lived there 5 of the last 7 years, up to $250,000 of the gain is excluded from capital gains tax ($500,000 if married filing jointly).`,
  },
  {
    id: "h2-w-conv-inr-used-pkr-rate",
    source: "holdout",
    label: "wrong",
    why: "$1,800 restated as ₹4,98,600 (used 277); at 88 it's ₹1,58,400 (off by ~3.1x).",
    text: `Your invoice to the Toronto client:

| Deliverable | Amount |
|:--|--:|
| Logo design | $600 |
| Brand guide | $450 |
| Social kit | $750 |
| **Total** | **$1,800** |

That's **$1,800 (≈ ₹4,98,600)** before platform fees. Raise it as an export invoice under your LUT so you don't have to add GST.`,
  },
  {
    id: "h2-webflow-project-hours-rates",
    source: "holdout",
    label: "right",
    why: "Amounts 1190 + 2720 + 3610 + 1140 = 8660; hours 96 summed separately; rate column not summed.",
    text: `Proposed estimate for the Webflow site:

| Phase | Hours | Rate | Amount |
|:--|--:|--:|--:|
| Discovery & wireframes | 14 | $85/hr | $1,190 |
| Visual design | 32 | $85/hr | $2,720 |
| Webflow build | 38 | $95/hr | $3,610 |
| QA & launch | 12 | $95/hr | $1,140 |
| **Total** | **96 hrs** | | **$8,660** |

I'd ask for 40% upfront ($3,464) and the rest on launch. Round to $8,700 if you'd rather quote a flat fee.`,
  },
  {
    id: "h2-apparel-reorder-skus",
    source: "holdout",
    label: "right",
    why: "Line totals 768 + 960 + 1500 + 294 = 3522; SKU numbers and unit counts (410) are not money; unit cost not summed.",
    text: `Reorder for next month based on the last 90 days of sales:

| SKU | Product | Units | Unit cost | Line total |
|:--|:--|--:|--:|--:|
| TSH-1042 | Organic tee, black (M) | 120 | $6.40 | $768.00 |
| TSH-1043 | Organic tee, black (L) | 150 | $6.40 | $960.00 |
| HD-2210 | Pullover hoodie, oat | 80 | $18.75 | $1,500.00 |
| CAP-0907 | Dad cap, navy | 60 | $4.90 | $294.00 |
| | **Total** | **410** | | **$3,522.00** |

HD-2210 has the slowest sell-through, so if cash is tight cut that to 50 units first.`,
  },
  {
    id: "h2-w-conv-crore-to-usd-10x",
    source: "holdout",
    label: "wrong",
    why: "PKR 2.5 crore restated as ~$9,000; at 277 it's ~$90,253 (off by ~10.0x).",
    text: `An apartment in Bahria Town Karachi in that size range is going for about **PKR 2.5 crore (around $9,000)** right now.

Things to factor in:
- **Transfer + taxes:** roughly 6–7% of the price
- **Possession timeline:** ready units, so no waiting on construction
- **Maintenance:** about PKR 8,000/month

Overseas Pakistanis can pay through a Roshan Digital Account, which keeps the transaction fully documented.`,
  },
  {
    id: "h2-ad-campaigns-blended-cpc",
    source: "holdout",
    label: "right",
    why: "Spend per row = clicks x CPC; spend total 8274; clicks 9100; conversions 285; total-row CPC 0.91 and CPA 29.03 are blended ratios, not sums.",
    text: `October paid performance:

| Campaign | Clicks | CPC | Spend | Conv. | CPA |
|:--|--:|--:|--:|--:|--:|
| Brand search | 1,800 | $0.62 | $1,116.00 | 96 | $11.63 |
| Non-brand search | 4,200 | $1.35 | $5,670.00 | 118 | $48.05 |
| Meta retargeting | 3,100 | $0.48 | $1,488.00 | 71 | $20.96 |
| **Total / blended** | **9,100** | **$0.91** | **$8,274.00** | **285** | **$29.03** |

Non-brand search is 69% of spend but has the highest CPA. Retargeting is your cheapest conversion — I'd move $1,000 from non-brand into it and watch frequency.`,
  },
  {
    id: "h2-w-conv-aed-multiplied",
    source: "holdout",
    label: "wrong",
    why: "AED 15,000 restated as ~$55,088 (multiplied by 3.6725); real is ~$4,084.",
    text: `A mid-level marketing manager salary in Dubai is around **AED 15,000/month (~$55,088)**, tax-free.

On top of base pay, most offers include:
- Annual flight home
- Medical insurance
- 30 calendar days of leave

Housing allowance is sometimes bundled into the 15,000, so ask for the breakdown before comparing offers.`,
  },
  {
    id: "h2-dental-treatment-inr-ranges",
    source: "holdout",
    label: "right",
    why: "Lows 15000, highs 32500; total ₹15,000–₹32,500.",
    text: `Typical prices at a good private clinic in Pune:

| Treatment | Price range |
|:--|--:|
| Root canal (molar) | ₹6,000–₹12,000 |
| Ceramic crown | ₹8,000–₹18,000 |
| Scaling & polishing | ₹1,000–₹2,500 |
| **Total** | **₹15,000–₹32,500** |

So plan for roughly ₹15–32.5K depending on the crown material. Zirconia sits at the top of that range; PFM crowns are closer to ₹8,000.`,
  },
  {
    id: "h2-uk-skilled-worker-move-gbp",
    source: "holdout",
    label: "right",
    why: "Items sum to £7617; IHS 3 x 1,035 = 3,105; £7617/0.75 ≈ $10200.",
    text: `Here's what to have ready before the move:

1. Skilled Worker visa (3 years) — £769
2. Immigration Health Surcharge (3 × £1,035) — £3,105
3. Flight to London — £620
4. First month's rent — £1,450
5. Tenancy deposit (5 weeks) — £1,673

**Total: £7,617** (around $10,200)

Some employers reimburse the visa and IHS — ask HR before you pay. You'll also need to show £1,270 in savings for 28 days unless your sponsor certifies maintenance.`,
  },
  {
    id: "h2-w-conv-usd-inr-table-row-10x",
    source: "holdout",
    label: "wrong",
    why: "AWS exam row $150 shown as ₹1,32,000; at 88 it's ₹13,200 (off by ~10.0x). No total row.",
    text: `Certification study budget:

| Item | USD | INR |
|:--|--:|--:|
| Coursera Plus (1 year) | $399 | ₹35,112 |
| AWS Solutions Architect exam | $150 | ₹1,32,000 |
| Udemy courses (3) | $45 | ₹3,960 |
| Practice exams | $30 | ₹2,640 |

The AWS exam voucher sometimes comes with a 50% discount after you pass a Foundational cert, so check your account before booking.`,
  },
  {
    id: "h2-lease-vs-buy-two-scenarios",
    source: "holdout",
    label: "right",
    why: "Lease 3500 + 14004 + 395 = 17899; buy 5000 + 22032 = 27032; minus 21,000 equity = 6032.",
    text: `Comparing 3 years with the 2025 RAV4 Hybrid:

**Lease**
- Due at signing: $3,500
- 36 payments × $389: $14,004
- Disposition fee: $395
- **Total: $17,899**

**Buy (60-month loan, sell at year 3)**
- Down payment: $5,000
- 36 payments × $612: $22,032
- **Total paid: $27,032**
- Minus equity when you sell (~$21,000 resale after paying off the loan balance)
- **Net cost: ~$6,032**

Buying comes out about $11,867 cheaper over the three years, assuming you stay under 12,000 miles a year and the resale value holds.`,
  },
  {
    id: "h2-w-conv-usd-pkr-row-27-7",
    source: "holdout",
    label: "wrong",
    why: "Upwork row $239.88 shown as PKR 6,645 (used 27.7); at 277 it's ~PKR 66,447 (off by ~10.0x). No total row.",
    text: `Yearly tools for freelancing from Pakistan:

| Tool | USD | PKR |
|:--|--:|--:|
| Upwork Plus membership (1 yr) | $239.88 | 6,645 |
| Portfolio site hosting | $96.00 | 26,592 |
| Grammarly Premium | $144.00 | 39,888 |

Pay these with a virtual card from SadaPay or Payoneer so you don't get hit by bank conversion markups.`,
  },
  {
    id: "h2-catering-per-head-gst",
    source: "holdout",
    label: "right",
    why: "250 x 1,200 = 300000; 10% service 30000; GST 18% on 330000 = 59400; total 389400.",
    text: `For **250 guests at ₹1,200 per plate**:

- Food: 250 × ₹1,200 = **₹3,00,000**
- Service charge (10%): ₹30,000
- GST (18% on food + service): ₹59,400

**Total: ₹3,89,400** (about ₹3.89 lakh)

Caterers usually ask for 30% advance. Confirm the final headcount 72 hours before — most will bill the guaranteed number even if fewer people show up.`,
  },
  {
    id: "h2-property-tax-escrow-monthly",
    source: "holdout",
    label: "right",
    why: "412,000 x 1.18% = 4861.6; /12 = 405.13; ZIP 78704 and 2026 are not money.",
    text: `With an assessed value of **$412,000** and a combined rate of **1.18%** (city + county + school district in ZIP 78704):

- Annual property tax: **$4,861.60**
- Monthly escrow: **$405.13**

If you file the homestead exemption before April 30, 2026, the school portion is calculated on a lower value — usually worth several hundred dollars a year.`,
  },
  {
    id: "h2-w-conv-monthly-income-crore",
    source: "holdout",
    label: "wrong",
    why: "$1,200 restated as PKR 3.3 crore; at 277 it's ~PKR 3.3 lakh (off by ~99.3x).",
    text: `If you land two steady clients at $600 each, that's **$1,200/month ≈ PKR 3.3 crore**.

After costs:
- Platform fee (10%): -$120
- Payoneer withdrawal (~2%): -$24
- **Net: $1,056**

Register with PSEB as a freelancer — it lowers your tax rate on export income to 0.25%.`,
  },
  {
    id: "h2-subscription-audit-annualized",
    source: "holdout",
    label: "right",
    why: "Monthly items sum to 87.94; annual figure is 87.94 x 12 = 1055.28.",
    text: `Your recurring subscriptions:

- Netflix Standard — $17.99/mo
- Spotify Duo — $16.99/mo
- iCloud+ 200GB — $2.99/mo
- ChatGPT Plus — $20.00/mo
- Adobe Lightroom — $11.99/mo
- NYT Digital — $17.98/mo

That's **$87.94 a month**, or **$1,055.28 a year**.

Two quick cuts: Lightroom is included if you keep a Photography plan elsewhere, and NYT often offers $1/week to people who cancel.`,
  },
  {
    id: "h2-w-conv-lpa-to-usd-10x",
    source: "holdout",
    label: "wrong",
    why: "₹18 LPA restated as ~$2,045/year; at 88 it's ~$20,455 (off by ~10.0x).",
    text: `An **₹18 LPA** offer (about $2,045/year) for a backend role with 3 years' experience is fair in Hyderabad.

Rough monthly in-hand under the new tax regime:
- Gross per month: ₹1,50,000
- After PF, professional tax and TDS: around ₹1,24,000

Ask whether the 18 includes variable pay — if 15% is variable, your fixed is closer to ₹15.3 L.`,
  },
  {
    id: "h2-hackathon-prize-pool-counts",
    source: "holdout",
    label: "right",
    why: "Prizes sum to 10500; 120 teams, 48 hours, 400 participants are counts.",
    text: `Last year's hackathon had **120 teams** (~400 participants) over **48 hours**. For this year's prize pool:

| Prize | Amount |
|:--|--:|
| 1st place | $5,000 |
| 2nd place | $2,500 |
| 3rd place | $1,000 |
| Best use of AI (sponsor) | $1,500 |
| People's choice | $500 |
| **Total prize pool** | **$10,500** |

Judging rubric (out of 100): impact 30, technical depth 30, design 20, presentation 20. Announce the pool early — it's the #1 driver of sign-ups.`,
  },
  {
    id: "h2-germany-gross-to-net-eur-usd",
    source: "holdout",
    label: "right",
    why: "Deductions 11280 + 5394 + 4959 + 754 + 1044 = 23431; net 58000 - 23431 = 34569; USD at 0.86: 67400, 40200.",
    text: `For a **€58,000 gross** salary in Berlin (tax class I, no church tax), roughly:

| Deduction | Per year |
|:--|--:|
| Income tax | €11,280 |
| Pension insurance (9.3%) | €5,394 |
| Health insurance (8.55%) | €4,959 |
| Unemployment insurance (1.3%) | €754 |
| Long-term care (1.8%) | €1,044 |
| **Total deductions** | **€23,431** |

**Net: about €34,569/year** (≈ €2,881/month).

In dollars that's ~$67,400 gross and ~$40,200 net. Health insurance includes the average 2025 supplementary contribution; your provider's may differ slightly.`,
  },
  {
    id: "h2-w-conv-usd-eur-10x",
    source: "holdout",
    label: "wrong",
    why: "$3,000 restated as ≈ €25,800; at 0.86 it's ~€2,580 (off by ~10.0x).",
    text: `The Blocked Account top-up you're short is **$3,000 (≈ €25,800)**.

Ways to close the gap:
1. Ask a family member to sign a Verpflichtungserklärung (formal obligation letter) instead
2. Show a scholarship letter covering part of the €992/month requirement
3. Transfer the difference via Wise, which is usually cheapest for USD→EUR

Embassies check the full amount, so don't book your appointment until it's in.`,
  },
  {
    id: "h2-dubai-freelance-permit-aed",
    source: "holdout",
    label: "right",
    why: "AED items sum to 12670; /3.6725 ≈ $3450.",
    text: `Getting set up as a freelancer in Dubai through a free zone:

- **Freelance permit (1 year)** — AED 7,500
- **Residence visa + Emirates ID** — AED 3,750
- **Medical test** — AED 320
- **Health insurance (basic)** — AED 1,100

Altogether that's about **AED 12,670** (~$3,450) for the first year.

Renewals are cheaper since the visa runs 2 years. Opening a business bank account can take 4–6 weeks, so start that early.`,
  },
  {
    id: "h2-w-conv-pkr-to-usd-10x",
    source: "holdout",
    label: "wrong",
    why: "PKR 85,000 restated as ~$3,070; at 277 it's ~$307 (off by ~10.0x). The PKR list total is right.",
    text: `Monthly living costs for a student in Islamabad, sharing a flat:

- **Rent share** — PKR 35,000
- **Food** — PKR 22,000
- **Utilities** — PKR 9,000
- **Transport** — PKR 8,000
- **Mobile + internet** — PKR 3,500
- **Misc** — PKR 7,500

Total: **PKR 85,000 (~$3,070)** per month.

You can bring food down by about a third if you cook at home most days.`,
  },
  {
    id: "h2-lums-semester-local-vs-international",
    source: "holdout",
    label: "right",
    why: "Local fee parts sum to 285000; $4,200 is a separate international-student fee, not a conversion; PKR 285,000 ≈ $1029.",
    text: `Per-semester fees for the BSc Computer Science program:

| Component | Cost (PKR) |
|:--|--:|
| Tuition | 245,000 |
| Lab & library | 18,000 |
| Student activity | 7,000 |
| Exam fee | 15,000 |
| **Total (Pakistani students)** | **285,000** |

That's roughly $1,029. International students are charged a separate flat fee of **$4,200 per semester**, so the two numbers aren't meant to match. Need-based aid covers up to 100% of tuition for local students.`,
  },
  {
    id: "h2-w-conv-aed-rent-ratio",
    source: "holdout",
    label: "wrong",
    why: "AED 85,000 restated as ≈ $8,500; at 3.6725 it's ~$23,145 (off by ~2.7x).",
    text: `A 2-bed in Al Nahda (Sharjah side) runs about **AED 85,000 a year (≈ $8,500)** — noticeably cheaper than the Dubai side.

Trade-offs:
- **Commute:** 45–90 minutes to Business Bay at rush hour
- **Salik tolls:** add up if you drive daily
- **Cheques:** many landlords accept 4–6

If you work in Deira or Al Qusais, the commute is much shorter.`,
  },
  {
    id: "h2-w-conv-gbp-to-pkr-lakh",
    source: "holdout",
    label: "wrong",
    why: "£2,400 restated as ≈ PKR 2.1 lakh; at 0.75 GBP and 277 PKR per USD it's ~PKR 8.86 lakh (off by ~4.2x).",
    text: `Your sister's UK student visa fees come to **£2,400 (≈ PKR 2.1 lakh)** once you include the IHS for the course length.

What that covers:
- Student visa application
- Immigration Health Surcharge (£776 per year)
- Priority processing (optional, adds about £500)

Pay with a card that doesn't charge a foreign transaction fee — most Pakistani bank cards add 3–5%.`,
  },
  {
    id: "h2-w-conv-eur-to-inr-10x",
    source: "holdout",
    label: "wrong",
    why: "€1,200 restated as ≈ ₹12,300; at 0.86 EUR and 88 INR per USD it's ~₹1,22,791 (off by ~10.0x).",
    text: `The Goethe-Institut A1–A2 intensive course in Pune is about **€1,200 (≈ ₹12,300)** if you book it through the German centre's online portal.

A few things to know:
- It runs 8 weeks, 4 hours a day
- The A2 exam is included in the course fee
- For most English-taught programs, B1 German is a "nice to have", not a requirement

If you can't do the intensive, the extensive evening batch spreads the same hours over 5 months.`,
  },
];
