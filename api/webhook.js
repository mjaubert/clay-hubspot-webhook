export const maxDuration = 30; // Vercel Pro: 30s max au lieu de 10s par défaut

const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const HUBSPOT_ACCOUNT_ID = process.env.HUBSPOT_ACCOUNT_ID;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function hubspotFetch(url, method = "GET", body = null, retries = 5) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const opts = {
      method,
      headers: {
        Authorization: `Bearer ${HUBSPOT_TOKEN}`,
        "Content-Type": "application/json"
      }
    };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(url, opts);
    const status = res.status;

    if (status === 429) {
      const wait = parseInt(res.headers.get("Retry-After") || "10") * 1000;
      console.log(`429 rate limit — attempt ${attempt}/${retries}, waiting ${wait}ms`);
      await sleep(wait);
      continue;
    }

    return res;
  }
  throw new Error("Rate limit dépassé après plusieurs tentatives");
}

// Recherche via v1 /lists/search — 1 seul appel, pas de pagination
async function findListByName(list_name) {
  const encoded = encodeURIComponent(list_name.trim());
  const res = await hubspotFetch(
    `https://api.hubapi.com/contacts/v1/lists/search?query=${encoded}&count=20&offset=0`
  );
  const text = await res.text();
  console.log(`findListByName — status: ${res.status} body: ${text.substring(0, 400)}`);

  if (!res.ok) return null;

  let data;
  try { data = JSON.parse(text); } catch { return null; }

  const match = data.lists?.find(l => l.name?.trim() === list_name.trim());
  if (match) {
    console.log("findListByName — found:", match.listId, match.name);
    return match.listId;
  }
  console.log("findListByName — not found for:", list_name);
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const { contact_id, import_code, list_name } = req.body;
  if (!contact_id || !import_code || !list_name) {
    return res.status(400).json({ error: "Champs manquants: contact_id, import_code, list_name" });
  }

  console.log("START — contact_id:", contact_id, "list_name:", list_name, "token_length:", HUBSPOT_TOKEN?.length);

  try {
    await sleep(Math.random() * 500);

    // ── 1. Cherche la liste par nom ───────────────────────────────────────────
    let listId = await findListByName(list_name);
    let listJustCreated = false;
    console.log("Step 1 — listId:", listId);

    // ── 2. Crée la liste si elle n'existe pas ────────────────────────────────
    if (!listId) {
      const createRes = await hubspotFetch(
        "https://api.hubapi.com/contacts/v1/lists",
        "POST",
        { name: list_name, dynamic: false }
      );
      const rawCreate = await createRes.text();
      let created = {};
      try { created = JSON.parse(rawCreate); } catch {}
      console.log("Step 2 — create status:", createRes.status, rawCreate.substring(0, 300));

      if (createRes.status === 200 || createRes.status === 201) {
        listId = created.listId;
        listJustCreated = true;
        console.log("Step 2 — created listId:", listId);
      } else {
        // Race condition → retry
        for (let attempt = 1; attempt <= 5; attempt++) {
          await sleep(600 * attempt);
          listId = await findListByName(list_name);
          console.log(`Step 2 — retry ${attempt}/5 — listId:`, listId);
          if (listId) break;
        }
      }
    }

    if (!listId) throw new Error("Impossible de récupérer le listId");

    // ── 3. Ajoute le contact à la liste ──────────────────────────────────────
    const addRes = await hubspotFetch(
      `https://api.hubapi.com/contacts/v1/lists/${listId}/add`,
      "POST",
      { vids: [parseInt(contact_id)] }
    );
    const addText = await addRes.text();
    console.log("Step 3 — add status:", addRes.status, addText.substring(0, 300));

    // ── 4. URL HubSpot de la liste ────────────────────────────────────────────
    const list_url = `https://app.hubspot.com/contacts/${HUBSPOT_ACCOUNT_ID}/lists/${listId}`;

    // ── 5. Webhook Clay — uniquement à la création de la liste ───────────────
    if (listJustCreated) {
      const webhookRes = await fetch(
        "https://api.clay.com/v3/sources/webhook/pull-in-data-from-a-webhook-8bbd1005-a299-4e85-9387-08701e82a8ea",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ import_code, list_name, list_id: listId, list_url, status: "list_created" })
        }
      );
      console.log("Step 5 — Clay webhook status:", webhookRes.status);
    }

    return res.status(200).json({ success: true, list_id: listId, list_url });

  } catch (err) {
    console.error("FATAL:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
