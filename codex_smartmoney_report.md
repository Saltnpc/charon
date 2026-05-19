# Smart Money as a Signal Source for Charon

## Executive Position

Smart Money should not be implemented as naive copy-trading. On Solana meme coins, the edge is not "wallet X bought, therefore buy." The edge is "a historically profitable wallet cluster created a fresh, non-dusted, non-sybil, size-adjusted accumulation event before public route confirmation, and the token survives enough microstructure checks to justify a very small, measured entry or ghost trial."

The recommended design is a two-tier Smart Money route:

1. **Smart Money Discovery:** actively monitors curated wallets and emits candidate mints from verified buy events.
2. **Smart Money Conviction Engine:** scores candidate mints by wallet quality, buy size, timing overlap, token novelty, holder/liquidity safety, and downstream confirmation from Charon's existing enrichment stack.

This route should be treated as an alpha discovery source, not a safety source. Trending and fee-claim routes are slower but have external validation. Smart Money is earlier, noisier, easier to manipulate, and more likely to catch tokens before liquidity, holders, and metadata are stable. Therefore, Smart Money candidates need stricter event validation, smaller first size, and heavier ghost learning.

## 1. Active Polling Strategy

### Recommendation

Do not poll all 80+ wallets equally for full PnL and recent transaction history. That will waste RPC/API budget and create noisy false positives. Use a **tiered wallet surveillance model**:

- **Tier A, elite wallets:** top 10-15 wallets by recent realized edge, low spam rate, repeatable early entries. Poll or subscribe aggressively.
- **Tier B, proven wallets:** next 25-40 wallets. Poll less frequently and use only for overlap confirmation.
- **Tier C, watchlist wallets:** remaining wallets. Do not use as standalone triggers. Use only as weak supporting signal or for periodic re-ranking.

The important point: Charon should rank wallets by observed behavior inside Charon, not by static curriculum status forever. A wallet that was elite historically but now farms exit liquidity or gets copied heavily must decay.

### Preferred Data Path

Best path depends on available provider features:

1. **Ideal:** Helius Enhanced Transactions or webhook address monitoring for the wallet list.
2. **Acceptable:** periodic `getSignaturesForAddress` per wallet, followed by parsed transaction fetch only for new signatures.
3. **Fallback:** poll token-account changes, but this is harder to classify because balance deltas do not always identify buy source, SOL spend, route, or transfer noise cleanly.

Use event-based ingestion if possible. Polling 80 wallets every few seconds with full parsed transactions will become expensive, rate-limited, and fragile.

### Robust Polling Architecture

Maintain per-wallet cursors:

```text
smart_wallets
- address
- label
- tier
- enabled
- quality_score
- recent_win_rate
- median_entry_mcap
- median_hold_minutes
- spam_rate
- dust_rate
- last_seen_signature
- last_polled_at_ms
- created_at_ms
- updated_at_ms

smart_wallet_events
- id
- wallet_address
- signature
- slot
- block_time_ms
- event_type              -- buy, sell, transfer_in, transfer_out, unknown
- mint
- sol_delta
- token_delta_raw
- token_delta_ui
- estimated_price_usd
- estimated_mcap_usd
- router                  -- jupiter, raydium, pump, meteora, unknown
- counterparty_program
- confidence              -- parser confidence, not trade conviction
- raw_json
- unique(signature, wallet_address, mint, event_type)
```

Polling loop:

```text
for wallet in dueWallets ordered by tier, last_polled_at:
  signatures = getSignaturesForAddress(wallet, until=last_seen_signature, limit=N)
  process oldest -> newest:
    tx = getParsedTransaction(signature) or provider enhanced tx
    event = classify wallet token/SOL deltas
    if event is verified buy:
      persist event
      update mint-level aggregation window
  advance cursor only after successful processing
```

Do not advance the cursor when parsing fails due to provider error. Keep retry counters per signature so one bad transaction does not block the wallet forever.

### Polling Frequencies

Initial conservative schedule:

- **Tier A:** every 10-20 seconds, `limit=20`.
- **Tier B:** every 45-90 seconds, `limit=20`.
- **Tier C:** every 5-15 minutes, `limit=10`, mostly for scoring and cluster support.
- **Backfill/re-rank job:** once per 6-24 hours, sample recent history and update wallet quality metrics.

If webhooks are available, still keep a slower reconciliation poll because webhooks can drop events or arrive out of order.

### Why Not Poll PnL Every Cycle

