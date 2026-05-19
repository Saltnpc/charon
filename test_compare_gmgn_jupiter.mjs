import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const GMGN_API_KEY = process.env.GMGN_API_KEY;

const TOKENS = [
  { label: 'POPCAT', mint: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr' },
  { label: 'WIF', mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm' },
  { label: 'BONK', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
];

const JSON_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
};

async function checkCompare(label, mint) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${label} (${mint.slice(0, 8)}...)`);
  console.log('='.repeat(60));

  let jupHolders = [];
  try {
    const res = await axios.get(`https://datapi.jup.ag/v1/holders/${mint}`, {
      timeout: 10000,
      headers: JSON_HEADERS,
    });
    jupHolders = Array.isArray(res.data?.holders) ? res.data.holders : [];
  } catch (err) {
    console.log(`[Jupiter] Error: ${err.message}`);
  }

  let gmgnInfo = null;
  try {
    const timestamp = Math.floor(Date.now() / 1000);
    const client_id = 'test-client-' + timestamp;
    const url = `https://openapi.gmgn.ai/v1/token/info?chain=sol&address=${mint}&timestamp=${timestamp}&client_id=${client_id}`;
    const res = await axios.get(url, {
      timeout: 10000,
      headers: {
        ...JSON_HEADERS,
        'X-APIKEY': GMGN_API_KEY
      }
    });
    gmgnInfo = res.data?.data?.data || res.data?.data || res.data;
  } catch (err) {
    console.log(`[GMGN] Error: ${err.response?.status} ${err.message}`);
  }

  // --- Jupiter Calculation ---
  const jupTotal = jupHolders.reduce((sum, h) => sum + Number(h.amount || 0), 0);
  
  // 1. Raw Calculation (All holders)
  const jupTop10Raw = jupHolders.slice(0, 10);
  const jupTop10RawPct = jupTop10Raw.reduce((sum, h) => sum + (Number(h.amount) / jupTotal * 100), 0);
  const jupMaxHolderRaw = jupTop10Raw.length ? (Number(jupTop10Raw[0].amount) / jupTotal * 100) : 0;
  
  // 2. Filtered Calculation (Exclude pool, cex, burn)
  const organicHolders = jupHolders.filter(h => {
    const tagsStr = (h.tags || []).map(t => (t.name || t.id || '').toLowerCase()).join(' ');
    return !tagsStr.includes('pool') && !tagsStr.includes('cex') && !tagsStr.includes('burn');
  });
  const jupTop10Organic = organicHolders.slice(0, 10);
  const jupTop10OrganicPct = jupTop10Organic.reduce((sum, h) => sum + (Number(h.amount) / jupTotal * 100), 0);
  const jupMaxHolderOrganic = jupTop10Organic.length ? (Number(jupTop10Organic[0].amount) / jupTotal * 100) : 0;
  
  // --- GMGN Data ---
  const gmgnTop10Pct = (Number(gmgnInfo?.top_10_holder_rate || 0) * 100);
  
  console.log(`\n--- HOLDER CONCENTRATION COMPARISON ---`);
  console.log(`Jupiter (Raw)       : Top 10 = ${jupTop10RawPct.toFixed(2)}% | Max Holder = ${jupMaxHolderRaw.toFixed(2)}%`);
  console.log(`Jupiter (Filtered)  : Top 10 = ${jupTop10OrganicPct.toFixed(2)}% | Max Holder = ${jupMaxHolderOrganic.toFixed(2)}%`);
  console.log(`GMGN (API Response) : Top 10 = ${gmgnTop10Pct.toFixed(2)}%`);
  
  console.log(`\n--- GMGN RAW PAYLOAD ---`);
  if (gmgnInfo) {
    console.log(`renounced_mint (dev)    :`, gmgnInfo.dev?.renounced_mint);
    console.log(`renounced_freeze (dev)  :`, gmgnInfo.dev?.renounced_freeze_account);
    console.log(`top_10_holder_rate (stat):`, gmgnInfo.stat?.top_10_holder_rate);
    console.log(`is_show_alert (stat)    :`, gmgnInfo.stat?.is_show_alert);
    console.log(`\nKeys in dev:`, Object.keys(gmgnInfo.dev || {}));
    console.log(`Keys in stat:`, Object.keys(gmgnInfo.stat || {}));
  } else {
    console.log(`No payload`);
  }
}

async function run() {
  for (const t of TOKENS) {
    await checkCompare(t.label, t.mint);
  }
}
run();
