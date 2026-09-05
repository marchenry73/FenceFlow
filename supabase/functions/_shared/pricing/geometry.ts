/**
 * Port of app/src/main/java/com/fenceestimator/app/geometry/FenceGeometry.kt:
 * the FenceCodec decoders and FenceGeometryEngine.analyze. GateSpan.kt is
 * deliberately not here -- it only draws the opening on screen and the
 * takeoff never reads it.
 */
import { f32 } from "./f32.ts";
import { isBlank, toFloatOrNull } from "./kotlin-text.ts";
import { enumValueOf, GATE_MOUNTINGS, GATE_SWINGS } from "./types.ts";
import type { GateMounting, GateSwing } from "./types.ts";

/** A vertex of the drawn fence line, in survey-image pixel space. Both Float. */
export interface FencePoint {
  x: number;
  y: number;
}

/**
 * A gate placed at an exact point on the drawing -- not required to sit on
 * the fence line itself, so it can mark a walk gate, drive gate, or opening
 * anywhere on the property.
 */
export interface GateMarker {
  x: number;
  y: number;
  widthFt: number;
  /** Defaults to the commonest case so older saved gates read sensibly. */
  mounting: GateMounting;
  /** Which way it opens. Older gates were saved without one; IN is the norm. */
  swing: GateSwing;
}

/**
 * Decodes the point list from the compact "x:y,x:y" string Room stores.
 * Anything that is not exactly two float-parsable parts is dropped, not
 * repaired, exactly as mapNotNull drops it on the phone.
 */
export function decodePoints(raw: string): FencePoint[] {
  if (isBlank(raw)) return [];
  const points: FencePoint[] = [];
  for (const pair of raw.split(",")) {
    const parts = pair.split(":");
    if (parts.length !== 2) continue;
    const x = toFloatOrNull(parts[0]);
    if (x === null) continue;
    const y = toFloatOrNull(parts[1]);
    if (y === null) continue;
    points.push({ x, y });
  }
  return points;
}

/**
 * Reads both the old three-part form and the four-part form with mounting.
 *
 * Every gate already drawn was saved without a mounting, and refusing to
 * parse those would silently empty the gate list on jobs that are already
 * quoted. A gate with no recorded mounting is read as LINE, which is what
 * the estimate already assumed when it charged concrete for every gate.
 */
export function decodeGates(raw: string): GateMarker[] {
  if (isBlank(raw)) return [];
  const gates: GateMarker[] = [];
  for (const entry of raw.split(",")) {
    const parts = entry.split(":");
    if (parts.length < 3) continue;
    const x = toFloatOrNull(parts[0]);
    if (x === null) continue;
    const y = toFloatOrNull(parts[1]);
    if (y === null) continue;
    const w = toFloatOrNull(parts[2]);
    if (w === null) continue;
    // runCatching { valueOf(name) }.getOrNull() ?: LINE -- an unknown name
    // falls back rather than dropping the gate.
    const mounting: GateMounting = (parts.length > 3 ? enumValueOf(GATE_MOUNTINGS, parts[3]) : null) ?? "LINE";
    // Same reasoning as mounting above: gates saved before swing was
    // recorded read as IN rather than being dropped.
    const swing: GateSwing = (parts.length > 4 ? enumValueOf(GATE_SWINGS, parts[4]) : null) ?? "IN";
    gates.push({ x, y, widthFt: w, mounting, swing });
  }
  return gates;
}

/** A vertex classified by how sharply the fence line bends there. */
export type VertexKind = "END" | "LINE" | "CORNER";

export interface ClassifiedVertex {
  index: number;
  point: FencePoint;
  kind: VertexKind;
  /** Float. */
  turnDegrees: number;
}

export interface SegmentResult {
  fromIndex: number;
  toIndex: number;
  /** Float. */
  lengthFt: number;
}

export interface FenceGeometryResult {
  /** Float. */
  totalLinearFeet: number;
  segments: SegmentResult[];
  vertices: ClassifiedVertex[];
  cornerCount: number;
  endCount: number;
  lineVertexCount: number;
}