PnL endpoints are useful for wallet ranking, but not for live signal generation. They are too slow, often delayed, provider-specific, and sometimes computed from imperfect token pricing. Live route detection should come from transaction deltas. PnL should be recalculated periodically for wallet quality:

- hourly for Tier A/B if API limits allow;
- daily for all wallets;
- after a material event, such as a wallet's last N Smart Money triggers underperforming Charon ghost results.

### Elite Subset vs All 80+

Use all 80+ wallets, but not equally. The system should be asymmetric:

- Tier A can trigger candidates alone if trade size and token checks are strong.
- Tier B requires overlap or external confirmation.
- Tier C cannot trigger a candidate alone.

Static "top 15 only" is too brittle because profitable wallets rotate, get burned, split funds, or change strategy. Full equal polling is too noisy. Tiered surveillance gets the benefit of broad coverage without treating every wallet as equally predictive.

## 2. Signal Thresholds

### Core Principle

The signal is not "wallet holds token." The signal is a **fresh verified buy** with enough size, intent, and overlap to matter.

Charon currently checks saved-wallet holder exposure passively through holder lists. That is useful context but weak as a route trigger because:

- airdrops can make a wallet a holder without intent;
- dust can fake exposure;
- holder APIs can lag;
- a wallet may have sold before the holder snapshot updates;
- tiny residual balances can look like conviction.

The Smart Money route should only trigger from signed wallet activity that looks like a swap/buy, not from passive holder presence.

### Verified Buy Definition

A Smart Money buy should satisfy all of these:

- wallet's SOL/USDC/base asset balance decreased meaningfully;
- target token balance increased meaningfully;
- transaction interacted with known swap or launch programs, not only SPL transfer;
- mint is not SOL, USDC, USDT, major LST, or known infrastructure token;
- delta is above wallet-specific dust threshold;
- event was not preceded by the same token being transferred into the wallet in suspicious tiny amounts;
- token amount is still held after a short confirmation delay if possible.

Minimum buy-size thresholds should be wallet-relative, not only absolute. A 0.2 SOL buy by a small fast wallet can matter; a 0.2 SOL buy by a wallet that usually enters with 20 SOL is noise.

Recommended fields:

```text
absolute_buy_sol >= 0.2 SOL for Tier A standalone
absolute_buy_sol >= 0.4 SOL for Tier B contribution
relative_size >= 20th percentile of that wallet's historical meme entries
ignore if buy_sol < max(0.05 SOL, wallet_median_buy_sol * 0.10)
```

For extremely early Pump tokens, 0.1 SOL can be real, but Charon should not auto-buy those as normal signals. It can ghost-track them or require overlap.

### Mint-Level Aggregation

Aggregate buys into rolling windows:

```text
smart_mint_windows
- mint
- window_started_at_ms
- window_ended_at_ms
- first_seen_at_ms
- last_buy_at_ms
- unique_wallet_count
- tier_a_count
- tier_b_count
- tier_c_count
- weighted_wallet_score
- total_buy_sol
- median_buy_sol
- max_buy_sol
- first_entry_mcap_usd
- latest_mcap_usd
- source_event_ids_json
- status
```

Use separate windows:

- **hot window:** 0-5 minutes, best for early discovery;
- **confirmation window:** 5-20 minutes, better for overlap;
- **late window:** 20-60 minutes, mostly avoid unless external routes confirm.

### Conviction Score

Use a deterministic score before LLM. The LLM should explain and compare candidates, not compensate for missing trade-event math.

Example scoring model:

```text
score =
  35 * wallet_cluster_score
+ 20 * buy_size_score
+ 15 * timing_score
+ 10 * novelty_score
+ 10 * liquidity_safety_score
+ 10 * holder_distribution_score
- penalties
```

Wallet cluster score:

```text
wallet_cluster_score =
  sum(log1p(wallet_quality_score) * tier_weight * size_weight * freshness_weight)
```

Tier weights:

```text
Tier A = 1.00
Tier B = 0.55
Tier C = 0.20
```

Freshness:

```text
0-2 min   = 1.00
2-5 min   = 0.85
5-10 min  = 0.65
10-20 min = 0.35
20m+      = 0.10
```

Size weight:

```text
size_weight = clamp(buy_sol / wallet_median_buy_sol, 0.25, 2.0)
```

### Overlap Thresholds

There is no universal "2+ wallets" rule. The better threshold is tier-sensitive:

