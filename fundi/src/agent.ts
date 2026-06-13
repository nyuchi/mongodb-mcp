// Fundi: the agent. Not a transform — an agent frame whose tools are *skills*.
// Today the routing is deterministic (LLM only at the description judgment
// point), but skills register into one map so richer skills (future relational /
// landmark resolution) slot in without rewriting the consumer.

import type { Db, MongoClient } from "mongodb";
import { type Bbox, boundaryBbox, guardRegion } from "./africa";
import { DB } from "./mongo";
import { encodePlusCode } from "./pluscode";
import { ProviderRegistry } from "./registry";
import { classify, type OsmFeature } from "./skills/classify";
import { type AiConfig, generateDescription } from "./skills/description";
import { type OverpassDeps, overpassLookup, osmKey } from "./skills/overpass";
import { radiusBbox, tileBbox } from "./skills/tile-region";
import { type EnrichedRecord, writeRecords } from "./skills/write-records";
import { enrichWikidata, type WikidataDeps } from "./skills/wikidata";
import { resolveWhat3Words, type What3WordsConfig } from "./skills/what3words";
import type { SeedTask, TaskResult } from "./types";

export interface AgentDeps {
  client: MongoClient;
  placesDb: Db;
  entityDb: Db;
  registry: ProviderRegistry;
  overpass: OverpassDeps;
  ai: AiConfig | null;
  what3words: What3WordsConfig | null;
  wikidata: WikidataDeps | null;
  boundary: Bbox;
}

function log(taskId: string, event: string, data: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({ at: new Date().toISOString(), worker: "fundi", taskId, event, ...data }),
  );
}

export async function buildDeps(client: MongoClient, env: Env): Promise<AgentDeps> {
  const strEnv = env as unknown as Record<string, string | undefined>;
  const integrationsDb = client.db(DB.integrations);
  const registry = new ProviderRegistry(integrationsDb, strEnv);

  const overpassEndpoint = await registry.endpoint("openstreetmap");
  const wikidataEndpoint = await registry.endpoint("wikidata");

  const w3wEndpoint = await registry.endpoint("what3words");
  const w3wKey = await registry.credential("what3words");

  // generate_description runs on Workers AI (Kimi by default), routed through
  // the shamwari AI Gateway. No API key — the AI binding carries access.
  const aiModel = await registry.model(
    "workers_ai",
    env.FUNDI_AI_MODEL ?? "workers-ai/@cf/moonshotai/kimi-k2.6",
  );
  const aiGateway = env.FUNDI_AI_GATEWAY ?? "shamwari";

  return {
    client,
    placesDb: client.db(DB.places),
    entityDb: client.db(DB.entity),
    registry,
    overpass: { endpoint: overpassEndpoint },
    ai: env.AI ? { binding: env.AI, model: aiModel, gateway: aiGateway } : null,
    what3words: w3wKey ? { endpoint: w3wEndpoint, apiKey: w3wKey } : null,
    wikidata: wikidataEndpoint ? { endpoint: wikidataEndpoint } : null,
    boundary: boundaryBbox(strEnv),
  };
}

// Resolves an `admin` region to a bbox via the places.placesGeo centroid.
async function resolveAdminBbox(
  placesDb: Db,
  adminPlaceId: string,
): Promise<{ bbox: Bbox; center: [number, number] }> {
  const doc = await placesDb.collection("placesGeo").findOne<{
    geo?: { coordinates?: [number, number] };
    center?: [number, number];
    centroid?: { coordinates?: [number, number] };
    seedRadiusMeters?: number;
  }>({ _id: adminPlaceId as never });
  if (!doc) throw new Error(`admin region not found in places.placesGeo: ${adminPlaceId}`);

  const coords = doc.geo?.coordinates ?? doc.centroid?.coordinates ?? doc.center;
  if (!coords) throw new Error(`places.placesGeo doc ${adminPlaceId} has no centroid`);
  const radius = doc.seedRadiusMeters ?? 25_000;
  return { bbox: radiusBbox(coords[0], coords[1], radius), center: coords };
}

