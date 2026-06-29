/**
 * Vercel Serverless Function — Proxy FNE DGI Côte d'Ivoire
 * Route : POST /api/fne
 */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { apiKey, apiUrl, action, payload } = req.body || {};
  if (!apiKey || !apiUrl || !payload)
    return res.status(400).json({ error: "apiKey, apiUrl et payload requis" });

  const endpoints = {
    sign:   "/external/invoices/sign",
    refund: "/external/invoices/refund",
    status: "/external/invoices/status",
  };
  const endpoint = endpoints[action || "sign"];
  if (!endpoint) return res.status(400).json({ error: "Action inconnue : " + action });

  try {
    const response = await fetch(apiUrl.replace(/\/$/, "") + endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return res.status(response.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message || "Erreur connexion DGI" });
  }
}
