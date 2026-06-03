# Expected output — first task (point_radius over Harare)

Submitting `point_radius.harare.json`:

```sh
curl -s -X POST http://localhost:8789/tasks \
  -H 'content-type: application/json' \
  --data @fundi/examples/point_radius.harare.json
```

returns immediately (the caller is never blocked, §2):

```json
{
  "kind": "seed",
  "taskId": "0192e0aa-1234-7abc-89de-f0123456789a",
  "deduped": false,
  "message": "This region will exist going forward."
}
```

The task is enqueued, a `FundiAgent` instance (keyed by that `taskId`) picks it
up, tiles the 5 km radius, queries Overpass, dedupes on OSM id, classifies each
feature, enriches it, and upserts tier-0 records. Check progress with the MCP
`task_status` tool or the D1 ledger.

## A business → place + linked unverified entity

An OSM hotel (e.g. `node/123456` `tourism=hotel`, `name="Bronte Hotel"`) yields
**two** records. The place's `ownerEntityId` points at the entity; the entity's
`primaryPlaceId` points back. Both at `verificationTier: 0`.

`places.places`:

```jsonc
{
  "_id": "0192e0aa-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
  "_schemaVersion": "v3.2",
  "ownerEntityId": "0192e0aa-bbbb-7bbb-8bbb-bbbbbbbbbbbb",
  "slug": "bronte-hotel-aaaaaa",
  "name": "Bronte Hotel",
  "geo": { "type": "Point", "coordinates": [31.0512, -17.8246] },
  "placeType": ["Accommodation", "LocalBusiness"],
  "plusCode": "4FRW5263+...", // computed locally, no API
  "what3words": "filled.count.soap", // write-time only; null if w3w unavailable
  "address": { "city": "Harare", "country": "ZW" },
  "content": { "description": "Bronte Hotel is a garden hotel in central Harare…" },
  "hierarchy": { "containedInPlaceId": null, "countryId": null, "provinceId": null },
  "bundu": {
    "verificationTier": 0,
    "trustSignals": { "ubuntuScore": 0.0, "communityVouches": 0, "reviewCount": 0 },
    "informalEconomy": { "isInformal": false },
    "communityCaretakers": [],
    "osmContribution": { "osmType": "node", "osmId": 123456, "lastSyncedAt": "2026-06-03T…" },
  },
  "sourceProvenance": { "legacyId": "node/123456", "dataOrigin": "osm", "dataConfidence": 0.7 },
  "isActive": true,
  "createdAt": "2026-06-03T…",
  "updatedAt": "2026-06-03T…",
}
```

`entity.entities`:

```jsonc
{
  "_id": "0192e0aa-bbbb-7bbb-8bbb-bbbbbbbbbbbb",
  "_schemaVersion": "v3.2",
  "entityType": "organization",
  "ecosystemRole": "external",
  "schemaOrgType": "LocalBusiness",
  "slug": "bronte-hotel-bbbbbb",
  "name": "Bronte Hotel",
  "isActive": true,
  "isPrivateByDefault": false,
  "primaryPlaceId": "0192e0aa-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
  "bundu": {
    "verificationTier": 0,
    "trustSignals": {
      "ubuntuScore": 0.0,
      "communityVouches": 0,
      "reviewCount": 0,
      "scamReportCount": 0,
      "scamReportResolved": 0,
      "verificationTier": 0,
    },
  },
  "sourceProvenance": {
    "legacyId": "node/123456",
    "sourceProject": "fundi",
    "mirroredFrom": "osm",
  },
  "createdAt": "2026-06-03T…",
  "updatedAt": "2026-06-03T…",
}
```

## A natural / owner-less place

A waterfall or viewpoint yields **one** record whose `ownerEntityId` is the
Bundu Commons custodian `0192e000-c000-7000-8000-000000000001`; no entity is
created.

## Re-running the same task

`write_records` upserts on `sourceProvenance.legacyId` (the OSM id), so a second
run of the identical task creates **zero** new records — it only refreshes
`updatedAt` and any changed enrichment. The duplicate "Rhino Safari Camp" bug
does not recur.
