const B = "http://localhost:3000";
const { chapters } = await (await fetch(`${B}/api/surah`)).json();
let total = 0;
const salah = [];
for (const c of chapters) {
  const d = await (await fetch(`${B}/api/surah/${c.id}/ayat`)).json();
  const n = d.verses?.length || 0;
  total += n;
  if (n !== c.verses_count) salah.push(`${c.id} ${c.name_simple}: ${n} dari ${c.verses_count}`);
}
console.log("jumlah surat:", chapters.length);
console.log("total ayat:", total);
console.log(salah.length ? salah : "semua jumlah ayat per surat cocok");
