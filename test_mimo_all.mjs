// Benchmark semua model MiMo untuk Charon compatibility
const UPSTREAM = 'https://opengateway.gitlawb.com/v1/xiaomi-mimo';

const MODELS = ['mimo-v2.5-pro', 'mimo-v2.5', 'mimo-v2-pro', 'mimo-v2-flash'];

const system = [
  'You are Charon, a Solana meme coin trench analyst.',
  'Return strict JSON only.',
  'You will receive up to 10 recently matched candidates.',
  'Pick at most one candidate to buy through the configured execution mode.',
  'Use verdict BUY only for the single best unusually strong asymmetric opportunity.',
  'Use WATCH if candidates are interesting but none deserves a buy.',
  'Use PASS if the set is weak or unsafe.',
  'Chart data is ATH/range context. Do not penalize or reward a token only because 24h change is huge; new Pump tokens often do that.',
  'Use distance from ATH/range high and top-blast risk to decide whether entry is late.',
  'Confidence is your conviction from 0 to 100, not probability.',
].join(' ');

const user = {
  task: 'Pick the best dry-run buy candidate from this recent batch, or choose none.',
  recent_lessons: [
    'Tokens with max holder >15% and mcap >100K tend to rug within 24h.',
    'Route fee_graduated_trending has 75% win rate historically.',
  ],
  output_schema: {
    verdict: 'BUY|WATCH|PASS',
    selected_candidate_id: 'integer candidate_id when verdict is BUY, otherwise null',
    selected_mint: 'mint string when verdict is BUY, otherwise null',
    confidence: 'number 0-100',
    reason: 'short string',
    risks: ['short strings'],
    suggested_tp_percent: 'positive number',
    suggested_sl_percent: 'negative number',
  },
  trigger_candidate_id: 1,
  candidates: [
    {
      candidate_id: 1, mint: 'CATGOLD111111111111111111111111111111111112',
      route: 'fee_graduated_trending',
      signals: { route: 'fee_graduated_trending', sourceCount: 3, feeClaim: true, graduated: true, trending: true },
      token: { mint: 'CATGOLD111111111111111111111111111111111112', name: 'CATGOLD', symbol: 'CATGOLD', decimals: 9 },
      metrics: { priceUsd: 0.00032, mcapUsd: 42000, liquidityUsd: 18500, volume24hUsd: 156000 },
      feeClaim: { feeAmountSol: 0.85, totalFees: 3.2 },
      trending: { rank: 12, volume: 156000, swaps: 842 },
      holders: { topHolderPercent: 8.2, top20HolderPercent: 22.5, holderCount: 1250, maxHolderPercent: 4.1 },
      chart: { distanceFromAthPercent: -33, topBlastRisk: false },
      twitterNarrative: { text: 'CATGOLD just graduated! Community-driven cat meme.' },
      filters: { passed: true, failures: [] },
    },
    {
      candidate_id: 2, mint: 'RUGGABLE11111111111111111111111111111111113',
      route: 'fee_graduated',
      signals: { route: 'fee_graduated', sourceCount: 2, feeClaim: true, graduated: true, trending: false },
      token: { mint: 'RUGGABLE11111111111111111111111111111111113', name: 'RUGGABLE', symbol: 'RUG', decimals: 6 },
      metrics: { priceUsd: 0.0012, mcapUsd: 180000, liquidityUsd: 5200, volume24hUsd: 42000 },
      holders: { topHolderPercent: 22.5, top20HolderPercent: 55.0, holderCount: 180, maxHolderPercent: 18.3 },
      chart: { distanceFromAthPercent: -8, topBlastRisk: true },
      filters: { passed: true, failures: [] },
    },
  ],
};

const results = [];

