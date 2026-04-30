import app from "@/app";

const PORT = Number(process.env.PORT ?? 3001);
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:3100";

app.listen(PORT, () => {
  console.log(`✓ Pinion API listening on http://localhost:${PORT}`);
  console.log(`  CORS origin: ${WEB_ORIGIN}`);
});
