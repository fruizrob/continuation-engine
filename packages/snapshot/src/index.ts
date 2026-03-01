import type {
  HeapPatch,
  HeapSnapshot,
  ObjectRecord,
  RestoreResult,
  RootRef,
  SnapshotOptions,
  UnsupportedRecord,
} from "@unwinder/contracts";

type SerializableState = Record<string, unknown>;

type RestoreOutput = RestoreResult & {
  state: SerializableState;
};

let snapshotSequence = 0;

function makeSnapshotId(): string {
  snapshotSequence += 1;
  return `snapshot-${snapshotSequence}`;
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function resolveRootValue(path: string, source: SerializableState): unknown {
  if (!path) {
    return undefined;
  }

  return path.split(".").reduce<unknown>((current, key) => {
    if (!isObjectLike(current)) {
      return undefined;
    }
    return current[key];
  }, source);
}

function createUnsupported(path: string, kind: string, reason: string): UnsupportedRecord {
  return {
    path,
    kind,
    reason,
    fallbackPolicy: "placeholder",
  };
}

function typeTagForValue(value: unknown): string {
  if (Array.isArray(value)) {
    return "Array";
  }

  if (value instanceof Date) {
    return "Date";
  }

  if (value instanceof RegExp) {
    return "RegExp";
  }

  if (value instanceof Map) {
    return "Map";
  }

  if (value instanceof Set) {
    return "Set";
  }

  return "Object";
}

export function captureHeap(
  roots: RootRef[],
  _opts: SnapshotOptions,
  source: SerializableState = {},
): HeapSnapshot {
  const graph: ObjectRecord[] = [];
  const unsupported: UnsupportedRecord[] = [];
  const capturedRoots: RootRef[] = [];
  const seen = new Map<object, string>();
  let nextObjectId = 0;

  function encodeValue(value: unknown, path: string): { primitive?: unknown; valueRef?: string } {
    if (value === null || value === undefined) {
      return {
        primitive: value,
      };
    }

    const valueType = typeof value;
    if (valueType === "string" || valueType === "number" || valueType === "boolean") {
      return {
        primitive: value,
      };
    }

    if (valueType === "bigint" || valueType === "symbol" || valueType === "function") {
      unsupported.push(createUnsupported(path, valueType, `Unsupported ${valueType} value`));
      return {
        primitive: `__unsupported__:${valueType}`,
      };
    }

    if (!isObjectLike(value)) {
      return {
        primitive: String(value),
      };
    }

    let objectId = seen.get(value);
    if (!objectId) {
      nextObjectId += 1;
      objectId = `obj-${nextObjectId}`;
      seen.set(value, objectId);

      const typeTag = typeTagForValue(value);
      const props: ObjectRecord["props"] = [];

      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
          const encoded = encodeValue(value[index], `${path}.${index}`);
          props.push({ key: String(index), ...encoded });
        }
      } else if (value instanceof Date) {
        props.push({ key: "__date", primitive: value.toISOString() });
      } else if (value instanceof RegExp) {
        props.push({ key: "__regexp_source", primitive: value.source });
        props.push({ key: "__regexp_flags", primitive: value.flags });
      } else if (value instanceof Map) {
        let index = 0;
        for (const [mapKey, mapValue] of value.entries()) {
          const mapKeyEncoded = encodeValue(mapKey, `${path}.mapKey${index}`);
          const mapValueEncoded = encodeValue(mapValue, `${path}.mapValue${index}`);
          props.push({ key: `mapKey:${index}`, ...mapKeyEncoded });
          props.push({ key: `mapValue:${index}`, ...mapValueEncoded });
          index += 1;
        }
      } else if (value instanceof Set) {
        let index = 0;
        for (const setValue of value.values()) {
          const setValueEncoded = encodeValue(setValue, `${path}.setValue${index}`);
          props.push({ key: `setValue:${index}`, ...setValueEncoded });
          index += 1;
        }
      } else {
        for (const [key, propValue] of Object.entries(value)) {
          const encoded = encodeValue(propValue, `${path}.${key}`);
          props.push({ key, ...encoded });
        }
      }

      graph.push({
        objectId,
        typeTag,
        props,
      });
    }

    return {
      valueRef: objectId,
    };
  }

  for (const root of roots) {
    const value = resolveRootValue(root.path, source);
    if (value === undefined) {
      unsupported.push(createUnsupported(root.path, "missing-root", "Root path not found in source state"));
      continue;
    }

    const encodedRoot = encodeValue(value, root.path);
    capturedRoots.push({
      ...root,
      id: encodedRoot.valueRef ?? root.id,
    });
  }

  return {
    snapshotId: makeSnapshotId(),
    checkpointId: "checkpoint-unknown",
    timelineId: 0,
    timestampMs: Date.now(),
    roots: capturedRoots,
    graph,
    unsupported,
  };
}

