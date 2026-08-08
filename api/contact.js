// Vercel serverless function: receives "Let's Connect" contact form submissions,
// creates/updates a contact in GHL, and triggers the notification workflow.
// The GHL API key lives ONLY here (server-side env var), never in client JS.

export default async function handler(req, res) {
  // CORS + method guard
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const GHL_API_KEY = process.env.GHL_API_KEY;
  const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
  const GHL_CONTACT_WORKFLOW_ID = process.env.GHL_CONTACT_WORKFLOW_ID;

  if (!GHL_API_KEY || !GHL_LOCATION_ID) {
    console.error('Missing GHL_API_KEY or GHL_LOCATION_ID env vars');
    return res.status(500).json({ error: 'Server not configured' });
  }

  const { firstName, lastName, email, subject, level, message } = req.body || {};

  if (!firstName || !lastName || !email || !message) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  try {
    // 1. Create/upsert the contact in GHL, tagged so it's easy to filter in the CRM
    const contactResp = await fetch('https://services.leadconnectorhq.com/contacts/upsert', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Version': '2021-07-28',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': UA,
      },
      body: JSON.stringify({
        locationId: GHL_LOCATION_ID,
        firstName,
        lastName,
        email,
        tags: ['website-contact-form'],
        customFields: [],
        source: 'Website Contact Form - Let\'s Connect',
      }),
    });

    const contactData = await contactResp.json();

    if (!contactResp.ok) {
      console.error('GHL contact upsert failed:', contactData);
      return res.status(502).json({ error: 'Failed to reach CRM' });
    }

    const contactId = contactData.contact ? contactData.contact.id : (contactData.id || null);

    // 2. Add a note to the contact with the actual message (subject, level, message body)
    if (contactId) {
      const noteBody =
        `Contact form submission from website:\n\n` +
        `Subject: ${subject || 'N/A'}\n` +
        `Current Level: ${level || 'Not specified'}\n\n` +
        `Message:\n${message}`;

      await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/notes`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GHL_API_KEY}`,
          'Version': '2021-07-28',
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': UA,
        },
        body: JSON.stringify({ body: noteBody }),
      }).catch((e) => console.error('Note creation failed (non-fatal):', e));

      // 3. Trigger the notification workflow (sends email to Andrew), if configured
      if (GHL_CONTACT_WORKFLOW_ID) {
        await fetch(
          `https://services.leadconnectorhq.com/contacts/${contactId}/workflow/${GHL_CONTACT_WORKFLOW_ID}`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${GHL_API_KEY}`,
              'Version': '2021-07-28',
              'Content-Type': 'application/json',
              'Accept': 'application/json',
              'User-Agent': UA,
            },
            body: JSON.stringify({
              eventStartTime: new Date().toISOString(),
            }),
          }
        ).catch((e) => console.error('Workflow trigger failed (non-fatal):', e));
      }
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Contact form handler error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
