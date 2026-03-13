export default function handler(req, res) {
  res.status(200).json({
    googleMapsKey: process.env.GOOGLE_MAPS_KEY,
    usdaApiKey: process.env.USDA_API_KEY
  });
}
