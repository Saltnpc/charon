// Quick test: see what tags Jupiter returns for holders
import axios from 'axios';

// Test with a few known tokens - mix of popular and pump tokens
const TOKENS = [
  { label: 'POPCAT', mint: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr' },
  { label: 'WIF', mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm' },
  { label: 'BONK', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
];

async function checkHolders(label, mint) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${label} (${mint.slice(0,8)}...)`);
  console.log('='.repeat(60));
  
  try {
    const res = await axios.get(`https://datapi.jup.ag/v1/holders/${mint}`, {
      timeout: 15000,
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      },
    });
    
    const holders = Array.isArray(res.data?.holders) ? res.data.holders : [];
    console.log(`Total holders returned: ${holders.length}`);
    
    // Show top 10 with full tag details
    const top10 = holders.slice(0, 10);
    const allTags = new Set();
    
    const total = holders.reduce((sum, h) => sum + Number(h.amount || 0), 0);
    
    console.log(`\nTop 10 holders:`);
    for (const [i, h] of top10.entries()) {
      const pct = total > 0 ? (Number(h.amount || 0) / total * 100).toFixed(2) : '?';
      const rawTags = h.tags || [];
      const tagNames = rawTags.map(t => t.name || t.id || JSON.stringify(t));
      tagNames.forEach(t => allTags.add(t));
      
      console.log(`  #${i+1}: ${h.address?.slice(0,12)}... | ${pct}% | tags: ${rawTags.length ? JSON.stringify(rawTags) : '(none)'}`);
    }
    
    // Collect ALL unique tags across ALL holders
    for (const h of holders) {
      (h.tags || []).forEach(t => allTags.add(t.name || t.id || JSON.stringify(t)));
    }
    
    console.log(`\nAll unique tag names found: ${allTags.size ? [...allTags].join(', ') : '(none)'}`);
    
    // Count how many holders have tags
    const taggedCount = holders.filter(h => h.tags?.length > 0).length;
    console.log(`Holders with tags: ${taggedCount}/${holders.length}`);
    
  } catch (err) {
    console.log(`Error: ${err.response?.status || ''} ${err.message}`);
  }
}

for (const t of TOKENS) {
  await checkHolders(t.label, t.mint);
}
