import proj4 from "proj4";

export const TARGET_CRS = "EPSG:5514" as const;

export const EPSG_5514_PROJ4 =
  "+proj=krovak +lat_0=49.5 +lon_0=24.8333333333333 " +
  "+alpha=30.2881397527778 +k=0.9999 +x_0=0 +y_0=0 " +
  // EPSG:5239 publishes these rotations in the Coordinate Frame convention.
  // Proj4js interprets +towgs84 rotations in the Position Vector convention,
  // so their signs must be reversed here.
  "+ellps=bessel +towgs84=572.213,85.334,461.94,4.9732,1.529,5.2484,3.5378 " +
  "+units=m +no_defs +type=crs";

export const EPSG_5514_WKT = `PROJCRS["S-JTSK / Krovak East North",BASEGEOGCRS["S-JTSK",DATUM["System of the Unified Trigonometrical Cadastral Network",ELLIPSOID["Bessel 1841",6377397.155,299.1528128,LENGTHUNIT["metre",1]],ID["EPSG",4156]],CONVERSION["Krovak East North (Greenwich)",METHOD["Krovak (North Orientated)",ID["EPSG",1041]],PARAMETER["Latitude of projection centre",49.5,ANGLEUNIT["degree",0.0174532925199433]],PARAMETER["Longitude of origin",24.8333333333333,ANGLEUNIT["degree",0.0174532925199433]],PARAMETER["Co-latitude of cone axis",30.2881397527778,ANGLEUNIT["degree",0.0174532925199433]],PARAMETER["Latitude of pseudo standard parallel",78.5,ANGLEUNIT["degree",0.0174532925199433]],PARAMETER["Scale factor on pseudo standard parallel",0.9999,SCALEUNIT["unity",1]],PARAMETER["False easting",0,LENGTHUNIT["metre",1]],PARAMETER["False northing",0,LENGTHUNIT["metre",1]]],CS[Cartesian,2],AXIS["Easting (X)",east,ORDER[1]],AXIS["Northing (Y)",north,ORDER[2]],LENGTHUNIT["metre",1],ID["EPSG",5514]]`;

proj4.defs(TARGET_CRS, EPSG_5514_PROJ4);

export type Coordinate = readonly [number, number];

export interface GeographicBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface ProjectedExtent {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function projectToSjtsk(coordinate: Coordinate): Coordinate {
  return proj4("EPSG:4326", TARGET_CRS, [...coordinate]) as [number, number];
}

export function unprojectFromSjtsk(coordinate: Coordinate): Coordinate {
  return proj4(TARGET_CRS, "EPSG:4326", [...coordinate]) as [number, number];
}

export function projectedExtent(
  bounds: GeographicBounds,
  samplesPerEdge = 32,
): ProjectedExtent {
  if (samplesPerEdge < 1) throw new Error("samplesPerEdge must be positive.");

  const points: Coordinate[] = [];
  for (let index = 0; index <= samplesPerEdge; index += 1) {
    const ratio = index / samplesPerEdge;
    const longitude = bounds.west + (bounds.east - bounds.west) * ratio;
    const latitude = bounds.south + (bounds.north - bounds.south) * ratio;
    points.push([longitude, bounds.south], [longitude, bounds.north]);
    points.push([bounds.west, latitude], [bounds.east, latitude]);
  }

  const projected = points.map(projectToSjtsk);
  const xs = projected.map(([x]) => x);
  const ys = projected.map(([, y]) => y);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}
