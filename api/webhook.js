const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const HUBSPOT_ACCOUNT_ID = process.env.HUBSPOT_ACCOUNT_ID;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Fetch HubSpot avec retry automatique sur 429
async function hubspotFetch(url, options = {}, retries = 5) {
  const { headers: _, ...restOptions } = options; // on ignore tout headers entrant
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(url, {
      ...restOptions,
      headers: {
        Authorization: `Bearer ${HUBSPOT_TOKEN}`,
        "Content-Type": "application/json"
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

// Recherche une liste par nom exact via l'API de recherche (v1 /lists/search)
// Beaucoup plus rapide que paginer toutes les listes
async function findListByName(list_name) {
  const encoded = encodeURIComponent(list_name.trim());
  const res = await hubspotFetch(
    `https://api.hubapi.com/contacts/v1/lists/search?query=${encoded}&count=10&offset=0`
  );

  if (!res.ok) {
    const body = await res.text();
    console.log("findListByName search failed:", res.status, body.substring(0, 200));
    return null;
  }

  const data = await res.json();
  console.log(`findListByName — status: ${res.status}, results: ${data.lists?.length}`);

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

  try {
    // DEBUG TEMPORAIRE — à supprimer après diagnostic
    console.log("TOKEN_DEBUG — length:", HUBSPOT_TOKEN?.length, "| starts:", HUBSPOT_TOKEN?.substring(0, 10), "| ends:", HUBSPOT_TOKEN?.slice(-4));

    await sleep(Math.random() * 500);

    // ── 1. Cherche la liste par nom ───────────────────────────────────────────
    let listId = await findListByName(list_name);
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
        // Race condition ou doublon → retry findListByName avec backoff
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