**Standalone Tier A trigger**

- 1 elite wallet can create a candidate only if:
  - buy is above wallet-specific normal size;
  - token is fresh;
  - no dust/transfer contamination;
  - liquidity and holder concentration are not catastrophic;
  - Charon enters only ghost or micro-size unless external confirmation appears.

**High-conviction trigger**

- 2 Tier A wallets within 5 minutes, or
- 1 Tier A + 2 Tier B within 10 minutes, or
- 4+ mixed wallets with at least 1 Tier A/B and meaningful total buy SOL.

**Weak trigger**

- 2 Tier B wallets without Tier A: ghost only or route candidate with reduced score.
- Any Tier C-only cluster: never buy; use as learning data.

Recommended initial route thresholds:

```text
SMART_MIN_SCORE_TO_CANDIDATE=55
SMART_MIN_SCORE_TO_LLM=70
SMART_MIN_SCORE_TO_CONFIRM=80
SMART_MIN_SCORE_TO_LIVE=90
SMART_MIN_TIER_A_STANDALONE_BUY_SOL=0.5
SMART_MIN_OVERLAP_WALLETS=2
SMART_OVERLAP_WINDOW_MS=600000
SMART_MAX_EVENT_AGE_MS=900000
```

For current Charon, I would start in dry-run with:

- candidate emission at score >= 55;
- LLM-eligible at score >= 70;
- no automatic live buys until ghost data proves route-specific expectancy.

### Distinguishing Conviction From Random Micro-Gambles

Key features:

- **Buy size vs wallet norm:** compare to that wallet's median and percentile distribution.
- **Token freshness:** early can be good, but pre-liquidity chaos should be penalized.
- **Follow-through:** wallet does not immediately sell within 30-120 seconds.
- **Cluster independence:** wallets are not funded by same source or repeatedly co-buying everything.
- **Entry mcap fit:** compare token market cap to that wallet's historical winning entries.
- **Program route:** real swap/launch interaction beats passive token transfer.
- **Repeat wallet behavior:** some wallets spray 30 tiny buys/day; those should have low signal weight.

Wallet-level quality should include a "selectivity" metric:

```text
selectivity = profitable_triggers / all_verified_buys_seen_by_charon
```

A wallet with 300 buys and 10 wins may have impressive screenshots but poor route value for an automated bot.

## 3. Pitfalls and Manipulations

### Airdrop and Dust Faking

Attackers can send tokens to known Smart Money wallets, making holder checks show exposure. This is the biggest reason not to use passive holder presence as a trigger.

Filters:

- ignore transfer-only token increases;
- require SOL/base asset spend in same transaction;
- require known swap/launch program interaction;
- ignore tokens where first event is inbound SPL transfer;
- require minimum token value estimate where possible;
- mark dusted wallet-mint pairs and suppress holder-based exposure for that mint.

### Wallet Impersonation by Funding Graph

People may create wallets funded by known wallets or CEX paths and market them as "smart." Conversely, real wallets may split into new addresses.

Filters:

- do not auto-promote wallets based on funding relationship alone;
- track behavioral performance, not identity claims;
- create wallet clusters, but score each address separately until its own outcomes prove edge.

### Copy-Trade Crowding

Popular wallets become toxic signals. If too many bots monitor the same wallet, its buys become immediate exit liquidity events. The first buy may still win, but the second wave often buys the local top.

Filters:

- measure post-event slippage: price movement from wallet buy to Charon detection;
- penalize if market cap is already up >30-50% since first smart event;
- penalize if buy arrives after a burst of swap count acceleration without liquidity growth;
- require tighter max event age for popular wallets;
- prefer wallets with low public visibility if known.

### Front-Running and Latency Disadvantage

If Charon polls every 30-90 seconds, it will often be behind faster bots. Buying after an elite wallet on a 20k mcap token can be buying after a 2x candle.

Filters:

- compute `detection_delay_ms = now - block_time`;
- compute `mcap_change_since_event` using price at event if provider supports it, otherwise first snapshot vs current;
- use smaller size or ghost-only if delay >120 seconds on low-liquidity tokens;
- do not chase if current mcap is >2x first detected mcap unless external signal quality is exceptional.

### Sybil Wallet Overlap

Multiple "smart" wallets may be controlled by one operator or funded as a bundle. Counting them as independent overlap is dangerous.

Filters:

