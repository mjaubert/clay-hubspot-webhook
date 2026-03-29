const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const HUBSPOT_ACCOUNT_ID = process.env.HUBSPOT_ACCOUNT_ID;
const CLAY_WEBHOOK_URL = process.env.CLAY_WEBHOOK_URL;

const listCache = {};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const { contact_id, import_code, list_name } = req.body;
  if (!contact_id || !import_code || !list_name) {
    return res.status(400).json({ error: "Champs manquants: contact_id, import_code, list_name" });
  }

  try {
    // ── 1. Récupérer ou créer la liste via API v1 ────────────────────────────
    let listId = listCache[import_code];

    if (!listId) {
      // Cherche si la liste existe déjà (API v1)
      const searchRes = await fetch(
        `https://api.hubapi.com/contacts/v1/lists?count=250`,
        { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
      );
      const searchData = await searchRes.json();
      console.log("Search status:", searchRes.status);
      const existing = searchData.lists?.find(l => l.name?.trim() === list_name?.trim());

      if (existing) {
        listId = existing.listId;
        console.log("Found existing list:", listId, existing.name);
      } else {
        // Crée la liste via API v1
        const createRes = await fetch("https://api.hubapi.com/contacts/v1/lists", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${HUBSPOT_TOKEN}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ name: list_name, dynamic: false })
        });
        const created = await createRes.json();
        console.log("Create status:", createRes.status, "response:", JSON.stringify(created));
        listId = created.listId;
        if (!listId) throw new Error("List creation failed: " + JSON.stringify(created));
        console.log("Created listId:", listId);
      }

      listCache[import_code] = listId;
    }

    // ── 2. Ajouter le contact via API v1 ─────────────────────────────────────
    console.log("Adding contact", contact_id, "to listId:", listId);
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

    // ── 3. URL HubSpot de la liste ────────────────────────────────────────────
    const list_url = `https://app.hubspot.com/contacts/${HUBSPOT_ACCOUNT_ID}/lists/${listId}`;

    // ── 4. Webhook retour Clay ────────────────────────────────────────────────
    if (CLAY_WEBHOOK_URL) {
      await fetch(CLAY_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ import_code, list_name, list_id: listId, list_url, contact_id, status: "success" })
      });
    }

    return res.status(200).json({ success: true, list_id: listId, list_url });

  } catch (err) {
    console.error("Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
