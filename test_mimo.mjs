// Test: Simulasi Charon LLM call ke Xiaomi MiMo via GitLawb gateway
// Ini persis seperti yang decideCandidateBatch() kirim

const UPSTREAM = 'https://opengateway.gitlawb.com/v1/xiaomi-mimo';
const MODEL = 'mimo-v2.5-pro';

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

// Sample candidate data (realistic Charon format)
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
      candidate_id: 1,
      mint: 'So11111111111111111111111111111111111111112',
      route: 'fee_graduated_trending',
      signals: {
        route: 'fee_graduated_trending',
        sourceCount: 3,
        feeClaim: true,
        graduated: true,
        trending: true,
      },
      token: {
        mint: 'So11111111111111111111111111111111111111112',
        name: 'CATGOLD',
        symbol: 'CATGOLD',
        decimals: 9,
      },
      metrics: {
        priceUsd: 0.00032,
        mcapUsd: 42000,
        liquidityUsd: 18500,
        volume24hUsd: 156000,
        priceChange5m: 12.5,
        priceChange1h: 45.2,
      },
      feeClaim: { feeAmountSol: 0.85, totalFees: 3.2, claimedAt: Date.now() - 120000 },
      trending: { rank: 12, volume: 156000, swaps: 842 },
      graduation: { graduatedAt: Date.now() - 3600000 },
      holders: {
        topHolderPercent: 8.2,
        top20HolderPercent: 22.5,
        holderCount: 1250,
        maxHolderPercent: 4.1,
      },
      chart: {
        currentNative: 0.00032,
        rangeHighNative: 0.00048,
        distanceFromAthPercent: -33,
        topBlastRisk: false,
      },
      twitterNarrative: { text: 'CATGOLD just graduated from pump.fun! Community-driven cat meme token.' },
      filters: { passed: true, failures: [] },
    },
    {
      candidate_id: 2,
      mint: 'ABC111111111111111111111111111111111111113',
      route: 'fee_graduated',
      signals: { route: 'fee_graduated', sourceCount: 2, feeClaim: true, graduated: true, trending: false },
      token: { mint: 'ABC111111111111111111111111111111111111113', name: 'RUGGABLE', symbol: 'RUG', decimals: 6 },
      metrics: { priceUsd: 0.0012, mcapUsd: 180000, liquidityUsd: 5200, volume24hUsd: 42000 },
      feeClaim: { feeAmountSol: 0.15, totalFees: 0.4 },
      holders: { topHolderPercent: 22.5, top20HolderPercent: 55.0, holderCount: 180, maxHolderPercent: 18.3 },
      chart: { currentNative: 0.0012, rangeHighNative: 0.0013, distanceFromAthPercent: -8, topBlastRisk: true },
      filters: { passed: true, failures: [] },
    },
  ],
};

console.log('🧪 Testing MiMo with Charon candidate screening task...');
console.log(`   Model: ${MODEL}`);
console.log(`   Gateway: ${UPSTREAM}`);
console.log(`   Candidates: ${user.candidates.length}`);
console.log('');

const startTime = Date.now();

try {
  const res = await fetch(`${UPSTREAM}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'identity' },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(user) },
      ],
    }),
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`⏱️  Response time: ${elapsed}s`);
  console.log(`📡 Status: ${res.status}`);
  console.log('');

  if (!res.ok) {
    const text = await res.text();
    console.log('❌ ERROR:', text.slice(0, 500));
    process.exit(1);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || '';
  const reasoning = data?.choices?.[0]?.message?.reasoning_content || '';

  if (reasoning) {
    console.log('🧠 REASONING (MiMo thinking):');
    console.log(reasoning.slice(0, 1000));
    console.log('---');
  }

  console.log('📝 RAW RESPONSE:');
  console.log(content);
  console.log('');

  // Try parse as JSON (like Charon would)
  let parsed;
  try {
    // Try direct parse
    parsed = JSON.parse(content);
  } catch {
    // Try extract JSON from text (like strictJsonFromText)
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      try { parsed = JSON.parse(match[0]); } catch {}
    }
  }

  if (parsed) {
    console.log('✅ PARSED JSON:');
    console.log(JSON.stringify(parsed, null, 2));
    console.log('');

    // Validate Charon compatibility
    const checks = [
      ['verdict', ['BUY', 'WATCH', 'PASS'].includes(parsed.verdict)],
      ['confidence', typeof parsed.confidence === 'number' && parsed.confidence >= 0 && parsed.confidence <= 100],
      ['reason', typeof parsed.reason === 'string' && parsed.reason.length > 0],
      ['risks', Array.isArray(parsed.risks)],
      ['suggested_tp_percent', typeof parsed.suggested_tp_percent === 'number'],
      ['suggested_sl_percent', typeof parsed.suggested_sl_percent === 'number'],
      ['selected_candidate_id', parsed.selected_candidate_id === null || typeof parsed.selected_candidate_id === 'number'],
      ['selected_mint', parsed.selected_mint === null || typeof parsed.selected_mint === 'string'],
    ];

    console.log('🔍 CHARON COMPATIBILITY CHECK:');
    let allPass = true;
    for (const [field, ok] of checks) {
      console.log(`   ${ok ? '✅' : '❌'} ${field}: ${JSON.stringify(parsed[field])}`);
      if (!ok) allPass = false;
    }
    console.log('');
    console.log(allPass ? '🎉 RESULT: FULLY COMPATIBLE with Charon!' : '⚠️ RESULT: Some fields need fixing');
  } else {
    console.log('❌ FAILED: Could not parse JSON from response');
  }

  // Usage info
  if (data.usage) {
    console.log(`\n📊 Token usage: prompt=${data.usage.prompt_tokens}, completion=${data.usage.completion_tokens}, total=${data.usage.total_tokens}`);
  }

} catch (err) {
  console.log('❌ FETCH ERROR:', err.message);
}