- funding graph similarity;
- repeated co-entry correlation;
- identical timing pattern across many mints;
- same exit timing pattern;
- same first funder or shared intermediate wallets;
- common DEX route and priority-fee fingerprint, if available.

Score overlap by cluster, not address count:

```text
effective_wallet_count = count(unique_wallet_clusters)
```

Two wallets in the same cluster should count closer to 1.2 than 2.0.

### Bundled Launches and Insider Wallets

Some "smart" buys are insiders creating the trap. Early wallet accumulation can mean the dev group is loading before promotion, not that external smart money discovered the coin.

Filters:

- high bundler rate;
- top holder concentration;
- creator/dev wallet relation to buying wallets;
- many early wallets funded shortly before launch;
- liquidity too thin relative to Smart Money buy size;
- suspicious freeze/mint authority or mutable metadata where applicable.

Smart Money should never override hard rug checks. It can raise urgency; it cannot make an unsafe token safe.

### Sell-Side Blindness

A buy signal without sell monitoring is incomplete. Many profitable wallets scalp. Charon may enter from their buy and still be holding after they exit.

Required:

- monitor sells from the same Smart Money wallets for open positions;
- reduce confidence if lead wallet sells >50% before Charon enters;
- for live positions, treat elite-wallet exit as a risk event, not automatic sell;
- if multiple triggering wallets exit within short window, tighten trailing stop or exit dry-run/live depending on mode.

### API Data Poisoning and Parser Errors

Parsed transactions differ across providers. Meme-coin routes use many programs and aggregator hops. False classification is inevitable.

Filters:

- store parser confidence;
- keep raw JSON for audits;
- require confidence >= high threshold for standalone trigger;
- compare token account deltas directly rather than trusting labels only;
- write unit tests against real transaction fixtures.

## 4. Integration With Charon

### Route Shape

Add a new signal module:

```text
src/signals/smartMoney.js
```

Responsibilities:

- poll/ingest wallet events;
- classify verified buys/sells;
- aggregate mint windows;
- emit `processCandidateFromSignals({ mint, route: 'smart_money', smartMoney })`;
- update wallet and route performance stats.

Extend candidate structure:

```js
candidate.smartMoney = {
  score,
  windowMs,
  firstSeenAtMs,
  lastEventAtMs,
  uniqueWalletCount,
  effectiveWalletCount,
  tierACount,
  tierBCount,
  totalBuySol,
  medianBuySol,
  maxBuySol,
  triggeringWallets: [
    {
      address,
      label,
      tier,
      qualityScore,
      buySol,
      relativeSize,
      signature,
      blockTimeMs,
      ageMs,
      parserConfidence,
    }
  ],
  flags: [],
};
```

Update `signalLabel()` to include `smart_money`. Update LLM compaction to include this object explicitly.

### Candidate Filtering

Current `filterCandidate()` is route-agnostic and mostly uses fee/trending/holder data. Smart Money needs route-specific filters. Do not force Smart Money through trending requirements, because the point is to discover before trending. Instead add Smart Money-specific gates:

```text
if route == smart_money:
  require smartMoney.score >= min_smart_money_score
  require effectiveWalletCount >= min_effective_wallets unless elite standalone
  require totalBuySol >= min_total_smart_buy_sol
  require maxEventAgeMs <= SMART_MAX_EVENT_AGE_MS
  reject transfer-only or low parser confidence events
  reject if top holder concentration exceeds route cap
  reject if liquidity below executable threshold
  reject if current mcap has moved too far from first event
```

Recommended default strategy config:

```json
{
  "smart_money_enabled": true,
  "smart_min_score": 70,
  "smart_min_effective_wallets": 1.8,
  "smart_min_total_buy_sol": 0.6,
  "smart_max_event_age_ms": 900000,
  "smart_min_parser_confidence": 0.85,
  "smart_max_mcap_move_since_first_event_pct": 80,
  "smart_elite_standalone_min_score": 85,
  "smart_elite_standalone_min_buy_sol": 0.5
}
```

### Dry-Run and Ghost Treatment

Smart Money candidates should initially be biased toward ghost tracking. Trending candidates already have public market validation. Smart Money candidates are earlier and have higher adverse-selection risk.

Recommended progression:

1. **Phase 0: observe only**
   - Save Smart Money candidates.
   - Do not enter dry-run positions.
   - Track 5m/15m/1h outcome from first event.

