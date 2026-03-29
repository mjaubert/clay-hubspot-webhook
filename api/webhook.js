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
      // Cherche si la liste existe déjà dans HubSpot
      const searchRes = await fetch(
        `https://api.hubapi.com/contacts/v1/lists?count=250`,
        { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
      );
      const { lists = [] } = await searchRes.json();
      const existing = lists.find(l => l.name === list_name);

      if (existing) {
        listId = existing.listId;
      } else {
        // Crée la liste (une seule fois)
        const createRes = await fetch("https://api.hubapi.com/contacts/v1/lists", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${HUBSPOT_TOKEN}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ name: list_name, dynamic: false })
        });
        const created = await createRes.json();
        listId = created.listId;
      }

      // Mémorise pour les prochains contacts du même import_code
      listCache[import_code] = listId;
    }

    // ── 2. Ajouter le contact à la liste ─────────────────────────────────────
    await fetch(`https://api.hubapi.com/contacts/v1/lists/${listId}/add`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HUBSPOT_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ vids: [parseInt(contact_id)] })
    });

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