function createContainer(typeTag: string): unknown {
  switch (typeTag) {
    case "Array":
      return [];
    case "Date":
      return new Date(0);
    case "RegExp":
      return /(?:)/;
    case "Map":
      return new Map();
    case "Set":
      return new Set();
    default:
      return {};
  }
}

function decodeValue(
  valueRef: string | undefined,
  primitive: unknown,
  objects: Map<string, unknown>,
): unknown {
  if (valueRef) {
    return objects.get(valueRef);
  }

  return primitive;
}

function applyPatch(target: SerializableState, patch: HeapPatch = {}): void {
  for (const [key, value] of Object.entries(patch)) {
    target[key] = value;
  }
}

export function restoreHeap(snapshot: HeapSnapshot, patch?: HeapPatch): RestoreOutput {
  const objects = new Map<string, unknown>();
  const recordMap = new Map(snapshot.graph.map((record) => [record.objectId, record]));

  for (const record of snapshot.graph) {
    objects.set(record.objectId, createContainer(record.typeTag));
  }

  for (const record of snapshot.graph) {
    const target = objects.get(record.objectId);
    if (!target) {
      continue;
    }

    if (record.typeTag === "Array") {
      const arr = target as unknown[];
      for (const prop of record.props) {
        const index = Number(prop.key);
        if (!Number.isNaN(index)) {
          arr[index] = decodeValue(prop.valueRef, prop.primitive, objects);
        }
      }
      continue;
    }

    if (record.typeTag === "Date") {
      const iso = record.props.find((prop) => prop.key === "__date")?.primitive;
      if (typeof iso === "string") {
        objects.set(record.objectId, new Date(iso));
      }
      continue;
    }

    if (record.typeTag === "RegExp") {
      const source = record.props.find((prop) => prop.key === "__regexp_source")?.primitive;
      const flags = record.props.find((prop) => prop.key === "__regexp_flags")?.primitive;
      objects.set(
        record.objectId,
        new RegExp(typeof source === "string" ? source : "", typeof flags === "string" ? flags : ""),
      );
      continue;
    }

    if (record.typeTag === "Map") {
      const map = target as Map<unknown, unknown>;
      const pairs: Array<{ key?: unknown; value?: unknown }> = [];
      for (const prop of record.props) {
        const [prefix, indexRaw] = prop.key.split(":");
        const index = Number(indexRaw);
        if (Number.isNaN(index)) {
          continue;
        }
        pairs[index] ??= {};
        const decoded = decodeValue(prop.valueRef, prop.primitive, objects);
        if (prefix === "mapKey") {
          pairs[index].key = decoded;
        } else if (prefix === "mapValue") {
          pairs[index].value = decoded;
        }
      }
      for (const pair of pairs) {
        if (pair.key !== undefined) {
          map.set(pair.key, pair.value);
        }
      }
      continue;
    }

    if (record.typeTag === "Set") {
      const set = target as Set<unknown>;
      for (const prop of record.props) {
        if (!prop.key.startsWith("setValue:")) {
          continue;
        }
        const decoded = decodeValue(prop.valueRef, prop.primitive, objects);
        set.add(decoded);
      }
      continue;
    }

    const obj = target as Record<string, unknown>;
    for (const prop of record.props) {
      obj[prop.key] = decodeValue(prop.valueRef, prop.primitive, objects);
    }
  }

  const state: SerializableState = {};
  for (const root of snapshot.roots) {
    const rootRecord = recordMap.get(root.id) ?? snapshot.graph.find((record) => record.objectId === root.id);
    if (rootRecord) {
      state[root.path] = objects.get(rootRecord.objectId);
    } else {
      const maybeObject = objects.get(root.id);
      if (maybeObject !== undefined) {
        state[root.path] = maybeObject;
      }
    }
  }

  applyPatch(state, patch);

  return {
    ok: true,
    warnings: snapshot.unsupported,
    state,
  };
}
