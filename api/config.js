export default function handler(req, res) {
  res.status(200).json({
    usdaApiKey: process.env.USDA_API_KEY
  });
}
