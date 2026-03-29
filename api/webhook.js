// Reçoit le webhook Clay, crée la liste HubSpot (1 seule fois par import_code),
// ajoute les contacts, puis renvoie un webhook de confirmation à Clay.

const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const HUBSPOT_ACCOUNT_ID = process.env.HUBSPOT_ACCOUNT_ID;
const CLAY_WEBHOOK_URL = process.env.CLAY_WEBHOOK_URL;

// Cache en mémoire pour éviter de recréer la liste pendant le batch
const listCache = {};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const { contact_id, import_code, list_name } = req.body;

  if (!contact_id || !import_code || !list_name) {
    return res.status(400).json({
      error: "Champs manquants",
      required: ["contact_id", "import_code", "list_name"]
    });
  }

  try {
    // ── 1. Récupérer ou créer la liste ──────────────────────────────────────
    let listId = listCache[import_code];

    if (!listId) {
      // Cherche si la liste existe déjà (API v3)
      const searchRes = await fetch(
        `https://api.hubapi.com/crm/v3/lists/search`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${HUBSPOT_TOKEN}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            query: list_name,
            count: 50,
            offset: 0,
            processingTypes: ["MANUAL"]
          })
        }
      );
      const searchData = await searchRes.json();
      console.log("HubSpot list search:", JSON.stringify(searchData?.lists?.map(l => l.name)));
      // Comparaison exacte du nom (trim pour éviter les espaces parasites)
      const existing = searchData.lists?.find(l => l.name?.trim() === list_name?.trim());
      if (existing) {
        // Utiliser l'ILS list ID pour les appels memberships
        listId = existing.ilsListId || existing.listId;
        console.log("Found existing listId:", listId);
      }

      if (existing) {
        listId = existing.listId;
      } else {
        // Crée la liste (API v3)
        const createRes = await fetch("https://api.hubapi.com/crm/v3/lists/", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${HUBSPOT_TOKEN}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            name: list_name,
            objectTypeId: "0-1",
            processingType: "MANUAL"
          })
        });
        const created = await createRes.json();
        console.log("HubSpot create list response:", JSON.stringify(created));
        listId = created?.list?.listId || created?.listId;
        if (!listId) throw new Error("HubSpot list creation failed: " + JSON.stringify(created));
        console.log("Created listId:", listId);
      }

      listCache[import_code] = listId;
    }

    // ── 2. Ajouter le contact à la liste (API v3) ─────────────────────────────
    // API v1 pour l'ajout de contacts — plus fiable que v3
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
    console.log("Add status:", addRes.status, "body:", addText.substring(0, 500));

    // ── 3. Construire l'URL HubSpot de la liste ───────────────────────────────
    const list_url = `https://app.hubspot.com/contacts/${HUBSPOT_ACCOUNT_ID}/lists/${listId}`;

    // ── 4. Renvoyer le webhook de confirmation à Clay ─────────────────────────
    await fetch(CLAY_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        import_code,
        list_name,
        list_id: listId,
        list_url,
        contact_id,
        status: "success"
      })
    });

    return res.status(200).json({ success: true, list_id: listId, list_url });

  } catch (err) {
    console.error(err);

    // Notifie Clay en cas d'erreur aussi
    await fetch(CLAY_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        import_code,
        contact_id,
        status: "error",
        error: err.message
      })
    }).catch(() => {});

    return res.status(500).json({ error: err.message });
  }
}
