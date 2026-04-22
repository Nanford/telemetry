# Zone Id And Area Id Alignment Design

## Goal

Align the Go2 SLAM telemetry payload with the backend's existing warehouse operations model so that:

- `zone_id` continues to represent business monitoring zones such as `A1` to `A5`
- `area_id` represents the broader SLAM map or floor context such as `warehouse_1f`
- `point_id` remains the matched patrol point identifier for compatibility and debugging

## Current Problem

The Pi agent currently loads a single `area_id` from `points.yaml` and sends it as the top-level `zone_id`. The backend, however, uses `zone_id` as the primary business key for:

- zone records
- sensor assignment
- telemetry aggregation
- alert rules
- alerts

This means telemetry from a matched patrol point like `A2` is currently being stored under `zone_id=warehouse_1f`, which conflicts with the existing backend data model and operations workflow.

## Design Decisions

### Payload semantics

- `zone_id`: the business zone key used by the backend, sourced from the matched point
- `area_id`: the larger SLAM area or floor identifier
- `point_id`: the matched point identifier; for current deployments this matches `zone_id`

Example:

```json
{
  "zone_id": "A2",
  "area_id": "warehouse_1f",
  "point_id": "A2"
}
```

### Pi-side matching

The Pi agent remains the source of truth for SLAM-based point matching. It should:

1. Read `area_id` from the points configuration
2. Match `x/y` coordinates to a point
3. Emit `zone_id` from the matched point's configured `zone_id`, or fall back to the point `id`

This preserves the existing spool-first telemetry pipeline and avoids duplicating spatial business rules in the backend.

### Backend compatibility

The backend should keep treating `zone_id` as the primary key for zones, rules, alerts, and trend queries.

The backend should additionally:

- accept `area_id` from payloads
- persist `area_id` into `telemetry_raw`
- fall back to `point_id` when `zone_id` is absent in incoming SLAM payloads

No existing rule or alert behavior should change.

## Configuration Model

The points configuration remains backward-compatible with the current single-area layout, but each point may now optionally declare `zone_id`.

Example:

```yaml
area_id: warehouse_1f
points:
  - id: A2
    zone_id: A2
    x: 6.4
    y: 2.0
    radius: 0.8
```

If `zone_id` is omitted, the matcher uses `id`.

## Testing Scope

The implementation must verify:

- point matching returns the correct `zone_id`
- telemetry payloads send `zone_id` and `area_id` with the corrected semantics
- backend normalization prefers `payload.zone_id`, falls back to `payload.point_id`, and preserves `area_id`
- backend SQL schema supports storing `area_id`

## Out Of Scope

- redesigning the backend alert model
- introducing multi-floor polygon-based SLAM area inference
- changing frontend pages to group by `area_id`
