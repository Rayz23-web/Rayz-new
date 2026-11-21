import { refreshAll } from "./api.mjs";

// Her 5 dakikada: abonelik Google dosyalarını yeniler (kalan gün, gerçek trafik GB, server değişimi)
export const config = { schedule: "*/5 * * * *" };

export default async () => {
  try { await refreshAll(20); } catch (e) { console.log("gsched:", String((e && e.message) || e)); }
  return new Response("ok");
};
