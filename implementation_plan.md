# Charon Strategic Improvement — Implementation Plan (FINAL v3)

> Berdasarkan: Ponyin.id + Codex GPT-5.5 Strategic Review + Codex GPT-5.5 Learning Review + Opus Review + Live API Testing + Diskusi
> Status: **Siap Eksekusi (oleh Codex)**

---

## Keputusan Yang Sudah Final

| Keputusan | Hasil |
|---|---|
| Mode operasi awal | `dry_run` selama 7+ hari |
| Multi-strategy | ✅ Semua 4 strategi jalan sekaligus saat dry-run |
| Budget per-strategy | 1 SOL virtual (≈10 posisi @ 0.1 SOL) |
| Screening LLM | **Shadow Mode** — verdict dicatat tapi tidak blocking entry |
| Learning LLM | ✅ Aktif — analisis data, bikin lessons, kirim report |
| Safety check source | Jupiter `audit` sebagai sumber utama |
| Safety Gates | **Hanya Mint & Freeze Authority yang Hard Gate**. Sisanya soft warning. |
| Capital Protection | Skip untuk dry-run, auto-aktif saat `live` |
| Auto-tuning | **Shadow only** — hitung rekomendasi, jangan terapkan otomatis |
| API Keys | GMGN ✅ Signal Server ✅ |

---

## Skema Execution Mode

| Fitur | `dry_run` | `confirm` | `live` |
|---|:---:|:---:|:---:|
| Multi-Strategy Parallel | ✅ Semua | ⚠️ 1 saja | ⚠️ 1 saja |
| Screening LLM | ✅ Shadow (catat, jangan blokir) | ✅ Aktif | ✅ Aktif |
| Learning LLM (Lessons) | ✅ Aktif | ✅ Aktif | ✅ Aktif |
| Safety Gates (Mint/Freeze) | ✅ | ✅ | ✅ |
| Holder Analysis Fix | ✅ | ✅ | ✅ |
| Capital Protection | ❌ | ❌ | ✅ |
| Multi-Stage TP | ✅ (dengan accounting proper) | ✅ | ✅ |
| Smart Money Route | ✅ Ghost | ✅ Confirm | ✅ Live |

---

## LLM Shadow Mode (Dry-Run)

> [!IMPORTANT]
> Saat dry-run multi-strategy, Charon menjalankan **3 layer data collection** sekaligus:

```
Sinyal masuk
  ↓
Build Candidate (1x, shared enrichment)
  ↓
┌─── Loop per-strategy ──────────────────────┐
│ filterCandidate(candidate, strat)          │
│   ↓ passed?                                │
│   → createDryRunPosition(strat)            │  ← Layer 1: Strategy comparison
│                                            │
│ Screening LLM juga jalan (async)           │
│   → verdict disimpan di snapshot_json      │  ← Layer 2: LLM value measurement
│   → TIDAK memblokir entry                  │
└────────────────────────────────────────────┘
  ↓
Learning LLM (berkala via auto-review)
  → classify positions → detect patterns      ← Layer 3: Continuous learning
  → generate lessons → report ke Telegram
```

---

## P0 — WAJIB Sebelum Dry-Run

### P0.1 Strategy Attribution End-to-End
- `settings.js`: Tambah `allActiveStrategies()`
- `candidateBuilder.js`: `filterCandidate(candidate, strategyOverride)` — backward compatible
- `orchestrator.js`: Loop `allActiveStrategies()` saat dry-run, simpan per-strategy filter results di `candidate.strategyFilters`
- `positions.js (db)`: `createDryRunPosition()` terima `strategyOverride`, simpan strategy config di `snapshot_json`
- `positions.js (exec)`: `refreshCandidateForExecution(row, strategyOverride)` — filter pakai strategi posisi, bukan global
- `connection.js`: Enable semua 4 strategi (`enabled = 1`)

### P0.2 Fix Duplicate & Capacity Per-Strategy
- `createDryRunPosition()`: `SELECT id FROM dry_run_positions WHERE mint = ? AND strategy_id = ? AND status = 'open' LIMIT 1`
- `canOpenMorePositions()`: Hitung per-strategy saat dry-run (`WHERE strategy_id = ? AND status = 'open'`).

### P0.3 Fix Learning Summary untuk Strategy Comparison
Tambah di `summarizeLearningWindow()` dan `learningReportText()` untuk membandingkan performa 4 strategi secara head-to-head (win rate, avg PnL, dll).

### P0.4 Multi-Stage TP dengan Proper Accounting
Tambah kolom DB: `initial_size_sol`, `realized_pnl_sol`, `remaining_fraction`, `tp_stage_index`.
Update logika di `refreshPosition()` agar PnL akurat saat partial exit.

**TP Stages Config (Lebih Degen):**
- **sniper**: 25% sell @ +150%, 25% sell @ +300%, 50% ride, 20% trail
- **dip_buy**: 30% sell @ +80%, 30% sell @ +150%, 40% ride, 15% trail
- **smart_money**: 20% sell @ +150%, 25% sell @ +400%, 55% ride, 25% trail
- **degen**: 40% sell @ +80%, 30% sell @ +200%, 30% ride, 10% trail ketat

---

## P1 — Should Have

### P1.1 Safety Gates di `filterCandidate()` (REVISED)

| Check | Type | Alasan |
|---|---|---|
| Mint Authority = false | 🔴 **Hard Gate** | Mekanikal — dev PASTI bisa cetak token = rug |
| Freeze Authority = false | 🔴 **Hard Gate** | Mekanikal — dev PASTI bisa freeze wallet |
| Dev hold > 30% | 🟡 **Soft Warning** | Biarkan learning buktikan korelasinya |
| Creator hold > 30% | 🟡 **Soft Warning** | Biarkan learning buktikan korelasinya |
| Bot holders > 10% | 🟡 **Soft Warning** | Biarkan learning buktikan korelasinya |
| Fresh wallet, rat trader, dll | 🟡 **Soft Warning** | Biarkan learning buktikan korelasinya |

### P1.2 Holder Analysis Fix
Di `fetchJupiterHolders()`: Filter `organic` holders (exclude Pool/CEX/Burn) untuk kalkulasi `top20Percent`. Gunakan GMGN `stat.top_10_holder_rate` sebagai fallback.

### P1.3 Pattern Group `strategy_route`
Tambah group spec `['strategy_route', row => ...]` di `patterns.js`.

### P1.4 Lessons Governance & Rejection Logging
- Jangan biarkan lessons mengubah parameter secara otomatis saat dry-run (shadow mode).
- Log per-strategy rejects di `decision_logs` termasuk `strategy_id` dan alasan.
- Simpan entry-time `strategy_config` di `snapshot_json` saat posisi dibuat.

---

## P2 — Nice To Have
- Same-mint cache untuk ghost/position (P2.1)
- Faster ghost intervals (1m, 3m) (P2.2)
- Telegram Daily Digest (P2.3)

---

## Urutan Eksekusi (Oleh Codex)

1. **P0.1 - P0.3**: Strategy attribution, deduplication, capacity, and learning summary.
2. **P0.4**: Multi-stage TP accounting & config.
3. **P1.1 - P1.2**: Safety Gates (hard & soft) + Holder Analysis Fix.
4. **P1.3 - P1.4**: Pattern grouping, Rejection logging, Strategy Config snapshot.
5. **P2**: Nice to haves (cache, intervals, digest).
