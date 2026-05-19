import fs from 'fs';
import Database from 'better-sqlite3';
import { DB_PATH } from './src/config.js';

const db = new Database(DB_PATH);

// Baca file wallet tracker.md
let content = fs.readFileSync('wallet tracker.md', 'utf-8');

// Bersihkan instruksi teks di baris pertama jika ada
const jsonStart = content.indexOf('[');
const jsonEnd = content.lastIndexOf(']') + 1;

if (jsonStart === -1 || jsonEnd === 0) {
    console.error('Format JSON tidak ditemukan di dalam wallet tracker.md');
    process.exit(1);
}

const jsonString = content.substring(jsonStart, jsonEnd).replace(/\\/g, '');

try {
    const wallets = JSON.parse(jsonString);
    const insert = db.prepare('INSERT OR IGNORE INTO saved_wallets (label, address, created_at_ms) VALUES (?, ?, ?)');
    
    let count = 0;
    const now = Date.now();
    
    db.transaction(() => {
        for (const w of wallets) {
            if (w.trackedWalletAddress && w.name) {
                const label = `${w.emoji || ''} ${w.name}`.trim();
                const info = insert.run(label, w.trackedWalletAddress, now);
                if (info.changes > 0) count++;
            }
        }
    })();
    
    console.log(`✅ Berhasil meng-import ${count} wallet baru ke dalam database!`);
} catch (err) {
    console.error('Gagal parsing atau memasukkan data:', err.message);
}