2. **Phase 1: dry-run only**
   - Create dry-run positions for score >= 70.
   - Size is virtual but use realistic slippage assumptions.
   - Add ghost snapshots at tighter early offsets: 1m, 3m, 5m, 10m, 15m, 30m, 60m.

3. **Phase 2: confirm mode**
   - Only score >= 85 or strong cluster.
   - Human approve/reject through Telegram.

4. **Phase 3: capped live**
   - Only after route-specific ghost expectancy is positive over enough samples.
   - Start with 25-50% normal position size.

Add Smart Money-specific ghost metrics:

```text
- pnl from first smart event
- pnl from Charon detection time
- pnl from actual Charon entry time
- max adverse excursion in first 5m
- max favorable excursion in first 15m/60m
- triggering wallets still holding after 5m/15m
- lead wallet exit-before-charon-entry flag
- overlap count at entry
```

This matters because a Smart Money route can look profitable from first wallet entry while being unprofitable from Charon's actual detection latency. Charon must optimize for executable edge, not screenshot edge.

### Position Sizing

Smart Money route should use smaller initial size than Trending unless confirmed by overlap.

Initial sizing:

```text
score 70-79: ghost or dry-run only
score 80-89: 0.03-0.05 SOL confirm-mode max
score 90+:    0.05-0.10 SOL max, only after proven route expectancy
```

Live size multiplier:

```text
smart_size_multiplier =
  base_size
* route_expectancy_multiplier
* signal_score_multiplier
* liquidity_multiplier
* latency_multiplier
* wallet_exit_multiplier
```

Where:

```text
route_expectancy_multiplier = 0.25 until proven, max 1.0
latency_multiplier = 1.0 if <30s, 0.7 if <90s, 0.4 if <180s, 0 if later and already pumped
wallet_exit_multiplier = 0.5 if lead wallet partially sold, 0 if cluster dumped
liquidity_multiplier caps size to avoid >1-2% pool impact
```

Never let Smart Money automatically increase size just because wallets are famous. Famous wallets are exactly where copy-trade crowding is worst.

### Entry Rules vs Trending Route

Smart Money route should differ from Trending route:

| Dimension | Trending Route | Smart Money Route |
|---|---:|---:|
| Discovery timing | Later | Earlier |
| External validation | Higher | Lower |
| Manipulation risk | Wash/bundler | Dust/sybil/copy-crowd |
| Initial mode | dry-run/confirm/live depending config | observe/dry-run first |
| Size | normal strategy size | 25-50% normal until proven |
| Required filters | volume/swaps/rug/bundler | verified buy/overlap/latency/cluster |
| Sell monitoring | normal TP/SL/trailing | include triggering-wallet exits |
| Learning focus | candidate quality | executable latency and wallet alpha decay |

### LLM Prompt Changes

The LLM should receive Smart Money evidence in compact, structured form and should be instructed not to overweight famous labels. Add to system prompt:

```text
For smart_money candidates, treat wallet buys as early noisy evidence, not proof.
Prefer verified buy clusters with meaningful size, low latency, independent wallets, and clean token safety.
Penalize dust, transfer-only exposure, stale events, sybil-like wallet overlap, and tokens already pumped far from first smart entry.
```

The LLM should never see only `savedWalletExposure.holderCount` for Smart Money decisions. It needs event details: buy size, age, wallet tier, whether still holding, and mcap movement since event.

### Telegram UX

Smart Money alerts should expose the evidence quickly:

```text
SM score: 84 | 2.3 effective wallets | 1.8 SOL total | first seen 3m ago
Wallets: A:wallet1 0.9 SOL, A:wallet2 0.6 SOL, B:wallet3 0.3 SOL
Mcap: first 42k -> now 57k (+36%)
Flags: no dust, no early sell, top20 34%, liquidity 18k
Mode: dry-run because route not live-proven
```

This makes operator review much better than a vague "smart wallet holds this token."

## Implementation Plan

### Step 1: Data Model

Add tables:

- `smart_wallets`
- `smart_wallet_events`
- `smart_mint_windows`
- `smart_wallet_clusters`
- `smart_route_stats`

Keep `saved_wallets` for passive exposure, but do not overload it with active route metadata. The current table has only `label`, `address`, `created_at_ms`; active Smart Money needs ranking, tiering, cursors, and stats.

### Step 2: Event Classifier

Build a transaction classifier with explicit confidence levels:

```text
HIGH:
  SOL/base decreases, token increases, known swap program, no suspicious transfer-only path.

MEDIUM:
  token increases and known program seen, but base asset delta ambiguous.

LOW:
  holder/token balance changed but route unclear.
```