/** Interior turn angles beyond this are treated as a corner post, not a line post. */
export const CORNER_ANGLE_THRESHOLD_DEGREES = 15;

/**
 * java.lang.Math.toDegrees since JDK 9: `angrad * RADIANS_TO_DEGREES` with
 * the constant below, rather than `angrad * 180.0 / PI`. The two can differ
 * by an ulp, and the fixtures are written by a JDK 17 JVM.
 */
const RADIANS_TO_DEGREES = 57.29577951308232;

/**
 * Computes real-world lengths and classifies each interior vertex as a corner
 * (sharp direction change -> needs a corner post) or a straight line point
 * (needs only a standard line post), given a pixels-per-foot calibration.
 *
 * Segment length is `sqrt(dx*dx + dy*dy)`, never hypot: hypot is allowed to
 * differ by an ulp between libms, and both engines were pinned to the plain
 * form so they cannot. The Kotlin is
 *
 *     val dx = (b.x - a.x).toDouble()
 *     val dy = (b.y - a.y).toDouble()
 *     val distPx = sqrt(dx * dx + dy * dy).toFloat()
 *
 * so the two subtractions are Float, and everything after them -- the
 * products, the sum, the square root -- is Double, narrowed once at the end.
 * Rounding the products and the sum to Float as well is a different number
 * on any leg that is not axis-aligned.
 */
export function analyze(points: readonly FencePoint[], pixelsPerFoot: number, closedLoop = false): FenceGeometryResult {
  if (points.length < 2 || pixelsPerFoot <= 0) {
    return { totalLinearFeet: 0, segments: [], vertices: [], cornerCount: 0, endCount: 0, lineVertexCount: 0 };
  }

  const segments: SegmentResult[] = [];
  let totalPixels = 0;
  const n = points.length;
  const segmentCount = closedLoop ? n : n - 1;
  for (let i = 0; i < segmentCount; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const dx = f32(b.x - a.x);
    const dy = f32(b.y - a.y);
    const distPx = f32(Math.sqrt(dx * dx + dy * dy));
    totalPixels = f32(totalPixels + distPx);
    segments.push({ fromIndex: i, toIndex: (i + 1) % n, lengthFt: f32(distPx / pixelsPerFoot) });
  }

  const vertices: ClassifiedVertex[] = [];
  for (let i = 0; i < n; i++) {
    const isEndpoint = !closedLoop && (i === 0 || i === n - 1);
    if (isEndpoint) {
      vertices.push({ index: i, point: points[i], kind: "END", turnDegrees: 0 });
      continue;
    }
    const prevIdx = (i - 1 + n) % n;
    const nextIdx = (i + 1) % n;
    const prev = points[prevIdx];
    const curr = points[i];
    const next = points[nextIdx];

    // The differences are Float subtractions widened to Double for atan2.
    const angleIn = Math.atan2(f32(curr.y - prev.y), f32(curr.x - prev.x));
    const angleOut = Math.atan2(f32(next.y - curr.y), f32(next.x - curr.x));
    let turnRad = angleOut - angleIn;
    while (turnRad > Math.PI) turnRad -= 2 * Math.PI;
    while (turnRad < -Math.PI) turnRad += 2 * Math.PI;
    const turnDeg = f32(Math.abs(turnRad) * RADIANS_TO_DEGREES);

    const kind: VertexKind = turnDeg >= CORNER_ANGLE_THRESHOLD_DEGREES ? "CORNER" : "LINE";
    vertices.push({ index: i, point: points[i], kind, turnDegrees: turnDeg });
  }

  const totalFeet = f32(totalPixels / pixelsPerFoot);
  return {
    totalLinearFeet: totalFeet,
    segments,
    vertices,
    cornerCount: vertices.filter((v) => v.kind === "CORNER").length,
    endCount: vertices.filter((v) => v.kind === "END").length,
    lineVertexCount: vertices.filter((v) => v.kind === "LINE").length,
  };
}