for (const model of MODELS) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🧪 Testing: ${model}`);
  console.log('='.repeat(60));

  const start = Date.now();
  try {
    const res = await fetch(`${UPSTREAM}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'identity' },
      body: JSON.stringify({
        model, temperature: 0.2,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: JSON.stringify(user) },
        ],
      }),
    });

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    if (!res.ok) {
      const text = await res.text();
      console.log(`❌ Status ${res.status}: ${text.slice(0, 200)}`);
      results.push({ model, status: 'ERROR', elapsed, error: `${res.status}` });
      continue;
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || '';
    const reasoning = data?.choices?.[0]?.message?.reasoning_content || '';
    const usage = data?.usage || {};

    // Parse JSON
    let parsed;
    try { parsed = JSON.parse(content); } catch {
      const m = content.match(/\{[\s\S]*\}/);
      if (m) try { parsed = JSON.parse(m[0]); } catch {}
    }

    if (!parsed) {
      console.log(`❌ Failed to parse JSON`);
      console.log(`   Raw: ${content.slice(0, 300)}`);
      results.push({ model, status: 'JSON_FAIL', elapsed, raw: content.slice(0, 100) });
      continue;
    }

    // Validate fields
    const checks = {
      verdict: ['BUY', 'WATCH', 'PASS'].includes(parsed.verdict),
      confidence: typeof parsed.confidence === 'number' && parsed.confidence >= 0 && parsed.confidence <= 100,
      reason: typeof parsed.reason === 'string' && parsed.reason.length > 0,
      risks: Array.isArray(parsed.risks),
      tp: typeof parsed.suggested_tp_percent === 'number',
      sl: typeof parsed.suggested_sl_percent === 'number',
      candidate_id: parsed.selected_candidate_id === null || typeof parsed.selected_candidate_id === 'number',
      mint: parsed.selected_mint === null || typeof parsed.selected_mint === 'string',
    };
    const passCount = Object.values(checks).filter(Boolean).length;
    const allPass = passCount === 8;

    // Quality assessment
    const correctVerdict = parsed.verdict === 'BUY' && parsed.selected_candidate_id === 1;
    const rejectRug = parsed.selected_candidate_id !== 2;
    const usedLessons = (parsed.reason || '').toLowerCase().includes('holder') || 
                        (parsed.reason || '').toLowerCase().includes('route') ||
                        (parsed.reason || '').toLowerCase().includes('fee_graduated');

    console.log(`⏱️  Time: ${elapsed}s`);
    console.log(`📝 Verdict: ${parsed.verdict} (conf: ${parsed.confidence})`);
    console.log(`   Selected: #${parsed.selected_candidate_id} ${parsed.selected_mint || 'none'}`);
    console.log(`   Reason: ${(parsed.reason || '').slice(0, 120)}`);
    console.log(`   TP/SL: +${parsed.suggested_tp_percent}% / ${parsed.suggested_sl_percent}%`);
    console.log(`   Risks: ${JSON.stringify(parsed.risks)}`);
    console.log(`   Reasoning: ${reasoning ? reasoning.length + ' chars' : 'none'}`);
    console.log(`   Tokens: ${usage.total_tokens || '?'}`);
    console.log(`🔍 Fields: ${passCount}/8 ${allPass ? '✅' : '⚠️'}`);
    console.log(`🎯 Quality: correct=${correctVerdict} reject_rug=${rejectRug} used_lessons=${usedLessons}`);

    results.push({
      model,
      status: allPass ? 'PASS' : 'PARTIAL',
      elapsed: parseFloat(elapsed),
      verdict: parsed.verdict,
      confidence: parsed.confidence,
      candidate: parsed.selected_candidate_id,
      tp: parsed.suggested_tp_percent,
      sl: parsed.suggested_sl_percent,
      fields: `${passCount}/8`,
      correctVerdict,
      rejectRug,
      usedLessons,
      reasoningLen: reasoning?.length || 0,
      tokens: usage.total_tokens || 0,
      reason: (parsed.reason || '').slice(0, 80),
    });

  } catch (err) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`❌ Error: ${err.message}`);
    results.push({ model, status: 'FETCH_ERROR', elapsed, error: err.message });
  }
}

// Summary table
console.log(`\n\n${'='.repeat(70)}`);
console.log('📊 COMPARISON SUMMARY');
console.log('='.repeat(70));
console.log('');
console.log('Model              | Time   | Verdict | Conf | TP/SL     | Fields | Correct | Tokens');
console.log('-------------------|--------|---------|------|-----------|--------|---------|-------');
for (const r of results) {
  if (r.status === 'ERROR' || r.status === 'FETCH_ERROR') {
    console.log(`${r.model.padEnd(18)} | ${String(r.elapsed).padEnd(6)} | ERROR   |      |           |        |         | ${r.error || ''}`);
  } else if (r.status === 'JSON_FAIL') {
    console.log(`${r.model.padEnd(18)} | ${String(r.elapsed).padEnd(6)} | JSON❌  |      |           |        |         |`);
  } else {
    const tp_sl = `+${r.tp}/${r.sl}`;
    const correct = r.correctVerdict && r.rejectRug && r.usedLessons ? '✅✅✅' : 
                    r.correctVerdict && r.rejectRug ? '✅✅' : '⚠️';
    console.log(`${r.model.padEnd(18)} | ${String(r.elapsed + 's').padEnd(6)} | ${r.verdict.padEnd(7)} | ${String(r.confidence).padEnd(4)} | ${tp_sl.padEnd(9)} | ${r.fields.padEnd(6)} | ${correct.padEnd(7)} | ${r.tokens}`);
  }
}
console.log('');
console.log('Correct = picked CATGOLD(#1), rejected RUGGABLE(#2), referenced lessons');
