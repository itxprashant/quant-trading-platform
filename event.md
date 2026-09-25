Master Playbook: Quant Finance Trading Tournament
Theme: "The New Eden Exchange"
This document outlines the complete execution for the Trading Floor. The core philosophy is Cognitive Overload. Candidates will not have time to sit and calculate. They must use mental heuristics while managing parallel streams of information, continuous margin checks, and dynamic asset additions.
🏛️ Ecosystem Rules & Structural Mechanics
1. The Bank of New Eden (Loans & Margin)
    • Real-Time Margin Calls: Margin calls do not wait for breaks. If a player’s Free Cash drops to $0 or lower, a Margin Call is triggered instantly. The Host violently dumps the player's entire inventory to the market via Market Orders (IOC), causing localized flash crashes.
    • The Predatory Loan: Players who are margin-called and owe money, or players who simply want to heavily leverage their positions, can approach the Bank. They can choose the exact amount they wish to borrow.
    • The 2X Amortized Bleed (Interest): The repayment terms are mathematically brutal. A player must pay back exactly 2X of whatever they borrowed. This total debt is divided equally by the remaining minutes of the game, and this specific chunk is automatically deducted from their cash balance every single minute.
        ◦ Example: If a player borrows $20,000 at Minute 70 (with 60 minutes left in the game), their total debt is $40,000. The Bank will automatically chip away $666.67 ($40,000 / 60) from their free cash every minute until the game ends. This mathematically forces them to take massive, high-risk trades just to outpace the continuous bleed.
2. Inventory Limits & Cost of Carry
    • Limit: No player may hold an absolute position (Long or Short) exceeding 100 units of any underlying asset.
    • Cost of Carry: To promote market neutrality, holding inventory hurts. Every minute, the clearing house deducts $1 from a player's cash for every unit of absolute inventory they hold.
3. The Information Architecture (Tri-Channel)
    1. The Public Ticker (The 5-Minute Pulse): Every 5 minutes, a newsflash drops. Exactly 50% of these are SIGNAL (changes Fair Value), and 50% are NOISE (obsolete, rumors, or distracting). Momentum bots will overreact to the NOISE. Elite traders must identify NOISE, fade the bot's price movement, and pocket the difference when the market realizes FV hasn't changed.
    2. The Deal Desk (DMs): Private, bargained OTC trades (detailed below).
    3. The Premium Feed (Latency Auction & Asymmetry): Starting at Minute 15, and repeating exactly every 15 minutes (30, 45, 60, etc.), the Host initiates a Blind Auction.
        ◦ Players have 30 seconds to secretly bid cash.
        ◦ Top 30% of active bidders win and pay their bid.
        ◦ Crucial Rule: At the end of the 30 seconds, the Host must publicly declare the cutoff price (e.g., "The lowest winning bid was $450").
        ◦ Winners get 10 seconds of early access to all Ticker news for the next 15 minutes.
4. The Bot Ecosystem & Liquidity Dynamics
The exchange is populated by algorithmic participants that act as both liquidity providers (Makers) and toxic order flow (Takers). Hosts will adjust their parameters to pressure the human traders.
    • 1. The HFT Market Maker (Liquidity Provider):
        ◦ Logic: Knows the true Fair Value (FV) and constantly provides two-sided quotes (Bid/Ask) for all assets and options.
        ◦ Adverse Selection Defense: If humans or other bots aggressively buy Calls from the MM, its inventory becomes highly short. To defend itself, the MM will skew its quotes upward (raising the Ask to stop selling, raising the Bid to attract buyers) and widen its spread proportionally to its absolute inventory to discourage further toxic flow.
    • 2. The Retail/Momentum Bot (Liquidity Taker):
        ◦ Logic: Blindly reactive and completely ignores the difference between SIGNAL and NOISE.
        ◦ Action: On any positive-sounding news ticker, it aggressively crosses the spread and hits the Ask on underlying assets and Call options (FOMO buying). Smart human players will anticipate this and place limit sell orders right before noise events to farm the bot for premium.
    • 3. The Vega Bot (Volatility Sniper):
        ◦ Logic: Trades purely on the "Uncertainty Premium" (Time Value).
        ◦ Action: One minute before a scheduled, high-impact news event (e.g., the Dis-Correlation Nuke), this bot aggressively lifts the asks to buy Straddles (buying both Calls and Puts). The exact second the news drops and the event is resolved, uncertainty vanishes. The Vega Bot violently dumps its entire inventory, hitting the bids to capture the intrinsic jump and simulating a massive Volatility Crush.
    • 4. The Parity Arb Bot (Structural Enforcer):
        ◦ Logic: Constantly scans the options order book to enforce the Iron Law of options pricing: $Call - Put = Stock - Strike$.
        ◦ Action: If a human trader, sweating from cognitive overload, misprices an option spread by even a few dollars, this bot instantly executes a 3-leg trade (e.g., Sell Overpriced Call, Buy Put, Buy Underlying Stock) to lock in risk-free profit, draining the human's cash balance.
