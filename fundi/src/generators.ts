// Task generators (§2). A bulk intent ("seed all African capitals, 20km") is
// NOT a special task — it fans out, here, into N atomic point_radius tasks.
// Generators are kept separate from the consumer (the FundiAgent), which only
// ever sees uniform atomic tasks.

import { buildClient, DB, COLLECTION } from "./mongo";
import type { BulkIntent, SeedTaskInput } from "./types";

interface CapitalDoc {
  _id: string;
  name?: string;
  geo?: { coordinates?: [number, number] };
  centroid?: { coordinates?: [number, number] };
  center?: [number, number];
}

// Dev-only fallback so the bulk example is runnable before places.placesGeo is
// populated. Doctrine (§0.4) forbids hardcoded regions in the engine, so this is
// gated behind FUNDI_ALLOW_FALLBACK_CAPITALS and never used in production.
const FALLBACK_CAPITALS: Array<{ name: string; center: [number, number] }> = [
  { name: "Harare", center: [31.0492, -17.8292] },
  { name: "Nairobi", center: [36.8219, -1.2921] },
  { name: "Accra", center: [-0.1869, 5.6037] },
  { name: "Kampala", center: [32.5825, 0.3476] },
  { name: "Lusaka", center: [28.3228, -15.3875] },
  { name: "Dakar", center: [-17.4677, 14.7167] },
  { name: "Kigali", center: [30.0589, -1.9441] },
  { name: "Windhoek", center: [17.0832, -22.5597] },
  { name: "Gaborone", center: [25.9088, -24.6282] },
  { name: "Bamako", center: [-8.0029, 12.6392] },
];

async function readCapitalsFromGeo(
  uri: string,
  limit: number,
): Promise<Array<{ name: string; center: [number, number] }>> {
  const client = buildClient(uri);
  try {
    await client.connect();
    const docs = await client
      .db(DB.places)
      .collection<CapitalDoc>(COLLECTION.placesGeo)
      .find(
        { $or: [{ isCapital: true }, { capital: true }, { "properties.capital": "yes" }] },
        { projection: { _id: 1, name: 1, geo: 1, centroid: 1, center: 1 }, limit },
      )
      .toArray();
    const out: Array<{ name: string; center: [number, number] }> = [];
    for (const d of docs) {
      const coords = d.geo?.coordinates ?? d.centroid?.coordinates ?? d.center;
      if (coords) out.push({ name: d.name ?? d._id, center: coords });
    }
    return out;
  } finally {
    await client.close().catch(() => {});
  }
}

export async function expandBulkIntent(
  env: { MONGODB_URI: string; FUNDI_ALLOW_FALLBACK_CAPITALS?: string },
  intent: BulkIntent,
): Promise<SeedTaskInput[]> {
  if (intent.intent !== "african_capitals") {
    throw new Error(`unknown bulk intent: ${intent.intent}`);
  }
  const limit = intent.limit ?? 200;

  let capitals = await readCapitalsFromGeo(env.MONGODB_URI, limit);
  if (capitals.length === 0) {
    if (env.FUNDI_ALLOW_FALLBACK_CAPITALS !== "true") {
      throw new Error(
        "no capitals found in places.placesGeo (mark capital docs with isCapital:true), " +
          "and FUNDI_ALLOW_FALLBACK_CAPITALS is not enabled",
      );
    }
    capitals = FALLBACK_CAPITALS.slice(0, limit);
  }

  return capitals.map((c) => ({
    region: { kind: "point_radius" as const, center: c.center, radiusMeters: intent.radiusMeters },
    categories: intent.categories,
    source: { ...intent.source, surface: intent.source.surface ?? `bulk:capital:${c.name}` },
    priority: 1, // bulk ops sit below user-initiated work (§2)
  }));
}
