require("dotenv").config();
const express = require("express");
const cors = require("cors");
const compression = require("compression");
const cache = require("./cache");

const app = express();
app.use(compression());
app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json());

const ENV = process.env.QF_ENV || "prelive";
const AUTH_BASE = {
  prelive: "https://prelive-oauth2.quran.foundation",
  production: "https://oauth2.quran.foundation",
}[ENV];
const API_BASE = {
  prelive: "https://apis-prelive.quran.foundation",
  production: "https://apis.quran.foundation",
}[ENV];

if (!AUTH_BASE) throw new Error("QF_ENV harus 'prelive' atau 'production'");

// ============================ TOKEN ============================
// Token OAuth di-cache per scope sampai mendekati kedaluwarsa
// (expires_in - 60 detik). Hanya satu permintaan token berjalan per scope
// (de-duplikasi via inflightToken), jadi tidak ada banjir permintaan token.
const tokenCache = {}; // scope -> { token, expiresAt }
const inflightToken = {}; // scope -> Promise<string>

function buildBasicAuth() {
  return Buffer.from(
    `${process.env.QF_CLIENT_ID}:${process.env.QF_CLIENT_SECRET}`
  ).toString("base64");
}

async function getAccessToken(scope) {
  const key = scope || "default";
  const cached = tokenCache[key];
  // masih valid: sisa > 60 detik
  if (cached?.token && Date.now() < cached.expiresAt - 60_000) return cached.token;

  // sudah ada permintaan token berjalan untuk scope ini -> bagi promise yang sama
  if (inflightToken[key]) return inflightToken[key];

  inflightToken[key] = (async () => {
    const res = await fetch(`${AUTH_BASE}/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${buildBasicAuth()}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        // key "default" bukan scope; pakai QF_SCOPE / content.quran.read
        scope: key === "default" ? process.env.QF_SCOPE || "content.quran.read" : scope,
      }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(
        `Gagal ambil token (HTTP ${res.status}): ${body.error || ""} ${body.error_description || ""}`
      );
    }

    const data = await res.json();
    tokenCache[key] = {
      token: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    return data.access_token;
  })().finally(() => {
    delete inflightToken[key];
  });

  return inflightToken[key];
}

function clearToken(scope) {
  const key = scope || "default";
  delete tokenCache[key];
}

// ============================ UPSTREAM ============================
async function qfGet(path, scope) {
  const token = await getAccessToken(scope);
  return fetch(`${API_BASE}/content/api/v4${path}`, {
    headers: {
      "x-auth-token": token,
      "x-client-id": process.env.QF_CLIENT_ID,
    },
  });
}

// ambil JSON dari upstream; kalau 401 buang token cache scope & coba sekali lagi.
// Melempar error bila akhirnya gagal (dipakai cache.fetchCached untuk stale-if-error).
async function qfFetchJsonUpstream(path, scope, label) {
  let r = await qfGet(path, scope);
  if (r.status === 401) {
    clearToken(scope);
    r = await qfGet(path, scope);
  }
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(
      `Upstream ${label} HTTP ${r.status}: ${body.slice(0, 200)}`
    );
  }
  return r.json();
}

// helper lama: ambil JSON dari upstream lalu kirim langsung ke res
// (dipakai endpoint detail surat yang tidak dicache)
async function qfFetchJson(path, res, errorMessage, scope) {
  try {
    const data = await qfFetchJsonUpstream(path, scope, path);
    return res.json(data);
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ error: errorMessage });
  }
}

// ============================ HTTP UTIL ============================
// kirim JSON dengan Cache-Control + ETag; dukung 304 (If-None-Match)
function sendJson(res, body, { etag, notModified, status = 200, warn = false } = {}) {
  res.status(status);
  res.setHeader(
    "Cache-Control",
    "public, max-age=3600, stale-while-revalidate=86400"
  );
  if (etag) {
    res.setHeader("ETag", etag);
    if (notModified) {
      res.status(304);
      res.end();
      return;
    }
  }
  if (warn) {
    // tandai sumber stale bila upstream gagal
    res.setHeader("X-Cache-Source", warn);
  }
  res.json(body);
}

function logRequest(label, source, ms) {
  console.log(`${label} ${source} ${ms}ms`);
}

// ============================ ENDPOINTS ============================
app.get("/api/health", (req, res) => res.json({ ok: true }));

// daftar semua surat (hanya field yang dipakai frontend)
app.get("/api/surah", async (req, res) => {
  const t0 = Date.now();
  const key = "surah";
  try {
    const { value, source } = await cache.fetchCached(
      key,
      cache.TTL.surah,
      () =>
        qfFetchJsonUpstream("/chapters?language=id", "default", "surat"),
      "surah"
    );
    // kecilkan payload: field yang dipakai frontend saja, nama tetap
    const chapters = (value.chapters || []).map((c) => ({
      id: c.id,
      name_simple: c.name_simple,
      name_arabic: c.name_arabic,
      verses_count: c.verses_count,
      revelation_place: c.revelation_place,
      bismillah_pre: c.bismillah_pre,
      translated_name: { name: c.translated_name?.name },
    }));
    const etag = cache.computeEtag({ chapters });
    sendJson(res, { chapters }, {
      etag,
      notModified: req.headers["if-none-match"] === etag,
      warn: source === "stale" ? "stale" : undefined,
    });
    logRequest("GET /api/surah", source, Date.now() - t0);
  } catch (err) {
    console.error("GET /api/surah gagal:", err.message);
    res.status(500).json({ error: "Gagal ambil data surat" });
  }
});

// detail satu surat
app.get("/api/surah/:id", (req, res) =>
  qfFetchJson(
    `/chapters/${encodeURIComponent(req.params.id)}?language=id`,
    res,
    "Gagal ambil surat"
  )
);

// ayat per surat (teks Arab + terjemahan Indonesia + kata per ayat)
app.get("/api/surah/:id/ayat", async (req, res) => {
  const t0 = Date.now();
  const id = req.params.id;
  const key = `verses:${id}`;
  const upstreamPath =
    `/verses/by_chapter/${encodeURIComponent(id)}` +
    `?language=id&words=true&word_fields=text_uthmani&fields=text_uthmani&translations=33&per_page=300`;
  try {
    const { value, source } = await cache.fetchCached(
      key,
      cache.TTL.verses,
      async () => {
        const data = await qfFetchJsonUpstream(upstreamPath, "default", "ayat");
        // petakan words -> { position, text, type } (sebelum disimpan ke cache)
        if (data.verses) {
          for (const v of data.verses) {
            if (Array.isArray(v.words)) {
              v.words = v.words.map((w) => ({
                position: w.position,
                text: w.text_uthmani ?? w.text ?? "",
                type: w.char_type_name ?? "word",
              }));
            }
          }
        }
        return data;
      },
      `ayat ${id}`
    );
    const etag = cache.computeEtag(value);
    sendJson(res, value, {
      etag,
      notModified: req.headers["if-none-match"] === etag,
      warn: source === "stale" ? "stale" : undefined,
    });
    logRequest(`GET /api/surah/${id}/ayat`, source, Date.now() - t0);
  } catch (err) {
    console.error(`GET /api/surah/${id}/ayat gagal:`, err.message);
    res.status(500).json({ error: "Gagal ambil ayat" });
  }
});

// daftar qari (reciter) — scope audio
app.get("/api/reciters", async (req, res) => {
  const t0 = Date.now();
  const key = "reciters";
  try {
    const { value, source } = await cache.fetchCached(
      key,
      cache.TTL.reciters,
      () =>
        qfFetchJsonUpstream(
          "/resources/chapter_reciters",
          "content.audio.read",
          "daftar qari"
        ),
      "reciters"
    );
    const etag = cache.computeEtag(value);
    sendJson(res, value, {
      etag,
      notModified: req.headers["if-none-match"] === etag,
      warn: source === "stale" ? "stale" : undefined,
    });
    logRequest("GET /api/reciters", source, Date.now() - t0);
  } catch (err) {
    console.error("GET /api/reciters gagal:", err.message);
    res.status(500).json({ error: "Gagal ambil daftar qari" });
  }
});

// rekaman bacaan satu surat (audio + timestamps per ayat) — scope audio
app.get("/api/audio/chapter/:reciterId/:chapterId", async (req, res) => {
  const { reciterId, chapterId } = req.params;
  // validasi angka, hindari path tidak valid ke API upstream
  if (!/^\d+$/.test(reciterId) || !/^\d+$/.test(chapterId)) {
    return res.status(400).json({ error: "ID tidak valid" });
  }
  const t0 = Date.now();
  const key = `audio:${reciterId}:${chapterId}`;
  try {
    const { value, source } = await cache.fetchCached(
      key,
      cache.TTL.audio,
      () =>
        qfFetchJsonUpstream(
          `/chapter_recitations/${reciterId}/${chapterId}?segments=true`,
          "content.audio.read",
          "audio"
        ),
      `${key}`
    );
    const etag = cache.computeEtag(value);
    sendJson(res, value, {
      etag,
      notModified: req.headers["if-none-match"] === etag,
      warn: source === "stale" ? "stale" : undefined,
    });
    logRequest(`GET /api/audio/chapter/${reciterId}/${chapterId}`, source, Date.now() - t0);
  } catch (err) {
    console.error(`GET /api/audio/chapter/${reciterId}/${chapterId} gagal:`, err.message);
    res.status(500).json({ error: "Gagal ambil audio surat" });
  }
});

// ============================ STARTUP ============================
// muat cache disk ke memori, lalu pemanasan latar belakang (non-blocking)
cache.loadFromDisk();
app.listen(process.env.PORT || 3000, () => {
  const port = process.env.PORT || 3000;
  console.log(`Server jalan di http://localhost:${port}`);
  // pemanasan: surat + qari di latar belakang
  const warm = async (key, ttl, fn, label) => {
    try {
      const { source } = await cache.fetchCached(key, ttl, fn, label);
      logRequest(`warmup ${label}`, source, 0);
    } catch (e) {
      console.error(`warmup ${label} gagal:`, e.message);
    }
  };
  warm("surah", cache.TTL.surah, () =>
    qfFetchJsonUpstream("/chapters?language=id", "default", "surat"), "surah");
  warm("reciters", cache.TTL.reciters, () =>
    qfFetchJsonUpstream("/resources/chapter_reciters", "content.audio.read", "daftar qari"), "reciters");
});
