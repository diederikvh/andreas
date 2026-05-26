/**
 * Map clustering helper. Wrapt `supercluster` zodat caller alleen
 * punten + zoom hoeft door te geven; we krijgen terug een gemixte
 * lijst van cluster-markers (samengevoegd puntje met telling) en
 * point-markers (één enkele payload).
 *
 * Bij uitgezoomd zicht klonteren overlappende pins samen tot één
 * cluster-marker; bij inzoomen valt 'ie weer uiteen in individuele
 * markers. Voorkomt de "Mondriaan-op-de-kaart"-look bij drukke dagen.
 */
import Supercluster from 'supercluster';

export type ClusterPoint<T> = {
  /** Stabiele key — caller bepaalt scheme. */
  id: string;
  lng: number;
  lat: number;
  payload: T;
};

export type ClusterMarker<T> =
  | {
      type: 'cluster';
      id: number;
      count: number;
      lng: number;
      lat: number;
      /** Bbox van alle children — caller fitBounds bij tap. */
      bbox: [number, number, number, number];
    }
  | {
      type: 'point';
      id: string;
      lng: number;
      lat: number;
      payload: T;
    };

export type ClusterIndex<T> = Supercluster<{ id: string; payload: T }>;

/**
 * Bouw een supercluster-index voor een set punten. Caller cachet via
 * useMemo op de input-array reference.
 *
 * Tuning:
 *   - radius: pixel-radius voor cluster-groepering. 60 = redelijk
 *     agressief (overlap binnen ~3 marker-diameters wordt cluster).
 *   - maxZoom: boven dit niveau geen clustering meer — individuele
 *     markers ook al staan ze op elkaar. Gebruiker kan altijd
 *     inzoomen om alle markers gescheiden te zien.
 */
export function buildClusterIndex<T>(points: ClusterPoint<T>[]): ClusterIndex<T> {
  const index = new Supercluster<{ id: string; payload: T }>({
    radius: 60,
    maxZoom: 15,
    minPoints: 2,
  });
  const features = points.map((p) => ({
    type: 'Feature' as const,
    properties: { id: p.id, payload: p.payload },
    geometry: {
      type: 'Point' as const,
      coordinates: [p.lng, p.lat],
    },
  }));
  index.load(features);
  return index;
}

export function getClusterMarkers<T>(
  index: ClusterIndex<T>,
  bbox: [number, number, number, number],
  zoom: number
): ClusterMarker<T>[] {
  const clusters = index.getClusters(bbox, Math.floor(zoom));
  const out: ClusterMarker<T>[] = [];
  for (const c of clusters) {
    const [lng, lat] = c.geometry.coordinates;
    const props = c.properties as
      | { cluster: true; cluster_id: number; point_count: number }
      | { id: string; payload: T };
    if ('cluster' in props && props.cluster) {
      out.push({
        type: 'cluster',
        id: props.cluster_id,
        count: props.point_count,
        lng,
        lat,
        bbox: getClusterBbox(index, props.cluster_id),
      });
    } else {
      const p = props as { id: string; payload: T };
      out.push({
        type: 'point',
        id: p.id,
        lng,
        lat,
        payload: p.payload,
      });
    }
  }
  return out;
}

/**
 * Bbox van alle children van een cluster. Supercluster heeft geen
 * directe bbox-getter; we ontleden via getLeaves en bouwen min/max
 * coords. Goedkoop bij N≤300.
 */
function getClusterBbox<T>(
  index: ClusterIndex<T>,
  clusterId: number
): [number, number, number, number] {
  const leaves = index.getLeaves(clusterId, Infinity);
  if (leaves.length === 0) return [0, 0, 0, 0];
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const leaf of leaves) {
    const [lng, lat] = leaf.geometry.coordinates;
    if (lng < west) west = lng;
    if (lng > east) east = lng;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return [west, south, east, north];
}
