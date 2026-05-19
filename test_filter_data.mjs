import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const GMGN_API_KEY = process.env.GMGN_API_KEY;

// Mix of established tokens AND fresh/risky meme coins for comparison
const TOKENS = [
  { label: 'POPCAT (established)', mint: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr' },
  { label: 'BONK (established)', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
];

const JSON_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
};

async function inspect(label, mint) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`${label}`);
  console.log('='.repeat(70));

  // --- Jupiter audit ---
  let audit = null;
  try {
    const url = new URL('https://datapi.jup.ag/v1/assets/search');
    url.searchParams.set('query', mint);
    const res = await axios.get(url.toString(), { timeout: 10000, headers: JSON_HEADERS });
    const rows = Array.isArray(res.data) ? res.data : [];
    const asset = rows.find(r => r?.id === mint) || rows[0];
    audit = asset?.audit || null;
    console.log(`\n--- JUPITER AUDIT ---`);
    console.log(JSON.stringify(audit, null, 2));
  } catch (err) {
    console.log(`[Jupiter] Error: ${err.message}`);
  }

  // --- GMGN stat + dev ---
  try {
    const ts = Math.floor(Date.now() / 1000);
    const url = `https://openapi.gmgn.ai/v1/token/info?chain=sol&address=${mint}&timestamp=${ts}&client_id=test-${ts}`;
    const res = await axios.get(url, {
      timeout: 10000,
      headers: { ...JSON_HEADERS, 'X-APIKEY': GMGN_API_KEY }
    });
    const data = res.data?.data?.data || res.data?.data || res.data;

    console.log(`\n--- GMGN STAT (all fields) ---`);
    if (data?.stat) {
      for (const [k, v] of Object.entries(data.stat)) {
        console.log(`  ${k.padEnd(40)}: ${v}`);
      }
    }

    console.log(`\n--- GMGN DEV (key fields) ---`);
    if (data?.dev) {
      console.log(`  creator_address                       : ${data.dev.creator_address}`);
      console.log(`  creator_token_status                  : ${data.dev.creator_token_status}`);
      console.log(`  cto_flag                              : ${data.dev.cto_flag}`);
      console.log(`  top_10_holder_rate (dev)               : ${data.dev.top_10_holder_rate}`);
      console.log(`  creator_open_count                    : ${data.dev.creator_open_count}`);
    }
  } catch (err) {
    console.log(`[GMGN] Error: ${err.response?.status} ${err.message}`);
  }
}

async function run() {
  for (const t of TOKENS) {
    await inspect(t.label, t.mint);
  }
}
run();
