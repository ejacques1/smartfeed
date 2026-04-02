export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Anthropic API key not configured' });
  }

  try {
    const { base64, mediaType, swapOnly, product, calories, protein_g, carbs_g, fat_g } = req.body;

    let messages;
    if (swapOnly) {
      // Text-search flow: we already have nutrition data, just need swap suggestions
      if (!product) return res.status(400).json({ error: 'Missing product name' });
      messages = [{
        role: 'user',
        content: `Given this food product: "${product}" (${calories} cal, ${protein_g}g protein, ${carbs_g}g carbs, ${fat_g}g fat per serving), suggest 2 whole food alternatives. Return ONLY valid JSON, no markdown: {"swaps":[{"food":"whole food name","calories":number,"protein_g":number,"carbs_g":number,"fat_g":number,"why":"one sentence explaining why this is a good swap"}]}. Focus on real, unprocessed foods like fruits, vegetables, nuts, eggs, yogurt — not processed substitutes. This is educational information, not dietary advice.`
      }];
    } else {
      // Image scan flow: read label + suggest swaps
      if (!base64 || !mediaType) return res.status(400).json({ error: 'Missing base64 or mediaType' });
      messages = [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: 'Read this nutrition facts label. Return ONLY valid JSON, no markdown, no explanation: {"product":"name if visible else Unknown","calories":number,"protein_g":number,"carbs_g":number,"fat_g":number,"serving_size":"text","swaps":[{"food":"whole food name","calories":number,"protein_g":number,"carbs_g":number,"fat_g":number,"why":"one sentence explaining why this is a good swap"}]}. Use 0 for any value not visible. For "swaps", suggest exactly 2 unprocessed whole food alternatives with a similar satisfaction profile but better nutritional value. Focus on real, simple foods like fruits, vegetables, nuts, eggs, yogurt — not processed substitutes. This is educational information, not dietary advice.' }
        ]
      }];
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 800,
        messages
      })
    });

    const data = await response.json();
    res.status(200).json(data);
  } catch (e) {
    console.error('Scan label error:', e);
    res.status(500).json({ error: 'Failed to analyze label' });
  }
}
