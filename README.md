# Charon

Charon is an autonomous Solana meme-coin trench agent. It screens high-noise Pump.fun token flow using multi-strategy overlap signals, LLM-powered analysis, ghost post-trade tracking, and continuous self-learning — all controlled via Telegram.

> **⚠️ ALERT**
> This codebase is in active development and testing. The developer does not guarantee any financial results. Use at your own risk.

---

## Architecture Overview

```
Signal Server (fee-claim, graduated, trending)
        ↓
  Candidate Builder
  ├── Jupiter Audit (safety gates)
  ├── GMGN Enrichment (holder, liquidity, fees)
  ├── Holder Analysis (organic filtering)
  └── Twitter Narrative
        ↓
  ┌─── Loop per Strategy (dry-run: all 4 parallel) ───┐
  │ filterCandidate(candidate, strategy)                │
  │   → Safety Gates (hard: mint/freeze authority)      │
  │   → Soft Warnings (dev hold, bot holders, etc.)     │
  │   → Holder Velocity Check                           │
  │   → Market Cap, Liquidity, Age filters              │
  │                                                     │
  │ LLM Screening (Shadow Mode in dry-run)              │
  │   → Verdict logged, does NOT block entry            │
  │                                                     │
  │ Position Created (per-strategy attribution)         │
  └─────────────────────────────────────────────────────┘
        ↓
  Position Monitor
  ├── Multi-Stage Take Profit (staged partial sells)
  ├── Stop Loss + Trailing TP
  └── Ghost Post-Trade Tracking
        ↓
  Learning Engine
  ├── Outcome Classification
  ├── Pattern Detection (by route, strategy, signal)
  ├── Lesson Generation
  └── Telegram Report
```

## Key Features

| Feature | Description |
|---|---|
| **4 Parallel Strategies** | Sniper, Dip Buy, Smart Money, Degen — all run simultaneously during dry-run |
| **Multi-Stage TP** | Staged partial sells with proper PnL accounting (initial size, realized PnL, remaining fraction) |
| **LLM Shadow Mode** | AI screening via MiMo v2.5 Pro — verdicts are logged but don't block rule-based entries during dry-run |
| **Holder Growth Velocity** | Measures holder growth speed (holders/minute) since pool creation for quality filtering |
| **Safety Gates** | Hard gates on mint/freeze authority; soft warnings on dev hold, bot holders, etc. |
| **Ghost Tracking** | Post-trade price monitoring at intervals to measure missed upside and avoided downside |
| **Self-Learning** | Continuous pattern detection, lesson generation, and strategy comparison reports |
| **98 Smart Wallets** | Pre-loaded alpha wallet list for saved-wallet exposure analysis |
| **3 Execution Modes** | `dry_run` (simulated), `confirm` (Telegram approval), `live` (auto-execute via Jupiter Ultra) |

---

## Strategies

| Strategy | Entry Mode | LLM | TP Stages | Key Filters |
|---|---|---|---|---|
| **Sniper** | Immediate | Shadow | 25% @ +150%, 25% @ +300% | Fee-claim overlap, 2+ sources, mcap 7K-200K |
| **Dip Buy** | Wait for dip | Shadow | 30% @ +80%, 30% @ +150% | ATH distance ≥-40%, mcap 25K-500K |
| **Smart Money** | Immediate | Shadow | 20% @ +150%, 25% @ +400% | 1000+ holders, strict trending quality |
| **Degen** | Immediate | Off | 40% @ +80%, 30% @ +200% | Low threshold, rule-based only, fast in/out |

Manage strategies via Telegram:

```bash
/strategy              # List all strategies
/strategy sniper       # View sniper config
/stratset sniper tp_percent 200   # Update a parameter
```

---

## Install

```bash
git clone https://github.com/Saltnpc/charon.git
cd charon
npm install
node import_wallets.js   # Import 98 smart wallets into database
cp .env.example .env     # Then edit .env with your credentials
```

### Run

```bash
npm start
# or
node src/index.js
```

### Run with PM2 (recommended for VPS)

```bash
pm2 start src/index.js --name charon
pm2 save
```

### Run on Termux (Android)

```bash
pkg update && pkg upgrade
pkg install nodejs git build-essential python
termux-wake-lock
git clone https://github.com/Saltnpc/charon.git
cd charon
npm install
node import_wallets.js
nano .env                # Fill in your credentials
node src/index.js
```

---

## Configuration

### Required

```env
# Telegram
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id

# Signal Server
SIGNAL_SERVER_URL=https://api.thecharon.xyz/api
SIGNAL_SERVER_KEY=your_key

# Trading Mode
TRADING_MODE=dry_run
```

### RPC (required for live execution)

```env
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
SOLANA_WS_URL=wss://mainnet.helius-rpc.com/?api-key=YOUR_KEY
# or just:
HELIUS_API_KEY=your_key
```

### GMGN Enrichment

```env
GMGN_ENABLED=true
GMGN_API_KEY=your_key
GMGN_REQUEST_DELAY_MS=2500
```

Enriches candidates with holder count, liquidity, fee data, and social links. Rate-limited — keep delay at 2500ms+.

### LLM (AI Screening)

```env
ENABLE_LLM=true
LLM_BASE_URL=https://opengateway.gitlawb.com/v1/xiaomi-mimo
LLM_API_KEY=none
LLM_MODEL=mimo-v2.5-pro
LLM_TIMEOUT_MS=60000
```