function dataConfidence(feature: OsmFeature): number {
  const tagCount = Object.keys(feature.tags ?? {}).length;
  return Math.min(0.3 + 0.05 * tagCount, 0.9);
}

export async function runTask(task: SeedTask, deps: AgentDeps): Promise<TaskResult> {
  log(task.taskId, "task.start", { source: task.source.kind, region: task.region.kind });

  // Resolve the region to a bbox + containment hint.
  let bbox: Bbox;
  let containedInPlaceId: string | null = null;
  if (task.region.kind === "point_radius") {
    const [lng, lat] = task.region.center;
    bbox = radiusBbox(lng, lat, task.region.radiusMeters);
  } else if (task.region.kind === "bbox") {
    const [s, w, n, e] = task.region.bbox;
    bbox = { s, w, n, e };
  } else {
    const resolved = await resolveAdminBbox(deps.placesDb, task.region.adminPlaceId);
    bbox = resolved.bbox;
    containedInPlaceId = task.region.adminPlaceId;
    // Deferred Africa guard (§2): admin centroid is only known now.
    const guard = guardRegion(
      { kind: "point_radius", center: resolved.center, radiusMeters: 1 },
      deps.boundary,
    );
    if (!guard.ok) throw new Error(`boundary guard: ${guard.reason}`);
  }

  const tiles = tileBbox(bbox);
  log(task.taskId, "tile.done", { tiles: tiles.length });

  // Dedupe on OSM id across tiles; keep the richest element (most tags).
  const seen = new Map<string, OsmFeature>();
  for (const tile of tiles) {
    let features: OsmFeature[] = [];
    try {
      features = await overpassLookup(deps.overpass, tile, task.categories);
    } catch (e) {
      log(task.taskId, "overpass.error", { error: String(e) });
      continue;
    }
    for (const f of features) {
      const key = osmKey(f);
      const prev = seen.get(key);
      if (!prev || Object.keys(f.tags).length > Object.keys(prev.tags).length) seen.set(key, f);
    }
  }
  log(task.taskId, "overpass.done", { uniqueFeatures: seen.size });

  let placesCreated = 0;
  let entitiesCreated = 0;
  let skipped = 0;

  for (const feature of seen.values()) {
    const classification = classify(feature);
    if (!classification.name) {
      skipped++;
      continue;
    }

    const [plusCode, what3words, wikidata] = await Promise.all([
      Promise.resolve(encodePlusCodeSafe(feature)),
      resolveWhat3Words(deps.what3words, feature.lat, feature.lon),
      enrichWikidata(deps.wikidata, feature.tags.wikidata),
    ]);

    // LLM only when OSM has no usable description (§4 judgment point).
    const existing = feature.tags.description;
    const description =
      existing && existing.length >= 20
        ? existing
        : await generateDescription(deps.ai, feature, classification.name);

    const rec: EnrichedRecord = {
      feature,
      classification,
      name: classification.name,
      plusCode,
      what3words,
      wikidata,
      description,
      dataConfidence: dataConfidence(feature),
      hierarchy: { containedInPlaceId, countryId: null, provinceId: null },
    };

    try {
      const outcome = await writeRecords(deps.placesDb, deps.entityDb, rec);
      if (outcome.placeCreated) placesCreated++;
      if (outcome.entityCreated) entitiesCreated++;
      if (!outcome.placeCreated) skipped++;
    } catch (e) {
      log(task.taskId, "write.error", { osm: osmKey(feature), error: String(e) });
      skipped++;
    }
  }

  const result: TaskResult = { placesCreated, entitiesCreated, skipped };
  log(task.taskId, "task.done", { ...result });
  return result;
}

function encodePlusCodeSafe(feature: OsmFeature): string {
  return encodePlusCode(feature.lat, feature.lon);
}
