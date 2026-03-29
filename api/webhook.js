const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const HUBSPOT_ACCOUNT_ID = process.env.HUBSPOT_ACCOUNT_ID;

// Pause utilitaire
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Fetch HubSpot avec retry automatique sur 429
async function hubspotFetch(url, options = {}, retries = 5) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${HUBSPOT_TOKEN}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("Retry-After") || "10") * 1000;
      console.log(`429 rate limit — attempt ${attempt}/${retries}, waiting ${retryAfter}ms`);
      await sleep(retryAfter);
      continue;
    }

    if (res.status === 401 || res.status === 403) {
      const body = await res.text();
      throw new Error(`HubSpot auth error ${res.status}: ${body.substring(0, 200)}`);
    }

    return res;
  }
  throw new Error("HubSpot rate limit dépassé après plusieurs tentatives");
}

// Parcourt toutes les pages et retourne le listId correspondant à list_name
async function findList(list_name) {
  let offset = 0;
  let pageCount = 0;
  while (true) {
    pageCount++;
    const res = await hubspotFetch(
      `https://api.hubapi.com/contacts/v1/lists?count=250&offset=${offset}`
    );
    const data = await res.json();
    console.log(`findList page ${pageCount} — status: ${res.status}, lists: ${data.lists?.length}, has-more: ${data["has-more"]}`);

    const existing = data.lists?.find(l => l.name?.trim() === list_name?.trim());
    if (existing) {
      console.log("findList — found:", existing.listId, existing.name);
      return existing.listId;
    }
    if (!data["has-more"]) {
      console.log("findList — not found after", pageCount, "pages");
      return null;
    }
    offset += 250;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const { contact_id, import_code, list_name } = req.body;
  if (!contact_id || !import_code || !list_name) {
    return res.status(400).json({ error: "Champs manquants: contact_id, import_code, list_name" });
  }

  try {
    // Délai aléatoire léger pour étaler les appels parallèles
    await sleep(Math.random() * 500);

    // ── 1. Cherche la liste existante ─────────────────────────────────────────
    let listId = await findList(list_name);
    let listJustCreated = false;
    console.log("Step 1 — listId:", listId);

    // ── 2. Crée la liste si elle n'existe pas ────────────────────────────────
    if (!listId) {
      const createRes = await hubspotFetch("https://api.hubapi.com/contacts/v1/lists", {
        method: "POST",
        body: JSON.stringify({ name: list_name, dynamic: false })
      });

      const rawCreate = await createRes.text();
      let created = {};
      try { created = JSON.parse(rawCreate); } catch {}
      console.log("Step 2 — create status:", createRes.status, rawCreate.substring(0, 300));

      if (createRes.status === 200 || createRes.status === 201) {
        listId = created.listId;
        listJustCreated = true;
        console.log("Step 2 — created listId:", listId);
      } else {
        // Création échouée (doublon, race condition) → retry avec backoff
        console.log("Step 2 — create failed, retrying findList...");
        for (let attempt = 1; attempt <= 5; attempt++) {
          await sleep(600 * attempt);
          listId = await findList(list_name);
          console.log(`Step 2 — retry ${attempt}/5 — listId:`, listId);
          if (listId) break;
        }
      }
    }

    if (!listId) throw new Error("Impossible de récupérer le listId");

    // ── 3. Ajoute le contact à la liste ──────────────────────────────────────
    const addRes = await hubspotFetch(
      `https://api.hubapi.com/contacts/v1/lists/${listId}/add`,
      {
        method: "POST",
        body: JSON.stringify({ vids: [parseInt(contact_id)] })
      }
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
