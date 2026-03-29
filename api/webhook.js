const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const HUBSPOT_ACCOUNT_ID = process.env.HUBSPOT_ACCOUNT_ID;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const { contact_id, import_code, list_name } = req.body;
  if (!contact_id || !import_code || !list_name) {
    return res.status(400).json({ error: "Champs manquants: contact_id, import_code, list_name" });
  }

  try {
    await new Promise(r => setTimeout(r, Math.random() * 1000));

    // ── Fonction utilitaire : parcourt toutes les pages et retourne le listId ──
    const findList = async () => {
      let offset = 0;
      let pageCount = 0;
      while (true) {
        pageCount++;
        const r = await fetch(
          `https://api.hubapi.com/contacts/v1/lists?count=250&offset=${offset}`,
          { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
        );
        const data = await r.json();

        console.log(`findList page ${pageCount} — status: ${r.status}, lists count: ${data.lists?.length}, has-more: ${data["has-more"]}, offset: ${offset}`);

        if (r.status !== 200) {
          console.log("findList — unexpected status:", r.status, JSON.stringify(data));
          return null;
        }

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
    };

    // ── 1. Cherche la liste existante ─────────────────────────────────────────
    let listId = await findList();
    let listJustCreated = false;
    console.log("Step 1 — listId after initial search:", listId);

    // ── 2. Crée la liste si elle n'existe pas ────────────────────────────────
    if (!listId) {
      const createRes = await fetch("https://api.hubapi.com/contacts/v1/lists", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${HUBSPOT_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ name: list_name, dynamic: false })
      });

      let created;
      const rawCreate = await createRes.text();
      try { created = JSON.parse(rawCreate); } catch { created = {}; }

      console.log("Step 2 — create status:", createRes.status, "body:", rawCreate.substring(0, 500));

      if (createRes.status === 200 || createRes.status === 201) {
        listId = created.listId;
        listJustCreated = true;
        console.log("Step 2 — created listId:", listId);
      } else {
        // Création échouée (race condition, doublon, rate limit…)
        console.log("Step 2 — create failed, starting retry loop");

        for (let attempt = 1; attempt <= 5; attempt++) {
          const delay = 600 * attempt;
          console.log(`Step 2 — retry ${attempt}/5, waiting ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));

          listId = await findList();
          console.log(`Step 2 — retry ${attempt}/5 — listId:`, listId);
          if (listId) break;
        }
      }
    }

    if (!listId) {
      console.error("Step 2 — FATAL: listId still null after all retries");
      throw new Error("Impossible de récupérer le listId");
    }

    // ── 3. Ajoute le contact à la liste ──────────────────────────────────────
    const addRes = await fetch(`https://api.hubapi.com/contacts/v1/lists/${listId}/add`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HUBSPOT_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ vids: [parseInt(contact_id)] })
    });
    const addText = await addRes.text();
    console.log("Step 3 — add status:", addRes.status, "body:", addText.substring(0, 300));

    // ── 4. URL HubSpot de la liste ────────────────────────────────────────────
    const list_url = `https://app.hubspot.com/contacts/${HUBSPOT_ACCOUNT_ID}/lists/${listId}`;

    // ── 5. Webhook Clay — uniquement à la création de la liste ───────────────
    if (listJustCreated) {
      const clayWebhookUrl = "https://api.clay.com/v3/sources/webhook/pull-in-data-from-a-webhook-8bbd1005-a299-4e85-9387-08701e82a8ea";
      const webhookRes = await fetch(clayWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ import_code, list_name, list_id: listId, list_url, status: "list_created" })
      });
      console.log("Step 5 — Clay webhook status:", webhookRes.status);
    }

    return res.status(200).json({ success: true, list_id: listId, list_url });

  } catch (err) {
    console.error("FATAL error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