🤝 The Deal Desk (OTC Bargaining Mechanics)
Separate from the open order book, the Host runs the "Deal Desk" via DMs. Deals are offered exactly on the 2.5-minute offset of the 10-minute intervals (e.g., Minutes 2.5, 12.5, 22.5...). This offset ensures deals overlap with maximum order book chaos.
The Workflow:
    1. The Offer: Host DMs a player: "I am offering a block of X asset for $Y. You have 15 seconds to reply: ACCEPT, REJECT, or BARGAIN [Price]."
    2. The Bargain: If a player replies BARGAIN [New Price], they run a risk. The Host runs a background probability check based on distance from Fair Value. Underpaying a buy or overasking a sell is linear: 0% off fair → 0% rejection; 25% off fair → 100% rejection.
    3. The Obligation: If accepted, the trade is binding. A player cannot back out if a new Ticker flash drops during the 5-second bargaining delay.
Pre-Determined OTC Deals (Host Cheat Sheet)
Note: These prices assume the host checks current FV. Prices below are marked as % of current FV.
    • Minute 12.5 (The "Too Good to be True" Block):
        ◦ Offer: Sell 50 Aerium to Player at 95% of current FV.
        ◦ The Trap: This requires an immediate $47,500 cash outlay. If the player accepts but doesn't have the cash, they instantly Margin Call themselves. Tests cash awareness.
    • Minute 32.5 (The Paired Correlation Trade):
        ◦ Offer: Buy 20 Aerium and Sell 20 Neuro-Chips to Player for a combined net zero cash.
        ◦ The Trap: The player is taking on massive spread risk right after Neuro-chips were introduced. Tests cross-asset correlation math.
    • Minute 52.5 (The ETF Arbitrage Setup):
        ◦ Offer: Sell 10 Orbital-Station ETFs to Player at 102% of NAV.
        ◦ The Trap: It's overpriced! But the redemption window opens in 2.5 minutes. If a player thinks they can short the ETF in the open market to a retail bot before redemption, they might take this bad deal to secure the inventory.
    • Minute 72.5 (The Volatility Dump):
        ◦ Offer: Buy 15 At-The-Money Calls from the Player for 20% above Intrinsic Value.
        ◦ The Trap: Sounds great, but if the player doesn't already own the calls, accepting this means they just naked-shorted 15 calls. Tests inventory limits and assignment breach danger.
    • Minute 92.5 (The "Dis-Correlation Nuke" Aftermath):
        ◦ Offer: Sell 30 Aerium to Player at 120% of current FV (which just tanked).
        ◦ The Trap: A pure test to see if the player is reading the news. Aerium is now obsolete. Anyone who accepts this is dead in the water.
    • Minute 112.5 (The Desperation Bailout):
        ◦ Offer: Host offers to buy any single asset from the player at 90% of FV, up to 50 units.
        ◦ The Trap: A lifeline for players choking on Cost of Carry or nearing margin limits, but it forces them to lock in a 10% loss.
⏱️ The Two-Hour Crucible: Event Script
SESSION 1: Building the Economy (Minutes 0:00 - 60:00)
    • 0:00 - The Open: Market Opens. Only AERIUM (Base Resource) is available. FV starts at 1000.
    • 5:00 - Ticker (SIGNAL): "Refinery strike in Sector 4 cuts Aerium output by 12%." (Aerium FV +50. Basic speed test).
    • 10:00 - Ticker (NOISE): "Senate sub-committee discussing long-term viability of Aerium infrastructure." (FV Unchanged. Momentum bots will aggressively short. Smart players will happily buy the artificial dip from the bots, knowing FV is still 1050).
        ◦ Event: Government issues STANDARD BONDS ($10k cost, $500/5m fixed yield). Players may buy a maximum of 1 at any time.
    • 15:00 - [BLIND AUCTION 1] & Ticker (SIGNAL): "New extraction tax levied on raw Aerium. Processing costs up 8%." (Aerium FV -40. Winners get 10s head start to dump inventory).
    • 18:00 - The Structural Exploit (The Flawed Bond):
        ◦ Event: The Exchange offers the "AERIUM-PEGGED YIELD BOND."
        ◦ The Trap: The yield is explicitly stated to be: (2000 - Aerium_Price) / 10 per 5 minutes. This creates an embedded derivative. If a player buys this for "passive income" but doesn't realize the yield drops to zero (or goes negative) if Aerium spikes, they will bleed cash. Elite candidates will buy the bond, but immediately buy Aerium Calls or go Long Aerium to delta-hedge the inverse yield risk. Players may buy a any bond at most once.
    • 20:00 - Ticker (NOISE): "Celebrity influencer 'Nova' endorses Aerium on holonet." (Retail bots panic-buy. FV unchanged. Players should aggressively short the retail spike).
    • 25:00 - Ticker (SIGNAL): "Smugglers busted with 50,000 tons of counterfeit Aerium; market supply shocks." (Aerium FV +80).
    • 30:00 - [BLIND AUCTION 2] & Asset Two Intro:
        ◦ Event: NEURO-CHIPS open for trading. Correlated to Aerium.
        ◦ Ticker (SIGNAL): "Neuro-Chips approved for civilian use! Deep silicon linkage established with Aerium." (Neuro-Chip FV starts at 500. Aerium FV +20).
    • 35:00 - Ticker (NOISE): "Unverified rumor: Neuro-Chip CEO seen leaving rival's headquarters." (Extreme volatility spike, but zero math change. Pure risk-management test).
    • 40:00 - Ticker (SIGNAL): "Cobalt shortage cripples Neuro-Chip assembly lines." (Neuro-Chip FV +100).
    • 45:00 - [BLIND AUCTION 3] & The Synthetic Intro:
        ◦ Event: ORBITAL-STATION ETF opens. (1 ETF = 2 AERIUM + 1 NEURO-CHIP). ETF Creation/Redemption opens for 30s every 10 mins.
    • 50:00 - Ticker (NOISE): "Orbital-Station quarterly earnings report delayed by 1 hour due to clerical error." (FV unchanged. Arbitrage bots will still hold the line, but weak human hands will panic sell the ETF).
    • 55:00 - The Price Correction (Host Intervention):
        ◦ Newsflash: "Central Economists warn that Aerium is dangerously over-leveraged. True intrinsic valuation models dictate price should not exceed 1150." (Forces a violent sell-off).
    • 60:00: TRADING HALTED FOR HALFTIME.
        ◦ Positions do not reset. Margin calculations are finalized. Players with negative cash are publicly given Predatory Loans.
