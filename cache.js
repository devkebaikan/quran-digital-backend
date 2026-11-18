// Cache kecil di memori + disk untuk data Quran Foundation.
// - TTL per tipe data (konstanta di bawah).
// - De-duplikasi: request yang sama & bersamaan berbagi satu promise fetch.
// - Stale-if-error: jika fetch upstream gagal, kirim cache lama (meski expired).
// - Persist ke ./cache (file JSON per kunci) agar survive restart.
const fs = require("fs");
const path = require("path");

// TTL: jangan lebih dari 24 jam tanpa mengecek Developer Terms Quran Foundation dulu.
const TTL = {
  surah: 24 * 3600 * 1000,
  reciters: 24 * 3600 * 1000,
  verses: 24 * 3600 * 1000,
  audio: 24 * 3600 * 1000,
};

const CACHE_DIR = path.join(__dirname, "cache");

// nilai: { key, value, savedAt, ttl }
const mem = new Map();
// in-flight promise per kunci (de-duplikasi)
const inflight = new Map();

function ensureDir() {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  } catch (e) {
    console.error("cache: gagal buat folder", e.message);
  }
}

// kunci jadi nama file aman
function safeFile(key) {
  return key.replace(/[^a-z0-9]+/gi, "_") + ".json";
}

// muat semua cache disk ke memori saat server mulai (TTL dihormati saat akses)
function loadFromDisk() {
  ensureDir();
  try {
    const files = fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(CACHE_DIR, f), "utf8");
        const entry = JSON.parse(raw);
        if (entry && entry.value !== undefined) {
          mem.set(entry.key, entry);
        }
      } catch {
        // file rusak: lewati
      }
    }
  } catch (e) {
    console.error("cache: gagal baca folder", e.message);
  }
}

function saveToDisk(key) {
  const entry = mem.get(key);
  if (!entry) return;
  ensureDir();
  try {
    fs.writeFileSync(path.join(CACHE_DIR, safeFile(key)), JSON.stringify(entry, "utf8"));
  } catch (e) {
    console.error("cache: gagal tulis disk", e.message);
  }
}

// entry masih valid (belum expired)
function getValid(key) {
  const e = mem.get(key);
  if (!e) return null;
  if (Date.now() - e.savedAt >= e.ttl) return null;
  return e;
}

// entry apa pun (termasuk expired) untuk stale-if-error
function getStale(key) {
  return mem.get(key) || null;
}

// etag stabil dari nilai (tanpa savedAt)
function computeEtag(value) {
  const str = JSON.stringify(value);
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return `W/"${(h >>> 0).toString(16)}"`;
}

// fetch nilai via fn, de-duplikasi + persist + stale-if-error.
// Return { value, source: "cache" | "upstream" | "stale" }.
async function fetchCached(key, ttl, fetchFn, label) {
  const valid = getValid(key);
  if (valid) return { value: valid.value, source: "cache" };

  // sudah ada fetch berjalan untuk kunci yang sama -> bagi promise yang sama
  let p = inflight.get(key);
  let isLeader = false;
  if (!p) {
    isLeader = true;
    p = (async () => {
      try {
        const value = await fetchFn();
        mem.set(key, { key, value, savedAt: Date.now(), ttl });
        saveToDisk(key);
        return value;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
  }

  try {
    const value = await p;
    // leader = yang benar-benar memanggil upstream; follower = berbagi promise
    return { value, source: isLeader ? "upstream" : "cache" };
  } catch (err) {
    const stale = getStale(key);
    if (stale) {
      console.error(`cache: ${label} upstream gagal (${err.message}), kirim stale`);
      return { value: stale.value, source: "stale" };
    }
    throw err;
  }
}

module.exports = {
  TTL,
  loadFromDisk,
  getValid,
  getStale,
  computeEtag,
  fetchCached,
  CACHE_DIR,
};
