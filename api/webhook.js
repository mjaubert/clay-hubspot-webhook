const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const HUBSPOT_ACCOUNT_ID = process.env.HUBSPOT_ACCOUNT_ID;
const CLAY_WEBHOOK_URL = process.env.CLAY_WEBHOOK_URL;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const { contact_id, import_code, list_name } = req.body;
  if (!contact_id || !import_code || !list_name) {
    return res.status(400).json({ error: "Champs manquants: contact_id, import_code, list_name" });
  }

  try {
    // ── 1. Cherche la liste existante via API v1 ─────────────────────────────
    let listId = null;
    let listJustCreated = false;
    let offset = 0;
    let found = false;

    while (!found) {
      const searchRes = await fetch(
        `https://api.hubapi.com/contacts/v1/lists?count=250&offset=${offset}`,
        { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
      );
      const searchData = await searchRes.json();
      const existing = searchData.lists?.find(l => l.name?.trim() === list_name?.trim());

      if (existing) {
        listId = existing.listId;
        console.log("Found existing list:", listId, existing.name);
        found = true;
      } else if (!searchData["has-more"]) {
        break;
      } else {
        offset += 250;
      }
    }

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
      const created = await createRes.json();
      console.log("Create status:", createRes.status, JSON.stringify(created));

      // Si la liste existe déjà (race condition entre instances parallèles)
      if (createRes.status === 400 && created.subCategory === "ILS.DUPLICATE_LIST_NAMES") {
        // Refetch pour récupérer le listId
        const refetchRes = await fetch(
          `https://api.hubapi.com/contacts/v1/lists?count=250`,
          { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
        );
        const refetchData = await refetchRes.json();
        const existing = refetchData.lists?.find(l => l.name?.trim() === list_name?.trim());
        listId = existing?.listId;
        console.log("Refetched listId after duplicate:", listId);
      } else {
        listId = created.listId;
        listJustCreated = true;
        console.log("Created listId:", listId);
      }
    }

    if (!listId) throw new Error("Impossible de récupérer le listId");

    // ── 3. Ajoute le contact à la liste via API v1 ───────────────────────────
    const addRes = await fetch(`https://api.hubapi.com/contacts/v1/lists/${listId}/add`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HUBSPOT_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ vids: [parseInt(contact_id)] })
    });
    const addText = await addRes.text();
    console.log("Add status:", addRes.status, "body:", addText.substring(0, 300));

    // ── 4. URL HubSpot de la liste ────────────────────────────────────────────
    const list_url = `https://app.hubspot.com/contacts/${HUBSPOT_ACCOUNT_ID}/lists/${listId}`;

    // ── 5. Webhook Clay — uniquement à la création de la liste ───────────────
    if (listJustCreated) {
      const clayWebhookUrl = "https://api.clay.com/v3/sources/webhook/pull-in-data-from-a-webhook-8bbd1005-a299-4e85-9387-08701e82a8ea";
      await fetch(clayWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          import_code,
          list_name,
          list_id: listId,
          list_url,
          status: "list_created"
        })
      });
      console.log("Clay webhook sent for new list:", list_name);
    }

    return res.status(200).json({ success: true, list_id: listId, list_url });

  } catch (err) {
    console.error("Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
