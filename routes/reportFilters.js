function parseIdList(input) {
  const raw = Array.isArray(input) ? input : [input];

  const flattened = raw.flatMap((item) => String(item || "").split(","));

  return Array.from(
    new Set(
      flattened
        .map((item) => String(item || "").trim())
        .filter((item) => item !== "")
    )
  );
}

function appendMultiIdFilter(where, params, columnName, singleValue, multiValue) {
  const ids = parseIdList(multiValue || singleValue);
  if (!ids.length) return;
  where.push(`CAST(${columnName} AS TEXT) IN (${ids.map(() => "?").join(",")})`);
  params.push(...ids);
}

function appendLocationFilter(where, params, locationId, locationIds, warehouseAlias = "w") {
  const ids = parseIdList(locationIds || locationId);
  if (!ids.length) return;
  where.push(`(
    CAST(i.location_id AS TEXT) IN (${ids.map(() => "?").join(",")})
    OR CAST(${warehouseAlias}.location_id AS TEXT) IN (${ids.map(() => "?").join(",")})
  )`);
  params.push(...ids);
  params.push(...ids);
}

module.exports = {
  parseIdList,
  appendMultiIdFilter,
  appendLocationFilter,
};