Only HIGH should trigger. MEDIUM can support an already-triggered cluster. LOW is stored for analysis only.

### Step 3: Aggregator

Every verified buy updates a mint-level rolling window. The aggregator computes:

- effective wallet count;
- weighted wallet score;
- buy-size normalized score;
- latency;
- cluster independence;
- first-event to current mcap movement;
- disqualifying flags.

Only then emit a Charon candidate.

### Step 4: Candidate Integration

Extend `buildCandidate()` to accept `smartMoney` in the signal payload and include it in the candidate JSON. Add route-specific filters in `filterCandidate()`. Extend `compactCandidateForLlm()`.

### Step 5: Ghost Learning

Add Smart Money route outcome analysis:

- score bucket vs realized PnL;
- wallet tier vs realized PnL;
- overlap count vs realized PnL;
- latency bucket vs realized PnL;
- buy-size percentile vs realized PnL;
- holder concentration vs failure rate;
- first-event mcap vs upside.

The route should earn live-trading permission from data.

### Step 6: Sell Monitoring

For any open dry-run/live Smart Money position, subscribe/poll triggering wallets more aggressively for sells. Add sell-pressure events:

```text
smart_wallet_exit_events
- position_id
- mint
- wallet_address
- sold_percent_est
- signature
- at_ms
- exit_pressure_score
```

Use this in position management:

- one triggering wallet partial sells: tighten trailing or annotate risk;
- lead wallet fully exits quickly: consider early exit;
- cluster exits: exit or mark as high-risk immediately.

## Hard Rules I Would Enforce

1. **No transfer-only Smart Money triggers.** A wallet must spend value.
2. **No Tier C standalone triggers.** Ever.
3. **No live buys before route-specific ghost expectancy is positive.**
4. **No buys if Charon detects after the easy move.** If first smart entry was 40k mcap and Charon sees 160k mcap six minutes later, the signal is stale.
5. **No Smart Money override of rug filters.** Wallets can be insiders, paid, compromised, or wrong.
6. **No fixed wallet worship.** Wallet weights must decay with poor Charon-observed results.
7. **Monitor sells as seriously as buys.** Smart wallets often scalp; Charon cannot hold blindly.

## Recommended Initial Config

```env
SMART_MONEY_ENABLED=true
SMART_POLL_TIER_A_MS=15000
SMART_POLL_TIER_B_MS=60000
SMART_POLL_TIER_C_MS=600000
SMART_OVERLAP_WINDOW_MS=600000
SMART_MAX_EVENT_AGE_MS=900000
SMART_MIN_EVENT_CONFIDENCE=0.85
SMART_MIN_SCORE_TO_CANDIDATE=55
SMART_MIN_SCORE_TO_LLM=70
SMART_MIN_SCORE_TO_CONFIRM=85
SMART_MIN_EFFECTIVE_WALLETS=1.8
SMART_MIN_TOTAL_BUY_SOL=0.6
SMART_ELITE_STANDALONE_MIN_SCORE=85
SMART_ELITE_STANDALONE_MIN_BUY_SOL=0.5
SMART_MAX_MCAP_MOVE_SINCE_FIRST_EVENT_PCT=80
SMART_INITIAL_SIZE_MULTIPLIER=0.35
SMART_GHOST_ONLY_UNTIL_SAMPLES=100
```

For the first 100-200 samples, keep the route in observe/dry-run. The target is not immediate profit. The target is to identify which wallet tiers, event ages, overlap patterns, and mcap ranges are actually executable for Charon.

## Final Strategic View

Smart Money is most valuable as an **early candidate generator** and **context amplifier**, not as an autopilot. The winning implementation is boring and adversarial: verify real buys, normalize by wallet behavior, aggregate independent overlap, punish latency, track exits, and let Charon's ghost system prove whether the route has executable edge.

The correct first version should be conservative:

- active monitor all wallets with tiered cadence;
- trigger mostly from Tier A and Tier A/B overlap;
- reject passive holder-only signals;
- dry-run aggressively;
- add tighter ghost snapshots;
- only graduate to confirm/live after route-level statistics show positive expectancy after Charon's actual detection delay.

If implemented this way, Smart Money becomes a high-quality discovery route. If implemented as "80 wallets bought/hold this token, ape now," it will mostly automate becoming exit liquidity for faster bots and the same wallets being copied.