`LLM_BASE_URL` accepts any OpenAI-compatible endpoint. Default is Xiaomi MiMo v2.5 Pro via GitLawb gateway (free). Other options: OpenAI, Groq, local Ollama.

Set `ENABLE_LLM=false` to disable. Strategies with `use_llm: false` (e.g. degen) skip LLM automatically.

### Live Execution

```env
SOLANA_PRIVATE_KEY=your_base58_key
JUPITER_API_KEY=your_key
JUPITER_SWAP_BASE_URL=https://api.jup.ag/swap/v2
LIVE_MIN_SOL_RESERVE=0.02
```

Swaps use Jupiter Ultra — slippage and routing handled automatically.

---

## Execution Modes

| Mode | Behavior | Wallet Needed |
|---|---|---|
| `dry_run` | Simulated buys/sells in SQLite. All 4 strategies run in parallel. | No |
| `confirm` | Sends Telegram intent with approve/reject buttons. | Yes |
| `live` | Auto-executes via Jupiter Ultra after strategy + LLM approval. | Yes |

---

## Safety Gates

| Check | Type | Behavior |
|---|---|---|
| Mint Authority active | 🔴 Hard Gate | Candidate rejected — dev can mint unlimited tokens |
| Freeze Authority active | 🔴 Hard Gate | Candidate rejected — dev can freeze wallets |
| Dev hold > 30% | 🟡 Soft Warning | Logged, learning tracks correlation |
| Creator hold > 30% | 🟡 Soft Warning | Logged, learning tracks correlation |
| Bot holders > 10% | 🟡 Soft Warning | Logged, learning tracks correlation |
| Fresh wallet / rat trader | 🟡 Soft Warning | Logged, learning tracks correlation |

---

## Telegram Commands

```bash
/menu                          # Interactive settings menu
/strategy                      # List all strategies
/strategy <id>                 # View strategy config
/stratset <id> <key> <value>   # Update strategy parameter
/positions                     # View open positions
/candidate <mint>              # Lookup candidate by mint
/filters                       # View current filter settings
/pnl                           # Portfolio PnL summary
/learn <window>                # Trigger learning analysis
/lessons                       # View active lessons
/walletadd <label> <address>   # Add tracked wallet
/walletremove <label>          # Remove tracked wallet
/wallets                       # List all tracked wallets
```

---

## Storage

Charon uses `charon.sqlite` (auto-created on first run) storing:

- Candidates and filter results
- LLM decisions and batch logs
- Decision logs (per-strategy, with rejection reasons)
- Positions and trades (with multi-stage TP accounting)
- Trade intents
- Saved/tracked wallets (98 pre-loaded via `import_wallets.js`)
- Strategy configurations
- Price alerts
- Ghost tracking jobs and snapshots
- Position outcomes and classifications
- Learning runs, lessons, and patterns

Open positions resume monitoring after restart.

---

## Learning System

Charon's learning engine runs periodically and:

1. **Classifies** closed positions into outcomes (winner, loser, missed upside, etc.)
2. **Detects patterns** across routes, strategies, signals, and market conditions
3. **Generates lessons** with evidence-backed confidence scores
4. **Compares strategies** head-to-head (win rate, avg PnL, per-route performance)
5. **Reports** findings to Telegram

During dry-run, lessons are **shadow-only** — they're recorded but don't auto-tune parameters.

---

## API Usage Notes

- **GMGN**: Rate-limited. Keep `GMGN_REQUEST_DELAY_MS=2500` or higher.
- **Jupiter**: Called per candidate and per position refresh. Auto-backs off on 429s.
- **Helius RPC**: Position monitoring polls every `POSITION_CHECK_MS` (default 10s). Use paid plan for live.
- **LLM**: One call per batch cycle. MiMo v2.5 Pro is free via GitLawb gateway.

---

## Project Structure

```
charon/
├── src/
│   ├── db/
│   │   ├── connection.js      # Schema, migrations, strategy seeds
│   │   ├── settings.js        # Hot-read settings & strategy helpers
│   │   ├── positions.js       # Position CRUD, multi-stage TP accounting
│   │   └── ghost.js           # Ghost tracking job management
│   ├── enrichment/
│   │   ├── jupiter.js         # Jupiter asset, holders, chart, audit
│   │   ├── gmgn.js            # GMGN token info enrichment
│   │   └── wallets.js         # Saved wallet exposure analysis
│   ├── pipeline/
│   │   ├── candidateBuilder.js # Build + filter candidates per strategy
│   │   ├── orchestrator.js    # Main loop: multi-strategy parallel processing
│   │   └── llm.js             # LLM batch screening (shadow mode)
│   ├── execution/
│   │   └── positions.js       # Position monitoring, TP/SL/trailing logic
│   ├── learning/
│   │   ├── classify.js        # Outcome classification
│   │   ├── patterns.js        # Pattern detection & grouping
│   │   ├── ghost.js           # Ghost post-trade tracking
│   │   ├── lessons.js         # Lesson generation & governance
│   │   ├── review.js          # Auto-review orchestration
│   │   ├── summary.js         # Learning window summaries
│   │   └── report.js          # Telegram report formatting
│   ├── telegram/
│   │   └── commands.js        # All Telegram bot commands
│   ├── app.js                 # Telegram bot setup
│   ├── config.js              # Environment config loader
│   └── index.js               # Entry point
├── import_wallets.js          # Import wallets from wallet tracker.md
├── wallet tracker.md          # 98 alpha wallets for tracking
├── test_mimo.mjs              # LLM compatibility test
├── .env.example               # Environment template
└── package.json
```

## License

Private use only.