⏸️ THE HALFTIME BREAK (Minutes 60:00 - 70:00)
Players have 10 minutes to calculate their Net Asset Value, negotiate off-book alliances, and sweat their Margin Requirements.
SESSION 2: The Options Grinder & Systemic Shocks (Minutes 70:00 - 130:00)
    • 70:00 - Options Open: Session 2 begins. The OPTIONS MARKET (Aerium Calls/Puts) goes live. Options run in tight 5-minute cycles.
        ◦ The 15-Second Exercise Window: At the end of a 5-min cycle, buyers have exactly 15 seconds to DM "EXERCISE". If missed, it expires worthless. Option sellers sweat for 15s.
        ◦ The Assignment Breach: If a seller is assigned and pushed over the 100-unit inventory limit, they get a 🚨 HIGH ALERT. They have 30 seconds to trade back under the limit, or the Host forcibly liquidates them at a pre-set, terrible "Border Price."
    • 75:00 - [BLIND AUCTION 4] & Ticker (SIGNAL): "Options expire. Massive Gamma squeeze observed on Neuro-Chips." (Neuro-Chip FV +50).
    • 80:00 - The Policy Vote (Game Theory):
        ◦ The Proposal: "The Solidarity Tax." A 10% wealth tax will be levied on the Top 10% richest players to be distributed equally among the Bottom 20%.
        ◦ The Bias: Rich players are publicly outed. Voting is democratic (poor outnumber rich). If the tax passes, watch the rich players retaliate by weaponizing their massive inventory to crash the market the poor players are trading in. They could also buy into assets to reduce free cash and escaping to the top 10% class.
    • 85:00 - Ticker (NOISE): "Analyst downgrades Neuro-Chips to 'Hold', citing lack of innovation." (A lagging indicator. Zero actual FV change. Let momentum bots sell).
    • 90:00 - [BLIND AUCTION 5] & The Dis-Correlation Nuke (SIGNAL):
        ◦ Ticker: "Zero-point energy prototype successful! Aerium obsolete!"
        ◦ Impact: Aerium FV drops -300. Neuro-Chips FV spikes +200. Premium Feed winners see this 10 seconds early and ruthlessly pick off the algorithmic Arbitrage bots on the ETF.
    • 95:00 - Ticker (NOISE): "Mass protests in the capital against zero-point energy safety risks." (Sounds like a reversal for Aerium, but FV remains dead. A massive trap for traders trying to catch a falling knife).
    • 100:00 - The Government Mission (The Manufactured Bubble):
        ◦ Newsflash: "Strategic Reserves Critical. In exactly 5 minutes, the single player holding the highest inventory of Aerium will receive a massive $10,000 Government Grant."
        ◦ Impact: Intentionally breaks FV trading. Players will aggressively bid up Aerium just to win the grant, creating a massive, predictable bubble. Elite players will short the absolute top, knowing the price will violently crash the exact second the grant is awarded.
    • 105:00 - [BLIND AUCTION 6] & The Bubble Pops: Grant is awarded. Aerium demand vanishes instantly.
    • 110:00 - Ticker (NOISE): "CEO of Orbital Station tweets a rocket emoji." (Momentum bots buy the ETF. Humans should short the ETF and buy the underlying to arbitrage the irrational exuberance).
    • 115:00 - Ticker (SIGNAL): "Solar flare scrambles Neuro-Chip logic gates globally!" (Neuro-Chip FV -150).
    • 120:00 - [BLIND AUCTION 7] & The Final Squeeze: Volatility parameters for all bots are tripled. Spreads widen massively.
    • 125:00 - Ticker (SIGNAL): "Massive cyberattack disables 40% of remaining Aerium grid." (Aerium FV +120. A final violent whip-saw to catch over-leveraged shorts).
    • 130:00: TRADING HALTED. FINAL MtM CALCULATED.
