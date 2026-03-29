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

    if (res.status === 429) {
      const wait = parseInt(res.headers.get("Retry-After") || "10") * 1000;
      console.log(`429 rate limit — attempt ${attempt}/${retries}, waiting ${wait}ms`);
      await sleep(wait);
      continue;
    }

    if (res.status === 401 || res.status === 403) {
      const text = await res.text();
      throw new Error(`HubSpot auth error ${res.status}: ${text.substring(0, 300)}`);
    }

    return res;
  }
  throw new Error("Rate limit dépassé après plusieurs tentatives");
}

// Utilise l'API v3 qui supporte le filtre par nom directement
async function findListByName(list_name) {
  const url = `https://api.hubapi.com/crm/v3/lists/?listType=STATIC&count=500`;
  let after = null;
  let page = 0;

  while (true) {
    page++;
    const pagedUrl = after ? `${url}&after=${after}` : url;
    const res = await hubspotFetch(pagedUrl);
    const data = await res.json();

    console.log(`findList v3 page ${page} — status: ${res.status}, count: ${data.lists?.length}, hasMore: ${!!data.paging?.next}`);

    const match = data.lists?.find(l => l.name?.trim() === list_name.trim());
    if (match) {
      console.log("findList — found:", match.listId, match.name);
      return match.listId;
    }

    if (!data.paging?.next?.after) {
      console.log("findList — not found after", page, "pages");
      return null;
    }

    after = data.paging.next.after;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const { contact_id, import_code, list_name } = req.body;
  if (!contact_id || !import_code || !list_name) {
    return res.status(400).json({ error: "Champs manquants: contact_id, import_code, list_name" });
  }

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
        console.log("Step 2 — create failed, retrying search...");
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
